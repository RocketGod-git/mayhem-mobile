package com.rocketgod.mayhem.core.spectrum

import java.util.Locale
import kotlin.math.abs
import kotlin.math.max

/**
 * Spectrum: the dBm scale, and how a span is taken from the radio.
 *
 * The radio measures in dBFS (0 dBFS = a full-scale tone at its 8-bit converter). What that is in dBm depends on
 * the gain in front of the converter, so the scale is gain-aware: dBm = dBFS - gain + K, with K the input level that
 * reaches full scale at 0 dB of gain. K is a typical figure per radio, not a measured one: real parts vary by several
 * dB and with frequency, so the scale is always marked approximate. A trim (CAL) set against a known source moves it.
 */

enum class RadioKind { HACKRF, RTLSDR, NONE }
data class GainState(
    val kind: RadioKind,
    /** A HackRF Pro reads about 28 dB lower than a One at the same settings (bench-measured). */
    val pro: Boolean,
    val lna: Int,
    val vga: Int,
    val amp: Boolean,
    /** An RTL-SDR's tuner gain, dB; NaN when the tuner's own AGC sets it (the scale cannot follow it then). */
    val tunerDb: Double,
)

/** Input level (dBm) at full scale with 0 dB of gain: typical, not measured. */
val FULL_SCALE_DBM: Map<RadioKind, Double> = mapOf(RadioKind.HACKRF to -10.0, RadioKind.RTLSDR to -5.0, RadioKind.NONE to 0.0)
const val HACKRF_AMP_DB = 14
const val HACKRF_PRO_DB = 28

/** dBm = dBFS + offset, the note on how it was worked out, and whether it can be trusted at all. */
data class DbmOffset(val offset: Double, val note: String, val ok: Boolean)

/** dBm = dBFS + offset, and why it is only approximate. */
fun dbmOffset(g: GainState, trimDb: Double = 0.0): DbmOffset {
    if (g.kind == RadioKind.HACKRF) {
        val gain = g.lna + g.vga + (if (g.amp) HACKRF_AMP_DB else 0)
        return DbmOffset(FULL_SCALE_DBM.getValue(RadioKind.HACKRF) - gain + (if (g.pro) HACKRF_PRO_DB else 0) + trimDb,
            "≈ from LNA ${g.lna} + VGA ${g.vga}${if (g.amp) " + AMP" else ""}", true)
    }
    if (g.kind == RadioKind.RTLSDR) {
        if (!g.tunerDb.isFinite()) return DbmOffset(FULL_SCALE_DBM.getValue(RadioKind.RTLSDR) + trimDb, "tuner AGC: the dBm scale cannot follow it", false)
        return DbmOffset(FULL_SCALE_DBM.getValue(RadioKind.RTLSDR) - g.tunerDb + trimDb, "≈ from tuner gain ${jsNum(g.tunerDb)} dB", true)
    }
    return DbmOffset(trimDb, "no radio", false)
}

/** A number as JavaScript prints it in a template: no ".0" on a whole number. */
private fun jsNum(v: Double): String = if (v == Math.floor(v) && abs(v) < 1e15) v.toLong().toString() else v.toString()

/** How a span is taken: one FFT (offset clear of DC, or centered with the DC bins patched), or a sweep of slices. */
sealed class SpanPlan {
    data class Fft(val rate: Double, val tuneHz: Double, val dcPatch: Boolean) : SpanPlan()
    data class Sweep(val sliceRate: Double) : SpanPlan()
}

/** Usable fraction of a rate (the baseband filter rolls off the edges). */
const val USABLE = 0.8
/** A span this fraction of the rate or less is taken with the radio tuned off it. */
const val OFFSET_FIT = 0.3
/** Where the span's center sits from the radio's when tuned off it, as a fraction of the rate. */
const val OFFSET_AT = 0.25

/**
 * Pick the cheapest way to take [start, stop] with the rates this radio does (any order): the smallest rate that
 * holds the span clear of DC (up to 10 Msps), else the smallest that holds it centered, else a sweep with the
 * widest slice.
 */
fun planSpan(startHz: Double, stopHz: Double, rates: List<Double>): SpanPlan {
    val span = stopHz - startHz; val c = (startHz + stopHz) / 2
    val asc = rates.sorted()
    for (r in asc) if (r <= 10_000_000 && span <= OFFSET_FIT * r) return SpanPlan.Fft(r, c + OFFSET_AT * r, false)
    for (r in asc) if (span <= USABLE * r) return SpanPlan.Fft(r, c, true)
    return SpanPlan.Sweep(asc[asc.size - 1])
}

private val HZ_RE = Regex("""^\s*([-+]?\d*\.?\d+)\s*([kKmMgG]?)(?:hz|Hz|HZ)?\s*$""")

/** "433.92M", "100k", "2.4G", "915000000", "-30" → hertz (a bare number under 10 000 is taken as MHz). */
fun parseHz(s: String): Double? {
    val m = HZ_RE.find(s) ?: return null
    val v = m.groupValues[1].toDouble()
    val u = m.groupValues[2].lowercase(Locale.US)
    if (u == "k") return v * 1e3
    if (u == "m") return v * 1e6
    if (u == "g") return v * 1e9
    return if (abs(v) < 10_000) v * 1e6 else v
}

/** JavaScript's toFixed: d digits after the point. */
private fun fixed(v: Double, d: Int): String = String.format(Locale.US, "%.${d}f", v)

/** A frequency the way a bench analyzer prints it: 433.920 000 MHz, 12.5 kHz. */
fun fmtHz(hz: Double, digits: Int = 6): String {
    val a = abs(hz)
    if (a >= 1e9) return "${fixed(hz / 1e9, max(0, digits + 0))} GHz".replace(Regex("""(\.\d*?)0+ GHz$"""), "$1 GHz").replace(Regex("""\. GHz$"""), " GHz")
    if (a >= 1e6) return "${fixed(hz / 1e6, digits)} MHz".replace(Regex("""(\.\d*?)0+ MHz$"""), "$1 MHz").replace(Regex("""\. MHz$"""), " MHz")
    if (a >= 1e3) return "${fixed(hz / 1e3, 3)} kHz".replace(Regex("""(\.\d*?)0+ kHz$"""), "$1 kHz").replace(Regex("""\. kHz$"""), " kHz")
    return "${fixed(hz, if (a < 10) 2 else 1)} Hz".replace(Regex("""(\.\d*?)0+ Hz$"""), "$1 Hz").replace(Regex("""\. Hz$"""), " Hz")
}

/** A time the way a scope prints it: 1.25 ms, 830 µs. */
fun fmtSec(s: Double): String {
    if (!s.isFinite()) return "—"
    val a = abs(s)
    if (a == 0.0) return "0 s"
    if (a >= 1) return "${fixed(s, 3)} s"
    if (a >= 1e-3) return "${fixed(s * 1e3, 3)} ms"
    if (a >= 1e-6) return "${fixed(s * 1e6, 2)} µs"
    return "${fixed(s * 1e9, 1)} ns"
}
