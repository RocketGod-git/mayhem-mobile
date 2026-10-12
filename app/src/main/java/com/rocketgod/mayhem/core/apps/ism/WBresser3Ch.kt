package com.rocketgod.mayhem.core.apps.ism

/** Bresser 3CH weather sensor, V0 and V1 framing (Mayhem fprotos/w-bresser_3ch.hpp). */
class WBresser3Ch : FProto(Fam.WEATHER, W.BRESSER_3CH) {
    init { teShort = 475; teLong = 3900; teDelta = 150 }
    private val teShortV1 = 250
    private val teLongV1 = 500

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> {
                if (level && dd(duration, teShort * 3) < teDelta) { teLast = duration; parserStep = STEP_V1_PREAMBLE_DN; decodeData = 0; decodeCountBit = 0 }
                else if (!level && duration >= teLong) { parserStep = STEP_V0_SAVE; decodeData = 0; decodeCountBit = 0 }
            }
            STEP_V0_SAVE -> {
                if (level) {
                    teLast = duration
                    parserStep = if (decodeCountBit < V0_DATA) STEP_V0_CHECK else STEP_V0_TAIL_CHECK
                } else parserStep = STEP_RESET
            }
            STEP_V0_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta) {
                        if (dd(duration, teShort * 2) < teDelta) { addBit(0); parserStep = STEP_V0_SAVE }
                        else if (dd(duration, teShort * 4) < teDelta) { addBit(1); parserStep = STEP_V0_SAVE }
                        else parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
            STEP_V0_TAIL_CHECK -> {
                if (!level) {
                    if (duration >= teLong) {
                        if (decodeCountBit == V0_DATA_AND_TAIL && checkV0()) {
                            decodeCountBit = V0_DATA
                            sensorType = W.BRESSER_3CH
                            hit()
                        }
                        decodeData = 0; decodeCountBit = 0
                        parserStep = STEP_RESET
                    } else if (decodeCountBit < V0_DATA_AND_TAIL && dd(teLast, teShort) < teDelta && dd(duration, teShort * 2) < teDelta) {
                        decodeCountBit++
                        parserStep = STEP_V0_SAVE
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
            STEP_V1_PREAMBLE_DN -> {
                if (!level && dd(duration, teShortV1 * 3) < teDelta) {
                    parserStep = if (dd(teLast, teShortV1 * 12) < teDelta * 2) STEP_V1_SAVE else STEP_V1_PREAMBLE_UP
                } else parserStep = STEP_RESET
            }
            STEP_V1_PREAMBLE_UP -> {
                if (level && dd(duration, teShortV1 * 3) < teDelta) { teLast = teLast + duration; parserStep = STEP_V1_PREAMBLE_DN }
                else parserStep = STEP_RESET
            }
            STEP_V1_SAVE -> {
                if (decodeCountBit == V1_DATA) {
                    if (checkV1()) { sensorType = W.BRESSER_3CH_V1; hit() }
                    decodeData = 0; decodeCountBit = 0
                    parserStep = STEP_RESET
                } else if (level) { teLast = duration; parserStep = STEP_V1_CHECK }
                else parserStep = STEP_RESET
            }
            STEP_V1_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShortV1) < teDelta && dd(duration, teLongV1) < teDelta) { addBit(0); parserStep = STEP_V1_SAVE }
                    else if (dd(teLast, teLongV1) < teDelta && dd(duration, teShortV1) < teDelta) { addBit(1); parserStep = STEP_V1_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun checkV0(): Boolean {
        if (decodeData == 0L) return false
        if (((decodeData ushr 8) and 0x0f) != 0x0fL) return false   // separator not 0xf
        if (((decodeData ushr 28) and 0xff) == 0xffL) return false  // ID only ones?
        if (((decodeData ushr 28) and 0xff) == 0x00L) return false  // ID only zeroes?
        if (((decodeData ushr 25) and 0x0f) == 0x0fL) return false  // flags only ones?
        if (((decodeData ushr 25) and 0x0f) == 0x00L) return false  // flags only zeroes?
        if (((decodeData ushr 12) and 0x0fff) == 0x0fffL) return false  // temperature maxed out?
        if ((decodeData and 0xff) < 20) return false  // humidity percentage less than 20?
        if ((decodeData and 0xff) > 95) return false  // humidity percentage more than 95?
        return true
    }

    private fun checkV1(): Boolean {
        if (decodeData == 0L) return false
        val sum = (((decodeData ushr 32) and 0xff) + ((decodeData ushr 24) and 0xff) + ((decodeData ushr 16) and 0xff) + ((decodeData ushr 8) and 0xff)) and 0xff
        return (decodeData and 0xff) == sum
    }

    companion object {
        private const val V0_DATA = 36; private const val V0_DATA_AND_TAIL = 52; private const val V1_DATA = 40
        private const val STEP_RESET = 0; private const val STEP_V0_SAVE = 1; private const val STEP_V0_CHECK = 2; private const val STEP_V0_TAIL_CHECK = 3
        private const val STEP_V1_PREAMBLE_DN = 4; private const val STEP_V1_PREAMBLE_UP = 5; private const val STEP_V1_SAVE = 6; private const val STEP_V1_CHECK = 7
    }
}
