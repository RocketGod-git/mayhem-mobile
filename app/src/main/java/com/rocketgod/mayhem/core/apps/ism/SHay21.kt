package com.rocketgod.mayhem.core.apps.ism

/** Hay21 21-bit OOK remotes with a 4-bit counter (Flipper Unleashed lib/subghz/protocols/hay21.c). Receive only. */
class SHay21 : FProto(Fam.REMOTE, S.HAY21) {
    private var gData = 0L
    init { teShort = 300; teLong = 700; teDelta = 150; minCountBitForFound = 21 }

    override fun feed(level: Boolean, duration: Int) {
        val gap = teLong * 6
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, gap) < teDelta * 3) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(duration, gap) < teDelta * 2) {
                        // Next gap: the last bit is read from its high alone
                        if (dd(teLast, teLong) < teDelta) addBit(1)
                        if (dd(teLast, teShort) < teDelta) addBit(0)
                        if (decodeCountBit == minCountBitForFound) { gData = decodeData; dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val btn = ((gData ushr 13) and 0xFFL).toInt()
        return RemoteInfo(RemoteFields.name(sensorType), (gData ushr 5) and 0xFFL, btn, ((gData ushr 1) and 0xFL).toInt(), listOf("Button: " + buttonName(btn)))
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2
        private fun buttonName(btn: Int): String = when (btn) { 0x5A -> "On/Off"; 0xC3 -> "Mode"; 0x88 -> "Hold"; else -> "Unknown" }
    }
}
