/**
 * LTE downlink basics (FDD, normal cyclic prefix, 15 kHz subcarriers).
 * 36.211: 6.2 resource grid and REGs, 6.10.1 CRS, 6.12 OFDM baseband, 6.3.4.3 transmit diversity, 7.1 modulation,
 * 7.2 pseudo-random sequence. 36.212 5.1.1 CRCs.
 * Complex vectors are split re/im typed arrays. A grid is [14 symbols][12 N_RB subcarriers], index l * K + k.
 */
import { fft } from '../../fft.js';

export const NRB_MAX = 110;

/** Sample-rate dependent timing: N_FFT = fs / 15 kHz, CP 160/144 Ts scaled. */
export class Numerology {
  readonly nfft: number; readonly cp0: number; readonly cpn: number; readonly slot: number; readonly subframe: number; readonly frame: number;
  readonly halfFrame: number;
  constructor(readonly fs: number) {
    this.nfft = Math.round(fs / 15_000);
    const s = this.nfft / 2048;
    this.cp0 = 160 * s; this.cpn = 144 * s; this.slot = 15_360 * s; this.subframe = 2 * this.slot; this.frame = 10 * this.subframe;
    this.halfFrame = 5 * this.subframe;
  }
  /** Start of OFDM symbol l (0..13, CP included) relative to the subframe start, and its CP length. */
  symbol(l: number): [number, number] {
    const slot = Math.floor(l / 7), li = l % 7;
    return [slot * this.slot + (li === 0 ? 0 : this.cp0 + this.nfft + (li - 1) * (this.cpn + this.nfft)), li === 0 ? this.cp0 : this.cpn];
  }
  /** Offset of the PSS useful part (symbol 6 of slot 0/10, after its CP) from the start of its subframe. */
  get pssOffset(): number { const [o, cp] = this.symbol(6); return o + cp; }
}

/** FFT bin of each subcarrier k of an N_RB grid; DC is not part of the grid (36.211 6.12). */
export function scToBin(nrb: number, nfft: number): Int32Array {
  const half = nrb * 6, out = new Int32Array(12 * nrb);
  for (let k = 0; k < 12 * nrb; k++) out[k] = (((k < half ? k - half : k - half + 1) % nfft) + nfft) % nfft;
  return out;
}

export interface Grid { re: Float32Array; im: Float32Array; K: number; nsym: number }
export const newGrid = (nrb: number, nsym = 14): Grid => ({ re: new Float32Array(nsym * 12 * nrb), im: new Float32Array(nsym * 12 * nrb), K: 12 * nrb, nsym });

const fftBufs = new Map<number, { re: Float32Array; im: Float32Array; bins: Map<number, Int32Array>; ramp: Map<number, [Float32Array, Float32Array]> }>();
function bufs(n: number) {
  let b = fftBufs.get(n);
  if (!b) { b = { re: new Float32Array(n), im: new Float32Array(n), bins: new Map(), ramp: new Map() }; fftBufs.set(n, b); }
  return b;
}

/**
 * FFT the symbols of the subframe starting at sample `start` of (xr, xi). The window sits `backoff` samples early,
 * inside the CP, and the resulting linear phase is removed. Returns null if the subframe runs past the buffer.
 */
export function ofdmDemod(xr: Float32Array, xi: Float32Array, start: number, num: Numerology, nrb: number, backoff: number, syms: number[] | null = null, g: Grid = newGrid(nrb)): Grid | null {
  const N = num.nfft, b = bufs(N);
  let bins = b.bins.get(nrb); if (!bins) { bins = scToBin(nrb, N); b.bins.set(nrb, bins); }
  let ramp = b.ramp.get(backoff);
  if (!ramp) {
    ramp = [new Float32Array(N), new Float32Array(N)];
    for (let n = 0; n < N; n++) { const a = 2 * Math.PI * backoff * n / N; ramp[0][n] = Math.cos(a); ramp[1][n] = Math.sin(a); }
    b.ramp.set(backoff, ramp);
  }
  const K = 12 * nrb, sc = 1 / Math.sqrt(N), list = syms ?? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  for (const l of list) {
    const [off, cp] = num.symbol(l), s = Math.round(start) + off + cp - backoff;
    if (s < 0 || s + N > xr.length) return null;
    b.re.set(xr.subarray(s, s + N)); b.im.set(xi.subarray(s, s + N));
    fft(b.re, b.im);
    for (let k = 0; k < K; k++) {
      const j = bins[k], yr = b.re[j], yi = b.im[j], pr = ramp[0][j], pi = ramp[1][j];
      g.re[l * K + k] = (yr * pr - yi * pi) * sc; g.im[l * K + k] = (yr * pi + yi * pr) * sc;
    }
  }
  return g;
}

