package com.rocketgod.mayhem.core.atsc

import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.min

/**
 * ATSC 1.0 TV: finds stations by their pilot, and with the whole 6 MHz channel in the span (8 MS/s or more) decodes
 * bursts of it to the transport stream: PSIP (channels, guide, station time), the PMTs and stills from the MPEG-2
 * intra pictures. Bursts go to a pool of decoder threads when there is one; what the CPU cannot take is skipped and
 * counted. Tables are read on the thread that finishes a burst; intra pictures decode on a thread of their own.
 */
val FIELD_MS = 313 * 832 / SR * 1000
/** Fields per burst: long enough to hold whole intra pictures of the smaller subchannels. */
const val BURST_FIELDS = 14
private const val STILL_EVERY_MS = 8_000L

class EventRec(val sourceId: Int, val eventId: Int, val startMs: Long, val seconds: Int, val title: String, var text: String, val rating: String, val captions: String, val table: Int, val seenMs: Long)
class StreamRow(val pid: Int, val type: Int, val typeName: String, val lang: String, val info: String, val kbps: Double, val share: Double, val captions: String)
class SubRow(
    val key: String, val major: Int, val minor: Int, val name: String, val longName: String, val program: Int, val sourceId: Int, val serviceType: Int,
    val hidden: Boolean, val hideGuide: Boolean, val access: Boolean, val streams: List<StreamRow>, val video: String, val stillMs: Long, val stillComplete: Boolean, val stillMbs: Int,
    val now: EventRec?, val next: EventRec?, val events: Int,
)
class PidRow(val pid: Int, val role: String, val packets: Int, val kbps: Double, val share: Double, val ccErrors: Int, val scrambled: Int, val pcrs: Int, val pcrIntervalMs: Double, val pcrPpm: Double)
class RsCount(var ok: Int = 0, var corrected: Int = 0, var failed: Int = 0, var bytes: Int = 0) {
    val total: Int get() = ok + corrected + failed
    fun copy() = RsCount(ok, corrected, failed, bytes)
}
class SttRec(val utcMs: Long, val offset: Int, val ds: Boolean, val diffMs: Double, val atMs: Long)
class StationRow(
    val key: String, val ch: Int, val band: String, val centerHz: Double, val tsid: Int, val firstMs: Long, val lastMs: Long,
    val pilotDb: Double, val pilotHz: Double, val topDb: Double, val pilotMs: Long, val pilotOk: Boolean, val syncMs: Long,
    val snrDb: Double, val sliceSnrDb: Double, val snrMs: Long, val rs: RsCount,
    val fields: Int, val airFields: Int, val packets: Int, val badPackets: Int, val decodedMs: Double,
    val subs: List<SubRow>, val tables: List<String>, val stt: SttRec?, val hasVct: Boolean, val hasEit: Boolean, val tvName: String, val events: Int,
)
class LiveSignal(
    val ch: Int, val centerHz: Double, val ms: Long, val ok: Boolean, val reason: String, val pilot: PilotInfo?, val snrDb: Double, val sliceSnrDb: Double, val segPeak: Double, val syncs: Int,
    val hist: IntArray, val eye: FloatArray, val echo: FloatArray, val dfe: FloatArray, val ffe: FloatArray, val eps: Double, val cpuMs: Double, val fields: Int,
    val rs: RsCount, val snrHistory: List<Double>, val rsHistory: List<Double>, val pids: List<PidRow>,
)
class Here(val ch: Int, val pilotOk: Boolean, val sync: Boolean, val pilotDb: Double, val pilotHz: Double, val topDb: Double, val snrDb: Double, val tsid: Int, val since: Long, val vct: Boolean, val stills: Int, val videoSubs: Int, val eit: Boolean, val bursts: Int)
class AtscSnap(
    val capability: String, val rate: Int, val centerHz: Double, val ch: Int, val workers: Int, val busy: Int,
    val decodedPct: Double, val cpuPct: Double, val bursts: Int, val stations: List<StationRow>, val live: LiveSignal?, val here: Here?,
)
class AtscLogRow(val ms: Long, val ch: Int, val kind: String, val text: String)
class RawTable(val table: String, val id: String, val hex: String)
class VideoRow(val pid: Int, val seq: SeqInfo?, val gop: String, val pictures: Int, val iPictures: Int)
class AtscDetail(val key: String, val station: StationRow, val program: Int, val events: List<EventRec>, val raw: List<RawTable>, val video: List<VideoRow>, val chanText: String)
class StillMeta(val ms: Long, val complete: Boolean, val mbs: Int, val w: Int, val h: Int, val dar: Double)

private class Station(val key: String, val ch: Int, val centerHz: Double, var firstMs: Long, var lastMs: Long) {
    var tsid = -1
    var pilotDb = 0.0; var pilotHz = 0.0; var topDb = Double.NaN; var pilotMs = 0L
    /** The pilot met the 8VSB rule (a plateau over the floor, the pilot at its level over it); segment sync was seen. */
    var pilotOk = false; var syncMs = 0L
    /** SNR of the last burst that decoded fields with most packets correctable (snrMs 0: none yet). */
    var snrDb = Double.NaN; var sliceSnrDb = Double.NaN; var snrMs = 0L
    val rs = RsCount()
    var fields = 0; var airFields = 0; var packets = 0; var badPackets = 0
    var pat: Pat? = null; val pmts = LinkedHashMap<Int, Pmt>(); var vct: Vct? = null; var mgt: Mgt? = null; var rrt: Rrt? = null
    var stt: SttRec? = null
    val events = LinkedHashMap<String, EventRec>(); val etts = HashMap<String, String>(); val chanEtt = HashMap<Int, String>()
    val raw = LinkedHashMap<String, String>(); val pidStats = LinkedHashMap<Int, PidStat>()
    val video = LinkedHashMap<Int, VideoRow>()
    val stills = HashMap<Int, StillMeta>()
}

private const val HEXD = "0123456789abcdef"
private fun hex(b: ByteArray): String { val c = CharArray(2 * b.size); for (i in b.indices) { val v = b[i].toInt() and 0xff; c[2 * i] = HEXD[v shr 4]; c[2 * i + 1] = HEXD[v and 15] }; return String(c) }
private fun unhex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }
private val CLOCK = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
private fun clock(ms: Long): String = synchronized(CLOCK) { CLOCK.format(java.util.Date(ms)) }
private fun isoUtc(ms: Long): String = java.time.Instant.ofEpochMilli(ms).toString().let { if (it.length == 20) it.dropLast(1) + ".000Z" else it }
fun tsidText(t: Int) = "0x%04X".format(t)

