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
 * Probes are capped by what the processor sustains: the time they take is measured and the cap set to fill
 * [BUDGET_MS] a second. A transmission without a probe is marked not recorded; none is dropped silently.
 */
import type { Emit, IqProcessor } from '../core.js';
import { fft, hann } from '../../fft.js';
import { Ddc } from '../trains.js';
import { RealFir, Resampler, lowpassTaps } from '../ham/filters.js';
import { SubAudioDecoder } from '../ham/ctcss.js';
import { CwReader } from '../fleet/rx.js';
import { HP_RASTER, hpBandOf } from './plan.js';
import { ClipStore, ClipWriter, CLIP_RATE, planReplay, replayFromPlan, ReplayMixer, type Clip } from './clips.js';
import { HamTracker, ENV_MS, HEAT_SLOTS, LINK_CORR, LINK_EDGE_MS, chanKey, envCorr, type HpPrefs, type HpSaved, type LiveRec, type TxRec } from './tracker.js';

/** Envelope a pair of open channels needs before they are compared for the same audio (1.5 s), the most compared (10 s), and how far either side of the keyup gap the lag is searched (300 ms). */
export const LINK_LIVE_FRAMES = 30, LINK_LIVE_MAX = 200, LINK_LIVE_LAG = 6;

export const PROBE_RATE = 24_000;
/** Processor time a second the probes may take, and the cap's bounds. */
export const BUDGET_MS = 450, CAP_MIN = 2, CAP_MAX = 32, CAP_START = 8;
/** A channel stays open this long below its closing level. */
export const CLOSE_HOLD_MS = 400;
/** Shorter than this is a noise blip, not a transmission. */
export const TX_MIN_MS = 250;
/** A tone must be heard through this share of a transmission to be its tone. */
export const TONE_SHARE = 0.5;
const MEASURE_MS = 100, SNAP_MS = 500, OFF_WIN_MS = 100;

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
}

