/**
 * Meisei iMS-100 and RS-11G (Japan): 1200 bit/s biphase-S on FM (2400 half-symbols a second), sent continuously.
 * A frame is 600 bits (half a second): two 300-bit subframes, each a 24-bit header (0x049DCE, then 0xFB6230) and six
 * 46-bit blocks. A block is a BCH(63,51) codeword shortened to (46,34): two 16-bit words, each followed by an odd
 * parity bit (1 when the word has an even number of ones), then 12 check bits; the code repairs two bits a block.
 * Fields are most significant bit first. Word 7 of subframe 0 names the model (0x30C1/0x31C1 iMS-100, 0x30A2/0x31A2
 * RS-11G). The frame counter (subframe 0, word 0) counts half seconds; even and odd frames carry different data, so
 * a complete report takes an even frame and the odd one after it. A 64-slot configuration table arrives one float a
 * frame (serial number, transmit frequency, the temperature and humidity calibration).
 */
import type { ChannelDecoder } from './bank.js';
import type { SondeFrame, SondeSink } from './types.js';

export const MEISEI_BAUD = 2400;
/** The raw biphase-S half-symbols of the subframe 0 header 0x049DCE (one of the two line polarities). */
export const MEISEI_HEADER = '101010101011010100101011001101001100101011001101';
/** Half-symbols after the header: the rest of the 600-bit frame. */
export const MEISEI_SYMS = 1152;
export const MEISEI_HDR0 = 0x049dce, MEISEI_HDR1 = 0xfb6230;

/** x^12 + x^10 + x^8 + x^5 + x^4 + x^3 + 1 */
const BCH_G = 0x1539;
/** The remainder mod g of the block bit at position p (block bit 0 is x^45, bit 45 is x^0). */
export const BCH_REM: Uint16Array = (() => {
  const r = new Uint16Array(46);
  let v = 1;
  for (let p = 45; p >= 0; p--) { r[p] = v; v <<= 1; if (v & 0x1000) v ^= BCH_G; }
  return r;
})();
/**
 * Syndrome to error pattern for every pattern of up to two bits inside the 46 (the code's distance is 5, so all of
 * them differ): 0 = clean, (p + 1) one bit, (p + 1) | (q + 1) << 8 two bits, -1 = beyond repair (or an error that
 * would land in the shortened-away positions).
 */
const BCH_FIX: Int32Array = (() => {
  const t = new Int32Array(4096).fill(-1);
  t[0] = 0;
  for (let p = 0; p < 46; p++) t[BCH_REM[p]] = p + 1;
  for (let p = 0; p < 46; p++) for (let q = p + 1; q < 46; q++) t[BCH_REM[p] ^ BCH_REM[q]] = (p + 1) | ((q + 1) << 8);
  return t;
})();

/** Repair one 46-bit block in place. Returns bits fixed (0..2), or -1 when it is beyond repair or a parity bit fails. */
export function meiseiBlockFix(bits: Uint8Array, start: number): number {
  let s = 0;
  for (let p = 0; p < 46; p++) if (bits[start + p]) s ^= BCH_REM[p];
  const e = BCH_FIX[s];
  if (e < 0) return -1;
  let fixed = 0;
  if (e > 0) {
    bits[start + (e & 255) - 1] ^= 1; fixed = 1;
    const q = e >> 8;
    if (q > 0) { bits[start + q - 1] ^= 1; fixed = 2; }
  }
  // each 16-bit word and its parity bit hold an odd number of ones
  let a = 0, b = 0;
  for (let k = 0; k < 17; k++) { a += bits[start + k]; b += bits[start + 17 + k]; }
  if ((a & 1) === 0 || (b & 1) === 0) return -1;
  return fixed;
}

/** Build a block from two words (the encoder; also used by the tests). */
export function meiseiBlock(wa: number, wb: number, out: Uint8Array | number[], pos: number): void {
  let pa = 1, pb = 1;
  for (let k = 0; k < 16; k++) {
    const x = (wa >> (15 - k)) & 1, y = (wb >> (15 - k)) & 1;
    out[pos + k] = x; out[pos + 17 + k] = y; pa ^= x; pb ^= y;
  }
  out[pos + 16] = pa; out[pos + 33] = pb;
  let r = 0;
  for (let p = 0; p < 34; p++) if (out[pos + p]) r ^= BCH_REM[p];
  for (let i = 0; i < 12; i++) out[pos + 34 + i] = (r >> (11 - i)) & 1;
}

