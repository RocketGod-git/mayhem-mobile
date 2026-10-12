package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.min

/*
 * The Fine Offset air-quality sensors and the big outdoor arrays, plus the WH1080 that started the line. All-ones
 * fields mean "not measured this time", and battery is bars split across two bytes where six bars means external
 * power. The WH1080 predates the rest: keyed and frequency-shifted versions, three message types on one frame,
 * seven- or eight-bit preambles, and a CRC that starts at 0xff because the preamble byte is inside it.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): fineoffset_wh1080.c, _wh43.c, _wh45.c, _wh46.c, _ws85.c, _ws90.c.
 * Twin of web/src/dsp/r433/devices/fineoffset3.ts.
 */

private val BANDS = listOf(433_920_000L, 868_300_000L, 915_000_000L)
private fun hex6(b: UBytes) = hexOf((b[1] shl 16) or (b[2] shl 8) or b[3], 6)
private val SYNC24 = UBytes.of(0xaa, 0x2d, 0xd4)
private val SYNC32 = UBytes.of(0xaa, 0xaa, 0x2d, 0xd4)

private class Batt(val bars: Int, val level: Double, val extPower: Int)
private fun batteryBars(hi: Int, lo: Int): Batt { val bars = ((hi and 0x40) shr 4) or ((lo and 0xc0) shr 6); return Batt(bars, min(bars * 0.2, 1.0), if (bars == 6) 1 else 0) }

private fun wh43(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val at = bits.search(0, 0, SYNC24, 24) + 24
    if (at + 10 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 10 * 8)
    if (b[0] != 0x43) return DECODE_ABORT_EARLY
    if (crc8(b, 8, 0x31, 0x00) != b[8] || (addBytes(b, 9) and 0xff) != b[9]) return DECODE_FAIL_MIC
    val batt = batteryBars(b[4], b[6])
    ctx.emit(data("model" to "Fineoffset-WH43", "id" to hex6(b), "battery_ok" to if (batt.bars > 1) 1 else 0,
        "battery_pct" to jsRound(100 * batt.level), "ext_power" to batt.extPower,
        "pm2_5_ug_m3" to (((b[4] and 0x3f) shl 8) or b[5]) / 10, "estimated_pm10_0_ug_m3" to (((b[6] and 0x3f) shl 8) or b[7]) / 10, "mic" to "CRC"))
    return 1
}

private fun wh45(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n < 170 || n > 240) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, SYNC24, 24) + 24
    if (at + 15 * 8 > n) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 15 * 8)
    if (b[0] != 0x45) return DECODE_ABORT_EARLY
    if (crc8(b, 13, 0x31, 0x00) != b[13] || (addBytes(b, 14) and 0xff) != b[14]) return DECODE_FAIL_MIC
    val batt = batteryBars(b[7], b[9])
    ctx.emit(data("model" to "Fineoffset-WH45", "id" to hex6(b), "battery_ok" to round1(batt.level), "ext_power" to batt.extPower,
        "temperature_C" to round1(((((b[4] and 0x07) shl 8) or b[5]) - 400) * 0.1), "humidity" to b[6],
        "pm2_5_ug_m3" to round1((((b[7] and 0x3f) shl 8) or b[8]) * 0.1), "pm10_ug_m3" to round1((((b[9] and 0x3f) shl 8) or b[10]) * 0.1),
        "co2_ppm" to ((b[11] shl 8) or b[12]), "mic" to "CRC"))
    return 1
}

private fun wh46(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val at = bits.search(0, 0, SYNC24, 24) + 24
    if (at + 21 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 21 * 8)
    if (b[0] != 0x46) return DECODE_ABORT_EARLY
    if (crc8(b, 19, 0x31, 0x00) != b[19] || (addBytes(b, 20) and 0xff) != b[20]) return DECODE_FAIL_MIC
    val batt = batteryBars(b[7], b[9])
    ctx.emit(data("model" to "Fineoffset-WH46", "id" to hex6(b), "battery_ok" to if (batt.bars > 1) 1 else 0,
        "battery_pct" to jsRound(100 * batt.level), "ext_power" to batt.extPower,
        "temperature_C" to round1(((((b[4] and 0x07) shl 8) or b[5]) - 400) * 0.1), "humidity" to b[6],
        "pm1_ug_m3" to round1(((b[13] shl 8) or b[14]) * 0.1), "pm2_5_ug_m3" to round1((((b[7] and 0x3f) shl 8) or b[8]) * 0.1),
        "pm4_ug_m3" to round1(((b[15] shl 8) or b[16]) * 0.1), "pm10_ug_m3" to round1((((b[9] and 0x3f) shl 8) or b[10]) * 0.1),
        "co2_ppm" to ((b[11] shl 8) or b[12]), "mic" to "CRC", "unknown1" to ((b[17] shl 8) or b[18])))
    return 1
}

private const val NO_WIND = 0x1ff
private const val NO_BYTE = 0xff

