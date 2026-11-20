/**
 * TETRA speech, receive side (ETSI EN 300 395-2), written from the standard's text and tables. No DOM.
 *
 *  - Channel decoding of the speech traffic channel (clauses 5 and 6, annex A). A full slot carries two 137-bit speech
 *    frames: the 432 type-4 bits are de-interleaved by the (24,18) matrix transpose of 5.5.3 (C4(24 i + j) = C3(18 j +
 *    i), counted from 0); the first 102 bits are class 0, sent as they are; the next 168 are class 1, the 16-state
 *    rate 1/3 mother code (G1 = 1 + D + D^2 + D^3 + D^4, G2 = 1 + D + D^3 + D^4, G3 = 1 + D^2 + D^4) punctured to
 *    rate 2/3 (P = 1, 2, 4, period 6); the last 162 are class 2 with its 8 parity bits and 4 tail bits at rate 8/18
 *    (P = 1, 2, 3, 4, 5, 7, 8, 10, 11, period 12), one code running on from class 1 into class 2. The parity is
 *    G(X) = 1 + X^3 + X^7 over the 60 class 2 bits plus an overall parity bit; a mismatch is a bad frame (BFI). A
 *    half slot (frame stealing) carries one frame: interleaved like the STCH ((216,101), EN 300 392-2 8.2.4.1),
 *    51 class 0 bits, 84 class 1 bits at rate 2/3 and 81 class 2 bits at rate 8/17 (P = 1, 2, 3, 4, 5, 7, 8, 10, 11,
 *    13, 14, 16, 17, 19, 20, 22, 23, period 24), parity G(X) = 1 + X + X^4. Table 5 and Table 6 give the order of
 *    the bits.
 *  - The ACELP decoder of clause 4.2.3: per 30 ms frame the LSPs from the split vector codebooks (3, 3 and 4
 *    values, 8, 9 and 9 bits), interpolated over the four 7.5 ms subframes (equation 22) and turned into the LP
 *    filter (clause 4.2.2.2); per subframe the pitch delay (1/3 resolution from 19 1/3 to 84 2/3 and whole samples to
 *    143 in the first subframe, 1/3 resolution within T1 - 5 2/3 to T1 + 4 2/3 in the others), the adaptive codebook
 *    vector interpolated from the past excitation by a Hamming windowed sinc truncated at 16 samples, the four
 *    algebraic pulses (Table 2) shaped by F(z) = A(z/0.75) / A(z/0.85) and the fixed pitch contribution for delays
 *    under 60 (f(n) + 0.8 f(n - T)), and the two gains from the predicted energies and the 6-bit vector quantizer
 *    of the prediction errors (4.2.2.6). The excitation drives 1 / A(z); the output is doubled with saturation
 *    (4.2.1). A bad frame is concealed as 4.2.3.2 says.
 *  The decoder works in floating point on the scale of the bit exact description (16-bit samples), so it follows
 *  the standard's algorithm without being bit exact.
 */
import { tetraViterbi, tetraDeinterleave } from './tetra.js';
import { TETRA_LSP1, TETRA_LSP2, TETRA_LSP3, TETRA_GAINS, tetraTable } from './tetra-tables.js';

/** Table 6: the speech frame bit (B1 to B137) carried by each type-2 bit of a half slot; Table 5 is this order with
 *  frames A and B alternating (type-2 bit 2k - 1 is frame A, 2k frame B). Class 0 is 1 to 51, class 1 52 to 107,
 *  class 2 108 to 137. */
export const TETRA_SPEECH_ORDER = [
  35, 36, 37, 38, 39, 40, 41, 42, 43, 47, 48, 56, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 74, 75, 83, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 101, 102, 110, 115, 116, 117,
  118, 119, 120, 121, 122, 123, 124, 128, 129, 137,
  58, 85, 112, 54, 81, 108, 135, 50, 77, 104, 131, 45, 72, 99, 126, 55, 82, 109, 136, 5, 13, 34, 8, 16, 17, 22, 23, 24, 25, 26, 6, 14, 7, 15, 60, 87, 114, 46, 73, 100,
  127, 44, 71, 98, 125, 33, 49, 76, 103, 130, 59, 86, 113, 57, 84, 111,
  18, 19, 20, 21, 31, 32, 53, 80, 107, 134, 1, 2, 3, 4, 9, 10, 11, 12, 27, 28, 29, 30, 52, 79, 106, 133, 51, 78, 105, 132];
