package com.rocketgod.mayhem.core.fleet

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin

/**
 * TETRA downlink (ETSI EN 300 392-2), receive only: the cell's synchronization burst and what its BSCH says.
 *
 *  - pi/4-DQPSK at 18000 symbols a second (EN 300 392-2 5.5, Table 5.1: phase steps +pi/4 = 00, +3pi/4 = 01,
 *    -pi/4 = 10, -3pi/4 = 11), demodulated by the phase step across one symbol, timing picked again every 255 symbols.
 *  - The synchronization downlink burst (9.4.4.2.6, Table 9.9): the 38-bit synchronization training sequence
 *    (9.4.4.3.4) at bits 215 to 252, the 120 scrambled BSCH bits right before it (bits 95 to 214), the AACH after it.
 *  - BSCH coding (8.3.1.2): 60 type-1 bits, a (76,60) block code (8.2.3.3: CRC with G(X) = X^16 + X^12 + X^5 + 1,
 *    register preset to ones, complemented), 4 tail bits, the 16-state rate 1/4 mother code (8.2.3.1.1: G1 = 1 + D + D^4,
 *    G2 = 1 + D^2 + D^3 + D^4, G3 = 1 + D + D^2 + D^4, G4 = 1 + D + D^3 + D^4) punctured to rate 2/3 (P = 1, 2, 5 of
 *    every 8), a (120,11) block interleaver (8.2.4.1) and scrambling (8.2.5) with the color code taken as all zeros.
 *  - The MAC SYNC PDU (21.4.4.1, Table 21.76) and the D-MLE-SYNC it carries (18.4.2.1, Table 18.17): system code,
 *    color code, timeslot, frame and multiframe numbers, sharing mode, MCC, MNC, cell load.
 */
const val TETRA_BAUD = 18000
private const val TETRA_BLK = 255
/** Table 5.1: the phase step of each dibit. */
private val TETRA_STEP = doubleArrayOf(PI / 4, 3 * PI / 4, -PI / 4, -3 * PI / 4)
/** The synchronization training sequence y1 to y38 (9.4.4.3.4) as 19 dibits. */
val TETRA_SYNC_BITS = intArrayOf(1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1)
private val TETRA_SYNC_STEPS = DoubleArray(19) { TETRA_STEP[(TETRA_SYNC_BITS[2 * it] shl 1) or TETRA_SYNC_BITS[2 * it + 1]] }

/** The scrambling sequence (8.2.5.2) from the 30-bit extended color code (all zeros, null, for the BSCH). */
fun tetraScrambler(e: IntArray?, n: Int): IntArray {
    val c = intArrayOf(1, 2, 4, 5, 7, 8, 10, 11, 12, 16, 22, 23, 26, 32)
    val p = IntArray(n + 32)   // p[j] is p(k) for k = j - 31
    p[0] = 1; p[1] = 1         // p(-31) = p(-30) = 1
    for (k in -29..0) p[k + 31] = if (e != null) e[-k] and 1 else 0   // p(k) = e(1 - k)
    for (j in 32 until n + 32) { var v = 0; for (i in c) v = v xor p[j - i]; p[j] = v }
    return p.copyOfRange(32, n + 32)   // p(1) .. p(n)
}
/** The (K1 + 16, K1) block code check of 8.2.3.3: the 16 bits after the K1 information bits. */
fun tetraCrc16(bits: IntArray, k1: Int): Int {
    var r = 0xffff
    for (i in 0 until k1) { val fb = ((r shr 15) and 1) xor bits[i]; r = (r shl 1) and 0xffff; if (fb != 0) r = r xor 0x1021 }
    return r xor 0xffff
}
private val TETRA_G = intArrayOf(0b10011, 0b11101, 0b10111, 0b11011)   // taps of D^0..D^4 (bit j = D^j)
/** Viterbi decoding of the rate 1/4 mother code from soft type-3 values (+1 for 0, -1 for 1, 0 erased), [k2] bits. */
private fun tetraViterbi(m: FloatArray, k2: Int): IntArray {
    val ns = 16; val inf = 1e9
    var pm = DoubleArray(ns) { inf }; pm[0] = 0.0
    val prev = IntArray(k2 * ns); val bitOf = IntArray(k2 * ns)
    fun out4(state: Int, b: Int, i: Int): Int { val reg = (state shl 1) or b; var v = 0; for (j in 0 until 5) if (TETRA_G[i] and (1 shl j) != 0) v = v xor ((reg shr j) and 1); return v }
    for (k in 0 until k2) {
        val np = DoubleArray(ns) { inf }
        for (s in 0 until ns) {
            if (pm[s] >= inf) continue
            for (b in 0..1) {
                var cost = 0.0
                for (i in 0 until 4) { val want = if (out4(s, b, i) != 0) -1 else 1; cost -= want * m[4 * k + i] }
                val nx = ((s shl 1) or b) and 15; val c = pm[s] + cost
                if (c < np[nx]) { np[nx] = c; prev[k * ns + nx] = s; bitOf[k * ns + nx] = b }
            }
        }
        pm = np
    }
    var s = 0 // tail bits bring the coder back to zero
    val out = IntArray(k2)
    for (k in k2 - 1 downTo 0) { out[k] = bitOf[k * ns + s]; s = prev[k * ns + s] }
    return out
}
/** Type-5 BSCH bits (120) to the 60 type-1 bits, or null when the check fails. */
fun tetraBsch(sb: IntArray): IntArray? {
    val kk = 120; val p = tetraScrambler(null, kk)
    val b4 = IntArray(kk) { sb[it] xor p[it] }
    val b3 = IntArray(kk); for (i in 1..kk) b3[i - 1] = b4[(11 * i) % kk]
    // depuncture: type-3 bit j comes from mother output 8 ((j - 1) div 3) + P((j - 1) mod 3 + 1), P = 1, 2, 5
    val pp = intArrayOf(1, 2, 5); val m = FloatArray(4 * 80)
    for (j in 1..kk) { val k = 8 * ((j - 1) / 3) + pp[(j - 1) % 3]; m[k - 1] = if (b3[j - 1] != 0) -1f else 1f }
    val b2 = tetraViterbi(m, 80)
    var crc = 0; for (i in 60 until 76) crc = (crc shl 1) or b2[i]
    return if (tetraCrc16(b2, 60) == crc) b2.copyOfRange(0, 60) else null
}
data class TetraSync(
    val systemCode: Int, val colorCode: Int, val timeslot: Int, val frame: Int, val multiframe: Int, val sharing: Int,
    val mcc: Int, val mnc: Int, val neighborBroadcast: Int, val cellLoad: Int, val lateEntry: Boolean,
)
fun tetraSyncPdu(b: IntArray): TetraSync {
    var i = 0
    fun f(n: Int): Int { var v = 0; for (k in 0 until n) v = v * 2 + b[i++]; return v }
    val systemCode = f(4); val colorCode = f(6); val timeslot = f(2) + 1; val frame = f(5); val multiframe = f(6); val sharing = f(2)
    f(3); f(1); f(1); f(1)
    val mcc = f(10); val mnc = f(14); val nb = f(2); val cellLoad = f(2); val lateEntry = f(1) == 1
    return TetraSync(systemCode, colorCode, timeslot, frame, multiframe, sharing, mcc, mnc, nb, cellLoad, lateEntry)
}

