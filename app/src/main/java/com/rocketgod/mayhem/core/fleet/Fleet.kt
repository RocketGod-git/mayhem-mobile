package com.rocketgod.mayhem.core.fleet

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.ham.RealFir
import com.rocketgod.mayhem.core.ham.lowpassTaps
import com.rocketgod.mayhem.core.trains.Ddc
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Fleet: a receive-only monitor for P25 and DMR trunked radio. Finds every carrier in the span, gives the live ones a
 * channel each (the control channels keep theirs, the rest take turns), decodes the control signaling and builds the
 * systems, sites, channel tables, grants, registrations and unit positions from what is on the air. Labels are only
 * what the air carries. Publishes a snapshot (at most two a second) and log lines.
 */
const val CH_RATE = 24_000.0
private const val CUT_HZ = 5_500.0
private const val AUDITION_MS = 3_000L
private const val LIVE_MS = 4_000L

data class CarrierRow(
    val key: Long, val hz: Long, val levelDb: Double, val peakDb: Double, val firstMs: Long, val lastMs: Long, val onMs: Long, val heardMs: Long,
    val cls: String, val role: String, val sys: String, val nac: Int, val cc: Int, val frames: Int, val blocks: Int, val crcOk: Int,
    val lastDecodeMs: Long, val envCv: Double, val eye: Double, val decoding: Boolean, val callsign: String, val tdma: Boolean, val lcn: String,
)
data class Neighbor(val label: String, val hz: Long, val ch: String, val sys: Int, val heard: Boolean)
data class Lcn(val lcn: Int, val hz: Long, val slot: Int)
data class SiteRow(
    val key: String, val label: String, val rfss: Int, val site: Int, val nac: Int, val ccHz: List<Long>, val lastMs: Long, val levelDb: Double,
    val neighbors: List<Neighbor>, val secondary: List<Pair<Long, String>>, val time: String, val callsign: String, val carriers: List<Long>,
    val lcns: List<Lcn>, val rest: Int, val busy: List<Int>, val idens: List<Iden>, val units: Int, val lra: Int, val cls: Int,
)
data class SystemRow(
    val key: String, val proto: String, val color: Int, val label: String, val wacn: Int, val sysId: Int, val cc: Int, val fid: Int,
    val net: Int, val model: String, val callsign: String, val firstMs: Long, val lastMs: Long, val sites: List<SiteRow>, val idens: List<Iden>,
    val grants: Int, val units: Int, val tgs: Int, val derived: Boolean,
)
data class UnitReport(val ms: Long, val hz: Long, val kind: String, val hex: String, val verified: Boolean, val lat: Double?, val lon: Double?, val text: String)
data class TrailPt(val lat: Double, val lon: Double, val ms: Long)
data class UnitRow(
    val key: String, val sys: String, val id: Int, val firstMs: Long, val lastMs: Long, val lat: Double?, val lon: Double?, val posMs: Long,
    val posVerified: Boolean, val trail: List<TrailPt>, val groups: List<Int>, val grants: Int, val carriers: List<Long>, val reports: List<UnitReport>, val site: String,
)
data class GrantRow(
    val ms: Long, var lastMs: Long, val sys: String, val kind: String, val tg: Int, val group: Boolean, var src: Int, val ch: String, val hz: Long, val slot: Int,
    val tdma: Boolean, val emergency: Boolean, val encrypted: Boolean, val carrierHz: Long, val site: String,
)
data class TgRow(val key: String, val sys: String, val tg: Int, val firstMs: Long, val lastMs: Long, val grants: Int, val recent: List<Long>, val members: List<Int>, val history: List<GrantRow>)
data class LogRow(val ms: Long, val hz: Long, val proto: String, val name: String, val text: String, val hex: String, val ok: Boolean)
data class FleetSnap(
    val centerHz: Long, val rate: Int, val spanLo: Double, val spanHi: Double, val carriers: List<CarrierRow>, val systems: List<SystemRow>,
    val units: List<UnitRow>, val tgs: List<TgRow>, val grants: List<GrantRow>, val perMin: Int, val blocks: Int, val slots: Int, val ref: Boolean,
)
data class UnitDetail(val key: String, val reports: List<UnitReport>, val trail: List<TrailPt>)

private class Carrier(val key: Long, val hz: Long, now: Long) {
    var levelDb = 0.0; var peakDb = 0.0; val firstMs = now; var lastMs = now; var onMs = 0L; var heardMs = 0L
    var cls = ""; var role = ""; var sys = ""; var nac = -1; var cc = -1; var frames = 0; var blocks = 0; var crcOk = 0; var lastDecodeMs = 0L
    var envCv = 0.0; var eye = 0.0; var decoding = false; var callsign = ""; var tdma = false; var lcn = ""
    var hdrMs = -1L; var hdrSlot = 0; var lastAuditionMs = 0L
    var p25Sys = -1; var p25Wacn = -1; var p25Rfss = -1; var p25Site = -1
    var dmrSys = ""; val tables = LinkedHashMap<Int, Iden>(); val unitIds = LinkedHashMap<Int, Long>()
    fun row() = CarrierRow(key, hz, levelDb, peakDb, firstMs, lastMs, onMs, heardMs, cls, role, sys, nac, cc, frames, blocks, crcOk, lastDecodeMs, envCv, eye,
        decoding, callsign, tdma, lcn)
}
private class NeighborAt(val sys: Int, val rfss: Int, val site: Int, val ch: Int)
private class Site(val key: String, val sys: String, val rfss: Int, val site: Int, var nac: Int, var lastMs: Long) {
    val carriers = LinkedHashSet<Long>(); val neighbors = LinkedHashMap<String, NeighborAt>(); val secondary = LinkedHashSet<Int>()
    var time = ""; var lra = -1; var cls = -1; val idens = LinkedHashMap<Int, Iden>()
}
private class Sys(val key: String, val proto: String, val color: Int, val wacn: Int, val sysId: Int, var cc: Int, val fid: Int, val net: Int, val model: String,
                  val firstMs: Long, var lastMs: Long, var derived: Boolean) {
    val idens = LinkedHashMap<Int, Iden>()
    val lcns = LinkedHashMap<Int, Pair<Long, Int>>(); val lcnVotes = LinkedHashMap<String, LinkedHashMap<Int, Int>>(); var rest = -1; var busy: List<Int> = emptyList()
}
private class Report(val ms: Long, val hz: Long, val kind: String, val hex: String, val verified: Boolean, val text: String) {
    var lat: Double? = null; var lon: Double? = null; var lonLo: Int? = null; var latLo: Int? = null
    fun row() = UnitReport(ms, hz, kind, hex, verified, lat, lon, text)
}
private class UnitRec(val key: String, val sys: String, val id: Int, val firstMs: Long, var lastMs: Long) {
    var lonLo = -1; var latLo = -1; var posMs = 0L; var posVerified = false; val trail = ArrayList<TrailPt>(); val groups = LinkedHashSet<Int>(); var grants = 0
    val carriers = LinkedHashSet<Long>(); val reports = ArrayList<Report>()
}
private class Tg(val key: String, val sys: String, val tg: Int, val firstMs: Long, var lastMs: Long) {
    var grants = 0; var recent = ArrayList<Long>(); val members = LinkedHashSet<Int>(); val history = ArrayList<GrantRow>()
}

