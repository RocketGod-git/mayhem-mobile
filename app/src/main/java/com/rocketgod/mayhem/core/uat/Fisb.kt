package com.rocketgod.mayhem.core.uat

/**
 * FIS-B (DO-267A / DO-358) from UAT ground uplinks (DO-282B): the products inside each 432-byte uplink message, and a
 * UAT aircraft downlink read into its fields. The twin of the web app's dsp/uat/fisb.ts and traffic.ts.
 *
 * Uplink message: an 8-byte header (the ground station's position, flags, slot), then information frames: a 9-bit
 * length, 3 reserved bits and a 4-bit type; type 0 holds one FIS-B APDU: A, G, P flags, an 11-bit product ID, an S
 * (segmented) flag, a 2-bit time option, the time, then the product's payload.
 *
 * - 63 / 64 NEXRAD radar (regional / CONUS): a 3-byte block reference (run-length or empty flag, north/south, a 2-bit
 *   scale, a 20-bit block number: 450 blocks a row, each 4 arc-minutes tall and 48 wide), then run-length bytes (5-bit
 *   run + 1, 3-bit intensity 0-7) filling 128 bins (32 wide, 4 rows), or a bitmap of further empty blocks.
 * - Text (413 METAR / TAF / PIREP / winds, and the NOTAM, AIRMET, SIGMET products): FIS-B's 6-bit text.
 */
data class UatStation(val lat: Double, val lon: Double, val slot: Int, val site: Int, val utc: Boolean)
data class FisbProduct(val id: Int, val hh: Int, val mm: Int, val month: Int?, val day: Int?, val payload: ByteArray)
/** South-west corner and size (degrees); [bins] 128 intensities, 32 a row, the northern row first, or null when empty. */
class RadarBlock(val product: Int, val block: Int, val scale: Int, val lat: Double, val lon: Double, val dLat: Double, val dLon: Double, val bins: ByteArray?)

data class Metar(
    val station: String, val raw: String, val day: Int? = null, val hh: Int? = null, val mm: Int? = null,
    val windDir: Int? = null, val windKt: Int? = null, val gustKt: Int? = null, val visSm: Double? = null,
    val ceilingFt: Int? = null, val sky: List<String> = emptyList(), val tempC: Int? = null, val dewC: Int? = null,
    val altimInHg: Double? = null, val wx: List<String> = emptyList(), val category: String? = null,
)

data class UatTarget(
    val address: String, val qualifier: Int, val payloadType: Int,
    val lat: Double? = null, val lon: Double? = null, val altFt: Int? = null, val altGeo: Boolean = false,
    val onGround: Boolean = false, val speedKt: Int? = null, val trackDeg: Int? = null, val vertFpm: Int? = null,
    val callsign: String? = null, val emitter: Int? = null,
)

/** One block of a gridded hazard (icing, turbulence, cloud tops, lightning) at one altitude [level]; null bins: nothing there. */
class HazardBlock(val product: Int, val block: Int, val level: Int, val lat: Double, val lon: Double, val dLat: Double, val dLon: Double, val bins: ByteArray?)

/** Time of a G-AIRMET or area: month, day, hour, minute (UTC). */
data class FisbTime(val month: Int, val day: Int, val hh: Int, val mm: Int)

/**
 * A drawn hazard: for G-AIRMETs [element] is 1 turbulence, 2 low-level wind shear, 3 surface wind, 4 icing,
 * 5 freezing level, 6 IFR, 7 mountain obscuration. [pts] lat, lon; [altsFt] the altitudes on its vertices.
 */
data class Overlay(val product: Int, val element: Int, val location: String, val report: Int, val geometry: Int, val line: Boolean,
                   val start: FisbTime, val end: FisbTime, val pts: List<Pair<Double, Double>>, val altsFt: List<Int>)

/** A special use airspace schedule in its parts. */
data class Sua(val name: String, val from: String?, val to: String?, val bottomFt: Int?, val topFt: Int?)

object Fisb {
    private fun u(b: ByteArray, i: Int) = b[i].toInt() and 0xff

