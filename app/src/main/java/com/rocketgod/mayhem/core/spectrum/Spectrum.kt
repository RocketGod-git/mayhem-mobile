package com.rocketgod.mayhem.core.spectrum

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.usb.HackRfOne
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The Spectrum app: a bench spectrum analyzer and its zero-span (waveform) mode.
 *
 * FREQ: center and span (or start and stop), RBW, VBW, reference level and scale, four traces (live, max hold, min
 * hold, average, view), four markers with delta and peak search, channel power, occupied bandwidth, ACPR and the noise
 * floor, and a persistence display. Spans wider than the radio sweep, with the Looking Glass's stepping.
 * ZERO SPAN: one frequency through a chosen filter, its amplitude, instantaneous frequency and phase over time, with a
 * level trigger, pre-trigger, single shot, two cursors and pulse measurements.
 *
 * The DSP runs on the engine's thread ([SpectrumProcessor]); the traces, markers and measurements are done here, on the
 * main thread, on what it sends. This object is the state and logic of the web app's SpectrumUi
 * (web/src/spectrum-ui.ts); ui/SpectrumScreen.kt draws it. Settings persist under `mayhem.spectrum`.
 */

enum class SpMode { FREQ, ZERO }
enum class Meas(val label: String) { OFF("OFF"), CHP("CH PWR"), OBW("OBW"), ACPR("ACPR"), NOISE("NOISE") }
enum class SpUnit(val label: String) { DBM("dBm"), DBFS("dBFS") }

/** A span preset: its label and width, Hz. */
val SPAN_PRESETS: List<Pair<String, Double>> = listOf("100k" to 1e5, "1M" to 1e6, "2M" to 2e6, "10M" to 1e7, "20M" to 2e7, "100M" to 1e8, "1G" to 1e9)
/** dB per division. */
val DIVS: List<Int> = listOf(1, 2, 5, 10, 20)
/** Zero-span sweep times, s (1-2-5 from 100 µs to 10 s). */
val SWEEP_TIMES: List<Double> = listOf(1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0)
private const val KEY = "mayhem.spectrum"
/** Frames a marker's readout averages over: steady to read, still quick to follow a change. */
const val MARKER_AVG = 16

/** One trace's saved settings. */
class TraceSet(var mode: TraceMode, var avgN: Int)

/** Everything the screen remembers (the web's Settings). */
class SpSettings(var dial: Double) {
    var mode = SpMode.FREQ
    var center = if (dial > 0) dial else 433.92e6
    var span = 2e6
    var startStop = false
    var rbwAuto = true; var rbw = 3000.0
    var vbwAuto = true; var vbw = 3000.0
    var window = WindowKind.HANN
    var ref = -20; var div = 10
    var unit = SpUnit.DBM
    var det = Detector.PEAK
    var cal = 0
    val traces: MutableList<TraceSet> = defaultTraces().map { TraceSet(it.mode, 10) }.toMutableList()
    val markers: MutableList<Marker> = defaultMarkers().toMutableList()
    var active = 0
    var meas = Meas.OFF; var chBw = 25_000.0; var spacing = 25_000.0
    var persist = false
    // zero span
    var zsFreq = if (dial > 0) dial else 433.92e6
    var zsBw = 100_000.0; var zsTime = 0.02; var trig = TrigMode.FREE; var single = false; var level = -60; var pre = 0.1
    var showAmp = true; var showFm = true; var showPh = false; var cursors = false; var curA = 0.25; var curB = 0.75

    fun toJson(): JSONObject = JSONObject().apply {
        put("mode", mode.name); put("center", center); put("span", span); put("startStop", startStop)
        put("rbwAuto", rbwAuto); put("rbw", rbw); put("vbwAuto", vbwAuto); put("vbw", vbw); put("window", window.name)
        put("ref", ref); put("div", div); put("unit", if (unit == SpUnit.DBM) "dBm" else "dBFS"); put("det", det.name); put("cal", cal)
        put("traces", JSONArray().apply { for (t in traces) put(JSONObject().put("mode", t.mode.name).put("avgN", t.avgN)) })
        put("markers", JSONArray().apply { for (m in markers) put(JSONObject().put("on", m.on).put("hz", m.hz).put("delta", m.delta).put("trace", m.trace)) })
        put("active", active); put("meas", meas.name); put("chBw", chBw); put("spacing", spacing); put("persist", persist)
        put("zsFreq", zsFreq); put("zsBw", zsBw); put("zsTime", zsTime); put("trig", trig.name); put("single", single); put("level", level); put("pre", pre)
        put("showAmp", showAmp); put("showFm", showFm); put("showPh", showPh); put("cursors", cursors); put("curA", curA); put("curB", curB)
    }

    /** Whatever of [j] reads cleanly replaces the default (a bad or missing field keeps it). */
    fun fromJson(j: JSONObject) {
        fun <T> opt(k: String, f: (String) -> T): T? = if (j.has(k)) runCatching { f(k) }.getOrNull() else null
        opt("mode") { SpMode.valueOf(j.getString(it)) }?.let { mode = it }
        opt("center") { j.getDouble(it) }?.let { center = it }
        opt("span") { j.getDouble(it) }?.let { span = it }
        opt("startStop") { j.getBoolean(it) }?.let { startStop = it }
        opt("rbwAuto") { j.getBoolean(it) }?.let { rbwAuto = it }
        opt("rbw") { j.getDouble(it) }?.let { rbw = it }
        opt("vbwAuto") { j.getBoolean(it) }?.let { vbwAuto = it }
        opt("vbw") { j.getDouble(it) }?.let { vbw = it }
        opt("window") { WindowKind.valueOf(j.getString(it)) }?.let { window = it }
        opt("ref") { j.getInt(it) }?.let { ref = it }
        opt("div") { j.getInt(it) }?.let { if (it in DIVS) div = it }
        opt("unit") { if (j.getString(it) == "dBFS") SpUnit.DBFS else SpUnit.DBM }?.let { unit = it }
        opt("det") { Detector.valueOf(j.getString(it)) }?.let { det = it }
        opt("cal") { j.getInt(it) }?.let { cal = it }
        opt("traces") { j.getJSONArray(it) }?.takeIf { it.length() == TRACE_COUNT }?.let { a ->
            for (i in 0 until TRACE_COUNT) runCatching { val o = a.getJSONObject(i); traces[i] = TraceSet(TraceMode.valueOf(o.getString("mode")), o.getInt("avgN")) }
        }
        opt("markers") { j.getJSONArray(it) }?.takeIf { it.length() == MARKER_COUNT }?.let { a ->
            for (i in 0 until MARKER_COUNT) runCatching {
                val o = a.getJSONObject(i)
                markers[i] = Marker(o.getBoolean("on"), o.getDouble("hz"), o.getBoolean("delta"), o.getInt("trace").coerceIn(0, TRACE_COUNT - 1))
            }
        }
        opt("active") { j.getInt(it) }?.let { active = it.coerceIn(0, MARKER_COUNT - 1) }
        opt("meas") { Meas.valueOf(j.getString(it)) }?.let { meas = it }
        opt("chBw") { j.getDouble(it) }?.let { chBw = it }
        opt("spacing") { j.getDouble(it) }?.let { spacing = it }
        opt("persist") { j.getBoolean(it) }?.let { persist = it }
        opt("zsFreq") { j.getDouble(it) }?.let { zsFreq = it }
        opt("zsBw") { j.getDouble(it) }?.let { zsBw = it }
        opt("zsTime") { j.getDouble(it) }?.let { zsTime = it }
        opt("trig") { TrigMode.valueOf(j.getString(it)) }?.let { trig = it }
        opt("single") { j.getBoolean(it) }?.let { single = it }
        opt("level") { j.getInt(it) }?.let { level = it }
        opt("pre") { j.getDouble(it) }?.let { pre = it }
        opt("showAmp") { j.getBoolean(it) }?.let { showAmp = it }
        opt("showFm") { j.getBoolean(it) }?.let { showFm = it }
        opt("showPh") { j.getBoolean(it) }?.let { showPh = it }
        opt("cursors") { j.getBoolean(it) }?.let { cursors = it }
        opt("curA") { j.getDouble(it) }?.let { curA = it }
        opt("curB") { j.getDouble(it) }?.let { curB = it }
    }
}

