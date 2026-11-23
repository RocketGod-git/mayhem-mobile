package com.rocketgod.mayhem.core.hamid

import com.rocketgod.mayhem.core.ham.CTCSS_TONES
import com.rocketgod.mayhem.core.ham.SubAudioDecoder
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Analog repeater signaling, one transmission at a time: carrier cut, CW ID, selcall (ZVEI1/2/3, CCIR1/2, EEA, EIA),
 * 2-tone pages, MDC-1200, other 1200 and 2400 baud bursts, CTCSS and its reverse burst, DCS and its turn-off code,
 * the courtesy tone and its fingerprint, the tail, time-outs and kerchunks. The same as the web's
 * dsp/hamid/analog.ts, step for step, so every platform reads the same.
 */
data class ToneSeg(val hz: Double, var atS: Double, var ms: Int, val amp: Double, var used: Boolean)
data class AnalogTone(val hz: Int, val ms: Int)
data class CourtesyTone(val tones: List<AnalogTone>, var key: String, val atS: Double, var seen: Int)
data class CwId(val callsign: String, val suffix: String, val text: String, val wpm: Int, val pitchHz: Int, val confidence: Double, val atS: Double)
data class Selcall(val system: String, val digits: String, val atS: Double)
data class TwoTone(val aHz: Int, val bHz: Int, val aMs: Int, val bMs: Int, val atS: Double)
data class MdcPacket(val op: Int, val arg: Int, val unit: String, val emergency: Boolean, val label: String, val extra: List<Int>, val atS: Double)
data class DataBurst(val baud: Int, val ms: Int, val atS: Double)
data class AnalogTx(
    val startS: Double, val durS: Double, val voiceS: Double,
    /** When the user unkeyed (seconds into the transmission) and the carrier after it; -1 when there was no user. */
    val unkeyS: Double, val tailS: Double,
    val ctcss: Double, val dcs: Int, val reverseBurst: Int, val dcsTurnOff: Boolean,
    val courtesy: CourtesyTone?, val cw: CwId?,
    val selcall: List<Selcall>, val twoTone: List<TwoTone>, val mdc: List<MdcPacket>, val data: List<DataBurst>,
    val timeout: Boolean, val kerchunk: Boolean,
)
data class AnalogCwId(val callsign: String, val count: Int, val confidence: Double)
data class AnalogPrint(val key: String, val tones: List<AnalogTone>, val count: Int)
data class AnalogSnap(val carrier: Boolean, val txs: List<AnalogTx>, val cwId: AnalogCwId?, val courtesy: List<AnalogPrint>, val timeoutS: Double)

private const val N = 128
private const val H = 32
private const val HALF = N / 2
private val HANN = DoubleArray(N) { 0.5 - 0.5 * cos(2 * PI * it / N) }
private val BITREV = IntArray(N) { i -> var r = 0; var j = i; var k = 1; while (k < N) { r = (r shl 1) or (j and 1); k = k shl 1; j = j shr 1 }; r }
private val TW_RE = DoubleArray(HALF) { cos(-2 * PI * it / N) }
private val TW_IM = DoubleArray(HALF) { sin(-2 * PI * it / N) }

/** JavaScript's Math.round: half up. */
private fun jsr(x: Double): Double = floor(x + 0.5)
private fun r2(x: Double) = jsr(x * 100) / 100

private fun spectrum(y: FloatArray, at: Int, re: DoubleArray, im: DoubleArray, p: DoubleArray) {
    for (i in 0 until N) { re[BITREV[i]] = y[at + i] * HANN[i]; im[BITREV[i]] = 0.0 }
    var size = 2
    while (size <= N) {
        val half = size shr 1; val step = N / size
        var s = 0
        while (s < N) {
            for (j in 0 until half) {
                val wr = TW_RE[j * step]; val wi = TW_IM[j * step]; val a = s + j; val b = a + half
                val tr = re[b] * wr - im[b] * wi; val ti = re[b] * wi + im[b] * wr
                re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
            }
            s += size
        }
        size = size shl 1
    }
    for (k in 0..HALF) p[k] = re[k] * re[k] + im[k] * im[k]
}
private fun pct(v: DoubleArray, q: Double): Double { if (v.isEmpty()) return 0.0; val s = v.sortedArray(); return s[floor(q * (s.size - 1)).toInt()] }
private fun pct(v: List<Double>, q: Double) = pct(v.toDoubleArray(), q)
private fun clamp01(x: Double) = if (x < 0) 0.0 else if (x > 1) 1.0 else x
private fun wrap(a: Double): Double { var x = a; while (x > PI) x -= 2 * PI; while (x < -PI) x += 2 * PI; return x }
private fun goertzel(x: FloatArray, from: Int, to: Int, hz: Double, rate: Double): Double {
    val c = 2 * cos(2 * PI * hz / rate); var s1 = 0.0; var s2 = 0.0
    for (i in from until to) { val s = x[i] + c * s1 - s2; s2 = s1; s1 = s }
    return s1 * s1 + s2 * s2 - c * s1 * s2
}

// ------------------------------------------------------------------------------------------------ callsigns
private val CALL_RE = Regex("^((?:[A-Z]{1,2}|[A-Z][0-9]|[2-9][A-Z])[0-9][A-Z]{1,4})(?:/([A-Z0-9]{1,4}))?$")
data class PlausibleCall(val call: String, val suffix: String)
/** A plausible amateur callsign in a CW word ("W6ABC", "W6ABC/R", "DEW6ABC"), or null. */
fun plausibleCall(word: String): PlausibleCall? {
    for (w in listOf(word, if (word.startsWith("DE")) word.substring(2) else "")) {
        val m = if (w.isNotEmpty()) CALL_RE.find(w) else null
        if (m != null && m.groupValues[1].length in 3..7) return PlausibleCall(m.groupValues[1], m.groupValues[2])
    }
    return null
}

// ------------------------------------------------------------------------------------------------ CW
private val MORSE = mapOf(
    ".-" to "A", "-..." to "B", "-.-." to "C", "-.." to "D", "." to "E", "..-." to "F", "--." to "G", "...." to "H", ".." to "I", ".---" to "J", "-.-" to "K", ".-.." to "L",
    "--" to "M", "-." to "N", "---" to "O", ".--." to "P", "--.-" to "Q", ".-." to "R", "..." to "S", "-" to "T", "..-" to "U", "...-" to "V", ".--" to "W", "-..-" to "X",
    "-.--" to "Y", "--.." to "Z", "-----" to "0", ".----" to "1", "..---" to "2", "...--" to "3", "....-" to "4", "....." to "5", "-...." to "6", "--..." to "7",
    "---.." to "8", "----." to "9", "-..-." to "/", "-...-" to "=", "..--.." to "?", ".-.-.-" to ".", "--..--" to ",",
)
private class Run(val on: Boolean, var len: Int, val at: Int, var snr: Double)
private class CwPass(val id: CwId?, val ditMs: Double, val dfHz: Double)

