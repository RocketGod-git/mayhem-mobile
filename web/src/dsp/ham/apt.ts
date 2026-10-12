/**
 * NOAA APT weather-image decoder on the NFM discriminator (137 MHz, ±17 kHz deviation): the picture is AM on a
 * 2400 Hz subcarrier at 4160 words per second, two 909-pixel channels per 2080-word line with a 1040 Hz "sync A"
 * square-wave burst at the start of each line. Envelope-detect the subcarrier, resample to the word rate, find the
 * sync burst, and hand out one gray line every half second (2 lines/s). Calibration is a slow running black/white.
 */
const RATE = 48_000, WORDS = 4160, LINE = 2080;
const SYNC_A = new Int8Array(39);
{ let k = 0; for (let i = 0; i < 4; i++) SYNC_A[k++] = -1; for (let c = 0; c < 7; c++) { SYNC_A[k++] = 1; SYNC_A[k++] = 1; SYNC_A[k++] = -1; SYNC_A[k++] = -1; } while (k < 39) SYNC_A[k++] = -1; }

export class AptDecoder {
  readonly minHalf = 20_000;
  onRow: (row: Uint8ClampedArray, line: number) => void = () => {};
  private cr = 1; private ci = 0; private readonly dr = Math.cos(-2 * Math.PI * 2400 / RATE); private readonly di = Math.sin(-2 * Math.PI * 2400 / RATE);
  private i1 = 0; private i2 = 0; private q1 = 0; private q2 = 0; private readonly a = 1 - Math.exp(-2 * Math.PI * 2600 / RATE);
  private ph = 0; private acc = 0; private accN = 0;
  private readonly words = new Float32Array(LINE * 8); private m = 0;
  private lineStart = -1; private lines = 0; private miss = 0;
  private lo = 0; private hi = 1; private calibrated = false;
  private readonly row = new Uint8ClampedArray(LINE);
  private tmp = new Float32Array(0);

  reset(): void { this.m = 0; this.lineStart = -1; this.lines = 0; this.miss = 0; this.calibrated = false; this.acc = 0; this.accN = 0; this.ph = 0; }

  onFm(samples: Float32Array, n: number, rate: number): void {
    if (rate !== RATE) return;
    const al = this.a, step = WORDS / RATE;
    for (let k = 0; k < n; k++) {
      const x = samples[k];
      const i = x * this.cr, q = x * this.ci;
      const nr = this.cr * this.dr - this.ci * this.di; this.ci = this.cr * this.di + this.ci * this.dr; this.cr = nr;
      this.i1 += al * (i - this.i1); this.i2 += al * (this.i1 - this.i2);
      this.q1 += al * (q - this.q1); this.q2 += al * (this.q1 - this.q2);
      this.acc += Math.sqrt(this.i2 * this.i2 + this.q2 * this.q2); this.accN++;
      this.ph += step;
      if (this.ph >= 1) { this.ph -= 1; this.word(this.acc / this.accN); this.acc = 0; this.accN = 0; }
    }
    if ((n & 0xfff) === 0) { const g = 1 / Math.hypot(this.cr, this.ci); this.cr *= g; this.ci *= g; }
  }

  private word(w: number): void {
    const words = this.words, len = words.length;
    words[this.m % len] = w; this.m++;
    const m = this.m;
    if (this.lineStart < 0) {                              // searching: a sync-A burst that repeats one line later
      if (m < LINE + 39) return;
      const c = this.corr(m - 39), cPrev = this.corr(m - 39 - LINE);
      if (c > 0.55 && cPrev > 0.4) { this.lineStart = m - 39; this.miss = 0; }
      return;
    }
    if (m < this.lineStart + LINE + 40) return;
    // a line is complete: re-time on the strongest sync within ±20 words of where the next one should be
    let best = this.lineStart + LINE, bestC = 0;
    for (let d = -20; d <= 20; d++) { const c = this.corr(this.lineStart + LINE + d); if (c > bestC) { bestC = c; best = this.lineStart + LINE + d; } }
    if (bestC < 0.35) { this.miss++; best = this.lineStart + LINE; if (this.miss > 6) { this.lineStart = -1; return; } } else this.miss = 0;
    this.emit(this.lineStart);
    this.lineStart = best;
  }

  /** Normalized correlation of the words starting at `at` with the sync-A template. */
  private corr(at: number): number {
    const words = this.words, len = words.length;
    if (at < this.m - len || at + 39 > this.m) return 0;
    let mean = 0; for (let k = 0; k < 39; k++) mean += words[(at + k) % len]; mean /= 39;
    let s = 0, a = 0;
    for (let k = 0; k < 39; k++) { const v = words[(at + k) % len] - mean; s += v * SYNC_A[k]; a += v < 0 ? -v : v; }
    return a > 0 ? s / a : 0;
  }

  private emit(at: number): void {
    const words = this.words, len = words.length, row = this.row;
    if (this.tmp.length < LINE) this.tmp = new Float32Array(LINE);
    const t = this.tmp;
    for (let k = 0; k < LINE; k++) t[k] = words[(at + k) % len];
    // black / white from the line's own extremes, followed slowly so one bad line does not flash
    const sorted = t.slice().sort();
    const lo = sorted[Math.floor(LINE * 0.02)], hi = sorted[Math.floor(LINE * 0.98)];
    if (!this.calibrated) { this.lo = lo; this.hi = hi; this.calibrated = true; } else { this.lo += 0.05 * (lo - this.lo); this.hi += 0.05 * (hi - this.hi); }
    const g = 255 / Math.max(1e-6, this.hi - this.lo);
    for (let k = 0; k < LINE; k++) row[k] = (t[k] - this.lo) * g;
    this.onRow(row.slice(), this.lines++);
  }
}
