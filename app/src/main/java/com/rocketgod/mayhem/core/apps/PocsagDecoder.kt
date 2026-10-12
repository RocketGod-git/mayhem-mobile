package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.BitSync
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.PacketLog

/**
 * POCSAG pager decoder (Mayhem proc_pocsag2 + pocsag.cpp). Rides on the NFM discriminator: three symbol clocks
 * (512 / 1200 / 2400 baud) hunt for the sync codeword in either polarity; the one that finds it takes over for the
 * transmission. Codewords are BCH(31,21)-corrected (Mayhem's EccContainer), addresses/functions extracted, and
 * alphanumeric / numeric messages assembled across batches.
 */
class PocsagDecoder(private val log: PacketLog) : IqProcessor {
    override val wantsFm: Boolean get() = true

    private val bauds = intArrayOf(512, 1200, 2400)
    private var syncs: Array<BitSync> = emptyArray()
    private var fmRate = 0
    private val shift = IntArray(3)
    private var locked = -1
    private var inverted = false
    private var cw = 0
    private var bitCount = 0
    private var cwCount = 0
    private var address = -1
    private var function = 0
    private val msgBits = IntArray(8192)
    private var msgBitCount = 0
    private var msgCodewords = 0
    private val ecc = PocsagEcc()

    override fun reset(rate: Int) { fmRate = 0; unlock() }
    override fun onIq(iq: ByteArray, len: Int, rate: Int) {}

    override fun onFm(samples: FloatArray, n: Int, rate: Int) {
        if (rate != fmRate) {
            fmRate = rate
            syncs = Array(3) { BitSync(bauds[it].toDouble(), rate.toDouble()) }
            unlock()
        }
        for (i in 0 until n) {
            val x = -samples[i]   // POCSAG '1' = negative deviation → flip so '1' is positive
            if (locked < 0) {
                for (b in 0 until 3) {
                    val bit = syncs[b].push(x)
                    if (bit < 0) continue
                    shift[b] = (shift[b] shl 1) or bit
                    if (bitDiff(shift[b], SYNC) <= 2) { locked = b; inverted = false; startBatch() }
                    else if (bitDiff(shift[b], SYNC.inv()) <= 2) { locked = b; inverted = true; startBatch() }
                }
            } else {
                val raw = syncs[locked].push(x)
                if (raw >= 0) onBit(if (inverted) raw xor 1 else raw)
            }
        }
    }

    private fun startBatch() { cw = 0; bitCount = 0; cwCount = 0 }

    private fun unlock() {
        endMessage()
        locked = -1; cw = 0; bitCount = 0; cwCount = 0
        for (b in 0 until 3) shift[b] = 0
        for (s in syncs) s.reset()
    }

    private fun onBit(bit: Int) {
        cw = (cw shl 1) or bit
        bitCount++
        if (bitCount < 32) return
        bitCount = 0
        if (cwCount >= 16) {
            // Next codeword after a batch must be the sync word, else the transmission ended.
            if (bitDiff(cw, SYNC) <= 2) cwCount = 0 else unlock()
            return
        }
        processCodeword(cwCount, cw)
        cwCount++
    }

    private fun processCodeword(idx: Int, raw: Int) {
        val errs = ecc.correct(raw)
        val c = ecc.out
        if (errs >= 3) { return }                       // uncorrectable: skip
        if (c == IDLE) { endMessage(); return }
        val isAddress = (c and (1 shl 31)) == 0
        if (isAddress) {
            endMessage()
            address = (((c ushr 13) and 0x3FFFF) shl 3) or (idx shr 1)
            function = (c ushr 11) and 3
        } else {
            if (address < 0) return
            if (msgBitCount + 20 > msgBits.size) return
            for (b in 30 downTo 11) msgBits[msgBitCount++] = (c ushr b) and 1
            msgCodewords++
        }
    }

    private fun endMessage() {
        if (address < 0) return
        val baud = if (locked >= 0) bauds[locked] else 0
        val head = "RIC %07d F%d %4dbps".format(address, function, baud)
        if (msgBitCount == 0) {
            log.add("$head TONE")
        } else {
            val alpha = decodeAlpha()
            val numeric = decodeNumeric()
            val useNumeric = if (msgCodewords >= 8) false else if (function == 0) true else !looksAlpha(alpha)
            log.add(if (useNumeric) "$head NUM: $numeric" else "$head ALPHA: $alpha")
        }
        address = -1; msgBitCount = 0; msgCodewords = 0
    }

