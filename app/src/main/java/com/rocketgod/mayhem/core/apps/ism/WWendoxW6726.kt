package com.rocketgod.mayhem.core.apps.ism

/** Wendox W6726 weather sensor (Mayhem fprotos/w-wendox-w6726.hpp). */
class WWendoxW6726 : FProto(Fam.WEATHER, W.WENDOX_W6726) {
    init { teShort = 1955; teLong = 5865; teDelta = 300; minCountBitForFound = 29 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort) < teDelta) { parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 0 }
            STEP_CHECK_PREAMBLE -> {
                if (level) teLast = duration
                else {
                    if (dd(teLast, teShort) < teDelta * 1 && dd(duration, teLong) < teDelta * 2) headerCount++
                    else if (headerCount > 4 && headerCount < 12) {
                        if (dd(teLast, teLong) < teDelta * 2 && dd(duration, teShort) < teDelta) { decodeData = 0; decodeCountBit = 0; addBit(1); parserStep = STEP_SAVE }
                        else parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                }
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (duration > teShort + teLong) {
                        if (dd(teLast, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                        else if (dd(teLast, teLong) < teDelta * 2) { addBit(1); parserStep = STEP_SAVE }
                        else parserStep = STEP_RESET
                        if (decodeCountBit == minCountBitForFound && check()) hit()
                        parserStep = STEP_RESET
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 3) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta * 2 && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun check(): Boolean {
        if (decodeData == 0L) return false
        val msg = intArrayOf(
            ((decodeData ushr 28) and 0xff).toInt(),
            ((decodeData ushr 20) and 0xff).toInt(),
            ((decodeData ushr 12) and 0xff).toInt(),
            ((decodeData ushr 4) and 0xff).toInt())
        val crc = FG.crc4(msg, 4, 0x9, 0xD)
        return crc == (decodeData and 0x0F).toInt()
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3 }
}