    fun station(b: ByteArray): UatStation {
        var lat = ((u(b, 0) shl 15) or (u(b, 1) shl 7) or (u(b, 2) shr 1)) * 360.0 / (1 shl 24); if (lat > 90) lat -= 180
        var lon = (((u(b, 2) and 1) shl 23) or (u(b, 3) shl 15) or (u(b, 4) shl 7) or (u(b, 5) shr 1)) * 360.0 / (1 shl 24); if (lon > 180) lon -= 360
        return UatStation(lat, lon, u(b, 6) and 0x1f, u(b, 7) shr 4, u(b, 6) and 0x80 != 0)
    }

    private class Bits(private val d: ByteArray) {
        var p = 0
        fun take(n: Int): Int { var v = 0; repeat(n) { v = (v shl 1) or ((d[p shr 3].toInt() shr (7 - (p and 7))) and 1); p++ }; return v }
    }

    /** Every FIS-B product in one uplink message. */
    fun products(msg: ByteArray): List<FisbProduct> {
        val out = ArrayList<FisbProduct>()
        if (u(msg, 6) and 0x20 == 0) return out
        var i = 8
        while (i + 2 <= msg.size) {
            val len = (u(msg, i) shl 1) or (u(msg, i + 1) shr 7)
            val type = u(msg, i + 1) and 0x0f
            if (len == 0) break
            val end = minOf(msg.size, i + 2 + len)
            val data = msg.copyOfRange(i + 2, end)
            i += 2 + len
            if (type != 0 || data.size < 4) continue
            val r = Bits(data)
            r.take(3)
            val id = r.take(11)
            val seg = r.take(1)
            val tOpt = r.take(2)
            var month: Int? = null; var day: Int? = null
            if (tOpt >= 2) { month = r.take(4); day = r.take(5) }
            val hh = r.take(5); val mm = r.take(6)
            if (tOpt == 1 || tOpt == 3) r.take(6)
            if (seg != 0) continue
            out.add(FisbProduct(id, hh, mm, month, day, data.copyOfRange(minOf(data.size, (r.p + 7) shr 3), data.size)))
        }
        return out
    }

    private val SCALE = intArrayOf(1, 5, 9, 9)

    private fun place(block: Int, south: Boolean, scale: Int): DoubleArray {
        val below = 450 * 900
        val row: Int; val col: Int; val wide: Double
        if (block < below) { row = block / 450; col = block % 450; wide = 48 / 60.0 } else { val b = block - below; row = 900 + b / 225; col = b % 225; wide = 96 / 60.0 }
        val k = SCALE[scale]
        var lat = row * 4 / 60.0; var lon = col * wide
        if (south) lat = -lat - 4 / 60.0 * k
        if (lon > 180) lon -= 360
        return doubleArrayOf(lat, lon, 4 / 60.0 * k, wide * k)
    }

    /** Radar blocks in one product 63/64 payload. */
    fun radarBlocks(p: FisbProduct): List<RadarBlock> {
        val d = p.payload
        if (d.size < 3) return emptyList()
        val rle = (u(d, 0) shr 7) and 1; val south = (u(d, 0) shr 6) and 1 == 1; val scale = (u(d, 0) shr 4) and 3
        val block = ((u(d, 0) and 0x0f) shl 16) or (u(d, 1) shl 8) or u(d, 2)
        val pl = place(block, south, scale)
        if (rle == 1) {
            val bins = ByteArray(128); var n = 0
            var i = 3
            while (i < d.size && n < 128) {
                val run = (u(d, i) shr 3) + 1; val v = (u(d, i) and 7).toByte()
                repeat(run) { if (n < 128) bins[n++] = v }
                i++
            }
            if (n != 128) return emptyList()
            return listOf(RadarBlock(p.id, block, scale, pl[0], pl[1], pl[2], pl[3], bins))
        }
        val out = arrayListOf(RadarBlock(p.id, block, scale, pl[0], pl[1], pl[2], pl[3], null))
        if (d.size > 3) {
            val nBytes = u(d, 3) and 0x0f
            val bits = ArrayList<Int>()
            for (k in 4 until 8) bits.add((u(d, 3) shr k) and 1)
            for (j in 0 until nBytes) { if (4 + j >= d.size) break; for (k in 0 until 8) bits.add((u(d, 4 + j) shr k) and 1) }
            bits.forEachIndexed { idx, on -> if (on == 1) { val b = block + idx + 1; val q = place(b, south, scale); out.add(RadarBlock(p.id, b, scale, q[0], q[1], q[2], q[3], null)) } }
        }
        return out
    }

