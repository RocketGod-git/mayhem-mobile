package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Barbecue and meat thermometers: the Maverick family, Quigg GT-TMBBQ-05, Burnhard, Gasmate, RF-T0912 and the
 * Typhur Sync Gold.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): maverick_et73x.c, maverick_et73.c, maverick_xr30.c, maverick_xr50.c,
 * gt_tmbbq05.c, burnhardbbq.c, gasmate_ba1008.c, grill_thermometer.c, typhur_sync_gold.c. Twin of
 * web/src/dsp/r433/devices/grill.ts.
 */

private val BANDS = listOf(433_920_000L)
private const val TWO_PROBES = "barbecue thermometer, two probes"

private fun sumNibbles(b: UBytes, n: Int): Int { var s = 0; for (i in 0 until n) s += (b[i] shr 4) + (b[i] and 0x0f); return s }

/**
 * Manchester inside Manchester: the radio layer yields another coded stream, 104 half-bits for 52 real ones. The
 * digest covers a serial the sensor never sends, so it can only be turned back into that serial: the session id.
 */
private fun et73x(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] != 104) return DECODE_ABORT_LENGTH
    val raw = bits.bb[0]
    if (raw[0] != 0x55 || raw[1] != 0x66 || raw[2] != 0x6a) return DECODE_ABORT_EARLY
    val mc = BitBuffer()
    bits.manchesterDecode(0, 0, mc, 104)
    if (mc.bitsPerRow[0] < 52) return DECODE_FAIL_SANITY
    val b = mc.bb[0]
    val flags = b[1] and 0x0f
    val temp1 = (b[2] shl 2) or ((b[3] and 0xc0) shr 6)
    val temp2 = ((b[3] and 0x3f) shl 4) or ((b[4] and 0xf0) shr 4)
    val digest = ((b[4] and 0x0f) shl 12) or (b[5] shl 4) or (b[6] shr 4)
    val id = lfsrDigest16(mc.bytes(0, 12, 24), 3, 0x8810, 0xdd38) xor digest
    ctx.emit(data("model" to "Maverick-ET73x", "id" to id, "status" to when (flags) { 2 -> "default"; 7 -> "init"; else -> "unknown" },
        "temperature_1_C" to temp1 - 532, "temperature_2_C" to temp2 - 532))
    return 1
}

/** The ThermoPro TP12's frame; the last two bytes are unexplained, so repetition is the entire check. */
private fun et73(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(3, 48)
    if (row < 0) return DECODE_ABORT_EARLY
    val b = bits.bb[row]
    if ((b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0) || (b[0] == 0xff && b[1] == 0xff && b[2] == 0xff && b[3] == 0xff)) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 48) return DECODE_ABORT_LENGTH
    ctx.emit(data("model" to "Maverick-ET73", "id" to b[0],
        "temperature_1_C" to round1((signed((b[1] shl 8) or (b[2] and 0xf0), 16) shr 4) * 0.1),
        "temperature_2_C" to round1((signed(((b[2] and 0x0f) shl 12) or (b[3] shl 4), 16) shr 4) * 0.1)))
    return 1
}

/** The ET-73x payload on FSK; a lost leading bit turns 0xaa into 0x55, so the first byte picks the alignment. */
private fun xr30(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] != 104) return DECODE_ABORT_LENGTH
    val b = when (bits.bb[0][0]) { 0x55 -> bits.bytes(0, 7, 12 * 8); 0xaa -> bits.bytes(0, 8, 12 * 8); else -> return DECODE_ABORT_EARLY }
    if (b[0] != 0xaa || b[1] != 0xaa || b[2] != 0xaa || b[3] != 0xd3 || b[4] != 0x91 || b[5] != 0xd3 || b[6] != 0x91) return DECODE_ABORT_EARLY
    val flags = (b[7] and 0xf0) shr 4
    val temp1 = ((b[7] and 0x0f) shl 6) or ((b[8] and 0xfc) shr 2)
    val temp2 = ((b[8] and 0x03) shl 8) or b[9]
    val digest = (b[10] shl 8) or b[11]
    ctx.emit(data("model" to "Maverick-XR30", "id" to (lfsrDigest16(b, 3, 0x8810, 0x0d42, 7) xor digest),
        "status" to when (flags) { 0 -> "default"; 5 -> "init"; else -> "unknown" }, "temperature_1_C" to temp1 - 532, "temperature_2_C" to temp2 - 532))
    return 1
}

private val XR50_SYNC = UBytes.of(0xd2, 0xaa, 0x2d, 0xd4)

/**
 * Four probes of five bytes each; an empty socket reads zero, which means no probe rather than freezing. The
 * length test is upstream's own, short by the sync word; such frames fail the CRC a moment later anyway.
 */
