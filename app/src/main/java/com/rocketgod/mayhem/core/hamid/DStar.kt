package com.rocketgod.mayhem.core.hamid

/**
 * D-STAR digital voice identity (JARL "Digitalization Technology Standard for Amateur Radio": the radio header, data
 * frames and D-PRS): GMSK at 4800 bits/s, LSB first, a positive deviation for a 1. Radio header (frame sync
 * 111011001010000 after the 1010 preamble; flags, RPT2, RPT1, UR, MY, MY suffix and P_FCS, K = 3 convolutional code,
 * the 24-row interleave, the x^7 + x^4 + 1 scrambler), then voice frames with 24-bit data frames (the sync every 21st,
 * the rest scrambled), paired into 6-byte slow data blocks: 4n message, 3n simple data (GPS NMEA, D-PRS), 5n the
 * header again, Cx code squelch, 8x and 9x DV Fast Data (which takes the voice frames too). Either polarity. Each
 * 72-bit voice frame goes out with its time; the AMBE in it is not decoded. The same as the web's dsp/hamid/dstar.ts.
 */
const val DSTAR_FS = "111011001010000"
const val DSTAR_DSYNC = "101010101011010001101000"
const val DSTAR_END = "000100110101111"
private fun bitsOf(s: String) = IntArray(s.length) { if (s[it] == '1') 1 else 0 }
private val FS = bitsOf(DSTAR_FS); private val DSYNC = bitsOf(DSTAR_DSYNC); private val END = bitsOf(DSTAR_END)

/** The scrambler sequence (x^7 + x^4 + 1, all ones to start). */
fun dstarPn(n: Int): IntArray {
    val out = IntArray(n); var s = 0x7f
    for (i in 0 until n) { val fb = ((s shr 6) xor (s shr 3)) and 1; out[i] = fb; s = ((s shl 1) or fb) and 0x7f }
    return out
}
private val PN = dstarPn(660)

/** Interleave: the coded bit sent k-th (24 rows; rows 0..11 hold 28 columns, rows 12..23 hold 27). */
val DSTAR_INTERLEAVE: IntArray = IntArray(660).also { t -> var k = 0; for (r in 0 until 24) for (c in 0 until if (r < 12) 28 else 27) t[k++] = 24 * c + r }

data class DStarHeader(val flag1: Int, val flag2: Int, val flag3: Int, val rpt2: String, val rpt1: String, val ur: String, val my: String, val suffix: String, val crcOk: Boolean)

fun parseHeaderBytes(b: IntArray): DStarHeader {
    val crc = Fec.crc16Lsb(b, 39); val got = (b[39] and 255) or ((b[40] and 255) shl 8)
    return DStarHeader(b[0] and 255, b[1] and 255, b[2] and 255, Fec.asciiField(b, 3, 8), Fec.asciiField(b, 11, 8), Fec.asciiField(b, 19, 8),
        Fec.asciiField(b, 27, 8), Fec.asciiField(b, 35, 4), crc == got)
}

/** 660 received header bits (in the order sent) → the header, or null when its check fails. */
fun decodeHeaderBits(rx: IntArray): DStarHeader? {
    val coded = IntArray(660)
    for (k in 0 until 660) coded[DSTAR_INTERLEAVE[k]] = (rx[k] xor PN[k]) and 1
    val bits = Fec.viterbi(coded, Fec.DSTAR_K, Fec.DSTAR_G).bits
    val h = parseHeaderBytes(Fec.packLsb(bits, 0, 41))
    return if (h.crcOk) h else null
}

/** A repeater field ("N0RPT  B") split into its callsign and module letter. */
fun repeaterOf(f: String): Pair<String, String> {
    val padded = (f + "        ").substring(0, 8)
    return padded.substring(0, 7).trim() to padded.substring(7, 8).trim()
}

class DStarId {
    var header: DStarHeader? = null; var headerFrom = ""
    var message = ""; var position: Position? = null; var positionText = ""; var dprsCrcOk = false
    var inverted = false; var active = false; var frames = 0; var headers = 0
    /** The code squelch block, fast data bytes received this call, and the picture found in them. */
    var csql: DStarCsql? = null; var fastBytes = 0; var image: DStarImage? = null
    /** Icom's message and picture records ("$$Msg", "$$Pic") in the simple or fast data. */
    var icomMessage: IcomMessage? = null; var icomPicture: IcomPicture? = null
    fun copy(): DStarId = DStarId().also { it.header = header; it.headerFrom = headerFrom; it.message = message; it.position = position; it.positionText = positionText; it.dprsCrcOk = dprsCrcOk; it.inverted = inverted; it.active = active; it.frames = frames; it.headers = headers; it.csql = csql; it.fastBytes = fastBytes; it.image = image; it.icomMessage = icomMessage; it.icomPicture = icomPicture }
}