private fun ws85(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n < 168 || n > 500) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, SYNC32, 32) + 32
    if (at + 32 * 8 > n) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 32 * 8)
    if (b[0] != 0x85) return DECODE_ABORT_EARLY
    if (crc8(b, 26, 0x31, 0x00) != b[26] || (addBytes(b, 27) and 0xff) != b[27]) return DECODE_FAIL_MIC
    val flags = b[5]
    val windAvg = ((flags and 0x10) shl 4) or b[7]
    val windDir = ((flags and 0x20) shl 3) or b[8]
    val windMax = ((flags and 0x40) shl 2) or b[9]
    val batteryMv = b[4] * 20
    val supercap = b[17] and 0x3f
    val out = data("model" to "Fineoffset-WS85", "id" to hex6(b), "battery_ok" to if (batteryMv > 2400) 1 else 0,
        "battery_pct" to min(100, if (batteryMv < 1400) 0 else (batteryMv - 1400) / 16), "battery_mV" to batteryMv,
        "flags" to hexOf(flags), "rain_mm" to round1(((b[15] shl 8) or b[16]) * 0.1), "rain_start" to ((b[12] and 0x10) shr 4),
        "firmware" to b[25], "mic" to "CRC")
    if (windDir != NO_WIND) out["wind_dir_deg"] = windDir
    if (windAvg != NO_WIND) out["wind_avg_m_s"] = round1(windAvg * 0.1)
    if (windMax != NO_WIND) out["wind_max_m_s"] = round1(windMax * 0.1)
    if (supercap != NO_BYTE) out["supercap_V"] = round1(supercap * 0.1)
    ctx.emit(out)
    return 1
}

private fun ws90(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n < 168 || n > 500) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, SYNC32, 32) + 32
    if (at + 32 * 8 > n) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 32 * 8)
    if (b[0] != 0x90) return DECODE_ABORT_EARLY
    if (crc8(b, 31, 0x31, 0x00) != 0 || (addBytes(b, 31) and 0xff) != b[31]) return DECODE_FAIL_MIC
    val flags = b[7]
    val lightRaw = (b[4] shl 8) or b[5]
    val batteryMv = b[6] * 20
    val tempRaw = ((flags and 0x03) shl 8) or b[8]
    val windAvg = ((flags and 0x10) shl 4) or b[10]
    val windDir = ((flags and 0x20) shl 3) or b[11]
    val windMax = ((flags and 0x40) shl 2) or b[12]
    val pressure = (b[14] shl 8) or b[15]
    val supercap = b[21] and 0x3f
    val out = data("model" to "Fineoffset-WS90", "id" to hex6(b),
        "battery_ok" to round2(min(100, if (batteryMv < 1400) 0 else (batteryMv - 1400) / 16) * 0.01), "battery_mV" to batteryMv,
        "flags" to hexOf(flags), "rain_mm" to round1(((b[19] shl 8) or b[20]) * 0.1), "rain_start" to ((b[16] and 0x10) shr 4),
        "firmware" to b[29], "mic" to "CRC")
    if (tempRaw != 0x3ff) out["temperature_C"] = round1((tempRaw - 400) * 0.1)
    if (b[9] != NO_BYTE) out["humidity"] = b[9]
    if (pressure != 0x3fff) out["pressure_hPa"] = pressure
    if (windDir != NO_WIND) out["wind_dir_deg"] = windDir
    if (windAvg != NO_WIND) out["wind_avg_m_s"] = round1(windAvg * 0.1)
    if (windMax != NO_WIND) out["wind_max_m_s"] = round1(windMax * 0.1)
    if (b[13] != NO_BYTE) out["uvi"] = round1(b[13] * 0.1)
    if (lightRaw != 0xffff) out["light_lux"] = lightRaw * 10
    if (supercap != NO_BYTE) out["supercap_V"] = round1(supercap * 0.1)
    ctx.emit(out)
    return 1
}

private val WIND_DIR = intArrayOf(0, 23, 45, 68, 90, 113, 135, 158, 180, 203, 225, 248, 270, 293, 315, 338)

