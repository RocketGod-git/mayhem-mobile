package com.rocketgod.mayhem.core.analyzer

import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/*
 * Getting bursts in and out: raw I/Q (.cu8 unsigned, .cs8 signed, as rtl_433 and URH write them) and Flipper Zero
 * `.sub` RAW pulse files. Twin of web/src/dsp/analyzer/files.ts and Files.swift.
 *
 * Samples here are signed bytes, interleaved I, Q (the web's Int8Array); the radio's own offset-128 form only
 * appears where samples go into the capture.
 */

/** Unsigned bytes, offset 128 (rtl_sdr, rtl_433 `.cu8`, HackRF's `.u8` captures in this app). */
fun toCu8(iq: ByteArray): ByteArray = ByteArray(iq.size) { (iq[it] + 128).toByte() }
/** Signed bytes (hackrf_transfer, rtl_433 `.cs8`). */
fun toCs8(iq: ByteArray): ByteArray = iq.copyOf()

private val UNSIGNED_EXT = Regex("\\.(cu8|u8|iq|raw)$", RegexOption.IGNORE_CASE)

/** A recording back to signed samples; `.cu8` / `.u8` / `.iq` are unsigned, everything else signed. */
fun fromIqFile(bytes: ByteArray, name: String): ByteArray {
    val unsigned = UNSIGNED_EXT.containsMatchIn(name)
    val out = ByteArray(bytes.size and 1.inv())
    for (i in out.indices) out[i] = if (unsigned) ((bytes[i].toInt() and 0xff) - 128).toByte() else bytes[i]
    return out
}

private val MHZ_ANY = Regex("\\d+(?:\\.\\d+)?\\s*mhz", RegexOption.IGNORE_CASE)
private val RATE_KM = Regex("(\\d+(?:\\.\\d+)?)\\s*(k|m)(?:sps|s/s|hz)?(?![a-z])", RegexOption.IGNORE_CASE)
private val RATE_SPS = Regex("(\\d{6,8})\\s*(?:sps|s/s)", RegexOption.IGNORE_CASE)
private val FREQ_MHZ = Regex("(\\d{2,4}(?:\\.\\d+)?)\\s*mhz", RegexOption.IGNORE_CASE)
private val FREQ_M = Regex("(?:^|[_\\-\\s])(\\d{3}(?:\\.\\d+)?)m(?![a-z])", RegexOption.IGNORE_CASE)
private val FREQ_HZ = Regex("(\\d{8,10})\\s*hz", RegexOption.IGNORE_CASE)
private val FREQ_BARE = Regex("(?:^|[_\\-\\s])(\\d{9})(?:[_\\-.\\s]|$)")

/** The sample rate a file name gives (`_250k`, `2Msps`, `2M`, `_1000000Hz`), or null. */
fun rateFromName(name: String): Double? {
    val m = RATE_KM.find(name.replace(MHZ_ANY, ""))
    if (m != null) {
        val v = m.groupValues[1].toDouble() * (if (m.groupValues[2].lowercase() == "k") 1e3 else 1e6)
        if (v >= 2e4 && v <= 2e7) return v
    }
    val s = RATE_SPS.find(name)
    return s?.groupValues?.get(1)?.toDouble()
}
/** The center frequency a file name gives (`315MHz`, `433.92M`, `_433920000Hz`), or null. */
fun freqFromName(name: String): Long? {
    val m = FREQ_MHZ.find(name) ?: FREQ_M.find(name)
    if (m != null) return Math.round(m.groupValues[1].toDouble() * 1e6)
    val h = FREQ_HZ.find(name) ?: FREQ_BARE.find(name)
    return h?.groupValues?.get(1)?.toLong()
}

/** Flipper's presets: OOK at 650 kHz bandwidth, or 2-FSK at 2.38 / 47.6 kHz deviation. */
fun subPreset(fsk: Boolean, shiftHz: Double): String {
    if (!fsk) return "FuriHalSubGhzPresetOok650Async"
    return if (shiftHz / 2 > 12_000) "FuriHalSubGhzPreset2FSKDev476Async" else "FuriHalSubGhzPreset2FSKDev238Async"
}

