/**
 * Graw DFM-06, DFM-09, DFM-17 (and the P variants, PS-15): 2500 baud 2-FSK, Manchester coded ("01" = 1, "10" = 0), so
 * 1250 bits/s in back-to-back 280-bit frames: the 16-bit header 0x45CF, a config block (7 Hamming(8,4) codewords) and
 * two GPS data blocks (13 codewords each), each block sent column-wise (bit 0 of every codeword, then bit 1 ...).
 * Every codeword corrects one bit error; a block with an uncorrectable codeword is dropped. There is no CRC.
 *
 * The data blocks are numbered 0..8 and cycle about once a second; the frame is reported when block 8 (date and time)
 * arrives and blocks 0..4 are fresh. The config block carries one channel per frame: PTU measurements (channels 0..8),
 * battery and MCU temperature, and the serial number, in two 16-bit halves on a channel whose number is the subtype.
 * That state lives in the decoder (one per channel). The TypeScript twin of core/sonde/Dfm.kt and Dfm.swift.
 */
import type { ChannelDecoder } from './bank.js';
import { FskFramer, type SondeFrame, type SondeSink } from './types.js';

export const DFM_BAUD = 2500;
/** The header 0x45CF as Manchester channel symbols. */
export const DFM_HEADER = '10011010100110010101101001010101';
export const DFM_FRAME_BITS = 280;
/** Channel symbols after the 32-symbol header. */
export const DFM_SYMS = (DFM_FRAME_BITS - 16) * 2;
const HEADER_BITS = 0x45cf;

/** Hamming(8,4) codeword (bit 0 = most significant bit of the byte) for a nibble. */
export function dfmHamming(nib: number): number {
  const m0 = (nib >> 3) & 1, m1 = (nib >> 2) & 1, m2 = (nib >> 1) & 1, m3 = nib & 1;
  const p4 = m1 ^ m2 ^ m3, p5 = m0 ^ m2 ^ m3, p6 = m0 ^ m1 ^ m3, p7 = m0 ^ m1 ^ m2;
  return ((nib & 0xf) << 4) | (p4 << 3) | (p5 << 2) | (p6 << 1) | p7;
}
/** Received byte -> nibble (or -1 when two or more bits are wrong), and whether one bit was corrected. */
const HAM_NIB = new Int8Array(256), HAM_FIX = new Uint8Array(256);
for (let v = 0; v < 256; v++) {
  HAM_NIB[v] = -1;
  for (let n = 0; n < 16; n++) {
    let d = v ^ dfmHamming(n), c = 0;
    while (d) { d &= d - 1; c++; }
    if (c <= 1) { HAM_NIB[v] = n; HAM_FIX[v] = c; break; }
  }
}

/** The DFM float24: a 4-bit exponent over a 20-bit mantissa. */
export const dfmFl24 = (d: number): number => (d & 0xfffff) / (1 << ((d >> 20) & 0xf));

/** NTC (EPCOS B57540G0502) resistance, ohms, to degrees C. */
export function dfmTempFromR(R: number): number {
  if (!(R > 0)) return NaN;
  const l = Math.log(R);
  return 1 / (1.09698417e-03 + 2.39564629e-04 * l + 2.48821437e-06 * l * l + 5.84354921e-08 * l * l * l) - 273.15;
}

/** Seconds since 1980-01-06 for a UTC date and time, as the reference decoder counts them (leap seconds ignored). */
function gpsSeconds(yy: number, mm: number, dd: number, hr: number, mi: number, sec: number): number {
  if (mm < 3) { yy -= 1; mm += 12; }
  const days = Math.floor(365.25 * yy) + Math.floor(30.6001 * (mm + 1)) + dd - 723263;
  return days * 86400 + hr * 3600 + mi * 60 + sec;
}

export class DfmDecoder {
  private readonly bits = new Uint8Array(DFM_FRAME_BITS);
  private readonly nib = new Uint8Array(13);
  /** The latest data packet of each number: 6 payload bytes, the frame index it came in. */
  private readonly pck = new Uint8Array(9 * 6);
  private readonly pckTs = new Int32Array(9).fill(-1000);
  private frmcnt = 0;
  private fixedAcc = 0;
  // config channel state
  private readonly cfg = new Uint8Array(16);
  private readonly val24 = new Int32Array(16);
  private readonly meas24 = new Float64Array(16);
  private ptuOut = 0; private sondeTyp = 0;
  private nulCh = 0; private maxCh = 0; private snCh = 0;
  private chX0 = 0; private chX1 = 0; private chXbit = 0; private snX = 0;
  private sn = 0; private sn6 = 0;
  private serial = '';
  // consistency
  private lastDiff = -1; private lastInv = -1;

