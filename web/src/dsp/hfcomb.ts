/**
 * The HF comb notch. Both sites' receivers (a HackRF Pro and an RTL-SDR, in two buildings) hear narrow steady lines at
 * exact multiples of 16.000 kHz in RF across HF, from an outside, precisely clocked source (likely network gear): each
 * 0.2 Hz wide, within a few Hz of n x 16 kHz (the radio's own tuning leftover, the same for every line at one tuning).
 * They show as steady lines in the waterfall and as tones in the audio.
 *
 * A channel's complex baseband goes through here before it is demodulated. Each n x 16 kHz inside the channel's band
 * (below 30 MHz only) is measured on its own: mixed to DC, low-passed (fourth-order Butterworth, 70 Hz) and sampled at
 * 256 Hz, then a 2 s spectrum (Hann, 0.5 Hz a bin) every second, the last 16 kept. Each bin is the mean of its quietest
 * two thirds over them: the idle seconds, so a talker or an FT8 signal that comes and goes drops out of it. A line is
 * there when the strongest bin within 10 Hz of n x 16 kHz stands 6 dB over the median of the bins 12 to 60 Hz either
 * side (10 dB from the 4th spectrum until 11 are in: with fewer, noise alone reaches 8 dB), and a new one is narrow, 6 dB
 * over the bins 2.5 to 7 Hz from it (a voice sitting on the grid point is not), and steady, moving from spectrum to
 * spectrum no more than noise moves it (an FT8 tone is a narrow line too, but comes and goes). Its frequency is read
 * between bins by a parabola. Only a line found is notched, by a one-pole complex notch 1 Hz wide (-3 dB at 0.5 Hz
 * either side), so a tone 3 Hz away loses 0.1 dB. A line missing from two measurements running is let go.
 */
import { fft } from '../fft.js';

export const COMB_STEP_HZ = 16_000;
/** Nothing at or above this RF frequency is measured or notched. */
export const COMB_TOP_HZ = 30_000_000;
export const COMB_MEAS_RATE = 256, COMB_MEAS_N = 512, COMB_MEAS_HOP = 256, COMB_KEEP = 16, COMB_MIN = 4, COMB_FULL = 11;
export const COMB_SEARCH_HZ = 10, COMB_LOCAL_LO_HZ = 12, COMB_LOCAL_HI_HZ = 60;
/** A new line is narrow: 6 dB over the median of the bins 2.5 to 7 Hz either side of its peak (speech is not). */
export const COMB_NEAR_LO_HZ = 2.5, COMB_NEAR_HI_HZ = 7;
/** And steady: its spread over the spectra kept under this share of its level, or this many times what noise gives. */
export const COMB_STEADY_MIN = 0.35, COMB_STEADY_K = 1.5;
export const COMB_OVER_DB = 6, COMB_OVER_EARLY_DB = 10;
export const COMB_NOTCH_HALF_HZ = 0.5, COMB_LP_HZ = 70, COMB_MISS = 2;

/** A two-pole Butterworth low-pass section (bilinear), in double precision. */
class Lp2 {
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number;
  private z1 = 0; private z2 = 0;
  constructor(hz: number, fs: number, q: number) {
    const w = 2 * Math.PI * hz / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), a0 = 1 + al;
    this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }
  step(x: number): number { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}

/** What a span's channels have found so far (Repeaters: a demodulator lives only as long as a transmission). */
export class CombMemory {
  lo = NaN;
  readonly lines = new Map<number, { hz: number; db: number }>();
  said = '';
}

export interface CombFound { rfHz: number; offsetHz: number; db: number }

class Line {
  f0 = 0;
  // measurement: the phasor turning n x 16 kHz to DC, its low-pass, the 256 Hz samples and the spectra
  mr = 1; mi = 0; dr = 1; di = 0;
  readonly li: Lp2[]; readonly lq: Lp2[];
  readonly ri = new Float32Array(COMB_MEAS_N); readonly rq = new Float32Array(COMB_MEAS_N); w = 0; got = 0; hop = 0;
  readonly specs: Float32Array[] = [];
  /** Each spectrum's own median over the bins 12 to 60 Hz either side. */
  readonly meds: number[] = [];
  // the notch: on, the line's offset from n x 16 kHz (Hz), how far it stood (dB), misses running, its phasor and estimate
  on = false; hz = 0; db = 0; miss = 0;
  nr = 1; ni = 0; ndr = 1; ndi = 0; er = 0; ei = 0;
  constructor(readonly n: number, fs: number) {
    this.li = [new Lp2(COMB_LP_HZ, fs, 0.5412), new Lp2(COMB_LP_HZ, fs, 1.3066)];
    this.lq = [new Lp2(COMB_LP_HZ, fs, 0.5412), new Lp2(COMB_LP_HZ, fs, 1.3066)];
  }
}

