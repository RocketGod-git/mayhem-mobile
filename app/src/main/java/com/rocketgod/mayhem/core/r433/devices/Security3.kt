package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Alarm sensors and oddities: Kerui, a generic motion kit, X10 Security, SimpliSafe (first and third generation),
 * Honeywell ActivLink, the Amazon Basics meat thermometer and CTT wildlife tags.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): kerui.c, generic_motion.c, x10_sec.c, simplisafe.c, honeywell_wdb.c,
 * abmt.c, simplisafe_gen3.c, ctt_motus.c. Twin of web/src/dsp/r433/devices/security3.ts.
 */

private val BAND_433 = listOf(433_920_000L)

private val KERUI_STATE = mapOf(0xa to "motion", 0xe to "open", 0x7 to "close", 0xb to "tamper", 0x5 to "water", 0xf to "battery")

/** No checksum: nine of twenty-five copies agreeing is the whole defense. Inverted, after an all-zero test. */
private fun kerui(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(9, 25)
    if (row < 0) return DECODE_ABORT_LENGTH
    if (bits.bitsPerRow[row] != 25) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    if (b[0] == 0 && b[1] == 0 && b[2] == 0) return DECODE_FAIL_SANITY
    b[0] = b[0].inv(); b[1] = b[1].inv(); b[2] = b[2].inv()
    val cmd = b[2] and 0x0f
    val state = KERUI_STATE[cmd] ?: return DECODE_ABORT_EARLY
    val out = data("model" to "Kerui-Security", "type" to "Security", "id" to ((b[0] shl 12) or (b[1] shl 4) or (b[2] shr 4)), "cmd" to cmd, "state" to state)
    // Each code speaks to one field only, as upstream reports it.
    when (cmd) { 0xa -> out["motion"] = 1; 0xe -> out["opened"] = 1; 0x7 -> out["opened"] = 0; 0xb -> out["tamper"] = 1; 0x5 -> out["water"] = 1; 0xf -> out["battery_ok"] = 0 }
    ctx.emit(out)
    return 1
}

/** The raw twenty-bit code only; upstream's notes list some values but nothing documents the command set. */
private fun genericMotion(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    for (i in 0 until bits.numRows) {
        val b = bits.bb[i]
        if (bits.bitsPerRow[i] != 20 || (b[1] == 0 && b[2] == 0) || (b[1] == 0xff && b[2] == 0xf0) || bits.countRepeats(i, 0) < 3) continue
        ctx.emit(data("model" to "Generic-Motion", "type" to "Security", "code" to hexOf((b[0] shl 12) or (b[1] shl 4) or (b[2] shr 4), 5)))
        return 1
    }
    return DECODE_ABORT_EARLY
}

private val X10_SEC_EVENT = mapOf(
    0x00 to "DOOR/WINDOW OPEN", 0x04 to "DOOR/WINDOW OPEN", 0x40 to "DOOR/WINDOW OPEN", 0x44 to "DOOR/WINDOW OPEN",
    0x80 to "DOOR/WINDOW CLOSED", 0x84 to "DOOR/WINDOW CLOSED", 0xc0 to "DOOR/WINDOW CLOSED", 0xc4 to "DOOR/WINDOW CLOSED",
    0x0c to "MOTION TRIPPED", 0x4c to "MOTION TRIPPED", 0x8c to "MOTION READY", 0xcc to "MOTION READY",
    0x06 to "KEY-FOB ARM", 0x26 to "KR18 PANIC", 0x42 to "KEY-FOB LIGHTS A ON", 0x46 to "KEY-FOB LIGHTS B ON",
    0x82 to "SH624 SEC-REMOTE DISARM", 0x86 to "KEY-FOB DISARM", 0x88 to "KR15 PANIC", 0x98 to "KR15 PANIC-3SECOND",
    0xc2 to "KEY-FOB LIGHTS A OFF", 0xc6 to "KEY-FOB LIGHTS B OFF",
)
/** Codes whose bit 6 is a tamper flag rather than part of the command. */
private val X10_SEC_TAMPER_CODES = setOf(0x00, 0x04, 0x40, 0x44, 0x80, 0x84, 0xc0, 0xc4, 0x0c, 0x4c, 0x8c, 0xcc)
/** The door and window codes, the only ones carrying the delay setting. */
private val X10_SEC_DELAY_CODES = setOf(0x00, 0x04, 0x40, 0x44, 0x80, 0x84, 0xc0, 0xc4)

/**
 * NEC-shaped: byte two is byte one with its low nibble complemented, byte four byte three complemented, and one
 * parity bit closes it. Upstream labels that CRC; mirrored so the two agree. Unknown events are reported as such.
 */
