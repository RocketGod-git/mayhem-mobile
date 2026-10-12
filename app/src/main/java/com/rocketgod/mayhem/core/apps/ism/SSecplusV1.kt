package com.rocketgod.mayhem.core.apps.ism

/** Security+ 1.0 garage remotes (Mayhem fprotos/s-secplus_v1.hpp). */
class SSecplusV1 : FProto(Fam.REMOTE, S.SECPLUS_V1) {
    init { teShort = 500; teLong = 1500; teDelta = 100; minCountBitForFound = 21 }

    private var packetAccepted = 0
    private var basePacketIndex = 0
    private val dataArray = IntArray(44)

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, teShort * 120) < teDelta * 120) {
                // Found header Security+ 1.0
                parserStep = STEP_SEARCH_START_BIT
                decodeData = 0; decodeCountBit = 0
                packetAccepted = 0
                dataArray.fill(0)
            }
            STEP_SEARCH_START_BIT -> {
                if (level) {
                    if (dd(duration, teShort) < teDelta) {
                        basePacketIndex = PACKET_1_INDEX_BASE
                        dataArray[decodeCountBit + basePacketIndex] = BIT_0
                        decodeCountBit++
                        parserStep = STEP_SAVE
                    } else if (dd(duration, teLong) < teDelta) {
                        basePacketIndex = PACKET_2_INDEX_BASE
                        dataArray[decodeCountBit + basePacketIndex] = BIT_2
                        decodeCountBit++
                        parserStep = STEP_SAVE
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
            STEP_SAVE -> {
                if (!level) {
                    if (dd(duration, teShort * 120) < teDelta * 120) {
                        if (decodeCountBit == minCountBitForFound) {
                            if (basePacketIndex == PACKET_1_INDEX_BASE) packetAccepted = packetAccepted or PACKET_1_ACCEPTED
                            if (basePacketIndex == PACKET_2_INDEX_BASE) packetAccepted = packetAccepted or PACKET_2_ACCEPTED
                            if (packetAccepted == (PACKET_1_ACCEPTED or PACKET_2_ACCEPTED)) { hit(); parserStep = STEP_RESET }
                        }
                        parserStep = STEP_SEARCH_START_BIT
                        decodeData = 0; decodeCountBit = 0
                    } else { teLast = duration; parserStep = STEP_DECODER_DATA }
                } else parserStep = STEP_RESET
            }
            STEP_DECODER_DATA -> {
                if (level && decodeCountBit <= minCountBitForFound) {
                    if (dd(teLast, teShort * 3) < teDelta * 3 && dd(duration, teShort) < teDelta) {
                        dataArray[decodeCountBit + basePacketIndex] = BIT_0
                        decodeCountBit++
                        parserStep = STEP_SAVE
                    } else if (dd(teLast, teShort * 2) < teDelta * 2 && dd(duration, teShort * 2) < teDelta * 2) {
                        dataArray[decodeCountBit + basePacketIndex] = BIT_1
                        decodeCountBit++
                        parserStep = STEP_SAVE
                    } else if (dd(teLast, teShort) < teDelta && dd(duration, teShort * 3) < teDelta * 3) {
                        dataArray[decodeCountBit + basePacketIndex] = BIT_2
                        decodeCountBit++
                        parserStep = STEP_SAVE
                    } else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            }
        }
    }

    companion object {
        private const val STEP_RESET = 0; private const val STEP_SEARCH_START_BIT = 1; private const val STEP_SAVE = 2; private const val STEP_DECODER_DATA = 3
        private const val BIT_0 = 0; private const val BIT_1 = 1; private const val BIT_2 = 2
        private const val PACKET_1_INDEX_BASE = 0; private const val PACKET_2_INDEX_BASE = 21
        private const val PACKET_1_ACCEPTED = 1 shl 0; private const val PACKET_2_ACCEPTED = 1 shl 1
    }
}
