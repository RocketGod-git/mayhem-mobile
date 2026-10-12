package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.max
import kotlin.math.min

/*
 * Wireless M-Bus (EN 13757-4) in modes C, T, S, R and F, and the RADIAN meter that wraps a wired M-Bus
 * telegram. Headers are decoded and the payload reported as hex; records are not interpreted, and an encrypted
 * payload is flagged as such.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): m_bus.c, radian.c. Twin of web/src/dsp/r433/devices/mbus.ts.
 */

private const val BLOCK1A_SIZE = 12
private const val BLOCK1B_SIZE = 10
private const val BLOCK2B_SIZE = 118
private const val BUF_SIZE = 512

private fun hex2(v: Int) = hexUp(v and 0xff, 2)
private fun hex4(v: Int) = hexUp(v and 0xffff, 4)
private fun hexN(m: UBytes, n: Int) = hexBytes(m, min(n, m.size))
/** Serial numbers travel as BCD, two digits to the byte. */
private fun bcd2int(b: Int) = (b shr 4) * 10 + (b and 0x0f)

/** A byte that need not be byte-aligned. */
private fun byteAt(m: UBytes, off: Int): Int {
    val i = off shr 3; val s = off and 7
    if (s == 0) return m[i]
    return (((m[i] shl 8) or m[i + 1]) shr (8 - s)) and 0xff
}

/** Three letters packed five bits each, offset from '@'. */
private fun manufDecode(f: Int) = String(charArrayOf((((f shr 10) and 0x1f) + 0x40).toChar(), (((f shr 5) and 0x1f) + 0x40).toChar(), ((f and 0x1f) + 0x40).toChar()))

private fun deviceTypeStr(t: Int): String = when (t) {
    0x00 -> "Other"; 0x01 -> "Oil"; 0x02 -> "Electricity"; 0x03 -> "Gas"; 0x04 -> "Heat"; 0x05 -> "Steam"
    0x06 -> "Warm Water"; 0x07 -> "Water"; 0x08 -> "Heat Cost Allocator"; 0x09 -> "Compressed Air"
    0x0a, 0x0b -> "Cooling load meter"; 0x0c -> "Heat"; 0x0d -> "Heat/Cooling load meter"; 0x0e -> "Bus/System component"
    0x0f -> "Unknown"; 0x15 -> "Hot Water"; 0x16 -> "Cold Water"; 0x17 -> "Hot/Cold Water meter"; 0x18 -> "Pressure"
    0x19 -> "A/D Converter"; 0x1a -> "Smoke detector"; 0x1b -> "Room sensor"; 0x1c -> "Gas detector"
    0x20 -> "Breaker (electricity)"; 0x21 -> "Valve (gas or water)"; 0x25 -> "Customer unit (display device)"
    0x28 -> "Waste water meter"; 0x29 -> "Garbage"; 0x2a -> "Carbon dioxide"; 0x31 -> "Communication controller"
    0x32 -> "Unidirectional repeater"; 0x33 -> "Bidirectional repeater"; 0x36 -> "Radio converter (system side)"
    0x37 -> "Radio converter (meter side)"
    else -> ""
}

/** Mode T: each nibble travels as six bits with exactly three set; anything else cannot legally have been sent. */
private fun decode3of6(byte: Int): Int = when (byte) {
    22 -> 0x00; 13 -> 0x01; 14 -> 0x02; 11 -> 0x03; 28 -> 0x04; 25 -> 0x05; 26 -> 0x06; 19 -> 0x07
    44 -> 0x08; 37 -> 0x09; 38 -> 0x0a; 35 -> 0x0b; 52 -> 0x0c; 49 -> 0x0d; 50 -> 0x0e; 41 -> 0x0f
    else -> 0xf0
}

/**
 * A bad symbol becomes a zero nibble rather than abandoning the frame: the per-block CRC is the real arbiter.
 * Returns how many bytes decoded cleanly before the first bad symbol.
 */
private fun decode3of6Buffer(bits: UBytes, bitOffset: Int, out: UBytes, numBytes: Int): Int {
    var contiguous = -1
    val n = min(numBytes, out.size)
    for (i in 0 until n) {
        val hi = decode3of6(byteAt(bits, i * 12 + bitOffset) shr 2)
        var lo = decode3of6(byteAt(bits, i * 12 + bitOffset + 6) shr 2)
        if (hi > 0x0f || lo > 0x0f) { lo = lo and 0x0f; if (contiguous < 0) contiguous = i }
        out[i] = ((hi shl 4) or lo) and 0xff
    }
    return if (contiguous < 0) n else contiguous
}

