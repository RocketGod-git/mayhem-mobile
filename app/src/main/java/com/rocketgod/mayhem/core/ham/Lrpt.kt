package com.rocketgod.mayhem.core.ham

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * Meteor-M N2-3 / N2-4 LRPT (137.9 / 137.1 MHz, 72 kbaud QPSK). Twin of web/src/dsp/ham/lrpt.ts + lrpt-fec.ts.
 *
 * A QPSK demodulator on the 240 kHz complex baseband (AGC, root-raised-cosine matched filter, fourth-power
 * frequency acquisition, Costas carrier loop, Gardner symbol timing), frame sync under all eight constellation
 * ambiguities, full-frame Viterbi (rate 1/2, K = 7), CCSDS descrambling and Reed-Solomon (255,223) with the
 * dual-basis root spacing, then transfer frames → M-PDU packets → MSU-MR image segments: 14 JPEG-style 8×8 MCUs
 * per packet, 196 per 1568-pixel line, one APID per spectral channel. Strips go out as they decode so the
 * picture builds live. RS, descrambler and packet / MCU / JPEG layout follow meteor_decode by dbdexter-dev (MIT).
 */

// ------------------------------------------------------------------------------------------- channel coding
private const val G1 = 0x79
private const val G2 = 0x5b
private const val K = 7
private const val STATES = 1 shl K
private const val SYNCWORD = 0x1acffc1d
private const val CADU_BYTES = 1024
private const val FRAME_SYMBOLS = CADU_BYTES * 8

private fun parity(x0: Int): Int { var x = x0; x = x xor (x shr 16); x = x xor (x shr 8); x = x xor (x shr 4); x = x xor (x shr 2); x = x xor (x shr 1); return x and 1 }

/** Encoder output (2 bits: G1 << 1 | G2) for each 7-bit shift-register state. */
private val OUT = IntArray(STATES) { (parity(it and G1) shl 1) or parity(it and G2) }

private fun convEncode32(word: Int): IntArray {
    val out = IntArray(32); var state = 0
    for (i in 31 downTo 0) {
        state = ((state shr 1) or (((word ushr i) and 1) shl (K - 1))) and (STATES - 1)
        out[31 - i] = OUT[state]
    }
    return out
}

/** Full-frame Viterbi: [soft] holds 2n values (G1, G2; positive = 1), [out] gets n / 8 bytes. Returns a BER estimate. */
private class Viterbi(private val n: Int) {
    private val prev = ByteArray(n * STATES)
    private var m0 = IntArray(STATES); private var m1 = IntArray(STATES)

    fun decode(soft: ByteArray, out: ByteArray): Double {
        var m = m0; var nm = m1
        m.fill(0)
        for (t in 0 until n) {
            val x = soft[2 * t].toInt(); val y = soft[2 * t + 1].toInt()
            val bm0 = -x - y; val bm1 = -x + y; val bm2 = x - y; val bm3 = x + y
            val base = t * STATES
            for (s in 0 until STATES) {
                val p0 = (s shl 1) and (STATES - 1); val p1 = p0 or 1
                val bm = when (OUT[s]) { 0 -> bm0; 1 -> bm1; 2 -> bm2; else -> bm3 }   // output depends only on the new state
                val c0 = m[p0] + bm; val c1 = m[p1] + bm
                if (c0 >= c1) { nm[s] = c0; prev[base + s] = p0.toByte() } else { nm[s] = c1; prev[base + s] = p1.toByte() }
            }
            if ((t and 255) == 255) { var mx = Int.MIN_VALUE; for (s in 0 until STATES) if (nm[s] > mx) mx = nm[s]; for (s in 0 until STATES) nm[s] -= mx }
            val tmp = m; m = nm; nm = tmp
        }
        m0 = m; m1 = nm
        var best = 0; for (s in 1 until STATES) if (m[s] > m[best]) best = s
        var s = best; var wrong = 0
        out.fill(0)
        for (t in n - 1 downTo 0) {
            if ((s shr (K - 1)) != 0) out[t shr 3] = (out[t shr 3].toInt() or (0x80 shr (t and 7))).toByte()
            val o = OUT[s]
            if (((o shr 1) and 1) != (if (soft[2 * t] > 0) 1 else 0)) wrong++
            if ((o and 1) != (if (soft[2 * t + 1] > 0) 1 else 0)) wrong++
            s = prev[t * STATES + s].toInt()
        }
        return wrong / (2.0 * n)
    }
}

