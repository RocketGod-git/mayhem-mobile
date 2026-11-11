package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.PacketLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/** Our meter-mesh decoder: synthetic hopping 2-FSK bursts through it. */
class MeshDecoderTest {
    companion object {
        const val RATE = MeshDecoder.RATE
        const val CENTER = 911_600_000L

        /** Raw IQ for bursts of bits at offsets Hz from the center (one each), 2-FSK ±20 kHz, [gap] seconds apart. */
        fun iq(bursts: List<Pair<IntArray, Double>>, baud: Double = 9600.0, amp: Double = 25.0, noise: Double = 3.0, gap: Double = 0.012, rate: Int = RATE): ByteArray {
            val rng = Random(11)
            val out = java.io.ByteArrayOutputStream()
            fun push(i: Double, q: Double) {
                out.write((128 + i + noise * rng.nextGaussian()).roundToInt().coerceIn(0, 255))
                out.write((128 + q + noise * rng.nextGaussian()).roundToInt().coerceIn(0, 255))
            }
            val sps = rate / baud
            repeat((gap * rate).toInt()) { push(0.0, 0.0) }
            for ((bits, off) in bursts) {
                var ph = 0.0; var acc = 0.0
                repeat((0.001 * rate).toInt()) { ph += 2 * Math.PI * off / rate; push(amp * cos(ph), amp * sin(ph)) }   // ramp-up carrier
                for (b in bits) {
                    acc += sps; val n = acc.toInt(); acc -= n
                    repeat(n) { ph += 2 * Math.PI * (off + if (b == 1) 20_000 else -20_000) / rate; push(amp * cos(ph), amp * sin(ph)) }
                }
                repeat((gap * rate).toInt()) { push(0.0, 0.0) }
            }
            return out.toByteArray()
        }

        fun bitsOf(bytes: IntArray): IntArray = IntArray(bytes.size * 8) { (bytes[it / 8] shr (7 - it % 8)) and 1 }

        fun meshBits(payload: IntArray): IntArray =
            IntArray(32) { it and 1 } + bitsOf(intArrayOf(0xF6, 0xE5, 0x6B) + payload) + intArrayOf(0, 1, 0, 1)   // and a short tail

        val BEACON = intArrayOf(0x2A, 0x55, 0x00, 0x23, 0x30, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0x50, 0x21, 0xD0, 0x05, 0x00,
            0x7C, 0x00, 0x03, 0xFB, 0x20, 0xA4, 0x03, 0x50, 0x21, 0xD0, 0x05, 0x01, 0x00, 0x07, 0x20, 0x01, 0x1E, 0x56, 0x7E, 0x00)

        /** A Gridstream frame on air: 0xAA preamble, then each byte UART framed (start 0, 8 bits LSB first, stop 1). */
        fun gridstreamBits(body: IntArray): IntArray {
            val bits = ArrayList<Int>()
            repeat(6) { bits += bitsOf(intArrayOf(0xAA)).toList() }
            bits += listOf(1, 0, 1, 0)
            for (b in intArrayOf(0x00, 0xFF) + body + intArrayOf(0x04)) { bits.add(0); for (k in 0 until 8) bits.add((b shr k) and 1); bits.add(1) }
            return bits.toIntArray()
        }

        fun withCrc(body: IntArray, seed: Int): IntArray {
            val c = MeshDecoder.crcCcitt(body.toList(), 0, body.size, seed)
            return body + intArrayOf(c shr 8, c and 0xFF)
        }
    }

    private fun run(iq: ByteArray, rate: Int = RATE): List<MeshFrame> {
        val d = MeshDecoder(PacketLog()); d.shedding = false
        val got = ArrayList<MeshFrame>()
        d.onFrame = { got.add(it) }
        d.centerOf = { CENTER }
        d.reset(rate)
        var at = 0
        while (at < iq.size) { val n = min(262_144, iq.size - at); d.onIq(iq.copyOfRange(at, at + n), n, rate); at += n }
        return got
    }

    private val beaconPayload = listOf(0xD7, 0xEB, 0x12, 0x34, 0x0C)

