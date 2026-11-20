package com.rocketgod.mayhem.core.pager

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.max

/**
 * ReFLEX outbound (two-way paging, base to pager), the FLEX-family frame as it is on the air at 940.8625 MHz in the
 * 2026-11-20 roof recording; the twin of the web app's reflex.ts. Our own code, from public facts about the FLEX
 * family (frames of 1.875 s, 128 frames a cycle, a frame information word coded BCH(31,21) plus parity, 8-word
 * blocks interleaved bit by bit) and from what the recording shows:
 *
 * - Sync 1 is sent 2-level at 1600 bps: 12.5 ms full-deviation tones, dotting, then an 80-bit sync word
 *   (0x163B5939, 0x0000, 0xE9C4A6C6, bits as sent with the higher tone a 1). FLEX's own sync carries 0xAAAA in the
 *   middle and other A codes, so a FLEX decoder never locks on it.
 * - The frame information word follows: BCH good on every frame heard, with FLEX's nibble checksum, and its cycle and
 *   frame numbers count one frame every 1.875 s.
 * - The data runs 4-level at 3200 baud (6400 bps), outer about the sync's deviation (2.4 kHz) and inner a third of it
 *   (0.8 kHz), the levels public descriptions give ReFLEX. After 80 symbols (25 ms, as FLEX's sync 2) come blocks of
 *   512 symbols; as in FLEX at this speed, the even symbols feed phases A and B, the odd ones C and D, 8 words each,
 *   bit-interleaved. The low bit of each symbol (levels numbered 0 to 3 from the lower tone), phases B and D, passes
 *   BCH(32,21) on about 97% of words. The high bit (phases A and C) does not follow that code at any alignment or
 *   mapping tried, so it is counted and not decoded.
 *
 * Each frame goes to the sink as a FRAME page with no capcode: its cycle and frame, how many blocks it ran and the
 * checked words of its first block (phase B then phase D) in hex. No address or text is read from it: the words that
 * check do not carry FLEX's block information word, address and vector structure at any alignment.
 */
class ReflexDecoder(private val sink: PagerSink, fs: Double) {
    /** [words]: the first block's phase B then phase D words; [okB] of [total]: coded words (B and D) that checked;
     *  [okA]: phase A and C words that did. */
    data class Frame(val cycle: Int, val frame: Int, val fiw: Int, val blocks: Int, val words: List<String>, val okB: Int, val okA: Int, val total: Int) {
        val where: String get() = "C${cycle}F" + frame.toString().padStart(3, '0')
        val text: String get() = "$blocks block${if (blocks == 1) "" else "s"}, $okB of $total words check · ${words.joinToString(" ")}"
        val line: String get() = "ReFLEX 6400/4L $where $text"
    }

    /** Running counts for the tests and the log. wordsB/okB: phases B and D; wordsA/okA: phases A and C. */
    class Stats { var syncs = 0; var frames = 0; var fiwBad = 0; var wordsB = 0; var okB = 0; var wordsA = 0; var okA = 0 }
    val stats = Stats()
    /** Every frame, as it ends (tests, and SINGLE mode's packet log). */
    var onFrame: ((Frame) -> Unit)? = null

    private val rate = fs
    private var sps = fs / BAUD
    private val toHz = fs / (2 * PI)
    private val dcA = 1.0 / (0.2 * fs)
    private var ph = 0.0; private var acc = 0.0; private var nAcc = 0; private var prevS = 0.0
    private var dc = 0.0
    private var hi = 0; private var mid = 0; private var lo = 0
    private val vals = DoubleArray(80); private var vW = 0
    private var st = SEARCH; private var n = 0; private var word = 0
    private var inv = false; private var dev = 2400.0
    private var cycle = 0; private var frame = 0; private var fiw = 0
    /** The block's data symbols as the clock sampled them ([0]) and a quarter, half and three quarters of a symbol
     *  later ([1]-[3]): a block whose timing slipped is read at the timing its words check best at. */
    private val alt = Array(4) { DoubleArray(BLOCK_SYMS) }
    private val altAcc = DoubleArray(4); private val altN = IntArray(4); private val altK = IntArray(4)
    private var mag = 0.0
    private var blocks = 0; private var first: List<String> = emptyList()
    private var okB = 0; private var okA = 0; private var tot = 0
    private var short: Triple<Int, Int, List<String>>? = null

