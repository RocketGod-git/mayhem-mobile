package com.rocketgod.mayhem.core.lora

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.PacketLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * The LoRa app: the wideband scanner on a real Meshtastic packet placed in a wider span, the MeshCore and LoRaWAN
 * parsers on frames built to their published layouts, and the hashes and ciphers they lean on.
 */
class LoraAppTest {
    private fun bytes(s: String): IntArray { val b = s.toByteArray(Charsets.UTF_8); return IntArray(b.size) { b[it].toInt() and 0xff } }

    @Test fun sha256AndHmac() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", hexOf(Sha256.hash(bytes("abc"))))
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", hexOf(Sha256.hash(IntArray(0))))
        // RFC 4231 test case 2
        assertEquals("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
            hexOf(Sha256.hmac(bytes("Jefe"), bytes("what do ya want for nothing?"))))
    }

    @Test fun aesDecrypt() {
        val key = IntArray(16) { it }
        val ct = intArrayOf(0x69, 0xc4, 0xe0, 0xd8, 0x6a, 0x7b, 0x04, 0x30, 0xd8, 0xcd, 0xb7, 0x80, 0x70, 0xb4, 0xc5, 0x5a)
        assertEquals("00112233445566778899aabbccddeeff", hexOf(Aes128.decrypt(ct, Aes128.expand(key))))
    }

    /** A text on a channel whose name no preset has, on public key 3: decrypted by trying the public keys. */
    @Test fun meshtasticAnyPublicChannel() {
        val text = bytes("hello from a custom channel")
        val data = intArrayOf(0x08, 0x01, 0x12, text.size) + text          // portnum 1 (text), payload
        val from = intArrayOf(0x32, 0x81, 0xb1, 0x2b); val id = intArrayOf(0x11, 0x22, 0x33, 0x44)
        val nonce = IntArray(16)
        for (k in 0 until 4) { nonce[k] = id[k]; nonce[8 + k] = from[k] }
        val ct = Aes128.ctr(Meshtastic.simpleKeys[2], nonce, data)
        val pkt = intArrayOf(0xff, 0xff, 0xff, 0xff) + from + id + intArrayOf(0x63, 0x5A, 0x00, 0x00) + ct   // channel hash 5A
        val p = Meshtastic.parse(pkt.toList())
        assertNotNull(p)
        assertEquals(1, p!!.portnum)
        assertEquals("hello from a custom channel", p.text)
    }

    @Test fun meshtasticPlan() {
        assertEquals(906_875_000L, LoraScanner.plan.firstOrNull { it.name == "Meshtastic LongFast US" }?.hz)
        assertEquals(913_125_000L, LoraScanner.plan.firstOrNull { it.name == "Meshtastic MediumFast US" }?.hz)
        assertEquals(918_875_000L, LoraScanner.plan.firstOrNull { it.name == "Meshtastic ShortFast US" }?.hz)
        // worldwide: Meshtastic's own slot rule per region
        assertEquals(919_875_000L, LoraScanner.plan.firstOrNull { it.name == "Meshtastic LongFast ANZ" }?.hz)
        assertEquals(869_525_000L, LoraScanner.plan.firstOrNull { it.name == "Meshtastic LongFast EU_868" }?.hz)
        assertTrue(LoraScanner.plan.firstOrNull { it.name == "Meshtastic LongFast EU_868" }?.standing == true)
        assertTrue(LoraScanner.plan.any { it.name == "MeshCore EU/UK narrow" && it.hz == 869_618_000L })
    }

    @Test fun meshCoreAdvert() {
        val b = ArrayList<Int>()
        b += listOf(0x11, 0x00)                                  // flood (1) advert (4 << 2), no hops
        b += (0 until 32).map { (it * 7) and 0xFF }
        b += listOf(0x10, 0x32, 0x54, 0x76)                      // timestamp
        repeat(64) { b.add(0xAA) }                               // signature
        b.add(0x92)                                              // has name (80), has position (10), repeater (2)
        for (v in intArrayOf(34_273_650, -118_780_320)) for (k in 0 until 4) b.add((v ushr (8 * k)) and 0xFF)
        b += bytes("Simi Hill RPT").toList()
        val p = MeshCore.parse(b)
        assertNotNull(p)
        assertEquals("ADVERT", p!!.typeName)
        assertEquals("repeater", p.nodeType)
        assertEquals("Simi Hill RPT", p.name)
        assertEquals(34.27365, p.lat!!, 1e-6)
        assertEquals(-118.78032, p.lon!!, 1e-6)
    }

    @Test fun meshCorePublicGroupText() {
        // a group message encrypted the way MeshCore does it: AES-128 ECB under the channel key, 2-byte HMAC-SHA256
        val key = MeshCore.publicKey
        var plain = intArrayOf(0x00, 0x10, 0x20, 0x30, 0x00) + bytes("RocketGod: hello mesh")
        while (plain.size % 16 != 0) plain += 0
        val rk = Aes128.expand(key)
        var ct = IntArray(0)
        var i = 0
        while (i < plain.size) { ct += Aes128.encrypt(plain.copyOfRange(i, i + 16), rk); i += 16 }
        val mac = Sha256.hmac(key + IntArray(16), ct)
        val b = intArrayOf(0x15, 0x41, 0xAB, 0xCD) + intArrayOf(Sha256.hash(key)[0], mac[0], mac[1]) + ct   // 1 hop, 2-byte hashes
        val p = MeshCore.parse(b.toList())
        assertNotNull(p)
        assertEquals(2, p!!.hashSize)
        assertEquals(listOf(listOf(0xAB, 0xCD)), p.path)
        assertEquals("Public", p.channel)
        assertEquals("RocketGod: hello mesh", p.text)
        assertEquals("RocketGod", p.name)
    }

    @Test fun loraWanJoinAndData() {
        val j = listOf(0x00) + listOf(0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08) + listOf(0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88) +
            listOf(0x9A, 0xBC, 1, 2, 3, 4)
        val p = LoraWan.parse(j)
        assertNotNull(p)
        assertEquals("JOIN REQUEST", p!!.typeName)
        assertEquals(0x8877665544332211UL.toLong(), p.devEui)
        val d = listOf(0x40, 0x78, 0x56, 0x34, 0x12, 0x80, 0x2A, 0x00, 0x01, 0xDE, 0xAD, 9, 9, 9, 9)
        val q = LoraWan.parse(d)
        assertNotNull(q)
        assertEquals("UPLINK", q!!.typeName)
        assertEquals(0x12345678L, q.devAddr)
        assertEquals(42, q.fcnt)
        assertEquals(1, q.port)
    }

    /**
     * The real LongFast packet (250 kHz, one sample a chip) band-limited up to 2 Msps, moved 300 kHz off the center,
     * quantized like a radio's samples, and given to the scanner, which has to find it, pick its bandwidth, and
     * decode it as Meshtastic without being told where it is.
     */
    @Test fun scannerFindsPacketInSpan() {
        val raw = clip("meshtastic_nodeinfo_a_250k_sf11")
        val n = raw.size / 2
        val up = 8; val rate = 2_000_000
        var big = 1; while (big < n) big = big shl 1
        val re = FloatArray(big); val im = FloatArray(big)
        for (k in 0 until n) { re[k] = raw[2 * k]; im[k] = raw[2 * k + 1] }
        Dsp.fft(re, im)
        val m = big * up
        val r2 = FloatArray(m); val i2 = FloatArray(m)
        for (k in 0 until big) {
            val dst = if (k < big / 2) k else m - (big - k)
            r2[dst] = re[k]; i2[dst] = -im[k]                    // conjugate: the forward FFT then inverts
        }
        Dsp.fft(r2, i2)
        val off = 300_000.0; val scale = 0.3f / big          // the clip peaks near 165: keep it inside 8 bits
        val total = m + rate / 10
        val out = ByteArray(2 * total)
        var seed = 1L
        fun noise(): Float { seed = (seed * 1_664_525 + 1_013_904_223) and 0xFFFF_FFFFL; return (seed ushr 8).toFloat() / (1 shl 24) - 0.5f }
        for (k in 0 until total) {
            var x = 0f; var y = 0f
            if (k >= rate / 20 && k - rate / 20 < m) {
                val s = k - rate / 20
                val a = r2[s] * scale; val b = -i2[s] * scale
                val w = 2 * Math.PI * off * k / rate
                x = a * cos(w).toFloat() - b * sin(w).toFloat(); y = a * sin(w).toFloat() + b * cos(w).toFloat()
            }
            x += 6 * noise(); y += 6 * noise()
            out[2 * k] = (x + 127.4f).roundToInt().coerceIn(0, 255).toByte()
            out[2 * k + 1] = (y + 127.4f).roundToInt().coerceIn(0, 255).toByte()
        }
        val hub = LoraHub(PacketLog())
        hub.scanner.shedding = false
        val center = 906_875_000L - 300_000
        hub.scanner.centerOf = { center }
        val got = ArrayList<LoraEvent>()
        hub.onHeard = { _, e -> got.add(e) }
        hub.scanner.reset(rate)
        var at = 0
        val chunk = 131_072
        while (at < out.size) { val c = minOf(chunk, out.size - at); hub.scanner.onIq(out.copyOfRange(at, at + c), c, rate); at += c }
        for (e in got) println("EVENT " + e.line)
        val e = got.firstOrNull { it.proto == "Meshtastic" }
        assertNotNull(e)
        assertEquals("NODEINFO_APP", e!!.kind)
        assertEquals(1, hub.nodes.value.size)
        println("bursts ${hub.bursts.value}")
        assertTrue(hub.bursts.value in 1..4)
    }

    /**
     * A real off-air recording through the whole receiver, as the radio would feed it. Runs only when
     * MAYHEM_LORA_IQ names an offset-128 u8 file called iq_<rate>_<centerHz>.u8 (MAYHEM_LORA_SECS caps the length).
     * Prints every event and how many bursts were heard, to compare with the iPad/Mac decoder on the same file.
     */
    @Test fun replayRecording() {
        val path = System.getenv("MAYHEM_LORA_IQ") ?: return
        val m = Regex("""iq_(\d+)_(\d+)""").find(java.io.File(path).name) ?: error("name must be iq_<rate>_<center>.u8")
        val rate = m.groupValues[1].toInt(); val center = m.groupValues[2].toLong()
        val secs = System.getenv("MAYHEM_LORA_SECS")?.toDouble() ?: 1e9
        val hub = LoraHub(PacketLog())
        hub.scanner.shedding = false
        hub.scanner.centerOf = { center }
        val got = ArrayList<LoraEvent>()
        val out = java.io.File("$path.android.txt").printWriter()
        hub.onHeard = { _, e -> got.add(e); out.println("EVENT %.1fs %s".format(e.ms / 1000.0, e.line)) }
        val hubHeard = hub.scanner.onHeard
        hub.scanner.onHeard = { h -> hubHeard?.invoke(h); out.println("FRAME %.4f MHz SF%d/%d crc %s len %d inv %s head %s".format(h.hz / 1e6, h.frame.sf, h.frame.bw, h.frame.crcOk, h.frame.payload.size, h.inverted, h.frame.payload.take(6).joinToString("") { "%02X".format(it) })) }
        val hubBurst = hub.scanner.onBurst
        hub.scanner.onBurst = { hz, bw, name -> hubBurst?.invoke(hz, bw, name); out.println("BURST %.4f MHz bw %d %s".format(hz / 1e6, bw, name ?: "-")) }
        hub.scanner.reset(rate)
        val limit = (secs * rate * 2).toLong()
        var done = 0L
        val t0 = System.nanoTime()
        java.io.FileInputStream(path).use { f ->
            val buf = ByteArray(262_144)
            while (done < limit) {
                val n = f.read(buf); if (n <= 0) break
                hub.scanner.onIq(buf, n, rate); done += n
            }
        }
        out.println("STAGES " + LoraReceiver.Stats.line())
        out.println("REPLAY %.1f s of air in %.1f s · %d events · bursts %d · nodes %d".format(done / 2.0 / rate, (System.nanoTime() - t0) / 1e9, got.size, hub.bursts.value, hub.nodes.value.size))
        out.close()
    }
}
