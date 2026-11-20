/**
 * HD Radio AUTO: where to look for stations and in what order to visit them. Pure functions, the same on every
 * platform (HdScanPlan on Android and in the Swift core).
 *
 * AUTO finds the stations first and only then tunes them, lowest first. A radio that sees most of the FM band at once
 * (a HackRF) takes one or a few wide looks and reads each 100 kHz channel's level off the averaged spectrum; a narrow
 * one (an RTL-SDR) surveys the band window by window at the HD rate, bottom up, and takes the hybrid channels the HD
 * finder reports in each. Stations already heard are merged in. At the top of the band it looks again and starts over.
 */

/** The FM band's station centers: 87.9 to 107.9 MHz, on a 100 kHz raster so it works everywhere. */
export const HD_BAND_LO = 87_900_000, HD_BAND_HI = 107_900_000, HD_RASTER = 100_000;
/** A wide look takes at most this many spans across the band; past that the window survey is quicker. */
export const HD_MAX_LOOKS = 4;
/** The part of a span a look trusts: the radio's baseband filter rolls the edges off. */
export const HD_LOOK_USABLE = 0.75;
/** A channel this far over the floor (dB, its 160 kHz average) is a station worth a visit. */
export const HD_STRONG_DB = 12;
/** A station heard before is visited again when the look still sees it at least this far over the floor. */
export const HD_SAVED_DB = 6;

export interface HdLookPlan { wide: boolean; rate: number; centers: number[] }

const snap = (hz: number) => Math.round(hz / HD_RASTER) * HD_RASTER;

/** The windows of the survey at the HD rate, each heard from its middle, bottom up (the HD finder's reach each side). */
export function hdWindows(hdRate: number): number[] {
  const reach = hdRate / 2 - 260_000, out: number[] = [];
  for (let c = 88_000_000 + reach; c - reach < 108_000_000; c += 2 * reach - 100_000) out.push(snap(c));
  return out;
}

/**
 * How AUTO looks at the band. [rates]: the spans this radio and screen can take, any order. The fewest looks that
 * cover every station's channel, at the narrowest span that does it (less work, finer bins). Each look is centered
 * halfway between two raster channels so the radio's DC spike lands on neither. More than [HD_MAX_LOOKS] (an RTL-SDR)
 * and AUTO surveys windows at the HD rate instead.
 */
export function hdLookPlan(rates: number[], hdRate: number): HdLookPlan {
  const lo = HD_BAND_LO - HD_RASTER, hi = HD_BAND_HI + HD_RASTER, need = hi - lo;
  let best: { rate: number; n: number } | null = null;
  for (const rate of [...rates].sort((a, b) => a - b)) {
    if (rate <= hdRate) continue;
    const n = Math.ceil(need / (rate * HD_LOOK_USABLE));
    if (!best || n < best.n) best = { rate, n };
  }
  if (!best || best.n > HD_MAX_LOOKS) return { wide: false, rate: hdRate, centers: hdWindows(hdRate) };
  const use = best.rate * HD_LOOK_USABLE, centers: number[] = [];
  for (let i = 0; i < best.n; i++) {
    const c = best.n === 1 ? (lo + hi) / 2 : lo + use / 2 + i * (need - use) / (best.n - 1);
    centers.push(Math.floor(c / HD_RASTER) * HD_RASTER + HD_RASTER / 2);
  }
  return { wide: true, rate: best.rate, centers };
}

/**
 * Every raster channel a look shows, with its level: the average dB over the floor across ±80 kHz of it. [spec] is the
 * averaged spectrum, dB over its own median, bin 0 at the bottom of the span. Only the trusted middle of the span
 * counts, and the DC spike's own bins (±30 kHz of the center) are left out of every channel.
 */
export function hdChannelLevels(spec: ArrayLike<number>, rate: number, centerHz: number): Map<number, number> {
  const out = new Map<number, number>(), n = spec.length;
  if (!n || rate <= 0) return out;
  const binHz = rate / n, start = centerHz - rate / 2, half = rate * HD_LOOK_USABLE / 2, w = Math.max(1, Math.floor(80_000 / binHz));
  for (let f = Math.ceil(Math.max(HD_BAND_LO, centerHz - half) / HD_RASTER) * HD_RASTER; f <= Math.min(HD_BAND_HI, centerHz + half); f += HD_RASTER) {
    const mid = Math.floor((f - start) / binHz);
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, mid - w); k <= Math.min(n - 1, mid + w); k++) {
      if (Math.abs(start + (k + 0.5) * binHz - centerHz) < 30_000) continue;
      sum += spec[k]; cnt++;
    }
    if (cnt) out.set(f, sum / cnt);
  }
  return out;
}

/** Two looks' levels as one: where they overlap, the higher reading. */
export function hdMergeLevels(into: Map<number, number>, add: Map<number, number>): Map<number, number> {
  for (const [f, v] of add) { const was = into.get(f); if (was === undefined || v > was) into.set(f, v); }
  return into;
}

/**
 * The stations in a look: channels at least [minDb] over the floor that stand above both neighbors (a strong
 * station's ±100 kHz shoulders and its HD sidebands also read high), lowest first.
 */
export function hdStrongStations(levels: Map<number, number>, minDb = HD_STRONG_DB): number[] {
  const out: number[] = [];
  for (const [f, v] of levels) {
    if (v < minDb) continue;
    const below = levels.get(f - HD_RASTER) ?? -Infinity, above = levels.get(f + HD_RASTER) ?? -Infinity;
    if (v > below && v >= above) out.push(f);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The visits, lowest first: the stations found plus the ones heard before. With [levels] (a wide look), a station
 * heard before is kept only if the look still shows it [HD_SAVED_DB] over the floor; without (the window survey)
 * every one is kept. Each on the raster, in the band, once.
 */
export function hdVisitOrder(found: number[], saved: number[], levels: Map<number, number> | null = null): number[] {
  const keep = saved.map(snap).filter(f => !levels || (levels.get(f) ?? -Infinity) >= HD_SAVED_DB);
  return [...new Set([...found.map(snap), ...keep])].filter(f => f >= HD_BAND_LO && f <= HD_BAND_HI).sort((a, b) => a - b);
}
