package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.BitSync
import com.rocketgod.mayhem.core.DiscFilter
import com.rocketgod.mayhem.core.HdlcFramer
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

data class AprsWx(
    val windDir: Int? = null, val windMph: Int? = null, val gustMph: Int? = null, val tempF: Int? = null,
    /** Hundredths of an inch. */
    val rain1h: Int? = null, val rain24h: Int? = null, val rainMidnight: Int? = null,
    val humidity: Int? = null, val pressureMb: Double? = null,
) {
    fun merge(o: AprsWx) = AprsWx(o.windDir ?: windDir, o.windMph ?: windMph, o.gustMph ?: gustMph, o.tempF ?: tempF, o.rain1h ?: rain1h,
        o.rain24h ?: rain24h, o.rainMidnight ?: rainMidnight, o.humidity ?: humidity, o.pressureMb ?: pressureMb)
}

/** One station, object or item, as its packets have described it (newest value wins). */
data class AprsStation(
    val call: String,
    /** station, object or item */
    var kind: String = "station",
    var owner: String? = null,
    var lat: Double? = null, var lon: Double? = null,
    var symbol: Char? = null, var table: Char? = null,
    /** Degrees, knots, metres. */
    var course: Int? = null, var speed: Double? = null, var alt: Double? = null,
    var comment: String? = null, var status: String? = null, var mice: String? = null,
    /** The last packet's destination, digipeater path, and the IGate that relayed it (third-party). */
    var dest: String? = null, var path: String? = null, var via: String? = null,
    var wx: AprsWx? = null,
    var lastMsg: Pair<String, String>? = null,
    var packets: Int = 0, var firstMs: Long = 0, var lastMs: Long = 0,
)

private val MICE_MSG = listOf("Emergency", "Priority", "Special", "Committed", "Returning", "In service", "En route", "Off duty")

/**
 * APRS receiver (Mayhem proc_aprsrx): Bell 202 AFSK (1200 / 2200 Hz) on the NFM discriminator, demodulated with a
 * sliding one-bit tone correlator, NRZI + AX.25 framed and FCS-checked. The payload is read the way APRS clients do:
 * uncompressed, compressed (base-91) and Mic-E positions with course, speed and altitude, status, messages, objects
 * and items, weather, and third-party (IGate) wrapping. Every station heard keeps a record.
 */
class AprsDecoder(private val log: PacketLog) : IqProcessor {
    override val wantsFm: Boolean get() = true

    private var fmRate = 0
    private var spb = 40
    private var ring = FloatArray(40)
    private var ri = 0
    private var ph1 = 0.0; private var ph2 = 0.0
    private var w1 = 0.0; private var w2 = 0.0
    private var c1 = 0.0; private var s1 = 0.0; private var c2 = 0.0; private var s2 = 0.0
    private var sinceRecompute = 0
    private var sync = BitSync(1200.0, 48000.0)
    private var filt = DiscFilter(3200.0, 48000.0)
    private val framer = HdlcFramer(400) { onFrame(it) }
    private val stations = HashMap<String, AprsStation>()
    private val _stations = MutableStateFlow<List<AprsStation>>(emptyList())
    /** Most recently heard first. */
    val table: StateFlow<List<AprsStation>> = _stations.asStateFlow()

    override fun reset(rate: Int) { fmRate = 0; framer.reset() }
    override fun onIq(iq: ByteArray, len: Int, rate: Int) {}

    fun clear() { synchronized(stations) { stations.clear() }; _stations.value = emptyList() }

    private fun configure(rate: Int) {
        fmRate = rate
        spb = (rate / 1200.0).roundToInt().coerceAtLeast(4)
        ring = FloatArray(spb); ri = 0
        w1 = 2.0 * Math.PI * 1200.0 / rate; w2 = 2.0 * Math.PI * 2200.0 / rate
        ph1 = 0.0; ph2 = 0.0; c1 = 0.0; s1 = 0.0; c2 = 0.0; s2 = 0.0; sinceRecompute = 0
        sync = BitSync(1200.0, rate.toDouble())
        filt = DiscFilter(3200.0, rate.toDouble())
        framer.reset()
    }

