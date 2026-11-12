package com.rocketgod.mayhem.core.trains

import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs
import kotlin.math.max

/** An end-of-train (or distributed power) unit, live. */
data class EotUnit(
    val unit: Int, val channel: String, val firstMs: Long, val lastMs: Long, val frames: Int, val last: EotPacket,
    /** (time, psig) of recent frames, oldest first. */
    val pressure: List<Pair<Long, Int>>, val snr: List<Int>,
    /** When a HOT command naming this unit was last heard (0: never). */
    val hotMs: Long = 0L,
)

/** A HOT transmission heard, with the EOT unit it names when one of the units on the board appears in its data. */
data class HotHeard(val ms: Long, val frame: HotFrame, val unit: Int?, val snrDb: Int)

/** A PTC station (one channel), live. */
data class PtcStation(
    val hz: Long, val kind: Kind, val firstMs: Long, val lastMs: Long, val bursts: Int,
    /** Seconds between its recent bursts, oldest first. */
    val gaps: List<Double>, val lastSymbols: Int, val changes: Int, val lastChangeMs: Long, val snr: List<Int>,
    /** Its last payload's first symbols, drawn as a fingerprint. */
    val print: IntArray, val times: List<Long>,
    /** Bursts in a row with the same content as the one before (a wayside repeating its status), and how many of its
     *  bursts had new content: a base station's beacon changes every time, a wayside's only when its status does. */
    val steady: Int = 0, val differed: Int = 0,
    /** Its transmitter's carrier off the channel (Hz, smoothed), the burst lengths it sends, its strongest burst, and
     *  its last message in full (symbols after the sync). */
    val carrierHz: Double = 0.0, val lengths: List<Int> = emptyList(), val snrMax: Int = 0, val last: IntArray = IntArray(0),
) {
    /** The first symbols after the shared sync, which differ station to station: its own header. */
    val header: String get() = PtcScanner.symHex(last, 0, 16)
    /** Its content changes on nearly every burst (a beacon with a running counter), so a change means nothing. */
    val varies: Boolean get() = bursts >= 4 && differed * 2 > bursts
    enum class Kind(val label: String) { WAYSIDE("WAYSIDE"), BASE("BASE STATION"), LOCOMOTIVE("LOCOMOTIVE"), OTHER("PTC") }
    /** The most common gap (its beacon period or slot cycle), or 0 before two gaps. */
    fun period(): Double {
        if (gaps.size < 2) return 0.0
        val s = gaps.sorted(); return s[s.size / 2]
    }
}

/**
 * Trains: one receiver for the railroad's radios. EOT mode sits between 452.9375 and 457.9375 MHz and decodes the end
 * and head units (and DPU traffic) at once where the radio is wide enough; PTC mode watches 216-222.5 MHz for the
 * train-control network: base stations, wayside units and locomotives. Receive only.
 */
class TrainsProcessor(private val log: PacketLog) : IqProcessor {
    enum class Band { EOT, PTC }
    @Volatile var band = Band.EOT
    var centerOf: () -> Long = { 0L }
    var now: () -> Long = { System.currentTimeMillis() }
    var onNote: ((String) -> Unit)? = null

    private val _units = MutableStateFlow<List<EotUnit>>(emptyList()); val units: StateFlow<List<EotUnit>> = _units.asStateFlow()
    private val _hots = MutableStateFlow<List<HotHeard>>(emptyList()); val hots: StateFlow<List<HotHeard>> = _hots.asStateFlow()
    private val _stations = MutableStateFlow<List<PtcStation>>(emptyList()); val stations: StateFlow<List<PtcStation>> = _stations.asStateFlow()
    /** Carrier activity on the EOT/HOT/DPU channels: when each was last on the air (ms), for the channel lamps. */
    private val _activity = MutableStateFlow<Map<String, Long>>(emptyMap()); val activity: StateFlow<Map<String, Long>> = _activity.asStateFlow()
    private val _ptcOther = MutableStateFlow(0); val ptcOther: StateFlow<Int> = _ptcOther.asStateFlow()
    /** Every EOT frame and every PTC burst, for tests and tools. */
    var onEot: ((EotPacket, String) -> Unit)? = null
    var onPtc: ((PtcBurst) -> Unit)? = null

    private val unitMap = LinkedHashMap<Int, EotUnit>()
    private val stationMap = LinkedHashMap<Long, PtcStation>()
    private val lastPayload = HashMap<Long, IntArray>()
    private val lastLogMs = HashMap<Long, Long>()
    private var rate = 0; private var lastCenter = Long.MIN_VALUE
    private var fi = FloatArray(0); private var fq = FloatArray(0)

