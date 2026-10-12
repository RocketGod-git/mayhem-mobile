package com.rocketgod.mayhem.core.apps.ism

/** Holtek remotes (Mayhem fprotos/s-holtek.hpp). */
class SHoltek : FProto(Fam.REMOTE, S.HOLTEK) {
    init { teShort = 430; teLong = 870; teDelta = 100; minCountBitForFound = 40 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 36) < teDelta * 36) parserStep = STEP_FOUND_START_BIT
            STEP_FOUND_START_BIT -> {
                if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_SAVE_DURATION; decodeData = 0; decodeCountBit = 0 }
                else parserStep = STEP_RESET
            }
            STEP_SAVE_DURATION -> {
                if (!level) {
                    if (duration >= teShort * 10 + teDelta) {
                        if (decodeCountBit == minCountBitForFound) {
                            if ((decodeData and HEADER_MASK) == HEADER) { dataCountBit = decodeCountBit; hit() }
                        }
                        decodeData = 0; decodeCountBit = 0
                        parserStep = STEP_FOUND_START_BIT
                        return
                    } else { teLast = duration; parserStep = STEP_CHECK_DURATION }
                } else parserStep = STEP_RESET
            }
            STEP_CHECK_DURATION -> {
                if (level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 2) { addBit(0); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teLong) < teDelta * 2 && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_FOUND_START_BIT = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3
        private const val HEADER_MASK = 0xF000000000L; private const val HEADER = 0x5000000000L
    }
}
