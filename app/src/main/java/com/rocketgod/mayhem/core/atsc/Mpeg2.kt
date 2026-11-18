package com.rocketgod.mayhem.core.atsc

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * MPEG-2 video (ITU-T H.262) intra pictures to small RGBA stills: sequence and picture headers and their extensions,
 * slices, intra macroblocks and blocks (Annex B VLC tables), DC prediction, inverse scan and quantization with
 * mismatch control, and an IDCT reduced to the still's size (each 8x8 block averaged down to s x s pixels).
 * Slices that cross a lost packet are skipped; the still keeps the rows it had before.
 */
private const val B1 = "1 1|011 2|010 3|0011 4|0010 5|00011 6|00010 7|0000111 8|0000110 9|00001011 10|00001010 11|00001001 12|00001000 13|00000111 14|00000110 15|0000010111 16|0000010110 17|0000010101 18|0000010100 19|0000010011 20|0000010010 21|00000100011 22|00000100010 23|00000100001 24|00000100000 25|00000011111 26|00000011110 27|00000011101 28|00000011100 29|00000011011 30|00000011010 31|00000011001 32|00000011000 33|00000001000 34"
private const val B12 = "100 0|00 1|01 2|101 3|110 4|1110 5|11110 6|111110 7|1111110 8|11111110 9|111111110 10|111111111 11"
private const val B13 = "00 0|01 1|10 2|110 3|1110 4|11110 5|111110 6|1111110 7|11111110 8|111111110 9|1111111110 10|1111111111 11"
private const val B14 = "10 EOB|11 0 1|011 1 1|0100 0 2|0101 2 1|00101 0 3|00111 3 1|00110 4 1|000110 1 2|000111 5 1|000101 6 1|000100 7 1|0000110 0 4|0000100 2 2|0000111 8 1|0000101 9 1|000001 ESC|00100110 0 5|00100001 0 6|00100101 1 3|00100100 3 2|00100111 10 1|00100011 11 1|00100010 12 1|00100000 13 1|0000001010 0 7|0000001100 1 4|0000001011 2 3|0000001111 4 2|0000001001 5 2|0000001110 14 1|0000001101 15 1|0000001000 16 1|000000011101 0 8|000000011000 0 9|000000010011 0 10|000000010000 0 11|000000011011 1 5|000000010100 2 4|000000011100 3 3|000000010010 4 3|000000011110 6 2|000000010101 7 2|000000010001 8 2|000000011111 17 1|000000011010 18 1|000000011001 19 1|000000010111 20 1|000000010110 21 1|0000000011010 0 12|0000000011001 0 13|0000000011000 0 14|0000000010111 0 15|0000000010110 1 6|0000000010101 1 7|0000000010100 2 5|0000000010011 3 4|0000000010010 5 3|0000000010001 9 2|0000000010000 10 2|0000000011111 22 1|0000000011110 23 1|0000000011101 24 1|0000000011100 25 1|0000000011011 26 1|00000000011111 0 16|00000000011110 0 17|00000000011101 0 18|00000000011100 0 19|00000000011011 0 20|00000000011010 0 21|00000000011001 0 22|00000000011000 0 23|00000000010111 0 24|00000000010110 0 25|00000000010101 0 26|00000000010100 0 27|00000000010011 0 28|00000000010010 0 29|00000000010001 0 30|00000000010000 0 31|000000000011000 0 32|000000000010111 0 33|000000000010110 0 34|000000000010101 0 35|000000000010100 0 36|000000000010011 0 37|000000000010010 0 38|000000000010001 0 39|000000000010000 0 40|000000000011111 1 8|000000000011110 1 9|000000000011101 1 10|000000000011100 1 11|000000000011011 1 12|000000000011010 1 13|000000000011001 1 14|0000000000010011 1 15|0000000000010010 1 16|0000000000010001 1 17|0000000000010000 1 18|0000000000010100 6 3|0000000000011010 11 2|0000000000011001 12 2|0000000000011000 13 2|0000000000010111 14 2|0000000000010110 15 2|0000000000010101 16 2|0000000000011111 27 1|0000000000011110 28 1|0000000000011101 29 1|0000000000011100 30 1|0000000000011011 31 1"
private const val B15 = "0110 EOB|10 0 1|010 1 1|110 0 2|00101 2 1|0111 0 3|00111 3 1|000110 4 1|00110 1 2|000111 5 1|0000110 6 1|0000100 7 1|11100 0 4|0000111 2 2|0000101 8 1|1111000 9 1|000001 ESC|11101 0 5|000101 0 6|1111001 1 3|00100110 3 2|1111010 10 1|00100001 11 1|00100101 12 1|00100100 13 1|000100 0 7|00100111 1 4|11111100 2 3|11111101 4 2|000000100 5 2|000000101 14 1|000000111 15 1|0000001101 16 1|1111011 0 8|1111100 0 9|00100011 0 10|00100010 0 11|00100000 1 5|0000001100 2 4|000000011100 3 3|000000010010 4 3|000000011110 6 2|000000010101 7 2|000000010001 8 2|000000011111 17 1|000000011010 18 1|000000011001 19 1|000000010111 20 1|000000010110 21 1|11111010 0 12|11111011 0 13|11111110 0 14|11111111 0 15|0000000010110 1 6|0000000010101 1 7|0000000010100 2 5|0000000010011 3 4|0000000010010 5 3|0000000010001 9 2|0000000010000 10 2|0000000011111 22 1|0000000011110 23 1|0000000011101 24 1|0000000011100 25 1|0000000011011 26 1|00000000011111 0 16|00000000011110 0 17|00000000011101 0 18|00000000011100 0 19|00000000011011 0 20|00000000011010 0 21|00000000011001 0 22|00000000011000 0 23|00000000010111 0 24|00000000010110 0 25|00000000010101 0 26|00000000010100 0 27|00000000010011 0 28|00000000010010 0 29|00000000010001 0 30|00000000010000 0 31|000000000011000 0 32|000000000010111 0 33|000000000010110 0 34|000000000010101 0 35|000000000010100 0 36|000000000010011 0 37|000000000010010 0 38|000000000010001 0 39|000000000010000 0 40|000000000011111 1 8|000000000011110 1 9|000000000011101 1 10|000000000011100 1 11|000000000011011 1 12|000000000011010 1 13|000000000011001 1 14|0000000000010011 1 15|0000000000010010 1 16|0000000000010001 1 17|0000000000010000 1 18|0000000000010100 6 3|0000000000011010 11 2|0000000000011001 12 2|0000000000011000 13 2|0000000000010111 14 2|0000000000010110 15 2|0000000000010101 16 2|0000000000011111 27 1|0000000000011110 28 1|0000000000011101 29 1|0000000000011100 30 1|0000000000011011 31 1"
/** The VLC tables as text (code, then run and level, or EOB / ESC), for the tests' own encoder. */
val VLC: Map<String, String> = mapOf("B1" to B1, "B12" to B12, "B13" to B13, "B14" to B14, "B15" to B15)

