package com.rocketgod.mayhem.core.fleet

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * DMR full link control (ETSI TS 102 361-1 and -2): the 72-bit LC carried in the voice LC header and terminator
 * bursts, its Reed-Solomon (12,9) check over GF(256) with the per-burst masks, and the voice burst payload split into
 * its three 72-bit vocoder frames.
 */
private val LC_EXP = IntArray(512)
private val LC_LOG = IntArray(256)
private val lcGfInit = run {
    var x = 1
    for (i in 0 until 255) { LC_EXP[i] = x; LC_LOG[x] = i; x = x shl 1; if ((x and 0x100) != 0) x = x xor 0x11d }
    for (i in 255 until 512) LC_EXP[i] = LC_EXP[i - 255]
    true
}
private fun lcMul(a: Int, b: Int): Int { check(lcGfInit); return if (a != 0 && b != 0) LC_EXP[LC_LOG[a] + LC_LOG[b]] else 0 }
/** g(x) = (x + α)(x + α²)(x + α³), highest power first. */
private val LC_GEN: IntArray = run {
    check(lcGfInit)
    var g = intArrayOf(1)
    for (r in 1..3) { val n = IntArray(g.size + 1); for (i in g.indices) { n[i] = n[i] xor g[i]; n[i + 1] = n[i + 1] xor lcMul(g[i], LC_EXP[r]) }; g = n }
    g
}

/** RS(12,9) parity of nine data bytes (the first byte is the highest power). */
fun rs129Parity(d: IntArray): IntArray {
    val r = IntArray(3)
    for (i in 0 until 9) {
        val fb = (d[i] and 255) xor r[0]
        r[0] = r[1] xor lcMul(fb, LC_GEN[1]); r[1] = r[2] xor lcMul(fb, LC_GEN[2]); r[2] = lcMul(fb, LC_GEN[3])
    }
    return r
}
/** CRC masks of the RS parity by data type: voice LC header, terminator with LC. */
val RS_MASK: Map<Int, Int> = mapOf(1 to 0x969696, 2 to 0x999999)
fun rs129Ok(b: IntArray, dt: Int): Boolean {
    val m = RS_MASK[dt] ?: return false
    val p = rs129Parity(b)
    return (b[9] xor (m shr 16)) == p[0] && (b[10] xor ((m shr 8) and 255)) == p[1] && (b[11] xor (m and 255)) == p[2]
}

data class DmrLc(val flco: Int, val fid: Int, val group: Boolean, val dst: Int, val src: Int, val emergency: Boolean, val privacy: Boolean, val priority: Int, val ok: Boolean)
/** Full LC from the 12 bytes of a voice LC header (dt 1) or terminator (dt 2). FLCO 0 is a group call, 3 unit to unit. */
fun parseLc(b: IntArray, dt: Int): DmrLc? {
    val flco = b[0] and 0x3f
    // FLCO 0 group, 3 unit; under Motorola's feature set (FID 0x10) Capacity Plus sends its group voice LC as FLCO 0x20
    if (flco != 0 && flco != 3 && !(b[1] == 0x10 && flco == 0x20)) return null
    val so = b[2]
    return DmrLc(flco, b[1], flco != 3, (b[3] shl 16) or (b[4] shl 8) or b[5], (b[6] shl 16) or (b[7] shl 8) or b[8],
        (so and 0x80) != 0, (so and 0x40) != 0, so and 3, rs129Ok(b, dt))
}
/** The 12 bytes of a voice LC burst (for the synthetic signals in the tests). */
fun lcBytes(group: Boolean, dst: Int, src: Int, dt: Int, emergency: Boolean = false, privacy: Boolean = false, fid: Int = 0): IntArray {
    val b = IntArray(12)
    b[0] = if (group) 0 else 3; b[1] = fid; b[2] = (if (emergency) 0x80 else 0) or (if (privacy) 0x40 else 0)
    b[3] = (dst shr 16) and 255; b[4] = (dst shr 8) and 255; b[5] = dst and 255; b[6] = (src shr 16) and 255; b[7] = (src shr 8) and 255; b[8] = src and 255
    val p = rs129Parity(b); val m = RS_MASK.getValue(dt)
    b[9] = p[0] xor (m shr 16); b[10] = p[1] xor ((m shr 8) and 255); b[11] = p[2] xor (m and 255)
    return b
}

/**
 * The three 72-bit vocoder frames of a 144-dibit voice burst: the 216 payload bits are the 108 before and the 108
 * after the 48-bit center field, in order, cut 72 / 72 / 72. The bits inside each frame stay as sent.
 */
