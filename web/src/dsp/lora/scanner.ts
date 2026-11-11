/**
 * The LoRa app's processor. Port of core/lora/LoraScanner.swift: one wide span (20 MHz on a HackRF) is watched for
 * bursts; each burst's width gives its bandwidth, the known channel plans give its spreading factor where they can,
 * and a channel of its own (mixed down, decimated, resampled to one sample a chip) runs LoRa receivers on it, from a
 * little before the burst began, until it ends. The always-on (standing) channels are listened to the whole time.
 *
 * Threading: on iOS the channels decode on a worker thread of their own, reading a raw-sample ring the radio thread
 * writes. Here the whole processor runs on the DSP Web Worker and the burst channels run synchronously at the end of
 * each onIq. The standing channels, which cost the most (every raw sample, all the time: about 40 % of a core each
 * at 20 Msps), can be handed to a StandingPool instead: Web Workers of their own, each with its own copy of the
 * ring (ChannelRunner below), sending back what they hear.
 *
 * Samples: the web gets signed int8 IQ, so the ring holds signed bytes and is read as-is (the Swift subtracts 127.4
 * from unsigned bytes).
 */
import { fft } from '../../fft.js';
import { ComplexFirDecimator, lowpassTaps } from '../ham/filters.js';
import { LoraReceiver, roundAway, type LoraFrame } from './phy.js';
import { CHANNELS, type LoraChannel } from './plan.js';

/** One LoRa frame the scanner heard: the frame, the channel it came on (Hz, the measured frequency error included),
 *  whether its chirps ran downward (a LoRaWAN downlink), and when (ms since the epoch). */
export interface LoraHeard { frame: LoraFrame; hz: number; inverted: boolean; time: number }

/** Int64.max / 4 in the Swift: "until the scanner is reset". */
const FOREVER = 2 ** 60;
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The first decimation, raw IQ down to about twice the channel's bandwidth: a third-order CIC to 3-6x the output
 * rate, then a windowed-sinc FIR the rest of the way. Port of ChannelDecimator (core/ham/Filters.swift). The
 * Swift's 64-bit integrators become wrapping int32 ones: the input scale (256 in the Swift) drops to the largest
 * power of two whose growth still fits 31 bits (128 for the 40x CIC a 62.5 kHz channel gets at 20 Msps), which
 * changes nothing that matters (the rounding is 1/128 of a sample LSB). The input is rounded the Swift way (halves
 * away from zero) through an Int32Array store, not Math.round: that is several times faster in V8, and this loop
 * runs on every raw sample of every open channel.
 */
export class ChannelDecimator {
  readonly total: number; readonly cicD: number; readonly firD: number;
  private readonly fir: ComplexFirDecimator | null;
  private readonly scale: number;
  private readonly gain: number;
  private i1r = 0; private i1i = 0; private i2r = 0; private i2i = 0; private i3r = 0; private i3i = 0;
  private c1r = 0; private c1i = 0; private c2r = 0; private c2i = 0; private c3r = 0; private c3i = 0;
  private ph = 0;
  private q = new Int32Array(0);
  private mid = new Float32Array(0);
  /** The decimated samples of the last process() call (interleaved). */
  out = new Float32Array(0);

  /** The largest decimation no larger than `want` that splits into a CIC part and a FIR part of 3-6 (FIR only up to 6). */
  static split(want: number): [number, number] {
    if (want <= 1) return [1, 1];
    if (want <= 6) return [1, want];
    let t = want;
    while (t > 6) {
      for (const f of [4, 5, 6, 3]) if (t % f === 0) return [t / f, f];
      t--;
    }
    return [1, t];
  }

  constructor(want: number) {
    [this.cicD, this.firD] = ChannelDecimator.split(want);
    this.total = this.cicD * this.firD;
    // transition from 1/3 of the output rate to 2/3 (aliases fold onto ±1/3): 24 taps per decimation step
    this.fir = this.firD > 1 ? new ComplexFirDecimator(lowpassTaps(0.5 / this.firD, 24 * this.firD + 1), this.firD) : null;
    // a mixed int8 sample is at most 128 * sqrt(2) < 182
    let scale = 256;
    while (scale > 1 && 182 * scale * this.cicD ** 3 >= 2 ** 31) scale >>= 1;
    this.scale = scale;
    this.gain = 1 / (scale * this.cicD ** 3);
  }

  /** `inp`: interleaved I/Q, `n` complex samples; the decimated samples go to `out` (grown if short). */
  process(inp: Float32Array, n: number): number {
    const need = 2 * (Math.floor(n / this.total) + 2);
    if (this.out.length < need) this.out = new Float32Array(need);
    if (this.cicD === 1) {
      if (!this.fir) { this.out.set(inp.subarray(0, 2 * n)); return n; }
      return this.fir.process(inp, n, this.out);
    }
    const nMid = Math.floor(n / this.cicD) + 2;
    if (this.mid.length < 2 * nMid) this.mid = new Float32Array(2 * nMid);
    if (this.q.length < 2 * n) this.q = new Int32Array(2 * n);
    const q = this.q, sc = this.scale, mid = this.mid, D = this.cicD, g = this.gain;
    for (let k = 0; k < 2 * n; k++) { const x = inp[k] * sc; q[k] = x + 0.5 * Math.sign(x); }   // the store truncates: rounded away from zero (branch-free: the signs are random)
    let i1r = this.i1r, i1i = this.i1i, i2r = this.i2r, i2i = this.i2i, i3r = this.i3r, i3i = this.i3i, ph = this.ph, o = 0;
    let c1r = this.c1r, c1i = this.c1i, c2r = this.c2r, c2i = this.c2i, c3r = this.c3r, c3i = this.c3i;
    for (let i = 0; i < n; i++) {
      i1r = (i1r + q[2 * i]) | 0; i1i = (i1i + q[2 * i + 1]) | 0;
      i2r = (i2r + i1r) | 0; i2i = (i2i + i1i) | 0;
      i3r = (i3r + i2r) | 0; i3i = (i3i + i2i) | 0;
      if (++ph >= D) {
        ph = 0;
        const y1r = (i3r - c1r) | 0, y1i = (i3i - c1i) | 0; c1r = i3r; c1i = i3i;
        const y2r = (y1r - c2r) | 0, y2i = (y1i - c2i) | 0; c2r = y1r; c2i = y1i;
        const y3r = (y2r - c3r) | 0, y3i = (y2i - c3i) | 0; c3r = y2r; c3i = y2i;
        mid[2 * o] = y3r * g; mid[2 * o + 1] = y3i * g; o++;
      }
    }
    this.i1r = i1r; this.i1i = i1i; this.i2r = i2r; this.i2i = i2i; this.i3r = i3r; this.i3i = i3i; this.ph = ph;
    this.c1r = c1r; this.c1i = c1i; this.c2r = c2r; this.c2i = c2i; this.c3r = c3r; this.c3i = c3i;
    if (!this.fir) { this.out.set(mid.subarray(0, 2 * o)); return o; }
    return this.fir.process(mid, o, this.out);
  }
}

