package com.rocketgod.mayhem.core.atsc

/**
 * 8VSB channel coding, ATSC A/53 Part 2 Sec 5.2: randomizer, RS(207,187), the 52-segment byte interleaver and the
 * 12-way trellis coder, each with its inverse.
 * Resolved against recordings: bytes go to the trellis coders just in time (a coder fetches the next interleaver
 * byte when it starts a byte), the randomizer starts from its preload for the first data byte of a field and shifts
 * once per data byte, the first byte sent is the highest-degree RS coefficient.
 */
const val SEG = 832
const val FIELD_SEGS = 313
const val DATA_SEGS = 312
const val DATA_SYMS = 828
const val FIELD_SYMS = SEG * FIELD_SEGS
const val FIELD_DATA_SYMS = DATA_SEGS * DATA_SYMS
const val FIELD_BYTES = DATA_SEGS * 207
const val RS_N = 207
const val RS_K = 187
const val RS_T = 10

// ---- randomizer (Fig 5.3) ----
/** The 312 x 187 randomizer bytes of one field, in order. */
val PRBS: ByteArray by lazy {
    val r = IntArray(17)
    for (k in intArrayOf(16, 15, 14, 13, 9, 8)) r[k] = 1
    val out = ByteArray(DATA_SEGS * RS_K)
    for (i in out.indices) {
        out[i] = ((r[14] shl 7) or (r[13] shl 6) or (r[12] shl 5) or (r[11] shl 4) or (r[7] shl 3) or (r[4] shl 2) or (r[3] shl 1) or r[1]).toByte()
        val o = r[16]
        for (k in 16 downTo 2) r[k] = r[k - 1]
        r[1] = o
        if (o != 0) for (k in intArrayOf(2, 4, 7, 8, 12, 13, 14)) r[k] = r[k] xor 1
    }
    out
}

// ---- GF(256), p(x) = x^8+x^4+x^3+x^2+1 ----
val GF_EXP = IntArray(512)
val GF_LOG = IntArray(256)
private val gfInit = run {
    var v = 1
    for (i in 0 until 255) { GF_EXP[i] = v; GF_LOG[v] = i; v = v shl 1; if (v and 0x100 != 0) v = v xor 0x11d }
    for (i in 255 until 512) GF_EXP[i] = GF_EXP[i - 255]
    GF_LOG[0] = -1
    true
}
private fun gmul(a: Int, b: Int): Int = if (a == 0 || b == 0) 0 else GF_EXP[GF_LOG[a] + GF_LOG[b]]
private fun ginv(a: Int): Int = GF_EXP[255 - GF_LOG[a]]

/** g(x) = prod (x + a^i), i = 0..19, highest power first (21 coefficients). */
val RS_GEN: IntArray by lazy {
    check(gfInit)
    var g = intArrayOf(1)
    for (i in 0 until 20) {
        val ng = IntArray(g.size + 1)
        for (j in g.indices) { ng[j] = ng[j] xor g[j]; ng[j + 1] = ng[j + 1] xor gmul(g[j], GF_EXP[i]) }
        g = ng
    }
    g
}

/** Systematic RS(207,187): 187 data bytes in, 207 out. */
fun rsEncode(data: ByteArray, from: Int = 0): ByteArray {
    val gen = RS_GEN
    val out = ByteArray(RS_N); System.arraycopy(data, from, out, 0, RS_K)
    val rem = IntArray(20)
    for (i in 0 until RS_K) {
        val f = (out[i].toInt() and 0xff) xor rem[0]
        for (j in 0 until 19) rem[j] = rem[j + 1] xor gmul(f, gen[j + 1])
        rem[19] = gmul(f, gen[20])
    }
    for (j in 0 until 20) out[RS_K + j] = rem[j].toByte()
    return out
}

/**
 * Corrects one 207-byte codeword in place (Berlekamp-Massey, Chien, Forney, roots a^0..a^19).
 * Returns the number of bytes corrected (0 when clean), or -1 when it cannot be corrected.
 */
