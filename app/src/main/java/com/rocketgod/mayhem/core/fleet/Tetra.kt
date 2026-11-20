package com.rocketgod.mayhem.core.fleet

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin

/**
 * TETRA downlink (ETSI EN 300 392-2), receive only: the physical layer and the channel coding of the logical channels.
 * The MAC and the layers above it are in TetraMac.kt, speech in TetraAcelp.kt.
 *
 *  - pi/4-DQPSK at 18000 symbols a second (5.5, Table 5.1: phase steps +pi/4 = 00, +3pi/4 = 01, -pi/4 = 10,
 *    -3pi/4 = 11), demodulated by the phase step across one symbol, timing picked again every 255 symbols. Each symbol
 *    gives two soft bits: the sine of its phase step for the first bit, the cosine for the second (positive is 0).
 *  - Slots of 255 symbols (9.4.4.2), four to a TDMA frame. The synchronization continuous downlink burst (Table 9.9)
 *    is found by its 38-bit training sequence (9.4.4.3.4) and gives the slot timing and, through the BSCH, the
 *    timeslot, frame and multiframe numbers; from then on every slot is read where it falls and recognized by its
 *    training sequence (normal training sequences 1 and 2 of 9.4.4.3.2, Table 9.13), the timing kept within two
 *    symbols of where each one is found.
 *  - Channel coding (clause 8): the (K1 + 16, K1) block code (8.2.3.3), tail bits and the 16-state rate 1/4 mother
 *    code (8.2.3.1.1: G1 = 1 + D + D^4, G2 = 1 + D^2 + D^3 + D^4, G3 = 1 + D + D^2 + D^4, G4 = 1 + D + D^3 + D^4)
 *    punctured to rate 2/3 (8.2.3.1.3: P = 1, 2, 5 of every 8), block interleaving (8.2.4.1) and scrambling (8.2.5)
 *    for the BSCH (K1 = 60, a = 11, all-zero color code), SCH/HD, BNCH and STCH (K1 = 124, a = 101) and SCH/F
 *    (K1 = 268, a = 103) (8.3.1.2, 8.3.1.4.1, 8.3.1.4.5); the shortened (30,14) Reed-Muller code of the AACH (8.2.3.2,
 *    8.3.1.1). Every channel but the BSCH is scrambled with the extended color code: MCC, MNC and color code
 *    (clause 23, figure 23.5).
 *  - The MAC SYNC PDU (21.4.4.2, Table 21.76) and the D-MLE-SYNC it carries (18.4.2.1, Table 18.17).
 */
const val TETRA_BAUD = 18000
private const val TETRA_BLK = 255
/** Table 5.1: the phase step of each dibit. */
private val TETRA_STEP = doubleArrayOf(PI / 4, 3 * PI / 4, -PI / 4, -3 * PI / 4)
/** The synchronization training sequence y1 to y38 (9.4.4.3.4). */
val TETRA_SYNC_BITS = intArrayOf(1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1)
/** Normal training sequences 1 (n1 to n22, equation 9.4) and 2 (p1 to p22, equation 9.5). */
val TETRA_NTS1 = intArrayOf(1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0)
val TETRA_NTS2 = intArrayOf(0, 1, 1, 1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0)
private fun tetraSteps(b: IntArray) = DoubleArray(b.size / 2) { TETRA_STEP[(b[2 * it] shl 1) or b[2 * it + 1]] }
private val SYNC_STEPS = tetraSteps(TETRA_SYNC_BITS)
private val N1_STEPS = tetraSteps(TETRA_NTS1)
private val N2_STEPS = tetraSteps(TETRA_NTS2)
/** Where the training sequences sit in a burst, in symbols from its first (Tables 9.7 and 9.9). */
private const val SYNC_AT = 107
private const val NTS_AT = 122

