/**
 * The Sondes front end: finds the carriers in the band, gives each one a channel (down-converter, FM discriminator,
 * frequency tracking) and runs every sonde decoder on it at once, so the type is whatever decodes. A radio that
 * samples the whole band (a HackRF at 8 Msps covers 400–406 MHz) watches every carrier at once; a narrower one (an
 * RTL-SDR) steps across the band in windows and stays on a window while a sonde in it decodes.
 * The TypeScript twin of core/sonde/SondeFront.kt and SondeFront.swift.
 */
import { fft, hann } from '../../fft.js';
import type { Emit, IqProcessor } from '../core.js';
import { Ddc } from '../trains.js';
import { Retuner } from '../sweep.js';
import { makeDecoders, type ChannelDecoder } from './bank.js';
import { SondeTracker } from './track.js';
import type { SondeFrame } from './types.js';

export interface SondeBand { id: string; title: string; lo: number; hi: number }
export const SONDE_BANDS: SondeBand[] = [
  { id: '400', title: '400–406 MHz', lo: 400_000_000, hi: 406_000_000 },
  { id: '1680', title: '1680 MHz', lo: 1_675_000_000, hi: 1_685_000_000 },
];
/** The channel filter half-width and rate per band: LMS6-1680 swings about ±50 kHz, the 400 MHz types a few kHz. */
const CH_WIDTH: Record<string, [number, number]> = { '400': [11_000, 48_000], '1680': [60_000, 192_000] };
/** The channel rate every decoder works at. */
export const SONDE_CH_RATE = 48_000;
/** The whole-band span (HackRF): 8 Msps around a center off any common channel, so the DC spike sits between sondes. */
export const SONDE_WIDE = 8_000_000;
export const SONDE_NARROW = 2_400_000;
export const wideCenter = (b: SondeBand) => Math.round((b.lo + b.hi) / 2 - 237_500);
/** The windows a narrow radio steps through, keeping the inner ±0.9 MHz of each (the outer edge rolls off). */
export function narrowWindows(b: SondeBand, rate: number): number[] {
  const use = Math.min(rate * 0.75, rate - 400_000), out: number[] = [];
  for (let lo = b.lo; lo < b.hi; lo += use) out.push(Math.round(Math.min(lo + use / 2, b.hi - use / 2)) + 137_500);
  return out;
}
const MAX_CH = 8;

export interface SondeChannelRow { hz: number; level: number; ageMs: number; decoding: string; frames: number }

class Channel {
  readonly ddc: Ddc;
  private oi = new Float32Array(0); private oq = new Float32Array(0);
  private pi = 0; private pq = 0;
  private afcAcc = 0; private afcN = 0;
  readonly decoders: ChannelDecoder[];
  openedMs: number; lastCarrierMs: number; lastDecodeMs = 0; frames = 0; level = 0; lastType = '';
  private clock = 0;
  constructor(public hz: number, private center: number, rate: number, now: number, band: string, sink: (f: SondeFrame, ch: Channel) => void) {
    const [cut, want] = CH_WIDTH[band] ?? CH_WIDTH['400'];
    this.ddc = new Ddc(cut, want, 63);
    this.ddc.reset(rate);
    this.ddc.offsetHz = hz - center;
    this.openedMs = now; this.lastCarrierMs = now;
    this.decoders = makeDecoders(this.ddc.outRate, f => { this.lastDecodeMs = this.clock; this.frames++; this.lastType = f.type; sink(f, this); });
  }
  retarget(center: number): void { this.center = center; this.ddc.offsetHz = this.hz - center; }
  push(re: Float32Array, im: Float32Array, n: number, now: number): void {
    this.clock = now;
    const m = this.ddc.maxOut(n);
    if (this.oi.length < m) { this.oi = new Float32Array(m); this.oq = new Float32Array(m); }
    const k = this.ddc.push(re, im, n, this.oi, this.oq);
    for (const dec of this.decoders) if (dec.hz !== undefined) dec.hz = this.hz;
    let pi = this.pi, pq = this.pq;
    for (let i = 0; i < k; i++) {
      const a = this.oi[i], b = this.oq[i];
      // discriminator: angle of the product with the previous sample's conjugate
      const d = Math.atan2(b * pi - a * pq, a * pi + b * pq);
      pi = a; pq = b;
      this.afcAcc += d; this.afcN++;
      for (const dec of this.decoders) dec.push(d);
    }
    this.pi = pi; this.pq = pq;
    // frequency tracking: a sonde drifts kHz as it cools; re-center when the mean offset passes 1.2 kHz
    if (this.afcN >= this.ddc.outRate) {
      const off = this.afcAcc / this.afcN * this.ddc.outRate / (2 * Math.PI);
      if (Math.abs(off) > 1200) { this.hz += Math.round(off * 0.8); this.ddc.offsetHz = this.hz - this.center; }
      this.afcAcc = 0; this.afcN = 0;
    }
  }
}

