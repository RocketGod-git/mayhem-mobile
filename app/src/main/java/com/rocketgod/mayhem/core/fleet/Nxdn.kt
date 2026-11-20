package com.rocketgod.mayhem.core.fleet

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * NXDN, receive only (NXDN TS 1-A Common Air Interface v1.3, TS 1-E Common Air Interface Type-D v1.1).
 *
 *  - 4-level FSK, dibit 01 = +3, 00 = +1, 10 = -1, 11 = -3 (1-A 4.5.3, Figure 4.5-7); NXDN48 at 2400 and NXDN96 at 4800
 *    symbols a second, the frame 384 bits either way (4.4). One frame sync word for every channel: CDF59,
 *    -3 +1 -3 +3 -3 -3 +3 +3 -1 +3 (4.4.4, Table 4.4-2; 1-E 4.4.5).
 *  - Scrambling (4.6): every symbol after the FSW, up to the post field, has its sign inverted where the 9-bit generator
 *    X^9 + X^4 + 1 puts out a 1; register S8..S0 = 0 1 1 1 0 0 1 0 0 at the start of each frame, output S0, S0 fed back to
 *    S8 and added into S3 (Figure 4.6-1; Figure 4.6-2: S0 to S181, the LICH to the end of the frame).
 *  - LICH (4.5.3, 5.2): 7 bits and an even parity bit over the 4 most significant, one bit a symbol (0 = +3, 1 = -3).
 *    RF channel type (bits 6-5): 00 RCCH, 01 RTCH, 10 RDCH (conventional), 11 RTCH_C, or RTCH2 on Type-D (1-E 5.2.1).
 *    Then the functional channel (bits 4-3), the option (bits 2-1) and the direction (bit 0, 1 outbound) (Table 5.2-1).
 *  - Outbound RCCH (4.4.1): FSW 20, LICH 16, CAC 300, E 24, Post 24. CAC (4.5.1.1): SR 8, layer 3 144, null 3, CRC 16,
 *    tail 4; the K = 5 rate 1/2 code G1 = 1 + D^3 + D^4, G2 = 1 + D + D^2 + D^4, punctured by 1111111 / 1011101 to 300
 *    bits; a 25 by 12 interleaver written by rows and read by columns (4.5.4).
 *  - RTCH and RDCH voice (4.4.2): FSW 20, LICH 16, SACCH 60, then four 72-bit VCHs, or a 144-bit FACCH1 in place of
 *    either pair (the steal flags of Table 5.2-1). 9600 bps EFR carries two 144-bit VCHs instead (Figure 4.6-2).
 *  - SACCH (4.5.2.1): SR 8 and 18 layer 3 bits, a 6-bit CRC (X^6 + X^5 + X^2 + X + 1), 4 tail bits, punctured by
 *    111111 / 110110 to 60 bits, a 5 by 12 interleaver. A layer 3 message rides in four of them, the superframe, each
 *    SR's structure field saying which quarter it is (6.3.3, Table 6.3-2).
 *  - FACCH1 (4.5.2.2): 80 bits, a 12-bit CRC (X^12 + X^11 + X^3 + X^2 + X + 1), 4 tail bits, punctured by 11 / 01 to 144,
 *    a 9 by 16 interleaver. Every CRC starts from a register of ones (4.5.5, Figure 4.5-13).
 *  - Type-D (1-E): the same frame, but the 60 bits after the LICH are the SCCH: 25 bits and a 7-bit CRC (X^7 + X^3 + 1),
 *    coded like the SACCH (4.5.1.1). Its structure field names one of four messages, INFO1 to INFO4 (6.3, 6.5).
 *  - VCH: the AMBE+2 vocoder's own frame, 72 bits at EHR (49 voice bits) or 144 at EFR (88), sent in order (7.1).
 *  - Layer 3 (6.2 to 6.5): octet 0 is two flags and the 6-bit message type. A CAC carries one message (single format) or
 *    two of 9 octets each (dual), as its SR's structure bit 0 says (Table 6.3-1).
 */
