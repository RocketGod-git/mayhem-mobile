package com.rocketgod.mayhem.core.ham

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Calendar
import java.util.TimeZone
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.roundToLong
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * Callsign know-how for the logbook: prefix → country / continent (offline, the common allocations), US call
 * areas, portable / DX-prefix parsing, Maidenhead grid squares with distance and bearing, and online lookups
 * (HamQTH's open DXCC service for entity and zones, hamdb.org and callook.info for name, QTH and grid).
 * Twin of web/src/callsign.ts.
 */

data class CallInfo(
    val call: String, val base: String, val prefix: String,
    var country: String? = null, var continent: String? = null, var cq: Int? = null, var itu: Int? = null,
    var lat: Double? = null, var lon: Double? = null, var utc: Double? = null,
    var name: String? = null, var qth: String? = null, var grid: String? = null, var cls: String? = null, var source: String = "",
)

data class ParsedCall(val call: String, val base: String, val prefix: String, val portable: String)

private val US_AREAS = mapOf("1" to "New England", "2" to "New York / New Jersey", "3" to "Pennsylvania / Delaware / Maryland / DC",
    "4" to "Southeast", "5" to "South Central", "6" to "California", "7" to "Northwest / Mountain", "8" to "Michigan / Ohio / West Virginia",
    "9" to "Illinois / Indiana / Wisconsin", "0" to "Midwest")

private val PORTABLE = Regex("^(P|M|MM|AM|QRP|A|R|B|J|LH|\\d)$")
private val CALL_A = Regex("^[A-Z0-9]{1,3}\\d[A-Z]{1,4}$")
private val CALL_B = Regex("^\\d[A-Z]\\d[A-Z]{1,4}$")

/** Split "VE3/W1AW/P" into the home call, the DX prefix it is operating under and the portable designator. */
fun parseCall(raw: String): ParsedCall {
    val call = raw.trim().uppercase().replace(Regex("[^A-Z0-9/]"), "")
    val parts = call.split('/').filter { it.isNotEmpty() }.toMutableList()
    if (parts.isEmpty()) return ParsedCall("", "", "", "")
    val portables = ArrayList<String>()
    while (parts.size > 1 && PORTABLE.matches(parts.last())) portables.add(0, parts.removeAt(parts.size - 1))
    fun looksLikeCall(s: String) = CALL_A.matches(s) || CALL_B.matches(s)
    var base = parts[0]; var prefix = ""
    if (parts.size >= 2) {
        val a = parts[0]; val b = parts[1]
        if (looksLikeCall(a) && looksLikeCall(b)) { base = if (a.length >= b.length) a else b; prefix = if (base == a) b else a }
        else if (looksLikeCall(b)) { base = b; prefix = a }
        else { base = a; prefix = b }
    }
    val m = Regex("^([A-Z0-9]{1,3}?\\d)").find(base)
    return ParsedCall(call, base, prefix.ifEmpty { m?.groupValues?.get(1) ?: base.take(2) }, portables.joinToString("/"))
}

/** Offline entity from the prefix (or the DX prefix when there is one). */
fun offlineInfo(raw: String): CallInfo {
    val p = parseCall(raw)
    val key = if (p.prefix.isNotEmpty() && p.prefix != p.base.take(p.prefix.length)) p.prefix else p.base
    val hit = CALL_PREFIXES.firstOrNull { key.startsWith(it.first) }
    val info = CallInfo(p.call, p.base, p.prefix, source = "prefix table")
    if (hit != null) {
        info.country = hit.second; info.continent = hit.third
        if (hit.second == "United States") {
            val d = Regex("\\d").find(p.base)?.value
            if (d != null && US_AREAS[d] != null) info.qth = "call area $d · ${US_AREAS[d]}"
        }
    }
    if (p.portable.isNotEmpty()) info.qth = (info.qth?.let { "$it · " } ?: "") + "/${p.portable}"
    return info
}

// ------------------------------------------------------------------------------------------ Maidenhead
private val GRID_RE = Regex("^[A-R]{2}\\d{2}([A-X]{2}(\\d{2})?)?$")

fun gridToLatLon(grid: String): Pair<Double, Double>? {
    val g = grid.trim().uppercase()
    if (!GRID_RE.matches(g)) return null
    var lon = (g[0] - 'A') * 20.0 - 180; var lat = (g[1] - 'A') * 10.0 - 90
    lon += (g[2] - '0') * 2; lat += (g[3] - '0')
    if (g.length >= 6) { lon += (g[4] - 'A') * 2.0 / 24; lat += (g[5] - 'A') / 24.0 }
    if (g.length >= 8) { lon += (g[6] - '0') * 2.0 / 240; lat += (g[7] - '0') / 240.0 }
    val w = if (g.length >= 8) 2.0 / 240 else if (g.length >= 6) 2.0 / 24 else 2.0
    val h = if (g.length >= 8) 1.0 / 240 else if (g.length >= 6) 1.0 / 24 else 1.0
    return (lat + h / 2) to (lon + w / 2)
}

fun latLonToGrid(latIn: Double, lonIn: Double, len: Int = 6): String {
    var lon = lonIn + 180; var lat = latIn + 90
    val sb = StringBuilder()
    sb.append('A' + floor(lon / 20).toInt()).append('A' + floor(lat / 10).toInt())
    lon %= 20; lat %= 10
    sb.append(floor(lon / 2).toInt()).append(floor(lat).toInt())
    if (len >= 6) { lon %= 2; lat %= 1; sb.append('a' + floor(lon * 12).toInt()).append('a' + floor(lat * 24).toInt()) }
    if (len >= 8) { lon = (lon * 12) % 1; lat = (lat * 24) % 1; sb.append(floor(lon * 10).toInt()).append(floor(lat * 10).toInt()) }
    return sb.toString()
}

/** Great-circle distance (km) and initial bearing (°) from 1 to 2. */
fun distanceBearing(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Pair<Double, Double> {
    val r = Math.PI / 180; val p1 = lat1 * r; val p2 = lat2 * r; val dl = (lon2 - lon1) * r
    val a = sin((p2 - p1) / 2).let { it * it } + cos(p1) * cos(p2) * sin(dl / 2).let { it * it }
    val km = 6371 * 2 * atan2(sqrt(a), sqrt(1 - a))
    val y = sin(dl) * cos(p2); val x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl)
    return km to (atan2(y, x) / r + 360) % 360
}

// ------------------------------------------------------------------------------------------ online
private fun fetchText(url: String, ms: Int = 7000): String {
    val c = URL(url).openConnection() as HttpURLConnection
    c.connectTimeout = ms; c.readTimeout = ms
    c.setRequestProperty("User-Agent", "MayhemMobile")
    try {
        if (c.responseCode !in 200..299) throw IllegalStateException("HTTP ${c.responseCode}")
        return c.inputStream.bufferedReader().use { it.readText() }
    } finally { c.disconnect() }
}

private fun xmlField(xml: String, tag: String) = Regex("<$tag>([^<]*)</$tag>").find(xml)?.groupValues?.get(1)?.trim()
private val pool = Executors.newFixedThreadPool(3)

/** Merge the free online sources over the offline guess. Blocking (call off the main thread); never throws. */
fun lookupCall(raw: String): CallInfo {
    val info = offlineInfo(raw)
    val call = info.base.ifEmpty { info.call }
    if (call.isEmpty()) return info
    val enc = URLEncoder.encode(call, "UTF-8")
    val us = info.country in setOf("United States", "Hawaii", "Alaska", "Puerto Rico")
    val fDxcc = pool.submit(Callable { fetchText("https://www.hamqth.com/dxcc.php?callsign=$enc") })
    val fHamdb = pool.submit(Callable { fetchText("https://api.hamdb.org/v1/$enc/json/mayhem-mobile") })
    val fCallook = if (us) pool.submit(Callable { fetchText("https://callook.info/$enc/json") }) else null
    val sources = ArrayList<String>()
    runCatching { fDxcc.get(8, TimeUnit.SECONDS) }.getOrNull()?.takeIf { it.contains("<dxcc>") }?.let { x ->
        xmlField(x, "name")?.let { info.country = it; sources.add("HamQTH") }
        xmlField(x, "continent")?.let { info.continent = it }
        xmlField(x, "cq")?.toIntOrNull()?.let { info.cq = it }
        xmlField(x, "itu")?.toIntOrNull()?.let { info.itu = it }
        val la = xmlField(x, "lat")?.toDoubleOrNull(); val lo = xmlField(x, "lng")?.toDoubleOrNull()
        if (la != null && lo != null) { info.lat = la; info.lon = lo }
        xmlField(x, "utc")?.toDoubleOrNull()?.let { info.utc = it }
    }
    runCatching {
        val j = JSONObject(fHamdb.get(8, TimeUnit.SECONDS)).optJSONObject("hamdb")?.optJSONObject("callsign")
        if (j != null && j.optString("call").let { it.isNotEmpty() && it != "NOT_FOUND" }) {
            fun ok(k: String) = j.optString(k).takeIf { it.isNotEmpty() && it != "NOT_FOUND" }
            val nm = listOfNotNull(ok("fname"), ok("name")).joinToString(" ").trim()
            if (nm.isNotEmpty()) info.name = nm
            val q = listOfNotNull(ok("addr2"), ok("state"), ok("country")).joinToString(", ")
            if (q.isNotEmpty()) info.qth = q
            ok("grid")?.let { info.grid = it }
            ok("class")?.let { info.cls = it }
            val la = ok("lat")?.toDoubleOrNull(); val lo = ok("lon")?.toDoubleOrNull()
            if (la != null && lo != null) { info.lat = la; info.lon = lo }
            sources.add("hamdb")
        }
    }
    if (fCallook != null) runCatching {
        val j = JSONObject(fCallook.get(8, TimeUnit.SECONDS))
        if (j.optString("status") == "VALID") {
            j.optString("name").takeIf { it.isNotEmpty() }?.let { info.name = it }
            j.optJSONObject("address")?.optString("line2")?.takeIf { it.isNotEmpty() }?.let { info.qth = it }
            j.optJSONObject("location")?.let { l ->
                l.optString("gridsquare").takeIf { it.isNotEmpty() }?.let { info.grid = it }
                val la = l.optString("latitude").toDoubleOrNull(); val lo = l.optString("longitude").toDoubleOrNull()
                if (la != null && lo != null) { info.lat = la; info.lon = lo }
            }
            j.optJSONObject("current")?.optString("operClass")?.takeIf { it.isNotEmpty() }?.let { info.cls = it.lowercase() }
            if (j.optString("type") == "CLUB") info.cls = "club"
            sources.add("callook")
        }
    }
    info.source = if (sources.isNotEmpty()) sources.joinToString(" + ") else "${info.source} (offline)"
    return info
}

// ------------------------------------------------------------------------------------------ bands / ADIF
fun bandOfHz(hz: Long): String {
    val m = hz / 1e6
    return ADIF_BANDS.firstOrNull { m >= it.first && m <= it.second }?.third ?: ""
}

data class Qso(
    val id: String, val call: String, val ts: Long, val freq: Long, val mode: String,
    val rstS: String = "", val rstR: String = "", val name: String = "", val qth: String = "", val grid: String = "",
    val notes: String = "", val country: String? = null,
)

private val ADIF_MODES = mapOf("NFM" to ("FM" to ""), "FM" to ("FM" to ""), "USB" to ("SSB" to "USB"), "LSB" to ("SSB" to "LSB"),
    "SSB" to ("SSB" to ""), "CW" to ("CW" to ""), "AM" to ("AM" to ""), "FT8" to ("FT8" to ""), "PSK31" to ("PSK" to "PSK31"),
    "RTTY" to ("RTTY" to ""), "SSTV" to ("SSTV" to ""), "DMR" to ("DIGITALVOICE" to "DMR"), "APRS" to ("PKT" to ""))

private fun utcParts(ts: Long): Calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = ts }

