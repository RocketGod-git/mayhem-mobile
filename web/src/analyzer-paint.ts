/**
 * Drawing one burst for the Analyzer: the trace in any of its views with the sliced line, every bit, the frames, the
 * symbol clock, the A/B cursors and the crosshair; the overview strip above it; the time axis under it; the eye and
 * the constellation; the pulse-length histogram with its class thresholds. Pure drawing: the screen (analyzer-ui.ts)
 * owns the state and hands it over as a `TraceCtx`. Twin of the Android ui/AnalyzerPaint.kt and the iPad/Mac
 * App/ui/AnalyzerPaint.swift.
 */

import { fft, hann } from './fft.js';
import { FM_SCALE, histogram, type Analysis } from './dsp/analyzer/demod.js';
import { edgesOf, eyeStarts, type PulseTable } from './dsp/analyzer/measure.js';
import type { Burst } from './dsp/analyzer/capture.js';

export type View = 'amp' | 'freq' | 'iq' | 'spec' | 'eye' | 'const';

export interface TraceCtx {
  b: Burst;
  a: Analysis;
  view: View;
  /** The visible window, samples. */
  a0: number; a1: number;
  /** Vertical zoom for this view: 1 fits the visible data, 2 shows half the range, and so on. */
  yz: number;
  pick: [number, number] | null;
  /** The bits lit by the pointer: frame, first bit, one past the last. */
  hl: { f: number; b0: number; b1: number } | null;
  cursors: [number | null, number | null];
  /** The pointer over the trace, canvas pixels, or null. */
  hover: { x: number; y: number } | null;
  showDur: boolean;
  showClock: boolean;
  samplesAxis: boolean;
  /** Samples well inside the carrier (see `innerMask`), for the frequency view's gating. */
  inner: Uint8Array;
  pulses: PulseTable | null;
}

/** Where the bands of the trace canvas sit, device pixels. */
export interface Layout { W: number; H: number; dpr: number; top: number; plotH: number; digY: number; digH: number; bitY: number; bitH: number; axisY: number }

export function layoutOf(cv: HTMLCanvasElement): Layout {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(200, Math.round(cv.clientWidth * dpr)), H = Math.round((cv.clientHeight || 280) * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const top = 16 * dpr, digH = 18 * dpr, bitH = 18 * dpr, axisH = 20 * dpr;
  const plotH = H - top - digH - bitH - axisH - 4 * dpr;
  return { W, H, dpr, top, plotH, digY: top + plotH, digH, bitY: top + plotH + digH + 2 * dpr, bitH, axisY: H - axisH };
}

/** Samples on a carrier and at least `w` samples from either of its edges: where the discriminator means something. */
export function innerMask(n: number, on: Uint8Array, w = 8): Uint8Array {
  const out = new Uint8Array(n);
  let run = 0;
  for (let i = 0; i < n; i++) { run = on[i] ? run + 1 : 0; if (run > 2 * w) out[i - w] = 1; }
  return out;
}

interface Colors { ink: string; accent: string; accent2: string; muted: string; paper: string; ok: string }
function colors(cv: HTMLElement): Colors {
  const css = getComputedStyle(cv);
  const v = (k: string, d: string) => css.getPropertyValue(k).trim() || d;
  return { ink: v('--ink', '#e8ecf4'), accent: v('--accent', '#4c8dff'), accent2: v('--accent2', '#ffaf00'), muted: v('--muted', '#8d97ab'), paper: v('--paper', '#0a0d13'), ok: v('--ok', '#3fd07a') };
}

export const toKhz = (v: number, rate: number) => v / FM_SCALE * rate / (2 * Math.PI) / 1e3;
const dbfs = (v: number) => 20 * Math.log10(Math.max(1, v) / 16384);

/** A readable time: µs, ms or s, with as many decimals as the step between ticks needs. */
export function fmtTime(sec: number, step = 0): string {
  const a = Math.abs(sec), d = (v: number, s: number) => v.toFixed(Math.max(0, Math.min(6, s > 0 ? -Math.floor(Math.log10(s)) : 3)));
  if (a < 1e-3) return `${d(sec * 1e6, step * 1e6)} µs`;
  if (a < 1) return `${d(sec * 1e3, step * 1e3)} ms`;
  return `${d(sec, step)} s`;
}

/** The value under sample `i` in a view, in words. */
export function valueAt(view: View, b: Burst, i: number): string {
  if (i < 0 || i >= b.n) return '—';
  if (view === 'freq') return `${toKhz(b.fm[i], b.rate).toFixed(1)} kHz`;
  if (view === 'iq' || view === 'const') return `I ${b.iq[2 * i]} Q ${b.iq[2 * i + 1]}`;
  return `${dbfs(b.env[i]).toFixed(1)} dBFS`;
}

/** Ticks for an axis over [t0, t1) seconds across `px` pixels: a 1/2/5 step at least `minPx` apart. */
export function ticks(t0: number, t1: number, px: number, minPx: number): { step: number; at: number[] } {
  const span = Math.max(1e-12, t1 - t0), raw = span / Math.max(1, px / minPx);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map(m => m * p).find(s => s >= raw) ?? 10 * p;
  const at: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) at.push(t);
  return { step, at };
}

