/**
 * NRSC-5 FM hybrid (MP1) Layer 1 receive front end, from SY_IDD_1011s rev H:
 *  - mix the station to 0 Hz, conjugate (14.2.2 up-converts with exp(-j2 pi fc t), so the RF spectrum is inverted
 *    against the subcarrier numbering), resample to 744187.5 Hz (3.5: 2048 points at 363.373 Hz spacing);
 *  - symbol timing and fractional carrier offset from the cyclic extension (13.2), on the primary sidebands only;
 *  - integer carrier offset from the DBPSK reference subcarriers (12.2.2, Table 12-24);
 *  - block sync and the system control word (11.2, 11.3, Table 11-1), BC and PSMI;
 *  - channel estimate from the known reference values (Table 12-18) and QPSK soft bits (Table 12-15) laid out as the
 *    512 x 720 PM matrix of one L1 frame.
 */
import { fft } from '../../fft.js';
import { PM_COLS, PM_ROWS, pmColumns } from './fec.js';

export const FS = 744_187.5;
export const NFFT = 2048, NCP = 112, NSYM = NFFT + NCP;
export const DF = FS / NFFT;
/** Subcarriers kept per symbol: -546..546. */
export const NSC = 1093;
const WIN_OFF = NCP >> 1;

/** MP1 reference subcarriers (Table 12-24) and their column of the reference matrix. */
export const REF_SC: number[] = [], REF_COL: number[] = [];
for (let j = 0, sc = -546; sc <= -356; sc += 19, j++) { REF_SC.push(sc); REF_COL.push(j); }
for (let j = 0, sc = 356; sc <= 546; sc += 19, j++) { REF_SC.push(sc); REF_COL.push(50 + j); }
const NREF = REF_SC.length;

/** Table 11-1 fixed sync bits (bit number to value). */
export const SYNC_BITS: [number, number][] = [[31, 0], [30, 1], [29, 1], [28, 0], [27, 0], [26, 1], [25, 0], [22, 1], [17, 0], [10, 1], [9, 1]];
/** Table 11-3 reference subcarrier identification: [bit 21, bit 20] for a reference matrix column. */
export function rsidForCol(c: number): [number, number] {
  const a: [number, number][] = c <= 30 ? [[1, 0], [0, 1], [0, 0], [1, 1]] : [[1, 0], [1, 1], [0, 0], [0, 1]];
  return a[c % 4];
}

export interface ScWord { syncOk: boolean; p0: boolean; p1: boolean; p2: boolean; p3: boolean; bc: number; psmi: number; sci: number; rsid: number; asm0: number; asm1: number }
/** b[0] is bit 31 (row 0 of the block) ... b[31] is bit 0. */
export function decodeScWord(b: ArrayLike<number>): ScWord {
  const bit = (i: number) => b[31 - i] & 1;
  let psmi = 0; for (let i = 0; i < 6; i++) psmi |= bit(1 + i) << i;
  let p0 = 0; for (let i = 0; i < 9; i++) p0 ^= bit(i);
  return {
    syncOk: SYNC_BITS.every(([i, v]) => bit(i) === v),
    sci: bit(24), p3: ((bit(24) + bit(23)) & 1) === 0,
    rsid: (bit(21) << 1) | bit(20), asm1: bit(19), p2: ((bit(19) + bit(21) + bit(20) + bit(18)) & 1) === 0,
    bc: (bit(15) << 3) | (bit(14) << 2) | (bit(13) << 1) | bit(12),
    p1: ((bit(15) + bit(14) + bit(13) + bit(12) + bit(16) + bit(11)) & 1) === 0,
    asm0: bit(8), psmi, p0: p0 === 0,
  };
}

