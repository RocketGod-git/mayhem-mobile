package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Olympia Protect 9571 alarm system: door/window contacts, PIR motion sensors and keyfobs on 868.3 to 868.5 MHz.
 * FSK, 366 us per bit, preamble aa aa 2d d4, 48 bits with two constant markers and a byte sum.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): olympia_9571.c. Twin of web/src/dsp/r433/devices/olympia.ts.
 */

private val OLYMPIA_PREAMBLE = UBytes.of(0xaa, 0x2d, 0xd4)
private val OLYMPIA_COMMANDS = mapOf(3 to "Disarm", 4 to "Arm Home + Siren", 5 to "Arm Siren Only", 6 to "Arm Home Only", 7 to "SOS")

private fun olympia9571(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_LENGTH
    var at = bits.search(0, 0, OLYMPIA_PREAMBLE, 24)
    if (at >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    at += 24
    if (at + 48 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 48)

    val id = "%06x".format((b[0] shl 16) or (b[1] shl 8) or b[2])
    val battWeak = (b[4] shr 7) and 1
    val deviceClass = (b[4] shr 4) and 7
    val type = (b[4] shr 1) and 7
    val state = b[4] and 1
    if (((b[3] shr 4) and 0x0f) != 0x8 || (b[3] and 7) != 0x6) return DECODE_FAIL_SANITY
    if (addBytes(b, 5) != b[5]) return DECODE_FAIL_MIC

    val out = when {
        deviceClass == 0 && type == 4 -> data("model" to "Olympia-9571", "subtype" to "Contact", "id" to id, "state" to if (state != 0) "open" else "closed")
        deviceClass == 0 && type == 7 -> data("model" to "Olympia-9571", "subtype" to "PIR-Motion", "id" to id, "state" to if (state != 0) "motion" else "idle")
        deviceClass == 1 -> data("model" to "Olympia-9571", "subtype" to "Keyfob", "id" to id, "cmd" to (OLYMPIA_COMMANDS[type] ?: "Unknown"), "cmd_id" to type)
        else -> return DECODE_FAIL_SANITY
    }
    out["battery_ok"] = if (battWeak != 0) 0 else 1
    out["mic"] = "CHECKSUM"
    ctx.emit(out)
    return 1
}

internal val OLYMPIA: List<RDevice> = listOf(
    dev(386, "Olympia Protect 9571 alarm system sensors", Mod.FSK_PCM, 366, 366, 5000, bands = listOf(868_300_000L),
        what = "alarm door contact, motion sensor and keyfob", decode = ::olympia9571),
)
