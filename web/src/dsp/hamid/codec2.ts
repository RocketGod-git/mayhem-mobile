/*
 * Codec 2 speech decoder, 3200 and 1600 bit/s modes, for M17 voice.
 *
 * Ported from Codec 2 by David Rowe (github.com/drowe67/codec2, commit 310777b): codec2.c (codec2_decode_3200,
 * codec2_decode_1600, synthesise_one_frame, ear_protection), quantise.c (decode_Wo, decode_energy,
 * decode_lspds_scalar, decode_lsps_scalar, check_lsp_order, bw_expand_lsps, aks_to_M2, lpc_post_filter,
 * apply_lpc_correction), interp.c (interp_Wo2, interp_energy, interpolate_lsp_ver2), phase.c (sample_phase,
 * phase_synth_zero_order), postfilter.c (postfilter), sine.c (c2const_create, make_synthesis_window, synthesise,
 * codec2_rand), lsp.c (lsp_to_lpc), pack.c (unpack, Gray coded) and the LSP codebooks codebook/lsp1..10.txt and
 * codebook/dlsp1..10.txt.
 *
 * Codec 2: Copyright (C) 1990-2010 David Rowe. pack.c: Copyright (C) 2010 Perens LLC. Ported for Mayhem Mobile.
 *
 * This file is free software; you can redistribute it and/or modify it under the terms of the GNU Lesser General
 * Public License version 2.1, as published by the Free Software Foundation. It is distributed in the hope that it
 * will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
 * PARTICULAR PURPOSE. See the GNU Lesser General Public License for more details. You should have received a copy
 * of the GNU Lesser General Public License along with this file; if not, see <http://www.gnu.org/licenses/>.
 *
 * The reference works in 32-bit float and this port in double, so its PCM is close to c2dec's but not
 * bit-identical. The same as Android's core/hamid/Codec2.kt and the Swift HamIdCodec2.swift. No DOM.
 */

export const C2_FS = 8000, C2_N = 80, C2_NDFT = 512, C2_P = 10;
/** The reference's own constants (defines.h), kept as written so the decisions they feed match. */
const PI = 3.141592654, TWO_PI = 6.283185307;
const P_MIN = 20, P_MAX = 160;                       // c2const_create at 8 kHz: 2.5 ms and 20 ms
/**
 * The reference keeps Wo, the bin width r and the excitation phase in 32-bit float, and the harmonic count and
 * the bin of each harmonic are whole-number cuts of them, so those are rounded to float here as there.
 */
const f32 = Math.fround;
export const WO_MIN = f32(TWO_PI / P_MAX), WO_MAX = f32(TWO_PI / P_MIN);
const R_BIN = f32(TWO_PI / 512);
const WO_BITS = 7, E_BITS = 5, E_MIN_DB = -10, E_MAX_DB = 40;
const LPCPF_BETA = 0.2, LPCPF_GAMMA = 0.5;
const BG_THRESH = 40, BG_BETA = 0.1, BG_MARGIN = 6;
const RAND_MAX = 32767;

/** codebook/dlsp1..10.txt: the 3200 mode's LSP difference quantizers (Hz), 5 bits each. */
const DLSP_A = Array.from({ length: 32 }, (_, i) => 25 * (i + 1));
const DLSP_B = [25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950, 1000, 1050, 1100, 1150, 1200, 1250, 1300, 1350, 1400];
export const LSPD_CB: number[][] = [DLSP_A, DLSP_A, DLSP_A, DLSP_B, DLSP_B, DLSP_B, DLSP_A, DLSP_A, DLSP_A, DLSP_A];
/** codebook/lsp1..10.txt: the 1600 mode's scalar LSP quantizers (Hz). */
export const LSP_CB: number[][] = [
  [225, 250, 275, 300, 325, 350, 375, 400, 425, 450, 475, 500, 525, 550, 575, 600],
  [325, 350, 375, 400, 425, 450, 475, 500, 525, 550, 575, 600, 625, 650, 675, 700],
  [500, 550, 600, 650, 700, 750, 800, 850, 900, 950, 1000, 1050, 1100, 1150, 1200, 1250],
  [700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200],
  [950, 1050, 1150, 1250, 1350, 1450, 1550, 1650, 1750, 1850, 1950, 2050, 2150, 2250, 2350, 2450],
  [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600],
  [1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800, 2900, 3000],
  [2300, 2400, 2500, 2600, 2700, 2800, 2900, 3000],
  [2500, 2600, 2700, 2800, 2900, 3000, 3100, 3200],
  [2900, 3100, 3300, 3500],
];
export const LSP_BITS = [4, 4, 4, 4, 4, 4, 4, 3, 3, 2];

