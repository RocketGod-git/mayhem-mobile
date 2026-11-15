package com.rocketgod.mayhem.core.sonde

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.time.OffsetDateTime
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/** A SondeHub launch site. */
data class HubSite(
    val id: String,
    val name: String,
    val lat: Double,
    val lon: Double,
    /** Sonde types flown there ("41" is a Vaisala RS41), with a frequency where the site lists one. */
    val types: List<String>,
    /** Nominal launch times as listed ("0:00:00" style: day:hh:mm), or a note such as "Irregular". */
    val times: List<String>,
)

/** The latest frame of a sonde someone on SondeHub is hearing. */
data class HubSonde(
    val serial: String,
    val type: String,
    val mhz: Double?,
    val lat: Double,
    val lon: Double,
    val alt: Double,
    val climb: Double?,
    val speedMs: Double?,
    val heading: Double?,
    val ms: Long,
    /** Everything else the latest frame carries, labeled for the detail (temperature, battery, the station hearing it...). */
    val fields: List<Pair<String, String>> = emptyList(),
    val tempC: Double? = null,
    val rh: Double? = null,
    val battV: Double? = null,
)

/** One balloon's whole flight so far, from SondeHub's telemetry: its track, where it came from, and who hears it. */
data class HubFlight(
    val track: List<Pair<Double, Double>>,
    /** The first frame: lat, lon, alt, time. */
    val launch: HubPoint?,
    val maxAlt: Double,
    val maxAltMs: Long,
    /** Every station that uploaded a frame, most frames first. */
    val stations: List<Pair<String, Int>>,
    val frames: Int,
)

data class HubPoint(val lat: Double, val lon: Double, val alt: Double, val ms: Long)

/** SondeHub's own landing prediction for a balloon. */
data class HubPredict(
    val lat: Double,
    val lon: Double,
    val ms: Long,
    val path: List<Pair<Double, Double>>,
    val burstAlt: Double?,
    val ascent: Double?,
    val descent: Double?,
    val descending: Boolean,
    val landed: Boolean,
)

/** The picked balloon's flight and prediction, as fetched (either may be missing). */
data class HubDetail(val flight: HubFlight? = null, val predict: HubPredict? = null, val at: Long = 0, val busy: Boolean = false, val err: String = "")

/** What SondeHub knows near you: the launch sites, and every balloon others are hearing. */
data class SondeNet(val sites: List<HubSite> = emptyList(), val air: List<HubSonde> = emptyList(), val err: String = "")

/**
 * SondeHub, the open network of radiosonde receivers: where the launch sites are, and every balloon in the air that
 * someone, somewhere, is hearing. Sondes shows both before its own radio hears anything, so the screen says what is
 * up and where to listen; a sonde our own decoder hears takes over its card. The twin of the web app's sondehub.ts.
 *
 * API: https://api.v2.sondehub.org (open data). /sites lists every launch site; /sondes lists the latest frame of
 * every sonde heard in a window, optionally within a distance of a point.
 */
object SondeHub {
    private const val API = "https://api.v2.sondehub.org"
    private const val DAY = 86_400_000L

    private val _net = MutableStateFlow(SondeNet())
    val net: StateFlow<SondeNet> = _net.asStateFlow()

    private val _details = MutableStateFlow<Map<String, HubDetail>>(emptyMap())
    /** The flight and landing prediction of each balloon tapped, refreshed at most once a minute. */
    val details: StateFlow<Map<String, HubDetail>> = _details.asStateFlow()

    /** Fetches [serial]'s whole flight and SondeHub's landing prediction, unless it did within the last minute. */
    fun detail(serial: String, now: Long = System.currentTimeMillis()) {
        val had = _details.value[serial]
        if (had != null && (had.busy || now - had.at < 60_000)) return
        _details.value = _details.value + (serial to (had ?: HubDetail()).copy(at = now, busy = true))
        scope.launch {
            val fl = runCatching { flight(serial) }
            val pr = runCatching { predict(serial) }
            val cur = _details.value[serial] ?: HubDetail()
            _details.value = _details.value + (serial to cur.copy(flight = fl.getOrNull() ?: cur.flight, predict = pr.getOrNull() ?: cur.predict, busy = false,
                err = fl.exceptionOrNull()?.let { it.message ?: it.toString() } ?: ""))
        }
    }

    /** Every frame anyone uploaded in the last [hours], as one flight. Blocking. */
    fun flight(serial: String, hours: Int = 6): HubFlight {
        val raw = JSONObject(get("$API/sondes/telemetry?serial=${java.net.URLEncoder.encode(serial, "UTF-8")}&duration=${hours}h", "telemetry"))
        return parseFlight(raw.optJSONObject(serial) ?: JSONObject())
    }

