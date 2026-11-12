package com.rocketgod.mayhem.core.trains

import com.rocketgod.mayhem.core.PacketLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Random
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/** Trains: EOT / HOT frames and PTC bursts, synthesized onto raw IQ, through the whole receiver. */
class TrainsTest {
    companion object {
        /** Three EOT frames off the air (PyEOT's demo recording), from the frame sync on. */
        val REAL = listOf(
            "11100010010111100001000011100101000010000100010111100010100010001110111110" to (10690 to 66),
            "11100010010111100000001000001100100100110100101101101110011010010111011011" to (19472 to 89),
            "11100010010111100000101001010110010100110101001011101011011001110010101001" to (39572 to 89))
        /** Two PTC bursts as demodulated from a recording, from the preamble on: a base station and a wayside unit. */
        const val BASE = "2222222220202122323321302121313001312030332132222022200302000323333100023300302210222011020013023031201300333210032203212310122120130032322000011021121302330111110311101202123110"
        const val WAYSIDE = "222222222020212232332130212131300131203313230101330100203202332301130101130301100032101000000000321010132103003320300103202111103100230331"

        fun bits(s: String) = s.map { it - '0' }.toIntArray()

        /** An EOT frame with these fields and a correct check. */
        fun eotFrame(unit: Int, psig: Int, motion: Boolean): IntArray {
            val p = IntArray(74)
            for (k in 0 until 11) p[k] = (EotParser.FSYNC11 shr (10 - k)) and 1
            p[13] = 1; p[14] = 1
            for (i in 0 until 17) p[18 + i] = (unit shr i) and 1
            for (i in 0 until 7) p[35 + i] = (psig shr i) and 1
            for (i in 0 until 7) p[42 + i] = (100 shr i) and 1
            p[50] = 1; p[53] = if (motion) 1 else 0; p[55] = 1
            val c = EotParser.check(IntArray(45) { p[11 + it] })
            for (i in 0 until 18) p[56 + i] = c[i]
            return p
        }

        /** NBFM IQ at [rate] carrying 1200 baud FFSK [bits] on a carrier [off] Hz from the center. */
        fun ffskIq(bits: IntArray, off: Double, rate: Int, lead: Double = 0.05, amp: Double = 30.0, noise: Double = 3.0, out: java.io.ByteArrayOutputStream = java.io.ByteArrayOutputStream()): java.io.ByteArrayOutputStream {
            val rng = Random(7)
            var ph = 0.0; var tone = 0.0
            fun push(on: Boolean, f: Double) {
                if (on) { tone += 2 * PI * f / rate; ph += 2 * PI * (off + 3000 * sin(tone)) / rate }
                val a = if (on) amp else 0.0
                out.write((128 + a * cos(ph) + noise * rng.nextGaussian()).roundToInt().coerceIn(0, 255))
                out.write((128 + a * sin(ph) + noise * rng.nextGaussian()).roundToInt().coerceIn(0, 255))
            }
            repeat((lead * rate).toInt()) { push(false, 0.0) }
            val spb = rate / 1200.0; var acc = 0.0
            for (b in bits) { acc += spb; val n = acc.toInt(); acc -= n; repeat(n) { push(true, if (b == 1) 1200.0 else 1800.0) } }
            repeat((lead * rate).toInt()) { push(false, 0.0) }
            return out
        }

        /**
         * pi/4-DQPSK IQ at [rate]: [syms] (0 = +45°, 1 = +135°, 2 = -135°, 3 = -45°) at 8000/s on [off] Hz, as a linear
         * modulation with raised-cosine pulses (beta 0.35), the way a real radio shapes it.
         */
        fun dqpskIq(syms: String, off: Double, rate: Int, out: java.io.ByteArrayOutputStream, gap: Double = 0.05, amp: Double = 30.0, noise: Double = 3.0, seed: Long = 3) {
            val rng = Random(seed)
            val sps = rate / 8000.0
            // the constellation points, with two of the first one ahead and two of the last one after (the ramps)
            val ph = DoubleArray(syms.length + 5)
            ph[0] = 0.3; ph[1] = 0.3; ph[2] = 0.3
            for ((i, c) in syms.withIndex()) ph[3 + i] = ph[2 + i] + when (c) { '0' -> PI / 4; '1' -> 3 * PI / 4; '2' -> -3 * PI / 4; else -> -PI / 4 }
            ph[syms.length + 3] = ph[syms.length + 2]; ph[syms.length + 4] = ph[syms.length + 2]
            fun rc(t: Double): Double {
                val b = 0.35
                if (kotlin.math.abs(t) < 1e-9) return 1.0
                val den = 1 - (2 * b * t) * (2 * b * t)
                val s = sin(PI * t) / (PI * t)
                return if (kotlin.math.abs(den) < 1e-6) s * PI / 4 else s * cos(PI * b * t) / den
            }
            var carrier = 0.0
            fun push(i: Double, q: Double) {
                carrier += 2 * PI * off / rate
                val c = cos(carrier); val sn = sin(carrier)
                out.write((128 + i * c - q * sn + noise * rng.nextGaussian()).roundToInt().coerceIn(0, 255))
                out.write((128 + i * sn + q * c + noise * rng.nextGaussian()).roundToInt().coerceIn(0, 255))
            }
            repeat((gap * rate).toInt()) { push(0.0, 0.0) }
            val total = ((ph.size + 2) * sps).toInt()
            for (n in 0 until total) {
                val t = n / sps - 1.0
                val k0 = t.toInt()
                var i = 0.0; var q = 0.0
                for (k in k0 - 5..k0 + 6) {
                    if (k < 0 || k >= ph.size) continue
                    val w = rc(t - k)
                    i += w * cos(ph[k]); q += w * sin(ph[k])
                }
                push(amp * i, amp * q)
            }
            repeat((gap * rate).toInt()) { push(0.0, 0.0) }
        }

        fun dotting(n: Int, endsOn: Int): IntArray = IntArray(n) { k -> if ((n - 1 - k) % 2 == 0) endsOn else 1 - endsOn }
    }

