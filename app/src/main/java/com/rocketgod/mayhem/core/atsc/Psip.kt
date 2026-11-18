package com.rocketgod.mayhem.core.atsc

/**
 * MPEG-2 PSI (ITU-T H.222.0: PAT, PMT, CRC-32 of Annex A) and ATSC PSIP (A/65: STT, MGT, TVCT/CVCT, EIT, ETT, RRT,
 * the multiple string structure with the Annex C Huffman text, and the descriptors receivers use).
 */
private val CRC_T = IntArray(256) { i -> var c = i shl 24; repeat(8) { c = if (c and 0x80000000.toInt() != 0) (c shl 1) xor 0x04c11db7 else c shl 1 }; c }
/** CRC-32 of H.222.0 Annex A; a whole section including its CRC gives 0. */
fun crc32(b: ByteArray, from: Int = 0, to: Int = b.size): Long {
    var c = -1
    for (i in from until to) c = (c shl 8) xor CRC_T[((c ushr 24) xor (b[i].toInt() and 0xff)) and 255]
    return c.toLong() and 0xffffffffL
}

internal fun ByteArray.u(i: Int): Int = if (i in indices) this[i].toInt() and 0xff else 0

/** Reassembles sections on one PID from TS payloads; whole sections come out through [onSection]. */
class SectionAssembler(private val onSection: (ByteArray) -> Unit) {
    private var buf: ByteArray? = null; private var len = 0
    fun reset() { buf = null; len = 0 }
    fun feed(pusi: Boolean, p: ByteArray, from: Int, to: Int) {
        if (pusi) {
            if (to <= from) return
            val ptr = p.u(from)
            if (buf != null && ptr > 0) { append(p, from + 1, minOf(to, from + 1 + ptr)); drain() }
            buf = ByteArray(4096); len = 0
            append(p, minOf(to, from + 1 + ptr), to)
            drain()
        } else if (buf != null) { append(p, from, to); drain() }
    }
    private fun append(p: ByteArray, from: Int, to: Int) {
        var b = buf ?: return
        val n = to - from; if (n <= 0) return
        if (len + n > b.size) { b = b.copyOf(maxOf(b.size * 2, len + n)); buf = b }
        System.arraycopy(p, from, b, len, n); len += n
    }
    private fun drain() {
        while (true) {
            val b = buf ?: return
            if (len < 3) return
            if (b.u(0) == 0xff) { buf = null; len = 0; return }
            val l = ((b.u(1) and 0x0f) shl 8) or b.u(2)
            if (l > 4093) { buf = null; len = 0; return }
            if (len < 3 + l) return
            onSection(b.copyOfRange(0, 3 + l))
            System.arraycopy(b, 3 + l, b, 0, len - 3 - l); len -= 3 + l
        }
    }
}

class SecHeader(val tableId: Int, val ext: Int, val version: Int, val current: Boolean, val section: Int, val last: Int)
fun secHeader(s: ByteArray) = SecHeader(s.u(0), (s.u(3) shl 8) or s.u(4), (s.u(5) shr 1) and 31, s.u(5) and 1 == 1, s.u(6), s.u(7))
private fun u16(s: ByteArray, p: Int) = (s.u(p) shl 8) or s.u(p + 1)
private fun u32(s: ByteArray, p: Int): Long = ((s.u(p).toLong() shl 24) or (s.u(p + 1).toLong() shl 16) or (s.u(p + 2).toLong() shl 8) or s.u(p + 3).toLong())
private fun pid13(s: ByteArray, p: Int) = ((s.u(p) and 0x1f) shl 8) or s.u(p + 1)
private fun latin(s: ByteArray, from: Int, to: Int): String { val sb = StringBuilder(); for (i in from until minOf(to, s.size)) sb.append((s[i].toInt() and 0xff).toChar()); return sb.toString() }

