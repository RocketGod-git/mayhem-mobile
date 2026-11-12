package com.rocketgod.mayhem.core.spectrum

import kotlin.math.max
import kotlin.math.min

/**
 * Spectrum: markers and peak search, as on a bench analyzer.
 *
 * A peak is a local maximum that the trace both rises to and falls from by at least the peak excursion (6 dB by
 * default) before meeting anything higher, and that sits above the peak threshold. PEAK puts a marker on the highest
 * peak; NEXT PEAK on the highest peak below the marker's current level; NEXT LEFT / NEXT RIGHT on the nearest peak
 * to that side. With no peak at all, PEAK falls back to the highest bin.
 */

const val PEAK_EXCURSION_DB = 6.0
const val MARKER_COUNT = 4

data class Marker(
    var on: Boolean,
    /** Where the marker sits, in hertz (kept across span changes). */
    var hz: Double,
    /** A delta marker reads relative to marker 1. */
    var delta: Boolean,
    /** Which trace (0..3) it reads. */
    var trace: Int,
)
fun defaultMarkers(): List<Marker> = List(MARKER_COUNT) { Marker(on = false, hz = 0.0, delta = false, trace = 0) }

/** Every peak in y, left to right. */
fun findPeaks(y: FloatArray, excursion: Double = PEAK_EXCURSION_DB, threshold: Double = Double.NEGATIVE_INFINITY): List<Int> {
    val n = y.size
    val out = ArrayList<Int>()
    var i = 0
    while (i < n) {
        val v = y[i]
        if (!(v >= threshold) || !v.isFinite()) { i++; continue }
        // a local maximum, the first bin of a flat top
        if (i > 0 && y[i - 1] >= v) { i++; continue }
        var j = i; while (j + 1 < n && y[j + 1] == v) j++
        if (j + 1 < n && y[j + 1] > v) { i = j + 1; continue }
        // how far it falls on each side before anything higher (or the end of the trace)
        var lo = v; var k = i - 1
        while (k >= 0 && y[k] <= v) { if (y[k] < lo) lo = y[k]; k-- }
        val left = v.toDouble() - lo
        lo = v; k = j + 1
        while (k < n && y[k] <= v) { if (y[k] < lo) lo = y[k]; k++ }
        val right = v.toDouble() - lo
        if (min(left, right) >= excursion) out.add(i)
        i = j + 1
    }
    return out
}

/** The highest bin (the first, on a tie). */
fun argMax(y: FloatArray): Int {
    var b = 0
    for (i in 1 until y.size) if (y[i] > y[b]) b = i
    return b
}

/** The highest peak, or the highest bin when nothing qualifies. */
fun peakSearch(y: FloatArray, excursion: Double = PEAK_EXCURSION_DB, threshold: Double = Double.NEGATIVE_INFINITY): Int {
    val p = findPeaks(y, excursion, threshold)
    if (p.isEmpty()) return argMax(y)
    var b = p[0]
    for (i in p) if (y[i] > y[b]) b = i
    return b
}

/** The highest peak lower than the bin `from`; `from` itself when there is none. */
fun nextPeak(y: FloatArray, from: Int, excursion: Double = PEAK_EXCURSION_DB, threshold: Double = Double.NEGATIVE_INFINITY): Int {
    val lvl = y[from]
    var b = -1
    for (i in findPeaks(y, excursion, threshold)) {
        if (i == from || y[i] > lvl || (y[i] == lvl && i < from)) continue
        if (b < 0 || y[i] > y[b]) b = i
    }
    return if (b < 0) from else b
}

/** The nearest peak to the left of `from`; `from` itself when there is none. */
fun nextPeakLeft(y: FloatArray, from: Int, excursion: Double = PEAK_EXCURSION_DB, threshold: Double = Double.NEGATIVE_INFINITY): Int =
    findPeaks(y, excursion, threshold).lastOrNull { it < from } ?: from

/** The nearest peak to the right of `from`; `from` itself when there is none. */
fun nextPeakRight(y: FloatArray, from: Int, excursion: Double = PEAK_EXCURSION_DB, threshold: Double = Double.NEGATIVE_INFINITY): Int =
    findPeaks(y, excursion, threshold).firstOrNull { it > from } ?: from

/** A peak's refined position: an offset in bins (-0.5..0.5) and the level at that offset. */
data class Refined(val offset: Double, val level: Double)

/**
 * The peak's true position and level from a parabola through it and its two neighbors (in dB): an offset in bins
 * (-0.5..0.5) and the level at that offset. A tone between two bins reads its frequency to a small part of a bin.
 */
fun refinePeak(y: FloatArray, i: Int): Refined {
    if (i <= 0 || i >= y.size - 1) return Refined(0.0, y[i].toDouble())
    val a = y[i - 1].toDouble(); val b = y[i].toDouble(); val c = y[i + 1].toDouble()
    val den = a - 2 * b + c
    if (!(den < 0)) return Refined(0.0, b)
    val d = max(-0.5, min(0.5, 0.5 * (a - c) / den))
    return Refined(d, b - 0.25 * (a - c) * d)
}

/** The bin nearest to a frequency, clamped to the trace. */
fun binOf(hz: Double, f0: Double, binHz: Double, n: Int): Int =
    max(0L, min((n - 1).toLong(), Math.round((hz - f0) / binHz))).toInt()

