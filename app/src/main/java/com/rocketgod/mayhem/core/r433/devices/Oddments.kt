package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Oddments: WG-PB12V1 probe, IBIS transit beacon, Opus XT300, EnOcean ERP1, CED7000 shot timer, Rosstech spa
 * control, RFM69 Moteino, TR-502MSV, Opel Mokka key, Florabest grill thermometer, Hanwell radiologger and the
 * McPower kinetic switch.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): wg_pb12v1.c, ibis_beacon.c, opus_xt300.c, enocean_erp1.c, ced7000.c,
 * rosstech_dcu706.c, rfm69_lowpowerlab.c, tr502msv.c, opel_mokka.c, florabest_fbth1.c, hanwell_ml4000.c,
 * mcpower_kinetic.c. Twin of web/src/dsp/r433/devices/oddments.ts.
 */

private val BAND_433 = listOf(433_920_000L)

/** A private copy of one row, so a decoder that inverts its input never touches the shared buffer. */
private fun copyRow(bits: BitBuffer, row: Int): BitBuffer {
    val out = BitBuffer()
    val src = bits.bb[row]
    for (i in 0 until bits.bitsPerRow[row]) out.addBit(bitAt(src, i))
    return out
}

private fun bitrowGetByte(row: UBytes, bitIdx: Int): Int {
    val at = bitIdx shr 3; val sh = bitIdx and 7
    return ((row[at] shl sh) or (if (sh != 0) row[at + 1] shr (8 - sh) else 0)) and 0xff
}

/**
 * Indistinguishable from a Fine Offset WH2 except by the type nibble. Humidity is pinned to 0xff on this probe,
 * so anything else is a misread; that test runs after the CRC, as upstream orders it.
 */
private fun wgPb12v1(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] < 48) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    if (b[0] != 0xff) return DECODE_ABORT_EARLY
    if ((b[1] and 0xf0) != 0x30) return DECODE_ABORT_EARLY
    if (b[5] != crc8(b, 4, 0x31, 0, 1)) return DECODE_FAIL_MIC
    if (b[4] != 0xff) return DECODE_FAIL_OTHER
    ctx.emit(data("model" to "WG-PB12V1", "type" to "Weather",
        "id" to (b[3] and 0x1f),                         // redrawn at every battery change: a session, not a probe
        "temperature_C" to round1(((((b[1] and 0x0f) shl 8) or b[2]) - 400) * 0.1), "mic" to "CRC"))
    return 1
}

private val IBIS_PREAMBLE = UBytes.of(0xab)

/** A bus or tram announcing itself to a stop. Only the vehicle number and a counter are understood; the rest is hex. */
private fun ibis(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 232 || bits.bitsPerRow[0] > 250) return DECODE_ABORT_LENGTH
    val pos = bits.search(0, 0, IBIS_PREAMBLE, 8)
    if (pos > 26) return DECODE_ABORT_EARLY
    val start = pos + 8
    if (bits.bitsPerRow[0] - start < 224) return DECODE_ABORT_LENGTH
    val msg = bits.bytes(0, start, 224)
    if (((msg[26] shl 8) or msg[27]) != crc16(msg, 26, 0x8005, 0x0000)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "IBIS-Beacon", "type" to "Transit", "id" to (((msg[5] and 0x0f) shl 12) or (msg[6] shl 4) or ((msg[7] and 0xf0) shr 4)),
        "counter" to u32be(msg, 20), "code" to hexBytes(msg, 28), "mic" to "CRC"))
    return 1
}

/**
 * Two upstream tests kept as written: the early abort joins its conditions with `&&`, so a bad preamble alone
 * still reaches the checksum; and a zero sum skips the check entirely. The physical bounds keep the noise out.
 */
private fun opusXt300(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var ret = 0; var failCode = 0
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] != 48) { failCode = DECODE_ABORT_LENGTH; continue }
        val b = bits.bb[row]
        if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0) { failCode = DECODE_FAIL_SANITY; continue }
        if (b[0] != 0xff && ((b[1] or 0x1) and 0xfd) == 0x55) { failCode = DECODE_ABORT_EARLY; continue }
        val chk = addBytes(b, 4, 1)
        if (chk != 0 && chk != b[5]) { failCode = DECODE_FAIL_MIC; continue }
        val temp = b[3] - 40
        val moisture = b[2]
        if (temp > 100 || moisture > 101) { failCode = DECODE_FAIL_SANITY; continue }
        ctx.emit(data("model" to "Opus-XT300", "type" to "Weather", "channel" to (b[1] and 0x03), "temperature_C" to temp, "moisture" to moisture,
            "mic" to "CHECKSUM"))
        ret++
    }
    return if (ret > 0) ret else failCode
}

