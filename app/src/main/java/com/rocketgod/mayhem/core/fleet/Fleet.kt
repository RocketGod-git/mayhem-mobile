package com.rocketgod.mayhem.core.fleet

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.ham.P25Decoder
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
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Dispatch: a receive-only monitor for P25, DMR, TETRA, NXDN and Motorola Type II trunked radio. Finds every carrier in the span, gives the
 * live ones a channel each (the control channels and the channels of calls on the air keep theirs, the rest take
 * turns), decodes the control signaling and builds the systems, sites, channel tables, grants, registrations, unit
 * positions and calls from what is on the air. Labels are only what the air carries. Publishes a snapshot (at most two
 * a second) and log lines. Internal names and saved keys stay "fleet" so saved data carries over.
 */
const val CH_RATE = 24_000.0
/** How far from its system's area a DMR unit position may resolve, and from the receiver before the area is known (km). */
const val PLACE_KM = 80.0
const val PLACE_RX_KM = 150.0
/** Distance in km between two points (equirectangular, plenty for a region). */
fun kmBetween(a: Double, b: Double, c: Double, d: Double): Double {
    val r = PI / 180; val x = (d - b) * r * cos((a + c) / 2 * r); val y = (c - a) * r
    return 6371 * kotlin.math.hypot(x, y)
}
private const val CUT_HZ = 5_500.0
/**
 * Turns on a channel for carriers nothing has decoded lately go two ways at once. Full looks for the strong new
 * carriers ([FULL_DB] over the floor and off any stronger one's skirt), strongest first, and after them for every carrier
 * in turn, the one waiting longest first: [AUDITION_MS] each. Quick looks of
 * [AUDITION_FIRST_MS] for the weaker new ones, strongest first (a control channel at a fair level shows its syncs well
 * inside one), held for [AUDITION_MS] when something on it looked like a signal Dispatch reads (syncs, words through
 * their check, training sequences).
 */
private const val AUDITION_MS = 3_000L
private const val AUDITION_FIRST_MS = 500L
private const val FULL_DB = 20.0
/** The quickest a carrier is classed analog or otherwise. */
private const val CLASS_MS = 1_500L
/** A control channel found on a turn keeps its channel until its system is read, up to this long. */
private const val IDENTIFY_MS = 10_000L
/** More control channels than channels for them: each holds one this long, then the one waiting longest takes it. */
private const val CORE_TURN_MS = 20_000L
/** A carrier classed analog or unknown, or one already identified that is not a control channel, waits this long for another turn. */
private const val RECHECK_MS = 300_000L
/** When the span has more carriers than channels, this many channels stay free for turns while new carriers wait (one after). */
private const val TURN_CHANNELS = 2
private const val LIVE_MS = 4_000L
private const val KNOWN_UNITS = 3000

data class CarrierRow(
    val key: Long, val hz: Long, val levelDb: Double, val peakDb: Double, val firstMs: Long, val lastMs: Long, val onMs: Long, val heardMs: Long,
    val cls: String, val role: String, val sys: String, val nac: Int, val cc: Int, val frames: Int, val blocks: Int, val crcOk: Int,
    val lastDecodeMs: Long, val envCv: Double, val eye: Double, val decoding: Boolean, val callsign: String, val tdma: Boolean, val lcn: String,
    /** When the channel last keyed its CW ID. */
    val callsignMs: Long = 0,
)
data class Neighbor(val label: String, val hz: Long, val ch: String, val sys: Int, val heard: Boolean)
data class Lcn(val lcn: Int, val hz: Long, val slot: Int)
data class LpcnRow(val lpcn: Int, val hz: Long, val votes: Int)
data class SiteRow(
    val key: String, val label: String, val rfss: Int, val site: Int, val nac: Int, val ccHz: List<Long>, val lastMs: Long, val levelDb: Double,
    val neighbors: List<Neighbor>, val secondary: List<Pair<Long, String>>, val time: String, val callsign: String, val carriers: List<Long>,
    val lcns: List<Lcn>, val rest: Int, val busy: List<Int>, val idens: List<Iden>, val units: Int, val lra: Int, val cls: Int,
)
data class SystemRow(
    val key: String, val proto: String, val color: Int, val label: String, val wacn: Int, val sysId: Int, val cc: Int, val fid: Int,
    val net: Int, val model: String, val callsign: String, val firstMs: Long, val lastMs: Long, val sites: List<SiteRow>, val idens: List<Iden>,
    val grants: Int, val units: Int, val tgs: Int, val derived: Boolean,
    /** How a DMR system trunks, from what its channels send: "CAPACITY PLUS" (rest-channel beacons), "TIER III" (Aloha and grants). */
    val trunk: String = "",
    /** The latest CW ID heard on any of the system's channels (control, voice, conventional): text, when, where. */
    val cwId: String = "", val cwIdMs: Long = 0, val cwIdHz: Long = 0,
    /** DMR logical channels resolved to MHz from grants and the voice link control that followed them. */
    val lpcns: List<LpcnRow> = emptyList(),
    /** The channels the system was heard on (kept when it is out of the span), and whether its units report positions. */
    val heardHz: List<Long> = emptyList(), val positions: Boolean = false,
    /** TETRA: what the cell broadcasts and the MAC headers say about air interface encryption ("" for the others). */
    val security: String = "",
)
data class UnitReport(val ms: Long, val hz: Long, val kind: String, val hex: String, val verified: Boolean, val lat: Double?, val lon: Double?, val text: String,
                      /** The carrier's level when it was heard (dB over the floor). */ val db: Double? = null)
data class TrailPt(val lat: Double, val lon: Double, val ms: Long)
data class UnitRow(
    val key: String, val sys: String, val id: Int, val firstMs: Long, val lastMs: Long, val lat: Double?, val lon: Double?, val posMs: Long,
    val posVerified: Boolean, val trail: List<TrailPt>, val groups: List<Int>, val grants: Int, val carriers: List<Long>, val reports: List<UnitReport>, val site: String,
    /** Talkgroups the unit was heard on, with how many times (most first). */
    val tgCounts: List<Pair<Int, Int>> = emptyList(),
    /** Position reports that resolved outside the system's area (left off the map), and all position reports. */
    val offArea: Int = 0, val fixes: Int = 0,
    /** The talker alias its radio sent (DMR), or "". */
    val alias: String = "",
)
data class GrantRow(
    val ms: Long, var lastMs: Long, val sys: String, val kind: String, val tg: Int, val group: Boolean, var src: Int, val ch: String, val hz: Long, val slot: Int,
    val tdma: Boolean, val emergency: Boolean, val encrypted: Boolean, val carrierHz: Long, val site: String, val lpcn: Int? = null, val chDerived: Boolean? = null,
)
data class TgRow(val key: String, val sys: String, val tg: Int, val firstMs: Long, val lastMs: Long, val grants: Int, val recent: List<Long>, val members: List<Int>, val history: List<GrantRow>)
data class LogRow(val ms: Long, val hz: Long, val proto: String, val name: String, val text: String, val hex: String, val ok: Boolean)
data class Follow(val key: String, val hz: Long)
data class FleetSnap(
    val centerHz: Long, val rate: Int, val spanLo: Double, val spanHi: Double, val carriers: List<CarrierRow>, val systems: List<SystemRow>,
    val units: List<UnitRow>, val tgs: List<TgRow>, val grants: List<GrantRow>, val perMin: Int, val blocks: Int, val slots: Int, val ref: Boolean,
    val calls: List<CallRow> = emptyList(), val follow: Follow? = null, val codecs: List<String> = emptyList(),
    /** The call being heard (its key), and the system lock in force. */
    val playing: String = "", val lock: Lock? = null,
)
data class UnitDetail(val key: String, val reports: List<UnitReport>, val trail: List<TrailPt>, val offArea: Int = 0)

/** What the device keeps between sessions (see [FleetProcessor.known]). */
data class KnownSystem(val key: String, val proto: String, val wacn: Int, val sysId: Int, val cc: Int, val fid: Int, val net: Int, val model: String,
                       val firstMs: Long, val lastMs: Long, val derived: Boolean, val hz: List<Long>)
data class KnownUnit(val sys: String, val id: Int, val lat: Double, val lon: Double, val posMs: Long, val verified: Boolean, val firstMs: Long, val lastMs: Long)
data class KnownState(val v: Int, val systems: List<KnownSystem>, val units: List<KnownUnit>) {
    fun toJson(): JSONObject = JSONObject().put("v", v)
        .put("systems", JSONArray(systems.map { s -> JSONObject().put("key", s.key).put("proto", s.proto).put("wacn", s.wacn).put("sysId", s.sysId).put("cc", s.cc).put("fid", s.fid)
            .put("net", s.net).put("model", s.model).put("firstMs", s.firstMs).put("lastMs", s.lastMs).put("derived", s.derived).put("hz", JSONArray(s.hz)) }))
        .put("units", JSONArray(units.map { u -> JSONObject().put("sys", u.sys).put("id", u.id).put("lat", u.lat).put("lon", u.lon).put("posMs", u.posMs).put("verified", u.verified)
            .put("firstMs", u.firstMs).put("lastMs", u.lastMs) }))
    companion object {
        fun fromJson(o: JSONObject?): KnownState? {
            if (o == null || o.optInt("v") != 1) return null
            val ss = o.optJSONArray("systems") ?: JSONArray(); val us = o.optJSONArray("units") ?: JSONArray()
            val systems = (0 until ss.length()).mapNotNull { i -> ss.optJSONObject(i)?.let { s ->
                val hz = s.optJSONArray("hz"); KnownSystem(s.optString("key"), s.optString("proto"), s.optInt("wacn", -1), s.optInt("sysId", -1), s.optInt("cc", -1), s.optInt("fid", -1),
                    s.optInt("net", -1), s.optString("model"), s.optLong("firstMs"), s.optLong("lastMs"), s.optBoolean("derived"), if (hz == null) emptyList() else (0 until hz.length()).map { hz.optLong(it) }) } }
                .filter { it.key.isNotEmpty() }
            val units = (0 until us.length()).mapNotNull { i -> us.optJSONObject(i)?.let { u ->
                KnownUnit(u.optString("sys"), u.optInt("id"), u.optDouble("lat"), u.optDouble("lon"), u.optLong("posMs"), u.optBoolean("verified"), u.optLong("firstMs"), u.optLong("lastMs")) } }
                .filter { it.lat.isFinite() && it.lon.isFinite() }
            return KnownState(1, systems, units)
        }
    }
}

private class Hdr(val ms: Long, val slot: Int)
private class Carrier(val key: Long, val hz: Long, now: Long) {
    var levelDb = 0.0; var peakDb = 0.0; val firstMs = now; var lastMs = now; var onMs = 0L; var heardMs = 0L
    var cls = ""; var role = ""; var sys = ""; var nac = -1; var cc = -1; var frames = 0; var blocks = 0; var crcOk = 0; var lastDecodeMs = 0L
    var envCv = 0.0; var eye = 0.0; var decoding = false; var callsign = ""; var callsignMs = 0L; var tdma = false; var lcn = ""
    var hdr: Hdr? = null; var lastAuditionMs = 0L
    /** Motorola Type II: the channel number the control channel announces for itself, and the plan that number proved. */
    var osw: OswCc? = null
    /** Turns the carrier has had on a channel, and its level at the last. */
    var turns = 0; var turnDb = 0.0
    var p25Sys = -1; var p25Wacn = -1; var p25Rfss = -1; var p25Site = -1
    var dmrSys = ""; val tables = LinkedHashMap<Int, Iden>(); val unitIds = LinkedHashMap<Int, Long>()
    var tetra: TetraSync? = null; var tetraCell: TetraSysinfo? = null; var nxdn: NxdnSite? = null; var nxdnBaud = 0
    var nxdnAdj: LinkedHashMap<String, NxdnAdj>? = null; var nxdnRan = -1; var nxdnRanN = 0; var nxdnService: Int? = null
    /** A Type-D repeater's call as its SCCH builds it up: source (INFO3), destination (INFO2/INFO4), cipher (INFO1). */
    var nxdnD: NxdnD? = null
    fun row() = CarrierRow(key, hz, levelDb, peakDb, firstMs, lastMs, onMs, heardMs, cls, role, sys, nac, cc, frames, blocks, crcOk, lastDecodeMs, envCv, eye,
        decoding, callsign, tdma, lcn, callsignMs)
}
private class OswCc(val cc: Int, val plan: SmartNet.Plan?)
/** Motorola Type II: the channel plan its control channel proved (null until one does), and the channels granted (count). */
private class OswSys { var plan: SmartNet.Plan? = null; val chans = LinkedHashMap<Int, Int>() }
private class NxdnD { var src = 0; var dst = -1; var group = true; var cipher = -1; var keyId = 0; var ms = 0L }
/** An NXDN message as a unit's report shows it. */
private class NxdnUnitMsg(val hex: String, val line: String)
private class NeighborAt(val sys: Int, val rfss: Int, val site: Int, val ch: Int)
private class Site(val key: String, val sys: String, val rfss: Int, val site: Int, var nac: Int, var lastMs: Long) {
    val carriers = LinkedHashSet<Long>(); val neighbors = LinkedHashMap<String, NeighborAt>(); val secondary = LinkedHashSet<Int>()
    var time = ""; var lra = -1; var cls = -1; val idens = LinkedHashMap<Int, Iden>()
}
private class Sys(val key: String, val proto: String, val color: Int, val wacn: Int, val sysId: Int, var cc: Int, val fid: Int, val net: Int, val model: String,
                  val firstMs: Long, var lastMs: Long, var derived: Boolean) {
    val idens = LinkedHashMap<Int, Iden>(); var trunk = ""
    val lcns = LinkedHashMap<Int, Pair<Long, Int>>(); val lcnVotes = LinkedHashMap<String, LinkedHashMap<Int, Int>>(); var rest = -1; var busy: List<Int> = emptyList()
    /** Tier III logical channel (LPCN) to carrier: votes, and the ones resolved. */
    val lpcnVotes = LinkedHashMap<Int, LinkedHashMap<Long, Int>>(); val lpcnHz = LinkedHashMap<Int, Long>()
    /** Where the system was heard (its control or rest channels), kept across retunes and sessions. */
    val heardHz = LinkedHashSet<Long>()
    /** NXDN: the channel plan learned from what was heard, and the symbol rate of the system's channels. */
    var nxdnPlan: NxdnPlan? = null; var nxdnBaud = 0
    /** TETRA: calls by call identifier, and the air interface encryption seen. */
    var tetra: TetraSys? = null
    var osw: OswSys? = null
}
private class TetraCall(var tg: Int, var group: Boolean, var src: Int, var hz: Long, var slot: Int, var e2ee: Boolean, val ms: Long)
private class TetraSys {
    val calls = LinkedHashMap<Int, TetraCall>(); var encSdus = 0; var clearSdus = 0; var aie = false; var sec: TetraSecurity? = null
    /** Carriers named by channel allocations: carrier number to frequency. */
    val carriers = LinkedHashMap<Int, Long>()
}
private class Report(val ms: Long, val hz: Long, val kind: String, val hex: String, val verified: Boolean, val text: String, val db: Double? = null) {
    var lat: Double? = null; var lon: Double? = null; var lonLo: Int? = null; var latLo: Int? = null
    fun row() = UnitReport(ms, hz, kind, hex, verified, lat, lon, text, db)
}
/** A position report as sent (the low 16 bits of each coordinate), resolved when shown. */
private class Fix(val ms: Long, val lat16: Int, val lon16: Int)
private class UnitRec(val key: String, val sys: String, val id: Int, val firstMs: Long, var lastMs: Long) {
    var lonLo = -1; var latLo = -1; var posMs = 0L; var posVerified = false; val trail = ArrayList<TrailPt>(); val groups = LinkedHashSet<Int>(); var grants = 0
    val carriers = LinkedHashSet<Long>(); val reports = ArrayList<Report>()
    /** Every position report as sent, and the talkgroups the unit was heard on with how many times. */
    val fixes = ArrayList<Fix>(); val tgCounts = LinkedHashMap<Int, Int>()
    /** The talker alias its radio sent (DMR), or "". */
    var alias = ""
    /** A position kept from an earlier session (restored from the device), used until a report on the air replaces it. */
    var fix: Pair<Double, Double>? = null
}
private class Tg(val key: String, val sys: String, val tg: Int, val firstMs: Long, var lastMs: Long) {
    var grants = 0; var recent = ArrayList<Long>(); val members = LinkedHashSet<Int>(); val history = ArrayList<GrantRow>()
}
private class PendingGrant(val sys: String, val tg: Int, val group: Boolean, val lpcn: Int, val slot: Int, val ms: Long)

/** Channels a span can run at once: the down-converters cost in proportion to the sample rate. */
fun channelBudget(rate: Int): Int = max(4, min(24, floor(110e6 / max(rate, 1)).toInt()))
private fun gridKey(hz: Double): Long = Math.round(hz / 6250) * 6250
private fun gridKey(hz: Long): Long = gridKey(hz.toDouble())
/** TETRA is not tried on 925 to 960 MHz (the 900 MHz land mobile and GSM downlink band), where none is allocated. */
private fun tetraBand(hz: Long): Boolean = hz < 925_000_000L || hz > 960_000_000L
private fun round6(x: Double): Double = Math.round(x * 1e6) / 1e6

