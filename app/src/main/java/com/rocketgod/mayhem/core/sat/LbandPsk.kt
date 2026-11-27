package com.rocketgod.mayhem.core.sat

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.ham.ChannelDecimator
import com.rocketgod.mayhem.core.ham.ComplexFirDecimator
import com.rocketgod.mayhem.core.ham.lowpassTaps
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * A BPSK receiver for a continuous L-band carrier (the Inmarsat-C NCS TDM at 1200 symbols a second, the Aero
 * P-channel at 600 or 1200). The channel comes down to about 80 kHz, wide enough for a HackRF's frequency error at
 * 1.5 GHz; the carrier is found from the line the squared signal puts at twice its frequency; then a low-pass near
 * the symbol rate, a Costas loop and a Gardner symbol clock give one soft value a symbol (about ±1).
 *
 * Twin of web/src/dsp/lband/psk.ts.
 */
class PskReceiver(val symbolRate: Int, private val onSymbol: (Double) -> Unit) {
    /** The carrier found, Hz from the channel's nominal frequency (NaN before one is found). */
    @Volatile var carrierHz = Double.NaN; private set
    /** 0 (noise) to 1 (clean BPSK), from how much of each symbol lies on the real axis. */
    @Volatile var lock = 0.0; private set
    /** The carrier's line over the squared signal's mean, dB. */
    @Volatile var lineDb = 0.0; private set
    var symbols = 0L; private set
    private var key = ""
    private var cr = 1.0; private var ci = 0.0; private var dr = 1.0; private var di = 0.0
    private var chan: ChannelDecimator? = null
    private var fs1 = 0.0; private var fs2 = 0.0; private var sps = 0.0
    private var narrow: ComplexFirDecimator? = null
    private var mixed = FloatArray(0); private var mid = FloatArray(0); private var flt = FloatArray(0); private var nar = FloatArray(0)
    private val acqRe = FloatArray(ACQ_N); private val acqIm = FloatArray(ACQ_N); private val acqPow = FloatArray(ACQ_N)
    private var acqN = 0; private var acqBlocks = 0; private var acqWait = 0L
    private var wr = 1.0; private var wi = 0.0; private var wdr = 1.0; private var wdi = 0.0
    private var th = 0.0; private var om = 0.0
    private val ring = DoubleArray(64); private var k = 0L; private var t = 0.0
    private var pr = 0.0; private var pi = 0.0; private var amp = 1.0

    fun reset() { key = ""; carrierHz = Double.NaN; lock = 0.0; symbols = 0 }

    /** Offset-128 I,Q bytes at [rate]; the channel sits [offsetHz] from the radio's center. */
    fun onIq(iq: ByteArray, len: Int, rate: Int, offsetHz: Long) {
        val k0 = "$rate|$offsetHz"
        if (k0 != key) setup(k0, rate.toDouble(), offsetHz.toDouble(), false)
        val n = len / 2
        if (mixed.size < 2 * n) mixed = FloatArray(2 * n)
        var r = cr; var s = ci
        for (i in 0 until n) {
            val xi = (iq[2 * i].toInt() and 0xFF) - 128.0; val xq = (iq[2 * i + 1].toInt() and 0xFF) - 128.0
            mixed[2 * i] = (xi * r - xq * s).toFloat(); mixed[2 * i + 1] = (xi * s + xq * r).toFloat()
            val tt = r * dr - s * di; s = r * di + s * dr; r = tt
            if (i and 1023 == 0) { val g = 1 / sqrt(r * r + s * s); r *= g; s *= g }
        }
        cr = r; ci = s
        val c = chan!!
        if (mid.size < c.outSize(n)) mid = FloatArray(c.outSize(n))
        val o = c.process(mixed, n, mid)
        wide(mid, o)
    }

    /** Complex samples already at some rate near 80 kHz (tests, tools). */
    fun onBaseband(z: FloatArray, n: Int, fs: Double) {
        val k0 = "bb|$fs"
        if (k0 != key) setup(k0, fs, 0.0, true)
        wide(z, n)
    }

    private fun setup(k0: String, rate: Double, offsetHz: Double, baseband: Boolean) {
        key = k0
        val w = -2 * PI * offsetHz / rate; dr = cos(w); di = sin(w); cr = 1.0; ci = 0.0
        chan = if (baseband) null else ChannelDecimator(max(1, floor(rate / 80_000).toInt()))
        fs1 = if (baseband) rate else rate / chan!!.total
        val d2 = max(1, floor(fs1 / (8 * symbolRate)).toInt())
        fs2 = fs1 / d2; sps = fs2 / symbolRate
        narrow = ComplexFirDecimator(lowpassTaps(0.75 * symbolRate / fs1, (4 * fs1 / symbolRate).roundToInt() or 1), d2)
        acqN = 0; acqBlocks = 0; acqPow.fill(0f); acqWait = 0
        carrierHz = Double.NaN; lock = 0.0
        setCarrier(0.0)
    }

    private fun setCarrier(hz: Double) {
        val w = -2 * PI * hz / fs1; wdr = cos(w); wdi = sin(w)
        th = 0.0; om = 0.0; amp = 1.0
    }

