/**
 * Spectrum: the persistence (density) display. Every frame drops a hit in each column at each bin's level; old hits
 * fade by `decay` per frame, so where a signal spends its time glows brightest and a rare burst still shows.
 */
export class Persistence {
  readonly hits: Float32Array;
  constructor(readonly cols: number, readonly rows: number, public decay = 0.93) { this.hits = new Float32Array(cols * rows); }
  clear(): void { this.hits.fill(0); }
  /** Fold in a trace (dB per bin) drawn with `top` dB at row 0 and `range` dB over all the rows. */
  add(y: ArrayLike<number>, top: number, range: number): void {
    const h = this.hits, d = this.decay;
    for (let i = 0; i < h.length; i++) h[i] *= d;
    const n = y.length, c = this.cols, r = this.rows;
    for (let i = 0; i < n; i++) {
      const col = Math.min(c - 1, Math.floor(i * c / n));
      const row = Math.floor((top - y[i]) / range * r);
      if (row >= 0 && row < r) h[row * c + col] += 1;
    }
  }
  /** Each cell's brightness 0..1 (log scaled to the busiest cell). */
  level(out = new Float32Array(this.hits.length)): Float32Array {
    let m = 0;
    for (const v of this.hits) if (v > m) m = v;
    const k = m > 0 ? 1 / Math.log1p(m) : 0;
    for (let i = 0; i < this.hits.length; i++) out[i] = Math.log1p(this.hits[i]) * k;
    return out;
  }
}
