package com.rocketgod.mayhem.core.pager

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.random.Random

/**
 * Pager decoders against signals built here from the protocol rules: POCSAG batches and FLEX frames are encoded,
 * FSK-modulated into discriminator samples (with noise, a carrier offset and an odd start phase), and decoded.
 * The FLEX path was also checked against live 929 / 931 MHz traffic during development.
 */
class PagerDecodersTest {

    private class Collect : PagerSink {
        val pages = ArrayList<PagerPage>(); var syncs = 0
        override fun onPage(p: PagerPage) { pages += p }
        override fun onSync(protocol: String, rate: String) { syncs++ }
    }

    // ---------------------------------------------------------------- BCH

    @Test fun bchFixesUpToTwoErrors() {
        val r = Random(1)
        repeat(500) {
            val d = r.nextInt(1 shl 21)
            val w = PagerBch.encode(d)
            assertEquals(w, PagerBch.correct(w))
            val a = r.nextInt(32); var b = r.nextInt(32); while (b == a) b = r.nextInt(32)
            assertEquals(w, PagerBch.correct(w xor (1 shl a)))
            assertEquals(w, PagerBch.correct(w xor (1 shl a) xor (1 shl b)))
        }
        assertEquals(PocsagDecoder.SYNC, PagerBch.correct(PocsagDecoder.SYNC))
        assertEquals(PocsagDecoder.IDLE, PagerBch.correct(PocsagDecoder.IDLE))
    }

    @Test fun bchRefusesThreeErrorsInTheDataBits() {
        val w = PagerBch.encode(0x12345)
        var refused = 0
        for (a in 1..29) { val bad = w xor (7 shl a); val c = PagerBch.correct(bad); if (c == null || c != w) refused++ }
        assertEquals(29, refused)
        assertNull(PagerBch.correct(w xor (7 shl 3)))
    }

    // ---------------------------------------------------------------- modulation helpers

    /**
     * Discriminator samples (radians per sample) for a run of symbol levels; symbol k lasts 1/[baudOf](k) seconds,
     * so a FLEX frame can change speed mid-way with continuous timing.
     */
    private fun fsk(levels: List<Double>, baudOf: (Int) -> Int, devHzPerUnit: Double, fs: Double, r: Random,
                    noise: Double = 0.08, offsetHz: Double = 420.0, lead: Int = 900): FloatArray {
        var span = 0.0
        for (k in levels.indices) span += fs / baudOf(k)
        val n = span.roundToInt() + lead * 2
        val raw = DoubleArray(n)
        var t = lead + r.nextDouble() * fs / baudOf(0)   // odd start phase
        for (k in levels.indices) {
            val end = t + fs / baudOf(k)
            for (i in t.toInt() until minOf(n, end.toInt())) raw[i] = levels[k] * devHzPerUnit
            t = end
        }
        // a short moving average stands in for the transmitter's shaping and the receiver's channel filter
        val m = maxOf(1, (fs / baudOf(levels.size - 1) / 5).toInt())
        val out = FloatArray(n)
        var acc = 0.0
        for (i in 0 until n) {
            acc += raw[i]; if (i >= m) acc -= raw[i - m]
            out[i] = (2 * PI * (acc / m + offsetHz) / fs + r.nextGaussian() * noise).toFloat()
        }
        return out
    }

    private fun Random.nextGaussian(): Double {
        var u = 0.0; while (u == 0.0) u = nextDouble()
        return kotlin.math.sqrt(-2.0 * kotlin.math.ln(u)) * cos(2 * PI * nextDouble())
    }

    // ---------------------------------------------------------------- POCSAG

