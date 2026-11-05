package com.rocketgod.mayhem.core.pager

import com.rocketgod.mayhem.core.Dsp
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.roundToLong

/** A page as the feed shows it: the decoder's page plus when, on what frequency, and whether it reads like a call-out. */
data class PagerMessage(val id: Long, val at: Long, val hz: Long, val page: PagerPage, val alert: Boolean)

/**
 * Multi-channel pager decode over whatever span the radio is tuned to — worldwide, no band presets. It peak-holds
 * the current span's spectrum, finds the carriers in it, and decodes up to [SLOTS] at once, each through a
 * [PagerChannelRx]. In HUNT it tracks the span's busiest carriers itself; PINNED keeps only the ones you tapped.
 * You choose the band by tuning the radio; the heard channel's audio goes out the normal path, so the global mute
 * governs it. Runs on the DSP thread via [onIq]; the UI reads the flows.
 */
object PagerEngine {
    const val SLOTS = 4

    data class Chan(val hz: Long, val snrDb: Float, val listening: Boolean, val protocol: String, val rate: String,
                    val pages: Int, val lastSync: Long)
    /** [heardHz]: the channel whose audio plays, shaded on the waterfall (null before any has a receiver). */
    data class Status(val text: String, val hunting: Boolean, val pinned: Int, val heardHz: Long? = null)

    private val _status = MutableStateFlow(Status("Waiting for the radio", true, 0))
    val status: StateFlow<Status> = _status.asStateFlow()
    private val _channels = MutableStateFlow<List<Chan>>(emptyList())
    val channels: StateFlow<List<Chan>> = _channels.asStateFlow()
    private val _messages = MutableStateFlow<List<PagerMessage>>(emptyList())
    val messages: StateFlow<List<PagerMessage>> = _messages.asStateFlow()
    private val _capcodes = MutableStateFlow(0)
    val capcodes: StateFlow<Int> = _capcodes.asStateFlow()

    /** AUTO: track the span's busiest carriers. Off: keep only [pinned], or with none pinned, what was decoding. */
    @Volatile var hunting = true; private set
    /** The AUTO tile. On: forget the pins and hunt; the heard channel goes back to whichever synced last. Off: the
     *  channels being decoded stay until a signal is picked. */
    fun setHunting(on: Boolean) {
        synchronized(pinned) { pinned.clear(); held.clear() }; listenHz = null
        if (!on) holdNow = true
        hunting = on; lastManage = 0L; status()
    }
    fun toggleAuto() = setHunting(!hunting)
    /** The channel whose audio plays (tap a channel); null = whichever synced last. */
    @Volatile var listenHz: Long? = null
    /** Carriers the user pinned (tap an active frequency to stay on it). */
    private val pinned = LinkedHashSet<Long>()
    /** AUTO off with nothing pinned: the channels that were decoding when it went off. */
    private val held = HashSet<Long>()
    @Volatile private var holdNow = false
    /** A waterfall tap waiting for the DSP thread to snap it onto the carrier there. */
    @Volatile private var pickHz = 0L
    fun pin(hz: Long) { synchronized(pinned) { pinned.add(hz); held.clear() }; hunting = false; listenHz = hz; lastManage = 0L; status() }
    /** A tap on the waterfall: the carrier under the finger is pinned (snapped onto it on the DSP thread), AUTO off. */
    fun pick(hz: Long) { pickHz = hz; hunting = false; lastManage = 0L; status() }
    /** Let a pinned carrier go: its receiver stops. AUTO stays off; the AUTO tile turns it back on. */
    fun unpin(hz: Long) {
        synchronized(pinned) { pinned.remove(hz); held.remove(hz) }
        if (listenHz == hz) listenHz = null
        lastManage = 0L; status()
    }
    fun pinnedList(): List<Long> = synchronized(pinned) { pinned.toList() }

    @Volatile var running = false; private set
    @Volatile private var restart = false
    @Volatile private var heard: Slot? = null

