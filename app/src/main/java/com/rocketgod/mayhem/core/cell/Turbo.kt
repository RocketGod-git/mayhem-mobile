package com.rocketgod.mayhem.core.cell

/*
 * DL-SCH turbo coding, 36.212: 5.1.2 single code block (B <= 6144, F filler bits at the front), 5.1.3.2 PCCC with two
 * 8-state RSC encoders (g0 = 1 + D^2 + D^3, g1 = 1 + D + D^3), trellis termination, QPP interleaver (Table 5.1.3-3),
 * 5.1.4.1 rate matching (sub-block interleavers, circular buffer, N_cb = K_w, k0 by redundancy version).
 * Decoder: max-log-MAP with scaled extrinsic exchange, stopped early by the caller's CRC check.
 */
private val QPP_K = intArrayOf(40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128, 136, 144, 152, 160, 168, 176, 184, 192, 200, 208, 216, 224, 232, 240, 248, 256, 264, 272, 280, 288, 296, 304, 312, 320, 328, 336, 344, 352, 360, 368, 376, 384, 392, 400, 408, 416, 424, 432, 440, 448, 456, 464, 472, 480, 488, 496, 504, 512, 528, 544, 560, 576, 592, 608, 624, 640, 656, 672, 688, 704, 720, 736, 752, 768, 784, 800, 816, 832, 848, 864, 880, 896, 912, 928, 944, 960, 976, 992, 1008, 1024, 1056, 1088, 1120, 1152, 1184, 1216, 1248, 1280, 1312, 1344, 1376, 1408, 1440, 1472, 1504, 1536, 1568, 1600, 1632, 1664, 1696, 1728, 1760, 1792, 1824, 1856, 1888, 1920, 1952, 1984, 2016, 2048, 2112, 2176, 2240, 2304, 2368, 2432, 2496, 2560, 2624, 2688, 2752, 2816, 2880, 2944, 3008, 3072, 3136, 3200, 3264, 3328, 3392, 3456, 3520, 3584, 3648, 3712, 3776, 3840, 3904, 3968, 4032, 4096, 4160, 4224, 4288, 4352, 4416, 4480, 4544, 4608, 4672, 4736, 4800, 4864, 4928, 4992, 5056, 5120, 5184, 5248, 5312, 5376, 5440, 5504, 5568, 5632, 5696, 5760, 5824, 5888, 5952, 6016, 6080, 6144)
private val QPP_F1 = intArrayOf(3, 7, 19, 7, 7, 11, 5, 11, 7, 41, 103, 15, 9, 17, 9, 21, 101, 21, 57, 23, 13, 27, 11, 27, 85, 29, 33, 15, 17, 33, 103, 19, 19, 37, 19, 21, 21, 115, 193, 21, 133, 81, 45, 23, 243, 151, 155, 25, 51, 47, 91, 29, 29, 247, 29, 89, 91, 157, 55, 31, 17, 35, 227, 65, 19, 37, 41, 39, 185, 43, 21, 155, 79, 139, 23, 217, 25, 17, 127, 25, 239, 17, 137, 215, 29, 15, 147, 29, 59, 65, 55, 31, 17, 171, 67, 35, 19, 39, 19, 199, 21, 211, 21, 43, 149, 45, 49, 71, 13, 17, 25, 183, 55, 127, 27, 29, 29, 57, 45, 31, 59, 185, 113, 31, 17, 171, 209, 253, 367, 265, 181, 39, 27, 127, 143, 43, 29, 45, 157, 47, 13, 111, 443, 51, 51, 451, 257, 57, 313, 271, 179, 331, 363, 375, 127, 31, 33, 43, 33, 477, 35, 233, 357, 337, 37, 71, 71, 37, 39, 127, 39, 39, 31, 113, 41, 251, 43, 21, 43, 45, 45, 161, 89, 323, 47, 23, 47, 263)
private val QPP_F2 = intArrayOf(10, 12, 42, 16, 18, 20, 22, 24, 26, 84, 90, 32, 34, 108, 38, 120, 84, 44, 46, 48, 50, 52, 36, 56, 58, 60, 62, 32, 198, 68, 210, 36, 74, 76, 78, 120, 82, 84, 86, 44, 90, 46, 94, 48, 98, 40, 102, 52, 106, 72, 110, 168, 114, 58, 118, 180, 122, 62, 84, 64, 66, 68, 420, 96, 74, 76, 234, 80, 82, 252, 86, 44, 120, 92, 94, 48, 98, 80, 102, 52, 106, 48, 110, 112, 114, 58, 118, 60, 122, 124, 84, 64, 66, 204, 140, 72, 74, 76, 78, 240, 82, 252, 86, 88, 60, 92, 846, 48, 28, 80, 102, 104, 954, 96, 110, 112, 114, 116, 354, 120, 610, 124, 420, 64, 66, 136, 420, 216, 444, 456, 468, 80, 164, 504, 172, 88, 300, 92, 188, 96, 28, 240, 204, 104, 212, 192, 220, 336, 228, 232, 236, 120, 244, 248, 168, 64, 130, 264, 134, 408, 138, 280, 142, 480, 146, 444, 120, 152, 462, 234, 158, 80, 96, 902, 166, 336, 170, 86, 174, 176, 178, 120, 182, 184, 186, 94, 190, 480)
val PERM_TC = intArrayOf(0, 16, 8, 24, 4, 20, 12, 28, 2, 18, 10, 26, 6, 22, 14, 30, 1, 17, 9, 25, 5, 21, 13, 29, 3, 19, 11, 27, 7, 23, 15, 31)

