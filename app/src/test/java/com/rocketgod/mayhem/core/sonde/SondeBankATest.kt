package com.rocketgod.mayhem.core.sonde

import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.apps.Retuner
import com.rocketgod.mayhem.core.sonde.SondeSynth.FlightPoint
import com.rocketgod.mayhem.core.sonde.SondeSynthA.DfmKind
import com.rocketgod.mayhem.core.sonde.SondeSynthA.DfmOptions
import com.rocketgod.mayhem.core.sonde.SondeSynthA.M10Options
import com.rocketgod.mayhem.core.sonde.SondeSynthA.M20Options
import com.rocketgod.mayhem.core.sonde.SondeSynthA.Mts01Options
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.min

/**
 * Sondes, bank A (the twin of web/test/sonde-a.mjs and SondeTestA.swift): Graw DFM-06/09/17/PS-15, Meteomodem
 * M10/M10+/M2K2/M20 and Meteosis MTS01. Frames built the way each sonde builds them, through the frame decoders;
 * reference vectors from the spec so the encoder and decoder can't be wrong together; damage rejected or repaired; both
 * FM polarities through the channel decoders; no cross-type false decodes; then every type at once on raw IQ through the
 * whole receiver. Each test runs all its checks and fails with the list of the ones that did not hold.
 */
class SondeBankATest {
    private class Checks {
        var pass = 0; val fails = ArrayList<String>()
        fun ok(c: Boolean, what: String, extra: String = "") { if (c) pass++ else fails.add(what + if (extra.isNotEmpty()) " — $extra" else "") }
        fun near(a: Double?, b: Double, tol: Double, what: String) = ok(a != null && abs(a - b) <= tol, what, "got $a, want $b ± $tol")
        fun eq(a: Any?, b: Any?, what: String) = ok(a == b, what, "got $a, want $b")
        fun done(name: String) { println("  $name: $pass passed, ${fails.size} failed"); assertTrue(fails.joinToString("\n"), fails.isEmpty()) }
    }

    private val flight: (Int) -> FlightPoint = { k -> FlightPoint(39.7392 + k * 1e-4, -104.9903 + k * 2e-4, 1600 + k * 5.1, 3.0, 4.0, 5.1) }
    /** 2026-11-14 12:34:50 UTC. */
    private val t0 = 1_794_659_690_000L
    private fun enc(s: String) = IntArray(s.length) { s[it].code }

    @Test fun referenceVectors() {
        val c = Checks()
        c.eq(Instant.ofEpochMilli(t0).atOffset(ZoneOffset.UTC).toString(), "2026-11-14T12:34:50Z", "test clock")
        c.eq(M10.check(enc("123456789"), 9), 0xF6D4, "M10 checksum vector \"123456789\"")
        c.eq(M10.check(intArrayOf(0x64, 0x9F), 2), 0x3E42, "M10 checksum vector 64 9F")
        c.eq(M10.check(IntArray(100) { it }, 100), 0xBA7F, "M10 checksum vector 00..63")
        c.eq(Mts01.crc(enc("123456789"), 0, 9), 0xE775, "MTS01 CRC vector \"123456789\"")
        val table = intArrayOf(0x00, 0x1E, 0x2D, 0x33, 0x4B, 0x55, 0x66, 0x78, 0x87, 0x99, 0xAA, 0xB4, 0xCC, 0xD2, 0xE1, 0xFF)
        c.ok(table.withIndex().all { (n, v) -> Dfm.hamming(n) == v }, "DFM Hamming(8,4) codeword table")
        // thermistor tables from the sources (R/R25 for the DFM NTC, kilohms for the M10)
        c.near(Dfm.tempFromR(2.7936 * 5000), 0.0, 0.3, "DFM NTC: 0 °C")
        c.near(Dfm.tempFromR(1.0 * 5000), 25.0, 0.3, "DFM NTC: 25 °C")
        c.near(Dfm.tempFromR(20.96 * 5000), -40.0, 0.5, "DFM NTC: -40 °C")
        c.near(M10.tempFromR(15.00e3), 0.0, 0.5, "M10 NTC: 0 °C")
        c.near(M10.tempFromR(5.370e3), 25.0, 0.5, "M10 NTC: 25 °C")
        c.near(M10.tempFromR(112.6e3), -40.0, 0.5, "M10 NTC: -40 °C")
        c.near(Mts01.tempFromR(15.0), 0.0, 1e-9, "MTS01 thermistor: 0 °C at R0")
        c.eq(Dfm.fl24(0x2ABCDE), 0xABCDE / 4.0, "DFM float24")
        // serial formats from the raw bytes
        c.eq(M10.m10Serial(intArrayOf(0x42, 0x00, 0x93, 0xD2, 0x24), 0), "903-2-11234", "M10 serial format (raw bytes)")
        c.eq(M10.m20Serial((5 * 12 + 11) or (0 shl 7) or (4350 shl 10) or (1 shl 23), 0), "512-1-14350", "M20 serial format")
        c.eq(M10.m20Serial(0, 7), "000-0-00000-007", "M20 blank serial")
        c.done("reference vectors")
    }