private fun cleanRuns(runs: List<Run>, minOn: Int, minOff: Int): MutableList<Run> {
    val r = runs.map { Run(it.on, it.len, it.at, it.snr) }.toMutableList()
    while (true) {
        var bi = -1
        for (i in 1 until r.size - 1) if (r[i].len < (if (r[i].on) minOn else minOff) && (bi < 0 || r[i].len < r[bi].len)) bi = i
        if (bi < 0) break
        val a = r[bi - 1]; val b = r[bi + 1]
        a.snr = if (a.on) max(a.snr, b.snr) else 0.0
        a.len += r[bi].len + b.len; r.removeAt(bi); r.removeAt(bi)
    }
    return r
}

private fun cwPass(y: FloatArray, rate: Double, f0: Double, bw: Double, t0S: Double): CwPass {
    val dec = max(1.0, jsr(rate / 500)).toInt(); val er = rate / dec; val a = 1 - exp(-2 * PI * bw / rate)
    val offs = doubleArrayOf(0.0, -190.0, -110.0, 110.0, 190.0); val M = offs.size
    val cr = DoubleArray(M) { 1.0 }; val ci = DoubleArray(M); val dr = DoubleArray(M) { cos(-2 * PI * (f0 + offs[it]) / rate) }; val di = DoubleArray(M) { sin(-2 * PI * (f0 + offs[it]) / rate) }
    val s1r = DoubleArray(M); val s1i = DoubleArray(M); val s2r = DoubleArray(M); val s2i = DoubleArray(M)
    val ne = y.size / dec; val c = DoubleArray(ne); val sd = DoubleArray(ne); val zr = DoubleArray(ne); val zi = DoubleArray(ne)
    var j = 0
    for (i in 0 until ne * dec) {
        val v = y[i].toDouble()
        for (k in 0 until M) {
            s1r[k] += a * (v * cr[k] - s1r[k]); s1i[k] += a * (v * ci[k] - s1i[k])
            s2r[k] += a * (s1r[k] - s2r[k]); s2i[k] += a * (s1i[k] - s2i[k])
            val nr = cr[k] * dr[k] - ci[k] * di[k]; ci[k] = cr[k] * di[k] + ci[k] * dr[k]; cr[k] = nr
        }
        if ((i + 1) % dec == 0) {
            c[j] = s2r[0] * s2r[0] + s2i[0] * s2i[0]; zr[j] = s2r[0]; zi[j] = s2i[0]
            var s = 0.0; for (k in 1 until M) s += s2r[k] * s2r[k] + s2i[k] * s2i[k]
            sd[j] = s / (M - 1) + 1e-20; j++
            if ((j and 255) == 0) for (k in 0 until M) { val g = 1 / sqrt(cr[k] * cr[k] + ci[k] * ci[k]); cr[k] *= g; ci[k] *= g }
        }
    }
    val ex = DoubleArray(ne) { c[it] - sd[it] }
    val lineLv = ArrayList<Double>(); for (q in 0 until ne) if (c[q] > 4 * sd[q]) lineLv.add(ex[q])
    val none = CwPass(null, 0.0, 0.0)
    if (lineLv.size < 10) return none
    val mark = pct(lineLv, 0.9)
    val runs = ArrayList<Run>(); var on = false; var len = 0; var at = 0; var snrMax = 0.0
    for (q in 0 until ne) {
        val qq = c[q] / sd[q]
        val now = if (on) ex[q] > 0.15 * mark else (ex[q] > 0.3 * mark && qq > 2)
        if (now != on && len > 0) { runs.add(Run(on, len, at, if (on) snrMax else 0.0)); len = 0; at = q; snrMax = 0.0 }
        on = now; len++; if (on) snrMax = max(snrMax, qq)
    }
    if (len > 0) runs.add(Run(on, len, at, if (on) snrMax else 0.0))
    val msPer = 1000 / er
    var r = cleanRuns(runs, jsr(12 / msPer).toInt(), jsr(12 / msPer).toInt())
    if (r.count { it.on } < 5) return none
    var bestD = 0.0; var bestCost = 1e9
    var d = 45.0
    while (d <= 260) {
        var cost = 0.0; var n = 0
        for (x in r) {
            val ms = x.len * msPer
            if (x.on) { if (ms > 5 * d) continue; val e = min(abs(ms - d) / d, abs(ms - 3 * d) / (3 * d)); cost += min(0.5, e); n++ }
            else { if (ms > 9 * d) continue; val e = min(min(abs(ms - d) / d, abs(ms - 3 * d) / (3 * d)), abs(ms - 7 * d) / (7 * d)); cost += min(0.5, e); n++ }
        }
        if (n >= 8) { cost /= n; if (cost < bestCost) { bestCost = cost; bestD = d } }
        d *= 1.02
    }
    if (bestD == 0.0) return none
    r = cleanRuns(r, jsr(0.35 * bestD / msPer).toInt(), jsr(0.35 * bestD / msPer).toInt())
    class Ch(val ch: String, val at: Int, val snr: Double, val word: Boolean)
    var dl = bestD; var sym = ""; var symAt = 0; var symSnr = ArrayList<Double>()
    val chars = ArrayList<Ch>(); var wordNext = false
    fun flush() { if (sym.isNotEmpty()) { chars.add(Ch(MORSE[sym] ?: "?", symAt, pct(symSnr, 0.5), wordNext)); wordNext = false }; sym = ""; symSnr = ArrayList() }
    for (x in r) {
        val ms = x.len * msPer
        if (x.on) {
            if (ms > 5 * bestD) { flush(); wordNext = true; continue }
            if (sym.isEmpty()) symAt = x.at
            val dah = ms > 2 * dl; sym += if (dah) "-" else "."; symSnr.add(x.snr)
            dl = min(1.3 * bestD, max(0.7 * bestD, 0.9 * dl + 0.1 * (if (dah) ms / 3 else ms)))
        } else if (ms > 2 * dl) { flush(); if (ms > 5 * dl) wordNext = true }
    }
    flush()
    var pr = 0.0; var pi = 0.0
    for (x in r) if (x.on && x.len > 8) for (q in x.at + 3 until x.at + x.len - 4) { pr += zr[q + 1] * zr[q] + zi[q + 1] * zi[q]; pi += zi[q + 1] * zr[q] - zr[q + 1] * zi[q] }
    val dfHz = if (pr != 0.0 || pi != 0.0) atan2(pi, pr) * er / (2 * PI) else 0.0
    class Word(var text: String, val at: Int, val snr: ArrayList<Double>)
    val words = ArrayList<Word>()
    for (ch in chars) {
        if (ch.word || words.isEmpty()) words.add(Word("", ch.at, ArrayList()))
        val w = words.last(); w.text += ch.ch; w.snr.add(ch.snr)
    }
    val text = words.joinToString(" ") { it.text }.take(64)
    var best: CwId? = null
    val hasDe = Regex("DE|RPT").containsMatchIn(text)
    for (w in words) {
        val pc = plausibleCall(w.text) ?: continue
        val snrDb = 10 * log10(max(1.0, pct(w.snr, 0.5)))
        val conf = clamp01(1 - 3 * bestCost) * clamp01((snrDb - 3) / 12) * (if (pc.call.length >= 4) 1.0 else 0.85) * (if (pc.suffix.isNotEmpty() || hasDe) 1.0 else 0.95)
        if (best == null || conf > best.confidence) best = CwId(pc.call, pc.suffix, text, jsr(1200 / bestD).toInt(), jsr(f0).toInt(), r2(conf), t0S + w.at / er)
    }
    return CwPass(best, bestD, dfHz)
}

