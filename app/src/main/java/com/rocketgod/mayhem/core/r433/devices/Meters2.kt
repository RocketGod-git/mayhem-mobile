package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.max
import kotlin.math.min

/*
 * Utility meters: Badger ORION and Orion Endpoint, Neptune R900, Arad Dialog3G, Landis & Gyr Gridstream and the
 * Apator Metra pair.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): badger_water.c, neptune_r900.c, arad_ms_meter.c, gridstream.c,
 * apator_metra_erm30.c, apator_metra_eitn30.c, orion_endpoint.c. Twin of web/src/dsp/r433/devices/meters2.ts.
 */

private val US_METER_BANDS = listOf(912_600_000L, 915_000_000L)
private val B915 = listOf(915_000_000L)
private const val WATER = "water meter"
private const val POWER = "electricity meter"

private fun byteAt(m: UBytes, off: Int): Int {
    val i = off shr 3; val s = off and 7
    if (s == 0) return m[i]
    return (((m[i] shl 8) or m[i + 1]) shr (8 - s)) and 0xff
}

private fun u32le(b: UBytes, at: Int): Long = (b[at].toLong()) or (b[at + 1].toLong() shl 8) or (b[at + 2].toLong() shl 16) or (b[at + 3].toLong() shl 24)

/** M-Bus mode T's 3-of-6 line code, borrowed by a meter whose payload is otherwise unrelated. */
private fun decode3of6(byte: Int): Int = when (byte) {
    22 -> 0x0; 13 -> 0x1; 14 -> 0x2; 11 -> 0x3; 28 -> 0x4; 25 -> 0x5; 26 -> 0x6; 19 -> 0x7
    44 -> 0x8; 37 -> 0x9; 38 -> 0xa; 35 -> 0xb; 52 -> 0xc; 49 -> 0xd; 50 -> 0xe; 41 -> 0xf
    else -> 0xff
}

/** The flag bytes' bits are not published, so they are reported raw. Upstream's symbol check is dead code; here it is live. */
private fun badgerOrion(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    if (rowBits < 16 + 12 * 10 || rowBits > 128 + 16 + 12 * 10 + 96) return DECODE_ABORT_LENGTH
    // The last six bits of the run-in plus the ten-bit sync, taken together as two bytes.
    var pos = bits.search(0, 0, UBytes.of(0x54, 0x3d), 16)
    if (pos + 12 * 10 >= rowBits) return DECODE_ABORT_EARLY
    pos += 16
    val row = bits.bb[0]
    val b = UBytes(10)
    for (n in 0 until 10) {
        val hi = decode3of6(byteAt(row, n * 12 + pos) shr 2)
        val lo = decode3of6(byteAt(row, n * 12 + pos + 6) shr 2)
        if (hi > 0x0f || lo > 0x0f) return DECODE_FAIL_MIC
        b[n] = (hi shl 4) or lo
    }
    if ((crc16(b, 8, 0x3d65, 0).inv() and 0xffff) != (((b[8] shl 8) or b[9]) and 0xffff)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Badger-ORION", "type" to "Meter", "id" to (b[0] or (b[1] shl 8) or (b[2] shl 16)), "flags_1" to b[3],
        "volume_gal" to (b[4] or (b[5] shl 8) or (b[6] shl 16)), "flags_2" to b[7], "mic" to "CRC"))
    return 1
}

/** Four chips to a base-6 digit; anything else cannot legally have been sent. */
private val MAP16TO6 = intArrayOf(-1, -1, -1, 0, -1, 1, 2, -1, -1, 5, 4, -1, 3, -1, -1, -1)

/**
 * A base-six payload with no checksum: two thirds of nibble values are illegal, so a corrupted frame almost
 * always fails to decode rather than decoding wrongly. The binary and BCD readings of the counter overlap;
 * nothing on the air says which a meter uses.
 */