export class CombNotch {
  private lo = NaN; private rf = NaN;
  private lines: Line[] = [];
  private readonly a: number;
  private dec = 0; private readonly decStep: number;
  private readonly win = new Float32Array(COMB_MEAS_N);
  private readonly comp = new Float32Array(COMB_MEAS_N);
  private readonly re = new Float32Array(COMB_MEAS_N); private readonly im = new Float32Array(COMB_MEAS_N);
  private said = '';
  private renorm = 0;

  /**
   * [fs]: the baseband's rate; [maxHz]: lines this far either side of its center are measured; [clearHz]: a line this
   * near the center is never notched (where a station's own carrier would be); [log]: one line when the lines notched
   * change; [memory]: shared by the channels of one span.
   */
  constructor(readonly fs: number, readonly maxHz: number, private readonly log?: (line: string) => void, readonly clearHz = 0, private readonly memory?: CombMemory) {
    this.a = 1 - Math.exp(-2 * Math.PI * COMB_NOTCH_HALF_HZ / fs);
    this.decStep = COMB_MEAS_RATE / fs;
    for (let k = 0; k < COMB_MEAS_N; k++) this.win[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / COMB_MEAS_N);
    // the low-pass's droop over the bins measured, taken back out (fourth-order Butterworth: 1 / (1 + (f/fc)^8))
    for (let b = 0; b < COMB_MEAS_N; b++) { const f = (b - COMB_MEAS_N / 2) * COMB_MEAS_RATE / COMB_MEAS_N; this.comp[b] = 1 + (f / COMB_LP_HZ) ** 8; }
  }

  /** Lines notched now (RF frequency, offset from n x 16 kHz, how far over the local median). */
  found(): CombFound[] { return this.lines.filter(l => l.on).map(l => ({ rfHz: l.n * COMB_STEP_HZ + l.hz, offsetHz: l.hz, db: l.db })); }
  /** Whether any line could be here at all (some n x 16 kHz inside the band, under 30 MHz). */
  get active(): boolean { return this.lines.length > 0; }

  /**
   * The radio's LO and the baseband center's offset from it (Hz). A new LO starts over (the radio's few-Hz tuning
   * leftover changes with it); moving the channel keeps what was measured on the lines still inside the band.
   */
  tune(loHz: number, offsetHz: number): void {
    const rf = loHz + offsetHz;
    if (loHz === this.lo && rf === this.rf) return;
    if (loHz !== this.lo) { this.lines = []; this.lo = loHz; }
    this.rf = rf;
    const mem = this.memory;
    if (mem && mem.lo !== loHz) { mem.lo = loHz; mem.lines.clear(); mem.said = ''; }
    const first = Math.max(1, Math.ceil((rf - this.maxHz) / COMB_STEP_HZ)), last = Math.floor((rf + this.maxHz) / COMB_STEP_HZ);
    const keep: Line[] = [];
    for (let n = first; n <= last; n++) {
      if (n * COMB_STEP_HZ >= COMB_TOP_HZ) break;
      let l = this.lines.find(x => x.n === n);
      if (!l) {
        l = new Line(n, this.fs);
        const m = mem?.lines.get(n);
        if (m) { l.on = true; l.hz = m.hz; l.db = m.db; }
      }
      l.f0 = n * COMB_STEP_HZ - rf;
      const w = -2 * Math.PI * l.f0 / this.fs; l.dr = Math.cos(w); l.di = Math.sin(w);
      this.setNotch(l);
      keep.push(l);
    }
    this.lines = keep;
  }

  private setNotch(l: Line): void { const w = 2 * Math.PI * (l.f0 + l.hz) / this.fs; l.ndr = Math.cos(w); l.ndi = Math.sin(w); }

