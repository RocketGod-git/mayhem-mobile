package com.rocketgod.mayhem.core.apps.ism

/** GangQi remotes (Mayhem fprotos/s-gangqi.hpp). */
class SGangqi : FProto(Fam.REMOTE, S.GANGQI) {
    init { teShort = 500; teLong = 1200; teDelta = 200; minCountBitForFound = 34 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teLong * 2) < teDelta * 3) {
                decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> if (!level) {
                if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                else if (dd(duration, teShort * 4) < teDelta) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teShort * 4) < teDelta) addBit(0)
                    if (dd(teLast, teLong) < teDelta && dd(duration, teShort * 4) < teDelta) addBit(1)
                    if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                    decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            } else parserStep = STEP_RESET
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
