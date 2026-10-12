package com.rocketgod.mayhem.core.apps.ism

/** Doitrand remotes (Mayhem fprotos/s-doitrand.hpp). */
class SDoitrand : FProto(Fam.REMOTE, S.DOITRAND) {
    init { teShort = 400; teLong = 1100; teDelta = 150; minCountBitForFound = 37 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 62) < teDelta * 30) parserStep = STEP_FOUND
            STEP_FOUND -> if (level && dd(duration, teShort * 2) < teDelta * 3) {
                parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0
            } else parserStep = STEP_RESET
            STEP_SAVE -> if (!level) {
                if (duration >= teShort * 10 + teDelta) {
                    parserStep = STEP_FOUND
                    if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                    decodeData = 0; decodeCountBit = 0
                } else {
                    teLast = duration
                    parserStep = STEP_CHECK
                }
            }
            STEP_CHECK -> if (level) {
                if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 3) { addBit(0); parserStep = STEP_SAVE }
                else if (dd(teLast, teLong) < teDelta * 3 && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                else parserStep = STEP_RESET
            } else parserStep = STEP_RESET
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_FOUND = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
