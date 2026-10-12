package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Energy monitors and socket meters: ELV ESA / GIRA, IKEA Sparsnäs, ESIC EMT7110, Norgo, Marlec iBoost+, Revolt,
 * Voltcraft EnergyCount 3000, RFXMeter and Eco-Eye.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): esa.c, ikea_sparsnas.c, emt7110.c, norgo.c, marlec_solar.c,
 * revolt_nc5462.c, revolt_zx7717.c, ec3k.c, rfxmeter.c, ecoeye.c. Twin of web/src/dsp/r433/devices/energy2.ts.
 */

private const val METER_HEAD = "optical head on a domestic electricity meter"
private const val SOCKET = "plug-in socket power meter"

/** Full-width sum: Revolt rejects a payload summing to zero, which a byte mask would confuse with one summing to 256. */
private fun sumBytesFull(m: UBytes, n: Int, at: Int = 0): Int { var s = 0; for (i in 0 until n) s += m[at + i]; return s }

/**
 * A running xor keyed on the previous ciphertext byte, so one bit error destroys everything after it. The
 * residue left in the last two bytes both verifies the frame and names the device family.
 */
private fun decryptEsa(b: UBytes, blen: Int): Int {
    var pos = 0; var salt = 0x89; var crc = 0
    for (i in 0 until blen - 3) {
        val byte = b[pos]
        crc = (crc + byte) and 0xffff
        b[pos] = b[pos] xor salt; pos++
        salt = (byte + 0x24) and 0xff
    }
    crc = (crc + b[pos]) and 0xffff
    b[pos] = b[pos] xor 0xff
    return ((((b[blen - 2] shl 8) or b[blen - 1]) - crc) and 0xffff)
}

private const val ESA_MAGIC_ELV = 0xf00f
private const val ESA_MAGIC_GIRA = 0xee11

private fun esa(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val len = bits.bitsPerRow[0]
    if (!(len == 176 || len == 160) || bits.numRows != 1) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, 16, len - 16)
    val crc = decryptEsa(b, len / 8 - 2)
    if (crc != ESA_MAGIC_ELV && crc != ESA_MAGIC_GIRA) return DECODE_FAIL_MIC
    val isGira = crc == ESA_MAGIC_GIRA
    // The divisor set at installation, still xored with a byte of the device id.
    val impulseConstant = if (isGira) (b[16] shl 8) or (b[17] xor b[1]) else ((b[14] shl 8) or b[15]) xor b[1]
    if (impulseConstant == 0) return DECODE_FAIL_SANITY
    val impulses = if (isGira) (b[11] shl 8) or b[12] else (b[9] shl 8) or b[10]
    val impulsesTotal = if (isGira) ((b[8] shl 16) or (b[9] shl 8) or b[10]).toLong() else u32be(b, 5)
    val out = data("model" to if (isGira) "Gira-EHZ" else when (b[3]) { 0x01 -> "ESAx000WZ"; 0x03 -> "ESA1000Z"; else -> "ESA-unknown" },
        "id" to ((b[1] shl 8) or b[2]), "impulses" to impulses, "impulses_total" to impulsesTotal, "impulse_constant" to impulseConstant,
        "total_kWh" to round3(impulsesTotal.toDouble() / impulseConstant), "impulse_kWh" to round3(impulses.toDouble() / impulseConstant),
        // The GIRA gives the sequence one fewer bit and uses it for the retry flag.
        "sequence_id" to if (isGira) b[0] and 0x3f else b[0] and 0x7f, "is_retry" to if (isGira) (b[0] shr 6) and 1 else b[0] shr 7,
        "mic" to "CRC")
    if (isGira) { out["status"] = (b[3] shl 8) or b[4]; out["power"] = (b[6] shl 8) or b[7] }
    ctx.emit(out)
    return 1
}

/** A property of the utility meter, not sent: anything derived from it is off by a factor for another calibration. */
private const val SPARSNAS_PULSES_PER_KWH = 1000
private const val SPARSNAS_ID_KEY_SUB = 0x5d38e8cbL
private const val SPARSNAS_BITLEN = 160

/**
 * The payload is xored with a key built from the serial, and the serial is also in the payload, so the one value
 * that decrypts to itself is the answer. The loops stop short of 0xff exactly as upstream's do.
 */
