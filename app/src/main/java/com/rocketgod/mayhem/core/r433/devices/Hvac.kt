package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Heating, fans and the Govee 912 MHz family: Watts thermostats, Eberle Instat, Regency and UniFan fan remotes,
 * and the Govee pool thermometer, dual-probe thermometer and leak detector.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): watts_thermostat.c, watts_wfht_rf.c, watts_vision.c,
 * eberle_instat868r1.c, regency_fan.c, universal_fan_controller.c, govee_h5310.c, govee_h5112.c, govee_h5059.c.
 * Twin of web/src/dsp/r433/devices/hvac.ts.
 */

private val B433 = listOf(433_920_000L)
private val B868 = listOf(868_300_000L)

/**
 * Inverted, and every field bit-reversed within its own bytes, so each is reflected separately: the nine-bit
 * temperatures straddle bytes and no whole-frame reflection would put them right. The sum is narrowed to a byte
 * exactly as upstream's uint8_t does.
 */
private fun wattsThermostat(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    bits.invert()
    if (bits.bitsPerRow[0] != 54) return DECODE_ABORT_LENGTH
    if (bits.bytes(0, 0, 8)[0] != 0xa5) return DECODE_ABORT_EARLY
    val idRaw = bits.bytes(0, 8, 16); reflectBytes(idRaw, 2)
    val id = (idRaw[1] shl 8) or idRaw[0]
    val flags = bits.bytes(0, 24, 4); reflectBytes(flags, 1)
    val tempRaw = bits.bytes(0, 28, 9); reflectBytes(tempRaw, 2)
    val temp = (tempRaw[1] shl 8) or tempRaw[0]
    val setpRaw = bits.bytes(0, 37, 9); reflectBytes(setpRaw, 2)
    val setp = (setpRaw[1] shl 8) or setpRaw[0]
    val chk = bits.bytes(0, 46, 8); reflectBytes(chk, 1)
    val sum = (addBytes(idRaw, 2) + addBytes(flags, 1) + addBytes(tempRaw, 2) + addBytes(setpRaw, 2)) and 0xff
    if (chk[0] != sum) return DECODE_FAIL_MIC
    if (id == 0 && flags[0] == 0 && temp == 0 && setp == 0 && chk[0] == 0) return DECODE_ABORT_EARLY
    ctx.emit(data("model" to "Watts-WFHTRF", "type" to "thermostat", "id" to id.toString(), "pairing" to (flags[0] and 1),
        "temperature_C" to round1(temp * 0.1), "setpoint_C" to round1(setp * 0.1),
        "flags" to flags[0],                             // only bit zero, pairing, has been identified
        "mic" to "CHECKSUM"))
    return 1
}

/**
 * A CC1101 frame with an application checksum underneath: a CRC-8 xored with a constant and then the
 * call-for-heat byte, covering it without it being in range. Only 0 or 100 per cent ever reaches the air.
 */
private fun wattsLcd(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] < 32 + 128) return DECODE_ABORT_LENGTH
    val offset = bits.search(0, 0, UBytes.of(0xd3, 0x91, 0xd3, 0x91), 32) + 32
    if (offset + 128 > bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, offset, 128)
    if (b[0] != 0x0d) return DECODE_ABORT_EARLY
    if (b[1] != 0xff || b[2] != 0xff || b[3] != 0xfe) return DECODE_ABORT_EARLY
    if ((b[4] and 0xfc) != 0) return DECODE_FAIL_SANITY
    if (b[5] == 0 && b[6] == 0 && b[7] == 0) return DECODE_FAIL_SANITY
    if (((crc8(b, 12, 0xe6, 0x00) xor 0xbe xor b[12]) and 0xff) != b[13]) return DECODE_FAIL_MIC
    if (crc16(b, 14, 0x8005, 0xffff) != (((b[14] shl 8) or b[15]) and 0xffff)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Watts-WFHTLCDRF", "type" to "thermostat", "id" to "${hexOf(b[5])}:${hexOf(b[6])}:${hexOf(b[7])}".uppercase(),
        "mode" to if ((b[4] and 0x02) != 0) "heat" else "cool", "pairing" to if ((b[4] and 0x01) != 0) "true" else "false",
        "temperature_C" to round1(signed((b[8] shl 8) or b[9], 16) / 10.0), "setpoint_C" to round1(signed((b[10] shl 8) or b[11], 16) / 10.0),
        "call_for_heat" to if (b[12] == 0x64) 100 else 0, "mic" to "CRC"))
    return 1
}

