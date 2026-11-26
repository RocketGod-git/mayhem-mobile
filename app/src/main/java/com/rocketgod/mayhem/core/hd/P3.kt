package com.rocketgod.mayhem.core.hd

import kotlin.math.abs
import kotlin.math.max

/**
 * The P3 and P4 logical channels of service modes MP2, MP3 and MP11 (SY_IDD_1011s): the PX1 and PX2 partitions on
 * the extended subcarriers, Interleaver IV (10.2.6, Tables 10-15, 10-16), the rate 1/2 code (9.3.4.3), the scrambler.
 */
object HdP3 {
    private const val C = 36; private const val B = 32; private const val BK_BITS = 32 * C; private const val BK_ADJ = 32 * C - 1
    /** Transfer frames per Interleaver IV cycle. */
    const val P3_CYCLE = 16

    class Cols(val sc: IntArray, val iq: IntArray)

    /** PX1 column to subcarrier and I (0) or Q (1) rail, for [ext] extended partitions per sideband (Tables 12-4, 12-5). */
    fun pxColumns(ext: Int): Cols {
        val J = 2 * ext; val sc = IntArray(J * C); val iq = IntArray(J * C)
        for (p in 0 until J) {
            val start = if (p < ext) -355 + 19 * p else 357 - 19 * (J - p)
            for (c in 0 until C) { sc[p * C + c] = start + (c shr 1); iq[p * C + c] = c and 1 }
        }
        return Cols(sc, iq)
    }

    /** PX2 (P4, mode MP11) column to subcarrier and rail (Table 12-6). */
    fun px2Columns(): Cols {
        val sc = IntArray(4 * C); val iq = IntArray(4 * C)
        for (p in 0 until 4) { val start = if (p < 2) -317 + 19 * p else 281 + 19 * (p - 2); for (c in 0 until C) { sc[p * C + c] = start + (c shr 1); iq[p * C + c] = c and 1 } }
        return Cols(sc, iq)
    }

    /** Interleaver IV write address of every input bit over one cycle (row * J * C + column of the internal matrix). */
    internal fun writeAddr(J: Int): IntArray {
        val M = if (J == 2) 4 else 2; val cols = J * C; val N = B * 32 * cols; val pt = IntArray(J); val w = IntArray(N)
        for (i in 0 until N) {
            val part = ((i + 2 * (M / 4)) / M) % J; val k = pt[part]++
            val block = (k + part * 7 - BK_ADJ * (k / BK_BITS)) % B
            val row = ((11 * k) % BK_BITS) / C; val col = (k * 11) % C
            w[i] = (block * 32 + row) * cols + part * C + col
        }
        return w
    }

    /** Rate 1/2 keeps g1 and g3 of the mother code, in serial order g1 g3. */
    fun depuncture12(soft: FloatArray, nIn: Int, out: FloatArray = FloatArray(nIn * 3)): FloatArray {
        for (i in 0 until nIn) { out[3 * i] = soft[2 * i]; out[3 * i + 1] = 0f; out[3 * i + 2] = soft[2 * i + 1] }
        return out
    }
    fun puncture12(code: ByteArray): ByteArray {
        val n = code.size / 3; val out = ByteArray(n * 2)
        for (i in 0 until n) { out[2 * i] = code[3 * i]; out[2 * i + 1] = code[3 * i + 2] }
        return out
    }

    /** Each column (one rail of one subcarrier) scaled by its own signal to noise: next to the analog FM some are far worse. */
    internal fun weigh(rows: FloatArray, cols: Int): FloatArray {
        val out = FloatArray(rows.size); val n = rows.size / cols
        for (c in 0 until cols) {
            var s = 0.0; var s2 = 0.0
            for (r in 0 until n) { val a = abs(rows[r * cols + c].toDouble()); s += a; s2 += a * a }
            val m = s / n; val v = max(s2 / n - m * m, 1e-12 + m * m * 1e-4); val g = m / v
            for (r in 0 until n) out[r * cols + c] = (rows[r * cols + c] * g).toFloat()
        }
        return out
    }
}

