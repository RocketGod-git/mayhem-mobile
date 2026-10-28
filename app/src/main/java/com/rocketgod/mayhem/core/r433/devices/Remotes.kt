package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Fixed-code remotes and mains switches: generic EV1527, Intertechno, Proove/Nexa, Cardin, and Somfy RTS
 * (rolling counter).
 *
 * Ported from rtl_433 (GPL-2.0-or-later): generic_remote.c, intertechno.c, proove.c, cardin.c, somfy_rts.c.
 * Twin of web/src/dsp/r433/devices/remotes.ts.
 */

/** Each bit pair is one solder position: low, high or floating, read as it would be off the board. */
private fun genericRemote(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val b = bits.bb[0]
    for (i in 0 until 3) b[i] = b[i].inv()
    if (bits.bitsPerRow[0] != 25 || (b[3] and 0x80) == 0 || (b[0] == 0 && b[1] == 0) || b[2] == 0) return DECODE_ABORT_LENGTH
    val full = (b[0] shl 16) or (b[1] shl 8) or b[2]
    val sb = StringBuilder()
    // 10 is invalid on the SC226x but legitimate on the EV1527, so it gets its own symbol.
    for (i in 22 downTo 0 step 2) sb.append("0ZX1"[(full shr i) and 0x03])
    ctx.emit(data("model" to "Generic-Remote", "id" to ((b[0] shl 8) or b[1]), "cmd" to b[2], "tristate" to sb.toString()))
    return 1
}

private fun intertechno(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bb[0][0] != 0 || (bits.bb[1][0] != 0x56 && bits.bb[1][0] != 0x69)) return DECODE_ABORT_EARLY
    val b = bits.bb[1]
    ctx.emit(data("model" to "Intertechno-Remote", "id" to hexBytes(b, 5), "slave" to (b[7] and 0x0f),
        "master" to ((b[7] and 0xf0) shr 4), "command" to (b[6] and 0x07)))
    return 1
}

/** Exactly one sync mark before the data is most of what tells this apart from its neighbors. */
private fun proove(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.syncsBeforeRow[0] != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] != 64) return DECODE_ABORT_LENGTH
    val databits = BitBuffer()
    bits.manchesterDecode(0, 0, databits, 80)
    if (databits.bitsPerRow[0] < 32) return DECODE_ABORT_LENGTH
    databits.invert()
    val b = databits.bb[0]
    ctx.emit(data("model" to "Proove-Security", "id" to ((b[0] shl 18) or (b[1] shl 10) or (b[2] shl 2) or (b[3] shr 6)),
        "channel" to (((b[3] shr 2) and 0x03) xor 0x03), "state" to if (((b[3] shr 4) and 1) != 0) "ON" else "OFF",
        "unit" to ((b[3] and 0x03) xor 0x03), "group" to ((b[3] shr 5) and 1)))
    return 1
}

/** Byte and mask of each switch's "fitted" bit, then of its "up" bit; nine switches in no tidy order. */
private val CARDIN_SWITCHES = arrayOf(
    intArrayOf(0, 0x08, 1, 0x08), intArrayOf(0, 0x10, 1, 0x10), intArrayOf(0, 0x20, 1, 0x20),
    intArrayOf(0, 0x40, 1, 0x40), intArrayOf(0, 0x80, 1, 0x80), intArrayOf(2, 0x80, 2, 0x40),
    intArrayOf(0, 0x01, 1, 0x01), intArrayOf(0, 0x02, 1, 0x02), intArrayOf(0, 0x04, 1, 0x04),
)

/** No identity as such: the pairing is nine physical switches, each up, down or not fitted. */
private fun cardin(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 24) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    val cmd = b[2] and 0x3f
    if (cmd != 0x03 && cmd != 0x09 && cmd != 0x0c && cmd != 0x06) return DECODE_ABORT_EARLY
    for (s in CARDIN_SWITCHES) if ((b[s[0]] and s[1]) == 0 && (b[s[2]] and s[3]) != 0) return DECODE_ABORT_EARLY
    val dip = StringBuilder()
    for (s in CARDIN_SWITCHES) dip.append(if ((b[s[0]] and s[1]) == 0) '-' else if ((b[s[2]] and s[3]) != 0) '+' else 'o')
    ctx.emit(data("model" to "Cardin-S466", "dipswitch" to dip.toString(),
        "rbutton" to listOf("11R", "10R", "01R", "00L?")[(cmd and 0x0f) / 3 - 1]))
    return 1
}

