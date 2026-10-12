package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Auriol (Lidl) thermometers and rain gauge, and Govee's leak detector and door contact.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): auriol_afw2a1.c, auriol_hg02832.c, auriol_ahfl.c,
 * auriol_4ld5661.c, govee.c. Twin of web/src/dsp/r433/devices/auriol.ts.
 */

private val B433 = listOf(433_920_000L)

private fun temp12(hi: Int, lo: Int) = round1((signed(((hi and 0x0f) shl 12) or (lo shl 4), 16) shr 4) * 0.1)

/** No checksum at all, so twelve identical copies are demanded before anything is believed. */
private fun afw2a1(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(12, 36)
    if (row < 0) return DECODE_ABORT_EARLY
    val b = bits.bb[row]
    if ((b[3] shr 4) != 0xa) return DECODE_FAIL_SANITY
    val tempC = (signed(((b[1] and 0x0f) shl 12) or (b[2] shl 4), 16) shr 4) * 0.1
    val humidity = ((b[3] and 0x0f) shl 4) or (b[4] shr 4)
    if (humidity > 100 || tempC < -51.1 || tempC > 76.7) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Auriol-AFW2A1", "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1, "battery_ok" to (b[1] shr 7),
        "button" to ((b[1] and 0x40) shr 6), "temperature_C" to round1(tempC), "humidity" to humidity))
    return 1
}

/** The four payload bytes are folded together with xor first, and a CRC is taken of that one byte. */
private fun hg02832(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 2) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] != 1 || bits.bitsPerRow[1] != 40) return DECODE_ABORT_LENGTH
    bits.invert()
    val b = bits.bb[1]
    val folded = UBytes.of(b[0] xor b[1] xor b[2] xor b[3])
    if ((crc8(folded, 1, 0x31, 0x53) xor b[4]) != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Auriol-HG02832", "id" to b[0], "channel" to ((b[2] and 0x30) shr 4) + 1,
        "battery_ok" to if ((b[2] shr 7) != 0) 0 else 1, "temperature_C" to temp12(b[2], b[3]), "humidity" to b[1],
        "button" to ((b[2] and 0x40) shr 6), "mic" to "CRC"))
    return 1
}

private fun ahfl(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 42)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 42) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if ((b[4] and 0xf0) != 0x40 || (b[3] and 0x01) != 0x00) return DECODE_FAIL_SANITY
    var sum = 0
    for (i in 0 until 4) sum += (b[i] and 0x0f) + (b[i] shr 4)
    sum += b[4] shr 4
    if ((sum and 0x3f) != (((b[4] and 0x0f) shl 2) or ((b[5] and 0xc0) shr 6))) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Auriol-AHFL", "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1, "battery_ok" to (b[1] shr 7),
        "button" to ((b[1] and 0x40) shr 6), "temperature_C" to temp12(b[1], b[2]), "humidity" to (b[3] shr 1), "mic" to "CHECKSUM"))
    return 1
}

/**
 * Off by default: no sync, no fixed identity, no checksum. The sold display multiplies tips by 0.3 mm, but the
 * bucket and funnel measure almost exactly 1 mm a tip, so that is used and the raw count reported alongside.
 */
private fun ld5661(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var ret = 0
    for (i in 0 until bits.numRows) {
        if (bits.bitsPerRow[i] != 52) { ret = DECODE_ABORT_LENGTH; continue }
        val b = bits.bb[i]
        if (b[3] != 0xf0 || (b[1] and 0x40) != 0) { ret = DECODE_FAIL_MIC; continue }
        val tips = (b[4] shl 12) or (b[5] shl 4) or (b[6] shr 4)
        ctx.emit(data("model" to "Auriol-4LD5661", "id" to b[0], "battery_ok" to (b[1] shr 7),
            "temperature_C" to temp12(b[1], b[2]), "rain_mm" to tips, "rain" to tips))
        return 1
    }
    return ret
}

