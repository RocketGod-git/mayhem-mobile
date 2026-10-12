package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import java.time.LocalDate

/*
 * EcoDHOME, GEO minim+, the BM5-v2 battery monitor and Elster / Honeywell R2S power meters.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): ecodhome.c, geo_minim.c, bm5.c, elster_power_meter.c. Twin of
 * web/src/dsp/r433/devices/energy3.ts.
 */

private val BAND_433 = listOf(433_920_000L)
private val BAND_868 = listOf(868_290_000L)
/** The Elster meters hop across 902.4-927.6 MHz; a fixed receiver sits in the middle. */
private val BAND_915 = listOf(915_000_000L)
private const val HOUSE = "household energy monitor"

/** One byte at an arbitrary bit offset, MSB first. */
private fun bitrowGetByte(row: UBytes, pos: Int) = (((row[pos shr 3] shl 8) or row[(pos shr 3) + 1]) shr (8 - (pos and 7))) and 0xff

/**
 * A clamp and a socket on one protocol, told apart by a type field, and they checksum differently. The
 * transmitter's power bytes each count up from 0x33 and wrap, so the bias comes off inside a byte.
 */
private fun ecodhome(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 128) return DECODE_ABORT_LENGTH
    val start = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0x2d, 0xd4), 32) + 32
    if (start >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    if (start + 12 * 8 >= bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val msg = bits.bytes(0, start, 13 * 8)
    val id = u32be(msg, 0)
    val mType = (msg[4] shl 8) or msg[5]
    if (mType == 0x7700) {
        if (addBytes(msg, 11) != msg[11]) return DECODE_FAIL_MIC
        if (msg[10] != 0x53) return DECODE_FAIL_SANITY
        val subtype = (msg[6] shl 8) or msg[7]
        val out = data("model" to "EcoDHOME-SmartSocket", "type" to "Energy", "id" to id, "message_type" to mType,
            "message_subtype" to subtype, "raw" to ((msg[8] shl 8) or msg[9]), "mic" to "CHECKSUM")
        if (subtype == 0x414b) out["power_W"] = (msg[9] shl 8) or msg[8]
        ctx.emit(out)
        return 1
    }
    if (((addBytes(msg, 9) + 0x35) and 0xff) != msg[9]) return DECODE_FAIL_MIC
    if (msg[10] != 0x55) return DECODE_FAIL_SANITY
    if (msg[11] != 0x00) return DECODE_FAIL_SANITY
    val out = data("model" to "EcoDHOME-Transmitter", "type" to "Energy", "id" to id, "message_type" to mType,
        "raw" to ((msg[6] shl 16) or (msg[7] shl 8) or msg[8]), "mic" to "CHECKSUM")
    if (mType == 0x3eb3) out["power_W"] = (((msg[7] - 0x33) and 0xff) shl 8) or ((msg[6] - 0x33) and 0xff)
    ctx.emit(out)
    return 1
}

/** The clamp: apparent power and how long the sensor has been awake. */
private fun geoMinimCt(ctx: DecodeCtx, buf: UBytes, len: Int): Int {
    if (buf[3] != 5) return DECODE_ABORT_LENGTH
    if (len != 11) return DECODE_ABORT_LENGTH
    var va = 10 * (buf[5] + ((buf[4] and 0x0f) shl 8))
    if ((buf[4] and 0x40) != 0) va += 5
    val out = data("model" to "GEO-minimCT", "type" to "Energy", "id" to hexBytes(buf, 3).uppercase(), "power_VA" to va,
        // The code counts eight-second intervals; the format string in the same file says nine.
        "uptime_s" to 8 * ((buf[6] shl 16) + (buf[7] shl 8) + buf[8]), "mic" to "CRC")
    val flags4 = buf[4] and 0xb0
    if (flags4 != 0x30) out["flags4"] = flags4
    ctx.emit(out)
    return 1
}

private fun pad2(n: Int) = n.toString().padStart(2, '0')

/** The display: real power, the last quarter hour's energy, and its own clock in days since 2007. */
private fun geoMinimDisplay(ctx: DecodeCtx, buf: UBytes, len: Int): Int {
    if (buf[3] != 42) return DECODE_ABORT_LENGTH
    if (len != 48) return DECODE_ABORT_LENGTH
    val watts = 5 * (buf[4] + ((buf[5] and 0x7f) shl 8))
    val wh = buf[14] + ((buf[15] and 0x07) shl 8)
    // A calendar date with no timezone in it, the hazard upstream's own comment warns about.
    val day = LocalDate.of(2007, 1, 1).plusDays((buf[30] + (buf[31] shl 8)).toLong())
    val clock = "${day.year}-${pad2(day.monthValue)}-${pad2(day.dayOfMonth)} ${pad2(buf[32] and 0x1f)}:${pad2(buf[33] and 0x3f)}"
    val out = data("model" to "GEO-minimDP", "type" to "Energy", "id" to hexBytes(buf, 3).uppercase(), "power_W" to watts,
        "energy_kWh" to wh * 0.001, "clock" to clock, "mic" to "CRC")
    val flags5 = buf[5] and 0x80
    if (flags5 != 0) out["flags5"] = flags5
    val flags15 = buf[15] and 0xf8
    if (flags15 != 0x40) out["flags15"] = flags15
    ctx.emit(out)
    return 1
}

private fun geoMinim(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_LENGTH
    // The run-in settles either way up, so both are tried.
    var bitpos = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0x7b, 0xb9), 32) + 32
    if (bitpos >= bits.bitsPerRow[0]) bitpos = bits.search(0, 0, UBytes.of(0x55, 0x55, 0x7b, 0xb9), 32) + 32
    if (bitpos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    var avail = bits.bitsPerRow[0]
    if (bitpos + 32 >= avail) return DECODE_ABORT_LENGTH
    avail -= bitpos
    val buf = UBytes(128)
    bits.extractBytes(0, bitpos, buf, 32)
    val dataLength = buf[3]
    if (dataLength != 0x2a && dataLength != 0x05) return DECODE_ABORT_EARLY
    val bytes = minOf(avail / 8, 128)
    val crcLen = 4 + buf[3]
    if (crcLen + 2 > bytes) return DECODE_FAIL_SANITY
    buf.setAll(bits.bytes(0, bitpos + 32, (bytes - 4) * 8).sub(0, bytes - 4), 4)
    if (crc16(buf, crcLen, 0x8005, 0) != ((buf[crcLen] shl 8) or buf[crcLen + 1])) return DECODE_FAIL_MIC
    return if (dataLength == 0x2a) geoMinimDisplay(ctx, buf, bytes) else geoMinimCt(ctx, buf, bytes)
}

