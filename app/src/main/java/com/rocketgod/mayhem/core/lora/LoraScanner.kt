package com.rocketgod.mayhem.core.lora

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.ham.ChannelDecimator
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * One LoRa frame the scanner heard: the frame, the channel it came on (Hz, the measured frequency error included),
 * whether its chirps ran downward (a LoRaWAN downlink), and when (ms since the epoch).
 */
class LoraHeard(val frame: LoraFrame, val hz: Long, val inverted: Boolean, val timeMs: Long)

/**
 * Not a Mayhem port: the LoRa app's processor. One wide span (20 MHz on a HackRF) is watched for bursts; each burst's
 * width gives its bandwidth, the known channel plans give its spreading factor where they can, and a channel of its
 * own (mixed down, decimated, resampled to one sample a chip) runs LoRa receivers on it, from a little before the
 * burst began, until it ends. The channels decode on a worker thread of their own, behind the radio's, side by side.
 * Kotlin twin of the iOS LoraScanner.swift.
 */
class LoraScanner : IqProcessor {
    @Volatile var centerOf: () -> Long = { 0L }
    var onHeard: ((LoraHeard) -> Unit)? = null
    /** Each burst that got a channel of its own: (Hz, bandwidth, plan name or null). */
    var onBurst: ((Long, Int, String?) -> Unit)? = null
    /**
     * Each transmission a receiver confirmed as LoRa (a preamble with its timing solved): (Hz, bandwidth). A channel
     * opened for a burst ([onBurst]) is often not LoRa at all (the band's meters hop through it all the time), so this
     * is what "LoRa bursts heard" counts.
     */
    var onLora: ((Long, Int) -> Unit)? = null
    /** Off for replays and tests, which run at their own pace (and decode inline). */
    var shedding = true
    var busy = 0.0; private set
    /** Samples a channel receiver threw away because it fell too far behind (a frame passing through is lost). */
    @Volatile var skipped = 0L; private set

    /**
     * Asked for a narrower span than [rate] when this device can't keep up with it: a slower phone (or one that has
     * heated up) still decodes what a narrower span holds, where a span it can't keep up with decodes nothing.
     */
    @Volatile var onTooMuch: ((Int) -> Unit)? = null
    private var strain = 0
    @Volatile private var channelCount = 0

    /**
     * Once a second, from the engine: the share of the radio's buffers it threw away and the channel time skipped.
     * Five seconds out of the last few behind asks for less; after that it waits a while to see the narrower span settle.
     */
    fun load(dropShare: Double, skippedSec: Double) {
        val behind = dropShare > 0.05 || skippedSec / max(1, channelCount) > 0.25 || busy > 1.0
        strain = if (behind) strain + 1 else max(0, strain - 1)
        if (strain >= 5) { strain = -15; onTooMuch?.invoke(rate) }
    }

    // ---- detection ----
    private var rate = 0; private var N = 2048; private var HOP = 10_000
    private var win = FloatArray(2048); private var re = FloatArray(2048); private var im = FloatArray(2048)
    private var floorP = FloatArray(0)
    /** How often each bin has been hot lately (decays over about 60 ms): a chirp sweeps its whole channel evenly, an FSK burst leaves gaps. */
    private var occ = FloatArray(0)
    /** Each bin's power over the same time: a real channel stands well above the band just outside its edges, a strong neighbor's splash does not. */
    private var lvl = FloatArray(0)
    /** The sample each bin was last hot at. */
    private var hotAt = LongArray(0)
    private var frames = 0
    private val binHz: Double get() = rate.toDouble() / N
    /** The last 0.4 s of samples, written here (the radio's thread) and read by the channel worker behind it. */
    @Volatile private var ring = ByteArray(2); private var ringSize = 0; @Volatile private var ringMask = 0
    private var written = 0L; private var nextFrame = 0L

    private class Region(var lo: Int, var hi: Int, var start: Long, var last: Long) {
        /** When its width last grew: a chirp's sweep widens a burst until it has covered the whole channel once. */
        var grew = last
        val spawned = ArrayList<Pair<Int, Double>>()
        /** Looks it was hot in: a chirp is there in nearly every look, noise only now and then. */
        var hits = 1
        /** Its strongest bin at each look from the start, for the chirp test. */
        val track = ArrayList<Int?>()
        var trackLook = 0
    }
    private val regions = ArrayList<Region>()