class DStarReceiver {
    var onHeader: (DStarHeader, String) -> Unit = { _, _ -> }
    var onEnd: () -> Unit = {}
    /** Each voice frame (not those carrying fast data), stream "dstar". */
    var onVoiceFrame: (HamVoiceFrame) -> Unit = {}
    private val vbuf = arrayOfNulls<IntArray>(21); private val vAt = DoubleArray(21)
    private val pend = ArrayList<Int>()
    private val fast = FastDataStream()
    /** The simple data bytes of this call, for Icom's records. */
    private val simple = FastDataStream()
    private val hist = IntArray(128); private var hp = 0
    private var inv = 0; private var hdrInv = 0
    private var hdr: IntArray? = null; private var hdrN = 0
    private var cnt = -1; private var missed = 0
    private var half: IntArray? = null
    private var msg = arrayOf("", "", "", ""); private var msgSeen = 0
    private val slowHdr = ArrayList<Int>()
    private val lines = LineBuffer()
    var bits = 0L
    val id = DStarId()

    fun reset() {
        hist.fill(0); hp = 0; inv = 0; hdrInv = 0; hdr = null; hdrN = 0; cnt = -1; missed = 0; half = null
        msg = arrayOf("", "", "", ""); msgSeen = 0; slowHdr.clear(); lines.reset(); bits = 0
        vbuf.fill(null); pend.clear(); fast.reset(); simple.reset()
        id.header = null; id.headerFrom = ""; id.message = ""; id.position = null; id.positionText = ""; id.dprsCrcOk = false; id.inverted = false; id.active = false; id.frames = 0; id.headers = 0
        id.csql = null; id.fastBytes = 0; id.image = null; id.icomMessage = null; id.icomPicture = null
    }

    private fun matches(pat: IntArray, end: Int, inv: Int): Int {
        var e = 0; val n = pat.size; val H = hist.size
        for (i in 0 until n) if (((hist[(hp - end - n + i + 2 * H) % H] xor inv) and 1) != pat[i]) e++
        return e
    }
    private fun alternating(end: Int, n: Int, inv: Int): Boolean {
        var e0 = 0; var e1 = 0; val H = hist.size
        for (i in 0 until n) { val b = (hist[(hp - end - n + i + 2 * H) % H] xor inv) and 1; if (b != (i and 1)) e0++; if (b != ((i + 1) and 1)) e1++ }
        return minOf(e0, e1) <= 1
    }

    fun pushSymbol(s: Double) = pushBit(if (s > 0) 1 else 0)

    fun pushBit(raw: Int) {
        bits++
        hist[hp] = raw and 1; hp = (hp + 1) % hist.size
        val h0 = hdr
        if (h0 != null) {
            h0[hdrN++] = (raw xor hdrInv) and 1
            if (hdrN == 660) {
                val h = decodeHeaderBits(h0); hdr = null
                if (h != null) { inv = hdrInv; id.inverted = inv == 1; cnt = -1; newCall(); id.header = h; id.headerFrom = "header"; id.headers++; id.active = true; onHeader(h, "header") }
            }
            return
        }
        if (id.active && matches(END, 0, inv) == 0 && alternating(15, 16, inv)) { flushVoice(); id.active = false; cnt = -1; onEnd(); return }
        for (iv in intArrayOf(inv, inv xor 1)) {
            if (matches(FS, 0, iv) <= 1 && alternating(15, 16, iv)) { hdrInv = iv; hdr = IntArray(660); hdrN = 0; return }
        }
        if (cnt >= 0) {
            cnt++
            if (cnt % 96 == 0) {
                val k = cnt / 96
                if (k < 21) { keepVoice(k); dataFrame(k) }
                else {
                    if (matches(DSYNC, 0, inv) <= 4) missed = 0 else if (++missed > 2) { flushVoice(); cnt = -1; id.active = false; return }
                    superframe(); keepVoice(0)
                }
            }
            return
        }
        for (iv in intArrayOf(0, 1)) {
            if (matches(DSYNC, 0, iv) == 0) { inv = iv; id.inverted = iv == 1; id.active = true; missed = 0; superframe(); keepVoice(0); return }
        }
    }