/** The event code is not a bitfield: particular values mean particular things. */
private fun govee(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 3) return DECODE_ABORT_EARLY
    val r = bits.findRepeatedRow(3, 48)
    if (r < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[r] > 48) return DECODE_ABORT_LENGTH
    val b = bits.bb[r]
    val code = hexBytes(b, 6)
    bits.invert()
    val id = (b[0] shl 8) or b[1]
    if (id == 0xffff || b[5] == 0) return DECODE_ABORT_EARLY
    val eventType = b[2] and 0x0f
    var event = (b[2] shl 8) or b[3]
    if (event == 0xffff) return DECODE_ABORT_EARLY
    // Four check bits sit inside a byte of markers: 101PPPP1.
    val parity = (b[5] shr 1) and 0x0f
    var chk = xorBytes(b, 5)
    chk = (chk shr 4) xor (chk and 0x0f)
    if (chk != parity) return DECODE_FAIL_MIC
    val battery = if (eventType == 0xc) b[3] else 0
    event = event and 0x0fff
    var model = "Govee-Water"
    var wet = -1
    val eventStr = when {
        event == 0xafa -> { wet = 0; "Button Press" }
        event == 0xbfb -> { wet = 1; "Water Leak" }
        eventType == 0xc -> "Battery Report"
        event == 0xdfd -> "Heartbeat"
        event == 0xe7f -> { model = "Govee-Contact"; "Open" }
        else -> "Unknown"
    }
    val out = data("model" to model, "id" to id, "event" to eventStr, "code" to code, "mic" to "PARITY")
    if (battery != 0) { out["battery_ok"] = battery / 100.0; out["battery_mV"] = 1800 + 12 * battery }
    if (wet >= 0) out["detect_wet"] = wet
    ctx.emit(out)
    return 1
}

/** The 2021 hardware replaced the folded parity with a proper CRC. */
private fun goveeH5054(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 3) return DECODE_ABORT_EARLY
    val r = bits.findRepeatedRow(3, 48)
    if (r < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[r] > 48) return DECODE_ABORT_LENGTH
    bits.invert()
    val b = bits.bb[r]
    val code = hexBytes(b, 6)
    if (crc16(b, 6, 0x1021, 0x1d0f) != 0) return DECODE_FAIL_MIC
    val event = b[2] and 0x0f
    val eventData = b[3]
    var wet = -1; var leakNum = -1; var battery = -1
    val eventStr = when (event) {
        0x0 -> { wet = 0; "Button Press" }
        0x1 -> { battery = eventData; "Battery Report" }
        0x2 -> { wet = 1; leakNum = eventData; "Water Leak" }
        else -> "Unknown"
    }
    val out = data("model" to "Govee-Water", "id" to ((b[0] shl 8) or b[1]), "event" to eventStr, "code" to code, "mic" to "CRC")
    if (battery >= 0) { out["battery_ok"] = battery / 100.0; out["battery_mV"] = 1800 + 12 * battery }
    if (wet >= 0) out["detect_wet"] = wet
    if (leakNum >= 0) out["leak_num"] = leakNum
    ctx.emit(out)
    return 1
}

internal val AURIOL: List<RDevice> = listOf(
    dev(146, "Auriol AFW2A1 temperature/humidity sensor", Mod.OOK_PPM, 576, 1536, 3954, gapLimit = 2012, bands = B433,
        what = "outdoor thermometer sold by Lidl", decode = ::afw2a1),
    dev(141, "Auriol HG02832, HG05124A-DCF, Rubicson 48957 temperature/humidity sensor", Mod.OOK_PWM, 252, 612, 62990, gapLimit = 750,
        syncWidth = 860, bands = B433, what = "outdoor thermometer", decode = ::hg02832),
    dev(183, "Auriol AHFL temperature/humidity sensor", Mod.OOK_PPM, 2100, 4150, 9150, gapLimit = 4248, bands = B433,
        what = "outdoor thermometer", decode = ::ahfl),
    dev(200, "Auriol 4-LD5661/4-LD5972/4-LD6313, Sempre 4-AH0423-4 temperature/rain sensor", Mod.OOK_PPM, 1000, 2000, 4000,
        gapLimit = 2500, syncWidth = 2500, disabled = true, bands = B433, what = "rain gauge with a thermometer", decode = ::ld5661),
    dev(192, "Govee water leak detector H5054, door contact sensor B5023", Mod.OOK_PWM, 440, 940, 9000, gapLimit = 900, bands = B433,
        what = "water leak detector and door contact", decode = ::govee),
    dev(231, "Govee water leak detector H5054", Mod.OOK_PWM, 440, 940, 9000, gapLimit = 900, bands = B433,
        what = "water leak detector, the later hardware", decode = ::goveeH5054),
)