const rgb = (c: string): [number, number, number] => {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (m) { const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255]; }
  const r = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/.exec(c);
  return r ? [+r[1], +r[2], +r[3]] : [0, 0, 0];
};
export const alpha = (c: string, a: number) => { const [r, g, b] = rgb(c); return `rgba(${r},${g},${b},${a})`; };
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The range a view's trace is drawn over: fitted to the visible data, then narrowed by the vertical zoom. */
function rangeOf(c: TraceCtx, sig: Int16Array, gate: Uint8Array | null): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = c.a0; i < c.a1; i++) { if (gate && !gate[i]) continue; const v = sig[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (lo === Infinity) { lo = -1; hi = 1; }
  if (c.view === 'freq') { const m = Math.max(Math.abs(lo), Math.abs(hi), 1) / c.yz; return [-m, m]; }
  return [0, Math.max(1, hi) / c.yz];
}

/** The whole trace canvas. */
export function paintTrace(cv: HTMLCanvasElement, c: TraceCtx): Layout {
  const L = layoutOf(cv), { W, H, dpr, top, plotH } = L;
  const g = cv.getContext('2d')!, k = colors(cv), { b, a, a0, a1 } = c;
  g.fillStyle = k.paper; g.fillRect(0, 0, W, H);
  const len = Math.max(1, a1 - a0), xOf = (i: number) => (i - a0) / len * W;
  const font = (px: number, bold = false) => `${bold ? 'bold ' : ''}${px * dpr}px ui-monospace, Menlo, Consolas, monospace`;
  // the eye and the constellation are not drawn against time: they take the whole canvas, with nothing timed over them
  if (c.view === 'eye' || c.view === 'const') {
    const full: Layout = { ...L, top: 6 * dpr, plotH: H - 12 * dpr };
    if (c.view === 'eye') paintEye(g, c, full, k); else paintConst(g, c, full, k);
    return L;
  }

  // frames shaded and labeled F1..Fn
  g.font = font(10, true); g.textBaseline = 'top';
  a.frames.forEach((f, i) => {
    const x0 = xOf(f.start), x1 = xOf(f.end);
    if (x1 < 0 || x0 > W) return;
    g.fillStyle = alpha(k.accent, 0.07); g.fillRect(x0, top, Math.max(1, x1 - x0), plotH + L.digH);
    g.fillStyle = alpha(k.accent, 0.9); g.fillText(`F${i + 1}`, Math.max(2 * dpr, x0 + 2 * dpr), 2 * dpr);
  });

  if (c.view === 'spec') paintSpec(g, c, L, k);
  else if (c.view === 'iq') {
    const m = 128 / c.yz, yOf = (v: number) => top + plotH / 2 - v / m * plotH / 2;
    g.strokeStyle = alpha(k.muted, 0.4); g.lineWidth = 1; g.beginPath(); g.moveTo(0, yOf(0)); g.lineTo(W, yOf(0)); g.stroke();
    for (const [ch, col] of [[0, k.accent], [1, k.accent2]] as [number, string][]) {
      g.strokeStyle = col; g.globalAlpha = 0.85; g.lineWidth = Math.max(1, dpr);
      trace(g, W, len, a0, b.n, i => b.iq[2 * i + ch], yOf, null);
      g.globalAlpha = 1;
    }
    g.font = font(10); g.textBaseline = 'top'; g.fillStyle = k.accent; g.fillText('I', 4 * dpr, top + 2 * dpr); g.fillStyle = k.accent2; g.fillText('Q', 14 * dpr, top + 2 * dpr);
  } else {
    const sig = c.view === 'amp' ? b.env : b.fm, gate = c.view === 'freq' ? c.inner : null;
    const [lo, hi] = rangeOf(c, sig, gate);
    const yOf = (v: number) => top + plotH - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * plotH;
    if (c.view === 'freq') { g.strokeStyle = alpha(k.muted, 0.4); g.lineWidth = 1; g.beginPath(); g.moveTo(0, yOf(0)); g.lineTo(W, yOf(0)); g.stroke(); }
    g.lineWidth = Math.max(1, dpr);
    if (gate) {
      // off the carrier (OOK gaps, keying edges) the discriminator is noise: drawn, but faint
      g.strokeStyle = alpha(k.accent, 0.18); trace(g, W, len, a0, b.n, i => sig[i], yOf, i => !gate[i]);
      g.strokeStyle = k.accent; trace(g, W, len, a0, b.n, i => sig[i], yOf, i => !!gate[i]);
    } else { g.strokeStyle = k.accent; trace(g, W, len, a0, b.n, i => sig[i], yOf, null); }
    const sliced = (c.view === 'freq') === (a.mod === 'FSK');
    if (sliced && a.runs.length) { g.strokeStyle = k.accent2; g.setLineDash([6 * dpr, 4 * dpr]); g.beginPath(); g.moveTo(0, yOf(a.cut)); g.lineTo(W, yOf(a.cut)); g.stroke(); g.setLineDash([]); }
    g.fillStyle = k.muted; g.font = font(10); g.textBaseline = 'top';
    const note = c.view === 'freq' ? `±${toKhz(hi, b.rate).toFixed(1)} kHz` : `${dbfs(hi).toFixed(0)} dBFS top`;
    g.fillText(`${note}${c.yz > 1 ? ` · Y ×${c.yz}` : ''}`, W - g.measureText(note).width - (c.yz > 1 ? 60 : 6) * dpr, top + 2 * dpr);
  }

  // the symbol clock: a faint tick at every symbol from each frame's start
  const u = a.symUs * b.rate / 1e6;
  if (c.showClock && u > 0 && W / len * u >= 4) {
    g.strokeStyle = alpha(k.ok, 0.35); g.lineWidth = 1;
    g.beginPath();
    for (const f of a.frames) {
      const s0 = f.spans.length ? f.spans[0] : f.start;
      for (let t = s0; t <= f.end; t += u) { const x = xOf(t); if (x < 0 || x > W) continue; g.moveTo(x, top); g.lineTo(x, L.digY + L.digH); }
    }
    g.stroke();
  }

  // the sliced line, and every mark and gap's length written in when there is room
  const y0 = L.digY + L.digH - 3 * dpr, y1 = L.digY + 4 * dpr;
  g.strokeStyle = k.ink; g.lineWidth = Math.max(1, dpr);
  g.beginPath();
  let pos = a.from, lvl = false;
  g.moveTo(0, y0);
  for (const r of a.runs) {
    const x0 = xOf(pos), x1 = xOf(pos + r.n);
    if (x1 >= 0 && x0 <= W) { const y = r.hi ? y1 : y0; if (r.hi !== lvl) g.lineTo(Math.max(0, x0), y); g.lineTo(Math.min(W, x1), y); }
    lvl = r.hi; pos += r.n;
  }
  g.stroke();
  // lengths are measured edge to edge at the halfway level (edgesOf), as the pulse table measures them
  const edges = edgesOf(a, b.env);
  if (c.showDur) {
    g.font = font(9); g.textAlign = 'center'; g.textBaseline = 'middle';
    pos = a.from;
    for (let ri = 0; ri < a.runs.length; ri++) {
      const r = a.runs[ri];
      const x0 = xOf(pos), x1 = xOf(pos + r.n);
      if (x1 - x0 >= 34 * dpr && x1 > 0 && x0 < W) {
        const t = `${((edges[ri + 1] - edges[ri]) / b.rate * 1e6).toFixed(0)}`;
        g.fillStyle = k.paper; const tw = g.measureText(t).width; g.fillRect((x0 + x1) / 2 - tw / 2 - 2, L.digY + L.digH / 2 - 6 * dpr, tw + 4, 12 * dpr);
        g.fillStyle = r.hi ? k.ok : k.accent2; g.fillText(t, (x0 + x1) / 2, L.digY + L.digH / 2);
      }
      pos += r.n;
    }
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }

  // the bits: each one's span as a cell, its value written in when there is room, the lit ones highlighted
  g.font = font(11); g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let fi = 0; fi < a.frames.length; fi++) {
    const f = a.frames[fi], s = f.spans;
    if (!s.length || xOf(s[s.length - 1]) < 0 || xOf(s[0]) > W) continue;
    const per = (xOf(s[s.length - 1]) - xOf(s[0])) / Math.max(1, f.bits.length);
    for (let q = 0; q < f.bits.length; q++) {
      const x0 = xOf(s[2 * q]), x1 = xOf(s[2 * q + 1]);
      if (x1 < 0 || x0 > W) continue;
      const lit = c.hl && c.hl.f === fi && q >= c.hl.b0 && q < c.hl.b1;
      if (lit) { g.fillStyle = alpha(k.accent2, 0.85); g.fillRect(x0, L.bitY, Math.max(1, x1 - x0), L.bitH); g.fillStyle = alpha(k.accent2, 0.14); g.fillRect(x0, top, Math.max(1, x1 - x0), L.bitY - top); }
      else if (q % 2) { g.fillStyle = alpha(k.muted, 0.12); g.fillRect(x0, L.bitY, Math.max(1, x1 - x0), L.bitH); }
      if (per >= 3) { g.fillStyle = alpha(k.muted, 0.5); g.fillRect(x0, L.bitY, 1, L.bitH); }
      if (per >= 7 * dpr) { g.fillStyle = lit ? k.paper : f.bits[q] === '1' ? k.ink : k.muted; g.fillText(f.bits[q], (x0 + x1) / 2, L.bitY + L.bitH / 2); }
    }
  }
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';

  // the selection
  if (c.pick) {
    const x0 = xOf(c.pick[0]), x1 = xOf(c.pick[1]);
    g.fillStyle = alpha(k.accent2, 0.16); g.fillRect(x0, top, x1 - x0, L.axisY - top);
    g.strokeStyle = k.accent2; g.lineWidth = dpr; g.strokeRect(x0 + 0.5, top + 0.5, x1 - x0 - 1, L.axisY - top - 1);
  }
  paintAxis(g, c, L, k);

  // cursors A and B
  c.cursors.forEach((s, i) => {
    if (s === null) return;
    const x = xOf(s);
    if (x < -2 || x > W + 2) return;
    g.strokeStyle = i ? k.ok : k.accent2; g.lineWidth = 1.5 * dpr;
    g.beginPath(); g.moveTo(x, top); g.lineTo(x, L.axisY); g.stroke();
    g.fillStyle = i ? k.ok : k.accent2; g.font = font(11, true); g.textBaseline = 'top';
    g.fillRect(x - 7 * dpr, top, 14 * dpr, 14 * dpr); g.fillStyle = k.paper; g.textAlign = 'center'; g.fillText(i ? 'B' : 'A', x, top + 2 * dpr); g.textAlign = 'left';
  });

  // the crosshair, with the time and value under it; near an edge in the sliced row, the runs either side of it
  if (c.hover) {
    const { x, y } = c.hover, i = Math.round(a0 + x / W * len);
    g.strokeStyle = alpha(k.ink, 0.45); g.lineWidth = 1; g.setLineDash([3 * dpr, 3 * dpr]);
    g.beginPath(); g.moveTo(x, top); g.lineTo(x, L.axisY); if (y > top && y < top + plotH) { g.moveTo(0, y); g.lineTo(W, y); } g.stroke(); g.setLineDash([]);
    let text = `${c.samplesAxis ? `#${i}` : fmtTime(i / b.rate, len / b.rate / 1000)} · ${c.view === 'spec' ? `${((top + plotH / 2 - y) / plotH * b.rate / 1e3).toFixed(1)} kHz` : valueAt(c.view, b, i)}`;
    if (y >= L.digY && y < L.bitY + L.bitH) {
      const e = edgeNear(a, x, xOf, 6 * dpr);
      if (e) { const us = (k: number) => ((edges[k + 1] - edges[k]) / b.rate * 1e6).toFixed(0); text = `${e.before.hi ? 'mark' : 'gap'} ${us(e.k)} µs | ${e.after.hi ? 'mark' : 'gap'} ${us(e.k + 1)} µs`; }
    }
    g.font = font(11, true); g.textBaseline = 'top';
    const tw = g.measureText(text).width, tx = Math.min(W - tw - 8 * dpr, x + 8 * dpr), ty = Math.max(top, Math.min(L.axisY - 18 * dpr, y + 10 * dpr));
    g.fillStyle = 'rgba(0,0,0,0.75)'; g.fillRect(tx - 4 * dpr, ty - 2 * dpr, tw + 8 * dpr, 16 * dpr);
    g.fillStyle = k.ink; g.fillText(text, tx, ty);
  }
  return L;
}

