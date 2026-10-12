package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Heating and utilities: Danfoss CFR, emonTx, Vaillant VRT340f, Clipsal CMR113, Proflame 2 gas fire remote,
 * SRSmith pool light remote, Flowis and Mueller water meters, Celsia CZC1 and the Oregon WMR500.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): danfoss.c, emontx.c, vaillant_vrt340f.c, cmr113.c, proflame2.c,
 * srsmith_pool_srs_2c_tx.c, flowis.c, celsia_czc1.c, mueller_hotrod.c, oregon_scientific_wmr500.c.
 * Twin of web/src/dsp/r433/devices/heating.ts.
 */

/** Upstream states a frequency for only two of these ten; the rest claim none rather than guess. */
private val BAND_315 = listOf(314_973_000L)
private val BAND_915 = listOf(915_000_000L)
private fun dec2(v: Int) = v.toString().padStart(2, '0')

private fun bitrowGetByte(row: UBytes, pos: Int) = (((row[pos shr 3] shl 8) or row[(pos shr 3) + 1]) shr (8 - (pos and 7))) and 0xff

/** The 4b/6b line code: only sixteen of sixty-four symbols are legal, so a flipped bit almost never survives. */
private val DANFOSS_6B4B = mapOf(0x0b to 0xd, 0x0d to 0xe, 0x0e to 0x3, 0x13 to 0x4, 0x15 to 0xa, 0x16 to 0xf, 0x19 to 0x9, 0x1a to 0x6,
    0x25 to 0x0, 0x26 to 0x7, 0x29 to 0x1, 0x2a to 0x5, 0x2c to 0xc, 0x31 to 0xb, 0x32 to 0x2, 0x34 to 0x8)

private fun danfossSwitch(v: Int) = when (v) { 2 -> "DAY"; 4 -> "TIMER"; 8 -> "NIGHT"; else -> "ERROR" }

private fun danfoss(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    if (rowBits < 246 || rowBits > 260) return DECODE_ABORT_LENGTH
    // Sixteen bits of the encoded prefix are enough to find it; the preamble ahead is always longer than fourteen bytes.
    val found = bits.search(0, 112, UBytes.of(0x36, 0x5c), 16)
    if (rowBits - found < 126) return DECODE_ABORT_LENGTH
    // The leading 0xE nibble sits outside the CRC; dropping it gives byte alignment.
    val bitOffset = found + 6
    val row = bits.bb[0]
    val bytes = UBytes(10)
    for (n in 0 until 10) {
        val hi = DANFOSS_6B4B[bitrowGetByte(row, n * 12 + bitOffset) shr 2] ?: return DECODE_FAIL_SANITY
        val lo = DANFOSS_6B4B[bitrowGetByte(row, n * 12 + bitOffset + 6) shr 2] ?: return DECODE_FAIL_SANITY
        bytes[n] = (hi shl 4) or lo
    }
    if (bytes[0] != 0x02) return DECODE_FAIL_MIC
    if (crc16(bytes, 8, 0x1021, 0x0000) != ((bytes[8] shl 8) or bytes[9])) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Danfoss-CFR", "type" to "Thermostat", "id" to ((bytes[1] shl 8) or bytes[2]),
        "temperature_C" to round2(bytes[5] + bytes[4] / 256.0), "setpoint_C" to round2(bytes[7] + bytes[6] / 256.0),
        "switch" to danfossSwitch(bytes[3] and 0x0f), "mic" to "CRC"))
    return 1
}

private val EMONTX_PREAMBLE = UBytes.of(0xaa, 0xaa, 0xaa)
private val EMONTX_HDR = UBytes.of(0x2d, 0xd2, 0x00)
private val EMONTX_HDR_INV = UBytes.of(0xd2, 0x2d, 0xc0)

/**
 * JeeLibs RF12 packets. The radio drops the preamble's last zero, so twenty-two bits are searched and the
 * position stepped back one; either polarity is accepted. A probe reading exactly 300.0 °C is absent.
 */
