/**
 * HAM+ receiver: every FM channel in the span at once, every open one demodulated.
 *
 * A windowed FFT every buffer measures the power on a 2.5 kHz raster; a per-channel floor (fast down, slow up) gives
 * an SNR, and a carrier opens on the raster point that is the strongest within 7.5 kHz once it passes the threshold
 * (closing 3 dB lower, after 0.4 s below, so a mobile's flutter does not split a transmission). Each open carrier gets
 * a down-converter to about 24 kS/s and a probe: the FM discriminator, whose mean over the transmission is the
 * transmitter's carrier frequency error, a CTCSS / DCS decoder, a Morse reader for CW IDs, the audio envelope, and its
 * audio, kept as 8 kHz mu-law in the time machine and played when the channel is listened to.
 *
 * Each probe also runs the identity layer (hamid/channel.ts) on its discriminator: DMR, D-STAR, Fusion, P25, NXDN,
 * dPMR and M17 named by their checks, who is talking and to which talkgroup, and analog signaling (selcall, MDC-1200,
 * FleetSync, DTMF, courtesy tones). A channel whose digital mode is named is a transmission without an FM voice, and
 * its digital voice, decoded by the app's vocoders, is what it records and plays. While the receiver clips (a very
 * strong signal nearby) no digital mode is named from what it hears.
 *
 * Probes are capped by what the processor sustains: the time they take is measured and the cap set to fill
 * [BUDGET_MS] a second. A transmission without a probe is marked not recorded; none is dropped silently.
 */
import type { Emit, IqProcessor } from '../core.js';
import { fft, hann } from '../../fft.js';
import { Ddc } from '../trains.js';
import { RealFir, Resampler, lowpassTaps } from '../ham/filters.js';
import { SubAudioDecoder } from '../ham/ctcss.js';
import { COMB_TOP_HZ, CombMemory, CombNotch } from '../hfcomb.js';
import { CwReader } from '../fleet/rx.js';
import { HP_RASTER, hpBandOf, hpGridOf } from './plan.js';
import { ClipStore, ClipWriter, CLIP_RATE, planReplay, replayFromPlan, ReplayMixer, type Clip } from './clips.js';
import { FmSpeech, SPEECH_LAPSE_MS, type SpeechCount } from './speech.js';
import { HamTracker, ENV_MS, HEAT_SLOTS, LINK_CORR, LINK_EDGE_MS, chanKey, envCorr, type HpPrefs, type HpSaved, type LiveRec, type TxRec } from './tracker.js';
import { HamIdChannel, type HamIdSnap } from '../hamid/channel.js';
import { identOf, isDigital, type HamIdent } from '../hamid/ident.js';
import { iqClipping } from '../hamid/framing.js';

/** Envelope a pair of open channels needs before they are compared for the same audio (1.5 s), the most compared (the last 5 s), and how far either way the lag is searched (300 ms). */
export const LINK_LIVE_FRAMES = 30, LINK_LIVE_MAX = 100, LINK_LIVE_LAG = 6;
/** A wideband event: this many channels or more keyed within this long of each other on one tone or one audio. */
export const FLOOD_MIN = 6, FLOOD_WIN_MS = 1_000;
/** How long after its keyup one of many keyed together waits for that check (its tone and 1.5 s of audio are read by then). */
export const FLOOD_HOLD_MS = 3_000;

export const PROBE_RATE = 24_000;
/** How close (Hz) a carrier must sit to one of the radio's own spurs to be taken as it: the reference's error is ppm. */
export const OWN_SPUR_HZ = 4_000;
/** Processor time a second the probes may take, and the cap's bounds. */
export const BUDGET_MS = 450, CAP_MIN = 2, CAP_MAX = 32, CAP_START = 8;
/** A channel stays open this long below its closing level. */
export const CLOSE_HOLD_MS = 400;
/** Shorter than this is a noise blip, not a transmission. */
export const TX_MIN_MS = 250;
/** Speech must span this long before an open channel is a talker; a stronger channel this near, this many dB over it and
 *  keyed within this long makes it that one's splatter. */
export const TALK_SPAN_MS = 400, GHOST_HZ = 25_000, GHOST_DB = 15, GHOST_MS = 1_000;
/** A tone must be heard through this share of a transmission to be its tone. */
export const TONE_SHARE = 0.5;
/** A carrier open this long without a voice shows as a steady carrier. */
export const STEADY_SHOW_MS = 3_000;
/** A voice first heard this long after its carrier came up starts the transmission, less this much before it. */
export const TALK_LATE_MS = 2_000, TALK_PRE_MS = 300;
/** The span's noise moving this much off its median of the last [GAIN_REF] measurements is a gain step (AGC, LNA, amp);
 *  after one no carrier opens for [SETTLE_MS] while every closed channel's floor follows at once, so the first seconds
 *  of AGC open nothing. Judged only on a span of [GAIN_MIN_CH] channels or more (a narrower one's noise is too few). */
export const GAIN_STEP_DB = 1.5, SETTLE_MS = 2_000, GAIN_REF = 5, GAIN_MIN_CH = 64;
/** About the length of a speech block (the start of a block is this long before its end). */
const SPEECH_BLOCK_MS = 85;
const MEASURE_MS = 100, SNAP_MS = 500, OFF_WIN_MS = 100;
/** Digital voice levels (the vocoders' outputs differ; these bring each near an FM voice) and the jitter buffer (200 ms at 8 kHz). */
const VOICE_GAIN = 1.5, VOICE_GAIN_P25 = 4.5, VOICE_GAIN_M17 = 1.2, VOICE_PRIME = 1_600;
/** After the receiver clips, no digital mode is named from what it hears for this long (AGC and spurs settle). */
export const CLIP_HOLD_MS = 250;
/** The identity layer's CW ID reader (bench: 15 of 16) is taken over the probe's own once it is this sure of a callsign. */
const CW_SURE = 0.85;

export interface HpParams { thresholdDb: number; mode: 'mix' | 'newest'; volume: number }

/** What the watcher needs of a channel's demodulator: HAM+ has the FM one below, CB its AM / FM / SSB one. */
export interface WatchProbe {
  readonly clip: ClipWriter; readonly means: number[]; readonly env: number[];
  a48: Float32Array; out48: number; levelDb: number; cw0: string;
  push(fi: Float32Array, fq: Float32Array, n: number, listen: boolean): void;
  retune(offsetHz: number): void;
  offset(skip?: number): { hz: number; sd: number };
  tone(): number; dcs(): number;
  /** The transmission ended: flush what is still buffered (a Morse letter). */
  end(): void;
  /** Whether the audio carries a voice, block by block (speech.ts). */
  readonly speech: SpeechCount;
  /** Set by the watcher before each push: the receiver is clipping. */
  clipped?: boolean;
  /** The identity read so far (HAM+), null when it names nothing. */
  ident?(): HamIdent | null;
  /** A digital mode is named: the channel is a transmission, its voice is the vocoder's. */
  digital?(): boolean;
  /** When the digital decoders last passed a check (ms from the probe's start), -1 never. */
  lastDigitalMs?: number;
  /** A CW ID callsign the identity layer's own Morse reader is sure of, '' none (taken over the probe's reader when there is one). */
  cwId?(): string;
}

