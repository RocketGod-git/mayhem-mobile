package com.rocketgod.mayhem.core.fleet

import com.rocketgod.mayhem.core.hamid.Position
import com.rocketgod.mayhem.core.hamid.lipShortReport
import com.rocketgod.mayhem.core.hamid.lrrpReport
import com.rocketgod.mayhem.core.hamid.parseNmea
import com.rocketgod.mayhem.core.hamid.rate34Decode
import com.rocketgod.mayhem.core.hamid.rate34Encode
import kotlin.math.abs
import kotlin.math.max

/**
 * P25 Phase 1 packet data, receive only (TIA-102.BAAA, TIA-102.BAEB SNDCP), and the vendor GPS link control words.
 * The same as the web's dsp/fleet/p25data.ts (the layouts are described there).
 */
class P25PduHeader(
    val confirmed: Boolean, val outbound: Boolean, val format: Int, val sap: Int, val mfid: Int, val llid: Int,
    val fmf: Boolean, val blocks: Int, val pad: Int, val ns: Int, val fsn: Int, val dho: Int, val hex: String,
)
class P25Ip(val src: String, val dst: String, val proto: Int, var sport: Int = 0, var dport: Int = 0)
class P25Packet(val header: P25PduHeader, val blocksOk: Int, val crcOk: Boolean, val data: IntArray, name: String) :
    UnitData("P25", header.llid, "packet data", name, "", Codes.hex(data).uppercase()) {
    var ip: P25Ip? = null
}
class P25Block34(val serial: Int, val data: IntArray, val ok: Boolean)

val P25_SAP = mapOf(
    0 to "USER DATA", 1 to "ENCRYPTED USER DATA", 2 to "CIRCUIT DATA", 3 to "CIRCUIT DATA CONTROL", 4 to "PACKET DATA", 5 to "ARP",
    6 to "SNDCP CONTROL", 31 to "EXTENDED ADDRESS", 32 to "REGISTRATION AND AUTHORIZATION", 33 to "CHANNEL REASSIGNMENT",
    34 to "SYSTEM CONFIGURATION", 35 to "LOOPBACK", 36 to "STATISTICS", 37 to "OUT OF SERVICE", 38 to "PAGING", 39 to "CONFIGURATION",
    40 to "KEY MANAGEMENT", 41 to "ENCRYPTED KEY MANAGEMENT", 61 to "TRUNKING CONTROL", 63 to "PROTECTED TRUNKING CONTROL",
)
private val PDU_FORMAT = mapOf(0x03 to "RESPONSE", 0x15 to "UNCONFIRMED DATA", 0x16 to "CONFIRMED DATA", 0x17 to "ALTERNATE TRUNKING")

object P25Data {
    /** The header's 12 octets (its CRC already checked). */
    fun header(b: IntArray) = P25PduHeader(
        (b[0] and 0x40) != 0, (b[0] and 0x20) != 0, b[0] and 0x1f, b[1] and 0x3f, b[2], (b[3] shl 16) or (b[4] shl 8) or b[5],
        (b[6] and 0x80) != 0, b[6] and 0x7f, b[7] and 0x1f, (b[8] shr 4) and 7, b[8] and 0xf, b[9] and 0x3f, Codes.hex(b, 0, 12).uppercase(),
    )

    // -------------------------------------------------------------------------------------------- CRCs
    /** CRC-9 of a confirmed block: the 7-bit serial, then the 16 data octets. */
    fun crc9(serial: Int, data: IntArray): Int {
        var r = 0
        fun bit(x: Int) { val fb = ((r shr 8) and 1) xor x; r = (r shl 1) and 0x1ff; if (fb != 0) r = r xor 0x059 }
        for (i in 6 downTo 0) bit((serial shr i) and 1)
        for (i in 0 until 16) for (j in 7 downTo 0) bit((data[i] shr j) and 1)
        return r xor 0x1ff
    }
    private val CRC32_T = IntArray(256) { i -> var c = i shl 24; repeat(8) { c = if (c and Int.MIN_VALUE != 0) (c shl 1) xor 0x04c11db7 else c shl 1 }; c }
    /** The packet CRC-32 over the first [n] octets: MSB first, register from zero, the remainder inverted. */
    fun crc32(b: IntArray, n: Int): Long {
        var c = 0
        for (i in 0 until n) c = (c shl 8) xor CRC32_T[((c ushr 24) xor b[i]) and 0xff]
        return c.inv().toLong() and 0xffffffffL
    }

    // -------------------------------------------------------------------------------------------- blocks
    private fun toBits(d: IntArray) = IntArray(196) { if (it and 1 == 0) (d[it shr 1] shr 1) and 1 else d[it shr 1] and 1 }
    private fun toDibits(r: IntArray) = IntArray(98) { (r[2 * it] shl 1) or r[2 * it + 1] }
    /** A confirmed block's 98 dibits: serial, CRC-9 and 16 data octets. */
    fun block34(d: IntArray): P25Block34 {
        val b = rate34Decode(toBits(d)).bytes; val serial = b[0] shr 1; val crc = ((b[0] and 1) shl 8) or b[1]; val data = b.copyOfRange(2, 18)
        return P25Block34(serial, data, crc9(serial, data) == crc)
    }

