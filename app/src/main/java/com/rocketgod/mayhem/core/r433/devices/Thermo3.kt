package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Thermometers: Rubicson 48659, Klimalogg, Inkbird ITH-20R, Acurite 01185M, Thermor DG950 and A6N 132TX,
 * Bresser ST1005H, Oria WA150KM and the Auriol HG04641A.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): rubicson_48659.c, klimalogg.c, inkbird_ith20r.c, acurite_01185m.c,
 * thermor_dg950.c, bresser_st1005h.c, oria_wa150km.c, thermor_a6n132tx.c, auriol_hg04641a.c. Twin of
 * web/src/dsp/r433/devices/thermo3.ts.
 */

private val BAND_433 = listOf(433_920_000L)

/**
 * Upstream reads `sign ? -1 : 1 * magnitude`, and `*` binds tighter than `?:`, so every sub-zero reading is
 * the constant -1 °F. Reproduced rather than silently corrected.
 */
private fun rubicson48659(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(10, 32)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 33 || bits.bitsPerRow[row] < 10) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (((addBytes(b, 3) - b[3]) and 0xff) != 0xa6) return DECODE_FAIL_MIC
    val tempF = if (((b[1] and 0x04) shr 2) != 0) -1 else ((b[1] and 0x03) shl 8) or b[2]
    ctx.emit(data("model" to "Rubicson-48659", "type" to "Weather", "id" to b[0], "temperature_F" to tempF, "mic" to "CHECKSUM"))
    return 1
}

private val KLIMALOGG_PRE = UBytes.of(0xb4, 0x2b)

/**
 * The whole transmission is bit-reflected, sync included, so 0x2d 0xd4 is searched as 0xb4 0x2b and the type
 * byte tested as 0x6a before the buffer is turned round. Humidity 0x6a means saturated or unknown, reported as 100.
 */
private fun klimalogg(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] < 11 * 8) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, KLIMALOGG_PRE, 16) + 16
    if (at + 9 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at, 9 * 8)
    if (b[7] != 0x6a) return DECODE_FAIL_SANITY
    reflectBytes(b, 9)
    if (crc8(b, 9, 0x31, 0x00) != 0) return DECODE_FAIL_MIC
    // Three BCD digits with a 40 °C offset.
    val tempRaw = (b[2] and 0x0f) * 100 + (b[3] shr 4) * 10 + (b[3] and 0x0f)
    val humidity = (b[4] and 0x7f).let { if (it == 0x6a) 100 else it }
    ctx.emit(data("model" to "Klimalogg-Pro", "type" to "Weather", "id" to (((b[0] and 0x7f) shl 8) or b[1]),
        "battery_ok" to if ((b[5] and 0x80) != 0) 0 else 1, "temperature_C" to round1((tempRaw - 400) * 0.1), "humidity" to humidity,
        "sequence_nr" to ((b[6] and 0xf0) shr 4), "mic" to "CRC"))
    return 1
}

private val INKBIRD_PRE = UBytes.of(0xaa, 0xaa, 0xaa, 0x2d, 0xd4)

/**
 * Little-endian throughout, CRC included. The source's own sample row fails its CRC, but the parameters reproduce
 * the stated check value over "123456789", so the arithmetic is right and the sample is a composite.
 */
private fun inkbird(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 187) return DECODE_ABORT_LENGTH
    val pos = bits.search(0, 0, INKBIRD_PRE, 40)
    if (pos == bits.bitsPerRow[0]) return DECODE_FAIL_SANITY
    val start = pos + 40
    var len = bits.bitsPerRow[0] - start
    if ((len + 7) / 8 < 19) return DECODE_ABORT_LENGTH
    if (len > 19 * 8) len = 19 * 8
    val msg = UBytes(19)
    bits.extractBytes(0, start, msg, len)
    if (crc16lsb(msg, 16, 0xa001, 0x86f4) != ((msg[17] shl 8) or msg[16])) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Inkbird-ITH20R", "type" to "Weather", "id" to ((msg[9] shl 8) or msg[8]),
        "battery_ok" to round2(msg[7] * 0.01),            // a level, not a flag: upstream's own shape
        "sensor_num" to msg[4],                            // 2 once an external probe is plugged in
        "temperature_C" to round1(signed((msg[11] shl 8) or msg[10], 16) * 0.1),
        "temperature_2_C" to round1(signed((msg[13] shl 8) or msg[12], 16) * 0.1),   // 130.0 with no second probe
        "humidity" to round1(((msg[15] shl 8) or msg[14]) * 0.1), "mic" to "CRC"))
    return 1
}

