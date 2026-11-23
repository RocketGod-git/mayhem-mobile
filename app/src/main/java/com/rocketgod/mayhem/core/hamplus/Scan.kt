package com.rocketgod.mayhem.core.hamplus

import com.rocketgod.mayhem.core.fleet.AUTO_SURVEY_MS
import com.rocketgod.mayhem.core.fleet.AutoView
import com.rocketgod.mayhem.core.fleet.FleetAuto
import kotlin.math.abs
import kotlin.math.roundToLong

/*
 * HAM+ scan around [FleetAuto]: AUTO and SCAN respect what is on the air. Mirrors web scan.ts.
 *  - Never a retune while a channel in the window is on the air: a transmission and its recording run to their end.
 *  - After the last transmission in the window ends it stays a hang time, so the next reply is caught. The hang is
 *    learned per window from the gaps between keyups on the same channel (twice the median gap, 8 to 45 s), 15 s until
 *    there are three gaps. Every keyup starts it again.
 *  - Past the hang, while the conversation is recent, it looks around: a short look at another window, and straight
 *    back to the conversation's window when that one is quiet, then a hang there again before the next look.
 *  - When the conversation is long over, AUTO and SCAN go on as they always did.
 *  - A followed channel pins its window outright (tuned there first when it is elsewhere), with no looks. Unfollowing
 *    goes back to the window the scan was on and the scan carries on from there as it was.
 *  - KEEP SCANNING ([HpScan.skip]) leaves a busy window at once; that window waits [HP_SKIP_MS] before AUTO comes back
 *    to it, unless a followed or priority channel is in it.
 * Data channels (APRS) and muted channels hold nothing.
 */

/** The hang before there is data, its bounds, and gaps longer than this are not one conversation. */
const val HP_HANG_MS = 15_000L
const val HP_HANG_MIN_MS = 8_000L
const val HP_HANG_MAX_MS = 45_000L
const val HP_GAP_MAX_MS = 60_000L
/** How long after its last transmission a conversation is still waited for, between looks. */
const val HP_CONVO_MS = 90_000L
/** A look at another window while a conversation is waited for. */
const val HP_LOOK_MS = 5_000L
/** A window left with KEEP SCANNING is not come back to for this long. */
const val HP_SKIP_MS = 120_000L

/** One transmission as the scan sees it: the snapshot's rows. */
data class HpAct(val id: Int, val hz: Long, val startMs: Long, val endMs: Long, val live: Boolean)

/** Whether the window centered on [center] hears [hz] with [rate] samples a second: inside 0.44 of the rate less a channel, clear of the center's DC spike. */
fun hpWindowHears(center: Long, rate: Double, hz: Long): Boolean {
    val d = abs(hz - center).toDouble()
    return d <= rate * 0.44 - 6_250 - HP_RASTER && d >= 6_000.0 + HP_RASTER
}

/** The window of [centers] (Hz) that hears [hz]: [cur] when it does, else the nearest that does, else -1. */
fun hpWindowOf(centers: List<Long>, rate: Double, hz: Long, cur: Int): Int {
    if (hz <= 0) return -1
    if (cur in centers.indices && hpWindowHears(centers[cur], rate, hz)) return cur
    var best = -1; var bd = Long.MAX_VALUE
    for (i in centers.indices) if (hpWindowHears(centers[i], rate, hz)) { val d = abs(hz - centers[i]); if (d < bd) { bd = d; best = i } }
    return best
}

/** 146.52 as 146.520, 442.0125 as 442.0125. */
private fun mhz(hz: Long): String { val s = "%.4f".format(java.util.Locale.US, hz / 1e6); return if (s.endsWith("0")) s.dropLast(1) else s }

/**
 * What the head line says the scan is doing: [n] windows, AUTO or one band, AUTO's mode, the window and the seconds
 * left in its turn; and the HAM+ scan's own [phase] (following, staying for a conversation, a look away) with its
 * channel and the seconds left in it.
 */
fun hpScanText(n: Int, autoBand: Boolean, mode: String, idx: Int, left: Long, phase: String = "", hz: Long = 0, phaseLeft: Long = 0): String {
    if (n < 2) return "WHOLE BAND"
    val a = if (autoBand) "AUTO" else "SCAN"
    when (phase) {
        "follow" -> return "FOLLOWING ${mhz(hz)} · $a PAUSED"
        "live" -> return "$a · STAYING FOR THE CONVERSATION ON ${mhz(hz)}"
        "hang", "home" -> return "$a · STAYING FOR THE CONVERSATION ON ${mhz(hz)} · $phaseLeft s"
        "look" -> return "$a · LOOKING AROUND · BACK IN $phaseLeft s"
    }
    return when (mode) {
        "hold" -> "$a · HOLDING WHERE THE VOICE IS"
        "survey" -> "$a · FIRST PASS · ${idx + 1}/$n · NEXT $left s"
        "look" -> "$a · LOOKING AROUND · BACK IN $left s"
        else -> "${if (autoBand) "AUTO SCAN" else "SCAN"} · ${idx + 1}/$n · NEXT $left s"
    }
}