/** Zigzag and alternate scans, Fig 7-2 / 7-3: scan[v][u] = n. */
val SCAN0 = intArrayOf(0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53, 10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63)
val SCAN1 = intArrayOf(0, 4, 6, 20, 22, 36, 38, 52, 1, 5, 7, 21, 23, 37, 39, 53, 2, 8, 19, 24, 34, 40, 50, 54, 3, 9, 18, 25, 35, 41, 51, 55, 10, 17, 26, 30, 42, 46, 56, 60, 11, 16, 27, 31, 43, 47, 57, 61, 12, 15, 28, 32, 44, 48, 58, 62, 13, 14, 29, 33, 45, 49, 59, 63)
/** Default intra matrix (6.3.11), raster order. */
val W_INTRA = intArrayOf(8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38, 22, 22, 26, 27, 29, 34, 37, 40, 22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58, 26, 27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83)
val QSCALE = arrayOf(
    intArrayOf(0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62),
    intArrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 96, 104, 112),
)
/** Raster position of coefficient n in each scan. */
private val INV = arrayOf(SCAN0, SCAN1).map { sc -> IntArray(64).also { o -> for (i in 0 until 64) o[sc[i]] = i } }

// LUT entries: length | value << 5 (B1, B12, B13); coefficient tables: length | run << 5 | level << 11 | kind << 18 (1 EOB, 2 ESC)
private fun lut(spec: String, bits: Int, coef: Boolean): IntArray {
    val t = IntArray(1 shl bits)
    for (ent in spec.split('|')) {
        val parts = ent.trim().split(' '); val code = parts[0]; val a = parts[1]; val b = parts.getOrNull(2)
        val l = code.length; val base = code.toInt(2) shl (bits - l)
        val v = when {
            !coef -> l or (a.toInt() shl 5)
            a == "EOB" -> l or (1 shl 18)
            a == "ESC" -> l or (2 shl 18)
            else -> (l + 1) or (a.toInt() shl 5) or (b!!.toInt() shl 11)
        }
        for (k in 0 until (1 shl (bits - l))) t[base + k] = v
    }
    return t
}
private class Luts(val b1: IntArray, val b12: IntArray, val b13: IntArray, val b14: IntArray, val b15: IntArray)
private val LUTS by lazy { Luts(lut(B1, 11, false), lut(B12, 9, false), lut(B13, 10, false), lut(B14, 17, true), lut(B15, 17, true)) }

