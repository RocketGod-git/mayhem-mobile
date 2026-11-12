package com.rocketgod.mayhem.core.analyzer

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/*
 * Lining up repeated frames bit by bit: what stays the same between presses and what changes.
 *
 * Several presses of one button, or one press heard several times, are each read to bits; this slides every frame
 * along a reference until the most bits agree, then marks each column fixed (every frame that reaches it agrees)
 * or changing. The fixed run at the front is usually a preamble (a 1010 or 1111 training run the receiver locks on
 * to) and then a sync word; the changing columns are the rolling code, a counter or a checksum. Reading these off by
 * eye is how an unknown key is cracked: it is how the Land Rover key in this app was.
 *
 * Twin of web/src/dsp/analyzer/align.ts and Align.swift.
 */

data class AlignedRow(
    /** Which of the frames passed in this is. */
    val index: Int,
    /** The column its first bit lands on. */
    val shift: Int,
    val bits: String,
)

data class Segment(val from: Int, val to: Int, val fixed: Boolean)

data class SyncWord(val from: Int, val to: Int, val bits: String, val hex: String)

class Alignment(
    val rows: List<AlignedRow>,
    /** The number of columns, from the leftmost first bit to the rightmost last. */
    val width: Int,
    /** Per column: 1 fixed, 0 changing, 2 only one frame reaches it. */
    val state: IntArray,
    /** Per column, the bit most frames have ('0', '1', or '?' where none reach). */
    val consensus: String,
    /** The training run at the front, as [from, to) columns, or null. */
    val preamble: Pair<Int, Int>?,
    /** The fixed run straight after it (up to 32 bits), or null. */
    val sync: SyncWord?,
    /** The columns from the end of the preamble on, in fixed and changing stretches. */
    val segments: List<Segment>,
    val fixedBits: Int,
    val changingBits: Int,
)

/**
 * Each frame as its 8-bit windows, one per bit position, with -1 for windows that say little: all one level, or the
 * 1010 of a preamble. Lining frames up on these, a frame's long idle runs and training bits cannot outvote the few
 * dozen bits of a sync word that really fix where it sits.
 */
private const val WIN = 8
private fun windows(bits: String): IntArray {
    val n = max(0, bits.length - WIN + 1); val out = IntArray(n)
    for (i in 0 until n) {
        var v = 0
        for (k in 0 until WIN) v = (v shl 1) or (bits[i + k].code - 48)
        out[i] = if (v == 0 || v == 0xff || v == 0xaa || v == 0x55) -1 else v
    }
    return out
}

/**
 * How well `b` agrees with `a` when its first bit sits at column `s` of `a`: first the informative windows that
 * match, then the bits that agree less those that do not. Returns the score and the overlap.
 */
private fun score(a: String, b: String, wa: IntArray, wb: IntArray, s: Int): Pair<Int, Int> {
    val i0 = max(0, s); val i1 = min(a.length, s + b.length)
    var v = 0; var w = 0
    for (i in i0 until i1) v += if (a[i] == b[i - s]) 1 else -1
    for (i in i0 until min(wa.size, s + wb.size)) { val x = wa[i]; if (x >= 0 && x == wb[i - s]) w++ }
    return (w * 10_000 + v) to max(0, i1 - i0)
}

/** The shift that lines `b` up best against `a`, within `maxShift`; they must overlap by half the shorter. */
fun bestShift(a: String, b: String, maxShift: Int): Int {
    val need = ceil(min(a.length, b.length) / 2.0).toInt()
    val wa = windows(a); val wb = windows(b)
    var best = 0; var bestV = Int.MIN_VALUE; var any = false
    for (s in -maxShift..maxShift) {
        val (v, overlap) = score(a, b, wa, wb, s)
        if (overlap < need) continue
        if (!any || v > bestV || (v == bestV && abs(s) < abs(best))) { bestV = v; best = s; any = true }
    }
    return best
}

private fun hexOf(bits: String): String = bitsToHex(bits)

/**
 * The longest stretch that alternates (1010) or holds (1111) from `from`, by the consensus. The sync word starts at
 * the first bit that breaks the pattern (…10101 1101…: the Land Rover's D3 starts at the repeated 1).
 */