    private fun run(p: TrainsProcessor, iq: ByteArray, rate: Int) {
        p.reset(rate)
        var at = 0
        while (at < iq.size) { val n = min(262_144, iq.size - at); p.onIq(iq.copyOfRange(at, at + n), n, rate); at += n }
    }

    @Test fun realEotFrames() {
        for ((s, want) in REAL) {
            val p = EotParser.decode(bits(s))
            assertNotNull(s, p)
            assertEquals(want.first, p!!.unit); assertEquals(want.second, p.psig)
        }
        // one flipped bit fails the check
        val bad = bits(REAL[0].first).also { it[40] = 1 - it[40] }
        assertEquals(null, EotParser.decode(bad))
    }

    @Test fun eotAndHotOverTheAir() {
        val rate = TrainsProcessor.EOT_RATE
        val c = TrainsProcessor.EOT_CENTER
        val frame = eotFrame(12345, 87, motion = true)
        val tx = dotting(69, 0) + frame.drop(0).toIntArray() + IntArray(1) + dotting(69, 0) + frame + IntArray(4)
        val out = ffskIq(tx, (TrainsProcessor.EOT_HZ - c).toDouble(), rate)
        // a HOT command naming the unit: 456 bits of dotting, a 24-bit sync, the block three times
        val block = run {
            var v = 0L
            val data = (0b101L shl 27) or (12345L shl 5) or 0b10011L          // 30 data bits with the unit inside
            v = data shl 34
            if (java.lang.Long.bitCount(v) % 2 == 0) v = v or 1L
            v
        }
        val blk = IntArray(64) { ((block ushr (63 - it)) and 1L).toInt() }
        val hot = dotting(456, 0) + bits("110100101101110010010110") + blk + blk + blk + IntArray(4)
        ffskIq(hot, (TrainsProcessor.HOT_HZ - c).toDouble(), rate, out = out)
        val log = PacketLog()
        val p = TrainsProcessor(log); p.centerOf = { c }; p.band = TrainsProcessor.Band.EOT
        val seen = ArrayList<EotPacket>()
        p.onEot = { e, _ -> seen.add(e) }
        run(p, out.toByteArray(), rate)
        for (l in log.lines.value) println(l)
        assertEquals(listOf("EOT", "HOT", "DPU"), p.hears())
        assertEquals("one report for the frame sent twice", 1, seen.size)
        assertEquals(12345, seen[0].unit); assertEquals(87, seen[0].psig); assertTrue(seen[0].motion)
        val h = p.hots.value
        assertEquals(1, h.size)
        assertEquals(12345, h[0].unit)
        assertEquals(3, h[0].frame.agree)
        assertTrue(p.units.value.first().hotMs > 0)
    }

