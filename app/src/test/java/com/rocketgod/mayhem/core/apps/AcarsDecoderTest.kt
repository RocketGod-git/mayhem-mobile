package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.PacketLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * ACARS end to end, as web/test/acars.mjs: a frame built the way a transmitter builds it is sent as 2400 bps MSK
 * audio on an AM carrier 250 kHz off the span centre, beside a strong AM carrier one channel away and noise.
 * Whichever way the transmitter maps bits to tones, and either polarity, the message comes back with a good CRC.
 */
class AcarsDecoderTest {
    private fun odd(c: Int): Int = if (Integer.bitCount(c) % 2 == 0) c or 0x80 else c
    private fun crcKermit(bytes: List<Int>): Int {
        var r = 0
        for (b in bytes) { var v = b; for (k in 0 until 8) { val l = (r xor v) and 1; r = r ushr 1; if (l != 0) r = r xor 0x8408; v = v ushr 1 } }
        return r
    }
    private fun frame(text: String): List<Int> {
        val body = ("2" + ".N12345" + "\u0015" + "H1" + "3" + "\u0002" + "M01A" + "UA1234" + text + "\u0003").map { odd(it.code) }
        val crc = crcKermit(body)
        return List(16) { 0xFF } + listOf(0x2B, 0x2A, 0x16, 0x16, 0x01) + body + listOf(crc and 0xff, crc shr 8, 0x7F)
    }
    private fun tones(bytes: List<Int>, kind: Int, invert: Int): List<Int> {
        val bits = bytes.flatMap { b -> (0 until 8).map { ((b shr it) and 1) xor invert } }
        var prev = 0
        return bits.map { b -> val t = when (kind) { 0 -> b; 1 -> b xor prev; else -> b xor prev xor 1 }; prev = b; t }
    }

    private fun run(kind: Int, invert: Int, seed: Long): String? {
        val rate = 2_000_000; val off = 250_000; val nb = 25_000
        val text = "POS N3412W11824 ${"ABC"[kind]}$invert"
        val ts = tones(frame(text), kind, invert) + List(40) { 1 }
        val r = java.util.Random(seed)
        val lead = (0.05 * rate).toInt(); val n = lead + Math.ceil(ts.size / 2400.0 * rate).toInt() + 4000
        val iq = ByteArray(2 * n)
        var aph = 0.0; var cph = 0.0; var nph = 0.0
        for (i in 0 until n) {
            val k = Math.floor((i - lead).toDouble() / rate * 2400).toInt()
            val on = k >= 0 && k < ts.size
            if (on) aph += 2 * PI * (if (ts[k] == 1) 2400 else 1200) / rate
            cph += 2 * PI * off / rate; nph += 2 * PI * (off + nb) / rate
            val amp = if (on) 18 * (1 + 0.7 * cos(aph)) else 0.0
            val neigh = 45 * (1 + 0.5 * sin(2 * PI * 700 * i / rate))
            val a = amp * cos(cph) + neigh * cos(nph) + 3 * r.nextGaussian()
            val b = amp * sin(cph) + neigh * sin(nph) + 3 * r.nextGaussian()
            iq[2 * i] = ((a + 127.4).roundToInt().coerceIn(0, 255)).toByte(); iq[2 * i + 1] = ((b + 127.4).roundToInt().coerceIn(0, 255)).toByte()
        }
        val log = PacketLog(); val d = AcarsDecoder(log)
        d.reset(rate); d.offsetHz = off
        var p = 0
        while (p < n) { val m = minOf(131_072, n - p); d.onIq(iq.copyOfRange(2 * p, 2 * (p + m)), 2 * m, rate); p += m }
        val lines = log.lines.value
        assertEquals("kind $kind inv $invert: one message $lines", 1, lines.size)
        return lines.firstOrNull()?.also {
            assertTrue("kind $kind inv $invert: $it", it.contains("N12345") && it.contains("H1") && it.contains("#M01A UA1234") && it.contains(text) && !it.contains("CRC?"))
        }
    }

    @Test fun acarsEveryMappingAndPolarity() { var s = 1L; for (kind in 0..2) for (inv in 0..1) run(kind, inv, s++) }

    @Test fun acarsNoiseGivesNothing() {
        val log = PacketLog(); val d = AcarsDecoder(log); val rate = 2_000_000
        d.reset(rate); d.offsetHz = 250_000
        val r = java.util.Random(99); val buf = ByteArray(2 * 131_072)
        repeat(60) { for (i in buf.indices) buf[i] = (127 + r.nextInt(21) - 10).toByte(); d.onIq(buf, buf.size, rate) }
        assertTrue("noise gave ${log.lines.value}", log.lines.value.isEmpty())
    }
}
