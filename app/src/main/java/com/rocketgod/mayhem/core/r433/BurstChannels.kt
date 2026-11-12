package com.rocketgod.mayhem.core.r433

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

/*
 * Finding every burst in the span and tuning to each one. Twin of web/src/dsp/r433/channels.ts.
 *
 * Remotes, keys and sensors are rarely on the dial. A key fob that says 433.92 can sit 350 kHz off it, and some
 * hop: a Ford key sends each frame on 434.26 and again on 433.59. Listening to the whole span at once lets in the
 * noise of all of it, and listening to a narrow slice around the dial misses everything off it. So this does what
 * a person with a waterfall does: it watches the spectrum, and when something lights up it tunes a narrow
 * receiver to exactly that frequency, a few milliseconds before the burst began (the samples are kept), and lets
 * it go once the burst has been quiet for a while. Several can run at once.
 *
 * Each channel comes out as the same envelope and discriminator streams the rtl_433 detector reads, at about
 * 250 kHz, centered on the burst. What reads them is up to the caller (see R433Processor).
 */

/** One narrow receiver, following one burst. The caller keeps its own state per slot index. */
data class BurstChannel(
    /** Which of the caller's slots this is; slots are reused once a channel closes. */
    val slot: Int,
    /** Offset from the radio's center, in hertz. */
    val hz: Double,
    /** The channel's sample rate. */
    val rate: Double,
    /** True for the first block after the channel opened: the caller should start this slot's readers afresh. */
    val fresh: Boolean,
)

/**
 * One block of a channel: its envelope and discriminator, [n] samples of each. `iq` is the channel's own samples
 * (interleaved I, Q as signed bytes at the channel rate), only when `keepIq` is set.
 */
typealias ChannelSink = (ch: BurstChannel, env: ShortArray, fm: ShortArray, n: Int, iq: ByteArray?) -> Unit
typealias ChannelEnd = (ch: BurstChannel) -> Unit

/** How many bursts can be followed at once. */
const val MAX_CHANNELS = 8
/** The rate each channel runs at, roughly: wide enough for a ±60 kHz shift, narrow enough to shed the noise. */
private const val CHANNEL_RATE = 250_000
/** How far apart two lit frequencies must be to be followed separately. */
private const val SAME_BURST_HZ = 100_000
/** How long a channel stays open after its burst last lit the spectrum. */
private const val HOLD_MS = 60
/** How far back a new channel starts, so the burst's opening is not lost to the time it took to notice it. */
private const val LOOKBACK_MS = 12
/** A frequency is lit when the power around it stands this far above its own noise. */
private const val LIT_DB = 8
/**
 * A strong burst splatters faint copies of itself across the span (the radio's own images and mixing products).
 * Anything lit this far below the strongest burst of the same moment is taken for that, not for a second device.
 */
private const val SPLATTER_DB = 25
/** The band's middle this far over its usual level means the whole band is lifted (a strong signal right by the antenna). */
private const val RAISED = 2
/** Bins either side of center ignored while the band is lifted: the radio's own offset jumps most there. */
private const val DC_BINS = 2
/** How many looks at the spectrum are averaged into one decision. */
private const val LOOKS = 4
/** The finder looks at about this many samples a second at most; a burst lasts milliseconds, so it misses none. */
private const val FINDER_BUDGET = 2_400_000

class BurstChannels(private val onChannel: ChannelSink, private val onEnd: ChannelEnd) {
    private class Open(val slot: Int, val hz: Double, var lastLit: Long, var pos: Long, val start: Long, val bb: Baseband, var phase: Double, var fresh: Boolean)

    private var rate = 0
    private var n = 256
    private var re = FloatArray(0); private var im = FloatArray(0); private var win = FloatArray(0)
    private var floor = FloatArray(0); private var pow = FloatArray(0); private var acc = FloatArray(0)
    private var accN = 0; private var raisedRun = 0; private var floorMid = 0.0
    private var sorted = FloatArray(0)
    private var litBefore = BooleanArray(0)
    private var frames = 0
    private var everyN = 1
    private var frameAcc = 0
    /** Raw samples kept for look-back, as a ring of interleaved signed bytes. */
    private var ring = ByteArray(0)
    private var ringMask = 0
    /** Absolute index of the next sample to arrive. */
    private var written = 0L
    private val open = ArrayList<Open>()
    private val free = ArrayList<Int>()
    private var scratch = ByteArray(0)
    private var decim = 8
    /** How many channels opened since the start, for the status line. */
    @Volatile var opened = 0; private set
    /** Hand each channel's raw samples to the sink as well (the Analyzer keeps them); off for the Devices app. */
    var keepIq = false
    /** Absolute index of the next sample to arrive, so a caller can say when a channel opened. */
    val samples: Long get() = written
    /** The absolute sample a channel's first block starts at (its look-back included). */
    fun startOf(slot: Int): Long = open.firstOrNull { it.slot == slot }?.start ?: 0L

