package com.rocketgod.mayhem.core.apps.ism

/** Kia key fob v5, Manchester coded (Mayhem fprotos/c-kia_v5.hpp). */
class CKiaV5 : FProto(Fam.CAR, C.KIA_V5) {
    init { teShort = 400; teLong = 800; teDelta = 150; minCountBitForFound = 64 }

    private val manchester = Manchester()

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) {
                parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 1; decodeCountBit = 0; decodeData = 0
                manchester.advance(Manchester.EVENT_RESET)
            }
            STEP_CHECK_PREAMBLE -> {
                if (level) {
                    if (dd(duration, teLong) < teDelta) {
                        if (headerCount > 40) { parserStep = STEP_DATA; decodeCountBit = 0; decodeData = 0; decodeData2 = 0; headerCount = 0 }
                        else teLast = duration
                    } else if (dd(duration, teShort) < teDelta) teLast = duration
                    else parserStep = STEP_RESET
                } else {
                    if (dd(duration, teShort) < teDelta && dd(teLast, teShort) < teDelta) headerCount++
                    else if (dd(duration, teLong) < teDelta && dd(teLast, teShort) < teDelta) headerCount++
                    else if (dd(teLast, teLong) < teDelta) headerCount++
                    else parserStep = STEP_RESET
                    teLast = duration
                }
            }
            STEP_DATA -> {
                val event: Int
                if (dd(duration, teShort) < teDelta) event = if (level) Manchester.EVENT_SHORT_HIGH else Manchester.EVENT_SHORT_LOW
                else if (dd(duration, teLong) < teDelta) event = if (level) Manchester.EVENT_LONG_HIGH else Manchester.EVENT_LONG_LOW
                else {
                    if (decodeCountBit >= minCountBitForFound) {
                        dataCountBit = if (decodeCountBit > 67) 67 else decodeCountBit
                        hit()
                    }
                    parserStep = STEP_RESET
                    return
                }

                if (decodeCountBit <= 66 && manchester.advance(event)) {
                    addBit(if (manchester.data) 1 else 0)
                    if (decodeCountBit == 64) { decodeData2 = decodeData; decodeData = 0 }
                }
                teLast = duration
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_DATA = 2 }
}
