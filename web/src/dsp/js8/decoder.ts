/**
 * JS8 receiver: every speed, every signal in the passband, at once.
 *
 * 48 kHz USB audio is resampled to each speed's working rate (12.8 kHz for Slow and Normal, 10.24 kHz for Fast and
 * Turbo, so a symbol is a power-of-two number of samples). Each slot of each speed is cut from a ring by the device
 * clock, turned into a log-power grid (FFT two symbols long, bins half a tone apart, a quarter-symbol step), searched
 * for the three Costas blocks across time and offset, and each candidate's 58 data tones give 174 soft bits for the
 * (174,87) LDPC decoder and the CRC-12. A second pass runs with the decoded signals taken out of the grid.
 */
import { fft } from '../../fft.js';
import { checkInfo, dataSym, frameTones, ldpcDecode, type Frame } from './codec.js';
import { JS8_MODES, frameSeconds, symSamples, type Js8Mode, type Js8Speed } from './modes.js';
import { unpackFrame, type Js8Frame } from './message.js';

const IN_RATE = 48_000;
const TIME_OSR = 4, FREQ_OSR = 4;
const F_LO = 100, F_HI = 3100;

export interface Js8Decode {
  mode: Js8Speed;
  /** Slot start, epoch ms. */
  slotMs: number;
  /** Audio offset of tone 0, Hz. */
  hz: number;
  snr: number;
  /** Start time against the nominal one, seconds. */
  dt: number;
  /** Frequency drift across the frame, Hz per minute. */
  drift: number;
  raw: string;
  flags: number;
  frame: Js8Frame;
  tones: number[];
}

/** Streaming rational resampler (windowed sinc, polyphase). */
export class Resampler {
  private readonly phases: Float32Array[] = [];
  private readonly hist: Float32Array;
  private hpos = 0; private acc = 0; private phase = 0;
  private readonly step: number;
  constructor(inRate: number, outRate: number, taps = 48) {
    this.step = inRate / outRate;
    let den = 1; while (den < 256 && Math.abs(this.step * den - Math.round(this.step * den)) > 1e-9) den++;
    const fc = 0.42 * outRate / inRate, half = taps / 2;
    for (let ph = 0; ph < den; ph++) {
      const frac = (ph * this.step) % 1, k = new Float32Array(taps); let sum = 0;
      for (let t = 0; t < taps; t++) {
        const x = t - half + 1 - frac;
        const s = Math.abs(x) < 1e-9 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * (t + 0.5 - frac) / taps) + 0.08 * Math.cos(4 * Math.PI * (t + 0.5 - frac) / taps);
        k[t] = s * w; sum += k[t];
      }
      for (let t = 0; t < taps; t++) k[t] /= sum;
      this.phases.push(k);
    }
    this.hist = new Float32Array(taps);
  }
  reset(): void { this.hist.fill(0); this.hpos = 0; this.acc = 0; this.phase = 0; }
  process(inp: Float32Array, n: number, out: (v: number) => void): void {
    const taps = this.hist.length;
    for (let i = 0; i < n; i++) {
      this.hist[this.hpos] = inp[i]; this.hpos = (this.hpos + 1) % taps;
      if (++this.acc >= this.step) {
        this.acc -= this.step;
        const k = this.phases[this.phase]; this.phase = (this.phase + 1) % this.phases.length;
        let y = 0, idx = this.hpos;
        for (let t = 0; t < taps; t++) { y += k[t] * this.hist[idx]; if (++idx >= taps) idx = 0; }
        out(y);
      }
    }
  }
}

/** Search window around the nominal start, seconds (early, late). */
export const dtRange = (m: Js8Mode): [number, number] => m.id === 'turbo' ? [-0.6, 1.2] : m.id === 'fast' ? [-1.0, 1.8] : [-1.5, 2.5];

interface Cand { t: number; f: number; score: number; }
const max4 = (a: number, b: number, c: number, d: number) => Math.max(a > b ? a : b, c > d ? c : d);
/** A data frame carries at least one character and ends with its 0 and 1s; anything else decoded is taken as is. */
function plausible(f: Frame): boolean { const u = unpackFrame(f); return u.kind !== 'data' || !!u.text; }

