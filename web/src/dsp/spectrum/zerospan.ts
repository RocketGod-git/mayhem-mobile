/**
 * Spectrum: zero span. The analyzer stays on one frequency and shows what happens there over time, as an
 * oscilloscope would: the amplitude through a chosen filter bandwidth, the instantaneous frequency and the phase.
 *
 * The channel is mixed to 0 Hz from wherever it sits in the radio's span (the radio is tuned off it, so the DC spike
 * is not on the signal), averaged down in a boxcar stage, low-passed to half the filter bandwidth by a windowed-sinc
 * FIR and decimated to about four samples per hertz of filter bandwidth.
 *
 * Triggering: FREE runs as a roll (the newest window, redrawn as it moves); RISE and FALL wait for the amplitude to
 * cross the trigger level that way (1 dB of hysteresis) and capture a window with `pre` of it before the trigger;
 * SINGLE disarms after one capture until it is armed again. While a trigger waits, a preview of the newest window goes
 * out five times a second (flagged `preview`), so the screen is never blank while nothing has crossed the level.
 */

export type TrigMode = 'FREE' | 'RISE' | 'FALL';
export const TRIG_MODES: TrigMode[] = ['FREE', 'RISE', 'FALL'];
/** Filter bandwidths on offer (a radio shows those its rates allow). */
export const ZS_BWS = [1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000];
/** The most samples one window holds. */
export const ZS_MAX_POINTS = 262_144;
/** The most points sent to the screen per window (more are peak-reduced to this). */
export const ZS_SHOW_POINTS = 65_536;
export const TRIG_HYST_DB = 1;
/** Where the channel sits from the radio's center, as a fraction of the rate: clear of DC, inside the radio's filter. */
export const ZS_OFFSET = 0.2;
/** The widest filter that fits at a rate with the channel ZS_OFFSET away from DC. */
export const zsMaxBw = (rate: number) => 0.36 * rate;
const MAX_TAPS = 63;

/** A windowed-sinc (Blackman) low-pass with cutoff fc (cycles per sample), unity gain at DC. */
export function designLowpass(fc: number, taps: number): Float32Array {
  const h = new Float32Array(taps), m = (taps - 1) / 2;
  let s = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
    h[i] = sinc * w; s += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= s;
  return h;
}

export interface ZsConfig {
  /** The channel's offset from the radio's center, Hz. */
  offsetHz: number;
  bwHz: number;
  sweepSec: number;
  trigger: TrigMode;
  single: boolean;
  /** Trigger level, dBFS. */
  levelDb: number;
  /** Fraction of the window before the trigger, 0..0.9. */
  pre: number;
}

export interface ZsCapture {
  /** Amplitude dBFS, instantaneous frequency Hz (from the channel center), phase degrees. */
  amp: Float32Array; fm: Float32Array; ph: Float32Array;
  /** Points per second of the arrays (after any reduction for the screen). */
  rate: number;
  /** The trigger's index in the arrays, or -1 for a roll. */
  trig: number;
  roll: boolean;
  /** A look at the channel while a trigger waits (5 a second, the newest window, not a capture): drawn dimmed. */
  preview: boolean;
}

/** The decimation plan for a filter at a rate: boxcar by d1, FIR by d2, to outRate. */
export function zsPlan(rate: number, bwHz: number): { d1: number; d2: number; outRate: number; taps: number } {
  const d1 = Math.max(1, Math.floor(rate / (16 * bwHz)));
  const r1 = rate / d1;
  const d2 = Math.max(1, Math.floor(r1 / (4 * bwHz)));
  const taps = Math.max(15, Math.min(MAX_TAPS, Math.round(6 * r1 / bwHz) | 1));
  return { d1, d2, outRate: r1 / d2, taps };
}

export class ZeroSpan {
  readonly outRate: number;
  readonly window: number;
  private readonly d1: number;
  private readonly d2: number;
  private readonly h: Float32Array;
  // NCO
  private cr = 1; private ci = 0;
  private readonly wr: number; private readonly wi: number;
  private ncoCount = 0;
  // boxcar
  private accI = 0; private accQ = 0; private accN = 0;
  // FIR history (doubled so a window is one straight run)
  private readonly hi: Float32Array; private readonly hq: Float32Array;
  private hpos = 0; private d2Count = 0;
  /** FIR inputs still to come before its history is full (its first outputs are a start-up transient). */
  private warm: number;
  // output ring
  private readonly cap: number;
  private readonly rAmp: Float32Array; private readonly rFm: Float32Array; private readonly rPh: Float32Array;
  /** Output samples produced so far (absolute index). */
  count = 0;
  private prevI = 0; private prevQ = 0;
  // trigger state
  private armed = true;
  private trigAt = -1;
  private nextAllowed = 0;
  private above = false;
  private lastRoll = 0;
  /** True once a SINGLE capture has been taken (until rearm); already true when that capture is handed out. */
  done = false;

  constructor(readonly rate: number, public cfg: ZsConfig, private readonly onCapture: (c: ZsCapture) => void) {
    const p = zsPlan(rate, cfg.bwHz);
    this.d1 = p.d1; this.d2 = p.d2; this.outRate = p.outRate;
    this.h = designLowpass((cfg.bwHz / 2) / (rate / p.d1), p.taps);
    const t = this.h.length;
    this.hi = new Float32Array(2 * t); this.hq = new Float32Array(2 * t);
    this.warm = t + 1;
    const a = -2 * Math.PI * cfg.offsetHz / rate;
    this.wr = Math.cos(a); this.wi = Math.sin(a);
    this.window = Math.max(16, Math.min(ZS_MAX_POINTS, Math.round(cfg.sweepSec * this.outRate)));
    this.cap = 2 * this.window + 1024;
    this.rAmp = new Float32Array(this.cap); this.rFm = new Float32Array(this.cap); this.rPh = new Float32Array(this.cap);
  }

