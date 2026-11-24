package com.rocketgod.mayhem.core.hamid

import com.rocketgod.mayhem.core.ham.hamSyncSigns
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/**
 * What an FM channel carries, from its discriminator: analog voice, DMR, D-STAR, Fusion (YSF), P25 or NXDN, named by
 * their sync words in the 4800/s and 2400/s symbol streams once two sit on the mode's frame grid; a channel that has
 * named none for 0.6 s is analog. M17's 8-symbol syncs count only one frame (192 symbols) after another. The same as the web's dsp/hamid/mode.ts.
 */
val HAM_MODES = listOf("DMR", "D-STAR", "YSF", "P25", "NXDN", "M17")
private val DMR_P = hamSyncSigns("DMR"); private val P25_P = hamSyncSigns("P25"); private val NXDN_P = hamSyncSigns("NXDN")
private fun signs(s: String) = IntArray(s.length) { if (s[it] == '1') 1 else -1 }
private val DS_FS = signs("1010101010101010$DSTAR_FS"); private val DS_SYNC = signs(DSTAR_DSYNC)
private val YSF_E = YSF_SYNC.sumOf { it * it }
private val M17_P = listOf(M17_SYNC_LSF, M17_SYNC_PACKET).map { w -> m17SyncSymbols(w).map { if (it > 0) 1 else -1 }.toIntArray() }
private val NEED = mapOf("DMR" to 3, "D-STAR" to 2, "YSF" to 2, "P25" to 2, "NXDN" to 3, "M17" to 6)
private val PERIOD = mapOf("DMR" to 144, "D-STAR" to 2016, "YSF" to 480, "P25" to 864, "NXDN" to 384, "M17" to 192)
private const val HOLD_S = 2

class ModeResult(val mode: String, val hits: Map<String, Int>, val seconds: Double)

class ModeDetector(val fs: Double) {
    var onSymbol48: (Double) -> Unit = {}
    private val s48 = DiscSymbols(fs, 4800.0); private val s24 = DiscSymbols(fs, 2400.0, false)
    private val r48 = DoubleArray(40); private var p48 = 0
    private val r24 = DoubleArray(24); private var p24 = 0
    private val hits = HashMap<String, ArrayList<Long>>()
    private var t48 = 0L; private val lastHit48 = HashMap<String, Long>(); private var t24 = 0L; private var lastHit24 = -1_000_000_000L
    private var samples = 0L; private val m17Cand = ArrayDeque<Long>()
    /** The last 192 symbols (the eye at a sync), each mode's eye votes, and its consecutive sync spacings on and off its grid. */
    private val eyeRing = DoubleArray(192); private var ep = 0
    private val eyes = HashMap<String, EyeVotes>(); private val lastAt = HashMap<String, Long>(); private val spacing = HashMap<String, IntArray>()
    private var sticky = ""

    init { s48.onSymbol = { sym48(it) }; s24.onSymbol = { sym24(it) } }
    fun reset() { s48.reset(); s24.reset(); r48.fill(0.0); r24.fill(0.0); p48 = 0; p24 = 0; hits.clear(); lastHit48.clear(); t48 = 0; t24 = 0; lastHit24 = -1_000_000_000L; samples = 0; m17Cand.clear(); sticky = ""
        eyeRing.fill(0.0); ep = 0; eyes.clear(); lastAt.clear(); spacing.clear() }

    fun push(disc: FloatArray, n: Int) { samples += n; s48.push(disc, n); s24.push(disc, n) }

    fun hit(mode: String, t: Long) {
        val last = lastHit48[mode] ?: -1_000_000_000L
        if (t - last < 8) return
        lastHit48[mode] = t
        hits.getOrPut(mode) { ArrayList() }.add(t)
        val prev = lastAt[mode]
        if (prev != null) { val sp = spacing.getOrPut(mode) { IntArray(2) }; if (onGrid(t - prev, PERIOD.getValue(mode))) sp[0]++ else sp[1]++ }
        lastAt[mode] = t
        if (mode == "P25" || mode == "M17") { val v = eyes.getOrPut(mode) { EyeVotes() }; if (eyeLevels(eyeRing) == 4) v.four++ else v.other++ }
    }
    /** The eye votes at [mode]'s syncs (P25 and M17). */
    fun eye(mode: String): EyeVotes? = eyes[mode]
    /** [mode]'s syncs came off its frame grid more often than on it: whatever passes that mode's checks is chance. */
    fun offGrid(mode: String): Boolean { val sp = spacing[mode] ?: return false; return sp[1] > sp[0] }
    /** Consecutive sync spacings of [mode]: on the grid, off it. */
    fun syncSpacing(mode: String): Pair<Int, Int> { val sp = spacing[mode] ?: return Pair(0, 0); return Pair(sp[0], sp[1]) }

