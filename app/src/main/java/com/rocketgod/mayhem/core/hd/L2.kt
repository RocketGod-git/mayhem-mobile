package com.rocketgod.mayhem.core.hd

/**
 * NRSC-5 Layer 2 and the transports above it:
 *  - the L2 PDU and its PCI codeword (SY_IDD_1014s, Tables 5-6 and 5-7);
 *  - audio transport PDUs, their locators, header expansions and PSD field (SY_IDD_1017s 5.2);
 *  - the fixed data bearer: streams, CCC and sync channel (SY_IDD_1019s 7.5, Figure 7-2);
 *  - HDLC framing with the RFC 1662 FCS-16 (SY_IDD_1019s 6.2, SY_IDD_1085s 5.1), AAS packets (Table 6-1);
 *  - ID3 v2.3 PSD tags (SY_IDD_1028s).
 * Settled on recordings: the descrambled L1 bits are reversed inside each 8-bit group to give the L2 bit numbering
 * (L2 bytes are formed least significant bit first from the L1 stream); block boundary markers (7D 3A E2 42) appear in
 * fixed streams even without FEC and are removed before HDLC un-escaping.
 * Bits are ByteArrays of 0 and 1; byte data is IntArrays of 0..255.
 */
object HdL2 {
    /** Table 5-6: the eight L2 PCI codewords. */
    val PCI_CW = intArrayOf(0x38D8D3, 0xCE3634, 0xE3634C, 0x8D8D33, 0x3634CE, 0x8D338D, 0xD8D338, 0x634CE3)
    val PCI_CONTENT = listOf("audio", "audio + opportunistic data", "audio + fixed data", "audio + fixed + opportunistic data", "fixed data only", "reserved", "reserved", "reserved")
    internal val BBM = intArrayOf(0x7D, 0x3A, 0xE2, 0x42)

    data class Spread(val start: Int, val offset: Int, val len: Int)
    /** Table 5-7: where the PCI bits are spread through an L2 PDU of L bits. */
    fun headerSpread(L: Int): Spread {
        val m = L % 8; val len = if (m == 0) 24 else if (m == 7) 23 else 22
        if (L < 72_000) return Spread(120, 8 * ((L - 120 + 7) / 8 / len) - 1, len)
        return Spread(8 * ((L - 30_000 + 7) / 8), if (len == 24) 1247 else if (len == 23) 1303 else 1359, len)
    }

    /** Reverse the bit order inside every whole 8-bit group. */
    fun l1ToL2(bits: ByteArray): ByteArray {
        val out = bits.copyOf(); val n = bits.size - bits.size % 8
        var i = 0
        while (i < n) { for (j in 0 until 8) out[i + j] = bits[i + 7 - j]; i += 8 }
        return out
    }

    class Pdu(val pci: Int, val pciErrors: Int, val bytes: IntArray)
    /** Descrambled P1 transfer frame bits to the PCI and payload bytes (packed most significant bit first). */
    fun pduFromFrame(l1: ByteArray): Pdu {
        val b = l1ToL2(l1); val L = b.size; val (start, offset, len) = headerSpread(L)
        var h = 0
        val skip = BooleanArray(L)
        for (i in 0 until len) { val p = start + i * (offset + 1); skip[p] = true; h = (h shl 1) or b[p].toInt() }
        var pci = 0; var err = 99
        for (k in 0 until 8) { val d = Integer.bitCount(h xor (PCI_CW[k] ushr (24 - len))); if (d < err) { err = d; pci = k } }
        val bytes = IntArray((L - len) / 8)
        var o = 0; var acc = 0; var nb = 0
        var i = 0
        while (i < L && o < bytes.size) {
            if (!skip[i]) { acc = (acc shl 1) or b[i].toInt(); if (++nb == 8) { bytes[o++] = acc; acc = 0; nb = 0 } }
            i++
        }
        return Pdu(pci, err, bytes)
    }

    /** The inverse of [pduFromFrame] (round-trip checks and the synthetic transmitter). */
    fun frameFromPdu(bytes: IntArray, L: Int, pci: Int): ByteArray {
        val (start, offset, len) = headerSpread(L)
        val b = ByteArray(L); val pos = BooleanArray(L); val cw = PCI_CW[pci] ushr (24 - len)
        for (i in 0 until len) { val p = start + i * (offset + 1); pos[p] = true; b[p] = ((cw shr (len - 1 - i)) and 1).toByte() }
        var q = 0
        for (i in 0 until L) { if (pos[i]) continue; val by = q shr 3; b[i] = (if (by < bytes.size) (bytes[by] shr (7 - (q and 7))) and 1 else 0).toByte(); q++ }
        return l1ToL2(b)
    }

