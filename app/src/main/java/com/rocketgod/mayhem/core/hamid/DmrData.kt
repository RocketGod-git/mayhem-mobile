package com.rocketgod.mayhem.core.hamid

import kotlin.math.abs
import kotlin.math.pow

/**
 * DMR rate 3/4 data (ETSI TS 102 361-1 B.2.4: the 8-state trellis of table B.7, the constellation of B.8, the
 * interleave of B.9) and the ETSI Location Information Protocol (TS 100 392-18-1 6.2.1 SHORT LOCATION REPORT), as DMR
 * carries it: in UDP to port 5017 and in the USBD poll response (TS 102 361-4 table 6.79). Motorola's LRRP is not a
 * published standard, is read from the layout in the DSD-FME decoder (below). The same as the web's dsp/hamid/dmrdata.ts.
 */
private val T34 = arrayOf(
    intArrayOf(0, 8, 4, 12, 2, 10, 6, 14), intArrayOf(4, 12, 2, 10, 6, 14, 0, 8), intArrayOf(1, 9, 5, 13, 3, 11, 7, 15), intArrayOf(5, 13, 3, 11, 7, 15, 1, 9),
    intArrayOf(3, 11, 7, 15, 1, 9, 5, 13), intArrayOf(7, 15, 1, 9, 5, 13, 3, 11), intArrayOf(2, 10, 6, 14, 0, 8, 4, 12), intArrayOf(6, 14, 0, 8, 4, 12, 2, 10),
)
private fun lv(v: Int) = when (v) { 1 -> 0; 3 -> 1; -1 -> 2; else -> 3 }
private val PT = arrayOf(1 to -1, -1 to -1, 3 to -3, -3 to -3, -3 to -1, 3 to -1, -1 to -3, 1 to -3, -3 to 3, 3 to 3, -1 to 1, 1 to 1, 1 to 3, -1 to 3, 3 to 1, -3 to 1)
    .map { (a, b) -> (lv(a) shl 2) or lv(b) }.toIntArray()
val R34_INTERLEAVE: IntArray = run {
    val t = ArrayList<Int>()
    for (m in 0 until 13) { t.add(8 * m); t.add(8 * m + 1) }
    for (c in intArrayOf(2, 4, 6)) for (m in 0 until 12) { t.add(c + 8 * m); t.add(c + 8 * m + 1) }
    t.toIntArray()
}
private val LEVEL = intArrayOf(1, 3, -1, -3)
private fun dibitDist(a: Int, b: Int) = (abs(LEVEL[a shr 2] - LEVEL[b shr 2]) + abs(LEVEL[a and 3] - LEVEL[b and 3])) shr 1

class Rate34(val bytes: IntArray, val metric: Int)
/** 196 payload bits → 18 octets. */
fun rate34Decode(raw: IntArray): Rate34 {
    val enc = IntArray(98)
    for (k in 0 until 98) enc[R34_INTERLEAVE[k]] = ((raw[2 * k] and 1) shl 1) or (raw[2 * k + 1] and 1)
    var pm = IntArray(8) { if (it == 0) 0 else 1 shl 20 }
    val back = IntArray(49 * 8)
    for (t in 0 until 49) {
        val sym = (enc[2 * t] shl 2) or enc[2 * t + 1]; val np = IntArray(8) { 1 shl 30 }
        for (s in 0 until 8) {
            if (pm[s] >= 1 shl 20) continue
            for (i in 0 until 8) {
                if (t == 48 && i != 0) continue
                val m = pm[s] + dibitDist(PT[T34[s][i]], sym)
                if (m < np[i]) { np[i] = m; back[t * 8 + i] = s }
            }
        }
        pm = np
    }
    val trib = IntArray(49); var s = 0
    for (t in 48 downTo 0) { trib[t] = s; s = back[t * 8 + s] }
    val bytes = IntArray(18)
    for (t in 0 until 48) for (j in 0 until 3) { val bit = 3 * t + j; if ((trib[t] shr (2 - j)) and 1 == 1) bytes[bit shr 3] = bytes[bit shr 3] or (0x80 ushr (bit and 7)) }
    return Rate34(bytes, pm[0])
}
/** 18 octets → the 196 payload bits. */
fun rate34Encode(bytes: IntArray): IntArray {
    val enc = IntArray(98); var s = 0
    for (t in 0 until 49) {
        var tr = 0
        if (t < 48) for (j in 0 until 3) { val bit = 3 * t + j; tr = (tr shl 1) or ((bytes[bit shr 3] shr (7 - (bit and 7))) and 1) }
        val p = PT[T34[s][tr]]; enc[2 * t] = p shr 2; enc[2 * t + 1] = p and 3; s = tr
    }
    val raw = IntArray(196)
    for (k in 0 until 98) { val v = enc[R34_INTERLEAVE[k]]; raw[2 * k] = v shr 1; raw[2 * k + 1] = v and 1 }
    return raw
}

private fun field(b: IntArray, from: Int, n: Int): Long { var v = 0L; for (i in from until from + n) v = v * 2 + ((b[i shr 3] shr (7 - (i and 7))) and 1); return v }

class LipReport(val lat: Double, val lon: Double, val source: String, val timeElapsed: Int, val posError: Int, val speedKmh: Double, val heading: Double)
/** LIP horizontal velocity (km/h), -1 when unknown (127). */
fun lipSpeed(k: Int): Double = if (k == 127) -1.0 else if (k <= 28) k.toDouble() else 16 * 1.038.pow(k - 13)

