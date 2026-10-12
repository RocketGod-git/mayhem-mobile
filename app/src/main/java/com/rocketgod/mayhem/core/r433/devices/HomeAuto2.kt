package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.max
import kotlin.math.min

/*
 * Insteon, the Honeywell CM921 (Evohome family) and Delta Dore X3D.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): insteon.c, honeywell_cm921.c, deltadore_x3d.c. Twin of
 * web/src/dsp/r433/devices/homeauto2.ts.
 */

private val BAND_868 = listOf(868_000_000L)
private val BAND_868_95 = listOf(868_950_000L)
private val BAND_915 = listOf(915_000_000L)

private fun bitrowGetByte(row: UBytes, pos: Int) = (((row[pos shr 3] shl 8) or row[(pos shr 3) + 1]) shr (8 - (pos and 7))) and 0xff

/**
 * CCITT whitening as the SX1211 applies it: the IBM shift register, but each byte xored with the key byte
 * reflected, so the keystreams differ from the second byte on. Its own inverse.
 */
private fun ccittWhitening(m: UBytes, n: Int) {
    var msb = 0x01; var lsb = 0xff
    for (i in 0 until n) {
        m[i] = m[i] xor reverse8(lsb)
        for (r in 0 until 8) {
            val prev = msb
            msb = (lsb and 0x01) xor ((lsb shr 5) and 0x01)
            lsb = (((prev shl 7) and 0x80) or ((lsb shr 1) and 0xff)) and 0xff
        }
    }
}

private val INSTEON_MSG_TYPE = listOf("Direct Message", "ACK of Direct Message", "Group Cleanup Direct Message",
    "ACK of Group Cleanup Direct Message", "Broadcast Message", "NAK of Direct Message", "Group Broadcast Message",
    "NAK of Group Cleanup Direct Message")

/** The ordinary packet's check: an xor with a nibble stir folded in after every byte. */
private fun insteonCrc(d: UBytes): Int {
    var r = 0
    for (i in 0 until 9) { r = r xor d[i]; r = (r xor ((((r xor ((r shl 1) and 0xff)) and 0x0f) shl 4))) and 0xff }
    return r
}

/** The extended packet's check is a different shape: negate the body's sum and add one. */
private fun insteonExtCrc(d: UBytes): Int {
    var r = 0
    for (i in 7 until 22) r = (r + d[i]) and 0xff
    return (r.inv() + 1) and 0xff
}

/** Blocks of an index and a byte, the index counting down from 31 (the prose says 32, the code 31). */
private fun insteonPacket(bits: BitBuffer, row: Int, startPos: Int, ctx: DecodeCtx): Int {
    val results = UBytes(35)
    var resultsLen = 0
    var pos = startPos + 7
    val idxBuf = BitBuffer(); val datBuf = BitBuffer()
    var next = bits.manchesterDecode(row, pos, idxBuf, 5)
    val firstIndex = reverse8(idxBuf.bb[0][0])
    next = bits.manchesterDecode(row, next, datBuf, 8)
    results[resultsLen++] = reverse8(datBuf.bb[0][0])
    if (firstIndex != 31) return DECODE_ABORT_EARLY
    // Two marker bits sit between blocks.
    if (bits.bytes(row, startPos + 7 + 26, 2)[0] != 0xc0) return DECODE_FAIL_SANITY
    val extended = (results[0] and 0x10) != 0
    val maxLen = if (extended) 32 else 13
    val minLen = if (extended) 23 else 10
    var prevIndex = 33
    for (j in 1 until maxLen) {
        pos += 28
        idxBuf.clear(); datBuf.clear()
        next = bits.manchesterDecode(row, pos, idxBuf, 5)
        next = bits.manchesterDecode(row, next, datBuf, 8)
        if (next - pos != 26) break
        val index = reverse8(idxBuf.bb[0][0])
        results[resultsLen++] = reverse8(datBuf.bb[0][0])
        if (index < prevIndex) prevIndex = index else return DECODE_ABORT_EARLY
    }
    if (resultsLen < minLen) return 0
    val want = if (extended) insteonExtCrc(results) else insteonCrc(results)
    if (results[minLen - 1] != want) return DECODE_FAIL_MIC
    val msgType = (results[0] shr 5) and 0x07
    ctx.emit(data("model" to "Insteon", "type" to "Remote", "from_id" to hexBytes(UBytes.of(results[6], results[5], results[4])).uppercase(),
        "to_id" to hexBytes(UBytes.of(results[3], results[2], results[1])).uppercase(), "msg_type" to msgType,
        "msg_str" to INSTEON_MSG_TYPE[msgType], "extended" to if (extended) 1 else 0, "hopsmax" to (results[0] and 0x03),
        "hopsleft" to ((results[0] shr 2) and 0x03), "payload" to hexBytes(results, resultsLen).uppercase(),
        "cmd_dat" to (7 until minLen - 1).map { results[it] }, "mic" to "CRC"))
    return 1
}