/** Every block carries its own CRC: the M-Bus polynomial, complemented, stored big-endian. */
private fun crcValid(b: UBytes, at: Int, n: Int): Boolean {
    if (n < 0 || at + n + 1 >= b.size) return false
    val calc = crc16(b, n, 0x3d65, 0, at).inv() and 0xffff
    return calc == (((b[at + n] shl 8) or b[at + n + 1]) and 0xffff)
}

private class MBusData { var length = 0; val data = UBytes(BUF_SIZE) }

private class Block2 {
    var ci = 0; var ac = 0; var st = 0; var cw = 0; var plOffset = 0
    var ellCi = 0; var ellCc = 0; var ellAcc = 0; var ellSecMode = 0
    var knxCtrl = 0; var src = 0; var dst = 0; var lNpci = 0; var tpci = 0; var apci = 0
    var qdsWalkBy = 0
}

private class Block1 {
    var l = 0; var c = 0; var mStr = ""; var aId = 0; var aVersion = 0; var aDevType = 0
    var knxMode = false; val knxSn = UBytes(6); val block2 = Block2()
}

/** The extended link layer's sub-header length by its control byte; negative means this is not one. */
private fun ellLen(ci: Int) = when (ci) { 0x8c -> 2; 0x8d -> 8; 0x8e -> 10; 0x8f -> 16; else -> -1 }

/**
 * Step over the optional layers in front of the payload (extended link, authentication, transport). Each names
 * its own length, so they are skipped without decoding. An encrypted layer stops the walk with plOffset zero,
 * which tells the caller not to read records from it.
 */
private fun parseCi(b: UBytes, at: Int, remaining: Int, plBase: Int, b2: Block2, depth: Int = 0) {
    if (remaining < 1 || depth > 4) return
    b2.ci = b[at]
    val el = ellLen(b2.ci)
    if (el >= 0) {
        if (remaining < 1 + el) return
        b2.ellCi = b2.ci
        b2.ellCc = b[at + 1]
        b2.ellAcc = b[at + 2]
        b2.ellSecMode = if (b2.ci == 0x8d || b2.ci == 0x8f) {
            val snOff = if (b2.ci == 0x8f) 11 else 3
            val sn = b[at + snOff] or (b[at + snOff + 1] shl 8) or (b[at + snOff + 2] shl 16) or (b[at + snOff + 3] shl 24)
            (sn ushr 29) and 0x7
        } else 0
        if (b2.ellSecMode != 0) return
        parseCi(b, at + 1 + el, remaining - 1 - el, plBase + 1 + el, b2, depth + 1)
        return
    }
    if (b2.ci == 0x90) {
        if (remaining < 2) return
        val aflLen = b[at + 1]
        if (remaining < 2 + aflLen) return
        parseCi(b, at + 2 + aflLen, remaining - 2 - aflLen, plBase + 2 + aflLen, b2, depth + 1)
        return
    }
    when (b2.ci) {
        0x7a -> { b2.ac = b[at + 1]; b2.st = b[at + 2]; b2.cw = ((b[at + 4] shl 8) or b[at + 3]) and 0xffff; b2.plOffset = plBase + 5 }
        0x72 -> { b2.ac = b[at + 9]; b2.st = b[at + 10]; b2.cw = ((b[at + 12] shl 8) or b[at + 11]) and 0xffff; b2.plOffset = plBase + 13 }
        0x78 -> b2.plOffset = plBase + 1
    }
    // Qundis walk-by reuses that control byte with a fixed layout of its own.
    if (b2.ci == 0x78 && b[at + 1] == 0x0d && b[at + 2] == 0xff && b[at + 3] == 0x5f && b[at + 4] == 0x35) {
        b2.ac = b[at + 7]; b2.st = b[at + 5]; b2.cw = ((b[at + 9] shl 8) or b[at + 8]) and 0xffff
        b2.plOffset = plBase + 1
        b2.qdsWalkBy = 1
    }
}

