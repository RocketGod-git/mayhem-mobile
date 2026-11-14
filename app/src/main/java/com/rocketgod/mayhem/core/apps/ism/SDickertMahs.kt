package com.rocketgod.mayhem.core.apps.ism

/**
 * Dickert MAHS gate remotes, 36-bit OOK PWM, 18 trinary symbols: 10 user DIPs + 8-symbol factory code (Flipper
 * Unleashed lib/subghz/protocols/dickert_mahs.c). Receive only.
 */
class SDickertMahs : FProto(Fam.REMOTE, S.DICKERT_MAHS) {
    private var tmp0 = 0
    private var tmpCnt = 0

    init { teShort = 400; teLong = 800; teDelta = 100; minCountBitForFound = 36 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> {
                // Check if done
                if (decodeCountBit >= minCountBitForFound) {
                    dataCountBit = decodeCountBit
                    hit()
                    decodeData = 0; decodeCountBit = 0
                }
                if (!level && dd(duration, teLong * 50) < teDelta * 70) parserStep = STEP_INITIAL // 40 ms header
            }
            STEP_INITIAL -> {
                if (!level) return
                if (dd(duration, teShort) < teDelta) { parserStep = STEP_RECORDING; decodeData = 0; decodeCountBit = 0 }
                else parserStep = STEP_RESET
            }
            STEP_RECORDING -> {
                if ((!level && tmpCnt == 0) || (level && tmpCnt == 1)) {
                    if (tmpCnt == 0) { tmp0 = duration; tmpCnt = 1; return }
                    // Space + mark: a bit is 1200 us in all
                    tmpCnt = 0
                    if (dd(tmp0 + duration, 1200) < teDelta) {
                        if (dd(tmp0, teLong) < teDelta) addBit(1)
                        else if (dd(tmp0, teShort) < teDelta) addBit(0)
                    } else parserStep = STEP_RESET
                } else { tmpCnt = 0; parserStep = STEP_RESET }
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit < minCountBitForFound) return null
        // Symbols from the low 36 bits, MSB first: 11 = '+', 01 = '0', 00 = '-', 10 = '?'
        val sb = StringBuilder()
        for (i in 0 until 18) {
            sb.append(when (((decodeData ushr (34 - i * 2)) and 3L).toInt()) { 1 -> '0'; 0 -> '-'; 3 -> '+'; else -> '?' })
        }
        val code = sb.toString()
        return RemoteInfo(RemoteFields.name(sensorType), 0L, null, null, listOf("User DIPs: " + code.substring(0, 10), "Factory code: " + code.substring(10, 18)))
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_INITIAL = 1; private const val STEP_RECORDING = 2 }
}