const val = (bits: Uint8Array, pos: number, n: number): number => {
  let v = 0;
  for (let k = 0; k < n; k++) v = (v << 1) | bits[pos + k];
  return v >>> 0;
};
/** Word j (0..11) of the subframe starting at `base`. */
const word = (bits: Uint8Array, base: number, j: number): number => val(bits, base + 24 + 46 * (j >> 1) + 17 * (j & 1), 16);
const i16 = (v: number) => (v << 16) >> 16;
const swap16 = (v: number) => ((v >> 8) & 0xff) | ((v & 0xff) << 8);

const fbuf = new DataView(new ArrayBuffer(4));
/** A 32-bit pattern as an IEEE float (iMS-100). */
function f32(bits32: number): number { fbuf.setUint32(0, bits32 >>> 0); return fbuf.getFloat32(0); }
/** The RS-11G's own float: sign at bit 23, exponent in the top byte, and a factor 4. */
export function f32e2(num: number): number {
  const v = ((num & 0x800000) << 8) | ((num >>> 1) & 0x7f800000) | (num & 0x7fffff);
  return f32(v) / 4;
}
/** The inverse of f32e2 (the encoder). */
export function toF32e2(f: number): number {
  fbuf.setFloat32(0, f * 4); const v = fbuf.getUint32(0);
  return ((((v >>> 23) & 0xff) << 24) | (((v >>> 31) & 1) << 23) | (v & 0x7fffff)) >>> 0;
}

/** The century-less year: the digit the iMS-100 sends, placed in the decade around the reference year. */
function estYear(y: number, refYear: number): number {
  let roll = 20, off = 20;
  if (refYear > 2003 && refYear < 2100) { roll = refYear - 2004; off = Math.floor(roll / 10) * 10; }
  y = (y % 10) + off;
  if (y < roll) y += 10;
  return 2000 + y;
}

/** NMEA-style ddmm.mmmm x 1e4 (as an int) to degrees. */
function nmeaDeg(v: number): number {
  const deg = Math.trunc(v / 1e6);
  return deg + (v / 1e6 - deg) * 100 / 60;
}

const pad2 = (n: number) => (n < 10 ? '0' : '') + n;

interface EvenPart {
  c: number; ok: boolean;
  lat: number; lon: number; alt: number; vH: number; heading: number; climb: number; hasClimb: boolean;
  timeS: number; date: string; tempC: number; rh: number;
}

export class MeiseiDecoder {
  private readonly cfg = new Float64Array(64);
  private readonly have = new Uint8Array(64);
  private model = '';
  private serial = 0;
  private fRef = 0;
  private txKHz = 0;
  private pend: EvenPart | null = null;
  private readonly bits = new Uint8Array(600);
  /** The year the iMS-100's single year digit is placed around. */
  refYear = new Date().getUTCFullYear();

  /** One frame's soft half-symbols after the header. */
  decode(soft: Float32Array): SondeFrame | null {
    const b = this.bits;
    for (let k = 0; k < 24; k++) b[k] = (MEISEI_HDR0 >> (23 - k)) & 1;
    // biphase-S: two equal halves = 1, a mid-cell transition = 0 (either line polarity)
    for (let j = 0; j < 576; j++) b[24 + j] = soft[2 * j] * soft[2 * j + 1] > 0 ? 1 : 0;
    return this.parse(b);
  }

