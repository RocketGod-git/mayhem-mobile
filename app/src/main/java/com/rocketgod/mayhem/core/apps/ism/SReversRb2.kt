package com.rocketgod.mayhem.core.apps.ism

/**
 * Revers RB2 / RB2M remotes, 433.92 MHz AM, 64-bit Manchester fixed code (Flipper Unleashed
 * lib/subghz/protocols/revers_rb2.c). A ~600 us LOW opens the frame, four short header half-bits stand for 0xF, then
 * Manchester at Te 250 us; a frame is accepted when byte [55:48] is 0xFF and the low 10 bits are the 0x200 stop code.
 * Serial = bits [47:10]. Receive only.
 */
class SReversRb2 : FProto(Fam.REMOTE, S.REVERS_RB2) {
    private var rx = 0L
    private val man = Manchester()
    init { teShort = 250; teLong = 500; teDelta = 160; minCountBitForFound = 64 }

    private fun addRbBit(bit: Boolean) {
        addBit(if (bit) 1 else 0)
        if (decodeCountBit >= 65) { decodeData = 0; decodeCountBit = 0; return }
        if (decodeCountBit < minCountBitForFound) return
        val preamble = (decodeData ushr 48) and 0xFFL
        val stopCode = decodeData and 0x3FFL
        if (preamble == 0xFFL && stopCode == 0x200L) {
            dataCountBit = decodeCountBit; rx = decodeData
            hit()
            decodeData = 0; decodeCountBit = 0
            man.advance(Manchester.EVENT_RESET)
        }
    }

    override fun feed(level: Boolean, duration: Int) {
        var event = Manchester.EVENT_RESET
        when (parserStep) {
            STEP_RESET -> if (!level && dd(duration, 600) < teDelta) {
                parserStep = STEP_HEADER; decodeData = 0; decodeCountBit = 0
                man.advance(Manchester.EVENT_RESET)
            }
            STEP_HEADER -> {
                if (dd(duration, teShort) < teDelta) {
                    if (!level) { if (teLast == 1) headerCount++; teLast = 0 }
                    else { if (teLast == 0) headerCount++; teLast = 1 }
                } else { headerCount = 0; teLast = 0; parserStep = STEP_RESET }
                if (headerCount == 4) {
                    headerCount = 0; decodeData = 0xFL; decodeCountBit = 4; parserStep = STEP_DECODER_DATA
                }
            }
            STEP_DECODER_DATA -> {
                if (!level) {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_LOW
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_LOW
                    else parserStep = STEP_RESET
                } else {
                    if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_HIGH
                    else if (dd(duration, teLong) < teDelta) event = Manchester.EVENT_LONG_HIGH
                    else parserStep = STEP_RESET
                }
                if (event != Manchester.EVENT_RESET && man.advance(event)) addRbBit(man.data)
            }
        }
    }

    override fun remoteInfo(): RemoteInfo? {
        if (dataCountBit != minCountBitForFound) return null
        val serial = ((rx and 0xFFFFFFFFFFFFL) ushr 10) and 0xFFFFFFFFL
        return RemoteInfo(RemoteFields.name(sensorType), serial, null, null, emptyList())
    }

    companion object { private const val STEP_RESET = 0; private const val STEP_HEADER = 1; private const val STEP_DECODER_DATA = 2 }
}
