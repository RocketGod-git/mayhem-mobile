/**
 * Spectrum: the FFT engine. Signed-int8 IQ in, one power spectrum per N samples out, each bin in dBFS (0 dBFS is a
 * full-scale complex tone, whichever window is used), fftshifted so index 0 is the lowest frequency.
 *
 * Every frame goes through the video filter (VBW). Between two reads of `take()` the engine also keeps each bin's
 * highest and lowest frame, so a max hold or min hold drawn at the display's frame rate still catches a burst that
 * came and went between two drawn frames.
 */
import { fft } from '../../fft.js';
import { VideoFilter, videoAlpha, windowGains, windowOf, type WindowKind } from './rbw.js';

/** Samples per second the engine will transform at most; above it, whole frames are skipped (the RBW is unchanged). */
export const FFT_BUDGET = 6_000_000;
const LN10_10 = 10 / Math.LN10;

/** Linear power to dB, floored well under anything an 8-bit radio can show. */
export const toDb = (p: number) => LN10_10 * Math.log(p + 1e-20);

/**
 * Lay the bins `c - half .. c + half` (the DC spike's spread) on a straight line between their outer neighbors.
 * A HackRF's or an RTL-SDR's DC offset is a pure tone at 0 Hz: it is the radio, not the signal.
 */
export function patchDc(p: Float32Array, c: number, half: number): void {
  const a = c - half - 1, b = c + half + 1;
  if (a < 0 || b >= p.length) return;
  for (let i = a + 1; i < b; i++) p[i] = p[a] + (p[b] - p[a]) * (i - a) / (b - a);
}

/** How many bins either side of DC a window's DC spike covers. */
export const dcHalfWidth = (kind: WindowKind) => (kind === 'HANN' ? 2 : 4);

export class FftEngine {
  readonly w: Float32Array;
  /** 1 / (128 · Σw)²: |X|² times this is the power in dBFS. */
  private readonly norm: number;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly bufI: Float32Array;
  private readonly bufQ: Float32Array;
  private fill = 0;
  private skipLeft = 0;
  private readonly power: Float32Array;
  readonly video: VideoFilter;
  readonly max: Float32Array;
  readonly min: Float32Array;
  /** The video-filtered frames since the last take, summed in linear power: the screen's frame is their mean. */
  private readonly sum: Float32Array;
  /** Frames folded in since the last take(). */
  framesSince = 0;
  /** Frames transformed since the engine was made. */
  frames = 0;
  /** Frames skipped between two transformed ones, to stay within FFT_BUDGET. */
  readonly skip: number;
  readonly enbw: number;

  constructor(readonly n: number, readonly kind: WindowKind, readonly rate: number, public vbwHz: number, public dcPatch: boolean) {
    this.w = windowOf(kind, n);
    const g = windowGains(this.w);
    this.enbw = g.enbw;
    this.norm = 1 / ((128 * g.sum) ** 2);
    this.re = new Float32Array(n); this.im = new Float32Array(n);
    this.bufI = new Float32Array(n); this.bufQ = new Float32Array(n);
    this.power = new Float32Array(n);
    this.video = new VideoFilter(n);
    this.max = new Float32Array(n).fill(-Infinity);
    this.min = new Float32Array(n).fill(Infinity);
    this.sum = new Float32Array(n);
    this.skip = Math.max(0, Math.ceil(rate / FFT_BUDGET) - 1);
  }

  /** The RBW in hertz. */
  get rbwHz(): number { return this.enbw * this.rate / this.n; }
  /** Bin spacing in hertz. */
  get binHz(): number { return this.rate / this.n; }
  /** Time from one transformed frame to the next, which is what the video filter integrates over. */
  get frameSec(): number { return (this.n * (1 + this.skip)) / this.rate; }

  /** Fold in a read of signed-int8 IQ. Returns how many frames it completed. */
  push(iq: Int8Array): number {
    const nSamp = iq.length >> 1;
    let done = 0;
    for (let s = 0; s < nSamp;) {
      if (this.skipLeft > 0) { const k = Math.min(this.skipLeft, nSamp - s); this.skipLeft -= k; s += k; continue; }
      const k = Math.min(this.n - this.fill, nSamp - s);
      for (let j = 0; j < k; j++) { this.bufI[this.fill + j] = iq[2 * (s + j)]; this.bufQ[this.fill + j] = iq[2 * (s + j) + 1]; }
      this.fill += k; s += k;
      if (this.fill === this.n) { this.frame(); this.fill = 0; this.skipLeft = this.skip * this.n; done++; }
    }
    return done;
  }

  /** Fold in one frame of float IQ (in int8 counts) directly: what the tests drive. */
  pushFloat(i: Float32Array, q: Float32Array): void {
    this.bufI.set(i.subarray(0, this.n)); this.bufQ.set(q.subarray(0, this.n)); this.frame();
  }

  private frame(): void {
    const n = this.n, h = n >> 1, w = this.w;
    for (let k = 0; k < n; k++) { this.re[k] = this.bufI[k] * w[k]; this.im[k] = this.bufQ[k] * w[k]; }
    fft(this.re, this.im);
    for (let i = 0; i < n; i++) { const s = i < h ? i + h : i - h; this.power[i] = (this.re[s] * this.re[s] + this.im[s] * this.im[s]) * this.norm; }
    if (this.dcPatch) patchDc(this.power, h, dcHalfWidth(this.kind));
    this.video.push(this.power, videoAlpha(this.vbwHz, this.frameSec));
    const y = this.video.y;
    for (let i = 0; i < n; i++) { const d = toDb(y[i]); if (d > this.max[i]) this.max[i] = d; if (d < this.min[i]) this.min[i] = d; this.sum[i] += y[i]; }
    this.framesSince++; this.frames++;
  }

  /**
   * The spectrum since the last take, bins a..b (inclusive), in dB: `live` is the power mean of every video-filtered
   * frame since then (an FFT analyzer's displayed frame: one lone frame of noise swings 20 dB bin to bin, dozens
   * averaged read steady), `max` and `min` the highest and lowest single frames (so a short burst is never lost).
   */
  take(a = 0, b = this.n - 1): { live: Float32Array; max: Float32Array; min: Float32Array; frames: number } {
    const len = b - a + 1;
    const live = new Float32Array(len), mx = new Float32Array(len), mn = new Float32Array(len);
    const frames = this.framesSince, k = 1 / Math.max(1, frames);
    for (let i = 0; i < len; i++) { live[i] = toDb(frames ? this.sum[a + i] * k : this.video.y[a + i]); mx[i] = this.max[a + i]; mn[i] = this.min[a + i]; }
    this.max.fill(-Infinity); this.min.fill(Infinity); this.sum.fill(0); this.framesSince = 0;
    return { live, max: mx, min: mn, frames };
  }
}
