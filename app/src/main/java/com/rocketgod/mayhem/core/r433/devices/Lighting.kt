package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * LightwaveRF, Philips AJ3650 and AJ7010 thermometers, GE Color Effects, Quinetic kinetic switches and the
 * Martec MPLCD fan remote.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): lightwave_rf.c, philips_aj3650.c, ge_coloreffects.c, philips_aj7010.c,
 * quinetic.c, martec_mplcd.c. Twin of web/src/dsp/r433/devices/lighting.ts.
 */

private val BAND_433 = listOf(433_920_000L)

/** Sixteen legal byte values, each with exactly two zero bits, so one flipped bit almost always falls outside. */
private val LIGHTWAVE_NIBBLE = IntArray(256) { -1 }.also { t ->
    intArrayOf(0xf6, 0xee, 0xed, 0xeb, 0xde, 0xdd, 0xdb, 0xbe, 0xbd, 0xbb, 0xb7, 0x7e, 0x7d, 0x7b, 0x77, 0x6f).forEachIndexed { n, b -> t[b] = n }
}

/**
 * Seventy-one bits (the seventy-second, a delimiter, is read as the end), turned into ten nibbles in three
 * passes: expand, strip, look up. No checksum, so off upstream.
 */
private fun lightwave(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] != 71 || bits.numRows != 1) return DECODE_ABORT_LENGTH
    bits.invert()
    // Every zero becomes "10": twenty zeros grow seventy-one bits to ninety-one.
    val stuffed = BitBuffer()
    for (n in 0 until bits.bitsPerRow[0]) { stuffed.addBit(1); if (bitAt(bits.bb[0], n) == 0) stuffed.addBit(0) }
    if (stuffed.bitsPerRow[0] != 91) return DECODE_ABORT_LENGTH
    var idx = 0
    if (bitAt(stuffed.bb[0], idx++) == 0) return DECODE_ABORT_EARLY
    val stripped = BitBuffer()
    for (n in 0 until 10) {
        if (bitAt(stuffed.bb[0], idx++) == 0) return DECODE_ABORT_EARLY
        for (m in 0 until 8) stripped.addBit(bitAt(stuffed.bb[0], idx++))
    }
    val nibbles = BitBuffer()
    for (n in 0 until 10) {
        val nibble = LIGHTWAVE_NIBBLE[stripped.bb[0][n]]
        if (nibble < 0) return DECODE_FAIL_SANITY
        for (m in 0 until 4) nibbles.addBit((nibble shr (3 - m)) and 1)
    }
    val b = nibbles.bb[0]
    ctx.emit(data("model" to "Lightwave-RF", "type" to "Remote", "id" to ((b[2] shl 16) or (b[3] shl 8) or b[4]),
        "subunit" to ((b[1] and 0xf0) shr 4), "command" to (b[1] and 0x0f), "parameter" to b[0]))
    return 1
}

/** Wire channel values are not the numbers on the case; anything unrecognized reads as zero. */
private val PHILIPS_CHANNEL = intArrayOf(2, 0, 1, 0, 3)

/** Three copies in one burst, the middle one half a byte out of step, combined by majority: any one may be damaged. */
private fun philipsAj3650(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[0] != 112) return DECODE_ABORT_LENGTH
    val bb = bits.bb[0]
    if ((bb[0] shr 4) != 0x0) return DECODE_ABORT_EARLY
    val packet = UBytes(4)
    for (i in 0 until 4) {
        val a = bb[i + 1]
        val b = ((bb[i + 5] shl 4) or ((bb[i + 6] shr 4) and 0x0f)) and 0xff
        val c = bb[i + 10]
        packet[i] = (a and b) or (b and c) or (a and c)
    }
    if (crc4(packet, 4, 0x9, 1) != 0) return DECODE_FAIL_MIC
    val wire = packet[0] and 0x0f
    val tempRaw = (packet[1] shl 2) or (packet[2] shr 6)
    ctx.emit(data("model" to "Philips-Temperature", "type" to "Weather", "channel" to if (wire >= PHILIPS_CHANNEL.size) 0 else PHILIPS_CHANNEL[wire],
        "battery_ok" to if ((packet[3] and 0x40) != 0) 0 else 1, "temperature_C" to round1((tempRaw - 500) * 0.1)))
    return 1
}

/** A zero is two bits and a one four; there is no length field, so the decode runs until the pattern breaks. */
private fun geDecodeBits(bits: BitBuffer, start: Int, out: BitBuffer) {
    val row = bits.bb[0]
    val len = bits.bitsPerRow[0]
    var ipos = start
    while (ipos < len) {
        val first = bitAt(row, ipos++); val second = bitAt(row, ipos++)
        if (first == 1 && second == 0) out.addBit(0)
        else if (first == 1 && second == 1) {
            if (bitAt(row, ipos++) == 0 && bitAt(row, ipos++) == 0) out.addBit(1) else break
        } else break
    }
}

private fun geFrame(bits: BitBuffer, start: Int, ctx: DecodeCtx): Int {
    val packet = BitBuffer()
    geDecodeBits(bits, start, packet)
    if (packet.bitsPerRow[0] != 17) return DECODE_ABORT_LENGTH
    val b = packet.bb[0]
    if ((b[0] and 0xc0) != 0) return DECODE_FAIL_SANITY
    if ((b[2] and 0x80) != 0) return DECODE_FAIL_SANITY
    val command = b[1]
    // A code with no known meaning goes out as itself.
    val named = when (command) { 0x5a -> "change"; 0xaa -> "on"; 0x55 -> "off"; else -> "0x" + Integer.toHexString(command) }
    ctx.emit(data("model" to "GE-ColorEffects", "type" to "Remote", "id" to b[0], "command" to named))
    return 1
}

