package com.rocketgod.mayhem.core.hamid

import kotlin.math.sqrt

/**
 * Yaesu System Fusion (C4FM) identity, from Yaesu's "Amateur Radio Digital Specifications" (rev. 1.01): the FS sync
 * D471C9634D, the FICH (CRC-16, Golay (24,12,8), K = 5 code, dibit interleave 20 x 5) and the callsign data units
 * (PN (9,5) whitening, CRC-16, K = 5 code, dibit interleave 20 x 9 or 20 x 5): destination, source, downlink and
 * uplink callsigns, the remarks, DG-ID (the squelch code), and positions in the data units. The same as the web's
 * dsp/hamid/ysf.ts.
 */
val YSF_SYNC: DoubleArray = run {
    val lv = intArrayOf(1, 3, -1, -3); val out = ArrayList<Double>()
    for (ch in "D471C9634D") { val v = ch.digitToInt(16); out.add(lv[v shr 2].toDouble()); out.add(lv[v and 3].toDouble()) }
    out.toDoubleArray()
}
private val SYNC_E = YSF_SYNC.sumOf { it * it }

/** The whitening sequence: PN (9,5), x^9 + x^5 + 1, S08..S00 = 111001001, output S00 (93 D7 51 ...). */
fun ysfWhitening(nBits: Int): IntArray {
    val out = IntArray(nBits); var s = 0x1c9
    for (i in 0 until nBits) { out[i] = s and 1; val fb = (s xor (s shr 4)) and 1; s = (s shr 1) or (fb shl 8) }
    return out
}
private val WHITE = ysfWhitening(160)

data class YsfFich(val fi: Int, val cs: Int, val cm: Int, val bn: Int, val bt: Int, val fn: Int, val ft: Int, val mr: Int, val voip: Int, val dt: Int, val sql: Int, val sc: Int)
fun parseFich(w: Long): YsfFich {
    fun f(sh: Int, m: Int) = ((w ushr sh) and m.toLong()).toInt()
    return YsfFich(f(30, 3), f(28, 3), f(26, 3), f(24, 3), f(22, 3), f(19, 7), f(16, 7), f(11, 7), f(10, 1), f(8, 3), f(7, 1), f(0, 0x7f))
}

private fun deinterleave(d: IntArray, cols: Int): IntArray {
    val n = d.size; val bits = IntArray(2 * n)
    for (i in 0 until n) { val v = d[(i % cols) * 20 + i / cols]; bits[2 * i] = (v shr 1) and 1; bits[2 * i + 1] = v and 1 }
    return bits
}

/** 100 FICH dibits → the 32 information bits, or null when Golay or the CRC fails. */
fun decodeFich(d: IntArray): Long? {
    val bits = Fec.viterbi(deinterleave(d, 5), Fec.YSF_K, Fec.YSF_G).bits
    val out = IntArray(6)
    for (g in 0 until 4) {
        var w = 0; for (i in 0 until 24) w = (w shl 1) or bits[24 * g + i]
        val r = Fec.golay24Decode(w) ?: return null
        val x = r.data
        if (g % 2 == 0) { out[3 * (g shr 1)] = x shr 4; out[3 * (g shr 1) + 1] = (x and 15) shl 4 }
        else { out[3 * (g shr 1) + 1] = out[3 * (g shr 1) + 1] or (x shr 8); out[3 * (g shr 1) + 2] = x and 255 }
    }
    if (Fec.crc16Msb(out, 4) != ((out[4] shl 8) or out[5])) return null
    return (out[0].toLong() shl 24) or (out[1].toLong() shl 16) or (out[2].toLong() shl 8) or out[3].toLong()
}

/** One data unit (180 dibits → 20 bytes, or 100 → 10), de-whitened, or null when the CRC fails. */
fun decodeUnit(d: IntArray): IntArray? {
    val nBytes = if (d.size == 180) 20 else 10; val cols = if (d.size == 180) 9 else 5
    val bits = Fec.viterbi(deinterleave(d, cols), Fec.YSF_K, Fec.YSF_G).bits
    val b = Fec.packMsb(bits, 0, nBytes + 2)
    if (Fec.crc16Msb(b, nBytes) != ((b[nBytes] shl 8) or b[nBytes + 1])) return null
    val out = b.copyOf(nBytes)
    for (i in 0 until nBytes * 8) if (WHITE[i] != 0) out[i shr 3] = out[i shr 3] xor (0x80 ushr (i and 7))
    return out
}

class YsfId {
    var dest = ""; var src = ""; var down = ""; var up = ""; var rem = arrayOf("", "", "", "")
    var dgid = -1; var sqlOn = false; var dt = -1; var callMode = -1; var route = -1; var voip = false
    var position: Position? = null; var positionText = ""
    var frames = 0; var units = 0; var inverted = false; var active = false
    fun copy(): YsfId = YsfId().also { it.dest = dest; it.src = src; it.down = down; it.up = up; it.rem = rem.copyOf(); it.dgid = dgid; it.sqlOn = sqlOn; it.dt = dt; it.callMode = callMode; it.route = route; it.voip = voip; it.position = position; it.positionText = positionText; it.frames = frames; it.units = units; it.inverted = inverted; it.active = active }
}
private fun slice4(s: Double) = if (s > 2) 1 else if (s > 0) 0 else if (s > -2) 2 else 3
private val LINE_SPLIT = Regex("[\\r\\n]+")

