/**
 * Z-Wave (ITU-T G.9959) for Devices and the Analyzer. R1 9.6 kb/s Manchester and R2 40 kb/s NRZ on 908.42 MHz,
 * R3 100 kb/s on 916.00 MHz (US). FSK is read off the discriminator, sliced at each rate in both polarities, found by
 * its 0x55 preamble and 0xF0 start of frame, and kept only when its frame check passes: the 8-bit XOR checksum
 * seeded 0xFF for R1/R2, CRC-16-CCITT seeded 0x1D0F for R3.
 */

export type ZwRate = 'R1' | 'R2' | 'R3';
export const ZW_BAUD: Record<ZwRate, number> = { R1: 9600, R2: 40000, R3: 100000 };
/** The US channels, and the rates each carries. */
export const ZW_CHANNELS: { hz: number; rates: ZwRate[] }[] = [
  { hz: 908_420_000, rates: ['R1', 'R2'] },
  { hz: 916_000_000, rates: ['R3'] },
];

export function zwChecksum(b: ArrayLike<number>, n = b.length): number {
  let c = 0xFF;
  for (let i = 0; i < n; i++) c ^= b[i];
  return c;
}

export function zwCrc16(b: ArrayLike<number>, n = b.length): number {
  let c = 0x1D0F;
  for (let i = 0; i < n; i++) {
    c ^= b[i] << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c;
}

export interface ZwFrame {
  rate: ZwRate;
  home: string;
  src: number;
  dst: number;
  /** The two frame control bytes. */
  fc: number;
  /** Header type: 1 singlecast, 2 multicast, 3 acknowledgment, 8 routed. */
  type: number;
  ackReq: boolean;
  routed: boolean;
  lowPower: boolean;
  seq: number;
  len: number;
  payload: Uint8Array;
  /** The whole frame, check included. */
  bytes: Uint8Array;
}

/** A frame from its bytes (home ID first), or null when the length or the check is wrong. */
export function zwParse(by: ArrayLike<number>, rate: ZwRate): ZwFrame | null {
  if (by.length < 10) return null;
  const L = by[7];
  const crc = rate === 'R3';
  if (L < (crc ? 11 : 10) || L > by.length || L > 170) return null;
  if (crc) { if (zwCrc16(by, L - 2) !== ((by[L - 2] << 8) | by[L - 1])) return null; }
  else if (zwChecksum(by, L - 1) !== by[L - 1]) return null;
  const bytes = Uint8Array.from({ length: L }, (_, i) => by[i]);
  const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
  const f0 = by[5], f1 = by[6];
  return {
    rate, home: hex2(by[0]) + hex2(by[1]) + hex2(by[2]) + hex2(by[3]), src: by[4], dst: by[8],
    fc: (f0 << 8) | f1, type: f0 & 0x0F, ackReq: !!(f0 & 0x40), routed: !!(f0 & 0x80), lowPower: !!(f0 & 0x20), seq: f1 & 0x0F,
    len: L, payload: bytes.slice(9, L - (crc ? 2 : 1)), bytes,
  };
}

export function zwHex(b: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (i ? ' ' : '') + b[i].toString(16).toUpperCase().padStart(2, '0');
  return s;
}

/** Command class names from the published Z-Wave command class specification. */
const CC: Record<number, string> = {
  0x00: 'NOP', 0x20: 'BASIC', 0x25: 'SWITCH BINARY', 0x26: 'SWITCH MULTILEVEL', 0x27: 'SWITCH ALL', 0x2B: 'SCENE ACTIVATION',
  0x30: 'SENSOR BINARY', 0x31: 'SENSOR MULTILEVEL', 0x32: 'METER', 0x40: 'THERMOSTAT MODE', 0x43: 'THERMOSTAT SETPOINT',
  0x5A: 'DEVICE RESET LOCALLY', 0x5B: 'CENTRAL SCENE', 0x5E: 'ZWAVEPLUS INFO', 0x60: 'MULTI CHANNEL', 0x62: 'DOOR LOCK',
  0x6C: 'SUPERVISION', 0x70: 'CONFIGURATION', 0x71: 'NOTIFICATION', 0x72: 'MANUFACTURER SPECIFIC', 0x73: 'POWERLEVEL',
  0x80: 'BATTERY', 0x84: 'WAKE UP', 0x85: 'ASSOCIATION', 0x86: 'VERSION', 0x8E: 'MULTI CHANNEL ASSOCIATION',
  0x98: 'SECURITY', 0x9F: 'SECURITY 2',
};
/** SET 1, GET 2, REPORT 3: the commands these classes share. */
const SGR: Record<number, string> = { 1: 'SET', 2: 'GET', 3: 'REPORT' };
const SGR_CC = new Set([0x20, 0x25, 0x26]);

export interface ZwMeaning { cc: string; cmd: string; value: number | null; text: string }

export function zwValue(v: number): string {
  return v === 0 ? 'off' : v === 0xFF ? 'on' : v <= 99 ? `level ${v}` : `0x${v.toString(16).toUpperCase()}`;
}

/** What a frame says, in words. */
export function zwDescribe(f: ZwFrame): ZwMeaning {
  if (f.type === 3) return { cc: '', cmd: 'ACK', value: null, text: 'ACK' };
  const pre = f.type === 2 ? 'multicast ' : '';
  if (f.routed) return { cc: '', cmd: 'ROUTED', value: null, text: `${pre}routed frame` };
  const p = f.payload;
  if (!p.length) return { cc: '', cmd: '', value: null, text: `${pre}no payload` };
  const name = CC[p[0]] ?? `class 0x${p[0].toString(16).toUpperCase().padStart(2, '0')}`;
  if (p[0] === 0x00) return { cc: 'NOP', cmd: '', value: null, text: `${pre}NOP` };
  if (p.length < 2) return { cc: name, cmd: '', value: null, text: pre + name };
  let cmd = `0x${p[1].toString(16).toUpperCase().padStart(2, '0')}`, value: number | null = null;
  if (SGR_CC.has(p[0]) && SGR[p[1]]) {
    cmd = SGR[p[1]];
    if ((p[1] === 1 || p[1] === 3) && p.length >= 3) value = p[2];
  } else if (p[0] === 0x30 && (p[1] === 2 || p[1] === 3)) {
    cmd = SGR[p[1]];
    if (p[1] === 3 && p.length >= 3) value = p[2];
  } else if (p[0] === 0x80 && (p[1] === 2 || p[1] === 3)) {
    cmd = SGR[p[1]];
    if (p[1] === 3 && p.length >= 3) value = p[2];
  } else if (p[0] === 0x84 && p[1] === 7) cmd = 'NOTIFICATION';
  else if (p[0] === 0x84 && p[1] === 8) cmd = 'NO MORE INFORMATION';
  const vtext = value === null ? '' : p[0] === 0x80 ? ` ${value === 0xFF ? 'low' : `${value}%`}` : ` ${value} (${zwValue(value)})`;
  return { cc: name, cmd, value, text: `${pre}${name} ${cmd}${vtext}` };
}

function median(v: Float32Array): number {
  const s = Float32Array.from(v).sort();
  return s.length ? s[s.length >> 1] : 0;
}

/** Every frame start in `bits`: the bit index just past each preamble and 0xF0. */
function* sofs(bits: Uint8Array, nb: number): Generator<number> {
  let w = 0;
  for (let i = 0; i < nb; i++) {
    w = ((w << 1) | bits[i]) & 0xFFFFFF;
    if (i >= 23 && w === 0x5555F0) yield i + 1;
  }
}

function bytesAt(bits: Uint8Array, nb: number, j0: number): number[] {
  const by: number[] = [];
  for (let j = j0; j + 8 <= nb && by.length < 170; j += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[j + k];
    by.push(v);
  }
  return by;
}

/**
 * Every frame in a burst of complex samples at `fs`, trying each rate in turn: the discriminator less its median,
 * a moving average 0.6 of a symbol long, six sampling phases, both polarities, and for R1 both Manchester pairings.
 * `at` is where each frame starts, in samples.
 */
export function zwSliceAll(re: Float32Array, im: Float32Array, n: number, fs: number, rates: ZwRate[]): { frame: ZwFrame; at: number }[] {
  const out: { frame: ZwFrame; at: number }[] = [];
  if (n < 16) return out;
  const seen = new Set<string>();
  const d = new Float32Array(n - 1);
  for (let i = 0; i + 1 < n; i++) {
    const a = re[i + 1] * re[i] + im[i + 1] * im[i], b = im[i + 1] * re[i] - re[i + 1] * im[i];
    d[i] = Math.atan2(b, a);
  }
  const med = median(d);
  for (let i = 0; i < d.length; i++) d[i] -= med;
  for (const rate of rates) {
    const manch = rate === 'R1';
    const sps = fs / ZW_BAUD[rate] * (manch ? 0.5 : 1);
    if (sps < 1.2) continue;
    const w = Math.max(1, Math.floor(sps * 0.6)), h = (w - 1) >> 1;
    const ds = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) {
      let s = 0;
      for (let m = 0; m < w; m++) { const j = i + h - m; if (j >= 0 && j < d.length) s += d[j]; }
      ds[i] = s / w;
    }
    const nChips = Math.max(0, Math.ceil((d.length - sps) / sps));
    const chips = new Uint8Array(nChips), bits = new Uint8Array(nChips);
    for (let k = 0; k < 6; k++) {
      const ph = k * sps / 6;
      let nc = 0;
      for (let t = 0; t < d.length - sps; t += sps) chips[nc++] = ds[Math.floor(ph + t)] > 0 ? 1 : 0;
      const cands: [Uint8Array, number, number][] = [];
      if (manch) {
        for (const o of [0, 1]) {
          const b = new Uint8Array(nc >> 1);
          let nb = 0;
          for (let i = o; i < nc - 1; i += 2) b[nb++] = chips[i] === 1 && chips[i + 1] === 0 ? 1 : 0;
          cands.push([b, nb, o]);
        }
      } else cands.push([chips.slice(0, nc), nc, 0]);
      for (const [b0, nb, o] of cands) {
        for (const inv of [0, 1]) {
          for (let i = 0; i < nb; i++) bits[i] = b0[i] ^ inv;
          for (const j of sofs(bits, nb)) {
            const f = zwParse(bytesAt(bits, nb, j), rate);
            if (!f) continue;
            const id = zwHex(f.bytes);
            if (seen.has(id)) continue;
            seen.add(id);
            const at = Math.round(ph + ((manch ? 2 * (j - 24) + o : j - 24)) * sps);
            out.push({ frame: f, at });
          }
        }
      }
    }
    if (out.length) break;
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The first frame in a burst, or null. */
export function zwSlice(re: Float32Array, im: Float32Array, n: number, fs: number, rates: ZwRate[]): ZwFrame | null {
  return zwSliceAll(re, im, n, fs, rates)[0]?.frame ?? null;
}

/** Every Z-Wave frame in a captured burst (interleaved I/Q bytes at `rate`), at any of the three rates. */
export function zwMatches(iq: Int8Array, n: number, rate: number): ZwFrame[] {
  if (rate < 150_000 || n < 64) return [];
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) { re[i] = iq[2 * i]; im[i] = iq[2 * i + 1]; }
  return zwSliceAll(re, im, n, rate, ['R2', 'R3', 'R1']).map(x => x.frame);
}

/** A frame as heard: where, how strong, and when in radio time (ms since the receiver started). */
export interface ZwHeard extends ZwFrame { mhz: number; snr: number; t: number }

const FS_TARGET = 400_000;
const HALF_BW = 150_000;
const LIT = 12;
const MIN_BURST_S = 0.0015;
const MAX_BURST_S = 0.3;
const QUIET_S = 0.0003;
const PAD = 200;

/** One Z-Wave channel inside the span: mixed down, filtered, decimated to about 400 kS/s and watched for bursts. */
class ZwChannel {
  readonly fs: number;
  private readonly d1: number; private readonly d2: number;
  private readonly taps: Float32Array;
  private readonly hr: Float32Array; private readonly hi: Float32Array; private hp = 0;
  private b1r = 0; private b1i = 0; private b1n = 0; private c2 = 0;
  private cr = 1; private ci = 0; private readonly sr: number; private readonly si: number; private nco = 0;
  private readonly ring: number; private readonly rr: Float32Array; private readonly ri: Float32Array; private w = 0;
  private ps = 0; private floor = 0; private warm = 0;
  private inBurst = false; private start = 0; private end = 0; private quiet = 0; private endAt = -1; private sum = 0; private cnt = 0;

  constructor(readonly hz: number, readonly off: number, readonly rates: ZwRate[], rate: number, private readonly onFrame: (f: ZwHeard) => void, private readonly clock: () => number) {
    this.d1 = Math.max(1, Math.floor(rate / 2_000_000));
    const r1 = rate / this.d1;
    this.d2 = Math.max(1, Math.round(r1 / FS_TARGET));
    this.fs = r1 / this.d2;
    const L = Math.max(15, Math.min(161, Math.round(3.3 * r1 / 100_000) | 1));
    this.taps = new Float32Array(L);
    const fc = Math.min(HALF_BW, 0.45 * this.fs) / r1;
    let s = 0;
    for (let i = 0; i < L; i++) {
      const x = i - (L - 1) / 2;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      this.taps[i] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (L - 1)));
      s += this.taps[i];
    }
    for (let i = 0; i < L; i++) this.taps[i] /= s;
    this.hr = new Float32Array(2 * L); this.hi = new Float32Array(2 * L);
    const step = -2 * Math.PI * off / rate;
    this.sr = Math.cos(step); this.si = Math.sin(step);
    this.ring = 1 << Math.ceil(Math.log2(this.fs * (MAX_BURST_S + 0.05)));
    this.rr = new Float32Array(this.ring); this.ri = new Float32Array(this.ring);
  }

  process(iq: Int8Array): void {
    const L = this.taps.length, taps = this.taps, hr = this.hr, hi = this.hi;
    for (let k = 0; k + 1 < iq.length; k += 2) {
      const I = iq[k], Q = iq[k + 1];
      this.b1r += I * this.cr - Q * this.ci; this.b1i += I * this.ci + Q * this.cr;
      const t = this.cr * this.sr - this.ci * this.si; this.ci = this.cr * this.si + this.ci * this.sr; this.cr = t;
      if (++this.nco >= 4096) { this.nco = 0; const m = Math.hypot(this.cr, this.ci); this.cr /= m; this.ci /= m; }
      if (++this.b1n < this.d1) continue;
      const xr = this.b1r / this.d1, xi = this.b1i / this.d1;
      this.b1r = 0; this.b1i = 0; this.b1n = 0;
      hr[this.hp] = xr; hi[this.hp] = xi; hr[this.hp + L] = xr; hi[this.hp + L] = xi;
      this.hp = (this.hp + 1) % L;
      if (++this.c2 < this.d2) continue;
      this.c2 = 0;
      let yr = 0, yi = 0;
      for (let j = 0, p = this.hp; j < L; j++, p++) { yr += taps[j] * hr[p]; yi += taps[j] * hi[p]; }
      this.sample(yr, yi);
    }
  }

  private sample(yr: number, yi: number): void {
    const m = this.ring - 1, idx = this.w;
    this.rr[idx & m] = yr; this.ri[idx & m] = yi; this.w++;
    const p = yr * yr + yi * yi;
    this.ps += (p - this.ps) / 32;
    if (this.warm < 2000) {
      if (++this.warm > 64) this.floor = this.floor ? this.floor + (this.ps - this.floor) / 64 : this.ps;
      if (this.floor < 1e-6) this.floor = 1e-6;
      return;
    }
    if (this.endAt >= 0) {
      if (idx >= this.endAt) this.finish(idx);
      else return;
    }
    if (!this.inBurst) {
      if (this.ps > this.floor * LIT) { this.inBurst = true; this.start = idx; this.quiet = 0; this.sum = 0; this.cnt = 0; }
      else this.floor += (this.ps - this.floor) / (this.ps < this.floor ? 64 : 4096);
      if (this.floor < 1e-6) this.floor = 1e-6;
    }
    if (this.inBurst) {
      this.sum += p; this.cnt++;
      if (this.ps < this.floor * LIT * 0.5) { if (++this.quiet > this.fs * QUIET_S) { this.inBurst = false; this.endAt = idx + PAD; this.end = idx - this.quiet; } }
      else this.quiet = 0;
      if (this.inBurst && idx - this.start > this.fs * MAX_BURST_S) { this.inBurst = false; this.floor = this.ps; }
    }
  }

  private finish(idx: number): void {
    this.endAt = -1;
    const a = this.start, b = this.end;
    if ((b - a) < this.fs * MIN_BURST_S) return;
    const from = Math.max(a - PAD, idx - this.ring + 1, 0), n = idx - from;
    const re = new Float32Array(n), im = new Float32Array(n), m = this.ring - 1;
    for (let i = 0; i < n; i++) { re[i] = this.rr[(from + i) & m]; im[i] = this.ri[(from + i) & m]; }
    const found = zwSliceAll(re, im, n, this.fs, this.rates);
    if (!found.length) return;
    const snr = 10 * Math.log10(Math.max(1e-9, this.sum / Math.max(1, this.cnt)) / this.floor);
    for (const { frame } of found) this.onFrame({ ...frame, mhz: this.hz / 1e6, snr: Math.round(snr * 10) / 10, t: this.clock() });
  }
}