private fun xr50(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY
    val n = bits.bitsPerRow[0]
    val at = bits.search(0, 0, XR50_SYNC, 32)
    if (at >= n) return DECODE_ABORT_LENGTH
    if (n - at < 184) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at + 32, 23 * 8)
    if (crc8(b, 23, 0x31, 0x00) != 0) return DECODE_FAIL_MIC
    val out = data("model" to "Maverick-XR50", "id" to hexOf((b[0] shl 8) or b[1], 4), "mic" to "CRC")
    for (p in 0 until 4) {
        val o = 2 + p * 5
        val tempRaw = ((b[o] and 0x0f) shl 8) or b[o + 1]
        out["probe_${p + 1}_flags"] = hexOf((b[o] and 0xf0) shr 4, 1)
        if (tempRaw != 0) out["temperature_${p + 1}_C"] = round1((tempRaw - 500) * 0.1)
        out["setpoint_high_${p + 1}_C"] = round1((((b[o + 2] shl 4) or ((b[o + 3] and 0xf0) shr 4)) - 500) * 0.1)
        out["setpoint_low_${p + 1}_C"] = round1(((((b[o + 3] and 0x0f) shl 8) or b[o + 4]) - 500) * 0.1)
    }
    ctx.emit(out)
    return 1
}

/**
 * Upstream's prose says odd parity but its code demands even, over the first 28 bits; all its recorded frames are
 * even, so the code is right. Temperature is Fahrenheit plus 90, reported in Fahrenheit.
 */
private fun gtTmbbq05(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(5, 33)
    if (r < 0 || bits.bitsPerRow[r] != 33) return DECODE_ABORT_LENGTH
    val b = bits.bytes(r, 1, 32)                         // drop the constant leading bit
    if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0) return DECODE_FAIL_SANITY
    if (parityBytes(UBytes.of(b[0], b[1], b[2], b[3] and 0xf0), 4) != 0) return DECODE_FAIL_MIC
    val sum = sumNibbles(b, 3) + (b[3] shr 4)
    if ((sum and 0x0f) != (b[3] and 0x0f)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "GT-TMBBQ05", "id" to ((b[0] shl 8) or b[2]),
        "temperature_F" to ((((b[3] and 0xc0) shl 2) or b[1]) - 90), "mic" to "CHECKSUM"))
    return 1
}

private val BURNHARD_MEAT = listOf("free", "beef", "veal", "pork", "chicken", "lamb", "fish", "ham")
private val BURNHARD_TASTE = listOf("rare", "medium rare", "medium", "medium well", "well done")

/** The base station's whole interface on the air: timer, cut of meat and doneness. An empty probe reads zero. */
private fun burnhard(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    var ret = DECODE_FAIL_OTHER
    for (i in 0 until bits.numRows) {
        val n = bits.bitsPerRow[i]
        if (n < 80 || n > 81) { ret = DECODE_ABORT_LENGTH; continue }
        val b = bits.bb[i]
        if (b[0] == 0 && b[9] == 0) { ret = DECODE_ABORT_EARLY; continue }
        if (lfsrDigest8Reflect(b, 9, 0x31, 0xf4) != b[9]) { ret = DECODE_FAIL_MIC; continue }
        val setpointRaw = ((b[7] and 0x0f) shl 8) or b[6]
        val tempRaw = ((b[7] and 0xf0) shl 4) or b[8]
        val meat = BURNHARD_MEAT.getOrNull(b[5] shr 4) ?: ""
        val taste = BURNHARD_TASTE.getOrNull(b[5] and 0x0f) ?: ""
        val out = data("model" to "BurnhardBBQ", "id" to b[0], "channel" to (b[1] and 0x07), "setpoint_C" to round1((setpointRaw - 500) * 0.1),
            "temperature_alarm" to if ((b[1] and 0x80) != 0) 1 else 0,
            "timer" to "${hexOf(b[3])}:${hexOf(b[4] and 0x7f)}",   // minutes and seconds, BCD
            "timer_active" to if ((b[1] and 0x10) != 0) 1 else 0, "timer_alarm" to if ((b[1] and 0x40) != 0) 1 else 0)
        if (tempRaw != 0) out["temperature_C"] = round1((tempRaw - 500) * 0.1)
        if (meat.isNotEmpty()) out["meat"] = meat
        if (taste.isNotEmpty()) out["taste"] = taste
        ctx.emit(out)
        return 1
    }
    return ret
}

