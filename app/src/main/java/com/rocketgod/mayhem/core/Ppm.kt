package com.rocketgod.mayhem.core

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Frequency correction: measuring a radio's crystal error from a steady carrier whose frequency is known. The span is
 * tuned below the carrier (so the radio's own center spike stays out of the way), the carrier is mixed to zero,
 * narrowed, and read off a long FFT to a few hertz. Twin of web/src/dsp/ppm.ts.
 */

/** The correction a radio can take, in parts per million. */
const val PPM_MAX = 200
fun clampPpm(v: Double): Int = Math.round(v).coerceIn(-PPM_MAX.toLong(), PPM_MAX.toLong()).toInt()

/** Where the carrier sits above the span center ([offset]) and how far either side it is searched ([half]), in hertz. */
data class MeasurePlan(val offset: Int, val half: Int)
fun measurePlan(rate: Int): MeasurePlan =
    MeasurePlan(min(300_000L, Math.round(rate * 0.25)).toInt(), min(100_000L, Math.round(rate * 0.2)).toInt())

/** The correction after a measurement: a fast crystal shows the carrier below [offset], so the correction goes up. */
fun ppmAfter(old: Double, centerHz: Double, offset: Double, heardOffset: Double): Double = old + (offset - heardOffset) / centerHz * 1e6

/** A measured carrier: its offset from the span center and how far it stands over the floor. */
data class CarrierResult(val offsetHz: Double, val snrDb: Double)

/** The strongest carrier [offset] Hz from the span center, within [half] Hz, from [seconds] of samples. */
class CarrierMeter(rate: Int, private val offset: Int, private val half: Int, seconds: Double, settleS: Double = 0.35) {
    private val dec = max(1, floor(rate / (half * 2.5)).toInt())
    private val outRate = rate.toDouble() / dec
    private val re = FloatArray(N); private val im = FloatArray(N)
    private val acc = DoubleArray(N)
    private val win = FloatArray(N) { (0.5 - 0.5 * cos(2 * PI * it / (N - 1))).toFloat() }
    private var frames = 0; private var fill = 0
    private var skip = Math.round(settleS * rate); private var left = Math.round(seconds * rate)
    private var pr = 1.0; private var pi = 0.0
    private val sr: Double; private val si: Double
    private var ai = 0.0; private var aq = 0.0; private var an = 0; private var di = 0.0; private var dq = 0.0
    init { val w = -2 * PI * offset / rate; sr = cos(w); si = sin(w) }

    /** Offset-128 interleaved IQ, [len] bytes; true once enough has been heard. */
    fun push(iq: ByteArray, len: Int = iq.size): Boolean {
        var i = 0
        val n = len shr 1
        if (skip > 0) { val s = min(skip, n.toLong()); skip -= s; i = s.toInt() }
        while (i < n && left > 0) {
            val bi = (iq[2 * i].toInt() and 0xff) - 128; val bq = (iq[2 * i + 1].toInt() and 0xff) - 128
            // the radio's DC spike out first: shifted and narrowed, it would fold back into the search
            di += 1e-4 * (bi - di); dq += 1e-4 * (bq - dq)
            val x = bi - di; val y = bq - dq
            // mix the carrier to zero with a rotating phasor
            ai += x * pr - y * pi; aq += x * pi + y * pr
            val r = pr * sr - pi * si; pi = pr * si + pi * sr; pr = r
            i++; left--
            if (++an < dec) continue
            val k = 1 / hypot(pr, pi); pr *= k; pi *= k
            re[fill] = (ai / dec).toFloat(); im[fill] = (aq / dec).toFloat(); ai = 0.0; aq = 0.0; an = 0
            if (++fill == N) frame()
        }
        return left <= 0
    }

    private fun frame() {
        for (i in 0 until N) { re[i] *= win[i]; im[i] *= win[i] }
        Dsp.fft(re, im)
        for (i in 0 until N) acc[i] += re[i].toDouble() * re[i] + im[i].toDouble() * im[i]
        frames++; fill = 0
    }

    /** The carrier found, or null with too little heard. */
    fun result(): CarrierResult? {
        if (frames == 0) return null
        val binHz = outRate / N
        val span = min(N / 2 - 2, floor(half / binHz).toInt())
        fun at(k: Int) = acc[(k + N) % N]
        var best = 0
        for (k in -span..span) if (at(k) > at(best)) best = k
        fun db(k: Int) = 10 * log10(at(k) + 1e-12)
        val a = db(best - 1); val b = db(best); val c = db(best + 1); val den = a - 2 * b + c
        val frac = if (den < 0) max(-0.5, min(0.5, 0.5 * (a - c) / den)) else 0.0
        val floorDb = ArrayList<Double>()
        var k = -span
        while (k <= span) { floorDb.add(db(k)); k += 7 }
        floorDb.sort()
        return CarrierResult(offset + (best + frac) * binHz, b - floorDb[floorDb.size shr 1])
    }

    private companion object { const val N = 65_536 }
}
