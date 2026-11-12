package com.rocketgod.mayhem.core.spectrum

import kotlin.math.floor
import kotlin.math.ln1p
import kotlin.math.min

/**
 * Spectrum: the persistence (density) display. Every frame drops a hit in each column at each bin's level; old hits
 * fade by `decay` per frame, so where a signal spends its time glows brightest and a rare burst still shows.
 */
class Persistence(val cols: Int, val rows: Int, var decay: Double = 0.93) {
    val hits = FloatArray(cols * rows)
    fun clear() { hits.fill(0f) }
    /** Fold in a trace (dB per bin) drawn with `top` dB at row 0 and `range` dB over all the rows. */
    fun add(y: FloatArray, top: Double, range: Double) {
        val h = hits; val d = decay
        for (i in h.indices) h[i] = (h[i] * d).toFloat()
        val n = y.size; val c = cols; val r = rows
        for (i in 0 until n) {
            val col = min(c - 1, floor(i.toDouble() * c / n).toInt())
            val row = floor((top - y[i]) / range * r)
            if (row >= 0 && row < r) h[row.toInt() * c + col] += 1f
        }
    }
    /** Each cell's brightness 0..1 (log scaled to the busiest cell). */
    fun level(out: FloatArray = FloatArray(hits.size)): FloatArray {
        var m = 0f
        for (v in hits) if (v > m) m = v
        val k = if (m > 0) 1 / ln1p(m.toDouble()) else 0.0
        for (i in hits.indices) out[i] = (ln1p(hits[i].toDouble()) * k).toFloat()
        return out
    }
}
