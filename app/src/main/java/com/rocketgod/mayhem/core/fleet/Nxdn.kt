package com.rocketgod.mayhem.core.fleet

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * NXDN trunked control channel (NXDN TS 1-A, Common Air Interface v1.3), outbound, receive only.
 *
 *  - 4-level FSK, dibit 01 = +3, 00 = +1, 10 = -1, 11 = -3 (4.5.3, Figure 4.5-7); NXDN48 at 2400 and NXDN96 at 4800
 *    symbols a second, the frame 384 bits either way (4.4).
 *  - The outbound RCCH frame (4.4.1, Figure 4.4-1): FSW 20 bits, LICH 16, CAC 300, E 24, Post 24. The frame sync word
 *    is CDF59: -3 +1 -3 +3 -3 -3 +3 +3 -1 +3 (4.4.4, Table 4.4-2).
 *  - Scrambling (4.6): every symbol but the FSW, guard, preamble and post field has its sign inverted where the
 *    9-bit generator X^9 + X^4 + 1 puts out a 1; register S8..S0 = 0 1 1 1 0 0 1 0 0 at the start of each frame,
 *    output S0, S0 fed back to S8 and added into S3 (Figure 4.6-1).
 *  - LICH (4.5.3, 5.2): 7 bits and an even parity bit over the 4 most significant, one bit a symbol (0 = +3, 1 = -3);
 *    RF channel type 00 RCCH, functional channel 00 CAC, direction 1 outbound.
 *  - CAC (4.5.1.1, 4.5.4): SR 8 bits, layer 3 144 bits, 3 null bits, a 16-bit CRC (X^16 + X^12 + X^5 + 1, register
 *    preset to ones, 4.5.5), 4 tail bits; the K = 5 rate 1/2 code G1 = 1 + D^3 + D^4, G2 = 1 + D + D^2 + D^4, punctured by
 *    1111111 / 1011101 to 300 bits; a 25 by 12 interleaver written by rows and read by columns.
 *  - SITE_INFO (6.4.3.1, Figure 6.4-53, message type 01 1000): the Location ID (6.5.2: category, system code, site
 *    code) in octets 1 to 3, the version number in octet 14, then the adjacent site allocation (4 bits) and the first
 *    and second control channels (10 bits each).
 */