// ---- Huffman text (A/65 Annex C) ----
private fun trees(src: String): Map<Int, Map<String, Int>> {
    val out = HashMap<Int, Map<String, Int>>()
    for (part in src.split(';')) {
        val (prior, list) = part.split(':')
        val t = HashMap<String, Int>()
        for (e in list.split(',')) { val (code, sym) = e.split('='); t[code] = sym.toInt() }
        out[prior.toInt()] = t
    }
    return out
}
private val huff by lazy { listOf(trees(HUFF_TITLE), trees(HUFF_DESC)) }
/** The trees of compression_type 1 (titles) and 2 (descriptions), prior character to code to symbol. */
fun huffTrees(ctype: Int): Map<Int, Map<String, Int>> = huff[ctype - 1]
/** Order-1 Huffman: the first character uses prior 0; ESC (27) sends the next byte plain; a plain byte of 128 or more
 *  is followed by another plain byte; Terminate (0) ends the string. */
fun huffDecode(data: ByteArray, ctype: Int, from: Int = 0, to: Int = data.size): String {
    val tab = huffTrees(ctype); val n = (to - from) * 8
    fun bit(i: Int) = (data.u(from + (i shr 3)) shr (7 - (i and 7))) and 1
    var pos = 0; var prior = 0; var plain = false; val out = StringBuilder()
    while (pos < n) {
        if (plain) {
            if (pos + 8 > n) break
            var ch = 0; for (k in 0 until 8) ch = (ch shl 1) or bit(pos + k)
            pos += 8
            if (ch == 0) break
            out.append(ch.toChar())
            prior = if (ch < 128) ch else 0; plain = ch >= 128
            continue
        }
        val tree = tab[prior] ?: break
        val code = StringBuilder(); var sym = -1
        while (pos < n && code.length < 24) { code.append(if (bit(pos++) != 0) '1' else '0'); val s = tree[code.toString()]; if (s != null) { sym = s; break } }
        if (sym <= 0) break
        if (sym == 27) { plain = true; continue }
        out.append(sym.toChar()); prior = sym
    }
    return out.toString()
}

class MString(val lang: String, val text: String)
/** multiple_string_structure (A/65 6.10): every string with its language. */
fun mss(s: ByteArray, p0: Int = 0, end0: Int = s.size): List<MString> {
    val out = ArrayList<MString>()
    val end = minOf(end0, s.size)
    var p = p0
    if (p >= end) return out
    val n = s.u(p++)
    var i = 0
    while (i < n && p + 4 <= end) {
        val lang = latin(s, p, p + 3); p += 3
        val segs = s.u(p++)
        val text = StringBuilder()
        var j = 0
        while (j < segs && p + 3 <= end) {
            val ct = s.u(p); val mode = s.u(p + 1); val nb = s.u(p + 2); p += 3
            val a = p; val b = minOf(end, p + nb); p += nb
            if (ct == 0 && mode <= 0x33) for (k in a until b) text.append(((mode shl 8) or s.u(k)).toChar())
            else if (ct == 0 && mode == 0x3f) { var k = a; while (k + 1 < b) { text.append(((s.u(k) shl 8) or s.u(k + 1)).toChar()); k += 2 } }
            else if ((ct == 1 || ct == 2) && mode == 0xff) text.append(huffDecode(s, ct, a, b))
            j++
        }
        out.add(MString(lang, text.toString()))
        i++
    }
    return out
}
private fun firstText(m: List<MString>): String = (m.firstOrNull { it.lang == "eng" } ?: m.firstOrNull())?.text ?: ""