  /** A 600-bit frame (both subframes, headers included). Repaired in place. */
  parse(b: Uint8Array): SondeFrame | null {
    const errs = new Int8Array(12);
    let bad0 = 0, bad1 = 0, fixed = 0, worst0 = 0, worst1 = 0;
    for (let s = 0; s < 2; s++) {
      for (let k = 0; k < 6; k++) {
        const e = meiseiBlockFix(b, 300 * s + 24 + 46 * k);
        errs[6 * s + k] = e;
        if (e < 0) { if (s === 0) bad0++; else bad1++; continue; }
        fixed += e;
        if (s === 0 && e > worst0) worst0 = e;
        if (s === 1 && e > worst1) worst1 = e;
      }
    }
    if (bad0 > 0) return null;
    // the second header should read 0xFB6230; more than a few wrong bits means subframe 1 is not where we think
    let hdrErr = 0;
    const h1 = val(b, 300, 24) ^ MEISEI_HDR1;
    for (let k = 0; k < 24; k++) hdrErr += (h1 >> k) & 1;
    const sub1 = bad1 === 0 && hdrErr <= 4;

    const c = word(b, 0, 0);
    const flag = word(b, 0, 7);
    if ((flag & 0xfe00) !== 0x3000 || ((flag >> 8) & 1) !== (c & 1)) return null;
    const model = (flag & 0xff) >= 0xc0 ? 'iMS-100' : 'RS-11G';
    if (model !== this.model) { this.reset(); this.model = model; }
    const ims = model === 'iMS-100';

    // configuration slot c % 64
    let w2 = word(b, 0, 2), w3 = word(b, 0, 3);
    let cfgOk: boolean;
    let fw: number;
    if (ims) {
      cfgOk = errs[0] < 2 && errs[1] < 2;
      fw = f32(((w3 << 16) | w2) >>> 0);
    } else {
      // RS-11G: no checksum anywhere, so only blocks needing at most one repaired bit are trusted
      cfgOk = worst0 <= 1;
      w2 = swap16(w2); w3 = swap16(w3);
      fw = f32e2(((w3 << 16) | w2) >>> 0);
    }
    const slot = c % 64;
    // a serial slot whose blocks needed two repairs still counts when it reads as a whole number (a wrong repair
    // would hardly give one), and agrees with the serial we have, if any
    if (!cfgOk && slot % 16 === 0 && fw > 0 && fw < 1e9 && fw === Math.round(fw) && (!this.serial || fw === this.serial)) {
      if (!this.serial) { this.model = model; this.serial = fw; }
    }
    if (cfgOk && Number.isFinite(fw)) {
      if (slot % 16 === 0 && fw > 0 && fw < 1e9) {
        const sn = Math.round(fw);
        if (this.serial && sn !== this.serial) this.reset();
        this.model = model; this.serial = sn;
      }
      this.cfg[slot] = fw; this.have[slot] = 1;
      if (slot === 15) this.txKHz = Math.round((ims ? 400_000 : 403_700) + fw * 100);
      if (c % 4 === 0) this.fRef = word(b, 0, 1);
      if (ims && c % 4 === 3) this.fRef = word(b, 0, 6);
    }

    if (c % 2 === 0) {
      const p: EvenPart = { c, ok: false, lat: NaN, lon: NaN, alt: NaN, vH: NaN, heading: NaN, climb: NaN, hasClimb: false, timeS: NaN, date: '', tempC: NaN, rh: NaN };
      if (ims) {
        const ms = word(b, 0, 10), hm = word(b, 0, 11), hh = hm >> 8, mm = hm & 0xff;
        if (hh < 24 && mm < 60 && ms < 60000) p.timeS = hh * 3600 + mm * 60 + ms / 1000;
      }
      this.ptu(b, ims, p);
      if (sub1) {
        if (ims) {
          let sum = word(b, 0, 10) + word(b, 0, 11);
          for (let j = 0; j < 11; j++) sum += word(b, 300, j);
          if ((sum & 0xffff) === word(b, 300, 11)) {
            const d = word(b, 300, 0);
            const day = Math.floor(d / 1000), mon = Math.floor(d / 10) % 100;
            if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) p.date = `${estYear(d % 10, this.refYear)}-${pad2(mon)}-${pad2(day)}`;
            const lat = (word(b, 300, 1) << 16) | word(b, 300, 2), lon = (word(b, 300, 3) << 16) | word(b, 300, 4);
            p.lat = nmeaDeg(lat); p.lon = nmeaDeg(lon);
            p.alt = ((word(b, 300, 5) << 8) | (word(b, 300, 6) >> 8)) / 100;
            p.heading = word(b, 300, 9) / 100;
            p.vH = word(b, 300, 10) / 194.384;
            p.ok = true;
          }
        } else {
          p.lat = ((word(b, 300, 1) << 16) | word(b, 300, 2)) / 1e7;
          p.lon = ((word(b, 300, 3) << 16) | word(b, 300, 4)) / 1e7;
          p.alt = ((word(b, 300, 5) << 16) | word(b, 300, 6)) / 100;
          p.vH = word(b, 300, 7) / 100;
          p.heading = word(b, 300, 8) / 100;
          p.climb = i16(word(b, 300, 9)) / 100; p.hasClimb = true;
          const yy = (word(b, 300, 10) & 0xff) + 0x700, md = word(b, 300, 11), mon = md >> 8, day = md & 0xff;
          if (yy > 1980 && mon >= 1 && mon <= 12 && day >= 1 && day <= 31) p.date = `${yy}-${pad2(mon)}-${pad2(day)}`;
          p.ok = worst1 <= 1;
        }
      }
      this.pend = p;
      return null;
    }