    /** FM discriminator samples in radians per sample. */
    fun push(xs: FloatArray, count: Int) {
        for (i in 0 until count) {
            val v = xs[i] * toHz
            if (st == SEARCH) dc += (v - dc) * dcA
            val s = v - dc
            // a crossing belongs at a symbol edge: pull the clock toward it
            if ((s > 0) != (prevS > 0)) { var e = ph; if (e > sps / 2) e -= sps; ph -= e * 0.1 }
            prevS = s
            if (ph > sps * 0.25 && ph < sps * 0.75) { acc += s; nAcc++ }
            ph += 1.0
            if (st == DATA) later(s)
            if (ph >= sps) { ph -= sps; val m = if (nAcc > 0) acc / nAcc else 0.0; acc = 0.0; nAcc = 0; symbol(m) }
        }
    }

    /** The other three timings of a data symbol: each its own mid-symbol window, [o] quarters of a symbol late. */
    private fun later(s: Double) {
        for (o in 1..3) {
            var p = ph - o * sps / 4; if (p < 0) p += sps
            if (p > sps * 0.25 && p < sps * 0.75) { altAcc[o] += s; altN[o]++ }
            else if (altN[o] > 0 && p >= sps * 0.75 && altK[o] < BLOCK_SYMS) { alt[o][altK[o]++] = altAcc[o] / altN[o]; altAcc[o] = 0.0; altN[o] = 0 }
        }
    }

    private fun symbol(v: Double) {
        when (st) {
            SEARCH -> {
                val b = if (v > 0) 1 else 0
                hi = ((hi shl 1) or (mid ushr 31)) and 0xFFFF
                mid = (mid shl 1) or (lo ushr 31)
                lo = (lo shl 1) or b
                vals[vW] = v; vW = (vW + 1) % 80
                val e = Integer.bitCount(hi xor SYNC_HI) + Integer.bitCount(mid xor SYNC_MID) + Integer.bitCount(lo xor SYNC_LO)
                if (e <= SYNC_ERRS || 80 - e <= SYNC_ERRS) { inv = e > SYNC_ERRS; locked() }
            }
            FIW -> { word = (word shl 1) or (if ((v > 0) != inv) 1 else 0); if (++n == 32) readFiw() }
            SYNC2 -> if (++n == SYNC2_SYMS) { n = 0; st = DATA }
            DATA -> {
                alt[0][n++] = v
                mag += abs(v)
                if (n == BLOCK_SYMS) { n = 0; val m = mag / BLOCK_SYMS; mag = 0.0; block(m); altK.fill(0) }
            }
        }
    }

    /**
     * The sync word is in. Its 80 symbols are known, so a straight-line fit of what was heard to what was sent gives
     * the deviation and what is left of the offset, which is then held for the frame (the 4-level slicer needs both).
     */
    private fun locked() {
        var sv = 0.0; var ss = 0.0; var ssv = 0.0
        for (k in 0 until 80) {
            val v = vals[(vW + k) % 80]; val bit = 79 - k
            val one = when { bit >= 64 -> (SYNC_HI ushr (bit - 64)) and 1; bit >= 32 -> (SYNC_MID ushr (bit - 32)) and 1; else -> (SYNC_LO ushr bit) and 1 }
            val sgn = if ((one == 1) != inv) 1.0 else -1.0
            sv += v; ss += sgn; ssv += sgn * v
        }
        val den = 80 - ss * ss / 80
        val d = if (den > 0) (ssv - ss * sv / 80) / den else 0.0
        val off = (sv - d * ss) / 80
        dev = max(300.0, d); dc += off
        st = FIW; n = 0; word = 0; hi = 0; mid = 0; lo = 0
        stats.syncs++
    }

    private fun readFiw() {
        val c = PagerBch.correct(word)
        val f = if (c == null) -1 else PagerBch.flexData(c)
        if (f < 0 || nibbleSum(f) != 0xF) { stats.fiwBad++; st = SEARCH; return }
        fiw = f; cycle = (f ushr 4) and 0xF; frame = (f ushr 8) and 0x7F
        blocks = 0; first = emptyList(); okA = 0; okB = 0; tot = 0; short = null
        stats.frames++
        sink.onSync("ReFLEX", "6400")
        st = SYNC2; n = 0; mag = 0.0; altK.fill(0); altN.fill(0); altAcc.fill(0.0)
        // the data runs at twice the sync's speed: the clock goes on from where it is, in the shorter symbol
        sps = rate / DATA_BAUD; if (ph >= sps) ph -= sps
    }

