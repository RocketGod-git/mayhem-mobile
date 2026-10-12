package com.rocketgod.mayhem.core.audio

import com.rocketgod.mayhem.core.BitSync
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/** DC blocker then a 4th-order Butterworth low-pass, for discriminator audio ahead of a tone demodulator. */
internal class DiscFilter(cutoffHz: Double, rate: Double, dcHz: Double = 40.0) {
    private var dcX = 0.0; private var dcY = 0.0
    private val dcA = exp(-2 * Math.PI * dcHz / rate)
    private val b0 = DoubleArray(2); private val b1 = DoubleArray(2); private val b2 = DoubleArray(2)
    private val a1 = DoubleArray(2); private val a2 = DoubleArray(2); private val z1 = DoubleArray(2); private val z2 = DoubleArray(2)
    init {
        for ((k, q) in doubleArrayOf(0.5412, 1.3066).withIndex()) {
            val w0 = 2 * Math.PI * min(0.45 * rate, cutoffHz) / rate; val alpha = sin(w0) / (2 * q); val c = cos(w0); val a0 = 1 + alpha
            b0[k] = (1 - c) / 2 / a0; b1[k] = (1 - c) / a0; b2[k] = (1 - c) / 2 / a0; a1[k] = -2 * c / a0; a2[k] = (1 - alpha) / a0
        }
    }
    fun push(x: Double): Double {
        val y = x - dcX + dcA * dcY; dcX = x; dcY = y
        var v = y
        for (k in 0 until 2) { val o = b0[k] * v + z1[k]; z1[k] = b1[k] * v - a1[k] * o + z2[k]; z2[k] = b2[k] * v - a2[k] * o; v = o }
        return v
    }
}

data class SameLocation(val code: String, val portion: Int, val state: String, val county: String)
data class SameHeader(
    val originator: String, val originatorName: String, val event: String, val eventName: String,
    val locations: List<SameLocation>, val hours: Int, val minutes: Int,
    /** Day of year and UTC time of issue. */
    val day: Int, val hour: Int, val minute: Int, val callsign: String,
)
/** [event] is header, eom (the alert is over) or tone (the attention tone, which is what marks an alert as real). */
data class SameEvent(val event: String, val header: SameHeader?, val raw: String, val repeats: Int)

const val SAME_BAUD = 520 + 5.0 / 6

val SAME_ORIGINATORS = mapOf("PEP" to "Primary Entry Point", "CIV" to "Civil authorities", "WXR" to "National Weather Service", "EAS" to "Broadcast station")

val SAME_EVENTS = mapOf(
    "RWT" to "Required Weekly Test", "RMT" to "Required Monthly Test", "NPT" to "National Periodic Test", "DMO" to "Practice/Demo",
    "ADR" to "Administrative Message", "EAN" to "Emergency Action Notification", "EAT" to "Emergency Action Termination",
    "TOR" to "Tornado Warning", "TOA" to "Tornado Watch", "SVR" to "Severe Thunderstorm Warning", "SVA" to "Severe Thunderstorm Watch",
    "SVS" to "Severe Weather Statement", "SPS" to "Special Weather Statement",
    "FFW" to "Flash Flood Warning", "FFA" to "Flash Flood Watch", "FFS" to "Flash Flood Statement",
    "FLW" to "Flood Warning", "FLA" to "Flood Watch", "FLS" to "Flood Statement",
    "WSW" to "Winter Storm Warning", "WSA" to "Winter Storm Watch", "BZW" to "Blizzard Warning",
    "HWW" to "High Wind Warning", "HWA" to "High Wind Watch", "EWW" to "Extreme Wind Warning",
    "HUW" to "Hurricane Warning", "HUA" to "Hurricane Watch", "HLS" to "Hurricane Statement",
    "TRW" to "Tropical Storm Warning", "TRA" to "Tropical Storm Watch",
    "SMW" to "Special Marine Warning", "CFW" to "Coastal Flood Warning", "CFA" to "Coastal Flood Watch",
    "TSW" to "Tsunami Warning", "TSA" to "Tsunami Watch", "DSW" to "Dust Storm Warning",
    "FRW" to "Fire Warning", "AVW" to "Avalanche Warning", "AVA" to "Avalanche Watch", "VOW" to "Volcano Warning", "EQW" to "Earthquake Warning",
    "EVI" to "Evacuation Immediate", "CEM" to "Civil Emergency Message", "CDW" to "Civil Danger Warning", "CAE" to "Child Abduction Emergency",
    "LEW" to "Law Enforcement Warning", "LAE" to "Local Area Emergency", "HMW" to "Hazardous Materials Warning",
    "NUW" to "Nuclear Power Plant Warning", "RHW" to "Radiological Hazard Warning", "SPW" to "Shelter in Place Warning",
    "TOE" to "911 Telephone Outage Emergency", "NMN" to "Network Message Notification",
)

