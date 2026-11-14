package com.rocketgod.mayhem.core.apps.ism

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Flipper (Unleashed) Sub-GHz remotes, group A (twin of web/test/remotes-ulA.mjs and RemotesUlATest.swift): a pulse
 * train built by each protocol's own encoder layout is fed to a fresh decoder, clean and with a few percent of timing
 * jitter, and the hit, the raw key and the parsed fields are checked. Protocols with a check (CRC, sync, repeat match)
 * also get a bad frame.
 */
class RemotesUlATest {
    private data class Hit(val data: Long, val data2: Long, val bits: Int, val info: RemoteInfo?)
    private data class P(val level: Boolean, val dur: Int)

    private val jit = intArrayOf(100, 103, 97, 102, 98)
    private fun jitter(p: List<P>): List<P> = p.mapIndexed { i, x -> P(x.level, x.dur * jit[i % jit.size] / 100) }

    private fun run(proto: FProto, pulses: List<P>): List<Hit> {
        val hits = ArrayList<Hit>()
        proto.callback = { x -> hits.add(Hit(x.decodeData, x.decodeData2, x.dataCountBit, x.remoteInfo())) }
        for (p in pulses) proto.feed(p.level, p.dur)
        return hits
    }

    private fun bitAt(v: Long, i: Int): Int = ((v ushr i) and 1L).toInt()
    private fun reverseBits(v: Long, n: Int): Long { var r = 0L; for (i in 0 until n) r = (r shl 1) or bitAt(v, i).toLong(); return r }

    /** Runs a case clean and jittered; each pass must give exactly one hit. */
    private fun both(name: String, make: () -> FProto, pulses: List<P>, verify: (String, Hit) -> Unit) {
        for ((tag, pp) in listOf("clean" to pulses, "jitter" to jitter(pulses))) {
            val hits = run(make(), pp)
            assertEquals("$name $tag hits", 1, hits.size)
            verify("$name $tag", hits[0])
        }
    }

    private fun noFields(name: String, info: RemoteInfo) {
        assertEquals("$name serial", 0L, info.serial); assertNull("$name btn", info.btn); assertNull("$name cnt", info.cnt)
    }

    @Test fun allstarFirefly() {
        val key = 0x34B9L; val ts = 600; val tl = 4000
        val p = arrayListOf(P(false, ts * 50 + 400))
        for (i in 18 downTo 1) {
            val one = bitAt(key, i - 1) == 1
            p.add(P(true, if (one) tl else ts))
            p.add(P(false, if (i == 1) ts * 50 + 400 else if (one) ts else tl))
        }
        both("allstar", ::SAllstarFirefly, p) { n, h ->
            assertEquals("$n key", key, h.data); assertEquals("$n bits", 18, h.bits)
            val info = h.info!!
            noFields(n, info)
            assertEquals("$n extra", listOf("Yek: 0x274B0", "+: __*___*__", "o: _____*_*_", "-: **__*____"), info.extra)
            assertEquals("$n name", "Allstar Firefly", info.name)
        }
    }

    private fun alutechCrc(data: Long): Int {
        var crc = 0xFF
        for (y in 0 until 8) {
            crc = crc xor ((data ushr (y * 8)) and 0xFFL).toInt()
            for (i in 0 until 8) crc = if (crc and 0x80 != 0) ((crc shl 1) xor 0x31) and 0xFF else (crc shl 1) and 0xFF
        }
        return crc
    }

    private fun alutechPulses(hop: Long, crc: Int): List<P> {
        val ts = 400; val tl = 800
        val out = ArrayList<P>()
        repeat(12) { out.add(P(true, ts)); out.add(P(false, ts)) }
        out[out.size - 1] = P(false, ts + ts * 9)
        fun bit(b: Int) { out.add(P(true, if (b == 1) ts else tl)); out.add(P(false, if (b == 1) tl else ts)) }
        for (i in 64 downTo 1) bit(bitAt(hop, i - 1))
        for (i in 8 downTo 1) bit(bitAt(crc.toLong(), i - 1))
        val last = out[out.size - 1]
        out[out.size - 1] = P(false, last.dur + tl * 20)
        return out
    }

