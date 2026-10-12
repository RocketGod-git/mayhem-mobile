package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.min

/*
 * Weather stations and a garden irrigation set: Holman / AOK WS5029, Cotech, Vevor 7-in-1, Sainlogic SA8 and
 * the Bresser SmartHome Garden.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): holman_ws5029.c, cotech_36_7959.c, cotech_ft0203.c, cotech_36_7900.c,
 * vevor_7in1.c, sainlogic_sa8.c, bresser_garden.c. Twin of web/src/dsp/r433/devices/weather5.ts.
 */

private val BAND_433 = listOf(433_920_000L)
private val BAND_VEVOR = listOf(868_300_000L, 915_000_000L)
/** The set spreads across the low 433 band, but everything sent to the soil sensor sits at 434.57. */
private val BAND_GARDEN = listOf(433_920_000L, 434_570_000L)
private const val STATION = "weather station: temperature, humidity, rain and wind"

private fun s16(v: Int) = signed(v, 16)

/** Sixteen compass points as whole degrees, rounded as upstream rounds them. */
private val WIND_DIR_DEG = intArrayOf(0, 23, 45, 68, 90, 113, 135, 158, 180, 203, 225, 248, 270, 293, 315, 338)

/**
 * Two builds told apart by frame length and whether the light field is zero. The check is a byte-wide xor fed to
 * a reflected Galois digest, which for one byte is just a fixed linear map.
 */
private fun holmanPcm(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    if (rowBits < 192) return DECODE_ABORT_LENGTH
    val pos = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0xaa, 0x98, 0xf3, 0xa5), 48)
    if (pos >= rowBits) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, pos + 48, 18 * 8)
    if (lfsrDigest8Reflect(UBytes.of(xorBytes(b, 12)), 1, 0x00, 0x31) != b[12]) return DECODE_FAIL_MIC
    val id = (b[0] shl 8) or b[1]
    val tempC = round1((s16((b[2] shl 8) or (b[3] and 0xf0)) shr 4) * 0.1)
    val humidity = ((b[3] and 0x0f) shl 4) or ((b[4] and 0xf0) shr 4)
    val rainRaw = ((b[4] and 0x0f) shl 8) or b[5]
    val windAvg = b[6]
    val windDir = WIND_DIR_DEG[(b[7] and 0xf0) shr 4]
    val lux = ((b[8] and 0x7f) shl 10) or (b[9] shl 2) or ((b[10] and 0xc0) shr 6)
    if (rowBits < 200 && lux == 0) {
        // No light sensor; rain steps in 0.79 mm.
        ctx.emit(data("model" to "Holman-WS5029", "type" to "Weather", "id" to id, "temperature_C" to tempC, "humidity" to humidity,
            "rain_mm" to round1(rainRaw * 0.79), "wind_avg_km_h" to windAvg, "wind_dir_deg" to windDir, "mic" to "CHECKSUM"))
        return 1
    }
    if (rowBits < 221) {
        ctx.emit(data("model" to "AOK-5056", "type" to "Weather", "id" to id, "temperature_C" to tempC, "humidity" to humidity,
            "rain_mm" to rainRaw, "wind_avg_km_h" to windAvg, "wind_dir_deg" to windDir,
            "uvi" to (((b[7] and 0x07) shl 1) or ((b[8] and 0x80) shr 7)), "light_lux" to lux,
            "counter" to (((b[10] and 0x0f) shl 8) or b[11]), "battery_ok" to if (((b[10] and 0x30) shr 4) != 0) 0 else 1, "mic" to "CHECKSUM"))
        return 1
    }
    return DECODE_FAIL_OTHER
}