    override fun onFm(samples: FloatArray, n: Int, rate: Int) {
        if (rate != fmRate) configure(rate)
        val twoPi = 2.0 * Math.PI
        for (i in 0 until n) {
            val x = filt.push(samples[i].toDouble()).toFloat()
            val old = ring[ri]
            ring[ri] = x
            ri = if (ri + 1 >= spb) 0 else ri + 1
            var o1 = ph1 - w1 * spb; while (o1 < 0) o1 += twoPi
            var o2 = ph2 - w2 * spb; while (o2 < 0) o2 += twoPi
            c1 += x * cos(ph1) - old * cos(o1); s1 += x * sin(ph1) - old * sin(o1)
            c2 += x * cos(ph2) - old * cos(o2); s2 += x * sin(ph2) - old * sin(o2)
            ph1 += w1; if (ph1 >= twoPi) ph1 -= twoPi
            ph2 += w2; if (ph2 >= twoPi) ph2 -= twoPi
            if (++sinceRecompute >= 4096) { sinceRecompute = 0; recompute() }
            val d = ((c1 * c1 + s1 * s1) - (c2 * c2 + s2 * s2)).toFloat()   // mark (1200) positive
            val b = sync.push(d)
            if (b >= 0) framer.pushRaw(b)
        }
    }

    /** Rebuild the running correlator sums from the ring to stop floating-point drift. */
    private fun recompute() {
        val twoPi = 2.0 * Math.PI
        c1 = 0.0; s1 = 0.0; c2 = 0.0; s2 = 0.0
        for (j in 0 until spb) {
            val v = ring[(ri + j) % spb]
            var a1 = ph1 - w1 * (spb - j); while (a1 < 0) a1 += twoPi
            var a2 = ph2 - w2 * (spb - j); while (a2 < 0) a2 += twoPi
            c1 += v * cos(a1); s1 += v * sin(a1); c2 += v * cos(a2); s2 += v * sin(a2)
        }
    }

    private fun onFrame(f: ByteArray) {
        if (f.size < 18 || !HdlcFramer.fcsOk(f)) return
        // AX.25 addresses: 7 bytes each, characters shifted left one; the low bit of the last byte ends the list.
        var p = 0
        val addrs = ArrayList<String>()
        var last = false
        while (!last && p + 7 <= f.size - 2 && addrs.size < 10) {
            val sb = StringBuilder()
            for (k in 0 until 6) { val ch = ((f[p + k].toInt() and 0xff) shr 1).toChar(); if (ch != ' ') sb.append(ch) }
            val ssidByte = f[p + 6].toInt() and 0xff
            val ssid = (ssidByte shr 1) and 0x0f
            if (ssid != 0) sb.append('-').append(ssid)
            if (addrs.size >= 2 && (ssidByte and 0x80) != 0) sb.append('*')
            last = (ssidByte and 1) != 0
            addrs.add(sb.toString())
            p += 7
        }
        if (addrs.size < 2 || p + 2 > f.size - 2) return
        p += 2
        val info = String(f, p, f.size - 2 - p, Charsets.ISO_8859_1)
        packet(addrs[1], addrs[0], if (addrs.size > 2) addrs.subList(2, addrs.size).joinToString(",") else "", info)
    }

    /** One decoded packet: update the records, log it, publish. */
    fun packet(src: String, dest: String, path: String, info: String, now: Long = System.currentTimeMillis()) {
        val st = synchronized(stations) { digest(src, dest, path, info, null, now) }
        val la = st?.lat; val lo = st?.lon
        log.add("$src>$dest${if (path.isNotEmpty()) ",$path" else ""}:$info" + if (la != null && lo != null) " [%.4f,%.4f]".format(la, lo) else "")
        _stations.value = synchronized(stations) {
            stations.values.removeIf { now - it.lastMs > 60 * 60_000L }
            stations.values.sortedByDescending { it.lastMs }.take(200).map { it.copy() }
        }
    }

    private fun station(call: String, kind: String, now: Long): AprsStation {
        val s = stations.getOrPut(call) { AprsStation(call, kind, firstMs = now) }
        s.kind = kind; s.lastMs = now; s.packets++
        return s
    }

