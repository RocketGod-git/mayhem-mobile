/**
 * Cell search on the central 6 RBs at 1.92 MS/s (N_FFT 128): PSS (36.211 6.11.1), SSS (6.11.2), CFO from the cyclic
 * prefix (6.12), and a per half-frame PSS map that survives sample drops (a drop only ever moves the PSS earlier).
 */
import { fft } from '../../fft.js';
import { Numerology } from './common.js';

export const LOW_FS = 1_920_000;
export const LOW = new Numerology(LOW_FS);
export const HALF = LOW.halfFrame;      // 9600

/** d_u(n) of 6.11.1.1, roots 25/29/34 for N_ID2 0/1/2. */
export function pssFreq(nid2: number): [Float32Array, Float32Array] {
  const u = [25, 29, 34][nid2], re = new Float32Array(62), im = new Float32Array(62);
  for (let n = 0; n < 62; n++) {
    const a = n < 31 ? -Math.PI * u * n * (n + 1) / 63 : -Math.PI * u * (n + 1) * (n + 2) / 63;
    re[n] = Math.cos(a); im[n] = Math.sin(a);
  }
  return [re, im];
}
/** Subcarrier offsets of the 62 PSS/SSS elements from DC (DC skipped). */
export const K62 = Int32Array.from({ length: 62 }, (_, n) => n < 31 ? n - 31 : n - 30);

/** Time-domain PSS of one N_FFT symbol (no CP), unit energy per sample on average. */
export function pssTime(nid2: number, nfft: number): [Float32Array, Float32Array] {
  const re = new Float32Array(nfft), im = new Float32Array(nfft), [pr, pi] = pssFreq(nid2);
  for (let n = 0; n < 62; n++) { const b = (K62[n] + nfft) % nfft; re[b] = pr[n]; im[b] = -pi[n]; }
  fft(re, im);
  const s = 1 / Math.sqrt(nfft);
  for (let i = 0; i < nfft; i++) { re[i] *= s; im[i] *= -s; }
  return [re, im];
}

function mseq(taps: number[]): Int8Array {
  const x = [0, 0, 0, 0, 1];
  for (let i = 0; i < 26; i++) x.push(taps.reduce((a, t) => a + x[i + t], 0) % 2);
  return Int8Array.from(x, v => 1 - 2 * v);
}
const S_T = mseq([2, 0]), C_T = mseq([3, 0]), Z_T = mseq([4, 2, 1, 0]);

/** d(0..61) of 6.11.2.1 for subframe 0 (sub5 false) or 5. */
export function sssSeq(nid1: number, nid2: number, sub5: boolean): Int8Array {
  const qp = Math.floor(nid1 / 30), q = Math.floor((nid1 + qp * (qp + 1) / 2) / 30), mp = nid1 + q * (q + 1) / 2;
  const m0 = mp % 31, m1 = (m0 + Math.floor(mp / 31) + 1) % 31, d = new Int8Array(62);
  for (let n = 0; n < 31; n++) {
    const s0 = S_T[(n + m0) % 31], s1 = S_T[(n + m1) % 31], c0 = C_T[(n + nid2) % 31], c1 = C_T[(n + nid2 + 3) % 31];
    const z0 = Z_T[(n + (m0 % 8)) % 31], z1 = Z_T[(n + (m1 % 8)) % 31];
    if (!sub5) { d[2 * n] = s0 * c0; d[2 * n + 1] = s1 * c1 * z0; } else { d[2 * n] = s1 * c0; d[2 * n + 1] = s0 * c1 * z1; }
  }
  return d;
}
let BANK: Int8Array[][] | null = null;
const bank = (nid2: number): Int8Array[] => {
  if (!BANK) BANK = [[], [], []];
  if (!BANK[nid2].length) for (let i = 0; i < 168; i++) BANK[nid2].push(sssSeq(i, nid2, false), sssSeq(i, nid2, true));
  return BANK[nid2];
};

/** Windowed-sinc low-pass decimator from fs to 1.92 MS/s (keeps the central 1.08 MHz). */
export function decimate(xr: Float32Array, xi: Float32Array, fs: number): [Float32Array, Float32Array] {
  const D = Math.round(fs / LOW_FS);
  if (D <= 1) return [xr, xi];
  const taps = 16 * D + 1, h = new Float32Array(taps), fc = 0.62e6 / fs, mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - mid, w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
    h[i] = (t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t)) * w; sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const n = Math.floor((xr.length - taps) / D) + 1, yr = new Float32Array(Math.max(0, n)), yi = new Float32Array(Math.max(0, n));
  for (let o = 0; o < n; o++) {
    let ar = 0, ai = 0; const s = o * D;
    for (let k = 0; k < taps; k++) { ar += h[k] * xr[s + k]; ai += h[k] * xi[s + k]; }
    yr[o] = ar; yi[o] = ai;
  }
  return [yr, yi];
}
/** Delay of the decimator output: output o is centered on input sample o * D + delayIn. */
export const decimDelay = (fs: number) => { const D = Math.round(fs / LOW_FS); return D <= 1 ? 0 : 8 * D; };

