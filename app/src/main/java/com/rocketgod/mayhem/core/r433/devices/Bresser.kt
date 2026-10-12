package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.min

/*
 * Bresser weather centres, and the Froggit and Ventus stations built from the same parts. The old 3-channel
 * thermometer is OOK; everything since is FSK on 868.3 MHz behind `2d d4`, with a sensor type in the seventh
 * byte. Unusual protections: a shift-register digest, or (the 5-in-1) the whole message sent twice with the
 * second copy inverted; and several fields xored with 0xff or 0xaa before transmission.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): bresser_3ch.c, bresser_5in1.c, bresser_6in1.c, bresser_7in1.c,
 * bresser_lightning.c, bresser_leakage.c. Twin of web/src/dsp/r433/devices/bresser.ts.
 */

private const val TYPE_WEATHER = 1
private const val TYPE_LEAKAGE = 5
private const val TYPE_AIR_PM = 8
private const val TYPE_LIGHTNING = 9
private const val TYPE_CO2 = 10
private const val TYPE_HCHO_VOC = 11
private const val TYPE_WEATHER3 = 12
private const val TYPE_WEATHER8 = 13
private val PRE_AA_AA_2DD4 = UBytes.of(0xaa, 0xaa, 0x2d, 0xd4)
private val PRE_AA_AA_AA_2DD4 = UBytes.of(0xaa, 0xaa, 0xaa, 0x2d, 0xd4)
private val B868 = listOf(868_300_000L)
private fun bcd2(b: Int) = (b shr 4) * 10 + (b and 0x0f)

private fun bresser3ch(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(3, 40)
    if (r < 0 || bits.bitsPerRow[r] > 42) return DECODE_ABORT_LENGTH
    val b = bits.bb[r]
    for (i in 0 until 5) b[i] = b[i].inv()
    if (((b[0] + b[1] + b[2] + b[3] - b[4]) and 0xff) != 0) return DECODE_FAIL_MIC
    val channel = (b[1] and 0x30) shr 4
    val humidity = b[3]
    val tempF = ((((b[1] and 0x0f) shl 8) + b[2]) - 900) * 0.1
    if (channel == 0 || humidity > 100 || tempF < -20 || tempF > 160) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Bresser-3CH", "id" to b[0], "channel" to channel, "battery_ok" to if (((b[1] and 0x80) shr 7) != 0) 0 else 1,
        "temperature_F" to round1(tempF), "humidity" to humidity, "mic" to "CHECKSUM"))
    return 1
}

/** 5-in-1: the first thirteen bytes are the exact complement of the next thirteen. */
private fun bresser5in1(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (bits.numRows != 1 || n < 248 || n > 440) return DECODE_ABORT_EARLY
    var start = bits.search(0, 0, PRE_AA_AA_AA_2DD4, 40)
    if (start == n) return DECODE_ABORT_LENGTH
    start += 40
    var len = n - start
    if (((len + 7) shr 3) < 26) return DECODE_ABORT_LENGTH
    len = min(len, 26 * 8)
    val msg = UBytes(26)
    bits.extractBytes(0, start, msg, len)
    for (col in 0 until 13) if ((msg[col] xor msg[col + 13]) != 0xff) return DECODE_FAIL_MIC
    val tempOk = (msg[20] and 0x0f) <= 9
    var tempRaw = (msg[20] and 0x0f) + ((msg[20] and 0xf0) shr 4) * 10 + (msg[21] and 0x0f) * 100
    if ((msg[25] and 0x0f) != 0) tempRaw = -tempRaw
    val humidityOk = (msg[22] and 0x0f) <= 9
    val rainRaw = (msg[23] and 0x0f) + ((msg[23] and 0xf0) shr 4) * 10 + (msg[24] and 0x0f) * 100 + ((msg[24] and 0xf0) shr 4) * 1000
    val sensorType = msg[15] and 0x7f
    val batteryOk = if ((msg[25] and 0x80) != 0) 0 else 1
    if (sensorType in 0x39..0x3b) {
        val out = data("model" to "Bresser-ProRainGauge", "id" to msg[14], "battery_ok" to batteryOk, "rain_mm" to round1(rainRaw * 0.1 * 2.5), "mic" to "CHECKSUM")
        if (tempOk) out["temperature_C"] = round1(tempRaw * 0.1)
        ctx.emit(out)
        return 1
    }
    val out = data("model" to "Bresser-5in1", "id" to msg[14], "battery_ok" to batteryOk,
        "wind_max_m_s" to round1((((msg[17] and 0x0f) shl 8) + msg[16]) * 0.1),
        "wind_avg_m_s" to round1(((msg[18] and 0x0f) + ((msg[18] and 0xf0) shr 4) * 10 + (msg[19] and 0x0f) * 100) * 0.1),
        "wind_dir_deg" to round1(((msg[17] and 0xf0) shr 4) * 22.5), "rain_mm" to round1(rainRaw * 0.1), "mic" to "CHECKSUM")
    if (tempOk) out["temperature_C"] = round1(tempRaw * 0.1)
    if (humidityOk) out["humidity"] = (msg[22] and 0x0f) + ((msg[22] and 0xf0) shr 4) * 10
    ctx.emit(out)
    return 1
}

