package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.PacketLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

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
}
