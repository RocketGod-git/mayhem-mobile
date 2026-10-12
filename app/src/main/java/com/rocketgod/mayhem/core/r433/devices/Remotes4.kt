package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.min

/*
 * Chamberlain CWPIRC motion sensor, Watchman Plus oil gauge, Nice Flor-S, Markisol, Dickert and Elero remotes.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): chamberlain_cwpirc.c, watchman_plus.c, nice_flor_s.c, markisol.c,
 * dickert_mahs.c, elero.c. Twin of web/src/dsp/r433/devices/remotes4.ts.
 */

private val B433 = listOf(433_920_000L)

/** Forty bits: two unused, eight of order and inversion, thirty interleaved, scrambled exactly as Security+ 2.0. */
private fun cwpircHalf(b: UBytes, at: Int, roll: IntArray): Int? {
    val orderInvert = ((b[at] and 0x3f) shl 2) or (b[at + 1] shr 6)
    val x30 = ((b[at + 1] and 0x3f) shl 24) or (b[at + 2] shl 16) or (b[at + 3] shl 8) or b[at + 4]
    val g = secplusPermute(orderInvert, x30, roll) ?: return null
    return (g[0] shl 10) or g[1]
}

/**
 * A motion sensor speaking a garage opener's language. Bit five of the fixed value flips with a low battery,
 * so it is masked out of the identity, or one sensor would look like two as its battery tired.
 */
private fun cwpirc(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val n = bits.bitsPerRow[0]
    if (n < 136) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, UBytes.of(0x55, 0x2d, 0xd4), 24)
    if (at >= n) return DECODE_ABORT_EARLY
    // The run-in sometimes lands a bit or two early, so nearby offsets are tried and the CRC decides.
    var b: UBytes? = null
    for (shift in 0..4) {
        val pos = at + 24 + shift
        if (pos + 112 > n) break
        val c = bits.bytes(0, pos, 112)
        if (c[0] != 0x00 || c[6] != 0x01) continue
        if (crc16(c, 14, 0x1021, 0x0000) != 0) continue
        b = c
        break
    }
    if (b == null) return DECODE_FAIL_MIC
    val roll0 = IntArray(9); val roll1 = IntArray(9)
    val fixed0 = cwpircHalf(b, 1, roll0) ?: return DECODE_FAIL_SANITY
    val fixed1 = cwpircHalf(b, 7, roll1) ?: return DECODE_FAIL_SANITY
    val batteryLow = (fixed1 and 0x20) != 0
    val id = fixed0.toLong() * 1048576 + (fixed1 and 0x20.inv())
    val digits = ArrayList<Int>()
    digits.add(roll1[8]); digits.add(roll0[8])
    for (i in 4 until 8) digits.add(roll1[i])
    for (i in 4 until 8) digits.add(roll0[i])
    for (i in 0 until 4) digits.add(roll1[i])
    for (i in 0 until 4) digits.add(roll0[i])
    var temp = 0L
    for (i in 0 until 18) temp = temp * 3 + digits[i]
    ctx.emit(data("model" to "Chamberlain-CWPIRC", "type" to "Motion", "id" to hexOf(id, 10), "battery_ok" to if (batteryLow) 0 else 1,
        "rolling" to (reverse32(temp) ushr 4), "mic" to "CRC"))
    return 1
}

/**
 * Reports a single digit (0-9, or F for full), not a depth. The serial is stored backwards across all
 * twenty-four bits and read as eight octal digits, which brings back the number printed on the case. No
 * checksum: four "10" markers woven through the frame are the whole of its integrity.
 */
private fun watchmanPlus(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 13 + 40) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    val rowLen = bits.bitsPerRow[0]
    val pre = UBytes.of(0xff, 0xf0)
    var from = 0
    while (from + 13 + 40 <= rowLen) {
        val match = bits.search(0, from, pre, 13)
        if (match + 13 + 40 > rowLen) break
        var pos = match + 13
        from = match + 1
        var stuffOk = true
        var idRaw = 0
        for (i in 0 until 3) {
            for (j in 0 until 8) idRaw = (idRaw shl 1) or bitAt(b, pos++)
            if (i < 2) { val s0 = bitAt(b, pos++); val s1 = bitAt(b, pos++); stuffOk = stuffOk && s0 == 1 && s1 == 0 }
        }
        val m0 = bitAt(b, pos++); val m1 = bitAt(b, pos++)
        stuffOk = stuffOk && m0 == 1 && m1 == 0
        var level = 0
        for (j in 0 until 4) level = level or (bitAt(b, pos++) shl j)
        pos += 3                                         // three bits nobody has explained
        val batteryLow = bitAt(b, pos++)
        val m2 = bitAt(b, pos++); val m3 = bitAt(b, pos++)
        stuffOk = stuffOk && m2 == 1 && m3 == 0
        if (!stuffOk || level > 10) continue
        val idRev = (reverse32((idRaw.toLong() shl 8) and 0xffffffffL) and 0xffffffL).toInt()
        var idVal = 0
        for (k in 7 downTo 0) idVal = idVal * 10 + ((idRev shr (k * 3)) and 0x07)
        ctx.emit(data("model" to "Watchman-Plus", "type" to "Meter", "id" to idVal.toString().padStart(8, '0'),
            "level" to if (level <= 9) level.toString() else "F", "battery_ok" to if (batteryLow != 0) 0 else 1))
        return 1
    }
    return DECODE_FAIL_SANITY
}

