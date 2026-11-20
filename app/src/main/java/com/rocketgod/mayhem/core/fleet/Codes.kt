package com.rocketgod.mayhem.core.fleet

import com.rocketgod.mayhem.core.ham.H1393
import com.rocketgod.mayhem.core.ham.H15113
import com.rocketgod.mayhem.core.ham.golay208
import com.rocketgod.mayhem.core.ham.golayParity
import com.rocketgod.mayhem.core.ham.hamming
import com.rocketgod.mayhem.core.ham.nidWord
import com.rocketgod.mayhem.core.ham.popcount

/**
 * Fleet coding layers: P25 Phase 1 (TIA-102) control channel and DMR (ETSI TS 102 361) bursts. Decoders and the
 * matching encoders (the encoders build synthetic signals and pin each layer down in tests). Blocks are 12 bytes as
 * an IntArray, symbols are dibits 0..3.
 *
 * P25 trellis, interleave and bit assignment are the ones derived from our own recordings; the BCH Network ID,
 * BPTC(196,96) and Golay(20,8) come from the shared ham decoders.
 */
object Codes {
    // ------------------------------------------------------------------------------------------------ CRC-CCITT
    private val CRC_T = IntArray(256) { i -> var c = i shl 8; repeat(8) { c = if ((c and 0x8000) != 0) ((c shl 1) xor 0x1021) and 0xffff else (c shl 1) and 0xffff }; c }
    /** x^16+x^12+x^5+1, init 0, MSB first, output complemented, over the first [n] bytes. */
    fun crcCcitt(b: IntArray, n: Int): Int {
        var crc = 0
        for (i in 0 until n) crc = ((crc shl 8) and 0xffff) xor CRC_T[((crc shr 8) xor b[i]) and 0xff]
        return crc.inv() and 0xffff
    }
    /** A 12-byte block whose last two bytes are the CRC of the first ten, XORed with the data-type mask. */
    fun crc12Ok(b: IntArray, mask: Int = 0): Boolean = ((b[10] shl 8) or b[11]) == (crcCcitt(b, 10) xor mask)
    /** DMR CRC masks by data type (TS 102 361-1 B.3.12). */
    val DMR_CRC_MASK: Map<Int, Int> = linkedMapOf(0 to 0x6969, 3 to 0xa5a5, 4 to 0xaaaa, 5 to 0xaaaa, 6 to 0xcccc)

    // ------------------------------------------------------------------------------------------------ P25 NID
    private val nidCache = HashMap<Int, Long>()
    private fun nidCw(nac: Int, duid: Int): Long = synchronized(nidCache) {
        val k = (nac shl 4) or duid
        nidCache[k] ?: nidWord(nac, duid).also { if (nidCache.size > 4096) nidCache.clear(); nidCache[k] = it }
    }
    /** The 64 NID bits for a network access code and data unit ID, as 32 dibits. */
    fun nidEncode(nac: Int, duid: Int): IntArray {
        val w = nidCw(nac, duid)
        return IntArray(32) { ((w ushr (62 - 2 * it)) and 3L).toInt() }
    }
    class Nid(val nac: Int, val duid: Int, val errs: Int)
    /**
     * BCH(63,16) plus overall parity: nearest code word among the received NAC, the NACs already heard and every
     * single-bit change of the received one, over all 16 DUIDs. Null past 11 bit errors.
     */
    fun nidDecode(d: IntArray, known: Iterable<Int> = emptyList()): Nid? {
        var v = 0L
        for (i in 0 until 32) v = (v shl 2) or (d[i] and 3).toLong()
        val rx = (v ushr 52).toInt()
        val cands = LinkedHashSet<Int>(); cands.add(rx); cands.addAll(known)
        for (b in 0 until 12) cands.add(rx xor (1 shl b))
        var best = 99; var bn = -1; var bd = -1
        for (nac in cands) for (duid in 0 until 16) {
            val e = java.lang.Long.bitCount(v xor nidCw(nac, duid))
            if (e < best) { best = e; bn = nac; bd = duid }
        }
        return if (best <= 11) Nid(bn, bd, best) else null
    }

    // ------------------------------------------------------------------------------------------------ P25 trellis
    /** Output (two dibits, first in the high bits) by [state = previous input dibit][input dibit]. */
    val TRELLIS = arrayOf(
        intArrayOf(0b0010, 0b1100, 0b0001, 0b1111),
        intArrayOf(0b1110, 0b0000, 0b1101, 0b0011),
        intArrayOf(0b1001, 0b0111, 0b1010, 0b0100),
        intArrayOf(0b0101, 0b1011, 0b0110, 0b1000),
    )
    /** Pair-symbol k of the trellis output is sent at this pair position. */
    val TSBK_SLOT = IntArray(49) { k -> intArrayOf(0, 13, 25, 37)[k % 4] + (k shr 2) }

