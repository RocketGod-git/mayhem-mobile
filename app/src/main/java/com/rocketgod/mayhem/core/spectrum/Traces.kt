package com.rocketgod.mayhem.core.spectrum

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Spectrum: the four traces. Each one is fed every displayed frame and keeps it its own way: LIVE draws the frame,
 * MAX and MIN hold the highest and lowest value each bin has seen (from the engine's per-frame extremes, so nothing
 * between two drawn frames is missed), AVG power-averages the last N frames, VIEW freezes what is there and OFF hides
 * the trace. All values are in the display unit (dBm or dBFS); a change of bin layout starts a trace over.
 */

enum class TraceMode { LIVE, MAX, MIN, AVG, VIEW, OFF }
val TRACE_MODES: List<TraceMode> = TraceMode.values().toList()
const val TRACE_COUNT = 4

class Trace(mode: TraceMode, var avgN: Int = 10) {
    /** How the trace keeps what it is fed; change it with [setMode] (which clears the trace when that matters). */
    var mode: TraceMode = mode
        private set
    var data: FloatArray? = null
    private var lin: FloatArray? = null
    /** Frames folded in since the trace was last cleared. */
    var count = 0
    /** The bin layout the data belongs to: first bin's frequency and spacing. */
    var f0 = 0.0
    var binHz = 0.0

    fun clear() { data = null; lin = null; count = 0 }
    fun setMode(m: TraceMode) { if (m != mode) { mode = m; if (m != TraceMode.VIEW && m != TraceMode.OFF) clear() } }

    /** Fold in one frame: `live` is the frame, `max` / `min` the highest and lowest values since the frame before. */
    fun update(live: FloatArray, max: FloatArray?, min: FloatArray?, f0: Double, binHz: Double) {
        if (mode == TraceMode.VIEW || mode == TraceMode.OFF) return
        val n = live.size
        var d = data
        if (d == null || d.size != n || abs(f0 - this.f0) > binHz * 1e-3 || abs(binHz - this.binHz) > binHz * 1e-6) {
            d = FloatArray(n); data = d; lin = null; count = 0; this.f0 = f0; this.binHz = binHz
        }
        val hi = max ?: live; val lo = min ?: live
        when (mode) {
            TraceMode.LIVE -> System.arraycopy(live, 0, d, 0, n)
            TraceMode.MAX -> if (count == 0) System.arraycopy(hi, 0, d, 0, n) else for (i in 0 until n) if (hi[i] > d[i]) d[i] = hi[i]
            TraceMode.MIN -> if (count == 0) System.arraycopy(lo, 0, d, 0, n) else for (i in 0 until n) if (lo[i] < d[i]) d[i] = lo[i]
            TraceMode.AVG -> {
                // a running mean while the first N frames come in, then an exponential average with weight 1/N (a bench
                // analyzer's trace average); in linear power so noise is not biased low
                val l = lin ?: FloatArray(n).also { lin = it }
                val k = 1.0 / kotlin.math.min(count + 1, kotlin.math.max(1, avgN))
                for (i in 0 until n) {
                    val p = 10.0.pow(live[i] / 10.0)
                    l[i] = (l[i] + k * (p - l[i])).toFloat()
                    d[i] = (10 * log10(l[i] + 1e-30)).toFloat()
                }
            }
            else -> {}
        }
        count++
    }
}

/** The default set: one live trace, a max hold, and two traces waiting. */
fun defaultTraces(): List<Trace> = listOf(Trace(TraceMode.LIVE), Trace(TraceMode.MAX), Trace(TraceMode.OFF), Trace(TraceMode.OFF))

/**
 * Reduce a trace to `cols` display columns with a detector: PEAK keeps each column's highest bin (nothing narrow is
 * lost), SAMPLE its middle bin, RMS the power mean of its bins. With fewer bins than columns, each bin is repeated.
 */
enum class Detector { PEAK, SAMPLE, RMS }
val DETECTORS: List<Detector> = Detector.values().toList()
fun toColumns(y: FloatArray, cols: Int, det: Detector, out: FloatArray = FloatArray(cols)): FloatArray {
    val n = y.size
    for (c in 0 until cols) {
        val a = floor(c.toDouble() * n / cols).toInt(); val b = max(a + 1, floor((c + 1).toDouble() * n / cols).toInt())
        if (det == Detector.SAMPLE || b - a == 1) { out[c] = y[min(n - 1, (a + b - 1) shr 1)]; continue }
        if (det == Detector.PEAK) { var m = Float.NEGATIVE_INFINITY; for (i in a until b) if (y[i] > m) m = y[i]; out[c] = m; continue }
        var s = 0.0; for (i in a until b) s += 10.0.pow(y[i] / 10.0)
        out[c] = (10 * log10(s / (b - a) + 1e-30)).toFloat()
    }
    return out
}