private fun x10Sec(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 2) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[1] < 41) return DECODE_ABORT_LENGTH
    val b = bits.bb[1]
    if ((b[0] xor b[1]) != 0x0f || (b[2] xor b[3]) != 0xff) return DECODE_FAIL_SANITY
    var parity = b[0] xor b[1] xor b[2] xor b[3] xor b[4] xor (b[5] and 0x80)
    parity = (parity shr 4) xor (parity and 0x0f)
    parity = (parity shr 2) xor (parity and 0x03)
    parity = (parity shr 1) xor (parity and 0x01)
    if (parity != 0) return DECODE_FAIL_MIC
    val code = b[2] and 0xfe
    val tamper = if (code in X10_SEC_TAMPER_CODES) (b[2] and 0x40) shr 6 else 0
    // Reads backwards: the bit set means the minimum delay.
    val delay = if (code in X10_SEC_DELAY_CODES) (if ((b[2] and 0x04) != 0) 0 else 1) else 0
    val out = data("model" to "X10-Security", "type" to "Security",
        "id" to hexOf(b[0]) + hexOf(b[4]),               // the identity's halves sit at opposite ends
        "code" to hexOf(b[2]), "event" to (X10_SEC_EVENT[code] ?: "UNKNOWN"), "mic" to "CRC")
    if (delay != 0) out["delay"] = delay
    if ((b[2] and 0x01) != 0) out["battery_ok"] = 0
    if (tamper != 0) out["tamper"] = tamper
    ctx.emit(out)
    return 1
}

/** Five printable characters sent LSB first; anything unprintable is replaced, a sign of uncaught damage. */
private fun ssGetId(b: UBytes): String {
    val sb = StringBuilder()
    for (k in 3..7) { val c = reverse8(b[k]); sb.append(if (c < 32 || c > 126) '?' else c.toChar()) }
    return sb.toString()
}

private val SS_SENSOR_STATE = mapOf(1 to "Contact Open", 2 to "Contact Closed", 3 to "Alarm Off")
private val SS_KEYPAD_COMMAND = mapOf(0x6a to "Arm System - Away", 0xca to "Arm System - Home", 0x3a to "Arm System - Canceled",
    0x2a to "Keypad Panic Button", 0x86 to "Keypad Menu Button")

/** The only one of the three messages with a check: sequence plus state. */
private fun ssSensorParser(bits: BitBuffer, ctx: DecodeCtx, row: Int): Int {
    if (bits.bitsPerRow[row] != 92) return DECODE_ABORT_LENGTH
    val b = bits.bb[row]
    val seq = reverse8(b[8]); val state = reverse8(b[9])
    if (((seq + state) and 0xff) != reverse8(b[10])) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "SimpliSafe-Sensor", "type" to "Security", "id" to ssGetId(b), "seq" to seq, "state" to state,
        "extradata" to (SS_SENSOR_STATE[state] ?: ""), "mic" to "CHECKSUM"))
    return 1
}

/**
 * The disarm PIN travels in clear, low nibble first. The sequence goes out unreversed here, unlike the sensor
 * parser; upstream's, kept so readings compare directly.
 */
private fun ssPinentryParser(bits: BitBuffer, ctx: DecodeCtx, row: Int): Int {
    val b = bits.bb[row]
    val pina = reverse8(b[10]); val pinb = reverse8(b[11])
    val pin = listOf(pina and 0x0f, (pina and 0xf0) shr 4, pinb and 0x0f, (pinb and 0xf0) shr 4).joinToString("") { Integer.toHexString(it) }
    ctx.emit(data("model" to "SimpliSafe-Keypad", "type" to "Security", "id" to ssGetId(b), "seq" to b[9], "extradata" to "Disarm Pin: $pin"))
    return 1
}

private fun ssKeypadCommands(bits: BitBuffer, ctx: DecodeCtx, row: Int): Int {
    val b = bits.bb[row]
    ctx.emit(data("model" to "SimpliSafe-Keypad", "type" to "Security", "id" to ssGetId(b), "seq" to b[9],
        "extradata" to (SS_KEYPAD_COMMAND[b[10]] ?: "Unknown Keypad: ${hexOf(b[10])}")))
    return 1
}

/** Inverted on the air, so the sync is matched as `cc 5f`; a type byte picks one of three payloads. */
private fun ssSensor(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 90)
    if (row < 0) return DECODE_ABORT_EARLY
    val b = bits.bb[row]
    if (b[0] != 0xcc || b[1] != 0x5f) return DECODE_ABORT_EARLY
    bits.invert()
    return when (b[2]) {
        0x88 -> ssSensorParser(bits, ctx, row)
        0x66 -> ssPinentryParser(bits, ctx, row)
        0x44 -> ssKeypadCommands(bits, ctx, row)
        else -> DECODE_ABORT_EARLY
    }
}

