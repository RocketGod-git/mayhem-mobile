package com.rocketgod.mayhem.core.hd

/**
 * Station Information Service on the PIDS channel (SY_IDD_1020s rev K, section 4): one 80-bit PDU per block, one or
 * two messages each. Fields are read from the PDU in its L2 bit order (the per-byte reversal of the L1 bits).
 * The CRC-12 at bits 68..79 does not verify against the text of 4.11 on our recordings, so every field is kept by
 * vote over repeated PDUs and shown as voted.
 */
object HdSis {
    private const val CHARS5 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ ?-*$"
    val SIS_PAYLOAD = intArrayOf(32, 22, 58, 32, 27, 58, 27, 22, 58, 58, 27)

    sealed class Msg {
        data class Id(val country: String, val facility: Int) : Msg()
        data class ShortName(val name: String) : Msg()
        data class LongName(val last: Int, val frame: Int, val chars: String, val seq: Int) : Msg()
        data class Loc(val high: Boolean, val deg: Double, val alt: Int) : Msg()
        class Smsg(val frame: Int, val seq: Int, val priority: Int?, val encoding: Int?, val length: Int?, val bytes: IntArray) : Msg()
        data class Svc(val adv: Boolean, val audio: Boolean, val access: Int, val program: Int, val progType: Int, val dataType: Int, val mime12: Int) : Msg()
        data class Param(val index: Int, val value: Int) : Msg()
        class Usn(val frame: Int, val encoding: Int?, val append: Int?, val bytes: IntArray) : Msg()
        class Slogan(val frame: Int, val encoding: Int?, val length: Int?, val bytes: IntArray) : Msg()
        data class Alert(val bits: String) : Msg()
        data class Other(val id: Int) : Msg()
    }

    class Pdu(val llds: Boolean, val msgs: List<Msg>, val timeLocked: Int, val advAlfn: Int, val crc: Int)

    private fun u(b: ByteArray, a: Int, n: Int): Int { var v = 0; for (i in a until a + n) v = v * 2 + (b[i].toInt() and 1); return v }
    private fun s(v: Int, n: Int) = if (v >= 1 shl (n - 1)) v - (1 shl n) else v
    private fun bytesAt(b: ByteArray, a: Int, n: Int) = IntArray(n) { u(b, a + 8 * it, 8) }

    fun parseMsg(id: Int, b: ByteArray): Msg = when (id) {
        0 -> { val cc = u(b, 0, 10); Msg.Id(if ((cc shr 5) < 26 && (cc and 31) < 26) "${CHARS5[cc shr 5]}${CHARS5[cc and 31]}" else "#$cc", u(b, 13, 19)) }
        1 -> {
            val sb = StringBuilder()
            for (i in 0 until 4) { val c = u(b, 5 * i, 5); sb.append(if (c < 31) CHARS5[c] else '#') }
            Msg.ShortName(sb.toString().trim() + if (u(b, 20, 2) == 1) "-FM" else "")
        }
        2 -> Msg.LongName(u(b, 0, 3), u(b, 3, 3), String(CharArray(7) { u(b, 6 + 7 * it, 7).toChar() }), u(b, 55, 3))
        4 -> Msg.Loc(u(b, 0, 1) == 1, s(u(b, 1, 22), 22) / 8192.0, u(b, 23, 4))
        5 -> {
            val frame = u(b, 0, 5); val seq = u(b, 5, 2)
            if (frame == 0) Msg.Smsg(frame, seq, u(b, 7, 1), u(b, 8, 3), u(b, 11, 8), bytesAt(b, 26, 4))
            else Msg.Smsg(frame, seq, null, null, null, bytesAt(b, 10, 6))
        }
        6, 10 -> {
            val cat = u(b, 0, 2)
            if (cat == 0) Msg.Svc(id == 10, true, u(b, 2, 1), u(b, 3, 6), u(b, 9, 8), -1, -1)
            else Msg.Svc(id == 10, false, u(b, 2, 1), -1, -1, u(b, 3, 9), u(b, 15, 12))
        }
        7 -> Msg.Param(u(b, 0, 6), u(b, 6, 16))
        8 -> {
            val frame = u(b, 0, 4)
            if (u(b, 4, 1) == 0) { if (frame == 0) Msg.Usn(frame, u(b, 5, 3), u(b, 8, 1), bytesAt(b, 10, 6)) else Msg.Usn(frame, null, null, bytesAt(b, 10, 6)) }
            else if (frame == 0) Msg.Slogan(frame, u(b, 5, 3), u(b, 11, 7), bytesAt(b, 18, 5)) else Msg.Slogan(frame, null, null, bytesAt(b, 10, 6))
        }
        9 -> Msg.Alert(String(CharArray(SIS_PAYLOAD[9]) { if (b[it].toInt() and 1 != 0) '1' else '0' }))
        else -> Msg.Other(id)
    }