private val INSTEON_PREAMBLE = UBytes.of(0xce, 0xaa)

private fun insteon(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    // Upstream adds sizeof the run-in array, two: its byte count, not its sixteen bits.
    val minBits = 10 * 28 + 2
    var events = 0; var failure = 0
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] < minBits) { failure = DECODE_ABORT_LENGTH; continue }
        var bitIndex = 0
        while (bits.bitsPerRow[row] - bitIndex >= minBits) {
            val at = bits.search(row, bitIndex, INSTEON_PREAMBLE, 16)
            if (at >= bits.bitsPerRow[row]) break
            val ret = insteonPacket(bits, row, at, ctx)
            if (ret > 0) { events += ret; bitIndex = at + minBits } else { if (ret < 0) failure = ret; bitIndex = at + 16 }
        }
    }
    return if (events > 0) 1 else failure
}

/** How many device addresses a header announces; anything unlisted is upstream's own guess. */
private fun cm921DeviceCount(header: Int) = when (header) {
    0x14 -> 1
    0x18, 0x1c, 0x10, 0x3c -> 2
    else -> (header shr 2) and 0x03
}

private val CM921_PREAMBLE = UBytes.of(0x55, 0x5f, 0xf0, 0x04)

/**
 * Three layers: UART framing, then Manchester, then a message bracketed by a fixed header and a footer of
 * filler found by walking back from the end. Every decoded byte sums to zero.
 */
