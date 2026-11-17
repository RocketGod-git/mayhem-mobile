/**
 * US LTE downlink presets (36.101 Table 5.5-1 operating bands, Table 5.7.3-1 EARFCN) and carrier finding from a
 * stitched power profile: a downlink carrier is a flat block of 1.08, 2.7, 4.5, 9, 13.5 or 18 MHz occupied
 * (N_RB x 180 kHz) whose center sits on the 100 kHz raster.
 */
export interface BandPreset { id: string; label: string; bands: number[]; lo: number; hi: number; tdd: boolean }
export const CELL_BANDS: BandPreset[] = [
  { id: 'B12', label: 'B12/17', bands: [12, 17], lo: 729e6, hi: 746e6, tdd: false },
  { id: 'B13', label: 'B13', bands: [13], lo: 746e6, hi: 756e6, tdd: false },
  { id: 'B14', label: 'B14', bands: [14], lo: 758e6, hi: 768e6, tdd: false },
  { id: 'B5', label: 'B5/26', bands: [5, 26], lo: 859e6, hi: 894e6, tdd: false },
  { id: 'B2', label: 'B2/25', bands: [2, 25], lo: 1930e6, hi: 1995e6, tdd: false },
  { id: 'B4', label: 'B4/66', bands: [4, 66], lo: 2110e6, hi: 2200e6, tdd: false },
  { id: 'B41', label: 'B41 TDD', bands: [41], lo: 2496e6, hi: 2690e6, tdd: true },
];
export const OCCUPIED_MHZ: [number, number][] = [[6, 1.08], [15, 2.7], [25, 4.5], [50, 9], [75, 13.5], [100, 18]];
/** Sample rate that holds a whole carrier of n RBs (a power-of-two FFT at 15 kHz). */
export const rateForRb = (nrb: number) => nrb <= 6 ? 1_920_000 : nrb <= 15 ? 3_840_000 : nrb <= 25 ? 7_680_000 : nrb <= 75 ? 15_360_000 : 30_720_000;
export const bandOf = (hz: number) => CELL_BANDS.find(b => hz >= b.lo - 1e5 && hz <= b.hi + 1e5) ?? null;

/** A stitched profile: power in dB at fixed steps from lo. */
export interface Profile { lo: number; step: number; db: Float32Array; seen: Uint8Array }
export function newProfile(lo: number, hi: number, step = 50_000): Profile {
  const n = Math.ceil((hi - lo) / step) + 1;
  return { lo, step, db: new Float32Array(n).fill(-200), seen: new Uint8Array(n) };
}
/** Writes one window's measurement (absolute Hz of its first point, step, dB values). */
export function stitch(p: Profile, lo: number, step: number, db: ArrayLike<number>): void {
  for (let i = 0; i < db.length; i++) {
    const j = Math.round((lo + i * step - p.lo) / p.step);
    if (j < 0 || j >= p.db.length) continue;
    p.db[j] = p.seen[j] ? Math.max(p.db[j], db[i]) : db[i]; p.seen[j] = 1;
  }
}
export interface CarrierGuess { centerHz: number; occupiedMhz: number; nrb: number; levelDb: number }
/**
 * Occupied blocks of the profile (above floor + 8 dB, at least 1 MHz) and the carrier centers they imply. A block
 * wider than one carrier is also offered as two or more 5 or 10 MHz carriers side by side.
 */
export function findCarriers(p: Profile, raster = 100_000): CarrierGuess[] {
  const vals = Array.from(p.db).filter((_, i) => p.seen[i]).sort((a, b) => a - b);
  if (vals.length < 10) return [];
  const floor = vals[Math.floor(vals.length * 0.15)], thr = floor + 8, out: CarrierGuess[] = [];
  const snap = (hz: number) => Math.round(hz / raster) * raster;
  let i = 0;
  while (i < p.db.length) {
    if (!p.seen[i] || p.db[i] < thr) { i++; continue; }
    let j = i, sum = 0;
    while (j < p.db.length && p.seen[j] && p.db[j] >= thr) { sum += p.db[j]; j++; }
    const lo = p.lo + (i - 0.5) * p.step, hi = p.lo + (j - 0.5) * p.step, w = (hi - lo) / 1e6, level = sum / (j - i) - floor;
    if (w >= 1) {
      let best = OCCUPIED_MHZ[0];
      for (const o of OCCUPIED_MHZ) if (Math.abs(o[1] - w) < Math.abs(best[1] - w)) best = o;
      out.push({ centerHz: snap((lo + hi) / 2), occupiedMhz: best[1], nrb: best[0], levelDb: level });
      if (w > 9.6) for (const [nrb, occ] of [[50, 9], [25, 4.5]] as [number, number][]) {
        const n = Math.round(w / (occ + 0.5));
        if (n < 2) continue;
        const pitch = (w * 1e6) / n;
        for (let k = 0; k < n; k++) out.push({ centerHz: snap(lo + pitch * (k + 0.5)), occupiedMhz: occ, nrb, levelDb: level });
      }
    }
    i = j;
  }
  const seen = new Set<number>();
  return out.filter(c => !seen.has(c.centerHz) && (seen.add(c.centerHz), true));
}
