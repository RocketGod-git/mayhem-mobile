package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Chamberlain / LiftMaster Security+ 1.0 and 2.0 garage remotes. Each press is sent as two halves, so a half
 * is held briefly until its partner arrives. Rolling codes are reported, not exploited.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): secplus_v1.c, secplus_v2.c. Twin of web/src/dsp/r433/devices/secplus.ts.
 */

/** A half waits this long for its partner: far longer than the real gap, far shorter than two presses. */
private const val CACHE_MS = 800L
private val BANDS = listOf(310_000_000L, 315_000_000L, 390_000_000L)
private const val WHAT = "garage door opener"

private object SecplusCache {
    var v1Part = 0; var v1Digits: UBytes? = null; var v1At = 0L
    var v2Half1: V2Half? = null; var v2Half2: V2Half? = null; var v2At = 0L
}

private class V2Half(val fixed: UBytes, val roll: IntArray)

/** The clock, behind a seam so tests can age the cache without waiting. */
internal var secplusClock: () -> Long = { System.currentTimeMillis() }
private fun now() = secplusClock()

/** Drop every held half. */
internal fun secplusResetCache() = synchronized(SecplusCache) {
    SecplusCache.v1Digits = null; SecplusCache.v1At = 0
    SecplusCache.v2Half1 = null; SecplusCache.v2Half2 = null; SecplusCache.v2At = 0
}

private val V1_PRE_A = UBytes.of(0x02)
private val V1_PRE_B = UBytes.of(0x07)

/**
 * The wire carries runs of ones separated by zeroes, and each run's length is a base-three digit; a run of four
 * or more cannot have been sent. Returns the first digit, which says which half this is.
 */
private fun v1DecodeHalf(src: UBytes, out: UBytes): Int {
    var n = 0; var run = 0
    for (i in 0 until 11) for (j in 0 until 8) {
        if (((src[i] shl j) and 0x80) != 0) { run++; continue }
        if (run == 0) continue
        if (run > 3) return -1
        out[n++] = run - 1
        run = 0
    }
    return out[0]
}

/** No preamble: every half begins with digit 0 or 2, `0001` or `0111` on the wire, so those shapes are the run-in. */
private fun v1FindNext(bits: BitBuffer, from: Int): Int {
    val head = bits.bb[0][0]
    if (from == 0 && ((head and 0xf0) == 0x10 || (head and 0xf0) == 0x70)) return 0
    if (from == 0 && ((head and 0xe0) == 0xe0 || (head and 0xc0) == 0x80)) return 0
    val a = bits.search(0, from, V1_PRE_A, 8) + 3
    val b = bits.search(0, from, V1_PRE_B, 8) + 3
    return if (a < b) a else b
}

/** Every other digit is the counter; the ones between are the fixed code obscured by a running total. */
private fun v1Accumulate(digits: UBytes, st: LongArray) {
    var acc = 0
    for (i in 0 until 20 step 2) {
        val a = digits[1 + i]
        st[0] = st[0] * 3 + a
        acc += a
        val b = (60 + digits[2 + i] - acc) % 3
        st[1] = st[1] * 3 + b
        acc += b
    }
}

