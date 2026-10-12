package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Acurite: the largest single family here and the most common weather sensor in the US. Most of the range shares
 * one frame and dispatches on a message type in the third byte — Tower, Iris 5-in-1, Notos 3-in-1, Atlas
 * 7-in-1, Optimus 6-in-1, 6045M lightning, 899 rain, 515 fridge / freezer, 1190 leak — checked by a byte sum and
 * even parity on every data byte's top bit. The older sensors each have their own arrangement.
 *
 * Ported from rtl_433's acurite.c (GPL-2.0-or-later). Twin of web/src/dsp/r433/devices/acurite.ts.
 */

private const val MSG_1190_DETECTOR = 0x01
private const val MSG_TOWER = 0x04
private const val MSG_ATLAS_WIND_TEMP_HUM = 0x05
private const val MSG_ATLAS_WIND_RAIN = 0x06
private const val MSG_ATLAS_WIND_UV_LUX = 0x07
private const val MSG_515_REFRIGERATOR = 0x08
private const val MSG_515_FREEZER = 0x09
private const val MSG_3N1 = 0x20
private const val MSG_ATLAS_WIND_TEMP_HUM_LTNG = 0x25
private const val MSG_ATLAS_WIND_RAIN_LTNG = 0x26
private const val MSG_ATLAS_WIND_UV_LUX_LTNG = 0x27
private const val MSG_6045M = 0x2f
private const val MSG_899_RAINFALL = 0x30
private const val MSG_5N1_WIND_DIR_RAIN = 0x31
private const val MSG_5N1_WIND_TEMP_HUM = 0x38
private const val MSG_OPTIMUS_WIND_RAIN = 0x3a
private const val MSG_OPTIMUS_TEMP_HUM = 0x3b

private const val LEN_515 = 6
private const val LEN_TXR = 7
private const val LEN_1190 = 7
private const val LEN_3N1 = 8
private const val LEN_5N1 = 8
private const val LEN_899 = 8
private const val LEN_ATLAS = 8
private const val LEN_6045 = 9
private const val LEN_ATLAS_LTNG = 10
private const val LEN_OPTIMUS = 10

/** The vane's sixteen reed-switch positions as the sensor codes them; 22.5° each. */
private val WIND_DIRECTIONS = intArrayOf(14, 11, 13, 12, 15, 10, 0, 9, 3, 6, 4, 5, 2, 7, 1, 8)
private val CHANNELS = arrayOf("C", "E", "B", "A")
private fun channelOf(byte: Int) = CHANNELS[(byte and 0xc0) shr 6]
private fun rawMsg(bb: UBytes, len: Int) = hexBytes(bb, len)
private val B433 = listOf(433_920_000L)

private fun txrCheck(bb: UBytes, browlen: Int, explen: Int): Int {
    if (browlen < 6) return DECODE_ABORT_LENGTH
    if (browlen < explen) return DECODE_ABORT_LENGTH
    if ((addBytes(bb, explen - 1) and 0xff) != bb[explen - 1]) return DECODE_FAIL_MIC
    if (parityBytes(bb, explen - 3, 2) != 0) return DECODE_FAIL_MIC
    if (channelOf(bb[0]) == "E") return DECODE_FAIL_SANITY
    return 0
}

private fun battery(bb: UBytes) = if ((bb[2] and 0x40) == 0) 0 else 1

private fun towerDecode(bb: UBytes, ctx: DecodeCtx): Int {
    val humidity = bb[3] and 0x7f
    if (humidity > 100 && humidity != 127) return DECODE_FAIL_SANITY
    val tempRaw = ((bb[4] and 0x7f) shl 7) or (bb[5] and 0x7f)
    val tempC = (tempRaw - 1000) * 0.1
    if (tempC < -40 || tempC > 70) return DECODE_FAIL_SANITY
    val out = data("model" to "Acurite-Tower", "id" to (((bb[0] and 0x3f) shl 8) or bb[1]), "channel" to channelOf(bb[0]),
        "battery_ok" to battery(bb), "temperature_C" to round1(tempC), "mic" to "CHECKSUM")
    if (humidity != 127) out["humidity"] = humidity
    if ((tempRaw and 0x3800) != 0) { out["exception"] = 1; out["raw_msg"] = rawMsg(bb, LEN_TXR) }
    ctx.emit(out)
    return 1
}

