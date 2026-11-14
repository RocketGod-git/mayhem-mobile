package com.rocketgod.mayhem.core.sonde

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.apps.Retuner
import com.rocketgod.mayhem.core.trains.Ddc
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * The Sondes front end: finds the carriers in the band, gives each one a channel (down-converter, FM discriminator,
 * frequency tracking) and runs every sonde decoder on it at once, so the type is whatever decodes. A radio that
 * samples the whole band (a HackRF at 8 Msps covers 400–406 MHz) watches every carrier at once; a narrower one (an
 * RTL-SDR) steps across the band in windows and stays on a window while a sonde in it decodes.
 * The Kotlin twin of web/src/dsp/sonde/front.ts and SondeFront.swift.
 */
data class SondeBand(val id: String, val title: String, val lo: Long, val hi: Long)

object SondeFront {
    val BANDS = listOf(
        SondeBand("400", "400–406 MHz", 400_000_000L, 406_000_000L),
        SondeBand("1680", "1680 MHz", 1_675_000_000L, 1_685_000_000L),
    )
    /** The channel rate every decoder works at. */
    const val CH_RATE = 48_000
    /** The whole-band span (HackRF): 8 Msps around a center off any common channel, so the DC spike sits between sondes. */
    const val WIDE = 8_000_000
    const val NARROW = 2_400_000
    const val MAX_CH = 8
    /** The channel filter half-width and rate per band: LMS6-1680 swings about ±50 kHz, the 400 MHz types a few kHz. */
    val CH_WIDTH: Map<String, Pair<Double, Double>> = mapOf("400" to (11_000.0 to 48_000.0), "1680" to (60_000.0 to 192_000.0))

    fun band(id: String): SondeBand = BANDS.firstOrNull { it.id == id } ?: BANDS[0]
    fun wideCenter(b: SondeBand): Long = Math.round((b.lo + b.hi) / 2.0 - 237_500)

    /** The windows a narrow radio steps through, keeping the inner ±0.9 MHz of each (the outer edge rolls off). */
    fun narrowWindows(b: SondeBand, rate: Int): List<Long> {
        val use = min(rate * 0.75, rate - 400_000.0); val out = ArrayList<Long>()
        var lo = b.lo.toDouble()
        while (lo < b.hi) { out.add(Math.round(min(lo + use / 2, b.hi - use / 2)) + 137_500); lo += use }
        return out
    }

    /** One log line per frame: type (upper case, so the log colors each type as its own kind), serial, GPS time,
     *  frame, position, height, climb, temperature. */
    fun line(f: SondeFrame, hz: Long): String {
        val parts = arrayListOf("${(f.model ?: f.type).uppercase(Locale.US)} ${f.serial}")
        f.timeS?.let { ts -> parts.add("%02d:%02d:%02d UTC".format(Locale.US, floor(ts / 3600).toLong() % 24, floor(ts / 60).toLong() % 60, floor(ts % 60).toLong())) }
        f.frame?.let { parts.add("#$it") }
        val la = f.lat; val lo = f.lon
        if (la != null && lo != null) parts.add("%.5f,%.5f".format(Locale.US, la, lo))
        f.alt?.let { parts.add("${Math.round(it)} m") }
        f.climb?.let { parts.add("${if (it >= 0) "+" else ""}${"%.1f".format(Locale.US, it)} m/s") }
        f.tempC?.let { parts.add("%.1f °C".format(Locale.US, it)) }
        f.rh?.let { parts.add("${Math.round(it)}%") }
        f.hPa?.let { parts.add("%.1f hPa".format(Locale.US, it)) }
        parts.add("%.3f MHz".format(Locale.US, hz / 1e6))
        return parts.joinToString(" · ")
    }
}

data class SondeChannelRow(val hz: Long, val level: Long, val ageMs: Long, val decoding: String, val frames: Int)

/** What the screen draws, every half second. [window]: the narrow radio's window (index, count); null on a wide one. */
data class SondeSnap(
    val sondes: List<SondeRow>, val channels: List<SondeChannelRow>, val wide: Boolean, val centerHz: Long, val band: String,
    val floor: Long, val window: Pair<Int, Int>?,
)

