package com.rocketgod.mayhem.core.hamplus

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToLong

/*
 * HAM+ band plan: the FM bands it watches, the names the US band plans give single frequencies, which segments hold
 * repeater outputs and inputs and their standard offsets, and the windows a receiver narrower than a band steps
 * through. Everything here is the published ARRL band plan; nothing local.
 */

data class HpBand(val id: String, val name: String, val lo: Long, val hi: Long)

val HP_BANDS: List<HpBand> = listOf(
    HpBand("2M", "2 m", 144_000_000, 148_000_000),
    HpBand("125", "1.25 m", 222_000_000, 225_000_000),
    HpBand("70CM", "70 cm", 420_000_000, 450_000_000),
    HpBand("6M", "6 m", 51_000_000, 54_000_000),
    HpBand("10M", "10 m", 29_500_000, 29_700_000),
)

fun hpBandOf(hz: Long): HpBand? = HP_BANDS.firstOrNull { hz >= it.lo && hz <= it.hi }

/** The raster channels are measured on: every 2.5 kHz, so 5, 12.5, 15, 20 and 25 kHz channel plans all land on it. */
const val HP_RASTER = 2_500L

private val NAMED: List<Pair<Long, String>> = listOf(
    146_520_000L to "NATIONAL SIMPLEX CALLING",
    223_500_000L to "NATIONAL SIMPLEX CALLING",
    446_000_000L to "NATIONAL SIMPLEX CALLING",
    52_525_000L to "NATIONAL SIMPLEX CALLING",
    52_540_000L to "SECONDARY SIMPLEX",
    29_600_000L to "NATIONAL SIMPLEX CALLING",
    144_390_000L to "APRS",
    145_825_000L to "SATELLITE APRS",
    144_200_000L to "SSB CALLING",
    432_100_000L to "SSB CALLING",
)

/** A segment of a band plan: what it is used for and, for repeater outputs, where the inputs are. */
private class Seg(val lo: Long, val hi: Long, val use: String, val offsets: List<Long> = emptyList())

private val SEGS = listOf(
    Seg(144_000_000, 144_275_000, "weak"),
    Seg(144_510_000, 144_890_000, "input"),
    Seg(145_110_000, 145_490_000, "output", listOf(-600_000)),
    Seg(145_800_000, 146_000_000, "satellite"),
    Seg(146_010_000, 146_370_000, "input"),
    Seg(146_400_000, 146_580_000, "simplex"),
    Seg(146_610_000, 146_970_000, "output", listOf(-600_000)),
    Seg(147_000_000, 147_390_000, "output", listOf(600_000)),
    Seg(147_420_000, 147_570_000, "simplex"),
    Seg(147_600_000, 147_990_000, "input"),
    Seg(222_000_000, 222_150_000, "weak"),
    Seg(222_250_000, 223_380_000, "input"),
    Seg(223_400_000, 223_520_000, "simplex"),
    Seg(223_850_000, 224_980_000, "output", listOf(-1_600_000)),
    Seg(432_000_000, 432_300_000, "weak"),
    Seg(435_000_000, 438_000_000, "satellite"),
    Seg(442_000_000, 445_000_000, "output", listOf(5_000_000, -5_000_000)),
    Seg(445_000_000, 447_000_000, "shared", listOf(-5_000_000, 5_000_000)),
    Seg(447_000_000, 450_000_000, "output", listOf(-5_000_000, 5_000_000)),
    Seg(51_120_000, 51_480_000, "input"),
    Seg(51_620_000, 51_980_000, "output", listOf(-500_000)),
    Seg(52_000_000, 52_480_000, "input"),
    Seg(52_500_000, 52_980_000, "output", listOf(-500_000, -1_000_000)),
    Seg(53_000_000, 53_480_000, "input"),
    Seg(53_500_000, 53_980_000, "output", listOf(-500_000, -1_000_000)),
    Seg(29_520_000, 29_580_000, "input"),
    Seg(29_620_000, 29_680_000, "output", listOf(-100_000)),
)

/**
 * [label] is the plan's name for this exact frequency, or ''. [use] is 'output' (a repeater output), 'input',
 * 'simplex', 'satellite', 'weak', 'shared', 'data' or ''. [offsets] is where a repeater with its output here
 * listens, in Hz, most usual first (empty when not an output).
 */
data class PlanInfo(val label: String, val use: String, val offsets: List<Long>)

private fun near(a: Long, b: Long) = abs(a - b) < 1_250

fun planInfo(hz: Long): PlanInfo {
    val named = NAMED.firstOrNull { near(it.first, hz) }
    // the national calling frequencies are simplex even where they sit inside another segment
    if (named != null) {
        val n = named.second
        return PlanInfo(n, if ("SIMPLEX" in n) "simplex" else if (n == "APRS" || n == "SATELLITE APRS") "data" else "weak", emptyList())
    }
    val s = SEGS.firstOrNull { hz >= it.lo - 1_250 && hz <= it.hi + 1_250 } ?: return PlanInfo("", "", emptyList())
    return PlanInfo("", s.use, if (s.use == "output" || s.use == "shared") s.offsets else emptyList())
}

private fun num(v: Double): String = if (v == floor(v) && abs(v) < 1e15) v.toLong().toString() else v.toString()

/** The offset text a tile shows for a repeater output, from the plan: '−600 kHz', '+5 MHz or −5 MHz'. */
fun offsetText(offsets: List<Long>): String {
    fun one(o: Long): String {
        val a = abs(o).toDouble()
        return (if (o < 0) "−" else "+") + if (a >= 1_000_000) "${num(a / 1e6)} MHz" else "${num(a / 1e3)} kHz"
    }
    return offsets.take(2).joinToString(" or ") { one(it) }
}

data class HpWindow(val band: String, val hz: Long)

/** The centers a band is heard from with [rate] samples a second: one when the span covers it, else even steps. */
fun hpWindows(bandId: String, rate: Double): List<HpWindow> {
    val use = rate * 0.8
    val out = ArrayList<HpWindow>()
    for (b in HP_BANDS) {
        if (bandId != "AUTO" && bandId != b.id) continue
        val n = max(1, ceil((b.hi - b.lo) / use).toInt())
        for (i in 0 until n) {
            val c = if (n == 1) (b.lo + b.hi) / 2.0 else b.lo + use / 2 + i * ((b.hi - b.lo - use) / (n - 1))
            out.add(HpWindow(b.id, c.roundToLong() + 1_250))
        }
    }
    return out
}