    /** One 80-bit SIS PDU in L2 bit order. */
    fun parse(b: ByteArray): Pdu {
        if (b[0].toInt() != 0) return Pdu(true, emptyList(), 0, 0, 0)
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
        return Pdu(false, msgs, b[65].toInt() and 1, u(b, 66, 2), u(b, 68, 12))
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
        25 to "Spanish Music", 26 to "Hip-Hop", 29 to "Weather", 30 to "Emergency Test", 31 to "Emergency",
    )
    fun programTypeName(t: Int?): String = if (t == null || t < 0) "" else PROGRAM_TYPES[t] ?: "Type $t"
    /** Data service types named in 1020s and seen on the air. */
    val DATA_TYPES = mapOf(66 to "Image maps", 259 to "Navigation")
    fun dataTypeName(t: Int): String = DATA_TYPES[t] ?: "Data type $t"
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
}

class SisAudio(val program: Int, val type: Int, val access: Int)
class SisData(val type: Int, val mime12: Int, val access: Int)
class SisSummary(
    val callsign: String, val country: String, val facility: Int, val longName: String, val slogan: String, val message: String, val universal: String,
    val lat: Double?, val lon: Double?, val altM: Int?,
    val audio: List<SisAudio>, val data: List<SisData>, val params: Map<Int, Int>,
    val timeLocked: Boolean, val alfn: Long, val alfnMs: Long, val pdus: Int, val llds: Int, val alerts: Int,
    /** Votes behind the call sign, out of all short-name messages. */
    val nameVotes: Pair<Int, Int>,
)

private fun sisText(b: List<Int>, enc: Int?): String {
    val sb = StringBuilder()
    if (enc == 4) { var i = 0; while (i + 1 < b.size) { sb.append((b[i] or (b[i + 1] shl 8)).toChar()); i += 2 } }
    else for (c in b) sb.append(c.toChar())
    return sb.toString().trimEnd('\u0000').replace(Regex("[\\x00-\\x08\\x0b-\\x1f]"), "")
}

/** Every SIS PDU of a station, majority-voted field by field. */
class SisVoter {
    var pdus = 0; private set
    var llds = 0; private set
    var alerts = 0; private set
    private val short = Votes<String>(); private val id = Votes<Pair<String, Int>>()
    private val locHi = Votes<Pair<Double, Int>>(); private val locLo = Votes<Pair<Double, Int>>()
    private val long = HashMap<Int, Votes<String>>(); private val longLast = Votes<Int>()
    private val slogan = HashMap<Int, Votes<List<Int>>>(); private val sloganLen = Votes<Pair<Int, Int>>()
    private val usn = HashMap<Int, Votes<List<Int>>>(); private val usnEnc = Votes<Int>()
    private val smsg = HashMap<String, Votes<List<Int>>>(); private val smsgHead = LinkedHashMap<Int, Votes<Pair<Int, Int>>>()
    private val svcAudio = LinkedHashMap<Int, Votes<Pair<Int, Int>>>()
    private class DataE(val type: Int, val mime12: Int, val access: Int, var n: Int)
    private val svcData = LinkedHashMap<String, DataE>()
    private val params = LinkedHashMap<Int, Votes<Int>>()
    private val locked = Votes<Int>()
    private var alfn = -1L; private var alfnFrames = 0L; private val alfnOff = Votes<Long>()