class AtscProcessor(private val packets: PacketLog? = null) : IqProcessor {
    @Volatile var centerHz = 0.0
    var centerOf: (() -> Double)? = null
    var now: () -> Long = { System.currentTimeMillis() }
    /** Live radio: bursts are captured only when a decoder is free, pictures decode on their own thread. Off for
     *  recordings and tests: every burst, decoded inline. */
    var realtime = true
    @Volatile var pool: AtscPool? = null
    private val stations = LinkedHashMap<String, Station>()
    private val log = ArrayList<AtscLogRow>()
    @Volatile var version = 0; private set
    /** Each decoded intra picture as a still (on the picture thread when realtime). */
    var onStill: ((String, Still) -> Unit)? = null
    var onLog: ((String) -> Unit)? = null
    private val _snap = MutableStateFlow<AtscSnap?>(null)
    val snap: StateFlow<AtscSnap?> = _snap.asStateFlow()
    private val lock = Any()

    private var rate = 0; private var lastCenter = Double.NaN; private var ch = 0
    private val demux = TsDemux()
    private var stills = HashMap<Int, StillDecoder>()
    private var stillGen = 0
    private val stillQueue = AtomicInteger(0)
    private val stillExec: Executor by lazy { Executors.newSingleThreadExecutor { r -> Thread(r, "atsc-pictures").apply { isDaemon = true; priority = Thread.NORM_PRIORITY - 1 } } }
    private var cap: ByteArray? = null; private var capN = 0; private var capLen = 0; private var capturing = false
    private var inFlight = 0; private var bursts = 0
    private var st = BurstState()
    private var live: LiveSignal? = null
    private val snrHistory = ArrayList<Double>(); private val rsHistory = ArrayList<Double>()
    private var airSamples = 0.0; private var decodedSamples = 0.0; private var cpuMs = 0.0; private var wallStart = 0L
    private var pilotAcc = 0; private val pilotRe = FloatArray(32768); private val pilotIm = FloatArray(32768); private var pilotN = 0
    private var hereSince = 0L; private var hereBursts = 0; private var settle = 0
    private var lastPost = 0L; private var dirty = false

    init {
        demux.onSection = { pid, s -> section(pid, s) }
        demux.onPes = { pid, es, holes -> pes(pid, es, holes) }
    }

    override fun reset(rate: Int) = synchronized(lock) {
        this.rate = rate; capN = 0; capturing = false; demux.gap(); st = BurstState(st.eps); allocCap(); post(true)
    }
    private fun allocCap() {
        if (rate < 6_400_000) { cap = null; capLen = 0; return }
        capLen = Math.round(rate * FIELD_MS / 1000 * (BURST_FIELDS + 1.2)).toInt()
        if (!realtime || pool == null) cap = ByteArray(2 * capLen)
    }
    val capability: String get() = if (rate >= 6_400_000) "decode" else "pilot"

    private fun station(): Station? {
        if (ch == 0) return null
        val key = "ch$ch"
        return stations.getOrPut(key) { val n = now(); Station(key, ch, centerOf(ch), n, n) }
    }

    /** Offset-128 bytes from the radio. */
    override fun onIq(iq: ByteArray, len: Int, rate: Int) = onIqSigned(iq, len, rate, true)

    /** [offset]: bytes are offset-128 (the radio's) rather than signed. */
    fun onIqSigned(iq: ByteArray, len: Int, rate: Int, offset: Boolean = false) {
        var pilotReady = false
        synchronized(lock) {
            if (rate != this.rate) reset(rate)
            centerOf?.let { centerHz = it() }
            if (centerHz != lastCenter) retuned()
            var n = len shr 1; var at = 0
            // samples still in flight from before the retune are not this channel's
            if (settle > 0) { val k = min(n, settle); settle -= k; if (k == n) return; at = k; n -= k }
            // the pilot, from a stretch of every buffer, about twice a second (any radio)
            pilotAcc += n
            if (pilotAcc > rate / 4) {
                val take = min(n, pilotRe.size - pilotN)
                for (i in 0 until take) {
                    val o = 2 * (at + i)
                    if (offset) { pilotRe[pilotN + i] = ((iq[o].toInt() and 0xff) - 128).toFloat(); pilotIm[pilotN + i] = ((iq[o + 1].toInt() and 0xff) - 128).toFloat() }
                    else { pilotRe[pilotN + i] = iq[o].toFloat(); pilotIm[pilotN + i] = iq[o + 1].toFloat() }
                }
                pilotN += take
                if (pilotN >= pilotRe.size) { pilotAcc = 0; pilotN = 0; pilotReady = true }
            }
            if (!pilotReady) capture(iq, at, n, offset)
            else { pendingIq = iq; pendingAt = at; pendingN = n; pendingOffset = offset }
        }
        if (pilotReady) {
            // the pilot search runs outside the lock so a finishing burst is not held up by it
            val want = synchronized(lock) { if (ch == 0) null else pilotOf(ch) - centerHz }
            val p = if (want != null && abs(want) <= this.rate / 2.0 - 50_000) findPilot(pilotRe, pilotIm, this.rate.toDouble(), 30_000.0, want) else null
            synchronized(lock) {
                if (want != null && abs(want) <= this.rate / 2.0 - 50_000) pilotLook(p)
                val q = pendingIq; pendingIq = null
                if (q != null) capture(q, pendingAt, pendingN, pendingOffset)
            }
        }
    }
    private var pendingIq: ByteArray? = null; private var pendingAt = 0; private var pendingN = 0; private var pendingOffset = false

    private fun capture(iq: ByteArray, at: Int, n: Int, offset: Boolean) {
        if (capability != "decode") return
        val s = station()
        val live = s != null && s.pilotOk && now() - s.pilotMs < 3_000
        if (live) airSamples += n
        // a burst starts only when a decoder can take it, on a channel whose pilot met the 8VSB rule
        if (!capturing) {
            if (s == null || (realtime && !live)) return
            val pl = pool
            if (realtime && pl != null && (pl.free == 0 || pl.failed)) return
            if (realtime && pl == null && inFlight > 0) return
            capturing = true; capN = 0
            if (cap?.size != 2 * capLen) cap = ByteArray(2 * capLen)
        }
        val c = cap!!
        val take = min(n, capLen - capN)
        if (offset) { val o = 2 * at; val d = 2 * capN; for (i in 0 until 2 * take) c[d + i] = (iq[o + i].toInt() xor 0x80).toByte() }
        else System.arraycopy(iq, 2 * at, c, 2 * capN, 2 * take)
        capN += take
        if (capN >= capLen) { capturing = false; burst(c); if (pool != null && realtime) cap = null }
    }

