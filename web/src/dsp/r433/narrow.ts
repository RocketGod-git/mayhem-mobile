/**
 * The narrow on-off-keyed path, for sensors too weak for the wide channels.
 *
 * The wide channels (`channels.ts`) look at the spectrum in 8 kHz bins and read each burst through a 250 kHz
 * channel, which suits keys and FSK sensors that move tens of kilohertz. A weather station on the far side of
 * the street can sit only about 10 dB over the noise in 5 kHz: in an 8 kHz bin it barely lights, and in 250 kHz
 * of envelope it is under the noise. This path watches the spectrum in 2 kHz bins, averaged over several
 * milliseconds, and when a narrow peak stands there it reads that frequency through a channel only about 6 kHz
 * wide at 100 kS/s, which keeps the 10 dB. Only the envelope is read (on-off keying), and only by the
 * checksummed decoders (see `processor.ts`), so the extra sensitivity does not bring extra false readings.
 */

import { fft, hann } from '../../fft.js';

/** How many narrow channels can run at once. */
export const NARROW_MAX = 4;
/** Finder bins about this wide. */
const BIN_HZ = 2_000;
/** The rate each narrow channel runs at: pulses down to 100 µs stay ten samples long for the detector. */
const NARROW_RATE = 100_000;
/** Moving average after the decimator, in channel samples: 16 at 100 kS/s puts its first null at 6.25 kHz. */
const SMOOTH = 16;
/** Looks averaged into one decision: about 8 ms at 2 MS/s. A weak sensor keys for 50 ms or more. */
const LOOKS = 16;
/** Lit when this far over the bin's own noise; with 16 looks of three bins the noise alone stays well under it. */
const LIT_DB = 5;
/** Two lit peaks closer than this are the same transmission. */
const SAME_HZ = 8_000;
/** Kept open this long after the peak was last lit. */
const HOLD_MS = 120;
/** Started this far back, so the detector has learned the noise before the burst it was opened for. */
const LOOKBACK_MS = 80;
/** Anything lit this far under the strongest peak of the moment is its splatter, not a second device. */
const SPLATTER_DB = 25;
/** The noise magnitude the channel is scaled to, so the detector's 9 dB carrier ratio governs, not its fixed floor. */
const NOISE_LEVEL = 800;
/** The finder looks at about this many samples a second at most. */
const FINDER_BUDGET = 1_200_000;

/** One narrow receiver. */
export interface NarrowChannel { slot: number; hz: number; rate: number; fresh: boolean }
export type NarrowSink = (ch: NarrowChannel, env: Int16Array, fm: Int16Array, n: number) => void;
export type NarrowEnd = (ch: NarrowChannel) => void;

interface Open {
  slot: number; hz: number; lastLit: number; pos: number; fresh: boolean;
  cr: number; ci: number;
  ai: number; aq: number; acc: number;
  mi: Float32Array; mq: Float32Array; mp: number; si: number; sq: number;
  gain: number;
}

export class NarrowOok {
  private rate = 0;
  private n = 1024;
  private re = new Float32Array(0); private im = new Float32Array(0); private win = new Float32Array(0);
  private floor = new Float32Array(0); private acc = new Float32Array(0); private pow = new Float32Array(0);
  private litBefore = new Uint8Array(0); private sorted = new Float32Array(0);
  private accN = 0; private frames = 0; private everyN = 1; private frameAcc = 0;
  private ring = new Int8Array(0); private ringMask = 0; private written = 0;
  private readonly open: Open[] = [];
  private readonly free: number[] = [];
  private decim = 20;
  private env = new Int16Array(0); private fm = new Int16Array(0);
  /** Channels opened since the start. */
  opened = 0;

  constructor(private readonly onChannel: NarrowSink, private readonly onEnd: NarrowEnd) {}

  reset(rate: number): void {
    for (const o of this.open) this.onEnd(this.channel(o));
    this.open.length = 0; this.free.length = 0;
    for (let i = NARROW_MAX - 1; i >= 0; i--) this.free.push(i);
    this.rate = rate;
    let n = 64; while (rate / n > BIN_HZ && n < 8192) n *= 2;
    this.n = n;
    this.re = new Float32Array(n); this.im = new Float32Array(n); this.win = hann(n);
    this.floor = new Float32Array(n); this.acc = new Float32Array(n); this.pow = new Float32Array(n);
    this.litBefore = new Uint8Array(n); this.sorted = new Float32Array(n);
    this.accN = 0; this.frames = 0; this.frameAcc = 0;
    this.everyN = Math.max(1, Math.round(rate / FINDER_BUDGET));
    this.decim = Math.max(1, Math.round(rate / NARROW_RATE));
    let size = 1; while (size < rate * 0.25 * 2) size *= 2;
    this.ring = new Int8Array(size); this.ringMask = size - 1; this.written = 0;
  }