    private fun char6(c: Int): String = when (c) {
        in 1..26 -> ('A' + c - 1).toString()
        in 32..63 -> c.toChar().toString()
        28 -> "\t"; 29, 30 -> "\n"
        31 -> "|"   // field separator (special use airspace schedules)
        else -> ""
    }

    private val KEYWORDS = listOf("METAR", "SPECI", "TAF", "NOTAM", "PIREP", "WINDS", "SIGMET", "AIRMET", "CWA", "SUA")
    private val PLAIN = Regex("[A-Z0-9 /.\\-\n]")

    /** The readable 6-bit text in a payload; records that are not text (graphic overlays) come back empty. */
    fun text(payload: ByteArray): String {
        var best = ""; var bestScore = 0
        val nbits = payload.size * 8
        for (off in 0 until 6) {
            val sb = StringBuilder()
            var p = off
            while (p + 6 <= nbits) {
                var v = 0
                for (k in 0 until 6) v = (v shl 1) or ((payload[(p + k) shr 3].toInt() shr (7 - ((p + k) and 7))) and 1)
                sb.append(char6(v)); p += 6
            }
            val s = sb.toString()
            val at = KEYWORDS.map { s.indexOf(it) }.filter { it >= 0 }
            val cand = if (at.isNotEmpty()) s.substring(at.min()) else s
            var score = 0
            for (ch in cand) score += if (PLAIN.matches(ch.toString())) 1 else -3
            if (score > bestScore) { best = cand; bestScore = score }
        }
        best = best.trim()
        return if (KEYWORDS.any { best.startsWith(it) }) best else ""
    }

    private fun temp(s: String) = if (s.startsWith("M")) -s.drop(1).toInt() else s.toInt()
    private val RE_HEAD = Regex("^(METAR|SPECI)\\s+([A-Z0-9]{4})\\s+(.*)$")
    private val RE_TIME = Regex("^(\\d{2})(\\d{2})(\\d{2})Z$")
    private val RE_WIND = Regex("^(\\d{3}|VRB)(\\d{2,3})(?:G(\\d{2,3}))?KT$")
    private val RE_VIS = Regex("^(M)?(\\d+)?SM$")
    private val RE_VIS_FRAC = Regex("^(\\d)/(\\d)SM$")
    private val RE_SKY = Regex("^(FEW|SCT|BKN|OVC|VV)(\\d{3})")
    private val RE_TEMP = Regex("^(M?\\d{2})/(M?\\d{2})?$")
    private val RE_ALT = Regex("^A(\\d{4})$")
    private val RE_WX = Regex("^[-+]?(VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|SQ|FC|SS|DS)+$")

