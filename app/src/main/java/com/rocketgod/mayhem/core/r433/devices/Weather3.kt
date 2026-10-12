package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Weather sensors: Alecto V1, inFactory, Oregon SL109H and V1, Ambient TX-8300, TS-FT002 tank gauge, Eurochron
 * and WS2032.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): alecto.c, infactory.c, oregon_scientific_sl109h.c, ambientweather_tx8300.c,
 * ts_ft002.c, eurochron.c, ws2032.c, oregon_scientific_v1.c. Twin of web/src/dsp/r433/devices/weather3.ts.
 */

private val BAND_433 = listOf(433_920_000L)
private const val TH = "thermometer and hygrometer"

private fun signed12(v: Int) = ((v and 0xffff) shl 16) shr 20
private fun fromBcd(x: Int) = ((x and 0xf0) shr 4) * 10 + (x and 0x0f)

/** Nibbles of the first four bytes summed backwards, then subtracted from fifteen or offset by seven, by a value in the frame. */
private fun alectoChecksum(b: UBytes): Boolean {
    var sum = 0
    for (i in 0 until 4) { val t = reverse8(b[i]); sum += (t and 0x0f) + ((t and 0xf0) shr 4) }
    sum = if ((b[1] and 0x7f) == 0x6c) sum + 0x07 else 0x0f - sum
    return reverse8((sum and 0x0f) shl 4) == (b[4] shr 4)
}

private fun alectoV1(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 7) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[1] != 36) return DECODE_ABORT_LENGTH
    val bb = bits.bb
    if (bb[1][0] != bb[5][0] || bb[2][0] != bb[6][0] || (bb[1][4] and 0x0f) != 0 || (bb[5][4] and 0x0f) != 0 ||
        bb[5][0] == 0 || bb[5][1] == 0) return DECODE_ABORT_EARLY
    if (!alectoChecksum(bb[1]) || !alectoChecksum(bb[5])) return DECODE_FAIL_MIC
    val b = bb[1]
    val msgType = (b[1] and 0x60) shr 5
    val isRain = (b[1] and 0x0f) == 0x0c
    fun base(model: String) = data("model" to model, "type" to "Weather", "id" to reverse8(b[0]), "channel" to ((b[0] and 0x0c) shr 2),
        "battery_ok" to if (((b[1] and 0x80) shr 7) != 0) 0 else 1, "mic" to "CHECKSUM")
    if (msgType == 0x3 && !isRain) {
        // Speed from one row, gust and direction from another four rows on.
        val skip = when { (b[1] and 0x0e) == 0x08 && b[2] == 0 -> 0; (b[1] and 0x0e) == 0x0e -> 4; else -> return DECODE_FAIL_SANITY }
        if (bits.numRows < 6 + skip) return DECODE_ABORT_EARLY
        val gustRow = bb[5 + skip]
        val out = base("AlectoV1-Wind")
        out["wind_avg_m_s"] = round2(reverse8(bb[1 + skip][3]) * 0.2)
        out["wind_max_m_s"] = round2(reverse8(gustRow[3]) * 0.2)
        out["wind_dir_deg"] = (reverse8(gustRow[2]) shl 1) or (gustRow[1] and 0x01)
        ctx.emit(out)
        return 1
    }
    if (msgType == 0x3) {
        val out = base("AlectoV1-Rain")
        out["rain_mm"] = round2(((reverse8(b[3]) shl 8) or reverse8(b[2])) * 0.25)
        ctx.emit(out)
        return 1
    }
    // Temperature and humidity, repeated across every row of the transmission.
    if (bb[2][0] == bb[3][0] && bb[3][0] == bb[4][0] && bb[4][0] == bb[5][0] && bb[5][0] == bb[6][0] &&
        (bb[3][4] and 0x0f) == 0 && (bb[5][4] and 0x0f) == 0) {
        val humidity = fromBcd(reverse8(b[3]))
        // The Prologue sensor is also thirty-six bits and is sometimes mistaken for this one.
        if (humidity > 100) return DECODE_FAIL_SANITY
        val out = base("AlectoV1-Temperature")
        out["temperature_C"] = round2(signed12((reverse8(b[1]) and 0xf0) or (reverse8(b[2]) shl 8)) * 0.1)
        out["humidity"] = humidity
        ctx.emit(out)
        return 1
    }
    return DECODE_FAIL_SANITY
}

