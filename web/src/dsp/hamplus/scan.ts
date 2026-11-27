/**
 * HAM+ scan around [FleetAuto]: AUTO and SCAN respect what is on the air.
 *  - Never a retune while a channel in the window is on the air: a transmission and its recording run to their end.
 *  - After the last transmission in the window ends it stays a hang time, so the next reply is caught. The hang is
 *    learned per window from the gaps between keyups on the same channel (twice the median gap, 8 to 45 s), 15 s until
 *    there are three gaps. Every keyup starts it again.
 *  - Past the hang, while the conversation is recent, it looks around: a short look at another window, and straight
 *    back to the conversation's window when that one is quiet, then a hang there again before the next look.
 *  - When the conversation is long over, AUTO and SCAN go on as they always did.
 *  - A followed channel pins its window outright (tuned there first when it is elsewhere), with no looks. Unfollowing
 *    goes back to the window the scan was on and the scan carries on from there as it was.
 *  - SCAN ON ([skip]) leaves a busy window at once; that window waits [HP_SKIP_MS] before AUTO comes back to it,
 *    unless a followed or priority channel is in it.
 *  - BIZ ([capMs]): a window holds the scan at most [capMs] at a time while some window has not been visited this round,
 *    so a band always busy somewhere (an 8 MHz VHF business window) never keeps the rest from being heard. The window
 *    moved to is held at least [HP_VISIT_MS]; once every window is visited a new round begins. A followed channel is
 *    never cut short.
 * Data channels (APRS) and muted channels hold nothing.
 */
import { AUTO_SURVEY_MS, type AutoView, type FleetAuto } from '../fleet/auto.js';
import { HP_RASTER, planInfo } from './plan.js';

/** The hang before there is data, its bounds, and gaps longer than this are not one conversation. */
export const HP_HANG_MS = 15_000, HP_HANG_MIN_MS = 8_000, HP_HANG_MAX_MS = 45_000, HP_GAP_MAX_MS = 60_000;
/** How long after its last transmission a conversation is still waited for, between looks. */
export const HP_CONVO_MS = 90_000;
/** A look at another window while a conversation is waited for. */
export const HP_LOOK_MS = 5_000;
/** A window left with SCAN ON is not come back to for this long. */
export const HP_SKIP_MS = 120_000;
/** BIZ: the most a window holds the scan while others wait their turn, and the least a window moved to is held. */
export const HP_CAP_MS = 60_000, HP_VISIT_MS = 6_000;

/** One transmission as the scan sees it: the snapshot's rows. */
export interface HpAct { id: number; hz: number; startMs: number; endMs: number; live: boolean }
export interface HpScanPrefs { hold: string; mute: string[]; prio: string[] }
/** What the scan is doing beyond AUTO itself: '' (AUTO's own), following, a channel on the air, the hang, waiting at the conversation's window between looks, a look away. */
export type HpPhase = '' | 'follow' | 'live' | 'hang' | 'home' | 'look' | 'visit';

/** Whether the window centered on [center] hears [hz] with [rate] samples a second: inside 0.44 of the rate less a channel, clear of the center's DC spike. */
export function hpWindowHears(center: number, rate: number, hz: number): boolean {
  const d = Math.abs(hz - center);
  return d <= rate * 0.44 - 6_250 - HP_RASTER && d >= 6_000 + HP_RASTER;
}

/** The window of [centers] (Hz) that hears [hz]: [cur] when it does, else the nearest that does, else -1. */
export function hpWindowOf(centers: number[], rate: number, hz: number, cur: number): number {
  if (!(hz > 0)) return -1;
  if (cur >= 0 && cur < centers.length && hpWindowHears(centers[cur], rate, hz)) return cur;
  let best = -1, bd = Infinity;
  for (let i = 0; i < centers.length; i++) if (hpWindowHears(centers[i], rate, hz)) { const d = Math.abs(hz - centers[i]); if (d < bd) { bd = d; best = i; } }
  return best;
}

