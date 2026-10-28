package com.rocketgod.mayhem.core.ham

import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/*
 * AMBE+2 vocoder (the 3600 bps / 2450 bps voice codec used by DMR, NXDN and dPMR): FEC (Golay 23,12 on the C0
 * and C1 code words, PN descrambling of C1), parameter decode (fundamental frequency, voiced/unvoiced bands,
 * gain, PRBA and higher-order spectral amplitude vectors) and multi-band-excitation speech synthesis.
 * A port of mbelib 1.3 (ISC license, Copyright (C) 2010 mbelib Author) by way of web/src/dsp/ham/mbe.ts. Each
 * call turns one 49-bit voice frame into 160 samples of 8 kHz audio.
 */

// ------------------------------------------------------------------------------------ Golay (23,12) / (20,8)
/** Parity contribution (11 bits) of each Golay data bit, index 0 = the most significant data bit (bit 11). */
private val GOLAY_GEN = intArrayOf(0x63a, 0x31d, 0x7b4, 0x3da, 0x1ed, 0x6cc, 0x366, 0x1b3, 0x6e3, 0x54b, 0x49f, 0x475)

private fun golayParity(data: Int, bits: Int): Int {
    var p = 0
    for (j in 0 until bits) if ((data and (1 shl j)) != 0) p = p xor GOLAY_GEN[11 - j]
    return p
}

/** syndrome → error pattern over [n] code bits (data<<11 | parity), for every pattern of weight ≤ 3. */
private fun golayTable(n: Int): IntArray {
    val t = IntArray(2048) { -1 }
    fun syn(e: Int) = golayParity(e ushr 11, n - 11) xor (e and 0x7ff)
    t[0] = 0
    for (i in 0 until n) {
        t[syn(1 shl i)] = 1 shl i
        for (j in i + 1 until n) {
            t[syn((1 shl i) or (1 shl j))] = (1 shl i) or (1 shl j)
            for (k in j + 1 until n) t[syn((1 shl i) or (1 shl j) or (1 shl k))] = (1 shl i) or (1 shl j) or (1 shl k)
        }
    }
    return t
}

private val G23 = golayTable(23)
private val G19 = golayTable(19)

/** Golay (23,12): [word] is data<<11 | parity. The corrected word, or −1 when more than 3 bits are wrong. */
fun golay2312(word: Int): Int {
    val e = G23[golayParity(word ushr 11, 12) xor (word and 0x7ff)]
    return if (e < 0) -1 else word xor e
}

fun popcount(x: Int): Int = Integer.bitCount(x)

/** Golay (20,8) as the DMR slot type uses it: the 19-bit word (8 data + 11 parity). data | corrections << 8, or −1. */
fun golay208(word19: Int): Int {
    val e = G19[golayParity(word19 ushr 11, 8) xor (word19 and 0x7ff)]
    return if (e < 0) -1 else ((word19 xor e) ushr 11) or (popcount(e) shl 8)
}

// --------------------------------------------------------------------------------------------- parameters
class MbeParms {
    var w0 = 0.0; var L = 0; var gamma = 0.0; var repeat = 0
    val Vl = IntArray(58); val Ml = DoubleArray(58); val log2Ml = DoubleArray(58); val PHIl = DoubleArray(58); val PSIl = DoubleArray(58)

    fun copyTo(to: MbeParms) {
        to.w0 = w0; to.L = L; to.gamma = gamma; to.repeat = repeat
        Vl.copyInto(to.Vl); Ml.copyInto(to.Ml); log2Ml.copyInto(to.log2Ml); PHIl.copyInto(to.PHIl); PSIl.copyInto(to.PSIl)
        to.Ml[0] = 0.0
    }
}

private fun initParms(cur: MbeParms, prev: MbeParms, prevEnh: MbeParms) {
    prev.w0 = 0.09378; prev.L = 30; prev.gamma = 0.0; prev.repeat = 0
    for (l in 0..56) { prev.Ml[l] = 0.0; prev.Vl[l] = 0; prev.log2Ml[l] = 0.0; prev.PHIl[l] = 0.0; prev.PSIl[l] = PI / 2 }
    prev.copyTo(cur); prev.copyTo(prevEnh)
}