/** One speed's grid and search, on a buffer at the mode's working rate whose sample 0 is `t0` seconds into the slot. */
export class ModeDecoder {
  static LLR_SCALE = 24; static MIN_SCORE = 1.6;
  readonly sym: number; readonly nfft: number; readonly step: number;
  readonly binHz: number; readonly bin0: number; readonly nBins: number;
  private win: Float32Array; private re: Float32Array; private im: Float32Array;
  private grid = new Float32Array(0); private lin = new Float32Array(0); private nSteps = 0;
  constructor(readonly mode: Js8Mode) {
    this.sym = symSamples(mode); this.nfft = this.sym * FREQ_OSR; this.step = this.sym / TIME_OSR;
    this.binHz = mode.fs / this.nfft; this.bin0 = Math.round(F_LO / this.binHz); this.nBins = Math.round((F_HI - F_LO) / this.binHz);
    // one symbol, rectangular (the tones are orthogonal over it), zero-padded to two for half-tone bins
    this.win = new Float32Array(this.nfft); for (let i = 0; i < this.sym; i++) this.win[i] = 1;
    this.re = new Float32Array(this.nfft); this.im = new Float32Array(this.nfft);
  }

  /** Decode a buffer whose sample 0 sits `t0` s after the slot boundary (t0 = delay + early edge of the DT search). */
  decode(buf: Float32Array, t0: number, slotMs: number, maxCands = 160): Js8Decode[] {
    this.buildGrid(buf);
    const out: Js8Decode[] = [];
    const seen = new Set<string>();
    for (let pass = 0; pass < 2; pass++) {
      const cands = this.search(maxCands, pass ? ModeDecoder.MIN_SCORE * 0.75 : ModeDecoder.MIN_SCORE);
      let found = 0;
      for (const c of cands) {
        const r = this.tryCand(c, t0, slotMs);
        if (!r) continue;
        const key = `${r.raw}|${r.flags}|${Math.round(r.hz / (this.mode.spacing * 2))}`;
        if (seen.has(key) || out.some(o => o.raw === r.raw && o.flags === r.flags && Math.abs(o.hz - r.hz) < this.mode.spacing * 3)) continue;
        seen.add(key); out.push(r); found++;
        this.subtract(c, Uint8Array.from(r.tones));
      }
      if (!found) break;
    }
    return out.sort((a, b) => a.hz - b.hz);
  }

  private buildGrid(buf: Float32Array): void {
    const L = buf.length, n = Math.max(0, Math.floor((L - this.nfft) / this.step) + 1);
    this.nSteps = n;
    if (this.grid.length < n * this.nBins) { this.grid = new Float32Array(n * this.nBins); this.lin = new Float32Array(n * this.nBins); }
    const re = this.re, im = this.im, w = this.win;
    for (let s = 0; s < n; s++) {
      const off = s * this.step;
      for (let i = 0; i < this.nfft; i++) { re[i] = i < this.sym ? buf[off + i] * w[i] : 0; im[i] = 0; }
      fft(re, im);
      const base = s * this.nBins;
      for (let b = 0; b < this.nBins; b++) { const k = this.bin0 + b, p = re[k] * re[k] + im[k] * im[k]; this.lin[base + b] = p; this.grid[base + b] = 10 * Math.log10(p + 1e-12); }
    }
  }
  private at(s: number, b: number): number { return s < 0 || s >= this.nSteps || b < 0 || b >= this.nBins ? NaN : this.grid[s * this.nBins + b]; }