    /** SondeHub's landing prediction, or null when it has none. Blocking. */
    fun predict(serial: String): HubPredict? {
        val a = JSONArray(get("$API/predictions?vehicles=${java.net.URLEncoder.encode(serial, "UTF-8")}", "predictions"))
        for (i in 0 until a.length()) { val p = a.optJSONObject(i) ?: continue; if (p.optString("vehicle") == serial) return parsePredict(p) }
        return null
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val busy = AtomicBoolean(false)
    @Volatile private var sitesAt = 0L
    @Volatile private var airAt = 0L
    private var dir: File? = null

    /** Where the launch-site list is kept for a day between visits. */
    fun init(filesDir: File) { dir = filesDir }

    /**
     * Called every second or so while Sondes is open: fetches the sites once (retried after a minute on failure) and
     * the balloons near [lat], [lon] every 30 s.
     */
    fun poll(lat: Double, lon: Double, now: Long = System.currentTimeMillis()) {
        if (_net.value.sites.isEmpty() && now - sitesAt > 60_000) {
            sitesAt = now
            scope.launch {
                runCatching { sites() }.onSuccess { s -> _net.value = _net.value.copy(sites = s) }
                    .onFailure { e -> _net.value = _net.value.copy(err = e.message ?: e.toString()) }
            }
        }
        if (now - airAt < 30_000 || !busy.compareAndSet(false, true)) return
        airAt = now
        scope.launch {
            try {
                runCatching { sondes(lat, lon) }.onSuccess { a -> _net.value = _net.value.copy(air = a, err = "") }
                    .onFailure { e -> _net.value = _net.value.copy(err = e.message ?: e.toString()) }
            } finally { busy.set(false) }
        }
    }

    /** The launch sites, from the copy in the app's files when it is under a day old. Blocking. */
    fun sites(): List<HubSite> {
        val f = dir?.let { File(it, "sondehub-sites.json") }
        if (f != null && f.exists() && System.currentTimeMillis() - f.lastModified() < DAY) {
            runCatching { parseSites(f.readText()) }.getOrNull()?.takeIf { it.isNotEmpty() }?.let { return it }
        }
        val text = get("$API/sites", "sites")
        val out = parseSites(text)
        if (out.isNotEmpty()) f?.runCatching { writeText(text) }
        return out
    }

    /** Every sonde heard by anyone in the last [lastS] seconds within [km] of a point. Blocking. */
    fun sondes(lat: Double, lon: Double, km: Double = 400.0, lastS: Int = 3 * 3600): List<HubSonde> =
        parseSondes(get("$API/sondes?lat=%.4f&lon=%.4f&distance=%d&last=%d".format(Locale.US, lat, lon, Math.round(km * 1000), lastS), "sondes"))

    // HttpURLConnection asks for gzip itself and unpacks it, as long as no Accept-Encoding is set here
    private fun get(url: String, what: String): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 10_000; c.readTimeout = 20_000; c.setRequestProperty("User-Agent", "MayhemMobile")
        try {
            if (c.responseCode !in 200..299) throw IllegalStateException("SondeHub $what: HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally { c.disconnect() }
    }

    private val US_SUFFIX = Regex("\\s*\\((United States|USA)\\)\\s*$")

    /** SondeHub's /sites answer: an object keyed by station id. */
    fun parseSites(text: String): List<HubSite> {
        val raw = JSONObject(text)
        val out = ArrayList<HubSite>()
        for (id in raw.keys()) {
            val v = raw.optJSONObject(id) ?: continue
            val p = v.optJSONArray("position") ?: continue
            if (p.length() < 2) continue
            val types = ArrayList<String>()
            v.optJSONArray("rs_types")?.let { a ->
                for (i in 0 until a.length()) {
                    val t = a.opt(i)
                    if (t is JSONArray) types.add("${hubTypeName(t.optString(0))} ${t.optString(1)} MHz") else if (t != null) types.add(hubTypeName(t.toString()))
                }
            }
            val times = ArrayList<String>()
            v.optJSONArray("times")?.let { a -> for (i in 0 until a.length()) times.add(a.optString(i)) }
            out.add(HubSite(id = v.optString("station").ifEmpty { id }, name = v.optString("station_name").ifEmpty { id }.replace(US_SUFFIX, ""),
                lat = p.optDouble(1), lon = p.optDouble(0), types = types, times = times))
        }
        return out
    }

    /** SondeHub's /sondes answer: an object keyed by serial, newest first. */
    fun parseSondes(text: String, now: Long = System.currentTimeMillis()): List<HubSonde> {
        val raw = JSONObject(text)
        val out = ArrayList<HubSonde>()
        for (serial in raw.keys()) {
            val v = raw.optJSONObject(serial) ?: continue
            parseSonde(serial, v, now)?.let { out.add(it) }
        }
        return out.sortedByDescending { it.ms }
    }

    private fun JSONObject.num(k: String): Double? = if (has(k) && !isNull(k)) (opt(k) as? Number)?.toDouble()?.takeIf { it.isFinite() } else null
    private fun JSONObject.str(k: String): String? = if (has(k) && !isNull(k)) optString(k).trim().ifEmpty { null } else null
    private fun ms(dt: String?, now: Long): Long = if (dt.isNullOrEmpty()) now else runCatching { OffsetDateTime.parse(dt).toInstant().toEpochMilli() }.getOrDefault(now)

    /** One SondeHub frame as a card: the flight numbers, plus every other field it carries, labeled. */
    fun parseSonde(serial: String, v: JSONObject, now: Long = System.currentTimeMillis()): HubSonde? {
        val lat = v.num("lat") ?: return null; val lon = v.num("lon") ?: return null
        val f = ArrayList<Pair<String, String>>()
        fun add(name: String, value: String?) { if (!value.isNullOrEmpty()) f.add(name to value) }
        val badTemp = v.optBoolean("invalid_temp", false)
        val temp = v.num("temp")?.takeIf { !badTemp }; val rh = v.num("humidity"); val hPa = v.num("pressure"); val batt = v.num("batt")
        val timer = v.num("burst_timer"); val snr = v.num("snr"); val rssi = v.num("rssi"); val sats = v.num("sats"); val frame = v.num("frame")
        val tx = v.num("tx_frequency")
        add("MAKER", v.str("manufacturer"))
        add("TEMPERATURE", temp?.let { "%.1f °C".format(Locale.US, it) })
        add("HUMIDITY", rh?.let { "%.0f %%".format(Locale.US, it) })
        add("PRESSURE", hPa?.takeIf { it > 0 }?.let { "%.1f hPa".format(Locale.US, it) })
        add("BATTERY", batt?.let { "%.1f V".format(Locale.US, it) })
        add("SATELLITES", sats?.let { "${it.toLong()}" })
        add("FRAME NUMBER", frame?.let { "${it.toLong()}" })
        add("BURST TIMER", timer?.takeIf { it > 0 && it < 65535 }?.let { dur(it) })
        add("TX FREQUENCY", tx?.let { "%.3f MHz".format(Locale.US, it) })
        add("SIGNAL", when {
            snr != null -> "%.1f dB SNR".format(Locale.US, snr) + (rssi?.let { " · %.0f dBm".format(Locale.US, it) } ?: "")
            rssi != null -> "%.0f dBm".format(Locale.US, rssi)
            else -> null
        })
        add("MAINBOARD", v.str("rs41_mainboard")?.let { b -> b + (v.str("rs41_mainboard_fw")?.let { " · firmware $it" } ?: "") })
        add("DFM CODE", v.str("dfmcode"))
        add("POSITION FROM", v.str("ref_position"))
        add("HEARD BY", v.str("uploader_callsign"))
        add("THEIR ANTENNA", v.str("uploader_antenna"))
        v.str("uploader_position")?.split(',')?.mapNotNull { it.trim().toDoubleOrNull() }?.takeIf { it.size == 2 }?.let { up ->
            add("THEIR STATION", "%.4f, %.4f".format(Locale.US, up[0], up[1]) + (v.num("uploader_alt")?.let { " · ${Math.round(it)} m" } ?: ""))
        }
        add("THEIR SOFTWARE", v.str("software_name")?.let { n -> n + (v.str("software_version")?.let { " $it" } ?: "") })
        return HubSonde(serial = serial, type = v.str("subtype") ?: v.str("type") ?: "sonde", mhz = v.num("frequency"),
            lat = lat, lon = lon, alt = v.num("alt") ?: 0.0, climb = v.num("vel_v"), speedMs = v.num("vel_h"), heading = v.num("heading"),
            ms = ms(v.str("datetime"), now), fields = f, tempC = temp, rh = rh, battV = batt)
    }

    /** A duration in seconds as "8 h 02 min" / "14 min". */
    fun dur(s: Double): String {
        val h = (s / 3600).toLong(); val m = ((s % 3600) / 60).toLong()
        return if (h > 0) "%d h %02d min".format(Locale.US, h, m) else "$m min"
    }

    /** SondeHub's telemetry for one serial: an object keyed by frame time. */
    fun parseFlight(frames: JSONObject): HubFlight {
        data class Row(val ms: Long, val v: JSONObject)
        val rows = ArrayList<Row>()
        for (k in frames.keys()) {
            val v = frames.optJSONObject(k) ?: continue
            if (v.num("lat") == null || v.num("lon") == null) continue
            val t = runCatching { OffsetDateTime.parse(k).toInstant().toEpochMilli() }.getOrNull() ?: continue
            rows.add(Row(t, v))
        }
        rows.sortBy { it.ms }
        val calls = HashMap<String, Int>()
        var maxAlt = 0.0; var maxAltMs = 0L
        val track = ArrayList<Pair<Double, Double>>()
        for (r in rows) {
            val lat = r.v.num("lat")!!; val lon = r.v.num("lon")!!; val alt = r.v.num("alt") ?: 0.0
            val last = track.lastOrNull()
            // one point per ~50 m of movement keeps a 5000-frame flight light on the map
            if (last == null || Math.abs(last.first - lat) + Math.abs(last.second - lon) > 0.0005) track.add(lat to lon)
            if (alt > maxAlt) { maxAlt = alt; maxAltMs = r.ms }
            val ups = r.v.optJSONArray("uploaders")
            if (ups != null) for (i in 0 until ups.length()) ups.optJSONObject(i)?.str("uploader_callsign")?.let { calls[it] = (calls[it] ?: 0) + 1 }
            else r.v.str("uploader_callsign")?.let { calls[it] = (calls[it] ?: 0) + 1 }
        }
        val first = rows.firstOrNull()
        return HubFlight(track = track, launch = first?.let { HubPoint(it.v.num("lat")!!, it.v.num("lon")!!, it.v.num("alt") ?: 0.0, it.ms) },
            maxAlt = maxAlt, maxAltMs = maxAltMs, stations = calls.entries.map { it.key to it.value }.sortedByDescending { it.second }, frames = rows.size)
    }

    /** One entry of SondeHub's /predictions answer; its "data" is the predicted path as a JSON string. */
    fun parsePredict(p: JSONObject): HubPredict? {
        val arr = when (val d = p.opt("data")) { is String -> runCatching { JSONArray(d) }.getOrNull(); is JSONArray -> d; else -> null } ?: return null
        val path = ArrayList<Pair<Double, Double>>()
        var endT = 0.0
        for (i in 0 until arr.length()) {
            val q = arr.optJSONObject(i) ?: continue
            val la = q.num("lat") ?: continue; var lo = q.num("lon") ?: continue
            if (lo > 180) lo -= 360
            path.add(la to lo); endT = q.num("time") ?: endT
        }
        if (path.isEmpty()) return null
        val flag = { k: String -> p.opt(k).let { it == true || (it as? Number)?.toInt() == 1 } }
        return HubPredict(lat = path.last().first, lon = path.last().second, ms = Math.round(endT * 1000), path = path, burstAlt = p.num("burst_altitude"),
            ascent = p.num("ascent_rate"), descent = p.num("descent_rate"), descending = flag("descending"), landed = flag("landed"))
    }

    /** The listed launch site a flight started from: the nearest within 25 km of its first frame. */
    fun launchSite(sites: List<HubSite>, lat: Double, lon: Double): HubSite? {
        var best: HubSite? = null; var bestKm = 25.0
        for (x in sites) {
            val dy = (x.lat - lat) * 111.2; val dx = (x.lon - lon) * 111.2 * Math.cos(Math.toRadians(lat))
            val km = Math.hypot(dx, dy)
            if (km < bestKm) { bestKm = km; best = x }
        }
        return best
    }

    private val TYPES = mapOf("41" to "RS41", "92" to "RS92", "11" to "LMS6", "82" to "LMS6-1680", "17" to "DFM-17", "09" to "DFM-09", "06" to "DFM-06",
        "52" to "RS92-NGP", "77" to "M10", "87" to "M20")

    /** SondeHub's short type codes as the names people know. */
    fun hubTypeName(t: String): String = TYPES[t] ?: t

    private val TIME = Regex("^\\d+:(\\d{1,2}):(\\d{2})$")

    /**
     * When a site next launches, by its listed times (taken as UTC hours, as SondeHub writes them: "0:12:00" is 12:00),
     * about an hour before each nominal time as weather services do. A launch counts as current for 90 minutes after
     * it goes up (the balloon is still climbing). Null when the site lists none or calls itself irregular.
     */
    fun nextLaunchMs(site: HubSite, now: Long = System.currentTimeMillis()): Long? {
        val hours = site.times.mapNotNull { TIME.matchEntire(it.trim()) }.map { it.groupValues[1].toDouble() + it.groupValues[2].toDouble() / 60 }
        if (hours.isEmpty()) return null
        val day0 = Math.floorDiv(now, DAY) * DAY
        var best: Long? = null
        for (k in -1..1) for (h in hours) {
            val launch = day0 + k * DAY + Math.round(h * 3_600_000) - 3_600_000
            if (launch + 90 * 60_000 >= now && (best == null || launch < best)) best = launch
        }
        return best
    }

    /** True when the site says it has no set schedule. */
    fun irregular(site: HubSite): Boolean = site.times.any { Regex("irregular|mission", RegexOption.IGNORE_CASE).containsMatchIn(it) }
}
