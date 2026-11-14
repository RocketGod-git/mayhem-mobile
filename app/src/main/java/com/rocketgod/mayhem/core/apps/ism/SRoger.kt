package com.rocketgod.mayhem.core.apps.ism

/**
 * Roger gate remotes, 433.92 MHz AM, 28-bit fixed code (Flipper Unleashed lib/subghz/protocols/roger.c). PWM at Te
 * 500 us: bit 1 = HIGH 2Te + LOW Te, bit 0 = HIGH Te + LOW 2Te, MSB first, frame closed by a ~19 Te LOW that also stands
 * in for the last bit's low half. Layout: serial(16) | button(4) | end(8). Receive only.
 */
class SRoger : FProto(Fam.REMOTE, S.ROGER) {
    private var rx = 0L
    init { teShort = 500; teLong = 1000; teDelta = 270; minCountBitForFound = 28 }

    private fun isGap(duration: Int): Boolean = dd(duration, teShort * 19) < teDelta * 5

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && isGap(duration)) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE_DURATION }
            STEP_SAVE_DURATION -> if (level) { teLast = duration; parserStep = STEP_CHECK_DURATION } else parserStep = STEP_RESET
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE_DURATION }
                    else if (isGap(duration)) {
                        // Closing gap: the last bit has only its high half.
                        if (dd(teLast, teLong) < teDelta) addBit(1)
                        if (dd(teLast, teShort) < teDelta) addBit(0)
                        if (decodeCountBit == minCountBitForFound) {
                            dataCountBit = decodeCountBit; rx = decodeData
                            hit()
                        }
                        decodeData = 0; decodeCountBit = 0
                        parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        return RemoteInfo(RemoteFields.name(sensorType), (rx ushr 12) and 0xFFFFFFFFL, ((rx ushr 8) and 0xFL).toInt(), null,
            listOf("End: 0x" + "%02X".format((rx and 0xFFL).toInt())))
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE_DURATION = 1; private const val STEP_CHECK_DURATION = 2 }
}