  /** Soft symbols after the header; `inv` = the signal came in with the opposite FM polarity to the header. */
  decodeSoft(soft: Float32Array, inv = false): SondeFrame | null {
    const b = this.bits;
    for (let k = 0; k < 16; k++) b[k] = (HEADER_BITS >> (15 - k)) & 1;
    const n = Math.min(DFM_FRAME_BITS - 16, soft.length >> 1);
    for (let k = 0; k < n; k++) b[16 + k] = soft[2 * k + 1] - soft[2 * k] >= 0 ? 1 : 0;
    for (let k = 16 + n; k < DFM_FRAME_BITS; k++) b[k] = 0;
    return this.frame(b, inv);
  }

  /** One 280-bit frame (header included). */
  frame(bits: Uint8Array, inv = false): SondeFrame | null {
    this.frmcnt++;
    let out: SondeFrame | null = null;
    const ec = this.block(bits, 16, 7);
    if (ec >= 0) { this.fixedAcc += ec; this.conf(ec); }
    for (let d = 0; d < 2; d++) {
      const e = this.block(bits, 72 + 104 * d, 13);
      if (e < 0 || e > 4) continue;
      this.fixedAcc += e;
      const id = this.nib[12];
      if (id > 8) continue;
      for (let k = 0; k < 6; k++) this.pck[id * 6 + k] = (this.nib[2 * k] << 4) | this.nib[2 * k + 1];
      this.pckTs[id] = this.frmcnt;
      if (id === 8) { const r = this.output(inv); if (r) out = r; }
    }
    return out;
  }