    private fun retuned() {
        lastCenter = centerHz
        val c = channelAt(centerHz)
        // decoding needs the channel centered; a narrow radio looks at the pilot wherever it is in the span
        ch = c?.ch ?: 0
        capturing = false; capN = 0; pilotAcc = 0; pilotN = 0; pendingIq = null
        settle = if (realtime) Math.round(rate * 0.3).toInt() else 0
        demux.clear(); stills = HashMap(); stillGen++
        // nothing measured before this visit stands for it
        station()?.let { s -> s.snrDb = Double.NaN; s.sliceSnrDb = Double.NaN; s.snrMs = 0; s.pilotOk = false; s.pilotDb = 0.0 }
        st = BurstState(st.eps)
        hereSince = now(); hereBursts = 0; live = null; snrHistory.clear(); rsHistory.clear()
        post(true)
    }

    private fun pilotLook(p: PilotInfo?) {
        val s = station() ?: return
        val t = now()
        if (p != null && p.ok) {
            val first = s.pilotMs == 0L
            s.pilotDb = if (s.pilotOk && s.pilotDb > 0) 0.7 * s.pilotDb + 0.3 * p.db else p.db; s.pilotHz = p.hz; s.topDb = p.topDb; s.pilotMs = t; s.lastMs = t; s.pilotOk = true
            if (first) note("PILOT", "ch ${s.ch} ${"%.0f".format(java.util.Locale.US, s.centerHz / 1e6)} MHz · pilot +${"%.1f".format(java.util.Locale.US, p.db)} dB · ${if (p.hz >= 0) "+" else ""}${"%.0f".format(java.util.Locale.US, p.hz)} Hz · channel +${"%.1f".format(java.util.Locale.US, p.topDb)} dB over the floor")
            version++
        } else { s.pilotOk = false; s.pilotDb = 0.0; if (p != null && p.topDb.isFinite()) s.topDb = p.topDb }
        dirty = true; post()
    }

    private fun burst(buf: ByteArray) {
        val rate = rate.toDouble(); val ch = ch; val center = centerHz
        inFlight++; bursts++
        val pl = pool
        if (pl != null && realtime && !pl.failed) {
            val ok = pl.run(buf, rate, st.copy()) { out, bst ->
                synchronized(lock) {
                    inFlight--
                    if (out == null || ch != this.ch || center != centerHz) return@synchronized
                    st = BurstState(bst.eps, bst.pilotHz, bst.act, bst.bursts)
                    result(out)
                }
            }
            if (ok) return
        }
        val bst = st.copy()
        var out: BurstOut? = null
        try { out = decodeBurst(buf, rate, bst) } catch (e: Exception) { onLog?.invoke("ATSC: ${e.message}") }
        inFlight--
        if (out == null) return
        st = bst
        result(out)
    }

    /** Feed a decoded burst (the pool's or inline). */
    private fun result(r: BurstOut) {
        val s = station() ?: return
        val t = now()
        cpuMs += r.cpuMs; hereBursts++
        if (wallStart == 0L) wallStart = t
        decodedSamples += r.fields * FIELD_MS / 1000 * rate
        s.fields += r.fields; s.airFields = Math.round(airSamples / rate * 1000 / FIELD_MS).toInt()
        if (r.segPeak >= 6 && r.reason != "no segment sync" && r.reason != "no pilot") s.syncMs = t
        if (r.ok) {
            val tot = r.rs.ok + r.rs.corrected + r.rs.failed
            // an SNR measured against decisions that are mostly wrong says nothing: shown only when most packets correct
            if (r.fields > 0 && tot > 0 && r.rs.failed.toDouble() / tot < 0.5) { s.snrDb = r.snrDb; s.sliceSnrDb = r.sliceSnrDb; s.snrMs = t }
            else { s.snrDb = Double.NaN; s.sliceSnrDb = Double.NaN }
            s.rs.ok += r.rs.ok; s.rs.corrected += r.rs.corrected; s.rs.failed += r.rs.failed; s.rs.bytes += r.rs.bytes
            snrHistory.add(r.snrDb); if (snrHistory.size > 60) snrHistory.removeAt(0)
            rsHistory.add(if (tot > 0) r.rs.failed.toDouble() / tot else 1.0); if (rsHistory.size > 60) rsHistory.removeAt(0)
        }
        // the signal view is for a channel with an 8VSB pilot; a burst of noise leaves it empty
        live = if (r.reason == "no pilot") null else LiveSignal(s.ch, s.centerHz, t, r.ok, r.reason, r.pilot, r.snrDb, r.sliceSnrDb, r.segPeak, r.syncs,
            r.hist.copyOf(), r.eye.copyOfRange(0, min(1500, r.eye.size)), r.echo, r.dfe, r.ffe, r.eps, r.cpuMs, r.fields,
            RsCount(r.rs.ok, r.rs.corrected, r.rs.failed, r.rs.bytes), snrHistory.toList(), rsHistory.toList(), emptyList())
        if (r.ts.isNotEmpty()) {
            demux.gap()
            demux.feed(r.ts)
            demux.gap(0)
            s.packets = demux.total; s.badPackets = demux.bad
            for ((pid, p) in demux.pids) s.pidStats[pid] = PidStat(p.packets, p.ccErrors, p.scrambled, p.pcrs, p.pcrIntervalMs, p.pcrPpm)
        }
        s.lastMs = t
        version++; dirty = true; post()
    }