/** The AUTO control's label: RESUME SCAN while a channel is followed, KEEP SCANNING while the scan stays for traffic, else AUTO. */
fun hpAutoLabel(n: Int, phase: String): String = when {
    n < 2 -> "AUTO"
    phase == "follow" -> "RESUME SCAN"
    phase == "live" || phase == "hang" || phase == "home" -> "KEEP SCANNING"
    else -> "AUTO"
}
val HP_AUTO_LABELS = listOf("AUTO", "KEEP SCANNING", "RESUME SCAN")

private fun chanOf(hz: Long): Long = (hz / 5_000.0).roundToLong()
private fun median(a: Collection<Long>): Double { val s = a.sorted(); val m = s.size / 2; return if (s.size % 2 == 1) s[m].toDouble() else (s[m - 1] + s[m]) / 2.0 }

class HpScan {
    /** The followed frequency the scan is paused for, or 0. */
    @Volatile var follow = 0L
        private set
    /** "" (AUTO's own), "follow", "live" (a channel on the air), "hang", "home" (waiting at the conversation's window between looks), "look". */
    @Volatile var phase = ""
        private set
    /** The channel the phase is about (the followed one, the one on the air, the conversation's). */
    @Volatile var hz = 0L
        private set
    /** When the phase's wait ends (the hang, the wait between looks, the look), 0 when it has none. */
    @Volatile var until = 0L
        private set
    private var home = -1; private var homeHz = 0L; private var homeUntil = 0L; private var waitUntil = 0L; private var lookUntil = 0L; private var lookIdx = -1; private var scanUntil = 0L
    /** Which window each transmission was heard on (-1: none that counts), the ones whose end is counted, each window's channels' last ends and gaps, the windows left with KEEP SCANNING. */
    private val win = LinkedHashMap<Int, Int>()
    private val ended = HashSet<Int>()
    private val lastEnd = HashMap<Int, HashMap<Long, Long>>()
    private val gaps = HashMap<Int, ArrayDeque<Long>>()
    private val cool = HashMap<Int, Long>()
    /** The channels busy on a window left with KEEP SCANNING, and until when they hold nothing (a neighbor window hears them too). */
    private var skipped = listOf<Pair<Long, Long>>()

    /** The window's hang: twice the median gap between keyups heard there, 8 to 45 s; 15 s until three gaps are known. */
    fun hang(w: Int): Long {
        val g = gaps[w]
        return if (g != null && g.size >= 3) (2 * median(g)).roundToLong().coerceIn(HP_HANG_MIN_MS, HP_HANG_MAX_MS) else HP_HANG_MS
    }
    /** The scan is staying for traffic, so KEEP SCANNING can move it on. */
    val busy: Boolean get() = phase == "live" || phase == "hang" || phase == "home"
    fun cooled(w: Int, now: Long): Boolean = (cool[w] ?: 0L) > now

    /** Each new transmission is put on the window tuned, and each keyup's gap since the last end on its channel is learned. */
    private fun learn(rows: List<HpAct>, centers: List<Long>, rate: Double, idx: Int, p: HpPrefs) {
        fun quiet(r: HpAct) = planInfo(r.hz).use == "data" || p.mute.any { abs((it.toLongOrNull() ?: 0L) - r.hz) < 1_250 } || skipped.any { r.startMs < it.second && abs(it.first - r.hz) <= 2_500 }
        val fresh = rows.filter { it.id !in win || (!it.live && it.id !in ended) }.sortedBy { it.startMs }
        for (r in fresh) {
            if (r.id !in win) {
                if (idx !in centers.indices || !hpWindowHears(centers[idx], rate, r.hz) || quiet(r)) { win[r.id] = -1; ended.add(r.id); continue }
                win[r.id] = idx
                val le = lastEnd[idx]?.get(chanOf(r.hz))
                if (le != null && r.startMs > le && r.startMs - le < HP_GAP_MAX_MS) {
                    val g = gaps.getOrPut(idx) { ArrayDeque() }; g.addLast(r.startMs - le); if (g.size > 20) g.removeFirst()
                }
            }
            val w = win[r.id] ?: -1
            if (!r.live && ended.add(r.id) && w >= 0) {
                val m = lastEnd.getOrPut(w) { HashMap() }; m[chanOf(r.hz)] = maxOf(m[chanOf(r.hz)] ?: 0L, r.endMs)
            }
        }
        if (win.size > 3_000) win.keys.take(1_000).forEach { win.remove(it); ended.remove(it) }
    }

    /** The next window after [from] that is not [skip] and not waiting out KEEP SCANNING, or -1. */
    private fun next(n: Int, from: Int, skip: Int, now: Long): Int {
        for (k in 1..n) { val i = ((from + k) % n + n) % n; if (i != skip && !cooled(i, now)) return i }
        return -1
    }