/** Every US Z-Wave channel that falls inside the span, listened to at once. */
export class ZWaveRx {
  private chans: ZwChannel[] = [];
  private rate = 0; private center = 0;
  private samples = 0;
  frames = 0;
  constructor(private readonly onFrame: (f: ZwHeard) => void) {}

  /** Radio time in ms since the receiver started. */
  airMs(): number { return this.rate ? this.samples / this.rate * 1000 : 0; }

  configure(rate: number, center: number): void {
    if (rate === this.rate && center === this.center) return;
    this.rate = rate; this.center = center;
    this.chans = [];
    if (!rate || !center) return;
    for (const c of ZW_CHANNELS) {
      const off = c.hz - center;
      if (Math.abs(off) + HALF_BW < rate / 2) this.chans.push(new ZwChannel(c.hz, off, c.rates, rate, f => { this.frames++; this.onFrame(f); }, () => this.airMs()));
    }
  }

  /** Which channels are being listened to, MHz. */
  listening(): number[] { return this.chans.map(c => c.hz / 1e6); }

  process(iq: Int8Array): void {
    for (const c of this.chans) c.process(iq);
    this.samples += iq.length >> 1;
  }
}

export interface ZwNode {
  id: number;
  controller: boolean;
  /** The rate and channel of its latest frame, and every rate it has been heard on. */
  rate: ZwRate;
  mhz: number;
  rates: ZwRate[];
  lastSeen: number;
  /** SNR of the node's own last frame, dB; null when only frames sent to it were heard. */
  snr: number | null;
  sent: number;
  got: number;
  /** Seconds between polls, measured from repeats; null until two have been heard. */
  poll: number | null;
  last: string;
  /** The last BASIC (or switch) value it reported, or was set to. */
  value: number | null;
}
export interface ZwLink { from: number; to: number; frames: number; last: string }
export interface ZwNet { home: string; nodes: ZwNode[]; links: ZwLink[]; frames: number; channels: number[] }

