package com.rocketgod.mayhem.core.r433

import com.rocketgod.mayhem.core.fleet.Codes
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/*
 * DMR bursts on a Devices channel, named for what they are. Twin of web/src/dsp/r433/dmr.ts.
 *
 * Two-way radios on DMR (ETSI TS 102 361) send 30 ms bursts of 4-level FSK at 4800 symbols a second, the outer
 * levels about ±1.94 kHz. On 433 MHz they look to the burst finder like an FSK sensor, but the shift is far too narrow
 * for the sensor slicers. This reads each channel the way a DMR receiver does: a narrow filter on the burst's own
 * center, the frequency summed over each symbol, and the 24-symbol sync word in the middle of the burst. A data
 * burst's slot type (color code and data type, Golay(20,8) protected) sits either side of that sync, so a burst is
 * named only when the sync matches and the slot type decodes. What the burst carries is left to Dispatch.
 */

/** Data types of the slot type field (TS 102 361-1, 9.3.6). 12 to 15 are reserved, and taken for a misread. */
val DMR_DATA_TYPE = listOf("PI header", "voice LC header", "terminator with LC", "CSBK", "MBC header", "MBC continuation",
    "data header", "rate 1/2 data", "rate 3/4 data", "idle", "rate 1 data", "unified single block data")

/** One data burst whose sync matched and whose slot type decoded. [at] is where its sync began, in channel samples. */
data class DmrSeen(val cc: Int, val dt: Int, val from: String, val offsetHz: Int, val errs: Int, val at: Long)

private const val BAUD = 4800
private const val READ_RATE = 50_000
private const val KEEP_S = 0.4
private const val TAIL_S = 0.04
private const val SYNC_MIN = 0.85
private val SYNCS = listOf("radio" to Codes.syncSigns(Codes.DMR_MS_DATA), "repeater" to Codes.syncSigns(Codes.DMR_BS_DATA))

class DmrSpot {
    private var d = 5
    private var sps = 10.4
    private var zi = FloatArray(0); private var zq = FloatArray(0)
    private var n = 0
    private var base = 0L
    private var ai = 0.0; private var aq = 0.0; private var acc = 0
    private var doneTo = 0L

    fun reset(rate: Double) {
        d = max(1, (rate / READ_RATE).roundToInt())
        val fs = rate / d
        sps = fs / BAUD
        val cap = ceil(fs * KEEP_S).toInt()
        if (zi.size != cap) { zi = FloatArray(cap); zq = FloatArray(cap) }
        n = 0; base = 0; ai = 0.0; aq = 0.0; acc = 0; doneTo = 0
    }

    /** A block of the channel's samples (interleaved I, Q); bursts found go to [out]. */
    fun push(iq: FloatArray, count: Int, out: MutableList<DmrSeen>) {
        for (k in 0 until count) {
            ai += iq[2 * k]; aq += iq[2 * k + 1]
            if (++acc < d) continue
            acc = 0
            if (n >= zi.size) scan(out, true)
            zi[n] = (ai / d).toFloat(); zq[n] = (aq / d).toFloat(); n++
            ai = 0.0; aq = 0.0
        }
    }

    /** The channel closed: read what is left. */
    fun end(out: MutableList<DmrSeen>) { scan(out, false); n = 0 }

    private fun scan(out: MutableList<DmrSeen>, keepTail: Boolean) {
        val fs = sps * BAUD
        if (n > 140 * sps) find(out, n, fs)
        if (keepTail) {
            val t = min(n, (fs * TAIL_S).roundToInt())
            zi.copyInto(zi, 0, n - t, n); zq.copyInto(zq, 0, n - t, n)
            base += n - t; n = t
        }
    }