private class Channel(var hz: Long, private var center: Long, rate: Int, now: Long, band: String, sink: (SondeFrame, Channel) -> Unit) {
    val ddc: Ddc = (SondeFront.CH_WIDTH[band] ?: SondeFront.CH_WIDTH.getValue("400")).let { (cut, want) -> Ddc(cut, want, 63) }
    private var oi = FloatArray(0); private var oq = FloatArray(0)
    private var pi = 0f; private var pq = 0f
    private var afcAcc = 0.0; private var afcN = 0
    val decoders: List<ChannelDecoder>
    var openedMs = now; var lastCarrierMs = now; var lastDecodeMs = 0L; var frames = 0; var level = 0.0; var lastType = ""
    private var clock = 0L

    init {
        ddc.reset(rate.toDouble())
        ddc.offsetHz = (hz - center).toDouble()
        decoders = SondeBank.makeDecoders(ddc.outRate) { f -> lastDecodeMs = clock; frames++; lastType = f.type; sink(f, this) }
    }

    fun retarget(center: Long) { this.center = center; ddc.offsetHz = (hz - center).toDouble() }

    fun push(re: FloatArray, im: FloatArray, n: Int, now: Long) {
        clock = now
        val m = ddc.maxOut(n)
        if (oi.size < m) { oi = FloatArray(m); oq = FloatArray(m) }
        val k = ddc.push(re, im, n, oi, oq)
        for (dec in decoders) if (dec.hz != null) dec.hz = hz
        var pi = this.pi; var pq = this.pq
        val decs = decoders
        for (i in 0 until k) {
            val a = oi[i]; val b = oq[i]
            // discriminator: angle of the product with the previous sample's conjugate
            val d = atan2((b * pi - a * pq).toDouble(), (a * pi + b * pq).toDouble())
            pi = a; pq = b
            afcAcc += d; afcN++
            for (dec in decs) dec.push(d)
        }
        this.pi = pi; this.pq = pq
        // frequency tracking: a sonde drifts kHz as it cools; re-center when the mean offset passes 1.2 kHz
        if (afcN >= ddc.outRate) {
            val off = afcAcc / afcN * ddc.outRate / (2 * PI)
            if (abs(off) > 1200) { hz += Math.round(off * 0.8); ddc.offsetHz = (hz - center).toDouble() }
            afcAcc = 0.0; afcN = 0
        }
    }
}

/**
 * The Sondes receiver. Runs on the DSP thread; the screen reads [snap]. Frames go to [log] (one line each), notes
 * (carriers opened, sondes found, launched / burst / landed) to [onNote]. [retuner] moves a narrow radio between
 * windows; [centerOf] reads where the radio is (the engine's LO), so a hop or a band change is followed.
 */
class SondeProcessor(private val log: PacketLog, private val retuner: Retuner = Retuner()) : IqProcessor {
    @Volatile var band: SondeBand = SondeFront.BANDS[0]; private set
    var centerHz: Long = SondeFront.wideCenter(SondeFront.BANDS[0]); private set
    val tracker = SondeTracker()
    var centerOf: (() -> Long)? = null
    var onNote: ((String) -> Unit)? = null
    private val _snap = MutableStateFlow<SondeSnap?>(null)
    val snap: StateFlow<SondeSnap?> = _snap.asStateFlow()

    private var rate = SondeFront.WIDE
    private val nFft = 4096
    private val win = FloatArray(nFft) { (0.5 - 0.5 * cos(2 * PI * it / (nFft - 1))).toFloat() }
    private val fre = FloatArray(nFft); private val fim = FloatArray(nFft)
    private val acc = FloatArray(nFft); private var accFrames = 0
    private var re = FloatArray(0); private var im = FloatArray(0)
    private var chans = ArrayList<Channel>()
    /** Candidates seen at the last look (hz → times in a row), so a one-off spike never opens a channel. */
    private var seen = HashMap<Long, Int>()
    /** Carriers that held a channel without ever decoding: left alone for a while. */
    private val banned = HashMap<Long, Long>()
    private var lastLook = 0L; private var lastSnap = 0L
    private var windows: List<Long> = emptyList(); private var winIx = 0; private var winSince = 0L
    private var lastFloor = 0.0
    /** Sample time, ms: wall time at the start plus the samples since (the decoders' clock, also when replaying). */
    private var clockBase = System.currentTimeMillis(); private var samples = 0L
    fun now(): Long = clockBase + samples * 1000 / rate

    /** Asked for from another thread (the screen), carried out on the DSP thread before the next buffer. */
    @Volatile private var pendingBand: String? = null
    @Volatile private var pendingClear = false