private fun sparsnasBruteForce(buf: UBytes): Long {
    val b5 = buf[5]; val b6 = buf[6]; val b7 = buf[7]; val b8 = buf[8]
    val batteryEnc = buf[17]
    val d3 = b8 xor 0x47
    for (k0 in 0 until 0xff) {
        val d0 = b5 xor k0
        if (d0 > 0x0f) continue
        for (k1 in 0 until 0xff) {
            val d1 = b6 xor k1
            for (k2 in 0 until 0xff) {
                val d2 = b7 xor k2
                val batteryDec = batteryEnc xor k2
                val decSensorId = (d0.toLong() shl 24) or (d1.toLong() shl 16) or (d2.toLong() shl 8) or d3.toLong()
                if (decSensorId > 999999) continue
                for (k4 in 0 until 0xff) {
                    val key = ((k0.toLong() shl 24) or (k4.toLong() shl 16) or (k2.toLong() shl 8) or k1.toLong())
                    if (decSensorId == ((key + SPARSNAS_ID_KEY_SUB) and 0xffffffffL) && batteryDec <= 100) return decSensorId
                }
            }
        }
    }
    return 0
}

/** The sender found so far, kept between bursts: the search is expensive and the answer does not change. */
private object Sparsnas { var sensorId = 0L }

internal fun resetSparsnasSensorId() = synchronized(Sparsnas) { Sparsnas.sensorId = 0 }

private fun sparsnas(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int = synchronized(Sparsnas) {
    val n = bits.bitsPerRow[0]
    if (n < SPARSNAS_BITLEN || n > 260) return DECODE_ABORT_LENGTH
    // Only the last two run-in bytes are checked; the leading ones are corrupted too often to insist on.
    val bitpos = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0xd2, 0x01), 32)
    if (bitpos == n || bitpos + 32 + SPARSNAS_BITLEN > n) return DECODE_ABORT_EARLY
    val buffer = bits.bytes(0, bitpos + 32, SPARSNAS_BITLEN)
    if (crc16(buffer, 18, 0x8005, 0xffff) != ((buffer[18] shl 8) or buffer[19])) return DECODE_FAIL_MIC
    if (Sparsnas.sensorId == 0L) Sparsnas.sensorId = sparsnasBruteForce(buffer)
    val sub = (Sparsnas.sensorId - SPARSNAS_ID_KEY_SUB) and 0xffffffffL
    val key = intArrayOf(((sub ushr 24) and 0xff).toInt(), (sub and 0xff).toInt(), ((sub ushr 8) and 0xff).toInt(), 0x47, ((sub ushr 16) and 0xff).toInt())
    val dec = UBytes(18)
    for (i in 0 until 5) dec[i] = buffer[i]
    for (i in 0 until 13) dec[5 + i] = buffer[5 + i] xor key[i % 5]
    val rcvSensorId = u32be(dec, 5)
    // No sender found, or a different one: the CRC passed, so a real Sparsnäs is on the air.
    if (Sparsnas.sensorId == 0L || rcvSensorId != Sparsnas.sensorId) {
        ctx.emit(data("model" to "Ikea-Sparsnas", "id" to Sparsnas.sensorId, "mic" to "CRC"))
        return 1
    }
    // Two bytes the sender never varies: the check that the key was right.
    if (dec[0] != 0x11) return DECODE_FAIL_SANITY
    if (dec[3] != 0x07) return DECODE_FAIL_SANITY
    val pulses = u32be(dec, 13)
    ctx.emit(data("model" to "Ikea-Sparsnas", "id" to rcvSensorId, "sequence" to ((dec[9] shl 8) or dec[10]),
        "battery_ok" to round2(dec[17] * 0.01), "pulses_per_kWh" to SPARSNAS_PULSES_PER_KWH,
        "cumulative_kWh" to round3(pulses.toDouble() / SPARSNAS_PULSES_PER_KWH), "effect" to ((dec[11] shl 8) or dec[12]),
        "pulses" to pulses, "mode" to (dec[4] xor 0x0f), "mic" to "CRC"))
    1
}