private val HONEYWELL_WDB_CLASS = mapOf(0x1 to "PIR-Motion", 0x2 to "Doorbell", 0x5 to "Contact")
private val HONEYWELL_WDB_ALERT = mapOf(0x0 to "Normal", 0x1 to "High", 0x2 to "High", 0x3 to "Full")

/**
 * One bit means "secret knock" on a doorbell and "case opened" on a contact, so the class is read first. Two
 * separate open and closed bits allow "unknown" (-1), which is how a tamper arrives. One parity bit and four
 * agreeing copies; the all-zero test runs before the parity, as upstream orders them.
 */
private fun honeywellWdb(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(4, 48)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] != 48) return DECODE_ABORT_LENGTH
    bits.invert()
    val b = bits.bb[row]
    val parity = parityBytes(b, 6)
    if ((b[0] == 0 && b[2] == 0 && b[4] == 0 && b[5] == 0) || (b[0] == 0xff && b[2] == 0xff && b[4] == 0xff && b[5] == 0xff)) return DECODE_FAIL_SANITY
    if (parity != 0) return DECODE_FAIL_MIC
    val type = (b[3] and 0x70) shr 4
    val bit = (b[5] and 0x10) shr 4
    val opened = (b[5] and 0x20) shr 5
    val closed = (b[5] and 0x40) shr 6
    val open = if (opened != 0 && closed == 0) 1 else if (opened == 0 && closed != 0) 0 else -1
    ctx.emit(data("model" to "Honeywell-ActivLink", "type" to "Security", "subtype" to (HONEYWELL_WDB_CLASS[type] ?: "Unknown"),
        "id" to ((b[0] shl 12) or (b[1] shl 4) or (b[2] shr 4)), "battery_ok" to if (((b[5] and 0x02) shr 1) != 0) 0 else 1,
        "alert" to (HONEYWELL_WDB_ALERT[b[4] and 0x03] ?: "Unknown"), "secret_knock" to if (type == 0x5) 0 else bit, "open" to open,
        "tampered" to if (type == 0x5) bit else 0,
        "relay" to ((b[5] and 0x08) shr 3),              // one unit repeating another's transmission
        "mic" to "PARITY"))
    return 1
}

private fun bcd2int(bcd: Int) = 10 * (bcd shr 4) + (bcd and 0x0f)

private val ABMT_SYNC = UBytes.of(0x55, 0xaa, 0xaa)

/**
 * The "sync" is the frame's own constant tail seen through Manchester, so the frame starts 72 bits before it.
 * No checksum: four agreeing copies and that tail are the only defense.
 */
private fun abmt(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(4, 90)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 120) return DECODE_ABORT_LENGTH
    val at = bits.search(row, 0, ABMT_SYNC, 24)
    if (at == bits.bitsPerRow[row] || at < 72) return DECODE_FAIL_SANITY
    val packet = BitBuffer()
    bits.manchesterDecode(row, at - 72, packet, 48)
    packet.invert()
    val b = packet.bb[0]
    ctx.emit(data("model" to "Basics-Meat", "id" to b[0],      // picked afresh at every power-on
        "temperature_C" to bcd2int(b[3]) * 10 + bcd2int(b[4] shr 4)))
    return 1
}

private val SS3_PREAMBLE = UBytes.of(0x93, 0x0b, 0x51, 0xde)
/** 21 for arming, 22 for a sensor, 24 for disarming. */
private val SS3_LENGTHS = setOf(0x15, 0x16, 0x18)

/**
 * A CMAC and an encrypted body behind a rolling counter; none of it is broken here. The length is validated
 * first, because it decides the CRC's span.
 */
