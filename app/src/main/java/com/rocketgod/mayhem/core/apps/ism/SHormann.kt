package com.rocketgod.mayhem.core.apps.ism

/** Hormann HSM remotes (Mayhem fprotos/s-hormann.hpp). */
class SHormann : FProto(Fam.REMOTE, S.HORMANN) {
    init { teShort = 500; teLong = 1000; teDelta = 200; minCountBitForFound = 44 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort * 24) < teDelta * 24) parserStep = STEP_FOUND_START_BIT
            STEP_FOUND_START_BIT -> {
                if (!level && dd(duration, teShort) < teDelta) { parserStep = STEP_SAVE_DURATION; decodeData = 0; decodeCountBit = 0 }
                else parserStep = STEP_RESET
            }
            STEP_SAVE_DURATION -> {
                if (level) {
                    if (duration >= teShort * 5 && (decodeData and HSM_PATTERN) == HSM_PATTERN) {
                        parserStep = STEP_FOUND_START_BIT
                        if (decodeCountBit >= minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        return
                    }
                    teLast = duration
                    parserStep = STEP_CHECK_DURATION
                } else parserStep = STEP_RESET
            }
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_FOUND_START_HEADER = 1; private const val STEP_FOUND_HEADER = 2
        private const val STEP_FOUND_START_BIT = 3; private const val STEP_SAVE_DURATION = 4; private const val STEP_CHECK_DURATION = 5
        private const val HSM_PATTERN = 0xFF000000003L
    }
}
