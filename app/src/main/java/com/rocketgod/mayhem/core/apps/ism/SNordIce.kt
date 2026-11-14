package com.rocketgod.mayhem.core.apps.ism

/**
 * Nord Ice remotes, 433.92 MHz AM, 33-bit fixed code (Flipper Unleashed lib/subghz/protocols/nord_ice.c). A press sends
 * a pair of frames that differ only in bit 14 (the frame flag), told apart by the gap that closes them (8980 / 7440
 * us); the decoder clears the flag so both frames report the same key. Layout: serial[32:15] | frame[14:13] |
 * one-hot button[12:9] | serial[8:0]. Receive only.
 */
class SNordIce : FProto(Fam.REMOTE, S.NORD_ICE) {
    private var rx = 0L
    init { teShort = 270; teLong = 760; teDelta = 150; minCountBitForFound = 33 }

    private fun isGap(duration: Int): Boolean {
        val gd = teDelta * 3
        return dd(duration, GAP_PLAIN) < gd || dd(duration, GAP_FLAGGED) < gd
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && isGap(duration)) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE_DURATION }
            STEP_SAVE_DURATION -> if (level) { teLast = duration; parserStep = STEP_CHECK_DURATION } else parserStep = STEP_RESET
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else if (isGap(duration)) {
                        // The last bit has only its high half; the gap stands in for the low half.
                        if (dd(teLast, teShort) < teDelta) addBit(0)
                        else if (dd(teLast, teLong) < teDelta) addBit(1)
                        if (decodeCountBit == minCountBitForFound) {
                            decodeData = decodeData and FRAME_FLAG.inv()
                            dataCountBit = decodeCountBit; rx = decodeData
                            hit()
                        }
                        // This gap also opens the next frame of the pair.
                        decodeData = 0; decodeCountBit = 0
                        parserStep = STEP_SAVE_DURATION
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val d = rx and FRAME_FLAG.inv()
        val serial = (((d ushr 15) shl 9) or (d and 0x1FFL)) and 0xFFFFFFFFL
        val btn = ((d ushr BTN_SHIFT) and 0xFL).toInt()
        val yek = FG.reverseKey(d, dataCountBit) and 0xFFFFFFFFFL
        return RemoteInfo(RemoteFields.name(sensorType), serial, btn, null, listOf("Yek: 0x" + "%08X".format(yek)))
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_SAVE_DURATION = 1; private const val STEP_CHECK_DURATION = 2
        private const val FRAME_FLAG = 1L shl 14
        private const val GAP_FLAGGED = 8980; private const val GAP_PLAIN = 7440
        private const val BTN_SHIFT = 9
    }
}