private fun emontx(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    val pktBytes = 33                                    // syn, group, node, len, fourteen words, postamble
    var events = 0
    var bitpos = 0
    while (true) {
        bitpos = bits.search(0, bitpos, EMONTX_PREAMBLE, 22)
        if (bitpos >= rowBits) break
        bitpos += 22
        while (bits.search(0, bitpos, EMONTX_PREAMBLE, 2) == bitpos) bitpos += 2
        bitpos--
        var inverted = false
        var pktPos = bits.search(0, bitpos, EMONTX_HDR, 11)
        if (pktPos > bitpos + 5) {
            pktPos = bits.search(0, bitpos, EMONTX_HDR_INV, 11)
            if (pktPos > bitpos + 5) continue
            inverted = true
        }
        if (pktPos + pktBytes * 8 > rowBits) break
        val pkt = bits.bytes(0, pktPos, pktBytes * 8)
        if (inverted) for (i in 0 until pktBytes) pkt[i] = pkt[i] xor 0xff
        if (pkt[3] != 0x1a || pkt[32] != 0xaa) continue
        val crc = crc16lsb(pkt, 0x1d, 0xa001, 0xffff, 1)
        val words = IntArray(14) { pkt[4 + it * 2] or (pkt[5 + it * 2] shl 8) }
        if (crc != words[13]) continue
        val out = data("model" to "emonTx-Energy", "type" to "Energy", "node" to (pkt[2] and 0x1f), "ct1" to signed(words[0], 16),
            "ct2" to signed(words[1], 16), "ct3" to signed(words[2], 16), "ct4" to signed(words[3], 16), "batt_Vrms" to round2(words[4] / 100.0),
            "pulse" to (words[11].toLong() or (words[12].toLong() shl 16)), "mic" to "CRC")
        for (i in 0 until 6) if (words[5 + i] != 3000) out["temp${i + 1}_C"] = round1(words[5 + i] * 0.1)
        ctx.emit(out)
        events++
    }
    return events
}

/** A sixteen-bit two's complement sum, taken at full width since it overflows a byte on upstream's own frame. */
private fun vaillantChecksumOk(b: UBytes, from: Int, to: Int, csFrom: Int, csTo: Int): Boolean {
    var calculated = 0
    for (i in from..to) calculated += b[i]
    return ((calculated + ((b[csFrom] shl 8) or b[csTo])) and 0xffff) == 0
}

/**
 * Differential Manchester with bit stuffing, LSB first: unstuff, reflect, then read. Upstream reflects one byte
 * fewer than the frame holds; the last byte is an unread epilogue, and the quirk is kept.
 */
private fun vaillant(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] < 128) return DECODE_ABORT_LENGTH
    val src = bits.bb[0]
    val destuffed = BitBuffer()
    var ones = 0
    for (k in 0 until bits.bitsPerRow[0]) {
        if (bitAt(src, k) == 1) { destuffed.addBit(1); ones++ }
        else { if (ones != 5) destuffed.addBit(0); ones = 0 }
    }
    val b = destuffed.bb[0]
    val bitcount = destuffed.bitsPerRow[0]
    reflectBytes(b, (bitcount - 1) / 8)
    val isNormal = bitcount in 128..131
    val isDetect = bitcount in 168..171
    if (!isNormal && !isDetect) return DECODE_ABORT_LENGTH
    val syncOk = b[0] == 0x00 && b[1] == 0x00 && b[2] == 0x7e
    if (syncOk && isNormal) {
        if (!vaillantChecksumOk(b, 3, 11, 12, 13)) return DECODE_FAIL_MIC
        val heatingMode = b[10] shr 7
        val targetTemperature = b[10] and 0x7f
        ctx.emit(data("model" to "Vaillant-VRT340f", "type" to "Thermostat", "id" to ((b[3] shl 8) or b[4]),
            "heating" to if (heatingMode == 0 && targetTemperature == 0) "OFF" else if (heatingMode != 0) "ON (2-point)" else "ON (analogue)",
            "heating_temp" to targetTemperature, "water" to if ((b[9] and 8) == 0) "ON" else "off", "battery_ok" to if (b[11] != 0) 0 else 1))
        return 1
    }
    // The longer frame is sent while pairing; only its device id is understood.
    if (syncOk && isDetect) {
        if (!vaillantChecksumOk(b, 3, 16, 17, 18)) return DECODE_FAIL_MIC
        ctx.emit(data("model" to "Vaillant-VRT340f", "type" to "Thermostat", "id" to ((b[11] shl 8) or b[12])))
        return 1
    }
    return DECODE_FAIL_SANITY
}

/**
 * Two coding layers and no checksum: on top of one bit per pulse, `00` holds the output bit and `011` flips it.
 * Eighty-three bits sent twice, and the copies agreeing is the only integrity there is.
 */