    // ---- EOT side ----
    private inner class Chan(val name: String, val hz: Long) {
        val ddc = Ddc(7_000.0, 24_000.0)
        val rx = FfskRx { b -> eot.push(b); eotInv.push(1 - b); hot.push(b) }
        val eot = EotParser { p -> eotFrame(p, this) }
        val eotInv = EotParser { p -> eotFrame(p, this) }
        val hot = HotParser { f -> hotFrame(f, this) }
        var on = false
        var oi = FloatArray(0); var oq = FloatArray(0)
        var lastSeenMs = 0L; var lastFrame = ""; var lastFrameMs = 0L
    }
    private val chans = listOf(Chan("EOT", EOT_HZ), Chan("HOT", HOT_HZ), Chan("DPU", DPU_HZ))

    // ---- PTC side ----
    private val ptc = PtcScanner { b -> ptcBurst(b) }
    var ptcTrace: ((String) -> Unit)?
        get() = ptc.trace
        set(v) { ptc.trace = v }

    override fun reset(rate: Int) {
        this.rate = rate
        val c = centerOf()
        for (ch in chans) {
            ch.ddc.reset(rate.toDouble()); ch.ddc.offsetHz = (ch.hz - c).toDouble()
            ch.on = abs(ch.hz - c) < rate * 0.45 - 8_000
            ch.rx.reset(ch.ddc.outRate)
        }
        lastCenter = c
        ptc.centerOf = centerOf; ptc.now = now
        ptc.reset(rate)
    }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (rate != this.rate) reset(rate)
        val n = len / 2
        if (fi.size < n) { fi = FloatArray(n); fq = FloatArray(n) }
        for (k in 0 until n) { fi[k] = (iq[2 * k].toInt() and 0xff) - 127.4f; fq[k] = (iq[2 * k + 1].toInt() and 0xff) - 127.4f }
        if (band == Band.EOT) {
            val c = centerOf()
            if (c != lastCenter) { lastCenter = c; for (ch in chans) ch.on = abs(ch.hz - c) < rate * 0.45 - 8_000 }
            for (ch in chans) {
                if (!ch.on) continue
                ch.ddc.offsetHz = (ch.hz - c).toDouble()
                val need = ch.ddc.maxOut(n)
                if (ch.oi.size < need) { ch.oi = FloatArray(need); ch.oq = FloatArray(need) }
                val m = ch.ddc.push(fi, fq, n, ch.oi, ch.oq)
                ch.rx.push(ch.oi, ch.oq, m)
                if (ch.rx.snrDb() >= 8) {
                    val t = now()
                    if (t - ch.lastSeenMs > 300) { ch.lastSeenMs = t; _activity.value = _activity.value + (ch.name to t) }
                }
            }
        } else ptc.push(fi, fq, n)
    }

    /** Which of the channels this tuning hears. */
    fun hears(): List<String> = chans.filter { it.on }.map { it.name }

    private fun eotFrame(p: EotPacket, ch: Chan) {
        val t = now()
        // each frame is sent twice and both polarities are tried: one report per frame
        if (p.bits == ch.lastFrame && t - ch.lastFrameMs < 1500) return
        ch.lastFrame = p.bits; ch.lastFrameMs = t
        onEot?.invoke(p, ch.name)
        val snr = ch.rx.snrDb()
        val old = unitMap[p.unit]
        val u = if (old == null) EotUnit(p.unit, ch.name, t, t, 1, p, listOf(t to p.psig), listOf(snr))
            else old.copy(lastMs = t, frames = old.frames + 1, last = p, channel = ch.name,
                pressure = (old.pressure + (t to p.psig)).takeLast(90), snr = (old.snr + snr).takeLast(40))
        unitMap[p.unit] = u
        _units.value = unitMap.values.sortedByDescending { it.lastMs }
        val chName = if (ch.name == "DPU") "DPU 457.925" else "EOT 457.9375"
        log.add("$chName unit ${p.unit} · ${p.psig} psig · ${if (p.motion) "MOVING" else "stopped"} · marker ${if (p.markerLight) "on" else "off"} · battery ${p.batteryPct}% ${p.batteryCond}${if (p.arm != "NORMAL") " · ${p.arm}" else ""}")
    }

    private fun hotFrame(f: HotFrame, ch: Chan) {
        val t = now()
        val key = "%016X".format(f.block)
        if (key == ch.lastFrame && t - ch.lastFrameMs < 1500) return
        ch.lastFrame = key; ch.lastFrameMs = t
        // a unit on the board whose 17-bit address shows up in the command (either bit order) is the one addressed
        val unit = unitMap.keys.firstOrNull { inData(f.data, it) }
        _hots.value = (listOf(HotHeard(t, f, unit, ch.rx.snrDb())) + _hots.value).take(30)
        if (unit != null) unitMap[unit]?.let { unitMap[unit] = it.copy(hotMs = t); _units.value = unitMap.values.sortedByDescending { u -> u.lastMs } }
        log.add("HOT ${if (ch.name == "HOT") "452.9375" else ch.name} · command %08X%s · %d of 3 copies agree%s".format(f.data,
            if (unit != null) " → unit $unit" else "", f.agree, if (f.parityOk) "" else " · parity?"))
    }

    private fun ptcBurst(b: PtcBurst) {
        onPtc?.invoke(b)
        if (!b.isPtc) { _ptcOther.value = ptc.others; return }
        val t = b.ms
        val old = stationMap[b.hz]
        val prev = lastPayload[b.hz]
        val differ = prev != null && differs(prev, b.payload)
        // a change of status: new content from a station that had been repeating itself
        val changed = differ && old != null && old.steady >= 1
        lastPayload[b.hz] = b.payload
        val s = if (old == null) PtcStation(b.hz, kindOf(b.hz), t, t, 1, emptyList(), b.symbols, 0, 0L, listOf(b.snrDb), b.payload.take(24).toIntArray(), listOf(t),
                carrierHz = b.carrierHz, lengths = listOf(b.symbols), snrMax = b.snrDb, last = b.payload)
            else old.copy(lastMs = t, bursts = old.bursts + 1, gaps = (old.gaps + (t - old.lastMs) / 1000.0).takeLast(12), lastSymbols = b.symbols,
                changes = old.changes + if (changed) 1 else 0, lastChangeMs = if (changed) t else old.lastChangeMs, snr = (old.snr + b.snrDb).takeLast(40),
                print = b.payload.take(24).toIntArray(), times = (old.times + t).filter { t - it < 300_000 }.takeLast(200),
                steady = if (prev != null && !differ) old.steady + 1 else 0, differed = old.differed + if (differ) 1 else 0,
                carrierHz = old.carrierHz + 0.2 * (b.carrierHz - old.carrierHz),
                lengths = (old.lengths + b.symbols).distinct().sorted().takeLast(8), snrMax = max(old.snrMax, b.snrDb), last = b.payload)
        stationMap[b.hz] = s
        _stations.value = stationMap.values.sortedWith(compareBy<PtcStation> { it.kind.ordinal }.thenBy { it.hz })
        val quiet = old != null && t - (lastLogMs[b.hz] ?: 0L) < 30_000
        if (old == null || changed || (s.kind == PtcStation.Kind.LOCOMOTIVE && !quiet)) {
            lastLogMs[b.hz] = t
            log.add("PTC %.4f %s · %d symbols · +%d dB%s".format(b.hz / 1e6, s.kind.label, b.symbols, b.snrDb,
                when { old == null -> " · new station"; changed -> " · STATUS CHANGED"; else -> "" }))
        }
    }

    fun clear() {
        unitMap.clear(); stationMap.clear(); lastPayload.clear(); lastLogMs.clear()
        _units.value = emptyList(); _stations.value = emptyList(); _hots.value = emptyList(); _activity.value = emptyMap(); _ptcOther.value = 0
    }

    companion object {
        const val EOT_HZ = 457_937_500L
        const val HOT_HZ = 452_937_500L
        const val DPU_HZ = 457_925_000L
        /** EOT mode on a wide radio: between the two, both 2.5 MHz off the center (clear of its spike). */
        const val EOT_CENTER = 455_437_500L
        const val EOT_RATE = 6_000_000
        /** A narrow radio hears the end unit and DPU, 250 kHz above them. */
        const val EOT_NARROW = 457_687_500L
        const val PTC_CENTER = 219_256_250L   // between raster channels: no station sits on the spike at the center
        const val PTC_RATE = 8_000_000
        /** A narrow radio watches the base and wayside channels heard most. */
        const val PTC_NARROW = 220_106_250L

        fun kindOf(hz: Long): PtcStation.Kind = when {
            hz in 217_000_000L until 220_000_000L -> PtcStation.Kind.WAYSIDE
            hz in 220_000_000L until 221_000_000L -> PtcStation.Kind.BASE
            hz in 221_000_000L until 222_000_000L -> PtcStation.Kind.LOCOMOTIVE
            else -> PtcStation.Kind.OTHER
        }

        /** More than a few symbols apart (a symbol error or two is not a change of status). */
        fun differs(a: IntArray, b: IntArray): Boolean {
            val n = minOf(a.size, b.size); if (n < 8) return a.size != b.size
            var d = 0; for (i in 0 until n) if (a[i] != b[i]) d++
            return d > max(3, n / 12) || abs(a.size - b.size) > 4
        }

        fun inData(data: Int, unit: Int): Boolean {
            for (o in 0..13) {
                val w = (data ushr o) and 0x1FFFF
                if (w == unit) return true
                if (Integer.reverse(w) ushr 15 == unit) return true
            }
            return false
        }
    }
}