private val VISION_SETPOINT_MODE = mapOf(0x00 to "Comfort", 0x01 to "Off", 0x02 to "Anti-freeze", 0x03 to "Reduced/ECO",
    0x04 to "Boost/Timer", 0x08 to "Auto (Comfort phase)", 0x0b to "Auto (Reduced phase)", 0x10 to "Manual/Temporary")
private val VISION_SENSOR_MODE = listOf("Amb", "FLR", "FLL", "Air")
/** The sensor saying it has nothing to report, not 212.4 °F. */
private const val VISION_TEMP_UNAVAILABLE = 0x084c

/**
 * Tag-and-value records whose value length lives in the tag's top two bits, so the stream can be walked without
 * knowing what any tag means. The setpoint tag reports the target for one named bank, not "the" target.
 */
private fun wattsVision(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val rowLen = bits.bitsPerRow[0]
    var bitpos = bits.search(0, 0, UBytes.of(0xaa, 0xd3, 0x91, 0xd3, 0x91), 40)
    if (bitpos >= rowLen) return DECODE_ABORT_EARLY
    bitpos += 40
    if (bitpos + 8 > rowLen) return DECODE_ABORT_LENGTH
    val length = bits.bytes(0, bitpos, 8)[0]
    // Twenty is a command from the base, thirty-four a status report from an endpoint.
    if (length != 0x14 && length != 0x22) return DECODE_ABORT_EARLY
    val totalBits = (length + 3) * 8
    if (bitpos + totalBits > rowLen) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, bitpos, totalBits)
    // The application's checksum, LSB first, then the radio's over everything including it.
    if (crc16lsb(b, length - 2, 0xa001, 0xffff, 1) != (((b[length] shl 8) or b[length - 1]) and 0xffff)) return DECODE_FAIL_MIC
    if (crc16(b, length + 1, 0x8005, 0xffff) != (((b[length + 1] shl 8) or b[length + 2]) and 0xffff)) return DECODE_FAIL_MIC
    if (b[5] != 0xc6) return DECODE_FAIL_SANITY
    val out = data("model" to "Watts-Vision", "type" to "thermostat", "id" to hexOf(u32be(b, 1), 8), "dest" to hexOf(u32be(b, 6), 8),
        "msg_type" to if (length == 0x14) "command" else "status")
    val recordsLen = length - 11
    var pos = 0
    while (pos < recordsLen) {
        val tag = b[10 + pos]
        if (tag == 0x00) break
        val valueLen = (tag shr 6) + 1
        if (pos + 1 + valueLen > recordsLen) break
        val v = b.sub(10 + pos + 1)
        fun be16(at: Int) = (v[at] shl 8) or v[at + 1]
        when (tag) {
            0x03 -> out["association_id"] = v[0]
            0xdf -> out["state_raw"] = hexBytes(v, 4)
            0x3b -> out["flags_raw"] = v[0]
            0x8d -> { out["report_flags_0"] = v[0]; out["report_flags_1"] = v[1]; out["report_flags_2"] = v[2] }
            0x8a -> {
                if (be16(0) != VISION_TEMP_UNAVAILABLE) out["mode_setpoint_F"] = round1(be16(0) / 10.0)
                out["setpoint_mode"] = VISION_SETPOINT_MODE[v[2]] ?: "unknown"
            }
            0x4b -> if (be16(0) != VISION_TEMP_UNAVAILABLE) out["temperature_F"] = round1(be16(0) / 10.0)
            0x5e -> if (be16(0) != VISION_TEMP_UNAVAILABLE) out["temperature_2_F"] = round1(be16(0) / 10.0)
            0xcc -> {
                // A limit of zero is switched off, not a floor held at freezing.
                if (be16(0) != 0) out["floor_limit_1_F"] = round1(be16(0) / 10.0)
                if (be16(2) != 0) out["floor_limit_2_F"] = round1(be16(2) / 10.0)
            }
            0x8e -> {
                // Plain whole degrees Celsius, unlike every other temperature in the frame.
                out["setpoint_min_C"] = v[0]; out["setpoint_max_C"] = v[1]
                out["sensor_mode"] = VISION_SENSOR_MODE[v[2] and 3]; out["sensor_flags_raw"] = v[2]
            }
            0x4c -> { out["diagnostic_code"] = v[0]; out["diagnostic_flags"] = v[1] }
        }
        pos += 1 + valueLen
    }
    out["mic"] = "CRC"
    ctx.emit(out)
    return 1
}