private val MOISTURE = intArrayOf(0, 7, 13, 20, 27, 33, 40, 47, 53, 60, 67, 73, 80, 87, 93, 99)

/** 6-in-1: masts, indoor sensors, pool thermometers and soil probes, told apart by the type nibble. */
private fun bresser6in1(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (bits.numRows != 1 || n < 160 || n > 440) return DECODE_ABORT_EARLY
    val start = bits.search(0, 0, PRE_AA_AA_2DD4, 32) + 32
    if (start >= n) return DECODE_ABORT_LENGTH
    if (n - start < 18 * 8) return DECODE_ABORT_LENGTH
    val msg = UBytes(18)
    bits.extractBytes(0, start, msg, 18 * 8)
    if (((msg[0] shl 8) or msg[1]) != lfsrDigest16(msg, 15, 0x8810, 0x5412, 2)) return DECODE_FAIL_MIC
    if ((addBytes(msg, 16, 2) and 0xff) != 0xff) return DECODE_FAIL_MIC
    val sType = msg[6] shr 4
    val rainOk = msg[16] and 1
    val tempOk = msg[12] <= 0x99 && (msg[13] and 0xf0) <= 0x90
    val tempRaw = (msg[12] shr 4) * 100 + (msg[12] and 0x0f) * 10 + (msg[13] shr 4)
    var tempC = if (((msg[13] shr 3) and 1) != 0) (tempRaw - 1000) * 0.1 else tempRaw * 0.1
    if (tempC < -50) tempC = -tempRaw * 0.1
    val humidity = bcd2(msg[14])
    var uvOk = (msg[16] and 0x0f) == 0 && (msg[15].inv() and 0xff) <= 0x99 && (msg[16].inv() and 0xf0) <= 0x90
    val uvRaw = ((msg[15].inv() and 0xf0) shr 4) * 100 + (msg[15].inv() and 0x0f) * 10 + ((msg[16].inv() and 0xf0) shr 4)
    msg[7] = msg[7] xor 0xff; msg[8] = msg[8] xor 0xff; msg[9] = msg[9] xor 0xff
    var windOk = msg[7] <= 0x99 && msg[8] <= 0x99 && msg[9] <= 0x99
    val gustRaw = (msg[7] shr 4) * 100 + (msg[7] and 0x0f) * 10 + (msg[8] shr 4)
    val avgRaw = (msg[9] shr 4) * 100 + (msg[9] and 0x0f) * 10 + (msg[8] and 0x0f)
    val windDir = ((msg[10] and 0xf0) shr 4) * 100 + (msg[10] and 0x0f) * 10 + ((msg[11] and 0xf0) shr 4)
    msg[12] = msg[12] xor 0xff; msg[13] = msg[13] xor 0xff; msg[14] = msg[14] xor 0xff
    val rainRaw = (msg[12] shr 4) * 100000 + (msg[12] and 0x0f) * 10000 + (msg[13] shr 4) * 1000 + (msg[13] and 0x0f) * 100 + (msg[14] shr 4) * 10 + (msg[14] and 0x0f)
    if (sType == 2 || sType == 4) { windOk = false; uvOk = false }
    val moisture = if (sType == 4 && tempOk && humidity in 1..16) MOISTURE[humidity - 1] else -1
    val startup = (msg[6] shr 3) and 1
    val out = data("model" to "Bresser-6in1", "id" to u32be(msg, 2), "channel" to (msg[6] and 0x07), "sensor_type" to sType,
        "flags" to (msg[16] and 0x0f), "mic" to "CRC")
    if (rainOk == 0) out["battery_ok"] = (msg[13] shr 1) and 1
    if (tempOk) out["temperature_C"] = round1(tempC)
    if (tempOk && moisture < 0) out["humidity"] = humidity
    if (moisture >= 0) out["moisture"] = moisture
    if (windOk) { out["wind_max_m_s"] = round1(gustRaw * 0.1); out["wind_avg_m_s"] = round1(avgRaw * 0.1); out["wind_dir_deg"] = windDir }
    if (rainOk != 0) out["rain_mm"] = round1(rainRaw * 0.1)
    if (uvOk) out["uvi"] = round1(uvRaw * 0.1)
    if (startup != 0) out["startup"] = startup
    ctx.emit(out)
    return 1
}

