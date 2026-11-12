/**
 * Lining up repeated frames bit by bit: what stays the same between presses and what changes.
 *
 * Several presses of one button, or one press heard several times, are each read to bits; this slides every frame
 * along a reference until the most bits agree, then marks each column fixed (every frame that reaches it agrees)
 * or changing. The fixed run at the front is usually a preamble (a 1010 or 1111 training run the receiver locks on
 * to) and then a sync word; the changing columns are the rolling code, a counter or a checksum. Reading these off by
 * eye is how an unknown key is cracked: it is how the Land Rover key in this app was.
 *
 * Twin of core/analyzer/Align.kt and Align.swift.
 */

export interface AlignedRow {
  /** Which of the frames passed in this is. */
  index: number;
  /** The column its first bit lands on. */
  shift: number;
  bits: string;
}

export interface Segment { from: number; to: number; fixed: boolean }

export interface Alignment {
  rows: AlignedRow[];
  /** The number of columns, from the leftmost first bit to the rightmost last. */
  width: number;
  /** Per column: 1 fixed, 0 changing, 2 only one frame reaches it. */
  state: Uint8Array;
  /** Per column, the bit most frames have ('0', '1', or '?' where none reach). */
  consensus: string;
  /** The training run at the front, as [from, to) columns, or null. */
  preamble: [number, number] | null;
  /** The fixed run straight after it (up to 32 bits), or null. */
  sync: { from: number; to: number; bits: string; hex: string } | null;
  /** The columns from the end of the preamble on, in fixed and changing stretches. */
  segments: Segment[];
  fixedBits: number;
  changingBits: number;
}

/**
 * Each frame as its 8-bit windows, one per bit position, with -1 for windows that say little: all one level, or the
 * 1010 of a preamble. Lining frames up on these, a frame's long idle runs and training bits cannot outvote the few
 * dozen bits of a sync word that really fix where it sits.
 */
const WIN = 8;
function windows(bits: string): Int32Array {
  const n = Math.max(0, bits.length - WIN + 1), out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < WIN; k++) v = (v << 1) | (bits.charCodeAt(i + k) - 48);
    out[i] = v === 0 || v === 0xff || v === 0xaa || v === 0x55 ? -1 : v;
  }
  return out;
}

/**
 * How well `b` agrees with `a` when its first bit sits at column `s` of `a`: first the informative windows that
 * match, then the bits that agree less those that do not.
 */
function score(a: string, b: string, wa: Int32Array, wb: Int32Array, s: number): { v: number; overlap: number } {
  const i0 = Math.max(0, s), i1 = Math.min(a.length, s + b.length);
  let v = 0, w = 0;
  for (let i = i0; i < i1; i++) v += a.charCodeAt(i) === b.charCodeAt(i - s) ? 1 : -1;
  for (let i = i0; i < Math.min(wa.length, s + wb.length); i++) { const x = wa[i]; if (x >= 0 && x === wb[i - s]) w++; }
  return { v: w * 10_000 + v, overlap: Math.max(0, i1 - i0) };
}

/** The shift that lines `b` up best against `a`, within `maxShift`; they must overlap by half the shorter. */
export function bestShift(a: string, b: string, maxShift: number): number {
  const need = Math.ceil(Math.min(a.length, b.length) / 2);
  const wa = windows(a), wb = windows(b);
  let best = 0, bestV = -Infinity;
  for (let s = -maxShift; s <= maxShift; s++) {
    const { v, overlap } = score(a, b, wa, wb, s);
    if (overlap < need) continue;
    if (v > bestV || (v === bestV && Math.abs(s) < Math.abs(best))) { bestV = v; best = s; }
  }
  return best;
}

const hexOf = (bits: string) => { let o = ''; for (let i = 0; i < bits.length; i += 4) o += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16).toUpperCase(); return o; };

/**
 * The longest stretch that alternates (1010) or holds (1111) from `from`, by the consensus. The sync word starts at
 * the first bit that breaks the pattern (…10101 1101…: the Land Rover's D3 starts at the repeated 1).
 */