/** Each button's code when the remote's own id is odd, then when it is even. */
private val EBERLE_ACTIONS = listOf(Triple("Learn", 0x3, 0xc), Triple("Reset", 0xb, 0x4), Triple("On", 0xe, 0x1), Triple("Off", 0x5, 0xa))

/**
 * Twenty-four bits read two ways at once: as LSB-first nibbles for a checksum that always sums to eleven, and
 * Gray-decoded then complemented for the fields. Upstream never clears its decode buffer between attempts, so a
 * retry after a failed checksum cannot succeed; ported as written.
 */
private fun eberle(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 30 + 50) return DECODE_ABORT_LENGTH
    val pre = UBytes.of(0x00, 0x0f, 0xe0, 0x30)
    val rowLen = bits.bitsPerRow[0]
    val decoded = BitBuffer()
    var searchStart = 0; var micOk = false
    while (searchStart + 30 + 50 <= rowLen) {
        val pos = bits.search(0, searchStart, pre, 30)
        if (pos + 30 + 50 > rowLen) break
        bits.differentialManchesterDecode(0, pos + 30, decoded, 25)
        if (decoded.bitsPerRow[0] < 25) { searchStart = pos + 30 + 1; continue }
        var checksum = 0
        val b = decoded.bb[0]
        for (n in 0 until 6) for (i in 0 until 4) if (bitAt(b, 1 + n * 4 + i) != 0) checksum += 1 shl i
        if ((checksum and 0xf) != 0xb) { searchStart = pos + 30 + 1; continue }
        micOk = true
        break
    }
    if (!micOk) return DECODE_FAIL_MIC
    val b = decoded.bb[0]
    val gray = IntArray(24)
    var prev = bitAt(b, 1)
    gray[0] = if (prev != 0) 0 else 1
    for (i in 1 until 24) { prev = prev xor bitAt(b, 1 + i); gray[i] = if (prev != 0) 0 else 1 }
    val nib = IntArray(6) { n -> var v = 0; for (i in 0 until 4) v = (v shl 1) or gray[n * 4 + i]; v }
    val id = (nib[0] shl 8) or (nib[1] shl 4) or nib[2]
    val action = nib[3]
    val command = EBERLE_ACTIONS.firstOrNull { action == if ((id and 1) != 0) it.second else it.third }?.first ?: "Unknown"
    ctx.emit(data("model" to "Eberle-Instat868r1", "type" to "remote", "id" to hexOf(id, 3), "command" to command,
        "action_code" to hexOf(action, 1),
        // A fixed marker for Learn and Reset, a counter stepping down per press for On and Off.
        "data" to hexOf(nib[4], 1), "mic" to "CHECKSUM"))
    return 1
}