private fun leakDecode(bb: UBytes, ctx: DecodeCtx): Int {
    ctx.emit(data("model" to "Acurite-Leak", "id" to (((bb[0] and 0x3f) shl 8) or bb[1]), "channel" to channelOf(bb[0]),
        "battery_ok" to battery(bb), "leak_detected" to ((bb[3] and 0x10) shr 4), "mic" to "CHECKSUM"))
    return 1
}

private fun fridgeDecode(bb: UBytes, ctx: DecodeCtx): Int {
    val type = bb[2] and 0x3f
    val suffix = when (type) { MSG_515_REFRIGERATOR -> "R"; MSG_515_FREEZER -> "F"; else -> return DECODE_FAIL_SANITY }
    val tempRaw = ((bb[3] and 0x7f) shl 7) or (bb[4] and 0x7f)
    val tempF = (tempRaw - 1480) * 0.1
    if (tempF < -40 || tempF > 158) return DECODE_FAIL_SANITY
    val out = data("model" to "Acurite-515", "id" to (((bb[0] and 0x3f) shl 8) or bb[1]), "channel" to channelOf(bb[0]) + suffix,
        "battery_ok" to battery(bb), "temperature_F" to round1(tempF), "mic" to "CHECKSUM")
    if ((tempRaw and 0x3000) != 0) { out["exception"] = 1; out["raw_msg"] = rawMsg(bb, LEN_515) }
    ctx.emit(out)
    return 1
}

/** 6045M lightning (AS3935): each strike, and an estimate of how far off the storm's leading edge is. */
private fun lightning6045Decode(bb: UBytes, ctx: DecodeCtx): Int {
    val humidity = bb[3] and 0x7f
    if (humidity > 100) return DECODE_FAIL_SANITY
    val tempRaw = ((bb[4] and 0x1f) shl 7) or (bb[5] and 0x7f)
    val tempF = (tempRaw - 1480) * 0.1
    if (tempF < -40 || tempF > 158) return DECODE_FAIL_SANITY
    var exception = 0
    if ((tempRaw and 0x3000) != 0) exception++
    if ((bb[4] and 0x20) != 0) exception++
    ctx.emit(data("model" to "Acurite-6045M", "id" to (((bb[0] and 0x3f) shl 8) or bb[1]), "channel" to channelOf(bb[0]),
        "battery_ok" to battery(bb), "temperature_F" to round1(tempF), "humidity" to humidity,
        "strike_count" to (((bb[6] and 0x7f) shl 1) or ((bb[7] and 0x40) shr 6)), "storm_dist" to (bb[7] and 0x1f),
        "active" to if ((bb[4] and 0x40) == 0x40) 1 else 0, "rfi" to if ((bb[7] and 0x20) == 0x20) 1 else 0,
        "exception" to exception, "raw_msg" to rawMsg(bb, LEN_6045)))
    return 1
}

private fun rain899Decode(bb: UBytes, ctx: DecodeCtx): Int {
    val ticks = ((bb[5] and 0x7f) shl 7) or (bb[6] and 0x7f)
    ctx.emit(data("model" to "Acurite-Rain899", "id" to (((bb[0] and 0x3f) shl 8) or bb[1]), "channel" to (bb[0] shr 6),
        "battery_ok" to battery(bb), "rain_mm" to round2(ticks * 0.254), "mic" to "CHECKSUM"))
    return 1
}

private fun notos3n1Decode(bb: UBytes, ctx: DecodeCtx): Int {
    val channel = channelOf(bb[0])
    if (channel == "E") return DECODE_FAIL_SANITY
    val humidity = bb[3] and 0x7f
    if (humidity > 100) return DECODE_FAIL_SANITY
    val tempF = ((((bb[4] and 0x1f) shl 7) or (bb[5] and 0x7f)) - 1480) * 0.1
    if (tempF < -40 || tempF > 158) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Acurite-3n1", "message_type" to (bb[2] and 0x3f), "id" to (((bb[0] and 0x3f) shl 8) or bb[1]),
        "channel" to channel, "sequence_num" to ((bb[0] and 0x30) shr 4), "battery_ok" to battery(bb),
        "wind_avg_mi_h" to (bb[6] and 0x7f), "temperature_F" to round1(tempF), "humidity" to humidity, "mic" to "CHECKSUM"))
    return 1
}

