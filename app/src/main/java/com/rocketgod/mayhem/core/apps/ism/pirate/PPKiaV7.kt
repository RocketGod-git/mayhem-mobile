// Port of ProtoPirate protocols/kia_v7.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Kia V7: FM, Manchester at 250 / 500 µs (events mapped the other way round from pp_manchester_event) after a
 * short-pair preamble and a long/short sync. 64 bits, stored inverted: a 0x4C header byte, a 16-bit counter, a
 * 28-bit serial, a button nibble and a CRC-8 (poly 0x7F, init 0x4C). Only frames with a good CRC are reported.
 */
class PPKiaV7 : PPDecoder("Kia V7", PPModulation.FM, PPConst(250, 500, 100, 64)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE = 1; private const val STEP_SYNC_LOW = 2; private const val STEP_DATA = 3
        private const val HEADER = 0x4C

        private fun buttonName(b: Int): String = when (b) { 1 -> "Lock"; 2 -> "Unlock"; 3, 8 -> "Trunk"; else -> "??" }
    }

    private var preambleCount = 0
    private var decodedButton = 0
    private var fixedHighByte = 0
    private var crcCalculated = 0
    private var crcRaw = 0
    private var crcValid = false

    init { manchester = PPManchester.START1 }   // calloc'd state

    /** kia_v7_decode_key_common */
    private fun decodeKey() {
        val b = PPMath.u64ToBytesBE(data)
        val ser = (b[3].toLong() shl 20) or (b[4].toLong() shl 12) or (b[5].toLong() shl 4) or (b[6].toLong() ushr 4)
        val counter = (b[1] shl 8) or b[2]
        val button = b[6] and 0x0F
        val calc = PPMath.crc8(b.copyOfRange(0, 7), 0x7F, 0x4C)
        serial = ser and 0x0FFFFFFF; btn = button; cnt = counter.toLong(); dataCountBit = 64
        decodedButton = button; fixedHighByte = b[0]; crcCalculated = calc; crcRaw = b[7]; crcValid = calc == b[7]
    }

    override fun reset() {
        parserStep = STEP_RESET; teLast = 0; decodeData = 0; decodeCountBit = 0; preambleCount = 0
        manchesterAdvance(PPManchester.RESET)
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && isShort(duration)) {
                parserStep = STEP_PREAMBLE; teLast = duration; preambleCount = 0
                manchesterAdvance(PPManchester.RESET)
            }
            STEP_PREAMBLE -> if (level) {
                if (isLong(duration) && isShort(teLast)) {
                    if (preambleCount > 15) {
                        decodeData = 0; decodeCountBit = 0; preambleCount = 0
                        addBit(1); addBit(0); addBit(1); addBit(1)
                        teLast = duration
                        parserStep = STEP_SYNC_LOW
                    } else parserStep = STEP_RESET
                } else if (isShort(duration)) teLast = duration
                else parserStep = STEP_RESET
            } else {
                if (isShort(duration) && isShort(teLast)) preambleCount = (preambleCount + 1) and 0xFFFF
                else parserStep = STEP_RESET
            }
            STEP_SYNC_LOW -> if (!level && isShort(duration) && isLong(teLast)) { teLast = duration; parserStep = STEP_DATA }
            STEP_DATA -> {
                if (isShort(duration) || isLong(duration)) {
                    val ev = if (isShort(duration)) (if (level) PPManchester.SHORT_HIGH else PPManchester.SHORT_LOW)
                    else (if (level) PPManchester.LONG_HIGH else PPManchester.LONG_LOW)
                    val bit = manchesterAdvance(ev)
                    if (bit >= 0) addBit(bit)
                }
                if (decodeCountBit == 64) {
                    val candidate = decodeData.inv()
                    if (((candidate ushr 56) and 0xFF).toInt() == HEADER) {
                        data = candidate; dataCountBit = 64
                        decodeKey()
                        if (crcValid) emit() else { data = 0; dataCountBit = 0 }
                    }
                    decodeData = 0; decodeCountBit = 0; parserStep = STEP_RESET
                    manchesterAdvance(PPManchester.RESET)
                }
            }
        }
    }

    override fun describe(): PPHit {
        decodeKey()
        return PPHit(name, dataCountBit, hx("%016X", data), serial and 0x0FFFFFFF,
            hx("%01X [", (decodedButton and 0x0F).toLong()) + buttonName(decodedButton) + "]", cnt and 0xFFFF,
            listOf(MeshField("CRC", hx("%02X [", crcCalculated.toLong()) + (if (crcValid) "OK" else "ERR") + "]")))
    }

    /** kia_v7.c get_string: "%s %dbit\r\nKey:%016llX\r\nSn:%07lX Cnt:%04lX\r\nBtn:%01X [%s] CRC:%02X [%s]". */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | Key:${h.key} | " + hx("Sn:%07X Cnt:%04X", h.serial ?: 0, h.cnt ?: 0) +
            " | Btn:${h.btn ?: ""} CRC:${h.fields.firstOrNull()?.value ?: ""}"
}