    private fun corrSigns(ring: DoubleArray, p: Int, pat: IntArray): Pair<Double, Double> {
        val R = ring.size; val n = pat.size
        var c = 0.0; var a = 0.0
        for (k in 0 until n) { val x = ring[(p - n + k + R) % R]; c += x * pat[k]; a += if (x < 0) -x else x }
        return Pair(if (a > 0) c / a else 0.0, a / n)
    }

    private fun sym48(s: Double) {
        onSymbol48(s)
        val t = ++t48
        r48[p48] = s; p48 = (p48 + 1) % 40
        eyeRing[ep] = s; ep = (ep + 1) % 192
        for (pat in DMR_P) { val m = corrSigns(r48, p48, pat); if (m.first > 0.85 && m.second > 1.8) { hit("DMR", t); break } }
        for (pat in P25_P) { val m = corrSigns(r48, p48, pat); if (m.first > 0.86 && m.second > 1.8) { hit("P25", t); break } }
        var c = 0.0; var e = 0.0
        for (k in 0 until 20) { val x = r48[(p48 - 20 + k + 40) % 40]; c += x * YSF_SYNC[k]; e += x * x }
        if (e > 0 && abs(c / sqrt(e * YSF_E)) > 0.9) hit("YSF", t)
        // M17's sync is only 8 symbols: a candidate counts when others came one and two frames (192 and 384 symbols)
        // before it. Voice payloads and noise match it by chance too, so every candidate of the last two frames is kept.
        for (pat in M17_P) {
            val m = corrSigns(r48, p48, pat)
            if (abs(m.first) > 0.9 && m.second > 2) {
                while (m17Cand.isNotEmpty() && t - m17Cand.first() > 386) m17Cand.removeFirst()
                if (m17Cand.any { abs(t - it - 192) <= 1 } && m17Cand.any { abs(t - it - 384) <= 2 }) hit("M17", t)
                m17Cand.addLast(t)
                break
            }
        }
        for (pat in arrayOf(DS_FS, DS_SYNC)) {
            var err = 0; var errInv = 0; val n = pat.size
            for (k in 0 until n) { val b = if (r48[(p48 - n + k + 40) % 40] > 0) 1 else -1; if (b != pat[k]) err++ else errInv++ }
            if (err <= 1 || errInv <= 1) { hit("D-STAR", t); break }
        }
    }
    private fun sym24(s: Double) {
        val t = ++t24
        r24[p24] = s; p24 = (p24 + 1) % 24
        if (t - lastHit24 < 8) return
        for (pat in NXDN_P) {
            val m = corrSigns(r24, p24, pat)
            if (m.first > 0.92 && m.second > 1.8) { lastHit24 = t; hit("NXDN", 2 * t + 8); return }
        }
    }

    fun result(): ModeResult {
        val now = t48; val out = LinkedHashMap<String, Int>()
        var best = ""; var bestN = 0.0
        for (m in HAM_MODES) {
            val a = ArrayList((hits[m] ?: arrayListOf()).filter { now - it <= HOLD_S * 4800L })
            hits[m] = a
            out[m] = a.size
            val P = PERIOD.getValue(m)
            // consecutive syncs a whole number of frames apart, at least as many as off the grid (Framing.kt)
            var on = 0; var off = 0
            for (i in 1 until a.size) { if (onGrid(a[i] - a[i - 1], P)) on++ else off++ }
            // (and over the whole channel its syncs are not mostly off the grid: noise and other systems match now and then)
            val need = NEED.getValue(m)
            val framed = on >= max(1, need - 1) && on >= off && !offGrid(m) && ((m != "P25" && m != "M17") || eyeOk(eyes[m]))
            if (framed && a.size >= need && a.size.toDouble() / need > bestN) { bestN = a.size.toDouble() / need; best = m }
        }
        val seconds = samples / fs
        if (best.isNotEmpty()) sticky = best else if (seconds >= 0.6) sticky = "analog"
        return ModeResult(sticky, out, seconds)
    }
}