    private fun digest(src: String, dest: String, path: String, info: String, via: String?, now: Long): AprsStation? {
        if (info.isEmpty()) return null
        // third-party: an IGate wraps the original packet; read the inner one and remember who relayed it
        if (info[0] == '}') {
            val m = Regex("^([A-Za-z0-9-]+)>([^:]+):([\\s\\S]*)$").find(info.substring(1)) ?: return null
            val parts = m.groupValues[2].split(',')
            return digest(m.groupValues[1], parts[0], parts.drop(1).joinToString(","), m.groupValues[3], src, now)
        }
        val s = station(src, "station", now)
        s.dest = dest; s.path = path; s.via = via
        when (val t = info[0]) {
            '!', '=' -> position(s, info.substring(1))
            '/', '@' -> if (info.length > 8) position(s, info.substring(8))
            '`', '\'', '\u001c', '\u001d' -> micE(s, dest, info.substring(1))
            '>' -> s.status = info.substring(1).replace(Regex("^\\d{6}[zh/]"), "").trim()
            ':' -> Regex("^:([^:]{9}):([\\s\\S]*)$").find(info)?.let { m ->
                val to = m.groupValues[1].trim(); val text = m.groupValues[2].replace(Regex("\\{[^}]*$"), "").trim()
                if (!Regex("^(ack|rej)\\d+").containsMatchIn(text)) s.lastMsg = to to text
            }
            ';' -> Regex("^;(.{9})([*_])(.{7})([\\s\\S]*)$").find(info)?.let { m ->
                val o = station(m.groupValues[1].trim(), "object", now)
                o.owner = src; o.dest = dest; o.path = path; o.via = via
                if (m.groupValues[2] == "*") position(o, m.groupValues[4]) else o.comment = "killed"
                return o
            }
            ')' -> Regex("^\\)([^!_]{3,9})([!_])([\\s\\S]*)$").find(info)?.let { m ->
                val o = station(m.groupValues[1].trim(), "item", now)
                o.owner = src; o.dest = dest; o.path = path; o.via = via
                if (m.groupValues[2] == "!") position(o, m.groupValues[3]) else o.comment = "killed"
                return o
            }
            '_' -> if (info.length > 9) s.wx = (s.wx ?: AprsWx()).merge(parseWx(info.substring(9)))
            'T', '<', '?', '{' -> {}
            else -> { if (t >= ' ') s.comment = info.trim() }
        }
        return s
    }

    /** Position body (after the type indicator and any timestamp): uncompressed or compressed, then the extras. */
    private fun position(s: AprsStation, body: String) {
        var rest: String
        if (Regex("^\\d{4}\\.\\d{2}[NS]").containsMatchIn(body) && body.length >= 19) {
            val lat = body.substring(0, 8); val lon = body.substring(9, 18)
            val la = lat.substring(0, 2).toIntOrNull()?.let { d -> lat.substring(2, 7).replace(' ', '0').toDoubleOrNull()?.let { d + it / 60 } }
            val lo = lon.substring(0, 3).toIntOrNull()?.let { d -> lon.substring(3, 8).replace(' ', '0').toDoubleOrNull()?.let { d + it / 60 } }
            if (la != null && lo != null) { s.lat = if (lat[7] == 'S') -la else la; s.lon = if (lon[8] == 'W') -lo else lo }
            s.table = body[8]; s.symbol = body[18]; rest = body.substring(19)
        } else if (body.length >= 13 && Regex("^[/\\\\A-Za-j]").containsMatchIn(body)) {
            fun b91(t: String): Long { var v = 0L; for (ch in t) v = v * 91 + (ch.code - 33); return v }
            s.table = body[0]; s.lat = 90 - b91(body.substring(1, 5)) / 380926.0; s.lon = -180 + b91(body.substring(5, 9)) / 190463.0; s.symbol = body[9]
            val c = body[10]; val sp = body[11]; val ty = body[12].code - 33
            if (c != ' ') {
                if ((ty and 0x18) == 0x10) s.alt = 1.002.pow(b91(body.substring(10, 12)).toDouble()) * 0.3048
                else if (c != '{') { s.course = (c.code - 33) * 4; s.speed = 1.08.pow(sp.code - 33) - 1 }
            }
            rest = body.substring(13)
        } else { s.comment = body.trim(); return }
        if (s.symbol == '_') {
            s.wx = (s.wx ?: AprsWx()).merge(parseWx(rest))
            s.comment = rest.replace(Regex("^(\\d{3}/\\d{3})?[cSgtrpPhbLls#\\d.-]*"), "").trim().ifEmpty { s.comment }
            return
        }
        Regex("^(\\d{3})/(\\d{3})").find(rest)?.let { m ->
            val c = m.groupValues[1].toInt(); val sp = m.groupValues[2].toInt()
            s.course = if (c == 0 && sp == 0) null else c % 360; s.speed = sp.toDouble(); rest = rest.substring(7)
        }
        Regex("/A=(-?\\d{6})").find(rest)?.let { m -> s.alt = m.groupValues[1].toInt() * 0.3048; rest = rest.replace(m.value, "") }
        rest = rest.replace(Regex("^PHG\\d{4}"), "").replace(Regex("^RNG\\d{4}"), "").replace(Regex("!w..!"), "").trim()
        if (rest.isNotEmpty()) s.comment = rest
    }

