package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Emos TTX201, Arexx Multilogger, the TFA 30.3307.02 wind sensor and the Hideki TS04 family.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): ttx201.c, arexx_ml.c, tfa_30_3307.c, hideki.c. Twin of
 * web/src/dsp/r433/devices/weather6.ts.
 */

private val BAND_433 = listOf(433_920_000L)
private fun pad2(n: Int) = n.toString().padStart(2, '0')

/** Fifty-four bits with two leading pad bits, so everything is read from bit two; the last repeat is two bits shorter. */
private fun ttx201Packet(bits: BitBuffer, row: Int, ctx: DecodeCtx): Int {
    val rowlen = bits.bitsPerRow[row]
    if (rowlen != 50 && rowlen != 54) return DECODE_ABORT_LENGTH
    val b = bits.bytes(row, 2, 56)
    val chk = b[0] and 0x3f
    val sum = addNibbles(b, 5, 1)
    val dataType = (b[2] and 0x70) shr 4
    if (sum == 0) return DECODE_ABORT_EARLY
    if (chk != (sum and 0x3f)) return DECODE_FAIL_MIC
    if (dataType == 0x05) {
        // A time broadcast was heard, so this repeat carries a clock instead of a reading.
        val year = b[1] and 0x7f; val month = b[2] and 0x0f; val day = (b[3] and 0xf8) shr 3
        val hour = ((b[3] and 0x07) shl 2) or ((b[4] and 0xc0) shr 6); val minute = b[4] and 0x3f; val second = (b[5] and 0x7e) shr 1
        val zone = if ((b[1] and 0x80) != 0) "CEST" else "CET"
        ctx.emit(data("model" to "Emos-TTX201", "type" to "Weather",
            "radio_clock" to "${year + 2000}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)} $zone", "mic" to "CHECKSUM"))
        return 1
    }
    val raw = signed(((b[3] and 0x0f) shl 12) or (b[4] shl 4), 16)
    ctx.emit(data("model" to "Emos-TTX201", "type" to "Weather", "id" to b[1], "channel" to (b[2] and 0x07) + 1,
        "battery_ok" to if ((b[2] and 0x08) != 0) 0 else 1, "temperature_C" to round1((raw shr 4) * 0.1), "mic" to "CHECKSUM"))
    return 1
}

/** A preamble row, eight repeats and a stray bit; one good repeat is the whole message. */
private fun ttx201(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var ret = 0; var events = 0
    if (bits.numRows in 2..10) {
        for (row in 0 until bits.numRows) {
            ret = ttx201Packet(bits, row, ctx)
            if (ret > 0) events += ret
            if (events != 0) return events
        }
    }
    return if (events > 0) events else ret
}

private fun arexxHumidity(raw: Int): Double { val s = signed(raw, 16); return round1(-2.0468 + 0.0367 * s - 1.5955e-6 * s * s) }

/**
 * The length byte picks the layout and the id's low bits pick the reading, odd for humidity; id ranges mean
 * different silicon. Upstream's comment gives CRC init 0xc0, its code 0x00, and its examples verify with 0x00.
 */
private fun arexx(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] < 64 || bits.bitsPerRow[0] > 140) return DECODE_ABORT_EARLY
    bits.invert()
    val preamble = UBytes.of(0xaa, 0xaa, 0x55)
    val b = UBytes(9)
    var msgLen = -1
    for (i in 0 until bits.numRows) {
        val pos = bits.search(i, 0, preamble, 24) + 24
        if (pos + 64 > bits.bitsPerRow[i]) continue
        bits.extractBytes(i, pos, b, 9 * 8)
        msgLen = b[0]
        break
    }
    if (msgLen <= 0) return DECODE_FAIL_SANITY
    if (msgLen > 7) return DECODE_FAIL_SANITY
    if (crc8le(b, msgLen, 0x31, 0x00) != b[msgLen]) return DECODE_FAIL_MIC
    var id = (b[2] shl 8) or b[1]
    var sensRaw = (b[3] shl 8) or b[4]
    val out = data("model" to "Arexx-ML", "type" to "Weather", "mic" to "CRC")
    when {
        msgLen == 5 && (id and 0xf000) == 0x2000 -> out["temperature_C"] = round2(signed(sensRaw, 16) * 0.0078125)
        msgLen == 5 && (id and 0xf001) == 0x4000 -> out["temperature_C"] = round2(sensRaw * 0.01 - 40.0)   // offset drifts with supply
        msgLen == 5 && (id and 0xf001) == 0x4001 -> { sensRaw = signed(sensRaw, 16); out["humidity"] = arexxHumidity(sensRaw) }
        msgLen == 6 -> {
            // Three alert bits above a signed thirteen-bit ambient reading.
            out["temperature_alert"] = (sensRaw shr 13) and 7
            out["temperature_C"] = (((sensRaw shl 3) shl 16) shr 16) / 128.0
        }
        msgLen == 7 -> {
            // A wider id pushes the reading along by a byte.
            id = (b[3] shl 16) or (b[2] shl 8) or b[1]
            sensRaw = (b[5] shl 8) or b[6]
            if ((id and 1) != 0) { sensRaw = signed(sensRaw, 16); out["humidity"] = arexxHumidity(sensRaw) }
            else out["temperature_C"] = round2(sensRaw * 0.01 - 40.0)
        }
    }
    out["id"] = id
    out["sensor_raw"] = sensRaw and 0xffff
    ctx.emit(out)
    return 1
}

