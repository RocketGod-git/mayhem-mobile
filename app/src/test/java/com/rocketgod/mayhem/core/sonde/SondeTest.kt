package com.rocketgod.mayhem.core.sonde

import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.apps.Retuner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min

/**
 * Sondes (the twin of web/test/sonde.mjs and SondeTest.swift): every type's frames, built the way the sonde builds
 * them, through the frame decoders, then FSK on raw IQ through the whole receiver (carrier search, channel, every
 * decoder at once). Also Reed-Solomon repair, the flight-phase tracker and the landing prediction.
 */
class SondeTest {
    private fun near(a: Double?, b: Double, tol: Double, what: String) {
        assertNotNull(what, a); assertTrue("$what: got $a, want $b ± $tol", abs(a!! - b) <= tol)
    }

    private fun flight(k: Int) = SondeSynth.FlightPoint(39.7392 + k * 1e-4, -104.9903 + k * 2e-4, 1600 + k * 5.1, 3.0, 4.0, 5.1)
    private fun padded(fr: IntArray) = fr.copyOf(fr.size + 198)

    @Test fun reedSolomonCorrectsUpToT() {
        val rng = SondeSynth.Prng(3)
        for (rs in listOf(ReedSolomon.VAISALA, ReedSolomon(0x187, 112, 11, 32))) {
            var good = 0
            for (trial in 0 until 30) {
                val cw = IntArray(255)
                for (i in rs.nroots until 255) cw[i] = (rng.next() * 256).toInt()
                rs.encode(cw)
                val ref = cw.copyOf()
                val ne = trial % (rs.nroots / 2 + 1)
                val used = LinkedHashSet<Int>()
                while (used.size < ne) used.add((rng.next() * 255).toInt())
                for (p in used) cw[p] = cw[p] xor (1 + (rng.next() * 255).toInt())
                val n = rs.decode(cw)
                if (n == ne && cw.contentEquals(ref)) good++
            }
            assertEquals("RS(255,${255 - rs.nroots}) corrects up to ${rs.nroots / 2} errors", 30, good)
        }
        // beyond t: reported or not, it must not crash
        val cw = IntArray(255); for (i in 24 until 255) cw[i] = i; ReedSolomon.VAISALA.encode(cw)
        for (i in 0 until 20) cw[i * 11] = cw[i * 11] xor 0x5a
        ReedSolomon.VAISALA.decode(cw)
    }

    @Test fun rs41FrameFields() {
        val cal = SondeSynth.rs41CalTable("RS41-SG", 403_010)
        val dec = Rs41Decoder()
        var last: SondeFrame? = null
        for (k in 0 until 52) {
            val fr = SondeSynth.rs41Frame("T1234567", 1000 + k, flight(k), cal, -20.0, 2400, 345_600_000L + k * 1000)
            last = dec.parse(padded(fr))
        }
        assertNotNull("RS41 frame parses", last); last!!
        assertEquals("RS41 serial", "T1234567", last.serial)
        assertEquals("RS41 frame number", 1051, last.frame)
        near(last.lat, 39.7392 + 51e-4, 1e-6, "RS41 latitude")
        near(last.lon, -104.9903 + 102e-4, 1e-6, "RS41 longitude")
        near(last.alt, 1600 + 51 * 5.1, 0.05, "RS41 altitude")
        near(last.climb, 5.1, 0.02, "RS41 climb")
        near(last.vH, 5.0, 0.02, "RS41 ground speed")
        near(last.heading, 53.13, 0.2, "RS41 heading")
        assertEquals("RS41 satellites", 9, last.sats)
        near(last.battV, 2.9, 0.01, "RS41 battery")
        near(last.tempC, -20.0, 0.05, "RS41 temperature from the calibration table")
        near(last.tHumC, -17.0, 0.05, "RS41 humidity-sensor temperature")
        val rh = last.rh
        assertTrue("RS41 humidity in range", rh != null && rh >= 0 && rh <= 100)
        assertEquals("RS41 reported frequency", 403_010, last.txKHz)
        assertEquals("RS41 model from the calibration table", "RS41-SG", last.model)
        assertEquals("RS41 burst-kill countdown", 0x7788, last.killS)
        assertEquals("RS41 whole calibration table", "51/51", last.extra?.get("CALIBRATION"))
        near(last.timeS, ((345_600 + 51) % 86400).toDouble(), 1e-9, "RS41 GPS time of day")
        assertEquals("RS41 clean frame needs no repair", 0, last.fixed)
        assertEquals("RS41 GPS date", "2026-01-08", last.date)
    }

    @Test fun rs41ReedSolomonRepairAndSymbols() {
        val cal = SondeSynth.rs41CalTable("RS41-SG", 403_010)
        // damage: 10 bytes in each codeword's reach, then fixed
        val fr = SondeSynth.rs41Frame("T1234567", 2000, flight(0), cal, -20.0, 2400, 0L)
        val bad = padded(fr)
        for (i in 0 until 20) bad[60 + i * 9] = bad[60 + i * 9] xor 0xa5
        val r = Rs41Decoder().parse(bad)
        assertEquals("RS41 Reed-Solomon repairs a damaged frame", "T1234567", r?.serial)
        assertEquals("RS41 reports bytes repaired", 20, r?.fixed)
        // soft symbols path (the framer's output after the header)
        val syms = SondeSynth.rs41Symbols(fr).copyOfRange(64, fr.size * 8)
        val soft = FloatArray(syms.size + 198 * 8) { if (it < syms.size && syms[it] != 0) 1f else -1f }
        assertEquals("RS41 from symbols", "T1234567", Rs41Decoder().decode(soft)?.serial)
        assertEquals("RS41 header", 64, Rs41.HEADER.length)
    }

