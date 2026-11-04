package com.rocketgod.mayhem.core.pager

import kotlin.math.abs

/**
 * FLEX on FM-discriminator samples at [fs]: 1600 / 3200 / 6400 bps, 2- and 4-level FSK.
 *
 * A frame is 1.875 s: sync 1 at 1600 baud (a 64-bit word: mode code, the 0xA6C6AAAA marker, the code inverted),
 * the frame information word (cycle and frame number), a short sync 2 at the frame's own speed, then 1.76 s of data
 * carrying one to four interleaved phases (A-D) of 88 words each. Every phase opens with a block information word
 * that says where its address and vector fields sit; each address points at a vector that says what the page is
 * and where its message words are. Alphanumeric pages may be split across frames; the pieces are stitched back.
 */
class FlexDecoder(private val sink: PagerSink, fs: Double) {
    private val clock = FskClock(fs, 1600)
    private val dcRate = clock.dcRate
    private var st = SYNC1
    private var sync64 = 0L
    private var pol = 0
    private var baud = 1600
    private var levels = 2
    private var count = 0
    private var fiw = 0
    private var cycle = 0
    private var frame = 0
    private var s2reg = 0
    private var env = 0.0
    private val phases = Array(4) { IntArray(WORDS) }
    private var bitCounter = 0
    private var odd = false
    private var frames = 0L
    private class Piece(val text: String, val at: Long, val rate: String, val where: String)
    private val pieces = HashMap<Long, Piece>()

    fun push(xs: FloatArray, n: Int) { for (i in 0 until n) if (clock.push(xs[i])) symbol(clock.value) }

    private fun rect(v: Double) = if (pol == 1) -v else v

    private fun symbol(v: Double) {
        when (st) {
            SYNC1 -> {
                env += (abs(v) - env) * 0.05
                sync64 = (sync64 shl 1) or (if (v < 0) 1L else 0L)
                val m = mode(sync64)
                val mi = if (m == null) mode(sync64.inv()) else null
                if (m != null || mi != null) {
                    pol = if (m != null) 0 else 1
                    val mm = m ?: mi!!
                    baud = mm[1]; levels = mm[2]
                    st = FIW; count = 0; fiw = 0
                    clock.gain = FskClock.LOCK_GAIN
                }
            }
            FIW -> {
                env += (abs(v) - env) * 0.05
                if (++count > 16) fiw = (fiw shl 1) or (if (rect(v) > 0) 1 else 0)
                if (count == 48) {
                    val d = PagerBch.correct(fiw)?.let { PagerBch.flexData(it) }
                    if (d == null || !checksumOk(d)) { restart(); return }
                    cycle = (d ushr 4) and 0xF; frame = (d ushr 8) and 0x7F
                    clock.baud = baud
                    clock.dcRate = 0.0   // the data's own DC is not the carrier's: hold the estimate from the sync
                    st = SYNC2; count = 0; s2reg = 0
                    sink.onSync("FLEX", rateLabel())
                }
            }
            SYNC2 -> {
                val nominal = baud * 25 / 1000
                count++
                s2reg = ((s2reg shl 1) or (if (rect(v) > 0) 1 else 0)) and 0xFFFF
                val invC = count >= 16 && Integer.bitCount(s2reg xor 0x127B) <= 2 && abs(count - nominal) <= 1
                if (invC || count == nominal) {
                    for (p in phases) p.fill(0)
                    bitCounter = 0; odd = false; st = DATA; count = 0
                }
            }
            DATA -> {
                val r = rect(v)
                val a: Int; val b: Int
                if (levels == 4) {
                    val thr = env * 2.0 / 3.0
                    val sym = if (r > thr) 3 else if (r > 0) 2 else if (r > -thr) 1 else 0
                    a = if (sym > 1) 1 else 0
                    b = if (sym == 1 || sym == 2) 1 else 0
                } else { a = if (r > 0) 1 else 0; b = 0 }
                if (baud == 1600 || !odd) { put(0, a); put(1, b) } else { put(2, a); put(3, b) }
                if (baud == 1600) bitCounter++ else { if (odd) bitCounter++; odd = !odd }
                if (++count == baud * 1760 / 1000) { decodeFrame(); restart() }
            }
        }
    }

    private fun put(phase: Int, bit: Int) {
        val idx = (bitCounter ushr 8) * 8 + (bitCounter and 7)   // 8 words per 256-bit block, bit-interleaved
        if (idx < WORDS) phases[phase][idx] = (phases[phase][idx] shl 1) or bit
    }

    private fun restart() {
        st = SYNC1; sync64 = 0L; clock.baud = 1600; clock.gain = FskClock.HUNT_GAIN; clock.dcRate = dcRate
    }

    private fun rateLabel() = (baud * (if (levels == 4) 2 else 1)).toString()

