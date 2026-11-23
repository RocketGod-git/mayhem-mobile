package com.rocketgod.mayhem.core.hamid

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * M17, from the M17 Protocol Specification, Part I Air Interface (version 2.1.1): 4FSK at 4800 symbols/s, 40 ms
 * frames of an 8-symbol sync (LSF 55F7, stream FF5D, packet 75FF) and 184 payload symbols, randomized (Appendix B)
 * and interleaved ((45x + 92x²) mod 368, Appendix F); the LSF (base-40 DST and SRC, TYPE, META, CRC 5935) under the
 * K = 5 code and P1; stream frames with the LICH (Golay (24,12)) and the frame number and 16 payload bytes under P2;
 * packet frames under P3; META text, GNSS and extended callsign data. Voice frames go to [M17Receiver.onVoice].
 * The same as the web's dsp/hamid/m17.ts.
 */
const val M17_SYNC_LSF = 0x55f7
const val M17_SYNC_STREAM = 0xff5d
const val M17_SYNC_PACKET = 0x75ff

fun m17SyncSymbols(w: Int): DoubleArray { val lv = intArrayOf(1, 3, -1, -3); return DoubleArray(8) { lv[(w shr (14 - 2 * it)) and 3].toDouble() } }
private val S_LSF = m17SyncSymbols(M17_SYNC_LSF)
private val S_PKT = m17SyncSymbols(M17_SYNC_PACKET)

val M17_RANDOMIZER = intArrayOf(
    0xd6, 0xb5, 0xe2, 0x30, 0x82, 0xff, 0x84, 0x62, 0xba, 0x4e, 0x96, 0x90, 0xd8, 0x98, 0xdd, 0x5d, 0x0c, 0xc8, 0x52, 0x43, 0x91, 0x1d, 0xf8,
    0x6e, 0x68, 0x2f, 0x35, 0xda, 0x14, 0xea, 0xcd, 0x76, 0x19, 0x8d, 0xd5, 0x80, 0xd1, 0x33, 0x87, 0x13, 0x57, 0x18, 0x2d, 0x29, 0x78, 0xc3,
)
private val RAND_BIT = IntArray(368) { (M17_RANDOMIZER[it shr 3] shr (7 - (it and 7))) and 1 }
fun m17Interleave(i: Int): Int = ((45L * i + 92L * i * i) % 368).toInt()
private val QPP = IntArray(368) { m17Interleave(it) }
val M17_P1 = intArrayOf(1) + IntArray(60) { intArrayOf(1, 0, 1, 1)[it % 4] }
val M17_P2 = intArrayOf(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0)
val M17_P3 = intArrayOf(1, 1, 1, 1, 1, 1, 1, 0)
private val G = intArrayOf(0b11001, 0b10111)

fun m17Crc(b: IntArray, n: Int): Int {
    var crc = 0xffff
    for (i in 0 until n) { crc = crc xor ((b[i] and 255) shl 8); repeat(8) { crc = if ((crc and 0x8000) != 0) ((crc shl 1) xor 0x5935) and 0xffff else (crc shl 1) and 0xffff } }
    return crc
}

private const val B40 = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/."
fun m17Address(b: IntArray, from: Int = 0): String {
    var v = 0L; for (i in 0 until 6) v = v * 256 + (b[from + i] and 255)
    if (v == 0xffffffffffffL) return "@ALL"
    if (v >= 0xee6b28000000L) return "#" + v.toString(16).uppercase()
    val s = StringBuilder()
    while (v > 0) { s.append(B40[(v % 40).toInt()]); v /= 40 }
    return s.toString().trimEnd()
}
fun m17Encode(call: String): Long {
    var v = 0L; val s = call.uppercase().take(9)
    for (i in s.length - 1 downTo 0) { val k = B40.indexOf(s[i]); v = v * 40 + (if (k > 0) k else 0) }
    return v
}