/** Iris 5-in-1: alternates wind + direction + rain with wind + temperature + humidity. */
private fun iris5n1Decode(bb: UBytes, ctx: DecodeCtx): Int {
    val type = bb[2] and 0x3f
    val raw = ((bb[3] and 0x1f) shl 3) or ((bb[4] and 0x70) shr 4)
    val windKmh = if (raw > 0) raw * 0.8278 + 1.0 else 0.0
    val common = data("model" to "Acurite-5n1", "message_type" to type, "id" to (((bb[0] and 0x0f) shl 8) or bb[1]),
        "channel" to channelOf(bb[0]), "sequence_num" to ((bb[0] and 0x30) shr 4), "battery_ok" to battery(bb),
        "wind_avg_km_h" to round1(windKmh))
    if (type == MSG_5N1_WIND_DIR_RAIN) {
        val ticks = ((bb[5] and 0x7f) shl 7) or (bb[6] and 0x7f)
        common["wind_dir_deg"] = WIND_DIRECTIONS[bb[4] and 0x0f] * 22.5
        common["rain_in"] = round2(ticks * 0.01)
        common["mic"] = "CHECKSUM"
        ctx.emit(common)
        return 1
    }
    if (type == MSG_5N1_WIND_TEMP_HUM) {
        val tempF = ((((bb[4] and 0x0f) shl 7) or (bb[5] and 0x7f)) - 400) * 0.1
        if (tempF < -40 || tempF > 158) return DECODE_FAIL_SANITY
        val humidity = bb[6] and 0x7f
        if (humidity > 100) return DECODE_FAIL_SANITY
        common["temperature_F"] = round1(tempF); common["humidity"] = humidity; common["mic"] = "CHECKSUM"
        ctx.emit(common)
        return 1
    }
    return DECODE_FAIL_SANITY
}

/** Atlas 7-in-1: three subjects, each with and without lightning appended. */
private fun atlasDecode(bb: UBytes, ctx: DecodeCtx): Int {
    val type = bb[2] and 0x3f
    val windMph = ((bb[3] and 0x7f) shl 1) or ((bb[4] and 0x40) shr 6)
    if (windMph > 200) return DECODE_FAIL_SANITY
    var exception = 0
    val out = data("model" to "Acurite-Atlas", "id" to (((bb[0] and 0x03) shl 8) or bb[1]), "channel" to channelOf(bb[0]),
        "sequence_num" to ((bb[0] and 0x0c) shr 2), "battery_ok" to battery(bb), "message_type" to type,
        "wind_avg_mi_h" to round1(windMph.toDouble()))
    if (type == MSG_ATLAS_WIND_TEMP_HUM || type == MSG_ATLAS_WIND_TEMP_HUM_LTNG) {
        val tempF = ((((bb[4] and 0x0f) shl 7) or (bb[5] and 0x7f)) - 400) * 0.1
        if ((bb[4] and 0x30) != 0) exception++
        if (tempF < -40 || tempF > 158) return DECODE_FAIL_SANITY
        val humidity = bb[6] and 0x7f
        if (humidity > 100) return DECODE_FAIL_SANITY
        if (humidity == 0) exception++
        out["temperature_F"] = round1(tempF); out["humidity"] = humidity
    }
    if (type == MSG_ATLAS_WIND_RAIN || type == MSG_ATLAS_WIND_RAIN_LTNG) {
        // a hall-effect vane: direction arrives in degrees, not as a table index
        val windDir = ((bb[4] and 0x1f) shl 5) or ((bb[5] and 0x7c) shr 2)
        if ((bb[4] and 0x30) != 0) exception++
        if (windDir > 360) return DECODE_FAIL_SANITY
        val ticks = ((bb[5] and 0x03) shl 7) or (bb[6] and 0x7f)
        out["wind_dir_deg"] = windDir; out["rain_in"] = round2(ticks * 0.01)
    }
    if (type == MSG_ATLAS_WIND_UV_LUX || type == MSG_ATLAS_WIND_UV_LUX_LTNG) {
        val lux = ((bb[5] and 0x7f) shl 7) or (bb[6] and 0x7f)
        if (lux > 12000) return DECODE_FAIL_SANITY
        out["uvi"] = bb[4] and 0x0f; out["lux"] = lux * 10
    }
    if (type == MSG_ATLAS_WIND_TEMP_HUM_LTNG || type == MSG_ATLAS_WIND_RAIN_LTNG || type == MSG_ATLAS_WIND_UV_LUX_LTNG) {
        out["strike_count"] = ((bb[7] and 0x7f) shl 2) or ((bb[8] and 0x60) shr 5)
        out["strike_distance"] = bb[8] and 0x1f
    }
    out["exception"] = exception
    out["raw_msg"] = rawMsg(bb, if (type >= MSG_ATLAS_WIND_TEMP_HUM_LTNG) LEN_ATLAS_LTNG else LEN_ATLAS)
    ctx.emit(out)
    return 1
}