private class Bits(private val d: ByteArray, from: Int, to: Int) {
    var p = from * 8; val n = to * 8
    private fun at(i: Int) = if (i in d.indices) d[i].toInt() and 0xff else 0
    fun peek(k: Int): Int {
        val i = p shr 3
        val v = (at(i).toLong() shl 24) or (at(i + 1).toLong() shl 16) or (at(i + 2).toLong() shl 8) or at(i + 3).toLong()
        val s = p and 7
        val w = if (s != 0) ((v shl s) or (at(i + 4).toLong() ushr (8 - s))) and 0xffffffffL else v
        return (w ushr (32 - k)).toInt()
    }
    fun get(k: Int): Int { val v = peek(k); p += k; return v }
}

class SeqInfo(val width: Int, val height: Int, val aspect: Int, val frameRate: Double, val bitRate: Long, val progressive: Boolean, val chroma: Int, val profileLevel: Int, val intraMatrix: Boolean)
class PicInfo(
    var type: Int, var temporalRef: Int, var structure: Int = 3, var topFirst: Boolean = true, var framePredDct: Boolean = true, var concealment: Boolean = false,
    var qScaleType: Int = 0, var intraVlc: Int = 0, var altScan: Int = 0, var dcPrecision: Int = 0, var progressiveFrame: Boolean = true,
)
class Still(
    val width: Int, val height: Int, val rgba: ByteArray, val dar: Double, val seq: SeqInfo, val pic: PicInfo, val mbs: Int, val mbsTotal: Int, val slices: Int, val badSlices: Int, val complete: Boolean,
    /** Macroblocks that hold picture (from this one or an earlier one on the same stream), mbw across, mbPx pixels each way
     *  (twice as tall for a field); the others were never decoded and are mid gray. */
    val have: ByteArray, val mbw: Int, val mbPx: Int, val filled: Boolean,
)

private val FRAME_RATES = doubleArrayOf(0.0, 24000.0 / 1001, 24.0, 25.0, 30000.0 / 1001, 30.0, 50.0, 60000.0 / 1001, 60.0)
private val DARS = doubleArrayOf(0.0, 1.0, 4.0 / 3, 16.0 / 9, 2.21)

/** Average-down IDCT matrices: R[s][i*8+u] gives pixel row i of an s x s block from coefficient row u. */
private val RED = java.util.concurrent.ConcurrentHashMap<Int, FloatArray>()
private fun reduce(s: Int): FloatArray = RED.getOrPut(s) {
    val m = FloatArray(s * 8); val box = 8 / s
    for (i in 0 until s) for (u in 0 until 8) {
        var a = 0.0
        for (x in i * box until (i + 1) * box) a += (if (u == 0) sqrt(0.5) else 1.0) * cos((2 * x + 1) * u * PI / 16) / 2
        m[i * 8 + u] = (a / box).toFloat()
    }
    m
}

private class SeqRaw(val h: Int, val v: Int, val aspect: Int, val rate: Int, val br: Int, val matrix: IntArray)
private class SeqExt(val progressive: Boolean, val chroma: Int, val hx: Int, val vx: Int, val brx: Int, val pl: Int, val fn: Int, val fd: Int)
private class BadSlice : Exception()

/** Decodes MPEG-2 video elementary-stream units (a PES payload each) and makes stills of the intra pictures. */
class StillDecoder(private val maxWidth: Int = 480) {
    var seq: SeqInfo? = null; private set
    private var seqRaw: SeqRaw? = null
    private var ext: SeqExt? = null
    /** Reduced planes of the last still (kept for compositing a damaged picture over it). */
    private var y: ByteArray? = null; private var cb: ByteArray? = null; private var cr: ByteArray? = null
    private var key = ""; private var have: ByteArray? = null
    var pictures = 0; private set
    var iPictures = 0; private set
    var gop = ""; private set