/** Map a received (I, Q) to (G1, G2) under variant v: rotation v & 3 (× 90°), then swap when v ≥ 4. */
private fun applyVariant(i: Int, q: Int, v: Int, forward: Boolean, out: IntArray) {
    var a = i; var b = q
    if (forward) {
        when (v and 3) { 1 -> { val t = a; a = -b; b = t }; 2 -> { a = -a; b = -b }; 3 -> { val t = a; a = b; b = -t } }
        if ((v and 4) != 0) { val t = a; a = b; b = t }
    } else {
        if ((v and 4) != 0) { val t = a; a = b; b = t }
        when (v and 3) { 1 -> { val t = a; a = b; b = -t }; 2 -> { a = -a; b = -b }; 3 -> { val t = a; a = -b; b = t } }
    }
    out[0] = a; out[1] = b
}

/** The coded sync word as 32 symbols, as it appears under each of the 8 constellation ambiguities. */
private val SYNC_VARIANTS: Array<IntArray> = run {
    val pairs = convEncode32(SYNCWORD)
    val o = IntArray(2)
    Array(8) { v ->
        IntArray(64).also { arr ->
            for (i in 0 until 32) {
                applyVariant(if (((pairs[i] shr 1) and 1) != 0) 1 else -1, if ((pairs[i] and 1) != 0) 1 else -1, v, true, o)
                arr[2 * i] = o[0]; arr[2 * i + 1] = o[1]
            }
        }
    }
}

/** Correlate 32 soft symbols against every sync variant: (variant, score 0..1). */
private fun syncScore(soft: ByteArray, at: Int, len: Int): Pair<Int, Double> {
    var bestV = 0; var best = -1.0
    for (v in 0 until 8) {
        val s = SYNC_VARIANTS[v]
        var c = 0; var a = 0
        for (k in 0 until 64) { val x = soft[(at + k) % len].toInt(); c += x * s[k]; a += abs(x) }
        val score = if (a > 0) c.toDouble() / a else 0.0
        if (score > best) { best = score; bestV = v }
    }
    return bestV to best
}

private val NOISE = IntArray(255).also { n ->
    var state = 0xff
    for (i in 0 until 255) {
        var b = 0
        for (j in 0 until 8) {
            val nb = ((state shr 7) xor (state shr 5) xor (state shr 3) xor state) and 1
            b = (b shl 1) or (state and 1); state = (state shr 1) or (nb shl 7)
        }
        n[i] = b
    }
}
/** Undo the CCSDS randomiser over the 1020 bytes after the sync marker. */
private fun descramble(cadu: ByteArray) { for (i in 0 until 1020) cadu[4 + i] = (cadu[4 + i].toInt() xor NOISE[i % 255]).toByte() }