    // ---- tables ----
    private fun section(pid: Int, sec: ByteArray) {
        if (sec.size < 12 || crc32(sec) != 0L) return
        val s = station() ?: return
        val tid = sec.u(0); val t = now()
        s.raw["${tid.toString(16)}/${(sec.u(3) shl 8) or sec.u(4)}/${sec.u(6)}"] = hex(sec)
        try {
            when {
                tid == 0x00 && pid == 0 -> {
                    val pat = parsePat(sec)
                    if (s.tsid != pat.tsid) {
                        if (s.tsid >= 0) forget(s)
                        s.tsid = pat.tsid
                        note("STATION", "ch ${s.ch} ${"%.0f".format(java.util.Locale.US, s.centerHz / 1e6)} MHz · TSID ${tsidText(pat.tsid)} · ${pat.programs.size} program${if (pat.programs.size == 1) "" else "s"}")
                    }
                    s.pat = pat
                    for (p in pat.programs) demux.watchSections(p.pid)
                }
                tid == 0x02 -> {
                    val pmt = parsePmt(sec); val had = s.pmts[pmt.program]
                    s.pmts[pmt.program] = pmt
                    for (es in pmt.streams) if (es.type == 0x02) demux.watchPes(es.pid)
                    if (had == null || had.version != pmt.version) version++
                }
                tid == 0xc7 -> {
                    val mgt = parseMgt(sec)
                    s.mgt = mgt
                    for (tb in mgt.tables) if (tb.type in 0x100..0x17f || tb.type in 0x200..0x27f || tb.type == 4 || tb.type in 0x301..0x3ff) demux.watchSections(tb.pid)
                }
                tid == 0xc8 || tid == 0xc9 -> {
                    val prev = s.vct
                    val v = mergeVct(s, sec)
                    if (prev == null || prev.version != v.version) for (c in v.channels) note("CHANNEL", "${c.major}.${c.minor} ${c.shortName.ifEmpty { "?" }} · ch ${s.ch} · program ${c.program}${c.desc.longName?.takeIf { it.isNotEmpty() }?.let { " · $it" } ?: ""}")
                }
                tid == 0xcd -> {
                    val x = parseStt(sec); val diff = (x.utcMs - t).toDouble(); val first = s.stt == null
                    s.stt = SttRec(x.utcMs, x.offset, x.dsStatus, s.stt?.let { 0.8 * it.diffMs + 0.2 * diff } ?: diff, t)
                    if (first) note("TIME", "ch ${s.ch} station clock ${isoUtc(x.utcMs).take(19).replace('T', ' ')} UTC · ${if (diff >= 0) "+" else ""}${"%.1f".format(java.util.Locale.US, diff / 1000)} s from this device")
                }
                tid == 0xcb -> {
                    val e = parseEit(sec); val table = s.mgt?.tables?.firstOrNull { it.pid == pid }?.type ?: 0x100; val off = s.stt?.offset ?: 18
                    for (ev in e.events) {
                        val k = "${e.sourceId}/${ev.eventId}"; val startMs = gpsToUnixMs(ev.startGps, off); val had = s.events[k]
                        val cap = ev.desc.captions?.takeIf { it.isNotEmpty() }?.joinToString(" ") { if (it.digital) "CC${it.service}" else "608 F${it.line21Field + 1}" } ?: ""
                        val rec = EventRec(e.sourceId, ev.eventId, startMs, ev.seconds, ev.title, if (had?.startMs == startMs) had.text else "", ratingText(ev.desc.advisory), cap, table - 0x100, t)
                        s.etts[k]?.let { rec.text = it }
                        s.events[k] = rec
                        if (had == null) version++
                    }
                    prune(s)
                }
                tid == 0xcc -> {
                    val x = parseEtt(sec); val k = "${x.sourceId}/${x.eventId}"
                    if (x.isEvent) { s.etts[k] = x.text; s.events[k]?.text = x.text } else s.chanEtt[x.sourceId] = x.text
                }
                tid == 0xca -> s.rrt = parseRrt(sec)
            }
        } catch (_: Exception) { /* a malformed table */ }
        s.lastMs = t
        dirty = true
    }

    /** A TVCT or CVCT section into the station's channel table (sections of one version add up). */
    private fun mergeVct(s: Station, sec: ByteArray): Vct {
        val v = parseVct(sec); val prev = s.vct
        fun merged(base: Vct) = Vct(base.cable, base.tsid, base.version, base.section, base.last,
            base.channels.filter { c -> v.channels.none { it.major == c.major && it.minor == c.minor } } + v.channels)
        s.vct = if (prev == null || prev.version != v.version || v.section == 0) v
        else merged(prev).let { Vct(prev.cable, prev.tsid, prev.version, prev.section, prev.last, it.channels) }
        return v
    }

    private fun forget(s: Station) {
        s.pat = null; s.pmts.clear(); s.vct = null; s.mgt = null; s.stt = null; s.events.clear(); s.etts.clear(); s.raw.clear(); s.video.clear(); s.stills.clear(); s.pidStats.clear()
    }

    private fun prune(s: Station) {
        val cut = now() + (s.stt?.diffMs ?: 0.0) - 6 * 3_600_000
        if (s.events.size < 400) { s.events.entries.removeAll { it.value.startMs + it.value.seconds * 1000L < cut }; return }
        s.events.entries.sortedBy { it.value.startMs }.take(s.events.size - 400).map { it.key }.forEach { s.events.remove(it) }
    }

    private fun programOfPid(s: Station, pid: Int): Int = s.pmts.values.firstOrNull { p -> p.streams.any { it.pid == pid } }?.program ?: -1

    private fun pes(pid: Int, es: ByteArray, holes: List<Int>) {
        val s = station() ?: return
        val prog = programOfPid(s, pid)
        val dec = stills.getOrPut(pid) { StillDecoder() }
        val last = s.stills[prog]; val t = now()
        val want = prog >= 0 && (last == null || !last.complete || t - last.ms > STILL_EVERY_MS)
        if (!realtime) { stillDone(s, pid, prog, dec, dec.unit(es, holes, want), stillGen); return }
        // pictures decode on their own thread; a backlog there drops the newest units
        if (stillQueue.get() > 6) return
        stillQueue.incrementAndGet()
        val gen = stillGen
        stillExec.execute {
            try {
                val still = try { dec.unit(es, holes, want) } catch (_: Exception) { null }
                val call = synchronized(lock) { if (gen == stillGen && station() === s) stillDone(s, pid, prog, dec, still, gen, false) else null }
                call?.invoke()
            } finally { stillQueue.decrementAndGet() }
        }
    }

    /** Records what a picture unit gave; returns the still callback to run (or runs it, inline). */
    private fun stillDone(s: Station, pid: Int, prog: Int, dec: StillDecoder, still: Still?, gen: Int, inline: Boolean = true): (() -> Unit)? {
        s.video[pid] = VideoRow(pid, dec.seq, dec.gop, dec.pictures, dec.iPictures)
        if (still == null || prog < 0) return null
        val last = s.stills[prog]; val t = now()
        // a picture that came out with fewer rows than the one we have keeps the old still
        if (last != null && last.complete && !still.filled && t - last.ms < 60_000) return null
        s.stills[prog] = StillMeta(t, still.filled, still.mbs, still.width, still.height, still.dar)
        val vc = s.vct?.channels?.firstOrNull { it.program == prog }
        if (last == null) note("STILL", "${if (vc != null) "${vc.major}.${vc.minor} ${vc.shortName}" else "program $prog"} · ${still.seq.width}x${still.seq.height}${if (still.seq.progressive) "p" else "i"} · ${if (still.complete) "whole picture" else "${Math.round(100.0 * still.mbs / still.mbsTotal)} % of the picture"}")
        version++; dirty = true
        val key = "${s.key}/$prog"
        val cb = onStill ?: return null
        if (inline) { cb(key, still); return null }
        return { if (gen == stillGen) cb(key, still) }
    }

