package com.rocketgod.mayhem.core.apps.ism

/** Kia key fob v2, Manchester coded (Mayhem fprotos/c-kia_v2.hpp). */
class CKiaV2 : FProto(Fam.CAR, C.KIA_V2) {
    init { teShort = 500; teLong = 1000; teDelta = 160; minCountBitForFound = 53 }

    private val manchester = Manchester()

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teLong) < teDelta) { parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 0; manchester.advance(Manchester.EVENT_RESET) }
            STEP_CHECK_PREAMBLE -> {
                if (level) { // HIGH pulse
                    if (dd(duration, teLong) < teDelta) { teLast = duration; headerCount++ }
                    else if (dd(duration, teShort) < teDelta) {
                        if (headerCount >= 100) { headerCount = 0; decodeData = 0; decodeCountBit = 1; parserStep = STEP_COLLECT_RAW_BITS; addBit(1) }
                        else teLast = duration
                    } else parserStep = STEP_RESET
                } else {
                    if (dd(duration, teLong) < teDelta) { headerCount++; teLast = duration }
                    else if (dd(duration, teShort) < teDelta) teLast = duration
                    else parserStep = STEP_RESET
                }
            }
            STEP_COLLECT_RAW_BITS -> {
                val event: Int
                if (dd(duration, teShort) < teDelta) event = if (level) Manchester.EVENT_SHORT_LOW else Manchester.EVENT_SHORT_HIGH
                else if (dd(duration, teLong) < teDelta) event = if (level) Manchester.EVENT_LONG_LOW else Manchester.EVENT_LONG_HIGH
                else { parserStep = STEP_RESET; return }

                if (manchester.advance(event)) {
                    addBit(if (manchester.data) 1 else 0)
                    if (decodeCountBit == 53) {
                        dataCountBit = decodeCountBit
                        hit()
                        decodeData = 0; decodeCountBit = 0; headerCount = 0; parserStep = STEP_RESET
                    }
                }
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_COLLECT_RAW_BITS = 2 }
}
