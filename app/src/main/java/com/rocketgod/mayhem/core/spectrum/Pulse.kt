package com.rocketgod.mayhem.core.spectrum

import kotlin.math.log10
import kotlin.math.pow

/**
 * Spectrum: automatic pulse measurements on a zero-span amplitude trace (dB), on the linear envelope as an
 * oscilloscope measures them. The top and base levels are the medians of the samples above and below the halfway
 * point between the trace's extremes; edges are where the envelope crosses 50 % of the way from base to top (with 5 %
 * hysteresis), interpolated between samples. Width = rise to fall, period = rise to rise, duty = width / period,
 * rise time = 10 % to 90 %, fall time = 90 % to 10 %. Each is the mean over every complete instance in the trace.
 */

data class PulseStats(
    /** Top and base levels, dB. */
    val top: Double, val base: Double,
    /** Seconds (NaN when the trace holds no complete instance). */
    val width: Double, val period: Double, val rise: Double, val fall: Double,
    /** 0..1. */
    val duty: Double,
    val pulses: Int,
)

private fun pulseMedian(a: List<Double>): Double {
    val s = a.sorted()
    return if (s.isNotEmpty()) (if (s.size and 1 != 0) s[s.size shr 1] else (s[s.size / 2 - 1] + s[s.size / 2]) / 2) else Double.NaN
}
private fun pulseMean(a: List<Double>): Double = if (a.isNotEmpty()) a.sum() / a.size else Double.NaN

/** Pulse statistics for an amplitude trace in dB sampled at `rate`; null when there is no on/off structure (under 6 dB). */
fun pulseStats(ampDb: FloatArray, rate: Double): PulseStats? {
    val n = ampDb.size
    if (n < 4) return null
    val v = DoubleArray(n)
    var lo = Double.POSITIVE_INFINITY; var hi = Double.NEGATIVE_INFINITY
    for (i in 0 until n) { v[i] = 10.0.pow(ampDb[i] / 20.0); if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i] }
    val mid = (lo + hi) / 2
    val ups = ArrayList<Double>(); val downs = ArrayList<Double>()
    for (i in 0 until n) (if (v[i] > mid) ups else downs).add(v[i])
    val top = pulseMedian(ups); val base = pulseMedian(downs)
    if (!(top > 2 * base) || ups.isEmpty() || downs.isEmpty()) return null
    fun at(f: Double) = base + f * (top - base)
    val l10 = at(0.1); val l50 = at(0.5); val l90 = at(0.9); val hy = 0.05 * (top - base)
    /** Where the trace crosses `lvl` between samples i-1 and i, in samples. */
    fun cross(i: Int, lvl: Double): Double { val a = v[i - 1]; val b = v[i]; return if (b == a) i.toDouble() else i - 1 + (lvl - a) / (b - a) }
    val rises = ArrayList<Double>(); val falls = ArrayList<Double>(); val riseT = ArrayList<Double>(); val fallT = ArrayList<Double>()
    var high = v[0] > l50
    for (i in 1 until n) {
        if (!high && v[i] >= l50 + hy) {
            high = true
            var j = i; while (j > 1 && v[j - 1] >= l50) j--
            rises.add(cross(j, l50))
            // 10 % on the way up (searching back) and 90 % (searching forward)
            var a = j; while (a > 1 && v[a - 1] >= l10) a--
            var b = i; while (b < n - 1 && v[b] < l90) b++
            if (a > 1 && v[a - 1] < l10 && v[b] >= l90 && b > 0) riseT.add(cross(b, l90) - cross(a, l10))
        } else if (high && v[i] <= l50 - hy) {
            high = false
            var j = i; while (j > 1 && v[j - 1] <= l50) j--
            falls.add(cross(j, l50))
            var a = j; while (a > 1 && v[a - 1] <= l90) a--
            var b = i; while (b < n - 1 && v[b] > l10) b++
            if (a > 1 && v[a - 1] > l90 && v[b] <= l10 && b > 0) fallT.add(cross(b, l10) - cross(a, l90))
        }
    }
    val widths = ArrayList<Double>(); val periods = ArrayList<Double>()
    for (r in rises) { val f = falls.firstOrNull { it > r }; if (f != null) widths.add(f - r) }
    for (k in 1 until rises.size) periods.add(rises[k] - rises[k - 1])
    // a width with no fall after the last rise belongs to a pulse cut off by the window; it is not counted
    val width = pulseMean(widths) / rate; val period = pulseMean(periods) / rate
    return PulseStats(
        top = 20 * log10(top), base = 20 * log10(base),
        width = width, period = period, duty = width / period, rise = pulseMean(riseT) / rate, fall = pulseMean(fallT) / rate, pulses = widths.size,
    )
}
