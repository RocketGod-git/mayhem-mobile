package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.min

/*
 * Ambient Weather, EcoWitt and Globaltronics sensors.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): ambient_weather.c, ambientweather_wh31e.c, gt_wt_02.c, gt_wt_03.c.
 * Twin of web/src/dsp/r433/devices/ambient.ts.
 */

private fun two(v: Int) = v.toString().padStart(2, '0')

/** The digest passes bad frames more often than it should, so the range checks are doing real work. */
private fun f007th(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    fun one(row: Int, at: Int): Int {
        val b = bits.bytes(row, at, 48)
        if (b[5] != (lfsrDigest8(b, 5, 0x98, 0x3e) xor 0x64)) return DECODE_FAIL_MIC
        val humidity = b[4]
        val tempF = ((((b[2] and 0x0f) shl 8) or b[3]) - 400) * 0.1
        if (humidity > 100) return DECODE_FAIL_SANITY
        if (tempF < -40 || tempF >= 344) return DECODE_FAIL_SANITY
        ctx.emit(data("model" to "Ambientweather-F007TH", "id" to b[1], "channel" to ((b[2] and 0x70) shr 4) + 1,
            "battery_ok" to if ((b[2] and 0x80) != 0) 0 else 1, "temperature_F" to round1(tempF), "humidity" to humidity, "mic" to "CRC"))
        return 1
    }
    // The preamble turns up in either polarity depending on where the Manchester decode locked on.
    val pre = UBytes.of(0x01, 0x45)
    val preInv = UBytes.of(0xfd, 0x45)
    var ret = 0
    for (row in 0 until bits.numRows) {
        var at = 0
        while (true) {
            at = bits.search(row, at, pre, 12)
            if (at + 8 + 48 > bits.bitsPerRow[row]) break
            ret = one(row, at + 8)
            if (ret > 0) return ret
            at += 16
        }
        at = 0
        while (true) {
            at = bits.search(row, at, preInv, 12)
            if (at + 8 + 48 > bits.bitsPerRow[row]) break
            ret = one(row, at + 8)
            if (ret > 0) return ret
            at += 15
        }
    }
    return ret
}

/** One frame across EcoWitt's outdoor range: a type byte picks the length, the CRC span and the byte sum. */
private fun wh31e(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val pre = UBytes.of(0xaa, 0x2d, 0xd4)
    var events = 0
    for (row in 0 until bits.numRows) {
        val start = bits.search(row, 0, pre, 24)
        if (start == bits.bitsPerRow[row]) continue
        val b = bits.bytes(row, start + 24, 18 * 8)
        val msgType = b[0]
        fun checked(n: Int) = crc8(b, n, 0x31, 0x00) == 0 && ((addBytes(b, n) - b[n]) and 0xff) == 0
        fun extra(from: Int, count: Int) = hexBytes(b, count, from)

        when (msgType) {
            0x30, 0x37 -> {
                if (!checked(6)) continue
                ctx.emit(data("model" to if (msgType == 0x30) "AmbientWeather-WH31E" else "AmbientWeather-WH31B", "id" to b[1],
                    "channel" to ((b[2] and 0x70) shr 4) + 1, "battery_ok" to if (((b[2] and 0x04) shr 2) != 0) 0 else 1,
                    "temperature_C" to round1(((((b[2] and 0x03) shl 8) or b[3]) - 400) * 0.1), "humidity" to b[4],
                    "data" to extra(6, 5), "mic" to "CRC"))
                events++
            }
            0x52 -> {
                if (!checked(10)) continue
                val year = ((b[3] and 0xf0) shr 4) * 10 + (b[3] and 0x0f) + 2000
                ctx.emit(data("model" to "AmbientWeather-WH31E", "id" to b[1], "data" to b[2],
                    "radio_clock" to "$year-${two(((b[4] and 0x10) shr 4) * 10 + (b[4] and 0x0f))}" +
                        "-${two(((b[5] and 0x30) shr 4) * 10 + (b[5] and 0x0f))}" +
                        "T${two(((b[6] and 0x30) shr 4) * 10 + (b[6] and 0x0f))}" +
                        ":${two(((b[7] and 0x70) shr 4) * 10 + (b[7] and 0x0f))}" +
                        ":${two(((b[8] and 0x70) shr 4) * 10 + (b[8] and 0x0f))}Z", "mic" to "CRC"))
                events++
            }
            0x40 -> {
                if (!checked(8)) continue
                val battV = b[4] and 0x1f
                // A single alkaline cell: 0.9 V is flat, 1.5 V is new.
                val level = min(100, if (battV <= 9) 0 else 100 * (battV - 9) / 6)
                val out = data("model" to "EcoWitt-WH40", "id" to (((b[1] and 0x0f) shl 16) or (b[2] shl 8) or b[3]),
                    "rain_mm" to round1(((b[5] shl 8) or b[6]) * 0.1), "data" to extra(9, 5), "mic" to "CRC")
                if (battV != 0) { out["battery_V"] = round1(battV * 0.1); out["battery_ok"] = level / 100.0 }
                ctx.emit(out)
                events++
            }
            0x20 -> {
                if (!checked(9)) continue
                val raw = b[4]
                val level = min(100, if (raw <= 90) 0 else 100 * (raw - 90) / 60)
                ctx.emit(data("model" to "EcoWitt-WN20", "id" to ((b[2] shl 8) or b[3]),
                    "battery_V" to round2(raw * 0.02), "battery_ok" to if (level > 0) 1 else 0, "battery_pct" to level,
                    "rain_mm" to round1(((b[5] shl 8) or b[6]) * 0.1), "data" to extra(10, 5), "mic" to "CRC"))
                events++
            }
            0x68 -> {
                if (!checked(15)) continue
                ctx.emit(data("model" to "EcoWitt-WS68", "id" to ((b[2] shl 8) or b[3]), "battery_raw" to b[6],
                    "battery_ok" to if (b[6] > 0x20) 1 else 0, "light_lux" to ((b[4] shl 8) or b[5]) * 10,
                    // The top bit of each of these three lives in a shared byte rather than beside its own value.
                    "wind_avg_m_s" to round1((((b[7] and 0x10) shl 4) or b[10]) * 0.1),
                    "wind_max_m_s" to round1((((b[7] and 0x40) shl 2) or b[12]) * 0.1),
                    "wind_dir_deg" to (((b[7] and 0x20) shl 3) or b[11]), "uvi" to b[13] / 10,
                    "data" to hexOf(b[16]) + Integer.toHexString(b[17] shr 4), "mic" to "CRC"))
                events++
            }
        }
    }
    return events
}