    /** A METAR read into the parts a display needs, with its flight category. */
    fun metar(text: String): Metar? {
        val m = RE_HEAD.find(text.replace(Regex("\\s+"), " ").trim()) ?: return null
        val raw = "${m.groupValues[1]} ${m.groupValues[2]} ${m.groupValues[3]}".replace(Regex("=.*$"), "").trim()
        var day: Int? = null; var hh: Int? = null; var mm: Int? = null; var wd: Int? = null; var wk: Int? = null; var gk: Int? = null
        var vis: Double? = null; var ceil: Int? = null; val sky = ArrayList<String>(); var t: Int? = null; var dw: Int? = null
        var alt: Double? = null; val wx = ArrayList<String>()
        for (tok in m.groupValues[3].split(" RMK")[0].split(" ")) {
            RE_TIME.matchEntire(tok)?.let { day = it.groupValues[1].toInt(); hh = it.groupValues[2].toInt(); mm = it.groupValues[3].toInt() }
                ?: RE_WIND.matchEntire(tok)?.let { wd = it.groupValues[1].toIntOrNull(); wk = it.groupValues[2].toInt(); gk = it.groupValues[3].toIntOrNull() }
                ?: RE_VIS.matchEntire(tok)?.takeIf { it.groupValues[2].isNotEmpty() }?.let { vis = it.groupValues[2].toDouble() }
                ?: RE_VIS_FRAC.matchEntire(tok)?.let { vis = it.groupValues[1].toDouble() / it.groupValues[2].toDouble() }
                ?: RE_SKY.find(tok)?.let {
                    val ft = it.groupValues[2].toInt() * 100
                    sky.add("${it.groupValues[1]} ${"%,d".format(java.util.Locale.US, ft)}")
                    if (it.groupValues[1] in listOf("BKN", "OVC", "VV") && (ceil == null || ft < ceil!!)) ceil = ft
                }
                ?: (if (tok == "CLR" || tok == "SKC" || tok == "NSC") { sky.add("clear"); Unit } else null)
                ?: RE_TEMP.matchEntire(tok)?.let { t = temp(it.groupValues[1]); if (it.groupValues[2].isNotEmpty()) dw = temp(it.groupValues[2]) }
                ?: RE_ALT.matchEntire(tok)?.let { alt = it.groupValues[1].toInt() / 100.0 }
                ?: (if (RE_WX.matches(tok)) wx.add(tok) else Unit)
        }
        val c = ceil ?: Int.MAX_VALUE; val v = vis ?: Double.MAX_VALUE
        val cat = if (vis == null && sky.isEmpty()) null else if (c < 500 || v < 1) "LIFR" else if (c < 1000 || v < 3) "IFR" else if (c <= 3000 || v <= 5) "MVFR" else "VFR"
        return Metar(m.groupValues[2], raw, day, hh, mm, wd, wk, gk, vis, ceil, sky, t, dw, alt, wx, cat)
    }

    private const val B40 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ  .."

    /** One basic (18-byte) or long (34-byte) UAT ADS-B frame. */
    fun downlink(b: ByteArray): UatTarget {
        val pt = u(b, 0) shr 3; val q = u(b, 0) and 7
        val address = "%06X".format(java.util.Locale.US, (u(b, 1) shl 16) or (u(b, 2) shl 8) or u(b, 3))
        val rawLat = (u(b, 4) shl 15) or (u(b, 5) shl 7) or (u(b, 6) shr 1)
        val rawLon = ((u(b, 6) and 1) shl 23) or (u(b, 7) shl 15) or (u(b, 8) shl 7) or (u(b, 9) shr 1)
        val rawAlt = (u(b, 10) shl 4) or (u(b, 11) shr 4)
        var lat: Double? = null; var lon: Double? = null
        if (rawLat != 0 || rawLon != 0) {
            lat = rawLat * 360.0 / (1 shl 24); if (lat > 90) lat -= 180
            lon = rawLon * 360.0 / (1 shl 24); if (lon > 180) lon -= 360
        }
        val ag = u(b, 12) shr 6
        var speed: Int? = null; var track: Int? = null; var vert: Int? = null
        if (ag == 0 || ag == 1) {
            val ns = ((u(b, 12) and 0x1f) shl 6) or (u(b, 13) shr 2)
            val ew = ((u(b, 13) and 0x03) shl 9) or (u(b, 14) shl 1) or (u(b, 15) shr 7)
            val nsMag = ns and 0x3ff; val ewMag = ew and 0x3ff
            if (nsMag != 0 && ewMag != 0) {
                val scale = if (ag == 1) 4 else 1
                val vn = (nsMag - 1) * scale * (if (ns and 0x400 != 0) -1 else 1)
                val ve = (ewMag - 1) * scale * (if (ew and 0x400 != 0) -1 else 1)
                speed = Math.round(Math.hypot(vn.toDouble(), ve.toDouble())).toInt()
                track = Math.round((Math.toDegrees(Math.atan2(ve.toDouble(), vn.toDouble())) + 360) % 360).toInt()
            }
            val vv = ((u(b, 15) and 0x7f) shl 4) or (u(b, 16) shr 4)
            val vMag = vv and 0x1ff
            if (vMag != 0) vert = (vMag - 1) * 64 * (if (vv and 0x200 != 0) -1 else 1)
        }
        var cs: String? = null; var emitter: Int? = null
        if (b.size >= 34 && (pt == 1 || pt == 3)) {
            val w1 = (u(b, 17) shl 8) or u(b, 18); val w2 = (u(b, 19) shl 8) or u(b, 20); val w3 = (u(b, 21) shl 8) or u(b, 22)
            emitter = (w1 / 1600) % 40
            val s = intArrayOf(w1 / 40 % 40, w1 % 40, w2 / 1600 % 40, w2 / 40 % 40, w2 % 40, w3 / 1600 % 40, w3 / 40 % 40, w3 % 40)
                .joinToString("") { B40[it].toString() }.trim()
            if (s.isNotEmpty()) cs = s
        }
        return UatTarget(address, q, pt, lat, lon, if (rawAlt != 0) (rawAlt - 1) * 25 - 1000 else null, u(b, 9) and 1 == 1, ag == 2, speed, track, vert, cs, emitter)
    }