private val NXDN_FSW = intArrayOf(-3, 1, -3, 3, -3, -3, 3, 3, -1, 3)
/** Symbols in a frame after the FSW (the LICH to the end of the post field or of the last VCH), and in a whole frame. */
private const val NXDN_BODY = 182
private const val NXDN_FRAME = 192
/** The scrambler's output for the symbols after the FSW of a frame (4.6). */
fun nxdnScrambler(n: Int): IntArray {
    var s = intArrayOf(0, 1, 1, 1, 0, 0, 1, 0, 0).reversedArray()   // s[i] = Si
    val out = IntArray(n)
    for (k in 0 until n) {
        val o = s[0]; out[k] = o
        val next = IntArray(9); for (i in 0 until 8) next[i] = s[i + 1]; next[8] = o; next[3] = s[4] xor o
        s = next
    }
    return out
}
private val NXDN_SCR = nxdnScrambler(NXDN_BODY)
/** A CRC of 4.5.5 (Figure 4.5-13) over the first [n] bits: register preset to ones, [poly] without its top term. */
fun nxdnCrc(bits: IntArray, n: Int, width: Int, poly: Int): Int {
    val mask = (1 shl width) - 1; var r = mask
    for (i in 0 until n) { val fb = ((r shr (width - 1)) and 1) xor bits[i]; r = (r shl 1) and mask; if (fb != 0) r = r xor poly }
    return r
}
/** The 16-bit CRC of the CAC (X^16 + X^12 + X^5 + 1). */
fun nxdnCrc16(bits: IntArray, n: Int): Int = nxdnCrc(bits, n, 16, 0x1021)
/** X^6 + X^5 + X^2 + X + 1 (SACCH), X^12 + X^11 + X^3 + X^2 + X + 1 (FACCH1), X^7 + X^3 + 1 (Type-D SCCH). */
fun nxdnCrc6(bits: IntArray, n: Int): Int = nxdnCrc(bits, n, 6, 0x27)
fun nxdnCrc12(bits: IntArray, n: Int): Int = nxdnCrc(bits, n, 12, 0x80f)
fun nxdnCrc7(bits: IntArray, n: Int): Int = nxdnCrc(bits, n, 7, 0x09)
private fun nxField(b: IntArray, at: Int, n: Int): Int { var v = 0; for (k in 0 until n) v = v * 2 + b[at + k]; return v }

private const val NXDN_G1 = 0b11001; private const val NXDN_G2 = 0b10111   // bit j = D^j
/** The two code bits (G1 then G2) for each 5-bit encoder register (bit 0 the newest input). */
private val NXDN_ENC = IntArray(32) { reg ->
    var a = 0; var b = 0
    for (k in 0 until 5) { if (NXDN_G1 and (1 shl k) != 0) a = a xor ((reg shr k) and 1); if (NXDN_G2 and (1 shl k) != 0) b = b xor ((reg shr k) and 1) }
    (a shl 1) or b
}
/**
 * Decodes one coded channel: [soft] is what was received in transmit order, each value positive for a 0 and negative
 * for a 1 (its size the confidence). Undone in turn: the interleaver ([rows] by [cols], written by rows and read by
 * columns), the puncturing ([keep] per period of code bits, 0 where a bit was not sent) and the code (Viterbi, 16 states,
 * [n] bits ending in the zero state).
 */
fun nxdnDecodeChannel(soft: FloatArray, rows: Int, cols: Int, keep: IntArray, n: Int): IntArray {
    val y = FloatArray(rows * cols)
    for (c in 0 until cols) for (r in 0 until rows) y[r * cols + c] = soft[c * rows + r]
    val m = FloatArray(2 * n); var j = 0
    for (i in 0 until 2 * n) m[i] = if (keep[i % keep.size] != 0) y[j++] else 0f
    val ns = 16; val inf = 1e9; var pm = DoubleArray(ns) { inf }; pm[0] = 0.0
    val prev = IntArray(n * ns); val bit = IntArray(n * ns)
    for (k in 0 until n) {
        val np = DoubleArray(ns) { inf }; val a = m[2 * k]; val b = m[2 * k + 1]
        for (st in 0 until ns) {
            if (pm[st] >= inf) continue
            for (u in 0..1) {
                val reg = (st shl 1) or u; val o = NXDN_ENC[reg]; val nx = reg and 15
                val c = pm[st] - (if (o and 2 != 0) -a else a) - (if (o and 1 != 0) -b else b)
                if (c < np[nx]) { np[nx] = c; prev[k * ns + nx] = st; bit[k * ns + nx] = u }
            }
        }
        pm = np
    }
    val d = IntArray(n); var st = 0
    for (k in n - 1 downTo 0) { d[k] = bit[k * ns + st]; st = prev[k * ns + st] }
    return d
}
private val CAC_KEEP = intArrayOf(1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1)
private val SACCH_KEEP = intArrayOf(1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0)
private val FACCH1_KEEP = intArrayOf(1, 0, 1, 1)
private fun hardSoft(rx: IntArray) = FloatArray(rx.size) { if (rx[it] != 0) -1f else 1f }
/** CAC: 300 received bits (after descrambling) to the 152 bits of SR and layer 3, or null when the CRC fails. */
fun nxdnCac(rx: IntArray): IntArray? = nxdnCacSoft(hardSoft(rx))
fun nxdnCacSoft(soft: FloatArray): IntArray? {
    val d = nxdnDecodeChannel(soft, 25, 12, CAC_KEEP, 175)
    return if (nxdnCrc16(d, 155) == nxField(d, 155, 16)) d.copyOfRange(0, 152) else null
}
/**
 * SACCH, or the Type-D SCCH coded the same way: 60 bits to the 36 decoded. [NxdnSacch.sacch] is the 26 bits of SR and
 * layer 3 when the 6-bit CRC holds, [NxdnSacch.scch] the 25 bits of a Type-D SCCH when its 7-bit CRC holds.
 */