class P3Frame(val pdu: HdL2.Pdu, val ber: Double)

/**
 * Takes the PX1 soft matrix one block pair (64 rows) at a time and gives back P3 transfer frames. Interleaver IV is
 * convolutional, so a frame comes out up to a cycle (16 block pairs) after it went in. Where the cycle starts is not
 * signaled; each candidate phase is tried until one decodes cleanly.
 */
class P3Decoder(ext: Int) {
    private val C = 36; private val CYCLE = HdP3.P3_CYCLE
    val J = 2 * ext; val b = 64 * J * C; val N = b * CYCLE
    private val w = HdP3.writeAddr(J)
    /** Per input bit of the cycle: which output position (counted from the cycle's start, up to 2N) carries it. */
    private val tRel = IntArray(N)
    /** Per input frame of the cycle: the last output frame (from the cycle's start) it needs. */
    private val needs = IntArray(CYCLE)
    private val out = HashMap<Int, FloatArray>()
    private var last = -1; private var misses = 0
    var phase = -1
    private val tries = IntArray(CYCLE); private val good = IntArray(CYCLE)

    init {
        for (j in 0 until N) {
            val t = if (w[j] >= j) w[j] else N + w[j]
            tRel[j] = t
            val f = j / b; val of = t / b
            if (of > needs[f]) needs[f] = of
        }
    }

    /**
     * One block pair's 64 rows of PX1 soft values (row major, J * 36 columns), numbered by its place in time so a
     * missed L1 frame leaves a gap rather than shifting everything after it. Returns the frames now complete.
     */
    fun push(rows: FloatArray, k: Int): List<P3Frame> {
        if (k <= last) reset()
        last = k
        out[k] = HdP3.weigh(rows, J * C)
        out.keys.removeAll { it < k - 2 * CYCLE - 2 }
        val done = ArrayList<P3Frame>()
        if (phase < 0 && tries.all { it > 40 }) unlock()
        val phases = if (phase >= 0) intArrayOf(phase) else IntArray(CYCLE) { it }
        for (ph in phases) {
            // input frames whose last needed output frame is k, for a cycle starting at output frame s = ph mod 16
            for (f in 0 until CYCLE) {
                val s = k - needs[f]
                if (s < 0 || Math.floorMod(s - ph, CYCLE) != 0) continue
                if (if (phase >= 0) ph != phase else tries[ph] > 40) continue
                val r = decode(s, f) ?: continue
                if (phase >= 0) {
                    // a whole cycle that will not decode: the alignment is lost, search again
                    if (r.pdu.pciErrors > 4 && r.ber > 0.15) { if (++misses >= CYCLE) { unlock(); return done } } else misses = 0
                } else {
                    tries[ph]++
                    if (r.pdu.pciErrors <= 2 && r.ber < 0.1) good[ph]++
                    if (good[ph] >= 3) phase = ph
                    else continue
                }
                done.add(r)
            }
        }
        return done
    }

    private fun decode(s: Int, f: Int): P3Frame? {
        val soft = FloatArray(b); val base = f * b
        for (i in 0 until b) {
            val t = tRel[base + i]; val o = out[s + t / b] ?: return null
            soft[i] = o[t % b]
        }
        val nIn = b / 2; val v = TbViterbi(); v.start(HdP3.depuncture12(soft, nIn), nIn); v.run()
        val bits = v.bits.copyOf(); val p = HdP3.puncture12(HdFec.encode(bits))
        var e = 0; var m = 0
        for (i in p.indices) { val x = soft[i]; if (x == 0f) continue; m++; if ((if (x > 0) 1 else 0) != p[i].toInt()) e++ }
        return P3Frame(HdL2.pduFromFrame(HdFec.descramble(bits)), if (m > 0) e.toDouble() / m else 1.0)
    }

    private fun unlock() { phase = -1; misses = 0; tries.fill(0); good.fill(0) }
    fun reset() { out.clear(); last = -1; unlock() }
}
