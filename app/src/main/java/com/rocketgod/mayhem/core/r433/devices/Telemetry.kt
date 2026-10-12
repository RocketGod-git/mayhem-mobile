package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Telemetry: Steelmate TPMS, RadioHead ASK and the Sensible Living probe, Digitech XC-0324, Companion WTR001,
 * Telldus FT0385R, ANT / ANT+, Shenzhen Wale WL-TH6R, Gear Hive TPMS and the FSL cricket scoreboard.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): steelmate.c, radiohead_ask.c, digitech_xc0324.c, companion_wtr001.c,
 * telldus_ft0385r.c, ant_antplus.c, shenzhen_wale_wl_th6r.c, tpms_gearhive.c, fsl_scoreboard.c. Twin of
 * web/src/dsp/r433/devices/telemetry.ts.
 */

private val TPMS_BANDS = listOf(315_000_000L, 433_920_000L)
private val B433 = listOf(433_920_000L)

private val STEELMATE_PRE = UBytes.of(0x00, 0x00, 0x7f)

/**
 * Inverted Manchester with every byte bit-reversed, so the searched run-in is `00 00 7f` though the sensor sends
 * `00 00 01`. Both are undone on a copy. Pressure counts thirty-seconds of a bar.
 */
private fun steelmate(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    for (row in 0 until bits.numRows) {
        val rowLen = bits.bitsPerRow[row]
        if (rowLen != 72 && rowLen != 73 && rowLen != 208 && rowLen != 209) continue
        val pos = bits.search(row, 0, STEELMATE_PRE, 24)
        if (pos > rowLen - 72) continue
        val b = bits.bytes(row, pos, 72)
        for (i in 0 until 9) b[i] = b[i].inv() and 0xff
        reflectBytes(b, 9)
        if (addBytes(b, 6, 2) != b[8]) continue
        val battery = b[7]
        val out = data("model" to "Steelmate", "type" to "TPMS", "id" to "0x" + hexOf((b[3] shl 8) or b[4], 4),
            "pressure_kPa" to round1(b[5] * 3.125), "temperature_C" to b[6] - 50, "mic" to "CHECKSUM")
        // Two battery values are leak warnings rather than voltages.
        if (battery < 0xfe) out["battery_mV"] = 3900 - battery * 10
        if (battery == 0xff) out["alarm"] = "fast leak" else if (battery == 0xfe) out["alarm"] = "slow leak"
        ctx.emit(out)
        return 1
    }
    return DECODE_FAIL_SANITY
}

private const val RH_ASK_MAX_PAYLOAD_LEN = 67
private const val RH_ASK_HEADER_LEN = 4
private const val RH_ASK_MAX_MESSAGE_LEN = RH_ASK_MAX_PAYLOAD_LEN - RH_ASK_HEADER_LEN - 3

/** Four-to-six coding with three ones per symbol, which bounds run length so a clockless receiver stays in step. */
private val RH_SYMBOLS = intArrayOf(0x0d, 0x0e, 0x13, 0x15, 0x16, 0x19, 0x1a, 0x1c, 0x23, 0x25, 0x26, 0x29, 0x2a, 0x2c, 0x32, 0x34)

private fun symbol6to4(symbol: Int): Int {
    for (i in ((symbol shr 2) and 8) until 16) if (symbol == RH_SYMBOLS[i]) return i
    return 0xff
}

private val RH_INIT = UBytes.of(0x55, 0x55, 0x55, 0x51, 0xcd)