// Reed-Solomon (255,223), interleave 4, dual-basis root spacing 11
private const val RS_N = 255
private const val RS_T = 32
private const val RS_T2 = 16
private const val GEN_POLY = 0x187
private const val FIRST_ROOT = 112
private const val ROOT_SKIP = 11
private val ALPHA = IntArray(RS_N + 1)
private val LOGT = IntArray(RS_N + 1)
private val GAPROOT = IntArray(RS_N)
private val ZEROES = IntArray(RS_T)
private val rsInit = run {
    ALPHA[0] = 1; LOGT[1] = 0; LOGT[0] = 183
    for (i in 1 until RS_N) { var t = ALPHA[i - 1] shl 1; if (t > RS_N) t = t xor GEN_POLY; ALPHA[i] = t; LOGT[t] = i }
    LOGT[255] = 183; ALPHA[255] = 0
    // alpha^0 raised to the skip lands on 255, past the table; the decoder never looks there
    for (i in 0 until RS_N) { val k = gfpow(i, ROOT_SKIP); if (k < RS_N) GAPROOT[k] = i }
    for (i in 0 until RS_T) ZEROES[i] = ALPHA[((i + FIRST_ROOT) * ROOT_SKIP) % RS_N]
    true
}
private fun gfmul(x: Int, y: Int) = if (x == 0 || y == 0) 0 else ALPHA[(LOGT[x] + LOGT[y]) % RS_N]
private fun gfdiv(x: Int, y: Int) = if (x == 0 || y == 0) 0 else ALPHA[(LOGT[x] - LOGT[y] + RS_N) % RS_N]
private fun gfpow(x: Int, e: Int) = if (x == 0) 0 else ALPHA[(LOGT[x] * e) % RS_N]
private fun polyEval(p: IntArray, x: Int, len: Int): Int { var r = 0; for (i in len - 1 downTo 0) r = gfmul(r, x) xor p[i]; return r }

/** Correct one 255-byte code word in place: symbols corrected, or −1. */
private fun fixBlock(d: IntArray): Int {
    val syn = IntArray(RS_T)
    var any = 0
    for (i in 0 until RS_T) { syn[i] = polyEval(d, ZEROES[i], RS_N); any = any or syn[i] }
    if (any == 0) return 0
    val lambda = IntArray(RS_T2 + 1); val prevL = IntArray(RS_T2 + 1)
    var deg = 0; var prevDelta = 1; var m = 1
    lambda[0] = 1; prevL[0] = 1
    for (n in 0 until RS_T) {
        var delta = syn[n]
        for (i in 1..deg) delta = delta xor gfmul(syn[n - i], lambda[i])
        if (delta == 0) m++
        else if (2 * deg <= n) {
            val tmp = lambda.copyOf()
            for (i in m until RS_T2 + 1) lambda[i] = lambda[i] xor gfmul(gfdiv(delta, prevDelta), prevL[i - m])
            tmp.copyInto(prevL); prevDelta = delta; deg = n + 1 - deg; m = 1
        } else {
            for (i in m until RS_T2 + 1) lambda[i] = lambda[i] xor gfmul(gfdiv(delta, prevDelta), prevL[i - m])
            m++
        }
    }
    val roots = ArrayList<Int>(); val pos = ArrayList<Int>()
    var i = 1
    while (i <= RS_N && roots.size < deg) { if (polyEval(lambda, i, RS_T2 + 1) == 0) { roots.add(i); pos.add(LOGT[GAPROOT[gfdiv(1, i)]]) }; i++ }
    if (roots.size != deg) return -1
    val omega = IntArray(RS_T)
    for (j in 0 until RS_T2 + 1) for (k in 0 until RS_T) if (k + j < RS_T) omega[k + j] = omega[k + j] xor gfmul(syn[k], lambda[j])
    val lprime = IntArray(RS_T2)
    for (k in 1 until RS_T2 + 1) { lprime[k - 1] = 0; for (j in 0 until k) lprime[k - 1] = lprime[k - 1] xor lambda[k] }
    for (k in roots.indices) {
        val fcr = gfpow(roots[k], FIRST_ROOT - 1)
        val num = polyEval(omega, roots[k], RS_T); val den = polyEval(lprime, roots[k], RS_T2)
        if (pos[k] in d.indices) d[pos[k]] = d[pos[k]] xor gfdiv(gfmul(num, fcr), den)
    }
    return roots.size
}

/** Correct the four interleaved RS code words of a CADU in place: total corrections, or −1. */
private fun rsFix(cadu: ByteArray): Int {
    check(rsInit)
    val block = IntArray(RS_N)
    var errors = 0
    for (i in 0 until 4) {
        for (j in 0 until RS_N) block[j] = cadu[4 + j * 4 + i].toInt() and 0xff
        val e = fixBlock(block)
        errors = if (e < 0 || errors < 0) -1 else errors + e
        for (j in 0 until RS_N) cadu[4 + j * 4 + i] = block[j].toByte()
    }
    return errors
}

