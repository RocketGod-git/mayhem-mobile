package com.rocketgod.mayhem.core.apps.ism

/** Honeywell / 2GIG security sensors, Manchester coded (Mayhem fprotos/s-honeywell.hpp). */
class SHoneywell : FProto(Fam.REMOTE, S.HONEYWELL) {
    init { teShort = 280; teLong = 143; teDelta = 51; minCountBitForFound = 62 }

    private val manchester = Manchester()

    override fun feed(level: Boolean, duration: Int) {
        var event = Manchester.EVENT_RESET
        if (!level) {
            if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_LOW
            else if (dd(duration, teLong) < teDelta * 2) event = Manchester.EVENT_LONG_LOW
        } else {
            if (dd(duration, teShort) < teDelta) event = Manchester.EVENT_SHORT_HIGH
            else if (dd(duration, teLong) < teDelta * 2) event = Manchester.EVENT_LONG_HIGH
        }
        if (event != Manchester.EVENT_RESET) {
            if (manchester.advance(event)) honeywellAddBit(manchester.data)
        } else { decodeData = 0; decodeCountBit = 0 }
    }

    private fun honeywellAddBit(bit: Boolean) {
        addBit(if (bit) 1 else 0)

        val preamble = ((decodeData ushr 48) and 0xFFFF).toInt()
        // can be multiple, since flipper can't read it well..
        if (preamble == 0b0011111111111110 || preamble == 0b0111111111111110 || preamble == 0b1111111111111110) {
            val dataToCrc = IntArray(4)
            dataToCrc[0] = ((decodeData ushr 40) and 0xFF).toInt()
            dataToCrc[1] = ((decodeData ushr 32) and 0xFF).toInt()
            dataToCrc[2] = ((decodeData ushr 24) and 0xFF).toInt()
            dataToCrc[3] = ((decodeData ushr 16) and 0xFF).toInt()
            val channel = ((decodeData ushr 44) and 0xF).toInt()
            val crcCalc = if (channel == 0x2 || channel == 0x4 || channel == 0xA) crc16(dataToCrc, 4, 0x8050, 0) // 2GIG brand
            else crc16(dataToCrc, 4, 0x8005, 0) // channel == 0x8
            val crc = (decodeData and 0xFFFF).toInt()
            if (crc == crcCalc) {
                // the data is good. process it.
                dataCountBit = decodeCountBit
                hit()
                decodeData = 0; decodeCountBit = 0
            } else return
        }
    }

    private fun crc16(message: IntArray, nBytes: Int, polynomial: Int, init: Int): Int {
        var remainder = init and 0xFFFF
        for (b in 0 until nBytes) {
            remainder = remainder xor ((message[b] shl 8) and 0xFFFF)
            for (bit in 0 until 8) remainder = if (remainder and 0x8000 != 0) ((remainder shl 1) xor polynomial) and 0xFFFF else (remainder shl 1) and 0xFFFF
        }
        return remainder
    }
}