    /** 12 bytes to 98 transmitted dibits (rate 1/2 trellis, flush input 0, interleaved). */
    fun tsbkEncode(bytes: IntArray): IntArray {
        val pairs = IntArray(49)
        var st = 0
        for (k in 0 until 49) {
            val inp = if (k < 48) (bytes[k shr 2] shr (6 - 2 * (k and 3))) and 3 else 0
            pairs[TSBK_SLOT[k]] = TRELLIS[st][inp]; st = inp
        }
        val out = IntArray(98)
        for (j in 0 until 49) { out[2 * j] = pairs[j] shr 2; out[2 * j + 1] = pairs[j] and 3 }
        return out
    }
    class Trellis(val bytes: IntArray, val metric: Int)
    /** Hard-decision Viterbi over the 98 dibits: the 12 bytes and the path metric (bit errors corrected). */
    fun tsbkDecode(d: IntArray): Trellis {
        val sym = IntArray(49)
        for (k in 0 until 49) { val j = TSBK_SLOT[k]; sym[k] = ((d[2 * j] and 3) shl 2) or (d[2 * j + 1] and 3) }
        val inf = 1_000_000_000
        var pm = intArrayOf(0, inf, inf, inf)
        val back = IntArray(49 * 4)
        for (k in 0 until 49) {
            val np = intArrayOf(inf, inf, inf, inf)
            for (s in 0 until 4) {
                if (pm[s] >= inf) continue
                for (i in 0 until 4) {
                    if (k == 48 && i != 0) continue
                    val m = pm[s] + popcount(TRELLIS[s][i] xor sym[k])
                    if (m < np[i]) { np[i] = m; back[k * 4 + i] = s }
                }
            }
            pm = np
        }
        val inputs = IntArray(49)
        var s = 0
        for (k in 48 downTo 0) { inputs[k] = s; s = back[k * 4 + s] }
        val bytes = IntArray(12)
        for (k in 0 until 48) bytes[k shr 2] = bytes[k shr 2] or (inputs[k] shl (6 - 2 * (k and 3)))
        return Trellis(bytes, pm[0])
    }

    // ------------------------------------------------------------------------------------------------ P25 frame
    const val P25_SYNC = "5575F5FF77FF"
    /** Frame positions (counted from the first sync symbol) that carry a status symbol. */
    fun isStatusPos(pos: Int) = pos % 36 == 35
    /** Sign pattern (+1 / -1 per symbol) of a 48-bit sync word in hex: dibit 01 is +3, 11 is -3. */
    fun syncSigns(hex: String): IntArray {
        val out = IntArray(hex.length * 2)
        for ((i, ch) in hex.withIndex()) { val v = ch.digitToInt(16); out[2 * i] = if ((v and 8) != 0) -1 else 1; out[2 * i + 1] = if ((v and 2) != 0) -1 else 1 }
        return out
    }
    /** One trunking signaling frame: sync, NID, the TSBKs, status symbols interleaved. */
    fun p25TsduSymbols(nac: Int, tsbks: List<IntArray>, status: Int = 1): IntArray {
        val info = ArrayList<Int>()
        for (s in syncSigns(P25_SYNC)) info.add(if (s > 0) 1 else 3)
        for (d in nidEncode(nac, 7)) info.add(d)
        for (t in tsbks) for (d in tsbkEncode(t)) info.add(d)
        val out = ArrayList<Int>()
        var k = 0
        while (k < info.size) { if (isStatusPos(out.size)) out.add(status) else out.add(info[k++]) }
        while (out.size % 36 != 0 && !isStatusPos(out.size)) out.add(0)
        if (isStatusPos(out.size)) out.add(status)
        return out.toIntArray()
    }