private class TetraChan(val rx: TetraRx, val ddc: Ddc?) { var oi = FloatArray(0); var oq = FloatArray(0) }
private class DdcBuf(val ddc: Ddc) { var oi = FloatArray(0); var oq = FloatArray(0) }

/** [baseband]: samples arrive already mixed to 0 Hz at that rate (a recorded channel clip), no down-converter. */
private class Chan(val key: Long, var hz: Double, center: Long, rate: Int, now: Long, baseband: Double = 0.0) {
    val ddc = Ddc(CUT_HZ, CH_RATE, 127)
    val rx: SymbolRx
    val p25 = P25Framer()
    val p25v = P25Decoder()
    /** Symbols so far, the P25 voice decoder's clock; [lcErrs] its failure count at the last link control read. */
    var t = 0L; var lcErrs = 0
    val dmr = DmrFramer()
    /** Motorola Type II signaling words, and analog FM voice on a channel a Type II grant named. */
    val osw: OswRx; var fm: FmVoice? = null
    /** The turn is a quick first look. */
    var quick = false
    val cw: CwReader
    var oi = FloatArray(0); var oq = FloatArray(0)
    val openedMs = now; var lastSyncMs = 0L; var quietSince = now; private var cwOn = false
    /** The Phase 2 TDMA receiver, on a channel a grant named TDMA. */
    var p2: P2Rx? = null
    val fs: Double
    /** A TETRA receiver on its own wider down-converter (a TETRA carrier is 25 kHz wide), for a carrier nothing else read. */
    var tetra: TetraChan? = null
    /** NXDN receivers (NXDN48 and NXDN96) on the channel baseband, for a carrier nothing else read; the one that locks stays. */
    var nxdn: List<NxdnRx>? = null
    /** The TETRA MAC on the TETRA receiver's bursts. */
    var tetraMac: TetraMac? = null
    /**
     * NXDN96's own down-converter on a span channel: 48 kS/s and 7 kHz wide, so its 4800 symbols a second get ten samples
     * each (at the channel's 24 kS/s the symbol timing slips now and then) and its outer deviation is not clipped.
     */
    var nxdnDdc: DdcBuf? = null
    /** NXDN frame syncs on their grid seen so far, and the callback when more come (the baud they came at). */
    private var nxdnGrid = 0
    var onNxdnSync: (baud: Int) -> Unit = {}
    fun nxdnSyncCheck() { nxdn?.let { for (r in it) if (r.framer.steady && r.framer.gridSyncs > nxdnGrid + 2) { nxdnGrid = r.framer.gridSyncs; onNxdnSync(r.baud) } } }
    private var center = center; private val rate = if (baseband > 0) 0 else rate
    /** Fed a recorded channel at its own rate (no down-converter, so no DC spike of the receiver's). */
    val baseband: Boolean get() = rate == 0
    /**
     * Lost voice is filled, not left silent: a P25 LDU (9 frames, 864 symbols) or a DMR voice burst (3 frames, 60 ms a
     * slot) that does not come when due is replaced by erasures, which the vocoder answers with the last frame repeated
     * and faded to a faint floor. So the player never runs dry inside a call. The fill never starts, extends, takes or
     * keeps a call (the processor drops it for a call no longer on the air), and stops 5 s after the lane's last voice.
     */
    var onFill: (lane: Int, frames: Int) -> Unit = { _, _ -> }
    /** Lanes: 0 and 1 the DMR slots, 2 P25. Symbol time of the last voice, and when the next fill falls due. */
    private val lastVoice = longArrayOf(-1_000_000_000L, -1_000_000_000L, -1_000_000_000L)
    private val due = longArrayOf(Long.MAX_VALUE, Long.MAX_VALUE, Long.MAX_VALUE)
    private var tetraHz = 0.0

    init {
        ddc.reset(rate.toDouble()); ddc.offsetHz = hz - center
        fs = if (baseband > 0) baseband else ddc.outRate
        rx = SymbolRx(fs)
        osw = OswRx(fs)
        cw = CwReader(fs)
        // the voice frames' payload (nine vocoder frames and the link control of each LDU) is read by the HAM receiver's
        // P25 decoder, driven by this channel's frame syncs
        rx.onSymbol = { s ->
            if ((t and 31L) == 0L) fillDue()
            val n0 = p25.syncs
            p25.push(s); dmr.push(s)
            if (p25.syncs != n0) p25v.sync(t) else p25v.push(slice(s), t)
            t++
        }
    }
    /** Voice arrived on a lane (DMR slot 0 or 1, or 2 for P25). */
    fun voiced(lane: Int) { val per = if (lane == 2) 864 else 288; lastVoice[lane] = t; due[lane] = t + per + (if (lane == 2) 216 else 96) }
    private fun fillDue() {
        for (lane in 0 until 3) {
            if (t < due[lane]) continue
            if (t - lastVoice[lane] > 24_000) { due[lane] = Long.MAX_VALUE; continue }
            val per = if (lane == 2) 864 else 288
            due[lane] += per.toLong()
            onFill(lane, if (lane == 2) 9 else 3)
        }
    }
    /** Something on the channel looks like a signal Dispatch reads (syncs, words through their check, training sequences). */
    fun hinted(): Boolean = p25.clean > 0 || p25.syncs >= 2 || dmr.syncs >= 2 || osw.good >= 2 || (nxdn?.any { it.framer.gridSyncs > 0} ?: false) ||
        (tetra?.let { it.rx.stats.bschOk > 0 || it.rx.stats.trainings >= 3 } ?: false)
    /** The turn of a carrier nothing has decoded is over. */
    fun turnOver(now: Long): Boolean = now - openedMs >= (if (quick && !hinted()) AUDITION_FIRST_MS else AUDITION_MS)
    fun retarget(center: Long) { ddc.offsetHz = hz - center; this.center = center; tetra?.ddc?.offsetHz = tetraHz - center; nxdnDdc?.let { it.ddc.offsetHz = hz - center } }
    /** The sample rate an NXDN receiver at [baud] gets: [wide] for an NXDN96 channel known as one. */
    fun nxdnFs(baud: Int, wide: Boolean): Double {
        if (!wide || baud == 2400 || rate == 0) return fs
        val x = nxdnDdc ?: run { val d = Ddc(7_000.0, 48_000.0, 63); d.reset(rate.toDouble()); d.offsetHz = hz - center; DdcBuf(d).also { nxdnDdc = it } }
        return x.ddc.outRate
    }
    /** Starts the TETRA receiver: 72 kS/s off its own down-converter, or the baseband itself when it is fast enough. */
    fun tetraOn(hz: Double = this.hz): TetraRx? {
        tetra?.let { return it.rx }
        if (rate > 0) { val d = Ddc(13_500.0, 72_000.0, 63); d.reset(rate.toDouble()); d.offsetHz = hz - center; tetraHz = hz; tetra = TetraChan(TetraRx(d.outRate), d) }
        else if (fs >= 36_000) tetra = TetraChan(TetraRx(fs), null)
        return tetra?.rx
    }
    fun push(fi: FloatArray, fq: FloatArray, n: Int, now: Long) {
        val need = ddc.maxOut(n)
        if (oi.size < need) { oi = FloatArray(need); oq = FloatArray(need) }
        val m = ddc.push(fi, fq, n, oi, oq)
        channel(oi, oq, m, now)
        val nx = nxdnDdc; val nd = nx?.ddc; val rs = nxdn
        if (nx != null && nd != null && rs != null && rs.any { it.fs != fs }) {
            val k = nd.maxOut(n); if (nx.oi.size < k) { nx.oi = FloatArray(k); nx.oq = FloatArray(k) }
            val j = nd.push(fi, fq, n, nx.oi, nx.oq)
            for (r in rs) if (r.fs != fs) r.push(nx.oi, nx.oq, j)
        } else if (nx != null && rs != null) nxdnDdc = null
        val tc = tetra; val td = tc?.ddc
        if (tc != null && td != null) {
            val k = td.maxOut(n); if (tc.oi.size < k) { tc.oi = FloatArray(k); tc.oq = FloatArray(k) }
            val j = td.push(fi, fq, n, tc.oi, tc.oq); tc.rx.push(tc.oi, tc.oq, j)
        }
    }
    /** Baseband straight to the TETRA receiver (a recorded or synthesized channel at its own rate). */
    fun tetraBaseband(zi: FloatArray, zq: FloatArray, m: Int) { val tc = tetra; if (tc != null && tc.ddc == null) tc.rx.push(zi, zq, m) }
    fun channel(zi: FloatArray, zq: FloatArray, m: Int, now: Long) {
        // decoded frames, not bare syncs, mark the channel digital: a keyed CW tone can pass for a sync now and then
        val s0 = p25.clean + dmr.bursts
        rx.push(zi, zq, m)
        osw.push(zi, zq, m); fm?.push(zi, zq, m)
        p2?.push(zi, zq, m)
        nxdn?.let { for (r in it) if (r.fs == fs) r.push(zi, zq, m) }
        nxdnSyncCheck()
        if (p25.clean + dmr.bursts != s0) { lastSyncMs = now; quietSince = now; cwOn = false }
        // a CW ID comes once the digital signal has stopped (a voice channel's frames are 180 ms apart); the reader starts
        // fresh then, so the digital signal's levels do not hide the tone
        else if (now - lastSyncMs > 250) { if (!cwOn) { cw.reset(); cwOn = true }; cw.push(zi, zq, m) }
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
    val calls = CallTracker { now() }
    private val p25Seen = HashMap<Long, Long>()
    private val dmrSeen = HashMap<Long, Long>()
    /** When each carrier last sent a Phase 2 sync pair: DMR syncs read off a Phase 2 signal are not DMR. */
    private val p2Seen = HashMap<Long, Long>()
    /** Carriers whose NXDN frame syncs keep their grid: NXDN, decoded or not, so never DMR (when, and at which baud). */
    private val nxdnSeen = HashMap<Long, Pair<Long, Int>>()
    private fun nxdnLately(c: Carrier, now: Long): Boolean { val x = nxdnSeen[c.key]; return x != null && now - x.first < 5_000 }
    /** DMR grants of the last moments, waiting for the voice link control that says which carrier their channel is. */
    private var pendingGrants = ArrayList<PendingGrant>()
    /**
     * A carrier not heard as DMR in the last 3 s has to prove it before a burst counts: the burst's own check passes (the
     * block CRC, or the RS check of a voice header or terminator), or its slot type needed no correction. A pager, an
     * analog or bare carrier, or a P25 voice channel passes the 0.82 sync now and then, and about a third of those chance
     * bursts pass the slot type's Golay code with corrections (almost none without): such a carrier was labeled DMR
     * voice, and its unchecked blocks could reach the tables.
     */
    private fun dmrProven(c: Carrier, b: Codes.DmrBurst, now: Long): Boolean {
        if (b.stErrs == 0 || now - (dmrSeen[c.key] ?: Long.MIN_VALUE / 2) <= 3_000) return true
        if (b.dt == 1 || b.dt == 2) return parseLc(b.bytes, b.dt)?.ok == true
        val mask = Codes.DMR_CRC_MASK[b.dt] ?: return false
        return Codes.crc12Ok(b.bytes, mask)
    }
    /** Per carrier: the last EMB that passed its check on a voice burst with no DMR data heard, for [dmrVoice]. */
    private val embVotes = HashMap<Long, Pair<Int, Long>>()
    private val _snap = MutableStateFlow<FleetSnap?>(null)
    val snap: StateFlow<FleetSnap?> = _snap.asStateFlow()

    // ------------------------------------------------------------------------------------------------ audio out
    /** Live audio of the call being heard, 48 kHz mono, faded in and out; set by the screen to the app's player. */
    var audioOut: ((FloatArray) -> Unit)? = null
    /** On by default (the owner's rule): a call heard is a call played. */
    @Volatile var audioOn = true; private set
    @Volatile var audioGain = 0.8; private set
    private val fader = AudioFader()
    private var vuAt = 0L
    private val _vu = MutableStateFlow(VuLevel("", -90))
    /** The level of the call being heard (its key, dBFS), at most every 80 ms. */
    val vu: StateFlow<VuLevel> = _vu.asStateFlow()
    data class VuLevel(val key: String, val db: Int)

    init {
        Vocoders.ensure()
        // the call being heard (the first to bring audio, unless priority or an emergency takes over) plays, faded in when
        // it starts and out when it ends or another takes over, so switching calls never clicks; its level goes to the meters
        calls.onAudio = { pcm, call ->
            if (audioOn) {
                for (b in fader.push(pcm, call.key, audioGain)) audioOut?.invoke(b)
                val t = System.currentTimeMillis()
                if (t - vuAt > 80) {
                    vuAt = t; var e = 0.0; for (v in pcm) e += v * v
                    _vu.value = VuLevel(call.key, (10 * log10(MAKEUP * MAKEUP * e / max(1, pcm.size) + 1e-9)).roundToInt())
                }
            }
        }
        calls.onEnd = { call -> if (fader.current == call.key) { fader.tail()?.let { audioOut?.invoke(it) }; _vu.value = VuLevel("", -90) } }
    }
    /** Turns the live audio on or off, and sets its gain (0 to 1.5). */
    @Synchronized fun setAudio(on: Boolean, gain: Double = audioGain) {
        if (!on && audioOn) fader.tail()?.let { audioOut?.invoke(it) }
        audioOn = on; audioGain = gain.coerceIn(0.0, 1.5)
    }
    /** Plays a call's kept audio again (through its own fader), on [out]. */
    fun replay(key: String, out: (FloatArray) -> Unit) {
        val pcm = synchronized(this) { calls.audioOf(key) } ?: return
        val f = AudioFader(); var i = 0
        while (i < pcm.size) { for (b in f.push(pcm.copyOfRange(i, min(pcm.size, i + 1600)), "replay", audioGain)) out(b); i += 1600 }
        f.tail()?.let(out)
    }

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
        for (ch in chans.values.toList()) ch.push(fi, fq, n, now)
        if (now - lastFind > 500 && frames >= 4) { lastFind = now; findCarriers(now); assign(now) }
        if (pending || now - lastPost > 1000) post()
    }