/** Two interleaved xor sums, plus the even one shifted by each set key bit and folded back, every step narrowed. */
private fun xorShiftBytes(m: UBytes, numBytes: Int, shiftUp: Int): Int {
    var r0 = 0; var r1 = 0; var rx = 0
    for (i in 0 until numBytes step 2) r0 = r0 xor m[i]
    for (i in 1 until numBytes step 2) r1 = r1 xor m[i]
    for (j in 0 until 7) if ((shiftUp and (1 shl j)) != 0) rx = rx xor ((r0 shl (j + 1)) and 0xff)
    return (r0 xor r1 xor rx) and 0xff
}

/**
 * Inverted: the preamble is checked before the flip, everything after it. Upstream sign-extends the
 * temperature then stores it unsigned, so anything below zero comes out near 409 °C; reproduced deliberately.
 */
private fun holmanPwm(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(3, 96)
    if (row < 0 || bits.bitsPerRow[row] != 96) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[0] != 0x55 || b[1] != 0x5a || b[2] != 0x67) return DECODE_FAIL_SANITY
    bits.invert()
    if (xorShiftBytes(b, 10, 0x18) != b[10]) return DECODE_FAIL_MIC
    val tempRaw = (((b[4] and 0x0f) shl 12) or (b[5] shl 4)) and 0xffff
    val windDir = b[9] and 0x0f
    ctx.emit(data("model" to "Holman-WS5029", "type" to "Weather", "id" to b[3], "battery_ok" to if ((b[4] and 0x80) != 0) 0 else 1,
        "temperature_C" to round1((tempRaw shr 4) * 0.1), "humidity" to b[6], "rain_mm" to round1(((b[7] shl 4) + (b[8] shr 4)) * 0.79),
        "wind_avg_km_h" to ((b[8] and 0x0f) shl 4) + (b[9] shr 4), "wind_dir_deg" to (windDir * 22.5).toInt(), "mic" to "CHECKSUM"))
    return 1
}

/**
 * An unfitted light sensor reads all ones, a UV index of 251, so both light fields are dropped when the UV byte
 * passes a bound no real index reaches. Temperature is Fahrenheit, whatever upstream's variable is called.
 */
private fun cotech367959(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 2) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] < 112 && bits.bitsPerRow[1] < 112) return DECODE_ABORT_EARLY
    val preamble = UBytes.of(0x01, 0x40)
    var b: UBytes? = null
    for (i in 0 until bits.numRows) {
        val pos = bits.search(i, 0, preamble, 12) + 12
        if (pos + 112 > bits.bitsPerRow[i]) continue
        b = bits.bytes(i, pos, 112)
        break
    }
    if (b == null) return DECODE_FAIL_SANITY
    if (crc8(b, 14, 0x31, 0xc0) != 0) return DECODE_FAIL_MIC
    // Four readings carry their top bit in the flags nibble.
    val windDir = (((b[1] and 0x04) shr 2) shl 8) or b[4]
    val gust = (((b[1] and 0x02) shr 1) shl 8) or b[3]
    val windAvg = ((b[1] and 0x01) shl 8) or b[2]
    val uvi = b[12]
    val out = data("model" to "Cotech-367959", "type" to "Weather", "id" to (((b[0] and 0x0f) shl 4) or (b[1] shr 4)),
        "battery_ok" to if (((b[1] and 0x08) shr 3) != 0) 0 else 1, "temperature_F" to round1(((((b[7] and 0x0f) shl 8) or b[8]) - 400) * 0.1),
        "humidity" to b[9], "rain_mm" to round1((((b[5] and 0x0f) shl 8) or b[6]) * 0.1), "wind_dir_deg" to windDir,
        "wind_avg_m_s" to round1(windAvg * 0.1), "wind_max_m_s" to round1(gust * 0.1), "mic" to "CRC")
    if (uvi <= 150) {
        out["light_lux"] = ((b[10] shl 8) or b[11]) or ((b[7] and 0x80) shl 9)
        out["uvi"] = round1(uvi * 0.1)
    }
    ctx.emit(out)
    return 1
}