/**
 * Rational resampler by L/M for rates that are not a multiple of 1.92 MS/s (a HackRF at 20 MS/s). Output m is the
 * signal at input position m * M / L, with no delay: a Kaiser-windowed sinc with cutoff fc (cycles per input sample),
 * one 2H-tap phase per L, each phase normalized to unit DC gain. Input outside the buffer counts as zero.
 */
export class Rational {
  readonly h: Float32Array;
  constructor(readonly L: number, readonly M: number, readonly H: number, fc: number, beta: number) {
    const T = 2 * H, h = new Float32Array(L * T), i0 = (x: number) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; }, ib = i0(beta);
    for (let r = 0; r < L; r++) {
      let sum = 0;
      for (let k = 0; k < T; k++) {
        const t = k - H + 1 - r / L, u = t / H, w = Math.abs(u) >= 1 ? 0 : i0(beta * Math.sqrt(1 - u * u)) / ib;
        const v = (t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t)) * w;
        h[r * T + k] = v; sum += v;
      }
      for (let k = 0; k < T; k++) h[r * T + k] /= sum;
    }
    this.h = h;
  }
  /** Outputs m0 .. m0+n-1 into (or, oi). */
  run(xr: Float32Array, xi: Float32Array, m0: number, n: number, or: Float32Array, oi: Float32Array): void {
    const { L, M, H, h } = this, T = 2 * H, len = xr.length;
    for (let j = 0; j < n; j++) {
      const num = (m0 + j) * M, q = Math.floor(num / L), r = num - q * L, b = q - H + 1, hb = r * T;
      let ar = 0, ai = 0;
      if (b >= 0 && b + T <= len) for (let k = 0; k < T; k++) { const c = h[hb + k]; ar += c * xr[b + k]; ai += c * xi[b + k]; }
      else for (let k = 0; k < T; k++) { const x = b + k; if (x < 0 || x >= len) continue; const c = h[hb + k]; ar += c * xr[x]; ai += c * xi[x]; }
      or[j] = ar; oi[j] = ai;
    }
  }
  /** Number of outputs from m = 0 whose taps all fall before the end of an input of len samples. */
  count(len: number): number { return Math.max(0, Math.floor((len - this.H) * this.L / this.M)); }
}
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
/**
 * For a rate that is not a multiple of 1.92 MS/s: the LTE rate it is resampled to (the smallest 1.92 MS/s x 2^k at or
 * above it, up to 30.72 MS/s), the resampler there for the OFDM symbols and the one down to 1.92 MS/s for cell search.
 * Null when the rate is a multiple of 1.92 MS/s (no resampling) or has no small rational ratio.
 */
export function lteResamplers(fs: number): { vr: number; up: Rational; down: Rational } | null {
  if (!Number.isInteger(fs) || Number.isInteger(fs / LOW_FS) || fs < 2 * LOW_FS) return null;
  let vr = LOW_FS;
  while (vr < fs && vr < 30_720_000) vr *= 2;
  if (vr < fs) return null;
  const g1 = gcd(vr, fs), g2 = gcd(LOW_FS, fs), L1 = vr / g1, M1 = fs / g1, L2 = LOW_FS / g2, M2 = fs / g2;
  if (L1 > 4096 || L2 > 4096) return null;
  // up: keep everything to the input Nyquist (an LTE carrier fills 90 %), stop its images; down: the central 1.08 MHz
  // with the same cutoff and span as decimate()
  return { vr, up: new Rational(L1, M1, 16, 0.5, 6), down: new Rational(L2, M2, Math.ceil(8 * fs / LOW_FS), 0.62e6 / fs, 7.5) };
}

