package com.rocketgod.mayhem.core.sonde

import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.apps.Retuner
import com.rocketgod.mayhem.core.sonde.SondeSynth.FlightPoint
import com.rocketgod.mayhem.core.sonde.SondeSynth.Prng
import com.rocketgod.mayhem.core.sonde.SondeSynthB.LmsOpts
import com.rocketgod.mayhem.core.sonde.SondeSynthB.MrzOpts
import com.rocketgod.mayhem.core.sonde.SondeSynthB.Rs92Opts
import com.rocketgod.mayhem.core.trains.Ddc
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.min

/**
 * Sondes, bank B (the twin of web/test/sonde-b.mjs): Vaisala RS92 (SGP and NGP), Lockheed Martin LMS6-403, LMSX and
 * LMS6-1680, MRZ. Frames built the way each sonde builds them, through the frame decoders and the channel decoders
 * (symbol slicer, header search in both FM polarities), the published test vectors, the 15 dB seed sweeps, then FSK
 * on raw IQ through the whole receiver.
 */
class SondeBankBTest {
    private class Checks {
        var pass = 0; val fails = ArrayList<String>()
        fun ok(c: Boolean, what: String, extra: String = "") { if (c) pass++ else fails.add(what + if (extra.isNotEmpty()) " — $extra" else "") }
        fun near(a: Double?, b: Double, tol: Double, what: String) = ok(a != null && abs(a - b) <= tol, what, "got $a, want $b ± $tol")
        fun eq(a: Any?, b: Any?, what: String) = ok(a == b, what, "got $a, want $b")
        fun done(name: String) { println("  $name: $pass passed, ${fails.size} failed"); assertTrue(fails.joinToString("\n"), fails.isEmpty()) }
    }

    private fun hex(s: String): IntArray { val h = s.filter { it.isLetterOrDigit() }; return IntArray(h.length / 2) { h.substring(2 * it, 2 * it + 2).toInt(16) } }
    private fun bitsLsb(bytes: IntArray) = SondeSynth.bitsOf(bytes, true)
    private fun flight(k: Int) = FlightPoint(39.7392 + k * 1e-4, -104.9903 + k * 2e-4, 1600 + k * 5.1, 3.0, 4.0, 5.1)
    private fun fall(k: Int) = FlightPoint(-33.9 + k * 1e-4, 151.2 - k * 1e-4, 20_000.0 - k * 12, -6.0, -2.5, -12.0)
    private fun idle(n: Int) = IntArray(n) { it and 1 }

    /**
     * Channel symbols as an ideal discriminator (radians/sample) at [rate], through every bank-B channel decoder. A run of
     * idle alternating symbols before and after; [invert] flips the FM polarity; [flip] lists symbol indexes to corrupt.
     */
    private fun feed(syms: IntArray, baud: Double, rate: Double = 48_000.0, invert: Boolean = false, flip: List<Int> = emptyList(), idleN: Int = 64): List<SondeFrame> {
        val out = ArrayList<SondeFrame>()
        val decs = SondeBank.makeBankB(rate) { out.add(it) }
        val all = idle(idleN) + syms + idle(idleN)
        val bad = flip.map { it + idleN }.toHashSet()
        val n = (all.size * rate / baud).toLong(); val amp = if (invert) -0.3 else 0.3
        val rng = Prng(77)
        for (t in 0 until n) {
            val k = (t * baud / rate).toInt()
            var v = if (all[k] != 0) amp else -amp
            if (k in bad) v = -v
            v += 0.05 * rng.gauss()
            for (d in decs) d.push(v)
        }
        return out
    }

    @Test fun convolutionalCode() {
        val c = Checks()
        val blkSync = "0000000000000000" + "0000001101011101" + "0100100111000010" + "0100111111110010" + "0110100001101011"
        val code = IntArray(80)
        Conv.encode(bitsLsb(intArrayOf(0x00, 0x58, 0xf3, 0x3f, 0xb8)), 0, code, 0)
        c.eq(code.joinToString(""), blkSync, "LMS6 sync bytes encode to the published code symbols")
        val raw = code.copyOfRange(16, 80).withIndex().joinToString("") { (i, v) -> "${if (i and 1 != 0) 1 - v else v}" }
        c.eq(raw, Lms6.HEADER, "LMS6 header = the sync code with every second symbol inverted")
        val rng = Prng(5)
        val bits = IntArray(2000) { if (rng.next() < 0.5) 1 else 0 }
        val c2 = IntArray(4000)
        Conv.encode(bits, Lms6.SYNC_STATE, c2, 0)
        val soft = FloatArray(4000) { if (c2[it] != 0) 1f else -1f }
        var flips = 0
        var i = 0
        while (i < soft.size) { soft[i] = -soft[i]; flips++; i += 37 }
        val out = IntArray(2000)
        val errs = Viterbi(2000).decode(soft, 0, 2000, Lms6.SYNC_STATE, out)
        c.ok(out.contentEquals(bits), "Viterbi corrects scattered symbol errors")
        c.eq(errs, flips, "Viterbi counts the symbols it repaired")
        c.done("convolutional code")
    }