class YsfReceiver {
    var onFich: (YsfFich) -> Unit = {}
    private val ring = DoubleArray(20); private var rp = 0
    private var sym: DoubleArray? = null; private var sn = 0; private var inv = 1.0
    private var t = 0L; private var lastSync = -1_000_000_000L
    private val dtBytes = ArrayList<IntArray?>()
    var syncs = 0
    val id = YsfId()

    fun reset() {
        ring.fill(0.0); rp = 0; sym = null; sn = 0; inv = 1.0; t = 0; lastSync = -1_000_000_000L; dtBytes.clear(); syncs = 0
        id.dest = ""; id.src = ""; id.down = ""; id.up = ""; id.rem = arrayOf("", "", "", ""); id.dgid = -1; id.sqlOn = false; id.dt = -1; id.callMode = -1; id.route = -1; id.voip = false
        id.position = null; id.positionText = ""; id.frames = 0; id.units = 0; id.inverted = false; id.active = false
    }

    fun pushSymbol(s: Double) {
        t++
        val f = sym
        if (f != null) {
            f[sn++] = s * inv
            if (sn == 460) { sym = null; frame(f) }
            return
        }
        ring[rp] = s; rp = (rp + 1) % 20
        var c = 0.0; var e = 0.0
        for (k in 0 until 20) { val x = ring[(rp + k) % 20]; c += x * YSF_SYNC[k]; e += x * x }
        if (e <= 0) return
        val corr = c / sqrt(e * SYNC_E)
        val expected = kotlin.math.abs(t - lastSync - 480) <= 1
        val thr = if (expected) 0.6 else 0.9
        if (corr >= thr || corr <= -thr) {
            inv = if (corr > 0) 1.0 else -1.0; id.inverted = inv < 0
            syncs++; lastSync = t; sym = DoubleArray(460); sn = 0
        }
    }

    private fun frame(f: DoubleArray) {
        val d = IntArray(460) { slice4(f[it]) }
        val w = decodeFich(d.copyOfRange(0, 100)) ?: return
        val fi = parseFich(w)
        id.frames++; id.active = fi.fi != 2
        id.dgid = fi.sc; id.sqlOn = fi.sql == 0; id.dt = fi.dt; id.callMode = fi.cm; id.route = fi.mr; id.voip = fi.voip == 1
        onFich(fi)
        val p = d.copyOfRange(100, 460)
        fun blocks(first: Int): IntArray { val o = IntArray(180); for (j in 0 until 5) System.arraycopy(p, (2 * j + first) * 36, o, 36 * j, 36); return o }
        if (fi.fi == 0) newCall()
        if (fi.fi == 0 || fi.fi == 2) { csd(1, decodeUnit(blocks(0))); csd(2, decodeUnit(blocks(1))) }
        else if (fi.fi == 1) {
            when (fi.dt) {
                0 -> { val u = decodeUnit(blocks(0)); if (fi.fn <= 2) csd(fi.fn + 1, u) else data(fi.fn - 3, u) }
                2 -> { val o = IntArray(100); for (j in 0 until 5) System.arraycopy(p, 72 * j, o, 20 * j, 20); half(fi.fn, decodeUnit(o)) }
                1 -> {
                    val a = decodeUnit(blocks(0)); val b = decodeUnit(blocks(1))
                    if (fi.fn == 0) { csd(1, a); csd(2, b) } else if (fi.fn == 1) { csd(3, a); data(0, b) } else { data(2 * fi.fn - 3, a); data(2 * fi.fn - 2, b) }
                }
                3 -> if (fi.fn == 0) csd(3, decodeUnit(p.copyOfRange(0, 180)))
            }
        }
    }

    private fun newCall() { dtBytes.clear(); id.dest = ""; id.src = ""; id.down = ""; id.up = ""; id.rem = arrayOf("", "", "", ""); id.position = null; id.positionText = "" }
    private fun csd(n: Int, u: IntArray?) {
        if (u == null) return
        id.units++
        when (n) {
            1 -> { id.dest = Fec.asciiField(u, 0, 10); id.src = Fec.asciiField(u, 10, 10) }
            2 -> { id.down = Fec.asciiField(u, 0, 10); id.up = Fec.asciiField(u, 10, 10) }
            else -> for (k in 0 until 4) id.rem[k] = Fec.asciiField(u, 5 * k, 5)
        }
    }
    private fun half(fn: Int, u: IntArray?) {
        if (u == null) return
        id.units++
        val s = Fec.asciiField(u, 0, 10)
        when (fn) {
            0 -> id.dest = s; 1 -> id.src = s; 2 -> id.down = s; 3 -> id.up = s
            4 -> { id.rem[0] = Fec.asciiField(u, 0, 5); id.rem[1] = Fec.asciiField(u, 5, 5) }
            5 -> { id.rem[2] = Fec.asciiField(u, 0, 5); id.rem[3] = Fec.asciiField(u, 5, 5) }
            else -> data(fn - 6, u)
        }
    }
    private fun data(k: Int, u: IntArray?) {
        if (u == null || k < 0 || k > 15) return
        id.units++
        while (dtBytes.size <= k) dtBytes.add(null)
        dtBytes[k] = u
        val sb = StringBuilder()
        for (b in dtBytes) { if (b == null) break; for (v in b) if (v != 0) sb.append(v.toChar()) }
        for (line in sb.toString().split(LINE_SPLIT)) {
            val pos = parsePositionLine(line)
            if (pos != null) { id.position = pos; id.positionText = line.trim() }
        }
    }
}
