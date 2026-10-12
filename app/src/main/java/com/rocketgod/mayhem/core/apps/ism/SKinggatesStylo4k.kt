package com.rocketgod.mayhem.core.apps.ism

/** KingGates Stylo 4K remotes (Mayhem fprotos/s-kinggates_stylo_4k.hpp). */
class SKinggatesStylo4k : FProto(Fam.REMOTE, S.KINGGATES_STYLO_4K) {
    init { teShort = 400; teLong = 1100; teDelta = 140; minCountBitForFound = 89 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_CHECK_PREAMBULA; headerCount++ }
            STEP_CHECK_PREAMBULA -> {
                if (!level && dd(duration, teShort) < teDelta) { parserStep = STEP_RESET; return }
                if (headerCount > 2 && dd(duration, teLong * 2) < teDelta * 2) {
                    // Found header
                    parserStep = STEP_CHECK_START_BIT
                } else { parserStep = STEP_RESET; headerCount = 0 }
            }
            STEP_CHECK_START_BIT -> {
                if (level && dd(duration, teShort * 2) < teDelta * 2) { parserStep = STEP_SAVE_DURATION; decodeData = 0; decodeCountBit = 0; headerCount = 0 }
            }
            STEP_SAVE_DURATION -> {
                if (!level) {
                    if (duration >= teLong * 3) {
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        parserStep = STEP_RESET
                        decodeData = 0; decodeCountBit = 0; headerCount = 0
                        return
                    } else { teLast = duration; parserStep = STEP_CHECK_DURATION }
                } else { parserStep = STEP_RESET; headerCount = 0 }
            }
            STEP_CHECK_DURATION -> {
                if (level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 2) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teLong) < teDelta * 2 && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE_DURATION }
                    else { parserStep = STEP_RESET; headerCount = 0 }
                    if (decodeCountBit == 53) decodeData = 0
                } else { parserStep = STEP_RESET; headerCount = 0 }
            }
        }
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULA = 1; private const val STEP_CHECK_START_BIT = 2
        private const val STEP_SAVE_DURATION = 3; private const val STEP_CHECK_DURATION = 4
    }
}
