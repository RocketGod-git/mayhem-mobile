package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * TFA Dostmann sensors, Inovalley, and the Fine Offset WH1050 the TFA 30.3151 is built on.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): inovalley-kw9015b.c, tfa_30_3196.c, tfa_drop_30.3233.c,
 * tfa_30_3221.c, tfa_marbella.c, tfa_14_1504_v2.c, fineoffset_wh1050.c, tfa_30_390x.c. Twin of
 * web/src/dsp/r433/devices/tfa.ts.
 */

private val B433 = listOf(433_920_000L)
private val B868 = listOf(868_300_000L)
private fun pad2(v: Int) = v.toString().padStart(2, '0')

/** Every byte arrives bit-reversed, and the checksum is a sum of the reversed nibbles. */
private fun kw9015b(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(3, 36)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 36) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    val r0 = reverse8(b[0]); val r1 = reverse8(b[1]); val r2 = reverse8(b[2]); val r3 = reverse8(b[3])
    val sum = (r0 shr 4) + (r0 and 0x0f) + (r1 shr 4) + (r1 and 0x0f) + (r2 shr 4) + (r2 and 0x0f) + (r3 shr 4) + (r3 and 0x0f)
    if ((sum and 0x0f) != (reverse8(b[4]) and 0x0f)) return DECODE_FAIL_MIC
    val rain = ((r0 and 0xc0) shl 4) or ((r1 and 0x06) shl 7) or r3
    ctx.emit(data("model" to "Inovalley-kw9015b", "id" to (r0 and 0x0f), "battery_ok" to if ((b[1] shr 7) != 0) 0 else 1,
        "temperature_C" to round1((signed((r2 shl 8) or (r1 and 0xf0), 16) shr 4) * 0.1), "rain_mm" to round1(rain * 0.45)))
    return 1
}

/** The sixteen-bit digest is used as the identity rather than checked, so integrity is reported as missing. */
private fun tfa303196(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 48 * 2 + 12)
    if (row < 0) return DECODE_ABORT_EARLY
    val start = bits.search(row, 0, UBytes.of(0x55, 0x56), 16) + 12
    if (bits.bitsPerRow[row] - start < 48 * 2) return DECODE_ABORT_LENGTH
    val out = BitBuffer()
    bits.manchesterDecode(row, start, out, 48)
    if (out.bitsPerRow[0] < 48) return DECODE_ABORT_LENGTH
    val b = out.bb[0]
    if (b[0] != 0xa8) return DECODE_FAIL_SANITY
    val digest = (b[4] shl 8) or b[5]
    val tempRaw = ((b[1] and 0x0f) shl 8) or b[2]
    ctx.emit(data("model" to "TFA-303196", "id" to (lfsrDigest16(b, 4, 0x8810, 0x22d0) xor digest), "channel" to (b[1] shr 4) + 1,
        "battery_ok" to if ((b[3] shr 7) != 0) 0 else 1, "temperature_C" to round1((tempRaw - 400) * 0.1),
        "humidity" to (b[3] and 0x7f), "mic" to "missing"))
    return 1
}

/** Arrives inverted; the counter is offset by ten and wraps, which is the sensor's own arithmetic. */
private fun tfaDrop(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    val row = bits.findRepeatedRow(2, 66)
    if (row < 0 || bits.bitsPerRow[row] > 66 + 16) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if ((b[0] and 0xf0) != (0x3 shl 4)) return DECODE_ABORT_EARLY
    if (b[7] != lfsrDigest8Reflect(b, 7, 0x31, 0xf4)) return DECODE_FAIL_MIC
    val counter = (((b[6] shl 8) or b[4]) + 10) and 0xffff
    ctx.emit(data("model" to "TFA-Drop", "id" to Integer.toHexString(((b[0] and 0x0f) shl 16) or (b[1] shl 8) or b[2]),
        "battery_ok" to if (((b[3] and 0x80) shr 7) != 0) 0 else 1, "rain_mm" to round1(counter * 0.254), "mic" to "CHECKSUM"))
    return 1
}

