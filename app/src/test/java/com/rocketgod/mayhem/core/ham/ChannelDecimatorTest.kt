package com.rocketgod.mayhem.core.ham

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sin

/** The engine's narrow-mode first decimation: what it passes and what it keeps from folding onto the channel. */
class ChannelDecimatorTest {
    /** Output power (dB) of a tone at [hz] through a decimator for [rate], after the filter settles. */
    private fun gainDb(rate: Int, hz: Double): Double {
        val dec = ChannelDecimator(rate / 48_000)
        val n = max(rate / 20, 60_000)
        val inp = FloatArray(2 * n)
        for (k in 0 until n) {
            val ph = 2 * Math.PI * hz * k / rate
            inp[2 * k] = (50 * cos(ph)).toFloat(); inp[2 * k + 1] = (50 * sin(ph)).toFloat()
        }
        val out = FloatArray(dec.outSize(n))
        val m = dec.process(inp, n, out)
        var p = 0.0
        for (k in m / 2 until m) p += (out[2 * k] * out[2 * k] + out[2 * k + 1] * out[2 * k + 1]).toDouble()
        return 10 * log10(p / (m - m / 2) / 2500 + 1e-15)
    }

    @Test fun splits() {
        assertEquals(40, ChannelDecimator.split(40).first * ChannelDecimator.split(40).second)
        assertEquals(40, ChannelDecimator.split(41).first * ChannelDecimator.split(41).second)
        val (c, f) = ChannelDecimator.split(83)
        assertTrue("${c}x$f", c * f <= 83 && c * f >= 78 && f in 3..6)
    }

    @Test fun passesTheChannel() {
        for (rate in intArrayOf(1_920_000, 2_000_000, 2_400_000, 4_000_000, 10_000_000, 20_000_000)) {
            for (hz in doubleArrayOf(0.0, 5_000.0, -8_000.0, 12_000.0)) {
                val g = gainDb(rate, hz)
                assertEquals("$hz Hz at $rate: $g dB", 0.0, g, 0.6)
            }
        }
    }

    @Test fun rejectsWhatWouldFold() {
        for (rate in intArrayOf(1_920_000, 2_000_000, 2_400_000, 4_000_000, 10_000_000, 20_000_000)) {
            val out = rate / ChannelDecimator(rate / 48_000).total
            // every tone that lands within ±12 kHz of the channel after decimation, out to 400 kHz
            var worst = -200.0
            for (n in 1..8) for (d in doubleArrayOf(-12_000.0, -6_000.0, 0.0, 6_000.0, 12_000.0))
                for (s in doubleArrayOf(1.0, -1.0)) worst = max(worst, gainDb(rate, s * (n * out + d)))
            assertTrue("worst fold at $rate: $worst dB", worst < -50)
            println("fold rejection at $rate: ${"%.0f".format(worst)} dB")
        }
    }
}