private val qppCache = HashMap<Int, IntArray>()
@Synchronized
fun qpp(k: Int): IntArray = qppCache.getOrPut(k) {
    val j = QPP_K.indexOf(k)
    require(j >= 0) { "no QPP interleaver for K=$k" }
    IntArray(k) { i -> ((QPP_F1[j].toLong() * i + QPP_F2[j].toLong() * i * i) % k).toInt() }
}
/** K of a single code block: the smallest table size >= B. */
fun blockSize(b: Int): Int = QPP_K.firstOrNull { it >= b } ?: throw IllegalArgumentException("needs segmentation")

// state s = (s1 s2 s3), s1 the newest register bit; a = u ^ s2 ^ s3, parity = a ^ s1 ^ s3
private val NXT = IntArray(16); private val PAR = IntArray(16); private val TERM_U = IntArray(8)
private val TRELLIS_INIT = run {
    for (s in 0 until 8) {
        val s1 = (s shr 2) and 1; val s2 = (s shr 1) and 1; val s3 = s and 1
        for (u in 0 until 2) { val a = u xor s2 xor s3; PAR[s * 2 + u] = a xor s1 xor s3; NXT[s * 2 + u] = (a shl 2) or (s1 shl 1) or s2 }
        TERM_U[s] = s2 xor s3
    }
    true
}

private class Rsc(val z: ByteArray, val xt: IntArray, val zt: IntArray)
private fun rsc(c: ByteArray): Rsc {
    check(TRELLIS_INIT)
    var s = 0; val z = ByteArray(c.size); val xt = IntArray(3); val zt = IntArray(3)
    for (i in c.indices) { val u = c[i].toInt(); z[i] = PAR[s * 2 + u].toByte(); s = NXT[s * 2 + u] }
    for (i in 0 until 3) { val u = TERM_U[s]; xt[i] = u; zt[i] = PAR[s * 2 + u]; s = NXT[s * 2 + u] }
    return Rsc(z, xt, zt)
}
/** d(0), d(1), d(2), each K + 4 long, tails placed per 5.1.3.2.2. */
fun turboEncode(c: ByteArray): Array<ByteArray> {
    val k = c.size; val pi = qpp(k); val ci = ByteArray(k) { c[pi[it]] }
    val a = rsc(c); val b = rsc(ci); val d0 = ByteArray(k + 4); val d1 = ByteArray(k + 4); val d2 = ByteArray(k + 4)
    System.arraycopy(c, 0, d0, 0, k); System.arraycopy(a.z, 0, d1, 0, k); System.arraycopy(b.z, 0, d2, 0, k)
    intArrayOf(a.xt[0], a.zt[1], b.xt[0], b.zt[1]).forEachIndexed { i, v -> d0[k + i] = v.toByte() }
    intArrayOf(a.zt[0], a.xt[2], b.zt[0], b.xt[2]).forEachIndexed { i, v -> d1[k + i] = v.toByte() }
    intArrayOf(a.xt[1], a.zt[2], b.xt[1], b.zt[2]).forEachIndexed { i, v -> d2[k + i] = v.toByte() }
    return arrayOf(d0, d1, d2)
}

