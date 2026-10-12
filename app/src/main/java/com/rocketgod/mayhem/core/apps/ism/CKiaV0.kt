package com.rocketgod.mayhem.core.apps.ism

/** Kia key fob v0 (Mayhem fprotos/c-kia_v0.hpp). */
class CKiaV0 : FProto(Fam.CAR, C.KIA_V0) {
    init { teShort = 250; teLong = 500; teDelta = 100; minCountBitForFound = 61 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_CHECK_PREAMBULA; teLast = duration; headerCount = 0 }
            STEP_CHECK_PREAMBULA -> {
                if (level) {
                    if (dd(duration, teShort) < teDelta || dd(duration, teLong) < teDelta) teLast = duration else parserStep = STEP_RESET
                } else if (dd(duration, teShort) < teDelta && dd(teLast, teShort) < teDelta) headerCount++
                else if (dd(duration, teLong) < teDelta && dd(teLast, teLong) < teDelta) {
                    if (headerCount > 15) { parserStep = STEP_SAVE_DURATION; decodeData = 0; decodeCountBit = 1; addBit(1) } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
            STEP_SAVE_DURATION -> {
                if (level) {
                    if (duration >= teLong + teDelta * 2) {
                        // End of transmission detected
                        parserStep = STEP_RESET
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0
                        return
                    } else { teLast = duration; parserStep = STEP_CHECK_DURATION }
                } else parserStep = STEP_RESET
            }
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teLong) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULA = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3 }
}
