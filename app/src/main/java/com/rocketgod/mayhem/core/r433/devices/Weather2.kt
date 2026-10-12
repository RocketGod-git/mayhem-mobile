package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Small weather sensors: Mebus, Calibeur, Springfield, FT-004-B, Hyundai WS, WT0124, Missil ML0757, Sharp SPC775.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): mebus.c, calibeur.c, springfield.c, ft004b.c, wssensor.c, wt0124.c,
 * missil_ml0757.c, sharp_spc775.c. Twin of web/src/dsp/r433/devices/weather2.ts.
 */

private val BAND_433 = listOf(433_920_000L)
private const val TH = "thermometer and hygrometer"

/** Sign-extend a twelve-bit field in the top of a sixteen-bit word, dropping the low nibble. */
private fun signed12(v: Int) = ((v and 0xffff) shl 16) shr 20

private fun byteAt(m: UBytes, off: Int): Int {
    val i = off shr 3; val s = off and 7
    if (s == 0) return m[i]
    return (((m[i] shl 8) or m[i + 1]) shr (8 - s)) and 0xff
}

/** No checksum and no length checks: rows one, five and thirteen must agree on the bytes they share. */
private fun mebus(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 13) return DECODE_ABORT_EARLY
    val r = bits.bb[1]
    if (bits.bb[0][0] != 0 || r[4] == 0 || (r[0] and 0x60) == 0 || r[3] != bits.bb[5][3] || r[4] != bits.bb[12][4]) return DECODE_ABORT_EARLY
    ctx.emit(data("model" to "Mebus-433", "type" to "Weather", "id" to (r[0] and 0x1f), "channel" to ((r[1] and 0x30) shr 4) + 1,
        "battery_ok" to if ((r[1] and 0x80) != 0) 1 else 0, "unknown1" to ((r[1] and 0x40) shr 6), "unknown2" to ((r[3] and 0xf0) shr 4),
        "temperature_C" to round2(signed12((r[1] shl 12) or (r[2] shl 4)) * 0.1),
        "humidity" to signed(((r[3] shl 4) or (r[4] shr 4)) and 0xff, 8)))
    return 1
}

/**
 * The channel hides in the temperature's tenths digit (channel × 10 plus the real fraction), which is why only
 * three can be told apart. One parity bit, so two identical messages are demanded.
 */
private fun calibeur(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 3) return DECODE_ABORT_EARLY
    val b = bits.bb[1]; val b2 = bits.bb[2]
    if ((b[0] == 0 && b[1] == 0 && b[2] == 0) || (b[0] == 0xff && b[1] == 0xff && b[2] == 0xff)) return DECODE_FAIL_SANITY
    bits.invert()
    if (bits.bitsPerRow[1] != 21) return DECODE_ABORT_LENGTH
    if (crc8(b, 3, 0x80, 0) == 0) return DECODE_FAIL_MIC
    if (b[0] != b2[0] || b[1] != b2[1] || b[2] != b2[2]) return DECODE_FAIL_SANITY
    // Every field is scattered a bit at a time.
    val packed = (((b[0] and 0x80) shr 7) or ((b[0] and 0x40) shr 5) or ((b[0] and 0x20) shr 3) or
        ((b[0] and 0x10) shr 1) or ((b[0] and 0x08) shl 1) or ((b[0] and 0x04) shl 3)) and 0xff
    val whole = (((b[0] and 0x02) shl 3) or ((b[0] and 0x01) shl 5) or ((b[1] and 0x80) shr 7) or ((b[1] and 0x40) shr 5) or
        ((b[1] and 0x20) shr 3) or ((b[1] and 0x10) shr 1) or ((b[1] and 0x08) shl 3)) and 0xff
    val humidity = (((b[1] and 0x02) shl 4) or ((b[1] and 0x01) shl 6) or ((b[2] and 0x80) shr 7) or ((b[2] and 0x40) shr 5) or
        ((b[2] and 0x20) shr 3) or ((b[2] and 0x10) shr 1) or ((b[2] and 0x08) shl 1)) and 0xff
    ctx.emit(data("model" to "Calibeur-RF104", "type" to "Weather", "id" to packed / 10,
        "temperature_C" to round1((packed % 10) * 0.1 + whole - 41), "humidity" to humidity, "mic" to "CRC"))
    return 1
}

