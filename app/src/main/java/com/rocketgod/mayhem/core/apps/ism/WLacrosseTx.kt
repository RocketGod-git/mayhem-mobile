package com.rocketgod.mayhem.core.apps.ism

/** LaCrosse TX weather sensor (Mayhem fprotos/w-lacrosse-tx.hpp). */
class WLacrosseTx : FProto(Fam.WEATHER, W.LACROSSE_TX) {
    init { teShort = 550; teLong = 1300; teDelta = 120; minCountBitForFound = 40 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, GAP) < teDelta * 2) { parserStep = STEP_CHECK_PREAMBLE; headerCount = 0 }
            STEP_CHECK_PREAMBLE -> {
                if (level) {
                    if (dd(duration, teShort) < teDelta && headerCount > 1) { parserStep = STEP_CHECK; decodeData = 0; decodeCountBit = 0; teLast = duration }
                    else if (duration > teLong * 2) parserStep = STEP_RESET
                } else {
                    if (dd(duration, GAP) < teDelta * 2) { teLast = duration; headerCount++ } else parserStep = STEP_RESET
                }
            }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (duration > GAP * 3) {
                        if (dd(teLast, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                        else if (dd(teLast, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                        if ((decodeData and SYNC_MASK) == SYNC_PATTERN) { if (checkCrc()) hit() }
                        decodeData = 0; decodeCountBit = 0; headerCount = 0; parserStep = STEP_RESET
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, GAP) < teDelta * 2) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, GAP) < teDelta * 2) { addBit(0); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    private fun checkCrc(): Boolean {
        if (decodeData == 0L) return false
        val msg = intArrayOf(
            ((decodeData ushr 36) and 0x0F).toInt(),
            ((decodeData ushr 32) and 0x0F).toInt(),
            ((decodeData ushr 28) and 0x0F).toInt(),
            ((decodeData ushr 24) and 0x0F).toInt(),
            ((decodeData ushr 20) and 0x0F).toInt(),
            ((decodeData ushr 16) and 0x0F).toInt(),
            ((decodeData ushr 12) and 0x0F).toInt(),
            ((decodeData ushr 8) and 0x0F).toInt(),
            ((decodeData ushr 4) and 0x0F).toInt())
        val crc = FG.addBytes(msg, 9)
        return (crc and 0x0F) == (decodeData and 0x0F).toInt()
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3
        private const val GAP = 1000
        private const val SYNC_PATTERN = 0x0A000000000L
        private const val SYNC_MASK = 0x0F000000000L
    }
}