/** Reconstructed upstream from transcribed hex, never a capture; every offset is tried for sync, two 0xff and a CRC at once. */
private fun cotechFt0203(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val b = UBytes(9)
    for (row in 0 until bits.numRows) {
        val rowBits = bits.bitsPerRow[row]
        var pos = 0
        while (pos + 72 <= rowBits) {
            bits.extractBytes(row, pos, b, 72)
            if (b[0] == 0x14 && b[6] == 0xff && b[7] == 0xff && crc8(b, 9, 0x31, 0xc0) == 0) {
                ctx.emit(data("model" to "Cotech-FT0203", "type" to "Weather", "id" to ((b[1] shl 3) or (b[2] shr 5)),
                    "battery_ok" to ((b[2] shr 4) and 0x01),     // one means healthy, unlike the 36-7959
                    "wind_dir_deg" to ((((b[2] shr 2) and 0x01) shl 8) or b[5]),
                    "wind_avg_m_s" to round1((((b[2] and 0x01) shl 8) or b[3]) * 0.1),
                    "wind_max_m_s" to round1(((((b[2] shr 1) and 0x01) shl 8) or b[4]) * 0.1), "mic" to "CRC"))
                return 1
            }
            pos++
        }
    }
    return DECODE_FAIL_SANITY
}

/**
 * No checksum: twenty-four bits zero in every one of upstream's sixty-six messages stand in for one. Rain stays
 * a raw count, since nobody has calibrated a tip.
 */
private fun cotech367900(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(8, 60)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 60) return DECODE_ABORT_LENGTH
    val b = bits.bytes(row, 0, 60)
    if (b[0] != 0xab || (b[1] shr 4) != 0x8) return DECODE_ABORT_EARLY
    if (b[3] != 0x00 || b[4] != 0x00 || b[5] != 0x00) return DECODE_FAIL_MIC
    var tempRaw = ((b[1] and 0x0f) shl 8) or b[2]
    if ((tempRaw and 0x800) != 0) tempRaw -= 0x1000
    ctx.emit(data("model" to "Cotech-367900", "type" to "Weather", "id" to ((b[0] shl 8) or b[1]), "temperature_C" to round1(tempRaw * 0.1),
        "rain_raw" to ((b[6] shl 4) or (b[7] shr 4))))
    return 1
}

/**
 * One row on purpose: a zero light reading leaves a gap the slicer would split on, so the reset limit is wide and
 * the row is walked. Wind, direction and rain carry +257; the light's top bit is a ×10 flag.
 */
private fun vevor(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val preamble = UBytes.of(0xaa, 0xaa, 0xca, 0xca, 0x54)
    val rowBits = bits.bitsPerRow[0]
    var ret = DECODE_FAIL_OTHER
    var pos = 0
    while (true) {
        pos = bits.search(0, pos, preamble, 40)
        if (pos + 264 > rowBits) break
        pos += 40
        if (pos + 21 * 8 > rowBits) { ret = DECODE_ABORT_LENGTH; continue }
        val b = bits.bytes(0, pos, 21 * 8)
        if (addBytes(b, 19) != b[19]) { ret = DECODE_FAIL_MIC; continue }
        if (b[0] == 0xaa && b[1] == 0) {
            var lux = ((b[16] shl 8) or b[17]) - 257
            if (((lux and 0x8000) shr 15) != 0) lux = (lux and 0x7fff) * 10
            ctx.emit(data("model" to "Vevor-7in1", "type" to "Weather", "id" to ((b[2] shl 8) or b[3]), "channel" to (b[1] and 0x0f),
                "battery_ok" to if (((b[4] and 0x80) shr 7) != 0) 0 else 1, "temperature_C" to round1((((b[5] shl 8) or b[6]) - 500) * 0.1),
                "humidity" to b[7], "wind_avg_km_h" to round1((((b[8] shl 8) or b[9]) - 257) / 8.333), "wind_max_km_h" to round1(b[10] / 1.25),
                "wind_dir_deg" to (((b[11] and 0x0f) shl 8) or b[12]) - 257, "rain_mm" to round1((((b[13] shl 8) or b[14]) - 257) * 0.233),
                "uvi" to (b[15] and 0x1f) - 1, "light_lux" to lux, "mic" to "CHECKSUM"))
            return 1
        }
        pos += 264
    }
    return ret
}