private val ENOCEAN_PREAMBLE = UBytes.of(0x55, 0x20)

/**
 * Twelve air bits carry eight of telegram, two complement checks and a continuation code that ends the
 * telegram. Bits are appended before a broken pair is noticed, so damage leaves a short telegram the CRC rejects.
 */
private fun decode8of12(b: UBytes, pos: Int, end: Int, out: BitBuffer): Int {
    if (pos + 12 > end) return DECODE_ABORT_LENGTH
    out.addBit(bitAt(b, pos)); out.addBit(bitAt(b, pos + 1))
    val b2 = bitAt(b, pos + 2); out.addBit(b2)
    if (b2 != (if (bitAt(b, pos + 3) != 0) 0 else 1)) return DECODE_FAIL_SANITY
    out.addBit(bitAt(b, pos + 4)); out.addBit(bitAt(b, pos + 5))
    val b6 = bitAt(b, pos + 6); out.addBit(b6)
    if (b6 != (if (bitAt(b, pos + 7) != 0) 0 else 1)) return DECODE_FAIL_SANITY
    out.addBit(bitAt(b, pos + 8)); out.addBit(bitAt(b, pos + 9))
    return (bitAt(b, pos + 10) shl 1) or bitAt(b, pos + 11)
}

/** Building automation. The telegram is not interpreted, since the profile depends on the receiver's pairing. */
private fun enocean(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val row = copyRow(bits, 0)
    row.invert()
    val start = row.search(0, 0, ENOCEAN_PREAMBLE, 11)
    if (start >= row.bitsPerRow[0]) return DECODE_FAIL_SANITY
    var pos = start + 11
    val end = row.bitsPerRow[0]
    val out = BitBuffer()
    var more: Int
    do {
        more = decode8of12(row.bb[0], pos, end, out) and 0xff   // upstream's uint8_t turns an error into a non-1
        pos += 12
    } while (pos < end && more == 0x01)
    if (out.bitsPerRow[0] < 16) return DECODE_ABORT_LENGTH
    val nb = (out.bitsPerRow[0] - 1) shr 3
    if (crc8(out.bb[0], nb, 0x07, 0x00) != bitrowGetByte(out.bb[0], out.bitsPerRow[0] - 8)) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "EnOcean-ERP1", "type" to "Automation", "telegram" to hexBytes(out.bb[0], (out.bitsPerRow[0] + 7) shr 3), "mic" to "CRC"))
    return 1
}

private val CED7000_SYNC = UBytes.of(0xaa, 0x4d, 0x5e)
private const val CED7000_DATA_BITS = 169
private const val CED7000_TOTAL_BITS = 201

/**
 * Decimal digits, one per reflected nibble; the final and split times take their hundreds from different
 * nibbles, as upstream lays them out. The only check is where the Manchester decode stops.
 */
private fun ced7000(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 6 * 16 + 3 * 8)
    if (row < 0) return DECODE_ABORT_EARLY
    val bitpos = bits.search(row, 0, CED7000_SYNC, 24) + 24
    if (bitpos >= bits.bitsPerRow[row]) return DECODE_ABORT_EARLY
    val inv = copyRow(bits, row)
    inv.invert()
    val decoded = BitBuffer()
    val ret = inv.manchesterDecode(0, bitpos, decoded, CED7000_DATA_BITS)
    if (ret != CED7000_TOTAL_BITS + 1) return DECODE_FAIL_MIC
    val n = ret / 8
    val b = decoded.bb[0].slice(0, n)
    reflectNibbles(b, n)
    val id = (b[1] and 0xf) * 1000 + (b[1] shr 4) * 100 + (b[0] and 0xf) * 10 + (b[0] shr 4)
    val count = (b[2] and 0xf) * 10 + (b[2] shr 4)
    val final = (b[5] shr 4) * 100 + (b[4] and 0xf) * 10 + (b[4] shr 4) + (b[3] and 0xf) * 0.1 + (b[3] shr 4) * 0.01
    val split = (b[7] and 0xf) * 100 + (b[7] shr 4) * 10 + (b[6] and 0xf) + (b[6] shr 4) * 0.1 + (b[5] and 0xf) * 0.01
    ctx.emit(data("model" to "CED7000", "type" to "Timer", "id" to id.toString().padStart(4, '0'), "count" to count,
        "final" to round2(final), "split" to round2(split)))
    return 1
}