    private val rs92Vector = "2a2a2a2a2a10" + "6510" + "e81820204b34393533393334006100083d3d07b342bb3e9809d3bc3f754c963b" + "ebfb" +
        "690c" + "ca2b0fd9670f00670f8c0f11a458111e8810da410d30430d" + "dc84" +
        "673d" + "b01c852167ab07298b3cb05a536e0fffcf4faf7f4f3fff8fcfffffffff7fe5918aef20e8110175879900d0e0e900061f8c048aa393009edea1fe2557dc0019549f04b5160d00ae998b00e12a4200370b8608cacc1900b3e08905bd60040126da9303e1d4b4006d04a00573469700d6a98b00699f120195828f04" + "6ed7" +
        "6805" + "03030000000000000000" + "b27d" + "ff02" + "02000200" + "f0be2a40a7cd69b9ed0668ec12182e8560ea6dd0733612a1"

    private fun rs92Run(ngp: Boolean, serial: String = "P3141592", n: Int = 33): List<IntArray> {
        val cal = SondeSynthB.rs92CalTable(if (ngp) 1_680_000 else 402_150, 0x0e10, ngp)
        val ptu = SondeSynthB.rs92PtuCounts(-20.0, 60.0, 40.0, 850.0)
        return List(n) { k -> SondeSynthB.rs92Frame(Rs92Opts(serial, 500 + k, cal, ptu, 3 * 86_400_000L + 45_296_000 + k * 1000,
            intArrayOf(2, 5, 7, 12, 13, 15, 19, 24, 30), intArrayOf(0x1234, 0, 0, 0xabcd), ngp)) }
    }
    private fun flat(parts: List<IntArray>): IntArray { val o = IntArray(parts.sumOf { it.size }); var k = 0; for (p in parts) { p.copyInto(o, k); k += p.size }; return o }

    @Test fun rs92() {
        val c = Checks()
        val v = hex(rs92Vector)
        c.eq(v.size, 240, "RS92 vector is a whole frame")
        val r = Rs92Decoder().parse(v.copyOf())
        c.eq(r?.serial, "K4953934", "RS92 vector: serial")
        c.eq(r?.frame, 6376, "RS92 vector: frame number")
        c.eq(r?.fixed, 0, "RS92 vector: RS parity checks (no repair)")
        c.eq(r?.extra?.get("CALIBRATION"), "1/32", "RS92 vector: one calibration row")
        c.eq(r?.lat, null, "RS92 vector: no position (raw GPS)")
        c.eq(r?.extra?.get("POSITION"), "raw GPS only (needs an ephemeris)", "RS92 says why there is no position")
        val ts = r?.timeS
        c.ok(ts != null && ts >= 0 && ts < 86400, "RS92 vector: GPS time of day", "$ts")
        // the same frame off the air: 8N1 Manchester symbols after the 60-symbol header
        val syms = SondeSynthB.rs92Symbols(v)
        c.eq(syms.copyOfRange(60, 120).joinToString(""), Rs92.HEADER, "RS92 header symbols")
        c.eq(Rs92Decoder().decode(FloatArray(syms.size - 120) { if (syms[120 + it] != 0) 1f else -1f })?.serial, "K4953934", "RS92 vector from symbols")
        // damage: 12 bytes repaired, then too many
        val bad = v.copyOf(); for (i in 0 until 12) bad[10 + i * 17] = bad[10 + i * 17] xor 0x5a
        val rb = Rs92Decoder().parse(bad)
        c.eq(rb?.serial, "K4953934", "RS92 Reed-Solomon repairs 12 bytes")
        c.eq(rb?.fixed, 12, "RS92 reports bytes repaired")
        val worse = v.copyOf(); for (i in 0 until 30) worse[8 + i * 7] = worse[8 + i * 7] xor 0x33
        c.eq(Rs92Decoder().parse(worse), null, "RS92 beyond repair is rejected")

        for (ngp in listOf(false, true)) {
            val name = if (ngp) "RS92-NGP" else "RS92-SGP"
            val dec = Rs92Decoder()
            var last: SondeFrame? = null
            for (fr in rs92Run(ngp)) last = dec.parse(fr)
            c.eq(last?.serial, "P3141592", "$name serial")
            c.eq(last?.frame, 532, "$name frame number")
            c.eq(last?.model, name, "$name model from the calibration table")
            c.eq(last?.extra?.get("CALIBRATION"), "32/32", "$name whole calibration table")
            c.near(last?.tempC, -20.0, 0.01, "$name temperature")
            c.near(last?.rh, 60.0, 0.01, "$name humidity (the higher sensor)")
            c.near(last?.hPa, 850.0, 0.05, "$name pressure")
            c.eq(last?.txKHz, if (ngp) 1_680_000 else 402_150, "$name reported frequency")
            c.eq(last?.killS, 0x0e10, "$name burst timer")
            c.eq(last?.sats, 9, "$name satellites tracked")
            c.eq(last?.extra?.get("PRN"), "2 5 7 12 13 15 19 24 30", "$name PRNs")
            c.eq(last?.timeS, (45_296 + 32).toDouble(), "$name GPS time of day")
            c.eq(last?.extra?.get("GPS WEEKDAY"), "Wed", "$name GPS weekday")
            c.eq(last?.extra?.get("AUX"), "12340000" + "0000abcd", "$name aux words")
            c.eq(last?.lat, null, "$name leaves the position undefined")
            c.eq(last?.battV, null, "$name sends no battery voltage")
        }
        // through the channel decoders, both polarities, with symbol errors for the RS to repair
        val ss = flat(rs92Run(false, "P2718281", 3).map { SondeSynthB.rs92Symbols(it) })
        for (invert in listOf(false, true)) {
            val pol = if (invert) "inverted" else "upright"
            val out = feed(ss, 4800.0, invert = invert, flip = listOf(500, 501, 1500, 1501, 2600, 2601, 3334, 3335, 6000, 6001, 7776, 7777)).filter { it.type == "RS92" }
            c.eq(out.size, 3, "RS92 channel decoder, $pol FM")
            c.eq(out.getOrNull(0)?.serial, "P2718281", "RS92 channel decoder serial, $pol")
            c.ok((out.getOrNull(0)?.fixed ?: 0) > 0, "RS92 channel decoder repaired the flipped symbols", "fixed ${out.getOrNull(0)?.fixed}")
        }
        c.done("RS92")
    }

