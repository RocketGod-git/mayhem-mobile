package com.rocketgod.mayhem.core.uat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * UAT (978 MHz), the twin of the web app's test/uat.mjs: Reed-Solomon repair, then whole frames built the way a tower
 * and an aircraft build them (DO-282B), CPFSK-modulated with noise and run through the receiver, and the METAR reader.
 */
class UatTest {
    private var seed = 7L
    private fun rnd(): Double { seed = (seed * 1103515245 + 12345) and 0xffffffffL; return seed / 4294967296.0 }

    @Test fun reedSolomonCorrectsUpToT() {
        for ((k, nr) in listOf(72 to 20, 18 to 12, 34 to 14)) {
            repeat(30) { trial ->
                val cw = UatRs.encode(IntArray(k) { (rnd() * 256).toInt() }, nr)
                val nErr = trial % (nr / 2 + 1)
                val bad = cw.copyOf()
                val pos = HashSet<Int>(); while (pos.size < nErr) pos.add((rnd() * cw.size).toInt())
                for (p in pos) bad[p] = bad[p] xor (1 + (rnd() * 255).toInt())
                assertEquals("RS($k) errors", nErr, UatRs.correct(bad, nr))
                assertTrue(bad.contentEquals(cw))
            }
            val bad = UatRs.encode(IntArray(k) { 7 }, nr)
            for (i in 0 until nr / 2 + 2) bad[i * 3] = bad[i * 3] xor 0x5a
            assertEquals(-1, UatRs.correct(bad, nr))
        }
    }

    private fun bitsOf(bytes: IntArray) = bytes.flatMap { b -> (7 downTo 0).map { (b shr it) and 1 } }
    private fun syncBits(w: Long) = (0 until 36).map { ((w shr (35 - it)) and 1).toInt() }

    /** CPFSK, h = 0.6, the exact phase integral at each sample, as offset-128 bytes (the engine's format). */
    private fun modulate(bits: List<Int>, rate: Double, noise: Double = 6.0, offsetHz: Double = 4000.0, amp: Double = 60.0): ByteArray {
        val br = UatReceiver.BITRATE; val dev = 0.3 * br; val tb = 1 / br; val lead = 100 * tb
        val n = ((bits.size + 200) * rate / br).toInt() + 1
        val cum = DoubleArray(bits.size + 1); for (i in bits.indices) cum[i + 1] = cum[i] + (if (bits[i] == 1) dev else -dev) * tb
        val out = ByteArray(2 * n)
        for (k in 0 until n) {
            val t = k / rate; val bi = floor((t - lead) / tb).toInt()
            val on = bi >= 0 && bi < bits.size
            val f = if (on) (if (bits[bi] == 1) dev else -dev) else 0.0
            val cyc = if (bi < 0) 0.0 else if (bi >= bits.size) cum[bits.size] else cum[bi] + f * (t - lead - bi * tb)
            val ph = 2 * PI * (cyc + offsetHz * t); val a = if (on) amp else 0.0
            fun g() = (rnd() + rnd() + rnd() - 1.5) * noise
            out[2 * k] = ((a * cos(ph) + g()).roundToInt().coerceIn(-127, 127) + 128).toByte()
            out[2 * k + 1] = ((a * sin(ph) + g()).roundToInt().coerceIn(-127, 127) + 128).toByte()
        }
        return out
    }

    private fun run(iq: ByteArray, rate: Int): Pair<List<ByteArray>, List<ByteArray>> {
        val ups = ArrayList<ByteArray>(); val downs = ArrayList<ByteArray>()
        val rx = UatReceiver({ m, _ -> ups.add(m) }, { b, _, _ -> downs.add(b) })
        rx.reset(rate)
        var o = 0
        while (o < iq.size) { val l = minOf(65536, iq.size - o); rx.onIq(iq.copyOfRange(o, o + l), l, rate); o += l }
        return ups to downs
    }