fun rsDecode(cw: ByteArray, off: Int = 0): Int {
    check(gfInit)
    val synd = IntArray(20)
    var any = 0
    for (j in 0 until 20) {
        var s = 0
        for (i in 0 until RS_N) s = (cw[off + i].toInt() and 0xff) xor (if (s == 0) 0 else GF_EXP[GF_LOG[s] + j])
        synd[j] = s; any = any or s
    }
    if (any == 0) return 0
    var c = intArrayOf(1); var bb = intArrayOf(1); var l = 0; var m = 1; var b = 1
    for (n in 0 until 20) {
        var d = synd[n]
        for (i in 1..l) if (i < c.size) d = d xor gmul(c[i], synd[n - i])
        if (d == 0) { m++; continue }
        val coef = gmul(d, ginv(b))
        val t = c.copyOf()
        if (c.size < bb.size + m) c = c.copyOf(bb.size + m)
        for (i in bb.indices) c[i + m] = c[i + m] xor gmul(coef, bb[i])
        if (2 * l <= n) { l = n + 1 - l; bb = t; b = d; m = 1 } else m++
    }
    var cl = c.size
    while (cl > 1 && c[cl - 1] == 0) cl--
    if (l > RS_T || cl - 1 != l) return -1
    val locs = IntArray(RS_N); var nl = 0
    for (i in 0 until RS_N) {
        val p = RS_N - 1 - i; val xinv = GF_EXP[(255 - p) % 255]
        var v = 0; var xp = 1
        for (k in 0 until cl) { v = v xor gmul(c[k], xp); xp = gmul(xp, xinv) }
        if (v == 0) locs[nl++] = i
    }
    if (nl != l) return -1
    val om = IntArray(20)
    for (i in 0 until 20) { var j = 0; while (j < cl && j <= i) { om[i] = om[i] xor gmul(c[j], synd[i - j]); j++ } }
    for (q in 0 until nl) {
        val i = locs[q]
        val p = RS_N - 1 - i; val x = GF_EXP[p]; val xi = ginv(x)
        var o = 0; var xp = 1
        for (k in 0 until 20) { o = o xor gmul(om[k], xp); xp = gmul(xp, xi) }
        var dl = 0; xp = 1
        var k = 1
        while (k < cl) { dl = dl xor gmul(c[k], xp); xp = gmul(xp, gmul(xi, xi)); k += 2 }
        if (dl == 0) return -1
        cw[off + i] = ((cw[off + i].toInt() and 0xff) xor gmul(x, gmul(o, ginv(dl)))).toByte()
    }
    return l
}

// ---- interleaver (Fig 5.5): byte n of the stream goes through branch n mod 52, delayed (n mod 52) x 208 bytes ----
const val IL_STEP = 208
const val IL_MAX = 51 * IL_STEP
/** Interleaves a whole stream that starts on a field boundary (bytes before the start count as zero). */
fun interleave(x: ByteArray): ByteArray {
    val y = ByteArray(x.size)
    for (n in x.indices) { val s = n - (n % 52) * IL_STEP; y[n] = if (s >= 0) x[s] else 0 }
    return y
}
/** De-interleaves a stream that starts on a field boundary; the last IL_MAX bytes have no complete output. */
fun deinterleave(y: ByteArray, n: Int = y.size): ByteArray {
    val m = maxOf(0, n - IL_MAX); val x = ByteArray(m)
    for (i in 0 until m) x[i] = y[i + (i % 52) * IL_STEP]
    return x
}

// ---- trellis symbol map (Table 5.1/5.2, just in time) ----
class SymMap(val enc: ByteArray, val byte: IntArray, val shift: ByteArray, val streams: Array<IntArray>)
/** For every data symbol of a field in time order: its coder, the interleaved byte it carries, the bit shift. */
val SYM_MAP: SymMap by lazy {
    val n = FIELD_DATA_SYMS; val enc = ByteArray(n); val byte = IntArray(n); val shift = ByteArray(n)
    val cnt = IntArray(12); val cur = IntArray(12)
    var nxt = 0; var i = 0
    for (s in 0 until DATA_SEGS) for (k in 0 until DATA_SYMS) {
        val e = (k + 4 * s) % 12
        if (cnt[e] and 3 == 0) cur[e] = nxt++
        enc[i] = e.toByte(); byte[i] = cur[e]; shift[i] = (6 - 2 * (cnt[e] and 3)).toByte(); cnt[e]++
        i++
    }
    val streams = Array(12) { e -> val a = IntArray(n / 12); var j = 0; for (t in 0 until n) if (enc[t].toInt() == e) a[j++] = t; a }
    SymMap(enc, byte, shift, streams)
}

