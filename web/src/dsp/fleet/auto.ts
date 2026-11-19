/**
 * Dispatch AUTO: which window of which band the receiver listens to. No DOM, driven every half second by the app.
 *
 * Each window keeps a score of the clear voice heard there: seconds of clear audio plus two for each clear call with a
 * talkgroup, over the seconds spent listening there (at least 20), both fading with a half-life of three minutes. So a
 * band is judged by how much clear voice it carries a minute, and a short look can show a busier one. Encrypted calls, calls with no talkgroup and calls with no audio
 * count for nothing, and so does a control channel by itself.
 *  - A fresh start surveys every window once (25 s where something decodes, 6 s where nothing does, a clear call heard
 *    to its end up to 40 s), with the scores held still, then holds the best window.
 *  - Scores are saved with the systems and come back decayed by their age: a reload with a known best window starts
 *    on it and skips the survey.
 *  - While holding, it steps away for a short look only when nothing clear has played for a while, and comes back.
 *    A window that has come to carry half again as much clear voice a minute as the held one takes over.
 *  - With no window scored after the survey it keeps stepping through them all.
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
/** Survey dwell: where nothing decodes, where something does, and the most a clear call can keep it. */
export const AUTO_SURVEY_MS = [6_000, 25_000, 40_000] as const;
/** A window takes over the held one when its score is this many times the held score. */
export const AUTO_SWITCH = 1.5;
/** Saved scores: what [FleetAuto.save] gives and the constructor takes back. */
export interface AutoSaved { scores: number[]; listen?: number[]; ms: number }
/** Listening time a window's density is taken over, at the least (seconds): a short look cannot look too good. */
export const AUTO_MIN_LISTEN_S = 20;
export const autoLookEvery = (systems: number) => systems >= 5 ? 300_000 : systems >= 2 ? 120_000 : 60_000;