/** CFO in Hz from the CP repetition over the whole buffer: x[n] x*[n + N] (unambiguous +-7.5 kHz). */
export function cpCfo(xr: Float32Array, xi: Float32Array, fs: number): { hz: number; strength: number } {
  const N = Math.round(fs / 15_000);
  let ar = 0, ai = 0, p = 0;
  for (let n = 0; n + N < xr.length; n++) {
    const a = xr[n], b = xi[n], c = xr[n + N], d = xi[n + N];
    ar += a * c + b * d; ai += b * c - a * d; p += a * a + b * b;
  }
  return { hz: -Math.atan2(ai, ar) * fs / (2 * Math.PI * N), strength: p > 0 ? Math.hypot(ar, ai) / p : 0 };
}
/** Multiplies by exp(-j 2 pi f n / fs) in place, n counted from n0. */
export function rotate(xr: Float32Array, xi: Float32Array, f: number, fs: number, n0 = 0): void {
  if (!f) return;
  const w = -2 * Math.PI * f / fs;
  let cr = Math.cos(w * n0), ci = Math.sin(w * n0);
  const dr = Math.cos(w), di = Math.sin(w);
  for (let n = 0; n < xr.length; n++) {
    const a = xr[n], b = xi[n];
    xr[n] = a * cr - b * ci; xi[n] = a * ci + b * cr;
    const t = cr * dr - ci * di; ci = cr * di + ci * dr; cr = t;
    if ((n & 1023) === 1023) { const m = Math.hypot(cr, ci); cr /= m; ci /= m; }
  }
}

export interface PssHit { nid2: number; pos: number; score: number; cfo: number }
const PSS_SPEC: [Float32Array, Float32Array][] = [], PSS_T: [Float32Array, Float32Array][] = [];
const FFT_N = 32_768;
function pssSpec(nid2: number): [Float32Array, Float32Array] {
  if (!PSS_SPEC[nid2]) {
    const [tr, ti] = pssTime(nid2, 128), re = new Float32Array(FFT_N), im = new Float32Array(FFT_N);
    re.set(tr); im.set(ti); fft(re, im); PSS_SPEC[nid2] = [re, im];
  }
  return PSS_SPEC[nid2];
}

/**
 * PSS search over two half-frames from `start` of a 1.92 MS/s buffer, folded modulo 5 ms. Returns peaks (position of
 * the PSS useful part, relative to `start`, in 0..9599) for every root and each extra CFO hypothesis (Hz), strongest first.
 */
