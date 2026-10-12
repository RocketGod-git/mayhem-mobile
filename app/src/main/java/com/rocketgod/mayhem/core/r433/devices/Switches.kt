package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Switches and remotes: Waveman, KlikAanKlikUit, Nexa, Brennenstuhl, HT680, Akhan, Quhwa doorbell, Blyss, Elro,
 * the RF-tech thermometer and Jasco / GE Choice Alert. A decoder that has to alter bits works on a copy; the shared
 * buffer leaves each decode as it went in.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): waveman.c, newkaku.c, nexa.c, brennenstuhl_rcs_2044.c, ht680.c,
 * akhan_100F14.c, quhwa.c, blyss.c, elro_db286a.c, rftech.c, jasco.c. Twin of web/src/dsp/r433/devices/switches.ts.
 */

private val BAND_433 = listOf(433_920_000L)
private const val SWITCHES = "mains switches and remotes"

private fun copyRow(bits: BitBuffer, row: Int): BitBuffer {
    val out = BitBuffer()
    val src = bits.bb[row]
    for (i in 0 until bits.bitsPerRow[row]) out.addBit(bitAt(src, i))
    return out
}

/**
 * PT2262-style: every other bit is forced to one, so three bytes masked with 0xaa must read 0xaa. The state
 * nibble must be one of the two values real remotes send; the all-ones frame other transmitters emit is refused.
 */
private fun waveman(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 25) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    if (b[0] == 0xff && b[1] == 0xff && b[2] == 0xff) return DECODE_ABORT_EARLY
    if ((b[0] and 0xaa) != 0xaa || (b[1] and 0xaa) != 0xaa || (b[2] and 0xaa) != 0xaa) return DECODE_FAIL_SANITY
    // Bits arrive reversed and inverted: a present pulse pair means the setting is off.
    val nb = IntArray(3) { i ->
        (if ((b[i] and 0x40) != 0) 0 else 0x01) or (if ((b[i] and 0x10) != 0) 0 else 0x02) or
            (if ((b[i] and 0x04) != 0) 0 else 0x04) or (if ((b[i] and 0x01) != 0) 0 else 0x08)
    }
    if (nb[2] != 0xe && nb[2] != 0x6) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Waveman-Switch", "id" to (0x41 + nb[0]).toChar().toString(),   // the house letter on the dial
        "channel" to (nb[1] shr 2) + 1, "button" to (nb[1] and 3) + 1, "state" to if (nb[2] == 0xe) "ON" else "OFF"))
    return 1
}

/**
 * Ternary coding whose two data symbols are a Manchester pair, so decoding stops at the third symbol: exactly the
 * rejection wanted, hence the test that the whole row decoded. On a 64-bit row b[4] reads zero, as upstream's does.
 */
private fun kakuTernary(src: BitBuffer): UBytes? {
    val databits = BitBuffer()
    val pos = src.manchesterDecode(0, 0, databits, 80)
    databits.invert()
    if (pos != 64 && pos != 72) return null
    return databits.bb[0]
}

/**
 * A "11" command is the dim symbol; upstream rewrites it to ON in the shared buffer before decoding, which here is
 * done on a copy. No check at all on the 26-bit address, so no mic is claimed.
 */
private fun newkaku(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.syncsBeforeRow[0] != 1) return DECODE_ABORT_EARLY
    val n = bits.bitsPerRow[0]
    if (n != 64 && n != 72) return DECODE_ABORT_LENGTH
    val dim = (bits.bb[0][6] and 0x03) == 0x03
    var src = bits
    if (dim) { src = copyRow(bits, 0); src.bb[0][6] = src.bb[0][6] and 0xfe }
    val b = kakuTernary(src) ?: return DECODE_ABORT_LENGTH
    ctx.emit(data("model" to "KlikAanKlikUit-Switch", "id" to ((b[0] shl 18) or (b[1] shl 10) or (b[2] shl 2) or (b[3] shr 6)),
        "unit" to (b[3] and 0x0f), "group_call" to if (((b[3] shr 5) and 1) != 0) "Yes" else "No",
        "command" to if (((b[3] shr 4) and 1) != 0) "On" else "Off", "dim" to if (dim) "Yes" else "No", "dim_value" to (b[4] shr 4)))
    return 1
}

/** The frame above with channel and unit stored inverted and no dim symbol; it also takes 72 bits, unlike Proove. */
private fun nexa(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.syncsBeforeRow[0] != 1) return DECODE_ABORT_EARLY
    val n = bits.bitsPerRow[0]
    if (n != 64 && n != 72) return DECODE_ABORT_LENGTH
    val b = kakuTernary(bits) ?: return DECODE_ABORT_LENGTH
    ctx.emit(data("model" to "Nexa-Security", "id" to ((b[0] shl 18) or (b[1] shl 10) or (b[2] shl 2) or (b[3] shr 6)),
        "channel" to (((b[3] shr 2) and 0x03) xor 0x03), "state" to if (((b[3] shr 4) and 1) != 0) "ON" else "OFF",
        "unit" to ((b[3] and 0x03) xor 0x03), "group" to ((b[3] shr 5) and 1)))
    return 1
}

