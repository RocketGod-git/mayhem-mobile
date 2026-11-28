/**
 * Frequency correction: measuring a radio's crystal error from a steady carrier whose frequency is known. No DOM.
 * The span is tuned below the carrier (so the radio's own center spike stays out of the way), the carrier is mixed
 * to zero, narrowed, and read off a long FFT to a few hertz.
 */
import { fft } from '../fft.js';

/** The correction a radio can take, in parts per million. */
export const PPM_MAX = 200;
export const clampPpm = (v: number): number => Math.max(-PPM_MAX, Math.min(PPM_MAX, Math.round(v)));

/** Where to put the span for a measurement at this rate: the carrier sits `offset` Hz above center, searched `half` either side. */
export function measurePlan(rate: number): { offset: number; half: number } {
  return { offset: Math.min(300_000, Math.round(rate * 0.25)), half: Math.min(100_000, Math.round(rate * 0.2)) };
}

/**
 * The correction after a measurement: [old] plus the error seen. A crystal running fast tunes high, so the carrier shows
 * below where it should ([heardOffset] under [offset]) and the correction goes up.
 */
export function ppmAfter(old: number, centerHz: number, offset: number, heardOffset: number): number {
  return old + ((offset - heardOffset) / centerHz) * 1e6;
}

const N = 65_536;
/** The strongest carrier [offset] Hz from the span center, within [half] Hz, from [seconds] of samples. */
export class CarrierMeter {
  private readonly dec: number; private readonly outRate: number;
  private readonly re = new Float32Array(N); private readonly im = new Float32Array(N);
  private readonly acc = new Float64Array(N); private readonly win = new Float32Array(N);
  private frames = 0; private fill = 0; private skip: number; private left: number;
  private pr = 1; private pi = 0; private readonly sr: number; private readonly si: number;
  private ai = 0; private aq = 0; private an = 0; private di = 0; private dq = 0;
  constructor(rate: number, private readonly offset: number, private readonly half: number, seconds: number, settleS = 0.35) {
    this.dec = Math.max(1, Math.floor(rate / (half * 2.5)));
    this.outRate = rate / this.dec;
    this.skip = Math.round(settleS * rate);
    this.left = Math.round(seconds * rate);
    const w = (-2 * Math.PI * offset) / rate;
    this.sr = Math.cos(w); this.si = Math.sin(w);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  }
  /** Interleaved 8-bit IQ; true once enough has been heard. */
  push(iq: Int8Array): boolean {
    let i = 0;
    const n = iq.length >> 1;
    if (this.skip > 0) { const s = Math.min(this.skip, n); this.skip -= s; i = s; }
    for (; i < n && this.left > 0; i++, this.left--) {
      // the radio's DC spike out first: shifted and narrowed, it would fold back into the search
      this.di += 1e-4 * (iq[2 * i] - this.di); this.dq += 1e-4 * (iq[2 * i + 1] - this.dq);
      const x = iq[2 * i] - this.di, y = iq[2 * i + 1] - this.dq;
      // mix the carrier to zero with a rotating phasor
      this.ai += x * this.pr - y * this.pi; this.aq += x * this.pi + y * this.pr;
      const r = this.pr * this.sr - this.pi * this.si; this.pi = this.pr * this.si + this.pi * this.sr; this.pr = r;
      if (++this.an < this.dec) continue;
      const k = 1 / Math.hypot(this.pr, this.pi); this.pr *= k; this.pi *= k;
      this.re[this.fill] = this.ai / this.dec; this.im[this.fill] = this.aq / this.dec; this.ai = this.aq = 0; this.an = 0;
      if (++this.fill === N) this.frame();
    }
    return this.left <= 0;
  }
  private frame(): void {
    for (let i = 0; i < N; i++) { this.re[i] *= this.win[i]; this.im[i] *= this.win[i]; }
    fft(this.re, this.im);
    for (let i = 0; i < N; i++) this.acc[i] += this.re[i] * this.re[i] + this.im[i] * this.im[i];
    this.frames++; this.fill = 0;
  }
  /** The carrier's offset from the span center and how far it stands over the floor, or null with too little heard. */
  result(): { offsetHz: number; snrDb: number } | null {
    if (!this.frames) return null;
    const binHz = this.outRate / N, span = Math.min(N / 2 - 2, Math.floor(this.half / binHz));
    const at = (k: number) => this.acc[(k + N) % N];
    let best = 0;
    for (let k = -span; k <= span; k++) if (at(k) > at(best)) best = k;
    const db = (k: number) => 10 * Math.log10(at(k) + 1e-12);
    const a = db(best - 1), b = db(best), c = db(best + 1), den = a - 2 * b + c;
    const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    const floor: number[] = [];
    for (let k = -span; k <= span; k += 7) floor.push(db(k));
    floor.sort((x, y) => x - y);
    return { offsetHz: this.offset + (best + frac) * binHz, snrDb: b - floor[floor.length >> 1] };
  }
}
