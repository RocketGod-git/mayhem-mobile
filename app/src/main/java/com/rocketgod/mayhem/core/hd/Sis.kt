package com.rocketgod.mayhem.core.hd

/** Station Information Service on the PIDS channel (1020s rev K, section 4); only PDUs whose CRC-12 verifies are voted. */
object HdSis {
    private const val CHARS5 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ ?-*$"
    val SIS_PAYLOAD = intArrayOf(32, 22, 58, 32, 27, 58, 27, 22, 58, 58, 27)

    sealed class Msg(val kind: String) {
        data class Id(val country: String, val facility: Int) : Msg("id")
        data class ShortName(val name: String) : Msg("short")
        data class LongName(val last: Int, val frame: Int, val chars: String, val seq: Int) : Msg("long")
        data class Loc(val high: Boolean, val deg: Double, val alt: Int) : Msg("loc")
        class Smsg(val frame: Int, val seq: Int, val priority: Int?, val encoding: Int?, val length: Int?, val checksum: Int?, val bytes: IntArray) : Msg("smsg")
        data class Svc(val adv: Boolean, val audio: Boolean, val access: Int, val program: Int, val progType: Int, val soundExp: Int, val dataType: Int, val mime12: Int) : Msg("svc")
        data class Param(val index: Int, val value: Int) : Msg("param")
        class Usn(val frame: Int, val encoding: Int?, val append: Int?, val frames: Int?, val bytes: IntArray) : Msg("usn")
        class Slogan(val frame: Int, val encoding: Int?, val length: Int?, val bytes: IntArray) : Msg("slogan")
        class Alert(val frame: Int, val seq: Int, val encoding: Int?, val length: Int?, val crc7: Int?, val cntLength: Int?, val bytes: IntArray) : Msg("alert")
        data class Alfn(val alfn: Long) : Msg("alfn")
        data class Other(val id: Int, val bits: String) : Msg("other")
    }

    class Pdu(val llds: Boolean, val msgs: List<Msg>, val timeLocked: Int, val advAlfn: Int, val crc: Int, val crcOk: Boolean = true, val bits: String = "")

    private fun u(b: ByteArray, a: Int, n: Int): Int { var v = 0; for (i in a until a + n) v = v * 2 + (b[i].toInt() and 1); return v }
    private fun uL(b: ByteArray, a: Int, n: Int): Long { var v = 0L; for (i in a until a + n) v = v * 2 + (b[i].toInt() and 1); return v }
    private fun s(v: Int, n: Int) = if (v >= 1 shl (n - 1)) v - (1 shl n) else v
    private fun bytesAt(b: ByteArray, a: Int, n: Int) = IntArray(n) { u(b, a + 8 * it, 8) }
    private fun bitString(b: ByteArray, n: Int = b.size) = String(CharArray(n) { if (b[it].toInt() and 1 != 0) '1' else '0' })
    private fun rev16(v: Int): Int { var r = 0; for (i in 0 until 16) r = (r shl 1) or ((v shr i) and 1); return r }

    /** The 16-bit register shared by the SIS and alert control CRCs: bits fed in order, then 16 zeros, returned reversed. */
    private fun crcReg(bits: IntArray, initReversed: Int = 0): Int {
        var r = rev16(initReversed)
        fun step(bit: Int) { val top = r and 0x8000; r = ((r shl 1) or bit) and 0xFFFF; if (top != 0) r = r xor 0x080B }
        for (x in bits) step(x and 1)
        repeat(16) { step(0) }
        return rev16(r)
    }
    /** The CRC-12 field a PDU's bits 0..67 need (the synthetic transmitter). */
    fun sisCrc(b: ByteArray): Int = (crcReg(IntArray(68) { b[67 - it].toInt() and 1 }) xor 0x955) and 0xFFF
    /** 1020s 4.11: whether a PDU's CRC-12 verifies. */
    fun sisCrcOk(b: ByteArray): Boolean = b.size >= 80 && sisCrc(b) == u(b, 68, 12)