    private fun decodeFrame() {
        frames++
        val list = when {
            baud == 1600 && levels == 2 -> intArrayOf(0)
            baud == 1600 -> intArrayOf(0, 1)
            levels == 2 -> intArrayOf(0, 2)
            else -> intArrayOf(0, 1, 2, 3)
        }
        for (p in list) decodePhase(phases[p], "ABCD"[p])
        // A split page whose next piece never came: show what arrived.
        val stale = pieces.filterValues { frames - it.at > 8 }
        for ((cap, pc) in stale) { pieces.remove(cap); sink.onPage(PagerPage("FLEX", pc.rate, cap, PageKind.ALPHA, pc.text + " …", pc.where)) }
    }

    private fun decodePhase(raw: IntArray, letter: Char) {
        if (raw.all { it == 0 || it == -1 }) return
        val w = IntArray(WORDS)
        val bad = BooleanArray(WORDS)
        for (i in 0 until WORDS) {
            val c = PagerBch.correct(raw[i])
            if (c == null) bad[i] = true else w[i] = PagerBch.flexData(c)
        }
        if (bad[0]) return
        val biw = w[0]
        if (biw == 0 || biw == 0x1FFFFF || !checksumOk(biw)) return
        val vOff = (biw ushr 10) and 0x3F
        val aOff = ((biw ushr 8) and 3) + 1
        if (vOff <= aOff || vOff >= WORDS) return
        var validVecs = 0
        for (k in 0 until vOff - aOff) { val wi = vOff + k; if (wi < WORDS && !bad[wi] && checksumOk(w[wi])) validVecs = k + 1 }
        val where = "C%02d F%03d %c".format(cycle, frame, letter)
        var vec = 0
        var i = aOff
        while (i < vOff) {
            val aw = w[i]
            if (bad[i] || aw == 0 || aw == 0x1FFFFF) { i++; continue }
            val long = isLong(aw)
            var cap: Long
            var j = vOff + vec
            if (long) {
                if (i + 1 >= vOff) break
                val aw2 = w[i + 1]
                cap = longCapcode(aw, aw2)
                vec += 2
                if (cap <= 0 || j >= WORDS) { i += 2; continue }
                i++   // the second address word is consumed too
            } else {
                cap = (aw - 0x8000).toLong()
                if (cap <= 0 || vec >= validVecs) { i++; continue }
                vec++
            }
            if (j < WORDS && !bad[j]) page(w, bad, j, cap, long, where)
            i++
        }
    }

    private fun page(w: IntArray, bad: BooleanArray, j: Int, cap: Long, long: Boolean, where: String) {
        val viw = w[j]
        val type = (viw ushr 4) and 7
        val mw1 = (viw ushr 7) and 0x7F
        val rate = rateLabel()
        when (type) {
            T_ALPHA, T_SECURE -> {
                val len = (viw ushr 14) and 0x7F
                val mw2 = mw1 + len - 1
                if (len == 0 || mw2 >= WORDS) return
                val a = if (long) alpha(w, bad, mw1 - 1, mw2 - 1) else alpha(w, bad, mw1, mw2)
                val kind = if (type == T_SECURE) PageKind.SECURE else PageKind.ALPHA
                when {
                    a.frag == 3 && a.more == 0 -> emit(cap, kind, a.text, where)
                    a.more == 1 -> { val prev = if (a.frag == 3) "" else pieces[cap]?.text.orEmpty(); pieces[cap] = Piece(prev + a.text, frames, rate, where) }
                    else -> { val prev = pieces.remove(cap)?.text.orEmpty(); emit(cap, kind, prev + a.text, where) }
                }
            }
            T_NUM, T_SNUM, T_NNUM -> numeric(w, bad, j, type == T_NNUM, long)?.let { emit(cap, PageKind.NUMERIC, it, where) }
            T_TONE -> {
                val t = (viw ushr 7) and 3
                val d = (viw ushr 9) and 0xFFF
                when {
                    t == 0 && d == 0xCCC -> emit(cap, PageKind.TONE, "", where)
                    t == 0 -> {
                        val sb = StringBuilder()
                        for (s in 0 until 12 step 4) sb.append(BCD[(d ushr s) and 0xF])
                        if (long && j + 1 < WORDS && !bad[j + 1]) { val y = w[j + 1]; for (s in 0 until 20 step 4) sb.append(BCD[(y ushr s) and 0xF]) }
                        emit(cap, PageKind.NUMERIC, sb.toString().trim(), where)
                    }
                    else -> emit(cap, PageKind.TONE, "source ${d and 7}", where)
                }
            }
            T_BINARY -> {
                val len = (viw ushr 14) and 0x7F
                val mw2 = mw1 + len - 1
                if (len == 0 || mw2 >= WORDS) return
                val sb = StringBuilder()
                for (k in mw1 + 1..mw2) { if (sb.isNotEmpty()) sb.append(' '); sb.append(if (bad[k]) "??????" else "%06X".format(w[k])) }
                emit(cap, PageKind.BINARY, sb.toString(), where)
            }
            // T_INSTR: temporary address assignments and system events, not pages.
        }
    }

    private fun emit(cap: Long, kind: PageKind, text: String, where: String) =
        sink.onPage(PagerPage("FLEX", rateLabel(), cap, kind, text, where))

    private class Alpha(val text: String, val frag: Int, val more: Int)