    /** 7-bit ASCII, LSB first, packed across message codewords. */
    private fun decodeAlpha(): String {
        val sb = StringBuilder()
        var i = 0
        while (i + 7 <= msgBitCount) {
            var ch = 0
            for (b in 0 until 7) ch = ch or (msgBits[i + b] shl b)
            i += 7
            when {
                ch == 0 -> {}
                ch in 0x20..0x7e -> sb.append(ch.toChar())
                ch == 0x0a || ch == 0x0d -> sb.append(' ')
                else -> sb.append('·')
            }
        }
        return sb.toString().trimEnd()
    }

    /** 4-bit BCD, LSB first: 0-9, R, U, space, -, ], [ */
    private fun decodeNumeric(): String {
        val sb = StringBuilder()
        var i = 0
        while (i + 4 <= msgBitCount) {
            val d = msgBits[i] or (msgBits[i + 1] shl 1) or (msgBits[i + 2] shl 2) or (msgBits[i + 3] shl 3)
            i += 4
            sb.append(NUMERIC_CHARS[d])
        }
        return sb.toString().trimEnd()
    }

    private fun looksAlpha(s: String): Boolean {
        if (s.isEmpty()) return false
        var good = 0
        for (c in s) if (c.isLetterOrDigit() || c == ' ' || c == '.' || c == ',' || c == ':' || c == '-' || c == '/') good++
        return good * 10 >= s.length * 7
    }

    private fun bitDiff(a: Int, b: Int): Int = Integer.bitCount(a xor b)

    companion object {
        const val SYNC = 0x7CD215D8
        const val IDLE = 0x7A89C197
        private const val NUMERIC_CHARS = "0123456789RU -]["
    }
}

/** BCH(31,21) error correction for POCSAG codewords — direct port of Mayhem's EccContainer (pocsag.cpp). */
class PocsagEcc {
    private val ecs = IntArray(21)
    private val bch = IntArray(1024)
    /** Corrected codeword after [correct]. */
    var out = 0; private set

    init {
        var srr = 0x3b4
        for (i in 0..20) {
            ecs[i] = srr
            srr = if ((srr and 0x01) != 0) (srr shr 1) xor 0x3B4 else srr shr 1
        }
        for (n in 0..20) for (i in 0..20) { val j = (i shl 5) + n; val k = ecs[n] xor ecs[i]; bch[k] = j + 0x2000 }
        for (n in 0..20) { val k = ecs[n]; val j = n + (0x1f shl 5); bch[k] = j + 0x1000 }
        for (n in 0..20) for (i in 0 until 10) { val k = ecs[n] xor (1 shl i); val j = n + (0x1f shl 5); bch[k] = j + 0x2000 }
        for (n in 0 until 10) bch[1 shl n] = 0x3ff + 0x1000
        for (n in 0 until 10) for (i in 0 until 10) if (i != n) bch[(1 shl n) xor (1 shl i)] = 0x3ff + 0x2000
    }

    /** Returns the error count (0, 1, 2; 3 = uncorrectable) and leaves the corrected word in [out]. */
    fun correct(input: Int): Int {
        var v = input
        var ecc = 0
        for (i in 31 downTo 11) if (v and (1 shl i) != 0) ecc = ecc xor ecs[31 - i]
        var acc = 0
        for (i in 10 downTo 1) { acc = acc shl 1; if (v and (1 shl i) != 0) acc = acc xor 0x01 }
        val synd = ecc xor acc
        var errl = 0
        if (synd != 0) {
            if (bch[synd] != 0) {
                val b1 = bch[synd] and 0x1f
                val b2 = (bch[synd] shr 5) and 0x1f
                if (b2 != 0x1f) v = v xor (1 shl (31 - b2))
                if (b1 != 0x1f) v = v xor (1 shl (31 - b1))
                errl = bch[synd] shr 12
            } else errl = 3
        }
        if (errl == 4) errl = 3
        out = v
        return errl
    }
}