  /** Deinterleave and correct one block into this.nib. Returns codewords corrected, or -1. */
  private block(bits: Uint8Array, start: number, L: number): number {
    let fixed = 0;
    for (let i = 0; i < L; i++) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[start + L * j + i];
      const nb = HAM_NIB[v];
      if (nb < 0) return -1;
      this.nib[i] = nb; fixed += HAM_FIX[v];
    }
    return fixed;
  }

  private resetCfg(): void {
    this.cfg.fill(0); this.ptuOut = 0; this.serial = '';
  }
  private resetAll(): void {
    this.resetCfg(); this.sondeTyp = 0; this.chXbit = 0; this.chX0 = 0; this.chX1 = 0; this.snX = 0; this.sn6 = 0;
    this.nulCh = 0; this.maxCh = 0; this.snCh = 0; this.sn = 0; this.lastDiff = -1;
  }

  /** The config block in this.nib[0..6]: channel number, then a 24-bit value. */
  private conf(ec: number): void {
    const id = this.nib[0];
    let val = 0;
    for (let k = 1; k <= 6; k++) val = (val << 4) | this.nib[k];
    if (ec === 0) {
      this.cfg[id] = 1; this.val24[id] = val; this.meas24[id] = dfmFl24(val);
    }
    // the "null channel": the first channel above 4 with its low 20 bits zero
    if (id > 4 && (val & 0xfffff) === 0) this.nulCh = (id << 4) | (val >> 20);
    const dfm6 = (this.nulCh & 0xf0) === 0x50 && (this.nulCh & 0x0f) !== 0;
    if (dfm6) this.ptuOut = 6;
    if (dfm6 && (this.sondeTyp & 0xf) > 6) { this.sondeTyp = 0; this.maxCh = id; this.resetCfg(); }
    if (id > 5 && id > this.maxCh && ec === 0 && ((val >> 20) & 0xf) === 0xc) this.maxCh = id;
    if (!(id > 5 && (id === (this.nulCh >> 4) + 1 || id === this.maxCh))) return;
    const sn2 = (id << 4) | (val >> 20), snCh = id;
    if ((this.nulCh & 0x58) === 0x58) {
      // DFM-06: the whole value is the serial (BCD, shown as hex), sent twice alike
      if (val === this.sn6 && val !== 0) {
        this.sondeTyp = 0x100 | snCh; this.ptuOut = 6;
        this.serial = val.toString(16).toUpperCase();
      } else { this.sondeTyp = 0; this.resetCfg(); }
      this.sn6 = val;
    } else if ((sn2 & 0xf) === 0xc || (sn2 & 0xf) === 0) {
      // DFM-09/17, PS-15: the serial in two halves, the last nibble says which
      const v = val & 0xfffff, hl = v & 0xf;
      if (hl >= 2) return;
      if (this.snCh !== snCh) { this.chXbit = 0; this.chX0 = 0; this.chX1 = 0; this.resetCfg(); }
      this.snCh = snCh;
      if (hl === 0) this.chX0 = (v >> 4) & 0xffff; else this.chX1 = (v >> 4) & 0xffff;
      this.chXbit |= 1 << hl;
      if (this.chXbit === 3) {
        const sn = ((this.chX0 << 16) | this.chX1) >>> 0;
        if (sn === this.snX || this.snX === 0) {
          this.sondeTyp = 0x100 | snCh; this.sn = sn;
          this.ptuOut = snCh >= 0xa && snCh <= 0xd ? snCh : 0;
          if (this.sn6 === 0 || (this.sondeTyp & 0xf) >= 0xa) this.serial = `${sn}`;
        } else { this.sondeTyp = 0; this.resetCfg(); }
        this.snX = sn; this.chXbit = 0;
      }
    }
  }

  private fresh(id: number): boolean { return this.pckTs[8] - this.pckTs[id] < 6; }
  private u8(id: number, k: number): number { return this.pck[id * 6 + k]; }
  private s32(id: number, k: number): number { const p = id * 6 + k, b = this.pck; return (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]; }
  private u16(id: number, k: number): number { const p = id * 6 + k; return (this.pck[p] << 8) | this.pck[p + 1]; }
  private s16(id: number, k: number): number { return (this.u16(id, k) << 16) >> 16; }

  /** Block 8 just arrived: put the second together. */
  private output(inv: boolean): SondeFrame | null {
    if (!this.fresh(0)) return null;
    let mode = this.u8(0, 2);
    if (mode !== 2 && mode !== 3 && mode !== 4) mode = 2;
    const need = mode === 2 ? [1, 2, 3, 4] : [1, 2, 3];
    for (const id of need) if (!this.fresh(id)) return null;
    const frnr = this.u8(0, 3);
    if (frnr === 0) return null;
    // date and time
    const b0 = this.u8(8, 0), b1 = this.u8(8, 1), b2 = this.u8(8, 2), b3 = this.u8(8, 3);
    const year = (b0 << 4) | (b1 >> 4), month = b1 & 0xf, day = b2 >> 3, hour = ((b2 & 7) << 2) | (b3 >> 6), minute = b3 & 0x3f;
    const ms = mode === 2 ? this.u16(1, 4) : this.u16(0, 0);
    const sek = ms / 1000;
    if (sek >= 60 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    // the polarity must not change under a sonde
    const invN = inv ? 1 : 0;
    if (this.lastInv >= 0 && invN !== this.lastInv) { this.resetAll(); this.lastInv = invN; return null; }
    this.lastInv = invN;
    const secGps = gpsSeconds(year, month, day, hour, minute, Math.floor(sek + 0.5));
    const diff = ((secGps & 0xff) - frnr) & 0xff;
    if (this.lastDiff >= 0 && diff !== this.lastDiff) {
      // the counter slipped against the clock: a decoding error, or a different sonde
      this.resetAll(); this.lastDiff = diff; return null;
    }
    this.lastDiff = diff;
    if (!this.serial) return null;

    const out: SondeFrame = { type: 'DFM', serial: 'DFM-' + this.serial, frame: frnr, fixed: this.fixedAcc };
    this.fixedAcc = 0;
    out.timeS = hour * 3600 + minute * 60 + sek;
    out.date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const extra: Record<string, string> = {};
    if (mode === 2) {
      out.lat = this.s32(2, 0) / 1e7; out.vH = this.s16(2, 4) / 100;
      out.lon = this.s32(3, 0) / 1e7; out.heading = this.u16(3, 4) / 100;
      out.alt = this.s32(4, 0) / 100; out.climb = this.s16(4, 4) / 100;
      let prn = this.s32(1, 0) >>> 0, nPrn = 0; while (prn) { prn &= prn - 1; nPrn++; }
      const nSv = this.u8(8, 4);
      out.sats = nSv || nPrn;
      if (this.fresh(5)) extra['GEOID HEIGHT'] = `${(-this.s16(5, 0) / 100).toFixed(1)} m`;
    } else {
      out.vH = this.s16(0, 4) / 100;
      out.lat = this.s32(1, 0) / 1e7; out.heading = this.u16(1, 4) / 100;
      out.lon = this.s32(2, 0) / 1e7; out.climb = this.s16(2, 4) / 100;
      out.alt = this.s32(3, 0) / 100;
      out.sats = this.u8(8, 4) || undefined;
      extra['ALTITUDE'] = 'above mean sea level';
      if (mode === 4 && this.u8(3, 4) !== 0) {
        let hex = '';
        for (let k = 4; k < 6; k++) hex += this.u8(3, k).toString(16).padStart(2, '0');
        for (let id = 4; id <= 7; id++) for (let k = 0; k < 6; k++) hex += this.u8(id, k).toString(16).padStart(2, '0');
        extra['AUX DATA'] = hex.toUpperCase();
      }
    }
    if (out.lat !== undefined && (Math.abs(out.lat) > 90 || Math.abs(out.lon!) > 180)) return null;

    // PTU: the channels the subtype says it sends, all received clean
    const c = this.cfg;
    let cfgchk = 0;
    if (this.ptuOut >= 5) cfgchk = c[0] & c[1] & c[2] & c[3] & c[4] & c[5];
    if (this.ptuOut >= 7) cfgchk &= c[6] & c[7];
    if (this.ptuOut >= 8) cfgchk &= c[8];
    const dfm17A = this.sn >= 23000000 && inv;
    let sensor = 'T', Rf = 220e3;
    if (cfgchk) {
      if (this.ptuOut >= 0xd || (this.ptuOut >= 0xc && this.meas24[6] < 220e3)) sensor = 'P';
      if (((this.ptuOut === 0xb || this.ptuOut === 0xc) && sensor === 'T') || this.ptuOut >= 0xd) Rf = 332e3;
      if (this.ptuOut === 0xa && sensor === 'T' && dfm17A) Rf = 332e3;
      if (this.ptuOut === 6 && (this.sondeTyp & 0xf) === 8) sensor = 'P';
    }
    let T = NaN;
    if (cfgchk && this.ptuOut) {
      const m = this.meas24;
      const f = sensor === 'P' ? m[1] : m[0], f1 = sensor === 'P' ? m[5] : m[3], f2 = sensor === 'P' ? m[6] : m[4];
      if (f * f1 * f2 !== 0) {
        const g = f2 / Rf, R = (f - f1) / g;
        T = dfmTempFromR(R);
      }
      if (Number.isFinite(T) && T > -120 && T < 60) out.tempC = T; else T = NaN;
    }
    if (this.ptuOut >= 0xa) {
      const ofs = sensor === 'P' ? 2 : 0;
      if (c[5 + ofs]) { const v = ((this.val24[5 + ofs] >> 4) & 0xffff) / 1000; if (v > 0) out.battV = v; }
      if (c[6 + ofs]) extra['MCU TEMPERATURE'] = `${(((this.val24[6 + ofs] >> 4) & 0xffff) / 100 - 273.15).toFixed(1)} °C`;
      if (Rf > 300e3 && c[7 + ofs]) extra['SONDE CLOCK'] = `${(this.val24[7 + ofs] >> 4) & 0xffff} s`;
    }
    const sub = this.sondeTyp & 0xf;
    let model: string;
    switch (sub) {
      case 0x6: model = 'DFM-06'; break;
      case 0x7: case 0x8: model = this.sn6 ? 'DFM-06P' : 'PS-15'; break;
      case 0xa: model = dfm17A ? 'DFM-17' : 'DFM-09'; break;
      case 0xb: model = 'DFM-17'; break;
      case 0xc: model = sensor === 'P' ? 'DFM-09P' : 'DFM-17'; break;
      case 0xd: model = 'DFM-17P'; break;
      default: model = 'DFM'; break;
    }
    if ((sub === 0x8 || sub === 0xc) && cfgchk && !Number.isFinite(T)) model = 'DFM';
    out.model = model;
    extra['SUBTYPE'] = `0x${sub.toString(16).toUpperCase()}`;
    out.extra = extra;
    return out;
  }
}

