package com.rocketgod.mayhem.core.hamplus

import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.fleet.CwReader
import com.rocketgod.mayhem.core.ham.RealFir
import com.rocketgod.mayhem.core.ham.Resampler
import com.rocketgod.mayhem.core.ham.SubAudioDecoder
import com.rocketgod.mayhem.core.ham.lowpassTaps
import com.rocketgod.mayhem.core.trains.Ddc
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/*
 * HAM+ receiver: every FM channel in the span at once, every open one demodulated.
 *
 * A windowed FFT every buffer measures the power on a 2.5 kHz raster; a per-channel floor (fast down, slow up) gives
 * an SNR, and a carrier opens on the raster point that is the strongest within 7.5 kHz once it passes the threshold
 * (closing 3 dB lower, after 0.4 s below, so a mobile's flutter does not split a transmission). Each open carrier gets
 * a down-converter to about 24 kS/s and a probe: the FM discriminator, whose mean over the transmission is the
 * transmitter's carrier frequency error, a CTCSS / DCS decoder, a Morse reader for CW IDs, the audio envelope, and its
 * audio, kept as 8 kHz mu-law in the time machine and played when the channel is listened to.
 *
 * Probes are capped by what the processor sustains: the time they take is measured and the cap set to fill
 * [BUDGET_MS] a second. A transmission without a probe is marked not recorded; none is dropped silently.
 */

const val PROBE_RATE = 24_000.0
/** Processor time a second the probes may take, and the cap's bounds. */
const val BUDGET_MS = 450.0
const val CAP_MIN = 2
const val CAP_MAX = 32
const val CAP_START = 8
/** A channel stays open this long below its closing level. */
const val CLOSE_HOLD_MS = 400.0
/** Envelope a pair of open channels needs before they are compared for the same audio (1.5 s), the most compared (10 s), and how far either side of the keyup gap the lag is searched (300 ms). */
const val LINK_LIVE_FRAMES = 30
const val LINK_LIVE_MAX = 200
const val LINK_LIVE_LAG = 6
/** Shorter than this is a noise blip, not a transmission. */
const val TX_MIN_MS = 250.0
/** A tone must be heard through this share of a transmission to be its tone. */
const val TONE_SHARE = 0.5
private const val MEASURE_MS = 100.0
private const val SNAP_MS = 500.0
private const val OFF_WIN_MS = 100.0
private const val AUDIO_RATE = 48_000.0

data class HpParams(val thresholdDb: Double = 8.0, val mode: Mode = Mode.MIX, val volume: Double = 1.0) {
    enum class Mode { MIX, NEWEST }
}

private class Offset(val hz: Double, val sd: Double)

private class Probe(rate: Double, offsetHz: Double) {
    val ddc = Ddc(7_500.0, PROBE_RATE, 63)
    val fs: Double
    var oi = FloatArray(0); var oq = FloatArray(0); var au = FloatArray(0); var au2 = FloatArray(0); var a8 = FloatArray(0); var a48 = FloatArray(0)
    val sub: SubAudioDecoder; val cw: CwReader; val lp: RealFir
    val to8: Resampler; val to48: Resampler; val clip = ClipWriter()
    private var pi = 1f; private var pq = 0f; private var deemph = 0.0; private var hp = 0.0; private val de: Double
    /** Discriminator sum over the current 100 ms, the 100 ms means so far, power and the envelope. */
    private var offAcc = 0.0; private var offN = 0; val means = ArrayList<Double>()
    private var envAcc = 0.0; private var envN = 0; val env = ArrayList<Float>()
    private var pow = 0.0; private var powN = 0
    var levelDb = -90.0; var cw0 = ""
    val tones = LinkedHashMap<Double, Int>(); val dcsCodes = LinkedHashMap<Int, Int>(); var subN = 0L
    var out48 = 0

    init {
        ddc.reset(rate); ddc.offsetHz = offsetHz; fs = ddc.outRate
        sub = SubAudioDecoder(fs); cw = CwReader(fs); cw.onText = { t -> cw0 = if (cw0.isNotEmpty()) "$cw0 $t" else t }
        lp = RealFir(lowpassTaps(3_000 / fs, 47))
        to8 = Resampler(CLIP_RATE / fs); to48 = Resampler(AUDIO_RATE / fs)
        de = 1 - exp(-1 / (fs * 530e-6))
    }

