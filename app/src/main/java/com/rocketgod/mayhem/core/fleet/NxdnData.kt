package com.rocketgod.mayhem.core.fleet

import com.rocketgod.mayhem.core.hamid.Position
import com.rocketgod.mayhem.core.hamid.parseNmea
import kotlin.math.abs
import kotlin.math.max

/**
 * NXDN data calls and the Kenwood talker alias (NXDN TS 1-A v1.3), on top of Nxdn.kt: the UDCH and FACCH2, the data
 * call header and its DCALL_UDT frames, NMEA and Kenwood's $PKNSH, short messages, STAT_REQ, the alias. The same as the
 * web's dsp/fleet/nxdndata.ts (the layouts are described there).
 */
fun nxdnCrc15(bits: IntArray, n: Int): Int = nxdnCrc(bits, n, 15, 0x4cc5)
private val UDCH_KEEP = intArrayOf(1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1)
private fun udField(b: IntArray, at: Int, n: Int): Int { var v = 0; for (k in 0 until n) v = v * 2 + b[at + k]; return v }
/** UDCH or FACCH2: 348 soft values (positive for a 0) to the 184 bits of SR and layer 3, null when the CRC fails. */
fun nxdnUdchSoft(soft: FloatArray): IntArray? {
    val d = nxdnDecodeChannel(soft, 29, 12, UDCH_KEEP, 203)
    return if (nxdnCrc15(d, 184) == udField(d, 184, 15)) d.copyOfRange(0, 184) else null
}
fun nxdnUdch(rx: IntArray): IntArray? = nxdnUdchSoft(FloatArray(rx.size) { if (rx[it] != 0) -1f else 1f })
/** The other way, for the tests: 23 octets (SR first) to the 348 coded bits as sent. */
fun nxdnUdchEncode(o: IntArray): IntArray {
    val info = IntArray(203)
    for (i in 0 until 184) info[i] = (o[i shr 3] shr (7 - (i and 7))) and 1
    val c = nxdnCrc15(info, 184); for (i in 0 until 15) info[184 + i] = (c shr (14 - i)) and 1
    fun at(k: Int) = if (k >= 0) info[k] else 0
    val coded = ArrayList<Int>()
    for (k in 0 until 203) { coded.add(at(k) xor at(k - 3) xor at(k - 4)); coded.add(at(k) xor at(k - 1) xor at(k - 2) xor at(k - 4)) }
    val p = coded.filterIndexed { i, _ -> UDCH_KEEP[i % 14] != 0 }; val out = IntArray(348)
    var j = 0; for (c2 in 0 until 12) for (r in 0 until 29) out[j++] = p[r * 12 + c2]
    return out
}

class NxdnDataHeader(val type: Int, val callType: Int, val src: Int, val dst: Int, val cipher: Int, val keyId: Int, val confirmed: Boolean, val frames: Int, val pad: Int)
/** DCALL_HDR or SDCALL_REQ from its octets. */
fun nxdnDataHeader(o: IntArray): NxdnDataHeader {
    val pi = (o[8] shl 8) or o[9]
    return NxdnDataHeader(o[0] and 0x3f, o[2] shr 5, (o[3] shl 8) or o[4], (o[5] shl 8) or o[6], o[7] shr 6, o[7] and 0x3f, (pi and 0x8000) != 0, ((pi shr 10) and 15) + 1, (pi shr 5) and 31)
}

private fun kdm(v: String, hemi: String, deg: Int): Double {
    if (!Regex("^\\d{${deg + 2}}(\\.\\d+)?$").matches(v)) return Double.NaN
    val x = v.substring(0, deg).toInt() + v.substring(deg).toDouble() / 60
    return if (hemi == "S" || hemi == "W") -x else if (hemi == "N" || hemi == "E") x else Double.NaN
}
/** Kenwood's $PKNSH (latitude, N/S, longitude, E/W, time, status, ...), its checksum checked; or any NMEA position. */
fun kenwoodPosition(line: String): Position? {
    val s = line.trim()
    if (!s.startsWith("\$PKNSH,")) return parseNmea(s)
    val star = s.lastIndexOf('*'); if (star < 0 || star + 3 > s.length) return null
    var x = 0; for (i in 1 until star) x = x xor s[i].code
    if (s.substring(star + 1, star + 3).toIntOrNull(16) != x) return null
    val f = s.substring(1, star).split(',')
    if (f.size < 5 || (f.size >= 7 && f[6].isNotEmpty() && f[6] != "A")) return null
    val lat = kdm(f[1], f[2], 2); val lon = kdm(f[3], f[4], 3)
    if (!lat.isFinite() || !lon.isFinite() || abs(lat) > 90 || abs(lon) > 180 || (lat == 0.0 && lon == 0.0)) return null
    return Position(lat, lon, "kenwood")
}
/** The printable runs of 4 or more characters in some bytes, joined. */
private fun textRuns(b: IntArray): String {
    val s = StringBuilder(); val run = StringBuilder()
    for (i in 0..b.size) {
        val c = if (i < b.size) b[i] else 0
        if ((c in 0x20..0x7e) || c == 10 || c == 13) run.append(c.toChar())
        else { if (run.trim().length >= 4) { if (s.isNotEmpty()) s.append(' '); s.append(run) }; run.setLength(0) }
    }
    return s.toString().trim()
}
private fun ndHex(b: IntArray) = b.joinToString("") { "%02X".format(it and 255) }

