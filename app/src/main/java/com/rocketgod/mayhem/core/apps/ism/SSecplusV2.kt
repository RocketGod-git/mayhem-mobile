package com.rocketgod.mayhem.core.apps.ism

/** Security+ 2.0 garage remotes (Mayhem fprotos/s-secplus_v2.hpp). */
class SSecplusV2 : FProto(Fam.REMOTE, S.SECPLUS_V2) {
    private val manchester = Manchester()
    private var secplusPacket1 = 0L

    init { teShort = 250; teLong = 500; teDelta = 110; minCountBitForFound = 62; manchester.state = Manchester.MID0 }

    override fun feed(level: Boolean, duration: Int) {
        var event = Manchester.EVENT_RESET
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teLong * 130) < teDelta * 100) {
                // Found header Security+ 2.0
                parserStep = STEP_DECODER_DATA
                decodeData = 0; decodeCountBit = 0
                secplusPacket1 = 0
                manchester.advance(Manchester.EVENT_RESET)
                manchester.advance(Manchester.EVENT_LONG_HIGH)
                manchester.advance(Manchester.EVENT_SHORT_LOW)
            }
            STEP_DECODER_DATA -> {
                if (!level) {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_LOW
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_LOW
                    else if (duration >= teLong * 2 + teDelta) {
                        if (decodeCountBit == minCountBitForFound) {
                            dataCountBit = decodeCountBit
                            if (checkPacket()) { hit(); parserStep = STEP_RESET }
                        }
                        decodeData = 0; decodeCountBit = 0
                        manchester.advance(Manchester.EVENT_RESET)
                        manchester.advance(Manchester.EVENT_LONG_HIGH)
                        manchester.advance(Manchester.EVENT_SHORT_LOW)
                    } else parserStep = STEP_RESET
                } else {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_HIGH
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_HIGH
                    else parserStep = STEP_RESET
                }
                if (event != Manchester.EVENT_RESET) {
                    if (manchester.advance(event)) addBit(if (manchester.data) 1 else 0)
                }
            }
        }
    }

    private fun checkPacket(): Boolean {
        if ((decodeData and HEADER_MASK) == HEADER) {
            if ((decodeData and PACKET_MASK) == PACKET_1) secplusPacket1 = decodeData
            else if ((decodeData and PACKET_MASK) == PACKET_2 && secplusPacket1 != 0L) return true
        }
        return false
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_DECODER_DATA = 1
        private const val HEADER = 0x3C0000000000L
        private val HEADER_MASK = 0xFFFF3C0000000000uL.toLong()
        private const val PACKET_1 = 0x000000000000L
        private const val PACKET_2 = 0x010000000000L
        private const val PACKET_MASK = 0x30000000000L
    }
}
