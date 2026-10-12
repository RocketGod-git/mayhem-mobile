package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.sqrt

/*
 * Weather stations and sensor platforms: ELV EM 1000 and WS 2000, Archos TBH, Emax W6 and its rebrands, NetAtmo,
 * the Omni multisensor and the Elsner Solexa sunblind sensor.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): elv.c, archos_tbh.c, emax.c, netatmo_th.c, omni.c, elsner_solexa.c.
 * Twin of web/src/dsp/r433/devices/stations.ts.
 */

private val BAND_433 = listOf(433_920_000L)
private val BAND_868 = listOf(868_300_000L)
private val BAND_868_95 = listOf(868_950_000L)

/** n bits from an absolute position, least significant first: fields are sent LSB first into an MSB-first buffer. */
private fun adPop(bb: UBytes, n: Int, bit: Int): Int {
    var v = 0
    for (i in 0 until n) if ((bb[(bit + i) shr 3] and (1 shl (7 - ((bit + i) % 8)))) != 0) v = v or (1 shl i)
    return v
}

/**
 * A byte-by-byte majority vote over three repeats first; rows two and three are zeroed views when absent, just as
 * upstream's preallocated buffer is, so the indexing is kept as written. Off upstream: its timings are guesses.
 */
private fun elvEm1000(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val voted = UBytes(14)
    for (i in 0 until 14) {
        val r0 = bits.bb[0][i]; val r1 = bits.bb[1][i]; val r2 = bits.bb[2][i]
        voted[i] = if (r0 == r1 || r0 == r2) r0 else if (r1 == r2) r1 else return DECODE_ABORT_EARLY
    }
    var bit = 18
    val dec = IntArray(10)
    var checksum = 0
    for (i in 0 until 9) {
        dec[i] = adPop(voted, 8, bit); bit += 8
        if (adPop(voted, 1, bit) == 0) return DECODE_ABORT_EARLY
        bit += 1
        checksum = checksum xor dec[i]
    }
    if (adPop(voted, 8, bit) != checksum) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "ELV-EM1000", "type" to "Energy", "id" to dec[1], "seq" to dec[2], "total" to (dec[3] or (dec[4] shl 8)),
        "current" to (dec[5] or (dec[6] shl 8)), "peak" to (dec[7] or (dec[8] shl 8))))
    return 1
}

/** A leading `!` marks a sensor kind upstream cannot decode. */
private val WS2000_TYPES = listOf("!AS3", "AS2000/ASH2000/S2000/S2001A/S2001IA/ASH2200/S300IA", "!S2000R", "!S2000W", "S2001I/S2001ID",
    "!S2500H", "!Pyrano", "KS200/KS300")

/** Nibbles after the type nibble; upstream fills nine of sixteen, and a zero length leaves the xor non-zero, rejecting it. */
private val WS2000_LENGTHS = intArrayOf(5, 8, 5, 8, 12, 9, 8, 14, 8, 0, 0, 0, 0, 0, 0, 0)

/**
 * Four-bit nibbles with a stop bit after each, LSB first; readings are decimal digits with a separate sign bit.
 * An xor and a four-bit sum plus five both have to hold. The combo sensor reuses positions for wind and rain.
 */