    fun parseMsg(id: Int, b: ByteArray): Msg = when (id) {
        0 -> { val cc = u(b, 0, 10); Msg.Id(if ((cc shr 5) < 26 && (cc and 31) < 26) "${CHARS5[cc shr 5]}${CHARS5[cc and 31]}" else "#$cc", u(b, 13, 19)) }
        1 -> {
            val sb = StringBuilder()
            for (i in 0 until 4) { val c = u(b, 5 * i, 5); sb.append(if (c < 31) CHARS5[c] else '#') }
            Msg.ShortName(sb.toString().trim() + if (u(b, 20, 2) == 1) "-FM" else "")
        }
        2 -> Msg.LongName(u(b, 0, 3), u(b, 3, 3), String(CharArray(7) { u(b, 6 + 7 * it, 7).toChar() }), u(b, 55, 3))
        // reserved in the documents; on air it is the frame's whole 32-bit ALFN (KLOS: equal to the ADV ALFN pairs)
        3 -> Msg.Alfn(uL(b, 0, 32))
        4 -> Msg.Loc(u(b, 0, 1) == 1, s(u(b, 1, 22), 22) / 8192.0, u(b, 23, 4))
        5 -> {
            val frame = u(b, 0, 5); val seq = u(b, 5, 2)
            if (frame == 0) Msg.Smsg(frame, seq, u(b, 7, 1), u(b, 8, 3), u(b, 11, 8), u(b, 19, 7), bytesAt(b, 26, 4))
            else Msg.Smsg(frame, seq, null, null, null, null, bytesAt(b, 10, 6))
        }
        6, 10 -> {
            val cat = u(b, 0, 2)
            if (cat == 0) Msg.Svc(id == 10, true, u(b, 2, 1), u(b, 3, 6), u(b, 9, 8), u(b, 22, 5), -1, -1)
            else Msg.Svc(id == 10, false, u(b, 2, 1), -1, -1, -1, u(b, 3, 9), u(b, 15, 12))
        }
        7 -> Msg.Param(u(b, 0, 6), u(b, 6, 16))
        8 -> {
            val frame = u(b, 0, 4)
            if (u(b, 4, 1) == 0) { if (frame == 0) Msg.Usn(frame, u(b, 5, 3), u(b, 8, 1), u(b, 9, 1) + 1, bytesAt(b, 10, 6)) else Msg.Usn(frame, null, null, null, bytesAt(b, 10, 6)) }
            else if (frame == 0) Msg.Slogan(frame, u(b, 5, 3), u(b, 11, 7), bytesAt(b, 18, 5)) else Msg.Slogan(frame, null, null, bytesAt(b, 10, 6))
        }
        9 -> {
            val frame = u(b, 0, 6); val seq = u(b, 6, 2)
            if (frame == 0) Msg.Alert(frame, seq, u(b, 10, 3), u(b, 13, 9), u(b, 22, 7), 1 + 2 * u(b, 29, 5), bytesAt(b, 34, 3))
            else Msg.Alert(frame, seq, null, null, null, null, bytesAt(b, 10, 6))
        }
        else -> Msg.Other(id, bitString(b))
    }

    /** One 80-bit SIS PDU in L2 bit order. */
    fun parse(b: ByteArray): Pdu {
        val crcOk = sisCrcOk(b); val bits = bitString(b, minOf(80, b.size))
        if (b[0].toInt() != 0) return Pdu(true, emptyList(), 0, u(b, 66, 2), u(b, 68, 12), crcOk, bits)
        val msgs = ArrayList<Msg>()
        val id1 = u(b, 2, 4); val n1 = SIS_PAYLOAD.getOrElse(id1) { 58 }
        msgs.add(parseMsg(id1, b.copyOfRange(6, minOf(b.size, 6 + n1)).copyOf(n1)))
        if (b[1].toInt() != 0) {
            val p = 6 + n1
            if (p + 4 <= b.size) {
                val id2 = u(b, p, 4); val n2 = SIS_PAYLOAD.getOrElse(id2) { 0 }
                if (n2 > 0 && p + 4 + n2 <= 64) msgs.add(parseMsg(id2, b.copyOfRange(p + 4, p + 4 + n2)))
            }
        }
        return Pdu(false, msgs, b[65].toInt() and 1, u(b, 66, 2), u(b, 68, 12), crcOk, bits)
    }

