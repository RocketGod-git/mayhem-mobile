package com.rocketgod.mayhem.core.cell

import kotlin.math.abs
import kotlin.math.min

/*
 * ETWS and CMAS (Wireless Emergency Alerts) content from SIB10, SIB11 and SIB12:
 *   36.331 SIB10/11/12 fields; SIB11/SIB12 segments are joined in segment-number order up to lastSegment.
 *   23.041 9.4.1.2.1 Serial Number (GS 2 bits, Message Code 10 bits, Update Number 4 bits),
 *          9.4.1.2.2 Message Identifier, 9.3.24 Warning Type, 9.4.2.2.5 CB Data (pages of 82 octets + 1 length octet).
 *   23.038 5 CBS Data Coding Scheme, 6.2.1 GSM 7-bit default alphabet and extension table, 6.1.2.2 packing.
 */
private val MSG_ID: Map<Int, String> = HashMap<Int, String>().also { m ->
    m.putAll(mapOf(
        4352 to "ETWS earthquake warning", 4353 to "ETWS tsunami warning", 4354 to "ETWS earthquake and tsunami warning",
        4355 to "ETWS test message", 4356 to "ETWS other emergency type",
        4370 to "CMAS Presidential Level Alert",
        4371 to "CMAS Extreme Alert (Extreme, Immediate, Observed)",
        4372 to "CMAS Extreme Alert (Extreme, Immediate, Likely)",
        4373 to "CMAS Severe Alert (Extreme, Expected, Observed)",
        4374 to "CMAS Severe Alert (Extreme, Expected, Likely)",
        4375 to "CMAS Severe Alert (Severe, Immediate, Observed)",
        4376 to "CMAS Severe Alert (Severe, Immediate, Likely)",
        4377 to "CMAS Severe Alert (Severe, Expected, Observed)",
        4378 to "CMAS Severe Alert (Severe, Expected, Likely)",
        4379 to "CMAS Child Abduction Emergency (AMBER Alert)",
        4380 to "CMAS Required Monthly Test",
        4381 to "CMAS Exercise",
        4382 to "CMAS operator defined use",
        4396 to "CMAS Public Safety Alert",
        4398 to "CMAS State/Local WEA Test",
        4400 to "CMAS geo-fencing trigger",
    ))
    for (i in 4383..4395) m[i] = m[i - 13] + " (additional language)"
    m[4397] = m[4396] + " (additional language)"
    m[4399] = m[4398] + " (additional language)"
}

/** The primary-language identifier of an additional-language CMAS identifier (the same id otherwise). */
fun baseId(id: Int): Int = when { id in 4383..4395 -> id - 13; id == 4397 || id == 4399 -> id - 1; else -> id }
fun isWarningId(id: Int) = id in 4352..4356 || id in 4370..4400
fun isAdditionalLanguage(id: Int) = baseId(id) != id
fun category(id: Int): String = MSG_ID[id] ?: when { id in 4352..4359 -> "ETWS reserved"; id in 4370..4399 -> "CMAS reserved"; else -> "not an ETWS or CMAS identifier" }

data class CmasClass(val label: String, val rank: Int, val kind: String)
/** Short class label and a severity rank for color: 5 Presidential/ETWS disaster, 4 Extreme, 3 Severe/AMBER, 2 Public Safety, 1 tests and others. */
fun cmasClass(id: Int): CmasClass {
    val b = baseId(id)
    return when {
        b == 4352 -> CmasClass("ETWS Earthquake", 5, "ETWS")
        b == 4353 -> CmasClass("ETWS Tsunami", 5, "ETWS")
        b == 4354 -> CmasClass("ETWS Earthquake and Tsunami", 5, "ETWS")
        b == 4355 -> CmasClass("ETWS Test", 1, "ETWS")
        b == 4356 -> CmasClass("ETWS Other", 4, "ETWS")
        b == 4370 -> CmasClass("Presidential", 5, "CMAS")
        b == 4371 || b == 4372 -> CmasClass("Extreme", 4, "CMAS")
        b in 4373..4378 -> CmasClass("Severe", 3, "CMAS")
        b == 4379 -> CmasClass("AMBER", 3, "CMAS")
        b == 4380 -> CmasClass("Required Monthly Test", 1, "CMAS")
        b == 4381 -> CmasClass("Exercise", 1, "CMAS")
        b == 4382 -> CmasClass("Operator", 1, "CMAS")
        b == 4396 -> CmasClass("Public Safety", 2, "CMAS")
        b == 4398 -> CmasClass("State/Local Test", 1, "CMAS")
        b == 4400 -> CmasClass("Geo-fencing trigger", 1, "CMAS")
        id in 4352..4359 -> CmasClass("ETWS", 1, "ETWS")
        id in 4370..4399 -> CmasClass("CMAS", 1, "CMAS")
        else -> CmasClass("Unknown", 0, "")
    }
}