private fun neptune(bits: BitBuffer, ctx: DecodeCtx, isBcd: Boolean): Int {
    if (bits.numRows != 1) return DECODE_ABORT_LENGTH
    // The real preamble shifted by its leading zero bit.
    val pre = UBytes.of(0x55, 0x55, 0x55, 0xa9, 0x66, 0x69, 0x65)
    val preLen = pre.size * 8
    val rowBits = bits.bitsPerRow[0]
    val startPos = bits.search(0, 0, pre, preLen)
    if (startPos + preLen + 168 > rowBits) return DECODE_ABORT_LENGTH
    if (startPos == rowBits) return DECODE_ABORT_EARLY
    val row = bits.bb[0]
    val base6 = IntArray(21)
    var count = 0
    var k = startPos + preLen
    while (k < startPos + preLen + 168) {
        val byte = byteAt(row, k)
        val hi = MAP16TO6[(byte shr 4) and 0x0f]; val lo = MAP16TO6[byte and 0x0f]
        if (hi < 0 || lo < 0) return DECODE_ABORT_EARLY
        base6[count++] = 6 * hi + lo
        k += 8
    }
    // Five bits from each base-6 value: 168 bits on the air become 105 of message.
    val packed = BitBuffer()
    for (v in base6) for (s in 4 downTo 0) packed.addBit((v shr s) and 1)
    val b = packed.bytes(0, 0, 13 * 8)
    var consumption = ((b[9] shr 5).toLong() shl 24) or (b[6].toLong() shl 16) or (b[7].toLong() shl 8) or b[8].toLong()
    if (isBcd) {
        var bcd = 0L
        for (i in 5 downTo 0) {
            val digit = ((consumption ushr (4 * i)) and 0x0f).toInt()
            if (digit > 9) return DECODE_ABORT_EARLY
            bcd = bcd * 10 + digit
        }
        consumption = bcd
    }
    ctx.emit(data("model" to if (isBcd) "Neptune-R900BCD" else "Neptune-R900", "type" to "Meter", "id" to u32be(b, 0),
        "unkn1" to (b[4] shr 4), "metertype" to (b[4] and 0x0f), "unkn2" to (b[5] shr 5),
        "nouse" to ((b[5] shr 2) and 0x07),              // days without use, banded
        "backflow" to (b[5] and 0x03),                   // over 35 days: none, low, high
        "consumption" to consumption, "leak" to ((b[9] shr 2) and 0x07),
        "leaknow" to (b[9] and 0x03),                    // over 24 h: 1 intermittent, 2 continuous
        "extra" to hexBytes(b, 3, 10)))
    return 1
}

/*
 * Arad's forty-bit checksum is linear: a running xor of a per-bit key over every set payload bit. So the
 * syndrome names which bits are wrong, and matching it against one, two or three keys repairs up to three bit
 * errors in a frame that would otherwise be lost. The keys come from a forty-bit shift register with three
 * feedback taps, starting from the key for the last payload bit and running backwards.
 */
private val ARAD_KEYS = LongArray(88).also { keys ->
    var key = 0x3037889dd8L
    for (j in 87 downTo 0) {
        keys[j] = key
        val t39 = (key shr 39) and 1L; val t31 = (key shr 31) and 1L; val t23 = (key shr 23) and 1L
        var next = (key shl 1) and 0xffffffffffL
        if (t39 != 0L) next = next xor 0x00014013f8L
        if (t31 != 0L) next = next xor 0x201080d890L
        if (t23 != 0L) next = next xor 0x00018f36c8L
        key = next
    }
}

private fun aradChecksum(b: UBytes): Long {
    var sum = 0L
    for (n in 0 until 11) for (i in 0 until 8) if (((b[n] shr (7 - i)) and 1) != 0) sum = sum xor ARAD_KEYS[n * 8 + i]
    return sum
}

private fun aradFlipBit(b: UBytes, bit: Int) { b[bit shr 3] = b[bit shr 3] xor (1 shl (7 - (bit % 8))) }

