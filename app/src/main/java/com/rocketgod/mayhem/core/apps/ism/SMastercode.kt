package com.rocketgod.mayhem.core.apps.ism

/** Mastercode remotes (Mayhem fprotos/s-mastercode.hpp). */
class SMastercode : FProto(Fam.REMOTE, S.MASTERCODE) {
    init { teShort = 1072; teLong = 2145; teDelta = 150; minCountBitForFound = 36 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 15) < teDelta * 15) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 8) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta * 8 && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(duration, teShort * 15) < teDelta * 15) {
                        if (dd(teLast, teShort) < teDelta) addBit(0)
                        else if (dd(teLast, teLong) < teDelta * 8) addBit(1)
                        else parserStep = STEP_RESET
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        parserStep = STEP_SAVE
                        decodeData = 0; decodeCountBit = 0
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
