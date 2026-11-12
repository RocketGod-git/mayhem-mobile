/**
 * Finding every burst in the span and tuning to each one.
 *
 * Remotes, keys and sensors are rarely on the dial. A key fob that says 433.92 can sit 350 kHz off it, and some
 * hop: a Ford key sends each frame on 434.26 and again on 433.59. Listening to the whole span at once lets in the
 * noise of all of it, and listening to a narrow slice around the dial misses everything off it. So this does what
 * a person with a waterfall does: it watches the spectrum, and when something lights up it tunes a narrow
 * receiver to exactly that frequency, a few milliseconds before the burst began (the samples are kept), and lets
 * it go once the burst has been quiet for a while. Several can run at once.
 *
 * Each channel comes out as the same envelope and discriminator streams the rtl_433 detector reads, at about
 * 250 kHz, centered on the burst. What reads them is up to the caller (see `processor.ts`).
 */

import { fft, hann } from '../../fft.js';
import { Baseband } from './baseband.js';

/** One narrow receiver, following one burst. The caller keeps its own state per slot index. */
export interface BurstChannel {
  /** Which of the caller's slots this is; slots are reused once a channel closes. */
  slot: number;
  /** Offset from the radio's center, in hertz. */
  hz: number;
  /** The channel's sample rate. */
  rate: number;
  /** True for the first block after the channel opened: the caller should start this slot's readers afresh. */
  fresh: boolean;
}

/** `iq` is the channel's own samples (interleaved I, Q at the channel rate), only when `keepIq` is set. */
export type ChannelSink = (ch: BurstChannel, env: Int16Array, fm: Int16Array, n: number, iq?: Int8Array) => void;
export type ChannelEnd = (ch: BurstChannel) => void;

/** How many bursts can be followed at once. */
export const MAX_CHANNELS = 8;
/** The rate each channel runs at, roughly: wide enough for a ±60 kHz shift, narrow enough to shed the noise. */
const CHANNEL_RATE = 250_000;
/** How far apart two lit frequencies must be to be followed separately. */
const SAME_BURST_HZ = 100_000;
/** How long a channel stays open after its burst last lit the spectrum. */
const HOLD_MS = 60;
/** How far back a new channel starts, so the burst's opening is not lost to the time it took to notice it. */
const LOOKBACK_MS = 12;
/** A frequency is lit when the power around it stands this far above its own noise. */
const LIT_DB = 8;
/**
 * A strong burst splatters faint copies of itself across the span (the radio's own images and mixing products).
 * Anything lit this far below the strongest burst of the same moment is taken for that, not for a second device.
 */
const SPLATTER_DB = 25;
/** The band's middle this far over its usual level means the whole band is lifted (a strong signal right by the antenna). */
const RAISED = 2;
/** Bins either side of center ignored while the band is lifted: the radio's own offset jumps most there. */
const DC_BINS = 2;
/** How many looks at the spectrum are averaged into one decision. */
const LOOKS = 4;
/** The finder looks at about this many samples a second at most; a burst lasts milliseconds, so it misses none. */
const FINDER_BUDGET = 2_400_000;

interface Open { slot: number; hz: number; lastLit: number; pos: number; start: number; bb: Baseband; phase: number; fresh: boolean }

export class BurstChannels {
  private rate = 0;
  private n = 256;
  private re = new Float32Array(0); private im = new Float32Array(0); private win = new Float32Array(0);
  private floor = new Float32Array(0); private pow = new Float32Array(0); private acc = new Float32Array(0);
  private accN = 0; private raisedRun = 0; private floorMid = 0;
  private sorted = new Float32Array(0);
  private litBefore = new Uint8Array(0);
  private frames = 0;
  private everyN = 1;
  private frameAcc = 0;
  /** Raw samples kept for look-back, as a ring of interleaved bytes. */
  private ring = new Int8Array(0);
  private ringMask = 0;
  /** Absolute index of the next sample to arrive. */
  private written = 0;
  private readonly open: Open[] = [];
  private readonly free: number[] = [];
  private scratch = new Int8Array(0);
  private decim = 8;
  /** How many channels opened since the start, for the status line. */
  opened = 0;
  /** Hand each channel's raw samples to the sink as well (the Analyzer keeps them); off for the Devices app. */
  keepIq = false;
  /** Absolute index of the next sample to arrive, so a caller can say when a channel opened. */
  get samples(): number { return this.written; }
  /** The absolute sample a channel's first block starts at (its look-back included). */
  startOf(slot: number): number { return this.open.find(o => o.slot === slot)?.start ?? 0; }

  constructor(private readonly onChannel: ChannelSink, private readonly onEnd: ChannelEnd) {}