/**
 * Where a watcher's channels are and how one opens. HAM+ watches every point of a 2.5 kHz raster inside its ham and business
 * bands and lets a carrier move to its own channel; CB watches the 40 channels of its plan and nothing else.
 */
export interface WatchPlan {
  /** The name in log lines and the snapshot message type. */
  name: string; type: string;
  raster: number;
  /** Whether a raster point may open a channel. */
  inPlan(hz: number): boolean;
  /** The FFT size for a sample rate. */
  nfft(rate: number): number;
  /** Half the span heard, at a sample rate. */
  spanHalf(rate: number): number;
  /** A new carrier must be the strongest within this many raster steps, and this many from an open one. */
  peakSteps: number; clearSteps: number;
  /** An open carrier off its raster point by more than half a step moves to the right one. */
  snap: boolean;
  /** The channel grid a carrier at [hz] snaps to (the raster when absent): 6.25 kHz business channels fall between raster points. */
  grid?(hz: number): number;
}
export const HAM_PLAN: WatchPlan = {
  name: 'Repeaters', type: 'hamplus', raster: HP_RASTER, inPlan: hz => !!hpBandOf(hz),
  nfft: rate => 1 << Math.max(10, Math.min(14, Math.ceil(Math.log2(rate / 1000)))), spanHalf: rate => rate * 0.44 - 6_250,
  peakSteps: 3, clearSteps: 4, snap: true, grid: hpGridOf,
};