class Region {
  /** When its width last grew: a chirp's sweep widens a burst until it has covered the whole channel once. */
  grew: number;
  spawned: { bw: number; off: number }[] = [];
  /** Looks it was hot in: a chirp is there in nearly every look, noise only now and then. */
  hits = 1;
  /** Its strongest bin at each look from the start, for the chirp test. */
  track: (number | null)[] = [];
  trackLook = 0;
  constructor(public lo: number, public hi: number, public start: number, public last: number) { this.grew = last; }
}

/** A known channel inside the span, its bins, and whether it is on the air now. */
class Slot {
  active = false;
  /** Listened to all the time (standing), never opened by a burst. */
  standing = false;
  lastOn = 0;
  /** The current stretch of activity in it: when it began and when it was last hot. */
  firstHot = 0; lastHot = 0;
  /** The strongest bin in it at each look since its activity began (null: nothing hot in that look). */
  track: (number | null)[] = [];
  trackLook = -1;
  /** Frames decoded on it (for the screen's per-channel activity). */
  frames = 0;
  constructor(readonly ch: LoraChannel, readonly lo: number, readonly hi: number,
              readonly below: [number, number] | null, readonly above: [number, number] | null) {}
}

interface Owner { r: Region | null; s: Slot | null; until: number }

/** What a standing channel needs to run anywhere: where it is, its modem, and the sample it starts at. */
export interface StandingSpec { id: number; rate: number; offHz: number; bw: number; hz: number; sf: number | null; from: number; name: string }

/**
 * Where the standing channels run when not inline: every raw buffer goes to it (`feed`, with the absolute index of
 * its first sample), channels are added and dropped by id, and what they hear comes back through `onHeard` (good
 * frames only; damaged ones wait for a better timing phase as they do inline, and are reported when the channel is
 * dropped).
 */
export interface StandingPool {
  onHeard: ((id: number, f: LoraFrame, hz: number, inv: boolean, at: number) => void) | null;
  feed(iq: Int8Array, start: number): void;
  add(spec: StandingSpec): void;
  drop(ids: number[]): void;
  reset(): void;
  /** Processing time over air time of the busiest pool worker. */
  readonly busy: number;
}

/** Per-channel activity for the screen. */
export interface LoraChannelState {
  name: string; hz: number; bw: number; sf: number | null;
  standing: boolean; active: boolean;
  /** Ms since its bins were last hot (null: never in this span), frames decoded on it. */
  hotAgoMs: number | null; frames: number;
}

export class LoraScanner {
  /** 20 Msps: every LoRa bandwidth divides it exactly, and it is the widest a HackRF samples. */
  static readonly RATE = 20_000_000;
  /** The span a radio that can't sample 20 MHz gets (an RTL-SDR), from Apps.swift. */
  static readonly NARROW_RATE = 2_000_000;
  static readonly BWS = [62_500, 125_000, 250_000, 500_000];
  /** Every channel with a known modem, worldwide (LoraPlan). Those inside the span are watched; the standing ones
   *  listened to all the time. */
  static get plan(): LoraChannel[] { return CHANNELS; }

  /** Debug: regions and receiver stages. */
  static trace: ((s: string) => void) | null = null;
  static traceHz = 0;
  /** Debug: the traced channel's samples at one a chip. */
  static tap: ((x: number[]) => void) | null = null;

  centerOf: () => number = () => 0;
  onHeard: ((h: LoraHeard) => void) | null = null;
  /** Each burst that got a channel of its own: (Hz, bandwidth, plan name or null). */
  onBurst: ((hz: number, bw: number, name: string | null) => void) | null = null;
  /** Load shedding (no new burst channels while the processing is behind); off for replays and tests. */
  shedding = true;
  /** Set: the standing channels run there (Web Workers) instead of inline. */
  private _pool: StandingPool | null = null;
  /** The pool's channels: id -> slot. */
  private remote = new Map<number, Slot>();
  get pool(): StandingPool | null { return this._pool; }
  set pool(p: StandingPool | null) {
    if (p === this._pool) return;
    // the channels running in the old place stop there
    if (this.remote.size) { this._pool?.drop([...this.remote.keys()]); for (const id of this.remote.keys()) this.owners.delete(id); this.remote.clear(); }
    this._pool = p;
    if (p) p.onHeard = (id, f, hz, inv, at) => this.remoteHeard(id, f, hz, inv, at);
    this.slotCenter = -1;   // the standing channels are placed again, where they now run
  }
  private _busy = 0;
  /** Processing time over air time, smoothed. */
  get busy(): number { return Math.max(this._busy, this._pool?.busy ?? 0); }

