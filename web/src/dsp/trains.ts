/**
 * Trains — the TypeScript twin of core/trains/TrainsDsp.kt and Trains.kt. Railroad telemetry, worked out from raw
 * recordings and the published field layouts:
 *
 * - EOT / HOT / DPU (end-of-train, head-of-train, distributed power) on 457.9375 / 452.9375 / 457.925 MHz: NBFM carrying
 *   1200 baud FFSK (mark 1200 Hz, space 1800 Hz). An EOT sends 69 bits of dotting, an 11-bit frame sync and a 63-bit
 *   block (45 data bits and an 18-bit BCH check XORed with a fixed key), twice. A HOT sends 456 bits of dotting, a 24-bit
 *   frame sync and one 64-bit block three times (30 data bits, 33 BCH, odd parity).
 * - PTC (I-ETMS / ITCnet) on 217-222 MHz: pi/4-DQPSK at 8000 symbols/s in 25 kHz channels, bursts of 17-25 ms. Every
 *   station opens with 9 preamble symbols and the same 30-symbol sync word; the rest is coded and whitened, so it is
 *   tracked (who, when, how often, has it changed) rather than read.
 */
import { BitSync, type Emit, type IqProcessor } from './core.js';
import { fft } from '../fft.js';

function lowpass(taps: number, cut: number): Float32Array {
  const m = taps - 1, h = new Float64Array(taps); let sum = 0;
  for (let k = 0; k < taps; k++) {
    const x = k - m / 2;
    const sinc = x === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * x) / (Math.PI * x);
    h[k] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * k / m)); sum += h[k];
  }
  return Float32Array.from(h, v => v / sum);
}

/**
 * A down-converter: mixes a channel to DC, integrates and dumps by d1 (to about four times the output rate), then an
 * FIR low-pass decimating by d2.
 */
export class Ddc {
  offsetHz = 0;
  outRate = 0;
  private inRate = 0; private d1 = 1; private d2 = 1;
  private h = new Float32Array(1);
  private bi = new Float32Array(2); private bq = new Float32Array(2); private bp = 0; private bc = 0;
  private ai = 0; private aq = 0; private ac = 0;
  private cr = 1; private ci = 0; private dr = 1; private di = 0; private lastOff = NaN;
  constructor(private readonly cutHz: number, private readonly wantRate: number, private readonly taps = 63) {}

  reset(rate: number): void {
    this.inRate = rate;
    this.d1 = Math.max(1, Math.round(rate / (this.wantRate * 4)));
    const mid = rate / this.d1;
    this.d2 = Math.max(1, Math.round(mid / this.wantRate));
    this.outRate = mid / this.d2;
    this.h = lowpass(this.taps, this.cutHz / mid);
    this.bi = new Float32Array(2 * this.taps); this.bq = new Float32Array(2 * this.taps); this.bp = 0; this.bc = 0;
    this.ai = 0; this.aq = 0; this.ac = 0; this.cr = 1; this.ci = 0; this.lastOff = NaN;
  }

  maxOut(n: number): number { return Math.floor(n / (this.d1 * this.d2)) + 2; }

  push(xi: Float32Array, xq: Float32Array, n: number, oi: Float32Array, oq: Float32Array): number {
    if (this.offsetHz !== this.lastOff) { this.lastOff = this.offsetHz; const w = -2 * Math.PI * this.offsetHz / this.inRate; this.dr = Math.cos(w); this.di = Math.sin(w); }
    let r = this.cr, s = this.ci, out = 0, sumI = this.ai, sumQ = this.aq, cnt = this.ac, bp = this.bp, bc = this.bc;
    const len = this.taps, inv = 1 / this.d1, d1 = this.d1, d2 = this.d2, dr = this.dr, di = this.di, h = this.h, bi = this.bi, bq = this.bq;
    for (let k = 0; k < n; k++) {
      const a = xi[k], b = xq[k];
      sumI += a * r - b * s; sumQ += a * s + b * r;
      const nr = r * dr - s * di; s = r * di + s * dr; r = nr;
      if (++cnt < d1) continue;
      cnt = 0;
      const yi = sumI * inv, yq = sumQ * inv; sumI = 0; sumQ = 0;
      bi[bp] = yi; bi[bp + len] = yi; bq[bp] = yq; bq[bp + len] = yq;
      if (++bp >= len) bp = 0;
      if (++bc < d2) continue;
      bc = 0;
      let si = 0, sq = 0;
      for (let t = 0; t < len; t++) { si += bi[bp + t] * h[t]; sq += bq[bp + t] * h[t]; }
      if (out < oi.length) { oi[out] = si; oq[out] = sq; out++; }
    }
    this.ai = sumI; this.aq = sumQ; this.ac = cnt; this.bp = bp; this.bc = bc;
    const m = 1 / Math.sqrt(r * r + s * s); this.cr = r * m; this.ci = s * m;
    return out;
  }
}

/** 1200 baud FFSK on an NFM channel: discriminator, one-bit mark/space correlators, clock recovery. */
export class FfskRx {
  fs = 0;
  private len = 20; private pi = 1; private pq = 0;
  private mRe = new Float32Array(1); private mIm = new Float32Array(1); private sRe = new Float32Array(1); private sIm = new Float32Array(1);
  private pos = 0; private smr = 0; private smi = 0; private ssr = 0; private ssi = 0;
  private wm = 0; private ws = 0; private tN = 0; private dc = 0;
  private sync = new BitSync(1200, 24_000);
  power = 0; floor = 0;
  constructor(private readonly onBit: (b: number) => void) {}