/**
 * Anchored at the start only: a copy closed by noise may carry junk after its final '-', and the structure is
 * fixed-width once the location list ends, so the match itself tells where the header stops.
 */
private val HEADER_RE = Regex("^ZCZC-([A-Z]{3})-([A-Z]{3})((?:-\\d{6}){1,31})\\+(\\d{4})-(\\d{7})-([\\x20-\\x7e]{8})-")
private const val MAX_MSG = 256

/** Parse a raw header; null when it does not fit the structure or carries an impossible time. */
fun parseSameHeader(raw: String): SameHeader? {
    val m = HEADER_RE.find(raw) ?: return null
    val (originator, event, locs, tttt, jjjhhmm, call) = m.destructured
    val locations = locs.substring(1).split('-').map { SameLocation(it, it[0].digitToInt(), it.substring(1, 3), it.substring(3)) }
    val hours = tttt.substring(0, 2).toInt(); val minutes = tttt.substring(2).toInt()
    val day = jjjhhmm.substring(0, 3).toInt(); val hour = jjjhhmm.substring(3, 5).toInt(); val minute = jjjhhmm.substring(5).toInt()
    // A time that cannot exist means a corrupted digit survived the vote: better silent than wrong by a day.
    if (minutes > 59 || day < 1 || day > 366 || hour > 23 || minute > 59) return null
    return SameHeader(originator, SAME_ORIGINATORS[originator] ?: originator, event, SAME_EVENTS[event] ?: event,
        locations, hours, minutes, day, hour, minute, call.trim())
}

private fun headerEnd(raw: String) = HEADER_RE.find(raw)?.value?.length ?: 0
/** How many of the first four characters agree with the expected opener; a shifted or junk copy scores under three. */
private fun opener(s: String, want: String): Int { var n = 0; for (i in 0 until 4) if (i < s.length && s[i] == want[i]) n++; return n }

/**
 * NOAA Weather Radio / EAS "SAME" decoder: the 520.83 baud AFSK burst that opens and closes every alert, on the NFM
 * discriminator. A header is sent three times; each copy is decoded on its own and the copies are voted character
 * by character, and only a result that fits the published structure exactly is reported — a half-parsed alert is
 * worse than none, because someone may act on it. Decisions are sign-based, so any input scale works, 24–96 kHz.
 */
class SameDecoder(private val emit: (SameEvent) -> Unit) {
    private var rate = 0
    private var t = 0L
    // sliding one-bit correlators for the two tones (mark: four cycles a bit, space: three — orthogonal over a bit)
    private var spb = 92
    private var ring = DoubleArray(92); private var ri = 0
    private var ph1 = 0.0; private var ph2 = 0.0; private var w1 = 0.0; private var w2 = 0.0
    private var c1 = 0.0; private var s1 = 0.0; private var c2 = 0.0; private var s2 = 0.0
    private var sinceRecompute = 0
    private var sync = BitSync(SAME_BAUD, 48000.0)
    private var filt = DiscFilter(3000.0, 48000.0)
    private var sr = 0
    private var synced = false
    private var cur = 0; private var bitIdx = 0
    private val msg = StringBuilder()
    private var inMsg = false
    private class Group(val kind: String, val copies: ArrayList<String>, var lastT: Long)
    private var group: Group? = null
    // attention tone: Goertzel bins (1050, 853, 960 Hz) over 50 ms blocks
    private var blockN = 2400
    private var coef = DoubleArray(3)
    private val g1 = DoubleArray(3); private val g2 = DoubleArray(3)
    private var energy = 0.0; private var blockI = 0
    private var toneRun = 0; private var toneKind = ""; private var toneQuiet = 0; private var toneArmed = true

