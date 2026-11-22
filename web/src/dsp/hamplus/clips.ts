/**
 * HAM+ time machine: every transmission's audio kept in memory as 8 kHz G.711 mu-law (8 kB a second of air), oldest
 * dropped first once the store passes its cap, and replays planned from it: one transmission, one conversation in
 * order, or the whole band from a moment on with overlapping transmissions mixed and long silences shortened.
 */

export const CLIP_RATE = 8_000;
/** The store's cap: 24 MB is about 50 minutes of air. */
export const CLIP_CAP_BYTES = 24 * 1024 * 1024;
/** A replay from a moment on shortens any silence longer than this to it. */
export const GAP_MAX_MS = 1_500;

/** G.711 mu-law (ITU-T G.711), input in [-1, 1]. */
export function muEncode(x: number): number {
  let s = Math.round(Math.max(-1, Math.min(1, x)) * 32_635);
  const sign = s < 0 ? 0x80 : 0; if (s < 0) s = -s;
  s += 0x84;
  let exp = 7; for (let m = 0x4000; (s & m) === 0 && exp > 0; m >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}
const MU_TABLE = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff, sign = u & 0x80, exp = (u >> 4) & 7, mant = u & 0x0f;
    const v = (((mant << 3) + 0x84) << exp) - 0x84;
    t[i] = (sign ? -v : v) / 32_635;
  }
  return t;
})();
export const muDecode = (b: number) => MU_TABLE[b & 0xff];

/** One transmission's audio as it grows. */
export class ClipWriter {
  private buf = new Uint8Array(CLIP_RATE * 4); len = 0;
  push(x: Float32Array, n: number): void {
    if (this.len + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + n)); b.set(this.buf.subarray(0, this.len)); this.buf = b; }
    for (let i = 0; i < n; i++) this.buf[this.len++] = muEncode(x[i]);
  }
  done(): Uint8Array { return this.buf.slice(0, this.len); }
}

export interface Clip { id: number; chan: number; startMs: number; data: Uint8Array }

export class ClipStore {
  private readonly clips = new Map<number, Clip>();
  bytes = 0;
  constructor(readonly cap = CLIP_CAP_BYTES) {}
  add(c: Clip): number[] {
    this.clips.set(c.id, c); this.bytes += c.data.length;
    const dropped: number[] = [];
    // Map keeps insertion order: the first ones are the oldest
    for (const [id, old] of this.clips) { if (this.bytes <= this.cap) break; this.clips.delete(id); this.bytes -= old.data.length; dropped.push(id); }
    return dropped;
  }
  get(id: number): Clip | undefined { return this.clips.get(id); }
  has(id: number): boolean { return this.clips.has(id); }
  get size(): number { return this.clips.size; }
  /** Seconds of audio held. */
  get seconds(): number { return this.bytes / CLIP_RATE; }
  oldestMs(): number { for (const c of this.clips.values()) return c.startMs; return 0; }
  all(): Clip[] { return [...this.clips.values()]; }
  clear(): void { this.clips.clear(); this.bytes = 0; }
}

/**
 * What a tap on the timeline at [ms] replays: every clip still on the air after that moment, or, when nothing was
 * heard after it, the band from the start of the last transmission before it. Empty only when nothing is kept.
 */
export function replayFromPlan(clips: { id: number; startMs: number; endMs: number }[], ms: number): { ids: number[]; fromMs: number } {
  if (!clips.length) return { ids: [], fromMs: ms };
  let from = ms;
  if (!clips.some(c => c.endMs > ms)) from = clips.reduce((a, c) => c.endMs > a.endMs ? c : a).startMs;
  return { ids: clips.filter(c => c.endMs > from).sort((a, b) => a.startMs - b.startMs).map(c => c.id), fromMs: from };
}

/** Where each clip of a replay starts, in samples from the replay's start. */
export interface ReplayPart { id: number; at: number }
/**
 * Plans a replay: clips in time order, each placed at its true time after the first, with every silence longer than
 * [GAP_MAX_MS] cut to it. Clips that overlapped on the air overlap in the replay (and are mixed).
 */
export function planReplay(clips: Clip[], gapMaxMs = GAP_MAX_MS): ReplayPart[] {
  const cs = [...clips].sort((a, b) => a.startMs - b.startMs);
  const out: ReplayPart[] = [];
  let shift = 0, endMs = -Infinity, t0 = cs.length ? cs[0].startMs : 0;
  for (const c of cs) {
    const gap = c.startMs - endMs;
    if (gap > gapMaxMs) shift += gap - gapMaxMs;
    if (!out.length) shift = 0;
    out.push({ id: c.id, at: Math.round((c.startMs - t0 - shift) * CLIP_RATE / 1000) });
    endMs = Math.max(endMs, c.startMs + c.data.length * 1000 / CLIP_RATE);
  }
  return out;
}

/** Mixes a planned replay into 8 kHz audio, a block at a time. */
export class ReplayMixer {
  pos = 0; readonly total: number;
  constructor(private readonly parts: { at: number; data: Uint8Array; id: number }[], private readonly gain = 1) {
    this.total = parts.reduce((m, p) => Math.max(m, p.at + p.data.length), 0);
  }
  get done(): boolean { return this.pos >= this.total; }
  /** The id of the clip playing at the replay's position (the latest started), or -1. */
  current(): number { let id = -1, at = -1; for (const p of this.parts) if (p.at <= this.pos && p.at + p.data.length > this.pos && p.at > at) { at = p.at; id = p.id; } return id; }
  private cnt = new Uint8Array(0);
  next(out: Float32Array, n: number): number {
    const k = Math.min(n, this.total - this.pos); if (k <= 0) return 0;
    out.fill(0, 0, k);
    if (this.cnt.length < k) this.cnt = new Uint8Array(k);
    const cnt = this.cnt; cnt.fill(0, 0, k);
    for (const p of this.parts) {
      const a = Math.max(this.pos, p.at), b = Math.min(this.pos + k, p.at + p.data.length);
      for (let t = a; t < b; t++) { out[t - this.pos] += muDecode(p.data[t - p.at]); cnt[t - this.pos]++; }
    }
    // overlapping voices are scaled by the square root of how many play at that moment
    for (let i = 0; i < k; i++) { const v = out[i] * this.gain / (cnt[i] > 1 ? Math.sqrt(cnt[i]) : 1); out[i] = v > 1 ? 1 : v < -1 ? -1 : v; }
    this.pos += k;
    return k;
  }
}