/** Optimus 6-in-1: the 5-in-1's two-message rotation in a longer frame. */
private fun optimusDecode(bb: UBytes, ctx: DecodeCtx): Int {
    val type = bb[2] and 0x3f
    val windMph = ((bb[3] and 0x7f) shl 1) or ((bb[4] and 0x40) shr 6)
    if (windMph > 200) return DECODE_FAIL_SANITY
    val common = data("model" to "Acurite-Optimus", "id" to (((bb[0] and 0x0f) shl 8) or bb[1]), "channel" to channelOf(bb[0]),
        "sequence_num" to ((bb[0] and 0x30) shr 4), "battery_ok" to battery(bb), "wind_avg_mi_h" to round1(windMph.toDouble()),
        "wind_avg_km_h" to round1(windMph * 1.609344))
    val raw = rawMsg(bb, LEN_OPTIMUS)
    if (type == MSG_OPTIMUS_TEMP_HUM) {
        val tempF = ((((bb[4] and 0x0f) shl 7) or (bb[5] and 0x7f)) - 400) * 0.1
        if (tempF < -40 || tempF > 158) return DECODE_FAIL_SANITY
        val humidity = bb[6] and 0x7f
        if (humidity > 100) return DECODE_FAIL_SANITY
        common["temperature_F"] = round1(tempF); common["humidity"] = humidity; common["raw_msg"] = raw
        ctx.emit(common)
        return 1
    }
    if (type == MSG_OPTIMUS_WIND_RAIN) {
        val ticks = ((bb[5] and 0x03) shl 7) or (bb[6] and 0x7f)
        common["wind_dir_deg"] = WIND_DIRECTIONS[bb[4] and 0x0f] * 22.5; common["rain_in"] = round2(ticks * 0.01); common["raw_msg"] = raw
        ctx.emit(common)
        return 1
    }
    return DECODE_FAIL_SANITY
}

private class TxrEntry(val len: Int, val fn: (UBytes, DecodeCtx) -> Int, val check: Boolean)

private val TXR_TABLE: Map<Int, TxrEntry> = mapOf(
    MSG_TOWER to TxrEntry(LEN_TXR, ::towerDecode, true),
    MSG_1190_DETECTOR to TxrEntry(LEN_1190, ::leakDecode, true),
    MSG_6045M to TxrEntry(LEN_6045, ::lightning6045Decode, true),
    MSG_515_REFRIGERATOR to TxrEntry(LEN_515, ::fridgeDecode, true),
    MSG_515_FREEZER to TxrEntry(LEN_515, ::fridgeDecode, true),
    MSG_5N1_WIND_TEMP_HUM to TxrEntry(LEN_5N1, ::iris5n1Decode, true),
    MSG_5N1_WIND_DIR_RAIN to TxrEntry(LEN_5N1, ::iris5n1Decode, true),
    MSG_OPTIMUS_TEMP_HUM to TxrEntry(LEN_OPTIMUS, ::optimusDecode, true),
    MSG_OPTIMUS_WIND_RAIN to TxrEntry(LEN_OPTIMUS, ::optimusDecode, true),
    MSG_899_RAINFALL to TxrEntry(LEN_899, ::rain899Decode, true),
    MSG_ATLAS_WIND_TEMP_HUM to TxrEntry(LEN_ATLAS, ::atlasDecode, true),
    MSG_ATLAS_WIND_RAIN to TxrEntry(LEN_ATLAS, ::atlasDecode, true),
    MSG_ATLAS_WIND_UV_LUX to TxrEntry(LEN_ATLAS, ::atlasDecode, true),
    MSG_ATLAS_WIND_TEMP_HUM_LTNG to TxrEntry(LEN_ATLAS_LTNG, ::atlasDecode, true),
    MSG_ATLAS_WIND_RAIN_LTNG to TxrEntry(LEN_ATLAS_LTNG, ::atlasDecode, true),
    MSG_ATLAS_WIND_UV_LUX_LTNG to TxrEntry(LEN_ATLAS_LTNG, ::atlasDecode, true),
    // the 3-in-1 does not always set its parity bit correctly, so only the sum is checked
    MSG_3N1 to TxrEntry(LEN_3N1, ::notos3n1Decode, false),
)