private fun parseBlock2(inp: MBusData, b1: Block1, block1Size: Int, plBase: Int) {
    val b = inp.data
    val b2 = b1.block2
    if (b1.knxMode) {
        b2.knxCtrl = b[block1Size]
        b2.src = ((b[block1Size + 1] shl 8) or b[block1Size + 2]) and 0xffff
        b2.dst = ((b[block1Size + 3] shl 8) or b[block1Size + 4]) and 0xffff
        b2.lNpci = b[block1Size + 5]; b2.tpci = b[block1Size + 6]; b2.apci = b[block1Size + 7]
    } else {
        parseCi(b, block1Size, if (inp.length > block1Size) inp.length - block1Size else 0, plBase, b2)
    }
}

private fun readIdentity(d: UBytes, b1: Block1) {
    b1.mStr = manufDecode(((d[3] shl 8) or d[2]) and 0xffff)
    b1.aId = bcd2int(d[7]) * 1000000 + bcd2int(d[6]) * 10000 + bcd2int(d[5]) * 100 + bcd2int(d[4])
    b1.aVersion = d[8]
    b1.aDevType = d[9]
}

/** Format A: block 1, then sixteen-byte data blocks each closed by a CRC, which is dropped as they are joined. */
private fun decodeFormatA(inp: MBusData, out: MBusData, b1: Block1): Boolean {
    val d = inp.data
    b1.l = d[0]; b1.c = d[1]
    // KNX-RF puts fixed values where the manufacturer would be, and a six-byte serial after it.
    if (d[2] == 0xff && d[3] == 0x03) { b1.knxMode = true; b1.knxSn.setAll(d.sub(4, 10)) } else readIdentity(d, b1)
    out.length = b1.l - 9 + BLOCK1A_SIZE - 2
    if (!crcValid(d, 0, 10)) return false
    val numDataBlocks = Math.floorDiv(b1.l - 9 + 15, 16)
    if (b1.l < 9 || (b1.l - 9) + numDataBlocks * 2 > inp.length - BLOCK1A_SIZE) return false
    out.data.setAll(d.sub(0, BLOCK1A_SIZE - 2), 0)
    for (n in 0 until numDataBlocks) {
        val inAt = BLOCK1A_SIZE + n * 18
        val outAt = n * 16 + BLOCK1A_SIZE - 2
        val blockSize = min(b1.l - 9 - n * 16, 16) + 2
        if (blockSize < 2 || outAt + blockSize > BUF_SIZE) return false
        if (!crcValid(d, inAt, blockSize - 2)) return false
        out.data.setAll(d.sub(inAt, inAt + blockSize), outAt)
    }
    parseBlock2(inp, b1, BLOCK1A_SIZE, BLOCK1A_SIZE - 2)
    return true
}

/** Format B: one CRC over blocks 1 and 2 together, and a third block for long telegrams. */
private fun decodeFormatB(inp: MBusData, out: MBusData, b1: Block1): Boolean {
    val d = inp.data
    b1.l = d[0]; b1.c = d[1]
    readIdentity(d, b1)
    out.length = b1.l - (9 + 2) + BLOCK1B_SIZE - 2
    if (b1.l < 12 || b1.l + 1 > inp.length) return false
    if (!crcValid(d, 0, min(b1.l - 1, (BLOCK1B_SIZE + BLOCK2B_SIZE) - 2))) return false
    val take = min(b1.l - 11, BLOCK2B_SIZE - 2) + BLOCK1B_SIZE
    out.data.setAll(d.sub(0, max(0, min(take, BUF_SIZE))), 0)
    val lOffset = BLOCK1B_SIZE + BLOCK2B_SIZE - 1
    if (b1.l > lOffset + 2) {
        val n = b1.l - lOffset - 2
        if (!crcValid(d, BLOCK1B_SIZE + BLOCK2B_SIZE, n)) return false
        out.data.setAll(d.sub(BLOCK2B_SIZE, BLOCK2B_SIZE + n), BLOCK2B_SIZE - 2)
        out.length -= 2
    }
    out.length += 2                                      // keep the final CRC, so a decrypting tool can check it
    parseBlock2(inp, b1, BLOCK1B_SIZE, BLOCK1B_SIZE)
    return true
}

