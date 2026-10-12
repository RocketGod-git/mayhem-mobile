package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * DirecTV RC66RX remote, Vivint security sensor and the Silver Spring Networks mesh endpoint.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): directv.c, vivint.c, silverspring.c. Twin of web/src/dsp/r433/devices/deferred.ts.
 */

private val BAND_345 = listOf(345_000_000L)
private val BAND_433 = listOf(433_920_000L)
private val BAND_915 = listOf(915_000_000L)

private val DTV_BUTTON = mapOf(
    0x01 to "1", 0x02 to "2", 0x03 to "3", 0x04 to "4", 0x05 to "5", 0x06 to "6", 0x07 to "7", 0x08 to "8", 0x09 to "9",
    0x0d to "CH UP", 0x0e to "CH DOWN", 0x0f to "CH PREV", 0x10 to "PWR", 0x11 to "0", 0x12 to "DASH", 0x13 to "ENTER",
    0x14 to "DASH REPEAT", 0x15 to "ENTER REPEAT", 0x20 to "MENU", 0x21 to "UP", 0x22 to "DOWN", 0x23 to "LEFT",
    0x24 to "RIGHT", 0x25 to "SELECT", 0x26 to "EXIT", 0x27 to "BACK", 0x28 to "GUIDE", 0x29 to "ACTIVE", 0x2a to "LIST",
    0x2b to "LIST REPEAT", 0x2c to "INFO REPEAT", 0x2d to "GUIDE REPEAT", 0x2e to "INFO",
    0x30 to "VCR PLAY", 0x31 to "VCR STOP", 0x32 to "VCR PAUSE", 0x33 to "VCR RWD", 0x34 to "VCR FFD", 0x35 to "VCR REC",
    0x36 to "VCR BACK", 0x37 to "VCR SKIP", 0x38 to "VCR SKIP REPEAT", 0x3a to "VCR PLAY REPEAT",
    0x3b to "VCR PAUSE REPEAT", 0x3c to "VCR RWD REPEAT", 0x3d to "VCR FFD REPEAT", 0x3e to "VCR REC REPEAT",
    0x3f to "VCR BACK REPEAT",
    0x41 to "RED", 0x42 to "YELLOW", 0x43 to "GREEN", 0x44 to "BLUE", 0x45 to "MENU REPEAT", 0x46 to "ACTIVE REPEAT",
    0x4a to "RED REPEAT", 0x4b to "YELLOW REPEAT", 0x4c to "GREEN REPEAT", 0x4d to "BLUE REPEAT",
    0x51 to "TV: VCR ALERT", 0x59 to "VOLUME ALERT", 0x5a to "AV1/AV2/TV: IR ALERT 1", 0x5b to "DTV: IR ALERT",
    0x5c to "AV1/AV2/TV: IR ALERT 2", 0x5d to "TV: DTV ALERT", 0x5e to "AV1: DTV ALERT", 0x5f to "AV2: DTV ALERT",
    0x60 to "0 REPEAT", 0x61 to "1 REPEAT", 0x62 to "2 REPEAT", 0x63 to "3 REPEAT", 0x64 to "4 REPEAT", 0x65 to "5 REPEAT",
    0x66 to "6 REPEAT", 0x67 to "7 REPEAT", 0x68 to "8 REPEAT", 0x69 to "9 REPEAT",
    0x73 to "FORMAT", 0x75 to "FORMAT REPEAT",
    0x80 to "DTV: DTV&TV POWER ON", 0x81 to "DTV: DTV&TV POWER OFF", 0xd6 to "SELECT RELEASE",
)

private class Dpwm(val bits: LongArray, val count: Int, val syncLen: Long)

/**
 * Differential pulse width: only run lengths carry data. The counter starts at all ones so the first transition
 * ends a sync of length zero; a sync discards everything before it, and the run after a sync is a marker.
 */
