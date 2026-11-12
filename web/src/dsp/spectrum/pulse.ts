/**
 * Spectrum: automatic pulse measurements on a zero-span amplitude trace (dB), on the linear envelope as an
 * oscilloscope measures them. The top and base levels are the medians of the samples above and below the halfway
 * point between the trace's extremes; edges are where the envelope crosses 50 % of the way from base to top (with 10 %
 * hysteresis), interpolated between samples. Width = rise to fall, period = rise to rise, duty = width / period,
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

const median = (a: number[]) => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length & 1 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

/**
 * Pulse statistics for an amplitude trace in dB sampled at `rate`; null when there is no on/off structure: top and base
 * under PULSE_MIN_DB apart (a steady carrier's noise and fading dips are not pulses).
 */
export function pulseStats(ampDb: ArrayLike<number>, rate: number): PulseStats | null {
  const n = ampDb.length;
  if (n < 4) return null;
  const v = new Float64Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { v[i] = 10 ** (ampDb[i] / 20); if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
  const mid = (lo + hi) / 2;
  const ups: number[] = [], downs: number[] = [];
  for (let i = 0; i < n; i++) (v[i] > mid ? ups : downs).push(v[i]);
  const top = median(ups), base = median(downs);
  if (!ups.length || !downs.length || !(20 * Math.log10(top / base) >= PULSE_MIN_DB)) return null;
  const at = (f: number) => base + f * (top - base);
  const l10 = at(0.1), l50 = at(0.5), l90 = at(0.9), hy = 0.1 * (top - base);
  /** Where the trace crosses `lvl` between samples i-1 and i, in samples. */
  const cross = (i: number, lvl: number) => { const a = v[i - 1], b = v[i]; return b === a ? i : i - 1 + (lvl - a) / (b - a); };
  const rises: number[] = [], falls: number[] = [], riseT: number[] = [], fallT: number[] = [];
  let high = v[0] > l50;
  for (let i = 1; i < n; i++) {
    if (!high && v[i] >= l50 + hy) {
      high = true;
      let j = i; while (j > 1 && v[j - 1] >= l50) j--;
      rises.push(cross(j, l50));
      // 10 % on the way up (searching back) and 90 % (searching forward)
      let a = j; while (a > 1 && v[a - 1] >= l10) a--;
      let b = i; while (b < n - 1 && v[b] < l90) b++;
      if (a > 1 && v[a - 1] < l10 && v[b] >= l90 && b > 0) riseT.push(cross(b, l90) - cross(a, l10));
    } else if (high && v[i] <= l50 - hy) {
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
