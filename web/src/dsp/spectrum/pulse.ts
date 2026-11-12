/**
 * Spectrum: automatic pulse measurements on a zero-span amplitude trace (dB), on the linear envelope as an
 * oscilloscope measures them. The trace must hold two distinct levels (twoLevels); the top and base are the medians of
 * the samples above and below the threshold between them; edges are where the envelope crosses 50 % of the way from base to top (with 10 %
 * hysteresis, and the new level held PULSE_HOLD samples), interpolated between samples. Width = rise to fall, period = rise to rise, duty = width / period,
 * rise time = 10 % to 90 %, fall time = 90 % to 10 %. Each is the mean over every complete instance in the trace.
 */

export interface PulseStats {
  /** Top and base levels, dB. */
  top: number; base: number;
  /** Seconds (NaN when the trace holds no complete instance). */
  width: number; period: number; rise: number; fall: number;
  /** 0..1. */
  duty: number;
  pulses: number;
}

/** How far the top must sit above the base for the trace to count as pulsed. */
export const PULSE_MIN_DB = 10;
/** The two levels must stand apart by this much against their own spread: (μ1 − μ0)² / (σ0² + σ1²). */
export const PULSE_SEPARATION = 4;
/** Each level must hold at least this share of the samples (a deep fade now and then is not a pulse train). */
export const PULSE_MIN_SHARE = 0.02;
/** A crossing counts only when the new level holds this many samples (a noise spike is not an edge). */
export const PULSE_HOLD = 3;

/**
 * Whether a trace (dB) holds two distinct levels, and the dB value between them: the threshold that best splits its
 * 0.5 dB histogram into two classes (Otsu), accepted only when the classes stand apart against their spread and each
 * holds a fair share of the samples. The envelope of noise alone (its deep fades included) fails this.
 */
export function twoLevels(db: ArrayLike<number>): number | null {
  const n = db.length;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const d = db[i]; if (Number.isFinite(d)) { if (d < lo) lo = d; if (d > hi) hi = d; } }
  if (!(hi - lo >= PULSE_MIN_DB)) return null;
  const W = 0.5, bins = Math.ceil((hi - lo) / W) + 1;
  const h = new Float64Array(bins);
  let tot = 0, sum = 0;
  for (let i = 0; i < n; i++) { const d = db[i]; if (!Number.isFinite(d)) continue; h[Math.min(bins - 1, Math.floor((d - lo) / W))]++; tot++; sum += d; }
  let w0 = 0, s0 = 0, best = -1, bestK = -1;
  for (let k = 0; k < bins - 1; k++) {
    const c = lo + (k + 0.5) * W;
    w0 += h[k]; s0 += h[k] * c;
    const w1 = tot - w0; if (!w0 || !w1) continue;
    const m0 = s0 / w0, m1 = (sum - s0) / w1, between = w0 * w1 * (m1 - m0) ** 2;
    if (between > best) { best = between; bestK = k; }
  }
  if (bestK < 0) return null;
  const th = lo + (bestK + 1) * W;
  let n0 = 0, n1 = 0, a0 = 0, a1 = 0, q0 = 0, q1 = 0;
  for (let i = 0; i < n; i++) { const d = db[i]; if (!Number.isFinite(d)) continue; if (d < th) { n0++; a0 += d; q0 += d * d; } else { n1++; a1 += d; q1 += d * d; } }
  if (n0 < PULSE_MIN_SHARE * tot || n1 < PULSE_MIN_SHARE * tot) return null;
  const m0 = a0 / n0, m1 = a1 / n1, v0 = q0 / n0 - m0 * m0, v1 = q1 / n1 - m1 * m1;
  if ((m1 - m0) ** 2 < PULSE_SEPARATION * (v0 + v1)) return null;
  return th;
}

const median = (a: number[]) => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length & 1 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

/**
 * Pulse statistics for an amplitude trace in dB sampled at `rate`; null when there is no on/off structure: top and base
 * under PULSE_MIN_DB apart, or not two distinct levels (noise and a steady carrier's fading dips are not pulses).
 */
export function pulseStats(ampDb: ArrayLike<number>, rate: number): PulseStats | null {
  const n = ampDb.length;
  if (n < 4) return null;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = 10 ** (ampDb[i] / 20);
  const split = twoLevels(ampDb);
  if (!split) return null;
  const ups: number[] = [], downs: number[] = [];
  for (let i = 0; i < n; i++) (ampDb[i] > split ? ups : downs).push(v[i]);
  const top = median(ups), base = median(downs);
  if (!(20 * Math.log10(top / base) >= PULSE_MIN_DB)) return null;
  const at = (f: number) => base + f * (top - base);
  const l10 = at(0.1), l50 = at(0.5), l90 = at(0.9), hy = 0.1 * (top - base);
  /** Where the trace crosses `lvl` between samples i-1 and i, in samples. */
  const cross = (i: number, lvl: number) => { const a = v[i - 1], b = v[i]; return b === a ? i : i - 1 + (lvl - a) / (b - a); };
  const rises: number[] = [], falls: number[] = [], riseT: number[] = [], fallT: number[] = [];
  let high = v[0] > l50;
  /** Whether samples i .. i + PULSE_HOLD - 1 all stay on the far side of the 50 % level. */
  const holds = (i: number, up: boolean) => { for (let j = i; j < Math.min(n, i + PULSE_HOLD); j++) if (up ? v[j] < l50 : v[j] > l50) return false; return true; };
  for (let i = 1; i < n; i++) {
    if (!high && v[i] >= l50 + hy && holds(i, true)) {
      high = true;
      let j = i; while (j > 1 && v[j - 1] >= l50) j--;
      rises.push(cross(j, l50));
      // 10 % on the way up (searching back) and 90 % (searching forward)
      let a = j; while (a > 1 && v[a - 1] >= l10) a--;
      let b = i; while (b < n - 1 && v[b] < l90) b++;
      if (a > 1 && v[a - 1] < l10 && v[b] >= l90 && b > 0) riseT.push(cross(b, l90) - cross(a, l10));
    } else if (high && v[i] <= l50 - hy && holds(i, false)) {
      high = false;
      let j = i; while (j > 1 && v[j - 1] <= l50) j--;
      falls.push(cross(j, l50));
      let a = j; while (a > 1 && v[a - 1] <= l90) a--;
      let b = i; while (b < n - 1 && v[b] > l10) b++;
      if (a > 1 && v[a - 1] > l90 && v[b] <= l10 && b > 0) fallT.push(cross(b, l10) - cross(a, l90));
    }
  }
  const widths: number[] = [], periods: number[] = [];
  for (const r of rises) { const f = falls.find(x => x > r); if (f !== undefined) widths.push(f - r); }
  for (let k = 1; k < rises.length; k++) periods.push(rises[k] - rises[k - 1]);
  // a width with no fall after the last rise belongs to a pulse cut off by the window; it is not counted
  const width = mean(widths) / rate, period = mean(periods) / rate;
  return {
    top: 20 * Math.log10(top), base: 20 * Math.log10(base),
    width, period, duty: width / period, rise: mean(riseT) / rate, fall: mean(fallT) / rate, pulses: widths.length,
  };
}

/** A trigger level for a trace (dB): its median (the noise, between bursts) plus `marginDb`, rounded to 1 dB. */
export function autoLevel(ampDb: ArrayLike<number>, marginDb = 12): number {
  const s = Float32Array.from(ampDb as ArrayLike<number>).filter(Number.isFinite).sort();
  return s.length ? Math.round(s[s.length >> 1] + marginDb) : NaN;
}