private fun aradCorrectBits(b: UBytes, syndrome: Long): Int {
    for (i in 0 until 88) if (ARAD_KEYS[i] == syndrome) { aradFlipBit(b, i); return 1 }
    for (i in 0 until 88) for (j in i + 1 until 88) if ((ARAD_KEYS[i] xor ARAD_KEYS[j]) == syndrome) { aradFlipBit(b, i); aradFlipBit(b, j); return 2 }
    for (i in 0 until 88) for (j in i + 1 until 88) {
        val x = ARAD_KEYS[i] xor ARAD_KEYS[j]
        for (k in j + 1 until 88) if ((x xor ARAD_KEYS[k]) == syndrome) { aradFlipBit(b, i); aradFlipBit(b, j); aradFlipBit(b, k); return 3 }
    }
    return -1
}

/**
 * Transmits inverted and corrects its own bit errors. Only the extracted bytes are complemented, not the shared
 * buffer. The count factor is not sent, so scale and unit are inferred from the serial suffix and a flag byte and
 * reported so a wrong guess is visible.
 */
private fun arad(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    if (rowBits < 18 * 8) return DECODE_ABORT_LENGTH
    // The middle four bytes of the fixed identifier, complemented.
    val matchPos = bits.search(0, 0, UBytes.of(0xf5, 0x13, 0x85, 0x37), 32)
    if (matchPos + 32 > rowBits) return DECODE_ABORT_LENGTH
    val uidStart = max(0, matchPos - 16)
    val payloadStart = matchPos + 32
    if (payloadStart + 128 > rowBits) return DECODE_ABORT_LENGTH
    val uidBits = min(payloadStart - uidStart, 56)
    val u = bits.bytes(0, uidStart, uidBits)
    for (i in 0 until u.size) u[i] = u[i].inv() and 0xff
    if ((uidBits and 7) != 0) u[(uidBits - 1) shr 3] = u[(uidBits - 1) shr 3] and ((0xff00 shr (uidBits and 7)) and 0xff)
    val b = bits.bytes(0, payloadStart, 128)
    for (i in 0 until b.size) b[i] = b[i].inv() and 0xff
    val rx = (b[11].toLong() shl 32) or u32be(b, 12)
    val calc = aradChecksum(b)
    var corrections = 0
    if (rx != calc) {
        corrections = aradCorrectBits(b, rx xor calc)
        if (corrections < 0) return DECODE_FAIL_MIC
    }
    val serno = b[1] or (b[2] shl 8) or (b[3] shl 16)
    val snSufx = b[4]
    val flags1 = b[5]
    val readRaw = b[6] or (b[7] shl 8) or (b[8] shl 16)
    var scale = 0.1; var unit = "m3"
    if (snSufx == 0x00 && (flags1 == 0x00 || flags1 == 0x40)) { scale = 0.01; unit = "m3" }
    else if (snSufx == 0x27 && flags1 == 0x00) { scale = 0.1; unit = "gal" }
    ctx.emit(data("model" to "AradMsMeter-Dialog3G", "type" to "Meter", "id" to serno.toString().padStart(8, '0') + "-" + hexOf(snSufx),
        "uid" to hexBytes(u, (uidBits + 7) shr 3),       // fixed across the product line: 3e690aec7ac8
        "leaking" to ((b[0] and 0x20) shr 5), "flags1" to hexOf(flags1), "gear" to scale, "volume" to round3(readRaw * scale),
        "unit" to unit, "flags2" to hexOf(b[10]), "corrections" to corrections, "mic" to "CHECKSUM"))
    return 1
}

/** Each utility is issued its own CRC init: an identifier, not a secret, so a passing frame also names who sent it. */
private val GRIDSTREAM_CRC_INIT = listOf(
    Triple(0xe623, "Kansas City MO", "Evergy-Missouri West"), Triple(0x5fd6, "Dallas TX", "Oncor"),
    Triple(0xd553, "Austin TX", "Austin Energy"), Triple(0x45f8, "Dallas TX", "CoServ"),
    Triple(0x62c1, "Quebec CAN", "Hydro-Quebec"), Triple(0x23d1, "Seattle WA", "Seattle City Light"),
    Triple(0x2c22, "Santa Barbara CA", "Southern California Edison"), Triple(0x142a, "Washington", "Puget Sound Energy"),
    Triple(0x47f7, "Pennsylvania", "PPL Electric"), Triple(0x22c6, "Long Island NY", "PSEG Long Island"),
    Triple(0x8819, "Alameda CA", "Alameda Municipal Power"), Triple(0x4e2d, "Milwaukee WI", "We Energies"),
    Triple(0x1d65, "Phoenix AZ", "APS"), Triple(0xb9a9, "Mattoon IL", "Coles-Moultrie Electric Co-op"),
    Triple(0xd1ff, "Newark NJ", "PSEG New Jersey"), Triple(0xba1f, "Burleson TX", "United Cooperative Services"),
)

