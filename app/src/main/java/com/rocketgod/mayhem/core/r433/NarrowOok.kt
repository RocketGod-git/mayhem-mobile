package com.rocketgod.mayhem.core.r433

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

/*
 * The narrow on-off-keyed path, for sensors too weak for the wide channels. Twin of web/src/dsp/r433/narrow.ts.
 *
 * The wide channels look at the spectrum in 8 kHz bins and read each burst through a 250 kHz channel. A weather
 * station on the far side of the street can sit only about 10 dB over the noise in 5 kHz: in an 8 kHz bin it barely
 * lights, and in 250 kHz of envelope it is under the noise. This path watches the spectrum in 2 kHz bins, averaged
 * over several milliseconds, and when a narrow peak stands there it reads that frequency through a channel only
 * about 6 kHz wide at 100 kS/s. Only the envelope is read (on-off keying), and only by the checksummed decoders.
 */

/** How many narrow channels can run at once. */
const val NARROW_MAX = 4
private const val BIN_HZ = 2_000
private const val NARROW_RATE = 100_000
private const val SMOOTH = 16
private const val LOOKS = 16
private const val LIT_DB = 5.0
private const val SAME_HZ = 8_000
private const val HOLD_MS = 120
private const val LOOKBACK_MS = 80
private const val SPLATTER_DB = 25.0
private const val NOISE_LEVEL = 800.0
private const val FINDER_BUDGET = 1_200_000

typealias NarrowSink = (ch: BurstChannel, env: ShortArray, fm: ShortArray, n: Int) -> Unit

class NarrowOok(private val onChannel: NarrowSink, private val onEnd: ChannelEnd) {
    private class Open(val slot: Int, val hz: Double, var lastLit: Long, var pos: Long) {
        var fresh = true
        var cr = 1.0; var ci = 0.0
        var ai = 0.0; var aq = 0.0; var acc = 0
        val mi = DoubleArray(SMOOTH); val mq = DoubleArray(SMOOTH); var mp = 0; var si = 0.0; var sq = 0.0
        var gain = 0.0
    }

    private var rate = 0
    private var n = 1024
    private var re = FloatArray(0); private var im = FloatArray(0); private var win = FloatArray(0)
    private var floor = FloatArray(0); private var acc = FloatArray(0); private var pow = FloatArray(0)
    private var litBefore = BooleanArray(0); private var sorted = FloatArray(0)
    private var accN = 0; private var frames = 0; private var everyN = 1; private var frameAcc = 0
    private var ring = ByteArray(0); private var ringMask = 0; private var written = 0L
    private val open = ArrayList<Open>()
    private val free = ArrayList<Int>()
    private var decim = 20
    private var env = ShortArray(0); private var fm = ShortArray(0); private var mag = DoubleArray(0)
    /** Channels opened since the start. */
    var opened = 0; private set

    fun reset(rate: Int) {
        for (o in open) onEnd(channel(o))
        open.clear(); free.clear()
        for (i in NARROW_MAX - 1 downTo 0) free.add(i)
        this.rate = rate
        var n = 64; while (rate / n > BIN_HZ && n < 8192) n *= 2
        this.n = n
        re = FloatArray(n); im = FloatArray(n); win = FloatArray(n) { (0.5 - 0.5 * cos(2 * PI * it / (n - 1))).toFloat() }
        floor = FloatArray(n); acc = FloatArray(n); pow = FloatArray(n); litBefore = BooleanArray(n); sorted = FloatArray(n)
        accN = 0; frames = 0; frameAcc = 0
        everyN = max(1, (rate.toDouble() / FINDER_BUDGET).roundToInt())
        decim = max(1, (rate.toDouble() / NARROW_RATE).roundToInt())
        var size = 1; while (size < rate * 0.25 * 2) size *= 2
        ring = ByteArray(size); ringMask = size - 1; written = 0
    }

    fun active(): Int = open.size

    /** Offset-128 interleaved IQ bytes; [len] bytes valid. */
    fun process(iq: ByteArray, len: Int) {
        val nSamp = len shr 1
        if (rate == 0 || nSamp == 0) return
        if (len * 2 > ring.size) growRing(len * 2)
        var w = ((written * 2) and ringMask.toLong()).toInt()
        for (i in 0 until nSamp * 2) { ring[w] = ((iq[i].toInt() and 0xff) - 128).toByte(); w = (w + 1) and ringMask }
        val start = written
        written += nSamp
        var f = 0
        while (f + n <= nSamp) {
            if (++frameAcc >= everyN) { frameAcc = 0; findIn(start + f) }
            f += n
        }
        val now = written; val hold = (rate * HOLD_MS / 1000.0).roundToInt()
        for (k in open.size - 1 downTo 0) {
            val o = open[k]
            run(o, now)
            if (now - o.lastLit > hold) { onEnd(channel(o)); open.removeAt(k); free.add(o.slot) }
        }
    }

    private fun growRing(minBytes: Int) {
        var size = ring.size; while (size < minBytes) size *= 2
        val next = ByteArray(size); val old = ring; val om = ringMask.toLong(); val end = written * 2
        var a = max(0L, end - old.size)
        while (a < end) { next[(a and (size - 1).toLong()).toInt()] = old[(a and om).toInt()]; a++ }
        ring = next; ringMask = size - 1
    }