/** The CW ID in one transmission at [rate], given the candidate pitches. */
fun decodeCwId(y: FloatArray, rate: Double, pitches: List<Double>, t0S: Double = 0.0): CwId? {
    var best: CwId? = null
    for (f in pitches) {
        val p1 = cwPass(y, rate, f, 40.0, t0S)
        if (p1.id != null && (best == null || p1.id.confidence > best.confidence)) best = p1.id
        if (p1.ditMs == 0.0) continue
        val bw = min(40.0, max(10.0, 600 / p1.ditMs))
        val p2 = cwPass(y, rate, f + (if (abs(p1.dfHz) < 40) p1.dfHz else 0.0), bw, t0S)
        if (p2.id != null && (best == null || p2.id.confidence > best.confidence)) best = p2.id
    }
    return if (best != null && best.confidence >= 0.3) best else null
}

// ------------------------------------------------------------------------------------------------ selcall
class SelSys(val name: String, val ms: Double, val tones: List<Pair<String, Double>>)
private val D_ZVEI = listOf(2400.0, 1060.0, 1160.0, 1270.0, 1400.0, 1530.0, 1670.0, 1830.0, 2000.0, 2200.0)
private val D_CCIR = listOf(1981.0, 1124.0, 1197.0, 1275.0, 1358.0, 1446.0, 1540.0, 1640.0, 1747.0, 1860.0)
private fun sys(name: String, ms: Double, digits: List<Double>, extra: List<Pair<String, Double>>) = SelSys(name, ms, digits.mapIndexed { i, f -> i.toString() to f } + extra)
/** The published 5-tone tables: digits 0-9, then the extra tones (E is the repeat tone) and the tone length. */
val SELCALL_SYSTEMS = listOf(
    sys("ZVEI1", 70.0, D_ZVEI, listOf("A" to 2800.0, "B" to 810.0, "C" to 970.0, "D" to 885.0, "E" to 2600.0, "F" to 680.0)),
    sys("ZVEI2", 70.0, D_ZVEI, listOf("A" to 885.0, "B" to 810.0, "C" to 740.0, "D" to 680.0, "E" to 970.0, "F" to 2600.0)),
    sys("ZVEI3", 70.0, listOf(2200.0, 970.0, 1060.0, 1160.0, 1270.0, 1400.0, 1530.0, 1670.0, 1830.0, 2000.0), listOf("A" to 885.0, "E" to 2400.0)),
    sys("CCIR1", 100.0, D_CCIR, listOf("A" to 2400.0, "B" to 930.0, "C" to 2247.0, "D" to 991.0, "E" to 2110.0, "F" to 1055.0)),
    sys("CCIR2", 70.0, D_CCIR, listOf("A" to 2400.0, "B" to 930.0, "C" to 2247.0, "D" to 991.0, "E" to 2110.0, "F" to 1055.0)),
    sys("EEA", 40.0, D_CCIR, listOf("A" to 1055.0, "B" to 930.0, "C" to 2247.0, "D" to 991.0, "E" to 2110.0)),
    sys("EIA", 33.0, listOf(600.0, 741.0, 882.0, 1023.0, 1164.0, 1305.0, 1446.0, 1587.0, 1728.0, 1869.0), listOf("A" to 2151.0, "B" to 2433.0, "C" to 2010.0, "D" to 2292.0, "E" to 459.0, "F" to 1091.0)),
)
private fun symbolOf(s: SelSys, hz: Double): String {
    var best = ""; var err = 1.0
    for ((k, f) in s.tones) { val e = abs(hz - f) / f; if (e < err) { err = e; best = k } }
    return if (err <= 0.018) best else ""
}
/** Selcalls in a run of tone segments: the longest run each system explains, the repeat tone resolved. */
fun findSelcalls(segs: List<ToneSeg>): List<Selcall> {
    val out = ArrayList<Selcall>()
    var i = 0
    while (i < segs.size) {
        var pick: SelSys? = null; var pn = 0; var pd = ""; var po = 0; var pr = 0; var zvei12 = false
        for (s in SELCALL_SYSTEMS) {
            var n = 0; var digits = ""; var odd = 0; var reps = 0
            for (j in i until segs.size) {
                val g = segs[j]
                if (g.used || g.ms < 0.65 * s.ms || g.ms > 1.45 * s.ms) break
                if (j > i) { val p = segs[j - 1]; if (g.atS - (p.atS + p.ms / 1000.0) > 0.02) break }
                val k = symbolOf(s, g.hz); if (k.isEmpty()) break
                if (k == "E") { if (digits.isEmpty()) break; digits += digits.last(); reps++ } else { digits += k; if (!k[0].isDigit()) odd++ }
                n++
            }
            if (n < 3) continue
            if (pick == null || n > pn || (n == pn && (odd < po || (odd == po && reps < pr)))) { pick = s; pn = n; pd = digits; po = odd; pr = reps; zvei12 = false }
            else if (n == pn && odd == po && reps == pr && pick.name == "ZVEI1" && s.name == "ZVEI2" && digits == pd) zvei12 = true
        }
        if (pick == null) { i++; continue }
        out.add(Selcall(if (zvei12) "ZVEI" else pick.name, pd, segs[i].atS))
        for (j in i until i + pn) segs[j].used = true
        i += pn
    }
    return out
}