private fun cm921(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 60) return DECODE_ABORT_LENGTH
    val row = bits.bb[0]
    val start = bits.search(0, 0, CM921_PREAMBLE, 30) + 30
    val avail = bits.bitsPerRow[0] - start
    if (avail < 8) return DECODE_ABORT_LENGTH
    val end = start + avail
    // Strip start and stop bits, each byte least significant bit first.
    val bytes = BitBuffer()
    var pos = start
    while (pos < end) {
        if (pos + 10 > end) break
        if (bitAt(row, pos) != 0) break
        if (bitAt(row, pos + 9) != 1) break
        val byte = bitrowGetByte(row, pos + 1)
        for (i in 0 until 8) bytes.addBit((byte shr i) and 1)
        pos += 10
    }
    if (bytes.bitsPerRow[0] < 32) return DECODE_FAIL_SANITY
    val inner = bytes.bb[0]
    if (bitrowGetByte(inner, 0) != 0x33 || bitrowGetByte(inner, 8) != 0x55 || bitrowGetByte(inner, 16) != 0x53) return DECODE_FAIL_SANITY
    var fi = bytes.bitsPerRow[0] - 8
    var sawFiller = false
    while (fi >= 24 && bitrowGetByte(inner, fi) == 0x55) { sawFiller = true; fi -= 8 }
    if (!sawFiller || fi < 24 || bitrowGetByte(inner, fi) != 0x35) return DECODE_FAIL_SANITY
    val first = 24
    val numBits = fi - first
    val packet = BitBuffer()
    val fpos = bytes.manchesterDecode(0, first, packet, numBits)
    // A clean decode overshoots by exactly one violating pair.
    if (numBits - (fpos - first - 2) != 0) return DECODE_FAIL_SANITY
    val numBytes = packet.bitsPerRow[0] shr 3
    if (numBytes < 1) return DECODE_ABORT_LENGTH
    val msg = packet.bb[0]
    if ((addBytes(msg, numBytes) and 0xff) != 0) return DECODE_FAIL_MIC
    // Upstream's reader returns a sentinel once it steps past the end, so the last byte in range reads 0xfc; kept.
    var ipos = 0
    fun nextByte(): Int { val v = bitrowGetByte(msg, ipos); ipos += 8; return if (ipos >= numBytes * 8) 0xfc else v }
    val header = nextByte()
    val ids = ArrayList<String>()
    repeat(cm921DeviceCount(header)) { val a = nextByte(); val b = nextByte(); val c = nextByte(); ids.add(hexBytes(UBytes.of(a, b, c))) }
    val command = (nextByte() shl 8) or nextByte()
    val payloadLength = nextByte()
    val payload = IntArray(min(payloadLength, 256)) { nextByte() }
    val out = data("model" to "Honeywell-CM921", "type" to "Thermostat", "ids" to ids.joinToString(" "), "mic" to "CHECKSUM")
    fun p(i: Int) = payload.getOrElse(i) { 0 }
    fun pad(n: Int, w: Int = 2) = n.toString().padStart(w, '0')
    when (command) {
        0x1030 -> if (payloadLength != 16) out["unknown"] = command else {
            out["zone_idx"] = p(0)
            for (i in 0 until 5) {
                val value = p(3 + 3 * i)
                when (p(1 + 3 * i)) { 0xc8 -> out["max_flow_temp"] = value; 0xc9 -> out["pump_run_time"] = value
                    0xca -> out["actuator_run_time"] = value; 0xcb -> out["min_flow_temp"] = value }
            }
        }
        0x313f -> when (payloadLength) {
            1 -> out["time_request"] = p(0)
            9 -> out["datetime"] = "${pad(p(4) and 0x1f)}:${pad(p(3))}:${pad(p(2))} ${pad(p(5))}-${pad(p(6))}-${pad((p(7) shl 8) or p(8), 4)}"
            else -> out["unknown"] = command
        }
        0x0008 -> if (payloadLength != 2) out["unknown"] = command else { out["domain_id"] = p(0); out["demand"] = p(1) / 200.0 }
        0x3ef0 -> when (payloadLength) {
            3 -> out["status"] = p(1) / 200.0
            6 -> { out["boiler_modulation_level"] = p(1) / 200.0; out["flame_status"] = p(3) }
            else -> out["unknown"] = command
        }
        0x2309 -> if (payloadLength != 3) out["unknown"] = command else { out["zone"] = p(0); out["setpoint"] = ((p(1) shl 8) or p(2)) / 100.0 }
        0x1100 -> if (payloadLength != 5 && payloadLength != 8) out["unknown"] = command else {
            out["domain_id"] = p(0); out["cycle_rate"] = p(1) / 4.0; out["minimum_on_time"] = p(2) / 4.0; out["minimum_off_time"] = p(3) / 4.0
            if (payloadLength == 8) out["proportional_band_width"] = ((p(5) shl 8) or p(6)) / 100.0
        }
        0x0009 -> if (payloadLength != 3) out["unknown"] = command else {
            out["device_number"] = p(0); out["failsafe_mode"] = when (p(1)) { 0 -> "off"; 1 -> "20-80"; else -> "unknown" }
        }
        0x3b00 -> if (payloadLength != 2) out["unknown"] = command else { out["domain_id"] = p(0); out["state"] = p(1) / 200.0 }
        0x30c9 -> for (i in 0 until payloadLength / 3) out["temperature (zone ${p(3 * i)})"] = signed((p(3 * i + 1) shl 8) or p(3 * i + 2), 16) / 100.0
        0x1fd4 -> out["ticker"] = (p(1) shl 8) or p(2)
        0x3150 -> { out["zone"] = p(0); out["heat_demand"] = p(1) }
        else -> out["unknown"] = command
    }
    ctx.emit(out)
    return 1
}

private val X3D_CLASS = listOf("Sensor", "Standard", "Pairing", "Beacon")
private val X3D_PREAMBLE = UBytes.of(0xaa, 0xaa, 0x81, 0x69, 0x96, 0x7e)

