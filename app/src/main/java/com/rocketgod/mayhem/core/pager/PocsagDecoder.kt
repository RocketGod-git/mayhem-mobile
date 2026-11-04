package com.rocketgod.mayhem.core.pager

/**
 * POCSAG (ITU-R M.584) on FM-discriminator samples at [fs]. Three lanes run side by side, one per speed (512 /
 * 1200 / 2400 baud), each hunting the 32-bit sync codeword in either polarity; a lane that finds it reads the
 * batch (8 frames × 2 codewords), expects the next sync 16 codewords later, and drops back to hunting when it
 * doesn't come. Codewords are BCH-corrected; an address codeword opens a page (RIC = 18 address bits + the frame
 * it sat in), message codewords add 20 bits each, and the next address or an idle codeword closes it.
 */
class PocsagDecoder(private val sink: PagerSink, fs: Double) {
    private val lanes = intArrayOf(512, 1200, 2400).map { Lane(it, fs) }

    fun push(xs: FloatArray, n: Int) { for (l in lanes) for (i in 0 until n) l.push(xs[i]) }

    private inner class Lane(val baud: Int, fs: Double) {
        private val clock = FskClock(fs, baud)
        private val dcRate = clock.dcRate
        private var reg = 0
        private var inv = false
        private var state = HUNT
        private var bits = 0
        private var cw = 0
        private var address = -1L
        private var func = 0
        private val chunks = IntArray(MAX_CHUNKS)
        private var nChunks = 0
        private var errs = 0
        private var badRun = 0

        fun push(x: Float) {
            if (!clock.push(x)) return
            reg = (reg shl 1) or (if (clock.value > 0) 1 else 0)
            when (state) {
                HUNT -> when {
                    Integer.bitCount(reg xor SYNC) <= 2 -> { inv = false; startBatch() }
                    Integer.bitCount(reg.inv() xor SYNC) <= 2 -> { inv = true; startBatch() }
                }
                BATCH -> if (++bits == 32) {
                    codeword(if (inv) reg.inv() else reg, cw)
                    bits = 0
                    if (++cw == 16) state = RESYNC
                }
                RESYNC -> if (++bits == 32) {
                    val w = if (inv) reg.inv() else reg
                    if (Integer.bitCount(w xor SYNC) <= 4) startBatch() else { flush(); hunt() }
                }
            }
        }

        private fun startBatch() {
            state = BATCH; bits = 0; cw = 0
            clock.gain = FskClock.LOCK_GAIN
            clock.dcRate = 0.0   // the preamble set the carrier's DC; message bits are not balanced, so hold it
            sink.onSync("POCSAG", baud.toString())
        }

        private fun hunt() { state = HUNT; clock.gain = FskClock.HUNT_GAIN; clock.dcRate = dcRate }

        private fun codeword(w: Int, index: Int) {
            val c = PagerBch.correct(w)
            if (c == null) {
                if (address >= 0) {
                    addChunk((w ushr 11) and 0xFFFFF); errs++
                    if (++badRun >= 4) flush()
                }
                return
            }
            badRun = 0
            when {
                c == IDLE -> flush()
                c < 0 -> if (address >= 0) addChunk((c ushr 11) and 0xFFFFF)   // bit 31 set: message codeword
                else -> {
                    flush()
                    address = (((c ushr 13) and 0x3FFFF).toLong() shl 3) or (index / 2).toLong()
                    func = (c ushr 11) and 3
                }
            }
        }

        private fun addChunk(v: Int) { if (nChunks < MAX_CHUNKS) chunks[nChunks++] = v }

        private fun flush() {
            if (address < 0) return
            val page = build()
            address = -1; nChunks = 0; errs = 0; badRun = 0
            if (page != null) sink.onPage(page)
        }

        private fun build(): PagerPage? {
            if (nChunks > 0 && errs * 2 > nChunks + 1) return null   // mostly unreadable: not worth showing
            val where = "func $func"
            if (nChunks == 0) return PagerPage("POCSAG", baud.toString(), address, PageKind.TONE, "", where)
            val num = numeric()
            val alpha = alpha()
            val kind = when (func) {
                0 -> PageKind.NUMERIC
                3 -> PageKind.ALPHA
                else -> if (alpha.length >= 2 && looksLikeText(alpha)) PageKind.ALPHA else PageKind.NUMERIC
            }
            return PagerPage("POCSAG", baud.toString(), address, kind, if (kind == PageKind.ALPHA) alpha else num, where, errs)
        }

        /** The message bits in air order. */
        private fun bit(i: Int): Int = (chunks[i / 20] ushr (19 - i % 20)) and 1

        private fun numeric(): String {
            val sb = StringBuilder()
            var i = 0
            while (i + 4 <= nChunks * 20) {
                var d = 0
                for (k in 0 until 4) d = d or (bit(i + k) shl k)   // first bit is the digit's low bit
                sb.append(NUMERIC[d]); i += 4
            }
            return sb.toString().trimEnd()
        }

        private fun alpha(): String {
            val sb = StringBuilder()
            var i = 0
            while (i + 7 <= nChunks * 20) {
                var c = 0
                for (k in 0 until 7) c = c or (bit(i + k) shl k)
                i += 7
                when {
                    c == 0x00 || c == 0x03 || c == 0x04 || c == 0x17 -> break   // end of text / padding
                    c == 0x0A || c == 0x0D -> sb.append('\n')
                    c >= 0x20 -> sb.append(c.toChar())
                }
            }
            return sb.toString().trim()
        }
    }

    companion object {
        const val SYNC = 0x7CD215D8
        const val IDLE = 0x7A89C197
        private const val HUNT = 0; private const val BATCH = 1; private const val RESYNC = 2
        private const val MAX_CHUNKS = 400
        private const val NUMERIC = "0123456789*U -)("

        fun looksLikeText(s: String): Boolean {
            if (s.isEmpty()) return false
            val good = s.count { it.isLetterOrDigit() || it == ' ' || it in ".,:;!?-/()#@'\"&\n" }
            return good * 100 >= s.length * 85
        }
    }
}