/** One sample a pixel or finer: join the samples; coarser: each pixel's min to max. `keep` picks which samples draw. */
function trace(g: CanvasRenderingContext2D, W: number, len: number, a0: number, n: number, v: (i: number) => number, yOf: (v: number) => number, keep: ((i: number) => boolean) | null): void {
  g.beginPath();
  if (len < W) {
    let pen = false;
    for (let i = a0; i <= a0 + len && i < n; i++) {
      if (keep && !keep(i)) { pen = false; continue; }
      const x = (i + 0.5 - a0) / len * W, y = yOf(v(i));
      if (pen) g.lineTo(x, y); else g.moveTo(x, y);
      pen = true;
    }
  } else {
    for (let x = 0; x < W; x++) {
      const i0 = a0 + Math.floor(x * len / W), i1 = Math.max(i0 + 1, a0 + Math.floor((x + 1) * len / W));
      let mn = Infinity, mx = -Infinity;
      for (let i = i0; i < i1 && i < n; i++) { if (keep && !keep(i)) continue; const q = v(i); if (q < mn) mn = q; if (q > mx) mx = q; }
      if (mn === Infinity) continue;
      g.moveTo(x + 0.5, yOf(mx)); g.lineTo(x + 0.5, yOf(mn) + 0.5);
    }
  }
  g.stroke();
}

