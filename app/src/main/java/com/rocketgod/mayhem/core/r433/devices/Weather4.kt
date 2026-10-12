package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Ecowitt WH53, Eurochron EFTH-800, Auriol AFT 77 B2, Vauno EN8822C and the Geevon TX16-3 / TX19-1.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): ecowitt.c, eurochron_efth800.c, auriol_aft77b2.c, vauno_en8822c.c,
 * geevon.c, geevon_tx19.c. Twin of web/src/dsp/r433/devices/weather4.ts.
 */

private val BAND_433 = listOf(433_920_000L)
private const val TH = "thermometer and hygrometer"
private fun pad2(n: Int) = n.toString().padStart(2, '0')

/**
 * Only the last four of the seven leading ones are reliable, so twelve bits are searched and the result advanced
 * by four to land on the model byte, which the CRC covers.
 */
private fun ecowitt(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_LENGTH
    val pos = bits.search(0, 0, UBytes.of(0xf5, 0x30), 12)
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] - pos < 52) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, pos + 4, 6 * 8)
    if (crc8(b, 6, 0x31, 0x00) != 0) return DECODE_FAIL_MIC
    val channel = (b[2] shr 4) + 1
    if (channel > 3) return DECODE_FAIL_SANITY
    if ((b[2] and 0x0c) != 0) return DECODE_ABORT_EARLY
    val tempRaw = ((b[2] and 0x03) shl 8) or b[3]
    if (b[4] != 0xff) return DECODE_ABORT_EARLY
    ctx.emit(data("model" to "Ecowitt-WH53", "type" to "Weather", "id" to b[1], "channel" to channel,
        "temperature_C" to round1((tempRaw - 400) * 0.1), "mic" to "CRC"))
    return 1
}

/**
 * A reading and a DCF77 clock frame share the air: the clock is read first while long rows are intact, then
 * every long row is struck out so the reading search cannot pick one up.
 */
private fun efth800(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    var radioClock = ""
    // Upstream tests `> 0`, so a clock in row zero is passed over; kept.
    val clockRow = bits.findRepeatedRow(2, 65)
    if (clockRow > 0) {
        val c = bits.bb[clockRow]
        if (crc8(c, 8, 0x31, 0x00) == 0) {
            val hour = c[2] and 0x1f; val min = c[3] and 0x3f; val sec = c[4] and 0x3f
            val year = c[5] shr 1
            val day = ((c[5] and 0x01) shl 4) or ((c[6] and 0xf0) shr 4)
            val mth = c[6] and 0x0f
            radioClock = "${year + 2000}-${pad2(mth)}-${pad2(day)}T${pad2(hour)}:${pad2(min)}:${pad2(sec)}"
        }
    }
    for (r in 0 until bits.numRows) if (bits.bitsPerRow[r] > 49) bits.bitsPerRow[r] = 0
    val row = bits.findRepeatedRow(2, 48)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 49) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[0] == 0x00 && b[1] == 0x00 && b[2] == 0x00 && b[4] == 0x00) return DECODE_FAIL_SANITY
    if (crc8(b, 6, 0x31, 0x00) != 0) return DECODE_FAIL_MIC
    // A signed ten-bit value high in a sixteen-bit word: the shift back down both sign-extends and scales.
    val tempRaw = (((((b[2] and 0x3f) shl 10) shl 16) shr 16) or ((b[3] and 0xf0) shl 2)) shr 6
    val out = data("model" to "Eurochron-EFTH800", "type" to "Weather", "id" to (((b[0] and 0x0f) shl 8) or b[1]),
        "channel" to ((b[0] and 0x70) shr 4) + 1, "battery_ok" to if ((b[2] shr 7) != 0) 0 else 1,
        "temperature_C" to round1(tempRaw * 0.1), "humidity" to (b[4] shr 4) * 10 + (b[4] and 0x0f), "mic" to "CRC")
    if (radioClock.isNotEmpty()) out["radio_clock"] = radioClock
    ctx.emit(out)
    return 1
}

