/**
 * Spectrum: the four traces. Each one is fed every displayed frame and keeps it its own way: LIVE draws the frame,
 * MAX and MIN hold the highest and lowest value each bin has seen (from the engine's per-frame extremes, so nothing
 * between two drawn frames is missed), AVG power-averages the last N frames, VIEW freezes what is there and OFF hides
 * the trace. All values are in the display unit (dBm or dBFS); a change of bin layout starts a trace over.
 */

export type TraceMode = 'LIVE' | 'MAX' | 'MIN' | 'AVG' | 'VIEW' | 'OFF';
export const TRACE_MODES: TraceMode[] = ['LIVE', 'MAX', 'MIN', 'AVG', 'VIEW', 'OFF'];
export const TRACE_COUNT = 4;

export class Trace {
  data: Float32Array | null = null;
  private lin: Float32Array | null = null;
  /** Frames folded in since the trace was last cleared. */
  count = 0;
  /** The bin layout the data belongs to: first bin's frequency and spacing. */
  f0 = 0;
  binHz = 0;
  constructor(public mode: TraceMode, public avgN = 10) {}

  clear(): void { this.data = null; this.lin = null; this.count = 0; }
  setMode(m: TraceMode): void { if (m !== this.mode) { this.mode = m; if (m !== 'VIEW' && m !== 'OFF') this.clear(); } }

  /** Fold in one frame: `live` is the frame, `max` / `min` the highest and lowest values since the frame before. */
  update(live: Float32Array, max: Float32Array | null, min: Float32Array | null, f0: number, binHz: number): void {
    if (this.mode === 'VIEW' || this.mode === 'OFF') return;
    const n = live.length;
    if (!this.data || this.data.length !== n || Math.abs(f0 - this.f0) > binHz * 1e-3 || Math.abs(binHz - this.binHz) > binHz * 1e-6) {
      this.data = new Float32Array(n); this.lin = null; this.count = 0; this.f0 = f0; this.binHz = binHz;
    }
    const d = this.data;
    const hi = max ?? live, lo = min ?? live;
    switch (this.mode) {
      case 'LIVE': d.set(live); break;
      case 'MAX': if (this.count === 0) d.set(hi); else for (let i = 0; i < n; i++) if (hi[i] > d[i]) d[i] = hi[i]; break;
      case 'MIN': if (this.count === 0) d.set(lo); else for (let i = 0; i < n; i++) if (lo[i] < d[i]) d[i] = lo[i]; break;
      case 'AVG': {
        // a running mean while the first N frames come in, then an exponential average with weight 1/N (a bench
        // analyzer's trace average); in linear power so noise is not biased low
        const lin = this.lin ??= new Float32Array(n);
        const k = 1 / Math.min(this.count + 1, Math.max(1, this.avgN));
        for (let i = 0; i < n; i++) { const p = 10 ** (live[i] / 10); lin[i] += k * (p - lin[i]); d[i] = 10 * Math.log10(lin[i] + 1e-30); }
        break;
      }
    }
    this.count++;
  }
}

/** The default set: one live trace, a max hold, and two traces waiting. */
export function defaultTraces(): Trace[] {
  return [new Trace('LIVE'), new Trace('MAX'), new Trace('OFF'), new Trace('OFF')];
}

/**
 * Reduce a trace to `cols` display columns with a detector: PEAK keeps each column's highest bin (nothing narrow is
 * lost), SAMPLE its middle bin, RMS the power mean of its bins. With fewer bins than columns, each bin is repeated.
 */
export type Detector = 'PEAK' | 'SAMPLE' | 'RMS';
export const DETECTORS: Detector[] = ['PEAK', 'SAMPLE', 'RMS'];
export function toColumns(y: Float32Array, cols: number, det: Detector, out = new Float32Array(cols)): Float32Array {
  const n = y.length;
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * n / cols), b = Math.max(a + 1, Math.floor((c + 1) * n / cols));
    if (det === 'SAMPLE' || b - a === 1) { out[c] = y[Math.min(n - 1, (a + b - 1) >> 1)]; continue; }
    if (det === 'PEAK') { let m = -Infinity; for (let i = a; i < b; i++) if (y[i] > m) m = y[i]; out[c] = m; continue; }
    let s = 0; for (let i = a; i < b; i++) s += 10 ** (y[i] / 10);
    out[c] = 10 * Math.log10(s / (b - a) + 1e-30);
  }
  return out;
}