private val ROSSTECH_DATA = UBytes.of(0xdd, 0x40)
private val ROSSTECH_BOND = UBytes.of(0xcd, 0x00)

/**
 * 8o1 serial: inverted framing (start one, stop zero), an odd parity bit, and the data byte not reversed,
 * unlike both shared UART helpers.
 */
private fun extractBytesUart8o1(m: UBytes, offsetBits: Int, numBits: Int, dst: UBytes): Int {
    var ret = 0; var off = offsetBits; var n = numBits
    while (n >= 11) {
        val startb = m[off shr 3] shr (7 - (off % 8)); off += 1
        var datab = m[off shr 3]
        if (off % 8 != 0) datab = ((m[off shr 3] shl 8) or m[(off shr 3) + 1]) shr (8 - (off % 8))
        off += 8
        val parityb = m[off shr 3] shr (7 - (off % 8)); off += 1
        val stopb = m[off shr 3] shr (7 - (off % 8)); off += 1
        if ((startb and 1) != 1) break
        if ((parityb and 1) != parity8(datab and 0xff)) break
        if ((stopb and 1) != 0) break
        dst[ret++] = datab and 0xff
        n -= 11
        if (ret >= dst.size) break
    }
    return ret
}

/** Data and bond frames; each preamble is the 8o1 encoding of its own type byte, 0xba and 0x9a. */
private fun rosstech(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 55 || bits.bitsPerRow[0] > 300) return DECODE_ABORT_EARLY
    var startPos = bits.search(0, 0, ROSSTECH_DATA, 11)
    if (startPos == bits.bitsPerRow[0]) {
        startPos = bits.search(0, 0, ROSSTECH_BOND, 11)
        if (startPos == bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    }
    if (startPos + 55 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val msg = bits.bytes(0, startPos, 56)
    val b = UBytes(5)
    if (extractBytesUart8o1(msg, 0, 55, b) != 5) return DECODE_ABORT_LENGTH
    if ((0xff xor xorBytes(b, 4)) != b[4]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Rosstech-Spa", "type" to "Thermostat", "id" to hexOf((b[1] shl 8) or b[2], 4),
        "msg_type" to if (b[0] == 0xba) "Data" else "Bond", "temperature_F" to b[3], "mic" to "CHECKSUM"))
    return 1
}

private val RFM69_SYNC = UBytes.of(0x2d)
private const val RFM69_LENGTH_POS = 5
private const val RFM69_DST_ID_POS = 6
private const val RFM69_SRC_ID_POS = 7
private const val RFM69_DATA_START_POS = 9
private const val RFM69_HEADER_LENGTH = 6
private const val RFM69_MAX_LENGTH = 65

/**
 * A hobby radio module in the LowPowerLab library's framing: the payload is a sketch's own bytes, read as text.
 * Upstream reports only sender address 2 (its example gateway); mirrored. Its buffer overruns at the largest
 * length are sized away here, and its two ids go out as numbers rather than strings.
 */
