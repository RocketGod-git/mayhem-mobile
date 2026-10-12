package com.rocketgod.mayhem.core.apps.ism

/** KeeLoq rolling-code remotes (Mayhem fprotos/s-keeloq.hpp). */
class SKeeloq : FProto(Fam.REMOTE, S.KEELOQ) {
    init { teShort = 400; teLong = 800; teDelta = 140; minCountBitForFound = 64 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_CHECK_PREAMBULA; headerCount++ }
            STEP_CHECK_PREAMBULA -> {
                if (!level && dd(duration, teShort) < teDelta) { parserStep = STEP_RESET; return }
                if (headerCount > 2 && dd(duration, teShort * 10) < teDelta * 10) {
                    // Found header
                    parserStep = STEP_SAVE_DURATION; decodeData = 0; decodeCountBit = 0
                } else { parserStep = STEP_RESET; headerCount = 0 }
            }
            STEP_SAVE_DURATION -> if (level) { teLast = duration; parserStep = STEP_CHECK_DURATION }
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (duration >= teShort * 2 + teDelta) {
                        // Found end TX
                        parserStep = STEP_RESET
                        if (decodeCountBit >= minCountBitForFound && decodeCountBit <= minCountBitForFound + 2) {
                            dataCountBit = minCountBitForFound
                            hit()
                            decodeData = 0; decodeCountBit = 0; headerCount = 0
                        }
                        return
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 2) {
                        if (decodeCountBit < minCountBitForFound) addBit(1) else decodeCountBit++
                        parserStep = STEP_SAVE_DURATION
                    } else if (dd(teLast, teLong) < teDelta * 2 && dd(duration, teShort) < teDelta) {
                        if (decodeCountBit < minCountBitForFound) addBit(0) else decodeCountBit++
                        parserStep = STEP_SAVE_DURATION
                    } else { parserStep = STEP_RESET; headerCount = 0 }
                } else { parserStep = STEP_RESET; headerCount = 0 }
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULA = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3 }
}
