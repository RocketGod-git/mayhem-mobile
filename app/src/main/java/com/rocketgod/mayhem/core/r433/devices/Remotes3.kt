package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * More remotes: Honda and Ford keys, the Dish satellite handset, Linear Megacode, Funkbus wall switches and the
 * Code Alarm FRDPC2002.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): honda_car_key.c, ford_car_key.c, dish_remote_6_3.c, megacode.c,
 * funkbus.c, code_alarm_frdpc2002.c. Twin of web/src/dsp/r433/devices/remotes3.ts.
 */

private val BAND_BOTH = listOf(315_000_000L, 433_920_000L)

private fun sumBytes(m: UBytes, n: Int, at: Int = 0): Int { var s = 0; for (i in 0 until n) s += m[at + i]; return s }

private val HONDA_CODES = listOf("boot", "unlock", "lock")

/** No check at all: two fixed 0xff bytes and the frame length are the only things separating this from noise. */
private fun hondaRemote(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    for (row in 0 until bits.numRows) {
        val n = bits.bitsPerRow[row]
        if (n < 385 || n > 394) continue
        val b = bits.bb[row]
        if (b[0] != 0xff || b[38] != 0xff) continue
        val command = (b[46] - 0xaa) and 0xff
        ctx.emit(data("model" to "Honda-CarRemote", "type" to "Remote", "id" to ((b[44] shl 8) or b[45]),
            "code" to (HONDA_CODES.getOrNull(command) ?: "unknown")))
        return 1
    }
    return 0
}

/** Found by its run-in of three tiny rows (one bit, nine, one); the field meanings were never confirmed upstream. */
private fun fordRemote(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var found = 0
    for (i in 3 until bits.numRows) {
        if (bits.bitsPerRow[i] < 78) continue
        if (bits.bitsPerRow[i - 3] != 1 || bits.bitsPerRow[i - 1] != 1 || bits.bitsPerRow[i - 2] != 9 || bits.bb[i - 2][0] != 0) continue
        val b = bits.bb[i]
        ctx.emit(data("model" to "Ford-CarRemote", "type" to "Remote", "id" to ((b[0] shl 16) or (b[1] shl 8) or b[2]), "code" to b[7]))
        found++
    }
    return found
}

private val DISH_BUTTONS = listOf(
    "Undefined", "Undefined", "Swap", "Undefined", "Position", "PIP", "DVR", "Undefined",
    "Skip Forward", "Skip Backward", "Undefined", "Dish Button", "Undefined", "Forward", "Backward", "TV Power",
    "Reset", "Undefined", "Undefined", "Undefined", "Undefined", "Undefined", "SAT",
    "Mute/Volume Up/Volume Down",
    "Undefined", "#/Search", "*/Format", "Undefined", "Undefined", "Undefined", "Stop", "Pause",
    "Record", "Channel Down", "Undefined", "Left", "Recall", "Channel Up", "Undefined", "Right",
    "TV/Video", "View/Live TV", "Undefined", "Guide", "Undefined", "Cancel", "Digit 0", "Select",
    "Page Up", "Digit 9", "Digit 8", "Digit 7", "Menu", "Digit 6", "Digit 5", "Digit 4",
    "Page Down", "Digit 3", "Digit 2", "Digit 1", "Play", "Dish Power", "Undefined", "Info",
)

/** Six button bits and ten fixed ones, which are its whole integrity; it must arrive three times over. */
private fun dishRemote(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(3, 16)
    if (r < 0 || bits.bitsPerRow[r] > 16) return DECODE_ABORT_LENGTH
    val b = bits.bb[r]
    if ((b[0] and 0x03) != 0x02 || (b[1] and 0xe8) != 0xa8) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Dish-RC63", "type" to "Remote", "button" to DISH_BUTTONS[b[0] shr 2]))
    return 1
}

/**
 * Twenty-four six-millisecond windows, each with exactly one pulse whose half gives the bit. Counting exactly
 * twenty-four pulses is a real check even though the code itself carries no checksum.
 */
private fun megacode(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(1, 144)
    if (row < 0) return DECODE_ABORT_LENGTH
    val l = bits.bitsPerRow[row]
    if (l < 136 || l > 148) return DECODE_ABORT_LENGTH
    var raw = 0; var pulses = 0
    val b = bits.bb[row]
    for (i in 0 until l) {
        if (((b[i shr 3] shl (i % 8)) and 0x80) != 0) {
            if ((i + 4) % 6 > 2) raw = raw or (0x800000 ushr ((i + 4) / 6))
            pulses++
        }
    }
    if (pulses != 24) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Megacode-Remote", "type" to "Remote", "id" to ((raw shr 3) and 0xffff), "raw" to hexUp(raw, 6),
        "facility" to ((raw shr 19) and 0x0f), "button" to (raw and 0x07)))
    return 1
}

/** A run of bits read least significant first, as this protocol lays out every field. */
private fun getBitsReflect(b: UBytes, start: Int, len: Int): Int {
    var result = 0; var mask = 1
    for (i in start until start + len) { if (bitAt(b, i) != 0) result = result or mask; mask = mask shl 1 }
    return result
}