export class FleetAuto {
  idx = 0;
  /** Clear voice heard on each window (decayed seconds), and seconds spent listening there (decayed the same way). */
  readonly score: Float64Array; readonly listen: Float64Array;
  /** 'survey' visits every window once, 'scan' steps through them, 'hold' stays on the best, 'look' is a short visit away. */
  mode: 'survey' | 'scan' | 'hold' | 'look' = 'survey';
  /** When the current window's turn ends (survey, scan) or the look ends. */
  until = 0;
  /** A control channel decoded, or clear voice was heard, on this window during its turn. */
  found = false;
  /** The window held, or -1. */
  held = -1;
  lastClear = 0; lastLook = 0;
  private lastMs = 0; private enter = 0; private lookIdx = -1;
  private readonly surveyed = new Set<number>();
  private readonly seen = new Map<string, number>();
  private readonly counted = new Set<string>();
  constructor(readonly windows: number, now = 0, start = 0, saved: AutoSaved | null = null) {
    this.score = new Float64Array(windows); this.listen = new Float64Array(windows); this.idx = start; this.enter = now; this.until = now + AUTO_SURVEY_MS[0]; this.lastMs = now; this.lastLook = now;
    if (saved && Array.isArray(saved.scores) && saved.scores.length === windows) {
      const k = Math.pow(0.5, Math.max(0, now - saved.ms) / AUTO_HALF_LIFE_MS);
      for (let i = 0; i < windows; i++) { this.score[i] = (Number(saved.scores[i]) || 0) * k; this.listen[i] = (Number(saved.listen?.[i]) || AUTO_MIN_LISTEN_S) * k; }
      const b = this.best();
      if (b >= 0) { this.mode = 'hold'; this.held = b; this.idx = b; }
    }
    if (windows < 2) this.mode = 'hold';
  }
  /** The scores to keep with the systems. */
  save(now: number): AutoSaved { const r = (x: number) => Math.round(x * 100) / 100; return { scores: [...this.score].map(r), listen: [...this.listen].map(r), ms: now }; }
  /** Clear voice a second of listening on a window. */
  density(i: number): number { return this.score[i] / Math.max(this.listen[i], AUTO_MIN_LISTEN_S); }
  /** The window with the most clear voice a minute among those that have earned the receiver, or -1. */
  best(): number {
    let b = -1, v = -1; for (let i = 0; i < this.windows; i++) if (this.score[i] >= AUTO_HOLD_SCORE && this.density(i) > v) { v = this.density(i); b = i; }
    return b;
  }
  /** The window to hold: the one held, unless another has come to score [AUTO_SWITCH] times as much. */
  private choose(): number {
    const b = this.best();
    if (this.held < 0 || this.score[this.held] < AUTO_HOLD_SCORE) return b;
    return b >= 0 && b !== this.held && this.density(b) >= AUTO_SWITCH * this.density(this.held) ? b : this.held;
  }
  /** Something clear is being heard now. */
  clearPlaying(v: AutoView): boolean { return v.calls.some(c => c.key === v.playing && c.onAir && !c.encrypted); }
  /** The receiver was tuned to a window from outside (a band picked, a lock, a visit back): AUTO goes on from it. */
  moved(idx: number, now: number): void {
    this.idx = idx; this.enter = now; this.found = false; this.until = now + AUTO_SURVEY_MS[0];
    if (this.mode === 'look' || this.mode === 'scan') this.mode = this.held >= 0 ? 'hold' : 'scan';
  }
  /** One look at the state: the window to tune to, or null to stay. */
  step(v: AutoView): number | null {
    const now = v.now, dt = Math.max(0, now - this.lastMs); this.lastMs = now;
    // the survey compares windows heard one after another: their scores stand still until it is done
    if (dt > 0 && this.mode !== 'survey') { const k = Math.pow(0.5, dt / AUTO_HALF_LIFE_MS); for (let i = 0; i < this.windows; i++) { this.score[i] *= k; this.listen[i] *= k; } }
    this.listen[this.idx] += dt / 1000;
    let gained = false;
    for (const c of v.calls) {
      if (c.encrypted || !c.tg || c.audioMs <= 0) continue;
      const was = this.seen.get(c.key) ?? 0;
      if (c.audioMs > was) { this.score[this.idx] += (c.audioMs - was) / 1000; this.seen.set(c.key, c.audioMs); gained = true; }
      if (!this.counted.has(c.key)) { this.counted.add(c.key); this.score[this.idx] += 2; }
    }
    if (this.seen.size > 400) for (const k of [...this.seen.keys()].slice(0, 200)) this.seen.delete(k);
    if (this.counted.size > 400) for (const k of [...this.counted].slice(0, 200)) this.counted.delete(k);
    const clear = this.clearPlaying(v);
    if (clear) this.lastClear = now;
    if (this.windows < 2) return null;
    const go = (i: number): number | null => { this.enter = now; this.found = false; if (i === this.idx) return null; this.idx = i; return i; };
    if (this.mode === 'survey') {
      if ((v.controlLive || gained) && !this.found) { this.found = true; this.until = Math.max(this.until, this.enter + AUTO_SURVEY_MS[1]); }
      if (clear) this.until = Math.min(Math.max(this.until, now + 1_000), this.enter + AUTO_SURVEY_MS[2]);
      if (now < this.until) return null;
      this.surveyed.add(this.idx);
      const next = [...Array(this.windows).keys()].map(k => (this.idx + 1 + k) % this.windows).find(i => !this.surveyed.has(i));
      if (next !== undefined) { this.until = now + AUTO_SURVEY_MS[0]; return go(next); }
      this.lastLook = now;
      this.held = this.best();
      if (this.held >= 0) { this.mode = 'hold'; return go(this.held); }
      this.mode = 'scan'; this.until = now + AUTO_SURVEY_MS[0];
      return go((this.idx + 1) % this.windows);
    }
    if (this.mode === 'look') {
      if (clear) { this.until = Math.max(this.until, now + 1_000); return null; }
      if (now < this.until) return null;
      this.mode = 'hold'; this.lastLook = now;
      const b = this.choose(); if (b >= 0) this.held = b;
      return this.held >= 0 ? go(this.held) : null;
    }
    const want = this.choose();
    if (want >= 0) {
      this.mode = 'hold';
      if (this.idx !== want) {
        // the call being heard finishes first
        if (clear) return null;
        this.held = want; return go(want);
      }
      this.held = want;
      if (!clear && now - this.lastClear > AUTO_QUIET_MS && now - this.lastLook > autoLookEvery(v.systems)) {
        const others = [...Array(this.windows).keys()].filter(i => i !== want);
        // round the band list, one window a look
        const next = others.find(i => i > this.lookIdx) ?? others[0];
        this.lookIdx = next; this.mode = 'look'; this.until = now + AUTO_LOOK_MS;
        return go(next);
      }
      return null;
    }
    // nothing earned: step through the windows, a control channel keeps one for 25 s, a clear call to its end
    this.mode = 'scan';
    if (v.controlLive && !this.found) { this.found = true; this.until = Math.max(this.until, now + 25_000); }
    if (clear) this.until = Math.max(this.until, now + 1_000);
    if (now < this.until) return null;
    this.until = now + AUTO_SURVEY_MS[0];
    return go((this.idx + 1) % this.windows);
  }
}
