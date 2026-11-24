/**
 * The start-up pick on a radio that sees only part of a band (an RTL-SDR: 2.4 of FM's 20 MHz). The view at the dial
 * keeps its station only when it leads that view and clearly stands out (the dial sits on the view's middle, where a
 * dongle's own DC and LO leakage reads as a weak station); otherwise the pick looks across the band a view at a time,
 * each view 50 kHz off the 100 kHz raster so no channel sits on a view's middle, and tunes the strongest channel on
 * the band's grid. The dial's station still stays when it is a third of the best and stands out. The same rules as
 * the iPad and Android apps.
 */

/** Lists from before a hop: the classifier waits this long after a retune. */
export const HOP_DRAIN_MS = 1500;
/** Frames are counted for this long once a hop's first list arrives (the view at the dial takes 2.5 s). */
export const HOP_LOOK_MS = 800;

/** The view centers that cover lo...hi at `rateHz`, 50 kHz off the raster; empty when one view already holds the band. */
export function bandHops(lo: number, hi: number, rateHz: number): number[] {
  const half = Math.floor(rateHz / 2) - 100_000;
  if (half <= 0 || hi - lo <= 2 * half) return [];
  const out: number[] = [];
  for (let c = lo + half + 50_000; c - half < hi; c += 2 * half) out.push(c);
  return out;
}

/**
 * A channel at `f` scored by the average level across ±80 kHz of it on `acc` (dB above the floor, summed over
 * `specN` frames) of a view at `center` sampled at `rate`. The DC spike's own bins (±30 kHz of the middle) are left
 * out of every score.
 */
export function channelScore(acc: ArrayLike<number>, specN: number, rate: number, center: number, f: number): number {
  const n = acc.length;
  if (!n || !specN) return 0;
  const binHz = rate / n, w = Math.max(1, Math.floor(80_000 / binHz)), start = center - rate / 2;
  const mid = Math.floor((f - start) / binHz); let sum = 0, cnt = 0;
  for (let k = Math.max(0, mid - w); k <= Math.min(n - 1, mid + w); k++) {
    if (Math.abs(start + (k + 0.5) * binHz - center) < 30_000) continue;
    sum += acc[k]; cnt++;
  }
  return cnt ? sum / cnt * (2 * w + 1) / specN : 0;
}

/** Every 100 kHz raster channel within `half` of the view's `center`, scored. */
export function viewScores(acc: ArrayLike<number>, specN: number, rate: number, center: number, half: number): [number, number][] {
  const all: [number, number][] = [];
  for (let f = Math.ceil((center - half) / 100_000) * 100_000; f <= center + half; f += 100_000) all.push([f, channelScore(acc, specN, rate, center, f)]);
  return all;
}

/**
 * The view at the dial keeps the station tuned: a third of the best in view and half again over the median, and not
 * a shoulder (`left`, `right` are the channels beside it). With the rest of the band still to look at
 * (`moreToLook`), only one that leads its view and clearly stands out.
 */
export function dialStays(mine: number, best: number, median: number, left: number, right: number, moreToLook: boolean): boolean {
  const enough = moreToLook ? mine >= 0.8 * best && mine >= 3 * median : mine >= best / 3 && mine >= 1.5 * median;
  return enough && mine >= left && mine >= right;
}

/** A view's scores folded into the band's: each channel (by its 100 kHz number) keeps its best. */
export function recordView(swept: Map<number, number>, all: [number, number][]): void {
  for (const [f, v] of all) { const k = Math.round(f / 100_000); swept.set(k, Math.max(swept.get(k) ?? 0, v)); }
}

/**
 * The two channels 50 kHz either side of each hop's middle. The dongle's own DC and LO leakage reaches past the bins
 * left out of every score and lifts them a little, one on each grid, which on a band with few stations could teach
 * the grid wrong (the strongest station's even shoulder picked over it). They stay candidates, but the grid is
 * learned without them.
 */
export function hopMiddles(hops: number[]): Set<number> {
  const out = new Set<number>();
  for (const c of hops) { out.add(Math.round((c - 50_000) / 100_000)); out.add(Math.round((c + 50_000) / 100_000)); }
  return out;
}

/** The verdict on the whole band: where to tune, its score, whether that is the dial's own station, and the band's best. */
export interface BandPick { hz: number; score: number; keptDial: boolean; bestHz: number; bestScore: number; channels: number; top: string }

/** The strongest channel in lo...hi on the band's grid; the dial's station stays when it is a third of the best and stands out. */
export function bandPick(swept: Map<number, number>, dialHz: number, lo: number, hi: number, middles: Set<number> = new Set()): BandPick | null {
  const band: [number, number][] = [...swept.keys()].filter(k => k * 100_000 >= lo && k * 100_000 <= hi).sort((a, b) => a - b).map(k => [k * 100_000, swept.get(k)!]);
  if (!band.length) return null;
  const g = fmGridParity(band.map(([f, v]): [number, number] => [f, middles.has(Math.round(f / 100_000)) ? 0 : v]));
  const onGrid = band.filter(([f]) => g < 0 || Math.round(f / 100_000) % 2 === g);
  if (!onGrid.length) return null;
  const b = onGrid.reduce((x, y) => (y[1] > x[1] ? y : x));
  const top = [...band].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([f, v]) => `${(f / 1e6).toFixed(1)}/${Math.round(v)}`).join(' ');
  const k = Math.round(dialHz / 100_000), mine = swept.get(k);
  if (mine !== undefined && k * 100_000 >= lo && k * 100_000 <= hi && (g < 0 || k % 2 === g)) {
    const median = onGrid.map(x => x[1]).sort((x, y) => x - y)[Math.floor(onGrid.length / 2)];
    if (mine >= b[1] / 3 && mine >= 1.5 * median && mine >= (swept.get(k - 1) ?? 0) && mine >= (swept.get(k + 1) ?? 0))
      return { hz: dialHz, score: mine, keptDial: true, bestHz: b[0], bestScore: b[1], channels: band.length, top };
  }
  return { hz: b[0], score: b[1], keptDial: false, bestHz: b[0], bestScore: b[1], channels: band.length, top };
}

/**
 * The broadcast grid in view: 1 when the stations heard sit on odd tenths (200 kHz apart, as in the Americas), 0 on
 * even tenths, -1 for any 100 kHz step. A station is a channel that tops both neighbors and is at least twice the
 * median; it takes three of them, nearly all on one parity, to settle it.
 */
export function fmGridParity(all: [number, number][]): number {
  if (all.length < 5) return -1;
  const median = all.map(x => x[1]).sort((a, b) => a - b)[Math.floor(all.length / 2)];
  let odd = 0, even = 0;
  for (let i = 1; i < all.length - 1; i++) {
    const v = all[i][1];
    if (v >= 2 * median && v > 0 && v >= all[i - 1][1] && v >= all[i + 1][1]) { if (Math.round(all[i][0] / 100_000) % 2 === 1) odd++; else even++; }
  }
  const n = odd + even;
  if (n < 3) return -1;
  return odd >= 0.7 * n ? 1 : even >= 0.7 * n ? 0 : -1;
}