  channelRate(): number { return this.rate / this.decim; }
  active(): number { return this.open.length; }
  offsets(): number[] { return this.open.map(o => o.hz); }

  process(iq: Int8Array): void {
    const nSamp = iq.length >> 1;
    if (!this.rate || nSamp === 0) return;
    if (iq.length * 2 > this.ring.length) this.growRing(iq.length * 2);
    let w = (this.written * 2) & this.ringMask;
    for (let i = 0; i < iq.length; i++) { this.ring[w] = iq[i]; w = (w + 1) & this.ringMask; }
    const start = this.written;
    this.written += nSamp;
    const N = this.n;
    for (let f = 0; f + N <= nSamp; f += N) {
      if (++this.frameAcc < this.everyN) continue;
      this.frameAcc = 0;
      this.findIn(iq, f, start + f);
    }
    const now = this.written, hold = Math.round(this.rate * HOLD_MS / 1000);
    for (let k = this.open.length - 1; k >= 0; k--) {
      const o = this.open[k];
      this.run(o, now);
      if (now - o.lastLit > hold) { this.onEnd(this.channel(o)); this.open.splice(k, 1); this.free.push(o.slot); }
    }
  }

  private growRing(minBytes: number): void {
    let size = this.ring.length; while (size < minBytes) size *= 2;
    const next = new Int8Array(size), old = this.ring, om = this.ringMask, end = this.written * 2;
    for (let a = Math.max(0, end - old.length); a < end; a++) next[a & (size - 1)] = old[a & om];
    this.ring = next; this.ringMask = size - 1;
  }

  private findIn(iq: Int8Array, off: number, absStart: number): void {
    const N = this.n, re = this.re, im = this.im, win = this.win, acc = this.acc;
    let mi = 0, mq = 0;
    for (let i = 0; i < N; i++) { mi += iq[2 * (off + i)]; mq += iq[2 * (off + i) + 1]; }
    mi /= N; mq /= N;
    for (let i = 0; i < N; i++) { re[i] = (iq[2 * (off + i)] - mi) * win[i]; im[i] = (iq[2 * (off + i) + 1] - mq) * win[i]; }
    fft(re, im);
    for (let i = 0; i < N; i++) {
      const a = (i + N - 1) % N, b = (i + 1) % N;
      acc[i] += re[a] * re[a] + im[a] * im[a] + re[i] * re[i] + im[i] * im[i] + re[b] * re[b] + im[b] * im[b];
    }
    if (++this.accN < LOOKS) return;
    const pow = this.pow, floor = this.floor, litNow = this.litBefore;
    for (let i = 0; i < N; i++) { pow[i] = acc[i] / LOOKS; acc[i] = 0; }
    this.accN = 0; this.frames++;
    if (this.frames <= 8) { for (let i = 0; i < N; i++) floor[i] = floor[i] ? Math.min(floor[i], pow[i]) : pow[i]; return; }
    const lit = Math.pow(10, LIT_DB / 10), med = this.median(pow);
    const hits: { bin: number; p: number }[] = [];
    for (let i = 0; i < N; i++) {
      const p = pow[i], ref = floor[i] > med ? floor[i] : med;
      // the bins next to the radio's own center offset are left to the wide path
      const on = p > ref * lit && i > 1 && i < N - 1;
      if (on && litNow[i]) hits.push({ bin: i, p });
      litNow[i] = on ? 1 : 0;
      if (p <= floor[i] * lit) floor[i] += (p - floor[i]) / 32;
    }
    if (!hits.length) return;
    hits.sort((x, y) => y.p - x.p);
    const binHz = this.rate / N, splatter = hits[0].p / Math.pow(10, SPLATTER_DB / 10);
    for (const h of hits) {
      if (h.p < splatter) break;
      // a narrow peak only: the wide path already reads anything spread over more than about 10 kHz
      let width = 1;
      for (let d = 1; d <= 8; d++) { const j = (h.bin + d) % N; if (pow[j] > floor[j] * lit) width++; else break; }
      for (let d = 1; d <= 8; d++) { const j = (h.bin - d + N) % N; if (pow[j] > floor[j] * lit) width++; else break; }
      if (width > 7) continue;
      let s = 0, sw = 0;
      for (let d = -2; d <= 2; d++) { const j = (h.bin + d + N) % N; const p = pow[j]; if (p > floor[j] * lit) { s += p * d; sw += p; } }
      const bin = h.bin + (sw ? s / sw : 0), hz = (bin < N / 2 ? bin : bin - N) * binHz;
      const o = this.open.find(x => Math.abs(x.hz - hz) < SAME_HZ);
      if (o) { o.lastLit = absStart + N; continue; }
      if (!this.free.length) continue;
      const slot = this.free.pop()!;
      const back = Math.round(this.rate * LOOKBACK_MS / 1000);
      const pos = Math.max(absStart - back, this.written - (this.ring.length >> 1) + 1, 0);
      this.open.push({
        slot, hz, lastLit: absStart + N, pos, fresh: true, cr: 1, ci: 0,
        ai: 0, aq: 0, acc: 0,
        mi: new Float32Array(SMOOTH), mq: new Float32Array(SMOOTH), mp: 0, si: 0, sq: 0, gain: 0,
      });
      this.opened++;
    }
  }

