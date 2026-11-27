package com.rocketgod.mayhem.core.gmrs

import com.rocketgod.mayhem.core.hamid.HamIdent
import com.rocketgod.mayhem.core.hamplus.CLOSE_HOLD_MS
import com.rocketgod.mayhem.core.hamplus.ChannelWatch
import com.rocketgod.mayhem.core.hamplus.HAM_PLAN
import com.rocketgod.mayhem.core.hamplus.HamTracker
import com.rocketgod.mayhem.core.hamplus.HpSnap
import com.rocketgod.mayhem.core.hamplus.PAIR_START_MS
import com.rocketgod.mayhem.core.hamplus.Probe
import com.rocketgod.mayhem.core.hamplus.STEADY_SHOW_MS
import com.rocketgod.mayhem.core.hamplus.TxRec
import com.rocketgod.mayhem.core.hamplus.WatchOpen
import com.rocketgod.mayhem.core.hamplus.WatchPlan
import com.rocketgod.mayhem.core.hamplus.chanKey
import kotlin.math.abs
import kotlin.math.max

/**
 * GMRS and MURS receiver: every channel of the plan in one span at once on HAM+'s watcher, every keyup opened and
 * demodulated by HAM+'s own FM probe (narrow FM, its CTCSS / DCS decoder, its Morse reader and the identity layer's
 * analog signaling: MDC-1200, FleetSync, other data bursts). Receive only.
 *
 * GMRS watches its 30 channels on their 12.5 kHz raster, a keyup opening on the channel that is the strongest within
 * one step; MURS its five on 2.5 kHz. Beyond HAM+:
 *  - a keyup on a repeater input (467.550 to 467.725) is paired with the keyup on its output 5 MHz down that starts
 *    with it, at once (the tracker also learns the pair, as HAM+ does, and then shows the two as one channel);
 *  - every callsign a Morse ID carries is listed (GMRS calls, WRAB123 or KAE1234, and amateur ones);
 *  - a keyup without a voice that carried signaling (an MDC-1200 or FleetSync ID, a data burst, a Morse ID alone) is
 *    logged all the same; a data burst no decoder names is flagged as data with a short hex dump of its bits.
 */
private class GmrsWatch(override val name: String, override val raster: Long, override val peakSteps: Int, private val murs: Boolean) : WatchPlan {
    override fun inPlan(hz: Long): Boolean { val c = gmrsChan(hz) ?: return false; return (c.kind == GmrsKind.MURS) == murs }
    override fun nfft(rate: Int) = HAM_PLAN.nfft(rate)
    override fun spanHalf(rate: Int) = HAM_PLAN.spanHalf(rate)
    override val clearSteps = 0
    override val snap = false
}
val GMRS_WATCH: WatchPlan = GmrsWatch("GMRS", 12_500L, 1, false)
val MURS_WATCH: WatchPlan = GmrsWatch("MURS", 2_500L, 0, true)
/** A GMRS channel this much under its neighbor 12.5 kHz away is taken for that one's splatter (dB). */
const val ADJ_DB = 15.0
/** The GMRS channel filter: cut and taps. */
const val PROBE_CUT_HZ = 6_000.0
const val PROBE_TAPS = 127
/** How many finished keyups are kept for pairing. */
private const val KEEP_KEYS = 400

/** A repeater keyup: its output and input, each one's tone, and which of the two were heard. */
data class GmrsRpt(val outHz: Long, val inHz: Long, val inTone: Double, val inDcs: Int, val outTone: Double, val outDcs: Int, val inHeard: Boolean, val outHeard: Boolean)
/** A callsign heard in a Morse ID. */
data class GmrsCall(val call: String, val gmrs: Boolean, var hz: Long, val firstMs: Double, var lastMs: Double, var count: Int)
/** What the board shows of a channel; [data]: the last keyup on it carried a data burst no decoder named. */
data class GmrsChanState(
    val id: String, val hz: Long, val key: String, val kind: GmrsKind, val name: String, val inSpan: Boolean,
    val open: Boolean, val steady: Boolean, val tone: Double, val dcs: Int, val lastMs: Double, val txs: Int, val call: String, val data: Boolean,
)
private class KeyRec(val id: Int, val hz: Long, val startMs: Double, val endMs: Double, val tone: Double, val dcs: Int)
private class Seen { var tone = 0.0; var dcs = 0; var lastMs = 0.0; var txs = 0; var call = ""; var data = false }

