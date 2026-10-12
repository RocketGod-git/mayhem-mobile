package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Household electricity monitors: Efergy, Current Cost and BlueLine.
 *
 * Ported from rtl_433 (GPL-2.0-or-later): efergy_e2_classic.c, efergy_optical.c, current_cost.c,
 * blueline.c. Twin of web/src/dsp/r433/devices/energy.ts.
 */

/** A raw converter reading plus a negated exponent to scale it by; the display holds the calibration. */
private fun efergyE2(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    if (bits.numRows != 1) return DECODE_ABORT_EARLY
    val n = bits.bitsPerRow[0]
    if (n < 64 || n > 65) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    // Either polarity; the top nibble of the first byte says which.
    if ((b[0] and 0xf0) != 0xf0 && (b[0] and 0xf0) != 0x00) return DECODE_ABORT_EARLY
    if ((b[0] and 0xf0) != 0) for (i in 0 until 8) b[i] = b[i].inv()
    var zeros = 0
    for (i in 0 until 8) if (b[i] == 0) zeros++
    if (zeros + 1 > 5) return DECODE_FAIL_SANITY
    val checksum = addBytes(b, 7)
    if (checksum == 0) return DECODE_FAIL_SANITY
    if ((checksum and 0xff) != b[7]) return DECODE_FAIL_MIC
    val fact = -signed(b[6], 8) + 15
    if (fact < 7 || fact > 23) return DECODE_FAIL_SANITY
    ctx.emit(data("model" to "Efergy-e2CT", "id" to ((b[2] shl 8) or b[1]), "battery_ok" to ((b[3] and 0x40) shr 6),
        "current" to round3(((b[4] shl 8) or b[5]).toDouble() / (1 shl fact)),
        "interval" to (((b[3] and 0x30) shr 4) + 1) * 6, "learn" to if ((b[3] and 0x80) != 0) "YES" else "NO", "mic" to "CHECKSUM"))
    return 1
}

/** The sensor does not send pulses per kWh, so every common calibration is reported; only one is your meter. */
private fun efergyOptical(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var n = bits.bitsPerRow[0]
    if (n < 96 || n > 100) return DECODE_ABORT_LENGTH
    val b = bits.bb[0]
    while ((b[0] and 0xf0) != 0xf0 && (b[0] and 0xf0) != 0x00) {
        n -= 1
        if (n < 96) return DECODE_ABORT_EARLY
        for (i in 0 until ((n + 7) shr 3)) b[i] = ((b[i] shl 1) or ((b[i + 1] and 0x80) shr 7)) and 0xff
    }
    if ((b[0] and 0xf0) != 0) for (i in 0 until 12) b[i] = b[i].inv()
    if (b[8] == 0 && b[9] == 0 && b[10] == 0 && b[11] == 0) return DECODE_FAIL_SANITY
    if (crc16(b, 10, 0x1021, 0x0000) != ((b[10] shl 8) or b[11])) return DECODE_FAIL_MIC
    val id = (b[0] shl 16) or (b[1] shl 8) or b[2]
    val seconds = (((b[3] and 0x30) shr 4) + 1) * 30
    val pulses = b[8]
    for (impKwh in intArrayOf(4000, 3200, 2000, 1000, 500)) {
        ctx.emit(data("model" to "Efergy-Optical", "id" to id, "pulses" to impKwh, "pulsecount" to pulses,
            "energy_kWh" to round3((pulses.toDouble() / impKwh) * (3600.0 / seconds)), "mic" to "CRC"))
    }
    return 1
}

/** Up to three clamps per transmitter; a separate message type carries a gas or water pulse counter. */
private fun currentCost(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    bits.invert()
    val classic = UBytes.of(0xcc, 0xcc, 0xcc, 0xce, 0x91, 0x5d)
    val envir = UBytes.of(0x55, 0x55, 0x55, 0x55, 0xa4, 0x57)
    var isEnvir = false
    var start = bits.search(0, 0, envir, 48)
    if (start + 47 + 112 <= bits.bitsPerRow[0]) {
        isEnvir = true
        start += 47
    } else {
        start = bits.search(0, 0, classic, 45)
        if (start + 45 + 112 > bits.bitsPerRow[0]) return DECODE_ABORT_EARLY
        start += 45
    }
    val packet = BitBuffer()
    bits.manchesterDecode(0, start, packet, 0)
    if (packet.bitsPerRow[0] < 64) return DECODE_ABORT_EARLY
    val b = packet.bb[0]
    fun clamp(hi: Int, lo: Int) = if ((hi and 0x80) != 0) ((hi and 0x7f) shl 8) or lo else 0
    if ((b[0] and 0xf0) == 0) {
        ctx.emit(data("model" to if (isEnvir) "CurrentCost-EnviR" else "CurrentCost-TX", "id" to (((b[0] and 0x0f) shl 8) or b[1]),
            "power0_W" to clamp(b[2], b[3]), "power1_W" to clamp(b[4], b[5]), "power2_W" to clamp(b[6], b[7])))
        return 1
    }
    if ((b[0] and 0xf0) == 0x40) {
        ctx.emit(data("model" to if (isEnvir) "CurrentCost-EnviRCounter" else "CurrentCost-Counter",
            "subtype" to b[3],                           // 2 electric, 3 gas, 4 water
            "id" to (((b[0] and 0x0f) shl 8) or b[1]), "power0" to u32be(b, 4)))
        return 1
    }
    return 0
}

/*
 * BlueLine masks every message but its identity by subtracting the serial number. Rather than wait for an
 * identity message, the CRC is run backwards: for each of the 256 possible high bytes it recovers what the low
 * byte must have been, keeps candidates whose message type agrees, and votes across transmissions until one
 * identity is clearly ahead. The vote persists between bursts.
 */