private fun rfm69(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val posn = bits.search(0, 0, RFM69_SYNC, 8)
    if (posn < 24 || posn > 28) return DECODE_ABORT_EARLY
    val message = UBytes(RFM69_MAX_LENGTH + 9)
    bits.extractBytes(0, posn - 24, message, RFM69_MAX_LENGTH * 8)
    val payloadLen = message[RFM69_LENGTH_POS]
    if (payloadLen > RFM69_MAX_LENGTH) return DECODE_ABORT_LENGTH
    val payload = UBytes(RFM69_MAX_LENGTH + 2)
    bits.extractBytes(0, posn + 16, payload, (payloadLen + 1) * 8)
    val crc = crc16(payload, payloadLen + 1, 0x1021, 0x1d0f).inv() and 0xffff
    if ((crc shr 8) != message[RFM69_HEADER_LENGTH + payloadLen] || (crc and 0xff) != message[RFM69_HEADER_LENGTH + payloadLen + 1]) return DECODE_FAIL_MIC
    if (message[RFM69_SRC_ID_POS] != 0x02) return DECODE_FAIL_OTHER
    message[RFM69_HEADER_LENGTH + payloadLen] = 0x00          // terminate the text at the checksum
    val sb = StringBuilder()
    for (i in 0 until 30) { val c = message[RFM69_DATA_START_POS + i]; if (c == 0) break; sb.append(c.toChar()) }
    ctx.emit(data("model" to "Moteino-RFM69", "type" to "Telemetry", "id" to message[RFM69_DST_ID_POS], "gateway_id" to message[RFM69_SRC_ID_POS],
        "msg" to sb.toString(), "mic" to "CRC"))
    return 1
}

private val TR502_COMMANDS = listOf("OFF", "BRIGHT", "ON", "DIM")
private val TR502_SOCKETS = listOf("1", "3", "2", "4", "ALL")

/** Socket bits are sent LSB first, hence 1, 3, 2, 4; only even codes and 111 exist, so an odd code is a misread. */
private fun tr502msv(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] != 21) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    if ((b[0] and 0x80) == 0) return DECODE_ABORT_EARLY
    if ((b[2] and 0x20) != 0) return DECODE_FAIL_SANITY
    val deviceId = ((b[0] and 0x7f) shl 5) or (b[1] shr 3)
    val socketId = b[1] and 0x07
    val onOff = (b[2] and 0x80) shr 7
    val command = (b[2] and 0x40) shr 6
    val s2 = (socketId shr 2) and 1; val s1 = (socketId shr 1) and 1; val s0 = socketId and 1
    if (((b[2] and 0x10) shr 4) != (command xor s2 xor s0) || ((b[2] and 0x08) shr 3) != (onOff xor s1)) return DECODE_FAIL_MIC
    val socket = if (socketId % 2 == 0) TR502_SOCKETS[socketId shr 1] else if (socketId == 0x7) TR502_SOCKETS[4] else return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "TR-502MSV", "type" to "Remote", "id" to deviceId, "socket_id" to socket,
        "command" to TR502_COMMANDS[(onOff shl 1) or command], "mic" to "CHECKSUM"))
    return 1
}

/**
 * The payload sent twice is the only check, and it is not decrypted. Upstream reads it one bit late against its own
 * layout (dropping the first payload bit, taking the end bit); reproduced so both report the same string.
 */
private fun opelMokka(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var found = 0
    for (i in 0 until bits.numRows) {
        if (bits.bitsPerRow[i] != 268) continue
        val b = bits.bb[i]
        var leadIn = 0
        for (k in 0..10) leadIn = leadIn or b[k]
        if (leadIn != 0) continue
        fun idAt(at: Int): Int { val t = bits.bytes(i, at, 11); return (t[0] shl 3) or (t[1] shr 5) }
        val keyId = idAt(90)
        if (keyId != idAt(90 + 12 * 8 + 1)) continue
        if (keyId == 0) continue
        ctx.emit(data("model" to "Opel-Mokka", "type" to "Remote", "id" to keyId, "event" to (((b[12] and 0x07) shl 2) or ((b[13] and 0xc0) shr 6)),
            "code" to hexBytes(bits.bytes(i, 90 + 17, 64), 8)))
        found++
    }
    return found
}

/**
 * One parity bit over thirty, with three matching rows doing as much work. Upstream's all-zero guard sits after
 * the 0x49 test and can never fire; kept so the files read the same.
 */
private fun florabest(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(3, 30)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 30) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[0] != 0x49) return DECODE_FAIL_SANITY
    if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0) return DECODE_ABORT_EARLY
    var parity = 0
    for (i in 0 until 30) parity = parity xor bitAt(b, i)
    if (parity != 1) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Florabest-FBTH1", "type" to "Weather", "id" to hexOf((b[0] shl 8) or b[1], 4),
        "temperature_F" to round1(((b[2] shl 5) or (b[3] shr 3)) * 0.1 - 90.0), "mic" to "PARITY"))
    return 1
}

