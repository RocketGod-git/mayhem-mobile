package com.rocketgod.mayhem.core

/**
 * Pure bit/codeword encoders for the transmit generators (Mayhem pocsag.cpp encode, rtty_tx/baudot, aprs_tx,
 * ui_rds, tones). No Android or radio dependency, so they can be unit-tested by feeding their output straight
 * back into the receive-side decoders. [Tx] turns the bit streams into FSK / AFSK / OOK IQ on the HackRF.
 */
object TxEncoders {

    // ---- POCSAG (Mayhem common/pocsag.cpp pocsag_encode + insert_BCH) ------------------------------------------
    private const val PREAMBLE = 0xAAAAAAAA.toInt()
    private const val SYNCWORD = 0x7CD215D8
    private const val IDLEWORD = 0x7A89C197.toInt()

    /** BCH(31,21) + even parity for a POCSAG codeword whose 21 data bits are already in bits 31..11. */
    fun insertBch(codewordIn: Int): Int {
        val d21 = codewordIn ushr 11
        // Systematic BCH(31,21), generator 0x769 — the standard POCSAG polynomial (matches PocsagEcc's syndrome table).
        var rem = d21 shl 10
        for (i in 30 downTo 10) if (rem and (1 shl i) != 0) rem = rem xor (0x769 shl (i - 10))
        var cw = (codewordIn and 0xFFFFF801.toInt()) or ((rem and 0x3FF) shl 1)
        var parity = 0
        for (i in 1..31) if (cw and (1 shl i) != 0) parity++
        return cw or (parity and 1)
    }

    private fun digitCode(ch: Char): Int {
        var code = when {
            ch in '0'..'9' -> ch - '0'
            ch == 'S' -> 10; ch == 'U' -> 11; ch == ' ' -> 12; ch == '-' -> 13; ch == ']' -> 14; ch == '[' -> 15
            else -> 12
        }
        code = ((code and 0x0C) shr 2) or ((code and 0x03) shl 2)
        code = ((code and 0x0A) shr 1) or ((code and 0x05) shl 1)
        return code
    }

    enum class PocsagType { ALPHANUMERIC, NUMERIC, ADDRESS_ONLY }

    /** Build the POCSAG codeword list (preamble, sync, address in its slot, message batches). Port of pocsag_encode. */
    fun pocsag(address: Int, function: Int, message: String, type: PocsagType): IntArray {
        val cw = ArrayList<Int>()
        repeat(576 / 32) { cw.add(PREAMBLE) }
        var codeword = (address and 0x1FFFF8) shl 10
        val addressSlot = (address and 7) * 2
        codeword = codeword or (function shl 11)
        codeword = insertBch(codeword)
        cw.add(SYNCWORD)
        var c = 0
        var brokeEarly = false
        while (c < 16) {
            if (c == addressSlot) { cw.add(codeword); if (type != PocsagType.ADDRESS_ONLY) { brokeEarly = true; break } }
            else cw.add(IDLEWORD)
            c++
        }
        if (type == PocsagType.ADDRESS_ONLY) return cw.toIntArray()
        c++
        codeword = 0
        var bitIdx = 20 + 11
        var charIdx = 0
        var ascii = 0
        val size = message.length
        do {
            if (c == 0) cw.add(SYNCWORD)
            while (c < 16) {
                if (type == PocsagType.ALPHANUMERIC) {
                    if (charIdx < size || ascii != 0) {
                        do {
                            bitIdx -= 7
                            ascii = if (charIdx < size) message[charIdx].code and 0x7F else 0
                            ascii = ((ascii and 0xF0) shr 4) or ((ascii and 0x0F) shl 4)
                            ascii = ((ascii and 0xCC) shr 2) or ((ascii and 0x33) shl 2)
                            ascii = ((ascii and 0xAA) shr 2) or (ascii and 0x55)
                            codeword = codeword or (ascii shl bitIdx)
                            charIdx++
                        } while (bitIdx > 11)
                        codeword = codeword and 0x7FFFF800
                        codeword = codeword or 0x80000000.toInt()
                        codeword = insertBch(codeword)
                        cw.add(codeword)
                        if (bitIdx != 11) { bitIdx += 20; codeword = ascii shl bitIdx } else { bitIdx = 20 + 11; codeword = 0 }
                    } else cw.add(IDLEWORD)
                } else if (type == PocsagType.NUMERIC) {
                    if (charIdx < size) {
                        do {
                            bitIdx -= 4
                            val dc = if (charIdx < size) digitCode(message[charIdx]) else 3
                            codeword = codeword or (dc shl bitIdx)
                            charIdx++
                        } while (bitIdx > 11)
                        codeword = codeword or 0x80000000.toInt()
                        codeword = insertBch(codeword)
                        cw.add(codeword)
                        bitIdx = 20 + 11; codeword = 0
                    } else cw.add(IDLEWORD)
                }
                c++
            }
            c = 0
        } while (charIdx < size)
        if (brokeEarly) { /* address batch was cut short at the slot; message batches already appended */ }
        return cw.toIntArray()
    }

    /** POCSAG on-air bits, MSB first, of a codeword list. '1' bit = TRUE. */
    fun pocsagBits(codewords: IntArray): BooleanArray {
        val bits = BooleanArray(codewords.size * 32)
        var i = 0
        for (w in codewords) for (b in 31 downTo 0) bits[i++] = (w ushr b) and 1 == 1
        return bits
    }

