/**
 * The Analyzer's capture: every burst in the span, kept whole.
 *
 * This is the Devices front end (`r433/channels.ts`) with a recorder on each channel. When something lights up
 * anywhere in the span, a narrow receiver is tuned to it from 12 ms before it began, and everything that receiver
 * hears (its envelope, its discriminator and its own I/Q samples, all at about 250 kHz) is kept until it lets go.
 * Each becomes one captured signal: when, where, how long and how strong.
 *
 * The same burst is also offered to every Devices decoder (rtl_433, ProtoPirate's car keys, Mayhem's remotes and
 * sensors), so a capture that is a known device says so. Twin of core/analyzer/Capture.kt and Capture.swift.
 */

import type { Emit, IqProcessor } from '../core.js';
import { BurstChannels, MAX_CHANNELS, type BurstChannel } from '../r433/channels.js';
import { KeyDecoders, type KeyReading } from '../r433/keys.js';
import { PulseDetect, type PulseKind } from '../r433/detect.js';
import { R433 } from '../r433/runner.js';
import type { PulseData } from '../r433/slicers.js';
import { carrierOf, noiseOf, twoMeans } from './demod.js';
import '../r433/devices/index.js';

export interface Burst {
  id: number;
  /** Seconds since capture started (or into the file, for an import) at the burst's first kept sample. */
  t: number;
  /** Wall-clock time it ended, ms. */
  wall: number;
  /** Offset from the radio's center, Hz. */
  hz: number;
  /** The channel's sample rate. */
  rate: number;
  n: number;
  env: Int16Array;
  fm: Int16Array;
  /** Interleaved I, Q bytes at `rate`. */
  iq: Int8Array;
  /** How long the carrier was up, ms (first rise to last fall). */
  ms: number;
  /** Peak level, dB below full scale, and over the noise before the burst. */
  dbfs: number;
  snr: number;
  /** What the Devices decoders made of it. */
  matches: string[];
  /** The file it came from, for an import. */
  src?: string;
}

/** A burst is kept for at most this long; past it, the rest is not stored (the decoders still hear it). */
export const MAX_BURST_S = 1.0;
/** Carriers shorter than this are clicks, not signals. */
const MIN_BURST_MS = 0.5;
/** Full scale of the envelope (see Baseband). */
const ENV_FULL = 16384;

/**
 * Two bursts at the same time within 150 kHz are one signal followed twice: an FSK packet's tones and sidebands can
 * light the spectrum wide enough for the finder to open a second channel beside the first. The stronger is kept,
 * or, within 3 dB, the one that hears two tones the further apart (the one centered on the packet).
 */
const SHADOW_HZ = 150_000;
const SHADOW_DB = 3;
/** Bursts are held this long after they end (seconds), so a stronger one overlapping them can still claim them. */
const HOLD_S = 0.15;

interface Slot {
  env: Int16Array; fm: Int16Array; iq: Int8Array; n: number; t: number; hz: number; rate: number;
  pd: PulseDetect; keys: KeyDecoders; matches: Set<string>;
}

let nextId = 1;

/** What a decoder said, in a few words. */
export function matchLabel(r: KeyReading): string {
  const what = r.family === 'key' ? 'car key' : r.family === 'remote' ? 'remote' : 'weather';
  return `${what}: ${r.model}${r.id ? ` ${r.id}` : ''}`;
}

export class AnalyzerCapture implements IqProcessor {
  private readonly channels: BurstChannels;
  private readonly slots: Slot[] = [];
  private readonly radio = new R433();
  private rate = 0;
  private cur = 0;
  /** Samples before the first one seen, for an import that starts part way in. */
  offsetS = 0;
  /** Stop keeping new bursts (the decoders and the finder carry on). */
  paused = false;
  src: string | undefined;
  /** Ended bursts not yet passed on, and the last few passed on, for the splatter check. */
  private readonly held: { b: Burst; end: number; spread: number }[] = [];
  private readonly recent: { t0: number; t1: number; hz: number; snr: number; spread: number }[] = [];

  constructor(private readonly onBurst: (b: Burst) => void) {
    this.channels = new BurstChannels((ch, env, fm, n, iq) => this.onChannel(ch, env, fm, n, iq), ch => this.onEnd(ch));
    this.channels.keepIq = true;
    for (let i = 0; i < MAX_CHANNELS; i++) {
      const slot: Slot = {
        env: new Int16Array(0), fm: new Int16Array(0), iq: new Int8Array(0), n: 0, t: 0, hz: 0, rate: 0,
        pd: new PulseDetect(250_000), keys: new KeyDecoders(r => slot.matches.add(matchLabel(r))), matches: new Set(),
      };
      this.slots.push(slot);
    }
  }