/** The frame's first byte is its own length; each byte is two six-bit symbols sent LSB first. */
private fun radioheadExtract(bits: BitBuffer, row: Int, payload: UBytes): Int {
    val len = bits.bitsPerRow[row]
    var msgLen = RH_ASK_MAX_MESSAGE_LEN
    var pos = bits.search(row, 0, RH_INIT, 40)
    if (pos == len) return DECODE_ABORT_EARLY
    var nbBytes = 0
    pos += 40
    while (pos < len && nbBytes < msgLen) {
        // Sixteen bits are read so the second symbol is whole.
        val rx = bits.bytes(row, pos, 16)
        var r0 = reverse8(rx[0])
        var r1 = reverse8(rx[1])
        r1 = ((r1 and 0x0f) shl 2) + (r0 shr 6)
        r0 = r0 and 0x3f
        val hi = symbol6to4(r0); if (hi > 0xf) return DECODE_FAIL_SANITY
        val lo = symbol6to4(r1); if (lo > 0xf) return DECODE_FAIL_SANITY
        payload[nbBytes] = (hi shl 4) or lo
        if (nbBytes == 0) {
            msgLen = payload[0]
            if (msgLen < 2 || msgLen > RH_ASK_MAX_MESSAGE_LEN) break
        }
        nbBytes++
        pos += 12
    }
    if (msgLen < 2) return DECODE_ABORT_LENGTH
    if (msgLen > RH_ASK_MAX_MESSAGE_LEN) return DECODE_ABORT_LENGTH
    // The CRC is the last two bytes, LSB first, stored complemented.
    val crc = (payload[msgLen - 1] shl 8) or payload[msgLen - 2]
    if ((crc16lsb(payload, msgLen - 2, 0x8408, 0xffff).inv() and 0xffff) != crc) return DECODE_FAIL_MIC
    return msgLen
}

private fun radiohead(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    val payload = UBytes(RH_ASK_MAX_PAYLOAD_LEN)
    val msgLen = radioheadExtract(bits, 0, payload)
    if (msgLen <= 0) return msgLen
    val dataLen = msgLen - RH_ASK_HEADER_LEN - 3
    if (dataLen <= 0) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "RadioHead-ASK", "len" to dataLen, "to" to payload[1], "from" to payload[2], "id" to payload[3], "flags" to payload[4],
        "payload" to (0 until dataLen).map { payload[5 + it] }, "mic" to "CRC"))
    return 1
}

/** One product's use of RadioHead at half speed; a short frame reads zeros past its end, as upstream lets it. */
private fun sensibleLiving(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    val payload = UBytes(RH_ASK_MAX_PAYLOAD_LEN)
    val msgLen = radioheadExtract(bits, 0, payload)
    if (msgLen <= 0) return msgLen
    ctx.emit(data("model" to "SensibleLiving-Moisture", "house_id" to payload[1], "module_id" to ((payload[2] shl 8) or payload[3]),
        "sensor_type" to payload[4], "sensor_count" to payload[5], "alarms" to payload[6], "sensor_value" to ((payload[7] shl 8) or payload[8]),
        "battery_mV" to ((payload[9] shl 8) or payload[10]) * 10, "mic" to "CRC"))
    return 1
}

private const val XC0324_MESSAGE_BITLEN = 48
private val XC0324_PRE = UBytes.of(0x5f)

/** Three copies per row; the first good one is reported and every good one counted, the only quality figure it offers. */
private fun xc0324(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0; var ret = 0
    var out: R433Data? = null
    for (r in 0 until bits.numRows) {
        if (bits.bitsPerRow[r] < XC0324_MESSAGE_BITLEN) continue
        var bitpos = 0
        while (true) {
            bitpos = bits.search(r, bitpos, XC0324_PRE, 8)
            if (bitpos + XC0324_MESSAGE_BITLEN > bits.bitsPerRow[r]) break
            val b = bits.bytes(r, bitpos, XC0324_MESSAGE_BITLEN)
            if (xorBytes(b, 6) != 0x00) ret = DECODE_FAIL_MIC
            else {
                ret = 1
                events++
                if (out == null) {
                    val temp = ((reverse8(b[3]) and 0x0f) shl 8) or reverse8(b[2])
                    out = data("model" to "Digitech-XC0324", "id" to hexUp(b[1]), "temperature_C" to round1((temp - 400) * 0.1),
                        "humidity" to reverse8(b[4]), "mic" to "CHECKSUM")
                }
            }
            bitpos += XC0324_MESSAGE_BITLEN
        }
    }
    if (events > 0 && out != null) {
        out["message_num"] = events
        ctx.emit(out)
        return events
    }
    return ret
}