    /**
     * One block of 512 symbols. Each symbol carries two bits; the even symbols' go to phases A (high bit) and B (low
     * bit), the odd symbols' to C and D, each phase 8 words bit-interleaved as FLEX does. Phases B and D carry
     * BCH(32,21) words; A and C do not follow that code, so they are only counted. [mag] is the mean distance of the
     * symbols from the center: four levels a third of the deviation apart average two thirds of it; silence (which
     * decodes as all-zero words, and a check passes those) sits well under that and noise well over.
     */
    private fun block(mag: Double) {
        if (mag < dev * 0.35 || mag > dev * 1.3) { end(); return }
        var best: Array<IntArray>? = null; var bestOk = -1
        for (o in 0 until 4) {
            if (o > 0 && altK[o] < BLOCK_SYMS - 1) continue
            val w = phases(alt[o], if (o > 0) altK[o] else BLOCK_SYMS)
            var ok = 0; for (p in intArrayOf(1, 3)) for (x in w[p]) if (PagerBch.correct(x) != null) ok++
            if (ok > bestOk) { bestOk = ok; best = w }
            if (ok == 16) break
        }
        val w = best!!
        var b = 0; var a = 0
        val words = ArrayList<String>(16)
        for (p in intArrayOf(1, 3)) for (j in 0 until 8) {
            val cb = PagerBch.correct(w[p][j])
            if (cb != null) { b++; words += "%06X".format(PagerBch.flexData(cb)) } else words += "------"
        }
        for (p in intArrayOf(0, 2)) for (j in 0 until 8) if (PagerBch.correct(w[p][j]) != null) a++
        if (b < BLOCK_MIN_OK) {
            if (short != null || blocks == 0) { end(); return }
            short = Triple(b, a, words); return
        }
        short?.let { count(it.first, it.second, it.third); short = null }
        count(b, a, words)
        if (blocks >= MAX_BLOCKS) end()
    }

    /** A block's symbols ([k] of them; a missing last one reads as the center) sliced and dealt into the four phases. */
    private fun phases(v: DoubleArray, k: Int): Array<IntArray> {
        val t = dev * 2 / 3
        fun sl(x: Double): Int { val s = if (inv) -x else x; return if (s > t) 3 else if (s > 0) 2 else if (s > -t) 1 else 0 }
        val w = Array(4) { IntArray(8) }
        for (c in 0 until BLOCK_SYMS / 2) {
            val e = sl(if (2 * c < k) v[2 * c] else 0.0); val o = sl(if (2 * c + 1 < k) v[2 * c + 1] else 0.0); val j = c and 7
            w[0][j] = (w[0][j] shl 1) or (e shr 1); w[1][j] = (w[1][j] shl 1) or (e and 1)
            w[2][j] = (w[2][j] shl 1) or (o shr 1); w[3][j] = (w[3][j] shl 1) or (o and 1)
        }
        return w
    }

    private fun count(b: Int, a: Int, words: List<String>) {
        stats.wordsB += 16; stats.okB += b; stats.wordsA += 16; stats.okA += a
        okB += b; okA += a; tot += 16
        if (blocks++ == 0) first = words
    }

    private fun end() {
        st = SEARCH; n = 0; short = null; sps = rate / BAUD
        if (blocks == 0) return
        val f = Frame(cycle, frame, fiw, blocks, first, okB, okA, tot)
        onFrame?.invoke(f)
        sink.onPage(PagerPage("ReFLEX", "6400", -1L, PageKind.FRAME, f.text, f.where, 0, KEY, 2))
    }

    companion object {
        /** The [PagerPage.key] every ReFLEX frame card carries: each new frame replaces its carrier's card. */
        const val KEY = "reflex"
        private const val BAUD = 1600.0
        /** The data's symbol rate: 4-level at 3200 baud, 6400 bps. */
        private const val DATA_BAUD = 3200.0
        private const val SYNC_HI = 0x163B
        private const val SYNC_MID = 0x59390000
        private val SYNC_LO = 0xE9C4A6C6.toInt()
        private const val SYNC_ERRS = 6
        /** Data symbols between the frame information word and the first block: 25 ms, as FLEX's sync 2. */
        private const val SYNC2_SYMS = 80
        /** A block: 160 ms, 512 symbols, 8 words in each of four phases. */
        private const val BLOCK_SYMS = 512
        /** A block counts as sent when this many of its 16 coded words pass (noise passes about a quarter of words,
         *  so 10 of 16 by chance is about one in 600). A frame ends at the second short block in a row, or at
         *  [MAX_BLOCKS]; a single short block between good ones is counted as received with errors. */
        private const val BLOCK_MIN_OK = 10
        private const val MAX_BLOCKS = 16
        private const val SEARCH = 0; private const val FIW = 1; private const val SYNC2 = 2; private const val DATA = 3
        private fun nibbleSum(d: Int) = ((d and 0xF) + ((d ushr 4) and 0xF) + ((d ushr 8) and 0xF) + ((d ushr 12) and 0xF) + ((d ushr 16) and 0xF) + ((d ushr 20) and 1)) and 0xF
    }
}
