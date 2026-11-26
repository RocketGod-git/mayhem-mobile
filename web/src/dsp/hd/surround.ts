/** Stereo to 5.1 (L, R, C, LFE, Ls, Rs), an active matrix decoder steering each frequency bin. */
// lossless before the surround delay: L + .707 C + .707 Ls = Lt, R + .707 C - .707 Rs = Rt
import { fft } from '../../fft.js';

const N = 1024, H = N / 2, K = N / 2 + 1;
const EPS = 1e-12;

export interface UpmixOptions {
  /** Sample rate in Hz. */ rate?: number;
  /** How much of a centered source moves to the center speaker, 0 to 1. */ center?: number;
  /** How much uncorrelated ambience moves to the surrounds, 0 to 1. */ ambience?: number;
  /** The surrounds' delay in ms, so the fronts keep the precedence. */ delayMs?: number;
  /** The LFE's level against the mono sum below its crossover. */ lfe?: number;
}

export class Upmixer {
  /** Samples from an input sample to the same sample in every output (the surrounds add their delay). */
  readonly latency = N;
  private readonly win = new Float32Array(N);
  private readonly inL = new Float32Array(N);
  private readonly inR = new Float32Array(N);
  private fill = N - H;
  private readonly ola = Array.from({ length: 6 }, () => new Float32Array(N));
  private readonly ready = Array.from({ length: 6 }, () => new Float32Array(H));
  private rp = 0;
  private readonly pLL = new Float32Array(K);
  private readonly pRR = new Float32Array(K);
  private readonly cRe = new Float32Array(K);
  private readonly cIm = new Float32Array(K);
  private readonly re = new Float32Array(N);
  private readonly im = new Float32Array(N);
  private readonly spec = Array.from({ length: 6 }, () => ({ re: new Float32Array(K), im: new Float32Array(K) }));
  private readonly Lr = new Float32Array(K);
  private readonly Li = new Float32Array(K);
  private readonly Rr = new Float32Array(K);
  private readonly Ri = new Float32Array(K);
  private readonly lfeW = new Float32Array(K);
  private readonly hiW = new Float32Array(K);
  private readonly alpha: number;
  private readonly centerAmt: number;
  private readonly ambAmt: number;
  private readonly lfeAmt: number;
  private readonly dly: number;
  private readonly dlyL: Float32Array;
  private readonly dlyR: Float32Array;
  private dp = 0;