    private val lms6Vector = "0058f33fb8" +
        "24540000007a9a4a1f130cbf07ebffe6d5a724379382ffa65ed3014af1e700c57f0030fc0016f30038062d1f83e87e6e1cfb46c5882b80000000000000000010241f93527ea51cf0fe0e092c1f7d6199e91cf727050300840000000000000000022d1f82806c481cf28f241a1e1f988f57a41cf61524172a1f8a93d8971cfad879072f1f82ce07431ced04ee05291f8d40eddb1ceaddfb1e2b1f8d3b04691ce93c511d1b1f95ed89031cf18e5203c33700000003a60a09b3110000000000001be4360fc22803c34903c35003c34c03c34c00000026ee3986069d361682f5fb" +
        "b00f3bd474dc5798959cb3abbd9a6b81a50b3bbbfeaf87cdc15a220cf5e6c437"

    private fun checkLms6Vector(c: Checks, f: SondeFrame?, what: String) {
        c.eq(f?.serial, "LMS6-8034890", "$what: serial")
        c.eq(f?.type, "LMS6", "$what: type")
        c.eq(f?.model, "LMS6-403", "$what: model")
        c.eq(f?.frame, 7955, "$what: frame counter")
        c.near(f?.timeS, 213_845.995 - 2 * 86400, 1e-6, "$what: GPS time of day")
        c.eq(f?.extra?.get("GPS WEEKDAY"), "Tue", "$what: GPS weekday")
        c.near(f?.lat, 50.930289, 1e-6, "$what: latitude")
        c.near(f?.lon, -0.492350, 1e-6, "$what: longitude")
        c.near(f?.alt, 21688.807, 1e-3, "$what: altitude")
        c.near(f?.vH, hypot(50.559, 12.540), 1e-3, "$what: ground speed")
        c.near(f?.heading, atan2(50.559, 12.540) * 180 / PI, 1e-3, "$what: heading")
        c.near(f?.climb, 5.875, 1e-3, "$what: climb")
    }

    private fun lmsOpts(k: Int) = LmsOpts(0x123456, 300 + k, 4 * 86_400_000L + 3_600_000 + k * 1000, fall(k))
    private fun checkLms(c: Checks, f: SondeFrame?, k: Int, what: String, x: Boolean) {
        val p = fall(k)
        c.eq(f?.serial, "${if (x) "LMSX" else "LMS6"}-${0x123456}", "$what: serial")
        c.eq(f?.model, if (x) "LMSX" else "LMS6-403", "$what: model")
        c.eq(f?.frame, 300 + k, "$what: frame counter")
        c.near(f?.timeS, 3600.0 + k, 1e-6, "$what: GPS time of day")
        c.near(f?.lat, p.lat, 1e-7, "$what: latitude")
        c.near(f?.lon, p.lon, 1e-7, "$what: longitude")
        c.near(f?.alt, p.alt, if (x) 0.01 else 0.001, "$what: altitude")
        c.near(f?.vH, hypot(p.vN, p.vE), 0.01, "$what: ground speed")
        c.near(f?.heading, (atan2(p.vE, p.vN) * 180 / PI + 360) % 360, 0.01, "$what: heading")
        c.near(f?.climb, p.vU, 0.01, "$what: climb")
    }

