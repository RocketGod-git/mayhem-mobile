// Port of ProtoPirate protocols/psa.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * PSA (Peugeot / Citroen): Manchester, two variants. The 250 / 500 µs one (states 1 and 2) has a run of 250 µs
 * preamble pairs, a 500 µs sync and a 1000 µs end mark; the 125 / 250 µs one (states 3 and 4) a run of 125 µs pairs,
 * a 250 µs sync and a 500 µs end mark. 64 bits of Key1 then 16 of Key2. Type 0x23 frames decode with a plain XOR
 * stage (serial, button, counter, CRC); every other frame needs ProtoPirate's TEA brute force, which the C defers to a
 * separate plugin and never runs while decoding, so those show only Key1 and Key2, as in the C.
 */
class PPPsa : PPDecoder("PSA", PPModulation.AM, PPConst(250, 500, 100, 128)) {
    companion object {
        private const val STATE0 = 0; private const val STATE1 = 1; private const val STATE2 = 2; private const val STATE3 = 3; private const val STATE4 = 4
        private const val TE_SHORT125 = 0x7D; private const val TE_LONG250 = 0xFA; private const val TE_END1000 = 1000; private const val TE_END500 = 500
        private const val TOLERANCE99 = 99; private const val TOLERANCE100 = 100; private const val TOLERANCE49 = 0x31; private const val TOLERANCE50 = 0x32
        private const val PATTERN_THRESHOLD1 = 0x46; private const val PATTERN_THRESHOLD2 = 0x45
        private const val MAX_BITS = 0x79; private const val KEY1_BITS = 0x40; private const val KEY2_BITS = 0x50; private const val BUFFER_SIZE = 48
        private const val TE_LONG300 = 0x12C

        // ---- psa.c helpers ----
        private fun absDiff(a: Int, b: Int) = if (a < b) b - a else a - b

        private fun directXorAllowedByKey2(key2HighByte: Int): Boolean {
            val lo = key2HighByte and 0xF
            if (lo < 3) return true
            if (lo < 7 && (key2HighByte and 0xC) != 0) return true
            return false
        }

        private fun calculateChecksum(b: IntArray) {
            var checksum = 0L
            for (i in 2 until 8) checksum += (b[i] and 0xF) + ((b[i] ushr 4) and 0xF)
            b[11] = ((checksum * 0x10) and 0xFF).toInt()
        }

        private fun secondStageXorDecrypt(b: IntArray) {
            // psa_copy_reverse
            val t = intArrayOf(b[5], b[4], b[3], b[2], b[9], b[8], b[7], b[6])
            b[2] = t[0] xor t[6]
            b[3] = t[2] xor t[0]
            b[4] = t[6] xor t[3]
            b[5] = t[7] xor t[1]
            b[6] = t[3] xor t[1]
            b[7] = t[6] xor t[4] xor t[5]
        }
    }

    // SubGhzProtocolDecoderPSA (the state lives in parserStep)
    private var prevDuration = 0
    private var decodeDataLow = 0L
    private var decodeDataHigh = 0L
    private var countBit = 0          // uint8
    private var key1Low = 0L
    private var key1High = 0L
    private var validationField = 0
    private var key2Low = 0L
    private var key2High = 0L
    private var statusFlag = 0L
    private var decrypted = 0
    private var modeSerialize = 0
    private var patternCounter = 0    // uint16
    private var decryptedButton = 0
    private var decryptedSerial = 0L
    private var decryptedCounter = 0L
    private var decryptedCrc = 0
    private var decryptedSeed = 0L
    private var decryptedType = 0

    private fun extractFieldsMode23(b: IntArray) {
        decryptedButton = b[8] and 0xF
        decryptedSerial = (b[3].toLong() shl 8) or (b[2].toLong() shl 16) or b[4].toLong()
        decryptedCounter = b[6].toLong() or (b[5].toLong() shl 8)
        decryptedCrc = b[7]
        decryptedType = 0x23
        decryptedSeed = decryptedSerial
    }

    private fun directXorDecrypt(b: IntArray): Boolean {
        calculateChecksum(b)
        val checksum = b[11]
        val key2High = b[8]
        if ((checksum xor key2High) and 0xF0 == 0) {
            b[13] = b[9] xor b[8]
            secondStageXorDecrypt(b)
            extractFieldsMode23(b)
            return true
        }
        return false
    }

