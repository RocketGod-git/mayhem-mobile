package com.rocketgod.mayhem.core.apps.ism

/**
 * Beninca ARC rolling-code remotes, 128-bit OOK PWM, AES-128 encrypted (Flipper Unleashed
 * lib/subghz/protocols/beninca_arc.c). Receive only. Serial, button and counter are inside the AES block, which needs
 * the manufacturer key, so only the two raw 64-bit halves are shown (Key1 = decodeData, Key2 = decodeData2).
 */
class SBenincaArc : FProto(Fam.REMOTE, S.BENINCA_ARC) {
    /** generic.data in Flipper: the first 64 bits, kept until the next frame overwrites it. */
    private var dataHi = 0L

    init { teShort = 300; teLong = 600; teDelta = 155; minCountBitForFound = 128 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_START -> if (!level && dd(duration, teLong * 16) < teDelta * 15) {
                // Gap (9600 +- 2325 us) found
                decodeData = 0; decodeCountBit = 0; parserStep = STEP_HIGH
            }
            STEP_HIGH -> {
                if (level) {
                    teLast = duration; parserStep = STEP_LOW
                    if (decodeCountBit == minCountBitForFound / 2 && decodeData != 0L) {
                        // First 64 bits captured
                        dataHi = decodeData; decodeData = 0
                    } else if (decodeCountBit == minCountBitForFound) {
                        // All 128 bits captured (this mark is the stop bit)
                        val lo = decodeData
                        decodeData = dataHi; decodeData2 = lo; dataCountBit = decodeCountBit
                        parserStep = STEP_START
                        hit()
                    }
                } else parserStep = STEP_START
            }
            STEP_LOW -> {
                if (!level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(1); parserStep = STEP_HIGH }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_HIGH }
                    else parserStep = STEP_START
                } else parserStep = STEP_START
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        return RemoteInfo(RemoteFields.name(sensorType), 0L, null, null, listOf("Key2: " + "%016X".format(decodeData2), "Hop: AES-128 encrypted"))
    }

    companion object { private const val STEP_START = 0; private const val STEP_HIGH = 1; private const val STEP_LOW = 2 }
}
