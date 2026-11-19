package com.rocketgod.mayhem.core.js8

import kotlin.math.atanh
import kotlin.math.max
import kotlin.math.min
import kotlin.math.tanh

/**
 * JS8 frame coding: 72 payload bits + 3 transmission-flag bits + CRC-12 = 87 information bits, the (174,87) LDPC
 * code (87 parity bits sent first), 58 data tones of 3 bits each in natural binary order (MSB first), and three
 * 7-tone Costas blocks at symbols 0, 36 and 72. Twin of web/src/dsp/js8/codec.ts.
 *
 * The CRC is the augmented CRC-12 with polynomial 0xC06 over the 75 bits followed by 13 zero bits, then XORed with
 * 42. Checked against the three TX.FRAME tone vectors in the JS8Call API documentation.
 */
object Js8Codec {
    const val N = 174
    const val K = 87
    const val M = 87
    /** Transmission flags (bits 72-74): first and last frame of a transmission; 4 marks a dictionary data frame. */
    const val FLAG_FIRST = 1
    const val FLAG_LAST = 2
    const val FLAG_RESERVED = 4

    // ---- parity-check structure ----------------------------------------------------------------------------------
    private val NM_ROWS: List<IntArray> = List(M) { m -> (0 until 7).map { JS8_LDPC_NM[m * 7 + it] }.filter { it != 0 }.map { it - 1 }.toIntArray() }

    /** Parity bits from information bits: P = Hp^-1 Hu, built once by Gaussian elimination over GF(2). */
    private val PARITY_ROWS: Array<ByteArray> = run {
        val a = Array(M) { m -> ByteArray(N).also { row -> for (n in NM_ROWS[m]) row[n] = (row[n].toInt() xor 1).toByte() } }
        for (c in 0 until K) {
            var p = c; while (p < M && a[p][c].toInt() == 0) p++
            check(p != M) { "JS8 LDPC: parity block is singular" }
            if (p != c) { val t = a[p]; a[p] = a[c]; a[c] = t }
            for (r in 0 until M) if (r != c && a[r][c].toInt() != 0) { val rr = a[r]; val rc = a[c]; for (j in c until N) rr[j] = (rr[j].toInt() xor rc[j].toInt()).toByte() }
        }
        Array(M) { a[it].copyOfRange(K, N) }
    }

    /** 87 information bits → 174-bit codeword (parity first). */
    fun ldpcEncode(info: ByteArray): ByteArray {
        val cw = ByteArray(N)
        for (i in 0 until K) cw[K + i] = info[i]
        for (r in 0 until M) { val row = PARITY_ROWS[r]; var s = 0; for (i in 0 until K) s = s xor (row[i].toInt() and info[i].toInt()); cw[r] = s.toByte() }
        return cw
    }

    /** Failed parity checks of a hard codeword. */
    fun syndrome(cw: ByteArray, off: Int = 0): Int {
        var e = 0
        for (r in NM_ROWS) { var x = 0; for (n in r) x = x xor cw[off + n].toInt(); e += x }
        return e
    }

    // flat edge tables for the decoder
    private val ROW_START = IntArray(M + 1)
    private val EDGE_VAR: IntArray
    private val COL_START = IntArray(N + 1)
    private val COL_EDGE: IntArray
    init {
        val rv = ArrayList<Int>()
        for (m in 0 until M) { ROW_START[m] = rv.size; for (n in NM_ROWS[m]) rv.add(n) }
        ROW_START[M] = rv.size
        EDGE_VAR = rv.toIntArray()
        COL_EDGE = IntArray(EDGE_VAR.size)
        var k = 0
        for (n in 0 until N) { COL_START[n] = k; for (e in EDGE_VAR.indices) if (EDGE_VAR[e] == n) COL_EDGE[k++] = e }
        COL_START[N] = k
    }
    private val NE = EDGE_VAR.size

    /** Gives up when the failed-check count has not fallen for this many iterations. */
    @JvmField var patience = 8

