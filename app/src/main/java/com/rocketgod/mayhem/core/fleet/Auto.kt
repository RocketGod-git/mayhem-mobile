package com.rocketgod.mayhem.core.fleet

import kotlin.math.max
import kotlin.math.pow

/**
 * Dispatch AUTO: which window of which band the receiver listens to, driven every half second by the app.
 *
 * Each window keeps a score of the clear voice heard there: seconds of clear audio plus two for each clear call with a
 * talkgroup, over the seconds spent listening there (at least 20), both fading with a half-life of three minutes. So a
 * band is judged by how much clear voice it carries a minute, and a short look can show a busier one. Encrypted calls,
 * calls with no talkgroup and calls with no audio count for nothing, and so does a control channel by itself.
 *  - A fresh start surveys every window once (25 s where something decodes, 6 s where nothing does, a clear call heard
 *    to its end up to 40 s), with the scores held still, then holds the best window.
 *  - Scores are saved with the systems and come back decayed by their age: a reload with a known best window starts
 *    on it and skips the survey.
 *  - While holding, it steps away for a short look only when nothing clear has played for a while, and comes back.
 *    A window that has come to carry half again as much clear voice a minute as the held one takes over.
 *  - With no window scored after the survey it keeps stepping through them all.
 */
data class AutoCall(val key: String, val onAir: Boolean, val encrypted: Boolean, val tg: Int, val audioMs: Long)
data class AutoView(
    val now: Long, val calls: List<AutoCall>, val playing: String,
    /** A control or rest channel decoding in the span right now. */
    val controlLive: Boolean,
    /** Systems known (heard this session or kept from earlier ones). */
    val systems: Int,
)
/** Saved scores: what [FleetAuto.save] gives and the constructor takes back. */
data class AutoSaved(val scores: List<Double>, val listen: List<Double>?, val ms: Long)

const val AUTO_HALF_LIFE_MS = 180_000.0
/** A window holds the receiver once its score passes this (a few seconds of clear speech). */
const val AUTO_HOLD_SCORE = 3.0
/** Nothing clear for this long on the held window, and a look elsewhere is allowed. */
const val AUTO_QUIET_MS = 15_000L
/** A look at another window lasts this long (longer while clear speech plays there). */
const val AUTO_LOOK_MS = 6_000L
/** Survey dwell: where nothing decodes, where something does, and the most a clear call can keep it. */
val AUTO_SURVEY_MS = longArrayOf(6_000L, 25_000L, 40_000L)
/** A window takes over the held one when its score is this many times the held score. */
const val AUTO_SWITCH = 1.5
/** Listening time a window's density is taken over, at the least (seconds): a short look cannot look too good. */
const val AUTO_MIN_LISTEN_S = 20.0
/** Looks are this far apart: rarely once many systems are known. */
fun autoLookEvery(systems: Int): Long = if (systems >= 5) 300_000L else if (systems >= 2) 120_000L else 60_000L

class FleetAuto(val windows: Int, now: Long = 0, start: Int = 0, saved: AutoSaved? = null) {
    var idx = start
    /** Clear voice heard on each window (decayed seconds), and seconds spent listening there (decayed the same way). */
    val score = DoubleArray(windows); val listen = DoubleArray(windows)
    /** "survey" visits every window once, "scan" steps through them, "hold" stays on the best, "look" is a short visit away. */
    var mode = "survey"
    /** When the current window's turn ends (survey, scan) or the look ends. */
    var until = now + AUTO_SURVEY_MS[0]
    /** A control channel decoded, or clear voice was heard, on this window during its turn. */
    var found = false
    /** The window held, or -1. */
    var held = -1
    var lastClear = 0L; var lastLook = now
    private var lastMs = now; private var enter = now; private var lookIdx = -1
    private val surveyed = HashSet<Int>()
    private val seen = LinkedHashMap<String, Long>()
    private val counted = LinkedHashSet<String>()

