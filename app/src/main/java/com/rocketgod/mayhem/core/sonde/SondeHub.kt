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
)

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
        fun JSONObject.num(k: String): Double? = if (has(k) && !isNull(k)) optDouble(k).takeIf { it.isFinite() } else null
        for (serial in raw.keys()) {
            val v = raw.optJSONObject(serial) ?: continue
            val lat = v.num("lat") ?: continue; val lon = v.num("lon") ?: continue
            val dt = v.optString("datetime")
            out.add(HubSonde(serial = serial, type = v.optString("subtype").ifEmpty { v.optString("type") }.ifEmpty { "sonde" }, mhz = v.num("frequency"),
                lat = lat, lon = lon, alt = v.num("alt") ?: 0.0, climb = v.num("vel_v"), speedMs = v.num("vel_h"), heading = v.num("heading"),
                ms = if (dt.isEmpty()) now else runCatching { OffsetDateTime.parse(dt).toInstant().toEpochMilli() }.getOrDefault(now)))
        }
        return out.sortedByDescending { it.ms }
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