/** The 30-bit extended color code e(1) .. e(30): MCC (10 bits), MNC (14), color code (6), most significant first. */
fun tetraColorBits(mcc: Int, mnc: Int, cc: Int): IntArray {
    val e = IntArray(30)
    for (i in 0 until 10) e[i] = (mcc shr (9 - i)) and 1
    for (i in 0 until 14) e[10 + i] = (mnc shr (13 - i)) and 1
    for (i in 0 until 6) e[24 + i] = (cc shr (5 - i)) and 1
    return e
}
/** The scrambling sequence (8.2.5.2) from the 30-bit extended color code (all zeros, null, for the BSCH). */
fun tetraScrambler(e: IntArray?, n: Int): IntArray {
    val c = intArrayOf(1, 2, 4, 5, 7, 8, 10, 11, 12, 16, 22, 23, 26, 32)
    val p = IntArray(n + 32)   // p[j] is p(k) for k = j - 31
    p[0] = 1; p[1] = 1         // p(-31) = p(-30) = 1
    for (k in -29..0) p[k + 31] = if (e != null) e[-k] and 1 else 0   // p(k) = e(1 - k)
    for (j in 32 until n + 32) { var v = 0; for (i in c) v = v xor p[j - i]; p[j] = v }
    return p.copyOfRange(32, n + 32)   // p(1) .. p(n)
}
private val scrCache = java.util.concurrent.ConcurrentHashMap<String, IntArray>()
private fun scrambler(e: IntArray?, n: Int): IntArray {
    val k = "${e?.joinToString("") ?: "0"}:$n"
    return scrCache[k] ?: tetraScrambler(e, n).also { if (scrCache.size > 64) scrCache.clear(); scrCache[k] = it }
}
/** Soft bits descrambled with the extended color code [e] (a scrambling bit of 1 turns the sign). */
fun tetraDescramble(soft: FloatArray, e: IntArray?): FloatArray {
    val p = scrambler(e, soft.size)
    return FloatArray(soft.size) { if (p[it] != 0) -soft[it] else soft[it] }
}
/** The (K1 + 16, K1) block code check of 8.2.3.3: the 16 bits after the K1 information bits. */
fun tetraCrc16(bits: IntArray, k1: Int): Int {
    var r = 0xffff
    for (i in 0 until k1) { val fb = ((r shr 15) and 1) xor bits[i]; r = (r shl 1) and 0xffff; if (fb != 0) r = r xor 0x1021 }
    return r xor 0xffff
}
/** The generator polynomials of the rate 1/4 mother code (8.2.3.1.1), bit j the coefficient of D^j. */
val TETRA_G4 = intArrayOf(0b10011, 0b11101, 0b10111, 0b11011)
/**
 * Viterbi decoding of a 16-state mother code of rate 1/n ([gens], bit j the coefficient of D^j) from soft values
 * (+1 for 0, -1 for 1, 0 erased), [k2] bits, the coder ending in state zero (tail bits).
 */
fun tetraViterbi(m: FloatArray, k2: Int, gens: IntArray = TETRA_G4): IntArray {
    val ns = 16; val inf = 1e18; val n = gens.size
    val outs = IntArray(32 * n)
    for (reg in 0 until 32) for (i in 0 until n) {
        var v = 0; for (j in 0 until 5) if (gens[i] and (1 shl j) != 0) v = v xor ((reg shr j) and 1)
        outs[reg * n + i] = if (v != 0) -1 else 1
    }
    var pm = DoubleArray(ns) { inf }; pm[0] = 0.0
    var np = DoubleArray(ns)
    val prev = IntArray(k2 * ns); val bitOf = IntArray(k2 * ns)
    for (k in 0 until k2) {
        np.fill(inf)
        for (s in 0 until ns) {
            if (pm[s] >= inf) continue
            for (b in 0..1) {
                val reg = (s shl 1) or b
                var cost = 0.0; for (i in 0 until n) cost -= outs[reg * n + i] * m[n * k + i]
                val nx = reg and 15; val c = pm[s] + cost
                if (c < np[nx]) { np[nx] = c; prev[k * ns + nx] = s; bitOf[k * ns + nx] = b }
            }
        }
        val t = pm; pm = np; np = t
    }
    var s = 0
    val out = IntArray(k2)
    for (k in k2 - 1 downTo 0) { out[k] = bitOf[k * ns + s]; s = prev[k * ns + s] }
    return out
}
/** Block de-interleaving (8.2.4.1): b4(k) = b3(i) with k = 1 + (a i mod K), so b3(i) is read from there. */
fun tetraDeinterleave(b4: FloatArray, a: Int): FloatArray { val kk = b4.size; return FloatArray(kk) { b4[(a * (it + 1)) % kk] } }
/**
 * Type-5 soft bits of one block to its type-1 bits: descrambled with [e], de-interleaved, depunctured (rate 2/3 of
 * the mother code: type-3 bit j is mother bit 8 ((j - 1) div 3) + P((j - 1) mod 3 + 1), P = 1, 2, 5), Viterbi
 * decoded and checked by the block code. Null when the check fails.
 */