/** The edge in the sliced line nearest pixel `x` (within `tol`), with the runs either side. */
export function edgeNear(a: Analysis, x: number, xOf: (i: number) => number, tol: number): { at: number; k: number; before: { hi: boolean; n: number }; after: { hi: boolean; n: number } } | null {
  let pos = a.from, best: { at: number; k: number; before: { hi: boolean; n: number }; after: { hi: boolean; n: number } } | null = null, bestD = tol;
  for (let i = 0; i + 1 < a.runs.length; i++) {
    pos += a.runs[i].n;
    const d = Math.abs(xOf(pos) - x);
    if (d <= bestD) { bestD = d; best = { at: pos, k: i, before: a.runs[i], after: a.runs[i + 1] }; }
  }
  return best;
}

function paintAxis(g: CanvasRenderingContext2D, c: TraceCtx, L: Layout, k: Colors): void {
  const { W, dpr, axisY } = L, { b, a0, a1 } = c, len = Math.max(1, a1 - a0);
  g.fillStyle = alpha(k.paper, 1); g.fillRect(0, axisY, W, L.H - axisY);
  g.strokeStyle = alpha(k.muted, 0.5); g.lineWidth = 1; g.beginPath(); g.moveTo(0, axisY + 0.5); g.lineTo(W, axisY + 0.5); g.stroke();
  g.font = `${10 * dpr}px ui-monospace, Menlo, Consolas, monospace`; g.fillStyle = k.muted; g.textBaseline = 'top';
  if (c.samplesAxis) {
    const t = ticks(a0, a1, W, 90 * dpr);
    for (const s of t.at) { const x = (s - a0) / len * W; g.fillRect(x, axisY, 1, 5 * dpr); g.fillText(`${Math.round(s)}`, x + 3 * dpr, axisY + 5 * dpr); }
  } else {
    const t = ticks(a0 / b.rate, a1 / b.rate, W, 90 * dpr);
    for (const s of t.at) { const x = (s * b.rate - a0) / len * W; g.fillRect(x, axisY, 1, 5 * dpr); g.fillText(fmtTime(s, t.step), x + 3 * dpr, axisY + 5 * dpr); }
  }
}