    class AudioPdu(val off: Int, val end: Int, val codecMode: Int, val streamId: Int, val pduSeq: Int, val blend: Int, val latency: Int,
                   val nop: Int, val la: Int, val locators: IntArray, val hdrExp: IntArray, val program: Int, val progType: Int?, val access: Int, val psd: IntArray)
    /** One audio transport PDU at byte [off] (1017s Figure 5-2, Table 5-1), or null. */
    fun parseAudioPdu(by: IntArray, off: Int): AudioPdu? {
        if (off + 14 > by.size) return null
        val h = off + 8                                            // the eight RS parity bytes come first
        val codecMode = by[h] and 15; val streamId = (by[h] shr 4) and 3; val pduSeq = ((by[h] shr 6) and 3) or ((by[h + 1] and 1) shl 2)
        val blend = (by[h + 1] shr 1) and 3; val latency = ((by[h + 2] shr 6) and 3) or ((by[h + 3] and 1) shl 2)
        val nop = (by[h + 4] shr 1) and 0x3F; var hef = by[h + 4] shr 7; val la = by[h + 5]
        if (codecMode == 15 || nop == 0) return null
        val lc16 = codecMode == 0 || (streamId == 1 && codecMode in 1..3)
        var p = off + 14
        val locators = IntArray(nop)
        if (lc16) {
            if (p + 2 * nop > by.size) return null
            for (i in 0 until nop) locators[i] = by[p + 2 * i] or (by[p + 2 * i + 1] shl 8)
            p += 2 * nop
        } else {
            val nbytes = (nop * 12 + 7) / 8
            if (p + nbytes + 1 > by.size) return null
            for (i in 0 until nop) {
                val j = (i shr 1) * 3
                locators[i] = if (i % 2 == 0) by[p + j] or ((by[p + j + 1] shr 4) shl 8) else (by[p + j + 1] and 15) or (by[p + j + 2] shl 4)
            }
            p += nbytes
        }
        val hdr = ArrayList<Int>()
        while (hef != 0 && p < by.size) { hdr.add(by[p]); hef = by[p] shr 7; p++ }
        var program = 0; var progType: Int? = null; var access = 0
        var i = 0
        while (i < hdr.size) {                                     // 1017s 5.2.1.6
            val x = hdr[i]; val hid = (x shr 4) and 7
            if (hid == 1) { program = (x shr 1) and 7; if (x and 1 != 0) i += 2 }
            else if (hid == 2 && i + 1 < hdr.size) { progType = ((x and 1) shl 7) or (hdr[i + 1] and 0x7F); access = (x shr 3) and 1; i += 1 }
            else if (hid == 3) i += if (x and 8 != 0) 4 else 3
            else if (hid == 4) i += if (x and 8 != 0) 3 else 1
            i++
        }
        val psdEnd = off + la
        val psd = if (psdEnd >= p) by.copyOfRange(p, minOf(by.size, psdEnd + 1).coerceAtLeast(p)) else IntArray(0)
        val end = if (locators.isNotEmpty()) off + locators[locators.size - 1] else -1
        return AudioPdu(off, end, codecMode, streamId, pduSeq, blend, latency, nop, la, locators, hdr.toIntArray(), program, progType, access, psd)
    }

    /** Consecutive audio PDUs from the start of the L2 PDU (MPS, then the SPS), stopping before [limit]. */
    fun parseAudioRegion(by: IntArray, limit: Int): Pair<List<AudioPdu>, Int> {
        val pdus = ArrayList<AudioPdu>()
        var off = 0
        while (off < limit - 14) {
            val d = parseAudioPdu(by, off)
            if (d == null || d.end < 0 || d.end >= limit || d.end <= off) break
            pdus.add(d); off = d.end + 1
        }
        return pdus to off
    }

    /** RFC 1662 FCS-16 (1019s 6.2.4). A frame with its FCS appended leaves 0xF0B8. */
    fun fcs16(data: IntArray, from: Int = 0, to: Int = data.size, init: Int = 0xFFFF): Int {
        var f = init
        for (i in from until to) { f = f xor data[i]; for (k in 0 until 8) f = if (f and 1 != 0) (f ushr 1) xor 0x8408 else f ushr 1 }
        return f
    }

    /** HDLC frame a payload: flag, escaped body with its FCS, flag. */
    fun hdlcWrap(body: IntArray): IntArray {
        val f = fcs16(body) xor 0xFFFF
        val out = ArrayList<Int>(body.size + 8); out.add(0x7E)
        for (x in body + intArrayOf(f and 255, f shr 8)) { if (x == 0x7E || x == 0x7D) { out.add(0x7D); out.add(x xor 0x20) } else out.add(x) }
        out.add(0x7E)
        return out.toIntArray()
    }