/** Windowed-sinc polyphase resampler from any input rate to FS, complex. */
class Resampler {
  private rate = 0; private step = 1; private T = 0; private readonly P = 256;
  private table = new Float32Array(0);
  private inRe = new Float32Array(0); private inIm = new Float32Array(0); private inN = 0; private t = 0;
  configure(rate: number): void {
    this.rate = rate; this.step = rate / FS;
    // pass to 200 kHz, stop by 544 kHz (what folds back into the sidebands after resampling)
    const fc = 372_000 / rate, trans = 344_000 / rate;
    this.T = Math.max(8, 2 * Math.ceil(5.5 / trans / 2));
    const T = this.T, P = this.P;
    this.table = new Float32Array((P + 1) * T);
    for (let p = 0; p <= P; p++) {
      const frac = p / P; let sum = 0;
      for (let m = 0; m < T; m++) {
        const x = frac - (m - T / 2 + 1);
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const u = x / T + 0.5;
        const w = u <= 0 || u >= 1 ? 0 : 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
        const v = sinc * w; this.table[p * T + m] = v; sum += v;
      }
      for (let m = 0; m < T; m++) this.table[p * T + m] /= sum;
    }
    this.inRe = new Float32Array(1 << 16); this.inIm = new Float32Array(1 << 16); this.inN = 0; this.t = T / 2;
  }
  get configuredRate(): number { return this.rate; }
  /** Append input samples; every output sample goes to `out`. */
  push(re: Float32Array, im: Float32Array, n: number, out: (r: number, i: number) => void): void {
    if (this.inN + n > this.inRe.length) {
      const cap = Math.max(this.inRe.length * 2, this.inN + n);
      const a = new Float32Array(cap), b = new Float32Array(cap); a.set(this.inRe.subarray(0, this.inN)); b.set(this.inIm.subarray(0, this.inN));
      this.inRe = a; this.inIm = b;
    }
    this.inRe.set(re.subarray(0, n), this.inN); this.inIm.set(im.subarray(0, n), this.inN); this.inN += n;
    const T = this.T, P = this.P, tab = this.table, xr = this.inRe, xi = this.inIm, half = T / 2;
    let t = this.t;
    while (Math.floor(t) + half < this.inN) {
      const i0 = Math.floor(t), p = Math.round((t - i0) * P), base = p * T, j0 = i0 - half + 1;
      let sr = 0, si = 0;
      for (let m = 0; m < T; m++) { const h = tab[base + m]; sr += h * xr[j0 + m]; si += h * xi[j0 + m]; }
      out(sr, si);
      t += this.step;
    }
    const drop = Math.max(0, Math.floor(t) - half);
    if (drop > 0) { xr.copyWithin(0, drop, this.inN); xi.copyWithin(0, drop, this.inN); this.inN -= drop; t -= drop; }
    this.t = t;
  }
}

/** One L1 frame's demodulated content, ready for de-interleaving. */
export interface FrameSoft {
  /** 512 x 720 PM matrix of soft values, positive meaning 1. */
  pm: Float32Array;
  psmi: number;
  /** Per-sideband SNR of the equalized data subcarriers, dB. */
  snrLoDb: number; snrHiDb: number;
  /** Absolute sample (at FS) where the frame starts. */
  startSample: number;
}

export type RxState = 'search' | 'ofdm' | 'sync' | 'frames';
export interface RxStatus {
  state: RxState; cfoHz: number; cpLock: number; blocks: number; blocksBad: number; psmi: number; bc: number;
}

const RING = 1 << 19, RMASK = RING - 1;
const ACQ_N = 1 << 17;
const SYMS = 640;

/**
 * Raw IQ in, L1 frames out. Push int8 IQ with `push`; each complete, block-synchronized L1 frame is handed to
 * `onFrame` as its PM soft matrix.
 */
export class HdRx {
  onFrame: (f: FrameSoft) => void = () => {};
  private readonly rs = new Resampler();
  private rate = 0; private offset = NaN;
  private stepRe = 1; private stepIm = 0; private phRe = 1; private phIm = 0; private phN = 0;
  private dec = 1; private decN = 0; private accRe = 0; private accIm = 0;
  private bufRe = new Float32Array(0); private bufIm = new Float32Array(0);
  private readonly yRe = new Float32Array(RING); private readonly yIm = new Float32Array(RING);
  private abs = 0;
  // acquisition
  private state: RxState = 'search';
  private lastAcqAt = 0; private cpLock = 0;
  private cfo = 0; private nextStart = 0; private rot = 0;
  private timingAt = 0; private timingMiss = 0;
  // symbols
  private readonly symRe = new Float32Array(SYMS * NSC); private readonly symIm = new Float32Array(SYMS * NSC);
  private symN = 0;
  private readonly symStart = new Float64Array(SYMS);
  private readonly refBits = new Uint8Array(SYMS * NREF); private readonly maj = new Uint8Array(SYMS);
  private readonly fre = new Float32Array(NFFT); private readonly fim = new Float32Array(NFFT);
  private readonly winPh: Float32Array;
  // block sync
  private blockPhase = -1; private blockMiss = 0; private blocks = 0; private blocksBad = 0;
  private lastBc = -1; private lastPsmi = -1;
  private frameStart = -1; private frameBc = -1;
  private readonly blockWords = new Uint8Array(16 * 32 * NREF);
  private readonly rsidVotes = new Int16Array(NREF * 3);
  // pm column map
  private readonly colSc: Int16Array; private readonly colIq: Uint8Array;