fun tetraDecode23(soft: FloatArray, k1: Int, a: Int, e: IntArray?): IntArray? {
    val kk = soft.size; val k2 = k1 + 20
    val b3 = tetraDeinterleave(tetraDescramble(soft, e), a)
    val pp = intArrayOf(1, 2, 5); val m = FloatArray(4 * k2)
    for (j in 1..kk) { val k = 8 * ((j - 1) / 3) + pp[(j - 1) % 3]; m[k - 1] = b3[j - 1] }
    val b2 = tetraViterbi(m, k2)
    var crc = 0; for (i in k1 until k1 + 16) crc = (crc shl 1) or b2[i]
    return if (tetraCrc16(b2, k1) == crc) b2.copyOfRange(0, k1) else null
}
/** Hard bits (0/1) to soft values (+1 for 0). */
fun tetraSoft(b: IntArray): FloatArray = FloatArray(b.size) { if (b[it] != 0) -1f else 1f }
/** Type-5 BSCH bits (120, hard) to the 60 type-1 bits, or null when the check fails. */
fun tetraBsch(sb: IntArray): IntArray? = tetraDecode23(tetraSoft(sb), 60, 11, null)
/** SCH/HD, BNCH or STCH: 216 type-5 soft bits to 124 type-1 bits. */
fun tetraSchHd(soft: FloatArray, e: IntArray): IntArray? = tetraDecode23(soft, 124, 101, e)
/** SCH/F: 432 type-5 soft bits to 268 type-1 bits. */
fun tetraSchF(soft: FloatArray, e: IntArray): IntArray? = tetraDecode23(soft, 268, 103, e)

/** The parity part of the (30,14) Reed-Muller generator matrix (8.2.3.2, equation 8.13): row i is info bit i. */
private val RM_P = intArrayOf(0b1001101101100000, 0b0010110111100000, 0b1111110000100000, 0b1110000000111100, 0b1001100000111010, 0b0101010000110110, 0b0010110000101110,
    0b1111111111011111, 0b1000001100111001, 0b0100001010110101, 0b0010000110101101, 0b0001001001110011, 0b0000100101101011, 0b0000010011100111)
