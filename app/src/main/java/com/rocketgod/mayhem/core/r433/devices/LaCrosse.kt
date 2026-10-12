package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * LaCrosse, and the TFA Dostmann and Conrad sensors built to the same designs: the older on-off keyed TX line with
 * BCD digits and a nibble sum, the frequency-shifted "IT+" line with a sync word and a CRC, the TX141 family back
 * on OOK with a shift-register digest, and the "View" (LTV) range that pairs with the phone app.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): lacrosse.c, lacrosse_tx35.c, lacrosse_tx34.c, lacrosse_tx141x.c,
 * lacrosse_breezepro.c, lacrosse_wr1.c, lacrosse_th3.c, lacrosse_r1.c. Twin of web/src/dsp/r433/devices/
 * lacrosse.ts and lacrosse2.ts.
 */

private val B433 = listOf(433_920_000L)
private val B868 = listOf(868_300_000L)

/** The original TX line: 44 bits in eleven nibbles, each value sent twice (with and without its decimal). */
private fun lacrosseTx(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0; var result = 0
    for (row in 0 until bits.numRows) {
        val p = bits.bb[row]
        if (bits.bitsPerRow[row] != 44) { result = DECODE_ABORT_LENGTH; continue }
        if (p[0] != 0x0a) { result = DECODE_ABORT_EARLY; continue }
        val n = IntArray(11)
        var parity = 0
        for (i in 0 until 44) {
            val bit = if ((p[i shr 3] and (1 shl (7 - (i % 8)))) != 0) 1 else 0
            val nib = i / 4
            n[nib] = n[nib] or (bit shl (3 - (i % 4)))
            if (nib in 5..7) parity += bit
        }
        parity += n[4] and 0x01
        var checksum = 0
        for (i in 0 until 10) checksum = (checksum + n[i]) and 0x0f
        if (checksum != n[10] || parity % 2 != 0) { result = DECODE_FAIL_MIC; continue }
        val type = n[2]
        val id = (n[3] shl 3) + (n[4] shr 1)
        val raw = (n[5] shl 8) or (n[6] shl 4) or n[7]
        val value = n[5] * 10 + n[6] + n[7] * 0.1
        if (n[5] != n[8] || n[6] != n[9]) { result = DECODE_FAIL_SANITY; continue }
        if (type == 0x00) {
            ctx.emit(data("model" to "LaCrosse-TX", "id" to id, "temperature_C" to jsRound((value - 50) * 10) / 10, "mic" to "PARITY"))
            events++
        } else if (type == 0x0e) {
            val out = data("model" to "LaCrosse-TX", "id" to id, "mic" to "PARITY")
            if (raw != 0xff) out["humidity"] = jsRound(value * 10) / 10
            ctx.emit(out)
            events++
        }
    }
    return if (events != 0) events else result
}

/** The "IT+" frame: sync word, model nibble, a six-bit identity picked at power-up, the reading and a CRC. */
private fun itPlus(bits: BitBuffer, ctx: DecodeCtx, model: Int): Int {
    val preamble = UBytes.of(0xa2, 0xdd, 0x49)
    var events = 0
    for (row in 0 until bits.numRows) {
        val start = bits.search(row, 0, preamble, 24)
        if (start >= bits.bitsPerRow[row]) continue
        val b = bits.bytes(row, start + 20, 40)
        if (b[4] != crc8(b, 4, 0x31, 0x00)) continue
        var id = ((b[0] and 0x0f) shl 2) or (b[1] shr 6)
        val tempC = 10 * (b[1] and 0x0f) + ((b[2] shr 4) and 0x0f) + 0.1 * (b[2] and 0x0f) - 40
        val humidity = b[3] and 0x7f
        val out = data("model" to if (model == 29) "LaCrosse-TX29IT" else "LaCrosse-TX35DTHIT", "id" to 0,
            "battery_ok" to if ((b[3] shr 7) != 0) 0 else 1, "newbattery" to ((b[1] shr 5) and 1),
            "temperature_C" to jsRound(tempC * 10) / 10, "mic" to "CRC")
        // 0x6a: no humidity element; 0x7d: the second probe, given its own identity
        if (humidity == 0x6a || humidity == 0x7d) { if (humidity == 0x7d) id += 0x40 } else out["humidity"] = humidity
        out["id"] = id
        ctx.emit(out)
        events++
    }
    return events
}

