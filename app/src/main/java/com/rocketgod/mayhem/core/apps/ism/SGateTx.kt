package com.rocketgod.mayhem.core.apps.ism

/** Gate-TX remotes (Mayhem fprotos/s-gate_tx.hpp). */
class SGateTx : FProto(Fam.REMOTE, S.GATE_TX) {
    init { teShort = 350; teLong = 700; teDelta = 100; minCountBitForFound = 24 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 47) < teDelta * 47) parserStep = STEP_FOUND
            STEP_FOUND -> if (level && dd(duration, teLong) < teDelta * 3) {
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