/** The frame as the screen keeps it: where its bins are. */
class SpFrameInfo(val f0: Double, val binHz: Double, val rbw: Double, val sweep: Boolean, val step: Int, val steps: Int)
/** A zero-span window as the screen keeps it, in display units. */
class ZsView(val amp: FloatArray, val fm: FloatArray, val ph: FloatArray, val rate: Double, val trig: Int, val roll: Boolean, val sweepSec: Double, val off: Double)

fun db1(v: Double): String = if (v.isFinite()) String.format(Locale.US, "%.1f", v) else "—"
/** A JavaScript-style number: no trailing zeros. */
internal fun jsTrim(v: Double, digits: Int): String {
    val s = String.format(Locale.US, "%.${digits}f", v)
    return if (s.contains('.')) s.trimEnd('0').trimEnd('.') else s
}
fun bwText(hz: Double): String = if (hz >= 1e6) "${jsTrim(hz / 1e6, 3)} MHz" else if (hz >= 1e3) "${jsTrim(hz / 1e3, 2)} kHz" else "${jsTrim(hz, 1)} Hz"
private fun stamp(): String = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())

/**
 * The processor as the engine runs it: [Spectrum]'s settings changes and SINGLE re-arms are queued here and applied on
 * the DSP thread, before the next read, so the processor is never touched from two threads.
 */
class SpectrumRunner(val proc: SpectrumProcessor) : IqProcessor {
    private val pending = ConcurrentLinkedQueue<(SpectrumProcessor) -> Unit>()
    fun post(f: (SpectrumProcessor) -> Unit) { pending.add(f) }
    private fun drain() { while (true) { val f = pending.poll() ?: break; runCatching { f(proc) } } }
    override fun reset(rate: Int) { drain(); proc.reset(rate) }
    override fun onIq(iq: ByteArray, len: Int, rate: Int) { drain(); proc.onIq(iq, len, rate) }
}

/** A readout tile: its id, label, the value and unit as shown big, and the badge in its corner (AUTO, MAN, RISE ↑...). */
class SpTile(val id: String, val label: String, val value: String, val unit: String, val badge: String)
/** A keypad entry in progress: which tile, its label, what kind of number, and the text typed so far. */
class SpPad(val tile: String, val label: String, val kind: String, var text: String = "")
/** One big number in the measurement card. */
class SpBig(val label: String, val value: String, val unit: String, val hot: Boolean = false)
/** The measurement card: title, trace tag, the main result (large), the others, and a line under them. */
class SpMeasCard(val title: String, val tag: String, val xl: SpBig?, val bigs: List<SpBig>, val three: Boolean, val sub: String, val warn: String = "")
/** One row of the marker table (or the cursor table in zero span). */
class SpMkRow(val k: Int, val chip: String, val active: Boolean, val trace: Int, val x: String, val y: String, val noise: String, val extra: String = "")

/** A frequency split for a big readout: the digits grouped in threes, and the unit. */
fun bigHz(hz: Double): Pair<String, String> {
    val a = abs(hz)
    val (v, u) = when { a >= 1e9 -> hz / 1e9 to "GHz"; a >= 1e6 -> hz / 1e6 to "MHz"; a >= 1e3 -> hz / 1e3 to "kHz"; else -> hz to "Hz" }
    var t = String.format(Locale.US, if (u == "Hz") "%.0f" else "%.6f", v)
    if (t.contains('.')) t = t.trimEnd('0').trimEnd('.')
    val dot = t.indexOf('.')
    if (dot >= 0) { val i = t.substring(0, dot); val f = t.substring(dot + 1); t = "$i." + f.chunked(3).joinToString(" ") }
    return t to u
}
/** 1-2-5 steps, for the span. */
fun step125(v: Double, dir: Int): Double {
    val e = floor(log10(v)).toInt(); val m = v / 10.0.pow(e)
    val ms = doubleArrayOf(1.0, 2.0, 5.0, 10.0)
    var i = ms.indexOfFirst { it >= m - 1e-9 }; if (i < 0) i = 3
    if (dir < 0 && ms[i] > m + 1e-9) i--
    i += dir
    val k = if (i < 0) -1 else if (i > 2) 1 else 0
    return ms[(i + 3) % 3] * 10.0.pow(e + k)
}
private fun sgn(v: Double) = if (v >= 0) "+" else "−"

object Spectrum {
    const val MIN_SPAN = 1000.0
    const val MAX_HZ = 6e9
    const val MIN_HZ = 1e6
    private var prefs: SharedPreferences? = null
    var s = SpSettings(0.0); private set
    val traces: List<Trace> = defaultTraces()
    var frame: SpFrameInfo? = null; private set
    var persistence: Persistence? = null; private set
    var zcap: ZsView? = null; private set
    var zstats: PulseStats? = null; private set
    var armed = true; private set
    var plan: SpanPlan? = null; private set
    var calNote = ""; private set
    var calOk = false; private set
    /** The measurement's last readout, kept for the export. */
    var measText = ""; private set
    /** The span on screen while a zoom or pan is being made (it is applied when the gesture settles). */
    var view: Pair<Double, Double>? = null; private set
    /** The keypad entry, while the keypad is open. */
    var pad: SpPad? = null; private set
    /** The plot's size in pixels at its last draw: the density display is kept at that resolution. */
    @Volatile var plotW = 0; @Volatile var plotH = 0
    private var runner: SpectrumRunner? = null
    /** Each marker's level, averaged over the last few frames (a live trace on noise jumps several dB a frame). */
    private class MkAvg(var hz: Double = Double.NaN, var trace: Trace? = null, var lin: Double = 0.0, var n: Int = 0)
    private val mkAvg = List(MARKER_COUNT) { MkAvg() }
    private val main = Handler(Looper.getMainLooper())
    private var loaded = false

    private val _ver = MutableStateFlow(0L)
    /** Bumped on every change, frames included: the screen redraws on it. */
    val ver: StateFlow<Long> = _ver.asStateFlow()
    private fun changed() { _ver.value = _ver.value + 1 }

    fun load(ctx: Context) {
        if (loaded) return
        loaded = true
        val p = ctx.getSharedPreferences("mayhem", Context.MODE_PRIVATE); prefs = p
        s = SpSettings(SdrEngine.radioFreqHz.toDouble())
        p.getString(KEY, null)?.let { j -> runCatching { s.fromJson(JSONObject(j)) } }
        s.traces.forEachIndexed { i, t -> traces[i].setMode(t.mode); traces[i].avgN = t.avgN }
    }
    fun save() { runCatching { prefs?.edit()?.putString(KEY, s.toJson().toString())?.apply() } }

    // ---- span and plan ----------------------------------------------------------------------------------------