    @Test fun lms6AndLmsx() {
        val c = Checks()
        val v = hex(lms6Vector)
        c.eq(v.size, 260, "LMS6 vector is a whole block")
        val fr = Lms6Decoder().blockBytes(v.copyOf(), false)
        c.eq(fr.size, 1, "LMS6 vector: one frame in the block")
        checkLms6Vector(c, fr.getOrNull(0), "LMS6 vector")
        c.eq(fr.getOrNull(0)?.fixed, 0, "LMS6 vector: RS parity checks (no repair)")
        // the block off the air: convolutional code, the header, the Viterbi
        val syms = SondeSynthB.lmsSymbols(v)
        c.eq(syms.copyOfRange(16, 80).joinToString(""), Lms6.HEADER, "LMS6 vector: header symbols")
        val soft = FloatArray(syms.size - 80) { if (syms[80 + it] != 0) 1f else -1f }
        var i = 0
        while (i < soft.size) { soft[i] = -soft[i]; i += 29 }
        checkLms6Vector(c, Lms6Decoder().decode(soft, false).getOrNull(0), "LMS6 vector through the Viterbi (3% symbol errors)")
        // RS: 16 bytes repaired, 17+ rejected
        val bad = v.copyOf(); for (j in 0 until 16) bad[6 + j * 15] = bad[6 + j * 15] xor 0xc3
        val rb = Lms6Decoder().blockBytes(bad, false)
        c.eq(rb.getOrNull(0)?.serial, "LMS6-8034890", "LMS6 Reed-Solomon repairs 16 bytes")
        c.eq(rb.getOrNull(0)?.fixed, 16, "LMS6 reports bytes repaired")
        val worse = v.copyOf(); for (j in 0 until 24) worse[6 + j * 10] = worse[6 + j * 10] xor 0x3c
        c.eq(Lms6Decoder().blockBytes(worse, false).size, 0, "LMS6 beyond repair is rejected")
        val crcBad = v.copyOfRange(5, 228); crcBad[30] = crcBad[30] xor 1
        c.eq(Lms6.parse(crcBad, false), null, "LMS6 frame with a bad CRC is rejected")

        // frames straddle the 260-byte blocks (34 fill bytes between frames, like the real 13:15 drift)
        val frames = List(5) { SondeSynthB.lms6Frame(lmsOpts(it)) }
        val ls = SondeSynthB.lmsSymbols(SondeSynthB.lms6Blocks(frames, 34))
        for (invert in listOf(false, true)) {
            val pol = if (invert) "inverted" else "upright"
            val flip = (300 until ls.size step 41).toList()
            val out = feed(ls, 4800.0, invert = invert, flip = flip)
            val l6 = out.filter { it.serial.startsWith("LMS6") }
            c.eq(l6.size, 5, "LMS6 channel decoder: all frames across blocks, $pol FM")
            checkLms(c, l6.getOrNull(3), 3, "LMS6 channel decoder ($pol)", false)
            c.eq(out.count { it.serial.startsWith("LMSX") || it.type != "LMS6" }, 0, "LMS6 signal decodes as nothing else")
        }
        // a gap in the block stream: the frame cut by it is dropped, never stitched to the wrong bytes
        val blocks = SondeSynthB.lms6Blocks(frames, 34)
        val dec = Lms6Decoder()
        val got = ArrayList<SondeFrame>()
        for (k in 0 until blocks.size / 260) if (k != 2) got.addAll(dec.blockBytes(blocks.copyOfRange(260 * k, 260 * k + 260), k != 3))
        c.ok(got.size >= 2 && got.size < 5 && got.all { (it.frame ?: 0) in 300..304 }, "LMS6 stream restarts after a missed block", got.joinToString(",") { "${it.frame}" })

        val xf = List(4) { SondeSynthB.lmsxFrame(lmsOpts(it)) }
        val xs = SondeSynthB.lmsSymbols(SondeSynthB.lmsxUnits(xf))
        for (invert in listOf(false, true)) {
            val pol = if (invert) "inverted" else "upright"
            val flip = (200 until xs.size step 37).toList()
            val out = feed(xs, 4797.8, invert = invert, flip = flip)
            val lx = out.filter { it.serial.startsWith("LMSX") }
            c.eq(lx.size, 4, "LMSX channel decoder, $pol FM")
            checkLms(c, lx.getOrNull(2), 2, "LMSX channel decoder ($pol)", true)
            c.eq(out.count { !it.serial.startsWith("LMSX") }, 0, "LMSX signal decodes as nothing else")
        }
        // the codeword 35 bytes late (block byte 40), RS repair, and beyond repair
        val unit = IntArray(300)
        intArrayOf(0x00, 0x58, 0xf3, 0x3f, 0xb8).copyInto(unit, 0); unit.fill(0xca, 5, 40)
        SondeSynthB.lmsCodeword(xf[1]).copyInto(unit, 40)
        checkLms(c, LmsxDecoder().unit(unit), 1, "LMSX codeword at block byte 40", true)
        val badU = unit.copyOf(); for (j in 0 until 15) badU[41 + j * 16] = badU[41 + j * 16] xor 0x99
        c.eq(LmsxDecoder().unit(badU)?.fixed, 15, "LMSX Reed-Solomon repairs 15 bytes")
        val worseU = unit.copyOf(); for (j in 0 until 40) worseU[42 + j * 6] = worseU[42 + j * 6] xor 0x99
        c.eq(LmsxDecoder().unit(worseU), null, "LMSX beyond repair is rejected")
        c.done("LMS6-403 / LMSX")
    }

    private val mk2a4d = "24 52 4D 31 EC 64 05 D8 00 38 0D 03 B9 B2 19 FA 6C 11 D6 32 19 FC 86 1F F8 56 0F FF FD 1D FD 74 11 F6 4E 03 B9 BD 03 B9 D4 03 B9 C5 03 B9 BA 03 B9 BE EC 64 00 6B 00 0D 6D 07 60 13 71 56 9A CB 42 38 E4 15 CA CA CA CA"
    private val mk2a54 = "24 52 54 32 EC 64 05 D7 00 A2 19 94 37 BB FF EE 84 92 21 41 60 82 B8 57 DA EF 00 1B FD 3E 00 07 BD FF F9 A0 00 0E E8 00 30 0A 10 28 0F 14 00 84 35 5F 47 1C FB 32 8E 07 2E 0F 14 00 83 07 E0 E2 1C EC F4 4D 0A 2B 0F 14 00 8B EE 8C 09 1C F6 1B C8 06 26 0F 14 00 83 AF 54 27 1C F3 08 C3 08 29 0F 14 00 91 E7 40 26 1C EA F7 A2 0D 2B 0F 14 00 79 F5 EB D4 1C F4 CE C8 13 24 0F 14 00 89 DB 4B F1 1C EA 78 64 17 2B 0F 14 00 7E A0 15 A5 1C F9 BA C4 03 27 0F 14 00 80 6F 4F 86 1C EE A7 8A 05 26 0F 14 00 98 60 25 99 1C ED EE 47 B4 B5 CA CA CA"