  // ---- detection ----
  private rate = 0; private N = 2048; private HOP = 10_000;
  private win = new Float32Array(2048); private re = new Float32Array(2048); private im = new Float32Array(2048);
  private floor = new Float32Array(0);
  /** How often each bin has been hot lately (decays over about 60 ms): a chirp sweeps its whole channel evenly, an
   *  FSK burst leaves gaps. */
  private occ = new Float32Array(0);
  /** Each bin's power over the same time: a real channel stands well above the band just outside its edges, a
   *  strong neighbor's splash does not. */
  private lvl = new Float32Array(0);
  /** The sample each bin was last hot at. */
  private hotAt = new Float64Array(0);
  private frames = 0;
  private get binHz(): number { return this.rate / this.N; }
  /** The last 0.4 s of samples (signed int8 IQ), written by onIq and read by the channels behind it. */
  private ring = new Int8Array(2); private ringSize = 0; private ringMask = 0;
  private written = 0; private nextFrame = 0;

  private regions: Region[] = [];
  private slots: Slot[] = [];
  private slotCenter = -1;
  /** Each channel handed to the channel half, what keeps it open, and until when. */
  private owners = new Map<number, Owner>();
  private nextId = 0;
  // Shared with the channel half: new channels, how far each may run, how far the samples go.
  private inbox: Extractor[] = [];
  private untils = new Map<number, number>();
  private latest = 0;
  private scheduled = false;
  /** Web only: with shedding on, the channel half stops for this buffer once its time is up (performance.now() ms),
   *  so an overloaded worker lags and skips ahead the way the iOS channel thread does, instead of queueing every
   *  radio buffer behind it. */
  private deadline = Infinity;
  private turn = 0;
  /** Channels the channel half has retired since the detection half last looked. */
  private finished: number[] = [];
  // Channel half only.
  private extractors: Extractor[] = [];
  private recent: [number, number][] = [];      // (payload hash, sample) of frames already reported

  reset(rate: number): void {
    this.rate = rate;
    let N = 256; while (rate / N > 10_000) N <<= 1;
    this.N = N;
    this.HOP = Math.max(N, Math.floor(rate / 2000));
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.floor = new Float32Array(N); this.occ = new Float32Array(N); this.lvl = new Float32Array(N);
    this.hotAt = new Float64Array(N).fill(-1_000_000_000); this.frames = 0;
    // 0.4 s of history: a burst is only recognized as LoRa some way into its preamble
    let size = 1;
    while (size < Math.trunc(rate * 0.4)) size <<= 1;
    this.extractors = []; this.recent = [];
    this.inbox = []; this.untils.clear(); this.finished = []; this.latest = 0; this.scheduled = false;
    this.ring = new Int8Array(2 * size);
    this.ringSize = size; this.ringMask = size - 1;
    this.written = 0; this.nextFrame = N; this.regions = []; this.owners.clear(); this.slots = []; this.slotCenter = -1;
    this.remote.clear(); this._pool?.reset();
  }

  onIq(iq: Int8Array, rate: number): void {
    if (this.ringSize === 0 || rate !== this.rate) this.reset(rate);
    const t0 = now();
    const n = iq.length >> 1;
    this.deadline = this.shedding ? t0 + 0.9 * 1000 * n / rate : Infinity;
    this._pool?.feed(iq, this.written);
    let k = 0;
    while (k < n) {
      // copy up to the next look in one run
      const upto = Math.min(n, k + (this.nextFrame - this.written));
      let j = k;
      while (j < upto) {
        const p = (this.written + (j - k)) & this.ringMask;
        const run = Math.min(upto - j, this.ringSize - p);
        this.ring.set(iq.subarray(2 * j, 2 * (j + run)), 2 * p);
        j += run;
      }
      this.written += upto - k; k = upto;
      if (this.written === this.nextFrame) { this.detect(); this.nextFrame += this.HOP; }
    }
    this.handOff();
    const used = (now() - t0) / 1000, air = n / rate;
    if (air > 0) this._busy += 0.1 * (used / air - this._busy);
  }

  /** The known channels inside the span now, with their activity. */
  channelStates(): LoraChannelState[] {
    const t = this.written;
    return this.slots.map(s => ({
      name: s.ch.name, hz: s.ch.hz, bw: s.ch.bw, sf: s.ch.sf, standing: s.standing, active: s.active,
      hotAgoMs: s.lastHot > 0 ? Math.max(0, Math.round((t - s.lastHot) / this.rate * 1000)) : null, frames: s.frames,
    }));
  }

  /** Channels with receivers running now (standing ones included). */
  get openChannels(): number { return this.owners.size; }

  /** The known channels that fall inside the span (clear of its edges), as bin ranges. */
  private placeSlots(center: number): void {
    this.slotCenter = center;
    const N = this.N, binHz = this.binHz;
    // the old standing channels were tuned to the old center: they finish where they are
    for (const [id, o] of this.owners) {
      if (o.s?.standing !== true) continue;
      if (this.remote.has(id)) { this.owners.delete(id); continue; }
      this.owners.set(id, { r: o.r, s: null, until: this.written });
    }
    if (this.remote.size) { this._pool?.drop([...this.remote.keys()]); this.remote.clear(); }
    this.slots = [];
    const half = this.rate / 2 * 0.96;
    for (const c of LoraScanner.plan) {
      const off = c.hz - center;
      if (Math.abs(off) + c.bw / 2 > half) continue;
      const bin = (f: number): number => roundAway((off + c.bw * f) / binHz + N / 2);
      const lo = bin(-0.4), hi = bin(0.4);
      const guardBand = (a: number, b: number): [number, number] | null => { const x = Math.max(a, 0), y = Math.min(b, N - 1); return y >= x ? [x, y] : null; };
      const below = guardBand(bin(-0.8), Math.min(bin(-0.6), lo - 1)), above = guardBand(Math.max(bin(0.6), hi + 1), bin(0.8));
      if (hi - lo >= 3) this.slots.push(new Slot(c, lo, hi, below, above));
    }
    for (const sl of this.slots) {
      if (!sl.ch.standing) continue;
      sl.standing = true;
      sl.active = this.spawn(sl.ch.hz, sl.ch.bw, sl.ch.sf, false, this.written, null, sl, sl.ch.name, true);
    }
  }