    private fun newBuffer(): IntArray {
        val b = IntArray(BUFFER_SIZE)
        PPPsaCrypto.setupByteBuffer(b, key1Low, key1High, key2Low)
        return b
    }

    private fun handleDecodedFrame(directXorMode: Int) {
        key2Low = decodeDataLow
        key2High = decodeDataHigh
        validationField = (decodeDataLow and 0xFFFF).toInt()
        decryptedType = 0; decryptedButton = 0; decryptedSerial = 0; decryptedCounter = 0; decryptedCrc = 0; decryptedSeed = 0
        decrypted = 0
        modeSerialize = if (directXorAllowedByKey2(((key2Low ushr 8) and 0xFF).toInt())) directXorMode else 0x36
        statusFlag = 0x80
        val b = newBuffer()
        if (modeSerialize != 0x36 && directXorDecrypt(b)) {
            modeSerialize = 0x23
            decrypted = 0x50
        } else {
            decrypted = 0
            modeSerialize = 0x36
        }
        emit()
        decodeDataLow = 0; decodeDataHigh = 0; countBit = 0
    }

    private fun decryptRouter() {
        val b = newBuffer()
        val key2HighByte = b[8]
        var mode = modeSerialize
        if (mode == 1 || mode == 2) {
            mode = if (!directXorAllowedByKey2(key2HighByte)) 0x36
            else if (directXorDecrypt(b)) 0x23
            else 0x36
        }
        if (mode == 0x23) {
            if (directXorDecrypt(b)) { modeSerialize = 0x23; decrypted = 0x50; return }
        } else if (mode == 0x36) {
            return   // TEA brute force: deferred to ProtoPirate's plugin, never run here
        } else {
            if (directXorAllowedByKey2(key2HighByte) && directXorDecrypt(b)) { modeSerialize = 0x23; decrypted = 0x50; return }
            modeSerialize = 0x36; decrypted = 0
            return
        }
        decrypted = 0
    }

    private fun pushBit(bit: Int) {
        val carry = (decodeDataLow ushr 31) and 1
        decodeDataLow = ((decodeDataLow shl 1) or bit.toLong()) and M32
        decodeDataHigh = ((decodeDataHigh shl 1) or carry) and M32
        countBit = (countBit + 1) and 0xFF
        if (countBit == KEY1_BITS) {
            key1Low = decodeDataLow; key1High = decodeDataHigh
            decodeDataLow = 0; decodeDataHigh = 0
        }
    }

    private fun manchesterStep(input: Int) {
        val bit = manchesterAdvance(input)
        if (bit >= 0) pushBit(bit)
    }

    override fun reset() {
        parserStep = 0; statusFlag = 0; modeSerialize = 0
        key1Low = 0; key1High = 0; key2Low = 0; key2High = 0
        decodeDataLow = 0; decodeDataHigh = 0; countBit = 0; patternCounter = 0
        manchester = PPManchester.MID1
        decryptedButton = 0; decryptedSerial = 0; decryptedCounter = 0; decryptedCrc = 0; decryptedSeed = 0; decryptedType = 0
    }