    /** The alert's CRC-7 (x^7 + x^3 + 1, start 0x42) over its message bytes, last byte first, seven bits each. */
    fun alertCrc7(a: IntArray, len: Int): Int {
        var r = 0x42
        fun step(bit: Int) { r = (r shl 1) or bit; if (r and 0x80 != 0) r = r xor 0x89 }
        for (i in len - 1 downTo 0) for (j in 6 downTo 0) step(((a[i] shr j) and 1) xor (if (j == 0 && i > 0) (a[i - 1] shr 7) and 1 else 0))
        repeat(7) { step(0) }
        return r and 0x7F
    }
    /** The control data's CRC-12: control bytes from the last down to byte 1, low bit first, CRC field as zeros. */
    fun alertCntCrc(c: IntArray, len: Int): Int {
        val fed = ArrayList<Int>()
        for (i in len - 1 downTo 1) for (j in 0 until 8) fed.add(if (i == 1 || (i == 2 && j < 4)) 0 else (c[i] shr j) and 1)
        return crcReg(fed.toIntArray(), 0x7E1B) and 0xFFF
    }

    class AlertControl(val categories: Pair<Int, Int>, val format: Int, val locations: List<Long>)
    /** The alert control data: categories and the area codes (SAME, FIPS or ZIP), fields read low bit first. */
    fun parseAlertControl(c: IntArray, len: Int): AlertControl {
        val bits = IntArray(len * 8) { (c[it / 8] shr (it % 8)) and 1 }
        var o = 0
        fun r(n: Int): Long { var v = 0L; for (i in 0 until n) { v = v or ((bits.getOrElse(o) { 0 }).toLong() shl i); o++ }; return v }
        o += 28
        val c1 = r(5).toInt(); val c2 = r(5).toInt(); o += 9
        val format = r(3).toInt(); val n = r(5).toInt(); o += 1
        val full = if (format == 0) 20 else 17; val short = if (format == 0) 14 else 10
        val locations = ArrayList<Long>()
        var i = 0
        while (i < n && o < bits.size) {
            val isFull = i == 0 || bits[o++] == 1
            if (o + (if (isFull) full else short) > bits.size) break
            if (isFull) locations.add(r(full))
            else { val d = r(short); val prev = locations[i - 1]; locations.add(d / 1000 * 100000 + (d % 1000) + (prev % 100000) - (prev % 1000)) }
            i++
        }
        return AlertControl(c1 to c2, format, locations)
    }
    val ALERT_LOCATION_FORMATS = listOf("SAME", "FIPS", "ZIP")

    /** SIS parameters 4..7 (exciter) or 8..11 (importer): maker, core and maker versions, status. */
    class Device(val maker: String, val core: String, val makerVersion: String, val coreStatus: Int, val makerStatus: Int, val importerConnected: Boolean?)
    fun sisDevice(p: Map<Int, Int>, base: Int): Device? {
        val a = p[base]; val b = p[base + 1]; val c = p[base + 2]; val d = p[base + 3]
        if (a == null && b == null && c == null) return null
        // the four parameters come one per PDU; any not heard yet shows as '?'
        fun ver(x: Int?, y: Int) = if (x == null) "?" else listOf((x shr 11) and 31, (x shr 6) and 31, (x shr 1) and 31).joinToString(".") + "." + (if (d == null) "?" else y.toString())
        fun ch(v: Int) = if (v in 32..126) v.toChar().toString() else "?"
        val dd = d ?: 0
        return Device(if (a == null) "?" else ch((a shr 8) and 0x7F) + ch(a and 0x7F), ver(b, (dd shr 11) and 31), ver(c, (dd shr 6) and 31),
            if (d == null) -1 else (d shr 3) and 7, if (d == null) -1 else d and 7, if (base == 4 && a != null) ((a shr 7) and 1) == 1 else null)
    }
    class Leap(val current: Int, val pending: Int, val pendingAlfn: Long)
    /** SIS parameters 0..2: leap seconds now and pending, and the ALFN the pending count takes effect. */
    fun sisLeap(p: Map<Int, Int>): Leap? {
        val a = p[0] ?: return null; val b = p[1] ?: return null; val c = p[2] ?: return null
        return Leap(a and 0xFF, a shr 8, c.toLong() * 65536 + b)
    }

    /** ALFN from the 16 ADV ALFN pairs of one frame (1020s 5.3.1): blocks 0..7 the low 16 bits, 8..15 the high. */
    fun alfnFromPairs(adv: IntArray): Long {
        var v = 0L
        for (bc in 0 until 16) {
            val hi = if (bc < 8) 30 - 2 * bc else 14 - 2 * (bc - 8)
            v += (adv[bc] and 3).toLong() shl (31 - (hi + 1))
        }
        return v
    }
    /** ALFN to UTC milliseconds: frames of 65536/44100 s since the GPS epoch, less the GPS-UTC leap seconds. */
    fun alfnToMs(alfn: Long, leap: Int = 18): Long = 315_964_800_000L + Math.round((alfn * 65536.0 / 44100 - leap) * 1000)