  reset(rate: number): void {
    this.fs = rate; this.len = Math.max(4, Math.round(rate / 1200));
    this.mRe = new Float32Array(this.len); this.mIm = new Float32Array(this.len); this.sRe = new Float32Array(this.len); this.sIm = new Float32Array(this.len);
    this.pos = 0; this.smr = 0; this.smi = 0; this.ssr = 0; this.ssi = 0;
    this.wm = 2 * Math.PI * 1200 / rate; this.ws = 2 * Math.PI * 1800 / rate; this.tN = 0;
    this.sync = new BitSync(1200, rate, 0.2);
    this.pi = 1; this.pq = 0; this.dc = 0; this.power = 0; this.floor = 0;
  }

  push(zi: Float32Array, zq: Float32Array, n: number): void {
    for (let k = 0; k < n; k++) {
      const i = zi[k], q = zq[k];
      const p = i * i + q * q;
      this.power += 0.01 * (p - this.power);
      this.floor = this.floor === 0 ? this.power : this.power < this.floor ? this.floor + 0.02 * (this.power - this.floor) : this.floor + 0.00002 * (this.power - this.floor);
      const re = i * this.pi + q * this.pq, im = q * this.pi - i * this.pq;
      this.pi = i; this.pq = q;
      let a = Math.atan2(im, re);
      this.dc += 0.002 * (a - this.dc); a -= this.dc;
      const t = this.tN++ % 1_000_000;
      const nmr = a * Math.cos(this.wm * t), nmi = -a * Math.sin(this.wm * t), nsr = a * Math.cos(this.ws * t), nsi = -a * Math.sin(this.ws * t);
      const ps = this.pos;
      this.smr += nmr - this.mRe[ps]; this.smi += nmi - this.mIm[ps]; this.ssr += nsr - this.sRe[ps]; this.ssi += nsi - this.sIm[ps];
      this.mRe[ps] = nmr; this.mIm[ps] = nmi; this.sRe[ps] = nsr; this.sIm[ps] = nsi;
      if (++this.pos >= this.len) {
        this.pos = 0;
        let a1 = 0, a2 = 0, a3 = 0, a4 = 0;
        for (let j = 0; j < this.len; j++) { a1 += this.mRe[j]; a2 += this.mIm[j]; a3 += this.sRe[j]; a4 += this.sIm[j]; }
        this.smr = a1; this.smi = a2; this.ssr = a3; this.ssi = a4;
      }
      const d = Math.hypot(this.smr, this.smi) - Math.hypot(this.ssr, this.ssi);
      const bit = this.sync.push(d);
      if (bit >= 0) this.onBit(bit);
    }
  }

  snrDb(): number { return this.floor <= 0 ? 0 : Math.round(10 * Math.log10(Math.max(this.power, 1e-9) / this.floor)); }
}

/** One decoded EOT (rear unit) frame. The layout follows PyEOT by Eric Reuter, checked against off-air recordings. */
export interface EotPacket {
  unit: number; psig: number; batteryPct: number; batteryCond: string; type: number; arm: string;
  motion: boolean; markerLight: boolean; markerBattery: boolean; turbine: boolean; valve: boolean; confirm: boolean; bits: string;
}

const GEN = [...'1111001101000001111'].map(Number);
const KEY = [...'101011011101110000'].map(Number);

export class EotParser {
  static readonly SYNC17 = 0b10101011100010010;
  static readonly FSYNC11 = 0b11100010010;
  private shift = 0; private got = -1; private readonly p = new Array<number>(74).fill(0);
  constructor(private readonly onPacket: (p: EotPacket) => void) {}

  push(bit: number): void {
    if (this.got >= 0) {
      this.p[11 + this.got] = bit;
      if (++this.got === 63) { this.got = -1; const e = EotParser.decode(this.p); if (e) this.onPacket(e); }
    }
    this.shift = ((this.shift << 1) | bit) & 0x1FFFF;
    let x = this.shift ^ EotParser.SYNC17, c = 0; while (x) { c += x & 1; x >>>= 1; }
    if (this.got < 0 && c <= 1) {
      for (let k = 0; k < 11; k++) this.p[k] = (EotParser.FSYNC11 >> (10 - k)) & 1;
      this.got = 0;
    }
  }

  /** The 18 check bits of a 45-bit data block (as sent), XORed with the key, as sent. */
  static check(data: number[]): number[] {
    const b = new Array<number>(63).fill(0);
    for (let i = 0; i < 45; i++) b[i] = data[44 - i];
    for (let i = 0; i < 45; i++) if (b[i] === 1) for (let j = 0; j < GEN.length; j++) b[i + j] ^= GEN[j];
    return Array.from({ length: 18 }, (_, i) => b[45 + i] ^ KEY[i]);
  }

  /** `p`: the 74 bits from the frame sync on. */
  static decode(p: number[]): EotPacket | null {
    const c = EotParser.check(p.slice(11, 56));
    for (let i = 0; i < 18; i++) if (c[i] !== p[56 + i]) return null;
    const r = (a: number, b: number) => { let v = 0; for (let i = a; i < b; i++) v |= p[i] << (i - a); return v; };
    const k = `${p[14]}${p[13]}`;
    const cond = k === '11' ? 'OK' : k === '10' ? 'LOW' : k === '01' ? 'VERY LOW' : 'NOT MONITORED';
    const type = (p[15] << 2) | (p[16] << 1) | p[17];
    const arm = type === 7 ? (p[51] === 0 ? 'ARMING' : 'ARMED') : 'NORMAL';
    return { unit: r(18, 35), psig: r(35, 42), batteryPct: Math.round(r(42, 49) * 100 / 127), batteryCond: cond, type, arm,
      motion: p[53] === 1, markerLight: p[55] === 1, markerBattery: p[54] === 1, turbine: p[52] === 1, valve: p[50] === 1, confirm: p[51] === 1, bits: p.join('') };
  }
}

