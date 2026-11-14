package com.rocketgod.mayhem.core.apps.ism

/**
 * Ansonic gate remotes, 12-bit FM PWM, 10 DIP switches + 2-bit key (Flipper Unleashed lib/subghz/protocols/ansonic.c).
 * Receive only.
 */
class SAnsonic : FProto(Fam.REMOTE, S.ANSONIC) {
    init { teShort = 555; teLong = 1111; teDelta = 120; minCountBitForFound = 12 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 35) < teDelta * 35) parserStep = STEP_FOUND_START_BIT // header
            STEP_FOUND_START_BIT -> {
                if (!level) return
                if (dd(duration, teShort) < teDelta) { parserStep = STEP_SAVE_DURATION; decodeData = 0; decodeCountBit = 0 }
                else parserStep = STEP_RESET
            }
            STEP_SAVE_DURATION -> {
                if (!level) {
                    if (duration >= teShort * 4) {
                        parserStep = STEP_FOUND_START_BIT
                        if (decodeCountBit >= minCountBitForFound) { dataCountBit = decodeCountBit; hit() }
                        return
                    }
                    teLast = duration; parserStep = STEP_CHECK_DURATION
                } else parserStep = STEP_RESET
            }
            STEP_CHECK_DURATION -> {
                if (level) {
                    // Reject anything whose bit rate is not Ansonic's
                    if (dd(teLast + duration, teShort + teLong) >= TE_SUM_DELTA) { parserStep = STEP_RESET; return }
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE_DURATION }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit < minCountBitForFound) return null
        val dip = (decodeData and 0xFFFL).toInt()
        val btn = ((decodeData ushr 1) and 3L).toInt()
        return RemoteInfo(RemoteFields.name(sensorType), 0L, btn, null, listOf("DIP: " + DIP_MASKS.joinToString("") { if (dip and it != 0) "1" else "0" }))
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_FOUND_START_BIT = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3
        /** A bit (mark + space) must add up to te_short + te_long within this many us. */
        private const val TE_SUM_DELTA = 110
        /** DIP switches 1..8, 10, 9 as Flipper prints them. */
        private val DIP_MASKS = intArrayOf(0x0800, 0x0400, 0x0200, 0x0100, 0x0080, 0x0040, 0x0020, 0x0010, 0x0001, 0x0008)
    }
}