private fun gridstreamChecksum(fullLength: Int, length: Int, b: UBytes, adjust: Int): Int {
    if (fullLength - 4 + adjust < length) return DECODE_ABORT_LENGTH
    val crc = ((b[2 + length + adjust] shl 8) or b[3 + length + adjust]) and 0xffff
    for (i in GRIDSTREAM_CRC_INIT.indices) if (crc16(b, length - 2, 0x1021, GRIDSTREAM_CRC_INIT[i].first, 4 + adjust) == crc) return i
    return DECODE_FAIL_MIC
}

/**
 * Mesh traffic between meters and collectors rather than a broadcast: source, destination, uptime and the mesh
 * clock are readable; the bodies are not decoded, and the ones marked encrypted genuinely are. 8N1 serial.
 */
private fun gridstream(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 1) return DECODE_FAIL_SANITY
    val rowBits = bits.bitsPerRow[0]
    val b = UBytes(256)
    val protocolVersion: Int
    var offset = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0x00, 0x5f, 0xf0), 36) + 36
    if (offset >= rowBits) {
        offset = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0x00, 0x7f, 0xf8), 37) + 37
        if (offset >= rowBits) return DECODE_FAIL_SANITY
        protocolVersion = 5
    } else protocolVersion = 4
    val decodedLen = extractBytesUart8n1(bits.bb[0], offset, min(rowBits - offset, b.size * 10), b)
    if (decodedLen < 5) return DECODE_FAIL_SANITY
    if (b[0] != 0x2a) return DECODE_FAIL_OTHER
    val subtype = b[1]
    val subtypeMod = if (subtype == 0xd2) -1 else 0
    val streamLen = if (subtype == 0xd2) b[2] else (b[2] shl 8) or b[3]
    val ci = b[4 + subtypeMod]
    // An AES body ends in an authentication tag rather than a CRC: reported flagged rather than dropped.
    if (subtype == 0xd2 && ci == 0x52) {
        ctx.emit(data("model" to "LandisGyr-GS", "type" to "Meter", "subtype" to subtype, "protoversion" to protocolVersion, "ci" to ci, "encrypted" to 1))
        return 1
    }
    val crcIdx = gridstreamChecksum(decodedLen, streamLen, b, subtypeMod)
    if (crcIdx < 0) return DECODE_FAIL_MIC
    val (initValue, location, provider) = GRIDSTREAM_CRC_INIT[crcIdx]
    val out = data("model" to "LandisGyr-GS", "type" to "Meter", "networkID" to hexOf(initValue, 4), "location" to location,
        "provider" to provider, "subtype" to subtype, "protoversion" to protocolVersion, "ci" to ci, "mic" to "CRC")
    var uptime = 0L
    if (subtype == 0x55) {
        out["destaddress"] = hexBytes(b, 6, 5)
        out["wanaddress"] = hexBytes(b, 6, 11)
        out["id"] = hexBytes(b, 4, 24)
        uptime = u32be(b, 18)
    } else if (subtype == 0xd5) {
        out["destaddress"] = hexBytes(b, 4, 5)
        out["id"] = hexBytes(b, 4, 9)
        if (streamLen == 0x47) {
            out["timestamp"] = u32be(b, 14)
            uptime = u32be(b, 22)
            out["wanaddress"] = hexBytes(b, 6, 30)
        }
    }
    if (uptime > 0) out["uptime"] = uptime               // seconds since that meter last lost power
    ctx.emit(out)
    return 1
}