const chanOf = (hz: number) => Math.round(hz / 5_000);
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export class HpScan {
  /** The followed frequency the scan is paused for, or 0. */
  follow = 0;
  phase: HpPhase = '';
  /** The channel the phase is about (the followed one, the one on the air, the conversation's). */
  hz = 0;
  /** When the phase's wait ends (the hang, the wait between looks, the look), 0 when it has none. */
  until = 0;
  private home = -1; private homeHz = 0; private homeUntil = 0; private waitUntil = 0; private lookUntil = 0; private lookIdx = -1; private scanUntil = 0;
  /** Which window each transmission was heard on (-1: none that counts), the ones whose end is counted, each window's channels' last ends and gaps, the windows left with SCAN ON. */
  private readonly win = new Map<number, number>();
  private readonly ended = new Set<number>();
  private readonly lastEnd = new Map<number, Map<number, number>>();
  private readonly gaps = new Map<number, number[]>();
  private readonly cool = new Map<number, number>();
  /** The channels busy on a window left with SCAN ON, and until when they hold nothing (a neighbor window hears them too). */
  private skipped: { hz: number; until: number }[] = [];
  /** 0: no cap (the ham bands). Else the most one window holds the scan while others wait their turn. */
  capMs = 0;
  /** The windows visited this round, the band they belong to, the window tuned and since when, and the visit's end. */
  private readonly visited = new Set<number>();
  private sig = ''; private atIdx = -1; private atMs = 0; private visitUntil = 0;

  /** The window's hang: twice the median gap between keyups heard there, 8 to 45 s; 15 s until three gaps are known. */
  hang(w: number): number {
    const g = this.gaps.get(w);
    return g && g.length >= 3 ? Math.min(HP_HANG_MAX_MS, Math.max(HP_HANG_MIN_MS, 2 * median(g))) : HP_HANG_MS;
  }
  /** The scan is staying for traffic, so SCAN ON can move it on. */
  get busy(): boolean { return this.phase === 'live' || this.phase === 'hang' || this.phase === 'home'; }
  cooled(w: number, now: number): boolean { return (this.cool.get(w) ?? 0) > now; }

  /** Each new transmission is put on the window tuned, and each keyup's gap since the last end on its channel is learned. */
  private learn(rows: HpAct[], centers: number[], rate: number, idx: number, p: HpScanPrefs): void {
    const quiet = (r: HpAct) => planInfo(r.hz).use === 'data' || p.mute.some(k => Math.abs(Number(k) - r.hz) < 1_250) || this.skipped.some(x => r.startMs < x.until && Math.abs(x.hz - r.hz) <= 2_500);
    const fresh = rows.filter(r => !this.win.has(r.id) || (!r.live && !this.ended.has(r.id))).sort((a, b) => a.startMs - b.startMs);
    for (const r of fresh) {
      if (!this.win.has(r.id)) {
        if (idx < 0 || idx >= centers.length || !hpWindowHears(centers[idx], rate, r.hz) || quiet(r)) { this.win.set(r.id, -1); this.ended.add(r.id); continue; }
        this.win.set(r.id, idx);
        const le = this.lastEnd.get(idx)?.get(chanOf(r.hz));
        if (le !== undefined && r.startMs > le && r.startMs - le < HP_GAP_MAX_MS) {
          const g = this.gaps.get(idx) ?? []; g.push(r.startMs - le); if (g.length > 20) g.shift(); this.gaps.set(idx, g);
        }
      }
      const w = this.win.get(r.id)!;
      if (!r.live && !this.ended.has(r.id)) {
        this.ended.add(r.id);
        if (w >= 0) { const m = this.lastEnd.get(w) ?? new Map<number, number>(); m.set(chanOf(r.hz), Math.max(m.get(chanOf(r.hz)) ?? 0, r.endMs)); this.lastEnd.set(w, m); }
      }
    }
    if (this.win.size > 3_000) for (const k of [...this.win.keys()].slice(0, 1_000)) { this.win.delete(k); this.ended.delete(k); }
  }

  /** The next window after [from] that is not [skip] and not waiting out SCAN ON, or -1. */
  private next(n: number, from: number, skip: number, now: number): number {
    for (let k = 1; k <= n; k++) { const i = (from + k) % n; if (i !== skip && !this.cooled(i, now)) return i; }
    return -1;
  }

  /**
   * One look every half second: the window to tune to, or null to stay. [rows] are the snapshot's transmissions,
   * [idx] the window tuned, [p] the channel preferences (hold is the followed channel's key, '' for ALL).
   */
  step(auto: FleetAuto, v: AutoView, rows: HpAct[], centers: number[], rate: number, idx: number, p: HpScanPrefs): number | null {
    const now = v.now, n = centers.length;
    const sig = centers.join(',');
    if (sig !== this.sig) { this.sig = sig; this.visited.clear(); this.atIdx = -1; this.visitUntil = 0; }
    if (idx !== this.atIdx) { this.atIdx = idx; this.atMs = now; }
    this.visited.add(idx);
    this.learn(rows, centers, rate, idx, p);
    const fhz = p.hold ? Number(p.hold) : 0, fw = fhz ? hpWindowOf(centers, rate, fhz, idx) : -1;
    if (fw >= 0) { this.follow = fhz; this.phase = 'follow'; this.hz = fhz; this.until = 0; this.home = -1; auto.pause(v); return fw !== idx ? fw : null; }
    if (this.follow) {
      // the follow ended: back to the window the scan was on, where it goes on as it was
      this.follow = 0; this.phase = ''; this.hz = 0; auto.pause(v);
      if (auto.idx !== idx && auto.idx >= 0 && auto.idx < n) return auto.idx;
    }
    if (n < 2) { this.phase = ''; return auto.step(v); }
    if (this.capMs > 0 && now - this.atMs >= this.capMs) {
      const nx = this.unvisited(n, idx, now);
      if (nx >= 0) {
        this.home = -1; this.lookUntil = 0; this.waitUntil = 0; this.hz = 0;
        this.visitUntil = now + HP_VISIT_MS; this.phase = 'visit'; this.until = this.visitUntil;
        auto.moved(nx, now); return nx;
      }
    }
    const here = rows.filter(r => this.win.get(r.id) === idx);
    // the channel named is the one being heard, else the newest to key up
    const live = here.find(r => r.live && String(r.id) === v.playing) ?? here.filter(r => r.live).sort((a, b) => b.startMs - a.startMs)[0];
    if (live) {
      this.phase = 'live'; this.hz = live.hz; this.until = 0;
      this.home = idx; this.homeHz = live.hz; this.homeUntil = now + HP_CONVO_MS; this.waitUntil = 0; this.lookUntil = 0;
      auto.stay(v); return null;
    }
    if (now < this.visitUntil) { this.phase = 'visit'; this.hz = 0; this.until = this.visitUntil; auto.stay(v); return null; }
    this.visitUntil = 0;
    const last = here.reduce<HpAct | null>((m, r) => !m || r.endMs > m.endMs ? r : m, null);
    if (last && now - last.endMs < this.hang(idx)) {
      this.phase = 'hang'; this.hz = last.hz; this.until = last.endMs + this.hang(idx);
      this.home = idx; this.homeHz = last.hz; this.homeUntil = last.endMs + HP_CONVO_MS; this.waitUntil = 0; this.lookUntil = 0;
      auto.stay(v); return null;
    }
    if (this.home >= 0 && this.home < n && now < this.homeUntil && !this.cooled(this.home, now)) {
      const looking = this.lookUntil > 0 && now < this.lookUntil;
      if (idx !== this.home && !looking) {
        // a look found nothing: straight back to the conversation, and a hang there before the next look
        this.lookUntil = 0; this.waitUntil = now + this.hang(this.home);
        this.phase = 'home'; this.hz = this.homeHz; this.until = this.waitUntil;
        auto.moved(this.home, now); return this.home;
      }
      if (idx !== this.home) { this.phase = 'look'; this.until = this.lookUntil; auto.stay(v); return null; }
      if (this.waitUntil && now < this.waitUntil) { this.phase = 'home'; this.hz = this.homeHz; this.until = this.waitUntil; auto.stay(v); return null; }
      const nx = this.next(n, this.lookIdx >= 0 ? this.lookIdx : idx, idx, now);
      if (nx >= 0) {
        this.lookIdx = nx; this.lookUntil = now + HP_LOOK_MS; this.waitUntil = 0;
        this.phase = 'look'; this.until = this.lookUntil;
        auto.moved(nx, now); return nx;
      }
    }
    this.home = -1; this.lookUntil = 0; this.waitUntil = 0; this.phase = ''; this.hz = 0; this.until = 0;
    let to = auto.step(v);
    if (to !== null && this.cooled(to, now)) {
      // a window left with SCAN ON waits out its time: the scan steps past it, a window a dwell
      to = null;
      if (now >= this.scanUntil) { const nx = this.next(n, idx, idx, now); if (nx >= 0) { to = nx; this.scanUntil = now + AUTO_SURVEY_MS[0]; } }
      auto.moved(to ?? idx, now);
    }
    return to;
  }

  /** The next window after [from] not visited this round and not waiting out SCAN ON; a new round when all are. */
  private unvisited(n: number, from: number, now: number): number {
    for (let round = 0; round < 2; round++) {
      for (let k = 1; k < n; k++) { const i = (from + k) % n; if (!this.visited.has(i) && !this.cooled(i, now)) return i; }
      this.visited.clear(); this.visited.add(from);
    }
    return -1;
  }

  /**
   * SCAN ON: off the busy window at once, to the next one. The window left waits [HP_SKIP_MS] before AUTO comes
   * back to it, unless a channel in [keep] (the followed and priority ones) is in it. A transmission open on it ends at
   * the retune and is kept like any other.
   */
  skip(auto: FleetAuto, now: number, centers: number[], rate: number, idx: number, keep: string[]): number | null {
    const n = centers.length;
    if (n < 2 || idx < 0 || idx >= n) return null;
    if (!keep.some(k => Number(k) > 0 && hpWindowHears(centers[idx], rate, Number(k)))) {
      this.cool.set(idx, now + HP_SKIP_MS);
      // what kept it busy keeps no neighbor window busy either
      this.skipped = this.skipped.filter(x => x.until > now);
      const recent = [...(this.lastEnd.get(idx) ?? new Map<number, number>())].filter(([, e]) => now - e < HP_CONVO_MS).map(([c]) => c * 5_000);
      for (const hz of [this.hz, ...recent]) if (hz > 0) this.skipped.push({ hz, until: now + HP_SKIP_MS });
    }
    this.home = -1; this.lookUntil = 0; this.waitUntil = 0; this.phase = ''; this.hz = 0; this.until = 0;
    const nx = this.next(n, idx, idx, now);
    if (nx < 0) return null;
    this.scanUntil = now + AUTO_SURVEY_MS[0];
    auto.moved(nx, now);
    return nx;
  }
}