private val NXDN_FSW = intArrayOf(-3, 1, -3, 3, -3, -3, 3, 3, -1, 3)
/** The scrambler's output for the symbols after the FSW of a frame (4.6). */
fun nxdnScrambler(n: Int): IntArray {
    var s = intArrayOf(0, 1, 1, 1, 0, 0, 1, 0, 0).reversedArray()   // s[i] = Si
    val out = IntArray(n)
    for (k in 0 until n) {
        val o = s[0]; out[k] = o
        val next = IntArray(9); for (i in 0 until 8) next[i] = s[i + 1]; next[8] = o; next[3] = s[4] xor o
        s = next
    }
    return out
}
/** The 16-bit CRC of 4.5.5 over the first [n] bits (register preset to ones). */
fun nxdnCrc16(bits: IntArray, n: Int): Int {
    var r = 0xffff
    for (i in 0 until n) { val fb = ((r shr 15) and 1) xor bits[i]; r = (r shl 1) and 0xffff; if (fb != 0) r = r xor 0x1021 }
    return r
}
private const val NXDN_G1 = 0b11001; private const val NXDN_G2 = 0b10111   // bit j = D^j
/** CAC: 300 received bits (after descrambling) to the 152 bits of SR and layer 3, or null when the CRC fails. */
fun nxdnCac(rx: IntArray): IntArray? {
    // de-interleave: transmitted in column order of a 25 x 12 array written by rows
    val y = IntArray(300)
    for (c in 0 until 12) for (r in 0 until 25) y[r * 12 + c] = rx[c * 25 + r]
    // de-puncture: of every 14 code bits X, X4 and X12 were not sent (positions 3 and 11 counting from 0)
    val m = FloatArray(350); var j = 0
    for (i in 0 until 350) { val p = i % 14; if (p == 3 || p == 11) { m[i] = 0f; continue }; m[i] = if (y[j++] != 0) -1f else 1f }
    // Viterbi, 16 states, 175 bits ending in the zero state
    val ns = 16; val inf = 1e9; var pm = DoubleArray(ns) { inf }; pm[0] = 0.0
    val prev = IntArray(175 * ns); val bit = IntArray(175 * ns)
    fun enc(st: Int, b: Int, g: Int): Int { val reg = (st shl 1) or b; var v = 0; for (k in 0 until 5) if (g and (1 shl k) != 0) v = v xor ((reg shr k) and 1); return v }
    for (k in 0 until 175) {
        val np = DoubleArray(ns) { inf }
        for (st in 0 until ns) {
            if (pm[st] >= inf) continue
            for (b in 0..1) {
                val c = pm[st] - (if (enc(st, b, NXDN_G1) != 0) -1 else 1) * m[2 * k] - (if (enc(st, b, NXDN_G2) != 0) -1 else 1) * m[2 * k + 1]
                val nx = ((st shl 1) or b) and 15
                if (c < np[nx]) { np[nx] = c; prev[k * ns + nx] = st; bit[k * ns + nx] = b }
            }
        }
        pm = np
    }
    val d = IntArray(175); var st = 0
    for (k in 174 downTo 0) { d[k] = bit[k * ns + st]; st = prev[k * ns + st] }
    var crc = 0; for (i in 155 until 171) crc = (crc shl 1) or d[i]
    return if (nxdnCrc16(d, 155) == crc) d.copyOfRange(0, 152) else null
}
data class NxdnSite(val category: Int, val system: Int, val site: Int, val cc1: Int, val cc2: Int, val version: Int, val adjacent: Int, val locationId: Int)
/** SITE_INFO (6.4.3.1) from the layer 3 bits (after SR): Location ID (6.5.2) and the control channels. */
fun nxdnSiteInfo(l3: IntArray): NxdnSite? {
    if (l3.size < 144) return null
    var i = 0
    fun f(n: Int): Int { var v = 0; for (k in 0 until n) v = v * 2 + l3[i++]; return v }
    f(2); if (f(6) != 0x18) return null
    val loc = f(24); val category = loc shr 22
    val sysBits = when (category) { 0 -> 10; 2 -> 14; 1 -> 17; else -> 0 }
    if (sysBits == 0) return null
    val siteBits = 22 - sysBits; val system = (loc shr siteBits) and ((1 shl sysBits) - 1); val site = loc and ((1 shl siteBits) - 1)
    i = 8 * 14; val version = f(8); val adjacent = f(4); val cc1 = f(10); val cc2 = f(10)
    return NxdnSite(category, system, site, cc1, cc2, version, adjacent, loc)
}
val NXDN_CATEGORY = listOf("GLOBAL", "LOCAL", "REGIONAL", "RESERVED")

/** One baud rate's receiver: symbols in (from [SymbolRx]), frames found by their FSW, CAC read. */
class NxdnFramer {
    var onSite: (NxdnSite) -> Unit = {}
    var onFrame: (lich: Int, ok: Boolean) -> Unit = { _, _ -> }
    class Stats { var fsw = 0; var lichOk = 0; var cacOk = 0; var cacBad = 0; override fun toString() = "fsw $fsw lichOk $lichOk cacOk $cacOk cacBad $cacBad" }
    val stats = Stats()
    /** The last frame's worth of symbols, and the frames waiting for their body (every FSW match gets its own look). */
    private val hist = FloatArray(256); private var hp = 0
    private val pending = ArrayDeque<Int>()
    fun push(s: Float) {
        hist[hp and 255] = s; hp++
        if (hp >= 10) {
            var c = 0.0; var a = 0.0
            for (k in 0 until 10) { val x = hist[(hp - 10 + k) and 255]; c += x * NXDN_FSW[k]; a += abs(x) }
            if (a > 15 && c / (3 * a) > 0.85) { stats.fsw++; pending.addLast(hp + 158) }
        }
        while (pending.isNotEmpty() && pending.first() <= hp) {
            val end = pending.removeFirst()
            val sym = FloatArray(158) { hist[(end - 158 + it) and 255] }
            frame(sym)
        }
    }
    private fun frame(sym: FloatArray) {
        val scr = nxdnScrambler(sym.size)
        val v = FloatArray(sym.size) { if (scr[it] != 0) -sym[it] else sym[it] }
        // LICH: one bit a symbol
        var lich = 0; for (k in 0 until 8) lich = (lich shl 1) or (if (v[k] < 0) 1 else 0)
        val par = ((lich shr 7) xor (lich shr 6) xor (lich shr 5) xor (lich shr 4)) and 1
        if (par != (lich and 1)) { onFrame(lich shr 1, false); return }
        stats.lichOk++
        val info = lich shr 1; val rf = info shr 5; val fn = (info shr 3) and 3; val dir = info and 1
        onFrame(info, true)
        if (rf != 0 || fn != 0 || dir != 1) return
        val bits = IntArray(300)
        for (k in 0 until 150) { val x = v[8 + k]; val d = if (x > 2) 1 else if (x > 0) 0 else if (x > -2) 2 else 3; bits[2 * k] = d shr 1; bits[2 * k + 1] = d and 1 }
        val cac = nxdnCac(bits)
        if (cac == null) { stats.cacBad++; return }
        stats.cacOk++
        nxdnSiteInfo(cac.copyOfRange(8, cac.size))?.let { onSite(it) }
    }
}
/**
 * A receiver at one baud rate on complex baseband: a low-pass a little wider than the signal (outer deviation plus
 * half the symbol rate, with room for a frequency offset), then the symbol recovery and the framer.
 */