/** 7-in-1: the newest mast plus air-quality, CO2 and formaldehyde monitors; every byte xored with 0xaa. */
private fun bresser7in1(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (bits.numRows != 1 || n < 160) return DECODE_ABORT_LENGTH
    val start = bits.search(0, 0, PRE_AA_AA_AA_2DD4, 40) + 40
    if (start >= n) return DECODE_ABORT_EARLY
    if (start + 21 * 8 >= n) return DECODE_ABORT_LENGTH
    val msg = UBytes(25)
    bits.extractBytes(0, start, msg, 25 * 8)
    if (msg[21] == 0x00) return DECODE_FAIL_SANITY
    val sType = msg[6] shr 4
    val nstartup = (msg[6] and 0x08) shr 3
    val chan = msg[6] and 0x07
    for (i in 0 until msg.length) msg[i] = msg[i] xor 0xaa
    val chk = (msg[0] shl 8) or msg[1]
    if ((chk xor lfsrDigest16(msg, 23, 0x8810, 0xba95, 2)) != 0x6df1) return DECODE_FAIL_MIC
    val id = (msg[2] shl 8) or msg[3]
    val flags = msg[15] and 0x0f
    val batteryOk = if ((flags and 0x06) == 0x06) 0 else 1
    fun common(model: String, withChan: Boolean): R433Data {
        val o = data("model" to model, "id" to id, "battery_ok" to batteryOk, "mic" to "CRC")
        if (withChan) o["channel"] = chan
        if (nstartup == 0) o["startup"] = 1
        return o
    }
    if (sType == TYPE_WEATHER || sType == TYPE_WEATHER3 || sType == TYPE_WEATHER8) {
        val tempRaw = (msg[14] shr 4) * 100 + (msg[14] and 0x0f) * 10 + (msg[15] shr 4)
        val rainRaw = (msg[10] shr 4) * 100000 + (msg[10] and 0x0f) * 10000 + (msg[11] shr 4) * 1000 + (msg[11] and 0x0f) * 100 + (msg[12] shr 4) * 10 + (msg[12] and 0x0f)
        val lightRaw = (msg[17] shr 4) * 100000 + (msg[17] and 0x0f) * 10000 + (msg[18] shr 4) * 1000 + (msg[18] and 0x0f) * 100 + (msg[19] shr 4) * 10 + (msg[19] and 0x0f)
        val out = common("Bresser-7in1", false)
        out["temperature_C"] = round1(if (tempRaw > 600) (tempRaw - 1000) * 0.1 else tempRaw * 0.1)
        out["humidity"] = bcd2(msg[16])
        out["rain_mm"] = round1(rainRaw * 0.1)
        if (sType != TYPE_WEATHER3) {
            out["wind_max_m_s"] = round1(((msg[7] shr 4) * 100 + (msg[7] and 0x0f) * 10 + (msg[8] shr 4)) * 0.1)
            out["wind_avg_m_s"] = round1(((msg[8] and 0x0f) * 100 + (msg[9] shr 4) * 10 + (msg[9] and 0x0f)) * 0.1)
            out["wind_dir_deg"] = (msg[4] shr 4) * 100 + (msg[4] and 0x0f) * 10 + (msg[5] shr 4)
            out["light_lux"] = lightRaw
            out["uvi"] = round1(((msg[20] shr 4) * 100 + (msg[20] and 0x0f) * 10 + (msg[21] shr 4)) * 0.1)
        }
        if (sType == TYPE_WEATHER8 && (msg[23] shr 4) < 10) out["temperature_1_C"] = round1((msg[22] shr 4) * 10 + (msg[22] and 0x0f) + (msg[23] shr 4) * 0.1)
        ctx.emit(out)
        return 1
    }
    if (sType == TYPE_AIR_PM) {
        val out = common("Bresser-7in1", true)
        if ((msg[10] and 0x0f) != 0x0f) out["pm2_5_ug_m3"] = (msg[10] and 0x0f) * 1000 + (msg[11] shr 4) * 100 + (msg[11] and 0x0f) * 10 + (msg[12] shr 4)
        if ((msg[12] and 0x0f) != 0x0f) out["pm10_0_ug_m3"] = (msg[12] and 0x0f) * 1000 + (msg[13] shr 4) * 100 + (msg[13] and 0x0f) * 10 + (msg[14] shr 4)
        ctx.emit(out)
        return 1
    }
    if (sType == TYPE_CO2) {
        val out = common("Bresser-CO2", true)
        if ((msg[5] and 0x0f) != 0x0f) out["co2_ppm"] = ((msg[4] and 0xf0) shr 4) * 1000 + (msg[4] and 0x0f) * 100 + ((msg[5] and 0xf0) shr 4) * 10 + (msg[5] and 0x0f)
        ctx.emit(out)
        return 1
    }
    if (sType == TYPE_HCHO_VOC) {
        val voc = msg[22] and 0x0f
        val out = common("Bresser-HCHOVOC", true)
        if ((msg[5] and 0x0f) != 0x0f) out["hcho_ppb"] = ((msg[4] and 0xf0) shr 4) * 1000 + (msg[4] and 0x0f) * 100 + ((msg[5] and 0xf0) shr 4) * 10 + (msg[5] and 0x0f)
        if (voc != 0x0f) out["voc_level"] = voc
        ctx.emit(out)
        return 1
    }
    return DECODE_FAIL_SANITY
}