private fun cmr113(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    if (rowBits < 350 || rowBits > 450) return DECODE_ABORT_LENGTH
    val head = bits.bytes(0, 0, 32)
    if (head[0] != 0xb0 || head[1] != 0x00 || head[2] != 0x00) return DECODE_ABORT_EARLY
    val compareBits = 83
    val compareBytes = (compareBits + 7) shr 3
    val out = BitBuffer()
    var start = 0
    var bit = 0
    while (start + 3 < rowBits) {
        val c = bits.bytes(0, start, 3)[0]
        if ((c shr 6) == 0x00) { start += 2; out.addBit(bit) }
        else if ((c shr 5) == 0x03) { start += 3; bit = 1 - bit; out.addBit(bit) }
        else if (start == 0) start += 1
        else return DECODE_ABORT_LENGTH
    }
    if (out.bitsPerRow[0] < 2 * compareBits + 2) return DECODE_ABORT_LENGTH
    val first = out.bytes(0, 0, compareBits)
    val second = out.bytes(0, compareBits + 2, compareBits)
    for (i in 0 until compareBytes) if (first[i] != second[i]) return DECODE_FAIL_MIC
    // Three ten-bit currents, LSB first, in tenths of an amp.
    val current = (0 until 3).map { i ->
        val raw = out.bytes(0, 36 + i * 10, 10)
        reflectBytes(raw, 2)
        round1((raw[0] + ((raw[1] and 0x03) shl 8)) * 0.1)
    }
    ctx.emit(data("model" to "Clipsal-CMR113", "type" to "Energy", "current_1_A" to current[0], "current_2_A" to current[1], "current_3_A" to current[2]))
    return 1
}

/**
 * Seven words, each `1110` then eleven Manchester bits: data, a pad bit set only on the first word, parity and a
 * guard. The convention is the opposite of the shared decoder's, so the decoded bytes are complemented.
 */
private fun proflame2Words(bits: BitBuffer, row: Int, start: Int, out: UBytes): Int {
    var pos = start
    var f = 0
    while (true) {
        if (bits.bitsPerRow[row] - pos < 26) return f
        val b = bits.bb[row]
        val sync = (bitAt(b, pos) shl 3) or (bitAt(b, pos + 1) shl 2) or (bitAt(b, pos + 2) shl 1) or bitAt(b, pos + 3)
        pos += 4
        if (sync != 0xe) return f
        val decoded = BitBuffer()
        pos = bits.manchesterDecode(row, pos, decoded, 11)
        if (decoded.bitsPerRow[0] != 11) return f
        val dataByte = decoded.bb[0][0] xor 0xff
        val flag = decoded.bb[0][1] xor 0xe0
        val pad = (flag shr 7) and 1; val par = (flag shr 6) and 1; val end = (flag shr 5) and 1
        if (pad != (if (f == 0) 1 else 0)) return f
        if ((parity8(dataByte) xor pad xor par) != 0) return f
        if (end != 1) return f
        if (f < out.size) out[f] = dataByte
        f++
    }
}

/** The last two bytes are called error detection upstream but nothing checks them, so they go out raw. */
private fun proflame2(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    for (row in 0 until bits.numRows) {
        val b = UBytes(7)
        if (proflame2Words(bits, row, 0, b) != 7) continue
        ctx.emit(data("model" to "Proflame2-Remote", "type" to "Remote", "id" to ((b[0] shl 16) or (b[1] shl 8) or b[2]), "cmd1" to b[3], "cmd2" to b[4],
            "err1" to b[5], "err2" to b[6], "pilot" to (b[3] shr 7), "light" to ((b[3] and 0x70) shr 4), "thermostat" to ((b[3] and 0x02) shr 1),
            "power" to (b[3] and 0x01), "front" to (b[4] shr 7), "fan" to ((b[4] and 0x70) shr 4), "aux" to ((b[4] and 0x08) shr 3),
            "flame" to (b[4] and 0x07), "mic" to "CHECKSUM"))
        return 1
    }
    return DECODE_FAIL_OTHER
}

private fun srsmithButton(id: Int) = when (id) {
    0x0d -> "On/Off Channel 1"; 0x1f -> "On/Off Channel 2"; 0x07 -> "Color Sync"; 0x0b -> "ON/OFF Control - M"; else -> "Unknown"
}

/**
 * A CC110x behind its usual sync word. Only the CRC-16 is enforced; the inner CRC-8 upstream computes and then
 * ignores is neither checked nor reported. The id is the remote's pin, inverted and bit-reversed.
 */
private fun srsmith(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    if (rowBits < 120 || rowBits > 144) return DECODE_ABORT_LENGTH
    val startPos = bits.search(0, 0, UBytes.of(0xaa, 0xd3, 0x91, 0xd3, 0x91), 40) + 40
    if (startPos >= rowBits) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, startPos, 10 * 8)
    if (((b[8] shl 8) or b[9]) != crc16(b, 8, 0x8005, 0xffff)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "SRSmith-SRS2CTX", "type" to "Remote", "id" to reverse8(b[5].inv() and 0xff), "button_press" to b[6],
        "button_press_name" to srsmithButton(b[6]),
        "unknown" to u32be(b, 1),                        // constant in every frame recorded, meaning unknown
        "mic" to "CRC"))
    return 1
}