const val GSM7 = "@£\$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
private val GSM7_EXT = linkedMapOf(0x0a to "\u000c", 0x14 to "^", 0x28 to "{", 0x29 to "}", 0x2f to "\\", 0x3c to "[", 0x3d to "~", 0x3e to "]", 0x40 to "|", 0x65 to "€")

/** 23.038 6.1.2.2: septets packed least significant bit first. */
fun unpack7(octets: ByteArray, nChars: Int? = null): List<Int> {
    var bits = 0L; var nb = 0
    val out = ArrayList<Int>()
    for (o in octets) {
        bits = bits or ((o.toLong() and 0xff) shl nb); nb += 8
        while (nb >= 7) { out.add((bits and 0x7f).toInt()); bits = bits ushr 7; nb -= 7 }
    }
    return if (nChars == null) out else out.take(nChars)
}
fun pack7(septets: List<Int>): ByteArray {
    var bits = 0L; var nb = 0
    val out = ArrayList<Byte>()
    for (s in septets) { bits = bits or (s.toLong() shl nb); nb += 7; while (nb >= 8) { out.add((bits and 0xff).toByte()); bits = bits ushr 8; nb -= 8 } }
    if (nb > 0) out.add((bits and 0xff).toByte())
    return out.toByteArray()
}
fun gsm7Text(septets: List<Int>): String {
    val s = StringBuilder(); var esc = false
    for (c in septets) {
        if (esc) { s.append(GSM7_EXT[c] ?: "?"); esc = false }
        else if (c == 0x1b) esc = true
        else s.append(GSM7[c])
    }
    return s.toString()
}
/** GSM 7-bit septets for a text (default alphabet and extension table); unknown characters become '?'. */
fun gsm7Septets(text: String): List<Int> {
    val out = ArrayList<Int>()
    var i = 0
    while (i < text.length) {
        val cp = text.codePointAt(i); val ch = String(Character.toChars(cp)); i += Character.charCount(cp)
        val j = GSM7.indexOf(ch)
        if (j >= 0 && ch != "\u001b") { out.add(j); continue }
        val e = GSM7_EXT.entries.firstOrNull { it.value == ch }
        if (e != null) { out.add(0x1b); out.add(e.key) } else out.add(GSM7.indexOf('?'))
    }
    return out
}

data class DcsInfo(val alphabet: String, val language: String?, val languagePrefix: Boolean)
/** 23.038 5 (CBS Data Coding Scheme): alphabet, the language it names, and whether the text starts with a language code. */
fun dcsInfo(dcs: Int): DcsInfo {
    val g = dcs shr 4; val lo = dcs and 15
    return when {
        g == 0 -> DcsInfo("GSM7", listOf("German", "English", "Italian", "French", "Spanish", "Dutch", "Swedish", "Danish", "Portuguese", "Finnish", "Norwegian", "Greek", "Turkish", "Hungarian", "Polish", "unspecified")[lo], false)
        g == 1 -> DcsInfo(if (lo == 1) "UCS2" else "GSM7", null, lo <= 1)
        g == 2 -> DcsInfo("GSM7", listOf("Czech", "Hebrew", "Arabic", "Russian", "Icelandic").getOrNull(lo), false)
        g == 3 -> DcsInfo("GSM7", null, false)
        g in 4..7 || g == 9 -> DcsInfo(listOf("GSM7", "8bit", "UCS2", "reserved")[(dcs shr 2) and 3], null, false)
        g == 15 -> DcsInfo(if (dcs and 4 != 0) "8bit" else "GSM7", null, false)
        else -> DcsInfo("unknown", null, false)
    }
}

data class CbContent(val pages: Int, val alphabet: String, val language: String?, val text: String, val binaryHex: String? = null)