/** Humidity is reported over a restricted range, with sentinel values for the two ends of the scale. */
private fun gtHumidity(raw: Int, hi: Int): Int? =
    if (raw != 10 && raw != 110 && (raw < 20 || raw > hi)) null else if (raw == 10) 0 else if (raw == 110) 100 else raw

/** A six-bit sum of nibbles, split awkwardly across two bytes. */
private fun gtWt02(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 2) return DECODE_ABORT_LENGTH
    for (row in 0 until bits.numRows) {
        val b = when (bits.bitsPerRow[row]) { 39 -> bits.bytes(row, 2, 37); 37 -> bits.bb[row]; else -> continue }
        if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0 && b[4] == 0) continue
        val sum = (b[0] shr 4) + (b[0] and 0x0f) + (b[1] shr 4) + (b[1] and 0x0f) +
            (b[2] shr 4) + (b[2] and 0x0f) + (b[3] shr 4) + (b[3] and 0x0e)
        if ((sum and 0x3f) != (((b[3] and 1) shl 5) + (b[4] shr 3))) continue
        val channel = (b[1] shr 4) and 3
        if (channel > 2) continue
        val tempC = (signed(((b[1] and 0x0f) shl 12) or (b[2] shl 4), 16) shr 4) * 0.1
        if (tempC < -20 || tempC > 60) continue
        val humidity = gtHumidity(b[3] shr 1, 90) ?: continue
        ctx.emit(data("model" to "GT-WT02", "id" to b[0], "channel" to channel + 1, "battery_ok" to if (((b[1] shr 7) and 1) != 0) 0 else 1,
            "temperature_C" to round1(tempC), "humidity" to humidity, "button" to ((b[1] shr 6) and 1), "mic" to "CHECKSUM"))
        return 1
    }
    return 0
}

/** A shift register clocked through the message, xored in wherever a bit is set: an LFSR digest rolled the other way. */
private fun gtWt03(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var row = 0
    if (bits.numRows > 1) row = bits.findRepeatedRow(bits.numRows / 2 + 1, 41)
    if (row < 0) return DECODE_ABORT_LENGTH
    if (bits.bitsPerRow[row] != 41) return DECODE_ABORT_LENGTH
    bits.invert()
    val b = bits.bb[row]
    if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0 && b[4] == 0) return DECODE_ABORT_EARLY
    var sum = 0
    for (k in 0 until 4) {
        var key = 0x3100
        for (i in 7 downTo 0) {
            if (((b[k] shr i) and 1) != 0) sum = sum xor (key and 0xff)
            key = key shr 1
        }
    }
    if ((sum xor b[4] xor 0x2d) != 0) return DECODE_FAIL_MIC
    val tempC = (signed(((b[2] and 0x0f) shl 12) or (b[3] shl 4), 16) shr 4) * 0.1
    if (tempC <= -50.2 || tempC >= 70.2) return DECODE_FAIL_SANITY
    val humidity = gtHumidity(b[1], 95) ?: return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "GT-WT03", "id" to b[0], "channel" to ((b[2] shr 4) and 3) + 1,
        "battery_ok" to if (((b[2] shr 7) and 1) != 0) 0 else 1, "temperature_C" to round1(tempC), "humidity" to humidity,
        "button" to ((b[2] shr 6) and 1), "mic" to "CRC"))
    return 1
}

internal val AMBIENT: List<RDevice> = listOf(
    dev(20, "Ambient Weather F007TH, TFA 30.3208.02, SwitchDocLabs F016TH temperature sensor", Mod.OOK_MANCHESTER_ZEROBIT, 500, 0, 2400,
        bands = listOf(433_920_000L, 915_000_000L), what = "outdoor thermometer, very common in North America", decode = ::f007th),
    dev(113, "Ambient Weather WH31E thermo-hygrometer, EcoWitt WH40/WN20 rain gauge, WS68 weather station", Mod.FSK_PCM, 56, 56, 1500,
        gapLimit = 1800, bands = listOf(433_920_000L, 868_300_000L, 915_000_000L),
        what = "thermometers, rain gauges, an anemometer array and a radio clock", decode = ::wh31e),
    dev(25, "Globaltronics GT-WT-02 sensor", Mod.OOK_PPM, 2500, 5000, 12000, gapLimit = 8000, bands = listOf(433_920_000L),
        what = "outdoor temperature and humidity sensor", decode = ::gtWt02),
    dev(138, "Globaltronics GT-WT-03 sensor", Mod.OOK_PWM, 256, 625, 61000, gapLimit = 1000, syncWidth = 855, bands = listOf(433_920_000L),
        what = "outdoor temperature and humidity sensor", decode = ::gtWt03),
)