// ---- 36.211 7.2 Gold sequence -------------------------------------------------------------------------------------
const NC = 1600;
let X1 = new Uint8Array(0);
function x1(n: number): Uint8Array {
  if (X1.length >= n + NC + 31) return X1;
  const len = Math.max(n + NC + 31, 2 * X1.length, 70_000), x = new Uint8Array(len);
  x[0] = 1;
  for (let i = 0; i + 31 < len; i++) x[i + 31] = x[i + 3] ^ x[i];
  X1 = x; return x;
}
/** c(n), n = 0..len-1, for c_init (36.211 7.2). */
export function gold(cInit: number, len: number): Uint8Array {
  const a = x1(len), x2 = new Uint8Array(len + NC + 31), out = new Uint8Array(len);
  for (let b = 0; b < 31; b++) x2[b] = Math.floor(cInit / 2 ** b) & 1;
  for (let i = 0; i + 31 < x2.length; i++) x2[i + 31] = x2[i + 3] ^ x2[i + 2] ^ x2[i + 1] ^ x2[i];
  for (let i = 0; i < len; i++) out[i] = a[i + NC] ^ x2[i + NC];
  return out;
}

// ---- 36.212 5.1.1 CRCs -------------------------------------------------------------------------------------------
export const CRC24A = [24, 23, 18, 17, 14, 11, 10, 7, 6, 5, 4, 3, 1, 0];
export const CRC24B = [24, 23, 6, 5, 1, 0];
export const CRC16 = [16, 12, 5, 0];
export const CRC8 = [8, 7, 4, 3, 1, 0];
/** Parity bits p_0..p_{L-1} (shift register from zero, MSB first). */
export function crcBits(bits: ArrayLike<number>, taps: number[], n = bits.length): Uint8Array {
  const L = taps[0]; let poly = 0;
  for (const t of taps.slice(1)) poly |= 1 << t;
  const mask = L === 32 ? 0xffffffff : (1 << L) - 1, top = 1 << (L - 1);
  let reg = 0;
  for (let i = 0; i < n; i++) {
    const fb = ((reg & top) !== 0 ? 1 : 0) ^ (bits[i] & 1);
    reg = (reg << 1) & mask;
    if (fb) reg ^= poly;
  }
  const out = new Uint8Array(L);
  for (let i = 0; i < L; i++) out[i] = (reg >> (L - 1 - i)) & 1;
  return out;
}
export function bitsToInt(b: ArrayLike<number>, from = 0, n = b.length - from): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 2 + (b[from + i] & 1);
  return v;
}
export function intToBits(v: number, n: number): Uint8Array {
  const o = new Uint8Array(n);
  for (let i = 0; i < n; i++) o[i] = Math.floor(v / 2 ** (n - 1 - i)) & 1;
  return o;
}
export function bitsToBytes(b: ArrayLike<number>): Uint8Array {
  const o = new Uint8Array(Math.ceil(b.length / 8));
  for (let i = 0; i < b.length; i++) if (b[i]) o[i >> 3] |= 0x80 >> (i & 7);
  return o;
}
export const hexOf = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