private fun acuriteTxr(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    var decoded = 0; var error = 0
    for (row in 0 until bits.numRows) {
        val browlen = bits.bitsPerRow[row] / 8
        val bb = bits.bb[row]
        if (browlen < 6) continue
        if (browlen > 10) { error = DECODE_ABORT_LENGTH; continue }
        if (bb[0] == 0 && bb[1] == 0 && bb[2] == 0 && bb[browlen - 1] == 0) continue
        val entry = TXR_TABLE[bb[2] and 0x3f]
        if (entry == null) { error = DECODE_FAIL_SANITY; continue }
        if (entry.check) {
            val ret = txrCheck(bb, browlen, entry.len)
            if (ret != 0) { error = ret; continue }
        } else {
            if (browlen < entry.len) { error = DECODE_ABORT_LENGTH; continue }
            if ((addBytes(bb, entry.len - 1) and 0xff) != bb[entry.len - 1]) { error = DECODE_FAIL_MIC; continue }
        }
        val ret = entry.fn(bb, ctx)
        if (ret > 0) decoded += ret else if (ret < 0) error = ret
    }
    return if (decoded != 0) decoded else error
}

private fun rain896(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val b = bits.bb[0]
    if (bits.bitsPerRow[0] < 24) return DECODE_ABORT_LENGTH
    if (bits.numRows < 12) return DECODE_ABORT_EARLY
    if (b[0] == 0 || b[1] == 0 || b[2] == 0 || b[3] != 0 || b[4] != 0) return DECODE_ABORT_EARLY
    ctx.emit(data("model" to "Acurite-Rain", "id" to b[0], "rain_mm" to round1((((b[1] and 0x0f) shl 8) or b[2]) * 0.5)))
    return 1
}

private fun acuriteTh(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var valid = 0; var result = 0
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] != 40) { result = DECODE_ABORT_LENGTH; continue }
        val bb = bits.bb[row]
        val cksum = bb[0] + bb[1] + bb[2] + bb[3]
        if (cksum == 0 || (cksum and 0xff) != bb[4]) { result = DECODE_FAIL_MIC; continue }
        val humidity = bb[3]
        if (humidity > 100) return DECODE_FAIL_SANITY
        val status = (bb[1] and 0xf0) shr 4
        ctx.emit(data("model" to "Acurite-609TXC", "id" to bb[0], "battery_ok" to if ((status and 0x8) != 0) 0 else 1,
            "temperature_C" to round1((signed(((bb[1] and 0x0f) shl 12) or (bb[2] shl 4), 16) shr 4) * 0.1),
            "humidity" to humidity, "status" to status, "mic" to "CHECKSUM"))
        valid++
    }
    return if (valid != 0) 1 else result
}

private fun acurite606(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(3, 32)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 33) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0) return DECODE_FAIL_SANITY
    if (lfsrDigest8(b, 3, 0x98, 0xf1) != b[3]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Acurite-606TX", "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1,
        "battery_ok" to ((b[1] and 0x80) shr 7), "button" to ((b[1] and 0x40) shr 6),
        "temperature_C" to round1((signed((b[1] shl 12) or (b[2] shl 4), 16) shr 4) * 0.1), "mic" to "CHECKSUM"))
    return 1
}