    /** An RTL-SDR runs Meters at 2.0 Msps (2.4 at most): mesh and Gridstream beacons across its span still decode. */
    @Test fun rtlSdrRates() {
        for (rate in intArrayOf(2_000_000, 2_400_000)) {
            val offs = listOf(-850_000.0, -300_000.0, 420_000.0, 900_000.0)
            val mesh = offs.map { meshBits(beaconPayload.toIntArray()) to it }
            var got = run(iq(mesh, rate = rate), rate)
            assertEquals("mesh at $rate", offs.size, got.count { it.sync == 0xF6E56B && it.bytes.take(5) == beaconPayload })
            for ((f, o) in got.zip(offs)) assertEquals(CENTER + o, f.hz.toDouble(), 5_000.0)
            // a Gridstream beacon too
            got = run(iq(listOf(gridstreamBits(withCrc(BEACON, 0x45F8)) to -600_000.0), rate = rate), rate)
            assertEquals("gridstream at $rate", 1, got.count { it.sync == MeshDecoder.GRIDSTREAM && it.crcOk })
        }
    }

    @Test fun wideSpan() {
        // 19.2 Msps: beacons hopping across the whole ±9 MHz, decoded and placed right
        val rate = 19_200_000
        val offs = listOf(-8_400_000.0, -3_100_000.0, 2_250_000.0, 7_900_000.0, 450_000.0, -6_000_000.0)
        val bursts = offs.map { meshBits(beaconPayload.toIntArray()) to it }
        val samples = iq(bursts, rate = rate)
        val t0 = System.nanoTime()
        val got = run(samples, rate)
        val secs = (System.nanoTime() - t0) / 1e9; val air = (samples.size / 2).toDouble() / rate
        println("wide: %d of %d decoded, %.2f s of IQ in %.2f s".format(got.count { it.sync == 0xF6E56B }, offs.size, air, secs))
        assertEquals(offs.size, got.count { it.sync == 0xF6E56B && it.bytes.take(5) == beaconPayload })
        for ((f, o) in got.zip(offs)) assertEquals(CENTER + o, f.hz.toDouble(), 5_000.0)
    }

    @Test fun hoppingBeacons() {
        val payloads = listOf(listOf(0xD7, 0xEB, 0xA7, 0x8C, 0x0C), listOf(0xD7, 0xEB, 0x9C, 0x9E, 0x08),
            listOf(0x5F, 0xE8, 0xC4, 0x5D, 0xC0, 0x20, 0x11, 0x99, 0x42, 0x07, 0x33, 0x81))
        val offs = listOf(-1_650_000.0, 410_000.0, 1_220_000.0, -380_000.0, 1_800_000.0, -900_000.0)
        val bursts = (0 until 12).map { meshBits(payloads[it % 3].toIntArray()) to offs[it % offs.size] }
        val got = run(iq(bursts))
        for (f in got) println(MeshDecoder.line(f))
        val good = got.filter { f -> f.sync == 0xF6E56B && payloads.any { p -> f.bytes.size >= p.size && f.bytes.take(p.size) == p } }
        assertTrue("${good.size} of 12 bursts decoded", good.size >= 11)
        assertNotNull(good.firstOrNull { it.bytes.first() == 0x5F })
    }

    @Test fun pollAndReplyInOneBurst() {
        // a poll, 16 bits of fresh preamble, the sync word again and a reply, all in one burst
        val poll = listOf(0x5F, 0xE4, 0x74, 0xED); val reply = listOf(0xD3, 0xF5, 0x91, 0xDA, 0x40, 0x20, 0x11, 0x22)
        val head = meshBits(poll.toIntArray()).take(32 + 24 + 32).toIntArray()
        val pre = IntArray(16) { it and 1 }
        val bits = head + pre + bitsOf(intArrayOf(0xF6, 0xE5, 0x6B) + reply.toIntArray()) + intArrayOf(0, 1, 0, 1)
        val got = run(iq(listOf(bits to 500_000.0)))
        for (f in got) println(MeshDecoder.line(f))
        assertEquals(2, got.size)
        assertEquals(poll, got.first().bytes.take(4))
        assertEquals(reply, got.last().bytes.take(8))
    }

