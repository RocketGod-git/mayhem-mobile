package com.rocketgod.mayhem.core.sonde

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Every sonde heard: its latest frame, its track, the flight phase (on the ground, climbing, burst, falling, landed)
 * and where it will come down. The landing prediction is a simple balloon model: the sonde keeps its climb rate to a
 * burst altitude (30 km unless it is already past that), then falls under a parachute whose speed grows with the
 * thinning air; on the way it drifts with the wind it measured itself on the way up, layer by layer.
 * The Kotlin twin of web/src/dsp/sonde/track.ts and SondeTrack.swift.
 */
enum class SondePhase(val id: String, val label: String) {
    NONE("", "NO FIX YET"), GROUND("ground", "ON THE GROUND"), ASCENT("ascent", "CLIMBING"), DESCENT("descent", "FALLING"), LANDED("landed", "LANDED")
}

data class SondeField(val name: String, val value: String)
data class SondeBurst(val lat: Double, val lon: Double, val alt: Double, val ms: Long)
data class SondePrediction(val lat: Double, val lon: Double, val inS: Long, val burstAlt: Long, val path: List<Pair<Double, Double>>)
/** A point of the flight track: latitude, longitude, height rounded to the meter. */
data class SondeTrackPoint(val lat: Double, val lon: Double, val alt: Long)

/** One sonde's card. The tracker replaces its lists rather than changing them, so a copy is a safe snapshot. */
data class SondeRow(
    var serial: String, var type: String, var model: String? = null, var hz: Long, var level: Double = 0.0,
    var firstMs: Long, var lastMs: Long, var frames: Int = 0,
    var frame: Int? = null, var lat: Double? = null, var lon: Double? = null, var alt: Double? = null,
    var vH: Double? = null, var heading: Double? = null, var climb: Double? = null,
    var tempC: Double? = null, var rh: Double? = null, var hPa: Double? = null, var battV: Double? = null, var sats: Int? = null,
    var killS: Int? = null, var timeS: Double? = null, var date: String? = null,
    var maxAlt: Double? = null, var phase: SondePhase = SondePhase.NONE, var burst: SondeBurst? = null,
    var track: List<SondeTrackPoint> = emptyList(), var predict: SondePrediction? = null, var fields: List<SondeField> = emptyList(), var fixed: Int = 0,
)

private const val SCALE_H = 7238.0                  // m, density scale height
private const val DEFAULT_BURST = 30_000.0
private const val DEFAULT_ASCENT = 5.0
private const val DEFAULT_DESCENT = 5.0
private const val LAYER = 500.0

private class Point(val ms: Long, val lat: Double, val lon: Double, val alt: Double)
private class Wind(var n: Double = 0.0, var e: Double = 0.0, var k: Int = 0)

private class Sonde(f: SondeFrame, hz: Long, now: Long) {
    val row = SondeRow(serial = f.serial, type = f.type, hz = hz, firstMs = now, lastMs = now)
    private var pts = ArrayList<Point>()
    private val winds = LinkedHashMap<Int, Wind>()
    private var climbAvg = 0.0; private var climbInit = false
    private var ascended = false; private var minAlt = Double.POSITIVE_INFINITY
    private var landedSince = 0L