/**
 * 8N1 serial behind a two-byte run-in. Upstream's CRC parameters never validate its own sample and it never
 * rejects on them; CRC-16/MODBUS over the same span does, so that is computed and a mic claimed only when it holds.
 */
private fun sainlogic(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    val offset = bits.search(0, 0, UBytes.of(0xfc, 0x95), 16) + 16
    if (offset >= rowBits) return DECODE_ABORT_EARLY
    val b = UBytes(41)
    if (extractBytesUart8n1(bits.bb[0], offset, min(rowBits - offset, b.size * 10), b) < 41) return DECODE_ABORT_LENGTH
    val crcOk = crc16lsb(b, 36, 0xa001, 0xffff, 3) == ((b[39] shl 8) or b[40])
    val out = data("model" to "Sainlogic-SA8", "type" to "Weather",
        "id" to hexBytes(UBytes.of(b[4], b[3], b[6], b[5], b[8], b[7])),     // three little-endian pairs
        "battery_ok" to ((b[38] and 0x10) shr 4), "counter" to ((b[16] shl 8) or b[15]),
        "temperature_C" to round1(s16((b[20] shl 8) or b[19]) * 0.1), "humidity" to b[21],
        "wind_avg_km_h" to round1(((b[30] shl 8) or b[29]) * 0.036), "wind_max_km_h" to round1(((b[28] shl 8) or b[27]) * 0.036),
        "wind_dir_deg" to ((b[32] shl 8) or b[31]), "rain_mm" to round1(((b[34] shl 8) or b[33]) * 0.42893617),
        "unknown" to ((b[36] shl 8) or b[35]),           // possibly a rain-per-hour counter
        "flags" to ((b[38] shl 8) or b[37]),             // reads like battery millivolts, unconfirmed
        "crc_ok" to if (crcOk) 1 else 0)
    if (crcOk) out["mic"] = "CRC"
    ctx.emit(out)
    return 1
}

/** The class byte at the top of the source id says which box in the set is talking. */
private fun bresserGardenModel(sourceId: Long) = when ((sourceId ushr 24).toInt()) {
    0x47 -> "Bresser-SoilMoisture"; 0x1f -> "Bresser-WaterTimer"; 0x01 -> "Bresser-Gateway"; else -> "Bresser-Garden"
}

private val GARDEN_DAY_MODE = listOf("unknown", "every day", "odd days", "even days", "weekly", "unknown", "unknown", "unknown")

/**
 * An irrigation set, two-way and chatty: soil probe, hose valve and gateway. Every frame is target, source,
 * counter, type and length, then a fixed thirty-three bytes ending in a CRC; a reply is the request's type with
 * bit seven set. The model is the sender's, so a gateway ack is a gateway reading. Anything unmapped is still
 * emitted with its payload raw rather than guessed at.
 */