/** One HOT (head unit) transmission: its frame sync and the 64-bit block, voted from its three copies. */
export interface HotFrame { sync24: number; block: bigint; data: number; agree: number; parityOk: boolean; }

export class HotParser {
  private last = -1; private run = 0; private got = -1;
  private readonly buf = new Array<number>(8 + 24 + 192 + 8).fill(0);
  constructor(private readonly onFrame: (f: HotFrame) => void) {}

  push(bit: number): void {
    if (this.got >= 0) {
      this.buf[this.got] = bit;
      if (++this.got === this.buf.length) { this.got = -1; this.decode(); }
      return;
    }
    if (bit !== this.last) this.run++;
    else {
      if (this.run >= 120) {
        for (let k = 0; k < 8; k++) this.buf[k] = (k & 1) === 0 ? this.last ^ 1 : this.last;
        this.buf[8] = bit; this.got = 9;
        this.last = bit; this.run = 1;
        return;
      }
      this.run = 1;
    }
    this.last = bit;
  }

  private block(at: number): bigint { let v = 0n; for (let k = 0; k < 64; k++) v = (v << 1n) | BigInt(this.buf[at + k]); return v; }

  private decode(): void {
    let best: HotFrame | null = null;
    for (let o = 0; o <= 16; o++) {
      const a = this.block(o + 24), b = this.block(o + 88), c = this.block(o + 152);
      const agree = (a === b ? 1 : 0) + (a === c ? 1 : 0) + (b === c ? 1 : 0);
      if (agree === 0) continue;
      const v = (a & b) | (a & c) | (b & c);
      let ones = 0; for (let x = v; x > 0n; x >>= 1n) ones += Number(x & 1n);
      let s = 0; for (let k = 0; k < 24; k++) s = (s << 1) | this.buf[o + k];
      const f: HotFrame = { sync24: s, block: v, data: Number((v >> 34n) & 0x3FFFFFFFn), agree: agree === 3 ? 3 : 2, parityOk: ones % 2 === 1 };
      if (!best || f.agree > best.agree || (f.agree === best.agree && f.parityOk && !best.parityOk)) best = f;
    }
    if (best) this.onFrame(best);
  }
}

/** One PTC burst, demodulated. */
export interface PtcBurst { hz: number; ms: number; durMs: number; snrDb: number; syncScore: number; payload: number[]; symbols: number; carrierHz: number; }

/** The sync word every station sends after its 9 preamble symbols (0 = +45°, 1 = +135°, 2 = -135°, 3 = -45°). */
export const PTC_SYNC = [...'020212232332130212131300131203'].map(Number);
/** Sync symbols that must match: a random burst matches about 8 of 30, and 22 is still out of its reach. */
export const PTC_MIN_SYNC = 22;
const BAND_LO = 216_000_000, BAND_HI = 222_500_000, WARM = 8;
/** Blocks each bin is averaged over (about a millisecond at 2-8 Msps), and the slot's power over its floor to light. */
const AVG = 4, THRESHOLD = 3.0;

export const snapHz = (hz: number) => Math.round(hz / 12_500) * 12_500;

/** Symbols as bits (Gray coded: +45° 00, +135° 01, -135° 11, -45° 10), packed into hex. */
export function symHex(sym: number[], from = 0, count = sym.length - from): string {
  let out = '', acc = 0, n = 0;
  for (let i = from; i < Math.min(sym.length, from + count); i++) {
    acc = (acc << 2) | [0, 1, 3, 2][sym[i] & 3]; n += 2;
    if (n === 8) { out += acc.toString(16).toUpperCase().padStart(2, '0'); acc = 0; n = 0; }
  }
  if (n > 0) out += (acc << (8 - n)).toString(16).toUpperCase().padStart(2, '0');
  return out;
}

/** The burst's carrier offset from DC: the power-weighted mean of its spectrum, symmetric about the carrier. */
export function carrier(zi: Float32Array, zq: Float32Array, n: number, fs: number): number {
  let nf = 256; while (nf < n && nf < 4096) nf *= 2;
  const re = new Float32Array(nf), im = new Float32Array(nf);
  for (let k = 0; k < Math.min(n, nf); k++) { re[k] = zi[k]; im[k] = zq[k]; }
  fft(re, im);
  let pw = 0, fw = 0;
  for (let b = 0; b < nf; b++) {
    const f = (b < nf / 2 ? b : b - nf) * fs / nf;
    if (Math.abs(f) > 12_000) continue;
    const p = re[b] * re[b] + im[b] * im[b]; pw += p; fw += p * f;
  }
  return pw > 0 ? fw / pw : 0;
}

/** pi/4-DQPSK at 8000 symbols/s: the clock phase with the tightest constellation, the carrier off the 4th power, then
 *  the sync searched in any rotation (and mirrored). */