// ------------------------------------------------------------------------------------------------ MDC-1200
private val MDC_SYNC = intArrayOf(0x07, 0x09, 0x2a, 0x44, 0x6f).flatMap { b -> (7 downTo 0).map { (b shr it) and 1 } }.toIntArray()
/** CRC-16 as MDC-1200 uses it: polynomial 0x1021 reflected (0x8408), zero start, inverted at the end. */
fun mdcCrc(bytes: IntArray, n: Int): Int {
    var c = 0
    for (i in 0 until n) { c = c xor bytes[i]; for (k in 0 until 8) c = if (c and 1 != 0) (c ushr 1) xor 0x8408 else c ushr 1 }
    return (c xor 0xffff) and 0xffff
}
private val MDC_LABELS = mapOf(0x01 to "PTT ID", 0x00 to "emergency", 0x20 to "emergency ACK", 0x63 to "radio check")
/**
 * One 112-bit MDC block, laid out as the Mayhem MDC-1200 transmitter (ui_mdc_tx) sends it: seven data bytes (op, arg,
 * unit ID high and low, the CRC low and high, a zero) then seven parity bytes, each byte least significant bit first,
 * parity bit n the XOR of data bits n, n-2, n-5 and n-6; coded bit p goes out as bit (p mod 7) * 16 + p / 7. The CRC
 * decides; a block whose parity disagrees in more than 8 places is refused as well.
 */
private fun mdcBlock(b: IntArray, at: Int): IntArray? {
    if (at + 112 > b.size) return null
    val e = IntArray(112)
    for (i in 0 until 112) e[(i % 16) * 7 + i / 16] = b[at + i]
    val bytes = IntArray(7)
    for (j in 0 until 7) { var x = 0; for (k in 0 until 8) x = x or (e[8 * j + k] shl k); bytes[j] = x }
    if (mdcCrc(bytes, 4) != (bytes[4] or (bytes[5] shl 8))) return null
    var bad = 0
    for (n in 0 until 56) { val p = e[n] xor (if (n >= 2) e[n - 2] else 0) xor (if (n >= 5) e[n - 5] else 0) xor (if (n >= 6) e[n - 6] else 0); if (p != e[56 + n]) bad++ }
    return if (bad <= 8) bytes else null
}
private fun fskDemod(y: FloatArray, from: Int, to: Int, rate: Double, centerHz: Double, bwHz: Double): DoubleArray {
    val n = to - from; val a = 1 - exp(-2 * PI * bwHz / rate); val w = -2 * PI * centerHz / rate; val dr = cos(w); val di = sin(w)
    val C = DoubleArray(n + 1); var cr = 1.0; var ci = 0.0; var r1 = 0.0; var i1 = 0.0; var r2 = 0.0; var i2 = 0.0; var r3 = 0.0; var i3 = 0.0; var pr = 1.0; var pi = 0.0
    for (i in 0 until n) {
        val v = y[from + i].toDouble()
        r1 += a * (v * cr - r1); i1 += a * (v * ci - i1); r2 += a * (r1 - r2); i2 += a * (i1 - i2); r3 += a * (r2 - r3); i3 += a * (i2 - i3)
        val nr = cr * dr - ci * di; ci = cr * di + ci * dr; cr = nr
        if ((i and 255) == 255) { val g = 1 / sqrt(cr * cr + ci * ci); cr *= g; ci *= g }
        C[i + 1] = C[i] + atan2(i3 * pr - r3 * pi, r3 * pr + i3 * pi); pr = r3; pi = i3
    }
    return C
}
private fun cumAt(C: DoubleArray, t: Double): Double { val n = C.size - 1; val k = floor(t).toInt(); return if (k >= n) C[n] else C[k] + (t - k) * (C[k + 1] - C[k]) }
/** MDC-1200 packets in a stretch of audio at [rate]. */
fun decodeMdc(y: FloatArray, from: Int, to: Int, rate: Double, t0S: Double): List<MdcPacket> {
    val n = to - from; if (n < rate * 0.1) return emptyList()
    val C = fskDemod(y, from, to, rate, 1500.0, 1000.0)
    val sps = rate / 1200; val nb = floor((n - sps) / sps).toInt(); val out = ArrayList<MdcPacket>()
    var skipUntil = -1
    var ph = 0
    while (ph < 8 && out.isEmpty()) {
        val t0 = ph * sps / 8; val tb = IntArray(nb) { k -> if (cumAt(C, t0 + (k + 1) * sps) - cumAt(C, t0 + k * sps) > 0) 1 else 0 }
        for (diff in 0 until 2) {
            val b = if (diff == 1) IntArray(nb) { k -> if (k > 0) tb[k] xor tb[k - 1] else tb[k] } else tb
            for (k in 40..nb - 112) {
                if (k < skipUntil) continue
                var err = 0; var errInv = 0
                var q = 0
                while (q < 40 && (err <= 2 || errInv <= 2)) { if (b[k - 40 + q] != MDC_SYNC[q]) err++ else errInv++; q++ }
                if (err > 2 && errInv > 2) continue
                val bits = if (err <= 2) b else IntArray(b.size) { b[it] xor 1 }
                val blk = mdcBlock(bits, k) ?: continue
                val op = blk[0]; val arg = blk[1]; val hi = blk[2]; val lo = blk[3]
                val second = mdcBlock(bits, k + 112)
                out.add(MdcPacket(op, arg, ((hi shl 8) or lo).toString(16).uppercase().padStart(4, '0'), op == 0x00, MDC_LABELS[op] ?: "",
                    second?.take(4) ?: emptyList(), t0S + (from + (k - 40) * sps) / rate))
                skipUntil = k + if (second != null) 224 else 112
            }
            if (out.isNotEmpty()) break
        }
        ph++
    }
    return out
}

