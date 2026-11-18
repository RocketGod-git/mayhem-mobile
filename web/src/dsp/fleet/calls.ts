/**
 * Dispatch calls: every voice grant and every voice transmission heard becomes a call that is on the air until its
 * channel says it ended (a P25 terminator, a DMR terminator) or goes quiet. Talkgroup preferences (mute, hold,
 * priority) pick what the receiver follows. Audio, where a vocoder is registered, is kept per call for replay. No DOM.
 */
import { makeCodec, type CodecId, type VoiceCodec } from './codec.js';

export interface CallRow {
  key: string; sys: string; proto: 'P25' | 'DMR'; tg: number; group: boolean; src: number; srcs: number[]; hz: number; slot: number; tdma: boolean;
  encrypted: boolean; emergency: boolean; startMs: number; lastMs: number; endMs: number; onAir: boolean;
  /** Voice heard on the channel itself (P25 voice frames, DMR voice bursts), in ms of speech. */
  voiceMs: number; frames: number; levelDb: number; peakDb: number; site: string; codec: CodecId;
  /** How the call ended: 'terminator', 'quiet', 'grant ended', or '' while on the air. */
  end: string; muted: boolean; prio: boolean; audioMs: number; lcVerified: boolean; granted: boolean;
  /** 'id' rows are CW IDs keyed on a channel; a call's own [cwId] is the ID its channel keyed right after it. */
  kind: 'call' | 'id'; cwId: string;
}
interface Call extends CallRow { grantMs: number; voiceAt: number; pcm: Float32Array[]; pcmN: number; codecInst: VoiceCodec | null }

export interface TgPrefs { mute: string[]; hold: string; prio: string[] }
export const AUDIO_CAP_S = 120;
const CALLS_KEPT = 200, AUDIO_CALLS = 30;
const QUIET_HEARD_MS = 1_200, QUIET_GRANT_MS = 3_000, TRAIL_MS = 2_000, ID_AFTER_MS = 15_000;

const gridKey = (hz: number) => Math.round(hz / 6250) * 6250;

export class CallTracker {
  readonly calls: Call[] = [];
  prefs: TgPrefs = { mute: [], hold: '', prio: [] };
  /** Live audio out, 8 kHz: set while the listener wants to hear the followed call. */
  onAudio: ((pcm: Float32Array, call: CallRow) => void) | null = null;
  constructor(private readonly now: () => number) {}

  tgKey = (c: { sys: string; tg: number; group: boolean; src?: number }) => c.group ? `${c.sys}/${c.tg}` : `${c.sys}/u${c.tg}`;
  muted(c: CallRow): boolean { return this.prefs.mute.includes(this.tgKey(c)) || (!!this.prefs.hold && this.prefs.hold !== this.tgKey(c)); }

  private find(sys: string, hz: number, slot: number, onAir = true): Call | undefined {
    const k = gridKey(hz);
    return this.calls.find(c => c.kind === 'call' && (!onAir || c.onAir) && (!sys || !c.sys || c.sys === sys) && c.hz > 0 && gridKey(c.hz) === k && c.slot === slot);
  }
  private create(p: Partial<CallRow> & { sys: string; proto: 'P25' | 'DMR'; hz: number; slot: number; codec: CodecId }, now: number): Call {
    const c: Call = {
      key: `${p.sys}|${now}|${p.hz}|${p.slot}`, sys: p.sys, proto: p.proto, tg: p.tg ?? 0, group: p.group ?? true, src: p.src ?? 0, srcs: p.src ? [p.src] : [], hz: p.hz, slot: p.slot,
      tdma: p.tdma ?? false, encrypted: p.encrypted ?? false, emergency: p.emergency ?? false, startMs: now, lastMs: now, endMs: 0, onAir: true, voiceMs: 0, frames: 0,
      levelDb: 0, peakDb: 0, site: p.site ?? '', codec: p.codec, end: '', muted: false, prio: false, audioMs: 0, lcVerified: false, granted: false, kind: 'call', cwId: '',
      grantMs: 0, voiceAt: 0, pcm: [], pcmN: 0, codecInst: null,
    };
    c.muted = this.muted(c); c.prio = this.prefs.prio.includes(this.tgKey(c));
    this.calls.unshift(c);
    this.trim();
    return c;
  }
  private trim(): void {
    let ended = 0;
    for (let i = 0; i < this.calls.length; i++) if (!this.calls[i].onAir && ++ended > CALLS_KEPT) { this.calls.splice(i, 1); i--; }
    let withAudio = 0;
    for (const c of this.calls) if (c.pcmN && ++withAudio > AUDIO_CALLS) { c.pcm = []; c.pcmN = 0; }
  }