    @Test fun aircraftDownlink() {
        val b = IntArray(34)
        b[0] = 1 shl 3; b[1] = 0xa5; b[2] = 0xa8; b[3] = 0x14
        val rawLat = (34.3842 / 360 * (1 shl 24)).roundToInt(); val rawLon = ((-118.7675 + 360) / 360 * (1 shl 24)).roundToInt()
        b[4] = rawLat shr 15; b[5] = (rawLat shr 7) and 0xff; b[6] = ((rawLat and 0x7f) shl 1) or (rawLon shr 23)
        b[7] = (rawLon shr 15) and 0xff; b[8] = (rawLon shr 7) and 0xff; b[9] = (rawLon and 0x7f) shl 1
        val rawAlt = (8300 + 1000) / 25 + 1
        b[10] = rawAlt shr 4; b[11] = ((rawAlt and 0xf) shl 4) or 8
        val ns = 0x400 or 14; val ew = 0x400 or 100; val vv = 0x200 or 6
        b[12] = ns shr 6; b[13] = ((ns and 0x3f) shl 2) or (ew shr 9); b[14] = (ew shr 1) and 0xff
        b[15] = ((ew and 1) shl 7) or (vv shr 4); b[16] = (vv and 0xf) shl 4
        val b40 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ  .."; val cs = "N4637G  ".map { b40.indexOf(it) }
        val w1 = 1600 + cs[0] * 40 + cs[1]; val w2 = cs[2] * 1600 + cs[3] * 40 + cs[4]; val w3 = cs[5] * 1600 + cs[6] * 40 + cs[7]
        b[17] = w1 shr 8; b[18] = w1 and 0xff; b[19] = w2 shr 8; b[20] = w2 and 0xff; b[21] = w3 shr 8; b[22] = w3 and 0xff
        val bits = (syncBits(0xEACDDA4E2L) + bitsOf(UatRs.encode(b, 14))).toMutableList()
        for (i in listOf(60, 61, 200, 300)) bits[i] = bits[i] xor 1
        for (rate in listOf(2_000_000, 2_400_000, 8_000_000)) {
            val (_, downs) = run(modulate(bits, rate.toDouble()), rate)
            assertEquals("downlink at $rate", 1, downs.size)
            val t = Fisb.downlink(downs[0])
            assertEquals("A5A814", t.address)
            if (rate != 2_000_000) continue
            assertEquals("N4637G", t.callsign)
            assertEquals(34.3842, t.lat!!, 1e-4); assertEquals(-118.7675, t.lon!!, 1e-4)
            assertEquals(8300, t.altFt); assertEquals(100.0, t.speedKt!!.toDouble(), 1.0); assertEquals(262.0, t.trackDeg!!.toDouble(), 1.0)
            assertEquals(-320, t.vertFpm); assertEquals(0, t.qualifier)
        }
    }

    private fun char6(c: Char) = if (c in 'A'..'Z') c - 'A' + 1 else c.code

    private fun apdu(pid: Int, hh: Int, mm: Int, payloadBits: List<Int>): ByteArray {
        val head = ArrayList<Int>(listOf(0, 0, 0)); for (i in 10 downTo 0) head.add((pid shr i) and 1)
        head.addAll(listOf(0, 0, 0)); for (i in 4 downTo 0) head.add((hh shr i) and 1); for (i in 5 downTo 0) head.add((mm shr i) and 1)
        while (head.size % 8 != 0) head.add(0)
        val bits = head + payloadBits + List((8 - (head.size + payloadBits.size) % 8) % 8) { 0 }
        return ByteArray(bits.size / 8) { i -> var v = 0; for (k in 0 until 8) v = (v shl 1) or bits[i * 8 + k]; v.toByte() }
    }

