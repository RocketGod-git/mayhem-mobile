package com.rocketgod.mayhem.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Hunting live voice. Not a bookmark scanner: there is no list. It watches whatever the receiver can see, lands on
 * anything new that might be somebody talking, checks that it really is, listens until the conversation stops, and
 * moves on. Broadcast stations and permanent carriers are what it works hardest to avoid, because they are strong,
 * always there, and would otherwise capture it forever.
 */
object Prowl {
    data class Range(val lo: Double, val hi: Double, val mode: SdrEngine.Mode, val name: String)
    val HUNT = listOf(
        Range(118e6, 137e6, SdrEngine.Mode.AM, "airband"),
        Range(144e6, 148e6, SdrEngine.Mode.NFM, "2 m ham"),
        Range(150e6, 174e6, SdrEngine.Mode.NFM, "VHF business"),
        Range(420e6, 470e6, SdrEngine.Mode.NFM, "UHF"),
        Range(851e6, 869e6, SdrEngine.Mode.NFM, "800 public safety"),
    )
    val SPANS = listOf("2 MHz" to 2_000_000, "8 MHz" to 8_000_000, "20 MHz" to 20_000_000)

    // The quiet timeout has to outlast the test, or a channel is dropped before it can be judged and the log fills
    // with things that were never actually listened to.
    private const val HANG = 3500L          // quiet this long and the over is finished
    private const val TEST = 2400L          // listen this long before deciding it really is speech
    private const val SETTLE = 1500L        // a signal must hold this long before it is worth stopping for
    private const val IDLE = 25_000L        // an empty span this long before moving, only when sweeping is on
    private const val MAX = 180_000L        // never sit on one channel longer than this
    private const val SKIP = 240_000L       // how long a rejected channel is left alone
    private const val CONST = 45_000L       // up this long without a break: a link or a beacon, not a conversation
    const val VOICE = 0.45                  // speech score needed to stay

    private class Track(var hz: Double, var first: Long, var last: Long, var best: Double, var hits: Int, var skipUntil: Long, var why: String)
    data class Hit(val at: Long, val hz: Double, val mode: SdrEngine.Mode, val cls: String, val secs: Double, val score: Double,
                   val db: Double, val band: String, val kept: Boolean, val why: String)
    data class Target(val hz: Double, val bw: Double, val cls: String, val at: Long, var lastLive: Long, var lastSeen: Long,
                      var judged: Boolean, var peak: Double, val band: String)
    data class View(
        val on: Boolean = false, val target: Target? = null, val held: Double? = null, val note: String = "",
        val seen: Int = 0, val ready: Int = 0, val remembered: Int = 0, val sweep: Boolean = false, val band: String = "",
        val score: Double = 0.0, val best: Double = 0.0, val parts: String = "", val log: List<Hit> = emptyList(),
        val span: Int = 2_000_000, val dwellS: Int = 0,
    )

    private val _view = MutableStateFlow(View())
    val view: StateFlow<View> = _view.asStateFlow()

    private var on = false
    private var target: Target? = null
    private var held: Double? = null
    private val tracks = HashMap<Long, Track>()
    private val log = ArrayList<Hit>()
    private var note = ""
    private var band = ""
    private var win = -1
    private var movedAt = 0L
    private var score = 0.0
    private var best = 0.0
    private var parts = ""
    private var sweep = false
    private var seen = 0
    private var ready = 0
    private var span = 2_000_000
    private var lastLo = 0L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var job: Job? = null

    private fun clock() = System.nanoTime() / 1_000_000
    private fun key(hz: Double) = (hz / 5000).roundToLong()
    fun mhz(hz: Double): String = "%.4f".format(hz / 1e6).trimEnd('0').trimEnd('.')

    /** Takes the receiver: back where the last visit left it, or the first window of the 2 m band. */
    @Synchronized fun open() {
        val keep = target != null || held != null
        val lo = when {
            lastLo != 0L -> lastLo
            HUNT.any { SdrEngine.radioFreqHz in it.lo.toLong()..it.hi.toLong() } -> SdrEngine.radioFreqHz
            else -> windows().first { it.third == "2 m ham" }.first
        }
        val off = SdrEngine.offsetHz.value
        SdrEngine.configure(modeAt(lo.toDouble()), lo, span, 24, 24, false, null)
        if (keep) SdrEngine.setOffset(off)
        lastLo = lo
        publish()
    }

    @Synchronized fun start() {
        on = true
        if (SdrEngine.squelchDb.value == 0) SdrEngine.setSquelch(9)
        held = null
        movedAt = clock()                         // work the span it is already on, do not jump away
        if (job == null) job = scope.launch {
            while (isActive) {
                // A hunt that dies quietly looks exactly like one that has found nothing, so failures are shown.
                try { step() } catch (e: Exception) { synchronized(this@Prowl) { note = "hunt stopped: ${e.message}" }; stop() }
                delay(250)
            }
        }
        publish()
    }

