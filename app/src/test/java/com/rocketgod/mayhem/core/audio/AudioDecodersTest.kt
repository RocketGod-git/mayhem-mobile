package com.rocketgod.mayhem.core.audio

import com.rocketgod.mayhem.core.Dsp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/** RDS, SAME and HD Radio, each fed from a transmit-side model written from the standard rather than the decoder. */
class AudioDecodersTest {
    // ---- RDS ----
    private val g = 0x5b9
    private fun xPowMod(k: Int): Int { var r = 1; repeat(k) { r = r shl 1; if (r and 0x400 != 0) r = r xor g }; return r }
    private fun crcRef(data: Int): Int { var r = 0; val v = (data and 0xffff) shl 10; for (i in 0 until 26) if ((v ushr i) and 1 == 1) r = r xor xPowMod(i); return r }
    private fun blockRef(data: Int, off: Int) = ((data and 0xffff) shl 10) or (crcRef(data) xor off)
    private fun pair(s: String, i: Int): Int {
        fun code(j: Int) = if (j < s.length) s[j].code and 0xff else 0x20
        return (code(i) shl 8) or code(i + 1)
    }
    private fun blockB(type: Int, tp: Boolean, pty: Int, low: Int) = (type shl 12) or ((if (tp) 1 else 0) shl 10) or ((pty and 0x1f) shl 5) or (low and 0x1f)
    private fun group(pi: Int, b: Int, c: Int, d: Int) = intArrayOf(blockRef(pi, OFFSET_A), blockRef(b, OFFSET_B), blockRef(c, OFFSET_C), blockRef(d, OFFSET_D))

    private val rt = "MAYHEM MOBILE RADIO DATA SYSTEM TEST\r"
    private fun stationBits(): IntArray {
        val pi = 0xc0fe; val ps = "MAYHEM  "; val pty = 10
        val afCodes = listOf(224 + 3, 168, 1, 124, 205)       // 104.3, 87.6, 99.9 behind a count, filler at the end
        val afPairs = listOf((afCodes[0] shl 8) or afCodes[1], (afCodes[2] shl 8) or afCodes[3], (afCodes[4] shl 8) or 205)
        val psG = (0 until 4).map { seg -> group(pi, blockB(0, true, pty, (1 shl 3) or seg), afPairs[seg % afPairs.size], pair(ps, 2 * seg)) }
        val rtG = (0 until ceil(rt.length / 4.0).toInt()).map { seg -> group(pi, blockB(2, true, pty, seg), pair(rt, 4 * seg), pair(rt, 4 * seg + 2)) }
        val groups = ArrayList<IntArray>()
        for (i in 0 until maxOf(psG.size, rtG.size)) { if (i < psG.size) groups.add(psG[i]); if (i < rtG.size) groups.add(rtG[i]) }
        val bits = ArrayList<Int>()
        for (gr in groups) for (blk in gr) for (i in 25 downTo 0) bits.add((blk ushr i) and 1)
        return bits.toIntArray()
    }

    /** Composite with pilot, mono audio, a stereo sideband, DC, noise, and RDS on 57 kHz with differential biphase. */
    private fun mpx(bits: IntArray, rate: Int, seconds: Double, freqError: Double = 0.0, phase0: Double = 0.0, noise: Double = 0.0): FloatArray {
        val ratio = 1 + freqError / 57000; val baud = 1187.5 * ratio; val fsc = 57000 + freqError
        val n = (rate * seconds).roundToInt()
        val enc = ArrayList<Int>(); var prev = 0; var next = 0
        fun tBit(idx: Int): Int { while (enc.size <= idx) { prev = prev xor bits[next++ % bits.size]; enc.add(prev) }; return enc[idx] }
        val bb = FloatArray(n) { k -> val h = floor(k.toDouble() / rate * 2 * baud).toInt(); val par = h and 1; if (tBit(h shr 1) == 1) (if (par == 1) -1f else 1f) else (if (par == 1) 1f else -1f) }
        val rng = Random(7)
        return FloatArray(n) { k ->
            val t = k.toDouble() / rate
            (0.05 + 0.4 * sin(2 * PI * 1000 * t) + 0.15 * sin(2 * PI * 12000 * t) * cos(2 * PI * 38000 * ratio * t) +
                0.09 * sin(2 * PI * 19000 * ratio * t) + 0.03 * bb[k] * cos(2 * PI * fsc * t + phase0) + noise * rng.nextGaussian()).toFloat()
        }
    }
    private fun rds(sig: FloatArray, rate: Int): RdsState {
        val d = RdsDecoder {}
        var at = 0
        while (at < sig.size) { val n = minOf(4096, sig.size - at); d.push(sig.copyOfRange(at, at + n), n, rate); at += n }
        return d.state
    }