    val start: Double get() = s.center - s.span / 2
    val stop: Double get() = s.center + s.span / 2
    /** The span drawn: the settled one, or the one a gesture is making. */
    fun vCenter(): Double = view?.first ?: s.center
    fun vSpan(): Double = view?.second ?: s.span
    fun rbwHz(): Double = if (s.rbwAuto) autoRbw(s.span) else s.rbw
    fun vbwHz(): Double = if (s.vbwAuto) frame?.rbw ?: rbwHz() else s.vbw

    /** The sample rates this radio does well: an RTL-SDR drops samples above 2.4 Msps. */
    fun rates(): List<Double> {
        val none = Radio.kind.value == Radio.Kind.NONE
        val all = Radio.RATE_CHOICES.filter { none || Radio.canSample(Radio.limits, it) }
        return (if (Radio.kind.value == Radio.Kind.RTLSDR) all.filter { it <= 2_400_000 } else all).map { it.toDouble() }
    }
    fun connected(): Boolean = Radio.kind.value != Radio.Kind.NONE

    /** The radio's gain now, for the dBm scale. */
    fun gain(): GainState {
        val k = when (Radio.kind.value) { Radio.Kind.HACKRF -> RadioKind.HACKRF; Radio.Kind.RTLSDR -> RadioKind.RTLSDR; else -> RadioKind.NONE }
        val pro = HackRfOne.boardLabel.contains("Pro", ignoreCase = true)
        val tuner = if (k == RadioKind.RTLSDR && !SdrEngine.tunerAgc.value) SdrEngine.radioVga.value.toDouble() else Double.NaN
        return GainState(k, pro, SdrEngine.radioLna.value, SdrEngine.radioVga.value, SdrEngine.radioAmp.value, tuner)
    }
    /** The RADIO chip's words. */
    fun gainText(): String {
        val g = gain()
        return when (g.kind) {
            RadioKind.RTLSDR -> if (g.tunerDb.isFinite()) "GAIN ${jsTrim(g.tunerDb, 1)} dB" else "TUNER AGC"
            RadioKind.HACKRF -> "LNA ${g.lna} · VGA ${g.vga}${if (g.amp) " · AMP" else ""}"
            RadioKind.NONE -> "NO RADIO"
        }
    }

    /** The zero-span rate: the smallest rate (from 2 Msps up, the HackRF's floor) whose span holds the filter clear of DC. */
    fun zsRate(): Double {
        val r = rates().sorted()
        if (r.isEmpty()) return 2e6
        return r.firstOrNull { it >= min(2e6, r.last()) && zsMaxBw(it) >= s.zsBw } ?: r.last()
    }
    /** Filter bandwidths this radio can do. */
    fun zsBws(): List<Double> { val top = max(rates().maxOrNull() ?: 0.0, 2e6); return ZS_BWS.filter { it <= zsMaxBw(top) } }

    private fun config(): SpecConfig {
        val zsRate = zsRate(); val zsTune = s.zsFreq - ZS_OFFSET * zsRate
        val base = SpecConfig(SpecMode.FFT, 0.0, start, stop, rbwHz(), s.window, if (s.vbwAuto) 1e12 else s.vbw, false, 0.0,
            ZsConfig(s.zsFreq - zsTune, s.zsBw, s.zsTime, s.trig, s.single, s.level - offset(), s.pre))
        if (s.mode == SpMode.ZERO) return base.copy(mode = SpecMode.ZERO, tuneHz = zsTune)
        val p = planSpan(start, stop, rates().ifEmpty { listOf(2e6) })
        plan = p
        return when (p) {
            is SpanPlan.Fft -> base.copy(tuneHz = p.tuneHz, dcPatch = p.dcPatch)
            is SpanPlan.Sweep -> base.copy(mode = SpecMode.SWEEP, sliceRate = p.sliceRate)
        }
    }

    /** Open the app: the settings from the last visit, and the processor started on them. */
    fun open() { pad = null; restart() }

    /** Retune and restart the processor (span, RBW, mode or window changed). */
    fun restart() {
        val cfg = config()
        // a marker the new span leaves behind goes off rather than reading the trace's edge
        for (m in s.markers) if (m.hz < start || m.hz > stop) { m.on = false; m.delta = false; m.hz = 0.0 }
        frame = null; zcap = null; zstats = null; armed = true; view = null
        // the marker averages belong to the old span's traces
        for (a in mkAvg) a.n = 0
        for (t in traces) t.clear()
        persistence?.clear()
        // a frame from a processor that has since been replaced belongs to the old settings, and is dropped
        var r: SpectrumRunner? = null
        val sp = SpectrumProcessor(cfg, { ev -> main.post { if (r != null && runner === r) onEvent(ev) } })
        r = SpectrumRunner(sp)
        runner = r
        when (cfg.mode) {
            SpecMode.ZERO -> SdrEngine.configure(SdrEngine.Mode.NONE, Math.round(cfg.tuneHz), zsRate().toInt(), 32, 40, true, r)
            SpecMode.SWEEP -> SdrEngine.configure(SdrEngine.Mode.NONE, Math.round(cfg.startHz + cfg.sliceRate / 2), cfg.sliceRate.toInt(), 32, 40, true, r)
            SpecMode.FFT -> SdrEngine.configure(SdrEngine.Mode.NONE, Math.round(cfg.tuneHz), (plan as SpanPlan.Fft).rate.toInt(), 32, 40, true, r)
        }
        save(); changed()
    }
    /** Settings the processor takes in place (VBW, trigger, level), applied on the DSP thread. */
    fun update() {
        val cfg = config()
        runner?.post { it.set(cfg) }
        save(); changed()
    }
    private fun rearmProc() { runner?.post { it.rearm() } }
    /** Set the span (clamped to what a radio reaches) and restart. */
    fun setSpan(center0: Double, span0: Double) {
        val span = max(MIN_SPAN, min(MAX_HZ - MIN_HZ, span0))
        val center = max(MIN_HZ + span / 2, min(MAX_HZ - span / 2, center0))
        s.center = center; s.span = span
        restart()
    }

    // ---- the dBm scale ----------------------------------------------------------------------------------------

    /** dBFS to the display unit. */
    fun offset(): Double {
        if (s.unit == SpUnit.DBFS) { calNote = "dBFS: relative to the converter's full scale"; calOk = true; return 0.0 }
        val o = dbmOffset(gain(), s.cal.toDouble())
        calOk = o.ok
        calNote = if (o.ok) "dBm ${o.note}${if (s.cal != 0) " · CAL ${if (s.cal > 0) "+" else ""}${s.cal} dB" else ""} · approximate" else "dBm uncalibrated: ${o.note}"
        return o.offset
    }
    fun unitLabel(): String = s.unit.label

    /** The radio's gain moved (RADIO panel): a trigger level in dBm keeps its meaning. */
    fun gainChanged() {
        if (Apps.playing() != MayhemApp.SPECTRUM) return
        if (s.mode == SpMode.ZERO && s.trig != TrigMode.FREE) update() else { offset(); changed() }
    }

    // ---- what the processor sends ------------------------------------------------------------------------------

    private fun onEvent(ev: SpectrumEvent) {
        if (Apps.playing() != MayhemApp.SPECTRUM) return
        when (ev) { is SpFrame -> onFrame(ev); is ZsCap -> onCapture(ev) }
    }

    private fun onFrame(m: SpFrame) {
        if (s.mode != SpMode.FREQ) return
        val off = offset().toFloat()
        fun shift(a: FloatArray?): FloatArray? { if (a == null) return null; for (i in a.indices) a[i] += off; return a }
        val live = shift(m.live)!!; val mx = shift(m.max); val mn = shift(m.min)
        frame = SpFrameInfo(m.f0, m.binHz, m.rbw, m.sweep, m.step, m.steps)
        // a sweep row is redrawn while it fills: only its finished passes feed the holds, the average and the density
        val whole = !m.sweep || m.step == m.steps
        for (t in traces) if (t.mode == TraceMode.LIVE || whole) t.update(live, mx, mn, m.f0, m.binHz)
        if (s.persist && whole && view == null) addDensity(live, m.f0, m.binHz)
        for (k in s.markers.indices) smoothMarker(k)
        changed()
    }

