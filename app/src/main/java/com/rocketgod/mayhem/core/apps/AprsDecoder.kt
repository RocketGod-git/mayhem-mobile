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
import kotlin.math.sqrt

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
 * APRS receiver (framing after Mayhem proc_aprsrx): Bell 202 AFSK (1200 / 2200 Hz) on the NFM discriminator,
 * demodulated with a sliding one-bit tone correlator, NRZI + AX.25 framed and FCS-checked. Pre-emphasis and radio
 * audio paths leave one tone up to several dB louder than the other, which pushes a single slicer's decisions off,
 * so (as Dire Wolf does) several slicers run side by side, each weighting the 2200 Hz tone differently, each with its
 * own clock and deframer; a frame any of them gets through the FCS is kept once. The payload is read the way APRS clients do:
 * uncompressed, compressed (base-91) and Mic-E positions with course, speed and altitude, status, messages, objects
 * and items, weather, and third-party (IGate) wrapping. Every station heard keeps a record.
 */
class AprsDecoder(private val log: PacketLog) : IqProcessor {
    companion object {
        /** 2200 Hz tone weights, ±6 dB in even steps. */
        private val GAINS = floatArrayOf(0.5f, 0.63f, 0.79f, 1.0f, 1.26f, 1.59f, 2.0f)
    }
    /**
     * It tunes its own channel from the raw IQ (onIq), so it can follow each packet's carrier: a digipeater heard here
     * sat 3 kHz low, which pushed its packets half out of a fixed ±5 kHz channel, and widening the channel to take
     * them in only let in the noise that broke them.
     */
    override val wantsFm: Boolean get() = false

    private var fmRate = 0
    private var spb = 40
    private var ring = FloatArray(40)
    private var ri = 0
    private var ph1 = 0.0; private var ph2 = 0.0
    private var w1 = 0.0; private var w2 = 0.0
    private var c1 = 0.0; private var s1 = 0.0; private var c2 = 0.0; private var s2 = 0.0
    private var sinceRecompute = 0
    private var syncs: List<BitSync> = emptyList()
    private val framers: List<HdlcFramer> = GAINS.map { _ -> HdlcFramer(400) { f -> onSliced(f) } }
    /** Sample clock and the recent frames (by FCS), so a frame two slicers both got is logged once. */
    private var clock = 0L
    private val recent = ArrayList<LongArray>()   // [fcs, at]
    private var filt = DiscFilter(3200.0, 48000.0)
    private val stations = HashMap<String, AprsStation>()
    private val _stations = MutableStateFlow<List<AprsStation>>(emptyList())
    /** Most recently heard first. */
    val table: StateFlow<List<AprsStation>> = _stations.asStateFlow()

    override fun reset(rate: Int) { fmRate = 0; chDec = null; for (f in framers) f.reset() }