private val SOMFY_CONTROL = listOf("? (0)", "My (1)", "Up (2)", "My + Up (3)", "Down (4)", "My + Down (5)", "Up + Down (6)",
    "My + Up + Down (7)", "Prog (8)", "Sun + Flag (9)", "Flag (10)", "? (11)", "? (12)", "? (13)", "? (14)", "? (15)")
private val SOMFY_SEED = listOf("? (0)", "? (1)", "? (2)", "? (3)", "? (4)", "Stop (5)", "Up (6)", "? (7)",
    "Down (8)", "? (9)", "? (10)", "? (11)", "Prog (12)", "? (13)", "? (14)", "? (15)")

/**
 * Not a fixed code: each byte is chained against the one before, and a counter advances with every press. The
 * long preambles mark repeats, so a burst of them means the button is being held.
 */
private fun somfyRts(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val long = UBytes.of(0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xff, 0x00)
    val rate = UBytes.of(0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xfe, 0x00)
    val short = UBytes.of(0xf0, 0xf0, 0xff, 0x00)
    var retransmission = 0
    var decodeRow = -1
    var bitpos = 0
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] > 170) {
            retransmission = 1
            bitpos = bits.search(row, 0, long, 49) + 49
            if (bitpos + 112 > bits.bitsPerRow[row]) bitpos = bits.search(row, 0, rate, 48) + 48
            if (bitpos + 112 <= bits.bitsPerRow[row]) { decodeRow = row; break }
        } else if (bits.bitsPerRow[row] > 130) {
            retransmission = 0
            bitpos = bits.search(row, 0, short, 25) + 25
            if (bitpos + 112 <= bits.bitsPerRow[row]) { decodeRow = row; break }
        }
    }
    if (decodeRow < 0) return DECODE_ABORT_EARLY
    if (bitpos + 112 > bits.bitsPerRow[decodeRow]) return DECODE_ABORT_LENGTH
    val decoded = BitBuffer()
    bits.manchesterDecode(decodeRow, bitpos, decoded, 80)
    if (decoded.numRows == 0 || decoded.bitsPerRow[0] < 56) return DECODE_ABORT_LENGTH
    val b = decoded.bb[0]
    for (i in 6 downTo 1) b[i] = b[i] xor b[i - 1]
    var chk = xorBytes(b, 7)
    chk = (chk and 0x0f) xor (chk shr 4)
    if (chk != 0) return DECODE_FAIL_MIC
    val seed = b[0]
    val control = (b[1] and 0xf0) shr 4
    ctx.emit(data("model" to "Somfy-RTS", "id" to ((b[6] shl 16) or (b[5] shl 8) or b[4]),
        "control" to if (control == 0x0f) SOMFY_SEED[seed and 0x0f] else SOMFY_CONTROL[control],
        "counter" to ((b[2] shl 8) or b[3]), "retransmission" to retransmission, "mic" to "CHECKSUM"))
    return 1
}

private val B433 = listOf(433_920_000L)
private const val SWITCHES = "mains switches and remotes"

internal val REMOTES: List<RDevice> = listOf(
    dev(30, "Generic remote SC226x EV1527", Mod.OOK_PWM, 464, 1404, 1800, tolerance = 200, bands = listOf(433_920_000L, 315_000_000L),
        what = "cheap doorbells, gate openers and alarm sensors", decode = ::genericRemote),
    dev(14, "Intertechno 433", Mod.OOK_PPM, 330, 1400, 10000, gapLimit = 1700, disabled = true, bands = B433, what = SWITCHES, decode = ::intertechno),
    dev(51, "Proove / Nexa / KlikAanKlikUit wireless switch", Mod.OOK_PPM, 270, 1300, 2800, gapLimit = 1500, syncWidth = 2650, tolerance = 200,
        bands = B433, what = SWITCHES, decode = ::proove),
    dev(17, "Cardin S466-TX2", Mod.OOK_PWM, 730, 1400, 32000, gapLimit = 1600, syncWidth = 6150, bands = B433,
        what = "gate and garage door remote", decode = ::cardin),
    dev(167, "Somfy RTS", Mod.OOK_PCM, 604, 604, 10000, gapLimit = 3000, tolerance = 20, bands = listOf(433_420_000L, 433_920_000L),
        what = "awning, blind and shutter remotes", decode = ::somfyRts),
)