/** Voltage is half a volt per step above 128 V: a neat fit for a socket, unable to express anything below. */
private fun emt7110(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val n = bits.bitsPerRow[0]
    if (n < 120 || n > 140) return DECODE_ABORT_LENGTH
    val offset = bits.search(0, 0, UBytes.of(0xaa, 0x2d, 0xd4), 24) + 24
    if (offset + 96 > n) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, offset, 96)
    if ((sumBytesFull(b, 12) and 0xff) != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "ESIC-EMT7110", "id" to hexOf(u32be(b, 0), 8), "power_W" to round1((((b[4] and 0x3f) shl 8) or b[5]) * 0.5),
        "current_A" to round3(((b[6] shl 8) or b[7]) * 0.001), "voltage_V" to round1((b[8] + 256) * 0.5),
        "energy_kWh" to round2((((b[9] and 0x3f) shl 8) or b[10]) * 0.01), "pairing" to ((b[4] and 0x80) shr 7),
        "connected" to ((b[4] and 0x40) shr 6), "mic" to "CHECKSUM"))
    return 1
}

private val NORGO_TAPS = intArrayOf(0x4880, 0, 0, 0, 0, 0, 0, 0, 0x2080, 0x4000, 0x4000, 0x4000, 0x4000, 0x4000, 0x4000)

private fun norgoNextMask(mask: Int): Int {
    var nMask = mask shr 1
    for (i in 0 until 15) if ((mask and (1 shl i)) != 0) nMask = nMask xor NORGO_TAPS[i]
    return nMask and 0xffff
}

/** A shift register clocked backwards over the message, with its own tap table. */
private fun norgoChecksum(data: UBytes, datalen: Int): Int {
    var mask = 0x0001; var chks = 0
    for (i in datalen - 1 downTo 8) {
        mask = norgoNextMask(mask)
        if (((data[i / 8] shr (i % 8)) and 1) != 0) chks = chks xor mask
    }
    return (chks shr 8) and 0xff
}

/**
 * Two messages told apart by one bit: the gap between flashes (power) or the count since power-up (energy).
 * The frame arrives inverted and least significant bit first.
 */
private fun norgo(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    val n = bits.bitsPerRow[0]
    if (n != 56 && n != 72 && n != 55 && n != 71) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    if (b[0] != (0xfa.inv() and 0xff)) return DECODE_ABORT_EARLY
    if (xorBytes(b, (n - 15) / 8, 1) != 0xff) return DECODE_FAIL_MIC
    bits.invert()
    reflectBytes(b, (n + 1) / 8)
    val deviceId = ((b[1] and 0xf0) shr 4) or ((b[2] and 0x0f) shl 4)
    val channel = ((b[1] and 0x0e) shr 1) + 1
    if ((b[1] and 0x01) == 0) {
        if (norgoChecksum(b, 5 * 8) != b[6]) return DECODE_FAIL_MIC
        ctx.emit(data("model" to "Norgo-NGE101", "id" to deviceId, "channel" to channel,
            // In 1/1024 of a second: shorter means more power drawn.
            "gap" to ((b[2] shr 4) or (b[3] shl 4) or ((b[4] and 0x7f) shl 12)), "mic" to "CRC"))
        return 1
    }
    if (norgoChecksum(b, 7 * 8) != b[8]) return DECODE_FAIL_MIC
    // Thirty-four bits wide; upstream reports the low thirty-two.
    val impulses = ((b[2] shr 4) or (b[3] shl 4) or (b[4] shl 12) or (b[5] shl 20) or ((b[6] and 0x3f) shl 28)).toLong() and 0xffffffffL
    ctx.emit(data("model" to "Norgo-NGE101", "id" to deviceId, "channel" to channel, "impulses" to impulses,
        "battery_ok" to if (((b[6] and 0x40) shr 6) != 0) 0 else 1, "mic" to "CRC"))
    return 1
}

private val MARLEC_PERIOD = mapOf(0xca to "saved_today", 0xcb to "saved_yesterday", 0xcc to "saved_last_7", 0xcd to "saved_last_28", 0xce to "saved_total")

/**
 * Reports how much solar it diverted rather than exported, one period per frame. Runs after Watts-Vision, whose
 * frames satisfy the same CRC; letting the more specific decoder settle a frame first is all that separates them.
 */
