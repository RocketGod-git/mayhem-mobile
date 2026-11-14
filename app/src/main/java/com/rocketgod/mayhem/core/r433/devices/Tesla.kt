package com.rocketgod.mayhem.core.r433.devices

import com.rocketgod.mayhem.core.r433.*

/*
 * Tesla charge port opener: the button on a Tesla charge cable that opens a closed charge port door.
 * Not an rtl_433 protocol, so it carries a number of its own (1000 and up are this app's). Receive only.
 *
 * Public signal (fredilarsen/TeslaChargeDoorOpener): OOK at 400 us per bit, 315 MHz (North America) or 433.92 MHz.
 * One press sends the same message five times, 23 ms apart: a 26-bit 1010 run-in, then three copies of one frame,
 * each after a 1.2 ms silence: a start bit and 49 Manchester bits. Every cable sends the same fixed code, with no
 * ID, counter or checksum, so the whole frame is matched rather than parsed.
 * Twin of web/src/dsp/r433/devices/tesla.ts.
 */

/** The 49 Manchester bits of one frame, with a 1-0 half-bit pair read as 1. */
const val TESLA_CHARGE_PORT_CODE = "0010010100101010101001101100111000110110100001100"
private val TESLA_FRAME_BITS = 1 + 2 * TESLA_CHARGE_PORT_CODE.length

private fun teslaBit(bits: BitBuffer, row: Int, i: Int) = (bits.bb[row][i shr 3] shr (7 - (i and 7))) and 1

/** True when a start bit at `at` is followed by the whole code, every half-bit pair a clean 10 or 01. */
private fun teslaFrameAt(bits: BitBuffer, row: Int, at: Int): Boolean {
    if (teslaBit(bits, row, at) != 1) return false
    for (k in TESLA_CHARGE_PORT_CODE.indices) {
        val a = teslaBit(bits, row, at + 1 + 2 * k); val b = teslaBit(bits, row, at + 2 + 2 * k)
        if (a == b || ('0' + a) != TESLA_CHARGE_PORT_CODE[k]) return false
    }
    return true
}

private fun teslaChargePort(d: RDevice, bits: BitBuffer, ctx: DecodeCtx): Int {
    var frames = 0; var longEnough = false
    for (r in 0 until bits.numRows) {
        val n = bits.bitsPerRow[r]
        if (n < TESLA_FRAME_BITS) continue
        longEnough = true
        for (at in 0..(n - TESLA_FRAME_BITS)) if (teslaFrameAt(bits, r, at)) { frames++; break }
    }
    if (!longEnough) return DECODE_ABORT_LENGTH
    if (frames == 0) return DECODE_ABORT_EARLY
    ctx.emit(data("model" to "Tesla-ChargePort", "command" to "open charge port", "frames" to frames))
    return 1
}

internal val TESLA: List<RDevice> = listOf(
    // the 1.2 ms silence before each frame starts a new row; the five repeats, 23 ms apart, are separate messages
    dev(1001, "Tesla charge port opener", Mod.OOK_PCM, 400, 400, 5000, gapLimit = 1000,
        bands = listOf(315_000_000L, 433_920_000L), what = "Tesla charge port opener", decode = ::teslaChargePort),
)
