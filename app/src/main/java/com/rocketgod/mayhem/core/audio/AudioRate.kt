package com.rocketgod.mayhem.core.audio

import com.rocketgod.mayhem.core.ham.ChannelDecimator
import com.rocketgod.mayhem.core.ham.SincResampler
import kotlin.math.ceil
import kotlin.math.max

/**
 * How the engine's demodulator gets from the radio's rate to its audio: stage 1 ([stage1], to about 240 kHz for WFM,
 * about 48 kHz for the narrow modes) and stage 2 ([stage2], a plain average down to the audio). Both are whole numbers,
 * so the audio lands on exactly 48 kHz only when the rate is 48 kHz times their product. 1.92 and 2.4 Msps do; 1.8 Msps
 * gives 50 kHz for NFM (1.8 M / 36) and 51.4 kHz for WFM (1.8 M / 7 / 5), which played straight into the 48 kHz output
 * runs 4 to 7 % fast and sharp and overfills it (the overflow is dropped). [audioRate] is what the demodulator really
 * makes; [exact] says no conversion is needed.
 */
data class AudioPlan(val rate: Int, val stage1: Int, val stage2: Int) {
    val audioRate: Double get() = rate.toDouble() / stage1 / stage2
    val exact: Boolean get() = rate.toLong() == AUDIO_OUT_RATE.toLong() * stage1 * stage2

    companion object {
        const val AUDIO_OUT_RATE = 48_000

        /** The engine's plan for [rate]: [wfm] takes stage 1 to about 240 kHz, the other modes through [ChannelDecimator]. */
        fun of(rate: Int, wfm: Boolean): AudioPlan {
            val stage1 = if (wfm) max(1, rate / 240_000) else ChannelDecimator.split(max(1, rate / AUDIO_OUT_RATE)).let { it.first * it.second }
            val inter = rate / stage1
            return AudioPlan(rate, stage1, max(1, inter / AUDIO_OUT_RATE))
        }
    }
}

/**
 * The demodulator's audio, at its own rate [inRate], converted to exactly [outRate] by a windowed-sinc resampler (32
 * taps, Blackman window, 512 phases; the cutoff sits at 46 % of the lower of the two rates, so a rate above 48 kHz is
 * filtered before it is thinned). At exactly the output rate it is a plain copy, bit for bit. This is a fixed ratio
 * set by the rate plan; a network radio's clock drift is taken up after it, by [DriftResampler].
 */
class AudioRateConverter(val inRate: Double, val outRate: Double = AudioPlan.AUDIO_OUT_RATE.toDouble()) {
    val exact: Boolean = inRate == outRate
    private val rs: SincResampler? = if (exact) null else SincResampler(inRate, outRate, 1, TAPS, PHASES)

    /** The room [process] may need in [out] for [n] input samples. */
    fun maxOut(n: Int): Int = if (exact) n else ceil(n * outRate / inRate).toInt() + 4

    fun reset() { rs?.reset() }

    /** [n] samples of [inp] in; the converted samples go to [out] (at least [maxOut] long); returns how many. */
    fun process(inp: FloatArray, n: Int, out: FloatArray): Int {
        val r = rs ?: run { System.arraycopy(inp, 0, out, 0, n); return n }
        return r.process(inp, n, out)
    }

    companion object {
        const val TAPS = 32
        const val PHASES = 512
    }
}