    /** NRSC-5 program types (the US table shared with RBDS). */
    val PROGRAM_TYPES = mapOf(
        0 to "None", 1 to "News", 2 to "Information", 3 to "Sports", 4 to "Talk", 5 to "Rock", 6 to "Classic Rock", 7 to "Adult Hits", 8 to "Soft Rock", 9 to "Top 40",
        10 to "Country", 11 to "Oldies", 12 to "Soft", 13 to "Nostalgia", 14 to "Jazz", 15 to "Classical", 16 to "Rhythm and Blues", 17 to "Soft Rhythm and Blues",
        18 to "Foreign Language", 19 to "Religious Music", 20 to "Religious Talk", 21 to "Personality", 22 to "Public", 23 to "College", 24 to "Spanish Talk",
        25 to "Spanish Music", 26 to "Hip-Hop", 29 to "Weather", 30 to "Emergency Test", 31 to "Emergency", 65 to "Traffic", 76 to "Special Reading Services",
    )
    fun programTypeName(t: Int?): String = if (t == null || t < 0) "" else PROGRAM_TYPES[t] ?: "Type $t"
    /** Service data types (1020s Table 4-13). */
    val DATA_TYPES = mapOf(
        0 to "Non-specific", 1 to "News", 3 to "Sports", 29 to "Weather", 31 to "Emergency", 65 to "Traffic", 66 to "Image maps", 80 to "Text", 256 to "Advertising", 257 to "Financial",
        258 to "Stock ticker", 259 to "Navigation", 260 to "Program guide", 261 to "Audio", 262 to "Private data network", 263 to "Service maintenance", 264 to "HD Radio system services",
        265 to "Audio-related objects", 511 to "Special tests",
    )
    fun dataTypeName(t: Int): String = DATA_TYPES[t] ?: "Data type $t"

    /** Known 32-bit MIME hashes (as sent, little endian) of the service directory, XHDR and LOT headers. */
    val MIME_HASHES: Map<Long, String> = mapOf(
        0xBE4B7536L to "Primary image (album art)", 0xD9C72536L to "Station logo", 0x2D42AC3EL to "NAVTEQ traffic", 0x82F03DFCL to "HERE TPEG traffic", 0xB7F03DFCL to "HERE traffic image",
        0xEECB55B6L to "HD TMC traffic", 0x4DC66C5AL to "HDC audio", 0xBB492AACL to "Text", 0x1E653E9CL to "JPEG image", 0x4F328CA0L to "PNG image",
        0xB39EBEB2L to "TTN TPEG traffic 1", 0x4EB03469L to "TTN TPEG traffic 2", 0x52103469L to "TTN TPEG traffic 3", 0xFF8422D7L to "TTN STM traffic maps", 0xEF042E96L to "TTN STM weather maps",
    )
    /** A 32-bit MIME hash's name, or "". */
    fun mimeName(h: Long): String = MIME_HASHES[h and 0xFFFFFFFFL] ?: ""
    /** The 12-bit hash SIS sends (the low 12 bits of the 32-bit one): the known types it can be, or "". */
    fun sisMimeName(m12: Int): String = MIME_HASHES.filterKeys { (it and 0xFFF).toInt() == m12 }.values.distinct().joinToString(" or ")

    /** Whether a station location is on the globe (1020s 4.4); some stations send one that is not. */
    fun locationValid(lat: Double?, lon: Double?): Boolean =
        lat != null && lon != null && lat.isFinite() && lon.isFinite() && kotlin.math.abs(lat) <= 90 && kotlin.math.abs(lon) <= 180 && !(lat == 0.0 && lon == 0.0)

    class Clock(val offsetMs: Long, val trusted: Boolean)
    /** The station clock against this device's (1020s 5.4.1): trusted only when locked to GPS and within [tolMs]. */
    fun clockCheck(alfnMs: Long, localMs: Long, timeLocked: Boolean, tolMs: Long = 10_000): Clock {
        val off = if (alfnMs != 0L && localMs != 0L) alfnMs - localMs else 0L
        return Clock(off, alfnMs != 0L && localMs != 0L && timeLocked && kotlin.math.abs(off) <= tolMs)
    }