private fun trainingRun(c: String, from: Int, to: Int): Int {
    var alt = from; var same = from
    for (i in from + 1 until to) { if (c[i] == '?' || c[i] == c[i - 1]) break; alt = i }
    for (i in from + 1 until to) { if (c[i] == '?' || c[i] != c[i - 1]) break; same = i }
    return max(alt, same) + 1 - from
}

/** Line up the frames. The one of median length is the reference; the rest are slid against it up to `maxShift` bits either way. */
fun align(frames: List<String>, maxShift: Int = 64): Alignment {
    if (frames.isEmpty()) return Alignment(emptyList(), 0, IntArray(0), "", null, null, emptyList(), 0, 0)
    // the reference is the frame of middling length: the longest may well be one with junk run on at either end
    val byLen = frames.mapIndexed { i, f -> f.length to i }.sortedBy { it.first }
    val ref = byLen[byLen.size shr 1].second
    val a = frames[ref]
    val shifts = frames.mapIndexed { i, b -> if (i == ref) 0 else bestShift(a, b, min(maxShift, max(a.length, b.length))) }
    val left = shifts.min()
    val rows = frames.mapIndexed { index, bits -> AlignedRow(index, shifts[index] - left, bits) }
    val width = rows.maxOf { it.shift + it.bits.length }
    val state = IntArray(width)
    val cons = StringBuilder(width)
    var fixedBits = 0; var changingBits = 0
    for (c in 0 until width) {
        var n0 = 0; var n1 = 0
        for (r in rows) { val j = c - r.shift; if (j < 0 || j >= r.bits.length) continue; if (r.bits[j] == '1') n1++ else n0++ }
        val n = n0 + n1
        state[c] = if (n < 2) 2 else if (n0 == 0 || n1 == 0) 1 else 0
        if (state[c] == 1) fixedBits++ else if (state[c] == 0) changingBits++
        cons.append(if (n == 0) '?' else if (n1 > n0) '1' else '0')
    }
    val consensus = cons.toString()
    // where at least two frames reach: the part worth reading
    var c0 = 0; while (c0 < width && state[c0] == 2) c0++
    var c1 = width; while (c1 > c0 && state[c1 - 1] == 2) c1--
    // the preamble: the longest training run that starts in the first third and is all fixed
    var preamble: Pair<Int, Int>? = null
    for (s in c0 until c0 + max(1, (c1 - c0) / 3)) {
        if (s >= width || state[s] != 1) continue
        var len = trainingRun(consensus, s, c1)
        // a training run that runs into changing bits ends there
        var k = 0; while (k < len && state[s + k] == 1) k++
        len = k
        if (len >= 8 && (preamble == null || len > preamble.second - preamble.first)) preamble = s to s + len
    }
    // the sync word: the fixed run straight after the preamble (or the first fixed run of 8 or more)
    var sync: SyncWord? = null
    val start = preamble?.second ?: c0
    for (s in start until c1) {
        if (state[s] != 1) { if (preamble != null) break; continue }
        var e = s; while (e < c1 && state[e] == 1 && e - s < 32) e++
        if (e - s >= 8) { val bits = consensus.substring(s, e); sync = SyncWord(s, e, bits, hexOf(bits)) }
        break
    }
    val segments = ArrayList<Segment>()
    var c = start
    while (c < c1) {
        val fixed = state[c] == 1
        var e = c; while (e < c1 && (state[e] == 1) == fixed) e++
        segments.add(Segment(c, e, fixed))
        c = e
    }
    return Alignment(rows, width, state, consensus, preamble, sync, segments, fixedBits, changingBits)
}

/** What [similar] compares: how a frame was read, and how long it is. */
interface Similar {
    val mod: Mod
    val coding: Coding
    val symUs: Double
    val bits: Int
}

/**
 * Which frames belong together: the ones read the same way (modulation, coding, a symbol within 15%) whose
 * lengths are within a quarter of the one picked.
 */
fun <T : Similar> similar(all: List<T>, pick: T): List<T> = all.filter { x ->
    x.mod == pick.mod && x.coding == pick.coding && abs(x.symUs - pick.symUs) <= pick.symUs * 0.15 &&
        abs(x.bits - pick.bits) <= max(8.0, pick.bits * 0.25)
}
