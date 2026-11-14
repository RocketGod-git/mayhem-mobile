package com.rocketgod.mayhem.core.apps.ism

/** Hollarm 42-bit OOK alarm remotes with a byte-sum check (Flipper Unleashed lib/subghz/protocols/hollarm.c). Receive only. */
class SHollarm : FProto(Fam.REMOTE, S.HOLLARM) {
    private var gData = 0L
    init { teShort = 200; teLong = 1000; teDelta = 200; minCountBitForFound = 42 }

    override fun feed(level: Boolean, duration: Int) {
        val gap = teShort * 12
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, gap) < teDelta * 2) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_SAVE }
            STEP_SAVE -> if (level) { teLast = duration; parserStep = STEP_CHECK } else parserStep = STEP_RESET
            STEP_CHECK -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(0); parserStep = STEP_SAVE }
                    else if (dd(teLast, teShort) < teDelta && dd(duration, teShort * 8) < teDelta) { addBit(1); parserStep = STEP_SAVE }
                    else if (dd(duration, gap) < teDelta) {
                        // Next gap: the last pulse counts as a 0
                        addBit(0)
                        if (decodeCountBit == minCountBitForFound) {
                            val data = decodeData ushr 2 // kept 2 bits to the right for parsing
                            if (byteSum(data) == (data and 0xFFL).toInt()) {
                                gData = data; decodeData = data; dataCountBit = decodeCountBit
                                hit()
                            }
                        }
                        decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val btn = ((gData ushr 8) and 0xFL).toInt()
        return RemoteInfo(RemoteFields.name(sensorType), (gData and 0xFFFFFFF0000L) ushr 16, btn, null,
            listOf("Sum: " + "%02X".format(byteSum(gData)), "Button: " + BUTTONS[btn]))
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_SAVE = 1; private const val STEP_CHECK = 2
        private val BUTTONS = arrayOf("Unknown", "Disarm", "Arm", "0x3", "Ringtone/Alarm", "0x5", "0x6", "0x7", "Ring", "Settings mode", "Exit settings",
            "Vibro sens. setting", "Not used (in settings)", "Volume setting", "0xE", "0xF")
        /** Sum of bytes 4..1, mod 256 (the remote sends it as byte 0). */
        private fun byteSum(d: Long): Int =
            (((d ushr 32) and 0xFFL) + ((d ushr 24) and 0xFFL) + ((d ushr 16) and 0xFFL) + ((d ushr 8) and 0xFFL)).toInt() and 0xFF
    }
}
