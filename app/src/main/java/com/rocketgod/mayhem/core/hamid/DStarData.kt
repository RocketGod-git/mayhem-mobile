package com.rocketgod.mayhem.core.hamid

/**
 * D-STAR data beyond the slow data (JARL standard): DV Fast Data (chapter 7: ten blocks a superframe, block 1 from data
 * frames 2 and 3 and voice frames 2, 3 and 1, 28 bytes, the others 20; mini-header 8x or 9x, a guard byte, and in each
 * voice frame a 0x02 byte between two halves; the voice frames scrambled, restarted each frame), the JPEG found in that
 * byte stream by its markers (the radios' own picture framing is not published), the code squelch block (Cx: two
 * bytes as sent, the first read as BCD), and DD mode packets (128 kbps: radio header, 2-byte length, Ethernet frame,
 * CRC-32, one scrambler from the header to the CRC; little-endian length and CRC taken). The same as the web's
 * dsp/hamid/dstar-data.ts.
 */
private val PN127: IntArray = run { val o = IntArray(127); var s = 0x7f; for (i in 0 until 127) { val fb = ((s shr 6) xor (s shr 3)) and 1; o[i] = fb; s = ((s shl 1) or fb) and 0x7f }; o }

/** The valid bytes of a fast data block, or null when the mini-header is not a fast data one. */
fun fastDataBlock(a: IntArray, b: IntArray, voices: List<IntArray>): IntArray? {
    val mh = a[0] and 255; val hi = mh shr 4
    if (hi != 8 && hi != 9) return null
    val n = (mh and 15) + (if (hi == 9) 16 else 0)
    val out = arrayListOf(a[1], a[2], b[1], b[2])
    for (v in voices) {
        val bits = IntArray(72) { (v[it] xor PN127[it % 127]) and 1 }
        val by = Fec.packLsb(bits, 0, 9)
        out.addAll(listOf(by[0], by[1], by[2], by[3], by[5], by[6], by[7], by[8]))
    }
    return out.subList(0, minOf(n, out.size)).toIntArray()
}

class DStarImage(val mime: String, val bytes: ByteArray, val complete: Boolean)
class FastDataStream {
    private var buf = ByteArray(4096)
    var n = 0
        private set
    fun reset() { n = 0 }
    /** The bytes so far. */
    fun bytes(): ByteArray = buf.copyOf(n)
    fun push(b: IntArray) {
        if (n + b.size > buf.size) { if (buf.size >= 1 shl 20) return; buf = buf.copyOf(buf.size * 2) }
        for (v in b) buf[n++] = v.toByte()
    }
    fun image(): DStarImage? {
        val b = buf
        var i = 0
        while (i + 2 < n) {
            if (b[i] == 0xff.toByte() && b[i + 1] == 0xd8.toByte() && b[i + 2] == 0xff.toByte()) {
                var j = i + 2
                while (j + 1 < n) { if (b[j] == 0xff.toByte() && b[j + 1] == 0xd9.toByte()) return DStarImage("image/jpeg", b.copyOfRange(i, j + 2), true); j++ }
                return DStarImage("image/jpeg", b.copyOfRange(i, n), false)
            }
            i++
        }
        return null
    }
}

class DStarCsql(val raw: String, val code: Int)
fun csqlOf(b1: Int, b2: Int): DStarCsql {
    val bcd = if ((b1 shr 4) <= 9 && (b1 and 15) <= 9) (b1 shr 4) * 10 + (b1 and 15) else -1
    return DStarCsql("%02X%02X".format(b1 and 255, b2 and 255), bcd)
}

fun crc32(b: IntArray, from: Int = 0, to: Int = b.size): Long {
    var c = 0xffffffffL
    for (i in from until to) { c = c xor (b[i] and 255).toLong(); for (k in 0 until 8) c = if (c and 1L != 0L) (c ushr 1) xor 0xedb88320L else c ushr 1 }
    return c.inv() and 0xffffffffL
}
private fun mac(b: IntArray, at: Int) = (0 until 6).joinToString(":") { "%02x".format(b[at + it] and 255) }

class DdFrame(val dst: String, val src: String, val type: Int, val length: Int, val crcOk: Boolean)
class DdId {
    var header: DStarHeader? = null; val frames = ArrayList<DdFrame>(); var packets = 0; var inverted = false
    fun copy(): DdId = DdId().also { it.header = header; it.frames.addAll(frames); it.packets = packets; it.inverted = inverted }
}
private val DD_FS = intArrayOf(1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0)

/** DD mode packets from a discriminator at [fs] (at least 256 kS/s), or from bits ([pushBit]). */
class DStarDdReceiver(fs: Double = 0.0) {
    var onFrame: (DdFrame, DStarHeader) -> Unit = { _, _ -> }
    val id = DdId()
    private val sym: DiscSymbols? = if (fs > 0) DiscSymbols(fs, 128000.0, false) else null
    private val hist = IntArray(32); private var hp = 0
    private var hdr: IntArray? = null; private var hdrN = 0; private var inv = 0
    private var hdrNow: DStarHeader? = null
    private var data: ArrayList<Int>? = null; private var cur = 0; private var nb = 0; private var pn = 0; private var need = 0
    init { sym?.onSymbol = { pushBit(if (it > 0) 1 else 0) } }
    fun reset() {
        sym?.reset(); hist.fill(0); hp = 0; hdr = null; hdrN = 0; inv = 0; hdrNow = null; data = null
        id.header = null; id.frames.clear(); id.packets = 0; id.inverted = false
    }
    fun push(disc: FloatArray, n: Int) { sym?.push(disc, n) }