export class SondeProcessor implements IqProcessor {
  band: SondeBand = SONDE_BANDS[0];
  centerHz = wideCenter(SONDE_BANDS[0]);
  readonly tracker = new SondeTracker();
  private rate = SONDE_WIDE;
  private readonly N = 4096;
  private readonly win = hann(this.N);
  private readonly fre = new Float32Array(this.N); private readonly fim = new Float32Array(this.N);
  private readonly acc = new Float32Array(this.N); private accFrames = 0;
  private re = new Float32Array(0); private im = new Float32Array(0);
  private chans: Channel[] = [];
  /** Candidates seen at the last look (hz → times in a row), so a one-off spike never opens a channel. */
  private seen = new Map<number, number>();
  /** Carriers that held a channel without ever decoding: left alone for a while. */
  private banned = new Map<number, number>();
  private lastLook = 0; private lastSnap = 0;
  private readonly retuner: Retuner;
  private windows: number[] = []; private winIx = 0; private winSince = 0;
  private lastFloor = 0;
  /** Sample time, ms: wall time at the start plus the samples since (the decoders' clock, also when replaying). */
  private clockBase = Date.now(); private samples = 0;
  now(): number { return this.clockBase + this.samples * 1000 / this.rate; }
  constructor(private readonly emit: Emit) { this.retuner = new Retuner(emit); }