    override fun feed(level: Boolean, duration: Int) {
        var tolerance: Int
        var newState = parserStep
        val prevDur = prevDuration
        val teShort = c.teShort; val teLong = c.teLong
        val lv = if (level) 1 else 0

        // `return@sw` is the C's `break` out of the switch (falls through to the state write-back below);
        // a plain `return` is the C's `return`.
        run sw@{
            when (parserStep) {
                STATE0 -> {
                    if (!level) return
                    if (duration < teShort) {
                        tolerance = teShort - duration
                        if (tolerance > TOLERANCE99) {
                            tolerance = if (duration < TE_SHORT125) TE_SHORT125 - duration else duration - TE_SHORT125
                            if (tolerance > 40) return
                            if (duration > 180) return
                            newState = STATE3
                        } else {
                            newState = STATE1
                        }
                    } else {
                        tolerance = duration - teShort
                        if (tolerance > TOLERANCE99) return
                        newState = STATE1
                    }
                    decodeDataLow = 0; decodeDataHigh = 0; patternCounter = 0; countBit = 0; modeSerialize = 0
                    prevDuration = duration
                    decryptedType = 0; decryptedButton = 0; decryptedSerial = 0; decryptedCounter = 0; decryptedCrc = 0; decryptedSeed = 0
                    decrypted = 0
                    manchesterAdvance(PPManchester.RESET)
                }

                STATE1 -> {
                    if (level) return
                    if (duration < teShort) {
                        tolerance = teShort - duration
                        if (tolerance < TOLERANCE100) {
                            if (absDiff(prevDur, teShort) <= TOLERANCE99) patternCounter = (patternCounter + 1) and 0xFFFF
                            prevDuration = duration
                            return
                        }
                    } else {
                        tolerance = duration - teShort
                        if (tolerance < TOLERANCE100) {
                            if (absDiff(prevDur, teShort) <= TOLERANCE99) patternCounter = (patternCounter + 1) and 0xFFFF
                            prevDuration = duration
                            return
                        } else {
                            val longDiff = if (duration < teLong) teLong - duration else duration - teLong
                            if (longDiff < 100) {
                                if (patternCounter > PATTERN_THRESHOLD1) {
                                    newState = STATE2
                                    decodeDataLow = 0; decodeDataHigh = 0; countBit = 0
                                    manchesterAdvance(PPManchester.RESET)
                                    parserStep = newState
                                }
                                patternCounter = 0
                                prevDuration = duration
                                return
                            }
                        }
                    }
                    newState = STATE0
                    patternCounter = 0
                }

                STATE2 -> {
                    if (countBit >= MAX_BITS) { newState = STATE0; return@sw }

                    if (level && countBit == KEY2_BITS) {
                        if (duration >= 800) {
                            val endDiff = if (duration < TE_END1000) TE_END1000 - duration else duration - TE_END1000
                            if (endDiff <= 199) {
                                if (((key1High ushr 16) and 0xF) != 0xAL) {
                                    decodeDataLow = 0; decodeDataHigh = 0; countBit = 0
                                    parserStep = STATE0
                                    return
                                }
                                handleDecodedFrame(1)
                                parserStep = STATE0
                                return
                            }
                        }
                    }

                    var manchesterInput = 0
                    var shouldProcess = false
                    if (duration < teShort) {
                        tolerance = teShort - duration
                        if (tolerance >= TOLERANCE100) return
                        manchesterInput = ((lv xor 1) and 0x7F) shl 1
                        shouldProcess = true
                    } else {
                        tolerance = duration - teShort
                        if (tolerance < TOLERANCE100) {
                            manchesterInput = ((lv xor 1) and 0x7F) shl 1
                            shouldProcess = true
                        } else if (duration < teLong) {
                            val diffFrom250 = duration - teShort
                            val diffFrom500 = teLong - duration
                            if (diffFrom500 < 150 || diffFrom250 > diffFrom500) {
                                manchesterInput = if (lv == 0) 6 else 4
                                shouldProcess = true
                            } else if (diffFrom250 < 150) {
                                manchesterInput = ((lv xor 1) and 0x7F) shl 1
                                shouldProcess = true
                            } else {
                                // psa.c: new_state is set but never written back before the return (C quirk, kept).
                                if (duration > 10000) { patternCounter = 0; return }
                                if (duration in 350..400) {
                                    manchesterInput = if (lv == 0) 6 else 4
                                    shouldProcess = true
                                } else {
                                    return
                                }
                            }
                        } else {
                            val longDiff = duration - teLong
                            if (longDiff < 100) {
                                manchesterInput = if (lv == 0) 6 else 4
                                shouldProcess = true
                            } else {
                                if (!level) {
                                    // psa.c: a low over 10 ms clears the pattern counter but the state is not written back
                                    // (new_state is dropped by the return), so the decoder stays in state 2. Kept as in C.
                                    if (duration > 10000) { patternCounter = 0; return }
                                    return
                                }
                                shouldProcess = false
                            }
                        }
                    }

                    if (shouldProcess && countBit < KEY2_BITS) manchesterStep(manchesterInput)

                    if (!level) return

                    if (!shouldProcess) {
                        val endDiff = if (duration < TE_END1000) TE_END1000 - duration else duration - TE_END1000
                        if (endDiff <= 199) {
                            if (countBit != KEY2_BITS) return
                            if (((key1High ushr 16) and 0xF) == 0xAL) {
                                handleDecodedFrame(1)
                                parserStep = STATE0
                                return
                            } else return
                        } else return
                    }
                }

                STATE3 -> {
                    if (duration >= 250) {
                        if (duration >= TE_LONG250 && duration < TE_LONG300) {
                            if (patternCounter > PATTERN_THRESHOLD2) {
                                newState = STATE4
                                decodeDataLow = 0; decodeDataHigh = 0; countBit = 0
                                manchesterAdvance(PPManchester.RESET)
                                parserStep = newState
                                patternCounter = 0
                                prevDuration = duration
                                return
                            }
                        }
                        newState = STATE0
                        patternCounter = 0
                        return@sw
                    }
                    tolerance = if (duration < TE_SHORT125) TE_SHORT125 - duration else duration - TE_SHORT125
                    if (tolerance < TOLERANCE50) {
                        if (absDiff(prevDur, TE_SHORT125) <= TOLERANCE49) patternCounter = (patternCounter + 1) and 0xFFFF else patternCounter = 0
                        prevDuration = duration
                        return
                    }
                    newState = STATE0
                    patternCounter = 0
                }

                STATE4 -> {
                    if (countBit >= MAX_BITS) { newState = STATE0; return@sw }
                    if (!level) {
                        val manchesterInput: Int
                        if (duration < TE_SHORT125) {
                            tolerance = TE_SHORT125 - duration
                            if (tolerance > TOLERANCE49) return
                            manchesterInput = ((lv xor 1) and 0x7F) shl 1
                        } else {
                            tolerance = duration - TE_SHORT125
                            if (tolerance < TOLERANCE50) {
                                manchesterInput = ((lv xor 1) and 0x7F) shl 1
                            } else if (duration >= TE_LONG250 && duration < TE_LONG300) {
                                manchesterInput = if (lv == 0) 6 else 4
                            } else {
                                return
                            }
                        }
                        manchesterStep(manchesterInput)
                    } else {
                        val endDiff = if (duration < TE_END500) TE_END500 - duration else duration - TE_END500
                        if (endDiff <= 99) {
                            if (countBit != KEY2_BITS) return
                            if (((key1High ushr 16) and 0xF) != 0xAL) {
                                decodeDataLow = 0; decodeDataHigh = 0; countBit = 0
                                parserStep = STATE0
                                return
                            }
                            handleDecodedFrame(2)
                            parserStep = STATE0
                            return
                        } else return
                    }
                }
                else -> {}
            }
        }

        parserStep = newState
        prevDuration = duration
    }