  /** Interleaved I/Q, in place. */
  processInterleaved(buf: Float32Array, n: number): void {
    if (!this.lines.length) return;
    for (let i = 0; i < n; i++) { this.step(buf[2 * i], buf[2 * i + 1]); buf[2 * i] = this.oR; buf[2 * i + 1] = this.oI; }
  }
  /** Separate I and Q, in place. */
  processSplit(bi: Float32Array, bq: Float32Array, n: number): void {
    if (!this.lines.length) return;
    for (let i = 0; i < n; i++) { this.step(bi[i], bq[i]); bi[i] = this.oR; bq[i] = this.oI; }
  }

  private oR = 0; private oI = 0;
  private step(xr: number, xi: number): void {
    this.dec += this.decStep;
    const take = this.dec >= 1; if (take) this.dec -= 1;
    const norm = ++this.renorm >= 4096; if (norm) this.renorm = 0;
    let yr = xr, yi = xi;
    for (const l of this.lines) {
      // measured on what came in
      const zr = xr * l.mr - xi * l.mi, zi = xr * l.mi + xi * l.mr;
      const fr = l.li[1].step(l.li[0].step(zr)), fi = l.lq[1].step(l.lq[0].step(zi));
      { const t = l.mr * l.dr - l.mi * l.di; l.mi = l.mr * l.di + l.mi * l.dr; l.mr = t; }
      if (take) this.sample(l, fr, fi);
      if (l.on) {
        // the line turned to DC, its one-pole estimate, turned back and taken out
        const ur = yr * l.nr + yi * l.ni, ui = yi * l.nr - yr * l.ni;
        l.er += this.a * (ur - l.er); l.ei += this.a * (ui - l.ei);
        yr -= l.er * l.nr - l.ei * l.ni; yi -= l.er * l.ni + l.ei * l.nr;
      }
      { const t = l.nr * l.ndr - l.ni * l.ndi; l.ni = l.nr * l.ndi + l.ni * l.ndr; l.nr = t; }
      if (norm) {
        const g = 1 / Math.hypot(l.mr, l.mi); l.mr *= g; l.mi *= g;
        const h = 1 / Math.hypot(l.nr, l.ni); l.nr *= h; l.ni *= h;
      }
    }
    this.oR = yr; this.oI = yi;
  }

  private sample(l: Line, i: number, q: number): void {
    l.ri[l.w] = i; l.rq[l.w] = q; l.w = (l.w + 1) % COMB_MEAS_N;
    if (l.got < COMB_MEAS_N) l.got++;
    if (++l.hop < COMB_MEAS_HOP || l.got < COMB_MEAS_N) return;
    l.hop = 0;
    const N = COMB_MEAS_N, re = this.re, im = this.im;
    for (let k = 0; k < N; k++) { const j = (l.w + k) % N; re[k] = l.ri[j] * this.win[k]; im[k] = l.rq[j] * this.win[k]; }
    fft(re, im);
    const s = new Float32Array(N);
    for (let k = 0; k < N; k++) { const b = (k + N / 2) % N; s[b] = (re[k] * re[k] + im[k] * im[k]) * this.comp[b]; }
    const loc: number[] = [], loB = Math.round(COMB_LOCAL_LO_HZ * N / COMB_MEAS_RATE), hiB = Math.round(COMB_LOCAL_HI_HZ * N / COMB_MEAS_RATE);
    for (let d = loB; d <= hiB; d++) loc.push(s[N / 2 + d], s[N / 2 - d]);
    loc.sort((x, y) => x - y);
    l.specs.push(s); l.meds.push(loc[loc.length >> 1] || 1e-30);
    if (l.specs.length > COMB_KEEP) { l.specs.shift(); l.meds.shift(); }
    if (l.specs.length >= COMB_MIN) this.judge(l);
  }