    private fun findIn(absStart: Long) {
        val nn = n; val ring = ring; val mask = ringMask
        val base = ((absStart * 2) and mask.toLong()).toInt()
        var mi = 0.0; var mq = 0.0
        for (i in 0 until nn) { mi += ring[(base + 2 * i) and mask]; mq += ring[(base + 2 * i + 1) and mask] }
        mi /= nn; mq /= nn
        for (i in 0 until nn) {
            re[i] = ((ring[(base + 2 * i) and mask] - mi) * win[i]).toFloat()
            im[i] = ((ring[(base + 2 * i + 1) and mask] - mq) * win[i]).toFloat()
        }
        Dsp.fft(re, im)
        for (i in 0 until nn) {
            val a = (i + nn - 1) % nn; val b = (i + 1) % nn
            acc[i] += re[a] * re[a] + im[a] * im[a] + re[i] * re[i] + im[i] * im[i] + re[b] * re[b] + im[b] * im[b]
        }
        if (++accN < LOOKS) return
        for (i in 0 until nn) { pow[i] = acc[i] / LOOKS; acc[i] = 0f }
        accN = 0; frames++
        if (frames <= 8) { for (i in 0 until nn) floor[i] = if (floor[i] != 0f) min(floor[i], pow[i]) else pow[i]; return }
        val lit = 10.0.pow(LIT_DB / 10)
        pow.copyInto(sorted); sorted.sort(); val med = sorted[nn shr 1].toDouble()
        val hits = ArrayList<Pair<Int, Float>>()
        for (i in 0 until nn) {
            val p = pow[i]; val ref = if (floor[i] > med) floor[i].toDouble() else med
            // the bins next to the radio's own center offset are left to the wide path
            val on = p > ref * lit && i > 1 && i < nn - 1
            if (on && litBefore[i]) hits.add(i to p)
            litBefore[i] = on
            if (p <= floor[i] * lit) floor[i] = (floor[i] + (p - floor[i]) / 32.0).toFloat()
        }
        if (hits.isEmpty()) return
        hits.sortByDescending { it.second }
        val binHz = rate.toDouble() / nn; val splatter = hits[0].second / 10.0.pow(SPLATTER_DB / 10)
        for ((hb, hp) in hits) {
            if (hp < splatter) break
            // a narrow peak only: the wide path already reads anything spread over more than about 10 kHz
            var width = 1
            for (d in 1..8) { val j = (hb + d) % nn; if (pow[j] > floor[j] * lit) width++ else break }
            for (d in 1..8) { val j = (hb - d + nn) % nn; if (pow[j] > floor[j] * lit) width++ else break }
            if (width > 7) continue
            var s = 0.0; var sw = 0.0
            for (d in -2..2) { val j = (hb + d + nn) % nn; val p = pow[j].toDouble(); if (p > floor[j] * lit) { s += p * d; sw += p } }
            val bin = hb + (if (sw != 0.0) s / sw else 0.0)
            val hz = (if (bin < nn / 2.0) bin else bin - nn) * binHz
            val o = open.firstOrNull { kotlin.math.abs(it.hz - hz) < SAME_HZ }
            if (o != null) { o.lastLit = absStart + nn; continue }
            if (free.isEmpty()) continue
            val slot = free.removeAt(free.size - 1)
            val back = (rate * LOOKBACK_MS / 1000.0).roundToInt()
            val pos = maxOf(absStart - back, written - (ring.size shr 1) + 1, 0L)
            open.add(Open(slot, hz, absStart + nn, pos))
            opened++
        }
    }

    /** Mix one channel to its peak, decimate, smooth and take the envelope, from where it left off up to [upto]. */
    private fun run(o: Open, upto: Long) {
        val count = (upto - o.pos).toInt()
        if (count <= 0) return
        val d = decim; val cap = count / d + 2
        if (env.size < cap) { env = ShortArray(cap); fm = ShortArray(cap); mag = DoubleArray(cap) }
        val ring = ring; val mask = ringMask
        val step = -2 * PI * o.hz / rate; val sr = cos(step); val si = sin(step)
        var cr = o.cr; var ci = o.ci; var r = ((o.pos * 2) and mask.toLong()).toInt(); var m = 0
        var ai = o.ai; var aq = o.aq; var acc = o.acc
        for (k in 0 until count) {
            val i = ring[r] + 0.5; val q = ring[(r + 1) and mask] + 0.5
            r = (r + 2) and mask
            // mix to the peak and average groups of [decim]: a boxcar whose nulls land on every alias of the narrow band
            ai += i * cr - q * ci; aq += i * ci + q * cr
            val t = cr * sr - ci * si; ci = cr * si + ci * sr; cr = t
            if (++acc < d) continue
            acc = 0
            val yi = ai / d; val yq = aq / d; ai = 0.0; aq = 0.0
            o.si += yi - o.mi[o.mp]; o.sq += yq - o.mq[o.mp]; o.mi[o.mp] = yi; o.mq[o.mp] = yq; o.mp = (o.mp + 1) % SMOOTH
            mag[m++] = hypot(o.si, o.sq) / SMOOTH
        }
        val nm = hypot(cr, ci); o.cr = cr / nm; o.ci = ci / nm; o.ai = ai; o.aq = aq; o.acc = acc
        o.pos = upto
        if (m == 0) return
        // scale once, from the quiet start of the look-back, so the noise sits where the detector's ratio works
        if (o.gain == 0.0) {
            val s = mag.copyOf(m); s.sort(); val q = s[(m * 0.3).toInt()].takeIf { it > 0 } ?: 1e-3
            o.gain = min(4000.0, max(1.0, NOISE_LEVEL / q))
        }
        for (i in 0 until m) { val v = mag[i] * o.gain; env[i] = (if (v > 32767) 32767.0 else v).toInt().toShort(); fm[i] = 0 }
        val ch = channel(o)
        o.fresh = false
        onChannel(ch, env, fm, m)
    }

    private fun channel(o: Open) = BurstChannel(o.slot, o.hz, rate.toDouble() / decim, o.fresh)
}