/**
 * Inverted, then reflected in place as upstream does. The sum is full width, since all zeros passes the checksum
 * and only the unnarrowed sum rules it out. 7000 and 200 are unplugged and failed probes.
 */
private fun acurite01185m(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var result = 0
    bits.invert()
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] != 56) { result = DECODE_ABORT_LENGTH; continue }
        val b = bits.bb[row]
        reflectBytes(b, 7)
        var sum = 0
        for (i in 0 until 6) sum += b[i]
        if ((sum and 0xff) != b[6]) { result = DECODE_FAIL_MIC; continue }
        if (sum == 0) return DECODE_FAIL_SANITY
        val t1 = (b[2] shl 8) or b[3]
        val t2 = (b[4] shl 8) or b[5]
        val out = data("model" to "Acurite-01185M", "type" to "Weather", "id" to b[0],
            "channel" to (b[1] and 0x0f),                  // picked by the sensor: only 3, 6, 12 and 15 are seen
            "battery_ok" to if ((b[1] shr 7) != 0) 0 else 1)
        if (t1 in 201..6999) out["temperature_1_F"] = round1((t1 - 900) * 0.1)
        if (t2 in 201..6999) out["temperature_2_F"] = round1((t2 - 900) * 0.1)
        out["mic"] = "CHECKSUM"
        ctx.emit(out)
        return 1
    }
    return result
}

/** Sixteen compass points in the order the sensor's own code numbers them. */
private val DG950_WIND_DIR = intArrayOf(157, 45, 135, 67, 180, 22, 112, 90, 225, 337, 247, 315, 202, 0, 270, 292)

/**
 * Thirteen nine-bit bursts stitched back into bytes. Nearly every field is inverted and self-confirming: the
 * temperature halves summed into a check byte (a sum of 0xff can never match, as upstream has it), rain sent twice
 * seven apart, direction twice, wind bytes summed into a fourth. A learning broadcast carries only the new id.
 */
private fun thermorDg950(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 13) return DECODE_ABORT_EARLY
    val b = UBytes(13)
    for (row in 0 until 13) {
        if (bits.bitsPerRow[row] != 9) return DECODE_ABORT_EARLY
        if ((bits.bb[row][0] and 0x80) != 0) return DECODE_ABORT_EARLY
        b[row] = bits.bytes(row, 1, 8)[0]
    }
    reflectBytes(b, 13)
    if (b[0] == 0xff && b[1] == b[2] && b[1] == b[4] && b[1] == b[5] && b[1] == b[6] && b[1] == b[7] && b[1] == b[8] && b[1] == b[10]) {
        ctx.emit(data("model" to "Thermor-DG950", "type" to "Weather", "id" to (b[1].inv() and 0xff), "pairing" to 1, "mic" to "CHECKSUM"))
        return 1
    }
    if (((b[1] + b[10]) and 0xff) + 1 != b[3]) return DECODE_ABORT_EARLY
    val tempC = (b[1] - 195) + (b[10] - 245) * 0.1
    val rainRate = b[2].inv() and 0xff
    if (rainRate != (b[12].inv() and 0xff) - 7) return DECODE_ABORT_EARLY
    var windDir = -1
    if (b[4] != 0xff && b[5] != 0xff) {
        if (b[4] != b[5]) return DECODE_ABORT_EARLY
        windDir = DG950_WIND_DIR[b[4] and 0x0f]
    }
    if (((b[6].inv() + b[7].inv() + b[8].inv()) and 0xff) != (b[9].inv() and 0xff)) return DECODE_ABORT_EARLY
    var windKmh = -1.0
    if (b[8] != 0xff) {
        val speedRaw = (b[6].inv() and 0xff) or ((b[7].inv() and 0xff) shl 8)
        val coef = b[8].inv() and 0xff
        // The cups are less linear at low speed, so a fitted slope is used below one byte of count.
        val ratio = if (speedRaw < 256) speedRaw * -0.0001746 + 0.155 else 0.11
        windKmh = maxOf(0.0, ratio * (speedRaw - coef + 45))
    }
    val out = data("model" to "Thermor-DG950", "type" to "Weather", "id" to (b[0].inv() and 0xff), "temperature_C" to round1(tempC),
        "rain_rate_mm_h" to round1(rainRate * 0.1))
    if (windDir >= 0) out["wind_dir_deg"] = windDir
    if (windKmh >= 0) out["wind_avg_km_h"] = round1(windKmh)
    out["pairing"] = 0
    out["mic"] = "CHECKSUM"
    ctx.emit(out)
    return 1
}