    class CccSub(val parity: Int, val interleave: Int, val length: Int)
    class Ccc(val mpl: Int, val subs: List<CccSub>, val raw: String)
    /** A complete CCC message (1019s Table 7-3) in a region: 7E MPL (mode, length) x n FCS. */
    fun parseCcc(region: IntArray, from: Int = 0, to: Int = region.size): Ccc? {
        for (st in from until to) {
            if (region[st] != 0x7E) continue
            var j = st + 1; while (j < to && region[j] == 0x7E) j++
            for (n in 1..4) {
                val raw = ArrayList<Int>(); var esc = false
                var k = j
                while (k < to && raw.size < 1 + 4 * n + 2) {
                    val x = region[k]
                    if (esc) { raw.add(x xor 0x20); esc = false } else if (x == 0x7D) esc = true else raw.add(x)
                    k++
                }
                if (raw.size < 1 + 4 * n + 2) break
                val fcs = raw[1 + 4 * n] or (raw[2 + 4 * n] shl 8)
                if ((fcs16(raw.toIntArray(), 0, 1 + 4 * n) xor 0xFFFF) == fcs) {
                    val subs = (0 until n).map { s -> CccSub(raw[1 + 4 * s], raw[2 + 4 * s], raw[3 + 4 * s] or (raw[4 + 4 * s] shl 8)) }
                    return Ccc(raw[0], subs, raw.subList(0, 1 + 4 * n).joinToString("") { "%02x".format(it) })
                }
            }
        }
        return null
    }

    /** Keeps the fixed bearer's configuration across PDUs and cuts each PDU's fixed sub-channel segments. */
    class FixedTracker {
        var ccc: Ccc? = null; private set
        private var width = -1
        fun split(by: IntArray, audioEnd: Int): Pair<List<IntArray>, Int> {
            val sync = by[by.size - 1]
            var w = -1
            if ((sync shr 4) == (sync and 15)) { val n = sync and 15; w = if (n == 0) 1 else 2 * n }
            val msg = parseCcc(by, maxOf(0, by.size - 32), by.size - 1)
            if (msg != null) ccc = msg
            val c = ccc ?: return emptyList<IntArray>() to by.size
            val total = c.subs.sumOf { it.length }
            if (w < 0) w = if (width >= 0) width else by.size - 1 - total - audioEnd
            width = w
            val start = by.size - 1 - w - total
            if (start < 0) return emptyList<IntArray>() to by.size
            val segs = ArrayList<IntArray>()
            var p = start
            for (s in c.subs) { segs.add(by.copyOfRange(p, minOf(by.size, p + s.length))); p += s.length }
            return segs to start
        }
        /** Where the fixed bearer starts in a PDU of [len] bytes, once known. */
        fun fixedStart(len: Int): Int {
            val c = ccc
            if (c == null || width < 0) return len
            return len - 1 - width - c.subs.sumOf { it.length }
        }
    }

    class Frame(val ok: Boolean, val frame: IntArray)
    /** A byte stream cut into HDLC frames: flags, block boundary markers, escapes, FCS. */
    class HdlcStream(private val stripBbm: Boolean) {
        private var buf = IntArray(4096); private var n = 0
        var bbm = 0; private set
        var good = 0; private set
        var bad = 0; private set
        fun clear() { n = 0 }
        private fun drop(k: Int) { System.arraycopy(buf, k, buf, 0, n - k); n -= k }
        fun feed(data: IntArray, from: Int = 0, to: Int = data.size): List<Frame> {
            val add = to - from
            if (n + add > buf.size) buf = buf.copyOf(maxOf(buf.size * 2, n + add))
            System.arraycopy(data, from, buf, n, add); n += add
            val out = ArrayList<Frame>()
            var scan = 0
            while (true) {
                var i = scan; while (i < n && buf[i] != 0x7E) i++
                if (i >= n) { drop(n.coerceAtMost(scan)); if (n > 70_000) drop(n - 70_000); break }
                var j = i + 1; while (j < n && buf[j] != 0x7E) j++
                if (j >= n) { drop(i); break }
                var fr = buf.copyOfRange(i + 1, j)
                scan = j
                if (fr.isEmpty()) continue
                if (stripBbm) {
                    val kept = ArrayList<Int>(fr.size)
                    var k = 0
                    while (k < fr.size) {
                        if (k + 3 < fr.size && fr[k] == BBM[0] && fr[k + 1] == BBM[1] && fr[k + 2] == BBM[2] && fr[k + 3] == BBM[3]) { bbm++; k += 4; continue }
                        kept.add(fr[k]); k++
                    }
                    if (kept.isEmpty()) continue
                    fr = kept.toIntArray()
                }
                val u = ArrayList<Int>(fr.size); var esc = false
                for (x in fr) { if (esc) { u.add(x xor 0x20); esc = false } else if (x == 0x7D) esc = true else u.add(x) }
                val ua = u.toIntArray()
                val ok = ua.size >= 3 && fcs16(ua) == 0xF0B8
                if (ok) good++ else bad++
                out.add(Frame(ok, ua))
            }
            return out
        }
    }

