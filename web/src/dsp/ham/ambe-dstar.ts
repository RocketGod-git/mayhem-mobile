/**
 * AMBE 3600x2400, the vocoder D-STAR DV carries: 72 bits every 20 ms, 49 of them parameters under the same Golay
 * (24,12) and scrambled Golay (23,12) code words as AMBE+2 (so the decoding in mbe.ts reads them), but a different
 * parameter layout and quantizer tables: the pitch is a formula of a 7-bit index, the voicing has 16 patterns, the
 * gain 64 steps, and a pitch index of 126 or 127 marks a tone.
 * A port of mbelib 1.3's ambe3600x2400 path (ISC license, Copyright (C) 2010 mbelib Author), with the order of the
 * 72 bits on the air from DSD's D-STAR receiver (ISC license, Copyright (C) 2010 DSD Author).
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
 * granted, provided that the above copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND ISC DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL ISC BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
 * CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF
 * CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS
 * SOFTWARE.
 */
import { AmbeDecoder } from './mbe.js';
import { DS_LTAB, DS_VUV, DS_LMPRBL, DS_DG, DS_PRBA24, DS_PRBA58, DS_HOC5, DS_HOC6, DS_HOC7, DS_HOC8 } from './ambe-dstar-tables.js';

/** The code word and bit each of the 72 bits sent goes to (row: C0..C3, column: bit, 0 the least significant). */
export const DSTAR_W = [0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0, 3, 2, 1, 1, 3, 2, 1, 1, 0, 0, 3, 2, 0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0,
  3, 2, 1, 1, 3, 2, 1, 1, 0, 0, 3, 2, 0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0, 3, 2, 1, 1, 3, 3, 2, 1, 0, 0, 3, 3];
export const DSTAR_X = [10, 22, 11, 9, 10, 22, 11, 23, 8, 20, 9, 21, 10, 8, 9, 21, 8, 6, 7, 19, 8, 20, 9, 7, 6, 18, 7, 5, 6, 18, 7, 19,
  4, 16, 5, 17, 6, 4, 5, 17, 4, 2, 3, 15, 4, 16, 5, 3, 2, 14, 3, 1, 2, 14, 3, 15, 0, 12, 1, 13, 2, 0, 1, 13, 0, 12, 10, 11, 0, 12, 1, 13];

export class AmbeDstarDecoder extends AmbeDecoder {
  private readonly fr: [Uint8Array, Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(24), new Uint8Array(24), new Uint8Array(24), new Uint8Array(24)];
  private readonly dTl = new Float64Array(58);
  private readonly dCik = new Float64Array(5 * 18);

  /** One D-STAR voice frame: the 72 bits as received, first sent first. Returns 160 samples at 8 kHz. */
  decodeVoice(bits: ArrayLike<number>): Float32Array {
    const fr = this.fr;
    for (const row of fr) row.fill(0);
    for (let i = 0; i < 72; i++) fr[DSTAR_W[i]][DSTAR_X[i]] = bits[i] & 1;
    return this.decode(fr);
  }