/** Raw counts only: the conversion lives in the base station, calibrated per transmitter. */
private fun hanwell(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 1) return DECODE_ABORT_EARLY
    val row = bits.numRows - 1
    if (bits.bitsPerRow[row] != 40) return DECODE_ABORT_LENGTH
    val b = bits.bytes(row, 0, 40)
    for (i in 0 until 5) b[i] = reverse8(b[i] xor 0xff)
    if (addBytes(b, 4) != b[4]) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "Hanwell-ML4000", "type" to "Weather", "id" to b[0], "temperature_raw" to ((b[2] shl 4) or (b[3] and 0x0f)),
        "humidity_raw" to ((b[1] shl 4) or (b[3] shr 4)), "mic" to "CHECKSUM"))
    return 1
}

private val MCPOWER_PREAMBLE = UBytes.of(0xaa, 0xaa)

/** Powered by the press, so the frame repeats while the energy lasts, and a late repeat may have no button set. */
private fun mcpower(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    var pos = bits.search(0, 0, MCPOWER_PREAMBLE, 16)
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    pos += 16
    if (bits.bitsPerRow[0] - pos < 48) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, pos, 48)
    if (crc16(b, 4, 0x1021, 0xaa55) != ((b[4] shl 8) or b[5])) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "McPower-Kinetic", "type" to "Remote", "id" to hexOf((b[0] shl 8) or b[1], 4), "button_left" to ((b[2] shr 6) and 1),
        "button_right" to ((b[2] shr 5) and 1), "counter" to (b[2] and 0xf), "flags" to hexOf(b[3]), "mic" to "CRC"))
    return 1
}

internal val ODDMENTS: List<RDevice> = listOf(
    dev(39, "WG-PB12V1 Temperature Sensor", Mod.OOK_PWM, 564, 1476, 2500, bands = BAND_433, what = "temperature probe", decode = ::wgPb12v1),
    dev(80, "IBIS beacon", Mod.OOK_MANCHESTER_ZEROBIT, 30, 0, 100, what = "public transport vehicle beacon", decode = ::ibis),
    dev(121, "Opus/Imagintronix XT300 Soil Moisture", Mod.OOK_PWM, 544, 932, 31000, gapLimit = 10000, bands = BAND_433,
        what = "soil moisture and temperature probe", decode = ::opusXt300),
    dev(198, "EnOcean ERP1", Mod.OOK_PCM, 8, 8, 800, tolerance = 1, disabled = true, bands = listOf(868_300_000L),
        what = "building automation telegram", decode = ::enocean),
    dev(233, "CED7000 Shot Timer", Mod.FSK_PCM, 1300, 1300, 9000, gapLimit = 3500, disabled = true, what = "shooting timer", decode = ::ced7000),
    dev(265, "Rosstech Digital Control Unit DCU-706/Sundance/Jacuzzi", Mod.OOK_PCM, 200, 200, 2000, what = "hot tub control panel", decode = ::rosstech),
    dev(318, "RFM69 LowPowerLab Moteino board (-s 1000k)", Mod.FSK_PCM, 18, 18, 400, what = "hobby radio module", decode = ::rfm69),
    dev(332, "TR-502MSV remote smart socket controller", Mod.OOK_PWM, 740, 1400, 84000, tolerance = 70, bands = BAND_433,
        what = "mains socket remote", decode = ::tr502msv),
    dev(333, "Opel Mokka Car Key", Mod.FSK_MANCHESTER_ZEROBIT, 100, 100, 1000, what = "car key fob", decode = ::opelMokka),
    dev(339, "Florabest FB-TH-1 BBQ Thermometer", Mod.OOK_PPM, 2000, 4000, 11000, gapLimit = 6000, bands = BAND_433, what = "grill thermometer", decode = ::florabest),
    dev(371, "Hanwell ML/RL4000-series Radiologger temperature/humidity sensor", Mod.FSK_PWM, 1000, 2000, 10000, syncWidth = 3000, disabled = true,
        bands = listOf(434_075_000L), what = "laboratory temperature and humidity logger", decode = ::hanwell),
    dev(376, "McPower Kinetic battery-less wall switch", Mod.FSK_PCM, 10, 10, 300, bands = BAND_433, what = "kinetic wall switch", decode = ::mcpower),
)