  /** A voice grant (or grant update) on the control channel. */
  grant(g: { sys: string; proto: 'P25' | 'DMR'; tg: number; group: boolean; src: number; hz: number; slot: number; tdma: boolean; encrypted: boolean; emergency: boolean; site: string }, now = this.now()): Call | null {
    if (!g.tg && !g.hz) return null;
    let c = this.calls.find(x => x.kind === 'call' && x.onAir && x.sys === g.sys && x.tg === g.tg && x.group === g.group && (!x.hz || !g.hz || gridKey(x.hz) === gridKey(g.hz)) && x.slot === g.slot);
    if (!c && g.hz) {
      // voice that arrived before its grant (or a grant for a channel already carrying an unlabeled call)
      const v = this.find(g.sys, g.hz, g.slot);
      if (v && !v.tg) c = v;
    }
    // grant updates trail a call for a moment after its terminator: they do not open it again
    if (!c && this.calls.some(x => x.kind === 'call' && !x.onAir && x.end === 'terminator' && now - x.endMs < TRAIL_MS && x.sys === g.sys && x.tg === g.tg && (!g.hz || !x.hz || gridKey(x.hz) === gridKey(g.hz)))) return null;
    const codec: CodecId = g.proto === 'P25' && !g.tdma ? 'imbe' : 'ambe2';
    if (!c) c = this.create({ ...g, codec }, now);
    c.tg = g.tg || c.tg; c.group = g.group; c.sys = g.sys || c.sys; if (g.hz) c.hz = g.hz; c.tdma = g.tdma; c.codec = codec;
    if (g.src) this.addSrc(c, g.src);
    c.encrypted = c.encrypted || g.encrypted; c.emergency = c.emergency || g.emergency; c.site = g.site || c.site;
    c.grantMs = now; c.lastMs = now; c.granted = true;
    c.muted = this.muted(c); c.prio = this.prefs.prio.includes(this.tgKey(c));
    return c;
  }
  private addSrc(c: Call, src: number): void { c.src = src; if (!c.srcs.includes(src)) { c.srcs.push(src); if (c.srcs.length > 12) c.srcs.shift(); } }

