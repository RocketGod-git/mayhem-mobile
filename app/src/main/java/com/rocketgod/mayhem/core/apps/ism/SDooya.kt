package com.rocketgod.mayhem.core.apps.ism

/** Dooya remotes (Mayhem fprotos/s-dooya.hpp). */
class SDooya : FProto(Fam.REMOTE, S.DOOYA) {
    init { teShort = 366; teLong = 733; teDelta = 120; minCountBitForFound = 40 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teLong * 12) < teDelta * 20) parserStep = STEP_FOUND
            STEP_FOUND -> {
                if (!level) {
                    if (dd(duration, teLong * 2) < teDelta * 3) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
                    else parserStep = STEP_RESET
                } else if (dd(duration, teShort * 13) < teDelta * 5) {
                    // stay
                } else parserStep = STEP_RESET
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> if (!level) {
                if (duration >= teLong * 4) {
                    if (dd(teLast, teShort) < teDelta) addBit(0)
                    else if (dd(teLast, teLong) < teDelta * 2) addBit(1)
                    else { parserStep = STEP_RESET; return }
                    parserStep = STEP_FOUND
                    if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                    return
                } else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 2) { addBit(0); parserStep = STEP_SAVE }
                else if (dd(teLast, teLong) < teDelta * 2 && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                else parserStep = STEP_RESET
            } else parserStep = STEP_RESET
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_FOUND = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
