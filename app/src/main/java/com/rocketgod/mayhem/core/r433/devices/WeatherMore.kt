package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Kedsum, Solight, Silvercrest, WT450 and the TFA Twin Plus.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): kedsum.c, solight_te44.c, silvercrest.c, wt450.c, tfa_twin_plus_30.3049.c.
 * Twin of web/src/dsp/r433/devices/weather-more.ts.
 */

private val B433 = listOf(433_920_000L)

/** Five empty rows lead as the sync; battery comes in three steps, which is all the sensor knows. */
private fun kedsum(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 5) return DECODE_ABORT_EARLY
    for (i in 0 until 5) if (bits.bitsPerRow[i] != 0) return DECODE_ABORT_EARLY
    val r = bits.findRepeatedRow(4, 42)
    if (r < 0 || bits.bitsPerRow[r] != 42) return DECODE_ABORT_LENGTH
    val b = bits.bytes(r, 2, 40)
    if ((crc4(b, 4, 0x3, 0x0) xor (b[4] shr 4)) != (b[4] and 0x0f)) return DECODE_FAIL_MIC
    val level = b[1] shr 6
    ctx.emit(data("model" to "Kedsum-TH", "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1,
        "battery_ok" to (if (level == 2) 100 else level * 10) / 100.0, "flags" to ((b[1] and 0xc0) or (b[4] shr 4)),
        "temperature_F" to round1(((((b[2] and 0x0f) shl 8) or (b[2] and 0xf0) or (b[1] and 0x0f)) - 900) * 0.1),
        "humidity" to (((b[3] and 0x0f) shl 4) or ((b[3] and 0xf0) shr 4)), "mic" to "CRC"))
    return 1
}

/** Shares its frame and CRC with Rubicson, and runs before Nexus for the same reason. */
private fun solight(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(3, 36)
    if (r < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[r] != 37) return DECODE_ABORT_LENGTH
    val b = bits.bb[r]
    if ((b[3] and 0xf0) != 0xf0) return DECODE_ABORT_EARLY
    val tmp = UBytes.of(b[0], b[1], b[2], b[3] and 0xf0, ((b[3] and 0x0f) shl 4) or ((b[4] and 0xf0) shr 4))
    if (crc8(tmp, 5, 0x31, 0x6c) != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Solight-TE44", "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1,
        "temperature_C" to round1((signed((b[1] shl 12) or (b[2] shl 4), 16) shr 4) * 0.1), "mic" to "CRC"))
    return 1
}

private val SILVERCREST_CMDS = intArrayOf(2, 3, 0, 1, 4, 5, 7, 6, 0xc, 0xd, 0xf, 0xe, 8, 9, 0xb, 0xa)

/** Each command is sent plainly and through a substitution table; the two must agree. */
private fun silvercrest(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[1] != 33) return DECODE_ABORT_LENGTH
    val b = bits.bb[1]
    if (b[0] != 0x7c || b[1] != 0x26) return DECODE_ABORT_EARLY
    val cmd = b[2] and 0x0f
    if ((b[3] and 0x0f) != SILVERCREST_CMDS[cmd]) return DECODE_ABORT_EARLY
    ctx.emit(data("model" to "Silvercrest-Remote", "button" to cmd))
    return 1
}

/** Differential Manchester; temperature is whole degrees plus sixteenths. */
private fun wt450(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 36) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    if ((b[0] shr 4) != 0xc) return DECODE_ABORT_EARLY
    var parity = xorBytes(b, 5)
    parity = parity xor (parity shr 4)
    parity = parity xor (parity shr 2)
    if ((parity and 0x03) != 0) return DECODE_FAIL_MIC
    val humidity = ((b[1] and 0x07) shl 4) or (b[2] shr 4)
    val whole = ((b[2] shl 4) or (b[3] shr 4)) and 0xff
    val temp = (whole - 50) + (b[3] and 0x0f) / 16.0
    if (humidity > 100) return DECODE_FAIL_SANITY
    if (temp < -35 || temp > 75) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "WT450-TH", "id" to (b[0] and 0x0f), "channel" to (b[1] shr 6) + 1,
        "battery_ok" to if ((b[1] and 0x08) != 0) 0 else 1, "temperature_C" to round2(temp), "humidity" to humidity,
        "seq" to (b[4] shr 6)))
    return 1
}

/** LSB first, so read from a reversed copy; the sign lives in the original bytes and is nine-bit two's complement. */
private fun tfaTwinPlus(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 36)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 36) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0 && b[4] == 0) return DECODE_ABORT_EARLY
    val rb = IntArray(5) { reverse8(b[it]) }
    var sum = 0
    for (i in 0 until 4) sum += (rb[i] shr 4) + (rb[i] and 0x0f)
    if ((rb[4] and 0x0f) != (sum and 0x0f)) return DECODE_FAIL_MIC
    val negative = b[2] and 0x07
    val temp = ((rb[2] and 0x1f) shl 4) or (rb[1] shr 4)
    ctx.emit(data("model" to "TFA-TwinPlus", "id" to ((rb[0] and 0x0f) or ((rb[0] and 0xc0) shr 2)), "channel" to ((b[0] shr 2) and 0x03),
        "battery_ok" to if ((b[1] shr 7) != 0) 0 else 1,
        "temperature_C" to round1((if (negative != 0) -((1 shl 9) - temp) else temp) * 0.1),
        "humidity" to (rb[3] and 0x7f) - 28, "mic" to "CHECKSUM"))
    return 1
}

internal val WEATHER_MORE: List<RDevice> = listOf(
    dev(57, "Kedsum temperature & humidity sensor, Pearl NC-7415", Mod.OOK_PPM, 2000, 4000, 9400, gapLimit = 4400, bands = B433,
        what = "outdoor temperature and humidity sensor", decode = ::kedsum),
    dev(85, "Solight TE44/TE66, EMOS E0107T, NX-6876-917", Mod.OOK_PPM, 972, 1932, 6000, gapLimit = 3000, priority = 5, bands = B433,
        what = "outdoor thermometer", decode = ::solight),
    dev(1, "Silvercrest remote control", Mod.OOK_PWM, 264, 744, 12000, gapLimit = 5000, bands = B433, what = "remote handset", decode = ::silvercrest),
    dev(33, "WT450, WT260H, WT405H", Mod.OOK_DMC, 976, 1952, 18000, tolerance = 100, bands = B433,
        what = "indoor and outdoor temperature and humidity sensors", decode = ::wt450),
    dev(31, "TFA Twin Plus 30.3049, Conrad KW9010, Ea2 BL999", Mod.OOK_PPM, 2000, 4000, 10000, gapLimit = 6000, bands = B433,
        what = "outdoor temperature and humidity sensor", decode = ::tfaTwinPlus),
)
