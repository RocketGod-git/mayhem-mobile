package com.rocketgod.mayhem.core.uat

import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * UAT on 978 MHz: the FAA ground towers' FIS-B weather (radar, airport weather, notices) and the aircraft that
 * broadcast on 978, kept for the screen. Decoding runs on the DSP thread; the screen reads [snapshot] whenever
 * [version] moves. The twin of the web app's UAT screen state.
 */
class UatProcessor(private val log: PacketLog) : IqProcessor {
    data class Tower(val lat: Double, val lon: Double, val at: Long, val frames: Int)
    data class Text(val kind: String, val station: String, val text: String, val at: Long)
    data class Plane(val t: UatTarget, val first: Long, val at: Long, val frames: Int, val track: List<Pair<Double, Double>>)
    data class Snapshot(
        val towers: Map<String, Tower>, val regional: List<RadarBlock>, val national: List<RadarBlock>, val radarTime: String,
        val metars: Map<String, Pair<Metar, Long>>, val texts: List<Text>, val planes: Map<String, Plane>,
        val products: Map<Int, Int>, val up: Int, val down: Int, val firstAt: Long,
    )

    private val lock = Any()
    private val towers = LinkedHashMap<String, Tower>()
    private val regional = HashMap<Int, RadarBlock>(); private val national = HashMap<Int, RadarBlock>()
    private var radarTime = ""
    private val metars = HashMap<String, Pair<Metar, Long>>()
    private val texts = LinkedHashMap<String, Text>()
    private val planes = HashMap<String, Plane>()
    private val products = HashMap<Int, Int>()
    private var up = 0; private var down = 0; private var firstAt = 0L
    private val _version = MutableStateFlow(0)
    /** Moves whenever anything new is decoded. */
    val version: StateFlow<Int> = _version.asStateFlow()
    private val clock = SimpleDateFormat("HH:mm:ss", Locale.US)

    private val rx = UatReceiver({ msg, _ -> onUp(msg) }, { b, _, _ -> onDown(b) })

    override fun reset(rate: Int) = rx.reset(rate)
    override fun onIq(iq: ByteArray, len: Int, rate: Int) = rx.onIq(iq, len, rate)

    private fun line(s: String) = log.add("${clock.format(Date())} $s")

    /** One decoded uplink message (also the entry point for replays and tests). */
    fun onUp(msg: ByteArray) {
        val now = System.currentTimeMillis()
        val got = ArrayList<String>()
        synchronized(lock) {
            up++; if (firstAt == 0L) firstAt = now
            val st = Fisb.station(msg)
            val key = "%.3f,%.3f".format(Locale.US, st.lat, st.lon)
            val tw = towers[key]
            if (tw == null) line("TOWER FIS-B ground station at %.4f, %.4f".format(Locale.US, st.lat, st.lon))
            towers[key] = Tower(st.lat, st.lon, now, (tw?.frames ?: 0) + 1)
            for (p in Fisb.products(msg)) {
                products[p.id] = (products[p.id] ?: 0) + 1
                if (p.id == 63 || p.id == 64) {
                    val map = if (p.id == 63) regional else national
                    for (b in Fisb.radarBlocks(p)) if (b.bins != null) map[b.block] = b else map.remove(b.block)
                    radarTime = "%02d:%02dZ".format(Locale.US, p.hh, p.mm)
                    continue
                }
                val t = Fisb.text(p.payload)
                if (t.isEmpty()) continue
                if (t.startsWith("METAR") || t.startsWith("SPECI")) {
                    val m = Fisb.metar(t) ?: continue
                    if (!metars.containsKey(m.station)) got.add("METAR ${m.station}")
                    metars[m.station] = m to now
                    continue
                }
                val kind = t.split(' ', '.').first()
                val station = Regex("^(?:NOTAM-\\w+\\s+)?K?([A-Z0-9]{3,4})\\b").find(t.substringAfter(' '))?.groupValues?.get(1) ?: ""
                val k = t.take(64)
                if (!texts.containsKey(k)) got.add(kind)
                texts[k] = Text(kind, station, t, now)
                if (texts.size > 600) texts.remove(texts.keys.first())
            }
        }
        if (got.isNotEmpty()) line("FISB ${got.take(6).joinToString(" · ")}${if (got.size > 6) " +${got.size - 6}" else ""}")
        _version.value++
    }

