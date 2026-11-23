package com.rocketgod.mayhem.core.cb

import com.rocketgod.mayhem.core.hamplus.ChannelWatch
import com.rocketgod.mayhem.core.hamplus.HamTracker
import com.rocketgod.mayhem.core.hamplus.HpSnap
import com.rocketgod.mayhem.core.hamplus.HpTxRow
import com.rocketgod.mayhem.core.hamplus.TxRec
import com.rocketgod.mayhem.core.hamplus.WatchOpen
import com.rocketgod.mayhem.core.hamplus.WatchPlan
import com.rocketgod.mayhem.core.hamplus.chanKey
import com.rocketgod.mayhem.core.hamplus.quietQuarter
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.log2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sqrt

/*
 * CB receiver: all 40 channels at once on HAM+'s watcher, each open one demodulated in its own mode.
 *
 * Each 100 ms the span's spectrum (about 150 to 250 Hz a bin) is cut into the 40 channels, ±4 kHz each, every bin
 * measured against the span's own noise (the quietest quarter of all the channel bins). A bin that stands well over
 * the noise and 6 dB over its channel's middle level and holds the same for two measurements is a steady line (an
 * unmodulated carrier, a receiver's own birdie, a carrier left keyed); it and its neighbors are left out, and so is
 * the channel's strongest bin and any bin that held a line for 3 s in the last ten minutes.
 *
 * A channel opens on what is left: its bins moving from one measurement to the next against their own floors (a
 * weak talker's voice, measured against how far the quietest quarter of the channels move), or plenty of power in
 * them (a strong talker, whose voice fills the channel). Then the demodulator decides: an opening that never
 * measures as AM, FM or sideband in its first 3 s (a burst of noise, a carrier keyed with nothing on it, sideband
 * facing a busy neighbor) is dropped without a trace. Nothing opens in the first 3 s of a span.
 *
 * A channel holding a steady line and no voice is reported as such: the level of the line over the noise, how long
 * it has held and how much of the last ten minutes it was there. Twin of web dsp/cb/engine.ts.
 */

/** The voice level (dB over the quiet channels' motion) a channel opens at; an open one closes 2 dB under it. */
const val CB_OPEN_DB = 3.0
/** Or its power outside its steady lines this far over the noise (dB), and staying open 3 dB under that. */
const val CB_SIG_OPEN_DB = 10.0
/** An open channel must measure as a readable station within this long, or it is dropped. */
const val CB_CONFIRM_MS = 3_000.0
/** A dropped channel stays shut this long. */
const val CB_DROP_HOLD_MS = 5_000.0
/** Nothing opens this long after the span starts: the floors and lines settle first. */
const val CB_WARM_MS = 3_000.0
/** A channel stays open this long without voice: a talker's breath, a short pause. */
const val CB_CLOSE_HOLD_MS = 1_200.0
/** The demodulated power falling this far under the transmission's peak this long is the carrier dropping: the end. */
const val CARRIER_DROP_DB = 10.0
const val CARRIER_GONE_MS = 200.0
private const val MEASURE_STEP_MS = 100.0
/** A steady line nearer the channel's center than this is not notched out (Hz). The probe also never notches within
 *  30 Hz of the carrier it holds, which is where a station on a line's frequency would be. */
const val NOTCH_KEEP_HZ = 0.0
/** Only a line that held this many measurements (2 s) is notched: longer than a talker's own carrier has been up when its channel opens. */
const val NOTCH_HELD = 20
/** A channel this much weaker than an open neighbor within 20 kHz is taken for its splatter (dB). */
const val SPLATTER_DB = 20.0
/** Sideband facing a neighbor this much stronger outside its steady lines (dB), or open, is that neighbor's splatter. */
const val SPLATTER_FACING_DB = 6.0
/** A steady line: over the noise by this much (linear, 8 dB), its measurements within what noise moves it by (never
 *  less than this share of their mean). */