    fun reset(rate: Int) {
        this.rate = rate
        // bins of roughly 8 kHz: narrow enough to see a weak key, wide enough that a burst's power lands in a few
        var n = 64; while (rate / n > 8_000 && n < 4096) n *= 2
        this.n = n
        re = FloatArray(n); im = FloatArray(n); win = FloatArray(n) { (0.5 - 0.5 * cos(2 * PI * it / (n - 1))).toFloat() }
        floor = FloatArray(n); pow = FloatArray(n); acc = FloatArray(n); litBefore = BooleanArray(n)
        accN = 0; raisedRun = 0; floorMid = 0.0; sorted = FloatArray(n)
        frames = 0; frameAcc = 0
        everyN = max(1, (rate.toDouble() / FINDER_BUDGET).roundToInt())
        decim = max(1, (rate.toDouble() / CHANNEL_RATE).roundToInt())
        var size = 1; while (size < rate * 0.25 * 2) size *= 2     // a quarter second of bytes
        ring = ByteArray(size); ringMask = size - 1
        written = 0
        for (o in open) onEnd(channel(o))
        open.clear()
        free.clear()
        for (i in MAX_CHANNELS - 1 downTo 0) free.add(i)
    }

    /** The rate each channel delivers. */
    fun channelRate(): Double = rate.toDouble() / decim
    /** How many channels are following a burst right now. */
    fun active(): Int = open.size
    /** The frequencies being followed right now, as offsets from center. */
    fun offsets(): List<Double> = open.map { it.hz }

    /** Offset-128 interleaved IQ bytes; [len] bytes valid. */
    fun process(iq: ByteArray, len: Int) {
        val nSamp = len shr 1
        if (rate == 0 || nSamp == 0) return
        // keep the samples for look-back
        if (len * 2 > ring.size) growRing(len * 2)
        var w = ((written * 2) and ringMask.toLong()).toInt()
        for (i in 0 until nSamp * 2) { ring[w] = ((iq[i].toInt() and 0xff) - 128).toByte(); w = (w + 1) and ringMask }
        val start = written
        written += nSamp

        // look for lit frequencies, frame by frame
        val nn = n
        var f = 0
        while (f + nn <= nSamp) {
            if (++frameAcc >= everyN) { frameAcc = 0; findIn(start + f) }
            f += nn
        }

        // run every open channel up to the newest sample, then close the ones gone quiet
        val now = written
        val holdS = (rate * HOLD_MS / 1000.0).roundToInt()
        for (k in open.size - 1 downTo 0) {
            val o = open[k]
            run(o, now)
            if (now - o.lastLit > holdS) {
                onEnd(channel(o))
                open.removeAt(k)
                free.add(o.slot)
            }
        }
    }

    private fun growRing(minBytes: Int) {
        var size = ring.size; while (size < minBytes) size *= 2
        val next = ByteArray(size)
        val old = ring; val om = ringMask.toLong()
        // copy the newest old.size bytes into their positions in the new ring
        val end = written * 2
        var a = max(0L, end - old.size)
        while (a < end) { next[(a and (size - 1).toLong()).toInt()] = old[(a and om).toInt()]; a++ }
        ring = next; ringMask = size - 1
    }