  private detect(): void {
    const n = this.N, re = this.re, im = this.im, ring = this.ring, win = this.win, mask = this.ringMask;
    const floor = this.floor, occ = this.occ, lvl = this.lvl, hotAt = this.hotAt, written = this.written;
    const s0 = written - n;
    let p0 = s0 & mask;
    for (let k = 0; k < n; k++) {
      re[k] = ring[2 * p0] * win[k]; im[k] = ring[2 * p0 + 1] * win[k];
      p0 = (p0 + 1) & mask;
    }
    fft(re, im);
    this.frames++;
    const frames = this.frames;
    let hot: number[] = [];
    const binHz = this.binHz;
    const dc = Math.trunc(15_000 / binHz) + 1;
    let top = 0;
    for (let k = 0; k < n; k++) {
      const b = (k + n / 2) % n;
      const p = re[k] * re[k] + im[k] * im[k];
      re[k] = p;
      let f = floor[b];
      if (frames <= 8) f = frames === 1 ? p : f + 0.3 * (p - f);
      else if (p < f * 4) f += 0.02 * (p - f); else f += 0.0005 * (p - f);
      floor[b] = f;
      if (frames > 8 && Math.abs(b - n / 2) > dc && p > f * 14) { hot.push(b); top = Math.max(top, p); }
    }
    // a transmitter right beside the radio overloads it and splashes across the whole span: only what is within
    // 30 dB of the strongest signal in this look counts
    hot = hot.filter(b => !(re[(b + n / 2) % n] < top * 1e-3));
    hot.sort((a, b) => a - b);
    for (let b = 0; b < n; b++) { occ[b] *= 0.992; lvl[b] += 0.008 * (re[(b + n / 2) % n] - lvl[b]); }
    for (const b of hot) { occ[b] += 1; hotAt[b] = written; }
    // each known channel's strongest hot bin this look, for the chirp test
    if (hot.length > 0) {
      for (const sl of this.slots) {
        if (sl.active) continue;
        let best = -1, bp = 0;
        for (const b of hot) if (b >= sl.lo && b <= sl.hi) { const p = re[(b + n / 2) % n]; if (p > bp) { bp = p; best = b; } }
        if (best < 0) continue;
        if (written - sl.lastHot > Math.trunc(this.rate * 0.015) || sl.track.length === 0) { sl.track = []; sl.trackLook = frames - 1; }
        // the latest looks, not the first: a spur or a neighbor's splash can hold the strongest bin at a frame's
        // very start
        while (sl.trackLook < frames - 1) { sl.track.push(null); sl.trackLook++; }
        sl.track.push(best); sl.trackLook = frames;
        if (sl.track.length > 16) sl.track.splice(0, sl.track.length - 16);
      }
    }
    const center = this.centerOf();
    if (center !== this.slotCenter) this.placeSlots(center);
    if (frames % 4 === 0) this.watchSlots();

    // the channels no plan knows: clusters of hot bins grouped into bursts
    let i = 0;
    const gap = 2;
    const regions = this.regions;
    while (i < hot.length) {
      let j = i + 1;
      while (j < hot.length && hot[j] - hot[j - 1] <= 2) j++;
      const lo = hot[i], hi = hot[j - 1];
      let peakBin = lo, pp = 0;
      for (let q = i; q < j; q++) { const v = re[(hot[q] + n / 2) % n]; if (v > pp) { pp = v; peakBin = hot[q]; } }
      const r = regions.find(x => lo <= x.hi + gap && hi >= x.lo - gap && (Math.max(hi, x.hi) - Math.min(lo, x.lo)) * binHz <= 520_000);
      if (r) {
        if (lo < r.lo || hi > r.hi) { r.lo = Math.min(r.lo, lo); r.hi = Math.max(r.hi, hi); r.grew = written; }
        if (r.last !== written) r.hits++;
        r.last = written;
        if (r.track.length < 24) {
          while (r.trackLook < frames - 1 && r.track.length < 24) { r.track.push(null); r.trackLook++; }
          if (r.trackLook === frames - 1) { r.track.push(peakBin); r.trackLook = frames; }
        }
      } else {
        const nr = new Region(lo, hi, s0, written);
        nr.track = [peakBin]; nr.trackLook = frames;
        regions.push(nr);
      }
      i = j;
    }
    // a chirp wrapping from the top of its channel to the bottom starts a second region: once they meet, one burst
    let k = 0;
    while (k < regions.length) {
      const a = regions[k];
      let j = -1;
      for (let q = k + 1; q < regions.length; q++) {
        const b = regions[q];
        if (b.lo <= a.hi + 2 && b.hi >= a.lo - 2 && (Math.max(a.hi, b.hi) - Math.min(a.lo, b.lo)) * binHz <= 520_000) { j = q; break; }
      }
      if (j >= 0) {
        const b = regions[j];
        a.lo = Math.min(a.lo, b.lo); a.hi = Math.max(a.hi, b.hi); a.start = Math.min(a.start, b.start); a.last = Math.max(a.last, b.last);
        a.grew = Math.max(a.grew, b.grew); a.spawned.push(...b.spawned); a.hits = Math.max(a.hits, b.hits);
        for (const [id, o] of this.owners) if (o.r === b) this.owners.set(id, { r: a, s: o.s, until: o.until });
        regions.splice(j, 1);
      } else k++;
    }
    const quiet = Math.trunc(this.rate * 0.15);
    this.regions = regions.filter(x => !(written - x.last > quiet || written - x.start > this.rate * 8));
    for (const r of this.regions) this.consider(r);
  }

