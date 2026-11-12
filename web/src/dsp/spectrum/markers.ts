/**
 * Spectrum: markers and peak search, as on a bench analyzer.
 *
 * A peak is a local maximum that the trace both rises to and falls from by at least the peak excursion (6 dB by
 * default) before meeting anything higher, and that sits above the peak threshold. PEAK puts a marker on the highest
 * peak; NEXT PEAK on the highest peak below the marker's current level; NEXT LEFT / NEXT RIGHT on the nearest peak
 * to that side. With no peak at all, PEAK falls back to the highest bin.
 */

export const PEAK_EXCURSION_DB = 6;
export const MARKER_COUNT = 4;

export interface Marker {
  on: boolean;
  /** Where the marker sits, in hertz (kept across span changes). */
  hz: number;
  /** A delta marker reads relative to marker 1. */
  delta: boolean;
  /** Which trace (0..3) it reads. */
  trace: number;
}
export function defaultMarkers(): Marker[] {
  return Array.from({ length: MARKER_COUNT }, () => ({ on: false, hz: 0, delta: false, trace: 0 }));
}

/** Every peak in y, left to right. */
export function findPeaks(y: ArrayLike<number>, excursion = PEAK_EXCURSION_DB, threshold = -Infinity): number[] {
  const n = y.length, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = y[i];
    if (!(v >= threshold) || !Number.isFinite(v)) continue;
    // a local maximum, the first bin of a flat top
    if (i > 0 && y[i - 1] >= v) continue;
    let j = i; while (j + 1 < n && y[j + 1] === v) j++;
    if (j + 1 < n && y[j + 1] > v) { i = j; continue; }
    // how far it falls on each side before anything higher (or the end of the trace)
    let lo = v, k = i - 1;
    for (; k >= 0 && y[k] <= v; k--) if (y[k] < lo) lo = y[k];
    const left = v - lo;
    lo = v; k = j + 1;
    for (; k < n && y[k] <= v; k++) if (y[k] < lo) lo = y[k];
    const right = v - lo;
    if (Math.min(left, right) >= excursion) out.push(i);
    i = j;
  }
  return out;
}

/** The highest bin (the first, on a tie). */
export function argMax(y: ArrayLike<number>): number {
  let b = 0;
  for (let i = 1; i < y.length; i++) if (y[i] > y[b]) b = i;
  return b;
}

/** The highest peak, or the highest bin when nothing qualifies. */
export function peakSearch(y: ArrayLike<number>, excursion = PEAK_EXCURSION_DB, threshold = -Infinity): number {
  const p = findPeaks(y, excursion, threshold);
  if (!p.length) return argMax(y);
  let b = p[0];
  for (const i of p) if (y[i] > y[b]) b = i;
  return b;
}

/** The highest peak lower than the bin `from`; `from` itself when there is none. */
export function nextPeak(y: ArrayLike<number>, from: number, excursion = PEAK_EXCURSION_DB, threshold = -Infinity): number {
  const lvl = y[from];
  let b = -1;
  for (const i of findPeaks(y, excursion, threshold)) {
    if (i === from || y[i] > lvl || (y[i] === lvl && i < from)) continue;
    if (b < 0 || y[i] > y[b]) b = i;
  }
  return b < 0 ? from : b;
}

/** The nearest peak to the left of `from`; `from` itself when there is none. */
export function nextPeakLeft(y: ArrayLike<number>, from: number, excursion = PEAK_EXCURSION_DB, threshold = -Infinity): number {
  const p = findPeaks(y, excursion, threshold).filter(i => i < from);
  return p.length ? p[p.length - 1] : from;
}

/** The nearest peak to the right of `from`; `from` itself when there is none. */
export function nextPeakRight(y: ArrayLike<number>, from: number, excursion = PEAK_EXCURSION_DB, threshold = -Infinity): number {
  const p = findPeaks(y, excursion, threshold).find(i => i > from);
  return p ?? from;
}

/**
 * The peak's true position and level from a parabola through it and its two neighbors (in dB): an offset in bins
 * (-0.5..0.5) and the level at that offset. A tone between two bins reads its frequency to a small part of a bin.
 */
export function refinePeak(y: ArrayLike<number>, i: number): { offset: number; level: number } {
  if (i <= 0 || i >= y.length - 1) return { offset: 0, level: y[i] };
  const a = y[i - 1], b = y[i], c = y[i + 1];
  const den = a - 2 * b + c;
  if (!(den < 0)) return { offset: 0, level: b };
  const d = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den));
  return { offset: d, level: b - 0.25 * (a - c) * d };
}

/** The bin nearest to a frequency, clamped to the trace. */
export const binOf = (hz: number, f0: number, binHz: number, n: number) => Math.max(0, Math.min(n - 1, Math.round((hz - f0) / binHz)));
