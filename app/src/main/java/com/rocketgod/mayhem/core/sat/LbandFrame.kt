package com.rocketgod.mayhem.core.sat

import com.rocketgod.mayhem.core.ham.Viterbi
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The frame both Inmarsat receivers share: a block of 64 rows sent one after another, each row opening with unique
 * word symbols (one UW bit a row, sent once or twice, never scrambled) and then its share of the coded data. The
 * coded symbols fill the table column by column and the rows go out in the order (i × 73) mod 64. The data is
 * scrambled, then coded with the rate 1/2, K = 7 code (the Meteor decoder's Viterbi, ham/Lrpt.kt), its last byte
 * zeros to flush the coder. The scrambler is x^8 + x^6 + x^5 + x^4 + 1 (Galois, 0xB8) from 0x80, restarted every
 * frame: 0x80, not the 0x40 some write-ups give.
 *
 * Twin of web/src/dsp/lband/frame.ts.
 */
object LbandFrame {
    const val ROWS = 64
    const val SCRAMBLER_SEED = 0x80
    private const val G1 = 0x79
    private const val G2 = 0x5b
    private const val K = 7

    /** One kind of frame: its unique word, how many times each UW bit is sent, and the coded symbols a row. */
    class Layout(val uw: IntArray, val uwPerRow: Int, val cols: Int) {
        val symbols get() = ROWS * (uwPerRow + cols)
        /** Data bytes a frame carries, the flush byte included. */
        val bytes get() = ROWS * cols / 16
    }

    /** A 64-bit unique word from two 32-bit halves, first bit sent = most significant. */
    fun uwBits(hi: Long, lo: Long): IntArray = IntArray(64) { i -> if (i < 32) ((hi ushr (31 - i)) and 1).toInt() else ((lo ushr (63 - i)) and 1).toInt() }

    /** The row of the table sent in place i. */
    fun rowOrder(i: Int) = (i * 73) % ROWS

    /** The scrambler's bytes for one frame. */
    fun scramblerBytes(n: Int): IntArray {
        val out = IntArray(n)
        var s = SCRAMBLER_SEED
        for (i in 0 until n) {
            var b = 0
            for (j in 0 until 8) { val o = s and 1; b = (b shl 1) or o; s = s shr 1; if (o != 0) s = s xor 0xB8 }
            out[i] = b
        }
        return out
    }

    private fun parity(x0: Int): Int { var x = x0; x = x xor (x shr 4); x = x xor (x shr 2); x = x xor (x shr 1); return x and 1 }

    /** Transmitter side (tests, tools): data bytes (bytes - 1 of them) to the frame's symbols, ±1. */
    fun build(l: Layout, data: IntArray): IntArray {
        val nb = l.bytes; val sc = scramblerBytes(nb - 1); val bits = IntArray(8 * nb)
        for (i in 0 until nb - 1) { val v = data.getOrElse(i) { 0 } xor sc[i]; for (j in 0 until 8) bits[8 * i + j] = (v shr (7 - j)) and 1 }
        val coded = IntArray(2 * bits.size)
        var st = 0
        for (i in bits.indices) {
            st = ((st shr 1) or (bits[i] shl (K - 1))) and ((1 shl K) - 1)
            coded[2 * i] = parity(st and G1); coded[2 * i + 1] = parity(st and G2)
        }
        val rowLen = l.uwPerRow + l.cols; val out = IntArray(ROWS * rowLen)
        for (i in 0 until ROWS) {
            val r = rowOrder(i)
            for (j in 0 until l.uwPerRow) out[i * rowLen + j] = if (l.uw[i] != 0) 1 else -1
            for (c in 0 until l.cols) out[i * rowLen + l.uwPerRow + c] = if (coded[c * ROWS + r] != 0) 1 else -1
        }
        return out
    }

    /**
     * Finds frames in a stream of soft symbols by their unique word (either polarity) and decodes each: de-interleave,
     * Viterbi, descramble. [onFrame] gets the data bytes (without the flush byte), the UW match (0..1) and the share of
     * coded bits the Viterbi path disagreed with.
     */
    class Sync(private val l: Layout, private val onFrame: (IntArray, Double, Double) -> Unit, private val threshold: Double = 0.6) {
        var frames = 0; private set
        private val n = l.symbols
        private val rowLen = l.uwPerRow + l.cols
        private val ring: DoubleArray
        private val mask: Int
        private var k = 0L
        private var hold = 0L; private var pend = -1L; private var pendScore = 0.0; private var pendSign = 1
        private val bits = 32 * l.cols
        private val vit = Viterbi(bits)
        private val soft = ByteArray(2 * bits)
        private val out = ByteArray(bits / 8)
        private val sc = scramblerBytes(bits / 8 - 1)
        private val uwAt = IntArray(ROWS * l.uwPerRow) { q -> (q / l.uwPerRow) * rowLen + q % l.uwPerRow }

        init {
            var size = 1; while (size < 2 * n) size = size shl 1
            ring = DoubleArray(size); mask = size - 1
        }

        fun reset() { k = 0; hold = 0; pend = -1; ring.fill(0.0) }

        fun push(x: Double) {
            ring[(k and mask.toLong()).toInt()] = x
            k++
            if (k < n) return
            val s = k - n
            if (pend >= 0 && s - pend >= 4) { decode(pend, pendSign, pendScore); hold = pend + n - 8; pend = -1 }
            if (s < hold) return
            score(s)
            if (sc0 >= threshold && (pend < 0 || sc0 > pendScore)) { pend = s; pendScore = sc0; pendSign = sg0 }
        }

        private var sc0 = 0.0; private var sg0 = 1
        private fun score(s: Long) {
            var c = 0.0; var a = 0.0
            for (q in uwAt.indices) {
                val x = ring[((s + uwAt[q]) and mask.toLong()).toInt()]
                c += if (l.uw[q / l.uwPerRow] != 0) x else -x; a += abs(x)
            }
            val v = if (a > 0) c / a else 0.0
            sc0 = abs(v); sg0 = if (v < 0) -1 else 1
        }

        private fun decode(s: Long, sign: Int, score: Double) {
            // the scale for the Viterbi's int8 values: the mean size of a data symbol
            var a = 0.0
            for (i in 0 until n) a += abs(ring[((s + i) and mask.toLong()).toInt()])
            val g = 40 / (if (a > 0) a / n else 1.0)
            for (i in 0 until ROWS) {
                val row = rowOrder(i); val base = s + i * rowLen + l.uwPerRow
                for (c in 0 until l.cols) {
                    val v = (sign * ring[((base + c) and mask.toLong()).toInt()] * g).roundToInt().coerceIn(-127, 127)
                    soft[c * ROWS + row] = v.toByte()
                }
            }
            val ber = vit.decode(soft, out)
            val data = IntArray(out.size - 1) { (out[it].toInt() and 0xFF) xor sc[it] }
            frames++
            onFrame(data, score, ber)
        }
    }
}
