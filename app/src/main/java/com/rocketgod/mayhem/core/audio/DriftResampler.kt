package com.rocketgod.mayhem.core.audio

import kotlin.math.floor

/**
 * Keeps a speaker fed from a source whose clock is not the speaker's. A network radio (rtl_tcp) is played a little
 * fast or slow on purpose (its jitter buffer steers its own depth at up to 2 % off real time) and a server's clock is
 * not the phone's, so its audio arrives up to a few percent off 48 kHz. Played as is, the output fills and drops
 * audio, or empties and underruns. This stretches or squeezes the audio by a few percent, by linear interpolation that
 * carries its phase from one block to the next (no seams), with the ratio set by how much the output has queued: a
 * proportional and integral loop holds the queue at [targetS], so a steady drift is followed without the queue
 * moving and a change is taken up over several seconds, too slowly to hear.
 *
 * Plain JVM: the caller says how much the output holds before each block ([steer]) and then resamples it ([process]).
 */
class DriftResampler(private val rate: Int = 48_000, private val targetS: Double = 0.25) {
    /** Output samples per input sample right now; always within [MAX_DEV] of 1. */
    var ratio = 1.0; private set
    private var prev = 0f        // the last input sample of the previous block
    private var pos = 0.0        // where the next output falls, in input samples after [prev]
    private var level = Double.NaN
    private var integ = 0.0

    /** A new output (opened, flushed): what was learned about the old one's queue does not apply. */
    fun reset() { ratio = 1.0; level = Double.NaN; integ = 0.0 }

    /** Before a block of [inFrames]: the output holds [queuedFrames] not yet played. */
    fun steer(queuedFrames: Int, inFrames: Int) {
        val dt = inFrames.toDouble() / rate
        val q = queuedFrames.toDouble() / rate
        // an output that is (nearly) empty is starting or refilling after a gap, not drifting: only the steady part
        // of the correction carries on, so the audio that refills it is not sped up
        if (q < MIN_STEER_S) { level = Double.NaN; ratio = 1.0 + (KI * integ).coerceIn(-MAX_DEV, MAX_DEV); return }
        level = if (level.isNaN()) q else level + (q - level) * (dt / (LEVEL_TAU_S + dt))
        val e = targetS - level
        integ = (integ + e * dt).coerceIn(-MAX_DEV / KI, MAX_DEV / KI)
        // the proportional part alone never moves it more than 3 % (an output filling up at the start)
        ratio = 1.0 + ((KP * e).coerceIn(-P_MAX, P_MAX) + KI * integ).coerceIn(-MAX_DEV, MAX_DEV)
    }

    /** Most outputs [process] can make from [n] inputs. */
    fun maxOut(n: Int): Int = (n * (1.0 + MAX_DEV)).toInt() + 2

    /** Resample [n] samples of [inp] into [out] at [ratio]; returns how many were written. */
    fun process(inp: ShortArray, n: Int, out: ShortArray): Int {
        if (n <= 0) return 0
        val step = 1.0 / ratio
        var t = pos
        var k = 0
        // the input as one stream: index 0 is [prev], 1..n are inp[0..n-1]
        while (t < n) {
            val i = floor(t).toInt()
            val f = (t - i).toFloat()
            val a = if (i == 0) prev else inp[i - 1].toFloat()
            val b = inp[i].toFloat()
            out[k++] = (a + (b - a) * f).toInt().coerceIn(-32768, 32767).toShort()
            t += step
        }
        pos = t - n
        prev = inp[n - 1].toFloat()
        return k
    }

    companion object {
        const val MAX_DEV = 0.04
        const val KP = 0.25
        const val KI = 0.02
        const val LEVEL_TAU_S = 0.5
        const val MIN_STEER_S = 0.05
        const val P_MAX = 0.03
    }
}
