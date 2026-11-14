package com.rocketgod.mayhem.core.apps.ism

/** FAAC TM 12-bit DIP-switch OOK remotes (Flipper Unleashed lib/subghz/protocols/faac_tm.c). Receive only. */
class SFaacTm : FProto(Fam.REMOTE, S.FAAC_TM) {
    /** Running sum of the frame's durations, then the measured Te (Flipper's instance->te). */
    private var te = 0
    private var gTe = 0
    private var gData = 0L
    init { teShort = 400; teLong = 800; teDelta = 120; minCountBitForFound = 12 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * HEADER_TE) < teDelta * HEADER_TE) parserStep = STEP_START_BIT
            STEP_START_BIT -> {
                if (!level) return
                if (dd(duration, teShort) < teDelta) { parserStep = STEP_SAVE; decodeData = 0; decodeCountBit = 0; te = duration }
                else parserStep = STEP_RESET
            }
            STEP_SAVE -> {
                if (!level) {
                    if (duration >= teShort * 4) {
                        parserStep = STEP_START_BIT
                        if (decodeCountBit == minCountBitForFound) {
                            // start bit plus 3 Te per bit
                            te /= (decodeCountBit * 3 + 1)
                            gTe = te; gData = decodeData; dataCountBit = decodeCountBit
                            hit()
                        }
                        return
                    }
                    teLast = duration; te += duration; parserStep = STEP_CHECK
                } else parserStep = STEP_RESET
            }
            STEP_CHECK -> {
                if (level) {
                    te += duration
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val d = (gData and 0xFFFL).toInt()
        val dip = StringBuilder()
        for (b in 11 downTo 0) dip.append(if ((d shr b) and 1 != 0) '1' else '0')
        return RemoteInfo(RemoteFields.name(sensorType), 0L, null, null, listOf("Te: ${gTe}us", "DIP: $dip"))
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_START_BIT = 1; private const val STEP_SAVE = 2; private const val STEP_CHECK = 3
        private const val HEADER_TE = 35
    }
}