/** The speech mother code (5.4.3.1). */
export const TETRA_G3 = [0b11111, 0b11011, 0b10101];
const P23 = [1, 2, 4], P818 = [1, 2, 3, 4, 5, 7, 8, 10, 11], P817 = [1, 2, 3, 4, 5, 7, 8, 10, 11, 13, 14, 16, 17, 19, 20, 22, 23];

/** The parity of [bits] by G(X): F(X) = X^p I(X) mod G(X), I(X) = C(1) + C(2) X + ... (5.4.2); [g] holds the
 *  exponents of G below X^p. Returns f(0) .. f(p - 1). */
export function tetraSpeechCrc(bits: ArrayLike<number>, p: number, g: number[]): number[] {
  const n = bits.length, poly = new Uint8Array(n + p);
  for (let i = 0; i < n; i++) poly[p + i] = bits[i] & 1;
  for (let d = n + p - 1; d >= p; d--) if (poly[d]) { poly[d] = 0; for (const e of g) poly[d - p + e] ^= 1; }
  return Array.from(poly.subarray(0, p));
}
/** Depunctured class 1 and class 2 type-3 soft bits to the mother code's input bits (Viterbi, rate 1/3). */
function speechViterbi(c1: Float32Array, c2: Float32Array, n1: number, n2: number, p2: number[], per2: number): Uint8Array {
  const m = new Float32Array(3 * (n1 + n2));
  for (let j = 1; j <= c1.length; j++) m[6 * Math.floor((j - 1) / 3) + P23[(j - 1) % 3] - 1] = c1[j - 1];
  const t = p2.length, o = 3 * n1;
  for (let j = 1; j <= c2.length; j++) { const k = per2 * Math.floor((j - 1) / t) + p2[(j - 1) % t]; if (k <= 3 * n2) m[o + k - 1] = c2[j - 1]; }
  return tetraViterbi(m, n1 + n2, TETRA_G3);
}
export interface TetraSpeech { frames: Uint8Array[]; bfi: boolean }
/**
 * A full slot of TCH/S: 432 type-4 soft bits (descrambled; +1 for 0) to two speech frames of 137 bits (B1 first).
 * [bfi] is set when the class 2 parity fails.
 */
export function tetraTchFull(c4: ArrayLike<number>): TetraSpeech {
  const c3 = new Float32Array(432);
  for (let i = 0; i < 18; i++) for (let j = 0; j < 24; j++) c3[j * 18 + i] = c4[i * 24 + j];
  const dec = speechViterbi(c3.subarray(102, 270), c3.subarray(270, 432), 112, 72, P818, 12);
  const c2 = new Uint8Array(286);
  for (let i = 0; i < 102; i++) c2[i] = c3[i] < 0 ? 1 : 0;
  c2.set(dec, 102);
  const cls2 = c2.subarray(214, 274), f = tetraSpeechCrc(cls2, 7, [0, 3]);
  let par = 0; for (const b of cls2) par ^= b; for (const b of f) par ^= b;
  let bfi = par !== c2[281];
  for (let i = 0; i < 7; i++) if (f[i] !== c2[274 + i]) bfi = true;
  const frames = [new Uint8Array(137), new Uint8Array(137)];
  for (let p = 0; p < 274; p++) frames[p & 1][TETRA_SPEECH_ORDER[p >> 1] - 1] = c2[p];
  return { frames, bfi };
}
/** A half slot of TCH/S (the second half of a stolen slot): 216 type-4 soft bits to one speech frame. */
export function tetraTchHalf(b4: ArrayLike<number>): TetraSpeech {
  const c3 = tetraDeinterleave(b4, 101);
  const dec = speechViterbi(c3.subarray(51, 135), c3.subarray(135, 216), 56, 38, P817, 24);
  const c2 = new Uint8Array(145);
  for (let i = 0; i < 51; i++) c2[i] = c3[i] < 0 ? 1 : 0;
  c2.set(dec, 51);
  const f = tetraSpeechCrc(c2.subarray(107, 137), 4, [0, 1]);
  let bfi = false; for (let i = 0; i < 4; i++) if (f[i] !== c2[137 + i]) bfi = true;
  const frame = new Uint8Array(137);
  for (let p = 0; p < 137; p++) frame[TETRA_SPEECH_ORDER[p] - 1] = c2[p];
  return { frames: [frame], bfi };
}

