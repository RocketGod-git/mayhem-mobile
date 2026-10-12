package com.rocketgod.mayhem.core.apps.ism

/** Marantec 24-bit remotes (Mayhem fprotos/s-marantec24.hpp). */
class SMarantec24 : FProto(Fam.REMOTE, S.MARANTEC24) {
    init { teShort = 800; teLong = 1600; teDelta = 200; minCountBitForFound = 24 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teLong * 9) < teDelta * 4) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    // Bit 0 is long and short x2 timing = 1600us HIGH (te_last) and 2400us LOW
                    if (dd(teLast, teLong) < teDelta && dd(duration, teShort * 3) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    // Bit 1 is short and long x2 timing = 800us HIGH (te_last) and 3200us LOW
                    else if (dd(teLast, teShort) < teDelta && dd(duration, teLong * 2) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(duration, teLong * 9) < teDelta * 4) {
                        // End of the key: found next GAP and add bit 0 or 1
                        if (dd(teLast, teLong) < teDelta && dd(duration, teLong * 9) < teDelta * 4) addBit(0)
                        if (dd(teLast, teShort) < teDelta && dd(duration, teLong * 9) < teDelta * 4) addBit(1)
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0
                        parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