/** The channel is copied into the check's own position before the CRC, and the last nibble xored in separately. */
private fun infactory(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n != 40 && n != 41 && n != 42) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    val channel = b[4] and 0x03
    if (channel == 0) return DECODE_ABORT_EARLY
    val msg = UBytes.of(b[0], (b[1] and 0x0f) or ((b[4] and 0x0f) shl 4), b[2], b[3], b[4])
    val crc = crc4(msg, 4, 0x13, 0) xor (msg[4] shr 4)
    if (crc != (b[1] shr 4)) return DECODE_FAIL_MIC
    val humidity = (b[3] and 0x0f) * 10 + (b[4] shr 4)
    if (humidity > 100) return DECODE_FAIL_SANITY
    val tempF = round2((((b[2] shl 4) or (b[3] shr 4)) - 900) * 0.1)
    if (tempF < -40 || tempF > 158) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "inFactory-TH", "type" to "Weather", "id" to b[0], "channel" to channel,
        "battery_ok" to if (((b[1] shr 2) and 1) != 0) 0 else 1, "button" to ((b[1] shr 3) and 1), "temperature_F" to tempF,
        "humidity" to humidity, "mic" to "CRC"))
    return 1
}

/** Four check bits and a Bresser frame of the same length, so repeats, decimal digits and a temperature bound all do work. */
private fun sl109h(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 38)
    if (row < 0 || bits.bitsPerRow[row] != 38) return DECODE_ABORT_LENGTH
    val msg = bits.bb[row]
    if (msg[0] == 0 && msg[1] == 0 && msg[2] == 0 && msg[3] == 0) return DECODE_FAIL_SANITY
    val chk = msg[0] shr 4
    val b = bits.bytes(row, 2, 36)
    b[0] = b[0] and 0x3f
    if (chk == 0 && b[0] == 0 && b[1] == 0 && b[2] == 0) return DECODE_FAIL_SANITY
    if ((addNibbles(b, 5) and 0x0f) != chk) return DECODE_FAIL_MIC
    val channelCode = b[0] shr 4
    if (channelCode == 3) return DECODE_FAIL_SANITY
    val tens = b[0] and 0x0f; val ones = b[1] shr 4
    if (tens > 9 || ones > 9) return DECODE_FAIL_SANITY
    val tempC = round1(signed12(((b[1] and 0x0f) shl 12) or (b[2] shl 4)) * 0.1)
    if (tempC < -20 || tempC > 60) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Oregon-SL109H", "type" to "Weather",
        "id" to (((b[3] and 0x0f) shl 4) or (b[4] shr 4)),       // changes when the battery does
        "channel" to if (channelCode != 0) channelCode else 3, "temperature_C" to tempC, "humidity" to tens * 10 + ones,
        "status" to (b[3] shr 4), "mic" to "CHECKSUM"))
    return 1
}

private fun tx8300Checksum(b: UBytes): Int {
    var x = 0; var y = 0
    for (i in 0 until 4) {
        x += (b[i] and 0x0f) + ((b[i] and 0xf0) shr 4)
        y += (b[i] and 0x05) + ((b[i] and 0x50) shr 4)
    }
    return (((x.inv() and 0x0f) shl 4) or (y.inv() and 0x0f)) and 0xff
}

