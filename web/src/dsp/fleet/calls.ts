/**
 * Dispatch calls: every voice grant and every voice transmission heard becomes a call that is on the air until its
 * channel says it ended (a P25 terminator, a DMR terminator) or goes quiet. Talkgroup preferences (mute, hold,
 * priority) and the system lock pick what the receiver follows and what is heard. Each call keeps what the air said
 * about its security (grant service options, link control, encryption sync, privacy header) and the position heard
 * with it. Audio, where a vocoder is registered, is kept per call for replay. No DOM.
 */
import { makeCodec, type CodecId, type VoiceCodec } from './codec.js';

/** Where a call was heard from: the talking unit's own position, or the latest of a talkgroup member's. */
export interface CallPos { lat: number; lon: number; unit: number; ms: number; via: 'unit' | 'talkgroup'; verified: boolean }
/** One system (or one site of it) the listener locked on. [hz] is its control channel, for tuning back to it. */
export interface Lock { sys: string; site: string; label: string; hz: number }
export type CallSec = 'unknown' | 'clear' | 'enc';
/** The air interfaces calls come from. */
export type CallProto = 'P25' | 'DMR' | 'TETRA' | 'NXDN';
/**
 * The vocoder of a call: IMBE for P25 Phase 1, AMBE+2 half rate for DMR, Phase 2 and NXDN, the TETRA ACELP codec for
 * TETRA. NXDN's EFR (its 9600 bps full rate) is the IMBE frame: [efr].
 */
export const codecOf = (proto: CallProto, tdma: boolean, efr = false): CodecId => proto === 'TETRA' ? 'tetra' : (proto === 'P25' && !tdma) || (proto === 'NXDN' && efr) ? 'imbe' : 'ambe2';
export interface CallRow {
  key: string; sys: string; proto: CallProto; tg: number; group: boolean; src: number; srcs: number[]; hz: number; slot: number; tdma: boolean;
  encrypted: boolean; emergency: boolean; startMs: number; lastMs: number; endMs: number; onAir: boolean;
  /** Voice heard on the channel itself (P25 voice frames, DMR voice bursts), in ms of speech. */
  voiceMs: number; frames: number; levelDb: number; peakDb: number; site: string; codec: CodecId;
  /** How the call ended: 'terminator', 'quiet', 'grant ended', or '' while on the air. */
  end: string; muted: boolean; prio: boolean; audioMs: number; lcVerified: boolean; granted: boolean;
  /** 'id' rows are CW IDs keyed on a channel; a call's own [cwId] is the ID its channel keyed right after it. */
  kind: 'call' | 'id'; cwId: string;
  /** Outside the system lock: shown dimmed, never heard, never followed. */
  outside: boolean;
  pos: CallPos | null;
  /** Security as the call states it, and what said so ('grant', 'LDU1', 'LDU2', 'HDU', 'LC', 'EMB', 'PI', 'assumed'). */
  sec: CallSec; secFrom: string;
  /** P25 encryption sync (LDU2 or HDU): algorithm ID, key ID (-1 when not heard) and the message indicator in hex. */
  algId: number; keyId: number; mi: string;
  /** DMR privacy indicator header as sent, in hex ('' when none was heard). */
  pi: string;
  /** Decoded audio level, dB below full scale (0 when none yet). */
  audioDb: number;
  /** A DMR grant's logical channel, and whether its frequency was learned from what the channels carried. */
  lpcn: number; chDerived: boolean;
  /** A grant or link control marked the call protected, and no encryption sync has confirmed or denied it. */
  protectedHint: boolean;
  /** Vocoder frames decoded, and how many of them were past their error correction (repeated or muted). */
  decoded: number; badFrames: number;
  /** The talker alias the radio sent (DMR), or ''. */
  alias: string;
}
interface Call extends CallRow { grantMs: number; voiceAt: number; audioAt: number; pcm: Float32Array[]; pcmN: number; codecInst: VoiceCodec | null; held: Uint8Array[]; hint: string; said: Said; wait: Float32Array[] }
/** What each source on the air said: 1 encrypted, 0 clear, -1 nothing yet; [syncs] the last algorithm IDs read. */
interface Said { grant: number; lc: number; syncs: number[]; from: string; pi: boolean; emb: number; history: boolean; histEnc: boolean; aie?: boolean }