private val REGENCY_COMMANDS = mapOf(1 to "fan_speed", 2 to "fan_speed", 4 to "light_intensity", 5 to "light_delay", 6 to "fan_direction")

/**
 * A four-bit checksum backed by four matching repeats and per-command value bounds. Upstream's prose says PPM but
 * its device table registers PWM, and the table is what slices.
 */
private fun regency(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    val row = bits.findRepeatedRow(4, 21)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 21) return DECODE_ABORT_LENGTH
    val b = bits.bytes(row, 1, 20)
    reflectBytes(b, 3)
    if ((addNibbles(b, 2) and 0x0f) != b[2]) return DECODE_FAIL_MIC
    val command = b[0] shr 4
    val value = b[1]
    val valueString = when (command) {
        1 -> "stop"
        2 -> if (value < 0x01 || value > 0x07) return DECODE_FAIL_SANITY else "speed $value"
        4 -> if (value > 0xc3) return DECODE_FAIL_SANITY else "$value %"
        5 -> if (value != 0x00 && value != 0x01) return DECODE_FAIL_SANITY else if (value == 0) "off" else "on"
        6 -> if (value != 0x07 && value != 0x83) return DECODE_FAIL_SANITY else if (value == 0x07) "clockwise" else "counter-clockwise"
        else -> return DECODE_FAIL_SANITY
    }
    ctx.emit(data("model" to "Regency-Remote", "type" to "remote",
        "channel" to (b[0].inv() and 0x0f),             // compartment switches read inverted
        "command" to REGENCY_COMMANDS[command], "value" to valueString, "mic" to "CHECKSUM"))
    return 1
}

private val UNIFAN_BUTTONS = mapOf(0x19 to "All Off", 0x17 to "Light On/Off", 0x1b to "Forward", 0x0a to "Fan", 0x0e to "Reverse",
    0x09 to "Fan Off", 0x0f to "Speed 1", 0x0d to "Speed 2", 0x03 to "Speed 3", 0x15 to "Speed 4", 0x10 to "Speed 5", 0x13 to "speed 6",
    0x1d to "1H", 0x16 to "2H", 0x06 to "3H")

/** The check nibble sits inside its own xor, and the result's nibbles fold to ten. The last of 33 bits is always one. */
private fun unifan(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(3, 33)
    if (row < 0) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if ((b[4] and 0x80) == 0) return DECODE_FAIL_SANITY
    val x = xorBytes(b, 4)
    if ((((x shr 4) xor (x and 0xf)) and 0xf) != 0xa) return DECODE_FAIL_MIC
    val address = (b[0] shl 12) + (b[1] shl 4) + (b[2] shr 4)
    val button = ((b[2] and 0x0f) shl 1) + ((b[3] and 0x80) shr 7)
    ctx.emit(data("model" to "UniFan-24V", "type" to "remote", "id" to address.toString(), "button" to (UNIFAN_BUTTONS[button] ?: "Unknown"),
        "button_code" to button, "counter" to ((b[3] and 0x7f) shr 4), "mic" to "CHECKSUM"))
    return 1
}

/** The 902-928 MHz band the family shares with its gateway. */
private val GOVEE_BANDS = listOf(912_000_000L, 915_000_000L)
private val GOVEE_SYNC = UBytes.of(0x2c, 0x4c, 0x4a)
/** The same sync one bit late, as it arrives when the demodulator locks a bit off. */
private val GOVEE_SYNC_SKEW1 = UBytes.of(0x16, 0x26, 0x25)
/**
 * Recovered from a leak detector's firmware and shared by the family: a fixed string xored over the payload
 * from an offset the frame carries. It hides the payload from a casual look and nothing else.
 */
private const val GOVEE_KEY = "s6amyEvO8UslCY0eZjgc2S6APCVLgLxzFvL2Z5GWPW7fKVjy2oAU6uiKU3lZCHm62VYQQuCtgxzPgGd8UDRPVZpDRAsh5EdYq1E4j4morJ3vd6tWx8BiWOLDc2I8wKUK"
private const val GOVEE_MAX_FRAME = 128