    /** Stops hunting without forgetting what it heard. */
    @Synchronized fun stop() {
        on = false
        job?.cancel(); job = null
        if (target != null) release(clock(), false, "stopped by hand")
        SdrEngine.listenForVoice(false)
        publish()
    }

    @Synchronized fun skip() {
        val now = clock()
        val t = target
        if (t != null) { skipTrack(t.hz, "skipped by hand", now); release(now, false) } else move(now)
        publish()
    }

    @Synchronized fun toggleSweep() { sweep = !sweep; movedAt = clock(); publish() }
    @Synchronized fun clearLog() { log.clear(); publish() }
    @Synchronized fun removeHit(h: Hit) { log.remove(h); publish() }

    @Synchronized fun setSpan(hz: Int) {
        span = hz
        SdrEngine.setRate(hz)
        val t = target ?: return publish()
        if (abs(t.hz - SdrEngine.freqHz.value) > hz / 2 - 60_000) listenAt(t.hz)
        publish()
    }

    /**
     * Stay on something and keep listening there. The hunt pauses rather than ending, so nothing will move the
     * receiver again until HUNT is pressed.
     */
    @Synchronized fun holdAt(hz: Double, mode: SdrEngine.Mode = modeAt(hz)) {
        stop()
        held = hz
        SdrEngine.setMode(mode)
        listenAt(hz)
        note = "holding ${mhz(hz)} · press HUNT to carry on looking"
        publish()
    }

    /** The channel being listened to: LO plus the demodulator's offset. */
    fun channelHz(): Long = SdrEngine.freqHz.value + SdrEngine.offsetHz.value

    private fun modeAt(hz: Double) = if (hz > 117e6 && hz < 138e6) SdrEngine.Mode.AM else SdrEngine.Mode.NFM

    /** Listen off-centre when the channel is in view; otherwise move the LO a quarter span away so DC stays clear. */
    private fun listenAt(hz: Double) {
        val lo = SdrEngine.freqHz.value
        val rate = SdrEngine.rateHz.value
        if (abs(hz - lo) < rate / 2 - 60_000 && abs(hz - lo) > 5_000) SdrEngine.setOffset((hz - lo).roundToInt())
        else {
            val nlo = (hz - rate / 4).roundToLong()
            SdrEngine.tune(nlo); lastLo = nlo
            SdrEngine.setOffset(rate / 4)
        }
    }

    private fun windows(): List<Triple<Long, SdrEngine.Mode, String>> {
        val w = max(1e6, span - 400_000.0)                // keep signals away from the edges of the span
        val out = ArrayList<Triple<Long, SdrEngine.Mode, String>>()
        for (h in HUNT) {
            val n = max(1, ceil((h.hi - h.lo) / w).toInt()); val st = (h.hi - h.lo) / n
            for (k in 0 until n) out.add(Triple((h.lo + st * (k + 0.5)).roundToLong(), h.mode, h.name))
        }
        return out
    }

    /**
     * Could this be a voice channel? Anything you can pick out on the waterfall by eye gets a try, so this only
     * refuses what is definitely not a conversation: the broadcast band, anything far too wide, anything in the noise.
     */
    private fun worthy(s: Signal): Boolean {
        if (s.hz > 87.4e6 && s.hz < 108.1e6) return false
        if (s.bw6 > 60_000) return false
        if (s.snr < 10) return false
        if (s.cls == "WFM" || s.cls == "WIDE") return false
        return true
    }

    private fun skipTrack(hz: Double, why: String, now: Long, forMs: Long = SKIP) {
        tracks[key(hz)]?.let { it.skipUntil = now + forMs; it.why = why }
    }

    @Synchronized private fun step() {
        if (!on) return
        val now = clock()
        val signals = SdrEngine.signals.value
        SdrEngine.voice.value?.let { v ->
            if (target != null) {
                score = v.score
                if (score > best) best = score          // speech has pauses, so judge on its best moment
                parts = "band %.2f · rhythm %.3f · swing %.1f dB · level %.0f dB".format(v.band, v.mod, v.vary, v.levelDb)
            }
        }
        for (s in signals) {
            if (!worthy(s)) continue
            val k = key(s.hz)
            var t = tracks[k]
            // A signal that comes and goes starts counting again: a peak that flickers for one frame is noise.
            if (t == null || now - t.last > 1500) t = Track(s.hz, now, now, s.snr, 0, t?.skipUntil ?: 0L, t?.why ?: "")
            t.last = now; t.hz = s.hz; t.hits++; if (s.snr > t.best) t.best = s.snr
            if (now - t.first > CONST && now > t.skipUntil) {
                t.skipUntil = now + SKIP; t.why = "always on"
                if (target?.hz != t.hz) note = "${mhz(t.hz)} has been up ${(now - t.first) / 1000}s without a break, leaving it"
            }
            tracks[k] = t
        }
        if (tracks.size > 300) tracks.entries.removeAll { now - it.value.last > 120_000 && now > it.value.skipUntil }

        seen = 0; ready = 0
        for (tr in tracks.values) {
            if (now - tr.last > 800) continue
            seen++
            if (now >= tr.skipUntil) ready++
        }
        if (target != null) { hold(now, signals); publish(); return }
        val pick = pick(now)
        if (pick != null) { land(pick, now, signals); publish(); return }
        // Working the span it is on. Wandering off it is opt-in, because the thing you can see is usually right here.
        if (sweep && now - movedAt > IDLE) { move(now); publish(); return }
        note = if (seen > 0) "$seen signals in view, $ready still worth a try" else "nothing in the span right now"
        publish()
    }

