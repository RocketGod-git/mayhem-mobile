package com.rocketgod.mayhem.core.apps.ism

/**
 * One decoded car-key frame. [serial] is Mayhem's uint32 serial (unsigned, in a Long); [btn] is the button text Mayhem
 * shows ("" when unknown); [cnt] is null when Mayhem leaves it at SD_NO_CNT. [extra] is reserved for additional lines
 * (Mayhem prints none for car keys beyond the raw data words the caller already has).
 */
data class CarInfo(val name: String, val serial: Long, val btn: String, val cnt: Int?, val extra: List<String>)

/**
 * Field extraction per car-key type (Mayhem external/subcarrx/ui_subcar.cpp SubCarRecentEntryDetailView::parseProtocol +
 * SubCarView::getSensorTypeName). Mayhem's serial / cnt are uint32, so assignments truncate the same way here; cnt is
 * the 32-bit value reinterpreted as Int.
 */
object CarFields {
    fun name(type: Int): String = when (type) {
        C.SUZUKI -> "Suzuki"; C.VW -> "VW"; C.SUBARU -> "Subaru"; C.KIA_V5 -> "Kia V5"; C.KIA_V3V4 -> "Kia V3/V4"; C.KIA_V2 -> "Kia V2"
        C.KIA_V1 -> "Kia V1"; C.KIA_V0 -> "Kia V0"; C.FORD_V0 -> "Ford V0"; C.FIAT_V0 -> "Fiat V0"; C.BMW_V0 -> "BMW V0"
        else -> "Unknown"
    }

    private const val M32 = 0xFFFFFFFFL
    private fun u32(v: Long): Long = v and M32
    private fun byte(v: Long, shift: Int): Int = ((v ushr shift) and 0xFF).toInt()

    /** Subaru rolling-count descrambler; KB is the little-endian byte view of the 64-bit key. */
    private fun subaruDecodeCount(kb: IntArray): Int {
        var lo = 0
        if ((kb[4] and 0x40) == 0) lo = lo or 0x01
        if ((kb[4] and 0x80) == 0) lo = lo or 0x02
        if ((kb[5] and 0x01) == 0) lo = lo or 0x04
        if ((kb[5] and 0x02) == 0) lo = lo or 0x08
        if ((kb[6] and 0x01) == 0) lo = lo or 0x10
        if ((kb[6] and 0x02) == 0) lo = lo or 0x20
        if ((kb[5] and 0x40) == 0) lo = lo or 0x40
        if ((kb[5] and 0x80) == 0) lo = lo or 0x80

        var regSh1 = (kb[7] shl 4) and 0xF0
        if ((kb[5] and 0x04) != 0) regSh1 = regSh1 or 0x04
        if ((kb[5] and 0x08) != 0) regSh1 = regSh1 or 0x08
        if ((kb[6] and 0x80) != 0) regSh1 = regSh1 or 0x02
        if ((kb[6] and 0x40) != 0) regSh1 = regSh1 or 0x01

        val regSh2 = ((kb[6] shl 2) and 0xF0) or ((kb[7] ushr 4) and 0x0F)

        var ser0 = kb[3]; var ser1 = kb[1]; var ser2 = kb[2]
        val totalRot = (4 + lo) and 0xFF
        for (i in 0 until totalRot) {
            val tBit = (ser0 ushr 7) and 1
            ser0 = ((ser0 shl 1) and 0xFE) or ((ser1 ushr 7) and 1)
            ser1 = ((ser1 shl 1) and 0xFE) or ((ser2 ushr 7) and 1)
            ser2 = ((ser2 shl 1) and 0xFE) or tBit
        }

        val t1 = ser1 xor regSh1
        val t2 = ser2 xor regSh2

        var hi = 0
        if ((t1 and 0x10) == 0) hi = hi or 0x04
        if ((t1 and 0x20) == 0) hi = hi or 0x08
        if ((t2 and 0x80) == 0) hi = hi or 0x02
        if ((t2 and 0x40) == 0) hi = hi or 0x01
        if ((t1 and 0x01) == 0) hi = hi or 0x40
        if ((t1 and 0x02) == 0) hi = hi or 0x80
        if ((t2 and 0x08) == 0) hi = hi or 0x20
        if ((t2 and 0x04) == 0) hi = hi or 0x10
        return ((hi shl 8) or lo) and 0xFFFF
    }

    private val KIA_V5_KEYSTORE = intArrayOf(0x53, 0x54, 0x46, 0x52, 0x4b, 0x45, 0x30, 0x30)

    /** Kia V5 rolling-code decrypt of the 32-bit encrypted word; returns the 16-bit counter. */
    private fun kiaV5Count(encrypted: Long): Int {
        var s0 = byte(encrypted, 0); var s1 = byte(encrypted, 8); var s2 = byte(encrypted, 16); var s3 = byte(encrypted, 24)
        var roundIndex = 1
        for (i in 0 until 18) {
            var r = KIA_V5_KEYSTORE[roundIndex] and 0xFF
            var steps = 8
            while (steps > 0) {
                var base = if ((s3 and 0x40) == 0) (if ((s3 and 0x02) == 0) 0x74 else 0x2E) else (if ((s3 and 0x02) == 0) 0x3A else 0x5C)
                if ((s2 and 0x08) != 0) base = (((base ushr 4) and 0x0F) or ((base and 0x0F) shl 4)) and 0xFF
                if ((s1 and 0x01) != 0) base = ((base and 0x3F) shl 2) and 0xFF
                if ((s0 and 0x01) != 0) base = (base shl 1) and 0xFF

                val temp = (s3 xor s1) and 0xFF
                s3 = ((s3 and 0x7F) shl 1) and 0xFF
                if ((s2 and 0x80) != 0) s3 = s3 or 0x01
                s2 = ((s2 and 0x7F) shl 1) and 0xFF
                if ((s1 and 0x80) != 0) s2 = s2 or 0x01
                s1 = ((s1 and 0x7F) shl 1) and 0xFF
                if ((s0 and 0x80) != 0) s1 = s1 or 0x01
                s0 = ((s0 and 0x7F) shl 1) and 0xFF

                val chk = (base xor (r xor temp)) and 0xFF
                if ((chk and 0x80) != 0) s0 = s0 or 0x01
                r = ((r and 0x7F) shl 1) and 0xFF
                steps--
            }
            roundIndex = (roundIndex - 1) and 0x7
        }
        return (s0 + (s1 shl 8)) and 0xFFFF
    }