// ------------------------------------------------------------------------------------------------ one transmission
private class Frames(val nF: Int, val E: DoubleArray, val kp: IntArray, val fq: DoubleArray, val hi: DoubleArray, val tonal: BooleanArray, val data: BooleanArray, val fsk: BooleanArray, val pitches: List<Double>)

private fun frames(y: FloatArray, rate: Double): Frames {
    val binHz = rate / N; val nF = if (y.size >= N) (y.size - N) / H + 1 else 0
    val E = DoubleArray(nF); val kp = IntArray(nF); val fq = DoubleArray(nF); val hi = DoubleArray(nF); val tonal = BooleanArray(nF); val data = BooleanArray(nF); val fsk = BooleanArray(nF)
    val re = DoubleArray(N); val im = DoubleArray(N); val p = DoubleArray(HALF + 1)
    val kLo = ceil(300 / binHz).toInt(); val kHi = min(HALF - 2, floor(3400 / binHz).toInt())
    val dLo = ceil(900 / binHz).toInt(); val dHi = min(HALF - 1, floor(2700 / binHz).toInt())
    val cLo = max(3, ceil(400 / binHz).toInt()); val cHi = min(HALF - 3, floor(1600 / binHz).toInt())
    val onCnt = IntArray(HALF + 1); val trans = IntArray(HALF + 1); val prevOn = BooleanArray(HALF + 1); val dSum = DoubleArray(HALF + 1)
    for (t in 0 until nF) {
        spectrum(y, t * H, re, im, p)
        var e = 0.0; var k1 = kLo + 1
        for (k in kLo..kHi) { e += p[k]; if (k > kLo && k < kHi && p[k] > p[k1]) k1 = k }
        E[t] = e; kp[t] = k1
        run { val l1 = ln(p[k1 - 1] + 1e-30); val l2 = ln(p[k1] + 1e-30); val l3 = ln(p[k1 + 1] + 1e-30); val den = l1 - 2 * l2 + l3; fq[t] = (k1 + (if (den < 0) 0.5 * (l1 - l3) / den else 0.0)) * binHz }
        val pk = p[k1 - 1] + p[k1] + p[k1 + 1]
        var k2 = -1; for (k in kLo + 1 until kHi) if (abs(k - k1) > 2 && (k2 < 0 || p[k] > p[k2])) k2 = k
        val pk2 = if (k2 > 0) p[k2 - 1] + p[k2] + p[k2 + 1] else 0.0
        tonal[t] = e > 1e-15 && pk >= 0.7 * e
        var fb = 0.0; var fh = 0.0; for (k in dLo..dHi) { fb += p[k]; if (k * binHz > 2150) fh += p[k] }
        hi[t] = if (e > 0) fh / e else 0.0
        data[t] = e > 1e-15 && pk + pk2 < 0.8 * e && fb >= 0.75 * e
        fsk[t] = e > 1e-15 && fb >= 0.75 * e
        for (k in cLo..cHi) {
            val on = p[k] > 1e-15 && p[k] >= p[k - 1] && p[k] >= p[k + 1] && p[k] > 10 * (p[k - 2] + p[k + 2])
            if (on) {
                onCnt[k]++; if (!prevOn[k]) trans[k]++
                val l1 = ln(p[k - 1] + 1e-30); val l2 = ln(p[k]); val l3 = ln(p[k + 1] + 1e-30); val den = l1 - 2 * l2 + l3
                dSum[k] += if (den < 0) 0.5 * (l1 - l3) / den else 0.0
            }
            prevOn[k] = on
        }
    }
    val cand = ArrayList<Pair<Int, Double>>()
    for (k in cLo..cHi) if (trans[k] >= 6) cand.add(k to onCnt[k] + (onCnt[k - 1] + onCnt[k + 1]) / 2.0)
    cand.sortWith(compareBy<Pair<Int, Double>> { -it.second }.thenBy { it.first })
    val pitches = ArrayList<Double>(); val taken = ArrayList<Int>()
    for ((k, _) in cand) { if (taken.any { abs(it - k) <= 1 }) continue; taken.add(k); pitches.add((k + dSum[k] / max(1, onCnt[k])) * binHz); if (pitches.size >= 3) break }
    return Frames(nF, E, kp, fq, hi, tonal, data, fsk, pitches)
}

private fun toneSegments(y: FloatArray, rate: Double, fr: Frames): MutableList<ToneSeg> {
    val out = ArrayList<ToneSeg>(); val raw = ArrayList<IntArray>()
    var t = 0
    while (t < fr.nF) {
        if (!fr.tonal[t]) { t++; continue }
        var u = t + 1; var fs = fr.fq[t]
        while (u < fr.nF && fr.tonal[u] && abs(fr.fq[u] - fs / (u - t)) <= max(20.0, 0.02 * fs / (u - t))) { fs += fr.fq[u]; u++ }
        if (u - t >= 3) {
            val fc = fs / (u - t)
            val a0 = t * H + N / 2 - H; val b0 = (u - 1) * H + N / 2 + H
            val lo = max(0, a0 - 6 * H); val hiS = min(y.size, b0 + 6 * H); val nc = (hiS - lo) / H
            fun mix(f: Double): Pair<DoubleArray, DoubleArray> {
                val zr = DoubleArray(nc); val zi = DoubleArray(nc); val w = 2 * PI * f / rate
                for (c in 0 until nc) { var sr = 0.0; var si = 0.0; for (i in 0 until H) { val n = lo + c * H + i; sr += y[n] * cos(w * n); si -= y[n] * sin(w * n) }; zr[c] = sr; zi[c] = si }
                return zr to zi
            }
            var z = mix(fc)
            val cA = max(0, Math.floorDiv(a0 - lo, H) + 1); val cB = min(nc - 1, Math.floorDiv(b0 - lo, H) - 1)
            var pr = 0.0; var pi = 0.0
            for (c in cA until cB) { pr += z.first[c + 1] * z.first[c] + z.second[c + 1] * z.second[c]; pi += z.second[c + 1] * z.first[c] - z.first[c + 1] * z.second[c] }
            val hz = fc + (if (pr != 0.0 || pi != 0.0) atan2(pi, pr) * rate / (2 * PI * H) else 0.0)
            z = mix(hz)
            val env = DoubleArray(nc) { hypot(z.first[it], z.second[it]) }
            val mid = ArrayList<Double>(); for (c in cA..cB) mid.add(env[c])
            val m = pct(mid, 0.5); var s = max(0, cA); var e = min(nc - 1, cB)
            while (s > 0 && env[s - 1] >= 0.5 * m) s--
            while (e < nc - 1 && env[e + 1] >= 0.5 * m) e++
            out.add(ToneSeg(jsr(hz * 10) / 10, 0.0, 0, m, false))
            raw.add(intArrayOf(t, u, lo + s * H, lo + (e + 1) * H))
        }
        t = u
    }
    for (i in out.indices) {
        var s = raw[i][2]; var e = raw[i][3]
        if (i > 0 && raw[i][0] - raw[i - 1][1] <= 8) s = jsr(((raw[i - 1][1] - 1) * H + raw[i][0] * H) / 2.0 + N / 2).toInt()
        if (i + 1 < out.size && raw[i + 1][0] - raw[i][1] <= 8) e = jsr(((raw[i][1] - 1) * H + raw[i + 1][0] * H) / 2.0 + N / 2).toInt()
        out[i].atS = s / rate; out[i].ms = jsr((e - s) * 1000 / rate).toInt()
    }
    return out
}