/**
 * Thirty-eight bits behind a mandatory zero, read shifted one left; the payload's last bit belongs to the six-bit
 * nibble-sum checksum and is cleared before summing. An Oregon hygrometer shares the shape; upstream sets no priority.
 */
private fun st1005h(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(3, 38)
    if (r < 0 || bits.bitsPerRow[r] > 38) return DECODE_ABORT_LENGTH
    val b = bits.bb[r]
    if ((b[0] and 0x80) != 0) return DECODE_FAIL_SANITY
    val msg = bits.bytes(r, 1, 32)
    msg[3] = msg[3] and 0xfe
    val sum = addNibbles(msg, 4)
    if (sum == 0) return DECODE_ABORT_EARLY
    if ((b[4] shr 2) != (sum and 0x3f)) return DECODE_FAIL_MIC
    val tempC = (signed(((msg[1] and 0x0f) shl 12) or (msg[2] shl 4), 16) shr 4) * 0.1
    val channel = ((msg[1] shr 4) and 0x03) + 1
    val humidity = msg[3] shr 1
    if (channel >= 4 || humidity > 110 || tempC < -30 || tempC > 160) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Bresser-ST1005H", "type" to "Weather", "id" to msg[0], "channel" to channel,
        "battery_ok" to if ((msg[1] shr 7) != 0) 0 else 1, "button" to ((msg[1] shr 6) and 0x01), "temperature_C" to round1(tempC),
        "humidity" to humidity, "mic" to "CHECKSUM"))
    return 1
}

private fun oriaNibble(m: UBytes, k: Int) = if (k % 2 == 0) (m[k shr 1] shr 4) and 0x0f else m[k shr 1] and 0x0f

/**
 * G. E. Thomas Manchester, so the buffer is inverted for the shared decoder. The trailing 0x69 is the fixed
 * terminator seen through the line code. The nibble sum is the decoded frame's own nibbles. Runs late so an
 * Oregon THGR810 can claim its own frames.
 */
private fun oria(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val bitlen = 227
    var r = -1
    for (i in 0 until bits.numRows) if (bits.bitsPerRow[i] == bitlen) { r = i; break }
    if (r < 0) return DECODE_ABORT_LENGTH
    val raw = bits.bb[r]
    if (raw[0] != 0xaa || raw[1] != 0xaa || raw[2] != 0xaa) return DECODE_ABORT_EARLY
    if (raw[bitlen / 8 - 1] != 0x69) return DECODE_ABORT_EARLY
    bits.invert()
    val mc = BitBuffer()
    bits.manchesterDecode(r, 0, mc, bitlen)
    val m = mc.bb[0]
    var sum = 0
    for (i in 0 until 15) sum += reflect4(oriaNibble(m, 7 + i))
    if ((sum and 0xff) != (reflect4(oriaNibble(m, 22)) or (reflect4(oriaNibble(m, 23)) shl 4))) return DECODE_FAIL_MIC
    reflectBytes(m, (mc.bitsPerRow[0] + 7) shr 3)
    var temperature = ((m[8] shr 4) and 0x0f) * 10 + (m[8] and 0x0f) + ((m[7] shr 4) and 0x0f) * 0.1
    if ((m[9] and 0x08) != 0) temperature = -temperature
    ctx.emit(data("model" to "Oria-WA150KM", "type" to "Weather", "id" to m[6], "channel" to ((m[5] shr 4) and 0x0f) + 1,
        "temperature_C" to round1(temperature), "mic" to "CHECKSUM"))
    return 1
}

/**
 * The checksum's high nibble changes shape with the sensor id: a lone parity bit on id 4, a parity bit over a
 * carry-folded value on the others. Every published sample satisfies it. Unsigned: no reading below zero.
 */