private class GoveeFrame(val frame: UBytes, val bytesAfterSync: Int)

/** The sync word in any row, and the bytes behind it; a negative decode result if there is none. */
private fun goveeFindFrame(bits: BitBuffer): Any {
    var row = -1; var syncPos = 0
    for (r in 0 until bits.numRows) {
        if (bits.bitsPerRow[r] < 8 * 7) continue
        val pos = bits.search(r, 0, GOVEE_SYNC, 24)
        if (pos < bits.bitsPerRow[r]) { row = r; syncPos = pos; break }
        val skew = bits.search(r, 0, GOVEE_SYNC_SKEW1, 24)
        if (skew < bits.bitsPerRow[r]) { row = r; syncPos = skew + 1; break }
    }
    if (row < 0) return DECODE_ABORT_EARLY
    syncPos += 24
    val bitsAfter = bits.bitsPerRow[row] - syncPos
    if (bitsAfter < 32) return DECODE_ABORT_LENGTH
    val n = minOf(bitsAfter shr 3, GOVEE_MAX_FRAME)
    return GoveeFrame(bits.bytes(row, syncPos, n * 8), n)
}

private fun goveeDecrypt(frame: UBytes, encLen: Int): UBytes? {
    val crcRecv = ((frame[2 + encLen] shl 8) or frame[3 + encLen]) and 0xffff
    if (crc16(frame, encLen, 0x1021, 0x1d0f, 2) != crcRecv) return null
    val seed = frame[1]
    val dec = UBytes(encLen)
    for (i in 0 until encLen) dec[i] = frame[2 + i] xor GOVEE_KEY[(i + seed) % 128].code
    return dec
}

/** The wire address and the same address with its halves swapped. */
private fun goveeIds(out: R433Data, dec: UBytes, at: Int) {
    val wire = u32be(dec, at)
    out["id"] = hexOf(((wire and 0xffffL) shl 16) or ((wire ushr 16) and 0xffffL), 8)
    out["id_wire"] = hexOf(wire, 8)
}

/**
 * Three frame shapes by outer length; the forced report has an extra constant byte that shifts everything after
 * it by one. The reply collides with the dual-probe thermometer and is settled by two constants that would mean
 * impossible humidity there. Below freezing is unverified.
 */
private fun goveeH5310(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val found = goveeFindFrame(bits)
    if (found !is GoveeFrame) return found as Int
    val frame = found.frame
    val outerLen = frame[0]
    val isTemp = outerLen == 0x10; val isPeriodic = outerLen == 0x3d; val isStatus = outerLen == 0x1f
    if (!isTemp && !isPeriodic && !isStatus) return DECODE_ABORT_EARLY
    if (found.bytesAfterSync < 1 + outerLen) return DECODE_ABORT_LENGTH
    val dec = goveeDecrypt(frame, outerLen - 3) ?: return DECODE_FAIL_MIC
    val marker = if (isTemp) 0x11 else if (isPeriodic) 0x1b else 0x71
    if (dec[0] != marker) return DECODE_ABORT_EARLY
    val at = if (isTemp) 6 else 5
    if (isStatus && (dec[8] != 0xcc || dec[9] != 0xff)) return DECODE_ABORT_EARLY
    val batteryPct = dec[at]
    val temperatureC = ((dec[at + 1] or (dec[at + 2] shl 8)) - 33168) / 10.0
    // Other family members can pass the checks above; a reading no pool could be at turns them away.
    if (temperatureC < -20 || temperatureC > 60) return DECODE_FAIL_SANITY
    val out = data("model" to "Govee-H5310", "type" to "thermometer")
    goveeIds(out, dec, 1)
    out["event"] = if (isTemp) "Temperature Update" else if (isPeriodic) "Periodic Update" else "Status"
    out["battery_ok"] = if (batteryPct > 0) 1 else 0
    out["battery_pct"] = batteryPct
    out["temperature_C"] = round1(temperatureC)
    out["mic"] = "CRC"
    ctx.emit(out)
    return 1
}