  constructor(o: UpmixOptions = {}) {
    const rate = o.rate ?? 48_000;
    for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    this.alpha = Math.exp(-(H / rate) / 0.04);
    this.centerAmt = o.center ?? 0.85;
    this.ambAmt = o.ambience ?? 0.5;
    this.lfeAmt = o.lfe ?? 0.5;
    this.dly = Math.max(0, Math.round((o.delayMs ?? 10) * rate / 1000));
    this.dlyL = new Float32Array(this.dly + 1);
    this.dlyR = new Float32Array(this.dly + 1);
    for (let k = 0; k < K; k++) {
      const f = k * rate / N;
      this.lfeW[k] = f <= 80 ? 1 : f >= 160 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * (f - 80) / 80);
      // surrounds roll off above 7 kHz (the fronts keep it), as matrix decoders do against leakage
      this.hiW[k] = f <= 7000 ? 1 : f >= 12000 ? 0.25 : 1 - 0.75 * (f - 7000) / 5000;
    }
  }

  reset(): void {
    this.inL.fill(0); this.inR.fill(0); this.fill = N - H; this.rp = 0;
    for (const a of this.ola) a.fill(0);
    for (const a of this.ready) a.fill(0);
    this.pLL.fill(0); this.pRR.fill(0); this.cRe.fill(0); this.cIm.fill(0);
    this.dlyL.fill(0); this.dlyR.fill(0); this.dp = 0;
  }

  /** One block of stereo in, the same length of 5.1 out. */
  process(l: Float32Array, r: Float32Array): Float32Array[] {
    const n = l.length, out = Array.from({ length: 6 }, () => new Float32Array(n));
    const [oL, oR, oC, oF, oLs, oRs] = out, rd = this.ready, D = this.dly;
    for (let i = 0; i < n; i++) {
      this.inL[this.fill] = l[i]; this.inR[this.fill] = r[i];
      const j = this.rp++;
      oL[i] = rd[0][j]; oR[i] = rd[1][j]; oC[i] = rd[2][j]; oF[i] = rd[3][j];
      if (D) {
        oLs[i] = this.dlyL[this.dp]; oRs[i] = this.dlyR[this.dp];
        this.dlyL[this.dp] = rd[4][j]; this.dlyR[this.dp] = rd[5][j]; this.dp = (this.dp + 1) % D;
      } else { oLs[i] = rd[4][j]; oRs[i] = rd[5][j]; }
      if (++this.fill === N) { this.frame(); this.fill = N - H; this.rp = 0; }
    }
    return out;
  }

  private frame(): void {
    const { re, im, win, spec } = this;
    for (let i = 0; i < N; i++) { re[i] = this.inL[i] * win[i]; im[i] = this.inR[i] * win[i]; }
    fft(re, im);
    const a = this.alpha, b = 1 - a;
    const { Lr, Li, Rr, Ri } = this;
    for (let k = 0; k < K; k++) {
      const m = (N - k) % N;
      Lr[k] = 0.5 * (re[k] + re[m]); Li[k] = 0.5 * (im[k] - im[m]);
      Rr[k] = 0.5 * (im[k] + im[m]); Ri[k] = -0.5 * (re[k] - re[m]);
      this.pLL[k] = a * this.pLL[k] + b * (Lr[k] * Lr[k] + Li[k] * Li[k]);
      this.pRR[k] = a * this.pRR[k] + b * (Rr[k] * Rr[k] + Ri[k] * Ri[k]);
      this.cRe[k] = a * this.cRe[k] + b * (Lr[k] * Rr[k] + Li[k] * Ri[k]);
      this.cIm[k] = a * this.cIm[k] + b * (Li[k] * Rr[k] - Lr[k] * Ri[k]);
    }
    for (let k = 0; k < K; k++) {
      // the statistics over three neighboring bins, which keeps the masks from fluttering
      let ll = 0, rr = 0, cr = 0, ci = 0;
      for (let q = Math.max(0, k - 1); q <= Math.min(K - 1, k + 1); q++) { ll += this.pLL[q]; rr += this.pRR[q]; cr += this.cRe[q]; ci += this.cIm[q]; }
      const g = Math.sqrt(ll * rr) + EPS, phi = cr / g, coh = Math.min(1, Math.hypot(cr, ci) / g);
      const bal = Math.abs(ll - rr) / (ll + rr + EPS);
      const inPh = phi > 0 ? phi : 0, outPh = phi < 0 ? -phi : 0;
      const gc = this.centerAmt * inPh * inPh * (1 - bal);
      const ga = Math.min(1, outPh + this.ambAmt * (1 - coh) * (1 - bal)) * this.hiW[k];
      const mr = 0.5 * (Lr[k] + Rr[k]), mi = 0.5 * (Li[k] + Ri[k]);
      const fLr = Lr[k] - gc * mr, fLi = Li[k] - gc * mi, fRr = Rr[k] - gc * mr, fRi = Ri[k] - gc * mi;
      const s = Math.SQRT2 * ga, f = 1 - ga, w = this.lfeW[k] * this.lfeAmt;
      spec[0].re[k] = f * fLr; spec[0].im[k] = f * fLi;
      spec[1].re[k] = f * fRr; spec[1].im[k] = f * fRi;
      spec[2].re[k] = Math.SQRT2 * gc * mr; spec[2].im[k] = Math.SQRT2 * gc * mi;
      spec[3].re[k] = w * mr; spec[3].im[k] = w * mi;
      spec[4].re[k] = s * fLr; spec[4].im[k] = s * fLi;
      spec[5].re[k] = -s * fRr; spec[5].im[k] = -s * fRi;
    }
    for (let c = 0; c < 6; c += 2) this.inverse(spec[c], spec[c + 1], this.ola[c], this.ola[c + 1]);
    for (let c = 0; c < 6; c++) {
      const o = this.ola[c];
      this.ready[c].set(o.subarray(0, H));
      o.copyWithin(0, H); o.fill(0, N - H);
    }
    this.inL.copyWithin(0, H); this.inR.copyWithin(0, H);
  }

  /** Two real channels' half spectra back to time, windowed and added into their overlap buffers. */
  private inverse(x: { re: Float32Array; im: Float32Array }, y: { re: Float32Array; im: Float32Array }, ox: Float32Array, oy: Float32Array): void {
    const { re, im, win } = this;
    // Z = X + jY over the full spectrum, conjugated so the forward FFT runs as an inverse
    for (let k = 0; k < K; k++) {
      re[k] = x.re[k] - y.im[k]; im[k] = -(x.im[k] + y.re[k]);
      if (k > 0 && k < N / 2) { const m = N - k; re[m] = x.re[k] + y.im[k]; im[m] = -(-x.im[k] + y.re[k]); }
    }
    fft(re, im);
    const s = 1 / N;
    for (let i = 0; i < N; i++) { ox[i] += re[i] * s * win[i]; oy[i] -= im[i] * s * win[i]; }
  }
}
