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
/** One readout row: a bold label, the text, an optional trace tag, lit when it is the active marker's. */
class ReadRow(val label: String, val text: String, val tag: String = "", val on: Boolean = false, val dim: Boolean = false, val meas: Boolean = false)

fun db1(v: Double): String = if (v.isFinite()) String.format(Locale.US, "%.1f", v) else "—"
/** A JavaScript-style number: no trailing zeros. */
private fun jsTrim(v: Double, digits: Int): String {
    val s = String.format(Locale.US, "%.${digits}f", v)
    return if (s.contains('.')) s.trimEnd('0').trimEnd('.') else s
}
fun bwText(hz: Double): String = if (hz >= 1e6) "${jsTrim(hz / 1e6, 2)} MHz" else if (hz >= 1e3) "${jsTrim(hz / 1e3, 2)} kHz" else "${jsTrim(hz, 1)} Hz"
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

object Spectrum {
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
    /** The measurement's last readout, kept for the export. */
    var measText = ""; private set
    private var runner: SpectrumRunner? = null
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
    fun open() { restart() }

    /** Retune and restart the processor (span, RBW, mode or window changed). */
    fun restart() {
        val cfg = config()
        frame = null; zcap = null; zstats = null; armed = true
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

    // ---- the dBm scale ----------------------------------------------------------------------------------------

    /** dBFS to the display unit. */
    fun offset(): Double {
        if (s.unit == SpUnit.DBFS) { calNote = "dBFS: relative to the converter's full scale"; return 0.0 }
        val o = dbmOffset(gain(), s.cal.toDouble())
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
        // a frame from a processor that has been replaced is from the old settings
        if (Apps.playing() != MayhemApp.SPECTRUM) return
        when (ev) { is SpFrame -> onFrame(ev); is ZsCap -> onCapture(ev) }
    }

    private fun onFrame(m: SpFrame) {
        if (s.mode != SpMode.FREQ) return
        val off = offset().toFloat()
        fun shift(a: FloatArray?): FloatArray? { if (a == null) return null; for (i in a.indices) a[i] += off; return a }
        val live = shift(m.live)!!; val mx = shift(m.max); val mn = shift(m.min)
        frame = SpFrameInfo(m.f0, m.binHz, m.rbw, m.sweep, m.step, m.steps)
        // a sweep row is redrawn while it fills: only its finished passes feed the holds and the average
        val whole = !m.sweep || m.step == m.steps
        for (t in traces) if (t.mode == TraceMode.LIVE || whole) t.update(live, mx, mn, m.f0, m.binHz)
        if (s.persist && whole) { val p = persistence ?: Persistence(400, 160).also { persistence = it }; p.add(live, s.ref.toDouble(), s.div * 10.0) }
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

    // ---- controls ---------------------------------------------------------------------------------------------

    fun setMode(m: SpMode) { s.mode = m; restart() }
    fun setSpan(hz: Double) { s.span = hz; restart() }
    fun setUnit(u: SpUnit) { s.unit = u; for (t in traces) t.clear(); persistence?.clear(); update() }
    fun setWindow(w: WindowKind) { s.window = w; restart() }
    fun setDet(d: Detector) { s.det = d; save(); changed() }
    fun setMeas(m: Meas) { s.meas = m; save(); changed() }
    fun setActive(k: Int) { s.active = k; save(); changed() }
    fun setMarkerTrace(t: Int) { s.markers[s.active].trace = t; save(); changed() }
    fun setZsBw(b: Double) { s.zsBw = b; restart() }
    fun setTrig(t: TrigMode) { s.trig = t; update() }
    fun clearTrace(i: Int) { traces[i].clear(); changed() }
    fun setTraceMode(i: Int, m: TraceMode) { traces[i].setMode(m); s.traces[i].mode = traces[i].mode; save(); changed() }

    /** A frequency typed in a field (center, span, start, stop, zero-span frequency). */
    fun setField(id: String, text: String) {
        val hz = parseHz(text)
        if (hz != null && hz > 0) when (id) {
            "center" -> s.center = hz
            "span" -> s.span = max(1000.0, hz)
            "start" -> { val st = stop; s.center = (hz + st) / 2; s.span = max(1000.0, st - hz) }
            "stop" -> { val a = start; s.center = (a + hz) / 2; s.span = max(1000.0, hz - a) }
            "zf" -> s.zsFreq = hz
        }
        restart()
    }

    fun stepper(id: String, dir: Int) {
        fun <T> idx(list: List<T>, v: T) = max(0, list.indexOf(v))
        when (id) {
            "rbw" -> { s.rbw = stepBw(frame?.rbw ?: rbwHz(), dir); s.rbwAuto = false; restart(); return }
            "vbw" -> { s.vbw = stepBw(if (s.vbwAuto) vbwHz() else s.vbw, dir); s.vbwAuto = false }
            "ref" -> s.ref += dir * (if (s.div >= 5) 5 else 1)
            "div" -> { s.div = DIVS[max(0, min(DIVS.size - 1, idx(DIVS, s.div) + dir))]; persistence?.clear() }
            "cal" -> s.cal = max(-40, min(40, s.cal + dir))
            "chbw" -> s.chBw = stepBw(s.chBw, dir)
            "spacing" -> s.spacing = stepBw(s.spacing, dir)
            "zst" -> {
                val plan = zsPlan(zsRate(), s.zsBw); val most = ZS_MAX_POINTS / plan.outRate
                s.zsTime = min(most, SWEEP_TIMES[max(0, min(SWEEP_TIMES.size - 1, idx(SWEEP_TIMES, s.zsTime) + dir))])
                restart(); return
            }
            "lvl" -> s.level += dir
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
            "vbwa" -> s.vbwAuto = !s.vbwAuto
            "mkon" -> { m.on = !m.on; if (m.on && m.hz == 0.0) markerTo(s.active, "peak") }
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

    /** PEAK, NEXT PEAK, ◀ NEXT, NEXT ▶, MKR → CENTER, ALL OFF, ARM. */
    fun action(id: String) {
        when (id) {
            "peak", "next", "left", "right" -> markerTo(s.active, id)
            "mkcf" -> { val m = s.markers[s.active]; if (m.on) { s.center = m.hz; restart() }; return }
            "mkoff" -> for (m in s.markers) { m.on = false; m.delta = false }
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
        val i = if (!m.on || how == "peak") peakSearch(y) else when (how) { "next" -> nextPeak(y, cur); "left" -> nextPeakLeft(y, cur); else -> nextPeakRight(y, cur) }
        val r = refinePeak(y, i)
        m.hz = t.f0 + (i + r.offset) * t.binHz; m.on = true
    }

    /** A tap or drag on the plot at [fx] (0..1 across it); [down] starts a drag. */
    private var drag = -1
    fun pointer(fx: Double, down: Boolean) {
        if (s.mode == SpMode.ZERO) {
            if (!s.cursors) return
            if (down) drag = if (abs(fx - s.curA) < abs(fx - s.curB)) 0 else 1
            if (drag == 0) s.curA = max(0.0, min(1.0, fx)) else s.curB = max(0.0, min(1.0, fx))
            changed(); return
        }
        val m = s.markers[s.active]
        m.on = true; m.hz = start + max(0.0, min(1.0, fx)) * s.span
        drag = 0
        changed()
    }
    fun pointerUp() { drag = -1; save() }

    /** A key on a keyboard: ←/→ next peak left/right, P peak, N next peak. */
    fun onKey(key: String): Boolean {
        if (s.mode != SpMode.FREQ) return false
        when (key) { "left", "right", "peak", "next" -> markerTo(s.active, key); else -> return false }
        save(); changed()
        return true
    }

    // ---- what the screen shows --------------------------------------------------------------------------------

    /** The header: the big frequency, and the line of settings under it. */
    fun header(): Pair<String, String> {
        val f = frame
        if (s.mode == SpMode.ZERO) {
            val z = zcap
            val trig = if (s.trig == TrigMode.FREE) "FREE RUN" else "${if (s.trig == TrigMode.RISE) "RISING" else "FALLING"} ${s.level} ${unitLabel()} · PRE ${(s.pre * 100).roundToInt()} %"
            return fmtHz(s.zsFreq) to "ZERO SPAN · FILTER ${bwText(s.zsBw)} · SWEEP ${fmtSec(z?.sweepSec ?: s.zsTime)} · $trig" +
                (if (s.single) (if (armed) " · SINGLE ARMED" else " · SINGLE DONE") else "")
        }
        val p = plan
        val how = when (p) {
            is SpanPlan.Sweep -> "SWEEP ${if (f != null) "${f.steps} STEPS" else ""}"
            is SpanPlan.Fft -> "${String.format(Locale.US, if (p.rate % 1e6 != 0.0) "%.2f" else "%.0f", p.rate / 1e6)} Msps"
            null -> ""
        }
        return fmtHz(s.center) to "SPAN ${bwText(s.span)} · RBW ${bwText(f?.rbw ?: rbwHz())} · VBW ${if (s.vbwAuto) "AUTO" else bwText(s.vbw)} · REF ${s.ref} ${unitLabel()} · ${s.div} dB/div · $how"
    }

    private fun markerLevel(k: Int): Double {
        val m = s.markers[k]; val t = traceFor(m.trace) ?: return Double.NaN
        val y = t.data ?: return Double.NaN
        return y[binOf(m.hz, t.f0, t.binHz, y.size)].toDouble()
    }
    /** The level of marker `k` on its trace, for the plot. */
    fun markerY(k: Int): Double = markerLevel(k)

    /** The readout rows under the plot: markers and the measurement, or the pulse and the cursors. */
    fun readout(): List<ReadRow> {
        val u = unitLabel()
        val rows = ArrayList<ReadRow>()
        if (s.mode == SpMode.ZERO) {
            val z = zcap; val st = zstats
            if (st != null) rows.add(ReadRow("PULSE", "width ${fmtSec(st.width)} · period ${fmtSec(st.period)} · duty ${if (st.duty.isFinite()) String.format(Locale.US, "%.1f %%", st.duty * 100) else "—"} · rise ${fmtSec(st.rise)} · fall ${fmtSec(st.fall)} · top ${db1(st.top)} $u · base ${db1(st.base)} $u · ${st.pulses} pulse${if (st.pulses == 1) "" else "s"}"))
            else if (z != null) rows.add(ReadRow("PULSE", "no on/off pattern in this window (it needs 10 dB between on and off)"))
            if (s.cursors && z != null && z.amp.isNotEmpty()) {
                val len = z.amp.size
                fun at(c: Double) = max(0, min(len - 1, Math.round(c * (len - 1)).toInt()))
                val a = at(s.curA); val b = at(s.curB); val dt = (b - a) / z.rate
                fun t(i: Int) = (i - max(0, z.trig)) / z.rate
                fun side(v: Float) = if (v < 0) "below" else "above"
                rows.add(ReadRow("A", "${fmtSec(t(a))} · ${db1(z.amp[a].toDouble())} $u · ${bwText(abs(z.fm[a].toDouble()))} ${side(z.fm[a])} · ${String.format(Locale.US, "%.0f", z.ph[a])}°"))
                rows.add(ReadRow("B", "${fmtSec(t(b))} · ${db1(z.amp[b].toDouble())} $u · ${bwText(abs(z.fm[b].toDouble()))} ${side(z.fm[b])} · ${String.format(Locale.US, "%.0f", z.ph[b])}°"))
                rows.add(ReadRow("B−A", "Δt ${fmtSec(dt)}${if (dt != 0.0) " · 1/Δt ${bwText(abs(1 / dt))}" else ""} · Δ ${db1(z.amp[b].toDouble() - z.amp[a])} dB"))
            }
            return rows
        }
        val m1 = s.markers[0]; val ref = markerLevel(0)
        s.markers.forEachIndexed { k, m ->
            if (!m.on) return@forEachIndexed
            val lv = markerLevel(k)
            val t = traceFor(m.trace); val y = t?.data; val f = frame
            val nd = if (y != null && f != null) noiseAt(y, binOf(m.hz, t.f0, t.binHz, y.size), f.rbw) else Double.NaN
            if (m.delta && k > 0 && m1.on) rows.add(ReadRow("Δ${k + 1}", "${if (m.hz - m1.hz >= 0) "+" else "−"}${fmtHz(abs(m.hz - m1.hz))} · ${if (lv - ref >= 0) "+" else ""}${db1(lv - ref)} dB", "T${m.trace + 1}", k == s.active))
            else rows.add(ReadRow("M${k + 1}", "${fmtHz(m.hz)} · ${db1(lv)} $u · ${db1(nd)} $u/Hz", "T${m.trace + 1}", k == s.active))
        }
        val t = measTrace(); val f = frame
        measText = ""
        val y = t?.data
        if (t != null && y != null && f != null && s.meas != Meas.OFF) {
            val rbw = f.rbw
            measText = when (s.meas) {
                Meas.CHP -> { val p = channelPower(y, t.f0, t.binHz, rbw, s.center, s.chBw); "channel power ${db1(p)} $u in ${bwText(s.chBw)} · ${db1(p - 10 * log10(s.chBw))} $u/Hz" }
                Meas.OBW -> { val o = occupiedBw(y, t.f0, t.binHz, rbw); "99 % occupied bandwidth ${bwText(o.bw)} (${fmtHz(o.lo, 4)} to ${fmtHz(o.hi, 4)}) · total ${db1(o.total)} $u" }
                Meas.ACPR -> { val a = acpr(y, t.f0, t.binHz, rbw, s.center, s.chBw, s.spacing); "main ${db1(a.main)} $u · lower ${db1(a.lowerDbc)} dBc · upper ${db1(a.upperDbc)} dBc (${bwText(s.chBw)} channels ${bwText(s.spacing)} apart)" }
                Meas.NOISE -> { val n = noiseFloor(y, rbw); "noise floor ${db1(n.floor)} $u per ${bwText(rbw)} · ${db1(n.density)} $u/Hz" }
                Meas.OFF -> ""
            }
            val label = when (s.meas) { Meas.CHP -> "CH POWER"; Meas.OBW -> "OBW 99%"; Meas.ACPR -> "ACPR"; Meas.NOISE -> "NOISE"; Meas.OFF -> "" }
            rows.add(ReadRow(label, measText, "T${traces.indexOf(t) + 1}", meas = true))
        }
        if (rows.isEmpty()) rows.add(ReadRow("", "Tap the trace to put a marker there, or PEAK. $calNote.", dim = true))
        return rows
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
        if (measText.isNotEmpty()) lines.add("# $measText")
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