/** The DFM decoder on a channel: the framer, plus the FM polarity (a DFM-17 hint). */
export class DfmChannel implements ChannelDecoder {
  readonly name = 'DFM';
  private readonly fr: FskFramer;
  private readonly dec = new DfmDecoder();
  private readonly ring = new Float32Array(1024);
  private ri = 0;
  private readonly sps: number;
  constructor(rate: number, sink: SondeSink) {
    this.sps = rate / DFM_BAUD;
    this.fr = new FskFramer(DFM_BAUD, rate, DFM_HEADER, DFM_SYMS, 2, soft => {
      const f = this.dec.decodeSoft(soft, this.inverted(soft));
      if (f && f.serial) sink(f);
    });
  }
  push(x: number): void {
    this.ring[this.ri] = x; this.ri = (this.ri + 1) & 1023;
    this.fr.push(x);
  }
  /** Whether the framer flipped the symbols: the last 16 soft symbols against the raw discriminator under them. */
  private inverted(soft: Float32Array): boolean {
    const nSym = 16, total = Math.min(1000, Math.round(nSym * this.sps));
    let mean = 0;
    for (let t = 1; t <= total; t++) mean += this.ring[(this.ri - t) & 1023];
    mean /= total;
    let corr = 0;
    for (let j = 0; j < nSym; j++) {
      const a = Math.round(j * this.sps) + 1, b = Math.round((j + 1) * this.sps);
      let s = 0;
      for (let t = a; t <= b; t++) s += this.ring[(this.ri - t) & 1023] - mean;
      corr += soft[soft.length - 1 - j] * s;
    }
    return corr < 0;
  }
}
