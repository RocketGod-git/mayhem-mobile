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
    /**
     * A radio that sees only part of the band (an RTL-SDR: 2.4 of FM's 20 MHz) looks across it a view at a time: the
     * views still to look at, every channel's best score so far, and whether this view is a hop (the one at the dial
     * is not).
     */
    private val hops = ArrayDeque<Long>()
    private val swept = HashMap<Long, Double>()
    /** The channels beside each hop's middle, which the dongle's leakage lifts (see [BandLook.middles]). */
    private var middles: Set<Long> = emptySet()
    @Volatile private var hopping = false
    /** The dial when the band look began, and the band it looks across. */
    private var dialHz = 0L
    private var bandLo = 0L
    private var bandHi = 0L
    /** A band the next [arm] also looks across (the start-up pick on a narrow radio). */
    @Volatile private var pendingBand: Pair<Long, Long>? = null

    /** Wait for a station; the clock starts when the first signals arrive, so a radio plugged in later still gets one. */
    @Synchronized fun arm() {
        armed = true; firstSeen = 0L; channel = SdrEngine.channelHz()
        armedAt = System.currentTimeMillis(); tally.clear(); frames = 0; specAcc = DoubleArray(0); specN = 0; gainAt = -1
        hops.clear(); swept.clear(); hopping = false
        val b = pendingBand
        if (b != null) {
            pendingBand = null; dialHz = channel; bandLo = b.first; bandHi = b.second
            hops.addAll(BandLook.hops(b.first, b.second, SdrEngine.rateHz.value)); middles = BandLook.middles(hops)
        }
    }

    /** The next [arm] also looks across the band [lo]..[hi], a view at a time (set by [viewWholeBand] on a narrow radio). */
    fun armThenSweep(lo: Long, hi: Long) { pendingBand = Pair(lo, hi) }

    /**
     * The pick is over (made, kept, or given up): a network radio leaves the view it hunted in for the rate it had
     * before (the less a Wi-Fi link has to carry, the better); USB keeps it.
     */
    private fun done() {
        armed = false; hops.clear(); swept.clear(); hopping = false
        if (com.rocketgod.mayhem.net.RtlTcp.active) SdrEngine.endWideScan()
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
    fun stop() { gen++; armed = false; pendingBand = null; synchronized(this) { hops.clear(); swept.clear(); hopping = false } }

    /** Called with each new set of signals; picks at most once per [arm]. */
    @Synchronized fun onSignals(list: List<Signal>, pdb: FloatArray = FloatArray(0), floorDb: Float = 0f) {
        if (!armed) return
        if (SdrEngine.channelHz() != channel) { done(); return }        // the user got there first
        val now = System.currentTimeMillis()
        // a retune or a new span right before arming leaves lists from the old view in flight, and the AGC and the
        // classifier need a moment at the new one: nothing before then counts (a hop's view may hold no signal at
        // all: its spectrum still counts)
        if (now - armedAt < BandLook.DRAIN_MS || (list.isEmpty() && !hopping)) return
        if (firstSeen == 0L) { firstSeen = now; return }
        if (now - firstSeen > 30_000) {
            if (hopping || hops.isNotEmpty()) com.rocketgod.mayhem.Diag.log("start-up: the band look stalled, staying on %.1f MHz".format(channel / 1e6))
            done(); return
        }
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
                com.rocketgod.mayhem.Diag.log("start-up: staying on the station already tuned, %.3f MHz %.0f dB %.0f kHz wide".format(on.hz / 1e6, on.snr, on.bw6 / 1e3))
                done()
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
        if (now - firstSeen < (if (hopping) BandLook.LOOK_MS else 2500L) || now - gainSince < 1000 || frames < 3) return   // let the AGC and the classifier settle
        if (broadcast && specN >= 3) {
            // every 100 kHz raster channel in view, scored by the average level across ±80 kHz of it. The middle
            // channel counts too: the radio opens centered on the dial, so the station is often right there, and
            // leaving it out made its two shoulders (±100 kHz) the "strongest stations" and tuned 100 kHz off it.
            // Only the DC spike's own bins (±30 kHz of the middle) are left out of every score.
            val rate = SdrEngine.rateHz.value.toDouble()
            fun score(c: Double): Double = BandLook.channelScore(specAcc, specN, rate, lo.toDouble(), c)
            val all = BandLook.viewScores(specAcc, specN, rate, lo.toDouble(), half.toDouble())
            // the hops cover the whole band, each channel off its view's middle; the view at the dial is left out,
            // since the dial sits on its middle, where a dongle's own DC and LO leakage reads as a weak station
            if (hopping) BandLook.record(swept, all)
            // the band's own grid, learned from the stations on the air, so it holds in every country: the Americas,
            // Korea and the Philippines put stations on odd tenths only (88.1 to 107.9), Europe and Japan on any 100 kHz
            // step. Off the grid a noise hump can win (101.0 picked on a Mac after Dispatch, garbled)
            val grid = fmGridParity(all)
            val scores = all.filter { grid < 0 || Math.round(it.first / 100_000) % 2 == grid.toLong() }
            val best = scores.maxByOrNull { it.second } ?: return
            // already on a good station (the dial the app came back to): stay unless it is under a third of the best one
            if (!hopping && abs(here - lo) <= half && (grid < 0 || Math.round(here / 100_000) % 2 == grid.toLong())) {
                val mine = score(here)
                // and only on the station itself: a dial 100 kHz to one side sits on its shoulder (garbled audio)
                // and standing out of the band: an empty dial (a fresh install's default) scores near every other
                // empty channel, a station at least half again over the median one. With the rest of the band still
                // to look at, only a station that leads its view and clearly stands out stays now (92.3 read 383
                // beside 93.1 at 1011 on an iPhone, static on the air); the rest is settled against the whole band
                val median = scores.map { it.second }.sorted()[scores.size / 2]
                if (BandLook.dialStays(mine, best.second, median, score(here - 100_000), score(here + 100_000), hops.isNotEmpty())) {
                    com.rocketgod.mayhem.Diag.log("start-up: staying on the station already tuned, %.3f MHz (level %.0f, best in view %.1f MHz %.0f)".format(here / 1e6, mine, best.first / 1e6, best.second))
                    done()
                    return
                }
            }
            if (hops.isNotEmpty()) {
                // the next view across the band: its middle becomes the channel for now (heard as the look goes by)
                val next = hops.removeFirst()
                hopping = true
                SdrEngine.tune(next, silent = true)
                SdrEngine.recentre()
                channel = SdrEngine.channelHz()
                armedAt = now; firstSeen = 0L; tally.clear(); frames = 0; specAcc = DoubleArray(0); specN = 0
                return
            }
            var pick = best
            var where = "in view"
            if (hopping) {
                // the whole band looked at: the strongest channel on the band's grid, learned from every view
                val p = BandLook.pick(swept, dialHz, bandLo, bandHi, middles)
                if (p == null) { done(); return }
                com.rocketgod.mayhem.Diag.log("start-up: looked across the band, ${p.channels} channels, strongest (MHz/score) ${p.top}")
                if (p.keptDial) com.rocketgod.mayhem.Diag.log("start-up: staying on the station already tuned, %.1f MHz (level %.0f, best in the band %.1f MHz %.0f)".format(p.hz / 1e6, p.score, p.bestHz / 1e6, p.bestScore))
                pick = Pair(p.hz, p.score)
                where = "in the band"
            } else {
                val top = scores.sortedByDescending { it.second }.take(5).joinToString(" ") { "%.1f/%.0f".format(it.first / 1e6, it.second) }
                com.rocketgod.mayhem.Diag.log("start-up: channels by level across 160 kHz (MHz/score, $specN frames) $top")
            }
            if (SdrEngine.mode.value != SdrEngine.Mode.WFM) SdrEngine.setMode(SdrEngine.Mode.WFM, silent = true)
            SdrEngine.tune(pick.first.toLong(), silent = true)
            done()
            com.rocketgod.mayhem.Diag.log("start-up: tuned the strongest station $where, %.1f MHz".format(pick.first / 1e6))
            return
        }
        val best = tally.values.filter { it.first * 3 >= frames }.maxByOrNull { it.second.snr }?.second ?: return
        done()
        modeFor(best)?.let { if (it != SdrEngine.mode.value) SdrEngine.setMode(it, silent = true) }
        SdrEngine.tune(signalDial(best, rasterFor(SdrEngine.mode.value)), silent = true)
        com.rocketgod.mayhem.Diag.log("start-up: tuned the strongest steady signal in view, %.3f MHz %s %.0f dB %.0f kHz wide".format(best.hz / 1e6, best.cls, best.snr, best.bw6 / 1e3))
    }
}