class NxdnSacch(val sacch: IntArray?, val scch: IntArray?)
fun nxdnSacch(rx: IntArray): NxdnSacch = nxdnSacchSoft(hardSoft(rx))
fun nxdnSacchSoft(soft: FloatArray): NxdnSacch {
    val d = nxdnDecodeChannel(soft, 5, 12, SACCH_KEEP, 36)
    return NxdnSacch(if (nxdnCrc6(d, 26) == nxField(d, 26, 6)) d.copyOfRange(0, 26) else null, if (nxdnCrc7(d, 25) == nxField(d, 25, 7)) d.copyOfRange(0, 25) else null)
}
/** FACCH1: 144 bits to the 80 of layer 3, or null when the CRC fails. */
fun nxdnFacch1(rx: IntArray): IntArray? = nxdnFacch1Soft(hardSoft(rx))
fun nxdnFacch1Soft(soft: FloatArray): IntArray? {
    val d = nxdnDecodeChannel(soft, 9, 16, FACCH1_KEEP, 96)
    return if (nxdnCrc12(d, 80) == nxField(d, 80, 12)) d.copyOfRange(0, 80) else null
}

// ---------------------------------------------------------------------------------------------------------- layer 3
data class NxdnSite(val category: Int, val system: Int, val site: Int, val cc1: Int, val cc2: Int, val version: Int, val adjacent: Int, val locationId: Int, val service: Int = 0)
val NXDN_CATEGORY = listOf("GLOBAL", "LOCAL", "REGIONAL", "RESERVED")
/** A Location ID (6.5.2): category (00 global, 10 regional, 01 local), system code and site code. */
data class NxdnLoc(val category: Int, val system: Int, val site: Int)
fun nxdnLocation(loc: Int): NxdnLoc? {
    val category = (loc ushr 22) and 3; val sysBits = when (category) { 0 -> 10; 2 -> 14; 1 -> 17; else -> 0 }
    if (sysBits == 0) return null
    val siteBits = 22 - sysBits
    return NxdnLoc(category, (loc ushr siteBits) and ((1 shl sysBits) - 1), loc and ((1 shl siteBits) - 1))
}
/** SITE_INFO (6.4.3.1, Figure 6.4-53) from the layer 3 bits (after SR): Location ID (6.5.2) and the control channels. */
fun nxdnSiteInfo(l3: IntArray): NxdnSite? {
    if (l3.size < 144 || nxField(l3, 2, 6) != 0x18) return null
    val loc = nxField(l3, 8, 24); val id = nxdnLocation(loc) ?: return null
    return NxdnSite(id.category, id.system, id.site, nxField(l3, 8 * 15 + 4, 10), nxField(l3, 8 * 16 + 6, 10), nxField(l3, 8 * 14, 8), nxField(l3, 8 * 15, 4), loc, nxField(l3, 8 * 7, 16))
}
/** Call types (6.5.12). */
val NXDN_CALL_TYPES = listOf("BROADCAST", "CONFERENCE", "UNSPECIFIED", "RESERVED", "INDIVIDUAL", "RESERVED", "INTERCONNECT", "SPEED DIAL")
/** Cipher types (6.5.27). */
val NXDN_CIPHERS = listOf("CLEAR", "SCRAMBLE", "DES", "AES")
/** Message names, on an outbound control channel and on a traffic channel (6.4, Tables 6.4-1 to 6.4-10). */
private val CC_NAMES = mapOf(
    0x01 to "VCALL_RESP", 0x02 to "VCALL_REC_REQ", 0x03 to "VCALL_CONN_RESP", 0x04 to "VCALL_ASSGN", 0x05 to "VCALL_ASSGN_DUP", 0x09 to "DCALL_RESP",
    0x0a to "DCALL_REC_REQ", 0x0d to "DCALL_ASSGN_DUP", 0x0e to "DCALL_ASSGN", 0x10 to "IDLE", 0x11 to "DISC", 0x18 to "SITE_INFO", 0x19 to "SRV_INFO",
    0x1a to "CCH_INFO", 0x1b to "ADJ_SITE_INFO", 0x1c to "FAIL_STAT_INFO", 0x20 to "REG_RESP", 0x22 to "REG_C_RESP", 0x23 to "REG_COMM", 0x24 to "GRP_REG_RESP",
    0x28 to "AUTH_INQ_REQ", 0x30 to "STAT_INQ_REQ", 0x31 to "STAT_INQ_RESP", 0x32 to "STAT_REQ", 0x33 to "STAT_RESP", 0x34 to "REM_CON_REQ", 0x35 to "REM_CON_RESP",
    0x38 to "SDCALL_REQ", 0x39 to "SDCALL_RESP",
)
private val TC_NAMES = mapOf(
    0x01 to "VCALL", 0x02 to "VCALL_REC_REQ", 0x03 to "VCALL_IV", 0x04 to "VCALL_ASSGN", 0x05 to "VCALL_ASSGN_DUP", 0x07 to "TX_REL_EX", 0x08 to "TX_REL",
    0x09 to "DCALL", 0x0b to "DCALL", 0x0c to "DCALL_ACK", 0x0f to "HEAD_DLY", 0x10 to "IDLE", 0x11 to "DISC", 0x19 to "SRV_INFO", 0x1a to "CCH_INFO", 0x1b to "ADJ_SITE_INFO",
    0x1c to "FAIL_STAT_INFO", 0x28 to "AUTH_INQ_REQ", 0x30 to "STAT_INQ_REQ", 0x31 to "STAT_INQ_RESP", 0x32 to "STAT_REQ", 0x33 to "STAT_RESP", 0x34 to "REM_CON_REQ",
    0x35 to "REM_CON_RESP", 0x38 to "SDCALL_REQ", 0x39 to "SDCALL_RESP", 0x3a to "SDCALL_IV",
)
data class NxdnAdj(val category: Int, val system: Int, val site: Int, val num: Int, val ch: Int)
/** CCH_INFO: the Location ID, the flags (8 current, 4 new, 2 added, 1 deleted) and the two channels. */
data class NxdnCch(val category: Int, val system: Int, val site: Int, val flags: Int, val ch1: Int, val ch2: Int)
class NxdnMsg(val type: Int, val name: String, val hex: String) {
    /** Call control (VCALL, VCALL_ASSGN, TX_REL, DISC, ...): call type, group or unit, IDs, emergency, voice call option. */
    var callType: Int? = null; var group = false; var src: Int? = null; var dst: Int? = null; var emergency = false; var voiceOpt: Int? = null
    /** VCALL: cipher type (0 clear, 1 scramble, 2 DES, 3 AES) and key ID. */
    var cipher: Int? = null; var keyId: Int? = null
    /** A channel number (VCALL_ASSGN, DCALL_ASSGN) and the call timer in seconds (0 unspecified). */
    var ch: Int? = null; var timer: Int? = null
    var site: NxdnSite? = null; var adj: List<NxdnAdj>? = null; var cch: NxdnCch? = null
    /** Mobility management (REG_RESP, GRP_REG_RESP, REG_COMM): the unit, its group and the cause. */
    var unit: Int? = null; var gid: Int? = null; var cause: Int? = null
    /** SRV_INFO service flags (6.5.33). */
    var service: Int? = null
    /** Type-D IDs carry a 5-bit home repeater or prefix ahead of an 11-bit ID (1-E 6.6.6, 6.6.7). */
    var typeD = false
}
private fun nxHex(o: IntArray) = o.joinToString("") { "%02X".format(it) }
/** Call Timer (6.5.32): 15 s steps to 180 s, then 30 s steps to 600 s. */
private fun callTimer(v: Int) = if (v == 0) 0 else if (v <= 12) 15 * v else if (v <= 0x1a) 180 + 30 * (v - 12) else -1
private val CALLISH_TC = setOf(0x01, 0x02, 0x04, 0x05, 0x07, 0x08, 0x11)
private val CALLISH_CC = setOf(0x01, 0x02, 0x03, 0x04, 0x05, 0x0d, 0x0e, 0x11)
/**
 * One layer 3 message from its octets. [on] says where it came from: a control channel ("cc") or a traffic channel
 * ("tc"), whose message types overlap. [typeD]: a Type-D FACCH1, whose IDs carry a prefix.
 */