/** Runs after Alecto, whose frames overlap; a one-nibble check, so readings are bounded to what the probe can measure. */
private fun springfield(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(3, 36)
    if (row < 0) return DECODE_ABORT_EARLY
    val n = bits.bitsPerRow[row]
    if (n != 36 && n != 37) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    val raw = u32be(b, 0)
    if (raw == 0xffffffffL || raw == 0L) return DECODE_ABORT_EARLY
    var chk = xorBytes(b, 4)
    chk = (chk shr 4) xor (chk and 0x0f)
    if (chk != 0) return DECODE_FAIL_MIC
    val tempC = round1(signed12(((b[1] and 0x0f) shl 12) or (b[2] shl 4)) * 0.1)
    val moisture = (b[3] shr 4) * 10
    if (tempC < -30 || tempC > 70) return DECODE_FAIL_SANITY
    if (moisture > 100) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Springfield-Soil", "type" to "Weather", "id" to b[0], "channel" to ((b[1] shr 4) and 0x03) + 1,
        "battery_ok" to if (((b[1] shr 7) and 1) != 0) 0 else 1, "temperature_C" to tempC, "moisture" to moisture,
        "button" to ((b[1] shr 6) and 1), "mic" to "CHECKSUM"))
    return 1
}

/** Three copies back to back, each bit taken by majority vote: it recovers from interference, not just notices it. */
private fun ft004b(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n != 137 && n != 138) return DECODE_ABORT_LENGTH
    val src = bits.bb[0]
    val msg = UBytes(6)
    for (i in 0 until 6) {
        val a = byteAt(src, i * 8); val b = byteAt(src, i * 8 + 46); val c = byteAt(src, i * 8 + 46 * 2)
        msg[i] = reverse8((a and b) or (b and c) or (a and c))
    }
    if (msg[0] != 0xf4) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "FT-004B", "type" to "Weather", "temperature_C" to round1((((msg[4] and 0x07) shl 8) or msg[3]) * 0.05 - 40)))
    return 1
}

/** Twenty-four bits said twenty-three times over, which is the whole of its integrity. */
private fun wssensor(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(4, 23)
    if (r < 0 || bits.bitsPerRow[r] != 24) return DECODE_ABORT_LENGTH
    val b = bits.bb[r]
    if ((b[0] == 0 && b[1] == 0 && b[2] == 0) || (b[0] == 0xff && b[1] == 0xff && b[2] == 0xff)) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Hyundai-WS", "type" to "Weather", "id" to b[2], "channel" to (b[1] and 0x03) + 1,
        "battery_ok" to if (((b[1] and 0x08) shr 3) != 0) 1 else 0, "temperature_C" to round2(signed12((b[0] shl 8) or (b[1] and 0xf0)) * 0.1),
        "button" to ((b[1] and 0x04) shr 2)))
    return 1
}

/** The sum folds its own carry back in, then adds the fifth byte without one: masking along the way never matches. */
private fun wt0124(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 2) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[1] != 49) return DECODE_ABORT_LENGTH
    val b = bits.bb[1]
    if ((b[0] shr 4) != 0x5) return DECODE_ABORT_EARLY
    if (xorBytes(b, 4) != b[4]) return DECODE_FAIL_MIC
    var sum = b[0] + b[1] + b[2] + b[3]
    sum += sum shr 8
    sum += b[4]
    if ((sum and 0xff) != b[5]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "WT0124-Pool", "type" to "Weather",
        "id" to (((b[0] and 0x0f) shl 4) or (b[1] and 0x0f)),   // picked afresh at every power-up
        "channel" to ((b[3] shr 4) and 0x03), "temperature_C" to round1(((((b[1] and 0x0f) shl 8) or b[2]) - 0x990) * 0.1), "mic" to "CHECKSUM"))
    return 1
}