    private fun onCapture(m: ZsCap) {
        if (s.mode != SpMode.ZERO) return
        val off = offset()
        for (i in m.amp.indices) m.amp[i] = (m.amp[i] + off).toFloat()
        zcap = ZsView(m.amp, m.fm, m.ph, m.rate, m.trig, m.roll, m.sweepSec, off)
        armed = m.armed
        zstats = pulseStats(m.amp, m.rate)
        changed()
    }

    /** The density display at the plot's own resolution: each frame reduced to columns, joined column to column. */
    private fun addDensity(live: FloatArray, f0: Double, binHz: Double) {
        if (plotW <= 0 || plotH <= 0) return
        val cols = max(64, min(1600, plotW)); val rows = max(64, min(600, plotH))
        val p = persistence?.takeIf { it.cols == cols && it.rows == rows } ?: Persistence(cols, rows, 0.9).also { persistence = it }
        // the frame's bins placed on the screen's columns (it may not fill the span exactly)
        val y = FloatArray(cols) { -1e9f }
        val x0 = (f0 - binHz / 2 - start) / s.span * cols; val x1 = (f0 + (live.size - 0.5) * binHz - start) / s.span * cols
        val a = max(0, ceil(x0).toInt()); val b = min(cols, floor(x1).toInt())
        if (b - a < 2) return
        System.arraycopy(toColumns(live, b - a, Detector.PEAK), 0, y, a, b - a)
        p.addColumns(y, s.ref.toDouble(), s.div * 10.0)
    }

    // ---- the readout tiles ------------------------------------------------------------------------------------

    /** The tiles for the mode. */
    fun tiles(): List<SpTile> {
        val u = unitLabel()
        fun t(id: String, label: String, p: Pair<String, String>, badge: String = "") = SpTile(id, label, p.first, p.second, badge)
        if (s.mode == SpMode.ZERO) {
            val sw = fmtSec(if (pinchTime.isFinite()) pinchTime else zcap?.sweepSec ?: s.zsTime).split(" ")
            return listOf(
                t("zf", "FREQUENCY", bigHz(s.zsFreq)),
                t("zbw", "FILTER", bigHz(s.zsBw)),
                SpTile("zst", "SWEEP", sw[0], sw.getOrElse(1) { "" }, ""),
                SpTile("lvl", "TRIGGER", if (s.trig == TrigMode.FREE) "FREE" else "${s.level}", if (s.trig == TrigMode.FREE) "RUN" else u,
                    if (s.trig == TrigMode.FREE) "" else if (s.trig == TrigMode.RISE) "RISE ↑" else "FALL ↓"),
                SpTile("ref", "REF LEVEL", "${s.ref}", u, "${s.div} dB/div"),
            )
        }
        val v = view
        val rbw = frame?.rbw ?: rbwHz()
        val a = if (s.startStop) listOf(t("start", "START", bigHz(start)), t("stop", "STOP", bigHz(stop)))
            // the CENTER and SPAN tiles follow a zoom or pan as it is made
            else listOf(t("center", "CENTER", bigHz(v?.first ?: s.center)), t("span", "SPAN", bigHz(v?.second ?: s.span)))
        return a + listOf(
            t("rbw", "RBW", bigHz(rbw), if (s.rbwAuto) "AUTO" else "MAN"),
            t("vbw", "VBW", if (s.vbwAuto) bigHz(rbw) else bigHz(s.vbw), if (s.vbwAuto) "AUTO" else "MAN"),
            SpTile("ref", "REF LEVEL", "${s.ref}", u, "${s.div} dB/div · AUTO"),
        )
    }

    /** Set REF and dB/div to frame the measured trace. */
    fun autoScaleNow() {
        val y = (traceFor(s.markers[s.active].trace) ?: traces.firstOrNull { it.data != null })?.data ?: return
        val a = autoScale(y, DIVS)
        s.ref = a.ref; s.div = a.div; persistence?.clear()
        update()
    }

    /** A tap on a tile's badge: AUTO/MAN toggles RBW or VBW auto, RISE/FALL flips the edge. */
    fun badge(id: String) {
        when (id) {
            "rbw" -> toggle("rbwa")
            "vbw" -> toggle("vbwa")
            "lvl" -> { s.trig = if (s.trig == TrigMode.RISE) TrigMode.FALL else TrigMode.RISE; update() }
            "ref" -> autoScaleNow()
        }
    }

    /** One click of a tile's knob. */
    fun turn(id: String, dir: Int) {
        when (id) {
            "center" -> { setSpan(s.center + dir * s.span / 10, s.span); return }
            "start" -> { setSpan(s.center + dir * s.span / 20, s.span - dir * s.span / 10); return }
            "stop" -> { setSpan(s.center + dir * s.span / 20, s.span + dir * s.span / 10); return }
            "span" -> { setSpan(s.center, step125(s.span, dir)); return }
            "rbw" -> { s.rbw = stepBw(frame?.rbw ?: rbwHz(), dir); s.rbwAuto = false; restart(); return }
            "vbw" -> { s.vbw = stepBw(if (s.vbwAuto) vbwHz() else s.vbw, dir); s.vbwAuto = false }
            "ref" -> { s.ref += dir * (if (s.div >= 5) 5 else 1); persistence?.clear() }
            "zf" -> { s.zsFreq += dir * s.zsBw / 4; restart(); return }
            "zbw" -> { val b = zsBws(); if (b.isEmpty()) return; val i = max(0, min(b.size - 1, b.indexOf(s.zsBw) + dir)); s.zsBw = b[i]; restart(); return }
            "zst" -> { stepper("zst", dir); return }
            // in FREE RUN the knob arms a rising trigger at the level shown; after that it moves the level
            "lvl" -> if (s.trig == TrigMode.FREE) s.trig = TrigMode.RISE else s.level += dir
            else -> { stepper(id, dir); return }
        }
        update()
    }

    // ---- keypad -----------------------------------------------------------------------------------------------