    /** One PES payload; [holes] are byte offsets where packets were lost. Returns a still when an I picture decodes. */
    fun unit(es: ByteArray, holes: List<Int> = emptyList(), wantStill: Boolean = true): Still? {
        val codes = ArrayList<IntArray>()
        var i = 0
        while (i + 3 < es.size) {
            if (es[i].toInt() == 0 && es[i + 1].toInt() == 0 && es[i + 2].toInt() == 1) { codes.add(intArrayOf(i, es[i + 3].toInt() and 0xff)); i += 3 }
            i++
        }
        var pic: PicInfo? = null; var matrix: IntArray? = null
        val slices = ArrayList<IntArray>()
        var out: Still? = null
        fun flush() {
            val p = pic; val sr = seqRaw
            if (p != null && p.type == 1 && slices.isNotEmpty() && wantStill && seq != null && sr != null && ext != null) out = decode(es, slices, p, matrix ?: sr.matrix, holes) ?: out
            slices.clear()
        }
        for (k in codes.indices) {
            val off = codes[k][0]; val code = codes[k][1]; val end = if (k + 1 < codes.size) codes[k + 1][0] else es.size
            val b = Bits(es, off + 4, end)
            if (code == 0xb3) {
                flush(); pic = null
                val h = b.get(12); val v = b.get(12); val aspect = b.get(4); val rate = b.get(4); val br = b.get(18); b.get(1); b.get(10); b.get(1)
                val mat = W_INTRA.copyOf()
                if (b.get(1) != 0) for (q in 0 until 64) mat[INV[0][q]] = b.get(8)
                seqRaw = SeqRaw(h, v, aspect, rate, br, mat)
                refreshSeq()
            } else if (code == 0xb5) {
                val id = b.get(4)
                val p = pic
                if (id == 1) {
                    val pl = b.get(8); val progressive = b.get(1) == 1; val chroma = b.get(2); val hx = b.get(2); val vx = b.get(2); val brx = b.get(12); b.get(1); b.get(8); b.get(1)
                    val fn = b.get(2); val fd = b.get(5)
                    ext = SeqExt(progressive, chroma, hx, vx, brx, pl, fn, fd)
                    refreshSeq()
                } else if (id == 8 && p != null) {
                    b.get(16)
                    p.dcPrecision = b.get(2); p.structure = b.get(2); p.topFirst = b.get(1) == 1; p.framePredDct = b.get(1) == 1; p.concealment = b.get(1) == 1
                    p.qScaleType = b.get(1); p.intraVlc = b.get(1); p.altScan = b.get(1); b.get(1); b.get(1); p.progressiveFrame = b.get(1) == 1
                } else if (id == 3 && p != null) {
                    if (b.get(1) != 0) { val m = IntArray(64); for (q in 0 until 64) m[INV[0][q]] = b.get(8); matrix = m }
                }
            } else if (code == 0x00) {
                flush()
                val tr = b.get(10); val type = b.get(3)
                pic = PicInfo(type, tr)
                matrix = null
                pictures++; if (type == 1) iPictures++
                gop = (gop + " IPB?"[minOf(4, type)]).takeLast(30)
            } else if (code in 0x01..0xaf && pic != null) slices.add(intArrayOf(off, code, end))
        }
        flush()
        return out
    }

    private fun refreshSeq() {
        val s = seqRaw ?: return; val x = ext
        val w = s.h or ((x?.hx ?: 0) shl 12); val h = s.v or ((x?.vx ?: 0) shl 12)
        seq = SeqInfo(w, h, s.aspect, (FRAME_RATES.getOrNull(s.rate) ?: 0.0) * ((x?.fn ?: 0) + 1) / ((x?.fd ?: 0) + 1), (s.br.toLong() or ((x?.brx ?: 0).toLong() shl 18)) * 400,
            x?.progressive ?: true, x?.chroma ?: 1, x?.pl ?: 0, s.matrix.indices.any { s.matrix[it] != W_INTRA[it] })
    }