/**
 * Two eleven-bit probes and ten-bit humidity packed into one little-endian word, a layout read from the firmware's
 * own packing routine; the frame also carries its last ten minutes in the same packing, reported as arrays.
 */
private fun goveeH5112(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val found = goveeFindFrame(bits)
    if (found !is GoveeFrame) return found as Int
    val frame = found.frame
    val outerLen = frame[0]
    if (outerLen < 4 || outerLen > GOVEE_MAX_FRAME - 1) return DECODE_FAIL_SANITY
    if (found.bytesAfterSync < 1 + outerLen) return DECODE_ABORT_LENGTH
    val encLen = outerLen - 3
    if (encLen < 10 || encLen > GOVEE_MAX_FRAME) return DECODE_ABORT_EARLY
    val dec = goveeDecrypt(frame, encLen) ?: return DECODE_FAIL_MIC
    val msgClass = dec[0]
    when (msgClass) {
        0x13 -> if (encLen != 57) return DECODE_ABORT_EARLY
        0x71 -> if (encLen != 28) return DECODE_ABORT_EARLY
        else -> return DECODE_ABORT_EARLY
    }
    fun packed(at: Int) = dec[at].toLong() or (dec[at + 1].toLong() shl 8) or (dec[at + 2].toLong() shl 16) or (dec[at + 3].toLong() shl 24)
    fun t1(p: Long) = ((p ushr 11) and 0x7ff).toInt()
    fun t2(p: Long) = (p and 0x7ff).toInt()
    fun h(p: Long) = ((p ushr 22) and 0x3ff).toInt()
    val live = packed(6)
    val humidity = h(live) / 10.0
    // Air cannot hold this much; the pool thermometer's constants land here at 102.3 per cent.
    if (humidity > 100) return DECODE_FAIL_SANITY
    val out = data("model" to "Govee-H5112", "type" to "thermometer")
    goveeIds(out, dec, 1)
    out["battery_ok"] = if (dec[5] > 0) 1 else 0
    out["battery_pct"] = dec[5]
    out["temperature_C"] = round1(t1(live) / 10.0 - 40)
    out["temperature_2_C"] = round1(t2(live) / 10.0 - 40)
    out["humidity"] = round1(humidity)
    if (msgClass == 0x13 && encLen >= 17 + 40) {
        val recs = (0 until 10).map { packed(17 + it * 4) }
        out["temperature_C_history"] = recs.map { round1(t1(it) / 10.0 - 40) }
        out["temperature_2_C_history"] = recs.map { round1(t2(it) / 10.0 - 40) }
        out["humidity_history"] = recs.map { round1(h(it) / 10.0) }
    }
    out["mic"] = "CRC"
    ctx.emit(out)
    return 1
}

private val GOVEE_H5059_SUBTYPES = mapOf(0x05 to "Button Press", 0x06 to "Water Leak", 0x07 to "Post Alarm")

/**
 * The device the family's protocol was reverse engineered from. A leak needs the alarm byte with either probe
 * (an earlier upstream version missed top-probe leaks). The follow-up frame covers both drying and a silenced
 * alarm, so no dryness is claimed.
 */