/**
 * Where a watcher's channels are and how one opens. HAM+ watches every point of a 2.5 kHz raster inside the ham bands
 * and lets a carrier move to its own raster point; CB watches the 40 channels of its plan and nothing else.
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
}
export const HAM_PLAN: WatchPlan = {
  name: 'Repeaters', type: 'hamplus', raster: HP_RASTER, inPlan: hz => !!hpBandOf(hz),
  nfft: rate => 1 << Math.max(10, Math.min(14, Math.ceil(Math.log2(rate / 1000)))), spanHalf: rate => rate * 0.44 - 6_250,
  peakSteps: 3, clearSteps: 4, snap: true,
};

class Probe implements WatchProbe {
  readonly ddc = new Ddc(7_500, PROBE_RATE, 63);
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
  constructor(rate: number, readonly offsetHz: number) {
    this.ddc.reset(rate); this.ddc.offsetHz = offsetHz; this.fs = this.ddc.outRate;
    this.sub = new SubAudioDecoder(this.fs); this.cw = new CwReader(this.fs); this.cw.onText = t => { this.cw0 = (this.cw0 ? this.cw0 + ' ' : '') + t; };
    this.lp = new RealFir(lowpassTaps(3_000 / this.fs, 47));
    this.to8 = new Resampler(CLIP_RATE / this.fs); this.to48 = new Resampler(48_000 / this.fs);
    this.de = 1 - Math.exp(-1 / (this.fs * 530e-6));
  }
  retune(offsetHz: number): void { this.ddc.offsetHz = offsetHz; }
  push(fi: Float32Array, fq: Float32Array, n: number, listen: boolean): void {
    const max = this.ddc.maxOut(n);
    if (this.oi.length < max) { this.oi = new Float32Array(max); this.oq = new Float32Array(max); this.au = new Float32Array(max); this.au2 = new Float32Array(max); this.a8 = new Float32Array(max); this.a48 = new Float32Array(2 * max + 16); }
    const m = this.ddc.push(fi, fq, n, this.oi, this.oq);
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
    this.subN += m;
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
    const k8 = this.to8.process(a2, m, this.a8); this.clip.push(this.a8, k8);
    this.out48 = listen ? this.to48.process(a2, m, this.a48) : 0;
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
  static top(m: Map<number, number>, total: number): number { let b = 0, v = 0; for (const [k, n] of m) if (n > v) { v = n; b = k; } return v >= TONE_SHARE * total ? b : 0; }
  tone(): number { return Probe.top(this.tones, this.subN); }
  dcs(): number { return this.tone() ? 0 : Probe.top(this.dcsCodes, this.subN); }
  end(): void { this.cw.end(); }
}

export interface Open<P extends WatchProbe = WatchProbe> { id: number; k: number; hz: number; startMs: number; quietMs: number; peak: number; snr: number; probe: P | null; cut: boolean; shifted: boolean; tileKey: string }

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
  params: HpParams = { thresholdDb: 8, mode: 'mix', volume: 1 };
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
  private nextId = 1;
  private lastMeasure = 0; private lastSnap = 0; private lastCap = 0; private lastLog = 0; private lastCenter = 0;
  /** Probe processing time measured: ms a probe takes per second of signal (smoothed), and the cap it sets. */
  costMs = 0; cap = CAP_START;
  /** A cap set from outside (tests, a device setting); 0 lets the measurement set it. */
  fixedCap = 0; private costT = 0; private costSig = 0; private costProbeS = 0;
  private outChunk = new Float32Array(2048); private outLen = 0; private mix = new Float32Array(0);
  private replay: { mixer: ReplayMixer; label: string; kind: string; to48: Resampler; buf8: Float32Array; buf48: Float32Array; acc: number } | null = null;
  playing: string[] = [];

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
    // only the ham bands open channels: a span reaching past a band's edge leaves the rest alone
    this.hamBand = new Uint8Array(this.count); for (let k = 0; k < this.count; k++) this.hamBand[k] = this.plan.inPlan(this.hzOf(k)) ? 1 : 0;
    this.power = new Float32Array(this.count).fill(-120); this.floor = new Float32Array(this.count).fill(NaN); this.snr = new Float32Array(this.count);
    this.lastCenter = this.centerHz;
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
    if (this.followClock && Math.abs(this.nowMs() - this.clock()) > 3_000) { this.baseMs = this.clock() - this.samples * 1000 / this.rate; }
    const now = this.nowMs();
    if (now - this.lastMeasure >= MEASURE_MS && this.frames > 0) { this.lastMeasure = now; this.measure(now); }
    this.runProbes(n, now);
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
    for (let k = 0; k < this.count; k++) {
      const rel = this.power[k] - common, f = this.floor[k];
      this.floor[k] = Number.isNaN(f) ? rel : rel < f ? f + 0.3 * (rel - f) : f + 0.004 * (rel - f);
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
    const o: Open<P> = { id: this.nextId++, k, hz, startMs: now - MEASURE_MS, quietMs: 0, peak: this.snr[k], snr: this.snr[k], probe: null, cut: false, shifted: false, tileKey: key };
    if (this.fixedCap) this.cap = this.fixedCap;
    if (this.probes() >= this.cap && this.wanted(key)) {
      // a followed or priority channel takes the probe of the newest other one, which is then marked cut
      const victim = [...this.opens.values()].filter(x => x.probe && !this.wanted(x.tileKey)).sort((a, b) => b.startMs - a.startMs)[0];
      if (victim) { victim.probe = null; victim.cut = true; }
    }
    if (this.probes() < this.cap) o.probe = this.makeProbe(hz, key);
    this.opens.set(o.id, o);
    return o;
  }

  protected close(o: Open<P>, endMs: number): void {
    this.opens.delete(o.id);
    if (endMs - o.startMs < TX_MIN_MS) return;
    const p = o.probe, off = p ? p.offset(2) : { hz: NaN, sd: 0 };
    if (p) p.end();
    const recorded = !!p && !o.cut;
    const t: TxRec = {
      id: o.id, hz: o.hz, startMs: o.startMs, endMs, peakDb: Math.round(o.peak * 10) / 10, offsetHz: off.hz, offsetSd: off.sd,
      tone: p ? p.tone() : 0, dcs: p ? p.dcs() : 0, cw: p?.cw0 ?? '', env: Float32Array.from((p?.env ?? []).slice(0, Math.ceil((endMs - o.startMs) / ENV_MS))), recorded,
    };
    if (recorded) this.clips.add({ id: o.id, chan: o.hz, startMs: o.startMs, data: p!.clip.done().slice(0, Math.round((endMs - o.startMs) * CLIP_RATE / 1000)) });
    this.closed(o, t);
    this.tracker.addTx(t);
  }
  /** A finished transmission, just before the tracker has it. */
  protected closed(_o: Open<P>, _t: TxRec): void { /* HAM+ keeps nothing more */ }
  protected closeAll(): void { const now = this.nowMs(); for (const o of [...this.opens.values()]) this.close(o, now); }

  /** Pairs of open channels (by id) heard carrying the same audio right now: linked repeaters. */
  private readonly liveLinked = new Set<string>();
  private linkAt = 0;
  /** Four times a second: open channels that keyed up together are compared, their audio envelopes at a lag of up to two seconds. */
  private checkLinks(now: number): void {
    if (now - this.linkAt < 250) return;
    this.linkAt = now;
    const os = [...this.opens.values()].filter(o => o.probe && o.probe.env.length >= LINK_LIVE_FRAMES);
    const ids = new Set(os.map(o => o.id));
    for (const k of [...this.liveLinked]) { const [a, b] = k.split('|').map(Number); if (!ids.has(a) || !ids.has(b)) this.liveLinked.delete(k); }
    for (let i = 0; i < os.length; i++) for (let j = i + 1; j < os.length; j++) {
      const [x, y] = os[i].startMs <= os[j].startMs ? [os[i], os[j]] : [os[j], os[i]];
      if (Math.abs(x.hz - y.hz) < 50_000 || y.startMs - x.startMs > LINK_EDGE_MS || x.tileKey === y.tileKey) continue;
      const key = `${x.id}|${y.id}`; if (this.liveLinked.has(key)) continue;
      const r = envCorr(Float32Array.from(x.probe!.env.slice(0, LINK_LIVE_MAX)), Float32Array.from(y.probe!.env.slice(0, LINK_LIVE_MAX)), Math.round((y.startMs - x.startMs) / ENV_MS), LINK_LIVE_LAG);
      if (r >= LINK_CORR) this.liveLinked.add(key);
    }
    const tiles = new Set<string>();
    for (const k of this.liveLinked) { const [a, b] = k.split('|').map(Number), oa = this.opens.get(a), ob = this.opens.get(b); if (oa && ob) tiles.add([oa.tileKey, ob.tileKey].sort().join('|')); }
    this.tracker.liveLinks = tiles;
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
    let c = [...this.opens.values()].filter(o => o.probe && !pr.mute.includes(o.tileKey));
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
      p.push(this.fi, this.fq, n, hear);
      // a carrier that is off its raster point by more than half a step moves to the right one, once
      if (this.plan.snap && !o.shifted && now - o.startMs > 500) {
        o.shifted = true;
        const off = p.offset(1);
        if (Math.abs(off.hz) > HP_RASTER / 2) {
          const steps = Math.round(off.hz / HP_RASTER), shift = steps * HP_RASTER;
          o.k += steps; o.hz += shift; o.tileKey = this.tileKey(o.hz); p.retune(o.hz - this.centerHz);
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
    return [...this.opens.values()].map(o => {
      const off = o.probe ? o.probe.offset(2) : { hz: NaN, sd: 0 };
      return { id: o.id, hz: o.hz, startMs: o.startMs, snrDb: Math.round(o.snr * 10) / 10, levelDb: o.probe ? Math.round(o.probe.levelDb) : -90, offsetHz: off.hz, tone: o.probe?.tone() ?? 0, dcs: o.probe?.dcs() ?? 0, recorded: !!o.probe && !o.cut };
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
      stats: { onAir: this.opens.size, stations: tr.stationCount, probes: this.probes(), cap: this.cap, costMs: Math.round(this.costMs * 10) / 10, clipS: Math.round(this.clips.seconds), clipMB: Math.round(this.clips.bytes / 1e5) / 10, capMB: Math.round(this.clips.cap / 1e5) / 10, oldestMs: this.clips.oldestMs(), channels: this.count },
    };
  }
  protected post(now: number): void { this.emit({ type: this.plan.type, ...this.snapshot(now) }); }
}

/** HAM+: every FM channel on the ham bands at once. */
export class HamPlusEngine extends ChannelWatch<Probe> {
  constructor(emit: Emit, sink: (chunk: Float32Array) => void, clock: () => number = () => Date.now(), perf: () => number = () => performance.now()) {
    super(HAM_PLAN, emit, sink, clock, perf);
  }
  protected makeProbe(hz: number): Probe { return new Probe(this.rate, hz - this.centerHz); }
}
export type HpSnap = ReturnType<HamPlusEngine['snapshot']>;