private fun marlec(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val n = bits.bitsPerRow[0]
    val start = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91), 48)
    if (start == n) return DECODE_ABORT_EARLY
    if (n < 12 * 8) return DECODE_ABORT_LENGTH
    val lenByte = bits.bytes(0, start + 48, 8)[0]
    if (lenByte > 105) return DECODE_ABORT_LENGTH
    if (start + 56 + (lenByte + 2) * 8 > n) return DECODE_ABORT_LENGTH
    val frame = UBytes(108)
    frame[0] = lenByte
    frame.setAll(bits.bytes(0, start + 56, (lenByte + 2) * 8), 1)
    if (((frame[lenByte + 1] shl 8) or frame[lenByte + 2]) != crc16(frame, lenByte + 1, 0x8005, 0xffff)) return DECODE_FAIL_MIC
    val out = data("model" to "Marlec-Solar", "raw" to hexBytes(frame, lenByte, 1), "mic" to "CRC")
    if (frame[3] == 0x22) {
        out["boost_time"] = frame[6]                     // minutes of manual boost still to run
        out["solar_off"] = frame[7]
        out["tank_hot"] = frame[8]
        out["battery_low"] = frame[13]
        // Signed: the heater can be drawing from the grid rather than the panels.
        out["heating"] = signed(frame[17] or (frame[18] shl 8), 16)
        out["import_val"] = frame[19] or (frame[20] shl 8) or (frame[21] shl 16) or (frame[22] shl 24)
        val savedVal = frame[26] or (frame[27] shl 8) or (frame[28] shl 16) or (frame[29] shl 24)
        MARLEC_PERIOD[frame[25]]?.let { out[it] = savedVal }
    }
    ctx.emit(out)
    return 1
}

/** A byte sum, plus a rule that a payload summing to zero is noise; the button repeats the reading with the top bit set. */
private fun revoltNc5462(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] != 104) return DECODE_ABORT_EARLY
    val b = bits.bb[0]
    val sum = sumBytesFull(b, 11)
    if (sum == 0) return DECODE_FAIL_SANITY
    if ((sum and 0xff) != b[11]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Revolt-NC5462", "id" to (((b[0] and 0x7f) shl 8) or b[1]), "voltage_V" to b[2],
        "current_A" to round2(((b[3] shl 8) or b[4]) * 0.01), "frequency_Hz" to b[5], "power_W" to round2(((b[6] shl 8) or b[7]) * 0.1),
        "power_factor_VA" to round2(b[8] * 0.01), "energy_kWh" to round2(((b[9] shl 8) or b[10]) * 0.01), "button" to (b[0] shr 7),
        "mic" to "CHECKSUM"))
    return 1
}

private const val ZX7717_POWER = 13
private const val ZX7717_ENERGY = 14
private const val ZX7717_POWER_COLD = 17
private const val ZX7717_ENERGY_COLD = 18

/** The length byte alone says live readings or an energy total; the "coldstart" pair has six extra bytes ahead. */
private fun revoltZx7717(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val rowLen = bits.bitsPerRow[0]
    if (rowLen < 15 * 8 || rowLen > 22 * 8) return DECODE_ABORT_EARLY
    val pos = bits.search(0, 0, UBytes.of(0x2a), 8) + 8
    if (pos > 16) return DECODE_ABORT_LENGTH
    val len = rowLen - pos
    val b = bits.bytes(0, pos, len)
    reflectBytes(b, (len + 7) shr 3)
    val msgLen = b[0]
    if (msgLen < 1) return DECODE_FAIL_SANITY
    if (len < (msgLen + 1) * 8) return DECODE_ABORT_LENGTH
    if ((sumBytesFull(b, msgLen) and 0xff) != b[msgLen]) return DECODE_FAIL_MIC
    val out = data("model" to "Revolt-ZX7717", "id" to ((b[2] shl 8) or b[1]), "version" to b[3], "mic" to "CHECKSUM")
    when (msgLen) {
        ZX7717_POWER, ZX7717_POWER_COLD -> {
            val at = if (msgLen == ZX7717_POWER) 7 else 11
            out["current_A"] = round3(((b[at + 1] shl 8) or b[at]) * 0.001)
            out["voltage_V"] = round1(((b[at + 3] shl 8) or b[at + 2]) * 0.1)
            out["power_W"] = round1(((b[at + 5] shl 8) or b[at + 4]) * 0.1)
        }
        ZX7717_ENERGY, ZX7717_ENERGY_COLD -> {
            val at = if (msgLen == ZX7717_ENERGY) 6 else 10
            out["energy_kWh"] = round2(((b[at + 2] shl 16) or (b[at + 1] shl 8) or b[at]) * 0.01)
        }
        else -> return DECODE_FAIL_OTHER
    }
    ctx.emit(out)
    return 1
}