// ------------------------------------------------------------------------------------------- JPEG pieces
private val DC_PREFIX = intArrayOf(2, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9)
private val AC_SIZE = intArrayOf(0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125)
private val AC_TABLE = intArrayOf(1, 2, 3, 0, 4, 17, 5, 18, 33, 49, 65, 6, 19, 81, 97, 7, 34, 113, 20, 50, 129, 145, 161, 8, 35, 66, 177, 193, 21, 82, 209, 240, 36, 51, 98, 114, 130,
    9, 10, 22, 23, 24, 25, 26, 37, 38, 39, 40, 41, 42, 52, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73, 74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105, 106, 115, 116, 117, 118, 119, 120, 121, 122, 131,
    132, 133, 134, 135, 136, 137, 138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167, 168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196, 197, 198, 199, 200, 201, 202, 210, 211,
    212, 213, 214, 215, 216, 217, 218, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250)
private val QUANT = intArrayOf(16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99)
private val ZIGZAG = intArrayOf(0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63)
private val COS = DoubleArray(64) { val x = it / 8; val u = it % 8; (if (u == 0) sqrt(0.5) else 1.0) * cos((2 * x + 1) * u * PI / 16) }

/** [count] bits starting [bitOff] bits into src[off..], MSB first, as a non-negative Long (up to 32 bits). */
private fun readBits(src: ByteArray, off: Int, bitOff: Int, count: Int): Long {
    if (count <= 0) return 0
    var p = off + (bitOff shr 3); val b = bitOff and 7
    fun at(i: Int): Long = if (i in src.indices) (src[i].toLong() and 0xff) else 0L
    var ret = at(p++) and ((1L shl (8 - b)) - 1)
    var left = count - (8 - b)
    while (left > 0) { ret = ret * 256 + at(p++); left -= 8 }
    return ret shr (-left)
}

private fun dcCategory(code16: Int): Int = when {
    code16 shr 14 == 0 -> 0
    code16 shr 13 < 7 -> (code16 shr 13) - 1
    code16 shr 12 < 0xf -> 6
    code16 shr 11 < 0x1f -> 7
    code16 shr 10 < 0x3f -> 8
    code16 shr 9 < 0x7f -> 9
    code16 shr 8 < 0xff -> 10
    code16 shr 7 < 0x1ff -> 11
    else -> -1
}

/** Huffman-decode [count] 8×8 blocks (zig-zag order) from src[off..]; false on a bad stream. */
private fun huffmanDecode(dst: IntArray, src: ByteArray, off: Int, count: Int, maxLen: Int): Boolean {
    var bit = 0; var dc = 0
    val end = off + maxLen
    for (i in 0 until count) {
        val blk = i * 64
        dst.fill(0, blk, blk + 64)
        val dcInfo = readBits(src, off, bit, 32)
        val cat = dcCategory((dcInfo ushr 16).toInt())
        if (cat < 0) return false
        val pre = DC_PREFIX[cat]
        val sign = ((dcInfo ushr (31 - pre)) and 1L).toInt()
        val extra = if (cat > 1) ((dcInfo ushr (31 - pre - cat + 1)) and ((1L shl (cat - 1)) - 1)).toInt() else 0
        if (cat != 0) dc += extra + if (sign != 0) 1 shl (cat - 1) else 1 - (1 shl cat)
        dst[blk] = dc
        bit += pre + cat
        if (off + (bit shr 3) >= end) break
        var r = 1
        while (r < 64) {
            val buf = readBits(src, off, bit, 32)
            var first = 0L; var idx = 0; var j = 2; var info = 0L
            while (j < AC_SIZE.size) {
                info = buf ushr (32 - j)
                if (info - first < AC_SIZE[j]) { info = AC_TABLE[(idx + info - first).toInt()].toLong(); break }
                first = (first + AC_SIZE[j]) shl 1; idx += AC_SIZE[j]
                j++
            }
            if (j >= AC_SIZE.size) return false
            bit += j
            if (info == 0L) break                          // end of block
            val run = ((info shr 4) and 15).toInt(); val acat = (info and 15).toInt()
            val asign = readBits(src, off, bit, 1).toInt()
            val aextra = if (acat > 1) readBits(src, off, bit + 1, acat - 1).toInt() else 0
            val coef = if (acat > 0) aextra + if (asign != 0) 1 shl (acat - 1) else 1 - (1 shl acat) else 0
            var k = 0
            while (k < run && r < 63) { dst[blk + r] = 0; k++; r++ }
            dst[blk + r] = coef
            bit += acat
            if (off + (bit shr 3) >= end) return true
            r++
        }
        if (off + (bit shr 3) >= end) break
    }
    return true
}

