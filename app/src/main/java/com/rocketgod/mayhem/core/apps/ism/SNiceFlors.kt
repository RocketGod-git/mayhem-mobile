package com.rocketgod.mayhem.core.apps.ism

/** Nice Flor-S / Nice One remotes (Mayhem fprotos/s-nice_flors.hpp). */
class SNiceFlors : FProto(Fam.REMOTE, S.NICE_FLORS) {
    init { teShort = 500; teLong = 1000; teDelta = 300; minCountBitForFound = 52 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 38) < teDelta * 38) parserStep = STEP_CHECK_HEADER  // Found start header Nice Flor-S
            STEP_CHECK_HEADER -> if (level && dd(duration, teShort * 3) < teDelta * 3) parserStep = STEP_FOUND_HEADER else parserStep = STEP_RESET
            STEP_FOUND_HEADER -> if (!level && dd(duration, teShort * 3) < teDelta * 3) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 } else parserStep = STEP_RESET
            STEP_SAVE -> {
                if (level) {
                    if (dd(duration, teShort * 3) < teDelta) {
                        // Found STOP bit
                        parserStep = STEP_RESET
                        if (decodeCountBit == minCountBitForFound || decodeCountBit == NICE_ONE_COUNT_BIT) { dataCountBit = decodeCountBit; hit(); decodeData = 0 }
                        return
                    } else { teLast = duration; parserStep = STEP_CHECK }
                }
            }
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_HEADER = 1; private const val STEP_FOUND_HEADER = 2; private const val STEP_SAVE = 3; private const val STEP_CHECK = 4
        private const val NICE_ONE_COUNT_BIT = 72
    }
}