/**
 * The broadcast grid in view: 1 when the stations heard sit on odd tenths (200 kHz apart, as in the Americas), 0 on
 * even tenths, -1 for any 100 kHz step. A station is a channel that tops both neighbors and is at least twice the
 * median; it takes three of them, nearly all on one parity, to settle it.
 */
fun fmGridParity(all: List<Pair<Double, Double>>): Int {
    if (all.size < 5) return -1
    val median = all.map { it.second }.sorted()[all.size / 2]
    var odd = 0; var even = 0
    for (i in 1 until all.size - 1) {
        val v = all[i].second
        if (v >= 2 * median && v > 0 && v >= all[i - 1].second && v >= all[i + 1].second) { if (Math.round(all[i].first / 100_000) % 2 == 1L) odd++ else even++ }
    }
    val n = odd + even
    if (n < 3) return -1
    return if (odd >= 0.7 * n) 1 else if (even >= 0.7 * n) 0 else -1
}

/**
 * The start-up pick on a radio that sees only part of a band (an RTL-SDR: 2.4 of FM's 20 MHz). The view at the dial
 * keeps its station only when it leads that view and clearly stands out (the dial sits on the view's middle, where a
 * dongle's own DC and LO leakage reads as a weak station); otherwise the pick looks across the band a view at a time,
 * each view 50 kHz off the 100 kHz raster so no channel sits on a view's middle, and tunes the strongest channel on
 * the band's grid. The dial's station still stays when it is a third of the best and stands out. Pure, for the tests.
 */
