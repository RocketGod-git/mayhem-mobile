/**
 * Spectrum: resolution and video bandwidth for an FFT analyzer.
 *
 * The resolution bandwidth (RBW) of an FFT bin is its window's equivalent noise bandwidth: ENBW (in bins) times the
 * bin spacing, rate / N. A requested RBW picks the power-of-two N nearest to it (in log), so the RBW actually used is
 * always reported back rather than the one asked for. The video bandwidth (VBW) is a single-pole low-pass on each
 * bin's power from frame to frame, as the video filter after an analog analyzer's detector; a VBW at or above the
 * RBW passes every frame through untouched.
 */

export type WindowKind = 'HANN' | 'FLATTOP';
export const WINDOWS: WindowKind[] = ['HANN', 'FLATTOP'];
export const MIN_FFT = 64;
export const MAX_FFT = 65536;

const windowCache = new Map<string, Float32Array>();
/** The window of length n: Hann (good resolution), or a flat top (a tone reads its true level wherever it falls). */
export function windowOf(kind: WindowKind, n: number): Float32Array {
  const key = `${kind}:${n}`;
  let w = windowCache.get(key);
  if (w) return w;
  w = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const x = 2 * Math.PI * k / n;
    // periodic windows (divide by n, not n - 1): the ENBW below is then exact
    w[k] = kind === 'HANN' ? 0.5 - 0.5 * Math.cos(x)
      : 0.21557895 - 0.41663158 * Math.cos(x) + 0.277263158 * Math.cos(2 * x) - 0.083578947 * Math.cos(3 * x) + 0.006947368 * Math.cos(4 * x);
  }
  windowCache.set(key, w);
  return w;
}

/** A window's sum (the coherent gain times n) and its equivalent noise bandwidth in bins. */
export function windowGains(w: Float32Array): { sum: number; enbw: number } {
  let s = 0, s2 = 0;
  for (let k = 0; k < w.length; k++) { s += w[k]; s2 += w[k] * w[k]; }
  return { sum: s, enbw: w.length * s2 / (s * s) };
}

/** The ENBW in bins of each window (1.5 for Hann, 3.77 for the flat top). */
export function enbwBins(kind: WindowKind): number { return windowGains(windowOf(kind, 1024)).enbw; }

/** The RBW an N-point FFT at this rate gives. */
export function rbwOf(rate: number, n: number, kind: WindowKind): number { return enbwBins(kind) * rate / n; }

/** The power-of-two FFT length whose RBW is nearest to the one asked for, within MIN_FFT..MAX_FFT. */
export function fftSizeFor(rate: number, rbwHz: number, kind: WindowKind): number {
  const ideal = enbwBins(kind) * rate / Math.max(1e-3, rbwHz);
  const p = Math.round(Math.log2(Math.max(1, ideal)));
  return Math.max(MIN_FFT, Math.min(MAX_FFT, 2 ** p));
}

/** The bench 1-3-10 steps from 1 Hz to 3 MHz, for RBW and VBW. */
export const BW_STEPS: number[] = (() => {
  const out: number[] = [];
  for (let d = 1; d <= 1e6; d *= 10) out.push(d, 3 * d);
  return out;
})();

/** How many RBWs fit across the span when the RBW is automatic (a bench analyzer's span/RBW ratio). */
export const SPAN_RBW_RATIO = 500;
/** The automatic RBW for a span: the 1-3-10 step at or under span / SPAN_RBW_RATIO. */
export function autoRbw(spanHz: number): number {
  const want = spanHz / SPAN_RBW_RATIO;
  let best = BW_STEPS[0];
  for (const s of BW_STEPS) if (s <= want) best = s;
  return best;
}

/** One step up or down the 1-3-10 ladder from v (dir +1 / -1). */
export function stepBw(v: number, dir: number): number {
  let i = 0, best = Infinity;
  for (let k = 0; k < BW_STEPS.length; k++) { const d = Math.abs(Math.log(BW_STEPS[k] / Math.max(1e-3, v))); if (d < best) { best = d; i = k; } }
  return BW_STEPS[Math.max(0, Math.min(BW_STEPS.length - 1, i + dir))];
}

/**
 * The video filter's coefficient for one frame `frameSec` long: a single pole at the VBW,
 * alpha = 1 - exp(-2π · VBW · T). A VBW at the RBW gives alpha near 1 (each frame stands alone).
 */
export function videoAlpha(vbwHz: number, frameSec: number): number {
  return 1 - Math.exp(-2 * Math.PI * Math.max(0, vbwHz) * Math.max(0, frameSec));
}

/** The video filter: each bin's power low-passed from frame to frame (in linear power, so noise is not biased low). */
export class VideoFilter {
  readonly y: Float32Array;
  private primed = false;
  constructor(readonly n: number) { this.y = new Float32Array(n); }
  reset(): void { this.primed = false; }
  /** Fold in one frame of linear power with coefficient alpha. */
  push(p: Float32Array, alpha: number): void {
    if (!this.primed || alpha >= 1) { this.y.set(p.subarray(0, this.n)); this.primed = true; return; }
    const a = Math.max(0, alpha);
    for (let i = 0; i < this.n; i++) this.y[i] += a * (p[i] - this.y[i]);
  }
}