fun toAdif(qsos: List<Qso>, myCall: String, myGrid: String): String {
    fun f(k: String, v: Any?): String { val s = v?.toString() ?: return ""; return if (s.isEmpty()) "" else "<$k:${s.length}>$s" }
    val head = "Mayhem Mobile logbook\n${f("ADIF_VER", "3.1.4")}${f("PROGRAMID", "MayhemMobile")}<EOH>\n"
    return head + qsos.joinToString("\n") { q ->
        val c = utcParts(q.ts)
        val date = "%04d%02d%02d".format(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
        val time = "%02d%02d".format(c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE))
        val (mode, sub) = ADIF_MODES[q.mode.uppercase()] ?: (q.mode.uppercase() to "")
        f("CALL", q.call) + f("QSO_DATE", date) + f("TIME_ON", time) + f("BAND", bandOfHz(q.freq)) + f("FREQ", "%.6f".format(q.freq / 1e6)) +
            f("MODE", mode) + f("SUBMODE", sub) + f("RST_SENT", q.rstS) + f("RST_RCVD", q.rstR) + f("NAME", q.name) + f("QTH", q.qth) +
            f("GRIDSQUARE", q.grid) + f("COUNTRY", q.country) + f("COMMENT", q.notes) + f("STATION_CALLSIGN", myCall) + f("MY_GRIDSQUARE", myGrid) + "<EOR>"
    } + "\n"
}