private fun simplisafeGen3(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val bitpos = bits.search(0, 0, SS3_PREAMBLE, 32) + 32
    if (bitpos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    if (bitpos + 24 * 8 > bits.bitsPerRow[0]) return DECODE_ABORT_LENGTH
    val b = bits.bytes(0, bitpos, 27 * 8)
    if (b[0] !in SS3_LENGTHS) return DECODE_ABORT_EARLY
    val len = b[0]
    if (crc16(b, len + 3, 0x8005, 0xffff) != 0) return DECODE_FAIL_MIC
    ctx.emit(data("model" to "SimpliSafe-Gen3", "type" to "Security", "id" to hexOf(u32be(b, 2), 8), "msg_type" to hexOf(b[1]),
        "ctr" to hexOf((b[8] shl 16) or (b[7] shl 8) or b[6], 6),   // the counter alone is little endian
        "cmac" to hexOf(u32be(b, 9), 8), "encr" to hexBytes(b, len - 12, 13), "mic" to "CRC"))
    return 1
}

private val CTT_SYNC = UBytes.of(0xd3, 0x91)
/** The thirty-two Motus code bytes: five bits spread over eight so any two differ in several places. */
private val CTT_MOTUS_CODE = setOf(0x00, 0x07, 0x19, 0x1e, 0x2a, 0x2d, 0x33, 0x34, 0x4b, 0x4c, 0x52, 0x55, 0x61, 0x66, 0x78, 0x7f,
    0x80, 0x87, 0x99, 0x9e, 0xaa, 0xad, 0xb3, 0xb4, 0xcb, 0xcc, 0xd2, 0xd5, 0xe1, 0xe6, 0xf8, 0xff)

/**
 * A sub-gram tag on a migrating bird. `valid_motus` says the id came from the Motus dictionary; failing it is a
 * tag outside that project, not a bad decode. Every good row is reported; a burst of only bad CRCs says so.
 */
private fun ctt(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var events = 0
    var sawBadCrc = false
    for (row in 0 until bits.numRows) {
        if (bits.bitsPerRow[row] < 56) continue
        val at = bits.search(row, 0, CTT_SYNC, 16)
        if (at >= bits.bitsPerRow[row]) continue
        if (at + 16 + 40 > bits.bitsPerRow[row]) continue
        val p = bits.bytes(row, at + 16, 40)
        if (crc8(p, 4, 0x07, 0x00) != p[4]) { sawBadCrc = true; continue }
        ctx.emit(data("model" to "CTT-Tag", "id" to u32be(p, 0),
            "valid_motus" to if ((0 until 4).all { p[it] in CTT_MOTUS_CODE }) 1 else 0, "mic" to "CRC"))
        events++
    }
    return if (events > 0) events else if (sawBadCrc) DECODE_FAIL_MIC else 0
}

private const val WDB = "wireless doorbell, PIR motion sensor and door contact"

internal val SECURITY3: List<RDevice> = listOf(
    dev(68, "Kerui PIR / Contact Sensor", Mod.OOK_PWM, 420, 960, 9900, gapLimit = 1100, tolerance = 160, bands = BAND_433,
        what = "alarm motion, door contact and water leak sensors", decode = ::kerui),
    // Pulse widths alternate between two packet forms; upstream names 433.3 MHz specifically.
    dev(87, "Generic wireless motion sensor", Mod.OOK_PWM, 888, (1332 + 1784) / 2.0, 2724 * 1.5, gapLimit = 1200, syncWidth = 1784 + 670,
        bands = listOf(433_300_000L), what = "alarm motion sensor and panel", decode = ::genericMotion),
    // American sensors at 310.558 MHz, European ones at 433.92.
    dev(99, "X10 Security", Mod.OOK_PPM, 562, 1687, 6000, gapLimit = 2200, bands = listOf(310_558_000L, 433_920_000L),
        what = "alarm door and window contacts, motion sensors and keyfobs", decode = ::x10Sec),
    dev(102, "SimpliSafe Home Security System (May require disabling automatic gain for KeyPad decodes)", Mod.OOK_PIWM_DC, 500, 1000, 2200,
        tolerance = 100, bands = BAND_433, what = "alarm sensors and keypad, first generation", decode = ::ssSensor),
    dev(115, "Honeywell ActivLink, Wireless Doorbell", Mod.OOK_PWM, 175, 340, 5000, syncWidth = 500, bands = BAND_433, what = WDB, decode = ::honeywellWdb),
    dev(116, "Honeywell ActivLink, Wireless Doorbell (FSK)", Mod.FSK_PWM, 160, 320, 560, syncWidth = 500, bands = BAND_433, what = WDB, decode = ::honeywellWdb),
    dev(181, "Amazon Basics Meat Thermometer", Mod.OOK_PCM, 550, 550, 5000, gapLimit = 2000, bands = BAND_433, what = "cooking thermometer", decode = ::abmt),
    dev(209, "SimpliSafe Gen 3 Home Security System", Mod.FSK_PCM, 208, 208, 7000, bands = listOf(433_900_000L),
        what = "alarm sensors, keypad and panel, third generation", decode = ::simplisafeGen3),
    dev(320, "Cellular Tracking Technologies LifeTag/PowerTag/HybridTag", Mod.FSK_PCM, 40, 40, 500, bands = listOf(434_000_000L),
        what = "wildlife tracking tag", decode = ::ctt),
)