    fun reset(rate: Int) { if (rate > 0) configure(rate) else this.rate = 0 }

    private fun configure(rate: Int) {
        this.rate = rate; t = 0
        spb = max(8, (rate / SAME_BAUD).roundToInt())
        ring = DoubleArray(spb); ri = 0
        w1 = 2 * Math.PI * 4 * SAME_BAUD / rate; w2 = 2 * Math.PI * 3 * SAME_BAUD / rate
        ph1 = 0.0; ph2 = 0.0; c1 = 0.0; s1 = 0.0; c2 = 0.0; s2 = 0.0; sinceRecompute = 0
        sync = BitSync(SAME_BAUD, rate.toDouble())
        filt = DiscFilter(3000.0, rate.toDouble())     // both tones sit under 2.1 kHz
        sr = 0; synced = false; cur = 0; bitIdx = 0; msg.setLength(0); inMsg = false
        group = null
        blockN = (rate / 20.0).roundToInt()
        coef = doubleArrayOf(1050.0, 853.0, 960.0).map { 2 * cos(2 * Math.PI * it / rate) }.toDoubleArray()
        g1.fill(0.0); g2.fill(0.0); energy = 0.0; blockI = 0
        toneRun = 0; toneKind = ""; toneQuiet = 0; toneArmed = true
    }

    fun onFm(samples: FloatArray, n: Int, rate: Int) {
        if (rate != this.rate) configure(rate)
        val twoPi = 2 * Math.PI
        for (i in 0 until n) {
            val x = filt.push(samples[i].toDouble())
            val old = ring[ri]
            ring[ri] = x
            ri = if (ri + 1 >= spb) 0 else ri + 1
            var o1 = ph1 - w1 * spb; while (o1 < 0) o1 += twoPi
            var o2 = ph2 - w2 * spb; while (o2 < 0) o2 += twoPi
            c1 += x * cos(ph1) - old * cos(o1); s1 += x * sin(ph1) - old * sin(o1)
            c2 += x * cos(ph2) - old * cos(o2); s2 += x * sin(ph2) - old * sin(o2)
            ph1 += w1; if (ph1 >= twoPi) ph1 -= twoPi
            ph2 += w2; if (ph2 >= twoPi) ph2 -= twoPi
            if (++sinceRecompute >= 4096) { sinceRecompute = 0; recompute() }
            val d = (c1 * c1 + s1 * s1) - (c2 * c2 + s2 * s2)
            val b = sync.push(d.toFloat())
            if (b >= 0) pushBit(b)
            tone(x)
        }
        t += n
        // a copy that never came: report what the earlier copies agreed on once the third is overdue
        group?.let { if (t - it.lastT > 2.5 * this.rate) finalize() }
    }

    /** Rebuild the running sums from the ring so floating-point drift never accumulates across a long watch. */
    private fun recompute() {
        val twoPi = 2 * Math.PI
        c1 = 0.0; s1 = 0.0; c2 = 0.0; s2 = 0.0
        for (j in 0 until spb) {
            val v = ring[(ri + j) % spb]
            var a1 = ph1 - w1 * (spb - j); while (a1 < 0) a1 += twoPi
            var a2 = ph2 - w2 * (spb - j); while (a2 < 0) a2 += twoPi
            c1 += v * cos(a1); s1 += v * sin(a1); c2 += v * cos(a2); s2 += v * sin(a2)
        }
    }