private fun elvWs2000(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.bb[0]
    val dec = IntArray(16)
    var bit = 11
    var check = 0; var sum = 0
    dec[0] = adPop(row, 4, bit); bit += 4
    if (adPop(row, 1, bit) == 0) return DECODE_ABORT_EARLY
    bit += 1
    check = check xor dec[0]; sum += dec[0]
    for (i in 1..WS2000_LENGTHS[dec[0]]) {
        dec[i] = adPop(row, 4, bit); bit += 4
        if (adPop(row, 1, bit) == 0) return DECODE_ABORT_EARLY
        bit += 1
        check = check xor dec[i]; sum += dec[i]
    }
    if (check != 0) return DECODE_FAIL_MIC
    if (adPop(row, 4, bit) != ((sum + 5) and 0x0f)) return DECODE_FAIL_MIC
    val temp = (if ((dec[1] and 8) != 0) -1 else 1) * (dec[4] * 10 + dec[3] + dec[2] * 0.1)
    // Only the barometric sensor carries a pressure, offset by 200 hPa, so it is never zero when present.
    val pressure = if (dec[0] == 4) 200 + dec[10] * 100 + dec[9] * 10 + dec[8] else 0
    val out = data("model" to "ELV-WS2000", "type" to "Weather", "subtype" to (WS2000_TYPES.getOrNull(dec[0]) ?: "?"), "id" to (dec[1] and 7),
        "temperature_C" to round1(temp))
    if (dec[0] == 7) {
        out["humidity"] = (dec[6] * 10 + dec[5]).toDouble()
        out["wind_avg_km_h"] = round1(dec[9] * 10 + dec[8] + dec[7] * 0.1)
        val rainsum = (dec[12] shl 8) + (dec[11] shl 4) + dec[10]
        out["rain_count"] = rainsum
        // 295 ml/m² per tip by default; the manual says to calibrate per unit.
        out["rain_mm"] = round1(rainsum * 0.295)
        out["is_raining"] = if ((dec[1] and 2) != 0) 1 else 0
        out["unknown"] = dec[13]
    } else {
        out["humidity"] = round1(dec[7] * 10 + dec[6] + dec[5] * 0.1)
    }
    if (pressure != 0) out["pressure_hPa"] = pressure
    ctx.emit(out)
    return 1
}

private val TBH_PREAMBLE = UBytes.of(0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91)
/** The published table the payload is chained against; the transform is its own inverse. */
private val TBH_INFO = intArrayOf(0x19, 0xf8, 0x28, 0x30, 0x6d, 0x0c, 0x94, 0x54, 0x22, 0xf2, 0x37, 0xc9, 0x66, 0xa3, 0x97, 0x57)

/**
 * An open hardware sensor. The length byte is the first byte the CRC covers, so a bad length fails the check. The
 * power frame's inner CRC-8 wants a length where the type byte sits, as the sensor computed it.
 */
private fun archosTbh(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val startPos = bits.search(0, 0, TBH_PREAMBLE, 48)
    if (startPos == bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] < 12 * 8) return DECODE_ABORT_LENGTH
    val len = bits.bytes(0, startPos + 48, 8)[0]
    if (len > 60) return DECODE_ABORT_LENGTH
    val frame = UBytes(63)
    frame[0] = len
    frame.setAll(bits.bytes(0, startPos + 56, (len + 2) * 8).sub(0, len + 2), 1)
    if (crc16(frame, len + 1, 0x8005, 0xffff) != ((frame[len + 1] shl 8) or frame[len + 2])) return DECODE_FAIL_MIC
    val payload = UBytes(62)
    payload[0] = frame[1] xor TBH_INFO[0]
    for (i in 1 until len) payload[i] = frame[i] xor frame[i + 1] xor TBH_INFO[i % TBH_INFO.size]
    val type = payload[4]
    val id = payload[0].toLong() or (payload[1].toLong() shl 8) or (payload[2].toLong() shl 16) or (payload[3].toLong() shl 24)
    return when (type) {
        1 -> {
            payload[4] = len - 4
            if (crc8(payload, len - 5, 0x07, 0x00, 4) != payload[len - 1]) return DECODE_FAIL_MIC
            ctx.emit(data("model" to "Archos-TBH", "type" to "Energy", "id" to id, "power_idx" to ((payload[6] shl 16) or (payload[7] shl 8) or payload[8]),
                "power_max" to ((payload[12] shl 8) or payload[13]),
                "timestamp" to (((payload[9] shl 16) or (payload[10] shl 8) or payload[11]) shr 3),   // eight ticks a second
                "mic" to "CRC"))
            1
        }
        2 -> {
            // Tenths of a kelvin, offset to freezing.
            ctx.emit(data("model" to "Archos-TBH", "type" to "Weather", "id" to id,
                "temperature_C" to round1((((payload[6] shl 8) or payload[5]) - 2732) * 0.1), "humidity" to payload[7], "mic" to "CRC"))
            1
        }
        3 -> { ctx.emit(data("model" to "Archos-TBH", "type" to "Weather", "id" to id, "battery_ok" to round2(payload[5] * 0.01), "mic" to "CRC")); 1 }
        4 -> { ctx.emit(data("model" to "Archos-TBH", "type" to "Weather", "id" to id, "battery_ok" to 0, "mic" to "CRC")); 1 }
        else -> DECODE_FAIL_SANITY
    }
}