    // ---- out ----
    private fun note(kind: String, text: String) {
        val t = now()
        log.add(0, AtscLogRow(t, ch, kind, text)); if (log.size > 500) log.subList(500, log.size).clear()
        packets?.add("${clock(t)} $kind $text")
        onLine?.invoke("${clock(t)} $kind $text")
    }
    /** Each log line as it is written (tests and the screen's log). */
    var onLine: ((String) -> Unit)? = null

    private fun subRows(s: Station): List<SubRow> {
        val t = now(); val rows = ArrayList<SubRow>()
        val chans = ArrayList<VChannel>(s.vct?.channels ?: emptyList())
        val total = maxOf(1, s.pidStats.values.sumOf { it.packets })
        val progs = chans.map { it.program }.toSet()
        // programs in the PAT with no channel in the TVCT still show (by program number)
        for (p in s.pat?.programs ?: emptyList()) if (p.program !in progs) chans.add(VChannel(0, p.program, "", 4, 0, s.tsid, p.program, 0, false, false, false, 0, -1, Descriptors()))
        for (c in chans) {
            val pmt = s.pmts[c.program]
            val elems = c.desc.elements ?: emptyList()
            val src = pmt?.streams ?: elems.map { e -> PmtStream(e.streamType, e.pid, Descriptors().also { it.lang = e.lang }) }
            val streams = src.map { x ->
                val ps = s.pidStats[x.pid]; val v = s.video[x.pid]?.seq
                val lang = x.desc.lang ?: x.desc.ac3?.lang ?: elems.firstOrNull { it.pid == x.pid }?.lang ?: ""
                val info = if (v != null) videoText(v) else x.desc.ac3?.let { "${it.channels} · ${it.kbps} kb/s" } ?: ""
                StreamRow(x.pid, x.type, streamTypeName(x.type), lang, info, if (ps != null) ps.packets.toDouble() / total * TS_BPS / 1000 else 0.0, if (ps != null) ps.packets.toDouble() / total else 0.0,
                    (x.desc.captions ?: emptyList()).joinToString(", ") { if (it.digital) "CC${it.service} ${it.lang}" else "608 ${it.lang}" })
            }
            val vid = streams.firstOrNull { isVideo(it.type) }
            val evs = s.events.values.filter { it.sourceId == c.sourceId }.sortedBy { it.startMs }
            val nowMs = if (s.stt != null) t + s.stt!!.diffMs.toLong() else t
            val cur = evs.firstOrNull { it.startMs <= nowMs && it.startMs + it.seconds * 1000L > nowMs }
            val nxt = evs.firstOrNull { it.startMs > nowMs }
            val still = s.stills[c.program]
            rows.add(SubRow("${s.key}/${c.program}", c.major, c.minor, c.shortName, c.desc.longName ?: "", c.program, c.sourceId, c.serviceType,
                c.hidden, c.hideGuide, c.access, streams, if (vid != null) (s.video[vid.pid]?.seq?.let { videoText(it) } ?: vid.typeName) else "",
                still?.ms ?: 0, still?.complete ?: false, still?.mbs ?: 0, cur, nxt, evs.size))
        }
        return rows.sortedWith(compareBy<SubRow> { if (it.major != 0) it.major else 999 }.thenBy { it.minor })
    }

    private fun stationRow(s: Station): StationRow {
        val subs = subRows(s)
        val tables = linkedSetOf<String>()
        if (s.pat != null) tables.add("PAT"); if (s.pmts.isNotEmpty()) tables.add("PMT"); if (s.mgt != null) tables.add("MGT")
        s.vct?.let { tables.add(if (it.cable) "CVCT" else "TVCT") }; if (s.stt != null) tables.add("STT"); if (s.events.isNotEmpty()) tables.add("EIT")
        if (s.etts.isNotEmpty()) tables.add("ETT"); if (s.rrt != null) tables.add("RRT")
        return StationRow(s.key, s.ch, ATSC_CHANNELS.firstOrNull { it.ch == s.ch }?.band ?: "", s.centerHz, s.tsid, s.firstMs, s.lastMs,
            s.pilotDb, s.pilotHz, s.topDb, s.pilotMs, s.pilotOk, s.syncMs, if (s.snrMs != 0L) s.snrDb else Double.NaN, if (s.snrMs != 0L) s.sliceSnrDb else Double.NaN, s.snrMs, s.rs.copy(),
            s.fields, s.airFields, s.packets, s.badPackets, s.fields * FIELD_MS,
            subs, tables.toList(), s.stt, s.vct != null, s.events.isNotEmpty(), subs.firstOrNull { it.name.isNotEmpty() }?.name ?: "", s.events.size)
    }

    private fun pidRows(s: Station): List<PidRow> {
        val total = maxOf(1, s.pidStats.values.sumOf { it.packets })
        fun vcOf(prog: Int) = s.vct?.channels?.firstOrNull { it.program == prog }
        fun role(pid: Int): String {
            if (pid == 0) return "PAT"; if (pid == 0x1ffb) return "PSIP base (MGT TVCT STT)"; if (pid == 0x1fff) return "null"; if (pid == 8192) return "uncorrectable (RS)"
            for (p in s.pat?.programs ?: emptyList()) if (p.pid == pid) { val vc = vcOf(p.program); return "PMT ${if (vc != null) "${vc.major}.${vc.minor}" else "program ${p.program}"}" }
            for (pm in s.pmts.values) for (x in pm.streams) if (x.pid == pid) { val vc = vcOf(pm.program); return "${if (vc != null) "${vc.major}.${vc.minor}" else "program ${pm.program}"} ${streamTypeName(x.type)}${x.desc.lang?.let { " $it" } ?: ""}" }
            s.mgt?.tables?.firstOrNull { it.pid == pid }?.let { return tableTypeName(it.type) }
            return ""
        }
        return s.pidStats.entries.map { (pid, p) -> PidRow(pid, role(pid), p.packets, p.packets.toDouble() / total * TS_BPS / 1000, p.packets.toDouble() / total, p.ccErrors, p.scrambled, p.pcrs, p.pcrIntervalMs, p.pcrPpm) }.sortedBy { it.pid }
    }