/** The rain gauge of the family: a running count of bucket tips, 0.222 mm each. */
private fun lacrosseTx34(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val preamble = UBytes.of(0xa2, 0xdd, 0x40)
    var events = 0
    for (row in 0 until bits.numRows) {
        val start = bits.search(row, 0, preamble, 20) + 20
        if (start + 40 > bits.bitsPerRow[row]) continue
        val b = bits.bytes(row, start, 40)
        if (b[4] != crc8(b, 4, 0x31, 0x00)) continue
        if (((b[0] and 0xf0) shr 4) != 5) continue
        val ticks = (b[2] shl 8) or b[3]
        ctx.emit(data("model" to "LaCrosse-TX34IT", "id" to (((b[0] and 0x0f) shl 2) or (b[1] shr 6)),
            "battery_ok" to if ((b[1] and 0x10) != 0) 0 else 1, "newbattery" to ((b[1] and 0x20) shr 5),
            "rain_mm" to jsRound(ticks * 0.222 * 10) / 10, "rain_raw" to ticks, "mic" to "CRC"))
        events++
    }
    return events
}

private const val TX141B = 32
private const val TX141 = 37
private const val TX141TH = 40
private const val TX141BV3 = 33
private const val TX141W = 65

/** The TX141 family: which sensor is talking is decided by how many bits arrived. */
private fun lacrosseTx141x(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    var r = bits.findRepeatedRow(if (bits.numRows > 5) 5 else 3, 32)
    if (r < 0) r = bits.findRepeatedRow(2, 64)
    if (r < 0 && bits.numRows <= 4) {
        for (row in 0 until bits.numRows) {
            if ((bits.bitsPerRow[row] == 40 || bits.bitsPerRow[row] == 41) && lfsrDigest8Reflect(bits.bb[row], 4, 0x31, 0xf4) == bits.bb[row][4]) { r = row; break }
        }
    }
    if (r < 0) return DECODE_ABORT_LENGTH
    val n = bits.bitsPerRow[r]
    val device = when {
        n >= 64 -> TX141W
        n > 41 -> return DECODE_ABORT_LENGTH
        n >= 41 -> { if (bits.numRows > 12) return DECODE_ABORT_LENGTH; TX141TH }
        n >= 40 -> TX141TH
        n >= 37 -> TX141
        n == 32 -> TX141B
        else -> TX141BV3
    }
    val b = bits.bb[r]
    if (device == TX141W) {
        if ((b[0] shr 3) != 0x01) return DECODE_ABORT_EARLY
        if (crc8(b, 8, 0x31, 0x00) != 0) return DECODE_FAIL_MIC
        val id = ((b[0] and 0x07) shl 16) or (b[1] shl 8) or b[2]
        val channel = (b[3] and 0x30) shr 4
        val type = b[3] and 0x0f
        val raw = (b[4] shl 4) or (b[5] shr 4)
        val second = ((b[5] and 0x0f) shl 8) or b[6]
        val common = data("model" to "LaCrosse-TX141W", "id" to hexOf(id, 5), "channel" to hexOf(channel, 1),
            "battery_ok" to if ((b[3] shr 7) != 0) 0 else 1, "test" to ((b[3] and 0x40) shr 6), "mic" to "CRC")
        when (type) {
            1 -> { common["temperature_C"] = jsRound((raw - 500) * 10.0) / 100; common["humidity"] = second }
            2 -> { common["wind_avg_km_h"] = raw / 10.0; common["wind_dir_deg"] = second }
            else -> return DECODE_FAIL_OTHER
        }
        ctx.emit(common)
        return 1
    }
    val id = b[0]
    // the battery flag runs the other way round on the temperature-only versions
    val batteryLow = if (device == TX141TH) (b[1] shr 7) else if ((b[1] shr 7) != 0) 0 else 1
    val test = (b[1] and 0x40) shr 6
    val channel = (b[1] and 0x30) shr 4
    val tempC = jsRound(((((b[1] and 0x0f) shl 8) or b[2]) - 500) * 10.0) / 100
    val humidity = if (device == TX141TH) b[3] else 0
    if (id == 0 || (device == TX141TH && (humidity == 0 || humidity > 100)) || tempC < -40 || tempC > 140) return DECODE_FAIL_SANITY
    val base = arrayOf("id" to hexOf(id, 2), "battery_ok" to (if (batteryLow != 0) 0 else 1), "temperature_C" to tempC, "test" to if (test != 0) "Yes" else "No")
    when (device) {
        TX141B -> ctx.emit(data("model" to "LaCrosse-TX141B", *base))
        TX141 -> ctx.emit(data("model" to "LaCrosse-TX141Bv2", "channel" to channel, *base))
        TX141BV3 -> ctx.emit(data("model" to "LaCrosse-TX141Bv3", "channel" to channel, *base))
        else -> {
            if (lfsrDigest8Reflect(b, 4, 0x31, 0xf4) != b[4]) return DECODE_FAIL_MIC
            ctx.emit(data("model" to "LaCrosse-TX141THBv2", "channel" to channel, *base, "humidity" to humidity, "mic" to "CRC"))
        }
    }
    return 1
}