/**
 * The most heavily coded frame here: return-to-zero inverted, then differential phase, differential NRZ-S and a
 * G3RUH descrambler (taps 16 and 11) before a sync word appears. The CRC-32 init is chosen per WeatherHub sensor
 * type and only the wind sensor's is known. Of the six readings carried, the latest is reported.
 */
private fun tfa303307(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val len = bits.bitsPerRow[0]
    val row = bits.bb[0]
    var lastBit = 0; var psk = 0; var lastPsk = 0; var nrzs = 0
    var lfsr = 0; var sr = 0; var srCount = -1
    val rdata = UBytes(48)
    var byteCount = 0
    var i = 0
    while (i < len && byteCount < rdata.size) {
        val bit = bitAt(row, i)
        if (bit == lastBit) psk = 1 - psk
        if (psk == lastPsk) nrzs = 1 - nrzs
        lastBit = bit; lastPsk = psk
        val descrambled = nrzs xor ((lfsr ushr 16) and 1) xor ((lfsr ushr 11) and 1)
        lfsr = (lfsr shl 1) or nrzs
        sr = (sr ushr 1) or (descrambled shl 31)
        if (sr == 0x2bd42d4b) {
            srCount = 0
            rdata[0] = sr and 0xff; rdata[1] = (sr ushr 8) and 0xff; rdata[2] = (sr ushr 16) and 0xff
            byteCount = 3
        }
        if (srCount == 0) { rdata[byteCount] = (sr ushr 24) and 0xff; byteCount++ }
        if (srCount >= 0) srCount = (srCount + 1) and 7
        i++
    }
    if (byteCount < 12) return DECODE_ABORT_LENGTH
    val plen = rdata[4]
    if (plen < 11 || plen + 4 > byteCount) return DECODE_ABORT_LENGTH
    if (rdata[5] != 0x0b) return DECODE_ABORT_EARLY
    var crc = 0xe7720ae4.toInt()
    for (k in 4 until plen) {
        crc = crc xor (rdata[k] shl 24)
        for (j in 0 until 8) crc = if (crc < 0) (crc shl 1) xor 0x04c11db7 else crc shl 1
    }
    if (crc.toLong() and 0xffffffffL != u32be(rdata, plen)) return DECODE_FAIL_MIC
    if (plen - 11 < 7) return DECODE_FAIL_SANITY
    val v = u32be(rdata.sub(11), 3)
    // Nine-bit fields whose top bit sits apart from the other eight.
    ctx.emit(data("model" to "TFA-303307", "type" to "Weather", "id" to hexBytes(rdata, 6, 5), "wind_dir_deg" to round1(22.5 * (v ushr 28)),
        "wind_avg_m_s" to round1((((v ushr 16) and 0xff) + 256 * ((v ushr 25) and 1)) / 10.0),
        "wind_max_m_s" to round1((((v ushr 8) and 0xff) + 256 * ((v ushr 24) and 1)) / 10.0), "mic" to "CRC"))
    return 1
}

/** Which sensor is talking is decided purely by how many bytes survive unstuffing. */
private const val HIDEKI_WIND = 14
private const val HIDEKI_TS04 = 10
private const val HIDEKI_RAIN = 9
private const val HIDEKI_TEMP = 8
/** The vane's sixteen positions are not in compass order on the wire. */
private val HIDEKI_WIND_DIR = intArrayOf(0, 15, 13, 14, 9, 10, 12, 11, 1, 2, 4, 3, 8, 7, 5, 6)
private val HIDEKI_APPROACH = intArrayOf(0, 1, -1, 2)

/**
 * A parity bit after every byte. Upstream inverts the shared buffer inside its row loop, so a second pass sees it
 * the right way up and fails its own run-in check; preserved, since that is what decides real traffic. A parity
 * failure on the very first byte reads as "no error" upstream and falls to the checksums, which catch it.
 */
