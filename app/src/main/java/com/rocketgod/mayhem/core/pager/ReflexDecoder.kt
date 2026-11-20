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
 * - After 36 more symbols the frame runs 4-level at 1600 baud (3200 bps), outer about the sync's deviation and inner
 *   a third of it, in blocks of 256 symbols. One of the two bits each symbol carries (the low bit, levels numbered
 *   0 to 3 from the lower tone) passes BCH(32,21) on about 91% of words with FLEX's 8-word bit interleave; the other
 *   bit does not follow that code at any alignment, so it is counted and not decoded.
 *
 * Each frame goes to the sink as a FRAME page with no capcode: its cycle and frame, how many blocks it ran and the
 * checked words of its first block in hex. No address or text is read from it.
 */
class ReflexDecoder(private val sink: PagerSink, fs: Double) {
    data class Frame(val cycle: Int, val frame: Int, val fiw: Int, val blocks: Int, val words: List<String>, val okB: Int, val okA: Int, val total: Int) {
        val where: String get() = "C${cycle}F" + frame.toString().padStart(3, '0')
        val text: String get() = "$blocks block${if (blocks == 1) "" else "s"}, $okB of $total words check · ${words.joinToString(" ")}"
        val line: String get() = "ReFLEX 3200/4L $where $text"
    }

    /** Running counts for the tests and the log. */
    class Stats { var syncs = 0; var frames = 0; var fiwBad = 0; var wordsB = 0; var okB = 0; var wordsA = 0; var okA = 0 }
    val stats = Stats()
    /** Every frame, as it ends (tests). */
    var onFrame: ((Frame) -> Unit)? = null

    private val sps = fs / BAUD
    private val toHz = fs / (2 * PI)
    private val dcA = 1.0 / (0.2 * fs)
    private var ph = 0.0; private var acc = 0.0; private var nAcc = 0; private var prevS = 0.0
    private var dc = 0.0
    private var hi = 0; private var mid = 0; private var lo = 0
    private val vals = DoubleArray(80); private var vW = 0
    private var st = SEARCH; private var n = 0; private var word = 0
    private var inv = false; private var dev = 2400.0
    private var cycle = 0; private var frame = 0; private var fiw = 0
    private val sym = IntArray(BLOCK_SYMS); private var mag = 0.0
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
            if (ph >= sps) { ph -= sps; val m = if (nAcc > 0) acc / nAcc else 0.0; acc = 0.0; nAcc = 0; symbol(m) }
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
                val s = if (inv) -v else v; val t = dev * 2 / 3
                sym[n++] = if (s > t) 3 else if (s > 0) 2 else if (s > -t) 1 else 0
                mag += abs(s)
                if (n == BLOCK_SYMS) { n = 0; val m = mag / BLOCK_SYMS; mag = 0.0; block(m) }
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
        sink.onSync("ReFLEX", "3200")
        st = SYNC2; n = 0; mag = 0.0
    }

    /**
     * One block of 256 symbols: each of its two bit streams deinterleaved into 8 words and checked. [mag] is the mean
     * distance of its symbols from the center: four levels a third of the deviation apart average two thirds of it,
     * and a block well under that is the carrier gone (silence decodes as all-zero words, which a check passes).
     */
    private fun block(mag: Double) {
        if (mag < dev * 0.35) { end(); return }
        val wa = IntArray(8); val wb = IntArray(8)
        for (c in 0 until BLOCK_SYMS) { val s = sym[c]; val j = c and 7; wa[j] = (wa[j] shl 1) or (s shr 1); wb[j] = (wb[j] shl 1) or (s and 1) }
        var b = 0; var a = 0
        val words = ArrayList<String>(8)
        for (j in 0 until 8) {
            val cb = PagerBch.correct(wb[j])
            if (cb != null) { b++; words += "%06X".format(PagerBch.flexData(cb)) } else words += "------"
            if (PagerBch.correct(wa[j]) != null) a++
        }
        if (b < BLOCK_MIN_OK) {
            if (short != null || blocks == 0) { end(); return }
            short = Triple(b, a, words); return
        }
        short?.let { count(it.first, it.second, it.third); short = null }
        count(b, a, words)
        if (blocks >= MAX_BLOCKS) end()
    }

    private fun count(b: Int, a: Int, words: List<String>) {
        stats.wordsB += 8; stats.okB += b; stats.wordsA += 8; stats.okA += a
        okB += b; okA += a; tot += 8
        if (blocks++ == 0) first = words
    }

    private fun end() {
        st = SEARCH; n = 0; short = null
        if (blocks == 0) return
        val f = Frame(cycle, frame, fiw, blocks, first, okB, okA, tot)
        onFrame?.invoke(f)
        sink.onPage(PagerPage("ReFLEX", "3200", -1L, PageKind.FRAME, f.text, f.where, 0, KEY, 2))
    }

    companion object {
        /** The [PagerPage.key] every ReFLEX frame card carries: each new frame replaces its carrier's card. */
        const val KEY = "reflex"
        private const val BAUD = 1600.0
        private const val SYNC_HI = 0x163B
        private const val SYNC_MID = 0x59390000
        private val SYNC_LO = 0xE9C4A6C6.toInt()
        private const val SYNC_ERRS = 6
        private const val SYNC2_SYMS = 36
        private const val BLOCK_SYMS = 256
        /** A block counts as sent when this many of its checked phase's 8 words pass (noise passes about a quarter of
         *  words, so 6 of 8 by chance is rare). A frame ends at the second short block in a row, or at [MAX_BLOCKS]. */
        private const val BLOCK_MIN_OK = 6
        private const val MAX_BLOCKS = 16
        private const val SEARCH = 0; private const val FIW = 1; private const val SYNC2 = 2; private const val DATA = 3
        private fun nibbleSum(d: Int) = ((d and 0xF) + ((d ushr 4) and 0xF) + ((d ushr 8) and 0xF) + ((d ushr 12) and 0xF) + ((d ushr 16) and 0xF) + ((d ushr 20) and 1)) and 0xF
    }
}
