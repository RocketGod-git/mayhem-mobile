package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Pulse-position weather sensors: the cheap outdoor thermometers that came with a kitchen display. All the same
 * idea under different brands — a fixed short mark, then a gap whose length is the bit — and several are the same
 * silicon with a different sticker, which is why some reject a reading the moment a sibling's checksum passes.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): nexus.c, prologue.c, rubicson.c, generic_temperature_sensor.c,
 * s3318p.c, esperanza_ews.c. Twin of web/src/dsp/r433/devices/weather-ppm.ts.
 */

private val B433 = listOf(433_920_000L)

/** Nexus and rebadges: no checksum, only an always-0xf nibble, so most of this is about not claiming a Rubicson. */
private fun nexus(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(3, 36)
    if (r < 0) return DECODE_ABORT_EARLY
    val b = bits.bb[r]
    if (bits.bitsPerRow[r] > 37) return DECODE_ABORT_LENGTH
    if ((b[3] and 0xf0) != 0xf0) return DECODE_ABORT_EARLY
    if ((b[0] == 0 && b[2] == 0 && b[3] == 0) || (b[0] == 0xff && b[2] == 0xff && b[3] == 0xff)) return DECODE_ABORT_EARLY
    if ((b[1] and 0x30) == 0x30) return DECODE_ABORT_EARLY
    val crcIn = UBytes.of(b[0], b[1], b[2], b[3] and 0xf0, ((b[3] and 0x0f) shl 4) or ((b[4] and 0xf0) shr 4))
    if (crc8(crcIn, 5, 0x31, 0x6c) == 0) return DECODE_FAIL_SANITY    // this is a Rubicson
    val tempRaw = signed((b[1] shl 12) or (b[2] shl 4), 16)
    val tempC = (tempRaw shr 4) * 0.1
    val humidity = ((b[3] and 0x0f) shl 4) or (b[4] shr 4)
    if (humidity != 0 && humidity > 100) return DECODE_FAIL_SANITY
    val out = data(
        "model" to if (humidity == 0) "Nexus-T" else "Nexus-TH",
        "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1,
        "battery_ok" to if ((b[1] and 0x80) != 0) 1 else 0,
        "temperature_C" to jsRound(tempC * 100) / 100,
    )
    if (humidity != 0) out["humidity"] = humidity
    if ((b[1] and 0x40) != 0) out["test"] = 1
    ctx.emit(out)
    return 1
}

private fun nexusSauna(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(3, 36)
    if (r < 0) return DECODE_ABORT_EARLY
    val b = bits.bb[r]
    if (bits.bitsPerRow[r] > 37) return DECODE_ABORT_LENGTH
    if ((b[1] and 0x0f) != 0x0f) return DECODE_ABORT_EARLY
    if (b[0] == 0 || (b[4] and 0x10) != 0x10 || (b[0] == 0xff && b[2] == 0xff && b[3] == 0xff)) return DECODE_ABORT_EARLY
    if ((b[1] and 0x30) != 0x30) return DECODE_ABORT_EARLY
    val out = data(
        "model" to "Nexus-Sauna", "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1,
        "battery_ok" to if ((b[1] and 0x80) != 0) 1 else 0,
        "temperature_C" to jsRound(signed((b[2] shl 8) or b[3], 16) * 10.0) / 100,
    )
    if ((b[1] and 0x40) != 0) out["test"] = 1
    ctx.emit(out)
    return 1
}

private fun prologue(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    // Alecto and Auriol v2 lead with eight sync bits: seeing those means this is not ours
    if (bits.bitsPerRow[0] <= 8 && bits.bitsPerRow[0] != 0) return DECODE_ABORT_EARLY
    val r = bits.findRepeatedRow(4, 36)
    if (r < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[r] > 37) return DECODE_ABORT_LENGTH
    val b = bits.bb[r]
    if ((b[0] and 0xf0) != 0x90 && (b[0] and 0xf0) != 0x50) return DECODE_FAIL_SANITY
    val humidity = ((b[3] and 0x0f) shl 4) or (b[4] shr 4)
    val out = data(
        "model" to "Prologue-TH", "subtype" to (b[0] shr 4),
        "id" to (((b[0] and 0x0f) shl 4) or ((b[1] and 0xf0) shr 4)),
        "channel" to (b[1] and 0x03) + 1,
        "battery_ok" to if ((b[1] and 0x08) != 0) 1 else 0,
        "temperature_C" to jsRound((signed((b[2] shl 8) or (b[3] and 0xf0), 16) shr 4) * 10.0) / 100,
        "button" to ((b[1] and 0x04) shr 2),
    )
    if (humidity != 0xcc) out["humidity"] = humidity
    ctx.emit(out)
    return 1
}

private fun rubicson(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(3, 36)
    if (r < 0) return DECODE_ABORT_EARLY
    val b = bits.bb[r]
    if (bits.bitsPerRow[r] < 36 || bits.bitsPerRow[r] > 38) return DECODE_ABORT_LENGTH
    if ((b[3] and 0xf0) != 0xf0) return DECODE_ABORT_EARLY
    val tmp = UBytes.of(b[0], b[1], b[2], b[3] and 0xf0, ((b[3] and 0x0f) shl 4) or ((b[4] and 0xf0) shr 4))
    if (crc8(tmp, 5, 0x31, 0x6c) != 0) return DECODE_FAIL_MIC
    ctx.emit(data(
        "model" to "Rubicson-Temperature", "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1,
        "battery_ok" to if ((b[1] and 0x80) != 0) 1 else 0,
        "temperature_C" to jsRound((signed((b[1] shl 12) or (b[2] shl 4), 16) shr 4) * 10.0) / 100,
        "mic" to "CRC",
    ))
    return 1
}