    private fun onDown(bytes: ByteArray) {
        val now = System.currentTimeMillis()
        val t = Fisb.downlink(bytes)
        var isNew = false
        synchronized(lock) {
            down++
            val was = planes[t.address]
            isNew = was == null
            // a basic frame has no call sign: keep the one a long frame gave
            val merged = if (was == null) t else t.copy(callsign = t.callsign ?: was.t.callsign, emitter = t.emitter ?: was.t.emitter,
                lat = t.lat ?: was.t.lat, lon = t.lon ?: was.t.lon, altFt = t.altFt ?: was.t.altFt, speedKt = t.speedKt ?: was.t.speedKt,
                trackDeg = t.trackDeg ?: was.t.trackDeg, vertFpm = t.vertFpm ?: was.t.vertFpm)
            var track = was?.track ?: emptyList()
            if (t.lat != null && t.lon != null) {
                val last = track.lastOrNull()
                if (last == null || Math.abs(last.first - t.lat) + Math.abs(last.second - t.lon) > 0.002) track = (track + (t.lat to t.lon)).takeLast(400)
            }
            planes[t.address] = Plane(merged, was?.first ?: now, now, (was?.frames ?: 0) + 1, track)
        }
        if (isNew) line("AIRCRAFT ${t.callsign ?: t.address} · ${source(t.qualifier)}${t.altFt?.let { " · %,d ft".format(Locale.US, it) } ?: ""}")
        _version.value++
    }

    fun snapshot(): Snapshot = synchronized(lock) {
        val now = System.currentTimeMillis()
        planes.entries.removeAll { now - it.value.at > 120_000 }
        Snapshot(towers.toMap(), regional.values.toList(), national.values.toList(), radarTime, metars.toMap(), texts.values.toList(),
            planes.toMap(), products.toMap(), up, down, firstAt)
    }

    fun clear() {
        synchronized(lock) {
            towers.clear(); regional.clear(); national.clear(); radarTime = ""; metars.clear(); texts.clear(); planes.clear(); products.clear()
            up = 0; down = 0; firstAt = 0
        }
        log.clear(); _version.value++
    }

    companion object {
        fun source(q: Int) = listOf("UAT", "UAT", "TIS-B", "TIS-B", "vehicle", "beacon", "ADS-R", "?").getOrElse(q) { "?" }
        val PRODUCT = mapOf(8 to "notices", 11 to "AIRMET", 12 to "SIGMET", 13 to "special use airspace", 14 to "G-AIRMET", 15 to "center weather",
            16 to "notices", 17 to "notices", 19 to "TFR", 63 to "regional radar", 64 to "national radar", 70 to "icing, low", 71 to "icing, high",
            84 to "cloud tops", 90 to "turbulence, low", 91 to "turbulence, high", 103 to "lightning", 413 to "weather text")
    }
}

/** Airport names and positions (OurAirports, public domain), from the bundled assets/airports.json, loaded once. */
object Airports {
    data class Airport(val lat: Double, val lon: Double, val name: String)
    @Volatile private var map: Map<String, Airport>? = null
    private val _loaded = MutableStateFlow(false)
    val loaded: StateFlow<Boolean> = _loaded.asStateFlow()

    operator fun get(id: String): Airport? = map?.get(id)

    fun load(ctx: android.content.Context) {
        if (map != null) return
        Thread({
            val m = HashMap<String, Airport>(20_000)
            runCatching {
                val a = org.json.JSONArray(ctx.assets.open("airports.json").bufferedReader().use { it.readText() })
                for (i in 0 until a.length()) { val r = a.getJSONArray(i); m[r.getString(0)] = Airport(r.getDouble(1), r.getDouble(2), r.getString(3)) }
            }
            map = m; _loaded.value = true
        }, "airports").start()
    }
}