    private fun dfmRun(o: DfmOptions, nFrames: Int, inv: Boolean = false, mangle: ((IntArray, Int) -> Unit)? = null): List<SondeFrame> {
        val tx = SondeSynthA.DfmTx(o); val dec = DfmDecoder(); val outs = ArrayList<SondeFrame>()
        for (i in 0 until nFrames) {
            val bits = tx.next()
            mangle?.invoke(bits, i)
            dec.frame(bits, inv)?.let { outs.add(it) }
        }
        return outs
    }
    private fun dfmO(kind: DfmKind, serial: Long, tempC: Double, chStart: Int = 0) =
        DfmOptions(kind, serial, tempC, battV = 3.12, startMs = t0, flight = flight, sats = 11, chStart = chStart)

    @Test fun dfmFrames() {
        val c = Checks()
        val o09 = dfmRun(dfmO(DfmKind.DFM09, 19072298, -20.0), 60)
        val last = o09.lastOrNull()
        c.ok(o09.size >= 5, "DFM-09 frames decode", "${o09.size} outputs")
        c.eq(last?.type, "DFM", "DFM family")
        c.eq(last?.model, "DFM-09", "DFM-09 model (subtype 0xA, normal polarity)")
        c.eq(last?.serial, "DFM-19072298", "DFM-09 serial (decimal, two halves)")
        val k = 13 - 1   // 60 frames = 120 packets = 13 seconds; the last full one is second 12
        c.eq(last?.frame, (1 + k) and 255, "DFM frame counter")
        c.near(last?.lat, flight(k).lat, 1e-7, "DFM latitude")
        c.near(last?.lon, flight(k).lon, 1e-7, "DFM longitude")
        c.near(last?.alt, flight(k).alt, 0.01, "DFM altitude")
        c.near(last?.vH, 5.0, 0.01, "DFM ground speed")
        c.near(last?.heading, 53.13, 0.01, "DFM heading")
        c.near(last?.climb, 5.1, 0.01, "DFM climb")
        c.eq(last?.sats, 11, "DFM satellites")
        c.near(last?.tempC, -20.0, 0.05, "DFM-09 temperature (channels 0, 3, 4; Rf 220k)")
        c.near(last?.battV, 3.12, 0.001, "DFM battery")
        c.eq(last?.date, "2026-11-14", "DFM date")
        c.near(last?.timeS, (12 * 3600 + 34 * 60 + 50 + k).toDouble(), 0.01, "DFM time of day")
        c.eq(last?.extra?.get("MCU TEMPERATURE"), "25.0 °C", "DFM MCU temperature")
        c.eq(last?.extra?.get("GEOID HEIGHT"), "33.5 m", "DFM geoid height")
        c.eq(last?.fixed, 0, "DFM clean frames need no repair")

        val l17 = dfmRun(dfmO(DfmKind.DFM17, 23038743, 12.5), 60, true).lastOrNull()
        c.eq(l17?.model, "DFM-17", "DFM-17 model (subtype 0xB)")
        c.eq(l17?.serial, "DFM-23038743", "DFM-17 serial")
        c.near(l17?.tempC, 12.5, 0.05, "DFM-17 temperature (Rf 332k)")
        c.eq(l17?.extra?.get("SONDE CLOCK"), "4321 s", "DFM-17 seconds counter")
        // subtype 0xA with a 23xxxxxx serial and inverted polarity: the DFM-17 heuristic
        c.eq(dfmRun(dfmO(DfmKind.DFM09, 23038744, 5.0), 60, true).lastOrNull()?.model, "DFM-17", "DFM subtype 0xA, inverted, serial >= 23000000: DFM-17")
        val l9p = dfmRun(dfmO(DfmKind.DFM09P, 20123456, -35.0), 70).lastOrNull()
        c.eq(l9p?.model, "DFM-09P", "DFM-09P model (subtype 0xC, P sensor)")
        c.near(l9p?.tempC, -35.0, 0.05, "DFM-09P temperature (channels 1, 5, 6)")
        c.near(l9p?.battV, 3.12, 0.001, "DFM-09P battery (channel 7)")
        val l06 = dfmRun(dfmO(DfmKind.DFM06, 0x123456, 18.0), 60, true).lastOrNull()
        c.eq(l06?.model, "DFM-06", "DFM-06 model")
        c.eq(l06?.serial, "DFM-123456", "DFM-06 serial (six hex digits)")
        c.near(l06?.tempC, 18.0, 0.05, "DFM-06 temperature")
        val lps = dfmRun(dfmO(DfmKind.PS15, 17012345, 0.0), 60).lastOrNull()
        c.eq(lps?.model, "PS-15", "PS-15 model (serial nibble 0)")
        c.eq(lps?.serial, "DFM-17012345", "PS-15 serial")
        c.eq(lps?.tempC, null, "PS-15: no temperature claimed")

        // Hamming repair: one wrong bit in every config codeword and in 4 of each data block's 13 (more marks a packet bad)
        val oneBit: (IntArray, Int) -> Unit = { bits, _ ->
            for ((start, l, step) in listOf(Triple(16, 7, 1), Triple(72, 13, 4), Triple(176, 13, 4))) {
                var i = 0
                while (i < l) { val p = start + l * ((i * 3 + 1) % 8) + i; bits[p] = bits[p] xor 1; i += step }
            }
        }
        val lr = dfmRun(dfmO(DfmKind.DFM09, 19072298, -20.0), 60, false, oneBit).lastOrNull()
        c.eq(lr?.serial, "DFM-19072298", "DFM Hamming repairs one bit per codeword")
        c.near(lr?.lat, flight(12).lat, 1e-7, "DFM repaired latitude")
        c.ok((lr?.fixed ?: 0) > 0, "DFM reports repaired codewords", "${lr?.fixed}")
        // two wrong bits in one codeword of each data block: those packets are dropped, nothing comes out
        val twoBit: (IntArray, Int) -> Unit = { bits, _ -> for (s in intArrayOf(72, 176)) { bits[s] = bits[s] xor 1; bits[s + 13] = bits[s + 13] xor 1 } }
        c.eq(dfmRun(dfmO(DfmKind.DFM09, 19072298, -20.0), 60, false, twoBit).size, 0, "DFM uncorrectable codewords: no frames")
        c.done("DFM frames")
    }