  /** A known channel goes on the air when nearly all of it has been swept lately; it gets its own receivers then. */
  private watchSlots(): void {
    const rate = this.rate, written = this.written, hotAt = this.hotAt, occ = this.occ, lvl = this.lvl;
    const gap = Math.trunc(rate * 0.015);
    for (const s of this.slots) {
      let last = -1_000_000_000;
      for (let b = s.lo; b <= s.hi; b++) if (hotAt[b] > last) last = hotAt[b];
      if (last > s.lastHot) { if (last - s.lastHot > gap) s.firstHot = last; s.lastHot = last; }
      if (s.standing) continue;
      if (s.active) {
        // off once quiet for three symbols (at the slowest spreading factor it could be)
        const sym = (1 << (s.ch.sf ?? 12)) / s.ch.bw;
        if (written - s.lastHot > rate * Math.max(0.03, 3 * sym)) { s.active = false; LoraScanner.trace?.(`slot off ${(written / rate * 1000).toFixed(1)} ms ${s.ch.name}`); }
        continue;
      }
      // the band's FSK bursts are over in 25 ms; a LoRa frame lasts longer
      const traced = LoraScanner.traceHz !== 0 && Math.abs(s.ch.hz - LoraScanner.traceHz) < 1000;
      const why = (w: string): void => { if (traced) LoraScanner.trace?.(`slot ${(written / rate * 1000).toFixed(1)} ms ${s.ch.name}: ${w}`); };
      if (written - s.lastHot > gap) continue;
      if (written - s.firstHot < Math.trunc(rate * 0.03)) { why('young'); continue; }
      let on = 0;
      for (let b = s.lo; b <= s.hi; b++) if (occ[b] > 0.25) on++;
      const cover = on / (s.hi - s.lo + 1);
      if (cover < 0.75) { why(`cover ${cover.toFixed(2)}`); continue; }
      const mean = (r: [number, number] | null): number => { if (!r) return 0; let t = 0; for (let b = r[0]; b <= r[1]; b++) t += lvl[b]; return t / (r[1] - r[0] + 1); };
      let inside = 0;
      for (let b = s.lo; b <= s.hi; b++) inside += lvl[b];
      inside /= s.hi - s.lo + 1;
      const edge = Math.max(mean(s.below), mean(s.above));
      if (inside <= 6 * edge) { why(`edges ${(inside / Math.max(edge, 1e-9)).toFixed(1)}`); continue; }
      if (!this.chirpsSlot(s)) { why(`not a chirp ${s.track.slice(0, 16).map(x => (x === null ? '-' : String(x))).join(' ')}`); continue; }
      // one transmission at a time per stretch of band: a channel overlapping one already on is the same signal (or
      // its splash)
      const o = this.slots.find(x => x !== s && x.active && x.hi >= s.lo && x.lo <= s.hi);
      if (o) { why('overlaps ' + o.ch.name); continue; }
      LoraScanner.trace?.(`slot on ${(written / rate * 1000).toFixed(1)} ms ${s.ch.name} cover ${cover.toFixed(2)}`);
      s.active = this.spawn(s.ch.hz, s.ch.bw, s.ch.sf, s.ch.name.includes('downlink'), s.firstHot - Math.trunc(rate * 0.02), null, s, s.ch.name);
    }
  }

  /** A preamble's chirps move the peak across the channel at one steady rate (wrapping at its edge); an FSK burst's
   *  peak jumps between its tones. */
  private chirpsSlot(s: Slot): boolean { return this.chirps(s.track.slice(-16), s.ch.bw); }

  private chirps(track: (number | null)[], bw: number): boolean {
    const width = bw / this.binHz;
    const diffs: number[] = [];
    for (let i = 1; i < Math.max(1, Math.min(track.length, 16)); i++) {
      const a = track[i - 1], b = track[i];
      if (a === null || b === null) continue;
      let d = (b - a) % width;
      if (d < -width / 2) d += width; else if (d >= width / 2) d -= width;
      diffs.push(d);
    }
    if (diffs.length < 6) return false;
    const med = diffs.slice().sort((x, y) => x - y)[Math.floor(diffs.length / 2)];
    const fit = diffs.filter(d => Math.abs(d - med) <= 1.5).length;
    return fit >= 0.6 * diffs.length;
  }

  /** A burst wide enough for LoRa and long enough not to be one of the band's short FSK bursts gets a channel at the
   *  bandwidth its width says; as a slow chirp's sweep widens the burst, a wider channel is tried too. */
  private consider(r: Region): void {
    const rate = this.rate, written = this.written, binHz = this.binHz;
    const width = (r.hi - r.lo + 1) * binHz;
    // the band's FSK bursts last 25 ms at most; a LoRa frame on a channel no plan knows lasts longer
    if (width < 45_000 || r.spawned.length >= 3 || written - r.start < Math.trunc(rate * 0.04)) return;
    const looks = (written - r.start) / this.HOP + 1;
    if (r.hits < 0.4 * looks) return;
    const bw = LoraScanner.BWS.find(b => b >= width * 0.85);
    if (bw === undefined) return;
    // wait until the width has held for half a symbol at SF12 of that bandwidth (a slower chirp is still sweeping)
    if (written - r.grew < rate * 2048 / bw) return;
    const off = ((r.lo + r.hi) / 2 - this.N / 2) * binHz;
    if (r.spawned.some(x => x.bw === bw && Math.abs(x.off - off) < bw / 8)) return;
    if (!this.chirps(r.track, bw)) { r.spawned.push({ bw, off }); return; }
    r.spawned.push({ bw, off });
    // a known channel on the air here already has its own receivers
    if (this.slots.some(s => s.active && s.hi >= r.lo && s.lo <= r.hi)) return;
    const hz = this.centerOf() + Math.trunc(off);
    const from = r.start - Math.trunc(rate * 0.01);
    this.spawn(hz, bw, null, true, from, r, null, null);
  }

