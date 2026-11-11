package com.rocketgod.mayhem.core.lora

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/** Signed 8-bit IQ test clips, as floats. */
internal fun clip(name: String): FloatArray {
    val raw = LoraPhyTest::class.java.getResourceAsStream("/$name.i8")!!.readBytes()
    return FloatArray(raw.size) { raw[it].toFloat() }
}

/**
 * The LoRa receiver on two real Meshtastic packets (LongFast, SF11 / 250 kHz) recorded off the air with a HackRF,
 * sent by the owner's own node with known contents.
 */
class LoraPhyTest {
    private fun frames(name: String): List<LoraFrame> {
        val x = clip(name)
        val rx = LoraReceiver(11, 250_000)
        val got = ArrayList<LoraFrame>()
        rx.onFrame = { got.add(it) }
        var at = 0
        while (at < x.size) { val n = minOf(8192, x.size - at); rx.push(x.copyOfRange(at, at + n)); at += n }
        return got
    }

    @Test fun realPacketA() {
        val f = frames("meshtastic_nodeinfo_a_250k_sf11")
        assertEquals(1, f.size)
        val p = f.first()
        assertEquals(true, p.crcOk)
        assertEquals(66, p.payload.size)
        assertEquals(listOf(0xff, 0xff, 0xff, 0xff, 0x32, 0x81, 0xb1, 0x2b, 0x0e, 0x62, 0x46, 0xd4), p.payload.take(12))
        println("A: cfo ${p.cfoHz} Hz, snr ${p.snrDb} dB, sync ${p.sync}")
    }

    @Test fun realPacketB() {
        val f = frames("meshtastic_nodeinfo_b_250k_sf11")
        assertEquals(true, f.firstOrNull()?.crcOk)
        assertEquals(listOf(0xff, 0xff, 0xff, 0xff, 0x32, 0x81, 0xb1, 0x2b, 0x10, 0x96, 0xeb, 0xf5), f.first().payload.take(12))
    }

    @Test fun whitening() {
        assertEquals(listOf(0xFF, 0xFE, 0xFC, 0xF8, 0xF0, 0xE1, 0xC2, 0x85), LoraCodec.whitening.take(8))
    }
}

class MeshtasticTest {
    @Test fun aesVector() {
        // FIPS-197 appendix C.1
        val key = IntArray(16) { it }
        val pt = intArrayOf(0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff)
        assertEquals("69c4e0d86a7b0430d8cdb78070b4c55a", hexOf(Aes128.encrypt(pt, Aes128.expand(key))))
    }

    @Test fun longFastHash() {
        assertEquals(0x08, Meshtastic.channelHash("LongFast", Meshtastic.defaultKey))
    }

    @Test fun realNodeInfo() {
        val x = clip("meshtastic_nodeinfo_a_250k_sf11")
        val rx = LoraReceiver(11, 250_000)
        val got = ArrayList<LoraFrame>()
        rx.onFrame = { got.add(it) }
        rx.push(x)
        val pkt = got.firstOrNull()?.let { Meshtastic.parse(it.payload) }
        assertNotNull(pkt)
        assertEquals(0x2bb18132L, pkt!!.from)
        assertEquals(0xFFFF_FFFFL, pkt.dest)
        assertEquals(0xd446620eL, pkt.id)
        assertEquals("NODEINFO_APP", pkt.portName)
        assertEquals("Meshtastic 8132", pkt.longName)
        assertEquals("8132", pkt.shortName)
        assertEquals("HELTEC_MESH_NODE_T114", pkt.hwModel)
        println(pkt.fields)
    }
}