    @Test fun narrowRadioHearsTheEndUnit() {
        val rate = 2_000_000; val c = TrainsProcessor.EOT_NARROW
        val f = eotFrame(777, 90, motion = false)
        val out = ffskIq(dotting(69, 0) + f + IntArray(4), (TrainsProcessor.EOT_HZ - c).toDouble(), rate)
        val p = TrainsProcessor(PacketLog()); p.centerOf = { c }
        run(p, out.toByteArray(), rate)
        assertEquals(listOf("EOT", "DPU"), p.hears())
        assertEquals(777, p.units.value.single().unit)
    }

    @Test fun ptcStations() {
        val rate = TrainsProcessor.PTC_RATE; val c = TrainsProcessor.PTC_CENTER
        val out = java.io.ByteArrayOutputStream()
        val changed = BASE.substring(0, 100) + BASE.substring(100).map { ((it - '0' + 1) % 4).toString() }.joinToString("")
        // the base station three times (the third with new content), the wayside unit twice, unchanged
        dqpskIq(BASE, 220_712_500.0 - c, rate, out, seed = 1)
        dqpskIq(WAYSIDE, 219_512_500.0 - c, rate, out, seed = 2)
        dqpskIq(BASE, 220_712_500.0 - c, rate, out, seed = 3)
        dqpskIq(WAYSIDE, 219_512_500.0 - c, rate, out, seed = 4)
        dqpskIq(changed, 220_712_500.0 - c, rate, out, seed = 5)
        // a locomotive's burst, from 221-222 MHz
        dqpskIq(WAYSIDE, 221_437_500.0 - c, rate, out, seed = 6)
        val log = PacketLog()
        val p = TrainsProcessor(log); p.centerOf = { c }; p.band = TrainsProcessor.Band.PTC
        val got = ArrayList<PtcBurst>(); p.onPtc = { got.add(it) }; p.ptcTrace = { println(it) }
        run(p, out.toByteArray(), rate)
        for (b in got) println("burst %.4f %d sym sync %d/30 snr %d".format(b.hz / 1e6, b.symbols, b.syncScore, b.snrDb))
        for (l in log.lines.value) println(l)
        assertEquals(6, got.count { it.isPtc })
        val st = p.stations.value
        assertEquals(3, st.size)
        assertEquals(221_437_500L, st.single { it.kind == PtcStation.Kind.LOCOMOTIVE }.hz)
        val base = st.first { it.kind == PtcStation.Kind.BASE }; val way = st.first { it.kind == PtcStation.Kind.WAYSIDE }
        assertEquals(220_712_500L, base.hz); assertEquals(219_512_500L, way.hz)
        assertEquals(3, base.bursts); assertEquals(2, way.bursts)
        assertEquals("the base station repeated itself, then changed", 1, base.changes)
        assertEquals("the wayside unit's did not", 0, way.changes)
    }