/** Several message types share framing and CRC; only type 1 is understood, so others are validated and declined. */
private fun flowis(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    val startPos = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91), 48)
    if (startPos == rowBits) return DECODE_ABORT_EARLY
    val len = bits.bytes(0, startPos + 48, 8)[0]
    if (startPos + (7 + len + 2) * 8 > rowBits) return DECODE_ABORT_LENGTH
    // The length byte counts neither itself nor the CRC, but the CRC covers it.
    val b = UBytes(len + 3)
    b[0] = len
    b.setAll(bits.bytes(0, startPos + 7 * 8, (len + 2) * 8).sub(0, len + 2), 1)
    if (((b[len + 1] shl 8) or b[len + 2]) != crc16(b, len + 1, 0x8005, 0xffff)) return DECODE_FAIL_MIC
    val type = b[1]
    if (type != 1) return DECODE_ABORT_EARLY
    val year = b[10] shr 2
    val month = (b[9] shr 6) or ((b[10] and 3) shl 2)
    val day = (b[9] and 0x3e) shr 1
    val hour = (b[8] shr 4) or ((b[9] and 1) shl 4)
    val minute = ((b[8] and 0x0f) shl 2) or ((b[7] and 0xc0) shr 6)
    val second = b[7] and 0x3f
    ctx.emit(data("model" to "Flowis", "type" to "Meter",
        "id" to (b[2].toLong() or (b[3].toLong() shl 8) or (b[4].toLong() shl 16) or (b[5].toLong() shl 24)), "msg_type" to type,
        "volume_m3" to round3(((b[13] shl 16) or (b[12] shl 8) or b[11]) / 1000.0),
        "device_time" to "${year + 2000}-${dec2(month)}-${dec2(day)}T${dec2(hour)}:${dec2(minute)}:${dec2(second)}",
        "alarm" to b[15], "backflow" to b[14], "mic" to "CRC"))
    return 1
}

private val CELSIA_PREAMBLE = UBytes.of(0xcc, 0xcc, 0xcc, 0xcc, 0x55, 0x55, 0x55, 0x55)

/**
 * Four wire bits per two data bits, 0xf0 ending the message, other symbols skipped as upstream does. The CRC-8 runs
 * over eight bytes past the real data into zeroes, which is harmless once the register reaches zero.
 */
private fun celsia(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1 || bits.bitsPerRow[0] < 144) return DECODE_ABORT_EARLY
    val preambleEnd = bits.search(0, 0, CELSIA_PREAMBLE, 64) + 64
    if (preambleEnd >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    if (preambleEnd + 132 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val row = bits.bb[0]
    val nBytes = bits.bitsPerRow[0] shr 3
    val decoded = BitBuffer()
    for (ipos in (preambleEnd shr 3) until nBytes) {
        when (row[ipos]) {
            0xf0 -> break
            0x55 -> { decoded.addBit(0); decoded.addBit(0) }
            0x5a -> { decoded.addBit(0); decoded.addBit(1) }
            0xa5 -> { decoded.addBit(1); decoded.addBit(0) }
            0xaa -> { decoded.addBit(1); decoded.addBit(1) }
        }
    }
    val b = decoded.bb[0]
    if (crc8(b, 8, 0x31, 0xd7) != 0) return DECODE_FAIL_MIC
    // 0x00 marks pairing, 0xf0 a command; only a command carries a heating level.
    if (b[2] != 0x00 && b[2] != 0xf0) return DECODE_FAIL_OTHER
    val out = data("model" to "Celsia-CZC1", "type" to "Thermostat", "id" to ((b[0] shl 8) or b[1]), "mic" to "CRC")
    if (b[2] == 0xf0) out["heat"] = reverse8(b[3])
    ctx.emit(out)
    return 1
}

private val MUELLER_SYNC = UBytes.of(0xfe, 0xb1, 0x00)

/** GFSK leaves the run-in unstable, so only the feb100 sync is trusted. Seven BCD nibbles of US gallons. */
private fun mueller(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] < 96) return DECODE_ABORT_LENGTH
    val pos = bits.search(0, 0, MUELLER_SYNC, 24)
    if (pos + 9 * 8 >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, pos + 24, 72)
    // CRC-8/UTI. Upstream returns a plain zero on failure; this says what it is.
    if ((crc8(b, 8, 0x07, 0x00) xor 0x55) != b[8]) return DECODE_FAIL_MIC
    val volume = ((b[4] and 0xf0) shr 4) * 1000000 + (b[4] and 0x0f) * 100000 + ((b[5] and 0xf0) shr 4) * 10000 + (b[5] and 0x0f) * 1000 +
        ((b[6] and 0xf0) shr 4) * 100 + (b[6] and 0x0f) * 10 + ((b[7] and 0xf0) shr 4)
    ctx.emit(data("model" to "Mueller-HotRod", "type" to "Meter", "id" to hexBytes(b, 4), "volume_gal" to volume, "flag" to (b[7] and 0x0f), "mic" to "CRC"))
    return 1
}