fun nxdnParse(o: IntArray, on: String, typeD: Boolean = false): NxdnMsg {
    val type = o[0] and 0x3f
    val name = (if (on == "cc") CC_NAMES else TC_NAMES)[type] ?: "TYPE %02X".format(type)
    val m = NxdnMsg(type, name, nxHex(o))
    fun u16(i: Int) = (o[i] shl 8) or o[i + 1]
    fun loc(i: Int) = (o[i] shl 16) or (o[i + 1] shl 8) or o[i + 2]
    // CC Option (6.5.11), Call Type (6.5.12), Voice Call Option (6.5.13), Source and Destination (Figure 6.4-1)
    if (type in (if (on == "tc") CALLISH_TC else CALLISH_CC)) {
        m.emergency = (o[1] and 0x80) != 0; m.callType = o[2] shr 5; m.group = (o[2] shr 5) < 2; m.voiceOpt = o[2] and 0x1f; m.src = u16(3); m.dst = u16(5)
        if (typeD) m.typeD = true
    }
    if (on == "tc" && type == 0x01) { m.cipher = o[7] shr 6; m.keyId = o[7] and 0x3f }
    // the assignments: Call Timer (6 bits) then the Channel (10 bits) in octets 7 and 8 (Figure 6.4-31)
    if (!typeD && (type == 0x04 || type == 0x05 || (on == "cc" && (type == 0x0d || type == 0x0e)))) { m.timer = callTimer(o[7] shr 2); m.ch = ((o[7] and 3) shl 8) or o[8] }
    if (type == 0x18 && on == "cc") nxdnLocation(loc(1))?.let { id ->
        m.site = NxdnSite(id.category, id.system, id.site, ((o[15] and 0xf) shl 6) or (o[16] shr 2), ((o[16] and 3) shl 8) or o[17], o[14], o[15] shr 4, loc(1), u16(7))
    }
    if (type == 0x19) m.service = u16(4)
    // CCH_INFO (Figure 6.4-55): Location ID, Curr New Add Del, Control Channel 1 and 2
    if (type == 0x1a) nxdnLocation(loc(1))?.let { id -> m.cch = NxdnCch(id.category, id.system, id.site, o[4] shr 4, ((o[4] and 3) shl 8) or o[5], ((o[6] and 3) shl 8) or o[7]) }
    // ADJ_SITE_INFO (Figure 6.4-56): five octets a site, Location ID, Adjacent Site Option (6 bits) and its channel
    if (type == 0x1b) {
        val adj = ArrayList<NxdnAdj>(); var i = 1
        while (i + 4 < o.size) {
            val l = loc(i); val id = nxdnLocation(l); val ch = ((o[i + 3] and 3) shl 8) or o[i + 4]
            if (l != 0 && id != null && ch != 0) adj.add(NxdnAdj(id.category, id.system, id.site, (o[i + 3] shr 2) and 0xf, ch))
            i += 5
        }
        m.adj = adj
    }
    // REG_RESP and REG_C_RESP (Figure 6.4-45): the Location ID in octets 1 to 3, the unit, its group, the cause
    if (on == "cc" && (type == 0x20 || type == 0x22)) { m.unit = u16(4); m.gid = u16(6); m.cause = o[8] }
    if (on == "cc" && type == 0x23) m.unit = u16(4)
    if (on == "cc" && type == 0x24) { m.unit = u16(2); m.gid = u16(4); m.cause = o[6] }
    return m
}
/** An ID as shown: Type-D's prefix and ID (1-E 6.6.6), else the 16-bit value. */
fun nxdnId(v: Int, typeD: Boolean = false): String = if (typeD) "${v shr 11}-${v and 0x7ff}" else "$v"
/** One message in words, for the log. */
fun nxdnLine(m: NxdnMsg): String {
    val parts = arrayListOf(m.name)
    m.site?.let { s -> parts.addAll(listOf("${NXDN_CATEGORY[s.category]} SYSTEM ${s.system}", "SITE ${s.site}", "control channel ${s.cc1}${if (s.cc2 != 0) " and ${s.cc2}" else ""}", "${s.adjacent} adjacent sites", "version ${s.version}")) }
    val src = m.src; val dst = m.dst
    if (src != null && dst != null) parts.add("${m.callType?.let { NXDN_CALL_TYPES[it] } ?: ""} ${if (m.group) "TG" else "UNIT"} ${nxdnId(dst, m.typeD)} ← ${nxdnId(src, m.typeD)}".trim())
    m.ch?.let { if (it != 0) parts.add("channel $it") }
    m.timer?.let { if (it > 0) parts.add("timer $it s") }
    val vo = m.voiceOpt
    if (vo != null && (m.type == 0x01 || m.type == 0x04 || m.type == 0x05)) parts.add(listOf("4800 EHR", "", "9600 EHR", "9600 EFR").getOrNull(vo and 7)?.ifEmpty { null } ?: "mode ${vo and 7}")
    m.cipher?.let { parts.add(if (it != 0) "${NXDN_CIPHERS[it]} · KEY ${m.keyId}" else "CLEAR") }
    if (m.emergency) parts.add("EMERGENCY")
    m.cch?.let { c -> parts.add("${NXDN_CATEGORY[c.category]} SYSTEM ${c.system} · SITE ${c.site}"); parts.add("${mapOf(8 to "current", 4 to "new", 2 to "added", 1 to "deleted")[c.flags] ?: ""} channel ${c.ch1}${if (c.ch2 != 0 && c.flags == 8) " and ${c.ch2}" else ""}".trim()) }
    m.adj?.forEach { a -> parts.add("site ${a.site} of ${NXDN_CATEGORY[a.category]} ${a.system} on channel ${a.ch}") }
    m.unit?.let { u -> val g = m.gid; val c = m.cause; parts.add("UNIT $u${if (g != null && g != 0 && g != 0xffff) " · TG $g" else ""}${if (c != null) " · ${if (c == 1) "accepted" else "cause %02X".format(c)}" else ""}") }
    m.service?.let { if (m.site == null) parts.add("services %04X".format(it)) }
    return parts.joinToString(" · ")
}
private fun bytesOf(bits: IntArray, at: Int, n: Int) = IntArray(n) { nxField(bits, at + 8 * it, 8) }
/** The messages of a CAC (SR first): one in the single format, two of 9 octets in the dual (Table 6.3-1, Figure 6.2-2). */
fun nxdnCacMessages(cac: IntArray): List<NxdnMsg> {
    val dual = (nxField(cac, 0, 8) and 0x40) != 0
    if (!dual) return listOf(nxdnParse(bytesOf(cac, 8, 18), "cc"))
    return listOf(nxdnParse(bytesOf(cac, 8, 9), "cc"), nxdnParse(bytesOf(cac, 80, 9), "cc"))
}

