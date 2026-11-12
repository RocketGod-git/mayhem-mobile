package com.rocketgod.mayhem.core.analyzer

import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.r433.BurstChannel
import com.rocketgod.mayhem.core.r433.BurstChannels
import com.rocketgod.mayhem.core.r433.BurstFn
import com.rocketgod.mayhem.core.r433.KeyDecoders
import com.rocketgod.mayhem.core.r433.KeyReading
import com.rocketgod.mayhem.core.r433.MAX_CHANNELS
import com.rocketgod.mayhem.core.r433.PulseDetect
import com.rocketgod.mayhem.core.r433.R433
import com.rocketgod.mayhem.core.r433.fmtValue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min

/*
 * The Analyzer's capture: every burst in the span, kept whole.
 *
 * This is the Devices front end (`r433/BurstChannels.kt`) with a recorder on each channel. When something lights up
 * anywhere in the span, a narrow receiver is tuned to it from 12 ms before it began, and everything that receiver
 * hears (its envelope, its discriminator and its own I/Q samples, all at about 250 kHz) is kept until it lets go.
 * Each becomes one captured signal: when, where, how long and how strong.
 *
 * The same burst is also offered to every Devices decoder (rtl_433, ProtoPirate's car keys, Mayhem's remotes and
 * sensors), so a capture that is a known device says so. Twin of web/src/dsp/analyzer/capture.ts and Capture.swift.
 */

class Burst(
    val id: Int,
    /** Seconds since capture started (or into the file, for an import) at the burst's first kept sample. */
    val t: Double,
    /** Wall-clock time it ended, ms. */
    val wall: Long,
    /** Offset from the radio's center, Hz. */
    val hz: Double,
    /** The channel's sample rate. */
    val rate: Double,
    val n: Int,
    val env: ShortArray,
    val fm: ShortArray,
    /** Interleaved I, Q signed bytes at `rate`. */
    val iq: ByteArray,
    /** How long the carrier was up, ms (first rise to last fall). */
    val ms: Double,
    /** Peak level, dB below full scale, and over the noise before the burst. */
    val dbfs: Double,
    val snr: Double,
    /** What the Devices decoders made of it. */
    val matches: List<String>,
    /** The file it came from, for an import. */
    val src: String? = null,
)

/** A burst is kept for at most this long; past it, the rest is not stored (the decoders still hear it). */
const val MAX_BURST_S = 1.0
/** Carriers shorter than this are clicks, not signals. */
private const val MIN_BURST_MS = 0.5
/** Full scale of the envelope (see Baseband). */
private const val ENV_FULL = 16384.0

/**
 * Two bursts at the same time within 150 kHz are one signal followed twice: an FSK packet's tones and sidebands can
 * light the spectrum wide enough for the finder to open a second channel beside the first. The stronger is kept,
 * or, within 3 dB, the one that hears two tones the further apart (the one centered on the packet).
 */
private const val SHADOW_HZ = 150_000
private const val SHADOW_DB = 3
/** Bursts are held this long after they end (seconds), so a stronger one overlapping them can still claim them. */
private const val HOLD_S = 0.15

private val nextId = AtomicInteger(1)

/** What a decoder said, in a few words. */
fun matchLabel(r: KeyReading): String {
    val what = if (r.family == "key") "car key" else if (r.family == "remote") "remote" else "weather"
    return "$what: ${r.model}${if (r.id.isNotEmpty()) " ${r.id}" else ""}"
}

/**
 * The capture as a baseband processor: offset-128 samples in from the radio, [onBurst] with each burst kept, on the
 * thread that feeds it (the DSP thread, or an import's own thread).
 */
class AnalyzerCapture(private val onBurst: (Burst) -> Unit) : IqProcessor {
    private class Slot {
        var env = ShortArray(0); var fm = ShortArray(0); var iq = ByteArray(0); var n = 0; var t = 0.0; var hz = 0.0; var rate = 0.0
        val pd = PulseDetect(250_000.0)
        lateinit var keys: KeyDecoders
        val matches = LinkedHashSet<String>()
    }
    private class Held(val b: Burst, val end: Double, val spread: Double)
    private class Recent(val t0: Double, val t1: Double, val hz: Double, val snr: Double, val spread: Double)

