package com.rocketgod.mayhem.core.apps.ism

/** Somfy Telis remotes (Mayhem fprotos/s-somify_telis.hpp). */
class SSomfyTelis : FProto(Fam.REMOTE, S.SOMFY_TELIS) {
    init { teShort = 640; teLong = 1280; teDelta = 250; minCountBitForFound = 56 }

    private val manchester = Manchester()

    override fun feed(level: Boolean, duration: Int) {
        var event = Manchester.EVENT_RESET
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort * 4) < teDelta * 4) { parserStep = STEP_FOUND_PREAMBULA; headerCount++ }
            STEP_FOUND_PREAMBULA -> if (!level && dd(duration, teShort * 4) < teDelta * 4) parserStep = STEP_CHECK_PREAMBULA else { headerCount = 0; parserStep = STEP_RESET }
            STEP_CHECK_PREAMBULA -> {
                if (level) {
                    if (dd(duration, teShort * 4) < teDelta * 4) { parserStep = STEP_FOUND_PREAMBULA; headerCount++ }
                    else if (headerCount > 1 && dd(duration, teShort * 7) < teDelta * 4) {
                        parserStep = STEP_DECODER_DATA
                        decodeData = 0; decodeCountBit = 0
                        headerCount = 0
                        manchester.advance(Manchester.EVENT_RESET)
                        manchester.advance(Manchester.EVENT_LONG_HIGH)
                    }
                }
            }
            STEP_DECODER_DATA -> {
                if (!level) {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_LOW
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_LOW
                    else if (duration >= teLong + teDelta) {
                        if (decodeCountBit == minCountBitForFound) {
                            // check crc
                            val dataTmp = decodeData xor (decodeData ushr 8)
                            if (((dataTmp ushr 40) and 0xF).toInt() == crc(dataTmp)) { dataCountBit = decodeCountBit; hit() }
                        }
                        decodeData = 0; decodeCountBit = 0
                        manchester.advance(Manchester.EVENT_RESET)
                        manchester.advance(Manchester.EVENT_LONG_HIGH)
                        parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_HIGH
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_HIGH
                    else parserStep = STEP_RESET
                }
                if (event != Manchester.EVENT_RESET) {
                    if (manchester.advance(event)) addBit(if (manchester.data) 1 else 0)
                }
            }
        }
    }

    private fun crc(dataIn: Long): Int {
        var crc = 0
        val data = dataIn and 0xFFF0FFFFFFFFFFL
        var i = 0
        while (i < 56) { crc = (crc.toLong() xor (data ushr i) xor (data ushr (i + 4))).toInt() and 0xff; i += 8 }
        return crc and 0xf
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULA = 1; private const val STEP_FOUND_PREAMBULA = 2; private const val STEP_DECODER_DATA = 4 }
}