  reset(rate: number): void {
    this.rate = rate;
    // bins of roughly 8 kHz: narrow enough to see a weak key, wide enough that a burst's power lands in a few
    let n = 64; while (rate / n > 8_000 && n < 4096) n *= 2;
    this.n = n;
    this.re = new Float32Array(n); this.im = new Float32Array(n); this.win = hann(n);
    this.floor = new Float32Array(n); this.pow = new Float32Array(n); this.acc = new Float32Array(n); this.litBefore = new Uint8Array(n);
    this.accN = 0; this.raisedRun = 0; this.floorMid = 0; this.sorted = new Float32Array(n);
    this.frames = 0; this.frameAcc = 0;
    this.everyN = Math.max(1, Math.round(rate / FINDER_BUDGET));
    this.decim = Math.max(1, Math.round(rate / CHANNEL_RATE));
    let size = 1; while (size < rate * 0.25 * 2) size *= 2;     // a quarter second of bytes
    this.ring = new Int8Array(size); this.ringMask = size - 1;
    this.written = 0;
    for (const o of this.open) this.onEnd(this.channel(o));
    this.open.length = 0;
    this.free.length = 0;
    for (let i = MAX_CHANNELS - 1; i >= 0; i--) this.free.push(i);
  }

  /** The rate each channel delivers. */
  channelRate(): number { return this.rate / this.decim; }
  /** How many channels are following a burst right now. */
  active(): number { return this.open.length; }
  /** The frequencies being followed right now, as offsets from center. */
  offsets(): number[] { return this.open.map(o => o.hz); }

  process(iq: Int8Array): void {
    const nSamp = iq.length >> 1;
    if (!this.rate || nSamp === 0) return;
    // keep the samples for look-back
    if (iq.length * 2 > this.ring.length) this.growRing(iq.length * 2);
    let w = (this.written * 2) & this.ringMask;
    for (let i = 0; i < iq.length; i++) { this.ring[w] = iq[i]; w = (w + 1) & this.ringMask; }
    const start = this.written;
    this.written += nSamp;

    // look for lit frequencies, frame by frame
    const N = this.n;
    for (let f = 0; f + N <= nSamp; f += N) {
      if (++this.frameAcc < this.everyN) continue;
      this.frameAcc = 0;
      this.findIn(iq, f, start + f);
    }

    // run every open channel up to the newest sample, then close the ones gone quiet
    const now = this.written;
    const holdS = Math.round(this.rate * HOLD_MS / 1000);
    for (let k = this.open.length - 1; k >= 0; k--) {
      const o = this.open[k];
      this.run(o, now);
      if (now - o.lastLit > holdS) {
        this.onEnd(this.channel(o));
        this.open.splice(k, 1);
        this.free.push(o.slot);
      }
    }
  }

  private growRing(minBytes: number): void {
    let size = this.ring.length; while (size < minBytes) size *= 2;
    const next = new Int8Array(size);
    const old = this.ring, om = this.ringMask;
    // copy the newest old.length bytes into their positions in the new ring
    const end = this.written * 2;
    for (let a = Math.max(0, end - old.length); a < end; a++) next[a & (size - 1)] = old[a & om];
    this.ring = next; this.ringMask = size - 1;
  }