private fun bresserLightning(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (bits.numRows != 1 || n < 112 || n > 440) return DECODE_ABORT_EARLY
    var start = bits.search(0, 0, PRE_AA_AA_2DD4, 32)
    if (start >= n) return DECODE_ABORT_LENGTH
    start += 32
    if (n - start < 80) return DECODE_ABORT_LENGTH
    val msg = UBytes(10)
    bits.extractBytes(0, start, msg, 80)
    val sType = msg[6] shr 4
    val chan = msg[6] and 0x07
    val batteryLow = (msg[5] and 0x08) shr 3
    val nstartup = (msg[6] and 0x08) shr 3
    for (i in 0 until msg.length) msg[i] = msg[i] xor 0xaa
    val chk = (msg[0] shl 8) or msg[1]
    if ((chk xor lfsrDigest16(msg, 8, 0x8810, 0xabf9, 2)) != 0x899e) return DECODE_FAIL_MIC
    if (sType != TYPE_LIGHTNING || chan != 0) return DECODE_FAIL_SANITY
    val out = data("model" to "Bresser-Lightning", "id" to ((msg[2] shl 8) or msg[3]), "battery_ok" to if (batteryLow != 0) 0 else 1,
        "storm_dist_km" to msg[7], "strike_count" to (msg[4] shr 4) * 100 + (msg[4] and 0x0f) * 10 + (msg[5] shr 4),
        "unknown1" to (((msg[5] and 0x0f) shl 8) or msg[6]), "unknown2" to ((msg[8] shl 8) or msg[9]), "mic" to "CRC")
    if (nstartup == 0) out["startup"] = 1
    ctx.emit(out)
    return 1
}