private fun hideki(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var ret = 0
    for (row in 0 until bits.numRows) {
        var unstuffedLen = (bits.bitsPerRow[row] + 4) / 9
        val sensorType = unstuffedLen
        if (unstuffedLen != HIDEKI_WIND && unstuffedLen != HIDEKI_TS04 && unstuffedLen != HIDEKI_RAIN && unstuffedLen != HIDEKI_TEMP) {
            ret = DECODE_ABORT_LENGTH; continue
        }
        unstuffedLen -= 1
        val b = bits.bb[row]
        var sync = (b[0] shl 1) or (b[1] shr 7)
        var startpos = -1
        for (i in 0 until 4) { if (sync == 0x0d) { startpos = 9 - i; break }; sync = sync shr 1 }
        if (startpos < 0) { ret = DECODE_ABORT_EARLY; continue }
        bits.invert()
        val packet = UBytes(14)
        var unstuffError = 0
        for (i in 0 until unstuffedLen) {
            val offset = startpos + i * 9
            packet[i] = ((b[offset / 8] shl (offset % 8)) or (b[offset / 8 + 1] shr (8 - (offset % 8)))) and 0xff
            val parity = (b[offset / 8 + 1] shr (7 - (offset % 8))) and 1
            if (parity != parity8(packet[i])) { ret = DECODE_FAIL_MIC; unstuffError = i; break }
        }
        if (unstuffError != 0) continue
        if (xorBytes(packet, unstuffedLen - 1) != 0) { ret = DECODE_FAIL_MIC; continue }
        if (crc8(packet, unstuffedLen, 0x07, 0x00) != 0) { ret = DECODE_FAIL_MIC; continue }
        reflectBytes(packet, unstuffedLen)
        val pktLen = (packet[1] shr 1) and 0x1f
        if (pktLen + 2 != unstuffedLen) { ret = DECODE_ABORT_LENGTH; continue }
        var channel = (packet[0] shr 5) and 0x0f
        if (channel >= 5) channel -= 1                   // channel 5 is spelled 6 on the wire
        var temp = (packet[4] and 0x0f) * 100 + ((packet[3] and 0xf0) shr 4) * 10 + (packet[3] and 0x0f)
        if (((packet[4] shr 7) and 1) == 0) temp = -temp
        fun base(model: String) = data("model" to model, "type" to "Weather", "id" to (packet[0] and 0x0f), "channel" to channel,
            "battery_ok" to ((packet[4] shr 6) and 1), "mic" to "CRC")
        when (sensorType) {
            HIDEKI_TS04 -> {
                val out = base("Hideki-TS04")
                out["temperature_C"] = round1(temp / 10.0)
                out["humidity"] = ((packet[5] and 0xf0) shr 4) * 10 + (packet[5] and 0x0f)
                ctx.emit(out)
            }
            HIDEKI_WIND -> {
                val out = base("Hideki-Wind")
                out["temperature_C"] = round1(temp * 0.1)
                out["wind_avg_mi_h"] = round2(((packet[8] and 0x0f) * 100 + (packet[7] shr 4) * 10 + (packet[7] and 0x0f)) * 0.1)
                out["wind_max_mi_h"] = round2(((packet[9] shr 4) * 100 + (packet[9] and 0x0f) * 10 + (packet[8] shr 4)) * 0.1)
                out["wind_approach"] = HIDEKI_APPROACH[(packet[10] shr 2) and 0x03]
                out["wind_dir_deg"] = round1(HIDEKI_WIND_DIR[(packet[10] and 0xf0) shr 4] * 225 * 0.1)
                ctx.emit(out)
            }
            HIDEKI_TEMP -> {
                val out = base("Hideki-Temperature")
                out["temperature_C"] = round1(temp * 0.1)
                ctx.emit(out)
            }
            HIDEKI_RAIN -> {
                val out = base("Hideki-Rain")
                out["battery_ok"] = (packet[1] shr 6) and 1     // the rain gauge keeps its battery bit elsewhere
                out["rain_mm"] = round1(((packet[4] shl 8) or packet[3]) * 0.7)
                ctx.emit(out)
            }
            else -> return DECODE_FAIL_SANITY
        }
        return 1
    }
    return ret
}

internal val WEATHER6: List<RDevice> = listOf(
    dev(111, "Emos TTX201 Temperature Sensor", Mod.OOK_MANCHESTER_ZEROBIT, 510, 0, 1700, tolerance = 250, bands = BAND_433,
        what = "thermometer with a radio clock", decode = ::ttx201),
    dev(264, "Arexx Multilogger IP-HA90, IP-TH78EXT, TSN-70E", Mod.FSK_MANCHESTER_ZEROBIT, 208, 208, 450, bands = BAND_433,
        what = "temperature and humidity logger", decode = ::arexx),
    dev(367, "TFA 30.3307.02 Wind sensor", Mod.OOK_RZI, 30, 167, 500, bands = BAND_433, what = "wind sensor", decode = ::tfa303307),
    dev(42, "HIDEKI TS04 Temperature, Humidity, Wind and Rain Sensor", Mod.OOK_DMC, 520, 1040, 4000, tolerance = 240, bands = BAND_433,
        what = "weather station: temperature, humidity, wind and rain", decode = ::hideki),
)