  private findIn(iq: Int8Array, off: number, absStart: number): void {
    const N = this.n, re = this.re, im = this.im, win = this.win;
    let mi = 0, mq = 0;
    for (let i = 0; i < N; i++) { mi += iq[2 * (off + i)]; mq += iq[2 * (off + i) + 1]; }
    mi /= N; mq /= N;
    for (let i = 0; i < N; i++) { re[i] = (iq[2 * (off + i)] - mi) * win[i]; im[i] = (iq[2 * (off + i) + 1] - mq) * win[i]; }
    fft(re, im);
    const pow = this.pow, floor = this.floor, acc = this.acc;
    // power summed over three neighboring bins, so a burst spread across a few still stands out, and averaged
    // over a few looks before deciding: a single look is too spiky, and the splatter of a strong burst flickers
    // over the threshold in it
    for (let i = 0; i < N; i++) {
      const a = (i + N - 1) % N, b = (i + 1) % N;
      acc[i] += re[a] * re[a] + im[a] * im[a] + re[i] * re[i] + im[i] * im[i] + re[b] * re[b] + im[b] * im[b];
    }
    if (++this.accN < LOOKS) return;
    for (let i = 0; i < N; i++) { pow[i] = acc[i] / LOOKS; acc[i] = 0; }
    this.accN = 0;
    this.frames++;
    const warm = this.frames < 32;
    const lit = Math.pow(10, LIT_DB / 10);
    const litNow = this.litBefore;
    // collect lit bins (two decisions running, so a lone noise spike does not open a channel), strongest first
    // The level a bin must beat: its own learned noise, or the band's middle right now if that is higher. A key
    // pressed next to the antenna lifts the whole band (and the center most of all) for as long as it sends; the
    // burst itself still stands well clear of that, and nothing else should open on the rise.
    const med = this.median(pow);
    const raised = !warm && med > this.floorMid * RAISED;
    const hits: { bin: number; p: number }[] = [];
    let litCount = 0;
    for (let i = 0; i < N; i++) {
      const p = pow[i];
      if (warm) { floor[i] = floor[i] ? floor[i] + (p - floor[i]) / this.frames : p; litNow[i] = 0; continue; }
      const on = p > (floor[i] > med ? floor[i] : med) * lit && !(raised && (i <= DC_BINS || i >= N - DC_BINS));
      if (on) { litCount++; if (litNow[i]) hits.push({ bin: i, p }); }
      litNow[i] = on ? 1 : 0;
    }
    if (warm) { this.floorMid = med; return; }
    // the floor learns only while the band is at rest; if it stays raised for a second, that is the new floor
    this.raisedRun = raised ? this.raisedRun + 1 : 0;
    const rebase = this.raisedRun * N * LOOKS > this.rate;
    if (rebase) { for (let i = 0; i < N; i++) floor[i] = pow[i]; this.floorMid = med; this.raisedRun = 0; }
    else if (!raised) {
      for (let i = 0; i < N; i++) if (pow[i] <= floor[i] * lit) floor[i] += (pow[i] - floor[i]) / 32;
      this.floorMid += (med - this.floorMid) / 32;
    }
    void litCount;
    if (!hits.length) return;
    hits.sort((x, y) => y.p - x.p);
    const binHz = this.rate / N;
    const splatter = hits[0].p / Math.pow(10, SPLATTER_DB / 10);
    for (const h of hits) {
      if (h.p < splatter) break;
      // refine to the power-weighted middle of the lit run around this bin
      let s = 0, sw = 0;
      for (let d = -3; d <= 3; d++) { const j = (h.bin + d + N) % N; const p = pow[j]; if (p > floor[j] * lit) { s += p * d; sw += p; } }
      const bin = h.bin + (sw ? s / sw : 0);
      const hz = (bin < N / 2 ? bin : bin - N) * binHz;
      const o = this.open.find(x => Math.abs(x.hz - hz) < SAME_BURST_HZ);
      if (o) { o.lastLit = absStart + N; continue; }
      if (!this.free.length) continue;
      const slot = this.free.pop()!;
      const bb = new Baseband(); bb.decim = this.decim; bb.keepIq = this.keepIq;
      const back = Math.round(this.rate * LOOKBACK_MS / 1000);
      const pos = Math.max(absStart - back, this.written - (this.ring.length >> 1) + 1, 0);
      this.open.push({ slot, hz, lastLit: absStart + N, pos, start: pos, bb, phase: 0, fresh: true });
      this.opened++;
    }
  }

  private median(v: Float32Array): number {
    const s = this.sorted; s.set(v); s.sort();
    return s[s.length >> 1];
  }

  /** Tune one channel down to its burst and hand the result on, from where it left off up to `upto`. */
  private run(o: Open, upto: number): void {
    const count = upto - o.pos;
    if (count <= 0) return;
    if (this.scratch.length < count * 2) this.scratch = new Int8Array(count * 2);
    const out = this.scratch, ring = this.ring, mask = this.ringMask;
    const step = -2 * Math.PI * o.hz / this.rate;
    // rotate by a running phasor, re-normalized each block so rounding cannot make it drift in size
    let cr = Math.cos(o.phase), ci = Math.sin(o.phase);
    const sr = Math.cos(step), si = Math.sin(step);
    let r = (o.pos * 2) & mask;
    for (let k = 0; k < count; k++) {
      const I = ring[r], Q = ring[(r + 1) & mask];
      r = (r + 2) & mask;
      const yi = I * cr - Q * ci, yq = I * ci + Q * cr;
      out[2 * k] = yi > 127 ? 127 : yi < -128 ? -128 : Math.round(yi);
      out[2 * k + 1] = yq > 127 ? 127 : yq < -128 ? -128 : Math.round(yq);
      const t = cr * sr - ci * si; ci = cr * si + ci * sr; cr = t;
    }
    o.phase = (o.phase + step * count) % (2 * Math.PI);
    o.pos = upto;
    const res = o.bb.process(out.subarray(0, count * 2));
    const ch = this.channel(o);
    o.fresh = false;
    this.onChannel(ch, res.env, res.fm, res.n, this.keepIq ? res.iq : undefined);
  }

  private channel(o: Open): BurstChannel {
    return { slot: o.slot, hz: o.hz, rate: this.rate / this.decim, fresh: o.fresh };
  }
}