/** Trellis encoder state for the 12 coders: precoder memory and the two delays of each. */
class TrellisEncoder {
    private val z2 = IntArray(12); private val s1 = IntArray(12); private val s2 = IntArray(12)
    /** One field of interleaved bytes (64584 from [from]) to 258336 data symbols (levels -7..+7). */
    fun field(bytes: ByteArray, from: Int = 0, out: ByteArray = ByteArray(FIELD_DATA_SYMS)): ByteArray {
        val m = SYM_MAP
        for (i in 0 until FIELD_DATA_SYMS) {
            val e = m.enc[i].toInt(); val pair = ((bytes[from + m.byte[i]].toInt() and 0xff) shr m.shift[i].toInt()) and 3
            val x2 = pair shr 1; val x1 = pair and 1
            val zz = x2 xor z2[e]; z2[e] = zz
            val z0 = s2[e]; val ns2 = s1[e] xor x1; s1[e] = s2[e]; s2[e] = ns2
            out[i] = (2 * (4 * zz + 2 * x1 + z0) - 7).toByte()
        }
        return out
    }
}

/**
 * Viterbi: next state (a,b) = 2a+b comes from state 2*s1+a with X1 = s1^b and subset Z1Z0 = 2*X1+a.
 * The 12-way trellis decoder over whole fields, keeping the precoder memory from field to field.
 */