/**
 * Keys the opposite way from everything else on this modulation, so the buffer is turned over first. Voltages
 * are rounded rather than truncated as the sensor's own display does, as upstream chooses.
 */
private fun bm5(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] != 88) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, 0, 88)
    if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[10] == 0) return DECODE_FAIL_MIC
    if (b[6] == 0 && b[7] == 0) return DECODE_FAIL_SANITY
    if (addBytes(b, 10) != b[10]) return DECODE_FAIL_MIC
    val soh = b[3] shr 1
    val soc = b[4] shr 1
    val temp = if ((b[5] and 0x01) != 0) -(b[5] shr 1) else b[5] shr 1
    val batteryV = ((b[7] shl 8) or b[6]) * 0.000625
    val startingV = ((b[9] shl 8) or b[8]) * 0.000625
    // A 12 V lead-acid monitor: anything far outside that is what an eight-bit checksum let through.
    if (soh > 100 || soc > 100 || batteryV < 0 || batteryV > 20 || startingV < 0 || startingV > 20) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "BM5-v2", "type" to "Energy", "id" to ((b[0] shl 16) or (b[1] shl 8) or b[2]), "health_pct" to soh,
        "cranking_error" to (b[4] and 0x01), "charge_pct" to soc, "charging_error" to (b[3] and 0x01), "temperature_C" to temp,
        "battery_V" to round2(batteryV), "starting_V" to round2(startingV), "mic" to "CHECKSUM"))
    return 1
}

private const val ELSTER_MIN_LEN = 9
private const val ELSTER_MAX_LEN = 200
private const val ELSTER2_MIN_LEN = 12
private const val ELSTER2_NBR_MAX = 8

/** CRC-16/X-25: reflected, all-ones init, complemented at the end. */
private fun x25(buf: UBytes, n: Int) = (crc16lsb(buf, n, 0x8408, 0xffff) xor 0xffff) and 0xffff

/**
 * These meters hop and the run-in is never the same length twice, so every bit position is tried; a candidate
 * must give a length in range and a matching CRC exactly where that length says.
 */