    @Test fun lms6At1680() {
        val c = Checks()
        val cf = hex(mk2a4d); val g = hex(mk2a54)
        c.eq(Mk2a.length(cf, cf.size), 66, "LMS6-1680 vector: config subframe length from its CRC")
        c.eq(Mk2a.length(g, g.size), 172, "LMS6-1680 vector: GPS subframe length from its CRC")
        val dec = Mk2aDecoder()
        c.eq(dec.parse(g, 172), null, "LMS6-1680 waits for the full serial")
        c.eq(dec.parse(cf, 66), null, "LMS6-1680 config subframe gives the serial (no report of its own)")
        val f = dec.parse(g, 172)
        c.eq(f?.serial, "LMS6-${0x006bec64}", "LMS6-1680 vector: serial")
        c.eq(f?.type, "LMS6", "LMS6-1680 vector: type")
        c.eq(f?.model, "LMS6-1680", "LMS6-1680 vector: model")
        c.eq(f?.frame, 1495, "LMS6-1680 vector: frame counter")
        c.near(f?.timeS, 429_143.995 - 4 * 86400, 1e-6, "LMS6-1680 vector: GPS time of day")
        c.eq(f?.extra?.get("GPS WEEKDAY"), "Thu", "LMS6-1680 vector: GPS weekday")
        c.near(f?.lat, 46.765379, 1e-6, "LMS6-1680 vector: latitude")
        c.near(f?.lon, -100.767403, 1e-6, "LMS6-1680 vector: longitude")
        c.near(f?.alt, 1834.302, 1e-3, "LMS6-1680 vector: altitude")
        c.near(f?.vH, hypot(1.981, -1.632), 1e-3, "LMS6-1680 vector: ground speed")
        c.near(f?.heading, 129.5, 0.1, "LMS6-1680 vector: heading")
        c.near(f?.climb, 3.816, 1e-3, "LMS6-1680 vector: climb")
        c.eq(dec.parse(g, 172), null, "LMS6-1680 repeat of the same frame is not reported twice")
        val bad = g.copyOf(); bad[20] = bad[20] xor 4
        c.eq(Mk2aDecoder().parse(bad, 172), null, "LMS6-1680 bad CRC is rejected")
        // the real subframes off the air, through the channel decoder, both polarities
        val syms = SondeSynthB.mk2aSymbols(listOf(cf.copyOf(68), cf.copyOf(68), g.copyOf(174), g.copyOf(174)))
        c.eq(syms.copyOfRange(60, 110).joinToString(""), Mk2a.HEADER, "LMS6-1680 header symbols")
        for (invert in listOf(false, true)) {
            val pol = if (invert) "inverted" else "upright"
            val out = feed(syms, 9616.0, invert = invert)
            c.eq(out.size, 1, "LMS6-1680 channel decoder, real subframes, $pol FM")
            c.eq(out.getOrNull(0)?.serial, "LMS6-${0x006bec64}", "LMS6-1680 channel decoder serial ($pol)")
        }
        // the encoder: config then GPS each second, every subframe twice
        val id = 0x00a1b2c3; val subs = ArrayList<IntArray>()
        for (k in 0 until 3) {
            val cc = SondeSynthB.mk2aConfig(id, 900 + k); val gg = SondeSynthB.mk2aGps(id, 900 + k, 5 * 86_400_000L + 7_200_000 + k * 1000, flight(k))
            subs.add(cc); subs.add(cc); subs.add(gg); subs.add(gg)
        }
        val es = SondeSynthB.mk2aSymbols(subs)
        for (invert in listOf(false, true)) {
            val pol = if (invert) "inverted" else "upright"
            val out = feed(es, 9616.0, invert = invert)
            c.eq(out.size, 3, "LMS6-1680 channel decoder, one report per frame, $pol FM")
            val ff = out.getOrNull(2); val p = flight(2)
            c.eq(ff?.serial, "LMS6-${0x00a1b2c3}", "LMS6-1680 encoder: serial")
            c.eq(ff?.frame, 902, "LMS6-1680 encoder: frame counter")
            c.near(ff?.timeS, 7200.0 + 2, 1e-6, "LMS6-1680 encoder: GPS time of day")
            c.near(ff?.lat, p.lat, 1e-6, "LMS6-1680 encoder: latitude")
            c.near(ff?.lon, p.lon, 1e-6, "LMS6-1680 encoder: longitude")
            c.near(ff?.alt, p.alt, 1e-3, "LMS6-1680 encoder: altitude")
            c.near(ff?.vH, 5.0, 1e-3, "LMS6-1680 encoder: ground speed")
            c.near(ff?.heading, 53.13, 0.01, "LMS6-1680 encoder: heading")
            c.near(ff?.climb, 5.1, 1e-3, "LMS6-1680 encoder: climb")
        }
        // a damaged GPS subframe (both copies) is dropped, the next second still decodes
        val dmg = feed(es, 9616.0, flip = listOf(4000, 6000))
        c.ok(dmg.size >= 2, "LMS6-1680 symbol errors lose at most that frame", "${dmg.size}")
        val flipAll = (2000 until 9000 step 300).toList()
        c.ok(feed(es, 9616.0, flip = flipAll).all { it.serial == "LMS6-${0x00a1b2c3}" && (it.frame ?: 0) >= 900 }, "LMS6-1680 never reports a damaged subframe")
        c.done("LMS6-1680")
    }

