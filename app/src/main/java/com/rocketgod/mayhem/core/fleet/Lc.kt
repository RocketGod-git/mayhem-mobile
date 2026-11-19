package com.rocketgod.mayhem.core.fleet

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
    if (flco != 0 && flco != 3) return null
    val so = b[2]
    return DmrLc(flco, b[1], flco == 0, (b[3] shl 16) or (b[4] shl 8) or b[5], (b[6] shl 16) or (b[7] shl 8) or b[8],
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
    return Emb(data shr 3, ((data shr 2) and 1) == 1, data and 3, QR167_GENS.any { qr167Parity(data, it) == par })
}
/** A voice burst's center field carrying an EMB (for the synthetic signals in the tests). */
fun embDibits(cc: Int, pi: Boolean, lcss: Int, g: Int = QR167_GENS[0]): IntArray {
    val data = ((cc and 15) shl 3) or (if (pi) 4 else 0) or (lcss and 3); val w = (data shl 9) or qr167Parity(data, g)
    return IntArray(8) { (w shr (2 * (7 - it))) and 3 }
}