private fun elster(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    if (rowBits < (ELSTER_MIN_LEN + 2) * 8) return DECODE_ABORT_LENGTH
    val row = bits.bb[0]
    val buf = UBytes(ELSTER_MAX_LEN + 2)
    var len = 0; var found = -1
    var pos = 0
    while (pos + (ELSTER_MIN_LEN + 2) * 8 <= rowBits) {
        val candLen = bitrowGetByte(row, pos) xor 0x55
        if (candLen in ELSTER_MIN_LEN..ELSTER_MAX_LEN && pos + (candLen + 2) * 8 <= rowBits) {
            for (i in 0 until candLen + 2) buf[i] = bitrowGetByte(row, pos + i * 8) xor 0x55
            if (x25(buf, candLen) == (buf[candLen] or (buf[candLen + 1] shl 8))) { found = pos; len = candLen; break }
        }
        pos++
    }
    if (found < 0) return DECODE_FAIL_MIC
    val flags = buf[1]
    val src = u32be(buf, 2)
    val dst = u32be(buf, 6)
    // Decimal: what the meter prints on its label as the LAN ID.
    val out = data("model" to "Elster-PowerMeter", "type" to "Energy", "id" to src.toString(), "dst" to dst.toString(), "flags" to flags,
        "data_raw" to hexBytes(buf, len - 10, 10), "mic" to "CRC")
    if (len == 40 && flags == 0x08 && dst == 0L) out["frame_type"] = "beacon"
    // An optional hourly-usage sub-command, only in plain meter reports.
    if (src < 0x80000000L && len - 1 > 15) {
        val cmdLen = buf[16]
        if (cmdLen == 0x33 && len - 1 >= 16 + cmdLen) {
            val cmd = buf.sub(17)
            if (cmd[1] == 0xce && cmdLen >= 10) {
                out["ctr"] = cmd[2]
                out["cur_hour"] = (cmd[5] shl 8) or cmd[6]
                out["last_hour"] = (cmd[7] shl 8) or cmd[8]
                val n = minOf(cmd[9], 17)
                val readings = ArrayList<String>()
                var h = 0
                while (h < n && cmdLen >= 10 + 2 * (h + 1)) { readings.add(fixed(((cmd[10 + 2 * h] shl 8) or cmd[11 + 2 * h]) * 0.01, 2)); h++ }
                out["hourly_kWh"] = readings.joinToString(",")
            }
            // Unconfirmed even against upstream's own reference dissector.
            if (cmd[1] == 0xce && cmdLen >= 47) out["reading_kWh"] = (cmd[44] shl 16) or (cmd[45] shl 8) or cmd[46]
        }
    }
    ctx.emit(out)
    return 1
}

/**
 * No Manchester, whitened with 0xaa, a sixteen-bit length that excludes the check. Most bodies are encrypted
 * per meter; in the two cleartext neighbour tables only each record's leading address is read.
 */
private fun elster2(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    if (rowBits < (ELSTER2_MIN_LEN + 2) * 8) return DECODE_ABORT_LENGTH
    val row = bits.bb[0]
    val buf = UBytes(ELSTER_MAX_LEN + 2)
    var len = 0; var found = -1
    var pos = 0
    while (pos + (ELSTER2_MIN_LEN + 2) * 8 <= rowBits) {
        val candLen = ((bitrowGetByte(row, pos) xor 0xaa) shl 8) or (bitrowGetByte(row, pos + 8) xor 0xaa)
        if (candLen in ELSTER2_MIN_LEN..ELSTER_MAX_LEN && pos + (candLen + 2) * 8 <= rowBits) {
            for (i in 0 until candLen + 2) buf[i] = bitrowGetByte(row, pos + i * 8) xor 0xaa
            if (x25(buf, candLen) == (buf[candLen] or (buf[candLen + 1] shl 8))) { found = pos; len = candLen; break }
        }
        pos++
    }
    if (found < 0) return DECODE_FAIL_MIC
    val src = u32be(buf, 3)
    val dst = u32be(buf, 7)
    val isMesh = src >= 0x80000000L
    val msg = if (!isMesh && len > 16) buf[16] else -1
    val out = data("model" to "Elster-PowerMeter2", "type" to "Energy", "id" to src.toString(), "dst" to dst.toString(),
        "mesh" to if (isMesh) 1 else 0, "data_raw" to hexBytes(buf, len - 12, 12), "mic" to "CRC")
    if (msg >= 0) out["msg"] = hexOf(msg)
    // The two classes start their records a byte apart: confirmed on real captures, still unexplained.
    if ((msg == 0x57 || msg == 0x7f) && len > 30) {
        val n = buf[28]
        val recStart = if (msg == 0x57) 30 else 29
        if (n in 1..ELSTER2_NBR_MAX && recStart + n * 20 <= len) out["nbr_ids"] = (0 until n).joinToString(",") { hexBytes(buf, 4, recStart + it * 20) }
    }
    ctx.emit(out)
    return 1
}

internal val ENERGY3: List<RDevice> = listOf(
    // Upstream records no frequency for this one.
    dev(174, "EcoDHOME Smart Socket and MCEE Solar monitor", Mod.FSK_PCM, 250, 250, 6000, what = HOUSE, decode = ::ecodhome),
    dev(224, "GEO minim+ energy monitor", Mod.FSK_PCM, 24, 24, 3000, bands = BAND_868, what = HOUSE, decode = ::geoMinim),
    dev(285, "bm5-v2 12V Battery Monitor", Mod.OOK_PWM, 225, 675, 6000, bands = BAND_433, what = "car battery monitor", decode = ::bm5),
    dev(338, "Elster/Honeywell R2S/REXU power meter", Mod.FSK_MANCHESTER_ZEROBIT, 28, 28, 3000, bands = BAND_915, what = "electricity meter", decode = ::elster),
    dev(373, "Elster/Honeywell R2S/REXU power meter, type-2 frames", Mod.FSK_PCM, 7, 7, 4000, bands = BAND_915, what = "electricity meter", decode = ::elster2),
)
