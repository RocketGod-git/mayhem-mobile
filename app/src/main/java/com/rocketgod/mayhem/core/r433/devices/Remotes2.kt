package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Car remotes: Chrysler, Nidec, MIC 6SC2, GM, Siemens, Alps, Continental and the Honda keyfob. Rolling codes are
 * reported as opaque values; nothing here can open a car.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): chrysler_car_remote.c, nidec_car_remote.c, 6sc2_car_remote.c,
 * gm_car_remote.c, siemens_5wy72xx.c, alps_fwb1u545.c, continental_kr5v2x.c, honda_keyfob.c. Twin of
 * web/src/dsp/r433/devices/remotes2.ts.
 */

private val BAND_315 = listOf(315_000_000L)
private val BAND_BOTH = listOf(315_000_000L, 433_920_000L)
private const val WHAT = "car remote"

/** The byte sum at full width, for all-zero and all-ones tests a masked sum would get wrong. */
private fun sumBytes(m: UBytes, n: Int, at: Int = 0): Int { var s = 0; for (i in 0 until n) s += m[at + i]; return s }

private fun buttonsFrom(mask: Int, names: List<String>): List<String> = names.filterIndexed { i, _ -> (mask and (1 shl i)) != 0 }

/** A multi-press flag that disagrees with how many buttons the code names means the frame decoded wrong. */
private fun chrysler(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0
    bits.invert()
    for (row in 0 until bits.numRows) {
        val offset = when { bits.bitsPerRow[row] >= 49 -> 49; bits.bitsPerRow[row] == 48 -> 48; else -> continue }
        val b = bits.bytes(row, bits.bitsPerRow[row] - offset, 48)
        reflectBytes(b, 6)
        val sum = sumBytes(b, 5)
        if ((sum and 0xff) != b[5]) continue
        if (sum == 0 || sum == 0xff * 5) continue
        val button = b[4] shr 4
        val multiPress = (b[4] and 0x4) != 0
        val held = buttonsFrom(button, listOf("Unlock", "Lock", "Panic"))
        if (held.isEmpty() || (held.size > 1 && !multiPress) || (held.size == 1 && multiPress)) continue
        ctx.emit(data("model" to "Chrysler-CarRemote", "type" to "Remote", "id" to hexUp(u32be(b, 0), 8), "button_code" to button,
            "button_str" to held.joinToString("; "), "mic" to "CHECKSUM"))
        events++
    }
    return events
}

private val NIDEC_BUTTONS = mapOf(0x3 to "Lock", 0x4 to "Unlock", 0x5 to "Trunk/Panic Short Press", 0x6 to "Panic Long Press", 0xf to "Trunk Long Press")

/**
 * The trailing sixteen bits are a keyed authenticator, and the demodulator usually cuts them short, so how many
 * actually arrived is reported. Off by default upstream: nothing here can rule out a foreign frame.
 */
private fun nidec(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] < 128) return DECODE_ABORT_LENGTH
    val offset = bits.search(0, 0, UBytes.of(0xff, 0xff, 0xff, 0xf0), 32) + 32
    if (bits.bitsPerRow[0] - offset < 56) return DECODE_ABORT_EARLY
    val securityBits = minOf(bits.bitsPerRow[0] - offset - 48, 16)
    bits.invert()                                        // the run-in is searched before the frame is turned over
    val b = bits.bytes(0, offset, 64)
    val sequence = (b[0] shl 8) or b[1]
    val id = (b[2] shl 16) or (b[3] shl 8) or b[4]
    val button = b[5] and 0x0f
    val security = ((b[6] shl 8) or b[7]) and 0xffff
    if ((b[5] and 0xf0) != 0x50) return DECODE_FAIL_SANITY
    if (id == 0 || sequence == 0 || id == 0xffffff || sequence == 0xffff || security == 0 || security == 0xffff) return DECODE_FAIL_SANITY
    if (button != 0x3 && button != 0x4 && button != 0x5 && button != 0x6 && button != 0xf) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Nidec-OUCG8D", "type" to "Remote", "id" to hexUp(id, 6), "security" to hexUp(security, 4),
        "security_bits" to securityBits, "sequence" to sequence, "button_code" to button, "button_str" to (NIDEC_BUTTONS[button] ?: "?")))
    return 1
}