private fun emitMBus(ctx: DecodeCtx, out: MBusData, b1: Block1, mode: String): Int {
    val b2 = b1.block2
    val rec = if (b1.knxMode) {
        data("model" to "KNX-RF", "type" to "Meter", "mode" to mode, "id" to hexN(b1.knxSn, 6).uppercase(), "sn" to hexN(b1.knxSn, 6),
            "knx_ctrl" to hex2(b2.knxCtrl), "src" to hex4(b2.src), "dst" to hex4(b2.dst), "l_npci" to hex2(b2.lNpci),
            "tpci" to hex2(b2.tpci), "apci" to hex2(b2.apci))
    } else {
        data("model" to "Wireless-MBus", "type" to "Meter", "mode" to mode, "manufacturer" to b1.mStr, "id" to b1.aId.toString(),
            "version" to b1.aVersion, "device_type" to hex2(b1.aDevType), "device_type_string" to deviceTypeStr(b1.aDevType),
            "control" to hex2(b1.c))
    }
    rec["data"] = hexN(out.data, max(0, min(out.length, BUF_SIZE)))
    if (b2.ellCi != 0) { rec["ell_ci"] = hex2(b2.ellCi); rec["ell_cc"] = hex2(b2.ellCc); rec["ell_acc"] = hex2(b2.ellAcc) }
    if (b2.ci != 0 && b2.ci != b2.ellCi) {
        rec["CI"] = hex2(b2.ci)
        if (b2.plOffset != 0) { rec["AC"] = hex2(b2.ac); rec["ST"] = hex2(b2.st); rec["CW"] = hex4(b2.cw) }
    }
    if (b2.qdsWalkBy != 0) rec["qds_walk_by"] = 1
    // Records are not decoded, so say plainly when the reason is that they are locked away.
    if (!b1.knxMode && b2.plOffset == 0) {
        if (b2.ellCi != 0 && b2.ellSecMode != 0) rec["payload_encrypted"] = 1
    } else if ((b2.cw and 0x0500) != 0) {
        rec["payload_encrypted"] = 1
    }
    rec["mic"] = "CRC"
    ctx.emit(rec)
    return 1
}

private val PREAMBLE_T = UBytes.of(0x54, 0x3d)
private val PREAMBLE_RA = UBytes.of(0x55, 0x54, 0x76, 0x96)
private val PREAMBLE_F = UBytes.of(0x55, 0xf6)
private val PREAMBLE_S = UBytes.of(0x54, 0x76, 0x96)
private val PREAMBLE_T_DN = UBytes.of(0xaa, 0xab, 0x32)

/** C and T share a preamble; the next byte tells them apart. T is 3-of-6 coded and always format A. */
private fun modeCt(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n < 32 + 13 * 8 || n > 64 + 256 * 12) return DECODE_ABORT_LENGTH
    var at = bits.search(0, 0, PREAMBLE_T, 16)
    if (at + 13 * 8 >= n) return DECODE_ABORT_EARLY
    at += 16
    val row = bits.bb[0]
    val inp = MBusData(); val out = MBusData(); val b1 = Block1()
    var next = byteAt(row, at)
    at += 8
    val mode: String
    if (next == 0x54) {
        mode = "C"
        next = byteAt(row, at)
        at += 8
        inp.length = min(Math.floorDiv(n - at, 8), BUF_SIZE)
        when (next) {
            0xcd -> { bits.extractBytes(0, at, inp.data, inp.length * 8); if (!decodeFormatA(inp, out, b1)) return DECODE_FAIL_SANITY }
            0x3d -> { bits.extractBytes(0, at, inp.data, inp.length * 8); if (!decodeFormatB(inp, out, b1)) return DECODE_FAIL_SANITY }
            else -> return DECODE_ABORT_EARLY
        }
    } else {
        mode = "T"
        at -= 8                                          // that byte was payload, not a mode marker
        inp.length = min(Math.floorDiv(n - at, 12), BUF_SIZE)
        if (decode3of6Buffer(row, at, inp.data, inp.length) < 0) return DECODE_FAIL_SANITY
        if (!decodeFormatA(inp, out, b1)) return DECODE_FAIL_SANITY
    }
    return emitMBus(ctx, out, b1, mode)
}

