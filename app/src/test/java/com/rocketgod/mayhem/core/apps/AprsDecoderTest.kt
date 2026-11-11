package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.PacketLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import com.rocketgod.mayhem.core.TxEncoders
import java.util.Random
import kotlin.math.pow
import kotlin.math.sin

/** The APRS payload, read the way APRS clients do, from packets taken from the specification's own examples. */
class AprsDecoderTest {
    private fun heard(vararg packets: Pair<String, String>): List<AprsStation> {
        val d = AprsDecoder(PacketLog())
        for ((src, info) in packets) d.packet(src, "APZMHM", "WIDE1-1", info)
        return d.table.value
    }
    private fun one(src: String, info: String) = heard(src to info).first { it.call == src }

    @Test fun uncompressedPosition() {
        val s = one("N0CALL-9", "!4903.50N/07201.75W-Test")
        assertEquals(49.0583, s.lat!!, 0.001); assertEquals(-72.0292, s.lon!!, 0.001)
        assertEquals('/', s.table); assertEquals('-', s.symbol); assertEquals("House", aprsSymbolName(s.table, s.symbol))
        assertEquals("Test", s.comment)
    }

    @Test fun courseSpeedAndAltitude() {
        val s = one("N0CALL-9", "=4903.50N/07201.75W>088/036/A=001234 on the road")
        assertEquals(88, s.course); assertEquals(36.0, s.speed!!, 0.01); assertEquals(1234 * 0.3048, s.alt!!, 0.01)
        assertEquals("on the road", s.comment)
    }

    @Test fun compressedPosition() {
        val s = one("N0CALL", "=/5L!!<*e7>7P[")
        assertEquals(49.5, s.lat!!, 0.001); assertEquals(-72.75, s.lon!!, 0.001)
        assertEquals('>', s.symbol); assertEquals(88, s.course); assertEquals(36.2, s.speed!!, 0.1)
    }

    @Test fun statusAndMessage() {
        assertEquals("NET tonight 7pm", one("W1AW", ">NET tonight 7pm").status)
        val m = one("K1ABC-1", ":N0CALL-9 :hello world{1")
        assertEquals("N0CALL-9" to "hello world", m.lastMsg)
        assertNull(one("K1ABC-2", ":N0CALL-9 :ack1").lastMsg)
    }

    @Test fun weather() {
        val w = one("W6XYZ", "!4903.50N/07201.75W_270/010g015t072h50b10132").wx
        assertNotNull(w)
        assertEquals(270, w!!.windDir); assertEquals(10, w.windMph); assertEquals(15, w.gustMph); assertEquals(72, w.tempF)
        assertEquals(50, w.humidity); assertEquals(1013.2, w.pressureMb!!, 0.01)
    }

    @Test fun objectsBelongToTheirSender() {
        val all = heard("N0CALL" to ";LEADER   *092345z4903.50N/07201.75W>088/036")
        val o = all.first { it.call == "LEADER" }
        assertEquals("object", o.kind); assertEquals("N0CALL", o.owner); assertEquals(49.0583, o.lat!!, 0.001)
    }

    @Test fun thirdPartyIsCreditedToTheOriginalStation() {
        val all = heard("IGATE-10" to "}W1ABC>APRS,TCPIP,WIDE2-1:!4903.50N/07201.75W-hi")
        val s = all.first { it.call == "W1ABC" }
        assertEquals("IGATE-10", s.via); assertEquals("TCPIP,WIDE2-1", s.path); assertEquals(49.0583, s.lat!!, 0.001)
    }

    @Test fun packetsAccumulate() {
        val s = heard("W1AW" to ">one", "W1AW" to ">two").first()
        assertEquals(2, s.packets); assertEquals("two", s.status)
    }
    /**
     * AFSK straight into the decoder as discriminator output at 48 kHz, one tone [tiltDb] louder than the other (as
     * pre-emphasis and radio audio leave it), with noise. Returns how many of [n] packets came through.
     */
    private fun afskPackets(tiltDb: Double, noise: Double, n: Int = 10): Int {
        val log = PacketLog(); val d = AprsDecoder(log)
        val rate = 48_000; val rng = Random(11)
        val space = 10.0.pow(tiltDb / 20)
        var ph = 0.0
        val buf = FloatArray(4_800)
        var at = 0
        fun push(x: Float) { buf[at++] = x; if (at == buf.size) { d.onFm(buf, at, rate); at = 0 } }
        for (k in 0 until n) {
            val frame = TxEncoders.ax25Aprs("N0CALL-$k", "!3415.00N/11847.00W>tilt test packet $k")
            val bits = TxEncoders.ax25Bits(frame, 24)
            repeat(2_400) { push((noise * rng.nextGaussian()).toFloat()) }
            var acc = 0.0
            for (b in bits) {
                acc += 40.0; val m = acc.toInt(); acc -= m
                repeat(m) {
                    ph += 2 * Math.PI * (if (b) 1200.0 else 2200.0) / rate
                    val a = (if (b) 1.0 else space) * sin(ph)
                    // discriminator output: radians a sample, 3 kHz deviation, plus noise
                    val x = 2 * Math.PI * 3000 * a / rate
                    push((x + noise * rng.nextGaussian()).toFloat())
                }
            }
        }
        repeat(4_800) { push(0f) }
        return log.lines.value.toSet().size
    }

    @Test fun afskFlat() { assertEquals(10, afskPackets(0.0, 0.05)) }
    @Test fun afskSpaceTiltedUp() { assertTrue(afskPackets(6.0, 0.05) >= 9) }
    @Test fun afskSpaceTiltedDown() { assertTrue(afskPackets(-6.0, 0.05) >= 9) }
    @Test fun afskNoisy() { println("APRS noisy: ${afskPackets(-4.0, 0.25)} of 10") }
}
