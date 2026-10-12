package com.rocketgod.mayhem.core.apps.ism

/** BETT remotes (Mayhem fprotos/s-bett.hpp). */
class SBett : FProto(Fam.REMOTE, S.BETT) {
    init { teShort = 340; teLong = 2000; teDelta = 150; minCountBitForFound = 18 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 44) < teDelta * 15) {
                decodeData = 0; decodeCountBit = 0; parserStep = STEP_CHECK
            }
            STEP_SAVE -> if (!level) {
                if (dd(duration, teShort * 44) < teDelta * 15) {
                    if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                    else parserStep = STEP_RESET
                    decodeData = 0; decodeCountBit = 0
                } else {
                    if (dd(duration, teShort) < teDelta || dd(duration, teLong) < teDelta * 3) parserStep = STEP_CHECK
                    else parserStep = STEP_RESET
                }
            }
            STEP_CHECK -> if (level) {
                if (dd(duration, teLong) < teDelta * 3) { addBit(1); parserStep = STEP_SAVE }
                else if (dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                else parserStep = STEP_RESET
            } else parserStep = STEP_RESET
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