const val LINE_MIN = 6.3
const val LINE_STEADY_MIN = 0.1
/** A line is also this many times the channel's middle level (linear, 6 dB). */
const val LINE_OVER_CH = 4.0
/** A line holding this many measurements running (3 s) is remembered, and its bins left out this long after. */
const val LINE_REMEMBER = 30
const val LINE_MEMORY_MS = 600_000.0
/** A channel shows "steady carrier, no voice" once a line has held this long without voice. */
const val STEADY_SHOW_MS = 3_000.0
/** A steady line missing this long is gone. */
const val LINE_GONE_MS = 1_000.0
/** The share of the last ten minutes a line was there decays with this time constant. */
private const val STEADY_TAU_MS = 600_000.0
/** The voice level is the mean of the last [V_N] motions without the [V_DROP] highest (a carrier keying up is two or three). */
private const val V_N = 8
private const val V_DROP = 3
/** A bin's noise floor follows a drop at once and a rise slowly (a measurement's share), about 20 s. */
private const val FLOOR_DOWN = 0.3
private const val FLOOR_UP = 0.005
private const val HALF_HZ = 4_000.0
private const val GUARD_HZ = 300.0

val CB_PLAN: WatchPlan = object : WatchPlan {
    override val name = "CB"
    override val raster = CB_RASTER
    override fun inPlan(hz: Long) = cbChannel(hz) > 0
    // fine enough that a carrier sits in a bin or two and the voice beside it in others
    override fun nfft(rate: Int) = 1 shl max(12, min(14, ceil(log2(rate / 250.0)).toInt()))
    override fun spanHalf(rate: Int) = min(rate * 0.44 - 6_250, 400_000.0)
    override val peakSteps = 0
    override val clearSteps = 1
    override val snap = false
}

/** What the CB screen knows about a channel beyond the tracker's tile. */
data class CbChan(
    val ch: Int, val hz: Long, val key: String, val inSpan: Boolean, val open: Boolean,
    /** The mode heard (live or last), what the measurement found for it (null: not yet), and the one set by hand (null: auto). */
    val mode: CbMode, val measured: CbMode?, val manual: CbMode?, val clarHz: Int,
    /** Voice level (dB over the quiet channels' motion) and the modulated power over the noise (dB), now. */
    val voiceDb: Double, val sigDb: Double,
    /** A steady line now: its level over the noise (dB, 0 when none), how long it held (ms) and its share of the last ten minutes. */
    val lineDb: Int, val steadyMs: Double, val steadyPct: Int,
    /** Steady carrier and no voice: what the screen shows muted. */
    val steady: Boolean,
)

/** HAM+'s snapshot with each row's mode filled in, and the 40 channels. */
class CbSnap(s: HpSnap, rows: List<HpTxRow>, val chans: List<CbChan>) :
    HpSnap(s.now, s.centerHz, s.rate, s.spanLo, s.spanHi, s.tiles, rows, s.convs, s.heat, s.playing, s.replay, s.stats)

/** The mode set by hand per channel key (absent: auto) and the SSB clarifier (Hz). */
data class CbPrefs(val modes: Map<String, CbMode> = emptyMap(), val clar: Map<String, Int> = emptyMap())

private class ChanState {
    var hist = ArrayList<FloatArray>(); var mem = DoubleArray(0); var run = IntArray(0); var fl = FloatArray(0); var v = ArrayList<Double>()
    var voiceDb = 0.0; var sigDb = 0.0; var totDb = 0.0; var d = 0.0
    var lineDb = 0; var lineSince = 0.0; var lineLast = 0.0; var noVoiceMs = Double.NEGATIVE_INFINITY; var seen = 0.0; var total = 0.0; var lastT = 0.0; var over = 0; var mode = CbMode.AM
}