private val EMAX_PREAMBLE = UBytes.of(0xaa, 0xaa, 0xca, 0xca, 0x54)
private const val EMAX_MESSAGE_BITLEN = 264

/**
 * One row, walked repeat by repeat, since a station at full light can fake a packet boundary; a failed repeat
 * moves on to the next preamble. The high nibble of byte one splits thermometer from station, and a filler byte
 * near the end tells three station variants apart. Station fields are stored plus one.
 */
private fun emax(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    var ret = 0
    var pos = 0
    while (true) {
        pos = bits.search(0, pos, EMAX_PREAMBLE, 40)
        if (pos + EMAX_MESSAGE_BITLEN > rowBits) break
        pos += 40
        if (pos + 32 * 8 > rowBits) { ret = DECODE_ABORT_LENGTH; continue }
        val b = bits.bytes(0, pos, 32 * 8)
        val kind = (b[1] and 0xf0) shr 4
        val subtype = b[3] and 0x03
        var checksum = addBytes(b, 31)
        if (kind != 0 && subtype == 0x3) checksum -= 0x9a   // one variant offsets its sum
        if ((checksum and 0xff) != b[31]) { ret = DECODE_FAIL_MIC; continue }
        val channel = b[1] and 0x0f
        val id = (b[2] shl 4) or (b[3] shr 4)
        val batteryOk = if ((b[3] and 0x08) != 0) 0 else 1
        val pairing = (b[3] and 0x04) != 0
        if (kind != 0) {
            // Temperature scattered across three bytes with a nibble ignored in the middle.
            val tempRaw = ((b[4] and 0x0f) shl 8) or (b[5] and 0xf0) or (b[6] and 0x0f)
            val out = data("model" to when (subtype) { 0x1 -> "Altronics-X7064"; 0x3 -> "Altronics-X7064A"; else -> "Emax-unknown" },
                "type" to "Weather", "id" to id, "channel" to channel, "battery_ok" to batteryOk)
            if (subtype == 0x1) out["temperature_F"] = round1((tempRaw - 900) * 0.1)
            if (subtype == 0x3) out["temperature_C"] = round1((tempRaw - 500) * 0.1)
            out["humidity"] = b[7]
            if (pairing) out["pairing"] = 1
            out["mic"] = "CHECKSUM"
            ctx.emit(out)
            return 1
        }
        fun m1(i: Int) = (b[i] - 1) and 0xff
        val tempRaw = ((b[4] and 0x0f) shl 8) or b[5]
        val tempF = round1((tempRaw - 900) * 0.1)
        val humidity = b[6]
        val speedKmh = round1(((m1(7) shl 8) or m1(8)) * 0.2)
        val directionDeg = ((m1(9) and 0x0f) shl 8) or m1(10)
        val rainMm = round1(((m1(11) shl 8) or m1(12)) * 0.2)
        fun lux(): Int { val v = ((m1(14) and 0x7f) shl 8) or m1(15); return if ((m1(14) and 0x80) != 0) v * 10 else v }   // top bit: ×10
        fun base(model: String) = data("model" to model, "type" to "Weather", "id" to id, "channel" to channel, "battery_ok" to batteryOk)
        val out: R433Data
        if (b[29] == 0x17) {
            // UV and light, no gust; a tag of three is the variant that leaves both empty.
            val tag = (m1(13) and 0xc0) shr 6
            out = base(if (tag != 3) "Emax-W6" else "IMETEO-X6")
            out["temperature_F"] = tempF; out["humidity"] = humidity; out["wind_avg_km_h"] = speedKmh
            out["wind_dir_deg"] = directionDeg; out["rain_mm"] = rainMm
            if (tag != 3) { out["uvi"] = m1(13) and 0x1f; out["light_lux"] = lux() }
        } else if (b[29] == 0x16 && b[14] == 0x01 && b[15] == 0x01) {
            // The light bytes are the fixed placeholder, so byte sixteen is a gust instead.
            out = base("Emax-EM3551H")
            out["temperature_F"] = tempF; out["humidity"] = humidity; out["wind_avg_km_h"] = speedKmh
            out["wind_max_km_h"] = round1(b[16] / 1.5); out["wind_dir_deg"] = directionDeg; out["rain_mm"] = rainMm
        } else if (b[29] == 0x16) {
            // Real light readings, and this one reports Celsius.
            out = base("Lacrosse-WS6262")
            out["temperature_C"] = round1((tempRaw - 500) * 0.1); out["humidity"] = humidity; out["wind_avg_km_h"] = speedKmh
            out["wind_max_km_h"] = round1(b[16] / 1.5); out["wind_dir_deg"] = directionDeg; out["rain_mm"] = rainMm
            out["uvi"] = m1(13) and 0x1f; out["light_lux"] = lux()
        } else {
            pos += EMAX_MESSAGE_BITLEN
            continue
        }
        if (pairing) out["pairing"] = 1
        out["mic"] = "CHECKSUM"
        ctx.emit(out)
        return 1
    }
    return ret
}