    // ------------------------------------------------------------------------------------------------ DMR burst
    const val DMR_BS_DATA = "DFF57D75DF5D"
    const val DMR_BS_VOICE = "755FD7DF75F7"
    const val DMR_MS_DATA = "D5D7F77FD757"
    const val DMR_MS_VOICE = "7F7D5DD57DFD"
    /** Golay(20,8): 8 data bits to 20 bits (11 parity bits of the (23,12) code, then the overall parity). */
    fun golay208Encode(data: Int): Int {
        val p = golayParity(data and 0xff, 8); val w = ((data and 0xff) shl 11) or p
        return (w shl 1) or (popcount(w) and 1)
    }
    class Golay(val data: Int, val errs: Int)
    /** Golay(20,8) decode: data byte and corrections, or null. */
    fun golay208Decode(w20: Int): Golay? {
        val c = golay208(w20 ushr 1)
        return if (c < 0) null else Golay(c and 0xff, c shr 8)
    }
    /** BPTC(196,96) encode: 12 bytes to 196 interleaved bits. */
    fun bptcEncode(bytes: IntArray): IntArray {
        val m = IntArray(196)
        fun bit(i: Int) = (bytes[i shr 3] shr (7 - (i and 7))) and 1
        var p = 0
        for (a in 4..11) m[a] = bit(p++)
        for (r in 1 until 9) for (a in r * 15 + 1..r * 15 + 11) m[a] = bit(p++)
        for (r in 0 until 9) {
            val off = r * 15 + 1
            for (q in 0 until 4) { var c = 0; for (i in 0 until 11) if ((H15113[q] and (1 shl i)) != 0) c = c xor m[off + i]; m[off + 11 + q] = c }
        }
        for (c in 0 until 15) {
            val col = IntArray(13)
            for (a in 0 until 9) col[a] = m[c + 1 + a * 15]
            for (q in 0 until 4) { var v = 0; for (i in 0 until 9) if ((H1393[q] and (1 shl i)) != 0) v = v xor col[i]; m[c + 1 + (9 + q) * 15] = v }
        }
        val raw = IntArray(196)
        for (a in 0 until 196) raw[(a * 181) % 196] = m[a]
        return raw
    }
    fun bptcDecode(raw: IntArray): IntArray = com.rocketgod.mayhem.core.ham.bptc(raw.copyOf())
    /** CACH TACT: access type, slot (TC), LCSS, Hamming(7,4) parity; bit positions inside the 24-bit CACH. */
    private val TACT_POS = intArrayOf(0, 4, 8, 12, 14, 18, 22)
    fun tactEncode(at: Int, tc: Int, lcss: Int): IntArray {
        val d = intArrayOf(at and 1, tc and 1, (lcss shr 1) and 1, lcss and 1)
        return intArrayOf(d[0], d[1], d[2], d[3], d[0] xor d[1] xor d[2], d[1] xor d[2] xor d[3], d[0] xor d[1] xor d[3])
    }
    fun cachSlot(cach24: IntArray): Int = cach24[TACT_POS[1]] and 1
    /** A whole 144-symbol base-station data burst (dibits): CACH, payload, slot type, sync, slot type, payload. */
    fun dmrDataBurst(slot: Int, cc: Int, dt: Int, bytes: IntArray, busy: Int = 1): IntArray {
        val cach = IntArray(24); val t = tactEncode(busy, slot, 0)
        TACT_POS.forEachIndexed { i, p -> cach[p] = t[i] }
        val st = golay208Encode((cc shl 4) or dt); val payload = bptcEncode(bytes)
        val bits = IntArray(288)
        cach.copyInto(bits, 0)
        payload.copyInto(bits, 24, 0, 98)
        for (i in 0 until 10) bits[122 + i] = (st ushr (19 - i)) and 1
        val sync = syncSigns(DMR_BS_DATA)
        for (i in 0 until 24) { val v = if (sync[i] > 0) 1 else 3; bits[132 + 2 * i] = v shr 1; bits[133 + 2 * i] = v and 1 }
        for (i in 0 until 10) bits[180 + i] = (st ushr (9 - i)) and 1
        payload.copyInto(bits, 190, 98, 196)
        return IntArray(144) { (bits[2 * it] shl 1) or bits[2 * it + 1] }
    }
    /** [ms]: a mobile station sent it (an MS sync): no CACH, so no slot or busy bit is read from it (slot 0, busy 0). */
    class DmrBurst(var slot: Int, val cc: Int, val dt: Int, val stErrs: Int, val bytes: IntArray, var busy: Int, var ms: Boolean = false)
    /** Reads a 144-dibit base-station data burst: slot from the CACH, slot type through Golay, payload through BPTC. */
    fun dmrReadBurst(d: IntArray): DmrBurst? {
        var st = 0
        for (i in 61..65) st = (st shl 2) or d[i]
        for (i in 90..94) st = (st shl 2) or d[i]
        val g = golay208Decode(st) ?: return null
        val cach = IntArray(24)
        for (i in 0 until 12) { cach[2 * i] = d[i] shr 1; cach[2 * i + 1] = d[i] and 1 }
        val raw = IntArray(196)
        var p = 0
        for (i in 12..60) { raw[p++] = d[i] shr 1; raw[p++] = d[i] and 1 }
        for (i in 95..143) { raw[p++] = d[i] shr 1; raw[p++] = d[i] and 1 }
        return DmrBurst(cachSlot(cach), g.data shr 4, g.data and 15, g.errs, com.rocketgod.mayhem.core.ham.bptc(raw), cach[0])
    }
    /** Hamming(15,11) of one BPTC row, for the layer tests. */
    fun bptcRowCheck(row: IntArray): Int = hamming(row, 0, 11, H15113)

    // ------------------------------------------------------------------------------------------------ helpers
    fun hex(b: IntArray, from: Int = 0, to: Int = b.size): String {
        val sb = StringBuilder()
        for (i in from until to) { val v = b[i] and 255; sb.append(HEX[v shr 4]).append(HEX[v and 15]) }
        return sb.toString()
    }
    private const val HEX = "0123456789abcdef"
    fun fromHex(h: String): IntArray = IntArray(h.length / 2) { h.substring(2 * it, 2 * it + 2).toInt(16) }
}