// ---- descriptors ----
class ServiceElement(val streamType: Int, val pid: Int, val lang: String)
class Caption(val lang: String, val digital: Boolean, val service: Int, val line21Field: Int, val easyReader: Boolean, val wide: Boolean)
class Advisory(val region: Int, val dims: List<Pair<Int, Int>>, val text: String)
class Ac3Info(val sampleRate: String, val bsid: Int, val kbps: Int, val channels: String, val lang: String)
class Descriptors {
    var longName: String? = null; var pcrPid: Int? = null; var elements: List<ServiceElement>? = null; var captions: List<Caption>? = null
    var advisory: List<Advisory>? = null; var lang: String? = null; var registration: String? = null; var ac3: Ac3Info? = null
    val tags = ArrayList<Int>()
}
private val AC3_RATES = intArrayOf(32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640)
private val AC3_MODES = listOf("1+1", "1/0", "2/0", "3/0", "2/1", "3/1", "2/2", "3/2")
fun descriptors(s: ByteArray, p0: Int, end0: Int): Descriptors {
    val d = Descriptors()
    val end = minOf(end0, s.size)
    var p = p0
    while (p + 2 <= end) {
        val tag = s.u(p); val len = s.u(p + 1); val b = p + 2; val e = minOf(end, b + len)
        d.tags.add(tag)
        try {
            when {
                tag == 0xa0 -> d.longName = firstText(mss(s, b, e))
                tag == 0xa1 -> {
                    d.pcrPid = pid13(s, b); val n = s.u(b + 2); val el = ArrayList<ServiceElement>()
                    var i = 0; var q = b + 3
                    while (i < n && q + 6 <= e) { el.add(ServiceElement(s.u(q), pid13(s, q + 1), latin(s, q + 3, q + 6).replace("\u0000", ""))); i++; q += 6 }
                    d.elements = el
                }
                tag == 0x86 -> {
                    val n = s.u(b) and 0x1f; val cs = ArrayList<Caption>()
                    var i = 0; var q = b + 1
                    while (i < n && q + 6 <= e) {
                        val dig = s.u(q + 3) and 0x80 != 0
                        cs.add(Caption(latin(s, q, q + 3), dig, if (dig) s.u(q + 3) and 0x3f else 0, if (dig) -1 else s.u(q + 3) and 1, s.u(q + 4) and 0x80 != 0, s.u(q + 4) and 0x40 != 0))
                        i++; q += 6
                    }
                    d.captions = cs
                }
                tag == 0x87 -> {
                    val n = s.u(b) and 0x3f; val adv = ArrayList<Advisory>()
                    var q = b + 1; var i = 0
                    while (i < n && q + 2 <= e) {
                        val region = s.u(q); val nd = s.u(q + 1); q += 2
                        val dims = ArrayList<Pair<Int, Int>>()
                        for (k in 0 until nd) { dims.add(s.u(q) to (s.u(q + 1) and 0x0f)); q += 2 }
                        val dl = s.u(q++); val text = if (dl > 0) firstText(mss(s, q, q + dl)) else ""; q += dl
                        adv.add(Advisory(region, dims, text)); i++
                    }
                    d.advisory = adv
                }
                tag == 0x0a -> d.lang = latin(s, b, b + 3)
                tag == 0x05 -> d.registration = latin(s, b, b + 4)
                tag == 0x81 && len >= 3 -> {
                    // A/52 Annex A AC-3 audio descriptor: sample rate, bsid, bit rate code (an upper limit from 32 up), channels
                    val sr = s.u(b) shr 5; val bsid = s.u(b) and 0x1f; val brc = (s.u(b + 1) shr 2) and 0x3f; val nc = (s.u(b + 2) shr 1) and 0x0f
                    val kbps = if (brc < 19) AC3_RATES[brc] else if (brc in 32..50) AC3_RATES[brc - 32] else 0
                    d.ac3 = Ac3Info(listOf("48 kHz", "44.1 kHz", "32 kHz").getOrNull(sr) ?: "any", bsid, kbps,
                        if (nc < 8) AC3_MODES[nc] else listOf("1", "up to 2", "up to 3", "up to 4", "up to 5", "up to 6").getOrNull(nc - 8) ?: "",
                        if (len >= 10) latin(s, b + len - 3, b + len) else "")
                }
            }
        } catch (_: Exception) { /* a cut-short descriptor */ }
        p = b + len
    }
    return d
}

