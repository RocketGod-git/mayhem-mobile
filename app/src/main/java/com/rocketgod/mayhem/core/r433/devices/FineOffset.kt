package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Fine Offset, and everything built on their designs — Ecowitt, Ambient Weather, Misol, Alecto, Froggit. One
 * Shenzhen factory makes the internals of a large share of the world's consumer weather stations. The modern
 * range shifts frequency and shares one arrangement — alternating preamble, sync `2d d4`, a family-code byte, the
 * readings, a CRC and a byte sum — so one decoder reads the burst length and hands off to whichever sibling fits.
 *
 * Ported from rtl_433's fineoffset.c (GPL-2.0-or-later). Twin of web/src/dsp/r433/devices/fineoffset.ts.
 */

private val PREAMBLE = UBytes.of(0xaa, 0x2d, 0xd4)
private val B433 = listOf(433_920_000L)

/** The original OOK sensors (WH2, WH2A, WH5, Telldus / Proove, TFA 303225): row length and first byte pick the model. */
private fun wh2(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    val row0 = bits.bb[0]
    val b: UBytes; val model: String
    if (n == 48 && row0[0] == 0xff) { b = bits.bytes(0, 8, 40); model = "Fineoffset-WH2" }
    else if (n == 55 && row0[0] == 0xfe) { b = bits.bytes(0, 7, 48); model = if (b[3] == 0xff) "TFA-303225" else "Fineoffset-WH2A" }
    else if (n == 47 && row0[0] == 0xfe) { b = bits.bytes(0, 7, 40); model = "Fineoffset-WH5" }
    else if (n == 49 && row0[0] == 0xff && (row0[1] and 0x80) == 0x80) { b = bits.bytes(0, 9, 40); model = "Fineoffset-TelldusProove" }
    else return DECODE_ABORT_LENGTH
    if (b[4] != crc8(b, 4, 0x31, 0)) return DECODE_FAIL_MIC
    if (model == "TFA-303225" && (addBytes(b, 5) and 0xff) != b[5]) return DECODE_FAIL_MIC
    if ((b[0] shr 4) != 4) return DECODE_FAIL_SANITY
    var temp = ((b[1] and 0x0f) shl 8) or b[2]
    var lowBattery = 0
    if (model == "TFA-303225") { lowBattery = if ((temp and 0x800) != 0) 1 else 0; temp = (temp and 0x7ff) - 400 }
    else if (model == "Fineoffset-WH5") temp -= 400
    else if ((temp and 0x800) != 0) temp = -(temp and 0x7ff)
    val temperature = temp * 0.1
    if (model == "Fineoffset-WH5" && (temperature < -40 || temperature > 60)) return DECODE_FAIL_SANITY
    val humidity = b[3]
    val out = data("model" to model, "id" to (((b[0] and 0x0f) shl 4) or ((b[1] and 0xf0) shr 4)), "temperature_C" to round1(temperature), "mic" to "CRC")
    if (model == "TFA-303225") out["battery_ok"] = if (lowBattery != 0) 0 else 1
    if (humidity != 0xff) out["humidity"] = humidity
    ctx.emit(out)
    return 1
}

/** Agimex Rosenborg 66796: the WH5 frame with no offset on the temperature. */
private fun wh5rb(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 47 || bits.bb[0][0] != 0xfe) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, 7, 40)
    if (b[4] != crc8(b, 4, 0x31, 0)) return DECODE_FAIL_MIC
    if ((b[0] shr 4) != 4) return DECODE_FAIL_SANITY
    var temp = ((b[1] and 0x0f) shl 8) or b[2]
    if ((temp and 0x800) != 0) temp = -(temp and 0x7ff)
    val out = data("model" to "Rosenborg-66796", "id" to (((b[0] and 0x0f) shl 4) or ((b[1] and 0xf0) shr 4)), "temperature_C" to round1(temp * 0.1), "mic" to "CRC")
    if (b[3] != 0xff) out["humidity"] = b[3]
    ctx.emit(out)
    return 1
}