private fun tfa303221(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(if (bits.numRows > 4) 4 else 2, 40)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 41) return DECODE_ABORT_LENGTH
    bits.invert()
    val b = bits.bb[row]
    if (b[0] == 0) return DECODE_FAIL_SANITY
    if (b[4] != lfsrDigest8Reflect(b, 4, 0x31, 0xf4)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "TFA-303221", "id" to b[0], "channel" to ((b[1] shr 4) and 3) + 1,
        "battery_ok" to if ((b[1] shr 7) != 0) 0 else 1, "temperature_C" to round2(((((b[1] and 0x0f) shl 8) or b[2]) - 500) * 0.1),
        "humidity" to b[3],
        "sendmode" to ((b[1] shr 6) and 1),              // the test button, which sends far more often than normal
        "mic" to "CRC"))
    return 1
}

/** The frame is taken from the preamble onward: the digest covers bytes three to nine. */
private fun marbella(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    val start = bits.search(0, 0, UBytes.of(0xaa, 0x2d, 0xd4), 24)
    if (start >= n) return DECODE_FAIL_SANITY
    val msg = bits.bytes(0, start, 11 * 8)
    if (msg[9] != 0xaa) return DECODE_FAIL_SANITY
    if (lfsrDigest8Reflect(msg, 7, 0x31, 0x31, 3) != msg[10]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "TFA-Marbella", "id" to hexOf((msg[3] shl 16) or (msg[4] shl 8) or msg[5], 6),
        "counter" to ((msg[6] shr 1) and 0x07), "battery_ok" to if (((msg[6] shr 7) and 1) != 0) 0 else 1,
        "temperature_C" to round1((((msg[7] shl 4) or (msg[8] shr 4)) - 400) * 0.1), "mic" to "CRC"))
    return 1
}

/** Whole degrees only, and it says when no probe is plugged in. */
private fun tfa141504(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    var available = bits.bitsPerRow[0]
    if (available < 64) return DECODE_ABORT_EARLY
    val start = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0x5c), 24)
    available -= start
    if (available < 24) return DECODE_ABORT_EARLY
    if (available < 64 || available > 76) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, start + 24, 40)
    val flags = b[0] shr 4
    if ((flags and 0x5) == 0x5) return DECODE_FAIL_SANITY
    if (b[2] != 0xff) return DECODE_FAIL_SANITY
    val calc = lfsrDigest16(b, 3, 0x8810, 0x0d42) xor 0x16eb
    if (calc != ((b[3] shl 8) + b[4])) return DECODE_FAIL_MIC
    val rawTemp = ((b[0] and 0x0f) shl 6) + (b[1] shr 2)
    val connected = rawTemp != 0x1c0
    val out = data("model" to "TFA-141504v2", "battery_ok" to if ((flags and 0x2) != 0) 1 else 0, "probe_fail" to if (connected) 0 else 1, "mic" to "CRC")
    if (connected) out["temperature_C"] = rawTemp - 532
    ctx.emit(out)
    return 1
}

/**
 * One frame on two radios, so the scaling follows how the frame arrived rather than which registration ran: keyed
 * offsets temperature by forty and counts rain in 0.3 mm, frequency-shifted carries a sign bit and counts 0.5 mm.
 */
