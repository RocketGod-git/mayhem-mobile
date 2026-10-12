package com.rocketgod.mayhem.core.apps.ism

/** Phoenix V2 remotes (Mayhem fprotos/s-phoenix_v2.hpp). */
class SPhoenixV2 : FProto(Fam.REMOTE, S.PHOENIX_V2) {
    init { teShort = 427; teLong = 853; teDelta = 100; minCountBitForFound = 52 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 60) < teDelta * 30) parserStep = STEP_FOUND_START_BIT
            STEP_FOUND_START_BIT -> if (level && dd(duration, teShort * 6) < teDelta * 4) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 } else parserStep = STEP_RESET
            STEP_SAVE -> {
                if (!level) {
                    if (duration >= teShort * 10 + teDelta) {
                        parserStep = STEP_FOUND_START_BIT
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0
                        return
                    } else { teLast = duration; parserStep = STEP_CHECK }
                }
            }
            STEP_CHECK -> {
                if (level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 3) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta * 3 && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_FOUND_START_BIT = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