/** 590TX: no packet gap, so 25 bits with the last discarded; one field is temperature or humidity. */
private fun acurite590tx(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(3, 25)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 25) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[4] != 0) return DECODE_FAIL_SANITY
    if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0) return DECODE_FAIL_SANITY
    var parity = b[0]
    parity = (parity shr 4) xor (parity and 0x0f)
    parity = (parity shr 2) xor (parity and 0x03)
    parity = parity xor (b[1] shr 6)
    parity = (parity shr 1) xor (parity and 0x01)
    if (parity == 0) return DECODE_FAIL_MIC
    val tempRaw = signed(((b[1] and 0x0f) shl 12) or (b[2] shl 4), 16) shr 4
    val out = data("model" to "Acurite-590TX", "id" to (b[0] and 0xfe), "channel" to ((b[1] shr 4) and 0x03),
        "battery_ok" to (b[0] and 0x01), "mic" to "PARITY")
    if (tempRaw in 0..100) out["humidity"] = tempRaw else out["temperature_C"] = round1((tempRaw - 500) * 0.1)
    ctx.emit(out)
    return 1
}

private class FridgeOpts(val model: String, val minBits: Int, val maxBits: Int, val bytes: Int, val tempAt: Int, val idAt: Int, val crcAt: Int, val crcFrom: Int, val sanity: Boolean)

/** 985 / 986 fridge thermometers: LSB first, a reflected CRC, signed-magnitude whole Fahrenheit. */
private fun fridgeReversed(bits: BitBuffer, ctx: DecodeCtx, o: FridgeOpts): Int {
    var valid = 0; var result = 0
    for (row in 0 until bits.numRows) {
        val n = bits.bitsPerRow[row]
        if (n < o.minBits || n > o.maxBits) { if (n > 16) result = DECODE_ABORT_LENGTH; continue }
        val bb = bits.bb[row]
        if (o.model == "Acurite-986") {
            if ((bb[0] == 0xff && bb[1] == 0xff && bb[2] == 0xff) || (bb[0] == 0 && bb[1] == 0 && bb[2] == 0)) { result = DECODE_ABORT_EARLY; continue }
        } else if (bb[2] == 0 && bb[3] == 0 && bb[4] == 0 && bb[5] == 0 && bb[6] == 0) { result = DECODE_ABORT_EARLY; continue }
        val br = UBytes(o.bytes)
        for (i in 0 until o.bytes) br[i] = reverse8(bb[i])
        var tempF = br[o.tempAt]
        val sensorId = (br[o.idAt] shl 8) or br[o.idAt + 1]
        val status = if (o.model == "Acurite-986") br[3] shr 1 else br[5]
        val sensorNum = (if (o.model == "Acurite-986") (br[3] and 0x01) else (br[5] and 0x01)) + 1
        val batteryLow = if (o.model == "Acurite-986") (status and 1) == 1 else if (sensorNum == 2) (status and 0x04) != 0 else (status and 0x02) != 0
        val crcc = crc8le(br, 4, 0x07, 0, o.crcFrom)
        if (crcc != br[o.crcAt] && crcc != (br[o.crcAt] or 0x80)) { result = DECODE_FAIL_MIC; continue }
        if ((tempF and 0x80) != 0) tempF = -(tempF and 0x7f)
        if (o.sanity && !(tempF >= -40 && tempF <= 104) && tempF != -127 && tempF != 127) { result = DECODE_FAIL_SANITY; continue }
        ctx.emit(data("model" to o.model, "id" to sensorId, "channel" to if (sensorNum == 2) "2F" else "1R",
            "battery_ok" to if (batteryLow) 0 else 1, "temperature_F" to tempF, "status" to status, "mic" to "CRC"))
        valid++
    }
    return if (valid != 0) 1 else result
}

