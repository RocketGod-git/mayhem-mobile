package com.rocketgod.mayhem.core.pager

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.audio.AudioRateConverter
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.roundToLong

/** A page as the feed shows it: the decoder's page plus when, on what frequency, and whether it reads like a call-out. */
data class PagerMessage(val id: Long, val at: Long, val hz: Long, val page: PagerPage, val alert: Boolean)

/** The readable runs of a broken page, four characters or more: a missing fragment (<…>), a cut end ( …) and the
 *  '?' of lost words split it. Errors come in bursts, so the word on either side of a lost one (three characters) may
 *  have been fixed into the wrong word: it is left out as well. */
internal fun readableRuns(text: String): List<String> {
    val c = text.toCharArray()
    val lost = c.indices.filter { c[it] == '?' }
    for (i in lost) for (k in maxOf(0, i - 3)..minOf(c.size - 1, i + 3)) if (c[k] != '…' && c[k] != '<' && c[k] != '>') c[k] = '?'
    return String(c).split(Regex("<…>| …$|\\?+")).map { it.trim() }.filter { it.length >= 4 }
}

/** Whether a whole page carries every readable run of a broken one, in order: the broken one is a copy of it. */
internal fun coversPage(whole: String, broken: String): Boolean {
    val runs = readableRuns(broken)
    if (runs.isEmpty()) return false
    var at = 0
    for (r in runs) { val k = whole.indexOf(r, at); if (k < 0) return false; at = k + r.length }
    return true
}

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
    /** How far above the span's noise (its median peak-hold) a carrier must stand. The noise holds flat to a dB
     *  or two, and a weak 2400 baud POCSAG carrier spreads over a few bins, so 12 dB lost carriers it could decode. */
    private const val SURVEY_DB = 8f
    private const val MANAGE_MS = 250L         // how often the carrier list is looked at again
    private const val HISTORY_S = 1.0          // IQ kept to replay into a new receiver (a POCSAG preamble is ~1.1 s at 512)
    private const val QUICK_MS = 3000L         // an unproven receiver this old gives way to a new carrier
    private const val TRIAL_MS = 20_000L       // a hunted carrier gets this long to show a sync
    private const val RETRY_MS = 90_000L       // before an evicted carrier is tried again
    private const val PROVEN_MS = 180_000L     // a carrier that synced this recently keeps its slot
    /**
     * Image copies of a strong carrier. The HackRF puts weak copies of every strong carrier at multiples of 41.667 kHz
     * (20 MHz / 480) either side of it, about 30 dB down at the first and 43 dB at the second (measured on the
     * 2026-11-20 roof recording, 929.6125, 931.5375, 935.275 and 940.8625 MHz). A copy carries the same pages at the
     * same instant, so it would decode them a second time and take a receiver a real carrier needs. A carrier sitting
     * within [IMAGE_TOL] of such an offset from one [IMAGE_DB] stronger gets no receiver in AUTO; a receiver at such an
     * offset that decodes a page another, much stronger receiver just decoded is a copy too, and gives its slot up.
     */
    private const val IMAGE_STEP = 41_667.0
    private const val IMAGE_STEPS = 4
    private const val IMAGE_TOL = 5_000.0
    private const val IMAGE_DB = 15f
    /** A page heard again on another carrier this soon after is the same transmission. */
    private const val COPY_MS = 3_000L
    /** How much weaker a receiver repeating another's page must be to be taken for a copy of it. */
    private const val COPY_DB = 10f
    /**
     * A page with pieces missing waits this long before it is shown. Simulcast carriers send the same pages a moment
     * apart, and one receiver often hears a page whole while another misses its first fragment; the whole copy usually
     * lands within a couple of seconds, and then the broken one is never shown.
     */
    private const val PARTIAL_WAIT_MS = 8_000L
    /** A whole copy arriving this soon after a broken one was shown takes that card's place, and a broken copy arriving
     *  this soon after a whole one is dropped (networks send a page again on another carrier seconds later). */
    private const val PARTIAL_REPLACE_MS = 60_000L
    private const val MAX_MESSAGES = 400
    /** How far back the card a repeated page replaces is looked for. */
    private const val REPEAT_MS = 10 * 60_000L
    private const val AUDIO_GAIN = 9000f / 32000f   // match PagerAudio's level into the ±1 audio path

    private class Slot(val hz: Long, val rx: PagerChannelRx, val since: Long) {
        @Volatile var lastSync = 0L
        var syncs = 0; var pages = 0; var protocol = ""; var rate = ""
    }
    internal class Carrier(val hz: Long, val db: Float) { var image: Long? = null }

    /** The stronger carrier [c] is an image copy of, if any (see [IMAGE_STEP]). */
    internal fun imageOf(c: Carrier, all: List<Carrier>, rate: Int = 0): Long? {
        val steps = ArrayList<Double>(2).apply { add(IMAGE_STEP) }
        val r = rate / 480.0   // the same spur scaled to the stream's rate, when that is its own spacing
        if (r >= 2 * IMAGE_TOL && abs(r - IMAGE_STEP) > IMAGE_TOL) steps += r
        for (s in all) {
            if (s === c || s.db - c.db < IMAGE_DB) continue
            val d = abs(c.hz - s.hz).toDouble()
            for (st in steps) for (k in 1..IMAGE_STEPS) if (abs(d - k * st) <= IMAGE_TOL) return s.hz
        }
        return null
    }

    private var center = 0L
    private var rateHz = 0
    private var spanStart = 0L
    @Volatile private var lastManage = 0L
    private var lastPublish = 0L
    private var peak = FloatArray(0)
    private var carriers = emptyList<Carrier>()
    private val slots = ArrayList<Slot>()
    private val tried = HashMap<Long, Long>()
    /** Carriers a receiver proved to be copies of another (it decoded that one's pages), by frequency. */
    private val copies = HashMap<Long, Long>()
    /** Pages put on the feed in the last [COPY_MS]: what the page says, its carrier, its card, when. */
    private class Recent(val key: String, var hz: Long, var id: Long, val at: Long)
    private val recent = ArrayList<Recent>()
    /** Broken pages waiting [PARTIAL_WAIT_MS] for a whole copy: carrier, page, when. */
    private class Waiting(val hz: Long, val p: PagerPage, val at: Long)
    private val brokenWaiting = ArrayList<Waiting>()
    /** Broken pages shown in the last [PARTIAL_REPLACE_MS] (their cards), so a late whole copy can take the place. */
    private class ShownBroken(val id: Long, val capcode: Long, val text: String, val at: Long)
    private val shownBroken = ArrayList<ShownBroken>()
    /** Whole pages shown in the last [PARTIAL_REPLACE_MS], so a broken copy arriving after one is dropped. */
    private class Whole(val capcode: Long, val text: String, val at: Long)
    private val wholes = ArrayList<Whole>()
    private var iq = FloatArray(0); private var qq = FloatArray(0)
    // The radio's DC offset (LO leakage), tracked per buffer and removed, so a carrier at the tuned center is not
    // buried under the spike and the center of the span can be hunted like the rest of it.
    private var dcI = 0f; private var dcQ = 0f; private var dcFresh = true
    // The last [HISTORY_S] of raw IQ: a carrier found now keyed up a moment ago, and POCSAG (unlike FLEX) only
    // transmits in bursts, so a new receiver is first fed what it missed, preamble and all.
    private var hist = ByteArray(0); private var hW = 0; private var hFill = 0
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
            // a retune ends every receiver, so no whole copy can come now: what was waiting is shown as it is
            release(t, all = true)
            synchronized(recent) { shownBroken.clear(); wholes.clear() }
            center = centerHz; rateHz = rate; restart = false
            slots.clear(); tried.clear(); synchronized(recent) { copies.clear(); recent.clear() }; peak = FloatArray(0); carriers = emptyList()
            spanStart = t; lastManage = 0L; heard = null
            hist = ByteArray(((rate * HISTORY_S).toInt() * 2).coerceAtLeast(2)); hW = 0; hFill = 0
            dcFresh = true
            status()
        }
        // the DC estimate follows the radio through the settle time too, so it is right by the first survey
        val n = len / 2
        var si = 0.0; var sq = 0.0
        for (k in 0 until n) { si += (buf[2 * k].toInt() and 0xff) - 127.4f; sq += (buf[2 * k + 1].toInt() and 0xff) - 127.4f }
        if (n > 0) {
            val mi = (si / n).toFloat(); val mq = (sq / n).toFloat()
            if (dcFresh) { dcI = mi; dcQ = mq; dcFresh = false } else { dcI += (mi - dcI) * 0.3f; dcQ += (mq - dcQ) * 0.3f }
        }
        release(t)
        if (t - spanStart < SETTLE_MS) return
        record(buf, len)
        if (iq.size < n) { iq = FloatArray(n); qq = FloatArray(n) }
        for (k in 0 until n) { iq[k] = (buf[2 * k].toInt() and 0xff) - 127.4f - dcI; qq[k] = (buf[2 * k + 1].toInt() and 0xff) - 127.4f - dcQ }
        scan(n)
        if (holdNow) { holdNow = false; synchronized(pinned) { held.clear(); slots.forEach { held += it.hz } } }
        val p = pickHz
        if (p != 0L) { pickHz = 0L; val at = snap(p); synchronized(pinned) { pinned.add(at); held.clear() }; listenHz = at; lastManage = 0L }
        if (slots.isNotEmpty()) {
            heard = listenHz?.let { h -> slots.firstOrNull { it.hz == h } } ?: slots.maxByOrNull { it.lastSync }
            for (s in slots) { s.rx.configure(center, rate); s.rx.process(iq, qq, n) }
        }
        // a control changed (lastManage reset) with AUTO off: the receivers follow it now, not after the survey
        val asked = lastManage == 0L && !hunting
        if (asked || (t - spanStart >= SETTLE_MS + SURVEY_MS && t - lastManage >= MANAGE_MS)) { lastManage = t; manage(t) }
        if (t - lastPublish > 500) { lastPublish = t; publish() }
    }

    // ---------------------------------------------------------------- spectrum: find the carriers

    // The survey looks at far more of the signal than a waterfall does (every 4th 1024-sample block of every buffer),
    // so a POCSAG transmitter keyed for only a second still shows up.
    private val sre = FloatArray(1024); private val sim = FloatArray(1024)
    private val hann = FloatArray(1024) { (0.5 - 0.5 * kotlin.math.cos(2 * Math.PI * it / 1023)).toFloat() }
    private fun scan(n: Int) {
        var start = 0
        while (start + 1024 <= n) {
            for (k in 0 until 1024) { sre[k] = iq[start + k] * hann[k]; sim[k] = qq[start + k] * hann[k] }
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
            if (abs(off) > rate * 0.45) continue   // the band edges (the DC spike is removed before the survey)
            val p = peak[k]
            if (p < floor + SURVEY_DB) continue
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
        val ranked = out.sortedByDescending { it.db }
        for (c in ranked) c.image = imageOf(c, ranked, rate)
        return ranked.take(16)
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
            override fun onPage(p: PagerPage) { if (p.protocol != "ReFLEX") slot.pages++; addPage(hz, p) }
            override fun onSync(protocol: String, rate: String) {
                val at = now(); slot.lastSync = at; slot.syncs++; slot.protocol = protocol; slot.rate = rate
            }
        })
        slot = Slot(hz, rx, t)
        rx.tap = { xs, n -> if (heard === slot) pushAudio(xs, n, rx.outRate) }
        rx.configure(center, rateHz)
        replay(rx)
        return slot
    }

    private fun record(buf: ByteArray, len: Int) {
        val cap = hist.size
        if (cap < 2) return
        var off = maxOf(0, len - cap)
        while (off < len) {
            val m = minOf(len - off, cap - hW)
            System.arraycopy(buf, off, hist, hW, m)
            off += m; hW = (hW + m) % cap
            hFill = minOf(cap, hFill + m)
        }
    }

    /** Feeds a new receiver the last [HISTORY_S] of the span, oldest first, with the DC removed as now. */
    private fun replay(rx: PagerChannelRx) {
        val cap = hist.size
        if (hFill < 2) return
        val chunk = 65_536
        val fi = FloatArray(chunk); val fq = FloatArray(chunk)
        var pos = (hW - hFill + cap) % cap
        var left = hFill / 2
        while (left > 0) {
            val m = minOf(chunk, left)
            for (k in 0 until m) {
                fi[k] = (hist[pos].toInt() and 0xff) - 127.4f - dcI
                fq[k] = (hist[pos + 1].toInt() and 0xff) - 127.4f - dcQ
                pos += 2; if (pos >= cap) pos = 0
            }
            rx.process(fi, fq, m)
            left -= m
        }
    }

    private fun manage(t: Long) {
        carriers = carriers(center, rateHz)
        // in HUNT, the strongest carriers, less any sitting out RETRY_MS after a failed trial (the next ones move up)
        fun resting(hz: Long) = t - (tried[hz] ?: 0L) < RETRY_MS && slots.none { abs(it.hz - hz) < 10_000 }
        fun wanted(): List<Long> = if (hunting) carriers.filter { !isCopy(it.hz) && !resting(it.hz) }.take(SLOTS).map { it.hz }
            else synchronized(pinned) { if (pinned.isNotEmpty()) pinned.toList() else held.toList() }
        val want = wanted()
        // evict: in HUNT, carriers that had their trial and never proved; in PINNED, anything no longer pinned
        // A carrier that wants a receiver while all are busy: one that has never synced, has had a few seconds and
        // is no longer among the wanted gives way (POCSAG keys up for a second; it can't wait out a 20 s trial).
        // A carrier that never synced gives way after its trial even while it is still among the strongest: a spur or a
        // non-pager signal can outrank every pager in the span, and would otherwise hold its receiver for good.
        val waiting = hunting && slots.size >= SLOTS && want.any { hz -> slots.none { abs(it.hz - hz) < 10_000 } && t - (tried[hz] ?: 0L) >= RETRY_MS }
        val gone = slots.filter { s ->
            val failed = s.syncs == 0 && t - s.since > TRIAL_MS
            if (!hunting) s.hz !in want
            else isCopy(s.hz) || failed || s.hz !in want && t - s.lastSync > PROVEN_MS &&
                (t - s.since > TRIAL_MS || (waiting && s.syncs == 0 && t - s.since > QUICK_MS))
        }
        // only a carrier that never synced waits out RETRY_MS: a pager that went quiet is welcome back at once
        for (s in gone) { slots.remove(s); if (hunting && s.syncs == 0) tried[s.hz] = t }
        val taken = slots.map { it.hz }.toHashSet()
        for (hz in if (gone.isNotEmpty()) wanted() else want) {
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
        for (c in carriers) if (slots.none { near(it.hz, c.hz) } && !isCopy(c.hz) && cs.size < 12) cs += Chan(c.hz, c.db, false, "", "", 0, 0L)
        _channels.value = cs
        status()
    }

    /** A carrier AUTO leaves alone: an image copy by the survey, or one a receiver showed to be a copy. */
    private fun isCopy(hz: Long): Boolean {
        if (synchronized(recent) { copies.keys.any { abs(it - hz) < 5_000 } }) return true
        return carriers.any { it.image != null && abs(it.hz - hz) < 5_000 }
    }
    private fun levelOf(hz: Long): Float = carriers.firstOrNull { abs(it.hz - hz) < 10_000 }?.db ?: 0f

    /**
     * A decoded page. A whole one goes to the feed, and a broken copy of it that is waiting, or was shown not long
     * ago, gives way to it. A broken one (pieces missing) waits [PARTIAL_WAIT_MS] for a whole copy from another carrier
     * or a repeat, and is dropped if a whole copy was shown just before it.
     */
    private fun addPage(hz: Long, p: PagerPage) {
        val t = now()
        // a ReFLEX frame card: one per carrier, kept current, never for a copy
        if (p.protocol == "ReFLEX") { if (!isCopy(hz)) place(hz, p, t, null); return }
        if (p.text.isBlank()) { show(hz, p, t, null); return }
        var replace: Long? = null
        synchronized(recent) {
            wholes.removeAll { t - it.at > PARTIAL_REPLACE_MS }
            if (p.errors > 0) {
                if (wholes.none { it.capcode == p.capcode && coversPage(it.text, p.text) }) brokenWaiting += Waiting(hz, p, t)
                return
            }
            brokenWaiting.removeAll { it.p.capcode == p.capcode && coversPage(p.text, it.p.text) }
            shownBroken.removeAll { t - it.at > PARTIAL_REPLACE_MS }
            val was = shownBroken.firstOrNull { it.capcode == p.capcode && coversPage(p.text, it.text) }
            if (was != null) { shownBroken.remove(was); replace = was.id }
            wholes += Whole(p.capcode, p.text, t)
        }
        show(hz, p, t, replace)
    }

    /** Broken pages whose wait is over ([all] of them on a retune) go to the feed as they are. */
    private fun release(t: Long, all: Boolean = false) {
        val due = synchronized(recent) {
            if (brokenWaiting.isEmpty()) return
            val d = brokenWaiting.filter { all || t - it.at >= PARTIAL_WAIT_MS }
            brokenWaiting.removeAll(d.toSet()); d
        }
        for (w in due) {
            val id = show(w.hz, w.p, t, null) ?: continue
            synchronized(recent) { shownBroken += ShownBroken(id, w.p.capcode, w.p.text, t) }
        }
    }

    /**
     * A page for the feed, in place of card [replace] if given; its card's id, or null for a copy already shown. The
     * same page from another receiver a moment ago is one transmission heard twice when the two are far apart in level
     * and at a spur offset: a receiver on an image copy (see [IMAGE_STEP]). It is shown once, on the stronger carrier,
     * and the weaker one gives its slot up. Two real carriers can carry the same page; both show.
     */
    private fun show(hz: Long, p: PagerPage, t: Long, replace: Long?): Long? {
        val key = "${p.protocol}|${p.rate}|${p.capcode}|${p.kind}|${p.where}|${p.text}"
        synchronized(recent) {
            recent.removeAll { t - it.at > COPY_MS }
            val twin = recent.firstOrNull { it.hz != hz && it.key == key }
            if (twin != null) {
                val mine = levelOf(hz); val theirs = levelOf(twin.hz)
                val strong = if (mine >= theirs) hz else twin.hz; val weak = if (strong == hz) twin.hz else hz
                if (abs(mine - theirs) >= COPY_DB && imageOf(Carrier(weak, 0f), listOf(Carrier(strong, IMAGE_DB)), rateHz) != null) {
                    copies[weak] = strong; lastManage = 0L
                    if (strong != hz) return null             // the copy: already shown
                    // the stronger carrier decoded it second: its card takes the copy's place
                    twin.hz = hz; twin.id = place(hz, p, t, twin.id)
                    return twin.id
                }
            }
            val id = place(hz, p, t, replace)
            recent += Recent(key, hz, id, t)
            return id
        }
    }

    /** Puts a page on the feed (in place of card [replace], if given) and returns its card's id. */
    private fun place(hz: Long, p: PagerPage, t: Long, replace: Long?): Long {
        var cur = _messages.value
        if (replace != null) cur = cur.filter { it.id != replace }
        // Another transmission of a page already on the feed (the decoder matched it by capcode and message number):
        // one that adds nothing is dropped, one that filled words the first copy lost takes its card's place.
        if (p.repeat != 0 && p.key.isNotEmpty()) {
            val earlier = cur.firstOrNull { it.at >= t - REPEAT_MS && it.hz == hz && it.page.protocol == p.protocol && it.page.capcode == p.capcode && it.page.key == p.key }
            if (p.repeat == 1 && earlier != null) return earlier.id
            if (earlier != null) cur = cur.filter { it.id != earlier.id }
        }
        val m = PagerMessage(nextId++, t, hz, p, isCallOut(p.text))
        _messages.value = if (cur.size >= MAX_MESSAGES) listOf(m) + cur.subList(0, MAX_MESSAGES - 1) else listOf(m) + cur
        // a ReFLEX frame card has no capcode
        if (p.capcode >= 0) synchronized(caps) { caps += p.capcode; _capcodes.value = caps.size }
        return m.id
    }

    // ---------------------------------------------------------------- heard-channel audio (played via drainAudio; global mute governs it)

    private val ring = FloatArray(1 shl 15)
    private var aR = 0; private var aW = 0
    private var dc = 0f
    // The channel's discriminator runs at its own rate (50 kHz at 2 Msps, 45.5 kHz at 2.048), converted to exactly 48 kHz
    // for the output; at 48 kHz itself it goes through untouched.
    private var conv: AudioRateConverter? = null
    private var convIn = FloatArray(0); private var convOut = FloatArray(0)
    private fun pushAudio(xs: FloatArray, n: Int, inRate: Double) {
        synchronized(ring) {
            if (inRate <= 0) return
            val c = conv?.takeIf { it.inRate == inRate } ?: AudioRateConverter(inRate).also { conv = it }
            if (convIn.size < n) convIn = FloatArray(n)
            for (i in 0 until n) { dc += (xs[i] - dc) * 0.001f; convIn[i] = (xs[i] - dc) * AUDIO_GAIN }
            if (convOut.size < c.maxOut(n)) convOut = FloatArray(c.maxOut(n))
            val k = c.process(convIn, n, convOut)
            for (i in 0 until k) {
                val nxt = (aW + 1) and (ring.size - 1)
                if (nxt == aR) break   // full: drop the rest of this block rather than block the DSP thread
                ring[aW] = convOut[i]
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