    class TimeHint(val offsetMin: Int, val schedule: Int, val dstLocal: Boolean, val dstNow: Boolean)
    /** SIS parameter 3, local time (1020s 4.7.1, bit 0 the most significant): UTC offset in minutes, DST schedule, DST
     *  practiced locally, DST in effect regionally. */
    fun localTimeHint(v: Int): TimeHint {
        val o = (v shr 5) and 0x7FF
        return TimeHint(if (o >= 1024) o - 2048 else o, (v shr 2) and 7, (v shr 1) and 1 == 1, v and 1 == 1)
    }
    /** A UTC offset as UTC-8:00. */
    fun utcOffsetText(min: Int): String = "UTC${if (min < 0) "-" else "+"}${kotlin.math.abs(min) / 60}:${"%02d".format(kotlin.math.abs(min) % 60)}"

    /** Blend control of the MPS (1017s Table 5-4). */
    val BLEND_NAMES = listOf("disabled (all digital)", "select (analog forced)", "enabled (blends on signal)", "reserved")
}

private class Votes<T> {
    class E<T>(val v: T, var n: Int)
    private val m = LinkedHashMap<String, E<T>>()
    fun add(key: String, v: T) { val e = m[key]; if (e != null) e.n++ else m[key] = E(v, 1) }
    class Best<T>(val v: T, val n: Int, val total: Int)
    fun best(): Best<T>? {
        var b: E<T>? = null; var total = 0
        for (e in m.values) { total += e.n; if (b == null || e.n > b.n) b = e }
        return b?.let { Best(it.v, it.n, total) }
    }
    val size: Int get() = m.size
    /** How many distinct values came at least [n] times. */
    fun atLeast(n: Int): Int = m.values.count { it.n >= n }
}

class SisAudio(val program: Int, val type: Int, val access: Int, val soundExp: Int = 0)
class SisData(val type: Int, val mime12: Int, val access: Int, val mimeName: String = "")
class SisAlert(
    val text: String, val encoding: Int, val seq: Int, val categories: Pair<Int, Int>, val locationFormat: String, val locations: List<Long>,
    /** The control data as hex; its CRC and the message CRC-7 both verified. */
    val control: String, val ms: Long,
)
class SisOther(val id: Int, val n: Int, val bits: String)
class SisSummary(
    val callsign: String, val country: String, val facility: Int, val longName: String, val slogan: String, val message: String, val universal: String,
    val lat: Double?, val lon: Double?, val altM: Int?,
    val audio: List<SisAudio>, val data: List<SisData>, val params: Map<Int, Int>,
    val timeLocked: Boolean, val alfn: Long, val alfnMs: Long, val pdus: Int, val llds: Int, val alerts: Int,
    /** Votes behind the call sign, out of all short-name messages. */
    val nameVotes: Pair<Int, Int>,
    /** The station message has the priority bit set (1020s 4.5: it goes to the top of the queue). */
    val messagePriority: Boolean = false,
    /** Votes behind each SIS parameter's value, out of all sent for that index. */
    val paramVotes: Map<Int, Pair<Int, Int>> = emptyMap(),
    /** This device's clock when the last ALFN came in (0: none yet). */
    val alfnLocalMs: Long = 0,
    /** 1 when an emergency alert decoded with both its CRCs verified. */
    val alertsRepeated: Int = 0,
    /** PDUs whose CRC-12 verified and failed; only the good ones are voted. */
    val crcGood: Int = 0, val crcBad: Int = 0,
    /** The station message's own checksum (1020s 4.5) verified over the voted text. */
    val messageChecksumOk: Boolean = false, val messageEncoding: Int = 0,
    /** The newest emergency alert that verified, or null; alerts that failed a CRC. */
    val alert: SisAlert? = null, val alertsBad: Int = 0,
    val exciter: HdSis.Device? = null, val importer: HdSis.Device? = null, val leap: HdSis.Leap? = null, val importerConfig: Int = -1,
    /** Messages by kind, PDUs that passed. */
    val msgCounts: Map<String, Int> = emptyMap(),
    /** Message ids with no defined payload (3, 11..15), with the bits last seen. */
    val other: List<SisOther> = emptyList(),
    /** Low latency data PDUs: the last one's bits and how many distinct were seen. */
    val lldsLast: String = "", val lldsDistinct: Int = 0,
    /** Message id 3 PDUs (the whole ALFN, sent by some stations) and the last value. */
    val alfnMsgs: Int = 0, val alfnMsgLast: Long = -1,
)

