// Port of ProtoPirate protocols/vag.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * VAG (VW / Audi / Seat / Skoda): AM, Manchester, 80 bits (Key1 64 + Key2 16). Types 1 and 2 use 300 / 600 µs with a
 * long 300 µs preamble, an inverted payload and a 15-bit frame prefix (0x2F3F = type 1, 0x2F1C = type 2); types 3 and 4
 * use 500 / 1000 µs with a 500 µs preamble and three 750 µs sync pairs. Type 2 decrypts with a fixed TEA key; types 1,
 * 3 and 4 need AUT64 keys from ProtoPirate's keystore file, which is not shipped, so those frames show as received
 * ("corrupted"), as the C does with no key file.
 */
class PPVag : PPDecoder("VAG", PPModulation.AM, PPConst(500, 1000, 80, 80)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE1 = 1; private const val STEP_DATA1 = 2; private const val STEP_PREAMBLE2 = 3
        private const val STEP_SYNC2A = 4; private const val STEP_SYNC2B = 5; private const val STEP_SYNC2C = 6; private const val STEP_DATA2 = 7

        private const val T12_TE_SHORT = 300; private const val T12_TE_LONG = 600; private const val T12_TE_DELTA = 100
        private const val T12_GAP_DELTA = 200; private const val T12_PREAMBLE_MIN = 151
        private const val T34_TE_SHORT = 500; private const val T34_TE_LONG = 1000; private const val T34_TE_DELTA = 100; private const val T34_LONG_DELTA = 200
        private const val T34_SYNC = 750; private const val T34_SYNC_DELTA = 150; private const val T34_PREAMBLE_MIN = 31; private const val T34_SYNC_PAIRS = 3
        private const val DATA_GAP_MIN = 4001; private const val TOTAL_BITS = 80; private const val KEY1_BITS = 64
        private const val PREFIX_BITS = 15; private const val BIT_LIMIT = 96
        private const val FRAME_PREFIX_T1 = 0x2F3FL; private const val FRAME_PREFIX_T2 = 0x2F1CL

        /** The AUT64 keys from ProtoPirate's "vag" keystore file (up to 3, matched by their index byte). None ship. */
        @JvmStatic var aut64Keys: List<PPAut64Key> = emptyList()

        private const val TEA_DELTA = -0x61C88647   // 0x9E3779B9 as a 32-bit Int
        private const val TEA_ROUNDS = 32
        private val teaKeySchedule = intArrayOf(0x0B46502D, 0x5E253718, 0x2BF93A19, 0x622C1206)

        // ---- vag.c helpers ----
        fun buttonName(btn: Int): String = when (btn) {
            0x1, 0x10 -> "Unlock"
            0x2, 0x20 -> "Lock"
            0x4, 0x40 -> "Boot"
            else -> "Unkn"
        }

        /** 32-bit TEA decrypt on Ints (which wrap like uint32_t). */
        private fun teaDecrypt(v: IntArray, k: IntArray) {
            var v0 = v[0]; var v1 = v[1]
            var sum = TEA_DELTA * TEA_ROUNDS
            repeat(TEA_ROUNDS) {
                v1 -= (((v0 shl 4) xor (v0 ushr 5)) + v0) xor (sum + k[(sum ushr 11) and 3])
                sum -= TEA_DELTA
                v0 -= (((v1 shl 4) xor (v1 ushr 5)) + v1) xor (sum + k[sum and 3])
            }
            v[0] = v0; v[1] = v1
        }

        private fun dispatchType12(d: Int) = d == 0x2A || d == 0x1C || d == 0x46
        private fun dispatchType34(d: Int) = d == 0x2B || d == 0x1D || d == 0x47

        private fun buttonValid(dec: IntArray): Boolean {
            val decBtn = (dec[7] ushr 4) and 0xF
            if (decBtn == 1 || decBtn == 2 || decBtn == 4) return true
            return dec[7] == 0
        }

        private fun buttonMatches(dec: IntArray, dispatchByte: Int): Boolean {
            val expected = (dispatchByte ushr 4) and 0xF
            if ((dec[7] ushr 4) and 0xF == expected) return true
            return dec[7] == 0 && expected == 2
        }

        /** vag_aut64_decrypt: key slot `keyIndex` is the keystore key whose index byte is keyIndex + 1. */
        private fun aut64Decrypt(block: IntArray, keyIndex: Int): Boolean {
            val key = aut64Keys.take(3).firstOrNull { it.index == keyIndex + 1 } ?: return false
            PPAut64.decrypt(key, block)
            return true
        }

        /** vag.c get_string's vehicle name, from Key1's top byte. */
        fun vehicleName(typeByte: Int): String = when (typeByte) {
            0x00 -> "VW Passat"
            0xC0 -> "VW"
            0xC1 -> "Audi"
            0xC2 -> "Seat"
            0xC3 -> "Skoda"
            else -> "VAG"
        }
    }

    // SubGhzProtocolDecoderVAG
    private var dataLow = 0L
    private var dataHigh = 0L
    private var bitCount = 0          // uint8
    private var key1Low = 0L
    private var key1High = 0L
    private var key2Low = 0L
    private var key2High = 0L
    private var vagDataCountBit = 0
    private var vagType = 0
    private var vagHeaderCount = 0    // uint16
    private var midCount = 0          // uint8
    private var vSerial = 0L
    private var vCnt = 0L
    private var vBtn = 0
    private var checkByte = 0
    private var keyIdx = 0xFF
    private var decrypted = false

    private fun fillFromDecrypted(dec: IntArray, dispatchByte: Int) {
        val raw = dec[0].toLong() or (dec[1].toLong() shl 8) or (dec[2].toLong() shl 16) or (dec[3].toLong() shl 24)
        vSerial = ((raw shl 24) or ((raw and 0xFF00) shl 8) or ((raw ushr 8) and 0xFF00) or (raw ushr 24)) and M32
        vCnt = dec[4].toLong() or (dec[5].toLong() shl 8) or (dec[6].toLong() shl 16)
        vBtn = (dec[7] ushr 4) and 0xF
        checkByte = dispatchByte
        decrypted = true
    }

    private fun parseData() {
        decrypted = false; vSerial = 0; vCnt = 0; vBtn = 0
        val dispatchByte = (key2Low and 0xFF).toInt()
        val key2HighByte = ((key2Low ushr 8) and 0xFF).toInt()
        fun b(v: Long, s: Int) = ((v ushr s) and 0xFF).toInt()
        val k1 = intArrayOf(b(key1High, 24), b(key1High, 16), b(key1High, 8), b(key1High, 0),
            b(key1Low, 24), b(key1Low, 16), b(key1Low, 8), b(key1Low, 0))
        val block = intArrayOf(k1[1], k1[2], k1[3], k1[4], k1[5], k1[6], k1[7], key2HighByte)

        run sw@{
            when (vagType) {
                1 -> {
                    if (!dispatchType12(dispatchByte)) return@sw
                    for (ki in 0 until 3) {
                        val copy = block.copyOf()
                        if (!aut64Decrypt(copy, ki)) continue
                        if (buttonValid(copy)) {
                            vSerial = (copy[0].toLong() shl 24) or (copy[1].toLong() shl 16) or (copy[2].toLong() shl 8) or copy[3].toLong()
                            vCnt = copy[4].toLong() or (copy[5].toLong() shl 8) or (copy[6].toLong() shl 16)
                            vBtn = copy[7]
                            checkByte = dispatchByte
                            keyIdx = ki
                            decrypted = true
                            return
                        }
                    }
                }
                2 -> {
                    if (!dispatchType12(dispatchByte)) return@sw
                    val v = intArrayOf((block[0] shl 24) or (block[1] shl 16) or (block[2] shl 8) or block[3],
                        (block[4] shl 24) or (block[5] shl 16) or (block[6] shl 8) or block[7])
                    teaDecrypt(v, teaKeySchedule)
                    val v0 = v[0]; val v1 = v[1]
                    val dec = intArrayOf((v0 ushr 24) and 0xFF, (v0 ushr 16) and 0xFF, (v0 ushr 8) and 0xFF, v0 and 0xFF,
                        (v1 ushr 24) and 0xFF, (v1 ushr 16) and 0xFF, (v1 ushr 8) and 0xFF, v1 and 0xFF)
                    if (!buttonMatches(dec, dispatchByte)) return@sw
                    fillFromDecrypted(dec, dispatchByte)
                    keyIdx = 0xFF
                    return
                }
                3 -> {
                    var copy = block.copyOf()
                    if (aut64Decrypt(copy, 2) && buttonValid(copy)) {
                        vagType = 4; keyIdx = 2; fillFromDecrypted(copy, dispatchByte); return
                    }
                    copy = block.copyOf()
                    if (aut64Decrypt(copy, 1) && buttonValid(copy)) { keyIdx = 1; fillFromDecrypted(copy, dispatchByte); return }
                    copy = block.copyOf()
                    if (aut64Decrypt(copy, 0) && buttonValid(copy)) { keyIdx = 0; fillFromDecrypted(copy, dispatchByte); return }
                }
                4 -> {
                    if (!dispatchType34(dispatchByte)) return@sw
                    val copy = block.copyOf()
                    if (!aut64Decrypt(copy, 2)) return@sw
                    if (!buttonMatches(copy, dispatchByte)) return@sw
                    keyIdx = 2
                    fillFromDecrypted(copy, dispatchByte)
                    return
                }
                else -> {}
            }
        }
        decrypted = false; vSerial = 0; vCnt = 0; vBtn = 0; checkByte = 0
    }

    private fun pushBit(bit: Int) {
        val carry = (dataLow ushr 31) and 1
        dataLow = ((dataLow shl 1) or bit.toLong()) and M32
        dataHigh = ((dataHigh shl 1) or carry) and M32
        bitCount = (bitCount + 1) and 0xFF
    }

    override fun reset() {
        parserStep = STEP_RESET
        decrypted = false
        dataLow = 0; dataHigh = 0; bitCount = 0; vagDataCountBit = 0; vagType = 0; vagHeaderCount = 0; midCount = 0
        manchesterAdvance(PPManchester.RESET)
        vSerial = 0; vCnt = 0; vBtn = 0; checkByte = 0; keyIdx = 0xFF
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> {
                if (!level) return
                if (dd(duration, T12_TE_SHORT) < T12_TE_DELTA) parserStep = STEP_PREAMBLE1
                else if (dd(duration, T34_TE_SHORT) < T34_TE_DELTA) parserStep = STEP_PREAMBLE2
                else return
                dataLow = 0; dataHigh = 0; vagHeaderCount = 0; midCount = 0; bitCount = 0; vagType = 0
                teLast = duration
                manchesterAdvance(PPManchester.RESET)
            }

            STEP_PREAMBLE1 -> {
                if (level) return
                if (dd(duration, T12_TE_SHORT) < T12_TE_DELTA) {
                    if (dd(teLast, T12_TE_SHORT) < T12_TE_DELTA) { teLast = duration; vagHeaderCount = (vagHeaderCount + 1) and 0xFFFF }
                    else parserStep = STEP_RESET
                    return
                }
                parserStep = STEP_RESET
                if (vagHeaderCount < T12_PREAMBLE_MIN) return
                if (dd(duration, T12_TE_LONG) >= T12_GAP_DELTA) return
                if (dd(teLast, T12_TE_SHORT) >= T12_TE_DELTA) return
                parserStep = STEP_DATA1
            }

            STEP_DATA1 -> {
                if (bitCount >= BIT_LIMIT) { parserStep = STEP_RESET; return }
                var event = PPManchester.RESET
                var gotPulse = false
                if (dd(duration, T12_TE_SHORT) < T12_TE_DELTA) {
                    event = if (level) PPManchester.SHORT_LOW else PPManchester.SHORT_HIGH; gotPulse = true
                } else if (duration > T12_TE_SHORT + T12_TE_DELTA && dd(duration, T12_TE_LONG) < T12_GAP_DELTA) {
                    event = if (level) PPManchester.LONG_LOW else PPManchester.LONG_HIGH; gotPulse = true
                }
                if (gotPulse && bitCount < BIT_LIMIT) {
                    val bit = manchesterAdvance(event)
                    if (bit >= 0) {
                        pushBit(bit)
                        if (bitCount == PREFIX_BITS) {
                            if (dataLow == FRAME_PREFIX_T1 && dataHigh == 0L) { dataLow = 0; dataHigh = 0; bitCount = 0; vagType = 1 }
                            else if (dataLow == FRAME_PREFIX_T2 && dataHigh == 0L) { dataLow = 0; dataHigh = 0; bitCount = 0; vagType = 2 }
                        } else if (bitCount == KEY1_BITS) {
                            key1Low = dataLow.inv() and M32; key1High = dataHigh.inv() and M32
                            dataLow = 0; dataHigh = 0
                        }
                    }
                    return
                }
                if (level) return
                if (duration < DATA_GAP_MIN) return
                if (bitCount == TOTAL_BITS) {
                    key2Low = dataLow.inv() and 0xFFFF
                    key2High = 0
                    vagDataCountBit = TOTAL_BITS
                    parseData()
                    emit()
                }
                dataLow = 0; dataHigh = 0; bitCount = 0
                parserStep = STEP_RESET
            }

            STEP_PREAMBLE2 -> {
                if (!level) {
                    if (dd(duration, T34_TE_SHORT) < T34_TE_DELTA && dd(teLast, T34_TE_SHORT) < T34_TE_DELTA) {
                        teLast = duration; vagHeaderCount = (vagHeaderCount + 1) and 0xFFFF
                    } else {
                        parserStep = STEP_RESET
                    }
                    return
                }
                if (vagHeaderCount < T34_PREAMBLE_MIN) return
                if (dd(duration, T34_TE_LONG) >= T34_LONG_DELTA) return
                if (dd(teLast, T34_TE_SHORT) >= T34_TE_DELTA) return
                teLast = duration
                parserStep = STEP_SYNC2A
            }

            STEP_SYNC2A -> if (!level && dd(duration, T34_TE_SHORT) < T34_TE_DELTA && dd(teLast, T34_TE_LONG) < T34_LONG_DELTA) {
                teLast = duration; parserStep = STEP_SYNC2B
            } else parserStep = STEP_RESET

            STEP_SYNC2B -> if (level && dd(duration, T34_SYNC) < T34_SYNC_DELTA) { teLast = duration; parserStep = STEP_SYNC2C }
                else parserStep = STEP_RESET

            STEP_SYNC2C -> if (!level && dd(duration, T34_SYNC) < T34_SYNC_DELTA && dd(teLast, T34_SYNC) < T34_SYNC_DELTA) {
                midCount = (midCount + 1) and 0xFF
                parserStep = STEP_SYNC2B
                if (midCount == T34_SYNC_PAIRS) {
                    dataLow = 1; dataHigh = 0; bitCount = 1
                    manchesterAdvance(PPManchester.RESET)
                    parserStep = STEP_DATA2
                }
            } else parserStep = STEP_RESET

            STEP_DATA2 -> {
                var event = PPManchester.RESET
                var gotPulse = false
                if (dd(duration, T34_TE_SHORT) < T34_TE_DELTA) { event = if (level) PPManchester.SHORT_LOW else PPManchester.SHORT_HIGH; gotPulse = true }
                else if (dd(duration, T34_TE_LONG) < T34_LONG_DELTA) { event = if (level) PPManchester.LONG_LOW else PPManchester.LONG_HIGH; gotPulse = true }
                if (gotPulse) {
                    val bit = manchesterAdvance(event)
                    if (bit >= 0) {
                        pushBit(bit)
                        if (bitCount == KEY1_BITS) {
                            key1Low = dataLow; key1High = dataHigh
                            dataLow = 0; dataHigh = 0
                        }
                    }
                }
                if (bitCount != TOTAL_BITS) return
                key2Low = dataLow and 0xFFFF
                key2High = 0
                vagDataCountBit = TOTAL_BITS
                vagType = 3
                parseData()
                emit()
                dataLow = 0; dataHigh = 0; bitCount = 0
                parserStep = STEP_RESET
            }

            else -> parserStep = STEP_RESET
        }
    }

    /** vag.c get_string, including its side effect: an undecrypted 80-bit frame is parsed again. */
    override fun describe(): PPHit {
        if (!decrypted && vagDataCountBit >= 80) parseData()
        val key = hx("%08X%08X", key1High, key1Low)
        val key2 = key2Low and 0xFFFF
        val fields = mutableListOf(MeshField("Vehicle", vehicleName(((key1High ushr 24) and 0xFF).toInt())),
            MeshField("Key2", hx("%04X", key2)),
            MeshField("Type", "$vagType"))
        if (decrypted) {
            fields.add(MeshField("Button", buttonName(vBtn)))
            return PPHit(name, vagDataCountBit, key, vSerial, hx("%X", vBtn.toLong()), vCnt, fields)
        }
        return PPHit(name, vagDataCountBit, key, null, null, null, fields)
    }

    /**
     * vag.c get_string: "%s %dbit\r\nKey1:%08lX%08lX\r\nKey2:%04X Btn:%0X - %s\r\nSer:%08lX Cnt:%06lX\r\n" when
     * decrypted, else "%s %dbit\r\nKey1:%08lX%08lX\r\nKey2:%04X (corrupted)\r\n"; %s is the vehicle name.
     */
    override fun cString(h: PPHit): String {
        val head = "${h.field("Vehicle")} ${h.bits}bit | Key1:${h.key} | Key2:${h.field("Key2")}"
        val b = h.btn
        if (b != null) return head + " Btn:$b - ${h.field("Button")} | " + hx("Ser:%08X Cnt:%06X", h.serial ?: 0, h.cnt ?: 0)
        return head + " (corrupted)"
    }
}