    private const val SETTLE_MS = 300L         // ignore the span right after a retune, while the AGC/stream settle
    private const val SURVEY_MS = 2000L        // peak-hold this long before the first carrier list
    private const val TRIAL_MS = 20_000L       // a hunted carrier gets this long to show a sync
    private const val RETRY_MS = 90_000L       // before an evicted carrier is tried again
    private const val PROVEN_MS = 180_000L     // a carrier that synced this recently keeps its slot
    private const val MAX_MESSAGES = 400
    /** How far back the card a repeated page replaces is looked for. */
    private const val REPEAT_MS = 10 * 60_000L
    private const val AUDIO_GAIN = 9000f / 32000f   // match PagerAudio's level into the ±1 audio path

    private class Slot(val hz: Long, val rx: PagerChannelRx, val since: Long) {
        @Volatile var lastSync = 0L
        var syncs = 0; var pages = 0; var protocol = ""; var rate = ""
    }
    private class Carrier(val hz: Long, val db: Float)

    private var center = 0L
    private var rateHz = 0
    private var spanStart = 0L
    @Volatile private var lastManage = 0L
    private var lastPublish = 0L
    private var peak = FloatArray(0)
    private var carriers = emptyList<Carrier>()
    private val slots = ArrayList<Slot>()
    private val tried = HashMap<Long, Long>()
    private var iq = FloatArray(0); private var qq = FloatArray(0)
    private var nextId = 1L
    private val caps = HashSet<Long>()

    fun start() { running = true; restart = true }
    fun stop() { running = false; heard = null; synchronized(ring) { aR = 0; aW = 0 } }
    fun clear() { _messages.value = emptyList(); synchronized(caps) { caps.clear() }; _capcodes.value = 0 }

    /** The clock (a bench harness can replay recordings faster than real time). */
    internal var clock: () -> Long = { System.currentTimeMillis() }
    private fun now() = clock()

    // ---------------------------------------------------------------- the radio's IQ

    fun onIq(buf: ByteArray, len: Int, rate: Int, centerHz: Long) {
        if (!running) return
        val t = now()
        if (restart || centerHz != center || rate != rateHz) {
            center = centerHz; rateHz = rate; restart = false
            slots.clear(); tried.clear(); peak = FloatArray(0); carriers = emptyList()
            spanStart = t; lastManage = 0L; heard = null
            status()
        }
        if (t - spanStart < SETTLE_MS) return
        scan(buf, len)
        if (holdNow) { holdNow = false; synchronized(pinned) { held.clear(); slots.forEach { held += it.hz } } }
        val p = pickHz
        if (p != 0L) { pickHz = 0L; val at = snap(p); synchronized(pinned) { pinned.add(at); held.clear() }; listenHz = at; lastManage = 0L }
        if (slots.isNotEmpty()) {
            val n = len / 2
            if (iq.size < n) { iq = FloatArray(n); qq = FloatArray(n) }
            for (k in 0 until n) { iq[k] = (buf[2 * k].toInt() and 0xff) - 127.4f; qq[k] = (buf[2 * k + 1].toInt() and 0xff) - 127.4f }
            heard = listenHz?.let { h -> slots.firstOrNull { it.hz == h } } ?: slots.maxByOrNull { it.lastSync }
            for (s in slots) { s.rx.configure(center, rate); s.rx.process(iq, qq, n) }
        }
        // a control changed (lastManage reset) with AUTO off: the receivers follow it now, not after the survey
        val asked = lastManage == 0L && !hunting
        if (asked || (t - spanStart >= SETTLE_MS + SURVEY_MS && t - lastManage > 2000)) { lastManage = t; manage(t) }
        if (t - lastPublish > 500) { lastPublish = t; publish() }
    }

    // ---------------------------------------------------------------- spectrum: find the carriers

