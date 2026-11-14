package com.rocketgod.mayhem.core.apps.ism

/**
 * Allstar Firefly 318ALD31K gate remotes, 18-bit OOK PWM, 9-position trinary DIP code (Flipper Unleashed
 * lib/subghz/protocols/allstar_firefly.c). Receive only.
 */
class SAllstarFirefly : FProto(Fam.REMOTE, S.ALLSTAR_FIREFLY) {
    init { teShort = 600; teLong = 4000; teDelta = 300; minCountBitForFound = 18 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 50) < teDelta * 5) {
                // Found the ~30 ms gap
                decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE_DURATION
            }
            STEP_SAVE_DURATION -> if (level) { teLast = duration; parserStep = STEP_CHECK_DURATION } else parserStep = STEP_RESET
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) {
                        addBit(1); parserStep = STEP_SAVE_DURATION
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) {
                        addBit(0); parserStep = STEP_SAVE_DURATION
                    } else if (dd(duration, teShort * 50) < teDelta * 5) {
                        // Next gap: the last bit is read from its mark alone
                        if (dd(teLast, teLong) < teDelta) addBit(1)
                        if (dd(teLast, teShort) < teDelta) addBit(0)
                        if (decodeCountBit == minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val d = decodeData
        val yek = FG.reverseKey(d, dataCountBit) and 0xFFFFFL
        fun dip(check: Int): String {
            val sb = StringBuilder()
            var sh = 16
            while (sh >= 0) { sb.append(if (((d ushr sh) and 3L).toInt() == check) '*' else '_'); sh -= 2 }
            return sb.toString()
        }
        return RemoteInfo(RemoteFields.name(sensorType), 0L, null, null,
            listOf("Yek: 0x" + "%05X".format(yek), "+: " + dip(DIP_P), "o: " + dip(DIP_O), "-: " + dip(DIP_N)))
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_SAVE_DURATION = 1; private const val STEP_CHECK_DURATION = 2
        private const val DIP_P = 0b11; private const val DIP_O = 0b10; private const val DIP_N = 0b00
    }
}
