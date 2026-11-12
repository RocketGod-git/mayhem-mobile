/**
 * Spectrum: power measurements on a trace (dB per bin, bins `binHz` apart starting at `f0`, each measured through the
 * RBW filter). Every bin counts the power in one RBW, and bins sit closer together than one RBW, so a band's power is
 * the sum of its bins' powers times binHz / RBW; bins straddling an edge count for the part inside it.
 */

/** dBm (or dBFS) to milliwatts (or full-scale units) and back. */
export const dbToLin = (db: number) => 10 ** (db / 10);
export const linToDb = (p: number) => 10 * Math.log10(Math.max(p, 1e-30));

/** The power between lo and hi hertz, in linear units. */
export function bandPower(y: ArrayLike<number>, f0: number, binHz: number, rbwHz: number, lo: number, hi: number): number {
  let s = 0;
  const n = y.length;
  const a = Math.max(0, Math.floor((lo - f0) / binHz - 0.5)), b = Math.min(n - 1, Math.ceil((hi - f0) / binHz + 0.5));
  for (let i = a; i <= b; i++) {
    const c = f0 + i * binHz, l = Math.max(lo, c - binHz / 2), r = Math.min(hi, c + binHz / 2);
    if (r > l) s += dbToLin(y[i]) * (r - l) / binHz;
  }
  return s * binHz / rbwHz;
}

/** Channel power in a channel `bwHz` wide around `centerHz`, in dB. */
export function channelPower(y: ArrayLike<number>, f0: number, binHz: number, rbwHz: number, centerHz: number, bwHz: number): number {
  return linToDb(bandPower(y, f0, binHz, rbwHz, centerHz - bwHz / 2, centerHz + bwHz / 2));
}

/**
 * Occupied bandwidth: the band holding `pct` percent of the trace's power, with (100 - pct) / 2 percent left out on
 * each side (99 % by default, as the FCC and ETSI define it).
 */
export function occupiedBw(y: ArrayLike<number>, f0: number, binHz: number, rbwHz: number, pct = 99): { bw: number; lo: number; hi: number; total: number } {
  const n = y.length;
  let total = 0;
  for (let i = 0; i < n; i++) total += dbToLin(y[i]);
  const edge = total * (1 - pct / 100) / 2;
  const at = (target: number): number => {
    let c = 0;
    for (let i = 0; i < n; i++) {
      const p = dbToLin(y[i]);
      if (c + p >= target) return f0 + (i - 0.5 + (p > 0 ? (target - c) / p : 0)) * binHz;
      c += p;
    }
    return f0 + (n - 0.5) * binHz;
  };
  const lo = at(edge), hi = at(total - edge);
  return { bw: hi - lo, lo, hi, total: linToDb(total * binHz / rbwHz) };
}

/** Adjacent-channel power ratio: the main channel's power and each neighbor's, `spacingHz` away, in dBc. */
export function acpr(y: ArrayLike<number>, f0: number, binHz: number, rbwHz: number, centerHz: number, bwHz: number, spacingHz: number, adjBwHz = bwHz):
  { main: number; lower: number; upper: number; lowerDbc: number; upperDbc: number } {
  const main = channelPower(y, f0, binHz, rbwHz, centerHz, bwHz);
  const lower = channelPower(y, f0, binHz, rbwHz, centerHz - spacingHz, adjBwHz);
  const upper = channelPower(y, f0, binHz, rbwHz, centerHz + spacingHz, adjBwHz);
  return { main, lower, upper, lowerDbc: lower - main, upperDbc: upper - main };
}

/**
 * The noise floor: the trace's median (robust to the carriers on it), per RBW, and as a density in dB/Hz.
 * The median of an averaged noise trace sits on its mean; a single unaveraged frame reads up to 1.6 dB low.
 */
export function noiseFloor(y: ArrayLike<number>, rbwHz: number): { floor: number; density: number } {
  const s = Float32Array.from(y as ArrayLike<number>).filter(Number.isFinite).sort();
  if (!s.length) return { floor: NaN, density: NaN };
  const m = s.length & 1 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { floor: m, density: m - 10 * Math.log10(rbwHz) };
}

/** The noise density at one bin, in dB/Hz: a few bins either side power-averaged, divided by the RBW. */
export function noiseAt(y: ArrayLike<number>, i: number, rbwHz: number, half = 4): number {
  let s = 0, k = 0;
  for (let j = Math.max(0, i - half); j <= Math.min(y.length - 1, i + half); j++) { s += dbToLin(y[j]); k++; }
  return linToDb(s / Math.max(1, k)) - 10 * Math.log10(rbwHz);
}