    private fun newCall() {
        msg = arrayOf("", "", "", ""); msgSeen = 0; slowHdr.clear(); lines.reset(); fast.reset(); simple.reset(); pend.clear()
        id.message = ""; id.position = null; id.positionText = ""; id.dprsCrcOk = false; id.frames = 0
        id.csql = null; id.fastBytes = 0; id.image = null; id.icomMessage = null; id.icomPicture = null
    }
    private fun superframe() { flushVoice(); cnt = 0; half = null; slowHdr.clear(); vbuf.fill(null) }

    /** The voice frame that ends 24 bits before the newest bit: the one before data frame [k]. */
    private fun keepVoice(k: Int) {
        val H = hist.size
        vbuf[k] = IntArray(72) { (hist[(hp - 96 + it + H) % H] xor inv) and 1 }; vAt[k] = (bits - 96).toDouble(); pend.add(k)
    }
    private fun flushVoice() {
        for (k in pend) { val v = vbuf[k] ?: continue; onVoiceFrame(HamVoiceFrame("dstar", "ambe-dstar", v, vAt[k], 0)) }
        pend.clear()
    }

    private fun dataFrame(k: Int) {
        id.frames++
        val b = IntArray(24); val H = hist.size
        for (i in 0 until 24) b[i] = (((hist[(hp - 24 + i + H) % H] xor inv) and 1) xor PN[i])
        val by = Fec.packLsb(b, 0, 3)
        if (k % 2 == 1) { half = by; return }
        val h = half
        if (h == null) { flushVoice(); return }
        half = null
        // fast data: block 1 reads voice frames 2, 3 and 1, the others the two of their own data frames
        val idx = if (k == 2) listOf(1, 2, 0) else listOf(k - 1, k)
        val vs = idx.map { vbuf[it] }
        val fd = if (vs.all { it != null }) fastDataBlock(h, by, vs.map { it!! }) else null
        if (fd != null) {
            pend.removeAll { it in idx }
            fast.push(fd); id.fastBytes += fd.size; id.image = fast.image(); icom()
        } else block(intArrayOf(h[0], h[1], h[2], by[0], by[1], by[2]))
        flushVoice()
    }

    private fun block(b: IntArray) {
        val type = b[0] shr 4; val n = b[0] and 15
        if (type == 4 && n < 4) {
            val sb = StringBuilder(); for (i in 1 until 6) sb.append(if (b[i] in 32..126) b[i].toChar() else ' ')
            msg[n] = sb.toString(); msgSeen = msgSeen or (1 shl n)
            if (msgSeen == 15) id.message = msg.joinToString("").trim()
        } else if (type == 3 && n >= 1) {
            val sb = StringBuilder(); for (i in 1..minOf(5, n)) sb.append(b[i].toChar())
            simple.push(b.copyOfRange(1, 1 + minOf(5, n))); icom()
            for (line in lines.push(sb.toString())) line(line)
        } else if (type == 12 && n == 2) {
            id.csql = csqlOf(b[1], b[2])
        } else if (type == 5 && n >= 1) {
            for (i in 1..minOf(5, n)) slowHdr.add(b[i])
            if (slowHdr.size >= 41) {
                val h = parseHeaderBytes(slowHdr.subList(slowHdr.size - 41, slowHdr.size).toIntArray())
                slowHdr.clear()
                if (h.crcOk) {
                    val cur = id.header
                    val changed = cur == null || cur.my != h.my || cur.rpt1 != h.rpt1
                    if (changed) { id.header = h; id.headerFrom = "slow data"; id.headers++; onHeader(h, "slow data") }
                }
            }
        }
    }

    /** Icom's records, from the fast data or else the simple data. */
    private fun icom() {
        val f = icomRecords(fast.bytes()); val s = icomRecords(simple.bytes())
        id.icomMessage = f.msg ?: s.msg; id.icomPicture = f.pic ?: s.pic
    }

    private fun line(line: String) {
        val p = parsePositionLine(line) ?: return
        if (line.startsWith("\$\$CRC")) {
            val c = line.indexOf(','); val want = line.substring(5, minOf(9, line.length)).toIntOrNull(16) ?: return
            val body = line.substring(c + 1) + "\r"
            val bytes = IntArray(body.length) { body[it].code and 255 }
            if (Fec.crc16Lsb(bytes, bytes.size) != want) return
            id.dprsCrcOk = true; p.source = "d-prs"
        }
        id.position = p; id.positionText = line
    }
}
