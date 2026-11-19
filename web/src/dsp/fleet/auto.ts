/**
 * Dispatch AUTO: which window of which band the receiver listens to. No DOM, driven every half second by the app.
 *
 * Each window keeps a score of the clear voice heard there: seconds of clear audio plus two for each clear call with a
 * talkgroup, fading with a half-life of three minutes. Encrypted calls, calls with no talkgroup and calls with no audio
 * count for nothing, and so does a control channel by itself. Once a window has earned a score the receiver holds it,
 * steps away only for a short look at another window when nothing clear has played for a while, and comes straight
 * back. With no window scored it steps through them all, staying longer where a control channel decodes.
 */
export interface AutoCall { key: string; onAir: boolean; encrypted: boolean; tg: number; audioMs: number }
export interface AutoView {
  now: number; calls: AutoCall[]; playing: string;
  /** A control or rest channel decoding in the span right now. */
  controlLive: boolean;
  /** Systems known (heard this session or kept from earlier ones). */
  systems: number;
}
export const AUTO_HALF_LIFE_MS = 180_000;
/** A window holds the receiver once its score passes this (a few seconds of clear speech). */
export const AUTO_HOLD_SCORE = 3;
/** Nothing clear for this long on the held window, and a look elsewhere is allowed. */
export const AUTO_QUIET_MS = 15_000;
/** A look at another window lasts this long (longer while clear speech plays there). */
export const AUTO_LOOK_MS = 6_000;
/** Looks are this far apart: rarely once many systems are known. */
export const autoLookEvery = (systems: number) => systems >= 5 ? 300_000 : systems >= 2 ? 120_000 : 60_000;

export class FleetAuto {
  idx = 0;
  readonly score: Float64Array;
  /** 'scan' steps through every window, 'hold' stays on the best one, 'look' is a short visit away from it. */
  mode: 'scan' | 'hold' | 'look' = 'scan';
  /** When the current window's turn ends (scan) or the look ends. */
  until = 0;
  /** A control channel decoded on this scan window. */
  found = false;
  lastClear = 0; lastLook = 0;
  private lastMs = 0;
  private readonly seen = new Map<string, number>();
  private readonly counted = new Set<string>();
  private lookFrom = 0;
  constructor(readonly windows: number, now = 0, start = 0) {
    this.score = new Float64Array(windows); this.idx = start; this.until = now + 6_000; this.lastMs = now; this.lastLook = now;
  }
  /** The window that has earned the receiver, or -1. */
  best(): number {
    let b = -1, v = AUTO_HOLD_SCORE; for (let i = 0; i < this.windows; i++) if (this.score[i] >= v) { v = this.score[i]; b = i; }
    return b;
  }
  /** Something clear is being heard now. */
  clearPlaying(v: AutoView): boolean { return v.calls.some(c => c.key === v.playing && c.onAir && !c.encrypted); }
  /** The receiver was tuned to a window from outside (a band picked, a lock): AUTO starts over from it. */
  moved(idx: number, now: number): void { this.idx = idx; this.mode = 'scan'; this.until = now + 6_000; this.found = false; }
  /** One look at the state: the window to tune to, or null to stay. */
  step(v: AutoView): number | null {
    const now = v.now, dt = Math.max(0, now - this.lastMs); this.lastMs = now;
    if (dt > 0) { const k = Math.pow(0.5, dt / AUTO_HALF_LIFE_MS); for (let i = 0; i < this.windows; i++) this.score[i] *= k; }
    for (const c of v.calls) {
      if (c.encrypted || !c.tg || c.audioMs <= 0) continue;
      const was = this.seen.get(c.key) ?? 0;
      if (c.audioMs > was) { this.score[this.idx] += (c.audioMs - was) / 1000; this.seen.set(c.key, c.audioMs); }
      if (!this.counted.has(c.key)) { this.counted.add(c.key); this.score[this.idx] += 2; }
    }
    if (this.seen.size > 400) for (const k of [...this.seen.keys()].slice(0, 200)) this.seen.delete(k);
    if (this.counted.size > 400) for (const k of [...this.counted].slice(0, 200)) this.counted.delete(k);
    const clear = this.clearPlaying(v);
    if (clear) this.lastClear = now;
    if (this.windows < 2) return null;
    const best = this.best();
    const go = (i: number): number | null => { if (i === this.idx) return null; this.idx = i; return i; };
    if (this.mode === 'look') {
      if (clear) { this.until = Math.max(this.until, now + 1_000); return null; }
      if (now < this.until) return null;
      this.mode = 'hold'; this.lastLook = now;
      const b = this.best();
      return go(b >= 0 ? b : this.lookFrom);
    }
    if (best >= 0) {
      if (this.idx !== best) {
        // the call being heard finishes first
        if (clear) return null;
        this.mode = 'hold'; return go(best);
      }
      this.mode = 'hold';
      if (!clear && now - this.lastClear > AUTO_QUIET_MS && now - this.lastLook > autoLookEvery(v.systems)) {
        const others = [...Array(this.windows).keys()].filter(i => i !== best);
        // the windows looked at least lately first: the next one round the band list after the last look
        const next = others.find(i => i > (this.lookFrom === best ? this.lookIdx : -1)) ?? others[0];
        this.lookIdx = next; this.lookFrom = best; this.mode = 'look'; this.until = now + AUTO_LOOK_MS; this.found = false;
        return go(next);
      }
      return null;
    }
    // nothing earned yet: step through the windows, a control channel keeps one for 25 s, a clear call to its end
    this.mode = 'scan';
    if (v.controlLive && !this.found) { this.found = true; this.until = Math.max(this.until, now + 25_000); }
    if (clear) this.until = Math.max(this.until, now + 1_000);
    if (now < this.until) return null;
    this.found = false; this.until = now + 6_000;
    return go((this.idx + 1) % this.windows);
  }
  private lookIdx = -1;
}
