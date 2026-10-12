package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Alarm sensors: Visonic PowerCode, Yale HSA, Kidde interconnect smoke alarms, Cavius alarms and door sensor,
 * and the Risco Agility motion detector.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): visonic_powercode.c, yale_hsa.c, kidde_rf_sm_dc.c, cavius.c,
 * cavius_door.c, risco_agility.c. Twin of web/src/dsp/r433/devices/security2.ts.
 */

private val B433 = listOf(433_920_000L)

/** The check runs down the frame: nibbles xored column by column, which catches a whole nibble arriving wrong. */
private fun visonic(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 37)
    if (row < 0) return DECODE_ABORT_LENGTH
    if (bits.bitsPerRow[row] != 37) return DECODE_ABORT_LENGTH
    val msg = bits.bytes(row, 1, 36)
    if (msg[0] == 0 && msg[1] == 0 && msg[2] == 0 && msg[3] == 0 && msg[4] == 0) return DECODE_FAIL_SANITY
    val lrc = xorBytes(msg, 5)
    if (((lrc shr 4) xor (lrc and 0x0f)) != 0) return DECODE_FAIL_MIC
    val f = msg[3]
    fun bit(m: Int) = if ((f and m) != 0) 1 else 0
    ctx.emit(data("model" to "Visonic-Powercode", "type" to "Security", "id" to hexBytes(msg, 3),
        "tamper" to bit(0x80),                           // the case has been opened
        "alarm" to bit(0x40), "battery_ok" to 1 - bit(0x20), "else" to bit(0x10),
        "restore" to bit(0x08),                          // whatever tripped has gone back to normal
        "supervised" to bit(0x04),                       // the routine check-in, not an event
        "spidernet" to bit(0x02), "repeater" to bit(0x01), "mic" to "CHECKSUM"))
    return 1
}

/**
 * One message across six one-byte packets, with an end flag on exactly the sixth. On any failure the decoder
 * walks on to the next end flag and starts again, which is how it recovers from a missed packet.
 */
private fun yaleHsa(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows < 6) return DECODE_ABORT_EARLY
    val msg = UBytes(6)
    var row = 0
    while (row < bits.numRows) {
        var ok = false
        var i = 0
        while (i < 6 && row < bits.numRows) {
            if (bits.bitsPerRow[row] != 13) break
            val b = bits.bb[row]
            if ((b[0] and 0xf0) != 0x50) break
            val eom = b[0] and 0x08
            if ((i < 5 && eom != 0) || (i == 5 && eom == 0)) break
            msg[i] = bits.bytes(row, 5, 8)[0]
            if (i == 5) ok = true
            i++; row++
        }
        if (!ok) {
            while (row < bits.numRows && (bits.bb[row][0] and 0x08) == 0) row++
            row++
            continue
        }
        if ((addBytes(msg, 6) and 0xff) != 0) continue
        ctx.emit(data("model" to "Yale-HSA", "type" to "Security", "id" to hexOf((msg[0] shl 8) or msg[1], 4),
            "stype" to hexOf(msg[2]),                    // ac and ad are contacts, 15 a motion detector
            "state" to hexOf(msg[3]),
            "event" to hexOf(msg[4]),                    // 1 triggered, 3 being paired, 4 tampered with
            "mic" to "CHECKSUM"))
        return 1
    }
    return 0
}

private val KIDDE_ANCHOR = UBytes.of(0x7f)

/**
 * Only the installer's eight DIP switches, sent twice with one bit flipped: an echo, not a checksum. Repeats
 * arrive too far apart to be demanded together, and a lead-in that is not differential Manchester stops a
 * decode partway, so the decode is retried from wherever the last attempt stopped.
 */
private fun kidde(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1 || bits.bitsPerRow[0] < 25 * 2) return DECODE_ABORT_LENGTH
    val rowLen = bits.bitsPerRow[0]
    var start = 0
    while (start < rowLen) {
        val decoded = BitBuffer()
        val next = bits.differentialManchesterDecode(0, start, decoded, 0)
        val len = decoded.bitsPerRow[0]
        start = if (next > start) next else start + 1
        if (len < 25) continue
        val b = decoded.bb[0]
        var from = 9
        while (from + 16 <= len) {
            val pos = decoded.search(0, from, KIDDE_ANCHOR, 8)
            if (pos + 16 > len) break
            from = pos + 1
            if (pos < 9) continue
            if (bitAt(b, pos - 9) != 0) continue
            var idRefl = 0; var echo = 0
            for (i in 0 until 8) idRefl = (idRefl shl 1) or bitAt(b, pos - 8 + i)
            for (i in 0 until 8) echo = (echo shl 1) or bitAt(b, pos + 8 + i)
            if (echo != (idRefl xor 0x80)) continue
            ctx.emit(data("model" to "Kidde-Smoke", "type" to "Security", "id" to hexOf(reverse8(idRefl))))
            return 1
        }
    }
    return DECODE_FAIL_SANITY
}

private val CAVIUS_MESSAGE = mapOf(0x80 to "Pairing", 0x40 to "Test alarm", 0x20 to "Fire alarm", 0x10 to "Warning/Water detected", 0x04 to "Alarm muted")