    private fun alpha(w: IntArray, bad: BooleanArray, first: Int, last: Int): Alpha {
        var frag = 3; var more = 0
        if (first in 0 until WORDS && !bad[first]) { val h = w[first]; more = (h ushr 10) and 1; frag = (h ushr 11) and 3 }
        val chars = ArrayList<Int>()
        fun put(c: Int, isBad: Boolean) {
            when {
                isBad -> chars.add('?'.code)
                c >= 0x20 || c == 0x0A -> chars.add(c)
                c == 0x03 || c == 0x00 -> chars.add(-1)   // padding: dropped at the end, '?' in the middle
            }
        }
        for (k in first + 1..last) {
            val b = k !in 0 until WORDS || bad[k]
            val d = if (b) 0 else w[k]
            if (k > first + 1) put(d and 0x7F, b)
            put((d ushr 7) and 0x7F, b)
            put((d ushr 14) and 0x7F, b)
        }
        val end = chars.indexOfLast { it != -1 }
        val sb = StringBuilder()
        for (k in 0..end) sb.append(if (chars[k] == -1) '?' else chars[k].toChar())
        return Alpha(sb.toString(), frag, more)
    }

    private fun numeric(w: IntArray, bad: BooleanArray, j: Int, numbered: Boolean, long: Boolean): String? {
        val viw = w[j]
        val w1 = (viw ushr 7) and 0x7F
        val n = (viw ushr 14) and 7
        if (w1 >= WORDS) return null
        val words = ArrayList<Int>()
        words.add(if (long && n > 0) j + 1 else w1)
        val start = if (long) w1 else w1 + 1
        val end = minOf(if (long) w1 + n - 1 else w1 + n, WORDS - 1)
        for (k in start..end) words.add(k)
        val sb = StringBuilder()
        var digit = 0
        var left = 4 + (if (numbered) 10 else 2)   // the first word opens with 2 (or 10) bits that aren't digits
        for (k in words) {
            if (k !in 0 until WORDS || bad[k]) { sb.append("?????"); digit = 0; left = 4; continue }
            var d = w[k]
            repeat(21) {
                digit = (digit ushr 1) or ((d and 1) shl 3)
                d = d ushr 1
                if (--left == 0) { sb.append(BCD[digit]); left = 4 }
            }
        }
        return sb.toString().trimEnd()
    }

    companion object {
        private const val WORDS = 88
        private const val SYNC1 = 0; private const val FIW = 1; private const val SYNC2 = 2; private const val DATA = 3
        private const val MARKER = 0xA6C6AAAA.toInt()
        /** Sync 1 mode codes → (baud, levels): 1600/2, 3200/4 (1600 baud), 3200/2, 6400/4 (two codes on air). */
        private val MODES = arrayOf(intArrayOf(0x870C, 1600, 2), intArrayOf(0xB068, 1600, 4), intArrayOf(0x7B18, 3200, 2),
            intArrayOf(0xDEA0, 3200, 4), intArrayOf(0x4C7C, 3200, 4))
        private const val T_SECURE = 0; private const val T_INSTR = 1; private const val T_TONE = 2; private const val T_NUM = 3
        private const val T_SNUM = 4; private const val T_ALPHA = 5; private const val T_BINARY = 6; private const val T_NNUM = 7
        private const val BCD = "0123456789.U -]["

        private fun mode(buf: Long): IntArray? {
            val marker = (buf ushr 16).toInt()
            val hi = ((buf ushr 48) and 0xFFFF).toInt()
            val lo = buf.toInt().inv() and 0xFFFF
            if (Integer.bitCount(marker xor MARKER) >= 4 || Integer.bitCount(hi xor lo) >= 4) return null
            return MODES.firstOrNull { Integer.bitCount(it[0] xor hi) < 4 }
        }

        /** Words whose four-bit nibbles (plus the top bit) sum to 0xF: the FIW and vector checksum. */
        fun checksumOk(d: Int): Boolean {
            val s = (d and 0xF) + ((d ushr 4) and 0xF) + ((d ushr 8) and 0xF) + ((d ushr 12) and 0xF) + ((d ushr 16) and 0xF) + ((d ushr 20) and 1)
            return (s and 0xF) == 0xF
        }

        /** An address word that is the first half of a long (two-word) address. */
        fun isLong(aw: Int) = aw in 1..0x8000 || aw in 0x1E0001..0x1F0000 || aw in 0x1F7FFF..0x1FFFFE

        fun longCapcode(aw1: Int, aw2: Int): Long {
            val a = aw1.toLong(); val b = aw2.toLong()
            return when {
                aw1 in 1..0x8000 && aw2 in 0x1F7FFF..0x1FFFFE -> a + (0x1FFFFF - b) * 32768 + 2068480
                aw1 in 1..0x8000 && aw2 in 0x1E0001..0x1F0000 -> a + (b - 1933312) * 32768 + 2068480
                aw1 in 0x1F7FFF..0x1FFFFE && aw2 in 0x1E0001..0x1F0000 -> (a - 2064383) + (b - 1867776) * 32768 + 2068479
                else -> -1
            }
        }
    }
}