export function pssSearch(yr: Float32Array, yi: Float32Array, start: number, cfos: number[] = [0]): PssHit[] {
  const len = 2 * HALF + 128, hits: PssHit[] = [];
  if (start + len > yr.length) return hits;
  const ar = new Float32Array(FFT_N), ai = new Float32Array(FFT_N), cr = new Float32Array(FFT_N), ci = new Float32Array(FFT_N), fold = new Float32Array(HALF);
  for (const cfo of cfos) {
    ar.fill(0); ai.fill(0);
    ar.set(yr.subarray(start, start + len)); ai.set(yi.subarray(start, start + len));
    rotate(ar.subarray(0, len), ai.subarray(0, len), cfo, LOW_FS);
    fft(ar, ai);
    for (let nid2 = 0; nid2 < 3; nid2++) {
      const [pr, pi] = pssSpec(nid2);
      // correlation = IFFT(Y conj(P)); IFFT via conj(FFT(conj(.)))
      for (let i = 0; i < FFT_N; i++) { cr[i] = ar[i] * pr[i] + ai[i] * pi[i]; ci[i] = -(ai[i] * pr[i] - ar[i] * pi[i]); }
      fft(cr, ci);
      for (let i = 0; i < HALF; i++) fold[i] = Math.hypot(cr[i], ci[i]) + Math.hypot(cr[i + HALF], ci[i + HALF]);
      const sorted = Float32Array.from(fold).sort(), med = sorted[HALF >> 1] || 1e-9;
      // up to three separated peaks per root (co-channel cells on the same root sit a few samples apart)
      const taken: number[] = [];
      for (let r = 0; r < 3; r++) {
        let best = -1, bv = 0;
        for (let i = 0; i < HALF; i++) if (fold[i] > bv && taken.every(t => Math.min(Math.abs(t - i), HALF - Math.abs(t - i)) > 3)) { bv = fold[i]; best = i; }
        if (best < 0) break;
        const score = bv / med;
        if (r > 0 && score < 0.45 * hits.filter(h => h.nid2 === nid2 && h.cfo === cfo)[0]?.score) break;
        taken.push(best);
        hits.push({ nid2, pos: best, score, cfo });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** Correlation magnitude of root nid2 at positions lo..hi of the buffer; returns the best position, sub-sample. */
export function pssLocal(yr: Float32Array, yi: Float32Array, nid2: number, lo: number, hi: number): { pos: number; peak: number; snr: number } | null {
  const [tr, ti] = PSS_T[nid2] ??= pssTime(nid2, 128);
  lo = Math.max(0, Math.floor(lo)); hi = Math.min(yr.length - 128, Math.ceil(hi));
  if (hi < lo + 2) return null;
  const mags = new Float32Array(hi - lo + 1);
  for (let p = lo; p <= hi; p++) {
    let ar = 0, ai = 0;
    for (let m = 0; m < 128; m++) { const a = yr[p + m], b = yi[p + m], c = tr[m], d = ti[m]; ar += a * c + b * d; ai += b * c - a * d; }
    mags[p - lo] = Math.hypot(ar, ai);
  }
  let j = 0;
  for (let i = 1; i < mags.length; i++) if (mags[i] > mags[j]) j = i;
  const sorted = Float32Array.from(mags).sort(), med = sorted[mags.length >> 1] || 1e-9;
  let frac = 0;
  if (j > 0 && j < mags.length - 1) { const a = mags[j - 1], b = mags[j], c = mags[j + 1], den = a - 2 * b + c; if (den < 0) frac = 0.5 * (a - c) / den; }
  return { pos: lo + j + frac, peak: mags[j], snr: mags[j] / med };
}

export interface HalfFrame { h: number; pos: number; snr: number }
/**
 * Follows the PSS through the buffer one half-frame at a time, from a position known modulo 5 ms. A gap re-derives
 * the true half-frame count, so h stays the count of 5 ms periods since the first one even across sample drops.
 */
export function halfFrameMap(yr: Float32Array, yi: Float32Array, nid2: number, pos0: number): HalfFrame[] {
  const out: HalfFrame[] = [];
  let pred = pos0, h = 0, miss = 0, last: HalfFrame | null = null;
  while (pred + 200 < yr.length) {
    const r = pssLocal(yr, yi, nid2, pred - (miss ? 1200 : 320), pred + 16);
    if (!r || r.snr < 3.2) { miss++; pred += HALF; h++; if (miss > 3) break; continue; }
    if (last && miss) h = last.h + Math.round((r.pos - last.pos) / HALF + 0.25);
    last = { h, pos: r.pos, snr: r.snr };
    out.push(last);
    miss = 0; pred = r.pos + HALF; h++;
  }
  return out;
}

/**
 * Coherent SSS scores over the mapped half-frames (36.211 6.11.2): the SSS sits `lag` samples before the PSS (one
 * symbol in FDD, three in TDD) and is equalized with the PSS channel. Returns [nid1, evenIsSf0, score] sorted best first.
 */
export function sssIdentify(yr: Float32Array, yi: Float32Array, nid2: number, map: HalfFrame[], max = 40, lag = 128 + LOW.cpn): [number, boolean, number][] {
  const N = 128, B = bank(nid2), [pr, pi] = pssFreq(nid2);
  const acc = new Float64Array(336), sr = new Float32Array(N), si = new Float32Array(N), qr = new Float32Array(N), qi = new Float32Array(N);
  const z = new Float32Array(62), hr = new Float32Array(62), hi = new Float32Array(62);
  for (const hf of map.slice(0, max)) {
    const s = Math.round(hf.pos), a = s - lag - 1, b = s - 1;
    if (a < 0 || b + N > yr.length) continue;
    sr.set(yr.subarray(a, a + N)); si.set(yi.subarray(a, a + N)); qr.set(yr.subarray(b, b + N)); qi.set(yi.subarray(b, b + N));
    fft(sr, si); fft(qr, qi);
    for (let n = 0; n < 62; n++) { const j = (K62[n] + N) % N; const ur = qr[j], ui = qi[j]; hr[n] = ur * pr[n] + ui * pi[n]; hi[n] = ui * pr[n] - ur * pi[n]; }
    for (let n = 0; n < 62; n++) {
      let cr = 0, ci = 0;
      for (let d = -1; d <= 1; d++) if (n + d >= 0 && n + d < 62) { cr += hr[n + d]; ci += hi[n + d]; }
      cr /= 3; ci /= 3;
      const j = (K62[n] + N) % N, yr2 = sr[j], yi2 = si[j];
      z[n] = (yr2 * cr + yi2 * ci) / Math.max(cr * cr + ci * ci, 1e-9);
    }
    const even = hf.h % 2 === 0;
    for (let i = 0; i < 168; i++) {
      let m0 = 0, m1 = 0; const d0 = B[2 * i], d1 = B[2 * i + 1];
      for (let n = 0; n < 62; n++) { m0 += d0[n] * z[n]; m1 += d1[n] * z[n]; }
      if (even) { acc[2 * i] += m0; acc[2 * i + 1] += m1; } else { acc[2 * i] += m1; acc[2 * i + 1] += m0; }
    }
  }
  const out: [number, boolean, number][] = [];
  for (let q = 0; q < 336; q++) out.push([q >> 1, q % 2 === 0, acc[q]]);
  return out.sort((x, y) => y[2] - x[2]);
}