    private fun pushBit(bit: Int) {
        sr = (sr ushr 1) or (bit shl 31)
        if (!synced) {
            // 0xAB's eight rotations are all distinct, so one byte fixes the alignment; four in a row make a preamble
            if (sr == 0xabababab.toInt()) { synced = true; bitIdx = 0; cur = 0; msg.setLength(0); inMsg = false }
            return
        }
        cur = (cur shr 1) or (bit shl 7)
        if (++bitIdx < 8) return
        val byte = cur; bitIdx = 0; cur = 0
        if (!inMsg) {
            if (byte == 0xab) return
            inMsg = true
        }
        if (byte < 0x20 || byte > 0x7e || msg.length >= MAX_MSG) { close(); return }
        msg.append(byte.toChar())
        // a clean copy ends on its final '-' (or the fourth N); closing there keeps what follows out of the vote
        if (msg.toString() == "NNNN" || HEADER_RE.containsMatchIn(msg)) close()
    }

    private fun close() {
        val s = msg.toString()
        synced = false; inMsg = false; msg.setLength(0); cur = 0; bitIdx = 0; sr = 0
        val kind = if (opener(s, "ZCZC") >= 3) "header" else if (opener(s, "NNNN") >= 3) "eom" else return
        val now = t
        group?.let { if (it.kind != kind || now - it.lastT > 4L * rate) finalize() }
        val g = group ?: Group(kind, ArrayList(), now).also { group = it }
        g.copies.add(s); g.lastT = now
        if (g.copies.size >= 3) finalize()
    }

    /** Vote the copies character by character, then insist the result is well-formed before saying anything. */
    private fun finalize() {
        val g = group ?: return
        group = null
        // clean copies break ties: a copy that matched the structure on its own is the better witness
        val copies = g.copies.sortedByDescending { if (headerEnd(it) > 0 || it == "NNNN") 1 else 0 }
        val len = copies.maxOf { it.length }
        val voted = StringBuilder()
        for (i in 0 until len) {
            val tally = HashMap<Char, Int>()
            var best = ' '; var bestN = 0
            for (c in copies) {
                if (i >= c.length) continue
                val n = (tally[c[i]] ?: 0) + 1; tally[c[i]] = n
                if (n > bestN) { bestN = n; best = c[i] }
            }
            voted.append(best)
        }
        val v = voted.toString()
        if (g.kind == "eom") { if (v.startsWith("NNNN")) emit(SameEvent("eom", null, "NNNN", copies.size)); return }
        val raw = v.substring(0, headerEnd(v))
        val header = if (raw.isNotEmpty()) parseSameHeader(raw) else null
        if (header != null) emit(SameEvent("header", header, raw, copies.size))
    }

    /**
     * Attention tone: 1050 Hz on NWR, 853 + 960 Hz on EAS, judged as the share of the block's energy in the bin so it
     * is level-independent. Half a second of it is required before it is reported, once per tone.
     */
    private fun tone(x: Double) {
        for (k in 0 until 3) { val s0 = x + coef[k] * g1[k] - g2[k]; g2[k] = g1[k]; g1[k] = s0 }
        energy += x * x
        if (++blockI < blockN) return
        val nn = blockN; val e = energy
        fun frac(k: Int): Double { val p = g1[k] * g1[k] + g2[k] * g2[k] - coef[k] * g1[k] * g2[k]; return if (e > 0) 2 * p / (nn * e) else 0.0 }
        val f1050 = frac(0); val f853 = frac(1); val f960 = frac(2)
        g1.fill(0.0); g2.fill(0.0); energy = 0.0; blockI = 0
        val kind = if (f1050 > 0.6) "1050 Hz" else if (f853 > 0.25 && f960 > 0.25 && f853 + f960 > 0.6) "853+960 Hz" else ""
        if (kind.isNotEmpty() && kind == toneKind) { toneRun++; toneQuiet = 0 }
        else if (kind.isNotEmpty()) { toneKind = kind; toneRun = 1; toneQuiet = 0 }
        else if (++toneQuiet >= 4) { toneRun = 0; toneKind = ""; toneArmed = true }
        if (toneArmed && toneRun >= 10) { toneArmed = false; emit(SameEvent("tone", null, toneKind, 1)) }
    }
}