    // odd frame: completes the even one before it
    const p = this.pend;
    this.pend = null;
    if (!p || p.c !== c - 1 || !p.ok) return null;
    if (ims) {
      if (sub1) {
        let sum = word(b, 0, 10) + word(b, 0, 11);
        for (let j = 0; j < 11; j++) sum += word(b, 300, j);
        const vu = i16(word(b, 300, 1));
        if ((sum & 0xffff) === word(b, 300, 11) && vu !== 0) { p.climb = vu / 19.4384; p.hasClimb = true; }
      }
    } else {
      const ms = swap16(word(b, 0, 10)), hm = word(b, 0, 11), hh = hm >> 8, mm = hm & 0xff;
      if (hh < 24 && mm < 60 && ms < 60000) p.timeS = hh * 3600 + mm * 60 + ms / 1000;
    }
    if (!this.serial) return null;
    const out: SondeFrame = { type: 'MEISEI', model, serial: `${this.serial}`, frame: p.c, fixed };
    if (Number.isFinite(p.timeS)) out.timeS = p.timeS;
    if (p.date) out.date = p.date;
    if (p.lat > -90 && p.lat < 90 && p.lon > -180 && p.lon < 180 && p.alt > -1000 && p.alt < 80000 && (p.lat !== 0 || p.lon !== 0)) {
      out.lat = p.lat; out.lon = p.lon; out.alt = p.alt;
      if (p.vH >= 0 && p.vH < 1000) out.vH = p.vH;
      if (p.heading >= 0 && p.heading <= 360) out.heading = p.heading;
      if (p.hasClimb && Math.abs(p.climb) < 1000) out.climb = p.climb;
    }
    if (Number.isFinite(p.tempC)) out.tempC = p.tempC;
    if (Number.isFinite(p.rh)) out.rh = p.rh;
    if (this.txKHz) out.txKHz = this.txKHz;
    let n = 0; for (let i = 0; i < 64; i++) n += this.have[i];
    out.extra = { CALIBRATION: `${n}/64` };
    return out;
  }

  /** Temperature (a resistance looked up in the calibrated table) and humidity, from an even frame. */
  private ptu(b: Uint8Array, ims: boolean, p: EvenPart): void {
    if (!this.fRef) return;
    const c = this.cfg, h = this.have;
    const rLo = ims ? 33 : 37, nPts = ims ? 12 : 11, poly = ims ? 53 : 33;
    let tOk = true;
    for (let i = 0; i < nPts; i++) if (!h[17 + i] || !h[rLo + i]) tOk = false;
    for (let i = 0; i < 4; i++) if (!h[poly + i]) tOk = false;
    // sanity: resistances rise, temperatures fall
    for (let i = 1; tOk && i < nPts; i++) if (!(c[rLo + i] > c[rLo + i - 1]) || !(c[17 + i] < c[17 + i - 1])) tOk = false;
    if (tOk && c[rLo] <= 0) tOk = false;
    if (tOk) {
      let f = word(b, 0, 5) / this.fRef * 4;
      if (f > 1) {
        f = 1 / (f - 1);
        const R = c[poly] + c[poly + 1] * f + c[poly + 2] * f * f - c[poly + 3];
        let T = NaN;
        if (R <= c[rLo]) T = c[17];
        else if (R >= c[rLo + nPts - 1]) T = c[17 + nPts - 1];
        else {
          for (let j = 0; j < nPts - 1; j++) {
            if (R < c[rLo + j + 1]) {
              const g = (Math.log(R) - Math.log(c[rLo + j])) / (Math.log(c[rLo + j + 1]) - Math.log(c[rLo + j]));
              T = c[17 + j] - g * (c[17 + j] - c[18 + j]);
              break;
            }
          }
        }
        if (T > -120 && T < 70) p.tempC = T;
      }
    }
    if (h[49] && h[50] && h[51] && h[52]) {
      const f = word(b, 0, 6) / this.fRef * 4;
      const rh = c[49] + c[50] * f + c[51] * f * f + c[52] * f * f * f;
      if (Number.isFinite(rh)) p.rh = Math.max(0, Math.min(100, rh));
    }
  }

  private reset(): void {
    this.cfg.fill(0); this.have.fill(0);
    this.serial = 0; this.fRef = 0; this.txKHz = 0; this.pend = null; this.model = '';
  }
}

