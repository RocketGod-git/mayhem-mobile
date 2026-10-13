package com.rocketgod.mayhem.usb

import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Radio
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.roundToInt

/** The parts of the RTL-SDR driver that are arithmetic, checked without a dongle, plus what each radio is allowed. */
class RtlSdrTest {
    private val rtlXtal = 28_800_000L
    private val r828dXtal = 16_000_000L
    private val ifHz = 3_570_000L

    @Test fun synthesizerLandsWhereItWasAsked() {
        for (rf in longArrayOf(24_000_000, 88_500_000, 131_550_000, 137_100_000, 144_390_000, 161_975_000, 315_000_000,
            433_920_000, 868_300_000, 911_600_000, 929_612_500, 1_090_000_000, 1_575_420_000, 1_760_000_000)) {
            val lo = rf + ifHz
            val p = RtlSdr.pllPlan(lo, rtlXtal, 2)
            assertTrue("$rf reachable", p.ok)
            val got = RtlSdr.pllFreq(p, rtlXtal)
            assertTrue("$rf lands within 500 Hz (got $got)", abs(got - lo) <= 500)
            val vco = got * p.mixDiv
            assertTrue("$rf VCO $vco inside its window", vco >= 1.77e9 && vco < 3.54e9)
        }
    }

    @Test fun r828dRunsFromItsOwnCrystal() {
        for (rf in longArrayOf(433_920_000, 1_090_000_000)) {
            val lo = rf + ifHz
            val p = RtlSdr.pllPlan(lo, r828dXtal, 1, 1)
            assertTrue(p.ok)
            assertTrue(abs(RtlSdr.pllFreq(p, r828dXtal) - lo) <= 500)
        }
    }

    @Test fun fineTuneMovesTheDivider() {
        val a = RtlSdr.pllPlan(437_490_000, rtlXtal, 1); val b = RtlSdr.pllPlan(437_490_000, rtlXtal, 3)
        assertEquals(b.divNum + 2, a.divNum)
    }

    @Test fun firPacking() {
        val fir = RtlSdr.firBytes()
        assertEquals(20, fir.size)
        val signed = intArrayOf(-54, -36, -41, -40, -32, -14, 14, 53)
        for (i in 0 until 8) assertEquals(signed[i] and 0xff, fir[i])
        val twelve = intArrayOf(101, 156, 215, 273, 327, 372, 404, 421)
        var i = 0
        while (i < 8) {
            val at = 8 + (i * 3) / 2
            val v0 = (fir[at] shl 4) or (fir[at + 1] shr 4)
            val v1 = ((fir[at + 1] and 0x0f) shl 8) or fir[at + 2]
            assertEquals(twelve[i], v0); assertEquals(twelve[i + 1], v1)
            i += 2
        }
        assertTrue(fir.all { it in 0..255 })
    }

    @Test fun gainSteps() {
        assertEquals(0, RtlSdr.gainSteps(0).third)
        val max = RtlSdr.gainSteps(10_000)
        assertEquals((RtlSdr.MAX_GAIN_DB * 10).roundToInt(), max.third)
        assertTrue(max.first <= 15 && max.second <= 15)
        var last = -1
        for (want in 0..488 step 7) {
            val g = RtlSdr.gainSteps(want).third
            assertTrue("$want gives at least that", g >= want)
            assertTrue("more never gives less", g >= last); last = g
        }
    }

    @Test fun limits() {
        val r = Radio.RTLSDR; val h = Radio.HACKRF
        assertTrue(Radio.canTune(r, 433_920_000)); assertTrue(Radio.canTune(r, 1_090_000_000))
        assertFalse(Radio.canTune(r, 2_402_000_000)); assertFalse(Radio.canTune(r, 7_074_000))
        assertTrue(Radio.canTune(h, 2_402_000_000))
        assertTrue(Radio.canSample(r, 2_000_000)); assertTrue(Radio.canSample(r, 250_000))
        assertFalse(Radio.canSample(h, 250_000)); assertFalse(Radio.canSample(r, 4_000_000)); assertFalse(Radio.canSample(r, 600_000))
        assertEquals(2_000_000, Radio.nearestRate(r, 2_000_000))
        assertEquals(2_400_000, Radio.nearestRate(r, 4_000_000))
        assertEquals(2_400_000, Radio.nearestRate(r, 19_200_000))
        assertEquals(8_000_000, Radio.nearestRate(h, 8_000_000))
        assertFalse(r.canTransmit); assertTrue(h.canTransmit)
    }

    @Test fun whatDimsOnADongle() {
        val dimmed = MayhemApp.entries.filter { Radio.blockedBecause(it, Radio.RTLSDR).isNotEmpty() }.toSet()
        assertEquals(setOf(MayhemApp.HAM, MayhemApp.BTLE, MayhemApp.TRANSMIT), dimmed)
        assertTrue(MayhemApp.entries.all { Radio.blockedBecause(it, Radio.HACKRF).isEmpty() })
        assertTrue(Radio.blockedBecause(MayhemApp.TRANSMIT, Radio.RTLSDR).contains("receives only"))
        assertTrue(Radio.blockedBecause(MayhemApp.HAM, Radio.RTLSDR).contains("14.074"))
    }
}