    /** The altitude, ft, of an icing or turbulence level (low products 70 / 90 from 2,000 ft, high 71 / 91 from 18,000). */
    fun hazardAltFt(product: Int, level: Int) = (if (product == 71 || product == 91) 18000 else 2000) + level * 2000

    /**
     * The gridded hazards, worked out from our recordings: the radar's block reference, but the three bits after the
     * run-length flag are the altitude level. Icing (70 / 71) is (run - 1, value) byte pairs; cloud tops (84),
     * turbulence (90 / 91) and lightning (103) are (run - 1) << 4 | value bytes, with 0xE<value> followed by a long
     * run. A block that does not fill its 128 bins exactly is dropped.
     */
    fun hazardBlocks(p: FisbProduct): List<HazardBlock> {
        val d = p.payload
        if (d.size < 3) return emptyList()
        val rle = (u(d, 0) shr 7) and 1; val level = (u(d, 0) shr 4) and 7
        val block = ((u(d, 0) and 0x0f) shl 16) or (u(d, 1) shl 8) or u(d, 2)
        val pl = place(block, false, 0)
        if (rle == 1) {
            val bins = ByteArray(128); var n = 0; var i = 3
            if (p.id == 70 || p.id == 71) {
                while (i + 1 < d.size && n < 128) { val run = u(d, i) + 1; val v = d[i + 1]; i += 2; repeat(run) { if (n < 128) bins[n++] = v } }
            } else {
                while (i < d.size && n < 128) {
                    val b = u(d, i++); val run: Int; val v: Int
                    if (b shr 4 == 0xE) { v = b and 15; if (i >= d.size) return emptyList(); run = u(d, i++) + 1 } else { run = (b shr 4) + 1; v = b and 15 }
                    repeat(run) { if (n < 128) bins[n++] = v.toByte() }
                }
            }
            if (n != 128) return emptyList()
            return listOf(HazardBlock(p.id, block, level, pl[0], pl[1], pl[2], pl[3], bins))
        }
        val out = arrayListOf(HazardBlock(p.id, block, level, pl[0], pl[1], pl[2], pl[3], null))
        if (d.size > 3) {
            val nBytes = u(d, 3) and 0x0f
            val bits = ArrayList<Int>()
            for (k in 4 until 8) bits.add((u(d, 3) shr k) and 1)
            for (j in 0 until nBytes) { if (4 + j >= d.size) break; for (k in 0 until 8) bits.add((u(d, 4 + j) shr k) and 1) }
            bits.forEachIndexed { idx, on -> if (on == 1) { val b = block + idx + 1; val q = place(b, false, 0); out.add(HazardBlock(p.id, b, level, q[0], q[1], q[2], q[3], null)) } }
        }
        return out
    }