private val BRENNENSTUHL_KEYS = mapOf(0x10 to "A", 0x08 to "B", 0x04 to "C", 0x02 to "D", 0x01 to "E")

/**
 * Each button has its own bit, so a frame naming more than one (or ON and OFF together) is far likelier noise
 * than a command, and is refused: the nearest thing to an integrity check this protocol has.
 */
private fun brennenstuhlRow(bits: BitBuffer, ctx: DecodeCtx, row: Int): Int {
    val b = bits.bb[row]
    if (bits.bitsPerRow[row] != 25 || (b[0] and 0xaa) != 0xaa || (b[1] and 0xaa) != 0xaa || (b[2] and 0xaa) != 0xaa || b[3] != 0x80) return 0
    val systemCode = ((b[0] and 0x40) shr 2) or ((b[0] and 0x10) shr 1) or (b[0] and 0x04) or ((b[0] and 0x01) shl 1) or ((b[1] and 0x40) shr 6)
    val controlKey = (b[1] and 0x10) or ((b[1] and 0x04) shl 1) or ((b[1] and 0x01) shl 2) or ((b[2] and 0x40) shr 5) or ((b[2] and 0x10) shr 4)
    val key = BRENNENSTUHL_KEYS[controlKey] ?: return 0
    val onOff = ((b[2] and 0x04) shr 1) or (b[2] and 0x01)
    if (onOff != 0x02 && onOff != 0x01) return 0
    ctx.emit(data("model" to "Brennenstuhl-RCS2044", "id" to systemCode, "key" to key, "state" to if (onOff == 0x02) "ON" else "OFF"))
    return 1
}

private fun brennenstuhl(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0
    for (row in 0 until bits.numRows) events += brennenstuhlRow(bits, ctx, row)
    return events
}

/** Tied low, floating, (invalid), tied high. */
private val HT680_TRISTATE = listOf("0", "X", "Z", "1")

/**
 * Each bit pair is one pin; four pins every HT680 leaves open are checked separately (upstream once joined them
 * with `&&`). The tri-state string is what you would read off the pads, and the only way to tell remotes apart.
 */
private fun ht680(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] != 41) continue
        if ((bits.bb[row][0] and 0xf8) != 0xa8) continue
        val b = bits.bytes(row, 5, 36)
        if ((b[1] and 0xf0) != 0xa0) continue
        if ((b[2] and 0x0c) != 0x08) continue
        if ((b[3] and 0x30) != 0x20) continue
        if ((b[4] and 0xf0) != 0xa0) continue
        val sb = StringBuilder()
        for (byte in 0 until 5) for (shift in 6 downTo 0 step 2) sb.append(HT680_TRISTATE[(b[byte] shr shift) and 0x03])
        val address = (b[0] shl 12) or (b[1] shl 4) or (b[2] shr 4)
        fun pressed(v: Int) = if (v == 3) "PRESSED" else ""
        ctx.emit(data("model" to "HT680-Remote", "id" to "0x" + hexUp(address, 6), "button1" to pressed(b[3] and 0x03),
            "button2" to pressed((b[3] shr 2) and 0x03), "button3" to pressed((b[3] shr 6) and 0x03), "button4" to pressed(b[2] and 0x03),
            "tristate" to sb.substring(0, 18)))
        return 1
    }
    return 0
}

private val AKHAN_COMMANDS = mapOf(0x1 to "0x1 (Lock)", 0x2 to "0x2 (Unlock)", 0x4 to "0x4 (Mute)", 0x8 to "0x8 (Alarm)")

/** An HS1527: fixed code, no check, and a one-hot command, so twelve of sixteen nibbles are refused outright. */
private fun akhan(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 25) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    val b0 = b[0].inv() and 0xff; val b1 = b[1].inv() and 0xff; val b2 = b[2].inv() and 0xff
    val cmdStr = AKHAN_COMMANDS[b2 and 0x0f] ?: return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Akhan-100F14", "id" to "0x" + Integer.toHexString((b0 shl 12) or (b1 shl 4) or (b2 shr 4)), "data" to cmdStr))
    return 1
}

/**
 * Eighteen inverted bits with four constant, and five matching rows. The all-zero test runs before the complement
 * (it rejects silence read as data) and the length test after it, as upstream orders them.
 */
private fun quhwa(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(5, 18)
    if (r < 0) return DECODE_ABORT_EARLY
    val b = bits.bb[r]
    if (b[0] == 0 && b[1] == 0 && b[2] == 0) return DECODE_FAIL_SANITY
    val b0 = b[0].inv() and 0xff; val b1 = b[1].inv() and 0xff; val b2 = b[2].inv() and 0xff
    if (bits.bitsPerRow[r] != 18 || (b1 and 0x03) != 0x03 || (b2 and 0xc0) != 0xc0) return DECODE_ABORT_LENGTH
    ctx.emit(data("model" to "Quhwa-Doorbell", "id" to ((b0 shl 8) or b1)))
    return 1
}

/** Two literal handset codes upstream's author had; an exact 33-bit match cannot false-trigger. */
private val BLYSS_CODES = listOf(intArrayOf(0xce, 0x8e, 0x2a, 0x6c, 0x80), intArrayOf(0xe7, 0x37, 0x7a, 0x2c, 0x80))