/**
 * One channel's data calls, statuses and aliases: fed every layer 3 message the framer reads (in order), it hands back
 * what a unit sent once it is whole.
 */
class NxdnDataReader {
    private var hdr: NxdnDataHeader? = null; private val parts = HashMap<Int, IntArray>()
    private var talker = 0; private var alias = arrayOfNulls<String>(0); private var aliasDone = ""
    fun reset() { hdr = null; parts.clear(); talker = 0; alias = arrayOfNulls(0); aliasDone = "" }
    /** A message's octets (its type in octet 0). */
    fun push(o: IntArray): List<UnitData> {
        val type = o[0] and 0x3f; val out = ArrayList<UnitData>()
        val h = hdr
        if (type == 0x01) { val src = (o[3] shl 8) or o[4]; if (src != talker) { talker = src; alias = arrayOfNulls(0); aliasDone = "" } }
        else if (type == 0x09 || type == 0x38) { hdr = nxdnDataHeader(o); parts.clear() }
        else if (type == 0x0b && h != null) {
            parts[o[1] shr 4] = o.copyOfRange(2, 22)
            if (parts.size >= h.frames) done()?.let { out.add(it) }
        } else if (type == 0x32 || type == 0x33) {
            val src = (o[3] shl 8) or o[4]; val dst = (o[5] shl 8) or o[6]; val status = o[7]; val name = if (type == 0x32) "STAT_REQ" else "STAT_RESP"
            out.add(UnitData("NXDN", src, "status", name, "$name · UNIT $src → $dst · STATUS $status", ndHex(o)).also { it.status = status })
        } else if (type == 0x3f && o[1] == 0x68 && o[2] == 0x82 && talker != 0) {
            val blk = o[3] shr 4; val of = o[3] and 15
            if (blk in 1..of) {
                if (of != alias.size) alias = arrayOfNulls(of)
                alias[blk - 1] = o.copyOfRange(4, o.size).filter { it in 0x20..0x7e }.map { it.toChar() }.joinToString("")
                val name = if (alias.all { it != null }) alias.joinToString("").trim() else ""
                if (name.isNotEmpty() && name != aliasDone) {
                    aliasDone = name
                    out.add(UnitData("NXDN", talker, "alias", "TALKER ALIAS", "TALKER ALIAS · UNIT $talker · \"$name\"", ndHex(o)).also { it.alias = name })
                }
            }
        }
        return out
    }
    /** The data call put together: its position or its text. */
    private fun done(): UnitData? {
        val h = hdr!!; hdr = null
        val all = ArrayList<Int>(); for (i in 0 until h.frames) { val p = parts[i] ?: return null; for (x in p) all.add(x) }
        parts.clear()
        val a = all.toIntArray(); val n = max(0, a.size - 4)
        val crc = (a[n].toLong() shl 24) or (a[n + 1].toLong() shl 16) or (a[n + 2].toLong() shl 8) or a[n + 3].toLong()
        val crcOk = P25Data.crc32(a, n) == crc; val data = a.copyOfRange(0, max(0, n - h.pad))
        val name = if (h.type == 0x38) "SHORT DATA" else "DATA CALL"; val who = "UNIT ${h.src} → ${if (h.callType < 2) "TG" else "UNIT"} ${h.dst}"
        val d = UnitData("NXDN", h.src, "data", name, "", ndHex(data))
        if (h.cipher != 0) { d.encrypted = true; d.line = "$name · $who · ENCRYPTED · KEY ${h.keyId}"; return d }
        val text = textRuns(data)
        for (s in text.split(Regex("\\s*(?=\\$)|[\r\n]+"))) { val p = if (s.startsWith("$")) kenwoodPosition(s) else null; if (p != null) { d.position = p; d.kind = "GPS"; break } }
        if (d.position == null && text.isNotEmpty()) { d.message = text; d.kind = "message" }
        d.line = "$name · $who" + (d.position?.let { " · GPS ${posText(it)}" } ?: d.message?.let { " · \"$it\"" } ?: "") + if (crcOk) "" else " · CRC failed"
        return d
    }
}