/** Mode S, Manchester, format A. The mode T downlink shares the band and is stepped around. */
private fun modeS(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n < 32 + 13 * 8 || n > 64 + 256 * 8) return DECODE_ABORT_LENGTH
    val dn = bits.search(0, 0, PREAMBLE_T_DN, 24)
    if (dn + 24 < n) return DECODE_ABORT_EARLY
    var at = bits.search(0, 0, PREAMBLE_S, 24)
    at += 24
    if (at >= n) return DECODE_ABORT_EARLY
    val packet = BitBuffer()
    bits.manchesterDecode(0, at, packet, 800)
    val decodedBits = packet.bitsPerRow[0]
    if (decodedBits < BLOCK1A_SIZE * 8) return DECODE_ABORT_LENGTH
    val inp = MBusData(); val out = MBusData(); val b1 = Block1()
    // rtl_433 passes the raw bit count as a byte count here; the bytes the Manchester decode produced are used.
    inp.length = min(decodedBits shr 3, BUF_SIZE)
    packet.extractBytes(0, 0, inp.data, inp.length * 8)
    if (!decodeFormatA(inp, out, b1)) return DECODE_FAIL_SANITY
    return emitMBus(ctx, out, b1, "S")
}

private fun modeR(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n < 32 + 13 * 8 || n > 64 + 256 * 8) return DECODE_ABORT_LENGTH
    var at = bits.search(0, 0, PREAMBLE_RA, 32)
    if (at + 13 * 8 >= n) return DECODE_ABORT_EARLY
    at += 32
    val inp = MBusData(); val out = MBusData(); val b1 = Block1()
    inp.length = min(Math.floorDiv(n - at, 8), BUF_SIZE)
    bits.extractBytes(0, at, inp.data, inp.length * 8)
    if (!decodeFormatA(inp, out, b1)) return DECODE_FAIL_SANITY
    return emitMBus(ctx, out, b1, "R")
}

/**
 * Mode F: its framing has never been confirmed upstream, so only the sighting is reported, without a mic: a
 * two-byte preamble and a known format byte.
 */
private fun modeF(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val n = bits.bitsPerRow[0]
    if (n < 32 + 13 * 8 || n > 64 + 256 * 8) return DECODE_ABORT_LENGTH
    var at = bits.search(0, 0, PREAMBLE_F, 16)
    if (at + 13 * 8 >= n) return DECODE_ABORT_EARLY
    at += 16
    val next = byteAt(bits.bb[0], at)
    if (next != 0x8d && next != 0x72) return DECODE_ABORT_EARLY
    ctx.emit(data("model" to "Wireless-MBus", "type" to "Meter", "mode" to "F", "format" to if (next == 0x8d) "A" else "B",
        "note" to "preamble and format byte recognized; payload framing unverified upstream"))
    return 1
}

private const val RADIAN_MAX_FRAME_BYTES = 256
private const val RADIAN_MIN_FRAME_BYTES = 6
private val RADIAN_SYNC = UBytes.of(0x0f, 0xff, 0xff, 0xff, 0xf0)

private fun radianControlString(c: Int) = when (c) { 0x06 -> "ack"; 0x10 -> "request"; 0x11 -> "response"; else -> "unknown" }

/** The wired telegram is found by its self-checking START, length, length, START framing, not a fixed offset. */
private fun radianFindWmbusFrame(body: UBytes, bodyLen: Int): Pair<Int, Int>? {
    var i = 0
    while (i + 4 <= bodyLen) {
        if (body[i] == 0x68 && body[i + 3] == 0x68 && body[i + 1] == body[i + 2]) {
            val wlen = body[i + 1]
            if (i + 4 + wlen + 2 <= bodyLen) {
                val at = i + 4
                var sum = 0
                for (j in 0 until wlen) sum = (sum + body[at + j]) and 0xff
                if (sum == body[at + wlen] && body[at + wlen + 1] == 0x16) return at to wlen
            }
        }
        i++
    }
    return null
}