export function demod(zi: Float32Array, zq: Float32Array, n: number, fs: number): { score: number; payload: number[]; symbols: number } | null {
  const sps = fs / 8000;
  if (n < sps * 50) return null;
  let pk = 0; for (let k = 0; k < n; k++) pk = Math.max(pk, zi[k] * zi[k] + zq[k] * zq[k]);
  let s0 = 0; while (s0 < n && zi[s0] * zi[s0] + zq[s0] * zq[s0] < pk * 0.05) s0++;
  let s1 = n - 1; while (s1 > s0 && zi[s1] * zi[s1] + zq[s1] * zq[s1] < pk * 0.05) s1--;
  let bestM = -1, bestR: Float64Array | null = null, bestI: Float64Array | null = null;
  for (let ph = 0; ph < 8; ph++) {
    const t0 = s0 + ph * sps / 8, cnt = Math.floor((s1 - t0) / sps);
    if (cnt < 40) continue;
    const sr = new Float64Array(cnt), si = new Float64Array(cnt);
    for (let k = 0; k < cnt; k++) {
      const t = t0 + k * sps, i0 = Math.floor(t), fr = t - i0, i1 = Math.min(i0 + 1, n - 1);
      sr[k] = zi[i0] * (1 - fr) + zi[i1] * fr; si[k] = zq[i0] * (1 - fr) + zq[i1] * fr;
    }
    const dr = new Float64Array(cnt - 1), di = new Float64Array(cnt - 1);
    let ar = 0, aI = 0;
    for (let k = 1; k < cnt; k++) {
      const r = sr[k] * sr[k - 1] + si[k] * si[k - 1], i = si[k] * sr[k - 1] - sr[k] * si[k - 1];
      const mag = Math.hypot(r, i) + 1e-12, ur = r / mag, ui = i / mag;
      dr[k - 1] = ur; di[k - 1] = ui;
      const r2 = ur * ur - ui * ui, i2 = 2 * ur * ui;
      ar += r2 * r2 - i2 * i2; aI += 2 * r2 * i2;
    }
    const metric = Math.hypot(ar, aI) / (cnt - 1);
    if (metric > bestM) { bestM = metric; bestR = dr; bestI = di; }
  }
  if (!bestR || !bestI) return null;
  const dr = bestR, di = bestI;
  let ar = 0, aI = 0;
  for (let k = 0; k < dr.length; k++) { const r2 = dr[k] * dr[k] - di[k] * di[k], i2 = 2 * dr[k] * di[k]; ar += r2 * r2 - i2 * i2; aI += 2 * r2 * i2; }
  const off = Math.atan2(-aI, -ar) / 4;
  const q = Array.from(dr, (_, k) => {
    let a = (Math.atan2(di[k], dr[k]) - off) * 180 / Math.PI;
    a = ((a + 540) % 360) - 180;
    return ((Math.round((a - 45) / 90) % 4) + 4) % 4;
  });
  let best = 0, bo = 0, bmir = false, brot = 0;
  for (const mir of [false, true]) for (let o = 0; o <= Math.min(60, q.length - PTC_SYNC.length); o++) for (let rot = 0; rot < 4; rot++) {
    let c = 0;
    for (let i = 0; i < PTC_SYNC.length; i++) { const v = mir ? 3 - q[o + i] : q[o + i]; if ((v + rot) % 4 === PTC_SYNC[i]) c++; }
    if (c > best) { best = c; bo = o; bmir = mir; brot = rot; }
  }
  const start = bo + PTC_SYNC.length, tail = Math.max(0, q.length - start - 3);
  const payload = Array.from({ length: tail }, (_, k) => ((bmir ? 3 - q[start + k] : q[start + k]) + brot) % 4);
  return { score: best, payload, symbols: q.length + 1 };
}

interface Open { startBlk: number; lastBlk: number; lo: number; hi: number; pw: number; fw: number; peak: number; peakFloor: number; lit: number; }

/** Watches a wide span for PTC bursts against a per-bin floor; each burst is cut out of a ring and demodulated. */
export class PtcScanner {
  centerHz = 0;
  now: () => number = () => Date.now();
  trace: ((s: string) => void) | null = null;
  others = 0; bursts = 0;
  private rate = 0; private nfft = 256;
  private re = new Float32Array(1); private im = new Float32Array(1); private win = new Float32Array(1); private floorP = new Float32Array(1);
  private bufI = new Float32Array(1); private bufQ = new Float32Array(1); private fill = 0;
  private ringI = new Float32Array(1); private ringQ = new Float32Array(1); private abs0 = 0; private ringAt = 0;
  private blk = 0; private warm = 0;
  private open: Open[] = [];
  /** Each bin's power over the last AVG blocks (a ring and its running sum): one block's noise is all over the place. */
  private hist: Float32Array[] = []; private sumP = new Float32Array(1);
  /** Which 12.5 kHz slot each bin falls in (-1: off the band, on the spike at the center or at the span's edges), each
   *  slot's raster channel and bins, and each bin's frequency; worked out again when the tuning moves. */
  private slotOf = new Int32Array(1); private binFreq = new Float64Array(1); private mapCenter = NaN;
  private slotCh: number[] = []; private slotLo: number[] = []; private slotHi: number[] = [];
  private slotP = new Float64Array(0); private slotF = new Float64Array(0); private slotFloor = new Float64Array(0);

