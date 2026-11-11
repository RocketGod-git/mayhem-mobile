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
    /** Every signal seen since the gain settled, by 100 kHz channel: frames it was in, and its best reading. */
    private val tally = HashMap<Long, Pair<Int, Signal>>()
    @Volatile private var frames = 0
    /**
     * Broadcast: the spectrum (dB above the floor) summed since the gain settled, and how many frames went in. The
     * classifier's verdict on a strong station swings frame to frame (47 kHz to 1.8 MHz wide as its HD sidebands merge
     * in, sometimes folded into a broad hump, its center wandering 200 kHz), and the radio's own clock line at an exact
     * megahertz sometimes passes for a station. So the pick there is the 160 kHz channel with the most level across
     * it, averaged: a real station fills the channel, a clock line is one bin however tall.
     */
    private var specAcc = DoubleArray(0)
    private var specN = 0
    /** Total gain (dB) the pick is waiting to see hold, and since when. */
    @Volatile private var gainAt = -1
    @Volatile private var gainSince = 0L

    /** Wait for a station; the clock starts when the first signals arrive, so a radio plugged in later still gets one. */
    @Synchronized fun arm() {
        armed = true; firstSeen = 0L; channel = SdrEngine.channelHz()
        armedAt = System.currentTimeMillis(); tally.clear(); frames = 0; specAcc = DoubleArray(0); specN = 0; gainAt = -1
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
    @Synchronized fun onSignals(list: List<Signal>, pdb: FloatArray = FloatArray(0), floorDb: Float = 0f) {
        if (!armed) return
        if (SdrEngine.channelHz() != channel) { armed = false; return }        // the user got there first
        val now = System.currentTimeMillis()
        // a retune or a new span right before arming leaves lists from the old view in flight, and the AGC and the
        // classifier need a moment at the new one: nothing before then counts
        if (now - armedAt < 1500 || list.isEmpty()) return
        if (firstSeen == 0L) { firstSeen = now; return }
        if (now - firstSeen > 30_000) { armed = false; return }
        // a pick taken while the AGC is still stepping measures stations through an overloaded front end (a strong one
        // smeared to 700 kHz, or shrank to 50): wait until the gain has held within 3 dB for 1 s (the AGC's last 2 dB
        // back-and-forth does not count), and forget the lists taken at the old gain
        val gain = SdrEngine.radioLna.value + SdrEngine.radioVga.value + if (SdrEngine.radioAmp.value) 14 else 0
        if (gainAt < 0 || abs(gain - gainAt) > 3) { gainAt = gain; gainSince = now; tally.clear(); frames = 0; specAcc = DoubleArray(0); specN = 0; return }
        val lo = SdrEngine.freqHz.value; val half = SdrEngine.rateHz.value / 2 - 100_000
        // in view, and not the radio's own spike at the middle of the span (a HackRF's DC offset)
        val inView = list.filter { abs(it.hz - lo) <= half && abs(it.hz - lo) > 30_000 }
        // broadcast: a real station is wide; a radio's own spur (a HackRF's clock line at an exact megahertz) is a
        // single bin even when the classifier calls it WFM, so width decides, with no fall-back to narrow ones; and
        // a broad noise hump (read as a "station" megahertz wide) is not one either
        // (a strong station can read only ~50 kHz at -6 dB, so a spur is told apart by being narrower than 25 kHz at -6 dB
        // AND under 80 kHz at -20 dB, not by a 60 kHz floor that threw out the strongest station in view)
        val broadcast = SdrEngine.mode.value == SdrEngine.Mode.WFM
        val pool = if (broadcast) inView.filter { (it.bw6 > 25_000 || it.bw20 > 80_000) && (it.bw6 < 400_000 || (it.snr >= 25 && it.bw6 < 1_000_000)) } else inView
        // already on a good station (the dial the app came back to): stay there, never trade it for another
        val here = SdrEngine.channelHz().toDouble()
        // (broadcast decides this from the channel levels below: a dial sitting on the radio's own DC spike passed for
        // a 17 dB station here)
        if (!broadcast) {
            val on = pool.firstOrNull { abs(it.hz - here) <= max(50_000.0, minOf(it.bw6, 300_000.0) / 2) }
            if (on != null && on.snr >= 15) {
                armed = false
                com.rocketgod.mayhem.Diag.log("start-up: staying on the station already tuned, %.3f MHz %.0f dB %.0f kHz wide".format(on.hz / 1e6, on.snr, on.bw6 / 1e3))
                return
            }
        }
        frames++
        for (k in pool.map { Math.round(it.hz / 100_000) }.distinct()) {
            val s = pool.filter { Math.round(it.hz / 100_000) == k }.maxByOrNull { it.snr }!!
            val t = tally[k]
            tally[k] = Pair((t?.first ?: 0) + 1, if (t == null || s.snr > t.second.snr) s else t.second)
        }
        if (broadcast && pdb.isNotEmpty()) {
            if (specAcc.size != pdb.size) { specAcc = DoubleArray(pdb.size); specN = 0 }
            for (k in pdb.indices) specAcc[k] += max(0.0, (pdb[k] - floorDb).toDouble())
            specN++
        }
        if (now - firstSeen < 2500 || now - gainSince < 1000 || frames < 3) return                    // let the AGC and the classifier settle
        if (broadcast && specN >= 3) {
            // every 100 kHz raster channel in view (clear of the DC spike at the middle), scored by the average level
            // summed across ±80 kHz of it
            val rate = SdrEngine.rateHz.value.toDouble(); val n = specAcc.size; val binHz = rate / n
            val w = maxOf(1, (80_000 / binHz).toInt()); val start = lo - rate / 2
            fun score(c: Double): Double {
                val mid = ((c - start) / binHz).toInt()
                var sum = 0.0
                for (k in maxOf(0, mid - w)..minOf(n - 1, mid + w)) sum += specAcc[k]
                return sum / specN
            }
            val scores = ArrayList<Pair<Double, Double>>()
            var c = Math.ceil((lo - half) / 100_000.0) * 100_000
            while (c <= lo + half) { if (abs(c - lo) > 60_000) scores.add(Pair(c, score(c))); c += 100_000 }
            val best = scores.maxByOrNull { it.second } ?: return
            armed = false
            // already on a good station (the dial the app came back to): stay unless it is under a third of the best one;
            // a dial on the DC spike at the middle of the span cannot be judged, so it is not kept
            if (abs(here - lo) > 60_000 && abs(here - lo) <= half) {
                val mine = score(here)
                if (mine >= best.second / 3) {
                    com.rocketgod.mayhem.Diag.log("start-up: staying on the station already tuned, %.3f MHz (level %.0f, best in view %.1f MHz %.0f)".format(here / 1e6, mine, best.first / 1e6, best.second))
                    return
                }
            }
            val top = scores.sortedByDescending { it.second }.take(5).joinToString(" ") { "%.1f/%.0f".format(it.first / 1e6, it.second) }
            com.rocketgod.mayhem.Diag.log("start-up: channels by level across 160 kHz (MHz/score, $specN frames) $top")
            if (SdrEngine.mode.value != SdrEngine.Mode.WFM) SdrEngine.setMode(SdrEngine.Mode.WFM, silent = true)
            SdrEngine.tune(best.first.toLong(), silent = true)
            com.rocketgod.mayhem.Diag.log("start-up: tuned the strongest station in view, %.1f MHz".format(best.first / 1e6))
            return
        }
        val best = tally.values.filter { it.first * 3 >= frames }.maxByOrNull { it.second.snr }?.second ?: return
        armed = false
        modeFor(best)?.let { if (it != SdrEngine.mode.value) SdrEngine.setMode(it, silent = true) }
        SdrEngine.tune(signalDial(best, rasterFor(SdrEngine.mode.value)), silent = true)
        com.rocketgod.mayhem.Diag.log("start-up: tuned the strongest steady signal in view, %.3f MHz %s %.0f dB %.0f kHz wide".format(best.hz / 1e6, best.cls, best.snr, best.bw6 / 1e3))
    }
}