private fun dpwmDecode(row: UBytes, bitLen: Int, start: Int): Dpwm {
    val out = LongArray(bitLen + 1)
    var bufPos = -1
    var cur = 0xffffffffL
    var syncLen = 0L
    var syncing = true
    var prev = 0xff
    for (p in start until bitLen) {
        val b = bitAt(row, p)
        if (b == prev) {
            cur = (cur + 1) and 0xffffffffL
            if (cur > 1) syncing = true                   // three or more alike symbols is a sync, not data
        } else {
            if (syncing) {
                syncLen = (cur + 1) and 0xffffffffL
                bufPos = -1
                syncing = false
            } else {
                if (bufPos >= 0) out[bufPos] = cur
                bufPos++
            }
            cur = 0
        }
        prev = b
    }
    // A sync running to the end of the row takes the bit before it with it.
    if (syncing) bufPos -= 1
    if (bufPos < 0) bufPos = 0
    return Dpwm(out, bufPos, syncLen)
}

private fun directv(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val bitLen = bits.bitsPerRow[0]
    if (bitLen < 44 || bitLen > 99) return DECODE_FAIL_SANITY
    val logical = dpwmDecode(bits.bb[0], bitLen, 0)
    if (logical.count != 40) return DECODE_ABORT_LENGTH
    val b = UBytes(5)
    for (i in 0 until 40) if (logical.bits[i] != 0L) b[i shr 3] = b[i shr 3] or (0x80 shr (i and 7))
    if (b[0] != 0x10) return DECODE_FAIL_SANITY
    var sum = 0
    for (i in 0 until 4) sum += (b[i] shr 4) + (b[i] and 0x0f)
    sum = (sum + (b[4] shr 4)) and 0x0f
    if (sum != (b[4] and 0x0f)) return DECODE_FAIL_MIC
    val id = (b[1] shl 12) or (b[2] shl 4) or (b[3] shr 4)
    if (id > 999999) return DECODE_FAIL_SANITY
    val button = ((b[3] shl 4) or (b[4] shr 4)) and 0xff
    ctx.emit(data("model" to "DirecTV-RC66RX", "type" to "Remote", "id" to id, "button_id" to button, "button_name" to (DTV_BUTTON[button] ?: "unknown"),
        // A long run-in marks the first send of a message, a short one a repeat.
        "event" to if (logical.syncLen > 5) "INITIAL" else "REPEAT", "mic" to "CHECKSUM"))
    return 1
}

/**
 * The status byte is encrypted under a per-device seed never sent; upstream reports raw hex without one, and so
 * does this. Ordinary frames carry a packed twelve-bit check, startup beacons a plain CRC-16.
 */
private fun vivint(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    bits.invert()
    val pos = bits.search(0, 0, UBytes.of(0xff, 0xe0), 12) + 12
    if (bits.bitsPerRow[0] - pos < 80) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, pos, 80)
    val eventType = b[0]
    val id = u32be(b, 4)
    if (id == 0L || id == 0xffffffffL) return DECODE_FAIL_SANITY
    val valid = if (eventType == 0xd0) {
        ((b[8] shl 8) or b[9]) == crc16(b, 8, 0x8050, 0)
    } else {
        // The low nibble of b[8] belongs to the check, so the CRC covers only its top nibble.
        val full = b[8]
        b[8] = full and 0xf0
        val check12 = crc16(b, 9, 0x8050, 0) shr 4
        b[8] = full
        check12 == (((full and 0x0f) shl 8) or b[9])
    }
    if (!valid) return DECODE_FAIL_MIC
    // Printed on the sensor as two decimal groups.
    val idStr = "${((id ushr 20) and 0xfff).toString().padStart(4, '0')}-${(id and 0xfffff).toString().padStart(7, '0')}"
    ctx.emit(data("model" to "Vivint-Security", "type" to "Security", "id" to idStr, "counter" to ((b[1] shl 8) or b[2]), "flags" to b[3],
        "event_type" to eventType, "data" to hexBytes(b, 10), "mic" to "CRC"))
    return 1
}

/** CRC-32/MPEG-2: all ones in, no final inversion, MSB first. */
private fun crc32Mpeg2(d: UBytes, len: Int): Int {
    var c = -1
    for (i in 0 until len) {
        c = c xor (d[i] shl 24)
        for (b in 0 until 8) c = if (c < 0) (c shl 1) xor 0x04c11db7 else c shl 1
    }
    return c
}

