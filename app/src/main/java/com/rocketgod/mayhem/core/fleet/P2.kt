package com.rocketgod.mayhem.core.fleet

import com.rocketgod.mayhem.core.ham.rsDecode
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.sin

/**
 * P25 Phase 2 two-slot TDMA, outbound voice channel (TIA-102.BBAB physical layer, TIA-102.BBAC MAC layer).
 *
 *  - H-DQPSK at 6000 symbols a second, demodulated by the phase step across one symbol (+3pi/4 is dibit 01, +pi/4 00,
 *    -pi/4 10, -3pi/4 11), symbol timing picked again every 360 symbols.
 *  - Timeslots of 180 symbols (30 ms), twelve to a 360 ms superframe. A 20-symbol ISCH straddles each slot boundary;
 *    the S-ISCH is the sync 0x575D57F7FF (BBAC 5.1). Slots 10 and 11 carry the SACCH; the outbound logical channel 0
 *    has slots 0, 2, 4, 6, 8 and 11, channel 1 slots 1, 3, 5, 7, 9 and 10 (BBAC 3.2).
 *  - The DUID, four unscrambled dibits at symbols 10, 47, 132 and 169 of a slot: a (8,4,4) code (BBAC 5.4, Table 5-3)
 *    naming the burst 4V, 2V, FACCH or SACCH, scrambled or not.
 *  - Scrambling (BBAC 7.2.5): a 44-bit LFSR, G(x) = x^44 + x^40 + x^35 + x^29 + x^24 + x^10 + 1, seeded with
 *    WACN * 2^24 + System ID * 2^12 + Color Code (the NAC), restarted every superframe at the start of slot 0; bit n of
 *    the superframe (360 a slot, ISCH and DUID positions included) is XORed with sequence bit n.
 *  - Voice (BBAC Annex E): 4V bursts carry four 72-bit AMBE+2 half-rate frames at symbols 11, 48, 96 and 133, with
 *    ESS-B at 84; 2V bursts two frames at 11 and 48, with ESS-A at 84 and 133.
 *  - ESS (BBAC 5.6.2): ALGID, key ID and MI, a (44,16,29) Reed-Solomon code over GF(64): the 16 information hexbits
 *    in the ESS-B of four 4V bursts, the 28 parity hexbits in the 2V's ESS-A.
 *  - MAC PDUs (BBAC 5.6, 8): the FACCH burst carries an S-OEMI (156 bits at symbols 11, 48 and 100 around a sync), the
 *    SACCH an I-OEMI (180 bits at symbols 11 and 48), each ending in a CRC-12 (g(x) = x^12 + x^11 + x^7 + x^4 + x^2 +
 *    x + 1, remainder inverted).
 * The superframe position is found from the SACCH pair (slots 10 and 11 right after an S-ISCH pair), and the seed by
 * which candidate (the systems heard on the control channels) makes the voice frames' first Golay word pass.
 */
const val P2_BAUD = 6000

/** The S-ISCH sync as symbol levels (dibit 01 is +3, 11 is -3). */
val P2_SYNC: IntArray = run {
    val bits = "575D57F7FF".flatMap { ch -> val v = ch.digitToInt(16); listOf((v shr 3) and 1, (v shr 2) and 1, (v shr 1) and 1, v and 1) }
    IntArray(bits.size / 2) { i ->
        when ("${bits[2 * i]}${bits[2 * i + 1]}") { "01" -> 3; "00" -> 1; "10" -> -1; else -> -3 }
    }
}
private const val P2_BLK = 360
private const val P2_SLOT = 180
private const val P2_SF_BITS = 4320