function trainingRun(c: string, from: number, to: number): number {
  let alt = from, same = from;
  for (let i = from + 1; i < to; i++) { if (c[i] === '?' || c[i] === c[i - 1]) break; alt = i; }
  for (let i = from + 1; i < to; i++) { if (c[i] === '?' || c[i] !== c[i - 1]) break; same = i; }
  return Math.max(alt, same) + 1 - from;
}

/** Line up the frames. The one of median length is the reference; the rest are slid against it up to `maxShift` bits either way. */
export function align(frames: string[], maxShift = 64): Alignment {
  const empty: Alignment = { rows: [], width: 0, state: new Uint8Array(0), consensus: '', preamble: null, sync: null, segments: [], fixedBits: 0, changingBits: 0 };
  if (!frames.length) return empty;
  // the reference is the frame of middling length: the longest may well be one with junk run on at either end
  const byLen = frames.map((f, i) => [f.length, i]).sort((x, y) => x[0] - y[0]);
  const ref = byLen[byLen.length >> 1][1];
  const a = frames[ref];
  const shifts = frames.map((b, i) => (i === ref ? 0 : bestShift(a, b, Math.min(maxShift, Math.max(a.length, b.length)))));
  const left = Math.min(...shifts);
  const rows: AlignedRow[] = frames.map((bits, index) => ({ index, shift: shifts[index] - left, bits }));
  const width = Math.max(...rows.map(r => r.shift + r.bits.length));
  const state = new Uint8Array(width);
  let consensus = '';
  let fixedBits = 0, changingBits = 0;
  for (let c = 0; c < width; c++) {
    let n0 = 0, n1 = 0;
    for (const r of rows) { const j = c - r.shift; if (j < 0 || j >= r.bits.length) continue; if (r.bits[j] === '1') n1++; else n0++; }
    const n = n0 + n1;
    state[c] = n < 2 ? 2 : n0 === 0 || n1 === 0 ? 1 : 0;
    if (state[c] === 1) fixedBits++; else if (state[c] === 0) changingBits++;
    consensus += n === 0 ? '?' : n1 > n0 ? '1' : '0';
  }
  // where at least two frames reach: the part worth reading
  let c0 = 0; while (c0 < width && state[c0] === 2) c0++;
  let c1 = width; while (c1 > c0 && state[c1 - 1] === 2) c1--;
  // the preamble: the longest training run that starts in the first third and is all fixed
  let preamble: [number, number] | null = null;
  for (let s = c0; s < c0 + Math.max(1, Math.floor((c1 - c0) / 3)); s++) {
    if (state[s] !== 1) continue;
    let len = trainingRun(consensus, s, c1);
    // a training run that runs into changing bits ends there
    let k = 0; while (k < len && state[s + k] === 1) k++;
    len = k;
    if (len >= 8 && (!preamble || len > preamble[1] - preamble[0])) preamble = [s, s + len];
  }
  // the sync word: the fixed run straight after the preamble (or the first fixed run of 8 or more)
  let sync: Alignment['sync'] = null;
  const start = preamble ? preamble[1] : c0;
  for (let s = start; s < c1; s++) {
    if (state[s] !== 1) { if (preamble) break; continue; }
    let e = s; while (e < c1 && state[e] === 1 && e - s < 32) e++;
    if (e - s >= 8) { const bits = consensus.slice(s, e); sync = { from: s, to: e, bits, hex: hexOf(bits) }; }
    break;
  }
  const segments: Segment[] = [];
  for (let c = start; c < c1;) {
    const fixed = state[c] === 1;
    let e = c; while (e < c1 && (state[e] === 1) === fixed) e++;
    segments.push({ from: c, to: e, fixed });
    c = e;
  }
  return { rows, width, state, consensus, preamble, sync, segments, fixedBits, changingBits };
}

/**
 * Which frames belong together: the ones read the same way (modulation, coding, a symbol within 15%) whose
 * lengths are within a quarter of the one picked.
 */
export function similar<T extends { mod: string; coding: string; symUs: number; bits: number }>(all: T[], pick: T): T[] {
  return all.filter(x => x.mod === pick.mod && x.coding === pick.coding && Math.abs(x.symUs - pick.symUs) <= pick.symUs * 0.15
    && Math.abs(x.bits - pick.bits) <= Math.max(8, pick.bits * 0.25));
}
