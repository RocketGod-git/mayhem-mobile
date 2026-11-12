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

    /**
     * The settings a radio can take beyond frequency, one flag per control on the RADIO panel. A control whose flag
     * is false is not drawn at all: a switch that moves and changes nothing is worse than no switch.
     */
    data class Caps(
        /** A HackRF's two receive stages: LNA 0-40 dB in 8s and VGA 0-62 dB in 2s. */
        val stagedGain: Boolean,
        /** An RTL-SDR's single tuner gain, 0-48.8 dB. */
        val tunerGain: Boolean,
        /** The HackRF's +14 dB front-end amplifier. */
        val amp: Boolean,
        /** DC on the antenna port for an inline LNA: HackRF antenna power (3.3 V), RTL-SDR Blog bias tee (4.5 V). */
        val biasT: Boolean,
        /** Volts the bias tee puts out, for the warning. */
        val biasVolts: Double,
        /** The R82xx tuner's own automatic gain. */
        val tunerAgc: Boolean,
        /** The RTL2832U's digital AGC. */
        val rtlAgc: Boolean,
        /** Crystal correction in parts per million. */
        val ppm: Boolean,
        /** HF by direct sampling of the ADC's Q branch (R820T/R820T2 only). */
        val directSampling: Boolean,
        /** The MAX2837's baseband filter bandwidths, in hertz; empty when the radio has no choice. */
        val bbFilters: List<Int>,
    )

    /** Everything a HackRF (One, r9, Pro, or a PortaPack in HackRF mode) can be told besides frequency. */
    val HACKRF_CAPS by lazy {
        Caps(stagedGain = true, tunerGain = false, amp = true, biasT = true, biasVolts = 3.3,
            tunerAgc = false, rtlAgc = false, ppm = false, directSampling = false, bbFilters = com.rocketgod.mayhem.usb.HackRfOne.BB_FILTER_BW.toList())
    }

    /** What the attached radio can be told, for the RADIO panel; null with nothing attached. Only what bring-up has found is listed. */
    val caps: Caps? get() = when (_kind.value) {
        Kind.HACKRF -> HACKRF_CAPS
        Kind.RTLSDR -> Caps(stagedGain = false, tunerGain = true, amp = false, biasT = true, biasVolts = 4.5,
            tunerAgc = true, rtlAgc = true, ppm = true, directSampling = com.rocketgod.mayhem.usb.RtlSdr.canDirectSample, bbFilters = emptyList())
        Kind.NONE -> null
    }

    /** Sample rates worth offering by hand, highest first; each radio shows the ones it accepts. */
    val RATE_CHOICES = listOf(20_000_000, 16_000_000, 12_500_000, 10_000_000, 8_000_000, 4_000_000, 3_200_000, 2_800_000,
        2_400_000, 2_048_000, 2_000_000, 1_800_000, 1_400_000, 1_024_000, 250_000)

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
        // HAM is not here: HF sits below where a dongle's tuner starts, but two meters and 70 cm do not, so on a
        // dongle HAM opens on 146.520 instead of being dimmed (Ham.open).
        MayhemApp.BTLE to Needs(freqHz = 2_402_000_000L),
        MayhemApp.TRANSMIT to Needs(tx = true),
        MayhemApp.TROLL to Needs(tx = true),
    )

    /** Why this radio cannot reach any of [lo]..[hi], or "" when it can reach some of it. */
    fun tuneWhy(lo: Long, hi: Long = lo, l: Limits = limits): String =
        if (hi < l.minHz || lo > l.maxHz) "${if (lo == hi) "%.3f MHz".format(lo / 1e6) else "%.0f–%.0f MHz".format(lo / 1e6, hi / 1e6)} is outside this $name's %d–%d MHz".format(l.minHz / 1_000_000, l.maxHz / 1_000_000) else ""

    /** Why this radio cannot sample at [hz], or "". */
    fun rateWhy(hz: Int, l: Limits = limits): String =
        if (canSample(l, hz)) "" else "%.1f Msps is above this $name's %.1f".format(hz / 1e6, l.rates.maxOf { it.last } / 1e6)

    /** What to suggest when the dongle cannot do something. */
    const val HACKRF_PITCH = "A HackRF covers 1 MHz to 6 GHz, samples up to 20 Msps and transmits."

    /** Why an app is not worth opening on this radio, or "" when it is. */
    fun blockedBecause(app: MayhemApp, l: Limits = limits): String {
        val n = NEEDS[app] ?: return ""
        if (n.tx && !l.canTransmit) return "this radio receives only"
        val f = n.freqHz
        if (f != null && !canTune(l, f)) return "%.3f MHz is outside its %d–%d MHz".format(f / 1e6, l.minHz / 1_000_000, l.maxHz / 1_000_000)
        return ""
    }
}