/** Type-D SCCH outbound messages (1-E 6.5.3), INFO1 to INFO4, from their 25 bits. */
class NxdnScch(val info: Int, val area: Int) {
    /** INFO4 and INFO2 (Figure 6.5-4): the repeater the destination is on (31 ends a transmission), the destination
     *  (prefix and ID) and whether it is a group. Special IDs (Figures 6.5-5 to 6.5-8): idle, halt, free repeaters, site. */
    var kind = ""; var goTo = -1; var dst = -1; var group = false
    var rep1 = -1; var rep2 = -1; var siteType = -1; var siteCode = -1
    /** INFO3 (Figure 6.5-9): the source (prefix and ID). INFO1 (Figure 6.5-10): call option, cipher type and key ID. */
    var src = -1; var callOpt = -1; var cipher = -1; var keyId = -1
}
fun nxdnScch(b: IntArray): NxdnScch {
    val s = NxdnScch(4 - nxField(b, 0, 2), b[2])
    val x = nxField(b, 3, 5); val y = nxField(b, 8, 5); val id = nxField(b, 13, 11)
    if (s.info == 4 || s.info == 2) {
        when (id) {
            2046 -> { s.kind = "idle"; s.rep1 = x; s.rep2 = y }
            2045 -> { s.kind = "halt"; s.rep1 = x; s.rep2 = y }
            2044 -> { s.kind = "free"; s.rep1 = x; s.rep2 = y }
            2041 -> { s.kind = "site"; s.siteType = x shr 3; s.siteCode = ((x and 7) shl 5) or y }
            else -> { s.kind = "busy"; s.goTo = x; s.dst = (y shl 11) or id; s.group = b[24] == 0 }
        }
    } else if (s.info == 3) { s.rep1 = x; s.src = (y shl 11) or id }
    else { s.rep1 = x; s.rep2 = y; s.callOpt = nxField(b, 13, 3); s.cipher = nxField(b, 16, 2); s.keyId = nxField(b, 18, 6) }
    return s
}