class NxdnRx(val fs: Double, val baud: Int) {
    val framer = NxdnFramer()
    val rx = SymbolRx(fs, baud.toDouble(), 0.5)
    private val h: FloatArray; private val bi: FloatArray; private val bq: FloatArray; private var p = 0
    private var oi = FloatArray(0); private var oq = FloatArray(0)
    /** The first tenth of a second is held to measure the carrier offset (the scrambled levels average out). */
    private var holdI: FloatArray? = FloatArray(1024); private var holdQ = FloatArray(1024); private var holdN = 0
    init {
        rx.onSymbol = { s -> framer.push(s) }
        val fc = (if (baud == 2400) 1050 else 2400) + baud / 2.0 + 800; val n = 2 * (2 * fs / baud).roundToInt() + 1; val m = (n - 1) / 2
        h = FloatArray(n); var sum = 0.0
        for (i in 0 until n) {
            val t = (i - m).toDouble(); val x = 2 * fc / fs; val sinc = if (t == 0.0) x else sin(PI * x * t) / (PI * t)
            h[i] = (sinc * (0.54 - 0.46 * cos(2 * PI * i / (n - 1)))).toFloat(); sum += h[i]
        }
        for (i in 0 until n) h[i] = (h[i] / sum).toFloat()
        bi = FloatArray(2 * n); bq = FloatArray(2 * n)
    }
    fun push(zi: FloatArray, zq: FloatArray, m: Int) {
        if (oi.size < m) { oi = FloatArray(m); oq = FloatArray(m) }
        val n = h.size
        for (k in 0 until m) {
            bi[p] = zi[k]; bi[p + n] = zi[k]; bq[p] = zq[k]; bq[p + n] = zq[k]
            if (++p >= n) p = 0
            var x = 0.0; var y = 0.0; for (j in 0 until n) { x += h[j].toDouble() * bi[p + j]; y += h[j].toDouble() * bq[p + j] }
            oi[k] = x.toFloat(); oq[k] = y.toFloat()
        }
        val hi = holdI
        if (hi == null) { rx.push(oi, oq, m); return }
        var hiArr: FloatArray = hi
        if (holdN + m > hiArr.size) { val sz = maxOf(2 * hiArr.size, holdN + m); hiArr = hiArr.copyOf(sz); holdQ = holdQ.copyOf(sz); holdI = hiArr }
        for (k in 0 until m) { hiArr[holdN] = oi[k]; holdQ[holdN++] = oq[k] }
        if (holdN < fs / 10) return
        var re = 0.0; var im = 0.0
        for (k in 1 until holdN) { re += hiArr[k].toDouble() * hiArr[k - 1] + holdQ[k].toDouble() * holdQ[k - 1]; im += holdQ[k].toDouble() * hiArr[k - 1] - hiArr[k].toDouble() * holdQ[k - 1] }
        rx.setOffset(atan2(im, re) * fs / (2 * PI))
        holdI = null
        rx.push(hiArr, holdQ, holdN)
        holdQ = FloatArray(0)
    }
}