private fun subAudio(y: FloatArray, rate: Double): Pair<FloatArray, Double> {
    val d = max(1.0, jsr(rate / 1000)).toInt(); val n = y.size / d; val u = FloatArray(n)
    val m1 = DoubleArray(y.size); var s = 0.0
    for (i in y.indices) { s += y[i]; if (i >= d) s -= y[i - d]; m1[i] = s / d }
    s = 0.0; var j = 0
    for (i in y.indices) { s += m1[i]; if (i >= d) s -= m1[i - d]; if ((i + 1) % d == 0 && j < n) u[j++] = (s / d).toFloat() }
    return u to rate / d
}

private fun ctcssOf(u: FloatArray, ru: Double): Double {
    val from = min(u.size, jsr(0.2 * ru).toInt()); val to = max(from, u.size - jsr(0.4 * ru).toInt())
    if (to - from < ru * 0.6) return 0.0
    var tot = 0.0; for (i in from until to) tot += u[i].toDouble() * u[i]
    var best = 0.0; var bi = -1; var second = 0.0
    for (k in CTCSS_TONES.indices) { val p = goertzel(u, from, to, CTCSS_TONES[k], ru); if (p > best) { second = best; best = p; bi = k } else if (p > second) second = p }
    val frac = best / ((to - from) * tot / 2 + 1e-30)
    return if (bi >= 0 && best > 4 * second && frac > 0.15) CTCSS_TONES[bi] else 0.0
}

private fun reverseBurst(u: FloatArray, ru: Double, f0: Double): Int {
    val B = max(1.0, jsr(ru / 50)).toInt(); val nb = u.size / B
    if (nb < 40) return 0
    val zr = DoubleArray(nb); val zi = DoubleArray(nb); val w = 2 * PI * f0 / ru
    for (j in 0 until nb) { var sr = 0.0; var si = 0.0; for (i in 0 until B) { val n = j * B + i; sr += u[n] * cos(w * n); si -= u[n] * sin(w * n) }; zr[j] = sr; zi[j] = si }
    val ar = DoubleArray(nb) { zr[it] + if (it > 0) zr[it - 1] else 0.0 }; val ai = DoubleArray(nb) { zi[it] + if (it > 0) zi[it - 1] else 0.0 }
    val mag = DoubleArray(nb) { hypot(ar[it], ai[it]) }
    val med = pct(mag.copyOfRange(floor(nb * 0.2).toInt(), floor(nb * 0.8).toInt()), 0.5)
    var je = nb - 1; while (je > 0 && mag[je] < 0.5 * med) je--
    val r0 = je - 75; val r1 = je - 20; if (r0 < 1) return 0
    val ph = ArrayList<Double>(); var prev = atan2(ai[r0], ar[r0]); var acc = prev
    for (j in r0..r1) { val a = atan2(ai[j], ar[j]); acc += wrap(a - prev); prev = a; ph.add(acc) }
    var sx = 0.0; var sy = 0.0; var sxx = 0.0; var sxy = 0.0; val nn = ph.size
    for (i in 0 until nn) { sx += i; sy += ph[i]; sxx += i.toDouble() * i; sxy += i * ph[i] }
    val b = (nn * sxy - sx * sy) / (nn * sxx - sx * sx); val a0 = (sy - b * sx) / nn
    fun res(j: Int) = wrap(atan2(ai[j], ar[j]) - (a0 + b * (j - r0)))
    for (js in je - 14..je - 3) {
        var cr = 0.0; var ci = 0.0; for (j in js..je) { cr += cos(res(j)); ci += sin(res(j)) }
        val m = atan2(ci, cr); val deg = abs(m) * 180 / PI
        if (deg < 90) continue
        var held = true; for (j in js..je) if (abs(wrap(res(j) - m)) > 40 * PI / 180) { held = false; break }
        if (held) return if (deg < 150) 120 else 180
    }
    return 0
}

private fun courtesyAfter(segs: List<ToneSeg>, afterS: Double, voiceAt: (Double, Double) -> Boolean, durS: Double): List<ToneSeg>? {
    var i = 0
    while (i < segs.size) {
        val g = ArrayList<ToneSeg>(); var j = i
        while (j < segs.size && !segs[j].used && (g.isEmpty() || segs[j].atS - (g.last().atS + g.last().ms / 1000.0) < 0.15)) { g.add(segs[j]); j++ }
        if (g.isEmpty()) { i++; continue }
        val s = g[0].atS; val e = g.last().atS + g.last().ms / 1000.0
        if (s >= afterS - 0.05 && g.size <= 6 && e - s <= 2 && g.all { it.ms in 25..600 } && !voiceAt(s, e) && durS - e >= 0.1) return g
        i = j
    }
    return null
}

private fun near(a: Double, b: Double, rel: Double, abs: Double) = kotlin.math.abs(a - b) <= max(abs, rel * max(a, b))

class AnalogSignaling(val fs: Double, val audio: Boolean = false) {
    /** Decimation to about 8 kHz and the rate it gives. */
    val D = max(1.0, jsr(fs / 8000)).toInt(); val rate = fs / D
    var carrier = false; private set
    val txs = ArrayList<AnalogTx>()
    var onTx: (AnalogTx) -> Unit = {}
    private val B = max(1.0, jsr(fs * 0.01)).toInt()
    private var bN = 0; private var bE = 0.0; private var bD = 0.0; private var prev = 0.0; private var onRun = 0; private var offRun = 0; private var onStart = 0L; private var offStart = 0L
    private var acc = 0.0; private var accN = 0; private var pos = 0L; private var dpos = 0L
    private var buf = FloatArray(1 shl 16); private var blen = 0; private var bufAt = 0L; private var txStart = 0L
    private class Votes(var count: Int, var miss: Double)
    private val calls = LinkedHashMap<String, Votes>()
    private class Print(val key: String, val tones: List<AnalogTone>, var count: Int)
    private val prints = ArrayList<Print>()
    private val timeouts = ArrayList<Double>()