// ---------------------------------------------------------------------------------------------------------- framer
/** What one traffic or conventional channel frame carried: the LICH's RF channel type, functional channel, option, direction. */
class NxdnTraffic(val rf: Int, val fn: Int, val opt: Int, val dir: Int) {
    /** The SACCH's radio access number (-1 when it did not come through), and whether this is a Type-D frame (an SCCH). */
    var ran = -1; var typeD = false
    /** The two halves of the VCH area (144 bits each, as sent), null where a FACCH1 took the half or none was sent. */
    val halves = arrayOfNulls<IntArray>(2)
    /** Messages read this frame: a SACCH superframe completed, a FACCH1 that passed its CRC. */
    val msgs = ArrayList<NxdnMsg>()
    /** A Type-D SCCH message. */
    var scch: NxdnScch? = null
}
/** One baud rate's receiver: symbols in (from [SymbolRx]), frames found by their FSW, every kind of channel read. */
class NxdnFramer {
    var onSite: (NxdnSite) -> Unit = {}
    var onFrame: (lich: Int, ok: Boolean) -> Unit = { _, _ -> }
    /** An outbound control channel frame: its SR and messages. */
    var onCac: (sr: Int, msgs: List<NxdnMsg>) -> Unit = { _, _ -> }
    /** A traffic or conventional channel frame. */
    var onTraffic: (NxdnTraffic) -> Unit = {}
    class Stats {
        var fsw = 0; var lichOk = 0; var cacOk = 0; var cacBad = 0; var sacchOk = 0; var facchOk = 0; var scchOk = 0; var voice = 0
        override fun toString() = "fsw $fsw lichOk $lichOk cacOk $cacOk cacBad $cacBad sacchOk $sacchOk facchOk $facchOk scchOk $scchOk voice $voice"
    }
    val stats = Stats()
    /** The last frame's worth of symbols, and the frames waiting for their body (every FSW match gets its own look). */
    private val hist = FloatArray(256); private var hp = 0
    private val pending = ArrayDeque<Int>()
    /** The SACCH superframe being put together (four quarters of 18 bits), and its RAN. */
    private var sf = arrayOfNulls<IntArray>(4); private var sfRan = -1
    /** Where the last frame read ended, and the last one that passed a check (a frame's voice counts on that grid). */
    private var lastFrame = -1_000_000_000; private var lastGood = -1_000_000_000
    /**
     * Locked: a check of 12 bits or more passed (a CAC, a FACCH1, a SACCH superframe whole), or three frames in a row on
     * one grid passed their SACCH or SCCH. Until then no voice is handed on: a receiver at the wrong symbol rate finds a
     * frame sync now and then, and a 6-bit CRC passes one time in 64.
     */
    var locked = false; private set
    private var run = 0
    fun push(s: Float) {
        hist[hp and 255] = s; hp++
        if (hp >= 10) {
            var c = 0.0; var a = 0.0
            for (k in 0 until 10) { val x = hist[(hp - 10 + k) and 255]; c += x * NXDN_FSW[k]; a += abs(x) }
            if (a > 15 && c / (3 * a) > 0.85) { stats.fsw++; pending.addLast(hp + NXDN_BODY) }
        }
        while (pending.isNotEmpty() && pending.first() <= hp) {
            val end = pending.removeFirst()
            if (end - lastFrame < NXDN_BODY) continue
            val sym = FloatArray(NXDN_BODY) { val x = hist[(end - NXDN_BODY + it) and 255]; if (NXDN_SCR[it] != 0) -x else x }
            if (frame(sym, end)) lastFrame = end
        }
    }
    /** Soft bits (positive for 0) of symbols [from, from + n). */
    private fun soft(v: FloatArray, from: Int, n: Int): FloatArray {
        val out = FloatArray(2 * n)
        for (k in 0 until n) {
            val x = v[from + k]
            out[2 * k] = (x / 2).coerceIn(-1f, 1f)
            out[2 * k + 1] = ((2 - abs(x)) / 1.5f).coerceIn(-1f, 1f)
        }
        return out
    }
    private fun hard(v: FloatArray, from: Int, n: Int): IntArray {
        val out = IntArray(2 * n)
        for (k in 0 until n) { val x = v[from + k]; out[2 * k] = if (x < 0) 1 else 0; out[2 * k + 1] = if (abs(x) > 2) 1 else 0 }
        return out
    }
    private fun frame(v: FloatArray, end: Int): Boolean {
        // LICH: one bit a symbol
        var lich = 0; for (k in 0 until 8) lich = (lich shl 1) or (if (v[k] < 0) 1 else 0)
        val par = ((lich shr 7) xor (lich shr 6) xor (lich shr 5) xor (lich shr 4)) and 1
        if (par != (lich and 1)) { onFrame(lich shr 1, false); return false }
        stats.lichOk++
        val info = lich shr 1; val rf = info shr 5; val fn = (info shr 3) and 3; val opt = (info shr 1) and 3; val dir = info and 1
        onFrame(info, true)
        if (rf == 0) {
            if (fn != 0 || dir != 1) return false
            val cac = nxdnCacSoft(soft(v, 8, 150))
            if (cac == null) { stats.cacBad++; return false }
            stats.cacOk++; lastGood = end; locked = true
            val msgs = nxdnCacMessages(cac)
            for (m in msgs) m.site?.let { onSite(it) }
            onCac(nxField(cac, 0, 8), msgs)
            return true
        }
        // a traffic channel: the SACCH (or a Type-D SCCH), then the VCHs or FACCH1s
        val t = NxdnTraffic(rf, fn, opt, dir)
        val sc = nxdnSacchSoft(soft(v, 8, 30))
        var good = false
        val scch = sc.scch; val sacch = sc.sacch
        if (rf == 3 && scch != null) { t.typeD = true; t.scch = nxdnScch(scch); stats.scchOk++; good = true }
        else if (sacch != null) {
            stats.sacchOk++; good = true
            val sr = nxField(sacch, 0, 8); val q = 3 - (sr shr 6); t.ran = sr and 0x3f
            // a superframe SACCH (functional channel 10 or 11): four quarters, the head first (Table 6.3-2)
            if (fn == 2 || fn == 3) {
                if (q == 0 || sfRan != t.ran) { sf = arrayOfNulls(4); sfRan = t.ran }
                sf[q] = sacch.copyOfRange(8, 26)
                if (q == 3 && sf.all { it != null }) {
                    val bits = IntArray(72); for (i in 0 until 4) sf[i]!!.copyInto(bits, 18 * i)
                    t.msgs.add(nxdnParse(bytesOf(bits, 0, 9), "tc"))
                    sf = arrayOfNulls(4); locked = true
                }
            }
        }
        // the VCH area and its steal flags (1-A and 1-E Table 5.2-1); the UDCH and FACCH2 of a data frame are not read
        val voiceFn = if (t.typeD) fn == 2 else fn == 2 || fn == 0; val facchOnly = t.typeD && fn == 0
        val grid = end - lastGood
        val onGrid = grid > 0 && grid <= 4 * NXDN_FRAME + 4 && abs(grid - NXDN_FRAME * Math.round(grid.toDouble() / NXDN_FRAME).toInt()) <= 2
        if (voiceFn || facchOnly) {
            for (h in 0..1) {
                val from = 38 + 72 * h
                val stolen = if (facchOnly) h == 0 || opt == 0 else opt == 0 || (if (h == 0) opt == 1 else opt == 2)
                if (stolen) {
                    val f = nxdnFacch1Soft(soft(v, from, 72))
                    if (f != null) { stats.facchOk++; good = true; locked = true; t.msgs.add(nxdnParse(bytesOf(f, 0, 10), "tc", t.typeD)) }
                } else if (!facchOnly) t.halves[h] = hard(v, from, 72)
            }
        }
        // voice in a frame where nothing passed a check counts only on the grid of the frames that did
        if (!good && !onGrid) { run = 0; return false }
        if (good) { run = if (onGrid) run + 1 else 1; lastGood = end; if (run >= 3) locked = true }
        if (!locked) { t.halves[0] = null; t.halves[1] = null }
        stats.voice += t.halves.count { it != null }
        onTraffic(t)
        return true
    }
}
/**
 * A receiver at one baud rate on complex baseband: a low-pass a little wider than the signal (outer deviation plus
 * half the symbol rate, with room for a frequency offset), then the symbol recovery and the framer.
 */
