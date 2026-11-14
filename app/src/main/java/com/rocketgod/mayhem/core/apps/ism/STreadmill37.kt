package com.rocketgod.mayhem.core.apps.ism

/**
 * Treadmill37 (QH-433) treadmill remotes, 433.92 MHz AM, 37-bit fixed code (Flipper Unleashed
 * lib/subghz/protocols/treadmill37.c). PWM at Te 300 us: bit 0 = HIGH Te + LOW 3Te, bit 1 = HIGH 3Te + LOW Te, MSB
 * first, frame closed by a ~20 Te LOW that stands in for the last bit's low half. Layout: serial(20) | button code(16)
 * | stop(1); Flipper prints the 16-bit code as "Btn". Receive only.
 */
class STreadmill37 : FProto(Fam.REMOTE, S.TREADMILL37) {
    private var rx = 0L
    init { teShort = 300; teLong = 900; teDelta = 150; minCountBitForFound = 37 }

    private fun isGap(duration: Int): Boolean = dd(duration, teShort * 20) < teDelta * 4

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && isGap(duration)) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE_DURATION }
            STEP_SAVE_DURATION -> if (level) { teLast = duration; parserStep = STEP_CHECK_DURATION } else parserStep = STEP_RESET
            STEP_CHECK_DURATION -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else if (isGap(duration)) {
                        // Closing gap: the last bit has only its high half.
                        if (dd(teLast, teShort) < teDelta) addBit(0)
                        if (dd(teLast, teLong) < teDelta) addBit(1)
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
        val yek = FG.reverseKey(rx, dataCountBit) and 0xFFFFFFFFFFL
        return RemoteInfo(RemoteFields.name(sensorType), (rx ushr 17) and 0xFFFFFFFFL, ((rx ushr 1) and 0xFFFFL).toInt(), null,
            listOf("Yek: 0x" + "%08X".format(yek)))
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE_DURATION = 1; private const val STEP_CHECK_DURATION = 2 }
}
