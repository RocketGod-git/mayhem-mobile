package com.rocketgod.mayhem.core.sat

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.pow
import kotlin.math.roundToLong
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * Satellite tracking: SGP4 (near-earth, Spacetrack Report #3 / Vallado) from two-line elements, observer look
 * angles (azimuth, elevation, range, range rate), pass prediction and Doppler-corrected frequencies. TLEs come
 * from CelesTrak and are cached for a day. Twin of web/src/sat.ts.
 */

data class Tle(val name: String, val line1: String, val line2: String)
data class Look(val az: Double, val el: Double, val rangeKm: Double, val rangeRate: Double, val lat: Double, val lon: Double, val altKm: Double)
data class Pass(val aos: Long, val los: Long, val maxEl: Double, val aosAz: Double, val losAz: Double)

private const val XKE = 0.0743669161
const val XKMPER = 6378.135
private const val CK2 = 5.413080e-4
private const val CK4 = 0.62098875e-6
private const val E6A = 1e-6
private const val QOMS2T = 1.88027916e-9
private const val S = 1.01222928
private const val AE = 1.0
private const val XJ3 = -0.253881e-5
private const val TWO_PI = 2 * PI
private const val DE2RA = PI / 180
private const val MINS_PER_DAY = 1440.0

class Sgp4(tle: Tle) {
    private val epoch: Double
    private val xno: Double; private val eo: Double; private val xincl: Double; private val xnodeo: Double
    private val omegao: Double; private val xmo: Double; private val bstar: Double
    private var aodp = 0.0; private var xnodp = 0.0; private var cosio = 0.0; private var sinio = 0.0; private var eta = 0.0
    private var c1 = 0.0; private var c4 = 0.0; private var c5 = 0.0; private var xmdot = 0.0; private var omgdot = 0.0; private var xnodot = 0.0
    private var omgcof = 0.0; private var xmcof = 0.0; private var xnodcf = 0.0; private var t2cof = 0.0; private var xlcof = 0.0; private var aycof = 0.0
    private var delmo = 0.0; private var sinmo = 0.0; private var x7thm1 = 0.0; private var d2 = 0.0; private var d3 = 0.0; private var d4 = 0.0
    private var t3cof = 0.0; private var t4cof = 0.0; private var t5cof = 0.0; private var isimp = false; private var x1mth2 = 0.0; private var x3thm1 = 0.0

    init {
        val l1 = tle.line1; val l2 = tle.line2
        val yy = l1.substring(18, 20).trim().toInt(); val days = l1.substring(20, 32).trim().toDouble()
        val year = if (yy < 57) 2000 + yy else 1900 + yy
        epoch = julian(year, 1, 1.0) - 1 + days
        val bexp = l1.substring(59, 61).trim().toInt()
        val bmant = (l1.substring(53, 54) + "0." + l1.substring(54, 59)).replace("+", "").replace(" ", "").toDouble()
        bstar = bmant * 10.0.pow(bexp)
        xincl = l2.substring(8, 16).trim().toDouble() * DE2RA
        xnodeo = l2.substring(17, 25).trim().toDouble() * DE2RA
        eo = ("0." + l2.substring(26, 33).trim()).toDouble()
        omegao = l2.substring(34, 42).trim().toDouble() * DE2RA
        xmo = l2.substring(43, 51).trim().toDouble() * DE2RA
        xno = l2.substring(52, 63).trim().toDouble() * TWO_PI / MINS_PER_DAY
        setup()
    }

    private fun setup() {
        val a1 = (XKE / xno).pow(2.0 / 3)
        cosio = cos(xincl); val theta2 = cosio * cosio
        x3thm1 = 3 * theta2 - 1
        val eosq = eo * eo; val betao2 = 1 - eosq; val betao = sqrt(betao2)
        val del1 = 1.5 * CK2 * x3thm1 / (a1 * a1 * betao * betao2)
        val ao = a1 * (1 - del1 * (0.5 * 2 / 3 + del1 * (1 + 134.0 / 81 * del1)))
        val delo = 1.5 * CK2 * x3thm1 / (ao * ao * betao * betao2)
        xnodp = xno / (1 + delo); aodp = ao / (1 - delo)
        isimp = aodp * (1 - eo) / AE < 220 / XKMPER + AE
        var s4 = S; var qoms24 = QOMS2T; val perige = (aodp * (1 - eo) - AE) * XKMPER
        if (perige < 156) { s4 = perige - 78; if (perige <= 98) s4 = 20.0; qoms24 = ((120 - s4) * AE / XKMPER).pow(4); s4 = s4 / XKMPER + AE }
        val pinvsq = 1 / (aodp * aodp * betao2 * betao2); val tsi = 1 / (aodp - s4)
        eta = aodp * eo * tsi; val etasq = eta * eta; val eeta = eo * eta
        val psisq = abs(1 - etasq); val coef = qoms24 * tsi.pow(4); val coef1 = coef / psisq.pow(3.5)
        val c2 = coef1 * xnodp * (aodp * (1 + 1.5 * etasq + eeta * (4 + etasq)) + 0.75 * CK2 * tsi / psisq * x3thm1 * (8 + 3 * etasq * (8 + etasq)))
        c1 = bstar * c2
        sinio = sin(xincl); val a3ovk2 = -XJ3 / CK2 * AE.pow(3)
        val c3 = coef * tsi * a3ovk2 * xnodp * AE * sinio / eo
        x1mth2 = 1 - theta2
        c4 = 2 * xnodp * coef1 * aodp * betao2 * (eta * (2 + 0.5 * etasq) + eo * (0.5 + 2 * etasq) - 2 * CK2 * tsi / (aodp * psisq) *
            (-3 * x3thm1 * (1 - 2 * eeta + etasq * (1.5 - 0.5 * eeta)) + 0.75 * x1mth2 * (2 * etasq - eeta * (1 + etasq)) * cos(2 * omegao)))
        c5 = 2 * coef1 * aodp * betao2 * (1 + 2.75 * (etasq + eeta) + eeta * etasq)
        val theta4 = theta2 * theta2; val temp1 = 3 * CK2 * pinvsq * xnodp; val temp2 = temp1 * CK2 * pinvsq; val temp3 = 1.25 * CK4 * pinvsq * pinvsq * xnodp
        xmdot = xnodp + 0.5 * temp1 * betao * x3thm1 + 0.0625 * temp2 * betao * (13 - 78 * theta2 + 137 * theta4)
        val x1m5th = 1 - 5 * theta2
        omgdot = -0.5 * temp1 * x1m5th + 0.0625 * temp2 * (7 - 114 * theta2 + 395 * theta4) + temp3 * (3 - 36 * theta2 + 49 * theta4)
        val xhdot1 = -temp1 * cosio
        xnodot = xhdot1 + (0.5 * temp2 * (4 - 19 * theta2) + 2 * temp3 * (3 - 7 * theta2)) * cosio
        omgcof = bstar * c3 * cos(omegao)
        xmcof = -2.0 / 3 * coef * bstar * AE / eeta
        xnodcf = 3.5 * betao2 * xhdot1 * c1
        t2cof = 1.5 * c1
        xlcof = 0.125 * a3ovk2 * sinio * (3 + 5 * cosio) / (1 + cosio)
        aycof = 0.25 * a3ovk2 * sinio
        delmo = (1 + eta * cos(xmo)).pow(3)
        sinmo = sin(xmo)
        x7thm1 = 7 * theta2 - 1
        if (!isimp) {
            val c1sq = c1 * c1; d2 = 4 * aodp * tsi * c1sq; val temp = d2 * tsi * c1 / 3
            d3 = (17 * aodp + s4) * temp; d4 = 0.5 * temp * aodp * tsi * (221 * aodp + 31 * s4) * c1
            t3cof = d2 + 2 * c1sq; t4cof = 0.25 * (3 * d3 + c1 * (12 * d2 + 10 * c1sq))
            t5cof = 0.2 * (3 * d4 + 12 * c1 * d3 + 6 * d2 * d2 + 15 * c1sq * (2 * d2 + c1sq))
        }
    }

    /** ECI position (km) and velocity (km/s) at a wall-clock time (ms). */
    fun propagate(ms: Long): Pair<DoubleArray, DoubleArray> {
        val tsince = (ms / 86_400_000.0 + 2440587.5 - epoch) * MINS_PER_DAY
        val xmdf = xmo + xmdot * tsince; val omgadf = omegao + omgdot * tsince; val xnoddf = xnodeo + xnodot * tsince
        var omega = omgadf; var xmp = xmdf; val tsq = tsince * tsince; val xnode = xnoddf + xnodcf * tsq
        var tempa = 1 - c1 * tsince; var tempe = bstar * c4 * tsince; var templ = t2cof * tsq
        if (!isimp) {
            val delomg = omgcof * tsince; val delm = xmcof * ((1 + eta * cos(xmdf)).pow(3) - delmo); val temp = delomg + delm
            xmp = xmdf + temp; omega = omgadf - temp
            val tcube = tsq * tsince; val tfour = tsince * tcube
            tempa = tempa - d2 * tsq - d3 * tcube - d4 * tfour
            tempe += bstar * c5 * (sin(xmp) - sinmo)
            templ = templ + t3cof * tcube + tfour * (t4cof + tsince * t5cof)
        }
        val a = aodp * tempa * tempa; val e = eo - tempe; val xl = xmp + omega + xnode + xnodp * templ
        val beta = sqrt(1 - e * e); val xn = XKE / a.pow(1.5)
        val axn = e * cos(omega); val temp = 1 / (a * beta * beta); val xll = temp * xlcof * axn; val aynl = temp * aycof
        val xlt = xl + xll; val ayn = e * sin(omega) + aynl
        val capu = fmod2p(xlt - xnode)
        var temp2 = capu; var sinepw = 0.0; var cosepw = 0.0; var temp3 = 0.0; var temp4 = 0.0; var temp5 = 0.0; var temp6 = 0.0
        for (i in 0 until 10) {
            sinepw = sin(temp2); cosepw = cos(temp2)
            temp3 = axn * sinepw; temp4 = ayn * cosepw; temp5 = axn * cosepw; temp6 = ayn * sinepw
            val epw = (capu - temp4 + temp3 - temp2) / (1 - temp5 - temp6) + temp2
            if (abs(epw - temp2) <= E6A) break
            temp2 = epw
        }
        val ecose = temp5 + temp6; val esine = temp3 - temp4; val elsq = axn * axn + ayn * ayn; val temp7 = 1 - elsq; val pl = a * temp7
        val r = a * (1 - ecose); val temp8 = 1 / r; val rdot = XKE * sqrt(a) * esine * temp8; val rfdot = XKE * sqrt(pl) * temp8
        val temp9 = a * temp8; val betal = sqrt(temp7); val temp10 = esine / (1 + betal)
        val cosu = temp9 * (cosepw - axn + ayn * temp10); val sinu = temp9 * (sinepw - ayn - axn * temp10)
        val u = atan2(sinu, cosu); val sin2u = 2 * sinu * cosu; val cos2u = 2 * cosu * cosu - 1; val t1 = CK2 / pl; val t2 = t1 / pl
        val rk = r * (1 - 1.5 * t2 * betal * x3thm1) + 0.5 * t1 * x1mth2 * cos2u; val uk = u - 0.25 * t2 * x7thm1 * sin2u
        val xnodek = xnode + 1.5 * t2 * cosio * sin2u; val xinck = xincl + 1.5 * t2 * cosio * sinio * cos2u
        val rdotk = rdot - xn * t1 * x1mth2 * sin2u; val rfdotk = rfdot + xn * t1 * (x1mth2 * cos2u + 1.5 * x3thm1)
        val sinuk = sin(uk); val cosuk = cos(uk); val sinik = sin(xinck); val cosik = cos(xinck); val sinnok = sin(xnodek); val cosnok = cos(xnodek)
        val xmx = -sinnok * cosik; val xmy = cosnok * cosik
        val ux = xmx * sinuk + cosnok * cosuk; val uy = xmy * sinuk + sinnok * cosuk; val uz = sinik * sinuk
        val vx = xmx * cosuk - cosnok * sinuk; val vy = xmy * cosuk - sinnok * sinuk; val vz = sinik * cosuk
        val kmpm = XKMPER / 60
        return doubleArrayOf(rk * ux * XKMPER, rk * uy * XKMPER, rk * uz * XKMPER) to
            doubleArrayOf((rdotk * ux + rfdotk * vx) * kmpm, (rdotk * uy + rfdotk * vy) * kmpm, (rdotk * uz + rfdotk * vz) * kmpm)
    }
}

private fun fmod2p(x0: Double): Double { val x = x0 % TWO_PI; return if (x < 0) x + TWO_PI else x }
private fun julian(y0: Int, m0: Int, d: Double): Double {
    var y = y0; var m = m0
    if (m <= 2) { y--; m += 12 }
    val a = floor(y / 100.0); val b = 2 - a + floor(a / 4)
    return floor(365.25 * (y + 4716)) + floor(30.6001 * (m + 1)) + d + b - 1524.5
}
private fun gmst(ms: Long): Double {
    val jd = ms / 86_400_000.0 + 2440587.5; val t = (jd - 2451545) / 36525
    var g = 280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t - t * t * t / 38710000
    g = ((g % 360) + 360) % 360
    return g * DE2RA
}

/** Look angles from an observer (deg, deg, km altitude). */
fun look(sat: Sgp4, ms: Long, lat: Double, lon: Double, altKm: Double = 0.0): Look {
    val (r, v) = sat.propagate(ms)
    val theta = gmst(ms) + lon * DE2RA; val la = lat * DE2RA
    val f = 1 / 298.26; val c = 1 / sqrt(1 + f * (f - 2) * sin(la).pow(2)); val sq = (1 - f).pow(2) * c
    val achcp = (XKMPER * c + altKm) * cos(la)
    val ox = achcp * cos(theta); val oy = achcp * sin(theta); val oz = (XKMPER * sq + altKm) * sin(la)
    val omegaE = 7.29211510e-5
    val ovx = -omegaE * oy; val ovy = omegaE * ox
    val rx = r[0] - ox; val ry = r[1] - oy; val rz = r[2] - oz; val vx = v[0] - ovx; val vy = v[1] - ovy; val vz = v[2]
    val sinLa = sin(la); val cosLa = cos(la); val sinTh = sin(theta); val cosTh = cos(theta)
    val topS = sinLa * cosTh * rx + sinLa * sinTh * ry - cosLa * rz
    val topE = -sinTh * rx + cosTh * ry
    val topZ = cosLa * cosTh * rx + cosLa * sinTh * ry + sinLa * rz
    val range = sqrt(rx * rx + ry * ry + rz * rz)
    var az = atan2(-topE, topS) + PI; az = ((az % TWO_PI) + TWO_PI) % TWO_PI
    val el = asin(topZ / range)
    val rangeRate = (rx * vx + ry * vy + rz * vz) / range
    val rMag = sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2])
    val sLon = ((atan2(r[1], r[0]) - gmst(ms)) / DE2RA + 540) % 360 - 180
    val sLat = asin(r[2] / rMag) / DE2RA
    return Look(az / DE2RA, el / DE2RA, range, rangeRate, sLat, sLon, rMag - XKMPER)
}