class NxdnRx(val fs: Double, val baud: Int) {
    val framer = NxdnFramer()
    val rx = SymbolRx(fs, baud.toDouble(), 0.5)
    private val h: FloatArray; private val bi: FloatArray; private val bq: FloatArray; private var p = 0
    private var oi = FloatArray(0); private var oq = FloatArray(0)
    /** The first tenth of a second is held to measure the carrier offset (the scrambled levels average out). */
    private var holdI: FloatArray? = FloatArray(1024); private var holdQ = FloatArray(1024); private var holdN = 0
    init {
        rx.onSymbol = { s -> framer.push(s) }
        val fc = (if (baud == 2400) 1050 else 2400) + baud / 2.0 + 800; val n = 2 * (2 * fs / baud).roundToInt() + 1; val m = (n - 1) / 2
        h = FloatArray(n); var sum = 0.0
        for (i in 0 until n) {
            val t = (i - m).toDouble(); val x = 2 * fc / fs; val sinc = if (t == 0.0) x else sin(PI * x * t) / (PI * t)
            h[i] = (sinc * (0.54 - 0.46 * cos(2 * PI * i / (n - 1)))).toFloat(); sum += h[i]
        }
        for (i in 0 until n) h[i] = (h[i] / sum).toFloat()
        bi = FloatArray(2 * n); bq = FloatArray(2 * n)
    }
    fun push(zi: FloatArray, zq: FloatArray, m: Int) {
        if (oi.size < m) { oi = FloatArray(m); oq = FloatArray(m) }
        val n = h.size
        for (k in 0 until m) {
            bi[p] = zi[k]; bi[p + n] = zi[k]; bq[p] = zq[k]; bq[p + n] = zq[k]
            if (++p >= n) p = 0
            var x = 0.0; var y = 0.0; for (j in 0 until n) { x += h[j].toDouble() * bi[p + j]; y += h[j].toDouble() * bq[p + j] }
            oi[k] = x.toFloat(); oq[k] = y.toFloat()
        }
        val hi = holdI
        if (hi == null) { rx.push(oi, oq, m); return }
        var hiArr: FloatArray = hi
        if (holdN + m > hiArr.size) { val sz = maxOf(2 * hiArr.size, holdN + m); hiArr = hiArr.copyOf(sz); holdQ = holdQ.copyOf(sz); holdI = hiArr }
        for (k in 0 until m) { hiArr[holdN] = oi[k]; holdQ[holdN++] = oq[k] }
        if (holdN < fs / 10) return
        var re = 0.0; var im = 0.0
        for (k in 1 until holdN) { re += hiArr[k].toDouble() * hiArr[k - 1] + holdQ[k].toDouble() * holdQ[k - 1]; im += holdQ[k].toDouble() * hiArr[k - 1] - hiArr[k].toDouble() * holdQ[k - 1] }
        rx.setOffset(atan2(im, re) * fs / (2 * PI))
        holdI = null
        rx.push(hiArr, holdQ, holdN)
        holdQ = FloatArray(0)
    }
    /** The end of a recording: the samples still waiting for a whole timing block. */
    fun flush() { rx.flush() }
}