private fun sisText(b: List<Int>, enc: Int?): String {
    val sb = StringBuilder()
    if (enc == 4) { var i = 0; while (i + 1 < b.size) { sb.append((b[i] or (b[i + 1] shl 8)).toChar()); i += 2 } }
    else for (c in b) sb.append(c.toChar())
    return sb.toString().trimEnd('\u0000').replace(Regex("[\\x00-\\x08\\x0b-\\x1f]"), "")
}
private fun hexOf(b: List<Int>) = b.joinToString("") { "%02x".format(it) }

/** Every SIS PDU of a station, majority-voted field by field over the PDUs whose CRC verifies. */
class SisVoter {
    var pdus = 0; private set
    var llds = 0; private set
    var alerts = 0; private set
    var crcGood = 0; private set
    var crcBad = 0; private set
    private val short = Votes<String>(); private val id = Votes<Pair<String, Int>>()
    private val locHi = Votes<Pair<Double, Int>>(); private val locLo = Votes<Pair<Double, Int>>()
    private val long = HashMap<Int, Votes<String>>(); private val longLast = Votes<Int>()
    private val slogan = HashMap<Int, Votes<List<Int>>>(); private val sloganLen = Votes<Pair<Int, Int>>()
    private val usn = HashMap<Int, Votes<List<Int>>>(); private val usnHead = Votes<Triple<Int, Int, Int>>()
    private val smsg = HashMap<String, Votes<List<Int>>>(); private val smsgHead = LinkedHashMap<Int, Votes<List<Int>>>()
    private var alfnLocal = 0L
    private val svcAudio = LinkedHashMap<Int, Votes<Triple<Int, Int, Int>>>()
    private class DataE(val type: Int, val mime12: Int, val access: Int, var n: Int)
    private val svcData = LinkedHashMap<String, DataE>()
    private val params = LinkedHashMap<Int, Votes<Int>>()
    private val locked = Votes<Int>()
    private var alfn = -1L; private var alfnFrames = 0L; private val alfnOff = Votes<Long>()
    private val msgCounts = LinkedHashMap<String, Int>()
    private class OtherE(var n: Int, var bits: String)
    private val other = LinkedHashMap<Int, OtherE>()
    private var lldsLast = ""; private val lldsDistinct = HashSet<String>()
    private class AlertHead(val encoding: Int, val length: Int, val crc7: Int, val cntLength: Int)
    private class AlertBuf(val seq: Int, var head: AlertHead?, val bytes: HashMap<Int, Int>, val have: HashSet<Int>)
    private var alertBuf: AlertBuf? = null
    private var alert: SisAlert? = null; private var alertsBad = 0
    private var alfnMsgs = 0; private var alfnMsgLast = -1L
    /** The clock alerts are stamped with (tests hold it still). */
    var clock: () -> Long = { System.currentTimeMillis() }

    fun add(p: HdSis.Pdu) {
        pdus++
        if (!p.crcOk) { crcBad++; return }
        crcGood++
        if (p.llds) { llds++; lldsLast = p.bits; if (lldsDistinct.size < 64) lldsDistinct.add(p.bits.substring(1, minOf(68, p.bits.length))); return }
        locked.add(p.timeLocked.toString(), p.timeLocked)
        for (m in p.msgs) { msgCounts[m.kind] = (msgCounts[m.kind] ?: 0) + 1; addMsg(m) }
    }
    /** One frame's ALFN as sent (from PDUs that passed their CRC), kept as the voted offset from the frames counted. */
    fun setAlfn(a: Long, localMs: Long = 0) { alfnLocal = localMs; alfnFrames++; val off = a - alfnFrames; alfnOff.add(off.toString(), off); alfn = alfnOff.best()!!.v + alfnFrames }
    /** A missed frame: the next ALFN is one further on. */
    fun skipFrame() { alfnFrames++; if (alfn >= 0) alfn++ }

    private fun <K, V> MutableMap<K, Votes<V>>.at(k: K) = getOrPut(k) { Votes() }