class TrellisDecoder {
    private val prevZ2 = IntArray(12)
    private val ys = FloatArray(FIELD_DATA_SYMS / 12)
    private val bits = ByteArray(FIELD_DATA_SYMS / 12)
    private val dec = ByteArray(FIELD_DATA_SYMS / 12)
    private val z2b = ByteArray(FIELD_DATA_SYMS / 12 * 4)
    /** Re-encoded levels of the decoded path, for the SNR against trellis decisions. */
    val levels = ByteArray(FIELD_DATA_SYMS)
    fun reset() { prevZ2.fill(0) }
    /** Soft data symbols of one field in, its 64584 interleaved bytes out. */
    fun field(y: FloatArray, out: ByteArray = ByteArray(FIELD_BYTES)): ByteArray {
        val map = SYM_MAP; val byte = map.byte; val shift = map.shift; val tt = FIELD_DATA_SYMS / 12
        out.fill(0)
        val ys = ys; val dec = dec; val z2b = z2b; val lv = levels; val bits = bits
        for (e in 0 until 12) {
            val idx = map.streams[e]
            for (t in 0 until tt) ys[t] = y[idx[t]]
            var m0 = 0f; var m1 = 0f; var m2 = 0f; var m3 = 0f
            for (t in 0 until tt) {
                val v = ys[t]; val o = 4 * t
                // subset s holds levels 2s-7 (Z2 = 0) and 2s+1 (Z2 = 1)
                var a0 = v + 7; var b0 = v - 1; a0 *= a0; b0 *= b0
                var a1 = v + 5; var b1 = v - 3; a1 *= a1; b1 *= b1
                var a2 = v + 3; var b2 = v - 5; a2 *= a2; b2 *= b2
                var a3 = v + 1; var b3 = v - 7; a3 *= a3; b3 *= b3
                val g0: Float; val g1: Float; val g2: Float; val g3: Float
                if (b0 < a0) { g0 = b0; z2b[o] = 1 } else { g0 = a0; z2b[o] = 0 }
                if (b1 < a1) { g1 = b1; z2b[o + 1] = 1 } else { g1 = a1; z2b[o + 1] = 0 }
                if (b2 < a2) { g2 = b2; z2b[o + 2] = 1 } else { g2 = a2; z2b[o + 2] = 0 }
                if (b3 < a3) { g3 = b3; z2b[o + 3] = 1 } else { g3 = a3; z2b[o + 3] = 0 }
                var d = 0; val n0: Float; val n1: Float; val n2: Float; val n3: Float
                var c0 = m0 + g0; var c1 = m2 + g2; if (c1 < c0) { n0 = c1; d = d or 1 } else n0 = c0
                c0 = m0 + g2; c1 = m2 + g0; if (c1 < c0) { n1 = c1; d = d or 2 } else n1 = c0
                c0 = m1 + g1; c1 = m3 + g3; if (c1 < c0) { n2 = c1; d = d or 4 } else n2 = c0
                c0 = m1 + g3; c1 = m3 + g1; if (c1 < c0) { n3 = c1; d = d or 8 } else n3 = c0
                dec[t] = d.toByte()
                var mn = n0; if (n1 < mn) mn = n1; if (n2 < mn) mn = n2; if (n3 < mn) mn = n3
                m0 = n0 - mn; m1 = n1 - mn; m2 = n2 - mn; m3 = n3 - mn
            }
            var st = 0; var best = m0
            if (m1 < best) { best = m1; st = 1 }; if (m2 < best) { best = m2; st = 2 }; if (m3 < best) st = 3
            for (t in tt - 1 downTo 0) {
                val s1 = (dec[t].toInt() shr st) and 1; val a = st shr 1; val b = st and 1; val x1 = s1 xor b; val sb = 2 * x1 + a
                val z2 = z2b[4 * t + sb].toInt()
                bits[t] = (z2 * 2 + x1).toByte()
                lv[idx[t]] = (2 * (4 * z2 + 2 * x1 + a) - 7).toByte()
                st = 2 * s1 + a
            }
            var p = prevZ2[e]
            for (t in 0 until tt) {
                val z2 = bits[t].toInt() shr 1; val x1 = bits[t].toInt() and 1; val x2 = z2 xor p; p = z2
                val i = idx[t]
                out[byte[i]] = (out[byte[i]].toInt() or (((x2 shl 1) or x1) shl shift[i].toInt())).toByte()
            }
            prevZ2[e] = p
        }
        return out
    }
}

/** RS-decodes and de-randomizes 207-byte packets that start on a field boundary into 188-byte TS packets. */
class RsStats(var ok: Int = 0, var corrected: Int = 0, var failed: Int = 0, var bytes: Int = 0)
fun packetsToTs(x: ByteArray, firstPacket: Int, stats: RsStats): ByteArray {
    val n = x.size / RS_N; val ts = ByteArray(n * 188); val pr = PRBS
    for (p in 0 until n) {
        val r = rsDecode(x, p * RS_N)
        if (r == 0) stats.ok++ else if (r > 0) { stats.corrected++; stats.bytes += r } else stats.failed++
        val base = ((firstPacket + p) % DATA_SEGS) * RS_K; val o = p * 188
        ts[o] = 0x47
        for (i in 0 until RS_K) ts[o + 1 + i] = (x[p * RS_N + i].toInt() xor pr[base + i].toInt()).toByte()
        if (r < 0) ts[o + 1] = (ts[o + 1].toInt() or 0x80).toByte()
    }
    return ts
}

/** TS packets (188 bytes each) to the interleaver input of whole fields: randomized and RS coded, sync dropped. */
fun tsToPackets(ts: ByteArray): ByteArray {
    val n = ts.size / 188; val x = ByteArray(n * RS_N); val pr = PRBS; val d = ByteArray(RS_K)
    for (p in 0 until n) {
        val base = (p % DATA_SEGS) * RS_K
        for (i in 0 until RS_K) d[i] = (ts[p * 188 + 1 + i].toInt() xor pr[base + i].toInt()).toByte()
        System.arraycopy(rsEncode(d), 0, x, p * RS_N, RS_N)
    }
    return x
}
