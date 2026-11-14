package com.rocketgod.mayhem.core.apps.ism

/**
 * Proteco MOVER gate remotes (Italy), 433.92 MHz AM, 24-bit fixed code (Flipper Unleashed
 * lib/subghz/protocols/proteco.c). CAME line coding at Te ~440 us: guard LOW ~20.5 Te, start HIGH Te, then bit 1 =
 * LOW 2Te + HIGH Te, bit 0 = LOW Te + HIGH 2Te, MSB first. The guard must be 18.5..22.5 of the frame's own mean Te.
 * Low 2 bits are the button. Receive only.
 */
class SProteco : FProto(Fam.REMOTE, S.PROTECO) {
    private var rx = 0L
    /** Sum of the frame's pulses (start bit included). */
    private var te = 0
    /** The LOW that opened the frame. */
    private var guard = 0
    init { teShort = 440; teLong = 880; teDelta = 150; minCountBitForFound = 24 }

    private fun guardOk(): Boolean {
        // start bit plus 3 Te per bit
        val t = te / (decodeCountBit * 3 + 1)
        return guard >= t * GUARD_TE_X2_MIN / 2 && guard <= t * GUARD_TE_X2_MAX / 2
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && duration >= teShort * 4) { guard = duration; parserStep = STEP_FOUND_START_BIT }
            STEP_FOUND_START_BIT -> if (level && dd(duration, teShort) < teDelta) {
                decodeData = 0; decodeCountBit = 0; te = duration; parserStep = STEP_SAVE_DURATION
            } else parserStep = STEP_RESET
            STEP_SAVE_DURATION -> {
                if (level) { parserStep = STEP_RESET; return }
                if (duration >= teShort * 4) {
                    // This gap ends the frame and is the next frame's guard.
                    if (decodeCountBit == minCountBitForFound && guardOk()) {
                        dataCountBit = decodeCountBit; rx = decodeData
                        hit()
                    }
                    guard = duration
                    parserStep = STEP_FOUND_START_BIT
                    return
                }
                teLast = duration; te += duration; parserStep = STEP_CHECK_DURATION
            }
            STEP_CHECK_DURATION -> {
                if (level && dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); te += duration; parserStep = STEP_SAVE_DURATION }
                else if (level && dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); te += duration; parserStep = STEP_SAVE_DURATION }
                else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        return RemoteInfo(RemoteFields.name(sensorType), (rx ushr 2) and 0x3FFFFFL, BTN[(rx and 0x3L).toInt()], null, emptyList())
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_FOUND_START_BIT = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3
        private const val GUARD_TE_X2_MIN = 37; private const val GUARD_TE_X2_MAX = 45
        private val BTN = intArrayOf(0x2, 0x3, 0x1, 0x4)
    }
}