    @Test fun alutechAt4n() {
        val hop = 0x5A3C96E1F00D2B47L
        val crc = reverseBits(alutechCrc(reverseBits(hop, 64)).toLong(), 8).toInt()
        assertEquals("alutech crc value", 0x2F, crc)
        val p = alutechPulses(hop, crc)
        both("alutech", ::SAlutechAt4n, p) { n, h ->
            assertEquals("$n key", hop, h.data); assertEquals("$n crc", crc.toLong(), h.data2); assertEquals("$n bits", 72, h.bits)
            val info = h.info!!
            noFields(n, info)
            assertEquals("$n extra", listOf("CRC: 2F", "Hop: encrypted"), info.extra)
        }
        assertEquals("alutech repeat once", 1, run(SAlutechAt4n(), p + p).size)
        assertEquals("alutech bad crc", 0, run(SAlutechAt4n(), alutechPulses(hop xor (1L shl 20), crc)).size)
    }

    @Test fun ansonic() {
        val key = 0xAAAL; val ts = 555; val tl = 1111
        val p = arrayListOf(P(false, ts * 35), P(true, ts))
        for (i in 12 downTo 1) {
            if (bitAt(key, i - 1) == 1) { p.add(P(false, ts)); p.add(P(true, tl)) } else { p.add(P(false, tl)); p.add(P(true, ts)) }
        }
        p.add(P(false, ts * 35))
        both("ansonic", ::SAnsonic, p) { n, h ->
            assertEquals("$n key", key, h.data); assertEquals("$n bits", 12, h.bits)
            val info = h.info!!
            assertEquals("$n btn", 1, info.btn); assertEquals(0L, info.serial); assertNull(info.cnt)
            assertEquals("$n extra", listOf("DIP: 1010101001"), info.extra)
        }
    }

    private fun belkornFrame(serialHi: Int, serial: Long, l24: Int, b3: Int, b4: Int, b5: Int, b6: Int, c: Int, btn: Int): Pair<Long, Long> {
        val data = (0x801L shl 52) or ((serialHi and 0xF).toLong() shl 48) or (serial shl 16) or ((l24 and 0xFF).toLong() shl 8) or ((l24 shr 8) and 0xFF).toLong()
        val data2 = (((l24 shr 16) and 0xFF).toLong() shl 46) or (b3.toLong() shl 38) or (b4.toLong() shl 30) or (b5.toLong() shl 22) or
            (b6.toLong() shl 14) or (c.toLong() shl 6) or (btn and 0x3F).toLong()
        return data to data2
    }

    private fun belkornPulses(data: Long, data2: Long): List<P> {
        val ts = 481; val tl = 962; val gap = ts * 16
        val out = arrayListOf(P(false, gap))
        for (i in 0 until 118) {
            val set = if (i < 64) bitAt(data, 63 - i) else bitAt(data2, 117 - i)
            out.add(P((i and 1) == 0, if (set == 1) tl else ts))
        }
        out.add(P(true, ts)); out.add(P(false, gap))
        return out
    }

    @Test fun belkorn() {
        val (d, d2) = belkornFrame(0x5, 0x12345678L, 0xABCDEF, 0x11, 0x22, 0x03, 0x44, 0x81, 0x04)
        both("belkorn", ::SBelkorn, belkornPulses(d, d2)) { n, h ->
            assertEquals("$n key", d, h.data); assertEquals("$n key2", d2, h.data2); assertEquals("$n bits", 118, h.bits)
            val info = h.info!!
            assertEquals("$n serial", 0x512345678L, info.serial); assertEquals("$n btn", 4, info.btn); assertEquals("$n cnt", 0x0381, info.cnt)
            assertEquals("$n extra", listOf("Key2: " + java.lang.Long.toHexString(d2).uppercase()), info.extra)
        }
        val (e, e2) = belkornFrame(0x0, 0xCAFEBABEL, 0x0000E0, 0x10, 0x42, 0x01, 0x01, 0x42, 0x20)
        val ha = run(SBelkorn(), belkornPulses(e, e2))
        assertEquals("belkorn format A hits", 1, ha.size)
        assertEquals(0xCAFEBABEL, ha[0].info!!.serial); assertEquals(0x20, ha[0].info!!.btn); assertEquals(0x0142, ha[0].info!!.cnt)
        assertEquals("belkorn bad sync", 0, run(SBelkorn(), belkornPulses(d xor (1L shl 60), d2)).size)
        assertEquals("belkorn bad btn", 0, run(SBelkorn(), belkornPulses(d, d2 xor 0x2L)).size)
    }

