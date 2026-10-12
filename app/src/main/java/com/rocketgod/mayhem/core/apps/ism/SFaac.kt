package com.rocketgod.mayhem.core.apps.ism

/** FAAC SLH remotes (Mayhem fprotos/s-faac.hpp). */
class SFaac : FProto(Fam.REMOTE, S.FAAC) {
    init { teShort = 255; teLong = 595; teDelta = 100; minCountBitForFound = 64 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teLong * 2) < teDelta * 3) parserStep = STEP_PREAMBULA
            STEP_PREAMBULA -> if (!level && dd(duration, teLong * 2) < teDelta * 3) {
                parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0
            } else parserStep = STEP_RESET
            STEP_SAVE -> if (level) {
                if (duration >= teShort * 3 + teDelta) {
                    parserStep = STEP_PREAMBULA
                    if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                    decodeData = 0; decodeCountBit = 0
                } else {
                    teLast = duration
                    parserStep = STEP_CHECK
                }
            } else parserStep = STEP_RESET
            STEP_CHECK -> if (!level) {
                if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                else parserStep = STEP_RESET
            } else parserStep = STEP_RESET
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_PREAMBULA = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
