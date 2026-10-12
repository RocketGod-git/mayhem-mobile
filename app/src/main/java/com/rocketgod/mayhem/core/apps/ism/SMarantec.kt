package com.rocketgod.mayhem.core.apps.ism

/** Marantec Manchester remotes (Mayhem fprotos/s-marantec.hpp). */
class SMarantec : FProto(Fam.REMOTE, S.MARANTEC) {
    init { teShort = 1000; teLong = 2000; teDelta = 200; minCountBitForFound = 49 }

    private val manchester = Manchester()

    override fun feed(level: Boolean, duration: Int) {
        var event = Manchester.EVENT_RESET
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teLong * 5) < teDelta * 8) {
                // Found header marantec
                parserStep = STEP_DECODER_DATA
                decodeData = 1; decodeCountBit = 1
                manchester.advance(Manchester.EVENT_RESET)
            }
            STEP_DECODER_DATA -> {
                if (!level) {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_LOW
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_LOW
                    else if (duration >= teLong * 2 + teDelta) {
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        decodeData = 1; decodeCountBit = 1
                        manchester.advance(Manchester.EVENT_RESET)
                    } else parserStep = STEP_RESET
                } else {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_HIGH
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_HIGH
                    else parserStep = STEP_RESET
                }
                if (event != Manchester.EVENT_RESET) {
                    if (manchester.advance(event)) { decodeData = (decodeData shl 1) or (if (manchester.data) 1L else 0L); decodeCountBit++ }
                }
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_DECODER_DATA = 2 }
}