    fun add(p: HdSis.Pdu) {
        pdus++
        if (p.llds) { llds++; return }
        locked.add(p.timeLocked.toString(), p.timeLocked)
        for (m in p.msgs) addMsg(m)
    }
    /** One frame's ALFN as sent; without a usable CRC single PDU errors show, so the clock is the voted offset
     *  between the frames counted here and the ALFN sent. */
    fun setAlfn(a: Long) { alfnFrames++; val off = a - alfnFrames; alfnOff.add(off.toString(), off); alfn = alfnOff.best()!!.v + alfnFrames }
    /** A missed frame: the next ALFN is one further on. */
    fun skipFrame() { alfnFrames++ }

    private fun <K, V> MutableMap<K, Votes<V>>.at(k: K) = getOrPut(k) { Votes() }

    private fun addMsg(m: HdSis.Msg) {
        when (m) {
            is HdSis.Msg.Id -> id.add("${m.country}/${m.facility}", m.country to m.facility)
            is HdSis.Msg.ShortName -> short.add(m.name, m.name)
            is HdSis.Msg.LongName -> { long.at(m.frame).add(m.chars, m.chars); longLast.add(m.last.toString(), m.last) }
            is HdSis.Msg.Loc -> (if (m.high) locHi else locLo).add("${m.deg}/${m.alt}", m.deg to m.alt)
            is HdSis.Msg.Smsg -> {
                smsg.at("${m.seq}/${m.frame}").add(m.bytes.joinToString(","), m.bytes.toList())
                if (m.frame == 0) smsgHead.at(m.seq).add("${m.length}/${m.encoding}", (m.length ?: 0) to (m.encoding ?: 0))
            }
            is HdSis.Msg.Svc -> {
                if (m.audio) svcAudio.at(m.program).add("${m.progType}/${m.access}", m.progType to m.access)
                else { val k = "${m.dataType}/${m.mime12}"; val e = svcData[k]; if (e != null) e.n++ else svcData[k] = DataE(m.dataType, m.mime12, m.access, 1) }
            }
            is HdSis.Msg.Param -> params.at(m.index).add(m.value.toString(), m.value)
            is HdSis.Msg.Usn -> { usn.at(m.frame).add(m.bytes.joinToString(","), m.bytes.toList()); if (m.frame == 0 && m.encoding != null) usnEnc.add(m.encoding.toString(), m.encoding) }
            is HdSis.Msg.Slogan -> { slogan.at(m.frame).add(m.bytes.joinToString(","), m.bytes.toList()); if (m.frame == 0) sloganLen.add("${m.length}/${m.encoding}", (m.length ?: 0) to (m.encoding ?: 0)) }
            is HdSis.Msg.Alert -> alerts++
            else -> {}
        }
    }

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
        val universal = if (usn.isNotEmpty()) sisText(join(usn), usnEnc.best()?.v) else ""
        var message = ""
        if (smsgHead.isNotEmpty()) {
            val seq = smsgHead.keys.sortedByDescending { smsgHead[it]!!.best()!!.total }.first()
            val (len, enc) = smsgHead[seq]!!.best()!!.v
            val b = ArrayList<Int>()
            for (f in 0 until 32) { val v = smsg["$seq/$f"]?.best()?.v; if (v == null) { if (b.size >= len) break; continue }; b.addAll(v) }
            message = sisText(b.take(len), enc)
        }
        return SisSummary(
            callsign = sn?.v ?: "", country = idv?.first ?: "", facility = idv?.second ?: -1, longName = longName.toString().trimEnd('\u0000').trim(),
            slogan = sloganS.trim(), message = message.trim(), universal = universal.trim(),
            lat = hi?.first, lon = lo?.first, altM = if (hi != null && lo != null) ((hi.second shl 4) or lo.second) * 16 else null,
            audio = svcAudio.entries.filter { it.value.best()!!.n >= 3 }.map { (program, v) -> SisAudio(program, v.best()!!.v.first, v.best()!!.v.second) }.sortedBy { it.program },
            data = svcData.values.filter { it.n >= 3 }.map { SisData(it.type, it.mime12, it.access) },
            params = params.mapValues { it.value.best()!!.v }, timeLocked = locked.best()?.v == 1, alfn = alfn, alfnMs = if (alfn >= 0) HdSis.alfnToMs(alfn) else 0L,
            pdus = pdus, llds = llds, alerts = alerts, nameVotes = if (sn != null) sn.n to sn.total else 0 to 0,
        )
    }
}
