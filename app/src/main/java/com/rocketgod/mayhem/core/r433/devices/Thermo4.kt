package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * WEC-2103, Homelead HG9901 soil sensor, WallarGe CLTX001, Esun EN2053 and EN2058 barbecue thermometers.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): wec2103.c, homelead_hg9901.c, wallarge_cltx001.c, esun_en2053.c,
 * en2058.c. Twin of web/src/dsp/r433/devices/thermo4.ts.
 */

private val BAND_433 = listOf(433_920_000L)
private const val BBQ = "barbecue thermometer"

/**
 * The CRC nibble is replaced by the last byte's low nibble before the check, and the result xored with its
 * high nibble. Upstream's battery mask and shift can never agree, so a flat battery is never reported; kept.
 */
private fun wec2103(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 6 || bits.bitsPerRow[2] != 42) return DECODE_ABORT_LENGTH
    val b = bits.bytes(3, 0, 40)
    val crcReceived = b[1] shr 4
    b[1] = (b[1] and 0x0f) or ((b[4] and 0x0f) shl 4)
    if ((crc4(b, 4, 3, 0) xor (b[4] shr 4)) != crcReceived) return DECODE_FAIL_MIC
    val tempRaw = (b[2] shl 4) or ((b[3] and 0xf0) shr 4)
    ctx.emit(data("model" to "WEC-2103", "type" to "Weather", "id" to b[0], "channel" to (b[4] and 0x0f),
        "battery_ok" to if (((b[1] and 0x04) shr 3) != 0) 0 else 1, "button" to ((b[1] and 0x08) shr 3),
        "temperature_F" to round2((tempRaw - 900) * 0.1), "humidity" to (b[3] and 0x0f) * 10 + ((b[4] and 0xf0) shr 4),
        "flags" to (b[1] and 0x0f), "mic" to "CRC"))
    return 1
}

/** Rough lux for the nine light steps; anything above eight is undefined. */
private val HOMELEAD_LUX = intArrayOf(60, 200, 400, 600, 1000, 1500, 2800, 4500, 10000, -1, -1, -1, -1, -1, -1, -1)

/** The run-in is searched as it arrives and the frame read after inverting. A four-bit nibble sum, and that is all. */
private fun homelead(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(1, 65)
    if (row < 0) return DECODE_ABORT_EARLY
    val rowLen = bits.bitsPerRow[row]
    if (rowLen > 65 + 8) return DECODE_ABORT_EARLY
    val pos = bits.search(row, 0, UBytes.of(0x55, 0xaa), 16)
    if (pos + 65 > rowLen) return DECODE_ABORT_LENGTH
    bits.invert()
    val b = bits.bb[row]
    if ((addNibbles(b, 7) and 0x0f) != ((b[7] and 0xf0) shr 4)) return DECODE_FAIL_MIC
    val temperature = if ((b[5] and 0x80) != 0) -(b[5] and 0x7f) else (b[5] and 0x7f)
    val battery = (b[6] and 0x30) shr 4
    val light = b[6] and 0x0f
    ctx.emit(data("model" to "Homelead-HG9901", "type" to "Weather", "id" to hexUp((b[2] shl 8) or b[3], 4),
        "battery_ok" to if (battery > 1) 1 else 0, "battery_pct" to 100 * battery / 3, "temperature_C" to temperature, "moisture" to b[4],
        "light_lvl" to light, "light_lux" to HOMELEAD_LUX[light],
        "sequence" to ((b[6] and 0xc0) shr 6),           // which of four transmit intervals it is using
        "mic" to "CHECKSUM"))
    return 1
}

/**
 * Inverted line coding, then a byte sum and a parity byte whose bit set means an even count of ones. The battery
 * field only appears when low; a cheerful "fine" for every frame would claim what the sensor never said.
 */