  /** A channel of its own for a burst; false when there is no room (the known channels keep room the others can't take). */
  private spawn(hz: number, bw: number, sf: number | null, inverted: boolean, from0: number, r: Region | null, s: Slot | null, name: string | null, standing = false): boolean {
    const rate = this.rate, written = this.written;
    LoraScanner.trace?.(`spawn ${(written / rate * 1000).toFixed(1)} ms ${(hz / 1e6).toFixed(4)} MHz bw ${bw} ${name ?? '-'}`);
    const open = [...this.owners.values()].filter(o => o.s?.standing !== true);
    if (!standing) {
      if (this.shedding && this._busy > 0.8) return false;
      if (open.length >= 10 || (s === null && open.filter(o => o.s === null).length >= 4)) return false;
    }
    const from = Math.max(from0, written - this.ringMask + Math.trunc(rate / 50), 0);
    const sfs = sf !== null ? [sf] : [7, 8, 9, 10, 11, 12];
    this.nextId++;
    if (standing && this._pool && s) {
      this._pool.add({ id: this.nextId, rate, offHz: hz - this.centerOf(), bw, hz, sf, from, name: name ?? '' });
      this.remote.set(this.nextId, s);
      this.owners.set(this.nextId, { r, s, until: FOREVER });
      this.onBurst?.(hz, bw, name);
      return true;
    }
    const e = new Extractor(this.nextId, rate, hz - this.centerOf(), bw, hz, from, sfs, inverted, s !== null ? 4 : 2, this, s);
    const t = LoraScanner.trace;
    if (t && LoraScanner.traceHz !== 0 && Math.abs(hz - LoraScanner.traceHz) < 1000) { e.traceAll(x => t('rx: ' + x)); e.tapped = true; }
    const until = standing ? FOREVER : written + Math.trunc(rate * 0.2);
    this.owners.set(this.nextId, { r, s, until });
    this.inbox.push(e); this.untils.set(this.nextId, until);
    this.onBurst?.(hz, bw, name);
    return true;
  }

  /** After each buffer: how far each channel may run now, then the channel half's turn. */
  private handOff(): void {
    const rate = this.rate;
    const tail = Math.trunc(rate * 0.05);
    for (const [id, o] of this.owners) {
      if (this.remote.has(id)) continue;
      let u = o.until;
      if (o.r) u = Math.max(u, o.r.last + tail);
      if (o.s && !o.s.standing) {
        // a few symbols past the last time the channel was heard (a weak frame drops out of the looks now and then)
        const sym = (1 << (o.s.ch.sf ?? 12)) / o.s.ch.bw;
        u = Math.max(u, o.s.lastHot + Math.trunc(rate * Math.max(0.05, 3 * sym)));
      }
      if (u !== o.until) this.owners.set(id, { r: o.r, s: o.s, until: u });
    }
    for (const id of this.finished) this.owners.delete(id);
    this.finished = [];
    for (const [id, o] of this.owners) if (!this.remote.has(id)) this.untils.set(id, o.until);
    this.latest = this.written;
    const go = !this.scheduled;
    this.scheduled = true;
    // the channel half runs right here, on the same (DSP worker) thread (a nested worker would be posted to when `go`)
    if (go) this.runExtractors();
  }

  /** Channel half: run every channel up to where its samples and its time go, and retire the finished ones. */
  private runExtractors(): void {
    const rate = this.rate;
    this.extractors.push(...this.inbox); this.inbox = [];
    const upTo = this.latest;
    for (const e of this.extractors) { const u = this.untils.get(e.id); if (u !== undefined) e.until = u; }
    this.scheduled = false;
    // each channel is independent (on iOS they run side by side, one core each)
    const r = this.ring, mask = this.ringMask, behind = this.ringMask - Math.trunc(rate / 50), back = Math.trunc(this.ringMask / 2);
    // (in turn, from a different channel each buffer, so a deadline shares the time out evenly)
    const list = this.extractors, cnt = list.length;
    this.turn = cnt > 0 ? (this.turn + 1) % cnt : 0;
    for (let j = 0; j < cnt; j++) {
      const e = list[(this.turn + j) % cnt];
      if (upTo - e.pos > behind) e.pos = upTo - back;   // fell behind
      const end = Math.min(upTo, e.until);
      if (end > e.pos) e.run(end, r, mask, this.deadline);
    }
    const gone: number[] = [];
    this.extractors = this.extractors.filter(e => {
      const done = (e.pos >= e.until && upTo >= e.until) || (e.until < FOREVER / 2 && upTo - e.born > rate * 8);
      if (done) {
        gone.push(e.id);
        for (const [f, inv, at] of e.bad) {
          if (e.goodAt.some(g => Math.abs(g - at) < rate)) continue;
          this.onHeard?.({ frame: f, hz: e.hz + Math.trunc(f.cfoHz), inverted: inv, time: Date.now() });
        }
      }
      return !done;
    });
    if (gone.length > 0) { for (const id of gone) this.untils.delete(id); this.finished.push(...gone); }
  }

  /** What the channels report goes through here one at a time. */
  heard(f: LoraFrame, e: Extractor, inv: boolean): void {
    const rate = this.rate;
    // a damaged frame waits: another timing phase may yet get it right, and the phases' damaged copies differ
    const at = e.pos;
    if (f.crcOk === false) { if (!e.bad.some(b => at - b[2] < rate)) e.bad.push([f, inv, at]); return; }
    e.goodAt.push(at);
    this.report(f, e.slot, e.hz, inv, at);
  }