    fun openPad(tile: String) {
        val t = tiles().firstOrNull { it.id == tile } ?: return
        if (tile == "lvl" && s.trig == TrigMode.FREE) { turn("lvl", 1); return }
        val kind = when (tile) { "ref", "lvl" -> "db"; "zst" -> "sec"; "rbw", "vbw", "span", "zbw" -> "bw"; else -> "hz" }
        pad = SpPad(tile, t.label, kind); changed()
    }
    fun closePad() { pad = null; changed() }
    /** The units the keypad offers for its entry, with their multipliers. */
    fun padUnits(): List<Pair<String, Double>> = when (pad?.kind) {
        "db" -> listOf(unitLabel() to 1.0)
        "sec" -> listOf("s" to 1.0, "ms" to 1e-3, "µs" to 1e-6)
        else -> listOf("GHz" to 1e9, "MHz" to 1e6, "kHz" to 1e3, "Hz" to 1.0)
    }
    fun padKey(k: String) {
        val p = pad ?: return
        when {
            k == "bs" -> p.text = p.text.dropLast(1)
            k == "C" -> p.text = ""
            k == "±" -> p.text = if (p.text.startsWith("-")) p.text.drop(1) else "-" + p.text
            k == "." -> if (!p.text.contains('.')) p.text += k
            k.length == 1 && k[0].isDigit() -> p.text += k
        }
        changed()
    }
    /** Apply the keypad's number times a unit multiplier. */
    fun enterPad(mult: Double) {
        val p = pad ?: return
        val v = (p.text.toDoubleOrNull() ?: Double.NaN) * mult
        pad = null; changed()
        if (p.text.isEmpty() || !v.isFinite()) return
        when (p.tile) {
            "center" -> { setSpan(v, s.span); return }
            "span" -> { setSpan(s.center, v); return }
            "start" -> { val st = stop; setSpan((v + st) / 2, st - v); return }
            "stop" -> { val a = start; setSpan((a + v) / 2, v - a); return }
            "rbw" -> { s.rbw = max(1.0, v); s.rbwAuto = false; restart(); return }
            "vbw" -> { s.vbw = max(1.0, v); s.vbwAuto = false }
            "ref" -> { s.ref = Math.round(v).toInt(); persistence?.clear() }
            "lvl" -> s.level = Math.round(v).toInt()
            "zf" -> { s.zsFreq = max(MIN_HZ, min(MAX_HZ, v)); restart(); return }
            "zbw" -> { val b = zsBws(); if (b.isEmpty()) return; s.zsBw = b.minByOrNull { abs(ln(it / v)) } ?: b[0]; restart(); return }
            "zst" -> { val most = ZS_MAX_POINTS / zsPlan(zsRate(), s.zsBw).outRate; s.zsTime = max(1e-5, min(most, v)); restart(); return }
        }
        update()
    }
    /** A key on a keyboard while the keypad is open; true when it was used. */
    fun padHardKey(key: String): Boolean {
        val p = pad ?: return false
        when {
            key == "esc" -> closePad()
            key == "enter" -> enterPad(if (p.kind == "db" || p.kind == "sec") 1.0 else 1e6)
            key == "bs" -> padKey("bs")
            key == "-" -> padKey("±")
            key == "." || (key.length == 1 && key[0].isDigit()) -> padKey(key)
            key in listOf("g", "m", "k") && p.kind != "db" -> enterPad(if (p.kind == "sec") (if (key == "m") 1e-3 else 1.0) else when (key) { "g" -> 1e9; "m" -> 1e6; else -> 1e3 })
        }
        return true
    }

    /** The line under the tiles: how the span is taken, the window and detector, the gain; and the dBm note. */
    fun status(): Pair<String, String> {
        val f = frame
        val parts = ArrayList<String>()
        if (s.mode == SpMode.FREQ) {
            val p = plan
            parts.add(when (p) {
                is SpanPlan.Sweep -> "SWEEP · ${if (f != null) "${f.steps} STEPS" else "…"}"
                is SpanPlan.Fft -> "FFT · ${jsTrim(p.rate / 1e6, 3)} Msps${if (p.dcPatch) "" else " · OFF DC"}"
                null -> ""
            })
            parts.add("${if (s.window == WindowKind.HANN) "HANN" else "FLAT TOP"} · ${s.det.name}")
        } else {
            parts.add("ZERO SPAN${if (s.single) (if (armed) " · SINGLE ARMED" else " · SINGLE DONE") else ""}${if (s.trig != TrigMode.FREE) " · PRE ${(s.pre * 100).roundToInt()} %" else ""}")
        }
        parts.add(gainText())
        offset()
        return parts.filter { it.isNotEmpty() }.joinToString(" · ") to calNote
    }

    // ---- controls ---------------------------------------------------------------------------------------------

    fun setMode(m: SpMode) { s.mode = m; restart() }
    fun setUnit(u: SpUnit) { s.unit = u; for (t in traces) t.clear(); for (a in mkAvg) a.n = 0; persistence?.clear(); update() }
    fun setWindow(w: WindowKind) { s.window = w; restart() }
    fun setDet(d: Detector) { s.det = d; save(); changed() }
    fun setMeas(m: Meas) { s.meas = m; save(); changed() }
    fun setActive(k: Int) { s.active = k; save(); changed() }
    fun setMarkerTrace(t: Int) { s.markers[s.active].trace = t; save(); changed() }
    fun setZsBw(b: Double) { s.zsBw = b; restart() }
    fun setTrig(t: TrigMode) { s.trig = t; update() }
    fun clearTrace(i: Int) { traces[i].clear(); for (a in mkAvg) a.n = 0; changed() }
    fun setTraceMode(i: Int, m: TraceMode) { traces[i].setMode(m); s.traces[i].mode = traces[i].mode; save(); changed() }

    fun stepper(id: String, dir: Int) {
        fun <T> idx(list: List<T>, v: T) = max(0, list.indexOf(v))
        when (id) {
            "div" -> { s.div = DIVS[max(0, min(DIVS.size - 1, idx(DIVS, s.div) + dir))]; persistence?.clear() }
            "cal" -> s.cal = max(-40, min(40, s.cal + dir))
            "chbw" -> s.chBw = min(stepBw(s.chBw, dir), max(1000.0, s.span))
            "spacing" -> s.spacing = stepBw(s.spacing, dir)
            "zst" -> {
                val plan = zsPlan(zsRate(), s.zsBw); val most = ZS_MAX_POINTS / plan.outRate
                val i = SWEEP_TIMES.indexOfFirst { it >= s.zsTime * 0.999 }
                s.zsTime = min(most, SWEEP_TIMES[max(0, min(SWEEP_TIMES.size - 1, (if (i < 0) SWEEP_TIMES.size - 1 else i) + dir))])
                restart(); return
            }
            "pre" -> s.pre = max(0.0, min(0.9, Math.round((s.pre + dir * 0.1) * 10) / 10.0))
            else -> if (id.startsWith("avg")) {
                val i = id.removePrefix("avg").toInt(); val t = traces[i]
                t.avgN = max(2, min(1000, if (t.avgN < 10) t.avgN + dir else Math.round(t.avgN * (if (dir > 0) 2.0 else 0.5)).toInt()))
                s.traces[i].avgN = t.avgN; t.clear()
            }
        }
        update()
    }

    fun toggle(id: String) {
        val m = s.markers[s.active]
        when (id) {
            "ss" -> s.startStop = !s.startStop
            "rbwa" -> { s.rbwAuto = !s.rbwAuto; restart(); return }
            "vbwa" -> { s.vbwAuto = !s.vbwAuto; update(); return }
            // a marker switched on with nowhere in the span to be starts on the highest peak
            "mkon" -> { m.on = !m.on; if (m.on && !(m.hz >= start && m.hz <= stop)) { m.on = false; markerTo(s.active, "peak") } }
            "mkd" -> { m.delta = !m.delta; if (m.delta && !s.markers[0].on) { s.markers[0].on = true; s.markers[0].hz = m.hz } }
            "persist" -> { s.persist = !s.persist; persistence = null }
            "single" -> { s.single = !s.single; update(); if (!s.single) rearmProc(); return }
            "vamp" -> s.showAmp = !s.showAmp
            "vfm" -> s.showFm = !s.showFm
            "vph" -> s.showPh = !s.showPh
            "cur" -> s.cursors = !s.cursors
        }
        save(); changed()
    }

    /** PEAK, NEXT PEAK, ◀ NEXT, NEXT ▶, MKR → CENTER, ALL OFF, AUTO LEVEL, ARM. */
    fun action(id: String) {
        when (id) {
            "peak", "next", "left", "right" -> markerTo(s.active, id)
            "mkcf" -> { val m = s.markers[s.active]; if (m.on) setSpan(m.hz, s.span); return }
            "mkoff" -> for (m in s.markers) { m.on = false; m.delta = false }
            "autoscale" -> { autoScaleNow(); return }
            // the trigger level from what is on screen: the noise between bursts plus 12 dB (arming RISE from FREE RUN)
            "autolvl" -> {
                val z = zcap ?: return; val l = autoLevel(z.amp); if (!l.isFinite()) return
                s.level = l.toInt(); if (s.trig == TrigMode.FREE) s.trig = TrigMode.RISE
                update(); return
            }
            "arm" -> { armed = true; rearmProc() }
        }
        save(); changed()
    }