class RmBuffer(val w: IntArray, val R: Int)
private val bufCache = HashMap<Long, RmBuffer>()
/** Circular buffer w as stream * (K + 4) + index, -1 for <NULL> (the filler bits of d(0) and d(1) are <NULL>). */
@Synchronized
fun rmBuffer(k: Int, f: Int): RmBuffer {
    val key = k.toLong() * 100_000 + f
    bufCache[key]?.let { return it }
    val d = k + 4; val c = 32; val r = (d + c - 1) / c; val kp = r * c; val nd = kp - d
    fun y(i: Int, q: Int): Int { val kk = q - nd; return if (kk < 0 || (i < 2 && kk < f)) -1 else i * d + kk }
    val w = IntArray(3 * kp)
    var n = 0
    for (j in 0 until c) for (row in 0 until r) w[n++] = y(0, row * c + PERM_TC[j])
    for (kk in 0 until kp) {
        w[n++] = y(1, (kk % r) * c + PERM_TC[kk / r])
        w[n++] = y(2, (PERM_TC[kk / r] + c * (kk % r) + 1) % kp)
    }
    val b = RmBuffer(w, r)
    if (bufCache.size > 32) bufCache.clear()
    bufCache[key] = b
    return b
}
private val posCache = HashMap<String, IntArray>()
/** The coded-bit position carried by each of the E transmitted bits, redundancy version rv. */
@Synchronized
fun rmPositions(k: Int, f: Int, e: Int, rv: Int): IntArray {
    val key = "$k:$f:$e:$rv"
    posCache[key]?.let { return it }
    val b = rmBuffer(k, f); val ncb = b.w.size; val k0 = b.R * (2 * ((ncb + 8 * b.R - 1) / (8 * b.R)) * rv + 2); val out = IntArray(e)
    var n = 0; var j = 0
    while (n < e) { val q = b.w[(k0 + j) % ncb]; if (q >= 0) out[n++] = q; j++ }
    if (posCache.size > 64) posCache.clear()
    posCache[key] = out
    return out
}
fun rateMatch(d: Array<ByteArray>, f: Int, e: Int, rv: Int): ByteArray {
    val k = d[0].size - 4; val dd = k + 4; val pos = rmPositions(k, f, e, rv)
    return ByteArray(e) { d[pos[it] / dd][pos[it] % dd] }
}
/** Adds received soft bits into the 3 x (K + 4) accumulator; soft combining across RVs is addition. */
fun rateDematchAdd(llr: FloatArray, k: Int, f: Int, rv: Int, acc: Array<FloatArray>?): Array<FloatArray> {
    val d = k + 4; val a = acc ?: Array(3) { FloatArray(d) }; val pos = rmPositions(k, f, llr.size, rv)
    for (i in llr.indices) a[pos[i] / d][pos[i] % d] += llr[i]
    return a
}