/** No key and never changes, so one capture with a known reading broke it. Not an involution: 1→7 but 7→4. */
private val APATOR_NIBBLE_MAP = intArrayOf(0x0, 0x7, 0xf, 0x9, 0xe, 0xd, 0x3, 0x4, 0x2, 0x6, 0xc, 0xb, 0x1, 0x8, 0xa, 0x5)

/**
 * One protocol in two lengths. The check covers the frame after whitening is stripped but before the nibble
 * substitution is undone, so it protects the transmitted form rather than the decoded one.
 */
private fun apator(bits: BitBuffer, ctx: DecodeCtx, expectLen: Int, model: String): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val rowBits = bits.bitsPerRow[0]
    val startPos = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0x69, 0x9a), 32)
    if (startPos == rowBits) return DECODE_ABORT_EARLY
    val at = startPos + 32
    val frameLen = expectLen + 3
    if (at + frameLen * 8 > rowBits) return DECODE_ABORT_LENGTH
    // 0xff is the first byte of the whitening sequence.
    if ((byteAt(bits.bb[0], at) xor 0xff) != expectLen) return DECODE_ABORT_EARLY
    val frame = bits.bytes(0, at, frameLen * 8)
    ibmWhitening(frame, frameLen)
    val rxCrc = ((frame[expectLen + 1] shl 8) or frame[expectLen + 2]) and 0xffff
    if (crc16(frame, expectLen + 1, 0x8005, 0xffff) != rxCrc) return DECODE_FAIL_MIC
    val p = UBytes(expectLen)
    for (i in 0 until 2 * expectLen) {
        val shift = if (i % 2 != 0) 0 else 4
        p[i shr 1] = p[i shr 1] or (APATOR_NIBBLE_MAP[(frame[1 + (i shr 1)] shr shift) and 0x0f] shl shift)
    }
    // Year from 2000 above the month and day, in one little-endian sixteen-bit field.
    val dateAt = if (expectLen == 0x13) 15 else 12
    val date = ((p[dateAt + 1] shl 8) or p[dateAt]) and 0xffff
    val dateStr = "${2000 + ((date shr 9) and 0x7f)}-${((date shr 5) and 0x0f).toString().padStart(2, '0')}-${(date and 0x1f).toString().padStart(2, '0')}"
    val out = data("model" to model, "type" to "Meter", "len" to expectLen, "date" to dateStr, "mic" to "CRC")
    if (expectLen == 0x13) {
        // The identifier printed on the radio module, not the one on the dial.
        out["id"] = u32le(p, 0) xor 0x30000000L
        out["volume_m3"] = ((u32le(p, 4) and 0x0fffffffL) ushr 3) / 1000.0     // the counter runs in liters
    } else {
        out["id"] = u32le(p, 0) xor 0x38000000L
        out["current_heating"] = ((p[11] shl 8) or p[10]) and 0xffff
        out["last_yr_heating"] = ((p[5] shl 8) or p[4]) and 0xffff
    }
    // The rest is unidentified, so it goes out as hex rather than being guessed into fields.
    out["payload"] = hexBytes(p, expectLen)
    ctx.emit(out)
    return 1
}

/** The model is implied by which block the serial number falls in. */
private fun orionEndpointModel(id: Long): String = when (id) {
    in 30000000L..59999999L -> "ME or SE"
    in 60000000L..69999999L -> "Mobile M"
    in 70000000L..89999999L -> "Classic (CE)"
    in 110000000L..119999999L -> "LTE"
    in 120000000L..129999999L -> "LTE-M or LTE-MS"
    in 130000000L..139999999L -> "C or CS"
    in 140000000L..148999999L -> "HLA"
    in 149000000L..149999999L -> "HLC"
    in 150000000L..159999999L -> "HLB"
    in 160000000L..169999999L -> "HLD"
    in 170000000L..179999999L -> "HLFX"
    in 180000000L..189999999L -> "HLG"
    else -> "Unknown Model"
}