/** Channels a span can run at once: the down-converters cost in proportion to the sample rate. */
fun channelBudget(rate: Int): Int = max(4, min(24, floor(110e6 / max(rate, 1)).toInt()))
private fun gridKey(hz: Double): Long = Math.round(hz / 6250) * 6250
private fun round6(x: Double): Double = Math.round(x * 1e6) / 1e6

/** [baseband]: samples arrive already mixed to 0 Hz at that rate (a recorded channel clip), no down-converter. */
private class Chan(val key: Long, var hz: Double, center: Long, rate: Int, now: Long, baseband: Double = 0.0) {
    val ddc = Ddc(CUT_HZ, CH_RATE, 127)
    val rx: SymbolRx
    val p25 = P25Framer()
    val dmr = DmrFramer()
    val cw: CwReader
    var oi = FloatArray(0); var oq = FloatArray(0)
    val openedMs = now; var lastSyncMs = 0L; var quietSince = now
    init {
        ddc.reset(rate.toDouble()); ddc.offsetHz = hz - center
        val fs = if (baseband > 0) baseband else ddc.outRate
        rx = SymbolRx(fs)
        cw = CwReader(fs)
        rx.onSymbol = { s -> p25.push(s); dmr.push(s) }
    }
    fun retarget(center: Long) { ddc.offsetHz = hz - center }
    fun push(fi: FloatArray, fq: FloatArray, n: Int, now: Long) {
        val need = ddc.maxOut(n)
        if (oi.size < need) { oi = FloatArray(need); oq = FloatArray(need) }
        val m = ddc.push(fi, fq, n, oi, oq)
        channel(oi, oq, m, now)
    }
    fun channel(zi: FloatArray, zq: FloatArray, m: Int, now: Long) {
        val s0 = p25.syncs + dmr.syncs
        rx.push(zi, zq, m)
        if (p25.syncs + dmr.syncs != s0) { lastSyncMs = now; quietSince = now; cw.reset() }
        else if (now - lastSyncMs > 80) cw.push(zi, zq, m)
    }
}

class FleetProcessor(private val log: PacketLog?) : IqProcessor {
    @Volatile var centerHz = 0L
    /** Where the radio is tuned; read on every buffer when set. */
    var centerOf: (() -> Long)? = null
    var now: () -> Long = { System.currentTimeMillis() }
    /** The receiver's own position: resolves the derived DMR unit reports (low 16 bits of each coordinate). */
    var ref: Pair<Double, Double>? = null; private set
    private val carriers = LinkedHashMap<Long, Carrier>()
    private val systems = LinkedHashMap<String, Sys>()
    private val sites = LinkedHashMap<String, Site>()
    private val units = LinkedHashMap<String, UnitRec>()
    private val tgs = LinkedHashMap<String, Tg>()
    private var grants = ArrayList<GrantRow>()
    private val logRows = ArrayList<LogRow>()
    var blocks = 0; private set
    private val chans = LinkedHashMap<Long, Chan>()
    private var rate = 0; private var lastCenter = Long.MIN_VALUE
    private var fi = FloatArray(0); private var fq = FloatArray(0)
    private var nfft = 4096; private var re = FloatArray(0); private var im = FloatArray(0); private var win = FloatArray(0); private var acc = FloatArray(0); private var frames = 0
    private var lastFind = 0L; private var lastPost = 0L; private var pending = false; private var colorNext = 0
    private val logSeen = HashMap<String, Long>()
    private val vendor = VendorCheck()
    private val bbFir = HashMap<Long, Pair<RealFir, RealFir>>()
    private val _snap = MutableStateFlow<FleetSnap?>(null)
    val snap: StateFlow<FleetSnap?> = _snap.asStateFlow()

    @Synchronized override fun reset(rate: Int) {
        this.rate = rate
        nfft = 1 shl max(10, min(15, ceil(ln(rate / 1000.0) / ln(2.0)).toInt()))
        re = FloatArray(nfft); im = FloatArray(nfft); win = FloatArray(nfft) { (0.5 - 0.5 * cos(2 * PI * it / (nfft - 1))).toFloat() }; acc = FloatArray(nfft); frames = 0
        chans.clear(); centerOf?.let { centerHz = it() }; lastCenter = centerHz
        post(true)
    }