/** Receive frequency of [downHz] now (range rate km/s; approaching = higher). */
fun doppler(downHz: Long, rangeRateKmS: Double): Long = (downHz * (1 - rangeRateKmS / 299792.458)).roundToLong()
/** What to transmit so the satellite hears [upHz] (the uplink shifts the other way). */
fun dopplerUp(upHz: Long, rangeRateKmS: Double): Long = (upHz * (1 + rangeRateKmS / 299792.458)).roundToLong()

/** Passes over the next [hours] (30 s scan refined by bisection at the edges), at most eight. */
fun passes(sat: Sgp4, lat: Double, lon: Double, fromMs: Long, hours: Int = 24, minEl: Double = 0.0): List<Pass> {
    val out = ArrayList<Pass>()
    var t = fromMs
    var up = look(sat, t, lat, lon).el > minEl
    var aos = if (up) t else 0L; var maxEl = 0.0; var aosAz = 0.0
    val end = fromMs + hours * 3_600_000L
    while (t < end) {
        t += 30_000
        val l = look(sat, t, lat, lon)
        if (!up && l.el > minEl) {
            var a = t - 30_000; var b = t
            repeat(6) { val m = (a + b) / 2; if (look(sat, m, lat, lon).el > minEl) b = m else a = m }
            aos = b; up = true; maxEl = l.el; aosAz = look(sat, b, lat, lon).az
        } else if (up && l.el <= minEl) {
            var a = t - 30_000; var b = t
            repeat(6) { val m = (a + b) / 2; if (look(sat, m, lat, lon).el > minEl) a = m else b = m }
            out += Pass(aos, a, maxEl, aosAz, look(sat, a, lat, lon).az)
            up = false; maxEl = 0.0
            if (out.size >= 8) break
        } else if (up && l.el > maxEl) maxEl = l.el
    }
    return out
}

