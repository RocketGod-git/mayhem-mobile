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
 * bit-identical. The same as the web's dsp/hamid/codec2.ts and the Swift HamIdCodec2.swift.
 */
package com.rocketgod.mayhem.core.hamid

import kotlin.math.PI as KPI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

object Codec2 {
    const val FS = 8000; const val N = 80; const val NDFT = 512; const val P = 10
    /** The reference's own constants (defines.h), kept as written so the decisions they feed match. */
    private const val PI = 3.141592654; private const val TWO_PI = 6.283185307
    private const val P_MIN = 20; private const val P_MAX = 160
    /**
     * The reference keeps Wo, the bin width r and the excitation phase in 32-bit float, and the harmonic count and
     * the bin of each harmonic are whole-number cuts of them, so those are rounded to float here as there.
     */
    private fun f32(x: Double): Double = x.toFloat().toDouble()
    val WO_MIN = f32(TWO_PI / P_MAX); val WO_MAX = f32(TWO_PI / P_MIN)
    private val R_BIN = f32(TWO_PI / 512)
    private const val WO_BITS = 7; private const val E_BITS = 5; private const val E_MIN_DB = -10.0; private const val E_MAX_DB = 40.0
    private const val LPCPF_BETA = 0.2; private const val LPCPF_GAMMA = 0.5
    private const val BG_THRESH = 40.0; private const val BG_BETA = 0.1; private const val BG_MARGIN = 6.0
    private const val RAND_MAX = 32767.0

    /** codebook/dlsp1..10.txt: the 3200 mode's LSP difference quantizers (Hz), 5 bits each. */
    private val DLSP_A = IntArray(32) { 25 * (it + 1) }
    private val DLSP_B = intArrayOf(25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950, 1000, 1050, 1100, 1150, 1200, 1250, 1300, 1350, 1400)
    val LSPD_CB = arrayOf(DLSP_A, DLSP_A, DLSP_A, DLSP_B, DLSP_B, DLSP_B, DLSP_A, DLSP_A, DLSP_A, DLSP_A)
    /** codebook/lsp1..10.txt: the 1600 mode's scalar LSP quantizers (Hz). */
    val LSP_CB = arrayOf(
        intArrayOf(225, 250, 275, 300, 325, 350, 375, 400, 425, 450, 475, 500, 525, 550, 575, 600),
        intArrayOf(325, 350, 375, 400, 425, 450, 475, 500, 525, 550, 575, 600, 625, 650, 675, 700),
        intArrayOf(500, 550, 600, 650, 700, 750, 800, 850, 900, 950, 1000, 1050, 1100, 1150, 1200, 1250),
        intArrayOf(700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200),
        intArrayOf(950, 1050, 1150, 1250, 1350, 1450, 1550, 1650, 1750, 1850, 1950, 2050, 2150, 2250, 2350, 2450),
        intArrayOf(1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600),
        intArrayOf(1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800, 2900, 3000),
        intArrayOf(2300, 2400, 2500, 2600, 2700, 2800, 2900, 3000),
        intArrayOf(2500, 2600, 2700, 2800, 2900, 3000, 3100, 3200),
        intArrayOf(2900, 3100, 3300, 3500),
    )
    val LSP_BITS = intArrayOf(4, 4, 4, 4, 4, 4, 4, 3, 3, 2)

    /** pack.c unpack(): MSB first, every field Gray coded. */
    class Bits(private val b: IntArray) {
        private var p = 0
        fun natural(n: Int): Int { var v = 0; repeat(n) { v = (v shl 1) or ((b[p shr 3] shr (7 - (p and 7))) and 1); p++ }; return v }
        fun read(n: Int): Int { var t = natural(n); t = t xor (t shr 8); t = t xor (t shr 4); t = t xor (t shr 2); t = t xor (t shr 1); return t }
    }

    fun decodeWo(i: Int): Double = f32(WO_MIN + f32(f32(f32(WO_MAX - WO_MIN) / (1 shl WO_BITS)) * i))
    fun decodeEnergy(i: Int): Double = 10.0.pow((E_MIN_DB + (E_MAX_DB - E_MIN_DB) / (1 shl E_BITS) * i) / 10)
    /** The harmonic count, C's (int)(PI / Wo). */
    private fun harmonics(wo: Double) = (PI / wo).toInt()