/** pack.c unpack(): MSB first, every field Gray coded. */
export class BitReader {
  private p = 0;
  constructor(private readonly b: ArrayLike<number>) {}
  natural(n: number): number { let v = 0; for (let i = 0; i < n; i++, this.p++) v = (v << 1) | ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1); return v; }
  read(n: number): number { let t = this.natural(n); t ^= t >> 8; t ^= t >> 4; t ^= t >> 2; t ^= t >> 1; return t; }
}

export const decodeWo = (i: number) => f32(WO_MIN + f32(f32(f32(WO_MAX - WO_MIN) / (1 << WO_BITS)) * i));
export const decodeEnergy = (i: number) => Math.pow(10, (E_MIN_DB + (E_MAX_DB - E_MIN_DB) / (1 << E_BITS) * i) / 10);
/** The harmonic count, C's (int)(PI / Wo). */
const harmonics = (wo: number) => Math.trunc(PI / wo);

export function decodeLspds(idx: ArrayLike<number>): Float64Array {
  const lsp = new Float64Array(C2_P); let hz = 0;
  for (let i = 0; i < C2_P; i++) { hz += LSPD_CB[i][idx[i]]; lsp[i] = (PI / 4000) * hz; }
  return lsp;
}
export function decodeLsps(idx: ArrayLike<number>): Float64Array {
  return Float64Array.from({ length: C2_P }, (_, i) => (PI / 4000) * LSP_CB[i][idx[i]]);
}
/** quantise.c check_lsp_order as written (its restart lands on i = 2), capped so bad bits cannot loop it. */
export function checkLspOrder(lsp: Float64Array): number {
  let swaps = 0;
  for (let i = 1; i < lsp.length && swaps < 1000; i++) if (lsp[i] < lsp[i - 1]) {
    swaps++; const t = lsp[i - 1]; lsp[i - 1] = lsp[i] - 0.1; lsp[i] = t + 0.1; i = 1;
  }
  return swaps;
}
export function bwExpandLsps(lsp: Float64Array, minLow: number, minHigh: number): void {
  for (let i = 1; i < 4; i++) if (lsp[i] - lsp[i - 1] < minLow * (PI / 4000)) lsp[i] = lsp[i - 1] + minLow * (PI / 4000);
  for (let i = 4; i < lsp.length; i++) if (lsp[i] - lsp[i - 1] < minHigh * (PI / 4000)) lsp[i] = lsp[i - 1] + minHigh * (PI / 4000);
}

/** 3200: the frame's two voicing bits, Wo, energy and LSPs (radians) as sent. */
export function unpack3200(b: ArrayLike<number>): { v1: boolean; v2: boolean; wo: number; e: number; lsp: Float64Array } {
  const r = new BitReader(b);
  const v1 = r.read(1) === 1, v2 = r.read(1) === 1;
  const wo = decodeWo(r.read(WO_BITS)), e = decodeEnergy(r.read(E_BITS));
  const idx = Array.from({ length: C2_P }, () => r.read(5));
  return { v1, v2, wo, e, lsp: decodeLspds(idx) };
}
/** 1600: four voicing bits, the Wo and energy of the second and fourth 10 ms, the LSPs (ordered and spread). */
export function unpack1600(b: ArrayLike<number>): { v: boolean[]; wo: [number, number]; e: [number, number]; lsp: Float64Array } {
  const r = new BitReader(b);
  const v0 = r.read(1) === 1;
  const v1 = r.read(1) === 1, wo1 = decodeWo(r.read(WO_BITS)), e1 = decodeEnergy(r.read(E_BITS));
  const v2 = r.read(1) === 1;
  const v3 = r.read(1) === 1, wo3 = decodeWo(r.read(WO_BITS)), e3 = decodeEnergy(r.read(E_BITS));
  const idx = LSP_BITS.map(n => r.read(n));
  const lsp = decodeLsps(idx);
  checkLspOrder(lsp); bwExpandLsps(lsp, 50, 100);
  return { v: [v0, v1, v2, v3], wo: [wo1, wo3], e: [e1, e3], lsp };
}

