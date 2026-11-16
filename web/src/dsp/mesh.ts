/**
 * Smart-meter mesh receiver (twin of the iOS/Kotlin MeshDecoder; our own decoder, no Mayhem or rtl_433
 * counterpart), worked out from recordings rather than a spec. Meter networks in 902-928 MHz hop a 2-FSK carrier
 * (9600 baud is the common rate) across dozens of channels, a burst of 5-25 ms per hop, so no single channel decoder
 * catches them. This one watches the whole span instead:
 *
 * 1. An FFT every half millisecond or so against a per-bin noise floor finds every burst and its center, wherever
 *    it hops.
 * 2. When a burst ends, its samples (kept in a ring) are mixed to DC, filtered to ±45 kHz and decimated, FM
 *    discriminated, centered (the carrier's error sits between the two tones) and sliced at the clock phase with the
 *    widest eye.
 * 3. The alternating preamble is found and the 24 bits after it are the network's sync word. Every network is
 *    learned that way, whoever made it: frames group by sync word, and a polarity rule (the preamble ends on a 1)
 *    makes the same network read the same on every radio.
 * 4. Landis+Gyr Gridstream (sync of 0xAA bytes, then UART-framed 00 FF) is recognized as such: bytes deframed and the
 *    CRC-16/CCITT checked with the published utility seeds, and a beacon's meter LAN address read out.
 * 5. IEEE 802.15.4g SUN-FSK at 50 kb/s (+-25 kHz, the standard's FSK operating mode 1): the standard's SFD, PHR and PN9
 *    whitening, and a frame check. The network heard at 911.6 MHz (worked out from our own 902-922 MHz recording,
 *    2026-11-15) wakes its sleeping receivers with a ~150 ms preamble, so bursts up to half a second are kept for it,
 *    and its CRC-16 (x^16+x^12+x^5+1 over the de-whitened bits in air order) starts from 0x1877, not 0: all 27 clean
 *    frames of that recording pass. Each 7-byte device ID gets a card with its frame counter and network ID.
 *
 * MetersProcessor runs it beside ErtDecoder on the same samples: the Meters app.
 */
import { popcount32, type Emit, type IqProcessor } from './core.js';
import { fft } from '../fft.js';
import { ChannelDecimator, ComplexFirDecimator, lowpassTaps } from './ham/filters.js';
import { ErtDecoder } from './ert.js';

/** One frame pulled out of a burst. */
export interface MeshFrame {
  ms: number; hz: number; snrDb: number;
  /** The network's 24-bit sync word (the bits right after the preamble), or GRIDSTREAM. */
  sync: number;
  baud: number;
  /** Whole bytes after the sync, MSB first (Gridstream: the UART-framed bytes, LSB first). */
  bytes: number[];
  durMs: number;
  /** Gridstream only: the CRC checked with a known utility seed. */
  crcOk: boolean;
  /** Gridstream only: the length field matches the bytes received (the CRC seed differs by utility). */
  lenOk: boolean;
  /** 802.15.4g only: the CRC-16 start the frame passed with. */
  crcInit?: number;
  /** The 9C··15 network only: the channel byte its sync word carries. */
  tag?: number;
}

/** Everything heard from one network (one sync word). */
export interface MeshNet {
  sync: number; frames: number;
  types: Record<number, number>;
  /** 25 kHz slots. */
  channels: number[];
  loHz: number; hiHz: number;
  lastHex: string; lastMs: number; bestSnr: number;
  /** Gridstream LAN addresses with a good CRC. */
  meters: number[];
}

export interface MeshHop { hz: number; ms: number }
export interface MeshField { name: string; value: string }
/** Two Gridstream meters heard talking (a routed frame from one, addressed to the other). */
export interface MeshLink { a: number; b: number }

/**
 * One transmitter. On the networks heard so far the first byte after the sync word names the sender: each value
 * comes with its own signal level and its own free-running 16-bit clock in the next two bytes, counting down at 128
 * a second (the node's hop clock, which lets neighbors predict its channel). Gridstream senders are keyed by the LAN
 * address in their beacons.
 */
export interface MeshDevice {
  key: string;
  net: number; id: number;
  frames: number; firstMs: number; lastMs: number;
  /** Recent hops, oldest first. */
  hops: MeshHop[];
  /** Signal of recent frames, oldest first. */
  snr: number[];
  /** The 16-bit clock in bytes 1-2 of the last frame, and its rate in ticks a second (negative counts down). */
  clock: number; clockMs: number; clockRate: number;
  ckMs: number[]; ckV: number[];
  pendMs: number | null; pendV: number; pendRun: number;
  lastHex: string;
  lengths: number[];
  /** The node's 24-bit ID, from its long F0 frames ([index] F0 [ID 24] [clock 16] ... 01 00). -1 until one is heard. */
  address: number; addressSeen: number;
  /** Gridstream: seconds since power-on, as of uptimeMs. */
  uptimeS: number; uptimeMs: number;
  /** Times the hop clock jumped to a new count (a resync). */
  resyncs: number;
  /** ERT only: the packet kind, commodity, and consumption (first and latest). */
  ertKind: string; commodity: string;
  consFirst: number; cons: number; consHistory: number[];
  /** Gridstream: position from the WAN address (the most-heard one wins), its node color. */
  lat: number | null; lon: number | null; posColor: number;
  /** WAN address -> beacons that carried it. */
  wanVotes: Record<string, number>;
  /** Name and value of every field decoded from this device's frames, for the detail panel. */
  fields: MeshField[];
  fieldsBy: Record<string, MeshField[]>;
  fieldOrder: string[];
  /** Gridstream: the other meters this one has addressed (LAN ids). */
  talksTo: number[];
  /** Gridstream: how many frames from other meters were addressed to it. */
  addressed: number;
  label: string;
}

/** The snapshot the worker posts to the screen. */
export interface MetersSnapshot { type: 'meters'; nets: MeshNet[]; devices: MeshDevice[]; links: MeshLink[]; bursts: number; busy: number }

