package com.rocketgod.mayhem.core.sonde

import java.time.Instant
import java.time.ZoneOffset
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Radiosondes: what every decoder reports, and the bit framer they share. The Kotlin twin of web/src/dsp/sonde/types.ts
 * and SondeTypes.swift.
 */

/** One decoded frame from one sonde. Fields a type does not carry stay null. */
data class SondeFrame(
    /** The family shown on the card: "RS41", "M10", "DFM-09" ... */
    var type: String,
    var serial: String,
    /** The model when the sonde says more than the family (RS41-SGP, DFM-17, iMet-4 ...). */
    var model: String? = null,
    var frame: Int? = null,
    /** GPS time of day, UTC, seconds since midnight. */
    var timeS: Double? = null,
    /** Date as YYYY-MM-DD, when the type sends it. */
    var date: String? = null,
    var lat: Double? = null, var lon: Double? = null,
    /** Meters above the WGS84 ellipsoid (or mean sea level for the types that send that). */
    var alt: Double? = null,
    /** Ground speed m/s, heading degrees true, climb m/s (negative descending). */
    var vH: Double? = null, var heading: Double? = null, var climb: Double? = null,
    var sats: Int? = null,
    var tempC: Double? = null, var rh: Double? = null, var hPa: Double? = null,
    /** Humidity sensor temperature (RS41). */
    var tHumC: Double? = null,
    var battV: Double? = null,
    /** Burst/kill timer, seconds left, when the sonde reports one. */
    var killS: Int? = null,
    /** Transmit frequency the sonde reports for itself, kHz. */
    var txKHz: Int? = null,
    /** Bytes or bits the error correction repaired (0 = clean). */
    var fixed: Int? = null,
    /** Anything else worth a line on the detail card, by label, in the order first set. */
    var extra: LinkedHashMap<String, String>? = null,
) {
    /** Set one [extra] field (keeping the order fields were first set in, as the web's object spread does). */
    fun put(name: String, value: String) { (extra ?: LinkedHashMap<String, String>().also { extra = it })[name] = value }
}

typealias SondeSink = (SondeFrame) -> Unit

/**
 * A symbol-rate bit slicer on the FM discriminator, with a sync-word search in both FM polarities. Once the header
 * matches it collects [frameSyms] more channel symbols and hands them over (soft values: the integrated discriminator
 * per symbol, positive = the header's 1), then goes back to searching. Headers up to 64 symbols.
 */
class FskFramer(
    val baud: Double, rate: Double, header: String, val frameSyms: Int,
    private val maxErr: Int,
    private val onFrame: (soft: FloatArray, headerErrs: Int) -> Unit,
    private val gain: Double = 0.2,
) {
    private val inc = baud / rate
    private var phase = 0.0; private var acc = 0.0; private var lastPos = false; private var first = true
    private var sh = 0L; private var shN = 0
    val hdrLen = header.length
    private val mask: Long = if (header.length >= 64) -1L else (1L shl header.length) - 1
    private val hdr: Long
    private var collecting = 0; private var inv = false
    private val buf = FloatArray(frameSyms); private var n = 0
    /** Running mean of the discriminator: the DC the slicer is centered on. */
    private var dc = 0.0
    private var lastErrs = 0

    init {
        var h = 0L
        for (c in header) h = (h shl 1) or (if (c == '1') 1L else 0L)
        require(header.length <= 64) { "sync word over 64 symbols" }
        hdr = h
    }

    fun reset() { phase = 0.0; acc = 0.0; first = true; sh = 0L; shN = 0; collecting = 0; n = 0 }

    /** One discriminator sample. */
    fun push(x: Double) {
        // the slicer's center follows the carrier between frames, and holds still inside one (long runs of one
        // symbol, like MTS01's padding, would drag it off)
        if (collecting == 0) dc += (x - dc) * 0.0005
        val v = x - dc
        val pos = v > 0
        if (!first && pos != lastPos) {
            val err = if (phase < 0.5) phase else phase - 1
            phase -= err * gain
        }
        first = false; lastPos = pos
        acc += v
        phase += inc
        if (phase < 1) return
        phase -= 1
        val s = acc; acc = 0.0
        symbol(s)
    }

    private fun symbol(s: Double) {
        if (collecting > 0) {
            buf[n++] = (if (inv) -s else s).toFloat()
            if (--collecting == 0) onFrame(buf.copyOf(n), lastErrs)
            return
        }
        sh = ((sh shl 1) or (if (s > 0) 1L else 0L)) and mask
        if (++shN < hdrLen) return
        val e = java.lang.Long.bitCount(sh xor hdr); val ei = hdrLen - e
        if (e <= maxErr || ei <= maxErr) {
            inv = ei < e; lastErrs = min(e, ei)
            collecting = frameSyms; n = 0; shN = 0
        }
    }
}