/** lsp.c lsp_to_lpc: A(z) = (P(z) + Q(z)) / 2, ω1, ω3, ... in P = (1 + z^-1)Π, ω2, ω4, ... in Q = (1 - z^-1)Π. */
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
for (let i = 0; i < C2_NDFT / 2; i++) { COS[i] = Math.cos(2 * Math.PI * i / C2_NDFT); SIN[i] = Math.sin(2 * Math.PI * i / C2_NDFT); }
const REV = (() => { const r = new Int32Array(C2_NDFT); const bits = Math.log2(C2_NDFT); for (let i = 0; i < C2_NDFT; i++) { let x = i, y = 0; for (let b = 0; b < bits; b++) { y = (y << 1) | (x & 1); x >>= 1; } r[i] = y; } return r; })();
/** In-place 512-point FFT; [inverse] uses e^{+j}, without the 1/N (as kiss_fft). */
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

/** sine.c make_synthesis_window: the trapezoid (a triangle at 8 kHz), its ramps summed in float as the reference does. */
const PN = (() => {
  const n = C2_N, tw = 40, pn = new Float64Array(2 * n); let win = 0;
  for (let i = n / 2 - tw; i < n / 2 + tw; i++) { pn[i] = win; win = Math.fround(win + 1 / (2 * tw)); }
  for (let i = n / 2 + tw; i < 3 * n / 2 - tw; i++) pn[i] = 1;
  win = 1;
  for (let i = 3 * n / 2 - tw; i < 3 * n / 2 + tw; i++) { pn[i] = win; win = Math.fround(win - 1 / (2 * tw)); }
  return pn;
})();

/** One 10 ms frame's model: pitch, harmonic count, amplitudes and phases (index 1..L), voicing. */
export interface C2Model { wo: number; L: number; A: Float64Array; phi: Float64Array; voiced: boolean }
const newModel = (wo: number, voiced: boolean): C2Model => ({ wo, L: wo > 0 ? harmonics(wo) : 0, A: new Float64Array(161), phi: new Float64Array(161), voiced });

/** interp.c interp_Wo2 with weight 0.5 (interp_Wo). */
function interpWo(m: C2Model, prev: C2Model, next: C2Model): void {
  if (m.voiced && !prev.voiced && !next.voiced) m.voiced = false;
  if (m.voiced) {
    if (prev.voiced && next.voiced) m.wo = f32(0.5 * prev.wo + 0.5 * next.wo);
    if (!prev.voiced && next.voiced) m.wo = next.wo;
    if (prev.voiced && !next.voiced) m.wo = prev.wo;
  } else m.wo = WO_MIN;
  m.L = harmonics(m.wo);
}

/**
 * quantise.c aks_to_M2 with the LPC post filter (lpc_post_filter, β = 0.2, γ = 0.5, bass boost on): the harmonic
 * amplitudes into [m].A from the band energies of E/|A|², and A(e^jω) for the phases.
 */