    @Test fun frequencyIsRight() {
        val got = run(iq(listOf(meshBits(intArrayOf(0xD7, 0xEB, 1, 2, 3)) to 777_000.0)))
        assertEquals(1, got.size)
        assertEquals(CENTER + 777_000.0, got.first().hz.toDouble(), 3_000.0)
    }

    @Test fun weakBurst() {
        val bursts = (0 until 10).map { meshBits(beaconPayload.toIntArray()) to 600_000.0 }
        val got = run(iq(bursts, amp = 6.0, noise = 4.0))
        val good = got.count { it.sync == 0xF6E56B && it.bytes.take(5) == beaconPayload }
        println("weak: $good/10")
        assertTrue(good >= 8)
    }

    @Test fun gridstreamBeacon() {
        // a 0x55 beacon laid out as on the RECESSIM wiki, CRC with the CoServ seed over the bytes after 00 FF
        val bits = gridstreamBits(withCrc(BEACON, 0x45F8))
        val got = run(iq(listOf(bits to -500_000.0, bits to 900_000.0)))
        for (f in got) println(MeshDecoder.line(f))
        assertEquals(2, got.count { it.sync == MeshDecoder.GRIDSTREAM && it.crcOk })
    }

    @Test fun gridstreamMeterCard() {
        // the same beacon twice: one meter, its id from bytes 26-29, its uptime from 20-23
        val bits = gridstreamBits(BEACON + intArrayOf(0x12, 0x34))   // a CRC with a seed we do not know: the length still checks out
        val d = MeshDecoder(PacketLog()); d.shedding = false
        d.centerOf = { CENTER }
        d.reset(RATE)
        val samples = iq(listOf(bits to 300_000.0, bits to -700_000.0))
        var at = 0
        while (at < samples.size) { val n = min(32768, samples.size - at); d.onIq(samples.copyOfRange(at, at + n), n, RATE); at += n }
        d.flush()
        val dev = d.devices.value.firstOrNull { it.net == MeshDecoder.GRIDSTREAM }
        assertNotNull(dev)
        assertEquals(0x5021D005L, dev!!.id)
        assertEquals(0x0003FB20, dev.uptimeS)
        assertEquals(2, dev.frames)
        // the CoServ beacon's WAN address is LAN-padded, not a position on earth; the decoder still reads it
        assertNotNull(dev.fields.firstOrNull { it.name == "WAN ADDRESS" })
    }

    @Test fun wanPosition() {
        val p = GridstreamWan.decode(0x42CBBE0E55E5L)!!
        assertEquals(43.0342, p.lat, 0.0001)
        assertEquals(-87.4801, p.lon, 0.0001)
        assertEquals(5, p.color)
        val oncor = GridstreamWan.decode(0x50CF8DD9E2C0L)!!   // the wiki's Oncor beacon: north Texas
        assertEquals(33.18, oncor.lat, 0.01)
        assertEquals(-96.70, oncor.lon, 0.01)
    }

    /**
     * A busy network's misread syncs are a bit slipped (the search locked early or late, or on the preamble's tail),
     * not a few bits flipped: these six came off the air here as F6E56B frames. They must not found networks of their
     * own; on the air one network was listed as about a hundred.
     */
    @Test fun slippedSyncsAreNotNewNetworks() {
        val d = MeshDecoder(PacketLog()); d.shedding = false
        var ms = 1_000L
        fun frame(sync: Int) = MeshFrame(ms, 915_000_000L, 20, sync, 9600, listOf(0xD7, 0xF5, 0x39, 0x12), 10.0).also { ms += 10 }
        repeat(30) { d.publish(frame(0xF6E56B)) }
        val ghosts = listOf(0xF56BD7, 0xB95AD7, 0x95AD7F, 0xD557DB, 0xD57DB9, 0xFB95AF)
        repeat(25) { for (g in ghosts) d.publish(frame(g)) }
        ms += 2_000; d.publish(frame(0xF6E56B))
        assertEquals(listOf(0xF6E56B), d.nets.value.map { it.sync })
        assertEquals(25 * ghosts.size, d.slips)
        // a real second network nowhere near F6E56B's stream still gets listed
        repeat(25) { d.publish(frame(0x3C9A41)) }
        ms += 2_000; d.publish(frame(0xF6E56B))
        assertTrue(d.nets.value.any { it.sync == 0x3C9A41 })
    }
}