    @Test fun rdsCheckwordMatchesTheGeneratorMatrix() {
        for (i in 0 until 300) {
            val data = (i * 48271 + 31) and 0xffff
            for (off in intArrayOf(OFFSET_A, OFFSET_B, OFFSET_C, OFFSET_CP, OFFSET_D)) {
                assertEquals(crcRef(data) xor off, rdsCheckword(data, off))
                assertEquals(off, rdsSyndrome(blockRef(data, off)))
            }
        }
    }

    @Test fun rdsCleanStation() {
        val st = rds(mpx(stationBits(), 250_000, 3.0), 250_000)
        assertTrue(st.synced)
        assertEquals(0xc0fe, st.pi)
        assertEquals("MAYHEM  ", st.ps)
        assertEquals(rt.trimEnd('\r'), st.rt)
        assertEquals("Pop Music", st.ptyName)
        assertTrue(st.tp); assertTrue(st.ms); assertFalse(st.ta)
        assertEquals(listOf(87.6, 99.9, 104.3), st.af)
        assertEquals(0, st.errors)
    }

    @Test fun rdsCarrierErrorPhaseNoiseAndRate() {
        assertEquals(rt.trimEnd('\r'), rds(mpx(stationBits(), 250_000, 3.0, freqError = 20.0, phase0 = 0.7), 250_000).rt)
        assertEquals("MAYHEM  ", rds(mpx(stationBits(), 250_000, 3.0, phase0 = PI), 250_000).ps)
        assertEquals("MAYHEM  ", rds(mpx(stationBits(), 250_000, 3.0, phase0 = 0.4, noise = 0.05), 250_000).ps)
        assertEquals(rt.trimEnd('\r'), rds(mpx(stationBits(), 192_000, 3.0, freqError = 10.0), 192_000).rt)
    }

    // ---- SAME ----
    private val sameRate = 48_000
    private fun bitsLsb(b: Int) = IntArray(8) { (b shr it) and 1 }
    private fun burstBits(text: String): IntArray {
        val o = ArrayList<Int>()
        repeat(16) { o.addAll(bitsLsb(0xab).toList()) }
        for (ch in text) o.addAll(bitsLsb(ch.code).toList())
        return o.toIntArray()
    }
    private fun afsk(bits: IntArray): FloatArray {
        val n = ceil(bits.size * sameRate / SAME_BAUD).toInt()
        var ph = 0.0
        return FloatArray(n) { k -> val bit = bits[minOf(bits.size - 1, floor(k * SAME_BAUD / sameRate).toInt())]; ph += 2 * PI * (if (bit == 1) 2083.33 else 1562.5) / sameRate; sin(ph).toFloat() }
    }
    private fun silence(s: Double) = FloatArray((s * sameRate).roundToInt())
    private fun tone(hz: Double, s: Double) = FloatArray((s * sameRate).roundToInt()) { sin(2 * PI * hz * it / sameRate).toFloat() }
    private fun discriminate(audio: FloatArray, noise: Double = 0.0): FloatArray {
        val r = Random(3); var ph = 0.0; var pi = 1.0; var pq = 0.0
        return FloatArray(audio.size) { k ->
            ph += 2 * PI * 3000 * audio[k] / sameRate
            var i = cos(ph); var q = sin(ph)
            if (noise > 0) { i += noise * r.nextGaussian() / sqrt(2.0); q += noise * r.nextGaussian() / sqrt(2.0) }
            val v = atan2(q * pi - i * pq, i * pi + q * pq); pi = i; pq = q; v.toFloat()
        }
    }
    private fun same(audio: FloatArray, noise: Double = 0.0): List<SameEvent> {
        val out = ArrayList<SameEvent>()
        val d = SameDecoder { out.add(it) }
        d.reset(sameRate)
        val disc = discriminate(audio, noise)
        var at = 0
        while (at < disc.size) { val n = minOf(4096, disc.size - at); d.onFm(disc.copyOfRange(at, at + n), n, sameRate); at += n }
        return out
    }
    private val hdr = "ZCZC-WXR-TOR-020103-020209+0030-1051700-KCLE/NWS-"
    private fun transmission(): FloatArray {
        val parts = ArrayList<FloatArray>()
        parts.add(silence(0.5))
        repeat(3) { parts.add(afsk(burstBits(hdr))); parts.add(silence(1.0)) }
        parts.add(tone(1050.0, 8.0)); parts.add(silence(1.0))
        repeat(3) { parts.add(afsk(burstBits("NNNN"))); parts.add(silence(1.0)) }
        parts.add(silence(3.0))
        val out = FloatArray(parts.sumOf { it.size }); var at = 0
        for (p in parts) { p.copyInto(out, at); at += p.size }
        return out
    }

