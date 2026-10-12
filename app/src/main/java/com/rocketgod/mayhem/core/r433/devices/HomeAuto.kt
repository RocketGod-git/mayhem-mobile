package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*
import kotlin.math.min

/*
 * Home automation: FS20 / FHT, RojaFlex shutters and Somfy io-homecontrol.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): fs20.c, rojaflex.c, somfy_iohc.c. Twin of web/src/dsp/r433/devices/homeauto.ts.
 */

private val BAND_433 = listOf(433_920_000L)
/** FS20 and Somfy both live in the European 868 MHz band, at slightly different spots. */
private val BAND_868 = listOf(868_350_000L)
private val BAND_868_9 = listOf(868_890_000L)

private val FS20_CMD = listOf(
    "off", "on, 6.25%", "on, 12.5%", "on, 18.75%", "on, 25%", "on, 31.25%", "on, 37.5%", "on, 43.75%",
    "on, 50%", "on, 56.25%", "on, 62.5%", "on, 68.75%", "on, 75%", "on, 81.25%", "on, 87.5%", "on, 93.75%",
    "on, 100%", "on, last value", "toggle on/off", "dim up", "dim down", "dim up/down", "set timer",
    "status request", "off, timer", "on, timer", "last value, timer", "reset to default",
    "unused", "unused", "unused", "unused",
)
private val FS20_FLAGS = listOf("(none)", "Extended", "BiDir", "Extended | BiDir", "Response", "Response | Extended", "Response | BiDir",
    "Response | Extended | BiDir")
private val FHT_CMD = listOf("end-of-sync", "valve open", "valve close", "? (0x3)", "? (0x4)", "? (0x5)", "valve open <ext>%", "? (0x7)",
    "offset adjust", "? (0x9)", "valve de-scale", "? (0x11)", "sync countdown", "? (0x13)", "beep", "pairing?")
private val FHT_FLAGS = listOf("(none)", "Extended", "BS?", "Extended | BS?", "Repeat", "Repeat | Extended", "Repeat | BS?", "Repeat | Extended | BS?")

/** One byte and the parity bit after it, from an unaligned position; -1 when the parity disagrees. */
private fun fs20Byte(row: UBytes, pos: Int): Int {
    val word = (((row[pos shr 3] shl 8) or row[(pos shr 3) + 1]) shl (pos and 7)) and 0xffff
    val data = word shr 8
    return if (parity8(data) != ((word shr 7) and 1)) -1 else data
}

/** Housecodes and addresses as base-four digits offset by one, the way the DIP switches read. */
private fun fs20Base4(value: Int, digits: Int): Int {
    var out = 0; var v = value
    for (i in 0 until digits) { out += ((v % 4) + 1) shl (i * 4); v /= 4 }
    return out
}

private val FS20_PREAMBLE = UBytes.of(0x00, 0x10)

/**
 * The checksum is a residual: take the fields back out and what remains names FS20 or FHT plus a hop count. Off
 * upstream, as foreign traffic false-decodes here; the sanity rules below turn away the common shapes of it.
 */
private fun fs20(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    val row = bits.bb[0]
    val rowBits = bits.bitsPerRow[0]
    var hc = 0; var address = 0; var cmd = 0; var ext = 0; var sum = 0
    var found = false
    var rc = DECODE_FAIL_MIC
    var bitpos = 0
    while (true) {
        val at = bits.search(0, bitpos, FS20_PREAMBLE, 12)
        if (at >= rowBits) break
        val start = at + 12
        if (start + 45 > rowBits) { rc = DECODE_ABORT_LENGTH; break }
        bitpos = at + 1
        ext = 0
        val b0 = fs20Byte(row, start); if (b0 < 0) continue
        val b1 = fs20Byte(row, start + 9); if (b1 < 0) continue
        val b2 = fs20Byte(row, start + 18); if (b2 < 0) continue
        val b3 = fs20Byte(row, start + 27); if (b3 < 0) continue
        var b4 = fs20Byte(row, start + 36); if (b4 < 0) continue
        hc = (b0 shl 8) or b1
        address = b2
        cmd = b3
        if ((cmd and 0x20) != 0) {
            ext = b4
            if (start + 54 > rowBits) { rc = DECODE_ABORT_LENGTH; break }
            b4 = fs20Byte(row, start + 45); if (b4 < 0) continue
        }
        sum = b4
        found = true
        rc = 1
        break
    }
    if (!found) return rc
    val residual = (sum - (hc shr 8) - (hc and 0xff) - address - cmd - ext) and 0xff
    val isFs20 = residual in 6..8
    val isFht = residual in 0x0c..0x0e
    if (!isFs20 && !isFht) return DECODE_FAIL_SANITY
    // A valve ends its sync run with the value in the extension byte, so a bare command zero is malformed.
    if (isFht && (cmd and 0x0f) == 0x00 && (cmd and 0x20) == 0) return DECODE_FAIL_SANITY
    if (isFs20 && (cmd and 0x1f) >= 0x1c) return DECODE_FAIL_SANITY
    if (hc == 0 && address == 0) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to if (isFs20) "FS20" else "FHT", "type" to "Remote", "housecode" to fs20Base4(hc, 8), "address" to fs20Base4(address, 4),
        "command" to if (isFs20) FS20_CMD[cmd and 0x1f] else FHT_CMD[cmd and 0x0f], "flags" to if (isFs20) FS20_FLAGS[cmd shr 5] else FHT_FLAGS[cmd shr 5],
        "ext" to ext, "mic" to "PARITY"))
    return 1
}