/** Sent twice, the second inverted, plus a checksum; the often-mangled first bit is recovered from the inverted copy. */
private fun tx8300(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 74) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, 2, 72)
    for (i in 4 until 8) b[i] = b[i] xor 0xff
    b[0] = (b[0] and 0x7f) or (b[4] and 0x80)
    if (b[0] != b[4] || b[1] != b[5] || b[2] != b[6] || b[3] != b[7]) return DECODE_FAIL_MIC
    if ((tx8300Checksum(b) xor b[8]) != 0) return DECODE_FAIL_MIC
    val temp = (b[2] and 0x0f) * 10 + ((b[3] and 0xf0) shr 4) + (b[3] and 0x0f) * 0.1
    val tens = (b[0] and 0xf0) shr 4; val ones = b[0] and 0x0f
    val out = data("model" to "AmbientWeather-TX8300", "type" to "Weather", "id" to (((b[1] and 0x07) shl 4) or ((b[2] and 0xf0) shr 4)),
        "channel" to ((b[1] and 0x30) shr 4), "battery" to ((b[1] and 0xc0) shr 6),
        "temperature_C" to round1(if (((b[1] and 0x08) shr 3) != 0) -temp else temp), "mic" to "CHECKSUM")
    // A humidity that is not two decimal digits means the sensor had nothing to report.
    if (tens <= 9 && ones <= 9) out["humidity"] = tens * 10 + ones
    ctx.emit(out)
    return 1
}

/** Sent LSB first, so reflecting also reverses nibbles; realigned from whichever of three lengths arrived. */
private fun tsFt002(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val b = UBytes(9)
    when (bits.bitsPerRow[0]) {
        72 -> bits.extractBytes(0, 0, b, 72)
        71 -> { bits.extractBytes(0, 7, b.sub(1), 64); b[0] = bits.bb[0][0] shr 1 }
        70 -> { bits.extractBytes(0, 6, b.sub(1), 64); b[0] = (bits.bb[0][0] shr 2) or 0x80 }
        else -> return DECODE_ABORT_LENGTH
    }
    if (xorBytes(b, 9) != 0) return DECODE_FAIL_MIC
    reflectBytes(b, 8)                                   // eight, not nine: the check byte stays as it was
    if (b[2] != 0x11) return DECODE_FAIL_SANITY
    val t = b[5] shr 4
    val transmit = when { (t and 0x07) == 0x07 -> 5; (t and 0x08) == 0x08 -> 30; t == 0 -> 180; else -> 0 }
    ctx.emit(data("model" to "TS-FT002", "type" to "Weather", "id" to b[1],
        "depth_cm" to ((b[3] shl 4) or (b[4] and 0x0f)),         // 0x5dc: no reading
        "temperature_C" to round1((((b[6] shl 4) or (b[5] and 0x0f)) - 400) * 0.1), "transmit_s" to transmit,
        "flags" to (b[4] shr 4), "mic" to "CHECKSUM"))
    return 1
}

/** No checksum: only the length and a zero nibble. */
private fun eurochron(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(3, 36)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 36) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if ((b[1] and 0x0f) != 0) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Eurochron-TH", "type" to "Weather", "id" to b[0], "battery_ok" to if ((b[1] shr 7) != 0) 0 else 1,
        "temperature_C" to round1(signed12((b[3] shl 8) or (b[4] and 0xf0)) * 0.1), "humidity" to b[2], "button" to ((b[1] and 0x10) shr 4)))
    return 1
}

/** A sum and a CRC; temperature is a magnitude with a sign bit. The run-in is searched before inverting, read after. */
private fun ws2032(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 14 * 8)
    if (row < 0) return DECODE_ABORT_EARLY
    val offset = bits.search(row, 0, UBytes.of(0x0a), 8)
    if (offset + 14 * 8 > bits.bitsPerRow[row]) return DECODE_ABORT_LENGTH
    bits.invert()
    val b = bits.bytes(row, offset, 14 * 8)
    var sum = 0
    for (i in 0 until 12) sum += b[i]
    if (sum == 0) return DECODE_FAIL_SANITY
    if ((sum and 0xff) != b[12]) return DECODE_FAIL_MIC
    if (crc8(b, 14, 0x31, 0x00) != 0) return DECODE_FAIL_MIC
    val magnitude = ((b[4] and 0x07) shl 8) or b[5]
    ctx.emit(data("model" to "WS2032", "type" to "Weather", "id" to hexUp((b[1] shl 8) or b[2], 4),
        "battery_ok" to if ((b[3] and 0x01) != 0) 0 else 1, "temperature_C" to round1((if ((b[4] and 0x08) != 0) -1 else 1) * magnitude * 0.1),
        "humidity" to b[6], "wind_dir_deg" to round1((b[4] shr 4) * 22.5), "wind_avg_km_h" to round1(b[7] * 0.43 * 3.6),
        "wind_max_km_h" to round1(b[8] * 0.43 * 3.6), "rain" to ((b[9] shl 16) or (b[10] shl 8) or b[11]),
        "flags" to hexOf(b[3] and 0xfe), "mic" to "CRC"))
    return 1
}

