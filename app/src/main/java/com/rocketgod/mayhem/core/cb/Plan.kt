package com.rocketgod.mayhem.core.cb

import com.rocketgod.mayhem.core.hamplus.PlanInfo
import com.rocketgod.mayhem.core.hamplus.TrackerPlan
import kotlin.math.abs

/*
 * The Citizens Band channel plan (FCC Part 95 Subpart D): 40 channels from 26.965 to 27.405 MHz on 10 kHz
 * steps, with the five gaps the plan leaves (26.995, 27.045, 27.095, 27.145, 27.195) and channels 23 to 25 out of order
 * (23 is 27.255, 24 is 27.235, 25 is 27.245). Channel 9 is for emergencies and help to travelers. Channel 19
 * is where highway traffic talks and 36 to 40 carry most single sideband, 38 LSB the calling channel: common
 * practice, not the rule, so they are names and nothing more. Twin of web dsp/cb/plan.ts.
 */

/** Channel n is CB_CHANNELS[n - 1], in Hz. */
val CB_CHANNELS: List<Long> = listOf(
    26_965_000, 26_975_000, 26_985_000, 27_005_000, 27_015_000, 27_025_000, 27_035_000, 27_055_000, 27_065_000, 27_075_000,
    27_085_000, 27_105_000, 27_115_000, 27_125_000, 27_135_000, 27_155_000, 27_165_000, 27_175_000, 27_185_000, 27_205_000,
    27_215_000, 27_225_000, 27_255_000, 27_235_000, 27_245_000, 27_265_000, 27_275_000, 27_285_000, 27_295_000, 27_305_000,
    27_315_000, 27_325_000, 27_335_000, 27_345_000, 27_355_000, 27_365_000, 27_375_000, 27_385_000, 27_395_000, 27_405_000,
)
const val CB_LO = 26_965_000L
const val CB_HI = 27_405_000L
/** Every channel lands on this raster (the plan is 10 kHz steps from 26.965, so 5 kHz from zero). */
const val CB_RASTER = 5_000L
/**
 * Where the radio is tuned: 27.195 MHz, the plan's unused slot between 19 and 20, so the receiver's own DC sits on no
 * channel and all 40 (440 kHz) fit in a 2 MS/s HackRF or a 2.4 MS/s RTL-SDR with room on both sides.
 */
const val CB_CENTER = 27_195_000L

enum class CbMode { AM, FM, USB, LSB }
val CB_MODES: List<CbMode> = CbMode.entries

/** The channel number at [hz] (within 1 kHz), or 0. */
fun cbChannel(hz: Long): Int {
    for (i in CB_CHANNELS.indices) if (abs(CB_CHANNELS[i] - hz) < 1_000) return i + 1
    return 0
}
fun cbHz(ch: Int): Long = CB_CHANNELS.getOrNull(ch - 1) ?: 0L

/** The names a channel goes by. */
fun cbName(ch: Int): String = when {
    ch == 9 -> "EMERGENCY"; ch == 19 -> "HIGHWAY"; ch == 38 -> "LSB CALLING"; ch >= 36 -> "SIDEBAND"; else -> ""
}
/** "emergency", "highway", "ssb" or "". */
fun cbUse(ch: Int): String = when { ch == 9 -> "emergency"; ch == 19 -> "highway"; ch >= 36 -> "ssb"; else -> "" }

fun cbPlanInfo(hz: Long): PlanInfo {
    val ch = cbChannel(hz)
    return PlanInfo(if (ch != 0) cbName(ch) else "", if (ch != 0) cbUse(ch) else "", emptyList())
}

/** The tracker on CB: no repeaters, and the activity map keeps a row a channel. */
val CB_TRACKER_PLAN: TrackerPlan = object : TrackerPlan {
    override fun info(hz: Long): PlanInfo = cbPlanInfo(hz)
    override fun heatRow(hz: Long): String { val ch = cbChannel(hz); return if (ch != 0) "CH$ch" else "" }
}