/** 184 symbols (polarity applied) → 368 soft bits (positive = 1), de-randomized and de-interleaved. */
fun m17FrameSoft(sym: DoubleArray, inv: Int): DoubleArray {
    val raw = DoubleArray(368)
    for (i in 0 until 184) {
        val s = sym[i] * inv; val c = if (s > 4) 4.0 else if (s < -4) -4.0 else s
        raw[2 * i] = -c; raw[2 * i + 1] = (if (c < 0) -c else c) - 2
    }
    for (i in 0 until 368) if (RAND_BIT[i] == 1) raw[i] = -raw[i]
    return DoubleArray(368) { raw[QPP[it]] }
}
private fun depuncture(rx: DoubleArray, from: Int, count: Int, p: IntArray, n: Int): DoubleArray {
    val o = DoubleArray(n); var k = from; var i = 0
    while (i < n && k < from + count) { if (p[i % p.size] == 1) o[i] = rx[k++]; i++ }
    return o
}
private fun par(v: Int): Int { var x = v; x = x xor (x ushr 4); x = x xor (x ushr 2); x = x xor (x ushr 1); return x and 1 }

class M17Decoded(val bits: IntArray, val errs: Int)

/** Soft Viterbi for the K = 5 code (positive = 1, zero = punctured), ending in state 0; [errs] as the web counts them. */
fun m17Viterbi(soft: DoubleArray): M17Decoded {
    val S = 16; val n = soft.size shr 1
    var pm = DoubleArray(S) { -1e30 }; pm[0] = 0.0
    var nx = DoubleArray(S)
    val from = IntArray(n * S); val prev = IntArray(n * S)
    val o0 = IntArray(32); val o1 = IntArray(32)
    for (s in 0 until S) for (b in 0..1) { val r = ((s shl 1) or b) and 31; o0[s * 2 + b] = par(r and G[0]); o1[s * 2 + b] = par(r and G[1]) }
    for (i in 0 until n) {
        nx.fill(-1e30)
        val c0 = soft[2 * i]; val c1 = soft[2 * i + 1]
        for (s in 0 until S) {
            val base = pm[s]; if (base <= -1e29) continue
            for (b in 0..1) {
                val ns = ((s shl 1) or b) and 15
                val d = base + (if (o0[s * 2 + b] == 1) c0 else -c0) + (if (o1[s * 2 + b] == 1) c1 else -c1)
                if (d > nx[ns]) { nx[ns] = d; from[i * S + ns] = b; prev[i * S + ns] = s }
            }
        }
        val t = pm; pm = nx; nx = t
    }
    val bits = IntArray(n); var s = 0
    for (i in n - 1 downTo 0) { bits[i] = from[i * S + s]; s = prev[i * S + s] }
    var errs = 0; var r = 0
    for (i in 0 until n) {
        r = ((r shl 1) or bits[i]) and 31
        val c0 = soft[2 * i]; val c1 = soft[2 * i + 1]; val e0 = par(r and G[0]); val e1 = par(r and G[1])
        if ((c0 > 0 && e0 == 0) || (c0 < 0 && e0 == 1)) errs++
        if ((c1 > 0 && e1 == 0) || (c1 < 0 && e1 == 1)) errs++
    }
    return M17Decoded(bits, errs)
}
private fun bytesOf(bits: IntArray, from: Int, n: Int): IntArray { val o = IntArray(n); for (i in 0 until n * 8) if (bits[from + i] != 0) o[i shr 3] = o[i shr 3] or (0x80 shr (i and 7)); return o }

class M17Lsf(val bytes: IntArray, val errs: Int)
fun m17DecodeLsf(soft: DoubleArray): M17Lsf? {
    val d = m17Viterbi(depuncture(soft, 0, 368, M17_P1, 488)); val b = bytesOf(d.bits, 0, 30)
    if (m17Crc(b, 30) != 0 || b.all { it == 0 }) return null
    return M17Lsf(b, d.errs)
}
fun m17DecodeLich(soft: DoubleArray): IntArray? {
    val o = IntArray(6)
    for (g in 0 until 4) {
        var w = 0; for (i in 0 until 24) w = (w shl 1) or (if (soft[24 * g + i] > 0) 1 else 0)
        val r = Fec.golay24Decode(w) ?: return null
        val x = r.data
        if (g % 2 == 0) { o[3 * (g shr 1)] = x shr 4; o[3 * (g shr 1) + 1] = (x and 15) shl 4 }
        else { o[3 * (g shr 1) + 1] = o[3 * (g shr 1) + 1] or (x shr 8); o[3 * (g shr 1) + 2] = x and 255 }
    }
    return o
}
class M17Stream(val fn: Int, val payload: IntArray, val errs: Int)
fun m17DecodeStream(soft: DoubleArray): M17Stream {
    val d = m17Viterbi(depuncture(soft, 96, 272, M17_P2, 296)); val b = bytesOf(d.bits, 0, 18)
    return M17Stream((b[0] shl 8) or b[1], b.copyOfRange(2, 18), d.errs)
}
class M17Packet(val data: IntArray, val eof: Boolean, val count: Int, val errs: Int)
fun m17DecodePacket(soft: DoubleArray): M17Packet {
    val d = m17Viterbi(depuncture(soft, 0, 368, M17_P3, 420)); val b = bytesOf(d.bits, 0, 26)
    return M17Packet(b.copyOfRange(0, 25), (b[25] and 0x80) != 0, (b[25] shr 2) and 31, d.errs)
}