/** HAM+'s FM demodulator, which GMRS and MURS take as it is. */
export class Probe implements WatchProbe {
  readonly ddc: Ddc;
  readonly fs: number;
  oi = new Float32Array(0); oq = new Float32Array(0); au = new Float32Array(0); au2 = new Float32Array(0); a8 = new Float32Array(0); a48 = new Float32Array(0);
  readonly sub: SubAudioDecoder; readonly cw: CwReader; readonly lp: RealFir;
  readonly to8: Resampler; readonly to48: Resampler; readonly clip = new ClipWriter();
  private pi = 1; private pq = 0; private deemph = 0; private hp = 0; private readonly de: number;
  /** Discriminator sum over the current 100 ms, the 100 ms means so far, power and the envelope. */
  private offAcc = 0; private offN = 0; readonly means: number[] = [];
  private envAcc = 0; private envN = 0; readonly env: number[] = [];
  pow = 0; powN = 0; levelDb = -90; cw0 = '';
  tones = new Map<number, number>(); dcsCodes = new Map<number, number>(); subN = 0;
  out48 = 0;
  readonly speech: FmSpeech;
  clipped = false;
  /** The identity layer on this channel, its last snapshot, and when its checks last moved. */
  readonly idc: HamIdChannel;
  private snap: HamIdSnap | null = null; private snapAt = 0; private seen = 0; private checks = 0;
  lastDigitalMs = -1;
  /** Decoded digital voice at 8 kHz waiting to be recorded and played (a ring), the stream being played, and when it last had a frame. */
  private readonly vq = new Float32Array(1 << 15); private vr = 0; private vw = 0; private primed = false;
  private stream = ''; private streamAt = -1e9;
  private readonly v48: Resampler; private v8 = new Float32Array(0);
  /** 10 m: the HF comb's lines that are really there, taken out of the channel before the discriminator (hfcomb.ts). */
  private readonly comb: CombNotch | null;
  /** [cutHz] and [taps]: the channel filter (GMRS, its neighbors 12.5 kHz away, a narrower and steeper one). */
  constructor(rate: number, readonly offsetHz: number, comb: ((fs: number) => CombNotch) | null = null, private readonly loHz = 0, cutHz = 7_500, taps = 63) {
    this.ddc = new Ddc(cutHz, PROBE_RATE, taps); this.ddc.reset(rate); this.ddc.offsetHz = offsetHz; this.fs = this.ddc.outRate;
    this.comb = comb ? comb(this.fs) : null; this.comb?.tune(loHz, offsetHz);
    this.sub = new SubAudioDecoder(this.fs); this.cw = new CwReader(this.fs); this.cw.onText = t => { this.cw0 = (this.cw0 ? this.cw0 + ' ' : '') + t; };
    this.lp = new RealFir(lowpassTaps(3_000 / this.fs, 47));
    this.to8 = new Resampler(CLIP_RATE / this.fs); this.to48 = new Resampler(48_000 / this.fs);
    this.de = 1 - Math.exp(-1 / (this.fs * 530e-6));
    this.speech = new FmSpeech(this.fs, hz => this.ddc.powerGain(hz));
    this.idc = new HamIdChannel(this.fs, true); this.v48 = new Resampler(48_000 / CLIP_RATE);
    // the vocoders' frames: DMR, D-STAR and Fusion as frames per stream, P25, NXDN and dPMR per slot, M17's Codec 2
    this.idc.onPcm = f => { if (f.pcm) this.voice(`${f.stream}`, f.pcm, VOICE_GAIN); };
    this.idc.onAudio = (m, slot, pcm) => this.voice(`${m}${slot}`, pcm, VOICE_GAIN_P25);
    this.idc.onM17Pcm = p => { const f = new Float32Array(p.length); for (let i = 0; i < p.length; i++) f[i] = p[i] / 32768; this.voice('m17', f, VOICE_GAIN_M17); };
  }
  /** The stream a mode's voice comes in on: only the named mode's frames play (a stray sync of another mode is no voice). */
  private static streamOf(mode: string, stream: string): boolean {
    switch (mode) {
      case 'DMR': return stream.startsWith('dmr');
      case 'D-STAR': return stream === 'dstar';
      case 'YSF': return stream === 'ysf';
      case 'M17': return stream === 'm17';
      case 'P25': case 'P25P2': case 'NXDN': case 'dPMR': return stream.startsWith(mode);
      default: return false;
    }
  }
  private voice(stream: string, pcm: Float32Array, gain: number): void {
    const mode = this.snap?.verified ? this.snap.mode : '';
    if (!Probe.streamOf(mode, stream)) return;
    // one talker at a time: the stream playing keeps going until it has been quiet half a second
    const t = this.subN / this.fs * 1000;
    if (stream !== this.stream && t - this.streamAt < 500) return;
    this.stream = stream; this.streamAt = t;
    const Q = this.vq.length - 1;
    for (let i = 0; i < pcm.length; i++) { this.vq[this.vw & Q] = pcm[i] * gain; this.vw++; }
    if (this.vw - this.vr > Q) this.vr = this.vw - Q;
  }
  /** [k] samples of decoded voice at 8 kHz into [out]: silence until 200 ms are waiting, and again after running dry. */
  private pull(out: Float32Array, k: number): void {
    const Q = this.vq.length - 1;
    if (!this.primed && this.vw - this.vr >= VOICE_PRIME) this.primed = true;
    for (let i = 0; i < k; i++) {
      if (this.primed && this.vr < this.vw) { out[i] = this.vq[this.vr & Q]; this.vr++; }
      else { out[i] = 0; this.primed = false; }
    }
  }
  digital(): boolean { return !!this.snap && this.snap.verified && isDigital(this.snap.mode); }
  ident(): HamIdent | null { return this.snap ? identOf(this.snap) : null; }
  cwId(): string { const c = this.snap?.analog?.cwId; return c && c.confidence >= CW_SURE ? c.callsign : ''; }
  /** The identity snapshot four times a second, and when the decoders' checks last moved. */
  private look(): void {
    const t = this.subN / this.fs;
    if (t - this.snapAt < 0.25) return;
    this.snapAt = t;
    const c = this.idc, n = c.dmr.checked + c.dmr.clean + c.dstar.id.frames + c.dstar.id.headers + c.ysf.id.frames + c.m17.id.lsfs + c.m17.id.frames + c.p25.p25.checked + c.p25.nxdn.checked + c.p25.dpmr.checked + c.p25.p25p2.checked;
    if (n !== this.checks) { this.checks = n; this.lastDigitalMs = t * 1000; }
    this.snap = c.snapshot(); this.seen++;
  }
  retune(offsetHz: number): void { this.ddc.offsetHz = offsetHz; this.comb?.tune(this.loHz, offsetHz); }
  push(fi: Float32Array, fq: Float32Array, n: number, listen: boolean): void {
    const max = this.ddc.maxOut(n);
    if (this.oi.length < max) { this.oi = new Float32Array(max); this.oq = new Float32Array(max); this.au = new Float32Array(max); this.au2 = new Float32Array(max); this.a8 = new Float32Array(max); this.a48 = new Float32Array(2 * max + 16); }
    const m = this.ddc.push(fi, fq, n, this.oi, this.oq);
    this.comb?.processSplit(this.oi, this.oq, m);
    this.cw.push(this.oi, this.oq, m);
    const win = Math.round(this.fs * OFF_WIN_MS / 1000), envWin = Math.round(this.fs * ENV_MS / 1000), au = this.au;
    for (let i = 0; i < m; i++) {
      const a = this.oi[i], b = this.oq[i];
      const f = Math.atan2(b * this.pi - a * this.pq, a * this.pi + b * this.pq);
      this.pi = a; this.pq = b;
      au[i] = f;
      this.offAcc += f; if (++this.offN >= win) { this.means.push(this.offAcc / this.offN * this.fs / (2 * Math.PI)); this.offAcc = 0; this.offN = 0; }
      this.pow += a * a + b * b; this.powN++;
    }
    this.sub.push(au, m);
    this.speech.push(au, m);
    this.idc.push(au, m, this.clipped);
    this.subN += m;
    this.look();
    if (this.sub.tone) this.tones.set(this.sub.tone, (this.tones.get(this.sub.tone) ?? 0) + m);
    else if (this.sub.dcs) this.dcsCodes.set(this.sub.dcs, (this.dcsCodes.get(this.sub.dcs) ?? 0) + m);
    for (let i = 0; i < m; i++) { this.deemph += this.de * (au[i] - this.deemph); au[i] = this.deemph * 0.6; }
    this.lp.process(au, m, this.au2);
    const a2 = this.au2, hpa = 1 - Math.exp(-2 * Math.PI * 300 / this.fs);
    for (let i = 0; i < m; i++) {
      // the envelope of the voice band (a one-pole high-pass at 300 Hz keeps the sub-audible tone out of it)
      this.hp += hpa * (a2[i] - this.hp); const v = a2[i] - this.hp;
      this.envAcc += v * v; if (++this.envN >= envWin) { this.env.push(Math.sqrt(this.envAcc / this.envN)); this.envAcc = 0; this.envN = 0; }
    }
    const k8 = this.to8.process(a2, m, this.a8);
    if (this.digital()) {
      // a digital channel records and plays its decoded voice, as many 8 kHz samples as the FM audio would have been
      if (this.v8.length < k8) this.v8 = new Float32Array(2 * k8 + 16);
      this.pull(this.v8, k8); this.clip.push(this.v8, k8);
      if (this.a48.length < 6 * k8 + 16) this.a48 = new Float32Array(12 * k8 + 32);
      this.out48 = listen ? this.v48.process(this.v8, k8, this.a48) : 0;
    } else {
      this.clip.push(this.a8, k8);
      this.out48 = listen ? this.to48.process(a2, m, this.a48) : 0;
    }
    if (this.powN > this.fs / 10) { this.levelDb = 10 * Math.log10(this.pow / this.powN + 1e-9); this.pow = 0; this.powN = 0; }
  }
  /** Carrier offset: the median of the 100 ms means (a burst of clicks moves one mean, not the median), and their spread. */
  offset(skip = 0): { hz: number; sd: number } {
    const ms = this.means.slice(skip); if (ms.length < 3) return { hz: NaN, sd: 0 };
    const s = [...ms].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)];
    const q1 = s[Math.floor(s.length / 4)], q3 = s[Math.floor(s.length * 3 / 4)];
    return { hz: med, sd: (q3 - q1) / 1.35 / Math.sqrt(ms.length) };
  }
  /** The tone (or code) heard through most of the transmission: half of it at least, so a moment of voice read as a tone does not count. */
  static top(m: Map<number, number>, total: number, share = TONE_SHARE): number { let b = 0, v = 0; for (const [k, n] of m) if (n > v) { v = n; b = k; } return v >= share * total ? b : 0; }
  /** The share of the transmission a DCS code must be read through (GMRS asks less: see its DCS_SHARE). */
  dcsShare = TONE_SHARE;
  tone(): number { return Probe.top(this.tones, this.subN); }
  dcs(): number { return this.tone() ? 0 : Probe.top(this.dcsCodes, this.subN, this.dcsShare); }
  end(): void { this.cw.end(); this.idc.analog.flush(); this.snapAt = -1; this.look(); }
}

export interface Open<P extends WatchProbe = WatchProbe> {
  id: number; k: number; hz: number; startMs: number; quietMs: number; peak: number; snr: number; probe: P | null; cut: boolean; shifted: boolean; tileKey: string;
  /** Its demodulator heard a voice ([SPEECH_MIN] speech blocks): a transmission. Until then a steady carrier, which no
   *  count, log, recording, listening or scan takes. One no demodulator measures (all were busy) counts as before. */
  talk: boolean;
  /** When its demodulator started (engine ms): the speech meter's time is from here. */
  probeAt: number;
  /** When its carrier came up (startMs as it opened, before a late voice moves startMs). */
  keyMs: number;
  /** Part of one wideband event (one tone or one audio opening many channels at once): shown once, never counted. */
  flood: boolean;
  /** Keyed in the same second as [FLOOD_MIN] or more others: not counted until this (engine ms), while the event check
   *  reads their tones and audio. */
  holdUntil: number;
}