    private fun find(out: MutableList<DmrSeen>, n: Int, fs: Double) {
        val zi = zi; val zq = zq; val sps = sps
        // the burst's own center: the mean frequency where it is strong
        val p = FloatArray(n) { zi[it] * zi[it] + zq[it] * zq[it] }
        val sorted = p.copyOf(); sorted.sort(); val top = sorted[(n * 0.9).toInt()]
        if (!(top > 0)) return
        var sr = 0.0; var sim = 0.0; var cnt = 0
        for (k in 1 until n) {
            if (p[k] < top * 0.3 || p[k - 1] < top * 0.3) continue
            sr += zi[k] * zi[k - 1] + zq[k] * zq[k - 1]; sim += zq[k] * zi[k - 1] - zi[k] * zq[k - 1]; cnt++
        }
        if (cnt < 100 * sps) return                      // less than a burst of signal here
        val off = atan2(sim, sr) * fs / (2 * PI)
        // mix it to zero, a 16 kHz boxcar, the discriminator, then the frequency summed over one symbol
        val l1 = max(1, (fs / 16_000).roundToInt()); val l2 = max(1, (fs / BAUD).roundToInt())
        val f = FloatArray(n); val w = -2 * PI * off / fs
        var si = 0.0; var sq = 0.0; var pi = 0.0; var pq = 0.0; var fsum = 0.0
        val bi = DoubleArray(l1); val bq = DoubleArray(l1); val bf = DoubleArray(l2)
        for (k in 0 until n) {
            val c = cos(w * k); val s = sin(w * k); val ii = zi[k] * c - zq[k] * s; val qq = zi[k] * s + zq[k] * c
            si += ii - bi[k % l1]; sq += qq - bq[k % l1]; bi[k % l1] = ii; bq[k % l1] = qq
            val v = atan2(sq * pi - si * pq, si * pi + sq * pq) * fs / (2 * PI)
            pi = si; pq = sq
            fsum += v - bf[k % l2]; bf[k % l2] = v
            f[k] = (fsum / l2).toFloat()
        }
        fun at(x: Double): Double = f[min(n - 1, max(0, x.roundToInt()))].toDouble()
        fun corr(x: Int, sig: IntArray): Double {
            var m = 0.0; for (i in 0 until 24) m += at(x + i * sps); m /= 24
            var c = 0.0; var a = 0.0
            for (i in 0 until 24) { val v = at(x + i * sps) - m; c += v * sig[i]; a += abs(v) }
            return if (a > 0) c / a else 0.0
        }
        val first = ceil(54 * sps).toInt() + l1 + l2; val last = n - ceil(78 * sps).toInt()
        var x = first
        while (x < last) {
            if (base + x < doneTo || p[x] < top * 0.1) { x++; continue }
            for ((from, sig) in SYNCS) {
                val r = corr(x, sig)
                if (r < SYNC_MIN) continue
                // the best alignment close by
                var bx = x; var br = r
                for (dd in 1..ceil(sps / 2).toInt()) { val r2 = corr(x + dd, sig); if (r2 > br) { br = r2; bx = x + dd } }
                var m = 0.0; for (i in 0 until 24) m += at(bx + i * sps); m /= 24
                var lvl = 0.0; for (i in 0 until 24) lvl += (at(bx + i * sps) - m) * sig[i]; lvl /= 24
                if (lvl <= 0) continue
                // DMR holds its carrier: an on-off keyed burst, whose spaces read as noise, is not one
                var held = true
                var k = max(0, (bx - 5 * sps).roundToInt()); val e = min(n, (bx + 29 * sps).roundToInt())
                while (k < e && held) { held = p[k] >= top * 0.1; k++ }
                if (!held) break
                // dibits 61 to 65 and 90 to 94 of the 144-dibit burst (sync at 66): the 20-bit slot type
                fun dib(j: Int): Int { val v = (at(bx + (j - 66) * sps) - m) / lvl * 3; return if (v >= 2) 1 else if (v >= 0) 0 else if (v >= -2) 2 else 3 }
                var st = 0
                for (j in 61..65) st = (st shl 2) or dib(j)
                for (j in 90..94) st = (st shl 2) or dib(j)
                val g = Codes.golay208Decode(st)
                if (g != null && g.errs <= 2 && (g.data and 15) < DMR_DATA_TYPE.size) {
                    out.add(DmrSeen(g.data shr 4, g.data and 15, from, off.roundToInt(), g.errs, (base + bx) * d))
                    doneTo = base + bx + (100 * sps).roundToInt()
                    x = bx + (100 * sps).roundToInt()
                }
                break
            }
            x++
        }
    }
}