    /** An icing value: severity 0-7 (7 no data), large supercooled drops 0-3; 0xFF is no data. */
    fun icingSeverity(v: Int): Int = if (v == 0xFF) 0 else ((v shr 3) and 7).let { if (it >= 6) 0 else it }
    fun icingSld(v: Int): Boolean = v != 0xFF && (v shr 6) != 0

    private fun six4(d: ByteArray, at: Int): String {
        val v = (u(d, at) shl 16) or (u(d, at + 1) shl 8) or u(d, at + 2)
        val sb = StringBuilder()
        for (k in 3 downTo 0) { val c = (v shr (k * 6)) and 63; if (c in 1..26) sb.append('A' + c - 1) else if (c in 48..57) sb.append(c.toChar()) }
        return sb.toString()
    }

    /**
     * A graphic overlay record (format 8): found by where its vertex list fits exactly. A geometry byte (low nibble),
     * 2 bits of operator and 6 of vertex count - 1, start and end (month, day, hour, minute), then 6-byte vertices:
     * 19-bit longitude, 19-bit latitude (360 / 2^19 degrees), a 10-bit altitude in hundreds of feet.
     */
    fun overlay(p: FisbProduct): Overlay? {
        val d = p.payload
        if (d.size < 26 || u(d, 0) shr 4 != 8) return null
        fun okTime(i: Int) = u(d, i) in 1..12 && u(d, i + 1) in 1..31 && u(d, i + 2) < 24 && u(d, i + 3) < 60
        var g = 10
        while (g + 10 <= d.size) {
            val geometry = u(d, g) and 15; val cnt = (u(d, g + 1) and 63) + 1
            val v0 = g + 10
            if (geometry in intArrayOf(3, 4, 7, 8, 9, 11, 12) && v0 + cnt * 6 == d.size && okTime(g + 2) && okTime(g + 6)) {
                val pts = ArrayList<Pair<Double, Double>>(); val alts = sortedSetOf<Int>(); var bad = false
                for (k in 0 until cnt) {
                    val i = v0 + k * 6
                    val hi = (u(d, i) shl 16) or (u(d, i + 1) shl 8) or u(d, i + 2); val lo = (u(d, i + 3) shl 16) or (u(d, i + 4) shl 8) or u(d, i + 5)
                    var lon = (hi shr 5) * 360.0 / (1 shl 19); if (lon > 180) lon -= 360
                    var lat = (((hi and 31) shl 14) or (lo shr 10)) * 360.0 / (1 shl 19); if (lat > 180) lat -= 360
                    if (kotlin.math.abs(lat) > 90) { bad = true; break }
                    pts.add(lat to lon); alts.add((lo and 0x3ff) * 100)
                }
                if (!bad) return Overlay(p.id, if (p.id == 14) u(d, 13) and 7 else 0, six4(d, 2), ((u(d, 6) and 0x3f) shl 8) or u(d, 7), geometry,
                    geometry == 11 || geometry == 12, FisbTime(u(d, g + 2), u(d, g + 3), u(d, g + 4), u(d, g + 5)),
                    FisbTime(u(d, g + 6), u(d, g + 7), u(d, g + 8), u(d, g + 9)), pts, alts.toList())
            }
            g++
        }
        return null
    }

    /** A special use airspace schedule line ("SUA ...|name|...|start|end|bottom|top|...") read into its parts. */
    fun sua(text: String): Sua? {
        if (!text.startsWith("SUA")) return null
        val f = text.split('|').map { it.trim() }
        val name = f.firstOrNull { Regex("^[A-Z]{1,2}\\d{2,5}[A-Z]?$").matches(it) } ?: ""
        val whenF = f.filter { Regex("^\\d{10}$").matches(it) }
        val alts = f.filter { Regex("^\\d{3}$").matches(it) }.map { it.toInt() * 100 }
        fun t(x: String?) = x?.let { "20${it.substring(0, 2)}-${it.substring(2, 4)}-${it.substring(4, 6)} ${it.substring(6, 8)}:${it.substring(8, 10)}Z" }
        return Sua(name, t(whenF.getOrNull(0)), t(whenF.getOrNull(1)), alts.getOrNull(0), alts.getOrNull(1))
    }
}

