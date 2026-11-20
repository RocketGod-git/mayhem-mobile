package com.rocketgod.mayhem.core.fleet

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * TETRA speech, receive side (ETSI EN 300 395-2), written from the standard's text and tables.
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
object TetraSpeech {
    /** Table 6: the speech frame bit (B1 to B137) carried by each type-2 bit of a half slot; Table 5 is this order with
     *  frames A and B alternating (type-2 bit 2k - 1 is frame A, 2k frame B). Class 0 is 1 to 51, class 1 52 to 107,
     *  class 2 108 to 137. */
    val ORDER = intArrayOf(
        35, 36, 37, 38, 39, 40, 41, 42, 43, 47, 48, 56, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 74, 75, 83, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 101, 102, 110, 115, 116, 117,
        118, 119, 120, 121, 122, 123, 124, 128, 129, 137,
        58, 85, 112, 54, 81, 108, 135, 50, 77, 104, 131, 45, 72, 99, 126, 55, 82, 109, 136, 5, 13, 34, 8, 16, 17, 22, 23, 24, 25, 26, 6, 14, 7, 15, 60, 87, 114, 46, 73, 100,
        127, 44, 71, 98, 125, 33, 49, 76, 103, 130, 59, 86, 113, 57, 84, 111,
        18, 19, 20, 21, 31, 32, 53, 80, 107, 134, 1, 2, 3, 4, 9, 10, 11, 12, 27, 28, 29, 30, 52, 79, 106, 133, 51, 78, 105, 132)
    /** The speech mother code (5.4.3.1). */
    val G3 = intArrayOf(0b11111, 0b11011, 0b10101)
    private val P23 = intArrayOf(1, 2, 4)
    private val P818 = intArrayOf(1, 2, 3, 4, 5, 7, 8, 10, 11)
    private val P817 = intArrayOf(1, 2, 3, 4, 5, 7, 8, 10, 11, 13, 14, 16, 17, 19, 20, 22, 23)

    /** The parity of [bits] by G(X): F(X) = X^p I(X) mod G(X), I(X) = C(1) + C(2) X + ... (5.4.2); [g] holds the
     *  exponents of G below X^p. Returns f(0) .. f(p - 1). */
    fun crc(bits: IntArray, p: Int, g: IntArray): IntArray {
        val n = bits.size; val poly = IntArray(n + p)
        for (i in 0 until n) poly[p + i] = bits[i] and 1
        for (d in n + p - 1 downTo p) if (poly[d] != 0) { poly[d] = 0; for (e in g) poly[d - p + e] = poly[d - p + e] xor 1 }
        return poly.copyOfRange(0, p)
    }
    /** Depunctured class 1 and class 2 type-3 soft bits to the mother code's input bits (Viterbi, rate 1/3). */
    private fun viterbi(c1: FloatArray, c2: FloatArray, n1: Int, n2: Int, p2: IntArray, per2: Int): IntArray {
        val m = FloatArray(3 * (n1 + n2))
        for (j in 1..c1.size) m[6 * ((j - 1) / 3) + P23[(j - 1) % 3] - 1] = c1[j - 1]
        val t = p2.size; val o = 3 * n1
        for (j in 1..c2.size) { val k = per2 * ((j - 1) / t) + p2[(j - 1) % t]; if (k <= 3 * n2) m[o + k - 1] = c2[j - 1] }
        return tetraViterbi(m, n1 + n2, G3)
    }
    class Result(val frames: List<IntArray>, val bfi: Boolean)
    /** A full slot of TCH/S: 432 type-4 soft bits (descrambled; +1 for 0) to two speech frames of 137 bits (B1 first). */
    fun full(c4: FloatArray): Result {
        val c3 = FloatArray(432)
        for (i in 0 until 18) for (j in 0 until 24) c3[j * 18 + i] = c4[i * 24 + j]
        val dec = viterbi(c3.copyOfRange(102, 270), c3.copyOfRange(270, 432), 112, 72, P818, 12)
        val c2 = IntArray(286)
        for (i in 0 until 102) c2[i] = if (c3[i] < 0) 1 else 0
        dec.copyInto(c2, 102)
        val cls2 = c2.copyOfRange(214, 274); val f = crc(cls2, 7, intArrayOf(0, 3))
        var par = 0; for (b in cls2) par = par xor b; for (b in f) par = par xor b
        var bfi = par != c2[281]
        for (i in 0 until 7) if (f[i] != c2[274 + i]) bfi = true
        val frames = listOf(IntArray(137), IntArray(137))
        for (p in 0 until 274) frames[p and 1][ORDER[p shr 1] - 1] = c2[p]
        return Result(frames, bfi)
    }
    /** A half slot of TCH/S (the second half of a stolen slot): 216 type-4 soft bits to one speech frame. */
    fun half(b4: FloatArray): Result {
        val c3 = tetraDeinterleave(b4, 101)
        val dec = viterbi(c3.copyOfRange(51, 135), c3.copyOfRange(135, 216), 56, 38, P817, 24)
        val c2 = IntArray(145)
        for (i in 0 until 51) c2[i] = if (c3[i] < 0) 1 else 0
        dec.copyInto(c2, 51)
        val f = crc(c2.copyOfRange(107, 137), 4, intArrayOf(0, 1))
        var bfi = false; for (i in 0 until 4) if (f[i] != c2[137 + i]) bfi = true
        val frame = IntArray(137)
        for (p in 0 until 137) frame[ORDER[p] - 1] = c2[p]
        return Result(listOf(frame), bfi)
    }
}