    /** One look at the spectrum: the [n] samples from absolute sample [absStart], read back from the ring. */
    private fun findIn(absStart: Long) {
        val nn = n; val re = re; val im = im; val win = win; val ring = ring; val mask = ringMask
        val base = ((absStart * 2) and mask.toLong()).toInt()
        var mi = 0.0; var mq = 0.0
        for (i in 0 until nn) { mi += ring[(base + 2 * i) and mask]; mq += ring[(base + 2 * i + 1) and mask] }
        mi /= nn; mq /= nn
        for (i in 0 until nn) {
            re[i] = ((ring[(base + 2 * i) and mask] - mi) * win[i]).toFloat()
            im[i] = ((ring[(base + 2 * i + 1) and mask] - mq) * win[i]).toFloat()
        }
        Dsp.fft(re, im)
        val pow = pow; val floor = floor; val acc = acc
        // power summed over three neighboring bins, so a burst spread across a few still stands out, and averaged
        // over a few looks before deciding: a single look is too spiky, and the splatter of a strong burst flickers
        // over the threshold in it
        for (i in 0 until nn) {
            val a = (i + nn - 1) % nn; val b = (i + 1) % nn
            val ra = re[a].toDouble(); val ia = im[a].toDouble(); val ri = re[i].toDouble(); val ii = im[i].toDouble(); val rb = re[b].toDouble(); val ib = im[b].toDouble()
            acc[i] = (acc[i] + (ra * ra + ia * ia + ri * ri + ii * ii + rb * rb + ib * ib)).toFloat()
        }
        if (++accN < LOOKS) return
        for (i in 0 until nn) { pow[i] = (acc[i].toDouble() / LOOKS).toFloat(); acc[i] = 0f }
        accN = 0
        frames++
        val warm = frames < 32
        val lit = 10.0.pow(LIT_DB / 10.0)
        val litNow = litBefore
        // collect lit bins (two decisions running, so a lone noise spike does not open a channel), strongest first
        // The level a bin must beat: its own learned noise, or the band's middle right now if that is higher. A key
        // pressed next to the antenna lifts the whole band (and the center most of all) for as long as it sends; the
        // burst itself still stands well clear of that, and nothing else should open on the rise.
        val med = median(pow).toDouble()
        val raised = !warm && med > floorMid * RAISED
        val hits = ArrayList<Pair<Int, Float>>()
        for (i in 0 until nn) {
            val p = pow[i]
            if (warm) {
                floor[i] = if (floor[i] != 0f) (floor[i] + (p.toDouble() - floor[i]) / frames).toFloat() else p
                litNow[i] = false
                continue
            }
            val fl = floor[i].toDouble()
            val on = p > (if (fl > med) fl else med) * lit && !(raised && (i <= DC_BINS || i >= nn - DC_BINS))
            if (on && litNow[i]) hits.add(i to p)
            litNow[i] = on
        }
        if (warm) { floorMid = med; return }
        // the floor learns only while the band is at rest; if it stays raised for a second, that is the new floor
        raisedRun = if (raised) raisedRun + 1 else 0
        val rebase = raisedRun.toLong() * nn * LOOKS > rate
        if (rebase) { for (i in 0 until nn) floor[i] = pow[i]; floorMid = med; raisedRun = 0 }
        else if (!raised) {
            for (i in 0 until nn) if (pow[i] <= floor[i] * lit) floor[i] = (floor[i] + (pow[i].toDouble() - floor[i]) / 32).toFloat()
            floorMid += (med - floorMid) / 32
        }
        if (hits.isEmpty()) return
        hits.sortByDescending { it.second }
        val binHz = rate.toDouble() / nn
        val splatter = hits[0].second / 10.0.pow(SPLATTER_DB / 10.0)
        for ((hb, hp) in hits) {
            if (hp < splatter) break
            // refine to the power-weighted middle of the lit run around this bin
            var s = 0.0; var sw = 0.0
            for (d in -3..3) { val j = (hb + d + nn) % nn; val p = pow[j].toDouble(); if (p > floor[j] * lit) { s += p * d; sw += p } }
            val bin = hb + (if (sw != 0.0) s / sw else 0.0)
            val hz = (if (bin < nn / 2.0) bin else bin - nn) * binHz
            val o = open.firstOrNull { abs(it.hz - hz) < SAME_BURST_HZ }
            if (o != null) { o.lastLit = absStart + nn; continue }
            if (free.isEmpty()) continue
            val slot = free.removeAt(free.size - 1)
            val bb = Baseband(); bb.decim = decim; bb.keepIq = keepIq
            val back = (rate * LOOKBACK_MS / 1000.0).roundToInt()
            val pos = maxOf(absStart - back, written - (ring.size shr 1) + 1, 0L)
            open.add(Open(slot, hz, absStart + nn, pos, pos, bb, 0.0, true))
            opened++
        }
    }

    private fun median(v: FloatArray): Float {
        val s = sorted; v.copyInto(s); s.sort()
        return s[s.size shr 1]
    }

    /** Tune one channel down to its burst and hand the result on, from where it left off up to [upto]. */
    private fun run(o: Open, upto: Long) {
        val count = (upto - o.pos).toInt()
        if (count <= 0) return
        if (scratch.size < count * 2) scratch = ByteArray(count * 2)
        val out = scratch; val ring = ring; val mask = ringMask
        val step = -2 * PI * o.hz / rate
        // rotate by a running phasor, re-normalized each block so rounding cannot make it drift in size
        var cr = cos(o.phase); var ci = sin(o.phase)
        val sr = cos(step); val si = sin(step)
        var r = ((o.pos * 2) and mask.toLong()).toInt()
        for (k in 0 until count) {
            val i = ring[r].toDouble(); val q = ring[(r + 1) and mask].toDouble()
            r = (r + 2) and mask
            val yi = i * cr - q * ci; val yq = i * ci + q * cr
            // the channel goes on as offset-128 bytes, the form Baseband reads
            out[2 * k] = ((if (yi > 127) 127 else if (yi < -128) -128 else Math.round(yi).toInt()) + 128).toByte()
            out[2 * k + 1] = ((if (yq > 127) 127 else if (yq < -128) -128 else Math.round(yq).toInt()) + 128).toByte()
            val t = cr * sr - ci * si; ci = cr * si + ci * sr; cr = t
        }
        o.phase = (o.phase + step * count) % (2 * PI)
        o.pos = upto
        val m = o.bb.process(out, count * 2)
        val ch = channel(o)
        o.fresh = false
        onChannel(ch, o.bb.env, o.bb.fm, m, if (keepIq) o.bb.iq else null)
    }

    private fun channel(o: Open) = BurstChannel(o.slot, o.hz, rate.toDouble() / decim, o.fresh)
}