/** Syndrome to error pattern (30 bits) for every pattern of up to three errors (the code's distance is 8). */
private val RM_FIX: IntArray by lazy {
    val t = IntArray(65536) { -1 }; t[0] = 0
    fun syn(err: Int): Int { var s = 0; for (i in 0 until 14) if ((err ushr (29 - i)) and 1 != 0) s = s xor RM_P[i]; return s xor (err and 0xffff) }
    for (a in 0 until 30) {
        val ea = 1 shl a; if (t[syn(ea)] < 0) t[syn(ea)] = ea
        for (b in a + 1 until 30) {
            val eb = ea or (1 shl b); if (t[syn(eb)] < 0) t[syn(eb)] = eb
            for (c in b + 1 until 30) { val ec = eb or (1 shl c); if (t[syn(ec)] < 0) t[syn(ec)] = ec }
        }
    }
    t
}
/** The AACH: 30 type-5 soft bits, descrambled, to the 14 bits of the ACCESS-ASSIGN PDU (null past three errors). */
fun tetraAach(soft: FloatArray, e: IntArray): Int? {
    val p = scrambler(e, 30)
    var w = 0; for (k in 0 until 30) w = (w shl 1) or ((if (soft[k] < 0) 1 else 0) xor p[k])
    var s = 0; for (i in 0 until 14) if ((w ushr (29 - i)) and 1 != 0) s = s xor RM_P[i]
    s = s xor (w and 0xffff)
    val fix = RM_FIX[s]; if (fix < 0) return null
    return ((w xor fix) ushr 16) and 0x3fff
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

/**
 * One downlink slot as received: which burst it is ("sync", or a normal burst with training sequence 1 "n1" or 2
 * "n2"), its timeslot (1 to 4), frame (1 to 18) and multiframe (1 to 60) numbers, and its 510 soft bits (bit k of the
 * burst at index k - 1). [sync] is the BSCH of a synchronization burst when it came through.
 */
class TetraBurst(val kind: String, val tn: Int, val fn: Int, val mn: Int, val soft: FloatArray, val score: Double, val sync: TetraSync?)

/** The receiver: complex baseband in, slots and the BSCH contents out. */
class TetraRx(val fs: Double) {
    var onSync: (TetraSync) -> Unit = {}
    /** Every slot whose training sequence was found, once the slot timing is known. */
    var onBurst: (TetraBurst) -> Unit = {}
    class Stats {
        var symbols = 0; var trainings = 0; var bschOk = 0; var bschBad = 0; var bursts = 0; var lost = 0
        override fun toString() = "symbols $symbols trainings $trainings bschOk $bschOk bschBad $bschBad bursts $bursts lost $lost"
    }
    val stats = Stats()
    private val tt = fs / TETRA_BAUD
    private var re = FloatArray(0); private var im = FloatArray(0); private var n = 0
    /** Phase steps of the last 4096 symbols, by symbol number. */
    private val ring = DoubleArray(4096); private var last = -1_000_000_000
    private class Lock(var start: Int, var tn: Int, var fn: Int, var mn: Int, var miss: Int)
    /** The slot timing: the symbol number the next slot starts at, its numbers, and the slots missed in a row. */
    private var lock: Lock? = null
    /** Whether the slot timing is known. */
    val locked: Boolean get() = lock != null
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
    private fun at(k: Int): Double = ring[k and 4095]
    /** How well the symbols from [k] on match [ref] (the mean cosine of the phase differences, 1 for a perfect match). */
    private fun match(k: Int, ref: DoubleArray): Double { var c = 0.0; for (i in ref.indices) c += cos(at(k + i) - ref[i]); return c / ref.size }
    private fun symbol(v: Double) {
        val k = stats.symbols++
        ring[k and 4095] = v
        val l = lock
        if (l != null) { if (k >= l.start + TETRA_BLK + 2) slot(); return }
        // no slot timing yet: the last 19 phase steps against the synchronization training sequence
        if (k < 19 + SYNC_AT || k - last < 200 || match(k - 18, SYNC_STEPS) < 0.8) return
        last = k; stats.trainings++
        val start = k - 18 - SYNC_AT
        // the slot timing is known from here: this burst is read again in full once its last symbols are in
        val s = bsch(start, true) ?: return
        lock = Lock(start, s.timeslot, s.frame, s.multiframe, 0)
    }
    private fun softOf(start: Int): FloatArray {
        val soft = FloatArray(2 * TETRA_BLK)
        for (j in 0 until TETRA_BLK) { val v = at(start + j); soft[2 * j] = sin(v).toFloat(); soft[2 * j + 1] = cos(v).toFloat() }
        return soft
    }
    /** The BSCH of a synchronization burst starting at symbol [start]: the 120 bits before its training sequence. */
    private fun bsch(start: Int, quiet: Boolean = false): TetraSync? {
        val soft = FloatArray(120)
        for (i in 0 until 60) { val v = at(start + 47 + i); soft[2 * i] = sin(v).toFloat(); soft[2 * i + 1] = cos(v).toFloat() }
        val b = tetraDecode23(soft, 60, 11, null)
        if (b == null) { if (!quiet) stats.bschBad++; return null }
        val s = tetraSyncPdu(b)
        if (!quiet) { stats.bschOk++; onSync(s) }
        return s
    }
    /** The slot due now: found within two symbols of where it should start, by its training sequence. */
    private fun slot() {
        val l = lock!!
        var best = -1.0; var kind = "n1"; var d0 = 0
        for (d in -2..2) {
            val s = l.start + d; val n1 = match(s + NTS_AT, N1_STEPS); val n2 = match(s + NTS_AT, N2_STEPS); val sy = match(s + SYNC_AT, SYNC_STEPS)
            // a small preference for the expected place, so a training sequence is not read one symbol off in noise
            val w = if (d == 0) 0.02 else 0.0
            if (n1 + w > best) { best = n1 + w; kind = "n1"; d0 = d }
            if (n2 + w > best) { best = n2 + w; kind = "n2"; d0 = d }
            if (sy + w > best) { best = sy + w; kind = "sync"; d0 = d }
        }
        var start = l.start
        if (best >= 0.7) {
            start += d0; l.miss = 0; stats.bursts++
            var sync: TetraSync? = null
            if (kind == "sync") {
                stats.trainings++; last = start + SYNC_AT + 18
                sync = bsch(start)
                if (sync != null) { l.tn = sync.timeslot; l.fn = sync.frame; l.mn = sync.multiframe }
            }
            onBurst(TetraBurst(kind, l.tn, l.fn, l.mn, softOf(start), best, sync))
        } else if (++l.miss > 12) { lock = null; stats.lost++; return }
        // on to the next slot
        l.start = start + TETRA_BLK
        if (++l.tn > 4) { l.tn = 1; if (++l.fn > 18) { l.fn = 1; if (++l.mn > 60) l.mn = 1 } }
    }
}