    val wide: Boolean get() = rate >= 6_000_000
    /** Peaks closer than this are one carrier (a wide LMS6-1680 spreads ±50 kHz). */
    private val mergeHz: Long get() = if (band.id == "1680") 80_000L else 20_000L

    /** Switch band (any thread). */
    fun setBand(id: String) { band = SondeFront.band(id); pendingBand = id }
    private fun applyBand(id: String) {
        band = SondeFront.band(id)
        chans = ArrayList(); seen.clear(); banned.clear()
        windows = SondeFront.narrowWindows(band, rate); winIx = 0
    }

    override fun reset(rate: Int) {
        this.rate = rate; chans = ArrayList(); seen.clear(); acc.fill(0f); accFrames = 0
        windows = SondeFront.narrowWindows(band, rate)
        clockBase = System.currentTimeMillis(); samples = 0; winSince = now()
    }

    /** The span center moved (the user, or our own hop). */
    fun setCenter(hz: Long) {
        if (hz == centerHz) return
        centerHz = hz
        val half = rate * 0.45
        chans = ArrayList(chans.filter { abs(it.hz - hz) < half })
        for (c in chans) c.retarget(hz)
        acc.fill(0f); accFrames = 0; seen.clear()
    }

    fun tuned() = retuner.tuned()