    @Test fun benincaArc() {
        val d = 0xDEADBEEF01234567UL.toLong(); val d2 = 0x89ABCDEF55AA1234UL.toLong(); val ts = 300; val tl = 600
        val p = arrayListOf(P(false, tl * 15))
        fun bit(b: Int) { p.add(P(true, if (b == 1) ts else tl)); p.add(P(false, if (b == 1) tl else ts)) }
        for (i in 64 downTo 1) bit(bitAt(d, i - 1))
        for (i in 64 downTo 1) bit(bitAt(d2, i - 1))
        p.add(P(true, ts)); p.add(P(false, tl * 15))
        both("beninca", ::SBenincaArc, p) { n, h ->
            assertEquals("$n key", d, h.data); assertEquals("$n key2", d2, h.data2); assertEquals("$n bits", 128, h.bits)
            val info = h.info!!
            noFields(n, info)
            assertEquals("$n extra", listOf("Key2: 89ABCDEF55AA1234", "Hop: AES-128 encrypted"), info.extra)
        }
    }

    @Test fun dickertMahs() {
        val code = "+0-+0-+0-+" + "0+-0+-0+"
        var key = 0L
        for (ch in code) key = (key shl 2) or (if (ch == '+') 3L else if (ch == '0') 1L else 0L)
        val ts = 400; val tl = 800
        val p = arrayListOf(P(false, ts * 112), P(true, ts))
        for (i in 36 downTo 1) {
            if (bitAt(key, i - 1) == 1) { p.add(P(false, tl)); p.add(P(true, ts)) } else { p.add(P(false, ts)); p.add(P(true, tl)) }
        }
        // Next frame's header and start bit end this one; the hit comes on the event after
        p.add(P(false, ts * 112)); p.add(P(true, ts)); p.add(P(false, ts))
        both("dickert", ::SDickertMahs, p) { n, h ->
            assertEquals("$n key", key, h.data); assertEquals("$n bits", 36, h.bits)
            val info = h.info!!
            noFields(n, info)
            assertEquals("$n extra", listOf("User DIPs: +0-+0-+0-+", "Factory code: 0+-0+-0+"), info.extra)
        }
    }

    private fun rev8(b: Int): Int { var r = 0; for (i in 0 until 8) r = (r shl 1) or ((b shr i) and 1); return r and 0xFF }
    private fun lcg(seed: Int, steps: Int): Int { var x = seed and 0xFF; for (i in 0 until (steps and 0xFF)) x = (21 * x + 1) and 0xFF; return x }
    private fun par8(b: Int): Int { var p = 0; for (i in 0 until 8) p = p xor ((b shr i) and 1); return p }

    /** subghz_protocol_ditec_gol4_encode_key without the counter step: serial / btn / cnt -> 54-bit key. */
    private fun gol4Encode(serial: Long, btn: Int, cnt: Int): Long {
        val raw = intArrayOf(((serial shr 24) and 0xFF).toInt(), ((serial shr 8) and 0xFF).toInt(), btn and 0x0F, (serial and 0xFF).toInt(),
            ((serial shr 16) and 0xFF).toInt(), cnt and 0xFF, (cnt shr 8) and 0xFF)
        val dec5 = raw[5] xor 0xA7; val dec6 = raw[6] xor 0x69
        val enc6 = lcg(dec6, dec5)
        var enc5 = lcg(dec5, 0xFE)
        if (enc6 and 0x80 != 0) enc5 = enc5 xor 1
        raw[5] = enc5; raw[6] = enc6
        raw[0] = rev8(raw[0]); raw[1] = rev8(raw[1]); raw[3] = rev8(raw[3]); raw[4] = rev8(raw[4])
        if (raw[2] == 0) raw[2] = 0xF0
        var b2 = rev8(raw[2]); b2 = b2.inv() and 0xFF; b2 = ((b2 shl 4) or (b2 shr 4)) and 0xFF; b2 = b2 and 0xDF; raw[2] = b2
        raw[5] = rev8(raw[5]); raw[6] = rev8(raw[6])
        val p5 = par8(raw[5]); val p6 = par8(raw[6])
        var carry = 0
        for (r in 0 until 3) for (i in 6 downTo 2) { val nc = (raw[i] shr 7) and 1; raw[i] = ((raw[i] shl 1) or carry) and 0xFF; carry = nc }
        raw[6] = if (p5 == p6) raw[6] and 0xFB else raw[6] or 0x04
        var key = 0L
        for (i in 0 until 54) key = (key shl 1) or ((raw[i shr 3] shr (7 - (i and 7))) and 1).toLong()
        return key
    }

