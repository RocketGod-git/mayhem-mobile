package com.rocketgod.mayhem.core.pager

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * One pager channel cut out of the SDR's wide IQ stream: mixed to baseband by a numerically controlled oscillator,
 * filtered and decimated in two FIR stages (to ~240 kHz, then to ~48 kHz with a channel filter tight enough that
 * the next 25 kHz channel is gone), FM-discriminated, and fed to both a FLEX and a POCSAG decoder. Several of these
 * run on one buffer, so one SDR listens to every busy pager channel in its window at once.
 */
class PagerChannelRx(val hz: Long, sink: PagerSink) {
    private val sink = sink
    var outRate = 0.0; private set
    private var rate = 0
    private var center = 0L
    // oscillator: a unit phasor stepped by a fixed rotation each sample (renormalized now and then)
    private var pr = 1.0; private var pi = 0.0
    private var sr = 1.0; private var si = 0.0
    private var d1 = 1; private var d2 = 1
    private var t1 = FloatArray(1); private var t2 = FloatArray(1)
    private var h1i = FloatArray(2); private var h1q = FloatArray(2); private var p1 = 0; private var c1 = 0
    private var h2i = FloatArray(2); private var h2q = FloatArray(2); private var p2 = 0; private var c2 = 0
    private var lastI = 0f; private var lastQ = 0f
    private var out = FloatArray(4096); private var nOut = 0
    private var flex: FlexDecoder? = null
    private var pocsag: PocsagDecoder? = null
    private var pow = 0.0
    /** Channel power after the channel filter, dB relative to full scale (for the UI's signal bar). */
    val powerDb: Double get() = 10.0 * ln(pow + 1e-12) / ln(10.0) - 42.0

    fun configure(centerHz: Long, sampleRate: Int) {
        if (centerHz == center && sampleRate == rate) return
        center = centerHz
        if (sampleRate != rate) {
            rate = sampleRate
            d1 = maxOf(1, (rate / 240_000.0).roundToInt())
            val inter = rate.toDouble() / d1
            d2 = maxOf(1, (inter / 48_000.0).roundToInt())
            outRate = inter / d2
            t1 = lowpass(5 * d1 + 1, 50_000.0 / rate)
            t2 = lowpass(127, 10_000.0 / inter)
            h1i = FloatArray(t1.size * 2); h1q = FloatArray(t1.size * 2); p1 = 0; c1 = 0
            h2i = FloatArray(t2.size * 2); h2q = FloatArray(t2.size * 2); p2 = 0; c2 = 0
            flex = FlexDecoder(sink, outRate)
            pocsag = PocsagDecoder(sink, outRate)
        }
        val w = -2.0 * PI * (hz - center) / rate
        sr = cos(w); si = sin(w)
    }

    /** One buffer of IQ (already centered floats, [n] samples). */
    fun process(iq: FloatArray, qq: FloatArray, n: Int) {
        if (rate == 0) return
        val L1 = t1.size; val L2 = t2.size
        var r = pr; var s = pi
        for (k in 0 until n) {
            val xi = iq[k]; val xq = qq[k]
            val yi = (xi * r - xq * s).toFloat()
            val yq = (xi * s + xq * r).toFloat()
            val nr = r * sr - s * si; s = r * si + s * sr; r = nr
            // stage 1: keep the last L1 samples (written twice so the window is always contiguous)
            h1i[p1] = yi; h1i[p1 + L1] = yi; h1q[p1] = yq; h1q[p1 + L1] = yq
            p1 = if (p1 + 1 == L1) 0 else p1 + 1
            if (++c1 < d1) continue
            c1 = 0
            var ai = 0f; var aq = 0f
            for (t in 0 until L1) { val c = t1[t]; ai += h1i[p1 + t] * c; aq += h1q[p1 + t] * c }
            // stage 2: the channel filter
            h2i[p2] = ai; h2i[p2 + L2] = ai; h2q[p2] = aq; h2q[p2 + L2] = aq
            p2 = if (p2 + 1 == L2) 0 else p2 + 1
            if (++c2 < d2) continue
            c2 = 0
            var bi = 0f; var bq = 0f
            for (t in 0 until L2) { val c = t2[t]; bi += h2i[p2 + t] * c; bq += h2q[p2 + t] * c }
            pow += (bi * bi + bq * bq - pow) * 0.0005
            out[nOut++] = atan2(bq * lastI - bi * lastQ, bi * lastI + bq * lastQ)
            lastI = bi; lastQ = bq
            if (nOut == out.size) drain()
        }
        val m = sqrt(r * r + s * s); pr = r / m; pi = s / m
        drain()
    }

    /** Sees every discriminator block before the decoders do (tests and bench tools). */
    var tap: ((FloatArray, Int) -> Unit)? = null

    private fun drain() {
        if (nOut == 0) return
        tap?.invoke(out, nOut)
        flex?.push(out, nOut)
        pocsag?.push(out, nOut)
        nOut = 0
    }

    companion object {
        /** Hamming-windowed sinc, unity gain at DC; [cut] is the cutoff as a fraction of the sample rate. */
        fun lowpass(taps: Int, cut: Double): FloatArray {
            val m = taps - 1
            val h = DoubleArray(taps) { k ->
                val x = k - m / 2.0
                val sinc = if (x == 0.0) 2 * cut else sin(2 * PI * cut * x) / (PI * x)
                sinc * (0.54 - 0.46 * cos(2 * PI * k / m))
            }
            val g = h.sum()
            return FloatArray(taps) { (h[it] / g).toFloat() }
        }
    }
}
