package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Remote starters and alarm fobs: Astrostart 2000, Compustar 1WG3R, Audiovox PRO-OE3B and the 2GIG-KEY2E-345.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): astrostart_2000.c, compustar_1wg3r.c, audiovox.c, 2gig_key2e.c.
 * Twin of web/src/dsp/r433/devices/remotes5.ts.
 */

private typealias ButtonMap = List<Pair<String, List<Int>>>

/** Every button a code names, in table order, each at most once. */
private fun buttonNames(map: ButtonMap, code: Int): String {
    val hit = map.filter { code in it.second }.map { it.first }
    return if (hit.isEmpty()) "?" else hit.joinToString("; ")
}

/** The single press plus the five pairings with the other buttons, which is why a value can appear under two names. */
private val ASTROSTART_BUTTONS: ButtonMap = listOf(
    "Lock" to listOf(0x2b, 0x03, 0x27, 0x0f, 0x35, 0x37), "Panic" to listOf(0x1f, 0x35, 0x0d, 0x25, 0x15, 0x2d),
    "Start" to listOf(0x13, 0x37, 0x2d, 0x33, 0x3d, 0x3b), "Stop" to listOf(0x2f, 0x0d, 0x33, 0x03, 0x1d, 0x17),
    "Trunk" to listOf(0x23, 0x25, 0x3d, 0x1d, 0x27, 0x07), "Unlock" to listOf(0x0b, 0x15, 0x3b, 0x17, 0x07, 0x0f),
    "Multiple" to listOf(0x3f),
)

/** The button byte twice (once inverted) and a nibble sum over the serial: two independent checks. */
private fun astrostart(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 52) return DECODE_ABORT_LENGTH
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val b = bits.bb[0]
    if (b[0] != (b[1].inv() and 0xff)) return DECODE_FAIL_MIC
    if ((b[6] shr 4) != (addNibbles(b, 4, 2) and 0x0f)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Astrostart-2000", "id" to hexUp(u32be(b, 2), 8), "button_code" to b[0],
        "button_str" to buttonNames(ASTROSTART_BUTTONS, b[0]), "mic" to "CHECKSUM"))
    return 1
}

/** "Long Press" is every combination's held form; upstream's repeated values are left as written so it can be diffed. */
private val COMPUSTAR_BUTTONS: ButtonMap = listOf(
    "Lock" to listOf(0x03, 0x05, 0x09, 0x0b, 0x0d, 0x0f, 0x1f, 0x17, 0x13, 0x15, 0x19, 0x1b, 0x1d),
    "Panic" to listOf(0x18),
    "Start" to listOf(0x09, 0x0a, 0x0c, 0x0b, 0x0e, 0x0d, 0x04, 0x1f, 0x08, 0x19, 0x1a, 0x1c, 0x1b, 0x1e, 0x1d, 0x12),
    "Trunk" to listOf(0x05, 0x06, 0x0c, 0x0e, 0x0d, 0x1f, 0x17, 0x02, 0x15, 0x16, 0x1c, 0x1e, 0x1d, 0x08, 0x14),
    "Unlock" to listOf(0x03, 0x06, 0x0a, 0x0b, 0x0e, 0x1f, 0x07, 0x17, 0x13, 0x16, 0x1a, 0x1b, 0x1e),
    "Long Press" to listOf(0x23, 0x31, 0x13, 0x16, 0x17, 0x1a, 0x1b, 0x1e, 0x15, 0x16, 0x1c, 0x1e, 0x1d, 0x08, 0x14,
        0x08, 0x19, 0x1a, 0x1c, 0x1b, 0x1e, 0x1d, 0x12, 0x13, 0x15, 0x19, 0x1b, 0x1d),
)

/**
 * A programming mode sends several presses in one burst, so every row is walked: five-bit rows of ones separate
 * batches, and a row identical to the last accepted is a repeat. Upstream tests a trailing bit that is always
 * padding; kept, since changing it would reject frames upstream accepts.
 */