    private fun addMsg(m: HdSis.Msg) {
        when (m) {
            is HdSis.Msg.Id -> id.add("${m.country}/${m.facility}", m.country to m.facility)
            is HdSis.Msg.ShortName -> short.add(m.name, m.name)
            is HdSis.Msg.LongName -> { long.at(m.frame).add(m.chars, m.chars); longLast.add(m.last.toString(), m.last) }
            is HdSis.Msg.Loc -> (if (m.high) locHi else locLo).add("${m.deg}/${m.alt}", m.deg to m.alt)
            is HdSis.Msg.Smsg -> {
                smsg.at("${m.seq}/${m.frame}").add(m.bytes.joinToString(","), m.bytes.toList())
                if (m.frame == 0) smsgHead.at(m.seq).add("${m.length}/${m.encoding}/${m.priority}/${m.checksum}", listOf(m.length ?: 0, m.encoding ?: 0, m.priority ?: 0, m.checksum ?: 0))
            }
            is HdSis.Msg.Svc -> {
                if (m.audio) svcAudio.at(m.program).add("${m.progType}/${m.access}/${m.soundExp}", Triple(m.progType, m.access, m.soundExp))
                else { val k = "${m.dataType}/${m.mime12}"; val e = svcData[k]; if (e != null) e.n++ else svcData[k] = DataE(m.dataType, m.mime12, m.access, 1) }
            }
            is HdSis.Msg.Param -> params.at(m.index).add(m.value.toString(), m.value)
            is HdSis.Msg.Usn -> { usn.at(m.frame).add(m.bytes.joinToString(","), m.bytes.toList()); if (m.frame == 0) usnHead.add("${m.encoding}/${m.append}/${m.frames}", Triple(m.encoding ?: 0, m.append ?: 0, m.frames ?: 1)) }
            is HdSis.Msg.Slogan -> { slogan.at(m.frame).add(m.bytes.joinToString(","), m.bytes.toList()); if (m.frame == 0) sloganLen.add("${m.length}/${m.encoding}", (m.length ?: 0) to (m.encoding ?: 0)) }
            is HdSis.Msg.Alert -> { alerts++; addAlert(m) }
            is HdSis.Msg.Alfn -> { alfnMsgs++; alfnMsgLast = m.alfn }
            is HdSis.Msg.Other -> { val e = other[m.id]; if (e != null) { e.n++; e.bits = m.bits } else other[m.id] = OtherE(1, m.bits) }
        }
    }

    /** 1020s 4.10: the alert's frames, its CRC-7 over the message, then the control data's own CRC. */
    private fun addAlert(m: HdSis.Msg.Alert) {
        var a = alertBuf
        if (a == null || (m.frame == 0 && m.seq != a.seq)) { a = AlertBuf(m.seq, null, HashMap(), HashSet()); alertBuf = a }
        if (m.frame == 0) { a.head = AlertHead(m.encoding ?: 0, m.length ?: 0, m.crc7 ?: 0, m.cntLength ?: 0); m.bytes.forEachIndexed { i, v -> a.bytes[i] = v } }
        else m.bytes.forEachIndexed { i, v -> a.bytes[6 * m.frame - 3 + i] = v }
        a.have.add(m.frame)
        val h = a.head ?: return
        val need = (h.length + 3 + 5) / 6
        for (f in 0 until need) if (f !in a.have) return
        val msg = IntArray(h.length) { a.bytes[it] ?: 0 }
        if (alertCrc7Ok(msg, h) == false) { alertsBad++; alertBuf = null; return }
        val cnt = msg.copyOfRange(0, h.cntLength)
        if ((((cnt[2] and 15) shl 8) or cnt[1]) != HdSis.alertCntCrc(cnt, h.cntLength)) { alertsBad++; alertBuf = null; return }
        val c = HdSis.parseAlertControl(cnt, h.cntLength)
        val body = msg.copyOfRange(h.cntLength, msg.size).toList()
        val t = if (h.encoding == 4) sisText(body, 4) else String(ByteArray(body.size) { body[it].toByte() }, Charsets.ISO_8859_1)
        val ctl = hexOf(cnt.toList()); val cur = alert
        if (cur == null || cur.control != ctl || cur.text != t.trim())
            alert = SisAlert(t.trim(), h.encoding, a.seq, c.categories, HdSis.ALERT_LOCATION_FORMATS.getOrElse(c.format) { "format ${c.format}" }, c.locations, ctl, clock())
        alertBuf = null
    }
    private fun alertCrc7Ok(msg: IntArray, h: AlertHead): Boolean =
        !(HdSis.alertCrc7(msg, h.length) != h.crc7 || h.cntLength < 7 || h.length < h.cntLength)