    /** The packet in a header and its blocks (confirmed blocks put in serial order). */
    fun packet(h: P25PduHeader, blocks: List<P25Block34>): P25Packet {
        val per = if (h.confirmed) 16 else 12; val all = IntArray(per * blocks.size)
        val order = if (h.confirmed) blocks.sortedBy { it.serial } else blocks
        order.forEachIndexed { i, b -> b.data.copyInto(all, per * i) }
        val n = max(0, all.size - 4)
        val crc = if (all.size >= 4) (all[n].toLong() shl 24) or (all[n + 1].toLong() shl 16) or (all[n + 2].toLong() shl 8) or all[n + 3].toLong() else -1L
        val crcOk = blocks.isNotEmpty() && crc32(all, n) == crc
        val data = all.copyOfRange(0, max(0, n - h.pad))
        val p = P25Packet(h, blocks.count { it.ok }, crcOk, data, PDU_FORMAT[h.format] ?: "DATA")
        p.encrypted = h.sap == 1
        if (crcOk && h.sap == 4) readIp(p)
        p.line = line(p)
        return p
    }
    private fun ipText(b: IntArray, i: Int) = "${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}"
    /** An IPv4 header with a good checksum at [at]: its header length and the datagram's. */
    private fun ipv4At(b: IntArray, at: Int): Pair<Int, Int>? {
        if (b.size < at + 20 || (b[at] shr 4) != 4) return null
        val ihl = (b[at] and 15) * 4; if (ihl < 20 || b.size < at + ihl) return null
        var s = 0; var i = 0; while (i < ihl) { s += (b[at + i] shl 8) or b[at + i + 1]; i += 2 }
        while (s > 0xffff) s = (s and 0xffff) + (s ushr 16)
        return if (s == 0xffff) ihl to minOf(b.size - at, (b[at + 2] shl 8) or b[at + 3]) else null
    }
    /** SNDCP's datagram: at the data header offset, else after SNDCP's two octets, else at the start. */
    private fun readIp(p: P25Packet) {
        val b = p.data
        for (at in intArrayOf(p.header.dho, 2, 0)) {
            val (ihl, len) = ipv4At(b, at) ?: continue
            val ip = b.copyOfRange(at, at + len); val proto = ip[9]
            val x = P25Ip(ipText(ip, 12), ipText(ip, 16), proto); p.ip = x
            if (proto != 17 || ip.size < ihl + 8) return
            val u = ip.copyOfRange(ihl, ip.size); val sport = (u[0] shl 8) or u[1]; val dport = (u[2] shl 8) or u[3]
            val pay = u.copyOfRange(8, minOf(u.size, max(8, (u[4] shl 8) or u[5])))
            x.sport = sport; x.dport = dport
            val lrrp = if (sport == 4001 || dport == 4001) lrrpReport(pay) else null
            if (lrrp != null) { p.position = Position(lrrp.lat, lrrp.lon, lrrp.source); p.heading = lrrp.heading; p.kind = "LRRP"; return }
            val lip = if (dport == 5017) lipShortReport(pay) else null
            if (lip != null) { p.position = Position(lip.lat, lip.lon, lip.source); p.heading = lip.heading; p.kind = "LIP"; return }
            val text = printable(pay)
            if (text.isNotEmpty()) {
                for (s in text.split(Regex("[\r\n]+"))) { val pos = if (s.startsWith("$")) parseNmea(s) else null; if (pos != null) { p.position = pos; p.kind = "NMEA"; return } }
                p.message = text; p.kind = "text"
            }
            return
        }
    }
    /** Bytes as text when they all are (printable ASCII, tabs and line ends), "" otherwise. */
    fun printable(b: IntArray): String {
        val s = StringBuilder()
        for (i in b.indices) { val c = b[i]; if (c == 0 && i == b.size - 1) break; if ((c < 0x20 || c > 0x7e) && c != 9 && c != 10 && c != 13) return ""; s.append(c.toChar()) }
        return s.toString().trim()
    }
    /** One packet in words, for the log. */
    fun line(p: P25Packet): String {
        val h = p.header; val parts = arrayListOf(p.name, P25_SAP[h.sap] ?: "SAP ${h.sap}", "${if (h.outbound) "TO" else "FROM"} UNIT ${h.llid}")
        if (h.mfid != 0) parts.add("MFID %02X".format(h.mfid))
        parts.add("${h.blocks} blocks${if (h.confirmed) " (${p.blocksOk} through their CRC)" else ""}")
        if (!p.crcOk) parts.add("packet CRC failed")
        if (p.encrypted) parts.add("ENCRYPTED")
        p.ip?.let { ip -> parts.add("IP ${ip.src} → ${ip.dst}${if (ip.proto == 17) " · UDP ${ip.sport} → ${ip.dport}" else " · protocol ${ip.proto}"}") }
        p.position?.let { parts.add("${p.kind} ${posText(it, p.heading)}") }
        p.message?.let { parts.add("\"$it\"") }
        return parts.joinToString(" · ")
    }

