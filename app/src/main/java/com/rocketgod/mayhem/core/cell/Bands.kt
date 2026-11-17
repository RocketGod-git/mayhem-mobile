package com.rocketgod.mayhem.core.cell

import kotlin.math.abs
import kotlin.math.roundToLong

/*
 * US LTE downlink presets (36.101 Table 5.5-1 operating bands, Table 5.7.3-1 EARFCN) and carrier finding from a
 * stitched power profile: a downlink carrier is a flat block of 1.08, 2.7, 4.5, 9, 13.5 or 18 MHz occupied
 * (N_RB x 180 kHz) whose center sits on the 100 kHz raster.
 */
data class BandPreset(val id: String, val label: String, val bands: List<Int>, val lo: Long, val hi: Long, val tdd: Boolean)

val CELL_BANDS = listOf(
    BandPreset("B12", "B12/17", listOf(12, 17), 729_000_000, 746_000_000, false),
    BandPreset("B13", "B13", listOf(13), 746_000_000, 756_000_000, false),
    BandPreset("B14", "B14", listOf(14), 758_000_000, 768_000_000, false),
    BandPreset("B5", "B5/26", listOf(5, 26), 859_000_000, 894_000_000, false),
    BandPreset("B2", "B2/25", listOf(2, 25), 1_930_000_000, 1_995_000_000, false),
    BandPreset("B4", "B4/66", listOf(4, 66), 2_110_000_000, 2_200_000_000, false),
    BandPreset("B41", "B41 TDD", listOf(41), 2_496_000_000, 2_690_000_000, true),
)
val OCCUPIED_MHZ = listOf(6 to 1.08, 15 to 2.7, 25 to 4.5, 50 to 9.0, 75 to 13.5, 100 to 18.0)
/** Sample rate that holds a whole carrier of n RBs (a power-of-two FFT at 15 kHz). */
fun rateForRb(nrb: Int): Int = when { nrb <= 6 -> 1_920_000; nrb <= 15 -> 3_840_000; nrb <= 25 -> 7_680_000; nrb <= 75 -> 15_360_000; else -> 30_720_000 }
fun bandOf(hz: Long): BandPreset? = CELL_BANDS.firstOrNull { hz >= it.lo - 100_000 && hz <= it.hi + 100_000 }

/** A stitched profile: power in dB at fixed steps from lo. */
class Profile(val lo: Long, val step: Int, val db: FloatArray, val seen: BooleanArray)
fun newProfile(lo: Long, hi: Long, step: Int = 50_000): Profile {
    val n = ((hi - lo + step - 1) / step).toInt() + 1
    return Profile(lo, step, FloatArray(n) { -200f }, BooleanArray(n))
}
/** Writes one window's measurement (absolute Hz of its first point, step, dB values). */
fun stitch(p: Profile, lo: Double, step: Int, db: FloatArray) {
    for (i in db.indices) {
        val j = Math.round((lo + i * step.toDouble() - p.lo) / p.step).toInt()
        if (j < 0 || j >= p.db.size) continue
        p.db[j] = if (p.seen[j]) maxOf(p.db[j], db[i]) else db[i]; p.seen[j] = true
    }
}
data class CarrierGuess(val centerHz: Long, val occupiedMhz: Double, val nrb: Int, val levelDb: Double)
/**
 * Occupied blocks of the profile (above floor + 8 dB, at least 1 MHz) and the carrier centers they imply. A block
 * wider than one carrier is also offered as two or more 5 or 10 MHz carriers side by side.
 */
fun findCarriers(p: Profile, raster: Long = 100_000): List<CarrierGuess> {
    val vals = p.db.indices.filter { p.seen[it] }.map { p.db[it] }.sorted()
    if (vals.size < 10) return emptyList()
    val floor = vals[(vals.size * 0.15).toInt()]; val thr = floor + 8
    val out = ArrayList<CarrierGuess>()
    fun snap(hz: Double): Long = (hz / raster).roundToLong() * raster
    var i = 0
    while (i < p.db.size) {
        if (!p.seen[i] || p.db[i] < thr) { i++; continue }
        var j = i; var sum = 0.0
        while (j < p.db.size && p.seen[j] && p.db[j] >= thr) { sum += p.db[j]; j++ }
        val lo = p.lo + (i - 0.5) * p.step; val hi = p.lo + (j - 0.5) * p.step; val w = (hi - lo) / 1e6; val level = sum / (j - i) - floor
        if (w >= 1) {
            var best = OCCUPIED_MHZ[0]
            for (o in OCCUPIED_MHZ) if (abs(o.second - w) < abs(best.second - w)) best = o
            out.add(CarrierGuess(snap((lo + hi) / 2), best.second, best.first, level))
            if (w > 9.6) for ((nrb, occ) in listOf(50 to 9.0, 25 to 4.5)) {
                val n = Math.round(w / (occ + 0.5)).toInt()
                if (n < 2) continue
                val pitch = (w * 1e6) / n
                for (k in 0 until n) out.add(CarrierGuess(snap(lo + pitch * (k + 0.5)), occ, nrb, level))
            }
        }
        i = j
    }
    val seen = HashSet<Long>()
    return out.filter { seen.add(it.centerHz) }
}
