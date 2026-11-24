package com.rocketgod.mayhem.core.ham

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sqrt

/*
 * AMBE 3600x2400, the vocoder D-STAR DV carries: the same Golay code words as AMBE+2 (read by [AmbeDecoder.decode]),
 * a different parameter layout and quantizer tables, a pitch index of 126 or 127 marking a tone. The same as the
 * web's dsp/ham/ambe-dstar.ts.
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

/** The code word and bit each of the 72 bits sent goes to. */
val DSTAR_W = intArrayOf(0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0, 3, 2, 1, 1, 3, 2, 1, 1, 0, 0, 3, 2, 0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0,
    3, 2, 1, 1, 3, 2, 1, 1, 0, 0, 3, 2, 0, 0, 3, 2, 1, 1, 0, 0, 1, 1, 0, 0, 3, 2, 1, 1, 3, 3, 2, 1, 0, 0, 3, 3)
val DSTAR_X = intArrayOf(10, 22, 11, 9, 10, 22, 11, 23, 8, 20, 9, 21, 10, 8, 9, 21, 8, 6, 7, 19, 8, 20, 9, 7, 6, 18, 7, 5, 6, 18, 7, 19,
    4, 16, 5, 17, 6, 4, 5, 17, 4, 2, 3, 15, 4, 16, 5, 3, 2, 14, 3, 1, 2, 14, 3, 15, 0, 12, 1, 13, 2, 0, 1, 13, 0, 12, 10, 11, 0, 12, 1, 13)

class AmbeDstarDecoder : AmbeDecoder() {
    private val fr = Array(4) { IntArray(24) }
    private val dTl = DoubleArray(58)
    private val dCik = DoubleArray(5 * 18)

    /** One D-STAR voice frame: the 72 bits as received, first sent first. 160 samples at 8 kHz. */
    fun decodeVoice(bits: IntArray): FloatArray {
        for (row in fr) row.fill(0)
        for (i in 0 until 72) fr[DSTAR_W[i]][DSTAR_X[i]] = bits[i] and 1
        return decode(fr)
    }

    override fun decodeParms(): Int {
        val Tl = dTl; val Cik = dCik
        cur.repeat = prev.repeat
        val b0 = (d[0] shl 6) or (d[1] shl 5) or (d[2] shl 4) or (d[3] shl 3) or (d[4] shl 2) or (d[5] shl 1) or d[48]
        if ((b0 and 0x7e) == 0x7e) return 3
        val f0 = 2.0.pow(-4.311767578125 - 2.1336e-2 * (b0 + 0.5))
        cur.w0 = f0 * 2 * PI
        val unvc = 0.2046 / sqrt(cur.w0)
        val L = DS_LTAB[b0]; cur.L = L
        val b1 = (d[38] shl 3) or (d[39] shl 2) or (d[40] shl 1) or d[41]
        for (l in 1..L) cur.Vl[l] = DS_VUV[b1 * 8 + floor(l * 16 * f0).toInt()]
        val b2 = (d[6] shl 5) or (d[7] shl 4) or (d[8] shl 3) or (d[9] shl 2) or (d[42] shl 1) or d[43]
        cur.gamma = DS_DG[b2] + 0.5 * prev.gamma
        val gm = DoubleArray(9)
        val b3 = (d[10] shl 8) or (d[11] shl 7) or (d[12] shl 6) or (d[13] shl 5) or (d[14] shl 4) or (d[15] shl 3) or (d[16] shl 2) or (d[44] shl 1) or d[45]
        gm[2] = DS_PRBA24[b3 * 3]; gm[3] = DS_PRBA24[b3 * 3 + 1]; gm[4] = DS_PRBA24[b3 * 3 + 2]
        val b4 = (d[17] shl 6) or (d[18] shl 5) or (d[19] shl 4) or (d[20] shl 3) or (d[21] shl 2) or (d[46] shl 1) or d[47]
        gm[5] = DS_PRBA58[b4 * 4]; gm[6] = DS_PRBA58[b4 * 4 + 1]; gm[7] = DS_PRBA58[b4 * 4 + 2]; gm[8] = DS_PRBA58[b4 * 4 + 3]
        val ri = DoubleArray(9)
        for (i in 1..8) { var sum = 0.0; for (m in 1..8) sum += (if (m == 1) 1 else 2) * gm[m] * cos(PI * (m - 1) * (i - 0.5) / 8); ri[i] = sum }
        val rc = 1 / (2 * sqrt(2.0))
        for (i in 1..4) { Cik[i * 18 + 1] = 0.5 * (ri[2 * i - 1] + ri[2 * i]); Cik[i * 18 + 2] = rc * (ri[2 * i - 1] - ri[2 * i]) }
        // the higher order coefficients; bit 24 is not read, and the last vector's lowest bit is always 0
        val hb = intArrayOf(0, (d[22] shl 3) or (d[23] shl 2) or (d[25] shl 1) or d[26], (d[27] shl 3) or (d[28] shl 2) or (d[29] shl 1) or d[30],
            (d[31] shl 3) or (d[32] shl 2) or (d[33] shl 1) or d[34], (d[35] shl 3) or (d[36] shl 2) or (d[37] shl 1))
        val hoc = arrayOf(DS_HOC5, DS_HOC5, DS_HOC6, DS_HOC7, DS_HOC8)
        val ji = intArrayOf(0, DS_LMPRBL[L * 4], DS_LMPRBL[L * 4 + 1], DS_LMPRBL[L * 4 + 2], DS_LMPRBL[L * 4 + 3])
        for (i in 1..4) for (k in 3..ji[i]) Cik[i * 18 + k] = if (k > 6) 0.0 else hoc[i][hb[i] * 4 + k - 3]
        var l = 1
        for (i in 1..4) {
            val j0 = ji[i]
            for (j in 1..j0) {
                var sum = 0.0
                for (k in 1..j0) sum += (if (k == 1) 1 else 2) * Cik[i * 18 + k] * cos(PI * (k - 1) * (j - 0.5) / j0)
                Tl[l++] = sum
            }
        }
        if (cur.L > prev.L) for (q in prev.L + 1..cur.L) { prev.Ml[q] = prev.Ml[prev.L]; prev.log2Ml[q] = prev.log2Ml[prev.L] }
        prev.log2Ml[0] = prev.log2Ml[1]; prev.Ml[0] = prev.Ml[1]
        val intkl = IntArray(58); val deltal = DoubleArray(58)
        var sum43 = 0.0; var sum42 = 0.0
        for (q in 1..cur.L) {
            val flokl = prev.L.toDouble() / cur.L * q
            intkl[q] = floor(flokl).toInt(); deltal[q] = flokl - intkl[q]
            sum43 += (1 - deltal[q]) * prev.log2Ml[intkl[q]] + deltal[q] * prev.log2Ml[intkl[q] + 1]
            sum42 += Tl[q]
        }
        sum43 *= 0.65 / cur.L; sum42 /= cur.L
        val bigGamma = cur.gamma - 0.5 * (ln(cur.L.toDouble()) / ln(2.0)) - sum42
        for (q in 1..cur.L) {
            val c1 = 0.65 * (1 - deltal[q]) * prev.log2Ml[intkl[q]]; val c2 = 0.65 * deltal[q] * prev.log2Ml[intkl[q] + 1]
            cur.log2Ml[q] = Tl[q] + c1 + c2 - sum43 + bigGamma
            cur.Ml[q] = (if (cur.Vl[q] == 1) 1.0 else unvc) * exp(0.693 * cur.log2Ml[q])
        }
        return 0
    }
}
