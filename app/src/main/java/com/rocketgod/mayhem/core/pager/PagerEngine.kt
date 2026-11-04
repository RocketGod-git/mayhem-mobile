package com.rocketgod.mayhem.core.pager

import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.Diag
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.ln
import kotlin.math.roundToLong

/** A page as the feed shows it: the decoder's page plus when, on what frequency, and whether it reads like a call-out. */
data class PagerMessage(val id: Long, val at: Long, val hz: Long, val page: PagerPage, val alert: Boolean)

/**
 * The SDR tool's PAGERS tab. It hunts on its own: surveys every pager window (a 2 MHz slice around each band where
 * FLEX and POCSAG live), finds the carriers in each from the spectrum, settles on the busiest window, and decodes up
 * to [SLOTS] of its strongest carriers at once. A carrier that never produces a sync gives its slot to the next
 * one; a window where nothing decodes is left for the next busiest; when nothing anywhere decodes, it surveys again.
 * Runs on the SDR's DSP thread ([onIq] / [onFft]); the UI reads the flows and can pin a window.
 */
object PagerEngine {
    /** The band plan being hunted — a region's windows. Defaults to the device locale; the UI can override it. */
    @Volatile var region: PagerRegions.Region = PagerRegions.auto()
        private set
    fun setRegion(r: PagerRegions.Region) { if (r.id != region.id) { region = r; restartAsked = true } }
    private val wins get() = region.windows
    const val SLOTS = 4

    data class Chan(val hz: Long, val snrDb: Float, val listening: Boolean, val protocol: String, val rate: String,
                    val pages: Int, val lastSyncAt: Long)
    data class WinStat(val index: Int, val label: String, val carriers: Int, val bestDb: Float, val surveyed: Boolean)
    data class Status(val text: String, val scanning: Boolean, val window: Int, val pinned: Int?)

    private val _status = MutableStateFlow(Status("Waiting for the SDR", true, -1, null))
    val status: StateFlow<Status> = _status.asStateFlow()
    private val _channels = MutableStateFlow<List<Chan>>(emptyList())
    val channels: StateFlow<List<Chan>> = _channels.asStateFlow()
    private val _windows = MutableStateFlow(wins.mapIndexed { i, w -> WinStat(i, w.label, 0, 0f, false) })
    val windows: StateFlow<List<WinStat>> = _windows.asStateFlow()
    private val _messages = MutableStateFlow<List<PagerMessage>>(emptyList())
    val messages: StateFlow<List<PagerMessage>> = _messages.asStateFlow()
    private val _capcodes = MutableStateFlow(0)
    val capcodes: StateFlow<Int> = _capcodes.asStateFlow()

    /** The speaker (off until the user turns it on): plays [listenHz] if it's decoding, else the channel that synced last. */
    private val _speaker = MutableStateFlow(false)
    val speaker: StateFlow<Boolean> = _speaker.asStateFlow()
    fun setSpeaker(on: Boolean) { _speaker.value = on; if (!on) PagerAudio.release() }
    /** Set from the UI: the channel chip in focus, or null. */
    @Volatile var listenHz: Long? = null
    @Volatile private var heard: Slot? = null

    /** Set from the UI: a window to stay on, or null to hunt. */
    @Volatile private var pin: Int? = null
    @Volatile private var running = false
    @Volatile private var restartAsked = false

    private const val SETTLE_MS = 350L
    private const val SURVEY_MS = 2500L
    private const val TRIAL_MS = 20_000L       // a carrier gets this long to show a sync
    private const val RETRY_MS = 90_000L       // before an evicted carrier is tried again
    private const val PROVEN_MS = 180_000L     // a carrier that synced this recently keeps its slot
    private const val WINDOW_MS = 45_000L      // a window with nothing decoding is left after this
    private const val RESURVEY_MS = 180_000L   // nothing decoding anywhere this long: survey again
    private const val MAX_MESSAGES = 400

    private enum class Phase { SURVEY, LISTEN }
    private class Slot(val hz: Long, val rx: PagerChannelRx, val since: Long) {
        @Volatile var lastSync = 0L
        var syncs = 0; var pages = 0; var protocol = ""; var rate = ""
    }
    private class Carrier(val hz: Long, val db: Float)