  private mapSlots(center: number): void {
    this.mapCenter = center;
    const n = this.nfft, binHz = this.rate / n;
    this.slotOf = new Int32Array(n).fill(-1); this.binFreq = new Float64Array(n);
    const chs: number[] = [], los: number[] = [], his: number[] = [];
    for (let b = 0; b < n; b++) {
      const off = (b - n / 2) * binHz, hz = center + off;
      this.binFreq[b] = hz;
      if (Math.abs(off) < 12_000 || Math.abs(off) > this.rate * 0.45 || hz < BAND_LO || hz > BAND_HI) continue;
      const ch = Math.round(hz / 12_500);
      if (chs.length === 0 || chs[chs.length - 1] !== ch) { chs.push(ch); los.push(b); his.push(b); } else his[his.length - 1] = b;
      this.slotOf[b] = chs.length - 1;
    }
    this.slotCh = chs; this.slotLo = los; this.slotHi = his;
    this.slotP = new Float64Array(chs.length); this.slotF = new Float64Array(chs.length); this.slotFloor = new Float64Array(chs.length);
  }
  constructor(private readonly onBurst: (b: PtcBurst) => void) {}

  reset(rate: number): void {
    this.rate = rate;
    let hb = 1; while (hb * 2 <= Math.max(64, Math.floor(rate / 6000))) hb *= 2;
    this.nfft = Math.min(4096, hb * 2);
    const n = this.nfft;
    this.re = new Float32Array(n); this.im = new Float32Array(n); this.floorP = new Float32Array(n);
    this.win = Float32Array.from({ length: n }, (_, k) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1)));
    this.bufI = new Float32Array(n); this.bufQ = new Float32Array(n); this.fill = 0;
    const ring = Math.max(n * 4, Math.floor(rate * 0.09));
    this.ringI = new Float32Array(ring); this.ringQ = new Float32Array(ring); this.abs0 = 0; this.ringAt = 0;
    this.blk = 0; this.open = []; this.warm = 0;
    this.hist = Array.from({ length: AVG }, () => new Float32Array(n)); this.sumP = new Float32Array(n); this.mapCenter = NaN;
  }

  push(xi: Float32Array, xq: Float32Array, n: number): void {
    const rl = this.ringI.length; let ix = this.ringAt;
    for (let k = 0; k < n; k++) {
      this.ringI[ix] = xi[k]; this.ringQ[ix] = xq[k];
      if (++ix === rl) ix = 0;
      this.bufI[this.fill] = xi[k]; this.bufQ[this.fill] = xq[k];
      if (++this.fill === this.nfft) { this.fill = 0; this.ringAt = ix; this.block(this.abs0 + k + 1); }
    }
    this.ringAt = ix; this.abs0 += n;
  }

  private block(endAbs: number): void {
    const n = this.nfft;
    for (let k = 0; k < n; k++) { this.re[k] = this.bufI[k] * this.win[k]; this.im[k] = this.bufQ[k] * this.win[k]; }
    fft(this.re, this.im);
    const center = this.centerHz;
    if (center !== this.mapCenter) this.mapSlots(center);
    // Each 12.5 kHz slot's power, summed over its bins and averaged over the last few blocks, against the same sum of
    // the bins' floors: a weak burst (an RTL-SDR on a short antenna) is a few dB over the noise in any one bin and
    // block, but clearly over it across its channel and a millisecond.
    const h = this.hist[this.blk % AVG], ready = this.blk >= AVG;
    this.slotP.fill(0); this.slotF.fill(0); this.slotFloor.fill(0);
    for (let b = 0; b < n; b++) {
      const idx = (b + n / 2) % n;
      const p = this.re[idx] * this.re[idx] + this.im[idx] * this.im[idx];
      this.sumP[b] += p - h[b]; h[b] = p;
      if (!ready) continue;
      const avg = this.sumP[b] / AVG;
      if (this.warm < WARM) { this.floorP[b] += (avg - this.floorP[b]) / (this.warm + 1); continue; }
      const sl = this.slotOf[b];
      if (sl < 0) continue;
      this.slotP[sl] += avg; this.slotF[sl] += avg * this.binFreq[b]; this.slotFloor[sl] += this.floorP[b];
    }
    if (!ready) { this.blk++; return; }
    if (this.warm < WARM) { this.warm++; this.blk++; return; }
    // lit slots: power, power x frequency, peak, the floor under the peak
    const seen = new Map<number, number[]>();
    for (let sl = 0; sl < this.slotCh.length; sl++) {
      if (this.slotP[sl] <= 0) continue;
      const active = this.slotP[sl] > this.slotFloor[sl] * THRESHOLD;
      // the floor is a mean of the quiet blocks; a slot lit for long (a carrier, not a burst) joins it slowly
      // (by a fixed ratio: a step toward a burst's own power would swallow it within a few milliseconds)
      for (let b = this.slotLo[sl]; b <= this.slotHi[sl]; b++) this.floorP[b] = active ? this.floorP[b] * 1.003 : this.floorP[b] + 0.02 * (this.sumP[b] / AVG - this.floorP[b]);
      if (active) seen.set(this.slotCh[sl], [this.slotP[sl], this.slotF[sl], this.slotP[sl], this.slotFloor[sl]]);
    }
    let runLo = -1e9, runHi = 0; const acc = [0, 0, 0, 0];
    const flush = () => {
      if (runLo === -1e9) return;
      let o = this.open.find(x => runLo <= x.hi + 1 && runHi >= x.lo - 1);
      if (!o) { o = { startBlk: this.blk, lastBlk: this.blk, lo: runLo, hi: runHi, pw: 0, fw: 0, peak: 0, peakFloor: 1, lit: 0 }; this.open.push(o); }
      if (o.lastBlk !== this.blk || o.lit === 0) o.lit++;
      o.lastBlk = this.blk; o.lo = Math.min(o.lo, runLo); o.hi = Math.max(o.hi, runHi);
      o.pw += acc[0]; o.fw += acc[1];
      if (acc[2] > o.peak) { o.peak = acc[2]; o.peakFloor = acc[3]; }
      runLo = -1e9; acc.fill(0);
    };
    for (const ch of [...seen.keys()].sort((x, y) => x - y)) {
      const a = seen.get(ch)!;
      if (runLo !== -1e9 && ch > runHi + 1) flush();
      if (runLo === -1e9) runLo = ch;
      runHi = ch;
      acc[0] += a[0]; acc[1] += a[1]; if (a[2] > acc[2]) { acc[2] = a[2]; acc[3] = a[3]; }
    }
    flush();
    const done = this.open.filter(o => this.blk - o.lastBlk >= 2);
    this.open = this.open.filter(o => this.blk - o.lastBlk < 2);
    for (const o of done) {
      const nb = o.lastBlk - o.startBlk + 1, dur = nb * n / this.rate;
      if (dur < 0.006 || dur > 0.07 || o.lit < nb * 0.7) continue;
      // a PTC channel is 25 kHz (two or three slots): wider and weak is noise lighting up, not a burst (a strong
      // burst's skirts light the slots around it, so width alone says nothing)
      if (o.hi - o.lo > 3 && o.peak < o.peakFloor * 100) continue;
      // the averaging lights a burst up to AVG blocks late and holds it as long after: start that much earlier
      const startAbs = endAbs - (this.blk - o.startBlk + 1 + AVG) * n - Math.floor(this.rate * 0.0007);
      const endBurst = endAbs - (this.blk - o.lastBlk) * n + Math.floor(this.rate * 0.0007);
      if (endAbs - startAbs >= this.ringI.length) continue;
      const hz = o.fw / o.pw;
      this.trace?.(`burst ${(hz / 1e6).toFixed(4)} MHz blocks ${nb} lit ${o.lit} dur ${(dur * 1000).toFixed(1)} ms`);
      this.extract(startAbs, endBurst, hz, center, dur, Math.round(10 * Math.log10(o.peak / Math.max(o.peakFloor, 1e-9))));
    }
    this.blk++;
  }

  private extract(a: number, b: number, hz: number, center: number, dur: number, snr: number): void {
    const n = b - a; if (n <= 0) return;
    const rl = this.ringI.length, xi = new Float32Array(n), xq = new Float32Array(n);
    for (let k = 0; k < n; k++) { const ix = (((a + k) % rl) + rl) % rl; xi[k] = this.ringI[ix]; xq[k] = this.ringQ[ix]; }
    // wide first (the coarse centroid can be a bin off), then the carrier measured and the channel cut tight
    const ddc = new Ddc(14_000, 64_000); ddc.reset(this.rate); ddc.offsetHz = hz - center;
    const wi = new Float32Array(ddc.maxOut(n)), wq = new Float32Array(wi.length);
    const m = ddc.push(xi, xq, n, wi, wq), fs = ddc.outRate;
    const fo = carrier(wi, wq, m, fs);
    const tight = new Ddc(5_500, fs, 97); tight.reset(fs); tight.offsetHz = fo;
    const oi = new Float32Array(tight.maxOut(m)), oq = new Float32Array(oi.length);
    const k = tight.push(wi, wq, m, oi, oq);
    this.bursts++;
    const d = demod(oi, oq, k, tight.outRate);
    const f = hz + fo;
    const burst: PtcBurst = { hz: snapHz(f), ms: this.now(), durMs: dur * 1000, snrDb: snr, syncScore: d?.score ?? 0, payload: d?.payload ?? [], symbols: d?.symbols ?? 0, carrierHz: f - snapHz(f) };
    if (burst.syncScore < PTC_MIN_SYNC) this.others++;
    this.onBurst(burst);
  }
}

