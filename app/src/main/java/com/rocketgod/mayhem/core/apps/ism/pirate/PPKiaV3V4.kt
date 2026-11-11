// Port of ProtoPirate protocols/kia_v3_v4.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Kia V3/V4: FM, PWM at 400 / 800 µs after a short-pair preamble and a ~1.2 ms sync (high sync = V4, low sync = V3,
 * whose bits arrive inverted). 64 key bits plus a CRC nibble: a KeeLoq hop (checked against the manufacturer key),
 * a 28-bit serial and a button, all bit-reversed per byte.
 */
class PPKiaV3V4 : PPDecoder("Kia V3/V4", PPModulation.FM, PPConst(400, 800, 150, 68)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBLE = 1; private const val STEP_COLLECT_RAW_BITS = 2
        private val versionNames = arrayOf("Kia V4", "Kia V3")
    }

    private var rawBits = IntArray(32)
    private var rawBitCount = 0
    private var isV3Sync = false
    private var encrypted = 0L
    private var decrypted = 0L
    private var crc = 0
    private var version = 0

    private fun addRawBit(bit: Boolean) {
        if (rawBitCount < 256) {
            val byteIdx = rawBitCount / 8; val bitIdx = 7 - rawBitCount % 8
            if (bit) rawBits[byteIdx] = rawBits[byteIdx] or (1 shl bitIdx) else rawBits[byteIdx] = rawBits[byteIdx] and (1 shl bitIdx).inv() and 0xFF
            rawBitCount++
        }
    }

    private fun processBuffer(): Boolean {
        if (rawBitCount < 68) return false
        if (isV3Sync) {
            for (i in 0 until (rawBitCount + 7) / 8) rawBits[i] = rawBits[i].inv() and 0xFF
        }
        val b = rawBits
        fun r(v: Int) = PPMath.reverseBits8(v).toLong()
        val crc = (b[8] ushr 4) and 0x0F
        val enc = (r(b[3]) shl 24) or (r(b[2]) shl 16) or (r(b[1]) shl 8) or r(b[0])
        val ser = (r(b[7] and 0xF0) shl 24) or (r(b[6]) shl 16) or (r(b[5]) shl 8) or r(b[4])
        val bt = ((r(b[7]) and 0xF0) ushr 4).toInt()
        val ourSerialLsb = (ser and 0xFF).toInt()
        val dec = KeeLoq.decrypt(enc, PPKeys.kiaMf ?: 0L)
        val decBtn = ((dec ushr 28) and 0x0F).toInt(); val decSerialLsb = ((dec ushr 16) and 0xFF).toInt()
        if (decBtn != bt || decSerialLsb != ourSerialLsb) return false
        encrypted = enc; decrypted = dec; this.crc = crc
        serial = ser; btn = bt; cnt = dec and 0xFFFF
        version = if (isV3Sync) 1 else 0
        data = PPMath.bytesToU64BE(b.copyOfRange(0, 8))
        dataCountBit = 68
        return true
    }

    override fun reset() {
        parserStep = STEP_RESET; headerCount = 0; rawBitCount = 0; crc = 0
        rawBits = IntArray(32)
    }

    private fun startCollect(v3: Boolean) {
        parserStep = STEP_COLLECT_RAW_BITS; rawBitCount = 0; isV3Sync = v3
        rawBits = IntArray(32)
    }

    override fun feed(level: Boolean, duration: Int) {
        val isSync = duration > 1000 && duration < 1500
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, c.teShort) < c.teDelta) {
                parserStep = STEP_CHECK_PREAMBLE; teLast = duration; headerCount = 1
            }
            STEP_CHECK_PREAMBLE -> if (level) {
                if (dd(duration, c.teShort) < c.teDelta) teLast = duration
                else if (isSync) { if (headerCount >= 8) startCollect(false) else parserStep = STEP_RESET }
                else parserStep = STEP_RESET
            } else {
                if (isSync) { if (headerCount >= 8) startCollect(true) else parserStep = STEP_RESET }
                else if (dd(duration, c.teShort) < c.teDelta && dd(teLast, c.teShort) < c.teDelta) headerCount = (headerCount + 1) and 0xFFFF
                else if (duration > 1500) parserStep = STEP_RESET
            }
            STEP_COLLECT_RAW_BITS -> if (level) {
                if (isSync) {
                    if (processBuffer()) emit()
                    parserStep = STEP_RESET
                } else if (dd(duration, c.teShort) < c.teDelta) addRawBit(false)
                else if (dd(duration, c.teLong) < c.teDelta) addRawBit(true)
                else parserStep = STEP_RESET
            } else {
                if (isSync || duration > 1500) {
                    if (processBuffer()) emit()
                    parserStep = STEP_RESET
                }
            }
        }
    }

    override fun describe(): PPHit {
        val yek = PPMath.reverseKey(data, 64)
        return PPHit(versionNames[version], dataCountBit, hx("%016X", data), serial, hx("%01X", btn.toLong()), cnt,
            listOf(MeshField("Yek", hx("%016X", yek)), MeshField("CRC", hx("%01X", crc.toLong()))))
    }

    /** kia_v3_v4.c get_string: "%s %dbit\r\nKey:%08lX%08lX\r\nYek:%08lX%08lX\r\nSerial:%07lX Btn:%01X\r\nCnt:%04lX CRC:%01X\r\n". */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | Key:${h.key} | Yek:${h.fields[0].value} | " + hx("Serial:%07X", h.serial ?: 0) +
            " Btn:${h.btn ?: ""} | " + hx("Cnt:%04X", h.cnt ?: 0) + " CRC:${h.fields[1].value}"
}
