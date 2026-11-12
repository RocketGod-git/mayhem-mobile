package com.rocketgod.mayhem.core.spectrum

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * Spectrum: power measurements on a trace (dB per bin, bins `binHz` apart starting at `f0`, each measured through the
 * RBW filter). Every bin counts the power in one RBW, and bins sit closer together than one RBW, so a band's power is
 * the sum of its bins' powers times binHz / RBW; bins straddling an edge count for the part inside it.
 */

/** dBm (or dBFS) to milliwatts (or full-scale units) and back. */
fun dbToLin(db: Double): Double = 10.0.pow(db / 10)
fun linToDb(p: Double): Double = 10 * log10(max(p, 1e-30))

/** The power between lo and hi hertz, in linear units. */
fun bandPower(y: FloatArray, f0: Double, binHz: Double, rbwHz: Double, lo: Double, hi: Double): Double {
    var s = 0.0
    val n = y.size
    val a = max(0.0, floor((lo - f0) / binHz - 0.5)).toInt(); val b = min((n - 1).toDouble(), ceil((hi - f0) / binHz + 0.5)).toInt()
    for (i in a..b) {
        val c = f0 + i * binHz; val l = max(lo, c - binHz / 2); val r = min(hi, c + binHz / 2)
        if (r > l) s += dbToLin(y[i].toDouble()) * (r - l) / binHz
    }
    return s * binHz / rbwHz
}

/** Channel power in a channel `bwHz` wide around `centerHz`, in dB. */
fun channelPower(y: FloatArray, f0: Double, binHz: Double, rbwHz: Double, centerHz: Double, bwHz: Double): Double =
    linToDb(bandPower(y, f0, binHz, rbwHz, centerHz - bwHz / 2, centerHz + bwHz / 2))

/** Occupied bandwidth and its edges, Hz, and the trace's total power, dB. */
data class Obw(val bw: Double, val lo: Double, val hi: Double, val total: Double)

/**
 * Occupied bandwidth: the band holding `pct` percent of the trace's power, with (100 - pct) / 2 percent left out on
 * each side (99 % by default, as the FCC and ETSI define it).
 */
fun occupiedBw(y: FloatArray, f0: Double, binHz: Double, rbwHz: Double, pct: Double = 99.0): Obw {
    val n = y.size
    var total = 0.0
    for (i in 0 until n) total += dbToLin(y[i].toDouble())
    val edge = total * (1 - pct / 100) / 2
    fun at(target: Double): Double {
        var c = 0.0
        for (i in 0 until n) {
            val p = dbToLin(y[i].toDouble())
            if (c + p >= target) return f0 + (i - 0.5 + (if (p > 0) (target - c) / p else 0.0)) * binHz
            c += p
        }
        return f0 + (n - 0.5) * binHz
    }
    val lo = at(edge); val hi = at(total - edge)
    return Obw(hi - lo, lo, hi, linToDb(total * binHz / rbwHz))
}

/** The main channel's power and each neighbor's, dB, and the neighbors relative to the main channel, dBc. */
data class Acpr(val main: Double, val lower: Double, val upper: Double, val lowerDbc: Double, val upperDbc: Double)

/** Adjacent-channel power ratio: the main channel's power and each neighbor's, `spacingHz` away, in dBc. */
fun acpr(y: FloatArray, f0: Double, binHz: Double, rbwHz: Double, centerHz: Double, bwHz: Double, spacingHz: Double, adjBwHz: Double = bwHz): Acpr {
    val main = channelPower(y, f0, binHz, rbwHz, centerHz, bwHz)
    val lower = channelPower(y, f0, binHz, rbwHz, centerHz - spacingHz, adjBwHz)
    val upper = channelPower(y, f0, binHz, rbwHz, centerHz + spacingHz, adjBwHz)
    return Acpr(main, lower, upper, lower - main, upper - main)
}

/** The noise floor per RBW, and as a density in dB/Hz. */
data class NoiseFloor(val floor: Double, val density: Double)

/**
 * The noise floor: the trace's median (robust to the carriers on it), per RBW, and as a density in dB/Hz.
 * The median of an averaged noise trace sits on its mean; a single unaveraged frame reads up to 1.6 dB low.
 */
fun noiseFloor(y: FloatArray, rbwHz: Double): NoiseFloor {
    val s = y.filter { it.isFinite() }.toFloatArray()
    s.sort()
    if (s.isEmpty()) return NoiseFloor(Double.NaN, Double.NaN)
    val m = if (s.size and 1 != 0) s[s.size shr 1].toDouble() else (s[s.size / 2 - 1].toDouble() + s[s.size / 2]) / 2
    return NoiseFloor(m, m - 10 * log10(rbwHz))
}

/** The noise density at one bin, in dB/Hz: a few bins either side power-averaged, divided by the RBW. */
fun noiseAt(y: FloatArray, i: Int, rbwHz: Double, half: Int = 4): Double {
    var s = 0.0; var k = 0
    for (j in max(0, i - half)..min(y.size - 1, i + half)) { s += dbToLin(y[j].toDouble()); k++ }
    return linToDb(s / max(1, k)) - 10 * log10(rbwHz)
}

/** A reference level and dB/div that frame a trace. */
data class AutoScale(val ref: Int, val div: Int)

/**
 * A reference level and scale that frame a trace (dB): the top 5 dB over its highest point, rounded up to 5 dB, and the
 * smallest dB/div (of `divs`) that still keeps the noise floor two divisions above the bottom.
 */
fun autoScale(y: FloatArray, divs: List<Int> = listOf(1, 2, 5, 10, 20)): AutoScale {
    var peak = Double.NEGATIVE_INFINITY
    for (i in y.indices) if (y[i].isFinite() && y[i] > peak) peak = y[i].toDouble()
    if (!peak.isFinite()) return AutoScale(-20, 10)
    val floor = noiseFloor(y, 1.0).floor
    val ref = ceil((peak + 5) / 5) * 5
    val need = ref - (floor - 5)
    val div = divs.firstOrNull { it * 8 >= need } ?: divs.last()
    return AutoScale(ref.toInt(), div)
}