// ---------------------------------------------------------------------------------------------------------- channels
/**
 * Channel number to frequency. TS 1-A gives the channel 10 bits (6.5.31) and no plan: each system sets its own. So the
 * plan is learned from what is heard: pairs of channel number and carrier (a control channel's own number from its
 * SITE_INFO, a grant matched to the voice that follows it). A channel heard is used as heard; channels heard that fit
 * one step and base give the rest; with one heard, the channel spacing of the bandwidth (6.25 kHz for NXDN48, 12.5 kHz
 * for NXDN96) is a guess, used only where a carrier is live.
 */
class NxdnPlan {
    /** Votes per channel for the carrier it is (Hz, to 125 Hz). */
    val votes = LinkedHashMap<Int, LinkedHashMap<Long, Int>>()
    /** The carrier each channel was heard on (two votes and two thirds of them). */
    val heard = LinkedHashMap<Int, Long>()
    var spacing = 6250L
    class Where(val hz: Long, val how: String)
    /** A pair heard: true when it settled (or moved) the channel's carrier. */
    fun vote(ch: Int, hz: Long, weight: Int = 1): Boolean {
        if (ch <= 0) return false
        val k = Math.round(hz / 125.0) * 125; val v = votes.getOrPut(ch) { LinkedHashMap() }
        v[k] = (v[k] ?: 0) + weight
        var best = 0L; var n = 0; var all = 0; for ((f, m) in v) { all += m; if (m > n) { n = m; best = f } }
        if (n >= 2 && n * 3 >= all * 2 && heard[ch] != best) {
            heard.entries.removeIf { it.value == best && it.key != ch }
            heard[ch] = best; return true
        }
        return false
    }
    /** The linear plan the channels heard agree on: step (Hz a channel) and the frequency of channel 0. */
    val linear: Pair<Double, Double>? get() {
        val p = heard.entries.sortedBy { it.key }.map { it.key to it.value }
        if (p.size < 2) return null
        val (c0, f0) = p.first(); val (c1, f1) = p.last(); val step = (f1 - f0).toDouble() / (c1 - c0)
        if (!(abs(step) >= 1000 && abs(step) <= 100_000)) return null
        val base = f0 - c0 * step
        return if (p.all { (c, f) -> abs(base + c * step - f) < 300 }) step to base else null
    }
    /** Where a channel is: "heard" on the air, from the "plan" the channels heard give, or a "guess" from one. */
    fun resolve(ch: Int): Where? {
        if (ch <= 0) return null
        heard[ch]?.let { return Where(it, "heard") }
        linear?.let { (step, base) -> return Where(Math.round(base + ch * step), "plan") }
        if (heard.size == 1) { val (c, f) = heard.entries.first(); return Where(f + (ch - c) * spacing, "guess") }
        return null
    }
}
