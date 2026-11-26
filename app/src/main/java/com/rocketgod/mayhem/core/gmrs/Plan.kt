package com.rocketgod.mayhem.core.gmrs

import com.rocketgod.mayhem.core.hamplus.PlanInfo
import com.rocketgod.mayhem.core.hamplus.TrackerPlan
import kotlin.math.abs

/**
 * The FRS/GMRS and MURS channel plans (FCC Part 95 Subparts B, E and J). FRS and GMRS share 22 channels: 1 to 7 at
 * 462.5625 to 462.7125 MHz and 8 to 14 at 467.5625 to 467.7125, both on 25 kHz steps, and 15 to 22 at 462.550 to
 * 462.725. Channels 15 to 22 are also GMRS repeater outputs, each listening 5 MHz up (467.550 to 467.725): the 8
 * repeater inputs, here 15R to 22R. 462.675 (channel 20) is where many listen for travelers and emergencies, by
 * custom only. MURS is five VHF channels: 151.820, 151.880, 151.940, 154.570 (Blue Dot) and 154.600 (Green Dot).
 */
enum class GmrsBand { GMRS, MURS }

/** 'frs' (1 to 14, low power), 'gmrs' (15 to 22, simplex or a repeater's output), 'input' (a repeater's input) or 'murs'. */
enum class GmrsKind { FRS, GMRS, INPUT, MURS }

/** A channel: "1" to "22", "15R" to "22R" for the repeater inputs, "M1" to "M5" on MURS; [outHz] a repeater input's output, 0 for the rest. */
data class GmrsChan(val id: String, val hz: Long, val kind: GmrsKind, val outHz: Long = 0L)

val GMRS_CHANNELS: List<GmrsChan> =
    (0 until 7).map { GmrsChan("${it + 1}", 462_562_500L + it * 25_000L, GmrsKind.FRS) } +
    (0 until 7).map { GmrsChan("${it + 8}", 467_562_500L + it * 25_000L, GmrsKind.FRS) } +
    (0 until 8).map { GmrsChan("${it + 15}", 462_550_000L + it * 25_000L, GmrsKind.GMRS) } +
    (0 until 8).map { GmrsChan("${it + 15}R", 467_550_000L + it * 25_000L, GmrsKind.INPUT, 462_550_000L + it * 25_000L) }
val MURS_CHANNELS: List<GmrsChan> = listOf(151_820_000L, 151_880_000L, 151_940_000L, 154_570_000L, 154_600_000L).mapIndexed { i, hz -> GmrsChan("M${i + 1}", hz, GmrsKind.MURS) }
fun channelsOf(b: GmrsBand): List<GmrsChan> = if (b == GmrsBand.MURS) MURS_CHANNELS else GMRS_CHANNELS
/** A repeater listens this far above its output. */
const val GMRS_RPT_OFFSET = 5_000_000L

/**
 * Where the radio is tuned. A HackRF at 8 MS/s hears all 30 GMRS channels from 465.140625 MHz: DC on no channel, and
 * the receiver's mirror image of each channel lands halfway between two others. A radio that cannot (an RTL-SDR) hears
 * the 15 channels at 462 MHz (1 to 7, 15 to 22) from 462.800 at 2.4 MS/s, its DC and mirror images clear of all of
 * them. MURS: all five from 153.000 at 4 MS/s, or the three at 151 MHz from 151.700 on an RTL-SDR, where no image
 * falls on a channel either.
 */
const val GMRS_CENTER = 465_140_625L
const val GMRS_NARROW_CENTER = 462_800_000L
const val GMRS_RATE = 8_000_000
const val MURS_CENTER = 153_000_000L
const val MURS_NARROW_CENTER = 151_700_000L
const val MURS_RATE = 4_000_000
const val NARROW_RATE = 2_400_000
fun centerOf(b: GmrsBand, wide: Boolean): Long = if (b == GmrsBand.MURS) (if (wide) MURS_CENTER else MURS_NARROW_CENTER) else (if (wide) GMRS_CENTER else GMRS_NARROW_CENTER)

/** The channel at [hz] (within 1 kHz) of either plan, or null. */
fun gmrsChan(hz: Long): GmrsChan? = GMRS_CHANNELS.firstOrNull { abs(it.hz - hz) < 1_000 } ?: MURS_CHANNELS.firstOrNull { abs(it.hz - hz) < 1_000 }
/** A repeater's input whose output is [hz], or 0. */
fun inputFor(hz: Long): Long = GMRS_CHANNELS.firstOrNull { it.kind == GmrsKind.INPUT && abs(it.outHz - hz) < 1_000 }?.hz ?: 0L

/** The name a channel goes by, "" for most. */
fun gmrsName(c: GmrsChan): String = when {
    c.id == "20" -> "TRAVEL / EMERGENCY"
    c.id == "M4" -> "BLUE DOT"
    c.id == "M5" -> "GREEN DOT"
    c.kind == GmrsKind.INPUT -> "REPEATER INPUT FOR ${c.id.dropLast(1)}"
    else -> ""
}
/** How the screen titles a channel: "CH 15", "CH 15R", "MURS 4". */
fun gmrsTitle(c: GmrsChan): String = if (c.kind == GmrsKind.MURS) "MURS ${c.id.drop(1)}" else "CH ${c.id}"

/** GMRS callsigns as the FCC issues them: four letters and three digits (WRAB123), or the older three letters and four digits (KAE1234). */
val GMRS_CALL_RE = Regex("^(?:WR[A-Z]{2}\\d{3}|K[A-Z]{2}\\d{4})$")
/** An amateur callsign (a GMRS licensee may also hold one). */
private val HAM_CALL_RE = Regex("^(?:[A-Z]{1,2}|[A-Z]\\d|\\d[A-Z])\\d[A-Z]{1,4}$")
data class IdCall(val call: String, val gmrs: Boolean)
/** The callsigns in a Morse ID ("DE WRAB123", "WRAB123/R"), each with whether it is a GMRS one. */
fun idCalls(text: String): List<IdCall> {
    val out = ArrayList<IdCall>()
    for (w in text.uppercase().split(Regex("\\s+"))) {
        val c = (if (w.startsWith("DE") && w.length > 6) w.substring(2) else w).substringBefore('/')
        val gmrs = GMRS_CALL_RE.matches(c)
        if ((gmrs || (HAM_CALL_RE.matches(c) && c.length >= 4)) && out.none { it.call == c }) out.add(IdCall(c, gmrs))
    }
    return out
}

fun gmrsPlanInfo(hz: Long): PlanInfo {
    val c = gmrsChan(hz) ?: return PlanInfo("", "", emptyList())
    // 15 to 22 are simplex and repeater outputs both: the tracker learns a pair from its input keying with it
    return PlanInfo(gmrsName(c), if (c.kind == GmrsKind.INPUT) "input" else "simplex", if (c.kind == GmrsKind.GMRS) listOf(GMRS_RPT_OFFSET) else emptyList())
}
/** The tracker on GMRS and MURS: the activity map keeps a row a channel. */
val GMRS_TRACKER_PLAN: TrackerPlan = object : TrackerPlan {
    override fun info(hz: Long): PlanInfo = gmrsPlanInfo(hz)
    override fun heatRow(hz: Long): String = gmrsChan(hz)?.let { "CH${it.id}" } ?: ""
}