    // The survey looks at far more of the signal than a waterfall does (every 4th 1024-sample block of every buffer),
    // so a POCSAG transmitter keyed for only a second still shows up.
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
            // a slow-decaying peak so carriers that come and go stay ranked
            peak[k] = if (db > peak[k]) db else peak[k] - 0.02f
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
            if (abs(off) < 15_000 || abs(off) > rate * 0.45) continue   // the DC spike and the band edges
            val p = peak[k]
            if (p < floor + 12f) continue
            var top = true
            for (j in maxOf(0, k - reach)..minOf(n - 1, k + reach)) if (peak[j] > p || (peak[j] == p && j < k)) { top = false; break }
            if (!top) continue
            // A FLEX carrier's spectrum is flat-topped, so its peak bin is not its center: take the power centroid
            // of the bins within 10 dB of the top, then snap onto a 2.5 kHz raster.
            var wsum = 0.0; var isum = 0.0
            for (j in maxOf(0, k - reach)..minOf(n - 1, k + reach)) if (peak[j] > p - 10f) {
                val lin = Math.pow(10.0, (peak[j] - p) / 10.0); wsum += lin; isum += lin * j
            }
            val est = center + (isum / wsum - n / 2) * bin
            val hz = (est / 2500.0).roundToLong() * 2500
            out += Carrier(hz, p - floor)
        }
        return out.sortedByDescending { it.db }.take(16)
    }

    /**
     * The carrier at a tapped frequency: a listed carrier within half a 25 kHz channel of it, else the power centroid
     * of the held spectrum within 12 kHz of it (a carrier the survey ranked too low to list), else the tap itself;
     * all on the 2.5 kHz raster the survey uses.
     */
    internal fun snap(hz: Long): Long {
        carriers(center, rateHz).filter { abs(it.hz - hz) <= 12_500 }.minByOrNull { abs(it.hz - hz) }?.let { return it.hz }
        val n = peak.size
        if (n > 0 && rateHz > 0) {
            val bin = rateHz.toDouble() / n
            val k0 = ((hz - center) / bin + n / 2).roundToLong().toInt()
            val reach = maxOf(1, (12_000 / bin).toInt())
            val lo = maxOf(0, k0 - reach); val hi = minOf(n - 1, k0 + reach)
            if (lo <= hi) {
                var top = -Float.MAX_VALUE
                for (j in lo..hi) top = maxOf(top, peak[j])
                val floor = peak.copyOf().also { it.sort() }[n / 2]
                if (top > floor + 6f) {
                    var wsum = 0.0; var isum = 0.0
                    for (j in lo..hi) if (peak[j] > top - 10f) { val lin = Math.pow(10.0, (peak[j] - top) / 10.0); wsum += lin; isum += lin * j }
                    return ((center + (isum / wsum - n / 2) * bin) / 2500.0).roundToLong() * 2500
                }
            }
        }
        return (hz / 2500.0).roundToLong() * 2500
    }

    // ---------------------------------------------------------------- slots

    private fun newSlot(hz: Long, t: Long): Slot {
        lateinit var slot: Slot
        val rx = PagerChannelRx(hz, object : PagerSink {
            override fun onPage(p: PagerPage) { slot.pages++; addPage(hz, p) }
            override fun onSync(protocol: String, rate: String) {
                val at = now(); slot.lastSync = at; slot.syncs++; slot.protocol = protocol; slot.rate = rate
            }
        })
        slot = Slot(hz, rx, t)
        rx.tap = { xs, n -> if (heard === slot) pushAudio(xs, n) }
        return slot
    }

    private fun manage(t: Long) {
        carriers = carriers(center, rateHz)
        val want: List<Long> = if (hunting) carriers.take(SLOTS).map { it.hz }
            else synchronized(pinned) { if (pinned.isNotEmpty()) pinned.toList() else held.toList() }
        // evict: in HUNT, carriers that had their trial and never proved; in PINNED, anything no longer pinned
        val gone = slots.filter { s ->
            if (!hunting) s.hz !in want
            else t - s.since > TRIAL_MS && t - s.lastSync > PROVEN_MS && s.hz !in want
        }
        for (s in gone) { slots.remove(s); if (hunting) tried[s.hz] = t }
        val taken = slots.map { it.hz }.toHashSet()
        for (hz in want) {
            if (slots.size >= SLOTS) break
            if (hz in taken || slots.any { abs(it.hz - hz) < 10_000 }) continue
            if (hunting && t - (tried[hz] ?: 0L) < RETRY_MS) continue
            slots += newSlot(hz, t)
        }
        publish()
    }

    private fun statusText(): String {
        if (!hunting) {
            val np = pinnedList().size
            if (np > 0) return "Pinned $np channel${if (np == 1) "" else "s"}"
            return if (slots.isNotEmpty()) "AUTO off · holding ${slots.size} · tap a signal to keep just it" else "AUTO off · tap a signal to decode it"
        }
        val dec = slots.count { now() - it.lastSync < PROVEN_MS && it.syncs > 0 }
        return when {
            peak.isEmpty() -> "Surveying the span"
            slots.isEmpty() -> "Watching · no carriers yet (tune to a pager band)"
            dec == 0 -> "Trying ${slots.size} carrier${if (slots.size == 1) "" else "s"}"
            else -> "Decoding $dec channel${if (dec == 1) "" else "s"}"
        }
    }

    private fun status() { _status.value = Status(statusText(), hunting, pinnedList().size, listenHz ?: heard?.hz) }

    private fun publish() {
        // a carrier's estimate wanders a raster step or two between surveys: within 10 kHz of a channel, it is that channel
        fun near(a: Long, b: Long) = abs(a - b) < 10_000
        val cs = ArrayList<Chan>()
        for (s in slots) cs += Chan(s.hz, carriers.firstOrNull { near(it.hz, s.hz) }?.db ?: 0f, true, s.protocol, s.rate, s.pages, s.lastSync)
        for (c in carriers) if (slots.none { near(it.hz, c.hz) } && cs.size < 12) cs += Chan(c.hz, c.db, false, "", "", 0, 0L)
        _channels.value = cs
        status()
    }

    private fun addPage(hz: Long, p: PagerPage) {
        val t = now()
        var cur = _messages.value
        // Another transmission of a page already on the feed (the decoder matched it by capcode and message number):
        // one that adds nothing is dropped, one that filled words the first copy lost takes its card's place.
        if (p.repeat != 0 && p.key.isNotEmpty()) {
            val earlier = cur.firstOrNull { it.at >= t - REPEAT_MS && it.hz == hz && it.page.protocol == p.protocol && it.page.capcode == p.capcode && it.page.key == p.key }
            if (p.repeat == 1 && earlier != null) return
            if (earlier != null) cur = cur.filter { it.id != earlier.id }
        }
        val m = PagerMessage(nextId++, t, hz, p, isCallOut(p.text))
        _messages.value = if (cur.size >= MAX_MESSAGES) listOf(m) + cur.subList(0, MAX_MESSAGES - 1) else listOf(m) + cur
        synchronized(caps) { caps += p.capcode; _capcodes.value = caps.size }
    }

    // ---------------------------------------------------------------- heard-channel audio (played via drainAudio; global mute governs it)

    private val ring = FloatArray(1 shl 15)
    private var aR = 0; private var aW = 0
    private var dc = 0f
    private fun pushAudio(xs: FloatArray, n: Int) {
        synchronized(ring) {
            for (i in 0 until n) {
                dc += (xs[i] - dc) * 0.001f
                val nxt = (aW + 1) and (ring.size - 1)
                if (nxt == aR) break   // full: drop the rest of this block rather than block the DSP thread
                ring[aW] = (xs[i] - dc) * AUDIO_GAIN
                aW = nxt
            }
        }
    }
    /** Pull up to [max] samples of the heard channel into [dst] for the engine's AudioTrack. */
    fun drainAudio(dst: FloatArray, max: Int): Int {
        synchronized(ring) {
            var k = 0
            while (k < max && aR != aW) { dst[k++] = ring[aR]; aR = (aR + 1) and (ring.size - 1) }
            return k
        }
    }

    /** A page with one of [ALERT]'s words in it. */
    internal fun isCallOut(text: String) = ALERT.containsMatchIn(text.uppercase())

    /** Words that make a page a call-out: fire, EMS, police, hospital codes, warnings, critical results, patients. */
    private val ALERT = Regex(
        "\\b(FIRE|EMS|MEDIC|AMBULANCE|CARDIAC|ARREST|STROKE|TRAUMA|CODE|STEMI|WARNING|CRITICAL|PATIENT|STRUCTURE|MVA|MVC|ACCIDENT|" +
            "SHOOTING|SHOTS|STABBING|OVERDOSE|UNRESPONSIVE|RESCUE|HAZMAT|ALARM|POLICE|SWAT|ENGINE \\d+|LADDER \\d+|" +
            "BATTALION|MEDIC \\d+|RESPOND|STAT)\\b")
}