    fun parse(type: Int, data: Long, data2: Long, bits: Int): CarInfo {
        val name = name(type)
        var serial = 0L; var btn = ""; var cnt: Int? = null
        when (type) {
            C.SUZUKI -> {
                val dataHigh = u32(data ushr 32); val dataLow = u32(data)
                serial = u32(((dataHigh and 0xFFF) shl 16) or (dataLow ushr 16))
                val buttonId = ((dataLow ushr 12) and 0xF).toInt()
                cnt = (u32(dataHigh shl 4) ushr 16).toInt()
                btn = buttonId.toString()
            }
            C.VW -> {
                serial = u32(data)  // trimmed to 32 bits for VW
                val check = (data2 and 0xFF).toInt()
                btn = when ((check ushr 4) and 0xF) {
                    0x1 -> "UNLOCK"; 0x2 -> "LOCK"; 0x3 -> "Un+Lk"; 0x4 -> "TRUNK"; 0x5 -> "Un+Tr"; 0x6 -> "Lk+Tr"; 0x7 -> "Un+Lk+Tr"; 0x8 -> "PANIC"
                    else -> "Unknown"
                }
            }
            C.SUBARU -> {
                // Little-endian byte view of the 64-bit key (Flipper's (uint8_t*)&data).
                val b = IntArray(8) { byte(data, it * 8) }
                serial = (b[1].toLong() shl 16) or (b[2].toLong() shl 8) or b[3].toLong()
                btn = (b[0] and 0x0F).toString()
                cnt = subaruDecodeCount(b)
            }
            C.KIA_V5 -> {
                var yek = 0L
                for (i in 0 until 8) {
                    val bt = byte(data2, i * 8)
                    var reversed = 0
                    for (bb in 0 until 8) if ((bt and (1 shl bb)) != 0) reversed = reversed or (1 shl (7 - bb))
                    yek = yek or (reversed.toLong() shl ((7 - i) * 8))
                }
                serial = (yek ushr 32) and 0x0FFFFFFF
                btn = ((yek ushr 60) and 0x0F).toInt().toString()
                cnt = kiaV5Count(u32(yek))
            }
            C.KIA_V3V4 -> { serial = u32(data); btn = "?" }  // not decrypted
            C.KIA_V2 -> {
                serial = u32(data ushr 20)
                val button = ((data ushr 16) and 0x0F).toInt()
                val rawCount = ((data ushr 4) and 0xFFF).toInt()
                cnt = ((rawCount ushr 4) or (rawCount shl 8)) and 0xFFF
                btn = button.toString()
            }
            C.KIA_V1 -> {
                serial = u32(data ushr 24)
                val button = ((data ushr 16) and 0xFF).toInt()
                cnt = (((data ushr 4) and 0xF).toInt() shl 8) or ((data ushr 8) and 0xFF).toInt()
                btn = button.toString()
            }
            C.KIA_V0, C.BMW_V0 -> {
                serial = (data ushr 12) and 0x0FFFFFFF
                val button = ((data ushr 8) and 0x0F).toInt()
                cnt = ((data ushr 40) and 0xFFFF).toInt()
                btn = button.toString()
            }
            C.FORD_V0 -> {
                val buf = IntArray(13)
                for (i in 0 until 8) buf[i] = byte(data, 56 - i * 8)
                buf[8] = byte(data2, 8); buf[9] = (data2 and 0xFF).toInt()
                var tmp = buf[8]; var parity = 0
                val parityAny = tmp != 0
                while (tmp != 0) { parity = parity xor (tmp and 1); tmp = tmp ushr 1 }
                buf[11] = if (parityAny) parity else 0
                val xorByte: Int; val limit: Int
                if (buf[11] != 0) { xorByte = buf[7]; limit = 7 } else { xorByte = buf[6]; limit = 6 }
                for (idx in 1 until limit) buf[idx] = buf[idx] xor xorByte
                if (buf[11] == 0) buf[7] = buf[7] xor xorByte
                val origB7 = buf[7]
                buf[7] = (origB7 and 0xAA) or (buf[6] and 0x55)
                val mixed = (buf[6] and 0xAA) or (origB7 and 0x55)
                buf[12] = mixed; buf[6] = mixed
                val serialLe = buf[1].toLong() or (buf[2].toLong() shl 8) or (buf[3].toLong() shl 16) or (buf[4].toLong() shl 24)
                serial = ((serialLe and 0xFF) shl 24) or (((serialLe ushr 8) and 0xFF) shl 16) or (((serialLe ushr 16) and 0xFF) shl 8) or ((serialLe ushr 24) and 0xFF)
                val button = (buf[5] ushr 4) and 0x0F
                cnt = ((buf[5] and 0x0F) shl 16) or (buf[6] shl 8) or buf[7]
                btn = button.toString()
            }
            C.FIAT_V0 -> {
                serial = u32(data); cnt = u32(data ushr 32).toInt()
                btn = (data2 and 0xFF).toInt().toString()
            }
            else -> {}
        }
        return CarInfo(name, serial, btn, cnt, emptyList())
    }
}