private fun wh1050Decode(bits: BitBuffer, ctx: DecodeCtx, at: Int, fsk: Boolean): Int {
    val br = bits.bytes(0, at, 9 * 8)
    if (crc8(br, 9, 0x31, 0x00) != 0) return 0
    val msgType = br[0] shr 4
    val model = if (fsk) "TFA-303151" else "Fineoffset-WH1050"
    val id = hexUp(((br[0] shl 4) and 0xf0) or (br[1] shr 4))
    val batteryOk = if ((br[1] and 0x04) != 0) 0 else 1
    if (msgType == 5) {
        val tempRaw = ((br[1] and 0x03) shl 8) or br[2]
        val rainRaw = (br[6] shl 8) or br[7]
        val temperature: Double; val rain: Double
        if (fsk) {
            temperature = if (((br[1] and 0x08) shr 3) != 0) -(tempRaw * 0.1) else tempRaw * 0.1
            rain = rainRaw * 0.5
        } else {
            temperature = (tempRaw - 400) * 0.1
            rain = rainRaw * 0.3
        }
        ctx.emit(data("model" to model, "id" to id, "msg_type" to msgType, "battery_ok" to batteryOk, "temperature_C" to round1(temperature),
            "humidity" to br[3], "wind_avg_km_h" to round2(br[4] * 0.34 * 3.6), "wind_max_km_h" to round2(br[5] * 0.34 * 3.6),
            "rain_mm" to round1(rain), "mic" to "CRC"))
        return 1
    }
    if (msgType == 6) {
        fun bcd(v: Int) = ((v and 0xf0) shr 4) * 10 + (v and 0x0f)
        val clock = "${2000 + bcd(br[5])}-${pad2(((br[6] and 0x10) shr 4) * 10 + (br[6] and 0x0f))}-${pad2(bcd(br[7]))}" +
            "T${pad2(((br[2] and 0x30) shr 4) * 10 + (br[2] and 0x0f))}:${pad2(bcd(br[3]))}:${pad2(bcd(br[4]))}"
        ctx.emit(data("model" to model, "id" to id, "msg_type" to msgType, "battery_ok" to batteryOk, "radio_clock" to clock, "mic" to "CRC"))
        return 1
    }
    return 0
}

private fun wh1050(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val n = bits.bitsPerRow[0]
    val first = bits.bb[0][0]
    // The Digitech XC0346 sends seven leading ones instead of eight.
    if (n == 79 && first == 0xfe) return wh1050Decode(bits, ctx, 7, false)
    if (n == 80 && first == 0xff) return wh1050Decode(bits, ctx, 8, false)
    if (n in 113..759) {
        val sync = UBytes.of(0xaa, 0x2d, 0xd4)
        var events = 0
        var at = 0
        // Six copies in one row, separated by gaps: take every one that decodes.
        while (true) {
            at = bits.search(0, at, sync, 24)
            if (at + 24 + 72 > n) break
            events += wh1050Decode(bits, ctx, at + 24, true)
            at += 123
        }
        return events
    }
    return DECODE_ABORT_LENGTH
}

private fun crc32(m: UBytes, at: Int, n: Int): Long {
    var crc = 0xffffffffL
    for (k in 0 until n) {
        crc = crc xor m[at + k].toLong()
        for (i in 0 until 8) crc = if ((crc and 1L) != 0L) (crc ushr 1) xor 0xedb88320L else crc ushr 1
    }
    return crc xor 0xffffffffL
}

