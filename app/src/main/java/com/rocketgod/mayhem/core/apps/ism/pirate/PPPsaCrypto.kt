// Port of ProtoPirate protocols/psa_crypto.c (decoder-side helpers; GPL-3.0). The TEA encrypt is encoder-only and the
// TEA brute force (psa_crypto_bf.c) is never run during decode, so neither ships here.
package com.rocketgod.mayhem.core.apps.ism.pirate

object PPPsaCrypto {
    const val BF1_CONST_U4 = 0x0E0F5C41L
    const val BF1_CONST_U5 = 0x0F5C4123L
    const val BF1_START = 0x23000000L; const val BF1_END = 0x24000000L
    const val BF2_START = 0xF3000000L; const val BF2_END = 0xF4000000L
    val bf1KeySchedule = longArrayOf(0x4A434915L, 0xD6743C2BL, 0x1F29D308L, 0xE6B79A64L)
    val bf2KeySchedule = longArrayOf(0x4039C240L, 0xEDA92CABL, 0x4306C02AL, 0x02192A04L)

    /** psa_crypto_setup_byte_buffer: key1 big-endian into buffer[0..7], the low 16 bits of key2 into buffer[8..9]. */
    fun setupByteBuffer(buffer: IntArray, key1Low: Long, key1High: Long, key2Low: Long) {
        for (i in 0 until 8) {
            val shift = i * 8
            val byteVal = if (shift < 32) ((key1Low ushr shift) and 0xFF).toInt() else ((key1High ushr (shift - 32)) and 0xFF).toInt()
            buffer[7 - i] = byteVal
        }
        buffer[9] = (key2Low and 0xFF).toInt()
        buffer[8] = ((key2Low ushr 8) and 0xFF).toInt()
    }

    /** psa_crypto_prepare_tea_data */
    fun prepareTeaData(b: IntArray): Pair<Long, Long> {
        val w0 = (b[3].toLong() shl 16) or (b[2].toLong() shl 24) or (b[4].toLong() shl 8) or b[5].toLong()
        val w1 = (b[7].toLong() shl 16) or (b[6].toLong() shl 24) or (b[8].toLong() shl 8) or b[9].toLong()
        return Pair(w0, w1)
    }

    /** psa_crypto_tea_crc: the byte sum of v0 and the top three bytes of v1. */
    fun teaCrc(v0: Long, v1: Long): Int {
        var crc = ((v0 ushr 24) and 0xFF) + ((v0 ushr 16) and 0xFF) + ((v0 ushr 8) and 0xFF) + (v0 and 0xFF)
        crc += ((v1 ushr 24) and 0xFF) + ((v1 ushr 16) and 0xFF) + ((v1 ushr 8) and 0xFF)
        return (crc and 0xFF).toInt()
    }

    /** psa_crypto_crc16_bf2: CRC-16 poly 0x8005, init 0. */
    fun crc16Bf2(buffer: IntArray, length: Int): Int {
        var crc = 0
        for (i in 0 until length) {
            crc = crc xor (buffer[i] shl 8)
            repeat(8) { crc = if (crc and 0x8000 != 0) ((crc shl 1) xor 0x8005) and 0xFFFF else (crc shl 1) and 0xFFFF }
        }
        return crc
    }

    /** psa_crypto_unpack_tea_result_to_buffer */
    fun unpackTeaResult(b: IntArray, v0: Long, v1: Long) {
        b[2] = ((v0 ushr 24) and 0xFF).toInt(); b[3] = ((v0 ushr 16) and 0xFF).toInt()
        b[4] = ((v0 ushr 8) and 0xFF).toInt(); b[5] = (v0 and 0xFF).toInt()
        b[6] = ((v1 ushr 24) and 0xFF).toInt(); b[7] = ((v1 ushr 16) and 0xFF).toInt()
        b[8] = ((v1 ushr 8) and 0xFF).toInt(); b[9] = (v1 and 0xFF).toInt()
    }
}