  private sync(t: number, f: number): number {
    // energy on the 21 sync tones against the mean of the other tones at the same symbols
    let on = 0, off = 0, cnt = 0;
    const c = this.mode.costas, g = this.lin;
    for (let blk = 0; blk < 3; blk++) for (let k = 0; k < 7; k++) {
      const s = t + (36 * blk + k) * TIME_OSR;
      if (s < 0 || s >= this.nSteps) continue;
      const row = s * this.nBins + f, tone = c[blk][k];
      let sum = 0; for (let j = 0; j < 8; j++) sum += g[row + j * FREQ_OSR];
      const v = g[row + tone * FREQ_OSR];
      on += v; off += (sum - v) / 7; cnt++;
    }
    return cnt >= 14 && off > 0 ? 10 * Math.log10(on / off) : -99;
  }
  private search(max: number, minScore: number): Cand[] {
    const maxF = this.nBins - 7 * FREQ_OSR - 1, maxT = this.nSteps - 1;
    const scores = new Float32Array((maxT + 1) * (maxF + 1)).fill(-99);
    const tMax = Math.round((dtRange(this.mode)[1] - dtRange(this.mode)[0]) * this.mode.fs / this.step);
    for (let t = 0; t <= Math.min(tMax, maxT); t++) for (let f = 0; f <= maxF; f++) scores[t * (maxF + 1) + f] = this.sync(t, f);
    const list: Cand[] = [];
    for (let t = 0; t <= Math.min(tMax, maxT); t++) for (let f = 0; f <= maxF; f++) {
      const v = scores[t * (maxF + 1) + f];
      if (v < minScore) continue;
      // local maximum over ±1 bin and ±2 steps
      let peak = true;
      for (let dt = -2; dt <= 2 && peak; dt++) for (let df = -1; df <= 1; df++) {
        if (!dt && !df) continue;
        const tt = t + dt, ff = f + df; if (tt < 0 || tt > maxT || ff < 0 || ff > maxF) continue;
        if (scores[tt * (maxF + 1) + ff] > v) { peak = false; break; }
      }
      if (peak) list.push({ t, f, score: v });
    }
    list.sort((a, b) => b.score - a.score);
    return list.slice(0, max);
  }

  private tryCand(c0: Cand, t0: number, slotMs: number): Js8Decode | null {
    // the peak and its time neighbors
    for (const dt of [0, -1, 1]) {
      const c = { ...c0, t: c0.t + dt };
      const llr = new Float32Array(174);
      for (let k = 0; k < 58; k++) {
        const s = c.t + dataSym(k) * TIME_OSR;
        const v = this.v8;
        for (let j = 0; j < 8; j++) { const x = this.at(s, c.f + j * FREQ_OSR); v[j] = Number.isNaN(x) ? 0 : x; }
        llr[3 * k] = max4(v[4], v[5], v[6], v[7]) - max4(v[0], v[1], v[2], v[3]);
        llr[3 * k + 1] = max4(v[2], v[3], v[6], v[7]) - max4(v[0], v[1], v[4], v[5]);
        llr[3 * k + 2] = max4(v[1], v[3], v[5], v[7]) - max4(v[0], v[2], v[4], v[6]);
      }
      let s1 = 0, s2 = 0; for (let i = 0; i < 174; i++) { s1 += llr[i]; s2 += llr[i] * llr[i]; }
      const varr = s2 / 174 - (s1 / 174) ** 2; if (varr <= 0) continue;
      const norm = Math.sqrt(ModeDecoder.LLR_SCALE / varr); for (let i = 0; i < 174; i++) llr[i] *= norm;
      const cw = ldpcDecode(llr, 40);
      if (!cw) continue;
      const frame = checkInfo(cw.subarray(87));
      if (!frame || !plausible(frame)) continue;
      return this.result(c, frame, t0, slotMs);
    }
    return null;
  }

  private result(c: Cand, frame: Frame, t0: number, slotMs: number): Js8Decode {
    const tones = frameTones(frame, this.mode.costas);
    // SNR: power on the sent tones against the median bin power, scaled to 2500 Hz
    let ps = 0, n = 0;
    for (let k = 0; k < 79; k++) { const s = c.t + k * TIME_OSR; if (s < 0 || s >= this.nSteps) continue; ps += this.lin[s * this.nBins + c.f + tones[k] * FREQ_OSR]; n++; }
    ps /= Math.max(1, n);
    const noise = this.noiseFloor();
    const snr = Math.round(10 * Math.log10(Math.max(1e-6, (ps - noise) / noise)) + 10 * Math.log10(this.mode.spacing / 2500));
    // offset and drift: where each sync block's energy peaks, within a tone either side, to a fraction of a bin
    const blockHz: number[] = [];
    for (let blk = 0; blk < 3; blk++) {
      const e: number[] = [];
      for (let d = -FREQ_OSR; d <= FREQ_OSR; d++) {
        let sum = 0;
        for (let k = 0; k < 7; k++) {
          const s = c.t + (36 * blk + k) * TIME_OSR, b = c.f + this.mode.costas[blk][k] * FREQ_OSR + d;
          if (s >= 0 && s < this.nSteps && b >= 0 && b < this.nBins) sum += this.lin[s * this.nBins + b];
        }
        e.push(sum);
      }
      let i = 1; for (let j = 1; j < e.length - 1; j++) if (e[j] > e[i]) i = j;
      const den = e[i - 1] - 2 * e[i] + e[i + 1], frac = den < 0 ? 0.5 * (e[i - 1] - e[i + 1]) / den : 0;
      blockHz.push((i - FREQ_OSR + Math.max(-0.5, Math.min(0.5, frac))) * this.binHz);
    }
    const hz = (this.bin0 + c.f) * this.binHz + (blockHz[0] + blockHz[1] + blockHz[2]) / 3;
    const drift = (blockHz[2] - blockHz[0]) / (72 * this.mode.symbol) * 60;
    const dt = t0 + c.t * this.step / this.mode.fs - this.mode.delay;
    const f = unpackFrame(frame);
    let raw = ''; for (let i = 0; i < 12; i++) { let v = 0; for (let b = 0; b < 6; b++) v = (v << 1) | frame.payload[i * 6 + b]; raw += '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-+'[v]; }
    return { mode: this.mode.id, slotMs, hz: Math.round(hz * 10) / 10, snr: Math.max(-30, Math.min(40, snr)), dt: Math.round(dt * 100) / 100, drift: Math.round(drift * 10) / 10, raw, flags: frame.flags, frame: f, tones: [...tones] };
  }