    /** ANALYZER / DEVICES: open that app on the active marker (or the center, or the zero-span frequency). */
    fun openIn(app: MayhemApp) { Apps.handoffHz = Math.round(selectedHz()); Apps.open(app) }

    /** The frequency the OPEN IN buttons hand over. */
    fun selectedHz(): Double {
        if (s.mode == SpMode.ZERO) return s.zsFreq
        val m = s.markers[s.active]
        return if (m.on) m.hz else s.center
    }

    /** The trace a marker reads, falling back to the first one with data. */
    fun traceFor(i: Int): Trace? {
        val t = traces[i]
        if (t.data != null && t.mode != TraceMode.OFF) return t
        return traces.firstOrNull { it.data != null && it.mode != TraceMode.OFF }
    }
    /** The trace the measurements read: the active marker's, else the first with data. */
    fun measTrace(): Trace? = traceFor(s.markers[s.active].trace)

    /** Peak search for marker `k`. */
    fun markerTo(k: Int, how: String) {
        val m = s.markers[k]; val t = traceFor(m.trace) ?: return
        val y = t.data ?: return
        val cur = binOf(m.hz, t.f0, t.binHz, y.size)
        // a marker off, or left outside the trace, starts from a peak search whatever was asked
        val inside = m.hz >= t.f0 - t.binHz && m.hz <= t.f0 + y.size * t.binHz
        val i = if (!m.on || !inside || how == "peak") peakSearch(y) else when (how) { "next" -> nextPeak(y, cur); "left" -> nextPeakLeft(y, cur); else -> nextPeakRight(y, cur) }
        val r = refinePeak(y, i)
        m.hz = t.f0 + (i + r.offset) * t.binHz; m.on = true
    }

    // ---- gestures on the plot (x in pixels across the plot area, [l] its left edge, [w] its width) ---------------

    private enum class G { TAP, PAN, PINCH, PINCH_T, MARKER, CURSOR }
    private class Gesture(var kind: G, val x0: Float, val center0: Double, val span0: Double, val d0: Float, val which: Int)
    private var gesture: Gesture? = null
    private val commit = Runnable { val v = view; if (v != null && gesture == null) setSpan(v.first, v.second) }

    fun hzAt(x: Float, l: Float, w: Float): Double = vCenter() - vSpan() / 2 + (x - l) / w * vSpan()
    fun xOfHz(hz: Double, l: Float, w: Float): Float = (l + (hz - (vCenter() - vSpan() / 2)) / vSpan() * w).toFloat()

    /** A finger (or the mouse) went down at [x]. */
    fun down(x: Float, l: Float, w: Float) {
        main.removeCallbacks(commit)
        if (s.mode == SpMode.ZERO) {
            if (!s.cursors) return
            val fx = (x - l) / w
            gesture = Gesture(G.CURSOR, x, 0.0, 0.0, 0f, if (abs(fx - s.curA) < abs(fx - s.curB)) 0 else 1)
            move(listOf(x), l, w); return
        }
        // on a marker: drag it; anywhere else: a tap drops the active marker, a drag pans
        val near = s.markers.indexOfFirst { it.on && abs(xOfHz(it.hz, l, w) - x) < 12 * density }
        if (near >= 0) { s.active = near; gesture = Gesture(G.MARKER, x, 0.0, 0.0, 0f, near); changed(); return }
        gesture = Gesture(G.TAP, x, vCenter(), vSpan(), 0f, 0)
    }
    /** A second finger: the gesture becomes a pinch about the two. */
    fun pinch(a: Float, b: Float) {
        // zero span: the pinch stretches the time axis (the sweep time), applied when the fingers lift
        if (s.mode == SpMode.ZERO) { gesture = Gesture(G.PINCH_T, (a + b) / 2, 0.0, s.zsTime, max(10f, abs(a - b)), 0); pinchTime = s.zsTime; return }
        gesture = Gesture(G.PINCH, (a + b) / 2, vCenter(), vSpan(), max(10f, abs(a - b)), 0)
    }
    /** The sweep time a zero-span pinch is making (shown on the SWEEP tile while the fingers move). */
    var pinchTime = Double.NaN; private set
    /** The longest window this filter allows. */
    private fun zsMostSec(): Double = ZS_MAX_POINTS / zsPlan(zsRate(), s.zsBw).outRate
    /** The pointers moved to [xs]. */
    fun move(xs: List<Float>, l: Float, w: Float) {
        val gs = gesture ?: return
        val x = xs.firstOrNull() ?: return
        when (gs.kind) {
            G.CURSOR -> { val fx = max(0.0, min(1.0, ((x - l) / w).toDouble())); if (gs.which == 0) s.curA = fx else s.curB = fx; changed() }
            G.MARKER -> { val m = s.markers[gs.which]; m.hz = max(start, min(stop, hzAt(x, l, w))); changed() }
            G.PINCH -> if (xs.size >= 2) {
                val d = max(10f, abs(xs[0] - xs[1]))
                val anchor = gs.center0 - gs.span0 / 2 + (gs.x0 - l) / w * gs.span0
                val span = max(MIN_SPAN, gs.span0 * gs.d0 / d)
                val mid = (xs[0] + xs[1]) / 2
                preview(anchor - ((mid - l) / w - 0.5) * span, span)
            }
            G.PINCH_T -> if (xs.size >= 2) {
                val d = max(10f, abs(xs[0] - xs[1]))
                pinchTime = max(SWEEP_TIMES.first(), min(zsMostSec(), gs.span0 * gs.d0 / d)); changed()
            }
            G.TAP, G.PAN -> {
                if (gs.kind == G.TAP && abs(x - gs.x0) > 6 * density) gs.kind = G.PAN
                if (gs.kind == G.PAN) preview(gs.center0 - (x - gs.x0) / w * gs.span0, gs.span0)
            }
        }
    }
    /** Every pointer is up; [x] is where the last one left. */
    fun up(x: Float, l: Float, w: Float) {
        val gs = gesture ?: return
        gesture = null
        when (gs.kind) {
            G.PINCH, G.PAN -> commitSoon(0)
            G.PINCH_T -> {
                // snap to the nearest 1-2-5 sweep time
                val want = pinchTime; pinchTime = Double.NaN
                if (want.isFinite()) { s.zsTime = min(zsMostSec(), SWEEP_TIMES.minByOrNull { abs(ln(it / want)) }!!); restart() } else changed()
            }
            G.TAP -> if (s.mode == SpMode.FREQ) {
                val m = s.markers[s.active]
                m.on = true; m.hz = hzAt(x, l, w)
                // a tap snaps to the peak under the finger when there is one within a few pixels
                val t = traceFor(m.trace); val y = t?.data
                if (t != null && y != null) {
                    val half = max(1, Math.round(8 * density / w * s.span / t.binHz).toInt())
                    val c = binOf(m.hz, t.f0, t.binHz, y.size)
                    var best = c
                    for (i in max(0, c - half)..min(y.size - 1, c + half)) if (y[i] > y[best]) best = i
                    m.hz = t.f0 + (best + refinePeak(y, best).offset) * t.binHz
                }
                save(); changed()
            }
            G.MARKER, G.CURSOR -> { save(); changed() }
        }
    }
    /** A mouse wheel notch over the plot: zoom about the pointer, or (sideways) pan by a tenth of the span. */
    fun wheel(x: Float, dy: Float, dx: Float, l: Float, w: Float) {
        if (s.mode != SpMode.FREQ) return
        val span = vSpan(); val center = vCenter()
        if (abs(dx) > abs(dy)) preview(center + (if (dx > 0) 1 else -1) * span / 10, span)
        else {
            val k = if (dy > 0) 1.25 else 0.8
            val anchor = hzAt(x, l, w); val fx = (x - l) / w
            val ns = max(MIN_SPAN, min(MAX_HZ - MIN_HZ, span * k))
            preview(anchor - (fx - 0.5) * ns, ns)
        }
        commitSoon(350)
    }
    /** +/− on a keyboard: one 1-2-5 step of span. */
    fun zoomKey(dir: Int) { if (s.mode == SpMode.FREQ) setSpan(s.center, step125(s.span, dir)) }