// ---- the View (LTV) range ------------------------------------------------------------------------------

private val SYNC = UBytes.of(0xd2, 0xaa, 0x2d, 0xd4)
private val VIEW_BANDS = listOf(433_920_000L, 868_300_000L, 915_000_000L)
private fun hex6(b: UBytes) = hexOf((b[0] shl 16) or (b[1] shl 8) or b[2], 6)

/** LTV-TH: three CRC initial values are accepted, as LaCrosse changed it between production runs. */
private fun lacrosseTh3(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n < 156 || n > 290) return DECODE_ABORT_LENGTH
    val model = if (n < 280) 3 else 2
    val at = bits.search(0, 0, SYNC, 32)
    if (at >= n) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, at + 32, 8 * 8)
    if (crc8(b, 8, 0x31, 0x00) != 0 && crc8(b, 8, 0x31, 0xac) != 0 && crc8(b, 8, 0x31, 0xb2) != 0) return DECODE_FAIL_MIC
    val rawTemp = (b[4] shl 4) or ((b[5] and 0xf0) shr 4)
    val humidity = ((b[5] and 0x0f) shl 8) or b[6]
    val tempC = (rawTemp - 400) * 0.1
    if (humidity > 100 || tempC < -50 || tempC > 70) return DECODE_FAIL_SANITY
    val flags = b[3] and 0x31
    val retrans = (b[3] and 0x40) shr 6
    val out = data("model" to if (model == 3) "LaCrosse-TH3" else "LaCrosse-TH2", "id" to hex6(b),
        "battery_ok" to if (((b[3] and 0x80) shr 7) != 0) 0 else 1, "seq" to ((b[3] and 0x0e) shr 1),
        "temperature_C" to round1(tempC), "humidity" to humidity, "mic" to "CRC")
    if (retrans != 0) out["retransmit"] = retrans
    if (flags != 0) out["flags"] = flags
    ctx.emit(out)
    return 1
}

/** LTV-R1 / R3 rain gauges and the W1/W2 wind sensor on one board, told apart by where the padding falls. */
private fun lacrosseR1(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY
    val n = bits.bitsPerRow[0]
    if (n < 170 || n > 272) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, SYNC, 32)
    if (at >= n) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, at + 32, 20 * 8)
    var rev = 1
    var chk = crc8(b, 11, 0x31, 0x00)
    if (chk == 0 && b[4] == 0xaa && b[5] == 0xaa && b[6] == 0xaa && (b[8] and 0x0f) == 0x0a && b[9] == 0xaa) rev = 9
    else if (chk == 0 && b[10] != 0) rev = 3
    else {
        chk = crc8(b, 8, 0x31, 0x00)
        if (b[10] != 0 || chk != 0) return DECODE_FAIL_MIC
    }
    val out = data("model" to when (rev) { 1 -> "LaCrosse-R1"; 3 -> "LaCrosse-R3"; else -> "LaCrosse-W1" }, "id" to hex6(b),
        "battery_ok" to if (((b[3] and 0x80) shr 7) != 0) 0 else 1, "seq" to ((b[3] and 0x0e) shr 1), "mic" to "CRC")
    val startup = (b[3] and 0x40) shr 6; val flags = b[3] and 0x31
    if (startup != 0) out["startup"] = startup
    if (flags != 0) out["flags"] = flags
    if (rev != 9) out["rain_mm"] = jsRound((((b[5] xor 0xaa) shl 16) or (b[4] shl 8) or b[6]) * 0.25 * 100) / 100
    if (rev == 3) out["rain2_mm"] = jsRound((((b[8] xor 0xaa) shl 16) or (b[7] shl 8) or b[9]) * 0.25 * 100) / 100
    if (rev == 9) out["wind_avg_km_h"] = round1(((b[7] shl 4) or (b[8] shr 4)) * 0.1)
    ctx.emit(out)
    return 1
}