    // ---- Baudot / RTTY (Mayhem rtty_tx/baudot.cpp, ITA2) -------------------------------------------------------
    private val LTRS = charArrayOf(0.toChar(), 'E', '\n', 'A', ' ', 'S', 'I', 'U', '\r', 'D', 'R', 'J', 'N', 'F', 'C', 'K', 'T', 'Z', 'L', 'W', 'H', 'Y', 'P', 'Q', 'O', 'B', 'G', 0.toChar(), 'M', 'X', 'V', 0.toChar())
    private val FIGS = charArrayOf(0.toChar(), '3', '\n', '-', ' ', '\'', '8', '7', '\r', '$', '4', 7.toChar(), ',', '!', ':', '(', '5', '+', ')', '2', '#', '6', '0', '1', '9', '?', '&', 0.toChar(), '.', '/', '=', 0.toChar())
    private const val FIGS_SHIFT = 0x1B
    private const val LTRS_SHIFT = 0x1F

    /** ITA2 5-bit symbols with LTRS/FIGS shifts for [text]. */
    fun baudot(text: String): IntArray {
        val out = ArrayList<Int>()
        var figures = false
        out.add(LTRS_SHIFT); // start in letters
        for (ch in text.uppercase()) {
            var idx = -1; var wantFigs = false
            if (ch == ' ') { out.add(0x04); continue }
            for (i in 1 until 32) { if (LTRS[i] == ch) { idx = i; wantFigs = false; break }; if (FIGS[i] == ch) { idx = i; wantFigs = true } }
            if (idx < 0) continue
            if (wantFigs != figures) { out.add(if (wantFigs) FIGS_SHIFT else LTRS_SHIFT); figures = wantFigs }
            out.add(idx)
        }
        return out.toIntArray()
    }

    // ---- AX.25 / APRS (Bell 202 AFSK) — HDLC UI frame with FCS + NRZI bits ------------------------------------
    /** A standard APRS AX.25 UI frame: dest APZMHM, source [call]-[ssid], no digipeaters, control 0x03, PID 0xF0, [info]. */
    fun ax25Aprs(source: String, info: String): ByteArray {
        val f = ArrayList<Int>()
        fun addr(call: String, ssid: Int, last: Boolean) {
            val c = call.uppercase().padEnd(6, ' ')
            for (i in 0 until 6) f.add((c[i].code and 0x7F) shl 1)
            f.add(((ssid and 0x0F) shl 1) or 0x60 or (if (last) 1 else 0))
        }
        val call = source.substringBefore('-').take(6)
        val ssid = source.substringAfter('-', "0").toIntOrNull() ?: 0
        addr("APZMHM", 0, false)          // destination (Mayhem's tocall)
        addr(call, ssid, true)            // source, last address
        f.add(0x03); f.add(0xF0)          // UI control + PID
        for (ch in info) f.add(ch.code and 0xFF)
        // FCS (CRC-16-CCITT, reflected, init 0xFFFF, xorout 0xFFFF), little-endian, over the frame so far
        var crc = 0xFFFF
        for (b in f) { var v = b; for (k in 0 until 8) { val bit = (crc and 1) xor (v and 1); crc = crc ushr 1; if (bit != 0) crc = crc xor 0x8408; v = v ushr 1 } }
        crc = crc.inv() and 0xFFFF
        f.add(crc and 0xFF); f.add((crc ushr 8) and 0xFF)
        return ByteArray(f.size) { f[it].toByte() }
    }

    /** HDLC-bitstuff + NRZI a frame, wrapped in opening/closing 0x7E flags. Returns on-air bits (true = high tone). */
    fun ax25Bits(frame: ByteArray, flags: Int = 32): BooleanArray {
        val raw = ArrayList<Boolean>()
        fun flag() { for (b in intArrayOf(0, 1, 1, 1, 1, 1, 1, 0)) raw.add(b == 1) }   // 0x7E, LSB... actually flag bits
        // Flags: 0x7E sent LSB-first is 0,1,1,1,1,1,1,0
        repeat(flags) { flag() }
        var ones = 0
        for (byte in frame) for (i in 0 until 8) {
            val bit = (byte.toInt() ushr i) and 1
            raw.add(bit == 1)
            if (bit == 1) { ones++; if (ones == 5) { raw.add(false); ones = 0 } } else ones = 0   // bit-stuff
        }
        repeat(flags) { flag() }
        // NRZI: a 0 toggles the tone, a 1 keeps it.
        val out = BooleanArray(raw.size)
        var level = true
        for (i in raw.indices) { if (!raw[i]) level = !level; out[i] = level }
        return out
    }

    // ---- DTMF ---------------------------------------------------------------------------------------------------
    private val DTMF_ROW = intArrayOf(697, 770, 852, 941)
    private val DTMF_COL = intArrayOf(1209, 1336, 1477, 1633)
    private const val DTMF_KEYS = "123A456B789C*0#D"
    /** Row/column tone pair for a DTMF key, or null. */
    fun dtmf(key: Char): Pair<Int, Int>? {
        val i = DTMF_KEYS.indexOf(key.uppercaseChar())
        return if (i < 0) null else DTMF_ROW[i / 4] to DTMF_COL[i % 4]
    }
}