private fun radianRow(bits: BitBuffer, ctx: DecodeCtx, row: Int): Int {
    val rowBits = bits.bitsPerRow[row]
    var pos = bits.search(row, 0, RADIAN_SYNC, 36)
    if (pos >= rowBits) return DECODE_ABORT_EARLY
    pos += 36
    if (pos >= rowBits) return DECODE_ABORT_LENGTH
    val frame = UBytes(RADIAN_MAX_FRAME_BYTES)
    val frameLen = extractBytesUart8n2(bits.bb[row], pos, min(rowBits - pos, RADIAN_MAX_FRAME_BYTES * 11), frame)
    if (frameLen < RADIAN_MIN_FRAME_BYTES) return DECODE_ABORT_LENGTH
    val declared = frame[0]
    if (declared < RADIAN_MIN_FRAME_BYTES || declared > RADIAN_MAX_FRAME_BYTES) return DECODE_FAIL_SANITY
    if (frameLen < declared) return DECODE_ABORT_LENGTH
    val crcRx = (frame[declared - 2] or (frame[declared - 1] shl 8)) and 0xffff
    if (crc16lsb(frame, declared - 2, 0x8408, 0x0000) != crcRx) return DECODE_FAIL_MIC
    val control = frame[1]
    // Two header layouts: compact (the one captured sample) and spaced, with a zero byte before each address.
    var addrOff = 2; var bodyOff = 12; var spaced = 0
    if (declared >= 18 && frame[2] == 0x00 && frame[8] == 0x00 && frame[14] == 0x00) { addrOff = 3; bodyOff = 15; spaced = 1 }
    if (bodyOff + 2 > declared) return DECODE_FAIL_SANITY
    val bodyLen = declared - bodyOff - 2
    val senderId = hexN(frame.sub(addrOff + 5 + spaced, addrOff + 10 + spaced), 5)
    val out = data("model" to "RADIAN", "type" to "Meter", "id" to senderId, "len" to declared, "control" to hex2(control),
        "control_string" to radianControlString(control), "header_variant" to if (spaced != 0) "spaced" else "compact",
        "receiver_id" to hexN(frame.sub(addrOff, addrOff + 5), 5), "sender_id" to senderId, "body_len" to bodyLen,
        "body" to hexN(frame.sub(bodyOff, bodyOff + bodyLen), bodyLen), "crc" to hex4(crcRx), "data" to hexN(frame, declared))
    // The body wraps a whole wired M-Bus telegram, read with the same header code as the radio modes.
    val wm = radianFindWmbusFrame(frame.sub(bodyOff, bodyOff + bodyLen), bodyLen)
    if (wm != null) {
        val b2 = Block2()
        val wired = frame.sub(bodyOff + wm.first, bodyOff + wm.first + wm.second)
        parseCi(wired, 2, if (wm.second > 2) wm.second - 2 else 0, 2, b2)
        if (b2.ci != 0) out["wmbus_ci"] = hex2(b2.ci)
        if (b2.plOffset != 0) { out["wmbus_ac"] = hex2(b2.ac); out["wmbus_st"] = hex2(b2.st); out["wmbus_cw"] = hex4(b2.cw) }
    }
    out["mic"] = "CRC"
    ctx.emit(out)
    return 1
}

private fun radian(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0; var aborts = 0; var fails = 0
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] < 36 + RADIAN_MIN_FRAME_BYTES * 11) { aborts++; continue }
        val ret = radianRow(bits, ctx, row)
        if (ret > 0) events += ret else if (ret == DECODE_FAIL_MIC || ret == DECODE_FAIL_SANITY) fails++ else aborts++
    }
    if (events != 0) return events
    if (fails != 0) return DECODE_FAIL_MIC
    if (aborts != 0) return DECODE_ABORT_EARLY
    return DECODE_ABORT_LENGTH
}

private const val METER = "utility meter"
private const val S_BIT = 1000 / 32.768

internal val MBUS: List<RDevice> = listOf(
    dev(104, "Wireless M-Bus, Mode C&T, 100kbps", Mod.FSK_PCM, 10, 10, 500, bands = listOf(868_950_000L), what = METER, decode = ::modeCt),
    dev(105, "Wireless M-Bus, Mode S, 32.768kbps", Mod.FSK_PCM, S_BIT, S_BIT, S_BIT * 9, bands = listOf(868_300_000L), what = METER, decode = ::modeS),
    dev(106, "Wireless M-Bus, Mode R, 4.8kbps", Mod.FSK_MANCHESTER_ZEROBIT, 1000 / 4.8 / 2, 0, (1000 / 4.8) * 1.5, disabled = true,
        bands = listOf(868_330_000L), what = METER, decode = ::modeR),
    dev(107, "Wireless M-Bus, Mode F, 2.4kbps", Mod.FSK_PCM, 1000 / 2.4, 1000 / 2.4, 5000, disabled = true,
        bands = listOf(433_820_000L), what = METER, decode = ::modeF),
    dev(238, "Wireless M-Bus, Mode T, 32.768kbps (downlink)", Mod.FSK_PCM, S_BIT, S_BIT, S_BIT * 9, bands = listOf(868_300_000L), what = METER, decode = ::modeCt),
    dev(379, "RADIAN/RADIAN0 meter", Mod.FSK_PCM, 416, 416, 20000, what = METER, decode = ::radian),
)
