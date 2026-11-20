package com.rocketgod.mayhem.core.hd

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * HD Radio AUTO: where to look for stations and in what order to visit them. Pure functions, the same as the web
 * (hdscan.ts) and the Swift core.
 *
 * AUTO finds the stations first and only then tunes them, lowest first. A radio that sees most of the FM band at once
 * (a HackRF) takes one or a few wide looks and reads each 100 kHz channel's level off the averaged spectrum; a narrow
 * one (an RTL-SDR) surveys the band window by window at the HD rate, bottom up, and takes the hybrid channels the HD
 * finder reports in each. Stations already heard are merged in. At the top of the band it looks again and starts over.
 */
object HdScanPlan {
    /** The FM band's station centers: 87.9 to 107.9 MHz, on a 100 kHz raster so it works everywhere. */
    const val BAND_LO = 87_900_000L
    const val BAND_HI = 107_900_000L
    const val RASTER = 100_000L
    /** A wide look takes at most this many spans across the band; past that the window survey is quicker. */
    const val MAX_LOOKS = 4
    /** The part of a span a look trusts: the radio's baseband filter rolls the edges off. */
    const val LOOK_USABLE = 0.75
    /** A channel this far over its local floor (dB, the average across its middle 100 kHz) is a station worth a visit. */
    const val STRONG_DB = 8.0
    /** A station heard before is visited again when the look still sees it at least this far over its local floor. */
    const val SAVED_DB = 4.0
    /** A channel's level is the average across ±50 kHz of it: the core of an FM station, not its rounded skirts. */
    const val LEVEL_HALF = 50_000.0
    /** The local floor: the 20th percentile of the bins within ±1 MHz (the radio's filter tilts the floor across a span). */
    const val FLOOR_REACH = 1_000_000.0
    const val FLOOR_PCT = 0.2
    /** A pass that heard no digital rests this long on the strongest station before it looks again (ms). */
    const val REST_MS = 120_000L

    class Plan(val wide: Boolean, val rate: Int, val centers: List<Long>)

    private fun snap(hz: Long): Long = (hz / RASTER.toDouble()).roundToLong() * RASTER

    /** The windows of the survey at the HD rate, each heard from its middle, bottom up (the HD finder's reach each side). */
    fun windows(hdRate: Int): List<Long> {
        val reach = hdRate / 2 - 260_000L
        val out = ArrayList<Long>(); var c = 88_000_000L + reach
        while (c - reach < 108_000_000L) { out.add(snap(c)); c += 2 * reach - 100_000 }
        return out
    }

    /**
     * How AUTO looks at the band. [rates]: the spans this radio and screen can take, any order. The fewest looks that
     * cover every station's channel, at the narrowest span that does it (less work, finer bins). Each look is centered
     * halfway between two raster channels so the radio's DC spike lands on neither. More than [MAX_LOOKS] (an RTL-SDR)
     * and AUTO surveys windows at the HD rate instead.
     */
    fun lookPlan(rates: List<Int>, hdRate: Int): Plan {
        val lo = BAND_LO - RASTER; val hi = BAND_HI + RASTER; val need = (hi - lo).toDouble()
        var bestRate = 0; var bestN = Int.MAX_VALUE
        for (rate in rates.sorted()) {
            if (rate <= hdRate) continue
            val n = ceil(need / (rate * LOOK_USABLE)).toInt()
            if (n < bestN) { bestN = n; bestRate = rate }
        }
        if (bestRate == 0 || bestN > MAX_LOOKS) return Plan(false, hdRate, windows(hdRate))
        val use = bestRate * LOOK_USABLE
        val centers = (0 until bestN).map { i ->
            val c = if (bestN == 1) (lo + hi) / 2.0 else lo + use / 2 + i * (need - use) / (bestN - 1)
            floor(c / RASTER).toLong() * RASTER + RASTER / 2
        }
        return Plan(true, bestRate, centers)
    }