function paintSpec(g: CanvasRenderingContext2D, c: TraceCtx, L: Layout, k: Colors): void {
  const { b, a, a0, a1 } = c, { W, top, plotH: h, dpr } = L;
  const N = 64, win = hann(N), re = new Float32Array(N), im = new Float32Array(N);
  const cols = Math.min(W, Math.max(1, Math.floor((a1 - a0) / 2)));
  const img = g.createImageData(cols, N);
  const mags: Float32Array[] = [];
  let peak = 1e-9;
  for (let col = 0; col < cols; col++) {
    const mid = a0 + Math.round((col + 0.5) * (a1 - a0) / cols);
    for (let q = 0; q < N; q++) { const i = Math.max(0, Math.min(b.n - 1, mid - N / 2 + q)); re[q] = b.iq[2 * i] * win[q]; im[q] = b.iq[2 * i + 1] * win[q]; }
    fft(re, im);
    const m = new Float32Array(N);
    for (let q = 0; q < N; q++) { const v = re[q] * re[q] + im[q] * im[q]; m[q] = v; if (v > peak) peak = v; }
    mags.push(m);
  }
  const lo = rgb(k.paper), mid = rgb(k.accent), hi = rgb(k.accent2);
  for (let col = 0; col < cols; col++) for (let q = 0; q < N; q++) {
    const bin = (q + N / 2) % N;
    const db = 10 * Math.log10(mags[col][bin] / peak + 1e-12);
    const t = Math.pow(Math.max(0, Math.min(1, (db + 45) / 45)), 1.6);
    const [r, gg, bb] = t < 0.6 ? mix(lo, mid, t / 0.6) : mix(mid, hi, (t - 0.6) / 0.4);
    const p = ((N - 1 - q) * cols + col) * 4;
    img.data[p] = r; img.data[p + 1] = gg; img.data[p + 2] = bb; img.data[p + 3] = 255;
  }
  const tmp = document.createElement('canvas'); tmp.width = cols; tmp.height = N;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(tmp, 0, top, W, h);
  g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = `${10 * dpr}px ui-monospace, monospace`; g.textBaseline = 'top';
  g.fillText(`+${(b.rate / 2e3).toFixed(0)} kHz`, 4 * dpr, top + 2 * dpr); g.textBaseline = 'bottom'; g.fillText(`−${(b.rate / 2e3).toFixed(0)} kHz`, 4 * dpr, top + h - 2 * dpr);
  if (a.mod === 'FSK') {
    g.textBaseline = 'bottom';
    for (const v of [a.lo, a.hi]) { const hz = toKhz(v, b.rate) * 1e3, y = top + h / 2 - hz / b.rate * h; g.fillStyle = k.accent2; g.fillRect(W - 10 * dpr, y - dpr, 10 * dpr, 2 * dpr); g.fillText(`${(hz / 1e3).toFixed(1)} kHz`, W - 76 * dpr, y - 2 * dpr); }
  }
}