  /** Peaks closer than this are one carrier (a wide LMS6-1680 spreads ±50 kHz). */
  private get mergeHz(): number { return this.band.id === '1680' ? 80_000 : 20_000; }
  get wide(): boolean { return this.rate >= 6_000_000; }
  /** Where others (SondeHub) hear balloons right now: a narrow radio goes to those windows first. */
  private hints: number[] = [];
  setHints(hz: number[]): void { this.hints = hz.filter(h => Number.isFinite(h) && h > 0); }
  setBand(id: string): void {
    this.band = SONDE_BANDS.find(b => b.id === id) ?? SONDE_BANDS[0];
    this.chans = []; this.seen.clear(); this.banned.clear();
    this.windows = narrowWindows(this.band, this.rate); this.winIx = 0;
  }
  reset(rate: number): void {
    this.rate = rate; this.chans = []; this.seen.clear(); this.acc.fill(0); this.accFrames = 0;
    this.windows = narrowWindows(this.band, rate);
    this.clockBase = Date.now(); this.samples = 0; this.winSince = this.now();
  }
  /** The span center moved (the user, or our own hop). */
  setCenter(hz: number): void {
    if (hz === this.centerHz) return;
    this.centerHz = hz;
    const half = this.rate * 0.45;
    this.chans = this.chans.filter(c => Math.abs(c.hz - hz) < half);
    for (const c of this.chans) c.retarget(hz);
    this.acc.fill(0); this.accFrames = 0; this.seen.clear();
  }
  tuned(): void { this.retuner.tuned(); }
  clear(): void { this.tracker.clear(); this.chans = []; this.seen.clear(); this.banned.clear(); }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    if (this.retuner.stale()) return;
    const n = iq.length >> 1;
    if (this.re.length < n) { this.re = new Float32Array(n); this.im = new Float32Array(n); }
    const re = this.re, im = this.im;
    for (let i = 0; i < n; i++) { re[i] = iq[2 * i] / 128; im[i] = iq[2 * i + 1] / 128; }
    // a look at the spectrum every buffer or so (a slice of each, enough to average a carrier out of the noise)
    for (let off = 0; off + this.N <= n && this.accFrames < 64; off += this.N * 8) {
      for (let k = 0; k < this.N; k++) { this.fre[k] = re[off + k] * this.win[k]; this.fim[k] = im[off + k] * this.win[k]; }
      fft(this.fre, this.fim);
      for (let k = 0; k < this.N; k++) this.acc[k] += this.fre[k] * this.fre[k] + this.fim[k] * this.fim[k];
      this.accFrames++;
    }
    this.samples += n;
    const now = this.now();
    for (const c of this.chans) c.push(re, im, n, now);
    if (now - this.lastLook >= 400 && this.accFrames >= 4) { this.look(now); this.lastLook = now; }
    if (!this.wide) this.hop(now, n);
    if (now - this.lastSnap >= 500) { this.lastSnap = now; this.snapshot(now); }
  }

  /** Carriers in the averaged spectrum: local peaks well over the median floor, inside the band. */
  private look(now: number): void {
    const N = this.N, db = new Float32Array(N);
    for (let k = 0; k < N; k++) { const j = (k + N / 2) % N; db[k] = 10 * Math.log10(this.acc[j] / this.accFrames + 1e-20); }
    this.acc.fill(0); this.accFrames = 0;
    const sorted = Float32Array.from(db).sort(), floor = sorted[N >> 1];
    this.lastFloor = floor;
    const binHz = this.rate / N, edge = Math.floor(N * 0.07), dc = Math.ceil(2500 / binHz);
    const reach = Math.max(2, Math.round(10_000 / binHz));
    const found: { hz: number; lvl: number }[] = [];
    for (let k = edge; k < N - edge; k++) {
      if (Math.abs(k - N / 2) <= dc) continue;
      const v = db[k];
      if (v < floor + 8) continue;
      let peak = true;
      for (let j = Math.max(0, k - reach); j <= Math.min(N - 1, k + reach); j++) if (db[j] > v || (db[j] === v && j < k)) { peak = false; break; }
      if (!peak) continue;
      // power-weighted center over the carrier's own width
      let w = 0, s = 0;
      for (let j = Math.max(0, k - reach); j <= Math.min(N - 1, k + reach); j++) { const p = Math.pow(10, (db[j] - floor) / 10) - 1; if (p > 0) { w += p; s += p * j; } }
      const bin = w > 0 ? s / w : k;
      const hz = Math.round(this.centerHz + (bin - N / 2) * binHz);
      if (hz < this.band.lo - 20_000 || hz > this.band.hi + 20_000) continue;
      found.push({ hz, lvl: v - floor });
    }
    found.sort((a, b) => b.lvl - a.lvl);
    // one carrier, one peak: a wide sonde (M10 at 9600 baud) has sideband peaks of its own within ±20 kHz
    const keep: { hz: number; lvl: number }[] = [];
    // and a much weaker peak near a strong carrier is its spur, not a sonde
    for (const f of found) if (!keep.some(k => Math.abs(k.hz - f.hz) < this.mergeHz || (Math.abs(k.hz - f.hz) < 100_000 && k.lvl > f.lvl + 18))) keep.push(f);
    const seen = new Map<number, number>();
    for (const f of keep) {
      const ch = this.chans.find(c => Math.abs(c.hz - f.hz) < this.mergeHz);
      if (ch) { ch.lastCarrierMs = now; ch.level = f.lvl; continue; }
      const key = Math.round(f.hz / 5000) * 5000;
      if ((this.banned.get(key) ?? 0) > now) continue;
      const times = (this.seen.get(key) ?? 0) + 1;
      seen.set(key, times);
      if (times >= 2 && this.chans.length >= MAX_CH) {
        // full: a clearly stronger carrier takes the place of the weakest channel that has not decoded
        let weak: Channel | null = null;
        for (const c of this.chans) if (!c.lastDecodeMs && (!weak || c.level < weak.level)) weak = c;
        if (weak && f.lvl > weak.level + 6) this.chans.splice(this.chans.indexOf(weak), 1);
      }
      if (times >= 2 && this.chans.length < MAX_CH) {
        const c = new Channel(f.hz, this.centerHz, this.rate, now, this.band.id, (fr, from) => this.heard(fr, from));
        c.level = f.lvl; this.chans.push(c);
        this.emit({ type: 'log', line: `Sondes: carrier at ${(f.hz / 1e6).toFixed(4)} MHz, +${f.lvl.toFixed(0)} dB, listening` });
      }
    }
    this.seen = seen;
    // close what went quiet; a carrier that never decodes is set aside (not a sonde, or one we can't read)
    this.chans = this.chans.filter(c => {
      const quietCarrier = now - c.lastCarrierMs > 15_000, quietDecode = now - Math.max(c.lastDecodeMs, c.openedMs) > 15_000;
      if (quietCarrier && quietDecode) return false;
      if (!c.lastDecodeMs && now - c.openedMs > 45_000) { this.banned.set(Math.round(c.hz / 5000) * 5000, now + 180_000); return false; }
      return true;
    });
  }

  /** A narrow radio: step through the band's windows; stay while a sonde decodes or a fresh carrier is being tried. */
  private hop(now: number, n: number): void {
    if (this.windows.length < 2) return;
    const decoding = this.chans.some(c => c.lastDecodeMs && now - c.lastDecodeMs < 30_000);
    const trying = this.chans.some(c => !c.lastDecodeMs && now - c.openedMs < 12_000);
    if (decoding || trying) { this.winSince = now; return; }
    if (now - this.winSince < 2500) return;
    // a balloon others are hearing (SondeHub) says where to listen: step only through the windows that hold one
    // (inner ±0.9 MHz), and through the whole band when nothing is reported
    const told = this.windows.map((w, i) => i).filter(i => this.hints.some(h => Math.abs(h - this.windows[i]) <= 900_000));
    if (told.length) {
      const at = told.indexOf(this.winIx);
      if (told.length === 1 && at === 0) { this.winSince = now; return; }
      this.winIx = told[(at + 1) % told.length];
    } else this.winIx = (this.winIx + 1) % this.windows.length;
    this.winSince = now;
    const hz = this.windows[this.winIx];
    this.retuner.next(hz, n, this.rate);
  }

  private heard(f: SondeFrame, ch: Channel): void {
    const s = this.tracker.add(f, ch.hz, ch.level, this.now());
    if (s.frames === 1) this.emit({ type: 'log', line: `Sondes: ${f.model ?? f.type} ${f.serial} on ${(ch.hz / 1e6).toFixed(3)} MHz` });
    for (const e of this.tracker.events.splice(0)) this.emit({ type: 'log', line: `Sondes: ${e}` });
    this.emit({ type: 'packet', line: sondeLine(f, ch.hz) });
  }

  private snapshot(now: number): void {
    const channels: SondeChannelRow[] = this.chans.map(c => ({ hz: c.hz, level: Math.round(c.level), ageMs: now - c.openedMs, decoding: c.lastDecodeMs && now - c.lastDecodeMs < 10_000 ? c.lastType : '', frames: c.frames }));
    this.emit({ type: 'sonde', sondes: this.tracker.rows(now), channels, wide: this.wide, centerHz: this.centerHz, band: this.band.id, floor: Math.round(this.lastFloor),
      window: this.wide ? null : { ix: this.winIx, of: this.windows.length } });
  }
}