    /**
     * Every raster channel a look shows, with its level: the average dB across ±50 kHz of it, over the local floor (the
     * 20th percentile of the bins within ±1 MHz). [spec] is the averaged spectrum in dB on any common scale (dB over its
     * own median, say), bin 0 at the bottom of the span. Only the trusted middle of the span counts, and the DC spike's
     * own bins (±30 kHz of the center) are left out everywhere.
     */
    fun channelLevels(spec: DoubleArray, rate: Int, centerHz: Long): Map<Long, Double> {
        val out = LinkedHashMap<Long, Double>(); val n = spec.size
        if (n == 0 || rate <= 0) return out
        val binHz = rate.toDouble() / n; val start = centerHz - rate / 2.0; val half = rate * LOOK_USABLE / 2
        val w = max(1, floor(LEVEL_HALF / binHz).toInt()); val fw = max(w + 1, floor(FLOOR_REACH / binHz).toInt())
        fun dc(k: Int) = abs(start + (k + 0.5) * binHz - centerHz) < 30_000
        val around = DoubleArray(2 * fw + 1)
        var f = ceil(max(BAND_LO.toDouble(), centerHz - half) / RASTER).toLong() * RASTER
        while (f <= min(BAND_HI.toDouble(), centerHz + half)) {
            val mid = floor((f - start) / binHz).toInt()
            var sum = 0.0; var cnt = 0
            for (k in max(0, mid - w)..min(n - 1, mid + w)) if (!dc(k)) { sum += spec[k]; cnt++ }
            var na = 0
            for (k in max(0, mid - fw)..min(n - 1, mid + fw)) if (!dc(k)) around[na++] = spec[k]
            if (cnt > 0 && na > 0) {
                java.util.Arrays.sort(around, 0, na)
                out[f] = sum / cnt - around[(na * FLOOR_PCT).toInt()]
            }
            f += RASTER
        }
        return out
    }

    /** Two looks' levels as one: where they overlap, the higher reading. */
    fun mergeLevels(into: MutableMap<Long, Double>, add: Map<Long, Double>): MutableMap<Long, Double> {
        for ((f, v) in add) { val was = into[f]; if (was == null || v > was) into[f] = v }
        return into
    }

    /**
     * The stations in a look: channels at least [minDb] over their local floor that stand above both neighbors (a strong
     * station's ±100 kHz shoulders and its HD sidebands also read high), lowest first.
     */
    fun strongStations(levels: Map<Long, Double>, minDb: Double = STRONG_DB): List<Long> =
        levels.filter { (f, v) ->
            v >= minDb && v > (levels[f - RASTER] ?: Double.NEGATIVE_INFINITY) && v >= (levels[f + RASTER] ?: Double.NEGATIVE_INFINITY)
        }.keys.sorted()

    /**
     * The visits, lowest first: the stations found plus the ones heard before. With [levels] (a wide look), a station
     * heard before is kept only if the look still shows it [SAVED_DB] over the floor; without (the window survey) every
     * one is kept. Each on the raster, in the band, once.
     */
    fun visitOrder(found: List<Long>, saved: List<Long>, levels: Map<Long, Double>? = null): List<Long> {
        val keep = saved.map(::snap).filter { levels == null || (levels[it] ?: Double.NEGATIVE_INFINITY) >= SAVED_DB }
        return (found.map(::snap) + keep).distinct().filter { it in BAND_LO..BAND_HI }.sorted()
    }

    /** Where a pass with no digital rests: the visit the looks read loudest (the first one when there are no levels). */
    fun strongest(visits: List<Long>, levels: Map<Long, Double>?): Long? {
        var best: Long? = null; var bestDb = Double.NEGATIVE_INFINITY
        for (f in visits) { val v = levels?.get(f) ?: Double.NEGATIVE_INFINITY; if (best == null || v > bestDb) { best = f; bestDb = v } }
        return best
    }
}