    private fun wide(z: FloatArray, n: Int) {
        // the carrier search: while there is none, and again every 10 s while the loop is not locked
        for (i in 0 until n) {
            if (acqWait > 0) { acqWait--; continue }
            val a = z[2 * i]; val b = z[2 * i + 1]
            acqRe[acqN] = a * a - b * b; acqIm[acqN] = 2 * a * b
            if (++acqN == ACQ_N) { acqN = 0; acquireBlock() }
        }
        if (flt.size < 2 * n) flt = FloatArray(2 * n)
        var r = wr; var s = wi
        for (i in 0 until n) {
            val x = z[2 * i].toDouble(); val y = z[2 * i + 1].toDouble()
            flt[2 * i] = (x * r - y * s).toFloat(); flt[2 * i + 1] = (x * s + y * r).toFloat()
            val tt = r * wdr - s * wdi; s = r * wdi + s * wdr; r = tt
            if (i and 1023 == 0) { val g = 1 / sqrt(r * r + s * s); r *= g; s *= g }
        }
        wr = r; wi = s
        if (nar.size < 2 * n + 4) nar = FloatArray(2 * n + 4)
        val c = narrow!!.process(flt, n, nar)
        for (i in 0 until c) sample(nar[2 * i].toDouble(), nar[2 * i + 1].toDouble())
    }

    private fun acquireBlock() {
        Dsp.fft(acqRe, acqIm)
        for (q in 0 until ACQ_N) acqPow[q] += acqRe[q] * acqRe[q] + acqIm[q] * acqIm[q]
        if (++acqBlocks < ACQ_BLOCKS) return
        // the line at twice the carrier, within ±0.45 of the wide rate (the carrier within ±0.225)
        val p = acqPow
        var best = 0; var bv = -1.0; var sum = 0.0
        val lim = floor(0.45 * ACQ_N).toInt()
        for (q in 0 until ACQ_N) {
            sum += p[q]
            val kk = if (q < ACQ_N / 2) q else q - ACQ_N
            if (abs(kk) > lim) continue
            // the three bins about it, so a line between two bins still wins
            val v = p[q] + 0.5 * (p[(q + 1) % ACQ_N] + p[(q + ACQ_N - 1) % ACQ_N])
            if (v > bv) { bv = v; best = q }
        }
        val mean = sum / ACQ_N
        lineDb = 10 * log10(p[best] / (mean + 1e-30) + 1e-30)
        // the peak's fractional bin from its neighbors
        val a = p[(best + ACQ_N - 1) % ACQ_N].toDouble(); val b = p[best].toDouble(); val c = p[(best + 1) % ACQ_N].toDouble()
        val den = a - 2 * b + c; val frac = if (den != 0.0) 0.5 * (a - c) / den else 0.0
        val kk = (if (best < ACQ_N / 2) best else best - ACQ_N) + max(-0.5, min(0.5, frac))
        val hz = kk * fs1 / ACQ_N / 2
        p.fill(0f); acqBlocks = 0
        if (lineDb > 12) {
            val moved = !(abs(hz - carrierHz) < 3 * fs1 / ACQ_N)
            if (moved) { carrierHz = hz; setCarrier(hz) }
            acqWait = (10 * fs1).roundToInt().toLong()
        }
    }

    private fun sample(x: Double, y: Double) {
        // Costas rotation, then into the ring for the interpolator
        val c = cos(th); val s = sin(th)
        val zr = x * c + y * s; val zi = y * c - x * s
        th += om
        if (th > PI) th -= 2 * PI else if (th < -PI) th += 2 * PI
        val slot = (k and 31).toInt()
        ring[2 * slot] = zr; ring[2 * slot + 1] = zi
        k++
        while (k - 1 >= floor(t).toLong() + 1) {
            if (k - t > 24) { t = (k - 2).toDouble(); continue }
            at(t); val yr = ar; val yi = ai
            at(t - sps / 2); val mr = ar; val mi = ai
            // Gardner: the midpoint between two symbols of opposite sign sits on zero when the clock is right
            val et = ((pr - yr) * mr + (pi - yi) * mi) / (amp * amp + 1e-12)
            t += sps + max(-1.0, min(1.0, 0.05 * sps * et))
            pr = yr; pi = yi
            // Costas, decision directed for BPSK
            val mag = sqrt(yr * yr + yi * yi)
            amp += (mag - amp) * 0.01
            val ec = max(-1.0, min(1.0, (if (yr >= 0) yi else -yi) / (amp + 1e-12)))
            th += 0.06 * ec; om += 0.0015 * ec / sps
            val q = if (mag > 0) (yr * yr - yi * yi) / (mag * mag) else 0.0
            lock += (q - lock) * 0.005
            symbols++
            onSymbol(yr / (amp + 1e-12))
        }
    }

    private var ar = 0.0; private var ai = 0.0
    /** Linear interpolation in the ring at absolute sample position [tt], into ar / ai. */
    private fun at(tt: Double) {
        val i = floor(tt).toLong(); val f = tt - i
        val a = 2 * (i and 31).toInt(); val b = 2 * ((i + 1) and 31).toInt()
        ar = ring[a] * (1 - f) + ring[b] * f; ai = ring[a + 1] * (1 - f) + ring[b + 1] * f
    }

    companion object {
        private const val ACQ_N = 16384
        private const val ACQ_BLOCKS = 4
    }
}
