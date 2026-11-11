// Port of ProtoPirate protocols/fiat_v0.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Fiat V0: AM, Manchester at 200 / 400 µs after 150+ short preamble pulses and an 800 µs gap; 71 bits: a 32-bit
 * hop, a 32-bit fixed part (serial), and a 6-bit end byte (the button).
 */
class PPFiatV0 : PPDecoder("Fiat V0", PPModulation.AM, PPConst(200, 400, 100, 64)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE = 1; private const val STEP_DATA = 2
        private const val PREAMBLE_PAIRS = 150; private const val GAP_US = 800
    }

    private var preambleCount = 0   // uint16
    private var dataLow = 0L
    private var dataHigh = 0L
    private var bitCount = 0        // uint8
    private var hop = 0L
    private var fix = 0L
    private var endbyte = 0

    override fun reset() {
        super.reset()
        preambleCount = 0; dataLow = 0; dataHigh = 0; bitCount = 0; hop = 0; fix = 0; endbyte = 0
    }

    private fun finishPacket() {
        data = (hop shl 32) or fix
        dataCountBit = 71
        serial = fix
        btn = endbyte
        cnt = hop
        decodeData = data
        decodeCountBit = dataCountBit
        emit()
        dataLow = 0; dataHigh = 0; bitCount = 0
        parserStep = STEP_RESET
    }

    private fun startData() {
        parserStep = STEP_DATA
        preambleCount = 0; dataLow = 0; dataHigh = 0; bitCount = 0
        manchesterAdvance(PPManchester.RESET)
    }

    override fun feed(level: Boolean, duration: Int) {
        val teShort = c.teShort; val teLong = c.teLong; val teDelta = c.teDelta
        when (parserStep) {
            STEP_RESET -> {
                if (!level) return
                if (dd(duration, teShort) < teDelta) {
                    dataLow = 0; dataHigh = 0
                    parserStep = STEP_PREAMBLE
                    preambleCount = 0; bitCount = 0; decodeData = 0; decodeCountBit = 0
                    manchesterAdvance(PPManchester.RESET)
                }
            }
            STEP_PREAMBLE -> {
                if (level) {
                    if (dd(duration, teShort) < teDelta) preambleCount = (preambleCount + 1) and 0xFFFF else parserStep = STEP_RESET
                    return
                }
                if (dd(duration, teShort) < teDelta) {
                    preambleCount = (preambleCount + 1) and 0xFFFF
                } else {
                    if (preambleCount >= PREAMBLE_PAIRS && dd(duration, GAP_US) < teDelta) { startData(); return }
                    parserStep = STEP_RESET
                }
                if (preambleCount >= PREAMBLE_PAIRS && parserStep == STEP_PREAMBLE && dd(duration, GAP_US) < teDelta) {
                    startData(); return
                }
            }
            STEP_DATA -> {
                var event = PPManchester.RESET
                if (dd(duration, teShort) < teDelta) event = if (level) PPManchester.SHORT_LOW else PPManchester.SHORT_HIGH
                else if (duration >= teShort && dd(duration, teLong) < teDelta) event = if (level) PPManchester.LONG_LOW else PPManchester.LONG_HIGH
                if (event != PPManchester.RESET) {
                    val bit = manchesterAdvance(event)
                    if (bit >= 0) {
                        val carry = (dataLow ushr 31) and 1
                        dataLow = ((dataLow shl 1) or bit.toLong()) and M32
                        dataHigh = ((dataHigh shl 1) or carry) and M32
                        bitCount = (bitCount + 1) and 0xFF
                        if (bitCount == 64) { fix = dataLow; hop = dataHigh; dataLow = 0; dataHigh = 0 }
                        if (bitCount == 0x47) { endbyte = (dataLow and 0x3F).toInt(); finishPacket() }
                    }
                } else {
                    if (bitCount == 0x47) { endbyte = (dataLow and 0x3F).toInt(); finishPacket() }
                    else if (bitCount < 64) parserStep = STEP_RESET
                }
            }
        }
    }

    override fun describe(): PPHit {
        val low = endbyte and 0x0F
        val suffix = if (low in 0x04..0x07) "Lock" else if (low in 0x08..0x0B) "Unlock" else "??"
        return PPHit(name, dataCountBit, hx("%08X%08X", hop, fix), fix, hx("%02X", (endbyte and 0x3F).toLong()), hop,
            listOf(MeshField("Hop", hx("%08X", hop)),
                MeshField("EndByte", hx("%02X", (endbyte and 0x3F).toLong())),
                MeshField("Action", suffix)))
    }

    /** fiat_v0.c get_string: "%s %dbit\r\nKey:%08lX%08lX\r\nHop:%08lX\r\nSn:%08lX\r\nEndByte:%02X\r\n". */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | Key:${h.key} | Hop:${h.fields[0].value} | " + hx("Sn:%08X", h.serial ?: 0) +
            " | EndByte:${h.fields[1].value}"
}