    private var phase = Phase.SURVEY
    private var surveyIdx = 0
    private var dwellStart = 0L
    private var window = 0
    private var windowSince = 0L
    private var lastAnySync = 0L
    private var lastManage = 0L
    private var lastPublish = 0L
    private var peak = FloatArray(0)
    private var found = Array(wins.size) { emptyList<Carrier>() }
    private var surveyed = BooleanArray(wins.size)
    private val slots = ArrayList<Slot>()
    private val tried = HashMap<Long, Long>()
    private var iq = FloatArray(0); private var qq = FloatArray(0)
    private var nextId = 1L
    private val caps = HashSet<Long>()

    /** Called by [SdrEngine.setMode] when the tab takes the radio. */
    fun start() { restartAsked = true; running = true }
    fun stop() { running = false; restartAsked = false; heard = null; PagerAudio.release() }
    fun pinWindow(index: Int?) { pin = index; restartAsked = true }
    fun clear() { _messages.value = emptyList(); synchronized(caps) { caps.clear() }; _capcodes.value = 0 }

    /** The hunter's clock (a bench harness replays recordings faster than real time). */
    internal var clock: () -> Long = { System.currentTimeMillis() }
    private fun now() = clock()

    private fun reset(t: Long) {
        restartAsked = false
        slots.clear()
        if (found.size != wins.size) { found = Array(wins.size) { emptyList() }; surveyed = BooleanArray(wins.size) }
        val p = pin
        if (p != null && p < wins.size) { enterWindow(p, t); return }
        phase = Phase.SURVEY; surveyIdx = 0
        surveyed.fill(false)
        tune(wins[0].centerHz, t)
        status("Scanning ${wins[0].label}", true)
    }

    private fun tune(hz: Long, t: Long) { SdrEngine.tune(hz); dwellStart = t; peak = FloatArray(0) }

    // ---------------------------------------------------------------- spectrum: find the carriers

    /** The SDR's FFT for this moment (fftshift not yet applied), [rate] its span. Peak-held per dwell. */
    fun onFft(re: FloatArray, im: FloatArray, rate: Int) {
        if (!running || phase != Phase.LISTEN) return
        if (now() - dwellStart < SETTLE_MS) return
        hold(re, im)
    }

    // The survey looks at far more of the signal than the waterfall does (every 4th 1024-sample block of every
    // buffer, not one block every 50 ms), so a POCSAG transmitter keyed for a second still shows up.
    private val sre = FloatArray(1024); private val sim = FloatArray(1024)
    private val hann = FloatArray(1024) { (0.5 - 0.5 * kotlin.math.cos(2 * Math.PI * it / 1023)).toFloat() }
    private fun scan(buf: ByteArray, len: Int) {
        val n = len / 2
        var start = 0
        while (start + 1024 <= n) {
            for (k in 0 until 1024) {
                sre[k] = ((buf[2 * (start + k)].toInt() and 0xff) - 127.4f) * hann[k]
                sim[k] = ((buf[2 * (start + k) + 1].toInt() and 0xff) - 127.4f) * hann[k]
            }
            Dsp.fft(sre, sim)
            hold(sre, sim)
            start += 4096
        }
    }

    private fun hold(re: FloatArray, im: FloatArray) {
        val n = re.size
        if (peak.size != n) peak = FloatArray(n) { -200f }
        for (k in 0 until n) {
            val s = (k + n / 2) % n   // DC to the middle
            val db = (10.0 * ln(re[s] * re[s] + im[s] * im[s] + 1e-9) / ln(10.0)).toFloat()
            // listening keeps a slow-decaying peak so carriers that come and go stay ranked
            peak[k] = if (db > peak[k]) db else if (phase == Phase.LISTEN) peak[k] - 0.02f else peak[k]
        }
    }