/** The parameters of one 137-bit speech frame (Table 3). */
export interface TetraFrameParams { lsp: [number, number, number]; pitch: number[]; pulses: number[][]; sign: number[]; shift: number[]; gains: number[] }
export function tetraFrameParams(b: ArrayLike<number>): TetraFrameParams {
  let i = 0; const f = (n: number) => { let v = 0; for (let k = 0; k < n; k++) v = (v << 1) | (b[i++] & 1); return v; };
  const lsp: [number, number, number] = [f(8), f(9), f(9)];
  const pitch: number[] = [], pulses: number[][] = [], sign: number[] = [], shift: number[] = [], gains: number[] = [];
  for (let s = 0; s < 4; s++) {
    pitch.push(f(s === 0 ? 8 : 5));
    const p4 = f(3), p3 = f(3), p2 = f(3), p1 = f(5);
    pulses.push([p1, p2, p3, p4]); sign.push(f(1)); shift.push(f(1)); gains.push(f(6));
  }
  return { lsp, pitch, pulses, sign, shift, gains };
}

let LSP1: Int16Array, LSP2: Int16Array, LSP3: Int16Array, GAINS: Int16Array;
const tables = () => { if (!LSP1) { LSP1 = tetraTable(TETRA_LSP1); LSP2 = tetraTable(TETRA_LSP2); LSP3 = tetraTable(TETRA_LSP3); GAINS = tetraTable(TETRA_GAINS); } };
/** The LSP vector (cosine domain) of three codebook indices. */
export function tetraLsp(i1: number, i2: number, i3: number): Float64Array {
  tables();
  const q = new Float64Array(10);
  for (let k = 0; k < 3; k++) q[k] = LSP1[3 * i1 + k] / 32768;
  for (let k = 0; k < 3; k++) q[3 + k] = LSP2[3 * i2 + k] / 32768;
  for (let k = 0; k < 4; k++) q[6 + k] = LSP3[4 * i3 + k] / 32768;
  return q;
}
/** The quantized pitch and code energy prediction errors (log2) of a gain index. */
export function tetraGainErrors(idx: number): [number, number] { tables(); return [GAINS[2 * idx] / 256, GAINS[2 * idx + 1] / 256]; }
/** LSPs (cosine domain) to the LP coefficients a1 .. a10 of A(z) = 1 + sum a_i z^-i (clause 4.2.2.2). */
export function tetraLspToA(q: ArrayLike<number>): Float64Array {
  const poly = (o: number) => {
    const f = new Float64Array(6); f[0] = 1;
    for (let i = 1; i <= 5; i++) {
      const c = q[2 * (i - 1) + o];
      f[i] = -2 * c * f[i - 1] + 2 * (i >= 2 ? f[i - 2] : 0);
      for (let j = i - 1; j >= 1; j--) f[j] = f[j] - 2 * c * f[j - 1] + (j >= 2 ? f[j - 2] : 0);
    }
    return f;
  };
  const f1 = poly(0), f2 = poly(1), a = new Float64Array(11); a[0] = 1;
  for (let i = 5; i >= 1; i--) { f1[i] += f1[i - 1]; f2[i] -= f2[i - 1]; }
  for (let i = 1; i <= 5; i++) { a[i] = 0.5 * (f1[i] + f2[i]); a[11 - i] = 0.5 * (f1[i] - f2[i]); }
  return a;
}
/** The pitch delay of a subframe: [whole, third] (third -1, 0 or +1) from its index; [t1] is the first subframe's whole delay. */
export function tetraPitch(idx: number, sf: number, t1: number): [number, number] {
  if (sf === 0) {
    if (idx < 197) { const t0 = Math.floor((idx + 2) / 3) + 19; return [t0, idx - 3 * t0 + 58]; }
    return [idx - 112, 0];
  }
  let tmin = t1 - 5; if (tmin < 20) tmin = 20;
  if (tmin + 9 > 143) tmin = 134;
  const t0 = Math.floor((idx + 2) / 3) - 1 + tmin;
  return [t0, idx - 2 - 3 * (Math.floor((idx + 2) / 3) - 1)];
}
/** The interpolation filter for the past excitation: sinc times a Hamming window, truncated at 16 samples (4.2.2.4). */
const HALF = 16;
function interp(t: number): number {
  if (Math.abs(t) >= HALF) return 0;
  const w = 0.54 + 0.46 * Math.cos(Math.PI * t / HALF);
  return t === 0 ? 1 : w * Math.sin(Math.PI * t) / (Math.PI * t);
}
/**
 * The decoded LSPs kept to the ordering property of 4.2.2.2 (0 < w1 < ... < w10 < pi), so 1 / A(z) stays stable:
 * the three split vectors can meet out of order. Neighbors closer than [LSP_GAP] (in frequency, radians) are spread
 * about their mean, twice over, and the set is put in order. Our own rule, not from the standard's text; it brings
 * the decoder's output closest to the standard's decoder test sequence.
 */