    fun pushBit(raw: Int) {
        hist[hp] = raw and 1; hp = (hp + 1) and 31
        val h0 = hdr
        if (h0 != null) {
            h0[hdrN++] = (raw xor inv) and 1
            if (hdrN == 660) {
                val h = decodeHeaderBits(h0); hdr = null
                if (h != null) { hdrNow = h; data = ArrayList(); cur = 0; nb = 0; pn = 660; need = 2; id.inverted = inv == 1 }
            }
            return
        }
        if (data != null) { dataBit((raw xor inv xor PN127[pn++ % 127]) and 1); return }
        for (iv in 0..1) if (syncAt(iv)) { inv = iv; hdr = IntArray(660); hdrN = 0; return }
    }
    private fun syncAt(iv: Int): Boolean {
        var e = 0
        for (i in 0 until 15) if (((hist[(hp - 15 + i + 32) and 31] xor iv) and 1) != DD_FS[i]) e++
        if (e > 1) return false
        var a = 0; var b = 0
        for (i in 0 until 16) { val v = (hist[(hp - 31 + i + 32) and 31] xor iv) and 1; if (v != (i and 1)) a++; if (v != ((i + 1) and 1)) b++ }
        return minOf(a, b) <= 1
    }
    private fun dataBit(bit: Int) {
        cur = cur or (bit shl (nb and 7))
        if ((++nb and 7) != 0) return
        val d = data!!; d.add(cur); cur = 0
        if (d.size == 2) {
            val len = d[0] or (d[1] shl 8)
            if (len < 14 || len > 1600) { data = null; return }
            need = 2 + len + 4
        }
        if (d.size == need) { data = null; packet(d.toIntArray()) }
    }
    private fun packet(d: IntArray) {
        val len = d.size - 6; val at = 2
        val got = (d[at + len].toLong() or (d[at + len + 1].toLong() shl 8) or (d[at + len + 2].toLong() shl 16) or (d[at + len + 3].toLong() shl 24))
        val crcOk = crc32(d, at, at + len) == got || crc32(d, 0, at + len) == got
        val f = DdFrame(mac(d, at), mac(d, at + 6), (d[at + 12] shl 8) or d[at + 13], len, crcOk)
        id.packets++; id.header = hdrNow
        id.frames.add(f); if (id.frames.size > 32) id.frames.removeAt(0)
        onFrame(f, hdrNow!!)
    }
}

/*
 * Icom's own records in the simple data and fast data streams (not in the JARL standard; the layout is from the
 * D-StarBeacon project's notes): "$$Msg,FROM,TO," then six digits and the text, and "$$Pic,FROM,TO," then four
 * characters (quality and size) and one picture block. The blocks' coding is not public: pictures are counted.
 */
data class IcomMessage(val from: String, val to: String, val text: String)
data class IcomPicture(val from: String, val to: String, val code: String, val blocks: Int)
class IcomRecords(val msg: IcomMessage?, val pic: IcomPicture?)
private val ICOM_CALL = Regex("^[A-Z0-9/ -]{3,10}$")

fun icomRecords(b: ByteArray): IcomRecords {
    var msg: IcomMessage? = null; var pic: IcomPicture? = null
    fun u(i: Int) = b[i].toInt() and 255
    fun at(i: Int, s: String): Boolean { for (k in s.indices) if (i + k >= b.size || u(i + k) != s[k].code) return false; return true }
    fun field(i0: Int): Pair<String, Int> { var i = i0; val sb = StringBuilder(); while (i < b.size && u(i) != 0x2c && sb.length < 12) sb.append(u(i++).toChar()); return sb.toString().trim() to i + 1 }
    var i = 0
    while (i + 6 < b.size) {
        val isMsg = at(i, "\$\$Msg,"); val isPic = !isMsg && at(i, "\$\$Pic,")
        if (!isMsg && !isPic) { i++; continue }
        val (f, j) = field(i + 6); val (t, k) = field(j)
        if (!ICOM_CALL.matches(f) || k > b.size) { i++; continue }
        if (isMsg) {
            val sb = StringBuilder(); var p = k + 6
            while (p < b.size && u(p) in 0x20..0x7e) sb.append(u(p++).toChar())
            if (k + 6 <= b.size) msg = IcomMessage(f, t, sb.toString().trim())
        } else {
            val code = StringBuilder(); var p = k; while (p < k + 4 && p < b.size) code.append(u(p++).toChar())
            val was = pic
            pic = if (was != null && was.from == f && was.to == t) IcomPicture(f, t, code.toString(), was.blocks + 1) else IcomPicture(f, t, code.toString(), 1)
        }
        i = k
    }
    return IcomRecords(msg, pic)
}