class CbEngine(
    clock: () -> Double = { System.currentTimeMillis().toDouble() },
    perf: () -> Double = { System.nanoTime() / 1e6 },
) : ChannelWatch<CbProbe>(CB_PLAN, clock, perf, { now -> HamTracker(CB_TRACKER_PLAN, now) }) {
    private val st = List(CB_CHANNELS.size) { ChanState() }
    var cbPrefs = CbPrefs(); private set
    private val txMode = LinkedHashMap<Int, CbMode>()
    private val confirmed = HashSet<Int>()
    /** When an opening's demodulator started, when it did not start with it. */
    private val checkFrom = HashMap<Int, Double>()
    /** Each finished transmission's carriers, as its demodulator took them (ms into it, Hz). */
    val txCarriers = LinkedHashMap<Int, List<CarrierChange>>()
    /** Openings dropped as no voice, since the start (the log and the tests read it). */
    var dropped = 0; private set
    private val peakLevel = HashMap<Int, Double>(); private val goneMs = HashMap<Int, Double>()
    private var binHz = 0.0

    init {
        centerHz = CB_CENTER
        setParams(params.copy(thresholdDb = CB_OPEN_DB))
    }

    /**
     * A new span (the radio started, retuned or changed rate) starts every channel's measurement over, and nothing opens
     * for [CB_WARM_MS] while the floors and the lines settle: a radio just started moves its gain and its own noise.
     */
    override fun layout() {
        super.layout()
        for (s in st) { s.hist = ArrayList(); s.fl.fill(0f); s.run.fill(0); s.v = ArrayList(); s.over = 0; s.voiceDb = 0.0; s.lineSince = 0.0; s.lineLast = 0.0; s.lineDb = 0 }
        warmUntil = nowMs() + CB_WARM_MS
    }
    private var warmUntil = 0.0
    /** The span's noise variance a sample at the radio's rate, from the quietest quarter of the channel bins. */
    private var noiseVarIn = 0.0

    fun setCbPrefs(p: CbPrefs) {
        synchronized(lock) {
            cbPrefs = p
            for (o in opens.values) { val pr = o.probe ?: continue; pr.manual = p.modes[o.tileKey]; pr.clarHz = (p.clar[o.tileKey] ?: 0).toDouble() }
        }
    }

    override fun makeProbe(hz: Long, key: String): CbProbe {
        val p = CbProbe(rate.toDouble(), (hz - centerHz).toDouble()); val ch = cbChannel(hz)
        p.manual = cbPrefs.modes[key]; p.clarHz = (cbPrefs.clar[key] ?: 0).toDouble()
        if (ch != 0) { p.guess = st[ch - 1].mode; p.noiseRatio = noiseOf(ch - 1); p.noiseVarIn = noiseVarIn; p.setNotches(birdies(ch - 1)) }
        return p
    }

    /**
     * The steady lines on a channel before a transmission opens, as offsets from its center (Hz): the peaks of the bins
     * steady for [NOTCH_HELD] measurements, read between bins by a parabola through the three around each. A line within
     * [NOTCH_KEEP_HZ] of the center is left alone, as it may be where the talker's own carrier is.
     */
    fun birdies(i: Int): List<Int> {
        val s = st[i]; val p = s.hist.lastOrNull(); val bh = binHz
        if (p == null || bh == 0.0) return emptyList()
        val w = (p.size - 1) / 2; val out = ArrayList<Int>()
        for (b in 1 until p.size - 1) {
            if (s.run[b] < NOTCH_HELD || p[b] < p[b - 1] || p[b] < p[b + 1]) continue
            val l = ln(p[b - 1].toDouble()); val c = ln(p[b].toDouble()); val r = ln(p[b + 1].toDouble()); val den = l - 2 * c + r
            val hz = (b - w + (if (den < 0) 0.5 * (l - r) / den else 0.0)) * bh
            if (abs(hz) > NOTCH_KEEP_HZ) out.add(hz.roundToInt())
        }
        return out.take(4)
    }

    /** The channel's noise against all its power, carrier too: what the probe takes noise alone to move. */
    private fun noiseOf(i: Int): Double = 1 / max(1e-3, 10.0.pow(st[i].totDb / 10))

    override fun gate(now: Double, pdb: DoubleArray, binHz: Double) {
        val n = nfft; val w = max(2, (HALF_HZ / binHz).roundToInt()); val g = max(1, (GUARD_HZ / binHz).roundToInt()); val nb = 2 * w + 1
        if (binHz != this.binHz) { this.binHz = binHz; for (s in st) { s.hist = ArrayList(); s.mem = DoubleArray(nb); s.run = IntArray(nb); s.fl = FloatArray(nb); s.v = ArrayList() } }
        val half = plan.spanHalf(rate)
        // the raw bins of every channel heard, and the span's noise a bin: their quietest quarter
        val raw: List<FloatArray?> = CB_CHANNELS.map { hz ->
            if (abs(hz - centerHz) > half) null
            else {
                val c = ((hz - centerHz) / binHz).roundToInt() + n / 2
                FloatArray(nb) { b -> pdb[max(0, min(n - 1, c - w + b))].toFloat() }
            }
        }
        var total = 0; for (r in raw) if (r != null) total += nb
        if (total == 0) return
        val all = FloatArray(total); var ai = 0
        for (r in raw) if (r != null) for (b in 0 until nb) all[ai++] = r[b]
        val nbin = quietQuarter(all, all.size).toDouble().let { if (it == 0.0) 1e-12 else it }
        // the span's noise a sample, for the demodulators: a Hann-windowed bin holds the noise variance times 0.375 N
        noiseVarIn = nbin / (0.375 * n)
        val ds = ArrayList<Double>()
        for (i in raw.indices) {
            val r = raw[i]; val s = st[i]
            if (r == null) { s.hist = ArrayList(); s.d = Double.NaN; continue }
            val p = FloatArray(nb) { b -> (r[b] / nbin).toFloat() }
            s.hist.add(p); if (s.hist.size > 3) s.hist.removeAt(0)
            // steady lines: well over the noise and the same two measurements running are left out at once and reported;
            // one that held [LINE_REMEMBER] measurements is remembered for ten minutes
            val ex = BooleanArray(nb); var line = 0.0
            // a line stands out of its channel: over the noise, and 6 dB over the channel's own middle level (a band of hiss
            // raised across the whole channel is not a line)
            val chMed = p.sortedArray()[nb shr 1].toDouble(); val lineMin = max(LINE_MIN, LINE_OVER_CH * chMed)
            val h = s.hist.size
            fun steadyOver(b: Int, k: Int): Boolean {
                if (h < k) return false
                var lo = Double.POSITIVE_INFINITY; var hi = 0.0; var sum = 0.0
                for (j in h - k until h) { val v = s.hist[j][b].toDouble(); lo = min(lo, v); hi = max(hi, v); sum += v }
                // a line in noise wobbles by the noise riding on it, less the stronger it is: about sqrt(2 / level) of
                // itself a frame, less over the frames a measurement averages; a voice's bins move far more
                return lo > lineMin && (hi - lo) / (sum / k) < max(LINE_STEADY_MIN, 0.7 * sqrt(2 / lo))
            }
            for (b in 0 until nb) {
                if (!steadyOver(b, 2)) { s.run[b] = 0; continue }
                s.run[b] = (s.run[b] + 1) and 0xffff  // as the web's Uint16Array
                for (d in -g..g) { val j = b + d; if (j in 0 until nb) ex[j] = true }
                if (s.run[b] >= 2) line = max(line, p[b].toDouble())
                // only a line that held for seconds is remembered: a held note in a voice is not
                if (s.run[b] >= LINE_REMEMBER) s.mem[b] = now
            }
            for (b in 0 until nb) if (s.mem[b] != 0.0 && now - s.mem[b] < LINE_MEMORY_MS) for (d in -g..g) { val j = b + d; if (j in 0 until nb) ex[j] = true }
            // the channel's strongest peak, steady or not, and the bins beside it: a carrier whose level wanders (fading, a
            // keyed carrier fluttering) moves its own bins, while a voice moves bins 300 Hz and more from its carrier
            run {
                var pk = -1; var pv = LINE_MIN
                for (b in 0 until nb) if (p[b] > pv) { pv = p[b].toDouble(); pk = b }
                if (pk >= 0) for (d in -g..g) { val j = pk + d; if (j in 0 until nb) ex[j] = true }
            }
            // how far the bins left move (the mean of the quarter that move most: a voice's bins, not the noise around
            // them), and the power in them
            var pw = 0.0; var cnt = 0; var tot = 0.0
            for (b in 0 until nb) tot += p[b]
            s.totDb = 10 * log10(max(1e-3, tot / nb - 1))
            val mvs = ArrayList<Double>()
            // each bin's move is measured against its own noise floor (fast down, slow up), so a stretch of the span with
            // more noise than the rest (a receiver's own noise near its center) moves no more than a quiet one
            for (b in 0 until nb) {
                val f = s.fl[b].toDouble(); val v = p[b].toDouble()
                s.fl[b] = (if (f == 0.0) v else if (v < f) f + FLOOR_DOWN * (v - f) else f + FLOOR_UP * (v - f)).toFloat()
            }
            if (s.hist.size >= 2) { val q = s.hist[s.hist.size - 2]; for (b in 0 until nb) if (!ex[b]) { mvs.add(abs(p[b].toDouble() - q[b].toDouble()) / max(1e-3, s.fl[b].toDouble())); pw += p[b]; cnt++ } }
            mvs.sortDescending()
            val top = max(1, mvs.size / 4)
            s.d = if (cnt >= nb / 4.0) { var a = 0.0; for (k in 0 until min(top, mvs.size)) a += mvs[k]; a / top } else Double.NaN
            s.sigDb = if (cnt != 0) 10 * log10(max(1e-3, pw / cnt - 1)) else 0.0
            if (s.d.isFinite()) ds.add(s.d)
            // the steady line's history: since when, and its share of the last ten minutes
            val dt = if (s.lastT != 0.0) min(1_000.0, now - s.lastT) else 0.0; s.lastT = now
            val kk = exp(-dt / STEADY_TAU_MS); s.seen = s.seen * kk + (if (line != 0.0 || now - s.lineLast <= LINE_GONE_MS) dt else 0.0); s.total = s.total * kk + dt
            // a weak line misses a measurement now and then: it counts as gone only after [LINE_GONE_MS] without it
            if (line != 0.0) { s.lineDb = (10 * log10(line)).roundToInt(); s.lineLast = now; if (s.lineSince == 0.0) s.lineSince = now }
            else if (now - s.lineLast > LINE_GONE_MS) { s.lineDb = 0; s.lineSince = 0.0 }
        }
        val dref = if (ds.isNotEmpty()) quietQuarter(ds.toDoubleArray(), ds.size).let { if (it == 0.0) 1e-9 else it } else 1e-9
        val thr = params.thresholdDb
        for (s in st) {
            if (s.hist.isEmpty()) { s.fl.fill(0f); s.v = ArrayList(); s.voiceDb = 0.0; s.over = 0; continue }
            // too few bins left to measure (a strong carrier and its neighbors): the level holds
            if (s.d.isFinite()) s.v.add(s.d / dref)
            if (s.v.size > V_N) s.v.removeAt(0)
            val sorted = s.v.sorted(); val keep = sorted.take(max(1, sorted.size - V_DROP))
            s.voiceDb = if (s.v.size >= 4) 10 * log10(max(1e-3, keep.sum() / keep.size)) else 0.0
            // a channel opens on its voice moving its bins (a weak talker), or on plenty of power outside its steady lines (a
            // strong one, whose voice fills the channel without much motion); the demodulator then has to find a voice in it
            s.over = if (s.voiceDb > thr || s.sigDb >= CB_SIG_OPEN_DB) s.over + 1 else 0
        }
        // open channels: still voiced? A carrier that drops away ends the transmission at once (the next talker may key
        // up a moment later); without one (SSB, or a weak talker under a steady line) the voice going quiet ends it
        for (o in opens.values.toList()) {
            // an opening that found every demodulator busy gets one as soon as one is free, and its check starts then
            if (o.probe == null && probes() < cap) { o.probe = makeProbe(o.hz, o.tileKey); o.cut = false; checkFrom[o.id] = now }
            val i = cbChannel(o.hz) - 1; val s = st[i]; val p = o.probe
            // a voice is AM, FM or sideband to the demodulator: something that moves the spectrum but measures as none of
            // them in its first seconds (a burst of noise from a nearby device) is dropped, not logged, and the channel is
            // held shut a while
            if (p != null && o.id !in confirmed && now - (checkFrom[o.id] ?: o.startMs) >= CB_CONFIRM_MS) {
                if (voiced(p, o.hz)) confirmed.add(o.id)
                else { drop(o, now); continue }
            }
            o.snr = s.sigDb; o.peak = max(o.peak, s.sigDb)
            if (p != null) {
                p.noiseRatio = noiseOf(i); p.noiseVarIn = noiseVarIn
                val pk = max(peakLevel[o.id] ?: -99.0, p.levelDb); peakLevel[o.id] = pk
                val m = p.mode(); val gone = (m == CbMode.AM || m == CbMode.FM) && p.levelDb < pk - CARRIER_DROP_DB
                val g0 = goneMs[o.id]
                if (!gone) goneMs.remove(o.id)
                else if (g0 == null) goneMs[o.id] = now
                else if (now - g0 >= CARRIER_GONE_MS) { close(o, g0 - MEASURE_STEP_MS); continue }
            }
            if (s.voiceDb > thr - 2 || s.sigDb >= CB_SIG_OPEN_DB - 3) o.quietMs = 0.0
            else if (o.quietMs == 0.0) o.quietMs = now
            else if (now - o.quietMs >= CB_CLOSE_HOLD_MS) close(o, o.quietMs)
        }
        // new talkers: four measurements over the threshold, and not a strong neighbor's splatter (an open channel within
        // 20 kHz with its power [SPLATTER_DB] over this one's)
        for (i in st.indices) {
            if (st[i].over < 4 || now < warmUntil || now - st[i].noVoiceMs < CB_DROP_HOLD_MS) continue
            val hz = CB_CHANNELS[i]
            if (opens.values.any { it.hz == hz }) continue
            if (opens.values.any { abs(it.hz - hz) <= 20_000 && st[cbChannel(it.hz) - 1].totDb - st[i].totDb > SPLATTER_DB }) continue
            val k = ((hz.toDouble() / CB_RASTER).roundToInt() - first).toInt()
            if (k < 0 || k >= count) continue
            openAt(k, now)
        }
    }

    /**
     * Whether an opening is a readable station by home's measure (a carrier 22 dB over the median through the keyup, or
     * a clear sideband), and not sideband facing a busy neighbor 10 kHz away (USB facing the channel above, LSB the one
     * below), which is that neighbor's AM splatter.
     */
    private fun voiced(p: CbProbe, hz: Long): Boolean {
        if (!p.readable()) return false
        val m = p.measuredMode(); val own = st.getOrNull(cbChannel(hz) - 1)
        fun busy(f: Long): Boolean {
            val ch = cbChannel(f); if (ch == 0) return false; val nn = st[ch - 1]
            return opens.values.any { it.hz == f } || (own != null && nn.sigDb >= own.sigDb + SPLATTER_FACING_DB)
        }
        if (m == CbMode.USB && busy(hz + 10_000)) return false
        if (m == CbMode.LSB && busy(hz - 10_000)) return false
        return true
    }
    /** An opening that never measured as a voice: gone without a trace, and its channel held shut a while. */
    private fun drop(o: WatchOpen<CbProbe>, now: Double) {
        val s = st.getOrNull(cbChannel(o.hz) - 1)
        opens.remove(o.id); peakLevel.remove(o.id); goneMs.remove(o.id); confirmed.remove(o.id); checkFrom.remove(o.id)
        if (s != null) { s.v = ArrayList(); s.over = 0; s.noVoiceMs = now }
        dropped++
    }
    /** One that ends before its voice check (a carrier dropping within 3 s) faces the check as it ends. */
    override fun close(o: WatchOpen<CbProbe>, endMs: Double) {
        // (one never demodulated cannot be checked: it is not logged either)
        val p = o.probe
        if (o.id !in confirmed && (p == null || !voiced(p, o.hz))) { drop(o, nowMs()); return }
        super.close(o, endMs)
    }

    override fun closed(o: WatchOpen<CbProbe>, t: TxRec) {
        peakLevel.remove(o.id); goneMs.remove(o.id); confirmed.remove(o.id); checkFrom.remove(o.id)
        val i = cbChannel(o.hz) - 1
        // the next transmission on the channel opens on its own voice, not on what is left of this one's
        if (i >= 0) { st[i].v = ArrayList(); st[i].over = 0 }
        val p = o.probe
        val m = p?.mode() ?: st.getOrNull(i)?.mode ?: CbMode.AM
        txMode[t.id] = m
        // the carriers it was heard on, in order with when (ms into it): one a keyup is the aim
        if (p != null) { txCarriers[t.id] = p.trk.changes.map { CarrierChange(it.ms, Math.round(it.hz).toDouble()) }; if (txCarriers.size > 4_000) txCarriers.remove(txCarriers.keys.first()) }
        if (txMode.size > 4_000) txMode.remove(txMode.keys.first())
        val mm = p?.measuredMode()
        if (i >= 0 && mm != null) st[i].mode = mm
    }

    override fun clear() { synchronized(lock) { super.clear(); txMode.clear(); txCarriers.clear() } }

    /** Each of the 40 channels as the screen shows it. */
    private fun chans(now: Double): List<CbChan> {
        val half = plan.spanHalf(rate)
        return CB_CHANNELS.mapIndexed { i, hz ->
            val s = st[i]; val key = chanKey(hz); val o = opens.values.firstOrNull { it.hz == hz }; val p = o?.probe
            val manual = cbPrefs.modes[key]
            val steadyMs = if (s.lineSince != 0.0) now - s.lineSince else 0.0
            CbChan(
                ch = i + 1, hz = hz, key = key, inSpan = rate != 0 && abs(hz - centerHz) <= half, open = o != null,
                mode = p?.mode() ?: manual ?: s.mode, measured = p?.measuredMode(), manual = manual, clarHz = cbPrefs.clar[key] ?: 0,
                voiceDb = (s.voiceDb * 10).roundToInt() / 10.0, sigDb = (s.sigDb * 10).roundToInt() / 10.0,
                lineDb = s.lineDb, steadyMs = steadyMs, steadyPct = if (s.total > 0) (100 * s.seen / s.total).roundToInt() else 0,
                steady = o == null && s.lineDb > 0 && steadyMs >= STEADY_SHOW_MS,
            )
        }
    }

    override fun snapshotLocked(now: Double): HpSnap {
        val s = super.snapshotLocked(now)
        val live = HashMap<Int, CbMode>(); for (o in opens.values) { val p = o.probe ?: continue; live[o.id] = p.mode() }
        // a transmission still waiting for its voice check is on the air, but not yet known to be a station (pending)
        val rows = s.rows.map { r -> r.copy(mode = (live[r.id] ?: txMode[r.id])?.name ?: "", pending = r.live && r.id !in confirmed) }
        return CbSnap(s, rows, chans(now))
    }

    /** The whole picture now, with the 40 channels. */
    fun cbSnapshot(): CbSnap = snapshot() as CbSnap
}