    private fun gol4Pulses(key: Long): List<P> {
        val ts = 400; val tl = 1100
        val out = arrayListOf(P(false, tl * 22), P(true, ts * 2))
        for (i in 54 downTo 1) {
            if (bitAt(key, i - 1) == 1) { out.add(P(false, ts)); out.add(P(true, tl)) } else { out.add(P(false, tl)); out.add(P(true, ts)) }
        }
        out.add(P(false, tl * 22)); out.add(P(true, ts * 2)); out.add(P(false, ts))
        return out
    }

    @Test fun ditecGol4() {
        // Real captures from the Flipper source comments, with their buttons
        val samples = listOf(0xCCB2F83208122L to 1, 0xCCB1F832103B9L to 0, 0xCCB2F8320ED66L to 1, 0xCCB37832104A6L to 2, 0xCCB3B8320DB4EL to 4, 0xCCB3D8320E855L to 8)
        for ((k, b) in samples) {
            val r = SDitecGol4.decodeKey(k)
            assertEquals("ditec sample btn", b, r.btn); assertEquals("ditec sample serial", 0xCC093483L, r.serial)
        }
        val key = gol4Encode(0xCC093483L, 2, 0x1234)
        both("ditec", ::SDitecGol4, gol4Pulses(key)) { n, h ->
            assertEquals("$n key", key, h.data); assertEquals("$n bits", 54, h.bits)
            val info = h.info!!
            assertEquals("$n serial", 0xCC093483L, info.serial); assertEquals("$n btn", 2, info.btn); assertEquals("$n cnt", 0x1234, info.cnt)
            assertEquals("$n extra", emptyList<String>(), info.extra)
        }
        val prog = run(SDitecGol4(), gol4Pulses(gol4Encode(0xCC093483L, 0, 0xFFFE)))
        assertEquals("ditec prog hits", 1, prog.size)
        assertEquals(0, prog[0].info!!.btn); assertEquals(0xFFFE, prog[0].info!!.cnt); assertEquals(listOf("Prog mode"), prog[0].info!!.extra)
    }

    private fun doorbellFrame(key: Long, te: Int): List<P> {
        val out = ArrayList<P>()
        for (i in 32 downTo 1) {
            if (bitAt(key, i - 1) == 1) { out.add(P(true, te * 3)); out.add(P(false, te)) } else { out.add(P(true, te)); out.add(P(false, te * 3)) }
        }
        out.add(P(true, te)); out.add(P(false, te * 14))
        return out
    }

    @Test fun doorbell32() {
        val key = 0x8A5C3E91L; val te = 515
        val p = listOf(P(false, te * 14)) + doorbellFrame(key, te) + doorbellFrame(key, te)
        for ((tag, pp) in listOf("clean" to p, "jitter" to jitter(p))) {
            val hits = run(SDoorbell32(), pp)
            assertEquals("doorbell $tag hits", 1, hits.size)
            val h = hits[0]
            assertEquals("doorbell $tag key", key, h.data); assertEquals(32, h.bits)
            val info = h.info!!
            noFields("doorbell $tag", info)
            if (tag == "clean") assertEquals(listOf("Te: 515 us"), info.extra)
            else assertTrue(info.extra[0], Regex("^Te: 5[01]\\d us$").matches(info.extra[0]))
        }
        val h2 = run(SDoorbell32(), listOf(P(false, 480 * 14)) + doorbellFrame(key, 480) + doorbellFrame(key, 480))
        assertEquals(1, h2.size); assertEquals(listOf("Te: 480 us"), h2[0].info!!.extra)
        assertEquals("doorbell single", 0, run(SDoorbell32(), listOf(P(false, te * 14)) + doorbellFrame(key, te)).size)
        assertEquals("doorbell mismatch", 0, run(SDoorbell32(), listOf(P(false, te * 14)) + doorbellFrame(key, te) + doorbellFrame(key xor 0x100L, te)).size)
    }
}
