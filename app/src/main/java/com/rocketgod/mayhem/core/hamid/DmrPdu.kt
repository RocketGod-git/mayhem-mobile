package com.rocketgod.mayhem.core.hamid

import com.rocketgod.mayhem.core.fleet.Codes

/**
 * DMR packet data put back together (ETSI TS 102 361-1 V2.6.1: 8.2, 9.2, 9.3, B.2.5, B.3.8 to B.3.10, B.3.12) and read
 * for what it carries: the data header of each format (table 9.30), rate 1/2, 3/4 and 1 blocks, confirmed (serial
 * number and CRC-9) or not, the 32-bit message CRC (octets in swapped pairs, sent least significant octet first; read
 * either way round), a UDT's CRC-CCITT; then LIP (UDP 5017), Motorola LRRP (4001) and TMS text (4007) in IPv4, NMEA
 * sentences, defined short data text (table 9.50) and UDT text (table 9.51). Motorola's TMS is not published: its
 * layout is read from public descriptions of captured traffic. The same as the web's dsp/hamid/dmrpdu.ts.
 */
private fun field(b: IntArray, from: Int, n: Int): Int { var v = 0; for (i in from until from + n) v = v * 2 + ((b[i shr 3] shr (7 - (i and 7))) and 1); return v }
private fun u24(b: IntArray, i: Int) = (b[i] shl 16) or (b[i + 1] shl 8) or b[i + 2]

/** The 196 payload bits of a data burst's dibits (before and after the center field). */
fun dmrPayloadBits(d: IntArray): IntArray {
    val raw = IntArray(196); var p = 0
    for (i in 12..60) { raw[p++] = d[i] shr 1; raw[p++] = d[i] and 1 }
    for (i in 95..143) { raw[p++] = d[i] shr 1; raw[p++] = d[i] and 1 }
    return raw
}
/** Rate 1 coded data (B.2.5): info bits 191 to 96, four pad bits, then 95 to 0. → 24 octets. */
fun rate1Bytes(raw: IntArray): IntArray {
    val o = IntArray(24)
    for (k in 0 until 192) if ((raw[if (k < 96) k else k + 4] and 1) != 0) o[k shr 3] = o[k shr 3] or (0x80 shr (k and 7))
    return o
}

/** The 32-bit message CRC (B.3.9) over [n] octets: in swapped pairs (each word's low octet first), from zero. */
fun dmrCrc32(b: IntArray, n: Int): Long {
    var c = 0L
    for (i in 0 until n) {
        c = c xor (b.getOrElse(i xor 1) { 0 }.toLong() shl 24)
        for (k in 0 until 8) c = if ((c and 0x80000000L) != 0L) ((c shl 1) xor 0x04c11db7L) and 0xffffffffL else (c shl 1) and 0xffffffffL
    }
    return c
}
/** The CRC-9 of a confirmed block (B.3.10): its data octets then the 7-bit serial number, inverted. */
fun dmrCrc9(b: IntArray, from: Int, n: Int, sn: Int): Int {
    var r = 0
    fun bit(x: Int) { val fb = ((r shr 8) and 1) xor x; r = (r shl 1) and 0x1ff; if (fb != 0) r = r xor 0x059 }
    for (i in 0 until 8 * n) bit((b[from + (i shr 3)] shr (7 - (i and 7))) and 1)
    for (i in 6 downTo 0) bit((sn shr i) and 1)
    return r xor 0x1ff
}
/** Table B.21: the CRC-9 mask of a confirmed block, by its size (12, 18 or 24 octets). */
private val CRC9_MASK = mapOf(12 to 0x0f0, 18 to 0x1ff, 24 to 0x10f)

/**
 * A data header: DPF, G/I, A, SAP, LLIDs, the blocks after it (BF, AB, or UAB + 1), the pad (octets, short data's
 * bits, UDT's nibbles), the DD or UDT format, a code (UDT opcode, status/precoded value, response) and the MFID.
 */