// ---- tables ----
class PatProgram(val program: Int, val pid: Int)
class Pat(val tsid: Int, val version: Int, val programs: List<PatProgram>)
fun parsePat(s: ByteArray): Pat {
    val h = secHeader(s); val programs = ArrayList<PatProgram>()
    var q = 8
    while (q + 4 <= s.size - 4) { val pn = u16(s, q); if (pn != 0) programs.add(PatProgram(pn, pid13(s, q + 2))); q += 4 }
    return Pat(h.ext, h.version, programs)
}
class PmtStream(val type: Int, val pid: Int, val desc: Descriptors)
class Pmt(val program: Int, val version: Int, val pcrPid: Int, val desc: Descriptors, val streams: List<PmtStream>)
fun parsePmt(s: ByteArray): Pmt {
    val h = secHeader(s); val pil = ((s.u(10) and 0x0f) shl 8) or s.u(11); val streams = ArrayList<PmtStream>()
    var p = 12 + pil
    while (p + 5 <= s.size - 4) { val il = ((s.u(p + 3) and 0x0f) shl 8) or s.u(p + 4); streams.add(PmtStream(s.u(p), pid13(s, p + 1), descriptors(s, p + 5, p + 5 + il))); p += 5 + il }
    return Pmt(h.ext, h.version, pid13(s, 8), descriptors(s, 12, 12 + pil), streams)
}
class MgtTable(val type: Int, val pid: Int, val version: Int, val bytes: Long)
class Mgt(val version: Int, val tables: List<MgtTable>)
fun parseMgt(s: ByteArray): Mgt {
    val h = secHeader(s); val n = u16(s, 9); val tables = ArrayList<MgtTable>()
    var p = 11; var i = 0
    while (i < n && p + 11 <= s.size - 4) { val dl = ((s.u(p + 9) and 0x0f) shl 8) or s.u(p + 10); tables.add(MgtTable(u16(s, p), pid13(s, p + 2), s.u(p + 4) and 31, u32(s, p + 5))); p += 11 + dl; i++ }
    return Mgt(h.version, tables)
}
fun tableTypeName(t: Int): String = when {
    t == 0 -> "TVCT"; t == 1 -> "TVCT next"; t == 2 -> "CVCT"; t == 3 -> "CVCT next"
    t == 4 -> "channel ETT"; t == 5 -> "DCCSCT"
    t in 0x100..0x17f -> "EIT-${t - 0x100}"
    t in 0x200..0x27f -> "ETT-${t - 0x200}"
    t in 0x301..0x3ff -> "RRT ${t - 0x300}"
    t in 0x1400..0x14ff -> "DCCT ${t - 0x1400}"
    else -> "0x%04x".format(t)
}
class VChannel(
    val major: Int, val minor: Int, val shortName: String, val modulation: Int, val carrierHz: Long, val tsid: Int, val program: Int,
    val etm: Int, val access: Boolean, val hidden: Boolean, val hideGuide: Boolean, val serviceType: Int, val sourceId: Int, val desc: Descriptors,
)
class Vct(val cable: Boolean, val tsid: Int, val version: Int, val section: Int, val last: Int, val channels: List<VChannel>)
fun parseVct(s: ByteArray): Vct {
    val h = secHeader(s); val n = s.u(9); val channels = ArrayList<VChannel>()
    var p = 10; var i = 0
    while (i < n && p + 32 <= s.size - 4) {
        val name = StringBuilder(); for (k in 0 until 7) { val c = u16(s, p + 2 * k); if (c != 0) name.append(c.toChar()) }
        val v = u32(s, p + 14).toInt(); val f = u16(s, p + 26); val dl = ((s.u(p + 30) and 0x03) shl 8) or s.u(p + 31)
        channels.add(VChannel((v shr 18) and 0x3ff, (v shr 8) and 0x3ff, name.toString().trim(), v and 0xff, u32(s, p + 18), u16(s, p + 22), u16(s, p + 24),
            f shr 14, (f shr 13) and 1 == 1, (f shr 12) and 1 == 1, (f shr 9) and 1 == 1, f and 0x3f, u16(s, p + 28), descriptors(s, p + 32, p + 32 + dl)))
        p += 32 + dl; i++
    }
    return Vct(s.u(0) == 0xc9, h.ext, h.version, h.section, h.last, channels)
}
/** GPS seconds (from 1980-01-06) less the GPS-UTC offset to Unix milliseconds. */
fun gpsToUnixMs(gps: Long, offset: Int): Long = (gps + 315_964_800L - offset) * 1000
class Stt(val gps: Long, val offset: Int, val utcMs: Long, val dsStatus: Boolean, val dsDay: Int, val dsHour: Int)
fun parseStt(s: ByteArray): Stt {
    val gps = u32(s, 9); val off = s.u(13); val ds = u16(s, 14)
    return Stt(gps, off, gpsToUnixMs(gps, off), (ds shr 15) == 1, (ds shr 8) and 0x1f, ds and 0xff)
}
class Event(val eventId: Int, val startGps: Long, val seconds: Int, val etm: Int, val title: String, val desc: Descriptors)
class Eit(val sourceId: Int, val version: Int, val section: Int, val last: Int, val events: List<Event>)
fun parseEit(s: ByteArray): Eit {
    val h = secHeader(s); val n = s.u(9); val events = ArrayList<Event>()
    var p = 10; var i = 0
    while (i < n && p + 10 <= s.size - 4) {
        val tl = s.u(p + 9)
        val title = firstText(mss(s, p + 10, p + 10 + tl))
        val q = p + 10 + tl; val dl = ((s.u(q) and 0x0f) shl 8) or s.u(q + 1)
        events.add(Event(((s.u(p) and 0x3f) shl 8) or s.u(p + 1), u32(s, p + 2), ((s.u(p + 6) and 0x0f) shl 16) or (s.u(p + 7) shl 8) or s.u(p + 8), (s.u(p + 6) shr 4) and 3, title, descriptors(s, q + 2, q + 2 + dl)))
        p = q + 2 + dl; i++
    }
    return Eit(h.ext, h.version, h.section, h.last, events)
}
class Ett(val version: Int, val etmId: Long, val sourceId: Int, val eventId: Int, val isEvent: Boolean, val text: String)
fun parseEtt(s: ByteArray): Ett {
    val h = secHeader(s); val id = u32(s, 9)
    return Ett(h.version, id, (id ushr 16).toInt(), ((id shr 2) and 0x3fff).toInt(), (id and 3L) == 2L, firstText(mss(s, 13, s.size - 4)))
}
class RrtValue(val abbrev: String, val text: String)
class RrtDim(val name: String, val graduated: Boolean, val values: List<RrtValue>)
class Rrt(val region: Int, val version: Int, val name: String, val dims: List<RrtDim>)
fun parseRrt(s: ByteArray): Rrt {
    val h = secHeader(s)
    var p = 9
    val nl = s.u(p++); val name = firstText(mss(s, p, p + nl)); p += nl
    val nd = s.u(p++); val dims = ArrayList<RrtDim>()
    var i = 0
    while (i < nd && p < s.size - 4) {
        val l = s.u(p++); val dn = firstText(mss(s, p, p + l)); p += l
        val graduated = (s.u(p) shr 4) and 1 == 1; val nv = s.u(p++) and 0x0f; val values = ArrayList<RrtValue>()
        for (k in 0 until nv) { val la = s.u(p++); val ab = firstText(mss(s, p, p + la)); p += la; val lr = s.u(p++); val rv = firstText(mss(s, p, p + lr)); p += lr; values.add(RrtValue(ab, rv)) }
        dims.add(RrtDim(dn, graduated, values)); i++
    }
    return Rrt(h.ext and 0xff, h.version, name, dims)
}