/** The span's noise: the power the quietest quarter of its channels sit at (a carrier or a hundred barely move it). */
export function quietQuarter(power: Float32Array | number[], count: number): number {
  if (count <= 0) return 0;
  const v = Array.from(power.slice(0, count)).sort((a, b) => a - b);
  return v[Math.floor((count - 1) / 4)];
}

/**
 * Every channel of a plan in the span at once: the measurement, the opening and closing, the demodulators and their
 * cap, the listening, the time machine and the snapshot. What is HAM+'s own (its plan, its FM probe) or CB's comes in
 * through [WatchPlan], [makeProbe] and [gate].
 */
export abstract class ChannelWatch<P extends WatchProbe> implements IqProcessor {
  readonly wantsFm = false;
  centerHz = 146_001_250;
  params: HpParams = { thresholdDb: 8, mode: 'newest', volume: 1 };
  readonly tracker: HamTracker;
  readonly clips = new ClipStore();
  /** Wall-clock anchoring: the engine's time is the samples it has had; it follows the wall clock when [followClock]. */
  followClock = true;
  protected rate = 0; private samples = 0; private baseMs = 0;
  protected nfft = 4096; private re = new Float32Array(0); private im = new Float32Array(0); private win = new Float32Array(0); private acc = new Float32Array(0); private frames = 0;
  protected fi = new Float32Array(0); protected fq = new Float32Array(0);
  protected first = 0; protected count = 0; protected hamBand = new Uint8Array(0);
  protected power = new Float32Array(0); protected floor = new Float32Array(0); protected snr = new Float32Array(0);
  protected readonly opens = new Map<number, Open<P>>();
  /** The span's noise at the last measurement, and until when the gain is settling (engine ms). */
  private commons: number[] = []; private settleUntil = 0;
  private nextId = 1;
  private lastMeasure = 0; private lastSnap = 0; private lastCap = 0; private lastLog = 0; private lastCenter = 0;
  /** Probe processing time measured: ms a probe takes per second of signal (smoothed), and the cap it sets. */
  costMs = 0; cap = CAP_START;
  /** A cap set from outside (tests, a device setting); 0 lets the measurement set it. */
  fixedCap = 0; private costT = 0; private costSig = 0; private costProbeS = 0;
  private outChunk = new Float32Array(2048); private outLen = 0; private mix = new Float32Array(0);
  private replay: { mixer: ReplayMixer; label: string; kind: string; to48: Resampler; buf8: Float32Array; buf48: Float32Array; acc: number } | null = null;
  playing: string[] = [];
  /** The receiver clipped within [CLIP_HOLD_MS]: probes are told, so nothing digital is named from it. */
  protected clipUntil = 0;
  /** Clipping is checked on this watcher's buffers (CB leaves it off). */
  protected checkClip = false;

  constructor(readonly plan: WatchPlan, protected readonly emit: Emit, private readonly sink: (chunk: Float32Array) => void, private readonly clock: () => number = () => Date.now(), private readonly perf: () => number = () => performance.now(), tracker?: (now: () => number) => HamTracker) {
    this.tracker = tracker ? tracker(() => this.nowMs()) : new HamTracker(() => this.nowMs());
  }
  /** A demodulator for a carrier at [hz] (tile [key]). */
  protected abstract makeProbe(hz: number, key: string): P;
  nowMs(): number { return this.baseMs + this.samples * 1000 / Math.max(1, this.rate); }

  setParams(p: Partial<HpParams>): void { Object.assign(this.params, p); }
  setPrefs(p: HpPrefs, labels?: Record<string, string>): void { this.tracker.prefs = p; if (labels) this.tracker.labels = labels; }
  restore(s: HpSaved | null): void { this.tracker.restore(s); }