/** Seven whole-degree bits scattered across positions 12, 7, 6, 11, 10, 9, 8; reassembled as upstream does. */
private fun companion(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(3, 14)
    if (r < 0 || bits.bitsPerRow[r] != 14) return DECODE_ABORT_LENGTH
    val b = bits.bytes(r, 0, 14)
    b[0] = b[0].inv() and 0xff
    b[1] = b[1].inv() and 0xfc
    if ((b[0] and 0x04) == 0x04) return DECODE_FAIL_SANITY
    if (parityBytes(b, 2) == 0) return DECODE_FAIL_MIC
    var tempTenthRaw = reverse8(b[0] and 0xf8)
    if (tempTenthRaw < 0x0a || tempTenthRaw > 0x13) return DECODE_FAIL_SANITY
    tempTenthRaw -= 0x0a
    val tempWholeRaw = reverse8(b[1] and 0xf0) or (reverse8(b[0] and 0x03) shr 2) or ((b[1] and 0x08) shl 3)
    if (tempWholeRaw < 11 || tempWholeRaw > 111) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Companion-WTR001", "temperature_C" to round1(tempWholeRaw + tempTenthRaw * 0.1 - 41), "mic" to "PARITY"))
    return 1
}

private val TELLDUS_PRE = UBytes.of(0x14, 0xe0)

/**
 * The console repeating its outdoor unit. The nine-bit run-in's last bit is the frame's first, so the search
 * advances by eight. An outdoor temperature of 0x7fb means nothing was heard from outside.
 */
private fun telldus(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 2) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] < 296 && bits.bitsPerRow[1] < 296) return DECODE_ABORT_EARLY
    var b: UBytes? = null
    for (i in 0 until bits.numRows) {
        val pos = bits.search(i, 0, TELLDUS_PRE, 9) + 8
        if (pos + 296 > bits.bitsPerRow[i]) continue
        b = bits.bytes(i, pos, 296)
        break
    }
    if (b == null) return DECODE_FAIL_SANITY
    if (crc8(b, 37, 0x31, 0xc0) != 0) return DECODE_FAIL_MIC
    // Three nine-bit wind fields whose top bits share byte two.
    val wind = ((b[2] and 0x01) shl 8) or b[3]
    val gust = (((b[2] and 0x02) shr 1) shl 8) or b[4]
    val windDir = (((b[2] and 0x04) shr 2) shl 8) or b[5]
    val tempRaw = ((b[24] and 0x0f) shl 8) or b[25]
    val temp2Raw = (((b[24] and 0xf0) shr 4) shl 8) or b[27]
    val out = data("model" to "Telldus-FT0385R", "temperature_2_F" to round1((temp2Raw - 400) * 0.1), "humidity_2" to b[28],
        "pressure_hPa" to round1(((b[29] shl 8) or b[30]) * 0.1), "mic" to "CRC")
    if (tempRaw != 0x7fb) {
        out["temperature_F"] = round1((tempRaw - 400) * 0.1)
        out["humidity"] = b[26]
        out["rain_mm"] = round1(((b[20] shl 8) or b[21]) * 0.1)
        out["wind_dir_deg"] = windDir
        out["wind_avg_m_s"] = round1(wind * 0.1)
        out["wind_max_m_s"] = round1(gust * 0.1)
    }
    ctx.emit(out)
    return 1
}

private val ANT_PRE = UBytes.of(0xaa)

/**
 * 2.4 GHz at a megabit, so it needs a converter and a high sample rate; off upstream. The run-in depends on the
 * first message bit, so on a CRC failure the frame is retried one bit along. The payload needs Garmin's network key.
 */
private fun ant(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    val rowLen = bits.bitsPerRow[0]
    if (rowLen < 120 || rowLen > 200) return DECODE_ABORT_LENGTH
    val bitOffset = bits.search(0, 0, ANT_PRE, 8) + 8
    if (bitOffset + 17 * 8 > rowLen) return DECODE_ABORT_LENGTH
    var b = bits.bytes(0, bitOffset, 17 * 8)
    if (crc16(b, 17, 0x1021, 0xffff) != 0) {
        b = bits.bytes(0, bitOffset + 1, 17 * 8)
        if (crc16(b, 17, 0x1021, 0xffff) != 0) return DECODE_FAIL_MIC
    }
    val netKey = (b[1] shl 8) or b[0]
    ctx.emit(data("model" to "Garmin-ANT", "network" to if (netKey == 0xc5a6) "ANT+" else "ANT", "channel" to "0x" + hexOf(netKey, 4),
        "id" to "0x" + hexOf((b[3] shl 8) or b[2], 4), "device_type" to b[4], "tx_type" to b[5],
        "payload" to (7..14).joinToString(" ") { hexOf(b[it]) }, "mic" to "CRC"))
    return 1
}