    private fun pocsagBits(pages: List<Triple<Long, Int, String>>, alphaFor: Set<Long>): List<Int> {
        // codeword stream, batch by batch, each page starting in its own frame slot
        val cws = ArrayList<Int>()
        fun slot() = cws.size % 16
        for ((ric, func, text) in pages) {
            while (slot() / 2 != (ric and 7).toInt()) cws += PocsagDecoder.IDLE
            cws += PagerBch.encode((((ric ushr 3).toInt() and 0x3FFFF) shl 2) or func)
            val bits = ArrayList<Int>()
            if (ric in alphaFor) {
                for (ch in text) for (k in 0 until 7) bits += (ch.code ushr k) and 1
                repeat(7) { bits += if (it == 2) 1 else 0 }   // EOT (0x04)
            } else {
                for (ch in text) { val d = "0123456789*U -)(".indexOf(ch); for (k in 0 until 4) bits += (d ushr k) and 1 }
            }
            while (bits.size % 20 != 0) bits += if (ric in alphaFor) 0 else (0xC ushr ((bits.size % 4))) and 1
            for (c in bits.indices step 20) {
                var v = 0; for (k in 0 until 20) v = (v shl 1) or bits[c + k]
                cws += PagerBch.encode((1 shl 20) or v)
            }
        }
        while (cws.size % 16 != 0) cws += PocsagDecoder.IDLE
        val out = ArrayList<Int>()
        repeat(576) { out += (it + 1) and 1 }                      // preamble 1010...
        for (b in 0 until cws.size / 16) {
            for (k in 31 downTo 0) out += (PocsagDecoder.SYNC ushr k) and 1
            for (c in 0 until 16) { val w = cws[b * 16 + c]; for (k in 31 downTo 0) out += (w ushr k) and 1 }
        }
        repeat(64) { out += (it and 1) }
        return out
    }

    private fun pocsagRun(baud: Int, invert: Boolean, seed: Int) {
        val pages = listOf(Triple(1234567L, 3, "ENGINE 12 RESPOND STRUCTURE FIRE 450 MAIN ST"), Triple(765432L, 0, "5551234"))
        val bits = pocsagBits(pages, setOf(1234567L))
        val levels = bits.map { if ((it == 1) != invert) 1.0 else -1.0 }
        val sig = fsk(levels, { baud }, 4500.0, 48_000.0, Random(seed))
        val c = Collect()
        PocsagDecoder(c, 48_000.0).push(sig, sig.size)
        val alpha = c.pages.firstOrNull { it.capcode == 1234567L }
        val num = c.pages.firstOrNull { it.capcode == 765432L }
        assertTrue("POCSAG $baud alpha missing: ${c.pages}", alpha != null)
        assertEquals("ENGINE 12 RESPOND STRUCTURE FIRE 450 MAIN ST", alpha!!.text)
        assertEquals(PageKind.ALPHA, alpha.kind)
        assertEquals(baud.toString(), alpha.rate)
        assertTrue("POCSAG $baud numeric missing: ${c.pages}", num != null)
        assertEquals("5551234", num!!.text)
        assertEquals(PageKind.NUMERIC, num.kind)
    }

    @Test fun pocsag512() = pocsagRun(512, false, 2)
    @Test fun pocsag1200() = pocsagRun(1200, false, 3)
    @Test fun pocsag2400() = pocsagRun(2400, false, 4)
    @Test fun pocsag1200Inverted() = pocsagRun(1200, true, 5)

    // ---------------------------------------------------------------- FLEX

    private fun withChecksum(d: Int): Int {
        val body = d and 0x1FFFF0
        val s = ((body ushr 4) and 0xF) + ((body ushr 8) and 0xF) + ((body ushr 12) and 0xF) + ((body ushr 16) and 0xF) + ((body ushr 20) and 1)
        return body or ((0xF - (s and 0xF)) and 0xF)
    }

    /** Phase words (data fields) for an alphanumeric and a numeric page. */
    private fun flexPhase(alphaCap: Long, text: String, numCap: Long, digits: String): IntArray {
        val w = IntArray(88)
        val aOff = 1; val vOff = 3
        w[0] = withChecksum((vOff shl 10) or ((aOff - 1) shl 8))
        w[1] = (alphaCap + 0x8000).toInt()
        w[2] = (numCap + 0x8000).toInt()
        // alphanumeric: header word, then the text (first content word carries two characters, the rest three)
        val msg = 5
        val chars = text.map { it.code }.toMutableList()
        val content = ArrayList<Int>()
        var k = 0
        var first = true
        while (k < chars.size) {
            val c = IntArray(3) { 3 }
            val start = if (first) 1 else 0
            for (s in start until 3) if (k < chars.size) c[s] = chars[k++]
            if (first) c[0] = 0
            content += c[0] or (c[1] shl 7) or (c[2] shl 14)
            first = false
        }
        w[msg] = 3 shl 11                     // single fragment, no more to follow
        for (i in content.indices) w[msg + 1 + i] = content[i]
        val len = 1 + content.size
        w[vOff] = withChecksum((5 shl 4) or (msg shl 7) or (len shl 14))
        // numeric: two filler bits, then BCD digits low bit first, padded with spaces
        val nStart = msg + len
        val bits = arrayListOf(0, 0)
        for (ch in digits) { val d = "0123456789.U -][".indexOf(ch); for (b in 0 until 4) bits += (d ushr b) and 1 }
        while (bits.size % 21 != 0) bits += (0xC ushr ((bits.size - 2) % 4)) and 1
        val nWords = bits.size / 21
        for (i in 0 until nWords) { var v = 0; for (b in 0 until 21) v = v or (bits[i * 21 + b] shl b); w[nStart + i] = v }
        w[vOff + 1] = withChecksum((3 shl 4) or (nStart shl 7) or ((nWords - 1) shl 14))
        return w
    }