    /** A known channel inside the span, its bins, and whether it is on the air now. */
    private class Slot(val ch: LoraChannel, val lo: Int, val hi: Int, val below: IntRange?, val above: IntRange?) {
        var active = false
        /** Listened to all the time (standing), never opened by a burst. */
        var standing = false
        /** The current stretch of activity in it: when it began and when it was last hot. */
        var firstHot = 0L; var lastHot = 0L
        /** The strongest bin in it at each look since its activity began (null: nothing hot in that look). */
        val track = ArrayList<Int?>()
        var trackLook = -1
    }
    private val slots = ArrayList<Slot>()
    private var slotCenter = -1L

    /** Radio thread: each channel handed to the worker, what keeps it open, and until when. */
    private class Owner(val r: Region?, val s: Slot?, val until: Long)
    private val owners = LinkedHashMap<Int, Owner>()
    private var nextId = 0
    // Shared with the worker, under the lock: new channels, how far each may run, how far the samples go.
    private val lock = Any()
    private val inbox = ArrayList<Extractor>()
    private val untils = HashMap<Int, Long>()
    @Volatile private var latest = 0L
    private var scheduled = false
    /** Channels the worker has retired since the radio thread last looked. */
    private val finished = ArrayList<Int>()
    // Worker only.
    private val extractors = ArrayList<Extractor>()
    private val recent = ArrayList<LongArray>()      // (payload hash, sample) of frames already reported

    override fun reset(rate: Int) {
        // the detect thread owns everything below: a reset from the radio's thread waits for it to take it
        if (shedding && Thread.currentThread().name != DETECT_NAME) {
            feed.clear()
            runCatching { detect.submit { resetHere(rate) }.get() }
            return
        }
        resetHere(rate)
    }

    private fun resetHere(rate: Int) {
        this.rate = rate
        N = 256; while (rate.toDouble() / N > 10_000) N = N shl 1
        HOP = max(N, rate / 2000)
        val n = N
        win = FloatArray(n) { (0.5 - 0.5 * cos(2 * Math.PI * it / n)).toFloat() }
        re = FloatArray(n); im = FloatArray(n)
        floorP = FloatArray(n); occ = FloatArray(n); lvl = FloatArray(n); hotAt = LongArray(n) { -1_000_000_000L }; frames = 0
        // 0.4 s of history: a burst is only recognized as LoRa some way into its preamble
        var size = 1
        while (size < (rate * 0.4).toInt()) size = size shl 1
        runCatching { worker.submit { extractors.clear(); recent.clear() }.get() }
        synchronized(lock) { inbox.clear(); untils.clear(); finished.clear(); latest = 0; scheduled = false }
        ring = ByteArray(2 * size) { 128.toByte() }
        ringSize = size; ringMask = size - 1
        written = 0; nextFrame = n.toLong(); regions.clear(); owners.clear(); slots.clear(); slotCenter = -1
    }