    fun reset() {
        carrier = false; txs.clear(); bN = 0; bE = 0.0; bD = 0.0; prev = 0.0; onRun = 0; offRun = 0
        acc = 0.0; accN = 0; pos = 0; dpos = 0; blen = 0; bufAt = 0; txStart = 0
        calls.clear(); prints.clear(); timeouts.clear()
    }
    fun push(x: FloatArray, n: Int) {
        for (i in 0 until n) {
            val v = x[i].toDouble(); bE += v * v; val d = v - prev; prev = v; bD += d * d
            acc += v; pos++
            if (++accN == D) { append((acc / D).toFloat()); acc = 0.0; accN = 0 }
            if (++bN == B) block()
        }
    }
    /** Ends a transmission still open (the end of a recording). */
    fun flush() { if (carrier) { carrier = false; endTx(dpos) }; onRun = 0; offRun = 0 }

    private fun append(v: Float) {
        if (blen == buf.size) buf = buf.copyOf(buf.size * 2)
        buf[blen++] = v; dpos++
        if (!carrier && onRun == 0 && blen > 2 * rate) { val keep = jsr(rate).toInt(); System.arraycopy(buf, blen - keep, buf, 0, keep); bufAt += blen - keep; blen = keep }
        if (carrier && dpos - txStart > 240 * rate) { endTx(dpos); txStart = dpos }
    }
    private fun block() {
        val on = if (audio) bE / B > 1e-7 else (bD / B < 1.0 && bE / B > 1e-9)
        bN = 0; bE = 0.0; bD = 0.0
        val start = pos - B
        if (on) {
            offRun = 0
            if (!carrier) { if (onRun == 0) onStart = start; if (++onRun >= 2) { carrier = true; onRun = 0; txStart = max(bufAt, Math.floorDiv(onStart, D.toLong())) } }
        } else {
            onRun = 0
            if (carrier) { if (offRun == 0) offStart = start; if (++offRun >= 4) { carrier = false; offRun = 0; endTx(Math.floorDiv(offStart, D.toLong())) } }
        }
    }
    private fun endTx(end: Long) {
        val a = (txStart - bufAt).toInt(); val b = min(blen.toLong(), end - bufAt).toInt()
        if (b - a >= jsr(0.08 * rate)) {
            val tx = analyze(buf.copyOfRange(a, b), txStart / rate)
            remember(tx); txs.add(tx); if (txs.size > 30) txs.removeAt(0); onTx(tx)
        }
        val drop = max(0L, min(blen.toLong(), end - bufAt)).toInt()
        System.arraycopy(buf, drop, buf, 0, blen - drop); blen -= drop; bufAt += drop
    }

    /** Reads one transmission ([y] at [rate], starting [startS] into the channel). */
    fun analyze(y: FloatArray, startS: Double): AnalogTx {
        val durS = y.size / rate; val fr = frames(y, rate)
        fun ft(t: Int) = (t * H + N / 2) / rate
        val lowE = pct(fr.E, 0.2); val vThr = max(6 * lowE, 1e-12)
        val voice = BooleanArray(fr.nF) { !fr.tonal[it] && !fr.data[it] && fr.E[it] > vThr }
        var voiceF = 0; var lastVoice = -1
        var t = 0
        while (t < fr.nF) {
            if (!voice[t]) { t++; continue }
            var u = t; var gap = 0; var cnt = 0
            while (u < fr.nF && gap < 75) { if (voice[u]) { gap = 0; cnt++ } else gap++; u++ }
            val end = u - gap
            if (end - t >= 15) { voiceF += cnt; lastVoice = end } else for (j in t until end) voice[j] = false
            t = u
        }
        val voiceS = voiceF * H / rate; val lastVoiceS = if (lastVoice >= 0) ft(lastVoice) else -1.0
        val voiceAt = { s: Double, e: Double -> var hit = false; for (q in 0 until fr.nF) { val c = ft(q); if (c >= s && c <= e && voice[q]) { hit = true; break } }; hit }

        val segs = toneSegments(y, rate, fr)
        val selcall = findSelcalls(segs).map { it.copy(atS = it.atS + startS) }
        val twoTone = ArrayList<TwoTone>()
        var i = 0
        while (i + 1 < segs.size) {
            val a = segs[i]; val b = segs[i + 1]
            if (a.used || b.used || a.ms < 350 || b.ms < 600 || b.atS - (a.atS + a.ms / 1000.0) > 0.25 || abs(a.hz - b.hz) < 20 ||
                a.hz < 280 || a.hz > 3000 || b.hz < 280 || b.hz > 3000) { i++; continue }
            twoTone.add(TwoTone(jsr(a.hz).toInt(), jsr(b.hz).toInt(), a.ms, b.ms, startS + a.atS)); a.used = true; b.used = true; i += 2
        }
        val mdc = ArrayList<MdcPacket>(); val data = ArrayList<DataBurst>()
        t = 0
        while (t < fr.nF) {
            if (!fr.fsk[t]) { t++; continue }
            var u = t + 1; var gap = 0; var cnt = 1; var strict = if (fr.data[t]) 1 else 0
            while (u < fr.nF && gap < 25) { if (fr.fsk[u]) { gap = 0; cnt++; if (fr.data[u]) strict++ } else gap++; u++ }
            u -= gap
            if (cnt >= 10 && cnt >= 0.6 * (u - t)) {
                val from = max(0, t * H - 24 * H); val to = min(y.size, u * H + N + 24 * H)
                val got = decodeMdc(y, from, to, rate, startS)
                if (got.isNotEmpty()) mdc.addAll(got)
                else if (strict >= 10 && strict >= 0.5 * cnt) {
                    var hs = 0.0; var hn = 0; for (j in t until u) if (fr.fsk[j]) { hs += fr.hi[j]; hn++ }
                    data.add(DataBurst(if (hs / hn > 0.08) 2400 else 1200, jsr((u - t) * H * 1000 / rate).toInt(), startS + ft(t)))
                }
            }
            t = u
        }
        val cw = decodeCwId(y, rate, fr.pitches, startS)
        if (cw != null) for (s in segs) if (abs(s.hz - cw.pitchHz) < 40 && s.ms < 400) s.used = true
        val cg = courtesyAfter(segs, lastVoiceS, voiceAt, durS)
        var courtesy: CourtesyTone? = null
        if (cg != null) {
            val tones = cg.map { AnalogTone(jsr(it.hz).toInt(), (jsr(it.ms / 10.0) * 10).toInt()) }
            courtesy = CourtesyTone(tones, tones.joinToString("+") { "${(jsr(it.hz / 5.0) * 5).toInt()}x${it.ms}" }, startS + cg[0].atS, 0)
        }
        val (u, ru) = subAudio(y, rate)
        val ctcss = ctcssOf(u, ru)
        val rb = if (ctcss != 0.0) reverseBurst(u, ru, ctcss) else 0
        val sub = SubAudioDecoder(rate); val counts = LinkedHashMap<Int, Int>(); var dcs = 0; var dcsN = 0
        val chunk = FloatArray(400); var q = 0
        while (q < y.size) { val m = min(400, y.size - q); System.arraycopy(y, q, chunk, 0, m); sub.push(chunk, m); if (sub.dcs != 0) counts[sub.dcs] = (counts[sub.dcs] ?: 0) + 1; q += 400 }
        for ((c, k) in counts) if (k > dcsN || (k == dcsN && c < dcs)) { dcs = c; dcsN = k }
        if (ctcss != 0.0) dcs = 0
        var dcsTurnOff = false
        if (dcs != 0 && ctcss == 0.0) {
            val e0 = u.size - jsr(0.02 * ru).toInt(); val e1 = u.size - jsr(0.17 * ru).toInt(); val p0 = u.size - jsr(0.6 * ru).toInt(); val p1 = u.size - jsr(0.25 * ru).toInt()
            fun ratio(a: Int, b: Int): Double { var tt = 0.0; for (k in a until b) tt += u[k].toDouble() * u[k]; return goertzel(u, a, b, 134.4, ru) / ((b - a) * tt / 2 + 1e-30) }
            if (p0 > 0) dcsTurnOff = ratio(e1, e0) > 0.5 && ratio(p0, p1) < 0.3
        }
        val unkeyS = if (lastVoiceS >= 0) min(durS, lastVoiceS) else courtesy?.let { it.atS - startS } ?: -1.0
        val tailS = if (unkeyS >= 0) r2(durS - unkeyS) else -1.0
        val timeout = durS >= 25 && lastVoiceS >= 0 && durS - lastVoiceS < 0.25 && courtesy == null
        val kerchunk = voiceS < 0.3 && cw == null && selcall.isEmpty() && twoTone.isEmpty() && mdc.isEmpty() && data.isEmpty() && durS < 15
        return AnalogTx(jsr(startS * 1000) / 1000, jsr(durS * 1000) / 1000, r2(voiceS), if (unkeyS >= 0) r2(unkeyS) else -1.0, tailS, ctcss, dcs, rb, dcsTurnOff,
            courtesy, cw, selcall, twoTone, mdc, data, timeout, kerchunk)
    }

