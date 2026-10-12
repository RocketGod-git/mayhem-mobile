package com.rocketgod.mayhem.core.apps.ism

/** X10 RF remotes (Mayhem fprotos/s-x10.hpp). */
class SX10 : FProto(Fam.REMOTE, S.X10) {
    init { teShort = 600; teLong = 1800; teDelta = 100; minCountBitForFound = 32 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort * 16) < teDelta * 7) parserStep = STEP_FOUND_PREAMBULA
            STEP_FOUND_PREAMBULA -> if (!level && dd(duration, teShort * 8) < teDelta * 5) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 } else { decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET }
            STEP_SAVE -> {
                if (level) {
                    if (dd(duration, teShort) < teDelta) {
                        if (decodeCountBit == minCountBitForFound) {
                            parserStep = STEP_RESET
                            if (decodeCountBit >= minCountBitForFound &&
                                (((decodeData ushr 24) xor (decodeData ushr 16)) and 0xFF) == 0xFFL &&
                                (((decodeData ushr 8) xor decodeData) and 0xFF) == 0xFFL) {
                                dataCountBit = decodeCountBit
                                hit()
                            }
                            decodeData = 0; decodeCountBit = 0
                            parserStep = STEP_RESET
                        } else { teLast = duration; parserStep = STEP_CHECK }
                    } else { decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET }
                } else { decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET }
            }
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 2) { addBit(1); parserStep = STEP_SAVE }
                    else { decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET }
                } else { decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET }
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_FOUND_PREAMBULA = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