export function aksToM2(ak: ArrayLike<number>, m: C2Model, E: number): { awRe: Float64Array; awIm: Float64Array } {
  const awRe = new Float64Array(C2_NDFT), awIm = new Float64Array(C2_NDFT);
  for (let i = 0; i < ak.length; i++) awRe[i] = ak[i];
  fft512(awRe, awIm, false);
  const H = C2_NDFT / 2, pw = new Float64Array(H);
  for (let i = 0; i < H; i++) pw[i] = 1 / (awRe[i] * awRe[i] + awIm[i] * awIm[i] + 1e-6);
  // lpc_post_filter
  const wr = new Float64Array(C2_NDFT), wi = new Float64Array(C2_NDFT);
  wr[0] = ak[0]; let coeff = LPCPF_GAMMA;
  for (let i = 1; i < ak.length; i++) { wr[i] = ak[i] * coeff; coeff *= LPCPF_GAMMA; }
  fft512(wr, wi, false);
  let eBefore = 1e-4, eAfter = 1e-4;
  for (let i = 0; i < H; i++) eBefore += pw[i];
  for (let i = 0; i < H; i++) {
    const rw = Math.sqrt((wr[i] * wr[i] + wi[i] * wi[i]) * pw[i]), pfw = Math.pow(rw, LPCPF_BETA);
    pw[i] *= pfw * pfw; eAfter += pw[i];
  }
  const gain = eBefore / eAfter * E;
  for (let i = 0; i < H; i++) pw[i] *= gain;
  for (let i = 0; i < C2_NDFT / 8; i++) pw[i] *= 1.4 * 1.4;            // bass boost: +3 dB below 1 kHz
  // band energies
  const r = R_BIN;
  for (let k = 1; k <= m.L; k++) {
    const am = Math.trunc((k - 0.5) * m.wo / r + 0.5); let bm = Math.trunc((k + 0.5) * m.wo / r + 0.5);
    if (bm > H) bm = H;
    let em = 0; for (let i = am; i < bm; i++) em += pw[i];
    m.A[k] = Math.sqrt(em);
  }
  return { awRe, awIm };
}

export class Codec2Decoder {
  private prev: C2Model = newModel(WO_MIN, false);
  private prevLsps = new Float64Array(C2_P);
  private prevE = 1;
  private exPhase = 0;
  private bgEst = 0;
  private sn = new Float64Array(2 * C2_N);
  private seed = 1;
  constructor(readonly rate: 3200 | 1600) { this.reset(); }
  /** Samples a frame gives: 160 (3200) or 320 (1600). */
  get samples(): number { return this.rate === 3200 ? 160 : 320; }

  /** codec2_create's decoder state. */
  reset(): void {
    this.prev = newModel(WO_MIN, false);
    this.prevLsps = Float64Array.from({ length: C2_P }, (_, i) => i * PI / (C2_P + 1));
    this.prevE = 1; this.exPhase = 0; this.bgEst = 0; this.sn.fill(0); this.seed = 1;
  }

  /** sine.c codec2_rand: 0..32767. */
  private rand(): number { this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0; return (this.seed >>> 16) & 0x7fff; }

  /** One frame (8 bytes) → 16-bit PCM at 8 kHz. */
  decode(frame: ArrayLike<number>): Int16Array {
    const out = new Int16Array(this.samples);
    if (this.rate === 3200) {
      const f = unpack3200(frame);
      const m0 = newModel(0, f.v1), m1 = newModel(f.wo, f.v2);
      interpWo(m0, this.prev, m1);
      const lsp0 = new Float64Array(C2_P);
      for (let i = 0; i < C2_P; i++) lsp0[i] = 0.5 * this.prevLsps[i] + 0.5 * f.lsp[i];
      this.synthFrame(m0, lsp0, Math.sqrt(this.prevE * f.e), out, 0);
      this.synthFrame(m1, f.lsp, f.e, out, C2_N);
      this.prev = m1; this.prevE = f.e; this.prevLsps = f.lsp;
    } else {
      const f = unpack1600(frame);
      const m = [newModel(0, f.v[0]), newModel(f.wo[0], f.v[1]), newModel(0, f.v[2]), newModel(f.wo[1], f.v[3])];
      interpWo(m[0], this.prev, m[1]);
      interpWo(m[2], m[1], m[3]);
      const e = [Math.sqrt(this.prevE * f.e[0]), f.e[0], Math.sqrt(f.e[0] * f.e[1]), f.e[1]];
      for (let k = 0; k < 4; k++) {
        let lsp = f.lsp;
        if (k < 3) { const w = 0.25 * (k + 1); lsp = new Float64Array(C2_P); for (let i = 0; i < C2_P; i++) lsp[i] = (1 - w) * this.prevLsps[i] + w * f.lsp[i]; }
        this.synthFrame(m[k], lsp, e[k], out, k * C2_N);
      }
      this.prev = m[3]; this.prevE = f.e[1]; this.prevLsps = f.lsp;
    }
    return out;
  }