    private fun carriers(center: Long, rate: Int): List<Carrier> {
        val n = peak.size
        if (n == 0) return emptyList()
        val sorted = peak.copyOf().also { it.sort() }
        val floor = sorted[n / 2]
        val bin = rate.toDouble() / n
        val reach = maxOf(1, (12_000 / bin).toInt())
        val out = ArrayList<Carrier>()
        for (k in 0 until n) {
            val off = (k - n / 2) * bin
            if (kotlin.math.abs(off) < 15_000 || kotlin.math.abs(off) > rate * 0.45) continue   // the DC spike and the band edges
            val p = peak[k]
            if (p < floor + 12f) continue
            var top = true
            for (j in maxOf(0, k - reach)..minOf(n - 1, k + reach)) if (peak[j] > p || (peak[j] == p && j < k)) { top = false; break }
            if (!top) continue
            // A FLEX carrier's spectrum is flat-topped, so its peak bin is not its center: take the power centroid
            // of the bins within 10 dB of the top, then snap onto the 2.5 kHz raster pager channels sit on.
            var wsum = 0.0; var isum = 0.0
            for (j in maxOf(0, k - reach)..minOf(n - 1, k + reach)) if (peak[j] > p - 10f) {
                val lin = Math.pow(10.0, (peak[j] - p) / 10.0); wsum += lin; isum += lin * j
            }
            val est = center + (isum / wsum - n / 2) * bin
            // US 929-932 MHz paging channels sit on 929.0125 + n x 25 kHz: snap there when that's within reach
            val onRaster = 929_012_500L + ((est - 929_012_500.0) / 25_000.0).roundToLong() * 25_000L
            val hz = if (est in 929_000_000.0..932_000_000.0 && kotlin.math.abs(onRaster - est) < 7_000) onRaster
                else (est / 2500.0).roundToLong() * 2500
            out += Carrier(hz, p - floor)
        }
        return out.sortedByDescending { it.db }.take(16)
    }

    // ---------------------------------------------------------------- the radio's IQ

    fun onIq(buf: ByteArray, len: Int, rate: Int, centerHz: Long) {
        if (!running) return
        val t = now()
        if (restartAsked) reset(t)
        when (phase) {
            Phase.SURVEY -> { if (t - dwellStart >= SETTLE_MS) scan(buf, len); survey(t, rate) }
            Phase.LISTEN -> {
                if (t - dwellStart >= SETTLE_MS && slots.isNotEmpty()) {
                    val n = len / 2
                    if (iq.size < n) { iq = FloatArray(n); qq = FloatArray(n) }
                    for (k in 0 until n) { iq[k] = (buf[2 * k].toInt() and 0xff) - 127.4f; qq[k] = (buf[2 * k + 1].toInt() and 0xff) - 127.4f }
                    heard = if (!_speaker.value) null else listenHz?.let { h -> slots.firstOrNull { it.hz == h } } ?: slots.maxByOrNull { it.lastSync }
                    for (s in slots) { s.rx.configure(centerHz, rate); s.rx.process(iq, qq, n) }
                }
                if (t - lastManage > 2000) { lastManage = t; manage(t, rate) }
            }
        }
        if (t - lastPublish > 500) { lastPublish = t; publish(t) }
    }

    private fun survey(t: Long, rate: Int) {
        if (t - dwellStart < SETTLE_MS + SURVEY_MS) return
        found[surveyIdx] = carriers(wins[surveyIdx].centerHz, rate)
        surveyed[surveyIdx] = true
        Diag.log("PAGER survey ${wins[surveyIdx].label}: ${found[surveyIdx].size} carriers" +
            found[surveyIdx].take(4).joinToString("") { " · %.4f +%.0fdB".format(it.hz / 1e6, it.db) })
        surveyIdx++
        if (surveyIdx < wins.size) {
            tune(wins[surveyIdx].centerHz, t)
            status("Scanning ${wins[surveyIdx].label}", true)
            return
        }
        val best = wins.indices.maxByOrNull { score(it) }
        if (best == null || found[best].isEmpty()) {
            surveyIdx = 0; tune(wins[0].centerHz, t)
            status("No pager carriers in range · scanning again", true)
            return
        }
        enterWindow(best, t)
    }

    private fun score(i: Int) = found[i].take(SLOTS).sumOf { it.db.toDouble() }

    private fun enterWindow(i: Int, t: Long) {
        phase = Phase.LISTEN
        window = i; windowSince = t; lastAnySync = t
        slots.clear()
        tune(wins[i].centerHz, t)
        // the survey's carriers seed the slots; the live spectrum takes over from the next round
        for (c in found[i].take(SLOTS)) slots += newSlot(c.hz, t)
        status(listenText(), slots.isEmpty())
        Diag.log("PAGER listening ${wins[i].label}: " + slots.joinToString(", ") { "%.4f".format(it.hz / 1e6) })
    }

    private fun newSlot(hz: Long, t: Long): Slot {
        lateinit var slot: Slot
        val rx = PagerChannelRx(hz, object : PagerSink {
            override fun onPage(p: PagerPage) { slot.pages++; addPage(hz, p) }
            override fun onSync(protocol: String, rate: String) {
                val at = now(); slot.lastSync = at; slot.syncs++; slot.protocol = protocol; slot.rate = rate; lastAnySync = at
            }
        })
        slot = Slot(hz, rx, t)
        rx.tap = { xs, n -> if (heard === slot) PagerAudio.write(xs, n, rx.outRate) }
        return slot
    }