    /** Forget every sonde and channel (any thread). */
    fun clear() { pendingClear = true; _snap.value = null }
    private fun applyClear() { tracker.clear(); chans = ArrayList(); seen.clear(); banned.clear() }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (rate != this.rate) reset(rate)
        pendingBand?.let { pendingBand = null; applyBand(it) }
        if (pendingClear) { pendingClear = false; applyClear() }
        centerOf?.let { val c = it(); if (c != centerHz) setCenter(c) }
        if (retuner.stale()) return
        val n = len shr 1
        if (re.size < n) { re = FloatArray(n); im = FloatArray(n) }
        val re = re; val im = im
        for (i in 0 until n) { re[i] = ((iq[2 * i].toInt() and 0xff) - 128) / 128f; im[i] = ((iq[2 * i + 1].toInt() and 0xff) - 128) / 128f }
        // a look at the spectrum every buffer or so (a slice of each, enough to average a carrier out of the noise)
        var off = 0
        while (off + nFft <= n && accFrames < 64) {
            for (k in 0 until nFft) { fre[k] = re[off + k] * win[k]; fim[k] = im[off + k] * win[k] }
            Dsp.fft(fre, fim)
            for (k in 0 until nFft) acc[k] += fre[k] * fre[k] + fim[k] * fim[k]
            accFrames++
            off += nFft * 8
        }
        samples += n
        val now = now()
        for (c in chans) c.push(re, im, n, now)
        if (now - lastLook >= 400 && accFrames >= 4) { look(now); lastLook = now }
        if (!wide) hop(now, n)
        if (now - lastSnap >= 500) { lastSnap = now; snapshot(now) }
    }

    private class Found(val hz: Long, val lvl: Double)

    /** Carriers in the averaged spectrum: local peaks well over the median floor, inside the band. */
    private fun look(now: Long) {
        val nn = nFft; val db = FloatArray(nn)
        for (k in 0 until nn) { val j = (k + nn / 2) % nn; db[k] = (10 * log10(acc[j].toDouble() / accFrames + 1e-20)).toFloat() }
        acc.fill(0f); accFrames = 0
        val sorted = db.copyOf(); sorted.sort(); val flo = sorted[nn shr 1]
        lastFloor = flo.toDouble()
        val binHz = rate.toDouble() / nn; val edge = floor(nn * 0.07).toInt(); val dc = ceil(2500 / binHz).toInt()
        val reach = max(2, Math.round(10_000 / binHz).toInt())
        val found = ArrayList<Found>()
        for (k in edge until nn - edge) {
            if (abs(k - nn / 2) <= dc) continue
            val v = db[k]
            if (v < flo + 8) continue
            var peak = true
            for (j in max(0, k - reach)..min(nn - 1, k + reach)) if (db[j] > v || (db[j] == v && j < k)) { peak = false; break }
            if (!peak) continue
            // power-weighted center over the carrier's own width
            var w = 0.0; var s = 0.0
            for (j in max(0, k - reach)..min(nn - 1, k + reach)) { val p = 10.0.pow((db[j] - flo) / 10.0) - 1; if (p > 0) { w += p; s += p * j } }
            val bin = if (w > 0) s / w else k.toDouble()
            val hz = Math.round(centerHz + (bin - nn / 2) * binHz)
            if (hz < band.lo - 20_000 || hz > band.hi + 20_000) continue
            found.add(Found(hz, (v - flo).toDouble()))
        }
        found.sortByDescending { it.lvl }
        // one carrier, one peak: a wide sonde (M10 at 9600 baud) has sideband peaks of its own within ±20 kHz
        val keep = ArrayList<Found>()
        // and a much weaker peak near a strong carrier is its spur, not a sonde
        for (f in found) if (keep.none { k -> abs(k.hz - f.hz) < mergeHz || (abs(k.hz - f.hz) < 100_000 && k.lvl > f.lvl + 18) }) keep.add(f)
        val seenNow = HashMap<Long, Int>()
        for (f in keep) {
            val ch = chans.firstOrNull { abs(it.hz - f.hz) < mergeHz }
            if (ch != null) { ch.lastCarrierMs = now; ch.level = f.lvl; continue }
            val key = Math.round(f.hz / 5000.0) * 5000
            if ((banned[key] ?: 0L) > now) continue
            val times = (seen[key] ?: 0) + 1
            seenNow[key] = times
            if (times >= 2 && chans.size >= SondeFront.MAX_CH) {
                // full: a clearly stronger carrier takes the place of the weakest channel that has not decoded
                var weak: Channel? = null
                for (c in chans) if (c.lastDecodeMs == 0L && (weak == null || c.level < weak.level)) weak = c
                if (weak != null && f.lvl > weak.level + 6) chans.remove(weak)
            }
            if (times >= 2 && chans.size < SondeFront.MAX_CH) {
                val c = Channel(f.hz, centerHz, rate, now, band.id) { fr, from -> heard(fr, from) }
                c.level = f.lvl; chans.add(c)
                onNote?.invoke("Sondes: carrier at ${"%.4f".format(Locale.US, f.hz / 1e6)} MHz, +${"%.0f".format(Locale.US, f.lvl)} dB, listening")
            }
        }
        seen = seenNow
        // close what went quiet; a carrier that never decodes is set aside (not a sonde, or one we can't read)
        chans = ArrayList(chans.filter { c ->
            val quietCarrier = now - c.lastCarrierMs > 15_000; val quietDecode = now - max(c.lastDecodeMs, c.openedMs) > 15_000
            if (quietCarrier && quietDecode) false
            else if (c.lastDecodeMs == 0L && now - c.openedMs > 45_000) { banned[Math.round(c.hz / 5000.0) * 5000] = now + 180_000; false }
            else true
        })
    }

    /** A narrow radio: step through the band's windows; stay while a sonde decodes or a fresh carrier is being tried. */
    private fun hop(now: Long, n: Int) {
        if (windows.size < 2) return
        val decoding = chans.any { it.lastDecodeMs != 0L && now - it.lastDecodeMs < 30_000 }
        val trying = chans.any { it.lastDecodeMs == 0L && now - it.openedMs < 12_000 }
        if (decoding || trying) { winSince = now; return }
        if (now - winSince < 2500) return
        winIx = (winIx + 1) % windows.size
        winSince = now
        retuner.next(windows[winIx], n, rate)
    }

    private fun heard(f: SondeFrame, ch: Channel) {
        val s = tracker.add(f, ch.hz, ch.level, now())
        if (s.frames == 1) onNote?.invoke("Sondes: ${f.model ?: f.type} ${f.serial} on ${"%.3f".format(Locale.US, ch.hz / 1e6)} MHz")
        for (e in tracker.events) onNote?.invoke("Sondes: $e")
        tracker.events.clear()
        log.add(SondeFront.line(f, ch.hz))
    }

    private fun snapshot(now: Long) {
        val channels = chans.map { c ->
            SondeChannelRow(c.hz, Math.round(c.level), now - c.openedMs, if (c.lastDecodeMs != 0L && now - c.lastDecodeMs < 10_000) c.lastType else "", c.frames)
        }
        _snap.value = SondeSnap(tracker.rows(now), channels, wide, centerHz, band.id, Math.round(lastFloor), if (wide) null else winIx to windows.size)
    }
}
