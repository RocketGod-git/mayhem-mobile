// Port of ProtoPirate protocols/honda_v2.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Honda V2: FM, 250 / 500 µs short-pair preamble (64+ pairs), a 750 µs sync pair, then 81 bits in a differential
 * pulse code: a 24-bit command signature, 24-bit serial, 9-bit counter, a 3-bit check, a 16-bit tail and one extra bit.
 */
class PPHondaV2 : PPDecoder("Honda V2", PPModulation.FM, PPConst(250, 500, 100, 81)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_PREAMBLE_LOW = 1; private const val STEP_PREAMBLE_HIGH = 2
        private const val STEP_SYNC_LOW = 3; private const val STEP_DATA = 4
        private const val MIN_PREAMBLE_PAIRS = 64; private const val SYNC_US = 750; private const val SYNC_DELTA_US = 120
        private const val BTN_UNKNOWN = 0x00; private const val BTN_LOCK = 0x02; private const val BTN_UNLOCK = 0x04
        private const val SIG_UNLOCK = 0xA285E3L; private const val SIG_LOCK = 0xC20363L

        private fun buttonFromSignature(s: Long): Int = if (s == SIG_UNLOCK) BTN_UNLOCK else if (s == SIG_LOCK) BTN_LOCK else BTN_UNKNOWN
        fun buttonName(b: Int): String = when (b) { BTN_LOCK -> "Lock"; BTN_UNLOCK -> "Unlock"; else -> "Unknown" }
        private fun calculateCheck(c: Long): Int {
            val c0 = ((c ushr 1) xor (c ushr 2) xor (c ushr 3) xor (c ushr 4) xor (c ushr 6)) and 1
            val c1 = ((c ushr 0) xor (c ushr 2) xor (c ushr 3) xor (c ushr 4) xor (c ushr 5) xor (c ushr 6) xor 1) and 1
            val c2 = ((c ushr 1) xor (c ushr 3) xor (c ushr 4) xor (c ushr 5) xor (c ushr 6)) and 1
            return (c0 or (c1 shl 1) or (c2 shl 2)).toInt()
        }
        private fun calculateTail(c: Long): Int =
            if ((((c ushr 0) xor (c ushr 2) xor (c ushr 4) xor (c ushr 5)) and 1) != 0L) 0xFFFF else 0x7FFF
    }

    private var preambleCount = 0
    private var raw = IntArray(10)
    private var bitCount = 0
    private var extraBit = false
    private var previousBit = true
    private var boundaryPadSkipped = false
    private var pendingShort = false
    private var key = 0L
    private var tail = 0
    private var commandSignature = 0L
    private var serialV2 = 0L
    private var count = 0L
    private var button = 0
    private var check = 0
    private var checkOk = false
    private var tailOk = false

    private fun isSync(d: Int) = dd(d, SYNC_US) < SYNC_DELTA_US

    private fun parseKeyFields(k: Long) {
        val b = PPMath.u64ToBytesBE(k)
        val sig = (b[0].toLong() shl 16) or (b[1].toLong() shl 8) or b[2].toLong()
        commandSignature = sig
        serialV2 = (b[3].toLong() shl 16) or (b[4].toLong() shl 8) or b[5].toLong()
        count = (b[6].toLong() shl 1) or ((b[7] ushr 7) and 1).toLong()
        button = buttonFromSignature(sig)
        check = b[7] and 0x07
    }

    private fun validateFrame(k: Long, t: Int, extra: Boolean): Boolean {
        val b = PPMath.u64ToBytesBE(k)
        val c = (b[6].toLong() shl 1) or ((b[7] ushr 7) and 1).toLong()
        checkOk = (b[7] and 0x78) == 0 && (b[7] and 0x07) == calculateCheck(c)
        tailOk = t == calculateTail(c) && extra
        return checkOk && tailOk
    }

    private fun addDecodedBit(bit: Boolean): Boolean {
        if (bitCount < 80) {
            if (bit) raw[bitCount / 8] = raw[bitCount / 8] or (1 shl (7 - bitCount % 8))
        } else if (bitCount == 80) {
            extraBit = bit
        } else return false
        bitCount++
        return true
    }

    private fun finishFrame(): Boolean {
        val k = PPMath.bytesToU64BE(raw)
        val t = (raw[8] shl 8) or raw[9]
        if (!validateFrame(k, t, extraBit)) return false
        key = k; tail = t
        parseKeyFields(k)
        data = key
        dataCountBit = c.minBits
        serial = serialV2; btn = button; cnt = count
        return true
    }

    private fun processTransition(level: Boolean, duration: Int): Boolean {
        if (!boundaryPadSkipped) {
            if (level && isShort(duration)) { boundaryPadSkipped = true; return true }
            boundaryPadSkipped = true
        }
        if (pendingShort) {
            if (!previousBit && !level && isShort(duration)) { pendingShort = false; return addDecodedBit(false) }
            else if (previousBit && level && isShort(duration)) { pendingShort = false; return addDecodedBit(true) }
            return false
        }
        if (!previousBit) {
            if (level && isLong(duration)) { previousBit = true; return addDecodedBit(true) }
            else if (level && isShort(duration)) { pendingShort = true; return true }
            return false
        }
        if (!level && isLong(duration)) { previousBit = false; return addDecodedBit(false) }
        else if (!level && isShort(duration)) { pendingShort = true; return true }
        return false
    }

    override fun reset() {
        super.reset()
        parserStep = STEP_RESET; teLast = 0; preambleCount = 0
        raw = IntArray(10); bitCount = 0; extraBit = false
        previousBit = true; boundaryPadSkipped = false; pendingShort = false
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (level && isShort(duration)) { preambleCount = 0; parserStep = STEP_PREAMBLE_LOW }
            STEP_PREAMBLE_LOW -> if (!level && isShort(duration)) { preambleCount++; parserStep = STEP_PREAMBLE_HIGH }
                else parserStep = STEP_RESET
            STEP_PREAMBLE_HIGH -> if (level && isShort(duration)) parserStep = STEP_PREAMBLE_LOW
                else if (level && isSync(duration) && preambleCount >= MIN_PREAMBLE_PAIRS) parserStep = STEP_SYNC_LOW
                else parserStep = STEP_RESET
            STEP_SYNC_LOW -> if (!level && isSync(duration)) {
                raw = IntArray(10); bitCount = 0; extraBit = false
                previousBit = true; boundaryPadSkipped = false; pendingShort = false
                addDecodedBit(true)
                parserStep = STEP_DATA
            } else parserStep = STEP_RESET
            STEP_DATA -> {
                if (!processTransition(level, duration)) parserStep = STEP_RESET
                else if (bitCount == c.minBits) {
                    if (finishFrame()) emit()
                    parserStep = STEP_RESET
                }
            }
        }
        teLast = duration
    }

    override fun describe(): PPHit {
        val tailShown = if (((tail ushr 15) and 1) != 0) 0x1FFFFL else 0x0FFFFL
        return PPHit(name, dataCountBit, hx("%016X", key), serialV2, hx("%02X - ", button.toLong()) + buttonName(button), count,
            listOf(MeshField("BtnSig", hx("%06X", commandSignature)),
                MeshField("Chk", hx("%02X [", check.toLong()) + (if (checkOk) "OK" else "BAD") + "]"),
                MeshField("Tail", hx("%05X [", tailShown) + (if (tailOk) "OK" else "BAD") + "]")))
    }

    /**
     * honda_v2.c get_string: "%s %dbit\r\nKey:%016llX\r\nSn:%06lX  Btn:%02X - %s\r\nBtnSig:%06lX\r\n
     * Cnt:%05lX  Chk:%02X [%s]  Tail:%05lX [%s]\r\n".
     */
    override fun cString(h: PPHit): String {
        val f = h.fields
        return "${h.name} ${h.bits}bit | Key:${h.key} | " + hx("Sn:%06X", h.serial ?: 0) + "  Btn:${h.btn ?: ""}" +
            " | BtnSig:${f[0].value} | " + hx("Cnt:%05X", h.cnt ?: 0) + "  Chk:${f[1].value}  Tail:${f[2].value}"
    }
}
