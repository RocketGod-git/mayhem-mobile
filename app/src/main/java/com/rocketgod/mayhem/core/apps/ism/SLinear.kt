package com.rocketgod.mayhem.core.apps.ism

/** Linear garage remotes (Mayhem fprotos/s-linear.hpp). */
class SLinear : FProto(Fam.REMOTE, S.LINEAR) {
    init { teShort = 500; teLong = 1500; teDelta = 150; minCountBitForFound = 10 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 42) < teDelta * 20) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (duration >= teShort * 5) {
                        parserStep = STEP_RESET
                        // checking that the duration matches the guardtime
                        if (dd(duration, teShort * 42) > teDelta * 20) return
                        if (dd(teLast, teShort) < teDelta) addBit(0)
                        else if (dd(teLast, teLong) < teDelta) addBit(1)
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        return
                    }
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