    fun retune(offsetHz: Double) { ddc.offsetHz = offsetHz }

    fun push(fi: FloatArray, fq: FloatArray, n: Int, listen: Boolean) {
        val max = ddc.maxOut(n)
        if (oi.size < max) { oi = FloatArray(max); oq = FloatArray(max); au = FloatArray(max); au2 = FloatArray(max); a8 = FloatArray(max); a48 = FloatArray(2 * max + 16) }
        val m = ddc.push(fi, fq, n, oi, oq)
        cw.push(oi, oq, m)
        val win = (fs * OFF_WIN_MS / 1000).roundToInt(); val envWin = (fs * ENV_MS / 1000).roundToInt(); val au = au
        for (i in 0 until m) {
            val a = oi[i]; val b = oq[i]
            val f = atan2((b * pi - a * pq).toDouble(), (a * pi + b * pq).toDouble())
            pi = a; pq = b
            au[i] = f.toFloat()
            offAcc += f
            if (++offN >= win) { means.add(offAcc / offN * fs / (2 * PI)); offAcc = 0.0; offN = 0 }
            pow += (a * a + b * b).toDouble(); powN++
        }
        sub.push(au, m)
        subN += m
        if (sub.tone != 0.0) tones[sub.tone] = (tones[sub.tone] ?: 0) + m
        else if (sub.dcs != 0) dcsCodes[sub.dcs] = (dcsCodes[sub.dcs] ?: 0) + m
        for (i in 0 until m) { deemph += de * (au[i] - deemph); au[i] = (deemph * 0.6).toFloat() }
        lp.process(au, m, au2)
        val a2 = au2; val hpa = 1 - exp(-2 * PI * 300 / fs)
        for (i in 0 until m) {
            // the envelope of the voice band (a one-pole high-pass at 300 Hz keeps the sub-audible tone out of it)
            hp += hpa * (a2[i] - hp); val v = a2[i] - hp
            envAcc += v * v
            if (++envN >= envWin) { env.add(sqrt(envAcc / envN).toFloat()); envAcc = 0.0; envN = 0 }
        }
        val k8 = to8.process(a2, m, a8); clip.push(a8, k8)
        out48 = if (listen) to48.process(a2, m, a48) else 0
        if (powN > fs / 10) { levelDb = 10 * log10(pow / powN + 1e-9); pow = 0.0; powN = 0 }
    }

    /** Carrier offset: the median of the 100 ms means (a burst of clicks moves one mean, not the median), and their spread. */
    fun offset(skip: Int = 0): Offset {
        if (means.size - skip < 3) return Offset(Double.NaN, 0.0)
        val s = means.subList(skip, means.size).sorted()
        val med = s[s.size / 2]; val q1 = s[s.size / 4]; val q3 = s[s.size * 3 / 4]
        return Offset(med, (q3 - q1) / 1.35 / sqrt(s.size.toDouble()))
    }

    /** The tone (or code) heard through most of the transmission: half of it at least, so a moment of voice read as a tone does not count. */
    fun tone(): Double = top(tones, 0.0, subN)
    fun dcs(): Int = if (tone() != 0.0) 0 else top(dcsCodes, 0, subN)
    companion object {
        fun <K> top(m: Map<K, Int>, none: K, total: Long): K { var b = none; var v = 0; for ((k, n) in m) if (n > v) { v = n; b = k }; return if (v >= TONE_SHARE * total) b else none }
    }
}

private class Open(val id: Int, var k: Int, var hz: Long, val startMs: Double, var quietMs: Double, var peak: Double, var snr: Double,
                   var probe: Probe?, var cut: Boolean, var shifted: Boolean, var tileKey: String)

data class HpReplayState(val active: Boolean, val label: String, val kind: String, val clip: Int, val pos: Double, val total: Double)

data class HpStats(
    val onAir: Int, val stations: Int, val probes: Int, val cap: Int, val costMs: Double, val clipS: Long, val clipMB: Double,
    val capMB: Double, val oldestMs: Double, val channels: Int,
)

/** The span's noise: the power the quietest quarter of its channels sit at (a carrier or a hundred barely move it). */
fun quietQuarter(power: FloatArray, count: Int): Float {
    if (count <= 0) return 0f
    val v = power.copyOf(count); v.sort()
    return v[(count - 1) / 4]
}