private const val WL_TH6R_BITS_PER_ROW = 72

/**
 * Whitened with a byte sent in clear (not encryption, just run breaking). The check folds in the sum's carry,
 * so the sum is full width. Weak enough that an identical second row is demanded; the row is worked on a copy.
 */
private fun wlTh6r(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedPrefix(2, WL_TH6R_BITS_PER_ROW)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > WL_TH6R_BITS_PER_ROW + 1) return DECODE_ABORT_LENGTH
    val b = bits.bytes(row, 0, WL_TH6R_BITS_PER_ROW)
    for (i in 0 until 9) b[i] = b[i].inv() and 0xff
    for (i in 0 until 7) b[i] = b[i] xor b[7]
    val x = xorBytes(b, 7)
    var sum = 0
    for (i in 0 until 7) sum += b[i]
    if (b[8] != (0xa5 xor x xor (sum and 0xff) xor (sum shr 8))) return DECODE_FAIL_MIC
    val tempC = signed((b[3] shl 8) or b[4], 16) * 0.1
    if (tempC < -20 || tempC > 60) return DECODE_FAIL_SANITY
    val humidityPct = b[5]
    if (humidityPct > 127) return DECODE_FAIL_SANITY
    val batteryPct = b[6]
    val pairing = b[7] shr 7
    val out = data("model" to "WL-TH6R", "id" to hexUp((b[0] shl 16) or (b[1] shl 8) or b[2], 6), "battery_pct" to batteryPct,
        "temperature_C" to round1(tempC), "humidity" to humidityPct,
        // Fresh batteries can leave the counter bits uninitialized, so anything at the wrap is pinned.
        "cycle" to if ((b[7] and 0x40) != 0) 0x40 else (b[7] and 0x3f), "mic" to "CHECKSUM")
    if (batteryPct < 20) out["battery_ok"] = 0
    if (pairing != 0) out["pairing"] = pairing
    ctx.emit(out)
    return 1
}

/**
 * Each byte is the xor of the one before with its meaning, seeded from the sync word. The last byte is called a
 * checksum upstream but never checked, so two fixed bit runs are the only integrity; mic says CHECKSUM as upstream does.
 */
private fun gearHiveDecode(bits: BitBuffer, ctx: DecodeCtx, row: Int, bitpos: Int): Int {
    val payloadStart = bitpos + 16
    if (bits.bitsPerRow[row] - payloadStart < 72) return DECODE_ABORT_LENGTH
    val raw = bits.bytes(row, payloadStart, 72)
    val p = UBytes(9)
    p[0] = raw[0] xor 0x94
    for (i in 1 until 9) p[i] = raw[i] xor raw[i - 1]
    if ((p[6] and 0x3c) != 0x20) return DECODE_FAIL_SANITY
    if ((p[7] and 0x3f) != 0x35) return DECODE_FAIL_SANITY
    val base = (80 + (p[1] and 0x0f) * 64) and 0xff     // the pressure zero point moves with the sensor class
    ctx.emit(data("model" to "Gear-Hive", "type" to "TPMS", "id" to hexOf((p[2] shl 16) or (p[3] shl 8) or p[4], 6),
        "counter" to (((p[1] shr 4) shl 8) or p[0]), "pressure_kPa" to round1(((p[5] - base + 256) and 0xff) * 6.25),
        "temperature_C" to ((p[7] shr 6) or ((p[6] and 0x03) shl 2)) + 21, "mic" to "CHECKSUM"))
    return 1
}

private val GEARHIVE_SYNC = UBytes.of(0x25, 0x94)

private fun gearHive(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0; var ret = 0
    for (row in 0 until bits.numRows) {
        var bitpos = 0
        while (true) {
            bitpos = bits.search(row, bitpos, GEARHIVE_SYNC, 16)
            if (bitpos + 16 + 72 > bits.bitsPerRow[row]) break
            ret = gearHiveDecode(bits, ctx, row, bitpos)
            if (ret > 0) events += ret
            bitpos += 16
        }
    }
    return if (events > 0) events else ret
}