/**
 * Hops across about fifty channels every 150 s, so catching one is about timing, not difficulty. Unwhitened with
 * the CC1101 sequence, then the whole frame including its CRC must run to zero. A zero daily reading means none
 * was sent.
 */
private fun orionEndpoint(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows > 1) return DECODE_FAIL_SANITY
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    val msgLen = bits.bitsPerRow[0]
    if (msgLen < 232 || msgLen > 290) return DECODE_ABORT_LENGTH
    var offset = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0xec, 0x62, 0xec, 0x62), 48)
    if (offset >= msgLen) return DECODE_ABORT_EARLY
    offset += 48
    if (msgLen - offset < 184) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, offset, 184)
    ibmWhitening(b, 23)
    if (crc16(b, 23, 0x8005, 0xffff) != 0) return DECODE_FAIL_MIC
    val id = u32le(b, 5)
    val dailyRaw = u32le(b, 16)
    val out = data("model" to "Orion-Endpoint", "type" to "Meter", "id" to id, "endpoint_model" to orionEndpointModel(id),
        "leaking" to ((b[10] and 0x20) shr 5), "reading" to u32le(b, 12), "flags_1" to ((b[9] shl 16) or (b[10] shl 8) or b[11]),
        "flags_2" to b[20], "mic" to "CRC")
    if (dailyRaw != 0L) out["daily_reading"] = dailyRaw
    ctx.emit(out)
    return 1
}

internal val METERS2: List<RDevice> = listOf(
    dev(223, "Badger ORION water meter, 100kbps", Mod.FSK_PCM, 10, 10, 1000, bands = listOf(916_450_000L), what = WATER, decode = ::badgerOrion),
    dev(228, "Neptune R900 flow meters", Mod.OOK_PCM, 30, 30, 320, bands = US_METER_BANDS, what = WATER) { _, bits, ctx -> neptune(bits, ctx, false) },
    // The same frames as above, read as decimal; on any one meter at most one of the two is right.
    dev(385, "Neptune R900 BCD flow meters", Mod.OOK_PCM, 30, 30, 320, disabled = true, bands = US_METER_BANDS, what = WATER) { _, bits, ctx -> neptune(bits, ctx, true) },
    dev(260, "Arad/Master Meter Dialog3G water utility meter", Mod.FSK_MANCHESTER_ZEROBIT, 8.4, 8.4, 100, bands = B915, what = WATER, decode = ::arad),
    dev(271, "Landis & Gyr Gridstream Power Meters 9.6k", Mod.FSK_PCM, 104, 104, 20000, bands = B915, what = POWER, decode = ::gridstream),
    dev(272, "Landis & Gyr Gridstream Power Meters 19.2k", Mod.FSK_PCM, 52, 52, 20000, bands = B915, what = POWER, decode = ::gridstream),
    dev(273, "Landis & Gyr Gridstream Power Meters 38.4k", Mod.FSK_PCM, 22, 22, 20000, bands = B915, what = POWER, decode = ::gridstream),
    // Upstream records no frequency for either Apator meter, so none is claimed.
    dev(277, "Apator Metra E-RM 30 water meter", Mod.FSK_PCM, 25, 25, 5000, what = WATER) { _, bits, ctx -> apator(bits, ctx, 0x13, "ApatorMetra-ERM30") },
    dev(296, "Apator Metra E-ITN 30 heat cost allocator", Mod.FSK_PCM, 25, 25, 5000, what = "heat cost allocator") { _, bits, ctx ->
        apator(bits, ctx, 0x11, "ApatorMetra-EITN30") },
    dev(282, "Orion Endpoint from Badger Meter, GIF2014W-OSE, water meter", Mod.FSK_PCM, 10, 10, 1000, bands = B915, what = WATER, decode = ::orionEndpoint),
    dev(290, "Orion Endpoint from Badger Meter, GIF2020OCECNA, water meter", Mod.FSK_PCM, 5, 5, 1000, bands = B915, what = WATER, decode = ::orionEndpoint),
)