private fun payloadStart(bits: BitBuffer) = bits.search(0, 0, PREAMBLE, 24) + 24

private val UVI_UPPER = intArrayOf(432, 851, 1210, 1570, 2017, 2450, 2761, 3100, 3512, 3918, 4277, 4650, 5029)

/** WH24 / WH65 / WS69 / HP1000 outdoor arrays: the model comes from burst length and postamble, not the frame. */
private fun wh24(bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n < 190 || n > 268) return DECODE_ABORT_LENGTH
    val at = payloadStart(bits)
    if (at + 17 * 8 > n) return DECODE_ABORT_LENGTH
    var model = if (n - at - 17 * 8 < 8) (if (at < 61) "Fineoffset-WH24" else "Fineoffset-WH65B") else "Fineoffset-WH65B"
    if (n > 215) model = "Fineoffset-WS69"
    val b = bits.bytes(0, at, 25 * 8)
    if (b[0] != 0x24) return DECODE_FAIL_SANITY
    if (crc8(b, 16, 0x31, 0x00) != 0 || addBytes(b, 16) != b[16]) return DECODE_FAIL_MIC
    var pressureHpa = -1.0
    if (model == "Fineoffset-WS69") {
        val raw = (b[17] shl 16) or (b[18] shl 8) or b[19]
        if (crc8(b, 24, 0x31, 0x00) == 0 && addBytes(b, 24) == b[24] && raw < 0x01ffff) pressureHpa = raw * 0.01
    }
    val wh24 = model == "Fineoffset-WH24"
    val windFactor = if (wh24) 1.12 else 0.51
    val rainPerTip = if (wh24) 0.3 else 0.254
    val windDir = b[2] or ((b[3] and 0x80) shl 1)
    val tempRaw = ((b[3] and 0x07) shl 8) or b[4]
    val humidity = b[5]
    val windRaw = b[6] or ((b[3] and 0x10) shl 4)
    val gustRaw = b[7]
    val uvRaw = (b[10] shl 8) or b[11]
    val lightRaw = (b[12] shl 16) or (b[13] shl 8) or b[14]
    var uvIndex = 0
    while (uvIndex < 13 && UVI_UPPER[uvIndex] < uvRaw) uvIndex++
    val out = data("model" to model, "id" to b[1], "battery_ok" to if (((b[3] and 0x08) shr 3) != 0) 0 else 1,
        "rain_mm" to round1(((b[8] shl 8) or b[9]) * rainPerTip), "mic" to "CRC")
    if (tempRaw != 0x7ff) out["temperature_C"] = round1((tempRaw - 400) * 0.1)
    if (humidity != 0xff) out["humidity"] = humidity
    if (pressureHpa >= 0) out["pressure_hPa"] = jsRound(pressureHpa * 100) / 100
    if (windDir != 0x1ff) out["wind_dir_deg"] = windDir
    if (windRaw != 0x1ff) out["wind_avg_m_s"] = round1(windRaw * 0.125 * windFactor)
    if (gustRaw != 0xff) out["wind_max_m_s"] = round1(gustRaw * windFactor)
    if (uvRaw != 0xffff) { out["uv"] = uvRaw; out["uvi"] = uvIndex }
    if (lightRaw != 0xffffff) out["light_lux"] = round1(lightRaw * 0.1)
    ctx.emit(out)
    return 1
}

/** WH0290 air quality (Ecowitt WH41, Ambient PM25): PM2.5 measured, the "PM10" only estimated by the module. */
private fun wh0290(bits: BitBuffer, ctx: DecodeCtx): Int {
    val at = payloadStart(bits)
    if (at + 64 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 64)
    if (crc8(b, 6, 0x31, 0x00) != b[6] || (addBytes(b, 7) and 0xff) != b[7]) return DECODE_FAIL_MIC
    val bars = ((b[2] and 0x40) shr 4) or ((b[4] and 0xc0) shr 6)
    ctx.emit(data("model" to "Fineoffset-WH0290", "id" to b[1], "battery_ok" to round1(bars * 0.2),
        "pm2_5_ug_m3" to (((b[2] and 0x3f) shl 8) or b[3]) / 10, "estimated_pm10_0_ug_m3" to (((b[4] and 0x3f) shl 8) or b[5]) / 10,
        "family" to b[0], "unknown1" to if ((b[2] and 0x80) != 0) 1 else 0, "mic" to "CRC"))
    return 1
}