    /** Mic-E: latitude, message and offsets ride in the destination address, the rest in the first payload bytes. */
    private fun micE(s: AprsStation, dest: String, body: String) {
        val d = dest.split('-')[0]
        if (d.length < 6 || body.length < 8) return
        val lat = StringBuilder(); var bits = 0; var north = false; var off100 = false; var west = false
        for (i in 0 until 6) {
            val c = d[i]; var digit = ' '; var bit = 0; var flag = false
            when (c) {
                in '0'..'9' -> digit = c
                in 'A'..'J' -> { digit = '0' + (c - 'A'); bit = 1 }
                'K' -> bit = 1
                'L' -> {}
                in 'P'..'Y' -> { digit = '0' + (c - 'P'); bit = 1; flag = true }
                'Z' -> { bit = 1; flag = true }
                else -> return
            }
            lat.append(digit); if (i < 3) bits = bits * 2 + bit
            if (i == 3) north = flag; if (i == 4) off100 = flag; if (i == 5) west = flag
        }
        val l = lat.toString().replace(' ', '0')
        val la = l.substring(0, 2).toInt() + "${l.substring(2, 4)}.${l.substring(4, 6)}".toDouble() / 60
        var lonDeg = body[0].code - 28; if (off100) lonDeg += 100
        if (lonDeg in 180..189) lonDeg -= 80 else if (lonDeg in 190..199) lonDeg -= 190
        var lonMin = body[1].code - 28; if (lonMin >= 60) lonMin -= 60
        val lonHun = body[2].code - 28
        val lo = lonDeg + (lonMin + lonHun / 100.0) / 60
        if (la > 90 || lo > 180) return
        s.lat = if (north) la else -la; s.lon = if (west) -lo else lo
        var sp = (body[3].code - 28) * 10; val dc = body[4].code - 28; sp += dc / 10
        var crs = (dc % 10) * 100 + (body[5].code - 28)
        if (sp >= 800) sp -= 800; if (crs >= 400) crs -= 400
        s.speed = sp.toDouble(); s.course = if (crs == 0 && sp == 0) null else crs % 360
        s.symbol = body[6]; s.table = body[7]
        s.mice = MICE_MSG[bits]
        var rest = body.substring(8)
        if (rest.isNotEmpty() && (rest[0] == '`' || rest[0] == '\'')) rest = rest.drop(if (rest[0] == '`') 5 else 3)
        Regex("^(.{3})\\}").find(rest)?.let { m -> var v = 0; for (ch in m.groupValues[1]) v = v * 91 + (ch.code - 33); s.alt = (v - 10000).toDouble(); rest = rest.substring(4) }
        rest = rest.replace(Regex("[\\x00-\\x1f\\x7f]"), "").replace(Regex("[\\]>_^]$"), "").trim()
        if (rest.isNotEmpty()) s.comment = rest
    }
}

/** Weather fields: a letter key and a fixed-width value (c wind dir, s mph, g gust, t °F, r/p/P rain, h humidity, b pressure). */
internal fun parseWx(t0: String): AprsWx {
    var t = t0
    var dir: Int? = null; var spd: Int? = null
    Regex("^(\\d{3})/(\\d{3})").find(t)?.let { m -> dir = m.groupValues[1].toInt(); spd = m.groupValues[2].toInt(); t = t.substring(7) }
    fun num(key: String, len: Int): Double? {
        val m = Regex(key + "(-?[\\d .]{$len})").find(t) ?: return null
        if (m.groupValues[1].contains("..")) return null
        return m.groupValues[1].trim().toDoubleOrNull()
    }
    num("c", 3)?.let { dir = it.toInt() }
    num("s", 3)?.let { spd = it.toInt() }
    val h = num("h", 2)?.toInt()?.let { if (it == 0) 100 else it }
    return AprsWx(dir, spd, num("g", 3)?.toInt(), num("t", 3)?.toInt(), num("r", 3)?.toInt(), num("p", 3)?.toInt(), num("P", 3)?.toInt(),
        h, num("b", 5)?.let { it / 10 })
}