/** The eye: two symbols of the sliced signal at every clock tick, laid over each other. */
function paintEye(g: CanvasRenderingContext2D, c: TraceCtx, L: Layout, k: Colors): void {
  const { b, a } = c, { W, top, plotH: h, dpr } = L;
  const sig = a.mod === 'FSK' ? b.fm : b.env;
  const e = eyeStarts(a, b.rate);
  // FSK: both tones with room around them; OOK and ASK: from nothing to a quarter over the mark level
  const mid = (a.hi + a.lo) / 2, span = Math.abs(a.hi - a.lo) * 0.8 / c.yz;
  const lo = a.mod === 'FSK' ? mid - span : 0, hi = a.mod === 'FSK' ? mid + span : Math.max(a.hi, a.cut * 2) * 1.25 / c.yz;
  const yOf = (v: number) => top + h - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo || 1) * h;
  g.strokeStyle = alpha(k.accent, Math.max(0.04, Math.min(0.3, 12 / Math.max(1, e.starts.length)))); g.lineWidth = Math.max(1, dpr);
  const step = Math.max(1, Math.floor(e.starts.length / 600));
  for (let s = 0; s < e.starts.length; s += step) {
    const s0 = e.starts[s];
    g.beginPath();
    for (let q = 0; q <= e.len; q++) { const i = s0 + q; if (i < 0 || i >= b.n) continue; const x = q / e.len * W, y = yOf(sig[i]); if (q === 0) g.moveTo(x, y); else g.lineTo(x, y); }
    g.stroke();
  }
  g.strokeStyle = k.accent2; g.setLineDash([6 * dpr, 4 * dpr]); g.beginPath(); g.moveTo(0, yOf(a.cut)); g.lineTo(W, yOf(a.cut)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = alpha(k.ok, 0.6); g.beginPath();
  for (const x of [W / 4, 3 * W / 4]) { g.moveTo(x, top); g.lineTo(x, top + h); }
  g.stroke();
  g.fillStyle = k.muted; g.font = `${10 * dpr}px ui-monospace, monospace`; g.textBaseline = 'top';
  g.fillText(`EYE · ${e.starts.length} symbols · ${a.symUs.toFixed(1)} µs · ticks at the symbol edges, the sample point between them`, 6 * dpr, top + 2 * dpr);
}