    private val mrzSlots = listOf(0xc to 12345678L, 0xd to 87654321L, 0xf to 141126L, 0xe to 10926L, 0x0 to 0x3f800000L, 0x1 to 0x40000000L)
    private fun mrzFrames(latlon: Boolean = false, n: Int = mrzSlots.size): List<IntArray> = List(n) { k ->
        val (slot, word) = mrzSlots[k % mrzSlots.size]
        SondeSynthB.mrzFrame(MrzOpts(slot, word, 13, 45, 10 + k, fall(k), 11, -31.25, 47.5, latlon))
    }

    @Test fun mrz() {
        val c = Checks()
        val dec = MrzDecoder()
        val fr = mrzFrames()
        c.eq(dec.parse(fr[0]), null, "MRZ waits for both serials")
        var last: SondeFrame? = null
        for (f in fr.drop(1)) last = dec.parse(f) ?: last
        val p = fall(5)
        c.eq(last?.serial, "MRZ-12345678-87654321", "MRZ serial (sonde and sensor boom)")
        c.eq(last?.type, "MRZ", "MRZ type")
        c.eq(last?.date, "2026-11-14", "MRZ date from its config slot")
        c.eq(last?.timeS, (13 * 3600 + 45 * 60 + 15).toDouble(), "MRZ UTC time of day")
        val gpsDay = LocalDate.of(2026, 11, 14).toEpochDay() - LocalDate.of(1980, 1, 6).toEpochDay()
        c.eq(last?.frame, (gpsDay * 86400 + 13 * 3600 + 45 * 60 + 15).toInt(), "MRZ frame = GPS-epoch seconds")
        c.near(last?.lat, p.lat, 1e-6, "MRZ latitude (ECEF)")
        c.near(last?.lon, p.lon, 1e-6, "MRZ longitude (ECEF)")
        c.near(last?.alt, p.alt, 0.02, "MRZ altitude (ECEF)")
        c.near(last?.vH, hypot(p.vN, p.vE), 0.02, "MRZ ground speed")
        c.near(last?.heading, (atan2(p.vE, p.vN) * 180 / PI + 360) % 360, 0.3, "MRZ heading")
        c.near(last?.climb, p.vU, 0.02, "MRZ climb")
        c.eq(last?.sats, 11, "MRZ satellites")
        c.near(last?.tempC, -31.25, 1e-9, "MRZ temperature")
        c.near(last?.rh, 47.5, 1e-9, "MRZ humidity")
        c.eq(last?.extra?.get("CALIBRATION DATE"), "010926", "MRZ calibration date")
        c.eq(dec.parse(fr[5]), null, "MRZ repeat of the same second is reported once")
        val bad = fr[5].copyOf(); bad[12] = bad[12] xor 0x10
        c.eq(MrzDecoder().parse(bad), null, "MRZ bad CRC is rejected")
        // lat/lon frames (FF FF marker, 42-byte CRC)
        val dl = MrzDecoder()
        var l: SondeFrame? = null
        for (f in mrzFrames(true)) l = dl.parse(f + intArrayOf(0xaa, 0xaa, 0xaa)) ?: l
        c.near(l?.lat, p.lat, 1e-6, "MRZ latitude (lat/lon frame)")
        c.near(l?.lon, p.lon, 1e-6, "MRZ longitude (lat/lon frame)")
        c.near(l?.alt, p.alt, 0.01, "MRZ altitude (lat/lon frame, MSL)")
        c.near(l?.vH, hypot(p.vN, p.vE), 0.01, "MRZ ground speed (lat/lon frame)")
        c.near(l?.tempC, -31.25, 1e-9, "MRZ temperature (lat/lon frame)")
        c.eq(l?.climb, null, "MRZ lat/lon frame has no climb")
        // off the air, both polarities, six copies of each frame
        val syms = SondeSynthB.mrzSymbols(fr, 6)
        c.eq(syms.copyOfRange(4 * 16 - 32, 4 * 16 + 12).joinToString(""), Mrz.HEADER, "MRZ header symbols")
        for (invert in listOf(false, true)) {
            val pol = if (invert) "inverted" else "upright"
            val out = feed(syms, 2399.0, invert = invert)
            c.eq(out.size, 5, "MRZ channel decoder: one report per second once the serials are in, $pol FM")
            c.eq(out.getOrNull(0)?.serial, "MRZ-12345678-87654321", "MRZ channel decoder serial ($pol)")
            c.eq(out.count { it.type != "MRZ" }, 0, "MRZ signal decodes as nothing else")
        }
        c.done("MRZ")
    }

    @Test fun noFalseDecodes() {
        val c = Checks()
        val cal = SondeSynth.rs41CalTable("RS41-SG")
        val rs41 = flat((0 until 3).map { k -> SondeSynth.rs41Symbols(SondeSynth.rs41Frame("T7654321", k, flight(k), cal, -20.0, 2400, k * 1000L)) + idle(4800 - 2560) })
        c.eq(feed(rs41, 4800.0).size, 0, "RS41 signal: nothing from bank B")
        val rs92 = flat(rs92Run(false, "P2718281", 3).map { SondeSynthB.rs92Symbols(it) })
        c.ok(feed(rs92, 4800.0).all { it.type == "RS92" }, "RS92 signal decodes as nothing else")
        val mk = SondeSynthB.mk2aSymbols(listOf(SondeSynthB.mk2aConfig(0x00a1b2c3, 1), SondeSynthB.mk2aGps(0x00a1b2c3, 1, 1000, flight(1))))
        c.ok(feed(mk, 9616.0).all { it.model == "LMS6-1680" }, "LMS6-1680 signal decodes as nothing else")
        val rng = Prng(99)
        for (baud in intArrayOf(2399, 4800, 9616)) {
            val junk = IntArray(baud * 4) { if (rng.next() < 0.5) 1 else 0 }
            c.eq(feed(junk, baud.toDouble()).size, 0, "random symbols at $baud Bd: no frames")
        }
        c.done("no false decodes")
    }