/** Sixty-eight bits: checks run on bytes realigned past a four-bit prefix, digits are read from the original row. */
private fun aft77b2(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var row = -1
    for (r in 0 until bits.numRows) if (bits.bitsPerRow[r] == 68) { row = r; break }
    if (row < 0) return DECODE_ABORT_EARLY
    val ptr = bits.bb[row]
    if (ptr[0] != 0xa5) return DECODE_ABORT_EARLY
    val frame = UBytes(8)
    for (i in 0 until 8) frame[i] = ((ptr[i] shl 4) or (ptr[i + 1] shr 4)) and 0xff
    if (addBytes(frame, 6) != frame[6]) return DECODE_FAIL_MIC
    if (lfsrDigest8(frame, 6, 0x83, 0xec) != frame[7]) return DECODE_FAIL_MIC
    var tempRaw = (ptr[4] shr 4) * 100 + (ptr[4] and 0x0f) * 10 + (ptr[5] shr 4)
    if ((ptr[3] and 0x08) != 0) tempRaw = -tempRaw
    ctx.emit(data("model" to "Auriol-AFT77B2", "type" to "Weather", "id" to frame[1], "temperature_C" to round2(tempRaw * 0.1), "mic" to "CRC"))
    return 1
}

/** A six-bit nibble sum split across the last two bytes; an all-zero row would check out, so it is refused first. */
private fun vauno(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedPrefix(4, 42)
    if (row < 0) return DECODE_ABORT_EARLY
    val b = bits.bb[row]
    val chk = ((b[4] and 0x0f) shl 2) or (b[5] shr 6)
    val sum = addNibbles(b, 4) + (b[4] shr 4)
    if (sum == 0) return DECODE_ABORT_EARLY
    if ((sum and 0x3f) != chk) return DECODE_FAIL_MIC
    val tempRaw = signed(((b[1] and 0x0f) shl 12) or (b[2] shl 4), 16)
    ctx.emit(data("model" to "Vauno-EN8822C", "type" to "Weather", "id" to b[0], "channel" to ((b[1] and 0x30) shr 4) + 1,
        "battery_ok" to if (((b[4] and 0x10) shr 4) != 0) 0 else 1, "temperature_C" to round1((tempRaw shr 4) * 0.1),
        "humidity" to (b[3] shr 1), "mic" to "CHECKSUM"))
    return 1
}

/** The two Geevons differ only in the last byte's check; three fixed bytes serve as a cheap structural test first. */
private fun geevon(bits: BitBuffer, ctx: DecodeCtx, model: String, verify: (UBytes) -> Boolean): Int {
    bits.invert()
    val row = bits.findRepeatedPrefix(if (bits.numRows > 5) 5 else 3, 72)
    if (row < 0) return DECODE_ABORT_LENGTH
    if (bits.bitsPerRow[row] != 73) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[5] != 0xaa || b[6] != 0x55 || b[7] != 0xaa) return DECODE_FAIL_MIC
    if (!verify(b)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to model, "type" to "Weather", "id" to b[0], "battery_ok" to if ((b[1] shr 7) != 0) 0 else 1,
        "channel" to ((b[1] and 0x30) shr 4) + 1, "temperature_C" to round1((((b[2] shl 4) or (b[3] shr 4)) - 500) * 0.1),
        "humidity" to b[4], "mic" to "CRC"))
    return 1
}

internal val WEATHER4: List<RDevice> = listOf(
    dev(127, "Ecowitt Wireless Outdoor Thermometer WH53/WH0280/WH0281A", Mod.OOK_PWM, 500, 1480, 2000, gapLimit = 1500, bands = BAND_433,
        what = "thermometer", decode = ::ecowitt),
    dev(152, "Eurochron EFTH-800 temperature and humidity sensor", Mod.OOK_PWM, 250, 500, 5500, gapLimit = 900, syncWidth = 750,
        bands = BAND_433, what = "thermometer and hygrometer with a radio clock", decode = ::efth800),
    dev(184, "Auriol AFT 77 B2 temperature sensor", Mod.OOK_PPM, 500, 920, 2275, gapLimit = 1104, bands = BAND_433, what = "thermometer", decode = ::aft77b2),
    dev(230, "Vauno EN8822C", Mod.OOK_PPM, 2000, 4000, 9500, gapLimit = 5000, tolerance = 500, bands = BAND_433, what = TH, decode = ::vauno),
    dev(261, "Geevon TX16-3 outdoor sensor", Mod.OOK_PWM, 250, 500, 1700, gapLimit = 625, syncWidth = 750, bands = BAND_433, what = TH) { _, bits, ctx ->
        geevon(bits, ctx, "Geevon-TX163") { crc8(it, 9, 0x31, 0x7b) == 0 } },
    // Where the two checks coincide this one will claim a TX16-3 frame too: a property of the protocols.
    dev(291, "Geevon TX19-1 outdoor sensor", Mod.OOK_PWM, 250, 500, 1700, gapLimit = 625, syncWidth = 750, bands = BAND_433, what = TH) { _, bits, ctx ->
        geevon(bits, ctx, "Geevon-TX191") { lfsrDigest8Reverse(it, 8, 0x98, 0x25) == it[8] } },
)