  constructor() {
    const { sc, iq } = pmColumns(); this.colSc = sc; this.colIq = iq;
    this.winPh = new Float32Array(2 * NSC);
    for (let k = -546; k <= 546; k++) { const a = -2 * Math.PI * k * WIN_OFF / NFFT; this.winPh[2 * (k + 546)] = Math.cos(a); this.winPh[2 * (k + 546) + 1] = Math.sin(a); }
  }

  /** The carrier error is given as on the air (the receiver works on the inverted spectrum). */
  get status(): RxStatus { return { state: this.state, cfoHz: -this.cfo, cpLock: this.cpLock, blocks: this.blocks, blocksBad: this.blocksBad, psmi: this.lastPsmi, bc: this.lastBc }; }

  reset(): void {
    this.abs = 0; this.state = 'search'; this.lastAcqAt = 0; this.cpLock = 0; this.cfo = 0; this.symN = 0;
    this.blockPhase = -1; this.blockMiss = 0; this.frameStart = -1; this.frameBc = -1; this.lastBc = -1; this.lastPsmi = -1;
    this.blocks = 0; this.blocksBad = 0; this.rsidVotes.fill(0); this.decN = 0; this.accRe = this.accIm = 0;
    this.phRe = 1; this.phIm = 0;
  }

  /** Signed int8 IQ at `rate`; the station sits `offsetHz` from the span center. */
  push(iq: Int8Array, n: number, rate: number, offsetHz: number): void {
    if (rate !== this.rate) {
      this.rate = rate; this.dec = rate > 3_300_000 ? Math.max(1, Math.round(rate / 2_000_000)) : 1;
      this.rs.configure(rate / this.dec); this.reset();
    }
    if (offsetHz !== this.offset) { this.offset = offsetHz; const w = -2 * Math.PI * offsetHz / rate; this.stepRe = Math.cos(w); this.stepIm = Math.sin(w); }
    if (this.bufRe.length < n) { this.bufRe = new Float32Array(n); this.bufIm = new Float32Array(n); }
    const br = this.bufRe, bi = this.bufIm, d = this.dec;
    let m = 0;
    for (let k = 0; k < n; k++) {
      const a = iq[2 * k] / 128, b = iq[2 * k + 1] / 128;
      const xr = a * this.phRe - b * this.phIm, xi = a * this.phIm + b * this.phRe;
      const nr = this.phRe * this.stepRe - this.phIm * this.stepIm; this.phIm = this.phRe * this.stepIm + this.phIm * this.stepRe; this.phRe = nr;
      if (++this.phN >= 4096) { this.phN = 0; const g = 1 / Math.hypot(this.phRe, this.phIm); this.phRe *= g; this.phIm *= g; }
      if (d === 1) { br[m] = xr; bi[m] = -xi; m++; }
      else { this.accRe += xr; this.accIm += xi; if (++this.decN >= d) { br[m] = this.accRe / d; bi[m] = -this.accIm / d; m++; this.accRe = this.accIm = 0; this.decN = 0; } }
    }
    const yr = this.yRe, yi = this.yIm;
    this.rs.push(br, bi, m, (r, i) => { const p = this.abs & RMASK; yr[p] = r; yi[p] = i; this.abs++; });
    this.advance();
  }

  /** Complex samples already at FS (test hook and the replay path). */
  pushFs(re: Float32Array, im: Float32Array): void {
    for (let k = 0; k < re.length; k++) { const p = this.abs & RMASK; this.yRe[p] = re[k]; this.yIm[p] = im[k]; this.abs++; }
    this.advance();
  }