  reset(rate: number): void { this.rate = rate; this.channels.reset(rate); }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    this.channels.process(iq);
    this.release(false);
  }

  /** Bursts being followed right now, and how many have been since the start, for the status line. */
  active(): number { return this.channels.active(); }
  followed(): number { return this.channels.opened; }

  /** Let every open channel go and pass on everything held: the end of an imported file. */
  finish(): void { this.channels.reset(this.rate); this.release(true); }

  /** The seconds a burst spans, for telling which overlap. */
  private static span(b: Burst): [number, number] { return [b.t, b.t + b.n / b.rate]; }

  /**
   * Pass on the held bursts that have ended long enough ago, unless another burst at the same time and nearly the
   * same frequency was far stronger: then this one is that one's splatter (an FSK packet's sidebands open a
   * channel of their own beside it), not a signal.
   */
  private release(all: boolean): void {
    const now = this.offsetS + this.channels.samples / this.rate;
    const beats = (snr: number, spread: number, b: Burst, bSpread: number) => snr > b.snr + SHADOW_DB || (snr > b.snr - SHADOW_DB && spread > bSpread);
    const shadowed = (b: Burst, bSpread: number) => {
      const [a0, a1] = AnalyzerCapture.span(b);
      const over = (t0: number, t1: number, hz: number) => t0 < a1 && t1 > a0 && Math.abs(hz - b.hz) < SHADOW_HZ;
      return this.held.some(h => h.b !== b && over(...AnalyzerCapture.span(h.b), h.b.hz) && beats(h.b.snr, h.spread, b, bSpread))
        || this.recent.some(r => over(r.t0, r.t1, r.hz) && beats(r.snr, r.spread, b, bSpread));
    };
    for (let i = 0; i < this.held.length;) {
      const h = this.held[i];
      if (!all && now - h.end < HOLD_S) { i++; continue; }
      if (!shadowed(h.b, h.spread)) {
        const [t0, t1] = AnalyzerCapture.span(h.b);
        this.recent.push({ t0, t1, hz: h.b.hz, snr: h.b.snr, spread: h.spread });
        if (this.recent.length > 16) this.recent.shift();
        this.onBurst(h.b);
      }
      this.held.splice(i, 1);
    }
  }

  private readonly sink = (kind: PulseKind, pulses: PulseData) => {
    for (const r of this.radio.run(kind, pulses)) if (!r.dev.disabled) this.slots[this.cur].matches.add(`rtl_433 ${r.dev.num}: ${r.data.model}${r.data.id !== undefined ? ` ${r.data.id}` : ''}`);
  };

  private onChannel(ch: BurstChannel, env: Int16Array, fm: Int16Array, n: number, iq?: Int8Array): void {
    const s = this.slots[ch.slot];
    this.cur = ch.slot;
    if (ch.fresh) {
      s.n = 0; s.hz = ch.hz; s.rate = ch.rate; s.matches.clear();
      s.t = this.offsetS + this.channels.startOf(ch.slot) / this.rate;
      s.pd.setSampleRate(ch.rate); s.pd.reset(); s.keys.slicer.reset(ch.rate); s.keys.slicer.flush(); s.keys.reset();
    }
    s.pd.process(env, fm, n, this.sink);
    s.keys.slicer.process(env, fm, n);
    const cap = Math.round(ch.rate * MAX_BURST_S);
    const take = Math.min(n, cap - s.n);
    if (take <= 0 || this.paused) return;
    if (s.env.length < s.n + take) {
      let size = Math.max(4096, s.env.length); while (size < s.n + take) size *= 2;
      const e = new Int16Array(size); e.set(s.env.subarray(0, s.n)); s.env = e;
      const f = new Int16Array(size); f.set(s.fm.subarray(0, s.n)); s.fm = f;
      const q = new Int8Array(size * 2); q.set(s.iq.subarray(0, s.n * 2)); s.iq = q;
    }
    s.env.set(env.subarray(0, take), s.n);
    s.fm.set(fm.subarray(0, take), s.n);
    if (iq) s.iq.set(iq.subarray(0, take * 2), s.n * 2);
    s.n += take;
  }

  private onEnd(ch: BurstChannel): void {
    const s = this.slots[ch.slot];
    this.cur = ch.slot;
    s.pd.flush(this.sink);
    s.keys.slicer.flush();
    if (this.paused || s.n < 16) return;
    const n = s.n;
    const noise = noiseOf(s.env, n, s.rate);
    const on = carrierOf(s.env, n, noise);
    let a = 0, b = n, peak = 0;
    while (a < n && !on[a]) a++;
    while (b > a && !on[b - 1]) b--;
    const fmOn: number[] = [];
    for (let i = a; i < b; i++) { if (s.env[i] > peak) peak = s.env[i]; if (on[i]) fmOn.push(s.fm[i]); }
    const tones = twoMeans(fmOn);
    const ms = (b - a) / s.rate * 1000;
    if (ms < MIN_BURST_MS) return;
    const end = this.offsetS + this.channels.samples / this.rate;
    this.held.push({ end, spread: tones.b - tones.a, b: {
      id: nextId++, t: s.t, wall: Date.now(), hz: s.hz, rate: s.rate, n,
      env: s.env.slice(0, n), fm: s.fm.slice(0, n), iq: s.iq.slice(0, n * 2), ms,
      dbfs: 20 * Math.log10(Math.max(1, peak) / ENV_FULL), snr: 20 * Math.log10(Math.max(1, peak) / noise),
      matches: [...s.matches], src: this.src,
    } });
  }
}