class M17LsfFields(val dst: String, val src: String, val type: Int, val meta: IntArray) {
    val stream get() = (type and 1) == 1
    val dataType get() = (type shr 1) and 3
    val encType get() = (type shr 3) and 3
    val encSub get() = (type shr 5) and 3
    val can get() = (type shr 7) and 15
    val signed get() = ((type shr 11) and 1) == 1
}
fun m17ParseLsf(b: IntArray): M17LsfFields = M17LsfFields(m17Address(b, 0), m17Address(b, 6), ((b[12] and 255) shl 8) or (b[13] and 255), IntArray(14) { b[14 + it] and 255 })

class M17Gnss(val pos: Position?, val source: Int, val station: Int, val radiusM: Int, val bearing: Int, val speedKmh: Double)
fun m17ParseGnss(m: IntArray): M17Gnss {
    val valid = (m[1] shr 4) and 15
    fun s24(i: Int): Int { val v = ((m[i] and 255) shl 16) or ((m[i + 1] and 255) shl 8) or (m[i + 2] and 255); return if ((v and 0x800000) != 0) v - 0x1000000 else v }
    var pos: Position? = null
    if ((valid and 8) != 0) {
        val lat = s24(3) * 90.0 / 8388607; val lon = s24(6) * 180.0 / 8388607
        if (abs(lat) <= 90 && abs(lon) <= 180 && !(lat == 0.0 && lon == 0.0)) {
            pos = Position(lat, lon, "m17-gnss")
            if ((valid and 4) != 0) pos.alt = (((m[9] and 255) shl 8) or (m[10] and 255)) * 0.5 - 500
        }
    }
    return M17Gnss(pos, (m[0] shr 4) and 15, m[0] and 15,
        if ((valid and 1) != 0) 1 shl ((m[1] shr 1) and 7) else -1,
        if ((valid and 2) != 0) ((m[1] and 1) shl 8) or (m[2] and 255) else -1,
        if ((valid and 2) != 0) ((((m[11] and 255) shl 4) or ((m[12] and 255) shr 4)) * 0.5) else -1.0)
}
private val REFLECTOR = Regex("^([A-Z0-9][A-Z0-9-]{2,7}) +([A-Z])$")
fun m17ReflectorOf(s: String): Pair<String, String>? = REFLECTOR.find(s)?.let { it.groupValues[1] to it.groupValues[2] }

data class M17Id(
    var dst: String = "", var src: String = "", var can: Int = -1,
    /** "voice", "voice+data", "data" (stream mode) or "packet"; "" until an LSF is known. */
    var kind: String = "", var codec: Int = 0, var encryption: String = "", var signed: Boolean = false,
    /** "lsf" or "lich" (six LICH pieces, joined late). */
    var lsfFrom: String = "",
    var text: String = "", var position: Position? = null, var gnssStation: Int = -1, var originator: String = "", var reflector: String = "", var module: String = "",
    var packetProto: Int = -1, var packetText: String = "",
    var lsfs: Int = 0, var frames: Int = 0, var packets: Int = 0, var fn: Int = -1, var ended: Boolean = false, var inverted: Boolean = false,
    var voiceFrames: Int = 0,
)

private val ENC = arrayOf("", "scrambler", "AES", "other")
private val KIND = arrayOf("", "data", "voice", "voice+data")
private const val MAX_ERRS = 28

