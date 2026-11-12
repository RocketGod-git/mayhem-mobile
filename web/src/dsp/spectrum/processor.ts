/**
 * Spectrum: the worker side. One FFT over the radio's span (FFT), a sweep of slices for spans wider than the radio
 * (SWEEP, stepped by the Looking Glass retune bookkeeping), or zero span (ZERO).
 *
 * Out: `spframe` { live, max, min (dBFS per bin), f0, binHz, rbw, n, frames, sweep, step, steps, passes } at most
 * about 30 times a second, and `zscap` { amp, fm, ph, rate, trig, roll } for zero span.
 */
import type { Emit, IqProcessor } from '../core.js';
import { Retuner } from '../sweep.js';
import { FftEngine, dcHalfWidth, patchDc, toDb } from './engine.js';
import { fftSizeFor, videoAlpha, windowGains, windowOf, type WindowKind } from './rbw.js';
import { ZeroSpan, type ZsConfig } from './zerospan.js';
import { fft } from '../../fft.js';

export interface SpecConfig {
  mode: 'FFT' | 'SWEEP' | 'ZERO';
  /** Where the radio is tuned (FFT, ZERO). */
  tuneHz: number;
  startHz: number;
  stopHz: number;
  rbwHz: number;
  window: WindowKind;
  vbwHz: number;
  dcPatch: boolean;
  /** SWEEP: the slice rate. */
  sliceRate: number;
  zs: ZsConfig;
}

/** Frames per second to the screen at most. */
const SHOW_HZ = 30;
/** A sweep row is never more than this many bins (a finer RBW over a very wide span is widened to fit). */
export const MAX_ROW_BINS = 262_144;
/** A sweep keeps the inner part of each slice: the same 408/512 the Looking Glass keeps. */
export const sweepKeep = (n: number) => 2 * Math.round(n * 204 / 512);

/** The FFT length a sweep uses for an RBW at a slice rate, widened until the row fits MAX_ROW_BINS. */
export function sweepFft(startHz: number, stopHz: number, sliceRate: number, rbwHz: number, kind: WindowKind): number {
  let n = Math.max(128, fftSizeFor(sliceRate, rbwHz, kind));
  while (n > 128 && Math.ceil((stopHz - startHz) / (sliceRate / n)) > MAX_ROW_BINS) n >>= 1;
  return n;
}

export class SpectrumProcessor implements IqProcessor {
  private fftE: FftEngine | null = null;
  private zs: ZeroSpan | null = null;
  private rate = 0;
  private sinceShow = 0;
  // sweep
  private readonly retune: Retuner;
  private sN = 0; private keep = 0; private k0 = 0; private steps = 0; private stepHz = 0; private binHz = 0;
  private row: Float32Array = new Float32Array(0);
  private lastAt: Float64Array = new Float64Array(0);
  private step = 0; private passes = 0; private clock = 0;
  private sw: { re: Float32Array; im: Float32Array; acc: Float32Array; w: Float32Array; norm: number; bi: Float32Array; bq: Float32Array; fill: number; frames: number; enbw: number } | null = null;

  constructor(public cfg: SpecConfig, private readonly emit: Emit) { this.retune = new Retuner(emit); }

  /** Settings that need no new engine (VBW, trigger) apply in place; anything else rebuilds on the next read. */
  set(cfg: SpecConfig): void {
    const old = this.cfg;
    this.cfg = cfg;
    if (cfg.mode === 'ZERO' && this.zs && old.mode === 'ZERO' && old.zs.bwHz === cfg.zs.bwHz && old.zs.offsetHz === cfg.zs.offsetHz && old.zs.sweepSec === cfg.zs.sweepSec) {
      this.zs.cfg = cfg.zs; return;
    }
    if (cfg.mode === 'FFT' && this.fftE && old.mode === 'FFT' && old.rbwHz === cfg.rbwHz && old.window === cfg.window && old.tuneHz === cfg.tuneHz && old.dcPatch === cfg.dcPatch) {
      this.fftE.vbwHz = cfg.vbwHz; return;
    }
    if (cfg.mode === 'SWEEP' && old.mode === 'SWEEP' && old.rbwHz === cfg.rbwHz && old.window === cfg.window && old.startHz === cfg.startHz && old.stopHz === cfg.stopHz) return;
    this.reset(this.rate);
  }
  /** Arm a zero-span SINGLE again. */
  rearm(): void { this.zs?.rearm(); }

  reset(rate: number): void {
    this.rate = rate; this.sinceShow = 0;
    this.fftE = null; this.zs = null; this.sw = null;
    const c = this.cfg;
    if (c.mode === 'FFT') this.fftE = new FftEngine(fftSizeFor(rate, c.rbwHz, c.window), c.window, rate, c.vbwHz, c.dcPatch);
    else if (c.mode === 'ZERO') this.zs = new ZeroSpan(rate, c.zs, cap => this.emit({ type: 'zscap', ...cap, sweepSec: this.zs?.sweepSec ?? 0, armed: !this.zs?.done }, [cap.amp.buffer, cap.fm.buffer, cap.ph.buffer]));
    else this.startSweep();
  }
  tuned(): void { this.retune.tuned(); }