    private fun manage(t: Long, rate: Int) {
        if (t - dwellStart < SETTLE_MS + SURVEY_MS) return
        val live = carriers(wins[window].centerHz, rate)
        if (live.isNotEmpty()) found[window] = live
        // carriers that had their chance and never synced make room
        val gone = slots.filter { t - it.since > TRIAL_MS && t - it.lastSync > PROVEN_MS }
        for (s in gone) { slots.remove(s); tried[s.hz] = t }
        val taken = slots.map { it.hz }.toHashSet()
        for (c in found[window]) {
            if (slots.size >= SLOTS) break
            if (c.hz in taken || slots.any { kotlin.math.abs(it.hz - c.hz) < 10_000 }) continue
            if (t - (tried[c.hz] ?: 0L) < RETRY_MS) continue
            slots += newSlot(c.hz, t)
        }
        val p = pin
        if (p != null && p != window) { enterWindow(p, t); return }
        if (p == null) {
            val quiet = t - lastAnySync
            if (quiet > RESURVEY_MS) { Diag.log("PAGER nothing decoding · surveying again"); restartAsked = true; return }
            if (quiet > WINDOW_MS && t - windowSince > WINDOW_MS) {
                // the next busiest window that has carriers, round the list
                val next = wins.indices.map { (window + 1 + it) % wins.size }.firstOrNull { it != window && found[it].isNotEmpty() }
                if (next != null) { enterWindow(next, t); return }
            }
        }
        status(listenText(), false)
    }

    private fun listenText(): String {
        val dec = slots.count { now() - it.lastSync < PROVEN_MS && it.syncs > 0 }
        val w = wins[window].label
        return when {
            slots.isEmpty() -> "Watching $w · no carriers yet"
            dec == 0 -> "Trying ${slots.size} carrier${if (slots.size == 1) "" else "s"} on $w"
            else -> "Decoding $dec channel${if (dec == 1) "" else "s"} on $w"
        }
    }

    private fun status(text: String, scanning: Boolean) {
        _status.value = Status(text, scanning, if (phase == Phase.LISTEN) window else surveyIdx.coerceAtMost(wins.size - 1), pin)
    }

    private fun publish(t: Long) {
        val listening = slots.associateBy { it.hz }
        val cs = ArrayList<Chan>()
        for (s in slots) cs += Chan(s.hz, found[window].firstOrNull { it.hz == s.hz }?.db ?: 0f, true, s.protocol, s.rate, s.pages, s.lastSync)
        if (phase == Phase.LISTEN) for (c in found[window]) if (c.hz !in listening && cs.size < 10) cs += Chan(c.hz, c.db, false, "", "", 0, 0L)
        _channels.value = cs
        _windows.value = wins.mapIndexed { i, w -> WinStat(i, w.label, found[i].size, found[i].firstOrNull()?.db ?: 0f, surveyed[i]) }
        if (phase == Phase.LISTEN) status(listenText(), false)
    }

    private fun addPage(hz: Long, p: PagerPage) {
        val m = PagerMessage(nextId++, now(), hz, p, ALERT.containsMatchIn(p.text.uppercase()))
        val cur = _messages.value
        _messages.value = if (cur.size >= MAX_MESSAGES) listOf(m) + cur.subList(0, MAX_MESSAGES - 1) else listOf(m) + cur
        synchronized(caps) { caps += p.capcode; _capcodes.value = caps.size }
    }

    /** Words that make a page a call-out: fire, EMS, police, hospital codes. */
    private val ALERT = Regex(
        "\\b(FIRE|EMS|MEDIC|AMBULANCE|CARDIAC|ARREST|STROKE|TRAUMA|CODE (BLUE|RED|3|STEMI)|STEMI|STRUCTURE|MVA|MVC|ACCIDENT|" +
            "SHOOTING|SHOTS|STABBING|OVERDOSE|UNRESPONSIVE|RESCUE|HAZMAT|ALARM|POLICE|SWAT|ENGINE \\d+|LADDER \\d+|" +
            "BATTALION|MEDIC \\d+|RESPOND|STAT)\\b")
}
