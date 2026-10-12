package com.rocketgod.mayhem.core.apps.ism

/** iDo 117/111 remotes (Mayhem fprotos/s-ido.hpp). */
class SIdo : FProto(Fam.REMOTE, S.IDO) {
    init { teShort = 450; teLong = 1450; teDelta = 150; minCountBitForFound = 48 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort * 10) < teDelta * 5) parserStep = STEP_FOUND_PREAMBULA
            STEP_FOUND_PREAMBULA -> {
                if (!level && dd(duration, teShort * 10) < teDelta * 5) { parserStep = STEP_SAVE_DURATION; decodeData = 0; decodeCountBit = 0 }
                else parserStep = STEP_RESET
            }
            STEP_SAVE_DURATION -> {
                if (level) {
                    if (duration >= teShort * 5 + teDelta) {
                        parserStep = STEP_FOUND_PREAMBULA
                        if (decodeCountBit >= minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0
                        return
                    } else { teLast = duration; parserStep = STEP_CHECK_DURATION }
                } else parserStep = STEP_RESET
            }
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 3) { addBit(0); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teShort) < teDelta * 3 && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_FOUND_PREAMBULA = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3 }
}