    private fun m10o(k: Int) = M10Options(serial = "903-2-11234", counter = 40 + k, p = flight(k), week = 2408, towMs = 6 * 86400000L + 45_296_000 + k * 1000,
        leap = 18, sats = 8, tempC = -12.0, rh = 47.0, tHumC = -10.0, battV = 3.05)

    @Test fun m10m20Frames() {
        val c = Checks()
        val dec = M10Decoder()
        val f = SondeSynthA.m10Frame(m10o(3))
        val r = dec.parse(f)
        c.ok(r != null, "M10 frame parses (checksum)")
        c.eq(r?.type, "M10", "M10 family"); c.eq(r?.model, "M10", "M10 model")
        c.eq(r?.serial, "M10-903-2-11234", "M10 serial")
        c.eq(r?.frame, 43, "M10 frame counter")
        c.near(r?.lat, flight(3).lat, 1e-6, "M10 latitude"); c.near(r?.lon, flight(3).lon, 1e-6, "M10 longitude")
        c.near(r?.alt, flight(3).alt, 0.001, "M10 altitude")
        c.near(r?.vH, 5.0, 0.01, "M10 ground speed"); c.near(r?.heading, 53.13, 0.05, "M10 heading"); c.near(r?.climb, 5.1, 0.005, "M10 climb")
        c.eq(r?.sats, 8, "M10 satellites")
        c.near(r?.timeS, (45_296 + 3 - 18).toDouble(), 0.001, "M10 UTC time of day (leap seconds applied)")
        c.eq(r?.date, Instant.ofEpochMilli(315_964_800_000L + (2408 * 604800L + 6 * 86400 + 45_296 + 3 - 18) * 1000).atOffset(ZoneOffset.UTC).toLocalDate().toString(), "M10 date")
        c.near(r?.tempC, -12.0, 0.15, "M10 temperature")
        c.near(r?.rh, 47 + 12 / 5.5, 0.1, "M10 humidity (with the cold correction)")
        c.near(r?.tHumC, -10.0, 0.2, "M10 humidity sensor temperature")
        c.near(r?.battV, 3.05, 0.01, "M10 battery")
        // damage: one bit anywhere fails the checksum
        for (p in intArrayOf(1, 20, 0x5e, 0x62, 0x63)) { val b = f.copyOf(); b[p] = b[p] xor 0x08; c.ok(dec.parse(b) == null, "M10 bit error at byte 0x${Integer.toHexString(p)} rejected") }
        // M2K2, M10+ (Gtop), signal-level frames
        c.eq(dec.parse(SondeSynthA.m10Frame(m10o(0).copy(type = 0x8f)))?.model, "M2K2", "M2K2 model")
        val g = dec.parse(SondeSynthA.m10Frame(m10o(5).copy(type = 0xaf)))
        c.eq(g?.model, "M10+", "M10+ model")
        c.near(g?.lat, flight(5).lat, 1e-6, "M10+ latitude"); c.near(g?.alt, flight(5).alt, 0.01, "M10+ altitude"); c.near(g?.climb, 5.1, 0.01, "M10+ climb")
        c.near(g?.timeS, ((45_296 + 5 - 18) % 86400).toDouble(), 0.001, "M10+ time")
        c.ok(dec.parse(SondeSynthA.m10Frame(m10o(0).copy(type = 0x49))) == null, "M10 signal-level frame (0x49) reported as nothing")
        c.eq(dec.parse(SondeSynthA.m10Frame(m10o(0).copy(aux = 2)))?.serial, "M10-903-2-11234", "M10 with 2 aux bytes (frame length 0x66)")
        // from soft symbols, after the sync
        val syms = SondeSynthA.m10Symbols(f, false, 0).let { it.copyOfRange(32, it.size) }
        val soft = FloatArray(syms.size + 64 * 16) { if (it < syms.size && syms[it] != 0) 1f else -1f }
        c.eq(dec.decode(soft)?.serial, "M10-903-2-11234", "M10 from biphase-mark symbols")
        c.eq(dec.decode(FloatArray(soft.size) { -soft[it] })?.serial, "M10-903-2-11234", "M10 symbols inverted: same frame")

        val m20 = M20Options(serial = "512-1-14350", counter = 200, p = flight(7), week = 2408, towS = 3 * 86400 + 3600 + 7, tempC = 21.5, rh = 63.0, tHumC = 20.0, battV = 3.0, hPa = 845.25)
        val r20 = dec.parse(SondeSynthA.m20Frame(m20))
        c.ok(r20 != null, "M20 frame parses (checksum)")
        c.eq(r20?.type, "M20", "M20 family")
        c.eq(r20?.serial, "M20-512-1-14350", "M20 serial")
        c.eq(r20?.frame, 200, "M20 frame counter")
        c.near(r20?.lat, flight(7).lat, 1e-6, "M20 latitude"); c.near(r20?.lon, flight(7).lon, 1e-6, "M20 longitude")
        c.near(r20?.alt, flight(7).alt, 0.01, "M20 altitude")
        c.near(r20?.vH, 5.0, 0.01, "M20 ground speed"); c.near(r20?.heading, 53.13, 0.2, "M20 heading"); c.near(r20?.climb, 5.1, 0.01, "M20 climb")
        c.eq(r20?.timeS, (3600 + 7).toDouble(), "M20 GPS time of day")
        c.near(r20?.tempC, 21.5, 0.2, "M20 temperature")
        c.near(r20?.tHumC, 20.0, 0.2, "M20 humidity sensor temperature")
        c.near(r20?.rh, 63.0, 0.5, "M20 humidity")
        c.near(r20?.hPa, 845.25, 0.01, "M20 pressure")
        c.near(r20?.battV, 3.0, 0.02, "M20 battery")
        val b20 = SondeSynthA.m20Frame(m20); b20[0x30] = b20[0x30] xor 1
        c.ok(dec.parse(b20) == null, "M20 bit error rejected")
        c.done("M10/M20 frames")
    }