/** DUID information values (BBAC Table 5-3). */
object DUID {
    const val V4 = 0b0000; const val V2 = 0b0110; const val SACCH_S = 0b0011; const val FACCH_S = 0b1001; const val SACCH = 0b1100; const val FACCH = 0b1111
    val ALL = intArrayOf(V4, V2, SACCH_S, FACCH_S, SACCH, FACCH)
}
private val DUID_ROWS = intArrayOf(0b1101, 0b1011, 0b1110, 0b0111)
fun duidEncode(i: Int): Int { var p = 0; for (b in 0 until 4) if ((i and (8 shr b)) != 0) p = p xor DUID_ROWS[b]; return (i shl 4) or p }
data class DuidRead(val v: Int, val dist: Int)
/** The DUID from its eight received bits: the nearest code word, and how far it was. */
fun duidDecode(w: Int): DuidRead {
    var v = 0; var dist = 9
    for (i in 0 until 16) { val n = Integer.bitCount(duidEncode(i) xor w); if (n < dist) { dist = n; v = i } }
    return DuidRead(v, dist)
}
/** The 4320-bit scrambling sequence of a superframe (BBAC 7.2.5, external LFSR, output from bit 43 of the seed). */
fun p2Sequence(wacn: Int, sysId: Int, nac: Int): IntArray {
    var seed = wacn.toLong() * (1L shl 24) + sysId.toLong() * (1L shl 12) + nac
    if (seed == 0L) seed = (1L shl 44) - 1
    val a = IntArray(P2_SF_BITS + 44)
    for (i in 0 until 44) a[i] = ((seed ushr (43 - i)) and 1L).toInt()
    for (m in 44 until a.size) a[m] = a[m - 4] xor a[m - 9] xor a[m - 15] xor a[m - 20] xor a[m - 34] xor a[m - 44]
    return a
}
/** CRC-12 of a MAC PDU (BBAC 8.4.5): the remainder of M(x) x^12 by g12, inverted. */
fun p2Crc12(bits: IntArray, n: Int = bits.size): Int {
    var r = 0
    for (i in 0 until n) { val fb = ((r shr 11) and 1) xor bits[i]; r = (r shl 1) and 0xfff; if (fb != 0) r = r xor 0x897 }
    return r xor 0xfff
}

// the half-rate frame's first Golay (23,12) word, read through the AMBE+2 frame order, checks the descrambling
private const val P2_GOLAY_GEN = 0xc75
private fun p2Golay23Syn(w: Int): Int { var r = w; for (b in 22 downTo 11) if ((r and (1 shl b)) != 0) r = r xor (P2_GOLAY_GEN shl (b - 11)); return r and 0x7ff }
/** Positions in a 72-bit frame (as sent) of the 23 bits of the first Golay word, highest first. */
private val C0_POS: IntArray = run {
    // the AMBE+2 72-bit frame order (the DMR receiver's de-interleave), first code word only
    val rW = intArrayOf(0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2)
    val rX = intArrayOf(23, 10, 22, 9, 21, 8, 20, 7, 19, 6, 18, 5, 17, 4, 16, 3, 15, 2, 14, 1, 13, 0, 12, 10, 11, 9, 10, 8, 9, 7, 8, 6, 7, 5, 6, 4)
    val rY = intArrayOf(0, 2, 0, 2, 0, 2, 0, 2, 0, 3, 0, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3)
    val rZ = intArrayOf(5, 3, 4, 2, 3, 1, 2, 0, 1, 13, 0, 12, 22, 11, 21, 10, 20, 9, 19, 8, 18, 7, 17, 6, 16, 5, 15, 4, 14, 3, 13, 2, 12, 1, 11, 0)
    val at = IntArray(24) { -1 }
    for (i in 0 until 36) { if (rW[i] == 0) at[rX[i]] = 2 * i; if (rY[i] == 0) at[rZ[i]] = 2 * i + 1 }
    IntArray(23) { at[23 - it] }
}
fun c0Clean(f: IntArray): Boolean { var w = 0; for (p in C0_POS) w = (w shl 1) or f[p]; return p2Golay23Syn(w) == 0 }

data class P2Seed(val wacn: Int, val sysId: Int, val nac: Int, val sys: String)
data class P2Ess(val algId: Int, val keyId: Int, val mi: String)
class P2Mac(val lch: Int, val slot: Int, val bytes: IntArray, val opcode: Int, val offset: Int, val facch: Boolean)
val MAC_OPS: Map<Int, String> = mapOf(1 to "MAC_PTT", 2 to "MAC_END_PTT", 3 to "MAC_IDLE", 4 to "MAC_ACTIVE", 6 to "MAC_HANGTIME")

/** Bursts by type, voice frames passed on, MAC PDUs passing / failing their CRC. */
class P2Stats {
    var flywheel = 0; var erased = 0; var slipped = 0; var rescued = 0; var bursts = 0; var v4 = 0; var v2 = 0; var facch = 0; var sacch = 0
    var frames = 0; var c0clean = 0; var macOk = 0; var macBad = 0; var macFixed = 0; var essOk = 0
}