private val NICE_LEAF = intArrayOf(
    25, 5, 63, 97, 203, 109, 69, 10, 3, 7, 64, 5, 71, 134, 180, 74,
    41, 158, 102, 199, 93, 118, 175, 101, 60, 77, 143, 174, 103, 148, 29, 85,
)

/**
 * Six bytes shuffled, complemented, then twice through a table-driven xor keyed on the byte being transformed,
 * so serial and rolling code come out together. In place; returns the code.
 */
private fun niceUnscramble(p: UBytes): Int {
    var k = p[4].inv() and 0xff
    p[5] = p[5].inv() and 0xff
    p[4] = p[2].inv() and 0xff
    p[2] = p[0].inv() and 0xff
    p[0] = k
    k = p[3].inv() and 0xff
    p[3] = p[1].inv() and 0xff
    p[1] = k
    fun xorTail(key: Int) { for (i in 1 until 6) p[i] = (p[i] xor key) and 0xff }
    for (y in 0 until 2) {
        k = (NICE_LEAF[p[0] shr 3] + 0x25) and 0xff
        xorTail(k)
        p[5] = p[5] and 0x0f
        p[0] = (p[0] xor (k and 0x07)) and 0xff
        k = NICE_LEAF[p[0] and 0x1f]
        xorTail(k)
        p[5] = p[5] and 0x0f
        p[0] = (p[0] xor (k and 0xe0)) and 0xff
        if (y == 0) { val t = p[0]; p[0] = p[1]; p[1] = t }
    }
    return ((p[1] shl 8) or p[0]) and 0xffff
}

/** The transmitter leaves a trailing empty row, which is part of how the frame is recognised. */
private fun niceFlorS(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 2 || bits.bitsPerRow[1] != 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] != 52 && bits.bitsPerRow[0] != 72) return DECODE_ABORT_LENGTH
    bits.invert()
    val b = bits.bb[0]
    val t = UBytes(7)
    t[0] = (b[0] shr 4) and 0x0f
    for (i in 0 until 6) t[i + 1] = ((b[i] shl 4) and 0xf0) or ((b[i + 1] shr 4) and 0x0f)
    val p = UBytes(7)
    p[5] = t[1] and 0x0f; p[4] = t[2]; p[3] = t[3]; p[2] = t[4]; p[1] = t[5]; p[0] = t[6]
    val code = niceUnscramble(p)
    val serial = ((p[5] shl 24) or (p[4] shl 16) or (p[3] shl 8) or p[2]) and 0xfffffff
    ctx.emit(data("model" to "Nice-FlorS", "type" to "Remote", "button" to (t[0] and 0x0f), "serial" to hexOf(serial, 7),
        "code" to hexOf(code, 4),
        // The repeat counter hides behind the button number, which is how a replay is spotted.
        "count" to ((((t[1] shr 4) and 0x0f) xor (t[0] and 0x0f)) xor 0x0f)))
    return 1
}

private val MARKISOL_CONTROL = listOf("Limit (0)", "Down (1)", "? (2)", "H-Down (3)", "Confirm (4)", "Stop (5)", "? (6)", "? (7)",
    "? (8)", "? (9)", "? (10)", "? (11)", "Up (12)", "Limit (13)", "H-Up (14)", "? (15)")

/** The slicer mistakes the frame marker for a data bit, so everything is shifted back by one first. */
private fun markisol(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val buf = UBytes(5)
    var sum = 0
    var found = false
    for (i in 0 until bits.numRows) {
        if (bits.bitsPerRow[i] != 41 && bits.bitsPerRow[i] != 42) continue
        val b = bits.bb[i]
        sum = 0
        for (j in 0 until 5) {
            buf[j] = reverse8(((b[j] shl 1) + (b[j + 1] shr 7)) and 0xff).inv() and 0xff
            sum = (sum + buf[j]) and 0xff
        }
        found = true
        break
    }
    if (!found) return DECODE_ABORT_EARLY
    if (sum != 1) return DECODE_FAIL_MIC
    val control = ((buf[2] shr 4) and 2.inv()) or ((buf[3] and 0x10) shr 3)
    ctx.emit(data("model" to "Markisol", "type" to "Remote", "id" to hexUp((buf[0] shl 8) or buf[1], 4),
        "control" to MARKISOL_CONTROL[control and 0x0f], "channel" to (buf[2] and 0x0f),
        "zone" to ((buf[2] and 0x20) shr 5) + ((buf[3] and 0x80) shr 6) + 1, "mic" to "CHECKSUM"))
    return 1
}

private val DICKERT_STATE = listOf("-", "0", "?", "+")