const LSP_GAP = 0.04;
export function tetraLspOrder(q: ArrayLike<number>): Float64Array {
  const w = Array.from(q, x => Math.acos(Math.max(-1, Math.min(1, x))));
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 9; i++) if (w[i + 1] - w[i] < LSP_GAP) { const m = (w[i] + w[i + 1]) / 2; w[i] = m - LSP_GAP / 2; w[i + 1] = m + LSP_GAP / 2; }
  w.sort((x, y) => x - y);
  return Float64Array.from(w, x => Math.cos(x));
}
const sat = (x: number) => x > 32767 ? 32767 : x < -32768 ? -32768 : x;
/**
 * The energies of 4.2.2.6 are taken on the scale of the bit exact description: log2 of the energy over 40 (16-bit
 * samples). The text leaves the scale out; this one reproduces the level of the standard's decoder test sequence.
 */
const ESCALE = Math.log2(40);
const L_SF = 60, PIT_MAX = 143, Q_INIT = [30000, 26000, 21000, 15000, 8000, 0, -8000, -15000, -21000, -26000].map(v => v / 32768);
/** The amplitudes of the four pulses (Table 2). */
const AMP = [1.4142, -1, 1, -1];

/** The TETRA ACELP speech decoder: one 137-bit frame (or null for a bad frame) to 240 samples of 8 kHz audio in -1 .. 1. */
export class TetraAcelp {
  private qPrev = Float64Array.from(Q_INIT);
  private exc = new Float64Array(PIT_MAX + HALF + 1 + 4 * L_SF);
  private mem = new Float64Array(10);
  private ep = 0; private ec = 0;
  private last: TetraFrameParams | null = null; private lastT = 60;
  /** Frames decoded, and how many of them were bad (concealed). */
  frames = 0; bad = 0;
  reset(): void { this.qPrev = Float64Array.from(Q_INIT); this.exc.fill(0); this.mem.fill(0); this.ep = 0; this.ec = 0; this.last = null; this.lastT = 60; this.frames = 0; this.bad = 0; }
  decode(bits: ArrayLike<number> | null): Float32Array {
    this.frames++;
    const bfi = !bits;
    if (bfi) this.bad++;
    const p = bits ? tetraFrameParams(bits) : this.last;
    const out = new Float32Array(4 * L_SF);
    if (!p) { this.ep -= 0.5; this.ec -= 0.5; return out; }
    if (!bfi) this.last = p;
    const q = bfi ? this.qPrev : tetraLspOrder(tetraLsp(p.lsp[0], p.lsp[1], p.lsp[2]));
    const base = PIT_MAX + HALF + 1, exc = this.exc;
    let t1 = 0;
    for (let sf = 0; sf < 4; sf++) {
      const w = [0.25, 0.5, 0.75, 1][sf], qs = new Float64Array(10);
      for (let i = 0; i < 10; i++) qs[i] = (1 - w) * this.qPrev[i] + w * q[i];
      const a = tetraLspToA(qs);
      // pitch: a bad frame repeats the last good whole delay, with no fraction
      let t0: number, fr: number;
      if (bfi) { t0 = this.lastT; fr = 0; }
      else { [t0, fr] = tetraPitch(p.pitch[sf], sf, t1); if (sf === 0) t1 = t0; }
      if (!bfi && sf === 3) this.lastT = t0;
      // the adaptive codebook vector: the past excitation at the delay t0 + fr / 3, filled in place
      const o = base + sf * L_SF, d = t0 + fr / 3, v = new Float64Array(L_SF);
      for (let n = 0; n < L_SF; n++) {
        const c = o + n - d, m0 = Math.ceil(c - HALF), m1 = Math.floor(c + HALF);
        let s = 0; for (let m = m0; m <= m1; m++) s += exc[m] * interp(c - m);
        v[n] = s; exc[o + n] = s;
      }
      // the algebraic code: four pulses, shaped by F(z) = A(z/0.75) / A(z/0.85) and the fixed pitch contribution
      const f = new Float64Array(L_SF), num = new Float64Array(11), den = new Float64Array(11);
      for (let i = 0; i <= 10; i++) { num[i] = a[i] * Math.pow(0.75, i); den[i] = a[i] * Math.pow(0.85, i); }
      for (let n = 0; n < L_SF; n++) { let s = n <= 10 ? num[n] : 0; for (let i = 1; i <= 10 && i <= n; i++) s -= den[i] * f[n - i]; f[n] = s; }
      if (t0 < L_SF) for (let n = t0; n < L_SF; n++) f[n] += 0.8 * f[n - t0];
      const pl = p.pulses[sf], sh = p.shift[sf], sg = p.sign[sf] ? -1 : 1;
      const pos = [2 * pl[0], 2 + 8 * pl[1], 4 + 8 * pl[2], 6 + 8 * pl[3]].map(x => x + sh);
      const c = new Float64Array(L_SF);
      for (let k = 0; k < 4; k++) { const m = pos[k]; if (m >= L_SF) continue; for (let n = m; n < L_SF; n++) c[n] += sg * AMP[k] * f[n - m]; }
      // the gains, from the energies: predicted from the last subframe's, corrected by the quantized prediction errors
      const h = new Float64Array(L_SF);
      for (let n = 0; n < L_SF; n++) { let s = n === 0 ? 1 : 0; for (let i = 1; i <= 10 && i <= n; i++) s -= a[i] * h[n - i]; h[n] = s; }
      let pg = 0, ev = 0, ecode = 0; for (let n = 0; n < L_SF; n++) { pg += h[n] * h[n]; ev += v[n] * v[n]; ecode += c[n] * c[n]; }
      const ea = Math.log2((ev + 1) * pg) - ESCALE, ef = Math.log2(Math.max(ecode, 1e-9) * pg) - ESCALE;
      let ep: number, ec: number;
      if (bfi) { ep = this.ep - 0.5; ec = this.ec - 0.5; }
      else {
        const [rp, rc] = tetraGainErrors(p.gains[sf]);
        ep = rp + 0.5 * this.ep + 0.25 * this.ec - 3; ec = rc + 0.25 * this.ep + 0.5 * this.ec - 3;
      }
      ep = Math.min(ep, 27); ec = Math.min(ec, 25);
      this.ep = ep; this.ec = ec;
      const gp = Math.pow(2, 0.5 * (ep - ea)), gc = Math.pow(2, 0.5 * (ec - ef));
      // the excitation, then 1 / A(z), then the doubling of the post-processing
      const ys = new Float64Array(L_SF + 10);
      for (let i = 0; i < 10; i++) ys[9 - i] = this.mem[i];
      for (let n = 0; n < L_SF; n++) {
        const u = sat(gp * v[n] + gc * c[n]);
        exc[o + n] = u;
        let s = u; for (let i = 1; i <= 10; i++) s -= a[i] * ys[10 + n - i];
        ys[10 + n] = s = sat(s);
        out[sf * L_SF + n] = Math.max(-32768, Math.min(32767, 2 * s)) / 32768;
      }
      // the synthesis filter's memory: its own last outputs, before the doubling (mem[0] the newest)
      for (let i = 0; i < 10; i++) this.mem[i] = ys[L_SF + 9 - i];
    }
    if (!bfi) this.qPrev = Float64Array.from(q);
    // the past excitation moves on by a frame
    exc.copyWithin(0, 4 * L_SF, exc.length);
    exc.fill(0, exc.length - 4 * L_SF);
    return out;
  }
}
