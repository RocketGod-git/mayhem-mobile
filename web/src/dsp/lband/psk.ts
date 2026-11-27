/**
 * A BPSK receiver for a continuous L-band carrier (the Inmarsat-C NCS TDM at 1200 symbols a second, the Aero
 * P-channel at 600 or 1200). The channel comes down to about 80 kHz, wide enough for a HackRF's frequency error at
 * 1.5 GHz; the carrier is found from the line the squared signal puts at twice its frequency; then a low-pass near
 * the symbol rate, a Costas loop and a Gardner symbol clock give one soft value a symbol (about ±1).
 *
 * Twins: core/sat/LbandPsk.kt and core/sat/LbandPsk.swift.
 */
import { ChannelDecimator, ComplexFirDecimator, lowpassTaps } from '../ham/filters.js';
import { fft } from '../../fft.js';

const ACQ_N = 16384, ACQ_BLOCKS = 4;

export class PskReceiver {
  /** The carrier found, Hz from the channel's nominal frequency (NaN before one is found). */
  carrierHz = NaN;
  /** 0 (noise) to 1 (clean BPSK), from how much of each symbol lies on the real axis. */
  lock = 0;
  /** The carrier's line over the squared signal's mean, dB. */
  lineDb = 0;
  symbols = 0;
  private key = '';
  private cr = 1; private ci = 0; private dr = 1; private di = 0;
  private chan: ChannelDecimator | null = null;
  private fs1 = 0; private fs2 = 0; private sps = 0;
  private narrow: ComplexFirDecimator | null = null;
  private mixed = new Float32Array(0); private flt = new Float32Array(0);
  private acqRe = new Float32Array(ACQ_N); private acqIm = new Float32Array(ACQ_N); private acqPow = new Float32Array(ACQ_N);
  private acqN = 0; private acqBlocks = 0; private acqWait = 0;
  // the coarse carrier mixer at fs1
  private wr = 1; private wi = 0; private wdr = 1; private wdi = 0;
  // Costas and Gardner at fs2
  private th = 0; private om = 0;
  private ring = new Float32Array(64); private k = 0; private t = 0;
  private pr = 0; private pi = 0; private amp = 1;

  constructor(readonly symbolRate: number, private readonly onSymbol: (soft: number) => void) {}

  reset(): void { this.key = ''; this.carrierHz = NaN; this.lock = 0; this.symbols = 0; }

  /** Signed int8 I,Q at `rate`; the channel sits `offsetHz` from the radio's center. */
  onIq(iq: Int8Array, rate: number, offsetHz: number): void {
    const key = `${rate}|${offsetHz}`;
    if (key !== this.key) this.setup(key, rate, offsetHz);
    const n = iq.length >> 1;
    if (this.mixed.length < 2 * n) this.mixed = new Float32Array(2 * n);
    let r = this.cr, s = this.ci;
    const m = this.mixed, dr = this.dr, di = this.di;
    for (let i = 0; i < n; i++) {
      const xi = iq[2 * i], xq = iq[2 * i + 1];
      m[2 * i] = xi * r - xq * s; m[2 * i + 1] = xi * s + xq * r;
      const t = r * dr - s * di; s = r * di + s * dr; r = t;
      if ((i & 1023) === 0) { const g = 1 / Math.sqrt(r * r + s * s); r *= g; s *= g; }
    }
    this.cr = r; this.ci = s;
    const o = this.chan!.process(m, n);
    this.wide(o.out, o.n);
  }

  /** Complex samples already at some rate near 80 kHz (tests, tools). */
  onBaseband(z: Float32Array, n: number, fs: number): void {
    const key = `bb|${fs}`;
    if (key !== this.key) this.setup(key, fs, 0, true);
    this.wide(z, n);
  }

  private setup(key: string, rate: number, offsetHz: number, baseband = false): void {
    this.key = key;
    const w = -2 * Math.PI * offsetHz / rate; this.dr = Math.cos(w); this.di = Math.sin(w); this.cr = 1; this.ci = 0;
    this.chan = baseband ? null : new ChannelDecimator(Math.max(1, Math.floor(rate / 80_000)));
    this.fs1 = baseband ? rate : rate / this.chan!.total;
    const d2 = Math.max(1, Math.floor(this.fs1 / (8 * this.symbolRate)));
    this.fs2 = this.fs1 / d2; this.sps = this.fs2 / this.symbolRate;
    this.narrow = new ComplexFirDecimator(lowpassTaps(0.75 * this.symbolRate / this.fs1, (Math.round(4 * this.fs1 / this.symbolRate) | 1)), d2);
    this.acqN = 0; this.acqBlocks = 0; this.acqPow.fill(0); this.acqWait = 0;
    this.carrierHz = NaN; this.lock = 0;
    this.setCarrier(0);
  }

  private setCarrier(hz: number): void {
    const w = -2 * Math.PI * hz / this.fs1; this.wdr = Math.cos(w); this.wdi = Math.sin(w);
    this.th = 0; this.om = 0; this.amp = 1;
  }

