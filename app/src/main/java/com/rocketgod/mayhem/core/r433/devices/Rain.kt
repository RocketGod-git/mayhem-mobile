package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Rain gauges and small sensors: Biltema, RainPoint soil probe, Atech WS-308, EMOS E6016 station and rain gauge,
 * Rubicson pool thermometer, Baldr rain gauge and thermo-hygrometer, Schou 72543.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): bt_rain.c, rainpoint.c, atech_ws308.c, emos_e6016.c, emos_e6016_rain.c,
 * rubicson_pool_48942.c, baldr_rain.c, schou_72543_rain.c, baldr_e0666th.c. Twin of web/src/dsp/r433/devices/rain.ts.
 */

private val BAND_433 = listOf(433_920_000L)
private fun pad2(n: Int) = n.toString().padStart(2, '0')
private fun int16(x: Int) = signed(x, 16)

/**
 * Off upstream: the checksum nibble has never been worked out. The same three bits are read as the top of the
 * rain counter and as the channel, and the rain arithmetic tries to undo a wrap; all kept exactly as written.
 */
private fun btRain(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(4, 36)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 36 && bits.bitsPerRow[row] != 37) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[0] == 0xff && b[1] == 0xff && b[2] == 0xff && b[3] == 0xff) return DECODE_FAIL_SANITY
    val button = (b[1] and 0x08) shr 3
    val tempC = (int16(((b[1] and 0x07) shl 13) or (b[2] shl 5)) shr 5) * 0.1
    var rain = ((b[1] and 0x07) shl 4) or b[3]
    val rest = rain % 25
    rain += if (rest % 2 != 0) (rest / 2) * 2048 else ((rest + 1) / 2) * 2048 + 12 * 2048
    ctx.emit(data("model" to "Biltema-Rain", "type" to "Weather", "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1,
        "battery_ok" to if ((b[1] shr 7) != 0) 0 else 1, "transmit" to if (button != 0) "MANUAL" else "AUTO",
        "temperature_C" to round1(tempC), "rain_rate_mm_h" to round2(rain * 0.052), "button" to button))
    return 1
}

/**
 * The gap between packets is carrier, not silence, so the burst is one long row. The search backs up two bits:
 * the sync's tail is also the first Manchester symbol of the payload. Then invert and reflect before the sum.
 */
private fun rainpointSoil(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 232 || bits.bitsPerRow[0] > 3000) return DECODE_ABORT_EARLY
    val pos = bits.search(0, 0, UBytes.of(0xaa, 0xa9), 16)
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val start = pos + 16 - 2
    val msg = BitBuffer()
    val end = bits.manchesterDecode(0, start, msg, 12 * 8)
    if (end - start != 12 * 2 * 8) return DECODE_ABORT_LENGTH
    msg.invert()
    val b = msg.bb[0]
    reflectBytes(b, 12)
    if (addNibbles(b, 10) != b[10]) return DECODE_FAIL_MIC
    // Upstream's channel guesses, carried through unchanged.
    val flags = b[4]
    val chan = when (flags) { 0x9f -> 1; 0xb1 -> 2; 0xb7 -> 3; else -> 0 }
    ctx.emit(data("model" to "RainPoint-Soil", "type" to "Weather", "id" to ((b[2] shl 8) or b[3]), "channel" to chan,
        "sync" to ((b[0] shl 8) or b[1]), "flags" to flags, "status" to ((b[5] shl 8) or b[6]), "temperature_C" to signed(b[7], 8),
        "moisture" to b[8], "mic" to "CHECKSUM"))
    return 1
}

/** Pulse widths inside RZ: one leading one is a zero bit, three a one bit, anything else a violation that stops the decode. */
private fun pwmOfPcmDecode(row: UBytes, bitLen: Int, out: UBytes, outLen: Int): Int {
    var pos = 0; var cnt = 0
    for (i in 0 until bitLen) {
        if ((row[i shr 3] and (1 shl (7 - (i % 8)))) != 0) { cnt++; continue }
        if (pos % 8 == 0) out[pos shr 3] = 0
        when (cnt) {
            1 -> pos++
            3 -> { out[pos shr 3] = out[pos shr 3] or (1 shl (7 - (pos % 8))); pos++ }
            else -> return pos
        }
        if (pos >= outLen) break
        cnt = 0
    }
    return pos
}

/** A run-in row then the data row; three BCD digits and a sign bit; an even parity fold over seven nibbles. */
private fun atechWs308(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 2) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[1] < 58) return DECODE_ABORT_LENGTH
    val b = UBytes(4)
    if (pwmOfPcmDecode(bits.bb[1], bits.bitsPerRow[1], b, 32) < 28) return DECODE_ABORT_LENGTH
    var chk = xorBytes(b, 3)
    chk = ((chk xor b[3]) shr 4) xor (chk and 0x0f)
    if (chk != 0) return DECODE_FAIL_MIC
    val tempRaw = (b[1] and 0x0f) * 100 + (b[2] shr 4) * 10 + (b[2] and 0x0f)
    val sign = if ((b[1] and 0x20) != 0) -1 else 1
    // Adding zero turns a negative zero into a plain one.
    ctx.emit(data("model" to "Atech-WS308", "type" to "Weather", "id" to b[0], "temperature_C" to round1(sign * tempRaw * 0.1) + 0.0, "mic" to "PARITY"))
    return 1
}