    fun add(f: SondeFrame, hz: Long, level: Double, now: Long, events: MutableList<String>) {
        val r = row
        r.type = f.type; f.model?.let { if (it.isNotEmpty()) r.model = it }
        r.hz = hz; r.level = level; r.lastMs = now; r.frames++
        r.fixed += f.fixed ?: 0
        f.frame?.let { r.frame = it }; f.tempC?.let { r.tempC = it }; f.rh?.let { r.rh = it }; f.hPa?.let { r.hPa = it }
        f.battV?.let { r.battV = it }; f.sats?.let { r.sats = it }; f.killS?.let { r.killS = it }; f.timeS?.let { r.timeS = it }; f.date?.let { r.date = it }
        val extra = f.extra
        if (extra != null) {
            val m = LinkedHashMap<String, String>(); for (x in r.fields) m[x.name] = x.value
            for ((k, v) in extra) m[k] = v
            f.txKHz?.let { if (it != 0) m["REPORTED FREQUENCY"] = "%.2f MHz".format(java.util.Locale.US, it / 1000.0) }
            f.tHumC?.let { m["HUMIDITY SENSOR"] = "%.1f °C".format(java.util.Locale.US, it) }
            r.fields = m.map { (name, value) -> SondeField(name, value) }
        }
        val lat = f.lat; val lon = f.lon; val alt = f.alt
        if (lat == null || lon == null || alt == null || !lat.isFinite() || !lon.isFinite()) return
        if (abs(lat) < 1e-6 && abs(lon) < 1e-6) return
        val prev = pts.lastOrNull()
        r.lat = lat; r.lon = lon; r.alt = alt
        r.vH = f.vH; r.heading = f.heading
        var climb = f.climb
        if (climb == null && prev != null && now > prev.ms) climb = (alt - prev.alt) / ((now - prev.ms) / 1000.0)
        if (climb != null && climb.isFinite()) {
            r.climb = climb
            climbAvg = if (climbInit) climbAvg + (climb - climbAvg) * 0.15 else climb; climbInit = true
        }
        var vH = f.vH; var hd = f.heading
        if ((vH == null || hd == null) && prev != null && now - prev.ms > 500) {
            val dn = (lat - prev.lat) * 111_320; val de = (lon - prev.lon) * 111_320 * cos(lat * PI / 180); val dt = (now - prev.ms) / 1000.0
            vH = hypot(dn, de) / dt; hd = (atan2(de, dn) * 180 / PI + 360) % 360
            r.vH = vH; r.heading = hd
        }
        if (vH != null && hd != null) {
            val l = floor(alt / LAYER).toInt(); val w = winds.getOrPut(l) { Wind() }
            w.n += vH * cos(hd * PI / 180); w.e += vH * sin(hd * PI / 180); w.k++
        }
        minAlt = min(minAlt, alt)
        val maxAlt0 = r.maxAlt
        if (maxAlt0 == null || alt > maxAlt0) r.maxAlt = alt
        // phase
        val was = r.phase
        if (climbAvg > 1.5) { r.phase = SondePhase.ASCENT; ascended = true; landedSince = 0 }
        else if (climbAvg < -2 && (ascended || (r.maxAlt ?: 0.0) - alt > 150)) {
            r.phase = SondePhase.DESCENT
            val mx = r.maxAlt
            if (r.burst == null && mx != null && mx - alt > 100) {
                var top = pts.firstOrNull() ?: Point(now, lat, lon, alt)
                for (p in pts) if (p.alt > top.alt) top = p
                r.burst = SondeBurst(top.lat, top.lon, top.alt, top.ms)
                events.add("${r.serial} burst at ${Math.round(top.alt)} m")
            }
        } else if (abs(climbAvg) < 0.7 && (vH ?: 0.0) < 3) {
            if (r.phase == SondePhase.DESCENT || r.phase == SondePhase.LANDED) {
                if (landedSince == 0L) landedSince = now
                if (now - landedSince > 20_000) r.phase = SondePhase.LANDED
            } else if (!ascended) r.phase = SondePhase.GROUND
        }
        if (r.phase == SondePhase.LANDED && was != SondePhase.LANDED) events.add("${r.serial} landed at ${"%.5f".format(java.util.Locale.US, lat)}, ${"%.5f".format(java.util.Locale.US, lon)}")
        if (r.phase == SondePhase.ASCENT && was == SondePhase.GROUND) events.add("${r.serial} launched")
        // the track: a point every 2 s or 25 m of height, at most 1500 (thinned evenly beyond that)
        if (prev == null || now - prev.ms >= 2000 || abs(alt - prev.alt) > 25) {
            pts.add(Point(now, lat, lon, alt))
            if (pts.size > 1500) { val last = pts.size - 1; pts = ArrayList(pts.filterIndexed { i, _ -> i % 2 == 0 || i == last }) }
        }
        r.track = pts.map { SondeTrackPoint(it.lat, it.lon, Math.round(it.alt)) }
        r.predict = predict(lat, lon, alt)
    }

