// Port of ProtoPirate protocols/fiat_v1.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Fiat V1 (BCM Hitag2): AM, Manchester cells at either 250 / 500 µs (variant A) or 100 / 200 µs (variant B), both
 * tracked at once in a sliding 208-cell window; 104 wire bits = 13 bytes: 00, family 01, a 32-bit UID, a 4-bit
 * button, a 10-bit control counter, a 32-bit Hitag2 authenticator, 2 tail bits, and an XOR byte. The authenticator is
 * checked against ProtoPirate's built-in list of known Hitag2 keys (epoch 0).
 */
class PPFiatV1 : PPDecoder("Fiat V1", PPModulation.AM, CONSTS[0]) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_DATA = 1
        private const val WIRE_BITS = 104; private const val WIRE_BYTES = 13; private const val WIRE_CELLS = 208; private const val LOGICAL_BITS = 102
        private const val BOUNDARY_MIN_US = 800; private const val DEFAULT_TAIL_BITS = 2
        private const val VARIANT_A = 0; private const val VARIANT_B = 1
        private val CONSTS = arrayOf(PPConst(250, 500, 100, 102), PPConst(100, 200, 50, 102))
        private val knownKeys = arrayOf(
            intArrayOf(0xB7, 0x92, 0x80, 0xAE, 0xCC, 0x37),
            intArrayOf(0xD4, 0x24, 0x28, 0xF7, 0xD9, 0x66),
            intArrayOf(0x4D, 0x34, 0x3F, 0xD4, 0xE7, 0xB6),
            intArrayOf(0x6D, 0x6B, 0xF2, 0x1D, 0x3A, 0x1A),
            intArrayOf(0xA3, 0xF3, 0xAC, 0xF7, 0xB9, 0x10),
            intArrayOf(0x4D, 0x49, 0x4B, 0x52, 0x4F, 0x4E),
            intArrayOf(0xCD, 0x49, 0x4B, 0x52, 0x4F, 0x4E),
            intArrayOf(0x33, 0xFA, 0x2F, 0xCD, 0xC3, 0x3B),
            intArrayOf(0xF6, 0x1A, 0xEF, 0x9C, 0xD0, 0x1B),
        )

        // ---- durations ----
        private fun isShortV(v: Int, d: Int) = kotlin.math.abs(d - CONSTS[v].teShort) < CONSTS[v].teDelta
        private fun isLongV(v: Int, d: Int) = kotlin.math.abs(d - CONSTS[v].teLong) < CONSTS[v].teDelta
        private fun isPulse(d: Int) = (0 until 2).any { isShortV(it, d) || isLongV(it, d) }

        fun buttonValid(b: Int) = b == 0x1 || b == 0x2 || b == 0x4 || b == 0x8
        fun buttonName(b: Int): String = when (b) { 0x8 -> "Unlock"; 0x4 -> "Lock"; 0x2 -> "Trunk"; 0x1 -> "Close"; else -> "Unknown" }
        fun frameXor(raw: IntArray): Int { var v = 0x01; for (i in 0 until 12) v = v xor raw[i]; return v }
        fun uid(raw: IntArray): Long = (raw[2].toLong() shl 24) or (raw[3].toLong() shl 16) or (raw[4].toLong() shl 8) or raw[5].toLong()
        fun counter(raw: IntArray): Long = ((raw[6] and 0x0F).toLong() shl 6) or (raw[7] ushr 2).toLong()
        fun hop(raw: IntArray): Long =
            ((raw[7] and 0x03).toLong() shl 30) or (raw[8].toLong() shl 22) or (raw[9].toLong() shl 14) or (raw[10].toLong() shl 6) or (raw[11] ushr 2).toLong()
        fun frameValid(raw: IntArray): Boolean {
            if (raw[0] != 0x00 || raw[1] != 0x01) return false
            if (frameXor(raw) != raw[12]) return false
            if (!buttonValid(raw[6] ushr 4)) return false
            val u = uid(raw)
            return u != 0L && u != M32
        }

        // ---- BCM Hitag2 ----
        private fun truth(table: Long, index: Int): Int = ((table ushr index) and 1).toInt()
        private fun fidx(a: Int, b: Int, c: Int, d: Int): Int = (a shl 3) or (b shl 2) or (c shl 1) or d
        private fun bb(byte: Int, bit: Int): Int = (byte ushr bit) and 1

        fun hitag2Filter(s: IntArray): Int {
            var g = 0
            g = g or truth(0x2c79, fidx(bb(s[0], 1), bb(s[0], 2), bb(s[0], 4), bb(s[0], 5)))
            g = g or (truth(0x6671, fidx(bb(s[1], 0), bb(s[1], 1), bb(s[1], 3), bb(s[1], 7))) shl 1)
            g = g or (truth(0x6671, fidx(bb(s[3], 5), bb(s[2], 0), bb(s[2], 2), bb(s[2], 6))) shl 2)
            g = g or (truth(0x6671, fidx(bb(s[4], 6), bb(s[3], 0), bb(s[3], 2), bb(s[3], 3))) shl 3)
            g = g or (truth(0x2c79, fidx(bb(s[5], 1), bb(s[5], 3), bb(s[5], 4), bb(s[4], 5))) shl 4)
            return truth(0x7907287bL, g)
        }
        private fun parity8(v0: Int): Int { var v = v0; v = v xor (v ushr 4); v = v xor (v ushr 2); v = v xor (v ushr 1); return v and 1 }
        private val feedbackMasks = intArrayOf(0xb3, 0x80, 0x83, 0x22, 0x00, 0x73)
        fun hitag2Feedback(s: IntArray): Int {
            var f = 0
            for (i in 0 until 6) f = f xor parity8(s[i] and feedbackMasks[i])
            return f and 1
        }
        fun hitag2Shift(s: IntArray, input: Int) {
            for (i in 0 until 5) s[i] = ((s[i] shl 1) or (s[i + 1] ushr 7)) and 0xFF
            s[5] = ((s[5] shl 1) or (input and 1)) and 0xFF
        }

        fun generateAuthenticator(uid: Long, button: Int, control: Int, key: IntArray, epoch: Long): Long {
            val state = intArrayOf(((uid ushr 24) and 0xFF).toInt(), ((uid ushr 16) and 0xFF).toInt(),
                ((uid ushr 8) and 0xFF).toInt(), (uid and 0xFF).toInt(), key[4], key[5])
            val iv = (((epoch and 0x3FFFF) shl 14) or ((control.toLong() and 0x03FF) shl 4) or (button.toLong() and 0x0F)) and M32
            for (i in 0 until 32) {
                val input = ((iv ushr (31 - i)) and 1).toInt() xor ((key[i shr 3] ushr (7 - (i and 7))) and 1) xor hitag2Filter(state)
                hitag2Shift(state, input)
            }
            var auth = 0L
            repeat(32) {
                auth = ((auth shl 1) or hitag2Filter(state).toLong()) and M32
                hitag2Shift(state, hitag2Feedback(state))
            }
            return auth
        }

        private fun keyMatches(uid: Long, button: Int, control: Int, hop: Long, key: IntArray, epoch: Long): Boolean =
            generateAuthenticator(uid, button, control, key, epoch) == hop
        private fun keyMatchesAnyButton(uid: Long, control: Int, hop: Long, key: IntArray, epoch: Long): Boolean {
            for (b in intArrayOf(0x1, 0x2, 0x4, 0x8)) if (keyMatches(uid, b, control, hop, key, epoch)) return true
            return false
        }
    }

    private val cells = arrayOf(IntArray(WIRE_CELLS), IntArray(WIRE_CELLS))
    private val cellCount = IntArray(2)
    private var rawData = IntArray(13)
    private var lastRawData = IntArray(13)
    private var lastRawValid = false
    private var uid = 0L
    private var hop = 0L
    private var family = 0
    private var tailBits = 2
    private var frameXor = 0
    private var hitag2Key = IntArray(6)
    private var hitag2Epoch = 0L
    private var hitag2KeyValid = false
    private var teVariant = 1

    init { reset() }

    override fun reset() {
        rawData = IntArray(13); lastRawData = rawData.copyOf()
        parserStep = STEP_RESET; decodeData = 0; decodeCountBit = 0
        lastRawValid = false
        data = 0; dataCountBit = 0; serial = 0; btn = 0; cnt = 0
        uid = 0; hop = 0; family = 0; tailBits = DEFAULT_TAIL_BITS; frameXor = 0
        hitag2KeyValid = false; hitag2Epoch = 0; teVariant = VARIANT_B
        hitag2Key = IntArray(6)
        clearAllCells()
    }

    private fun clearCells(v: Int) { cellCount[v] = 0; cells[v].fill(0) }
    private fun clearAllCells() { for (v in 0 until 2) clearCells(v) }

    private fun decodeFields() {
        family = rawData[1]
        uid = uid(rawData)
        serial = uid
        btn = rawData[6] ushr 4
        cnt = counter(rawData)
        hop = hop(rawData)
        tailBits = rawData[11] and 0x03
        frameXor = rawData[12]
        data = (serial shl 32) or hop
        dataCountBit = LOGICAL_BITS
        decodeData = data; decodeCountBit = dataCountBit
        verifyHitag2Key()
    }

    private fun commit(raw: IntArray, variant: Int): Boolean {
        if (!frameValid(raw)) return false
        if (lastRawValid && lastRawData.contentEquals(raw)) return true
        rawData = raw.copyOf(); lastRawData = raw.copyOf(); lastRawValid = true
        teVariant = if (variant == VARIANT_A) VARIANT_A else VARIANT_B
        decodeFields()
        emit()
        return true
    }

    private fun tryDecodeWindow(v: Int, invert: Boolean): Boolean {
        if (cellCount[v] != WIRE_CELLS) return false
        val cl = cells[v]
        val raw = IntArray(WIRE_BYTES)
        for (bi in 0 until WIRE_BITS) {
            val first = cl[bi * 2]; val second = cl[bi * 2 + 1]
            if (first == second) return false
            var bit = first != 0
            if (invert) bit = !bit
            if (bit) raw[bi shr 3] = raw[bi shr 3] or (1 shl (7 - (bi and 7)))
        }
        return commit(raw, v)
    }

    private fun tryDecode(v: Int) {
        if (tryDecodeWindow(v, false)) return
        tryDecodeWindow(v, true)
    }

    private fun pushCell(v: Int, level: Boolean) {
        if (cellCount[v] < WIRE_CELLS) {
            cells[v][cellCount[v]] = if (level) 1 else 0; cellCount[v]++
        } else {
            System.arraycopy(cells[v], 1, cells[v], 0, WIRE_CELLS - 1); cells[v][WIRE_CELLS - 1] = if (level) 1 else 0
        }
        tryDecode(v)
    }

    private fun feedDataPulse(level: Boolean, duration: Int): Boolean {
        var matched = false
        for (v in 0 until 2) {
            if (isShortV(v, duration)) {
                pushCell(v, level); matched = true
            } else if (isLongV(v, duration)) {
                pushCell(v, level); pushCell(v, level); matched = true
            } else {
                if (!level && duration >= BOUNDARY_MIN_US) pushCell(v, false)
                clearCells(v)
            }
        }
        return matched
    }

    private fun verifyHitag2Key() {
        hitag2KeyValid = false; hitag2Epoch = 0; hitag2Key = IntArray(6)
        val control = (cnt and 0x03FF).toInt()
        for (k in knownKeys) {
            if (keyMatches(uid, btn, control, hop, k, 0) || keyMatchesAnyButton(uid, control, hop, k, 0)) {
                hitag2Key = k.copyOf(); hitag2Epoch = 0; hitag2KeyValid = true
                return
            }
        }
    }

    override fun feed(level: Boolean, duration: Int) {
        when (parserStep) {
            STEP_RESET -> if (isPulse(duration)) {
                clearAllCells()
                parserStep = STEP_DATA
                feedDataPulse(level, duration)
            }
            STEP_DATA -> if (!feedDataPulse(level, duration)) parserStep = STEP_RESET
        }
    }

    override fun describe(): PPHit {
        val f = mutableListOf(MeshField("Sync", hx("%02X", family.toLong())),
            MeshField("UID", hx("%08X", uid)),
            MeshField("Auth", hx("%08X", hop)),
            MeshField("Button", buttonName(btn)),
            MeshField("Ctrl", hx("%03X", cnt)),
            MeshField("TE", "$teVariant"),
            MeshField("Tail", "$tailBits"),
            MeshField("XOR", hx("%02X", frameXor.toLong())),
            MeshField("KEY", if (hitag2KeyValid) "OK" else "??"))
        if (hitag2KeyValid) f.add(MeshField("Hitag2 Key", hitag2Key.joinToString("") { hx("%02X", it.toLong()) }))
        return PPHit(name, LOGICAL_BITS, hx("%08X %03X%01X %08X", serial, cnt, btn.toLong(), hop), serial, hx("%02X", btn.toLong()), cnt, f)
    }

    /**
     * fiat_v1.c get_string: "%s %ubit %s\r\n%08lX %03lX%01X %08lX\r\nSync:%02X UID:%08lX Auth:%08lX\r\n
     * Btn:%02X [%s] Ctrl:%03lX\r\nTE:%u Tail:%u XOR:%02X\r\n".
     */
    override fun cString(h: PPHit): String {
        val v = HashMap<String, String>()
        for (f in h.fields) v.putIfAbsent(f.name, f.value)
        return "${h.name} ${h.bits}bit KEY:${v["KEY"]} | ${h.key} | Sync:${v["Sync"]} UID:${v["UID"]} Auth:${v["Auth"]}" +
            " | Btn:${h.btn} [${v["Button"]}] Ctrl:${v["Ctrl"]} | TE:${v["TE"]} Tail:${v["Tail"]} XOR:${v["XOR"]}"
    }
}