/**
 * The capture as a worker processor: each burst goes to the interface, its arrays handed over rather than copied,
 * and once a second a status line.
 */
export class AnalyzerProcessor implements IqProcessor {
  readonly capture: AnalyzerCapture;
  private lastStats = 0;
  private captured = 0;
  constructor(private readonly emit: Emit) {
    this.capture = new AnalyzerCapture(b => { this.captured++; emit({ type: 'anburst', burst: b }, [b.env.buffer, b.fm.buffer, b.iq.buffer]); });
  }
  reset(rate: number): void { this.capture.reset(rate); }
  onIq(iq: Int8Array, rate: number): void {
    this.capture.onIq(iq, rate);
    const now = Date.now();
    if (now - this.lastStats >= 1000) {
      this.lastStats = now;
      this.emit({ type: 'anstats', channels: this.capture.active(), followed: this.capture.followed(), captured: this.captured, span: rate });
    }
  }
}

/**
 * Run a whole recording through a fresh capture: an imported .cu8 / .cs8 (or a Flipper .sub turned back into
 * samples). The file is read in the same blocks a radio delivers, then a moment of silence lets the last burst go.
 */
export function captureFile(iq: Int8Array, rate: number, src: string, onBurst: (b: Burst) => void): number {
  let count = 0;
  const cap = new AnalyzerCapture(b => { count++; onBurst(b); });
  cap.src = src;
  cap.reset(rate);
  const block = 262144;
  for (let p = 0; p < iq.length; p += block) cap.onIq(iq.subarray(p, Math.min(iq.length, p + block)), rate);
  // a fifth of a second of quiet so every channel closes on its own (the finder lets go after 60 ms)
  const quiet = new Int8Array(Math.round(rate * 0.2) * 2);
  let seed = 1;
  for (let i = 0; i < quiet.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; quiet[i] = ((seed >>> 16) % 5) - 2; }
  cap.onIq(quiet, rate);
  cap.finish();
  return count;
}

/** What the person keeps: bursts outside these are dropped as they arrive (counted, not shown). */
export interface CaptureFilter {
  /** Absolute frequency range, Hz (0 = no limit). */
  loHz: number; hiHz: number;
  minSnr: number;
  minMs: number; maxMs: number;
  /** Skip bursts a Devices decoder already claims. */
  unknownOnly: boolean;
  /** Keep only bursts that carry data (see hasData): on by default, so spurs and blips don't flood the list. */
  dataOnly: boolean;
}
export const NO_FILTER: CaptureFilter = { loHz: 0, hiHz: 0, minSnr: 0, minMs: 0, maxMs: 0, unknownOnly: false, dataOnly: false };
export const DEFAULT_FILTER: CaptureFilter = { ...NO_FILTER, dataOnly: true };

/**
 * Whether a burst looks like a transmission rather than a spur or a blip: a Devices decoder claims it, or it lasts at
 * least 2 ms and reads as 16 or more bits at a plausible rate for a remote or a sensor (100 kbit/s or less), and those
 * bits span at least a quarter of it. A plain carrier, two tones with no bits, a 1 ms tick read as 170 kbit/s, or a
 * few stray bits in 50 ms of noise all fail.
 */
export function hasData(a: { frames: { bits: string }[]; baud: number }, b: { ms: number; matches: string[] }): boolean {
  if (b.matches.length) return true;
  const bits = a.frames.reduce((n, f) => n + f.bits.length, 0);
  if (!(b.ms >= 2 && bits >= 16 && a.baud > 0 && a.baud <= 100_000)) return false;
  // the bits must fill a fair share of the burst: noise reads as a few stray bits spread over 50 ms, while real frames
  // (repeats and the gaps between them included) cover 40% of it or more
  return bits / a.baud * 1000 >= 0.25 * b.ms;
}

/** Whether a burst heard with the radio at `center` gets through. A file with no known center skips the frequency test. */
export function passes(f: CaptureFilter, b: { hz: number; snr: number; ms: number; matches: string[] }, center: number): boolean {
  const hz = center + b.hz;
  if (center && f.loHz && hz < f.loHz) return false;
  if (center && f.hiHz && hz > f.hiHz) return false;
  if (f.minSnr && b.snr < f.minSnr) return false;
  if (f.minMs && b.ms < f.minMs) return false;
  if (f.maxMs && b.ms > f.maxMs) return false;
  if (f.unknownOnly && b.matches.length) return false;
  return true;
}