    private fun mtso(k: Int) = Mts01Options(id = "MTS1A234", counter = 1000 + k, startMs = t0 + k * 1000L, battMv = 3710, lat = flight(k).lat, lon = flight(k).lon,
        alt = flight(k).alt, heading = 53.1, speed = 5.0, rawT = 15 * exp(3000 * (1 / (273.15 - 15) - 1 / 273.15)))

    @Test fun mts01Frames() {
        val c = Checks()
        val dec = Mts01Decoder()
        val f = SondeSynthA.mts01Frame(mtso(2))
        val r = dec.parse(f)
        c.ok(r != null, "MTS01 frame parses (CRC)")
        c.eq(r?.type, "MTS01", "MTS01 family")
        c.eq(r?.serial, "MTS01-MTS1A234", "MTS01 serial")
        c.eq(r?.frame, 1002, "MTS01 frame counter")
        c.near(r?.lat, flight(2).lat, 1e-6, "MTS01 latitude"); c.near(r?.lon, flight(2).lon, 1e-6, "MTS01 longitude"); c.near(r?.alt, flight(2).alt, 0.05, "MTS01 altitude")
        c.near(r?.heading, 53.1, 0.01, "MTS01 heading"); c.near(r?.vH, 5.0, 0.01, "MTS01 speed")
        c.eq(r?.climb, null, "MTS01 has no climb field")
        c.near(r?.tempC, -15.0, 0.01, "MTS01 temperature")
        c.near(r?.battV, 3.71, 1e-9, "MTS01 battery")
        c.eq(r?.date, "2026-11-14", "MTS01 date")
        c.eq(r?.timeS, (12 * 3600 + 34 * 60 + 52).toDouble(), "MTS01 time")
        val b = f.copyOf(); b[40] = b[40] xor 0x01
        c.ok(dec.parse(b) == null, "MTS01 bit error rejected")
        val sy = SondeSynthA.mts01Symbols(f, false, 0)
        val soft = FloatArray(sy.size - 32) { if (sy[32 + it] != 0) 1f else -1f }
        c.eq(dec.decode(soft)?.serial, "MTS01-MTS1A234", "MTS01 from symbols")
        c.done("MTS01 frames")
    }