    init {
        if (saved != null && saved.scores.size == windows) {
            val k = 0.5.pow(max(0L, now - saved.ms) / AUTO_HALF_LIFE_MS)
            for (i in 0 until windows) {
                score[i] = (saved.scores[i].takeIf { it.isFinite() } ?: 0.0) * k
                listen[i] = ((saved.listen?.getOrNull(i))?.takeIf { it.isFinite() && it != 0.0 } ?: AUTO_MIN_LISTEN_S) * k
            }
            val b = best()
            if (b >= 0) { mode = "hold"; held = b; idx = b }
        }
        if (windows < 2) mode = "hold"
    }
    /** The scores to keep with the systems. */
    fun save(now: Long): AutoSaved = AutoSaved(score.map { Math.round(it * 100) / 100.0 }, listen.map { Math.round(it * 100) / 100.0 }, now)
    /** Clear voice a second of listening on a window. */
    fun density(i: Int): Double = score[i] / max(listen[i], AUTO_MIN_LISTEN_S)
    /** The window with the most clear voice a minute among those that have earned the receiver, or -1. */
    fun best(): Int { var b = -1; var v = -1.0; for (i in 0 until windows) if (score[i] >= AUTO_HOLD_SCORE && density(i) > v) { v = density(i); b = i }; return b }
    /** The window to hold: the one held, unless another has come to score [AUTO_SWITCH] times as much. */
    private fun choose(): Int {
        val b = best()
        if (held < 0 || score[held] < AUTO_HOLD_SCORE) return b
        return if (b >= 0 && b != held && density(b) >= AUTO_SWITCH * density(held)) b else held
    }
    /** Something clear is being heard now. */
    fun clearPlaying(v: AutoView): Boolean = v.calls.any { it.key == v.playing && it.onAir && !it.encrypted }
    /** The receiver was tuned to a window from outside (a band picked, a lock, a visit back): AUTO goes on from it. */
    fun moved(idx: Int, now: Long) {
        this.idx = idx; enter = now; found = false; until = now + AUTO_SURVEY_MS[0]
        if (mode == "look" || mode == "scan") mode = if (held >= 0) "hold" else "scan"
    }
    /** One look at the state: the window to tune to, or null to stay. */
    fun step(v: AutoView): Int? {
        val now = v.now; val dt = max(0L, now - lastMs); lastMs = now
        // the survey compares windows heard one after another: their scores stand still until it is done
        if (dt > 0 && mode != "survey") { val k = 0.5.pow(dt / AUTO_HALF_LIFE_MS); for (i in 0 until windows) { score[i] *= k; listen[i] *= k } }
        listen[idx] += dt / 1000.0
        var gained = false
        for (c in v.calls) {
            if (c.encrypted || c.tg == 0 || c.audioMs <= 0) continue
            val was = seen[c.key] ?: 0L
            if (c.audioMs > was) { score[idx] += (c.audioMs - was) / 1000.0; seen[c.key] = c.audioMs; gained = true }
            if (counted.add(c.key)) score[idx] += 2
        }
        if (seen.size > 400) seen.keys.take(200).forEach { seen.remove(it) }
        if (counted.size > 400) counted.take(200).forEach { counted.remove(it) }
        val clear = clearPlaying(v)
        if (clear) lastClear = now
        if (windows < 2) return null
        fun go(i: Int): Int? { enter = now; found = false; if (i == idx) return null; idx = i; return i }
        if (mode == "survey") {
            if ((v.controlLive || gained) && !found) { found = true; until = max(until, enter + AUTO_SURVEY_MS[1]) }
            if (clear) until = minOf(max(until, now + 1_000), enter + AUTO_SURVEY_MS[2])
            if (now < until) return null
            surveyed.add(idx)
            val next = (0 until windows).map { (idx + 1 + it) % windows }.firstOrNull { it !in surveyed }
            if (next != null) { until = now + AUTO_SURVEY_MS[0]; return go(next) }
            lastLook = now
            held = best()
            if (held >= 0) { mode = "hold"; return go(held) }
            mode = "scan"; until = now + AUTO_SURVEY_MS[0]
            return go((idx + 1) % windows)
        }
        if (mode == "look") {
            if (clear) { until = max(until, now + 1_000); return null }
            if (now < until) return null
            mode = "hold"; lastLook = now
            val b = choose(); if (b >= 0) held = b
            return if (held >= 0) go(held) else null
        }
        val want = choose()
        if (want >= 0) {
            mode = "hold"
            if (idx != want) {
                // the call being heard finishes first
                if (clear) return null
                held = want; return go(want)
            }
            held = want
            if (!clear && now - lastClear > AUTO_QUIET_MS && now - lastLook > autoLookEvery(v.systems)) {
                val others = (0 until windows).filter { it != want }
                // round the band list, one window a look
                val next = others.firstOrNull { it > lookIdx } ?: others[0]
                lookIdx = next; mode = "look"; until = now + AUTO_LOOK_MS
                return go(next)
            }
            return null
        }
        // nothing earned: step through the windows, a control channel keeps one for 25 s, a clear call to its end
        mode = "scan"
        if (v.controlLive && !found) { found = true; until = max(until, now + 25_000) }
        if (clear) until = max(until, now + 1_000)
        if (now < until) return null
        until = now + AUTO_SURVEY_MS[0]
        return go((idx + 1) % windows)
    }
}
