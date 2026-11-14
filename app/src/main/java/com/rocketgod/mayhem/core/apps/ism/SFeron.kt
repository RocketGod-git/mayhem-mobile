package com.rocketgod.mayhem.core.apps.ism

/** Feron 32-bit OOK light remotes (Flipper Unleashed lib/subghz/protocols/feron.c). Receive only. */
class SFeron : FProto(Fam.REMOTE, S.FERON) {
    private var gData = 0L
    init { teShort = 350; teLong = 750; teDelta = 150; minCountBitForFound = 32 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teLong * 6) < teDelta * 4) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(duration, teShort + 150) < teDelta) {
                        // End of the key: 500 us low (here), then 500 us high
                        if (dd(teLast, teShort) < teDelta) addBit(0)
                        if (dd(teLast, teLong) < teDelta) addBit(1)
                        if (decodeCountBit == minCountBitForFound) { gData = decodeData; dataCountBit = decodeCountBit; hit() }
                        decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val cmd = (gData and 0xFFFFL).toInt()
        return RemoteInfo(RemoteFields.name(sensorType), (gData ushr 16) and 0xFFFFL, null, null, listOf("Command: 0x" + "%04X".format(cmd)))
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2 }
}