    // ---- channel decoders on a clean discriminator: both FM polarities, and no type decodes another's signal
    private val chRate = 47_619.0
    private fun disc(syms: IntArray, baud: Double, dev: Double, invert: Boolean, rate: Double = chRate): DoubleArray {
        val n = ceil(syms.size * rate / baud).toInt(); val a = 2 * PI * dev / rate
        return DoubleArray(n) { i -> val k = min(syms.size - 1, (i * baud / rate).toInt()); 0.02 + if ((syms[k] != 0) != invert) a else -a }
    }
    private fun bankRun(x: DoubleArray): List<SondeFrame> {
        val got = ArrayList<SondeFrame>()
        val decs = SondeBank.makeBankA(chRate) { got.add(it) }
        for (v in x) for (d in decs) d.push(v)
        return got
    }
    /** Frames with idle (alternating) symbols up to a second each: [idle] maps the fill index to a symbol. */
    private fun perSecond(frames: List<IntArray>, perSec: Int, idle: (Int) -> Int): IntArray {
        val out = ArrayList<Int>()
        for (f in frames) { out.addAll(f.toList()); for (i in 0 until perSec - f.size) out.add(idle(i)) }
        return out.toIntArray()
    }
    private fun dfmSig(serial: Long, inv: Boolean): DoubleArray {
        val tx = SondeSynthA.DfmTx(DfmOptions(DfmKind.DFM09, serial, -20.0, startMs = t0, flight = flight, chStart = 10))
        return disc(SondeSynthA.dfmSymbols(List(40) { tx.next() }), 2500.0, 2400.0, inv)
    }
    private val sigs: Map<String, (Boolean) -> DoubleArray> = linkedMapOf(
        "DFM" to { inv -> dfmSig(19072298, inv) },
        "M10" to { inv -> disc(perSecond(List(3) { SondeSynthA.m10Symbols(SondeSynthA.m10Frame(m10o(it))) }, 9615) { (it shr 1) and 1 }, 9615.0, 4800.0, inv) },
        "M20" to { inv ->
            disc(perSecond(List(3) { k -> SondeSynthA.m10Symbols(SondeSynthA.m20Frame(M20Options("512-1-14350", k, flight(k), 2408, 1000 + k, 5.0, 40.0, 5.0, 3.0))) }, 9600) { (it shr 1) and 1 },
                9600.0, 4800.0, inv)
        },
        "MTS01" to { inv -> disc(perSecond(List(3) { SondeSynthA.mts01Symbols(SondeSynthA.mts01Frame(mtso(it))) }, 1200) { it and 1 }, 1200.0, 640.0, inv) },
    )
    private val serials = mapOf("DFM" to "DFM-19072298", "M10" to "M10-903-2-11234", "M20" to "M20-512-1-14350", "MTS01" to "MTS01-MTS1A234")

