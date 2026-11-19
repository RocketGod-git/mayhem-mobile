package com.rocketgod.mayhem.core.js8

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/** ln 2. */
internal val LN_2 = kotlin.math.ln(2.0)

/**
 * JS8 waveform: 79 tones, continuous phase, the tone frequency Gaussian-smoothed across symbol boundaries
 * (BT 2), with a short raised-cosine ramp at both ends. As audio for USB, or as the instantaneous audio-offset
 * frequency a transmitter adds to its carrier. Twin of web/src/dsp/js8/synth.ts.
 */
object Js8Synth {
    private const val BT = 2.0
    private val KG = PI * sqrt(2 / LN_2)

    private fun erf(x: Double): Double {
        val t = 1 / (1 + 0.3275911 * abs(x))
        val y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x)
        return if (x >= 0) y else -y
    }
    /** Frequency pulse of one symbol over three symbols: (erf(k BT (t + 1/2)) - erf(k BT (t - 1/2))) / 2. */
    private fun gaussPulse(sps: Int): FloatArray {
        val n = 3 * sps
        return FloatArray(n) { i -> val t = (i + 0.5) / sps - 1.5; (0.5 * (erf(KG * BT * (t + 0.5)) - erf(KG * BT * (t - 0.5)))).toFloat() }
    }

    /** Instantaneous offset from tone 0, Hz, at [rate] samples per second, for the whole frame. */
    fun toneTrack(tones: IntArray, mode: Js8Mode, rate: Int): FloatArray {
        val sps = (mode.symbol * rate).roundToInt(); val n = 79 * sps; val out = FloatArray(n); val p = gaussPulse(sps)
        // the first and last tones are held one symbol beyond the frame so its ends are steady
        for (k in -1..79) {
            val f = tones[max(0, min(78, k))] * mode.spacing; val at = (k - 1) * sps
            for (i in p.indices) { val j = at + i; if (j in 0 until n) out[j] = (out[j] + f * p[i]).toFloat() }
        }
        return out
    }

    /** Amplitude ramp at the ends of the frame (an eighth of a symbol), 0..1. */
    fun rampAt(i: Int, n: Int, sps: Int): Double {
        val r = max(1, (sps / 8.0).roundToInt())
        if (i < r) return 0.5 - 0.5 * cos(PI * i / r)
        if (i >= n - r) return 0.5 - 0.5 * cos(PI * (n - 1 - i) / r)
        return 1.0
    }

    /** One frame as real audio: tone 0 at [baseHz]. */
    fun audio(tones: IntArray, mode: Js8Mode, baseHz: Double, rate: Int, amplitude: Double = 0.5): FloatArray {
        val tr = toneTrack(tones, mode, rate); val n = tr.size; val sps = (mode.symbol * rate).roundToInt(); val out = FloatArray(n)
        var ph = 0.0
        for (i in 0 until n) { ph += 2 * PI * (baseHz + tr[i]) / rate; if (ph > 2 * PI) ph -= 2 * PI; out[i] = (amplitude * rampAt(i, n, sps) * sin(ph)).toFloat() }
        return out
    }
    fun frameSamples(mode: Js8Mode, rate: Int): Int = (frameSeconds(mode) * rate).roundToInt()
}