private val TRAIL_CRLF = Regex("[\\r\\n]+$")
private val TRAIL_CRLF0 = Regex("[\\r\\n\\u0000]+$")
/** CB Data (23.041 9.4.2.2.5): number of pages, then each page as 82 octets and its information length. */
fun cbDataText(cb: ByteArray, dcs: Int): CbContent {
    val n = if (cb.isNotEmpty()) cb[0].toInt() and 0xff else 0
    val info = dcsInfo(dcs)
    val parts = ArrayList<ByteArray>()
    var p = 1
    var i = 0
    while (i < n && p < cb.size) {
        val page = cb.copyOfRange(p, min(cb.size, p + 82))
        val ln = if (p + 82 < cb.size) min(cb[p + 82].toInt() and 0xff, 82) else page.size
        parts.add(page.copyOfRange(0, min(ln, page.size)))
        p += 83; i++
    }
    var language = info.language; var text: String
    when (info.alphabet) {
        "GSM7" -> {
            text = parts.joinToString("") { d -> gsm7Text(unpack7(d, d.size * 8 / 7)) }
            text = text.replace(TRAIL_CRLF, "")
            if (info.languagePrefix) { language = text.take(2); text = if (text.length > 3) text.substring(3) else "" }
        }
        "UCS2" -> {
            val all = parts.fold(ByteArray(0)) { a, b -> a + b }
            var start = 0
            if (info.languagePrefix) { language = gsm7Text(unpack7(all.copyOfRange(0, min(2, all.size)), 2)); start = 2 }
            val sb = StringBuilder()
            var k = start
            while (k + 1 < all.size) { sb.append((((all[k].toInt() and 0xff) shl 8) or (all[k + 1].toInt() and 0xff)).toChar()); k += 2 }
            text = sb.toString().replace(TRAIL_CRLF0, "")
        }
        else -> return CbContent(n, info.alphabet, language, "", parts.joinToString("") { hexOf(it) })
    }
    return CbContent(n, info.alphabet, language, text)
}

data class SerialInfo(val scope: String, val messageCode: Int, val updateNumber: Int)
fun serialInfo(sn: Int): SerialInfo =
    SerialInfo(listOf("cell-wide (immediate)", "PLMN-wide", "tracking-area-wide", "cell-wide")[(sn shr 14) and 3], (sn shr 4) and 0x3ff, sn and 15)

data class WarningType(val type: String, val userAlert: Boolean, val popup: Boolean)
/** 23.041 9.3.24 Warning Type (SIB10): 7-bit type, emergency user alert, popup. */
fun warningTypeInfo(hex: String): WarningType {
    val v = hex.take(4).padEnd(4, '0').toIntOrNull(16) ?: 0
    val t = v shr 9
    return WarningType(listOf("earthquake", "tsunami", "earthquake and tsunami", "test", "other").getOrNull(t) ?: "reserved $t", v and 0x100 != 0, v and 0x80 != 0)
}

private val BIN = Regex("^[01]+$")
internal fun bitsNum(s: Any?): Long = if (s is String && BIN.matches(s)) s.toLong(2) else -1

data class WarningMessage(
    val key: String, val kind: String, val source: String,
    val id: Int, val serial: Int, val scope: String, val messageCode: Int, val updateNumber: Int,
    val category: String, val cls: String, val rank: Int, val additionalLanguage: Boolean,
    var warningType: WarningType? = null,
    var complete: Boolean = false, var segments: List<Int> = emptyList(), var lastSegment: Int = -1,
    var dcs: Int = -1, var alphabet: String = "", var language: String? = null, var pages: Int = 0, var text: String = "", var binaryHex: String = "",
    var areaHex: String = "", val cells: MutableList<String> = ArrayList(), var firstMs: Long = 0, var lastMs: Long = 0, var receptions: Int = 0,
) {
    /** A copy that later changes to this one never reach (snapshots). */
    fun frozen(): WarningMessage = copy(cells = ArrayList(cells))
}

private class Seg(val data: String, val area: String, val dcs: Int)
private class Pending(val msg: WarningMessage, val seg: java.util.TreeMap<Int, Seg>)

/** Collects SIB10/SIB11/SIB12 from any number of cells into whole messages, one per message identifier and serial number. */
class WarningAssembler {
    private val map = LinkedHashMap<String, Pending>()

