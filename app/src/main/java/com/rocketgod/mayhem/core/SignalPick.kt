package com.rocketgod.mayhem.core

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToLong

/** The signal under a tap: the strongest whose band holds it, else the nearest within [reachHz]. */
fun signalAt(hz: Long, reachHz: Double): Signal? {
    var inside: Signal? = null; var near: Signal? = null; var nearD = Double.MAX_VALUE
    for (s in SdrEngine.signals.value) {
        val d = abs(s.hz - hz)
        if (d <= s.bw6 / 2 + reachHz / 3 && (inside == null || s.db > inside.db)) inside = s
        if (d <= reachHz && d < nearD) { near = s; nearD = d }
    }
    return inside ?: near
}

/** The channel raster a mode lives on, for snapping. */
fun rasterFor(m: SdrEngine.Mode): Long = when (m) { SdrEngine.Mode.WFM -> 100_000L; SdrEngine.Mode.NFM -> 12_500L; SdrEngine.Mode.AM -> 10_000L; else -> 1_000L }

/**
 * Where to put the dial for a signal: its measured center, pulled onto the raster when close (a repeater measured
 * 200 Hz off still reads 146.520). SSB humps sit beside the suppressed carrier, so the dial goes to the carrier.
 */
fun signalDial(s: Signal, raster: Long): Long {
    var hz = s.hz
    if (s.cls == "USB") hz -= s.bw6 / 2 + 300 else if (s.cls == "LSB") hz += s.bw6 / 2 + 300
    val on = (hz / raster).roundToLong() * raster
    val wide = s.cls == "WFM" || s.cls == "WIDE" || s.bw6 > 60_000
    if (abs(on - hz) < if (wide) raster / 2.0 else max(raster / 3.0, s.bw6 * 0.2)) return on
    return (hz / 100).roundToLong() * 100
}

/**
 * The mode a tapped signal asks for: a wide hump (or anything in the broadcast band) is WFM and a confident label
 * picks its own. A doubtful narrow hump heard in WFM is safest as NFM; otherwise a doubtful one leaves the mode
 * alone rather than putting a broadcast station through a 12.5 kHz demodulator.
 */
fun modeFor(s: Signal, current: SdrEngine.Mode = SdrEngine.mode.value): SdrEngine.Mode? {
    val wide = s.cls == "WFM" || s.cls == "WIDE" || s.bw6 > 60_000 || (s.hz > 87_500_000 && s.hz < 108_000_000)
    if (wide) return SdrEngine.Mode.WFM
    if (s.conf >= 0.6) return when (s.cls) { "AM" -> SdrEngine.Mode.AM; "USB" -> SdrEngine.Mode.USB; "LSB", "SSB" -> SdrEngine.Mode.LSB; else -> SdrEngine.Mode.NFM }
    return if (current == SdrEngine.Mode.WFM || current == SdrEngine.Mode.NONE) SdrEngine.Mode.NFM else null
}

/**
 * The first thing heard on opening: like the web app's front door, the strongest station in view, picked once a
 * moment after the radio comes up, and never if the user has tuned anything first.
 */
object AutoPick {
    @Volatile private var armed = false
    @Volatile private var firstSeen = 0L
    @Volatile private var channel = 0L

    /** Wait for a station; the clock starts when the first signals arrive, so a radio plugged in later still gets one. */
    fun arm() { armed = true; firstSeen = 0L; channel = SdrEngine.channelHz() }

    /** Called with each new set of signals; picks at most once per [arm]. */
    fun onSignals(list: List<Signal>) {
        if (!armed) return
        if (SdrEngine.channelHz() != channel) { armed = false; return }        // the user got there first
        if (list.isEmpty()) return
        val now = System.currentTimeMillis()
        if (firstSeen == 0L) { firstSeen = now; return }
        if (now - firstSeen < 2500) return                                      // let the AGC and the classifier settle
        if (now - firstSeen > 30_000) { armed = false; return }
        val lo = SdrEngine.freqHz.value; val half = SdrEngine.rateHz.value / 2 - 100_000
        val inView = list.filter { abs(it.hz - lo) <= half }
        val broadcast = SdrEngine.mode.value == SdrEngine.Mode.WFM
        val pool = if (broadcast) inView.filter { it.cls == "WFM" || it.bw6 > 60_000 }.ifEmpty { inView } else inView
        val best = pool.maxByOrNull { it.snr } ?: return
        armed = false
        modeFor(best)?.let { if (it != SdrEngine.mode.value) SdrEngine.setMode(it, silent = true) }
        SdrEngine.tune(signalDial(best, rasterFor(SdrEngine.mode.value)), silent = true)
        com.rocketgod.mayhem.Diag.log("start-up: tuned the strongest signal in view, %.3f MHz %s %.0f dB".format(best.hz / 1e6, best.cls, best.snr))
    }
}