  reset(rate: number): void {
    this.rate = rate; this.samples = 0; this.baseMs = this.clock();
    this.nfft = this.plan.nfft(rate);
    this.re = new Float32Array(this.nfft); this.im = new Float32Array(this.nfft); this.win = hann(this.nfft); this.acc = new Float32Array(this.nfft); this.frames = 0;
    this.closeAll(); this.layout();
    this.emit({ type: 'log', line: `${this.plan.name}: ${(rate / 1e6).toFixed(2)} Msps · ${this.count} channels on a ${this.plan.raster / 1e3} kHz raster · probe cap ${this.cap}` });
  }
  protected layout(): void {
    const half = this.plan.spanHalf(this.rate), R = this.plan.raster;
    const first = Math.ceil((this.centerHz - half) / R), last = Math.floor((this.centerHz + half) / R);
    this.first = first; this.count = Math.max(0, last - first + 1);
    // only the plan's bands open channels: a span reaching past a band's edge leaves the rest alone
    this.hamBand = new Uint8Array(this.count); for (let k = 0; k < this.count; k++) this.hamBand[k] = this.plan.inPlan(this.hzOf(k)) ? 1 : 0;
    this.power = new Float32Array(this.count).fill(-120); this.floor = new Float32Array(this.count).fill(NaN); this.snr = new Float32Array(this.count);
    this.lastCenter = this.centerHz; this.commons = []; this.settleUntil = 0;
    this.tracker.setSpan(this.centerHz - half, this.centerHz + half);
  }
  protected hzOf(k: number): number { return (this.first + k) * this.plan.raster; }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    if (this.centerHz !== this.lastCenter) { this.closeAll(); this.acc.fill(0); this.frames = 0; this.layout(); }
    const n = iq.length >> 1;
    if (this.fi.length < n) { this.fi = new Float32Array(n); this.fq = new Float32Array(n); }
    for (let k = 0; k < n; k++) { this.fi[k] = iq[2 * k] + 0.5; this.fq[k] = iq[2 * k + 1] + 0.5; }
    const N = this.nfft, step = Math.max(N, Math.floor(n / 4));
    for (let off = 0; off + N <= n && this.frames < 16; off += step) {
      for (let k = 0; k < N; k++) { this.re[k] = this.fi[off + k] * this.win[k]; this.im[k] = this.fq[off + k] * this.win[k]; }
      fft(this.re, this.im);
      for (let k = 0; k < N; k++) this.acc[k] += this.re[k] * this.re[k] + this.im[k] * this.im[k];
      this.frames++;
    }
    this.samples += n;
    if (this.checkClip && iqClipping(iq, iq.length, 16)) this.clipUntil = this.nowMs() + CLIP_HOLD_MS;
    if (this.followClock && Math.abs(this.nowMs() - this.clock()) > 3_000) { this.baseMs = this.clock() - this.samples * 1000 / this.rate; }
    const now = this.nowMs();
    if (now - this.lastMeasure >= MEASURE_MS && this.frames > 0) { this.lastMeasure = now; this.measure(now); }
    this.runProbes(n, now);
    this.speechStep(now);
    if (now - this.lastSnap >= SNAP_MS) { this.lastSnap = now; this.post(now); }
  }

  /** Channel powers, floors, SNRs; carriers open and close. */
  private measure(now: number): void {
    const N = this.nfft, binHz = this.rate / N, half = Math.max(1, Math.round(4_000 / binHz));
    const pdb = new Float32Array(N);
    for (let k = 0; k < N; k++) pdb[(k + N / 2) % N] = this.acc[k] / this.frames;
    this.acc.fill(0); this.frames = 0;
    for (let k = 0; k < this.count; k++) {
      const c = Math.round((this.hzOf(k) - this.centerHz) / binHz) + N / 2;
      let s = 0, cnt = 0;
      for (let b = Math.max(1, c - half); b <= Math.min(N - 2, c + half); b++) { s += pdb[b]; cnt++; }
      const db = 10 * Math.log10(s / Math.max(1, cnt) + 1e-12);
      this.power[k] = db;
    }
    // each channel's floor is kept against the span's own noise (its quietest quarter), so a gain change (AGC, LNA, amp)
    // that lifts the whole span moves no channel: only a carrier rises above its neighbors
    const common = quietQuarter(this.power, this.count);
    // a gain step: until it has settled, every channel not open takes its level as its floor, so none opens on it
    if (this.count >= GAIN_MIN_CH && this.commons.length >= GAIN_REF) {
      const ref = [...this.commons].sort((a, b) => a - b)[GAIN_REF >> 1];
      if (Math.abs(common - ref) >= GAIN_STEP_DB) this.settleUntil = now + SETTLE_MS;
    }
    this.commons.push(common); if (this.commons.length > GAIN_REF) this.commons.shift();
    const settling = now < this.settleUntil, held = new Set<number>();
    if (settling) for (const o of this.opens.values()) for (let d = -1; d <= 1; d++) held.add(o.k + d);
    for (let k = 0; k < this.count; k++) {
      const rel = this.power[k] - common, f = this.floor[k];
      this.floor[k] = Number.isNaN(f) || (settling && !held.has(k)) ? rel : rel < f ? f + 0.3 * (rel - f) : f + 0.004 * (rel - f);
      this.snr[k] = rel - this.floor[k];
    }
    this.gate(now, pdb, binHz);
  }
  /** Which channels open and close, on the measurement just made ([pdb]: the span's power a bin, DC in the middle). */
  protected gate(now: number, _pdb: Float32Array, _binHz: number): void {
    const p = this.params, pl = this.plan;
    const nearDc = (k: number) => Math.abs(this.hzOf(k) - this.centerHz) < 6_000;
    // open channels: still above the closing level near their raster point?
    for (const o of [...this.opens.values()]) {
      let best = -99; for (let d = -1; d <= 1; d++) { const j = o.k + d; if (j >= 0 && j < this.count) best = Math.max(best, this.snr[j]); }
      o.snr = best; o.peak = Math.max(o.peak, best);
      if (best > p.thresholdDb - 3) o.quietMs = 0;
      else if (!o.quietMs) o.quietMs = now;
      else if (now - o.quietMs >= CLOSE_HOLD_MS) this.close(o, o.quietMs);
    }
    // new carriers: over the threshold, the strongest raster point within 7.5 kHz, clear of the open ones
    for (let k = 0; k < this.count; k++) {
      if (this.snr[k] <= p.thresholdDb || nearDc(k) || !this.hamBand[k]) continue;
      let peak = true; for (let d = -pl.peakSteps; d <= pl.peakSteps && peak; d++) { const j = k + d; if (d && j >= 0 && j < this.count && this.power[j] > this.power[k]) peak = false; }
      if (!peak) continue;
      let clear = true; for (const o of this.opens.values()) if (Math.abs(o.k - k) <= pl.clearSteps) { clear = false; break; }
      if (!clear) continue;
      this.openAt(k, now);
    }
  }

  protected tileKey(hz: number): string { return chanKey(this.tracker.tileHz(hz)); }
  private wanted(key: string): boolean { const pr = this.tracker.prefs; return pr.hold === key || pr.prio.includes(key); }
  protected probes(): number { let n = 0; for (const o of this.opens.values()) if (o.probe) n++; return n; }

  protected openAt(k: number, now: number): Open<P> {
    const hz = this.hzOf(k), key = this.tileKey(hz);
    const o: Open<P> = { id: this.nextId++, k, hz, startMs: now - MEASURE_MS, quietMs: 0, peak: this.snr[k], snr: this.snr[k], probe: null, cut: false, shifted: false, tileKey: key, talk: true, probeAt: now, keyMs: now - MEASURE_MS, flood: false, holdUntil: 0 };
    // the radio's own spur: shown as a steady carrier, never demodulated, counted or logged
    if (this.ownSpur(hz)) { o.talk = false; this.opens.set(o.id, o); return o; }
    if (this.fixedCap) this.cap = this.fixedCap;
    if (this.probes() >= this.cap && this.wanted(key)) {
      // a followed or priority channel takes the probe of the newest other one, which is then marked cut
      const victim = [...this.opens.values()].filter(x => x.probe && !this.wanted(x.tileKey)).sort((a, b) => b.startMs - a.startMs)[0];
      if (victim) { if (victim.probe?.speech.heard) victim.talk = true; victim.probe = null; victim.cut = true; }
    }
    if (this.probes() < this.cap) this.attach(o, now);
    this.opens.set(o.id, o);
    // many keyed in the same second wait for the wideband-event check before any of them counts
    const near = [...this.opens.values()].filter(x => Math.abs(x.keyMs - o.keyMs) <= FLOOD_WIN_MS);
    if (near.length >= FLOOD_MIN) for (const x of near) if (!x.holdUntil) x.holdUntil = x.keyMs + FLOOD_HOLD_MS;
    return o;
  }
  /** Gives an open channel a demodulator: from now it is a transmission only once that hears a voice. */
  /**
   * A short burst is no talker: its speech must span TALK_SPAN_MS (a courtesy beep or a kerchunk is
   * shorter), and a channel keyed with a much stronger one beside it (GHOST_HZ, GHOST_DB, within GHOST_MS) is that
   * one's splatter (a DMR repeater's FSK reads as a data burst 20 kHz off), not a talker of its own.
   */
  protected ghost(o: Open<P>): boolean {
    for (const x of this.opens.values()) if (x !== o && Math.abs(x.hz - o.hz) <= GHOST_HZ && x.peak - o.peak >= GHOST_DB && Math.abs(x.keyMs - o.keyMs) <= GHOST_MS) return true;
    return false;
  }
  protected attach(o: Open<P>, now: number): void { o.probe = this.makeProbe(o.hz, o.tileKey); o.probeAt = now; o.talk = false; }
  /** When the open channel's voice was last heard (engine ms), or -1. */
  protected lastSpeech(o: Open<P>): number { const s = o.probe?.speech; return s && s.lastMs >= 0 ? o.probeAt + s.lastMs : -1; }
  /** Open channels holding a carrier with no voice: how many, and each one's frequency, since when and its level. */
  steadyOpens(now: number): { hz: number; key: string; sinceMs: number; levelDb: number; own: boolean }[] {
    return [...this.opens.values()].filter(o => !o.talk && now - o.startMs >= STEADY_SHOW_MS).map(o => ({ hz: o.hz, key: o.tileKey, sinceMs: o.startMs, levelDb: o.probe ? Math.round(o.probe.levelDb) : -90, own: this.ownSpur(o.hz) }));
  }
  /**
   * The attached radio's own spurs are every [ownSpurStep] Hz (0: none known). An RTL-SDR's R820T or R828D makes one at
   * each harmonic of its 28.8 MHz reference (432.000 is the 15th): a steady carrier with a drone on it that no one sends,
   * so a carrier within OWN_SPUR_HZ of one gets no demodulator and is never a transmission.
   */
  ownSpurStep = 0;
  ownSpur(hz: number): boolean { const st = this.ownSpurStep; if (st <= 0) return false; const r = hz % st; return Math.min(r, st - r) <= OWN_SPUR_HZ; }
  /** A voice first heard this long after its carrier came up starts the transmission (CB's AM measure takes longer). */
  protected talkLateMs = TALK_LATE_MS;
  /** Speech: an open channel becomes a transmission once its voice is heard, and one whose voice has stopped for
   *  [SPEECH_LAPSE_MS] while its carrier stays ends at its last word (the carrier left on is steady from there). */
  private speechStep(now: number): void {
    for (const o of [...this.opens.values()]) {
      const p = o.probe; if (!p) continue;
      if (!o.talk) {
        // a named digital mode is a transmission (its voice is not FM speech)
        if (p.digital?.()) { o.talk = true; continue; }
        if (!p.speech.heard || p.speech.lastMs - p.speech.firstMs < TALK_SPAN_MS || this.ghost(o)) continue;
        o.talk = true;
        // a carrier that was up a while before its voice (a carrier left on, then a talker) starts at the voice
        const first = o.probeAt + p.speech.firstMs - SPEECH_BLOCK_MS;
        if (first - o.startMs > this.talkLateMs) o.startMs = first - TALK_PRE_MS;
        continue;
      }
      const last = p.digital?.() ? (p.lastDigitalMs! >= 0 ? o.probeAt + p.lastDigitalMs! : -1) : this.lastSpeech(o);
      if (last >= 0 && now - last > SPEECH_LAPSE_MS) this.close(o, last + CLOSE_HOLD_MS);
    }
  }

  protected close(o: Open<P>, endMs: number): void {
    this.opens.delete(o.id);
    // a carrier that never carried a voice, or one channel of a wideband event, is no transmission: nothing counted,
    // logged or kept
    if (!o.talk || o.flood) { this.steadyClosed(o, endMs); return; }
    if (endMs - o.startMs < TX_MIN_MS) return;
    const p = o.probe, off = p ? p.offset(2) : { hz: NaN, sd: 0 };
    if (p) p.end();
    const recorded = !!p && !o.cut, digital = !!p?.digital?.();
    const t: TxRec = {
      id: o.id, hz: o.hz, startMs: o.startMs, endMs, peakDb: Math.round(o.peak * 10) / 10, offsetHz: off.hz, offsetSd: off.sd,
      tone: p && !digital ? p.tone() : 0, dcs: p && !digital ? p.dcs() : 0, cw: p?.cwId?.() || p?.cw0 || '', ident: p?.ident?.() ?? null, env: Float32Array.from((p?.env ?? []).slice(Math.max(0, Math.round((o.startMs - o.probeAt) / ENV_MS)), Math.max(0, Math.round((o.startMs - o.probeAt) / ENV_MS)) + Math.ceil((endMs - o.startMs) / ENV_MS))), recorded,
    };
    // (the audio from the transmission's start: later than its demodulator's when the voice came after the carrier)
    const at = Math.max(0, Math.round((o.startMs - o.probeAt) * CLIP_RATE / 1000));
    if (recorded) this.clips.add({ id: o.id, chan: o.hz, startMs: o.startMs, data: p!.clip.done().slice(at, at + Math.round((endMs - o.startMs) * CLIP_RATE / 1000)) });
    this.closed(o, t);
    this.tracker.addTx(t);
  }
  /** A steady carrier went (or the span moved): HAM+ keeps nothing of it. */
  protected steadyClosed(_o: Open<P>, _endMs: number): void { /* nothing */ }
  /** A finished transmission, just before the tracker has it. */
  protected closed(_o: Open<P>, _t: TxRec): void { /* HAM+ keeps nothing more */ }
  protected closeAll(): void { const now = this.nowMs(); for (const o of [...this.opens.values()]) this.close(o, now); }

  /** A channel that counts: a voice heard on it, and not one channel of a wideband event. */
  protected counted(o: Open<P>): boolean { return o.talk && !o.flood && this.nowMs() >= o.holdUntil; }
  /**
   * Whether two open channels carry the same audio right now: their voice envelopes over the last [LINK_LIVE_MAX]
   * frames (5 s) both have, lined up in time (each demodulator's frames start when it did), correlating at the best
   * lag within [LINK_LIVE_LAG] frames either way. The last five seconds, not the first: a carrier up before its talker
   * (a tail, a courtesy tone) is judged on the speech. The link check and the wideband-event check both ask this, so
   * they never disagree.
   */
  sameAudio(x: Open<P>, y: Open<P>): number {
    const a = x.probe?.env, b = y.probe?.env; if (!a || !b) return -1;
    const end = Math.min(x.probeAt + a.length * ENV_MS, y.probeAt + b.length * ENV_MS);
    const start = Math.max(x.probeAt, y.probeAt, end - LINK_LIVE_MAX * ENV_MS), n = Math.floor((end - start) / ENV_MS);
    if (n < LINK_LIVE_FRAMES) return -1;
    const ia = Math.round((start - x.probeAt) / ENV_MS), ib = Math.round((start - y.probeAt) / ENV_MS);
    return envCorr(Float32Array.from(a.slice(ia, ia + n)), Float32Array.from(b.slice(ib, ib + n)), 0, LINK_LIVE_LAG);
  }
  /** Pairs of open channels (by id) heard carrying the same audio right now: linked repeaters. */
  private readonly liveLinked = new Set<string>();
  private linkAt = 0;
  /** The wideband event on the air now, if any: how many channels, their span, the tone they share (0 when the audio was the match). */
  flood: { channels: number; loHz: number; hiHz: number; tone: number; sinceMs: number } | null = null;
  /** Four times a second: open channels that keyed up together are compared for the same audio (linked repeaters), and
   *  many keyed up together on one tone or one audio are one wideband event. */
  private checkLinks(now: number): void {
    if (now - this.linkAt < 250) return;
    this.linkAt = now;
    this.checkFlood();
    const os = [...this.opens.values()].filter(o => this.counted(o) && o.probe && o.probe.env.length >= LINK_LIVE_FRAMES);
    const ids = new Set(os.map(o => o.id));
    for (const k of [...this.liveLinked]) { const [a, b] = k.split('|').map(Number); if (!ids.has(a) || !ids.has(b)) this.liveLinked.delete(k); }
    for (let i = 0; i < os.length; i++) for (let j = i + 1; j < os.length; j++) {
      const [x, y] = os[i].keyMs <= os[j].keyMs ? [os[i], os[j]] : [os[j], os[i]];
      if (Math.abs(x.hz - y.hz) < 50_000 || y.keyMs - x.keyMs > LINK_EDGE_MS || x.tileKey === y.tileKey) continue;
      const key = `${x.id}|${y.id}`; if (this.liveLinked.has(key)) continue;
      if (this.sameAudio(x, y) >= LINK_CORR) this.liveLinked.add(key);
    }
    const tiles = new Set<string>();
    for (const k of this.liveLinked) { const [a, b] = k.split('|').map(Number), oa = this.opens.get(a), ob = this.opens.get(b); if (oa && ob) tiles.add([oa.tileKey, ob.tileKey].sort().join('|')); }
    this.tracker.liveLinks = tiles;
  }
  /**
   * One signal smeared across the span (overload, intermod, a strong signal leaking in) opens many unrelated channels in
   * the same second, all on one sub-audible tone or all carrying one audio. [FLOOD_MIN] or more channels keyed within
   * [FLOOD_WIN_MS] of each other that share a tone, or the same audio by [sameAudio], are one wideband event: shown
   * once, none of them counted as talking, logged, kept or holding the scan. A linked pair or trio stays under it.
   */
  private checkFlood(): void {
    const os = [...this.opens.values()].filter(o => o.talk && o.probe);
    let best: Open<P>[] = [], tone = 0;
    for (const a of os) {
      const near = os.filter(o => Math.abs(o.keyMs - a.keyMs) <= FLOOD_WIN_MS);
      if (near.length < FLOOD_MIN) continue;
      const t = a.probe!.tone(), byTone = t ? near.filter(o => Math.abs(o.probe!.tone() - t) < 0.6) : [];
      const byAudio = near.filter(o => o === a || this.sameAudio(a, o) >= LINK_CORR);
      const g = byTone.length >= byAudio.length ? byTone : byAudio;
      if (g.length >= FLOOD_MIN && g.length > best.length) { best = g; tone = g === byTone ? t : 0; }
    }
    for (const o of best) o.flood = true;
    // (and the ones keyed with them that no demodulator measures: the event took the demodulators)
    if (best.length) { const k = best.map(o => o.keyMs).sort((a, b) => a - b)[best.length >> 1]; for (const o of this.opens.values()) if (!o.probe && Math.abs(o.keyMs - k) <= FLOOD_WIN_MS) o.flood = true; }
    const on = [...this.opens.values()].filter(o => o.flood);
    this.flood = on.length ? { channels: on.length, loHz: Math.min(...on.map(o => o.hz)), hiHz: Math.max(...on.map(o => o.hz)), tone: tone || (this.flood?.tone ?? 0), sinceMs: Math.min(...on.map(o => o.keyMs)) } : null;
  }
  /** Two open channels carry the same audio: heard linked right now, or a link learned before. */
  private linkedNow(a: Open<P>, b: Open<P>): boolean {
    return this.liveLinked.has(`${a.id}|${b.id}`) || this.liveLinked.has(`${b.id}|${a.id}`) || this.tracker.linked(a.tileKey, b.tileKey);
  }

  /**
   * Which open channels are heard: the followed one alone; else priority ones when open; else all (mix) or the newest.
   * Linked repeaters carry the same voice a little apart, an echo when mixed: only one copy is heard, the stronger.
   */
  private listenSet(): Open<P>[] {
    const pr = this.tracker.prefs;
    let c = [...this.opens.values()].filter(o => this.counted(o) && o.probe && !pr.mute.includes(o.tileKey));
    // a repeater input is the same voice as its output: the output is heard
    c = c.filter(o => !(this.tracker.outputOf(o.hz) && c.some(x => x.tileKey === o.tileKey && x !== o)));
    if (pr.hold) return c.filter(o => o.tileKey === pr.hold);
    const pri = c.filter(o => pr.prio.includes(o.tileKey));
    if (pri.length) c = pri;
    const one: Open<P>[] = [];
    for (const o of [...c].sort((a, b) => b.snr - a.snr)) if (!one.some(k => this.linkedNow(k, o))) one.push(o);
    c = one;
    c.sort((a, b) => a.startMs - b.startMs);
    return this.params.mode === 'newest' ? c.slice(-1) : c.slice(-4);
  }

  private runProbes(n: number, now: number): void {
    this.checkLinks(now);
    const listen = this.replay ? [] : this.listenSet();
    this.playing = listen.map(o => o.tileKey);
    const t0 = this.perf();
    let voices = 0, m = 0, probes = 0;
    for (const o of this.opens.values()) {
      const p = o.probe; if (!p) continue;
      probes++;
      const hear = listen.includes(o);
      p.clipped = now < this.clipUntil;
      p.push(this.fi, this.fq, n, hear);
      // a carrier that is off its channel by more than half a step moves to the right one, once (on a 6.25 kHz
      // grid that can be a channel between two raster points, kept at its own frequency)
      if (this.plan.snap && !o.shifted && now - o.startMs > 500) {
        o.shifted = true;
        const off = p.offset(1), g = this.plan.grid?.(o.hz) ?? HP_RASTER, shift = Math.round((o.hz + off.hz) / g) * g - o.hz;
        if (shift && Math.abs(off.hz - shift) < Math.abs(off.hz)) {
          o.k += Math.round(shift / HP_RASTER); o.hz += shift; o.tileKey = this.tileKey(o.hz); p.retune(o.hz - this.centerHz);
          for (let i = 0; i < p.means.length; i++) p.means[i] -= shift;
        }
      }
      if (hear && p.out48 > 0) {
        if (this.mix.length < p.out48) this.mix = new Float32Array(2 * p.out48);
        if (voices === 0) { this.mix.set(p.a48.subarray(0, p.out48)); m = p.out48; } else for (let i = 0; i < Math.min(m, p.out48); i++) this.mix[i] += p.a48[i];
        voices++;
      }
    }
    const dt = this.perf() - t0;
    if (probes > 0) { this.costT += dt; this.costSig += n / this.rate; this.costProbeS += probes * n / this.rate; }
    if (now - this.lastCap > 2_000 && this.costProbeS > 0.5) {
      this.lastCap = now;
      const per = this.costT / this.costProbeS;
      this.costMs = this.costMs ? 0.7 * this.costMs + 0.3 * per : per;
      this.cap = this.fixedCap || Math.max(CAP_MIN, Math.min(CAP_MAX, Math.floor(BUDGET_MS / Math.max(0.1, this.costMs))));
      this.costT = 0; this.costSig = 0; this.costProbeS = 0;
      if (now - this.lastLog > 30_000) { this.lastLog = now; this.emit({ type: 'log', line: `${this.plan.name}: demod cost ${this.costMs.toFixed(1)} ms per channel per second at ${(this.rate / 1e6).toFixed(2)} Msps, cap ${this.cap} channels` }); }
    }
    if (this.replay) { this.replayStep(n); return; }
    if (!voices) return;
    const g = this.params.volume / Math.sqrt(voices);
    for (let i = 0; i < m; i++) this.out(this.mix[i] * g);
  }
  private out(v: number): void { this.outChunk[this.outLen++] = v > 1 ? 1 : v < -1 ? -1 : v; if (this.outLen >= this.outChunk.length) { this.sink(this.outChunk.slice()); this.outLen = 0; } }

  /** Replays: one transmission, the transmissions of a conversation, or the whole band from a moment on. */
  replayTx(ids: number[], label: string, kind: string): boolean {
    const clips = ids.map(id => this.clips.get(id)).filter((c): c is Clip => !!c);
    if (!clips.length) return false;
    const parts = planReplay(clips).map(p => ({ ...p, data: this.clips.get(p.id)!.data }));
    this.replay = { mixer: new ReplayMixer(parts, this.params.volume), label, kind, to48: new Resampler(48_000 / CLIP_RATE), buf8: new Float32Array(4096), buf48: new Float32Array(4096 * 6 + 16), acc: 0 };
    return true;
  }
  /** The band from a moment on; after the last transmission, from the last one heard. False only when nothing is kept. */
  replayFrom(ms: number): boolean {
    const plan = replayFromPlan(this.clips.all().map(c => ({ id: c.id, startMs: c.startMs, endMs: c.startMs + c.data.length * 1000 / CLIP_RATE })), ms);
    return this.replayTx(plan.ids, `the band from ${new Date(plan.fromMs).toTimeString().slice(0, 8)}`, 'band');
  }
  stopReplay(): void { this.replay = null; }
  /** Forgets everything heard: the channels, stations, pairs, links, the activity map and the time machine. */
  clear(): void { this.replay = null; this.tracker.clear(); this.tracker.heat = { bands: [], cover: new Array(HEAT_SLOTS).fill(0) }; this.clips.clear(); }
  private replayStep(n: number): void {
    const r = this.replay!; r.acc += n * CLIP_RATE / this.rate;
    while (r.acc >= 1) {
      const k = Math.min(r.buf8.length, Math.floor(r.acc)); r.acc -= k;
      const got = r.mixer.next(r.buf8, k);
      const q = r.to48.process(r.buf8, got, r.buf48);
      for (let i = 0; i < q; i++) this.out(r.buf48[i]);
      if (r.mixer.done) { this.replay = null; return; }
    }
  }
  replayState(): { active: boolean; label: string; kind: string; clip: number; pos: number; total: number } {
    const r = this.replay;
    return r ? { active: true, label: r.label, kind: r.kind, clip: r.mixer.current(), pos: r.mixer.pos / CLIP_RATE, total: r.mixer.total / CLIP_RATE } : { active: false, label: '', kind: '', clip: -1, pos: 0, total: 0 };
  }

  /** The channels open now, as the tracker takes them. */
  liveRecs(): LiveRec[] {
    return [...this.opens.values()].filter(o => this.counted(o)).map(o => {
      const off = o.probe ? o.probe.offset(2) : { hz: NaN, sd: 0 };
      return { id: o.id, hz: o.hz, startMs: o.startMs, snrDb: Math.round(o.snr * 10) / 10, levelDb: o.probe ? Math.round(o.probe.levelDb) : -90, offsetHz: off.hz, tone: o.probe && !o.probe.digital?.() ? o.probe.tone() : 0, dcs: o.probe && !o.probe.digital?.() ? o.probe.dcs() : 0, recorded: !!o.probe && !o.cut, ident: o.probe?.ident?.() ?? null };
    });
  }

  /** The whole picture, twice a second. */
  snapshot(now = this.nowMs()) {
    const tr = this.tracker;
    tr.setLive(this.liveRecs()); tr.judge(now);
    const rows = tr.rows(now, 400);
    for (const r of rows) r.recorded = r.recorded && (r.live || this.clips.has(r.id));
    const convs = tr.convs(rows, now).slice(0, 80);
    const tiles = tr.tiles(now, rows);
    return {
      now, centerHz: this.centerHz, rate: this.rate, spanLo: tr.spanLo, spanHi: tr.spanHi, tiles, rows, convs, heat: tr.heat, playing: this.playing, replay: this.replayState(),
      steady: this.steadyOpens(now), flood: this.flood,
      stats: { onAir: [...this.opens.values()].filter(o => this.counted(o)).length, steady: this.steadyOpens(now).length, own: this.steadyOpens(now).filter(x => x.own).map(x => x.hz), stations: tr.stationCount, probes: this.probes(), cap: this.cap, costMs: Math.round(this.costMs * 10) / 10, clipS: Math.round(this.clips.seconds), clipMB: Math.round(this.clips.bytes / 1e5) / 10, capMB: Math.round(this.clips.cap / 1e5) / 10, oldestMs: this.clips.oldestMs(), channels: this.count },
    };
  }
  protected post(now: number): void { this.emit({ type: this.plan.type, ...this.snapshot(now) }); }
}

/** HAM+: every FM channel on the ham bands at once. */
export class HamPlusEngine extends ChannelWatch<Probe> {
  constructor(emit: Emit, sink: (chunk: Float32Array) => void, clock: () => number = () => Date.now(), perf: () => number = () => performance.now()) {
    super(HAM_PLAN, emit, sink, clock, perf);
    this.checkClip = true;
  }
  /** What this span's 10 m channels found of the HF comb, so a new transmission starts with its lines known. */
  private readonly combMem = new CombMemory();
  protected makeProbe(hz: number): Probe {
    const comb = hz < COMB_TOP_HZ ? (fs: number) => new CombNotch(fs, 7_000, line => this.emit({ type: 'log', line }), 30, this.combMem) : null;
    return new Probe(this.rate, hz - this.centerHz, comb, this.centerHz);
  }
}
export type HpSnap = ReturnType<HamPlusEngine['snapshot']>;