    private fun remember(tx: AnalogTx) {
        tx.cw?.let { c -> val k = c.callsign + if (c.suffix.isNotEmpty()) "/" + c.suffix else ""; val v = calls.getOrPut(k) { Votes(0, 1.0) }; v.count++; v.miss *= 1 - c.confidence }
        tx.courtesy?.let { c ->
            var p = prints.firstOrNull { q -> q.tones.size == c.tones.size && q.tones.indices.all { near(q.tones[it].hz.toDouble(), c.tones[it].hz.toDouble(), 0.015, 8.0) && near(q.tones[it].ms.toDouble(), c.tones[it].ms.toDouble(), 0.2, 20.0) } }
            if (p == null) { p = Print(c.key, c.tones, 0); prints.add(p) }
            p.count++; c.key = p.key; c.seen = p.count
        }
        if (tx.timeout) timeouts.add(tx.durS)
    }

    fun snapshot(): AnalogSnap {
        var cwId: AnalogCwId? = null
        for ((k, v) in calls) { val conf = r2(min(0.99, 1 - v.miss)); val b = cwId; if (b == null || v.count > b.count || (v.count == b.count && conf > b.confidence)) cwId = AnalogCwId(k, v.count, conf) }
        return AnalogSnap(carrier, txs.toList(), cwId, prints.map { AnalogPrint(it.key, it.tones, it.count) }, if (timeouts.isNotEmpty()) jsr(pct(timeouts, 0.5) * 10) / 10 else 0.0)
    }
}

/** One line per thing heard in a transmission, for the UI (app copy: no dashes as punctuation, no colons). */
fun analogSummary(tx: AnalogTx): List<String> {
    val out = ArrayList<String>()
    tx.cw?.let { out.add("CW ID ${it.callsign}${if (it.suffix.isNotEmpty()) "/" + it.suffix else ""}, ${it.wpm} WPM") }
    for (s in tx.selcall) out.add("${s.system} selcall ${s.digits}")
    for (t in tx.twoTone) out.add("2-tone page ${t.aHz} and ${t.bHz} Hz")
    for (m in tx.mdc) out.add("MDC-1200 unit ${m.unit}${if (m.label.isNotEmpty()) " " + m.label else " op " + m.op.toString(16).uppercase().padStart(2, '0')}")
    for (d in tx.data) out.add("${d.baud} baud data burst")
    if (tx.ctcss != 0.0) out.add("PL ${String.format(Locale.US, "%.1f", tx.ctcss)}${if (tx.reverseBurst != 0) ", reverse burst ${tx.reverseBurst}°" else ""}")
    if (tx.dcs != 0) out.add("DCS ${tx.dcs.toString().padStart(3, '0')}${if (tx.dcsTurnOff) ", turn-off code" else ""}")
    tx.courtesy?.let { c -> out.add("Courtesy tone ${c.tones.joinToString(" ") { it.hz.toString() }} Hz${if (c.seen > 1) ", heard ${c.seen} times" else ""}") }
    if (tx.tailS >= 0) out.add("Tail ${String.format(Locale.US, "%.1f", tx.tailS)} s")
    if (tx.timeout) out.add("Timed out after ${jsr(tx.durS).toInt()} s")
    if (tx.kerchunk) out.add("Kerchunk")
    return out
}