/**
 * Meisei on a channel: a half-symbol clock on the discriminator's transitions (integrate and dump), then the cell
 * alignment found from the cell boundaries themselves (biphase-S always changes level there, so a leaky count of the
 * level changes at even and at odd half-symbol boundaries shows which is which, and a clock slip only costs a few
 * bits), then the 24-bit header 0x049DCE in the decoded bits (biphase-S bits do not depend on the FM polarity) and
 * the rest of the 600-bit frame.
 */
export class MeiseiChannel implements ChannelDecoder {
  readonly name = 'MEISEI';
  private readonly dec = new MeiseiDecoder();
  private readonly inc: number;
  private phase = 0; private acc = 0; private dc = 0; private amp = 0; private lastPos = false;
  private h1 = 0;                        // the previous half-symbol
  private k = 0;                         // half-symbols so far
  private score = 0;                     // > 0: cells start on even half-symbols
  private cellPar = 0;
  private sh = 0;                        // the last 24 bits
  private collecting = 0;
  private readonly bits = new Uint8Array(600);
  private nb = 0;
  private readonly ring: Float64Array; private rp = 0; private rs = 0;
  /** Timing-loop gain per level change. */
  gain = 0.05;
  /** Level changes counted only this close to a boundary, in half-symbols. */
  gate = 0.35;
  constructor(rate: number, private readonly sink: SondeSink) {
    this.inc = MEISEI_BAUD / rate;
    this.ring = new Float64Array(Math.max(1, Math.round(rate / MEISEI_BAUD / 4)));
  }
  push(x: number): void {
    this.dc += (x - this.dc) * 0.0005;
    let v = x - this.dc;
    // FM clicks (a near-2π phase jump in a few samples) would swamp a half-symbol's sum: clip at 1.5 times the mean level
    const a = v < 0 ? -v : v;
    this.amp += (a - this.amp) * 0.001;
    const lim = 1.5 * this.amp;
    if (v > lim) v = lim; else if (v < -lim) v = -lim;
    // a short running mean (a quarter of a half-symbol) before the slicer, so noise makes fewer false crossings
    const m = this.ring.length;
    this.rs += v - this.ring[this.rp]; this.ring[this.rp] = v; this.rp = this.rp + 1 === m ? 0 : this.rp + 1;
    v = this.rs / m;
    const pos = v > 0;
    if (pos !== this.lastPos) {
      // level changes far from a boundary are noise; leave them out
      const err = this.phase < 0.5 ? this.phase : this.phase - 1;
      if (err < this.gate && err > -this.gate) this.phase -= err * this.gain;
    }
    this.lastPos = pos;
    this.acc += v;
    this.phase += this.inc;
    if (this.phase < 1) return;
    this.phase -= 1;
    const h = this.acc; this.acc = 0;
    this.half(h);
  }
  private half(h: number): void {
    const k = this.k++;
    // a level change between half-symbols k-1 and k: a cell boundary when k has the cells' parity
    const change = h * this.h1 < 0;
    if ((k & 1) === 0) this.score += ((change ? 1 : -1) - this.score) * 0.05;
    else this.score -= ((change ? 1 : -1) + this.score) * 0.05;
    const par = this.score >= 0 ? 0 : 1;
    // a cell ends at k when k + 1 has the cells' parity; while collecting, keep the parity we had
    if (this.collecting === 0) this.cellPar = par;
    if (((k + 1) & 1) === this.cellPar) this.bit(h * this.h1 > 0 ? 1 : 0);
    this.h1 = h;
  }
  private bit(b: number): void {
    if (this.collecting > 0) {
      this.bits[this.nb++] = b;
      if (--this.collecting === 0) {
        const f = this.dec.parse(this.bits);
        if (f && f.serial) this.sink(f);
      }
      return;
    }
    this.sh = ((this.sh << 1) | b) & 0xffffff;
    let x = this.sh ^ MEISEI_HDR0, e = 0;
    while (x) { x &= x - 1; e++; }
    if (e <= 2) {
      for (let j = 0; j < 24; j++) this.bits[j] = (MEISEI_HDR0 >> (23 - j)) & 1;
      this.nb = 24; this.collecting = 576; this.sh = 0;
    }
  }
}