private val FSL_PREAMBLE = UBytes.of(0xaa, 0xaa, 0xaa, 0xaa)
private val FSL_SYNC = UBytes.of(0xe0)

/**
 * A scoreboard handset sending one field's digits, the block ten times over. The four position markers counting
 * down are the whole integrity check; a digit of fifteen is blank, so a score shows no leading nought.
 */
private fun fslScoreboard(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] < 700) continue
        val preamblePos = bits.search(row, 0, FSL_PREAMBLE, 32)
        if (preamblePos + 38 + 72 >= bits.bitsPerRow[row]) continue
        var blockPos = preamblePos + 38
        while (blockPos + 72 < bits.bitsPerRow[row]) {
            if (bits.search(row, blockPos, FSL_SYNC, 3) == blockPos) {
                val decoded = BitBuffer()
                bits.manchesterDecode(row, blockPos + 3, decoded, 32)
                if (decoded.bitsPerRow[0] >= 32) {
                    val b = decoded.bytes(0, 0, 32)
                    if ((b[0] shr 4) == 0x3 && (b[1] shr 4) == 0x2 && (b[2] shr 4) == 0x1 && (b[3] shr 4) == 0x0) {
                        val hundreds = b[1] and 0xf; val tens = b[2] and 0xf; val units = b[3] and 0xf
                        var value = 0
                        if (hundreds != 0xf) value += hundreds * 100
                        if (tens != 0xf) value += tens * 10
                        if (units != 0xf) value += units
                        ctx.emit(data("model" to "FSL-Scoreboard", "id" to (b[0] and 0xf), "value" to value))
                        return 1
                    }
                }
            }
            blockPos += 72
        }
    }
    return DECODE_ABORT_EARLY
}

internal val TELEMETRY: List<RDevice> = listOf(
    dev(59, "Steelmate TPMS", Mod.FSK_MANCHESTER_ZEROBIT, 50, 50, 120, bands = TPMS_BANDS, what = "tire pressure sensor: Steelmate TP-S15, R-Lake", decode = ::steelmate),
    dev(67, "Radiohead ASK", Mod.OOK_PCM, 500, 500, 5 * 500, bands = TPMS_BANDS, what = "generic hobbyist radio link", decode = ::radiohead),
    dev(103, "Sensible Living Mini-Plant Moisture Sensor", Mod.OOK_PCM, 1000, 1000, 5 * 1000, bands = TPMS_BANDS, what = "plant moisture probe", decode = ::sensibleLiving),
    dev(120, "Digitech XC-0324 / AmbientWeather FT005TH temp/hum sensor", Mod.OOK_PPM, 520, 1000, 3000, bands = B433,
        what = "thermometer and hygrometer", decode = ::xc0324),
    dev(126, "Companion WTR001 Temperature Sensor", Mod.OOK_PWM, 732, 2196, 8000, gapLimit = 4000, syncWidth = 1464, bands = B433,
        what = "thermometer", decode = ::companion),
    dev(205, "Telldus weather station FT0385R sensors", Mod.OOK_MANCHESTER_ZEROBIT, 500, 0, 2400, gapLimit = 1200, bands = B433,
        what = "weather station console", decode = ::telldus),
    // 2.4 GHz: out of reach without a converter, and off upstream.
    dev(216, "ANT and ANT+ devices", Mod.FSK_PCM, 1, 1, 500, gapLimit = 500, syncWidth = 8, disabled = true, bands = listOf(2_457_025_000L),
        what = "sports and fitness telemetry", decode = ::ant),
    dev(319, "Shenzhen Wale WL-TH6R Temperature & Humidity Sensor", Mod.OOK_PWM, 365, 605, 4000, gapLimit = 780, tolerance = 50, bands = B433,
        what = "thermometer and hygrometer", decode = ::wlTh6r),
    dev(322, "Gear Hive TPMS sensor", Mod.OOK_MANCHESTER_ZEROBIT, 120, 224, 800, bands = B433, what = "tire pressure sensor: unbranded aftermarket", decode = ::gearHive),
    dev(345, "FSL Cricket Scoreboard Controller", Mod.FSK_PCM, 528, 528, 3000, what = "cricket scoreboard controller", decode = ::fslScoreboard),
)