/**
 * Upstream inverts the whole buffer before searching; searching for the complement and complementing the bytes
 * read gives the same result without touching the shared buffer, and the complement is the CC110x sync word. The
 * short message is verified and dropped (its payload is not understood); temperature is a two-point fit.
 */
private fun wmr500(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val rowLen = bits.bitsPerRow[0]
    var pos = bits.search(0, 0, UBytes.of(0xaa, 0xd3, 0x91, 0xd3, 0x91), 40)
    if (pos >= rowLen) return DECODE_ABORT_EARLY
    pos += 40
    if (pos + 8 > rowLen) return DECODE_ABORT_LENGTH
    val availBytes = minOf((rowLen - pos) / 8, 28)
    val b = bits.bytes(0, pos, availBytes * 8)
    for (i in 0 until b.size) b[i] = b[i] xor 0xff
    val len = b[0]
    val totalBytes: Int; val crcInit: Int
    when (len) { 14 -> { totalBytes = 17; crcInit = 0x4ed0 }; 25 -> { totalBytes = 28; crcInit = 0x1a4c }; else -> return DECODE_ABORT_EARLY }
    if (availBytes < totalBytes) return DECODE_ABORT_LENGTH
    if (crc16(b, totalBytes - 2, 0x8005, crcInit) != ((b[totalBytes - 2] shl 8) or b[totalBytes - 1])) return DECODE_FAIL_MIC
    if (len == 14) return DECODE_ABORT_EARLY
    val humidity = 208 - b[16]
    if (humidity < 0 || humidity > 100) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Oregon-WMR500", "type" to "Weather", "id" to ((b[8] shl 8) or b[9]),
        "temperature_C" to round1((b[14] - 169) * 0.7), "temperature_raw" to b[14], "humidity" to humidity, "mic" to "CRC"))
    return 1
}

/** 49261 kHz on the RFM69 and 49230 kHz on the RFM12B; upstream splits the difference. */
private const val EMONTX_BIT = 2000000.0 / (49230 + 49261)

internal val HEATING: List<RDevice> = listOf(
    dev(26, "Danfoss CFR Thermostat", Mod.FSK_PCM, 100, 100, 500, what = "room thermostat", decode = ::danfoss),
    dev(45, "emonTx OpenEnergyMonitor", Mod.FSK_PCM, EMONTX_BIT, EMONTX_BIT, 1200, what = "household energy monitor", decode = ::emontx),
    dev(77, "Vaillant calorMatic VRT340f Central Heating Control", Mod.OOK_DMC, 836, 1648, 4000, tolerance = 120, what = "central heating control", decode = ::vaillant),
    // Short high and low pulses differ enough to need a wide tolerance.
    dev(193, "Clipsal CMR113 Cent-a-meter power meter", Mod.OOK_PIWM_DC, 480, 976, 2069, syncWidth = 2028, tolerance = 200,
        what = "three-phase current clamp", decode = ::cmr113),
    dev(207, "SmartFire Proflame 2 remote control", Mod.OOK_PCM, 417, 417, 6000, gapLimit = 1000, bands = BAND_315, what = "gas fireplace remote", decode = ::proflame2),
    dev(227, "SRSmith Pool Light Remote Control SRS-2C-TX (-f 915M)", Mod.FSK_PCM, 100, 100, 4096, bands = BAND_915, what = "pool light remote", decode = ::srsmith),
    dev(237, "Flowis flow meters", Mod.FSK_PCM, 10, 10, 5000, what = "water meter", decode = ::flowis),
    dev(243, "Celsia CZC1 Thermostat", Mod.OOK_PCM, 1220, 1220, 4880, tolerance = 20, what = "room thermostat", decode = ::celsia),
    dev(255, "Mueller Hot Rod water meter", Mod.FSK_PCM, 26, 26, 2500, what = "water meter", decode = ::mueller),
    dev(363, "Oregon Scientific WMR500 weather station", Mod.FSK_PCM, 26, 26, 312, what = "weather station", decode = ::wmr500),
)