private const val NS = 160
/** Synthesis window: rises over 50 samples around the frame boundary, flat across the frame. */
private val WS = DoubleArray(321) { n -> if (n <= 55) 0.0 else if (n <= 105) (n - 55) * 0.02 else if (n <= 215) 1.0 else if (n <= 265) (265 - n) * 0.02 else 0.0 }
private const val TWO_PI = 2 * PI
/** Unvoiced synthesis works in a 256-point transform centered on the frame: the window sits at WS[x + WOFF]. */
private const val NFFT_UV = 256
private const val WOFF = NS - (NFFT_UV shr 1)
/**
 * Turns a band of unit-power noise into the amplitude the codec asked for. Calibrated against the model's own
 * rule that a band carries the same energy whether it is synthesized as tone or as noise.
 */
private const val UV_SCALE = 43.91

/** Is a frame's C0 code word clean (≤1 correction and the 24th parity bit agrees)? Strong evidence the bits are real voice. */
fun c0Clean(fr0: IntArray): Boolean {
    var c0 = 0; for (j in 23 downTo 1) c0 = (c0 shl 1) or fr0[j]
    val fix = golay2312(c0)
    if (fix < 0 || popcount(fix xor c0) > 1) return false
    return (popcount(fix) and 1) == fr0[0]
}

open class AmbeDecoder {
    protected val cur = MbeParms()
    protected val prev = MbeParms()
    protected val prevEnh = MbeParms()
    private val d = IntArray(49)
    private val Tl = DoubleArray(58)
    private val Cik = DoubleArray(5 * 18)
    // Unvoiced synthesis: one continuous pseudo-random sequence, the transform it is shaped in, this frame's
    // noise block and the previous one (the overlap-add needs both).
    private val noise = DoubleArray(NFFT_UV)
    private var noiseSeed = 3147
    private val fre = FloatArray(NFFT_UV)
    private val fim = FloatArray(NFFT_UV)
    private val binGain = DoubleArray(NFFT_UV shr 1)
    private val uw = DoubleArray(NFFT_UV)
    private val prevUw = DoubleArray(NFFT_UV)
    private val outD = DoubleArray(NS)
    val out = FloatArray(NS)
    /** Golay corrections in the last frame (C0 + C1). */
    var errs = 0
    /** What the last frame was: "" voice, E erasure, T tone, R repeat, M muted, S silence. */
    var status = ""
    /** Frames with more than this many corrected bits are not trusted, and the previous frame is repeated. */
    protected var repeatErrs = 3

    init { initParms(cur, prev, prevEnh) }

    open fun reset() { initParms(cur, prev, prevEnh); status = ""; errs = 0 }

    /**
     * Decode one DMR voice frame: [fr] is the de-interleaved frame as four code words, C0 (24 bits, index 23 first
     * on air), C1 (23), C2 (11), C3 (14), each indexed with bit 0 as its least significant bit. 160 samples, 8 kHz.
     */
    fun decode(fr: Array<IntArray>): FloatArray {
        var e = 0
        // C0: Golay (24,12) with the extra parity bit in fr[0][0] ignored
        var c0 = 0; for (j in 23 downTo 1) c0 = (c0 shl 1) or fr[0][j]
        val c0fix = golay2312(c0)
        if (c0fix < 0) e += 4 else { e += popcount((c0fix xor c0) ushr 11); for (j in 23 downTo 1) fr[0][j] = (c0fix ushr (j - 1)) and 1 }
        // PN descramble C1 with a generator seeded from C0's data bits
        var seed = 0; for (i in 23 downTo 12) seed = (seed shl 1) or fr[0][i]
        var pr = 16 * seed
        for (j in 22 downTo 0) { pr = (173 * pr + 13849) % 65536; fr[1][j] = fr[1][j] xor (pr ushr 15) }
        // C1: Golay (23,12)
        var c1 = 0; for (j in 22 downTo 0) c1 = (c1 shl 1) or fr[1][j]
        val c1fix = golay2312(c1)
        if (c1fix < 0) e += 4 else e += popcount((c1fix xor c1) ushr 11)
        var p = 0
        for (j in 23 downTo 12) d[p++] = fr[0][j]
        for (j in 22 downTo 11) d[p++] = if (c1fix < 0) fr[1][j] else (c1fix ushr j) and 1
        for (j in 10 downTo 0) d[p++] = fr[2][j]
        for (j in 13 downTo 0) d[p++] = fr[3][j]
        errs = e
        return process(e)
    }