/** Leak alarm: an alarm bit and its complement, which must disagree. */
private fun bresserLeakage(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (bits.numRows != 1 || n < 160 || n > 440) return DECODE_ABORT_EARLY
    var start = bits.search(0, 0, PRE_AA_AA_2DD4, 32)
    if (start >= n) return DECODE_ABORT_LENGTH
    start += 32
    if (n - start < 18 * 8) return DECODE_ABORT_LENGTH
    val msg = UBytes(18)
    bits.extractBytes(0, start, msg, 18 * 8)
    if (((msg[0] shl 8) or msg[1]) != crc16(msg, 5, 0x1021, 0x0000, 2)) return DECODE_FAIL_MIC
    val sType = msg[6] shr 4
    val chan = msg[6] and 0x07
    val alarm = (msg[7] and 0x80) shr 7
    val noAlarm = (msg[7] and 0x40) shr 6
    if (sType != TYPE_LEAKAGE || alarm == noAlarm || chan == 0) return DECODE_FAIL_SANITY
    val out = data("model" to "Bresser-Leakage", "id" to u32be(msg, 2), "channel" to chan,
        "battery_ok" to if ((msg[7] and 0x30) != 0x00) 1 else 0, "alarm" to alarm)
    if (((msg[6] and 0x08) shr 3) == 0) out["startup"] = 1
    ctx.emit(out)
    return 1
}

internal val BRESSER: List<RDevice> = listOf(
    dev(52, "Bresser Thermo-/Hygro-Sensor 3CH", Mod.OOK_PWM, 250, 500, 1250, syncWidth = 750, gapLimit = 625, bands = listOf(433_920_000L),
        what = "outdoor temperature and humidity sensor; also the Renkforce DM-7511", decode = ::bresser3ch),
    dev(119, "Bresser Weather Center 5-in-1", Mod.FSK_PCM, 124, 124, 25000, bands = B868, what = "outdoor weather mast: wind, rain, temperature, humidity", decode = ::bresser5in1),
    dev(172, "Bresser Weather Center 6-in-1, 7-in-1 indoor, soil, new 5-in-1, 3-in-1 wind gauge, Froggit WH6000, Ventus C8488A", Mod.FSK_PCM, 124, 124, 25000,
        bands = B868, what = "weather masts, indoor sensors, pool thermometers and soil probes", decode = ::bresser6in1),
    dev(173, "Bresser Weather Center 7-in-1, air quality PM2.5/PM10, CO2, HCHO/VOC", Mod.FSK_PCM, 124, 124, 25000, bands = B868,
        what = "weather mast, air quality, carbon dioxide and formaldehyde monitors", decode = ::bresser7in1),
    dev(249, "Bresser lightning", Mod.FSK_PCM, 124, 124, 25000, bands = B868, what = "lightning detector", decode = ::bresserLightning),
    dev(247, "Bresser water leakage", Mod.FSK_PCM, 124, 124, 25000, bands = B868, what = "water leak alarm", decode = ::bresserLeakage),
)