    private fun pick(now: Long): Track? {
        var best: Track? = null; var bestVal = -1e9
        for (t in tracks.values) {
            if (now < t.skipUntil) continue                        // still serving a skip
            if (now - t.last > 800) continue                       // must be on the air right now
            if (now - t.first < SETTLE || t.hits < 5) continue     // and must have held, not just flickered
            val v = t.best + if (now - t.first < 20_000) 12 else 0  // something that just started beats something lingering
            if (v > bestVal) { bestVal = v; best = t }
        }
        return best
    }

    private fun land(t: Track, now: Long, signals: List<Signal>) {
        val sig = signals.firstOrNull { key(it.hz) == key(t.hz) }
        val mode = modeAt(t.hz)
        if (SdrEngine.mode.value != mode) SdrEngine.setMode(mode)
        listenAt(t.hz)
        target = Target(t.hz, sig?.bw6 ?: 12_500.0, sig?.cls ?: "", now, now, now, false, t.best, band)
        score = 0.0; best = 0.0; parts = ""
        SdrEngine.listenForVoice(true)
        note = "${mhz(t.hz)} $mode at ${t.best.roundToInt()} dB, listening"
    }

    private fun hold(now: Long, signals: List<Signal>) {
        val t = target ?: return
        val sig = signals.firstOrNull { abs(it.hz - t.hz) < max(7000.0, t.bw) }
        if (sig != null && sig.snr > 7) { t.lastLive = now; t.lastSeen = now; if (sig.snr > t.peak) t.peak = sig.snr }
        // An open squelch keeps a weak over alive between sightings, but cannot hold the receiver on its own: a squelch
        // stuck open on noise would otherwise end the hunt for good.
        else if (SdrEngine.squelchOpen.value && SdrEngine.squelchDb.value > 0 && now - t.lastSeen < 4000) t.lastLive = now
        val dwell = now - t.at
        if (!t.judged && dwell > TEST) {
            t.judged = true
            if (best < VOICE) {
                skipTrack(t.hz, "not speech", now)
                note = "${mhz(t.hz)} scored ${"%.2f".format(best)} for speech, leaving it · $parts"
                release(now, false, "not speech")
                return
            }
            note = "${mhz(t.hz)} speech ${"%.2f".format(best)}, holding · $parts"
        }
        if (now - t.lastLive > HANG || dwell > MAX) release(now, t.judged && best >= VOICE, if (t.judged) "" else "gone before it could be judged")
    }

    /**
     * Lets a channel go. Everything it stopped on is written down, kept or not, with the reason: a log of only the
     * successes gives no way to tell a quiet band from a speech test set too strictly.
     */
    private fun release(now: Long, kept: Boolean, why: String = "") {
        val t = target
        target = null; movedAt = now
        SdrEngine.listenForVoice(false)
        if (t == null) return
        val secs = (now - t.at) / 1000.0
        if (!t.judged) {
            // Gone before there was enough audio to judge: not a finding, so not written down, just left alone a while.
            skipTrack(t.hz, "went away before it could be judged", now, 45_000)
            note = "${mhz(t.hz)} went before it could be judged"
        } else if (secs > 0.8) {
            log.add(0, Hit(System.currentTimeMillis(), t.hz, SdrEngine.mode.value, t.cls, secs, best, t.peak, t.band, kept, why))
            while (log.size > 200) log.removeAt(log.size - 1)
            if (kept) note = "${mhz(t.hz)} finished after ${secs.roundToInt()}s"
        }
    }

    private fun move(now: Long) {
        val wins = windows()
        win = (win + 1) % wins.size
        val (centre, mode, name) = wins[win]
        band = name; movedAt = now
        SdrEngine.tune(centre); SdrEngine.setOffset(0); lastLo = centre
        if (SdrEngine.mode.value != mode) SdrEngine.setMode(mode)
        note = "sweeping $name around ${mhz(centre.toDouble())}"
    }

    private fun publish() {
        val t = target
        _view.value = View(on, t?.copy(), held, note, seen, ready, tracks.size, sweep, band, score, best, parts, log.toList(), span,
            if (t != null) ((clock() - t.at) / 1000).toInt() else 0)
    }
}