private const val NEG = -1e9f
/** One constituent max-log-MAP decoder: a-posteriori LLRs of the K inputs (positive = 0). */
private fun bcjr(lu: FloatArray, lp: FloatArray, lut: FloatArray, lpt: FloatArray, alpha: FloatArray, out: FloatArray) {
    check(TRELLIS_INIT)
    val k = lu.size; val tt = k + 3
    alpha.fill(NEG, 0, 8); alpha[0] = 0f
    for (t in 0 until tt) {
        val u0 = if (t < k) lu[t] else lut[t - k]; val p0 = if (t < k) lp[t] else lpt[t - k]; val a = t * 8; val b = a + 8
        for (n in 0 until 8) alpha[b + n] = NEG
        for (s in 0 until 8) {
            val sa = alpha[a + s]
            if (sa <= NEG / 2) continue
            for (u in 0 until 2) {
                if (t >= k && u != TERM_U[s]) continue
                val v = sa + 0.5f * ((if (u != 0) -u0 else u0) + (if (PAR[s * 2 + u] != 0) -p0 else p0)); val n = NXT[s * 2 + u]
                if (v > alpha[b + n]) alpha[b + n] = v
            }
        }
        var mx = NEG
        for (n in 0 until 8) if (alpha[b + n] > mx) mx = alpha[b + n]
        for (n in 0 until 8) alpha[b + n] -= mx
    }
    var beta = FloatArray(8) { NEG }; var prev = FloatArray(8)
    beta[0] = 0f
    for (t in tt - 1 downTo 0) {
        val u0 = if (t < k) lu[t] else lut[t - k]; val p0 = if (t < k) lp[t] else lpt[t - k]; val a = t * 8
        var m0 = NEG; var m1 = NEG
        prev.fill(NEG)
        for (s in 0 until 8) for (u in 0 until 2) {
            if (t >= k && u != TERM_U[s]) continue
            val v = 0.5f * ((if (u != 0) -u0 else u0) + (if (PAR[s * 2 + u] != 0) -p0 else p0)) + beta[NXT[s * 2 + u]]
            if (v > prev[s]) prev[s] = v
            if (t < k) { val tot = alpha[a + s] + v; if (u != 0) { if (tot > m1) m1 = tot } else if (tot > m0) m0 = tot }
        }
        if (t < k) out[t] = m0 - m1
        var mx = NEG
        for (s in 0 until 8) if (prev[s] > mx) mx = prev[s]
        for (s in 0 until 8) prev[s] -= mx
        val tmp = beta; beta = prev; prev = tmp
    }
}

class TurboResult(val bits: ByteArray, val ok: Boolean, val iters: Int)
/** acc: combined soft bits [3][K + 4]. Hard bits of the K inputs and whether crc() accepted them. */
fun turboDecode(acc: Array<FloatArray>, k: Int, f: Int, crc: (ByteArray) -> Boolean, iters: Int = 8, scale: Float = 0.75f): TurboResult {
    val pi = qpp(k); val ls = acc[0].copyOfRange(0, k); val lp1 = acc[1].copyOfRange(0, k); val lp2 = acc[2].copyOfRange(0, k)
    for (i in 0 until f) ls[i] = 50f
    val xt1 = floatArrayOf(acc[0][k], acc[2][k], acc[1][k + 1]); val zt1 = floatArrayOf(acc[1][k], acc[0][k + 1], acc[2][k + 1])
    val xt2 = floatArrayOf(acc[0][k + 2], acc[2][k + 2], acc[1][k + 3]); val zt2 = floatArrayOf(acc[1][k + 2], acc[0][k + 3], acc[2][k + 3])
    val la = FloatArray(k); val in1 = FloatArray(k); val in2 = FloatArray(k); val l1 = FloatArray(k); val l2 = FloatArray(k)
    val lsp = FloatArray(k); val la2 = FloatArray(k); val alpha = FloatArray((k + 4) * 8); val bits = ByteArray(k)
    for (i in 0 until k) lsp[i] = ls[pi[i]]
    for (it in 1..iters) {
        for (i in 0 until k) in1[i] = ls[i] + la[i]
        bcjr(in1, lp1, xt1, zt1, alpha, l1)
        for (i in 0 until k) { val j = pi[i]; la2[i] = (l1[j] - ls[j] - la[j]) * scale; in2[i] = lsp[i] + la2[i] }
        bcjr(in2, lp2, xt2, zt2, alpha, l2)
        for (i in 0 until k) { val j = pi[i]; la[j] = (l2[i] - lsp[i] - la2[i]) * scale; bits[j] = if (l2[i] < 0) 1 else 0 }
        if (crc(bits)) return TurboResult(bits, true, it)
    }
    return TurboResult(bits, false, iters)
}