/** LTV-WR1: wind and rain together. */
private fun lacrosseWr1(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n < 120 || n > 156) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, SYNC, 32)
    if (at >= n) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, at + 32, 11 * 8)
    if (crc8(b, 11, 0x31, 0x00) != 0) return DECODE_FAIL_MIC
    val rawWind = (b[4] shl 4) or ((b[5] and 0xf0) shr 4)
    val direction = ((b[5] and 0x0f) shl 8) or b[6]
    val speed = rawWind * 0.1
    if (speed > 200 || direction > 360) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "LaCrosse-WR1", "id" to hex6(b), "seq" to ((b[3] and 0x0e) shr 1), "flags" to (b[3] and 0xf1),
        "wind_avg_km_h" to round1(speed), "wind_dir_deg" to direction,
        "rain1" to hexOf((b[7] shl 4) or ((b[8] and 0xf0) shr 4), 3), "rain2" to hexOf(((b[8] and 0x0f) shl 8) or b[9], 3), "mic" to "CRC"))
    return 1
}

/** The Breeze Pro: wind plus temperature and humidity. */
private fun breezePro(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n < 264) return DECODE_ABORT_LENGTH
    val at = bits.search(0, 0, SYNC, 32)
    if (at >= n) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, at + 32, 11 * 8)
    if (crc8(b, 11, 0x31, 0x00) != 0) return DECODE_FAIL_MIC
    val tempC = (((b[4] shl 4) or ((b[5] and 0xf0) shr 4)) - 400) * 0.1
    val humidity = ((b[5] and 0x0f) shl 8) or b[6]
    val speed = ((b[7] shl 4) or ((b[8] and 0xf0) shr 4)) * 0.1
    val direction = ((b[8] and 0x0f) shl 8) or b[9]
    if (humidity > 100 || tempC < -40 || tempC > 70 || direction > 360 || speed > 200) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "LaCrosse-BreezePro", "id" to hex6(b), "seq" to ((b[3] and 0x0e) shr 1), "flags" to (b[3] and 0xf1),
        "temperature_C" to round1(tempC), "humidity" to humidity, "wind_avg_km_h" to round1(speed), "wind_dir_deg" to direction, "mic" to "CRC"))
    return 1
}

internal val LACROSSE: List<RDevice> = listOf(
    dev(8, "LaCrosse TX temperature / humidity sensor", Mod.OOK_PWM, 550, 1400, 8000, gapLimit = 3000, bands = B433,
        what = "outdoor sensor: TX-3, TX-4, TX-6U, TX-7U, TFA 30.3120.90", decode = ::lacrosseTx),
    dev(76, "LaCrosse TX29IT, TFA Dostmann 30.3159.IT temperature sensor", Mod.FSK_PCM, 55, 55, 4000, bands = B868,
        what = "outdoor thermometer on the 868 MHz band") { _, bits, ctx -> itPlus(bits, ctx, 29) },
    dev(75, "LaCrosse TX35DTH-IT, TFA Dostmann 30.3155 temperature/humidity sensor", Mod.FSK_PCM, 105, 105, 4000, bands = B868,
        what = "outdoor temperature and humidity sensor on the 868 MHz band") { _, bits, ctx -> itPlus(bits, ctx, 35) },
    dev(206, "LaCrosse TX34-IT rain gauge", Mod.FSK_PCM, 58, 58, 4000, bands = B868, what = "tipping-bucket rain gauge", decode = ::lacrosseTx34),
    dev(73, "LaCrosse TX141-Bv2, TX141TH-Bv2, TX141-Bv3, TX141W, TX145wsdth, (TFA, ORIA) sensor", Mod.OOK_PWM, 208, 417, 1700,
        syncWidth = 833, gapLimit = 625, bands = B433, what = "outdoor thermometer, or a wind and temperature station", decode = ::lacrosseTx141x),
)

internal val LACROSSE2: List<RDevice> = listOf(
    dev(171, "LaCrosse View LTV-TH thermo-hygro sensor", Mod.FSK_PCM, 104, 104, 9600, bands = VIEW_BANDS, what = "outdoor temperature and humidity", decode = ::lacrosseTh3),
    dev(175, "LaCrosse View LTV-R1, LTV-R3 rain gauge and LTV-W1/W2 wind sensor", Mod.FSK_PCM, 104, 104, 9600, bands = VIEW_BANDS,
        what = "rain gauge or wind sensor", decode = ::lacrosseR1),
    dev(170, "LaCrosse View LTV-WR1 multi sensor", Mod.FSK_PCM, 104, 104, 9600, bands = VIEW_BANDS, what = "wind and rain sensor", decode = ::lacrosseWr1),
    dev(166, "LaCrosse View LTV-WSDTH01 Breeze Pro wind sensor", Mod.FSK_PCM, 107, 107, 5900, bands = VIEW_BANDS, what = "wind, temperature and humidity", decode = ::breezePro),
)
