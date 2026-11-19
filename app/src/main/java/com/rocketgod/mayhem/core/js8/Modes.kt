package com.rocketgod.mayhem.core.js8

import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * The four JS8 speeds. Symbol rates, tone spacings, transmit lengths and slot lengths are from the JS8Call User
 * Guide's modulation table; the first-tone delays after the slot boundary are the published nominal ones.
 * Twin of web/src/dsp/js8/modes.ts.
 */
enum class Js8Speed(val label: String, val short: String) { SLOW("SLOW", "S"), NORMAL("NORMAL", "N"), FAST("FAST", "F"), TURBO("TURBO", "T");
    val id: String get() = name.lowercase()
    companion object { fun of(id: String): Js8Speed? = entries.firstOrNull { it.id == id || it.name == id } }
}

class Js8Mode(
    val id: Js8Speed,
    /** Slot length, seconds. */
    val period: Int,
    /** Symbol length, seconds (79 symbols per frame). */
    val symbol: Double,
    /** Tone spacing, Hz (= the baud rate). */
    val spacing: Double,
    /** Nominal first-tone time after the slot boundary, seconds. */
    val delay: Double,
    val costas: Array<IntArray>,
    /** Working sample rate: a power-of-two number of samples per symbol. */
    val fs: Int,
    /** Decoder threshold quoted by the guide relative to Normal, dB (Normal is -24 dB in 2500 Hz). */
    val threshold: Int,
) { val label: String get() = id.label }

val JS8_MODES: List<Js8Mode> = listOf(
    Js8Mode(Js8Speed.SLOW, 30, 0.32, 3.125, 0.5, COSTAS_MODIFIED, 12_800, -27),
    Js8Mode(Js8Speed.NORMAL, 15, 0.16, 6.25, 0.5, COSTAS_ORIGINAL, 12_800, -24),
    Js8Mode(Js8Speed.FAST, 10, 0.1, 10.0, 0.2, COSTAS_MODIFIED, 10_240, -22),
    Js8Mode(Js8Speed.TURBO, 6, 0.05, 20.0, 0.1, COSTAS_MODIFIED, 10_240, -18),
)
fun js8Mode(id: Js8Speed): Js8Mode = JS8_MODES.first { it.id == id }
const val JS8_SYMBOLS = 79
/** Seconds one frame is on the air. */
fun frameSeconds(m: Js8Mode): Double = JS8_SYMBOLS * m.symbol
/** Samples per symbol at the mode's working rate. */
fun symSamples(m: Js8Mode): Int = (m.symbol * m.fs).roundToInt()
/** Start of the slot holding [ms], epoch milliseconds. */
fun slotStart(m: Js8Mode, ms: Long): Long = floor(ms / (m.period * 1000.0)).roundToLong() * m.period * 1000L

/** Suggested JS8 dial frequencies, USB (JS8Call User Guide, Frequencies). */
val JS8_DIALS: List<Pair<String, Long>> = listOf(
    "160m" to 1_842_000L, "80m" to 3_578_000L, "40m" to 7_078_000L, "30m" to 10_130_000L, "20m" to 14_078_000L, "17m" to 18_104_000L,
    "15m" to 21_078_000L, "12m" to 24_922_000L, "10m" to 28_078_000L, "6m" to 50_318_000L, "2m" to 144_178_000L,
)
/** JS8Call keeps its transmissions out of the lowest 500 Hz of the passband; heartbeats sit in 500-1000 Hz. */
const val JS8_TX_MIN_HZ = 500
const val JS8_TX_MAX_HZ = 2900
const val JS8_HB_LO_HZ = 500
const val JS8_HB_HI_HZ = 1000