    fun decodeLspds(idx: IntArray): DoubleArray {
        val lsp = DoubleArray(P); var hz = 0.0
        for (i in 0 until P) { hz += LSPD_CB[i][idx[i]]; lsp[i] = (PI / 4000) * hz }
        return lsp
    }
    fun decodeLsps(idx: IntArray) = DoubleArray(P) { (PI / 4000) * LSP_CB[it][idx[it]] }
    /** quantise.c check_lsp_order as written (its restart lands on i = 2), capped so bad bits cannot loop it. */
    fun checkLspOrder(lsp: DoubleArray): Int {
        var swaps = 0; var i = 1
        while (i < lsp.size && swaps < 1000) {
            if (lsp[i] < lsp[i - 1]) { swaps++; val t = lsp[i - 1]; lsp[i - 1] = lsp[i] - 0.1; lsp[i] = t + 0.1; i = 1 }
            i++
        }
        return swaps
    }
    fun bwExpandLsps(lsp: DoubleArray, minLow: Double, minHigh: Double) {
        for (i in 1 until 4) if (lsp[i] - lsp[i - 1] < minLow * (PI / 4000)) lsp[i] = lsp[i - 1] + minLow * (PI / 4000)
        for (i in 4 until lsp.size) if (lsp[i] - lsp[i - 1] < minHigh * (PI / 4000)) lsp[i] = lsp[i - 1] + minHigh * (PI / 4000)
    }

    class F3200(val v1: Boolean, val v2: Boolean, val wo: Double, val e: Double, val lsp: DoubleArray)
    /** 3200: the frame's two voicing bits, Wo, energy and LSPs (radians) as sent. */
    fun unpack3200(b: IntArray): F3200 {
        val r = Bits(b)
        val v1 = r.read(1) == 1; val v2 = r.read(1) == 1
        val wo = decodeWo(r.read(WO_BITS)); val e = decodeEnergy(r.read(E_BITS))
        val idx = IntArray(P) { r.read(5) }
        return F3200(v1, v2, wo, e, decodeLspds(idx))
    }
    class F1600(val v: BooleanArray, val wo: DoubleArray, val e: DoubleArray, val lsp: DoubleArray)
    /** 1600: four voicing bits, the Wo and energy of the second and fourth 10 ms, the LSPs (ordered and spread). */
    fun unpack1600(b: IntArray): F1600 {
        val r = Bits(b)
        val v0 = r.read(1) == 1
        val v1 = r.read(1) == 1; val wo1 = decodeWo(r.read(WO_BITS)); val e1 = decodeEnergy(r.read(E_BITS))
        val v2 = r.read(1) == 1
        val v3 = r.read(1) == 1; val wo3 = decodeWo(r.read(WO_BITS)); val e3 = decodeEnergy(r.read(E_BITS))
        val idx = IntArray(P) { r.read(LSP_BITS[it]) }
        val lsp = decodeLsps(idx)
        checkLspOrder(lsp); bwExpandLsps(lsp, 50.0, 100.0)
        return F1600(booleanArrayOf(v0, v1, v2, v3), doubleArrayOf(wo1, wo3), doubleArrayOf(e1, e3), lsp)
    }

    /** lsp.c lsp_to_lpc: A(z) = (P(z) + Q(z)) / 2, ω1, ω3, ... in P = (1 + z^-1)Π, ω2, ω4, ... in Q = (1 - z^-1)Π. */
    fun lspToLpc(w: DoubleArray): DoubleArray {
        fun mul(a: DoubleArray, c: Double): DoubleArray { val o = DoubleArray(a.size + 2); for (i in a.indices) { o[i] += a[i]; o[i + 1] += c * a[i]; o[i + 2] += a[i] }; return o }
        var p = doubleArrayOf(1.0, 1.0); var q = doubleArrayOf(1.0, -1.0)
        for (i in w.indices step 2) p = mul(p, -2 * cos(w[i]))
        for (i in 1 until w.size step 2) q = mul(q, -2 * cos(w[i]))
        return DoubleArray(w.size + 1) { (p[it] + q[it]) / 2 }
    }