private fun secplusV1(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int = synchronized(SecplusCache) {
    val n = bits.bitsPerRow[0]
    if (n < 84 || n > 130) return DECODE_ABORT_LENGTH
    var first: UBytes? = null
    var second: UBytes? = null
    var at = 0
    while (at < n && first == null && second == null) {
        at = v1FindNext(bits, at)
        if (at < 0 || at + 84 > n) break
        val out = UBytes(44)                             // a corrupt frame can produce more digits than a good one
        val which = v1DecodeHalf(bits.bytes(0, at, 84), out)
        if (which < 0 || which == 1) { at += 4; continue }
        if (which == 0) { first = out.slice(0, 22); at += 88 } else if (which == 2) { second = out.slice(0, 22); at += 88 }
    }
    if (first == null && second == null) return DECODE_ABORT_EARLY
    val c = SecplusCache
    if (c.v1At != 0L) {
        val held = c.v1Digits
        if (now() - c.v1At < CACHE_MS && held != null) {
            if (second != null && c.v1Part == 0) first = held
            else if (first != null && c.v1Part == 2) second = held
        }
        c.v1Digits = null; c.v1At = 0
    }
    if (first == null || second == null) {
        if (first != null) { c.v1Part = 0; c.v1Digits = first } else { c.v1Part = 2; c.v1Digits = second }
        c.v1At = now()
        return DECODE_ABORT_EARLY
    }
    val st = LongArray(2)
    v1Accumulate(first, st)
    v1Accumulate(second, st)
    val rolling = reverse32(st[0])
    val fixed = st[1]
    // The fixed code is a base-three number with several fields buried in it by division.
    val switchId = (fixed % 3).toInt()
    val id0 = ((fixed / 3) % 3).toInt()
    val id1 = ((fixed / 9) % 3).toInt()
    val out = data("model" to "Secplus-v1", "type" to "Remote", "id0" to id0, "id1" to id1, "switch_id" to switchId,
        "fixed" to fixed.toString(), "rolling" to rolling.toString())
    if (id1 == 0) {
        // A wall keypad: it reports the code that was typed, not a button.
        val padId = ((fixed / 27) % 2187).toInt()
        val pin = ((fixed / 59049) % 19683).toInt()
        var pinStr = when (pin) { in 0..9999 -> pin.toString().padStart(4, '0'); in 10000..11029 -> "enter"; else -> "" }
        when (((fixed / 1162261467) % 3).toInt()) { 1 -> pinStr += "#"; 2 -> pinStr += "*" }
        out["id"] = padId
        if (padId != 0) out["pad_id"] = padId
        if (pin != 0) out["pin"] = pinStr
    } else {
        val remoteId = fixed / 27
        out["id"] = remoteId
        if (remoteId != 0L) {
            out["remote_id"] = remoteId
            out["button_id"] = when (switchId) { 1 -> "left"; 0 -> "middle"; else -> "right" }
        }
    }
    ctx.emit(out)
    1
}

private val V2_PREAMBLE = UBytes.of(0xaa, 0xaa, 0x95, 0x60)

/** Which of the three groups arrive inverted, by four bits of the indicator. */
private val V2_INVERT = mapOf(
    0x0 to booleanArrayOf(true, true, false), 0x1 to booleanArrayOf(false, true, false), 0x2 to booleanArrayOf(false, false, true),
    0x4 to booleanArrayOf(true, true, true), 0x5 to booleanArrayOf(true, false, true), 0x6 to booleanArrayOf(false, true, true),
    0x8 to booleanArrayOf(true, false, false), 0x9 to booleanArrayOf(false, false, false), 0xa to booleanArrayOf(true, false, true),
)

/** Which order the three groups arrived in, by the other four. */
private val V2_ORDER = mapOf(
    0x0 to intArrayOf(0, 2, 1), 0x1 to intArrayOf(2, 0, 1), 0x2 to intArrayOf(0, 1, 2),
    0x4 to intArrayOf(1, 2, 0), 0x5 to intArrayOf(1, 0, 2), 0x6 to intArrayOf(2, 1, 0),
    0x8 to intArrayOf(1, 2, 0), 0x9 to intArrayOf(2, 1, 0), 0xa to intArrayOf(0, 1, 2),
)

/**
 * Undo the group scrambling: thirty bits carry three ten-bit groups interleaved a bit at a time, and the indicator
 * says which were inverted and in what order, so the same payload looks different on every press. Fills the nine
 * base-three counter digits; null for a combination never sent or a digit that cannot exist.
 *
 * Chamberlain reuses this exact permutation inside an unrelated motion sensor, so it is shared from here: a
 * single transposed entry in these tables would still pass every structural check.
 */
internal fun secplusPermute(orderInvert: Int, x30: Int, roll: IntArray): IntArray? {
    val inv = V2_INVERT[orderInvert and 0x0f] ?: return null
    val ord = V2_ORDER[orderInvert shr 4] ?: return null
    var x = x30
    var p0 = 0; var p1 = 0; var p2 = 0
    for (i in 0 until 10) {
        p2 = p2 xor ((x and 1) shl i); x = x ushr 1
        p1 = p1 xor ((x and 1) shl i); x = x ushr 1
        p0 = p0 xor ((x and 1) shl i); x = x ushr 1
    }
    if (inv[0]) p0 = p0.inv() and 0x3ff
    if (inv[1]) p1 = p1.inv() and 0x3ff
    if (inv[2]) p2 = p2.inv() and 0x3ff
    val groups = intArrayOf(p0, p1, p2)
    p0 = groups[ord.indexOf(0)]; p1 = groups[ord.indexOf(1)]; p2 = groups[ord.indexOf(2)]
    var k = 0
    for (i in 6 downTo 0 step 2) roll[k++] = (orderInvert shr i) and 0x03
    for (i in 8 downTo 0 step 2) roll[k++] = (p2 shr i) and 0x03
    for (i in 0 until 9) if (roll[i] == 3) return null
    return intArrayOf(p0, p1, p2)
}

private fun v2DecodeHalf(packet: BitBuffer, roll: IntArray): UBytes? {
    val head = packet.bytes(0, 4, 8)
    val raw = packet.bytes(0, 12, 30)
    val x = (u32be(raw, 0) ushr 2).toInt()
    val g = secplusPermute(head[0], x, roll) ?: return null
    val fixed = UBytes(3)
    var bi = 0
    fun put(v: Int) { if (v != 0) fixed[bi shr 3] = fixed[bi shr 3] or (0x80 shr (bi and 7)); bi++ }
    for (i in 9 downTo 0) put((g[0] shr i) and 1)
    for (i in 9 downTo 0) put((g[1] shr i) and 1)
    return fixed
}

private fun secplusV2(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int = synchronized(SecplusCache) {
    var half1: V2Half? = null
    var half2: V2Half? = null
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] < 110) continue
        val at = bits.search(row, 0, V2_PREAMBLE, 28)
        if (at >= bits.bitsPerRow[row]) break
        val packet = BitBuffer()
        bits.manchesterDecode(row, at + 26, packet, 80)
        if (packet.bitsPerRow[0] < 42) continue
        // The first, third and fourth bits are always clear; the second says which half this is.
        val head = packet.bb[0][0]
        if ((head and 0xb0) != 0) continue
        val roll = IntArray(16)
        val fixed = v2DecodeHalf(packet, roll) ?: continue
        if ((head and 0xc0) != 0) half2 = V2Half(fixed, roll) else half1 = V2Half(fixed, roll)
        if (half1 != null && half2 != null) break
    }
    if (half1 == null && half2 == null) return DECODE_ABORT_EARLY
    val c = SecplusCache
    if (half1 == null || half2 == null) {
        val fresh = c.v2At != 0L && now() - c.v2At < CACHE_MS
        if (half1 != null) c.v2Half1 = half1 else c.v2Half2 = half2
        c.v2At = now()
        if (fresh && c.v2Half1 != null && c.v2Half2 != null) {
            half1 = c.v2Half1; half2 = c.v2Half2
            c.v2Half1 = null; c.v2Half2 = null; c.v2At = 0
        } else {
            if (!fresh) { if (half1 != null) c.v2Half2 = null else c.v2Half1 = null }
            return DECODE_ABORT_EARLY
        }
    } else {
        c.v2Half1 = null; c.v2Half2 = null; c.v2At = 0
    }
    val h1 = half1!!; val h2 = half2!!
    // The counter's digits come from the two halves alternately, and not in the order they arrived.
    val digits = ArrayList<Int>()
    digits.add(h2.roll[8]); digits.add(h1.roll[8])
    for (i in 4 until 8) digits.add(h2.roll[i])
    for (i in 4 until 8) digits.add(h1.roll[i])
    for (i in 0 until 4) digits.add(h2.roll[i])
    for (i in 0 until 4) digits.add(h1.roll[i])
    var rollingTemp = 0L
    for (i in 0 until 18) rollingTemp = rollingTemp * 3 + digits[i]
    if (rollingTemp >= 0x10000000L) return DECODE_FAIL_SANITY
    val rolling = reverse32(rollingTemp) ushr 4
    // Forty bits across the two halves; the first half's last byte is real only in its top nibble.
    val f1 = h1.fixed; val f2 = h2.fixed
    val fixedTotal = (f1[0].toLong() shl 32) + (f1[1].toLong() shl 24) + ((f1[2] and 0xf0).toLong() shl 16) +
        (f2[0].toLong() shl 12) + (f2[1].toLong() shl 4) + ((f2[2] shr 4) and 0x0f)
    ctx.emit(data("model" to "Secplus-v2", "type" to "Remote", "id" to fixedTotal % 4294967296L, "button_id" to fixedTotal / 4294967296L,
        "remote_id" to fixedTotal % 4294967296L, "fixed" to fixedTotal.toString(), "rolling" to rolling.toString()))
    1
}

internal val SECPLUS: List<RDevice> = listOf(
    dev(178, "Security+ (Keyfob)", Mod.OOK_PCM, 500, 500, 80000, gapLimit = 15000, tolerance = 20, bands = BANDS, what = WHAT, decode = ::secplusV1),
    dev(164, "Security+ 2.0 (Keyfob)", Mod.OOK_PCM, 250, 250, 9000, gapLimit = 1500, tolerance = 50, bands = BANDS, what = WHAT, decode = ::secplusV2),
)