    /**
     * Sum-product belief propagation. [llr] > 0 means a 1. Returns the codeword with 0 failed checks, or null. Gives
     * up early when the failed-check count stops falling. Thread-safe: its working arrays are per call.
     */
    fun ldpcDecode(llr: FloatArray, maxIters: Int = 30): ByteArray? {
        val c2v = FloatArray(NE); val v2c = FloatArray(NE); val th = FloatArray(NE)
        val hard = ByteArray(N)
        for (n in 0 until N) for (k in COL_START[n] until COL_START[n + 1]) v2c[COL_EDGE[k]] = llr[n]
        var best = M; var since = 0
        for (it in 0 until maxIters) {
            for (e in 0 until NE) th[e] = tanh(-v2c[e] / 2.0).toFloat()
            for (m in 0 until M) {
                val a = ROW_START[m]; val b = ROW_START[m + 1]
                for (i in a until b) {
                    var p = 1.0
                    for (j in a until b) if (j != i) p *= th[j]
                    c2v[i] = (-2 * atanh(max(-0.999999, min(0.999999, p)))).toFloat()
                }
            }
            for (n in 0 until N) {
                var s = llr[n].toDouble(); val a = COL_START[n]; val b = COL_START[n + 1]
                for (k in a until b) s += c2v[COL_EDGE[k]]
                hard[n] = if (s > 0) 1 else 0
                for (k in a until b) { val e = COL_EDGE[k]; v2c[e] = (s - c2v[e]).toFloat() }
            }
            val err = syndrome(hard)
            if (err == 0) return hard
            if (err < best) { best = err; since = 0 } else if (++since >= patience) break
        }
        return null
    }

    // ---- CRC-12 ---------------------------------------------------------------------------------------------------
    fun crc12(bits: ByteArray, count: Int, off: Int = 0): Int {
        var r = 0
        fun step(x: Int) { val top = (r shr 11) and 1; r = ((r shl 1) or x) and 0xFFF; if (top != 0) r = r xor 0xC06 }
        for (i in 0 until count) step(bits[off + i].toInt() and 1)
        repeat(13) { step(0) }
        return r xor 42
    }

    fun payloadToText(p: ByteArray): String {
        val sb = StringBuilder()
        for (i in 0 until 12) { var v = 0; for (b in 0 until 6) v = (v shl 1) or p[i * 6 + b].toInt(); sb.append(JS8_ALPHABET72[v]) }
        return sb.toString()
    }
    fun textToPayload(t: String): ByteArray? {
        if (t.length != 12) return null
        val p = ByteArray(72)
        for (i in 0 until 12) { val v = JS8_ALPHABET72.indexOf(t[i]); if (v < 0) return null; for (b in 0 until 6) p[i * 6 + b] = ((v shr (5 - b)) and 1).toByte() }
        return p
    }

    /** 72 payload bits + flags → 87 information bits with the CRC. */
    fun infoBits(f: Frame): ByteArray {
        val info = ByteArray(K)
        System.arraycopy(f.payload, 0, info, 0, 72)
        for (b in 0 until 3) info[72 + b] = ((f.flags shr (2 - b)) and 1).toByte()
        val c = crc12(info, 75)
        for (b in 0 until 12) info[75 + b] = ((c shr (11 - b)) and 1).toByte()
        return info
    }
    /** 87 information bits (from [off]) → frame, or null when the CRC fails. */
    fun checkInfo(info: ByteArray, off: Int = 0): Frame? {
        var c = 0; for (b in 0 until 12) c = (c shl 1) or info[off + 75 + b].toInt()
        if (crc12(info, 75, off) != c) return null
        return Frame(info.copyOfRange(off, off + 72), (info[off + 72].toInt() shl 2) or (info[off + 73].toInt() shl 1) or info[off + 74].toInt())
    }

    /** Data-tone position of the k-th of the 58 data symbols. */
    fun dataSym(k: Int): Int = if (k < 29) 7 + k else 14 + k

    /** A frame → 79 tones with the mode's Costas blocks. */
    fun frameTones(f: Frame, costas: Array<IntArray>): IntArray {
        val cw = ldpcEncode(infoBits(f))
        val t = IntArray(79)
        for (b in 0 until 3) for (k in 0 until 7) t[36 * b + k] = costas[b][k]
        for (k in 0 until 58) t[dataSym(k)] = (cw[3 * k].toInt() shl 2) or (cw[3 * k + 1].toInt() shl 1) or cw[3 * k + 2].toInt()
        return t
    }
    /** 79 hard tones → frame (LDPC hard check, no correction), for known tone vectors. */
    fun tonesFrame(t: IntArray): Frame? {
        val cw = ByteArray(N)
        for (k in 0 until 58) { val v = t[dataSym(k)]; cw[3 * k] = ((v shr 2) and 1).toByte(); cw[3 * k + 1] = ((v shr 1) and 1).toByte(); cw[3 * k + 2] = (v and 1).toByte() }
        if (syndrome(cw) != 0) return null
        return checkInfo(cw, K)
    }
}

/** A frame's 12-character field (72 bits) plus its 3 flag bits. */
class Frame(val payload: ByteArray, var flags: Int)