class DataHeader(val dpf: Int, val group: Boolean, val ack: Boolean, var sap: Int, val dst: Int, val src: Int, var blocks: Int) {
    var pad = 0; var format = -1; var code = -1; var mfid = -1
}
/** A data header's 12 octets (the CRC already checked), or null for a reserved format. */
fun dataHeader(b: IntArray): DataHeader? {
    val dpf = b[0] and 15
    val h = DataHeader(dpf, (b[0] and 0x80) != 0, (b[0] and 0x40) != 0, b[1] shr 4, u24(b, 2), u24(b, 5), b[8] and 0x7f)
    when (dpf) {
        0 -> { h.format = b[1] and 15; h.pad = b[8] shr 3; h.blocks = (b[8] and 3) + 1; h.code = b[9] and 0x3f }
        1 -> h.code = b[9]
        2, 3 -> h.pad = (b[0] and 0x10) or (b[1] and 15)
        13, 14 -> {
            h.blocks = (b[0] and 0x30) or (b[1] and 15)
            if (dpf == 13) { h.format = b[8] shr 2; h.pad = b[9] }
            else if (h.blocks != 0) h.pad = b[9]
            else h.code = ((b[8] and 3) shl 8) or b[9]
        }
        15 -> { h.sap = b[0] shr 4; h.mfid = b[1]; h.blocks = 0 }
        else -> return null
    }
    return h
}
/** The DPF in words. */
fun dpfName(dpf: Int): String = when (dpf) { 0 -> "UDT"; 1 -> "RESPONSE"; 2 -> "UNCONFIRMED DATA"; 3 -> "CONFIRMED DATA"; 13 -> "DEFINED SHORT DATA"; 14 -> "SHORT DATA"; 15 -> "PROPRIETARY DATA"; else -> "DPF $dpf" }

/** A whole PDU: the user data (pad and CRC off), how many of its bits are data, the CRC checked, octets per block. */
class DmrPdu(val hdr: DataHeader, val data: IntArray, val bits: Int, val crcOk: Boolean, val size: Int)

/** One slot's packet data: a data header opens a PDU, the blocks it announced fill it. */
class DmrPduAssembler {
    private var hdr: DataHeader? = null
    private var blocks = arrayOfNulls<IntArray>(0)
    private var size = 0; private var next = 0

    fun reset() { hdr = null; blocks = arrayOfNulls(0); size = 0; next = 0 }
    val open: Boolean get() = hdr != null