private fun blyss(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] != 33) continue
        val b = bits.bb[row]
        if (BLYSS_CODES.none { code -> code.indices.all { b[it] == code[it] } }) continue
        ctx.emit(data("model" to "Blyss-DC5ukwh", "id" to hexBytes(b, 4)))
        return 1
    }
    return DECODE_FAIL_SANITY
}

/** The Blyss frame without the literal match: length and repetition only, so off upstream, and it claims Blyss codes too. */
private fun elro(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(5, 33)
    if (row < 0 || bits.bitsPerRow[row] != 33) return DECODE_ABORT_LENGTH
    ctx.emit(data("model" to "Elro-DB286A", "id" to hexBytes(bits.bb[row], 4)))
    return 1
}

/** Twenty-four bits, no check, trusted only for repeating three times; nothing bounds the temperature. */
private fun rftech(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(3, 24)
    if (r < 0 || bits.bitsPerRow[r] != 24) return DECODE_ABORT_LENGTH
    val b = bits.bb[r]
    val mag = (b[1] and 0x7f) + (b[2] and 0x0f) * 0.1
    ctx.emit(data("model" to "RF-tech", "id" to b[0], "battery_ok" to if ((b[2] and 0x80) == 0x80) 1 else 0,
        "temperature_C" to if ((b[1] and 0x80) != 0) -mag else mag, "button" to if ((b[2] and 0x60) != 0) 1 else 0))
    return 1
}

private val JASCO_RUNIN = UBytes.of(0xfc, 0x0c)

/** Three bytes and their xor: weak, but the one real check in this family. The run-in cannot occur inside coded data. */
private fun jasco(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val rawLen = bits.bitsPerRow[0]
    if (rawLen < 80 || rawLen > 87) return DECODE_ABORT_EARLY
    val startPos = bits.search(0, 0, JASCO_RUNIN, 16) + 16
    if (startPos + 64 > rawLen) return DECODE_ABORT_LENGTH
    val packet = BitBuffer()
    bits.manchesterDecode(0, startPos, packet, 32)
    if (packet.bitsPerRow[0] < 32) return DECODE_ABORT_LENGTH
    val b = packet.bb[0]
    if ((b[0] xor b[1] xor b[2] xor b[3]) != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Jasco-Security", "id" to ((b[0] shl 8) or b[1]),
        "status" to if ((b[2] and 0xef) == 0xef) 1 else 0,  // 1 is closed
        "mic" to "CHECKSUM"))
    return 1
}

internal val SWITCHES_FAMILY: List<RDevice> = listOf(
    dev(4, "Waveman Switch Transmitter", Mod.OOK_PWM, 357, 1064, 12000, gapLimit = 1400, tolerance = 200, bands = BAND_433,
        what = "mains switch remote", decode = ::waveman),
    dev(15, "KlikAanKlikUit Wireless Switch", Mod.OOK_PPM, 300, 1400, 3200, syncWidth = 2650, tolerance = 200, bands = BAND_433,
        what = SWITCHES, decode = ::newkaku),
    dev(96, "Nexa", Mod.OOK_PPM, 270, 1300, 2800, gapLimit = 1500, syncWidth = 2650, tolerance = 200, bands = BAND_433,
        what = "magnetic door sensor and mains switches", decode = ::nexa),
    dev(24, "Brennenstuhl RCS 2044", Mod.OOK_PWM, 320, 968, 4000, gapLimit = 1500, disabled = true, bands = BAND_433,
        what = "mains socket remote", decode = ::brennenstuhl),
    dev(46, "HT680 Remote control", Mod.OOK_PWM, 200, 600, 14000, gapLimit = 1200, what = "gate and garage door remote", decode = ::ht680),
    // Some variants run their long pulses close to 1100 µs.
    dev(48, "Akhan 100F14 remote keyless entry", Mod.OOK_PWM, 316, 1020, 1800, tolerance = 100, disabled = true,
        what = "car keyless entry remote", decode = ::akhan),
    dev(49, "Quhwa", Mod.OOK_PWM, 360, 1070, 6600, gapLimit = 1200, tolerance = 80, bands = BAND_433, what = "wireless doorbell push", decode = ::quhwa),
    dev(58, "Blyss DC5-UK-WH", Mod.OOK_PWM, 500, 1500, 8000, gapLimit = 2500, bands = BAND_433, what = "mains switch remote", decode = ::blyss),
    dev(62, "Elro DB286A Doorbell", Mod.OOK_PWM, 456, 1448, 8000, gapLimit = 2000, disabled = true, bands = BAND_433,
        what = "wireless doorbell push", decode = ::elro),
    dev(72, "RF-tech", Mod.OOK_PPM, 2000, 4000, 10000, gapLimit = 5000, disabled = true, what = "wireless thermometer", decode = ::rftech),
    dev(204, "Jasco/GE Choice Alert Security Devices", Mod.OOK_PCM, 250, 250, 1800, bands = listOf(318_010_000L),
        what = "door and window sensor", decode = ::jasco),
)