private fun genericTemperature(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    for (i in 1 until 10) if (bits.bitsPerRow[i] != 24) return DECODE_ABORT_LENGTH
    val b = bits.bb[1]
    if ((b[0] == 0 && b[1] == 0 && b[2] == 0) || (b[0] == 0xff && b[1] == 0xff && b[2] == 0xff)) return DECODE_ABORT_EARLY
    ctx.emit(data(
        "model" to "Generic-Temperature", "id" to b[0], "battery_ok" to ((b[1] and 0xc0) shr 6),
        "temperature_C" to jsRound((signed(((b[1] and 0x3f) shl 10) or (b[2] shl 2), 16) shr 4) * 10.0) / 100,
    ))
    return 1
}

private fun s3318p(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    // two empty leading rows are two sync marks: the Esperanza variant below
    if (bits.bitsPerRow[0] == 0 && bits.bitsPerRow[1] == 0) return DECODE_ABORT_EARLY
    val r = bits.findRepeatedRow(4, 42)
    if (r < 0 || bits.bitsPerRow[r] != 42) return DECODE_ABORT_LENGTH
    val b = bits.bytes(r, 2, 40)
    if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0) return DECODE_FAIL_SANITY
    if ((crc4(b, 4, 0x3, 0x0) xor (b[4] shr 4)) != (b[4] and 0x0f)) return DECODE_FAIL_MIC
    val humidity = ((b[3] and 0x0f) shl 4) or ((b[3] and 0xf0) shr 4)
    val tempRaw = ((b[2] and 0x0f) shl 8) or (b[2] and 0xf0) or (b[1] and 0x0f)
    val out = data(
        "model" to "Conrad-S3318P", "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1,
        "battery_ok" to if ((b[4] and 0x40) != 0) 0 else 1,
        "temperature_F" to jsRound((tempRaw - 900) * 10.0) / 100,
        "button" to (b[4] shr 7), "mic" to "CRC",
    )
    if (humidity != 0) out["humidity"] = humidity
    ctx.emit(out)
    return 1
}

private fun esperanzaEws(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 0 || bits.bitsPerRow[1] != 0) return DECODE_FAIL_SANITY
    if (bits.numRows != 14) return DECODE_ABORT_LENGTH
    var row = 2
    while (row < bits.numRows - 3) {
        if (bits.bitsPerRow[row] != 42) return DECODE_FAIL_SANITY
        val a = bits.bb[row]; val c = bits.bb[row + 2]
        for (i in 0 until BITBUF_COLS) if (a[i] != c[i]) return DECODE_FAIL_SANITY
        row += 2
    }
    val b = bits.bytes(2, 2, 40)
    if ((crc4(b, 4, 0x3, 0x0) xor (b[4] shr 4)) != (b[4] and 0x0f)) return DECODE_FAIL_MIC
    val tempRaw = ((b[2] and 0x0f) shl 8) or (b[2] and 0xf0) or (b[1] and 0x0f)
    ctx.emit(data(
        "model" to "Esperanza-EWS", "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1,
        "battery_ok" to if ((b[4] and 0x40) == 0x40) 0 else 1,
        "temperature_F" to jsRound((tempRaw - 900) * 10.0) / 100,
        "humidity" to (((b[3] and 0x0f) shl 4) or ((b[3] and 0xf0) shr 4)), "mic" to "CRC",
    ))
    return 1
}

internal val WEATHER_PPM: List<RDevice> = listOf(
    dev(19, "Nexus, FreeTec NC-7345, NX-3980, Solight TE82S, TFA 30.3209 temperature/humidity sensor", Mod.OOK_PPM, 1000, 2000, 5000,
        gapLimit = 3000, priority = 10, bands = B433, what = "outdoor thermometer, often bundled with a kitchen display", decode = ::nexus),
    dev(279, "Nexus, CRX, Prego sauna temperature sensor", Mod.OOK_PPM, 1000, 2000, 5000, gapLimit = 3000, priority = 10, bands = B433,
        what = "sauna probe, reads far above room temperature", decode = ::nexusSauna),
    dev(3, "Prologue, FreeTec NC-7104, NC-7159-675 temperature sensor", Mod.OOK_PPM, 2000, 4000, 10000, gapLimit = 7000, priority = 10,
        bands = B433, what = "outdoor thermometer, sometimes with humidity", decode = ::prologue),
    dev(2, "Rubicson, TFA 30.3197 or InFactory PT-310 temperature sensor", Mod.OOK_PPM, 1000, 2000, 4800, gapLimit = 3000, bands = B433,
        what = "outdoor or pool thermometer", decode = ::rubicson),
    dev(38, "Generic temperature sensor 1", Mod.OOK_PPM, 2000, 4000, 10000, gapLimit = 4800, bands = B433, what = "unbranded thermometer",
        decode = ::genericTemperature),
    dev(47, "Conrad S3318P, FreeTec NC-5849-913 temperature humidity sensor, ORIA WA50 ST389 temperature sensor", Mod.OOK_PPM, 1900, 3800, 9400,
        gapLimit = 4400, bands = B433, what = "outdoor temperature and humidity sensor", decode = ::s3318p),
    dev(35, "Esperanza EWS", Mod.OOK_PPM, 2000, 4000, 9400, gapLimit = 4400, bands = B433, what = "outdoor temperature and humidity sensor",
        decode = ::esperanzaEws),
)