object BandLook {
    /** Lists from before a hop: the classifier waits this long after a retune, and a network radio still delivers samples from the old frequency. */
    const val DRAIN_MS = 1500L
    /** Frames are counted for this long once a hop's first list arrives (the view at the dial takes 2.5 s). */
    const val LOOK_MS = 800L

    /** The view centers that cover [lo]..[hi] at [rateHz], 50 kHz off the raster; empty when one view already holds the band. */
    fun hops(lo: Long, hi: Long, rateHz: Int): List<Long> {
        val half = rateHz / 2L - 100_000
        if (half <= 0 || hi - lo <= 2 * half) return emptyList()
        val out = ArrayList<Long>()
        var c = lo + half + 50_000
        while (c - half < hi) { out.add(c); c += 2 * half }
        return out
    }

    /**
     * A channel at [c] scored by the average level across ±80 kHz of it on [specAcc] (dB above the floor, summed over
     * [specN] frames) of a view at [center] sampled at [rate]. The DC spike's own bins (±30 kHz of the middle) are left
     * out of every score.
     */
    fun channelScore(specAcc: DoubleArray, specN: Int, rate: Double, center: Double, c: Double): Double {
        val n = specAcc.size
        if (n == 0 || specN == 0) return 0.0
        val binHz = rate / n
        val w = maxOf(1, (80_000 / binHz).toInt()); val start = center - rate / 2
        val mid = ((c - start) / binHz).toInt()
        var sum = 0.0; var cnt = 0
        for (k in maxOf(0, mid - w)..minOf(n - 1, mid + w)) {
            if (abs(start + (k + 0.5) * binHz - center) < 30_000) continue
            sum += specAcc[k]; cnt++
        }
        return if (cnt == 0) 0.0 else sum / cnt * (2 * w + 1) / specN
    }

