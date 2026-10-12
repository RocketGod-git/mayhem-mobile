package com.rocketgod.mayhem.core.apps.ism

/** SMC5326 remotes (Mayhem fprotos/s-smc5326.hpp). */
class SSmc5326 : FProto(Fam.REMOTE, S.SMC5326) {
    init { teShort = 300; teLong = 900; teDelta = 200; minCountBitForFound = 25 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 24) < teDelta * 12) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK }
            STEP_CHECK -> {
                if (!level) {
                    if (duration >= teLong * 2) {
                        parserStep = STEP_SAVE
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0
                        return
                    }
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 3) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta * 3 && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
