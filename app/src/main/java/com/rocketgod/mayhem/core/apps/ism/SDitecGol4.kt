package com.rocketgod.mayhem.core.apps.ism

/**
 * Ditec GOL4 rolling-code remotes, 54-bit OOK PWM (Flipper Unleashed lib/subghz/protocols/ditec_gol4.c). Receive
 * only. The hop is only obfuscated (bit rotation + a fixed LCG, no manufacturer key), so serial, button and 16-bit
 * counter are recovered exactly as Flipper does.
 */
class SDitecGol4 : FProto(Fam.REMOTE, S.DITEC_GOL4) {
    init { teShort = 400; teLong = 1100; teDelta = 200; minCountBitForFound = 54 }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teLong * 22) < teLong * 4) { decodeData = 0; decodeCountBit = 0; parserStep = STEP_START_BIT }
            STEP_START_BIT -> parserStep = if (level && dd(duration, teShort * 2) < teDelta) STEP_SAVE_DURATION else STEP_RESET
            STEP_SAVE_DURATION -> if (!level) { teLast = duration; parserStep = STEP_CHECK_DURATION } else parserStep = STEP_RESET
            STEP_CHECK_DURATION -> {
                if (level) {
                    if (dd(teLast, teShort) < teDelta && dd(duration, teLong) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                    else if (dd(teLast, teLong) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE_DURATION }
                } else if (dd(teLast, teLong * 20) < teLong * 3) {
                    // The space before was the inter-frame gap
                    if (decodeCountBit == minCountBitForFound) { dataCountBit = minCountBitForFound; hit() }
                    decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val k = decodeKey(decodeData)
        return RemoteInfo(RemoteFields.name(sensorType), k.serial, k.btn, k.cnt, if (k.btn == 0) listOf("Prog mode") else emptyList())
    }

    data class Gol4Key(val serial: Long, val btn: Int, val cnt: Int)

    companion object {
        private const val STEP_RESET = 0; private const val STEP_START_BIT = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3

        private fun bitReverse8(v: Int): Int { var b = v and 0xFF; var r = 0; for (i in 0 until 8) { r = ((r shl 1) or (b and 1)) and 0xFF; b = b ushr 1 }; return r }
        private fun lcgStep(seed: Int, stepsIn: Int): Int { var x = seed and 0xFF; val steps = stepsIn and 0xFF; for (i in 0 until steps) x = (21 * x + 1) and 0xFF; return x }
        private fun lcgInverse(target: Int, stepsIn: Int): Int { val steps = stepsIn and 0xFF; return if (steps == 0) target and 0xFF else lcgStep(target, (256 - steps) and 0xFF) }

        /** Undo the GOL4 obfuscation in place on the 7 raw bytes (gol4_rolling_decode). */
        private fun gol4Decode(raw: IntArray) {
            var carry = 0
            for (r in 0 until 3) for (i in 2 until 7) { val nc = raw[i] and 1; raw[i] = ((raw[i] ushr 1) or (carry shl 7)) and 0xFF; carry = nc }
            raw[0] = bitReverse8(raw[0]); raw[1] = bitReverse8(raw[1]); raw[3] = bitReverse8(raw[3]); raw[4] = bitReverse8(raw[4])
            var b2 = raw[2] and 0xDF
            b2 = ((b2 shl 4) or (b2 ushr 4)) and 0xFF
            b2 = b2.inv() and 0xFF
            raw[2] = bitReverse8(b2)
            raw[5] = bitReverse8(raw[5]); raw[6] = bitReverse8(raw[6])
            if (raw[6] and 0x80 != 0) raw[5] = raw[5] xor 1
            raw[5] = lcgInverse(raw[5], 0xFE)
            raw[6] = lcgInverse(raw[6], raw[5])
            raw[5] = raw[5] xor 0xA7; raw[6] = raw[6] xor 0x69
        }

        /** Serial, button and counter of a 54-bit GOL4 key. */
        fun decodeKey(key: Long): Gol4Key {
            val raw = IntArray(7)
            for (i in 0 until 54) if (FG.bitRead(key, 53 - i) != 0) raw[i ushr 3] = raw[i ushr 3] or (1 shl (7 - (i and 7)))
            gol4Decode(raw)
            val serial = (raw[0].toLong() shl 24) or (raw[4].toLong() shl 16) or (raw[1].toLong() shl 8) or raw[3].toLong()
            return Gol4Key(serial, raw[2] and 0x0F, (raw[5] or (raw[6] shl 8)) and 0xFFFF)
        }
    }
}
