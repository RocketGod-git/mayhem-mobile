package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.PacketLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * ERT straight into the decoder: SCM packets as OOK Manchester (32768 chips a second) at both rates the app runs,
 * clean and with noise, with random gaps and timing so the clock has to find each packet on its own.
 */
class ErtDecoderTest {
    private fun crc16(bits: List<Int>, poly: Int): Int {
        var crc = 0
        for (b in bits) { val msb = (crc shr 15) and 1; crc = (crc shl 1) and 0xFFFF; if ((msb xor b) != 0) crc = crc xor poly }
        return crc
    }
    private fun field(v: Long, n: Int): List<Int> = (0 until n).map { ((v shr (n - 1 - it)) and 1L).toInt() }

    private fun scm(id: Long, cons: Long): List<Int> {
        val data = ArrayList<Int>()
        data += field(id shr 24, 2)
        data += 0; data += field(0, 2); data += field(7, 4); data += field(0, 2)
        data += field(cons, 24); data += field(id and 0xFFFFFF, 24)
        data += field(crc16(data, 0x6F63).toLong(), 16)
        return field(0x1F2A60, 21) + data
    }

    private fun packets(rate: Int, n: Int, amp: Double, noise: Double, ppm: Double = 0.0): Int {
        val log = PacketLog(); val d = ErtDecoder(log); d.reset(rate)
        val rng = Random(5)
        val chips = ArrayList<Boolean>()
        for (k in 0 until n) {
            repeat(100 + rng.nextInt(300)) { chips.add(false) }
            for (b in scm(1_000L + k, 50_000L + k)) { chips.add(b == 1); chips.add(b != 1) }
        }
        repeat(200) { chips.add(false) }
        val spc = rate / (32768.0 * (1 + ppm / 1e6))
        val total = (chips.size * spc).toInt()
        val iq = ByteArray(2 * total)
        var ph = 0.0
        for (k in 0 until total) {
            val on = chips[min(chips.size - 1, (k / spc).toInt())]
            ph += 2 * Math.PI * 300_000 / rate
            val a = if (on) amp else 0.0
            iq[2 * k] = (128 + a * cos(ph) + noise * rng.nextGaussian()).roundToInt().coerceIn(0, 255).toByte()
            iq[2 * k + 1] = (128 + a * sin(ph) + noise * rng.nextGaussian()).roundToInt().coerceIn(0, 255).toByte()
        }
        var p = 0; val chunk = 262_144
        while (p < iq.size) { val m = min(chunk, iq.size - p); d.onIq(iq.copyOfRange(p, p + m), m, rate); p += m }
        return log.lines.value.size
    }

    @Test fun cleanBothRates() {
        for (rate in intArrayOf(2_000_000, ErtDecoder.RATE)) {
            val got = packets(rate, 20, 50.0, 2.0)
            println("ERT clean @$rate: $got of 20")
            assertTrue("clean @$rate", got >= 19)
        }
    }

    @Test fun noisyAndOffClock() {
        for (rate in intArrayOf(2_000_000, ErtDecoder.RATE)) {
            for ((amp, noise, ppm) in listOf(Triple(20.0, 10.0, 0.0), Triple(10.0, 10.0, 0.0), Triple(6.0, 10.0, 0.0),
                                              Triple(20.0, 5.0, 200.0), Triple(20.0, 5.0, -200.0))) {
                val got = packets(rate, 20, amp, noise, ppm)
                println("ERT @$rate amp $amp noise $noise ppm $ppm: $got of 20")
                if (amp >= 20) assertTrue("@$rate amp $amp noise $noise ppm $ppm", got >= 18)
            }
        }
    }

    @Test fun noiseGivesNothing() {
        assertEquals(0, packets(2_000_000, 0, 0.0, 10.0))
    }
}