/** Ten three-way switches set by the installer are the code; reported as the positions read off the hardware. */
private fun dickert(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] != 37) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, 1, 36)
    val dip = StringBuilder(); val fac = StringBuilder()
    for (field in 0 until 18) {
        val v = (b[field shr 2] shr (2 * (3 - (field % 4)))) and 0x03
        (if (field < 10) dip else fac).append(DICKERT_STATE[v])
    }
    ctx.emit(data("model" to "Dickert-MAHS433", "type" to "Remote", "id" to ((b[0] shl 12) or (b[1] shl 4) or (b[2] shr 4)),
        "dipswitch" to dip.toString(), "facswitch" to fac.toString()))
    return 1
}

private val ELERO_NIBBLE = intArrayOf(0x0a, 0x03, 0x01, 0x0c, 0x0d, 0x07, 0x0f, 0x06, 0x00, 0x08, 0x0b, 0x0e, 0x09, 0x02, 0x05, 0x04)

/**
 * Obfuscation, not encryption: a nibble substitution, nibble-wise subtractions with a key walking down, and an
 * xor with the block's own first two bytes. Fully reversible.
 */
private fun eleroUnwrap(m: UBytes) {
    for (i in 0 until 8) m[i] = ((ELERO_NIBBLE[(m[i] shr 4) and 0x0f] shl 4) or ELERO_NIBBLE[m[i] and 0x0f]) and 0xff
    var key = 0xfe
    for (i in 0 until 2) {
        m[i] = (((m[i] and 0xf0) - (key and 0xf0)) and 0xf0) or ((m[i] - key) and 0x0f)
        key = (key - 0x22) and 0xff
    }
    val x0 = m[0]; val x1 = m[1]
    for (i in 0 until 8 step 2) { m[i] = m[i] xor x0; m[i + 1] = m[i + 1] xor x1 }
    key = 0xba
    for (i in 2 until 8) {
        m[i] = (((m[i] and 0xf0) - (key and 0xf0)) and 0xf0) or ((m[i] - key) and 0x0f)
        key = (key - 0x22) and 0xff
    }
}

private fun elero(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    // Only the first thirty-one bits of the printed sync word are really sync.
    var at = bits.search(0, 0, UBytes.of(0xa7, 0x23, 0xa7, 0x23), 31)
    if (at == bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    at += 31
    val availBits = bits.bitsPerRow[0] - at
    if (availBits < 8) return DECODE_ABORT_LENGTH
    val availBytes = min(availBits shr 3, 40)
    val frame = UBytes(40)
    bits.extractBytes(0, at, frame, availBytes * 8)
    ibmWhitening(frame, availBytes)
    val total = frame[0] + 3
    if (total > 40 || availBytes < total) return DECODE_ABORT_LENGTH
    if (crc16(frame, total - 2, 0x8005, 0xffff) != (((frame[total - 2] shl 8) or frame[total - 1]) and 0xffff)) return DECODE_FAIL_MIC
    val ndst = frame[16]
    if (17 + ndst + 2 + 8 + 2 > total) return DECODE_FAIL_SANITY
    val channel = hexBytes(frame, ndst, 17).uppercase()
    val enc = frame.slice(17 + ndst + 2, 17 + ndst + 10)
    eleroUnwrap(enc)
    val command = when (enc[2]) { 0x20 -> "Up"; 0x10 -> "Stop"; 0x40 -> "Down"; else -> "?" }
    ctx.emit(data("model" to "Elero", "type" to "Remote", "id" to hexUp((frame[7] shl 16) or (frame[8] shl 8) or frame[9], 6),
        "channel" to channel, "command" to command, "counter" to frame[1], "mic" to "CRC"))
    return 1
}

internal val REMOTES4: List<RDevice> = listOf(
    dev(258, "Chamberlain CWPIRC PIR Sensor", Mod.FSK_PCM, 25, 25, 500, what = "motion sensor", decode = ::cwpirc),
    // Pulse widths are upstream's best estimate: its bit-level decode is confirmed, a raw capture is not.
    dev(359, "Kingspan/Watchman Plus (Niveau) oil tank monitor", Mod.OOK_PWM, 3299, 4107, 5000, bands = B433,
        what = "oil tank level monitor", decode = ::watchmanPlus),
    dev(169, "Nice Flor-s remote control for gates", Mod.OOK_PWM, 500, 1000, 5000, gapLimit = 2000, syncWidth = 1500, tolerance = 100,
        disabled = true, bands = B433, what = "gate remote", decode = ::niceFlorS),
    dev(191, "Markisol, E-Motion, BOFU, Rollerhouse, BF-30x, BF-415 curtain remote", Mod.OOK_PWM, 368, 704, 2000, gapLimit = 2000,
        syncWidth = 5628, disabled = true, bands = B433, what = "curtain and blind remote", decode = ::markisol),
    dev(344, "Dickert MAHS433-01 garage door remote control", Mod.OOK_PWM, 362, 770, 12000, gapLimit = 1064, disabled = true,
        bands = B433, what = "garage remote", decode = ::dickert),
    dev(372, "Elero bidirectional blinds/awning remote (Silent Gliss and others)", Mod.FSK_PCM, 13, 13, 4000,
        bands = listOf(868_000_000L, 915_000_000L), what = "blind and awning remote", decode = ::elero),
)