  /** The sweep time the window actually covers (it is capped at ZS_MAX_POINTS). */
  get sweepSec(): number { return this.window / this.outRate; }

  /** Arm again (after a SINGLE, or to drop a capture in progress). */
  rearm(): void { this.armed = true; this.done = false; this.trigAt = -1; this.nextAllowed = this.count; }

  /** Signed-int8 IQ. */
  push(iq: Int8Array): void {
    const n = iq.length >> 1;
    for (let k = 0; k < n; k++) this.sample(iq[2 * k], iq[2 * k + 1]);
  }
  /** Float IQ in int8 counts (the tests). */
  pushFloat(i: Float32Array, q: Float32Array): void { for (let k = 0; k < i.length; k++) this.sample(i[k], q[k]); }

  private sample(x: number, y: number): void {
    // mix the channel down to 0 Hz
    const mi = x * this.cr - y * this.ci, mq = x * this.ci + y * this.cr;
    const nr = this.cr * this.wr - this.ci * this.wi; this.ci = this.cr * this.wi + this.ci * this.wr; this.cr = nr;
    if (++this.ncoCount === 4096) { this.ncoCount = 0; const m = Math.hypot(this.cr, this.ci); this.cr /= m; this.ci /= m; }
    // boxcar
    this.accI += mi; this.accQ += mq;
    if (++this.accN < this.d1) return;
    const bi = this.accI / this.d1, bq = this.accQ / this.d1;
    this.accI = 0; this.accQ = 0; this.accN = 0;
    // FIR history
    const t = this.h.length;
    this.hi[this.hpos] = bi; this.hi[this.hpos + t] = bi;
    this.hq[this.hpos] = bq; this.hq[this.hpos + t] = bq;
    this.hpos = (this.hpos + 1) % t;
    if (this.warm > 0) { this.warm--; if (this.warm > 0) return; }
    if (++this.d2Count < this.d2) return;
    this.d2Count = 0;
    let si = 0, sq = 0;
    const h = this.h, base = this.hpos;   // oldest sample first
    for (let j = 0; j < t; j++) { si += h[j] * this.hi[base + j]; sq += h[j] * this.hq[base + j]; }
    this.out(si, sq);
  }

  private out(i: number, q: number): void {
    const p = (i * i + q * q) / (128 * 128);
    const amp = 10 * Math.log10(p + 1e-20);
    // instantaneous frequency: the phase step from the last sample
    const dr = i * this.prevI + q * this.prevQ, di = q * this.prevI - i * this.prevQ;
    const fm = Math.atan2(di, dr) * this.outRate / (2 * Math.PI);
    const ph = Math.atan2(q, i) * 180 / Math.PI;
    this.prevI = i; this.prevQ = q;
    const at = this.count % this.cap;
    this.rAmp[at] = amp; this.rFm[at] = fm; this.rPh[at] = ph;
    this.count++;
    this.trigger(amp);
  }

  private trigger(amp: number): void {
    const c = this.cfg, now = this.count;
    // the level crossing, with hysteresis
    const wasAbove = this.above;
    if (amp >= c.levelDb + TRIG_HYST_DB / 2) this.above = true;
    else if (amp < c.levelDb - TRIG_HYST_DB / 2) this.above = false;
    // at most 20 screens a second (in signal time, which is wall time when live)
    const gap = Math.max(1, Math.round(this.outRate * 0.05));
    if (c.trigger === 'FREE') {
      if (now - this.lastRoll >= gap || now === this.window) {
        this.lastRoll = now;
        const len = Math.min(now, this.window);
        this.emit(now - len, len, -1, true);
      }
      return;
    }
    const pre = Math.round(Math.max(0, Math.min(0.9, c.pre)) * this.window);
    if (this.trigAt < 0) {
      if (!this.armed || this.done) return;
      // while it waits, a dimmed look at the channel now and then, so the level can be set against what is there
      if (now - this.lastRoll >= 4 * gap) { this.lastRoll = now; const len = Math.min(now, this.window); this.emit(now - len, len, -1, true, true); }
      if (now < this.nextAllowed) return;
      const crossed = c.trigger === 'RISE' ? (!wasAbove && this.above) : (wasAbove && !this.above);
      if (!crossed || now - 1 < pre) return;
      this.trigAt = now - 1;
    }
    if (now - this.trigAt >= this.window - pre) {
      // a SINGLE is done before its capture goes out, so the capture says so
      if (c.single) { this.done = true; this.armed = false; }
      const at = this.trigAt;
      this.nextAllowed = at + (this.window - pre) + gap;
      this.trigAt = -1;
      this.emit(at - pre, this.window, pre, false);
    }
  }

  private emit(start: number, len: number, trig: number, roll: boolean, preview = false): void {
    const k = Math.max(1, Math.ceil(len / ZS_SHOW_POINTS));
    const m = Math.ceil(len / k);
    const amp = new Float32Array(m), fm = new Float32Array(m), ph = new Float32Array(m);
    for (let o = 0; o < m; o++) {
      // amplitude peak-held across the points folded together; frequency and phase sampled
      let a = -Infinity;
      const j0 = start + o * k;
      for (let j = j0; j < Math.min(start + len, j0 + k); j++) { const v = this.rAmp[j % this.cap]; if (v > a) a = v; }
      amp[o] = a; fm[o] = this.rFm[j0 % this.cap]; ph[o] = this.rPh[j0 % this.cap];
    }
    this.onCapture({ amp, fm, ph, rate: this.outRate / k, trig: trig < 0 ? -1 : Math.round(trig / k), roll, preview });
  }
}