  private advance(): void {
    if (this.state === 'search') {
      if (this.abs >= ACQ_N + NSYM && this.abs - this.lastAcqAt >= 2 * ACQ_N) { this.lastAcqAt = this.abs; this.acquire(); }
      if (this.state === 'search') return;
    }
    // OFDM found but no block sync within three seconds: start over
    if (this.state === 'ofdm' && this.symN > 3 * FS / NSYM) { this.state = 'search'; return; }
    while (this.abs >= Math.round(this.nextStart) + WIN_OFF + NFFT + 8) {
      if (this.abs - this.nextStart > RING - 4 * NSYM) { this.state = 'search'; return; }
      this.symbol();
      if ((this.state as RxState) === 'search') return;
    }
    if (this.abs - this.timingAt > 3 * FS) { this.timingAt = this.abs; this.retime(); }
  }

  /** The cyclic-extension correlation of the last ACQ_N samples, sidebands only, folded by absolute symbol phase. */
  private cpFold(): { d0: number; c: number; lock: number; foff: number } {
    const re = new Float32Array(ACQ_N), im = new Float32Array(ACQ_N), base = this.abs - ACQ_N;
    for (let k = 0; k < ACQ_N; k++) { const p = (base + k) & RMASK; re[k] = this.yRe[p]; im[k] = this.yIm[p]; }
    fft(re, im);
    const binHz = FS / ACQ_N;
    for (let k = 0; k < ACQ_N; k++) {
      const f = Math.abs((k < ACQ_N / 2 ? k : k - ACQ_N) * binHz);
      if (f < 125_000 || f > 202_000) { re[k] = 0; im[k] = 0; }
    }
    for (let k = 0; k < ACQ_N; k++) im[k] = -im[k];
    fft(re, im);
    for (let k = 0; k < ACQ_N; k++) { re[k] /= ACQ_N; im[k] = -im[k] / ACQ_N; }
    const fr = new Float64Array(NSYM), fi = new Float64Array(NSYM);
    let sr = 0, si = 0;
    const lim = ACQ_N - NFFT;
    for (let n = 0; n < lim; n++) {
      const pr = re[n] * re[n + NFFT] + im[n] * im[n + NFFT], pi = im[n] * re[n + NFFT] - re[n] * im[n + NFFT];
      sr += pr; si += pi;
      if (n >= NCP) { const o = n - NCP, qr = re[o] * re[o + NFFT] + im[o] * im[o + NFFT], qi = im[o] * re[o + NFFT] - re[o] * im[o + NFFT]; sr -= qr; si -= qi; }
      if (n >= NCP - 1) { const d = (base + n - NCP + 1) % NSYM; fr[d] += sr; fi[d] += si; }
    }
    let best = 0, d0 = 0, sum = 0;
    for (let d = 0; d < NSYM; d++) { const v = Math.hypot(fr[d], fi[d]); sum += v; if (v > best) { best = v; d0 = d; } }
    const foff = -Math.atan2(fi[d0], fr[d0]) * FS / (2 * Math.PI * NFFT);
    return { d0, c: best, lock: sum > 0 ? best / (sum / NSYM) : 0, foff };
  }

  private acquire(): void {
    const r = this.cpFold();
    this.cpLock = r.lock;
    if (r.lock < 4.5) { this.state = 'search'; return; }
    this.cfo = r.foff;
    // integer offset: the DBPSK reference subcarriers keep cos(2 dphi) near 1, QPSK data averages near 0
    const base = this.abs - ACQ_N;
    let first = base + ((r.d0 - (base % NSYM)) + NSYM) % NSYM;
    const nsym = Math.floor((this.abs - first - NSYM) / NSYM);
    const scRe = new Float64Array(NFFT), scIm = new Float64Array(NFFT);
    let pr: Float32Array | null = null, pi: Float32Array | null = null;
    for (let s = 0; s < nsym; s++) {
      const st = first + s * NSYM + WIN_OFF;
      for (let m = 0; m < NFFT; m++) {
        const p = (st + m) & RMASK, a = -2 * Math.PI * this.cfo * (st + m) / FS, c = Math.cos(a), sn = Math.sin(a);
        this.fre[m] = this.yRe[p] * c - this.yIm[p] * sn; this.fim[m] = this.yRe[p] * sn + this.yIm[p] * c;
      }
      fft(this.fre, this.fim);
      if (pr && pi) for (let b = 0; b < NFFT; b++) {
        const dr = this.fre[b] * pr[b] + this.fim[b] * pi[b], di = this.fim[b] * pr[b] - this.fre[b] * pi[b];
        const m2 = dr * dr + di * di; if (m2 > 0) { scRe[b] += (dr * dr - di * di) / m2; scIm[b] += 2 * dr * di / m2; }
      }
      pr = Float32Array.from(this.fre); pi = Float32Array.from(this.fim);
    }
    // a carrier s whole bins off turns by 2 pi s NSYM / NFFT from one symbol to the next: undo that per candidate
    let bestS = 0, bestV = -Infinity;
    for (let s = -40; s <= 40; s++) {
      let vr = 0, vi = 0; for (const sc of REF_SC) { const b = (sc + s + 2 * NFFT) % NFFT; vr += scRe[b]; vi += scIm[b]; }
      const a = -4 * Math.PI * s * NSYM / NFFT, v = vr * Math.cos(a) - vi * Math.sin(a);
      if (v > bestV) { bestV = v; bestS = s; }
    }
    this.cfo += bestS * DF;
    {
      this.state = 'ofdm';
      // start on the first whole symbol of the acquisition window, so sync can be found from data already here
      this.nextStart = first; this.rot = 0; this.symN = 0; this.blockPhase = -1; this.frameStart = -1;
      this.timingAt = this.abs;
    }
  }