/** WH1080 / WH3080: no family code, so length and a nibble decide; short preambles are shifted back into line. */
private fun wh1080(bits: BitBuffer, ctx: DecodeCtx, fsk: Boolean): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val n = bits.bitsPerRow[0]
    val br: UBytes
    var sensMsg = 10
    var shortPreamble = false
    if (fsk) {
        val at = bits.search(0, 0, SYNC24, 24) + 24
        if (at + 11 * 8 > n) return DECODE_ABORT_LENGTH
        br = bits.bytes(0, at - 8, 11 * 8)
        br[0] = 0xff
    } else if (n in 88..99) br = bits.bytes(0, 0, 11 * 8)
    else if (n == 87) {
        shortPreamble = true
        br = UBytes(11); br.setAll(bits.bytes(0, 7, 10 * 8), 1); br[0] = (bits.bb[0][0] shr 1) or 0x80
    } else if (n == 64) { sensMsg = 7; br = bits.bytes(0, 0, 8 * 8) }
    else if (n == 63) {
        shortPreamble = true; sensMsg = 7
        br = UBytes(8); br.setAll(bits.bytes(0, 7, 7 * 8), 1); br[0] = (bits.bb[0][0] shr 1) or 0x80
    } else return DECODE_ABORT_LENGTH
    if (br[0] != 0xff) return DECODE_FAIL_SANITY
    if (crc8(br, if (sensMsg == 10) 11 else 8, 0x31, 0xff) != 0) return DECODE_FAIL_MIC
    val msgType = when (br[1] shr 4) { 0x0a -> 0; 0x0b -> 1; 0x07 -> 2; else -> return DECODE_FAIL_SANITY }
    val id = ((br[1] shl 4) and 0xf0) or (br[2] shr 4)
    fun two(v: Int) = ((v and 0xf0) shr 4) * 10 + (v and 0x0f)
    fun p2(v: Int) = v.toString().padStart(2, '0')
    if (msgType == 0) {
        val tempC = if (fsk) {
            var raw = ((br[2] and 0x0f) shl 8) or br[3]
            if ((raw and 0x800) != 0) raw = -(raw and 0x7ff)
            raw * 0.1
        } else ((((br[2] and 0x03) shl 8) or br[3]) - 400) * 0.1
        ctx.emit(data("model" to "Fineoffset-WHx080", "subtype" to msgType, "id" to id, "battery_ok" to if ((br[9] shr 4) == 1) 0 else 1,
            "temperature_C" to round1(tempC), "humidity" to br[4], "wind_dir_deg" to WIND_DIR[br[9] and 0x0f],
            "wind_avg_km_h" to round2(br[5] * 0.34 * 3.6), "wind_max_km_h" to round2(br[6] * 0.34 * 3.6),
            "rain_mm" to round1((((br[7] and 0x0f) shl 8) or br[8]) * 0.3), "mic" to "CRC"))
        return 1
    }
    if (msgType == 1) {
        val clock = "${2000 + two(br[6])}-${p2(((br[7] and 0x10) shr 4) * 10 + (br[7] and 0x0f))}-${p2(two(br[8]))}T" +
            "${p2(((br[3] and 0x30) shr 4) * 10 + (br[3] and 0x0f))}:${p2(two(br[4]))}:${p2(two(br[5]))}"
        ctx.emit(data("model" to "Fineoffset-WHx080", "subtype" to msgType, "id" to id,
            "signal" to if ((br[2] and 0x0f) == 10) "DCF77" else "WWVB/MSF", "radio_clock" to clock, "mic" to "CRC"))
        return 1
    }
    val light = (br[4] shl 16) or (br[5] shl 8) or br[6]
    ctx.emit(data("model" to "Fineoffset-WHx080", "subtype" to msgType, "uv_sensor_id" to id, "uv_status" to if (br[3] == 85) "OK" else "ERROR",
        "uv_index" to (br[2] and 0x0f), "lux" to round1(light * 0.1), "wm" to round2(light / (if (shortPreamble) 1265.8 else 6830.0)), "mic" to "CRC"))
    return 1
}

internal val FINEOFFSET3: List<RDevice> = listOf(
    dev(283, "Fine Offset WH43 air quality sensor", Mod.FSK_PCM, 58, 58, 2500, bands = BANDS, what = "particulate sensor", decode = ::wh43),
    dev(219, "Fine Offset WH45 air quality sensor", Mod.FSK_PCM, 58, 58, 2500, bands = BANDS, what = "particulate and carbon dioxide sensor", decode = ::wh45),
    dev(262, "Fine Offset WH46 air quality sensor", Mod.FSK_PCM, 58, 58, 2500, bands = BANDS, what = "particulate and carbon dioxide sensor, four particle sizes", decode = ::wh46),
    dev(287, "Fine Offset WS85 weather station", Mod.FSK_PCM, 58, 58, 3000, bands = BANDS, what = "outdoor array: wind and rain", decode = ::ws85),
    dev(244, "Fine Offset WS90 weather station", Mod.FSK_PCM, 58, 58, 3000, bands = BANDS,
        what = "outdoor array: wind, rain, temperature, humidity, pressure, light and ultraviolet", decode = ::ws90),
    dev(32, "Fine Offset WH1080/WH3080 weather station", Mod.OOK_PWM, 544, 1524, 2800, bands = listOf(433_920_000L),
        what = "outdoor array with an optional light and ultraviolet head") { _, bits, ctx -> wh1080(bits, ctx, false) },
    dev(155, "Fine Offset WH1080/WH3080 weather station, frequency shifted", Mod.FSK_PCM, 58, 58, 5800, bands = listOf(433_920_000L, 868_300_000L),
        what = "outdoor array with an optional light and ultraviolet head") { _, bits, ctx -> wh1080(bits, ctx, true) },
)
