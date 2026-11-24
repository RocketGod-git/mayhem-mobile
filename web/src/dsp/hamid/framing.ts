/**
 * What a digital mode must show before the identity layer names it, beyond its sync word (home's real-air checks,
 * 2026-11-23: an 8-symbol or 24-symbol sync turns up in other signals too):
 *
 *   · frame spacing: its checked frames come on the mode's own frame grid, DMR 30 ms (60 ms a slot), D-STAR 20 ms,
 *     Fusion 100 ms, P25 180 ms, NXDN 40 or 80 ms, M17 40 ms, dPMR 80 ms. A pair of checked frames whose spacing is a
 *     whole number of frames counts; frames that pass their checks by chance fall anywhere. P25's checked frames are
 *     held to its shortest frame (the 15 ms terminator a repeater repeats in its hang time; an LDU is twelve of them).
 *     The mode detector's sync hits are held to each mode's voice frame, consecutive hit by consecutive hit, so a sync
 *     that repeats every 15 or 20 ms (another 4FSK or 2FSK system) names no P25 or M17 by itself;
 *   · the eye (M17 and P25): four levels, not two. A 2-level FSK burst read as 4FSK puts every symbol on the outer
 *     levels, a 4FSK signal half of them on the inner ones;
 *   · no clipping: while the receiver clips (a strong burst nearby sprays spurs across the band) a channel's samples
 *     go to no digital decoder (HamIdChannel.push).
 * No DOM.
 */

/** Each mode's frame in 4800/s symbols (NXDN48 and dPMR run at 2400/s, counted here as two each). */
export const FRAME_SYMS: Record<string, number> = { DMR: 144, 'D-STAR': 96, YSF: 480, P25: 72, NXDN: 192, M17: 192, dPMR: 384 };
/** The grid a key of [FrameGate] is held to: its mode's (a key may carry more after a colon, P25's NAC). */
export const frameSyms = (key: string) => FRAME_SYMS[key.split(':')[0]];
/** How far off a whole number of frames a spacing may be (symbol timing moves a little). */
export const GRID_TOL = 3;

/** Whether [d] symbols is a whole number of frames of [p]. */
export function onGrid(d: number, p: number): boolean {
  if (d < p - GRID_TOL) return false;
  const r = d % p;
  return r <= GRID_TOL || r >= p - GRID_TOL;
}

/** Checked frames per mode, with when they came: a mode is framed once two came a whole number of frames apart. */
export class FrameGate {
  private readonly seen = new Map<string, number>();
  private readonly last = new Map<string, number>();
  private readonly on = new Map<string, number>();
  reset(): void { this.seen.clear(); this.last.clear(); this.on.clear(); }
  /** The checked-frame count of [key] (a mode) is [count] at symbol time [t]: a new frame when it moved. */
  mark(key: string, count: number, t: number): void {
    if (count === (this.seen.get(key) ?? 0)) return;
    this.seen.set(key, count);
    const l = this.last.get(key);
    // a second check of the same frame (one burst passing two codes) is the same frame
    if (l !== undefined && t - l <= GRID_TOL) return;
    if (l !== undefined && onGrid(t - l, frameSyms(key))) this.on.set(key, (this.on.get(key) ?? 0) + 1);
    this.last.set(key, t);
  }
  /** Pairs of checked frames heard on the grid. */
  pairs(key: string): number { return this.on.get(key) ?? 0; }
  framed(key: string): boolean { return this.pairs(key) > 0; }
  /** Of the keys starting [prefix] (P25's NACs), the one with the most frames on the grid, or '' when none has any. */
  best(prefix: string): string { let b = '', n = 0; for (const [k, v] of this.on) if (k.startsWith(prefix) && v > n) { n = v; b = k; } return b; }
}

/**
 * The eye of [n] symbols (outer levels scaled to about ±3, as DiscSymbols gives them): 4 when they sit on four levels
 * (the inner and the outer ones each hold a share and few fall between), 2 when nearly all are on the outer two, 0 when
 * it cannot tell (noise).
 */
export function eyeLevels(sym: ArrayLike<number>, n = sym.length): 0 | 2 | 4 {
  let inner = 0, outer = 0, mid = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(sym[i]); total++;
    if (a >= 0.3 && a <= 1.7) inner++;
    else if (a >= 2.3 && a <= 4) outer++;
    else if (a > 1.7 && a < 2.3) mid++;
  }
  if (!total) return 0;
  const fi = inner / total, fo = outer / total, fm = mid / total;
  if (fi >= 0.15 && fo >= 0.15 && fm <= 0.6 * Math.min(fi, fo)) return 4;
  if (fi + fm < 0.1 && fo > 0.6) return 2;
  return 0;
}

/** Eye votes of one mode, one at each of its sync hits. */
export interface EyeVotes { four: number; other: number }
/** The eye agrees with a 4-level mode: most of its sync hits saw four levels. */
export const eyeOk = (v: EyeVotes | undefined) => !!v && v.four > 0 && v.four >= v.other;

/** A receive buffer clips when this share of its values sit at the converter's full scale. */
export const CLIP_SHARE = 0.002;
/** Whether 8-bit IQ ([iq], interleaved) is clipping: at least [CLIP_SHARE] of its values at ±127 or -128. */
export function iqClipping(iq: Int8Array, n = iq.length): boolean {
  let c = 0;
  for (let i = 0; i < n; i++) { const v = iq[i]; if (v >= 127 || v <= -127) c++; }
  return c >= CLIP_SHARE * n && c > 4;
}