private fun bresserGarden(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_FAIL_SANITY
    val msgLen = bits.bitsPerRow[0]
    // The soil probe's wake-up preamble pushes its frames past 1500 bits; nothing runs longer.
    if (msgLen > 2000) return DECODE_ABORT_LENGTH
    var offset = bits.search(0, 0, UBytes.of(0xaa, 0xf3, 0xe9, 0x10, 0x5e, 0x51), 48)
    if (offset >= msgLen) return DECODE_ABORT_EARLY
    offset += 48
    if (msgLen - offset < 33 * 8) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, offset, 33 * 8)
    if (crc16(b, 33, 0x1021, 0xd636) != 0) return DECODE_FAIL_MIC
    val targetId = u32le(b, 0)
    val sourceId = u32le(b, 4)
    val counter = b[8]
    val msgType = b[9]
    val msgLength = b[10]
    val ack = msgType shr 7
    val model = bresserGardenModel(sourceId)
    // The payload runs b[11]..b[30]; a longer declared length cannot be real whatever the CRC says.
    if (msgLength > 20) return DECODE_FAIL_SANITY
    fun payloadHex() = hexBytes(b, min(msgLength, 20), 11)
    fun base(name: String, vararg kv: Pair<String, Any?>): R433Data {
        val out = data("model" to model, "type" to "Weather", "id" to sourceId, "msg_counter" to counter, "mic" to "CRC", "msg_name" to name)
        for ((k, v) in kv) out[k] = v
        return out
    }
    fun le16(at: Int) = b[at] or (b[at + 1] shl 8)
    fun emit(out: R433Data): Int { ctx.emit(out); return 1 }

    // Init and pairing announce, at power-up and periodically.
    if (msgType == 0x01 && (msgLength == 0x07 || msgLength == 0x08))
        return emit(base("Init Pairing", "target_id" to targetId, "device_type" to b[11], "firmware" to b[17], "msg_type" to msgType,
            "msg_length" to msgLength, "msg" to payloadHex()))
    if (msgType == 0x81 && msgLength == 0x10)
        return emit(base("Pairing ack", "target_id" to targetId, "acknowledgement" to ack, "msg_type" to msgType, "msg_length" to msgLength,
            "msg" to payloadHex()))
    // Probe straight to the gateway with relaying off: the relayed block minus address and spacer, two bytes earlier.
    if (msgType == 0x03 && msgLength == 0x07)
        return emit(base("Soil telemetry", "station_id" to targetId, "device_type" to b[11], "msg_type" to msgType,
            "temperature_F" to round1(s16((b[17] shl 8) or b[16]) * 0.1), "moisture" to b[14],
            "battery_ok" to if (((b[12] and 0x10) shr 4) != 0) 0 else 1, "battery_level" to (b[12] and 0x0f)))
    if ((msgType == 0x83 || msgType == 0x84 || msgType == 0x89 || msgType == 0x8a) && msgLength == 0x01)
        return emit(base("Acknowledgement", "target_id" to targetId, "acknowledgement" to ack, "msg_type" to msgType, "msg_length" to msgLength))
    // The valve relaying the probe, with the signal strength it measured inserted at b[13].
    if (msgType == 0x0a && msgLength == 0x09)
        return emit(base("Relay telemetry", "station_id" to targetId, "device_type" to b[11], "sensor_number" to b[12], "msg_type" to msgType,
            "temperature_F" to round1(s16((b[19] shl 8) or b[18]) * 0.1), "moisture" to b[16], "soil_rssi" to b[13],
            "battery_ok" to if (((b[14] and 0x10) shr 4) != 0) 0 else 1, "battery_level" to (b[14] and 0x0f)))
    if (msgType == 0x09 && msgLength == 0x09)
        return emit(base("Soil telemetry", "station_id" to targetId, "device_type" to b[11], "sensor_number" to b[12], "msg_type" to msgType,
            "temperature_F" to round1(s16((b[19] shl 8) or b[18]) * 0.1), "moisture" to b[16],
            "battery_ok" to if (((b[14] and 0x10) shr 4) != 0) 0 else 1, "battery_level" to (b[14] and 0x0f)))
    // A run that delivered water; scheduled slots are skipped while the soil is wet enough.
    if (msgType == 0x04 && msgLength == 0x0e)
        return emit(base("Watering", "station_id" to targetId, "sensor_number" to b[11], "msg_type" to msgType,
            "programme" to ((b[14] shl 8) or b[15]), "cycle_counter" to le16(16), "trigger" to b[18],
            "water_usage_l" to round1(le16(19) * 0.1),   // metered, not computed from run time
            "duration_s" to le16(23)))                   // wall clock, so misting pauses count
    if (msgType == 0x85 && msgLength == 0x0f)
        return emit(base("Schedule config", "target_id" to targetId, "sensor_number" to b[18], "msg_type" to msgType,
            "default_duration_s" to le16(12), "mist_run_s" to le16(14), "mist_interval_s" to le16(16), "stop_moisture" to b[19],
            "flow_rate" to signed(b[24], 8), "unknown" to b[22]))
    if (msgType == 0x20 && (msgLength == 0x02 || msgLength == 0x03)) {
        val out = base("Config change", "target_id" to targetId, "msg_type" to msgType, "config_counter" to b[11])
        if (msgLength == 0x03 && b[12] == 0x04) out["rf_channel"] = b[13]
        return emit(out)
    }
    // The watering plan table, seven bytes a plan, paged when it does not fit.
    if (msgType == 0x86 && (msgLength == 0x08 || msgLength == 0x0f)) {
        val plans = ArrayList<R433Data>()
        val nPlans = (msgLength - 1) / 7
        var p = 0
        while (p < nPlans && plans.size < 2 && (12 + p * 7 + 6) < 33) {
            val at = 12 + p * 7
            plans.add(data("model" to model, "plan" to plans.size + 1, "enabled" to if ((b[at] and 0x80) != 0) 1 else 0,
                "irrigation" to if ((b[at + 2] and 0x80) != 0) "misting" else "normal",
                "start_hour" to (((b[at + 2] and 0x07) shl 2) or (b[at + 1] shr 6)), "start_minute" to (b[at + 1] and 0x3f),
                "day_mode" to GARDEN_DAY_MODE[(b[at + 2] shr 3) and 0x07], "weekday_mask" to (b[at] and 0x7f),
                "duration_s" to le16(at + 3), "water_limit_l" to round1(le16(at + 5) / 10.0)))
            p++
        }
        return emit(base("Schedule", "target_id" to targetId, "msg_type" to msgType, "more_parts" to if (b[11] != 0) 1 else 0, "plans" to plans))
    }
    // A run command, or the keep-alive that shares its type.
    if (msgType == 0x21 && msgLength >= 0x03) {
        val variant = b[12]; val mode = b[13]
        var durationS = if (msgLength >= 0x04) b[14] else 0
        if (msgLength >= 0x05) durationS = durationS or (b[15] shl 8)
        val isRun = variant == 0x02
        val out = base(if (!isRun) "Heartbeat" else if (mode == 0) "Run stop" else "Run start", "target_id" to targetId, "msg_type" to msgType)
        if (isRun) out["mode"] = mode
        if (isRun && msgLength >= 0x04) out["duration_s"] = durationS
        if (!isRun && msgLength >= 0x04) out["heartbeat_interval_s"] = durationS
        out["msg"] = payloadHex()
        return emit(out)
    }
    if (msgType == 0xa1 || msgType == 0xa0) {
        val hasRun = msgType == 0xa1 && msgLength >= 0x0d && b[13] == 0x9f && b[18] == 0x81 && b[21] == 0xad
        val out = base(if (msgType == 0xa0) "Acknowledgement" else if (hasRun) "Run response" else "Beacon",
            "target_id" to targetId, "msg_type" to msgType, "acknowledgement" to ack)
        if (hasRun) {
            out["trigger"] = b[12]; out["duration_s"] = le16(22); out["remaining_s"] = le16(19)
            out["water_usage_l"] = round1(le16(14) * 0.1)        // the last completed run, not this one
        }
        out["msg"] = payloadHex()
        return emit(out)
    }
    if (msgType == 0x82 && msgLength >= 0x02) {
        val out = base("Status response", "target_id" to targetId, "msg_type" to msgType, "config_counter" to b[12])
        // Cloud-disciplined and seconds-scale, so it jumps and wraps; not a wall clock.
        if (msgLength >= 0x05) out["gateway_time"] = b[13] or (b[14] shl 8) or (b[15] shl 16)
        out["msg"] = payloadHex()
        return emit(out)
    }
    if (msgType == 0x88 && msgLength >= 0x03)
        return emit(base("Moisture response", "target_id" to targetId, "msg_type" to msgType, "moisture" to b[13], "msg" to payloadHex()))
    if (msgType == 0x02 || msgType == 0x05 || msgType == 0x06 || msgType == 0x08) {
        val hasRun = msgType == 0x02 && msgLength >= 0x0f && b[20] == 0x81 && b[23] == 0xad
        val name = when (msgType) { 0x02 -> "Status report"; 0x05 -> "Config request"; 0x08 -> "Moisture request"; else -> "Schedule request" }
        val out = base(name, "target_id" to targetId, "msg_type" to msgType, "msg_length" to msgLength)
        if (hasRun) {
            out["trigger"] = b[14]; out["duration_s"] = le16(24); out["remaining_s"] = le16(21)
            out["water_usage_l"] = round1(le16(16) * 0.1)
        }
        out["msg"] = payloadHex()
        return emit(out)
    }
    return emit(base("Unknown msg", "target_id" to targetId, "acknowledgement" to ack, "msg_type" to msgType, "msg_length" to msgLength,
        "msg" to payloadHex()))
}