/** One flag picks temperature or rain-and-wind, sent in turn; the wind scale is odd, but it is what the display shows. */
private fun missil(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(5, 40)
    if (r < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] > 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[r] > 40) return DECODE_ABORT_LENGTH
    val b = bits.bb[r]
    if ((b[4] and 0x0f) != 0x0f) return DECODE_ABORT_EARLY
    val f12 = ((b[2] shl 4) or (b[3] shr 4)) and 0xfff
    val f8 = (((b[3] and 0x0f) shl 4) or (b[4] shr 4)) and 0xff
    val out = data("model" to "Missil-ML0757", "type" to "Weather", "id" to b[0], "battery_ok" to if ((b[1] and 0x80) != 0) 0 else 1)
    if ((b[1] and 0x04) != 0) {
        out["rain_mm"] = round2(f12 * 0.45)
        out["wind_avg_km_h"] = when (f8) { 0x00 -> 0.0; 0x80 -> 1.4; 0xc0 -> 2.8; else -> round2((f8 + 2) * 1.4) }
    } else {
        out["temperature_C"] = round2(if ((f12 and 0x800) != 0) (0x1000 - f12) * -0.1 else f12 * 0.1)
    }
    ctx.emit(out)
    return 1
}

/** The digest is of the xor of everything before it, not of the bytes themselves. */
private fun sharpSpc775(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    val r = bits.findRepeatedRow(2, 48)
    if (r < 0) return DECODE_ABORT_EARLY
    val pos = bits.search(r, 0, UBytes.of(0xa5), 8)
    if (pos + 6 * 8 > bits.bitsPerRow[r]) return DECODE_FAIL_SANITY
    val b = bits.bytes(r, pos, 6 * 8)
    if (lfsrDigest8Reflect(UBytes.of(xorBytes(b, 5)), 1, 0x31, 0x31) != b[5]) return DECODE_FAIL_MIC
    val humidity = b[4]
    if (humidity > 100) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Sharp-SPC775", "type" to "Weather", "id" to b[1], "battery_ok" to if ((b[2] and 0x80) != 0) 0 else 1,
        "temperature_C" to round1(signed12(((b[2] and 0x0f) shl 12) or (b[3] shl 4)) * 0.1), "humidity" to humidity, "mic" to "CRC"))
    return 1
}

internal val WEATHER2: List<RDevice> = listOf(
    // Pulse widths guessed upstream: no samples were ever available.
    dev(13, "Mebus 433", Mod.OOK_PPM, 800, 1600, 6000, gapLimit = 2400, disabled = true, bands = BAND_433, what = TH, decode = ::mebus),
    dev(21, "Calibeur RF-104 Sensor", Mod.OOK_PWM, 760, 2240, 3200, syncWidth = 1560, bands = BAND_433, what = TH, decode = ::calibeur),
    dev(53, "Springfield Temperature and Soil Moisture", Mod.OOK_PPM, 2000, 4000, 9200, gapLimit = 5000, priority = 10, bands = BAND_433,
        what = "soil moisture and temperature probe", decode = ::springfield),
    dev(92, "FT-004-B Temperature Sensor", Mod.OOK_PPM, 1956, 3900, 4000, gapLimit = 4000, bands = BAND_433, what = "thermometer", decode = ::ft004b),
    dev(108, "Hyundai WS SENZOR Remote Temperature Sensor", Mod.OOK_PPM, 1000, 2000, 4400, gapLimit = 2400, bands = BAND_433,
        what = "thermometer", decode = ::wssensor),
    dev(109, "WT0124 Pool Thermometer", Mod.OOK_PWM, 680, 1850, 30000, gapLimit = 4000, syncWidth = 10000, bands = BAND_433,
        what = "pool thermometer", decode = ::wt0124),
    dev(157, "Missil ML0757 weather station", Mod.OOK_PPM, 975, 1950, 4500, gapLimit = 2500, tolerance = 100, bands = BAND_433,
        what = "weather station: temperature, wind and rain", decode = ::missil),
    dev(158, "Sharp SPC775 weather station", Mod.FSK_PWM, 225, 425, 10000, gapLimit = 2900, bands = listOf(915_000_000L), what = TH, decode = ::sharpSpc775),
)