class P2Rx(val fs: Double) {
    /** A sync, and whether it is the second of a pair (180 symbols after the one before). */
    var onSync: (Boolean) -> Unit = {}
    /** One AMBE+2 frame (72 bits, descrambled, as sent) of a logical channel; an empty frame is an erasure (a lost burst). */
    var onVoice: (Int, IntArray) -> Unit = { _, _ -> }
    /** A MAC PDU that passed its CRC. */
    var onMac: (P2Mac) -> Unit = {}
    /** The encryption sync of a logical channel's voice superframe, once its Reed-Solomon code passed. */
    var onEss: (Int, P2Ess) -> Unit = { _, _ -> }
    /** The seed was found among the candidates. */
    var onSeed: (P2Seed) -> Unit = {}
    var syncs = 0; var pairs = 0; var symbols = 0L
    val stats = P2Stats()
    var seeds: List<P2Seed> = emptyList(); private set
    var seed: P2Seed? = null; private set
    private var seq: IntArray? = null
    private val T = fs / P2_BAUD
    private var re = FloatArray(0); private var im = FloatArray(0); private var n = 0
    private val ring = FloatArray(20); private var rp = 0; private var t = 0; private var lastSync = -1_000_000_000
    /** Symbols kept for the bursts, by absolute symbol number. */
    private var hist = ByteArray(8192); private var histBase = 0
    /** Slot starts (absolute symbol numbers) waiting for their 180 symbols; the superframe's slot 0 when known. */
    private val pendingSlots = ArrayList<Int>(); private var sf0 = -1; private var lastPair = -1_000_000_000; private var prevSacch = -1
    private val seedVotes = HashMap<Int, Int>()
    /** Per logical channel: ESS-B pieces of the last four 4V bursts. */
    private val essB = arrayOf(ArrayList<IntArray>(), ArrayList<IntArray>())