    private fun flexFrame(code: Int, baud: Int, levels4: Boolean, phaseA: IntArray, flip: Map<Int, Int> = emptyMap()): List<Double> {
        val out = ArrayList<Double>()
        repeat(96) { out += if (it % 2 == 0) 3.0 else -3.0 }                      // bit sync
        val sync = (code.toLong() shl 48) or (0xA6C6AAAAL shl 16) or (code.inv().toLong() and 0xFFFF)
        for (k in 63 downTo 0) out += if (((sync ushr k) and 1L) == 1L) -3.0 else 3.0   // sync bit 1 = low tone
        repeat(16) { out += if (it % 2 == 0) 3.0 else -3.0 }
        val fiwData = withChecksum((3 shl 4) or (5 shl 8))
        val fiw = PagerBch.flexWord(fiwData)
        for (k in 31 downTo 0) out += if (((fiw ushr k) and 1) == 1) 3.0 else -3.0
        // sync 2 at the frame's speed: filler, then C and C inverted
        val s2 = baud * 25 / 1000
        val tail = (0xED84 shl 16) or 0x127B
        for (i in 0 until s2) {
            val bit = if (i >= s2 - 32) (tail ushr (s2 - 1 - i)) and 1 else i and 1
            out += if (bit == 1) 3.0 else -3.0
        }
        val air = Array(4) { p -> IntArray(88) { i -> if (p == 0) PagerBch.flexWord(phaseA[i]) xor (flip[i] ?: 0) else 0 } }
        fun bit(p: Int, c: Int): Int { val idx = (c ushr 8) * 8 + (c and 7); val pos = (c ushr 3) and 31; return (air[p][idx] ushr (31 - pos)) and 1 }
        fun level(a: Int, b: Int) = if (!levels4) (if (a == 1) 3.0 else -3.0) else when { a == 1 && b == 0 -> 3.0; a == 1 -> 1.0; b == 1 -> -1.0; else -> -3.0 }
        for (c in 0 until 11 * 256) {
            if (baud == 1600) out += level(bit(0, c), bit(1, c))
            else { out += level(bit(0, c), bit(1, c)); out += level(bit(2, c), bit(3, c)) }
        }
        return out
    }

    private fun flexRun(code: Int, baud: Int, levels4: Boolean, rateLabel: String, seed: Int) {
        val phase = flexPhase(1234567L, "CODE 3 MVA I-75 NB MM 12", 765432L, "5551234")
        val frame = flexFrame(code, baud, levels4, phase)
        // the sync and FIW run at 1600 baud, the rest at the frame's speed
        val head = 96 + 64 + 16 + 32
        val sig = fsk(frame, { if (it < head) 1600 else baud }, 1600.0, 48_000.0, Random(seed))
        val c = Collect()
        FlexDecoder(c, 48_000.0).push(sig, sig.size)
        val alpha = c.pages.firstOrNull { it.capcode == 1234567L }
        val num = c.pages.firstOrNull { it.capcode == 765432L }
        assertTrue("FLEX $rateLabel alpha missing (syncs ${c.syncs}): ${c.pages}", alpha != null)
        assertEquals("CODE 3 MVA I-75 NB MM 12", alpha!!.text)
        assertEquals(rateLabel, alpha.rate)
        assertTrue("where: ${alpha.where}", alpha.where.startsWith("C03 F005 A"))
        assertTrue("FLEX $rateLabel numeric missing: ${c.pages}", num != null)
        assertEquals("5551234", num!!.text)
    }