/** 00275rm / 00276rm: three copies are voted bit by bit into a fourth before the CRC is checked. */
private fun acurite00275rm(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var result = 0
    bits.invert()
    val rows = ArrayList<Int>()
    for (row in 0 until bits.numRows) if (rows.size < 3 && bits.bitsPerRow[row] == 88) rows.add(row)
    if (rows.size == 3) {
        val x = bits.bb[rows[0]]; val y = bits.bb[rows[1]]; val z = bits.bb[rows[2]]
        bits.addRow()
        val b = bits.bb[bits.numRows - 1]
        for (i in 0 until 11) b[i] = (x[i] and y[i]) or (y[i] and z[i]) or (z[i] and x[i])
        bits.bitsPerRow[bits.numRows - 1] = 88
    }
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] != 88) { result = DECODE_ABORT_LENGTH; continue }
        val b = bits.bb[row]
        if (crc16lsb(b, 11, 0x00b2, 0x00d0) != 0) { result = DECODE_FAIL_MIC; continue }
        val probe = b[5] and 3
        val out = data("model" to if ((b[2] and 1) != 0) "Acurite-00275rm" else "Acurite-00276rm", "subtype" to probe,
            "id" to ((b[0] shl 16) or (b[1] shl 8) or b[3]), "battery_ok" to battery(b),
            "temperature_C" to round1((((b[4] shl 4) or (b[5] shr 4)) - 1000) * 0.1),
            "humidity" to (((b[6] and 0x1f) shl 2) or (b[7] shr 6)), "mic" to "CRC")
        if (probe == 1) out["water"] = if ((b[7] and 0x0f) == 15) 1 else 0
        if (probe == 2 || probe == 3) out["temperature_1_C"] = round1(((((b[7] and 0x0f) shl 8) or b[8]) - 1000) * 0.1)
        if (probe == 3) out["humidity_1"] = b[9] and 0x7f
        ctx.emit(out)
        return 1
    }
    return result
}

internal val ACURITE: List<RDevice> = listOf(
    dev(40, "Acurite 592TXR temp/humidity, 592TX temp, 5n1, 3n1, Atlas weather station, 515 fridge/freezer, 6045 lightning, 899 rain, 1190/1192 leak",
        Mod.OOK_PWM, 220, 408, 4000, syncWidth = 620, gapLimit = 500, bands = B433,
        what = "the main Acurite range: thermometers, weather stations, lightning, rain, leaks and fridge probes", decode = ::acuriteTxr),
    dev(10, "Acurite 896 rain gauge", Mod.OOK_PPM, 1000, 2000, 5000, gapLimit = 3500, priority = 10, bands = B433, what = "tipping-bucket rain gauge", decode = ::rain896),
    dev(11, "Acurite 609TXC temperature and humidity sensor", Mod.OOK_PPM, 1000, 2000, 10000, gapLimit = 3000, bands = B433,
        what = "outdoor temperature and humidity sensor", decode = ::acuriteTh),
    dev(55, "Acurite 606TX / Technoline TX960 temperature sensor", Mod.OOK_PPM, 2000, 4000, 10000, gapLimit = 7000, bands = B433, what = "outdoor thermometer", decode = ::acurite606),
    dev(163, "Acurite 590TX temperature with optional humidity", Mod.OOK_PPM, 500, 1500, 3500, gapLimit = 2000, bands = B433, what = "outdoor thermometer", decode = ::acurite590tx),
    dev(41, "Acurite 986 refrigerator / freezer thermometer", Mod.OOK_PPM, 520, 880, 4000, gapLimit = 1280, bands = B433, what = "fridge and freezer probes") { _, bits, ctx ->
        fridgeReversed(bits, ctx, FridgeOpts("Acurite-986", 39, 43, 5, 0, 1, 4, 0, false)) },
    dev(326, "Acurite/Chaney 985 refrigerator / freezer thermometer", Mod.OOK_PPM, 556, 1104, 7636, gapLimit = 4000, syncWidth = 2996, bands = B433,
        what = "fridge and freezer probes, the older Chaney-branded version") { _, bits, ctx ->
        fridgeReversed(bits, ctx, FridgeOpts("Acurite-985", 55, 59, 7, 2, 3, 6, 2, true)) },
    dev(74, "Acurite 00275rm, 00276rm temp/humidity with optional probe", Mod.OOK_PWM, 232, 420, 708, gapLimit = 520, syncWidth = 632, bands = B433,
        what = "room monitor with an optional water or temperature probe", decode = ::acurite00275rm),
)
