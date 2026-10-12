package com.rocketgod.mayhem.core.apps.ism

/** CAME Twee (Manchester) remotes (Mayhem fprotos/s-came_twee.hpp). */
class SCameTwee : FProto(Fam.REMOTE, S.CAME_TWEE) {
    init { teShort = 500; teLong = 1000; teDelta = 250; minCountBitForFound = 54 }
    private val manchester = Manchester()

    override fun feed(level: Boolean, duration: Int) {
        var event = Manchester.EVENT_RESET
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teLong * 51) < teDelta * 20) {
                parserStep = STEP_DATA
                decodeData = 0; decodeCountBit = 0
                manchester.advance(Manchester.EVENT_LONG_LOW)
                manchester.advance(Manchester.EVENT_LONG_HIGH)
                manchester.advance(Manchester.EVENT_SHORT_LOW)
            }
            STEP_DATA -> {
                if (!level) {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_LOW
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_LOW
                    else if (duration >= teLong * 2 + teDelta) {
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0
                        manchester.advance(Manchester.EVENT_LONG_LOW)
                        manchester.advance(Manchester.EVENT_LONG_HIGH)
                        manchester.advance(Manchester.EVENT_SHORT_LOW)
                    } else parserStep = STEP_RESET
                } else {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_HIGH
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_HIGH
                    else parserStep = STEP_RESET
                }
                if (event != Manchester.EVENT_RESET) {
                    if (manchester.advance(event)) {
                        decodeData = (decodeData shl 1) or (if (!manchester.data) 1L else 0L)
                        decodeCountBit++
                    }
                }
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_DATA = 1 }
}