  /** A frame from a pool worker's standing channel. */
  private remoteHeard(id: number, f: LoraFrame, hz: number, inv: boolean, at: number): void {
    const s = this.remote.get(id);
    if (!s && !this.owners.has(id)) {
      // a channel already dropped (the span moved): only its damaged frames come late, and they still count
      if (f.crcOk !== false) return;
    }
    this.report(f, s ?? null, hz, inv, at);
  }

  private report(f: LoraFrame, slot: Slot | null, hz: number, inv: boolean, at: number): void {
    const rate = this.rate;
    let h = 5381;
    for (const b of f.payload) h = (Math.imul(h, 33) + b) | 0;
    this.recent = this.recent.filter(x => !(Math.abs(at - x[1]) > rate * 3));
    if (this.recent.some(x => x[0] === h)) return;
    this.recent.push([h, at]);
    if (slot) slot.frames++;
    this.onHeard?.({ frame: f, hz: hz + Math.trunc(f.cfoHz), inverted: inv, time: Date.now() });
  }
}

/** Who an Extractor reports to: the scanner itself, or a pool worker's ChannelRunner. */
interface HeardSink { heard(f: LoraFrame, e: Extractor, inv: boolean): void }

/**
 * A pool worker's half: its own copy of the raw-sample ring and the standing channels it was given, run to the end
 * of every buffer within the buffer's air time (a channel that falls behind skips ahead, as the inline ones do).
 * Good frames go to `onHeard` at once; damaged ones wait for a better timing phase and go when the channel is dropped.
 */
export class ChannelRunner implements HeardSink {
  onHeard: ((id: number, f: LoraFrame, hz: number, inv: boolean, at: number) => void) | null = null;
  shedding = true;
  busy = 0;
  private rate = 0; private ring = new Int8Array(2); private ringSize = 0; private ringMask = 0; private written = 0;
  private list: Extractor[] = [];
  private turn = 0;

  private setRate(rate: number): void {
    this.rate = rate;
    let size = 1;
    while (size < Math.trunc(rate * 0.4)) size <<= 1;
    this.ring = new Int8Array(2 * size); this.ringSize = size; this.ringMask = size - 1;
  }

  add(sp: StandingSpec): void {
    if (sp.rate !== this.rate) { this.setRate(sp.rate); this.list = []; }
    const e = new Extractor(sp.id, sp.rate, sp.offHz, sp.bw, sp.hz, Math.max(sp.from, this.written - this.ringMask + Math.trunc(sp.rate / 50), 0),
      sp.sf !== null ? [sp.sf] : [7, 8, 9, 10, 11, 12], false, 4, this, null);
    e.until = FOREVER;
    this.list.push(e);
  }

  drop(ids: number[]): void {
    const rate = this.rate;
    this.list = this.list.filter(e => {
      if (!ids.includes(e.id)) return true;
      for (const [f, inv, at] of e.bad) if (!e.goodAt.some(g => Math.abs(g - at) < rate)) this.onHeard?.(e.id, f, e.hz, inv, at);
      return false;
    });
  }

  reset(): void { this.list = []; this.written = 0; this.rate = 0; this.ringSize = 0; }

  heard(f: LoraFrame, e: Extractor, inv: boolean): void {
    const at = e.pos;
    if (f.crcOk === false) { if (!e.bad.some(b => at - b[2] < this.rate)) e.bad.push([f, inv, at]); return; }
    e.goodAt.push(at);
    this.onHeard?.(e.id, f, e.hz, inv, at);
  }

  /** A raw buffer whose first sample is sample `start` of the stream. */
  feed(iq: Int8Array, start: number, rate: number): void {
    if (rate !== this.rate || this.ringSize === 0) this.setRate(rate);
    const t0 = now();
    const n = iq.length >> 1;
    this.written = start;
    for (let j = 0; j < n;) {
      const p = this.written & this.ringMask, run = Math.min(n - j, this.ringSize - p);
      this.ring.set(iq.subarray(2 * j, 2 * (j + run)), 2 * p);
      this.written += run; j += run;
    }
    const deadline = this.shedding ? t0 + 0.9 * 1000 * n / rate : Infinity;
    const upTo = this.written, behind = this.ringMask - Math.trunc(rate / 50), back = Math.trunc(this.ringMask / 2);
    const cnt = this.list.length;
    this.turn = cnt > 0 ? (this.turn + 1) % cnt : 0;
    for (let j = 0; j < cnt; j++) {
      const e = this.list[(this.turn + j) % cnt];
      if (upTo - e.pos > behind) e.pos = upTo - back;   // fell behind
      if (upTo > e.pos) e.run(upTo, this.ring, this.ringMask, deadline);
    }
    const used = (now() - t0) / 1000, air = n / rate;
    if (air > 0) this.busy += 0.1 * (used / air - this.busy);
  }
}

/** A channel: mixed down from the ring, decimated, resampled to one sample a chip, and its receivers. */
class Extractor {
  pos: number;
  readonly born: number;
  until = 0;
  tapped = false;
  bad: [LoraFrame, boolean, number][] = [];
  goodAt: number[] = [];
  private readonly dec: ChannelDecimator;
  /** Windowed-sinc interpolator: TAPS taps at the decimated rate, PHASES fractional positions. */
  private static readonly TAPS = 32;
  private static readonly PHASES = 128;
  private readonly poly: Float32Array;
  private readonly step: number;
  private t = Extractor.TAPS / 2;
  private subK = 0;
  private y = new Float32Array(4096);  // resampler input, interleaved; the first yLen floats are in use
  private yLen = 0;
  private cr = 1; private ci = 0;
  private readonly sr: number; private readonly si: number;
  private mixed = new Float32Array(0);
  /** Receivers by (spreading factor, inverted, timing phase): a chip sampled a fraction off its center loses a lot of
   *  a critically sampled chirp, so each one also listens a half (and quarter) chip later. */
  private readonly rx: [LoraReceiver, boolean, number][] = [];
  private count = 0;

