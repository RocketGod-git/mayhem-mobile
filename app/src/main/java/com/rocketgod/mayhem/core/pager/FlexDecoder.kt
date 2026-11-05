package com.rocketgod.mayhem.core.pager

import kotlin.math.abs

/**
 * FLEX on FM-discriminator samples at [fs]: 1600 / 3200 / 6400 bps, 2- and 4-level FSK.
 *
 * A frame is 1.875 s: sync 1 at 1600 baud (a 64-bit word: mode code, the 0xA6C6AAAA marker, the code inverted),
 * the frame information word (cycle and frame number), a short sync 2 at the frame's own speed, then 1.76 s of data
 * carrying one to four interleaved phases (A-D) of 88 words each. Every phase opens with a block information word
 * that says where its address and vector fields sit; each address points at a vector that says what the page is
 * and where its message words are. Message layout follows ARIB STD-43A, the published FLEX standard (section
 * numbers below are its): pages split across frames are joined by message number, each page's checksum K is checked,
 * and a page sent more than once is combined word by word, so a word one copy lost can come from another.
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
    /** How sure each received bit is, 0 (on the decision line) to 1 (a clean symbol): word × 32, MSB at index 31. */
    private val sure = Array(4) { FloatArray(WORDS * 32) }
    private val got = Array(4) { IntArray(WORDS) }
    private var bitCounter = 0
    private var odd = false
    private var frames = 0L
    /** Words the plain BCH check could not fix that soft decoding brought back (for tests and the log). */
    var recovered = 0; private set
    /** Seconds of signal heard: the clock a split page's hold and a repeat's window run on. */
    private var heardS = 0.0
    private val secondsPerSample = 1.0 / fs

    fun push(xs: FloatArray, n: Int) { heardS += n * secondsPerSample; for (i in 0 until n) if (clock.push(xs[i])) symbol(clock.value) }

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
                    for (g in got) g.fill(0)
                    bitCounter = 0; odd = false; st = DATA; count = 0
                }
            }
            DATA -> {
                val r = rect(v)
                val a: Int; val b: Int
                // how far each bit's decision sat from its line, in units of a clean symbol's distance
                val sa: Float; val sb: Float
                if (levels == 4) {
                    val thr = env * 2.0 / 3.0
                    val sym = if (r > thr) 3 else if (r > 0) 2 else if (r > -thr) 1 else 0
                    a = if (sym > 1) 1 else 0
                    b = if (sym == 1 || sym == 2) 1 else 0
                    val unit = (env / 3.0).coerceAtLeast(1e-9)
                    sa = (abs(r) / unit).coerceAtMost(1.0).toFloat()
                    sb = (abs(abs(r) - thr) / unit).coerceAtMost(1.0).toFloat()
                } else { a = if (r > 0) 1 else 0; b = 0; sa = (abs(r) / env.coerceAtLeast(1e-9)).coerceAtMost(1.0).toFloat(); sb = 1f }
                if (baud == 1600 || !odd) { put(0, a, sa); put(1, b, sb) } else { put(2, a, sa); put(3, b, sb) }
                if (baud == 1600) bitCounter++ else { if (odd) bitCounter++; odd = !odd }
                if (++count == baud * 1760 / 1000) { decodeFrame(); restart() }
            }
        }
    }

    private fun put(phase: Int, bit: Int, conf: Float) {
        val idx = (bitCounter ushr 8) * 8 + (bitCounter and 7)   // 8 words per 256-bit block, bit-interleaved
        if (idx < WORDS) {
            phases[phase][idx] = (phases[phase][idx] shl 1) or bit
            val k = got[phase][idx]++
            if (k < 32) sure[phase][idx * 32 + 31 - k] = conf
        }
    }

    /**
     * A word the BCH check gave up on, decoded again with what the receiver knew about each bit. The least sure bits
     * (up to five, each under [WEAK]) are treated as erasures: every way of flipping them is tried, and a flip that
     * lands within BCH reach of a codeword is kept if the errors outside those bits stay inside what the code can
     * still guarantee with that many erasures (2 errors + erasures < 6, the distance of BCH(31,21) with parity).
     * Inside that bound the answer is unique, so this recovers words lost in a fade without inventing any from
     * noise, which the plain check cannot tell apart. The cheapest answer (least total sureness flipped) wins.
     */
    private fun recover(raw: Int, conf: FloatArray, base: Int): Int? {
        val weak = (0 until 32).filter { conf[base + it] < WEAK }.sortedBy { conf[base + it] }.take(5)
        if (weak.isEmpty()) return null
        var best: Int? = null; var bestCost = Float.MAX_VALUE
        for (m in 1 until (1 shl weak.size)) {
            var flip = 0; var cost = 0f
            for (j in weak.indices) if ((m ushr j) and 1 == 1) { flip = flip or (1 shl weak[j]); cost += conf[base + weak[j]] }
            val c = PagerBch.correct(raw xor flip) ?: continue
            var outside = c xor raw xor flip
            for (bit in weak) outside = outside and (1 shl bit).inv()
            val extra = Integer.bitCount(outside)
            if (2 * extra + weak.size >= 6) continue
            for (bit in 0 until 32) if ((outside ushr bit) and 1 == 1) cost += conf[base + bit]
            if (cost < bestCost) { bestCost = cost; best = c }
        }
        return best
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
        for (p in list) decodePhase(phases[p], "ABCD"[p], sure[p])
        // A split page whose remaining fragments never came within the hold time: what arrived, marked as unfinished.
        val now = heardS
        for (key in streams.keys.toList()) {
            val s = streams[key]!!
            if (now - s.at > HOLD_S) { streams.remove(key); finish(s, CUT, complete = false) }
        }
        seen.removeAll { now - it.at > HOLD_S }
    }

    private fun decodePhase(raw: IntArray, letter: Char, conf: FloatArray) {
        if (raw.all { it == 0 || it == -1 }) return
        val w = IntArray(WORDS)
        val bad = BooleanArray(WORDS)
        val fix = IntArray(WORDS)
        for (i in 0 until WORDS) {
            val c = PagerBch.correct(raw[i])
            if (c != null) { w[i] = PagerBch.flexData(c); fix[i] = Integer.bitCount(raw[i] xor c); continue }
            // past what the check fixes on its own: try again with the bits it was least sure of
            val r = recover(raw[i], conf, i * 32)
            if (r != null) { w[i] = PagerBch.flexData(r); fix[i] = SOFT; recovered++ } else bad[i] = true
        }
        this.fix = fix
        if (bad[0]) return
        val biw = w[0]
        if (biw == 0 || biw == 0x1FFFFF || !checksumOk(biw)) return
        val vOff = (biw ushr 10) and 0x3F
        val aOff = ((biw ushr 8) and 3) + 1
        if (vOff <= aOff || vOff >= WORDS) return
        // Vectors pair with addresses in order; an address with no vector (past the last valid one) is tone only.
        var validVecs = 0
        for (k in 0 until vOff - aOff) { val wi = vOff + k; if (wi < WORDS && !bad[wi] && checksumOk(w[wi])) validVecs = k + 1 }
        val where = "C%02d F%03d %c".format(cycle, frame, letter)
        var vec = 0
        var i = aOff
        while (i < vOff) {
            val aw = w[i]
            // a long address takes two address words and two vector words, whether or not this one can be read
            val long = isLong(aw)
            val j = vOff + vec
            vec += if (long) 2 else 1
            val next = i + (if (long) 2 else 1)
            if (bad[i] || aw == 0 || aw == 0x1FFFFF) { i = next; continue }
            val cap: Long = if (long) { if (i + 1 >= vOff || bad[i + 1]) { i = next; continue }; longCapcode(aw, w[i + 1]) } else (aw - 0x8000).toLong()
            if (cap <= 0 || cap > 4297068542L) { i = next; continue }
            if (j - vOff >= validVecs || j >= WORDS) {
                if (!long && cap != 1L) emit(cap, PageKind.TONE, "", where)
                i = next; continue
            }
            if (!bad[j] && (!long || (j + 1 < WORDS && !bad[j + 1]))) page(w, bad, j, cap, long, where)
            i = next
        }
    }

    /** The current phase's words: how many bits the check fixed (0-2), [SOFT] if soft decoding brought it back. */
    private var fix = IntArray(WORDS)

    private fun page(w: IntArray, bad: BooleanArray, j: Int, cap: Long, long: Boolean, where: String) {
        val viw = w[j]
        val type = (viw ushr 4) and 7
        val b = (viw ushr 7) and 0x7F
        when (type) {
            T_ALPHA, T_SECURE, T_BINARY -> {
                // Section 3.9: n counts the message's words, its header included. A short address's header is the
                // first message word; a long address carries it in its second vector word instead.
                var len = (viw ushr 14) and 0x7F
                val hdr: Int; var mw = b
                if (long) hdr = j + 1 else { hdr = b; mw = b + 1 }
                if (len >= 1) len--
                if (b == 0 || hdr >= WORDS || mw > WORDS) return
                if (mw + len > WORDS) len = WORDS - mw
                val secureData = type == T_SECURE && !bad[hdr] && (w[hdr] ushr 19) and 3 != 0
                if (type == T_BINARY || secureData) binary(w, bad, hdr, mw, len, cap, if (type == T_SECURE) PageKind.SECURE else PageKind.BINARY, where)
                else alpha(w, bad, hdr, mw, len, cap, type, where)
            }
            T_NUM, T_SNUM, T_NNUM -> numeric(w, bad, j, type == T_NNUM, long)?.let { (text, errors) -> emit(cap, PageKind.NUMERIC, text, where, errors) }
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
            // T_INSTR: temporary address assignments and system events, not pages.
        }
    }

    private fun emit(cap: Long, kind: PageKind, text: String, where: String, errors: Int = 0, key: String = "", repeat: Int = 0) =
        sink.onPage(PagerPage("FLEX", rateLabel(), cap, kind, text, where, errors, key, repeat))

    /** The three bit groups of a 21-bit word (0-7, 8-15, 16-20) that FLEX's message checksums add up. */
    private fun groups(d: Int) = (d and 0xFF) + ((d ushr 8) and 0xFF) + ((d ushr 16) and 0x1F)

    /** A page arriving in fragments, matched by capcode, type and message number N (Section 3.10.1.3). */
    private class Stream(val cap: Long, val kind: PageKind, val n: Int, val at: Double, val rate: String, val where: String) {
        val text = StringBuilder()
        var errors = 0; var words = 0; var lostWords = 0; var expectF = 0
    }
    private val streams = HashMap<String, Stream>()
    /** A whole page heard lately, word by word, so another transmission of it can fill words this copy lost. */
    private class Seen(val cap: Long, val type: Int, val n: Int, val words: IntArray, val gone: BooleanArray, var at: Double)
    private val seen = ArrayList<Seen>()

    /**
     * An alphanumeric (or secure text) page, per Section 3.10.1.3. Its header word: K, a 10-bit checksum (bits 0-9);
     * C, more fragments follow (10); F, the fragment number (11-12, 3 for the first); N, the message number
     * (13-18); R and M, retrieval and mail-drop flags (19, 20). Characters are 7-bit, three to a word, except the
     * first word of a first fragment, whose low seven bits are the signature S.
     */
    private fun alpha(w: IntArray, bad: BooleanArray, hdr: Int, mw: Int, len: Int, cap: Long, type: Int, where: String) {
        val kind = if (type == T_SECURE) PageKind.SECURE else PageKind.ALPHA
        val known = !bad[hdr]
        val h = if (known) w[hdr] else 0
        val more = (h ushr 10) and 1
        val frag = if (known) (h ushr 11) and 3 else 3
        val n = (h ushr 13) and 0x3F
        val first = frag == 3
        val words = IntArray(len) { w[mw + it] }
        val gone = BooleanArray(len) { bad[mw + it] }
        val fixed = IntArray(len) { fix[mw + it] }
        // K: the ones' complement of the sum of the header (K zeroed) and the message words. When it does not come
        // out, or cannot be worked out because a word was lost, the words the check fixed at its limit (two bits,
        // or brought back by soft decoding) are the likely culprits: noise "corrected" into a wrong word. They count
        // as lost unless another copy confirms them. A word fixed by one bit or none is kept: being wrong would take
        // five or more bit errors.
        fun kOk(): Boolean {
            if (!known || gone.any { it }) return false
            var s = groups(h and 0x3FF.inv())
            for (d in words) s += groups(d)
            return (s.inv() and 0x3FF) == (h and 0x3FF)
        }
        if (!kOk()) {
            val lostNear = BooleanArray(len) { (it > 0 && gone[it - 1]) || (it + 1 < len && gone[it + 1]) }
            val anyGone = gone.any { it }
            for (k in 0 until len) if (!gone[k] && fixed[k] >= 2 && (!anyGone || lostNear[k])) gone[k] = true
        }
        // Another transmission of the same whole page (Section 3.4.2): same capcode, type, message number and length,
        // and every word both copies read agrees. Words one copy lost are taken from the other. A copy adding nothing
        // is a repeat, not a new page.
        var repeat = 0
        if (known && first && more == 0 && len > 0) {
            val s = seen.firstOrNull { it.cap == cap && it.type == type && it.n == n && it.words.size == len &&
                (0 until len).none { k -> !it.gone[k] && !gone[k] && it.words[k] != words[k] } }
            if (s == null) seen += Seen(cap, type, n, words.copyOf(), gone.copyOf(), heardS)
            else {
                val adds = (0 until len).any { s.gone[it] && !gone[it] }
                for (k in 0 until len) if (gone[k] && !s.gone[k]) { words[k] = s.words[k]; gone[k] = false }
                for (k in 0 until len) if (s.gone[k] && !gone[k]) { s.words[k] = words[k]; s.gone[k] = false }
                s.at = heardS
                repeat = if (adds) 2 else 1
            }
        }
        // the characters
        val chars = ArrayList<Int>()
        var lostWords = 0
        for (k in 0 until len) {
            val d = words[k]
            // the first word of a first fragment opens with the signature S, not a character
            val sigWord = k == 0 && first
            if (gone[k]) { repeat(if (sigWord) 2 else 3) { chars += LOST }; lostWords++; continue }
            for (s in (if (sigWord) intArrayOf(7, 14) else intArrayOf(0, 7, 14))) chars += (d ushr s) and 0x7F
        }
        val text = render(chars)
        if (!known || (first && more == 0)) {
            // the whole page in one piece; with its header lost, its fragment and number are unknown, so it is partial
            val errors = if (known) lostWords else maxOf(1, lostWords)
            emit(cap, kind, if (lostWords * 2 > len) "" else text.trimEnd(), where, errors, if (known) "$type/$n" else "", repeat)
            return
        }
        val key = "$cap/$type/$n"
        if (first) {
            // the first of several: a new stream (an unfinished one with this number is sent as it stands)
            streams.remove(key)?.let { finish(it, CUT, complete = false) }
            streams[key] = Stream(cap, kind, n, heardS, rateLabel(), where).also { it.text.append(text); it.errors = lostWords; it.words = len; it.lostWords = lostWords; it.expectF = 0 }
            return
        }
        // a continuation: F runs 0, 1, 2, 0 ... after the first; a break in it is a fragment that never arrived
        val s = streams[key] ?: Stream(cap, kind, n, heardS, rateLabel(), where).also { it.text.append(GAP); it.errors = 1; it.expectF = frag; streams[key] = it }
        if (frag != s.expectF) { s.text.append(GAP); s.errors++ }
        s.text.append(text); s.errors += lostWords; s.words += len; s.lostWords += lostWords
        s.expectF = (frag + 1) % 3
        if (more == 0) { streams.remove(key); finish(s, "", complete = true) }
    }

    /** Send a fragmented page: whole when its last piece came, unfinished (marked [CUT]) when the hold ran out. */
    private fun finish(s: Stream, tail: String, complete: Boolean) {
        val errors = s.errors + (if (!complete) 1 else 0)
        val text = if (s.lostWords * 2 > s.words) "" else s.text.toString().trimEnd() + tail
        sink.onPage(PagerPage("FLEX", s.rate, s.cap, s.kind, text, s.where, errors, "", 0))
    }

    /** Characters to text: ETX and NUL are fill (dropped at the end, '?' between); a lost word's slots are '?'. Spaces are
     *  kept at the end: a fragment may end in one. */
    private fun render(chars: List<Int>): String {
        val sb = StringBuilder()
        var end = chars.size - 1
        while (end >= 0 && (chars[end] == 0x03 || chars[end] == 0x00)) end--
        for (k in 0..end) {
            val c = chars[k]
            sb.append(when { c == LOST -> '?'; c == 0x03 || c == 0x00 -> '?'; c >= 0x20 || c == 0x0A || c == 0x0D -> c.toChar(); else -> '?' })
        }
        return sb.toString()
    }

    /** Binary pages (Section 3.10.1.2) as hex, the second header word left out of a first fragment. */
    private fun binary(w: IntArray, bad: BooleanArray, hdr: Int, mw: Int, len: Int, cap: Long, kind: PageKind, where: String) {
        if (len <= 0) return
        val first = !bad[hdr] && ((w[hdr] ushr 13) and 3) == 3 && kind == PageKind.BINARY
        val from = if (first) 1 else 0
        val sb = StringBuilder()
        var lost = 0
        for (k in from until len) { if (sb.isNotEmpty()) sb.append(' '); if (bad[mw + k]) lost++; sb.append(if (bad[mw + k]) "??????" else "%06X".format(w[mw + k])) }
        // a binary page that is mostly lost words is noise: it goes out empty, so the feed can hide it
        val n = len - from
        emit(cap, kind, if (n <= 0 || lost * 2 > n) "" else sb.toString(), where, lost)
    }

    /**
     * Numeric pages (Section 3.10.1.1): BCD digits, low bit first, after 2 checksum bits (10 bits for numbered
     * numeric: checksum, N, R, S). The first message word is the second vector word for a long address. K is six bits:
     * K3-K0 in the vector (bits 17-20) and K5K4 in the first word (bits 0-1), over every message word.
     */
    private fun numeric(w: IntArray, bad: BooleanArray, j: Int, numbered: Boolean, long: Boolean): Pair<String, Int>? {
        val viw = w[j]
        val w1 = (viw ushr 7) and 0x7F
        val n = (viw ushr 14) and 7
        if (w1 >= WORDS || (long && j + 1 >= WORDS)) return null
        val body0 = if (long) j + 1 else w1
        val words = ArrayList<Int>()
        words.add(body0)
        val start = if (long) w1 else w1 + 1
        val end = minOf(if (long) w1 + n - 1 else w1 + n, WORDS - 1)
        for (k in start..end) words.add(k)
        val sb = StringBuilder()
        var digit = 0
        var left = 4 + (if (numbered) 10 else 2)
        var lost = 0
        var sum = 0
        for ((idx, k) in words.withIndex()) {
            if (k !in 0 until WORDS || bad[k]) { sb.append("?????"); digit = 0; left = 4; lost++; continue }
            var d = w[k]
            sum += groups(if (idx == 0) d and 3.inv() else d)
            repeat(21) {
                digit = (digit ushr 1) or ((d and 1) shl 3)
                d = d ushr 1
                if (--left == 0) { sb.append(BCD[digit]); left = 4 }
            }
        }
        var errors = lost
        if (lost == 0) {
            val s = sum and 0xFF
            val k6 = ((s and 0x3F) + (s ushr 6)).inv() and 0x3F
            val rx = ((w[body0] and 3) shl 4) or ((viw ushr 17) and 0xF)
            // as for text, a failed K condemns only a word fixed at the code's limit
            if (k6 != rx && words.any { fix[it] >= 2 }) errors = 1
        }
        return sb.toString().trimEnd() to errors
    }

    companion object {
        private const val WORDS = 88
        /** A bit decided closer to its line than this (of a clean symbol's distance) may be wrong: an erasure. */
        private const val WEAK = 0.45f
        /** [fix] for a word soft decoding brought back: as uncertain as a two-bit fix. */
        private const val SOFT = 3
        /** A character slot of a lost word. */
        private const val LOST = -2
        /** How long a split page waits for its next piece, and a page is kept for a repeat: 128 frames, 4 minutes. */
        private const val HOLD_S = 240.0
        /** The end of a page whose last fragment never came. */
        private const val CUT = " …"
        /** Where a fragment is missing inside a page. */
        private const val GAP = "<…>"
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

        /** An address word that opens a long (two-word) address: LA1 or LA2 (LA3 and LA4 only ever come second). */
        fun isLong(aw: Int) = aw in 1..0x8000 || aw in 0x1F7FFF..0x1FFFFE

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