/** The run-in can be sliced a bit short, so four lengths of two patterns are tried in turn. */
private val GE_PATTERNS = listOf(UBytes.of(0xcc, 0xff, 0x00) to 24, UBytes.of(0xcc, 0xff, 0x00) to 23,
    UBytes.of(0xcc, 0xfe, 0x00) to 23, UBytes.of(0xcc, 0xfe, 0x00) to 22)

private fun geColorEffects(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var bitpos = 0; var events = 0; var ret = 0
    while (true) {
        var found = -1
        for ((pattern, len) in GE_PATTERNS) {
            val at = bits.search(0, bitpos, pattern, len) + len
            if (at + 33 <= bits.bitsPerRow[0]) { found = at; break }
        }
        if (found < 0) break
        bitpos = found
        ret = geFrame(bits, bitpos, ctx)
        if (ret > 0) events += ret
        bitpos++
    }
    return if (events > 0) events else ret
}

/**
 * Rejected only when both alternative sums fail, since some transmissions cover the last byte and some do not.
 * Upstream marks its temperature line very likely wrong; five points are too few to fit a better one, so it stands.
 */
private fun philipsAj7010(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    if (bits.numRows != 1) return DECODE_ABORT_LENGTH
    if (bits.bitsPerRow[0] != 40) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    if (b[0] == 0 && b[2] == 0 && b[3] == 0 && b[4] == 0) return DECODE_FAIL_SANITY
    if (b[0] != 0x00) return DECODE_FAIL_SANITY
    if (xorBytes(b, 5) != 0 && (xorBytes(b, 3) xor b[4]) != 0) return DECODE_FAIL_MIC
    val channel = when (b[1]) { 0x36 -> 3; 0x45 -> 2; 0x5a -> 1; else -> 0 }
    val tempRaw = ((b[3] and 0x3f) shl 8) or b[2]
    ctx.emit(data("model" to "Philips-AJ7010", "type" to "Weather", "channel" to channel, "temperature_C" to round1(tempRaw / 353.0 - 9.2), "mic" to "CHECKSUM"))
    return 1
}

/** Self-powered by the press, so no battery field; a release carries no button and is dropped. */
private fun quinetic(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.bitsPerRow[0] < 110 || bits.bitsPerRow[0] > 140) return DECODE_ABORT_LENGTH
    val pos = bits.search(0, 0, UBytes.of(0xa4, 0x23), 16)
    if (pos >= bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
    val b = bits.bytes(0, pos + 16, 40)
    if (crc16(b, 5, 0x1021, 0x1d0f) != 0) return DECODE_FAIL_MIC
    if (b[2] == 192) return DECODE_ABORT_EARLY
    ctx.emit(data("model" to "Quinetic", "type" to "Remote", "id" to hexOf((b[0] shl 8) or b[1], 4), "channel" to b[2], "mic" to "CRC"))
    return 1
}

private val MARTEC_SPEED = listOf("off", "high", "medium", "low")

/**
 * The whole fan setting on every press. Read from the second bit so the checksum's nibbles align; an all-zero
 * payload satisfies four check bits trivially and is refused. The dimmer is stored upside down.
 */
private fun martec(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    val row = bits.findRepeatedRow(2, 22)
    if (row < 0) return DECODE_ABORT_EARLY
    if (bits.bitsPerRow[row] > 22) return DECODE_ABORT_LENGTH
    val bytes = bits.bytes(row, 1, 21)
    if ((addNibbles(bytes, 2) and 0x0f) != ((bytes[2] shr 3) and 0x0f)) return DECODE_FAIL_MIC
    if (bytes[0] == 0 && bytes[1] == 0) return DECODE_FAIL_SANITY
    var dimmer = ((bytes[0] and 0x01) shl 6) + ((bytes[1] shr 2) and 0x3f)
    if (dimmer > 0) dimmer = 42 - dimmer
    ctx.emit(data("model" to "Martec-MPLCD", "type" to "Remote", "id" to reflect4((bytes[0].inv() shr 1) and 0x0f), "dimmer" to dimmer,
        "speed" to MARTEC_SPEED[bytes[1] and 0x03], "mic" to "CHECKSUM"))
    return 1
}

internal val LIGHTING: List<RDevice> = listOf(
    dev(61, "LightwaveRF", Mod.OOK_PPM, 250, 1250, 1500, disabled = true, bands = BAND_433, what = "lighting and socket remote", decode = ::lightwave),
    dev(94, "Philips outdoor temperature sensor (type AJ3650)", Mod.OOK_PWM, 2000, 6000, 30000, bands = BAND_433, what = "thermometer", decode = ::philipsAj3650),
    // Upstream records no frequency for this one.
    dev(98, "GE Color Effects", Mod.FSK_PCM, 52, 52, 450, what = "Christmas light remote", decode = ::geColorEffects),
    dev(135, "Philips outdoor temperature sensor (type AJ7010)", Mod.OOK_PWM, 2000, 6000, 30000, syncWidth = 1000, bands = BAND_433,
        what = "thermometer", decode = ::philipsAj7010),
    // Off upstream: it needs 433.4 MHz at a sample rate this app does not normally run.
    dev(270, "Quinetic", Mod.FSK_PCM, 10, 10, 120, tolerance = 1, disabled = true, bands = listOf(433_300_000L), what = "kinetic wall switch", decode = ::quinetic),
    dev(335, "Martec MPLCD Ceiling Fan Remote", Mod.OOK_PWM, 292, 648, 12000, gapLimit = 850, bands = BAND_433, what = "ceiling fan remote", decode = ::martec),
)