export interface TgPrefs { mute: string[]; hold: string; prio: string[]; lock?: Lock | null }
export const AUDIO_CAP_S = 120;
/** Frames held while a call's security is not yet known (360 ms); past that a call nothing marked encrypted plays. */
export const HOLD_FRAMES = 18;
/**
 * On P25 a clear grant or link control waits three LDUs (540 ms) for the encryption sync: the sync is read at the end
 * of an LDU2, after its nine frames, so a call joined at its LDU1 has the sync in hand before this many frames.
 */
export const P25_HOLD_FRAMES = 27;
/** Encrypted calls, and calls still waiting on their security, rank below every clear call. */
export const quietRank = (c: Pick<CallRow, 'encrypted' | 'sec'>) => c.encrypted ? 2 : c.sec === 'unknown' ? 1 : 0;
const CALLS_KEPT = 200, AUDIO_CALLS = 30;
const QUIET_HEARD_MS = 1_200, QUIET_GRANT_MS = 3_000, TRAIL_MS = 2_000, ID_AFTER_MS = 15_000;
/**
 * How long the call heard keeps the audio with no speech frame: P25 Phase 1 hands over nine frames an LDU (180 ms), so
 * one lost LDU must not cost it; Phase 2 and DMR bring frames every 60 ms. Past this a call with speech takes over, so
 * a call that holds the channel with silence, or frames that all fail, never keeps NOW PLAYING quiet.
 */
export const liveMs = (c: { proto: string; tdma: boolean }) => c.proto === 'P25' && !c.tdma ? 600 : 360;

const gridKey = (hz: number) => Math.round(hz / 6250) * 6250;
/** How long the talkgroup of a call just heard keeps first claim on the audio: the reply in a conversation. */
export const CONVERSATION_MS = 2_000;
/** A call waiting out another talkgroup's conversation keeps this many frames (20 ms each) to play when its turn comes. */
const WAIT_FRAMES = Math.ceil(CONVERSATION_MS / 20) + 25;
/** Outside a lock: another system, or another site of the locked one (a call with no site label is kept). */
export const outsideLock = (c: { sys: string; site: string }, lock: Lock | null | undefined) =>
  !!lock && (c.sys !== lock.sys || (!!lock.site && !!c.site && c.site !== lock.site));

export class CallTracker {
  readonly calls: Call[] = [];
  prefs: TgPrefs = { mute: [], hold: '', prio: [], lock: null };
  /** The call being heard: the first to bring audio keeps it until it ends; priority (then emergency) takes over. */
  playing = '';
  /** The talkgroup of the call last heard, and when it ended: its next call gets the audio first for a moment. */
  private lastHeard: { sys: string; tg: number; group: boolean; ms: number } | null = null;
  /** Talkgroups whose calls a sync (ALGID other than 0x80) marked encrypted, and when. */
  private readonly encTgs = new Map<string, number>();
  /** Live audio out, 8 kHz: every decoded frame of the call being heard. */
  onAudio: ((pcm: Float32Array, call: CallRow) => void) | null = null;
  /** The call being heard went off the air or out of hearing (so its audio can fade out instead of stopping dead). */
  onEnd: ((call: CallRow) => void) | null = null;
  constructor(private readonly now: () => number) {}

  tgKey = (c: { sys: string; tg: number; group: boolean; src?: number }) => c.group ? `${c.sys}/${c.tg}` : `${c.sys}/u${c.tg}`;
  muted(c: CallRow): boolean { return this.prefs.mute.includes(this.tgKey(c)) || (!!this.prefs.hold && this.prefs.hold !== this.tgKey(c)); }
  private label(c: Call): void { c.muted = this.muted(c); c.prio = this.prefs.prio.includes(this.tgKey(c)); c.outside = outsideLock(c, this.prefs.lock); }

