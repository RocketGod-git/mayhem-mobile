package com.rocketgod.mayhem.core.apps.ism

/** Nice Flo remotes (Mayhem fprotos/s-nice_flo.hpp). */
class SNiceFlo : FProto(Fam.REMOTE, S.NICE_FLO) {
    init { teShort = 700; teLong = 1400; teDelta = 200; minCountBitForFound = 12 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 36) < teDelta * 36) parserStep = STEP_FOUND_START_BIT  // Found header Nice Flo
            STEP_FOUND_START_BIT -> {
                if (!level) return
                else if (dd(duration, teShort) < teDelta) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }  // Found start bit Nice Flo
                else parserStep = STEP_RESET
            }
            STEP_SAVE -> {
                if (!level) {
                    if (duration >= teShort * 4) {
                        parserStep = STEP_FOUND_START_BIT
                        if (decodeCountBit >= minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        return
                    }
                    teLast = duration
                    parserStep = STEP_CHECK
                } else parserStep = STEP_RESET
            }
            STEP_CHECK -> {
                if (level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_FOUND_START_BIT = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
