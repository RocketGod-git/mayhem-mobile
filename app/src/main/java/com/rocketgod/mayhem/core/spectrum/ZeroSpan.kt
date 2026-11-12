package com.rocketgod.mayhem.core.spectrum

import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Spectrum: zero span. The analyzer stays on one frequency and shows what happens there over time, as an
 * oscilloscope would: the amplitude through a chosen filter bandwidth, the instantaneous frequency and the phase.
 *
 * The channel is mixed to 0 Hz from wherever it sits in the radio's span (the radio is tuned off it, so the DC spike
 * is not on the signal), averaged down in a boxcar stage, low-passed to half the filter bandwidth by a windowed-sinc
 * FIR and decimated to about four samples per hertz of filter bandwidth.
 *
 * Triggering: FREE runs as a roll (the newest window, redrawn as it moves); RISE and FALL wait for the amplitude to
 * cross the trigger level that way (1 dB of hysteresis) and capture a window with `pre` of it before the trigger;
 * SINGLE disarms after one capture until it is armed again.
 */

enum class TrigMode { FREE, RISE, FALL }
val TRIG_MODES: List<TrigMode> = TrigMode.values().toList()
/** Filter bandwidths on offer (a radio shows those its rates allow). */
val ZS_BWS: List<Double> = listOf(1_000.0, 3_000.0, 10_000.0, 30_000.0, 100_000.0, 300_000.0, 1_000_000.0)
/** The most samples one window holds. */
const val ZS_MAX_POINTS = 262_144
/** The most points sent to the screen per window (more are peak-reduced to this). */
const val ZS_SHOW_POINTS = 65_536
const val TRIG_HYST_DB = 1.0
/** Where the channel sits from the radio's center, as a fraction of the rate: clear of DC, inside the radio's filter. */
const val ZS_OFFSET = 0.2
/** The widest filter that fits at a rate with the channel ZS_OFFSET away from DC. */
fun zsMaxBw(rate: Double): Double = 0.36 * rate
private const val MAX_TAPS = 63

/** A windowed-sinc (Blackman) low-pass with cutoff fc (cycles per sample), unity gain at DC. */
fun designLowpass(fc: Double, taps: Int): FloatArray {
    val h = FloatArray(taps); val m = (taps - 1) / 2.0
    var s = 0.0
    for (i in 0 until taps) {
        val x = i - m
        val sinc = if (x == 0.0) 2 * fc else sin(2 * Math.PI * fc * x) / (Math.PI * x)
        val w = 0.42 - 0.5 * cos(2 * Math.PI * i / (taps - 1)) + 0.08 * cos(4 * Math.PI * i / (taps - 1))
        h[i] = (sinc * w).toFloat(); s += h[i]
    }
    for (i in 0 until taps) h[i] = (h[i] / s).toFloat()
    return h
}

data class ZsConfig(
    /** The channel's offset from the radio's center, Hz. */
    val offsetHz: Double,
    val bwHz: Double,
    val sweepSec: Double,
    val trigger: TrigMode,
    val single: Boolean,
    /** Trigger level, dBFS. */
    val levelDb: Double,
    /** Fraction of the window before the trigger, 0..0.9. */
    val pre: Double,
)

class ZsCapture(
    /** Amplitude dBFS, instantaneous frequency Hz (from the channel center), phase degrees. */
    val amp: FloatArray, val fm: FloatArray, val ph: FloatArray,
    /** Points per second of the arrays (after any reduction for the screen). */
    val rate: Double,
    /** The trigger's index in the arrays, or -1 for a roll. */
    val trig: Int,
    val roll: Boolean,
)

/** The decimation plan for a filter at a rate: boxcar by d1, FIR by d2, to outRate. */
data class ZsPlan(val d1: Int, val d2: Int, val outRate: Double, val taps: Int)
fun zsPlan(rate: Double, bwHz: Double): ZsPlan {
    val d1 = max(1, floor(rate / (16 * bwHz)).toInt())
    val r1 = rate / d1
    val d2 = max(1, floor(r1 / (4 * bwHz)).toInt())
    val taps = max(15, min(MAX_TAPS, Math.round(6 * r1 / bwHz).toInt() or 1))
    return ZsPlan(d1, d2, r1 / d2, taps)
}

class ZeroSpan(val rate: Double, var cfg: ZsConfig, private val onCapture: (ZsCapture) -> Unit) {
    val outRate: Double
    val window: Int
    private val d1: Int
    private val d2: Int
    private val h: FloatArray
    // NCO
    private var cr = 1.0; private var ci = 0.0
    private val wr: Double; private val wi: Double
    private var ncoCount = 0
    // boxcar
    private var accI = 0.0; private var accQ = 0.0; private var accN = 0
    // FIR history (doubled so a window is one straight run)
    private val hi: FloatArray; private val hq: FloatArray
    private var hpos = 0; private var d2Count = 0
    /** FIR inputs still to come before its history is full (its first outputs are a start-up transient). */
    private var warm: Int
    // output ring
    private val cap: Int
    private val rAmp: FloatArray; private val rFm: FloatArray; private val rPh: FloatArray
    /** Output samples produced so far (absolute index). */
    var count = 0L
    private var prevI = 0.0; private var prevQ = 0.0
    // trigger state
    private var armed = true
    private var trigAt = -1L
    private var nextAllowed = 0L
    private var above = false
    private var lastRoll = 0L
    /** True once a SINGLE capture has been taken (until rearm). */
    var done = false