    /**
     * One look every half second: the window to tune to, or null to stay. [rows] are the snapshot's transmissions,
     * [idx] the window tuned, [p] the channel preferences (hold is the followed channel's key, "" for ALL).
     */
    fun step(auto: FleetAuto, v: AutoView, rows: List<HpAct>, centers: List<Long>, rate: Double, idx: Int, p: HpPrefs): Int? {
        val now = v.now; val n = centers.size
        learn(rows, centers, rate, idx, p)
        val fhz = p.hold.toLongOrNull() ?: 0L
        val fw = if (fhz > 0) hpWindowOf(centers, rate, fhz, idx) else -1
        if (fw >= 0) { follow = fhz; phase = "follow"; hz = fhz; until = 0; home = -1; auto.pause(v); return if (fw != idx) fw else null }
        if (follow != 0L) {
            // the follow ended: back to the window the scan was on, where it goes on as it was
            follow = 0L; phase = ""; hz = 0; auto.pause(v)
            if (auto.idx != idx && auto.idx in 0 until n) return auto.idx
        }
        if (n < 2) { phase = ""; return auto.step(v) }
        val here = rows.filter { win[it.id] == idx }
        val live = here.filter { it.live }.maxByOrNull { it.startMs }
        if (live != null) {
            phase = "live"; hz = live.hz; until = 0
            home = idx; homeHz = live.hz; homeUntil = now + HP_CONVO_MS; waitUntil = 0; lookUntil = 0
            auto.stay(v); return null
        }
        val last = here.maxByOrNull { it.endMs }
        if (last != null && now - last.endMs < hang(idx)) {
            phase = "hang"; hz = last.hz; until = last.endMs + hang(idx)
            home = idx; homeHz = last.hz; homeUntil = last.endMs + HP_CONVO_MS; waitUntil = 0; lookUntil = 0
            auto.stay(v); return null
        }
        if (home in 0 until n && now < homeUntil && !cooled(home, now)) {
            val looking = lookUntil > 0 && now < lookUntil
            if (idx != home && !looking) {
                // a look found nothing: straight back to the conversation, and a hang there before the next look
                lookUntil = 0; waitUntil = now + hang(home)
                phase = "home"; hz = homeHz; until = waitUntil
                auto.moved(home, now); return home
            }
            if (idx != home) { phase = "look"; until = lookUntil; auto.stay(v); return null }
            if (waitUntil != 0L && now < waitUntil) { phase = "home"; hz = homeHz; until = waitUntil; auto.stay(v); return null }
            val nx = next(n, if (lookIdx >= 0) lookIdx else idx, idx, now)
            if (nx >= 0) {
                lookIdx = nx; lookUntil = now + HP_LOOK_MS; waitUntil = 0
                phase = "look"; until = lookUntil
                auto.moved(nx, now); return nx
            }
        }
        home = -1; lookUntil = 0; waitUntil = 0; phase = ""; hz = 0; until = 0
        var to = auto.step(v)
        if (to != null && cooled(to, now)) {
            // a window left with KEEP SCANNING waits out its time: the scan steps past it, a window a dwell
            to = null
            if (now >= scanUntil) { val nx = next(n, idx, idx, now); if (nx >= 0) { to = nx; scanUntil = now + AUTO_SURVEY_MS[0] } }
            auto.moved(to ?: idx, now)
        }
        return to
    }

    /**
     * KEEP SCANNING: off the busy window at once, to the next one. The window left waits [HP_SKIP_MS] before AUTO comes
     * back to it, unless a channel in [keep] (the followed and priority ones) is in it. A transmission open on it ends at
     * the retune and is kept like any other.
     */
    fun skip(auto: FleetAuto, now: Long, centers: List<Long>, rate: Double, idx: Int, keep: List<String>): Int? {
        val n = centers.size
        if (n < 2 || idx !in 0 until n) return null
        if (keep.none { k -> (k.toLongOrNull() ?: 0L).let { it > 0 && hpWindowHears(centers[idx], rate, it) } }) {
            cool[idx] = now + HP_SKIP_MS
            // what kept it busy keeps no neighbor window busy either
            val recent = (lastEnd[idx] ?: emptyMap<Long, Long>()).filter { now - it.value < HP_CONVO_MS }.keys.map { it * 5_000 }
            skipped = skipped.filter { it.second > now } + (listOf(hz) + recent).filter { it > 0 }.map { it to now + HP_SKIP_MS }
        }
        home = -1; lookUntil = 0; waitUntil = 0; phase = ""; hz = 0; until = 0
        val nx = next(n, idx, idx, now)
        if (nx < 0) return null
        scanUntil = now + AUTO_SURVEY_MS[0]
        auto.moved(nx, now)
        return nx
    }
}