  /** LSPs and energy → amplitudes (aks_to_M2, apply_lpc_correction), then synthesise_one_frame into [out] at [at]. */
  private synthFrame(m: C2Model, lsp: Float64Array, E: number, out: Int16Array, at: number): void {
    const { awRe, awIm } = aksToM2(lspToLpc(lsp), m, E);
    if (m.wo < PI * 150 / 4000) m.A[1] *= 0.032;
    // sample_phase + phase_synth_zero_order: H = conj(A) at each harmonic, excitation m·φ1 (voiced) or random
    const r = R_BIN;
    this.exPhase = f32(this.exPhase + f32(m.wo * C2_N));
    this.exPhase = f32(this.exPhase - TWO_PI * Math.floor(f32(this.exPhase / TWO_PI + 0.5)));
    for (let k = 1; k <= m.L; k++) {
      const b = Math.trunc(f32(f32(k * m.wo) / r) + 0.5), hr = awRe[b], hi = -awIm[b];
      let er: number, ei: number;
      if (m.voiced) { const x = f32(this.exPhase * k); er = Math.cos(x); ei = Math.sin(x); }
      else { const phi = TWO_PI * this.rand() / RAND_MAX; er = Math.cos(phi); ei = Math.sin(phi); }
      m.phi[k] = Math.atan2(hi * er + hr * ei, hr * er - hi * ei + 1e-12);
    }
    // postfilter: in voiced frames, harmonics under the background noise estimate get random phases
    let en = 1e-12; for (let k = 1; k <= m.L; k++) en += m.A[k] * m.A[k];
    en = 10 * Math.log10(en / m.L);
    if (en < BG_THRESH && !m.voiced) this.bgEst = this.bgEst * (1 - BG_BETA) + en * BG_BETA;
    const thresh = Math.pow(10, (this.bgEst + BG_MARGIN) / 20);
    if (m.voiced) for (let k = 1; k <= m.L; k++) if (m.A[k] < thresh) m.phi[k] = (TWO_PI / RAND_MAX) * this.rand();
    // synthesis (sine.c synthesise): one bin per harmonic, inverse DFT, trapezoid overlap-add
    const sn = this.sn, n = C2_N;
    for (let i = 0; i < n - 1; i++) sn[i] = sn[i + n];
    sn[n - 1] = 0;
    const re = new Float64Array(C2_NDFT), im = new Float64Array(C2_NDFT);
    for (let k = 1; k <= m.L; k++) {
      let b = Math.trunc(f32(f32(k * m.wo) * C2_NDFT) / TWO_PI + 0.5);
      if (b > C2_NDFT / 2 - 1) b = C2_NDFT / 2 - 1;
      re[b] = m.A[k] * Math.cos(m.phi[k]); im[b] = m.A[k] * Math.sin(m.phi[k]);
    }
    for (let k = 1; k < C2_NDFT / 2; k++) { re[C2_NDFT - k] = re[k]; im[C2_NDFT - k] = -im[k]; }
    fft512(re, im, true);
    for (let i = 0; i < n - 1; i++) sn[i] += re[C2_NDFT - n + 1 + i] * PN[i];
    for (let i = n - 1, j = 0; i < 2 * n; i++, j++) sn[i] = re[j] * PN[i];
    // ear_protection, then C's float to short
    let max = 0; for (let i = 0; i < n; i++) if (sn[i] > max) max = sn[i];
    const over = max / 30000;
    if (over > 1) { const g = 1 / (over * over); for (let i = 0; i < n; i++) sn[i] *= g; }
    for (let i = 0; i < n; i++) out[at + i] = sn[i] > 32767 ? 32767 : sn[i] < -32767 ? -32767 : Math.trunc(sn[i]);
  }
}