/** The receiver: complex baseband in, BSCH contents out. */
class TetraRx(val fs: Double) {
    var onSync: (TetraSync) -> Unit = {}
    class Stats { var symbols = 0; var trainings = 0; var bschOk = 0; var bschBad = 0; override fun toString() = "symbols $symbols trainings $trainings bschOk $bschOk bschBad $bschBad" }
    val stats = Stats()
    private val tt = fs / TETRA_BAUD
    private var re = FloatArray(0); private var im = FloatArray(0); private var n = 0
    /** Phase steps kept for the burst before each training sequence. */
    private val ring = DoubleArray(512); private var rp = 0; private var last = -1_000_000_000
    fun push(zi: FloatArray, zq: FloatArray, m: Int) {
        if (n + m > re.size) { val sz = maxOf(2 * re.size, n + m + 1024); re = re.copyOf(sz); im = im.copyOf(sz) }
        for (k in 0 until m) { re[n] = zi[k]; im[n++] = zq[k] }
        val need = ceil((TETRA_BLK + 2) * tt).toInt() + 2
        while (n >= need) block()
    }
    private fun dphi(t: Double): Double {
        val i = floor(t).toInt(); val f = t - i; val j = floor(t - tt).toInt(); val g = t - tt - j
        val a = re[i] * (1 - f) + re[i + 1] * f; val b = im[i] * (1 - f) + im[i + 1] * f
        val c = re[j] * (1 - g) + re[j + 1] * g; val d = im[j] * (1 - g) + im[j + 1] * g
        return atan2(b * c - a * d, a * c + b * d)
    }
    private fun block() {
        val t0 = tt + 1
        var best = 0; var bm = -1e9
        // the timing whose phase steps sit closest to odd multiples of pi/4 (|mean of e^(4j step)|: a frequency offset does not move it)
        for (p in 0 until 8) {
            var x = 0.0; var y = 0.0; var k = 0
            while (k < TETRA_BLK) { val v = 4 * dphi(t0 + p * tt / 8 + k * tt); x += cos(v); y += sin(v); k += 3 }
            val s = x * x + y * y; if (s > bm) { bm = s; best = p }
        }
        var cr = 0.0; var ci = 0.0
        for (k in 0 until TETRA_BLK) { val v = dphi(t0 + best * tt / 8 + k * tt); cr += cos(4 * v); ci += sin(4 * v) }
        val off = atan2(ci, cr) - PI; val corr = atan2(sin(off), cos(off)) / 4
        for (k in 0 until TETRA_BLK) { var v = dphi(t0 + best * tt / 8 + k * tt) - corr; v = atan2(sin(v), cos(v)); symbol(v) }
        val used = floor(TETRA_BLK * tt).toInt()
        re.copyInto(re, 0, used, n); im.copyInto(im, 0, used, n); n -= used
    }
    private fun symbol(v: Double) {
        ring[rp] = v; rp = (rp + 1) and 511; stats.symbols++
        // the last 19 phase steps against the training sequence
        var c = 0.0; for (i in 0 until 19) c += cos(ring[(rp - 19 + i + 512) and 511] - TETRA_SYNC_STEPS[i])
        if (c < 0.8 * 19 || stats.symbols - last < 200) return
        last = stats.symbols; stats.trainings++
        // the 60 BSCH symbols right before the training sequence
        val sb = IntArray(120)
        for (i in 0 until 60) {
            val s = ring[(rp - 19 - 60 + i + 512) and 511]
            val d = if (s > PI / 2) 1 else if (s > 0) 0 else if (s > -PI / 2) 2 else 3
            sb[2 * i] = d shr 1; sb[2 * i + 1] = d and 1
        }
        val b = tetraBsch(sb)
        if (b == null) { stats.bschBad++; return }
        stats.bschOk++
        onSync(tetraSyncPdu(b))
    }
}
