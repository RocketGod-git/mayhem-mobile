package com.rocketgod.mayhem.core.spectrum

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.min
import kotlin.math.pow

/**
 * Spectrum: automatic pulse measurements on a zero-span amplitude trace (dB), on the linear envelope as an
 * oscilloscope measures them. The trace must hold two distinct levels (twoLevels); the top and base are the medians of
 * the samples above and below the threshold between them; edges are where the envelope crosses 50 % of the way from base to top (with 10 %
 * hysteresis, and the new level held PULSE_HOLD samples), interpolated between samples. Width = rise to fall, period = rise to rise, duty = width / period,
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

/** How far the top must sit above the base for the trace to count as pulsed. */
const val PULSE_MIN_DB = 10.0
/** The two levels must stand apart by this much against their own spread: (μ1 − μ0)² / (σ0² + σ1²). */
const val PULSE_SEPARATION = 4.0
/** Each level must hold at least this share of the samples (a deep fade now and then is not a pulse train). */
const val PULSE_MIN_SHARE = 0.02
/** A crossing counts only when the new level holds this many samples (a noise spike is not an edge). */
const val PULSE_HOLD = 3

/**
 * Whether a trace (dB) holds two distinct levels, and the dB value between them: the threshold that best splits its
 * 0.5 dB histogram into two classes (Otsu), accepted only when the classes stand apart against their spread and each
 * holds a fair share of the samples. The envelope of noise alone (its deep fades included) fails this.
 */
fun twoLevels(db: FloatArray): Double? {
    val n = db.size
    var lo = Double.POSITIVE_INFINITY; var hi = Double.NEGATIVE_INFINITY
    for (i in 0 until n) { val d = db[i].toDouble(); if (d.isFinite()) { if (d < lo) lo = d; if (d > hi) hi = d } }
    if (!(hi - lo >= PULSE_MIN_DB)) return null
    val w = 0.5; val bins = ceil((hi - lo) / w).toInt() + 1
    val h = DoubleArray(bins)
    var tot = 0.0; var sum = 0.0
    for (i in 0 until n) { val d = db[i].toDouble(); if (!d.isFinite()) continue; h[min(bins - 1, floor((d - lo) / w).toInt())]++; tot++; sum += d }
    var w0 = 0.0; var s0 = 0.0; var best = -1.0; var bestK = -1
    for (k in 0 until bins - 1) {
        val c = lo + (k + 0.5) * w
        w0 += h[k]; s0 += h[k] * c
        val w1 = tot - w0; if (w0 == 0.0 || w1 == 0.0) continue
        val m0 = s0 / w0; val m1 = (sum - s0) / w1; val between = w0 * w1 * (m1 - m0) * (m1 - m0)
        if (between > best) { best = between; bestK = k }
    }
    if (bestK < 0) return null
    val th = lo + (bestK + 1) * w
    var n0 = 0; var n1 = 0; var a0 = 0.0; var a1 = 0.0; var q0 = 0.0; var q1 = 0.0
    for (i in 0 until n) { val d = db[i].toDouble(); if (!d.isFinite()) continue; if (d < th) { n0++; a0 += d; q0 += d * d } else { n1++; a1 += d; q1 += d * d } }
    if (n0 < PULSE_MIN_SHARE * tot || n1 < PULSE_MIN_SHARE * tot) return null
    val m0 = a0 / n0; val m1 = a1 / n1; val v0 = q0 / n0 - m0 * m0; val v1 = q1 / n1 - m1 * m1
    if ((m1 - m0) * (m1 - m0) < PULSE_SEPARATION * (v0 + v1)) return null
    return th
}

private fun pulseMedian(a: List<Double>): Double {
    val s = a.sorted()
    return if (s.isNotEmpty()) (if (s.size and 1 != 0) s[s.size shr 1] else (s[s.size / 2 - 1] + s[s.size / 2]) / 2) else Double.NaN
}
private fun pulseMean(a: List<Double>): Double = if (a.isNotEmpty()) a.sum() / a.size else Double.NaN

/**
 * Pulse statistics for an amplitude trace in dB sampled at `rate`; null when there is no on/off structure: top and base
 * under PULSE_MIN_DB apart, or not two distinct levels (noise and a steady carrier's fading dips are not pulses).
 */
fun pulseStats(ampDb: FloatArray, rate: Double): PulseStats? {
    val n = ampDb.size
    if (n < 4) return null
    val v = DoubleArray(n)
    for (i in 0 until n) v[i] = 10.0.pow(ampDb[i] / 20.0)
    val split = twoLevels(ampDb) ?: return null
    val ups = ArrayList<Double>(); val downs = ArrayList<Double>()
    for (i in 0 until n) (if (ampDb[i] > split) ups else downs).add(v[i])
    val top = pulseMedian(ups); val base = pulseMedian(downs)
    if (!(20 * log10(top / base) >= PULSE_MIN_DB)) return null
    fun at(f: Double) = base + f * (top - base)
    val l10 = at(0.1); val l50 = at(0.5); val l90 = at(0.9); val hy = 0.1 * (top - base)
    /** Where the trace crosses `lvl` between samples i-1 and i, in samples. */
    fun cross(i: Int, lvl: Double): Double { val a = v[i - 1]; val b = v[i]; return if (b == a) i.toDouble() else i - 1 + (lvl - a) / (b - a) }
    val rises = ArrayList<Double>(); val falls = ArrayList<Double>(); val riseT = ArrayList<Double>(); val fallT = ArrayList<Double>()
    var high = v[0] > l50
    /** Whether samples i .. i + PULSE_HOLD - 1 all stay on the far side of the 50 % level. */
    fun holds(i: Int, up: Boolean): Boolean { for (j in i until min(n, i + PULSE_HOLD)) if (if (up) v[j] < l50 else v[j] > l50) return false; return true }
    for (i in 1 until n) {
        if (!high && v[i] >= l50 + hy && holds(i, true)) {
            high = true
            var j = i; while (j > 1 && v[j - 1] >= l50) j--
            rises.add(cross(j, l50))
            // 10 % on the way up (searching back) and 90 % (searching forward)
            var a = j; while (a > 1 && v[a - 1] >= l10) a--
            var b = i; while (b < n - 1 && v[b] < l90) b++
            if (a > 1 && v[a - 1] < l10 && v[b] >= l90 && b > 0) riseT.add(cross(b, l90) - cross(a, l10))
        } else if (high && v[i] <= l50 - hy && holds(i, false)) {
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

/** A trigger level for a trace (dB): its median (the noise, between bursts) plus `marginDb`, rounded to 1 dB. */
fun autoLevel(ampDb: FloatArray, marginDb: Double = 12.0): Double {
    val s = ampDb.filter { it.isFinite() }.toFloatArray(); s.sort()
    return if (s.isNotEmpty()) floor(s[s.size shr 1] + marginDb + 0.5) else Double.NaN
}
