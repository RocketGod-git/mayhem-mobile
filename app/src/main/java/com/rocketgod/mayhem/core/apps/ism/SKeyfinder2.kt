package com.rocketgod.mayhem.core.apps.ism

/**
 * Keyfinder 2 key finder fobs, 433.92 MHz AM, 11-bit fixed code (Flipper Unleashed lib/subghz/protocols/keyfinder2.c).
 * Frame = button(3) in wide symbols | 10011 | button(3) in narrow symbols, MSB first, repeated back to back with no
 * gap. Receive only.
 */
class SKeyfinder2 : FProto(Fam.REMOTE, S.KEYFINDER2) {
    private var rx = 0L
    init { teShort = 350; teLong = 1020; teDelta = 150; minCountBitForFound = 11 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && (dd(duration, TE_WIDE_SHORT) < TE_WIDE_DELTA || dd(duration, TE_WIDE_LONG) < TE_WIDE_DELTA)) {
                decodeData = 0; decodeCountBit = 0; teLast = duration; parserStep = STEP_CHECK_WIDE
            }
            STEP_SAVE_WIDE -> if (level) { teLast = duration; parserStep = STEP_CHECK_WIDE } else parserStep = STEP_RESET
            STEP_CHECK_WIDE -> {
                if (!level) {
                    if (dd(teLast, TE_WIDE_SHORT) < TE_WIDE_DELTA && dd(duration, TE_WIDE_LONG) < TE_WIDE_DELTA) addBit(1)
                    else if (dd(teLast, TE_WIDE_LONG) < TE_WIDE_DELTA && dd(duration, TE_WIDE_SHORT) < TE_WIDE_DELTA) addBit(0)
                    else { parserStep = STEP_RESET; return }
                    parserStep = if (decodeCountBit == HEADER_BITS) STEP_SAVE_DURATION else STEP_SAVE_WIDE
                } else parserStep = STEP_RESET
            }
            STEP_SAVE_DURATION -> if (level) { teLast = duration; parserStep = STEP_CHECK_DURATION } else parserStep = STEP_RESET
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) addBit(1)
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) addBit(0)
                    else { parserStep = STEP_RESET; return }
                    if (decodeCountBit == minCountBitForFound) {
                        dataCountBit = decodeCountBit; rx = decodeData
                        hit()
                        parserStep = STEP_RESET
                    } else parserStep = STEP_SAVE_DURATION
                } else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val btn = (rx and 0x7L).toInt()
        return RemoteInfo(RemoteFields.name(sensorType), 0L, btn, null, listOf("Color: " + color(btn)))
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_SAVE_WIDE = 1; private const val STEP_CHECK_WIDE = 2
        private const val STEP_SAVE_DURATION = 3; private const val STEP_CHECK_DURATION = 4
        private const val TE_WIDE_SHORT = 1500; private const val TE_WIDE_LONG = 2500; private const val TE_WIDE_DELTA = 350; private const val HEADER_BITS = 3
        /** Color printed on the button for this code (taken from one four-button fob). */
        private fun color(btn: Int): String = when (btn) { 3 -> "Purple"; 4 -> "Blue"; 5 -> "Green"; 6 -> "Red"; else -> "Unknown" }
    }
}