/** The I/Q samples in the visible window, plotted against each other. */
function paintConst(g: CanvasRenderingContext2D, c: TraceCtx, L: Layout, k: Colors): void {
  const { b, a0, a1 } = c, { W, top, plotH: h, dpr } = L;
  const side = Math.min(W, h), cx = W / 2, cy = top + h / 2, sc = side / 2 / 128 * c.yz;
  g.strokeStyle = alpha(k.muted, 0.4); g.lineWidth = 1; g.beginPath();
  g.moveTo(cx - side / 2, cy); g.lineTo(cx + side / 2, cy); g.moveTo(cx, cy - side / 2); g.lineTo(cx, cy + side / 2); g.stroke();
  g.strokeRect(cx - side / 2, cy - side / 2, side, side);
  const step = Math.max(1, Math.floor((a1 - a0) / 20000)), r = Math.max(1, dpr);
  for (const pass of [0, 1]) {
    g.fillStyle = pass ? alpha(k.accent, 0.35) : alpha(k.muted, 0.08);
    for (let i = a0; i < a1; i += step) {
      if (!!c.inner[i] !== !!pass) continue;
      const x = cx + b.iq[2 * i] * sc, y = cy - b.iq[2 * i + 1] * sc;
      if (Math.abs(x - cx) > side / 2 || Math.abs(y - cy) > side / 2) continue;
      g.fillRect(x, y, r, r);
    }
  }
  g.fillStyle = k.muted; g.font = `${10 * dpr}px ui-monospace, monospace`; g.textBaseline = 'top';
  g.fillText(`I/Q · ${Math.ceil((a1 - a0) / step)} points${c.yz > 1 ? ` · ×${c.yz}` : ''} · bright: on the carrier`, 6 * dpr, top + 2 * dpr);
}