private val NETATMO_PREAMBLE = UBytes.of(0xaa, 0xaa, 0xe7, 0x12)

/**
 * Four messages by length, including the base station's own request. Known fields are little endian in a
 * big-endian frame. The anemometer reports four ultrasonic axis values; speed and direction are reconstructed from
 * the two diagonals, so the raw four go out too.
 */
private fun netatmo(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val startPos = bits.search(0, 0, NETATMO_PREAMBLE, 32)
    if (startPos == bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val len = bits.bytes(0, startPos + 32, 8)[0]
    val b = UBytes(256 + 2 + 1)
    b[0] = len
    b.setAll(bits.bytes(0, startPos + 40, (len + 2) * 8).sub(0, len + 2), 1)
    if (crc16(b, len + 1, 0x8005, 0xffff) != ((b[len + 1] shl 8) or b[len + 2])) return DECODE_FAIL_MIC
    val id = u32be(b, 1)
    val signal = signed(b[6], 8)
    when (len) {
        6 -> ctx.emit(data("model" to "NetAtmo-TH", "type" to "Weather", "id" to id, "signal_dB" to signal, "mic" to "CRC"))
        0x19 -> ctx.emit(data("model" to "NetAtmo-TH", "type" to "Weather", "id" to id,
            "battery_mV" to (b[8] * 256 + b[7]) * 2,     // half millivolts
            "signal_dB" to signal, "temperature_C" to round1(signed((b[23] shl 8) or b[22], 16) * 0.1), "humidity" to b[25], "mic" to "CRC"))
        0x31 -> {
            val a = signed((b[26] shl 8) or b[25], 16); val bb = signed((b[28] shl 8) or b[27], 16)
            val c = signed((b[30] shl 8) or b[29], 16); val dd = signed((b[32] shl 8) or b[31], 16)
            val ws315 = a + bb; val ws45 = c + dd
            ctx.emit(data("model" to "NetAtmo-Wind", "type" to "Weather", "id" to id, "battery_mV" to b[8] * 256 + b[7], "signal_dB" to signal,
                "raw_a_315" to a, "raw_b_315" to bb, "raw_c_045" to c, "raw_d_045" to dd,
                "wind_spd_km_h" to round1(sqrt((ws45 * ws45 + ws315 * ws315).toDouble()) * 0.05),
                // The axes sit at 45 and 315 degrees, so the angle is offset by 315 before wrapping.
                "wind_dir_deg" to (atan2(ws45.toDouble(), ws315.toDouble()) / PI * 180 + 315).toInt() % 360, "mic" to "CRC"))
        }
        else -> ctx.emit(data("model" to "NetAtmo-THW", "type" to "Weather", "id" to id, "signal_dB" to signal, "mic" to "CRC"))
    }
    return 1
}

/** Upstream's sketch invites owners to change this seed, so a unit built with another will not decode. */
private const val OMNI_INITCRC = 0xaa

/**
 * A Pico sketch whose payload depends on what is attached: two formats are defined, the rest go out as hex.
 * Upstream's header calls byte five a second humidity; its code reports light, and the code is what runs.
 */
private fun omni(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val r = bits.findRepeatedRow(2, 80)
    if (r < 0 || bits.bitsPerRow[r] > 82) return DECODE_ABORT_LENGTH
    val b = bits.bb[r]
    if (crc8(b, 9, 0x97, OMNI_INITCRC) != b[9]) return DECODE_FAIL_MIC
    val fmt = b[0] shr 4
    val id = b[0] and 0x0f
    val payload = hexBytes(b, 8, 1)
    val itempC = round2((signed((b[1] shl 8) or b[2], 16) shr 4) * 0.1)
    val volts = round2(b[8] * 0.01 + 3.0)
    when (fmt) {
        0 -> ctx.emit(data("model" to "Omni-Multisensor", "type" to "Weather", "id" to id, "channel" to fmt, "temperature_C" to itempC,
            "voltage_V" to volts, "payload" to payload, "mic" to "CRC"))
        1 -> ctx.emit(data("model" to "Omni-Multisensor", "type" to "Weather", "id" to id, "channel" to fmt, "temperature_C" to itempC,
            // The cast to sixteen bits drops the nibble above, rather than masking it first.
            "temperature_2_C" to round2((signed((b[2] shl 12) or (b[3] shl 4), 16) shr 4) * 0.1), "humidity" to b[4], "light_pct" to b[5],
            "pressure_hPa" to round1(((b[6] shl 8) or b[7]) * 0.1), "voltage_V" to volts, "mic" to "CRC"))
        else -> ctx.emit(data("model" to "Omni-Multisensor", "type" to "Weather", "id" to id, "channel" to fmt, "payload" to payload, "mic" to "CRC"))
    }
    return 1
}

/** Shift left, smearing ones in underneath when the low bit is set: what the reverse engineering found. */
private fun elsnerSpread(x: Int, k: Int): Int {
    var v = (x shl k) and 0xff
    if ((x and 1) != 0) v = v or (((1 shl k) - 1) and 0xff)
    return v
}

private fun elsnerStep(prev: Int, base: Int, oldBit: Int, newBit: Int) = (elsnerSpread(prev, 1) + base + newBit - oldBit) and 0xff

/** Undo the self-synchronizing whitening x^7 + x^5 + 1 (lags 5 and 7), or just the seven-bit lag. */
private fun elsnerDescramble(input: UBytes, nbytes: Int, withFive: Boolean): UBytes {
    val out = UBytes(nbytes)
    for (n in 0 until nbytes * 8) {
        var bit = bitAt(input, n)
        if (withFive && n - 5 >= 0) bit = bit xor bitAt(input, n - 5)
        if (n - 7 >= 0) bit = bit xor bitAt(input, n - 7)
        out[n shr 3] = out[n shr 3] or (bit shl (7 - (n % 8)))
    }
    return out
}

/** The seven tokens one handset was seen to send; upstream reports nothing for any other. */
private fun elsnerCommandName(token: Int): String? = when (token) {
    0xcc00 -> "close"; 0xbb00 -> "open"; 0xbd00 -> "stop_or_release"; 0x00ef -> "automode_a"; 0x00e3 -> "automode_b"
    0xaac0 -> "filler"; 0xa9c0 -> "automode_companion"; else -> null
}

private val ELSNER_ANCHOR = UBytes.of(0x0a)

/**
 * The payload's first eleven bytes are an arithmetic expansion of one rolling byte; three fixed identities confirm
 * the model before the rolling state and counter are reported. The button press is a difference from what that
 * arithmetic predicts, at positions a selector bit picks. A candidate temperature turned out to be an identity
 * constant over all 256 states, so none is reported. No published capture, so the CRC is enforced, not verified.
 */
private fun elsner(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val pos = bits.search(0, 0, ELSNER_ANCHOR, 8) + 8
    val len = bits.bitsPerRow[0]
    if (pos >= len || len - pos < 38 * 8) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, pos, 38 * 8)
    if (crc16(b, 36, 0x1021, 0x68b3) != ((b[36] shl 8) or b[37])) return DECODE_FAIL_MIC
    val p = elsnerDescramble(b, 36, true)
    val rp0 = b[4]
    val paramOk = b[7] == ((elsnerSpread(rp0, 3) + 0x48) and 0xff) && b[8] == ((elsnerSpread(rp0, 4) + 0xd0) and 0xff) &&
        b[9] == ((elsnerSpread(rp0, 5) + 0xa0) and 0xff)
    val counter = (b[5] - elsnerSpread(rp0, 1)) and 0xff
    var command: String? = null
    if (paramOk) {
        val q = elsnerDescramble(b, 36, false)
        if (((q[4 + 3] shr 4) and 1) != 0) {
            val branch1 = (q[4 + 17] shr 2) and 1
            val l12 = parity8(rp0 and 0xf9); val l13 = parity8(rp0 and 0xfd); val l14 = 1 xor parity8(rp0 and 0xff)
            val l17 = parity8(rp0 and 0xfe); val l18 = 1 xor parity8(rp0 and 0xff); val l19 = parity8(rp0 and 0xfe)
            val exp0: Int; val exp1: Int; val obs0: Int; val obs1: Int
            if (branch1 == 0) {
                exp0 = elsnerStep(b[4 + 12], 0x6a, l12, l13); exp1 = elsnerStep(exp0, 0x30, l13, l14); obs0 = b[4 + 13]; obs1 = b[4 + 14]
            } else {
                exp0 = elsnerStep(b[4 + 17], 0x30, l17, l18); exp1 = elsnerStep(exp0, 0x30, l18, l19); obs0 = b[4 + 18]; obs1 = b[4 + 19]
            }
            command = elsnerCommandName((((obs0 - exp0) and 0xff) shl 8) or ((obs1 - exp1) and 0xff))
        }
    }
    val out = data("model" to "Elsner-Solexa", "type" to "Blind", "id" to hexBytes(p, 4))
    if (paramOk) { out["rolling"] = hexOf(rp0); out["counter"] = counter }
    if (command != null) out["command"] = command
    out["data"] = hexBytes(p, 32, 4)
    out["mic"] = "CRC"
    ctx.emit(out)
    return 1
}