/** De-zigzag, dequantise (JPEG quality q) and inverse-DCT one block into 64 grey pixels. */
private fun idctBlock(src: IntArray, at: Int, q: Int, out: ByteArray, outAt: Int, f: DoubleArray, row: DoubleArray) {
    val compr = if (q < 50) 5000.0 / max(1, q) else 200.0 - 2 * q
    for (k in 0 until 64) { val nat = ZIGZAG[k]; val qv = max(1, floor((QUANT[nat] * compr / 50 + 1) / 2).toInt()); f[nat] = (src[at + k] * qv).toDouble() }
    for (y in 0 until 8) for (x in 0 until 8) { var s = 0.0; for (u in 0 until 8) s += COS[x * 8 + u] * f[y * 8 + u]; row[y * 8 + x] = s / 2 }
    for (x in 0 until 8) for (y in 0 until 8) {
        var s = 0.0; for (v in 0 until 8) s += COS[y * 8 + v] * row[v * 8 + x]
        out[outAt + y * 8 + x] = (s / 2 + 128).roundToInt().coerceIn(0, 255).toByte()
    }
}

// ------------------------------------------------------------------------------------------- demodulator
private const val IN_RATE = 240_000.0
private const val SYM_RATE = 72_000.0
private const val SPS = IN_RATE / SYM_RATE
private const val MCU_PER_MPDU = 14
private const val MPDU_PER_LINE = 14
private const val MPDU_PER_PERIOD = 43
private const val VCDU_DATA = 882
private const val MPDU_HDR = 6
private const val MPDU_MAX = 6 + 8 + 2048

/** Root-raised-cosine taps, unity DC gain. */
private fun rrcTaps(alpha: Double, sps: Double, span: Int): FloatArray {
    val n = (span * sps).roundToInt() or 1; val h = FloatArray(n); val m = (n - 1) / 2.0
    var sum = 0.0
    for (i in 0 until n) {
        val t = (i - m) / sps
        val v = if (t == 0.0) 1 - alpha + 4 * alpha / PI
        else if (abs(abs(t) - 1 / (4 * alpha)) < 1e-6) (alpha / sqrt(2.0)) * ((1 + 2 / PI) * sin(PI / (4 * alpha)) + (1 - 2 / PI) * cos(PI / (4 * alpha)))
        else (sin(PI * t * (1 - alpha)) + 4 * alpha * t * cos(PI * t * (1 + alpha))) / (PI * t * (1 - 16 * alpha * alpha * t * t))
        h[i] = v.toFloat(); sum += v
    }
    for (i in 0 until n) h[i] = (h[i] / sum).toFloat()
    return h
}

data class LrptStats(val lock: Boolean, val freqHz: Double, val ber: Double, val rs: Int, val frames: Int, val badFrames: Int)

class LrptDecoder : IqTap {
    /** (apid, strip line, x, 8×112 grey pixels). */
    var onStrip: (Int, Int, Int, ByteArray) -> Unit = { _, _, _, _ -> }
    var onStats: (LrptStats) -> Unit = {}
    var onLog: (String) -> Unit = {}