    private fun inSpan(hz: Double): Boolean = abs(hz - centerHz) < rate * 0.44 - 6_250
    private fun inSpan(hz: Long): Boolean = inSpan(hz.toDouble())
    /** Whether [hz] is inside the span the radio hears now. */
    @Synchronized fun spanHas(hz: Long): Boolean = rate > 0 && inSpan(hz)
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
            val n0 = carriers.size
            val c = carrierAt(if (abs(hz - key) < 1_500) key.toDouble() else Math.round(hz / 100) * 100.0)
            val fresh = carriers.size > n0
            seen.add(c.key)
            if (fresh) { c.levelDb = db; c.peakDb = db }
            if (now - c.lastMs < 2_000) c.onMs += now - c.lastMs
            c.lastMs = now; c.levelDb = Math.round(db * 10) / 10.0; c.peakDb = max(c.peakDb, c.levelDb)
            chans[c.key]?.hz = hz
        }
        for (c in carriers.values) if (c.key !in seen && inSpan(c.hz) && now - c.lastMs > 1_000) chans[c.key]?.cw?.end()
        pending = true
    }

    /**
     * Control channels keep their channel (taking turns when there are more than channels for them); the channels of
     * calls on the air keep theirs; every other live carrier gets turns (see [AUDITION_MS]).
     */
    private fun assign(now: Long) {
        val budget = channelBudget(rate)
        calls.tick({ hz -> val c = carriers[gridKey(hz)]; if (c != null && now - c.lastMs < 1_500) c.levelDb else null }, now)
        // the channels of calls on the air keep a channel while they last: from the grant on (the first voice frames come
        // before the spectrum shows the carrier), and past the first moments only while the carrier is up
        val pinned = calls.ranked().filter { !it.muted && !it.outside && it.hz > 0 && inSpan(it.hz) }.mapNotNull { x ->
            val c = carriers[gridKey(x.hz)]
            if (c != null && now - c.lastMs < LIVE_MS) c else if (now - x.startMs < 1_500) carrierAt(x.hz.toDouble()) else null
        }.distinct()
        val pinnedKeys = pinned.map { it.key }.toSet()
        val live = carriers.values.filter { inSpan(it.hz) && now - it.lastMs < LIVE_MS }
        val it = chans.entries.iterator()
        while (it.hasNext()) {
            val e = it.next(); val c = carriers[e.key]
            if (c == null || (now - c.lastMs > LIVE_MS && e.key !in pinnedKeys) || !inSpan(c.hz)) { it.remove(); continue }
            classify(c, e.value, now)
        }
        fun keep(c: Carrier) = c.lastDecodeMs > 0 && now - c.lastDecodeMs < 10_000
        // control and rest channels, and the ones carrying unit reports, come first (the locked system's when locked);
        // the channels of calls on the air come right after them, never in their place
        val lock = calls.prefs.lock?.sys ?: ""
        fun core0(c: Carrier) = (c.role == "control" || c.role == "rest" || reportsOn(c, now)) && (lock.isEmpty() || c.sys.isEmpty() || c.sys == lock)
        // one control channel a P25 site is enough: the others the same site's are heard on (a secondary control channel, or
        // the copies of a strong one the receiver makes beside it) wait their turns like any carrier
        val bestOfSite = HashMap<String, Carrier>()
        for (c in live) if (c.p25Site >= 0 && c.sys.isNotEmpty() && core0(c)) { val k = "${c.sys}/${c.p25Rfss}/${c.p25Site}"; val b = bestOfSite[k]; if (b == null || c.levelDb > b.levelDb) bestOfSite[k] = c }
        fun core(c: Carrier) = core0(c) && (c.p25Site < 0 || c.sys.isEmpty() || bestOfSite["${c.sys}/${c.p25Rfss}/${c.p25Site}"] === c)
        // a carrier classed analog or unknown, or one a system already owns that is not a control channel, waits for its next
        // turn (a voice channel comes back through the grants that name it; one classed unknown comes back sooner when it
        // keys up 6 dB stronger)
        fun settled(c: Carrier) = c.lastAuditionMs > 0 && now - c.lastAuditionMs < RECHECK_MS && !core(c) &&
            (c.sys.isNotEmpty() || c.cls == "ANALOG FM" || ((c.cls == "UNKNOWN 4FSK" || c.cls == "UNKNOWN LINEAR") && c.levelDb < c.turnDb + 6))
        val sorted = live.filter { keep(it) }.sortedWith(compareByDescending<Carrier> { core(it) }.thenByDescending { it.levelDb })
        // a carrier's place in the turns: its level, 20 dB less when it sits on the skirt of a neighbor 15 dB stronger
        // within 10 kHz
        val byHz = live.sortedBy { it.hz }; val score = HashMap<Long, Double>()
        for (i in byHz.indices) {
            val c = byHz[i]; var skirt = false
            var j = i - 1; while (j >= 0 && c.hz - byHz[j].hz <= 10_000 && !skirt) { skirt = byHz[j].levelDb >= c.levelDb + 15; j-- }
            j = i + 1; while (j < byHz.size && byHz[j].hz - c.hz <= 10_000 && !skirt) { skirt = byHz[j].levelDb >= c.levelDb + 15; j++ }
            score[c.key] = c.levelDb - if (skirt) 20 else 0
        }
        fun sc(c: Carrier) = score[c.key] ?: c.levelDb
        // carriers still waiting for a turn keep a share of the channels free, so a span with more carriers than channels
        // visits all of them. A carrier is new to the turns until it has had one, and again when it comes up 6 dB over its
        // level then (a channel that keys up now and then). The full share while new carriers wait, one channel after.
        val waiting = live.filter { !chans.containsKey(it.key) && !keep(it) && !settled(it) }
        fun fresh(c: Carrier) = c.turns == 0 || c.levelDb >= c.turnDb + 6
        val reserve = if (waiting.isNotEmpty() && live.size > budget) (if (waiting.any { fresh(it) }) TURN_CHANNELS else 1) else 0
        val cap = budget - reserve
        // the control channels known take turns when there are more than channels for them: one holding its channel keeps
        // it for [CORE_TURN_MS], then the one that has waited longest goes next. One granting calls keeps its channel.
        val busy = HashMap<Long, Int>()
        for (g in grants) { if (now - g.lastMs > 60_000) continue; val k = gridKey(g.carrierHz); busy[k] = (busy[k] ?: 0) + 1 }
        fun rank(c: Carrier): Int { val ch = chans[c.key]; return if (ch == null) 2 else if ((busy[c.key] ?: 0) > 0) 0 else if (now - ch.openedMs < CORE_TURN_MS) 1 else 3 }
        val coreL = live.filter { core(it) }.sortedWith { a, b ->
            val ra = rank(a); val rb = rank(b)
            if (ra != rb) ra - rb
            else if (ra == 0) (busy[b.key] ?: 0) - (busy[a.key] ?: 0)
            else if (ra == 1) b.levelDb.compareTo(a.levelDb)
            else a.lastAuditionMs.compareTo(b.lastAuditionMs)
        }
        val others = sorted.filter { !core(it) && it.key !in pinnedKeys }
        val nCore = min(coreL.size, max(1, cap))
        val held = coreL.take(nCore); val callChans = pinned.filter { it !in held }
        val want = ArrayList((held + callChans + others).take(max(cap, held.size + callChans.size)))
        // a carrier found decoding on its turn (a control channel, or a DMR or NXDN channel whose system its own frames name)
        // keeps the channel until its system is read
        for ((k, ch) in chans) { val c = carriers[k]!!; if (c !in want && (c.role == "control" || c.role == "rest" || (keep(c) && (c.cls == "DMR" || c.cls.startsWith("NXDN")))) && c.sys.isEmpty() && now - ch.openedMs < IDENTIFY_MS) want.add(min(nCore, want.size), c) }
        for ((k, ch) in chans) { val c = carriers[k]!!; if (!keep(c) && !ch.turnOver(now) && c !in want) want.add(c) }
        // the two ways of turns share the free channels: full looks (strong new carriers strongest first, then every
        // carrier, the one waiting longest first) and quick looks (the weaker new carriers, strongest first)
        val free = live.filter { it !in want && !settled(it) }
        val fullQ = free.filter { !fresh(it) || sc(it) >= FULL_DB }.sortedWith { a, b ->
            val fa = fresh(a); val fb = fresh(b)
            if (fa != fb) (if (fb) 1 else 0) - (if (fa) 1 else 0) else if (fa) sc(b).compareTo(sc(a)) else a.lastAuditionMs.compareTo(b.lastAuditionMs)
        }
        val quickQ = free.filter { fresh(it) && sc(it) < FULL_DB }.sortedByDescending { sc(it) }
        var nQuick = 0; var nFull = 0
        for (ch in chans.values) if (!ch.turnOver(now)) { if (ch.quick) nQuick++ else nFull++ }
        val quickSet = HashSet<Long>()
        var fi = 0; var qi = 0
        while (want.size < budget && (fi < fullQ.size || qi < quickQ.size)) {
            val q = qi < quickQ.size && (nQuick <= nFull || fi >= fullQ.size)
            if (q) { val c = quickQ[qi++]; want.add(c); quickSet.add(c.key); nQuick++ } else { want.add(fullQ[fi++]); nFull++ }
        }
        // channels still to spare go to the carriers that are waiting out their recheck, the one waiting longest first
        for (c in live.filter { it !in want && settled(it) }.sortedBy { it.lastAuditionMs }) { if (want.size >= budget) break; want.add(c) }
        val chosen = want.take(budget).map { it.key }.toSet()
        chans.keys.retainAll(chosen)
        for (k in chosen) if (!chans.containsKey(k)) {
            val c = carriers[k]!!; c.lastAuditionMs = now; c.turns++; c.turnDb = c.levelDb; open(c, now); chans[k]?.quick = k in quickSet
        }
        for (c in carriers.values) c.decoding = chans.containsKey(c.key)
        for ((k, ch) in chans) { val p = ch.p2; if (p != null && p.seed == null) carriers[k]?.let { p.setSeeds(p2Seeds(it)) } }
        placeCalls()
    }
    /** A carrier that has sent unit reports in the last minute. */
    private fun reportsOn(c: Carrier, now: Long): Boolean = c.unitIds.values.any { now - it < 60_000 }
    private fun open(c: Carrier, now: Long, given: Chan? = null) {
        val ch = given ?: Chan(c.key, c.hz.toDouble(), centerHz, rate, now)
        ch.p25.onBlock = { b -> p25Block(c, b) }
        ch.p25.onFrame = { nac, duid -> c.envCv = Math.round(ch.rx.envCv * 100) / 100.0; p25Frame(c, nac, duid) }
        ch.dmr.onBurst = { e -> dmrBurst(c, e) }
        ch.dmr.onVoice = { slot, d, n -> dmrVoice(c, ch, slot, d, n) }
        ch.p25v.onVoice = { bits -> p25Voice(c, bits.copyOf(), ch) }
        ch.onFill = { lane, n -> fill(c, lane, n) }
        ch.onNxdnSync = { baud -> nxdnSeen[c.key] = now() to baud }
        ch.p25v.onLog = { p25Lc(c, ch) }
        ch.p25v.onEs = { es -> p25Sec(c, "LDU2", es.algId, es.keyId, es.mi) }
        ch.p25v.onHdu = { hd -> p25Sec(c, "HDU", hd.algId, hd.keyId, hd.mi) }
        ch.cw.onText = { t -> cwText(c, t) }
        ch.osw.onOsw = { o, gap -> oswWord(c, ch, o, gap) }
        if (c.tdma) p2On(c, ch)
        chans[c.key] = ch
        if (calls.at("", c.hz, 0)?.proto == "SMARTNET") fmOn(c, ch)
    }
    /** A Phase 2 TDMA channel: its S-ISCH syncs class it and keep it decoding. */
    private fun p2On(c: Carrier, ch: Chan) {
        if (ch.p2 != null) return
        val p = P2Rx(ch.fs); ch.p2 = p
        p.onSync = { paired -> if (paired) { val now = now(); c.cls = "P25 PHASE 2 TDMA"; c.lastDecodeMs = now; c.frames++; if (c.role != "control") c.role = "voice"; p2Seen[c.key] = now; pending = true } }
        p.setSeeds(p2Seeds(c))
        p.onSeed = { s -> if (c.sys.isEmpty()) c.sys = s.sys; addLog(LogRow(now(), c.hz, "P25", "PHASE 2 SCRAMBLING", "PHASE 2 · descrambling with WACN ${hx(s.wacn, 5)} · SYSTEM ${hx(s.sysId, 3)} · NAC ${hx(s.nac, 3)}", "", true)) }
        p.onVoice = { lch, fr ->
            // an erasure keeps the timing of a call already on the air; it never starts or extends one
            if (fr.isEmpty()) { val call = calls.at(c.sys, c.hz, lch); if (call != null && call.onAir) calls.frames(call, listOf(fr)) }
            else { val call = calls.voice(c.sys, "P25", c.hz, lch, 20, now(), true); calls.frames(call, listOf(fr)); pending = true }
        }
        p.onMac = { m -> p2Mac(c, m) }
        p.onEss = { lch, e -> calls.at(c.sys, c.hz, lch)?.let { calls.security(it, SecIn(e.algId != 0x80, "ESS", e.algId, e.keyId, e.mi)) } }
    }
    // ------------------------------------------------------------------------------------------------ NXDN
    /**
     * NXDN receivers on a channel: both bandwidths until one locks, or the one a system's grant names. The one that locks
     * stays; an NXDN96 one moves to its own 48 kS/s down-converter then (a carrier tried and not NXDN never costs one).
     */
    private fun nxdnOn(c: Carrier, ch: Chan, baud: Int = 0) {
        if (ch.nxdn != null) return
        fun make(b: Int, wide: Boolean): NxdnRx {
            val r = NxdnRx(ch.nxdnFs(b, wide), b)
            val keep = {
                val cur = ch.nxdn
                if (r.framer.locked && cur != null && r in cur) {
                    if (b == 4800 && !wide && !ch.baseband) ch.nxdn = listOf(make(4800, true))
                    else if (cur.size > 1) ch.nxdn = listOf(r)
                }
            }
            r.framer.onCac = { sr, msgs -> keep(); nxdnCac(c, sr, msgs, b) }
            r.framer.onTraffic = { t -> keep(); if (r.framer.locked || t.msgs.isNotEmpty()) nxdnTraffic(c, t, b) }
            return r
        }
        ch.nxdn = intArrayOf(2400, 4800).filter { baud == 0 || it == baud }.map { make(it, it == baud) }
    }
    private fun newSys(key: String, proto: String, wacn: Int, sysId: Int, cc: Int, fid: Int, net: Int, model: String, now: Long, derived: Boolean = false): Sys =
        Sys(key, proto, colorNext++, wacn, sysId, cc, fid, net, model, now, now, derived).also { systems[key] = it }
    private fun nxdnSys(key: String, now: Long, model: String, wacn: Int, sysId: Int, trunk: String, baud: Int): Sys {
        val s = systems[key] ?: newSys(key, "NXDN", wacn, sysId, -1, -1, -1, model, now)
        s.trunk = trunk; s.lastMs = now
        val plan = s.nxdnPlan ?: NxdnPlan().also { s.nxdnPlan = it }
        s.nxdnBaud = baud; plan.spacing = if (baud == 2400) 6250L else 12500L
        return s
    }
    private class NxdnPending(val sys: String, val ch: Int, val src: Int, val dst: Int, val group: Boolean, val ms: Long)
    /** Grants of the last moments, waiting for the voice that says which carrier their channel is (TS 1-A gives no plan). */
    private var nxdnPending = ArrayList<NxdnPending>()
    private fun nxdnLog(c: Carrier, name: String, text: String, hex: String) = addLog(LogRow(now(), c.hz, "NXDN", name, "${c.cls} · $text", hex, true))
    /** Where an NXDN channel is: heard, from the plan, or a guess used only where a carrier is live in the span. */
    private fun nxdnHz(s: Sys, ch: Int, now: Long): Pair<Long, Boolean> {
        val r = s.nxdnPlan?.resolve(ch) ?: return 0L to false
        if (r.how == "guess") {
            val k = carriers[gridKey(r.hz)]
            return if (k != null && inSpan(r.hz) && now - k.lastMs < LIVE_MS && abs(k.hz - r.hz) < 1_500) r.hz to true else 0L to false
        }
        return r.hz to (r.how != "heard")
    }
    /** An outbound control channel frame (TS 1-A 4.4.1): its messages build the system, its grants and its units. */
    private fun nxdnCac(c: Carrier, sr: Int, msgs: List<NxdnMsg>, baud: Int) {
        val now = now()
        c.cls = if (baud == 2400) "NXDN48" else "NXDN96"; c.role = "control"; c.lastDecodeMs = now; c.frames++; c.crcOk++; c.blocks++; blocks++; c.nxdnRan = sr and 0x3f
        for (m in msgs) {
            m.site?.let { nxdnSite(c, it, baud) }
            val s = if (c.sys.isNotEmpty()) systems[c.sys] else null
            if (s != null) { s.lastMs = now; nxdnControl(c, s, m, c.nxdn?.let { "site ${it.site}" } ?: "", now) }
            if (m.type != 0x10 && m.site == null) nxdnLog(c, m.name, nxdnLine(m), m.hex)
        }
        pending = true
    }
    /** SITE_INFO (TS 1-A 6.4.3.1): the Location ID names the system and site, and the control channels. */
    private fun nxdnSite(c: Carrier, x: NxdnSite, baud: Int) {
        val now = now(); val cat = NXDN_CATEGORY[x.category]; val key = "NXDN $cat-${x.system}"
        val s = nxdnSys(key, now, cat, x.category, x.system, "TYPE-C", baud)
        s.heardHz.add(c.key)
        c.cls = if (baud == 2400) "NXDN48" else "NXDN96"; c.role = "control"; c.sys = key
        c.nxdn = x.copy(service = c.nxdnService ?: x.service); c.nxdnBaud = baud
        // the control channel's own number: with one control channel named it is this one; with two, the one the plan puts here
        val plan = s.nxdnPlan!!
        if (x.cc1 != 0 && (x.cc2 == 0 || x.cc2 == x.cc1)) plan.vote(x.cc1, c.hz)
        else if (x.cc1 != 0) for (n in intArrayOf(x.cc1, x.cc2)) { val r = plan.resolve(n); if (r != null && r.how != "guess" && abs(r.hz - c.hz) < 1_000) plan.vote(n, c.hz) }
        addLog(LogRow(now, c.hz, "NXDN", "SITE_INFO", "${c.cls} · SITE_INFO · $cat SYSTEM ${x.system} · SITE ${x.site} · control channel ${x.cc1}${if (x.cc2 != 0) " and ${x.cc2}" else ""} · ${x.adjacent} adjacent sites · version ${x.version}", "", true))
        pending = true
    }
    /** A control message of a known system: grants, registrations, neighbors, channels. */
    private fun nxdnControl(c: Carrier, s: Sys, m: NxdnMsg, site: String, now: Long) {
        val msg = NxdnUnitMsg(m.hex, nxdnLine(m))
        val ch = m.ch; val dst = m.dst
        if ((m.type == 0x04 || m.type == 0x05) && ch != null && ch != 0 && dst != null) {
            val (hz, derived) = nxdnHz(s, ch, now); val efr = ((m.voiceOpt ?: 0) and 7) == 3; val src = m.src ?: 0
            nxdnPending = ArrayList(nxdnPending.filter { now - it.ms < 3_000 })
            if (nxdnPending.none { it.sys == s.key && it.ch == ch && it.dst == dst }) nxdnPending.add(NxdnPending(s.key, ch, src, dst, m.group, now))
            grant(s.key, GrantRow(now, now, s.key, if (m.group) "grant" else "u2u", dst, m.group, src, "CH $ch", hz, 0, false, m.emergency, false, c.hz, site, ch, derived), m.type == 0x05, efr)
            if (src != 0) touchUnit(s.key, src, c, now, "grant", msg, site, if (m.group) dst else null)
            if (!m.group && dst != 0) touchUnit(s.key, dst, c, now, "u2u", msg, site)
        } else if ((m.type == 0x20 || m.type == 0x24) && (m.unit ?: 0) in 1 until 0xfff0) {
            val unit = m.unit!!
            val u = touchUnit(s.key, unit, c, now, if (m.type == 0x20) "registration" else "group registration", msg, site)
            // a registration accepted (Cause (MM) 0x01, Table 6.5-27) puts the unit in its group
            val g = m.gid ?: 0
            if (g in 1 until 0xfff0 && m.cause == 1) { u.groups.add(g); tgFor(s.key, g, now).members.add(unit) }
        } else if ((m.type == 0x22 || m.type == 0x23) && (m.unit ?: 0) in 1 until 0xfff0) touchUnit(s.key, m.unit!!, c, now, if (m.type == 0x22) "registration clear" else "registration command", msg, site)
        else if (m.type == 0x1b && m.adj != null) { val a = c.nxdnAdj ?: LinkedHashMap<String, NxdnAdj>().also { c.nxdnAdj = it }; for (x in m.adj!!) a["${x.category}-${x.system}-${x.site}"] = x }
        else if (m.type == 0x1a) { val x = m.cch; val own = c.nxdn; if (x != null && own != null && x.site == own.site && x.system == own.system && x.flags == 8 && x.ch1 != 0 && x.ch2 == 0) s.nxdnPlan!!.vote(x.ch1, c.hz) }
        else if (m.type == 0x19 && m.service != null) { c.nxdnService = m.service; c.nxdn = c.nxdn?.copy(service = m.service!!) }
    }
    /**
     * A traffic channel frame (RTCH, RDCH, or a Type-D RTCH2): the VCALL in its SACCH or FACCH1 names the call and says
     * whether it is ciphered, TX_REL ends it, and its VCHs are the voice. A conventional channel (RDCH) is its own system,
     * named by its RAN; a trunked one belongs to the system whose grant named it.
     */
    private fun nxdnTraffic(c: Carrier, t: NxdnTraffic, baud: Int) {
        val now = now()
        c.cls = if (baud == 2400) "NXDN48" else "NXDN96"; c.lastDecodeMs = now; c.frames++
        if (c.role != "control") c.role = "voice"
        // a conventional system is named by its RAN once two SACCHs agree on it
        if (t.ran >= 0) { c.nxdnRanN = if (c.nxdnRan == t.ran) c.nxdnRanN + 1 else 1; c.nxdnRan = t.ran }
        if (t.rf == 2 && t.ran >= 0 && c.nxdnRanN >= 2) {
            val key = "NXDN CONV RAN ${t.ran}"
            val s = nxdnSys(key, now, "CONVENTIONAL", -1, t.ran, "CONVENTIONAL", baud)
            s.heardHz.add(c.key); c.sys = key
        }
        t.scch?.let { nxdnScch(c, it, now, baud) }
        for (m in t.msgs) {
            val dst = m.dst
            if (m.type == 0x01 && dst != null) {
                nxdnLearn(c, m.src ?: 0, dst, m.group, now)
                val call = calls.lc(c.sys, c.hz, 0, LcIn(m.group, dst, m.src ?: 0, m.emergency, (m.cipher ?: 0) != 0), now, "NXDN")
                if (((m.voiceOpt ?: 0) and 7) == 3) calls.setCodec(call, CodecIds.IMBE)
                calls.security(call, SecIn((m.cipher ?: 0) != 0, "VCALL", m.cipher, m.keyId))
                if (call.sys.isNotEmpty() && c.sys.isEmpty()) c.sys = call.sys
            } else if (m.type == 0x08 || m.type == 0x07 || m.type == 0x11) calls.terminate(c.sys, c.hz, 0, now)
            else if (m.type == 0x05 && (m.ch ?: 0) != 0 && c.sys.isNotEmpty()) systems[c.sys]?.let { nxdnControl(c, it, m, "", now) }
            if (m.type != 0x10) nxdnLog(c, m.name, "${if (t.rf == 2) "RDCH" else if (t.typeD) "RTCH2" else "RTCH"} · ${nxdnLine(m)}", m.hex)
        }
        val halves = t.halves.filterNotNull()
        if (halves.isEmpty()) { pending = true; return }
        val call = calls.voice(c.sys, "NXDN", c.hz, 0, 0, now)
        // EHR: two 72-bit VCHs a half; EFR (the IMBE frame): one 144-bit VCH a half
        val frames = ArrayList<IntArray>()
        for (h in halves) { if (call.codec == CodecIds.IMBE) frames.add(h) else { frames.add(h.copyOfRange(0, 72)); frames.add(h.copyOfRange(72, 144)) } }
        call.voiceMs += 20L * frames.size
        calls.frames(call, frames)
        pending = true
    }
    /** A call named on a carrier: a grant of the last moments to the same talkgroup or unit says which channel it is. */
    private fun nxdnLearn(c: Carrier, src: Int, dst: Int, group: Boolean, now: Long) {
        val i = nxdnPending.indexOfFirst { now - it.ms < 3_000 && it.dst == dst && it.group == group && (src == 0 || it.src == 0 || it.src == src) && (c.sys.isEmpty() || c.sys == it.sys) }
        if (i < 0) return
        val g = nxdnPending.removeAt(i)
        val s = systems[g.sys] ?: return; val plan = s.nxdnPlan ?: return
        if (c.sys.isEmpty()) c.sys = g.sys
        if (plan.vote(g.ch, c.hz)) {
            pending = true
            addLog(LogRow(now, c.hz, "NXDN", "CHANNEL", "${c.cls} · channel ${g.ch} is ${"%.5f".format(java.util.Locale.US, c.hz / 1e6)} MHz, from a grant and the voice that followed it", "", true))
        }
    }
    /** A Type-D SCCH message (TS 1-E 6.5.3): the site, a call's source, destination and cipher, the end of a transmission. */
    private fun nxdnScch(c: Carrier, x: NxdnScch, now: Long, baud: Int) {
        if (x.kind == "site" && x.siteCode >= 0) {
            val key = "NXDN TYPE-D SITE ${x.siteCode}"
            val s = nxdnSys(key, now, "TYPE-D", -1, x.siteCode, "TYPE-D", baud)
            s.heardHz.add(c.key); c.sys = key
            return
        }
        if (x.kind == "idle" || x.kind == "free" || x.kind == "halt") return
        val d = c.nxdnD?.takeIf { now - it.ms < 2_000 } ?: NxdnD().also { c.nxdnD = it }
        d.ms = now
        if (x.info == 3 && x.src >= 0) d.src = x.src
        if (x.info == 1 && x.cipher >= 0) { d.cipher = x.cipher; d.keyId = maxOf(0, x.keyId) }
        if (x.kind == "busy" && x.dst >= 0) {
            // Go to Repeater 31 is the end of a transmission (1-E 6.6.11)
            if (x.goTo == 31) { calls.terminate(c.sys, c.hz, 0, now); c.nxdnD = null; return }
            d.dst = x.dst; d.group = x.group
            // INFO4 on a repeater sends units elsewhere: a grant to that repeater's channel (INFO2 names this repeater's own call)
            val s = if (c.sys.isNotEmpty()) systems[c.sys] else null
            if (s != null && x.info == 4 && x.goTo > 0 && !calls.onAirAt(c.sys, c.hz, 0)) {
                val (hz, derived) = nxdnHz(s, x.goTo, now)
                nxdnPending = ArrayList(nxdnPending.filter { now - it.ms < 3_000 })
                if (nxdnPending.none { it.sys == s.key && it.ch == x.goTo && it.dst == x.dst }) nxdnPending.add(NxdnPending(s.key, x.goTo, 0, x.dst, x.group, now))
                grant(s.key, GrantRow(now, now, s.key, if (x.group) "grant" else "u2u", x.dst, x.group, 0, "REPEATER ${x.goTo}", hz, 0, false, false, false, c.hz, "", x.goTo, derived), false)
                nxdnLog(c, "INFO4", "GO TO REPEATER ${x.goTo} · ${if (x.group) "TG" else "UNIT"} ${nxdnId(x.dst, true)}", "")
                return
            }
        }
        if (d.dst >= 0 && (d.src != 0 || calls.onAirAt(c.sys, c.hz, 0))) {
            nxdnLearn(c, d.src, d.dst, d.group, now)
            val call = calls.lc(c.sys, c.hz, 0, LcIn(d.group, d.dst, d.src, false, d.cipher > 0), now, "NXDN")
            if (d.cipher >= 0) calls.security(call, SecIn(d.cipher > 0, "SCCH", d.cipher, d.keyId))
        }
    }
    /**
     * NXDN sites: a Type-C control channel per site (its SITE_INFO), with its adjacent sites and the channels learned;
     * a conventional or Type-D system's carriers make one site.
     */
    private fun nxdnSites(s: Sys): List<SiteRow> {
        val plan = s.nxdnPlan; val now = now()
        val lcns = plan?.heard?.entries?.sortedBy { it.key }?.map { Lcn(it.key, it.value, 0) } ?: emptyList()
        val cs = carriers.values.filter { it.sys == s.key }
        if (s.trunk == "TYPE-C") return cs.filter { it.nxdn != null }.map { c ->
            val x = c.nxdn!!
            val nbs = (c.nxdnAdj?.values ?: emptyList()).map { a ->
                val r = plan?.resolve(a.ch)
                Neighbor(if (a.system == x.system && a.category == x.category) "site ${a.site}" else "${NXDN_CATEGORY[a.category]} ${a.system} site ${a.site}", if (r != null && r.how != "guess") r.hz else 0L, "CH ${a.ch}", a.system,
                    cs.any { o -> o.nxdn?.site == a.site && now - o.lastMs < 60_000 })
            }
            SiteRow("${s.key}/${x.site}", "site ${x.site}", -1, x.site, c.nxdnRan, listOf(c.hz), c.lastMs, c.levelDb, nbs, emptyList(),
                "${c.cls} · control channel ${x.cc1}${if (x.cc2 != 0) " and ${x.cc2}" else ""} · ${x.adjacent} adjacent sites", c.callsign, listOf(c.key), lcns, -1, emptyList(), emptyList(), 0, -1, x.version)
        }
        if (cs.isEmpty()) return emptyList()
        return listOf(SiteRow("${s.key}/1", if (s.trunk == "TYPE-D") "site ${s.sysId}" else "RAN ${s.sysId}", -1, s.sysId, if (s.trunk == "CONVENTIONAL") s.sysId else -1, cs.map { it.hz }.sorted(),
            cs.maxOf { it.lastMs }, cs.maxOf { it.levelDb }, emptyList(), emptyList(), cs.first().cls, cs.firstOrNull { it.callsign.isNotEmpty() }?.callsign ?: "", cs.map { it.key }, lcns, -1, emptyList(), emptyList(), 0, -1, -1))
    }
    private fun tetraOn(c: Carrier, ch: Chan) {
        // the carrier finder can split a 25 kHz signal into pieces: the receiver is centered on all of them together
        val now = now()
        val parts = carriers.values.filter { abs(it.hz - c.hz) <= 16_000 && now - it.lastMs < LIVE_MS && it.cls != "P25 C4FM" && it.cls != "DMR" }
        // one receiver per signal: a piece next to one that already has it reads nothing twice
        for ((k, x) in chans) if (k != c.key && x.tetra != null && abs((carriers[k]?.hz ?: 0L) - c.hz) <= 16_000) return
        var w = 0.0; var sum = 0.0; for (x in parts) { val p = 10.0.pow(x.levelDb / 10); w += p; sum += p * x.hz }
        val rx = ch.tetraOn(if (w > 0) sum / w else c.hz.toDouble()) ?: return
        rx.onSync = { s -> tetraSync(c, s) }
        val mac = ch.tetraMac ?: TetraMac(rx).also { m -> ch.tetraMac = m; m.onEvent = { tetraEvent(c, it) } }
        // a carrier a grant sent us to: its scrambling is the cell's, known before its own synchronization bursts come
        val s = systems[c.sys]
        if (s != null && s.proto == "TETRA" && !mac.cellKnown) mac.setCell(s.wacn, s.sysId, s.cc)
    }
    /** A TETRA synchronization burst (EN 300 392-2 BSCH): the network (MCC, MNC), the cell's color code and timing. */
    private fun tetraSync(c: Carrier, t: TetraSync) {
        val now = now(); val key = "TETRA ${t.mcc}-${t.mnc}"
        val s = systems[key] ?: newSys(key, "TETRA", t.mcc, t.mnc, t.colorCode, -1, -1, "", now)
        s.lastMs = now; s.heardHz.add(c.key)
        c.cls = "TETRA"; if (c.role != "voice") c.role = "control"; c.sys = key; c.cc = t.colorCode; c.lastDecodeMs = now; c.frames++; c.crcOk++; c.blocks++; blocks++
        c.tetra = t
        // the other pieces of the same 25 kHz signal are the same carrier
        for (x in carriers.values) if (x !== c && abs(x.hz - c.hz) <= 13_000 && x.cls != "TETRA" && !(x.lastDecodeMs > 0 && now - x.lastDecodeMs < 5_000)) {
            x.cls = "TETRA"; x.role = "control"; x.sys = key; x.cc = t.colorCode; x.lastDecodeMs = now
        }
        addLog(LogRow(now, c.hz, "TETRA", "SYNC", "TETRA · SYNC · MCC ${t.mcc} · MNC ${t.mnc} · color code ${t.colorCode} · TS${t.timeslot} · frame ${t.frame} · multiframe ${t.multiframe} · cell load ${t.cellLoad}", "", true))
        pending = true
    }
    /** The TETRA state of a carrier's system. */
    private fun tetraOf(c: Carrier): Sys? {
        val s = systems[c.sys] ?: return null
        if (s.proto != "TETRA") return null
        if (s.tetra == null) s.tetra = TetraSys()
        return s
    }
    /** What the TETRA MAC read on a carrier (EN 300 392-2 clauses 14, 16, 18, 21). */
    private fun tetraEvent(c: Carrier, e: TetraEvent) {
        val s = tetraOf(c) ?: return
        val t = s.tetra!!; val now = now()
        fun log(name: String, text: String) = addLog(LogRow(now, c.hz, "TETRA", name, "TETRA · $text", "", true))
        when (e) {
            is TetraEvent.Sysinfo -> {
                val i = e.info; c.tetraCell = i; c.lastDecodeMs = now; c.blocks++; c.crcOk++; blocks++
                t.aie = i.services.aie; if (i.security != null) t.sec = i.security
                val mhz = if (i.mainHz > 0) " (${"%.5f".format(java.util.Locale.US, i.mainHz / 1e6)} MHz)" else ""
                val sec = i.security?.let { " · security class ${if (it.class3) 3 else 2}${if (it.auth) " · authentication required" else ""}" } ?: ""
                log("SYSINFO", "SYSINFO · LA ${i.la} · main carrier ${i.mainCarrier}$mhz · ${if (i.services.aie) "air interface encryption available" else "no air interface encryption"}$sec · " +
                    "${if (i.services.voice) "voice service" else "no voice service"}${if (i.services.registration) " · registration required" else ""}")
            }
            is TetraEvent.Access -> log("ACCESS-DEFINE", e.text)
            is TetraEvent.Encrypted -> { t.encSdus++; c.blocks++; blocks++; log("ENCRYPTED", "TS${e.mac.tn} · signalling encrypted on the air interface (encryption mode ${e.mac.enc})") }
            is TetraEvent.Alloc -> if (e.mac.chan != null) log("CHANNEL ALLOCATION", "TS${e.mac.tn} · SSI ${e.mac.ssi}${if (e.mac.um >= 0) " · usage marker ${e.mac.um}" else ""} · ${tetraChanText(c, e.mac)}")
            is TetraEvent.Mm -> {
                t.clearSdus++; c.blocks++; c.crcOk++; blocks++
                if (e.type == 5 && e.mac.ssi > 0) tetraUnit(s.key, e.mac.ssi, c, now, "registration", e.name)
                log(e.name, "TS${e.mac.tn} · ${e.name}${if (e.mac.ssi >= 0) " · SSI ${e.mac.ssi}" else ""}")
            }
            is TetraEvent.Other -> log(e.name, "TS${e.mac.tn} · ${e.name}${if (e.mac.ssi >= 0) " · SSI ${e.mac.ssi}" else ""}")
            is TetraEvent.Cmce -> { t.clearSdus++; c.blocks++; c.crcOk++; blocks++; tetraCmce(c, s, e.pdu, e.mac, now) }
            is TetraEvent.Voice -> tetraVoice(c, s, e.tn, e.frames, now)
            is TetraEvent.Aach -> {
                // a traffic slot of a cell whose signalling is encrypted on the air interface, with no call read for it: an
                // encrypted call (the cell's broadcast and the MAC headers both say so)
                if (e.usage >= 4 && t.aie && t.encSdus > 0) {
                    val k = calls.at(s.key, c.hz, e.tn - 1)
                    if (k == null) { val call = calls.voice(s.key, "TETRA", c.hz, e.tn - 1, 0, now); calls.security(call, SecIn(true, "AIE")) }
                    else if (k.sec == "enc") calls.voice(s.key, "TETRA", c.hz, e.tn - 1, 0, now)
                }
                return
            }
        }
        pending = true
    }
    /**
     * A channel allocation to a frequency and slot: the cell's band and offset unless it gives its own, placed relative
     * to the cell's main carrier as received.
     */
    private fun tetraChanHz(c: Carrier, a: TetraChanAlloc): Pair<Long, Int> {
        val cell = c.tetraCell ?: carriers.values.firstOrNull { it.sys == c.sys && it.tetraCell != null }?.tetraCell
        var hz = 0.0
        if (a.band > 0) hz = tetraCarrierHz(a.carrier, a.band, a.offset)
        else if (cell != null && cell.band > 0) hz = tetraCarrierHz(a.carrier, cell.band, cell.offset)
        val main = if (cell != null) carriers.values.firstOrNull { it.sys == c.sys && it.tetraCell != null && abs(it.hz - cell.mainHz) < 15_000 } else null
        if (cell != null && main != null && hz > 0) hz = main.hz + (hz - cell.mainHz)
        else if (hz == 0.0 && cell != null && a.carrier == cell.mainCarrier) hz = c.hz.toDouble()
        val r = Math.round(hz)
        if (r > 0) tetraOf(c)?.tetra?.carriers?.set(a.carrier, r)
        return r to max(0, a.tn - 1)
    }
    private fun tetraChanText(c: Carrier, mac: TetraMacInfo): String {
        val a = mac.chan ?: return ""
        if (a.tn == 0) return "to the control channel"
        val (hz, _) = tetraChanHz(c, a)
        return "carrier ${a.carrier}${if (hz > 0) " (${"%.5f".format(java.util.Locale.US, hz / 1e6)} MHz)" else ""} TS${a.tn}${if (a.updown == 1) " downlink" else if (a.updown == 2) " uplink" else ""}"
    }
    /** TETRA call control (14.7.1): set-up, connect, transmission grants and the end of a call build the call. */
    private fun tetraCmce(c: Carrier, s: Sys, p: TetraCmce, mac: TetraMacInfo, now: Long) {
        val t = s.tetra!!
        var call = if (p.callId >= 0) t.calls[p.callId] else null
        val at = mac.chan?.let { if (it.tn > 0) tetraChanHz(c, it) else null }
        fun who() = call?.let { " · ${if (it.group) "TG" else "UNIT"} ${it.tg}" } ?: ""
        val text = StringBuilder("TS${mac.tn} · ${p.name}${if (p.callId >= 0) " · call ${p.callId}" else ""}")
        var grant = false
        when (p.type) {
            7 -> {   // D-SETUP: sent to the called group (or unit), naming the calling unit
                val group = (p.basic?.comm ?: 1) != 0
                val nc = TetraCall(mac.ssi, group, if (p.calling > 0) p.calling else 0, at?.first ?: call?.hz ?: 0L, at?.second ?: call?.slot ?: 0, p.basic?.e2ee == true, now)
                call = nc
                if (p.callId >= 0) t.calls[p.callId] = nc
                val kind = if (p.basic != null && p.basic!!.mode != 0) " · circuit mode ${p.basic!!.mode}" else " speech"
                text.append(" · ${if (group) "TG" else "UNIT"} ${mac.ssi}${if (nc.src != 0) " ← ${nc.src}" else ""} · ${tetraCommName(p.basic?.comm ?: 1)}$kind${if (p.basic?.e2ee == true) " · END-TO-END ENCRYPTED" else ""} · priority ${p.prio}")
                grant = true
            }
            2, 14 -> {   // D-CONNECT (to the calling unit), D-CALL RESTORE
                val k = call
                if (k != null && at != null) { k.hz = at.first; k.slot = at.second }
                if (k != null && p.basic != null) k.e2ee = p.basic!!.e2ee
                if (k != null && p.newCallId >= 0) { t.calls.remove(p.callId); t.calls[p.newCallId] = k; text.append(" · now call ${p.newCallId}") }
                if (k != null && p.type == 2 && mac.ssi > 0 && k.src == 0) k.src = mac.ssi
                text.append(who())
                grant = k != null
            }
            11, 13 -> {   // D-TX GRANTED, D-TX INTERRUPT: who talks now
                val k = call
                if (k != null && p.talker > 0 && (p.grant == 0 || p.grant == 3)) k.src = p.talker
                if (k != null && at != null) { k.hz = at.first; k.slot = at.second }
                if (k != null && p.encCtl == 1) k.e2ee = true
                text.append("${who()} · ${tetraGrantName(p.grant)}${if (p.talker > 0) " · talker ${p.talker}" else ""}${if (p.encCtl == 1) " · END-TO-END ENCRYPTED" else ""}")
                grant = k != null && (p.grant == 0 || p.grant == 3)
            }
            9 -> text.append("${who()} · transmission ceased")
            4, 6 -> {   // D-DISCONNECT, D-RELEASE
                text.append("${who()} · ${tetraDisconnectCause(p.cause)}")
                val k = call
                if (k != null && p.type == 6) { if (k.hz != 0L) calls.terminate(s.key, k.hz, k.slot, now); t.calls.remove(p.callId) }
            }
            8, 15 -> {   // D-STATUS, D-SDS-DATA
                val x = p.sds
                if (x != null) {
                    val body = when (x.kind) { "text" -> "\"${x.text}\""; "status" -> "status ${x.status}"; else -> "${x.kind} ${x.hex}" }
                    text.append(" · ${if (x.from > 0) "${x.from} → " else ""}${mac.ssi} · $body")
                    val what = "${when (x.kind) { "text" -> "SDS text"; "status" -> "status"; else -> "SDS" }} $body"
                    if (x.from > 0) tetraUnit(s.key, x.from, c, now, "$what to ${mac.ssi}", text.toString())
                    if (mac.ssi > 0) tetraUnit(s.key, mac.ssi, c, now, "$what${if (x.from > 0) " from ${x.from}" else ""}", text.toString())
                }
            }
            else -> text.append(who())
        }
        val k = call
        if (k != null && grant) {
            if (k.src != 0) tetraUnit(s.key, k.src, c, now, "call", text.toString(), if (k.group) k.tg else null)
            val ch = if (at != null) "carrier ${mac.chan!!.carrier} TS${mac.chan.tn}" else "call ${p.callId}"
            if (k.tg != 0 || k.hz != 0L) grant(s.key, GrantRow(now, now, s.key, if (k.group) "grant" else "u2u", k.tg, k.group, k.src, ch, k.hz, k.slot, false, false, k.e2ee, c.hz, ""), p.type != 7)
        }
        if (at != null) text.append(" · ${tetraChanText(c, mac)}")
        addLog(LogRow(now, c.hz, "TETRA", p.name, "TETRA · $text", "", true))
    }
    /** Speech of a traffic slot: the call on that carrier and slot takes it (one the air named, or a new one that waits). */
    private fun tetraVoice(c: Carrier, s: Sys, tn: Int, frames: List<IntArray>, now: Long) {
        c.lastDecodeMs = now; c.frames++; if (c.role != "control") c.role = "voice"
        // the call on this signal and slot, where the grant put it (the receiver may sit on a piece of the same signal)
        val near = calls.calls.firstOrNull { it.kind == "call" && it.onAir && it.proto == "TETRA" && it.sys == s.key && it.slot == tn - 1 && abs(it.hz - c.hz) <= 13_000 }
        val call = calls.voice(s.key, "TETRA", near?.hz ?: c.hz, tn - 1, 30L * frames.count { it.isNotEmpty() }, now)
        calls.frames(call, frames)
    }
    /** A TETRA unit heard: what it did, with the group when there is one. */
    private fun tetraUnit(sys: String, id: Int, c: Carrier, now: Long, kind: String, text: String, group: Int? = null) {
        val key = "$sys/$id"
        val u = units.getOrPut(key) { UnitRec(key, sys, id, now, now) }
        u.lastMs = now; u.carriers.add(c.key)
        if (group != null) { u.groups.add(group); u.tgCounts[group] = (u.tgCounts[group] ?: 0) + 1; tgFor(sys, group, now).members.add(id) }
        if (kind == "call") u.grants++
        u.reports.add(Report(now, c.hz, kind, "", true, text, c.levelDb))
        if (u.reports.size > 60) u.reports.removeAt(0)
        pending = true
    }
    /** What a TETRA system's cells broadcast and its MAC headers say about air interface encryption. */
    private fun tetraSecurity(s: Sys): String {
        val heard = carriers.values.any { it.sys == s.key && it.tetraCell != null }
        val t = s.tetra ?: return if (heard) "CLEAR AIR INTERFACE" else ""
        val cls = t.sec?.let { " · SECURITY CLASS ${if (it.class3) 3 else 2}" } ?: ""
        if (t.aie && t.encSdus > 0) return "AIR INTERFACE ENCRYPTED$cls"
        if (t.aie) return "AIR INTERFACE ENCRYPTION AVAILABLE$cls"
        return if (heard) "CLEAR AIR INTERFACE" else ""
    }
    /** The scrambling seeds a Phase 2 channel may use: its own system first, then every P25 system and site heard. */
    private fun p2Seeds(c: Carrier): List<P2Seed> {
        val out = ArrayList<P2Seed>()
        fun add(s: Sys, nac: Int) { if (nac >= 0 && s.wacn >= 0 && s.sysId >= 0 && out.none { it.sys == s.key && it.nac == nac }) out.add(P2Seed(s.wacn, s.sysId, nac, s.key)) }
        fun nacs(s: Sys) = sites.values.filter { it.sys == s.key }.map { it.nac }
        val own = systems[c.sys]
        if (own != null && own.proto == "P25") for (n in nacs(own)) add(own, n)
        for (s in systems.values) if (s.proto == "P25") for (n in nacs(s)) add(s, n)
        return out
    }
    /** A Phase 2 MAC PDU (BBAC 8): push to talk names the call and its encryption, end of push to talk ends it. */
    private fun p2Mac(c: Carrier, m: P2Mac) {
        val now = now(); val op = MAC_OPS[m.opcode] ?: "MAC ${m.opcode}"; val sys = c.sys; val lch = m.lch
        val text = StringBuilder("$op · TS${lch + 1}")
        if (m.opcode == 1) {
            val p = p2Ptt(m.bytes)
            val call = calls.lc(sys, c.hz, lch, LcIn(true, p.group, p.src, false, false), now, "P25", true)
            calls.security(call, SecIn(p.algId != 0x80, "MAC", p.algId, p.keyId, p.mi))
            text.append(" · TG ${p.group}${if (p.src != 0) " ← ${p.src}" else ""} · ALGID ${hx(p.algId, 2)} · KEY ${hx(p.keyId, 4)}${if (p.algId != 0x80) " · MI ${p.mi.uppercase()}" else ""}")
        } else if (m.opcode == 2) {
            val e = p2EndPtt(m.bytes)
            calls.terminate(sys, c.hz, lch, now)
            text.append(" · TG ${e.group}${if (e.src != 0 && e.src != 0xffffff) " ← ${e.src}" else ""} · NAC ${hx(e.nac, 3)}")
        } else {
            for (x in p2Messages(m.bytes)) {
                val b = x.bytes
                if (x.b == 0 && x.mco == 1 && b.size >= 7) {
                    // a group voice channel user: who is on this logical channel (while it is active)
                    val so = b[1]; val group = (b[2] shl 8) or b[3]; val src = (b[4] shl 16) or (b[5] shl 8) or b[6]
                    if (m.opcode == 4) {
                        val call = calls.lc(sys, c.hz, lch, LcIn(true, group, src, (so and 0x80) != 0, false), now, "P25", true)
                        if ((so and 0x40) != 0) calls.security(call, SecIn(true, "grant"))
                    }
                    text.append(" · ${x.name} TG $group${if (src != 0) " ← $src" else ""}${if ((so and 0x80) != 0) " · EMERGENCY" else ""}${if ((so and 0x40) != 0) " · PROTECTED" else ""}")
                } else if (x.b == 1 && b.size >= 9) {
                    // a Phase 1 broadcast in its abbreviated form: the trunking block parser reads it
                    val blk = IntArray(12); blk[0] = x.mco; for (i in 1 until 9) blk[i + 1] = b[i]
                    val t = Tsbks.parse(blk)
                    val s = systems[sys]
                    if (s != null && (t.kind == "update" || t.kind == "grant")) p25Apply(c, t, s, now)
                    text.append(" · ${Tsbks.line(t)}")
                } else text.append(" · ${x.name}")
            }
        }
        addLog(LogRow(now, c.hz, "P25", op, "PHASE 2 · $text", Codes.hex(m.bytes), true))
        pending = true
    }
    // ------------------------------------------------------------------------------------------------ Motorola Type II
    private val oswParsers = HashMap<Long, OswParser>()
    /**
     * A signaling word that passed its check. A carrier becomes a Type II control channel on its third word, with at
     * least half the frames since its first passing: a chance pass on noise never makes one.
     */
    private fun oswWord(c: Carrier, ch: Chan, o: Osw, gap: Int) {
        val now = now(); val rx = ch.osw
        if (c.cls != "MOTOROLA TYPE II") {
            if (rx.good < 3 || rx.good < 0.5 * rx.expected) return
            c.cls = "MOTOROLA TYPE II"; c.role = "control"
        }
        c.frames++; c.blocks = rx.expected; c.crcOk = rx.good; c.lastDecodeMs = now; blocks++
        val p = oswParsers.getOrPut(c.key) { OswParser() }
        val ev = if (gap > 1) p.lost() else ArrayList()
        ev.addAll(p.push(o))
        for (e in ev) oswEvent(c, e, now)
    }
    private fun oswSys(id: Int, now: Long): Sys {
        val key = "SMARTNET ${hx(id, 4)}"
        val s = systems.getOrPut(key) { Sys(key, "SMARTNET", colorNext++, -1, id, -1, -1, -1, "", now, now, false) }
        s.trunk = "TYPE II"
        if (s.osw == null) s.osw = OswSys()
        s.lastMs = now
        return s
    }
    private fun oswEvent(c: Carrier, e: OswEvent, now: Long) {
        val hexw = SmartNet.hex(e.words)
        fun log(name: String, text: String) = addLog(LogRow(now, c.hz, "TYPE II", name, text, hexw, true))
        if (e.kind == "sysid") {
            val s = oswSys(e.sys, now); c.sys = s.key; s.heardHz.add(c.key)
            val plan = SmartNet.provePlan(e.cc, c.hz)
            c.osw = OswCc(e.cc, plan)
            if (plan != null && s.osw!!.plan == null) s.osw!!.plan = plan
            log("SYSTEM ID", "SYSTEM ${hx(e.sys, 4)} · CONTROL CHANNEL ${e.cc}${if (plan != null) " · ${plan.label}" else " · no channel plan puts that number on this frequency"}")
            pending = true
            return
        }
        val s = if (c.sys.isNotEmpty()) systems[c.sys] else null
        if (e.kind == "grant" || e.kind == "update") {
            val tg = if (e.group) SmartNet.tgOf(e.tg) else e.tg; val st = if (e.group) SmartNet.tgStatus(e.tg) else 0
            val who = "${if (e.group) "TG" else "UNIT"} $tg${if (st != 0) " · STATUS $st" else ""}${if (e.kind == "grant") " ← ${e.src}" else ""}"
            val name = if (e.kind == "grant") "GRANT" else "UPDATE"
            val so = s?.osw
            if (s == null || so == null) { log(name, "$who · CH ${e.ch} · system ID not heard yet"); return }
            s.lastMs = now
            val plan = so.plan; val hz = plan?.hz?.invoke(e.ch) ?: 0L
            so.chans[e.ch] = (so.chans[e.ch] ?: 0) + 1
            val site = oswSiteLabel(c)
            grant(s.key, GrantRow(now, now, s.key, if (e.kind == "grant") "grant" else "update", tg, e.group, if (e.kind == "grant") e.src else 0, "CH ${e.ch}", hz, 0, false, false, false, c.hz, site, e.ch), e.kind == "update")
            if (e.kind == "grant") touchUnit(s.key, e.src, c, now, "grant", NxdnUnitMsg(hexw, "GRANT $who · CH ${e.ch}"), site, if (e.group) tg else null)
            log(name, "$who · CH ${e.ch}${if (hz != 0L) " · ${"%.4f".format(java.util.Locale.US, hz / 1e6)} MHz" else ""}")
            return
        }
        if (e.kind == "idle") return
        log("OSW ${e.words.joinToString("+") { hx(it.cmd, 3) }}", "not read · ${e.words.joinToString(" / ") { SmartNet.wordText(it) }}")
    }
    private fun oswSiteLabel(c: Carrier): String { val o = c.osw; return if (o != null) "channel ${o.cc}" else "${"%.4f".format(java.util.Locale.US, c.hz / 1e6)} MHz" }
    /** A Type II voice channel: analog FM voice to the call on the air there. */
    private fun fmOn(c: Carrier, ch: Chan) {
        if (ch.fm != null) return
        val f = FmVoice(ch.fs); ch.fm = f
        f.onPcm = { pcm, open -> val call = calls.at("", c.hz, 0); if (call != null && call.proto == "SMARTNET") { calls.analog(call, pcm, open); if (open) pending = true } }
    }
    private fun oswSites(s: Sys): List<SiteRow> {
        val cs = carriers.values.filter { it.sys == s.key && it.cls == "MOTOROLA TYPE II" }
        val plan = s.osw?.plan
        val lcns = if (plan != null) (s.osw?.chans?.keys ?: emptySet()).sorted().map { Lcn(it, plan.hz(it), 0) } else emptyList()
        return cs.map { c ->
            val o = c.osw
            SiteRow("${s.key}/${c.key}", oswSiteLabel(c), -1, o?.cc ?: -1, -1, listOf(c.hz), c.lastMs, c.levelDb, emptyList(), emptyList(),
                if (o != null) (o.plan?.label ?: "channel plan not proved") else "", c.callsign, listOf(c.key), lcns, -1, emptyList(), emptyList(), 0, -1, -1)
        }
    }
    private fun classify(c: Carrier, ch: Chan, now: Long) {
        if (c.tdma && ch.p2 == null) p2On(c, ch)
        val quiet = !(c.lastDecodeMs > 0 && now - c.lastDecodeMs < 15_000)
        if (!c.tdma && ch.tetra == null && c.cls != "TETRA" && now - ch.openedMs > 1_500 && quiet && tetraBand(c.hz)) tetraOn(c, ch)
        if (!c.tdma && ch.nxdn == null && c.cls != "TETRA" && now - ch.openedMs > 1_500 && quiet) nxdnOn(c, ch)
        c.heardMs += 500; c.envCv = Math.round(ch.rx.envCv * 100) / 100.0; c.eye = Math.round(ch.rx.eye * 100) / 100.0
        if (c.lastDecodeMs > 0 && now - c.lastDecodeMs < 15_000) return
        if (now - ch.openedMs < CLASS_MS) return
        c.cls = when {
            c.tdma && ch.rx.envCv > 0.15 -> "P25 PHASE 2 TDMA"
            ch.rx.eye > 1.3 && ch.rx.envCv < 0.15 -> "UNKNOWN 4FSK"
            ch.rx.envCv > 0.18 -> "UNKNOWN LINEAR"
            else -> "ANALOG FM"
        }
        nxdnSeen[c.key]?.let { (ms, baud) -> if (now - ms < 5_000) c.cls = if (baud == 2400) "NXDN48" else "NXDN96" }
    }

    // ------------------------------------------------------------------------------------------------ P25
    private fun p25Frame(c: Carrier, nac: Int, duid: Int) {
        val now = now()
        c.frames++; c.nac = nac; c.lastDecodeMs = now; p25Seen[c.key] = now
        c.cls = if (c.envCv > 0.2) "P25 CQPSK/LSM" else "P25 C4FM"
        if (duid == 7) c.role = "control"
        else if (duid == 0xc) { if (c.role != "control") c.role = "data" }
        else if (c.role != "control") c.role = "voice"
        if (duid != 7) pending = true
        if (c.role == "voice") {
            // header, voice frames (nine vocoder frames each), terminators
            if (duid == 0 || duid == 5 || duid == 10) calls.voice(c.sys, "P25", c.hz, 0, if (duid == 0) 0L else 180L, now)
            else if (duid == 3 || duid == 15) calls.terminate(c.sys, c.hz, 0, now)
        }
    }
    private fun p25Block(c: Carrier, b: P25Block) {
        val now = now()
        // voice channels carry no trunking blocks: one that fails its CRC there is noise that looked like a frame
        if (!b.crcOk && c.role == "voice") return
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
        val s = systems[key] ?: newSys(key, "P25", c.p25Wacn, c.p25Sys, -1, -1, -1, "", now)
        s.lastMs = now; c.sys = key; if (t.kind != "iden") s.heardHz.add(c.key)
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
                        val vc = carriers[gridKey(r.hz)]
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
        // a mobile's burst (MS sync) carries no CACH: no slot is read from it
        val ts = if (b.ms) "FROM A RADIO" else "TS${b.slot + 1}"
        // an NXDN carrier's 2400 or 4800 symbols can pass for a DMR burst now and then
        if (nxdnLately(c, now)) return
        if (b.dt > 10) return
        if (c.tdma || now - (p2Seen[c.key] ?: Long.MIN_VALUE / 2) < 5_000) return
        // nor are a P25 carrier's, as for the voice bursts below
        if (now - (p25Seen[c.key] ?: Long.MIN_VALUE / 2) < 2_000) return
        if (!dmrProven(c, b, now)) return
        c.frames++; if (b.stErrs == 0 || c.cc < 0) c.cc = b.cc; c.cls = "DMR"; c.lastDecodeMs = now; dmrSeen[c.key] = now
        if (b.dt == 1 || b.dt == 2) {
            if (c.role != "control" && c.role != "rest") c.role = "voice"
            pending = true
            val lc = parseLc(b.bytes, b.dt)
            if (lc != null && lc.ok) {
                // a terminator labels the call it ends; on its own it is no call
                if (b.dt == 1 || calls.onAirAt(c.sys, c.hz, b.slot)) {
                    if (b.dt == 1) learnLpcn(c, b.slot, lc, now)
                    val call = calls.lc(c.sys, c.hz, b.slot, LcIn(lc.group, lc.dst, lc.src, lc.emergency, lc.privacy), now)
                    if (call.sys.isNotEmpty() && c.sys.isEmpty()) c.sys = call.sys
                }
                if (b.dt == 2) calls.terminate(c.sys, c.hz, b.slot, now)
                val name = if (b.dt == 1) "VOICE LC HEADER" else "TERMINATOR WITH LC"
                addLog(LogRow(now, c.hz, "DMR", name, "CC ${b.cc} · $ts · $name · ${if (lc.group) "TG" else "UNIT"} ${lc.dst} ← ${lc.src}${if (lc.emergency) " · EMERGENCY" else ""}${if (lc.privacy) " · PRIVACY" else ""}", Codes.hex(b.bytes), true))
            } else if (b.dt == 2) calls.terminate(c.sys, c.hz, b.slot, now)
            return
        }
        if (b.dt == 9) return
        val mask = Codes.DMR_CRC_MASK[b.dt]
        val ok = mask != null && Codes.crc12Ok(b.bytes, mask)
        // a privacy indicator header (it follows the voice LC header of an encrypted call): the call it opens is encrypted.
        // Its fields (not in ETSI TS 102 361; read from public descriptions): algorithm ID in octet 0, key ID in octet 2,
        // a 32-bit MI in octets 3 to 6
        if (b.dt == 0 && ok) { val y = b.bytes; calls.securityAt(c.sys, c.hz, b.slot, SecIn(true, "PI", y[0], y[2], Codes.hex(y, 3, 7), Codes.hex(y, 0, 10))); pending = true }
        // as on P25: a block failing its CRC on a voice channel is noise that looked like a burst
        if (!ok && c.role == "voice" && b.dt != 3) return
        if (!ok && c.role == "voice" && b.dt == 3 && !(b.bytes[1] == 0x10 && ((b.bytes[0] and 0x3f) == 0x09 || (b.bytes[0] and 0x3f) == 0x3d))) return
        c.blocks++; blocks++
        if (ok) c.crcOk++
        if (b.dt == 3) {
            val op = b.bytes[0] and 0x3f
            val isVendor = !ok && b.bytes[1] == 0x10 && (op == 0x09 || op == 0x3d)
            val vok = isVendor && vendor.check(b.bytes, "${b.cc}")
            if (vok) c.crcOk++
            val cs = Csbks.parse(b.bytes, ok || vok)
            // the unit-report families are kept when their check fails (shown unverified); anything else has to pass its CRC
            if (!ok && !vok && !(cs.derived && (cs.kind == "unitrpt" || cs.kind == "unithdr" || cs.kind == "callann"))) return
            // radios heard directly (inbound or talkaround) are not a control channel
            if (c.role == "" || c.role == "voice") c.role = if (b.ms) "data" else "control"
            val s = dmrSystem(c, cs, b.cc, now)
            dmrApply(c, cs, b.slot, s, now)
            addLog(LogRow(now, c.hz, "DMR", cs.name, "CC ${b.cc} · $ts · ${Csbks.line(cs)}", cs.hex, ok || vok))
        } else if (ok || b.dt == 7) {
            if (b.dt == 6 || b.dt == 7) { if (c.role == "") c.role = "data" }
            val name = DATA_TYPES[b.dt]
            val hex = Codes.hex(b.bytes)
            addLog(LogRow(now, c.hz, "DMR", name, "CC ${b.cc} · $ts · $name${if (ok) "" else " · no block CRC"} · $hex", hex, ok))
        }
    }
    /**
     * One IMBE frame out of a P25 voice frame. Until a grant or the link control says what the call is, its frames wait
     * in the call (the LDU1 that names it arrives after its own nine frames).
     */
    private fun p25Voice(c: Carrier, bits: IntArray, ch: Chan?) {
        val call = calls.at(c.sys, c.hz, 0) ?: return
        calls.frames(call, listOf(bits)); ch?.voiced(2)
    }
    /** Erasures for voice that did not come when due ([Chan.onFill]): only for a call on the air, never making one. */
    private fun fill(c: Carrier, lane: Int, n: Int) {
        val call = calls.at(c.sys, c.hz, if (lane == 2) 0 else lane) ?: return
        if (!call.onAir || call.proto != (if (lane == 2) "P25" else "DMR") || call.tdma) return
        calls.frames(call, List(n) { IntArray(0) })
    }
    /** Link control read out of an LDU1 (talkgroup or unit, source, encryption) labels the call on that channel. */
    private fun p25Lc(c: Carrier, ch: Chan) {
        val st = ch.p25v.status(ch.t); val fresh = st.errs == ch.lcErrs
        ch.lcErrs = st.errs
        if (st.duid != 5 || !fresh || (st.lcf != 0 && st.lcf != 3) || (st.talkgroup == 0 && st.source == 0) || !calls.onAirAt(c.sys, c.hz, 0)) return
        calls.lc(c.sys, c.hz, 0, LcIn(st.lcf == 0, st.talkgroup, st.source, st.emergency, st.encrypted), now(), "P25")
    }
    /** The encryption sync of an LDU2, or a call header: algorithm, key, message indicator. 0x80 is in the clear. */
    private fun p25Sec(c: Carrier, from: String, algId: Int, keyId: Int, mi: String) {
        val now = now(); val clear = algId == 0x80
        val call = calls.securityAt(c.sys, c.hz, 0, SecIn(!clear, from, algId, keyId, mi))
        if (call != null) pending = true
        val name = if (from == "HDU") "HEADER" else "ENCRYPTION SYNC"
        addLog(LogRow(now, c.hz, "P25", name, "NAC ${hx(max(0, c.nac), 3)} · $name · ALGID ${hx(algId, 2)} · KEY ${hx(keyId, 4)} · MI ${mi.uppercase()}", "", true))
    }
    /** A DMR voice burst: keeps its call on the air and hands its three vocoder frames on. */
    private fun dmrVoice(c: Carrier, ch: Chan?, slot: Int, d: IntArray, n: Int = 0) {
        val now = now(); val never = Long.MIN_VALUE / 2
        // a P25 channel's voice frames can look like a DMR voice sync now and then
        if (now - (p25Seen[c.key] ?: never) < 2_000) return
        if (nxdnLately(c, now)) return
        // a P25 Phase 2 channel (a grant said TDMA, or its syncs were heard) is never read as DMR
        if (c.tdma || now - (p2Seen[c.key] ?: never) < 5_000) return
        // nor is a carrier next to one (a Phase 2 signal the carrier finder split, or its neighbor 12.5 kHz away)
        for (x in carriers.values) if (x !== c && abs(x.hz - c.hz) <= 13_000 && (x.tdma || now - (p2Seen[x.key] ?: never) < 5_000)) return
        // the receiver's own DC spike at the center of the span, and bursts of one repeated symbol (a bare carrier),
        // are not DMR: an all-zero EMB passes any linear code
        if (ch != null && !ch.baseband && abs(c.hz - centerHz) < 2_000) return
        run { val k = IntArray(4); for (v in d) k[v and 3]++; if (k.max() > 0.7 * d.size) return }
        val data = now - (dmrSeen[c.key] ?: never) <= 3_000
        if (!data && ch?.dmr?.voiceLive != true) return
        // with no DMR data burst heard lately, the voice alone has to prove itself: two EMBs that pass their (16,7) check
        // with the same color code within a second (a Phase 2 superframe also repeats every 360 ms)
        if (!data && calls.at(c.sys, c.hz, slot) == null) {
            if (n == 0) return
            val e = readEmb(d); if (!e.ok) return
            val v = embVotes[c.key]
            if (v == null || v.first != e.cc || now - v.second > 1_000) { embVotes[c.key] = e.cc to now; return }
        }
        c.lastDecodeMs = now; c.cls = "DMR"; c.frames++
        if (c.role == "") c.role = "voice"
        val call = calls.voice(c.sys, "DMR", c.hz, slot, 60, now)
        // bursts B to F carry the EMB: its privacy bit says whether the call is encrypted, read before the frames play
        if (n > 0) {
            val e = readEmb(d)
            if (e.ok && (c.cc < 0 || e.cc == c.cc)) {
                calls.security(call, SecIn(e.pi, "EMB"))
                // bursts B to E also carry the embedded LC in four fragments: who is talking to whom, the privacy bit, the alias
                val k = "${c.key}:$slot"; val asm = embAsm.getOrPut(k) { EmbLcAssembler() }
                val lc = if (n <= 4) asm.push(e.lcss, embBits(d)) else { asm.reset(); null }
                when (val p = lc?.let { parseEmbLc(it) }) {
                    is EmbLc.Voice -> embLc(c, slot, p.lc, now)
                    is EmbLc.Alias -> embAlias(c, slot, p.part, p.bytes)
                    null -> {}
                }
            }
        }
        calls.frames(call, voiceFrames(d)); ch?.voiced(slot)
        pending = true
    }
    /** Embedded LC fragments and talker aliases being put together, per carrier and slot. */
    private val embAsm = HashMap<String, EmbLcAssembler>(); private val aliases = HashMap<String, TalkerAlias>()
    private val embSeen = HashMap<String, Long>(); private val unitAlias = HashMap<String, String>()
    /** An embedded voice LC: the call on that slot is named (talkgroup, unit) and its privacy bit taken, as from a header. */
    private fun embLc(c: Carrier, slot: Int, lc: DmrLc, now: Long) {
        if (lc.dst == 0 && lc.src == 0) return
        val call = calls.lc(c.sys, c.hz, slot, LcIn(lc.group, lc.dst, lc.src, lc.emergency, lc.privacy), now, "DMR")
        if (call.sys.isNotEmpty() && c.sys.isEmpty()) c.sys = call.sys
        val k = "${c.key}:$slot:${lc.dst}:${lc.src}:${lc.privacy}"; val seen = embSeen[k]
        if (seen == null || now - seen > 10_000) {
            embSeen[k] = now; if (embSeen.size > 500) embSeen.clear()
            addLog(LogRow(now, c.hz, "DMR", "EMBEDDED LC", "CC ${c.cc} · TS${slot + 1} · EMBEDDED LC · ${if (lc.group) "TG" else "UNIT"} ${lc.dst} ← ${lc.src}${if (lc.fid == 0x10) " · FID 10" else ""}" +
                "${if (lc.emergency) " · EMERGENCY" else ""}${if (lc.privacy) " · PRIVACY" else ""}", "", true))
        }
        pending = true
    }
    /** A talker alias part: once the name is whole it labels the call and its unit. */
    private fun embAlias(c: Carrier, slot: Int, part: Int, bytes: IntArray) {
        val ta = aliases.getOrPut("${c.key}:$slot") { TalkerAlias() }
        val name = ta.push(part, bytes); if (name.isEmpty()) return
        val call = calls.at(c.sys, c.hz, slot) ?: return
        if (call.alias != name) { call.alias = name; pending = true }
        if (call.src != 0) { val uk = "${call.sys.ifEmpty { c.sys }}/${call.src}"; unitAlias[uk] = name; units[uk]?.alias = name }
        addLog(LogRow(now(), c.hz, "DMR", "TALKER ALIAS", "TS${slot + 1} · TALKER ALIAS · $name${if (call.src != 0) " · UNIT ${call.src}" else ""}", "", true))
    }
    private fun dmrSystem(c: Carrier, cs: Csbk, cc: Int, now: Long): Sys {
        var key = c.dmrSys
        if (cs.verified && cs.sysCode != null) key = "DMR ${cs.model} ${cs.net}"
        else if (key.isEmpty()) key = "DMR CC$cc FID ${hx(cs.fid, 2)}"
        c.dmrSys = key; c.sys = key
        val s = systems[key] ?: newSys(key, "DMR", -1, -1, cc, cs.fid, cs.net ?: -1, cs.model ?: "", now, cs.derived)
        s.lastMs = now; s.cc = cc; s.heardHz.add(c.key); if (cs.derived) s.derived = true
        return s
    }
    private fun dmrApply(c: Carrier, cs: Csbk, slot: Int, s: Sys, now: Long) {
        when (cs.kind) {
            "beacon" -> {
                s.trunk = "CAPACITY PLUS"
                s.rest = cs.rest ?: -1; s.busy = cs.busy ?: emptyList()
                // a unit exchange on this carrier just now and one logical channel busy: that channel is this carrier's slot
                val hd = c.hdr
                if (s.busy.size == 1 && hd != null && now - hd.ms < 1_000) lcnVote(s, s.busy[0], c.hz, hd.slot)
                c.lcn = s.lcns.filter { it.value.first == c.hz }.keys.joinToString("/")
                for (k in carriers.values) if (k.sys == s.key) {
                    val mine = s.lcns.filter { it.value.first == k.hz }.keys
                    k.role = if (s.rest in mine) "rest" else if (k.role == "rest") "control" else k.role
                }
                cs.unit?.let { touchUnit(s.key, it, c, now, "busy channel", cs, "") }
            }
            "unithdr" -> cs.unit?.let { c.hdr = Hdr(now, slot); touchUnit(s.key, it, c, now, "unit report header", cs, "") }
            "unitrpt" -> if (cs.unit != null) unitReport(s, c, cs, now)
            "grant" -> {
                if (cs.verified && cs.fid == 0) s.trunk = "TIER III"
                val dst = cs.dst ?: return
                val lp = cs.lpcn ?: -1; val hz = s.lpcnHz[lp] ?: 0L
                pendingGrants = ArrayList(pendingGrants.filter { now - it.ms < 3_000 })
                pendingGrants.add(PendingGrant(s.key, dst, cs.group == true, lp, cs.slot ?: 0, now))
                grant(s.key, GrantRow(now, now, s.key, if (cs.group == true) "grant" else "u2u", dst, cs.group == true, cs.src ?: 0, "LPCN $lp", hz, cs.slot ?: 0,
                    false, cs.emergency == true, false, c.hz, "", lp, hz > 0), false)
                cs.src?.let { if (it != 0) touchUnit(s.key, it, c, now, "grant", cs, "", if (cs.group == true) dst else null) }
            }
            "ack", "unit", "aloha", "callann" -> {
                if (cs.kind == "aloha" && cs.verified) s.trunk = "TIER III"
                val id = if (cs.kind == "callann") cs.unit else cs.dst
                if (id != null && id != 0 && id < 0xfffff0) touchUnit(s.key, id, c, now, if (cs.kind == "ack") "acknowledged" else cs.name.lowercase(), cs, "")
            }
        }
    }
    /**
     * A voice LC header on [c]: a DMR grant of the last two seconds to the same talkgroup and slot says which logical
     * channel this carrier is. Each logical channel takes the carrier it got at least two votes and two thirds of
     * (worked out from what the channels carry, not from a channel plan on the air).
     */
    private fun learnLpcn(c: Carrier, slot: Int, lc: DmrLc, now: Long) {
        val i = pendingGrants.indexOfFirst { now - it.ms < 2_000 && it.lpcn >= 0 && it.tg == lc.dst && it.group == lc.group && it.slot == slot && (c.sys.isEmpty() || c.sys == it.sys) }
        if (i < 0) return
        val g = pendingGrants.removeAt(i)
        val s = systems[g.sys] ?: return
        val v = s.lpcnVotes.getOrPut(g.lpcn) { LinkedHashMap() }; val k = c.hz
        v[k] = (v[k] ?: 0) + 1
        var best = 0L; var n = 0; var all = 0
        for ((hz, m) in v) { all += m; if (m > n) { n = m; best = hz } }
        if (n >= 2 && n * 3 >= all * 2) {
            s.lpcnHz.entries.removeIf { it.value == best && it.key != g.lpcn }
            if (s.lpcnHz[g.lpcn] != best) { s.lpcnHz[g.lpcn] = best; pending = true }
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
        val fx = u.fixes.lastOrNull()
        if (fx == null || fx.lat16 != latLo || fx.lon16 != lonLo) { u.fixes.add(Fix(now, latLo, lonLo)); if (u.fixes.size > 300) u.fixes.removeAt(0) }
        anchorsDirty = true
        val p = place(s.key, latLo, lonLo)
        if (last != null && p != null) { last.lat = p.first; last.lon = p.second }
    }
    private fun cwText(c: Carrier, text: String) {
        val word = text.split(' ').firstOrNull { looksLikeCallsign(it) }
        addLog(LogRow(now(), c.hz, "CW", "CW ID", "CW ID · $text", "", word != null))
        if (word != null) { val now = now(); c.callsign = word; c.callsignMs = now; calls.cwId(c.sys, c.hz, word, now); pending = true }
    }

    // ------------------------------------------------------------------------------------------------ tables
    private fun touchUnit(sys: String, id: Int, c: Carrier, now: Long, kind: String, msg: Any, site: String, group: Int? = null): UnitRec {
        val key = "$sys/$id"
        val u = units.getOrPut(key) { UnitRec(key, sys, id, now, now) }
        u.lastMs = now; u.carriers.add(c.key)
        if (group != null) { u.groups.add(group); u.tgCounts[group] = (u.tgCounts[group] ?: 0) + 1; tgFor(sys, group, now).members.add(id) }
        if (kind == "grant" || kind == "u2u" || kind == "datagrant") u.grants++
        val cs = msg as? Csbk; val ts = msg as? Tsbk; val nx = msg as? NxdnUnitMsg
        val text = if (nx != null) nx.line else if (cs != null) Csbks.line(cs) else Tsbks.line(ts!!)
        u.reports.add(Report(now, c.hz, kind + if (site.isNotEmpty()) " · site $site" else "", nx?.hex ?: cs?.hex ?: ts!!.hex, cs?.verified ?: true, text, c.levelDb))
        if (u.reports.size > 60) u.reports.removeAt(0)
        pending = true
        return u
    }
    private fun tgFor(sys: String, tg: Int, now: Long): Tg { val key = "$sys/$tg"; return tgs.getOrPut(key) { Tg(key, sys, tg, now, now) } }
    /** A grant, or an update of one already on the feed (the same talkgroup on the same channel within 5 s). */
    private fun grant(sys: String, g: GrantRow, update: Boolean, efr: Boolean = false) {
        if (g.kind != "datagrant") {
            val p25 = sys.startsWith("P25"); val tetra = sys.startsWith("TETRA"); val nxdn = sys.startsWith("NXDN"); val sn = sys.startsWith("SMARTNET")
            val call = calls.grant(GrantIn(sys, if (p25) "P25" else if (tetra) "TETRA" else if (nxdn) "NXDN" else if (sn) "SMARTNET" else "DMR", g.tg, g.group, g.src, g.hz, if (p25) (if (g.tdma) g.slot else 0) else g.slot, g.tdma, g.encrypted, g.emergency,
                g.site, g.lpcn, g.chDerived, efr), g.ms)
            // a voice channel inside the span is listened to from the grant on, not from the next channel assignment
            if (call != null && call.onAir && !call.muted && call.hz != 0L && rate > 0 && inSpan(call.hz)) {
                val vc = carrierAt(call.hz.toDouble()); if (vc.role.isEmpty()) vc.role = "voice"; if (vc.sys.isEmpty()) vc.sys = sys
                if (!chans.containsKey(vc.key)) { vc.lastAuditionMs = g.ms; open(vc, g.ms); vc.decoding = true }
                val ch = chans[vc.key]
                if (tetra && ch != null && ch.tetra == null) tetraOn(vc, ch)
                // an NXDN voice channel is read from its first frame, at the system's symbol rate
                if (nxdn && ch != null && ch.nxdn == null) nxdnOn(vc, ch, systems[sys]?.nxdnBaud ?: 0)
                // a Type II voice channel carries analog FM
                if (sn && ch != null) fmOn(vc, ch)
            } else if (sn && call != null && call.onAir && call.hz != 0L) {
                // a recorded channel fed as its own baseband
                val vc = carriers[gridKey(call.hz)]; val ch = vc?.let { chans[it.key] }
                if (vc != null && ch != null) { if (vc.role.isEmpty()) vc.role = "voice"; if (vc.sys.isEmpty()) vc.sys = sys; fmOn(vc, ch) }
            }
        }
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
    /** The log lines kept (for tests and the export). */
    @Synchronized fun logRows(): List<LogRow> = logRows.toList()

    // ------------------------------------------------------------------------------------------------ output
    private fun resolvePos(u: UnitRec): Pair<Double?, Double?> {
        val f = u.fix
        if (u.lonLo < 0 && f != null) {
            // a position kept from an earlier session: shown only where the system's radios can be (an older build drew
            // some reports in the wrong place)
            return if (keptOk(u.sys, f)) f.first to f.second else null to null
        }
        if (u.lonLo < 0) return null to null
        val p = place(u.sys, u.latLo, u.lonLo) ?: return null to null
        return p.first to p.second
    }
    private fun keptOk(sys: String, f: Pair<Double, Double>): Boolean {
        val a = anchorFor(sys); val r = a ?: ref ?: return true
        return kmBetween(f.first, f.second, r.first, r.second) <= (if (a != null) PLACE_KM else PLACE_RX_KM)
    }
    /**
     * DMR unit reports carry only the low 16 bits of each coordinate (about 5.6 degrees a cycle), so each report has a
     * twin every 5.6 degrees and is resolved to the one nearest a reference. The reference is the system's own area
     * once three or more of its units agree on it (the median of their positions, at least three within 40 km of it):
     * units of one system cluster around its sites. A report that lands farther than [PLACE_KM] from that area (or
     * [PLACE_RX_KM] from the receiver, before the system has an area) is not a place the system's radios can be: it is
     * left off the map rather than drawn in the ocean, and counted.
     */
    private fun place(sys: String, lat16: Int, lon16: Int): Pair<Double, Double>? {
        if (ref == null) return null
        val a = anchorFor(sys); val r = a ?: ref!!
        val lat = round6(Csbks.unwrap16(lat16, r.first)); val lon = round6(Csbks.unwrap16(lon16, r.second))
        return if (kmBetween(lat, lon, r.first, r.second) <= (if (a != null) PLACE_KM else PLACE_RX_KM)) lat to lon else null
    }
    private val anchors = HashMap<String, Pair<Double, Double>?>(); private var anchorsDirty = true
    private fun anchorFor(sys: String): Pair<Double, Double>? {
        if (anchorsDirty) { anchors.clear(); anchorsDirty = false }
        if (anchors.containsKey(sys)) return anchors[sys]
        var out: Pair<Double, Double>? = null
        val r = ref
        if (r != null) {
            val pts = ArrayList<Pair<Double, Double>>()
            for (u in units.values) if (u.sys == sys && u.lonLo >= 0) pts.add(Csbks.unwrap16(u.latLo, r.first) to Csbks.unwrap16(u.lonLo, r.second))
            if (pts.size >= 3) {
                fun med(v: List<Double>): Double { val x = v.sorted(); return x[x.size shr 1] }
                val m = med(pts.map { it.first }) to med(pts.map { it.second })
                if (pts.count { kmBetween(it.first, it.second, m.first, m.second) <= 40 } >= 3) out = m
            }
        }
        anchors[sys] = out
        return out
    }
    /** A unit's track: every position report placed (in order, repeats folded), and how many could not be placed. */
    private fun trailOf(u: UnitRec): Pair<List<TrailPt>, Int> {
        if (u.fixes.isEmpty()) {
            // a track kept from an earlier session: the same check as its position
            val f = u.fix
            return if (f != null && !keptOk(u.sys, f)) emptyList<TrailPt>() to 1 else u.trail.toList() to 0
        }
        val trail = ArrayList<TrailPt>(); var off = 0
        for (x in u.fixes) {
            val p = place(u.sys, x.lat16, x.lon16)
            if (p == null) { off++; continue }
            val l = trail.lastOrNull()
            if (l == null || l.lat != p.first || l.lon != p.second) trail.add(TrailPt(p.first, p.second, x.ms))
        }
        return trail to off
    }
    /**
     * Where each call on the air is heard from: the talking unit's last position, else the latest position of any unit
     * in the talkgroup. The call keeps the last one placed while it was on the air.
     */
    private fun placeCalls() {
        if (ref == null) return
        for (c in calls.calls) {
            if (!c.onAir || c.kind != "call") continue
            callPos(c)?.let { calls.place(c, it) }
        }
    }
    private fun callPos(c: Call): CallPos? {
        fun at(u: UnitRec?, via: String): CallPos? {
            if (u == null || u.lonLo < 0) return null
            val (lat, lon) = resolvePos(u)
            return if (lat == null || lon == null) null else CallPos(lat, lon, u.id, u.posMs, via, u.posVerified)
        }
        fun unitOf(id: Int): UnitRec? {
            if (id == 0) return null
            if (c.sys.isNotEmpty()) return units["${c.sys}/$id"] ?: (if (id > 0xffff) units["${c.sys}/${id and 0xffff}"] else null)
            var found: UnitRec? = null
            for (u in units.values) if (u.id == id && u.lonLo >= 0) { if (found != null) return null; found = u }
            return found
        }
        at(unitOf(c.src), "unit")?.let { return it }
        if (!c.group || c.tg == 0) return null
        // a call on a channel no control channel has named yet: the talkgroup, when only one system has it
        val t = if (c.sys.isNotEmpty()) tgs["${c.sys}/${c.tg}"] else tgs.values.filter { it.tg == c.tg }.let { if (it.size == 1) it[0] else null }
        var best: CallPos? = null
        for (m in t?.members ?: emptySet()) { val p = at(unitOf(m), "talkgroup"); if (p != null && (best == null || p.ms > best.ms)) best = p }
        return best
    }
    /**
     * What the device keeps between sessions: every system heard (where, and what it was) and every unit position
     * decoded. [restore] puts it back; positions from the air replace the kept ones as they come.
     */
    @Synchronized fun known(): KnownState {
        val ss = systems.values.map { s -> KnownSystem(s.key, s.proto, s.wacn, s.sysId, s.cc, s.fid, s.net, s.model, s.firstMs, s.lastMs, s.derived, s.heardHz.take(12)) }
        val us = ArrayList<KnownUnit>()
        for (u in units.values) { val (lat, lon) = resolvePos(u); if (lat != null && lon != null) us.add(KnownUnit(u.sys, u.id, lat, lon, u.posMs, u.posVerified, u.firstMs, u.lastMs)) }
        us.sortByDescending { it.posMs }
        return KnownState(1, ss, us.take(KNOWN_UNITS))
    }
    @Synchronized fun restore(k: KnownState?) {
        if (k == null || k.v != 1) return
        for (x in k.systems) {
            val s = systems[x.key] ?: Sys(x.key, x.proto, colorNext++, x.wacn, x.sysId, x.cc, x.fid, x.net, x.model, x.firstMs, x.lastMs, x.derived).also { systems[x.key] = it }
            s.heardHz.addAll(x.hz)
        }
        for (x in k.units) {
            val key = "${x.sys}/${x.id}"
            val u = units.getOrPut(key) { UnitRec(key, x.sys, x.id, x.firstMs, x.lastMs).also { it.posMs = x.posMs; it.posVerified = x.verified; it.trail.add(TrailPt(x.lat, x.lon, x.posMs)) } }
            if (u.lonLo < 0 && x.posMs >= u.posMs) { u.fix = x.lat to x.lon; u.posMs = x.posMs; u.posVerified = x.verified }
        }
        post(true)
    }
    /** The receiver's position arrived or moved: every stored report is resolved against it again. */
    @Synchronized fun setRef(lat: Double, lon: Double) {
        ref = lat to lon; anchorsDirty = true
        for (u in units.values) {
            if (u.lonLo < 0) continue
            for (r in u.reports) { val a = r.latLo; val o = r.lonLo; if (a != null && o != null) { val p = place(u.sys, a, o); r.lat = p?.first; r.lon = p?.second } }
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
            val lcns = s.lcns.filter { (_, v) -> gridKey(v.first) in keys || g.any { it.hz == v.first } }.map { (l, v) -> Lcn(l, v.first, v.second) }.sortedBy { it.lcn }
            val ids = HashSet<Int>(); for (c in g) ids.addAll(c.unitIds.keys)
            SiteRow("${s.key}/$n", call.ifEmpty { if (s.net >= 0) "site ${s.net}" else "site $n" }, -1, n, -1, g.map { it.hz }.sorted(), g.maxOf { it.lastMs }, g.maxOf { it.levelDb },
                emptyList(), emptyList(), "", call, g.map { it.key }, lcns, s.rest, s.busy, emptyList(), ids.size, -1, -1)
        }
    }
    private fun buildSnapshot(): FleetSnap {
        val now = now()
        placeCalls()
        val unitSite = HashMap<String, String>()
        val sysRows = systems.values.map { s ->
            val siteRows: List<SiteRow> = when (s.proto) {
                "P25" -> sites.values.filter { it.sys == s.key }.map { x ->
                    val tables = LinkedHashMap(s.idens); tables.putAll(x.idens)
                    val ccs = x.carriers.mapNotNull { carriers[it] }
                    SiteRow(x.key, "${x.rfss}.${x.site}", x.rfss, x.site, x.nac, ccs.map { it.hz }, x.lastMs, ccs.maxOfOrNull { it.levelDb } ?: Double.NEGATIVE_INFINITY,
                        x.neighbors.values.map { nb -> val r = Tsbks.resolve(nb.ch, tables); Neighbor("${nb.rfss}.${nb.site}", r?.hz ?: 0L, hx(nb.ch, 4), nb.sys,
                            sites.values.any { o -> o.sys == s.key && o.rfss == nb.rfss && o.site == nb.site }) }.sortedBy { it.hz },
                        x.secondary.map { ch -> (Tsbks.resolve(ch, tables)?.hz ?: 0L) to hx(ch, 4) }, x.time, ccs.firstOrNull { it.callsign.isNotEmpty() }?.callsign ?: "",
                        x.carriers.toList(), emptyList(), -1, emptyList(), tables.values.sortedBy { it.iden }, 0, x.lra, x.cls)
                }
                "TETRA" -> {
                    // one site per cell (color code): its control carriers, and the traffic carriers heard or allocated
                    val cells = LinkedHashMap<Int, ArrayList<Carrier>>()
                    for (c in carriers.values) if (c.sys == s.key && (c.tetra != null || c.tetraCell != null)) cells.getOrPut(c.tetra?.colorCode ?: c.cc) { ArrayList() }.add(c)
                    cells.map { (cc, cs) ->
                        val info = cs.firstOrNull { it.tetraCell != null }?.tetraCell
                        val sy = (cs.firstOrNull { it.tetra != null && it.role == "control" } ?: cs.firstOrNull { it.tetra != null })?.tetra
                        val ctrl = cs.filter { it.role != "voice" }; val traffic = LinkedHashMap<Long, String>()
                        for (c in cs) if (c.role == "voice") traffic[c.hz] = ""
                        for ((n, hz) in s.tetra?.carriers ?: emptyMap<Int, Long>()) if (traffic.keys.none { abs(it - hz) < 3_200 } && ctrl.none { abs(it.hz - hz) < 3_200 }) traffic[hz] = "carrier $n"
                        val unitIds = units.values.filter { u -> u.sys == s.key && cs.any { it.key in u.carriers } }.map { it.id }.toSet()
                        SiteRow("${s.key}/$cc", if (info != null) "cell LA ${info.la}" else "color code $cc", -1, cc, -1, ctrl.map { it.hz }, cs.maxOf { it.lastMs }, cs.maxOf { it.levelDb },
                            emptyList(), traffic.entries.sortedBy { it.key }.map { it.key to it.value }, if (sy != null) "TS${sy.timeslot} · frame ${sy.frame} · multiframe ${sy.multiframe}" else "", "",
                            cs.map { it.key }, emptyList(), -1, emptyList(), emptyList(), unitIds.size, info?.la ?: -1, sy?.cellLoad ?: -1)
                    }
                }
                "NXDN" -> nxdnSites(s)
                "SMARTNET" -> oswSites(s)
                else -> dmrSites(s)
            }
            for (st in siteRows) for (k in st.carriers) for (u in units.values) if (u.sys == s.key && k in u.carriers) unitSite[u.key] = st.label
            val label = when {
                s.proto == "SMARTNET" -> "MOTOROLA TYPE II · SYSTEM ${hx(s.sysId, 4)}"
                s.proto == "NXDN" && s.trunk == "CONVENTIONAL" -> "NXDN · CONVENTIONAL · RAN ${s.sysId}"
                s.proto == "NXDN" && s.trunk == "TYPE-D" -> "NXDN · TYPE-D · SITE ${s.sysId}"
                s.proto == "NXDN" -> "NXDN · ${s.model} SYSTEM ${s.sysId}"
                s.proto == "TETRA" -> "TETRA · MCC ${s.wacn} · MNC ${s.sysId}"
                s.proto == "P25" -> "WACN ${hx(s.wacn, 5)} · SYSTEM ${hx(s.sysId, 3)}"
                s.net >= 0 -> "${s.model} NETWORK ${s.net}"
                s.trunk == "CAPACITY PLUS" -> "CAPACITY PLUS · COLOR CODE ${s.cc}"
                else -> "COLOR CODE ${s.cc}${if (s.fid > 0) " · FID ${hx(s.fid, 2)}" else ""}"
            }
            val plan = s.nxdnPlan
            val lpcns = if (plan != null) plan.heard.map { (ch, hz) -> LpcnRow(ch, hz, plan.votes[ch]?.get(hz) ?: 0) }.sortedBy { it.lpcn }
                else s.lpcnHz.map { (lpcn, hz) -> LpcnRow(lpcn, hz, s.lpcnVotes[lpcn]?.get(hz) ?: 0) }.sortedBy { it.lpcn }
            var cwId = ""; var cwIdMs = 0L; var cwIdHz = 0L
            for (c in carriers.values) if (c.sys == s.key && c.callsignMs != 0L && c.callsignMs > cwIdMs) { cwId = c.callsign; cwIdMs = c.callsignMs; cwIdHz = c.hz }
            SystemRow(s.key, s.proto, s.color, label, s.wacn, s.sysId, s.cc, s.fid, s.net, s.model, siteRows.firstOrNull { it.callsign.isNotEmpty() }?.callsign ?: "",
                s.firstMs, s.lastMs, siteRows, s.idens.values.sortedBy { it.iden }, grants.count { it.sys == s.key }, units.values.count { it.sys == s.key },
                tgs.values.count { it.sys == s.key }, s.derived || lpcns.isNotEmpty(), s.trunk, cwId, cwIdMs, cwIdHz, lpcns, s.heardHz.take(12),
                units.values.any { it.sys == s.key && (it.lonLo >= 0 || it.fix != null) }, if (s.proto == "TETRA") tetraSecurity(s) else "")
        }.sortedBy { it.firstMs }
        val unitRows = units.values.map { u ->
            val (lat, lon) = resolvePos(u); val (tr, off) = trailOf(u)
            UnitRow(u.key, u.sys, u.id, u.firstMs, u.lastMs, lat, lon, u.posMs, u.posVerified, tr.takeLast(12), u.groups.toList(), u.grants, u.carriers.toList(),
                u.reports.takeLast(6).map { it.row() }, unitSite[u.key] ?: "", u.tgCounts.entries.sortedByDescending { it.value }.map { it.key to it.value }, off, u.fixes.size,
                u.alias.ifEmpty { unitAlias[u.key] ?: "" })
        }
        val tgRows = tgs.values.map { t -> TgRow(t.key, t.sys, t.tg, t.firstMs, t.lastMs, t.grants, t.recent.filter { now - it < 600_000 }, t.members.take(200), t.history.take(12).map { it.copy() }) }
        val carrierRows = carriers.values.map { it.row() }.sortedBy { it.hz }
        return FleetSnap(centerHz, rate, spanLo, spanHi, carrierRows, sysRows, unitRows, tgRows, grants.take(120).map { it.copy() },
            grants.count { now - it.ms < 60_000 }, blocks, chans.size, ref != null, calls.rows(), followTarget(),
            listOf(CodecIds.IMBE, CodecIds.AMBE2, CodecIds.TETRA).filter { hasCodec(it) } + CodecIds.FM, calls.playing, calls.prefs.lock)
    }
    @Synchronized fun snapshot(): FleetSnap = buildSnapshot()
    /** The call a one-channel receiver should go to, outside the span: only one there is something to hear on. */
    private fun followTarget(): Follow? {
        val c = calls.followTarget({ inSpan(it) }, { x -> (hasCodec(x.codec) || x.codec == CodecIds.FM) && !x.encrypted && !x.protectedHint && x.sec != "unknown" }) ?: return null
        return Follow(c.key, c.hz)
    }
    @Synchronized fun setPrefs(p: TgPrefs) { calls.setPrefs(p); post(true) }
    @Synchronized fun callAudio(key: String): FloatArray? = calls.audioOf(key)
    /** A carrier at [hz] as if found in the span (recorded blocks are replayed through it). */
    private fun carrierAt(hz: Double): Carrier {
        val key = gridKey(hz)
        carriers[key]?.let { return it }
        // a carrier off the 6.25 kHz grid sits near the boundary of two keys: the one already heard within 1.5 kHz is it
        carriers.values.firstOrNull { abs(it.hz - hz) < 1_500 }?.let { return it }
        return Carrier(key, Math.round(hz), now()).also { carriers[key] = it }
    }
    /** Marks the carrier at [hz] as a Phase 2 TDMA channel of [sys] (what a grant would say; for recorded channels). */
    @Synchronized fun markTdma(hz: Long, sys: String = "") { val c = carrierAt(hz.toDouble()); c.tdma = true; if (sys.isNotEmpty()) c.sys = sys; chans[c.key]?.let { p2On(c, it) } }
    /** The Phase 2 receiver's counters on [hz], if one runs there. */
    @Synchronized fun p2StatsAt(hz: Long): P2Stats? = chans[gridKey(hz)]?.p2?.stats
    /** Test access: a carrier at [hz] set as if heard and decoded at [ms] (the channel budget tests). Returns its key. */
    @Synchronized internal fun testCarrier(hz: Long, ms: Long, role: String, levelDb: Double, sys: String, unitIds: Map<Int, Long> = emptyMap()): Long {
        val c = carrierAt(hz.toDouble()); c.lastMs = ms; c.lastDecodeMs = ms; c.role = role; c.levelDb = levelDb; c.sys = sys; c.unitIds.putAll(unitIds); return c.key
    }
    /** Test access: every carrier heard and decoded again at [ms]. */
    @Synchronized internal fun testTouchAll(ms: Long) { for (c in carriers.values) { c.lastMs = ms; c.lastDecodeMs = ms } }
    /** Test access: the key of the carrier at [hz] (made as if found in the span). */
    @Synchronized internal fun testCarrierKey(hz: Long): Long = carrierAt(hz.toDouble()).key
    /** Test access: sets what the finder and the decoders would leave on a carrier (null leaves a field as it is). */
    @Synchronized internal fun testSet(key: Long, levelDb: Double? = null, lastMs: Long? = null, role: String? = null, sys: String? = null, cls: String? = null,
                                       lastDecodeMs: Long? = null, p25Site: Int? = null) {
        val c = carriers[key] ?: return
        levelDb?.let { c.levelDb = it }; lastMs?.let { c.lastMs = it }; role?.let { c.role = it }; sys?.let { c.sys = it }; cls?.let { c.cls = it }
        lastDecodeMs?.let { c.lastDecodeMs = it }; p25Site?.let { c.p25Rfss = 1; c.p25Site = it }
    }
    /** Test access: a carrier's level, class, whether it has a channel, and when its last turn began. */
    internal data class TestState(val levelDb: Double, val cls: String, val decoding: Boolean, val lastAuditionMs: Long, val hz: Long)
    @Synchronized internal fun testState(key: Long): TestState? = carriers[key]?.let { TestState(it.levelDb, it.cls, it.decoding, it.lastAuditionMs, it.hz) }
    /** Test access: a grant as the control channel would add it. */
    @Synchronized internal fun testAddGrant(g: GrantRow) { grants.add(0, g); if (grants.size > 300) grants.subList(300, grants.size).clear() }
    /** Test access: one channel assignment pass now. */
    @Synchronized internal fun testAssign(now: Long) = assign(now)
    /** Test access: the carriers that have a channel decoding them. */
    @Synchronized internal fun openChannels(): Set<Long> = chans.keys.toSet()
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
    /** One recorded DMR voice burst (144 dibits) heard on [hz]: [n] is its place in the superframe (0 has the sync). */
    @Synchronized fun feedDmrVoice(hz: Long, slot: Int, dibits: IntArray, n: Int) { val c = carrierAt(hz.toDouble()); dmrSeen[c.key] = now(); dmrVoice(c, null, slot, dibits, n) }
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
        ch.tetraBaseband(zi, zq, n)
    }
    /** Starts the TETRA receiver on a carrier now (the recorded and synthesized channels in the tests). */
    @Synchronized fun tetraNow(hz: Long) { val c = carrierAt(hz.toDouble()); chans[c.key]?.let { tetraOn(c, it) } }
    /** Starts the NXDN receivers on a carrier now (the synthesized channels in the tests). */
    @Synchronized fun nxdnNow(hz: Long) { val c = carrierAt(hz.toDouble()); val ch = chans[c.key]; if (ch != null && ch.nxdn == null) nxdnOn(c, ch) }
    /** The end of a recording: the samples still waiting for a whole timing block are decoded too. */
    @Synchronized fun flush() { for (ch in chans.values) { ch.rx.flush(); ch.nxdn?.forEach { it.flush() } } }
    /** A CW ID read on [hz]. */
    @Synchronized fun feedCw(hz: Long, text: String) { cwText(carrierAt(hz.toDouble()), text) }
    /** Everything held about one unit, for its detail view. */
    @Synchronized fun unitDetail(key: String): UnitDetail? {
        val u = units[key] ?: return null
        val (tr, off) = trailOf(u)
        return UnitDetail(key, u.reports.map { it.row() }, tr, off)
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
                .put("trail", JSONArray(trailOf(u).first.map { JSONArray(listOf(it.lat, it.lon, it.ms)) }))
                .put("reports", JSONArray(u.reports.map { r -> reportJson(r.row()).also { j -> r.lonLo?.let { j.put("lonLo", it) }; r.latLo?.let { j.put("latLo", it) } } }))
        }))
        return csv.toString() to o.toString(1)
    }
    private fun idenJson(i: Iden) = JSONObject().put("iden", i.iden).put("base", i.base).put("spacing", i.spacing).put("txOffset", i.txOffset).put("bw", i.bw).put("tdma", i.tdma)
        .put("slots", i.slots).put("form", i.form).put("raw", i.raw)
    private fun grantJson(g: GrantRow) = JSONObject().put("ms", g.ms).put("lastMs", g.lastMs).put("sys", g.sys).put("kind", g.kind).put("tg", g.tg).put("group", g.group)
        .put("src", g.src).put("ch", g.ch).put("hz", g.hz).put("slot", g.slot).put("tdma", g.tdma).put("emergency", g.emergency).put("encrypted", g.encrypted)
        .put("carrierHz", g.carrierHz).put("site", g.site).also { j -> g.lpcn?.let { j.put("lpcn", it) }; g.chDerived?.let { j.put("chDerived", it) } }
    private fun reportJson(r: UnitReport) = JSONObject().put("ms", r.ms).put("hz", r.hz).put("kind", r.kind).put("hex", r.hex).put("verified", r.verified)
        .put("lat", r.lat ?: JSONObject.NULL).put("lon", r.lon ?: JSONObject.NULL).put("text", r.text)
    private fun carrierJson(c: CarrierRow) = JSONObject().put("key", c.key).put("hz", c.hz).put("levelDb", c.levelDb).put("peakDb", c.peakDb).put("firstMs", c.firstMs)
        .put("lastMs", c.lastMs).put("onMs", c.onMs).put("heardMs", c.heardMs).put("cls", c.cls).put("role", c.role).put("sys", c.sys).put("nac", c.nac).put("cc", c.cc)
        .put("frames", c.frames).put("blocks", c.blocks).put("crcOk", c.crcOk).put("lastDecodeMs", c.lastDecodeMs).put("envCv", c.envCv).put("eye", c.eye)
        .put("decoding", c.decoding).put("callsign", c.callsign).put("callsignMs", c.callsignMs).put("tdma", c.tdma).put("lcn", c.lcn)
    private fun siteJson(x: SiteRow) = JSONObject().put("key", x.key).put("label", x.label).put("rfss", x.rfss).put("site", x.site).put("nac", x.nac).put("ccHz", JSONArray(x.ccHz))
        .put("lastMs", x.lastMs).put("levelDb", if (x.levelDb.isFinite()) x.levelDb else JSONObject.NULL)
        .put("neighbors", JSONArray(x.neighbors.map { JSONObject().put("label", it.label).put("hz", it.hz).put("ch", it.ch).put("sys", it.sys).put("heard", it.heard) }))
        .put("secondary", JSONArray(x.secondary.map { JSONObject().put("hz", it.first).put("ch", it.second) })).put("time", x.time).put("callsign", x.callsign)
        .put("carriers", JSONArray(x.carriers)).put("lcns", JSONArray(x.lcns.map { JSONObject().put("lcn", it.lcn).put("hz", it.hz).put("slot", it.slot) }))
        .put("rest", x.rest).put("busy", JSONArray(x.busy)).put("idens", JSONArray(x.idens.map { idenJson(it) })).put("units", x.units).put("lra", x.lra).put("cls", x.cls)
    private fun sysJson(s: SystemRow) = JSONObject().put("key", s.key).put("proto", s.proto).put("color", s.color).put("label", s.label).put("trunk", s.trunk).put("wacn", s.wacn).put("sysId", s.sysId)
        .put("cc", s.cc).put("fid", s.fid).put("net", s.net).put("model", s.model).put("callsign", s.callsign).put("cwId", s.cwId).put("cwIdMs", s.cwIdMs).put("cwIdHz", s.cwIdHz)
        .put("firstMs", s.firstMs).put("lastMs", s.lastMs)
        .put("sites", JSONArray(s.sites.map { siteJson(it) })).put("idens", JSONArray(s.idens.map { idenJson(it) })).put("grants", s.grants).put("units", s.units)
        .put("tgs", s.tgs).put("derived", s.derived).put("lpcns", JSONArray(s.lpcns.map { JSONObject().put("lpcn", it.lpcn).put("hz", it.hz).put("votes", it.votes) }))
        .put("heardHz", JSONArray(s.heardHz)).put("positions", s.positions)

    private fun post(force: Boolean = false) {
        val t = now()
        if (!force && t - lastPost < 500) { pending = true; return }
        pending = false; lastPost = t
        _snap.value = buildSnapshot()
    }
    @Synchronized fun clear() {
        carriers.clear(); systems.clear(); sites.clear(); units.clear(); anchorsDirty = true; embAsm.clear(); aliases.clear(); unitAlias.clear(); tgs.clear(); grants = ArrayList(); logRows.clear(); logSeen.clear()
        chans.clear(); bbFir.clear(); blocks = 0; colorNext = 0; calls.clear(); pendingGrants = ArrayList(); nxdnPending = ArrayList(); oswParsers.clear()
        post(true)
    }

    companion object {
        private val CLOCK = ThreadLocal.withInitial { java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US) }
        private val ISO = ThreadLocal.withInitial { java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") } }

        /** The bands Dispatch scans: id, label, low and high edge (Hz). */
        val BANDS = listOf(
            Band("VHF", "VHF 150–174", 150_000_000L, 174_000_000L), Band("TETRA", "TETRA 380–430", 380_000_000L, 430_000_000L), Band("UHF", "UHF 450–470", 450_000_000L, 470_000_000L),
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
