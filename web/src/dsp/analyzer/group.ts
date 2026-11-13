/**
 * Bursts into transmissions: one press of a key is many bursts.
 *
 * A key sends each press several times, often on several frequencies (the Land Rover sends 6 frames on 3 channels
 * for one press), and the front end captures each as its own burst. Here bursts that follow each other closely
 * (each starting within `gapS` of the last one's end) and belong together become one transmission: the same
 * Devices decoder reading with the same identity, or the same frame (near enough bit for bit). Twin of
 * core/analyzer/Group.kt and Group.swift.
 */

import { bestShift } from './align.js';

/** What grouping needs to know of a burst. */
export interface GroupIn {
  id: number;
  /** Start, seconds (radio or file time), and length, seconds. */
  t: number;
  dur: number;
  /** Absolute frequency, Hz (or the offset, if the center is unknown). */
  hz: number;
  /** The Devices decoders' readings ("car key: Land Rover FSK A824"). */
  matches: string[];
  /** The burst's longest frame. */
  bits: string;
  /** The file it came from; bursts from different files (or a file and the air) never group. */
  src?: string;
}

export interface Transmission {
  /** The first burst's id: the transmission's own. */
  id: number;
  ids: number[];
  /** What it is: the decoder's reading when one claimed it, else empty. */
  label: string;
  /** The channels it was sent on, Hz, low to high: the mean of each cluster of frequencies within 30 kHz. */
  freqs: number[];
  t: number;
  end: number;
}

/** Two frames are the same when, lined up, at least 90% of the overlap agrees and the overlap is most of the shorter. */
export function sameFrame(a: string, b: string): boolean {
  if (a.length < 16 || b.length < 16) return false;
  const s = bestShift(a, b, 16);
  const i0 = Math.max(0, s), i1 = Math.min(a.length, s + b.length);
  if (i1 - i0 < Math.min(a.length, b.length) * 0.8) return false;
  let agree = 0;
  for (let i = i0; i < i1; i++) if (a[i] === b[i - s]) agree++;
  return agree >= (i1 - i0) * 0.9;
}

/**
 * Whether a frame carries data: it changes at least every 16 bits on average, and is not one short pattern over and
 * over (a wake-up preamble: 1010…, 1100…), which repeats with a period of 8 bits or less across 90% of it.
 */
export function informative(bits: string): boolean {
  let t = 0; for (let i = 1; i < bits.length; i++) if (bits[i] !== bits[i - 1]) t++;
  if (t < Math.max(2, bits.length / 16)) return false;
  for (let p = 1; p <= 8 && p < bits.length; p++) {
    let same = 0; for (let i = p; i < bits.length; i++) if (bits[i] === bits[i - p]) same++;
    if (same >= 0.9 * (bits.length - p)) return false;
  }
  return true;
}

/**
 * A decoder's reading without the ID or code at its end ("car key: Land Rover FSK 80E32F" → "car key: Land Rover
 * FSK"): copies of one press go together even when a decoder reads one of them a bit differently.
 */
export const protocolOf = (label: string) => label.replace(/\s+\S*\d\S*$/, '');

/** Group bursts (any order) into transmissions, in time order. */
export function groupPresses(bursts: GroupIn[], gapS = 0.5): Transmission[] {
  const sorted = [...bursts].sort((x, y) => x.t - y.t || x.id - y.id);
  const out: (Transmission & { members: GroupIn[] })[] = [];
  for (const b of sorted) {
    let joined = false;
    // newest groups first: a burst belongs with the transmission it follows on from
    for (let g = out.length - 1; g >= 0 && !joined; g--) {
      const tx = out[g];
      if (b.t - tx.end > gapS || (tx.members[0].src ?? '') !== (b.src ?? '')) { if (g < out.length - 4) break; continue; }
      const byDecoder = b.matches.length > 0 && b.matches.some(m => tx.members.some(x => x.matches.some(y => protocolOf(y) === protocolOf(m))));
      const unclaimed = !b.matches.length || tx.members.every(x => !x.matches.length);
      const byFrame = unclaimed && b.bits.length > 0 && tx.members.some(x => sameFrame(x.bits, b.bits));
      // a wake-up preamble with no decoder's name on it carries no identity: it goes with the press it is heard in
      const blank = (x: GroupIn) => !x.matches.length && !informative(x.bits);
      const preamble = blank(b) || tx.members.every(blank);
      if (byDecoder || byFrame || preamble) {
        tx.members.push(b); tx.ids.push(b.id);
        tx.end = Math.max(tx.end, b.t + b.dur);
        if (!tx.label && b.matches.length) tx.label = b.matches[0];
        joined = true;
      }
    }
    if (!joined) out.push({ id: b.id, ids: [b.id], label: b.matches[0] ?? '', freqs: [], t: b.t, end: b.t + b.dur, members: [b] });
  }
  return out.map(({ members, ...tx }) => {
    // named by what most of its frames say: one frame's stale or misread label does not name the press
    const votes = new Map<string, number>();
    for (const m of members) for (const l of m.matches.slice(0, 1)) votes.set(l, (votes.get(l) ?? 0) + 1);
    if (votes.size) tx.label = [...votes].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    // a channel is everything heard within 30 kHz (an FSK key's bare carrier sits a tone away from its data)
    const fs = members.map(m => m.hz).sort((x, y) => x - y), groups: number[][] = [];
    for (const f of fs) { const g = groups[groups.length - 1]; if (g && f - g[g.length - 1] <= 30_000) g.push(f); else groups.push([f]); }
    return { ...tx, freqs: groups.map(g => g.reduce((a, b) => a + b, 0) / g.length) };
  });
}