export interface EotUnit { unit: number; channel: string; firstMs: number; lastMs: number; frames: number; last: EotPacket; pressure: [number, number][]; snr: number[]; hotMs: number; }
export interface HotHeard { ms: number; data: number; sync24: number; agree: number; parityOk: boolean; unit: number | null; snrDb: number; }
export type PtcKind = 'WAYSIDE' | 'BASE' | 'LOCOMOTIVE' | 'OTHER';
export interface PtcStation {
  hz: number; kind: PtcKind; firstMs: number; lastMs: number; bursts: number; gaps: number[]; lastSymbols: number; changes: number;
  lastChangeMs: number; snr: number[]; print: number[]; times: number[]; steady: number; differed: number;
  /** Its transmitter's carrier off the channel (Hz, smoothed), the burst lengths it sends, its strongest burst, and its last message. */
  carrierHz: number; lengths: number[]; snrMax: number; last: number[];
}
export const PTC_KIND_LABEL: Record<PtcKind, string> = { WAYSIDE: 'WAYSIDE', BASE: 'BASE STATION', LOCOMOTIVE: 'LOCOMOTIVE', OTHER: 'PTC' };
export const stationVaries = (s: PtcStation) => s.bursts >= 4 && s.differed * 2 > s.bursts;
export const stationPeriod = (s: PtcStation) => { if (s.gaps.length < 2) return 0; const g = [...s.gaps].sort((a, b) => a - b); return g[Math.floor(g.length / 2)]; };

export const EOT_HZ = 457_937_500, HOT_HZ = 452_937_500, DPU_HZ = 457_925_000;
export const EOT_CENTER = 455_437_500, EOT_RATE = 6_000_000, EOT_NARROW = 457_687_500;
export const PTC_CENTER = 219_256_250, PTC_RATE = 8_000_000, PTC_NARROW = 220_106_250;

