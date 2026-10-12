package com.rocketgod.mayhem.core.apps.ism

/** StarLine car alarm remotes (Mayhem fprotos/s-star_line.hpp). */
class SStarLine : FProto(Fam.REMOTE, S.STARLINE) {
    init { teShort = 250; teLong = 500; teDelta = 120; minCountBitForFound = 64 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> {
                if (level) {
                    if (dd(duration, teLong * 2) < teDelta * 2) { parserStep = STEP_CHECK_PREAMBULA; headerCount++ }
                    else if (headerCount > 4) { decodeData = 0; decodeCountBit = 0; teLast = duration; parserStep = STEP_CHECK }
                } else headerCount = 0
            }
            STEP_CHECK_PREAMBULA -> if (!level && dd(duration, teLong * 2) < teDelta * 2) parserStep = STEP_RESET else { headerCount = 0; parserStep = STEP_RESET }
            STEP_SAVE -> {
                if (level) {
                    if (duration >= teLong + teDelta) {
                        parserStep = STEP_RESET
                        if (decodeCountBit >= minCountBitForFound && decodeCountBit <= minCountBitForFound + 2) { dataCountBit = minCountBitForFound; hit() }
                        decodeData = 0; decodeCountBit = 0
                        headerCount = 0
                        return
                    } else { teLast = duration; parserStep = STEP_CHECK }
                } else parserStep = STEP_RESET
            }
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teShort) < teDelta) {
                        if (decodeCountBit < minCountBitForFound) addBit(0) else decodeCountBit++
                        parserStep = STEP_SAVE
                    } else if (dd(teLast, teLong) < teDelta && dd(duration, teLong) < teDelta) {
                        if (decodeCountBit < minCountBitForFound) addBit(1) else decodeCountBit++
                        parserStep = STEP_SAVE
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULA = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