const GRIDSTREAM = -1, ERT = -2, SUN = -3, FAST = -4;
/** The 38.4 kbaud network whose sync word carries a channel byte in its middle: 9C, the channel, 15. */
const HOP9C = 0x9C0015;
/** A Gridstream uptime above 20 years is a bit error, not a node that has run that long. */
const UPTIME_MAX = 20 * 365 * 86400;
const h2 = (v: number) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const h8 = (v: number) => (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
const hex = (b: number[]) => b.map(h2).join('');
const hxs = (b: number[]) => b.map(h2).join(' ');
const u32 = (b: number[], at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const pc = (x: number) => popcount32(x >>> 0);

function newDevice(net: number, id: number, firstMs: number): MeshDevice {
  id = id >>> 0;
  return {
    key: `${net}/${id}`, net, id, frames: 0, firstMs, lastMs: 0, hops: [], snr: [], clock: -1, clockMs: 0, clockRate: 0,
    ckMs: [], ckV: [], pendMs: null, pendV: 0, pendRun: 0, lastHex: '', lengths: [], address: -1, addressSeen: 0,
    uptimeS: -1, uptimeMs: 0, resyncs: 0, ertKind: '', commodity: '', consFirst: -1, cons: -1, consHistory: [],
    lat: null, lon: null, posColor: 0, wanVotes: {}, fields: [], fieldsBy: {}, fieldOrder: [], talksTo: [], addressed: 0,
    label: net === ERT ? String(id) : net === GRIDSTREAM ? h8(id) : net === SUN ? '' : h2(id),
  };
}

/** The clock now, run on from the last frame at its rate (16 bits, wrapping). */
export function clockAt(d: MeshDevice, ms: number): number {
  if (d.clock < 0) return -1;
  const v = d.clock + Math.round(d.clockRate * (ms - d.clockMs) / 1000);
  return d.net === GRIDSTREAM ? ((v % 16_800) + 16_800) % 16_800 : v & 0xFFFF;
}
/** Gridstream: seconds since power-on now. */
export function uptimeAt(d: MeshDevice, ms: number): number { return d.uptimeS < 0 ? -1 : d.uptimeS + Math.trunc((ms - d.uptimeMs) / 1000); }
/** Frames a second, over the last minute of hops. */
export function perSecond(d: MeshDevice): number {
  if (d.hops.length < 2) return 0;
  const a = d.hops[0], b = d.hops[d.hops.length - 1];
  return b.ms > a.ms ? (d.hops.length - 1) / ((b.ms - a.ms) / 1000) : 0;
}

/**
 * A Gridstream WAN address as latitude and longitude: 48 bits of S (1), latitude (20), W (1), longitude (21) and a
 * node color (5) that tells apart nodes at one spot, with 90 degrees scaled to 2^21 and the angle counted from the
 * pole and the antimeridian. Layout from the MIT-licensed gpsdecode (github.com/beroset/gpsdecode), checked against
 * its worked example: 42:CB:BE:0E:55:E5 is 43.0342 N, 87.4801 W, color 5.
 */
export const GridstreamWan = {
  decode(v: number): { lat: number; lon: number; color: number } | null {
    const k = 90 / 1_048_576;
    const color = v % 32;
    const lonBits = Math.floor(v / 32) % 2 ** 21, west = Math.floor(v / 2 ** 26) % 2 === 1;
    const latBits = Math.floor(v / 2 ** 27) % 2 ** 20, south = Math.floor(v / 2 ** 47) % 2 === 1;
    let lat = 90 - k * latBits, lon = 180 - k * lonBits;
    if (south) lat = -lat;
    if (west) lon = -lon;
    if (!(lat > -90 && lat < 90 && lon > -180 && lon < 180)) return null;
    return { lat, lon, color };
  },
  value(b: number[], at: number): number { let v = 0; for (let i = 0; i < 6; i++) v = v * 256 + b[at + i]; return v; },
};

export class MeshDecoder implements IqProcessor {
  static readonly RATE = 4_194_304;
  /** The wide span Meters opens at where the radio can take it. */
  static readonly WIDE = 19_200_000;
  static readonly BAUDS = [9600, 19200, 38400];
  static readonly GRIDSTREAM = GRIDSTREAM;
  /** ERT meters (Itron SCM / SCM+ / IDM, Neptune R900) share the device list, decoded by ErtDecoder on the same samples. */
  static readonly ERT = ERT;
  /** IEEE 802.15.4g SUN-FSK frames, any network (see sunParse). */
  static readonly SUN = SUN;
  static readonly SUN_BAUD = 50_000;
  /** CRC-16 starts of the SUN networks heard (0x1877: the 911.6 MHz network), tried before the standard's own. */
  static readonly SUN_INITS = [0x1877];
  /** The 106.4 kbaud network (2-FSK, ±44 kHz): its 32-bit sync after the 0101 preamble. */
  static readonly FAST = FAST;
  static readonly FAST_BAUD = 106_400;
  static readonly FAST_SYNC = 0x39717DF1;
  static readonly HOP9C = HOP9C;
  /** Utility seeds for Gridstream's CRC (CoServ, Oncor), from the RECESSIM wiki. */
  static readonly GS_SEEDS = [0x45F8, 0x5FD6];
  static readonly R900_SYNC = 0b00000000000000001110010101100100;
  /** Networks shown once they have this many frames; fewer is most likely a burst with bit errors. */
  static readonly MIN_FRAMES = 3;
  /** Debug: where Gridstream frames that end early are described (tests and tools). */
  static trace: ((s: string) => void) | null = null;

  /** Where the radio is tuned (for the frequencies shown); set by the worker. */
  centerHz = 0;
  now: () => number = () => Date.now();
  /** Every decoded frame, for tests and tools. */
  onFrame: ((f: MeshFrame) => void) | null = null;
  /** Off for replays and tests, which run at their own pace (a slow machine is not behind any radio). */
  shedding = true;
  /** How much of real time this decoder is taking (smoothed): above 0.5 only the strongest bursts are demodulated,
   *  above 0.8 none are, so a busy band at a wide span can never starve the waterfall or stall the radio. */
  busy = 0;
  /** Gridstream power usage reports heard (sender not in the clear). */
  dcwReports = 0;

  private netMap = new Map<number, MeshNet>();
  private devMap = new Map<string, MeshDevice>();
  private linkSet = new Map<string, MeshLink>();
  private lastLog = new Map<number, number>();
  private kinds = new Set<string>();
  /** Sync words of the networks with enough frames to be sure of. */
  private established: number[] = [];
  /** Each network's first two payload bytes, counted: the most common pair follows its sync on the air. */
  private heads = new Map<number, Map<number, number>>();
  /** Frames thrown away as a slipped read of an established network (see slipOf). */
  slips = 0;
  private lastPublish = 0;
  /** The tables as last published. */
  nets: MeshNet[] = [];
  devices: MeshDevice[] = [];
  links: MeshLink[] = [];
  bursts = 0;

  // ---- detection ----
  /** FFT size and step, set with the rate: bins of about 8 kHz, a look every half millisecond or so. */
  private N = 512; private HOP = 2048;
  private rate = MeshDecoder.RATE;
  private win = new Float32Array(512);
  private re = new Float32Array(512); private im = new Float32Array(512);
  private floor = new Float32Array(512);
  private get binHz(): number { return this.rate / this.N; }
  private frames = 0;
  private ring = new Int8Array(0);
  private ringMask = 0;
  private written = 0;
  private nextFrame = 0;
  private active: { start: number; last: number; wSum: number; w: number; peak: number; bin: number }[] = [];
  /** Long bursts (wake-up preambles) looked at again once the frame after them has had time to arrive. */
  private tails: { start: number; last: number; peak: number; bin: number; due: number }[] = [];
  /** 802.15.4g frames published in the last half second (bytes -> sample count), so a frame is published once. */
  private sunSeen = new Map<string, number>();
  private fastHeads = new Map<string, number>();
  private count = 0;
  private shed = 0;
  /** Frames after the first in the same burst, published right after it. */
  private extraFrames: MeshFrame[] = [];

  constructor(private readonly emit: Emit) {}

  reset(rate: number): void {
    this.rate = rate;
    // bins of 8-20 kHz (a burst is 40 kHz wide) and a look every half millisecond (bursts last 5-25 ms): at 19.2 Msps
    // a finer grid and a look every 0.1 ms cost ten times this and fell behind the radio
    let N = 512; while (rate / N > 20_000) N <<= 1;
    this.N = N;
    this.HOP = Math.max(N, 2048, Math.floor(rate / 2000));
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.win = new Float32Array(N); for (let k = 0; k < N; k++) this.win[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / N);
    this.floor = new Float32Array(N); this.frames = 0;
    // a ring long enough for the longest burst seen (25 ms) with margin, at any rate
    let size = 1;
    while (size < Math.floor(rate * 0.08)) size <<= 1;
    this.ring = new Int8Array(2 * size); this.ringMask = size - 1;
    this.written = 0; this.nextFrame = N; this.active = []; this.tails = []; this.sunSeen.clear(); this.fastHeads.clear();
  }

  clear(): void {
    this.established = []; this.slipCache.clear(); this.syncFrames = 0; this.heads.clear(); this.slips = 0; this.netMap.clear(); this.devMap.clear(); this.linkSet.clear(); this.lastLog.clear(); this.kinds.clear();
    this.count = 0; this.nets = []; this.devices = []; this.links = []; this.bursts = 0; this.dcwReports = 0;
    this.post();
  }

  onIq(iq: Int8Array, rate: number): void {
    if (this.ring.length === 0 || rate !== this.rate) this.reset(rate);
    const t0 = performance.now();
    const n = iq.length >> 1, ring = this.ring, mask = this.ringMask;
    for (let k = 0; k < n; k++) {
      const p = (this.written & mask) * 2;
      ring[p] = iq[2 * k]; ring[p + 1] = iq[2 * k + 1];
      this.written++;
      if (this.written === this.nextFrame) { this.detect(); this.nextFrame += this.HOP; }
    }
    const used = (performance.now() - t0) / 1000, air = n / rate;
    if (air > 0) this.busy += 0.1 * (used / air - this.busy);
  }

  private detect(): void {
    const n = this.N, re = this.re, im = this.im, win = this.win, ring = this.ring, mask = this.ringMask;
    const s0 = this.written - n;
    for (let k = 0; k < n; k++) { const p = ((s0 + k) & mask) * 2; re[k] = ring[p] * win[k]; im[k] = ring[p + 1] * win[k]; }
    fft(re, im);
    this.frames++;
    const frames = this.frames, floor = this.floor, binHz = this.binHz;
    const hot: [number, number][] = [];   // (shifted bin, power over floor)
    // most of the span over its floor is the floor being wrong (a quiet start, a retune), not bursts: it all catches up
    let over = 0;
    for (let k = 0; k < n; k++) { re[k] = re[k] * re[k] + im[k] * im[k]; if (re[k] > floor[(k + n / 2) % n] * 25) over++; }
    const wrong = over > n / 2;
    for (let k = 0; k < n; k++) {
      const b = (k + n / 2) % n;                 // 0 = lowest frequency
      const p = re[k];
      let f = floor[b];
      if (frames <= 8) f = frames === 1 ? p : f + 0.3 * (p - f);
      else if (p < f * 4 || wrong) f += 0.02 * (p - f);
      // a bin well over its floor creeps it up slowly: an 802.15.4g wake-up preamble (~150 ms of steady lines) stays a
      // burst to its end (at 0.0005 a look it faded after 40 ms); a carrier is still dropped at half a second
      else if (p > f * 25) f += 0.00005 * (p - f);
      else f += 0.0005 * (p - f);
      floor[b] = f;
      if (frames > 8 && Math.abs(b - n / 2) * binHz > 20_000 && p > f * 25) hot.push([b, p / Math.max(f, 1e-3)]);
    }
    hot.sort((a, b) => a[0] - b[0]);
    // clusters of hot bins (a 2-FSK burst lights both tones, ±20 kHz is ±2.5 bins at 8 kHz)
    const clusters: [number, number, number][] = [];   // (center bin, peak ratio, weight)
    let i = 0;
    while (i < hot.length) {
      let j = i, w = 0, ws = 0, pk = 0;
      while (j < hot.length && (j === i || (hot[j][0] - hot[j - 1][0]) * binHz <= 26_000)) {
        const r = hot[j][1]; w += r; ws += r * hot[j][0]; pk = Math.max(pk, hot[j][1]); j++;
      }
      clusters.push([ws / w, pk, w]); i = j;
    }
    for (const c of clusters) {
      const a = this.active.find(x => Math.abs(x.bin - c[0]) * binHz <= 57_000);
      if (a) { a.last = this.written; a.wSum += c[0] * c[2]; a.w += c[2]; a.peak = Math.max(a.peak, c[1]); a.bin = a.wSum / a.w; }
      else this.active.push({ start: s0, last: this.written, wSum: c[0] * c[2], w: c[2], peak: c[1], bin: c[0] });
    }
    // a burst that has gone quiet for 3 frames is done
    const quiet = Math.max(3 * this.HOP, Math.floor(this.rate / 650));
    const done: typeof this.active = [];
    this.active = this.active.filter(b => {
      if (this.written - b.last > quiet) { done.push(b); return false; }
      // a carrier, not a burst (an 802.15.4g wake-up preamble runs ~150 ms, so up to half a second is a burst)
      if (this.written - b.start > this.rate * 0.5) return false;
      return true;
    });
    // a strong burst splashes into neighbors: keep the strongest of those that ended together
    done.sort((a, b) => b.peak - a.peak);
    const kept: typeof done = [];
    for (const b of done) if (!kept.some(k => Math.abs(k.bin - b.bin) * this.rate / n < 200_000 && Math.abs(k.last - b.last) < Math.floor(this.rate / 500))) kept.push(b);
    for (const b of kept) {
      // over budget: keep up with the radio first, decode what the time allows (strong bursts first)
      if (this.shedding && (this.busy > 0.8 || (this.busy > 0.5 && b.peak < 60))) { this.shed++; continue; }
      // an 802.15.4g frame after a long wake-up preamble is spread too wide to light the detector, so the burst seems
      // to end with its preamble: if it held no frame, it is looked at again 12 ms on (the frame is 6-20 ms long)
      if (!this.demod(b) && b.last - b.start > this.rate * 0.02) this.tails.push({ start: b.start, last: b.last, peak: b.peak, bin: b.bin, due: b.last + Math.floor(this.rate * 0.012) });
    }
    while (this.tails.length && this.tails[0].due <= this.written) {
      const t = this.tails.shift()!;
      this.demod({ start: t.start, last: t.due, peak: t.peak, bin: t.bin }, true);
    }
  }

  // ---- demodulation ----
  /** True when an 802.15.4g frame was found. `tail`: only that is looked for, in the last 40 ms. */
  private demod(b: { start: number; last: number; peak: number; bin: number }, tail = false): boolean {
    const rate = this.rate, dur = (b.last - b.start) / rate;
    if (dur < 0.002) return false;
    if (!tail) this.count++;
    const n = this.N;
    const offHz = (b.bin - n / 2) * rate / n;
    const edge = Math.max(this.HOP, Math.floor(rate / 2000));
    // a long burst is a wake-up preamble with its frame at the end: only the last 40 ms are demodulated
    const long = tail || dur > 0.06;
    const from = Math.max(b.start - edge, this.written - this.ringMask + 1, long ? b.last + edge - Math.floor(rate * 0.04) : -Infinity);
    const to = Math.min(this.written, b.last + edge);
    const len = to - from;
    if (len < 256) return false;
    // mix the burst to DC
    const mixed = new Float32Array(2 * len), ring = this.ring, mask = this.ringMask;
    const w = -2 * Math.PI * offHz / rate, sr = Math.cos(w), si = Math.sin(w);
    let cr = 1, ci = 0;
    for (let k = 0; k < len; k++) {
      const p = ((from + k) & mask) * 2, iv = ring[p], qv = ring[p + 1];
      mixed[2 * k] = iv * cr - qv * ci; mixed[2 * k + 1] = iv * ci + qv * cr;
      const t = cr * sr - ci * si; ci = cr * si + ci * sr; cr = t;
      if ((k & 1023) === 0) { const g = 1 / Math.sqrt(cr * cr + ci * ci); cr *= g; ci *= g; }
    }
    // down to about 262 kHz through a CIC and a short FIR (cheap at 20 Msps), then a ±45 kHz channel filter
    const chan = new ChannelDecimator(Math.max(1, Math.floor(rate / 262_144)));
    const { out: z0, n: m0 } = chan.process(mixed, len);
    const fs = rate / chan.total;
    if (this.sun(mixed, len, rate, offHz, Math.round(10 * Math.log10(b.peak)), dur)) return true;
    if (long) return false;
    if (dur <= 0.009 && this.fast(mixed, len, rate, offHz, Math.round(10 * Math.log10(b.peak)), dur)) return true;
    const lp = new ComplexFirDecimator(lowpassTaps(45_000 / fs, 33), 1);
    const z = new Float32Array(2 * (m0 + 2));
    const m = lp.process(z0, m0, z);
    // where the burst actually is (the detector's edges are half a millisecond coarse)
    const pw = new Float32Array(m);
    for (let k = 0; k < m; k++) pw[k] = z[2 * k] * z[2 * k] + z[2 * k + 1] * z[2 * k + 1];
    if (m === 0) return false;
    const top = Float32Array.from(pw).sort()[Math.min(m - 1, Math.floor(m * 0.995))];
    let a = -1, e = -1;
    for (let k = 0; k < m; k++) if (pw[k] > 0.2 * top) { if (a < 0) a = k; e = k; }
    if (a < 0 || e - a <= 64) return false;
    const fm = new Float32Array(e - a);
    for (let k = a + 1; k <= e; k++) {
      const i0 = z[2 * (k - 1)], q0 = z[2 * (k - 1) + 1], i1 = z[2 * k], q1 = z[2 * k + 1];
      fm[k - a - 1] = Math.atan2(q1 * i0 - i1 * q0, i1 * i0 + q1 * q0);
    }
    const srt = Float32Array.from(fm).sort();
    const mid = (srt[Math.floor(srt.length * 0.95)] + srt[Math.floor(srt.length * 0.05)]) / 2;
    for (let k = 0; k < fm.length; k++) fm[k] -= mid;
    const hz = this.centerHz + Math.trunc(offHz + mid * fs / (2 * Math.PI));
    const snr = Math.round(10 * Math.log10(b.peak));
    for (const baud of MeshDecoder.BAUDS) {
      const bits = MeshDecoder.slice(fm, fs / baud);
      this.extraFrames = [];
      const f = this.parse(bits, baud, hz, snr, dur);
      if (f) { this.publish(f); for (const x of this.extraFrames) this.publish(x); this.extraFrames = []; return false; }
    }
    // not FSK: try it as on-off keying at 32768 chips a second (Neptune R900 water meters)
    this.ook(z, a, e, fs, this.centerHz + Math.trunc(offHz), snr);
    return false;
  }

  /** An 802.15.4g SUN-FSK frame in this burst, if there is one. The long preamble lights a comb of lines 25 kHz apart
   *  that pulls the detector's center by up to 100 kHz, so the carrier is found here: down to about 524 kHz, the
   *  discriminator's midpoint over the burst, the burst moved onto it, a ±70 kHz channel, bits at 50 kb/s and
   *  sunParse. True when a frame was published. */
  private sun(mixed: Float32Array, len: number, rate: number, offHz: number, snr: number, dur: number): boolean {
    const chan = new ChannelDecimator(Math.max(1, Math.floor(rate / 524_288)));
    const { out: y, n } = chan.process(mixed, len);
    const fs = rate / chan.total, sps = fs / MeshDecoder.SUN_BAUD;
    if (n < 64 || sps < 3) return false;
    const fmOf = (z: Float32Array, m: number): Float32Array | null => {
      const pw = new Float32Array(m);
      for (let k = 0; k < m; k++) pw[k] = z[2 * k] * z[2 * k] + z[2 * k + 1] * z[2 * k + 1];
      const top = Float32Array.from(pw).sort()[Math.min(m - 1, Math.floor(m * 0.995))];
      let a = -1, e = -1;
      for (let k = 0; k < m; k++) if (pw[k] > 0.2 * top) { if (a < 0) a = k; e = k; }
      if (a < 0 || (e - a) / sps < 64) return null;
      const fm = new Float32Array(e - a);
      for (let k = a + 1; k <= e; k++) {
        const i0 = z[2 * (k - 1)], q0 = z[2 * (k - 1) + 1], i1 = z[2 * k], q1 = z[2 * k + 1];
        fm[k - a - 1] = Math.atan2(q1 * i0 - i1 * q0, i1 * i0 + q1 * q0);
      }
      return fm;
    };
    const mid = (fm: Float32Array) => { const t = Float32Array.from(fm).sort(); return (t[Math.floor(t.length * 0.95)] + t[Math.floor(t.length * 0.05)]) / 2; };
    // the carrier: a ±150 kHz look first
    const w1 = new Float32Array(2 * (n + 2));
    const m1 = new ComplexFirDecimator(lowpassTaps(150_000 / fs, 31), 1).process(y, n, w1);
    const f1 = fmOf(w1, m1);
    if (!f1) return false;
    const errHz = mid(f1) * fs / (2 * Math.PI);
    // the burst moved onto it, a ±70 kHz channel
    const w = -2 * Math.PI * errHz / fs, sr = Math.cos(w), si = Math.sin(w);
    let cr = 1, ci = 0;
    for (let k = 0; k < n; k++) {
      const iv = y[2 * k], qv = y[2 * k + 1];
      y[2 * k] = iv * cr - qv * ci; y[2 * k + 1] = iv * ci + qv * cr;
      const t = cr * sr - ci * si; ci = cr * si + ci * sr; cr = t;
      if ((k & 1023) === 0) { const g = 1 / Math.sqrt(cr * cr + ci * ci); cr *= g; ci *= g; }
    }
    const z = new Float32Array(2 * (n + 2));
    const m = new ComplexFirDecimator(lowpassTaps(70_000 / fs, 41), 1).process(y, n, z);
    const fm = fmOf(z, m);
    if (!fm) return false;
    const c = mid(fm);
    for (let k = 0; k < fm.length; k++) fm[k] -= c;
    const r = MeshDecoder.sunParse(MeshDecoder.slice(fm, sps));
    if (!r) return false;
    // one frame is often looked at twice (a burst split by the comb, a second look at its tail): once is enough
    const key = r.bytes.join(','), seen = this.sunSeen.get(key);
    for (const [k, at] of this.sunSeen) if (this.written - at > rate * 0.5) this.sunSeen.delete(k);
    this.sunSeen.set(key, this.written);
    if (seen !== undefined && this.written - seen < rate * 0.5) return true;
    const hz = this.centerHz + Math.trunc(offHz + errHz + c * fs / (2 * Math.PI));
    this.publish({ ms: this.now(), hz, snrDb: snr, sync: SUN, baud: MeshDecoder.SUN_BAUD, bytes: r.bytes, durMs: dur * 1000, crcOk: true, lenOk: true, crcInit: r.init });
    return true;
  }

  /** The 106.4 kbaud network: 5 ms bursts too wide for the ±45 kHz channel the others go through. Down to about
   *  524 kHz, a ±120 kHz channel, the discriminator centered, bits at 106.4 kb/s with the clock searched ±1% (a 500-bit
   *  frame slips at 0.2%), then its 0101 preamble and sync 39717DF1 (2 bit errors at most, either polarity). The bytes
   *  after the sync are published. True when a frame was. */
  private fast(mixed: Float32Array, len: number, rate: number, offHz: number, snr: number, dur: number): boolean {
    const chan = new ChannelDecimator(Math.max(1, Math.floor(rate / 524_288)));
    const { out: y, n } = chan.process(mixed, len);
    const fs = rate / chan.total, sps0 = fs / MeshDecoder.FAST_BAUD;
    if (n < 64 || sps0 < 3) return false;
    const z = new Float32Array(2 * (n + 2));
    const m = new ComplexFirDecimator(lowpassTaps(120_000 / fs, 31), 1).process(y, n, z);
    const pw = new Float32Array(m);
    for (let k = 0; k < m; k++) pw[k] = z[2 * k] * z[2 * k] + z[2 * k + 1] * z[2 * k + 1];
    const top = Float32Array.from(pw).sort()[Math.min(m - 1, Math.floor(m * 0.995))];
    let a = -1, e = -1;
    for (let k = 0; k < m; k++) if (pw[k] > 0.2 * top) { if (a < 0) a = k; e = k; }
    if (a < 0 || (e - a) / sps0 < 100) return false;
    const fm = new Float32Array(e - a);
    for (let k = a + 1; k <= e; k++) {
      const i0 = z[2 * (k - 1)], q0 = z[2 * (k - 1) + 1], i1 = z[2 * k], q1 = z[2 * k + 1];
      fm[k - a - 1] = Math.atan2(q1 * i0 - i1 * q0, i1 * i0 + q1 * q0);
    }
    const t = Float32Array.from(fm).sort(), c = (t[Math.floor(t.length * 0.95)] + t[Math.floor(t.length * 0.05)]) / 2;
    for (let k = 0; k < fm.length; k++) fm[k] -= c;
    // the clock: the rate and phase with the widest eye
    let best = -1, bs = sps0, bp = 0;
    for (let r = -10; r <= 10; r++) {
      const sps = sps0 * (1 + r / 1000), cnt = Math.floor((fm.length - 1) / sps);
      for (let p = 0; p < 8; p++) {
        const ph = sps * p / 8;
        let v = 0;
        for (let k = 0; k < cnt; k++) v += Math.abs(fm[Math.floor(ph + k * sps)]);
        v /= cnt;
        if (v > best) { best = v; bs = sps; bp = ph; }
      }
    }
    const cnt = Math.floor((fm.length - 1 - bp) / bs);
    const bits = new Array<number>(cnt);
    for (let k = 0; k < cnt; k++) bits[k] = fm[Math.floor(bp + k * bs)] > 0 ? 1 : 0;
    const want = MeshDecoder.FAST_SYNC >>> 0;
    for (let i = 16; i + 32 + 16 <= bits.length && i < 260; i++) {
      let w = 0;
      for (let k = 0; k < 32; k++) w = ((w << 1) | bits[i + k]) >>> 0;
      for (const inv of [0, 1]) {
        const v = inv ? (~w) >>> 0 : w;
        if (pc((v ^ want) >>> 0) > 2) continue;
        // the preamble right before it alternates
        let alt = 0;
        for (let k = i - 16; k < i - 1; k++) if (bits[k] !== bits[k + 1]) alt++;
        if (alt < 13) continue;
        const out: number[] = [];
        for (let q = i + 32; q + 8 <= bits.length; q += 8) {
          let b = 0;
          for (let k = q; k < q + 8; k++) b = (b << 1) | (inv ? 1 - bits[k] : bits[k]);
          out.push(b);
        }
        if (out.length < 8) return false;
        const hz = this.centerHz + Math.trunc(offHz + c * fs / (2 * Math.PI));
        this.publish({ ms: this.now(), hz, snrDb: snr, sync: FAST, baud: MeshDecoder.FAST_BAUD, bytes: out, durMs: dur * 1000, crcOk: false, lenOk: false });
        return true;
      }
    }
    return false;
  }

  /** PN9 (x^9 + x^5 + 1, all ones to start): the standard's data whitening, one bit per PSDU bit. */
  private static pn9Bits: Uint8Array = (() => {
    const out = new Uint8Array(2048 * 8); let st = 0x1FF;
    for (let k = 0; k < out.length; k++) { out[k] = st & 1; const b = (st ^ (st >> 5)) & 1; st = (st >> 1) | (b << 8); }
    return out;
  })();

  /** CRC-16 x^16+x^12+x^5+1 over bits in air order, register MSB first (the 911.6 MHz network's frame check). */
  static sunCrc16(bits: ArrayLike<number>, n: number, init: number): number {
    let c = init;
    for (let k = 0; k < n; k++) { const t = ((c >> 15) & 1) ^ bits[k]; c = ((c << 1) & 0xFFFF) ^ (t ? 0x1021 : 0); }
    return c;
  }
  private static crc32Table: Uint32Array = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();

  /**
   * An 802.15.4g SUN-FSK frame in hard bits (either polarity): alternating preamble, the uncoded SFD 0x904E (one bit
   * wrong allowed), the 16-bit PHR (mode switch 0, FCS type, whitening, 11-bit length MSB first), the PSDU de-whitened
   * and its frame check passed. The 2-octet check is tried from the known network starts, then as the standard's
   * CRC-16 (reflected, start 0); the 4-octet one as the standard's CRC-32. Returns the PSDU bytes (LSB first, as sent)
   * without the check, or null.
   */
  static sunParse(raw: number[]): { bytes: number[]; init: number } | null {
    const PN = MeshDecoder.pn9Bits;
    for (const inv of [false, true]) {
      const bits = inv ? raw.map(x => 1 - x) : raw;
      let w = 0;
      for (let i = 0; i < bits.length; i++) {
        w = ((w << 1) | bits[i]) >>> 0;
        if (i < 31 || pc((w & 0xFFFF) ^ 0x904E) > 1 || pc((w >>> 16) ^ 0x5555) > 2) continue;
        const p = i + 1;
        if (p + 16 > bits.length) break;
        if (bits[p] !== 0) continue;   // a mode-switch PHR, not a frame
        let L = 0;
        for (let k = 5; k < 16; k++) L = (L << 1) | bits[p + k];
        const fcs2 = bits[p + 3] === 1, dw = bits[p + 4] === 1, fl = fcs2 ? 2 : 4;
        if (L <= fl || p + 16 + L * 8 > bits.length) continue;
        const ps = new Uint8Array(L * 8);
        for (let k = 0; k < ps.length; k++) ps[k] = bits[p + 16 + k] ^ (dw ? PN[k] : 0);
        const by: number[] = [];
        for (let q = 0; q < L; q++) { let v = 0; for (let k = 0; k < 8; k++) v |= ps[8 * q + k] << k; by.push(v); }
        const n = (L - fl) * 8;
        let init = -1;
        if (fcs2) {
          let got = 0; for (let k = 0; k < 16; k++) got = (got << 1) | ps[n + k];
          for (const s0 of MeshDecoder.SUN_INITS) if (MeshDecoder.sunCrc16(ps, n, s0) === got) { init = s0; break; }
          if (init < 0) {
            // the standard's CRC-16: reflected, start 0, sent low byte first
            let c = 0;
            for (let q = 0; q < L - 2; q++) { c ^= by[q]; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1; }
            if (c === (by[L - 2] | (by[L - 1] << 8))) init = 0;
          }
        } else {
          let c = 0xFFFFFFFF;
          for (let q = 0; q < L - 4; q++) c = MeshDecoder.crc32Table[(c ^ by[q]) & 0xFF] ^ (c >>> 8);
          c = (c ^ 0xFFFFFFFF) >>> 0;
          if (c === ((by[L - 4] | (by[L - 3] << 8) | (by[L - 2] << 16) | (by[L - 1] << 24)) >>> 0)) init = 0;
        }
        if (init >= 0) return { bytes: by.slice(0, L - fl), init };
      }
    }
    return null;
  }

  /** An on-off burst in its own channel: the envelope, chips at 32768 a second at the phase with the widest swing, the
   *  R900 preamble looked for in them (a chip or two wrong allowed), and the 168 chips after it decoded. */
  private ook(z: Float32Array, a: number, e: number, fs: number, hz: number, snr: number): void {
    const spc = fs / 32768;
    if (spc < 3) return;
    const env = new Float32Array(e - a + 1);
    for (let k = a; k <= e; k++) env[k - a] = Math.sqrt(z[2 * k] * z[2 * k] + z[2 * k + 1] * z[2 * k + 1]);
    const n = Math.floor(env.length / spc) - 1;
    if (n < 200) return;
    const sorted = Float32Array.from(env).sort(), thr = (sorted[Math.floor(sorted.length / 20)] + sorted[Math.floor(sorted.length * 19 / 20)]) / 2;
    let bestPh = 0, bestSwing = -1;
    for (let p = 0; p < 8; p++) {
      const ph = spc * p / 8;
      let sw = 0;
      for (let k = 0; k < n; k++) sw += Math.abs(chipEnergy(env, ph + k * spc, spc) - thr);
      if (sw > bestSwing) { bestSwing = sw; bestPh = p === 0 ? 0 : spc * p / 8; }
    }
    let chips = 0;
    for (let k = 0; k < n; k++) {
      const en = chipEnergy(env, bestPh + k * spc, spc) - thr;
      chips = ((chips << 1) | (en > 0 ? 1 : 0)) >>> 0;
      if (k >= 31 && k + 168 < n && pc(chips ^ MeshDecoder.R900_SYNC) <= 2) {
        const p = new Float32Array(168);
        for (let i = 0; i < 168; i++) p[i] = chipEnergy(env, bestPh + (k + 1 + i) * spc, spc);
        const r = ErtDecoder.decodeR900(p);
        if (r) {
          this.emit({ type: 'packet', line: `${(hz / 1e6).toFixed(3)} +${snr} dB ${r.line}` });
          this.ertReading('R900', r.id, 'water', r.cons, [...r.fields, ['FREQUENCY', `${(hz / 1e6).toFixed(4)} MHz`], ['SIGNAL', `+${snr} dB`]]);
          return;
        }
      }
    }
  }

  /** Hard bits at the clock phase with the widest eye (a burst is short enough for one phase to hold). */
  static slice(fm: Float32Array, sps: number): number[] {
    let best = -1, bestPh = 0;
    const count = Math.floor(fm.length / sps) - 1;
    if (count < 16) return [];
    for (let p = 0; p < 16; p++) {
      const ph = sps * p / 16;
      let s = 0;
      for (let k = 0; k < count; k++) s += Math.abs(fm[Math.floor(ph + k * sps)]);
      if (s > best) { best = s; bestPh = ph; }
    }
    const out = new Array<number>(count);
    for (let k = 0; k < count; k++) out[k] = fm[Math.floor(bestPh + k * sps)] > 0 ? 1 : 0;
    return out;
  }

  // ---- framing ----
  static gridstreamStart(bits: number[]): number | null {
    // 0x00 then 0xFF, each as start 0 + 8 bits + stop 1 (v5 breaks the second start bit to a 1)
    const v4 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const v5 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    if (bits.length < 40) return null;
    for (let p = 8; p < bits.length - 20; p++) {
      // right after the 0xAA preamble, which ends on a 0
      if (bits[p - 1] !== 0 || bits[p - 2] !== 1 || bits[p - 3] !== 0 || bits[p - 4] !== 1) continue;
      let m4 = true, m5 = true;
      for (let k = 0; k < 20 && (m4 || m5); k++) { if (bits[p + k] !== v4[k]) m4 = false; if (bits[p + k] !== v5[k]) m5 = false; }
      if (m4 || m5) return p;
    }
    return null;
  }

  static crcCcitt(data: number[], from: number, to: number, seed: number): number {
    let c = seed;
    for (let i = from; i < to; i++) {
      c ^= data[i] << 8;
      for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
    }
    return c;
  }

  parse(raw: number[], baud: number, hz: number, snr: number, dur: number): MeshFrame | null {
    const frame = (sync: number, bytes: number[], crcOk = false, lenOk = false): MeshFrame => ({ ms: this.now(), hz, snrDb: snr, sync, baud, bytes, durMs: dur * 1000, crcOk, lenOk });
    for (const inv of [false, true]) {
      const bits = inv ? raw.map(x => 1 - x) : raw;
      const p = MeshDecoder.gridstreamStart(bits);
      if (p === null) continue;
      let bytes: number[] = [];
      let q = p;
      // the header strictly framed; once the length field is in, that many bytes are read even through a start or
      // stop bit or two gone wrong (one flipped bit used to end the frame, and its position with it)
      let slips = 0;
      while (q + 10 <= bits.length && bytes.length < 300) {
        const framed = bits[q + 9] === 1 && (q === p + 10 || bits[q] === 0);
        if (!framed) {
          if (bytes.length < 6) break;
          const want = 6 + ((bytes[4] << 8) | bytes[5]);
          slips++;
          if (bytes.length >= want || slips > Math.max(2, Math.floor(want / 12))) break;
        } else if (bytes.length >= 6 && bytes.length >= 6 + ((bytes[4] << 8) | bytes[5])) break;
        let v = 0;
        for (let k = 0; k < 8; k++) v |= bits[q + 1 + k] << k;   // UART: LSB first
        bytes.push(v); q += 10;
      }
      if (bytes.length < 6 && MeshDecoder.trace) MeshDecoder.trace(`GS short baud ${baud} inv ${inv} ${bytes.length}B bits ${bits.slice(p, Math.min(bits.length, p + 90)).join('')}`);
      // the 24-bit start turns up by chance in a busy band: a real frame carries at least its 6-byte header
      if (bytes.length < 6) continue;
      let ok = false, lenOk = false;
      if (bytes.length >= 8) {
        const ln = (bytes[4] << 8) | bytes[5];
        if (ln >= 4 && bytes.length >= 6 + ln) {
          ok = MeshDecoder.GS_SEEDS.some(s => MeshDecoder.crcCcitt(bytes, 2, 6 + ln, s) === 0 || MeshDecoder.crcCcitt(bytes, 6, 6 + ln, s) === 0);
          bytes = bytes.slice(0, 6 + ln); lenOk = true;
        }
      }
      return frame(GRIDSTREAM, bytes, ok, lenOk);
    }
    // any other network: an alternating preamble of 16+ bits, then its sync word
    // the first alternating run of 16+ bits (noise ahead of the burst makes short ones)
    let k = 0, j = -1;
    while (k + 1 < raw.length && k < 160) {
      let e = k;
      while (e + 1 < raw.length && raw[e] !== raw[e + 1]) e++;
      if (e - k >= 16) { j = e; break; }
      k = e + 1;
    }
    if (j < 0 || j + 1 + 24 + 8 > raw.length) return null;
    // polarity: the preamble ends on a 1
    let bits = raw[j] === 1 ? raw : raw.map(x => 1 - x);
    let start = j + 1;
    const word = (bb: number[], st: number) => { let v = 0; for (let i = st; i < st + 24; i++) v = (v << 1) | bb[i]; return v; };
    // an established network's sync word a few bits either side (the preamble's end is read a bit or two off when
    // noise or the ramp-up blurs it) wins over the bits that happen to sit there
    found: for (const net of this.established) {
      for (const inv of [false, true]) {
        const bb = inv ? bits.map(x => 1 - x) : bits;
        for (let st = Math.max(0, j - 8); st <= Math.min(bb.length - 32, j + 48); st++) {
          if (pc(word(bb, st) ^ net) <= 1) { bits = bb; start = st; break found; }
        }
      }
    }
    const sync = word(bits, start);
    // a burst can hold several frames back to back (a poll and the reply in the same slot): every later copy of the
    // sync word starts a frame of its own, and the alternating preamble before it is not part of the last one
    const starts = [start];
    let s2 = start + 48;
    while (s2 + 24 <= bits.length) {
      if (pc(word(bits, s2) ^ sync) <= 1) { starts.push(s2); s2 += 48; } else s2++;
    }
    const bytesOf = (from: number, to: number): number[] => {
      // the next frame's preamble is at least 16 bits: stop short of it, then drop whole 55 / AA bytes left over
      const end = to < bits.length ? Math.max(from, to - 16) : to;
      const out: number[] = [];
      for (let q = from; q + 8 <= end; q += 8) { let v = 0; for (let i = q; i < q + 8; i++) v = (v << 1) | bits[i]; out.push(v); }
      if (to < bits.length) while (out.length && (out[out.length - 1] === 0x55 || out[out.length - 1] === 0xAA)) out.pop();
      return out;
    };
    // 9C··15 is one network: the byte in the middle of its sync word follows the channel it is sent on
    const hop9c = ((sync & 0xFF00FF) >>> 0) === HOP9C;
    const named = (x: MeshFrame): MeshFrame => hop9c ? { ...x, sync: HOP9C, tag: (sync >> 8) & 0xFF } : x;
    for (let s = 1; s < starts.length; s++) {
      const by = bytesOf(starts[s] + 24, s + 1 < starts.length ? starts[s + 1] : bits.length);
      if (by.length) this.extraFrames.push(named(frame(sync, by)));
    }
    return named(frame(sync, bytesOf(start + 24, starts.length > 1 ? starts[1] : bits.length)));
  }

  // ---- results ----
  static syncName(s: number): string { return s === GRIDSTREAM ? 'Gridstream' : s === SUN ? '802.15.4g' : s === FAST ? '106 kbaud' : s === HOP9C ? '9C··15' : s.toString(16).toUpperCase().padStart(6, '0'); }

  /** The 911.6 MHz network's frame (the one whose check starts at 0x1877): a header, the 7-byte device ID at 4-10,
   *  ... a counter at 19 and the 6-byte network ID at 20-25. Other 802.15.4g networks have their own layouts and are
   *  counted, not carded. */
  static sunLayout(f: MeshFrame): boolean { return f.crcInit === 0x1877 && f.bytes.length >= 26; }

  /** One card per 7-byte device ID (the ID repeats on every hop); its frame counter, kind and network ID. */
  private trackSun(f: MeshFrame): void {
    const b = f.bytes;
    if (!MeshDecoder.sunLayout(f)) return;
    const idHex = hex(b.slice(4, 11));
    let h = 0x811C9DC5; for (let k = 4; k < 11; k++) h = Math.imul(h ^ b[k], 0x01000193) >>> 0;
    const key = `${SUN}/${h}`;
    const d = this.devMap.get(key) ?? newDevice(SUN, h, f.ms);
    d.label = idHex;
    d.frames++; d.lastMs = f.ms;
    d.hops.push({ hz: f.hz, ms: f.ms }); if (d.hops.length > 48) d.hops.splice(0, d.hops.length - 48);
    d.snr.push(f.snrDb); if (d.snr.length > 60) d.snr.splice(0, d.snr.length - 60);
    if (!d.lengths.includes(b.length + 2)) d.lengths.push(b.length + 2);
    d.lastHex = hxs(b.slice(0, 16));
    // the counter at byte 19: shown as the card's clock (clockRate 0, so it holds between frames)
    d.clock = b[19]; d.clockMs = f.ms; d.clockRate = 0;
    const chs = new Set(d.hops.map(x => Math.round(x.hz / 200_000))).size;
    d.fields = [
      { name: 'PROTOCOL', value: `IEEE 802.15.4g SUN-FSK · 50 kb/s · CRC start ${(f.crcInit ?? 0).toString(16).toUpperCase().padStart(4, '0')}` },
      { name: 'DEVICE ID', value: hxs(b.slice(4, 11)) },
      { name: 'NETWORK ID', value: hxs(b.slice(20, 26)) },
      { name: 'KIND', value: `${h2(b[3])} · ${h2(b[14])}` },
      { name: 'COUNTER', value: `${h2(b[19])} (${b[19]})` },
      { name: 'PAYLOAD', value: hxs(b.slice(26)) },
      { name: 'LAST FRAME', value: hxs(b) },
      { name: 'FREQUENCY', value: `${(f.hz / 1e6).toFixed(4)} MHz` },
      { name: 'CHANNELS', value: `${chs} heard` },
      { name: 'SIGNAL', value: `+${f.snrDb} dB` },
      { name: 'LENGTHS', value: `${[...d.lengths].sort((x, y) => x - y).join(', ')} bytes` },
    ];
    this.devMap.set(key, d);
  }
  /** The 106.4 kbaud network: one card for the network (its frames carry no device ID we can read yet), with the
   *  4-byte headers after the sync counted (60 76 00 06 and 60 76 1D 86 are most of them). */
  private trackFast(f: MeshFrame): void {
    const b = f.bytes;
    if (b.length < 8) return;
    const key = `${FAST}/0`;
    const d = this.devMap.get(key) ?? newDevice(FAST, 0, f.ms);
    d.label = '106 kbaud';
    const hd = hxs(b.slice(0, 4)), heads = this.fastHeads;
    heads.set(hd, (heads.get(hd) ?? 0) + 1);
    d.frames++; d.lastMs = f.ms;
    d.hops.push({ hz: f.hz, ms: f.ms }); if (d.hops.length > 48) d.hops.splice(0, d.hops.length - 48);
    d.snr.push(f.snrDb); if (d.snr.length > 60) d.snr.splice(0, d.snr.length - 60);
    if (!d.lengths.includes(b.length)) d.lengths.push(b.length);
    d.lastHex = hxs(b.slice(0, 16));
    const chs = new Set(d.hops.map(x => Math.round(x.hz / 200_000))).size;
    d.fields = [
      { name: 'NETWORK', value: '106.4 kbaud 2-FSK · ±44 kHz · sync 39717DF1 · not identified' },
      { name: 'HEADERS', value: [...heads.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} ×${v}`).join(' · ') },
      { name: 'FIELDS', value: `${hxs(b.slice(4, 6))} · ${hxs(b.slice(6, 8))} (change every second or so)` },
      { name: 'LAST FRAME', value: hxs(b.slice(0, 24)) + (b.length > 24 ? ' …' : '') },
      { name: 'FREQUENCY', value: `${(f.hz / 1e6).toFixed(4)} MHz` },
      { name: 'CHANNELS', value: `${chs} heard` },
      { name: 'SIGNAL', value: `+${f.snrDb} dB` },
      { name: 'CHECK', value: 'none found yet (no CRC-8 or CRC-16 fits)' },
    ];
    this.devMap.set(key, d);
  }

  /**
   * The dominant network sync is a slipped read of, if any. Only a network carrying at least 1% of all frames is a
   * candidate: the ghosts come from the busy one, and each extra candidate is another chance to swallow a real small
   * network (checked against all networks with 5+ frames, 10 of 60 injected random networks vanished; against the
   * dominant ones only, none). sync is that network's slip when, for one of its 16 commonest two-byte heads, it is
   * within 2 bit errors of a 24-bit window of its preamble's tail, sync and head (shifted -8 to +16), or exactly a
   * one-bit slip of sync and head, or within edit distance 2 of that whole stretch. Replayed over 1.59 M real frames:
   * 97 listed networks without this, 49 with it.
   */
  private slipOf(sync: number): number | null {
    const p = Array.from({ length: 24 }, (_, i) => (sync >> (23 - i)) & 1);
    for (const net of this.netMap.values()) {
      const e = net.sync;
      if (e < 0 || e === sync || net.frames < 5 || net.frames < 0.01 * this.syncFrames) continue;
      const hs = [...(this.heads.get(e) ?? new Map<number, number>()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map((x) => x[0]);
      for (const x of this.slipWords(e, net.frames, hs)) if (pc(x ^ sync) <= 2) return e;
      for (const h of hs) {
        const ctx: number[] = [];
        for (let i = 15; i >= 0; i--) ctx.push((0x5555 >> i) & 1);
        for (let i = 23; i >= 0; i--) ctx.push((e >> i) & 1);
        for (let i = 15; i >= 0; i--) ctx.push((h >> i) & 1);
        if (MeshDecoder.editIn(p, ctx) <= 2) return e;
      }
    }
    return null;
  }

  /** Frames of every network but Gridstream, for the 1% share slipOf asks of a candidate. */
  private syncFrames = 0;
  /** Per network: the slip words of its preamble, sync and heads, and the frame count they were worked out at. */
  private slipCache = new Map<number, [number, number[]]>();

  private slipWords(e: number, frames: number, hs: number[]): number[] {
    const c = this.slipCache.get(e);
    if (c && frames < 2 * c[0]) return c[1];
    const word = (b: number[]): number => { let v = 0; for (let i = 0; i < 24; i++) v = ((v << 1) | b[i]) >>> 0; return v; };
    const out = new Set<number>();
    for (const h of hs) {
      const s: number[] = [];
      for (let i = 15; i >= 0; i--) s.push((0x5555 >> i) & 1);
      for (let i = 23; i >= 0; i--) s.push((e >> i) & 1);
      for (let i = 15; i >= 0; i--) s.push((h >> i) & 1);
      for (let sh = -8; sh <= 16; sh++) out.add(word(s.slice(16 + sh)));
      const sb = s.slice(16);
      for (let k = 0; k < 24; k++) {
        // a bit lost at k, or one gained there (either value)
        out.add(word([...sb.slice(0, k), ...sb.slice(k + 1)]));
        for (const x of [0, 1]) out.add(word([...sb.slice(0, k), x, ...sb.slice(k)]));
      }
    }
    const w = [...out];
    this.slipCache.set(e, [Math.max(1, frames), w]);
    return w;
  }

  /** The least edit distance between p and any stretch of t (Sellers' approximate substring match). */
  static editIn(p: number[], t: number[]): number {
    let prev = new Array<number>(t.length + 1).fill(0);
    for (let i = 1; i <= p.length; i++) {
      const cur = new Array<number>(t.length + 1); cur[0] = i;
      for (let j = 1; j <= t.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (p[i - 1] === t[j - 1] ? 0 : 1));
      prev = cur;
    }
    return Math.min(...prev);
  }

  /** A "sync word" that is mostly alternating bits is the preamble read a few bits late, not a network. */
  static isPreamble(sync: number): boolean { return sync >= 0 && pc((sync ^ (sync >> 1)) & 0x7F_FFFF) >= 18; }

  /** Every decoded frame comes through here (public so tests can feed frames directly). */
  publish(frame: MeshFrame): void {
    if (MeshDecoder.isPreamble(frame.sync)) return;
    const f = { ...frame };
    // a sync word a bit or two off an established network's is that network with bit errors
    if (f.sync >= 0 && (this.netMap.get(f.sync)?.frames ?? 0) < MeshDecoder.MIN_FRAMES) {
      let near: MeshNet | null = null;
      for (const v of this.netMap.values()) if (v.sync >= 0 && v.frames >= 5 && pc(v.sync ^ f.sync) <= 2 && (!near || v.frames > near.frames)) near = v;
      if (near) f.sync = near.sync;
      // not a few flipped bits but a slipped one: the sync search locked a bit or two early or late (or on the
      // preamble's tail), so the word read is a window of an established network's own bit stream, and the bytes
      // after it are misaligned too. One busy network turned into thousands of "networks" this way.
      else if (this.slipOf(f.sync) !== null) { this.slips++; return; }
    }
    this.onFrame?.(f);
    if (f.sync >= 0) this.syncFrames++;
    const net = this.netMap.get(f.sync) ?? { sync: f.sync, frames: 0, types: {}, channels: [], loHz: Number.MAX_SAFE_INTEGER, hiHz: 0, lastHex: '', lastMs: 0, bestSnr: 0, meters: [] };
    net.frames++;
    if (f.bytes.length) net.types[f.bytes[0]] = (net.types[f.bytes[0]] ?? 0) + 1;
    const ch = Math.round(f.hz / 25_000); if (!net.channels.includes(ch)) net.channels.push(ch);
    net.loHz = Math.min(net.loHz, f.hz); net.hiHz = Math.max(net.hiHz, f.hz);
    net.lastHex = hxs(f.bytes.slice(0, 24));
    net.lastMs = f.ms; net.bestSnr = Math.max(net.bestSnr, f.snrDb);
    if (f.sync === GRIDSTREAM && f.crcOk && f.bytes.length >= 30 && f.bytes[2] === 0x2A && f.bytes[3] === 0x55) {
      const id = u32(f.bytes, 26); if (!net.meters.includes(id)) net.meters.push(id);
    }
    this.netMap.set(f.sync, net);
    if (f.sync >= 0 && f.bytes.length >= 2) {
      const h = this.heads.get(f.sync) ?? new Map<number, number>(); const k = (f.bytes[0] << 8) | f.bytes[1];
      h.set(k, (h.get(k) ?? 0) + 1); this.heads.set(f.sync, h);
    }
    if (net.frames === 20 && f.sync >= 0 && !this.established.includes(f.sync)) this.established.push(f.sync);
    if (net.frames >= MeshDecoder.MIN_FRAMES || f.sync < 0) this.track(f);
    // the debug log gets each new kind of frame (network, first byte, length), and every long one: readings arrive
    // rarely and in longer frames than the hop beacons
    const kind = `${MeshDecoder.syncName(f.sync)} ${h2(f.bytes[0] ?? 0)} ${f.bytes.length}B`;
    if (net.frames >= MeshDecoder.MIN_FRAMES && (f.bytes.length >= 10 || !this.kinds.has(kind))) { this.kinds.add(kind); this.emit({ type: 'log', line: `MESH ${MeshDecoder.line(f)}` }); }
    // the log: every Gridstream frame, else at most one line a second per network and frame type
    const key = f.sync * 257 + (f.bytes[0] ?? 0);
    if (f.sync < 0 || (net.frames >= MeshDecoder.MIN_FRAMES && f.ms - (this.lastLog.get(key) ?? 0) >= 1000)) {
      this.lastLog.set(key, f.ms);
      this.emit({ type: 'packet', line: MeshDecoder.line(f) });
    }
    if (f.ms - this.lastPublish >= 250) { this.lastPublish = f.ms; this.flush(); }
  }

  /** Gridstream LPP opcodes, as the wiki names them (2X tickle / keep-alive, 3X sync, 51 / 55 link info). */
  static opcode(o: number): string {
    if (o === 0x51) return 'link info';
    if (o === 0x55) return 'link info request';
    if (o === 0x22 || o === 0x52) return 'route record';
    if (o >= 0x20 && o <= 0x2F) return 'keep-alive';
    if (o >= 0x30 && o <= 0x3F) return 'sync';
    return 'opcode';
  }
  /** The node status word: a483 on every meter seen so far (network-wide), so anything else is worth a look. */
  static statusWord(a: number, b: number): string {
    const v = (a << 8) | b;
    return v.toString(16).toUpperCase().padStart(4, '0') + (v === 0xA483 ? ' (network normal)' : (v & 0xFF00) === 0xA400 ? ` (network A4 · node flags ${h2(b)})` : '');
  }
  /** The device / firmware descriptor, the XX 32 0Y group the wiki sees on every meter. */
  static descriptor(x: number, y: number, z: number): string { return `${h2(x)} ${h2(y)} ${h2(z)} (class ${h2(x)} · model ${h2(y)} · rev ${z})`; }

  private gsKey(id: number): string { return `${GRIDSTREAM}/${id >>> 0}`; }

  /**
   * Gridstream, laid out as on the RECESSIM wiki. A 2A 55 beacon carries the meter's LAN id (on its sticker), its
   * uptime, its WAN address (a position), status, descriptor and hop clock. A 2A D5 frame is routed: destination and
   * source LAN ids, and for registration (opcode 51 / 55) the network time, uptime and the source's WAN address.
   */
  private trackGridstream(f: MeshFrame): void {
    const b = f.bytes;
    // a power usage report (types 00-03, subtype 81 / 85): no sender in the clear, so it is counted for the network
    if (b.length >= 6 && b[2] <= 3 && (b[3] === 0x81 || b[3] === 0x85)) { this.dcwReports++; return; }
    if (!(f.crcOk || f.lenOk) || b.length < 15 || b[2] !== 0x2A) return;
    // an id a bit or two off a meter already heard twice is that meter with bit errors
    const canon = (id: number): number => {
      id = id >>> 0;
      if (this.devMap.has(this.gsKey(id))) return id;
      let near: MeshDevice | null = null;
      for (const v of this.devMap.values()) if (v.net === GRIDSTREAM && v.frames >= 2 && pc(v.id ^ id) <= 2 && (!near || v.frames > near.frames)) near = v;
      return near ? near.id : id;
    };
    const dev = (id: number): MeshDevice => { const c = canon(id); return this.devMap.get(this.gsKey(c)) ?? newDevice(GRIDSTREAM, c, f.ms); };
    const put = (d: MeshDevice) => { this.devMap.set(this.gsKey(d.id), d); };
    const heard = (d: MeshDevice) => {
      d.frames++; d.lastMs = f.ms;
      d.hops.push({ hz: f.hz, ms: f.ms }); if (d.hops.length > 48) d.hops.splice(0, d.hops.length - 48);
      d.snr.push(f.snrDb); if (d.snr.length > 60) d.snr.splice(0, d.snr.length - 60);
      if (!d.lengths.includes(b.length)) d.lengths.push(b.length);
      d.lastHex = hxs(b.slice(0, 16));
    };
    // the fields from each kind of frame are kept side by side: a beacon's position stays when a routed frame comes
    const setFields = (d: MeshDevice, kind: string, fl: MeshField[]) => {
      d.fieldsBy[kind] = fl;
      if (!d.fieldOrder.includes(kind)) d.fieldOrder.push(kind);
      d.fields = d.fieldOrder.flatMap(k => [{ name: '──', value: k }, ...(d.fieldsBy[k] ?? [])]);
    };
    const position = (d: MeshDevice, wan: number) => {
      d.wanVotes[wan] = (d.wanVotes[wan] ?? 0) + 1;
      // a position is shown only once two beacons agree on it: where the utility's CRC seed is unknown a frame passes
      // on its length alone, and one with a flipped bit in its WAN address decodes to a point kilometers away
      const votes = Object.entries(d.wanVotes);
      let best: [string, number] | null = null;
      for (const v of votes) if (!best || v[1] > best[1]) best = v;
      const p = best && best[1] >= 2 ? GridstreamWan.decode(Number(best[0])) : null;
      if (p) { d.lat = p.lat; d.lon = p.lon; d.posColor = p.color; } else { d.lat = null; d.lon = null; }
    };
    const posText = (d: MeshDevice) => d.lat !== null && d.lon !== null ? `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)} (node color ${d.posColor})`
      : Object.keys(d.wanVotes).length ? 'waiting for a second beacon with the same WAN address' : '-';
    // uptime is seconds since power-on; a bit error can make it decades, so such a value is shown but not kept
    const upOk = (up: number) => up <= UPTIME_MAX;
    const upText = (up: number, minutes: boolean) => !upOk(up) ? `${up} s (implausible, likely a bit error: ignored)`
      : `${up} s (${Math.floor(up / 86400)}d ${pad2(Math.floor(up / 3600) % 24)}h${minutes ? ` ${pad2(Math.floor(up / 60) % 60)}m` : ''})`;
    const poweredUp = (up: number) => upOk(up) ? `${new Date(f.ms - up * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC (the last power-up: an outage or a restart)` : '-';
    if (b[3] === 0x55 && b.length >= 37 && b[6] === 0x30) {
      const d = dev(u32(b, 26));
      heard(d);
      const up = u32(b, 20);
      if (upOk(up)) { d.uptimeS = up; d.uptimeMs = f.ms; }
      d.clock = (b[35] << 8) | b[36]; d.clockMs = f.ms; d.clockRate = 100;   // hundredths into the 168 s cycle
      position(d, GridstreamWan.value(b, 13));
      setFields(d, 'BEACON', [
        { name: 'FRAME', value: `beacon 2A 55, sync opcode 30, ${b.length} bytes` },
        { name: 'METER ID', value: `${h8(d.id)} (${d.id})` },
        { name: 'POSITION', value: posText(d) },
        { name: 'NODE COLOR', value: String(d.posColor) },
        { name: 'WAN ADDRESS', value: hex(b.slice(13, 19)) },
        { name: 'DESTINATION', value: hex(b.slice(7, 13)) },
        { name: 'UPTIME', value: upText(up, true) },
        { name: 'POWERED UP', value: poweredUp(up) },
        { name: 'COUNTER', value: `${h2(b[19])} (${b[19]}, steps by 2)` },
        { name: 'STATUS', value: MeshDecoder.statusWord(b[24], b[25]) },
        { name: 'FORMAT', value: hex(b.slice(30, 32)) + (b[30] === 0x01 ? ' (record marker)' : '') },
        { name: 'DEVICE', value: MeshDecoder.descriptor(b[32], b[33], b[34]) },
        { name: 'HOP CLOCK', value: `${(d.clock / 100).toFixed(2)} s into the 168 s cycle · channel slot ${Math.floor(d.clock / 70) % 240} of 240` },
        { name: 'TX FLAGS', value: b.length >= 39 ? `${hex(b.slice(37, 39))} (transmit status ${(b[38] & 0x0F).toString(16).toUpperCase()})` : '-' },
        { name: 'TRAILER', value: b.length > 41 ? hex(b.slice(39, b.length - 2)) : '-' },
        { name: 'CRC', value: hex(b.slice(b.length - 2)) + (f.crcOk ? ' · ok (known seed)' : ' · length ok, utility seed unknown') },
      ]);
      put(d);
    } else if (b[3] === 0xD5 && b.length >= 15) {
      const dst = canon(u32(b, 7)), src = canon(u32(b, 11));
      const d = dev(src);
      heard(d);
      if (!d.talksTo.includes(dst)) d.talksTo.push(dst);
      if (dst !== 0xFFFF_FFFF && dst !== src) { const l = { a: Math.min(src, dst), b: Math.max(src, dst) }; this.linkSet.set(`${l.a}/${l.b}`, l); }
      const n = b.length;
      const fl: MeshField[] = [
        { name: 'FRAME', value: `routed 2A D5 · ${MeshDecoder.opcode(b[6])} (opcode ${h2(b[6])}) · ${n} bytes` },
        { name: 'METER ID', value: `${h8(src)} (${src})` },
        { name: 'TO', value: dst === 0xFFFF_FFFF ? 'everyone (broadcast)' : `${h8(dst)} (${dst})` },
        { name: 'FRAME ID', value: b.length > 15 ? h2(b[15]) : '-' },
      ];
      // the tail of every routed frame: hop clock, status / flags, CRC
      if (n >= 24) {
        const hc = (b[n - 6] << 8) | b[n - 5];
        if (hc < 16_800) {
          fl.push({ name: 'HOP CLOCK', value: `${(hc / 100).toFixed(2)} s into the 168 s cycle` });
          d.clock = hc; d.clockMs = f.ms; d.clockRate = 100;
        }
        fl.push({ name: 'TX FLAGS', value: hex(b.slice(n - 4, n - 2)) });
        fl.push({ name: 'CRC', value: hex(b.slice(n - 2)) });
      }
      if ((b[6] === 0x51 || b[6] === 0x55) && b.length >= 42) {
        const epoch = u32(b, 16), up = u32(b, 24);
        if (upOk(up)) { d.uptimeS = up; d.uptimeMs = f.ms; }
        position(d, GridstreamWan.value(b, 32));
        const terr = u32(b, 20) | 0;
        const own = u32(b, 38);
        fl.push(
          { name: 'NETWORK TIME', value: `${new Date(epoch * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC` },
          { name: 'CLOCK ERROR', value: `${terr} (${hex(b.slice(20, 24))})` },
          { name: 'UPTIME', value: upText(up, false) },
          { name: 'POWERED UP', value: poweredUp(up) },
          { name: 'STATUS', value: MeshDecoder.statusWord(b[28], b[29]) },
          { name: 'SEQUENCE', value: `threshold ${b[30]} · number ${b[31]}` },
          { name: 'POSITION', value: posText(d) },
          { name: 'WAN ADDRESS', value: hex(b.slice(32, 38)) },
          { name: 'OWN ID', value: `${h8(own)}${own === src ? ' (matches sender)' : ''}` },
        );
        if (n > 48) {
          fl.push({ name: 'DEVICE', value: MeshDecoder.descriptor(b[42], b[43], b[44]) });
          fl.push({ name: 'LINK QUALITY', value: hex(b.slice(45, n - 6)) });
        }
      } else if (n > 22) {
        const p = b[16];
        fl.push({ name: 'PAYLOAD TYPE', value: `${h2(p)}${p & 0x80 ? ' · routed' : ' · direct'}` });
        fl.push({ name: 'PAYLOAD', value: hex(b.slice(17, n - 6)) });
      }
      setFields(d, `ROUTED ${MeshDecoder.opcode(b[6])}`, fl);
      put(d);
      // the addressed meter exists too, even before its own beacon
      if (dst !== 0xFFFF_FFFF && dst !== src) {
        const t = this.devMap.get(this.gsKey(dst));
        if (t) { t.addressed++; put(t); }
        else {
          const nt = dev(dst); nt.firstMs = f.ms; nt.lastMs = 0; nt.addressed = 1;
          nt.fields = [{ name: 'METER ID', value: `${h8(dst)} (${dst})` }, { name: 'HEARD', value: 'only addressed by others' }];
          put(nt);
        }
      }
    }
  }

  private track(f: MeshFrame): void {
    if (f.sync === GRIDSTREAM) { this.trackGridstream(f); return; }
    if (f.sync === SUN) { this.trackSun(f); return; }
    if (f.sync === FAST) { this.trackFast(f); return; }
    if (!f.bytes.length) return;
    let id = f.bytes[0];
    let key = `${f.sync}/${id}`;
    const c16 = f.bytes.length >= 3 ? (f.bytes[1] << 8) | f.bytes[2] : -1;
    // an id a bit off an established device whose clock this frame fits is that device with a bit error
    if ((this.devMap.get(key)?.frames ?? 0) < 3) {
      for (const v of this.devMap.values()) {
        if (v.net === f.sync && v.frames >= 5 && pc(v.id ^ id) === 1 && c16 >= 0 && v.clock >= 0 && MeshDecoder.wrap16(c16 - clockAt(v, f.ms)) < 80) { id = v.id; key = `${f.sync}/${id}`; break; }
      }
    }
    const d = this.devMap.get(key) ?? newDevice(f.sync, id, f.ms);
    d.frames++; d.lastMs = f.ms;
    d.hops.push({ hz: f.hz, ms: f.ms }); if (d.hops.length > 48) d.hops.splice(0, d.hops.length - 48);
    d.snr.push(f.snrDb); if (d.snr.length > 60) d.snr.splice(0, d.snr.length - 60);
    if (!d.lengths.includes(f.bytes.length)) d.lengths.push(f.bytes.length);
    d.lastHex = hxs(f.bytes.slice(0, 16));
    // a long F0 frame names the node: F0, its 24-bit ID, then a clock of its own. A short one (5 bytes or so) is only
    // a beacon whose clock happens to read F0xx, and goes on to the clock like any other.
    if (f.bytes.length >= 9 && f.bytes[1] === 0xF0) {
      const a = (f.bytes[2] << 16) | (f.bytes[3] << 8) | f.bytes[4];
      if (a === d.address) d.addressSeen++; else { d.address = a; d.addressSeen = 1; }
      this.devMap.set(key, d);
      return;
    }
    d.fields = [
      { name: 'NETWORK', value: `${MeshDecoder.syncName(f.sync)} · ${f.baud} baud 2-FSK` },
      { name: 'DEVICE', value: `${h2(id)} (first byte of every frame)` },
      { name: 'LAST FRAME', value: hxs(f.bytes) },
      { name: 'FREQUENCY', value: `${(f.hz / 1e6).toFixed(4)} MHz` },
      { name: 'SIGNAL', value: `+${f.snrDb} dB` },
      { name: 'LENGTHS', value: `${[...d.lengths].sort((x, y) => x - y).join(', ')} bytes` },
      { name: 'NODE ID', value: d.address >= 0 ? `${d.address.toString(16).toUpperCase().padStart(6, '0')} (${d.address}), heard ${d.addressSeen}×` : 'not announced yet' },
      { name: 'FRAME LAYOUT', value: 'index · clock (128/s) · check — ID frames: index · F0 · ID · clock · … 01 00' },
    ];
    if (f.sync === HOP9C && f.tag !== undefined) {
      d.fields.splice(2, 0, { name: 'CHANNEL BYTE', value: `${h2(f.tag)} at ${(f.hz / 1e6).toFixed(3)} MHz (the middle byte of the sync word follows the channel)` });
      d.fields = d.fields.filter(x => x.name !== 'FRAME LAYOUT' && x.name !== 'NODE ID');
    }
    if (f.sync === 0xA993A9 && f.bytes.length >= 10) {
      d.fields.splice(2, 0,
        { name: 'SIZE BYTE', value: `${h2(f.bytes[1])}: a ${(255 - f.bytes[1]) / 2 + 3}-byte frame` },
        { name: 'NETWORK ID', value: hxs(f.bytes.slice(2, 9)) });
      d.fields = d.fields.filter(x => x.name !== 'FRAME LAYOUT' && x.name !== 'NODE ID');
    }
    if (c16 >= 0) {
      // once the clock is known, a value that does not fit it (a bit error, another kind of frame) is left out
      const fits = d.ckV.length < 3 || MeshDecoder.wrap16(c16 - clockAt(d, f.ms)) < 80;
      if (fits) {
        d.ckMs.push(f.ms); d.ckV.push(c16);
        if (d.ckV.length > 12) { d.ckMs.shift(); d.ckV.shift(); }
        const slopes: number[] = [];
        for (let k = 1; k < d.ckV.length; k++) {
          if (d.ckMs[k] - d.ckMs[k - 1] < 25) continue;
          let dv = (d.ckV[k] - d.ckV[k - 1]) & 0xFFFF; if (dv >= 32768) dv -= 65536;
          const r = dv / ((d.ckMs[k] - d.ckMs[k - 1]) / 1000);
          if (Math.abs(r) <= 1000) slopes.push(r);   // the clocks seen tick 64 or 128 a second
        }
        if (slopes.length >= 2 || (d.clockRate === 0 && slopes.length)) { slopes.sort((x, y) => x - y); d.clockRate = slopes[slopes.length >> 1]; }
        d.clock = c16; d.clockMs = f.ms;
      } else {
        // frames on another clock line (another sender with the same index, or another kind of frame) are left out;
        // the card moves to a new line only once it has clearly taken over, 5 frames running
        const pm = d.pendMs;
        if (pm !== null && f.ms - pm >= 25 && MeshDecoder.wrap16(c16 - (d.pendV + Math.trunc(d.clockRate * (f.ms - pm) / 1000))) < 40) {
          d.pendRun++; d.pendMs = f.ms; d.pendV = c16;
          if (d.pendRun >= 5) { d.ckMs = [f.ms]; d.ckV = [c16]; d.clock = c16; d.clockMs = f.ms; d.resyncs++; d.pendMs = null; d.pendRun = 0; }
        } else { d.pendMs = f.ms; d.pendV = c16; d.pendRun = 1; }
      }
    }
    this.devMap.set(key, d);
  }

  /** An ERT reading from ErtDecoder: the meter joins the device list with its consumption. */
  ertReading(kind: string, id: number, commodity: string, cons: number, extra: [string, string][] = []): void {
    const ms = this.now();
    const uid = id >>> 0, key = `${ERT}/${uid}`;
    const d = this.devMap.get(key) ?? newDevice(ERT, uid, ms);
    d.frames++; d.lastMs = ms;
    d.ertKind = kind; d.commodity = commodity;
    if (d.consFirst < 0) d.consFirst = cons;
    d.cons = cons;
    if (d.consHistory[d.consHistory.length - 1] !== cons) { d.consHistory.push(cons); if (d.consHistory.length > 60) d.consHistory.shift(); }
    d.fields = [
      { name: 'PROTOCOL', value: kind === 'R900' ? 'Neptune R900' : `Itron ERT ${kind}` }, { name: 'METER ID', value: `${id}` },
      { name: 'COMMODITY', value: commodity }, { name: 'CONSUMPTION', value: `${cons}` },
      { name: 'SINCE FIRST HEARD', value: `+${cons - d.consFirst}` }, { name: 'READINGS', value: `${d.frames}` },
      ...extra.map(([name, value]) => ({ name, value })),
    ];
    d.hops.push({ hz: 0, ms }); if (d.hops.length > 48) d.hops.shift();
    this.devMap.set(key, d);
    this.flush();
  }

  /** Distance between two 16-bit clock values, either way round. */
  static wrap16(d: number): number { const m = d & 0xFFFF; return Math.min(m, 65536 - m); }

  /** A Gridstream id heard once, a bit or two off a meter heard three times or more, is a bit-error copy of it and is
   *  folded in (two real meters can differ by a bit, so an id heard more than once stays its own). */
  private foldGridstream(): void {
    const gs = [...this.devMap.values()].filter(d => d.net === GRIDSTREAM).sort((a, b) => b.frames - a.frames);
    for (const small of [...gs].reverse()) {
      if (small.frames > 1) continue;
      const big = gs.find(x => x.id !== small.id && x.frames >= 3 && pc(x.id ^ small.id) <= 2);
      if (!big) continue;
      const keep = this.devMap.get(this.gsKey(big.id));
      if (!keep || !this.devMap.has(this.gsKey(small.id))) continue;
      keep.frames += small.frames;
      for (const t of small.talksTo) if (!keep.talksTo.includes(t)) keep.talksTo.push(t);
      keep.addressed += small.addressed;
      keep.firstMs = Math.min(keep.firstMs, small.firstMs);
      for (const [k, v] of Object.entries(small.wanVotes)) keep.wanVotes[k] = (keep.wanVotes[k] ?? 0) + v;
      this.devMap.delete(this.gsKey(small.id));
      const links = new Map<string, MeshLink>();
      for (const l of this.linkSet.values()) {
        const a = l.a === small.id ? big.id : l.a, b = l.b === small.id ? big.id : l.b;
        if (a === b) continue;
        const nl = { a: Math.min(a, b), b: Math.max(a, b) }; links.set(`${nl.a}/${nl.b}`, nl);
      }
      this.linkSet = links;
    }
  }

  /** Publish the tables now (they otherwise refresh at most four times a second). */
  flush(): void {
    this.foldGridstream();
    // a network needs a real share of the traffic: a few frames of the busy one read off by a bit or two are not one
    // the share is of the sync-word networks only: Gridstream, 802.15.4g and the 106 kbaud network are found by their own
    // decoders, and a busy one of those must not hide a small sync-word network
    let top = 0; for (const n of this.netMap.values()) if (n.sync >= 0) top = Math.max(top, n.frames);
    this.nets = [...this.netMap.values()].filter(n => n.sync < 0 || n.frames >= 20 || (n.frames >= MeshDecoder.MIN_FRAMES && n.frames * 50 >= top)).sort((a, b) => b.frames - a.frames);
    this.bursts = this.count;
    this.links = [...this.linkSet.values()];
    // a card for: every ERT meter; a Gridstream meter heard twice, or addressed by others three times (one reference
    // alone is as likely a bit error in an id); a device of a network that is really there
    const shown = new Set(this.nets.map(n => n.sync));
    this.devices = [...this.devMap.values()].filter(d => {
      if (d.net === ERT) return true;
      if (d.net === GRIDSTREAM) return d.frames >= 2 || d.addressed >= 3;
      if (d.net === SUN || d.net === FAST) return true;
      return d.frames >= 5 && shown.has(d.net);
    }).sort((a, b) => b.lastMs - a.lastMs || a.id - b.id);
    this.post();
  }

  private post(): void {
    const snap: MetersSnapshot = { type: 'meters', nets: this.nets.map(n => ({ ...n })), devices: this.devices.map(d => ({ ...d })), links: this.links, bursts: this.bursts, busy: this.busy };
    this.emit(snap as unknown as Record<string, unknown>);
  }

  /** The log line: the frame decoded as far as its layout is known, raw hex only for what is not. */
  static line(f: MeshFrame): string {
    const b = f.bytes;
    const head = `${(f.hz / 1e6).toFixed(3)} +${f.snrDb} dB `;
    if (f.sync === GRIDSTREAM) {
      if (b.length >= 37 && b[2] === 0x2A && b[3] === 0x55 && b[6] === 0x30) {
        const id = u32(b, 26), up = u32(b, 20);
        const p = GridstreamWan.decode(GridstreamWan.value(b, 13));
        return head + `GRIDSTREAM beacon ${h8(id)} · up ${Math.floor(up / 86400)}d ${pad2(Math.floor(up / 3600) % 24)}h` + (p ? ` · ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : '');
      }
      if (b.length >= 15 && b[2] === 0x2A && b[3] === 0xD5) {
        return head + `GRIDSTREAM ${h8(u32(b, 11))} → ${h8(u32(b, 7))} · op ${h2(b[6])} · ` + hxs(b.slice(Math.min(b.length, 15)).slice(0, 10));
      }
      if (b.length >= 6 && b[2] <= 3 && (b[3] === 0x81 || b[3] === 0x85)) {
        return head + `GRIDSTREAM power usage report (DCW) · type ${h2(b[2])}/${h2(b[3])} · seq ${h2(b[4])} · ` + hxs(b.slice(5).slice(0, 24));
      }
      if (b.length >= 6 && b[2] === 0x2A && b[3] === 0xD2) return head + `GRIDSTREAM link frame D2 · len ${b[4]} · ` + hxs(b.slice(5).slice(0, 20));
      return head + 'GRIDSTREAM ' + hxs(b.slice(0, 16));
    }
    if (f.sync === SUN) {
      if (MeshDecoder.sunLayout(f)) return head + `802.15.4g ${hex(b.slice(4, 11))} · cnt ${h2(b[19])} · kind ${h2(b[3])} · net ${hex(b.slice(20, 26))} · ` + hxs(b.slice(26));
      return head + `802.15.4g ${b.length + 2}B · ` + hxs(b.slice(0, 20)) + (b.length > 20 ? ' …' : '');
    }
    if (f.sync === 0xF6E56B && b.length >= 9 && b[1] === 0xF0) {
      return head + `${MeshDecoder.syncName(f.sync)} node ${h2(b[0])} · ID ${h2(b[2])}${h2(b[3])}${h2(b[4])} · clock ${h2(b[5])}${h2(b[6])} · ` + hxs(b.slice(7));
    }
    if (f.sync === 0xF6E56B && b.length >= 4) {
      return head + `${MeshDecoder.syncName(f.sync)} node ${h2(b[0])} · clock ${h2(b[1])}${h2(b[2])} · check ${h2(b[3])}` + (b.length > 4 ? ' · ' + hxs(b.slice(4)) : '');
    }
    return head + MeshDecoder.syncName(f.sync) + ' · ' + hxs(b.slice(0, 20)) + (b.length > 20 ? ' …' : '');
  }
}

function pad2(v: number): string { return String(v).padStart(2, '0'); }

function chipEnergy(env: Float32Array, start: number, spc: number): number {
  const a = Math.floor(start), b = Math.min(env.length, Math.floor(start + spc));
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += env[i];
  return s / (b - a);
}

/**
 * The Meters app's processor: ErtDecoder (Itron SCM / SCM+ / IDM and Neptune R900, OOK) and MeshDecoder (the hopping
 * FSK mesh networks, Gridstream) on every buffer. Both live in 902-928 MHz and both want the same wide span, so one
 * app hears all of them.
 */
export class MetersProcessor implements IqProcessor {
  constructor(readonly ert: ErtDecoder, readonly mesh: MeshDecoder) {
    ert.onReading = (k, id, c, v, extra) => mesh.ertReading(k, id, c, v, extra);
  }
  reset(rate: number): void { this.ert.reset(rate); this.mesh.reset(rate); }
  onIq(iq: Int8Array, rate: number): void { this.ert.onIq(iq); this.mesh.onIq(iq, rate); }
  clear(): void { this.mesh.clear(); }
}