    /** Draw the span a gesture is making, with what is already measured shifted under it. */
    private fun preview(center0: Double, span0: Double) {
        val span = max(MIN_SPAN, min(MAX_HZ - MIN_HZ, span0))
        val center = max(MIN_HZ + span / 2, min(MAX_HZ - span / 2, center0))
        view = center to span
        changed()
    }
    /** Apply the gesture's span once it settles. */
    private fun commitSoon(ms: Long) { main.removeCallbacks(commit); main.postDelayed(commit, ms) }
    /** Pixels per dp on this screen, for the touch distances. */
    @Volatile var density = 1f

    /** A key on a keyboard: the keypad when it is open; else ←/→ next peak, P peak, N next peak, +/− zoom. */
    fun onKey(key: String): Boolean {
        if (pad != null) return padHardKey(key)
        if (s.mode != SpMode.FREQ) return false
        when (key) {
            "left", "right", "peak", "next" -> markerTo(s.active, key)
            "+" -> { zoomKey(-1); return true }
            "-" -> { zoomKey(1); return true }
            else -> return false
        }
        save(); changed()
        return true
    }

    // ---- what the side panel shows ----------------------------------------------------------------------------

    /** Fold this frame's level at marker k into its running average (power mean of about the last MARKER_AVG frames). */
    private fun smoothMarker(k: Int) {
        val a = mkAvg[k]; val m = s.markers[k]
        val raw = rawLevel(k)
        if (!m.on || !raw.isFinite()) { a.n = 0; return }
        val t = traceFor(m.trace)
        if (a.hz != m.hz || a.trace !== t) { a.hz = m.hz; a.trace = t; a.n = 0 }
        val p = 10.0.pow(raw / 10)
        a.n = min(a.n + 1, MARKER_AVG)
        a.lin += (p - a.lin) / a.n
    }

    /** A marker's level as shown: its running average once it has one, else the trace under it. */
    private fun markerLevel(k: Int): Double {
        val a = mkAvg[k]; val m = s.markers[k]
        if (a.n > 0 && a.hz == m.hz && a.trace === traceFor(m.trace)) return 10 * log10(a.lin + 1e-30)
        return rawLevel(k)
    }

    /** The trace's value under marker k this frame. */
    private fun rawLevel(k: Int): Double {
        val m = s.markers[k]; val t = traceFor(m.trace) ?: return Double.NaN
        val y = t.data ?: return Double.NaN
        if (m.hz < t.f0 - t.binHz || m.hz > t.f0 + y.size * t.binHz) return Double.NaN
        return y[binOf(m.hz, t.f0, t.binHz, y.size)].toDouble()
    }
    /** The level of marker `k` on its trace, for the plot. */
    fun markerY(k: Int): Double = markerLevel(k)

    /** The active marker as the plot prints it, top right: head (MKRn / ΔMKRn), frequency, level; null when it is off. */
    fun activeReadout(): Triple<String, String, String>? {
        val am = s.markers[s.active]
        if (!am.on) return null
        val lv = markerLevel(s.active)
        val d = am.delta && s.active > 0 && s.markers[0].on
        val ref = if (d) markerLevel(0) else 0.0
        val head = if (d) "ΔMKR${s.active + 1}" else "MKR${s.active + 1}"
        val fx = if (d) "${sgn(am.hz - s.markers[0].hz)}${fmtHz(abs(am.hz - s.markers[0].hz), 6)}" else fmtHz(am.hz, 6)
        val fy = if (d) "${sgn(lv - ref)}${db1(abs(lv - ref))} dB" else "${db1(lv)} ${unitLabel()}"
        return Triple(head, fx, fy)
    }

    private fun splitBw(hz: Double): Pair<String, String> { val t = bwText(hz); val i = t.lastIndexOf(' '); return t.substring(0, i) to t.substring(i + 1) }

    /** The measurement card (or the pulse card in zero span). */
    fun measCard(): SpMeasCard {
        val u = unitLabel()
        if (s.mode == SpMode.ZERO) {
            val z = zcap; val st = zstats
            if (st == null) return SpMeasCard("PULSE", "", null, emptyList(), false,
                if (z != null) "No pulses in this window: it needs two distinct levels at least 10 dB apart." else "Waiting for samples.")
            fun cell(l: String, v: String): SpBig { val i = v.lastIndexOf(' '); return if (i < 0) SpBig(l, v, "") else SpBig(l, v.substring(0, i), v.substring(i + 1)) }
            val cells = listOf(cell("WIDTH", fmtSec(st.width)), cell("PERIOD", fmtSec(st.period)),
                cell("DUTY", if (st.duty.isFinite()) String.format(Locale.US, "%.1f %%", st.duty * 100) else "—"), cell("RISE", fmtSec(st.rise)),
                cell("FALL", fmtSec(st.fall)), SpBig("PULSES", "${st.pulses}", ""))
            return SpMeasCard("PULSE", "", null, cells, false, "top ${db1(st.top)} $u · base ${db1(st.base)} $u · ${db1(st.top - st.base)} dB on/off")
        }
        val t = measTrace(); val f = frame; val y = t?.data
        measText = ""
        val title = when (s.meas) { Meas.CHP -> "CHANNEL POWER"; Meas.OBW -> "OCCUPIED BANDWIDTH 99 %"; Meas.ACPR -> "ADJACENT CHANNEL POWER"; Meas.NOISE -> "NOISE FLOOR"; Meas.OFF -> "MEASURE" }
        if (s.meas == Meas.OFF) return SpMeasCard(title, "", null, emptyList(), false, "Pick CH PWR, OBW, ACPR or NOISE below for a measurement here.")
        if (t == null || y == null || f == null) return SpMeasCard(title, "", null, emptyList(), false, "Waiting for a trace.")
        val rbw = f.rbw; val tag = "T${traces.indexOf(t) + 1}"
        return when (s.meas) {
            Meas.CHP -> {
                val p = channelPower(y, t.f0, t.binHz, rbw, s.center, s.chBw); val d = p - 10 * log10(s.chBw)
                measText = "channel power ${db1(p)} $u in ${bwText(s.chBw)} · ${db1(d)} $u/Hz"
                val c = splitBw(s.chBw)
                SpMeasCard(title, tag, SpBig("POWER", db1(p), u), listOf(SpBig("DENSITY", db1(d), "$u/Hz"), SpBig("CHANNEL", c.first, c.second)), false, "")
            }
            Meas.OBW -> {
                val o = occupiedBw(y, t.f0, t.binHz, rbw)
                measText = "99 % occupied bandwidth ${bwText(o.bw)} (${fmtHz(o.lo, 4)} to ${fmtHz(o.hi, 4)}) · total ${db1(o.total)} $u"
                val b = splitBw(o.bw); val c = bigHz((o.lo + o.hi) / 2)
                SpMeasCard(title, tag, SpBig("OCCUPIED", b.first, b.second), listOf(SpBig("TOTAL POWER", db1(o.total), u), SpBig("CENTER", c.first, c.second)), false,
                    "${fmtHz(o.lo, 4)} to ${fmtHz(o.hi, 4)}")
            }
            Meas.ACPR -> {
                val a = acpr(y, t.f0, t.binHz, rbw, s.center, s.chBw, s.spacing)
                measText = "main ${db1(a.main)} $u · lower ${db1(a.lowerDbc)} dBc · upper ${db1(a.upperDbc)} dBc (${bwText(s.chBw)} channels ${bwText(s.spacing)} apart)"
                SpMeasCard(title, tag, null, listOf(SpBig("LOWER", db1(a.lowerDbc), "dBc"), SpBig("MAIN", db1(a.main), u, hot = true), SpBig("UPPER", db1(a.upperDbc), "dBc")), true,
                    "${bwText(s.chBw)} channels, ${bwText(s.spacing)} apart · lower ${db1(a.lower)} $u · upper ${db1(a.upper)} $u")
            }
            Meas.NOISE -> {
                val n = noiseFloor(y, rbw)
                measText = "noise floor ${db1(n.floor)} $u per ${bwText(rbw)} · ${db1(n.density)} $u/Hz"
                val r = splitBw(rbw)
                // a dBm floor under thermal noise is the scale being wrong, not a quiet band: say so
                val warn = if (s.unit == SpUnit.DBM && n.density < THERMAL_DBM_HZ)
                    "Below thermal noise (${jsTrim(THERMAL_DBM_HZ, 0)} dBm/Hz): the dBm scale reads ${db1(THERMAL_DBM_HZ - n.density)} dB or more low on this radio here. Raise CAL to correct it." else ""
                SpMeasCard(title, tag, SpBig("DENSITY", db1(n.density), "$u/Hz"), listOf(SpBig("FLOOR", db1(n.floor), u), SpBig("PER RBW", r.first, r.second)), false, "", warn)
            }
            Meas.OFF -> SpMeasCard(title, "", null, emptyList(), false, "")
        }
    }