/** Hard bits out of soft symbols. */
fun hard(s: FloatArray): IntArray = IntArray(s.size) { if (s[it] > 0) 1 else 0 }

/** Manchester pairs to bits: a pair (a, b) is 1 when a > b (the "10" = 1 convention) unless [oneIsHighLow] is false. */
fun manchester(s: FloatArray, start: Int, nBits: Int, oneIsHighLow: Boolean = true): IntArray =
    IntArray(nBits) { k -> val a = s[start + 2 * k]; val b = s[start + 2 * k + 1]; if ((a > b) == oneIsHighLow) 1 else 0 }

/** Bytes (0..255) from bits, least significant bit first (RS41, RS92) or most significant first. */
fun bytesOf(bits: IntArray, start: Int, nBytes: Int, lsbFirst: Boolean): IntArray {
    val out = IntArray(nBytes)
    for (i in 0 until nBytes) {
        var v = 0
        for (k in 0 until 8) { val b = bits[start + 8 * i + k] and 1; v = v or (if (lsbFirst) b shl k else b shl (7 - k)) }
        out[i] = v
    }
    return out
}

data class GeoPos(val lat: Double, val lon: Double, val alt: Double)
data class Neu(val vH: Double, val heading: Double, val climb: Double)

private const val WGS_A = 6378137.0
private const val WGS_B = 6356752.31424518

/** WGS84 ECEF (meters) to latitude, longitude (degrees) and height above the ellipsoid. */
fun ecefToGeo(x: Double, y: Double, z: Double): GeoPos {
    val a = WGS_A; val b = WGS_B; val e2 = (a * a - b * b) / (a * a); val ee2 = (a * a - b * b) / (b * b)
    val lon = atan2(y, x); val p = hypot(x, y); val t = atan2(z * a, p * b)
    val st = sin(t); val ct = cos(t)
    val lat = atan2(z + ee2 * b * st * st * st, p - e2 * a * ct * ct * ct)
    val r = a / sqrt(1 - e2 * sin(lat) * sin(lat))
    return GeoPos(lat * 180 / PI, lon * 180 / PI, p / cos(lat) - r)
}

/** Latitude, longitude, height to ECEF (for the test encoders). */
fun geoToEcef(latD: Double, lonD: Double, h: Double): DoubleArray {
    val a = WGS_A; val b = WGS_B; val e2 = (a * a - b * b) / (a * a)
    val la = latD * PI / 180; val lo = lonD * PI / 180; val n = a / sqrt(1 - e2 * sin(la) * sin(la))
    return doubleArrayOf((n + h) * cos(la) * cos(lo), (n + h) * cos(la) * sin(lo), (n * (1 - e2) + h) * sin(la))
}

/** ECEF velocity to ground speed, heading and climb at a position. */
fun ecefVelToNeu(vx: Double, vy: Double, vz: Double, latD: Double, lonD: Double): Neu {
    val la = latD * PI / 180; val lo = lonD * PI / 180
    val vN = -vx * sin(la) * cos(lo) - vy * sin(la) * sin(lo) + vz * cos(la)
    val vE = -vx * sin(lo) + vy * cos(lo)
    val vU = vx * cos(la) * cos(lo) + vy * cos(la) * sin(lo) + vz * sin(la)
    var hd = atan2(vE, vN) * 180 / PI; if (hd < 0) hd += 360
    return Neu(hypot(vN, vE), hd, vU)
}

fun neuToEcefVel(vN: Double, vE: Double, vU: Double, latD: Double, lonD: Double): DoubleArray {
    val la = latD * PI / 180; val lo = lonD * PI / 180
    return doubleArrayOf(
        -vN * sin(la) * cos(lo) - vE * sin(lo) + vU * cos(la) * cos(lo),
        -vN * sin(la) * sin(lo) + vE * cos(lo) + vU * cos(la) * sin(lo),
        vN * cos(la) + vU * sin(la))
}

/** GPS week + seconds of week to a date string (no leap seconds: the date only). */
fun gpsDate(week: Int, tow: Double): String {
    val ms = GPS_EPOCH_MS + (week.toLong() * 7 * 86400 + floor(tow).toLong()) * 1000
    return Instant.ofEpochMilli(ms).atOffset(ZoneOffset.UTC).toLocalDate().toString()
}

/** 1980-01-06T00:00:00Z. */
private const val GPS_EPOCH_MS = 315_964_800_000L
