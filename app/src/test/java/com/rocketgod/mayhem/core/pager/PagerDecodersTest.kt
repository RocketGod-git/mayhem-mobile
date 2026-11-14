package com.rocketgod.mayhem.core.pager

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
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

    /** The SINGLE channel mode's decoder on the receiver's FM output, at a carrier offset a cheap radio really has. */
    private fun singleRun(baud: Int, invert: Boolean, offsetHz: Double, seed: Int): List<String> {
        val bits = pocsagBits(listOf(Triple(1234567L, 3, "CODE BLUE RM 412 EAST")), setOf(1234567L))
        val levels = bits.map { if ((it == 1) != invert) -1.0 else 1.0 }
        val sig = fsk(levels, { baud }, 4500.0, 48_000.0, Random(seed), offsetHz = offsetHz)
        val log = com.rocketgod.mayhem.core.PacketLog()
        val d = com.rocketgod.mayhem.core.apps.PagerDecoder(log)
        d.reset(48_000); d.onFm(sig, sig.size, 48_000)
        return log.lines.value
    }

    @Test fun singleChannelDecodesPocsagByDefault() {
        for (baud in intArrayOf(512, 1200, 2400)) for (inv in listOf(false, true)) for (off in doubleArrayOf(0.0, 1500.0, -2500.0)) {
            val lines = singleRun(baud, inv, off, baud + off.toInt())
            assertTrue("SINGLE POCSAG $baud inv=$inv offset $off: $lines", lines.any { "CODE BLUE RM 412 EAST" in it })
        }
    }

    // ---------------------------------------------------------------- FLEX

    private fun withChecksum(d: Int): Int {
        val body = d and 0x1FFFF0
        val s = ((body ushr 4) and 0xF) + ((body ushr 8) and 0xF) + ((body ushr 12) and 0xF) + ((body ushr 16) and 0xF) + ((body ushr 20) and 1)
        return body or ((0xF - (s and 0xF)) and 0xF)
    }

    private fun groups(d: Int) = (d and 0xFF) + ((d ushr 8) and 0xFF) + ((d ushr 16) and 0x1F)

    /**
     * An alphanumeric message as a transmitter builds it (ARIB STD-43A 3.10.1.3): the header (K, C, F, N), then the
     * characters three to a word, the first word of a first fragment opening with the signature S. K is the ones'
     * complement of the header's and every message word's 8 + 8 + 5 bit groups.
     */
    private fun alphaWords(text: String, n: Int, frag: Int = 3, more: Int = 0): IntArray {
        val chars = text.map { it.code }
        val content = ArrayList<Int>()
        var k = 0
        var first = frag == 3
        val sig = chars.sum().inv() and 0x7F
        while (k < chars.size) {
            val c = IntArray(3) { 3 }
            val start = if (first) 1 else 0
            for (s in start until 3) if (k < chars.size) c[s] = chars[k++]
            if (first) c[0] = sig
            content += c[0] or (c[1] shl 7) or (c[2] shl 14)
            first = false
        }
        var h = (more shl 10) or (frag shl 11) or (n shl 13)
        var s = groups(h)
        for (d in content) s += groups(d)
        h = h or (s.inv() and 0x3FF)
        return intArrayOf(h) + content.toIntArray()
    }

    /** A numeric message (3.10.1.1): two checksum bits, BCD digits low bit first, space fill; K3-K0 goes in the vector. */
    private fun numericWords(digits: String): Pair<IntArray, Int> {
        val bits = arrayListOf(0, 0)
        for (ch in digits) { val d = "0123456789.U -][".indexOf(ch); for (b in 0 until 4) bits += (d ushr b) and 1 }
        while (bits.size % 21 != 0) bits += (0xC ushr ((bits.size - 2) % 4)) and 1
        val words = IntArray(bits.size / 21) { i -> var v = 0; for (b in 0 until 21) v = v or (bits[i * 21 + b] shl b); v }
        var sum = 0
        for (d in words) sum += groups(d)
        val s = sum and 0xFF
        val k6 = ((s and 0x3F) + (s ushr 6)).inv() and 0x3F
        words[0] = words[0] or ((k6 ushr 4) and 3)
        return words to (k6 and 0xF)
    }

    /** Phase words for an alphanumeric page and a numeric page on short addresses. Text starts at word 6. */
    private fun flexPhase(alphaCap: Long, text: String, numCap: Long, digits: String, n: Int = 5, frag: Int = 3, more: Int = 0): IntArray {
        val w = IntArray(88)
        val aOff = 1; val vOff = 3
        w[0] = withChecksum((vOff shl 10) or ((aOff - 1) shl 8))
        w[1] = (alphaCap + 0x8000).toInt()
        w[2] = (numCap + 0x8000).toInt()
        val msg = 5
        val a = alphaWords(text, n, frag, more)
        for (i in a.indices) w[msg + i] = a[i]
        w[vOff] = withChecksum((5 shl 4) or (msg shl 7) or (a.size shl 14))
        val nStart = msg + a.size
        val (num, k30) = numericWords(digits)
        for (i in num.indices) w[nStart + i] = num[i]
        w[vOff + 1] = withChecksum((3 shl 4) or (nStart shl 7) or ((num.size - 1) shl 14) or (k30 shl 17))
        return w
    }

    /** A long (two-word) address page: its header rides in the second vector word, the text from word 9. */
    private fun flexPhaseLong(cap: Long, text: String): IntArray {
        val w = IntArray(88)
        val aOff = 1; val vOff = 3
        w[0] = withChecksum((vOff shl 10) or ((aOff - 1) shl 8))
        // set 1-2: capcode = aw1 + (2097151 - aw2) * 32768 + 2068480
        val q = (cap - 2068480) / 32768
        w[1] = (cap - 2068480 - q * 32768).toInt()
        w[2] = (2097151 - q).toInt()
        // the message field starts further on, after other traffic, so the word before it is not the header
        val msg = 9
        for (k in 5 until msg) w[k] = 0x0A5A5 + k
        val a = alphaWords(text, 9)
        w[vOff + 1] = a[0]
        for (i in 1 until a.size) w[msg + i - 1] = a[i]
        w[vOff] = withChecksum((5 shl 4) or (msg shl 7) or (a.size shl 14))
        return w
    }

    private fun flexFrame(code: Int, baud: Int, levels4: Boolean, phaseA: IntArray, flip: Map<Int, Int> = emptyMap(), fade: Map<Int, Int> = emptyMap()): List<Double> {
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
        // a faded bit (two-level only): sent the wrong way, but weakly, close to the decision line
        fun faded(c: Int): Boolean { val idx = (c ushr 8) * 8 + (c and 7); val pos = (c ushr 3) and 31; return ((fade[idx] ?: 0) ushr (31 - pos)) and 1 == 1 }
        for (c in 0 until 11 * 256) {
            if (!levels4 && baud == 1600 && faded(c)) { out += if (bit(0, c) == 1) -0.6 else 0.6; continue }
            if (baud == 1600) out += level(bit(0, c), bit(1, c))
            else { out += level(bit(0, c), bit(1, c)); out += level(bit(2, c), bit(3, c)) }
        }
        return out
    }

    /** Frames at 1600 baud, two-level, one after another through one decoder. */
    private fun decode1600(seed: Int, vararg frames: List<Double>): Pair<Collect, FlexDecoder> {
        val sym = frames.flatMap { it }
        val sig = fsk(sym, { 1600 }, 1600.0, 48_000.0, Random(seed))
        val c = Collect()
        val dec = FlexDecoder(c, 48_000.0)
        dec.push(sig, sig.size)
        return c to dec
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
        assertEquals(0, alpha.errors)
        assertEquals(rateLabel, alpha.rate)
        assertTrue("where: ${alpha.where}", alpha.where.startsWith("C03 F005 A"))
        assertTrue("FLEX $rateLabel numeric missing: ${c.pages}", num != null)
        assertEquals("5551234", num!!.text)
        assertEquals(0, num.errors)
    }

    @Test fun flex1600() = flexRun(0x870C, 1600, false, "1600", 11)
    @Test fun flex3200FourLevel() = flexRun(0xB068, 1600, true, "3200", 12)
    @Test fun flex3200TwoLevel() = flexRun(0x7B18, 3200, false, "3200", 13)
    @Test fun flex6400() = flexRun(0xDEA0, 3200, true, "6400", 14)

    private val TEXT = "STATION 7 RESPOND TO ROOM 38 NOW PLEASE"
    /** [TEXT] with the characters of message words [from]..[to] (counting the first text word as 0) lost. */
    private fun lostWords(from: Int, to: Int): String {
        fun at(word: Int) = if (word == 0) 0 else 2 + (word - 1) * 3
        val a = at(from); val b = minOf(TEXT.length, at(to + 1))
        return TEXT.substring(0, a) + "?".repeat(b - a) + TEXT.substring(b)
    }

    /** A long address's header is in its second vector word: the page and its capcode both come out. */
    @Test fun flexLongAddressPage() {
        val (c, _) = decode1600(15, flexFrame(0x870C, 1600, false, flexPhaseLong(420167049L, "CLASS 2 21 Y/O M MVC ETA 8 MIN")))
        val p = c.pages.firstOrNull { it.capcode == 420167049L }
        assertTrue("long page missing: ${c.pages}", p != null)
        assertEquals("CLASS 2 21 Y/O M MVC ETA 8 MIN", p!!.text)
        assertEquals(0, p.errors)
    }

    /** One failed word inside good text stays a gap; the rest of the page is kept. */
    @Test fun flexKeepsAPageWithOneLostWord() {
        // three bit errors: past what the code corrects, and never close enough to another word to miscorrect
        val (c, _) = decode1600(22, flexFrame(0x870C, 1600, false, flexPhase(1234567L, TEXT, 765432L, "5551234"), mapOf(6 + 3 to 0x0E000000)))
        val alpha = c.pages.first { it.capcode == 1234567L }
        assertEquals("STATION ???ESPOND TO ROOM 38 NOW PLEASE", alpha.text)   // the word held "7 R"
        assertEquals(1, alpha.errors)
    }

    /** Several words lost together (a fade): the gap shows, and the text after it is kept, not thrown away. */
    @Test fun flexKeepsTheTextAfterAFade() {
        val (c, _) = decode1600(21, flexFrame(0x870C, 1600, false, flexPhase(1234567L, TEXT, 765432L, "5551234"),
            mapOf(6 + 6 to 0x0E000000, 6 + 7 to 0x00E00000, 6 + 8 to 0x000E0000)))
        val alpha = c.pages.first { it.capcode == 1234567L }
        assertEquals(lostWords(6, 8), alpha.text)
        assertEquals(3, alpha.errors)
        assertEquals("5551234", c.pages.first { it.capcode == 765432L }.text)
    }

    /** Four bits of one word lost in a fade: past what BCH fixes, but the receiver knew they were weak; K confirms it. */
    @Test fun flexRecoversAFadedWord() {
        val (c, dec) = decode1600(31, flexFrame(0x870C, 1600, false, flexPhase(1234567L, TEXT, 765432L, "5551234"), fade = mapOf(6 + 3 to 0x48210000)))
        val alpha = c.pages.first { it.capcode == 1234567L }
        assertEquals(TEXT, alpha.text)
        assertEquals(0, alpha.errors)
        assertTrue("recovered ${dec.recovered}", dec.recovered >= 1)
    }

    /** A fade across two neighbouring words (five weak bits in one, three in the next): both come back whole. */
    @Test fun flexRecoversAFadeAcrossWords() {
        val (c, _) = decode1600(32, flexFrame(0x870C, 1600, false, flexPhase(1234567L, TEXT, 765432L, "5551234"), fade = mapOf(6 + 5 to 0x41208400, 6 + 6 to 0x00E00000)))
        val alpha = c.pages.first { it.capcode == 1234567L }
        assertEquals(TEXT, alpha.text)
        assertEquals(0, alpha.errors)
    }

    /** A word wrong by six confident bits is not "recovered" into something else: it stays lost. */
    @Test fun flexDoesNotInventFromConfidentErrors() {
        val (c, _) = decode1600(33, flexFrame(0x870C, 1600, false, flexPhase(1234567L, TEXT, 765432L, "5551234"), flip = mapOf(6 + 3 to 0x3F000000)))
        val alpha = c.pages.first { it.capcode == 1234567L }
        assertEquals("STATION ???ESPOND TO ROOM 38 NOW PLEASE", alpha.text)
        assertEquals(1, alpha.errors)
    }

    /** Words that needed two bits fixed are kept when K confirms the page, even the last. */
    @Test fun flexKeepsTwoBitFixes() {
        val lastWord = 6 + (TEXT.length - 2 + 2) / 3
        val (c, _) = decode1600(23, flexFrame(0x870C, 1600, false, flexPhase(1234567L, TEXT, 765432L, "5551234"), mapOf(6 + 4 to 0x00000006, lastWord to 0x60000000)))
        val alpha = c.pages.first { it.capcode == 1234567L }
        assertEquals(TEXT, alpha.text)
        assertEquals(0, alpha.errors)
    }

    /** Noise that the check "corrects" into a wrong word (two bits from another codeword): K catches it, the word is lost. */
    @Test fun flexChecksumCatchesAMiscorrectedWord() {
        val phase = flexPhase(1234567L, TEXT, 765432L, "5551234")
        val wrong = phase.copyOf(); wrong[6 + 4] = phase[6 + 4] xor 0x0A5A5   // another valid word, the page's K unchanged
        val (c, _) = decode1600(24, flexFrame(0x870C, 1600, false, wrong, mapOf(6 + 4 to 0x00000006)))
        val alpha = c.pages.first { it.capcode == 1234567L }
        assertEquals(lostWords(4, 4), alpha.text)
        assertEquals(1, alpha.errors)
    }

    /** A page in two fragments (same message number): joined, the continuation's first character included. */
    @Test fun flexJoinsFragmentsByMessageNumber() {
        val f1 = flexFrame(0x870C, 1600, false, flexPhase(1234567L, "PART ONE OF THE ", 765432L, "5551234", n = 7, frag = 3, more = 1))
        val f2 = flexFrame(0x870C, 1600, false, flexPhase(1234567L, "MESSAGE ENDS HERE", 765432L, "5551234", n = 7, frag = 0, more = 0))
        val (c, _) = decode1600(41, f1, f2)
        val alpha = c.pages.filter { it.capcode == 1234567L }
        assertEquals("pages: $alpha", 1, alpha.size)
        assertEquals("PART ONE OF THE MESSAGE ENDS HERE", alpha[0].text)
        assertEquals(0, alpha[0].errors)
    }

    /** A continuation with a different message number belongs to another message: not joined. */
    @Test fun flexDoesNotJoinDifferentMessages() {
        val f1 = flexFrame(0x870C, 1600, false, flexPhase(1234567L, "PART ONE OF THE ", 765432L, "5551234", n = 7, frag = 3, more = 1))
        val f2 = flexFrame(0x870C, 1600, false, flexPhase(1234567L, "SOMETHING ELSE", 765432L, "5551234", n = 8, frag = 0, more = 0))
        val (c, _) = decode1600(42, f1, f2)
        val alpha = c.pages.filter { it.capcode == 1234567L }
        assertTrue("pages: $alpha", alpha.none { it.text.contains("PART ONE OF THE SOMETHING") })
        val orphan = alpha.first { it.text.contains("SOMETHING ELSE") }
        assertTrue("orphan: $orphan", orphan.text.startsWith("<…>") && orphan.errors > 0)
    }

    /** A fragment missing from the sequence (F jumps): the gap is marked and the page is partial. */
    @Test fun flexMarksAMissingFragment() {
        val f1 = flexFrame(0x870C, 1600, false, flexPhase(1234567L, "FIRST PIECE ", 765432L, "5551234", n = 3, frag = 3, more = 1))
        val f3 = flexFrame(0x870C, 1600, false, flexPhase(1234567L, "LAST PIECE", 765432L, "5551234", n = 3, frag = 1, more = 0))
        val (c, _) = decode1600(43, f1, f3)
        val alpha = c.pages.first { it.capcode == 1234567L }
        assertEquals("FIRST PIECE <…>LAST PIECE", alpha.text)
        assertTrue(alpha.errors > 0)
    }

    /** Two transmissions of a page, each losing a different word: the second fills the first, and a third adds nothing. */
    @Test fun flexCombinesRepeatsWordByWord() {
        val phase = flexPhase(1234567L, TEXT, 765432L, "5551234")
        val (c, _) = decode1600(44,
            flexFrame(0x870C, 1600, false, phase, mapOf(6 + 3 to 0x0E000000)),
            flexFrame(0x870C, 1600, false, phase, mapOf(6 + 9 to 0x0E000000)),
            flexFrame(0x870C, 1600, false, phase))
        val alpha = c.pages.filter { it.capcode == 1234567L }
        assertEquals("pages: $alpha", 3, alpha.size)
        assertEquals(lostWords(3, 3), alpha[0].text); assertEquals(0, alpha[0].repeat)
        assertEquals(TEXT, alpha[1].text); assertEquals(0, alpha[1].errors); assertEquals(2, alpha[1].repeat)
        assertEquals(1, alpha[2].repeat)
        assertEquals(alpha[0].key, alpha[1].key)
    }

    /** The same capcode and number but words that disagree where both copies read them: a different page, kept apart. */
    @Test fun flexDoesNotCombineDifferentPages() {
        val (c, _) = decode1600(45,
            flexFrame(0x870C, 1600, false, flexPhase(1234567L, TEXT, 765432L, "5551234"), mapOf(6 + 3 to 0x0E000000)),
            flexFrame(0x870C, 1600, false, flexPhase(1234567L, "STATION 9 RESPOND TO ROOM 12 NOW PLEASE", 765432L, "5551234")))
        val alpha = c.pages.filter { it.capcode == 1234567L }
        assertEquals("STATION 9 RESPOND TO ROOM 12 NOW PLEASE", alpha[1].text)
        assertEquals(0, alpha[1].repeat)
    }

    /** A numeric word "corrected" into a wrong one: the numeric checksum catches it. */
    @Test fun flexNumericChecksum() {
        val phase = flexPhase(1234567L, TEXT, 765432L, "5551234")
        val nStart = 5 + alphaWords(TEXT, 5).size
        val wrong = phase.copyOf(); wrong[nStart] = phase[nStart] xor 0x0A5A0
        val (c, _) = decode1600(46, flexFrame(0x870C, 1600, false, wrong, mapOf(nStart to 0x00000006)))
        assertEquals(1, c.pages.first { it.capcode == 765432L }.errors)
        val (c2, _) = decode1600(47, flexFrame(0x870C, 1600, false, phase))
        assertEquals(0, c2.pages.first { it.capcode == 765432L }.errors)
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

    @Test fun textFilterKeepsWritingAndDropsDataFeeds() {
        for (s in listOf("MSN 012 Hello Message from NOC PCB2 3102174981 [53]",
                "THIS IS A TEST PERIODIC PAGE SEQUENTIAL NUMBER  6763",
                "From: WebCTRL@ngc.com Subject: VAV-1-07 Control Room - High Zone Temp: Alarm (ZTMP_HI)  [86]",
                "CALL 555-1212 RE: PT IN RM 4 *URGENT*"))
            assertTrue(s, PocsagDecoder.readsAsText(s))
        for (s in listOf("~G1\$+#^aXaV`UbUbU\$!!!!Pueblo CO       . [68]",
                "~G1 +#`d]e]f]h^h_\"\"!!!Bakersfield CA  . [18]",
                "~&=\$#SAaXaV`UbUbU\$!!!!PUB [39]",
                "~G1!+#glemeidhdga\$&\$&&Brownsville TX  . [27]"))
            assertTrue(s, !PocsagDecoder.readsAsText(s))
    }
    /** The hunter's controls on a span with two steady carriers: a waterfall tap a few kHz off one pins that carrier
     *  and turns AUTO off, only it keeps a receiver, AUTO toggles, and letting the last pin go leaves AUTO off. */
    @Test fun hunterControls() {
        val rate = 1_000_000; val center = 929_600_000L
        val tones = longArrayOf(929_400_000L, 929_912_500L)
        val e = PagerEngine
        var t = 1_700_000_000_000L   // the engine's clock is the wall clock
        e.clock = { t }
        e.setHunting(true); e.start()
        val n = 65_536; val buf = ByteArray(2 * n); var k0 = 0L
        val r = java.util.Random(5)
        fun feed(ms: Long) {
            val end = t + ms
            while (t < end) {
                for (k in 0 until n) {
                    var a = r.nextGaussian() * 3; var b = r.nextGaussian() * 3
                    for (f in tones) { val ph = 2 * PI * (f - center) * (k0 + k) / rate; a += 25 * cos(ph); b += 25 * sin(ph) }
                    buf[2 * k] = (a + 127.4).roundToInt().coerceIn(0, 255).toByte(); buf[2 * k + 1] = (b + 127.4).roundToInt().coerceIn(0, 255).toByte()
                }
                k0 += n; t += n * 1000L / rate
                e.onIq(buf, 2 * n, rate, center)
            }
        }
        fun listening() = e.channels.value.filter { it.listening }.map { it.hz }
        feed(4000)
        assertEquals("AUTO gives both carriers a receiver: ${e.channels.value}", 2, listening().size)
        e.pick(929_404_100L); feed(100)
        val pins = e.pinnedList()
        assertTrue("a tap 4 kHz off a carrier pins the carrier: $pins", pins.size == 1 && abs(pins[0] - 929_400_000L) <= 2500)
        assertTrue("a tap turns AUTO off", !e.status.value.hunting)
        assertEquals("only the picked carrier keeps a receiver", listOf(pins[0]), listening())
        assertEquals("the picked carrier is heard and shaded", pins[0], e.status.value.heardHz)
        e.toggleAuto(); feed(100)
        assertTrue("AUTO while off turns it on and forgets the pins", e.status.value.hunting && e.pinnedList().isEmpty())
        feed(3000)
        e.toggleAuto(); feed(100)
        assertTrue("AUTO while on turns it off, holding what was decoding: ${e.status.value} ${listening()}",
            !e.status.value.hunting && e.pinnedList().isEmpty() && listening().size == 2 && e.status.value.text.startsWith("AUTO off"))
        e.pick(929_912_000L); feed(100)
        assertEquals("picking one keeps just it", 1, listening().size)
        e.unpin(e.pinnedList()[0]); feed(100)
        assertTrue("letting the last pin go stops it and leaves AUTO off: ${listening()}", !e.status.value.hunting && listening().isEmpty())
        e.stop(); e.setHunting(true)
    }

    @Test fun callOutWords() {
        val re = PagerEngine.isCallOut("Subj:Low WARNING 68") && PagerEngine.isCallOut("critical lab value") &&
            PagerEngine.isCallOut("PATIENT: Richard B") && PagerEngine.isCallOut("CODE TEST") && !PagerEngine.isCallOut("Bed Clean - Routine")
        assertTrue("WARNING, CRITICAL, PATIENT and CODE make a call-out; routine traffic does not", re)
    }

    // ---------------------------------------------------------------- POCSAG over the air, through the hunter

    /**
     * A bursty POCSAG transmitter in a wide RTL-SDR-style span (u8 IQ), run through the whole hunter: the span
     * survey has to find the carrier, give it a receiver, and the receiver has to decode it. Real POCSAG keys up
     * only to send (unlike FLEX, which never stops), with the radio's own frequency error on top and the data
     * low-pass shaped by the transmitter. [gapS] is the quiet time between transmissions.
     */
    private fun airRun(baud: Int, invert: Boolean, seed: Int, rate: Int = 2_400_000, bursts: Int = 3, gapS: Double = 4.0,
                       errHz: Double = 1800.0, amp: Double = 20.0, chanOff: Long = 312_500L, devHz: Double = 4500.0): List<PagerPage> {
        val center = 152_000_000L; val chan = center + chanOff
        val text = "CODE BLUE RM 412 EAST"
        val bits = pocsagBits(listOf(Triple(1234567L, 3, text), Triple(765432L, 0, "5551234")), setOf(1234567L))
        val sps = rate.toDouble() / baud
        val noise = DoubleArray(1 shl 16).also { val r = Random(seed); for (i in it.indices) it[i] = r.nextGaussian() }
        var lcg = seed.toLong() * 2654435761L + 1
        fun nz(): Double { lcg = lcg * 6364136223846793005L + 1442695040888963407L; return noise[(lcg ushr 48).toInt()] }
        val e = PagerEngine
        var t = 1_700_000_000_000L
        e.clock = { t }
        e.stop(); e.clear(); e.setHunting(true); e.start()
        val n = 131_072; val buf = ByteArray(2 * n)
        var ph = 0.0; var shaped = 0.0
        val alpha = 1.0 - kotlin.math.exp(-2 * PI * 0.6 * baud / rate)   // ~0.6 x baud transmitter low-pass
        val burstLen = (bits.size * sps).toLong()
        val gap = (gapS * rate).toLong()
        val lead = (3.0 * rate).toLong()
        val total = lead + bursts * (burstLen + gap)
        var s = 0L
        while (s < total) {
            for (k in 0 until n) {
                val at = s + k
                var on = false; var dev = 0.0
                if (at >= lead) {
                    val q = (at - lead) % (burstLen + gap)
                    if (q < burstLen) {
                        on = true
                        val b = bits[(q / sps).toInt().coerceAtMost(bits.size - 1)]
                        dev = if ((b == 1) != invert) -devHz else devHz   // POCSAG: a 1 is the low tone
                    }
                }
                shaped += (dev - shaped) * alpha
                var a = nz() * 4.0 + 5.0; var bq = nz() * 4.0 - 3.0   // with the radio's DC offset
                if (on) {
                    ph += 2 * PI * (chan - center + errHz + shaped) / rate
                    if (ph > PI) ph -= 2 * PI
                    a += amp * cos(ph); bq += amp * sin(ph)
                }
                buf[2 * k] = (a + 127.4).roundToInt().coerceIn(0, 255).toByte(); buf[2 * k + 1] = (bq + 127.4).roundToInt().coerceIn(0, 255).toByte()
            }
            s += n; t += n * 1000L / rate
            e.onIq(buf, 2 * n, rate, center)
        }
        val got = e.messages.value.map { it.page }
        chansSeen = e.channels.value.size
        e.stop(); e.clear()
        return got
    }

    private var chansSeen = 0

    /** Only the radio's noise and DC offset in the span: the survey lists no carriers and nothing decodes. */
    @Test fun pocsagAirNoiseOnlyFindsNothing() {
        val pages = airRun(1200, false, 42, amp = 0.0, bursts = 1)
        assertTrue("pages from noise: $pages", pages.isEmpty())
        assertEquals("carriers listed from noise alone", 0, chansSeen)
    }

    /** Every transmission decodes, the first one included: [bursts] alpha and [bursts] numeric pages. */
    private fun assertAir(baud: Int, invert: Boolean, pages: List<PagerPage>, bursts: Int = 3) {
        val what = "POCSAG $baud${if (invert) " inverted" else ""} over the air"
        val alpha = pages.filter { it.capcode == 1234567L }
        val num = pages.filter { it.capcode == 765432L }
        assertEquals("$what: alpha pages in $pages", bursts, alpha.size)
        assertEquals("$what: numeric pages in $pages", bursts, num.size)
        for (a in alpha) { assertEquals("CODE BLUE RM 412 EAST", a.text); assertEquals("POCSAG", a.protocol); assertEquals(baud.toString(), a.rate) }
        for (n in num) assertEquals("5551234", n.text)
    }

    @Test fun pocsagAir512() = assertAir(512, false, airRun(512, false, 31))
    @Test fun pocsagAir512Inverted() = assertAir(512, true, airRun(512, true, 32))
    @Test fun pocsagAir1200() = assertAir(1200, false, airRun(1200, false, 33))
    @Test fun pocsagAir1200Inverted() = assertAir(1200, true, airRun(1200, true, 34))
    @Test fun pocsagAir2400() = assertAir(2400, false, airRun(2400, false, 35))
    @Test fun pocsagAir2400Inverted() = assertAir(2400, true, airRun(2400, true, 36))
    /** Tuned right onto the pager's frequency: the carrier sits on the radio's DC spike. */
    @Test fun pocsagAirAtTheTunedCenter() = assertAir(1200, false, airRun(1200, false, 37, chanOff = 0L))
    @Test fun pocsagAirAtTheTunedCenter512Inverted() = assertAir(512, true, airRun(512, true, 38, chanOff = 2500L, amp = 1.4))
    /** A pager that keys up every half minute, which the survey has long forgotten by the next page. */
    @Test fun pocsagAirLongGaps() = assertAir(2400, false, airRun(2400, false, 39, rate = 1_024_000, gapS = 30.0))
    @Test fun pocsagAirNarrowDeviationBigOffset() = assertAir(1200, true, airRun(1200, true, 40, devHz = 2500.0, errHz = 5000.0, rate = 3_840_000))
    @Test fun pocsagAirWeak() = assertAir(2400, false, airRun(2400, false, 41, amp = 1.4))
}