/** The xor of the payload folded to a nibble, each bit mixing in a fixed pattern; the byte's parity is the fifth bit. */
private fun funkbusChecksum(b: UBytes, len: Int): Int {
    val fullBytes = len shr 3
    val bitsLeft = len % 8
    var xorByte = xorBytes(b, fullBytes)
    val mask = (0xff shl (8 - bitsLeft)) and 0xff
    xorByte = (xorByte xor (b[fullBytes] and mask)) and 0xff
    val nibble = ((xorByte and 0xf0) shr 4) xor (xorByte and 0x0f)
    var result = 0
    if ((nibble and 0x8) != 0) result = result xor 0x8c
    if ((nibble and 0x4) != 0) result = result xor 0x32
    if ((nibble and 0x2) != 0) result = result xor 0xc8
    if ((nibble and 0x1) != 0) result = result xor 0x23
    return (result and 0x0f) or (parity8(xorByte) shl 4)
}

/** Insta's lighting bus behind Berker, Gira and Jung wall switches. */
private fun funkbus(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] < 48) return DECODE_ABORT_LENGTH
        val b = bits.bb[row]
        if (getBitsReflect(b, 0, 4) != 0x4 || getBitsReflect(b, 4, 4) != 0x3) return DECODE_ABORT_EARLY
        val parity = getBitsReflect(b, 43, 1)
        val check = getBitsReflect(b, 44, 4)
        val checksum = funkbusChecksum(b, 43)
        if (check != reflect4(checksum and 0x0f) || parity != (checksum shr 4)) return DECODE_FAIL_MIC
        ctx.emit(data("model" to "Funkbus-Remote", "type" to "Remote", "id" to getBitsReflect(b, 8, 20),
            "battery_ok" to if (getBitsReflect(b, 30, 1) != 0) 0 else 1,
            "command" to getBitsReflect(b, 33, 3),       // which button on the remote
            "group" to getBitsReflect(b, 36, 2),         // channel group A to C, or a light scene
            "action" to getBitsReflect(b, 39, 2),        // stop, off, on, scene
            "repeat" to getBitsReflect(b, 41, 1),        // not the first send
            "longpress" to getBitsReflect(b, 42, 1),     // held, for dimming or learning a scene
            "mic" to "CHECKSUM"))
        events++
    }
    return events
}

/** Several buttons share a code, so one value can legitimately name two. */
private val CODE_ALARM_BUTTONS = listOf("Multiple" to listOf(0x7), "Lock" to listOf(0x6, 0x4), "Panic" to listOf(0x1, 0x3),
    "Start" to listOf(0x0, 0x3), "Unlock" to listOf(0x5, 0x4))

/** The identity is recovered by xoring each byte of the rolling code with the next: bits that stay fixed press to press. */
private fun codeAlarm(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 60) return DECODE_ABORT_LENGTH
    if (bits.bb[0][0] != 0x00 || bits.bb[0][1] != 0x00) return DECODE_FAIL_SANITY
    val b = bits.bytes(0, 19, 40)
    val sum = sumBytes(b, 5)
    if (sum == 0 || sum >= 0xff * 5) return DECODE_FAIL_SANITY
    val code = bits.bytes(0, 23, 36)
    val id = ((code[0] xor code[1]) shl 16) or ((code[1] xor code[2]) shl 8) or (code[2] xor code[3])
    val button = b[0] shr 4
    val held = CODE_ALARM_BUTTONS.filter { button in it.second }.map { it.first }
    ctx.emit(data("model" to "CodeAlarm-FRDPC2002", "type" to "Remote", "id" to hexUp(id, 6), "button_code" to button,
        "button_str" to if (held.isEmpty()) "?" else held.joinToString("; "), "data" to hexBytes(b, 5).uppercase()))
    return 1
}

internal val REMOTES3: List<RDevice> = listOf(
    dev(64, "Honda Car Key", Mod.FSK_PWM, 250, 500, 2000, disabled = true, bands = BAND_BOTH, what = "car remote", decode = ::hondaRemote),
    dev(93, "Ford Car Key", Mod.OOK_DMC, 250, 500, 4000, tolerance = 50, disabled = true, bands = BAND_BOTH, what = "car remote", decode = ::fordRemote),
    dev(101, "Dish remote 6.3", Mod.OOK_PPM, 1692, 2812, 9000, gapLimit = 4500, disabled = true, what = "satellite remote", decode = ::dishRemote),
    dev(199, "Linear Megacode Garage/Gate Remotes", Mod.OOK_PCM, 1000, 1000, 20000, gapLimit = 9000, disabled = true,
        bands = listOf(318_000_000L), what = "gate and garage remote", decode = ::megacode),
    dev(202, "Funkbus / Instafunk (Berker, Gira, Jung)", Mod.OOK_DMC, 500, 1000, 2000, gapLimit = 1500, syncWidth = 4000, tolerance = 300,
        bands = listOf(433_420_000L), what = "light switch remote", decode = ::funkbus),
    dev(317, "Code Alarm FRDPC2002 Car Remote", Mod.OOK_MANCHESTER_ZEROBIT, 550, 1100, 1600, tolerance = 100, bands = listOf(315_000_000L),
        what = "car remote", decode = ::codeAlarm),
)
