package com.rocketgod.mayhem.core.apps.ism

/** Kia key fob v1, Manchester coded (Mayhem fprotos/c-kia_v1.hpp). */
class CKiaV1 : FProto(Fam.CAR, C.KIA_V1) {
    init { teShort = 800; teLong = 1600; teDelta = 200; minCountBitForFound = 57 }

    private val manchester = Manchester()

    override fun feed(level: Boolean, duration: Int) {
        var event = Manchester.EVENT_RESET
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teLong) < teDelta) {
                parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 0; decodeData = 0; decodeCountBit = 0
                manchester.advance(Manchester.EVENT_RESET)
            }
            STEP_CHECK_PREAMBLE -> {
                if (!level) {
                    // header_count is a uint8_t upstream
                    if (dd(duration, teLong) < teDelta && dd(teLast, teLong) < teDelta) { headerCount = (headerCount + 1) and 0xff; teLast = duration }
                    else parserStep = STEP_RESET
                }
                if (headerCount > 70) {
                    if (!level && dd(duration, teShort) < teDelta && dd(teLast, teLong) < teDelta) { decodeCountBit = 1; addBit(1); headerCount = 0; parserStep = STEP_DECODE_DATA }
                }
            }
            STEP_DECODE_DATA -> {
                if (dd(duration, teShort) < teDelta) event = if (level) Manchester.EVENT_SHORT_LOW else Manchester.EVENT_SHORT_HIGH
                else if (dd(duration, teLong) < teDelta) event = if (level) Manchester.EVENT_LONG_LOW else Manchester.EVENT_LONG_HIGH

                if (event != Manchester.EVENT_RESET) {
                    if (manchester.advance(event)) addBit(if (manchester.data) 1 else 0)
                }

                if (decodeCountBit == minCountBitForFound) {
                    dataCountBit = decodeCountBit
                    hit()
                    decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                }
            }
        }
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_DECODE_DATA = 2 }
}