  private readonly v8 = new Float64Array(8);
  private floorCache = NaN;
  private noiseFloor(): number {
    if (!Number.isNaN(this.floorCache)) return this.floorCache;
    const s: number[] = []; const L = this.nSteps * this.nBins; const stride = Math.max(1, Math.floor(L / 4000));
    for (let i = 0; i < L; i += stride) s.push(this.lin[i]);
    s.sort((a, b) => a - b);
    // the median of exponential power is ln 2 of its mean
    this.floorCache = s[s.length >> 1] / Math.LN2;
    return this.floorCache;
  }

  /** Take a decoded signal out of the grid so weaker ones beside and under it can be found. */
  private subtract(c: Cand, tones: Uint8Array): void {
    const floorDb = 10 * Math.log10(this.noiseFloor() * Math.LN2 + 1e-12);
    for (let k = 0; k < 79; k++) for (let d = -TIME_OSR; d <= TIME_OSR; d++) {
      const s = c.t + k * TIME_OSR + d; if (s < 0 || s >= this.nSteps) continue;
      for (const db of [-1, 0, 1]) { const b = c.f + tones[k] * FREQ_OSR + db; if (b < 0 || b >= this.nBins) continue; this.grid[s * this.nBins + b] = floorDb; this.lin[s * this.nBins + b] = this.noiseFloor() * Math.LN2; }
    }
  }
  /** Call before each slot so the noise floor is measured afresh. */
  resetFloor(): void { this.floorCache = NaN; }
}

/** Streaming JS8 receiver over all four speeds. Audio in at 48 kHz, decodes out per slot. */
export class Js8Decoder {
  readonly name = 'JS8';
  confidence = 0;
  onText: (t: string, meta?: string) => void = () => {};
  onDecodes: (list: Js8Decode[], mode: Js8Speed, slotMs: number) => void = () => {};
  /** A waterfall row of the audio passband (0-3200 Hz, 6.25 Hz bins, dB) every quarter second. */
  onWaterfall: (row: Float32Array, ms: number) => void = () => {};
  enabled: Record<Js8Speed, boolean> = { slow: true, normal: true, fast: true, turbo: true };
  /** The device clock; replaceable for tests. */
  now: () => number = () => Date.now();
  private streams: { fs: number; rs: Resampler; ring: Float32Array; total: number; t0: number }[];
  private modes: { m: Js8Mode; dec: ModeDecoder; last: number; stream: number }[];
  private wfAcc = 0; private wfRe = new Float32Array(2048); private wfIm = new Float32Array(2048); private wfWin = new Float32Array(2048);
  constructor() {
    this.streams = [12_800, 10_240].map(fs => ({ fs, rs: new Resampler(IN_RATE, fs), ring: new Float32Array(fs * (fs === 12_800 ? 36 : 16)), total: 0, t0: 0 }));
    this.modes = JS8_MODES.map(m => ({ m, dec: new ModeDecoder(m), last: -1, stream: m.fs === 12_800 ? 0 : 1 }));
    for (let i = 0; i < 2048; i++) this.wfWin[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / 2048);
  }
  reset(): void { for (const s of this.streams) { s.rs.reset(); s.total = 0; s.t0 = 0; s.ring.fill(0); } for (const m of this.modes) m.last = -1; this.confidence = 0; }