    private val channels: BurstChannels
    private val slots = ArrayList<Slot>()
    private val radio = R433()
    private var rate = 0
    private var cur = 0
    /** Samples before the first one seen, for an import that starts part way in. */
    var offsetS = 0.0
    /** Stop keeping new bursts (the decoders and the finder carry on). */
    @Volatile var paused = false
    var src: String? = null
    /** Ended bursts not yet passed on, and the last few passed on, for the splatter check. */
    private val held = ArrayList<Held>()
    private val recent = ArrayList<Recent>()

    init {
        channels = BurstChannels({ ch, env, fm, n, iq -> onChannel(ch, env, fm, n, iq) }, { ch -> onEnd(ch) })
        channels.keepIq = true
        for (i in 0 until MAX_CHANNELS) {
            val slot = Slot()
            slot.keys = KeyDecoders { r -> slot.matches.add(matchLabel(r)) }
            slots.add(slot)
        }
    }

    /** Bursts being followed right now, and how many have been since the start, for the status line. */
    fun active(): Int = channels.active()
    fun followed(): Int = channels.opened

    override fun reset(rate: Int) { this.rate = rate; channels.reset(rate) }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (rate != this.rate) reset(rate)
        channels.process(iq, len)
        release(false)
    }

    /** Let every open channel go and pass on everything held: the end of an imported file. */
    fun finish() { channels.reset(rate); release(true) }

    /** The seconds a burst spans, for telling which overlap. */
    private fun span(b: Burst): Pair<Double, Double> = b.t to b.t + b.n / b.rate

    /**
     * Pass on the held bursts that have ended long enough ago, unless another burst at the same time and nearly the
     * same frequency was far stronger: then this one is that one's splatter (an FSK packet's sidebands open a
     * channel of their own beside it), not a signal.
     */
    private fun release(all: Boolean) {
        val now = offsetS + channels.samples.toDouble() / rate
        fun beats(snr: Double, spread: Double, b: Burst, bSpread: Double) = snr > b.snr + SHADOW_DB || (snr > b.snr - SHADOW_DB && spread > bSpread)
        fun shadowed(b: Burst, bSpread: Double): Boolean {
            val (a0, a1) = span(b)
            fun over(t0: Double, t1: Double, hz: Double) = t0 < a1 && t1 > a0 && abs(hz - b.hz) < SHADOW_HZ
            return held.any { h -> h.b !== b && span(h.b).let { (t0, t1) -> over(t0, t1, h.b.hz) } && beats(h.b.snr, h.spread, b, bSpread) } ||
                recent.any { r -> over(r.t0, r.t1, r.hz) && beats(r.snr, r.spread, b, bSpread) }
        }
        var i = 0
        while (i < held.size) {
            val h = held[i]
            if (!all && now - h.end < HOLD_S) { i++; continue }
            if (!shadowed(h.b, h.spread)) {
                val (t0, t1) = span(h.b)
                recent.add(Recent(t0, t1, h.b.hz, h.b.snr, h.spread))
                if (recent.size > 16) recent.removeAt(0)
                onBurst(h.b)
            }
            held.removeAt(i)
        }
    }

    /**
     * A completed rtl_433 burst of the channel being read. Decoded right here, as the web's worker does it, so the
     * burst's matches are complete when the channel closes (the Devices app decodes on a worker instead).
     */
    private val sink: BurstFn = { fsk, pulses ->
        for (r in radio.run(fsk, pulses)) if (!r.dev.disabled) {
            slots[cur].matches.add("rtl_433 ${r.dev.num}: ${r.data["model"]?.let { fmtValue(it) } ?: r.dev.name}${r.data["id"]?.let { " ${fmtValue(it)}" } ?: ""}")
        }
    }

    private fun onChannel(ch: BurstChannel, env: ShortArray, fm: ShortArray, n: Int, iq: ByteArray?) {
        val s = slots[ch.slot]
        cur = ch.slot
        if (ch.fresh) {
            s.n = 0; s.hz = ch.hz; s.rate = ch.rate; s.matches.clear()
            s.t = offsetS + channels.startOf(ch.slot).toDouble() / rate
            s.pd.setSampleRate(ch.rate); s.pd.reset(); s.keys.slicer.reset(ch.rate); s.keys.slicer.flush(); s.keys.reset()
        }
        s.pd.process(env, fm, n, sink)
        s.keys.slicer.process(env, fm, n)
        val cap = Math.round(ch.rate * MAX_BURST_S).toInt()
        val take = min(n, cap - s.n)
        if (take <= 0 || paused) return
        if (s.env.size < s.n + take) {
            var size = max(4096, s.env.size); while (size < s.n + take) size *= 2
            s.env = s.env.copyOf(size)
            s.fm = s.fm.copyOf(size)
            s.iq = s.iq.copyOf(size * 2)
        }
        System.arraycopy(env, 0, s.env, s.n, take)
        System.arraycopy(fm, 0, s.fm, s.n, take)
        if (iq != null) System.arraycopy(iq, 0, s.iq, s.n * 2, take * 2)
        s.n += take
    }

    private fun onEnd(ch: BurstChannel) {
        val s = slots[ch.slot]
        cur = ch.slot
        s.pd.flush(sink)
        s.keys.slicer.flush()
        if (paused || s.n < 16) return
        val n = s.n
        val noise = noiseOf(s.env, n, s.rate)
        val on = carrierOf(s.env, n, noise)
        var a = 0; var b = n; var peak = 0
        while (a < n && !on[a]) a++
        while (b > a && !on[b - 1]) b--
        val fmOn = DoubleBuf(b - a)
        for (i in a until b) { if (s.env[i] > peak) peak = s.env[i].toInt(); if (on[i]) fmOn.add(s.fm[i].toDouble()) }
        val tones = twoMeans(fmOn.a, fmOn.size)
        val ms = (b - a) / s.rate * 1000
        if (ms < MIN_BURST_MS) return
        val end = offsetS + channels.samples.toDouble() / rate
        held.add(Held(Burst(
            nextId.getAndIncrement(), s.t, System.currentTimeMillis(), s.hz, s.rate, n,
            s.env.copyOf(n), s.fm.copyOf(n), s.iq.copyOf(n * 2), ms,
            20 * log10(max(1, peak) / ENV_FULL), 20 * log10(max(1, peak) / noise),
            s.matches.toList(), src,
        ), end, tones.b - tones.a))
    }
}