  private find(sys: string, hz: number, slot: number, onAir = true): Call | undefined {
    const k = gridKey(hz);
    return this.calls.find(c => c.kind === 'call' && (!onAir || c.onAir) && (!sys || !c.sys || c.sys === sys) && c.hz > 0 && gridKey(c.hz) === k && c.slot === slot);
  }
  private create(p: Partial<CallRow> & { sys: string; proto: CallProto; hz: number; slot: number; codec: CodecId }, now: number): Call {
    const c: Call = {
      key: `${p.sys}|${now}|${p.hz}|${p.slot}`, sys: p.sys, proto: p.proto, tg: p.tg ?? 0, group: p.group ?? true, src: p.src ?? 0, srcs: p.src ? [p.src] : [], hz: p.hz, slot: p.slot,
      tdma: p.tdma ?? false, encrypted: false, emergency: p.emergency ?? false, startMs: now, lastMs: now, endMs: 0, onAir: true, voiceMs: 0, frames: 0,
      levelDb: 0, peakDb: 0, site: p.site ?? '', codec: p.codec, end: '', muted: false, prio: false, audioMs: 0, lcVerified: false, granted: false, kind: 'call', cwId: '',
      outside: false, pos: null, sec: 'unknown', secFrom: '', algId: -1, keyId: -1, mi: '', pi: '', audioDb: 0, lpcn: p.lpcn ?? -1, chDerived: p.chDerived ?? false, protectedHint: false, decoded: 0, badFrames: 0, alias: '',
      grantMs: 0, voiceAt: 0, audioAt: 0, pcm: [], pcmN: 0, codecInst: null, held: [], hint: '', wait: [], said: { grant: -1, lc: -1, syncs: [], from: '', pi: false, emb: -1, history: false, histEnc: false },
    };
    this.label(c);
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
  grant(g: { sys: string; proto: CallProto; tg: number; group: boolean; src: number; hz: number; slot: number; tdma: boolean; encrypted: boolean; emergency: boolean; site: string; lpcn?: number; chDerived?: boolean; efr?: boolean }, now = this.now()): Call | null {
    if (!g.tg && !g.hz) return null;
    let c = this.calls.find(x => x.kind === 'call' && x.onAir && x.sys === g.sys && x.tg === g.tg && x.group === g.group && (!x.hz || !g.hz || gridKey(x.hz) === gridKey(g.hz)) && (x.slot === g.slot || !x.hz || !g.hz));
    if (!c && g.hz) {
      // voice that arrived before its grant (or a grant for a channel already carrying an unlabeled call)
      const v = this.find(g.sys, g.hz, g.slot);
      if (v && !v.tg) c = v;
    }
    // grant updates trail a call for a moment after its terminator: they do not open it again
    if (!c && this.calls.some(x => x.kind === 'call' && !x.onAir && x.end === 'terminator' && now - x.endMs < TRAIL_MS && x.sys === g.sys && x.tg === g.tg && (!g.hz || !x.hz || gridKey(x.hz) === gridKey(g.hz)))) return null;
    const codec = codecOf(g.proto, g.tdma, g.efr);
    if (!c) c = this.create({ ...g, codec }, now);
    c.tg = g.tg || c.tg; c.group = g.group; c.sys = g.sys || c.sys; if (g.hz) { c.hz = g.hz; c.slot = g.slot; } c.tdma = g.tdma; c.codec = codec;
    if (g.lpcn !== undefined && g.lpcn >= 0) c.lpcn = g.lpcn;
    if (g.chDerived) c.chDerived = true;
    if (g.src) this.addSrc(c, g.src);
    c.emergency = c.emergency || g.emergency; c.site = g.site || c.site;
    // a P25 grant's service options say whether the call is encrypted; a DMR grant says nothing either way
    if (g.encrypted) this.security(c, { enc: true, from: 'grant' });
    else if (g.proto === 'P25' || g.proto === 'TETRA') this.security(c, { enc: false, from: 'grant' });
    c.grantMs = now; c.lastMs = now; c.granted = true;
    this.label(c);
    return c;
  }
  private addSrc(c: Call, src: number): void { c.src = src; if (!c.srcs.includes(src)) { c.srcs.push(src); if (c.srcs.length > 12) c.srcs.shift(); } }

  /** Voice on a channel: a P25 voice frame (180 ms of speech) or a DMR voice burst (60 ms). */
  voice(sys: string, proto: CallProto, hz: number, slot: number, ms: number, now = this.now(), tdma = false): Call {
    let c = this.find(sys, hz, slot);
    if (!c) c = this.create({ sys, proto, hz, slot, tdma, codec: codecOf(proto, tdma) }, now);
    c.frames++; c.voiceMs += ms; c.voiceAt = now; c.lastMs = now;
    if (sys && !c.sys) { c.sys = sys; this.label(c); }
    return c;
  }
  /** Link control read on the voice channel (DMR voice LC header or terminator, P25 LDU1): who is talking to whom. */
  lc(sys: string, hz: number, slot: number, lc: { group: boolean; dst: number; src: number; emergency: boolean; privacy: boolean }, now = this.now(), proto: CallProto = 'DMR', tdma = false): Call {
    let c = this.find(sys, hz, slot);
    if (c && c.tg && c.tg !== lc.dst) { this.finish(c, 'terminator', now); c = undefined; }
    if (!c) {
      // a granted call whose channel is not resolved yet (a DMR logical channel): the voice link control places it
      c = this.calls.find(x => x.kind === 'call' && x.onAir && x.proto === proto && !x.hz && x.tg === lc.dst && x.group === lc.group && (!sys || !x.sys || x.sys === sys));
      if (c) { c.hz = hz; c.slot = slot; }
    }
    if (!c) c = this.create({ sys, proto, hz, slot, tdma, codec: codecOf(proto, tdma), tg: lc.dst, group: lc.group }, now);
    c.tg = lc.dst; c.group = lc.group; this.addSrc(c, lc.src); c.emergency = c.emergency || lc.emergency; c.lcVerified = true;
    if (sys && !c.sys) c.sys = sys;
    if (!tdma && proto !== 'NXDN') this.security(c, { enc: lc.privacy, from: proto === 'P25' ? 'LDU1' : 'LC' });
    c.lastMs = now; c.voiceAt = Math.max(c.voiceAt, now);
    this.label(c);
    return c;
  }
  /**
   * What the air says about a call's security, each source kept, and the call's state worked out again from all of
   * them. A call is ENCRYPTED only when the radio says so positively:
   *  - P25: an encryption sync (LDU2) or header that passed its Reed-Solomon check with an ALGID other than 0x80.
   *    ALGID 0x80 is clear, whatever else was said. A grant or link control marked protected, with no sync to
   *    confirm it, is only "protected?": the call plays, and goes quiet the moment a sync says encrypted.
   *  - DMR: the link control's privacy bit (Reed-Solomon checked), the privacy indicator header (CRC checked) or the
   *    EMB privacy bit (its (16,7) check).
   * Frames that fail their codes, or a call with nothing readable, never make a call encrypted.
   */
  security(c: Call, s: { enc: boolean; from: string; algId?: number; keyId?: number; mi?: string; pi?: string }): void {
    const said = c.said, sync = s.from === 'LDU2' || s.from === 'HDU' || s.from === 'MAC' || s.from === 'ESS';
    if (c.tdma && c.tg && !said.history && this.encTgs.has(this.tgKey(c))) said.history = true;
    if (sync && s.algId !== undefined && s.algId >= 0) { said.syncs.push(s.algId); if (said.syncs.length > 2) said.syncs.shift(); c.algId = s.algId; c.keyId = s.keyId ?? c.keyId; if (s.mi !== undefined) c.mi = s.mi; said.from = s.from; }
    else if (s.from === 'grant') said.grant = s.enc ? 1 : (said.grant === 1 ? 1 : 0);
    else if (s.from === 'LDU1' || s.from === 'LC') said.lc = s.enc ? 1 : (said.lc === 1 ? 1 : 0);
    else if (s.from === 'PI') { said.pi = true; if (s.pi) c.pi = s.pi; if (s.algId !== undefined) c.algId = s.algId; if (s.keyId !== undefined) c.keyId = s.keyId; if (s.mi) c.mi = s.mi; }
    else if (s.from === 'EMB') said.emb = s.enc ? 1 : (said.emb === 1 ? 1 : 0);
    else if (s.from === 'history') said.histEnc = true;
    else if (s.from === 'AIE') said.aie = true;
    // NXDN: the cipher type of a VCALL (SACCH or FACCH1, CRC checked) or of a Type-D INFO1 (SCCH, CRC checked)
    else if (s.from === 'VCALL' || s.from === 'SCCH') { said.lc = s.enc ? 1 : (said.lc === 1 ? 1 : 0); said.from = s.from; if (s.enc) { if (s.algId !== undefined) c.algId = s.algId; if (s.keyId !== undefined) c.keyId = s.keyId; } }
    let sec: CallSec = 'unknown', from = '';
    if (c.proto === 'P25') {
      const last = said.syncs.length ? said.syncs[said.syncs.length - 1] : -1;
      if (last >= 0) { sec = last === 0x80 ? 'clear' : 'enc'; from = said.from; }
      // a Phase 2 talkgroup whose earlier calls were encrypted waits for its push to talk or ESS, and past a second
      // without either is taken as encrypted
      else if (said.histEnc) { sec = 'enc'; from = 'history'; }
      else if (said.history && c.tdma) sec = 'unknown';
      else if (said.grant >= 0 || said.lc >= 0) { sec = 'clear'; from = said.grant >= 0 ? 'grant' : 'LDU1'; }
      c.protectedHint = last < 0 && (said.grant === 1 || said.lc === 1);
    } else if (c.proto === 'TETRA') {
      // TETRA: the end-to-end encryption flag of the call's set-up (or the encryption control of a transmission grant),
      // or signalling encrypted on the air interface of a cell that offers it
      if (said.grant === 1 || said.aie) { sec = 'enc'; from = said.aie ? 'AIE' : 'grant'; }
      else if (said.grant === 0) { sec = 'clear'; from = 'grant'; }
      c.protectedHint = false;
    } else if (c.proto === 'NXDN') {
      // a cipher type other than 00 is encrypted (scramble, DES, AES); 00 says clear (TS 1-A 6.5.27)
      if (said.lc === 1) { sec = 'enc'; from = said.from; } else if (said.lc === 0) { sec = 'clear'; from = said.from; }
      c.protectedHint = false;
    } else {
      if (said.lc === 1 || said.pi || said.emb === 1) { sec = 'enc'; from = said.pi ? 'PI' : said.lc === 1 ? 'LC' : 'EMB'; }
      // an EMB privacy bit of 0 does not make a call clear: Motorola's privacy leaves it 0, the LC's service options say it
      else if (said.lc === 0) { sec = 'clear'; from = 'LC'; }
      c.protectedHint = false;
    }
    const was = c.sec;
    if (sec === 'enc' && sync && c.tg) this.encTgs.set(this.tgKey(c), this.now());
    c.sec = sec; c.secFrom = sec === 'unknown' ? c.secFrom : from; c.encrypted = sec === 'enc';
    if (sec === 'enc') { c.held = []; c.wait = []; if (this.playing === c.key) { this.playing = ''; this.onEnd?.(c); } }
    else if (sec === 'clear' && was !== 'clear') this.release(c);
  }
  /** The call's vocoder, before any of its frames were decoded (an NXDN call that turns out to be EFR). */
  setCodec(c: CallRow, codec: CodecId): void { const x = c as Call; if (x.codec !== codec && !x.codecInst) { x.codec = codec; x.held = []; } }
  /** Security of the call on the air on a channel, if there is one. */
  securityAt(sys: string, hz: number, slot: number, s: { enc: boolean; from: string; algId?: number; keyId?: number; mi?: string; pi?: string }): Call | undefined {
    const c = this.find(sys, hz, slot); if (c) this.security(c, s); return c;
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
  /** The call on the air on a channel (and slot), if any. */
  at(sys: string, hz: number, slot: number): Call | undefined { return this.find(sys, hz, slot); }
  /** The channel sent its end of transmission. */
  terminate(sys: string, hz: number, slot: number, now = this.now()): void { const c = this.find(sys, hz, slot); if (c) this.finish(c, 'terminator', now); }
  /** Where the call was heard from; kept with the call once it ends. */
  place(c: CallRow, pos: CallPos | null): void { if (pos) (c as Call).pos = pos; }
  /**
   * Vocoder frames of a call: decoded where a codec is registered and the call is in the clear. Until something on
   * the air says whether the call is encrypted its frames wait (at most [HOLD_FRAMES]).
   */
  frames(c: Call, frames: Uint8Array[]): void {
    if (c.encrypted || c.muted || c.outside) return;
    if (c.sec === 'unknown') {
      c.held.push(...frames);
      // nothing checked on the air has named the call yet (no grant, no link control, no EMB that passed its check):
      // it waits, its oldest frames going first. A false DMR detection or a channel of noise never takes the audio.
      if (c.held.length > P25_HOLD_FRAMES) c.held.splice(0, c.held.length - P25_HOLD_FRAMES);
      return;
    }
    this.decode(c, frames);
  }
  private release(c: Call): void {
    const h = c.held; c.held = [];
    if (h.length && !c.encrypted && !c.muted && !c.outside) this.decode(c, h);
  }
  private decode(c: Call, frames: Uint8Array[]): void {
    if (!c.codecInst) c.codecInst = makeCodec(c.codec);
    const k = c.codecInst; if (!k) return;
    const now = this.now();
    for (const f of frames) {
      const pcm = k.decode(f); if (!pcm) continue;
      c.decoded++; if (k.bad) c.badFrames++;
      if (c.pcmN < AUDIO_CAP_S * 8000) { c.pcm.push(pcm); c.pcmN += pcm.length; c.audioMs = Math.round(c.pcmN / 8); }
      let e = 0; for (let i = 0; i < pcm.length; i++) e += pcm[i] * pcm[i];
      const db = 10 * Math.log10(e / pcm.length + 1e-9);
      c.audioDb = c.audioDb ? c.audioDb + 0.3 * (db - c.audioDb) : db;
      // only a frame that came through its codes and carries speech counts as audio: a weak call's muted and repeated
      // frames, and a keyed radio's silence frames, neither take the audio nor keep it
      const good = !k.bad && !k.silent;
      if (good) c.audioAt = now;
      if (this.playing === c.key) { this.onAudio?.(pcm, c); continue; }
      const r = good ? this.choose(c, now) : c.wait.length ? 'wait' : 'no';
      if (r === 'yes') { for (const w of c.wait) this.onAudio?.(w, c); c.wait = []; this.onAudio?.(pcm, c); }
      else if (r === 'wait') { c.wait.push(pcm); if (c.wait.length > WAIT_FRAMES) c.wait.shift(); }
      else c.wait = [];
    }
  }
  /**
   * Whether [c] is the call heard: it is when nothing else is, and it takes over for priority or emergency. The call
   * heard keeps the audio while it is on the air (its terminator, or 1.2 s with no voice frame, ends it) and has
   * brought speech within [liveMs]: a lost LDU or a frame that failed its codes does not hand it to another call.
   */
  private choose(c: Call, now: number): 'yes' | 'no' | 'wait' {
    if (this.playing === c.key) return 'yes';
    const cur = this.playing ? this.calls.find(x => x.key === this.playing) : undefined;
    const live = !!cur && cur.onAir && !cur.muted && !cur.outside && !cur.encrypted && now - cur.audioAt < liveMs(cur);
    const wins = !!cur && ((c.prio && !cur.prio) || (c.emergency && !cur.emergency && !cur.prio));
    if (live && !wins) return 'no';
    // the conversation goes on: for 2 s after the call heard ends, the same talkgroup's next call gets the audio
    // first over a call that starts in that time. That call's speech is kept, not lost: it plays from its start if no
    // reply comes. A call already on the air when the heard one ended goes straight on (holding it would cost audio).
    const h = this.lastHeard, same = !!h && c.tg === h.tg && c.group === h.group && (!c.sys || !h.sys || c.sys === h.sys);
    if (!cur?.onAir && h && now - h.ms < CONVERSATION_MS && !same && c.startMs >= h.ms && !c.prio && !c.emergency) return 'wait';
    // past the window, the call that has waited longest goes first, from the start of what it kept
    if (!cur?.onAir && !(h && now - h.ms < CONVERSATION_MS && same)) {
      const first = this.calls.find(x => x !== c && x.onAir && x.wait.length > c.wait.length && !x.encrypted && !x.muted && !x.outside);
      if (first) { this.playing = first.key; for (const w of first.wait) this.onAudio?.(w, first); first.wait = []; return 'no'; }
    }
    if (cur && live) this.onEnd?.(cur);
    this.playing = c.key;
    return 'yes';
  }
  /**
   * The conversation window is over and nothing plays: the speech kept by the call that waited longest plays now, even
   * when that call has already ended (a short call in the window is heard rather than lost).
   */
  private waitOut(now: number): void {
    const h = this.lastHeard;
    if (this.playing || !h || now - h.ms < CONVERSATION_MS) return;
    const x = this.calls.filter(c => c.wait.length && !c.encrypted && !c.muted && !c.outside).sort((a, b) => a.startMs - b.startMs)[0];
    for (const c of this.calls) if (c !== x && !c.onAir) c.wait = [];
    if (!x) return;
    const w = x.wait; x.wait = [];
    if (x.onAir) this.playing = x.key;
    for (const p of w) this.onAudio?.(p, x);
    if (!x.onAir) this.onEnd?.(x);
  }
  private finish(c: Call, why: string, now: number): void {
    if (!c.onAir) return;
    // frames still waiting on the call's security play out first, unless nothing on the air ever named the call
    c.onAir = false; c.endMs = now; c.end = why; c.codecInst = null; c.held = [];
    // the conversation's window runs from the call's last voice (a call that went quiet ends 1.2 s after it)
    if (this.playing === c.key) { this.playing = ''; this.lastHeard = { sys: c.sys, tg: c.tg, group: c.group, ms: Math.min(now, c.voiceAt || now) }; this.onEnd?.(c); }
    this.trim();
  }
  /** Calls go off the air when nothing has kept them alive. [level] reads the carrier level for a frequency. */
  tick(level: (hz: number) => number | null, now = this.now()): void {
    this.waitOut(now);
    for (const c of this.calls) {
      if (!c.onAir) continue;
      const l = c.hz ? level(c.hz) : null;
      if (l !== null) { c.levelDb = l; c.peakDb = Math.max(c.peakDb, l); }
      if (c.tdma && c.tg && c.sec !== 'enc' && !c.said.syncs.length) {
        if (!c.said.history && this.encTgs.has(this.tgKey(c))) { c.said.history = true; this.security(c, { enc: false, from: 'recheck' }); }
        if (c.said.history && now - c.startMs > 1_000) this.security(c, { enc: true, from: 'history' });
      }
      const heard = c.voiceAt > 0;
      if (heard ? now - c.voiceAt > QUIET_HEARD_MS && now - c.grantMs > QUIET_HEARD_MS : now - c.grantMs > QUIET_GRANT_MS) this.finish(c, heard ? 'quiet' : 'grant ended', now);
    }
  }
  setPrefs(p: TgPrefs): void {
    this.prefs = { mute: [...p.mute], hold: p.hold, prio: [...p.prio], lock: p.lock ? { ...p.lock } : null };
    for (const c of this.calls) this.label(c);
    const cur = this.calls.find(x => x.key === this.playing);
    if (cur && (cur.muted || cur.outside)) { this.playing = ''; this.onEnd?.(cur); }
  }
  /** On-air calls in the order they are worth listening to: priority, emergency, then newest. Muted and locked-out ones last. */
  ranked(): Call[] {
    return this.calls.filter(c => c.onAir).sort((a, b) => Number(a.outside) - Number(b.outside) || Number(a.muted) - Number(b.muted) || Number(a.encrypted) - Number(b.encrypted) || Number(b.prio) - Number(a.prio) || Number(b.emergency) - Number(a.emergency) || b.startMs - a.startMs);
  }
  /** The call a single-channel receiver should go to: the best one outside [inSpan] that is not muted or locked out. */
  followTarget(inSpan: (hz: number) => boolean, worth: (c: CallRow) => boolean = () => true): Call | null {
    return this.ranked().find(c => !c.muted && !c.outside && !c.encrypted && c.hz > 0 && !inSpan(c.hz) && worth(c)) ?? null;
  }
  audioOf(key: string): Float32Array | null {
    const c = this.calls.find(x => x.key === key); if (!c || !c.pcmN) return null;
    const out = new Float32Array(c.pcmN); let p = 0; for (const b of c.pcm) { out.set(b, p); p += b.length; }
    return out;
  }
  rows(n = 80): CallRow[] {
    const on = this.ranked(), off = this.calls.filter(c => !c.onAir).slice(0, n);
    return [...on, ...off].map(({ grantMs: _g, voiceAt: _v, audioAt: _a, pcm: _p, pcmN: _n, codecInst: _k, held: _h, hint: _t, said: _s, wait: _w, ...r }) => ({ ...r, srcs: [...r.srcs], pos: r.pos ? { ...r.pos } : null }));
  }
  clear(): void { this.calls.length = 0; this.playing = ''; }
}