  push(a: Float32Array, n: number): void {
    const now = this.now();
    for (const s of this.streams) {
      const L = s.ring.length;
      s.rs.process(a, n, v => { s.ring[s.total % L] = v; s.total++; });
      const est = now - s.total / s.fs * 1000;
      s.t0 = s.t0 === 0 ? est : s.t0 + 0.02 * (est - s.t0);
    }
    this.waterfall(now);
    for (const md of this.modes) {
      if (!this.enabled[md.m.id]) continue;
      const P = md.m.period * 1000, [, late] = dtRange(md.m);
      const lag = (md.m.delay + frameSeconds(md.m) + late + 0.15) * 1000 + md.dec.nfft / md.m.fs * 1000;
      const slot = Math.floor((now - lag) / P) * P;
      if (slot <= md.last) continue;
      const first = md.last < 0; md.last = slot;
      if (first) continue;          // the slot in progress when audio started is partial
      this.decodeSlot(md, slot);
    }
  }

  private decodeSlot(md: { m: Js8Mode; dec: ModeDecoder; stream: number }, slotMs: number): void {
    const s = this.streams[md.stream], m = md.m, [early, late] = dtRange(m);
    const startMs = slotMs + (m.delay + early) * 1000;
    const len = Math.round((frameSeconds(m) + late - early) * m.fs) + md.dec.nfft;
    const start = Math.round((startMs - s.t0) / 1000 * s.fs);
    if (start < s.total - s.ring.length || start + len > s.total) return;
    const buf = new Float32Array(len), L = s.ring.length;
    for (let i = 0; i < len; i++) { const k = start + i; buf[i] = k >= 0 ? s.ring[k % L] : 0; }
    md.dec.resetFloor();
    const list = md.dec.decode(buf, m.delay + early, slotMs);
    this.confidence = list.length ? 1 : Math.max(0, this.confidence - 0.2);
    for (const r of list) this.onText(`${m.label} ${String(r.snr).padStart(3)} ${r.dt.toFixed(1).padStart(4)} ${Math.round(r.hz).toString().padStart(4)}  ${r.frame.text ?? r.frame.kind}\n`, 'JS8');
    this.onDecodes(list, m.id, slotMs);
  }

  private waterfall(now: number): void {
    const s = this.streams[0];
    if (s.total < 2048) return;
    if (now - this.wfAcc < 250) return;
    this.wfAcc = now;
    const L = s.ring.length, end = s.total;
    for (let i = 0; i < 2048; i++) { this.wfRe[i] = s.ring[(end - 2048 + i) % L] * this.wfWin[i]; this.wfIm[i] = 0; }
    fft(this.wfRe, this.wfIm);
    const row = new Float32Array(512);
    for (let b = 0; b < 512; b++) row[b] = 10 * Math.log10(this.wfRe[b] * this.wfRe[b] + this.wfIm[b] * this.wfIm[b] + 1e-12);
    this.onWaterfall(row, now);
  }
}

/** Decode a whole slot of one speed from 48 kHz audio whose sample 0 is the slot boundary (tests, files). */
export function decodeSlotAudio(audio48: Float32Array, speed: Js8Speed, slotMs = 0): Js8Decode[] {
  const m = JS8_MODES.find(x => x.id === speed)!;
  const rs = new Resampler(IN_RATE, m.fs); const all: number[] = [];
  rs.process(audio48, audio48.length, v => all.push(v));
  const groupDelay = 24 / IN_RATE;                     // half the resampler's taps
  const [early, late] = dtRange(m);
  const dec = new ModeDecoder(m);
  const start = Math.round((m.delay + early + groupDelay) * m.fs);
  const len = Math.round((frameSeconds(m) + late - early) * m.fs) + dec.nfft;
  const buf = new Float32Array(len);
  for (let i = 0; i < len; i++) { const k = start + i; buf[i] = k >= 0 && k < all.length ? all[k] : 0; }
  return dec.decode(buf, m.delay + early, slotMs);
}
