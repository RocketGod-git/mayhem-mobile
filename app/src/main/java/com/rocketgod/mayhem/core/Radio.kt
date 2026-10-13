package com.rocketgod.mayhem.core

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Which radio is attached and what it can do. A HackRF and an RTL-SDR differ in what they tune, how fast they
 * sample, how their gain is arranged and whether they transmit at all, so each declares its limits and the app
 * asks, rather than trying something and reading the wreckage afterwards.
 */
object Radio {
    enum class Kind { NONE, HACKRF, RTLSDR }

    /** The envelope a radio works inside; hardware, not preference. Rates are inclusive ranges in hertz. */
    data class Limits(val minHz: Long, val maxHz: Long, val rates: List<IntRange>, val canTransmit: Boolean)

    val HACKRF = Limits(1_000_000L, 6_000_000_000L, listOf(1_000_000..20_000_000), true)
    /** Below ~24 MHz the R82xx tracking filter runs out, above 1.766 GHz the PLL; between 300 and 900 kHz the
     *  resampler produces nothing usable, and past 2.4 Msps the USB link drops samples rather than slowing. */
    val RTLSDR = Limits(24_000_000L, 1_766_000_000L, listOf(225_001..300_000, 900_001..2_400_000), false)

    private val _kind = MutableStateFlow(Kind.NONE)
    val kind: StateFlow<Kind> = _kind.asStateFlow()
    fun attached(k: Kind) { _kind.value = k }

    /** With nothing attached nothing is dimmed: a HackRF session looks exactly as it always did. */
    val limits: Limits get() = if (_kind.value == Kind.RTLSDR) RTLSDR else HACKRF
    val canTransmit: Boolean get() = limits.canTransmit
    val name: String get() = if (_kind.value == Kind.RTLSDR) "RTL-SDR" else "HackRF"

    /** What is attached, as it named itself at bring-up: board and firmware, or dongle and tuner; "" for nothing. */
    val label: String get() = when (_kind.value) {
        Kind.RTLSDR -> com.rocketgod.mayhem.usb.RtlSdr.label
        Kind.HACKRF -> com.rocketgod.mayhem.usb.HackRfOne.let { h -> h.boardLabel.ifEmpty { "HackRF" } + if (h.firmware.isNotEmpty()) " · fw ${h.firmware}" else "" }
        Kind.NONE -> ""
    }

    fun canTune(l: Limits, hz: Long) = hz in l.minHz..l.maxHz
    fun canSample(l: Limits, hz: Int) = l.rates.any { hz in it }

    /** The nearest rate the radio will accept, for clamping rather than refusing. */
    fun nearestRate(l: Limits, hz: Int): Int {
        if (canSample(l, hz)) return hz
        var best = l.rates[0].first; var bestD = Long.MAX_VALUE
        for (r in l.rates) for (c in intArrayOf(r.first, r.last)) { val d = kotlin.math.abs(c.toLong() - hz); if (d < bestD) { bestD = d; best = c } }
        return best
    }

    /** The one thing about an app a radio has to be able to do: the band it exists for, or transmitting at all. */
    data class Needs(val freqHz: Long? = null, val tx: Boolean = false)
    val NEEDS = mapOf(
        // HAM is an HF app before anything else: SSB, CW and FT8 at 14.074 sit below where a dongle's tuner starts.
        // It still works on two metres, so it is dimmed, not locked.
        MayhemApp.HAM to Needs(freqHz = 14_074_000L),
        MayhemApp.BTLE to Needs(freqHz = 2_402_000_000L),
        MayhemApp.TRANSMIT to Needs(tx = true),
    )

    /** Why an app is not worth opening on this radio, or "" when it is. */
    fun blockedBecause(app: MayhemApp, l: Limits = limits): String {
        val n = NEEDS[app] ?: return ""
        if (n.tx && !l.canTransmit) return "this radio receives only"
        val f = n.freqHz
        if (f != null && !canTune(l, f)) return "it lives at %.3f MHz, outside this radio's %d–%d MHz".format(f / 1e6, l.minHz / 1_000_000, l.maxHz / 1_000_000)
        return ""
    }
}