/** The indoor console sensors (WH25, WH32, WH32B, WN32B) and the front door to the whole FSK family. */
private fun wh25(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    var type = 25
    if (n < 160) return wh0290(bits, ctx)
    if (n < 190) type = 32
    else if (n < 440) return wh24(bits, ctx)
    if (n > 510) type = 32
    val at = payloadStart(bits)
    if (at + 64 > n) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 64)
    val msgType = b[0] and 0xf0
    if (type == 32 && msgType == 0xd0) type = 31
    else if (msgType != 0xe0) { if (b[0] == 0x41) return wh0290(bits, ctx); return DECODE_ABORT_EARLY }
    if ((((addBytes(b, 6) and 0xff) - b[6]) and 0xff) != 0) return DECODE_FAIL_MIC
    val bitsum = xorBytes(b, 6)
    if (type == 25 && (((bitsum and 0x0f) shl 4) or (bitsum shr 4)) != b[7]) return DECODE_FAIL_MIC
    val tempRaw = ((b[1] and 0x03) shl 8) or b[2]
    val pressureRaw = (b[4] shl 8) or b[5]
    val out = data("model" to when (type) { 31 -> "Fineoffset-WH32"; 32 -> "Fineoffset-WH32B"; else -> "Fineoffset-WH25" },
        "id" to (((b[0] and 0x0f) shl 4) or (b[1] shr 4)), "battery_ok" to if (((b[1] and 0x08) shr 3) != 0) 0 else 1,
        "temperature_C" to round1((tempRaw - 400) * 0.1), "humidity" to b[3], "mic" to "CRC")
    if (pressureRaw != 0xffff) out["pressure_hPa"] = round1(pressureRaw * 0.1)
    ctx.emit(out)
    return 1
}

/** WH51 soil moisture (and the WN31 sharing its frame): its own percentage plus the raw reading behind it. */
private fun wh51(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] < 120) return DECODE_ABORT_LENGTH
    val at = payloadStart(bits)
    if (at + 14 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 14 * 8)
    if (b[0] != 0x51) return DECODE_ABORT_EARLY
    if ((addBytes(b, 13) and 0xff) != b[13]) return DECODE_FAIL_MIC
    if (crc8(b, 12, 0x31, 0) != b[12]) return DECODE_FAIL_MIC
    val mvBits = b[4] and 0x1f
    val level = when { mvBits >= 16 -> 1.0; mvBits == 15 -> 0.9; mvBits == 14 -> 0.5; mvBits == 13 -> 0.1; else -> 0.0 }
    ctx.emit(data("model" to "Fineoffset-WH51", "id" to hexOf(b[1]) + hexOf(b[2]) + hexOf(b[3]), "battery_ok" to level,
        "battery_mV" to mvBits * 100, "moisture" to b[6], "boost" to ((b[4] and 0xe0) shr 5),
        "ad_raw" to (((b[7] and 0x01) shl 8) or b[8]), "mic" to "CRC"))
    return 1
}