class M17Receiver {
    /** A Codec 2 frame (8 bytes) and its rate (3200 or 1600). */
    var onVoice: (IntArray, Int) -> Unit = { _, _ -> }
    var id = M17Id(); private set
    private val ring = DoubleArray(512); private var t = 0L
    private class Pending(val at: Long, val tries: List<IntArray>)
    private val pend = ArrayDeque<Pending>()
    private var lastFrame = -1_000_000_000L; private var inv = 0
    private var lsf: M17LsfFields? = null
    private val lich = IntArray(30); private var lichMask = 0
    private val textBlk = arrayOf("", "", "", ""); private var textCtl = 0
    private val pkt = ArrayList<Int>(); private var pktNext = 0

    fun reset() {
        ring.fill(0.0); t = 0; pend.clear(); lastFrame = -1_000_000_000L; inv = 0; lsf = null
        lich.fill(0); lichMask = 0; textBlk.fill(""); textCtl = 0; pkt.clear(); pktNext = 0; id = M17Id()
    }

    fun pushSymbol(s: Double) {
        ring[(t and 511).toInt()] = s; t++
        var c = 0.0; var e = 0.0; var cp = 0.0
        for (k in 0 until 8) { val x = ring[((t - 8 + k) and 511).toInt()]; c += x * S_LSF[k]; cp += x * S_PKT[k]; e += x * x }
        if (e > 0) {
            val n = sqrt(e * 72); val cl = c / n; val cpk = cp / n; val mag = sqrt(e / 8)
            val expected = abs(t - lastFrame - 192) <= 1
            val thr = if (expected) 0.5 else 0.88
            if (mag > 1.5 || expected) {
                val tries = ArrayList<IntArray>()
                if (cl >= thr) { tries.add(intArrayOf(0, 1)); tries.add(intArrayOf(1, -1)) }
                if (cl <= -thr) { tries.add(intArrayOf(1, 1)); tries.add(intArrayOf(0, -1)) }
                if (cpk >= thr) tries.add(intArrayOf(2, 1))
                if (cpk <= -thr) tries.add(intArrayOf(2, -1))
                if (tries.isNotEmpty()) {
                    val sorted = if (inv != 0) tries.sortedBy { if (it[1] == inv) 0 else 1 } else tries
                    pend.addLast(Pending(t, sorted))
                }
            }
        }
        while (pend.isNotEmpty() && t - pend.first().at >= 184) {
            val p = pend.removeFirst()
            if (p.at - lastFrame < 190) continue
            frame(p)
        }
    }

    private fun frame(p: Pending) {
        val sym = DoubleArray(184) { ring[((p.at + it) and 511).toInt()] }
        for (tr in p.tries) {
            val kind = tr[0]; val pol = tr[1]
            val soft = m17FrameSoft(sym, pol)
            when (kind) {
                0 -> { val r = m17DecodeLsf(soft) ?: continue; locked(p.at, pol); gotLsf(r.bytes, "lsf"); return }
                1 -> {
                    val l = m17DecodeLich(soft) ?: continue
                    val cnt = l[5] shr 5; if (cnt > 5) continue
                    val st = m17DecodeStream(soft); if (st.errs > MAX_ERRS) continue
                    locked(p.at, pol); stream(l, cnt, st.fn, st.payload); return
                }
                else -> {
                    val pk = m17DecodePacket(soft)
                    if (pk.errs > MAX_ERRS || (pk.eof && (pk.count < 1 || pk.count > 25))) continue
                    locked(p.at, pol); packet(pk.data, pk.eof, pk.count); return
                }
            }
        }
    }
    private fun locked(at: Long, pol: Int) { lastFrame = at; inv = pol; id.inverted = pol < 0 }