/** One log line per frame: time, type, serial, frame, position, height, climb, temperature. */
export function sondeLine(f: SondeFrame, hz: number): string {
  // the type leads (upper case), so the log colors each type as its own kind; the GPS time follows as a detail
  const parts = [`${(f.model ?? f.type).toUpperCase()} ${f.serial}`];
  if (f.timeS !== undefined) parts.push(`${String(Math.floor(f.timeS / 3600) % 24).padStart(2, '0')}:${String(Math.floor(f.timeS / 60) % 60).padStart(2, '0')}:${String(Math.floor(f.timeS % 60)).padStart(2, '0')} UTC`);
  if (f.frame !== undefined) parts.push(`#${f.frame}`);
  if (f.lat !== undefined && f.lon !== undefined) parts.push(`${f.lat.toFixed(5)},${f.lon.toFixed(5)}`);
  if (f.alt !== undefined) parts.push(`${Math.round(f.alt)} m`);
  if (f.climb !== undefined) parts.push(`${f.climb >= 0 ? '+' : ''}${f.climb.toFixed(1)} m/s`);
  if (f.tempC !== undefined) parts.push(`${f.tempC.toFixed(1)} °C`);
  if (f.rh !== undefined) parts.push(`${Math.round(f.rh)}%`);
  if (f.hPa !== undefined) parts.push(`${f.hPa.toFixed(1)} hPa`);
  parts.push(`${(hz / 1e6).toFixed(3)} MHz`);
  return parts.join(' · ');
}