/** Five models on one frame; each reports its last three readings so a console that missed one can fill its graph. */
private fun tfa30390x(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    val at = bits.search(0, 0, UBytes.of(0x4b, 0x2d, 0xd4, 0x2b), 32)
    if (at + 32 + 8 > n) return DECODE_ABORT_LENGTH
    val lenByte = bits.bytes(0, at + 32, 8)[0]
    if (lenByte != 24 && lenByte != 30 && lenByte != 36) return DECODE_ABORT_LENGTH
    if (at + 32 + lenByte * 8 > n) return DECODE_ABORT_LENGTH
    // The sync word is kept in the buffer, so the length byte lands at index four.
    val b = bits.bytes(0, at, 32 + lenByte * 8)
    val want = (b[lenByte + 3].toLong() shl 24) or (b[lenByte + 2].toLong() shl 16) or (b[lenByte + 1].toLong() shl 8) or b[lenByte].toLong()
    if (crc32(b, 4, lenByte - 4) != want) return DECODE_FAIL_MIC
    if (b[5] == 0 && b[6] == 0 && b[7] == 0 && b[8] == 0) return DECODE_FAIL_SANITY
    fun at16(i: Int) = b[i] or (b[i + 1] shl 8)
    fun series(first: Int, step: Int, bitsN: Int) = List(3) { round1(signed(at16(first + it * step), bitsN) * 0.1) }
    fun plain(first: Int, step: Int) = List(3) { round1(at16(first + it * step) * 0.1) }
    fun join(v: List<Double>) = v.joinToString(", ") { jsNum(it) }
    val out = data("model" to "", "id" to hexUp(u32be(b, 5), 8), "battery_ok" to if ((b[9] and 0x08) != 0) 0 else 1,
        "manual_transmit" to ((b[9] and 0x02) shr 1), "seq_number" to (b[10] or (b[11] shl 8)), "mic" to "CRC")
    when (b[5]) {
        0xa0, 0xa6 -> {
            if (lenByte != 30) return DECODE_FAIL_SANITY
            val t = series(12, 6, 11); val h = plain(14, 6)
            out["model"] = if (b[5] == 0xa0) "TFA-303908" else "TFA-303906"
            out["temperature_C"] = t[0]; out["temperature_C_last"] = join(t); out["humidity"] = h[0]; out["humidity_last"] = join(h)
        }
        0xa3 -> {
            if (lenByte != 30) return DECODE_FAIL_SANITY
            val t = series(12, 6, 11); val e = series(14, 6, 11)
            out["model"] = "TFA-303902"
            out["temperature_C"] = t[0]; out["temperature_C_last"] = join(t)
            out["temperature_C_ext"] = e[0]; out["temperature_C_ext_last"] = join(e)
        }
        0xa4 -> {
            if (lenByte != 36) return DECODE_FAIL_SANITY
            val t = series(12, 8, 12); val h = plain(14, 8); val e = series(16, 8, 12)
            out["model"] = "TFA-303905"
            out["temperature_C"] = t[0]; out["temperature_C_last"] = join(t); out["humidity"] = h[0]; out["humidity_last"] = join(h)
            out["temperature_C_ext"] = e[0]; out["temperature_C_ext_last"] = join(e)
        }
        0xa5 -> {
            if (lenByte != 24) return DECODE_FAIL_SANITY
            val t = series(12, 4, 11)
            out["model"] = "TFA-303901"
            out["temperature_C"] = t[0]; out["temperature_C_last"] = join(t)
        }
        else -> return DECODE_FAIL_SANITY
    }
    ctx.emit(out)
    return 1
}

private const val TH = "outdoor thermometer and hygrometer"
private const val ARRAY = "outdoor array: wind, rain, temperature and humidity"

internal val TFA: List<RDevice> = listOf(
    dev(37, "Inovalley kw9015b, TFA Dostmann 30.3161 rain and temperature sensor", Mod.OOK_PPM, 2000, 4000, 10000, gapLimit = 4800,
        bands = B433, what = "rain gauge and thermometer", decode = ::kw9015b),
    dev(132, "TFA Dostmann 30.3196 temperature and humidity outdoor sensor", Mod.FSK_MANCHESTER_ZEROBIT, 245, 0, 22000, tolerance = 60,
        bands = B868, what = TH, decode = ::tfa303196),
    dev(147, "TFA Drop rain gauge 30.3233.01", Mod.OOK_PWM, 255, 510, 2500, gapLimit = 1300, syncWidth = 750, bands = B433,
        what = "tipping-bucket rain gauge", decode = ::tfaDrop),
    dev(165, "TFA Dostmann 30.3221.02 and 30.3249.02 temperature and humidity outdoor sensor", Mod.OOK_PWM, 235, 480, 850, syncWidth = 836,
        bands = B433, what = TH, decode = ::tfa303221),
    dev(182, "TFA Marbella pool thermometer", Mod.FSK_PCM, 105, 105, 2000, bands = B433, what = "floating pool thermometer", decode = ::marbella),
    dev(232, "TFA Dostmann 14.1504.V2 grill and meat thermometer", Mod.FSK_PCM, 360, 360, 4096, bands = B433, what = "barbecue thermometer", decode = ::tfa141504),
    dev(69, "Fine Offset WH1050 weather station", Mod.OOK_PWM, 544, 1524, 10520, bands = B433, what = ARRAY, decode = ::wh1050),
    dev(246, "TFA 30.3151 weather station", Mod.FSK_PCM, 60, 60, 2500, bands = B868, what = ARRAY, decode = ::wh1050),
    dev(347, "TFA Dostmann 30.390X temperature and humidity series", Mod.FSK_PCM, 61, 61, 3500, tolerance = 5, bands = B868,
        what = "outdoor sensors: 30.3901, 30.3902, 30.3905, 30.3906 and 30.3908", decode = ::tfa30390x),
)