    // ---- seed sweep at 15 dB: raw IQ at 2.4 Msps through the channel filter the front end uses (11 kHz for 400 MHz,
    // 60 kHz for 1680 MHz), the discriminator and the bank, 1 kHz off center, two noise seeds, both FM polarities
    private fun channelRun(syms: IntArray, baud: Double, dev: Double, snr: Double, seed: Int, wide: Boolean, offHz: Double = 1000.0): List<SondeFrame> {
        val rate = 2_400_000.0
        val ddc = if (wide) Ddc(60_000.0, 192_000.0, 63) else Ddc(11_000.0, 48_000.0, 63)
        ddc.reset(rate); ddc.offsetHz = offHz
        val out = ArrayList<SondeFrame>(); val decs = SondeBank.makeBankB(ddc.outRate) { out.add(it) }
        val per = Math.round(baud).toInt()
        var pi = 1f; var pq = 0f
        var k = 0
        while (k * per < syms.size) {
            val iq = SondeSynth.fskIq(syms.copyOfRange(k * per, min(syms.size, (k + 1) * per)), baud, rate, 0.0, dev, snr, 0.0, Prng(seed * 1000L + k))
            val n = iq.size / 2
            val re = FloatArray(n) { ((iq[2 * it].toInt() and 0xff) - 128) / 128f }; val im = FloatArray(n) { ((iq[2 * it + 1].toInt() and 0xff) - 128) / 128f }
            val oi = FloatArray(ddc.maxOut(n)); val oq = FloatArray(ddc.maxOut(n)); val m = ddc.push(re, im, n, oi, oq)
            for (i in 0 until m) {
                val a = oi[i]; val b = oq[i]; val d = atan2((b * pi - a * pq).toDouble(), (a * pi + b * pq).toDouble())
                pi = a; pq = b
                for (x in decs) x.push(d)
            }
            k++
        }
        return out
    }

    @Test fun sweep15dB() {
        val c = Checks()
        val t0 = System.currentTimeMillis()
        fun lead(baud: Double) = idle(Math.round(baud / 10).toInt())
        val mk1680 = run {
            var mk = lead(9616.0)
            for (k in 0 until 4) {
                val cc = SondeSynthB.mk2aConfig(0x00a1b2c3, 900 + k); val gg = SondeSynthB.mk2aGps(0x00a1b2c3, 900 + k, 7_200_000L + k * 1000, flight(k))
                val sec = SondeSynthB.mk2aSymbols(listOf(cc, cc, gg, gg))
                mk = mk + sec + SondeSynthB.uartBits(IntArray((9616 - sec.size) / 10) { 0xca })
            }
            mk
        }
        class Case(val name: String, val baud: Double, val dev: Double, val wide: Boolean, val body: IntArray, val want: Int)
        val sweep = listOf(
            Case("RS92", 4800.0, 1920.0, false, lead(4800.0) + flat(rs92Run(false, "P5772156", 4).map { SondeSynthB.rs92Symbols(it) }), 4),
            Case("LMS6-403", 4800.0, 2160.0, false, lead(4800.0) + SondeSynthB.lmsSymbols(SondeSynthB.lms6Blocks(List(4) { SondeSynthB.lms6Frame(lmsOpts(it)) }, 34)), 4),
            Case("LMSX", 4797.8, 2160.0, false, lead(4800.0) + SondeSynthB.lmsSymbols(SondeSynthB.lmsxUnits(List(4) { SondeSynthB.lmsxFrame(lmsOpts(it)) })), 4),
            Case("MRZ", 2399.0, 4800.0, false, lead(2400.0) + SondeSynthB.mrzSymbols(mrzFrames(false, 6), 2), 5),
            Case("LMS6-1680", 9616.0, 40_000.0, true, mk1680, 4),
        )
        for (s in sweep) {
            // idle after the last frame too: the channel filter holds its last symbols back
            val syms = s.body + lead(s.baud)
            val got = ArrayList<Int>()
            for (seed in 1..2) for (sign in intArrayOf(1, -1)) got.add(channelRun(syms, s.baud, sign * s.dev, 15.0, seed, s.wide).size)
            c.ok(got.all { it >= s.want }, "${s.name} at 15 dB: every frame over 2 seeds x 2 polarities", "got ${got.joinToString(" ")}, want ${s.want} each")
        }
        println("  (15 dB sweep: ${"%.1f".format((System.currentTimeMillis() - t0) / 1000.0)} s)")
        c.done("15 dB sweep")
    }

    // ---- the whole receiver: FSK on raw IQ at 2.4 Msps, some hundreds of kHz off the center
    private fun iqOf(syms: IntArray, baud: Double, rate: Double, offsetHz: Double, dev: Double, snr: Double = 25.0): ByteArray {
        // a second at a time, each with its own noise (like rs41Iq in SondeTest)
        val per = Math.round(baud).toInt(); val parts = ArrayList<ByteArray>()
        var k = 0
        while (k * per < syms.size) { parts.add(SondeSynth.fskIq(syms.copyOfRange(k * per, min(syms.size, (k + 1) * per)), baud, rate, offsetHz, dev, snr, 0.0, Prng(100L + k))); k++ }
        val out = ByteArray(parts.sumOf { it.size }); var o = 0
        for (p in parts) { p.copyInto(out, o); o += p.size }
        return out
    }