    private fun decode(es: ByteArray, slices: List<IntArray>, pic: PicInfo, w: IntArray, holes: List<Int>): Still? {
        val seq = seq!!; val x = ext!!
        if (x.chroma != 1 || pic.concealment) return null
        val mbw = (seq.width + 15) shr 4
        val mbh = if (x.progressive) (seq.height + 15) shr 4 else 2 * ((seq.height + 31) shr 5)
        val field = pic.structure != 3; val mbhPic = if (field) mbh shr 1 else mbh
        var s = 8; while (s > 1 && mbw * 2 * s > maxWidth) s = s shr 1
        val yw = mbw * 2 * s; val yh = mbhPic * 2 * s; val cw = mbw * s; val ch = mbhPic * s
        val k = "${seq.width}x${seq.height}/${pic.structure}/$s"
        if (k != key || y == null) {
            key = k; have = ByteArray(mbw * mbhPic)
            y = ByteArray(yw * yh).also { it.fill(126) }; cb = ByteArray(cw * ch).also { it.fill(128.toByte()) }; cr = ByteArray(cw * ch).also { it.fill(128.toByte()) }
        }
        val yy = y!!; val cbp = cb!!; val crp = cr!!; val hv = have!!
        val l = LUTS; val lutc = if (pic.intraVlc != 0) l.b15 else l.b14; val inv = INV[pic.altScan]; val qs = QSCALE[pic.qScaleType]
        val dcMult = intArrayOf(8, 4, 2, 1)[pic.dcPrecision]; val dcReset = intArrayOf(128, 256, 512, 1024)[pic.dcPrecision]
        val r = reduce(s); val r8 = reduce(8)
        val ff = IntArray(64); val tmp = FloatArray(64); val blk = FloatArray(6 * 64); val full = FloatArray(256)
        var mbs = 0; var bad = 0
        val nmb = mbw * mbhPic
        for (sl in slices) {
            val off = sl[0]; val code = sl[1]; val end = sl[2]
            if (holes.any { it > off && it <= end }) { bad++; continue }
            val b = Bits(es, off + 4, end)
            val pred = intArrayOf(dcReset, dcReset, dcReset)
            var done = 0
            try {
                var qsc = b.get(5)
                if (b.peek(1) != 0) { b.get(9); while (b.get(1) != 0) b.get(8) } else b.get(1)
                var addr = (code - 1) * mbw - 1; var first = true
                while (true) {
                    if (b.p + 23 >= b.n || b.peek(23) == 0) break
                    var inc = 0
                    while (true) { val v = l.b1[b.peek(11)]; if (v == 0) throw BadSlice(); b.p += v and 31; val vl = v shr 5; if (vl == 34) { inc += 33; continue }; inc += vl; break }
                    if (inc > 1 && !first) { pred[0] = dcReset; pred[1] = dcReset; pred[2] = dcReset }
                    addr += inc; first = false
                    var quant = false
                    if (b.get(1) == 0) { if (b.get(1) != 1) throw BadSlice(); quant = true }
                    val dct = if (!field && !pic.framePredDct) b.get(1) else 0
                    if (quant) qsc = b.get(5)
                    val qscale = qs[qsc]
                    if (addr >= nmb || addr < 0) throw BadSlice()
                    for (bk in 0 until 6) {
                        val cc = if (bk < 4) 0 else if (bk == 4) 1 else 2
                        ff.fill(0)
                        val dv = if (cc == 0) l.b12[b.peek(9)] else l.b13[b.peek(10)]
                        if (dv == 0) throw BadSlice()
                        b.p += dv and 31
                        val size = dv shr 5
                        var diff = 0
                        if (size != 0) { val d = b.get(size); val half = 1 shl (size - 1); diff = if (d >= half) d else d + 1 - 2 * half }
                        pred[cc] += diff
                        var n = 1; var sum = 0
                        val dc = dcMult * pred[cc]; ff[0] = dc; sum += dc
                        while (true) {
                            val v = lutc[b.peek(17)]
                            if (v == 0) throw BadSlice()
                            val kind = v shr 18
                            if (kind == 1) { b.p += v and 31; break }
                            val run: Int; var level: Int
                            if (kind == 2) {
                                b.p += v and 31; run = b.get(6); level = b.get(12)
                                if (level >= 2048) level -= 4096
                                if (level == 0 || level == -2048) throw BadSlice()
                            } else {
                                val len = v and 31; val sign = b.peek(len) and 1 == 1
                                b.p += len; run = (v shr 5) and 63; level = (v shr 11) and 127; if (sign) level = -level
                            }
                            n += run
                            if (n > 63) throw BadSlice()
                            val pos = inv[n]; val wq = w[pos]
                            var vv = (2 * abs(level) * wq * qscale) shr 5
                            if (level < 0) vv = -vv
                            if (vv > 2047) vv = 2047 else if (vv < -2048) vv = -2048
                            ff[pos] = vv; sum += vv
                            n++
                        }
                        if (sum and 1 == 0) ff[63] += if (ff[63] and 1 != 0) -1 else 1
                        val o = bk * 64
                        if (cc == 0 && dct != 0) idct(ff, r8, 8, tmp, blk, o) else idct(ff, r, s, tmp, blk, o)
                    }
                    // place the macroblock
                    val mr = addr / mbw; val mc = addr - mr * mbw
                    if (dct != 0) {
                        for (bk in 0 until 4) { val bx = (bk and 1) * 8; val top = if (bk < 2) 0 else 1; for (rr in 0 until 8) for (c in 0 until 8) full[(2 * rr + top) * 16 + bx + c] = blk[bk * 64 + rr * 8 + c] }
                        val box = 16 / (2 * s)
                        for (rr in 0 until 2 * s) for (c in 0 until 2 * s) {
                            var a = 0f; for (i in 0 until box) for (j in 0 until box) a += full[(rr * box + i) * 16 + c * box + j]
                            yy[(mr * 2 * s + rr) * yw + mc * 2 * s + c] = clip(a / (box * box))
                        }
                    } else {
                        for (bk in 0 until 4) {
                            val ox = mc * 2 * s + (bk and 1) * s; val oy = mr * 2 * s + (bk shr 1) * s
                            for (rr in 0 until s) for (c in 0 until s) yy[(oy + rr) * yw + ox + c] = clip(blk[bk * 64 + rr * s + c])
                        }
                    }
                    for (rr in 0 until s) for (c in 0 until s) {
                        cbp[(mr * s + rr) * cw + mc * s + c] = clip(blk[4 * 64 + rr * s + c])
                        crp[(mr * s + rr) * cw + mc * s + c] = clip(blk[5 * 64 + rr * s + c])
                    }
                    done++; hv[addr] = 1
                }
                mbs += done
            } catch (_: Exception) {
                bad++
                mbs += done
            }
        }
        if (mbs == 0) return null
        // to RGB (BT.709), cropped to the picture, a field doubled in height
        val pw = minOf(yw, (seq.width * 2.0 * s / 16).roundToInt()); val ph = minOf(yh, ((if (field) seq.height / 2.0 else seq.height.toDouble()) * 2 * s / 16).roundToInt())
        val oh = if (field) 2 * ph else ph; val rgba = ByteArray(pw * oh * 4)
        for (rr in 0 until oh) {
            val yr = if (field) rr shr 1 else rr
            for (c in 0 until pw) {
                val lum = ((yy[yr * yw + c].toInt() and 0xff) - 16) * 255.0 / 219; val ci = (yr shr 1) * cw + (c shr 1)
                val u = ((cbp[ci].toInt() and 0xff) - 128) * 255.0 / 224; val v = ((crp[ci].toInt() and 0xff) - 128) * 255.0 / 224; val o = (rr * pw + c) * 4
                rgba[o] = clamp8(lum + 1.5748 * v); rgba[o + 1] = clamp8(lum - 0.1873 * u - 0.4681 * v); rgba[o + 2] = clamp8(lum + 1.8556 * u); rgba[o + 3] = -1
            }
        }
        val sr = seqRaw!!
        val dar = if (DARS.getOrNull(sr.aspect).let { it == null || it == 0.0 || it == 1.0 }) seq.width.toDouble() / seq.height else DARS[sr.aspect]
        val hc = hv.copyOf()
        return Still(pw, oh, rgba, dar, seq, pic, mbs, nmb, slices.size, bad, mbs == nmb && bad == 0, hc, mbw, 2 * s, hc.all { it.toInt() == 1 })
    }
}

private fun clip(v: Float): Byte = (if (v < 0) 0 else if (v > 255) 255 else Math.round(v)).toByte()
/** As a clamped byte store does: rounded half to even. */
private fun clamp8(v: Double): Byte = (if (v <= 0) 0 else if (v >= 255) 255 else Math.rint(v).toInt()).toByte()

/** 2-D inverse DCT of raster coefficients F averaged down to s x s (s = 8 is the full Annex A IDCT). */
private fun idct(f: IntArray, r: FloatArray, s: Int, tmp: FloatArray, out: FloatArray, o: Int) {
    // rows of the output: tmp[i][u] = sum_v R[i][v] F[v][u]
    for (i in 0 until s) for (u in 0 until 8) { var a = 0f; for (v in 0 until 8) a += r[i * 8 + v] * f[v * 8 + u]; tmp[i * 8 + u] = a }
    for (i in 0 until s) for (j in 0 until s) { var a = 0f; for (u in 0 until 8) a += tmp[i * 8 + u] * r[j * 8 + u]; out[o + i * s + j] = a }
}