    /** Feeds one decoded SIB; returns the message it belongs to when that message is new, completed or carried by a new cell. */
    @Synchronized
    fun add(sib: String, v: Obj, cell: String, ms: Long): WarningMessage? {
        val r9 = sib.startsWith("sib12")
        fun f(n: String): Any? = v[if (r9) "$n-r9" else n]
        val id = bitsNum(f("messageIdentifier")); val serial = bitsNum(f("serialNumber"))
        if (id < 0 || serial < 0) return null
        val key = "$id/$serial"
        var p = map[key]; var changed = false
        if (p == null) {
            val c = cmasClass(id.toInt()); val s = serialInfo(serial.toInt())
            p = Pending(WarningMessage(key, c.kind, if (sib == "sib10") "SIB10" else if (r9) "SIB12" else "SIB11", id.toInt(), serial.toInt(), s.scope, s.messageCode, s.updateNumber,
                category(id.toInt()), c.label, c.rank, isAdditionalLanguage(id.toInt()), firstMs = ms, lastMs = ms), java.util.TreeMap())
            map[key] = p
            changed = true
        }
        val m = p.msg
        m.lastMs = maxOf(m.lastMs, ms); m.firstMs = minOf(m.firstMs, ms); m.receptions++
        if (cell !in m.cells) { m.cells.add(cell); changed = true }
        if (sib == "sib10") {
            val wt = v["warningType"]
            if (wt is String && m.warningType == null) { m.warningType = warningTypeInfo(wt); m.complete = true; changed = true }
            return if (changed) m.frozen() else null
        }
        val num = (f("warningMessageSegmentNumber") as? Number)?.toInt() ?: -1
        if (!p.seg.containsKey(num)) {
            val dcsHex = f("dataCodingScheme")
            p.seg[num] = Seg((f("warningMessageSegment") ?: "").toString(), (v["warningAreaCoordinatesSegment-r15"] ?: "").toString(), if (dcsHex is String) dcsHex.toIntOrNull(16) ?: -1 else -1)
            if (f("warningMessageSegmentType") == "lastSegment") m.lastSegment = num
            m.segments = p.seg.keys.toList()
            changed = true
            if (!m.complete && m.lastSegment >= 0 && m.segments.size >= m.lastSegment + 1 && m.segments.withIndex().all { (i, n) -> n == i }) finish(p)
        }
        return if (changed) m.frozen() else null
    }

    private fun finish(p: Pending) {
        val m = p.msg; val segs = m.segments.take(m.lastSegment + 1).map { p.seg.getValue(it) }
        val dcs = if (segs[0].dcs >= 0) segs[0].dcs else 0x0f
        val c = cbDataText(hexToBytes(segs.joinToString("") { it.data }), dcs)
        m.dcs = dcs; m.alphabet = c.alphabet; m.language = c.language; m.pages = c.pages; m.text = c.text; m.binaryHex = c.binaryHex ?: ""
        m.areaHex = segs.joinToString("") { it.area }
        m.complete = true
    }

    @Synchronized
    fun messages(): List<WarningMessage> = map.values.map { it.msg.frozen() }.sortedByDescending { it.firstMs }
    /** Restores messages kept from an earlier session (complete ones only; their segments are not needed again). */
    @Synchronized
    fun restore(list: List<WarningMessage>) {
        for (m in list) if (m.key.isNotEmpty() && !map.containsKey(m.key)) {
            val seg = java.util.TreeMap<Int, Seg>(); for (n in m.segments) seg[n] = Seg("", "", m.dcs)
            map[m.key] = Pending(m.frozen(), seg)
        }
    }
    @Synchronized
    fun clear() = map.clear()
}

/** One alert: the messages of one category sent together in several languages (same class, overlapping cells, within 10 minutes). */
class AlertGroup(val key: String, val cls: String, val rank: Int, val kind: String, var firstMs: Long, var lastMs: Long, val cells: MutableList<String>, val messages: MutableList<WarningMessage>)
fun groupAlerts(msgs: List<WarningMessage>): List<AlertGroup> {
    val out = ArrayList<AlertGroup>()
    for (m in msgs.sortedBy { it.firstMs }) {
        val b = baseId(m.id)
        val g = out.firstOrNull { x -> baseId(x.messages[0].id) == b && abs(x.firstMs - m.firstMs) < 600_000 && x.cells.any { it in m.cells } && x.messages.none { it.id == m.id } }
        if (g != null) { g.messages.add(m); g.lastMs = maxOf(g.lastMs, m.lastMs); for (c in m.cells) if (c !in g.cells) g.cells.add(c) }
        else out.add(AlertGroup(m.key, m.cls, m.rank, m.kind, m.firstMs, m.lastMs, ArrayList(m.cells), arrayListOf(m)))
    }
    for (g in out) g.messages.sortWith(compareBy<WarningMessage> { if (it.additionalLanguage) 1 else 0 }.thenBy { it.id })
    return out.sortedByDescending { it.firstMs }
}