  private median(v: Float32Array): number { const s = this.sorted; s.set(v); s.sort(); return s[s.length >> 1]; }

  /** Mix one channel to its peak, decimate, smooth and take the envelope, from where it left off up to `upto`. */
  private run(o: Open, upto: number): void {
    const count = upto - o.pos;
    if (count <= 0) return;
    const D = this.decim, cap = Math.ceil(count / D) + 2;
    if (this.env.length < cap) { this.env = new Int16Array(cap); this.fm = new Int16Array(cap); }
    const env = this.env, mag = new Float32Array(cap), ring = this.ring, mask = this.ringMask;
    const step = -2 * Math.PI * o.hz / this.rate, sr = Math.cos(step), si = Math.sin(step);
    let cr = o.cr, ci = o.ci, r = (o.pos * 2) & mask, n = 0, ai = o.ai, aq = o.aq, acc = o.acc;
    for (let k = 0; k < count; k++) {
      const I = ring[r] + 0.5, Q = ring[(r + 1) & mask] + 0.5;
      r = (r + 2) & mask;
      // mix to the peak and average groups of D: a boxcar whose nulls land on every alias of the narrow band
      ai += I * cr - Q * ci; aq += I * ci + Q * cr;
      const t = cr * sr - ci * si; ci = cr * si + ci * sr; cr = t;
      if (++acc < D) continue;
      acc = 0;
      const yi = ai / D, yq = aq / D; ai = 0; aq = 0;
      o.si += yi - o.mi[o.mp]; o.sq += yq - o.mq[o.mp]; o.mi[o.mp] = yi; o.mq[o.mp] = yq; o.mp = (o.mp + 1) % SMOOTH;
      mag[n++] = Math.hypot(o.si, o.sq) / SMOOTH;
    }
    const m = Math.hypot(cr, ci); cr /= m; ci /= m;
    o.cr = cr; o.ci = ci; o.ai = ai; o.aq = aq; o.acc = acc;
    o.pos = upto;
    if (!n) return;
    // scale once, from the quiet start of the look-back, so the noise sits where the detector's ratio works
    if (!o.gain) {
      const s = Array.from(mag.subarray(0, n)).sort((a, b) => a - b), q = s[Math.floor(n * 0.3)] || 1e-3;
      o.gain = Math.min(4000, Math.max(1, NOISE_LEVEL / q));
    }
    for (let i = 0; i < n; i++) { const v = mag[i] * o.gain; env[i] = v > 32767 ? 32767 : v; }
    this.fm.fill(0, 0, n);
    const ch = this.channel(o);
    o.fresh = false;
    this.onChannel(ch, env, this.fm, n);
  }

  private channel(o: Open): NarrowChannel { return { slot: o.slot, hz: o.hz, rate: this.rate / this.decim, fresh: o.fresh }; }
}