/** An additive shift register, so the same routine undoes it. */
private fun ssnDescramble(buf: UBytes, len: Int, seed: Int) {
    var reg = seed and 0xff
    for (i in 0 until len) {
        var k = 0
        for (b in 0 until 8) {
            k = ((k shl 1) or ((reg shr 7) and 1)) and 0xff
            var t = reg and 0x8e
            t = t xor (t shr 4); t = t xor (t shr 2); t = t xor (t shr 1)
            reg = ((reg shl 1) or (t and 1)) and 0xff
        }
        buf[i] = buf[i] xor k
    }
}

private class SsnExtras {
    var seenDll2 = false; var seenDll4 = false; var seenDll9 = false; var seenMpdu = false
    var seq: IntArray? = null; var fet: Int? = null; var rssi: Int? = null; var cli: IntArray? = null; var syncChannel: Int? = null
}

/**
 * One type/length/value record and the bytes it took: the top bit of the first byte picks one of two layouts.
 * Upstream marks several of these fields as candidates rather than settled; its names are kept so the two agree.
 */
private fun ssnTlv(psdu: UBytes, len: Int, i: Int, parts: MutableList<String>, extras: SsnExtras?): Triple<Int, Int, Boolean> {
    if (i + 2 > len) return Triple(0, 0, false)
    val h0 = psdu[i]; val h1 = psdu[i + 1]
    val isMpdu = (h0 and 0x80) != 0
    val type = if (isMpdu) h0 shr 3 else ((h0 shl 1) or (h1 shr 7)) and 0x1ff
    val vlen = if (isMpdu) ((h0 and 0x07) shl 8) or h1 else h1 and 0x7f
    if (i + 2 + vlen > len) return Triple(0, 0, false)
    parts.add("${if (isMpdu) 'M' else 'D'}$type/$vlen")
    if (isMpdu && type == 17 && vlen > 0) {
        val nested = ArrayList<String>()
        ssnTlv(psdu, i + 2 + vlen, i + 2, nested, null)
        parts[parts.size - 1] = parts.last() + "{${nested.joinToString(" ")}}"
    }
    if (extras != null) {
        val v = i + 2
        if (isMpdu) extras.seenMpdu = true
        else when (type) {
            2 -> {
                extras.seenDll2 = true
                if (vlen == 3) {
                    val raw = (psdu[v] shl 16) or (psdu[v + 1] shl 8) or psdu[v + 2]
                    extras.cli = intArrayOf((raw shr 21) and 0x7, (raw shr 12) and 0x1ff, (raw shr 9) and 0x7, raw and 0x1ff)
                }
            }
            4 -> {
                extras.seenDll4 = true
                if (vlen == 2) {
                    val raw = (psdu[v] shl 8) or psdu[v + 1]
                    extras.seq = intArrayOf((raw shr 15) and 1, (raw shr 14) and 1, (raw shr 10) and 0xf, raw and 0x3ff)
                }
            }
            9 -> { extras.seenDll9 = true; if (vlen == 1) extras.rssi = signed(psdu[v], 8) }
            1 -> if (vlen == 2) extras.fet = (psdu[v] shl 8) or psdu[v + 1]
            8 -> if (vlen == 5) extras.syncChannel = psdu[v + 4]
        }
    }
    return Triple(2 + vlen, type, !isMpdu)
}

/**
 * The record stream. One type marks that the last four bytes checksum everything before them; another ends the
 * stream ahead of a fragment that is not reassembled, whose size is reported.
 */
private fun ssnTlvs(psdu: UBytes, psduLen: Int, start: Int, extras: SsnExtras): String {
    val parts = ArrayList<String>()
    var i = start
    var sawCrcMarker = false
    while (i < psduLen) {
        val (used, type, isDll) = ssnTlv(psdu, psduLen, i, parts, extras)
        if (used == 0) break
        i += used
        if (isDll && type == 6) { sawCrcMarker = true; continue }
        if (isDll && type == 5) {
            if (i < psduLen) parts.add("+${psduLen - i}B")
            return parts.joinToString(" ")
        }
    }
    if (sawCrcMarker && i + 4 == psduLen) parts.add(if (crc32Mpeg2(psdu, i) == u32be(psdu, i).toInt()) ":ok" else ":bad")
    else if (i < psduLen) parts.add("+${psduLen - i}B")
    return parts.joinToString(" ")
}

private fun ssnLink(fctrl: Int, e: SsnExtras): String = when (fctrl) {
    2 -> "broadcast"
    3 -> "poll"
    1 -> if (e.seenDll4 || e.seenMpdu) "data" else if (e.seenDll2) "poll_ack" else if (e.seenDll9) "data_ack" else ""
    else -> ""
}