private const val EC3K_PACKET_BYTES = 41

/** A one where the level held, a zero where it changed. */
private fun ec3kSymbolAt(m: UBytes, bit: Int): Int {
    val bit0 = if (bit > 0) bitAt(m, bit - 1) else 0
    return if (bit0 == bitAt(m, bit)) 1 else 0
}

/** Self-synchronizing descrambler: each symbol xored with two earlier ones, so the first seventeen are unusable. */
private fun ec3kDescrambledAt(m: UBytes, bit: Int): Int {
    var out = ec3kSymbolAt(m, bit)
    if (bit > 17) out = out xor ec3kSymbolAt(m, bit - 17)
    if (bit > 12) out = out xor ec3kSymbolAt(m, bit - 12)
    return out
}

/** Fields are nibble-aligned rather than byte-aligned. */
private fun ec3kNibbles(buf: UBytes, start: Int, count: Int): Long {
    var v = 0L
    for (i in 0 until count) v = v * 16 + ((buf[(start + i) shr 1] shr ((1 - ((start + i) and 1)) * 4)) and 0x0f)
    return v
}

/** Counters split far apart show the format grew; the always-zero gaps are checked, worth as much as the CRC. */
private fun ec3kExtract(p: UBytes, ctx: DecodeCtx): Int {
    if (ec3kNibbles(p, 9, 4) != 0L || ec3kNibbles(p, 17, 7) != 0L || ec3kNibbles(p, 62, 5) != 0L || ec3kNibbles(p, 77, 1) != 0L) return DECODE_FAIL_SANITY
    val receivedCrc = 0xffff xor (ec3kNibbles(p, 78, 2) or (ec3kNibbles(p, 80, 2) shl 8)).toInt()
    if (crc16lsb(p, EC3K_PACKET_BYTES - 2, 0x8408, 0xffff) != receivedCrc) return DECODE_FAIL_MIC
    // A 56-bit count of watt-seconds in two halves.
    val energyWs = ec3kNibbles(p, 67, 4) * 0x10000000L + ec3kNibbles(p, 24, 7)
    ctx.emit(data("model" to "Voltcraft-EC3k", "id" to hexOf(ec3kNibbles(p, 1, 4), 4), "power" to round3(ec3kNibbles(p, 31, 4) / 10.0),
        "energy" to round3(energyWs / 3600000.0), "energy2" to round3(ec3kNibbles(p, 39, 6) / 3600000.0),
        "time_total" to (ec3kNibbles(p, 5, 4) or (ec3kNibbles(p, 59, 3) shl 16)),
        "time_on" to (ec3kNibbles(p, 13, 4) or (ec3kNibbles(p, 71, 3) shl 16)),
        "power_max" to round3(ec3kNibbles(p, 35, 4) / 10.0), "reset_counter" to ec3kNibbles(p, 74, 2), "flags" to ec3kNibbles(p, 76, 1),
        "mic" to "CRC"))
    return 1
}

/**
 * The only decoder that finds its own frame boundaries: HDLC-style framing, delimited by exactly six ones with
 * a zero stuffed after any five in the payload. A seventh one means the stream was joined mid-frame: resync.
 */
private fun ec3k(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 90) return DECODE_ABORT_LENGTH
    val row = bits.bb[0]
    val n = bits.bitsPerRow[0]
    val packet = UBytes(EC3K_PACKET_BYTES)
    var rc = DECODE_ABORT_EARLY
    var packetpos = 0; var inPacket = false; var onecount = 0; var recbyte = 0; var recpos = 0
    fun resync() { packetpos = 0; inPacket = false; onecount = 0; recbyte = 0; recpos = 0 }
    var at = 17
    while (rc != 1 && at < n) {
        if (ec3kDescrambledAt(row, at) != 0) {
            if (onecount < 6 && packetpos < EC3K_PACKET_BYTES) {
                onecount++
                recbyte = (recbyte shr 1) or 0x80               // least significant bit first
                if (++recpos == 8 && inPacket) { recpos = 0; packet[packetpos++] = recbyte }
            } else resync()
        } else {
            if (onecount < 5 && packetpos < EC3K_PACKET_BYTES) {
                recbyte = recbyte shr 1
                if (++recpos == 8 && inPacket) { recpos = 0; packet[packetpos++] = recbyte }
            } else if (onecount == 5) {
                // A stuffed zero: drop it and keep the byte alignment.
            } else if (onecount == 6) {
                inPacket = !inPacket
                packetpos = 0; recpos = 0
            } else resync()
            onecount = 0
        }
        if (packetpos >= EC3K_PACKET_BYTES) { rc = ec3kExtract(packet, ctx); resync() }
        at++
    }
    return rc
}

