package com.rocketgod.mayhem.core.analyzer

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The Analyzer end to end: synthetic bursts of every modulation and line coding, made into I/Q, found by the burst
 * front end anywhere in the span, then read back with nothing set by hand. Then repeated frames lined up bit by bit,
 * the fixed and changing columns checked, and the file formats round-tripped. Twin of web/test/analyzer.mjs, check
 * for check (83 of them), with the same signals and the same PRNG.
 *
 * No real key is in here: the synthetic frames use made-up bytes, and the Land Rover check uses the ProtoPirate-style
 * fixture already in the repo (resources/pirate/land_rover_fsk.txt), turned back into samples.
 */
class AnalyzerTest {
    private var pass = 0
    private var fail = 0
    private val failures = ArrayList<String>()
    private fun check(ok: Boolean, what: String) { if (ok) pass++ else { fail++; failures.add(what); println("FAIL $what") } }
    private fun near(a: Double, b: Double, tol: Double) = abs(a - b) <= tol
    private fun f1(x: Double) = String.format(Locale.US, "%.1f", x)
    private fun f0(x: Double) = String.format(Locale.US, "%.0f", x)

    // mulberry32: an LCG's bits repeat in shifted runs, which made made-up hops look like copies of each other
    private var seed = 99
    private fun rnd(): Double {
        seed += 0x6D2B79F5
        var t = seed
        t = (t xor (t ushr 15)) * (t or 1)
        t = t xor (t + (t xor (t ushr 7)) * (t or 61))
        return ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL) / 4294967296.0
    }
    private fun gauss(): Double { val a = sqrt(-2 * ln(rnd() + 1e-12)); return a * cos(2 * PI * rnd()) }
    private fun randBits(n: Int): String = buildString { repeat(n) { append(if (rnd() < 0.5) '1' else '0') } }
    private fun hexBits(h: String): String = h.map { Integer.toBinaryString(it.digitToInt(16)).padStart(4, '0') }.joinToString("")
    private fun flip(s: String) = s.map { if (it == '1') '0' else '1' }.joinToString("")

    private val RATE = 2_000_000

    /** A signal builder at 2 Msps: segments of (amplitude, frequency offset) for a number of microseconds, over noise. */
    private inner class Air {
        var out = ByteArray(1 shl 20); var len = 0; var ph = 0.0
        private fun push(v: Long) { if (len == out.size) out = out.copyOf(out.size * 2); out[len++] = max(-128L, min(127L, v)).toByte() }
        fun seg(us: Double, amp: Double, hz: Double) {
            val n = Math.round(us * RATE / 1e6)
            for (k in 0 until n) {
                ph += 2 * PI * hz / RATE
                if (ph > PI) ph -= 2 * PI
                push(Math.round(amp * cos(ph) + gauss() * 3))
                push(Math.round(amp * sin(ph) + gauss() * 3))
            }
        }
        fun quiet(ms: Double) = seg(ms * 1000, 0.0, 0.0)
        /** On-off or two-level keying: each (high, us). */
        fun ook(levels: List<Pair<Boolean, Double>>, hz: Double, amp: Double = 50.0, low: Double = 0.0) { for ((h, us) in levels) seg(us, if (h) amp else low, hz) }
        /** Frequency keying: each (high, us). */
        fun fsk(levels: List<Pair<Boolean, Double>>, hz: Double, dev: Double, amp: Double = 50.0) { for ((h, us) in levels) seg(us, amp, hz + if (h) dev else -dev) }
        fun iq(): ByteArray = out.copyOf(len)
    }

    /** Every burst the capture keeps from a signal (fed as the radio delivers it: offset-128 bytes). */
    private fun capture(air: Air): List<Burst> {
        val bursts = ArrayList<Burst>()
        val cap = AnalyzerCapture { bursts.add(it) }
        cap.reset(RATE)
        val iq = air.iq()
        val buf = ByteArray(262144)
        var p = 0
        while (p < iq.size) {
            val n = min(iq.size, p + 262144) - p
            for (i in 0 until n) buf[i] = (iq[p + i] + 128).toByte()
            cap.onIq(buf, n, RATE)
            p += 262144
        }
        cap.finish()
        return bursts
    }
    private fun read(b: Burst, o: Overrides = Overrides()) = analyze(b.env, b.fm, b.n, b.rate, o)

    /** Levels of one bit string, each bit [us] long, runs of the same level merged. */
    private fun levelsOf(code: String, us: Double): MutableList<Pair<Boolean, Double>> {
        val lv = ArrayList<Pair<Boolean, Double>>()
        for (c in code) { val h = c == '1'; if (lv.isNotEmpty() && lv.last().first == h) lv[lv.size - 1] = h to lv.last().second + us else lv.add(h to us) }
        return lv
    }

    private class Sum(val i: Int, override val mod: Mod, override val coding: Coding, override val symUs: Double, override val bits: Int) : Similar

    @Test
    fun analyzerEndToEnd() {
        pwm(); ppm(); ask(); fskNrz(); manchester(); shifted(); landRover(); counterAndCheck(); bundleAndFilter(); small()
        println("analyzer: $pass passed, $fail failed")
        assertTrue("failed: ${failures.joinToString(" | ")}", fail == 0)
        assertEquals("check count", 83, pass + fail)
    }

    // ---- OOK, pulse width: a PT2262-style 24-bit remote, four repeats ------------------------------------------------
    private fun pwm() {
        val code = randBits(24)
        val air = Air()
        air.quiet(60.0)
        val frame = ArrayList<Pair<Boolean, Double>>()
        for (c in code) { frame.add(if (c == '1') true to 1050.0 else true to 350.0); frame.add(if (c == '1') false to 350.0 else false to 1050.0) }
        frame.add(true to 350.0); frame.add(false to 10_850.0)
        for (r in 0 until 4) air.ook(frame, 210_000.0)
        air.quiet(150.0)
        val bursts = capture(air)
        check(bursts.size == 1, "PWM: one burst kept (got ${bursts.size})")
        val b = bursts[0]
        check(near(b.hz, 210_000.0, 12_000.0), "PWM: tuned to the burst (${b.hz})")
        val a = read(b)
        check(a.mod == Mod.OOK, "PWM: OOK detected (${a.mod}, ${a.why})")
        check(a.coding == Coding.PWM, "PWM: pulse width detected (${a.coding})")
        check(near(a.symUs, 350.0, 35.0), "PWM: symbol 350 us (${f1(a.symUs)})")
        check(a.frames.size == 4, "PWM: four frames (${a.frames.size})")
        check(a.frames.all { it.bits.startsWith(code) }, "PWM: every frame reads the code (${a.frames.joinToString(" ") { it.bits }} vs $code)")
        check(b.matches.any { Regex("princeton|remote", RegexOption.IGNORE_CASE).containsMatchIn(it) }, "PWM: the Devices decoders recognize it (${b.matches.joinToString(", ")})")
        check(near(a.baud, 1e6 / 1400, 40.0), "PWM: rate ${f0(a.baud)} bits/s")
        // every bit knows where it lies: a pulse-width bit spans its mark and its gap, 1.4 ms
        val fr = a.frames[0]
        check(fr.spans.size == 2 * fr.bits.length, "spans: one per bit (${fr.spans.size / 2} for ${fr.bits.length})")
        check(fr.spans[0] >= fr.start - 2 && fr.spans[fr.spans.size - 1] <= fr.end + 400, "spans: inside the frame")
        val bitUs = (fr.spans[1] - fr.spans[0]) / b.rate * 1e6
        check(near(bitUs, 1400.0, 60.0), "spans: a PWM bit is 1.4 ms (${f0(bitUs)} us)")
        val h = histogram(a, b.rate)
        val pm = h.marks.withIndex().sortedByDescending { it.value }.take(2).map { (it.index + 0.5) * h.binUs }.sorted()
        check(near(pm[0], 350.0, 100.0) && near(pm[1], 1050.0, 100.0), "histogram: marks at 350 and 1050 us (${pm.map { f0(it) }})")
        val inv = read(b, Overrides(invert = true))
        check(inv.frames[0].bits.substring(0, 24) == flip(code), "PWM: invert flips the bits")
        // the Flipper file: same pulses out and back
        val pu = pulsesUs(a, b.rate)
        val sub = parseSub(toSub(pu, 433_920_000.0, false, 0.0))
        check(sub != null && sub.pulses.size == pu.size && sub.pulses == pu && sub.freqHz == 433_920_000.0 && !sub.fsk, "PWM: .sub round trip")
        check(pu[0] > 0 && pu[pu.size - 1] > 0, ".sub: starts and ends on a mark")
        // and the .sub turned back into samples reads the same
        val again = ArrayList<Burst>()
        captureFile(synthesize(sub!!.pulses, false), 1_000_000, "x.sub") { again.add(it) }
        val a2 = again.firstOrNull()?.let { read(it) }
        check(a2 != null && a2.coding == Coding.PWM && a2.frames.firstOrNull()?.bits?.startsWith(code) == true, ".sub import reads the same code (${a2?.frames?.firstOrNull()?.bits})")
    }

    // ---- OOK, pulse position -------------------------------------------------------------------------------------
    private fun ppm() {
        val code = randBits(32)
        val air = Air()
        air.quiet(60.0)
        // a long start mark ends up its own frame part: none here; PPM proper is constant marks
        val frame = ArrayList<Pair<Boolean, Double>>()
        for (c in code) { frame.add(true to 500.0); frame.add(false to if (c == '1') 2000.0 else 1000.0) }
        frame.add(true to 500.0); frame.add(false to 12_000.0)
        for (r in 0 until 3) air.ook(frame, -340_000.0)
        air.quiet(150.0)
        val bursts = capture(air)
        check(bursts.size == 1, "PPM: one burst (${bursts.size})")
        val a = read(bursts[0])
        check(a.mod == Mod.OOK && a.coding == Coding.PPM, "PPM: OOK + PPM detected (${a.mod} ${a.coding})")
        check(a.frames.size == 3 && a.frames.all { it.bits == code }, "PPM: frames read the code (${a.frames.joinToString(" ") { it.bits }})")
    }

    // ---- ASK, NRZ ---------------------------------------------------------------------------------------------------
    private fun ask() {
        val code = "1010101010101010" + randBits(48)
        val air = Air()
        air.quiet(60.0)
        air.ook(levelsOf(code, 500.0), 80_000.0, 70.0, 22.0)
        air.quiet(150.0)
        val bursts = capture(air)
        check(bursts.size == 1, "ASK: one burst (${bursts.size})")
        val a = read(bursts[0])
        check(a.mod == Mod.ASK, "ASK detected (${a.mod}, ${a.why})")
        check(a.coding == Coding.NRZ, "ASK: NRZ detected (${a.coding})")
        check(near(a.symUs, 500.0, 25.0), "ASK: symbol 500 us (${f1(a.symUs)})")
        val bits = a.frames.firstOrNull()?.bits ?: ""
        check(bits.contains(code.replace(Regex("0+$"), "").substring(1)), "ASK: bits read ($bits vs $code)")
    }

    // ---- FSK, NRZ (a TPMS-like 19.2 kbaud packet) ------------------------------------------------------------------
    private fun fskNrz() {
        val code = "0101010101010101" + "00111111" + randBits(64)
        val air = Air()
        air.quiet(60.0)
        val us = 1e6 / 19_200
        air.fsk(levelsOf(code, us), 150_000.0, 30_000.0)
        air.quiet(150.0)
        val bursts = capture(air)
        check(bursts.size == 1, "FSK NRZ: one burst (${bursts.size})")
        val a = read(bursts[0])
        check(a.mod == Mod.FSK, "FSK NRZ: FSK detected (${a.mod}, ${a.why})")
        check(a.coding == Coding.NRZ, "FSK NRZ: NRZ detected (${a.coding})")
        check(near(a.symUs, us, 4.0), "FSK NRZ: symbol ${f1(us)} us (${f1(a.symUs)})")
        check(near(a.shiftHz, 60_000.0, 12_000.0), "FSK NRZ: shift 60 kHz (${f0(a.shiftHz)})")
        val bits = a.frames.firstOrNull()?.bits ?: ""
        check(bits.contains(code.substring(4, code.length - 2)), "FSK NRZ: bits read (${bits.length} bits)")
    }

    // ---- FSK, Manchester: a hopping key, six packets on three channels ---------------------------------------------
    // Made-up bytes in the Land Rover's layout: 24-bit training run, 5 fixed bytes, a channel byte, 2 fixed bytes, a
    // 64-bit hop that changes every packet, a 16-bit check.
    private val FIXED = "34A5C33C96"
    private val FIXED2 = "7E81"
    private class Packet(val bits: String, val hop: String, val ch: Int)

    private fun manchester() {
        val packets = ArrayList<Packet>()
        val air = Air()
        air.quiet(60.0)
        val chans = doubleArrayOf(-312_000.0, 5_000.0, 323_000.0)
        for (p in 0 until 6) {
            val ch = p % 3; val hop = randBits(64); val crc = randBits(16)
            val bits = "1010".repeat(6) + hexBits(FIXED) + Integer.toBinaryString(ch shl 3).padStart(8, '0') + hexBits(FIXED2) + hop + crc
            packets.add(Packet(bits.substring(24), hop, ch))
            val lv = arrayListOf(false to 50_000.0)
            for (c in bits) { if (c == '1') { lv.add(true to 64.0); lv.add(false to 64.0) } else { lv.add(false to 64.0); lv.add(true to 64.0) } }
            lv.add(false to 200.0)
            air.fsk(lv, chans[ch], 23_000.0)
            air.quiet(30.0)
        }
        air.quiet(150.0)
        val bursts = capture(air)
        check(bursts.size == 6, "Manchester: six bursts (${bursts.size})")
        check(bursts.withIndex().all { (i, b) -> near(b.hz, chans[i % 3], 30_000.0) }, "Manchester: each on its channel (${bursts.joinToString(", ") { f0(it.hz / 1e3) }})")
        check(bursts.all { near(it.ms, 72.0, 4.0) }, "Manchester: lengths ${bursts.joinToString(", ") { f1(it.ms) }} ms")
        val reads = bursts.map { read(it) }
        check(reads.all { it.mod == Mod.FSK }, "Manchester: FSK detected (${reads.map { it.mod }})")
        check(reads.all { it.coding == Coding.Manchester }, "Manchester: detected (${reads.map { it.coding }})")
        check(reads.all { near(it.symUs, 64.0, 4.0) }, "Manchester: half bit 64 us (${reads.map { f1(it.symUs) }})")
        check(reads.all { near(it.baud, 7812.5, 300.0) }, "Manchester: 7.8 kbit/s (${reads.map { f0(it.baud) }})")
        val frames = reads.map { it.frames.lastOrNull()?.bits ?: "" }
        check(frames.withIndex().all { (i, f) -> i < packets.size && f.contains(packets[i].bits.substring(0, 140)) }, "Manchester: every packet reads back")
        val mf = reads[0].frames.last()
        check(near((mf.spans[2 * 40 + 1] - mf.spans[2 * 40]) / bursts[0].rate * 1e6, 128.0, 8.0), "spans: a Manchester bit is two half bits")
        // line them up
        val al = align(frames)
        check(al.preamble != null && al.preamble.second - al.preamble.first >= 16, "align: preamble found (${al.preamble})")
        check(al.sync != null && al.sync.hex.startsWith("34A5C33C"), "align: sync word (${al.sync?.hex})")
        val base = al.sync?.from ?: 0
        // fixed bytes fixed, channel bits changing, hop changing
        var fixedOk = true; for (c in base until base + 40) if (st(al, c) != 1) fixedOk = false
        check(fixedOk, "align: the five fixed bytes are fixed")
        check(st(al, base + 40 + 3) == 0 && st(al, base + 40 + 4) == 0, "align: the channel bits change")
        var fixed2 = true; for (c in base + 48 until base + 64) if (st(al, c) != 1) fixed2 = false
        check(fixed2, "align: the two fixed bytes after the channel are fixed")
        var hopCh = 0; for (c in base + 64 until base + 128) if (st(al, c) == 0) hopCh++
        check(hopCh > 50, "align: the hop changes ($hopCh/64 columns)")
        check(al.segments.size >= 4, "align: segments ${al.segments.joinToString(" ") { "${if (it.fixed) "F" else "C"}${it.to - it.from}" }}")
        // grouping
        val sum = reads.mapIndexed { i, a -> Sum(i, a.mod, a.coding, a.symUs, frames[i].length) }
        check(similar(sum, sum[0]).size == 6, "similar: the six packets group together")
    }

    /** A column's state, or -1 past the end (the web reads undefined there). */
    private fun st(al: Alignment, c: Int) = if (c in al.state.indices) al.state[c] else -1

    // ---- alignment from shifted copies ----------------------------------------------------------------------------
    private fun shifted() {
        val pre = "10".repeat(12); val sync = hexBits("2DD4"); val fixed = randBits(24)
        val rows = ArrayList<String>()
        for (i in 0 until 5) rows.add(pre.substring(i * 2) + sync + fixed + randBits(32))
        val al = align(rows)
        val s0 = al.rows.map { it.shift }
        check(rows.mapIndexed { i, r -> s0[i] + r.length }.toSet().size == 1, "align: ragged starts line up on the end ($s0)")
        check(al.sync != null && al.sync.hex.startsWith("2DD4"), "align: sync after a ragged preamble (${al.sync?.hex})")
    }

    // ---- the Land Rover fixture, through the whole import path ----------------------------------------------------
    private fun landRover() {
        val text = javaClass.classLoader!!.getResource("pirate/land_rover_fsk.txt")!!.readText()
        val trains = ArrayList<ArrayList<Int>>(); val expect = ArrayList<String?>()
        var cur: ArrayList<Int>? = null
        // (the checkout may have CRLF line ends; the web test reads the LF original)
        for (raw in text.split('\n')) {
            val line = raw.trimEnd('\r')
            if (line.startsWith("# train")) { cur = ArrayList(); trains.add(cur); continue }
            if (line.startsWith("= ")) { expect.add(Regex("Key:([0-9A-F]+)").find(line)?.groupValues?.get(1)); continue }
            if (cur == null || line.isEmpty() || line[0] == '#') continue
            val parts = line.split(' ')
            val us = parts[1].trim().toInt()
            cur.add(if (parts[0] == "1") us else -us)
        }
        val keys = ArrayList<String>(); val frames = ArrayList<String>()
        for (t in trains.indices) {
            val pulses = listOf(-60_000) + trains[t] + listOf(-2000)
            val got = ArrayList<Burst>()
            captureFile(synthesize(pulses, true), 1_000_000, "lr$t.sub") { got.add(it) }
            val b = got.sortedByDescending { it.n }.firstOrNull() ?: continue
            val a = read(b)
            val f = a.frames.sortedByDescending { it.bits.length }.firstOrNull() ?: continue
            frames.add(f.bits)
            if (a.mod == Mod.FSK && a.coding == Coding.Manchester) keys.add(f.bits)
            if (t == 0) check(b.matches.any { it.contains("land rover", ignoreCase = true) }, "Land Rover: the Devices decoder recognizes the import (${b.matches})")
        }
        check(keys.size == trains.size, "Land Rover: every train reads as FSK Manchester (${keys.size}/${trains.size})")
        val hits = expect.count { k -> k != null && frames.any { f -> f.contains(hexBits(k).substring(0, 120)) } }
        check(hits == expect.size, "Land Rover: every expected frame is in the bits ($hits/${expect.size})")
        val al = align(frames)
        check(al.sync != null && al.sync.hex.startsWith("D3683C0E"), "Land Rover: sync word D3683C0E (${al.sync?.hex})")
        val base = al.sync?.from ?: 0
        var f5 = true; for (c in base until base + 40) if (st(al, c) != 1) f5 = false
        check(f5, "Land Rover: bytes 0..4 fixed")
        var hop = 0; for (c in base + 64 until base + 128) if (st(al, c) == 0) hop++
        check(hop > 56, "Land Rover: the hop changes ($hop/64)")
        // the checksum finder: CRC-16/XMODEM over bytes 4..15, stored in 16..17 (as worked out by hand from the recordings)
        val start = dataStart(al)
        val crc = findCheck(fromStart(al, start))
        check(crc != null && crc.name.contains("XMODEM") && crc.from == 4 && crc.to == 16 && crc.at == 16 && !crc.little, "Land Rover: CRC found (${crc?.name} over ${crc?.from}..${crc?.to} at ${crc?.at})")
        val sg = suggest(al)
        val kinds = sg.fields.map { it.kind }
        check(FieldKind.Preamble in kinds && FieldKind.Sync in kinds && FieldKind.Crc in kinds && FieldKind.Id in kinds, "Land Rover: fields suggested (${sg.fields.joinToString(" ") { "${it.kind.key}:${it.from}-${it.to}" }})")
        // saved as a protocol, it is recognized in a later frame, with the CRC checked
        val proto = Protocol("Land Rover", al.sync!!.bits, "FSK", "Manchester", 64.0, sg.fields, sg.check)
        val hit = recognize(listOf(proto), frames[0], "FSK", "Manchester")
        check(hit != null && hit.protocol.name == "Land Rover", "protocol: recognized by its sync")
        check(hit != null && checkHolds(proto, frames[0], hit.start) == true, "protocol: its CRC holds on a real frame")
        val hs = hit?.start ?: 0
        val broken = frames[0].substring(0, hs + 50) + (if (frames[0][hs + 50] == '1') '0' else '1') + frames[0].substring(hs + 51)
        check(checkHolds(proto, broken, hs) == false, "protocol: a flipped bit fails the CRC")
        check(fieldValue(frames[0], hs, sg.fields.first { it.kind == FieldKind.Sync }).startsWith("D3683C0E"), "protocol: field values read")
        check(recognize(listOf(proto), frames[0], "OOK", "PWM") == null, "protocol: another modulation is not it")
    }

    // ---- counter and checksum on made-up frames ------------------------------------------------------------------
    private fun counterAndCheck() {
        val sync = hexBits("2DD4"); val id = hexBits("A1B2")
        val rows = ArrayList<String>()
        for (k in 0 until 6) {
            val cnt = Integer.toBinaryString(40 + (k shr 1)).padStart(8, '0')            // two repeats per press
            val body = id + cnt + randBits(16)
            val crc = Integer.toBinaryString(checkOf(CheckSpec(CheckKind.Crc, 8, 0x07, 0, false, 0), bytesOf(body), 0, 5)).padStart(8, '0')
            rows.add("1010".repeat(4) + sync + body + crc)
        }
        val al = align(rows)
        val sg = suggest(al)
        val cnt = sg.fields.firstOrNull { it.kind == FieldKind.Counter }
        check(cnt != null && cnt.from == 32 && cnt.to == 40, "counter suggested (${cnt?.from}-${cnt?.to})")
        check(sg.check != null && sg.check.name.contains("CRC-8") && sg.check.at == 7, "CRC-8 found (${sg.check?.name} at ${sg.check?.at})")
        check(findCounter(fromStart(al, dataStart(al)).reversed(), listOf(Segment(32, 40, false))) == null, "a counter that runs backward in time is not one")
    }

    // ---- session bundle and capture filter -----------------------------------------------------------------------
    private fun bundleAndFilter() {
        val env = shortArrayOf(1, -2, 300, 32767); val fm = shortArrayOf(-32768, 5, 6, 7); val iq = byteArrayOf(1, -1, 2, -2, 127, -128, 0, 5)
        val meta = JSONObject().put("version", 1)
            .put("bursts", JSONArray().put(JSONObject().put("n", 4).put("id", 7).put("name", "gate").put("star", true).put("note", "left button")))
            .put("protocols", JSONArray().put(JSONObject().put("name", "p")))
        val back = decodeBundle(encodeBundle(meta, listOf(BundleArrays(env, fm, iq))))
        check(back != null && back.meta.getJSONArray("bursts").getJSONObject(0).getString("name") == "gate" && back.meta.getJSONArray("protocols").length() == 1, "bundle: names and protocols round trip")
        check(back != null && back.arrays[0].env.contentEquals(env) && back.arrays[0].fm.contentEquals(fm) && back.arrays[0].iq.contentEquals(iq), "bundle: samples round trip")
        check(decodeBundle(byteArrayOf(1, 2, 3)) == null, "bundle: other bytes are not one")
        fun ok(f: CaptureFilter, center: Long, matches: List<String> = emptyList()) = passes(f, 50_000.0, 12.0, 20.0, matches, center)
        check(ok(NO_FILTER, 433_920_000), "filter: none lets everything through")
        check(!ok(NO_FILTER.copy(loHz = 434e6), 433_920_000) && ok(NO_FILTER.copy(loHz = 433.9e6, hiHz = 434e6), 433_920_000), "filter: frequency range")
        check(!ok(NO_FILTER.copy(minSnr = 15.0), 0) && !ok(NO_FILTER.copy(maxMs = 10.0), 0) && !ok(NO_FILTER.copy(minMs = 30.0), 0), "filter: SNR and length")
        check(!ok(NO_FILTER.copy(unknownOnly = true), 0, listOf("remote: x")) && ok(NO_FILTER.copy(unknownOnly = true), 0), "filter: only unknown")
        check(ok(NO_FILTER.copy(loHz = 434e6), 0), "filter: a file with no center skips the frequency test")
    }

    // ---- small things ---------------------------------------------------------------------------------------------
    private fun small() {
        check(bitsToHex("1101001101101") == "D368", "hex (${bitsToHex("1101001101101")})")
        check(bitsToAscii("0100100001101001") == "Hi", "ascii")
        check(rateFromName("landrover2_315MHz_2Msps.u8") == 2e6, "rate from name (${rateFromName("landrover2_315MHz_2Msps.u8")})")
        check(rateFromName("analyzer_433.920MHz_250k_3.cu8") == 250e3, "rate from name 250k (${rateFromName("analyzer_433.920MHz_250k_3.cu8")})")
        check(freqFromName("landrover2_315MHz_2Msps.u8") == 315_000_000L, "freq from name")
        check(freqFromName("analyzer_433.920MHz_250k_3.cu8") == 433_920_000L, "freq from name, decimals")
        val iq = byteArrayOf(-128, -1, 0, 1, 127, 5)
        val back = fromIqFile(toCu8(iq), "x.cu8")
        check(back.contentEquals(iq), "cu8 round trip")
        check(fromIqFile(byteArrayOf(255.toByte(), 1), "x.cs8")[0] == (-1).toByte(), "cs8 is signed")
        check(parseSub("Filetype: Flipper SubGhz Key File\nProtocol: Princeton\nKey: 00 00 00 00 00 12 34 56\n") == null, "a decoded .sub is not RAW")
    }
}