    /**
     * Turn the decoded model parameters into 160 samples. Shared with IMBE: from here on the two codecs describe
     * speech the same way, as a pitch, a harmonic count, a voicing decision per band and a spectral amplitude.
     */
    protected fun process(e: Int): FloatArray {
        status = ""
        var bad = decodeParms()
        when {
            bad == 2 -> { status = "E"; cur.repeat = 0 }
            bad == 3 -> { status = "T"; cur.repeat = 0 }
            bad == 4 || e > repeatErrs -> { prev.copyTo(cur); cur.repeat++; status = "R"; bad = 0 }
            else -> cur.repeat = 0
        }
        if (bad == 0) {
            if (cur.repeat <= 3) {
                cur.copyTo(prev)
                enhance(cur)
                synthesize(cur, prevEnh)
                cur.copyTo(prevEnh)
                return out
            }
            status = "M"
        }
        out.fill(0f)
        initParms(cur, prev, prevEnh)
        return out
    }

    /** Reads the codec's own bits into the model: 0 good, 2 erasure, 3 tone, 4 repeat the last frame. */
    protected open fun decodeParms(): Int {
        cur.repeat = prev.repeat
        val b0 = (d[0] shl 6) or (d[1] shl 5) or (d[2] shl 4) or (d[3] shl 3) or (d[37] shl 2) or (d[38] shl 1) or d[39]
        if (b0 in 120..123) return 2
        var silence = false; var f0 = 0.0; var L = 0
        if (b0 == 124 || b0 == 125) {
            silence = true; cur.w0 = TWO_PI / 32; f0 = 1.0 / 32; L = 14; cur.L = 14
            for (l in 1..L) cur.Vl[l] = 0
            status = "S"
        } else if (b0 >= 126) return 3
        if (!silence) { f0 = W0[b0]; cur.w0 = f0 * TWO_PI; L = LTAB[b0]; cur.L = L }
        val unvc = 0.2046 / sqrt(cur.w0)
        val b1 = (d[4] shl 4) or (d[5] shl 3) or (d[6] shl 2) or (d[7] shl 1) or d[35]
        if (!silence) for (l in 1..L) { val jl = floor(l * 16 * f0).toInt(); cur.Vl[l] = VUV[b1 * 8 + jl] }
        val b2 = (d[8] shl 4) or (d[9] shl 3) or (d[10] shl 2) or (d[11] shl 1) or d[36]
        cur.gamma = DG[b2] + 0.5 * prev.gamma
        val gm = DoubleArray(9)
        val b3 = (d[12] shl 8) or (d[13] shl 7) or (d[14] shl 6) or (d[15] shl 5) or (d[16] shl 4) or (d[17] shl 3) or (d[18] shl 2) or (d[19] shl 1) or d[40]
        gm[2] = PRBA24[b3 * 3]; gm[3] = PRBA24[b3 * 3 + 1]; gm[4] = PRBA24[b3 * 3 + 2]
        val b4 = (d[20] shl 6) or (d[21] shl 5) or (d[22] shl 4) or (d[23] shl 3) or (d[41] shl 2) or (d[42] shl 1) or d[43]
        gm[5] = PRBA58[b4 * 4]; gm[6] = PRBA58[b4 * 4 + 1]; gm[7] = PRBA58[b4 * 4 + 2]; gm[8] = PRBA58[b4 * 4 + 3]
        val ri = DoubleArray(9)
        for (i in 1..8) {
            var sum = 0.0
            for (m in 1..8) sum += (if (m == 1) 1 else 2) * gm[m] * cos(PI * (m - 1) * (i - 0.5) / 8)
            ri[i] = sum
        }
        val rconst = 1 / (2 * sqrt(2.0))
        Cik[1 * 18 + 1] = 0.5 * (ri[1] + ri[2]); Cik[1 * 18 + 2] = rconst * (ri[1] - ri[2])
        Cik[2 * 18 + 1] = 0.5 * (ri[3] + ri[4]); Cik[2 * 18 + 2] = rconst * (ri[3] - ri[4])
        Cik[3 * 18 + 1] = 0.5 * (ri[5] + ri[6]); Cik[3 * 18 + 2] = rconst * (ri[5] - ri[6])
        Cik[4 * 18 + 1] = 0.5 * (ri[7] + ri[8]); Cik[4 * 18 + 2] = rconst * (ri[7] - ri[8])
        val b5 = (d[24] shl 4) or (d[25] shl 3) or (d[26] shl 2) or (d[27] shl 1) or d[44]
        val b6 = (d[28] shl 3) or (d[29] shl 2) or (d[30] shl 1) or d[45]
        val b7 = (d[31] shl 3) or (d[32] shl 2) or (d[33] shl 1) or d[46]
        val b8 = (d[34] shl 2) or (d[47] shl 1) or d[48]
        val ji = intArrayOf(0, LMPRBL[L * 4], LMPRBL[L * 4 + 1], LMPRBL[L * 4 + 2], LMPRBL[L * 4 + 3])
        val hoc = arrayOf(DoubleArray(0), HOC5, HOC6, HOC7, HOC8); val hb = intArrayOf(0, b5, b6, b7, b8)
        for (i in 1..4) for (k in 3..ji[i]) Cik[i * 18 + k] = if (k > 6) 0.0 else hoc[i][hb[i] * 4 + k - 3]
        // inverse DCT of each block gives the log-amplitude prediction residuals
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

    /** Spectral amplitude enhancement (perceptual formant sharpening). */
    private fun enhance(c: MbeParms) {
        var rm0 = 0.0; var rm1 = 0.0
        for (l in 1..c.L) { val m2 = c.Ml[l] * c.Ml[l]; rm0 += m2; rm1 += m2 * cos(c.w0 * l) }
        val r2m0 = rm0 * rm0; val r2m1 = rm1 * rm1
        for (l in 1..c.L) {
            if (c.Ml[l] == 0.0) continue
            val wl = sqrt(c.Ml[l]) * ((0.96 * PI * ((r2m0 + r2m1) - 2 * rm0 * rm1 * cos(c.w0 * l))) / (c.w0 * rm0 * (r2m0 - r2m1))).pow(0.25)
            if (8 * l <= c.L) continue
            c.Ml[l] *= if (wl > 1.2) 1.2 else if (wl < 0.5) 0.5 else if (wl.isNaN()) 1.0 else wl
        }
        var sum = 0.0
        for (l in 1..c.L) sum += c.Ml[l] * c.Ml[l]
        val g = if (sum == 0.0) 1.0 else sqrt(rm0 / sum)
        for (l in 1..c.L) c.Ml[l] *= g
    }

    /**
     * The next 160 samples of excitation noise, kept as one continuous sequence across frames. Restarting it every
     * frame is what makes the reference implementation's unvoiced bands sound like a bank of restarting oscillators.
     */
    private fun nextNoise() {
        val u = noise
        System.arraycopy(u, NS, u, 0, NFFT_UV - NS)
        // centered on zero: an all-positive sequence is a constant plus noise, which the window turns into a pulse
        for (i in NFFT_UV - NS until NFFT_UV) { noiseSeed = (171 * noiseSeed + 11213) % 53125; u[i] = (noiseSeed - 26562).toDouble() }
    }

    /**
     * Unvoiced bands the way the standard builds them: shape a block of noise with the synthesis window, transform
     * it, keep only the bins in bands this frame called unvoiced, scale each band to its decoded amplitude, and
     * transform back.
     */
    private fun synthUnvoiced(c: MbeParms) {
        val re = fre; val im = fim; val u = noise; val gain = binGain; val half = NFFT_UV shr 1
        nextNoise()
        for (x in 0 until NFFT_UV) { re[x] = (u[x] * WS[x + WOFF]).toFloat(); im[x] = 0f }
        fftInPlace(re, im, false)
        gain.fill(0.0)
        val bins = NFFT_UV * c.w0 / TWO_PI
        for (l in 1..c.L) {
            if (c.Vl[l] != 0) continue
            val a = max(1, ceil((l - 0.5) * bins).toInt()); val b = min(half, ceil((l + 0.5) * bins).toInt())
            if (b <= a) continue
            var pow = 0.0
            for (k in a until b) pow += (re[k] * re[k] + im[k] * im[k]).toDouble()
            val rms = sqrt(pow / (b - a))
            if (rms > 0) { val s = UV_SCALE * c.Ml[l] / rms; for (k in a until b) gain[k] = s }
        }
        for (k in 1 until half) {
            val s = gain[k].toFloat(); val m = NFFT_UV - k
            re[k] *= s; im[k] *= s; re[m] *= s; im[m] *= s
        }
        re[0] = 0f; im[0] = 0f; re[half] = 0f; im[half] = 0f
        for (k in 0 until NFFT_UV) im[k] = -im[k]       // inverse transform via the conjugate of the forward one
        fftInPlace(re, im, false)
        val g = 1.0 / NFFT_UV
        for (k in 0 until NFFT_UV) uw[k] = re[k] * g
    }

    private fun synthesize(c: MbeParms, p: MbeParms) {
        val o = outD
        val cw0 = c.w0; val pw0 = p.w0
        o.fill(0.0)
        val maxl: Int
        if (c.L > p.L) { maxl = c.L; for (l in p.L + 1..maxl) { p.Ml[l] = 0.0; p.Vl[l] = 1 } }
        else { maxl = p.L; for (l in c.L + 1..maxl) { c.Ml[l] = 0.0; c.Vl[l] = 1 } }
        for (l in 1..56) {
            var psi = p.PSIl[l] + (pw0 + cw0) * (l * NS / 2.0)
            psi -= TWO_PI * floor(psi / TWO_PI)
            c.PSIl[l] = psi
            // The codec sends no phase, so the decoder invents it; keeping the predicted phase throughout sounds
            // clearly better than the reference's per-frame randomization of the upper harmonics.
            c.PHIl[l] = psi
        }
        for (l in 1..maxl) {
            val cw0l = cw0 * l; val pw0l = pw0 * l
            val cV = c.Vl[l] == 1; val pV = p.Vl[l] == 1
            val cM = c.Ml[l]; val pM = p.Ml[l]; val cPhi = c.PHIl[l]; val pPhi = p.PHIl[l]
            if (cV && pV) for (n in 0 until NS) o[n] += WS[n + NS] * pM * cos(pw0l * n + pPhi) + WS[n] * cM * cos(cw0l * (n - NS) + cPhi)
            else if (cV) for (n in 0 until NS) o[n] += WS[n] * cM * cos(cw0l * (n - NS) + cPhi)
            else if (pV) for (n in 0 until NS) o[n] += WS[n + NS] * pM * cos(pw0l * n + pPhi)
        }
        // This frame's noise block, overlap-added with the previous one, weighted by the sum of the SQUARED windows:
        // two uncorrelated noise blocks add in power, so amplitude weights would leave a 3 dB hole mid-frame.
        synthUnvoiced(c)
        val half = NFFT_UV shr 1
        for (n in 0 until NS) {
            val wp = WS[n + NS]; val wc = WS[n]; val den = wp * wp + wc * wc
            if (den <= 0) continue
            var v = 0.0
            if (wp > 0) v += wp * prevUw[n + half]
            if (wc > 0) v += wc * uw[n + half - NS]
            o[n] += v / den
        }
        uw.copyInto(prevUw)
        val g = 7.0 / 32768
        for (n in 0 until NS) { val v = o[n] * g; out[n] = (if (v > 1) 1.0 else if (v < -1) -1.0 else v).toFloat() }
    }
}

// ================================================================================================ IMBE (P25)

/*
 * IMBE 7200x4400, the vocoder P25 Phase 1 carries: 144 bits on air every 20 ms, 88 of them parameters. Only the
 * front half differs from AMBE; once the bits become a pitch, a harmonic count, voicing and spectral amplitudes
 * the two share the enhancement and synthesis above. Every value is scalar quantized with a bit allocation that
 * depends on the harmonic count; what is intricate is where the bits live, ordered by how much protection they
 * deserve rather than by what they mean. Ported from mbelib (ISC), checked against JMBE and OP25.
 */

private val HAM_GEN = intArrayOf(0x7f08, 0x78e4, 0x66d2, 0x55b1)
private val HAM_FIX = intArrayOf(0x0, 0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80, 0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000)

/** The de-interleave as a rule: read out of a six-row, twenty-four-column block, odd columns swapping rows in pairs. */
private val DEINT = IntArray(144) { i -> val j = i / 6; val r = i % 6; j + 24 * (if ((j and 1) != 0) r xor 1 else r) }
private val WORD_AT = intArrayOf(0, 23, 46, 69, 92, 107, 122, 137)
private val WORD_LEN = intArrayOf(23, 23, 23, 23, 15, 15, 15, 7)

class ImbeDecoder : AmbeDecoder() {
    private val id = IntArray(88)
    // twelve wide: every quantized value fits in ten bits, but the voicing word runs to twelve
    private val bb = Array(58) { IntArray(12) }
    private val w = IntArray(144)
    private val words = IntArray(8)
    private val iTl = DoubleArray(58)
    private val iCik = Array(7) { DoubleArray(11) }
    private val ri = DoubleArray(7)
    private val gm = DoubleArray(7)