    /** Every 100 kHz raster channel within [half] of the view's [center], scored. */
    fun viewScores(specAcc: DoubleArray, specN: Int, rate: Double, center: Double, half: Double): List<Pair<Double, Double>> {
        val all = ArrayList<Pair<Double, Double>>()
        var c = Math.ceil((center - half) / 100_000.0) * 100_000
        while (c <= center + half) { all.add(Pair(c, channelScore(specAcc, specN, rate, center, c))); c += 100_000 }
        return all
    }

    /**
     * The view at the dial keeps the station tuned: a third of the best in view and half again over the median, and
     * not a shoulder ([left], [right] are the channels beside it). With the rest of the band still to look at
     * ([moreToLook]), only one that leads its view and clearly stands out.
     */
    fun dialStays(mine: Double, best: Double, median: Double, left: Double, right: Double, moreToLook: Boolean): Boolean {
        val enough = if (moreToLook) mine >= 0.8 * best && mine >= 3 * median else mine >= best / 3 && mine >= 1.5 * median
        return enough && mine >= left && mine >= right
    }

    /** A view's scores folded into the band's: each channel (by its 100 kHz number) keeps its best. */
    fun record(swept: MutableMap<Long, Double>, all: List<Pair<Double, Double>>) {
        for ((ch, v) in all) { val k = Math.round(ch / 100_000); swept[k] = max(swept[k] ?: 0.0, v) }
    }

    /**
     * The two channels 50 kHz either side of each hop's middle. The dongle's own DC and LO leakage reaches past the
     * bins left out of every score and lifts them a little, one on each grid, which on a band with few stations
     * could teach the grid wrong (the strongest station's even shoulder picked over it). They stay candidates, but
     * the grid is learned without them.
     */
    fun middles(hops: List<Long>): Set<Long> = hops.flatMap { listOf(Math.round((it - 50_000) / 100_000.0), Math.round((it + 50_000) / 100_000.0)) }.toSet()

    /** The verdict on the whole band: where to tune, its score, whether that is the dial's own station, and the band's best. */
    class Pick(val hz: Double, val score: Double, val keptDial: Boolean, val bestHz: Double, val bestScore: Double, val channels: Int, val top: String)

    /** The strongest channel in [lo]..[hi] on the band's grid; the dial's station stays when it is a third of the best and stands out. */
    fun pick(swept: Map<Long, Double>, dialHz: Long, lo: Long, hi: Long, middles: Set<Long> = emptySet()): Pick? {
        val band = swept.keys.filter { it * 100_000 in lo..hi }.sorted().map { Pair(it * 100_000.0, swept[it]!!) }
        if (band.isEmpty()) return null
        val g = fmGridParity(band.map { if (Math.round(it.first / 100_000) in middles) Pair(it.first, 0.0) else it })
        val onGrid = band.filter { g < 0 || Math.round(it.first / 100_000) % 2 == g.toLong() }
        val b = onGrid.maxByOrNull { it.second } ?: return null
        val top = band.sortedByDescending { it.second }.take(5).joinToString(" ") { "%.1f/%.0f".format(it.first / 1e6, it.second) }
        val k = Math.round(dialHz / 100_000.0)
        val mine = swept[k]
        if (mine != null && k * 100_000 in lo..hi && (g < 0 || k % 2 == g.toLong())) {
            val median = onGrid.map { it.second }.sorted()[onGrid.size / 2]
            if (mine >= b.second / 3 && mine >= 1.5 * median && mine >= (swept[k - 1] ?: 0.0) && mine >= (swept[k + 1] ?: 0.0))
                return Pick(dialHz.toDouble(), mine, true, b.first, b.second, band.size, top)
        }
        return Pick(b.first, b.second, false, b.first, b.second, band.size, top)
    }
}
