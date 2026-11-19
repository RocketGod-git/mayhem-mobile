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
 * Dispatch: a receive-only monitor for P25, DMR, TETRA and NXDN trunked radio. Finds every carrier in the span, gives the
 * live ones a channel each (the control channels and the channels of calls on the air keep theirs, the rest take
 * turns), decodes the control signaling and builds the systems, sites, channel tables, grants, registrations, unit
 * positions and calls from what is on the air. Labels are only what the air carries. Publishes a snapshot (at most two
 * a second) and log lines. Internal names and saved keys stay "fleet" so saved data carries over.
 */
const val CH_RATE = 24_000.0
private const val CUT_HZ = 5_500.0
private const val AUDITION_MS = 3_000L
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
)
data class UnitReport(val ms: Long, val hz: Long, val kind: String, val hex: String, val verified: Boolean, val lat: Double?, val lon: Double?, val text: String)
data class TrailPt(val lat: Double, val lon: Double, val ms: Long)
data class UnitRow(
    val key: String, val sys: String, val id: Int, val firstMs: Long, val lastMs: Long, val lat: Double?, val lon: Double?, val posMs: Long,
    val posVerified: Boolean, val trail: List<TrailPt>, val groups: List<Int>, val grants: Int, val carriers: List<Long>, val reports: List<UnitReport>, val site: String,
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
data class UnitDetail(val key: String, val reports: List<UnitReport>, val trail: List<TrailPt>)

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
    var p25Sys = -1; var p25Wacn = -1; var p25Rfss = -1; var p25Site = -1
    var dmrSys = ""; val tables = LinkedHashMap<Int, Iden>(); val unitIds = LinkedHashMap<Int, Long>()
    var tetra: TetraSync? = null; var nxdn: NxdnSite? = null; var nxdnBaud = 0
    fun row() = CarrierRow(key, hz, levelDb, peakDb, firstMs, lastMs, onMs, heardMs, cls, role, sys, nac, cc, frames, blocks, crcOk, lastDecodeMs, envCv, eye,
        decoding, callsign, tdma, lcn, callsignMs)
}
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
}
private class Report(val ms: Long, val hz: Long, val kind: String, val hex: String, val verified: Boolean, val text: String) {
    var lat: Double? = null; var lon: Double? = null; var lonLo: Int? = null; var latLo: Int? = null
    fun row() = UnitReport(ms, hz, kind, hex, verified, lat, lon, text)
}
private class UnitRec(val key: String, val sys: String, val id: Int, val firstMs: Long, var lastMs: Long) {
    var lonLo = -1; var latLo = -1; var posMs = 0L; var posVerified = false; val trail = ArrayList<TrailPt>(); val groups = LinkedHashSet<Int>(); var grants = 0
    val carriers = LinkedHashSet<Long>(); val reports = ArrayList<Report>()
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
private fun round6(x: Double): Double = Math.round(x * 1e6) / 1e6

private class TetraChan(val rx: TetraRx, val ddc: Ddc?) { var oi = FloatArray(0); var oq = FloatArray(0) }

/** [baseband]: samples arrive already mixed to 0 Hz at that rate (a recorded channel clip), no down-converter. */
private class Chan(val key: Long, var hz: Double, center: Long, rate: Int, now: Long, baseband: Double = 0.0) {
    val ddc = Ddc(CUT_HZ, CH_RATE, 127)
    val rx: SymbolRx
    val p25 = P25Framer()
    val p25v = P25Decoder()
    /** Symbols so far, the P25 voice decoder's clock; [lcErrs] its failure count at the last link control read. */
    var t = 0L; var lcErrs = 0
    val dmr = DmrFramer()
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
    fun retarget(center: Long) { ddc.offsetHz = hz - center; this.center = center; tetra?.ddc?.offsetHz = tetraHz - center }
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
        p2?.push(zi, zq, m)
        nxdn?.let { for (r in it) r.push(zi, zq, m) }
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
    /** DMR grants of the last moments, waiting for the voice link control that says which carrier their channel is. */
    private var pendingGrants = ArrayList<PendingGrant>()
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
        fun core(c: Carrier) = (c.role == "control" || c.role == "rest" || reportsOn(c, now)) && (lock.isEmpty() || c.sys.isEmpty() || c.sys == lock)
        val want = ArrayList(live.filter { keep(it) }.sortedWith(compareByDescending<Carrier> { core(it) }.thenByDescending { it.levelDb }))
        val nCore = want.count { core(it) }
        for (c in pinned.reversed()) { val i = want.indexOf(c); if (i >= 0) want.removeAt(i); want.add(min(nCore, want.size), c) }
        for ((k, ch) in chans) { val c = carriers[k]!!; if (!keep(c) && now - ch.openedMs < AUDITION_MS && c !in want) want.add(c) }
        val rest = live.filter { it !in want }.sortedWith(compareBy<Carrier> { it.lastAuditionMs }.thenByDescending { it.levelDb })
        for (c in rest) { if (want.size >= budget) break; want.add(c) }
        val chosen = want.take(budget).map { it.key }.toSet()
        chans.keys.retainAll(chosen)
        for (k in chosen) if (!chans.containsKey(k)) { val c = carriers[k]!!; c.lastAuditionMs = now; open(c, now) }
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
        ch.p25v.onLog = { p25Lc(c, ch) }
        ch.p25v.onEs = { es -> p25Sec(c, "LDU2", es.algId, es.keyId, es.mi) }
        ch.p25v.onHdu = { hd -> p25Sec(c, "HDU", hd.algId, hd.keyId, hd.mi) }
        ch.cw.onText = { t -> cwText(c, t) }
        if (c.tdma) p2On(c, ch)
        chans[c.key] = ch
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
    private fun nxdnOn(c: Carrier, ch: Chan) {
        val rs = ArrayList<NxdnRx>()
        for (baud in intArrayOf(2400, 4800)) {
            val r = NxdnRx(ch.fs, baud)
            r.framer.onSite = { x -> if ((ch.nxdn?.size ?: 0) > 1) ch.nxdn = listOf(r); nxdnSite(c, x, baud) }
            rs.add(r)
        }
        ch.nxdn = rs
    }
    private fun newSys(key: String, proto: String, wacn: Int, sysId: Int, cc: Int, fid: Int, net: Int, model: String, now: Long, derived: Boolean = false): Sys =
        Sys(key, proto, colorNext++, wacn, sysId, cc, fid, net, model, now, now, derived).also { systems[key] = it }
    /** NXDN SITE_INFO (TS 1-A 6.4.3.1): the Location ID names the system and site, and the control channels. */
    private fun nxdnSite(c: Carrier, x: NxdnSite, baud: Int) {
        val now = now(); val cat = NXDN_CATEGORY[x.category]; val key = "NXDN $cat-${x.system}"
        val s = systems[key] ?: newSys(key, "NXDN", x.category, x.system, -1, -1, -1, cat, now)
        s.lastMs = now; s.heardHz.add(c.key)
        c.cls = if (baud == 2400) "NXDN48" else "NXDN96"; c.role = "control"; c.sys = key; c.lastDecodeMs = now; c.frames++; c.crcOk++; c.blocks++; blocks++
        c.nxdn = x; c.nxdnBaud = baud
        addLog(LogRow(now, c.hz, "NXDN", "SITE_INFO", "${c.cls} · SITE_INFO · $cat SYSTEM ${x.system} · SITE ${x.site} · control channel ${x.cc1}${if (x.cc2 != 0) " and ${x.cc2}" else ""} · ${x.adjacent} adjacent sites · version ${x.version}", "", true))
        pending = true
    }
    private fun tetraOn(c: Carrier, ch: Chan) {
        // the carrier finder can split a 25 kHz signal into pieces: the receiver is centered on all of them together
        val now = now()
        val parts = carriers.values.filter { abs(it.hz - c.hz) <= 16_000 && now - it.lastMs < LIVE_MS && it.cls != "P25 C4FM" && it.cls != "DMR" }
        var w = 0.0; var sum = 0.0; for (x in parts) { val p = 10.0.pow(x.levelDb / 10); w += p; sum += p * x.hz }
        val rx = ch.tetraOn(if (w > 0) sum / w else c.hz.toDouble()) ?: return
        rx.onSync = { s -> tetraSync(c, s) }
    }
    /** A TETRA synchronization burst (EN 300 392-2 BSCH): the network (MCC, MNC), the cell's color code and timing. */
    private fun tetraSync(c: Carrier, t: TetraSync) {
        val now = now(); val key = "TETRA ${t.mcc}-${t.mnc}"
        val s = systems[key] ?: newSys(key, "TETRA", t.mcc, t.mnc, t.colorCode, -1, -1, "", now)
        s.lastMs = now; s.heardHz.add(c.key)
        c.cls = "TETRA"; c.role = "control"; c.sys = key; c.cc = t.colorCode; c.lastDecodeMs = now; c.frames++; c.crcOk++; c.blocks++; blocks++
        c.tetra = t
        // the other pieces of the same 25 kHz signal are the same carrier
        for (x in carriers.values) if (x !== c && abs(x.hz - c.hz) <= 13_000 && x.cls != "TETRA" && !(x.lastDecodeMs > 0 && now - x.lastDecodeMs < 5_000)) {
            x.cls = "TETRA"; x.role = "control"; x.sys = key; x.cc = t.colorCode; x.lastDecodeMs = now
        }
        addLog(LogRow(now, c.hz, "TETRA", "SYNC", "TETRA · SYNC · MCC ${t.mcc} · MNC ${t.mnc} · color code ${t.colorCode} · TS${t.timeslot} · frame ${t.frame} · multiframe ${t.multiframe} · cell load ${t.cellLoad}", "", true))
        pending = true
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
    private fun classify(c: Carrier, ch: Chan, now: Long) {
        if (c.tdma && ch.p2 == null) p2On(c, ch)
        val quiet = !(c.lastDecodeMs > 0 && now - c.lastDecodeMs < 15_000)
        if (!c.tdma && ch.tetra == null && c.cls != "TETRA" && now - ch.openedMs > 1_500 && quiet) tetraOn(c, ch)
        if (!c.tdma && ch.nxdn == null && c.cls != "TETRA" && now - ch.openedMs > 1_500 && quiet) nxdnOn(c, ch)
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
        if (b.dt > 10) return
        if (c.tdma || now - (p2Seen[c.key] ?: Long.MIN_VALUE / 2) < 5_000) return
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
                addLog(LogRow(now, c.hz, "DMR", name, "CC ${b.cc} · TS${b.slot + 1} · $name · ${if (lc.group) "TG" else "UNIT"} ${lc.dst} ← ${lc.src}${if (lc.emergency) " · EMERGENCY" else ""}${if (lc.privacy) " · PRIVACY" else ""}", Codes.hex(b.bytes), true))
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
        if (n > 0) { val e = readEmb(d); if (e.ok && (c.cc < 0 || e.cc == c.cc)) calls.security(call, SecIn(e.pi, "EMB")) }
        calls.frames(call, voiceFrames(d)); ch?.voiced(slot)
        pending = true
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
        val r = ref ?: return
        val lat = round6(Csbks.unwrap16(latLo, r.first)); val lon = round6(Csbks.unwrap16(lonLo, r.second))
        if (last != null) { last.lat = lat; last.lon = lon }
        val tr = u.trail.lastOrNull()
        if (tr == null || tr.lat != lat || tr.lon != lon) { u.trail.add(TrailPt(lat, lon, now)); if (u.trail.size > 30) u.trail.removeAt(0) }
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
        if (g.kind != "datagrant") {
            val p25 = sys.startsWith("P25")
            val call = calls.grant(GrantIn(sys, if (p25) "P25" else "DMR", g.tg, g.group, g.src, g.hz, if (p25) (if (g.tdma) g.slot else 0) else g.slot, g.tdma, g.encrypted, g.emergency,
                g.site, g.lpcn, g.chDerived), g.ms)
            // a voice channel inside the span is listened to from the grant on, not from the next channel assignment
            if (call != null && call.onAir && !call.muted && call.hz != 0L && rate > 0 && inSpan(call.hz)) {
                val vc = carrierAt(call.hz.toDouble()); if (vc.role.isEmpty()) vc.role = "voice"; if (vc.sys.isEmpty()) vc.sys = sys
                if (!chans.containsKey(vc.key)) { vc.lastAuditionMs = g.ms; open(vc, g.ms); vc.decoding = true }
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
        if (u.lonLo < 0 && f != null) return f.first to f.second
        val r = ref
        if (r == null || u.lonLo < 0) return null to null
        return round6(Csbks.unwrap16(u.latLo, r.first)) to round6(Csbks.unwrap16(u.lonLo, r.second))
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
                "TETRA" -> carriers.values.filter { it.sys == s.key && it.tetra != null }.map { c -> val t = c.tetra!!
                    SiteRow("${s.key}/${c.key}", "color code ${t.colorCode}", -1, t.colorCode, -1, listOf(c.hz), c.lastMs, c.levelDb, emptyList(), emptyList(),
                        "TS${t.timeslot} · frame ${t.frame} · multiframe ${t.multiframe}", "", listOf(c.key), emptyList(), -1, emptyList(), emptyList(), 0, -1, t.cellLoad) }
                "NXDN" -> carriers.values.filter { it.sys == s.key && it.nxdn != null }.map { c -> val x = c.nxdn!!
                    SiteRow("${s.key}/${x.site}", "site ${x.site}", -1, x.site, -1, listOf(c.hz), c.lastMs, c.levelDb, emptyList(), emptyList(),
                        "${c.cls} · control channel ${x.cc1}${if (x.cc2 != 0) " and ${x.cc2}" else ""} · ${x.adjacent} adjacent sites", "", listOf(c.key), emptyList(), -1, emptyList(), emptyList(), 0, -1, x.version) }
                else -> dmrSites(s)
            }
            for (st in siteRows) for (k in st.carriers) for (u in units.values) if (u.sys == s.key && k in u.carriers) unitSite[u.key] = st.label
            val label = when {
                s.proto == "NXDN" -> "NXDN · ${s.model} SYSTEM ${s.sysId}"
                s.proto == "TETRA" -> "TETRA · MCC ${s.wacn} · MNC ${s.sysId}"
                s.proto == "P25" -> "WACN ${hx(s.wacn, 5)} · SYSTEM ${hx(s.sysId, 3)}"
                s.net >= 0 -> "${s.model} NETWORK ${s.net}"
                s.trunk == "CAPACITY PLUS" -> "CAPACITY PLUS · COLOR CODE ${s.cc}"
                else -> "COLOR CODE ${s.cc}${if (s.fid > 0) " · FID ${hx(s.fid, 2)}" else ""}"
            }
            val lpcns = s.lpcnHz.map { (lpcn, hz) -> LpcnRow(lpcn, hz, s.lpcnVotes[lpcn]?.get(hz) ?: 0) }.sortedBy { it.lpcn }
            var cwId = ""; var cwIdMs = 0L; var cwIdHz = 0L
            for (c in carriers.values) if (c.sys == s.key && c.callsignMs != 0L && c.callsignMs > cwIdMs) { cwId = c.callsign; cwIdMs = c.callsignMs; cwIdHz = c.hz }
            SystemRow(s.key, s.proto, s.color, label, s.wacn, s.sysId, s.cc, s.fid, s.net, s.model, siteRows.firstOrNull { it.callsign.isNotEmpty() }?.callsign ?: "",
                s.firstMs, s.lastMs, siteRows, s.idens.values.sortedBy { it.iden }, grants.count { it.sys == s.key }, units.values.count { it.sys == s.key },
                tgs.values.count { it.sys == s.key }, s.derived || lpcns.isNotEmpty(), s.trunk, cwId, cwIdMs, cwIdHz, lpcns, s.heardHz.take(12),
                units.values.any { it.sys == s.key && (it.lonLo >= 0 || it.fix != null) })
        }.sortedBy { it.firstMs }
        val unitRows = units.values.map { u ->
            val (lat, lon) = resolvePos(u)
            UnitRow(u.key, u.sys, u.id, u.firstMs, u.lastMs, lat, lon, u.posMs, u.posVerified, u.trail.takeLast(12), u.groups.toList(), u.grants, u.carriers.toList(),
                u.reports.takeLast(6).map { it.row() }, unitSite[u.key] ?: "")
        }
        val tgRows = tgs.values.map { t -> TgRow(t.key, t.sys, t.tg, t.firstMs, t.lastMs, t.grants, t.recent.filter { now - it < 600_000 }, t.members.take(200), t.history.take(12).map { it.copy() }) }
        val carrierRows = carriers.values.map { it.row() }.sortedBy { it.hz }
        return FleetSnap(centerHz, rate, spanLo, spanHi, carrierRows, sysRows, unitRows, tgRows, grants.take(120).map { it.copy() },
            grants.count { now - it.ms < 60_000 }, blocks, chans.size, ref != null, calls.rows(), followTarget(),
            listOf(CodecIds.IMBE, CodecIds.AMBE2).filter { hasCodec(it) }, calls.playing, calls.prefs.lock)
    }
    @Synchronized fun snapshot(): FleetSnap = buildSnapshot()
    /** The call a one-channel receiver should go to, outside the span: only one there is something to hear on. */
    private fun followTarget(): Follow? {
        val c = calls.followTarget({ inSpan(it) }, { x -> hasCodec(x.codec) && !x.encrypted && !x.protectedHint && x.sec != "unknown" }) ?: return null
        return Follow(c.key, c.hz)
    }
    @Synchronized fun setPrefs(p: TgPrefs) { calls.setPrefs(p); post(true) }
    @Synchronized fun callAudio(key: String): FloatArray? = calls.audioOf(key)
    /** A carrier at [hz] as if found in the span (recorded blocks are replayed through it). */
    private fun carrierAt(hz: Double): Carrier {
        val key = gridKey(hz)
        return carriers.getOrPut(key) { Carrier(key, Math.round(hz), now()) }
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
        carriers.clear(); systems.clear(); sites.clear(); units.clear(); tgs.clear(); grants = ArrayList(); logRows.clear(); logSeen.clear()
        chans.clear(); bbFir.clear(); blocks = 0; colorNext = 0; calls.clear(); pendingGrants = ArrayList()
        post(true)
    }

    companion object {
        private val CLOCK = ThreadLocal.withInitial { java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US) }
        private val ISO = ThreadLocal.withInitial { java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") } }

        /** The bands Dispatch scans: id, label, low and high edge (Hz). */
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