    @Test fun towerUplinkWithMetarAndRadar() {
        val metar = "METAR KCMA 150455Z 06007KT 10SM CLR 15/11 A2999 RMK AO2="
        val a1 = apdu(413, 4, 55, metar.flatMap { c -> (5 downTo 0).map { (char6(c) shr it) and 1 } })
        val blk = 222600
        val radar = listOf(0x80 or ((blk shr 16) and 0xf), (blk shr 8) and 0xff, blk and 0xff, (31 shl 3) or 3, (31 shl 3) or 3, 31 shl 3, 31 shl 3)
        val a2 = apdu(63, 5, 36, radar.flatMap { v -> (7 downTo 0).map { (v shr it) and 1 } })
        val msg = ByteArray(432)
        val rawLat = (34.0755 / 360 * (1 shl 24)).roundToInt(); val rawLon = ((-118.6595 + 360) / 360 * (1 shl 24)).roundToInt()
        msg[0] = (rawLat shr 15).toByte(); msg[1] = (rawLat shr 7).toByte(); msg[2] = (((rawLat and 0x7f) shl 1) or (rawLon shr 23)).toByte()
        msg[3] = (rawLon shr 15).toByte(); msg[4] = (rawLon shr 7).toByte(); msg[5] = (((rawLon and 0x7f) shl 1) or 1).toByte()
        msg[6] = (0x80 or 0x20 or 7).toByte(); msg[7] = (12 shl 4).toByte()
        var i = 8
        for (a in listOf(a1, a2)) { msg[i] = (a.size shr 1).toByte(); msg[i + 1] = ((a.size and 1) shl 7).toByte(); a.copyInto(msg, i + 2); i += 2 + a.size }
        val frame = UatRs.uplinkFrame(msg)
        assertEquals(0, UatRs.uplinkMessage(frame)!!.second)
        val bits = (syncBits(0x153225B1DL) + bitsOf(frame)).toMutableList()
        for (k in listOf(100, 900, 901, 2000, 3000, 4400)) bits[k] = bits[k] xor 1
        for (rate in listOf(2_000_000, 2_400_000)) {
            val (ups, _) = run(modulate(bits, rate.toDouble()), rate)
            assertEquals("uplink at $rate", 1, ups.size)
            if (rate != 2_000_000) continue
            val st = Fisb.station(ups[0])
            assertEquals(34.0755, st.lat, 1e-4); assertEquals(-118.6595, st.lon, 1e-4); assertEquals(7, st.slot)
            val ps = Fisb.products(ups[0])
            assertEquals(2, ps.size)
            val t = Fisb.text(ps.first { it.id == 413 }.payload)
            assertTrue(t, t.startsWith("METAR KCMA 150455Z"))
            val w = Fisb.metar(t)!!
            assertEquals(60, w.windDir); assertEquals(7, w.windKt); assertEquals(10.0, w.visSm!!, 0.0); assertEquals(15, w.tempC)
            assertEquals(29.99, w.altimInHg!!, 1e-9); assertEquals("VFR", w.category)
            val rb = Fisb.radarBlocks(ps.first { it.id == 63 })
            assertEquals(1, rb.size); assertEquals(32.93, rb[0].lat, 0.01); assertEquals(-120.0, rb[0].lon, 0.01)
            assertEquals(3, rb[0].bins!![0].toInt()); assertEquals(0, rb[0].bins!![127].toInt())
        }
    }

    @Test fun metarCategories() {
        assertEquals("IFR", Fisb.metar("METAR KSFO 150456Z 28012G20KT 2SM BR OVC008 12/11 A3001")?.category)
        assertEquals("LIFR", Fisb.metar("METAR KSMO 150451Z 00000KT 1/2SM FG VV002 13/13 A3000")?.category)
        assertEquals("MVFR", Fisb.metar("METAR KBUR 150453Z 15005KT 6SM HZ BKN025 16/11 A3002")?.category)
        assertEquals(-2, Fisb.metar("METAR K05U 150535Z AUTO 21006KT 10SM CLR M02/M03 A3010")?.tempC)
        assertNotNull(Fisb.metar("SPECI KLAX 150500Z 08004KT 10SM FEW027 18/12 A3000"))
        assertTrue(abs(1.0) > 0)
    }

    /** One-off: the real 978 MHz recording from the roof, when it is on this machine. */
    @Test fun realRecordingWhenPresent() {
        val f = java.io.File(System.getenv("UAT_REAL") ?: return)
        if (!f.exists()) return
        val raw = f.readBytes()
        for (k in raw.indices) raw[k] = (raw[k] + 128).toByte()
        val ups = ArrayList<ByteArray>(); val downs = ArrayList<ByteArray>()
        val rx = UatReceiver({ m, _ -> ups.add(m) }, { b, _, _ -> downs.add(b) })
        rx.reset(2_000_000)
        var o = 0
        while (o < raw.size) { val l = minOf(262144, raw.size - o); rx.onIq(raw.copyOfRange(o, o + l), l, 2_000_000); o += l }
        println("REAL: ${ups.size} uplinks, ${downs.size} downlinks, ${rx.bad} failed; aircraft " + downs.map { Fisb.downlink(it).let { t -> t.callsign ?: t.address } }.toSet())
    }
}
