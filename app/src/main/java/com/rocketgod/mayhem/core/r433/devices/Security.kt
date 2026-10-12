package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Alarm systems: door and window contacts, motion detectors, smoke alarms and their panels. A contact sensor
 * announces every door opening in clear with a fixed serial, so anyone in range sees the shape of a building's
 * activity. The CRCs here are for interference, not eavesdropping.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): honeywell.c, interlogix.c, dsc.c, x10_rf.c, chuango.c,
 * smoke_gs558.c. Twin of web/src/dsp/r433/devices/security.ts.
 */

/** Two generations share the air, so the CRC polynomial depends on the channel. */
private fun honeywell(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 120) return DECODE_ABORT_LENGTH
    val rawLen = bits.bitsPerRow[0]
    val preamble = UBytes.of(0x55, 0x55, 0x56)
    var pos = 0
    var found: UBytes? = null
    var channel = 0; var deviceId = 0
    while (true) {
        pos = bits.search(0, pos, preamble, 24)
        if (pos + 24 >= rawLen) break
        val decoded = BitBuffer()
        bits.manchesterDecode(0, pos + 24, decoded, 96)
        pos += 1                                       // the sync can land a bit either way; try both
        if (decoded.bitsPerRow[0] < 48) continue
        val b = decoded.bb[0]
        channel = b[0] shr 4
        deviceId = ((b[0] and 0x0f) shl 16) or (b[1] shl 8) or b[2]
        val crc = (b[4] shl 8) or b[5]
        if (deviceId == 0 && crc == 0) continue
        val poly = if (channel == 0x2 || channel == 0x4 || channel == 0x9 || channel == 0xa || channel == 0xc) 0x8050 else 0x8005
        if (crc == crc16(b, 4, poly, 0)) { found = b; break }
    }
    val f = found ?: return DECODE_FAIL_MIC
    val event = f[3]
    val contact = (event and 0x80) shr 7
    ctx.emit(data("model" to "Honeywell-Security", "id" to deviceId, "channel" to channel, "event" to event,
        "state" to if (contact != 0) "open" else "closed", "contact_open" to contact, "reed_open" to ((event and 0x20) shr 5),
        "alarm" to ((event and 0x10) shr 4), "tamper" to ((event and 0x40) shr 6),
        "battery_ok" to if (((event and 0x08) shr 3) != 0) 0 else 1, "heartbeat" to ((event and 0x04) shr 2), "mic" to "CRC"))
    return 1
}

private val INTERLOGIX_TYPES = mapOf(0xa to "contact", 0xf to "keyfob", 0x4 to "motion", 0x6 to "heat",
    0x9 to "glass", 0xd to "glass", 0xe to "freeze", 0x2 to "smoke", 0x3 to "panic")

/** Five switch states per frame; a keyfob codes its button into the same bits, so it is read differently. */
private fun interlogix(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] < 57 || bits.bitsPerRow[0] > 64) return DECODE_ABORT_LENGTH
    var at = bits.search(0, 0, UBytes.of(0x01), 8)
    if (at == bits.bitsPerRow[0]) return DECODE_FAIL_SANITY
    at += 8
    val m = bits.bytes(0, at, 46)
    if ((m[0] == 0x00 && m[1] == 0x00 && m[2] == 0x00) || (m[0] == 0xff && m[1] == 0xff && m[2] == 0xff)
        || (m[3] == 0x00 && m[4] == 0x00 && m[5] == 0x00) || (m[3] == 0xff && m[4] == 0xff && m[5] == 0xff)) return DECODE_FAIL_SANITY
    var parity = m[0] xor m[1] xor m[2] xor m[3] xor m[4]
    parity = (parity shr 4) xor (parity and 0x0f)
    parity = (parity shr 2) xor (parity and 0x03)
    parity = parity xor (m[5] shr 6)
    if ((parity xor 0x3) != 0) return DECODE_FAIL_MIC
    val typeNibble = reverse8(m[2]) shr 4
    val deviceType = INTERLOGIX_TYPES[typeNibble] ?: return DECODE_FAIL_SANITY
    val lowBattery: Int
    val sw: List<String>
    if (typeNibble == 0xf) {
        lowBattery = 0
        val k = m[3] and 0x0e
        sw = listOf(0x4, 0x8, 0xc, 0x2, 0xa).map { if (k == it) "CLOSED" else "OPEN" }
    } else {
        lowBattery = if ((m[3] and 0x10) != 0) 1 else 0
        fun s(v: Int) = if (v != 0) "OPEN" else "CLOSED"
        sw = listOf(s(m[3] and 0x04), s(m[3] and 0x01), s(m[4] and 0x40), s(m[4] and 0x10), s(m[4] and 0x04))
    }
    ctx.emit(data("model" to "Interlogix-Security", "subtype" to deviceType,
        "id" to hexOf(reverse8(m[2])) + hexOf(reverse8(m[1])) + hexOf(reverse8(m[0])), "battery_ok" to if (lowBattery != 0) 0 else 1,
        "switch1" to sw[0], "switch2" to sw[1], "switch3" to sw[2], "switch4" to sw[3], "switch5" to sw[4],
        "raw_message" to hexOf(m[3]) + hexOf(m[4]) + hexOf(m[5])))
    return 1
}