export function kindOf(hz: number): PtcKind {
  if (hz >= 217_000_000 && hz < 220_000_000) return 'WAYSIDE';
  if (hz >= 220_000_000 && hz < 221_000_000) return 'BASE';
  if (hz >= 221_000_000 && hz < 222_000_000) return 'LOCOMOTIVE';
  return 'OTHER';
}
export function differs(a: number[], b: number[]): boolean {
  const n = Math.min(a.length, b.length); if (n < 8) return a.length !== b.length;
  let d = 0; for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d > Math.max(3, Math.floor(n / 12)) || Math.abs(a.length - b.length) > 4;
}
export function inData(data: number, unit: number): boolean {
  for (let o = 0; o <= 13; o++) {
    const w = (data >>> o) & 0x1FFFF;
    if (w === unit) return true;
    let r = 0; for (let i = 0; i < 17; i++) r |= ((w >> i) & 1) << (16 - i);
    if (r === unit) return true;
  }
  return false;
}

interface Chan { name: string; hz: number; ddc: Ddc; rx: FfskRx; on: boolean; oi: Float32Array; oq: Float32Array; lastSeenMs: number; lastFrame: string; lastFrameMs: number; }

/**
 * Trains: one receiver for the railroad's radios. EOT mode sits between 452.9375 and 457.9375 MHz and decodes the end
 * and head units (and DPU traffic) at once where the radio is wide enough; PTC mode watches 216-222.5 MHz for the
 * train-control network. Receive only. Publishes a 'trains' snapshot (at most four a second) and 'packet' log lines.
 */
export class TrainsProcessor implements IqProcessor {
  band: 'EOT' | 'PTC' = 'EOT';
  centerHz = 0;
  now: () => number = () => Date.now();
  onEot: ((p: EotPacket, ch: string) => void) | null = null;
  onPtc: ((b: PtcBurst) => void) | null = null;
  readonly units = new Map<number, EotUnit>();
  readonly stations = new Map<number, PtcStation>();
  hots: HotHeard[] = [];
  readonly activity: Record<string, number> = {};
  private readonly lastPayload = new Map<number, number[]>();
  private readonly lastLogMs = new Map<number, number>();
  private rate = 0; private lastCenter = NaN; private lastPost = 0; private pending = false;
  private fi = new Float32Array(0); private fq = new Float32Array(0);
  private readonly chans: Chan[];
  readonly ptc: PtcScanner;

  constructor(private readonly emit: Emit | null) {
    this.chans = ([['EOT', EOT_HZ], ['HOT', HOT_HZ], ['DPU', DPU_HZ]] as [string, number][]).map(([name, hz]) => {
      const ch = { name, hz, ddc: new Ddc(7_000, 24_000), on: false, oi: new Float32Array(0), oq: new Float32Array(0), lastSeenMs: 0, lastFrame: '', lastFrameMs: 0 } as Chan;
      const eot = new EotParser(p => this.eotFrame(p, ch)), eotInv = new EotParser(p => this.eotFrame(p, ch)), hot = new HotParser(f => this.hotFrame(f, ch));
      ch.rx = new FfskRx(b => { eot.push(b); eotInv.push(1 - b); hot.push(b); });
      return ch;
    });
    this.ptc = new PtcScanner(b => this.ptcBurst(b));
  }