/**
 * Whitened throughout, length byte included, so the length is recovered on its own first. One flag byte moves
 * everything after it; trailing rubbish from a longer message is common, so the CRC position bounds the payload.
 */
private fun x3d(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    var start = bits.search(0, 0, X3D_PREAMBLE, 48)
    if (start >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    start += 48
    if (bits.bitsPerRow[0] < 10 * 8) return DECODE_ABORT_LENGTH
    val lenByte = bits.bytes(0, start, 8)
    ccittWhitening(lenByte, 1)
    val len = lenByte[0]
    if (len < 2 || len > 64) return DECODE_ABORT_LENGTH
    val frame = UBytes(65)
    frame.setAll(bits.bytes(0, start, len * 8).sub(0, len))
    ccittWhitening(frame, len)
    if (crc16(frame, len - 2, 0x1021, 0x0000) != ((frame[len - 2] shl 8) or frame[len - 1])) return DECODE_FAIL_MIC
    var at = 2                                           // past the length and a fixed 0xff
    val number = frame[at++]
    val msgType = frame[at++]
    val headerLen = frame[at] and 0x1f
    val headerFlags = frame[at++] and 0xe0
    val deviceId = frame[at] or (frame[at + 1] shl 8) or (frame[at + 2] shl 16)
    at += 3
    val network = frame[at++]
    at++                                                 // an unidentified flag byte
    val flags2 = frame[at++]
    val flags3 = frame[at++]
    var hasTemp = false; var tempType = 0; var temperature = 0
    if (flags3 == 0x01) at++
    else if (flags3 == 0x08) {
        hasTemp = true
        tempType = frame[at++]
        temperature = signed(frame[at] or (frame[at + 1] shl 8), 16)
        at += 2
    }
    val messageId = frame[at] or (frame[at + 1] shl 8)
    at += 4                                              // message id, then a two-byte header check
    val noPayload = (headerFlags and 0x20) != 0
    if (msgType == 0x01 && !noPayload && len < at + 12 + 2) return DECODE_ABORT_LENGTH
    val out = data("model" to "DeltaDore-X3D", "type" to "Thermostat", "id" to deviceId, "network" to network,
        "subtype" to (X3D_CLASS.getOrNull(msgType) ?: "Unknown"), "msg_id" to messageId, "msg_no" to number, "header_len" to headerLen, "mic" to "CRC")
    if (hasTemp) {
        out["temperature_C"] = temperature / 100.0
        out["temperature_type"] = when (tempType) { 0x00 -> "indoor"; 0x01 -> "outdoor"; else -> "" }
    }
    if (noPayload) {
        // A window sensor says only what changed, and nothing at all when nothing did.
        if (flags2 == 0x01) out["wnd_stat"] = "Closed" else if (flags2 == 0x41) out["wnd_stat"] = "Opened"
    } else if (msgType == 0x01) {
        fun le16(): Int { val v = frame[at] or (frame[at + 1] shl 8); at += 2; return v }
        out["retry"] = frame[at++]
        out["transfer"] = le16()
        out["transfer_ack"] = le16()
        out["target"] = le16()
        out["action"] = frame[at++]
        out["register_high"] = frame[at++]
        out["register_low"] = frame[at++]
        out["target_ack"] = le16()
        // Upstream's register meanings are a partial table it calls work in progress, so the rest stays hex.
        out["raw_msg"] = hexBytes(frame, max(0, len - at - 2), at)
    }
    ctx.emit(out)
    return 1
}

internal val HOMEAUTO2: List<RDevice> = listOf(
    dev(159, "Insteon", Mod.FSK_PCM, 110, 110, 1000, gapLimit = 500, tolerance = 15, bands = BAND_915, what = "home automation switch and sensor", decode = ::insteon),
    dev(185, "Honeywell CM921 Wireless Programmable Room Thermostat", Mod.FSK_PCM, 26, 26, 2000, tolerance = 5, bands = BAND_868,
        what = "heating controller", decode = ::cm921),
    dev(269, "DeltaDore X3D devices", Mod.FSK_PCM, 25, 25, 800, bands = BAND_868_95, what = "heating and shutter controller", decode = ::x3d),
)