/**
 * The model preamble is matched on raw air bytes before inversion, everything else after. The E6018 has no wind
 * sensor and a free-running clock, so those fields are only reported for the full station. The repeat check
 * skips the last byte, a deliberately changing counter.
 */
private fun emosE6016(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedPrefix(3, 120 - 8)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 120) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[0] != 0x55 || b[1] != 0x5a || b[2] != 0x7c) return DECODE_ABORT_EARLY
    bits.invert()
    if (addBytes(b, 13) != b[13]) return DECODE_FAIL_MIC
    val isE6018 = ((b[4] shr 6) and 0x03) != 2
    val dt = ((b[4] and 0x3f).toLong() shl 26) or (b[5].toLong() shl 18) or (b[6].toLong() shl 10) or (b[7].toLong() shl 2) or (b[8] shr 6).toLong()
    fun f(shift: Int, mask: Long) = ((dt ushr shift) and mask).toInt()
    val clock = "${f(26, 0x3f) + 2000}-${pad2(f(22, 0x0f))}-${pad2(f(17, 0x1f))}T${pad2(f(12, 0x1f))}:${pad2(f(6, 0x3f))}:${pad2(f(0, 0x3f))}"
    val tempC = (int16(((b[8] and 0x0f) shl 12) or (b[9] shl 4)) shr 4) * 0.1
    val out = data("model" to if (isE6018) "EMOS-E6018" else "EMOS-E6016", "type" to "Weather", "id" to b[3],
        "channel" to ((b[8] shr 4) and 0x03) + 1, "battery_ok" to ((b[12] shr 2) and 0x01), "temperature_C" to round1(tempC), "humidity" to b[10])
    if (!isE6018) {
        out["wind_avg_m_s"] = round1(b[11] * 0.295)
        out["wind_dir_deg"] = round1((b[12] shr 4) * 22.5)
        out["radio_clock"] = clock
    }
    out["mic"] = "CHECKSUM"
    ctx.emit(out)
    return 1
}

/**
 * The station's rain gauge, 0x75 where the station has 0x7c. Upstream's "after inversion" example disagrees with
 * its raw capture; the raw capture is the one whose checksum holds, and that is what is followed.
 */
private fun emosRain(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(3, 72)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] < 72 || bits.bitsPerRow[row] > 73) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[0] != 0x55 || b[1] != 0x5a || b[2] != 0x75) return DECODE_ABORT_EARLY
    bits.invert()
    if (addBytes(b, 8) != b[8]) return DECODE_FAIL_MIC
    val rainRaw = ((b[6] and 0x0f) shl 8) or b[7]
    ctx.emit(data("model" to "EMOS-E6016R", "type" to "Weather", "id" to b[3], "battery_ok" to if ((b[4] shr 6) != 0) 1 else 0,
        "rain_mm" to round1(rainRaw * 0.7), "mic" to "CHECKSUM"))
    return 1
}

/** A real CRC, with every check after inversion; the channel also sets the 55 s + channel transmit interval. */
private fun rubicsonPool(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 41)
    if (row < 0 || bits.bitsPerRow[row] != 41) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    bits.invert()
    if ((b[3] and 0x0f) != 0 || b[5] != 0) return DECODE_ABORT_EARLY
    if (b[0] == 0 && b[2] == 0 && b[4] == 0) return DECODE_ABORT_EARLY
    if (crc8(b, 4, 0x31, 0x00) != b[4]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Rubicson-48942", "type" to "Weather", "channel" to (b[0] shr 4) + 1,
        "id" to (((b[0] and 0x0f) shl 6) or ((b[1] and 0xfc) shr 2)), "battery_ok" to if ((b[2] shr 7) != 0) 0 else 1,
        "temperature_C" to round1(((((b[2] and 0x7f) shl 4) or (b[3] shr 4)) - 1024) * 0.1), "mic" to "CRC"))
    return 1
}

/** No checksum at all, so off upstream and run late, letting Rubicson-Temperature settle a shared frame first. */
private fun baldrRain(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(3, 36)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 37) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if ((b[0] == 0 && b[2] == 0 && b[3] == 0) || (b[0] == 0xff && b[2] == 0xff && b[3] == 0xff)) return DECODE_ABORT_EARLY
    ctx.emit(data("model" to "Baldr-Rain", "type" to "Weather", "id" to ((b[0] shl 4) or (b[1] shr 4)), "flags" to (b[1] and 0x0f),
        "rain_in" to round3(((b[2] shl 12) or (b[3] shl 4) or (b[4] shr 4)) * 0.001)))
    return 1
}