  constructor(readonly id: number, rate: number, offHz: number, readonly bw: number, readonly hz: number, from: number,
              sfs: number[], inverted: boolean, private readonly phases: number, scanner: HeardSink, readonly slot: Slot | null) {
    this.pos = from; this.born = from;
    const d = Math.max(1, Math.floor(rate / (2 * bw)));
    this.dec = new ChannelDecimator(d);
    const r1 = rate / this.dec.total;
    this.step = r1 / bw;
    // cut a little past the channel's edges: sampled at one sample a chip, what a chirp has just past its edge folds
    // back onto itself as LoRa expects; Blackman window, each phase summing to 1
    const fc = 0.6 * bw / r1, T = Extractor.TAPS, P = Extractor.PHASES;
    const h = new Float32Array(T * P);
    for (let ph = 0; ph < P; ph++) {
      const frac = ph / P;
      let sum = 0;
      const row = new Float64Array(T);
      for (let k = 0; k < T; k++) {
        const x = k - T / 2 + 1 - frac;
        const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const u = (x + T / 2) / T;
        const w = u <= 0 || u >= 1 ? 0 : 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
        row[k] = Math.fround(sinc * w); sum += sinc * w;
      }
      for (let k = 0; k < T; k++) h[ph * T + k] = row[k] / sum;
    }
    this.poly = h;
    const w = -2 * Math.PI * offHz / rate;
    this.sr = Math.cos(w); this.si = Math.sin(w);
    // the oscillator starts at the phase the absolute sample count gives, so it doesn't matter where it begins
    const ph = w * (from % rate);
    this.cr = Math.cos(ph); this.ci = Math.sin(ph);
    for (const sf of sfs) {
      for (const inv of inverted ? [false, true] : [false]) {
        for (let p = 0; p < phases; p++) {
          const r = new LoraReceiver(sf, bw);
          r.onFrame = f => scanner.heard(f, this, inv);
          this.rx.push([r, inv, p]);
        }
      }
    }
  }

  traceAll(f: (s: string) => void): void { for (const [r, inv, ph] of this.rx) if (!inv && ph === 0) r.trace = s => f(`sf${r.sf} ` + s); }

  run(end: number, ring: Int8Array, mask: number, deadline = Infinity): void {
    const sr = this.sr, si = this.si;
    while (this.pos < end && now() < deadline) {
      const n = Math.min(end - this.pos, 65_536);
      if (this.mixed.length < 2 * n) this.mixed = new Float32Array(2 * n);
      const mixed = this.mixed;
      let cr = this.cr, ci = this.ci, count = this.count;
      let p = (this.pos & mask) * 2;
      const wrap = 2 * (mask + 1);
      for (let k = 0; k < n; k++) {
        const i = ring[p], q = ring[p + 1];
        p += 2; if (p >= wrap) p = 0;
        mixed[2 * k] = i * cr - q * ci; mixed[2 * k + 1] = i * ci + q * cr;
        const tr = cr * sr - ci * si; ci = cr * si + ci * sr; cr = tr;
        count++;
        if ((count & 1023) === 0) { const g = 1 / Math.sqrt(cr * cr + ci * ci); cr *= g; ci *= g; }
      }
      this.cr = cr; this.ci = ci; this.count = count;
      this.pos += n;
      const m = this.dec.process(mixed, n);
      if (this.yLen + 2 * m > this.y.length) { const ny = new Float32Array(Math.max(this.y.length * 2, this.yLen + 2 * m)); ny.set(this.y.subarray(0, this.yLen)); this.y = ny; }
      this.y.set(this.dec.out.subarray(0, 2 * m), this.yLen); this.yLen += 2 * m;
      this.resample();
    }
  }

  /** From the decimated rate to exactly one sample a chip, through the windowed-sinc filter (which is also the
   *  channel filter). */
  private resample(): void {
    const phases = this.phases;
    const outs: number[][] = [];
    for (let p = 0; p < phases; p++) outs.push([]);
    const y = this.y, cnt = this.yLen / 2, T = Extractor.TAPS, P = Extractor.PHASES, poly = this.poly;
    const sub = this.step / phases;
    let t = this.t, subK = this.subK;
    while (t + T / 2 < cnt) {
      const i = Math.floor(t);
      const ph = Math.min(P - 1, Math.floor((t - i) * P));
      const base = i - T / 2 + 1;
      let sr = 0, si = 0;
      const o = ph * T;
      for (let k = 0; k < T; k++) { const c = poly[o + k], yi = 2 * (base + k); sr += c * y[yi]; si += c * y[yi + 1]; }
      outs[subK].push(sr, si);
      subK = (subK + 1) % phases;
      t += sub;
    }
    this.subK = subK;
    const drop = Math.max(0, Math.floor(t) - T / 2);
    if (drop > 0) { y.copyWithin(0, 2 * drop, this.yLen); this.yLen -= 2 * drop; t -= drop; }
    this.t = t;
    if (outs[0].length === 0) return;
    if (this.tapped) LoraScanner.tap?.(outs[0]);
    for (let p = 0; p < phases; p++) {
      const out = outs[p];
      if (out.length === 0) continue;
      let conj: number[] | null = null;
      for (const [r, inv, ph] of this.rx) {
        if (ph !== p) continue;
        if (inv) {
          if (!conj) { conj = out.slice(); for (let k = 1; k < out.length; k += 2) conj[k] = -out[k]; }
          r.push(conj);
        } else r.push(out);
      }
    }
  }
}

