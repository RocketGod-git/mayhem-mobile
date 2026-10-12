package com.rocketgod.mayhem.core.apps.ism

/** Nero Radio remotes (Mayhem fprotos/s-neroradio.hpp). */
class SNeroRadio : FProto(Fam.REMOTE, S.NERO_RADIO) {
    init { teShort = 200; teLong = 400; teDelta = 80; minCountBitForFound = 56 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_CHECK_PREAMBULA; teLast = duration; headerCount = 0 }
            STEP_CHECK_PREAMBULA -> {
                if (level) {
                    if (dd(duration, teShort) < teDelta || dd(duration, teShort * 4) < teDelta) teLast = duration
                    else parserStep = STEP_RESET
                } else if (dd(duration, teShort) < teDelta) {
                    if (dd(teLast, teShort) < teDelta) { headerCount++; return }  // Found header
                    else if (dd(teLast, teShort * 4) < teDelta) {
                        // Found start bit
                        if (headerCount > 40) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0 }
                        else parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (duration >= 1250) {
                        // Found stop bit
                        if (dd(teLast, teShort) < teDelta) addBit(0)
                        else if (dd(teLast, teLong) < teDelta) addBit(1)
                        parserStep = STEP_RESET
                        if (decodeCountBit == minCountBitForFound || decodeCountBit == minCountBitForFound + 1) { dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0
                        parserStep = STEP_RESET
                        return
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULA = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