/** A network of alarms that sound together; each message names the network's master and the detector that started it. */
private fun cavius(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    // The chips are configured with 'Cavi' as their sync word, which is literally what this is.
    val at = bits.search(0, 0, UBytes.of(0x43, 0x61, 0x76, 0x69), 32)
    if (at + 22 * 8 >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val packet = BitBuffer()
    bits.manchesterDecode(0, at + 32, packet, 11 * 8)
    packet.invert()
    if (packet.bitsPerRow[0] < 11 * 8) return DECODE_FAIL_SANITY
    val b = packet.bb[0]
    if (crc8le(b, 7, 0x31, 0x00) != 0) return DECODE_FAIL_MIC
    val batteryLow = (b[4] and 0x08) != 0
    val message = b[4] and 0x08.inv()
    ctx.emit(data("model" to "Cavius-Security", "type" to "Security", "id" to u32be(b, 7), "battery_ok" to if (batteryLow) 0 else 1,
        "net_id" to u32be(b, 0), "message" to message,
        "text" to (CAVIUS_MESSAGE[message] ?: if (batteryLow) "Battery low" else "Unknown"), "mic" to "CRC"))
    return 1
}

/** A different protocol under the same name: no Manchester, a six-byte identity, a plain CRC. */
private fun caviusDoor(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val rowLen = bits.bitsPerRow[0]
    val at = bits.search(0, 0, UBytes.of(0xaa, 0xaa, 0xaa, 0xd3, 0x15, 0x27), 48)
    if (at >= rowLen) return DECODE_ABORT_EARLY
    if (at + 48 + 9 * 8 > rowLen) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, at + 48, 9 * 8)
    if (crc8(b, 8, 0x07, 0x00) != b[8]) return DECODE_FAIL_MIC
    val state = when (b[7]) { 0x25 -> "open"; 0x24 -> "closed"; else -> return DECODE_FAIL_SANITY }
    ctx.emit(data("model" to "Cavius-Door", "type" to "Security", "id" to hexBytes(b, 6, 1), "state" to state, "counter" to b[0], "mic" to "CRC"))
    return 1
}

/** Undo a Gray code: each bit is the running xor of everything above it. */
private fun grayDecode(n0: Int): Int { var n = n0; var p = n; while (true) { n = n shr 1; if (n == 0) break; p = p xor n }; return p }

/**
 * Differential Manchester, then every byte bit-reversed, then Gray-coded fields: nothing secret, but nothing
 * legible until all three come off. The identity is read before the reversal; upstream notes it does not match
 * the printed number, so that ordering is unsettled.
 */
private fun risco(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val pos = bits.search(0, 0, UBytes.of(0x55, 0x5a), 16)
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val decoded = BitBuffer()
    bits.differentialManchesterDecode(0, pos + 16, decoded, 16 * 8)
    if (decoded.bitsPerRow[0] < 16 * 8) return DECODE_ABORT_LENGTH
    val b = decoded.bb[0]
    if (crc16(b, 16, 0x8005, 0x8181) != 0) return DECODE_FAIL_MIC
    // The longer frame this family also sends has not been worked out, so it is left alone.
    if (((b[0] shl 8) or b[1]) != 0xff60) return DECODE_ABORT_LENGTH
    val id = (b[6] shl 16) or (b[7] shl 8) or b[8]
    reflectBytes(b, 16)
    val state = grayDecode(b[12] and 0x0f)
    val lowBatt = (grayDecode((b[12] and 0xf0) shr 4) and 0x08) shr 3
    val out = data("model" to "Risco-RWX95P", "type" to "Security", "id" to id, "counter" to grayDecode((b[5] shl 8) or b[4]),
        "battery_ok" to if (lowBatt != 0) 0 else 1, "mic" to "CRC")
    if (((state and 0x04) shr 2) != 0) out["tamper"] = 1     // the case has been opened
    if (((state and 0x02) shr 1) != 0) out["motion"] = 1
    ctx.emit(out)
    return 1
}

internal val SECURITY2: List<RDevice> = listOf(
    dev(151, "Visonic powercode", Mod.OOK_PWM, 400, 800, 5000, gapLimit = 900, bands = B433, what = "alarm door and window sensor", decode = ::visonic),
    dev(210, "Yale HSA (Home Security Alarm), YES-Alarmkit", Mod.OOK_PWM, 850, 1460, 1500, syncWidth = 5380, bands = B433,
        what = "alarm sensor: door, motion, keypad and keyfob", decode = ::yaleHsa),
    dev(361, "Kidde RF-SM-DC wireless-interconnect smoke alarm", Mod.OOK_PCM, 400, 400, 3000, disabled = true, bands = B433,
        what = "smoke and carbon monoxide alarm", decode = ::kidde),
    dev(179, "Cavius smoke, heat and water detector", Mod.FSK_PCM, 206, 206, 1000, gapLimit = 1000, syncWidth = 2700,
        bands = listOf(869_670_000L), what = "smoke, heat and water alarm", decode = ::cavius),
    dev(368, "Cavius Door/Window sensor", Mod.FSK_PCM, 415, 415, 3000, bands = listOf(868_700_000L), what = "alarm door and window sensor", decode = ::caviusDoor),
    dev(266, "Risco 2 Way Agility protocol, Risco PIR/PET Sensor RWX95P", Mod.OOK_PCM, 175, 175, 1000, bands = B433,
        what = "alarm motion detector", decode = ::risco),
)