  onIq(iq: Int8Array, rate: number): void {
    if (rate !== this.rate) this.reset(rate);
    const c = this.cfg;
    if (c.mode === 'ZERO') { this.zs?.push(iq); return; }
    if (c.mode === 'SWEEP') { this.sweepIq(iq, rate); return; }
    const e = this.fftE; if (!e) return;
    e.push(iq);
    this.sinceShow += iq.length >> 1;
    if (this.sinceShow < rate / SHOW_HZ || e.framesSince === 0) return;
    this.sinceShow = 0;
    // the bins inside [start, stop]
    const h = e.n >> 1, bin = e.binHz;
    const a = Math.max(0, Math.ceil((c.startHz - c.tuneHz) / bin + h)), b = Math.min(e.n - 1, Math.floor((c.stopHz - c.tuneHz) / bin + h));
    if (b < a) return;
    const t = e.take(a, b);
    this.emit({ type: 'spframe', ...t, f0: c.tuneHz + (a - h) * bin, binHz: bin, rbw: e.rbwHz, n: e.n, sweep: false, step: 0, steps: 1, passes: e.frames },
      [t.live.buffer, t.max.buffer, t.min.buffer]);
  }

  private startSweep(): void {
    const c = this.cfg;
    const n = this.sN = sweepFft(c.startHz, c.stopHz, c.sliceRate, c.rbwHz, c.window);
    this.keep = sweepKeep(n); this.k0 = (n >> 1) - (this.keep >> 1);
    this.binHz = c.sliceRate / n; this.stepHz = this.keep * this.binHz;
    this.steps = Math.max(1, Math.ceil((c.stopHz - c.startHz) / this.stepHz));
    const bins = Math.min(this.steps * this.keep, Math.ceil((c.stopHz - c.startHz) / this.binHz));
    this.row = new Float32Array(bins).fill(-200);
    this.lastAt = new Float64Array(this.steps).fill(-1);
    this.step = 0; this.passes = 0; this.clock = 0;
    const w = windowOf(c.window, n), g = windowGains(w);
    this.sw = { re: new Float32Array(n), im: new Float32Array(n), acc: new Float32Array(n), w, norm: 1 / ((128 * g.sum) ** 2), bi: new Float32Array(n), bq: new Float32Array(n), fill: 0, frames: 0, enbw: g.enbw };
    this.retune.start(this.centerOf(0));
  }
  /** The kept part of slice i covers [start + i·step, start + (i+1)·step). */
  private centerOf(i: number): number { return this.cfg.startHz + this.stepHz / 2 + i * this.stepHz; }

  private sweepIq(iq: Int8Array, rate: number): void {
    const s = this.sw; if (!s) return;
    const nSamp = iq.length >> 1;
    this.clock += nSamp;
    if (this.retune.stale()) return;
    const n = this.sN, h = n >> 1;
    // every whole frame in this read (and across reads, for an FFT longer than one), power-averaged
    for (let k = 0; k < nSamp;) {
      const take = Math.min(n - s.fill, nSamp - k);
      for (let j = 0; j < take; j++) { s.bi[s.fill + j] = iq[2 * (k + j)]; s.bq[s.fill + j] = iq[2 * (k + j) + 1]; }
      s.fill += take; k += take;
      if (s.fill === n) {
        for (let j = 0; j < n; j++) { s.re[j] = s.bi[j] * s.w[j]; s.im[j] = s.bq[j] * s.w[j]; }
        fft(s.re, s.im);
        for (let i = 0; i < n; i++) { const t = i < h ? i + h : i - h; s.acc[i] += (s.re[t] * s.re[t] + s.im[t] * s.im[t]) * s.norm; }
        s.fill = 0; s.frames++;
      }
    }
    if (s.frames === 0) return;   // an FFT longer than one read: keep collecting on this step
    for (let i = 0; i < n; i++) s.acc[i] /= s.frames;
    patchDc(s.acc, h, dcHalfWidth(this.cfg.window));
    // video filter across passes: each slice against what it read last pass
    const was = this.lastAt[this.step];
    const alpha = was < 0 ? 1 : videoAlpha(this.cfg.vbwHz, (this.clock - was) / rate);
    this.lastAt[this.step] = this.clock;
    const base = this.step * this.keep;
    for (let j = 0; j < this.keep && base + j < this.row.length; j++) {
      const p = s.acc[this.k0 + j];
      const old = this.row[base + j];
      const lin = alpha >= 1 || old <= -199 ? p : 10 ** (old / 10) + alpha * (p - 10 ** (old / 10));
      this.row[base + j] = toDb(lin);
    }
    s.acc.fill(0); s.frames = 0; s.fill = 0;
    this.step++;
    const wrapped = this.step >= this.steps;
    if (wrapped) { this.step = 0; this.passes++; }
    this.sinceShow += nSamp;
    if (wrapped || this.sinceShow >= rate / (SHOW_HZ / 3)) {
      this.sinceShow = 0;
      const live = this.row.slice();
      this.emit({ type: 'spframe', live, max: null, min: null, f0: this.cfg.startHz, binHz: this.binHz, rbw: s.enbw * this.binHz, n, frames: 1, sweep: true, step: wrapped ? this.steps : this.step, steps: this.steps, passes: this.passes }, [live.buffer]);
    }
    this.retune.next(this.centerOf(this.step), nSamp, rate);
  }
}