    @Test fun channelDecoders() {
        val c = Checks()
        for ((type, mk) in sigs) {
            for (inv in listOf(false, true)) {
                val got = bankRun(mk(inv))
                val mine = got.filter { it.type == type && it.serial == serials[type] }
                val pol = if (inv) "inverted" else "normal"
                c.ok(mine.size >= (if (type == "DFM") 3 else 2), "$type through its channel decoder, $pol polarity", "${mine.size} frames")
                c.ok(got.all { it.type == type }, "$type signal: no other type decodes it ($pol)", got.filter { it.type != type }.joinToString(",") { it.type })
                if (type == "DFM") c.eq(mine.lastOrNull()?.model, "DFM-09", "DFM polarity seen ($pol), serial < 23000000 stays DFM-09")
            }
        }
        // the DFM polarity estimate feeds the DFM-17 heuristic: subtype 0xA, a 23xxxxxx serial
        c.eq(bankRun(dfmSig(23038744, false)).lastOrNull()?.model, "DFM-09", "DFM 0xA normal polarity: DFM-09")
        c.eq(bankRun(dfmSig(23038744, true)).lastOrNull()?.model, "DFM-17", "DFM 0xA inverted polarity: DFM-17")
        // noise alone: nothing
        var s = 5L
        val x = DoubleArray(chRate.toInt() * 3) { s = (s * 1103515245L + 12345L) and 0xffffffffL; (s / 4294967296.0 - 0.5) * 2 }
        c.eq(bankRun(x).size, 0, "noise: no frames")
        c.done("channel decoders")
    }