  /** Every few seconds: compare the tracked symbol timing with the cyclic extension and pull it back on. */
  private retime(): void {
    if (this.abs < ACQ_N) return;
    const r = this.cpFold();
    this.cpLock = r.lock;
    if (r.lock < 4.5) { if (++this.timingMiss >= 3) { this.state = 'search'; this.timingMiss = 0; } return; }
    const cur = ((Math.round(this.nextStart) % NSYM) + NSYM) % NSYM;
    let delta = r.d0 - cur; if (delta > NSYM / 2) delta -= NSYM; if (delta < -NSYM / 2) delta += NSYM;
    if (Math.abs(delta) <= 60) { this.timingMiss = 0; if (Math.abs(delta) >= 2) this.nextStart += delta; }
    else if (++this.timingMiss >= 3) { this.state = 'search'; this.timingMiss = 0; }
  }

  private symbol(): void {
    const S = Math.round(this.nextStart), st = S + WIN_OFF, cfo = this.cfo;
    const w = -2 * Math.PI * cfo / FS;
    let ph = this.rot + w * WIN_OFF;
    let cr = Math.cos(ph), ci = Math.sin(ph);
    const sr = Math.cos(w), si = Math.sin(w);
    for (let m = 0; m < NFFT; m++) {
      const p = (st + m) & RMASK, xr = this.yRe[p], xi = this.yIm[p];
      this.fre[m] = xr * cr - xi * ci; this.fim[m] = xr * ci + xi * cr;
      const nr = cr * sr - ci * si; ci = cr * si + ci * sr; cr = nr;
    }
    fft(this.fre, this.fim);
    const slot = this.symN % SYMS, off = slot * NSC;
    for (let k = -546; k <= 546; k++) {
      const b = (k + NFFT) % NFFT, i = k + 546, c = this.winPh[2 * i], s = this.winPh[2 * i + 1];
      this.symRe[off + i] = this.fre[b] * c - this.fim[b] * s; this.symIm[off + i] = this.fre[b] * s + this.fim[b] * c;
    }
    this.symStart[slot] = S;
    // reference bits, differential against the previous symbol, plus the residual carrier offset they show
    if (this.symN > 0) {
      const prev = ((this.symN - 1) % SYMS) * NSC;
      let n = 0, qr = 0, qi = 0;
      for (let j = 0; j < NREF; j++) {
        const i = REF_SC[j] + 546, ar = this.symRe[off + i], ai = this.symIm[off + i], br = this.symRe[prev + i], bi = this.symIm[prev + i];
        const dr = ar * br + ai * bi, di = ai * br - ar * bi;
        const bit = dr < 0 ? 1 : 0; this.refBits[slot * NREF + j] = bit; n += bit;
        const m = Math.hypot(dr, di) || 1; qr += (dr * dr - di * di) / m; qi += 2 * dr * di / m;
      }
      this.maj[slot] = n * 2 > NREF ? 1 : 0;
      const dphi = Math.atan2(qi, qr) / 2;
      this.cfo += 0.02 * dphi / (2 * Math.PI * NSYM / FS);
    }
    this.rot += w * NSYM; this.rot %= 2 * Math.PI;
    this.nextStart += NSYM;
    this.symN++;
    this.blockSync();
  }