    /** A data header that passed its CRC (mask CCCC). A proprietary second header joins the packet before it. */
    fun header(b: IntArray): DataHeader? {
        val h = dataHeader(b) ?: run { reset(); return null }
        val cur = hdr
        if (h.dpf == 15 && cur != null && cur.sap == 9 && next == 0 && cur.mfid < 0) {
            cur.mfid = h.mfid; cur.blocks = maxOf(0, cur.blocks - 1); blocks = arrayOfNulls(cur.blocks)
            return cur
        }
        reset()
        if (h.dpf == 1 || h.dpf == 15 || (h.dpf == 14 && h.blocks == 0)) return h
        if (h.blocks > 0) { hdr = h; blocks = arrayOfNulls(h.blocks) }
        return h
    }
    /** A data block of 12, 18 or 24 octets; the PDU when this one completes it. */
    fun block(bytes: IntArray): DmrPdu? {
        val h = hdr ?: return null
        val n = bytes.size
        if ((size != 0 && size != n) || (h.dpf == 0 && n != 12)) { reset(); return null }
        size = n
        val b = bytes.copyOf()
        var at = -1
        if (h.dpf == 3) {
            // a confirmed block is placed by its serial number when its CRC-9 checks (a block sent again lands on itself)
            val sn = b[0] shr 1; val c9 = ((b[0] and 1) shl 8) or b[1]
            if ((dmrCrc9(b, 2, n - 2, sn) xor (CRC9_MASK[n] ?: 0)) == c9 && sn < blocks.size) at = sn
        }
        if (at < 0) { while (next < blocks.size && blocks[next] != null) next++; at = next }
        if (at >= blocks.size) { reset(); return null }
        blocks[at] = b
        if (blocks.any { it == null }) return null
        val pdu = assemble(h, blocks.map { it!! }, n)
        reset()
        return pdu
    }
    private fun assemble(h: DataHeader, bl: List<IntArray>, size: Int): DmrPdu {
        val parts = ArrayList<Int>()
        for (x in bl) for (i in (if (h.dpf == 3) 2 else 0) until x.size) parts.add(x[i])
        val p = parts.toIntArray()
        if (h.dpf == 0) {
            val n = p.size - 2; val crc = (p[n] shl 8) or p[n + 1]
            val bits = maxOf(0, 8 * n - 4 * h.pad)
            return DmrPdu(h, p.copyOf((bits + 7) shr 3), bits, Codes.crcCcitt(p, n) == crc, size)
        }
        val n = p.size - 4; val c = dmrCrc32(p, n)
        val le = p[n].toLong() or (p[n + 1].toLong() shl 8) or (p[n + 2].toLong() shl 16) or (p[n + 3].toLong() shl 24)
        val be = (p[n].toLong() shl 24) or (p[n + 1].toLong() shl 16) or (p[n + 2].toLong() shl 8) or p[n + 3].toLong()
        val short = h.dpf == 13 || h.dpf == 14
        val bits = if (short) maxOf(0, 8 * n - h.pad) else 8 * maxOf(0, n - h.pad)
        return DmrPdu(h, p.copyOf((bits + 7) shr 3), bits, le == c || be == c, size)
    }
}

// ------------------------------------------------------------------------------------------------ what it carries
/** What a PDU carries: kind 'position' or 'text', how it came (LIP, LRRP, NMEA, TMS, SHORT DATA, UDT), and from LIP speed, heading, error. */
class DmrPduContent(val kind: String, val via: String, val text: String, val pos: Position?) { var speedKmh = -1.0; var heading = -1.0; var posError = -1 }

private val NMEA_RE = Regex("\\$[A-Z]{2}[A-Z]{3},[^$\\n]*\\*[0-9A-F]{2}")
/** NMEA sentences with good checksums anywhere in a byte payload; the last one with a position. */
fun nmeaInPayload(b: IntArray): Position? {
    val sb = StringBuilder(); for (v in b) { val c = v and 255; sb.append(if (c in 32..126) c.toChar() else '\n') }
    var found: Position? = null
    for (m in NMEA_RE.findAll(sb)) { val p = parseNmea(m.value); if (p != null) { p.source = "dmr-data"; found = p } }
    return found
}