private const val BLUELINE_ID_STEP = 4
private const val BLUELINE_GUESS_THRESHOLD = 4

/** Run a CRC-8 backwards, recovering the initial value that would produce a known remainder. */
private fun revCrc8(m: UBytes, nBytes: Int, polynomial: Int, remainder: Int): Int {
    if ((polynomial and 0x01) == 0) return 0xff
    val poly = ((polynomial shr 1) or 0x80) and 0xff
    var rem = remainder and 0xff
    for (byte in nBytes - 1 downTo 0) {
        for (bit in 0 until 8) rem = if ((rem and 0x01) != 0) ((rem shr 1) xor poly) and 0xff else rem shr 1
        rem = rem xor m[byte]
    }
    return rem and 0xff
}

private object Blueline {
    var sensorId = 0
    var searching = true
    val votes = IntArray(0x10000 / BLUELINE_ID_STEP)
}

/** Forget the identity worked out for a BlueLine monitor, so a different one can be found. */
internal fun resetBluelineId() = synchronized(Blueline) { Blueline.sensorId = 0; Blueline.searching = true; Blueline.votes.fill(0) }

private fun guessBluelineId(row: UBytes): Int {
    val startValue = (row[2] shl 8) or row[1]
    val recvCrc = row[3]
    val msgType = row[1] and 0x03
    val buf = UBytes.of(0x00, row[2])
    var bestId = 0; var bestHits = 0; var numAtBest = 0
    for (step in 0 until 256) {
        val low = revCrc8(buf, 2, 0x07, recvCrc)
        if ((low and 0x03) == msgType) {
            val value = (startValue - (((buf[1] shl 8) or low) and 0xffff)) and 0xffff
            val slot = value / BLUELINE_ID_STEP
            Blueline.votes[slot] = (Blueline.votes[slot] + 1) and 0xffff
            if (Blueline.votes[slot] >= bestHits) {
                if (Blueline.votes[slot] > bestHits) { bestHits = Blueline.votes[slot]; bestId = value; numAtBest = 1 } else numAtBest++
            }
        }
        buf[1] = (buf[1] + 1) and 0xff
    }
    return if (bestHits >= BLUELINE_GUESS_THRESHOLD && numAtBest == 1) bestId else 0
}

private fun blueline(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int = synchronized(Blueline) {
    bits.invert()
    var decoded = 0
    var failure = 0
    for (row in 0 until bits.numRows) {
        val r = bits.bb[row]
        if (bits.bitsPerRow[row] != 32 || r[0] != 0xfe) {
            if (DECODE_ABORT_LENGTH < failure) failure = DECODE_ABORT_LENGTH
            continue
        }
        val msgType = r[1] and 0x03
        val recvCrc = r[3]
        var payload = 0
        val payloadBytes = UBytes(2)
        val calcCrc: Int
        if (msgType == 0x00) {
            calcCrc = crc8(r, 2, 0x07, 0x00, 1)
        } else {
            payload = (((r[2] shl 8) or r[1]) - Blueline.sensorId) and 0xffff
            payloadBytes[0] = payload and 0xff
            payloadBytes[1] = payload shr 8
            calcCrc = crc8(payloadBytes, 2, 0x07, 0x00)
        }
        if (calcCrc != recvCrc) {
            if (Blueline.searching && msgType != 0x00) {
                val guess = guessBluelineId(r)
                if (guess != 0) { Blueline.sensorId = guess; Blueline.searching = false }
            }
            if (DECODE_FAIL_MIC < failure) failure = DECODE_FAIL_MIC
            continue
        }
        when (msgType) {
            0x00 -> {
                val id = (r[2] shl 8) or r[1]
                ctx.emit(data("model" to "Blueline-PowerCost", "id" to id, "mic" to "CRC"))
                if (Blueline.searching) { Blueline.sensorId = id; Blueline.searching = false }
            }
            // The gap between meter pulses in milliseconds: shorter means more power being drawn.
            0x01 -> ctx.emit(data("model" to "Blueline-PowerCost", "id" to Blueline.sensorId, "gap" to payload, "mic" to "CRC"))
            0x02 -> {
                val flags = payloadBytes[0] shr 2
                ctx.emit(data("model" to "Blueline-PowerCost", "id" to Blueline.sensorId, "flags" to flags,
                    "battery_ok" to if (((flags and 0x20) shr 5) != 0) 0 else 1,
                    "temperature_C" to round1(0.436 * payloadBytes[1] - 30.36), "mic" to "CRC"))
            }
            else -> ctx.emit(data("model" to "Blueline-PowerCost", "id" to Blueline.sensorId, "impulses" to payload, "mic" to "CRC"))
        }
        decoded++
    }
    if (decoded > 0) decoded else failure
}

internal val ENERGY: List<RDevice> = listOf(
    dev(36, "Efergy e2 classic", Mod.FSK_PWM, 64, 136, 400, gapLimit = 200, syncWidth = 500, bands = listOf(433_920_000L),
        what = "clamp-on household electricity monitor", decode = ::efergyE2),
    dev(63, "Efergy optical", Mod.FSK_PWM, 64, 136, 400, syncWidth = 500, bands = listOf(433_920_000L),
        what = "optical head that counts a meter’s pulse lamp", decode = ::efergyOptical),
    dev(44, "CurrentCost current sensor", Mod.FSK_PCM, 250, 250, 8000, bands = listOf(433_920_000L, 868_300_000L),
        what = "household electricity, gas and water monitors", decode = ::currentCost),
    dev(176, "BlueLine Innovations power cost monitor", Mod.OOK_PPM, 500, 1000, 8000, gapLimit = 2000, bands = listOf(433_920_000L),
        what = "optical head on a domestic electricity meter", decode = ::blueline),
)
