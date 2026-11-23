/**
 * A Codec 2 style speech decoder for M17 voice (3200 and 1600 bit/s), built from David Rowe's "Codec 2 Algorithm
 * Description" (February 2025) and nothing else:
 *
 *   · the harmonic sinusoidal model: L = ⌊π/ω0⌋ harmonics of ω0, synthesized every 10 ms (N = 80 samples at
 *     8 kHz) by an Ndft = 512 inverse DFT with each harmonic placed at bin round(m·ω0·Ndft/2π), joined by a
 *     triangular overlap-add window (section 3.3);
 *   · the LPC/LSP spectral envelope: p = 10 LSP frequencies, A(z) = (P(z) + Q(z))/2 with ω1, ω3, ... in P and
 *     ω2, ω4, ... in Q, each harmonic's amplitude from the LPC power spectrum summed over its band
 *     (round((m-0.5)r) to round((m+0.5)r) - 1), after the post filter Rw^β with Rw = |A(z/γ)|/|A(z)|, β = 0.2,
 *     γ = 0.5 (section 3.7);
 *   · zero-order phase: voiced harmonics take m·φ1 with φ1 advancing N·ω0 a frame, unvoiced take random phases
 *     at ω0 = 2π·50/8000, both plus the phase of H = G/A at the harmonic (section 3.6);
 *   · the frames: 3200 is 64 bits every 20 ms (pitch 7, energy 5, voicing 2, LSP differences 50); 1600 is 64 bits
 *     every 40 ms (pitch 14, energy 10, voicing 4, LSPs 36) (sections 2.5 and 4); parameters between the sent ones
 *     are linear interpolations, as the decoder of section 3.7 does.
 *
 * What the description does not give, and is only in the reference implementation's source, is not used: the bit
 * order inside a frame, the pitch and energy quantizer ranges, and the LSP quantizer tables. Those below are our
 * own (OWN_* names), so this decodes frames from our own encoder; frames from radios using the reference tables
 * come out as speech-like sound with the wrong spectrum until the real tables can be used. No DOM.
 */

export const C2_FS = 8000, C2_N = 80, C2_NDFT = 512, C2_P = 10;
const TWO_PI = 2 * Math.PI;
/** Our own pitch quantizer: 7 bits, F0 50 to 400 Hz in equal steps. */
export const OWN_F0_MIN = 50, OWN_F0_MAX = 400;
/** Our own energy quantizer: 5 bits, the mean power of a 10 ms frame (16-bit PCM units) from 10 to 80 dB. */
export const OWN_E_MIN_DB = 10, OWN_E_MAX_DB = 80;
/** Our own 3200 LSP difference quantizers, 5 bits each: [low, high] Hz of ω1 and of each step ωi - ωi-1. */
export const OWN_LSPD_HZ: [number, number][] = [[100, 700], [40, 800], [40, 800], [40, 800], [40, 800], [40, 800], [40, 800], [40, 800], [40, 800], [40, 800]];
/** Our own 1600 LSP quantizers: bits and [low, high] Hz of each LSP. */
export const OWN_LSP_BITS = [4, 4, 4, 4, 4, 4, 4, 3, 3, 2];
export const OWN_LSP_HZ: [number, number][] = [[100, 700], [200, 1100], [400, 1600], [650, 2000], [1000, 2400], [1300, 2800], [1700, 3200], [2000, 3400], [2400, 3600], [2800, 3800]];

export const f0FromIndex = (i: number) => OWN_F0_MIN + i * (OWN_F0_MAX - OWN_F0_MIN) / 127;
export const eDbFromIndex = (i: number) => OWN_E_MIN_DB + i * (OWN_E_MAX_DB - OWN_E_MIN_DB) / 31;
export const lspdHz = (k: number, i: number) => OWN_LSPD_HZ[k][0] + i * (OWN_LSPD_HZ[k][1] - OWN_LSPD_HZ[k][0]) / 31;
export const lspHz = (k: number, i: number) => OWN_LSP_HZ[k][0] + i * (OWN_LSP_HZ[k][1] - OWN_LSP_HZ[k][0]) / ((1 << OWN_LSP_BITS[k]) - 1);

