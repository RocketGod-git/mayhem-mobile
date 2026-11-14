package com.rocketgod.mayhem.core.apps.ism

/**
 * Doorbell32 wireless doorbells, 32-bit OOK PWM 1:3 with a 14*Te guard; Te is measured from the signal (Flipper
 * Unleashed lib/subghz/protocols/doorbell32.c). Receive only. A key is reported only once two consecutive frames match.
 */
class SDoorbell32 : FProto(Fam.REMOTE, S.DOORBELL32) {
    /** Measured Te in us (sum of all pulses / 129 once a frame is complete). */
    var te = 0
    private var lastData = 0L

    init { teShort = 515; teLong = 1545; teDelta = 200; minCountBitForFound = 32 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * GUARD_TIME) < teDelta * GUARD_TIME / 2) {
                parserStep = STEP_SAVE_DURATION; decodeData = 0; decodeCountBit = 0; te = 0
            }
            STEP_SAVE_DURATION -> if (level) { teLast = duration; te += duration; parserStep = STEP_CHECK_DURATION } else parserStep = STEP_RESET
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (duration >= teLong * 2) {
                        // Guard reached, the frame ends here
                        if (decodeCountBit == minCountBitForFound && lastData == decodeData && lastData != 0L) {
                            te /= (decodeCountBit * 4 + 1)
                            dataCountBit = decodeCountBit
                            hit()
                        }
                        lastData = decodeData
                        decodeData = 0; decodeCountBit = 0; te = 0
                        parserStep = STEP_SAVE_DURATION
                        return
                    }
                    te += duration
                    // Bit 0 is short mark + long space, bit 1 the other way round
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta * 2) { addBit(0); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teLong) < teDelta * 2 && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        return RemoteInfo(RemoteFields.name(sensorType), 0L, null, null, listOf("Te: $te us"))
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_SAVE_DURATION = 1; private const val STEP_CHECK_DURATION = 2
        private const val GUARD_TIME = 14
    }
}
