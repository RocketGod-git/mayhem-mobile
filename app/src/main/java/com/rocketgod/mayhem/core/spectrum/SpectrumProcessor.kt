package com.rocketgod.mayhem.core.spectrum

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.apps.Retuner
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Spectrum: the DSP side. One FFT over the radio's span (FFT), a sweep of slices for spans wider than the radio
 * (SWEEP, stepped by the Looking Glass retune bookkeeping), or zero span (ZERO).
 *
 * Out, through [emit] on the DSP thread: [SpFrame] { live, max, min (dBFS per bin), f0, binHz, rbw, n, frames,
 * sweep, step, steps, passes } at most about 30 times a second, and [ZsCap] { amp, fm, ph, rate, trig, roll } for
 * zero span. The sweep moves the radio through its [Retuner], as Looking Glass does.
 */

enum class SpecMode { FFT, SWEEP, ZERO }

data class SpecConfig(
    val mode: SpecMode,
    /** Where the radio is tuned (FFT, ZERO). */
    val tuneHz: Double,
    val startHz: Double,
    val stopHz: Double,
    val rbwHz: Double,
    val window: WindowKind,
    val vbwHz: Double,
    val dcPatch: Boolean,
    /** SWEEP: the slice rate. */
    val sliceRate: Double,
    val zs: ZsConfig?,
)

/** What the processor hands the screen (the web worker's messages). */
sealed interface SpectrumEvent

/** One spectrum frame (`spframe`): dBFS per bin from [f0], [binHz] apart; [max] / [min] are null in a sweep. */
class SpFrame(
    val live: FloatArray, val max: FloatArray?, val min: FloatArray?,
    val f0: Double, val binHz: Double, val rbw: Double, val n: Int, val frames: Int,
    val sweep: Boolean, val step: Int, val steps: Int, val passes: Int,
) : SpectrumEvent

/** One zero-span window (`zscap`). */
class ZsCap(
    val amp: FloatArray, val fm: FloatArray, val ph: FloatArray,
    val rate: Double, val trig: Int, val roll: Boolean, val sweepSec: Double, val armed: Boolean,
) : SpectrumEvent

/** Frames per second to the screen at most. */
private const val SHOW_HZ = 30.0
/** A sweep row is never more than this many bins (a finer RBW over a very wide span is widened to fit). */
const val MAX_ROW_BINS = 262_144
/** A sweep keeps the inner part of each slice: the same 408/512 the Looking Glass keeps. */
fun sweepKeep(n: Int): Int = 2 * Math.round(n * 204.0 / 512).toInt()

/** The FFT length a sweep uses for an RBW at a slice rate, widened until the row fits MAX_ROW_BINS. */
fun sweepFft(startHz: Double, stopHz: Double, sliceRate: Double, rbwHz: Double, kind: WindowKind): Int {
    var n = max(128, fftSizeFor(sliceRate, rbwHz, kind))
    while (n > 128 && ceil((stopHz - startHz) / (sliceRate / n)) > MAX_ROW_BINS) n = n shr 1
    return n
}

/**
 * [set] and [rearm] change the DSP state directly, as the web worker does on a message: call them on the DSP thread
 * (or before the processor is handed to the engine).
 */