  protected override decodeParms(): number {
    const d = this.d, cur = this.cur, prev = this.prev, Tl = this.dTl, Cik = this.dCik;
    cur.repeat = prev.repeat;
    const b0 = d[0] << 6 | d[1] << 5 | d[2] << 4 | d[3] << 3 | d[4] << 2 | d[5] << 1 | d[48];
    if ((b0 & 0x7e) === 0x7e) return 3;                                      // tone
    const f0 = Math.pow(2, -4.311767578125 - 2.1336e-2 * (b0 + 0.5));
    cur.w0 = f0 * 2 * Math.PI;
    const unvc = 0.2046 / Math.sqrt(cur.w0);
    const L = DS_LTAB[b0]; cur.L = L;
    const b1 = d[38] << 3 | d[39] << 2 | d[40] << 1 | d[41];
    for (let l = 1; l <= L; l++) cur.Vl[l] = DS_VUV[b1 * 8 + Math.floor(l * 16 * f0)];
    const b2 = d[6] << 5 | d[7] << 4 | d[8] << 3 | d[9] << 2 | d[42] << 1 | d[43];
    cur.gamma = DS_DG[b2] + 0.5 * prev.gamma;
    const Gm = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const b3 = d[10] << 8 | d[11] << 7 | d[12] << 6 | d[13] << 5 | d[14] << 4 | d[15] << 3 | d[16] << 2 | d[44] << 1 | d[45];
    Gm[2] = DS_PRBA24[b3 * 3]; Gm[3] = DS_PRBA24[b3 * 3 + 1]; Gm[4] = DS_PRBA24[b3 * 3 + 2];
    const b4 = d[17] << 6 | d[18] << 5 | d[19] << 4 | d[20] << 3 | d[21] << 2 | d[46] << 1 | d[47];
    Gm[5] = DS_PRBA58[b4 * 4]; Gm[6] = DS_PRBA58[b4 * 4 + 1]; Gm[7] = DS_PRBA58[b4 * 4 + 2]; Gm[8] = DS_PRBA58[b4 * 4 + 3];
    const Ri = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 1; i <= 8; i++) {
      let sum = 0;
      for (let m = 1; m <= 8; m++) sum += (m === 1 ? 1 : 2) * Gm[m] * Math.cos(Math.PI * (m - 1) * (i - 0.5) / 8);
      Ri[i] = sum;
    }
    const rc = 1 / (2 * Math.SQRT2);
    for (let i = 1; i <= 4; i++) { Cik[i * 18 + 1] = 0.5 * (Ri[2 * i - 1] + Ri[2 * i]); Cik[i * 18 + 2] = rc * (Ri[2 * i - 1] - Ri[2 * i]); }
    // the higher order coefficients; bit 24 is not read, and the last vector's lowest bit is always 0
    const hb = [0, d[22] << 3 | d[23] << 2 | d[25] << 1 | d[26], d[27] << 3 | d[28] << 2 | d[29] << 1 | d[30], d[31] << 3 | d[32] << 2 | d[33] << 1 | d[34], d[35] << 3 | d[36] << 2 | d[37] << 1];
    const hoc = [null, DS_HOC5, DS_HOC6, DS_HOC7, DS_HOC8];
    const Ji = [0, DS_LMPRBL[L * 4], DS_LMPRBL[L * 4 + 1], DS_LMPRBL[L * 4 + 2], DS_LMPRBL[L * 4 + 3]];
    for (let i = 1; i <= 4; i++) for (let k = 3; k <= Ji[i]; k++) Cik[i * 18 + k] = k > 6 ? 0 : hoc[i]![hb[i] * 4 + k - 3];
    let l = 1;
    for (let i = 1; i <= 4; i++) {
      const ji = Ji[i];
      for (let j = 1; j <= ji; j++) {
        let sum = 0;
        for (let k = 1; k <= ji; k++) sum += (k === 1 ? 1 : 2) * Cik[i * 18 + k] * Math.cos(Math.PI * (k - 1) * (j - 0.5) / ji);
        Tl[l++] = sum;
      }
    }
    // the amplitudes: a prediction from the previous frame plus this frame's residuals (as AMBE+2)
    if (cur.L > prev.L) for (let q = prev.L + 1; q <= cur.L; q++) { prev.Ml[q] = prev.Ml[prev.L]; prev.log2Ml[q] = prev.log2Ml[prev.L]; }
    prev.log2Ml[0] = prev.log2Ml[1]; prev.Ml[0] = prev.Ml[1];
    const intkl = new Int32Array(58), deltal = new Float64Array(58);
    let Sum43 = 0, Sum42 = 0;
    for (let q = 1; q <= cur.L; q++) {
      const flokl = (prev.L / cur.L) * q;
      intkl[q] = Math.floor(flokl); deltal[q] = flokl - intkl[q];
      Sum43 += (1 - deltal[q]) * prev.log2Ml[intkl[q]] + deltal[q] * prev.log2Ml[intkl[q] + 1];
      Sum42 += Tl[q];
    }
    Sum43 *= 0.65 / cur.L; Sum42 /= cur.L;
    const BigGamma = cur.gamma - 0.5 * Math.log2(cur.L) - Sum42;
    for (let q = 1; q <= cur.L; q++) {
      const c1 = 0.65 * (1 - deltal[q]) * prev.log2Ml[intkl[q]], c2 = 0.65 * deltal[q] * prev.log2Ml[intkl[q] + 1];
      cur.log2Ml[q] = Tl[q] + c1 + c2 - Sum43 + BigGamma;
      cur.Ml[q] = (cur.Vl[q] === 1 ? 1 : unvc) * Math.exp(0.693 * cur.log2Ml[q]);
    }
    return 0;
  }
}