    /** A station: its tables were read, or its segment sync seen; with a narrow radio, its pilot met the 8VSB rule. */
    private fun listed(x: Station): Boolean = x.tsid >= 0 || x.syncMs > 0 || (capability == "pilot" && x.pilotOk)

    fun snapshot(): AtscSnap = synchronized(lock) {
        val s = if (ch != 0) stations["ch$ch"] else null; val t = now()
        val wall = if (wallStart != 0L) maxOf(1L, t - wallStart) else 1L
        val lv = live; val liveOut = if (lv != null && s != null) LiveSignal(lv.ch, lv.centerHz, lv.ms, lv.ok, lv.reason, lv.pilot, lv.snrDb, lv.sliceSnrDb, lv.segPeak, lv.syncs,
            lv.hist, lv.eye, lv.echo, lv.dfe, lv.ffe, lv.eps, lv.cpuMs, lv.fields, lv.rs, lv.snrHistory, lv.rsHistory, pidRows(s)) else null
        val subs = if (s != null) subRows(s) else emptyList()
        val videoSubs = subs.filter { x -> x.streams.any { it.type == 0x02 } }
        AtscSnap(capability, rate, centerHz, ch, pool?.size ?: 0, inFlight,
            if (airSamples > 0) min(100.0, 100 * decodedSamples / airSamples) else 0.0, min(400.0, 100 * cpuMs / wall), bursts,
            stations.values.filter { listed(it) }.sortedBy { it.ch }.map { stationRow(it) }, liveOut,
            s?.let { Here(it.ch, it.pilotOk, it.syncMs >= hereSince, it.pilotDb, it.pilotHz, it.topDb, if (it.snrMs >= hereSince) it.snrDb else Double.NaN, it.tsid, hereSince, it.vct != null,
                videoSubs.count { x -> x.stillMs > hereSince }, videoSubs.size, it.events.values.any { e -> e.seenMs > hereSince }, hereBursts) })
    }

    fun post(force: Boolean = false) {
        val t = System.nanoTime() / 1_000_000
        if (!force && (!dirty || t - lastPost < 500)) return
        lastPost = t; dirty = false
        _snap.value = snapshot()
    }

    /** Everything known of a station for the detail panel: the guide, the streams and the raw tables. */
    fun detail(key: String): AtscDetail? = synchronized(lock) {
        val sk = key.substringBefore('/'); val s = stations[sk] ?: return@synchronized null
        val p = key.substringAfter('/', "").toIntOrNull() ?: -1; val vc = s.vct?.channels?.firstOrNull { it.program == p }
        val events = s.events.values.filter { if (vc != null) it.sourceId == vc.sourceId else true }.sortedBy { it.startMs }
        val raw = s.raw.entries.filter { (k, _) ->
            val parts = k.split('/'); val tid = parts[0].toInt(16)
            when (tid) { 0x2 -> parts[1].toInt() == p; 0xcb -> vc == null || parts[1].toInt() == vc.sourceId; else -> true }
        }.map { (k, v) -> RawTable(tableName(k.substringBefore('/').toInt(16)), k, v) }.take(80)
        AtscDetail(key, stationRow(s), p, events, raw, s.video.values.toList(), if (vc != null) s.chanEtt[vc.sourceId] ?: "" else "")
    }

    // ---- export and persistence ----
    private fun eventJson(e: EventRec) = JSONObject().put("sourceId", e.sourceId).put("eventId", e.eventId).put("startMs", e.startMs).put("seconds", e.seconds).put("title", e.title)
        .put("text", e.text).put("rating", e.rating).put("captions", e.captions).put("table", e.table).put("seenMs", e.seenMs)
    private fun descJson(d: Descriptors) = JSONObject().apply {
        put("tags", JSONArray(d.tags)); d.longName?.let { put("longName", it) }; d.lang?.let { put("lang", it) }; d.registration?.let { put("registration", it) }
        d.pcrPid?.let { put("pcrPid", it) }
        d.elements?.let { put("elements", JSONArray(it.map { e -> JSONObject().put("streamType", e.streamType).put("pid", e.pid).put("lang", e.lang) })) }
        d.captions?.let { put("captions", JSONArray(it.map { c -> JSONObject().put("lang", c.lang).put("digital", c.digital).put("service", c.service).put("line21Field", c.line21Field).put("easyReader", c.easyReader).put("wide", c.wide) })) }
        d.advisory?.let { put("advisory", JSONArray(it.map { a -> JSONObject().put("region", a.region).put("text", a.text).put("dims", JSONArray(a.dims.map { x -> JSONArray(listOf(x.first, x.second)) })) })) }
        d.ac3?.let { put("ac3", JSONObject().put("sampleRate", it.sampleRate).put("bsid", it.bsid).put("kbps", it.kbps).put("channels", it.channels).put("lang", it.lang)) }
    }
    private fun seqJson(v: SeqInfo) = JSONObject().put("width", v.width).put("height", v.height).put("aspect", v.aspect).put("frameRate", v.frameRate).put("bitRate", v.bitRate)
        .put("progressive", v.progressive).put("chroma", v.chroma).put("profileLevel", v.profileLevel).put("intraMatrix", v.intraMatrix)
    private fun num(d: Double): Any = if (d.isFinite()) d else JSONObject.NULL
    private fun rowJson(r: StationRow) = JSONObject().put("key", r.key).put("ch", r.ch).put("band", r.band).put("centerHz", r.centerHz).put("tsid", r.tsid).put("firstMs", r.firstMs).put("lastMs", r.lastMs)
        .put("pilotDb", r.pilotDb).put("pilotHz", r.pilotHz).put("topDb", num(r.topDb)).put("pilotMs", r.pilotMs).put("pilotOk", r.pilotOk).put("syncMs", r.syncMs)
        .put("snrDb", num(r.snrDb)).put("sliceSnrDb", num(r.sliceSnrDb)).put("snrMs", r.snrMs)
        .put("rs", JSONObject().put("ok", r.rs.ok).put("corrected", r.rs.corrected).put("failed", r.rs.failed).put("bytes", r.rs.bytes))
        .put("fields", r.fields).put("airFields", r.airFields).put("packets", r.packets).put("badPackets", r.badPackets).put("decodedMs", r.decodedMs)
        .put("tables", JSONArray(r.tables)).put("tvName", r.tvName).put("events", r.events)
        .put("subs", JSONArray(r.subs.map { x -> JSONObject().put("key", x.key).put("major", x.major).put("minor", x.minor).put("name", x.name).put("longName", x.longName).put("program", x.program)
            .put("sourceId", x.sourceId).put("serviceType", x.serviceType).put("hidden", x.hidden).put("hideGuide", x.hideGuide).put("access", x.access).put("video", x.video)
            .put("streams", JSONArray(x.streams.map { y -> JSONObject().put("pid", y.pid).put("type", y.type).put("typeName", y.typeName).put("lang", y.lang).put("info", y.info).put("kbps", y.kbps).put("captions", y.captions) }))
            .put("now", x.now?.let { eventJson(it) } ?: JSONObject.NULL).put("next", x.next?.let { eventJson(it) } ?: JSONObject.NULL) }))
    private fun tablesJson(s: Station) = JSONObject().apply {
        s.pat?.let { p -> put("pat", JSONObject().put("tsid", p.tsid).put("version", p.version).put("programs", JSONArray(p.programs.map { JSONObject().put("program", it.program).put("pid", it.pid) }))) }
        put("pmts", JSONArray(s.pmts.values.map { m -> JSONObject().put("program", m.program).put("version", m.version).put("pcrPid", m.pcrPid).put("desc", descJson(m.desc))
            .put("streams", JSONArray(m.streams.map { x -> JSONObject().put("type", x.type).put("pid", x.pid).put("desc", descJson(x.desc)) })) }))
        s.mgt?.let { g -> put("mgt", JSONObject().put("version", g.version).put("tables", JSONArray(g.tables.map { JSONObject().put("type", it.type).put("name", tableTypeName(it.type)).put("pid", it.pid).put("version", it.version).put("bytes", it.bytes) }))) }
        s.vct?.let { v -> put("vct", JSONObject().put("cable", v.cable).put("tsid", v.tsid).put("version", v.version).put("channels", JSONArray(v.channels.map { c ->
            JSONObject().put("major", c.major).put("minor", c.minor).put("shortName", c.shortName).put("modulation", c.modulation).put("carrierHz", c.carrierHz).put("tsid", c.tsid).put("program", c.program)
                .put("etm", c.etm).put("access", c.access).put("hidden", c.hidden).put("hideGuide", c.hideGuide).put("serviceType", c.serviceType).put("sourceId", c.sourceId).put("desc", descJson(c.desc)) }))) }
        s.stt?.let { put("stt", JSONObject().put("utcMs", it.utcMs).put("offset", it.offset).put("ds", it.ds).put("diffMs", it.diffMs).put("atMs", it.atMs)) }
        put("events", JSONArray(s.events.values.map { eventJson(it) }))
    }