    init { repeatErrs = 5 }

    /** One voice frame: the 144 bits as they came off the air. 160 samples at 8 kHz. */
    fun decodeVoice(bits: IntArray): FloatArray {
        for (i in 0 until 144) w[DEINT[i]] = bits[i]
        for (k in 0 until 8) {
            var v = 0
            for (i in 0 until WORD_LEN[k]) v = (v shl 1) or w[WORD_AT[k] + i]
            words[k] = v
        }
        var e = 0
        // the first word protects the seed for everything else, so it is corrected before anything is descrambled
        val u0 = golay2312(words[0])
        if (u0 < 0) e += 4 else { e += popcount((u0 xor words[0]) ushr 11); words[0] = u0 }
        var pr = 16 * (words[0] ushr 11)
        for (k in 1 until 7) {
            for (b in WORD_LEN[k] - 1 downTo 0) { pr = (173 * pr + 13849) % 65536; words[k] = words[k] xor ((pr ushr 15) shl b) }
        }
        for (k in 1 until 4) {
            val fix = golay2312(words[k])
            if (fix < 0) e += 4 else { e += popcount((fix xor words[k]) ushr 11); words[k] = fix }
        }
        for (k in 4 until 7) {
            var syn = 0
            for (i in 0 until 4) syn = (syn shl 1) or (popcount(words[k] and HAM_GEN[i]) and 1)
            if (syn != 0) { words[k] = words[k] xor HAM_FIX[syn]; e++ }
        }
        var p = 0
        for (k in 0 until 4) for (b in 11 downTo 0) id[p++] = (words[k] ushr (b + 11)) and 1
        for (k in 4 until 7) for (b in 10 downTo 0) id[p++] = (words[k] ushr (b + 4)) and 1
        for (b in 6 downTo 0) id[p++] = (words[7] ushr b) and 1
        errs = e
        return process(e)
    }