/** The overview strip: the whole burst in miniature, the visible window boxed. */
export function paintMini(cv: HTMLCanvasElement, b: Burst, a0: number, a1: number, pick: [number, number] | null): void {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(100, Math.round(cv.clientWidth * dpr)), H = Math.round((cv.clientHeight || 30) * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d')!, k = colors(cv);
  g.fillStyle = k.paper; g.fillRect(0, 0, W, H);
  let peak = 1; for (let i = 0; i < b.n; i++) if (b.env[i] > peak) peak = b.env[i];
  g.strokeStyle = alpha(k.accent, 0.7); g.lineWidth = 1; g.beginPath();
  for (let x = 0; x < W; x++) {
    const i0 = Math.floor(x * b.n / W), i1 = Math.max(i0 + 1, Math.floor((x + 1) * b.n / W));
    let m = 0; for (let i = i0; i < i1; i++) if (b.env[i] > m) m = b.env[i];
    g.moveTo(x + 0.5, H - 1); g.lineTo(x + 0.5, H - 1 - m / peak * (H - 3));
  }
  g.stroke();
  if (pick) { g.fillStyle = alpha(k.accent2, 0.3); g.fillRect(pick[0] / b.n * W, 0, Math.max(1, (pick[1] - pick[0]) / b.n * W), H); }
  const x0 = a0 / b.n * W, x1 = a1 / b.n * W;
  g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 0, x0, H); g.fillRect(x1, 0, W - x1, H);
  g.strokeStyle = k.accent2; g.lineWidth = 2 * dpr; g.strokeRect(x0 + dpr, dpr, Math.max(4, x1 - x0 - 2 * dpr), H - 2 * dpr);
}

/** URH's pulse-length histogram: marks above the line, gaps below, the symbol multiples faint, each class threshold dashed and labeled. */
export function paintHistogram(cv: HTMLCanvasElement, a: Analysis, rate: number, t: PulseTable | null): void {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(200, Math.round(cv.clientWidth * dpr)), H = Math.round((cv.clientHeight || 110) * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d')!, k = colors(cv);
  g.fillStyle = k.paper; g.fillRect(0, 0, W, H);
  if (!a.runs.length) return;
  const h = histogram(a, rate);
  const n = h.marks.length, bw = W / n, mid = (H - 14 * dpr) / 2, max = Math.max(1, ...h.marks, ...h.spaces);
  const xUs = (us: number) => us / h.binUs * bw;
  g.strokeStyle = alpha(k.muted, 0.3); g.lineWidth = 1;
  for (let q = 1; q * a.symUs < h.binUs * n; q++) { const x = xUs(q * a.symUs); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H - 14 * dpr); g.stroke(); }
  for (let i = 0; i < n; i++) {
    const hm = h.marks[i] / max * (mid - 2), hs = h.spaces[i] / max * (mid - 2);
    g.fillStyle = k.ok; g.fillRect(i * bw + 1, mid - hm, Math.max(1, bw - 2), hm);
    g.fillStyle = k.accent2; g.fillRect(i * bw + 1, mid, Math.max(1, bw - 2), hs);
  }
  g.font = `${10 * dpr}px ui-monospace, monospace`; g.textBaseline = 'top';
  if (t) {
    g.setLineDash([4 * dpr, 3 * dpr]); g.lineWidth = 1.5 * dpr;
    for (const [cuts, col, y0, y1] of [[t.markCuts, k.ok, 0, mid], [t.spaceCuts, k.accent2, mid, H - 14 * dpr]] as [number[], string, number, number][]) {
      g.strokeStyle = col; g.fillStyle = col;
      for (const cu of cuts) { const x = xUs(cu); g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke(); g.fillText(`${cu.toFixed(0)}`, x + 3 * dpr, y0 + 2 * dpr); }
    }
    g.setLineDash([]);
  }
  g.fillStyle = k.muted;
  for (let q = 1; q * a.symUs < h.binUs * n && q <= 8; q++) g.fillText(`${(q * a.symUs).toFixed(0)}`, xUs(q * a.symUs) + 2 * dpr, H - 12 * dpr);
  g.fillText('µs', W - 16 * dpr, H - 12 * dpr);
}