private fun wallarge(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var result = DECODE_ABORT_LENGTH
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] != 56) continue
        val b = bits.bb[row]
        for (i in 0 until 7) b[i] = b[i].inv() and 0xff
        if (b[6] != (addBytes(b, 5) and 0xff)) { result = DECODE_FAIL_MIC; continue }
        val parityByte = b[5]
        var parityValid = (parityByte and 0x07) == 0
        if (parityValid) for (i in 0 until 5) if (parity8(b[i]) == ((parityByte shr (7 - i)) and 1)) { parityValid = false; break }
        if (!parityValid) { result = DECODE_FAIL_MIC; continue }
        val batteryLow = (b[3] and 0x80) shr 7
        val testMode = (b[3] and 0x40) shr 6
        val tempRaw = signed(((b[3] and 0x0f) shl 12) or (b[4] shl 4), 16)
        val out = data("model" to "WallarGe-CLTX001", "type" to "Weather", "id" to ((b[0] shl 8) or b[1]),
            "channel" to ((b[3] and 0x30) shr 4) + 1, "temperature_C" to round1((tempRaw shr 4) * 0.1), "mic" to "CHECKSUM")
        if (batteryLow != 0) out["battery_ok"] = 0
        if (testMode != 0) out["test"] = testMode
        ctx.emit(out)
        result = 1
        break
    }
    return result
}

/** The check byte is the byte sum mod eight below four even-parity flags, one per data byte. 0xfd6 is an empty probe. */
private fun esun(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 40)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 40) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[0] != 0xc0) return DECODE_FAIL_SANITY
    var chk = (b[0] + b[1] + b[2] + b[3]) and 0x07
    for (i in 0 until 4) chk = chk or ((1 xor parity8(b[i])) shl (4 + i))
    if (chk != b[4]) return DECODE_FAIL_MIC
    val temp1 = (b[1] shl 4) or (b[2] shr 4)
    val temp2 = ((b[2] and 0x0f) shl 8) or b[3]
    val out = data("model" to "Esun-EN2053", "type" to "Weather", "mic" to "CHECKSUM")
    if (temp1 != 0xfd6) out["temperature_1_F"] = temp1
    if (temp2 != 0xfd6) out["temperature_2_F"] = temp2
    ctx.emit(out)
    return 1
}

private val EN2058_PREAMBLE = UBytes.of(0xff, 0xfe, 0x00, 0x00)

/** Nine repeats run together in one row, so a repeat spoiled in the air costs nothing while a later one survives. */
private fun en2058(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 174) return DECODE_ABORT_LENGTH
    var offset = 0
    for (i in 0 until 9) {
        offset = bits.search(0, offset, EN2058_PREAMBLE, 30)
        if (offset >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
        offset += 30
        val idBytes = bits.bytes(0, offset + 56, 24)
        val dataBytes = bits.bytes(0, offset + 80, 80)
        if (((0x56 + addBytes(idBytes, 3) + addBytes(dataBytes, 8)) and 0xff) != dataBytes[9]) continue
        fun probe(n: Int) = round1((((dataBytes[n * 2] shl 8) or dataBytes[n * 2 + 1]) - 900) / 10.0)
        val out = data("model" to "EN2058", "type" to "Weather", "id" to ((idBytes[0] shl 16) or (idBytes[1] shl 8) or idBytes[2]),
            "temperature1_F" to probe(0), "temperature2_F" to probe(1), "temperature3_F" to probe(2), "temperature4_F" to probe(3), "mic" to "CHECKSUM")
        // The counter sits well past the reading, so a repeat cut short does not carry one.
        if (offset + 320 <= bits.bitsPerRow[0]) out["sequence"] = bits.bytes(0, offset + 304, 16)[0]
        ctx.emit(out)
        return 1
    }
    return DECODE_FAIL_MIC
}

internal val THERMO4: List<RDevice> = listOf(
    dev(229, "WEC-2103 temperature/humidity sensor", Mod.OOK_PPM, 1900, 3800, 9400, gapLimit = 4400, bands = BAND_433,
        what = "thermometer and hygrometer", decode = ::wec2103),
    dev(280, "Homelead HG9901 (Geevon, Dr.Meter, Royal Gardineer) soil moisture/temp/light level sensor", Mod.OOK_PWM, 432, 1228, 4500,
        gapLimit = 2000, bands = BAND_433, what = "soil moisture, temperature and light sensor", decode = ::homelead),
    dev(292, "WallarGe CLTX001 Outdoor Temperature Sensor", Mod.OOK_PWM, 250, 500, 1250, gapLimit = 650, tolerance = 75, bands = BAND_433,
        what = "thermometer", decode = ::wallarge),
    dev(341, "Esun EN2053 two-channel BBQ thermometer", Mod.OOK_PPM, 1024, 2000, 7500, gapLimit = 3000, bands = BAND_433, what = BBQ, decode = ::esun),
    dev(346, "EN2058 four probe temperature sensor", Mod.FSK_PCM, 100, 100, 4000, bands = BAND_433, what = BBQ, decode = ::en2058),
)