  reset(rate: number): void {
    this.rate = rate;
    const c = this.centerHz;
    for (const ch of this.chans) {
      ch.ddc.reset(rate); ch.ddc.offsetHz = ch.hz - c;
      ch.on = Math.abs(ch.hz - c) < rate * 0.45 - 8_000;
      ch.rx.reset(ch.ddc.outRate);
    }
    this.lastCenter = c;
    this.ptc.centerHz = c; this.ptc.now = this.now;
    this.ptc.reset(rate);
    this.post(true);
  }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    const n = iq.length >> 1;
    if (this.fi.length < n) { this.fi = new Float32Array(n); this.fq = new Float32Array(n); }
    for (let k = 0; k < n; k++) { this.fi[k] = iq[2 * k] + 0.6; this.fq[k] = iq[2 * k + 1] + 0.6; }
    const c = this.centerHz;
    if (this.band === 'EOT') {
      if (c !== this.lastCenter) { this.lastCenter = c; for (const ch of this.chans) ch.on = Math.abs(ch.hz - c) < this.rate * 0.45 - 8_000; this.post(true); }
      for (const ch of this.chans) {
        if (!ch.on) continue;
        ch.ddc.offsetHz = ch.hz - c;
        const need = ch.ddc.maxOut(n);
        if (ch.oi.length < need) { ch.oi = new Float32Array(need); ch.oq = new Float32Array(need); }
        const m = ch.ddc.push(this.fi, this.fq, n, ch.oi, ch.oq);
        ch.rx.push(ch.oi, ch.oq, m);
        if (ch.rx.snrDb() >= 8) { const t = this.now(); if (t - ch.lastSeenMs > 300) { ch.lastSeenMs = t; this.activity[ch.name] = t; this.post(); } }
      }
    } else { this.ptc.centerHz = c; this.ptc.push(this.fi, this.fq, n); }
    if (this.pending) this.post();
  }

  hears(): string[] { return this.chans.filter(c => c.on).map(c => c.name); }

  private log(line: string): void { this.emit?.({ type: 'packet', line }); }

  /** The snapshot for the screen, at most four times a second (and right away when [force]). */
  private post(force = false): void {
    const t = Date.now();
    if (!force && t - this.lastPost < 250) { this.pending = true; return; }
    this.pending = false; this.lastPost = t;
    this.emit?.({ type: 'trains', band: this.band, hears: this.hears(), units: [...this.units.values()], hots: this.hots, stations: [...this.stations.values()],
      activity: { ...this.activity }, other: this.ptc.others });
  }

  private eotFrame(p: EotPacket, ch: Chan): void {
    const t = this.now();
    // each frame is sent twice and both polarities are tried: one report per frame
    if (p.bits === ch.lastFrame && t - ch.lastFrameMs < 1500) return;
    ch.lastFrame = p.bits; ch.lastFrameMs = t;
    this.onEot?.(p, ch.name);
    const snr = ch.rx.snrDb(), old = this.units.get(p.unit);
    this.units.set(p.unit, old
      ? { ...old, lastMs: t, frames: old.frames + 1, last: p, channel: ch.name, pressure: [...old.pressure, [t, p.psig] as [number, number]].slice(-90), snr: [...old.snr, snr].slice(-40) }
      : { unit: p.unit, channel: ch.name, firstMs: t, lastMs: t, frames: 1, last: p, pressure: [[t, p.psig]], snr: [snr], hotMs: 0 });
    this.log(`${ch.name === 'DPU' ? 'DPU 457.925' : 'EOT 457.9375'} unit ${p.unit} · ${p.psig} psig · ${p.motion ? 'MOVING' : 'stopped'} · marker ${p.markerLight ? 'on' : 'off'} · battery ${p.batteryPct}% ${p.batteryCond}${p.arm !== 'NORMAL' ? ` · ${p.arm}` : ''}`);
    this.post(true);
  }

  private hotFrame(f: HotFrame, ch: Chan): void {
    const t = this.now(), key = f.block.toString(16);
    if (key === ch.lastFrame && t - ch.lastFrameMs < 1500) return;
    ch.lastFrame = key; ch.lastFrameMs = t;
    // a unit on the board whose 17-bit address shows up in the command (either bit order) is the one addressed
    const unit = [...this.units.keys()].sort((a, b) => a - b).find(u => inData(f.data, u)) ?? null;
    this.hots = [{ ms: t, data: f.data, sync24: f.sync24, agree: f.agree, parityOk: f.parityOk, unit, snrDb: ch.rx.snrDb() }, ...this.hots].slice(0, 30);
    if (unit !== null) { const u = this.units.get(unit)!; this.units.set(unit, { ...u, hotMs: t }); }
    this.log(`HOT ${ch.name === 'HOT' ? '452.9375' : ch.name} · command ${f.data.toString(16).toUpperCase().padStart(8, '0')}${unit !== null ? ` → unit ${unit}` : ''} · ${f.agree} of 3 copies agree${f.parityOk ? '' : ' · parity?'}`);
    this.post(true);
  }

  private ptcBurst(b: PtcBurst): void {
    this.onPtc?.(b);
    if (b.syncScore < PTC_MIN_SYNC) { this.post(); return; }
    const t = b.ms, old = this.stations.get(b.hz), prev = this.lastPayload.get(b.hz);
    const differ = prev !== undefined && differs(prev, b.payload);
    // a change of status: new content from a station that had been repeating itself
    const changed = differ && old !== undefined && old.steady >= 1;
    this.lastPayload.set(b.hz, b.payload);
    const s: PtcStation = old
      ? { ...old, lastMs: t, bursts: old.bursts + 1, gaps: [...old.gaps, (t - old.lastMs) / 1000].slice(-12), lastSymbols: b.symbols,
          changes: old.changes + (changed ? 1 : 0), lastChangeMs: changed ? t : old.lastChangeMs, snr: [...old.snr, b.snrDb].slice(-40),
          print: b.payload.slice(0, 24), times: [...old.times, t].filter(x => t - x < 300_000).slice(-200),
          steady: prev !== undefined && !differ ? old.steady + 1 : 0, differed: old.differed + (differ ? 1 : 0),
          carrierHz: old.carrierHz + 0.2 * (b.carrierHz - old.carrierHz), lengths: [...new Set([...old.lengths, b.symbols])].sort((x, y) => x - y).slice(-8),
          snrMax: Math.max(old.snrMax, b.snrDb), last: b.payload }
      : { hz: b.hz, kind: kindOf(b.hz), firstMs: t, lastMs: t, bursts: 1, gaps: [], lastSymbols: b.symbols, changes: 0, lastChangeMs: 0,
          snr: [b.snrDb], print: b.payload.slice(0, 24), times: [t], steady: 0, differed: 0, carrierHz: b.carrierHz, lengths: [b.symbols], snrMax: b.snrDb, last: b.payload };
    this.stations.set(b.hz, s);
    const quiet = old !== undefined && t - (this.lastLogMs.get(b.hz) ?? 0) < 30_000;
    if (!old || changed || (s.kind === 'LOCOMOTIVE' && !quiet)) {
      this.lastLogMs.set(b.hz, t);
      this.log(`PTC ${(b.hz / 1e6).toFixed(4)} ${PTC_KIND_LABEL[s.kind]} · ${b.symbols} symbols · +${b.snrDb} dB${!old ? ' · new station' : changed ? ' · STATUS CHANGED' : ''}`);
    }
    this.post(!old || changed);
  }

  clear(): void {
    this.units.clear(); this.stations.clear(); this.lastPayload.clear(); this.lastLogMs.clear(); this.hots = [];
    for (const k of Object.keys(this.activity)) delete this.activity[k];
    this.post(true);
  }
}