    @Test fun flex1600() = flexRun(0x870C, 1600, false, "1600", 11)
    @Test fun flex3200FourLevel() = flexRun(0xB068, 1600, true, "3200", 12)
    @Test fun flex3200TwoLevel() = flexRun(0x7B18, 3200, false, "3200", 13)
    @Test fun flex6400() = flexRun(0xDEA0, 3200, true, "6400", 14)

    /** Words lost partway through a page: the text stops where the damage starts instead of running on as noise. */
    @Test fun flexCutsAPageWhereTheNoiseStarts() {
        val phase = flexPhase(1234567L, "STATION 7 RESPOND TO ROOM 38 NOW PLEASE", 765432L, "5551234")
        // content words start at 6 (the header is 5); the first holds two characters, the rest three each
        val flip = mapOf(6 + 6 to 0x0F000000, 6 + 7 to 0x00F00000, 6 + 8 to 0x000F0000)
        val frame = flexFrame(0x870C, 1600, false, phase, flip)
        val sig = fsk(frame, { 1600 }, 1600.0, 48_000.0, Random(21))
        val c = Collect()
        FlexDecoder(c, 48_000.0).push(sig, sig.size)
        val alpha = c.pages.firstOrNull { it.capcode == 1234567L }
        assertTrue("alpha missing: ${c.pages}", alpha != null)
        assertEquals("STATION 7 RESPOND …", alpha!!.text)
        assertTrue("errors: ${alpha.errors}", alpha.errors >= 2)
        assertEquals("5551234", c.pages.first { it.capcode == 765432L }.text)
    }

    /** One failed word inside good text stays a gap; the rest of the page is kept. */
    @Test fun flexKeepsAPageWithOneLostWord() {
        val phase = flexPhase(1234567L, "STATION 7 RESPOND TO ROOM 38 NOW PLEASE", 765432L, "5551234")
        // three bit errors: past what the code corrects, and never close enough to another word to miscorrect
        val frame = flexFrame(0x870C, 1600, false, phase, mapOf(6 + 3 to 0x0E000000))
        val sig = fsk(frame, { 1600 }, 1600.0, 48_000.0, Random(22))
        val c = Collect()
        FlexDecoder(c, 48_000.0).push(sig, sig.size)
        val alpha = c.pages.firstOrNull { it.capcode == 1234567L }
        assertTrue("alpha missing: ${c.pages}", alpha != null)
        assertEquals("STATION ???ESPOND TO ROOM 38 NOW PLEASE", alpha!!.text)   // the word held "7 R"
        assertEquals(1, alpha.errors)
    }

    // ---------------------------------------------------------------- the whole channel path

    @Test fun channelizerFindsAPageOffCenter() {
        val fs = 2_400_000; val center = 929_800_000L; val chan = 930_112_500L
        val bits = pocsagBits(listOf(Triple(1234567L, 3, "TEST PAGE OFF CENTER")), setOf(1234567L))
        val baud = 1200
        val sps = fs.toDouble() / baud
        val n = (bits.size * sps).toInt() + 20_000
        val iq = FloatArray(n); val qq = FloatArray(n)
        val r = Random(21)
        var ph = 0.0
        val off = (chan - center).toDouble()
        // a neighbor 25 kHz up, carrying noise-like FSK at the same level, must not get in the way
        var ph2 = 0.0
        for (i in 0 until n) {
            val k = ((i - 10_000) / sps).toInt()
            val dev = if (k in bits.indices) (if (bits[k] == 1) 4500.0 else -4500.0) else 0.0
            ph += 2 * PI * (off + dev) / fs
            ph2 += 2 * PI * (off + 25_000 + (if ((i / 900) % 2 == 0) 4000.0 else -4000.0)) / fs
            iq[i] = (30 * cos(ph) + 30 * cos(ph2) + r.nextGaussian() * 6).toFloat()
            qq[i] = (30 * sin(ph) + 30 * sin(ph2) + r.nextGaussian() * 6).toFloat()
        }
        val c = Collect()
        val rx = PagerChannelRx(chan, c)
        rx.configure(center, fs)
        var p = 0
        while (p < n) { val m = minOf(131_072, n - p); rx.process(iq.copyOfRange(p, p + m), qq.copyOfRange(p, p + m), m); p += m }
        assertEquals("pages: ${c.pages}", "TEST PAGE OFF CENTER", c.pages.firstOrNull { it.capcode == 1234567L }?.text)
    }
}