    /** The marker table's rows (empty when no marker is on). */
    fun markerRows(): List<SpMkRow> {
        val u = unitLabel(); val f = frame
        val m1 = s.markers[0]; val ref = markerLevel(0)
        return s.markers.withIndex().filter { it.value.on }.map { (k, m) ->
            val lv = markerLevel(k); val tr = traceFor(m.trace); val y = tr?.data
            val nd = if (y != null && f != null) noiseAt(y, binOf(m.hz, tr.f0, tr.binHz, y.size), f.rbw) else Double.NaN
            val d = m.delta && k > 0 && m1.on
            SpMkRow(k, "${if (d) "Δ" else ""}${k + 1}", k == s.active, m.trace,
                if (d) "${sgn(m.hz - m1.hz)}${fmtHz(abs(m.hz - m1.hz), 6)}" else fmtHz(m.hz, 6),
                if (d) "${sgn(lv - ref)}${db1(abs(lv - ref))} dB" else "${db1(lv)} $u",
                if (d) "" else db1(nd))
        }
    }

    /** The zero-span cursor table: A, B, then B−A (x = time, y = amplitude, noise = frequency, extra = phase). */
    fun cursorRows(): List<SpMkRow> {
        val z = zcap ?: return emptyList()
        if (!s.cursors || z.amp.isEmpty()) return emptyList()
        val u = unitLabel(); val len = z.amp.size
        fun at(c: Double) = max(0, min(len - 1, Math.round(c * (len - 1)).toInt()))
        val a = at(s.curA); val b = at(s.curB); val dt = (b - a) / z.rate
        fun t(i: Int) = (i - max(0, z.trig)) / z.rate
        fun row(k: String, i: Int) = SpMkRow(-1, k, false, 0, fmtSec(t(i)), "${db1(z.amp[i].toDouble())} $u", "${sgn(z.fm[i].toDouble())}${bwText(abs(z.fm[i].toDouble()))}",
            "${String.format(Locale.US, "%.0f", z.ph[i])}°")
        val dA = z.amp[b].toDouble() - z.amp[a]
        return listOf(row("A", a), row("B", b),
            SpMkRow(-2, "B−A", false, 0, fmtSec(dt), "${sgn(dA)}${db1(abs(dA))} dB", if (dt != 0.0) "1/Δt ${bwText(abs(1 / dt))}" else "", ""))
    }

    // ---- export -----------------------------------------------------------------------------------------------

    fun fileName(ext: String): String {
        val hz = if (s.mode == SpMode.ZERO) s.zsFreq else s.center
        return "spectrum_${String.format(Locale.US, "%.3f", hz / 1e6)}MHz_${if (s.mode == SpMode.ZERO) "zerospan_" else ""}${stamp()}.$ext"
    }

    /** The trace(s) or the zero-span window as CSV, with the settings in comment lines. */
    fun csv(): String {
        val u = unitLabel(); val lines = arrayListOf("# Mayhem Mobile · Spectrum")
        fun num(v: Double) = if (v == Math.floor(v) && abs(v) < 1e15) v.toLong().toString() else v.toString()
        if (s.mode == SpMode.ZERO) {
            val z = zcap
            lines.add("# zero span ${num(s.zsFreq)} Hz · filter ${num(s.zsBw)} Hz · trigger ${s.trig.name}${if (s.trig != TrigMode.FREE) " ${s.level} $u pre ${num(s.pre)}" else ""}")
            lines.add("# $calNote")
            lines.add("time_s,amplitude_$u,frequency_offset_hz,phase_deg")
            if (z != null) for (i in z.amp.indices) lines.add(String.format(Locale.US, "%.6e,%.2f,%.1f,%.1f", (i - max(0, z.trig)) / z.rate, z.amp[i], z.fm[i], z.ph[i]))
            return lines.joinToString("\n") + "\n"
        }
        val f = frame
        lines.add("# center ${num(s.center)} Hz · span ${num(s.span)} Hz · RBW ${f?.let { String.format(Locale.US, "%.1f", it.rbw) } ?: ""} Hz · VBW ${if (s.vbwAuto) "auto" else num(s.vbw)} · ${s.window.name} window")
        lines.add("# $calNote")
        measCard()
        if (measText.isNotEmpty()) lines.add("# $measText")
        s.markers.forEachIndexed { k, m -> if (m.on) lines.add("# marker ${k + 1}: ${String.format(Locale.US, "%.1f", m.hz)} Hz ${db1(markerLevel(k))} $u") }
        val ts = traces.withIndex().filter { it.value.data != null && it.value.mode != TraceMode.OFF }
        lines.add((listOf("frequency_hz") + ts.map { "T${it.index + 1}_${it.value.mode.name}_$u" }).joinToString(","))
        val n = ts.maxOfOrNull { it.value.data!!.size } ?: 0
        val t0 = ts.firstOrNull()?.value
        if (t0 != null) for (k in 0 until n) {
            lines.add((listOf(String.format(Locale.US, "%.1f", t0.f0 + k * t0.binHz)) + ts.map { x -> val d = x.value.data!!; if (k < d.size) String.format(Locale.US, "%.2f", d[k]) else "NaN" }).joinToString(","))
        }
        return lines.joinToString("\n") + "\n"
    }

    fun saved(name: String) { Diag.log("Spectrum: saved $name") }
}