private val FOUR_BUTTONS = mapOf(0x1 to "Unlock", 0x2 to "Lock", 0x3 to "Trunk", 0x4 to "Panic")

/** Least significant bit first, so every field is turned around byte by byte. */
private fun sixSc2(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(1, 48)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 88) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[0] != 0x55 || b[1] != 0x54) return DECODE_FAIL_SANITY
    if (xorBytes(b, 9, 2) != 0) return DECODE_FAIL_MIC
    val encrypted = (reverse8(b[5]) shl 24) or (reverse8(b[4]) shl 16) or (reverse8(b[3]) shl 8) or reverse8(b[2])
    val button = reverse8(b[6]) and 0x0f
    ctx.emit(data("model" to "MIC6SC2-CarRemote", "type" to "Remote", "encrypted" to hexUp(encrypted, 8), "button_code" to button,
        "button_str" to (FOUR_BUTTONS[button] ?: "?"), "sequence" to ((reverse8(b[8]) shl 8) or reverse8(b[7])), "mic" to "CHECKSUM"))
    return 1
}

/** Two nested checks, and the wake-up burst may be cut anywhere, so the payload is measured back from the end. */
private fun gm(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] < 113 || bits.numRows > 1) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, bits.bitsPerRow[0] - 113, 112)
    if (b[0] != 0xff) return DECODE_FAIL_SANITY
    val buttonChecksum = addNibbles(b, 1, 2)
    if (buttonChecksum == 0 || (buttonChecksum and 0x0f) != 0) return DECODE_FAIL_MIC
    val fullChecksum = sumBytes(b, 13, 1)
    if (fullChecksum == 0 || (fullChecksum and 0xff) != 0) return DECODE_FAIL_MIC
    val button = b[2] and 0x07
    ctx.emit(data("model" to "GM-ABO1502T", "type" to "Remote", "id" to hexUp(b[1]) + hexUp(u32be(b, 3), 8),
        "encrypted" to hexUp((b[10] shl 16) or (b[11] shl 8) or b[12], 6), "button_code" to button,
        "button_str" to (FOUR_BUTTONS[button] ?: "?"), "sequence" to ((b[7] shl 16) or (b[8] shl 8) or b[9]), "mic" to "CHECKSUM"))
    return 1
}

/** Six buttons, any combination held at once, everything little endian. */
private fun siemens(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] < 113 || bits.numRows > 1) return DECODE_ABORT_LENGTH
    val offset = bits.search(0, 0, UBytes.of(0x60, 0x01), 16) + 16
    val b = bits.bytes(0, offset, 96)
    val sum = sumBytes(b, 12)
    if (sum == 0 || sum == 0xff * 12) return DECODE_FAIL_SANITY
    if (xorBytes(b, 12) != 0) return DECODE_FAIL_MIC
    val held = buttonsFrom(b[4], listOf("Lock", "Unlock", "Trunk", "Panic", "Left Door", "Right Door"))
    ctx.emit(data("model" to "Siemens-5WY72XX", "type" to "Remote", "id" to hexUp(b[3]) + hexUp(b[2]) + hexUp(b[1]) + hexUp(b[0]),
        "encrypted" to hexUp(b[10]) + hexUp(b[9]) + hexUp(b[8]) + hexUp(b[7]), "button_code" to b[4],
        "button_str" to held.joinToString("; "), "sequence" to ((b[5] shl 8) or b[6]), "mic" to "CHECKSUM"))
    return 1
}

private val ALPS_BUTTONS = mapOf(0xe to "Lock", 0xc to "Panic", 0x5 to "Panic Held", 0x1 to "Unlock")

/** No checksum: the button byte is sent twice and the copies must agree, so no mic is claimed. */
private fun alps(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 76 || bits.numRows > 1) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    if (b[0] != 0x55 || b[5] != b[6]) return DECODE_FAIL_SANITY
    val id = u32be(b, 1)
    if (id == 0L || id == 0xffffffffL) return DECODE_FAIL_SANITY
    val button = b[5] shr 4
    ctx.emit(data("model" to "Alps-FWB1U545", "type" to "Remote", "id" to hexUp(id, 8), "button_code" to button,
        "button_str" to (ALPS_BUTTONS[button] ?: "?"), "sequence" to ((b[7] shl 8) or b[8])))
    return 1
}