// ---- 36.211 6.10.1 cell-specific reference signals ---------------------------------------------------------------
const crsCache = new Map<number, [Float32Array, Float32Array]>();
/** r_{l,ns}(m), m = 0..2 N_RB^max - 1, normal CP. */
export function crsSeq(ns: number, l: number, pci: number): [Float32Array, Float32Array] {
  const key = (ns * 8 + l) * 504 + pci;
  let r = crsCache.get(key);
  if (r) return r;
  const cInit = 1024 * (7 * (ns + 1) + l + 1) * (2 * pci + 1) + 2 * pci + 1;
  const c = gold(cInit, 4 * NRB_MAX), re = new Float32Array(2 * NRB_MAX), im = new Float32Array(2 * NRB_MAX);
  for (let m = 0; m < 2 * NRB_MAX; m++) { re[m] = (1 - 2 * c[2 * m]) * Math.SQRT1_2; im[m] = (1 - 2 * c[2 * m + 1]) * Math.SQRT1_2; }
  r = [re, im];
  if (crsCache.size > 20_000) crsCache.clear();
  crsCache.set(key, r);
  return r;
}
/** Subframe symbols carrying CRS of antenna port p. */
export const crsSymbols = (port: number): number[] => port < 2 ? [0, 4, 7, 11] : [1, 8];
/** First subcarrier offset of port p's CRS in subframe symbol lSf; CRS sit at k = 6m + offset, m = 0..2 N_RB - 1. */
export function crsShift(port: number, lSf: number, pci: number): number {
  const l = lSf % 7, slotPar = Math.floor(lSf / 7) % 2;
  const v = port === 0 ? (l === 0 ? 0 : 3) : port === 1 ? (l === 0 ? 3 : 0) : port === 2 ? 3 * slotPar : 3 + 3 * slotPar;
  return (v + pci % 6) % 6;
}
/** CRS REs of ports 0..nports-1 as a [14 * K] mask. */
export function crsMask(pci: number, nrb: number, nports: number): Uint8Array {
  const K = 12 * nrb, m = new Uint8Array(14 * K);
  for (let p = 0; p < nports; p++) for (const l of crsSymbols(p)) { const s = crsShift(p, l, pci); for (let k = s; k < K; k += 6) m[l * K + k] = 1; }
  return m;
}

export interface Chan { re: Float32Array[]; im: Float32Array[]; nv: number; snr: number }
/** Least-squares CRS estimate per port, 3-tap smoothing, linear interpolation in frequency, then in time. */
export function chanEst(g: Grid, sf: number, pci: number, nrb: number, nports: number): Chan {
  const K = 12 * nrb, re: Float32Array[] = [], im: Float32Array[] = [];
  let noise = 0, nn = 0, pow = 0;
  const er = new Float32Array(K), ei = new Float32Array(K);
  for (let p = 0; p < nports; p++) {
    const Hr = new Float32Array(14 * K), Hi = new Float32Array(14 * K), syms = crsSymbols(p), ests: [Float32Array, Float32Array][] = [];
    for (const l of syms) {
      const ns = 2 * sf + Math.floor(l / 7), [rr, ri] = crsSeq(ns, l % 7, pci), s = crsShift(p, l, pci), M = 2 * nrb, off = NRB_MAX - nrb;
      const lr = new Float32Array(M), li = new Float32Array(M);
      for (let m = 0; m < M; m++) {
        const k = 6 * m + s, yr = g.re[l * K + k], yi = g.im[l * K + k], cr = rr[m + off], ci = ri[m + off];
        lr[m] = (yr * cr + yi * ci); li[m] = (yi * cr - yr * ci);
      }
      const sr = new Float32Array(M), si = new Float32Array(M);
      for (let m = 0; m < M; m++) {
        const a = m === 0 ? 1 : m - 1, b = m === M - 1 ? M - 2 : m + 1;
        sr[m] = (lr[a] + lr[m] + lr[b]) / 3; si[m] = (li[a] + li[m] + li[b]) / 3;
        const dr = lr[m] - sr[m], di = li[m] - si[m];
        noise += dr * dr + di * di; nn++; pow += sr[m] * sr[m] + si[m] * si[m];
      }
      const outR = new Float32Array(K), outI = new Float32Array(K);
      for (let k = 0; k < K; k++) {
        const x = (k - s) / 6;
        if (x <= 0) { outR[k] = sr[0]; outI[k] = si[0]; continue; }
        if (x >= M - 1) { outR[k] = sr[M - 1]; outI[k] = si[M - 1]; continue; }
        const i0 = Math.floor(x), w = x - i0;
        outR[k] = sr[i0] * (1 - w) + sr[i0 + 1] * w; outI[k] = si[i0] * (1 - w) + si[i0 + 1] * w;
      }
      ests.push([outR, outI]);
    }
    for (let l = 0; l < 14; l++) {
      let a = 0, b = 0, w = 0;
      if (l <= syms[0]) { a = 0; b = 0; w = 0; }
      else if (l >= syms[syms.length - 1]) { a = b = syms.length - 1; w = 0; }
      else for (let i = 0; i < syms.length - 1; i++) if (syms[i] <= l && l <= syms[i + 1]) { a = i; b = i + 1; w = (l - syms[i]) / (syms[i + 1] - syms[i]); break; }
      for (let k = 0; k < K; k++) { er[k] = ests[a][0][k] * (1 - w) + ests[b][0][k] * w; ei[k] = ests[a][1][k] * (1 - w) + ests[b][1][k] * w; }
      Hr.set(er, l * K); Hi.set(ei, l * K);
    }
    re.push(Hr); im.push(Hi);
  }
  const nv = nn ? Math.max(1e-9, (noise / nn) * 3 / 2) : 1e-3;
  return { re, im, nv, snr: nn ? pow / nn / nv : 0 };
}

