package com.rocketgod.mayhem.core.apps.ism

/** Intertechno V3 remotes (Mayhem fprotos/s-intertechnov3.hpp). */
class SIntertechnoV3 : FProto(Fam.REMOTE, S.INTERTECHNO_V3) {
    init { teShort = 275; teLong = 1375; teDelta = 150; minCountBitForFound = 32 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 37) < teDelta * 15) parserStep = STEP_START_SYNC
            STEP_START_SYNC -> {
                if (level && dd(duration, teShort) < teDelta) parserStep = STEP_FOUND_SYNC
                else parserStep = STEP_RESET
            }
            STEP_FOUND_SYNC -> {
                if (!level && dd(duration, teShort * 10) < teDelta * 3) { parserStep = STEP_START_DURATION; decodeData = 0; decodeCountBit = 0 }
                else parserStep = STEP_RESET
            }
            STEP_START_DURATION -> {
                if (level && dd(duration, teShort) < teDelta) parserStep = STEP_SAVE_DURATION
                else parserStep = STEP_RESET
            }
            STEP_SAVE_DURATION -> {
                if (!level) {
                    if (duration >= teShort * 11) {
                        parserStep = STEP_START_SYNC
                        if (decodeCountBit == minCountBitForFound || decodeCountBit == DIMMING_COUNT_BIT) { dataCountBit = decodeCountBit; hit() }
                        return
                    }
                    teLast = duration
                    parserStep = STEP_CHECK_DURATION
                } else parserStep = STEP_RESET
            }
            STEP_CHECK_DURATION -> {
                if (level) {
                    // Add 0 bit
                    if (dd(teLast, teShort) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_END_DURATION }
                    // Add 1 bit
                    else if (dd(teLast, teLong) < teDelta * 2 && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_END_DURATION }
                    // Add dimm_state
                    else if (dd(teLast, teShort) < teDelta * 2 && dd(duration, teShort) < teDelta && decodeCountBit == 27) { addBit(0); parserStep = STEP_END_DURATION }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
            STEP_END_DURATION -> {
                if (!level && (dd(duration, teShort) < teDelta || dd(duration, teLong) < teDelta * 2)) parserStep = STEP_START_DURATION
                else parserStep = STEP_RESET
            }
        }
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_START_SYNC = 1; private const val STEP_FOUND_SYNC = 2; private const val STEP_START_DURATION = 3
        private const val STEP_SAVE_DURATION = 4; private const val STEP_CHECK_DURATION = 5; private const val STEP_END_DURATION = 6
        private const val DIMMING_COUNT_BIT = 36
    }
}