    /** RS41 on raw IQ: one frame a second, then the carrier alone (alternating ones and zeros, like the sonde's idle). */
    private fun rs41Iq(rate: Double, offsetHz: Double, nFrames: Int, serial: String = "T7654321", snr: Double = 25.0, start: Int = 0): ByteArray {
        val cal = SondeSynth.rs41CalTable("RS41-SG")
        val parts = ArrayList<ByteArray>()
        for (k in 0 until nFrames) {
            val fr = SondeSynth.rs41Frame(serial, start + k, flight(start + k), cal, -20.0, 2400, k * 1000L)
            val syms = SondeSynth.rs41Symbols(fr)
            val all = IntArray(4800) { if (it < syms.size) syms[it] else (it - syms.size) and 1 }
            parts.add(SondeSynth.fskIq(all, 4800.0, rate, offsetHz, 2400.0, snr, 0.0, SondeSynth.Prng(100L + k)))
        }
        val out = ByteArray(parts.sumOf { it.size }); var o = 0
        for (p in parts) { p.copyInto(out, o); o += p.size }
        return out
    }

    private fun run(proc: SondeProcessor, iq: ByteArray, rate: Int, chunk: Int = 131072) {
        var o = 0
        while (o < iq.size) { val e = min(iq.size, o + chunk); val b = iq.copyOfRange(o, e); proc.onIq(b, b.size, rate); o = e }
    }

    @Test fun rs41ThroughTheReceiver() {
        val notes = ArrayList<String>()
        val rate = 2_400_000
        val tunes = ArrayList<Long>()
        val proc = SondeProcessor(PacketLog(), Retuner(tune = { tunes.add(it) }, applied = { false }))
        proc.onNote = { notes.add(it) }
        proc.setBand("400")
        proc.reset(rate)
        proc.setCenter(403_000_000L - 300_000)
        val t0 = System.currentTimeMillis()
        run(proc, rs41Iq(rate.toDouble(), 300_000.0, 5), rate)
        val rows = proc.tracker.rows(System.currentTimeMillis())
        val s = rows.firstOrNull { it.serial == "T7654321" }
        assertNotNull("RS41 through the receiver (carrier search, channel, decoder): rows ${rows.map { it.serial }}; log ${notes.joinToString(" | ")}", s)
        assertTrue("RS41 several frames through the receiver: ${s!!.frames}", s.frames >= 2)
        assertTrue("RS41 channel frequency: ${s.hz}", abs(s.hz - 403_000_000L) <= 3000)
        println("  (receiver: ${"%.1f".format((System.currentTimeMillis() - t0) / 1000.0)} s for 5 s of 2.4 Msps)")
    }

    @Test fun narrowWindowsCoverTheBand() {
        val w = SondeFront.narrowWindows(SondeFront.BANDS[0], 2_400_000)
        val half = min(2_400_000 * 0.75, 2_000_000.0) / 2
        assertTrue("narrow windows cover 400–406 MHz: $w", w.size >= 3 && w[0] - half - 137_500 <= 400_000_000 && w.last() + half - 137_500 >= 406_000_000)
    }

    @Test fun trackerBurstAndLanding() {
        val tr = SondeTracker()
        var t = 1_000_000L
        var row: SondeRow? = null
        val lat = 40.0; var lon = -105.0; var alt = 1600.0
        for (k in 0 until 1200) {   // 1 h climbing at 5 m/s, 10 m/s wind to the east
            alt += 5; lon += 10 / (111_320 * cos(lat * Math.PI / 180))
            t += 1000
            row = tr.add(SondeFrame(type = "RS41", serial = "X1", lat = lat, lon = lon, alt = alt, climb = 5.0, vH = 10.0, heading = 90.0), 403_000_000L, 20.0, t)
        }
        assertEquals("tracker: ascent", SondePhase.ASCENT, row!!.phase)
        val p = row.predict
        assertTrue("tracker: prediction drifts downwind: $p", p != null && p.lon > lon && abs(p.lat - lat) < 0.01)
        assertEquals("tracker: default burst altitude", 30_000L, p!!.burstAlt)
        for (k in 0 until 120) {
            alt -= 20; t += 1000
            row = tr.add(SondeFrame(type = "RS41", serial = "X1", lat = lat, lon = lon, alt = alt, climb = -20.0, vH = 10.0, heading = 90.0), 403_000_000L, 20.0, t)
        }
        assertEquals("tracker: descent", SondePhase.DESCENT, row!!.phase)
        val b = row.burst
        assertTrue("tracker: burst detected at the top: $b", b != null && abs(b.alt - 7600) < 30)
        val inS = row.predict?.inS
        assertTrue("tracker: time to landing: $inS", inS != null && inS > 60 && inS < 3000)
        assertTrue("tracker: burst event", tr.events.any { it.contains("burst") })
    }
}