    /**
     * Spread the 88 bits across the parameters: significance-major, so the bits that matter most sit in the best
     * protected code words; the voicing bits interrupt at a fixed point and the bottom gain bits are placed singly.
     */
    private fun scatter(L: Int, K: Int) {
        for (m in 0..L + 1) bb[m].fill(0)
        fun len(m: Int) = if (m < 3) 0 else if (m < 8) IMBE_BA_BITS[L - 9][m - 3] else IMBE_HOBA[L - 9][m - 8]
        val order = ArrayList<Int>()
        for (p in 9 downTo 0) for (m in 3..L + 1) if (len(m) > p) order.add(m * 16 + p)
        var s = 0
        fun put(at: Int, m: Int, b: Int) { bb[m][b] = id[at] }
        for (k in 0 until 6) put(6 + k, 2, 5 - k)
        for (k in 0 until 39) { val o = order[s++]; put(9 + k, o shr 4, o and 15) }
        for (k in 0 until K) put(48 + k, 1, K - 1 - k)
        put(48 + K, 2, 2); put(49 + K, 2, 1)
        for (k in 50 + K until 84) { val o = order[s++]; put(k, o shr 4, o and 15) }
        put(84, 2, 0)
    }

    override fun decodeParms(): Int {
        cur.repeat = prev.repeat
        val b0 = (id[0] shl 7) or (id[1] shl 6) or (id[2] shl 5) or (id[3] shl 4) or (id[4] shl 3) or (id[5] shl 2) or (id[85] shl 1) or id[86]
        if (b0 > 207) return 4
        cur.w0 = 4 * PI / (b0 + 39.5)
        val L = floor(0.9254 * floor(PI / cur.w0 + 0.25)).toInt()
        if (L < 9 || L > 56) return 4
        cur.L = L
        val l9 = L - 9; val K = if (L < 37) (L + 2) / 3 else 12
        scatter(L, K)
        // voicing: one bit per band of three harmonics, the first band taking the most significant bit
        run {
            var j = 1; var k = K - 1
            for (l in 1..L) {
                cur.Vl[l] = bb[1][k]
                if (j == 3) { j = 1; if (k > 0) k-- } else j++
            }
        }
        var b2 = 0; for (b in 5 downTo 0) b2 = (b2 shl 1) or bb[2][b]
        gm[1] = IMBE_B2[b2]
        for (i in 2 until 7) {
            val bits = IMBE_BA_BITS[l9][i - 2]; val step = IMBE_BA_STEP[l9 * 5 + (i - 2)]
            var bm = 0; for (b in bits - 1 downTo 0) bm = (bm shl 1) or bb[i + 1][b]
            gm[i] = step * (bm - 2.0.pow(bits - 1) + 0.5)
        }
        for (i in 1..6) {
            var sum = 0.0
            for (m in 1..6) sum += (if (m == 1) 1 else 2) * gm[m] * cos(PI * (m - 1) * (i - 0.5) / 6)
            ri[i] = sum
        }
        var m = 8
        for (i in 1..6) {
            iCik[i][1] = ri[i]
            for (k in 2..IMBE_JI[l9][i - 1]) {
                val bmBits = IMBE_HOBA[l9][m - 8]
                if (bmBits == 0) iCik[i][k] = 0.0
                else {
                    var bm = 0; for (b in bmBits - 1 downTo 0) bm = (bm shl 1) or bb[m][b]
                    iCik[i][k] = IMBE_QUANT_STEP[bmBits - 1] * IMBE_STAND_DEV[k - 2] * (bm - 2.0.pow(bmBits - 1) + 0.5)
                }
                m++
            }
        }
        var l = 1
        for (i in 1..6) {
            val ji = IMBE_JI[l9][i - 1]
            for (j in 1..ji) {
                var sum = 0.0
                for (k in 1..ji) sum += (if (k == 1) 1 else 2) * iCik[i][k] * cos(PI * (k - 1) * (j - 0.5) / ji)
                iTl[l++] = sum
            }
        }
        // amplitudes are a difference from the previous frame, interpolated across a harmonic count change, with
        // the frame's mean level removed so an error cannot accumulate
        val rho = if (L <= 15) 0.4 else if (L <= 24) 0.03 * L - 0.05 else 0.7
        if (L > prev.L) for (q in prev.L + 1..L) { prev.Ml[q] = prev.Ml[prev.L]; prev.log2Ml[q] = prev.log2Ml[prev.L] }
        var mean = 0.0
        for (q in 1..L) {
            val f = prev.L.toDouble() / L * q; val k = floor(f).toInt(); val dd = f - k
            mean += (1 - dd) * prev.log2Ml[k] + dd * prev.log2Ml[k + 1]
        }
        mean *= rho / L
        for (q in 1..L) {
            val f = prev.L.toDouble() / L * q; val k = floor(f).toInt(); val dd = f - k
            cur.log2Ml[q] = iTl[q] + rho * (1 - dd) * prev.log2Ml[k] + rho * dd * prev.log2Ml[k + 1] - mean
            cur.Ml[q] = 2.0.pow(cur.log2Ml[q])
        }
        return 0
    }
}