internal val STATIONS: List<RDevice> = listOf(
    dev(6, "ELV EM 1000", Mod.OOK_PPM, 500, 1000, 30000, gapLimit = 7250, disabled = true, bands = BAND_868, what = "energy meter", decode = ::elvEm1000),
    dev(7, "ELV WS 2000", Mod.OOK_PWM, 366, 854, 1000, disabled = true, bands = BAND_868, what = "weather station receiver", decode = ::elvWs2000),
    dev(144, "TBH weather sensor", Mod.FSK_PCM, 212, 212, 3000, bands = BAND_433, what = "weather and power sensor", decode = ::archosTbh),
    dev(215, "Emax W6, rebranded as Altronics x7063/4/x7064A, Optex 990040/50/51, Orium 13093/13123, " +
        "Infactory FWS-1200, Newentor Q9, Otio 810025, Protmex PT3390A, Jula Marquant 014331/32, " +
        "TechniSat IMETEO X6, weather station or temperature/humidity sensor", Mod.FSK_PCM, 90, 90, 9000, bands = BAND_433,
        what = "weather station", decode = ::emax),
    dev(336, "NetAtmo temperature/humidity and wind sensors", Mod.FSK_PCM, 8.5, 8.5, 800, bands = BAND_868_95,
        what = "weather station outdoor modules", decode = ::netatmo),
    dev(337, "Omni Multisensor", Mod.OOK_PWM, 200, 400, 1250, gapLimit = 500, syncWidth = 600, bands = BAND_433, what = "multisensor", decode = ::omni),
    dev(364, "Elsner Solexa 230V", Mod.FSK_MANCHESTER_ZEROBIT, 11, 11, 25, bands = BAND_868,
        what = "sunblind wind, light and temperature sensor", decode = ::elsner),
)
