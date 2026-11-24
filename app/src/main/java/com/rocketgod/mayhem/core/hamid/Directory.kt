package com.rocketgod.mayhem.core.hamid

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Who and what an identity names, from worldwide sources only: DMR radio IDs (radioid.net's user list or per-ID
 * answers), talkgroup names (Brandmeister's), and repeaters (HearHam, Brandmeister devices) matched by frequency,
 * the tone or color code heard choosing between sites that share one. Parsers and lookups only. The same as the web's
 * dsp/hamid/directory.ts.
 */
fun parseCsv(text: String): List<List<String>> {
    val rows = ArrayList<List<String>>(); var row = ArrayList<String>(); val f = StringBuilder(); var q = false
    var i = 0
    while (i < text.length) {
        val c = text[i]
        if (q) { if (c == '"') { if (i + 1 < text.length && text[i + 1] == '"') { f.append('"'); i++ } else q = false } else f.append(c); i++; continue }
        when (c) {
            '"' -> q = true
            ',' -> { row.add(f.toString()); f.setLength(0) }
            '\n', '\r' -> { if (c == '\r' && i + 1 < text.length && text[i + 1] == '\n') i++; row.add(f.toString()); rows.add(row); row = ArrayList(); f.setLength(0) }
            else -> f.append(c)
        }
        i++
    }
    if (f.isNotEmpty() || row.isNotEmpty()) { row.add(f.toString()); rows.add(row) }
    return rows
}
private val WS = Regex("[ \\t\\n\\u000B\\f\\r]+")
/** Runs of ASCII white space as one space, none at either end (the same rule on every platform). */
private fun clean(s: String?) = (s ?: "").replace(WS, " ").removePrefix(" ").removeSuffix(" ")

data class RadioIdUser(val id: Int, val callsign: String, val name: String, val city: String, val state: String, val country: String)

class RadioIdTable private constructor(private val ids: IntArray, private val offs: IntArray, private val pool: String) {
    private var byCall: HashMap<String, Int>? = null
    val size: Int get() = ids.size

    companion object {
        private val DIGITS = Regex("^\\d+$")
        fun fromCsv(text: String): RadioIdTable {
            val rows = parseCsv(text)
            val start = if (rows.isNotEmpty() && !DIGITS.matches(clean(rows[0].getOrNull(0)))) 1 else 0
            val recs = ArrayList<Pair<Int, String>>()
            for (r in start until rows.size) {
                val c = rows[r]; val id = clean(c.getOrNull(0)).toIntOrNull() ?: continue
                if (id <= 0 || clean(c.getOrNull(1)).isEmpty()) continue
                val name = listOf(clean(c.getOrNull(2)), clean(c.getOrNull(3))).filter { it.isNotEmpty() }.joinToString(" ")
                recs.add(id to listOf(clean(c.getOrNull(1)).uppercase(), name, clean(c.getOrNull(4)), clean(c.getOrNull(5)), clean(c.getOrNull(6))).joinToString("|") { it.replace('|', '/') })
            }
            recs.sortWith(compareBy { it.first })
            val ids = IntArray(recs.size); val offs = IntArray(recs.size + 1); val sb = StringBuilder(); var o = 0
            recs.forEachIndexed { i, r -> ids[i] = r.first; offs[i] = o; sb.append(r.second); o += r.second.length }
            offs[recs.size] = o
            return RadioIdTable(ids, offs, sb.toString())
        }
    }
    private fun row(i: Int): RadioIdUser {
        val f = pool.substring(offs[i], offs[i + 1]).split('|')
        return RadioIdUser(ids[i], f[0], f[1], f[2], f[3], f[4])
    }
    fun byId(id: Int): RadioIdUser? {
        var lo = 0; var hi = ids.size - 1
        while (lo <= hi) { val m = (lo + hi) ushr 1; val v = ids[m]; if (v == id) return row(m); if (v < id) lo = m + 1 else hi = m - 1 }
        return null
    }
    fun byCallsign(call: String): RadioIdUser? {
        val map = byCall ?: HashMap<String, Int>().also { mp -> for (i in ids.indices) { val p = pool.indexOf('|', offs[i]); val c = pool.substring(offs[i], p); if (!mp.containsKey(c)) mp[c] = i }; byCall = mp }
        val i = map[call.trim().uppercase()] ?: return null
        return row(i)
    }
}

data class Talkgroup(val id: Int, val name: String, val network: String)
class TalkgroupTable {
    private val nets = LinkedHashMap<String, HashMap<Int, String>>()
    fun addList(list: List<Talkgroup>) { for (t in list) nets.getOrPut(t.network) { HashMap() }[t.id] = t.name }
    /** Brandmeister's /v2/talkgroup answer: { "91": "World-wide", ... }. */
    fun addBrandmeister(json: String): Int {
        val o = JSONObject(json); val list = ArrayList<Talkgroup>()
        for (k in o.keys()) { val id = k.toIntOrNull() ?: continue; val v = o.opt(k); if (id >= 0 && v is String && v.isNotBlank()) list.add(Talkgroup(id, v.trim(), "Brandmeister")) }
        addList(list); return list.size
    }
    fun lookup(id: Int, network: String = ""): Talkgroup? {
        val order = (listOf(network, "Brandmeister") + nets.keys).filter { it.isNotEmpty() }.distinct()
        for (n in order) { val name = nets[n]?.get(id); if (name != null) return Talkgroup(id, name, n) }
        return null
    }
}

class Repeater {
    var name = ""; var call = ""; var site = ""; var city = ""; var mode = ""; var outputHz = 0L; var inputHz = 0L
    var tone = ""; var cc = -1; var network = ""; var lat = Double.NaN; var lon = Double.NaN; var status = ""; var source = ""
}

private val FREQ_RE = Regex("^\\s*(\\d{2,4}\\.\\d+)\\s*([+\\-s])?")
/** "446.580-" → output and input (Hz) with the band's standard split; "144.460 s" is simplex. */
fun parseFreqField(s: String): Pair<Long, Long>? {
    val m = FREQ_RE.find(s) ?: return null
    val out = Math.round(m.groupValues[1].toDouble() * 1e6)
    val split = if (out < 148_000_000) 600_000L else if (out < 230_000_000) 1_600_000L else if (out < 470_000_000) 5_000_000L else 12_000_000L
    val inp = when (m.groupValues[2]) { "-" -> out - split; "+" -> out + split; else -> out }
    return out to inp
}

private fun jstr(o: JSONObject, k: String) = if (o.isNull(k)) "" else o.opt(k)?.toString() ?: ""
private fun jnum(o: JSONObject, k: String): Double = when (val v = o.opt(k)) { is Number -> v.toDouble(); is String -> v.toDoubleOrNull() ?: Double.NaN; else -> Double.NaN }

fun parseHearHam(json: String): List<Repeater> {
    val a = JSONArray(json); val out = ArrayList<Repeater>()
    for (i in 0 until a.length()) {
        val o = a.getJSONObject(i); val f = jnum(o, "frequency"); val off = jnum(o, "offset").let { if (it.isNaN()) 0.0 else it }
        if (!(f > 0)) continue
        val rp = Repeater()
        rp.call = clean(jstr(o, "callsign")).uppercase(); rp.name = rp.call; rp.city = clean(jstr(o, "city"))
        rp.mode = clean(jstr(o, "mode")); rp.outputHz = Math.round(f); rp.inputHz = Math.round(f + off)
        rp.tone = clean(jstr(o, "encode")); rp.network = clean(jstr(o, "group")); rp.lat = jnum(o, "latitude"); rp.lon = jnum(o, "longitude")
        val op = o.opt("operational"); rp.status = if (op == 0 || op == false) "Down" else ""; rp.source = "hearham.com"
        out.add(rp)
    }
    return out
}

fun parseBrandmeisterDevices(json: String): List<Repeater> {
    val a = JSONArray(json); val out = ArrayList<Repeater>()
    for (i in 0 until a.length()) {
        val o = a.getJSONObject(i); val tx = jnum(o, "tx"); val rx = jnum(o, "rx")
        if (!(tx > 0) || !(rx > 0) || tx == rx) continue
        val rp = Repeater()
        rp.call = clean(jstr(o, "callsign")).uppercase(); rp.name = rp.call; rp.city = clean(jstr(o, "city"))
        rp.mode = "DMR"; rp.outputHz = Math.round(tx * 1e6); rp.inputHz = Math.round(rx * 1e6); rp.cc = jnum(o, "colorcode").let { if (it.isNaN()) -1 else it.toInt() }
        rp.network = "Brandmeister"; rp.lat = jnum(o, "lat"); rp.lon = jnum(o, "lng"); rp.source = "brandmeister.network"
        out.add(rp)
    }
    return out
}

private fun km(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
    val r = Math.PI / 180; val x = (bLon - aLon) * r * cos((aLat + bLat) * r / 2); val y = (bLat - aLat) * r
    return 6371 * sqrt(x * x + y * y)
}

/** A directory's mode text as the decoder's names: FM, DMR, DSTAR, YSF, P25, NXDN (several, space separated). */
fun modeKey(m: String): String {
    val u = m.uppercase(); val out = ArrayList<String>()
    if (Regex("D-?STAR|DSTAR").containsMatchIn(u)) out.add("DSTAR")
    if (Regex("FUSION|C4FM|YSF|SYSTEM FUSION").containsMatchIn(u)) out.add("YSF")
    if (Regex("DMR|MOTOTRBO").containsMatchIn(u)) out.add("DMR")
    if (Regex("P25|APCO").containsMatchIn(u)) out.add("P25")
    if (Regex("NXDN").containsMatchIn(u)) out.add("NXDN")
    if (Regex("\\bFM\\b|ANALOG|^FM|NFM").containsMatchIn(u) || out.isEmpty()) out.add("FM")
    return out.joinToString(" ")
}
private val DCS_RE = Regex("(\\d{3})\\s*(DPL|DCS)|D(\\d{3})", RegexOption.IGNORE_CASE)
/** "127.3" equals "127.3 Hz"; "073 DPL" equals "D073". */
fun toneEq(a: String, b: String): Boolean {
    fun n(s: String): String {
        DCS_RE.find(s)?.let { val g = it.groupValues; return "D" + g[1].ifEmpty { g[3] } }
        val f = Regex("^\\s*[+-]?\\d*\\.?\\d+").find(s)?.value?.trim()?.toDoubleOrNull()
        return if (f != null) String.format(java.util.Locale.US, "%.1f", f) else s.trim().uppercase()
    }
    return n(a) == n(b)
}

class RepeaterDirectory {
    val list = ArrayList<Repeater>()
    fun add(rs: List<Repeater>) { list.addAll(rs) }
    fun at(hz: Long, tolHz: Long = 2_500, tone: String? = null, cc: Int? = null, mode: String? = null, lat: Double? = null, lon: Double? = null, maxKm: Double? = null): List<Repeater> {
        val want = if (mode == null) "" else modeKey(mode)
        val c = list.filter { kotlin.math.abs(it.outputHz - hz) <= tolHz && (want.isEmpty() || it.mode.isEmpty() || modeKey(it.mode).split(' ').contains(want)) }
        fun near(r: Repeater): Double = if (lat != null && lon != null && r.lat.isFinite() && r.lon.isFinite()) km(lat, lon, r.lat, r.lon) else Double.NaN
        val kept = c.filter { val d = near(it); !(maxKm != null && d.isFinite() && d > maxKm) }
        fun score(r: Repeater): Double {
            var s = 0.0
            if (!tone.isNullOrEmpty() && r.tone.isNotEmpty() && toneEq(r.tone, tone)) s += 100 else if (!tone.isNullOrEmpty() && r.tone.isNotEmpty()) s -= 50
            if (cc != null && cc >= 0 && r.cc >= 0) s += if (r.cc == cc) 100 else -50
            if (r.status == "Down") s -= 10
            val d = near(r); if (d.isFinite()) s -= min(40.0, d / 10)
            return s
        }
        return kept.map { it to score(it) }.sortedWith(compareByDescending<Pair<Repeater, Double>> { it.second }.thenBy { it.first.name }).map { it.first }
    }
    fun byCall(call: String): Repeater? { val c = call.trim().uppercase(); return list.firstOrNull { it.call == c } }
}

/** radioid.net's per-ID answer (/api/dmr/user/?id=): its first result, or null. */
fun parseRadioIdApi(json: String): RadioIdUser? {
    val r = JSONObject(json).optJSONArray("results")?.optJSONObject(0) ?: return null
    val id = if (r.has("radio_id")) r.optInt("radio_id") else r.optInt("id")
    val call = clean(jstr(r, "callsign"))
    if (id <= 0 || call.isEmpty()) return null
    val name = listOf(clean(if (r.has("fname")) jstr(r, "fname") else jstr(r, "name")), clean(jstr(r, "surname"))).filter { it.isNotEmpty() }.joinToString(" ")
    return RadioIdUser(id, call.uppercase(), name, clean(jstr(r, "city")), clean(jstr(r, "state")), clean(jstr(r, "country")))
}

data class CallRecord(val callsign: String, val name: String, val city: String, val state: String, val grid: String, val lat: Double, val lon: Double, val licenseClass: String, val source: String)
private val CITY_RE = Regex("^(.*?),\\s*([A-Z]{2})\\s+\\d{5}")
/** What callook.info's JSON says about a US callsign. */
fun parseCallook(json: String): CallRecord? {
    val j = JSONObject(json)
    if (j.optString("status") != "VALID") return null
    val cur = j.optJSONObject("current") ?: return null
    val call = cur.optString("callsign"); if (call.isEmpty()) return null
    val line2 = j.optJSONObject("address")?.optString("line2") ?: ""
    val m = CITY_RE.find(line2); val loc = j.optJSONObject("location")
    return CallRecord(call.uppercase(), clean(j.optString("name")), if (m != null) clean(m.groupValues[1]) else clean(line2), m?.groupValues?.get(2) ?: "",
        clean(loc?.optString("gridsquare")), loc?.optString("latitude")?.toDoubleOrNull() ?: Double.NaN, loc?.optString("longitude")?.toDoubleOrNull() ?: Double.NaN,
        clean(cur.optString("operClass")), "callook.info")
}
private val CALL_RE = Regex("^[A-Z0-9]{1,3}\\d[A-Z]{1,4}$")
private val SPLIT_RE = Regex("[\\s/-]")
/** A plausible amateur callsign heard on the air (what may be looked up), base call only. */
fun lookupKey(heard: String): String {
    val s = heard.trim().uppercase().split(SPLIT_RE).firstOrNull() ?: ""
    return if (CALL_RE.matches(s) && s.any { it in 'A'..'Z' }) s else ""
}