    fun summary(): SisSummary {
        val sn = short.best(); val idv = id.best()?.v; val hi = locHi.best()?.v; val lo = locLo.best()?.v
        fun join(mp: Map<Int, Votes<List<Int>>>) = mp.keys.sorted().flatMap { mp[it]!!.best()!!.v }
        val longName = StringBuilder()
        if (long.isNotEmpty()) { val last = longLast.best()?.v ?: 7; for (f in 0..last) longName.append(long[f]?.best()?.v ?: "") }
        var sloganS = ""
        if (slogan.isNotEmpty()) {
            val (len, enc) = sloganLen.best()?.v ?: (0 to 0); val b = join(slogan)
            sloganS = sisText(if (len > 0) b.take(if (enc == 4) 2 * len else len) else b, enc)
        }
        val (usnEnc, usnAppend, usnFrames) = usnHead.best()?.v ?: Triple(0, 0, 0)
        var universal = ""
        if (usn.isNotEmpty()) {
            val b = ArrayList<Int>()
            for (f in 0 until (if (usnFrames != 0) usnFrames else usn.size)) b.addAll(usn[f]?.best()?.v ?: emptyList())
            universal = sisText(b, usnEnc).trim() + if (usnAppend != 0) "-FM" else ""
        }
        var message = ""; var messagePriority = false; var messageChecksumOk = false; var messageEncoding = 0
        if (smsgHead.isNotEmpty()) {
            val seq = smsgHead.keys.sortedByDescending { smsgHead[it]!!.best()!!.total }.first()
            val hv = smsgHead[seq]!!.best()!!.v; val len = hv[0]; val enc = hv[1]; val prio = hv[2]; val sum = hv[3]
            messagePriority = prio == 1; messageEncoding = enc
            val b = ArrayList<Int>()
            for (f in 0 until 32) { val v = smsg["$seq/$f"]?.best()?.v; if (v == null) { if (b.size >= len) break; continue }; b.addAll(v) }
            val body = b.take(len)
            val t = body.sum()
            messageChecksumOk = body.size == len && ((((t shr 8) and 0x7F) + (t and 0xFF)) and 0x7F) == sum
            message = sisText(body, enc)
        }
        val pv = params.mapValues { it.value.best()!!.v }
        return SisSummary(
            callsign = sn?.v ?: "", country = idv?.first ?: "", facility = idv?.second ?: -1, longName = longName.toString().trimEnd('\u0000').trim(),
            slogan = sloganS.trim(), message = message.trim(), universal = universal,
            lat = hi?.first, lon = lo?.first, altM = if (hi != null && lo != null) ((hi.second shl 4) or lo.second) * 16 else null,
            audio = svcAudio.entries.filter { it.value.best()!!.n >= 2 }.map { (program, v) -> val b = v.best()!!.v; SisAudio(program, b.first, b.second, b.third) }.sortedBy { it.program },
            data = svcData.values.filter { it.n >= 2 }.map { SisData(it.type, it.mime12, it.access, HdSis.sisMimeName(it.mime12)) },
            params = pv, timeLocked = locked.best()?.v == 1, alfn = alfn, alfnMs = if (alfn >= 0) HdSis.alfnToMs(alfn) else 0L,
            pdus = pdus, llds = llds, alerts = alerts, nameVotes = if (sn != null) sn.n to sn.total else 0 to 0,
            messagePriority = messagePriority, paramVotes = params.mapValues { it.value.best()!!.let { b -> b.n to b.total } }, alfnLocalMs = alfnLocal,
            alertsRepeated = if (alert != null) 1 else 0, crcGood = crcGood, crcBad = crcBad, messageChecksumOk = messageChecksumOk, messageEncoding = messageEncoding,
            alert = alert, alertsBad = alertsBad,
            exciter = HdSis.sisDevice(pv, 4), importer = HdSis.sisDevice(pv, 8), leap = HdSis.sisLeap(pv), importerConfig = pv[12] ?: -1,
            msgCounts = LinkedHashMap(msgCounts), other = other.entries.map { SisOther(it.key, it.value.n, it.value.bits) },
            lldsLast = lldsLast, lldsDistinct = lldsDistinct.size, alfnMsgs = alfnMsgs, alfnMsgLast = alfnMsgLast,
        )
    }
}