private fun lipFields(b: IntArray, at: Int, source: String): LipReport? {
    val te = field(b, at, 2).toInt()
    var lon = field(b, at + 2, 25); var lat = field(b, at + 27, 24)
    if (lon >= 0x1000000) lon -= 0x2000000
    if (lat >= 0x800000) lat -= 0x1000000
    val r = LipReport(lat * 180.0 / 16777216, lon * 360.0 / 33554432, source, te, field(b, at + 51, 3).toInt(), lipSpeed(field(b, at + 54, 7).toInt()), field(b, at + 61, 4) * 22.5)
    if (r.posError == 7 || (lat == 0L && lon == 0L) || abs(r.lat) > 90 || abs(r.lon) > 180) return null
    return r
}
/** A LIP PDU: only the SHORT LOCATION REPORT (PDU type 0) is read. */
fun lipShortReport(b: IntArray): LipReport? = if (b.size < 10 || field(b, 0, 2) != 0L) null else lipFields(b, 2, "lip")
/** A USBD block's 10 octets: service type 0, LIP, then the poll response fields. */
fun usbdLip(b: IntArray): LipReport? = if ((b[0] shr 4) != 0) null else lipFields(b, 4, "lip-usbd")

/** An IPv4 packet with a good header checksum holding UDP to port 5017 → its LIP report. */
fun lipInIp(b: IntArray): LipReport? {
    val u = udpPayload(b) ?: return null
    return if (u.dport == 5017 && u.data.size >= 10) lipShortReport(u.data) else null
}
/** An IPv4 packet with a good header checksum holding UDP to or from port 4001 → its LRRP report. */
fun lrrpInIp(b: IntArray): LrrpReport? {
    val u = udpPayload(b) ?: return null
    return if (u.dport == 4001 || u.sport == 4001) lrrpReport(u.data) else null
}
class Udp(val sport: Int, val dport: Int, val data: IntArray)
/** The UDP datagram in an IPv4 packet whose header checksum checks. */
fun udpPayload(b: IntArray): Udp? {
    if (b.size < 28 || (b[0] shr 4) != 4 || b[9] != 17) return null
    val ihl = (b[0] and 15) * 4; if (ihl < 20 || b.size < ihl + 8) return null
    var sum = 0; var i = 0
    while (i < ihl) { sum += (b[i] shl 8) or b[i + 1]; i += 2 }
    while (sum > 0xffff) sum = (sum and 0xffff) + (sum ushr 16)
    if (sum != 0xffff) return null
    val ulen = (b[ihl + 4] shl 8) or b[ihl + 5]
    if (ulen < 8) return null
    return Udp((b[ihl] shl 8) or b[ihl + 1], (b[ihl + 2] shl 8) or b[ihl + 3], IntArray(ulen - 8) { b.getOrElse(ihl + 8 + it) { 0 } })
}

/**
 * Motorola LRRP (UDP port 4001; not a published standard, the layout is from the DSD-FME decoder): a message type
 * (0x07, 0x0B or 0x0D), a length, then tokens: 0x22 request ID, 0x34/0x35 time, 0x51/0x54/0x55 a circle, 0x66 a point,
 * 0x69/0x6A a point with altitude, 0x56 the heading (2 degree steps), 0x6C/0x70 a speed (not read). Latitude: the top
 * bit the sign, 90/2^31 degrees; longitude two's complement, 180/2^31 degrees.
 */
class LrrpReport(val lat: Double, val lon: Double, val source: String, val heading: Double)
private val LRRP_SKIP = mapOf(0x34 to 6, 0x35 to 6, 0x36 to 2, 0x37 to 2, 0x56 to 2, 0x6c to 3, 0x70 to 3)
private val LRRP_POS = mapOf(0x51 to 11, 0x54 to 11, 0x55 to 11, 0x66 to 9, 0x69 to 10, 0x6a to 10)
fun lrrpReport(p: IntArray): LrrpReport? {
    if (p.size < 4 || (p[0] != 0x07 && p[0] != 0x0b && p[0] != 0x0d)) return null
    val end = minOf(p.size, 2 + p[1])
    var lat = Double.NaN; var lon = Double.NaN; var heading = -1.0
    fun u32(i: Int) = (p[i].toLong() shl 24) or (p[i + 1].toLong() shl 16) or (p[i + 2].toLong() shl 8) or p[i + 3].toLong()
    var i = 2
    while (i < end) {
        val t = p[i]
        if (t == 0x22 || t == 0x23) { i += 2 + (if (i + 1 < end) p[i + 1] else 0); continue }
        val n = LRRP_POS[t]
        if (n != null && i + 8 < end && lat.isNaN()) {
            val a = u32(i + 1); val o = u32(i + 5)
            lat = (a and 0x7fffffffL) * 90.0 / 2147483648.0 * (if (a >= 0x80000000L) -1 else 1)
            lon = o.toInt() * 180.0 / 2147483648.0
            i += n; continue
        }
        if (t == 0x56 && i + 1 < end) heading = p[i + 1] * 2.0
        i += LRRP_SKIP[t] ?: 1
    }
    if (!lat.isFinite() || abs(lat) > 90 || abs(lon) > 180 || (lat == 0.0 && lon == 0.0)) return null
    return LrrpReport(lat, lon, "lrrp", heading)
}