    /** The log as CSV, and everything decoded (each station's row, its tables, guide and raw sections) as JSON. */
    fun exportAll(): Pair<String, String> = synchronized(lock) {
        val csv = (listOf("time,channel,kind,text") + log.reversed().map { "${isoUtc(it.ms)},${it.ch},${it.kind},\"${it.text.replace("\"", "\"\"")}\"" }).joinToString("\n")
        val json = JSONObject().put("exported", isoUtc(now())).put("stations", JSONArray(stations.values.map { s ->
            val o = rowJson(stationRow(s)); val tb = tablesJson(s); for (k in tb.keys()) o.put(k, tb.get(k)); o.put("raw", JSONObject(s.raw as Map<*, *>)); o
        }))
        csv to json.toString(1)
    }

    /** What is kept between runs: every station, its tables (as their sections), guide, streams and picture records. */
    fun exportState(): String = synchronized(lock) {
        JSONObject().put("v", 1).put("stations", JSONArray(stations.values.map { s ->
            JSONObject().put("key", s.key).put("ch", s.ch).put("centerHz", s.centerHz).put("tsid", s.tsid).put("firstMs", s.firstMs).put("lastMs", s.lastMs)
                .put("pilotDb", s.pilotDb).put("pilotHz", s.pilotHz).put("topDb", num(s.topDb)).put("pilotMs", s.pilotMs).put("pilotOk", s.pilotOk).put("syncMs", s.syncMs)
                .put("snrDb", num(s.snrDb)).put("sliceSnrDb", num(s.sliceSnrDb)).put("snrMs", s.snrMs)
                .put("rs", JSONObject().put("ok", s.rs.ok).put("corrected", s.rs.corrected).put("failed", s.rs.failed).put("bytes", s.rs.bytes))
                .put("fields", s.fields).put("airFields", s.airFields).put("packets", s.packets).put("badPackets", s.badPackets)
                .put("sections", JSONArray(s.raw.entries.filter { it.key.substringBefore('/').toInt(16) in setOf(0x00, 0x02, 0xc7, 0xc8, 0xc9, 0xca) }.map { it.value }))
                .put("stt", s.stt?.let { JSONObject().put("utcMs", it.utcMs).put("offset", it.offset).put("ds", it.ds).put("diffMs", it.diffMs).put("atMs", it.atMs) } ?: JSONObject.NULL)
                .put("events", JSONArray(s.events.values.map { eventJson(it) }))
                .put("etts", JSONObject(s.etts as Map<*, *>)).put("chanEtt", JSONObject(s.chanEtt.mapKeys { it.key.toString() } as Map<*, *>))
                .put("pidStats", JSONObject().also { o -> for ((pid, p) in s.pidStats) o.put(pid.toString(), JSONArray(listOf(p.packets, p.ccErrors, p.scrambled, p.pcrs, p.pcrIntervalMs, p.pcrPpm))) })
                .put("video", JSONArray(s.video.values.map { v -> JSONObject().put("pid", v.pid).put("gop", v.gop).put("pictures", v.pictures).put("iPictures", v.iPictures).put("seq", v.seq?.let { seqJson(it) } ?: JSONObject.NULL) }))
                .put("stills", JSONObject().also { o -> for ((p, m) in s.stills) o.put(p.toString(), JSONObject().put("ms", m.ms).put("complete", m.complete).put("mbs", m.mbs).put("w", m.w).put("h", m.h).put("dar", m.dar)) })
        })).put("log", JSONArray(log.take(200).map { JSONObject().put("ms", it.ms).put("ch", it.ch).put("kind", it.kind).put("text", it.text) })).toString()
    }

    fun restore(text: String?) {
        val j = runCatching { JSONObject(text ?: return) }.getOrNull() ?: return
        if (j.optInt("v") != 1) return
        synchronized(lock) {
            val a = j.optJSONArray("stations") ?: JSONArray()
            for (i in 0 until a.length()) {
                val o = a.getJSONObject(i); val key = o.optString("key")
                // a saved station from before the 8VSB rule, with nothing decoded, was likely a spur: it is not brought back
                if (key.isEmpty() || stations.containsKey(key) || !(o.optInt("tsid", -1) >= 0 || o.optLong("syncMs") > 0 || o.optBoolean("pilotOk"))) continue
                val s = Station(key, o.optInt("ch"), o.optDouble("centerHz"), o.optLong("firstMs"), o.optLong("lastMs"))
                s.tsid = o.optInt("tsid", -1); s.pilotDb = o.optDouble("pilotDb", 0.0); s.pilotHz = o.optDouble("pilotHz", 0.0); s.topDb = o.optDouble("topDb", Double.NaN)
                s.pilotMs = o.optLong("pilotMs"); s.pilotOk = o.optBoolean("pilotOk"); s.syncMs = o.optLong("syncMs"); s.snrMs = o.optLong("snrMs")
                s.snrDb = if (s.snrMs != 0L) o.optDouble("snrDb", Double.NaN) else Double.NaN; s.sliceSnrDb = if (s.snrMs != 0L) o.optDouble("sliceSnrDb", Double.NaN) else Double.NaN
                o.optJSONObject("rs")?.let { s.rs.ok = it.optInt("ok"); s.rs.corrected = it.optInt("corrected"); s.rs.failed = it.optInt("failed"); s.rs.bytes = it.optInt("bytes") }
                s.fields = o.optInt("fields"); s.airFields = o.optInt("airFields"); s.packets = o.optInt("packets"); s.badPackets = o.optInt("badPackets")
                val secs = o.optJSONArray("sections") ?: JSONArray()
                val bytes = (0 until secs.length()).map { unhex(secs.getString(it)) }
                for (sec in bytes.sortedBy { when (it.u(0)) { 0x00 -> 0; 0xc7 -> 1; 0xc8, 0xc9 -> 2; 0x02 -> 3; else -> 4 } }) runCatching {
                    s.raw["${sec.u(0).toString(16)}/${(sec.u(3) shl 8) or sec.u(4)}/${sec.u(6)}"] = hex(sec)
                    when (sec.u(0)) { 0x00 -> s.pat = parsePat(sec); 0x02 -> parsePmt(sec).let { s.pmts[it.program] = it }; 0xc7 -> s.mgt = parseMgt(sec); 0xc8, 0xc9 -> mergeVct(s, sec); 0xca -> s.rrt = parseRrt(sec) }
                }
                o.optJSONObject("stt")?.let { s.stt = SttRec(it.optLong("utcMs"), it.optInt("offset"), it.optBoolean("ds"), it.optDouble("diffMs"), it.optLong("atMs")) }
                val ev = o.optJSONArray("events") ?: JSONArray()
                for (k in 0 until ev.length()) { val e = ev.getJSONObject(k)
                    val r = EventRec(e.optInt("sourceId"), e.optInt("eventId"), e.optLong("startMs"), e.optInt("seconds"), e.optString("title"), e.optString("text"), e.optString("rating"), e.optString("captions"), e.optInt("table"), e.optLong("seenMs"))
                    s.events["${r.sourceId}/${r.eventId}"] = r }
                o.optJSONObject("etts")?.let { e -> for (k in e.keys()) s.etts[k] = e.getString(k) }
                o.optJSONObject("chanEtt")?.let { e -> for (k in e.keys()) k.toIntOrNull()?.let { s.chanEtt[it] = e.getString(k) } }
                o.optJSONObject("pidStats")?.let { e -> for (k in e.keys()) { val v = e.getJSONArray(k); k.toIntOrNull()?.let { s.pidStats[it] = PidStat(v.optInt(0), v.optInt(1), v.optInt(2), v.optInt(3), v.optDouble(4), v.optDouble(5)) } } }
                val vids = o.optJSONArray("video") ?: JSONArray()
                for (k in 0 until vids.length()) { val v = vids.getJSONObject(k); val q = v.optJSONObject("seq")
                    s.video[v.optInt("pid")] = VideoRow(v.optInt("pid"), q?.let { SeqInfo(it.optInt("width"), it.optInt("height"), it.optInt("aspect"), it.optDouble("frameRate"), it.optLong("bitRate"), it.optBoolean("progressive"), it.optInt("chroma"), it.optInt("profileLevel"), it.optBoolean("intraMatrix")) },
                        v.optString("gop"), v.optInt("pictures"), v.optInt("iPictures")) }
                o.optJSONObject("stills")?.let { e -> for (k in e.keys()) { val m = e.getJSONObject(k); k.toIntOrNull()?.let { s.stills[it] = StillMeta(m.optLong("ms"), m.optBoolean("complete"), m.optInt("mbs"), m.optInt("w"), m.optInt("h"), m.optDouble("dar", 16.0 / 9)) } } }
                stations[key] = s
            }
            if (log.isEmpty()) { val l = j.optJSONArray("log") ?: JSONArray(); for (i in 0 until l.length()) { val o = l.getJSONObject(i); log.add(AtscLogRow(o.optLong("ms"), o.optInt("ch"), o.optString("kind"), o.optString("text"))) } }
            post(true)
        }
    }

    /** The log rows, newest first. */
    fun logRows(): List<AtscLogRow> = synchronized(lock) { log.toList() }

    fun clear() = synchronized(lock) {
        stations.clear(); log.clear(); demux.clear(); stills.clear(); stillGen++; live = null; airSamples = 0.0; decodedSamples = 0.0; cpuMs = 0.0; wallStart = 0; version++; post(true)
    }
}

private fun tableName(tid: Int): String = mapOf(0x00 to "PAT", 0x02 to "PMT", 0xc7 to "MGT", 0xc8 to "TVCT", 0xc9 to "CVCT", 0xca to "RRT", 0xcb to "EIT", 0xcc to "ETT", 0xcd to "STT")[tid] ?: "0x${tid.toString(16)}"
fun videoText(v: SeqInfo): String {
    val fr = if (v.frameRate != 0.0) (if (abs(v.frameRate - Math.round(v.frameRate)) > 0.01) "%.2f".format(java.util.Locale.US, v.frameRate) else "%.0f".format(java.util.Locale.US, v.frameRate)) else ""
    return "${v.width}x${v.height}${if (v.progressive) "p" else "i"} $fr${if (v.aspect == 3) " 16:9" else if (v.aspect == 2) " 4:3" else ""}"
}