    private fun gotLsf(b: IntArray, from: String) {
        val l = m17ParseLsf(b)
        val old = lsf
        val same = old != null && old.src == l.src && old.dst == l.dst && old.type == l.type
        if (from == "lsf" || !same) newCall()
        lsf = l
        if (from == "lsf") id.lsfs++
        id.lsfFrom = from
        id.dst = l.dst; id.src = l.src; id.can = l.can; id.signed = l.signed
        id.kind = if (l.stream) KIND[l.dataType] else "packet"
        id.codec = if (l.stream && l.encType == 0) (if (l.dataType == 2) 3200 else if (l.dataType == 3) 1600 else 0) else 0
        id.encryption = if (l.stream) ENC[l.encType] else ""
        id.ended = false
        if (!l.stream || l.encType == 0) meta(l.encSub, l.meta)
        if (id.reflector.isEmpty()) m17ReflectorOf(l.dst)?.let { id.reflector = it.first; id.module = it.second }
    }
    private fun meta(kind: Int, m: IntArray) {
        when (kind) {
            0 -> {
                val ctl = m[0]; if (ctl == 0) return
                var blk = -1; for (i in 0 until 4) if ((ctl and (1 shl i)) != 0) { blk = i; break }
                if (blk < 0) return
                val s = StringBuilder(); for (i in 1 until 14) { val ch = m[i]; if (ch in 32..126) s.append(ch.toChar()) else if (ch != 0) s.append('?') }
                textBlk[blk] = s.toString(); textCtl = textCtl or ctl
                val need = textCtl shr 4
                val t = StringBuilder(); for (i in 0 until 4) if ((need and (1 shl i)) != 0 || textBlk[i].isNotEmpty()) t.append(textBlk[i])
                id.text = t.toString().trimEnd()
            }
            1 -> { val g = m17ParseGnss(m); if (g.pos != null) id.position = g.pos; id.gnssStation = g.station }
            2 -> {
                id.originator = m17Address(m, 0)
                val r2 = m17Address(m, 6); val r = m17ReflectorOf(r2)
                if (r != null) { id.reflector = r.first; id.module = r.second } else if (r2.isNotEmpty()) { id.reflector = r2; id.module = "" }
            }
        }
    }
    private fun newCall() {
        id.text = ""; id.position = null; id.gnssStation = -1; id.originator = ""; id.reflector = ""; id.module = ""; id.fn = -1; id.ended = false
        textBlk.fill(""); textCtl = 0; pkt.clear(); pktNext = 0
    }

    private fun stream(l6: IntArray, cnt: Int, fn: Int, payload: IntArray) {
        id.frames++
        for (i in 0 until 5) lich[5 * cnt + i] = l6[i]
        lichMask = lichMask or (1 shl cnt)
        if (cnt == 5 && lichMask == 63 && m17Crc(lich, 30) == 0) {
            val l = m17ParseLsf(lich); val old = lsf
            if (old == null || l.src != old.src || l.dst != old.dst || l.type != old.type) gotLsf(lich.copyOf(), "lich")
            else if (l.encType == 0) { lsf = l; meta(l.encSub, l.meta) }
        }
        if (cnt == 5) lichMask = 0
        id.fn = fn and 0x7fff; id.ended = (fn and 0x8000) != 0
        val l = lsf
        if (l != null && l.stream && l.encType == 0 && (fn and 0x7fff) < 0x7ffb) {
            if (l.dataType == 2) { onVoice(payload.copyOfRange(0, 8), 3200); onVoice(payload.copyOfRange(8, 16), 3200); id.voiceFrames += 2 }
            else if (l.dataType == 3) { onVoice(payload.copyOfRange(0, 8), 1600); id.voiceFrames++ }
        }
    }

    private fun packet(data: IntArray, eof: Boolean, count: Int) {
        id.frames++
        if (!eof) {
            if (count != pktNext) { pkt.clear(); pktNext = 0; if (count != 0) return }
            for (v in data) pkt.add(v)
            pktNext++
            return
        }
        for (i in 0 until count) pkt.add(data[i])
        val b = pkt.toIntArray(); pkt.clear(); pktNext = 0
        if (b.size < 3 || m17Crc(b, b.size) != 0) return
        id.packets++
        id.packetProto = b[0]
        val s = StringBuilder()
        for (i in 1 until b.size - 2) { val ch = b[i]; if (ch == 0) break; s.append(if (ch in 32..126) ch.toChar() else if (ch == 10 || ch == 13) '\n' else '?') }
        id.packetText = s.toString()
        if (b[0] == 0x02 || b[0] == 0x05) for (line in id.packetText.split('\n')) { val p = parsePositionLine(line); if (p != null) id.position = p }
    }
}