  private blockSync(): void {
    const n = this.symN;
    if (this.blockPhase < 0) {
      if (n < 97 || n % 32 !== 0) return;
      let bestP = -1, bestV = -1;
      const from = n - Math.min(n - 1, 4 * 32);
      for (let p = 0; p < 32; p++) {
        let v = 0, cnt = 0;
        for (let st = from + ((p - from) % 32 + 32) % 32; st + 32 <= n; st += 32) {
          cnt++;
          for (const [b, val] of SYNC_BITS) if (this.maj[(st + 31 - b) % SYMS] === val) v++;
        }
        if (cnt && v / cnt > bestV) { bestV = v / cnt; bestP = p; }
      }
      if (bestV >= SYNC_BITS.length - 1) { this.blockPhase = bestP; this.state = 'sync'; this.blockMiss = 0; this.frameStart = -1; }
      return;
    }
    if ((n - this.blockPhase) % 32 !== 0) return;
    const st = n - 32;
    if (st < 1) return;
    // decode the block's system control word on every reference subcarrier
    const words: ScWord[] = [];
    const good: number[] = [];
    const bits = new Uint8Array(32);
    for (let j = 0; j < NREF; j++) {
      for (let r = 0; r < 32; r++) bits[r] = this.refBits[((st + r) % SYMS) * NREF + j];
      const w = decodeScWord(bits); words.push(w);
      if (w.syncOk && w.p0 && w.p1) good.push(j);
    }
    this.blocks++;
    if (!good.length) {
      this.blocksBad++;
      if (++this.blockMiss >= 3) { this.blockPhase = -1; this.state = 'ofdm'; this.frameStart = -1; }
      return;
    }
    this.blockMiss = 0;
    const vote = (f: (w: ScWord) => number) => { const c = new Map<number, number>(); for (const j of good) { const v = f(words[j]); c.set(v, (c.get(v) ?? 0) + 1); } let b = 0, bn = -1; for (const [v, k] of c) if (k > bn) { bn = k; b = v; } return b; };
    const bc = vote(w => w.bc), psmi = vote(w => w.psmi);
    this.lastBc = bc; this.lastPsmi = psmi;
    if (this.state === 'sync' || this.state === 'frames') this.state = this.frameStart >= 0 || this.state === 'frames' ? 'frames' : 'sync';
    // the clean word per subcarrier: the majority, with each subcarrier's own identification bits
    const cons = new Uint8Array(32);
    for (let r = 0; r < 32; r++) { let c = 0; for (const j of good) c += this.refBits[((st + r) % SYMS) * NREF + j]; cons[r] = c * 2 > good.length ? 1 : 0; }
    cons[0] = 0;
    const slotWords = bc * 32 * NREF;
    for (let j = 0; j < NREF; j++) {
      const own = words[j].syncOk && words[j].p0 && words[j].p1 && words[j].p2;
      if (own) {
        for (const [k, b] of [[0, 21], [1, 20], [2, 18]] as const) this.rsidVotes[j * 3 + k] += this.refBits[((st + 31 - b) % SYMS) * NREF + j] ? 1 : -1;
      }
      for (let r = 0; r < 32; r++) {
        let v = own ? this.refBits[((st + r) % SYMS) * NREF + j] : cons[r];
        if (!own) { const bit = 31 - r, k = bit === 21 ? 0 : bit === 20 ? 1 : bit === 18 ? 2 : -1; if (k >= 0 && this.rsidVotes[j * 3 + k] !== 0) v = this.rsidVotes[j * 3 + k] > 0 ? 1 : 0; }
        this.blockWords[slotWords + r * NREF + j] = r === 0 ? 0 : v;
      }
    }
    // frame tracking: BC 0 opens a frame, 1..15 must follow in order
    if (bc === 0) { this.frameStart = st; this.frameBc = 0; this.state = 'frames'; }
    else if (this.frameStart >= 0) {
      if (bc !== this.frameBc + 1) { this.frameStart = -1; return; }
      this.frameBc = bc;
      if (bc === 15) { const fs = this.frameStart; this.frameStart = -1; this.emitFrame(fs); }
    }
  }