/** Two-line elements from CelesTrak, cached in the app's files for a day. Blocking; call off the main thread. */
object Tles {
    private var dir: File? = null
    fun init(filesDir: File) { dir = filesDir }

    /** Drop the cached element sets so the next request fetches fresh ones. */
    fun forget() { dir?.listFiles()?.filter { it.name.startsWith("tle-") }?.forEach { it.delete() } }

    private fun get(url: String): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 10_000; c.readTimeout = 15_000; c.setRequestProperty("User-Agent", "MayhemMobile")
        try { return c.inputStream.bufferedReader().use { it.readText() } } finally { c.disconnect() }
    }

    private fun parse(text: String): List<Tle> {
        val lines = text.split(Regex("\\r?\\n")).map { it.trimEnd() }.filter { it.isNotEmpty() }
        val out = ArrayList<Tle>()
        var i = 0
        while (i + 2 < lines.size) { out += Tle(lines[i].trim(), lines[i + 1], lines[i + 2]); i += 3 }
        return out
    }

    /** Every satellite in one CelesTrak group (cached a day): used to put a name to a bird from where it is. */
    fun group(group: String): List<Tle> {
        val f = dir?.let { File(it, "tle-$group.json") }
        if (f != null && f.exists() && System.currentTimeMillis() - f.lastModified() < 86_400_000) {
            runCatching { val a = JSONArray(f.readText()); return (0 until a.length()).map { val o = a.getJSONObject(it); Tle(o.getString("n"), o.getString("a"), o.getString("b")) } }
        }
        val list = parse(get("https://celestrak.org/NORAD/elements/gp.php?GROUP=$group&FORMAT=TLE"))
        f?.runCatching { writeText(JSONArray().also { a -> list.forEach { a.put(JSONObject().put("n", it.name).put("a", it.line1).put("b", it.line2)) } }.toString()) }
        return list
    }

    /** TLEs for a set of NORAD ids: the amateur group, then stations (the ISS) and weather. */
    fun forIds(ids: Collection<Int>): Map<Int, Tle> {
        val out = HashMap<Int, Tle>()
        for (g in listOf("amateur", "stations", "weather", "cubesat")) {
            if (ids.all { it in out }) break
            runCatching { for (t in group(g)) t.line1.substring(2, 7).trim().toIntOrNull()?.let { out.putIfAbsent(it, t) } }
        }
        return out
    }
}
