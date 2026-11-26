// IMDCT for the AAC filterbank: M coefficients in, 2M samples out, scaled by 2/N as in ISO/IEC 14496-3.
export class Imdct {
  private readonly m: number;
  private readonly tw: Float64Array;
  private readonly fc: Float64Array;
  private readonly fs: Float64Array;
  private readonly rev: Uint16Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly u: Float64Array;

  constructor(m: number) {
    this.m = m;
    const h = m / 2;
    this.tw = new Float64Array(2 * h);
    for (let k = 0; k < h; k++) { const a = -Math.PI * (8 * k + 1) / (8 * m); this.tw[2 * k] = Math.cos(a); this.tw[2 * k + 1] = Math.sin(a); }
    this.fc = new Float64Array(h / 2); this.fs = new Float64Array(h / 2);
    for (let k = 0; k < h / 2; k++) { this.fc[k] = Math.cos(-2 * Math.PI * k / h); this.fs[k] = Math.sin(-2 * Math.PI * k / h); }
    const bits = Math.log2(h);
    this.rev = new Uint16Array(h);
    for (let i = 0; i < h; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.re = new Float64Array(h); this.im = new Float64Array(h); this.u = new Float64Array(m);
  }

  // DCT-IV via an M/2-point complex FFT, then unfolded to the 2M-sample IMDCT output.
  run(x: ArrayLike<number>, xo: number, out: Float64Array): void {
    const m = this.m, h = m / 2, re = this.re, im = this.im, tw = this.tw, u = this.u;
    for (let k = 0; k < h; k++) {
      const a = x[xo + 2 * k], b = x[xo + m - 1 - 2 * k], c = tw[2 * k], s = tw[2 * k + 1], r = this.rev[k];
      re[r] = a * c - b * s; im[r] = a * s + b * c;
    }
    for (let len = 2; len <= h; len <<= 1) {
      const half = len >> 1, step = h / len;
      for (let i = 0; i < h; i += len) {
        for (let j = 0; j < half; j++) {
          const c = this.fc[j * step], s = this.fs[j * step], p = i + j, q = p + half;
          const tr = re[q] * c - im[q] * s, ti = re[q] * s + im[q] * c;
          re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
        }
      }
    }
    const g = 1 / m;
    for (let j = 0; j < h; j++) {
      const c = tw[2 * j], s = tw[2 * j + 1], a = re[j] * c - im[j] * s, b = re[j] * s + im[j] * c;
      u[2 * j] = a * g; u[m - 1 - 2 * j] = -b * g;
    }
    const q = m / 2;
    for (let n = 0; n < q; n++) out[n] = u[n + q];
    for (let n = q; n < 3 * q; n++) out[n] = -u[3 * q - 1 - n];
    for (let n = 3 * q; n < 2 * m; n++) out[n] = -u[n - 3 * q];
  }
}

// Direct O(N^2) reference, for tests.
export function imdctRef(x: ArrayLike<number>, m: number): Float64Array {
  const n2 = 2 * m, out = new Float64Array(n2), n0 = (m + 1) / 2;
  for (let n = 0; n < n2; n++) { let s = 0; for (let k = 0; k < m; k++) s += x[k] * Math.cos(Math.PI / m * (n + n0) * (k + 0.5)); out[n] = s / m; }
  return out;
}