private val SSN_SYNC = UBytes.of(0xaa, 0xaa, 0x18, 0xbf)

/**
 * The per-hop scrambler seed is not sent, so every value is tried against the CRC-32: on a constructed frame
 * exactly one works, and a single flipped bit leaves none.
 */
private fun silverSpring(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    var pos = bits.search(0, 0, SSN_SYNC, 32)
    if (pos >= bits.bitsPerRow[0]) {
        bits.invert()                                    // both keying polarities turn up in the wild
        pos = bits.search(0, 0, SSN_SYNC, 32)
        if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    }
    // The frame begins on the last bit of the matched sync and is the complement of what matched.
    val frameStart = pos + 32 - 1
    val availBits = bits.bitsPerRow[0] - frameStart
    if (availBits < (3 + 4) * 8) return DECODE_ABORT_LENGTH
    val availBytes = minOf(availBits / 8, 512)
    bits.invert()
    val frame = bits.bytes(0, frameStart, availBytes * 8)
    if ((frame[1] and 0xf8) != 0) return DECODE_FAIL_SANITY
    val channel = frame[0]
    val psduLen = ((frame[1] and 0x07) shl 8) or frame[2]
    if (psduLen < 1 || 3 + psduLen + 4 > availBytes) return DECODE_ABORT_LENGTH
    val scrLen = psduLen + 4
    val psdu = UBytes(scrLen)
    var seedFound = -1
    for (seed in 1 until 256) {
        psdu.setAll(frame.sub(3, 3 + scrLen))
        ssnDescramble(psdu, scrLen, seed)
        if (crc32Mpeg2(psdu, psduLen) == u32be(psdu, psduLen).toInt()) { seedFound = seed; break }
    }
    if (seedFound < 0) return DECODE_FAIL_MIC
    val fctrl = psdu[0]
    var at = 1
    var dst = ""; var src = ""
    if ((fctrl and 0x01) != 0 && at + 8 <= psduLen) { dst = hexBytes(psdu, 8, at); at += 8 }
    if ((fctrl and 0x02) != 0 && at + 8 <= psduLen) { src = hexBytes(psdu, 8, at); at += 8 }
    val extras = SsnExtras()
    val tlvs = ssnTlvs(psdu, psduLen, at, extras)
    val link = ssnLink(fctrl, extras)
    val out = data("model" to "SilverSpring-Mesh", "type" to "Meter", "channel" to channel, "seed" to seedFound, "len" to psduLen,
        "data" to hexBytes(psdu, psduLen), "mic" to "CRC")
    if (dst.isNotEmpty()) out["dst_id"] = dst
    if (src.isNotEmpty()) out["src_id"] = src
    if (link.isNotEmpty()) out["link"] = link
    if (tlvs.isNotEmpty()) out["tlvs"] = tlvs
    extras.seq?.let { out["seq_num"] = it[3]; out["frag_num"] = it[2]; out["frag_more"] = it[1]; out["retry"] = it[0] }
    extras.fet?.let { out["fet"] = it }
    extras.rssi?.let { out["rssi"] = it }
    extras.cli?.let { out["cli_tx_pri"] = it[0]; out["cli_tx_time"] = it[1]; out["cli_rx_pri"] = it[2]; out["cli_rx_time"] = it[3] }
    extras.syncChannel?.let { out["sync_channel"] = it }
    ctx.emit(out)
    return 1
}

internal val DEFERRED: List<RDevice> = listOf(
    dev(128, "DirecTV RC66RX Remote Control", Mod.FSK_PCM, 600, 600, 50000, gapLimit = 30000, bands = BAND_433, what = "satellite television remote", decode = ::directv),
    dev(342, "Vivint Door/Window Sensor, V-DW21R-345/V-DW11-345", Mod.OOK_MANCHESTER_ZEROBIT, 150, 0, 300, bands = BAND_345, what = "security sensor", decode = ::vivint),
    dev(383, "Silver Spring Networks mesh endpoint (-s 1600k)", Mod.FSK_PCM, 10, 10, 1000, bands = BAND_915, what = "utility mesh endpoint", decode = ::silverSpring),
)