val STREAM_TYPES: Map<Int, String> = mapOf(
    0x01 to "MPEG-1 video", 0x02 to "MPEG-2 video", 0x03 to "MPEG-1 audio", 0x04 to "MPEG-2 audio", 0x05 to "private sections", 0x06 to "PES private data",
    0x0b to "DSM-CC data carousel", 0x0d to "DSM-CC", 0x0f to "AAC audio", 0x1b to "H.264 video", 0x24 to "HEVC video", 0x81 to "AC-3 audio", 0x87 to "E-AC-3 audio", 0x95 to "data service table",
)
val SERVICE_TYPES: Map<Int, String> = mapOf(1 to "ANALOG TV", 2 to "DIGITAL TV", 3 to "AUDIO", 4 to "DATA", 5 to "SOFTWARE", 6 to "UNASSOCIATED", 7 to "PARAMETERIZED", 8 to "ATSC 3.0", 9 to "ATSC 3.0 AUDIO")
fun isVideo(t: Int) = t == 0x02 || t == 0x01 || t == 0x1b || t == 0x24
fun isAudio(t: Int) = t == 0x81 || t == 0x87 || t == 0x03 || t == 0x04 || t == 0x0f
fun streamTypeName(t: Int) = STREAM_TYPES[t] ?: "type 0x${t.toString(16)}"
/** A content advisory as the station words it (its rating description), else its region and dimension values. */
fun ratingText(a: List<Advisory>?): String {
    if (a.isNullOrEmpty()) return ""
    val r = a.firstOrNull { it.text.isNotEmpty() } ?: a[0]
    return r.text.ifEmpty { "region ${r.region} ${r.dims.joinToString(" ") { "${it.first}:${it.second}" }}" }
}