class SpectrumProcessor(
    var cfg: SpecConfig,
    private val emit: (SpectrumEvent) -> Unit,
    private val retune: Retuner = Retuner(),
) : IqProcessor {
    private var fftE: FftEngine? = null
    private var zs: ZeroSpan? = null
    private var rate = 0
    private var sinceShow = 0.0
    // sweep
    private var sN = 0; private var keep = 0; private var k0 = 0; private var steps = 0; private var stepHz = 0.0; private var binHz = 0.0
    private var row = FloatArray(0)
    private var lastAt = DoubleArray(0)
    private var step = 0; private var passes = 0; private var clock = 0.0

    private class SweepState(
        val re: FloatArray, val im: FloatArray, val acc: FloatArray, val w: FloatArray, val norm: Double,
        val bi: FloatArray, val bq: FloatArray, var fill: Int, var frames: Int, val enbw: Double,
    )
    private var sw: SweepState? = null

    /** Settings that need no new engine (VBW, trigger) apply in place; anything else rebuilds on the next read. */
    fun set(cfg: SpecConfig) {
        val old = this.cfg
        this.cfg = cfg
        val z = zs; val oz = old.zs; val nz = cfg.zs
        if (cfg.mode == SpecMode.ZERO && z != null && old.mode == SpecMode.ZERO && oz != null && nz != null &&
            oz.bwHz == nz.bwHz && oz.offsetHz == nz.offsetHz && oz.sweepSec == nz.sweepSec) {
            z.cfg = nz; return
        }
        val e = fftE
        if (cfg.mode == SpecMode.FFT && e != null && old.mode == SpecMode.FFT && old.rbwHz == cfg.rbwHz && old.window == cfg.window &&
            old.tuneHz == cfg.tuneHz && old.dcPatch == cfg.dcPatch) {
            e.vbwHz = cfg.vbwHz; return
        }
        if (cfg.mode == SpecMode.SWEEP && old.mode == SpecMode.SWEEP && old.rbwHz == cfg.rbwHz && old.window == cfg.window &&
            old.startHz == cfg.startHz && old.stopHz == cfg.stopHz) return
        reset(rate)
    }
    /** Arm a zero-span SINGLE again. */
    fun rearm() { zs?.rearm() }

    override fun reset(rate: Int) {
        this.rate = rate; sinceShow = 0.0
        fftE = null; zs = null; sw = null
        val c = cfg
        when (c.mode) {
            SpecMode.FFT -> fftE = FftEngine(fftSizeFor(rate.toDouble(), c.rbwHz, c.window), c.window, rate.toDouble(), c.vbwHz, c.dcPatch)
            SpecMode.ZERO -> zs = ZeroSpan(rate.toDouble(), c.zs!!) { cap ->
                emit(ZsCap(cap.amp, cap.fm, cap.ph, cap.rate, cap.trig, cap.roll, zs?.sweepSec ?: 0.0, !(zs?.done ?: false)))
            }
            SpecMode.SWEEP -> startSweep()
        }
    }
    /** The radio has confirmed the frequency asked for (the driver's applied frequency is also polled on every read). */
    fun tuned() { retune.tuned() }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (rate != this.rate) reset(rate)
        val c = cfg
        if (c.mode == SpecMode.ZERO) { zs?.push(iq, len); return }
        if (c.mode == SpecMode.SWEEP) { sweepIq(iq, len, rate); return }
        val e = fftE ?: return
        e.push(iq, len)
        sinceShow += len shr 1
        if (sinceShow < rate / SHOW_HZ || e.framesSince == 0) return
        sinceShow = 0.0
        // the bins inside [start, stop]
        val h = e.n shr 1; val bin = e.binHz
        val a = max(0, ceil((c.startHz - c.tuneHz) / bin + h).toInt()); val b = min(e.n - 1, floor((c.stopHz - c.tuneHz) / bin + h).toInt())
        if (b < a) return
        val t = e.take(a, b)
        emit(SpFrame(t.live, t.max, t.min, c.tuneHz + (a - h) * bin, bin, e.rbwHz, e.n, t.frames, false, 0, 1, e.frames))
    }

    private fun startSweep() {
        val c = cfg
        val n = sweepFft(c.startHz, c.stopHz, c.sliceRate, c.rbwHz, c.window)
        sN = n
        keep = sweepKeep(n); k0 = (n shr 1) - (keep shr 1)
        binHz = c.sliceRate / n; stepHz = keep * binHz
        steps = max(1, ceil((c.stopHz - c.startHz) / stepHz).toInt())
        val bins = min(steps * keep, ceil((c.stopHz - c.startHz) / binHz).toInt())
        row = FloatArray(bins) { -200f }
        lastAt = DoubleArray(steps) { -1.0 }
        step = 0; passes = 0; clock = 0.0
        val w = windowOf(c.window, n); val g = windowGains(w)
        sw = SweepState(FloatArray(n), FloatArray(n), FloatArray(n), w, 1 / ((128 * g.sum) * (128 * g.sum)), FloatArray(n), FloatArray(n), 0, 0, g.enbw)
        retune.start(Math.round(centerOf(0)))
    }
    /** The kept part of slice i covers [start + i·step, start + (i+1)·step). */
    private fun centerOf(i: Int): Double = cfg.startHz + stepHz / 2 + i * stepHz

    private fun sweepIq(iq: ByteArray, len: Int, rate: Int) {
        val s = sw ?: return
        val nSamp = len shr 1
        clock += nSamp
        if (retune.stale()) return
        val n = sN; val h = n shr 1
        // every whole frame in this read (and across reads, for an FFT longer than one), power-averaged
        var k = 0
        while (k < nSamp) {
            val take = min(n - s.fill, nSamp - k)
            for (j in 0 until take) { s.bi[s.fill + j] = iqCount(iq[2 * (k + j)]).toFloat(); s.bq[s.fill + j] = iqCount(iq[2 * (k + j) + 1]).toFloat() }
            s.fill += take; k += take
            if (s.fill == n) {
                for (j in 0 until n) { s.re[j] = s.bi[j] * s.w[j]; s.im[j] = s.bq[j] * s.w[j] }
                Dsp.fft(s.re, s.im)
                for (i in 0 until n) {
                    val t = if (i < h) i + h else i - h
                    s.acc[i] = (s.acc[i] + (s.re[t].toDouble() * s.re[t] + s.im[t].toDouble() * s.im[t]) * s.norm).toFloat()
                }
                s.fill = 0; s.frames++
            }
        }
        if (s.frames == 0) return   // an FFT longer than one read: keep collecting on this step
        for (i in 0 until n) s.acc[i] = (s.acc[i].toDouble() / s.frames).toFloat()
        patchDc(s.acc, h, dcHalfWidth(cfg.window))
        // video filter across passes: each slice against what it read last pass
        val was = lastAt[step]
        val alpha = if (was < 0) 1.0 else videoAlpha(cfg.vbwHz, (clock - was) / rate)
        lastAt[step] = clock
        val base = step * keep
        var j = 0
        while (j < keep && base + j < row.size) {
            val p = s.acc[k0 + j].toDouble()
            val old = row[base + j]
            val lin = if (alpha >= 1 || old <= -199) p else 10.0.pow(old / 10.0) + alpha * (p - 10.0.pow(old / 10.0))
            row[base + j] = toDb(lin).toFloat()
            j++
        }
        s.acc.fill(0f); s.frames = 0; s.fill = 0
        step++
        val wrapped = step >= steps
        if (wrapped) { step = 0; passes++ }
        sinceShow += nSamp
        if (wrapped || sinceShow >= rate / (SHOW_HZ / 3)) {
            sinceShow = 0.0
            val live = row.copyOf()
            emit(SpFrame(live, null, null, cfg.startHz, binHz, s.enbw * binHz, n, 1, true, if (wrapped) steps else step, steps, passes))
        }
        retune.next(Math.round(centerOf(step)), nSamp, rate)
    }
}
