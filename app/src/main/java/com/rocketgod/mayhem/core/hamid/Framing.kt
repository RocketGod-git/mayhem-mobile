package com.rocketgod.mayhem.core.hamid

import kotlin.math.abs
import kotlin.math.min

/**
 * What a digital mode must show before the identity layer names it, beyond its sync word: its checked frames on the
 * mode's frame grid, its syncs not heard off that grid more often than on it, a 4-level eye for M17 and P25, and no
 * samples taken while the receiver clips. The same as the web's dsp/hamid/framing.ts.
 */
val FRAME_SYMS = mapOf("DMR" to 144, "D-STAR" to 96, "YSF" to 480, "P25" to 72, "NXDN" to 192, "M17" to 192, "dPMR" to 384)
fun frameSyms(key: String): Int = FRAME_SYMS.getValue(key.substringBefore(":"))
const val GRID_TOL = 3

/** Whether [d] symbols is a whole number of frames of [p]. */
fun onGrid(d: Long, p: Int): Boolean {
    if (d < p - GRID_TOL) return false
    val r = (d % p).toInt()
    return r <= GRID_TOL || r >= p - GRID_TOL
}

/** Checked frames per mode, with when they came: a mode is framed once two came a whole number of frames apart. */
class FrameGate {
    private val seen = HashMap<String, Int>(); private val last = HashMap<String, Long>(); private val on = HashMap<String, Int>()
    fun reset() { seen.clear(); last.clear(); on.clear() }
    /** The checked-frame count of [key] (a mode) is [count] at symbol time [t]: a new frame when it moved. */
    fun mark(key: String, count: Int, t: Long) {
        if (count == (seen[key] ?: 0)) return
        seen[key] = count
        val l = last[key]
        // a second check of the same frame (one burst passing two codes) is the same frame
        if (l != null && t - l <= GRID_TOL) return
        if (l != null && onGrid(t - l, frameSyms(key))) on[key] = (on[key] ?: 0) + 1
        last[key] = t
    }
    fun pairs(key: String): Int = on[key] ?: 0
    fun framed(key: String): Boolean = pairs(key) > 0
    /** Of the keys starting [prefix] (P25's NACs), the one with the most frames on the grid, or "" when none has any. */
    fun best(prefix: String): String { var b = ""; var n = 0; for ((k, v) in on) if (k.startsWith(prefix) && v > n) { n = v; b = k }; return b }
}

/** The eye of [n] symbols (outer levels near ±3): 4 on four levels, 2 when nearly all are on the outer two, else 0. */
fun eyeLevels(sym: DoubleArray, n: Int = sym.size): Int {
    var inner = 0; var outer = 0; var mid = 0; var total = 0
    for (i in 0 until n) {
        val a = abs(sym[i]); total++
        if (a >= 0.3 && a <= 1.7) inner++ else if (a >= 2.3 && a <= 4) outer++ else if (a > 1.7 && a < 2.3) mid++
    }
    if (total == 0) return 0
    val fi = inner.toDouble() / total; val fo = outer.toDouble() / total; val fm = mid.toDouble() / total
    if (fi >= 0.15 && fo >= 0.15 && fm <= 0.6 * min(fi, fo)) return 4
    if (fi + fm < 0.1 && fo > 0.6) return 2
    return 0
}

/** Eye votes of one mode, one at each of its sync hits. */
class EyeVotes { var four = 0; var other = 0 }
/** The eye agrees with a 4-level mode: most of its sync hits saw four levels. */
fun eyeOk(v: EyeVotes?): Boolean = v != null && v.four > 0 && v.four >= v.other

const val CLIP_SHARE = 0.002
/** Whether 8-bit IQ (interleaved) is clipping: at least [CLIP_SHARE] of its values at full scale. */
fun iqClipping(iq: ByteArray, n: Int = iq.size): Boolean {
    var c = 0
    for (i in 0 until n) { val v = iq[i].toInt(); if (v >= 127 || v <= -127) c++ }
    return c >= CLIP_SHARE * n && c > 4
}
/** The same for unsigned 8-bit IQ (the engine's input: 0 and 255 are full scale), looking at every [step]th value
 *  (Repeaters looks at one in 16: an overload fills a buffer, it does not hide in one sample). */
fun iqClippingU8(iq: ByteArray, n: Int = iq.size, step: Int = 1): Boolean {
    var c = 0; var m = 0; var i = 0
    while (i < n) { val v = iq[i].toInt() and 0xff; m++; if (v == 0 || v == 255) c++; i += step }
    return c >= CLIP_SHARE * m && c > (if (step > 1) 1 else 4)
}