    private val rrc = rrcTaps(0.6, SPS, 8)
    private val histI = FloatArray(rrc.size); private val histQ = FloatArray(rrc.size); private var hpos = 0
    private var agc = 1.0
    private var theta = 0.0; private var omega = 0.0
    private var nextSym = SPS; private var period = SPS
    private var prevSymI = 0.0; private var prevSymQ = 0.0
    private val fI = DoubleArray(4); private val fQ = DoubleArray(4); private var fn = 0
    private var n = 0L
    private var symRms = 0.5
    private val acqRe = FloatArray(4096); private val acqIm = FloatArray(4096); private var acqN = 0; private var lastAcq = 0L
    private val soft = ByteArray(FRAME_SYMBOLS * 2 * 3); private var nsym = 0L
    private var locked = false; private var frameStart = 0L; private var variant = 0; private var miss = 0
    private val viterbi = Viterbi(FRAME_SYMBOLS)
    private val frameSoft = ByteArray(FRAME_SYMBOLS * 2)
    private val cadu = ByteArray(CADU_BYTES)
    private var ber = 0.0; private var rs = 0; private var frames = 0; private var badFrames = 0
    private val mpdu = ByteArray(MPDU_MAX); private var mstate = 0; private var moff = 0; private var mfrag = 0
    private var lineBase = -1L; private var seqHi = 0L; private var lastSeq = -1
    private val coef = IntArray(64 * MCU_PER_MPDU); private val strip = ByteArray(64 * MCU_PER_MPDU)
    private val tmp64 = DoubleArray(64); private val row64 = DoubleArray(64); private val va = IntArray(2)
    private var lastStats = 0L
    private val ci = DoubleArray(2); private val mi = DoubleArray(2)

    fun reset() {
        hpos = 0; histI.fill(0f); histQ.fill(0f); agc = 1.0; theta = 0.0; omega = 0.0; nextSym = SPS; period = SPS; n = 0; nsym = 0
        locked = false; miss = 0; frames = 0; badFrames = 0; ber = 0.0; rs = 0; mstate = 0; lineBase = -1; seqHi = 0; lastSeq = -1; acqN = 0
    }

    fun stats() = LrptStats(locked, omega * IN_RATE / (2 * PI), ber, rs, frames, badFrames)

    /** Complex baseband at 240 kHz (interleaved I, Q), the LRPT carrier near DC. */
    override fun onIq240(buf: FloatArray, n: Int) {
        val h = rrc; val taps = h.size
        for (k in 0 until n) {
            val i0 = buf[2 * k] * agc; val q0 = buf[2 * k + 1] * agc
            val mag = sqrt(i0 * i0 + q0 * q0)
            agc += 0.002 * agc * (1 - mag)
            if (agc > 1e6) agc = 1e6
            histI[hpos] = i0.toFloat(); histQ[hpos] = q0.toFloat()
            var fi = 0.0; var fq = 0.0; var p = hpos
            for (t in 0 until taps) { fi += h[t] * histI[p]; fq += h[t] * histQ[p]; if (--p < 0) p = taps - 1 }
            if (++hpos >= taps) hpos = 0
            if (!locked && acqN < 4096) { acqRe[acqN] = fi.toFloat(); acqIm[acqN] = fq.toFloat(); acqN++ }
            val c = cos(theta); val s = sin(theta)
            val ri = fi * c + fq * s; val rq = fq * c - fi * s
            theta += omega; if (theta > PI) theta -= 2 * PI else if (theta < -PI) theta += 2 * PI
            val idx = fn and 3; fI[idx] = ri; fQ[idx] = rq; fn++
            while (nextSym <= this.n) {
                val frac = this.n - nextSym
                interp(frac, ci); interp(frac + period / 2, mi)
                val cI = ci[0]; val cQ = ci[1]
                val te = ((cI - prevSymI) * mi[0] + (cQ - prevSymQ) * mi[1]) / max(0.05, symRms * symRms)
                period -= 0.0004 * te; period = period.coerceIn(SPS * 0.995, SPS * 1.005)
                nextSym -= 0.04 * te
                prevSymI = cI; prevSymQ = cQ
                val pe = (if (cI >= 0) cQ else -cQ) - (if (cQ >= 0) cI else -cI)
                theta += 0.05 * pe; omega += 0.0008 * pe
                omega = omega.coerceIn(-0.8, 0.8)
                symRms += 0.001 * (sqrt(cI * cI + cQ * cQ) - symRms)
                symbol(cI, cQ)
                nextSym += period
            }
            this.n++
            if (!locked && acqN >= 4096 && this.n - lastAcq > IN_RATE / 4) { acquire(); lastAcq = this.n; acqN = 0 }
        }
        if (this.n - lastStats > IN_RATE) { lastStats = this.n; onStats(stats()) }
    }