    private val COS = DoubleArray(NDFT / 2) { cos(2 * KPI * it / NDFT) }
    private val SIN = DoubleArray(NDFT / 2) { sin(2 * KPI * it / NDFT) }
    private val REV = IntArray(NDFT) { var x = it; var y = 0; repeat(9) { y = (y shl 1) or (x and 1); x = x shr 1 }; y }
    /** In-place 512-point FFT; [inverse] uses e^{+j}, without the 1/N (as kiss_fft). */
    fun fft512(re: DoubleArray, im: DoubleArray, inverse: Boolean) {
        for (i in 0 until NDFT) { val j = REV[i]; if (j > i) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t } }
        var len = 2
        while (len <= NDFT) {
            val half = len shr 1; val step = NDFT / len
            var s = 0
            while (s < NDFT) {
                for (k in 0 until half) {
                    val c = COS[k * step]; val sn = if (inverse) SIN[k * step] else -SIN[k * step]
                    val a = s + k; val b = a + half
                    val tr = re[b] * c - im[b] * sn; val ti = re[b] * sn + im[b] * c
                    re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
                }
                s += len
            }
            len = len shl 1
        }
    }

    /** sine.c make_synthesis_window: the trapezoid (a triangle at 8 kHz), its ramps summed in float as the reference does. */
    private val PN = DoubleArray(2 * N).also { pn ->
        val tw = 40; var win = 0.0
        for (i in N / 2 - tw until N / 2 + tw) { pn[i] = win; win = f32(win + 1.0 / (2 * tw)) }
        for (i in N / 2 + tw until 3 * N / 2 - tw) pn[i] = 1.0
        win = 1.0
        for (i in 3 * N / 2 - tw until 3 * N / 2 + tw) { pn[i] = win; win = f32(win - 1.0 / (2 * tw)) }
    }

    /** One 10 ms frame's model: pitch, harmonic count, amplitudes and phases (index 1..L), voicing. */
    class Model(var wo: Double, var voiced: Boolean) {
        var L = if (wo > 0) harmonics(wo) else 0
        val A = DoubleArray(161); val phi = DoubleArray(161)
    }

    /** interp.c interp_Wo2 with weight 0.5 (interp_Wo). */
    private fun interpWo(m: Model, prev: Model, next: Model) {
        if (m.voiced && !prev.voiced && !next.voiced) m.voiced = false
        if (m.voiced) {
            if (prev.voiced && next.voiced) m.wo = f32(0.5 * prev.wo + 0.5 * next.wo)
            if (!prev.voiced && next.voiced) m.wo = next.wo
            if (prev.voiced && !next.voiced) m.wo = prev.wo
        } else m.wo = WO_MIN
        m.L = harmonics(m.wo)
    }

    class Aw(val re: DoubleArray, val im: DoubleArray)
    /**
     * quantise.c aks_to_M2 with the LPC post filter (lpc_post_filter, β = 0.2, γ = 0.5, bass boost on): the harmonic
     * amplitudes into [m].A from the band energies of E/|A|², and A(e^jω) for the phases.
     */
    fun aksToM2(ak: DoubleArray, m: Model, e: Double): Aw {
        val awRe = DoubleArray(NDFT); val awIm = DoubleArray(NDFT)
        for (i in ak.indices) awRe[i] = ak[i]
        fft512(awRe, awIm, false)
        val h = NDFT / 2; val pw = DoubleArray(h)
        for (i in 0 until h) pw[i] = 1 / (awRe[i] * awRe[i] + awIm[i] * awIm[i] + 1e-6)
        // lpc_post_filter
        val wr = DoubleArray(NDFT); val wi = DoubleArray(NDFT)
        wr[0] = ak[0]; var coeff = LPCPF_GAMMA
        for (i in 1 until ak.size) { wr[i] = ak[i] * coeff; coeff *= LPCPF_GAMMA }
        fft512(wr, wi, false)
        var eBefore = 1e-4; var eAfter = 1e-4
        for (i in 0 until h) eBefore += pw[i]
        for (i in 0 until h) {
            val rw = sqrt((wr[i] * wr[i] + wi[i] * wi[i]) * pw[i]); val pfw = rw.pow(LPCPF_BETA)
            pw[i] *= pfw * pfw; eAfter += pw[i]
        }
        val gain = eBefore / eAfter * e
        for (i in 0 until h) pw[i] *= gain
        for (i in 0 until NDFT / 8) pw[i] *= 1.4 * 1.4                  // bass boost: +3 dB below 1 kHz
        // band energies
        val r = R_BIN
        for (k in 1..m.L) {
            val am = ((k - 0.5) * m.wo / r + 0.5).toInt(); var bm = ((k + 0.5) * m.wo / r + 0.5).toInt()
            if (bm > h) bm = h
            var em = 0.0; for (i in am until bm) em += pw[i]
            m.A[k] = sqrt(em)
        }
        return Aw(awRe, awIm)
    }

    class Decoder(val rate: Int) {
        private var prev = Model(WO_MIN, false)
        private var prevLsps = DoubleArray(P)
        private var prevE = 1.0
        private var exPhase = 0.0
        private var bgEst = 0.0
        private val sn = DoubleArray(2 * N)
        private var seed = 1
        init { reset() }
        /** Samples a frame gives: 160 (3200) or 320 (1600). */
        val samples get() = if (rate == 3200) 160 else 320

        /** codec2_create's decoder state. */
        fun reset() {
            prev = Model(WO_MIN, false); prevLsps = DoubleArray(P) { it * PI / (P + 1) }
            prevE = 1.0; exPhase = 0.0; bgEst = 0.0; sn.fill(0.0); seed = 1
        }

        /** sine.c codec2_rand: 0..32767. */
        private fun rand(): Int { seed = seed * 1103515245 + 12345; return (seed ushr 16) and 0x7fff }

        /** One frame (8 bytes) → 16-bit PCM at 8 kHz. */
        fun decode(frame: IntArray): ShortArray {
            val out = ShortArray(samples)
            if (rate == 3200) {
                val f = unpack3200(frame)
                val m0 = Model(0.0, f.v1); val m1 = Model(f.wo, f.v2)
                interpWo(m0, prev, m1)
                val lsp0 = DoubleArray(P) { 0.5 * prevLsps[it] + 0.5 * f.lsp[it] }
                synthFrame(m0, lsp0, sqrt(prevE * f.e), out, 0)
                synthFrame(m1, f.lsp, f.e, out, N)
                prev = m1; prevE = f.e; prevLsps = f.lsp
            } else {
                val f = unpack1600(frame)
                val m = arrayOf(Model(0.0, f.v[0]), Model(f.wo[0], f.v[1]), Model(0.0, f.v[2]), Model(f.wo[1], f.v[3]))
                interpWo(m[0], prev, m[1])
                interpWo(m[2], m[1], m[3])
                val e = doubleArrayOf(sqrt(prevE * f.e[0]), f.e[0], sqrt(f.e[0] * f.e[1]), f.e[1])
                for (k in 0 until 4) {
                    val w = 0.25 * (k + 1)
                    val lsp = if (k < 3) DoubleArray(P) { (1 - w) * prevLsps[it] + w * f.lsp[it] } else f.lsp
                    synthFrame(m[k], lsp, e[k], out, k * N)
                }
                prev = m[3]; prevE = f.e[1]; prevLsps = f.lsp
            }
            return out
        }

        /** LSPs and energy → amplitudes (aks_to_M2, apply_lpc_correction), then synthesise_one_frame into [out] at [at]. */
        private fun synthFrame(m: Model, lsp: DoubleArray, e: Double, out: ShortArray, at: Int) {
            val aw = aksToM2(lspToLpc(lsp), m, e)
            if (m.wo < PI * 150 / 4000) m.A[1] *= 0.032
            // sample_phase + phase_synth_zero_order: H = conj(A) at each harmonic, excitation m·φ1 (voiced) or random
            val r = R_BIN
            exPhase = f32(exPhase + f32(m.wo * N))
            exPhase = f32(exPhase - TWO_PI * floor(f32(exPhase / TWO_PI + 0.5)))
            for (k in 1..m.L) {
                val b = (f32(f32(k * m.wo) / r) + 0.5).toInt(); val hr = aw.re[b]; val hi = -aw.im[b]
                val er: Double; val ei: Double
                if (m.voiced) { val x = f32(exPhase * k); er = cos(x); ei = sin(x) }
                else { val phi = TWO_PI * rand() / RAND_MAX; er = cos(phi); ei = sin(phi) }
                m.phi[k] = atan2(hi * er + hr * ei, hr * er - hi * ei + 1e-12)
            }
            // postfilter: in voiced frames, harmonics under the background noise estimate get random phases
            var en = 1e-12; for (k in 1..m.L) en += m.A[k] * m.A[k]
            en = 10 * log10(en / m.L)
            if (en < BG_THRESH && !m.voiced) bgEst = bgEst * (1 - BG_BETA) + en * BG_BETA
            val thresh = 10.0.pow((bgEst + BG_MARGIN) / 20)
            if (m.voiced) for (k in 1..m.L) if (m.A[k] < thresh) m.phi[k] = (TWO_PI / RAND_MAX) * rand()
            // synthesis (sine.c synthesise): one bin per harmonic, inverse DFT, trapezoid overlap-add
            for (i in 0 until N - 1) sn[i] = sn[i + N]
            sn[N - 1] = 0.0
            val re = DoubleArray(NDFT); val im = DoubleArray(NDFT)
            for (k in 1..m.L) {
                var b = (f32(f32(k * m.wo) * NDFT) / TWO_PI + 0.5).toInt()
                if (b > NDFT / 2 - 1) b = NDFT / 2 - 1
                re[b] = m.A[k] * cos(m.phi[k]); im[b] = m.A[k] * sin(m.phi[k])
            }
            for (k in 1 until NDFT / 2) { re[NDFT - k] = re[k]; im[NDFT - k] = -im[k] }
            fft512(re, im, true)
            for (i in 0 until N - 1) sn[i] += re[NDFT - N + 1 + i] * PN[i]
            var j = 0
            for (i in N - 1 until 2 * N) { sn[i] = re[j] * PN[i]; j++ }
            // ear_protection, then C's float to short
            var max = 0.0; for (i in 0 until N) if (sn[i] > max) max = sn[i]
            val over = max / 30000
            if (over > 1) { val g = 1 / (over * over); for (i in 0 until N) sn[i] *= g }
            for (i in 0 until N) out[at + i] = (if (sn[i] > 32767) 32767 else if (sn[i] < -32767) -32767 else sn[i].toInt()).toShort()
        }
    }
}