    @Test fun fourSondesThroughTheReceiver() {
        val c = Checks()
        val rate = 2_400_000; val secs = 10; val n = rate.toLong() * secs
        val center = 403_000_000L
        // DFM: continuous frames; serial channel first so the serial is complete in under 3 s
        val tx = SondeSynthA.DfmTx(DfmOptions(DfmKind.DFM17, 23038743, -20.0, battV = 3.1, startMs = t0, flight = flight))
        val tx2 = SondeSynthA.DfmTx(DfmOptions(DfmKind.DFM17, 23038743, -20.0, battV = 3.1, startMs = t0, flight = flight, chStart = tx.cycleLen - 1))
        val dfmFr = List((secs * 4.5 + 2).toInt()) { tx2.next() }
        // M10, M20: a burst a second; MTS01: a frame a second; idle carrier between
        fun burst(frames: List<IntArray>, baud: Int): IntArray {
            val out = ArrayList<Int>()
            for (f in frames) { out.addAll(f.toList()); while (out.size % baud != 0) out.add((out.size shr 1) and 1) }
            return out.toIntArray()
        }
        val m10s = burst(List(secs) { SondeSynthA.m10Symbols(SondeSynthA.m10Frame(m10o(it))) }, 9615)
        val m20s = burst(List(secs) { k -> SondeSynthA.m10Symbols(SondeSynthA.m20Frame(M20Options("512-1-14350", k, flight(k), 2408, 1000 + k, 5.0, 40.0, 5.0, 3.0)), true) }, 9600)
        val mtsl = ArrayList<Int>()
        for (k in 0 until secs) { mtsl.addAll(SondeSynthA.mts01Symbols(SondeSynthA.mts01Frame(mtso(k))).toList()); while (mtsl.size % 1200 != 0) mtsl.add(mtsl.size and 1) }
        val mix = SondeSynthA.FskMix(rate.toDouble(), listOf(
            SondeSynthA.FskSignal(SondeSynthA.dfmSymbols(dfmFr, true), 2500.0, -650_000.0, 2400.0, 26.0),
            SondeSynthA.FskSignal(m10s, 9615.0, -250_000.0, 4800.0, 26.0),
            SondeSynthA.FskSignal(m20s, 9600.0, 300_000.0, 4800.0, 26.0),
            SondeSynthA.FskSignal(mtsl.toIntArray(), 1200.0, 700_000.0, 640.0, 26.0),
        ), 6.0)
        val notes = ArrayList<String>()
        val proc = SondeProcessor(PacketLog(), Retuner(tune = {}, applied = { false }))
        proc.onNote = { notes.add(it) }
        proc.setBand("400"); proc.reset(rate); proc.setCenter(center)
        val tStart = System.currentTimeMillis()
        var done = 0L
        while (done < n) { val m = min(65536L, n - done).toInt(); val b = mix.next(m); proc.onIq(b, b.size, rate); done += m }
        val tRun = System.currentTimeMillis() - tStart
        val rows = proc.tracker.rows(System.currentTimeMillis())
        val all = rows.joinToString(",") { "${it.type}:${it.serial}" }
        for ((type, serial, off) in listOf(Triple("DFM", "DFM-23038743", -650_000L), Triple("M10", "M10-903-2-11234", -250_000L),
                Triple("M20", "M20-512-1-14350", 300_000L), Triple("MTS01", "MTS01-MTS1A234", 700_000L))) {
            val s = rows.firstOrNull { it.type + "-" + it.serial == serial }
            c.ok(s != null && s.type == type, "$type through the receiver", "rows $all; log ${notes.joinToString(" | ")}")
            c.ok((s?.frames ?: 0) >= 2, "$type several frames through the receiver", "frames ${s?.frames}")
            c.near(s?.hz?.toDouble(), (center + off).toDouble(), 3000.0, "$type channel frequency")
        }
        c.eq(rows.firstOrNull { it.serial == "23038743" }?.model, "DFM-17", "DFM-17 model through the receiver")
        c.near(rows.firstOrNull { it.serial == "23038743" }?.tempC, -20.0, 0.1, "DFM-17 temperature through the receiver")
        c.eq(rows.size, 4, "receiver: exactly the four sondes, no false decodes")
        println("  (receiver and signal generation: ${"%.1f".format(tRun / 1000.0)} s for $secs s of 2.4 Msps with 4 channels)")
        c.done("four sondes through the receiver")
    }
}
