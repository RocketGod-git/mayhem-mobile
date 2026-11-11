package com.rocketgod.mayhem.core.ham

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

/** The integer mixer fused into the CIC gives what the float mixer followed by the CIC gives. */
class ChannelDecimatorMixTest {
    @Test fun fusedMixMatchesFloat() {
        val rate = 20_000_000; val off = -6_125_000L; val want = rate / (2 * 250_000)
        val n = 50_000
        val rnd = java.util.Random(3)
        val size = 1 shl 17; val mask = size - 1
        val ring = ByteArray(2 * size) { (rnd.nextInt(256)).toByte() }
        val from = 123_457L
        // float path, the way the scanner did it
        val w = -2 * Math.PI * off / rate
        val mixed = FloatArray(2 * n)
        for (k in 0 until n) {
            val p = ((from + k) and mask.toLong()).toInt() * 2
            val i = (ring[p].toInt() and 0xff) - 127f; val q = (ring[p + 1].toInt() and 0xff) - 127f
            val ph = w * ((from + k) % rate)
            val c = cos(ph).toFloat(); val s = sin(ph).toFloat()
            mixed[2 * k] = i * c - q * s; mixed[2 * k + 1] = i * s + q * c
        }
        val a = ChannelDecimator(want); val b = ChannelDecimator(want)
        val outA = FloatArray(a.outSize(n)); val outB = FloatArray(b.outSize(n))
        val ma = a.process(mixed, n, outA)
        val osc = ChannelDecimator.oscTable(off, rate)
        assertNotNull(osc)
        val mb = b.processMix(ring, mask, from, n, osc!!, (from % (osc.size / 2)).toInt(), outB)
        assertEquals(ma, mb)
        var peak = 0f; var err = 0f
        for (k in 0 until 2 * ma) { peak = max(peak, abs(outA[k])); err = max(err, abs(outA[k] - outB[k])) }
        assertTrue("peak $peak", peak > 1f)
        // the 14-bit table and the float path's own rounding: far below a bit of the radio's 8
        assertTrue("err $err of $peak", err < 0.01f * peak)
    }

    @Test fun longPeriodsAreRefused() {
        assertEquals(null, ChannelDecimator.oscTable(1_234_567L, 20_000_000))
        assertEquals(2 * 160, ChannelDecimator.oscTable(-6_125_000L, 20_000_000)!!.size)
    }
}