/** A start bit sits before every data byte, so the payload is unpacked from across byte boundaries first. */
private fun dsc(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var valid = 0
    var result = 0
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] < 48 || bits.bitsPerRow[row] > 70) { result = DECODE_ABORT_EARLY; continue }
        val b = bits.bb[row]
        if (!((b[0] and 0xf0) != 0 && (b[1] and 0x08) != 0 && (b[2] and 0x04) != 0 && (b[3] and 0x02) != 0 && (b[4] and 0x01) != 0)) {
            result = DECODE_ABORT_EARLY; continue
        }
        val bytes = UBytes.of(
            ((b[0] and 0x0f) shl 4) or ((b[1] and 0xf0) shr 4),
            ((b[1] and 0x07) shl 5) or ((b[2] and 0xf8) shr 3),
            ((b[2] and 0x03) shl 6) or ((b[3] and 0xfc) shr 2),
            ((b[3] and 0x01) shl 7) or ((b[4] and 0xfe) shr 1),
            b[5])
        if (bytes[0] == 0xff && bytes[1] == 0xff && bytes[2] == 0xff && bytes[3] == 0xff) { result = DECODE_FAIL_SANITY; continue }
        if (crc8le(bytes, 5, 0xf5, 0x3d) != 0) { result = DECODE_FAIL_MIC; continue }
        val status = bytes[0]
        val esn = (bytes[1] shl 16) or (bytes[2] shl 8) or bytes[3]
        fun f(c: Boolean) = if (c) 1 else 0
        ctx.emit(data("model" to "DSC-Security", "id" to esn, "closed" to f((status and 0x02) == 0x02),
            "event" to f((status and 0x40) != 0x40), "tamper" to f((status and 0x01) != 0x01 || (status and 0x10) == 0x10),
            "battery_ok" to f((status and 0x08) != 0x08), "xactivity" to f((status and 0x20) == 0x20),
            "xtamper1" to f((status and 0x01) != 0x01), "xtamper2" to f((status and 0x10) == 0x10),
            "exception" to f((status and 0x80) != 0x80 || (status and 0x04) == 0x04),
            "esn" to hexOf(esn, 6), "status" to status, "status_hex" to hexOf(status, 2), "mic" to "CRC"))
        valid++
    }
    return if (valid != 0) 1 else result
}

/** No checksum: each byte is followed by its complement, and the house letter is a small scrambling of four bits. */
private fun x10(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val b = bits.bb[1]
    if (bits.bitsPerRow[1] != 32) return DECODE_ABORT_LENGTH
    if ((b[0] xor b[1]) != 0xff || (b[2] xor b[3]) != 0xff) return DECODE_FAIL_SANITY
    val mask = intArrayOf(0x0b, 0x0b, 0x07, 0x07); val value = intArrayOf(0x00, 0x0b, 0x00, 0x07)
    for (i in 0 until 4) if ((mask[i] and b[i]) != value[i]) return DECODE_FAIL_SANITY
    val h0 = (b[0] and 0x80) shr 7; val h1 = (b[0] and 0x40) shr 6; val h2 = (b[0] and 0x20) shr 5; val h3 = (b[0] and 0x10) shr 4
    val house = (((h0 xor h1).inv() and 1) shl 3) or ((h1.inv() and 1) shl 2) or (((h1 xor h2) and 1) shl 1) or (h3 and 1)
    var unit = (((b[0] and 0x04) shl 1) or ((b[2] and 0x40) shr 4) or ((b[2] and 0x08) shr 2) or ((b[2] and 0x10) shr 4)) + 1
    val event: String
    if ((b[2] and 0x80) == 0x80) {
        unit = 0
        event = when (b[2]) { 0x98 -> "DIM"; 0x88 -> "BRI"; 0x90 -> "ALL LTS ON"; 0x80 -> "ALL OFF"; else -> "UNKNOWN" }
    } else {
        event = if ((b[2] and 0x20) == 0x00) "ON" else "OFF"
    }
    ctx.emit(data("model" to "X10-RF", "id" to unit, "channel" to (house + 65).toChar().toString(), "state" to event,
        "data" to hexOf((b[0] shl 24) or (b[1] shl 16) or (b[2] shl 8) or b[3], 8), "mic" to "PARITY"))
    return 1
}