  private wide(z: Float32Array, n: number): void {
    // the carrier search: while there is none, and again every 10 s while the loop is not locked
    for (let i = 0; i < n; i++) {
      if (this.acqWait > 0) { this.acqWait--; continue; }
      const a = z[2 * i], b = z[2 * i + 1];
      this.acqRe[this.acqN] = a * a - b * b; this.acqIm[this.acqN] = 2 * a * b;
      if (++this.acqN === ACQ_N) { this.acqN = 0; this.acquireBlock(); }
    }
    if (this.flt.length < 2 * n) this.flt = new Float32Array(2 * n);
    // the coarse mixer, in place into flt
    let r = this.wr, s = this.wi;
    const f = this.flt, dr = this.wdr, di = this.wdi;
    for (let i = 0; i < n; i++) {
      const x = z[2 * i], y = z[2 * i + 1];
      f[2 * i] = x * r - y * s; f[2 * i + 1] = x * s + y * r;
      const t = r * dr - s * di; s = r * di + s * dr; r = t;
      if ((i & 1023) === 0) { const g = 1 / Math.sqrt(r * r + s * s); r *= g; s *= g; }
    }
    this.wr = r; this.wi = s;
    const c = this.narrow!.process(f, n, f);
    for (let i = 0; i < c; i++) this.sample(f[2 * i], f[2 * i + 1]);
  }

  private acquireBlock(): void {
    const re = this.acqRe, im = this.acqIm, p = this.acqPow;
    fft(re, im);
    for (let k = 0; k < ACQ_N; k++) p[k] += re[k] * re[k] + im[k] * im[k];
    if (++this.acqBlocks < ACQ_BLOCKS) return;
    // the line at twice the carrier, within ±0.45 of the wide rate (the carrier within ±0.225)
    let best = 0, bv = -1, sum = 0;
    const lim = Math.floor(0.45 * ACQ_N);
    for (let k = 0; k < ACQ_N; k++) {
      sum += p[k];
      const kk = k < ACQ_N / 2 ? k : k - ACQ_N;
      if (Math.abs(kk) > lim) continue;
      // the three bins about it, so a line between two bins still wins
      const v = p[k] + 0.5 * (p[(k + 1) % ACQ_N] + p[(k + ACQ_N - 1) % ACQ_N]);
      if (v > bv) { bv = v; best = k; }
    }
    const mean = sum / ACQ_N;
    this.lineDb = 10 * Math.log10(p[best] / (mean + 1e-30) + 1e-30);
    // the peak's fractional bin from its neighbors
    const a = p[(best + ACQ_N - 1) % ACQ_N], b = p[best], c = p[(best + 1) % ACQ_N];
    const den = a - 2 * b + c, frac = den !== 0 ? 0.5 * (a - c) / den : 0;
    const kk = (best < ACQ_N / 2 ? best : best - ACQ_N) + Math.max(-0.5, Math.min(0.5, frac));
    const hz = kk * this.fs1 / ACQ_N / 2;
    p.fill(0); this.acqBlocks = 0;
    if (this.lineDb > 12) {
      const moved = !(Math.abs(hz - this.carrierHz) < 3 * this.fs1 / ACQ_N);
      if (moved) { this.carrierHz = hz; this.setCarrier(hz); }
      this.acqWait = Math.round(10 * this.fs1);
    }
  }

  private sample(x: number, y: number): void {
    // Costas rotation, then into the ring for the interpolator
    const c = Math.cos(this.th), s = Math.sin(this.th);
    const zr = x * c + y * s, zi = y * c - x * s;
    this.th += this.om;
    if (this.th > Math.PI) this.th -= 2 * Math.PI; else if (this.th < -Math.PI) this.th += 2 * Math.PI;
    const ring = this.ring, k = this.k;
    ring[2 * (k & 31)] = zr; ring[2 * (k & 31) + 1] = zi;
    this.k = k + 1;
    const sps = this.sps;
    while (this.k - 1 >= Math.floor(this.t) + 1) {
      if (this.k - this.t > 24) { this.t = this.k - 2; continue; }
      const [yr, yi] = this.at(this.t), [mr, mi] = this.at(this.t - sps / 2);
      // Gardner: the midpoint between two symbols of opposite sign sits on zero when the clock is right
      const amp2 = this.amp * this.amp;
      const et = ((this.pr - yr) * mr + (this.pi - yi) * mi) / (amp2 + 1e-12);
      this.t += sps + Math.max(-1, Math.min(1, 0.05 * sps * et));
      this.pr = yr; this.pi = yi;
      // Costas, decision directed for BPSK
      const mag = Math.sqrt(yr * yr + yi * yi);
      this.amp += (mag - this.amp) * 0.01;
      const ec = Math.max(-1, Math.min(1, (yr >= 0 ? yi : -yi) / (this.amp + 1e-12)));
      this.th += 0.06 * ec; this.om += 0.0015 * ec / sps;
      const q = mag > 0 ? (yr * yr - yi * yi) / (mag * mag) : 0;
      this.lock += (q - this.lock) * 0.005;
      this.symbols++;
      this.onSymbol(yr / (this.amp + 1e-12));
    }
  }

  /** Linear interpolation in the ring at absolute sample position t. */
  private at(t: number): [number, number] {
    const i = Math.floor(t), f = t - i, a = 2 * (i & 31), b = 2 * ((i + 1) & 31), r = this.ring;
    return [r[a] * (1 - f) + r[b] * f, r[a + 1] * (1 - f) + r[b + 1] * f];
  }
}