/** The parameters of one 137-bit speech frame (Table 3); pulses per subframe as pulse 1, 2, 3, 4. */
class TetraFrameParams(val lsp: IntArray, val pitch: IntArray, val pulses: Array<IntArray>, val sign: IntArray, val shift: IntArray, val gains: IntArray) {
    companion object {
        fun of(b: IntArray): TetraFrameParams {
            var i = 0
            fun f(n: Int): Int { var v = 0; for (k in 0 until n) v = (v shl 1) or (b[i++] and 1); return v }
            val lsp = intArrayOf(f(8), f(9), f(9))
            val pitch = IntArray(4); val pulses = Array(4) { IntArray(4) }; val sign = IntArray(4); val shift = IntArray(4); val gains = IntArray(4)
            for (s in 0 until 4) {
                pitch[s] = f(if (s == 0) 8 else 5)
                val p4 = f(3); val p3 = f(3); val p2 = f(3); val p1 = f(5)
                pulses[s] = intArrayOf(p1, p2, p3, p4); sign[s] = f(1); shift[s] = f(1); gains[s] = f(6)
            }
            return TetraFrameParams(lsp, pitch, pulses, sign, shift, gains)
        }
    }
}

/** The TETRA ACELP speech decoder: one 137-bit frame (or null for a bad frame) to 240 samples of 8 kHz audio in -1 .. 1. */
class TetraAcelp {
    companion object {
        private const val L_SF = 60
        private const val PIT_MAX = 143
        /** The interpolation filter for the past excitation: sinc times a Hamming window, truncated at 16 samples (4.2.2.4). */
        private const val HALF = 16
        private val Q_INIT = doubleArrayOf(30000.0, 26000.0, 21000.0, 15000.0, 8000.0, 0.0, -8000.0, -15000.0, -21000.0, -26000.0).map { it / 32768 }.toDoubleArray()
        /** The amplitudes of the four pulses (Table 2). */
        private val AMP = doubleArrayOf(1.4142, -1.0, 1.0, -1.0)
        /**
         * The energies of 4.2.2.6 are taken on the scale of the bit exact description: log2 of the energy over 40 (16-bit
         * samples). The text leaves the scale out; this one reproduces the level of the standard's decoder test sequence.
         */
        private val ESCALE = ln(40.0) / ln(2.0)
        /**
         * The decoded LSPs kept to the ordering property of 4.2.2.2 (0 < w1 < ... < w10 < pi), so 1 / A(z) stays stable:
         * the three split vectors can meet out of order. Neighbors closer than [LSP_GAP] (in frequency, radians) are spread
         * about their mean, twice over, and the set is put in order. Our own rule, not from the standard's text; it brings
         * the decoder's output closest to the standard's decoder test sequence.
         */
        private const val LSP_GAP = 0.04
        private fun log2(x: Double) = ln(x) / ln(2.0)
        private fun sat(x: Double) = if (x > 32767) 32767.0 else if (x < -32768) -32768.0 else x
        private fun interp(t: Double): Double {
            if (abs(t) >= HALF) return 0.0
            val w = 0.54 + 0.46 * cos(PI * t / HALF)
            return if (t == 0.0) 1.0 else w * sin(PI * t) / (PI * t)
        }
        /** The LSP vector (cosine domain) of three codebook indices. */
        fun lsp(i1: Int, i2: Int, i3: Int): DoubleArray {
            val q = DoubleArray(10)
            for (k in 0 until 3) q[k] = TetraTables.lsp1[3 * i1 + k] / 32768.0
            for (k in 0 until 3) q[3 + k] = TetraTables.lsp2[3 * i2 + k] / 32768.0
            for (k in 0 until 4) q[6 + k] = TetraTables.lsp3[4 * i3 + k] / 32768.0
            return q
        }
        fun lspOrder(q: DoubleArray): DoubleArray {
            val w = DoubleArray(10) { acos(max(-1.0, min(1.0, q[it]))) }
            for (pass in 0 until 2) for (i in 0 until 9) if (w[i + 1] - w[i] < LSP_GAP) { val m = (w[i] + w[i + 1]) / 2; w[i] = m - LSP_GAP / 2; w[i + 1] = m + LSP_GAP / 2 }
            w.sort()
            return DoubleArray(10) { cos(w[it]) }
        }
        /** The quantized pitch and code energy prediction errors (log2) of a gain index. */
        fun gainErrors(idx: Int): DoubleArray = doubleArrayOf(TetraTables.gains[2 * idx] / 256.0, TetraTables.gains[2 * idx + 1] / 256.0)
        /** LSPs (cosine domain) to the LP coefficients a1 .. a10 of A(z) = 1 + sum a_i z^-i (clause 4.2.2.2). */
        fun lspToA(q: DoubleArray): DoubleArray {
            fun poly(o: Int): DoubleArray {
                val f = DoubleArray(6); f[0] = 1.0
                for (i in 1..5) {
                    val c = q[2 * (i - 1) + o]
                    f[i] = -2 * c * f[i - 1] + 2 * (if (i >= 2) f[i - 2] else 0.0)
                    for (j in i - 1 downTo 1) f[j] = f[j] - 2 * c * f[j - 1] + (if (j >= 2) f[j - 2] else 0.0)
                }
                return f
            }
            val f1 = poly(0); val f2 = poly(1); val a = DoubleArray(11); a[0] = 1.0
            for (i in 5 downTo 1) { f1[i] += f1[i - 1]; f2[i] -= f2[i - 1] }
            for (i in 1..5) { a[i] = 0.5 * (f1[i] + f2[i]); a[11 - i] = 0.5 * (f1[i] - f2[i]) }
            return a
        }
        /** The pitch delay of a subframe: (whole, third), third -1, 0 or +1, from its index; [t1] the first subframe's whole delay. */
        fun pitch(idx: Int, sf: Int, t1: Int): IntArray {
            if (sf == 0) {
                if (idx < 197) { val t0 = (idx + 2) / 3 + 19; return intArrayOf(t0, idx - 3 * t0 + 58) }
                return intArrayOf(idx - 112, 0)
            }
            var tmin = t1 - 5; if (tmin < 20) tmin = 20
            if (tmin + 9 > 143) tmin = 134
            val t0 = (idx + 2) / 3 - 1 + tmin
            return intArrayOf(t0, idx - 2 - 3 * ((idx + 2) / 3 - 1))
        }
    }
    private var qPrev = Q_INIT.copyOf()
    private val exc = DoubleArray(PIT_MAX + HALF + 1 + 4 * L_SF)
    private val mem = DoubleArray(10)
    private var ep = 0.0; private var ec = 0.0
    private var last: TetraFrameParams? = null; private var lastT = 60
    /** Frames decoded, and how many of them were bad (concealed). */
    var frames = 0; var bad = 0
    fun reset() { qPrev = Q_INIT.copyOf(); exc.fill(0.0); mem.fill(0.0); ep = 0.0; ec = 0.0; last = null; lastT = 60; frames = 0; bad = 0 }
    fun decode(bits: IntArray?): FloatArray {
        frames++
        val bfi = bits == null
        if (bfi) bad++
        val p = if (bits != null) TetraFrameParams.of(bits) else last
        val out = FloatArray(4 * L_SF)
        if (p == null) { ep -= 0.5; ec -= 0.5; return out }
        if (!bfi) last = p
        val q = if (bfi) qPrev else lspOrder(lsp(p.lsp[0], p.lsp[1], p.lsp[2]))
        val base = PIT_MAX + HALF + 1
        var t1 = 0
        for (sf in 0 until 4) {
            val w = doubleArrayOf(0.25, 0.5, 0.75, 1.0)[sf]
            val qs = DoubleArray(10) { (1 - w) * qPrev[it] + w * q[it] }
            val a = lspToA(qs)
            // pitch: a bad frame repeats the last good whole delay, with no fraction
            val t0: Int; val fr: Int
            if (bfi) { t0 = lastT; fr = 0 } else { val pt = pitch(p.pitch[sf], sf, t1); t0 = pt[0]; fr = pt[1]; if (sf == 0) t1 = t0 }
            if (!bfi && sf == 3) lastT = t0
            // the adaptive codebook vector: the past excitation at the delay t0 + fr / 3, filled in place
            val o = base + sf * L_SF; val d = t0 + fr / 3.0; val v = DoubleArray(L_SF)
            for (n in 0 until L_SF) {
                val c = o + n - d; val m0 = ceil(c - HALF).toInt(); val m1 = floor(c + HALF).toInt()
                var s = 0.0; for (m in m0..m1) s += exc[m] * interp(c - m)
                v[n] = s; exc[o + n] = s
            }
            // the algebraic code: four pulses, shaped by F(z) = A(z/0.75) / A(z/0.85) and the fixed pitch contribution
            val f = DoubleArray(L_SF); val num = DoubleArray(11); val den = DoubleArray(11)
            for (i in 0..10) { num[i] = a[i] * 0.75.pow(i); den[i] = a[i] * 0.85.pow(i) }
            for (n in 0 until L_SF) { var s = if (n <= 10) num[n] else 0.0; for (i in 1..min(10, n)) s -= den[i] * f[n - i]; f[n] = s }
            if (t0 < L_SF) for (n in t0 until L_SF) f[n] += 0.8 * f[n - t0]
            val pl = p.pulses[sf]; val sh = p.shift[sf]; val sg = if (p.sign[sf] != 0) -1.0 else 1.0
            val pos = intArrayOf(2 * pl[0], 2 + 8 * pl[1], 4 + 8 * pl[2], 6 + 8 * pl[3]).map { it + sh }
            val c = DoubleArray(L_SF)
            for (k in 0 until 4) { val m = pos[k]; if (m >= L_SF) continue; for (n in m until L_SF) c[n] += sg * AMP[k] * f[n - m] }
            // the gains, from the energies: predicted from the last subframe's, corrected by the quantized prediction errors
            val h = DoubleArray(L_SF)
            for (n in 0 until L_SF) { var s = if (n == 0) 1.0 else 0.0; for (i in 1..min(10, n)) s -= a[i] * h[n - i]; h[n] = s }
            var pg = 0.0; var ev = 0.0; var ecode = 0.0
            for (n in 0 until L_SF) { pg += h[n] * h[n]; ev += v[n] * v[n]; ecode += c[n] * c[n] }
            val ea = log2((ev + 1) * pg) - ESCALE; val ef = log2(max(ecode, 1e-9) * pg) - ESCALE
            var epn: Double; var ecn: Double
            if (bfi) { epn = ep - 0.5; ecn = ec - 0.5 }
            else { val g = gainErrors(p.gains[sf]); epn = g[0] + 0.5 * ep + 0.25 * ec - 3; ecn = g[1] + 0.25 * ep + 0.5 * ec - 3 }
            epn = min(epn, 27.0); ecn = min(ecn, 25.0)
            ep = epn; ec = ecn
            val gp = 2.0.pow(0.5 * (epn - ea)); val gc = 2.0.pow(0.5 * (ecn - ef))
            // the excitation, then 1 / A(z), then the doubling of the post-processing
            val ys = DoubleArray(L_SF + 10)
            for (i in 0 until 10) ys[9 - i] = mem[i]
            for (n in 0 until L_SF) {
                val u = sat(gp * v[n] + gc * c[n])
                exc[o + n] = u
                var s = u; for (i in 1..10) s -= a[i] * ys[10 + n - i]
                s = sat(s); ys[10 + n] = s
                out[sf * L_SF + n] = (sat(2 * s) / 32768).toFloat()
            }
            // the synthesis filter's memory: its own last outputs, before the doubling (mem[0] the newest)
            for (i in 0 until 10) mem[i] = ys[L_SF + 9 - i]
        }
        if (!bfi) qPrev = q.copyOf()
        // the past excitation moves on by a frame
        exc.copyInto(exc, 0, 4 * L_SF, exc.size)
        exc.fill(0.0, exc.size - 4 * L_SF, exc.size)
        return out
    }
}