/**
 * Three decimal digits and a sign bit. Two checksum folds are accepted: the documented end-around carry, and one
 * upstream has verified only against a single weak capture, carried across as it stands.
 */
private fun oregonV1(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] != 32) continue
        val b = bits.bb[row]
        if (b[0] == 0xff && b[1] == 0xff && b[2] == 0xff && b[3] == 0xff) continue
        val nib = IntArray(8)
        var rawCs = 0
        for (i in 0 until 4) {
            val v = reverse8(b[i])
            nib[i * 2] = v and 0x0f
            nib[i * 2 + 1] = v shr 4
            if (i < 3) rawCs += nib[i * 2] + 16 * nib[i * 2 + 1]
        }
        val checksum = nib[6] + (nib[7] shl 4)
        val fold = (rawCs and 0xff) + (rawCs shr 8)
        val alt = (if (rawCs > 0x180) rawCs + 1 else rawCs) and 0xff
        if (checksum == 0 || (checksum != fold && checksum != alt)) continue
        val magnitude = nib[2] * 0.1 + nib[3] + nib[4] * 10
        ctx.emit(data("model" to "Oregon-v1", "type" to "Weather", "id" to nib[0], "channel" to ((nib[1] shr 2) and 0x03) + 1,
            "battery_ok" to if (((nib[5] shr 3) and 0x01) != 0) 0 else 1,
            "temperature_C" to round1(if (((nib[5] shr 1) and 0x01) != 0) -magnitude else magnitude), "mic" to "CHECKSUM"))
        events++
    }
    return events
}

internal val WEATHER3: List<RDevice> = listOf(
    dev(16, "AlectoV1 Weather Sensor (Alecto WS3500 WS4500 Ventus W155/W044 Oregon)", Mod.OOK_PPM, 2000, 4000, 10000, gapLimit = 7000,
        bands = BAND_433, what = "weather station: temperature, humidity, rain and wind", decode = ::alectoV1),
    dev(91, "inFactory, nor-tec, FreeTec NC-3982-913 temperature humidity sensor", Mod.OOK_PPM, 2000, 4000, 5000, syncWidth = 500,
        tolerance = 750, bands = BAND_433, what = TH, decode = ::infactory),
    dev(54, "Oregon Scientific SL109H Remote Thermal Hygro Sensor", Mod.OOK_PPM, 2000, 4000, 10000, gapLimit = 5000, bands = BAND_433,
        what = TH, decode = ::sl109h),
    dev(112, "Ambient Weather TX-8300 Temperature/Humidity Sensor", Mod.OOK_PPM, 2000, 4000, 8000, gapLimit = 6500, bands = BAND_433,
        what = TH, decode = ::tx8300),
    dev(125, "TS-FT002 Wireless Ultrasonic Tank Liquid Level Meter With Temperature Sensor", Mod.OOK_PPM, 464, 948, 2000, gapLimit = 1200,
        bands = BAND_433, what = "tank level gauge with a thermometer", decode = ::tsFt002),
    dev(129, "Eurochron temperature and humidity sensor", Mod.OOK_PPM, 1016, 2024, 8200, gapLimit = 2100, disabled = true, bands = BAND_433,
        what = TH, decode = ::eurochron),
    dev(145, "WS2032 weather station", Mod.OOK_PWM, 500, 1000, 4000, gapLimit = 750, bands = BAND_433,
        what = "weather station: temperature, humidity, wind and rain", decode = ::ws2032),
    dev(50, "OSv1 Temperature Sensor", Mod.OOK_PWM_OSV1, 1465, 0, 14000, gapLimit = 3500, syncWidth = 5780, bands = BAND_433,
        what = "thermometer", decode = ::oregonV1),
)