    /** An RTL-SDR: 2 Msps on the narrow PTC tuning still hears the base station and the wayside unit beside it. */
    @Test fun ptcStationsOnANarrowRadio() {
        val rate = 2_000_000; val c = TrainsProcessor.PTC_NARROW
        val out = java.io.ByteArrayOutputStream()
        dqpskIq(BASE, 220_712_500.0 - c, rate, out, seed = 1)
        dqpskIq(WAYSIDE, 219_512_500.0 - c, rate, out, seed = 2)
        dqpskIq(BASE, 220_712_500.0 - c, rate, out, seed = 3)
        val log = PacketLog()
        val p = TrainsProcessor(log); p.centerOf = { c }; p.band = TrainsProcessor.Band.PTC
        val got = ArrayList<PtcBurst>(); p.onPtc = { got.add(it) }; p.ptcTrace = { println(it) }
        run(p, out.toByteArray(), rate)
        for (b in got) println("narrow burst %.4f %d sym sync %d/30 snr %d".format(b.hz / 1e6, b.symbols, b.syncScore, b.snrDb))
        assertEquals(3, got.count { it.isPtc })
        assertEquals(2, p.stations.value.size)
    }

    @Test fun noiseIsNotPtc() {
        val rate = 2_000_000; val c = TrainsProcessor.PTC_NARROW
        val out = java.io.ByteArrayOutputStream()
        // a 20 ms FM voice-like carrier is a burst on the band, but not PTC
        val rng = Random(9)
        dqpskIq((0 until 160).map { "0123"[rng.nextInt(4)] }.joinToString(""), 400_000.0, rate, out)
        val p = TrainsProcessor(PacketLog()); p.centerOf = { c }; p.band = TrainsProcessor.Band.PTC
        run(p, out.toByteArray(), rate)
        assertTrue(p.stations.value.isEmpty())
        assertEquals(1, p.ptcOther.value)
    }

    /** How much of real time the receiver takes, in each mode, on noise. */
    @Test fun speed() {
        for ((band, rate, c) in listOf(Triple(TrainsProcessor.Band.EOT, TrainsProcessor.EOT_RATE, TrainsProcessor.EOT_CENTER),
                Triple(TrainsProcessor.Band.PTC, TrainsProcessor.PTC_RATE, TrainsProcessor.PTC_CENTER))) {
            val rng = Random(1); val buf = ByteArray(262_144) { (128 + 4 * rng.nextGaussian()).roundToInt().coerceIn(0, 255).toByte() }
            val p = TrainsProcessor(PacketLog()); p.centerOf = { c }; p.band = band; p.reset(rate)
            repeat(10) { p.onIq(buf, buf.size, rate) }   // warm up
            val reps = (2 * rate * 2) / buf.size
            val t0 = System.nanoTime(); repeat(reps) { p.onIq(buf, buf.size, rate) }
            val secs = (System.nanoTime() - t0) / 1e9
            println("speed $band at ${rate / 1e6} Msps: %.0f%% of real time".format(100 * secs / (reps * buf.size / 2.0 / rate)))
        }
    }

    /** MAYHEM_TRAINS_IQ=path,rate,center,EOT|PTC: a recording (offset-128 u8 IQ) through the receiver. */
    @Test fun replayRecording() {
        val spec = System.getenv("MAYHEM_TRAINS_IQ") ?: return
        val (path, r, c, band) = spec.split(",")
        val rate = r.toInt(); val center = c.toLong()
        val log = PacketLog()
        val p = TrainsProcessor(log); p.centerOf = { center }; p.band = TrainsProcessor.Band.valueOf(band)
        var n = 0; var t = 0L
        p.now = { t }
        p.onPtc = { b -> n++; println("t %.3f s · %.4f MHz · %d sym · sync %d/30 · +%d dB".format(t / 1000.0, b.hz / 1e6, b.symbols, b.syncScore, b.snrDb)) }
        p.onEot = { e, ch -> println("$ch $e") }
        p.reset(rate)
        File(path).inputStream().buffered(1 shl 20).use { ins ->
            val buf = ByteArray(1 shl 18); var done = 0L
            while (true) {
                val k = ins.read(buf); if (k <= 0) break
                p.onIq(buf, k - (k and 1), rate); done += k; t = done / 2 * 1000 / rate
            }
        }
        for (l in log.lines.value.reversed()) println(l)
        for (s in p.stations.value) println("${s.kind} ${s.hz} bursts ${s.bursts} period %.2f s changes ${s.changes}".format(s.period()))
        println("$n bursts, ${p.ptcOther.value} not PTC")
    }
}