/** Alecto WS-1200 rain / temperature, two revisions, and its radio clock frame. */
private fun alectoWs1200(bits: BitBuffer, ctx: DecodeCtx, version: Int): Int {
    val n = bits.bitsPerRow[0]
    val row0 = bits.bb[0]
    val want = if (version == 1) 63 else 95
    if (n != want || (row0[0] shr 1) != 0x7f) return DECODE_ABORT_LENGTH
    if (version == 2 && (row0[1] shr 5) != 0x3) {
        if ((row0[1] shr 1) != 0x52) return DECODE_ABORT_LENGTH
        val c = bits.bytes(0, 7, 88)
        if (crc8(c, 10, 0x31, 0) != 0 || ((addBytes(c, 10) - c[10]) and 0xff) != 0) return DECODE_FAIL_MIC
        // every field is already decimal digits, so it is printed rather than converted
        ctx.emit(data("model" to "Alecto-WS1200v2", "id" to c[1], "battery_ok" to if (((c[2] shr 7) and 1) != 0) 0 else 1,
            "radio_clock" to "${Integer.toHexString(c[4] + 0x2000)}-${hexOf(c[5])}-${hexOf(c[6])}T${hexOf(c[7])}:${hexOf(c[8])}:${hexOf(c[9])}", "mic" to "CRC"))
        return 1
    }
    if (version == 1 && (row0[1] shr 5) != 0x3) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, 7, if (version == 1) 56 else 88)
    if (crc8(b, 7, 0x31, 0) != 0) return DECODE_FAIL_MIC
    if (version == 2 && ((addBytes(b, 7) - b[7]) and 0xff) != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to if (version == 1) "Alecto-WS1200v1" else "Alecto-WS1200v2", "id" to (((b[0] and 0x0f) shl 4) or (b[1] shr 4)),
        "battery_ok" to if (((b[1] shr 3) and 1) != 0) 0 else 1, "temperature_C" to round1(((((b[1] and 0x07) shl 8) or b[2]) - 400) * 0.1),
        "rain_mm" to round1(((b[4] shl 8) or b[3]) * 0.3), "mic" to "CRC"))
    return 1
}

private fun wh0530(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n == 63) return alectoWs1200(bits, ctx, 1)
    if (n == 95) return alectoWs1200(bits, ctx, 2)
    if (n != 71) return DECODE_ABORT_LENGTH
    val row0 = bits.bb[0]
    if ((row0[0] shr 1) != 0x7f || (row0[1] shr 5) != 0x3) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, 7, 64)
    if (crc8(b, 7, 0x31, 0) != 0 || ((addBytes(b, 7) - b[7]) and 0xff) != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Fineoffset-WH0530", "id" to (((b[0] and 0x0f) shl 4) or (b[1] shr 4)),
        "battery_ok" to if (((b[1] shr 3) and 1) != 0) 0 else 1, "temperature_C" to round1(((((b[1] and 0x07) shl 8) or b[2]) - 400) * 0.1),
        "rain_mm" to round1(((b[4] shl 8) or b[3]) * 0.3), "mic" to "CRC"))
    return 1
}

internal val FINEOFFSET: List<RDevice> = listOf(
    dev(18, "Fine Offset Electronics WH2, WH5, Telldus temperature/humidity/rain sensor", Mod.OOK_PWM, 500, 1500, 1200, tolerance = 160, bands = B433,
        what = "outdoor thermometer, the older on-off keyed generation", decode = ::wh2),
    dev(356, "Agimex Rosenborg 66796 temperature/humidity sensor", Mod.OOK_PWM, 500, 1500, 1200, tolerance = 160, bands = B433,
        what = "outdoor thermometer sold in Denmark; shares a frame with the WH5", decode = ::wh5rb),
    dev(78, "Fine Offset WH25, WH32, WH32B, WN32B, WH24, WH65, WS69, HP1000, Misol WS2320 temperature/humidity/pressure sensor", Mod.FSK_PCM, 58, 58, 20000,
        bands = listOf(433_920_000L, 868_300_000L, 915_000_000L), what = "indoor console sensors and outdoor weather arrays", decode = ::wh25),
    dev(142, "Fine Offset / Ecowitt WH51, WN31, SwitchDoc Labs SM23 soil moisture sensor", Mod.FSK_PCM, 58, 58, 5000,
        bands = listOf(433_920_000L, 915_000_000L), what = "soil moisture probe", decode = ::wh51),
    dev(79, "Fine Offset Electronics WH0530 temperature/rain sensor", Mod.OOK_PWM, 504, 1480, 1200, tolerance = 160, bands = B433,
        what = "rain gauge with a thermometer; also the Alecto WS-1200", decode = ::wh0530),
)