/** Three decimal digits and a sign; the nibbles must sum to a constant ending 0xc, weak enough to need the fixed nibble too. */
private fun gasmate(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_LENGTH
    if (bits.bitsPerRow[0] != 32) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    if ((b[0] and 0xf8) != 0xf0) return DECODE_ABORT_EARLY
    if ((sumNibbles(b, 4) and 0x0f) != 0x0c) return DECODE_FAIL_MIC
    val raw = (b[0] and 0x03) * 100 + ((b[1] and 0xf0) shr 4) * 10 + (b[1] and 0x0f)
    ctx.emit(data("model" to "Gasmate-BA1008", "temperature_C" to if (((b[0] and 0x04) shr 2) != 0) -raw else raw,
        "unknown_1" to hexOf((b[2] shl 4) or (b[3] shr 4), 3), "mic" to "CHECKSUM"))
    return 1
}

/** Three bytes with an eight-bit sum: thin, so it runs late and wants the value twice. -1029 °F means over range. */
private fun rfT0912(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    var tempF = 0
    var repeats = 0
    for (row in 0 until bits.numRows) {
        val r = bits.bb[row]
        val checksum = (r[0] + r[1]) and 0xff
        if (bits.bitsPerRow[row] != 24 || checksum != r[2] || checksum == 0) continue
        val value = signed((r[0] shl 8) or r[1], 16)
        if (tempF != value) { tempF = value; repeats = 0 } else repeats++
    }
    if (repeats < 1) return DECODE_ABORT_EARLY
    val overload = if (tempF == -1029) 1 else 0
    val out = data("model" to "RF-T0912", "overload" to overload, "mic" to "CHECKSUM")
    if (overload == 0) out["temperature_F"] = tempF
    ctx.emit(out)
    return 1
}

private val TYPHUR_SYNC = UBytes.of(0x57, 0x54)

/** Five points along one probe (surface to middle) in hundredths, plus ambient in tenths; little-endian but the id. */
private fun typhur(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    for (row in 0 until bits.numRows) {
        val n = bits.bitsPerRow[row]
        var pos = bits.search(row, 0, TYPHUR_SYNC, 16)
        if (pos >= n) continue
        pos += 16
        if (n - pos < 24 * 8) continue
        val b = bits.bytes(row, pos, 24 * 8)
        if (crc16(b, 22, 0x8005, 0x0000) != ((b[22] shl 8) or b[23])) continue
        fun le(at: Int) = b[at] or (b[at + 1] shl 8)
        val out = data("model" to "Typhur-SyncGold", "id" to hexOf((b[0] shl 16) or (b[1] shl 8) or b[2], 6),
            "in_base" to if ((b[4] and 0x08) != 0) 1 else 0, "counter" to le(20), "battery_V" to round2(le(18) * 0.01),
            "ambient_C" to round1(le(16) * 0.1), "mic" to "CRC")
        for (i in 0 until 5) out["temperature_${i + 1}_C"] = round2(le(6 + i * 2) * 0.01)
        ctx.emit(out)
        return 1
    }
    return DECODE_FAIL_MIC
}

internal val GRILL: List<RDevice> = listOf(
    dev(71, "Maverick ET-732/733 BBQ Sensor", Mod.OOK_MANCHESTER_ZEROBIT, 230, 0, 4000, bands = BANDS, what = TWO_PROBES, decode = ::et73x),
    dev(114, "Maverick ET73", Mod.OOK_PPM, 1050, 2050, 4400, gapLimit = 2200, bands = BANDS, what = TWO_PROBES, decode = ::et73),
    dev(220, "Maverick XR-30 BBQ Sensor", Mod.FSK_PCM, 360, 360, 4096, bands = BANDS, what = TWO_PROBES, decode = ::xr30),
    dev(281, "Maverick XR-50 BBQ Sensor", Mod.FSK_PCM, 107, 107, 2200, bands = BANDS, what = "barbecue thermometer, four probes with targets", decode = ::xr50),
    dev(137, "Globaltronics QUIGG GT-TMBBQ-05", Mod.OOK_PPM, 2000, 4000, 9100, gapLimit = 4200, bands = BANDS,
        what = "barbecue thermometer, one probe", decode = ::gtTmbbq05),
    dev(177, "Burnhard BBQ thermometer", Mod.OOK_PWM, 240, 484, 848, syncWidth = 840, bands = BANDS,
        what = "barbecue thermometer with a timer and a target", decode = ::burnhard),
    dev(236, "Gasmate BA1008 meat thermometer", Mod.OOK_PPM, 536, 1668, 2000, bands = BANDS, what = "meat thermometer", decode = ::gasmate),
    dev(331, "RF-T0912 Grill Thermometer", Mod.OOK_PWM, 252, 736, 8068, gapLimit = 5000, syncWidth = 980, priority = 10, bands = BANDS,
        what = "grill thermometer with a probe", decode = ::rfT0912),
    dev(377, "Typhur Sync Gold meat thermometer probe", Mod.FSK_PCM, 13, 13, 3000, bands = BANDS,
        what = "wireless meat probe, five points and ambient", decode = ::typhur),
)