/** The whole picture, twice a second. */
class HpSnap(
    val now: Double, val centerHz: Long, val rate: Int, val spanLo: Double, val spanHi: Double, val tiles: List<HpTile>,
    val rows: List<HpTxRow>, val convs: List<HpConv>, val heat: HpHeat, val playing: List<String>, val replay: HpReplayState, val stats: HpStats,
)

private class Replay(val mixer: ReplayMixer, val label: String, val kind: String, val to48: Resampler, val buf8: FloatArray, val buf48: FloatArray, var acc: Double)

/**
 * Every call runs under the engine's lock: [onIq] on the DSP thread, the commands ([replayTx], [setPrefs], ...) from
 * the screen. [clock] is the wall clock (ms) and [perf] a monotonic clock (ms) the demod cost is timed with.
 */
class HamPlusEngine(
    private val clock: () -> Double = { System.currentTimeMillis().toDouble() },
    private val perf: () -> Double = { System.nanoTime() / 1e6 },
) : IqProcessor {
    override val wantsFm = false
    override val producesAudio = true

    @Volatile var centerHz = 146_001_250L
    var params = HpParams(); private set
    val tracker: HamTracker
    val clips = ClipStore()
    /** Wall-clock anchoring: the engine's time is the samples it has had; it follows the wall clock when [followClock]. */
    @Volatile var followClock = true
    /** A cap set from outside (tests, a device setting); 0 lets the measurement set it. */
    @Volatile var fixedCap = 0

    private val _snap = MutableStateFlow<HpSnap?>(null)
    val snap: StateFlow<HpSnap?> = _snap.asStateFlow()

    private val lock = Any()
    private var rate = 0; private var samples = 0L; private var baseMs = 0.0
    private var nfft = 4096; private var re = FloatArray(0); private var im = FloatArray(0); private var win = FloatArray(0); private var acc = DoubleArray(0); private var frames = 0
    private var pdb = DoubleArray(0)
    private var fi = FloatArray(0); private var fq = FloatArray(0)
    private var first = 0L; private var count = 0; private var hamBand = BooleanArray(0)
    private var power = FloatArray(0); private var floorDb = FloatArray(0); private var snr = FloatArray(0)
    private val opens = LinkedHashMap<Int, Open>()
    private var nextId = 1
    private var lastMeasure = 0.0; private var lastSnap = 0.0; private var lastCap = 0.0; private var lastLog = 0.0; private var lastCenter = 0L
    /** Probe processing time measured: ms a probe takes per second of signal (smoothed), and the cap it sets. */
    var costMs = 0.0; private set
    var cap = CAP_START; private set
    private var costT = 0.0; private var costSig = 0.0; private var costProbeS = 0.0
    private var outBuf = FloatArray(96_000); private var outLen = 0; private var mix = FloatArray(0)
    private var replay: Replay? = null
    var playing: List<String> = emptyList(); private set

    init { tracker = HamTracker { nowMs() } }

    fun nowMs(): Double = baseMs + samples * 1000.0 / max(1, rate)

    fun setParams(p: HpParams) { synchronized(lock) { params = p } }
    fun setPrefs(p: HpPrefs, labels: Map<String, String>? = null) { synchronized(lock) { tracker.prefs = p; if (labels != null) tracker.labels = labels } }
    fun restore(s: HpSaved?) { synchronized(lock) { tracker.restore(s) } }
    fun save(): HpSaved = synchronized(lock) { tracker.save() }

    override fun reset(rate: Int) { synchronized(lock) { resetLocked(rate) } }

    private fun resetLocked(rate: Int) {
        this.rate = rate; samples = 0; baseMs = clock()
        nfft = 1 shl max(10, min(14, ceil(ln(rate / 1000.0) / ln(2.0)).toInt()))
        re = FloatArray(nfft); im = FloatArray(nfft); acc = DoubleArray(nfft); pdb = DoubleArray(nfft); frames = 0
        win = FloatArray(nfft) { (0.5 - 0.5 * cos(2 * PI * it / (nfft - 1))).toFloat() }
        closeAll(); plan()
        Diag.log("Repeaters: %.2f Msps · %d channels on a %s kHz raster · probe cap %d".format(Locale.US, rate / 1e6, count, (HP_RASTER / 1e3).toString(), cap))
    }

    private fun plan() {
        val half = rate * 0.44 - 6_250
        val f = ceil((centerHz - half) / HP_RASTER).toLong(); val l = floor((centerHz + half) / HP_RASTER).toLong()
        first = f; count = max(0, (l - f + 1).toInt())
        // only the ham bands open channels: a span reaching past a band's edge leaves the rest alone
        hamBand = BooleanArray(count) { hpBandOf(hzOf(it)) != null }
        power = FloatArray(count) { -120f }; floorDb = FloatArray(count) { Float.NaN }; snr = FloatArray(count)
        lastCenter = centerHz
        tracker.setSpan(centerHz - half, centerHz + half)
    }

    private fun hzOf(k: Int): Long = (first + k) * HP_RASTER

    override fun onIq(iq: ByteArray, len: Int, rate: Int) { synchronized(lock) { onIqLocked(iq, len, rate) } }

    private fun onIqLocked(iq: ByteArray, len: Int, rate: Int) {
        if (rate != this.rate) resetLocked(rate)
        if (centerHz != lastCenter) { closeAll(); acc.fill(0.0); frames = 0; plan() }
        val n = len / 2
        if (fi.size < n) { fi = FloatArray(n); fq = FloatArray(n) }
        for (k in 0 until n) { fi[k] = (iq[2 * k].toInt() and 0xff) - 127.5f; fq[k] = (iq[2 * k + 1].toInt() and 0xff) - 127.5f }
        val nn = nfft; val step = max(nn, n / 4)
        var off = 0
        while (off + nn <= n && frames < 16) {
            for (k in 0 until nn) { re[k] = fi[off + k] * win[k]; im[k] = fq[off + k] * win[k] }
            Dsp.fft(re, im)
            for (k in 0 until nn) acc[k] += (re[k] * re[k] + im[k] * im[k]).toDouble()
            frames++; off += step
        }
        samples += n
        if (followClock && abs(nowMs() - clock()) > 3_000) baseMs = clock() - samples * 1000.0 / this.rate
        val now = nowMs()
        if (now - lastMeasure >= MEASURE_MS && frames > 0) { lastMeasure = now; measure(now) }
        runProbes(n, now)
        if (now - lastSnap >= SNAP_MS) { lastSnap = now; _snap.value = snapshotLocked(now) }
    }

    /** Channel powers, floors, SNRs; carriers open and close. */
    private fun measure(now: Double) {
        val nn = nfft; val binHz = rate.toDouble() / nn; val half = max(1, (4_000 / binHz).roundToInt()); val p = params
        for (k in 0 until nn) pdb[(k + nn / 2) % nn] = acc[k] / frames
        acc.fill(0.0); frames = 0
        for (k in 0 until count) {
            val c = ((hzOf(k) - centerHz) / binHz).roundToInt() + nn / 2
            var s = 0.0; var cnt = 0
            for (b in max(1, c - half)..min(nn - 2, c + half)) { s += pdb[b]; cnt++ }
            val db = (10 * log10(s / max(1, cnt) + 1e-12)).toFloat()
            power[k] = db
        }
        // each channel's floor is kept against the span's own noise (its quietest quarter), so a gain change (AGC, LNA, amp)
        // that lifts the whole span moves no channel: only a carrier rises above its neighbors
        val common = quietQuarter(power, count)
        for (k in 0 until count) {
            val rel = power[k] - common
            val f = floorDb[k]
            floorDb[k] = if (f.isNaN()) rel else if (rel < f) f + 0.3f * (rel - f) else f + 0.004f * (rel - f)
            snr[k] = rel - floorDb[k]
        }
        fun nearDc(k: Int) = abs(hzOf(k) - centerHz) < 6_000
        // open channels: still above the closing level near their raster point?
        for (o in opens.values.toList()) {
            var best = -99.0
            for (d in -1..1) { val j = o.k + d; if (j in 0 until count) best = max(best, snr[j].toDouble()) }
            o.snr = best; o.peak = max(o.peak, best)
            if (best > p.thresholdDb - 3) o.quietMs = 0.0
            else if (o.quietMs == 0.0) o.quietMs = now
            else if (now - o.quietMs >= CLOSE_HOLD_MS) close(o, o.quietMs)
        }
        // new carriers: over the threshold, the strongest raster point within 7.5 kHz, clear of the open ones
        for (k in 0 until count) {
            if (snr[k] <= p.thresholdDb || nearDc(k) || !hamBand[k]) continue
            var peak = true
            for (d in -3..3) { val j = k + d; if (d != 0 && j in 0 until count && power[j] > power[k]) { peak = false; break } }
            if (!peak) continue
            if (opens.values.any { abs(it.k - k) <= 4 }) continue
            openAt(k, now)
        }
    }

    private fun tileKey(hz: Long): String = chanKey(tracker.tileHz(hz))
    private fun wanted(key: String): Boolean { val pr = tracker.prefs; return pr.hold == key || key in pr.prio }
    private fun probes(): Int = opens.values.count { it.probe != null }

    private fun openAt(k: Int, now: Double) {
        val hz = hzOf(k); val key = tileKey(hz)
        val o = Open(nextId++, k, hz, now - MEASURE_MS, 0.0, snr[k].toDouble(), snr[k].toDouble(), null, false, false, key)
        if (fixedCap != 0) cap = fixedCap
        if (probes() >= cap && wanted(key)) {
            // a followed or priority channel takes the probe of the newest other one, which is then marked cut
            val victim = opens.values.filter { it.probe != null && !wanted(it.tileKey) }.maxByOrNull { it.startMs }
            if (victim != null) { victim.probe = null; victim.cut = true }
        }
        if (probes() < cap) o.probe = Probe(rate.toDouble(), (hz - centerHz).toDouble())
        opens[o.id] = o
    }

    private fun close(o: Open, endMs: Double) {
        opens.remove(o.id)
        if (endMs - o.startMs < TX_MIN_MS) return
        val p = o.probe
        val off = p?.offset(2) ?: Offset(Double.NaN, 0.0)
        p?.cw?.end()
        val recorded = p != null && !o.cut
        val tone = p?.tone() ?: 0.0
        val envN = ceil((endMs - o.startMs) / ENV_MS).toInt()
        val env = p?.env?.let { e -> FloatArray(min(e.size, envN)) { e[it] } } ?: FloatArray(0)
        val t = TxRec(o.id, o.hz, o.startMs, endMs, (o.peak * 10).roundToInt() / 10.0, off.hz, off.sd,
            tone, p?.dcs() ?: 0, p?.cw0 ?: "", env, recorded)
        if (recorded) {
            val data = p!!.clip.done()
            clips.add(Clip(o.id, o.hz, o.startMs, data.copyOf(min(data.size, ((endMs - o.startMs) * CLIP_RATE / 1000).roundToInt()))))
        }
        tracker.addTx(t)
    }

    private fun closeAll() { val now = nowMs(); for (o in opens.values.toList()) close(o, now) }

    /** Pairs of open channels (by id) heard carrying the same audio right now: linked repeaters. */
    private val liveLinked = HashSet<String>()
    private var linkAt = 0.0
    /** Four times a second: open channels that keyed up together are compared, their audio envelopes at a lag near the keyup gap. */
    private fun checkLinks(now: Double) {
        if (now - linkAt < 250) return
        linkAt = now
        val os = opens.values.filter { it.probe != null && it.probe!!.env.size >= LINK_LIVE_FRAMES }
        val ids = os.map { it.id }.toSet()
        liveLinked.removeAll { k -> k.split('|').map { it.toInt() }.any { it !in ids } }
        for (i in os.indices) for (j in i + 1 until os.size) {
            val (x, y) = if (os[i].startMs <= os[j].startMs) os[i] to os[j] else os[j] to os[i]
            if (abs(x.hz - y.hz) < 50_000 || y.startMs - x.startMs > LINK_EDGE_MS || x.tileKey == y.tileKey) continue
            val key = "${x.id}|${y.id}"; if (key in liveLinked) continue
            val r = envCorr(x.probe!!.env.take(LINK_LIVE_MAX).toFloatArray(), y.probe!!.env.take(LINK_LIVE_MAX).toFloatArray(), ((y.startMs - x.startMs) / ENV_MS).roundToInt(), LINK_LIVE_LAG)
            if (r >= LINK_CORR) liveLinked.add(key)
        }
        tracker.liveLinks = liveLinked.mapNotNull { k -> val (a, b) = k.split('|').map { it.toInt() }; val oa = opens[a]; val ob = opens[b]; if (oa != null && ob != null) listOf(oa.tileKey, ob.tileKey).sorted().joinToString("|") else null }.toSet()
    }
    /** Two open channels carry the same audio: heard linked right now, or a link learned before. */
    private fun linkedNow(a: Open, b: Open): Boolean = "${a.id}|${b.id}" in liveLinked || "${b.id}|${a.id}" in liveLinked || tracker.linked(a.tileKey, b.tileKey)

    /**
     * Which open channels are heard: the followed one alone; else priority ones when open; else all (mix) or the newest.
     * Linked repeaters carry the same voice a little apart, an echo when mixed: only one copy is heard, the stronger.
     */
    private fun listenSet(): List<Open> {
        val pr = tracker.prefs
        var c = opens.values.filter { it.probe != null && it.tileKey !in pr.mute }
        // a repeater input is the same voice as its output: the output is heard
        val c0 = c
        c = c0.filter { o -> !(tracker.outputOf(o.hz) != 0L && c0.any { x -> x.tileKey == o.tileKey && x !== o }) }
        if (pr.hold.isNotEmpty()) return c.filter { it.tileKey == pr.hold }
        val pri = c.filter { it.tileKey in pr.prio }
        if (pri.isNotEmpty()) c = pri
        val one = ArrayList<Open>()
        for (o in c.sortedByDescending { it.snr }) if (one.none { linkedNow(it, o) }) one.add(o)
        c = one.sortedBy { it.startMs }
        return if (params.mode == HpParams.Mode.NEWEST) c.takeLast(1) else c.takeLast(4)
    }

    private fun runProbes(n: Int, now: Double) {
        checkLinks(now)
        val listen = if (replay != null) emptyList() else listenSet()
        playing = listen.map { it.tileKey }
        val t0 = perf()
        var voices = 0; var m = 0; var probes = 0
        for (o in opens.values) {
            val p = o.probe ?: continue
            probes++
            val hear = listen.any { it === o }
            p.push(fi, fq, n, hear)
            // a carrier that is off its raster point by more than half a step moves to the right one, once
            if (!o.shifted && now - o.startMs > 500) {
                o.shifted = true
                val off = p.offset(1)
                if (abs(off.hz) > HP_RASTER / 2.0) {
                    val steps = (off.hz / HP_RASTER).roundToInt(); val shift = steps * HP_RASTER
                    o.k += steps; o.hz += shift; o.tileKey = tileKey(o.hz); p.retune((o.hz - centerHz).toDouble())
                    for (i in p.means.indices) p.means[i] -= shift.toDouble()
                }
            }
            if (hear && p.out48 > 0) {
                if (mix.size < p.out48) mix = mix.copyOf(2 * p.out48)
                if (voices == 0) { System.arraycopy(p.a48, 0, mix, 0, p.out48); m = p.out48 } else for (i in 0 until min(m, p.out48)) mix[i] += p.a48[i]
                voices++
            }
        }
        val dt = perf() - t0
        if (probes > 0) { costT += dt; costSig += n.toDouble() / rate; costProbeS += probes * n.toDouble() / rate }
        if (now - lastCap > 2_000 && costProbeS > 0.5) {
            lastCap = now
            val per = costT / costProbeS
            costMs = if (costMs != 0.0) 0.7 * costMs + 0.3 * per else per
            cap = if (fixedCap != 0) fixedCap else max(CAP_MIN, min(CAP_MAX, floor(BUDGET_MS / max(0.1, costMs)).toInt()))
            costT = 0.0; costSig = 0.0; costProbeS = 0.0
            if (now - lastLog > 30_000) {
                lastLog = now
                Diag.log("Repeaters: demod cost %.1f ms per channel per second at %.2f Msps, cap %d channels".format(Locale.US, costMs, rate / 1e6, cap))
            }
        }
        if (replay != null) { replayStep(n); return }
        if (voices == 0) return
        val g = params.volume / sqrt(voices.toDouble())
        for (i in 0 until m) out(mix[i] * g)
    }

    private fun out(v: Double) {
        if (outLen >= outBuf.size) outLen = 0
        outBuf[outLen++] = (if (v > 1) 1.0 else if (v < -1) -1.0 else v).toFloat()
    }

    override fun drainAudio(dst: FloatArray, max: Int): Int = synchronized(lock) {
        val k = min(max, outLen)
        System.arraycopy(outBuf, 0, dst, 0, k)
        if (k < outLen) System.arraycopy(outBuf, k, outBuf, 0, outLen - k)
        outLen -= k
        k
    }

    /** Replays: one transmission, the transmissions of a conversation, or the whole band from a moment on. */
    fun replayTx(ids: List<Int>, label: String, kind: String): Boolean = synchronized(lock) {
        val cs = ids.mapNotNull { clips.get(it) }
        if (cs.isEmpty()) return@synchronized false
        val parts = planReplay(cs).map { MixPart(it.id, it.at, clips.get(it.id)!!.data) }
        replay = Replay(ReplayMixer(parts, params.volume), label, kind, Resampler(AUDIO_RATE / CLIP_RATE), FloatArray(4096), FloatArray(4096 * 6 + 16), 0.0)
        true
    }

    /** The band from a moment on; after the last transmission, from the last one heard. False only when nothing is kept. */
    fun replayFrom(ms: Double): Boolean {
        val (ids, from) = synchronized(lock) { replayFromPlan(clips.all().map { ClipSpan(it.id, it.startMs, it.startMs + it.data.size * 1000.0 / CLIP_RATE) }, ms) }
        return replayTx(ids, "the band from ${SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(from.toLong()))}", "band")
    }

    fun stopReplay() { synchronized(lock) { replay = null } }
    /** Forgets everything heard: the channels, stations, pairs, links, the activity map and the time machine. */
    fun clear() { synchronized(lock) { replay = null; tracker.clear(); tracker.heat = HpHeat(); clips.clear() } }

    private fun replayStep(n: Int) {
        val r = replay ?: return
        r.acc += n.toDouble() * CLIP_RATE / rate
        while (r.acc >= 1) {
            val k = min(r.buf8.size, floor(r.acc).toInt()); r.acc -= k
            val got = r.mixer.next(r.buf8, k)
            val q = r.to48.process(r.buf8, got, r.buf48)
            for (i in 0 until q) out(r.buf48[i].toDouble())
            if (r.mixer.done) { replay = null; return }
        }
    }

    fun replayState(): HpReplayState = synchronized(lock) { replayStateLocked() }

    private fun replayStateLocked(): HpReplayState {
        val r = replay ?: return HpReplayState(false, "", "", -1, 0.0, 0.0)
        return HpReplayState(true, r.label, r.kind, r.mixer.current(), r.mixer.pos.toDouble() / CLIP_RATE, r.mixer.total.toDouble() / CLIP_RATE)
    }

    /** The channels open now, as the tracker takes them. */
    private fun liveRecs(): List<LiveRec> = opens.values.map { o ->
        val p = o.probe
        val off = p?.offset(2) ?: Offset(Double.NaN, 0.0)
        LiveRec(o.id, o.hz, o.startMs, (o.snr * 10).roundToInt() / 10.0, if (p != null) p.levelDb.roundToInt().toDouble() else -90.0, off.hz,
            p?.tone() ?: 0.0, p?.dcs() ?: 0, p != null && !o.cut)
    }

    /** The whole picture now; the engine also publishes it on [snap] twice a second. */
    fun snapshot(): HpSnap = synchronized(lock) { snapshotLocked(nowMs()) }

    private fun snapshotLocked(now: Double): HpSnap {
        val tr = tracker
        tr.setLive(liveRecs()); tr.judge(now)
        val rows = tr.rows(now, 400)
        for (r in rows) r.recorded = r.recorded && (r.live || clips.has(r.id))
        val convs = tr.convs(rows, now).take(80)
        val tiles = tr.tiles(now, rows)
        return HpSnap(now, centerHz, rate, tr.spanLo, tr.spanHi, tiles, rows, convs, tr.heat.copy(), playing, replayStateLocked(),
            HpStats(opens.size, tr.stationCount, probes(), cap, (costMs * 10).roundToInt() / 10.0, clips.seconds.roundToInt().toLong(),
                (clips.bytes / 1e5).roundToInt() / 10.0, (clips.cap / 1e5).roundToInt() / 10.0, clips.oldestMs(), count))
    }
}
