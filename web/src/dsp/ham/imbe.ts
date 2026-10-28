/**
 * IMBE 7200x4400, the vocoder P25 Phase 1 carries: 144 bits on air every 20 ms, 88 of them parameters.
 *
 * Only the front half differs from the AMBE codec already here. Once the bits become a pitch, a harmonic count,
 * a voicing decision per band and a set of spectral amplitudes, the two are the same model and share the
 * enhancement and synthesis in mbe.ts, so this file extends that decoder rather than repeating it.
 *
 * IMBE is the simpler of the two to unpack: there is no vector quantization anywhere, every value is scalar with
 * a bit allocation that depends on the harmonic count. What is intricate instead is where the bits live, because
 * they are ordered by how much protection they deserve rather than by what they mean.
 *
 * Ported from mbelib (ISC license), checked against the JMBE and OP25 implementations.
 */
import { AmbeDecoder, golay2312, popcount } from './mbe.js';
import { QUANT_STEP, STAND_DEV, B2, BA_BITS, BA_STEP, HOBA, JI } from './imbe-tables.js';

/** Hamming (15,11) parity rows and the single-error correction table, both from mbelib. */
const HAM_GEN = [0x7f08, 0x78e4, 0x66d2, 0x55b1];
const HAM_FIX = [0x0, 0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80, 0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000];

/**
 * The de-interleave, as a rule rather than the reference's 144-entry table: the frame is read out of a six-row,
 * twenty-four-column block, and odd columns swap their rows in pairs.
 */
const DEINT = new Uint8Array(144);
for (let i = 0; i < 144; i++) { const j = (i / 6) | 0, r = i % 6; DEINT[i] = j + 24 * ((j & 1) ? (r ^ 1) : r); }

/** Where each code word starts in the de-interleaved frame, and how long it is. */
const WORD_AT = [0, 23, 46, 69, 92, 107, 122, 137];
const WORD_LEN = [23, 23, 23, 23, 15, 15, 15, 7];

function hamming1511(block: number): { word: number; errs: number } {
  let syn = 0;
  for (let i = 0; i < 4; i++) syn = (syn << 1) | (popcount(block & HAM_GEN[i]) & 1);
  if (syn === 0) return { word: block, errs: 0 };
  return { word: block ^ HAM_FIX[syn], errs: 1 };
}

export class ImbeDecoder extends AmbeDecoder {
  /** The 88 parameter bits, most significant of each value first. */
  private readonly id = new Uint8Array(88);
  /** Each parameter's bits, as bb[vector][bit]; vector 0 is the pitch, 1 the voicing, 2 the gain. */
  // Twelve wide, not ten: every quantized value fits in ten bits, but the voicing word runs to twelve.
  private readonly bb: Uint8Array[] = Array.from({ length: 58 }, () => new Uint8Array(12));
  private readonly w = new Uint8Array(144);
  private readonly words = new Int32Array(8);
  private readonly iTl = new Float64Array(58);
  private readonly iCik: Float64Array[] = Array.from({ length: 7 }, () => new Float64Array(11));
  private readonly Ri = new Float64Array(7);
  private readonly Gm = new Float64Array(7);

  constructor() { super(); this.repeatErrs = 5; }

  /**
   * Decode one voice frame. `bits` is the 144 bits as they came off the air, one per entry.
   * Returns 160 samples at 8 kHz.
   */
  decodeVoice(bits: Uint8Array): Float32Array {
    const w = this.w, words = this.words;
    for (let i = 0; i < 144; i++) w[DEINT[i]] = bits[i];
    for (let k = 0; k < 8; k++) {
      let v = 0;
      for (let i = 0, at = WORD_AT[k], n = WORD_LEN[k]; i < n; i++) v = (v << 1) | w[at + i];
      words[k] = v;
    }
    let errs = 0;
    // The first word protects the seed for everything else, so it is corrected before anything is descrambled.
    const u0 = golay2312(words[0]);
    if (u0 < 0) errs += 4; else { errs += popcount((u0 ^ words[0]) >>> 11); words[0] = u0; }
    // A pseudo-random sequence keyed on that seed is laid over the rest of the frame; lift it off.
    let pr = 16 * (words[0] >>> 11);
    for (let k = 1; k < 7; k++) {
      const n = WORD_LEN[k];
      for (let b = n - 1; b >= 0; b--) { pr = (173 * pr + 13849) % 65536; words[k] ^= (pr >>> 15) << b; }
    }
    for (let k = 1; k < 4; k++) {
      const fix = golay2312(words[k]);
      if (fix < 0) errs += 4; else { errs += popcount((fix ^ words[k]) >>> 11); words[k] = fix; }
    }
    for (let k = 4; k < 7; k++) { const r = hamming1511(words[k]); words[k] = r.word; errs += r.errs; }
    // The parameter bits are the high 12 of each Golay word, the high 11 of each Hamming word, then all seven
    // of the last word, which carries no protection at all.
    const id = this.id;
    let p = 0;
    for (let k = 0; k < 4; k++) for (let b = 11; b >= 0; b--) id[p++] = (words[k] >>> (b + 11)) & 1;
    for (let k = 4; k < 7; k++) for (let b = 10; b >= 0; b--) id[p++] = (words[k] >>> (b + 4)) & 1;
    for (let b = 6; b >= 0; b--) id[p++] = (words[7] >>> b) & 1;
    this.errs = errs;
    return this.process(errs);
  }