/**
 * The sum is taken at full width: upstream rejects a zero sum before narrowing, and a masked sum would discard
 * frames summing to a nonzero multiple of 256. A fresh gauge reads 6552.6 mm and counts down.
 */
private fun schou(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 2) return DECODE_ABORT_LENGTH
    val row = bits.findRepeatedPrefix(2, 64)
    if (row < 0) return DECODE_ABORT_EARLY
    val b = bits.bb[row]
    var sum = 0
    for (i in 0 until 7) sum += b[i]
    if (sum == 0) return DECODE_ABORT_EARLY
    if (b[7] != (sum and 0xff)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Schou-72543", "type" to "Weather", "id" to ((b[0] shl 8) or b[1]),
        "temperature_F" to round1((((b[6] shl 8) or b[5]) - 900) * 0.1), "rain_mm" to round1(((b[4] shl 8) or b[3]) * 0.1),
        "battery_ok" to if ((b[2] and 0x80) != 0) 0 else 1, "msg_counter" to ((b[2] and 0x0e) shr 1),
        "msg_repeat" to if ((b[2] and 0x40) != 0) 1 else 0, "mic" to "CHECKSUM"))
    return 1
}

/**
 * No checksum, but eight matching rows and about eighteen fixed bits, a stronger filter than some real checksums.
 * The id spans both ends of the frame and survives battery changes; startup clears ten to fifteen minutes in.
 */
private fun baldrTherm(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(8, 64)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 65) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if ((b[1] and 0x40) != 0 || (b[3] and 0xf0) != 0xf0 || (b[4] and 0x0f) != 0 || b[5] != 0 || (b[6] and 0xf7) != 0) return DECODE_ABORT_EARLY
    val tempC = (int16((b[1] shl 12) or (b[2] shl 4)) shr 4) * 0.1
    ctx.emit(data("model" to "Baldr-E0666TH", "type" to "Weather", "id" to ((b[0] shl 8) or b[7]), "channel" to ((b[1] and 0x30) shr 4) + 1,
        "battery_ok" to if ((b[1] and 0x80) != 0) 1 else 0, "temperature_C" to round1(tempC), "humidity" to (((b[3] shl 4) or (b[4] shr 4)) and 0xff),
        "startup" to if ((b[6] and 0x08) != 0) 1 else 0))
    return 1
}

internal val RAIN: List<RDevice> = listOf(
    dev(118, "Biltema rain gauge", Mod.OOK_PPM, 1940, 3900, 8800, gapLimit = 4100, disabled = true, bands = BAND_433, what = "rain gauge", decode = ::btRain),
    dev(195, "RainPoint soil temperature and moisture sensor", Mod.OOK_PCM, 500, 500, 1500, bands = BAND_433,
        what = "soil temperature and moisture probe", decode = ::rainpointSoil),
    dev(196, "Atech-WS308 temperature sensor", Mod.OOK_PCM, 1600, 1832, 9000, gapLimit = 2500, bands = BAND_433, what = "thermometer", decode = ::atechWs308),
    dev(214, "EMOS E6016 weatherstation with DCF77, EMOS E6018 temperature/humidity sensor", Mod.OOK_PWM, 280, 796, 850, gapLimit = 3000,
        syncWidth = 1836, bands = BAND_433, what = "weather station with a radio clock", decode = ::emosE6016),
    dev(217, "EMOS E6016 rain gauge", Mod.OOK_PWM, 300, 800, 2500, gapLimit = 1000, bands = BAND_433, what = "rain gauge", decode = ::emosRain),
    dev(222, "Rubicson Pool Thermometer 48942", Mod.OOK_PWM, 280, 480, 6000, gapLimit = 5000, syncWidth = 730, bands = BAND_433,
        what = "pool thermometer", decode = ::rubicsonPool),
    dev(242, "Baldr / RainPoint rain gauge", Mod.OOK_PPM, 1000, 2000, 5000, gapLimit = 3000, priority = 10, disabled = true, bands = BAND_433,
        what = "rain gauge", decode = ::baldrRain),
    dev(250, "Schou 72543 Day Rain Gauge, Motonet MTX, MarQuant, TFA Dostmann 30.3252.01, ADE WS1907", Mod.OOK_PWM, 972, 2680, 2712,
        syncWidth = 7328, bands = BAND_433, what = "rain gauge and thermometer", decode = ::schou),
    dev(284, "Baldr E0666TH Thermo-Hygrometer", Mod.OOK_PPM, 1000, 2000, 5000, gapLimit = 3000, bands = BAND_433,
        what = "thermometer and hygrometer", decode = ::baldrTherm),
)