private val ROJAFLEX_CMD = mapOf(0x0a to "Stop", 0x1a to "Up", 0x8a to "Down",
    0x9a to "Save/Unsave position",                      // five presses of stop; the same code sets and clears it
    0xda to "Go saved position", 0xea to "Request Status", 0x85 to "Pos. Status 0%", 0x95 to "Pos. Status 20%",
    0xa5 to "Pos. Status 40%", 0xb5 to "Pos. Status 60%", 0xc5 to "Pos. Status 80%", 0xd5 to "Pos. Status 100%")

/**
 * The bridge clones a remote's frame but never appends the CRC, so a remote frame two bytes short is the bridge
 * talking, and it is reported without an integrity claim it has not earned.
 */
private fun rojaflex(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val start = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0xd3, 0x91, 0xd3, 0x91), 48)
    if (start >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val frameBits = (bits.bitsPerRow[0] - start - 48) and 0xfe
    if (frameBits < 72 || frameBits > 88) return DECODE_ABORT_LENGTH
    val msg = bits.bytes(0, start + 48, frameBits)
    val hasCrc = frameBits == 88
    if (hasCrc && crc16(msg, 9, 0x8005, 0xffff) != ((msg[9] shl 8) or msg[10])) return DECODE_FAIL_MIC
    val model = when (msg[5] and 0x0f) {
        0x5 -> "RojaFlex-Shutter"
        0xa -> if (hasCrc) "RojaFlex-Remote" else "RojaFlex-Bridge"
        else -> "RojaFlex-Other"
    }
    val out = data("model" to model, "type" to "Remote", "id" to ((msg[1] shl 20) or (msg[2] shl 12) or (msg[3] shl 4) or (msg[4] shr 4)),
        "channel" to (msg[4] and 0x0f),                 // zero addresses every shutter at once
        "token" to ((msg[7] shl 8) or msg[8]), "cmd_id" to msg[5], "cmd_name" to (ROJAFLEX_CMD[msg[5]] ?: "unknown"), "cmd_value" to msg[6])
    if (hasCrc) out["mic"] = "CRC"
    ctx.emit(out)
    return 1
}

/**
 * UART framed throughout, sync word included, so the search pattern is the UART encoding of ff33. A one-way
 * frame ends in a counter and a six-byte keyed authentication code, reported as hex: there is no key to read it.
 */
private fun somfyIohc(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val offset = bits.search(0, 0, UBytes.of(0x57, 0xfd, 0x99), 24) + 24
    if (offset >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val b = UBytes(1 + 31 + 2)
    var len = extractBytesUart8n1(bits.bb[0], offset, min(bits.bitsPerRow[0] - offset, b.size * 10), b)
    if (len < 11) return DECODE_ABORT_LENGTH
    val msgLen = b[0] and 0x1f
    if (len < msgLen + 3) return DECODE_ABORT_LENGTH
    if (msgLen < 8) return DECODE_ABORT_LENGTH
    len = msgLen + 3
    if (crc16lsb(b, len, 0x8408, 0x0000) != 0) return DECODE_FAIL_MIC
    val protocolMode = (b[0] and 0x20) shr 5
    var dataLength = msgLen - 8
    var seqNr = 0
    var mac = ""
    val payload: String
    if (protocolMode == 0 || dataLength < 8) {
        payload = hexBytes(b, dataLength, 9)
    } else {
        dataLength -= 8
        payload = hexBytes(b, dataLength, 9)
        seqNr = (b[9 + dataLength] shl 8) or b[9 + dataLength + 1]
        mac = hexBytes(b, 6, 9 + dataLength + 2)
    }
    // Three id bytes, not the four upstream's column headings suggest: the byte before is control byte two.
    val out = data("model" to "Somfy-IOHC", "type" to "Remote", "id" to ((b[5] shl 16) or (b[6] shl 8) or b[7]),
        "dst_id" to ((b[2] shl 16) or (b[3] shl 8) or b[4]), "msg_type" to b[8], "msg" to payload,
        "mode" to if (protocolMode != 0) "One-way" else "Two-way", "version" to (b[1] and 0x03), "flag_end" to ((b[0] and 0x80) shr 7),
        "flag_start" to ((b[0] and 0x40) shr 6), "flag_mode" to protocolMode, "flag_beacon" to ((b[1] and 0x80) shr 7),
        "flag_routed" to ((b[1] and 0x40) shr 6), "flag_lpm" to ((b[1] and 0x20) shr 5), "mic" to "CRC")
    if (protocolMode == 1) { out["counter"] = seqNr; out["mac"] = mac }
    ctx.emit(out)
    return 1
}

internal val HOMEAUTO: List<RDevice> = listOf(
    dev(122, "FS20 / FHT", Mod.OOK_PWM, 400, 600, 9000, disabled = true, bands = BAND_868, what = "home automation switch and radiator valve", decode = ::fs20),
    dev(187, "RojaFlex shutter and remote devices", Mod.FSK_PCM, 100, 100, 102400, bands = BAND_433, what = "roller shutter remote", decode = ::rojaflex),
    // UART framing gives at most nine zeros in a row.
    dev(189, "Somfy io-homecontrol", Mod.FSK_PCM, 26, 26, 300, bands = BAND_868_9, what = "blind and shutter remote", decode = ::somfyIohc),
)