    /**
     * Radio's thread: hand the buffer to the detect thread and return. Everything the scanner does per look ran here
     * before, and at 20 Msps on a phone that held this thread past real time, so the engine dropped over half the
     * radio's buffers. If the detect thread falls behind in turn, the hand-off queue overflows and the lost samples
     * count as skipped (the health line says so).
     */
    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (!shedding) { process(iq, len, rate); return }
        val b = spare.poll()?.takeIf { it.size == len } ?: ByteArray(len)
        System.arraycopy(iq, 0, b, 0, len)
        if (!feed.offer(Chunk(b, len, rate))) { skipped += len / 2; spare.offer(b) }
        if (draining.compareAndSet(false, true)) detect.execute(drain)
    }

    /** Detect thread: everything queued, then a last look so a buffer offered while it was finishing isn't stranded. */
    private val drain = Runnable {
        while (true) {
            while (true) { val c = feed.poll() ?: break; runCatching { process(c.b, c.len, c.rate) }; spare.offer(c.b) }
            draining.set(false)
            if (feed.isEmpty() || !draining.compareAndSet(false, true)) break
        }
    }

    private class Chunk(val b: ByteArray, val len: Int, val rate: Int)
    /** Buffers waiting for the detect thread (about 0.4 s at 20 Msps), and spent ones for reuse. */
    private val feed = java.util.concurrent.ArrayBlockingQueue<Chunk>(1024)
    private val spare = java.util.concurrent.ConcurrentLinkedQueue<ByteArray>()
    private val draining = java.util.concurrent.atomic.AtomicBoolean(false)

    /** Detect thread (or inline for replays and tests): the ring, the looks, and the hand-off to the channels. */
    private fun process(iq: ByteArray, len: Int, rate: Int) {
        if (ringSize == 0 || rate != this.rate) resetHere(rate)
        val t0 = System.nanoTime()
        val n = len / 2
        var k = 0
        val rg = ring
        while (k < n) {
            // copy up to the next look in one run
            val upto = min(n, k + (nextFrame - written).toInt())
            var j = k
            while (j < upto) {
                val p = ((written + (j - k)) and ringMask.toLong()).toInt()
                val run = min(upto - j, ringSize - p)
                System.arraycopy(iq, 2 * j, rg, 2 * p, 2 * run)
                j += run
            }
            written += (upto - k); k = upto
            if (written == nextFrame) { detect(); nextFrame += HOP }
        }
        handOff()
        val used = (System.nanoTime() - t0) / 1e9; val air = n.toDouble() / rate
        if (air > 0) busy += 0.1 * (used / air - busy)
    }

    /** The known channels that fall inside the span (clear of its edges), as bin ranges. */
    private fun placeSlots(center: Long) {
        slotCenter = center
        // the old standing channels were tuned to the old center: they finish where they are
        for ((id, o) in owners.entries.toList()) if (o.s?.standing == true) owners[id] = Owner(o.r, null, written)
        slots.clear()
        val half = rate / 2.0 * 0.96
        for (c in plan) {
            val off = (c.hz - center).toDouble()
            if (abs(off) + c.bw / 2.0 > half) continue
            fun bin(f: Double): Int = Math.round((off + c.bw * f) / binHz + N / 2).toInt()
            val lo = bin(-0.4); val hi = bin(0.4)
            fun guardBand(a: Int, b: Int): IntRange? { val x = max(a, 0); val y = min(b, N - 1); return if (y >= x) x..y else null }
            val below = guardBand(bin(-0.8), min(bin(-0.6), lo - 1)); val above = guardBand(max(bin(0.6), hi + 1), bin(0.8))
            if (hi - lo >= 3) slots.add(Slot(c, lo, hi, below, above))
        }
        for (sl in slots) if (sl.ch.standing) {
            sl.standing = true
            sl.active = spawn(sl.ch.hz, sl.ch.bw, sl.ch.sf, false, written, null, sl, sl.ch.name, standing = true)
        }
    }

    private fun detect() {
        val n = N
        val s0 = written - n
        var p0 = (s0 and ringMask.toLong()).toInt()
        val rg = ring
        for (k in 0 until n) {
            re[k] = ((rg[2 * p0].toInt() and 0xff) - 127.4f) * win[k]; im[k] = ((rg[2 * p0 + 1].toInt() and 0xff) - 127.4f) * win[k]
            p0 = (p0 + 1) and ringMask
        }
        Dsp.fft(re, im)
        frames++
        val hot = ArrayList<Int>()
        val dc = (15_000 / binHz).toInt() + 1
        var top = 0f
        for (k in 0 until n) {
            val b = (k + n / 2) and (n - 1)
            val p = re[k] * re[k] + im[k] * im[k]
            re[k] = p
            var f = floorP[b]
            if (frames <= 8) f = if (frames == 1) p else f + 0.3f * (p - f)
            else if (p < f * 4) f += 0.02f * (p - f) else f += 0.0005f * (p - f)
            floorP[b] = f
            // each bin's occupancy decays and its level follows, in the same pass
            occ[b] *= 0.992f; lvl[b] += 0.008f * (p - lvl[b])
            if (frames > 8 && abs(b - n / 2) > dc && p > f * 14) { hot.add(b); top = max(top, p) }
        }
        // a transmitter right beside the radio overloads it and splashes across the whole span: only what is within
        // 30 dB of the strongest signal in this look counts
        hot.removeAll { re[(it + n / 2) and (n - 1)] < top * 1e-3f }
        hot.sort()
        // unboxed from here: every known channel looks through these each look
        val hh = hot.toIntArray(); val hn = hh.size
        for (b in hh) { occ[b] += 1f; hotAt[b] = written }
        // each known channel's strongest hot bin this look, for the chirp test
        if (hn > 0) {
            for (sl in slots) {
                if (sl.active) continue
                var best = -1; var bp = 0f
                // the first hot bin at or above the channel's bottom, then only its own
                var q = java.util.Arrays.binarySearch(hh, sl.lo); if (q < 0) q = -q - 1
                while (q < hn && hh[q] <= sl.hi) { val b = hh[q]; val p = re[(b + n / 2) and (n - 1)]; if (p > bp) { bp = p; best = b }; q++ }
                if (best < 0) continue
                if (written - sl.lastHot > (rate * 0.015).toLong() || sl.track.isEmpty()) { sl.track.clear(); sl.trackLook = frames - 1 }
                // the latest looks, not the first: a spur or a neighbor's splash can hold the strongest bin at a
                // frame's very start
                while (sl.trackLook < frames - 1) { sl.track.add(null); sl.trackLook++ }
                sl.track.add(best); sl.trackLook = frames
                if (sl.track.size > 16) sl.track.subList(0, sl.track.size - 16).clear()
            }
        }
        val center = centerOf()
        if (center != slotCenter) placeSlots(center)
        if (frames % 4 == 0) watchSlots()

        // the channels no plan knows: clusters of hot bins grouped into bursts
        var i = 0
        val gap = 2
        while (i < hn) {
            var j = i + 1
            while (j < hn && hh[j] - hh[j - 1] <= 2) j++
            val lo = hh[i]; val hi = hh[j - 1]
            var peakBin = lo; var pp = 0f
            for (q in i until j) { val v = re[(hh[q] + n / 2) and (n - 1)]; if (v > pp) { pp = v; peakBin = hh[q] } }
            val r = regions.firstOrNull { lo <= it.hi + gap && hi >= it.lo - gap && (max(hi, it.hi) - min(lo, it.lo)) * binHz <= 520_000 }
            if (r != null) {
                if (lo < r.lo || hi > r.hi) { r.lo = min(r.lo, lo); r.hi = max(r.hi, hi); r.grew = written }
                if (r.last != written) r.hits++
                r.last = written
                if (r.track.size < 24) {
                    while (r.trackLook < frames - 1 && r.track.size < 24) { r.track.add(null); r.trackLook++ }
                    if (r.trackLook == frames - 1) { r.track.add(peakBin); r.trackLook = frames }
                }
            } else {
                val nr = Region(lo, hi, s0, written)
                nr.track.add(peakBin); nr.trackLook = frames
                regions.add(nr)
            }
            i = j
        }
        // a chirp wrapping from the top of its channel to the bottom starts a second region: once they meet, one burst
        var k = 0
        while (k < regions.size) {
            val a = regions[k]
            val j = (k + 1 until regions.size).firstOrNull { regions[it].lo <= a.hi + 2 && regions[it].hi >= a.lo - 2 && (max(a.hi, regions[it].hi) - min(a.lo, regions[it].lo)) * binHz <= 520_000 }
            if (j != null) {
                val b = regions[j]
                a.lo = min(a.lo, b.lo); a.hi = max(a.hi, b.hi); a.start = min(a.start, b.start); a.last = max(a.last, b.last)
                a.grew = max(a.grew, b.grew); a.spawned.addAll(b.spawned); a.hits = max(a.hits, b.hits)
                for ((id, o) in owners.entries.toList()) if (o.r === b) owners[id] = Owner(a, o.s, o.until)
                regions.removeAt(j)
            } else k++
        }
        val quiet = (rate * 0.15).toLong()
        regions.removeAll { written - it.last > quiet || written - it.start > rate.toLong() * 8 }
        for (r in regions.toList()) consider(r)
    }

    /** A known channel goes on the air when nearly all of it has been swept lately; it gets its own receivers then. */
    private fun watchSlots() {
        val gap = (rate * 0.015).toLong()
        for (s in slots) {
            var last = -1_000_000_000L
            for (b in s.lo..s.hi) if (hotAt[b] > last) last = hotAt[b]
            if (last > s.lastHot) { if (last - s.lastHot > gap) s.firstHot = last; s.lastHot = last }
            if (s.standing) continue
            if (s.active) {
                // off once quiet for three symbols (at the slowest spreading factor it could be)
                val sym = (1 shl (s.ch.sf ?: 12)).toDouble() / s.ch.bw
                if ((written - s.lastHot) > rate * max(0.03, 3 * sym)) { s.active = false; trace?.invoke("slot off %.1f ms %s".format(written.toDouble() / rate * 1000, s.ch.name)) }
                continue
            }
            // the band's FSK bursts are over in 25 ms; a LoRa frame lasts longer
            val traced = traceHz != 0.0 && abs(s.ch.hz - traceHz) < 1000
            fun why(w: String) { if (traced) trace?.invoke("slot %.1f ms %s: %s".format(written.toDouble() / rate * 1000, s.ch.name, w)) }
            if (written - s.lastHot > gap) continue
            if (written - s.firstHot < (rate * 0.03).toLong()) { why("young"); continue }
            var on = 0
            for (b in s.lo..s.hi) if (occ[b] > 0.25f) on++
            val cover = on.toDouble() / (s.hi - s.lo + 1)
            if (cover < 0.75) { why("cover %.2f".format(cover)); continue }
            fun mean(r: IntRange?): Float { if (r == null) return 0f; var t = 0f; for (b in r) t += lvl[b]; return t / (r.last - r.first + 1) }
            var inside = 0f
            for (b in s.lo..s.hi) inside += lvl[b]
            inside /= (s.hi - s.lo + 1)
            val edge = max(mean(s.below), mean(s.above))
            if (inside <= 6 * edge) { why("edges %.1f".format(inside / max(edge, 1e-9f))); continue }
            if (!chirps(s.track.takeLast(16), s.ch.bw)) { why("not a chirp"); continue }
            // one transmission at a time per stretch of band: a channel overlapping one already on is the same
            // signal (or its splash)
            val o = slots.firstOrNull { it !== s && it.active && it.hi >= s.lo && it.lo <= s.hi }
            if (o != null) { why("overlaps " + o.ch.name); continue }
            trace?.invoke("slot on %.1f ms %s cover %.2f".format(written.toDouble() / rate * 1000, s.ch.name, cover))
            s.active = spawn(s.ch.hz, s.ch.bw, s.ch.sf, s.ch.name.contains("downlink"), s.firstHot - (rate * 0.02).toLong(), null, s, s.ch.name)
        }
    }

    /**
     * A preamble's chirps move the peak across the channel at one steady rate (wrapping at its edge); an FSK burst's
     * peak jumps between its tones.
     */
    private fun chirps(track: List<Int?>, bw: Int): Boolean {
        val width = bw / binHz
        val diffs = ArrayList<Double>()
        for (i in 1 until max(1, min(track.size, 16))) {
            val a = track[i - 1] ?: continue; val b = track[i] ?: continue
            var d = (b - a).toDouble().rem(width)
            if (d < -width / 2) d += width else if (d >= width / 2) d -= width
            diffs.add(d)
        }
        if (diffs.size < 6) return false
        val med = diffs.sorted()[diffs.size / 2]
        val fit = diffs.count { abs(it - med) <= 1.5 }
        return fit >= 0.6 * diffs.size
    }

    /**
     * A burst wide enough for LoRa and long enough not to be one of the band's short FSK bursts gets a channel at the
     * bandwidth its width says; as a slow chirp's sweep widens the burst, a wider channel is tried too.
     */
    private fun consider(r: Region) {
        val width = (r.hi - r.lo + 1) * binHz
        // the band's FSK bursts last 25 ms at most; a LoRa frame on a channel no plan knows lasts longer
        if (width < 45_000 || r.spawned.size >= 3 || written - r.start < (rate * 0.04).toLong()) return
        val looks = (written - r.start).toDouble() / HOP + 1
        if (r.hits < 0.4 * looks) return
        val bw = BWS.firstOrNull { it >= width * 0.85 } ?: return
        // wait until the width has held for half a symbol at SF12 of that bandwidth (a slower chirp is still sweeping)
        if ((written - r.grew) < rate * 2048.0 / bw) return
        val off = ((r.lo + r.hi) / 2.0 - N / 2) * binHz
        if (r.spawned.any { it.first == bw && abs(it.second - off) < bw / 8.0 }) return
        if (!chirps(r.track, bw)) { r.spawned.add(bw to off); return }
        r.spawned.add(bw to off)
        // a known channel on the air here already has its own receivers
        if (slots.any { it.active && it.hi >= r.lo && it.lo <= r.hi }) return
        // to the kHz: well inside what a LoRa receiver corrects, and it keeps the channel's oscillator table short
        val hz = centerOf() + Math.round(off / 1000.0) * 1000
        val from = r.start - (rate * 0.01).toLong()
        spawn(hz, bw, null, true, from, r, null, null)
    }

    /** A channel of its own for a burst; false when there is no room (the known channels keep room the others can't take). */
    private fun spawn(hz: Long, bw: Int, sf: Int?, inverted: Boolean, from0: Long, r: Region?, s: Slot?, name: String?, standing: Boolean = false): Boolean {
        trace?.invoke("spawn %.1f ms %.4f MHz bw %d %s".format(written.toDouble() / rate * 1000, hz / 1e6, bw, name ?: "-"))
        val open = owners.values.filter { it.s?.standing != true }
        if (!standing) {
            if (shedding && busy > 0.8) return false
            if (open.size >= 10 || (s == null && open.count { it.s == null } >= 4)) return false
        }
        // at most three quarters of the ring back: one started at its very end was overwritten before it ran, skipped
        // half a ring ahead (and lost its preamble), and counted as a channel falling behind
        val from = maxOf(from0, written - ringMask * 3L / 4, 0L)
        val sfs = if (sf != null) listOf(sf) else (7..12).toList()
        nextId++
        val e = Extractor(nextId, rate, (hz - centerOf()).toDouble(), bw, hz, from, sfs, inverted, if (s != null) 4 else 2)
        val t = trace
        if (t != null && traceHz != 0.0 && abs(hz - traceHz) < 1000) { e.traceAll { t("rx: $it") }; e.tapped = true }
        val until = if (standing) Long.MAX_VALUE / 4 else written + (rate * 0.2).toLong()
        owners[nextId] = Owner(r, s, until)
        synchronized(lock) { inbox.add(e); untils[nextId] = until }
        onBurst?.invoke(hz, bw, name)
        return true
    }

    /** Radio thread, after each buffer: how far each channel may run now, then the worker's turn. */
    private fun handOff() {
        val tail = (rate * 0.05).toLong()
        for ((id, o) in owners.entries.toList()) {
            var u = o.until
            if (o.r != null) u = max(u, o.r.last + tail)
            val s = o.s
            if (s != null && !s.standing) {
                // a few symbols past the last time the channel was heard (a weak frame drops out of the looks now and then)
                val sym = (1 shl (s.ch.sf ?: 12)).toDouble() / s.ch.bw
                u = max(u, s.lastHot + (rate * max(0.05, 3 * sym)).toLong())
            }
            if (u != o.until) owners[id] = Owner(o.r, o.s, u)
        }
        val go: Boolean
        synchronized(lock) {
            for (id in finished) owners.remove(id)
            finished.clear()
            for ((id, o) in owners) untils[id] = o.until
            latest = written
            go = !scheduled
            scheduled = true
        }
        if (!shedding) runExtractors()
        else if (go) worker.execute { runCatching { runExtractors() } }
    }

    /** Worker: run every channel up to where its samples and its time go, and retire the finished ones. */
    private fun runExtractors() {
        val upTo: Long
        synchronized(lock) {
            extractors.addAll(inbox); inbox.clear()
            upTo = latest
            for (e in extractors) untils[e.id]?.let { e.until = it }
            scheduled = false
        }
        // each channel is independent: they run side by side, one core each, and never wait for one another (a
        // slow channel held back every other one when they ran in rounds, with cores sitting idle)
        val list = extractors.toList(); val r = ring; val mask = ringMask
        channelCount = list.size
        val behind = ringMask.toLong() - rate / 50; val back = (ringMask / 2).toLong()
        for (e in list) {
            val job = Runnable {
                try {
                    // the newest written sample when it starts, not when it was queued
                    val top = latest
                    if (top - e.pos > behind) { skipped += (top - back) - e.pos; e.pos = top - back }   // fell behind
                    val end = min(top, e.until)
                    if (end > e.pos) e.run(end, r, mask)
                } catch (_: Throwable) {
                } finally { e.busy.set(false) }
            }
            if (!shedding) { e.busy.set(true); job.run() }
            else if (e.busy.compareAndSet(false, true)) pool.execute(job)
        }
        val gone = ArrayList<Int>()
        extractors.removeAll { e ->
            if (e.busy.get()) return@removeAll false
            val done = (e.pos >= e.until && upTo >= e.until) || (e.until < Long.MAX_VALUE / 8 && upTo - e.born > rate.toLong() * 8)
            if (done) {
                gone.add(e.id)
                for ((f, inv, at) in e.bad) if (e.goodAt.none { abs(it - at) < rate }) onHeard?.invoke(LoraHeard(f, e.hz + f.cfoHz.toLong(), inv, System.currentTimeMillis()))
            }
            done
        }
        if (gone.isNotEmpty()) synchronized(lock) { for (id in gone) untils.remove(id); finished.addAll(gone) }
    }

    /** Channels decode side by side: what they report goes through here one at a time. */
    private val heardLock = Any()

    private fun heard(f: LoraFrame, e: Extractor, inv: Boolean) = synchronized(heardLock) {
        // a damaged frame waits: another timing phase may yet get it right, and the phases' damaged copies differ
        val at = e.pos
        if (f.crcOk == false) { if (e.bad.none { at - it.third < rate }) e.bad.add(Triple(f, inv, at)); return@synchronized }
        e.goodAt.add(at)
        var h = 5381L
        for (b in f.payload) h = h * 33 + b
        recent.removeAll { abs(at - it[1]) > rate.toLong() * 3 }
        if (recent.any { it[0] == h }) return@synchronized
        recent.add(longArrayOf(h, at))
        onHeard?.invoke(LoraHeard(f, e.hz + f.cfoHz.toLong(), inv, System.currentTimeMillis()))
    }

    // ---- a channel ----
    private inner class Extractor(val id: Int, rate: Int, offHz: Double, val bw: Int, val hz: Long, from: Long, sfs: List<Int>, inverted: Boolean, private val phases: Int) {
        @Volatile var pos = from
        /** On a core now; the worker hands it more only once it is done. */
        val busy = java.util.concurrent.atomic.AtomicBoolean(false)
        val born = from
        @Volatile var until = 0L
        var tapped = false
        /** A receiver of this channel has found a LoRa preamble. */
        var confirmed = false
        val bad = ArrayList<Triple<LoraFrame, Boolean, Long>>()
        val goodAt = ArrayList<Long>()
        private val dec = ChannelDecimator(max(1, rate / (2 * bw)))
        private val poly: FloatArray
        private val step: Double
        private var t = (TAPS / 2).toDouble()
        private var subK = 0
        private var y = FloatArray(0); private var yLen = 0      // resampler input, interleaved
        // the channel's oscillator in floats: this loop runs once a sample per channel at the full span rate
        private var cr = 1f; private var ci = 0f
        private val sr: Float; private val si: Float
        private var mixed = FloatArray(0); private var mid = FloatArray(0)
        /** The oscillator as an integer table when the offset repeats soon enough: the mixer then runs fused into the CIC. */
        private val osc: IntArray? = if (dec.cicD > 1 && offHz == Math.rint(offHz)) ChannelDecimator.oscTable(offHz.toLong(), rate) else null
        /**
         * Receivers by (spreading factor, inverted, timing phase): a chip sampled a fraction off its center loses a
         * lot of a critically sampled chirp, so each one also listens a half (and quarter) chip later.
         */
        private val rx = ArrayList<Triple<LoraReceiver, Boolean, Int>>()
        private var count = 0

        init {
            val r1 = rate.toDouble() / dec.total
            step = r1 / bw
            // cut a little past the channel's edges: sampled at one sample a chip, what a chirp has just past its edge
            // folds back onto itself as LoRa expects; Blackman window, each phase summing to 1
            val fc = 0.6 * bw / r1; val tt = TAPS; val pp = PHASES
            val h = FloatArray(tt * pp)
            for (ph in 0 until pp) {
                val frac = ph.toDouble() / pp
                var sum = 0.0
                for (k in 0 until tt) {
                    val x = (k - tt / 2 + 1) - frac
                    val sinc = if (x == 0.0) 2 * fc else sin(2 * Math.PI * fc * x) / (Math.PI * x)
                    val u = (x + tt / 2.0) / tt
                    val w = if (u <= 0 || u >= 1) 0.0 else 0.42 - 0.5 * cos(2 * Math.PI * u) + 0.08 * cos(4 * Math.PI * u)
                    h[ph * tt + k] = (sinc * w).toFloat(); sum += sinc * w
                }
                for (k in 0 until tt) h[ph * tt + k] = (h[ph * tt + k] / sum).toFloat()
            }
            poly = h
            val w = -2 * Math.PI * offHz / rate
            sr = cos(w).toFloat(); si = sin(w).toFloat()
            // the oscillator starts at the phase the absolute sample count gives, so it doesn't matter where it begins
            val ph0 = w * (from % rate)
            cr = cos(ph0).toFloat(); ci = sin(ph0).toFloat()
            for (sf in sfs) for (inv in if (inverted) listOf(false, true) else listOf(false)) for (ph in 0 until phases) {
                val rcv = LoraReceiver(sf, bw)
                rcv.onFrame = { f -> heard(f, this, inv) }
                // once a channel: its timing phases all see the same transmission
                rcv.onAligned = { if (!confirmed) { confirmed = true; onLora?.invoke(hz, bw) } }
                rx.add(Triple(rcv, inv, ph))
            }
        }

        fun traceAll(f: (String) -> Unit) { for ((r, inv, ph) in rx) if (!inv && ph == 0) r.trace = { f("sf${r.sf} $it") } }

        fun run(end: Long, ring: ByteArray, mask: Int) {
            while (pos < end) {
                val n = min(end - pos, 65_536L).toInt()
                val ot = osc
                if (ot != null) {
                    if (mid.size < dec.outSize(n)) mid = FloatArray(dec.outSize(n))
                    // the table's phase follows the absolute sample count, so a channel that skipped ahead stays in step
                    val m = dec.processMix(ring, mask, pos, n, ot, (pos % (ot.size / 2)).toInt(), mid)
                    pos += n
                    if (yLen + 2 * m > y.size) y = y.copyOf(max(2 * y.size, yLen + 2 * m))
                    System.arraycopy(mid, 0, y, yLen, 2 * m); yLen += 2 * m
                    resample()
                    continue
                }
                if (mixed.size < 2 * n) mixed = FloatArray(2 * n)
                for (k in 0 until n) {
                    val p = ((pos + k) and mask.toLong()).toInt() * 2
                    val i = (ring[p].toInt() and 0xff) - 127.4f; val q = (ring[p + 1].toInt() and 0xff) - 127.4f
                    mixed[2 * k] = i * cr - q * ci; mixed[2 * k + 1] = i * ci + q * cr
                    val tr = cr * sr - ci * si; ci = cr * si + ci * sr; cr = tr
                    count++
                    if (count and 255 == 0) { val g = 1f / sqrt(cr * cr + ci * ci); cr *= g; ci *= g }
                }
                pos += n
                if (mid.size < dec.outSize(n)) mid = FloatArray(dec.outSize(n))
                val m = dec.process(mixed, n, mid)
                if (yLen + 2 * m > y.size) y = y.copyOf(max(2 * y.size, yLen + 2 * m))
                System.arraycopy(mid, 0, y, yLen, 2 * m); yLen += 2 * m
                resample()
            }
        }

        /** From the decimated rate to exactly one sample a chip, through the windowed-sinc filter (which is also the channel filter). */
        private fun resample() {
            val outs = Array(phases) { FloatArrayBuilder() }
            val cnt = yLen / 2; val tt = TAPS; val pp = PHASES
            val sub = step / phases
            while (t + tt / 2 < cnt) {
                val i = t.toInt()
                val ph = min(pp - 1, ((t - i) * pp).toInt())
                val base = i - tt / 2 + 1
                var sre = 0f; var sim = 0f
                val o = ph * tt
                for (k in 0 until tt) { val c = poly[o + k]; sre += c * y[2 * (base + k)]; sim += c * y[2 * (base + k) + 1] }
                outs[subK].add(sre, sim)
                subK = (subK + 1) % phases
                t += sub
            }
            val drop = max(0, t.toInt() - tt / 2)
            if (drop > 0) { System.arraycopy(y, 2 * drop, y, 0, yLen - 2 * drop); yLen -= 2 * drop; t -= drop }
            if (outs[0].size == 0) return
            if (tapped) tap?.invoke(outs[0].toArray())
            for (p in 0 until phases) {
                if (outs[p].size == 0) continue
                val out = outs[p].toArray()
                var conj: FloatArray? = null
                for ((r, inv, ph) in rx) {
                    if (ph != p) continue
                    if (inv) {
                        val cj = conj ?: out.copyOf().also { c -> var k = 1; while (k < c.size) { c[k] = -c[k]; k += 2 }; conj = c }
                        r.push(cj)
                    } else r.push(out)
                }
            }
        }
    }

    /** A growable float list of interleaved I/Q pairs. */
    private class FloatArrayBuilder {
        private var a = FloatArray(256); var size = 0; private set
        fun add(x: Float, y: Float) { if (size + 2 > a.size) a = a.copyOf(2 * a.size); a[size++] = x; a[size++] = y }
        fun toArray(): FloatArray = a.copyOf(size)
    }

    companion object {
        /** 20 Msps: every LoRa bandwidth divides it exactly, and it is the widest a HackRF samples. */
        const val RATE = 20_000_000
        val BWS = intArrayOf(62_500, 125_000, 250_000, 500_000)
        /**
         * Every channel with a known modem, worldwide (LoraPlan): Meshtastic's regions and presets, MeshCore's presets,
         * LoRaWAN's plans. Those inside the span are watched; the standing ones listened to all the time.
         */
        val plan: List<LoraChannel> get() = LoraPlan.channels
        /** Debug: regions and receiver stages. */
        @Volatile var trace: ((String) -> Unit)? = null
        @Volatile var traceHz = 0.0
        /** Debug: the traced channel's samples at one a chip. */
        @Volatile var tap: ((FloatArray) -> Unit)? = null
        /** Windowed-sinc interpolator: TAPS taps at the decimated rate, PHASES fractional positions. */
        private const val TAPS = 32
        private const val PHASES = 128

        /**
         * The radio's threads run ahead of all of these (a buffer they can't take in time is lost to everyone), the
         * looks next (they feed every channel), the channels at the normal level: one falling behind skips, nothing drops.
         */
        private fun daemon(name: String, nice: Int) = ThreadFactory { r ->
            Thread({ runCatching { android.os.Process.setThreadPriority(nice) }; r.run() }, name).apply { isDaemon = true }
        }
        private const val DETECT_NAME = "mayhem-lora-detect"
        /** The looks, off the radio's thread. */
        private val detect = Executors.newSingleThreadExecutor(daemon(DETECT_NAME, -4))
        /** The channel worker, behind the radio's thread. */
        private val worker = Executors.newSingleThreadExecutor(daemon("mayhem-lora-channels", -2))
        /**
         * The cores the channels run on, side by side: all but three, which stay free for the radio's USB reads, the
         * engine and the looks (a channel that can't keep up skips; a radio buffer nobody takes is lost to everything).
         */
        private val pool = Executors.newFixedThreadPool(max(1, Runtime.getRuntime().availableProcessors() - 3), daemon("mayhem-lora-channel", 0))
    }
}