private val CHUANGO_CMDS = mapOf(0xd to "Low Battery", 0xc to "Closing", 0xb to "24H Zone", 0xa to "Single Delay Zone",
    0x8 to "Arm", 0x7 to "Normal Zone", 0x6 to "Home Mode Zone", 0x5 to "On", 0x4 to "Home Mode", 0x3 to "Tamper",
    0x2 to "Alarm", 0x1 to "Disarm", 0x0 to "Test")

private fun chuango(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 25) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    for (i in 0 until 3) b[i] = b[i].inv()
    if ((b[3] and 0x80) == 0 || (b[0] == 0 && b[1] == 0 && (b[2] and 0xf0) == 0)) return DECODE_ABORT_EARLY
    val cmd = b[2] and 0x0f
    ctx.emit(data("model" to "Chuango-Security", "id" to ((b[0] shl 12) or (b[1] shl 4) or (b[2] shr 4)),
        "cmd" to (CHUANGO_CMDS[cmd] ?: "?"), "cmd_id" to cmd))
    return 1
}

/** A run of 0x55 is the pairing burst, not a reading. */
private fun smokeGs558(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 3) return DECODE_ABORT_EARLY
    bits.invert()
    var learn = 0
    for (r in 0 until bits.numRows) {
        val b = bits.bb[r]
        if (bits.bitsPerRow[r] >= 24 && b[0] == 0x55 && b[1] == 0x55 && b[2] == 0x55) { learn++; bits.bitsPerRow[r] = 0 }
        if ((bits.bitsPerRow[r] == 26 || bits.bitsPerRow[r] == 27) && b[3] == 0) bits.bitsPerRow[r] = 24
    }
    val r = bits.findRepeatedRow(3, 24)
    if (r < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[r] > 32) return DECODE_ABORT_LENGTH
    val b = bits.bb[r]
    for (i in 0 until 3) b[i] = reverse8(b[i])
    val id = ((b[2] and 0x0f) shl 11) or (b[1] shl 3) or (b[0] shr 5)
    if (id == 0 || id == 0x7fff) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Smoke-GS558", "id" to id, "unit" to (b[0] and 0x1f), "learn" to if (learn > 1) 1 else 0,
        "code" to hexOf(b[2]) + hexOf(b[1]) + hexOf(b[0])))
    return 1
}

private val DSC_BANDS = listOf(433_920_000L, 315_000_000L)

internal val SECURITY: List<RDevice> = listOf(
    dev(70, "Honeywell door/window sensor, 2Gig DW10/DW11, RE208 repeater", Mod.OOK_PCM, 136, 136, 408, bands = listOf(345_000_000L),
        what = "alarm door and window contacts", decode = ::honeywell),
    dev(100, "Interlogix GE UTC security devices", Mod.OOK_PPM, 122, 244, 500, bands = listOf(319_500_000L),
        what = "alarm contacts, motion, glass-break, smoke and keyfobs", decode = ::interlogix),
    dev(23, "DSC security contact", Mod.OOK_PCM, 250, 500, 5000, bands = DSC_BANDS, what = "alarm door and window contacts", decode = ::dsc),
    dev(148, "DSC security contact (WS4945)", Mod.OOK_PCM, 536, 1072, 9000, bands = DSC_BANDS,
        what = "alarm contacts: EV-DW4927, WS4975, WS4945", decode = ::dsc),
    dev(22, "X10 RF", Mod.OOK_PPM, 562, 1687, 6000, gapLimit = 2200, bands = listOf(310_000_000L, 433_920_000L),
        what = "home automation remotes and switches", decode = ::x10),
    dev(29, "Chuango security technology", Mod.OOK_PWM, 568, 1704, 1800, tolerance = 160, disabled = true, bands = listOf(433_920_000L),
        what = "alarm sensors and remotes", decode = ::chuango),
    dev(86, "Wireless smoke and heat detector GS 558", Mod.OOK_PWM, 436, 1202, 14117, gapLimit = 1949, disabled = true,
        bands = listOf(433_920_000L), what = "smoke and heat alarm", decode = ::smokeGs558),
)
