package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * ThermoPro cooking and outdoor thermometers, and the TFA pool thermometer.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): thermopro_tp11.c, thermopro_tp12.c, thermopro_tx2c.c,
 * thermopro_tx7b.c, tfa_pool_thermometer.c. Twin of web/src/dsp/r433/devices/thermopro.ts.
 */

private val B433 = listOf(433_920_000L)

private fun allSame4(b: UBytes, v: Int) = b[0] == v && b[1] == v && b[2] == v && b[3] == v

private fun tp11(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 32)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 33) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (lfsrDigest8Reflect(b, 3, 0x51, 0x04) != b[3]) return DECODE_FAIL_MIC
    if (allSame4(b, 0) || allSame4(b, 0xff)) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Thermopro-TP11", "id" to ((b[0] shl 4) or (b[1] shr 4)),
        "temperature_C" to round1(((((b[1] and 0x0f) shl 8) or b[2]) - 200) * 0.1), "mic" to "CRC"))
    return 1
}

/** Matches a repeated prefix rather than a whole row, because the last repeat is often a bit short. */
private fun tp12(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedPrefix(if (bits.numRows > 5) 5 else 2, 40)
    if (row < 0) return DECODE_ABORT_EARLY
    val b = bits.bb[row]
    if (allSame4(b, 0)) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 41) return DECODE_ABORT_LENGTH
    if (lfsrDigest8Reflect(b, 4, 0x51, 0x04) != b[4]) return DECODE_FAIL_MIC
    // The food probe takes the high nibble of the shared byte, the pit probe the low one.
    ctx.emit(data("model" to "Thermopro-TP12", "id" to b[0],
        "temperature_1_C" to round1(((((b[2] and 0xf0) shl 4) or b[1]) - 200) * 0.1),
        "temperature_2_C" to round1(((((b[2] and 0x0f) shl 8) or b[3]) - 200) * 0.1), "mic" to "CRC"))
    return 1
}

/** Off by default: no checksum, only two bytes expected to be zero. */
private fun tx2c(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(4, 36)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 45) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (allSame4(b, 0) || allSame4(b, 0xff)) return DECODE_FAIL_SANITY
    if ((b[4] and 0x0f) != 0x00 || b[5] != 0x00) return DECODE_FAIL_SANITY
    val humidity = ((b[3] and 0x0f) shl 4) or (b[4] shr 4)
    val out = data("model" to "Thermopro-TX2C", "id" to (((b[0] and 0x0f) shl 4) or (b[1] shr 4)), "channel" to (b[1] and 0x03) + 1,
        "battery_ok" to if (((b[1] and 0x08) shr 3) != 0) 0 else 1, "temperature_C" to round1((signed((b[2] shl 8) or b[3], 16) shr 4) * 0.1),
        "button" to ((b[1] and 0x04) shr 2))
    if (humidity != 0x0a) out["humidity"] = humidity    // 0x0a: the sensor has no humidity element
    ctx.emit(out)
    return 1
}

private fun tx7b(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY
    val msgLen = bits.bitsPerRow[0]
    if (msgLen > 260) return DECODE_ABORT_LENGTH
    // The real preamble opens with 0xd2, dropped from the pattern because it is often clipped.
    var offset = bits.search(0, 0, UBytes.of(0x55, 0x2d, 0xd4), 24)
    if (offset >= msgLen) return DECODE_ABORT_EARLY
    if (msgLen - offset < 96) return DECODE_ABORT_LENGTH
    offset += 24
    val b = bits.bytes(0, offset, 72)
    if (lfsrDigest8Reverse(b, 8, 0x98, 0x25) != b[8]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "ThermoPro-TX7B", "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1,
        "battery_ok" to if ((b[1] shr 7) != 0) 0 else 1, "button" to ((b[1] and 0x40) shr 6), "flags" to (b[1] and 0x0f),
        "temperature_C" to round1((((b[2] shl 4) or ((b[3] and 0xf0) shr 4)) - 400) * 0.1), "humidity" to b[4], "mic" to "CHECKSUM"))
    return 1
}

/** A sum of nibbles with one subtracted; twelve-bit temperature, negative above half scale. */
private fun tfaPool(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(7, 28)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 28) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    val sum = (b[0] and 0x0f) + (b[1] shr 4) + (b[1] and 0x0f) + (b[2] shr 4) + (b[2] and 0x0f) + (b[3] shr 4) - 1
    if (((b[0] and 0xf0) shr 4) != (sum and 0x0f)) return DECODE_FAIL_MIC
    val raw = ((b[1] and 0x0f) shl 8) or b[2]
    ctx.emit(data("model" to "TFA-Pool", "id" to (((b[0] and 0x0f) shl 4) or ((b[1] and 0xf0) shr 4)), "channel" to ((b[3] and 0xc0) shr 6),
        "battery_ok" to ((b[3] and 0x20) shr 5), "temperature_C" to round1((if (raw > 2048) raw - 4096 else raw) * 0.1), "mic" to "CHECKSUM"))
    return 1
}

internal val THERMOPRO: List<RDevice> = listOf(
    dev(84, "ThermoPro TP11 thermometer", Mod.OOK_PPM, 500, 1500, 4000, gapLimit = 2000, bands = B433, what = "cooking thermometer with one probe", decode = ::tp11),
    dev(97, "ThermoPro TP08/TP12/TP20 thermometer", Mod.OOK_PPM, 500, 1500, 4000, gapLimit = 2000, bands = B433,
        what = "barbecue thermometer with a food probe and a pit probe", decode = ::tp12),
    dev(245, "ThermoPro TX-2C, TX-2B thermometer and humidity sensor", Mod.OOK_PPM, 1958, 3825, 8643, gapLimit = 7000, disabled = true,
        bands = B433, what = "outdoor temperature and humidity sensor", decode = ::tx2c),
    dev(278, "ThermoPro TX-7B outdoor thermometer hygrometer", Mod.FSK_PCM, 108, 108, 1500, bands = B433,
        what = "outdoor temperature and humidity sensor", decode = ::tx7b),
    dev(56, "TFA pool temperature sensor", Mod.OOK_PPM, 2000, 4600, 10000, gapLimit = 7800, bands = B433, what = "floating pool thermometer", decode = ::tfaPool),
)
