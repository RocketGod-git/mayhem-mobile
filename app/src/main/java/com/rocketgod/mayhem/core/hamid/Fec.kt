package com.rocketgod.mayhem.core.hamid

/**
 * Shared coding blocks for the D-STAR and Fusion decoders: a hard-decision Viterbi decoder for the rate 1/2
 * convolutional codes both use (D-STAR K = 3, G1 = 1 + D + D², G2 = 1 + D²; Fusion K = 5, G1 = 1 + D³ + D⁴,
 * G2 = 1 + D + D² + D⁴, outputs G1 then G2), the extended Golay (24,12,8) of the Fusion FICH from the generator
 * matrix in Yaesu's specification (appendix A), the CRCs, and bit packing. The same as the web's dsp/hamid/fec.ts.
 */
object Fec {
    private fun parity(v: Int): Int { var x = v; x = x xor (x ushr 16); x = x xor (x ushr 8); x = x xor (x ushr 4); x = x xor (x ushr 2); x = x xor (x ushr 1); return x and 1 }

    const val DSTAR_K = 3
    val DSTAR_G = intArrayOf(0b111, 0b101)
    const val YSF_K = 5
    val YSF_G = intArrayOf(0b11001, 0b10111)

    fun convEncode(bits: IntArray, k: Int, g: IntArray): IntArray {
        val out = IntArray(bits.size * 2); val m = (1 shl k) - 1; var r = 0
        for (i in bits.indices) { r = ((r shl 1) or (bits[i] and 1)) and m; out[2 * i] = parity(r and g[0]); out[2 * i + 1] = parity(r and g[1]) }
        return out
    }

    class Decoded(val bits: IntArray, val errs: Int)

    /** Hard-decision Viterbi: pairs of coded bits → the input bits, ending in state 0 (tail bits included). */
    fun viterbi(coded: IntArray, k: Int, g: IntArray): Decoded {
        val S = 1 shl (k - 1); val n = coded.size shr 1; val m = (1 shl k) - 1
        var pm = IntArray(S) { 1 shl 20 }; pm[0] = 0
        var nx = IntArray(S)
        val from = IntArray(n * S); val prev = IntArray(n * S)
        val o0 = IntArray(S * 2); val o1 = IntArray(S * 2)
        for (s in 0 until S) for (b in 0..1) { val r = ((s shl 1) or b) and m; o0[s * 2 + b] = parity(r and g[0]); o1[s * 2 + b] = parity(r and g[1]) }
        for (i in 0 until n) {
            nx.fill(1 shl 30)
            val c0 = coded[2 * i] and 1; val c1 = coded[2 * i + 1] and 1
            for (s in 0 until S) {
                val base = pm[s]; if (base >= (1 shl 29)) continue
                for (b in 0..1) {
                    val ns = ((s shl 1) or b) and (S - 1)
                    val d = base + (o0[s * 2 + b] xor c0) + (o1[s * 2 + b] xor c1)
                    if (d < nx[ns]) { nx[ns] = d; from[i * S + ns] = b; prev[i * S + ns] = s }
                }
            }
            val t = pm; pm = nx; nx = t
        }
        val bits = IntArray(n); var s = 0
        for (i in n - 1 downTo 0) { bits[i] = from[i * S + s]; s = prev[i * S + s] }
        return Decoded(bits, pm[0])
    }

    // -------------------------------------------------------------------------------------------- Golay (24,12,8)
    private val G24 = intArrayOf(0xc75, 0x63b, 0xf68, 0x7b4, 0x3da, 0xd99, 0x6cd, 0x367, 0xdc6, 0xa97, 0x93e, 0x8eb)
    fun golay24Parity(d12: Int): Int { var p = 0; for (j in 0 until 12) if ((d12 and (1 shl (11 - j))) != 0) p = p xor G24[j]; return p }
    fun golay24Encode(d12: Int): Int = ((d12 and 0xfff) shl 12) or golay24Parity(d12 and 0xfff)
    private val G24_FIX: IntArray by lazy {
        val t = IntArray(4096) { -1 }
        fun syn(e: Int) = golay24Parity(e ushr 12) xor (e and 0xfff)
        t[0] = 0
        for (a in 0 until 24) {
            t[syn(1 shl a)] = 1 shl a
            for (b in a + 1 until 24) {
                t[syn((1 shl a) or (1 shl b))] = (1 shl a) or (1 shl b)
                for (c in b + 1 until 24) t[syn((1 shl a) or (1 shl b) or (1 shl c))] = (1 shl a) or (1 shl b) or (1 shl c)
            }
        }
        t
    }
    class Golay(val data: Int, val errs: Int)
    fun golay24Decode(w: Int): Golay? {
        val e = G24_FIX[golay24Parity((w ushr 12) and 0xfff) xor (w and 0xfff)]
        if (e < 0) return null
        return Golay(((w xor e) ushr 12) and 0xfff, Integer.bitCount(e))
    }

    // -------------------------------------------------------------------------------------------- CRCs
    /** CRC-16 x^16+x^12+x^5+1 MSB first, register cleared, complemented (Fusion FICH and DCH). */
    fun crc16Msb(bytes: IntArray, n: Int): Int {
        var crc = 0
        for (i in 0 until n) { crc = crc xor ((bytes[i] and 255) shl 8); repeat(8) { crc = if ((crc and 0x8000) != 0) ((crc shl 1) xor 0x1021) and 0xffff else (crc shl 1) and 0xffff } }
        return crc.inv() and 0xffff
    }
    /** CRC-16 with the reflected polynomial 0x8408, register all ones, complemented (D-STAR P_FCS and D-PRS). */
    fun crc16Lsb(bytes: IntArray, n: Int): Int {
        var crc = 0xffff
        for (i in 0 until n) { crc = crc xor (bytes[i] and 255); repeat(8) { crc = if ((crc and 1) != 0) (crc ushr 1) xor 0x8408 else crc ushr 1 } }
        return crc.inv() and 0xffff
    }

    // -------------------------------------------------------------------------------------------- bits
    fun packMsb(bits: IntArray, from: Int, nBytes: Int): IntArray {
        val out = IntArray(nBytes)
        for (i in 0 until nBytes * 8) if ((bits[from + i] and 1) != 0) out[i shr 3] = out[i shr 3] or (0x80 ushr (i and 7))
        return out
    }
    fun packLsb(bits: IntArray, from: Int, nBytes: Int): IntArray {
        val out = IntArray(nBytes)
        for (i in 0 until nBytes * 8) if ((bits[from + i] and 1) != 0) out[i shr 3] = out[i shr 3] or (1 shl (i and 7))
        return out
    }
    /** Printable ASCII of a fixed-width field, trailing spaces dropped. */
    fun asciiField(b: IntArray, from: Int, len: Int): String {
        val sb = StringBuilder()
        for (i in from until from + len) { val c = b[i] and 255; sb.append(if (c in 32..126) c.toChar() else ' ') }
        return sb.toString().trimEnd()
    }
}
