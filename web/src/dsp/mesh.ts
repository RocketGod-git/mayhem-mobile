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

const GRIDSTREAM = -1, ERT = -2;
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
    label: net === ERT ? String(id) : net === GRIDSTREAM ? h8(id) : h2(id),
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
    this.written = 0; this.nextFrame = N; this.active = [];
  }

  clear(): void {
    this.established = []; this.heads.clear(); this.slips = 0; this.netMap.clear(); this.devMap.clear(); this.linkSet.clear(); this.lastLog.clear(); this.kinds.clear();
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
    for (let k = 0; k < n; k++) {
      const b = (k + n / 2) % n;                 // 0 = lowest frequency
      const p = re[k] * re[k] + im[k] * im[k];
      let f = floor[b];
      if (frames <= 8) f = frames === 1 ? p : f + 0.3 * (p - f);
      else if (p < f * 4) f += 0.02 * (p - f); else f += 0.0005 * (p - f);
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
      if (this.written - b.start > this.rate * 0.06) return false;   // a carrier, not a burst
      return true;
    });
    // a strong burst splashes into neighbors: keep the strongest of those that ended together
    done.sort((a, b) => b.peak - a.peak);
    const kept: typeof done = [];
    for (const b of done) if (!kept.some(k => Math.abs(k.bin - b.bin) * this.rate / n < 200_000 && Math.abs(k.last - b.last) < Math.floor(this.rate / 500))) kept.push(b);
    for (const b of kept) {
      // over budget: keep up with the radio first, decode what the time allows (strong bursts first)
      if (this.shedding && (this.busy > 0.8 || (this.busy > 0.5 && b.peak < 60))) { this.shed++; continue; }
      this.demod(b);
    }
  }

  // ---- demodulation ----
  private demod(b: { start: number; last: number; peak: number; bin: number }): void {
    const rate = this.rate, dur = (b.last - b.start) / rate;
    if (dur < 0.002) return;
    this.count++;
    const n = this.N;
    const offHz = (b.bin - n / 2) * rate / n;
    const edge = Math.max(this.HOP, Math.floor(rate / 2000));
    const from = Math.max(b.start - edge, this.written - this.ringMask + 1);
    const to = Math.min(this.written, b.last + edge);
    const len = to - from;
    if (len < 256) return;
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
    const lp = new ComplexFirDecimator(lowpassTaps(45_000 / fs, 33), 1);
    const z = new Float32Array(2 * (m0 + 2));
    const m = lp.process(z0, m0, z);
    // where the burst actually is (the detector's edges are half a millisecond coarse)
    const pw = new Float32Array(m);
    for (let k = 0; k < m; k++) pw[k] = z[2 * k] * z[2 * k] + z[2 * k + 1] * z[2 * k + 1];
    if (m === 0) return;
    const top = Float32Array.from(pw).sort()[Math.min(m - 1, Math.floor(m * 0.995))];
    let a = -1, e = -1;
    for (let k = 0; k < m; k++) if (pw[k] > 0.2 * top) { if (a < 0) a = k; e = k; }
    if (a < 0 || e - a <= 64) return;
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
      if (f) { this.publish(f); for (const x of this.extraFrames) this.publish(x); this.extraFrames = []; return; }
    }
    // not FSK: try it as on-off keying at 32768 chips a second (Neptune R900 water meters)
    this.ook(z, a, e, fs, this.centerHz + Math.trunc(offHz), snr);
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
    for (let s = 1; s < starts.length; s++) {
      const by = bytesOf(starts[s] + 24, s + 1 < starts.length ? starts[s + 1] : bits.length);
      if (by.length) this.extraFrames.push(frame(sync, by));
    }
    return frame(sync, bytesOf(start + 24, starts.length > 1 ? starts[1] : bits.length));
  }

  // ---- results ----
  static syncName(s: number): string { return s === GRIDSTREAM ? 'Gridstream' : s.toString(16).toUpperCase().padStart(6, '0'); }
  /**
   * The established network sync is a slipped read of, if any: within edit distance 2 (a slip is an insertion and a
   * deletion; a bit error is a substitution) of some 24-bit window of what that network sends, its preamble's tail,
   * its sync, and the two payload bytes that most often follow. A random word comes this close about 0.2% of the
   * time, so a real second network is not swallowed.
   */
  private slipOf(sync: number): number | null {
    const p = Array.from({ length: 24 }, (_, i) => (sync >> (23 - i)) & 1);
    for (const e of this.established) {
      if (e === sync) continue;
      const ctx = [...Array.from({ length: 16 }, (_, i) => (0x5555 >> (15 - i)) & 1), ...Array.from({ length: 24 }, (_, i) => (e >> (23 - i)) & 1)];
      let head = -1, best = 0;
      for (const [k, n] of this.heads.get(e) ?? []) if (n > best) { best = n; head = k; }
      if (head >= 0) for (let i = 15; i >= 0; i--) ctx.push((head >> i) & 1);
      if (MeshDecoder.editIn(p, ctx) <= 2) return e;
    }
    return null;
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
    if (f.sync !== GRIDSTREAM && (this.netMap.get(f.sync)?.frames ?? 0) < MeshDecoder.MIN_FRAMES) {
      let near: MeshNet | null = null;
      for (const v of this.netMap.values()) if (v.sync !== GRIDSTREAM && v.frames >= 5 && pc(v.sync ^ f.sync) <= 2 && (!near || v.frames > near.frames)) near = v;
      if (near) f.sync = near.sync;
      // not a few flipped bits but a slipped one: the sync search locked a bit or two early or late (or on the
      // preamble's tail), so the word read is a window of an established network's own bit stream, and the bytes
      // after it are misaligned too. One busy network turned into thousands of "networks" this way.
      else if (this.slipOf(f.sync) !== null) { this.slips++; return; }
    }
    this.onFrame?.(f);
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
    if (f.sync !== GRIDSTREAM && f.bytes.length >= 2) {
      const h = this.heads.get(f.sync) ?? new Map<number, number>(); const k = (f.bytes[0] << 8) | f.bytes[1];
      h.set(k, (h.get(k) ?? 0) + 1); this.heads.set(f.sync, h);
    }
    if (net.frames === 20 && f.sync !== GRIDSTREAM && !this.established.includes(f.sync)) this.established.push(f.sync);
    if (net.frames >= MeshDecoder.MIN_FRAMES || f.sync === GRIDSTREAM) this.track(f);
    // the debug log gets each new kind of frame (network, first byte, length), and every long one: readings arrive
    // rarely and in longer frames than the hop beacons
    const kind = `${MeshDecoder.syncName(f.sync)} ${h2(f.bytes[0] ?? 0)} ${f.bytes.length}B`;
    if (net.frames >= MeshDecoder.MIN_FRAMES && (f.bytes.length >= 10 || !this.kinds.has(kind))) { this.kinds.add(kind); this.emit({ type: 'log', line: `MESH ${MeshDecoder.line(f)}` }); }
    // the log: every Gridstream frame, else at most one line a second per network and frame type
    const key = f.sync * 257 + (f.bytes[0] ?? 0);
    if (f.sync === GRIDSTREAM || (net.frames >= MeshDecoder.MIN_FRAMES && f.ms - (this.lastLog.get(key) ?? 0) >= 1000)) {
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
      // a position is shown once two beacons agree on it, or while it is the only one heard
      const votes = Object.entries(d.wanVotes);
      let best: [string, number] | null = null;
      for (const v of votes) if (!best || v[1] > best[1]) best = v;
      const p = best && (best[1] >= 2 || votes.length === 1) ? GridstreamWan.decode(Number(best[0])) : null;
      if (p) { d.lat = p.lat; d.lon = p.lon; d.posColor = p.color; } else { d.lat = null; d.lon = null; }
    };
    if (b[3] === 0x55 && b.length >= 37 && b[6] === 0x30) {
      const d = dev(u32(b, 26));
      heard(d);
      d.uptimeS = u32(b, 20); d.uptimeMs = f.ms;
      d.clock = (b[35] << 8) | b[36]; d.clockMs = f.ms; d.clockRate = 100;   // hundredths into the 168 s cycle
      position(d, GridstreamWan.value(b, 13));
      const up = d.uptimeS;
      setFields(d, 'BEACON', [
        { name: 'FRAME', value: `beacon 2A 55, sync opcode 30, ${b.length} bytes` },
        { name: 'METER ID', value: `${h8(d.id)} (${d.id})` },
        { name: 'POSITION', value: d.lat !== null && d.lon !== null ? `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}` : '-' },
        { name: 'NODE COLOR', value: String(d.posColor) },
        { name: 'WAN ADDRESS', value: hex(b.slice(13, 19)) },
        { name: 'DESTINATION', value: hex(b.slice(7, 13)) },
        { name: 'UPTIME', value: `${up} s (${Math.floor(up / 86400)}d ${pad2(Math.floor(up / 3600) % 24)}h ${pad2(Math.floor(up / 60) % 60)}m)` },
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
        d.uptimeS = up; d.uptimeMs = f.ms;
        position(d, GridstreamWan.value(b, 32));
        const terr = u32(b, 20) | 0;
        const wan = GridstreamWan.decode(GridstreamWan.value(b, 32));
        const own = u32(b, 38);
        fl.push(
          { name: 'NETWORK TIME', value: `${new Date(epoch * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC` },
          { name: 'CLOCK ERROR', value: `${terr} (${hex(b.slice(20, 24))})` },
          { name: 'UPTIME', value: `${up} s (${Math.floor(up / 86400)}d ${pad2(Math.floor(up / 3600) % 24)}h)` },
          { name: 'STATUS', value: MeshDecoder.statusWord(b[28], b[29]) },
          { name: 'SEQUENCE', value: `threshold ${b[30]} · number ${b[31]}` },
          { name: 'POSITION', value: wan ? `${wan.lat.toFixed(5)}, ${wan.lon.toFixed(5)} (node color ${wan.color})` : '-' },
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
    let top = 0; for (const n of this.netMap.values()) top = Math.max(top, n.frames);
    this.nets = [...this.netMap.values()].filter(n => n.sync === GRIDSTREAM || n.frames >= 20 || (n.frames >= MeshDecoder.MIN_FRAMES && n.frames * 50 >= top)).sort((a, b) => b.frames - a.frames);
    this.bursts = this.count;
    this.links = [...this.linkSet.values()];
    // a card for: every ERT meter; a Gridstream meter heard twice, or addressed by others three times (one reference
    // alone is as likely a bit error in an id); a device of a network that is really there
    const shown = new Set(this.nets.map(n => n.sync));
    this.devices = [...this.devMap.values()].filter(d => {
      if (d.net === ERT) return true;
      if (d.net === GRIDSTREAM) return d.frames >= 2 || d.addressed >= 3;
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
