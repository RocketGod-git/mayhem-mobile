package com.rocketgod.mayhem.core.spectrum

import java.util.concurrent.ConcurrentHashMap
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.log2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Spectrum: resolution and video bandwidth for an FFT analyzer.
 *
 * The resolution bandwidth (RBW) of an FFT bin is its window's equivalent noise bandwidth: ENBW (in bins) times the
 * bin spacing, rate / N. A requested RBW picks the power-of-two N nearest to it (in log), so the RBW actually used is
 * always reported back rather than the one asked for. The video bandwidth (VBW) is a single-pole low-pass on each
 * bin's power from frame to frame, as the video filter after an analog analyzer's detector; a VBW at or above the
 * RBW passes every frame through untouched.
 */

enum class WindowKind { HANN, FLATTOP }
val WINDOWS: List<WindowKind> = listOf(WindowKind.HANN, WindowKind.FLATTOP)
const val MIN_FFT = 64
const val MAX_FFT = 65536

private val windowCache = ConcurrentHashMap<String, FloatArray>()
/** The window of length n: Hann (good resolution), or a flat top (a tone reads its true level wherever it falls). */
fun windowOf(kind: WindowKind, n: Int): FloatArray {
    val key = "$kind:$n"
    windowCache[key]?.let { return it }
    val w = FloatArray(n)
    for (k in 0 until n) {
        val x = 2 * Math.PI * k / n
        // periodic windows (divide by n, not n - 1): the ENBW below is then exact
        w[k] = (if (kind == WindowKind.HANN) 0.5 - 0.5 * cos(x)
        else 0.21557895 - 0.41663158 * cos(x) + 0.277263158 * cos(2 * x) - 0.083578947 * cos(3 * x) + 0.006947368 * cos(4 * x)).toFloat()
    }
    windowCache[key] = w
    return w
}

/** A window's sum (the coherent gain times n) and its equivalent noise bandwidth in bins. */
data class WindowGains(val sum: Double, val enbw: Double)
fun windowGains(w: FloatArray): WindowGains {
    var s = 0.0; var s2 = 0.0
    for (k in w.indices) { s += w[k]; s2 += w[k].toDouble() * w[k] }
    return WindowGains(s, w.size * s2 / (s * s))
}

/** The ENBW in bins of each window (1.5 for Hann, 3.77 for the flat top). */
fun enbwBins(kind: WindowKind): Double = windowGains(windowOf(kind, 1024)).enbw

/** The RBW an N-point FFT at this rate gives. */
fun rbwOf(rate: Double, n: Int, kind: WindowKind): Double = enbwBins(kind) * rate / n

/** The power-of-two FFT length whose RBW is nearest to the one asked for, within MIN_FFT..MAX_FFT. */
fun fftSizeFor(rate: Double, rbwHz: Double, kind: WindowKind): Int {
    val ideal = enbwBins(kind) * rate / max(1e-3, rbwHz)
    val p = Math.round(log2(max(1.0, ideal))).toInt()
    return max(MIN_FFT.toDouble(), min(MAX_FFT.toDouble(), 2.0.pow(p))).toInt()
}

/** The bench 1-3-10 steps from 1 Hz to 3 MHz, for RBW and VBW. */
val BW_STEPS: List<Double> = run {
    val out = ArrayList<Double>()
    var d = 1.0
    while (d <= 1e6) { out.add(d); out.add(3 * d); d *= 10 }
    out
}

/** How many RBWs fit across the span when the RBW is automatic (a bench analyzer's span/RBW ratio). */
const val SPAN_RBW_RATIO = 500
/** The automatic RBW for a span: the 1-3-10 step at or under span / SPAN_RBW_RATIO. */
fun autoRbw(spanHz: Double): Double {
    val want = spanHz / SPAN_RBW_RATIO
    var best = BW_STEPS[0]
    for (s in BW_STEPS) if (s <= want) best = s
    return best
}

/** One step up or down the 1-3-10 ladder from v (dir +1 / -1). */
fun stepBw(v: Double, dir: Int): Double {
    var i = 0; var best = Double.POSITIVE_INFINITY
    for (k in BW_STEPS.indices) { val d = abs(ln(BW_STEPS[k] / max(1e-3, v))); if (d < best) { best = d; i = k } }
    return BW_STEPS[max(0, min(BW_STEPS.size - 1, i + dir))]
}

/**
 * The video filter's coefficient for one frame `frameSec` long: a single pole at the VBW,
 * alpha = 1 - exp(-2π · VBW · T). A VBW at the RBW gives alpha near 1 (each frame stands alone).
 */
fun videoAlpha(vbwHz: Double, frameSec: Double): Double = 1 - exp(-2 * Math.PI * max(0.0, vbwHz) * max(0.0, frameSec))

/** The video filter: each bin's power low-passed from frame to frame (in linear power, so noise is not biased low). */
class VideoFilter(val n: Int) {
    val y = FloatArray(n)
    private var primed = false
    fun reset() { primed = false }
    /** Fold in one frame of linear power with coefficient alpha. */
    fun push(p: FloatArray, alpha: Double) {
        if (!primed || alpha >= 1) { System.arraycopy(p, 0, y, 0, n); primed = true; return }
        val a = max(0.0, alpha)
        for (i in 0 until n) y[i] = (y[i] + a * (p[i].toDouble() - y[i])).toFloat()
    }
}