    /** Linearly interpolate the filtered, derotated stream [back] samples before the newest one. */
    private fun interp(back: Double, out: DoubleArray) {
        val i = floor(back).toInt(); val f = back - i
        val a = (fn - 1 - i) and 3; val b = (fn - 2 - i) and 3
        out[0] = fI[a] * (1 - f) + fI[b] * f; out[1] = fQ[a] * (1 - f) + fQ[b] * f
    }

    /** Coarse carrier: the fourth power of QPSK collapses the modulation, leaving a line at 4 × the offset. */
    private fun acquire() {
        val nn = 4096
        val fr = FloatArray(nn); val fi = FloatArray(nn)
        for (k in 0 until nn) {
            val a = acqRe[k]; val b = acqIm[k]
            val r2 = a * a - b * b; val i2 = 2 * a * b
            fr[k] = r2 * r2 - i2 * i2; fi[k] = 2 * r2 * i2
        }
        fftInPlace(fr, fi, false)
        var best = 0; var bestP = -1f
        for (k in 0 until nn) { val p = fr[k] * fr[k] + fi[k] * fi[k]; if (p > bestP) { bestP = p; best = k } }
        val bin = if (best > nn / 2) best - nn else best
        val df = bin * IN_RATE / nn / 4
        if (abs(df) < 30_000) omega = 2 * PI * df / IN_RATE
    }

    private fun symbol(i: Double, q: Double) {
        val g = 100 / max(1e-3, symRms)
        val si = (i * g).roundToInt().coerceIn(-127, 127); val sq = (q * g).roundToInt().coerceIn(-127, 127)
        val len = soft.size; val at = ((nsym * 2) % len).toInt()
        soft[at] = si.toByte(); soft[at + 1] = sq.toByte()
        nsym++
        if (!locked) {
            if (nsym < 32) return
            val start = nsym - 32
            val (v, score) = syncScore(soft, ((start * 2) % len).toInt(), len)
            if (score >= 0.82) {
                locked = true; variant = v; frameStart = start; miss = 0
                onLog("LRPT sync · variant $v · offset %.0f Hz".format(omega * IN_RATE / (2 * PI)))
            }
            return
        }
        if (nsym >= frameStart + FRAME_SYMBOLS + 32) decodeFrame()
    }

    private fun decodeFrame() {
        val next = frameStart + FRAME_SYMBOLS
        val len = soft.size
        val (v, score) = syncScore(soft, ((next * 2) % len).toInt(), len)
        if (score >= 0.6) { variant = v; miss = 0 }
        else if (++miss > 3) { locked = false; onLog("LRPT lost"); return }
        for (k in 0 until FRAME_SYMBOLS) {
            val at = (((frameStart + k) * 2) % len).toInt()
            applyVariant(soft[at].toInt(), soft[at + 1].toInt(), variant, false, va)
            frameSoft[2 * k] = va[0].coerceIn(-127, 127).toByte(); frameSoft[2 * k + 1] = va[1].coerceIn(-127, 127).toByte()
        }
        frameStart = next
        ber = viterbi.decode(frameSoft, cadu)
        descramble(cadu)
        rs = rsFix(cadu)
        if (rs < 0) { badFrames++; mstate = 0; return }
        frames++
        vcdu(cadu)
    }

    private fun u8(b: ByteArray, i: Int) = b[i].toInt() and 0xff