    @Test fun sameHeaderToneAndEnd() {
        val out = same(transmission())
        val h = out.filter { it.event == "header" }
        assertEquals(1, h.size)
        val m = h[0].header!!
        assertEquals("Tornado Warning", m.eventName)
        assertEquals("National Weather Service", m.originatorName)
        assertEquals(listOf("020103", "020209"), m.locations.map { it.code })
        assertEquals(0, m.hours); assertEquals(30, m.minutes)
        assertEquals(105, m.day); assertEquals(17, m.hour); assertEquals(0, m.minute)
        assertEquals("KCLE/NWS", m.callsign)
        assertEquals(3, h[0].repeats)
        assertEquals(1, out.count { it.event == "tone" && it.raw == "1050 Hz" })
        assertEquals(1, out.count { it.event == "eom" })
    }

    @Test fun sameRejectsImpossibleTimes() {
        assertEquals(null, parseSameHeader("ZCZC-WXR-TOR-020103+0060-1051700-KCLE/NWS-"))
        assertEquals(null, parseSameHeader("ZCZC-WXR-TOR-020103+0030-0001700-KCLE/NWS-"))
        assertEquals("Tornado Warning", parseSameHeader(hdr)?.eventName)
    }

    // ---- HD Radio ----
    private val hdRate = 1_488_375
    private fun hybrid(digital: Boolean, cfoHz: Double = 0.0, seed: Long = 1): ByteArray {
        val nFft = 4096; val cp = 224; val sym = nFft + cp; val symbols = 300
        val u = Random(seed)
        val total = symbols * sym
        val re = FloatArray(total); val im = FloatArray(total)
        var ph = 0.0
        for (k in 0 until total) { val t = k.toDouble() / hdRate; ph += 2 * PI * (75_000 * sin(2 * PI * 1000 * t)) / hdRate; re[k] = cos(ph).toFloat(); im[k] = sin(ph).toFloat() }
        if (digital) {
            val subs = (356..545).flatMap { listOf(it, -it) }
            val a = sqrt(10.0.pow(-2.0) / subs.size).toFloat()
            val x = FloatArray(nFft); val y = FloatArray(nFft)
            for (s in 0 until symbols) {
                x.fill(0f); y.fill(0f)
                for (k in subs) { val i = (k + nFft) % nFft; val q = u.nextInt(4); x[i] = if (q and 1 != 0) -a else a; y[i] = if (q and 2 != 0) -a else a }
                for (i in 0 until nFft) y[i] = -y[i]
                Dsp.fft(x, y)
                for (i in 0 until nFft) y[i] = -y[i]
                val base = s * sym
                for (i in 0 until cp) { re[base + i] += x[nFft - cp + i]; im[base + i] += y[nFft - cp + i] }
                for (i in 0 until nFft) { re[base + cp + i] += x[i]; im[base + cp + i] += y[i] }
            }
        }
        if (cfoHz != 0.0) { var p = 0.0; val w = 2 * PI * cfoHz / hdRate; for (k in 0 until total) { val c = cos(p); val s = sin(p); val r = re[k] * c - im[k] * s; im[k] = (re[k] * s + im[k] * c).toFloat(); re[k] = r.toFloat(); p += w } }
        val iq = ByteArray(2 * total)
        for (k in 0 until total) {
            val r = (60 * (re[k] + 0.02 * u.nextGaussian())).roundToInt().coerceIn(-127, 127)
            val i = (60 * (im[k] + 0.02 * u.nextGaussian())).roundToInt().coerceIn(-127, 127)
            iq[2 * k] = (r + 127).toByte(); iq[2 * k + 1] = (i + 127).toByte()
        }
        return iq
    }
    private fun hd(iq: ByteArray): HdReport {
        val reports = ArrayList<HdReport>()
        val det = HdDetector { reports.add(it) }
        val chunk = 65536
        var at = 0
        while (at + 2 <= iq.size) { val n = minOf(chunk, iq.size - at); det.push(iq.copyOfRange(at, at + n), n shr 1, hdRate, 0.0); at += chunk }
        return reports.last()
    }

    @Test fun hdHybridStationIsDetected() {
        val r = hd(hybrid(true))
        assertTrue("$r", r.present)
        assertTrue("$r", r.lock > 1.5 && r.snrDb > 10)
        assertTrue("$r", abs(r.cfoHz) < 40)
    }

    @Test fun hdAnalogOnlyIsNot() {
        val r = hd(hybrid(false, seed = 2))
        assertFalse("$r", r.present)
        assertTrue("$r", r.lock < 1.3)
    }

    @Test fun hdCarrierErrorIsMeasured() {
        val r = hd(hybrid(true, cfoHz = 120.0, seed = 3))
        assertTrue("$r", r.present && abs(r.cfoHz - 120) < 40)
    }
}