/** One 10 ms set of model parameters. */
export interface C2Params { wo: number; voiced: boolean; eDb: number; lsp: Float64Array }

/** Bits of a frame, first bit the MSB of the first byte. */
export class BitReader {
  private p = 0;
  constructor(private readonly b: ArrayLike<number>) {}
  read(n: number): number { let v = 0; for (let i = 0; i < n; i++, this.p++) v = (v << 1) | ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1); return v; }
}

/** LSPs (radians, rising) kept in (0, π) and apart by at least [minSep]. */
export function orderLsps(w: Float64Array, minSep = 0.02): void {
  for (let i = 0; i < w.length; i++) {
    const lo = i === 0 ? minSep : w[i - 1] + minSep;
    if (!(w[i] >= lo)) w[i] = lo;
  }
  for (let i = w.length - 1; i >= 0; i--) {
    const hi = i === w.length - 1 ? Math.PI - minSep : w[i + 1] - minSep;
    if (w[i] > hi) w[i] = hi;
  }
}

/** 3200: 64 bits → the parameters of the frame's two 10 ms halves (the second as sent, voicing of each). */
export function unpack3200(b: ArrayLike<number>): { wo: number; eDb: number; v1: boolean; v2: boolean; lsp: Float64Array } {
  const r = new BitReader(b);
  const wo = TWO_PI * f0FromIndex(r.read(7)) / C2_FS, eDb = eDbFromIndex(r.read(5));
  const v1 = r.read(1) === 1, v2 = r.read(1) === 1;
  const lsp = new Float64Array(10); let f = 0;
  for (let k = 0; k < 10; k++) { f += lspdHz(k, r.read(5)); lsp[k] = TWO_PI * f / C2_FS; }
  orderLsps(lsp);
  return { wo, eDb, v1, v2, lsp };
}
/** 1600: 64 bits → two pitch and energy pairs (for the second and fourth 10 ms), four voicing bits, the LSPs. */
export function unpack1600(b: ArrayLike<number>): { wo: [number, number]; eDb: [number, number]; v: boolean[]; lsp: Float64Array } {
  const r = new BitReader(b);
  const v1 = r.read(1) === 1, wo1 = TWO_PI * f0FromIndex(r.read(7)) / C2_FS, e1 = eDbFromIndex(r.read(5));
  const v2 = r.read(1) === 1, v3 = r.read(1) === 1, wo2 = TWO_PI * f0FromIndex(r.read(7)) / C2_FS, e2 = eDbFromIndex(r.read(5));
  const v4 = r.read(1) === 1;
  const lsp = new Float64Array(10);
  for (let k = 0; k < 10; k++) lsp[k] = TWO_PI * lspHz(k, r.read(OWN_LSP_BITS[k])) / C2_FS;
  orderLsps(lsp);
  return { wo: [wo1, wo2], eDb: [e1, e2], v: [v1, v2, v3, v4], lsp };
}

/** LSP frequencies (radians) → A(z) = 1 + a1 z^-1 + ... + a10 z^-10, from P(z) and Q(z) (section 3.7). */
export function lspToLpc(w: ArrayLike<number>): Float64Array {
  let P = [1, 1], Q = [1, -1];
  const mul = (a: number[], c: number) => { const o = new Array(a.length + 2).fill(0); for (let i = 0; i < a.length; i++) { o[i] += a[i]; o[i + 1] += c * a[i]; o[i + 2] += a[i]; } return o; };
  for (let i = 0; i < w.length; i += 2) P = mul(P, -2 * Math.cos(w[i]));
  for (let i = 1; i < w.length; i += 2) Q = mul(Q, -2 * Math.cos(w[i]));
  const a = new Float64Array(w.length + 1);
  for (let k = 0; k <= w.length; k++) a[k] = (P[k] + Q[k]) / 2;
  return a;
}