    init {
        val p = zsPlan(rate, cfg.bwHz)
        d1 = p.d1; d2 = p.d2; outRate = p.outRate
        h = designLowpass((cfg.bwHz / 2) / (rate / p.d1), p.taps)
        val t = h.size
        hi = FloatArray(2 * t); hq = FloatArray(2 * t)
        warm = t + 1
        val a = -2 * Math.PI * cfg.offsetHz / rate
        wr = cos(a); wi = sin(a)
        window = max(16, min(ZS_MAX_POINTS, Math.round(cfg.sweepSec * outRate).toInt()))
        cap = 2 * window + 1024
        rAmp = FloatArray(cap); rFm = FloatArray(cap); rPh = FloatArray(cap)
    }

    /** The sweep time the window actually covers (it is capped at ZS_MAX_POINTS). */
    val sweepSec: Double get() = window / outRate

    /** Arm again (after a SINGLE, or to drop a capture in progress). */
    fun rearm() { armed = true; done = false; trigAt = -1L; nextAllowed = count }

    /** Offset-128 IQ bytes ([len] valid). */
    fun push(iq: ByteArray, len: Int = iq.size) {
        val n = len shr 1
        for (k in 0 until n) sample(iqCount(iq[2 * k]).toDouble(), iqCount(iq[2 * k + 1]).toDouble())
    }
    /** Float IQ in int8 counts (the tests). */
    fun pushFloat(i: FloatArray, q: FloatArray) { for (k in i.indices) sample(i[k].toDouble(), q[k].toDouble()) }

    private fun sample(x: Double, y: Double) {
        // mix the channel down to 0 Hz
        val mi = x * cr - y * ci; val mq = x * ci + y * cr
        val nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr
        if (++ncoCount == 4096) { ncoCount = 0; val m = hypot(cr, ci); cr /= m; ci /= m }
        // boxcar
        accI += mi; accQ += mq
        if (++accN < d1) return
        val bi = accI / d1; val bq = accQ / d1
        accI = 0.0; accQ = 0.0; accN = 0
        // FIR history
        val t = h.size
        hi[hpos] = bi.toFloat(); hi[hpos + t] = bi.toFloat()
        hq[hpos] = bq.toFloat(); hq[hpos + t] = bq.toFloat()
        hpos = (hpos + 1) % t
        if (warm > 0) { warm--; if (warm > 0) return }
        if (++d2Count < d2) return
        d2Count = 0
        var si = 0.0; var sq = 0.0
        val base = hpos   // oldest sample first
        for (j in 0 until t) { si += h[j].toDouble() * hi[base + j]; sq += h[j].toDouble() * hq[base + j] }
        out(si, sq)
    }

    private fun out(i: Double, q: Double) {
        val p = (i * i + q * q) / (128 * 128)
        val amp = 10 * log10(p + 1e-20)
        // instantaneous frequency: the phase step from the last sample
        val dr = i * prevI + q * prevQ; val di = q * prevI - i * prevQ
        val fm = atan2(di, dr) * outRate / (2 * Math.PI)
        val ph = atan2(q, i) * 180 / Math.PI
        prevI = i; prevQ = q
        val at = (count % cap).toInt()
        rAmp[at] = amp.toFloat(); rFm[at] = fm.toFloat(); rPh[at] = ph.toFloat()
        count++
        trigger(amp)
    }

    private fun trigger(amp: Double) {
        val c = cfg; val now = count
        // the level crossing, with hysteresis
        val wasAbove = above
        if (amp >= c.levelDb + TRIG_HYST_DB / 2) above = true
        else if (amp < c.levelDb - TRIG_HYST_DB / 2) above = false
        // at most 20 screens a second (in signal time, which is wall time when live)
        val gap = max(1, Math.round(outRate * 0.05).toInt())
        if (c.trigger == TrigMode.FREE) {
            if (now - lastRoll >= gap || now == window.toLong()) {
                lastRoll = now
                val len = min(now, window.toLong()).toInt()
                emit(now - len, len, -1, true)
            }
            return
        }
        val pre = Math.round(max(0.0, min(0.9, c.pre)) * window).toInt()
        if (trigAt < 0) {
            if (!armed || done || now < nextAllowed) return
            val crossed = if (c.trigger == TrigMode.RISE) (!wasAbove && above) else (wasAbove && !above)
            if (!crossed || now - 1 < pre) return
            trigAt = now - 1
        }
        if (now - trigAt >= window - pre) {
            emit(trigAt - pre, window, pre, false)
            nextAllowed = trigAt + (window - pre) + gap
            trigAt = -1L
            if (c.single) { done = true; armed = false }
        }
    }

    private fun emit(start: Long, len: Int, trig: Int, roll: Boolean) {
        val k = max(1, ceil(len.toDouble() / ZS_SHOW_POINTS).toInt())
        val m = ceil(len.toDouble() / k).toInt()
        val amp = FloatArray(m); val fm = FloatArray(m); val ph = FloatArray(m)
        for (o in 0 until m) {
            // amplitude peak-held across the points folded together; frequency and phase sampled
            var a = Float.NEGATIVE_INFINITY
            val j0 = start + o * k
            for (j in j0 until min(start + len, j0 + k)) { val v = rAmp[(j % cap).toInt()]; if (v > a) a = v }
            amp[o] = a; fm[o] = rFm[(j0 % cap).toInt()]; ph[o] = rPh[(j0 % cap).toInt()]
        }
        onCapture(ZsCapture(amp, fm, ph, outRate / k, if (trig < 0) -1 else Math.round(trig.toDouble() / k).toInt(), roll))
    }
}
