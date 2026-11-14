package com.rocketgod.mayhem.core.sonde

import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.apps.Retuner
import com.rocketgod.mayhem.core.sonde.SondeSynth.Prng
import com.rocketgod.mayhem.core.sonde.SondeSynthC.ImetData
import com.rocketgod.mayhem.core.sonde.SondeSynthC.Imet54Data
import com.rocketgod.mayhem.core.sonde.SondeSynthC.MeiseiData
import com.rocketgod.mayhem.core.trains.Ddc
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.min

/**
 * Sondes, bank C (the twin of web/test/sonde-c.mjs): InterMet iMet-1-RSB / iMet-4 (Bell 202 AFSK on FM), InterMet
 * iMet-54 / iMet-50 and Meisei iMS-100 / RS-11G. Frames built the way each sonde builds them go through the frame
 * decoders (CRCs, Hamming and BCH repair, both FM polarities), the 15 dB noise sweeps through the receiver's own
 * channel filter, then all three types on raw IQ through the whole receiver.
 */
class SondeBankCTest {
    private class Checks {
        var pass = 0; val fails = ArrayList<String>()
        fun ok(c: Boolean, what: String, extra: String = "") { if (c) pass++ else fails.add(what + if (extra.isNotEmpty()) " — $extra" else "") }
        fun near(a: Double?, b: Double, tol: Double, what: String) = ok(a != null && abs(a - b) <= tol, what, "got $a, want $b ± $tol")
        fun eq(a: Any?, b: Any?, what: String) = ok(a == b, what, "got $a, want $b")
        fun done(name: String) { println("  $name: $pass passed, ${fails.size} failed"); assertTrue(fails.joinToString("\n"), fails.isEmpty()) }
    }