/**
 * The X10 frame, so the address is sent twice with its high nibble flipped. Upstream's prose says both nibbles;
 * its code flips one, and a receiver has to agree with the code.
 */
private fun rfxmeter(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 && bits.numRows != 2) return DECODE_ABORT_LENGTH
    val row = bits.numRows - 1
    if (bits.bitsPerRow[row] != 48) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if ((b[0] xor 0xf0) != b[1]) return DECODE_FAIL_SANITY
    if ((addNibbles(b, 6) and 0x0f) != 0x0f) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "RfxMeter", "id" to b[0], "msg_type" to (b[5] shr 4),
        "msg_value" to ((b[4] shl 16) or (b[2] shl 8) or b[3]), "mic" to "CHECKSUM"))
    return 1
}

/** Amps, not watts, and no identity at all; a long reset limit keeps counting through a quiet house's zero bits. */
private fun ecoeye(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val n = bits.bitsPerRow[0]
    val start = bits.search(0, 0, UBytes.of(0xaa, 0x2d, 0xd4), 24) + 24
    if (start >= n) return DECODE_ABORT_EARLY
    if (start + 40 > n) return DECODE_ABORT_LENGTH
    val msg = bits.bytes(0, start, 40)
    if ((sumBytesFull(msg, 4) and 0xff) != msg[4]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "EcoEye", "current_used_A" to round2(((msg[2] shl 8) or msg[3]) * 0.01),
        "current_pv_A" to round2(((msg[0] shl 8) or msg[1]) * 0.01), "mic" to "CHECKSUM"))
    return 1
}

private val B433 = listOf(433_920_000L)

internal val ENERGY2: List<RDevice> = listOf(
    // Doubtful upstream: no length or preamble check of its own, only the residue.
    dev(117, "ESA1000 / ESA2000 Energy Monitor, GIRA Wetterstation", Mod.OOK_MANCHESTER_ZEROBIT, 260, 0, 3000, disabled = true,
        bands = B433, what = METER_HEAD, decode = ::esa),
    dev(130, "IKEA Sparsnas Energy Meter Monitor", Mod.FSK_PCM, 27, 27, 3000, gapLimit = 1000, bands = listOf(868_000_000L), what = METER_HEAD, decode = ::sparsnas),
    dev(136, "ESIC EMT7110 power meter", Mod.FSK_PCM, 104, 104, 10000, bands = listOf(868_280_000L), what = SOCKET, decode = ::emt7110),
    dev(139, "Norgo NGE101", Mod.OOK_DMC, 486, 972, 2100, tolerance = 120, bands = B433, what = METER_HEAD, decode = ::norgo),
    dev(188, "Marlec Solar iBoost+ sensors", Mod.FSK_PCM, 20, 20, 300, priority = 10, bands = listOf(868_300_000L),
        what = "solar immersion diverter", decode = ::marlec),
    dev(239, "Revolt NC-5642 Energy Meter", Mod.OOK_PWM, 200, 320, 272, syncWidth = 10024, bands = B433, what = SOCKET, decode = ::revoltNc5462),
    dev(274, "Revolt ZX-7717 power meter", Mod.OOK_MANCHESTER_ZEROBIT, 310, 310, 900, bands = B433, what = SOCKET, decode = ::revoltZx7717),
    dev(289, "Voltcraft EnergyCount 3000 (ec3k)", Mod.FSK_PCM, 50, 50, 5000, gapLimit = 3000, tolerance = 5, bands = listOf(868_300_000L),
        what = SOCKET, decode = ::ec3k),
    dev(334, "RfxMeter, RFXPwr", Mod.OOK_PPM, 500, 1500, 5000, gapLimit = 2500, bands = B433, what = "pulse counter for electricity, gas or water", decode = ::rfxmeter),
    dev(351, "Eco-Eye solar PV/grid current monitor", Mod.FSK_PCM, 200, 200, 8100, bands = B433, what = "solar and grid current monitor", decode = ::ecoeye),
)