    private var rxTime = 0L; private var rxSeconds = 0.0
    private fun receiver(c: Checks, what: String, band: String, centerHz: Long, offsetHz: Long, syms: IntArray, baud: Double, dev: Double, serial: String, type: String,
                         model: String?, minFrames: Int = 2, tolHz: Double = 3000.0, snr: Double = 25.0): SondeRow? {
        val notes = ArrayList<String>(); val rate = 2_400_000
        val proc = SondeProcessor(PacketLog(), Retuner(tune = {}, applied = { false }))
        proc.onNote = { notes.add(it) }
        proc.setBand(band); proc.reset(rate); proc.setCenter(centerHz - offsetHz)
        val iq = iqOf(syms, baud, rate.toDouble(), offsetHz.toDouble(), dev, snr)
        val t0 = System.currentTimeMillis()
        var o = 0
        while (o < iq.size) { val e = min(iq.size, o + 131072); val b = iq.copyOfRange(o, e); proc.onIq(b, b.size, rate); o = e }
        rxTime += System.currentTimeMillis() - t0; rxSeconds += iq.size / 2.0 / rate
        val rows = proc.tracker.rows(System.currentTimeMillis())
        // the tracker drops a family prefix the card already shows ("LMS6-1193046" -> "1193046")
        val shown = if (serial.startsWith("$type-")) serial.substring(type.length + 1) else serial
        val s = rows.firstOrNull { it.serial == shown }
        c.ok(s != null, "$what through the receiver", "rows ${rows.joinToString(",") { it.serial }}; log ${notes.joinToString(" | ")}")
        c.eq(s?.type, type, "$what receiver row type")
        if (model != null) c.eq(s?.model, model, "$what receiver row model")
        c.ok((s?.frames ?: 0) >= minFrames, "$what several frames through the receiver", "frames ${s?.frames}")
        c.near(s?.hz?.toDouble(), centerHz.toDouble(), tolHz, "$what channel frequency")
        return s
    }

    @Test fun throughTheReceiver() {
        val c = Checks()
        // RS92-SGP: 5 frames, 1 s each
        val rs = flat(rs92Run(false, "P1618033", 5).map { SondeSynthB.rs92Symbols(it) })
        receiver(c, "RS92", "400", 402_150_000, 310_000, rs, 4800.0, 1920.0, "P1618033", "RS92", null)
        // LMS6-403: 6 frames across 7 blocks
        val l6 = SondeSynthB.lmsSymbols(SondeSynthB.lms6Blocks(List(6) { SondeSynthB.lms6Frame(lmsOpts(it)) }, 34))
        val r6 = receiver(c, "LMS6-403", "400", 403_400_000, -270_000, l6, 4800.0, 2160.0, "LMS6-${0x123456}", "LMS6", "LMS6-403")
        c.ok(r6?.lat != null, "LMS6-403 receiver row has a position")
        // LMSX: 5 units
        val lx = SondeSynthB.lmsSymbols(SondeSynthB.lmsxUnits(List(5) { SondeSynthB.lmsxFrame(lmsOpts(it)) }))
        receiver(c, "LMSX", "400", 404_800_000, 420_000, lx, 4797.8, 2160.0, "LMSX-${0x123456}", "LMS6", "LMSX")
        // MRZ: the slot cycle twice, two copies each
        val mz = SondeSynthB.mrzSymbols(mrzFrames(false, 12), 2)
        receiver(c, "MRZ", "400", 401_500_000, -350_000, mz, 2399.0, 4800.0, "MRZ-12345678-87654321", "MRZ", null)
        // LMS6-1680 at 1680 MHz, ±40 kHz: config + GPS twice a second, idle CA to fill the second. A carrier this wide is
        // first found up to ~40 kHz off (the spectrum's centroid) and the channel's AFC walks it in over a few seconds, so
        // 10 s, at least half the frames, and the frequency within ±15 kHz
        val subs = ArrayList<IntArray>()
        for (k in 0 until 10) { val cc = SondeSynthB.mk2aConfig(0x00a1b2c3, 900 + k); val gg = SondeSynthB.mk2aGps(0x00a1b2c3, 900 + k, 7_200_000L + k * 1000, flight(k)); subs.add(cc); subs.add(cc); subs.add(gg); subs.add(gg) }
        var mk = IntArray(0)
        for (k in 0 until 10) { val sec = SondeSynthB.mk2aSymbols(subs.subList(4 * k, 4 * k + 4)); mk = mk + sec + SondeSynthB.uartBits(IntArray((9616 - sec.size) / 10) { 0xca }) }
        receiver(c, "LMS6-1680", "1680", 1_680_000_000, 260_000, mk, 9616.0, 40_000.0, "LMS6-${0x00a1b2c3}", "LMS6", "LMS6-1680", minFrames = 5, tolHz = 15_000.0)
        println("  (receiver: ${"%.1f".format(rxTime / 1000.0)} s for ${"%.1f".format(rxSeconds)} s of 2.4 Msps over 5 types)")
        c.done("through the receiver")
    }
}