    @Synchronized override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (rate != this.rate) reset(rate)
        centerOf?.let { centerHz = it() }
        val now = now(); val c = centerHz
        if (c != lastCenter) {
            lastCenter = c; acc.fill(0f); frames = 0
            val it = chans.entries.iterator()
            while (it.hasNext()) { val e = it.next(); if (!inSpan(e.value.hz)) it.remove() else e.value.retarget(c) }
        }
        val n = len / 2
        if (fi.size < n) { fi = FloatArray(n); fq = FloatArray(n) }
        for (k in 0 until n) { fi[k] = (iq[2 * k].toInt() and 0xff) - 127.5f; fq[k] = (iq[2 * k + 1].toInt() and 0xff) - 127.5f }
        // the spectrum for finding carriers: a few transforms per buffer are plenty
        val nn = nfft; val step = max(nn, n / 4)
        var off = 0
        while (off + nn <= n && frames < 24) {
            for (k in 0 until nn) { re[k] = fi[off + k] * win[k]; im[k] = fq[off + k] * win[k] }
            Dsp.fft(re, im)
            for (k in 0 until nn) acc[k] += re[k] * re[k] + im[k] * im[k]
            frames++; off += step
        }
        for (ch in chans.values) ch.push(fi, fq, n, now)
        if (now - lastFind > 500 && frames >= 4) { lastFind = now; findCarriers(now); assign(now) }
        if (pending || now - lastPost > 1000) post()
    }

    private fun inSpan(hz: Double): Boolean = abs(hz - centerHz) < rate * 0.44 - 6_250
    private fun inSpan(hz: Long): Boolean = inSpan(hz.toDouble())
    val spanLo: Double get() = centerHz - rate * 0.44
    val spanHi: Double get() = centerHz + rate * 0.44

    /** Peaks of the 6 kHz channel power, at least 10 dB over the span's median, 6 kHz apart (a neighbor 12.5 kHz away
     *  stays its own carrier). */
    private fun findCarriers(now: Long) {
        val nn = nfft; val bin = rate.toDouble() / nn; val p = FloatArray(nn)
        for (k in 0 until nn) p[k] = acc[(k + nn / 2) % nn] / frames
        acc.fill(0f); frames = 0
        val w = max(1, (6_000 / bin).roundToInt()); val half = w shr 1; val s = FloatArray(nn); val pre = DoubleArray(nn + 1)
        for (k in 0 until nn) pre[k + 1] = pre[k] + p[k]
        for (k in 0 until nn) s[k] = (pre[min(nn, max(0, k - half + w))] - pre[max(0, k - half)]).toFloat()
        val lo = ceil(nn / 2 - rate * 0.44 / bin).toInt(); val hi = floor(nn / 2 + rate * 0.44 / bin).toInt()
        val vals = s.copyOfRange(lo, hi).also { it.sort() }
        val fl = vals.getOrNull(floor(vals.size * 0.4).toInt())?.toDouble()?.takeIf { it != 0.0 } ?: 1e-9
        val dc = ceil(4_000 / bin).toInt(); val seen = HashSet<Long>()
        for (k in lo + 1 until hi - 1) {
            val v = s[k]; if (v < fl * 10) continue
            var peak = true
            for (j in max(lo, k - w)..min(hi - 1, k + w)) if (s[j] > v || (s[j] == v && j < k)) { peak = false; break }
            if (!peak) continue
            val db = 10 * log10(v / fl)
            if (abs(k - nn / 2) < dc && db < 20) continue
            var sw = 0.0; var sp = 0.0; for (j in max(0, k - half)..min(nn - 1, k + half)) { sw += p[j]; sp += p[j].toDouble() * j }
            val hz = centerHz + (sp / sw - nn / 2) * bin; val key = gridKey(hz)
            seen.add(key)
            val fresh = !carriers.containsKey(key)
            val c = carrierAt(if (abs(hz - key) < 1_500) key.toDouble() else Math.round(hz / 100) * 100.0)
            if (fresh) { c.levelDb = db; c.peakDb = db }
            if (now - c.lastMs < 2_000) c.onMs += now - c.lastMs
            c.lastMs = now; c.levelDb = Math.round(db * 10) / 10.0; c.peakDb = max(c.peakDb, c.levelDb)
            chans[key]?.hz = hz
        }
        for (c in carriers.values) if (c.key !in seen && inSpan(c.hz) && now - c.lastMs > 1_000) chans[c.key]?.cw?.end()
        pending = true
    }

    /** Control channels keep their channel; every other live carrier gets a turn of a few seconds. */
    private fun assign(now: Long) {
        val budget = channelBudget(rate)
        val live = carriers.values.filter { inSpan(it.hz) && now - it.lastMs < LIVE_MS }
        val it = chans.entries.iterator()
        while (it.hasNext()) {
            val e = it.next(); val c = carriers[e.key]
            if (c == null || now - c.lastMs > LIVE_MS || !inSpan(c.hz)) { it.remove(); continue }
            classify(c, e.value, now)
        }
        fun keep(c: Carrier) = c.lastDecodeMs > 0 && now - c.lastDecodeMs < 10_000
        val want = ArrayList(live.filter { keep(it) }.sortedByDescending { it.levelDb })
        for ((k, ch) in chans) { val c = carriers[k]!!; if (!keep(c) && now - ch.openedMs < AUDITION_MS && c !in want) want.add(c) }
        val rest = live.filter { it !in want }.sortedWith(compareBy<Carrier> { it.lastAuditionMs }.thenByDescending { it.levelDb })
        for (c in rest) { if (want.size >= budget) break; want.add(c) }
        val chosen = want.take(budget).map { it.key }.toSet()
        chans.keys.retainAll(chosen)
        for (k in chosen) if (!chans.containsKey(k)) { val c = carriers[k]!!; c.lastAuditionMs = now; open(c, now) }
        for (c in carriers.values) c.decoding = chans.containsKey(c.key)
    }
    private fun open(c: Carrier, now: Long, given: Chan? = null) {
        val ch = given ?: Chan(c.key, c.hz.toDouble(), centerHz, rate, now)
        ch.p25.onBlock = { b -> p25Block(c, b) }
        ch.p25.onFrame = { nac, duid -> c.envCv = Math.round(ch.rx.envCv * 100) / 100.0; p25Frame(c, nac, duid) }
        ch.dmr.onBurst = { e -> dmrBurst(c, e) }
        ch.cw.onText = { t -> cwText(c, t) }
        chans[c.key] = ch
    }
    private fun classify(c: Carrier, ch: Chan, now: Long) {
        c.heardMs += 500; c.envCv = Math.round(ch.rx.envCv * 100) / 100.0; c.eye = Math.round(ch.rx.eye * 100) / 100.0
        if (c.lastDecodeMs > 0 && now - c.lastDecodeMs < 15_000) return
        if (now - ch.openedMs < 2_000) return
        c.cls = when {
            c.tdma && ch.rx.envCv > 0.15 -> "P25 PHASE 2 TDMA"
            ch.rx.eye > 1.3 && ch.rx.envCv < 0.15 -> "UNKNOWN 4FSK"
            ch.rx.envCv > 0.18 -> "UNKNOWN LINEAR"
            else -> "ANALOG FM"
        }
    }

    // ------------------------------------------------------------------------------------------------ P25
    private fun p25Frame(c: Carrier, nac: Int, duid: Int) {
        val now = now()
        c.frames++; c.nac = nac; c.lastDecodeMs = now
        c.cls = if (c.envCv > 0.2) "P25 CQPSK/LSM" else "P25 C4FM"
        if (duid == 7) c.role = "control"
        else if (duid == 0xc) { if (c.role != "control") c.role = "data" }
        else if (c.role != "control") c.role = "voice"
        if (duid != 7) pending = true
    }
    private fun p25Block(c: Carrier, b: P25Block) {
        val now = now()
        c.blocks++; blocks++
        if (!b.crcOk) return
        c.crcOk++
        val t = Tsbks.parse(b.bytes)
        val sys = p25Identity(c, t, now)
        p25Apply(c, t, sys, now)
        val extra = t.ch?.let { if (t.kind != "iden") " → ${chText(c, sys, it)}" else "" } ?: ""
        addLog(LogRow(now, c.hz, "P25", t.name, "NAC ${hx(b.nac, 3)} · ${Tsbks.line(t)}$extra", t.hex, true))
    }
    /** Which system and site a control channel belongs to, from its RFSS and network status. */
    private fun p25Identity(c: Carrier, t: Tsbk, now: Long): Sys? {
        if (t.kind == "rfss") { c.p25Sys = t.sys!!; c.p25Rfss = t.rfss!!; c.p25Site = t.site!! }
        if (t.kind == "net") { c.p25Wacn = t.wacn!!; c.p25Sys = t.sys!! }
        if (t.kind == "iden") t.iden?.let { c.tables[it.iden] = it }
        if (c.p25Wacn < 0 || c.p25Sys < 0) return null
        val key = "P25 ${hx(c.p25Wacn, 5)}.${hx(c.p25Sys, 3)}"
        val s = systems.getOrPut(key) { Sys(key, "P25", colorNext++, c.p25Wacn, c.p25Sys, -1, -1, -1, "", now, now, false) }
        s.lastMs = now; c.sys = key
        s.idens.putAll(c.tables)
        if (c.p25Rfss >= 0) {
            val sk = "$key/${c.p25Rfss}.${c.p25Site}"
            val site = sites.getOrPut(sk) { Site(sk, key, c.p25Rfss, c.p25Site, c.nac, now) }
            site.carriers.add(c.key); site.lastMs = now; site.nac = c.nac
            site.idens.putAll(c.tables)
        }
        return s
    }
    private fun siteOf(c: Carrier): Site? = if (c.sys.isNotEmpty() && c.p25Rfss >= 0) sites["${c.sys}/${c.p25Rfss}.${c.p25Site}"] else null
    private fun tablesFor(c: Carrier, s: Sys?): Map<Int, Iden> {
        if (s == null) return c.tables
        val m = LinkedHashMap(s.idens); m.putAll(c.tables); return m
    }
    private fun chText(c: Carrier, s: Sys?, ch: Int): String {
        val r = Tsbks.resolve(ch, tablesFor(c, s))
        return if (r != null) "%.5f MHz".format(java.util.Locale.US, r.hz / 1e6) + (if (r.tdma) " TDMA slot ${r.slot + 1}" else "") else "channel ${hx(ch, 4)} (no table yet)"
    }
    private fun p25Apply(c: Carrier, t: Tsbk, s: Sys?, now: Long) {
        val site = siteOf(c)
        if (s == null) return
        val tables = tablesFor(c, s)
        val siteLabel = if (site != null) "${site.rfss}.${site.site}" else ""
        when (t.kind) {
            "rfss", "net" -> if (site != null) { site.lra = t.lra ?: site.lra; site.cls = t.cls ?: site.cls }
            "adj" -> if (site != null && t.sys != null) site.neighbors["${t.sys}.${t.rfss}.${t.site}"] = NeighborAt(t.sys!!, t.rfss!!, t.site!!, t.ch!!)
            "sccb" -> if (site != null && t.ch != null) { site.secondary.add(t.ch!!); if (t.ch2 != null && t.ch2 != t.ch && t.op == 0x39) site.secondary.add(t.ch2!!) }
            "time" -> if (site != null && t.time != null) site.time = t.time!!
            "grant", "update", "u2u", "datagrant" -> {
                val svc = t.svc ?: 0
                fun add(ch: Int, tg: Int?, group: Boolean, src: Int) {
                    val r = Tsbks.resolve(ch, tables)
                    if (r != null) {
                        val vc = carriers[gridKey(r.hz.toDouble())]
                        if (vc != null) { if (vc.role != "control") vc.role = if (t.kind == "datagrant") "data" else "voice"; vc.tdma = r.tdma; if (vc.sys.isEmpty()) vc.sys = s.key }
                    }
                    grant(s.key, GrantRow(now, now, s.key, t.kind, tg ?: 0, group, src, hx(ch, 4), r?.hz ?: 0L, r?.slot ?: 0, r?.tdma ?: false,
                        Tsbks.emergency(svc), Tsbks.encrypted(svc), c.hz, siteLabel), t.kind == "update")
                }
                if (t.kind == "u2u") {
                    t.ch?.let { add(it, t.dst, false, t.src ?: 0) }
                    t.src?.let { if (it != 0) touchUnit(s.key, it, c, now, "u2u", t, siteLabel) }
                    t.dst?.let { if (it != 0) touchUnit(s.key, it, c, now, "u2u", t, siteLabel) }
                } else if (t.ch != null) {
                    add(t.ch!!, t.group ?: t.dst, t.group != null, t.src ?: 0)
                    if (t.ch2 != null && t.group2 != null) add(t.ch2!!, t.group2, true, 0)
                    t.src?.let { if (it != 0) touchUnit(s.key, it, c, now, t.kind, t, siteLabel, t.group) }
                    t.dst?.let { if (it != 0 && t.kind == "datagrant") touchUnit(s.key, it, c, now, t.kind, t, siteLabel) }
                }
            }
            "affil" -> t.dst?.let { d ->
                if (d != 0) {
                    val u = touchUnit(s.key, d, c, now, "affiliation", t, siteLabel)
                    t.group?.let { g -> if (g != 0) { u.groups.add(g); tgFor(s.key, g, now).members.add(d) } }
                }
            }
            "reg", "dereg", "unit" -> {
                val id = if (t.kind == "reg" && t.op == 0x2c) t.src else t.dst ?: t.src
                if (id != null && id != 0 && id < 0xfffff0) touchUnit(s.key, id, c, now, t.kind, t, siteLabel)
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ DMR
    private val DATA_TYPES = arrayOf("PI HEADER", "VOICE HEADER", "TERMINATOR", "CSBK", "MBC HEADER", "MBC CONTINUATION", "DATA HEADER", "RATE 1/2 DATA", "RATE 3/4 DATA", "IDLE", "RATE 1 DATA")
    private fun dmrBurst(c: Carrier, e: DmrEvent) {
        val now = now(); val b = e.burst
        if (b.dt > 10) return
        c.frames++; c.cc = b.cc; c.cls = "DMR"; c.lastDecodeMs = now
        if (b.dt == 1 || b.dt == 2) { if (c.role != "control" && c.role != "rest") c.role = "voice"; pending = true; return }
        if (b.dt == 9) return
        c.blocks++; blocks++
        val mask = Codes.DMR_CRC_MASK[b.dt]
        val ok = mask != null && Codes.crc12Ok(b.bytes, mask)
        if (ok) c.crcOk++
        if (b.dt == 3) {
            val op = b.bytes[0] and 0x3f
            val isVendor = !ok && b.bytes[1] == 0x10 && (op == 0x09 || op == 0x3d)
            val vok = isVendor && vendor.check(b.bytes, "${b.cc}")
            if (vok) c.crcOk++
            val cs = Csbks.parse(b.bytes, ok || vok)
            // the unit-report families are kept when their check fails (shown unverified); anything else has to pass its CRC
            if (!ok && !vok && !(cs.derived && (cs.kind == "unitrpt" || cs.kind == "unithdr" || cs.kind == "callann"))) return
            if (c.role == "" || c.role == "voice") c.role = "control"
            val s = dmrSystem(c, cs, b.cc, now)
            dmrApply(c, cs, b.slot, s, now)
            addLog(LogRow(now, c.hz, "DMR", cs.name, "CC ${b.cc} · TS${b.slot + 1} · ${Csbks.line(cs)}", cs.hex, ok || vok))
        } else if (ok || b.dt == 7) {
            if (b.dt == 6 || b.dt == 7) { if (c.role == "") c.role = "data" }
            val name = DATA_TYPES[b.dt]
            val hex = Codes.hex(b.bytes)
            addLog(LogRow(now, c.hz, "DMR", name, "CC ${b.cc} · TS${b.slot + 1} · $name${if (ok) "" else " · no block CRC"} · $hex", hex, ok))
        }
    }
    private fun dmrSystem(c: Carrier, cs: Csbk, cc: Int, now: Long): Sys {
        var key = c.dmrSys
        if (cs.verified && cs.sysCode != null) key = "DMR ${cs.model} ${cs.net}"
        else if (key.isEmpty()) key = "DMR CC$cc FID ${hx(cs.fid, 2)}"
        c.dmrSys = key; c.sys = key
        val s = systems.getOrPut(key) { Sys(key, "DMR", colorNext++, -1, -1, cc, cs.fid, cs.net ?: -1, cs.model ?: "", now, now, cs.derived) }
        s.lastMs = now; s.cc = cc; if (cs.derived) s.derived = true
        return s
    }
    private fun dmrApply(c: Carrier, cs: Csbk, slot: Int, s: Sys, now: Long) {
        when (cs.kind) {
            "beacon" -> {
                s.rest = cs.rest ?: -1; s.busy = cs.busy ?: emptyList()
                // a unit exchange on this carrier just now and one logical channel busy: that channel is this carrier's slot
                if (s.busy.size == 1 && c.hdrMs >= 0 && now - c.hdrMs < 1_000) lcnVote(s, s.busy[0], c.hz, c.hdrSlot)
                c.lcn = s.lcns.filter { it.value.first == c.hz }.keys.joinToString("/")
                for (k in carriers.values) if (k.sys == s.key) {
                    val mine = s.lcns.filter { it.value.first == k.hz }.keys
                    k.role = if (s.rest in mine) "rest" else if (k.role == "rest") "control" else k.role
                }
                cs.unit?.let { touchUnit(s.key, it, c, now, "busy channel", cs, "") }
            }
            "unithdr" -> cs.unit?.let { c.hdrMs = now; c.hdrSlot = slot; touchUnit(s.key, it, c, now, "unit report header", cs, "") }
            "unitrpt" -> if (cs.unit != null) unitReport(s, c, cs, now)
            "grant" -> {
                val dst = cs.dst ?: return
                grant(s.key, GrantRow(now, now, s.key, if (cs.group == true) "grant" else "u2u", dst, cs.group == true, cs.src ?: 0, "LPCN ${cs.lpcn}", 0L, cs.slot ?: 0,
                    true, cs.emergency == true, false, c.hz, ""), false)
                cs.src?.let { if (it != 0) touchUnit(s.key, it, c, now, "grant", cs, "", if (cs.group == true) dst else null) }
            }
            "ack", "unit", "aloha", "callann" -> {
                val id = if (cs.kind == "callann") cs.unit else cs.dst
                if (id != null && id != 0 && id < 0xfffff0) touchUnit(s.key, id, c, now, if (cs.kind == "ack") "acknowledged" else cs.name.lowercase(), cs, "")
            }
        }
    }
    /** Votes per carrier slot for the logical channel it is; each slot takes the one it got at least two thirds of. */
    private fun lcnVote(s: Sys, lcn: Int, hz: Long, slot: Int) {
        val k = "$hz:$slot"; val v = s.lcnVotes.getOrPut(k) { LinkedHashMap() }
        v[lcn] = (v[lcn] ?: 0) + 1
        var best = -1; var n = 0; var all = 0
        for ((l, c) in v) { all += c; if (c > n) { n = c; best = l } }
        if (n >= 3 && n * 3 >= all * 2) {
            s.lcns.entries.removeIf { it.value.first == hz && it.value.second == slot && it.key != best }
            s.lcns[best] = hz to slot
        }
    }
    private fun unitReport(s: Sys, c: Carrier, cs: Csbk, now: Long) {
        val u = touchUnit(s.key, cs.unit!!, c, now, "unit report", cs, "")
        c.unitIds[cs.unit!!] = now
        val lonLo = cs.lonLo; val latLo = cs.latLo
        if (cs.noFix || lonLo == null || latLo == null) return
        u.lonLo = lonLo; u.latLo = latLo; u.posMs = now; u.posVerified = cs.verified
        val last = u.reports.lastOrNull()
        if (last != null) { last.lonLo = lonLo; last.latLo = latLo }
        val r = ref ?: return
        val lat = round6(Csbks.unwrap16(latLo, r.first)); val lon = round6(Csbks.unwrap16(lonLo, r.second))
        if (last != null) { last.lat = lat; last.lon = lon }
        val tr = u.trail.lastOrNull()
        if (tr == null || tr.lat != lat || tr.lon != lon) { u.trail.add(TrailPt(lat, lon, now)); if (u.trail.size > 30) u.trail.removeAt(0) }
    }
    private fun cwText(c: Carrier, text: String) {
        val word = text.split(' ').firstOrNull { looksLikeCallsign(it) }
        addLog(LogRow(now(), c.hz, "CW", "CW ID", "CW ID · $text", "", word != null))
        if (word != null) { c.callsign = word; pending = true }
    }

    // ------------------------------------------------------------------------------------------------ tables
    private fun touchUnit(sys: String, id: Int, c: Carrier, now: Long, kind: String, msg: Any, site: String, group: Int? = null): UnitRec {
        val key = "$sys/$id"
        val u = units.getOrPut(key) { UnitRec(key, sys, id, now, now) }
        u.lastMs = now; u.carriers.add(c.key)
        if (group != null) { u.groups.add(group); tgFor(sys, group, now).members.add(id) }
        if (kind == "grant" || kind == "u2u" || kind == "datagrant") u.grants++
        val cs = msg as? Csbk; val ts = msg as? Tsbk
        val text = if (cs != null) Csbks.line(cs) else Tsbks.line(ts!!)
        u.reports.add(Report(now, c.hz, kind + if (site.isNotEmpty()) " · site $site" else "", cs?.hex ?: ts!!.hex, cs?.verified ?: true, text))
        if (u.reports.size > 60) u.reports.removeAt(0)
        pending = true
        return u
    }
    private fun tgFor(sys: String, tg: Int, now: Long): Tg { val key = "$sys/$tg"; return tgs.getOrPut(key) { Tg(key, sys, tg, now, now) } }
    /** A grant, or an update of one already on the feed (the same talkgroup on the same channel within 5 s). */
    private fun grant(sys: String, g: GrantRow, update: Boolean) {
        val same = grants.firstOrNull { it.sys == sys && it.tg == g.tg && it.ch == g.ch && it.group == g.group && g.ms - it.lastMs < 5_000 }
        if (same != null) { same.lastMs = g.ms; if (g.src != 0 && same.src == 0) same.src = g.src; pending = true; return }
        if (update && g.tg == 0) return
        grants.add(0, g); if (grants.size > 300) grants.subList(300, grants.size).clear()
        if (g.group) {
            val t = tgFor(sys, g.tg, g.ms)
            t.lastMs = g.ms; t.grants++; t.recent.add(g.ms); t.recent = ArrayList(t.recent.filter { g.ms - it < 600_000 })
            t.history.add(0, g); if (t.history.size > 60) t.history.subList(60, t.history.size).clear()
            if (g.src != 0) t.members.add(g.src)
        }
        pending = true
    }
    private fun addLog(r: LogRow) {
        logRows.add(r); if (logRows.size > 20_000) logRows.subList(0, 5_000).clear()
        val k = "${r.hz}|${r.hex.ifEmpty { r.text }}"; val last = logSeen[k]
        logSeen[k] = r.ms
        if (logSeen.size > 4000) logSeen.entries.removeIf { r.ms - it.value > 30_000 }
        if (last != null && r.ms - last < 30_000) return
        val t = CLOCK.get()!!.format(java.util.Date(r.ms))
        log?.add("$t ${r.proto} ${"%.5f".format(java.util.Locale.US, r.hz / 1e6)} ${r.text}${if (r.hex.isNotEmpty() && !r.text.contains(r.hex)) " · ${r.hex}" else ""}")
    }

    // ------------------------------------------------------------------------------------------------ output
    private fun resolvePos(u: UnitRec): Pair<Double?, Double?> {
        val r = ref
        if (r == null || u.lonLo < 0) return null to null
        return round6(Csbks.unwrap16(u.latLo, r.first)) to round6(Csbks.unwrap16(u.lonLo, r.second))
    }
    /** The receiver's position arrived or moved: every stored report is resolved against it again. */
    @Synchronized fun setRef(lat: Double, lon: Double) {
        ref = lat to lon
        for (u in units.values) {
            if (u.lonLo < 0) continue
            for (r in u.reports) { val a = r.latLo; val o = r.lonLo; if (a != null && o != null) { r.lat = round6(Csbks.unwrap16(a, lat)); r.lon = round6(Csbks.unwrap16(o, lon)) } }
            val (la, lo) = resolvePos(u)
            if (la != null && lo != null && u.trail.isEmpty()) u.trail.add(TrailPt(la, lo, u.posMs))
        }
        post(true)
    }
    private fun dmrSites(s: Sys): List<SiteRow> {
        val cs = carriers.values.filter { it.sys == s.key }
        val parent = HashMap<Long, Long>(); for (c in cs) parent[c.key] = c.key
        fun find(k: Long): Long { var r = k; while (parent[r] != r) r = parent[r]!!; return r }
        val owner = HashMap<Int, Long>()
        for (c in cs) for (id in c.unitIds.keys) { val o = owner[id]; if (o == null) owner[id] = c.key else parent[find(c.key)] = find(o) }
        for (a in cs) for (b in cs) if (a.callsign.isNotEmpty() && a.callsign == b.callsign) parent[find(a.key)] = find(b.key)
        val groups = LinkedHashMap<Long, ArrayList<Carrier>>()
        for (c in cs) groups.getOrPut(find(c.key)) { ArrayList() }.add(c)
        var n = 0
        return groups.values.sortedBy { g -> g.minOf { it.firstMs } }.map { g ->
            n++
            val call = g.firstOrNull { it.callsign.isNotEmpty() }?.callsign ?: ""; val keys = g.map { it.key }.toSet()
            val lcns = s.lcns.filter { (_, v) -> gridKey(v.first.toDouble()) in keys || g.any { it.hz == v.first } }.map { (l, v) -> Lcn(l, v.first, v.second) }.sortedBy { it.lcn }
            val ids = HashSet<Int>(); for (c in g) ids.addAll(c.unitIds.keys)
            SiteRow("${s.key}/$n", call.ifEmpty { if (s.net >= 0) "site ${s.net}" else "site $n" }, -1, n, -1, g.map { it.hz }.sorted(), g.maxOf { it.lastMs }, g.maxOf { it.levelDb },
                emptyList(), emptyList(), "", call, g.map { it.key }, lcns, s.rest, s.busy, emptyList(), ids.size, -1, -1)
        }
    }
    private fun buildSnapshot(): FleetSnap {
        val now = now()
        val unitSite = HashMap<String, String>()
        val sysRows = systems.values.map { s ->
            val siteRows: List<SiteRow> = if (s.proto == "P25") {
                sites.values.filter { it.sys == s.key }.map { x ->
                    val tables = LinkedHashMap(s.idens); tables.putAll(x.idens)
                    val ccs = x.carriers.mapNotNull { carriers[it] }
                    SiteRow(x.key, "${x.rfss}.${x.site}", x.rfss, x.site, x.nac, ccs.map { it.hz }, x.lastMs, ccs.maxOfOrNull { it.levelDb } ?: Double.NEGATIVE_INFINITY,
                        x.neighbors.values.map { nb -> val r = Tsbks.resolve(nb.ch, tables); Neighbor("${nb.rfss}.${nb.site}", r?.hz ?: 0L, hx(nb.ch, 4), nb.sys,
                            sites.values.any { o -> o.sys == s.key && o.rfss == nb.rfss && o.site == nb.site }) }.sortedBy { it.hz },
                        x.secondary.map { ch -> (Tsbks.resolve(ch, tables)?.hz ?: 0L) to hx(ch, 4) }, x.time, ccs.firstOrNull { it.callsign.isNotEmpty() }?.callsign ?: "",
                        x.carriers.toList(), emptyList(), -1, emptyList(), tables.values.sortedBy { it.iden }, 0, x.lra, x.cls)
                }
            } else dmrSites(s)
            for (st in siteRows) for (k in st.carriers) for (u in units.values) if (u.sys == s.key && k in u.carriers) unitSite[u.key] = st.label
            val label = if (s.proto == "P25") "WACN ${hx(s.wacn, 5)} · SYSTEM ${hx(s.sysId, 3)}" else if (s.net >= 0) "${s.model} NETWORK ${s.net}" else "COLOR CODE ${s.cc}${if (s.fid > 0) " · FID ${hx(s.fid, 2)}" else ""}"
            SystemRow(s.key, s.proto, s.color, label, s.wacn, s.sysId, s.cc, s.fid, s.net, s.model, siteRows.firstOrNull { it.callsign.isNotEmpty() }?.callsign ?: "",
                s.firstMs, s.lastMs, siteRows, s.idens.values.sortedBy { it.iden }, grants.count { it.sys == s.key }, units.values.count { it.sys == s.key },
                tgs.values.count { it.sys == s.key }, s.derived)
        }.sortedBy { it.firstMs }
        val unitRows = units.values.map { u ->
            val (lat, lon) = resolvePos(u)
            UnitRow(u.key, u.sys, u.id, u.firstMs, u.lastMs, lat, lon, u.posMs, u.posVerified, u.trail.takeLast(12), u.groups.toList(), u.grants, u.carriers.toList(),
                u.reports.takeLast(6).map { it.row() }, unitSite[u.key] ?: "")
        }
        val tgRows = tgs.values.map { t -> TgRow(t.key, t.sys, t.tg, t.firstMs, t.lastMs, t.grants, t.recent.filter { now - it < 600_000 }, t.members.take(200), t.history.take(12).map { it.copy() }) }
        val carrierRows = carriers.values.map { it.row() }.sortedBy { it.hz }
        return FleetSnap(centerHz, rate, spanLo, spanHi, carrierRows, sysRows, unitRows, tgRows, grants.take(120).map { it.copy() },
            grants.count { now - it.ms < 60_000 }, blocks, chans.size, ref != null)
    }
    @Synchronized fun snapshot(): FleetSnap = buildSnapshot()
    /** A carrier at [hz] as if found in the span (recorded blocks are replayed through it). */
    private fun carrierAt(hz: Double): Carrier {
        val key = gridKey(hz)
        return carriers.getOrPut(key) { Carrier(key, Math.round(hz), now()) }
    }
    /** One recorded P25 trunking block (12 bytes, CRC included) heard on [hz]. */
    @Synchronized fun feedP25(hz: Long, nac: Int, bytes: IntArray) {
        val c = carrierAt(hz.toDouble())
        p25Frame(c, nac, 7)
        p25Block(c, P25Block(nac, 0, bytes, Codes.crc12Ok(bytes), 0, 0))
    }
    /** One recorded DMR burst's contents heard on [hz]. */
    @Synchronized fun feedDmr(hz: Long, slot: Int, cc: Int, dt: Int, bytes: IntArray) {
        dmrBurst(carrierAt(hz.toDouble()), DmrEvent(Codes.DmrBurst(slot, cc, dt, 0, bytes, 1), IntArray(0)))
    }
    /** A recorded channel clip, complex baseband at [fs] mixed to 0 Hz from [hz]: decoded as a channel of the span. */
    @Synchronized fun feedBaseband(hz: Long, fs: Double, zi: FloatArray, zq: FloatArray, n: Int) {
        val c = carrierAt(hz.toDouble()); val now = now()
        var ch = chans[c.key]
        if (ch == null) { ch = Chan(c.key, hz.toDouble(), hz, (fs * 4).roundToInt(), now, fs); open(c, now, ch) }
        c.lastMs = now; c.decoding = true
        // the same channel filter the down-converter applies: a neighbor 12.5 kHz away is inside a 48 kS/s clip
        val f = bbFir.getOrPut(c.key) { val t = lowpassTaps(CUT_HZ / fs, 127); RealFir(t) to RealFir(t) }
        val fi = FloatArray(n); val fq = FloatArray(n)
        f.first.process(zi, n, fi); f.second.process(zq, n, fq)
        ch.channel(fi, fq, n, now)
    }
    /** The end of a recording: the samples still waiting for a whole timing block are decoded too. */
    @Synchronized fun flush() { for (ch in chans.values) ch.rx.flush() }
    /** A CW ID read on [hz]. */
    @Synchronized fun feedCw(hz: Long, text: String) { cwText(carrierAt(hz.toDouble()), text) }
    /** Everything held about one unit, for its detail view. */
    @Synchronized fun unitDetail(key: String): UnitDetail? {
        val u = units[key] ?: return null
        return UnitDetail(key, u.reports.map { it.row() }, u.trail.toList())
    }
    /** The block log as CSV, and the tables as JSON. */
    @Synchronized fun exportAll(): Pair<String, String> {
        fun q(v: String) = "\"${v.replace("\"", "\"\"")}\""
        val iso = ISO.get()!!
        val csv = StringBuilder("utc,mhz,protocol,type,crc_ok,fields,hex\n")
        for (r in logRows) csv.append(iso.format(java.util.Date(r.ms))).append(',').append("%.5f".format(java.util.Locale.US, r.hz / 1e6)).append(',').append(r.proto).append(',')
            .append(q(r.name)).append(',').append(if (r.ok) 1 else 0).append(',').append(q(r.text)).append(',').append(r.hex).append('\n')
        val s = buildSnapshot()
        val o = JSONObject()
        o.put("exported", iso.format(java.util.Date(now())))
        o.put("systems", JSONArray(s.systems.map { sysJson(it) }))
        o.put("carriers", JSONArray(s.carriers.map { carrierJson(it) }))
        o.put("talkgroups", JSONArray(s.tgs.map { t -> JSONObject().put("key", t.key).put("sys", t.sys).put("tg", t.tg).put("firstMs", t.firstMs).put("lastMs", t.lastMs)
            .put("grants", t.grants).put("recent", JSONArray(t.recent)).put("members", JSONArray(t.members)).put("history", JSONArray(t.history.map { grantJson(it) })) }))
        o.put("grants", JSONArray(grants.map { grantJson(it) }))
        o.put("units", JSONArray(units.values.map { u ->
            val (la, lo) = resolvePos(u)
            JSONObject().put("sys", u.sys).put("id", u.id).put("first", iso.format(java.util.Date(u.firstMs))).put("last", iso.format(java.util.Date(u.lastMs)))
                .put("groups", JSONArray(u.groups.toList())).put("position", JSONArray(listOf(la ?: JSONObject.NULL, lo ?: JSONObject.NULL))).put("positionVerified", u.posVerified)
                .put("trail", JSONArray(u.trail.map { JSONArray(listOf(it.lat, it.lon, it.ms)) }))
                .put("reports", JSONArray(u.reports.map { r -> reportJson(r.row()).also { j -> r.lonLo?.let { j.put("lonLo", it) }; r.latLo?.let { j.put("latLo", it) } } }))
        }))
        return csv.toString() to o.toString(1)
    }
    private fun idenJson(i: Iden) = JSONObject().put("iden", i.iden).put("base", i.base).put("spacing", i.spacing).put("txOffset", i.txOffset).put("bw", i.bw).put("tdma", i.tdma)
        .put("slots", i.slots).put("form", i.form).put("raw", i.raw)
    private fun grantJson(g: GrantRow) = JSONObject().put("ms", g.ms).put("lastMs", g.lastMs).put("sys", g.sys).put("kind", g.kind).put("tg", g.tg).put("group", g.group)
        .put("src", g.src).put("ch", g.ch).put("hz", g.hz).put("slot", g.slot).put("tdma", g.tdma).put("emergency", g.emergency).put("encrypted", g.encrypted)
        .put("carrierHz", g.carrierHz).put("site", g.site)
    private fun reportJson(r: UnitReport) = JSONObject().put("ms", r.ms).put("hz", r.hz).put("kind", r.kind).put("hex", r.hex).put("verified", r.verified)
        .put("lat", r.lat ?: JSONObject.NULL).put("lon", r.lon ?: JSONObject.NULL).put("text", r.text)
    private fun carrierJson(c: CarrierRow) = JSONObject().put("key", c.key).put("hz", c.hz).put("levelDb", c.levelDb).put("peakDb", c.peakDb).put("firstMs", c.firstMs)
        .put("lastMs", c.lastMs).put("onMs", c.onMs).put("heardMs", c.heardMs).put("cls", c.cls).put("role", c.role).put("sys", c.sys).put("nac", c.nac).put("cc", c.cc)
        .put("frames", c.frames).put("blocks", c.blocks).put("crcOk", c.crcOk).put("lastDecodeMs", c.lastDecodeMs).put("envCv", c.envCv).put("eye", c.eye)
        .put("decoding", c.decoding).put("callsign", c.callsign).put("tdma", c.tdma).put("lcn", c.lcn)
    private fun siteJson(x: SiteRow) = JSONObject().put("key", x.key).put("label", x.label).put("rfss", x.rfss).put("site", x.site).put("nac", x.nac).put("ccHz", JSONArray(x.ccHz))
        .put("lastMs", x.lastMs).put("levelDb", if (x.levelDb.isFinite()) x.levelDb else JSONObject.NULL)
        .put("neighbors", JSONArray(x.neighbors.map { JSONObject().put("label", it.label).put("hz", it.hz).put("ch", it.ch).put("sys", it.sys).put("heard", it.heard) }))
        .put("secondary", JSONArray(x.secondary.map { JSONObject().put("hz", it.first).put("ch", it.second) })).put("time", x.time).put("callsign", x.callsign)
        .put("carriers", JSONArray(x.carriers)).put("lcns", JSONArray(x.lcns.map { JSONObject().put("lcn", it.lcn).put("hz", it.hz).put("slot", it.slot) }))
        .put("rest", x.rest).put("busy", JSONArray(x.busy)).put("idens", JSONArray(x.idens.map { idenJson(it) })).put("units", x.units).put("lra", x.lra).put("cls", x.cls)
    private fun sysJson(s: SystemRow) = JSONObject().put("key", s.key).put("proto", s.proto).put("color", s.color).put("label", s.label).put("wacn", s.wacn).put("sysId", s.sysId)
        .put("cc", s.cc).put("fid", s.fid).put("net", s.net).put("model", s.model).put("callsign", s.callsign).put("firstMs", s.firstMs).put("lastMs", s.lastMs)
        .put("sites", JSONArray(s.sites.map { siteJson(it) })).put("idens", JSONArray(s.idens.map { idenJson(it) })).put("grants", s.grants).put("units", s.units)
        .put("tgs", s.tgs).put("derived", s.derived)

    private fun post(force: Boolean = false) {
        val t = now()
        if (!force && t - lastPost < 500) { pending = true; return }
        pending = false; lastPost = t
        _snap.value = buildSnapshot()
    }
    @Synchronized fun clear() {
        carriers.clear(); systems.clear(); sites.clear(); units.clear(); tgs.clear(); grants = ArrayList(); logRows.clear(); logSeen.clear()
        chans.clear(); bbFir.clear(); blocks = 0; colorNext = 0
        post(true)
    }

    companion object {
        private val CLOCK = ThreadLocal.withInitial { java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US) }
        private val ISO = ThreadLocal.withInitial { java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") } }

        /** The bands Fleet scans: id, label, low and high edge (Hz). */
        val BANDS = listOf(
            Band("VHF", "VHF 150–174", 150_000_000L, 174_000_000L), Band("UHF", "UHF 450–470", 450_000_000L, 470_000_000L),
            Band("TBAND", "T-BAND 470–512", 470_000_000L, 512_000_000L), Band("700", "700 769–775", 769_000_000L, 775_000_000L),
            Band("800", "800 851–869", 851_000_000L, 869_000_000L), Band("900", "900 935–941", 935_000_000L, 941_000_000L),
        )
        val SPANS = listOf(2_400_000 to "2.4 MHz", 8_000_000 to "8 MHz", 20_000_000 to "20 MHz")
        /** The centers a band is heard from: one when the span covers it, else even steps across it. */
        fun windows(band: String, rate: Int): List<Window> {
            val use = rate * 0.8; val out = ArrayList<Window>()
            for (b in BANDS) {
                if (band != "AUTO" && band != b.id) continue
                val n = max(1, ceil((b.hi - b.lo) / use).toInt())
                for (i in 0 until n) out.add(Window(b.id, (if (n == 1) (b.lo + b.hi) / 2.0 else b.lo + use / 2 + i * ((b.hi - b.lo - use) / (n - 1))).roundToLong() + 3_125))
            }
            return out
        }
    }
    data class Band(val id: String, val label: String, val lo: Long, val hi: Long)
    data class Window(val band: String, val hz: Long)
}