    /** psa.c get_string, including its side effect: with a fresh frame not yet decrypted it runs the decrypt router. */
    override fun describe(): PPHit {
        if (statusFlag == 0x80L && (key1Low != 0L || key1High != 0L) && decryptedType == 0) decryptRouter()
        val key2Value = (key2Low and 0xFFFF)
        val key = hx("%08X%08X", key1High, key1Low)
        if (decrypted == 0x50 && (decryptedType == 0x23 || decryptedType == 0x36)) {
            val t23 = decryptedType == 0x23
            return PPHit(name, 128, key, decryptedSerial, hx(if (t23) "%01X" else "%02X", decryptedButton.toLong()), decryptedCounter,
                listOf(MeshField("Key2", hx("%04X", key2Value)),
                    MeshField("Ser", hx("%06X", decryptedSerial)),
                    MeshField("Cnt", hx(if (t23) "%04X" else "%X", decryptedCounter)),
                    MeshField("CRC", hx("%02X", decryptedCrc.toLong())),
                    MeshField("Type", hx("%02X", decryptedType.toLong())),
                    MeshField("Sd", hx("%06X", decryptedSeed))))
        }
        return PPHit(name, 128, key, null, null, null, listOf(MeshField("Key2", hx("%X", key2Value))))
    }

    /**
     * psa.c get_string: "%s %dbit\r\nKey1:%08lX%08lX\r\nKey2:%04X\r\nBtn:%01X\r\nSer:%06lX\r\nCnt:%04lX\r\nCRC:%02X\r\n
     * Type:%02X\r\nSd:%06lX" for a decrypted frame (Btn %02X, Cnt %lX for type 0x36), else "%s %dbit\r\nKey1:...\r\nKey2:%X".
     */
    override fun cString(h: PPHit): String {
        val parts = mutableListOf("${h.name} ${h.bits}bit", "Key1:${h.key}")
        for (f in h.fields) {
            parts.add("${f.name}:${f.value}")
            if (f.name == "Key2") h.btn?.let { parts.add("Btn:$it") }
        }
        return parts.joinToString(" | ")
    }
}