  /** Is the line there, on the idle part of the spectra kept? */
  private judge(l: Line): void {
    const N = COMB_MEAS_N, c = N / 2, perHz = N / COMB_MEAS_RATE, k = l.specs.length, use = k - Math.floor(k / 3);
    const hiB = Math.round(COMB_LOCAL_HI_HZ * perHz), loB = Math.round(COMB_LOCAL_LO_HZ * perHz), srch = Math.round(COMB_SEARCH_HZ * perHz);
    const quiet = new Float64Array(2 * hiB + 1), col = new Float64Array(k);
    for (let d = -hiB; d <= hiB; d++) {
      for (let j = 0; j < k; j++) col[j] = l.specs[j][c + d];
      col.sort(); let sum = 0; for (let j = 0; j < use; j++) sum += col[j];
      quiet[d + hiB] = sum / use;
    }
    const local: number[] = [];
    for (let d = loB; d <= hiB; d++) { local.push(quiet[hiB + d], quiet[hiB - d]); }
    local.sort((x, y) => x - y);
    const med = local[local.length >> 1] || 1e-30;
    let pk = -srch; for (let d = -srch; d <= srch; d++) if (quiet[d + hiB] > quiet[pk + hiB]) pk = d;
    const over = 10 * Math.log10(quiet[pk + hiB] / med);
    const near: number[] = [], nLo = Math.round(COMB_NEAR_LO_HZ * perHz), nHi = Math.round(COMB_NEAR_HI_HZ * perHz);
    for (let d = nLo; d <= nHi; d++) { near.push(quiet[hiB + pk + d], quiet[hiB + pk - d]); }
    near.sort((x, y) => x - y);
    const narrow = 10 * Math.log10(quiet[pk + hiB] / (near[near.length >> 1] || 1e-30)) > COMB_OVER_DB;
    // and steady: its level in each spectrum (over that spectrum's median) moves no more than noise moves a line that
    // strong, about sqrt(2 / level) of it (an FT8 tone, which CPFSK also makes a narrow line, comes and goes with the
    // symbols and the slots)
    let sum = 0, sq = 0;
    for (let j = 0; j < k; j++) { const sp = l.specs[j], v = Math.max(sp[c + pk - 1], sp[c + pk], sp[c + pk + 1]) / l.meds[j]; sum += v; sq += v * v; }
    const mean = sum / k, sd = Math.sqrt(Math.max(0, sq / k - mean * mean));
    const steady = sd < mean * Math.max(COMB_STEADY_MIN, COMB_STEADY_K * Math.sqrt(2 / mean));
    const need = k >= COMB_FULL ? COMB_OVER_DB : COMB_OVER_EARLY_DB;
    let hz = pk / perHz;
    if (pk > -srch && pk < srch) {
      const ya = Math.log(quiet[pk - 1 + hiB] + 1e-30), yb = Math.log(quiet[pk + hiB] + 1e-30), yc = Math.log(quiet[pk + 1 + hiB] + 1e-30), den = ya - 2 * yb + yc;
      if (den < 0) hz = (pk + 0.5 * (ya - yc) / den) / perHz;
    }
    const was = l.on, clear = Math.abs(l.f0 + hz) >= this.clearHz;
    // the stricter early level only turns a line on; one already notched stays while it stands 6 dB
    if (clear && ((over > need && narrow && steady) || (l.on && over > COMB_OVER_DB))) {
      l.hz = l.on ? 0.5 * (l.hz + hz) : hz; l.db = over; l.miss = 0; l.on = true;
      this.memory?.lines.set(l.n, { hz: l.hz, db: l.db });
    } else if (l.on && ++l.miss >= COMB_MISS) { l.on = false; l.er = l.ei = 0; this.memory?.lines.delete(l.n); }
    if (l.on) this.setNotch(l);
    if (was !== l.on) this.report();
  }

  private report(): void {
    if (!this.log) return;
    const all = this.memory ? [...this.memory.lines.entries()].map(([n, v]) => ({ rfHz: n * COMB_STEP_HZ + v.hz, offsetHz: v.hz, db: v.db })) : this.found();
    let text: string;
    if (!all.length) text = 'HF comb: no lines at n x 16 kHz now';
    else {
      const top = all.reduce((x, y) => (y.db > x.db ? y : x));
      text = `HF comb: ${all.length} line${all.length > 1 ? 's' : ''} at n x 16 kHz notched, strongest ${(top.rfHz / 1e6).toFixed(3)} MHz ${top.db.toFixed(0)} dB over the floor (offset ${top.offsetHz >= 0 ? '+' : ''}${top.offsetHz.toFixed(1)} Hz)`;
    }
    const last = this.memory ? this.memory.said : this.said;
    // the first "none" is not news: only say so once lines were notched
    if (text === last || (!all.length && !last)) return;
    if (this.memory) this.memory.said = text; else this.said = text;
    this.log(text);
  }
}