    class Packet(val dtpf: Int, val port: Int, val seq: Int, val payload: IntArray)
    /** An un-escaped HDLC frame (with its FCS) as an AAS or PSD packet (1019s Table 6-1, 1085s Table 5-2). */
    fun parsePacket(u: IntArray): Packet? {
        if (u.size < 3) return null
        val dtpf = u[0]
        var a = 1; val b = u.size - 2
        if (dtpf == 0x26 && b - a >= 2) a += 2 + u[a]
        if (b - a < 4) return null
        return Packet(dtpf, u[a] or (u[a + 1] shl 8), u[a + 2] or (u[a + 3] shl 8), u.copyOfRange(a + 4, b))
    }

    class Id3Frame(val id: String, val bytes: IntArray, val text: String? = null, val desc: String? = null, val lang: String? = null)
    private fun latin1(b: IntArray, from: Int = 0, to: Int = b.size): String { val sb = StringBuilder(); for (i in from until to) sb.append(b[i].toChar()); return sb.toString() }
    private fun utf16(b: IntArray, from: Int, to: Int): String {
        var le = true; var i = from
        if (to - from >= 2 && b[from] == 0xFE && b[from + 1] == 0xFF) { le = false; i += 2 } else if (to - from >= 2 && b[from] == 0xFF && b[from + 1] == 0xFE) i += 2
        val sb = StringBuilder()
        while (i + 1 < to) { sb.append((if (le) b[i] or (b[i + 1] shl 8) else (b[i] shl 8) or b[i + 1]).toChar()); i += 2 }
        return sb.toString()
    }
    private fun decodeText(enc: Int, b: IntArray, from: Int, to: Int): String {
        val s = when (enc) {
            1, 2 -> utf16(b, from, to)
            3 -> String(ByteArray(to - from) { b[from + it].toByte() }, Charsets.UTF_8)
            else -> latin1(b, from, to)
        }
        return s.trimEnd('\u0000')
    }
    /** ID3 v2.3 tag frames (the PSD subset of 1028s); null when it is not a tag. */
    fun parseId3(p: IntArray): List<Id3Frame>? {
        if (p.size < 10 || p[0] != 0x49 || p[1] != 0x44 || p[2] != 0x33) return null
        val size = (p[6] shl 21) or (p[7] shl 14) or (p[8] shl 7) or p[9]; val end = minOf(p.size, 10 + size)
        val out = ArrayList<Id3Frame>()
        var q = 10
        while (q + 10 <= end) {
            if (p[q] == 0) break
            val id = latin1(p, q, q + 4); val fsz = ((p[q + 4].toLong() shl 24) or (p[q + 5].toLong() shl 16) or (p[q + 6].toLong() shl 8) or p[q + 7].toLong())
            val bEnd = minOf(end.toLong(), q + 10 + fsz).toInt()
            val body = p.copyOfRange(q + 10, bEnd.coerceAtLeast(q + 10))
            q = (q + 10 + fsz).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
            out.add(when {
                id[0] == 'T' && body.isNotEmpty() -> Id3Frame(id, body, text = decodeText(body[0], body, 1, body.size))
                id == "COMM" && body.size >= 4 -> {
                    val z = (4 until body.size).firstOrNull { body[it] == 0 } ?: -1
                    Id3Frame(id, body, lang = latin1(body, 1, 4), desc = decodeText(body[0], body, 4, if (z >= 0) z else body.size),
                        text = if (z >= 0) decodeText(body[0], body, z + 1, body.size) else "")
                }
                else -> Id3Frame(id, body)
            })
        }
        return out
    }
    /** Build an ID3 v2.3 tag of frames, text given as a String (tests and the demo). */
    fun buildId3(frames: List<Pair<String, Any>>): IntArray {
        val parts = ArrayList<Int>()
        for ((id, v) in frames) {
            val body: List<Int> = if (v is String) listOf(0) + v.map { it.code and 255 } else (v as IntArray).toList()
            parts.addAll(id.map { it.code }); val n = body.size
            parts.addAll(listOf((n ushr 24) and 255, (n shr 16) and 255, (n shr 8) and 255, n and 255, 0, 0)); parts.addAll(body)
        }
        val n = parts.size
        return (listOf(0x49, 0x44, 0x33, 3, 0, 0, (n shr 21) and 127, (n shr 14) and 127, (n shr 7) and 127, n and 127) + parts).toIntArray()
    }
}