/**
 * Undo transmit diversity (6.3.4.3) over a list of REs in mapping order. y: received; idx: grid indices.
 * Returns the equalized symbols and an SNR weight per symbol.
 */
export function tdDecode(g: Grid, H: Chan, idx: Int32Array, nports: number): { xr: Float32Array; xi: Float32Array; gain: Float32Array } {
  const M = idx.length, xr = new Float32Array(M), xi = new Float32Array(M), gain = new Float32Array(M);
  if (nports === 1) {
    for (let i = 0; i < M; i++) {
      const j = idx[i], hr = H.re[0][j], hi = H.im[0][j], yr = g.re[j], yi = g.im[j], p = Math.max(hr * hr + hi * hi, 1e-12);
      xr[i] = (yr * hr + yi * hi) / p; xi[i] = (yi * hr - yr * hi) / p; gain[i] = p;
    }
    return { xr, xi, gain };
  }
  const pair = (i0: number, i1: number, pa: number, pb: number) => {
    const j0 = idx[i0], j1 = idx[i1];
    const h0r = (H.re[pa][j0] + H.re[pa][j1]) / 2, h0i = (H.im[pa][j0] + H.im[pa][j1]) / 2;
    const h1r = (H.re[pb][j0] + H.re[pb][j1]) / 2, h1i = (H.im[pb][j0] + H.im[pb][j1]) / 2;
    const r0r = g.re[j0], r0i = g.im[j0], r1r = g.re[j1], r1i = g.im[j1];
    const n = Math.max((h0r * h0r + h0i * h0i + h1r * h1r + h1i * h1i) / 2, 1e-12);
    // x0 = (conj(h0) r0 + h1 conj(r1)) / sqrt2, x1 = (conj(h0) r1 - h1 conj(r0)) / sqrt2
    const a = Math.SQRT1_2 / n;
    xr[i0] = ((h0r * r0r + h0i * r0i) + (h1r * r1r + h1i * r1i)) * a;
    xi[i0] = ((h0r * r0i - h0i * r0r) + (h1i * r1r - h1r * r1i)) * a;
    xr[i1] = ((h0r * r1r + h0i * r1i) - (h1r * r0r + h1i * r0i)) * a;
    xi[i1] = ((h0r * r1i - h0i * r1r) - (h1i * r0r - h1r * r0i)) * a;
    gain[i0] = gain[i1] = n;
  };
  if (nports === 2) { for (let i = 0; i + 1 < M; i += 2) pair(i, i + 1, 0, 1); return { xr, xi, gain }; }
  for (let i = 0; i + 3 < M; i += 4) { pair(i, i + 1, 0, 2); pair(i + 2, i + 3, 1, 3); }
  return { xr, xi, gain };
}

/** QPSK soft bits (7.1.2: bit 0 maps to +1/sqrt2). Positive means 0. */
export function qpskLlr(x: { xr: Float32Array; xi: Float32Array; gain: Float32Array }, nv: number, out = new Float32Array(2 * x.xr.length)): Float32Array {
  const s = 2 * Math.SQRT2 / Math.max(nv, 1e-9);
  for (let i = 0; i < x.xr.length; i++) { out[2 * i] = x.xr[i] * x.gain[i] * s; out[2 * i + 1] = x.xi[i] * x.gain[i] * s; }
  return out;
}
/** Multiplies soft bits by (1 - 2 c(n)). */
export function descramble(llr: Float32Array, c: Uint8Array): void { for (let i = 0; i < llr.length; i++) if (c[i]) llr[i] = -llr[i]; }
