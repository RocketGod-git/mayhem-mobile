package com.rocketgod.mayhem.core.hamid

import kotlin.math.abs

/**
 * Positions carried as text inside digital voice signals: NMEA 0183 sentences (RMC, GGA, GLL, any talker) and APRS
 * position reports (uncompressed, with or without a timestamp), as D-STAR's D-PRS, DMR packet data and Fusion data
 * channels carry them. The same as the web's dsp/hamid/gps.ts.
 */
data class Position(val lat: Double, val lon: Double, var source: String, var alt: Double? = null)

private val HEX2 = Regex("^[0-9A-Fa-f]{2}$")
private val LAT_RE = Regex("^\\d{4}(\\.\\d+)?$")
private val LON_RE = Regex("^\\d{5}(\\.\\d+)?$")

/** "3404.50" with hemisphere "N" → 34.075; [degDigits] is 2 for latitude, 3 for longitude. */
private fun dm(v: String, hemi: String, degDigits: Int): Double {
    if (!(if (degDigits == 2) LAT_RE else LON_RE).matches(v)) return Double.NaN
    val deg = v.substring(0, degDigits).toInt(); val min = v.substring(degDigits).toDouble()
    if (!(min >= 0 && min < 60)) return Double.NaN
    val x = deg + min / 60
    return when (hemi) { "S", "W" -> -x; "N", "E" -> x; else -> Double.NaN }
}
private fun inRange(p: Position?): Position? = if (p != null && abs(p.lat) <= 90 && abs(p.lon) <= 180 && !(p.lat == 0.0 && p.lon == 0.0)) p else null

/** True when the sentence's checksum (the XOR between '$' and '*') is right; a sentence without one fails. */
fun nmeaChecksumOk(s: String): Boolean {
    val star = s.lastIndexOf('*')
    if (s.isEmpty() || s[0] != '$' || star < 0 || star + 3 > s.length) return false
    var x = 0; for (i in 1 until star) x = x xor s[i].code
    val hh = s.substring(star + 1, star + 3)
    return HEX2.matches(hh) && hh.toInt(16) == x
}

/** One NMEA sentence ("$GPRMC,...*hh"); its checksum must check. */
fun parseNmea(line: String): Position? {
    val s = line.trim()
    if (!nmeaChecksumOk(s)) return null
    val f = s.substring(1, s.lastIndexOf('*')).split(',')
    val type = if (f[0].length >= 2) f[0].substring(2) else ""
    var p: Position? = null
    if (type == "RMC" && f.size >= 7 && f[2] == "A") p = Position(dm(f[3], f[4], 2), dm(f[5], f[6], 3), "nmea")
    else if (type == "GGA" && f.size >= 10 && f[6] != "0" && f[6] != "") {
        p = Position(dm(f[2], f[3], 2), dm(f[4], f[5], 3), "nmea")
        f[9].toDoubleOrNull()?.let { if (it.isFinite()) p.alt = it }
    } else if (type == "GLL" && f.size >= 5 && (f.size < 7 || f[6] == "A")) p = Position(dm(f[1], f[2], 2), dm(f[3], f[4], 3), "nmea")
    if (p == null || !p.lat.isFinite() || !p.lon.isFinite()) return null
    return inRange(p)
}

private val APRS_RE = Regex("^(\\d{2})([\\d ]{2}\\.[\\d ]{2})([NS])(.)(\\d{3})([\\d ]{2}\\.[\\d ]{2})([EW])")
private val ALT_RE = Regex("/A=(-?\\d{5,6})")

/** An APRS packet or just its information field ("CALL>APxxxx,DSTAR*:!3404.50N/11815.25W>comment", or timestamped). */
fun parseAprs(text: String): Position? {
    val colon = text.indexOf(':'); val gt = text.indexOf('>')
    val info = if (colon >= 0 && gt >= 0 && gt < colon) text.substring(colon + 1) else text
    if (info.isEmpty()) return null
    val body = when (info[0]) { '!', '=' -> info.substring(1); '/', '@' -> if (info.length > 8) info.substring(8) else return null; else -> return null }
    val m = APRS_RE.find(body) ?: return null
    val g = m.groupValues
    val lat = dm(g[1] + g[2].replace(' ', '0'), g[3], 2); val lon = dm(g[5] + g[6].replace(' ', '0'), g[7], 3)
    if (!lat.isFinite() || !lon.isFinite()) return null
    val p = Position(lat, lon, "aprs")
    ALT_RE.find(body)?.let { p.alt = it.groupValues[1].toInt() * 0.3048 }
    return inRange(p)
}

/** Any position in one line of text: NMEA first, then APRS. */
fun parsePositionLine(line: String): Position? {
    val s = line.trim()
    if (s.startsWith("\$\$CRC")) { val c = s.indexOf(','); return if (c > 0) parseAprs(s.substring(c + 1)) else null }
    if (s.startsWith("$")) return parseNmea(s)
    return parseAprs(s)
}

/** Text arriving a few bytes at a time: complete lines come out on CR or LF. */
class LineBuffer {
    private val buf = StringBuilder()
    fun push(text: String): List<String> {
        val out = ArrayList<String>()
        for (ch in text) {
            if (ch == '\r' || ch == '\n') { if (buf.isNotEmpty()) out.add(buf.toString()); buf.setLength(0) }
            else if (buf.length < 256) buf.append(ch)
        }
        return out
    }
    val pending: String get() = buf.toString()
    fun reset() { buf.setLength(0) }
}