private fun compustar(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0
    var previousRow = -1
    for (row in 0 until bits.numRows) {
        val b = bits.bb[row]
        if (bits.bitsPerRow[row] == 5 && (b[0] and 0xf8) == 0xf8) { previousRow = -1; continue }
        if (bits.bitsPerRow[row] < 35) continue
        if ((b[2] and 0xe0) != 0xe0 || (b[4] and 1) != 0) continue
        if ((b[0] == 0xff && b[1] == 0xff) || (b[0] == 0x00 && b[1] == 0x00)) continue
        // Both button bytes start three bits into a byte.
        val buttonInverse = ((b[2] shl 3) and 0xff) or (b[3] shr 5)
        val button = ((b[3] shl 3) and 0xff) or (b[4] shr 5)
        if ((buttonInverse.inv() and 0xff) != button) continue
        if (previousRow >= 0 && bits.compareRows(previousRow, row, 35)) continue
        previousRow = row
        // The top bit is the remote's secondary mode; upstream's run-on "?Secondary Mode" is reproduced.
        var names = buttonNames(COMPUSTAR_BUTTONS, button and 0x7f)
        if ((button and 0x80) != 0) names += if (names == "?") "Secondary Mode" else "; Secondary Mode"
        ctx.emit(data("model" to "Compustar-1WG3R", "id" to hexUp((b[0] shl 8) or b[1], 4), "button_code" to button,
            "button_str" to names, "mic" to "CHECKSUM"))
        events++
    }
    return events
}

private val AUDIOVOX_BUTTONS = listOf("Lock", "Unlock", "Option", "Trunk")

/**
 * Sent upside down with no check: the sanity test reads the raw byte before inversion and the fields after, as
 * upstream does; only the extracted bytes are complemented, so the shared buffer is left alone.
 */
private fun audiovox(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 25) return DECODE_ABORT_LENGTH
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val b = bits.bb[0]
    if ((b[2] and 0xaa) != 0 || b[2] == 0x55) return DECODE_FAIL_SANITY
    val id = (((b[0].inv() and 0xff) shl 8) or (b[1].inv() and 0xff)) and 0xffff
    if (id == 0 || id == 0xffff) return DECODE_FAIL_SANITY
    val flags = b[2].inv() and 0xff
    val names = AUDIOVOX_BUTTONS.filterIndexed { i, _ -> (flags and (1 shl (2 * i))) != 0 }
    if (names.isEmpty()) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Audiovox-PROOE3B", "id" to hexUp(id, 4), "button_str" to names.joinToString("; ")))
    return 1
}

private val TWOGIG_RUNIN = UBytes.of(0x55, 0x55, 0x56)

/**
 * Forty-eight bits of an unsolved cipher, reported under names that admit it and deliberately not as an id: a
 * rolling value posing as an identity would make one fob look new on every press. The frame itself is sound.
 */
private fun twogig(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 96) return DECODE_ABORT_LENGTH
    val rawLen = bits.bitsPerRow[0]
    val at = bits.search(0, 0, TWOGIG_RUNIN, 24)
    if (at + 24 >= rawLen) return DECODE_ABORT_EARLY
    val msg = BitBuffer()
    bits.manchesterDecode(0, at + 24, msg, 72)
    if (msg.bitsPerRow[0] < 72) return DECODE_ABORT_LENGTH
    val b = msg.bb[0]
    if (b[4] != 0x25) return DECODE_ABORT_EARLY
    if (crc16(b, 7, 0x8005, 0x4c57) != (((b[7] shl 8) or b[8]) and 0xffff)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "TwoGig-KEY2E345", "encrypted_id" to hexBytes(b, 4), "encrypted_status" to hexBytes(b, 2, 5), "mic" to "CRC"))
    return 1
}

internal val REMOTES5: List<RDevice> = listOf(
    dev(301, "Astrostart 2000 Car Remote (-f 372.4M)", Mod.OOK_PPM, 326, 526, 541, gapLimit = 541, tolerance = 80,
        bands = listOf(372_400_000L), what = "car alarm and remote starter", decode = ::astrostart),
    dev(302, "Compustar 1WG3R Car Remote", Mod.OOK_PWM, 708, 1076, 1532, syncWidth = 1448, what = "car alarm remote", decode = ::compustar),
    dev(305, "Audiovox PRO-OE3B Car Remote (-f 303.4M)", Mod.OOK_PWM, 445, 895, 1790, gapLimit = 1790, syncWidth = 1368, priority = 10,
        bands = listOf(303_400_000L), what = "car alarm remote", decode = ::audiovox),
    dev(370, "2GIG-KEY2E-345 encrypted keyfob", Mod.OOK_PCM, 136, 136, 408, disabled = true, bands = listOf(345_000_000L),
        what = "alarm system keyfob", decode = ::twogig),
)