    private val ch = 48_000.0
    private fun signed(b: Byte) = (b.toInt() and 0xff) - 128
    /** The FM discriminator (radians per sample) of offset-128 IQ, as the receiver's channel computes it; [sign] -1 flips polarity. */
    private fun disc(iq: ByteArray, sign: Int = 1): FloatArray {
        val n = iq.size shr 1; val out = FloatArray(n)
        var pi = 1.0; var pq = 0.0
        for (i in 0 until n) {
            val a = signed(iq[2 * i]).toDouble(); val b = signed(iq[2 * i + 1]).toDouble()
            out[i] = (sign * atan2(b * pi - a * pq, a * pi + b * pq)).toFloat()
            pi = a; pq = b
        }
        return out
    }
    private fun concat(parts: List<ByteArray>): ByteArray {
        val o = ByteArray(parts.sumOf { it.size }); var k = 0
        for (p in parts) { p.copyInto(o, k); k += p.size }
        return o
    }
    private fun bankDec(name: String, sink: SondeSink) = SondeBank.makeBankC(ch, sink).first { it.name == name }
    private fun sha(s: String): String {
        val h = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.US_ASCII))
        return "IMET-" + h.joinToString("") { "%02X".format(it.toInt() and 0xff) }.takeLast(8)
    }
    private fun idle(n: Int) = IntArray(n) { it and 1 }

    // ---------------------------------------------------------------- iMet-1 / iMet-4
    /** 2026-11-14 15:00:00 UTC. */
    private val now = 1_794_668_400_000L
    private val day = 1_794_614_400_000L
    private fun imetData(k: Int) = ImetData(frame = 1000 + k, hPa = 850.25, tempC = -12.34, rh = 56.78, battV = 5.6,
        lat = 35.12345 + k * 1e-4, lon = -97.4321 - k * 1e-4, alt = 1500.0 + 5 * k, sats = 9, timeS = 50_000.0 + k,
        vE = 3.0, vN = 4.0, vU = 5.25, ext = doubleArrayOf(21.5, -3.25, -11.75))

    @Test fun imetFrames() {
        val c = Checks()
        c.eq(Imet.crc(IntArray(9) { "123456789"[it].code }, 0, 9), 0xe5cc, "iMet CRC-16/AUG-CCITT check value")

        // iMet-4: frame counter once a second; the first frame is held back to tell iMet-1 from iMet-4
        val got = ArrayList<SondeFrame>()
        val dec = ImetDecoder(ch) { got.add(it) }
        dec.hz = 402_012_000; dec.clock = { now }
        val b0 = SondeSynthC.imetBurst(imetData(0)); val b1 = SondeSynthC.imetBurst(imetData(1).copy(xdata = intArrayOf(0x01, 0x07, 0x12, 0x34, 0x09, 0xc4, 0x50, 0x0e)))
        c.eq(dec.parseBurst(b0, b0.size), null, "iMet first frame held back (model decision)")
        val f = dec.parseBurst(b1, b1.size)
        c.eq(f?.type, "iMet", "iMet type")
        c.eq(f?.model, "iMet-4", "iMet-4 from the counter rate")
        val powerOn = day + (50_001 - 1001) * 1000L
        val want = sha(Imet.isoSeconds(powerOn) + "402.000 MHz" + "SONDE")
        c.eq(f?.serial, want, "iMet-4 ID = auto_rx SHA-256(power-on time + frequency)")
        c.eq(Imet.uniqueId(powerOn, 402_012_000), want, "iMet ID helper")
        c.eq(f?.frame, 1001, "iMet frame counter")
        c.near(f?.lat, 35.12355, 1e-5, "iMet latitude")
        c.near(f?.lon, -97.4322, 1e-5, "iMet longitude")
        c.eq(f?.alt, 1505.0, "iMet altitude")
        c.eq(f?.sats, 9, "iMet satellites")
        c.eq(f?.timeS, 50_001.0, "iMet GPS time of day")
        c.near(f?.vH, 5.0, 1e-5, "iMet ground speed (eGPS)")
        c.near(f?.heading, 36.87, 0.01, "iMet heading (eGPS)")
        c.near(f?.climb, 5.25, 1e-5, "iMet climb (eGPS, CRC at its real offset 0x1C)")
        c.near(f?.tempC, -12.34, 1e-9, "iMet temperature")
        c.near(f?.rh, 56.78, 1e-9, "iMet humidity")
        c.near(f?.hPa, 850.25, 1e-9, "iMet pressure")
        c.near(f?.battV, 5.6, 1e-9, "iMet battery")
        c.near(f?.tHumC, -11.75, 1e-9, "iMet humidity-sensor temperature (ePTU)")
        c.eq(f?.extra?.get("AUX"), "ozone (ECC)", "iMet XDATA instrument")
        c.eq(f?.extra?.get("AUX DATA"), "01071234" + "09C4500E", "iMet XDATA payload")
        c.eq(got.size, 1, "iMet sink got the frame")
        // same sonde, next second: same ID
        val b2 = SondeSynthC.imetBurst(imetData(2))
        c.eq(dec.parseBurst(b2, b2.size)?.serial, want, "iMet ID stable frame to frame")
        // CRC: a damaged PTU packet means no report; a damaged GPS packet means no position
        val bad = b2.copyOf(); bad[30 + 8] = bad[30 + 8] xor 0x10
        c.eq(dec.parseBurst(bad, bad.size), null, "iMet damaged PTU rejected (CRC)")
        val badG = SondeSynthC.imetBurst(imetData(3)); badG[5] = badG[5] xor 0x01
        val g = ImetDecoder(ch) {}; g.clock = { now }
        val fg = g.parseBurst(badG, badG.size)
        c.ok(fg != null && fg.lat == null, "iMet damaged GPS packet: PTU only, no position")
        // plain GPS + plain PTU packets
        val plain = ImetDecoder(ch) {}; plain.clock = { now }; plain.hz = 403_500_000
        fun pb(k: Int) = SondeSynthC.imetBurst(imetData(k).copy(vE = null, ext = null))
        plain.parseBurst(pb(0), pb(0).size)
        val fp = plain.parseBurst(pb(1), pb(1).size)
        c.near(fp?.alt, 1505.0, 0.0, "iMet plain GPS packet")
        c.eq(fp?.climb, null, "iMet plain GPS has no velocity")
        c.eq(fp?.serial, sha(Imet.isoSeconds(powerOn) + "403.500 MHzSONDE"), "iMet ID with the other frequency")

        // iMet-1: the counter runs twice a second
        val d1 = ImetDecoder(ch) {}; d1.clock = { now }; d1.hz = 402_012_000
        fun i1(k: Int) = SondeSynthC.imetBurst(imetData(k).copy(frame = 400 + 2 * k))
        d1.parseBurst(i1(0), i1(0).size)
        val f1 = d1.parseBurst(i1(1), i1(1).size)
        c.eq(f1?.model, "iMet-1-RSB", "iMet-1 from the counter rate")
        c.eq(f1?.serial, sha(Imet.isoSeconds(day + (50_001 - 201) * 1000L) + "402.000 MHzSONDE"), "iMet-1 ID (counter / 2)")
        // no GPS lock: frequency-only ID, no position
        val nl = ImetDecoder(ch) {}; nl.hz = 402_012_000
        val bn = SondeSynthC.imetBurst(imetData(0).copy(sats = 2))
        val fn = nl.parseBurst(bn, bn.size)
        c.eq(fn?.serial, sha("402.000 MHzSONDE"), "iMet without lock: ID from the frequency alone")
        c.eq(fn?.lat, null, "iMet without lock: no position")

        // the tone demodulator: AFSK on FM, both FM polarities
        for (sign in intArrayOf(1, -1)) {
            val out = ArrayList<SondeFrame>()
            val d = ImetDecoder(ch) { out.add(it) }; d.clock = { now }; d.hz = 402_012_000
            val iq = concat((0..2).map { k -> SondeSynthC.afskFmIq(SondeSynthC.imetLineBits(SondeSynthC.imetBurst(imetData(k)), 30, 600), ch, 1500.0 * sign, 4000.0, 22.0, 0.02, Prng(20L + k)) })
            for (v in disc(iq, sign)) d.push(v.toDouble())
            val pol = if (sign > 0) "normal" else "inverted"
            c.eq(out.size, 2, "iMet AFSK on FM, $pol polarity: frames")
            c.eq(out.getOrNull(0)?.serial, want, "iMet AFSK on FM, $pol: ID")
            c.eq(out.getOrNull(1)?.frame, 1002, "iMet AFSK on FM, $pol: frame")
            c.near(out.getOrNull(1)?.climb, 5.25, 1e-5, "iMet AFSK on FM, $pol: climb")
        }
        c.done("iMet-1 / iMet-4")
    }

    // ---------------------------------------------------------------- iMet-54
    private fun i54(k: Int) = Imet54Data(serial = 55064506, timeS = 41718.0 + k, lat = -25.91298 - k * 1e-5, lon = 28.20926, alt = 2627.3 + 8 * k,
        tempC = 14.9, rh = 69.73, tRh = 15.53)

    @Test fun imet54Frames() {
        val c = Checks()
        val dec = Imet54Decoder()
        val fr = SondeSynthC.imet54Frame(i54(0))
        val f = dec.parse(fr)
        c.eq(f?.type, "iMet-54", "iMet-54 type")
        c.eq(f?.model, "iMet-54", "iMet-54 model")
        c.eq(f?.serial, "55064506", "iMet-54 serial")
        c.eq(f?.timeS, 41718.0, "iMet-54 time")
        c.eq(f?.frame, 41718, "iMet-54 frame = seconds of day")
        c.near(f?.lat, -25.91298, 2e-6, "iMet-54 latitude")
        c.near(f?.lon, 28.20926, 2e-6, "iMet-54 longitude")
        c.near(f?.alt, 2627.3, 0.05, "iMet-54 altitude")
        c.near(f?.tempC, 14.9, 1e-4, "iMet-54 temperature")
        c.near(f?.tHumC, 15.53, 1e-4, "iMet-54 humidity-sensor temperature")
        c.near(f?.rh, 69.73 * 1.0412, 0.3, "iMet-54 humidity corrected to air temperature")
        c.eq(f?.extra?.get("CRC"), "frame", "iMet-54 whole-frame CRC")
        // through the symbols: Hamming code, interleave, 8N1
        val syms = SondeSynthC.imet54Symbols(fr)
        val hdrAt = syms.joinToString("").indexOf(Imet54.HEADER, 18 * 10)
        c.eq(hdrAt, 18 * 10, "iMet-54 header in the preamble")
        val soft = FloatArray(2200) { if (syms[hdrAt + 40 + it] != 0) 1f else -1f }
        val fs = Imet54Decoder().decode(soft)
        c.eq(fs?.serial, "55064506", "iMet-54 from symbols")
        c.eq(fs?.fixed, 0, "iMet-54 clean")
        // one wrong bit in each of 40 codewords: repaired
        val dmg = soft.copyOf()
        for (k in 0 until 40) { val gg = 3 + 8 * (k % 27) + (k shr 3) % 8; val j = k % 8; dmg[gg * 10 + 1 + j] *= -1f }
        val fd = Imet54Decoder().decode(dmg)
        c.eq(fd?.serial, "55064506", "iMet-54 Hamming repairs one bit per codeword")
        c.eq(fd?.fixed, 40, "iMet-54 reports repaired codewords")
        // two wrong bits in one codeword: detected, the CRC then rejects the frame
        val two = soft.copyOf()
        two[(3 + 8 * 2 + 0) * 10 + 1 + 2] *= -1f; two[(3 + 8 * 2 + 1) * 10 + 1 + 2] *= -1f
        c.eq(Imet54Decoder().decode(two), null, "iMet-54 double error in a codeword: rejected")
        val crcBad = fr.copyOf(); crcBad[0x1d] = crcBad[0x1d] xor 0x04
        c.eq(dec.parse(crcBad), null, "iMet-54 damaged frame rejected (CRC)")
        // the newer firmware's CRC over the first 52 bytes alone
        val fc = SondeSynthC.imet54Frame(i54(0).copy(cont = true))
        c.eq(dec.parse(fc)?.extra?.get("CRC"), "both", "iMet-54 both CRCs")
        val contOnly = fc.copyOf(); contOnly[0x40] = contOnly[0x40] xor 0xff
        c.eq(dec.parse(contOnly)?.extra?.get("CRC"), "first 52 bytes", "iMet-54 first-52-byte CRC alone accepted")
        val contBad = contOnly.copyOf(); contBad[0x10] = contBad[0x10] xor 1
        c.eq(dec.parse(contBad), null, "iMet-54 both CRCs failing: rejected")
        // iMet-50: GPS only, PTU sensors absent
        val f50 = dec.parse(SondeSynthC.imet54Frame(i54(0).copy(tempC = null, rh = null, tRh = null, status = 0x0030)))
        c.eq(f50?.model, "iMet-50", "iMet-50 recognized")
        c.eq(f50?.tempC, null, "iMet-50 no temperature")
        c.near(f50?.alt, 2627.3, 0.05, "iMet-50 altitude")
        c.eq(dec.parse(SondeSynthC.imet54Frame(i54(0).copy(status = 0x000e))), null, "iMet-54 without GPS status rejected")

        // the real frame from imet54.txt (its first 44 bytes; zeros after, the CRCs computed over that)
        val real = IntArray(108)
        intArrayOf(0x03, 0x48, 0x37, 0xBA, 0x06, 0xC4, 0x25, 0xB0, 0xFE, 0x7A, 0x2B, 0xF6, 0x01, 0xAD, 0x29, 0x71, 0x00, 0x00, 0x66, 0xA1,
            0, 0, 0, 0, 0, 0, 0, 0, 0x41, 0x6E, 0x81, 0x4E, 0x42, 0x8B, 0x74, 0x18, 0x41, 0x78, 0x83, 0x80, 0x62, 0x10, 0x00, 0x3E).copyInto(real)
        SondeSynthC.imet54SetStd(real)
        val fr0 = dec.parse(real)
        c.eq(fr0?.serial, "55064506", "iMet-54 real frame: serial")
        c.eq(fr0?.timeS, (11 * 3600 + 35 * 60 + 18).toDouble(), "iMet-54 real frame: 11:35:18")
        c.near(fr0?.lat, -25.91298, 5e-6, "iMet-54 real frame: latitude")
        c.near(fr0?.lon, 28.20926, 1e-5, "iMet-54 real frame: longitude")
        c.near(fr0?.alt, 2627.3, 0.01, "iMet-54 real frame: altitude")
        c.near(fr0?.tempC, 14.9, 0.05, "iMet-54 real frame: temperature")
        c.eq(fr0?.rh?.let { Math.round(it) }, 73L, "iMet-54 real frame: humidity 73%")

        // on the FM channel, both polarities
        for (sign in intArrayOf(1, -1)) {
            val out = ArrayList<SondeFrame>()
            val d = bankDec("iMet-54") { out.add(it) }
            val iq = concat((0..1).map { k -> SondeSynth.fskIq(SondeSynthC.imet54Symbols(SondeSynthC.imet54Frame(i54(k))) + idle(400), 4800.0, ch, 0.0, 1920.0 * sign, 30.0, 0.02, Prng(40L + k)) })
            for (v in disc(iq)) d.push(v.toDouble())
            val pol = if (sign > 0) "normal" else "inverted"
            c.eq(out.size, 2, "iMet-54 on FM, $pol polarity: frames")
            c.eq(out.getOrNull(1)?.serial, "55064506", "iMet-54 on FM, $pol: serial")
            c.near(out.getOrNull(1)?.alt, 2635.3, 0.05, "iMet-54 on FM, $pol: altitude")
        }
        c.done("iMet-54")
    }

    // ---------------------------------------------------------------- Meisei
    private fun msFlight(c: Int, tRaw: Int = 0, uRaw: Int = 0) = MeiseiData(lat = 35.6812 + c * 1e-5, lon = 139.7671 + c * 2e-5, alt = 1234.56 + c, vH = 7.5,
        heading = 271.25, climb = 5.2, timeS = 3 * 3600 + 4 * 60 + c / 2.0, year = 2026, month = 11, day = 14, tRaw = tRaw, uRaw = uRaw, fRef = 60000)

    private fun meiseiRun(model: String, c0: Int, n: Int, tempC: Double, rhWant: Double, dmg: ((IntArray, Int) -> Unit)? = null): List<SondeFrame> {
        val cfg = SondeSynthC.meiseiCfg(model, 412345, 403_500)
        val d = MeiseiDecoder(); d.refYear = 2026
        val outs = ArrayList<SondeFrame>()
        for (c in c0 until c0 + n) {
            val fRef = 60000
            val fd = msFlight(c, SondeSynthC.meiseiTRaw(model, cfg, tempC, fRef), Math.round(rhWant / 100 * fRef).toInt())
            val b = SondeSynthC.meiseiFrame(model, c, fd, cfg)
            dmg?.invoke(b, c)
            d.parse(b)?.let { outs.add(it) }
        }
        return outs
    }

    @Test fun meiseiFrames() {
        val c = Checks()
        // BCH(46,34): random blocks, up to two wrong bits repaired; parity bits are odd
        val rng = Prng(5)
        var good = 0; var caught = 0
        for (t in 0 until 300) {
            val blk = IntArray(46); val a = (rng.next() * 65536).toInt(); val bb = (rng.next() * 65536).toInt()
            Meisei.block(a, bb, blk, 0)
            val ref = blk.copyOf(); val ne = t % 3
            val used = LinkedHashSet<Int>(); while (used.size < ne) used.add((rng.next() * 46).toInt())
            for (p in used) blk[p] = blk[p] xor 1
            if (Meisei.blockFix(blk, 0) == ne && blk.contentEquals(ref)) good++
            // three wrong bits: never handed back as the original
            val b3 = ref.copyOf(); val u3 = LinkedHashSet<Int>(); while (u3.size < 3) u3.add((rng.next() * 46).toInt())
            for (p in u3) b3[p] = b3[p] xor 1
            if (Meisei.blockFix(b3, 0) < 0 || !b3.contentEquals(ref)) caught++
        }
        c.eq(good, 300, "Meisei BCH(46,34) repairs up to 2 bits")
        c.eq(caught, 300, "Meisei BCH beyond 2 bits never passes as the original")
        c.near(Meisei.f32e2(Meisei.toF32e2(-12.375)), -12.375, 0.0, "RS-11G float format round trip")
        // biphase-S: the encoder's 0x049DCE is the header (or its inverse)
        val hb = IntArray(24) { (0x049dce shr (23 - it)) and 1 }
        val raw = SondeSynthC.BiphaseS().encode(hb).joinToString("")
        val inv = Meisei.HEADER.map { if (it == '1') '0' else '1' }.joinToString("")
        c.ok(raw == Meisei.HEADER || raw == inv, "Meisei header is biphase-S 0x049DCE", raw)

        for (model in listOf("iMS-100", "RS-11G")) {
            val outs = meiseiRun(model, 0, 130, -23.4, 42.0)
            val f = outs.lastOrNull()
            c.eq(outs.size, 65, "$model: one report per frame pair")
            c.eq(f?.type, "MEISEI", "$model type")
            c.eq(f?.model, model, "$model model from word 7")
            c.eq(f?.serial, "412345", "$model serial from the config table")
            c.eq(f?.frame, 128, "$model frame counter")
            c.near(f?.lat, 35.6812 + 128e-5, 2e-6, "$model latitude")
            c.near(f?.lon, 139.7671 + 256e-5, 2e-6, "$model longitude")
            c.near(f?.alt, 1234.56 + 128, 0.006, "$model altitude")
            c.near(f?.vH, 7.5, 0.01, "$model ground speed")
            c.near(f?.heading, 271.25, 0.006, "$model heading")
            c.near(f?.climb, 5.2, 0.06, "$model climb")
            c.near(f?.tempC, -23.4, 0.05, "$model temperature from the calibration table")
            c.near(f?.rh, 42.0, 0.01, "$model humidity")
            c.eq(f?.txKHz, 403_500, "$model reported frequency")
            c.eq(f?.date, "2026-11-14", "$model date")
            c.near(f?.timeS, 3 * 3600 + 4 * 60 + (if (model == "iMS-100") 64.0 else 64.5), 0.001, "$model time")
            c.eq(f?.fixed, 0, "$model clean")
            c.eq(f?.extra?.get("CALIBRATION"), "64/64", "$model whole config table")
            // two wrong bits in every block of both subframes: repaired (RS-11G trusts single-bit repairs only)
            // (iMS-100 keeps a config word only when its blocks needed at most one repair, like the reference decoder)
            fun nb(k: Int) = if (model == "iMS-100") (if (k < 2) 1 else 2) else 1
            val rep = meiseiRun(model, 32, 4, -23.4, 42.0) { b, _ ->
                for (k in 0 until 12) for (e in 0 until nb(k)) { val p = 300 * (if (k >= 6) 1 else 0) + 24 + 46 * (k % 6) + 5 + 20 * e; b[p] = b[p] xor 1 }
            }
            var want = 0; for (k in 0 until 12) want += nb(k)
            c.eq(rep.size, 2, "$model: BCH repairs ${if (model == "iMS-100") "two bits" else "a bit"} in every block")
            c.eq(rep.getOrNull(1)?.fixed, want, "$model reports repaired bits")
            c.near(rep.getOrNull(1)?.lat, 35.6812 + 34e-5, 2e-6, "$model repaired latitude")
            // three wrong bits in subframe 0's first block: the frame is dropped
            val drop = meiseiRun(model, 32, 4, -23.4, 42.0) { b, cc -> if (cc == 34) for (p in intArrayOf(3, 9, 30)) b[24 + p] = b[24 + p] xor 1 }
            c.eq(drop.size, 1, "$model: an unrepairable block drops its frame")
        }
        // iMS-100: the GPS checksum guards the position
        val outs = meiseiRun("iMS-100", 32, 4, 0.0, 10.0) { b, cc ->
            if (cc == 34) {
                val w = IntArray(2) { j -> var v = 0; for (k in 0 until 16) v = (v shl 1) or b[300 + 24 + 46 * 5 + 17 * j + k]; v }
                Meisei.block(w[0], (w[1] + 1) and 0xffff, b, 300 + 24 + 46 * 5)
            }
        }
        c.eq(outs.size, 1, "iMS-100 bad GPS checksum: that report is dropped")
        c.eq(outs.getOrNull(0)?.frame, 32, "iMS-100 the good pair still reports")
        // on the FM channel, both polarities (biphase-S does not care, the framer finds either header sign)
        for (sign in intArrayOf(1, -1)) {
            val out = ArrayList<SondeFrame>()
            val d = bankDec("MEISEI") { out.add(it) }
            val cfg = SondeSynthC.meiseiCfg("iMS-100", 412345, 403_500); val bp = SondeSynthC.BiphaseS()
            val raw2 = ArrayList<Int>()
            for (cc in 30 until 40) raw2.addAll(bp.encode(SondeSynthC.meiseiFrame("iMS-100", cc, msFlight(cc, 20000, 3000), cfg)).toList())
            for (v in disc(SondeSynth.fskIq(raw2.toIntArray(), 2400.0, ch, 0.0, 2400.0 * sign, 30.0, 0.02, Prng(60)))) d.push(v.toDouble())
            val pol = if (sign > 0) "normal" else "inverted"
            c.ok(out.size >= 3, "Meisei on FM, $pol polarity: reports", "${out.size}")
            c.eq(out.getOrNull(0)?.serial, "412345", "Meisei on FM, $pol: serial")
            c.eq(out.getOrNull(0)?.frame, 32, "Meisei on FM, $pol: frame")
            c.near(out.getOrNull(0)?.alt, 1234.56 + 32, 0.006, "Meisei on FM, $pol: altitude")
        }
        c.done("Meisei")
    }

    // ---------------------------------------------------------------- noise margin: 15 dB, five seeds, both polarities
    /** IQ at 192 kHz through the receiver's own channel filter (Ddc, 11 kHz) and discriminator. */
    private fun channel(iq: ByteArray, rate: Double, sign: Int): Pair<FloatArray, Double> {
        val ddc = Ddc(11_000.0, 48_000.0, 63); ddc.reset(rate); ddc.offsetHz = 0.0
        val n = iq.size shr 1
        val re = FloatArray(n) { signed(iq[2 * it]) / 128f }; val im = FloatArray(n) { signed(iq[2 * it + 1]) / 128f }
        val oi = FloatArray(ddc.maxOut(n)); val oq = FloatArray(ddc.maxOut(n))
        val k = ddc.push(re, im, n, oi, oq); val x = FloatArray(k)
        var pi = 1f; var pq = 0f
        for (i in 0 until k) { x[i] = (sign * atan2((oq[i] * pi - oi[i] * pq).toDouble(), (oi[i] * pi + oq[i] * pq).toDouble())).toFloat(); pi = oi[i]; pq = oq[i] }
        return x to ddc.outRate
    }

    @Test fun noiseMargin15dB() {
        val c = Checks()
        val r = 192_000.0; val snr = 15.0
        val gen: Map<String, (Int) -> ByteArray> = linkedMapOf(
            "iMet" to { seed -> concat((0 until 11).map { k ->
                val b = SondeSynthC.imetLineBits(SondeSynthC.imetBurst(imetData(k)), 30, 0); while (b.size < 1200) b.add(1)
                SondeSynthC.afskFmIq(b, r, 0.0, 4000.0, snr, 0.0, Prng(seed * 31L + k)) }) },
            "iMet-54" to { seed -> concat((0 until 10).map { k ->
                val s = SondeSynthC.imet54Symbols(SondeSynthC.imet54Frame(i54(k)))
                SondeSynth.fskIq(idle(1200) + s + idle(3600 - s.size), 4800.0, r, 0.0, 1920.0, snr, 0.0, Prng(seed * 31L + k)) }) },
            "MEISEI" to { seed ->
                val cfg = SondeSynthC.meiseiCfg("iMS-100", 412345, 403_500); val bp = SondeSynthC.BiphaseS(); val raw = ArrayList<Int>()
                for (cc in 30 until 52) raw.addAll(bp.encode(SondeSynthC.meiseiFrame("iMS-100", cc, msFlight(cc, 20000, 3000), cfg)).toList())
                SondeSynth.fskIq(raw.toIntArray(), 2400.0, r, 0.0, 2400.0, snr, 0.05, Prng(seed.toLong())) },
        )
        for ((t, mk) in gen) {
            val counts = ArrayList<Int>()
            for (sign in intArrayOf(1, -1)) for (seed in 1..5) {
                val out = ArrayList<SondeFrame>()
                val (x, rate) = channel(mk(seed), r, sign)
                val d = SondeBank.makeBankC(rate) { out.add(it) }.first { it.name == t }
                d.hz = 402_000_000
                for (v in x) d.push(v.toDouble())
                counts.add(out.size)
            }
            c.ok(counts.all { it == 10 }, "$t at ${snr.toInt()} dB: 10 of 10 frames, 5 seeds, both polarities", counts.joinToString(" "))
        }
        c.done("15 dB noise margin")
    }

    // ---------------------------------------------------------------- the whole receiver: all three on raw IQ at 2.4 Msps
    @Test fun threeSondesThroughTheReceiver() {
        val c = Checks()
        val rate = 2_400_000; val secs = 6; val center = 402_500_000L
        val parts = ArrayList<ByteArray>()
        // iMet-4 at 402.150 MHz: one burst a second, idle mark between
        parts.add(concat((0 until secs).map { k ->
            val bits = SondeSynthC.imetLineBits(SondeSynthC.imetBurst(imetData(k)), 30, 0); while (bits.size < 1200) bits.add(1)
            SondeSynthC.afskFmIq(bits, rate.toDouble(), -350_000.0, 4000.0, 25.0, 0.0, Prng(100L + k), 40.0) }))
        // iMet-54 at 402.750 MHz: one frame a second
        parts.add(concat((0 until secs).map { k ->
            val s = SondeSynthC.imet54Symbols(SondeSynthC.imet54Frame(i54(k)))
            SondeSynth.fskIq(s + idle(4800 - s.size), 4800.0, rate.toDouble(), 250_000.0, 1920.0, 25.0, 0.0, Prng(200L + k), 40.0) }))
        // iMS-100 at 403.000 MHz: continuous, two frames a second
        run {
            val cfg = SondeSynthC.meiseiCfg("iMS-100", 412345, 403_000); val bp = SondeSynthC.BiphaseS()
            parts.add(concat((44 until 44 + 2 * secs).map { cc ->
                SondeSynth.fskIq(bp.encode(SondeSynthC.meiseiFrame("iMS-100", cc, msFlight(cc, 20000, 3000), cfg)), 2400.0, rate.toDouble(), 500_000.0, 2400.0, 25.0, 0.0, Prng(300L + cc), 40.0) }))
        }
        val n = parts.minOf { it.size }
        val iq = ByteArray(n) { i -> (max(-127, min(127, signed(parts[0][i]) + signed(parts[1][i]) + signed(parts[2][i]))) + 128).toByte() }
        val notes = ArrayList<String>()
        val proc = SondeProcessor(PacketLog(), Retuner(tune = {}, applied = { false }))
        proc.onNote = { notes.add(it) }
        proc.setBand("400"); proc.reset(rate); proc.setCenter(center)
        val t0 = System.currentTimeMillis()
        var o = 0
        while (o < iq.size) { val e = min(iq.size, o + 131072); val b = iq.copyOfRange(o, e); proc.onIq(b, b.size, rate); o = e }
        val wall = (System.currentTimeMillis() - t0) / 1000.0
        val rows = proc.tracker.rows(System.currentTimeMillis())
        val log = "rows ${rows.joinToString(",") { "${it.type}/${it.model}/${it.serial}@${it.hz}" }}; log ${notes.joinToString(" | ")}"
        val im = rows.firstOrNull { it.type == "iMet" }; val i5 = rows.firstOrNull { it.type == "iMet-54" }; val me = rows.firstOrNull { it.type == "MEISEI" }
        c.ok(im != null && Regex("^IMET-[0-9A-F]{8}$").matches(im.serial), "iMet-4 through the receiver", log)
        c.eq(im?.model, "iMet-4", "iMet-4 model through the receiver")
        c.near(im?.hz?.toDouble(), 402_150_000.0, 3000.0, "iMet-4 channel frequency")
        c.eq(i5?.serial, "55064506", "iMet-54 through the receiver")
        c.ok((i5?.frames ?: 0) >= 3, "iMet-54 several frames through the receiver", "frames ${i5?.frames}")
        c.eq(me?.serial, "412345", "iMS-100 through the receiver")
        c.eq(me?.model, "iMS-100", "iMS-100 model through the receiver")
        c.ok((me?.frames ?: 0) >= 3, "iMS-100 several frames through the receiver", "frames ${me?.frames}")
        println("  (receiver: ${"%.1f".format(wall)} s for $secs s of 2.4 Msps, three sondes)")
        c.done("three sondes through the receiver")
    }

}
