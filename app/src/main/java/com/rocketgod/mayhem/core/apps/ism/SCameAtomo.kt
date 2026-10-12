package com.rocketgod.mayhem.core.apps.ism

/** CAME Atomo (Manchester) remotes (Mayhem fprotos/s-came_atomo.hpp). */
class SCameAtomo : FProto(Fam.REMOTE, S.CAME_ATOMO) {
    init { teShort = 600; teLong = 1200; teDelta = 250; minCountBitForFound = 62 }
    private val manchester = Manchester()

    override fun feed(level: Boolean, duration: Int) {
        var event = Manchester.EVENT_RESET
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teLong * 60) < teDelta * 40) {
                parserStep = STEP_DATA
                decodeData = 0; decodeCountBit = 1
                manchester.advance(Manchester.EVENT_RESET)
                manchester.advance(Manchester.EVENT_SHORT_LOW)
            }
            STEP_DATA -> {
                if (!level) {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_LOW
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_LOW
                    else if (duration >= teLong * 2 + teDelta) {
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 1
                        manchester.advance(Manchester.EVENT_RESET)
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