    fun setSeeds(s: List<P2Seed>) {
        seeds = s
        val cur = seed
        if (cur != null && s.none { it.wacn == cur.wacn && it.sysId == cur.sysId && it.nac == cur.nac }) { seed = null; seq = null }
    }
    fun push(zi: FloatArray, zq: FloatArray, m: Int) {
        if (n + m > re.size) { val len = max(2 * re.size, n + m + 1024); re = re.copyOf(len); im = im.copyOf(len) }
        for (k in 0 until m) { re[n] = zi[k]; im[n++] = zq[k] }
        val need = ceil((P2_BLK + 2) * T).toInt() + 2
        while (n >= need) block()
    }
    private fun dphi(t: Double): Double {
        val i = floor(t).toInt(); val f = t - i; val j = floor(t - T).toInt(); val g = t - T - j
        val a = re[i] * (1 - f) + re[i + 1] * f; val b = im[i] * (1 - f) + im[i + 1] * f
        val c = re[j] * (1 - g) + re[j + 1] * g; val d = im[j] * (1 - g) + im[j + 1] * g
        return atan2(b * c - a * d, a * c + b * d)
    }
    private fun block() {
        val t0 = T + 1
        var best = 0; var bm = -1e9
        // the timing whose phase steps sit closest to odd multiples of pi/4 (|mean of e^(4j step)|: a frequency offset does not move it)
        for (p in 0 until 8) {
            var x = 0.0; var y = 0.0; var k = 0
            while (k < P2_BLK) { val v = 4 * dphi(t0 + p * T / 8 + k * T); x += cos(v); y += sin(v); k += 3 }
            val s = x * x + y * y; if (s > bm) { bm = s; best = p }
        }
        var cr = 0.0; var ci = 0.0
        for (k in 0 until P2_BLK) { val v = dphi(t0 + best * T / 8 + k * T); cr += cos(4 * v); ci += sin(4 * v) }
        val off = atan2(ci, cr) - PI; val corr = atan2(sin(off), cos(off)) / 4
        for (k in 0 until P2_BLK) { var v = dphi(t0 + best * T / 8 + k * T) - corr; v = atan2(sin(v), cos(v)); symbol(v * 4 / PI) }
        val used = floor(P2_BLK * T).toInt()
        re.copyInto(re, 0, used, n); im.copyInto(im, 0, used, n); n -= used
    }
    /** The dibit of absolute symbol [s] (01 for +3, 00 +1, 10 -1, 11 -3). */
    private fun dib(s: Int): Int { val i = s - histBase; return if (i < 0 || i >= hist.size) 0 else hist[i].toInt() and 3 }
    private fun symbol(s: Double) {
        val t = this.t
        if (t - histBase >= hist.size) { val keep = 2048; val h = ByteArray(hist.size); hist.copyInto(h, 0, hist.size - keep, hist.size); hist = h; histBase = t - keep }
        hist[t - histBase] = (if (s > 2) 1 else if (s > 0) 0 else if (s > -2) 2 else 3).toByte()
        ring[rp] = s.toFloat(); rp = (rp + 1) % 20; this.t++; symbols++
        var c = 0.0; var a = 0.0
        for (k in 0 until 20) { val x = ring[(rp + k) % 20].toDouble(); c += x * P2_SYNC[k]; a += abs(x) * 3 }
        if (a > 0 && c / a > 0.9 && this.t - lastSync > 10) {
            val paired = abs(this.t - lastSync - P2_SLOT) <= 2
            syncs++; if (paired) pairs++
            if (paired) pair(lastSync - 20)
            lastSync = this.t; onSync(paired)
        }
        // a sync pair missed (noise, a fade) does not cost its four slots: once the superframe is placed the slots carry on
        // from the last pair (each one is placed to the symbol on its own), for up to eight pairs
        if (sf0 >= 0 && lastPair > 0 && this.t > lastPair + 720 + 200 && this.t - lastPair < 720 * 8) { stats.flywheel++; pair(lastPair + 720) }
        while (pendingSlots.isNotEmpty() && this.t >= pendingSlots[0] + P2_SLOT + 3) slot(pendingSlots.removeAt(0))
    }
    /** An S-ISCH pair starting at [p]: the four slots after it are framed (the next pair comes 720 symbols on). */
    private fun pair(p: Int) {
        if (p - lastPair < 700) return
        lastPair = p
        for (k in 0 until 4) { val st = p + 10 + P2_SLOT * k; if (st !in pendingSlots) pendingSlots.add(st) }
        pendingSlots.sort()
    }
    private fun duidAt(st: Int): DuidRead {
        val d0 = dib(st + 10); val d1 = dib(st + 47); val d2 = dib(st + 132); val d3 = dib(st + 169)
        return duidDecode((d0 shl 6) or (d1 shl 4) or (d2 shl 2) or d3)
    }
    private fun bits(st: Int, from: Int, n: Int, scr: Boolean, slot: Int, k: IntArray? = seq): IntArray {
        val out = IntArray(2 * n)
        val use = scr && k != null
        for (q in 0 until n) {
            val v = dib(st + from + q); val bi = slot * 360 + 2 * (from + q)
            out[2 * q] = (v shr 1) xor (if (use) k[bi] else 0); out[2 * q + 1] = (v and 1) xor (if (use) k[bi + 1] else 0)
        }
        return out
    }
    private fun slotOf(st: Int): Int = ((Math.round((st - sf0).toDouble() / P2_SLOT) % 12).toInt() + 12) % 12
    /**
     * Where a slot really starts: the symbol clock can slip a symbol between sync pairs, so the burst is looked for a
     * symbol either side (two late) of where the grid puts it. A DUID read cleanly wins; else, once the scrambling is
     * known, the place where most voice frames' first Golay words pass. The slots still to come move with it.
     */
    private fun place(st: Int): Int {
        var best = st; var score = -1
        val slot = if (sf0 >= 0) slotOf(st) else -1
        for (sh in intArrayOf(0, 1, -1, 2)) {
            val d = duidAt(st + sh); val known = d.v in DUID.ALL
            var sc = if (d.dist == 0 && known) 10 else if (d.dist == 1 && known) 5 else 0
            if (seq != null && slot in 0 until 10) sc += 3 * intArrayOf(11, 48, 96, 133).count { c0Clean(bits(st + sh, it, 36, true, slot)) }
            if (sc > score) { score = sc; best = st + sh }
            if (sh == 0 && sc >= 10 + (if (seq != null && slot in 0 until 10) 6 else 0)) break
        }
        if (best != st) { stats.slipped++; for (i in pendingSlots.indices) pendingSlots[i] += best - st }
        return best
    }
    /**
     * A voice slot of a call on the air that brought no voice (lost, or taken by signaling): its time is filled with
     * erasures (an empty frame), which the vocoder answers with the last frame repeated and then muted to a faint floor,
     * so the audio keeps its timing instead of running dry, through a lost burst and a pause between talkers. Fill for a
     * call no longer on the air is dropped, and it stops 5 s after the channel's last voice.
     */
    private val missed = IntArray(2)
    private val voiceT = intArrayOf(-1_000_000_000, -1_000_000_000)
    private fun slot(at: Int) {
        val v0 = stats.frames
        slotInner(at)
        if (sf0 < 0 || seq == null) return
        val pos = slotOf(at)
        if (pos >= 10) return
        val lch = pos and 1
        if (stats.frames != v0) { missed[lch] = 0; return }
        // while the call may still be on the air (the fill for a call that has ended is dropped), at most 5 s from its voice
        if (t - voiceT[lch] > 30_000) return
        missed[lch]++; stats.erased += 4
        for (k in 0 until 4) onVoice(lch, IntArray(0))
    }
    private fun slotInner(at: Int) {
        if (at < histBase) return
        val st = place(at)
        val d = duidAt(st)
        val pos = if (sf0 >= 0) slotOf(st) else -1
        val isSacch = d.v == DUID.SACCH_S || d.v == DUID.SACCH; val isVoice = d.v == DUID.V4 || d.v == DUID.V2
        // a DUID that names a burst its slot never carries (a SACCH in slots 0 to 9, voice in 10 or 11) was misread
        var known = d.dist <= 1 && d.v in DUID.ALL && !(pos >= 0 && ((isSacch && pos < 10) || (isVoice && pos >= 10)))
        // a FACCH read through a damaged DUID whose frames' first Golay words pass where voice sits is voice
        // and a voice DUID read through one bit error must show it: at least two frames whose first Golay word passes
        // (and any voice burst some frame of: a DUID read by chance off noise, after a carrier has gone, carries none)
        if (known && isVoice && pos >= 0 && seq != null) {
            val fs = if (d.v == DUID.V4) intArrayOf(11, 48, 96, 133) else intArrayOf(11, 48)
            if (fs.count { c0Clean(bits(st, it, 36, true, pos)) } < (if (d.dist == 1) 2 else 1)) return
        }
        if (known && d.dist == 1 && !isVoice && pos in 0 until 10 && seq != null && intArrayOf(11, 48, 96, 133).count { c0Clean(bits(st, it, 36, true, pos)) } >= 3) known = false
        // a DUID too damaged to read (or read as no defined burst): once the grid and the scrambling are known, the burst
        // is taken as voice when its frames' first Golay words pass where a 4V (or a 2V) carries them, else it is dropped.
        // A DUID is only four dibits, so a burst at the edge loses it long before it loses its voice.
        if (!known) {
            if (sf0 < 0 || seq == null) return
            val slot = slotOf(st)
            // only inside a call on that logical channel (voice in the last two superframes): never a call made from nothing
            if (slot >= 10 || t - voiceT[slot and 1] > 2 * 2160) return
            val c = intArrayOf(11, 48, 96, 133).map { c0Clean(bits(st, it, 36, true, slot)) }
            val n4 = c.count { it }
            if (n4 >= 3 || (n4 >= 2 && (c[2] || c[3]))) { stats.rescued++; voice(st, slot, slot and 1, true) }
            else if (c[0] && c[1]) { stats.rescued++; voice(st, slot, slot and 1, false) }
            return
        }
        stats.bursts++
        // the SACCH pair (slots 10 and 11) right after an S-ISCH pair sets the superframe: slot 0 begins two slots on
        val sacch = isSacch
        if (sacch && prevSacch >= 0 && abs(st - prevSacch - P2_SLOT) <= 1 && abs(prevSacch - lastPair - 10) <= 1) sf0 = st + P2_SLOT
        prevSacch = if (sacch) st else -1
        if (sf0 < 0) return
        val slot = slotOf(st); val lch = if (slot in intArrayOf(0, 2, 4, 6, 8, 11)) 0 else 1
        if (d.v == DUID.V4 || d.v == DUID.V2) voice(st, slot, lch, d.v == DUID.V4)
        else if (d.v == DUID.FACCH_S || d.v == DUID.FACCH || d.v == DUID.SACCH_S || d.v == DUID.SACCH)
            mac(st, slot, lch, d.v == DUID.FACCH_S || d.v == DUID.FACCH, d.v == DUID.FACCH_S || d.v == DUID.SACCH_S)
    }
    private fun voice(st: Int, slot: Int, lch: Int, four: Boolean) {
        voiceT[lch] = t
        if (four) stats.v4++ else stats.v2++
        val at = if (four) intArrayOf(11, 48, 96, 133) else intArrayOf(11, 48)
        if (seq == null) { findSeed(st, slot, at); if (seq == null) return }
        for (f in at) {
            val fr = bits(st, f, 36, true, slot)
            stats.frames++; if (c0Clean(fr)) stats.c0clean++
            onVoice(lch, fr)
        }
        // ESS-B (4 hexbits) in each 4V; the 2V's ESS-A closes the code word
        val ess = essB[lch]
        if (four) { ess.add(p2Hexbits(bits(st, 84, 12, true, slot))); if (ess.size > 4) ess.removeAt(0) }
        else {
            if (ess.size == 4) {
                val a = bits(st, 84, 48, true, slot) + bits(st, 133, 36, true, slot)
                val cw = (ess.flatMap { it.toList() } + p2Hexbits(a).toList()).toIntArray()
                val fixed = rsDecode(cw, 28)
                if (fixed in 0..10) {
                    fun bit(i: Int) = (cw[i / 6] shr (5 - i % 6)) and 1
                    fun f(a0: Int, n: Int): Int { var v = 0; for (i in 0 until n) v = v * 2 + bit(a0 + i); return v }
                    val mi = StringBuilder(); for (i in 0 until 9) mi.append("%02x".format(f(24 + 8 * i, 8)))
                    stats.essOk++
                    onEss(lch, P2Ess(f(0, 8), f(8, 16), mi.toString()))
                }
            }
            ess.clear()
        }
    }
    private fun mac(st: Int, slot: Int, lch: Int, facch: Boolean, scr: Boolean) {
        if (facch) stats.facch++ else stats.sacch++
        if (scr && seq == null) return
        var info = if (facch) bits(st, 11, 36, scr, slot) + bits(st, 48, 31, scr, slot) + bits(st, 100, 11, scr, slot)
            else bits(st, 11, 36, scr, slot) + bits(st, 48, 54, scr, slot)
        val n = info.size - 12
        fun crcOf(b: IntArray): Int { var c = 0; for (i in n until b.size) c = c * 2 + b[i]; return c }
        if (p2Crc12(info, n) != crcOf(info)) {
            // the Reed-Solomon code (BBAC 5.6.1): S-OEMI (45,26,20) and I-OEMI (52,30,23) from the (63,35,29) mother code,
            // the S most significant information hexbits shortened (zero), the U least significant parity hexbits punctured
            val parity = if (facch) bits(st, 111, 21, scr, slot) + bits(st, 133, 36, scr, slot) else bits(st, 102, 30, scr, slot) + bits(st, 133, 36, scr, slot)
            val s0 = if (facch) 9 else 5; val u = if (facch) 9 else 6
            val cw = IntArray(s0) + p2Hexbits(info) + p2Hexbits(parity) + IntArray(u)
            val fixed = if (cw.size == 63) rs63Decode(cw, List(u) { 63 - u + it }) else -1
            if (fixed < 0) { stats.macBad++; return }
            val fx = ArrayList<Int>(); for (i in s0 until s0 + info.size / 6) for (k in 5 downTo 0) fx.add((cw[i] shr k) and 1)
            val fa = fx.toIntArray()
            if (p2Crc12(fa, n) != crcOf(fa)) { stats.macBad++; return }
            info = fa; stats.macFixed++
        }
        stats.macOk++
        val bytes = IntArray(n shr 3) { i -> var v = 0; for (k in 0 until 8) v = v * 2 + info[8 * i + k]; v }
        onMac(P2Mac(lch, slot, bytes, bytes[0] shr 5, (bytes[0] shr 2) and 7, facch))
    }
    /** The seed: the candidate whose sequence leaves most voice frames with a clean first Golay word, twice running. */
    private fun findSeed(st: Int, slot: Int, at: IntArray) {
        for ((i, s) in seeds.withIndex()) {
            val k = p2Sequence(s.wacn, s.sysId, s.nac)
            var clean = 0
            for (f in at) if (c0Clean(bits(st, f, 36, true, slot, k))) clean++
            if (2 * clean >= at.size) {
                val v = (seedVotes[i] ?: 0) + 1; seedVotes[i] = v
                if (v >= 2) { seed = s; seq = k; seedVotes.clear(); onSeed(s); return }
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------ RS over GF(64)
private val P2GE = IntArray(128)
private val P2GL = IntArray(64)
private val p2GfInit = run {
    var x = 1
    for (i in 0 until 63) { P2GE[i] = x; P2GL[x] = i; x = x shl 1; if ((x and 0x40) != 0) x = x xor 0x43 }
    for (i in 63 until 128) P2GE[i] = P2GE[i - 63]
    true
}
private fun p2gm(a: Int, b: Int) = if (a != 0 && b != 0) P2GE[P2GL[a] + P2GL[b]] else 0
private fun p2gInv(a: Int) = P2GE[(63 - P2GL[a]) % 63]
private fun p2PolyMul(a: IntArray, b: IntArray): IntArray {
    val o = IntArray(a.size + b.size - 1)
    for (i in a.indices) if (a[i] != 0) for (j in b.indices) o[i + j] = o[i + j] xor p2gm(a[i], b[j])
    return o
}
private fun p2PolyEval(p: IntArray, x: Int): Int { var v = 0; for (i in p.indices.reversed()) v = p2gm(v, x) xor p[i]; return v }

/**
 * Errors-and-erasures decoding of the (63,35,29) mother code (BBAC Annex A: GF(64) from x^6 + x + 1, generator roots
 * a^1 to a^28). [cw] is the 63-hexbit word, highest power first; [eras] the indices of erased (punctured) hexbits.
 * Corrects in place; returns the number of hexbits changed, or -1 past correcting.
 */
fun rs63Decode(cw: IntArray, eras: List<Int>): Int {
    check(p2GfInit)
    val n = 63; val r0 = 28
    fun deg(i: Int) = n - 1 - i
    val s = IntArray(r0)
    for (j in 1..r0) { var v = 0; for (i in 0 until n) v = p2gm(v, P2GE[j]) xor cw[i]; s[j - 1] = v }
    if (s.all { it == 0 }) return 0
    var gam = intArrayOf(1); for (e in eras) gam = p2PolyMul(gam, intArrayOf(1, P2GE[deg(e) % 63]))
    // modified syndromes T = S * Gamma mod x^R, then Berlekamp-Massey from the erasure count on
    val tt = p2PolyMul(s, gam).copyOf(r0); val rho = eras.size
    var lam = intArrayOf(1); var bb = intArrayOf(1); var l = 0
    for (r in rho until r0) {
        var d = 0; var i = 0
        while (i <= l && i < lam.size) { d = d xor p2gm(lam[i], if (r - i in tt.indices) tt[r - i] else 0); i++ }
        val xB = intArrayOf(0) + bb
        if (d == 0) { bb = xB; continue }
        val nl = IntArray(max(lam.size, xB.size)) { k -> lam.getOrElse(k) { 0 } xor p2gm(d, xB.getOrElse(k) { 0 }) }
        if (2 * l <= r - rho) { val di = p2gInv(d); bb = IntArray(lam.size) { p2gm(lam[it], di) }; l = r - rho + 1 - l } else bb = xB
        lam = nl
    }
    val psi = p2PolyMul(lam, gam); val om = p2PolyMul(s, psi).copyOf(r0)
    val dpsi = IntArray(psi.size - 1) { val i = it + 1; if ((i and 1) != 0) psi[i] else 0 }
    var fixed = 0; var roots = 0
    for (i in 0 until n) {
        val x = P2GE[deg(i) % 63]; val xi = p2gInv(x)
        if (p2PolyEval(psi, xi) != 0) continue
        roots++
        val den = p2PolyEval(dpsi, xi); if (den == 0) return -1
        val mag = p2gm(p2PolyEval(om, xi), p2gInv(den))
        if (mag != 0) { cw[i] = cw[i] xor mag; fixed++ }
    }
    var degPsi = psi.size - 1; while (degPsi > 0 && psi[degPsi] == 0) degPsi--
    if (roots != degPsi || 2 * (degPsi - rho) + rho > r0) return -1
    for (j in 1..r0) { var v = 0; for (i in 0 until n) v = p2gm(v, P2GE[j]) xor cw[i]; if (v != 0) return -1 }
    return fixed
}
private fun p2Hexbits(b: IntArray): IntArray {
    val o = IntArray(b.size / 6)
    for (q in o.indices) { var v = 0; for (k in 0 until 6) v = v * 2 + b[6 * q + k]; o[q] = v }
    return o
}

/** A MAC PDU's messages (BBAC 8.3): each starts with B1 B2 and a 6-bit MCO; lengths from BBAC Table 8-2. */
class P2Msg(val b: Int, val mco: Int, val bytes: IntArray, val name: String)
private val P2_LEN = mapOf(
    "0:1" to 7, "0:33" to 14, "0:2" to 8, "0:34" to 15, "0:5" to 16, "0:37" to 15, "0:48" to 5, "0:49" to 7,
    "1:2" to 9, "1:59" to 11, "1:58" to 9, "1:60" to 9, "1:61" to 9, "1:52" to 9, "1:51" to 9,
    "3:3" to 8, "3:59" to 13, "3:58" to 11, "3:60" to 11,
)
private val P2_NAMES = mapOf(
    "0:1" to "GROUP VOICE CHANNEL USER", "0:33" to "GROUP VOICE CHANNEL USER (EXTENDED)", "0:2" to "UNIT TO UNIT VOICE CHANNEL USER", "0:34" to "UNIT TO UNIT VOICE CHANNEL USER (EXTENDED)",
    "0:5" to "GROUP VOICE CHANNEL GRANT UPDATE MULTIPLE", "0:37" to "GROUP VOICE CHANNEL GRANT UPDATE MULTIPLE (EXPLICIT)", "0:48" to "POWER CONTROL SIGNAL QUALITY", "0:49" to "MAC RELEASE",
    "1:2" to "GROUP VOICE CHANNEL GRANT UPDATE", "1:59" to "NETWORK STATUS BROADCAST", "1:58" to "RFSS STATUS BROADCAST", "1:60" to "ADJACENT STATUS BROADCAST", "1:61" to "IDENTIFIER UPDATE",
    "1:52" to "IDENTIFIER UPDATE VHF/UHF", "1:51" to "IDENTIFIER UPDATE TDMA", "3:3" to "GROUP VOICE CHANNEL GRANT UPDATE (EXPLICIT)",
)
fun p2Messages(pdu: IntArray): List<P2Msg> {
    val out = ArrayList<P2Msg>()
    var i = 1
    while (i < pdu.size) {
        val b = pdu[i] shr 6; val mco = pdu[i] and 0x3f; val key = "$b:$mco"
        if (b == 0 && mco == 0) break   // null information: the rest is fill
        val len = P2_LEN[key] ?: (if (b == 2 && i + 1 < pdu.size) pdu[i + 1] and 0x3f else 0)
        if (len == 0 || i + len > pdu.size) break
        out.add(P2Msg(b, mco, pdu.copyOfRange(i, i + len), P2_NAMES[key] ?: (if (b == 2) "MANUFACTURER" else "MCO $b:${"%02X".format(mco)}")))
        i += len
    }
    return out
}
data class P2Ptt(val mi: String, val algId: Int, val keyId: Int, val src: Int, val group: Int)
data class P2EndPtt(val nac: Int, val src: Int, val group: Int)
/** MAC_PTT and MAC_END_PTT fields (BBAC 8.2.1, 8.2.2; octet positions derived from our recording). */
fun p2Ptt(pdu: IntArray): P2Ptt {
    val mi = StringBuilder(); for (i in 1..9) mi.append("%02x".format(pdu[i]))
    return P2Ptt(mi.toString(), pdu[10], (pdu[11] shl 8) or pdu[12], (pdu[13] shl 16) or (pdu[14] shl 8) or pdu[15], (pdu[16] shl 8) or pdu[17])
}
fun p2EndPtt(pdu: IntArray): P2EndPtt =
    P2EndPtt(((pdu[1] shl 8) or pdu[2]) and 0xfff, (pdu[13] shl 16) or (pdu[14] shl 8) or pdu[15], (pdu[16] shl 8) or pdu[17])