/** The once-a-second status line: bursts followed now and since the start, bursts captured, and the span watched. */
data class AnalyzerStats(val channels: Int = 0, val followed: Int = 0, val captured: Int = 0, val span: Int = 0)

/**
 * The capture as the radio's processor: each burst goes to [onBurst] (on the DSP thread), and once a second a
 * status line to [onStats].
 */
class AnalyzerProcessor(onBurst: (Burst) -> Unit, private val onStats: (AnalyzerStats) -> Unit) : IqProcessor {
    private var lastStats = 0L
    @Volatile private var captured = 0
    val capture = AnalyzerCapture { b -> captured++; onBurst(b) }
    override fun reset(rate: Int) { capture.reset(rate) }
    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        capture.onIq(iq, len, rate)
        val now = System.currentTimeMillis()
        if (now - lastStats >= 1000) {
            lastStats = now
            onStats(AnalyzerStats(capture.active(), capture.followed(), captured, rate))
        }
    }
}

/**
 * Run a whole recording through a fresh capture: an imported .cu8 / .cs8 (or a Flipper .sub turned back into
 * samples), as signed bytes. The file is read in the same blocks a radio delivers, then a moment of silence lets the
 * last burst go. The capture takes the radio's offset-128 bytes, so each block is shifted on the way in.
 */
fun captureFile(iq: ByteArray, rate: Int, src: String, onBurst: (Burst) -> Unit): Int {
    var count = 0
    val cap = AnalyzerCapture { b -> count++; onBurst(b) }
    cap.src = src
    cap.reset(rate)
    val block = 262144
    var buf = ByteArray(block)
    fun feed(from: ByteArray, start: Int, end: Int) {
        val len = end - start
        if (buf.size < len) buf = ByteArray(len)
        for (i in 0 until len) buf[i] = (from[start + i] + 128).toByte()
        cap.onIq(buf, len, rate)
    }
    var p = 0
    while (p < iq.size) { feed(iq, p, min(iq.size, p + block)); p += block }
    // a fifth of a second of quiet so every channel closes on its own (the finder lets go after 60 ms)
    val quiet = ByteArray(Math.round(rate * 0.2).toInt() * 2)
    var seed = 1L
    for (i in quiet.indices) { seed = lcg(seed); quiet[i] = (((seed ushr 16) % 5).toInt() - 2).toByte() }
    feed(quiet, 0, quiet.size)
    cap.finish()
    return count
}