  /** Channel estimate from the pilots, then the PM matrix of soft values. */
  private emitFrame(fs: number): void {
    if (this.symN - fs > SYMS) return;
    // pilots: Href[sym][j] = X / R, R from the differentially encoded block word
    const H = new Float32Array(PM_ROWS * NREF * 2);
    for (let blk = 0; blk < 16; blk++) for (let j = 0; j < NREF; j++) {
      let R = 0;
      for (let r = 0; r < 32; r++) {
        R ^= this.blockWords[blk * 32 * NREF + r * NREF + j];
        const n = blk * 32 + r, off = ((fs + n) % SYMS) * NSC + REF_SC[j] + 546;
        const s = R ? 1 : -1;                               // R = 1 -> +1+j, 0 -> -1-j; X / (s(1+j)) = X (1-j) s / 2
        const xr = this.symRe[off], xi = this.symIm[off];
        H[(n * NREF + j) * 2] = s * (xr + xi) / 2; H[(n * NREF + j) * 2 + 1] = s * (xi - xr) / 2;
      }
    }
    // smooth over five symbols
    const Hs = new Float32Array(H.length);
    for (let n = 0; n < PM_ROWS; n++) for (let j = 0; j < NREF; j++) {
      let r = 0, i = 0, c = 0;
      for (let d = -2; d <= 2; d++) { const m = n + d; if (m < 0 || m >= PM_ROWS) continue; r += H[(m * NREF + j) * 2]; i += H[(m * NREF + j) * 2 + 1]; c++; }
      Hs[(n * NREF + j) * 2] = r / c; Hs[(n * NREF + j) * 2 + 1] = i / c;
    }
    // interpolate magnitude and unwrapped phase across each sideband, then soft bits
    const pm = new Float32Array(PM_ROWS * PM_COLS);
    const hr = new Float32Array(NSC), hi = new Float32Array(NSC);
    const mag = new Float64Array(NREF), ph = new Float64Array(NREF);
    let eLo = 0, vLo = 0, nLo = 0, eHi = 0, vHi = 0, nHi = 0;
    for (let n = 0; n < PM_ROWS; n++) {
      for (let j = 0; j < NREF; j++) { const r = Hs[(n * NREF + j) * 2], i = Hs[(n * NREF + j) * 2 + 1]; mag[j] = Math.hypot(r, i); ph[j] = Math.atan2(i, r); }
      for (const [a, b] of [[0, 11], [11, 22]]) {
        for (let j = a + 1; j < b; j++) { let d = ph[j] - ph[j - 1]; while (d > Math.PI) { ph[j] -= 2 * Math.PI; d -= 2 * Math.PI; } while (d < -Math.PI) { ph[j] += 2 * Math.PI; d += 2 * Math.PI; } }
        for (let j = a; j < b - 1; j++) {
          const k0 = REF_SC[j], k1 = REF_SC[j + 1];
          for (let k = k0; k <= k1; k++) {
            const t = (k - k0) / (k1 - k0), m = mag[j] + t * (mag[j + 1] - mag[j]), p = ph[j] + t * (ph[j + 1] - ph[j]);
            hr[k + 546] = m * Math.cos(p); hi[k + 546] = m * Math.sin(p);
          }
        }
      }
      const off = ((fs + n) % SYMS) * NSC;
      for (let c = 0; c < PM_COLS; c++) {
        const k = this.colSc[c] + 546, xr = this.symRe[off + k], xi = this.symIm[off + k], a = hr[k], b = hi[k];
        const zr = xr * a + xi * b, zi = xi * a - xr * b;           // X conj(H)
        const v = this.colIq[c] ? zi : zr;
        pm[n * PM_COLS + c] = v;
        const h2 = a * a + b * b; if (h2 <= 0) continue;
        const e = Math.abs(v) / h2;                                    // equalized amplitude on this rail
        if (k < 546) { eLo += e; vLo += e * e; nLo++; } else { eHi += e; vHi += e * e; nHi++; }
      }
    }
    const snr = (s: number, s2: number, n: number) => { if (!n) return -99; const m = s / n, v = s2 / n - m * m; return 10 * Math.log10(m * m / Math.max(v, 1e-9)); };
    this.onFrame({ pm, psmi: this.lastPsmi, snrLoDb: snr(eLo, vLo, nLo), snrHiDb: snr(eHi, vHi, nHi), startSample: this.symStart[fs % SYMS] });
  }
}
