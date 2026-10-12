package com.rocketgod.mayhem.core.apps.ism

/** Linear Delta-3 remotes (Mayhem fprotos/s-linear_delta3.hpp). */
class SLinearDelta3 : FProto(Fam.REMOTE, S.LINEAR_DELTA3) {
    init { teShort = 500; teLong = 2000; teDelta = 150; minCountBitForFound = 8 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 70) < teDelta * 24) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (duration >= teShort * 10) {
                        parserStep = STEP_RESET
                        if (dd(teLast, teShort) < teDelta) addBit(1)
                        else if (dd(teLast, teLong) < teDelta) addBit(0)
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit(); parserStep = STEP_SAVE }
                        return
                    }
                    if (dd(teLast, teShort) < teDelta && dd(duration, teShort * 7) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