/** A Flipper `.sub` RAW file: signed microseconds, positive high, 512 to a line as the Flipper writes them. */
fun toSub(pulses: List<Int>, freqHz: Double, fsk: Boolean, shiftHz: Double): String {
    val lines = arrayListOf("Filetype: Flipper SubGhz RAW File", "Version: 1", "Frequency: ${Math.round(freqHz)}", "Preset: ${subPreset(fsk, shiftHz)}", "Protocol: RAW")
    var i = 0
    while (i < pulses.size) { lines.add("RAW_Data: ${pulses.subList(i, min(pulses.size, i + 512)).joinToString(" ")}"); i += 512 }
    return lines.joinToString("\n") + "\n"
}

data class SubFile(val freqHz: Double, val preset: String, val fsk: Boolean, val pulses: List<Int>)

private val LEADING_INT = Regex("^[+-]?\\d+")

/** Read a Flipper `.sub` RAW file. Null when it is not one (a decoded `.sub` holds a key, not pulses). */
fun parseSub(text: String): SubFile? {
    var freqHz = 433_920_000.0; var preset = ""
    val pulses = ArrayList<Int>()
    for (raw in text.split(Regex("\\r?\\n"))) {
        val i = raw.indexOf(':')
        if (i < 0) continue
        val k = raw.substring(0, i).trim(); val v = raw.substring(i + 1).trim()
        if (k == "Frequency") freqHz = v.toDoubleOrNull()?.takeIf { it != 0.0 } ?: freqHz
        else if (k == "Preset") preset = v
        // parseInt: the leading whole number of each token, if any
        else if (k == "RAW_Data") for (t in v.split(Regex("\\s+"))) { val x = LEADING_INT.find(t)?.value?.toIntOrNull() ?: 0; if (x != 0) pulses.add(x) }
    }
    if (pulses.isEmpty()) return null
    return SubFile(freqHz, preset, preset.contains("FSK", ignoreCase = true), pulses)
}

/** The web's LCG step, in doubles as JavaScript does it (the product passes 2^53, so its low bits round the same way). */
internal fun lcg(seed: Long): Long = (seed.toDouble() * 1103515245 + 12345).toLong() and 0xFFFFFFFFL

/**
 * Pulses back into samples, so a `.sub` goes through the same capture and views as anything off the air: a carrier
 * 100 kHz above center (clear of the DC the finder ignores) keyed on and off, or shifted ±20 kHz for FSK, over a
 * little noise, with a tenth of a second of noise before it for the finder to learn the floor from.
 */
fun synthesize(pulses: List<Int>, fsk: Boolean, rate: Int = 1_000_000): ByteArray {
    var total = 0.0
    for (p in pulses) total += min(abs(p), 200_000)
    val lead = Math.round(rate * 0.1).toInt()
    val n = lead + Math.round(total * rate / 1e6).toInt() + lead
    val out = ByteArray(n * 2)
    var seed = 7L
    fun noise(): Int { seed = lcg(seed); return ((seed ushr 16) % 7).toInt() - 3 }
    var ph = 0.0; var k = 0
    fun put(amp: Double, hz: Double) {
        ph += 2 * PI * hz / rate
        if (ph > PI) ph -= 2 * PI
        out[2 * k] = max(-128L, min(127L, Math.round(amp * cos(ph)) + noise())).toByte()
        out[2 * k + 1] = max(-128L, min(127L, Math.round(amp * sin(ph)) + noise())).toByte()
        k++
    }
    for (i in 0 until lead) put(0.0, 0.0)
    for (p in pulses) {
        val m = Math.round(min(abs(p), 200_000).toDouble() * rate / 1e6).toInt(); val hi = p > 0
        var i = 0
        while (i < m && k < n) {
            put(if (fsk) 60.0 else if (hi) 60.0 else 0.0, if (fsk) 100_000.0 + (if (hi) 20_000 else -20_000) else 100_000.0)
            i++
        }
    }
    while (k < n) put(0.0, 0.0)
    return out
}

/** A name for an exported burst: where it was, the rate, and which one. */
fun exportName(freqHz: Double, rate: Double, id: Int, ext: String): String =
    "analyzer_${String.format(Locale.US, "%.3f", freqHz / 1e6)}MHz_${Math.round(rate / 1e3)}k_$id.$ext"