private fun u32le(b: UBytes, at: Int): Long = b[at].toLong() or (b[at + 1].toLong() shl 8) or (b[at + 2].toLong() shl 16) or (b[at + 3].toLong() shl 24)

internal val WEATHER5: List<RDevice> = listOf(
    dev(134, "AOK Weather Station rebrand Holman Industries iWeather WS5029, Conrad AOK-5056, Optex 990018", Mod.FSK_PCM, 100, 100, 19200,
        bands = listOf(917_000_000L), what = "weather station: temperature, humidity, rain, wind, and UV on some builds", decode = ::holmanPcm),
    dev(143, "Holman Industries iWeather WS5029 weather station (older PWM)", Mod.FSK_PWM, 488, 976, 6000, gapLimit = 2000, bands = BAND_433,
        what = STATION, decode = ::holmanPwm),
    dev(340, "Holman Industries iWeather WS5029 weather station (older PWM, OOK), BIOWIN 270208", Mod.OOK_PWM, 488, 976, 6000, gapLimit = 2000,
        bands = BAND_433, what = STATION, decode = ::holmanPwm),
    dev(153, "Cotech 36-7959, SwitchDocLabs FT020T wireless weather station with USB", Mod.OOK_MANCHESTER_ZEROBIT, 500, 0, 1200, gapLimit = 1200,
        bands = BAND_433, what = "weather station: temperature, humidity, rain, wind, light and UV", decode = ::cotech367959),
    dev(369, "Cotech FT0203/18-3676 anemometer", Mod.OOK_MANCHESTER_ZEROBIT, 500, 0, 1200, disabled = true, bands = BAND_433,
        what = "anemometer: wind speed, gust and direction", decode = ::cotechFt0203),
    dev(382, "Cotech 36-7900 rain gauge", Mod.OOK_PPM, 1000, 2000, 4500, gapLimit = 3500, disabled = true, bands = BAND_433,
        what = "rain gauge with a thermometer", decode = ::cotech367900),
    dev(263, "Vevor Wireless Weather Station 7-in-1", Mod.FSK_PCM, 87, 87, 9000, bands = BAND_VEVOR,
        what = "weather station: temperature, humidity, rain, wind, light and UV", decode = ::vevor),
    dev(293, "Sainlogic SA8, Gevanti SA8 Weather Station", Mod.OOK_PCM, 200, 200, 2500, bands = BAND_433, what = STATION, decode = ::sainlogic),
    dev(384, "Bresser SmartHome Garden soil moisture and water timer valve (Baldr Homgar, RainPoint)", Mod.FSK_PCM, 50, 50, 10000,
        bands = BAND_GARDEN, what = "garden irrigation set: soil moisture, water timer valve and gateway", decode = ::bresserGarden),
)