/** The data bursts no decoder named, as the identity layer lists them. */
fun dataLines(id: HamIdent?): List<String> = id?.signaling.orEmpty().filter { it.contains("data burst") }

/**
 * A DCS code read through this share of a keyup is its code (HAM+ asks half): a code passes the Golay check and
 * repeats three times before it counts, so voice is never read as one, but loud voice breaks the reading for a while.
 */
const val DCS_SHARE = 0.2

/** The whole picture, with the band's channels, the callsigns heard and the repeater keyups by keyup id. */
class GmrsSnap(s: HpSnap, val band: GmrsBand, val chans: List<GmrsChanState>, val calls: List<GmrsCall>, val rpt: Map<Int, GmrsRpt>) :
    HpSnap(s.now, s.centerHz, s.rate, s.spanLo, s.spanHi, s.tiles, s.rows, s.convs, s.heat, s.playing, s.replay, s.stats, s.steady, s.flood)

class GmrsEngine(
    val band: GmrsBand,
    clock: () -> Double = { System.currentTimeMillis().toDouble() },
    perf: () -> Double = { System.nanoTime() / 1e6 },
) : ChannelWatch<Probe>(if (band == GmrsBand.MURS) MURS_WATCH else GMRS_WATCH, clock, perf, { now -> HamTracker(GMRS_TRACKER_PLAN, now) }) {
    override val checkClip = true
    private val keys = ArrayList<KeyRec>()
    private val seen = HashMap<Long, Seen>()
    private val calls = LinkedHashMap<String, GmrsCall>()

    init { centerHz = centerOf(band, true) }

    /**
     * GMRS hears each channel through a 6 kHz filter steep enough to keep the next channel, 12.5 kHz away, out. Every
     * keyup's analog signaling is read through, not only around its steady tones as Repeaters does: a data burst is
     * short and seldom holds one tone long enough to be found that way.
     */
    override fun makeProbe(hz: Long, key: String): Probe {
        val p = if (band == GmrsBand.GMRS) Probe(rate.toDouble(), (hz - centerHz).toDouble(), null, centerHz.toDouble(), PROBE_CUT_HZ, PROBE_TAPS)
            else Probe(rate.toDouble(), (hz - centerHz).toDouble(), null, centerHz.toDouble())
        p.idc.analog.onlyTonal = false; p.dcsShare = DCS_SHARE
        return p
    }

    /**
     * HAM+'s opening and closing, but on GMRS one raster step is the next channel: an open keyup is held by its own
     * channel alone, and a keyup opens beside a busy neighbor unless it is [ADJ_DB] under it (the neighbor's splatter).
     * MURS, on 2.5 kHz, keeps HAM+'s step either side.
     */
    override fun gate(now: Double, pdb: DoubleArray, binHz: Double) {
        val p = params; val pl = plan; val wide = pl.raster >= 12_500; val hold = if (wide) 0 else 1; val margin = if (wide) ADJ_DB else 0.0
        for (o in opens.values.toList()) {
            var best = -99.0
            for (d in -hold..hold) { val j = o.k + d; if (j in 0 until count) best = max(best, snr[j].toDouble()) }
            o.snr = best; o.peak = max(o.peak, best)
            if (best > p.thresholdDb - 3) o.quietMs = 0.0
            else if (o.quietMs == 0.0) o.quietMs = now
            else if (now - o.quietMs >= CLOSE_HOLD_MS) close(o, o.quietMs)
        }
        for (k in 0 until count) {
            if (snr[k] <= p.thresholdDb || !hamBand[k] || abs(hzOf(k) - centerHz) < 6_000) continue
            var peak = true
            for (d in -pl.peakSteps..pl.peakSteps) { val j = k + d; if (d != 0 && j in 0 until count && power[j] > power[k] + margin) { peak = false; break } }
            if (!peak || opens.values.any { abs(it.k - k) <= pl.clearSteps }) continue
            openAt(k, now)
        }
    }

    /** A keyup no voice was heard on is kept when it carried signaling or a Morse callsign: an ID, a data burst. */
    override fun steadyClosed(o: WatchOpen<Probe>, endMs: Double) {
        val p = o.probe ?: return
        if (o.flood || ownSpur(o.hz)) return
        p.end()
        if (p.ident()?.signaling.isNullOrEmpty() && idCalls(p.cwId().ifEmpty { p.cw0 }).isEmpty()) return
        o.talk = true
        close(o, endMs)
    }

    override fun closed(o: WatchOpen<Probe>, t: TxRec) {
        keys.add(KeyRec(t.id, t.hz, t.startMs, t.endMs, t.tone, t.dcs))
        if (keys.size > KEEP_KEYS) keys.removeAt(0)
        val s = seen.getOrPut(t.hz) { Seen() }
        s.lastMs = t.endMs; s.txs++; if (t.tone != 0.0 || t.dcs != 0) { s.tone = t.tone; s.dcs = t.dcs }
        s.data = dataLines(t.ident).isNotEmpty()
        for (c in idCalls(t.cw)) {
            s.call = c.call
            val k = calls[c.call]
            if (k != null) { k.count++; k.lastMs = t.endMs; k.hz = t.hz } else calls[c.call] = GmrsCall(c.call, c.gmrs, t.hz, t.startMs, t.endMs, 1)
        }
    }

    /** Keyups finished and on the air now, oldest first. */
    private fun allKeys(): List<KeyRec> = keys + opens.values.filter { counted(it) }.map { o -> KeyRec(o.id, o.hz, o.startMs, 0.0, o.probe?.tone() ?: 0.0, o.probe?.dcs() ?: 0) }

    /**
     * Repeater keyups by keyup id: an input keyup and the output keyup that starts within [PAIR_START_MS] of it and
     * overlaps it are one, both ids naming it. An input keyed alone is a repeater keyup whose output was not heard.
     */
    fun repeaterKeys(): Map<Int, GmrsRpt> = synchronized(lock) { repeaterKeysLocked() }
    private fun repeaterKeysLocked(): Map<Int, GmrsRpt> {
        val all = allKeys(); val out = HashMap<Int, GmrsRpt>()
        for (r in all) {
            val c = gmrsChan(r.hz) ?: continue
            if (c.kind != GmrsKind.INPUT) continue
            val o = all.firstOrNull { x -> abs(x.hz - c.outHz) < 1_000 && abs(x.startMs - r.startMs) <= PAIR_START_MS && (x.endMs == 0.0 || x.endMs >= r.startMs) && (r.endMs == 0.0 || r.endMs >= x.startMs) }
            val p = GmrsRpt(c.outHz, c.hz, r.tone, r.dcs, o?.tone ?: 0.0, o?.dcs ?: 0, true, o != null)
            out[r.id] = p
            if (o != null) out[o.id] = p
        }
        return out
    }

    /** Every channel of this band as the board shows it. */
    private fun chans(now: Double): List<GmrsChanState> {
        val half = plan.spanHalf(rate)
        return channelsOf(band).map { c ->
            val all = opens.values.filter { abs(it.hz - c.hz) < 1_000 }; val o = all.firstOrNull { counted(it) }; val s = seen[c.hz]
            val steady = o == null && all.any { !it.talk && now - it.startMs >= STEADY_SHOW_MS }
            val lt = o?.probe?.tone() ?: 0.0; val ld = o?.probe?.dcs() ?: 0
            val live = lt != 0.0 || ld != 0
            GmrsChanState(c.id, c.hz, chanKey(c.hz), c.kind, gmrsName(c), rate > 0 && abs(c.hz - centerHz) <= half,
                o != null, steady, if (live) lt else s?.tone ?: 0.0, if (live) ld else s?.dcs ?: 0,
                if (o != null) now else s?.lastMs ?: 0.0, (s?.txs ?: 0) + (if (o != null) 1 else 0), s?.call ?: "", s?.data ?: false)
        }
    }

    override fun clear() { synchronized(lock) { keys.clear(); seen.clear(); calls.clear() }; super.clear() }

    override fun snapshotLocked(now: Double): HpSnap {
        val s = super.snapshotLocked(now)
        return GmrsSnap(s, band, chans(now), calls.values.map { it.copy() }.sortedByDescending { it.lastMs }, repeaterKeysLocked())
    }

    /** The whole picture now, with the band's channels. */
    fun gmrsSnapshot(): GmrsSnap = snapshot() as GmrsSnap
}