/** A gap longer than this between frames for one node starts a new exchange. */
const EXCHANGE_GAP_MS = 5000;

/** The Z-Wave networks heard: each home ID, its nodes, and who talks to whom. */
export class ZWaveNets {
  private readonly nets = new Map<string, { nodes: Map<number, ZwNode & { starts: number[]; lastT: number }>; links: Map<string, ZwLink>; frames: number; channels: Set<number>; requesters: Set<number> }>();

  clear(): void { this.nets.clear(); }
  get size(): number { return this.nets.size; }

  /** Add one frame; `wall` is when it was heard (ms, for the screen), `f.t` its radio time (ms, for the intervals). */
  add(f: ZwHeard, wall: number): ZwNet {
    let n = this.nets.get(f.home);
    if (!n) { n = { nodes: new Map(), links: new Map(), frames: 0, channels: new Set(), requesters: new Set() }; this.nets.set(f.home, n); }
    n.frames++; n.channels.add(f.mhz);
    const m = zwDescribe(f);
    const node = (id: number) => {
      let x = n!.nodes.get(id);
      if (!x) { x = { id, controller: false, rate: f.rate, mhz: f.mhz, rates: [], lastSeen: wall, snr: null, sent: 0, got: 0, poll: null, last: '', value: null, starts: [], lastT: -Infinity }; n!.nodes.set(id, x); }
      return x;
    };
    const seenOn = (x: ZwNode) => { x.rate = f.rate; x.mhz = f.mhz; x.lastSeen = wall; if (!x.rates.includes(f.rate)) { x.rates.push(f.rate); x.rates.sort(); } };
    const s = node(f.src);
    s.sent++; s.snr = f.snr; seenOn(s);
    if (f.type !== 3 && (m.cmd === 'GET' || m.cmd === 'SET')) n.requesters.add(f.src);
    if (f.type !== 3 && m.cmd !== 'GET') s.last = m.text;
    if (m.cmd === 'REPORT' && m.value !== null) s.value = m.value;
    if (f.dst !== 0xFF && f.type !== 2) {
      const d = node(f.dst);
      d.got++; seenOn(d);
      if (m.cmd === 'SET' && m.value !== null) d.value = m.value;
      if (f.type !== 3 && f.payload.length && n.requesters.has(f.src)) {
        if (f.t - d.lastT > EXCHANGE_GAP_MS) { d.starts.push(f.t); if (d.starts.length > 16) d.starts.shift(); }
        d.lastT = f.t;
      }
      const key = `${f.src}>${f.dst}`;
      const l = n.links.get(key) ?? { from: f.src, to: f.dst, frames: 0, last: '' };
      l.frames++; l.last = m.text; n.links.set(key, l);
    }
    for (const x of n.nodes.values()) {
      x.controller = n.requesters.size ? n.requesters.has(x.id) : x.id === 1;
      if (x.starts.length >= 2 && !x.controller) {
        const g = x.starts.slice(1).map((t, i) => t - x.starts[i]).sort((a, b) => a - b);
        const mid = g.length & 1 ? g[g.length >> 1] : (g[g.length / 2 - 1] + g[g.length / 2]) / 2;
        x.poll = Math.round(mid / 100) / 10;
      }
    }
    return this.snapshot(f.home)!;
  }

  snapshot(home: string): ZwNet | null {
    const n = this.nets.get(home);
    if (!n) return null;
    const nodes = [...n.nodes.values()].map(({ starts: _s, lastT: _l, ...x }) => ({ ...x, rates: x.rates.slice() }))
      .sort((a, b) => (b.controller ? 1 : 0) - (a.controller ? 1 : 0) || a.id - b.id);
    return { home, nodes, links: [...n.links.values()].map(l => ({ ...l })), frames: n.frames, channels: [...n.channels].sort((a, b) => a - b) };
  }
}