/** Characters to text: controls (line breaks as spaces) and unpaired surrogates dropped, trimmed. */
private fun clean(codes: List<Int>): String {
    val sb = StringBuilder()
    for (c in codes) { if (c == 10 || c == 13 || c == 9) sb.append(' ') else if (c >= 32 && c != 0x7f && (c < 0xd800 || c > 0xdfff) && c < 0x10000) sb.append(c.toChar()) }
    return sb.toString().replace(Regex("\\s+"), " ").trim()
}
private fun latin1(b: IntArray, from: Int, to: Int) = clean((from until to).map { b[it] and 255 })
private fun utf16(b: IntArray, from: Int, to: Int, le: Boolean): String {
    val o = ArrayList<Int>(); var i = from
    while (i + 1 < to) { o.add(if (le) b[i] or (b[i + 1] shl 8) else (b[i] shl 8) or b[i + 1]); i += 2 }
    return clean(o)
}
private fun iso7(b: IntArray, bits: Int): String { val o = ArrayList<Int>(); var i = 0; while (i + 7 <= bits) { o.add(field(b, i, 7)); i += 7 }; return clean(o) }
private fun utf8(b: IntArray, from: Int, to: Int): String {
    val o = ArrayList<Int>(); var i = from
    while (i < to) {
        val x = b[i] and 255; val n = if (x < 0x80) 0 else if (x >= 0xf0) 3 else if (x >= 0xe0) 2 else if (x >= 0xc0) 1 else -1
        if (n < 0 || i + n >= to) { i++; continue }
        var c = if (n != 0) x and (0x3f shr n) else x
        for (k in 1..n) c = (c shl 6) or (b[i + k] and 0x3f)
        o.add(c); i += n + 1
    }
    return clean(o)
}
/** Defined short data's text by its DD format (table 9.50), "" for a format that is not text. */
fun ddText(fmt: Int, b: IntArray, bits: Int): String {
    val n = bits shr 3
    return when (fmt) {
        2 -> iso7(b, bits)
        in 3..17 -> latin1(b, 0, n)
        18 -> utf8(b, 0, n)
        19 -> { val le = b.getOrElse(0) { 0 } == 0xff && b.getOrElse(1) { 0 } == 0xfe; val bom = le || (b.getOrElse(0) { 0 } == 0xfe && b.getOrElse(1) { 0 } == 0xff); utf16(b, if (bom) 2 else 0, n, le) }
        20, 21 -> utf16(b, 0, n, fmt == 21)
        else -> ""
    }
}
/** A UDT's text by its format (table 9.51), "" for a format that is not text. */
fun udtText(fmt: Int, b: IntArray, bits: Int): String {
    val n = bits shr 3
    return when (fmt) { 3 -> iso7(b, bits); 4 -> latin1(b, 0, n); 7 -> utf16(b, 0, n, false); 10 -> utf16(b, 3, n, false); else -> "" }
}
/**
 * Motorola TMS (UDP port 4007): a 2-octet length, a header octet (its 0x20 bit: extension octets follow), an address
 * length and that many octets, the extension octets (each with its top bit set but the last), then UTF-16LE text.
 * "" when there is no text (an acknowledgment).
 */
fun tmsText(u: IntArray): String {
    if (u.size < 4) return ""
    val end = minOf(u.size, 2 + ((u[0] shl 8) or u[1])); val hdr = u[2]
    var i = 4 + u[3]
    if ((hdr and 0x20) != 0) while (i < end) { val x = u[i++]; if ((x and 0x80) == 0) break }
    return if (i < end) utf16(u, i, end, true) else ""
}

/** What a PDU carries. Positions in IP and NMEA carry their own checks; text only when the message CRC checked. */
fun dmrPduContent(p: DmrPdu): DmrPduContent? {
    val h = p.hdr; val d = p.data
    if (h.dpf == 13 && p.crcOk) { val t = ddText(h.format, d, p.bits); if (t.isNotEmpty()) return DmrPduContent("text", "SHORT DATA", t, null) }
    if (h.dpf == 0 && p.crcOk) { val t = udtText(h.format, d, p.bits); if (t.isNotEmpty()) return DmrPduContent("text", "UDT", t, null) }
    val u = udpPayload(d)
    if (u != null) {
        if (u.dport == 5017) {
            val r = lipShortReport(u.data)
            if (r != null) return DmrPduContent("position", "LIP", "", Position(r.lat, r.lon, r.source)).also { it.speedKmh = r.speedKmh; it.heading = r.heading; it.posError = r.posError }
        }
        if (u.dport == 4001 || u.sport == 4001) { val r = lrrpReport(u.data); if (r != null) return DmrPduContent("position", "LRRP", "", Position(r.lat, r.lon, r.source)).also { it.heading = r.heading } }
        if (u.dport == 4007 || u.sport == 4007) { val t = tmsText(u.data); if (t.isNotEmpty()) return DmrPduContent("text", "TMS", t, null) }
    }
    val pos = nmeaInPayload(d) ?: return null
    return DmrPduContent("position", "NMEA", "", pos)
}