private val CONTINENTAL_BUTTONS = mapOf(0x1 to "Lock", 0x3 to "Unlock", 0x9 to "Trunk Long Press", 0xa to "Trunk/Panic Short Press", 0xb to "Panic Long Press")

private fun continental(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] < 132) return DECODE_ABORT_LENGTH
    val offset = bits.search(0, 0, UBytes.of(0xf0, 0xf0, 0x60), 20) + 20
    if (bits.bitsPerRow[0] - offset < 112) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, offset, 112)
    val id = u32be(b, 0)
    val button = b[5] shr 4
    val sequence = (b[6] shl 16) or (b[7] shl 8) or b[8]
    val encrypted = u32be(b, 9)
    if (id == 0L || button == 0 || sequence == 0 || id == 0xfffffffL || encrypted == 0xfffffffL || sequence == 0xffffff) return DECODE_FAIL_SANITY
    if (xorBytes(b, 14) != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Continental-KR5V2X", "type" to "Remote", "id" to hexUp(id, 8), "encrypted" to hexUp(encrypted, 8),
        "sequence" to sequence, "button_code" to button, "button_str" to (CONTINENTAL_BUTTONS[button] ?: "?"), "mic" to "CHECKSUM"))
    return 1
}

private val HONDA_EVENTS = mapOf(0x21 to "Lock", 0x22 to "Unlock", 0x24 to "Trunk", 0x27 to "Emergency", 0x2d to "RemoteStart")

/** The same Honda remote as above, read behind Honda's manufacturer code and a proper CRC. */
private fun hondaKeyfob(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] < 150 || bits.bitsPerRow[0] > 184) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, UBytes.of(0xec, 0x0f, 0x62), 24)
    if (at + 16 + 120 > bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    // Only the first two bytes of the manufacturer code are skipped; the third is part of the checked frame.
    val b = bits.bytes(0, at + 16, 120)
    if (crc8(b, 14, 0x2f, 0x00) != b[14]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Honda-KR5V2X1X", "type" to "Remote", "id" to hexOf(u32be(b, 2), 8), "event" to (HONDA_EVENTS[b[6]] ?: "?"),
        "counter" to hexOf((b[7] shl 16) or (b[8] shl 8) or b[9], 6), "code" to hexOf(u32be(b, 10), 8), "mic" to "CRC"))
    return 1
}

internal val REMOTES2: List<RDevice> = listOf(
    dev(303, "Chrysler Car Remote", Mod.OOK_PWM, 350, 700, 350 * 50, gapLimit = 350 * 12, syncWidth = 350 * 21, tolerance = 100,
        bands = BAND_315, what = WHAT, decode = ::chrysler),
    dev(304, "Nidec Car Remote", Mod.FSK_PWM, 250, 500, 1000, disabled = true, bands = BAND_315, what = WHAT, decode = ::nidec),
    dev(312, "MIC 6SC2 Car Remote", Mod.OOK_MANCHESTER_ZEROBIT, 250, 0, 10000, bands = BAND_315, what = WHAT, decode = ::sixSc2),
    dev(313, "GM ABO1502T Car Remote", Mod.OOK_PPM, 300, 500, 20000, bands = BAND_315, what = WHAT, decode = ::gm),
    dev(314, "Siemens 5WY72XX Car Remote", Mod.OOK_MANCHESTER_ZEROBIT, 220, 0, 10000, bands = BAND_315, what = WHAT, decode = ::siemens),
    dev(315, "Alps FWB1U545 Car Remote", Mod.FSK_MANCHESTER_ZEROBIT, 500, 0, 1500, bands = BAND_BOTH, what = WHAT, decode = ::alps),
    dev(316, "Continental KR5V2X Car Remote", Mod.FSK_MANCHESTER_ZEROBIT, 100, 200, 1500, bands = BAND_315, what = WHAT, decode = ::continental),
    dev(327, "Honda Keyfob KR5V2X/1X", Mod.FSK_MANCHESTER_ZEROBIT, 60, 120, 1500, bands = BAND_BOTH, what = WHAT, decode = ::hondaKeyfob),
)
