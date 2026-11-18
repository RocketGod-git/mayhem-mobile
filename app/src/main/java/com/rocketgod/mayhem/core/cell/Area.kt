package com.rocketgod.mayhem.core.cell

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot

/*
 * WEA alert areas and geo-fencing triggers, formats derived from our own recordings (the defining document,
 * ATIS-0700041, is outside the specs this app is built from).
 * Area (warningAreaCoordinatesSegment-r15, segments joined in segment-number order): a 16-bit header of unsettled
 * meaning, then points of 44 bits, 22-bit latitude (v * 180 / 2^22 - 90) then 22-bit longitude (v * 360 / 2^22 - 180);
 * the ring closes on its first point.
 * Trigger (CMAS 4400, 8-bit data): a 2-byte header, then (message identifier, serial number) pairs of 16 bits each.
 */
data class WarningArea(val header: String, val points: List<Pair<Double, Double>>, val closed: Boolean, val bounds: DoubleArray, val areaKm2: Double)
data class TriggerPair(val id: Int, val serial: Int)
data class GeoTrigger(val header: String, val pairs: List<TriggerPair>)

private val HEX = Regex("^[0-9a-fA-F]*$")
private fun bitsOf(hex: String): String = hex.lowercase().map { it.digitToInt(16).toString(2).padStart(4, '0') }.joinToString("")

fun parseWarningArea(hex: String): WarningArea? {
    if (!HEX.matches(hex) || hex.length < 4 + 22) return null
    val body = bitsOf(hex).substring(16); val n = body.length / 44
    if (n < 3) return null
    val points = (0 until n).map { i ->
        val lat = body.substring(44 * i, 44 * i + 22).toLong(2) * 180.0 / (1 shl 22) - 90
        val lon = body.substring(44 * i + 22, 44 * i + 44).toLong(2) * 360.0 / (1 shl 22) - 180
        lat to lon
    }
    val f = points[0]; val l = points[n - 1]
    return WarningArea(hex.take(4).uppercase(), points, f == l,
        doubleArrayOf(points.minOf { it.first }, points.minOf { it.second }, points.maxOf { it.first }, points.maxOf { it.second }), ringAreaKm2(points))
}

fun parseGeoTrigger(hex: String): GeoTrigger? {
    if (hex.isEmpty() || !HEX.matches(hex) || hex.length < 12 || (hex.length - 4) % 8 != 0) return null
    val pairs = (4 until hex.length step 8).map { i -> TriggerPair(hex.substring(i, i + 4).toInt(16), hex.substring(i + 4, i + 8).toInt(16)) }
    return GeoTrigger(hex.take(4).uppercase(), pairs)
}

private const val R = 6_371_008.8
/** Local equirectangular projection around a reference latitude, in meters. */
private fun project(p: Pair<Double, Double>, lat0: Double, lon0: Double): Pair<Double, Double> {
    val k = PI / 180
    return (p.second - lon0) * k * R * cos(lat0 * k) to (p.first - lat0) * k * R
}
fun ringAreaKm2(pts: List<Pair<Double, Double>>): Double {
    if (pts.size < 3) return 0.0
    val lat0 = pts.sumOf { it.first } / pts.size; val lon0 = pts[0].second; val xy = pts.map { project(it, lat0, lon0) }
    var s = 0.0
    for (i in xy.indices) { val (x1, y1) = xy[i]; val (x2, y2) = xy[(i + 1) % xy.size]; s += x1 * y2 - x2 * y1 }
    return abs(s) / 2 / 1e6
}
fun insideRing(p: Pair<Double, Double>, pts: List<Pair<Double, Double>>): Boolean {
    var inside = false
    var j = pts.size - 1
    for (i in pts.indices) {
        val (yi, xi) = pts[i]; val (yj, xj) = pts[j]
        if ((yi > p.first) != (yj > p.first) && p.second < (xj - xi) * (p.first - yi) / (yj - yi) + xi) inside = !inside
        j = i
    }
    return inside
}
/** Shortest distance in meters from p to the ring's edge. */
fun distanceToEdgeM(p: Pair<Double, Double>, pts: List<Pair<Double, Double>>): Double {
    val xy = pts.map { project(it, p.first, p.second) }
    var best = Double.POSITIVE_INFINITY
    for (i in xy.indices) {
        val (ax, ay) = xy[i]; val (bx, by) = xy[(i + 1) % xy.size]; val dx = bx - ax; val dy = by - ay; val l = dx * dx + dy * dy
        val t = if (l != 0.0) (-(ax * dx + ay * dy) / l).coerceIn(0.0, 1.0) else 0.0
        best = minOf(best, hypot(ax + t * dx, ay + t * dy))
    }
    return best
}
/** Where the receiver stands relative to an alert area: inside or not, and meters to its edge. */
fun areaRelation(p: Pair<Double, Double>, a: WarningArea): Pair<Boolean, Double> = insideRing(p, a.points) to distanceToEdgeM(p, a.points)