// ------------------------------------------------------------------------------------------------ FFT (radix 2)
const COS = new Float64Array(C2_NDFT / 2), SIN = new Float64Array(C2_NDFT / 2);
for (let i = 0; i < C2_NDFT / 2; i++) { COS[i] = Math.cos(TWO_PI * i / C2_NDFT); SIN[i] = Math.sin(TWO_PI * i / C2_NDFT); }
const REV = (() => { const r = new Int32Array(C2_NDFT); const bits = Math.log2(C2_NDFT); for (let i = 0; i < C2_NDFT; i++) { let x = i, y = 0; for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; } r[i] = y; } return r; })();
/** In-place 512-point FFT; [inverse] uses e^{+j}, without the 1/N. */
export function fft512(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = C2_NDFT;
  for (let i = 0; i < n; i++) { const j = REV[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let s = 0; s < n; s += len) for (let k = 0; k < half; k++) {
      const c = COS[k * step], sn = inverse ? SIN[k * step] : -SIN[k * step];
      const a = s + k, b = a + half;
      const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}

/** The post filtered LPC power spectrum shape (bins 0..256) and the phase of H = 1/A at every bin. */
export function lpcSpectrum(a: ArrayLike<number>): { pw: Float64Array; phase: Float64Array } {
  const re = new Float64Array(C2_NDFT), im = new Float64Array(C2_NDFT), rg = new Float64Array(C2_NDFT), ig = new Float64Array(C2_NDFT);
  let g = 1;
  for (let k = 0; k < a.length; k++) { re[k] = a[k]; rg[k] = a[k] * g; g *= 0.5; }
  fft512(re, im, false); fft512(rg, ig, false);
  const pw = new Float64Array(C2_NDFT / 2 + 1), phase = new Float64Array(C2_NDFT / 2 + 1);
  for (let k = 0; k <= C2_NDFT / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k] + 1e-12, pg = rg[k] * rg[k] + ig[k] * ig[k];
    pw[k] = Math.pow(pg / p, 0.1) / p;                     // Rw^β with β = 0.2, Rw = |A(z/γ)| / |A(z)|
    phase[k] = -Math.atan2(im[k], re[k]);
  }
  return { pw, phase };
}

export class Codec2Decoder {
  private prev: C2Params = { wo: TWO_PI * 100 / C2_FS, voiced: false, eDb: OWN_E_MIN_DB, lsp: Float64Array.from({ length: 10 }, (_, i) => TWO_PI * (i + 1) * 360 / C2_FS) };
  private phi1 = 0;
  private tail = new Float64Array(C2_N);
  private seed = 1;
  constructor(readonly rate: 3200 | 1600) {}
  /** Samples a frame gives: 160 (3200) or 320 (1600). */
  get samples(): number { return this.rate === 3200 ? 160 : 320; }

  reset(): void { this.prev = { wo: TWO_PI * 100 / C2_FS, voiced: false, eDb: OWN_E_MIN_DB, lsp: Float64Array.from({ length: 10 }, (_, i) => TWO_PI * (i + 1) * 360 / C2_FS) }; this.phi1 = 0; this.tail.fill(0); this.seed = 1; }

  /** One frame (8 bytes) → 16-bit PCM at 8 kHz. */
  decode(frame: ArrayLike<number>): Int16Array {
    const out = new Int16Array(this.samples); const subs: C2Params[] = [];
    const p = this.prev;
    if (this.rate === 3200) {
      const f = unpack3200(frame);
      const b: C2Params = { wo: f.wo, voiced: f.v2, eDb: f.eDb, lsp: f.lsp };
      subs.push(interp(p, b, 0.5, f.v1), b);
    } else {
      const f = unpack1600(frame);
      const lspMid = mixLsp(p.lsp, f.lsp, 0.5);
      const a: C2Params = { wo: f.wo[0], voiced: f.v[1], eDb: f.eDb[0], lsp: lspMid };
      const b: C2Params = { wo: f.wo[1], voiced: f.v[3], eDb: f.eDb[1], lsp: f.lsp };
      const s1 = interp(p, a, 0.5, f.v[0]); s1.lsp = mixLsp(p.lsp, f.lsp, 0.25);
      const s3 = interp(a, b, 0.5, f.v[2]); s3.lsp = mixLsp(p.lsp, f.lsp, 0.75);
      subs.push(s1, a, s3, b);
    }
    for (let s = 0; s < subs.length; s++) this.synth(subs[s], out, s * C2_N);
    this.prev = subs[subs.length - 1];
    return out;
  }

  /** One 10 ms frame of [q] into [out] at [at]. */
  synth(q: C2Params, out: Int16Array, at: number): void {
    const wo = q.voiced ? q.wo : TWO_PI * 50 / C2_FS;
    const { pw, phase } = lpcSpectrum(lspToLpc(q.lsp));
    const L = Math.floor(Math.PI / wo), r = wo * C2_NDFT / TWO_PI;
    const shape = new Float64Array(L + 1); let sum = 0;
    for (let m = 1; m <= L; m++) {
      const am = Math.round((m - 0.5) * r), bm = Math.min(Math.round((m + 0.5) * r), C2_NDFT / 2);
      let e = 0; for (let k = am; k < bm; k++) e += pw[k];
      shape[m] = e; sum += e;
    }
    const power = Math.pow(10, q.eDb / 10);
    this.phi1 += C2_N * wo; this.phi1 -= TWO_PI * Math.floor(this.phi1 / TWO_PI);
    const re = new Float64Array(C2_NDFT), im = new Float64Array(C2_NDFT);
    for (let m = 1; m <= L; m++) {
      const k = Math.round(m * r); if (k >= C2_NDFT / 2 || k < 1) continue;
      const A = sum > 0 ? Math.sqrt(2 * power * shape[m] / sum) : 0;
      let th: number;
      if (q.voiced) th = m * this.phi1;
      else { this.seed = (Math.imul(this.seed, 1103515245) + 12345) & 0x7fffffff; th = this.seed / 2147483648 * TWO_PI - Math.PI; }
      th += phase[k];
      const mag = A * C2_NDFT / 2;
      re[k] += mag * Math.cos(th); im[k] += mag * Math.sin(th);
      re[C2_NDFT - k] += mag * Math.cos(th); im[C2_NDFT - k] -= mag * Math.sin(th);
    }
    fft512(re, im, true);
    for (let n = 0; n < C2_N; n++) {
      const y = this.tail[n] + re[C2_NDFT - C2_N + n] / C2_NDFT * (n / C2_N);
      this.tail[n] = re[n] / C2_NDFT * (1 - n / C2_N);
      const v = Math.round(y);
      out[at + n] = v > 32767 ? 32767 : v < -32767 ? -32767 : v;
    }
  }
}

function mixLsp(a: Float64Array, b: Float64Array, f: number): Float64Array {
  const o = new Float64Array(10); for (let i = 0; i < 10; i++) o[i] = a[i] * (1 - f) + b[i] * f; return o;
}
/** The parameters a fraction [f] of the way from [a] to [b], with voicing [v]: pitch from the voiced ends only. */
function interp(a: C2Params, b: C2Params, f: number, v: boolean): C2Params {
  let wo: number;
  if (a.voiced && b.voiced) wo = a.wo * (1 - f) + b.wo * f;
  else if (b.voiced) wo = b.wo; else if (a.voiced) wo = a.wo; else wo = b.wo;
  return { wo, voiced: v, eDb: a.eDb * (1 - f) + b.eDb * f, lsp: mixLsp(a.lsp, b.lsp, f) };
}
