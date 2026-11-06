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
 * Where to put the dial for a signal: its measured centre, pulled onto the raster when close (a repeater measured
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
 * The first thing heard on opening: the strongest steady station in view, picked once a moment after the radio is up
 * and streaming, and never if the user has tuned anything first.
 */
object AutoPick {
    @Volatile private var armed = false
    @Volatile private var armedAt = 0L
    @Volatile private var firstSeen = 0L
    @Volatile private var channel = 0L
    /** The candidates from about a second ago: a pick has to be in both, so a burst of noise in one frame never wins. */
    @Volatile private var earlier: List<Signal> = emptyList()
    @Volatile private var earlierAt = 0L

    /** Wait for a station; the clock starts when the first signals arrive, so a radio plugged in later still gets one. */
    fun arm() {
        armed = true; firstSeen = 0L; channel = SdrEngine.channelHz()
        armedAt = System.currentTimeMillis(); earlier = emptyList(); earlierAt = 0L
    }

    /**
     * Show the whole listening band the dial is in (as the band chips do), so the pick is the strongest station
     * anywhere in the band, not just in the span around the dial. The app sets it (the bands are UI data).
     */
    @Volatile var viewWholeBand: (() -> Unit)? = null

    @Volatile private var gen = 0

    /**
     * Look across the band once the radio is up and streaming. At start-up the app gets here before the radio has
     * attached, when nothing says yet whether it is a HackRF or an RTL-SDR and there is nothing to hear. A tune by
     * hand, or another app, while it waits calls it off.
     */
    fun armBand() {
        val g = ++gen
        armed = false
        val ch = SdrEngine.channelHz()
        Thread({
            var waited = 0
            while (Radio.kind.value == Radio.Kind.NONE || SdrEngine.rxHealth.value.isEmpty()) {
                if (g != gen || SdrEngine.channelHz() != ch || waited > 600_000) return@Thread
                Thread.sleep(250); waited += 250
            }
            if (g != gen || SdrEngine.channelHz() != ch) return@Thread
            viewWholeBand?.invoke()
            arm()
        }, "band-pick").apply { isDaemon = true; start() }
    }
    /** Another app taking the radio calls off a pick still waiting for it. */
    fun stop() { gen++; armed = false }

    /** Called with each new set of signals; picks at most once per [arm]. */
    fun onSignals(list: List<Signal>) {
        if (!armed) return
        if (SdrEngine.channelHz() != channel) { armed = false; return }        // the user got there first
        val now = System.currentTimeMillis()
        // a retune or a new span right before arming leaves lists from the old view in flight, and the AGC and the
        // classifier need a moment at the new one: nothing before then counts
        if (now - armedAt < 1500 || list.isEmpty()) return
        if (firstSeen == 0L) { firstSeen = now; return }
        if (now - firstSeen > 30_000) { armed = false; return }
        val lo = SdrEngine.freqHz.value; val half = SdrEngine.rateHz.value / 2 - 100_000
        // in view, and not the radio's own spike at the middle of the span (a HackRF's DC offset)
        val inView = list.filter { abs(it.hz - lo) <= half && abs(it.hz - lo) > 30_000 }
        // broadcast: a real station is wide; a radio's own spur (a HackRF's clock line at an exact megahertz) is a
        // single bin even when the classifier calls it WFM, so width decides, with no fall-back to narrow ones
        val pool = if (SdrEngine.mode.value == SdrEngine.Mode.WFM) inView.filter { it.bw6 > 60_000 } else inView
        // already on a good station (the dial the app came back to): stay there, never trade it for another
        val here = SdrEngine.channelHz().toDouble()
        val on = pool.firstOrNull { abs(it.hz - here) <= max(50_000.0, it.bw6 / 2) }
        if (on != null && on.snr >= 15) {
            armed = false
            SdrEngine.recentre()
            com.rocketgod.mayhem.Diag.log("start-up: staying on the station already tuned, %.3f MHz %.0f dB".format(on.hz / 1e6, on.snr))
            return
        }
        if (now - earlierAt < 1000) return
        val prev = earlier
        earlier = pool; earlierAt = now
        if (now - firstSeen < 2500 || prev.isEmpty()) return                    // let the AGC and the classifier settle
        // held for a second: in the list a second ago as well as now
        val best = pool.filter { s -> prev.any { abs(it.hz - s.hz) <= 50_000 } }.maxByOrNull { it.snr } ?: return
        armed = false
        modeFor(best)?.let { if (it != SdrEngine.mode.value) SdrEngine.setMode(it, silent = true) }
        SdrEngine.tune(signalDial(best, rasterFor(SdrEngine.mode.value)), silent = true)
        // the pick sits in the middle of the waterfall, not off at the side (the span stays as wide as it was)
        if (!SdrEngine.spanByHand) SdrEngine.recentre()
        com.rocketgod.mayhem.Diag.log("start-up: tuned the strongest steady signal in view, %.3f MHz %s %.0f dB".format(best.hz / 1e6, best.cls, best.snr))
    }
}