fun voiceFrames(d: IntArray): List<IntArray> {
    val bits = IntArray(216)
    var p = 0
    for (i in 12 until 66) { bits[p++] = d[i] shr 1; bits[p++] = d[i] and 1 }
    for (i in 90 until 144) { bits[p++] = d[i] shr 1; bits[p++] = d[i] and 1 }
    return listOf(bits.copyOfRange(0, 72), bits.copyOfRange(72, 144), bits.copyOfRange(144, 216))
}

/**
 * The two generators a (16,7) code shortened from the length-17 quadratic residue code can have: (x + 1) times one of
 * the two degree-8 factors of x^17 + 1 over GF(2). The EMB is accepted as a code word of either.
 */
val QR167_GENS = intArrayOf(0x34b, 0x279)
/** The nine check bits of seven EMB data bits under generator [g] (systematic, data first). */
fun qr167Parity(data7: Int, g: Int): Int {
    var r = (data7 and 0x7f) shl 9
    for (b in 15 downTo 9) if ((r and (1 shl b)) != 0) r = r xor (g shl (b - 9))
    return r and 0x1ff
}
data class Emb(val cc: Int, val pi: Boolean, val lcss: Int, val ok: Boolean)
/**
 * The EMB of a voice burst B to F (ETSI TS 102 361-1): 8 bits before and 8 after the 32-bit embedded signaling in
 * the burst's 48-bit center: color code (4), privacy indicator (1), LC start/stop (2), then 9 check bits.
 */
fun readEmb(d: IntArray): Emb {
    var w = 0
    for (i in 66 until 70) w = (w shl 2) or (d[i] and 3)
    for (i in 86 until 90) w = (w shl 2) or (d[i] and 3)
    val data = w shr 9; val par = w and 0x1ff
    return Emb(data shr 3, ((data shr 2) and 1) == 1, data and 3, QR167_GENS.any { qr167Parity(data, it) == par } || embParity(data) == par)
}
/**
 * The EMB check bits as our recordings carry them: the (x + 1)(x^8 + x^5 + x^4 + x^3 + 1) code's, with 0x138 added
 * when the LC start/stop field is 1 or 2 (first or last fragment). Derived from the Capacity Plus capture of
 * 2026-11-19, where every first and last fragment carries exactly that difference and the others none.
 */
fun embParity(data7: Int): Int = qr167Parity(data7, QR167_GENS[0]) xor (if ((data7 and 3) == 1 || (data7 and 3) == 2) 0x138 else 0)
/** The 32 embedded signaling bits of a voice burst B to E (the center field between the two EMB halves). */
fun embBits(d: IntArray): IntArray { val b = IntArray(32); var k = 0; for (i in 70 until 86) { b[k++] = (d[i] shr 1) and 1; b[k++] = d[i] and 1 }; return b }

/**
 * Embedded LC (ETSI TS 102 361-1 Annex B, variable-length BPTC): an LC sent in four 32-bit fragments over voice bursts
 * B to E (LC start/stop 1, 3, 3, 2). The 128 bits are a 16 by 8 matrix sent column by column; rows 0 to 6 carry the
 * data (11 bits in rows 0 and 1, 10 bits and one checksum bit in rows 2 to 6) and their Hamming check bits, and row 7
 * makes every column even. The 72 LC bits come out with a 5-bit checksum: the octet sum, plus 8 as our recordings
 * carry it, modulo 31.
 */
class EmbLcAssembler {
    private var frags = ArrayList<IntArray>()
    /** One fragment; the 9 LC octets when a whole LC has come in and checked. */
    fun push(lcss: Int, bits: IntArray): IntArray? {
        when (lcss) {
            1 -> frags = arrayListOf(bits)
            3 -> if (frags.size in 1..2) frags.add(bits) else frags = ArrayList()
            2 -> {
                if (frags.size != 3) { frags = ArrayList(); return null }
                val all = IntArray(128); var k = 0
                for (f in frags) for (v in f) all[k++] = v
                for (v in bits) all[k++] = v
                frags = ArrayList()
                return embLcDecode(all)
            }
            else -> frags = ArrayList()
        }
        return null
    }
    fun reset() { frags = ArrayList() }
}
fun embLcDecode(all: IntArray): IntArray? {
    if (all.size < 128) return null
    val m = Array(8) { IntArray(16) }
    var i = 0; for (c in 0 until 16) for (r in 0 until 8) m[r][c] = all[i++]
    for (c in 0 until 16) { var p = 0; for (r in 0 until 8) p = p xor m[r][c]; if (p != 0) return null }
    val bits = ArrayList<Int>(72); var cs = 0
    for (r in 0 until 7) { val n = if (r < 2) 11 else 10; for (c in 0 until n) bits.add(m[r][c]); if (r >= 2) cs = cs * 2 + m[r][10] }
    val out = IntArray(9)
    for (k in 0 until 9) { var v = 0; for (j in 0 until 8) v = v * 2 + bits[8 * k + j]; out[k] = v }
    val sum = out.sum()
    return if ((sum + 8) % 31 == cs || sum % 31 == cs) out else null
}
/**
 * What an embedded LC says. A group (FLCO 0) or unit (3) voice LC as in the header, and under Motorola's feature set
 * (FID 0x10) FLCO 0x20, the group voice LC Capacity Plus sends, laid out the same: service options (bit 6 privacy,
 * bit 7 emergency), destination and source. Talker alias header and blocks: FLCO 4 to 7, or 0x14 to 0x17 under FID 0x10.
 */