private fun thermorA6n(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 5) return DECODE_ABORT_LENGTH
    val row = bits.findRepeatedRow(5, 32)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 32) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    val tempRaw = (b[1] shl 8) or b[2]
    if (tempRaw > 2500) return DECODE_FAIL_SANITY
    val loSum = (b[0] and 0x0f) + (b[1] and 0x0f) + (b[2] and 0x0f)
    val overflow = loSum shr 4
    if ((loSum and 0x0f) != (b[3] and 0x0f)) return DECODE_FAIL_MIC
    val id = (b[0] shr 4) and 0x0f
    val hiSum = (b[0] shr 4) + (b[1] shr 4) + (b[2] shr 4)
    val chkHi = b[3] shr 4
    if (id == 4) {
        if (chkHi != ((hiSum + overflow) and 1)) return DECODE_FAIL_MIC
    } else {
        val msb = parity8(b[0] and 0x0f) xor parity8(b[1] and 0x0f) xor parity8(b[2])
        if (chkHi != ((msb shl 3) or ((2 + (hiSum and 1)) xor overflow))) return DECODE_FAIL_MIC
    }
    ctx.emit(data("model" to "Thermor-A6N132TX", "type" to "Weather", "id" to id, "channel" to ((b[0] shr 2) and 0x03),
        "temperature_C" to round1(tempRaw * 0.1), "mic" to "CHECKSUM"))
    return 1
}

/**
 * Four check bits let other sensors through, so the flag nibble (one bit always set, two always clear) and a
 * temperature range carry most of the weight; upstream calls these mitigations, and they are kept exactly.
 */
private fun auriolHg04641a(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 36)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] < 36) return DECODE_ABORT_LENGTH
    val b = bits.bytes(row, 0, 36)
    b[4] = b[4] shr 4
    if ((addNibbles(b, 4) and 0x0f) != b[4]) return DECODE_FAIL_MIC
    val flags = b[2] shr 4
    if ((flags and 0x06) != 0 || (flags and 0x01) == 0) return DECODE_FAIL_SANITY
    val tempDecic = signed(((b[2] and 0x0f) shl 12) or (b[3] shl 4), 16) shr 4
    if (tempDecic < -400 || tempDecic > 600) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Auriol-HG04641A", "type" to "Weather", "id" to ((b[0] shl 8) or b[1]),
        "battery_ok" to if ((flags and 0x08) != 0) 0 else 1, "temperature_C" to round1(tempDecic * 0.1), "mic" to "CHECKSUM"))
    return 1
}

private const val TH = "thermometer and hygrometer"

internal val THERMO3: List<RDevice> = listOf(
    dev(133, "Rubicson 48659 Thermometer", Mod.OOK_PPM, 940, 1900, 4000, gapLimit = 2000, bands = BAND_433, what = "meat thermometer", decode = ::rubicson48659),
    dev(150, "Klimalogg", Mod.OOK_NRZS, 26, 0, 1000, disabled = true, bands = BAND_433, what = "logging thermometer and hygrometer", decode = ::klimalogg),
    dev(194, "Inkbird ITH-20R temperature humidity sensor", Mod.FSK_PCM, 100, 100, 4000, bands = BAND_433,
        what = "logging thermometer and hygrometer with a second probe", decode = ::inkbird),
    dev(197, "Acurite Grill/Meat Thermometer 01185M", Mod.OOK_PWM, 840, 2070, 6000, gapLimit = 3000, syncWidth = 6600, bands = BAND_433,
        what = "grill and meat thermometer", decode = ::acurite01185m),
    dev(254, "Thermor DG950 weather station", Mod.OOK_PWM, 680, 2100, 8000, gapLimit = 3000, syncWidth = 1438, bands = BAND_433,
        what = "weather station with wind and rain sensors", decode = ::thermorDg950),
    dev(268, "Bresser Thermo-/Hygro-Sensor Explore Scientific ST1005H", Mod.OOK_PPM, 2500, 4500, 10000, gapLimit = 4500, bands = BAND_433,
        what = TH, decode = ::st1005h),
    dev(288, "Oria WA150KM freezer and fridge thermometer", Mod.OOK_PCM, 490, 490, 4000, gapLimit = 1500, priority = 10, bands = BAND_433,
        what = "freezer and fridge thermometer", decode = ::oria),
    dev(325, "Thermor A6N 132TX temperature sensor", Mod.OOK_PPM, 1000, 2000, 4000, gapLimit = 2000, bands = BAND_433, what = "thermometer", decode = ::thermorA6n),
    dev(357, "Auriol HG04641A temperature station", Mod.OOK_PPM, 980, 1976, 5000, gapLimit = 2500, bands = BAND_433, what = "thermometer", decode = ::auriolHg04641a),
)