    /** The wind in a layer, from the nearest layer measured. */
    private fun wind(alt: Double): Pair<Double, Double> {
        if (winds.isEmpty()) return 0.0 to 0.0
        val l = floor(alt / LAYER).toInt()
        var best: Wind? = null; var bd = Int.MAX_VALUE
        for ((k, w) in winds) { val d = abs(k - l); if (d < bd) { bd = d; best = w } }
        val b = best ?: return 0.0 to 0.0
        return b.n / b.k to b.e / b.k
    }

    private fun predict(lat: Double, lon: Double, alt: Double): SondePrediction? {
        val r = row
        if (r.phase == SondePhase.LANDED || r.phase == SondePhase.GROUND || r.phase == SondePhase.NONE) return null
        val ground = if (minAlt < 4000 && ascended) max(0.0, min(minAlt, 3000.0)) else 0.0
        val path = ArrayList<Pair<Double, Double>>(); path.add(lat to lon)
        var la = lat; var lo = lon; var h = alt; var t = 0.0
        fun step(dh: Double, rate: Double) {
            val dt = abs(dh) / max(rate, 0.5); val (wn, we) = wind(h)
            la += wn * dt / 111_320; lo += we * dt / (111_320 * max(0.05, cos(la * PI / 180)))
            h += dh; t += dt
        }
        var burstAlt = r.burst?.alt ?: max(DEFAULT_BURST, alt + 1500)
        if (r.phase == SondePhase.ASCENT) {
            val asc = if (climbAvg > 1) climbAvg else DEFAULT_ASCENT
            burstAlt = max(burstAlt, alt)
            while (h < burstAlt) { step(min(100.0, burstAlt - h), asc); if (path.size < 600) path.add(la to lo) }
        }
        // the parachute falls at v0 at sea level, faster as the air thins: v = v0 * exp(h / 2H)
        var v0 = DEFAULT_DESCENT
        if (r.phase == SondePhase.DESCENT && climbAvg < -1 && alt < 25_000) v0 = max(2.0, min(15.0, -climbAvg * exp(-alt / (2 * SCALE_H))))
        var guard = 0
        while (h > ground && guard++ < 2000) { step(-min(100.0, h - ground), v0 * exp(h / (2 * SCALE_H))); if (guard % 3 == 0) path.add(la to lo) }
        path.add(la to lo)
        return SondePrediction(la, lo, Math.round(t), Math.round(burstAlt), path)
    }
}

class SondeTracker {
    private val sondes = LinkedHashMap<String, Sonde>()
    /** What happened (launched, burst, landed), drained by the receiver into its log. */
    val events = ArrayList<String>()

    /** Add a frame; returns the sonde's live row (read it on the same thread). */
    fun add(f0: SondeFrame, hz: Long, level: Double, now: Long): SondeRow {
        // the card shows the type beside the serial: drop a family prefix ("DFM-23038743" → "23038743")
        val f = if (f0.serial.startsWith(f0.type + "-") && f0.serial.length > f0.type.length + 1) f0.copy(serial = f0.serial.substring(f0.type.length + 1)) else f0
        val key = "${f.type}:${f.serial}"
        val s = sondes.getOrPut(key) { Sonde(f, hz, now) }
        s.add(f, hz, level, now, events)
        return s.row
    }

    /** Copies of every row, most recently heard first: safe to hand to another thread. */
    @Suppress("UNUSED_PARAMETER")
    fun rows(now: Long): List<SondeRow> = sondes.values.map { it.row.copy() }.sortedByDescending { it.lastMs }

    fun clear() { sondes.clear() }
}