    // -------------------------------------------------------------------------------------------- GPS link control
    private val GPS_LC = mapOf(0xa4 to "HARRIS", 0x90 to "MOTOROLA")
    /** A vendor GPS link control (its 9 octets), for the talker [unit]; null for any other. */
    fun gpsLc(b: IntArray, unit: Int): UnitData? {
        val vendor = GPS_LC[b[1]] ?: return null
        if ((b[0] and 0x3f) != 0x2a || (b[0] and 0x80) != 0) return null
        fun s24(i: Int): Int { val v = (b[i] shl 16) or (b[i + 1] shl 8) or b[i + 2]; return if (v and 0x800000 != 0) v - 0x1000000 else v }
        val lat = s24(2) * 90.0 / 8388608; val lon = s24(5) * 180.0 / 8388608
        if ((lat == 0.0 && lon == 0.0) || abs(lat) > 90 || abs(lon) > 180) return null
        val pos = Position(lat, lon, "${vendor.lowercase()}-lc")
        return UnitData("P25", unit, "GPS", "$vendor GPS", "$vendor GPS · UNIT ${if (unit != 0) unit.toString() else "?"} · ${posText(pos)}", Codes.hex(b, 0, 9).uppercase()).also { it.position = pos }
    }

    // -------------------------------------------------------------------------------------------- encoders (tests)
    /** A packet's blocks (98 dibits each, the header first). The CRCs, pad and serials are filled in. */
    fun encode(confirmed: Boolean, sap: Int, llid: Int, data: IntArray, outbound: Boolean = false, mfid: Int = 0, dho: Int = 0): List<IntArray> {
        val per = if (confirmed) 16 else 12; val n = max(1, (data.size + 4 + per - 1) / per); val pad = n * per - 4 - data.size
        val all = IntArray(n * per); data.copyInto(all)
        val c = crc32(all, all.size - 4).toInt()
        all[all.size - 4] = c ushr 24; all[all.size - 3] = (c shr 16) and 255; all[all.size - 2] = (c shr 8) and 255; all[all.size - 1] = c and 255
        val h = IntArray(12)
        h[0] = (if (confirmed) 0x40 else 0) or (if (outbound) 0x20 else 0) or (if (confirmed) 0x16 else 0x15); h[1] = 0xc0 or sap; h[2] = mfid
        h[3] = (llid shr 16) and 255; h[4] = (llid shr 8) and 255; h[5] = llid and 255; h[6] = 0x80 or n; h[7] = pad; h[8] = if (confirmed) 0x80 else 0; h[9] = dho
        val hc = Codes.crcCcitt(h, 10); h[10] = hc shr 8; h[11] = hc and 255
        val out = arrayListOf(Codes.tsbkEncode(h))
        for (i in 0 until n) {
            val d = all.copyOfRange(per * i, per * i + per)
            if (!confirmed) { out.add(Codes.tsbkEncode(d)); continue }
            val b = IntArray(18); val crc = crc9(i, d); b[0] = (i shl 1) or (crc shr 8); b[1] = crc and 255; d.copyInto(b, 2)
            out.add(toDibits(rate34Encode(b)))
        }
        return out
    }
    /** One data frame: sync, NID (DUID C), the blocks, the status symbols put in. */
    fun symbols(nac: Int, blocks: List<IntArray>, status: Int = 1): IntArray {
        val info = ArrayList<Int>()
        for (s in Codes.syncSigns(Codes.P25_SYNC)) info.add(if (s > 0) 1 else 3)
        for (d in Codes.nidEncode(nac, 0xc)) info.add(d)
        for (b in blocks) for (d in b) info.add(d)
        val out = ArrayList<Int>(); var k = 0
        while (k < info.size) { if (Codes.isStatusPos(out.size)) out.add(status) else out.add(info[k++]) }
        while (out.size % 36 != 0 && !Codes.isStatusPos(out.size)) out.add(0)
        if (Codes.isStatusPos(out.size)) out.add(status)
        return out.toIntArray()
    }
}

/**
 * The blocks of one data frame put back into a packet: [push] each block's 98 dibits, the header first; it says when
 * the frame is done (the blocks the header named came, or the header failed its CRC).
 */
class P25PduReader {
    var onPacket: (P25Packet) -> Unit = {}
    private var hdr: P25PduHeader? = null; private val got = ArrayList<P25Block34>()
    fun start() { hdr = null; got.clear() }
    /** One block: true while more are wanted. */
    fun push(d: IntArray): Boolean {
        val h0 = hdr
        if (h0 == null) {
            val b = Codes.tsbkDecode(d).bytes
            if (!Codes.crc12Ok(b)) return false
            val h = P25Data.header(b)
            if (h.format != 0x15 && h.format != 0x16) return false
            hdr = h
            return h.blocks != 0
        }
        got.add(if (h0.confirmed) P25Data.block34(d) else P25Block34(got.size, Codes.tsbkDecode(d).bytes, true))
        if (got.size < h0.blocks) return true
        onPacket(P25Data.packet(h0, got.toList()))
        return false
    }
}