  /** Voice on a channel: a P25 voice frame (180 ms of speech) or a DMR voice burst (60 ms). */
  voice(sys: string, proto: 'P25' | 'DMR', hz: number, slot: number, ms: number, now = this.now()): Call {
    let c = this.find(sys, hz, slot);
    if (!c) c = this.create({ sys, proto, hz, slot, codec: proto === 'P25' ? 'imbe' : 'ambe2' }, now);
    c.frames++; c.voiceMs += ms; c.voiceAt = now; c.lastMs = now;
    if (sys && !c.sys) c.sys = sys;
    return c;
  }
  /** Link control read on the voice channel (DMR voice LC header or terminator): who is talking to whom. */
  lc(sys: string, hz: number, slot: number, lc: { group: boolean; dst: number; src: number; emergency: boolean; privacy: boolean }, now = this.now()): Call {
    let c = this.find(sys, hz, slot);
    if (c && c.tg && c.tg !== lc.dst) { this.finish(c, 'terminator', now); c = undefined; }
    if (!c) c = this.create({ sys, proto: 'DMR', hz, slot, codec: 'ambe2', tg: lc.dst, group: lc.group }, now);
    c.tg = lc.dst; c.group = lc.group; this.addSrc(c, lc.src); c.encrypted = c.encrypted || lc.privacy; c.emergency = c.emergency || lc.emergency; c.lcVerified = true;
    c.lastMs = now; c.voiceAt = Math.max(c.voiceAt, now);
    c.muted = this.muted(c); c.prio = this.prefs.prio.includes(this.tgKey(c));
    return c;
  }
  /** A CW ID keyed on a channel: logged as its own row, and on the call that channel just carried. */
  cwId(sys: string, hz: number, text: string, now = this.now()): void {
    const k = gridKey(hz), last = this.calls.find(c => c.kind === 'call' && c.hz > 0 && gridKey(c.hz) === k && (c.onAir || now - c.endMs < ID_AFTER_MS));
    if (last) last.cwId = text;
    const r = this.create({ sys: sys || last?.sys || '', proto: last?.proto ?? 'P25', hz, slot: 0, codec: 'imbe', tg: 0 }, now);
    r.kind = 'id'; r.cwId = text; r.onAir = false; r.endMs = now; r.end = 'cw id';
    this.trim();
  }
  onAirAt(sys: string, hz: number, slot: number): boolean { return !!this.find(sys, hz, slot); }
  /** The channel sent its end of transmission. */
  terminate(sys: string, hz: number, slot: number, now = this.now()): void { const c = this.find(sys, hz, slot); if (c) this.finish(c, 'terminator', now); }
  /** Vocoder frames of a call: decoded where a codec is registered and the call is in the clear. */
  frames(c: Call, frames: Uint8Array[]): void {
    if (c.encrypted || c.muted) return;
    if (!c.codecInst) c.codecInst = makeCodec(c.codec);
    const k = c.codecInst; if (!k) return;
    for (const f of frames) {
      const pcm = k.decode(f); if (!pcm) continue;
      if (c.pcmN < AUDIO_CAP_S * 8000) { c.pcm.push(pcm); c.pcmN += pcm.length; c.audioMs = Math.round(c.pcmN / 8); }
      this.onAudio?.(pcm, c);
    }
  }
  private finish(c: Call, why: string, now: number): void {
    if (!c.onAir) return;
    c.onAir = false; c.endMs = now; c.end = why; c.codecInst = null;
    this.trim();
  }
  /** Calls go off the air when nothing has kept them alive. [level] reads the carrier level for a frequency. */
  tick(level: (hz: number) => number | null, now = this.now()): void {
    for (const c of this.calls) {
      if (!c.onAir) continue;
      const l = c.hz ? level(c.hz) : null;
      if (l !== null) { c.levelDb = l; c.peakDb = Math.max(c.peakDb, l); }
      const heard = c.voiceAt > 0;
      if (heard ? now - c.voiceAt > QUIET_HEARD_MS && now - c.grantMs > QUIET_HEARD_MS : now - c.grantMs > QUIET_GRANT_MS) this.finish(c, heard ? 'quiet' : 'grant ended', now);
    }
  }
  setPrefs(p: TgPrefs): void {
    this.prefs = { mute: [...p.mute], hold: p.hold, prio: [...p.prio] };
    for (const c of this.calls) { c.muted = this.muted(c); c.prio = this.prefs.prio.includes(this.tgKey(c)); }
  }
  /** On-air calls in the order they are worth listening to: priority, emergency, then newest. Muted ones last. */
  ranked(): Call[] {
    return this.calls.filter(c => c.onAir).sort((a, b) => Number(a.muted) - Number(b.muted) || Number(b.prio) - Number(a.prio) || Number(b.emergency) - Number(a.emergency) || b.startMs - a.startMs);
  }
  /** The call a single-channel receiver should go to: the best one outside [inSpan] that is not muted. */
  followTarget(inSpan: (hz: number) => boolean, worth: (c: CallRow) => boolean = () => true): Call | null {
    return this.ranked().find(c => !c.muted && c.hz > 0 && !inSpan(c.hz) && worth(c)) ?? null;
  }
  audioOf(key: string): Float32Array | null {
    const c = this.calls.find(x => x.key === key); if (!c || !c.pcmN) return null;
    const out = new Float32Array(c.pcmN); let p = 0; for (const b of c.pcm) { out.set(b, p); p += b.length; }
    return out;
  }
  rows(n = 80): CallRow[] {
    const on = this.ranked(), off = this.calls.filter(c => !c.onAir).slice(0, n);
    return [...on, ...off].map(({ grantMs: _g, voiceAt: _v, pcm: _p, pcmN: _n, codecInst: _k, ...r }) => ({ ...r, srcs: [...r.srcs] }));
  }
  clear(): void { this.calls.length = 0; }
}