private fun goveeH5059(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val found = goveeFindFrame(bits)
    if (found !is GoveeFrame) return found as Int
    val frame = found.frame
    val outerLen = frame[0]
    if (outerLen < 4 || outerLen > GOVEE_MAX_FRAME - 1) return DECODE_FAIL_SANITY
    if (found.bytesAfterSync < 1 + outerLen) return DECODE_ABORT_LENGTH
    // Upstream decrypts into a sixty-four byte buffer, so longer is refused.
    val encLen = outerLen - 3
    if (encLen < 8 || encLen > 64) return DECODE_FAIL_SANITY
    val dec = goveeDecrypt(frame, encLen) ?: return DECODE_FAIL_MIC
    if (encLen < 19) return DECODE_FAIL_SANITY
    val msgClass = dec[0]
    val subtype = dec[13]; val leakTop = dec[14]; val leakBottom = dec[15]; val leakAlarm = dec[17]
    var wet = -1
    val event = when (msgClass) {
        0x11 -> when {
            subtype == 0x05 -> { wet = 0; GOVEE_H5059_SUBTYPES[0x05]!! }
            subtype == 0x06 && leakAlarm != 0 && (leakTop == 1 || leakBottom == 1) -> { wet = 1; GOVEE_H5059_SUBTYPES[0x06]!! }
            subtype == 0x07 -> GOVEE_H5059_SUBTYPES[0x07]!!
            else -> "Telemetry"
        }
        0x01 -> "Pairing"
        0x02 -> "Class 0x02"
        else -> return DECODE_ABORT_EARLY
    }
    val out = data("model" to "Govee-H5059", "type" to "leak detector")
    goveeIds(out, dec, 1)
    out["event"] = event; out["msg_class"] = msgClass; out["subtype"] = subtype; out["mic"] = "CRC"
    if (wet >= 0) out["detect_wet"] = wet
    if (wet == 1) { out["leak_top"] = if (leakTop == 1) 1 else 0; out["leak_bottom"] = if (leakBottom == 1) 1 else 0 }
    ctx.emit(out)
    return 1
}

private const val FAN = "ceiling fan remote control"

internal val HVAC: List<RDevice> = listOf(
    dev(253, "Watts WFHT-RF Thermostat", Mod.OOK_PWM, 260, 600, 900, syncWidth = 6000, bands = B433, what = "room thermostat", decode = ::wattsThermostat),
    dev(348, "Watts WFHT-RF / WFHC-MASTERH&C-RF underfloor heating thermostat", Mod.OOK_MANCHESTER_ZEROBIT, 460, 0, 900, bands = B433,
        what = "underfloor heating thermostat", decode = ::wattsLcd),
    dev(366, "Watts Vision thermostat (-f 868.3M)", Mod.FSK_PCM, 26, 26, 1000, bands = B868, what = "thermostat and heating zone controller", decode = ::wattsVision),
    dev(358, "Eberle Instat 868r1 floor heating thermostat remote", Mod.FSK_PCM, 400, 400, 8000, bands = B868, what = "floor heating remote control", decode = ::eberle),
    dev(211, "Regency Ceiling Fan Remote (-f 303.75M to 303.96M)", Mod.OOK_PWM, 580, 976, 14000, gapLimit = 8000, bands = listOf(303_900_000L),
        what = FAN, decode = ::regency),
    dev(286, "Universal (Reverseable) 24V Fan Controller", Mod.OOK_PWM, 256, 756, 8800, gapLimit = 8000, syncWidth = 3616, bands = B433,
        what = FAN, decode = ::unifan),
    dev(349, "Govee Pool/Spa Thermometer H5310", Mod.FSK_PCM, 100, 100, 2000, bands = GOVEE_BANDS, what = "pool and spa thermometer", decode = ::goveeH5310),
    // After the pool thermometer, before the leak detector.
    dev(350, "Govee H5112 Dual-Probe Thermometer", Mod.FSK_PCM, 100, 100, 2000, priority = 5, bands = GOVEE_BANDS,
        what = "dual probe thermometer and hygrometer", decode = ::goveeH5112),
    // The loosest of the three, so it runs last.
    dev(300, "Govee Water Leak Detector H5059", Mod.FSK_PCM, 100, 100, 2000, priority = 10, bands = GOVEE_BANDS, what = "water leak detector", decode = ::goveeH5059),
)