  /**
   * Spread the 88 bits across the parameters. The first six and last two are the pitch, three more are the top of
   * the gain, and the middle is filled most-significant-bit-first across every remaining parameter at once, so
   * that the bits which matter most sit inside the best protected code words. The voicing bits interrupt this at
   * a fixed point, and the bottom three gain bits are placed individually.
   */
  private scatter(L: number, K: number): void {
    const id = this.id, bb = this.bb;
    for (let m = 0; m <= L + 1; m++) bb[m].fill(0);
    const len = (m: number) => m < 3 ? 0 : m < 8 ? BA_BITS[L - 9][m - 3] : HOBA[L - 9][m - 8];
    // Significance-major: every parameter's bit 9 first, then every parameter's bit 8, and so on down.
    const order: number[] = [];
    for (let p = 9; p >= 0; p--) for (let m = 3; m <= L + 1; m++) if (len(m) > p) order.push(m * 16 + p);
    let s = 0;
    const put = (at: number, m: number, b: number) => { bb[m][b] = id[at]; };
    for (let k = 0; k < 6; k++) put(6 + k, 2, 5 - k);
    for (let k = 0; k < 39; k++) { const o = order[s++]; put(9 + k, o >> 4, o & 15); }
    for (let k = 0; k < K; k++) put(48 + k, 1, K - 1 - k);
    put(48 + K, 2, 2); put(49 + K, 2, 1);
    for (let k = 50 + K; k < 84; k++) { const o = order[s++]; put(k, o >> 4, o & 15); }
    put(84, 2, 0);
  }

  protected override decodeParms(): number {
    const id = this.id, cur = this.cur, prev = this.prev, bb = this.bb, Cik = this.iCik, Ri = this.Ri, Gm = this.Gm, Tl = this.iTl;
    cur.repeat = prev.repeat;
    const b0 = id[0] << 7 | id[1] << 6 | id[2] << 5 | id[3] << 4 | id[4] << 3 | id[5] << 2 | id[85] << 1 | id[86];
    if (b0 > 207) return 4;                       // silence, a tone, or a reading that cannot be right
    cur.w0 = 4 * Math.PI / (b0 + 39.5);
    const L = Math.floor(0.9254 * Math.floor(Math.PI / cur.w0 + 0.25));
    if (L < 9 || L > 56) return 4;
    cur.L = L;
    const L9 = L - 9, K = L < 37 ? Math.floor((L + 2) / 3) : 12;
    this.scatter(L, K);

    // Voicing: one bit per band of three harmonics, the first band taking the most significant bit.
    for (let l = 1, j = 1, k = K - 1; l <= L; l++) {
      cur.Vl[l] = bb[1][k];
      if (j === 3) { j = 1; if (k > 0) k--; } else j++;
    }

    // Gain, then the five-value gain vector, both scalar quantized.
    let b2 = 0; for (let b = 5; b >= 0; b--) b2 = (b2 << 1) | bb[2][b];
    Gm[1] = B2[b2];
    for (let i = 2; i < 7; i++) {
      const bits = BA_BITS[L9][i - 2], step = BA_STEP[L9 * 5 + (i - 2)];
      let bm = 0; for (let b = bits - 1; b >= 0; b--) bm = (bm << 1) | bb[i + 1][b];
      Gm[i] = step * (bm - Math.pow(2, bits - 1) + 0.5);
    }
    // Those six values are a cosine transform of the six frequency blocks' average levels.
    for (let i = 1; i <= 6; i++) {
      let sum = 0;
      for (let m = 1; m <= 6; m++) sum += (m === 1 ? 1 : 2) * Gm[m] * Math.cos(Math.PI * (m - 1) * (i - 0.5) / 6);
      Ri[i] = sum;
    }

    // Everything left describes the shape within each block.
    let m = 8;
    for (let i = 1; i <= 6; i++) {
      Cik[i][1] = Ri[i];
      for (let k = 2; k <= JI[L9][i - 1]; k++) {
        const Bm = HOBA[L9][m - 8];
        if (Bm === 0) Cik[i][k] = 0;
        else {
          let bm = 0; for (let b = Bm - 1; b >= 0; b--) bm = (bm << 1) | bb[m][b];
          Cik[i][k] = QUANT_STEP[Bm - 1] * STAND_DEV[k - 2] * (bm - Math.pow(2, Bm - 1) + 0.5);
        }
        m++;
      }
    }
    for (let i = 1, l = 1; i <= 6; i++) {
      const ji = JI[L9][i - 1];
      for (let j = 1; j <= ji; j++, l++) {
        let sum = 0;
        for (let k = 1; k <= ji; k++) sum += (k === 1 ? 1 : 2) * Cik[i][k] * Math.cos(Math.PI * (k - 1) * (j - 0.5) / ji);
        Tl[l] = sum;
      }
    }

    // The amplitudes are sent as a difference from the previous frame, interpolated when the harmonic count
    // changed, with the frame's mean level removed so that an error cannot accumulate.
    const rho = L <= 15 ? 0.4 : L <= 24 ? 0.03 * L - 0.05 : 0.7;
    if (L > prev.L) for (let l = prev.L + 1; l <= L; l++) { prev.Ml[l] = prev.Ml[prev.L]; prev.log2Ml[l] = prev.log2Ml[prev.L]; }
    let mean = 0;
    for (let l = 1; l <= L; l++) {
      const f = (prev.L / L) * l, k = Math.floor(f), d = f - k;
      mean += (1 - d) * prev.log2Ml[k] + d * prev.log2Ml[k + 1];
    }
    mean *= rho / L;
    for (let l = 1; l <= L; l++) {
      const f = (prev.L / L) * l, k = Math.floor(f), d = f - k;
      cur.log2Ml[l] = Tl[l] + rho * (1 - d) * prev.log2Ml[k] + rho * d * prev.log2Ml[k + 1] - mean;
      cur.Ml[l] = Math.pow(2, cur.log2Ml[l]);
    }
    return 0;
  }
}