    // ---- own channel with per-packet carrier tracking ----
    // Wide path (±12 kHz) finds the packet: the discriminator is steady through a packet and random between them, so
    // 10 ms blocks whose RMS drops well under the running noise level are a packet, and their mean is its carrier.
    // Narrow path (±5 kHz, what Bell 202 at ±3 kHz deviation needs) is shifted onto that carrier and demodulated.
    private var chDec: com.rocketgod.mayhem.core.ham.ChannelDecimator? = null
    private var chRate = 0; private var chKey = 0
    private var mixBuf = FloatArray(0); private var chBuf = FloatArray(0)
    private var ncoR = 1f; private var ncoI = 0f; private var ncoN = 0
    private var wide = CplxLowpass(12_000.0, 48_000.0); private var narrow = CplxLowpass(5_000.0, 48_000.0)
    private var pwI = 1f; private var pwQ = 0f; private var pnI = 1f; private var pnQ = 0f
    private var afcHz = 0.0; private var afcPh = 0.0
    private var blkN = 0; private var blkSum = 0.0; private var blkSq = 0.0; private var noiseRms = 0.0
    private var runN = 0; private var runSum = 0.0; private var runSq = 0.0

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        val n = len / 2
        val off = com.rocketgod.mayhem.core.SdrEngine.offsetHz.value
        if (n <= 0 || kotlin.math.abs(off) > rate / 2 - 20_000) return
        if (chDec == null || chKey != rate) {
            val d = com.rocketgod.mayhem.core.ham.ChannelDecimator(maxOf(1, rate / 48_000)); chDec = d; chKey = rate; chRate = rate / d.total
            wide = CplxLowpass(12_000.0, chRate.toDouble()); narrow = CplxLowpass(5_000.0, chRate.toDouble())
            afcHz = 0.0; noiseRms = 0.0; runN = 0
        }
        val dec = chDec!!
        if (mixBuf.size < 2 * n) mixBuf = FloatArray(2 * n)
        if (chBuf.size < dec.outSize(n)) chBuf = FloatArray(dec.outSize(n))
        val stepR = cos(-2.0 * Math.PI * off / rate).toFloat(); val stepI = sin(-2.0 * Math.PI * off / rate).toFloat()
        for (i in 0 until n) {
            val iv = (iq[2 * i].toInt() and 0xff) - 127.4f; val qv = (iq[2 * i + 1].toInt() and 0xff) - 127.4f
            mixBuf[2 * i] = iv * ncoR - qv * ncoI; mixBuf[2 * i + 1] = iv * ncoI + qv * ncoR
            val nr = ncoR * stepR - ncoI * stepI; ncoI = ncoR * stepI + ncoI * stepR; ncoR = nr
            if (++ncoN >= 4096) { ncoN = 0; val g = 1f / sqrt(ncoR * ncoR + ncoI * ncoI); ncoR *= g; ncoI *= g }
        }
        val m = dec.process(mixBuf, n, chBuf)
        if (chRate != fmRate) configure(chRate)
        val twoPi = 2.0 * Math.PI
        for (j in 0 until m) {
            val ci = chBuf[2 * j]; val cq = chBuf[2 * j + 1]
            // wide: find the packet and its carrier
            wide.push(ci, cq); val wi = wide.i; val wq = wide.q
            val dw = kotlin.math.atan2(wq * pwI - wi * pwQ, wi * pwI + wq * pwQ); pwI = wi; pwQ = wq
            carrierBlock(dw.toDouble())
            // narrow: on the packet's carrier
            val c = cos(-afcPh).toFloat(); val sn = sin(-afcPh).toFloat()
            afcPh += twoPi * afcHz / chRate; if (afcPh > twoPi) afcPh -= twoPi else if (afcPh < 0) afcPh += twoPi
            narrow.push(ci * c - cq * sn, ci * sn + cq * c); val ni = narrow.i; val nq = narrow.q
            val dn = kotlin.math.atan2(nq * pnI - ni * pnQ, ni * pnI + nq * pnQ); pnI = ni; pnQ = nq
            step(dn)
        }
    }

    private fun carrierBlock(v: Double) {
        blkN++; blkSum += v; blkSq += v * v
        if (blkN < chRate / 100) return
        val mean = blkSum / blkN; val rms = sqrt(blkSq / blkN)
        blkN = 0; blkSum = 0.0; blkSq = 0.0
        noiseRms = if (noiseRms == 0.0) rms else noiseRms + 0.01 * (rms - noiseRms)
        if (rms < 0.82 * noiseRms) {
            runN++; runSum += mean; runSq += mean * mean
            if (runN >= 4) {
                val mu = runSum / runN; val sd = sqrt(maxOf(0.0, runSq / runN - mu * mu))
                val hz = mu * chRate / (2 * Math.PI)
                if (sd * chRate / (2 * Math.PI) < 1200 && kotlin.math.abs(hz) < 7_000) afcHz = hz
            }
        } else { runN = 0; runSum = 0.0; runSq = 0.0 }
    }

    fun clear() { synchronized(stations) { stations.clear() }; _stations.value = emptyList() }

    private fun configure(rate: Int) {
        fmRate = rate
        spb = (rate / 1200.0).roundToInt().coerceAtLeast(4)
        ring = FloatArray(spb); ri = 0
        w1 = 2.0 * Math.PI * 1200.0 / rate; w2 = 2.0 * Math.PI * 2200.0 / rate
        ph1 = 0.0; ph2 = 0.0; c1 = 0.0; s1 = 0.0; c2 = 0.0; s2 = 0.0; sinceRecompute = 0
        syncs = GAINS.map { _ -> BitSync(1200.0, rate.toDouble(), gain = 0.15) }
        filt = DiscFilter(3200.0, rate.toDouble())
        for (f in framers) f.reset()
        recent.clear()
    }

    override fun onFm(samples: FloatArray, n: Int, rate: Int) {
        if (rate != fmRate) configure(rate)
        for (i in 0 until n) step(samples[i])
    }

    /** One discriminator sample (radians/sample) through the tone correlators, the slicers and the deframers. */
    private fun step(v: Float) {
        val twoPi = 2.0 * Math.PI
        run {
            val x = filt.push(v.toDouble()).toFloat()
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
            clock++
            val mark = sqrt(c1 * c1 + s1 * s1).toFloat(); val space = sqrt(c2 * c2 + s2 * s2).toFloat()
            for (k in syncs.indices) {
                val b = syncs[k].push(mark - GAINS[k] * space)   // mark (1200) positive
                if (b >= 0) framers[k].pushRaw(b)
            }
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

    private fun onSliced(f: ByteArray) {
        if (f.size < 18 || !HdlcFramer.fcsOk(f)) return
        val fcs = (((f[f.size - 2].toInt() and 0xff) shl 8) or (f[f.size - 1].toInt() and 0xff)).toLong()
        val window = fmRate.toLong() * 2
        recent.removeAll { clock - it[1] > window }
        if (recent.any { it[0] == fcs }) return
        recent.add(longArrayOf(fcs, clock))
        onFrame(f)
    }

    private fun onFrame(f: ByteArray) {
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

/** 4th-order Butterworth low-pass on a complex (I/Q) stream; [i], [q] hold the last output. */
class CplxLowpass(cutHz: Double, rate: Double) {
    private val b0 = FloatArray(2); private val b1 = FloatArray(2); private val b2 = FloatArray(2)
    private val a1 = FloatArray(2); private val a2 = FloatArray(2)
    private val zi = FloatArray(4); private val zq = FloatArray(4)
    var i = 0f; private set
    var q = 0f; private set
    init {
        val w0 = 2 * Math.PI * minOf(0.45 * rate, cutHz) / rate; val c = cos(w0)
        for ((k, qq) in doubleArrayOf(0.5412, 1.3066).withIndex()) {
            val alpha = sin(w0) / (2 * qq); val a0 = 1 + alpha
            b0[k] = ((1 - c) / 2 / a0).toFloat(); b1[k] = ((1 - c) / a0).toFloat(); b2[k] = ((1 - c) / 2 / a0).toFloat()
            a1[k] = (-2 * c / a0).toFloat(); a2[k] = ((1 - alpha) / a0).toFloat()
        }
    }
    fun push(xi: Float, xq: Float) {
        var x = xi; var y = xq
        for (k in 0 until 2) {
            val oi = b0[k] * x + zi[2 * k]; zi[2 * k] = b1[k] * x - a1[k] * oi + zi[2 * k + 1]; zi[2 * k + 1] = b2[k] * x - a2[k] * oi
            val oq = b0[k] * y + zq[2 * k]; zq[2 * k] = b1[k] * y - a1[k] * oq + zq[2 * k + 1]; zq[2 * k + 1] = b2[k] * y - a2[k] * oq
            x = oi; y = oq
        }
        i = x; q = y
    }
}
