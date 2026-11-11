package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.TxEncoders
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

/**
 * The AIS decoder at the intermediate rates the engine hands it (rate / its first decimation: 48 to 60 kHz),
 * fed packets as a transmitter sends them: 24 bits of 0101 training, a flag, the packet, a flag.
 */
class AisDecoderRateTest {
    companion object {
        fun airBits(): BooleanArray {
            val m = ArrayList<Int>()
            fun put(v: Int, n: Int) { for (k in 0 until n) m.add((v shr (n - 1 - k)) and 1) }
            put(1, 6); put(0, 2); put(366_123_456, 30); put(0, 4); put(0, 8); put(123, 10); put(1, 1)
            put((-118.25 * 600_000).toInt() and 0xFFFFFFF, 28); put((33.75 * 600_000).toInt() and 0x7FFFFFF, 27)
            put(2_705, 12); put(271, 9); put(30, 6); put(0, 2); put(0, 3); put(0, 1); put(0, 19)
            // each octet of the message is sent LSB first: pack MSB first, and the HDLC encoder sends bytes LSB first
            val f = ArrayList<Int>((0 until 21).map { j -> (0 until 8).fold(0) { a, b -> (a shl 1) or m[8 * j + b] } })
            var crc = 0xFFFF
            for (b in f) { var v = b; repeat(8) { val bit = (crc and 1) xor (v and 1); crc = crc shr 1; if (bit != 0) crc = crc xor 0x8408; v = v shr 1 } }
            crc = crc xor 0xFFFF; f.add(crc and 0xFF); f.add(crc shr 8)
            val train = BooleanArray(24) { it % 2 == 1 }
            return train + TxEncoders.ax25Bits(ByteArray(f.size) { f[it].toByte() }, 1)
        }
    }

    private fun decoded(rate: Int, noise: Float): Int {
        val log = PacketLog(); val d = AisDecoder(log); d.reset(rate)
        val rng = Random(5)
        val dev = (2 * Math.PI * 2400 / rate).toFloat()
        val fm = ArrayList<Float>()
        repeat(rate / 20) { fm.add(0f) }
        val spb = rate / 9600.0; var acc = 0.0
        repeat(3) {
            for (b in airBits()) { acc += spb; val n = acc.toInt(); acc -= n; repeat(n) { fm.add((if (b) dev else -dev) + noise * dev * rng.nextGaussian().toFloat()) } }
            repeat(rate / 20) { fm.add(0f) }
        }
        d.onFm(fm.toFloatArray(), fm.size, rate)
        return log.count.value
    }

    @Test fun everyIntermediateRate() {
        for (r in intArrayOf(48_000, 48_780, 49_382, 50_000, 51_200, 60_000)) {
            assertEquals("clean at $r", 3, decoded(r, 0f))
            assertTrue("noisy at $r", decoded(r, 0.5f) >= 2)
        }
    }
}