fun fromAdif(text: String): List<Qso> {
    val i = text.uppercase().indexOf("<EOH>")
    val body = if (i >= 0) text.substring(i + 5) else text
    val out = ArrayList<Qso>()
    val re = Regex("<([A-Za-z_]+):(\\d+)(?::[^>]*)?>")
    for (rec in body.split(Regex("<EOR>", RegexOption.IGNORE_CASE))) {
        val fields = HashMap<String, String>()
        for (m in re.findAll(rec)) {
            val start = m.range.last + 1; val n = m.groupValues[2].toInt()
            fields[m.groupValues[1].uppercase()] = rec.substring(start, minOf(rec.length, start + n))
        }
        val call = fields["CALL"] ?: continue
        val date = fields["QSO_DATE"] ?: "19700101"; val time = (fields["TIME_ON"] ?: "0000").padEnd(6, '0')
        val ts = runCatching {
            Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
                clear(); set(date.substring(0, 4).toInt(), date.substring(4, 6).toInt() - 1, date.substring(6, 8).toInt(),
                    time.substring(0, 2).toInt(), time.substring(2, 4).toInt(), time.substring(4, 6).toInt())
            }.timeInMillis
        }.getOrDefault(0L)
        val mode = fields["SUBMODE"].takeIf { !it.isNullOrEmpty() } ?: fields["MODE"] ?: ""
        out += Qso("$ts-$call", call.uppercase(), ts, fields["FREQ"]?.toDoubleOrNull()?.let { (it * 1e6).roundToLong() } ?: 0L,
            when (mode) { "SSB" -> "USB"; "FM" -> "NFM"; else -> mode }, fields["RST_SENT"] ?: "", fields["RST_RCVD"] ?: "",
            fields["NAME"] ?: "", fields["QTH"] ?: "", fields["GRIDSQUARE"] ?: "", fields["COMMENT"] ?: fields["NOTES"] ?: "", fields["COUNTRY"])
    }
    return out
}

/** Conventional report for a mode: 59 for voice, 599 for CW and the keyboard modes, an SNR-style dB for FT8. */
fun rstDefault(mode: String): String = when {
    Regex("^(FM|NFM|AM|USB|LSB|SSB|DMR)$").matches(mode) -> "59"
    mode.contains("FT8") -> "-10"
    else -> "599"
}