sealed class EmbLc {
    data class Voice(val lc: DmrLc) : EmbLc()
    class Alias(val part: Int, val bytes: IntArray) : EmbLc()
}
fun parseEmbLc(b: IntArray): EmbLc? {
    val flco = b[0] and 0x3f; val fid = b[1]; val so = b[2]
    fun voice(group: Boolean) = EmbLc.Voice(DmrLc(flco, fid, group, (b[3] shl 16) or (b[4] shl 8) or b[5], (b[6] shl 16) or (b[7] shl 8) or b[8],
        (so and 0x80) != 0, (so and 0x40) != 0, so and 3, true))
    if (flco == 0 || (fid == 0x10 && flco == 0x20)) return voice(true)
    if (flco == 3) return voice(false)
    if ((fid == 0 && flco in 4..7) || (fid == 0x10 && flco in 0x14..0x17)) return EmbLc.Alias(flco and 3, b.copyOfRange(2, b.size))
    return null
}
/**
 * Talker alias (ETSI TS 102 361-2, the alias header and up to three blocks): the header's first octet is the format
 * (2 bits: 7-bit, ISO 8-bit, UTF-8, UTF-16) and the length in characters (5 bits), then one bit and six octets of
 * text; each block carries seven octets. The name is complete once its length has come in.
 */
class TalkerAlias {
    private var fmt = -1; private var len = 0; private var data = arrayOfNulls<IntArray>(4)
    /** A part (0 header, 1 to 3 blocks): the name so far, or "" while it is not known. */
    fun push(part: Int, bytes: IntArray): String {
        if (part == 0) { fmt = bytes[0] shr 6; len = (bytes[0] shr 1) and 31; data = arrayOf(bytes, null, null, null) }
        else if (part in 1..3) data[part] = bytes
        return text()
    }
    fun text(): String {
        if (data[0] == null || fmt < 0) return ""
        val bits = ArrayList<Int>()
        for (k in 0 until 4) { val d = data[k] ?: break; for (v in d) for (j in 7 downTo 0) bits.add((v shr j) and 1) }
        // the header's first octet holds the format and length and the first data bit
        val s = bits.subList(7, bits.size)
        val out = StringBuilder()
        if (fmt == 0) {
            var i = 0
            while (i + 7 <= s.size && out.length < len) { var v = 0; for (j in 0 until 7) v = v * 2 + s[i + j]; out.append(v.toChar()); i += 7 }
        } else {
            // 8-bit and 16-bit text starts on the octet after the header's first: its last bit is padding
            val by = ArrayList<Int>(); var i = 1
            while (i + 8 <= s.size) { var v = 0; for (j in 0 until 8) v = v * 2 + s[i + j]; by.add(v); i += 8 }
            when (fmt) {
                3 -> { var k = 0; while (k + 1 < by.size && out.length < len) { out.append(((by[k] shl 8) or by[k + 1]).toChar()); k += 2 } }
                2 -> out.append(String(ByteArray(by.size) { by[it].toByte() }, Charsets.UTF_8).take(len))
                else -> { var k = 0; while (k < by.size && out.length < len) { out.append(by[k].toChar()); k++ } }
            }
        }
        val t = out.toString().filter { it.code >= 0x20 && it.code != 0x7f }.trim()
        return if (t.length >= min(len, 1) && (t.length >= len || complete())) t else ""
    }
    private fun complete(): Boolean {
        val per = if (fmt == 0) 7 else if (fmt == 3) 16 else 8
        val need = ceil((len * per - 48) / 56.0).toInt()
        for (k in 1..max(0, need)) if (k > 3 || data[k] == null) return false
        return true
    }
    fun reset() { fmt = -1; len = 0; data = arrayOfNulls(4) }
}
/** A voice burst's center field carrying an EMB (for the synthetic signals in the tests). */
fun embDibits(cc: Int, pi: Boolean, lcss: Int, g: Int = QR167_GENS[0]): IntArray {
    val data = ((cc and 15) shl 3) or (if (pi) 4 else 0) or (lcss and 3); val w = (data shl 9) or qr167Parity(data, g)
    return IntArray(8) { (w shr (2 * (7 - it))) and 3 }
}
