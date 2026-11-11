// Port of ProtoPirate protocols/kia_v6.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Kia V6: FM, Manchester at 200 / 400 µs (events mapped the other way round from pp_manchester_event) after a
 * preamble of 601+ short pairs and a long sync, 144 bits (stored inverted). The last 16 bytes are AES-128
 * encrypted with a key built from two manufacturer keystores; the plaintext holds serial, button, a 32-bit counter
 * and two CRC bytes.
 */
class PPKiaV6 : PPDecoder("Kia V6", PPModulation.FM, PPConst(200, 400, 100, 144)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_WAIT_FIRST_HIGH = 1; private const val STEP_WAIT_LONG_HIGH = 2; private const val STEP_DATA = 3
        private const val XOR_MASK_LOW = 0x84AF25FBL; private const val XOR_MASK_HIGH = 0x638766ABL

        private val sbox = intArrayOf(0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
        0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
        0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
        0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
        0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
        0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
        0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
        0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
        0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
        0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
        0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
        0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
        0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
        0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
        0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
        0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16)
        private val sboxInv = intArrayOf(0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb,
        0x7c, 0xe3, 0x39, 0x82, 0x9b, 0x2f, 0xff, 0x87, 0x34, 0x8e, 0x43, 0x44, 0xc4, 0xde, 0xe9, 0xcb,
        0x54, 0x7b, 0x94, 0x32, 0xa6, 0xc2, 0x23, 0x3d, 0xee, 0x4c, 0x95, 0x0b, 0x42, 0xfa, 0xc3, 0x4e,
        0x08, 0x2e, 0xa1, 0x66, 0x28, 0xd9, 0x24, 0xb2, 0x76, 0x5b, 0xa2, 0x49, 0x6d, 0x8b, 0xd1, 0x25,
        0x72, 0xf8, 0xf6, 0x64, 0x86, 0x68, 0x98, 0x16, 0xd4, 0xa4, 0x5c, 0xcc, 0x5d, 0x65, 0xb6, 0x92,
        0x6c, 0x70, 0x48, 0x50, 0xfd, 0xed, 0xb9, 0xda, 0x5e, 0x15, 0x46, 0x57, 0xa7, 0x8d, 0x9d, 0x84,
        0x90, 0xd8, 0xab, 0x00, 0x8c, 0xbc, 0xd3, 0x0a, 0xf7, 0xe4, 0x58, 0x05, 0xb8, 0xb3, 0x45, 0x06,
        0xd0, 0x2c, 0x1e, 0x8f, 0xca, 0x3f, 0x0f, 0x02, 0xc1, 0xaf, 0xbd, 0x03, 0x01, 0x13, 0x8a, 0x6b,
        0x3a, 0x91, 0x11, 0x41, 0x4f, 0x67, 0xdc, 0xea, 0x97, 0xf2, 0xcf, 0xce, 0xf0, 0xb4, 0xe6, 0x73,
        0x96, 0xac, 0x74, 0x22, 0xe7, 0xad, 0x35, 0x85, 0xe2, 0xf9, 0x37, 0xe8, 0x1c, 0x75, 0xdf, 0x6e,
        0x47, 0xf1, 0x1a, 0x71, 0x1d, 0x29, 0xc5, 0x89, 0x6f, 0xb7, 0x62, 0x0e, 0xaa, 0x18, 0xbe, 0x1b,
        0xfc, 0x56, 0x3e, 0x4b, 0xc6, 0xd2, 0x79, 0x20, 0x9a, 0xdb, 0xc0, 0xfe, 0x78, 0xcd, 0x5a, 0xf4,
        0x1f, 0xdd, 0xa8, 0x33, 0x88, 0x07, 0xc7, 0x31, 0xb1, 0x12, 0x10, 0x59, 0x27, 0x80, 0xec, 0x5f,
        0x60, 0x51, 0x7f, 0xa9, 0x19, 0xb5, 0x4a, 0x0d, 0x2d, 0xe5, 0x7a, 0x9f, 0x93, 0xc9, 0x9c, 0xef,
        0xa0, 0xe0, 0x3b, 0x4d, 0xae, 0x2a, 0xf5, 0xb0, 0xc8, 0xeb, 0xbb, 0x3c, 0x83, 0x53, 0x99, 0x61,
        0x17, 0x2b, 0x04, 0x7e, 0xba, 0x77, 0xd6, 0x26, 0xe1, 0x69, 0x14, 0x63, 0x55, 0x21, 0x0c, 0x7d)
        private val rcon = intArrayOf(0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36)

        // ---- AES-128 decryption, as kia_v6.c writes it ----
        private fun gfMul2(x: Int): Int = (((x ushr 7) * 0x1b) xor (x shl 1)) and 0xFF

        private fun subBytesInv(s: IntArray) { for (i in 0 until 16) s[i] = sboxInv[s[i]] }

        private fun shiftRowsInv(s: IntArray) {
            var t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t
            t = s[2]; s[2] = s[10]; s[10] = t
            t = s[6]; s[6] = s[14]; s[14] = t
            t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t
        }

        private fun mixColumnsInv(s: IntArray) {
            for (i in 0 until 4) {
                val a = s[i * 4]; val b = s[i * 4 + 1]; val c = s[i * 4 + 2]; val d = s[i * 4 + 3]
                val a2 = gfMul2(a); val a4 = gfMul2(a2); val a8 = gfMul2(a4)
                val b2 = gfMul2(b); val b4 = gfMul2(b2); val b8 = gfMul2(b4)
                val c2 = gfMul2(c); val c4 = gfMul2(c2); val c8 = gfMul2(c4)
                val d2 = gfMul2(d); val d4 = gfMul2(d2); val d8 = gfMul2(d4)
                s[i * 4] = (a8 xor a4 xor a2) xor (b8 xor b2 xor b) xor (c8 xor c4 xor c) xor (d8 xor d)
                s[i * 4 + 1] = (a8 xor a) xor (b8 xor b4 xor b2) xor (c8 xor c2 xor c) xor (d8 xor d4 xor d)
                s[i * 4 + 2] = (a8 xor a4 xor a) xor (b8 xor b) xor (c8 xor c4 xor c2) xor (d8 xor d2 xor d)
                s[i * 4 + 3] = (a8 xor a2 xor a) xor (b8 xor b4 xor b) xor (c8 xor c) xor (d8 xor d4 xor d2)
            }
        }

        private fun addRoundKey(s: IntArray, k: IntArray, off: Int) { for (i in 0 until 16) s[i] = s[i] xor k[off + i] }

        private fun keyExpansion(key: IntArray): IntArray {
            val rk = IntArray(176)
            for (i in 0 until 16) rk[i] = key[i]
            for (i in 4 until 44) {
                val p = (i - 1) * 4
                var b0 = rk[p]; var b1 = rk[p + 1]; var b2 = rk[p + 2]; var b3 = rk[p + 3]
                if (i % 4 == 0) {
                    val n0 = sbox[b1] xor rcon[i / 4 - 1]; val n1 = sbox[b2]; val n2 = sbox[b3]; val n3 = sbox[b0]
                    b0 = n0; b1 = n1; b2 = n2; b3 = n3
                }
                val q = (i - 4) * 4
                b0 = b0 xor rk[q]; b1 = b1 xor rk[q + 1]; b2 = b2 xor rk[q + 2]; b3 = b3 xor rk[q + 3]
                rk[i * 4] = b0; rk[i * 4 + 1] = b1; rk[i * 4 + 2] = b2; rk[i * 4 + 3] = b3
            }
            return rk
        }

        private fun aes128Decrypt(ek: IntArray, data: IntArray): IntArray {
            val s = data.copyOf()
            addRoundKey(s, ek, 160)
            for (round in 9 downTo 1) {
                shiftRowsInv(s); subBytesInv(s); addRoundKey(s, ek, round * 16); mixColumnsInv(s)
            }
            shiftRowsInv(s); subBytesInv(s); addRoundKey(s, ek, 0)
            return s
        }

        /** get_kia_v6_aes_key: both keystores (0 when absent) XORed with the fixed masks, big-endian. */
        private fun aesKey(): IntArray {
            fun half(ks: Long): IntArray {
                val lo = (ks and M32) xor XOR_MASK_LOW; val hi = XOR_MASK_HIGH xor ((ks ushr 32) and M32)
                return PPMath.u64ToBytesBE((hi shl 32) or lo)
            }
            return half(PPKeys.kiaV6A ?: 0L) + half(PPKeys.kiaV6B ?: 0L)
        }
    }

    private var dataPart1Low = 0L
    private var dataPart1High = 0L
    private var storedPart1Low = 0L
    private var storedPart1High = 0L
    private var storedPart2Low = 0L
    private var storedPart2High = 0L
    private var dataPart3 = 0
    private var bitCount = 0
    private var fxField = 0
    private var crc1Field = 0
    private var crc2Field = 0

    /**
     * kia_v6_decrypt: fills Fx, serial, button, counter and the two CRC bytes (the CRC check result is unused, as
     * in the C).
     */
    private fun decrypt(): Boolean {
        val p1h = storedPart1High; val p1l = storedPart1Low; val p2h = storedPart2High; val p2l = storedPart2Low
        fun b(v: Long, s: Int): Int = ((v ushr s) and 0xFF).toInt()
        val enc = intArrayOf(b(p1h, 8), b(p1h, 0), b(p1l, 24), b(p1l, 16), b(p1l, 8), b(p1l, 0),
            b(p2h, 24), b(p2h, 16), b(p2h, 8), b(p2h, 0), b(p2l, 24), b(p2l, 16), b(p2l, 8), b(p2l, 0),
            (dataPart3 ushr 8) and 0xFF, dataPart3 and 0xFF)
        val fx0 = b(p1h, 24); val fx1 = b(p1h, 16)
        fxField = ((fx0 and 0xF) shl 4) or (fx1 and 0xF)
        val dec = aes128Decrypt(keyExpansion(aesKey()), enc)
        val calc = PPMath.crc8(dec.copyOfRange(0, 15), 0x07, 0xFF)
        val stored = dec[15]
        serial = (dec[4].toLong() shl 16) or (dec[5].toLong() shl 8) or dec[6].toLong()
        btn = dec[7]
        cnt = (dec[8].toLong() shl 24) or (dec[9].toLong() shl 16) or (dec[10].toLong() shl 8) or dec[11].toLong()
        crc1Field = dec[12]
        crc2Field = dec[15]
        return (calc xor stored) < 2
    }

    override fun reset() { parserStep = STEP_RESET; manchesterAdvance(PPManchester.RESET) }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> {
                if (!level) return
                if (dd(duration, c.teShort) < c.teDelta) {
                    parserStep = STEP_WAIT_FIRST_HIGH; teLast = duration; headerCount = 0
                    manchesterAdvance(PPManchester.RESET)
                }
            }
            STEP_WAIT_FIRST_HIGH -> {
                if (level) return
                val diffShort = dd(duration, c.teShort); val diffLong = dd(duration, c.teLong)
                val diff = if (diffLong < diffShort) diffLong else diffShort
                if (diffLong < c.teDelta && diffLong < diffShort && headerCount >= 0x259) {
                    headerCount = 0; teLast = duration; parserStep = STEP_WAIT_LONG_HIGH
                    return
                }
                if (diff >= c.teDelta) { parserStep = STEP_RESET; return }
                if (dd(teLast, c.teShort) < c.teDelta) {
                    teLast = duration; headerCount = (headerCount + 1) and 0xFFFF
                } else parserStep = STEP_RESET
            }
            STEP_WAIT_LONG_HIGH -> {
                if (!level) { parserStep = STEP_RESET; return }
                if (dd(duration, c.teLong) >= c.teDelta && dd(duration, c.teShort) >= c.teDelta) { parserStep = STEP_RESET; return }
                if (dd(teLast, c.teLong) >= c.teDelta) { parserStep = STEP_RESET; return }
                decodeData = 0; decodeCountBit = 0
                addBit(1); addBit(1); addBit(0); addBit(1)
                dataPart1Low = decodeData and M32
                dataPart1High = (decodeData ushr 32) and M32
                bitCount = decodeCountBit and 0xFF
                parserStep = STEP_DATA
            }
            STEP_DATA -> {
                val ev: Int
                if (dd(duration, c.teShort) < c.teDelta) ev = if (level) PPManchester.SHORT_HIGH else PPManchester.SHORT_LOW
                else if (dd(duration, c.teLong) < c.teDelta) ev = if (level) PPManchester.LONG_HIGH else PPManchester.LONG_LOW
                else { parserStep = STEP_RESET; return }
                val bit = manchesterAdvance(ev)
                if (bit >= 0) {
                    val u4 = dataPart1Low
                    val u5 = ((u4 shl 1) or bit.toLong()) and M32
                    val carry = (u4 ushr 31) and 1
                    val hi = ((dataPart1High shl 1) or carry) and M32
                    dataPart1Low = u5; dataPart1High = hi
                    decodeData = (hi shl 32) or u5
                    bitCount = (bitCount + 1) and 0xFF
                    if (bitCount == 0x40) {
                        storedPart1Low = u5.inv() and M32; storedPart1High = hi.inv() and M32; dataPart1Low = 0; dataPart1High = 0
                    } else if (bitCount == 0x80) {
                        storedPart2Low = u5.inv() and M32; storedPart2High = hi.inv() and M32; dataPart1Low = 0; dataPart1High = 0
                    }
                }
                teLast = duration
                if (bitCount != c.minBits) return
                dataCountBit = c.minBits
                dataPart3 = dataPart1Low.toInt().inv() and 0xFFFF
                decrypt()
                emit()
                dataPart1Low = 0; dataPart1High = 0; bitCount = 0
                parserStep = STEP_RESET
            }
        }
    }

    override fun describe(): PPHit {
        decrypt()
        val key2Combined = ((storedPart2High shl 16) or (storedPart2Low ushr 16)) and M32
        val key2Second = (dataPart3.toLong() or (storedPart2Low shl 16)) and M32
        val line1 = hx("%08X%08X%04X", storedPart1High, storedPart1Low, storedPart2High ushr 16)
        val line2 = hx("%08X%08X", key2Combined, key2Second)
        return PPHit(name, dataCountBit, line1 + line2, serial and 0xFFFFFF, hx("%01X", (btn and 0x0F).toLong()), cnt,
            listOf(MeshField("Key1", line1), MeshField("Key2", line2),
                MeshField("Fx", hx("%02X", fxField.toLong())),
                MeshField("CRC1", hx("%02X", crc1Field.toLong())),
                MeshField("CRC2", hx("%02X", crc2Field.toLong()))))
    }

    /**
     * kia_v6.c get_string: "%s %dbit\r\n%08lX%08lX%04lX\r\n%08lX%08lX Fx:%02X\r\nSer:%06lX Btn:%01X CRC1:%02X\r\n
     * Cnt:%08lX CRC2:%02X".
     */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | ${h.fields[0].value} | ${h.fields[1].value} Fx:${h.fields[2].value} | " +
            hx("Ser:%06X", h.serial ?: 0) + " Btn:${h.btn ?: ""} CRC1:${h.fields[3].value} | " +
            hx("Cnt:%08X", h.cnt ?: 0) + " CRC2:${h.fields[4].value}"
}