    /** CCSDS transfer frame → M-PDUs (meteor_decode's mpdu_reconstruct state machine). */
    private fun vcdu(c: ByteArray) {
        val version = u8(c, 4) shr 6; val type = u8(c, 5) and 0x3f
        if (version == 0 || type == 0) return
        val hdrPtr = ((u8(c, 12) and 7) shl 8) or u8(c, 13)
        val hdrPresent = (u8(c, 12) shr 3) == 0 && hdrPtr != 0x7ff
        val dataOff = 14
        var guard = 0
        while (true) {
            if (++guard > 64) break
            val jmpIdle = hdrPresent && moff == 0
            if (mfrag >= MPDU_MAX) { mstate = 0; moff = 0; mfrag = 0; break }
            if (mstate == 0) {
                if (!hdrPresent) break
                moff = hdrPtr; if (moff > VCDU_DATA) break
                mfrag = 0; mstate = 1; continue
            }
            if (mstate == 1) {
                val left = MPDU_HDR - mfrag
                if (moff + left < VCDU_DATA) { System.arraycopy(c, dataOff + moff, mpdu, mfrag, left); mfrag = 0; moff += left; mstate = 2; continue }
                System.arraycopy(c, dataOff + moff, mpdu, mfrag, VCDU_DATA - moff); mfrag += VCDU_DATA - moff; moff = 0; break
            }
            val plen = ((u8(mpdu, 4) shl 8) or u8(mpdu, 5)) + 1
            if (plen > MPDU_MAX - MPDU_HDR) { mstate = 0; moff = 0; mfrag = 0; break }
            val left = plen - mfrag
            if (moff + left < VCDU_DATA) {
                System.arraycopy(c, dataOff + moff, mpdu, MPDU_HDR + mfrag, left); mfrag = 0; moff += left; mstate = if (jmpIdle) 0 else 1
                packet(plen)
                continue
            }
            System.arraycopy(c, dataOff + moff, mpdu, MPDU_HDR + mfrag, VCDU_DATA - moff); mfrag += VCDU_DATA - moff; moff = 0; mstate = if (jmpIdle) 0 else 2
            break
        }
    }

    private fun packet(plen: Int) {
        val m = mpdu
        val apid = ((u8(m, 0) and 7) shl 8) or u8(m, 1); val seq = ((u8(m, 2) and 0x3f) shl 8) or u8(m, 3)
        if (apid < 64 || apid > 69) return                       // 70 = telemetry
        val seg = MPDU_HDR + 8                                   // after the 8-byte time stamp
        val mcuSeq = u8(m, seg); val q = u8(m, seg + 5)
        if (q == 0) return
        val dataAt = seg + 6; val maxLen = plen - 8 - 6
        if (maxLen <= 0) return
        if (!huffmanDecode(coef, m, dataAt, MCU_PER_MPDU, maxLen)) return
        for (i in 0 until MCU_PER_MPDU) idctBlock(coef, i * 64, q, strip, i * 64, tmp64, row64)
        val line = lineOf(apid, seq, mcuSeq / MCU_PER_MPDU)
        if (line < 0) return
        val px = ByteArray(8 * MCU_PER_MPDU * 8)
        for (b in 0 until MCU_PER_MPDU) for (y in 0 until 8) for (x in 0 until 8) px[y * 112 + b * 8 + x] = strip[b * 64 + y * 8 + x]
        onStrip(apid, line, (mcuSeq - mcuSeq % MCU_PER_MPDU) * 8, px)
    }

    /**
     * Scan line of a packet from the shared sequence counter: a line period is 43 packets (14 per channel plus
     * telemetry), channels in ascending APID order, so the first packet fixes the period phase and every channel
     * lands on the same rows even when another channel's packets were lost.
     */
    private fun lineOf(apid: Int, seq: Int, k: Int): Int {
        if (lastSeq >= 0 && seq < lastSeq - 8192) seqHi += 16384
        else if (lastSeq >= 0 && seq > lastSeq + 8192) seqHi -= 16384
        lastSeq = seq
        val abs = seq + seqHi
        if (lineBase < 0) { val rank = if (apid == 64) 0 else if (apid == 65 || apid == 67) 1 else 2; lineBase = abs - k - MPDU_PER_LINE * rank }
        val d = abs - lineBase
        return if (d < 0) -1 else (d / MPDU_PER_PERIOD).toInt()
    }
}

