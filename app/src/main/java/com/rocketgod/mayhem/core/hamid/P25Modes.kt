package com.rocketgod.mayhem.core.hamid

import com.rocketgod.mayhem.core.fleet.NxdnFramer
import com.rocketgod.mayhem.core.fleet.NxdnTraffic
import com.rocketgod.mayhem.core.fleet.P2Rx
import com.rocketgod.mayhem.core.fleet.P2Seed
import com.rocketgod.mayhem.core.fleet.p2EndPtt
import com.rocketgod.mayhem.core.fleet.p2Messages
import com.rocketgod.mayhem.core.fleet.p2Ptt
import com.rocketgod.mayhem.core.ham.AmbeDecoder
import com.rocketgod.mayhem.core.ham.ImbeDecoder
import com.rocketgod.mayhem.core.ham.P25Decoder
import com.rocketgod.mayhem.core.ham.rW
import com.rocketgod.mayhem.core.ham.rX
import com.rocketgod.mayhem.core.ham.rY
import com.rocketgod.mayhem.core.ham.rZ
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sign
import kotlin.math.sin

/**
 * The HAM+ identity decoders for P25 Phase 1, P25 Phase 2, NXDN (48 and 96) and dPMR, and the face HamIdChannel sees.
 * The same as the web's dsp/hamid/voice.ts, p25id.ts, p25p2id.ts, nxdnid.ts, dpmr.ts and p25modes.ts (the standards
 * each follows and the choices made are described there).
 */

// ------------------------------------------------------------------------------------------------ voice
const val HAMID_VOICE_GAIN = 7.0 / 32768 / 3

/** AMBE+2 half rate, one 72-bit frame in the order DMR (and Phase 2, NXDN EHR, dPMR) sends it; 160 samples at 8 kHz. */
class AmbeStream {
    private val d = AmbeDecoder().also { it.outGain = HAMID_VOICE_GAIN }
    private val fr = Array(4) { IntArray(24) }
    var frames = 0; private set
    fun reset() { d.reset(); frames = 0 }
    fun decode(bits: IntArray): FloatArray {
        frames++
        if (bits.isEmpty()) return d.erase().copyOf()
        for (row in fr) row.fill(0)
        for (i in 0 until 36) { fr[rW[i]][rX[i]] = bits[2 * i]; fr[rY[i]][rZ[i]] = bits[2 * i + 1] }
        return d.decode(fr).copyOf()
    }
}
/** IMBE, one 144-bit frame as sent (P25 Phase 1, NXDN EFR). */
class ImbeStream {
    private val d = ImbeDecoder().also { it.outGain = HAMID_VOICE_GAIN }
    var frames = 0; private set
    fun reset() { d.reset(); frames = 0 }
    fun decode(bits: IntArray): FloatArray { frames++; return if (bits.size < 144) d.erase().copyOf() else d.decodeVoice(bits.copyOf(144)).copyOf() }
}
private fun hexOf(b: IntArray) = b.joinToString("") { "%02X".format(it) }

// ------------------------------------------------------------------------------------------------ P25 Phase 1
data class P25Id(
    var nac: Int = -1, var tg: Int = 0, var src: Int = 0, var group: Boolean = true, var emergency: Boolean = false,
    var encrypted: Boolean = false, var algId: Int = -1, var keyId: Int = 0,
    var lcf: Int = -1, var mfid: Int = 0, var lc: String = "",
    var frames: Int = 0, var lcs: Int = 0, var voiceFrames: Int = 0, var calls: Int = 0,
    var inverted: Boolean = false, var lastSym: Long = -1,
)
/** The P25 frame sync 5575F5FF77FF as signs (dibit 01 +, 11 -). */
private val P25_SYNC = IntArray(24).also { a -> var k = 0; for (c in "5575F5FF77FF") { val v = c.digitToInt(16); a[k++] = if ((v and 8) != 0) -1 else 1; a[k++] = if ((v and 2) != 0) -1 else 1 } }

class P25Identity {
    var onAudio: (FloatArray) -> Unit = {}
    var id = P25Id(); private set
    private val dec = P25Decoder()
    private val voice = ImbeStream()
    private val ring = FloatArray(24); private var rp = 0
    private var t = 0L; private var sign = 1.0; private var framesSeen = 0; private var open = false
    init {
        dec.onVoice = { bits -> if (!id.encrypted) { id.voiceFrames++; onAudio(voice.decode(bits)) } }
        dec.onLc = { lc(it) }
        dec.onHdu = { h -> open = false; start(); id.src = 0; id.algId = h.algId; id.keyId = h.keyId; id.mfid = h.mfid; if (h.tg != 0) id.tg = h.tg; id.encrypted = h.algId != 0x80 && h.algId != 0; id.lastSym = t; voice.reset() }
        dec.onEs = { es -> id.algId = es.algId; id.keyId = es.keyId; id.encrypted = es.algId != 0x80 && es.algId != 0 }
    }
    fun reset() { id = P25Id(); dec.reset(); voice.reset(); ring.fill(0f); rp = 0; t = 0; sign = 1.0; framesSeen = 0; open = false }
    private fun start() { if (!open) { open = true; id.calls++; id.encrypted = false; id.algId = -1; id.keyId = 0; id.emergency = false } }
    val checked: Int get() = id.frames

    fun pushSymbol(s: Double) {
        t++
        ring[rp] = s.toFloat(); rp = (rp + 1) % 24
        var c = 0.0; var a = 0.0
        for (k in 0 until 24) { val x = ring[(rp + k) % 24].toDouble(); c += x * P25_SYNC[k]; a += abs(x) }
        // while a frame is being read, a sync must be cleaner and of the same polarity (voice data now and then comes near it)
        val locked = dec.status(t).locked
        if (a > 24 * 1.8 && (if (locked) c * sign > 0 && abs(c) / a > 0.95 else abs(c) / a > 0.86)) { sign = (if (c > 0) 1.0 else -1.0) * 3 * 24 / a; dec.sync(t); return }
        if (!locked) return
        val x = s * sign
        dec.push(if (x > 2) 1 else if (x > 0) 0 else if (x > -2) 2 else 3, t)
        val now = dec.status(t)
        if (now.frames != framesSeen) {
            framesSeen = now.frames
            id.frames = now.frames; id.nac = now.nac; id.inverted = sign < 0; id.lastSym = t
            if (now.duid == 0x3 || now.duid == 0xf) { voice.reset(); open = false }
        }
    }
    private fun lc(b: IntArray) {
        val lcf = b[0] and 0x3f; val svc = b[2]
        if (lcf == 0x00 || lcf == 0x03) { val src = (b[6] shl 16) or (b[7] shl 8) or b[8]; if (id.src != 0 && src != id.src) open = false; start() }
        id.lcs++; id.lcf = lcf; id.mfid = b[1]; id.lc = hexOf(b); id.lastSym = t
        if ((b[0] and 0x80) != 0) id.encrypted = true
        if (lcf == 0x00 || lcf == 0x03) {
            id.emergency = (svc and 0x80) != 0
            if ((svc and 0x40) != 0) id.encrypted = true
            id.src = (b[6] shl 16) or (b[7] shl 8) or b[8]
            id.tg = if (lcf == 0) (b[4] shl 8) or b[5] else (b[3] shl 16) or (b[4] shl 8) or b[5]
            id.group = lcf == 0
        }
    }
}

// ------------------------------------------------------------------------------------------------ P25 Phase 2
data class P2Slot(
    val lch: Int, var tg: Int = 0, var src: Int = 0, var group: Boolean = true, var emergency: Boolean = false,
    var encrypted: Boolean = false, var algId: Int = -1, var keyId: Int = 0,
    var activity: String = "", var calls: Int = 0, var voiceFrames: Int = 0, var lastSym: Long = -1,
)
data class P2Id(var nac: Int = -1, var wacn: Int = -1, var sysId: Int = -1, var seeded: String = "", val slots: List<P2Slot> = listOf(P2Slot(0), P2Slot(1)), var pairs: Int = 0, var macs: Int = 0) {
    fun deep() = copy(slots = slots.map { it.copy() })
}
class P2NetStatus(val wacn: Int, val sysId: Int, val nac: Int)
/** NETWORK STATUS BROADCAST, abbreviated (11 octets): LRA, WACN (20 bits), system ID (12), channel, service class, color code (12). */
fun p2NetStatus(b: IntArray): P2NetStatus? = if (b.size < 11) null else P2NetStatus((b[2] shl 12) or (b[3] shl 4) or (b[4] shr 4), ((b[4] and 15) shl 8) or b[5], ((b[9] and 15) shl 8) or b[10])
private const val P2_HOLD = 18

class P25P2Identity(val fs: Double) {
    var onAudio: (Int, FloatArray) -> Unit = { _, _ -> }
    var id = P2Id(); private set
    private var rx: P2Rx
    private val voice = arrayOf(AmbeStream(), AmbeStream())
    private var user: List<P2Seed> = emptyList(); private val heard = ArrayList<P2Seed>()
    private var ph = 0.0; private var re = FloatArray(0); private var im = FloatArray(0)
    private val held = arrayOf(ArrayList<IntArray>(), ArrayList<IntArray>())
    init { rx = make() }

    private fun make(): P2Rx {
        val r = P2Rx(fs)
        r.onSync = { paired -> if (paired) id.pairs++ }
        r.onSeed = { s -> id.seeded = s.sys; id.wacn = s.wacn; id.sysId = s.sysId; id.nac = s.nac }
        r.onVoice = voice@{ lch0, f ->
            val lch = lch0 and 1; val sl = id.slots[lch]
            if (sl.activity != "voice") { if (f.isEmpty()) return@voice; start(lch) }
            sl.lastSym = r.symbols
            if (sl.encrypted) return@voice
            if (sl.algId < 0) { held[lch].add(f.copyOf()); if (held[lch].size < P2_HOLD) return@voice }
            play(lch)
            if (sl.algId >= 0) frame(lch, f)
        }
        r.onEss = { lch, e -> val sl = id.slots[lch and 1]; sl.algId = e.algId; sl.keyId = e.keyId; sl.encrypted = e.algId != 0x80 && e.algId != 0; settle(lch and 1) }
        r.onMac = { m ->
            val lch = m.lch and 1; val sl = id.slots[lch]; id.macs++; sl.lastSym = r.symbols
            if (m.opcode == 1) {
                val p = p2Ptt(m.bytes)
                if (sl.activity != "voice") start(lch)
                sl.src = p.src; sl.tg = p.group; sl.group = true; sl.algId = p.algId; sl.keyId = p.keyId; sl.encrypted = p.algId != 0x80 && p.algId != 0
                settle(lch)
            } else if (m.opcode == 2) {
                val e = p2EndPtt(m.bytes)
                id.nac = e.nac; sl.activity = ""; held[lch].clear()
                if (e.src != 0 && e.src != 0xffffff) sl.src = e.src
            } else for (x in p2Messages(m.bytes)) {
                val b = x.bytes
                if (x.b == 0 && (x.mco == 1 || x.mco == 2) && m.opcode == 4) {
                    val so = b[1]
                    sl.emergency = (so and 0x80) != 0; if ((so and 0x40) != 0) { sl.encrypted = true; settle(lch) }
                    if (x.mco == 1 && b.size >= 7) { sl.group = true; sl.tg = (b[2] shl 8) or b[3]; sl.src = (b[4] shl 16) or (b[5] shl 8) or b[6] }
                    if (x.mco == 2 && b.size >= 8) { sl.group = false; sl.tg = (b[2] shl 16) or (b[3] shl 8) or b[4]; sl.src = (b[5] shl 16) or (b[6] shl 8) or b[7] }
                } else if (x.b == 1 && x.mco == 0x3b) {
                    val n = p2NetStatus(b)
                    if (n != null && heard.none { it.wacn == n.wacn && it.sysId == n.sysId && it.nac == n.nac }) {
                        heard.add(P2Seed(n.wacn, n.sysId, n.nac, "heard"))
                        if (id.wacn < 0) { id.wacn = n.wacn; id.sysId = n.sysId; id.nac = n.nac }
                        rx.setSeeds(user + heard)
                    }
                }
            }
        }
        r.setSeeds(user + heard)
        return r
    }
    private fun start(lch: Int) { val sl = id.slots[lch]; sl.activity = "voice"; sl.calls++; sl.algId = -1; sl.keyId = 0; sl.encrypted = false; sl.emergency = false; voice[lch].reset(); held[lch].clear() }
    private fun frame(lch: Int, f: IntArray) { val sl = id.slots[lch]; if (f.isNotEmpty()) sl.voiceFrames++; onAudio(lch, voice[lch].decode(f)) }
    private fun play(lch: Int) { val h = ArrayList(held[lch]); held[lch].clear(); if (!id.slots[lch].encrypted) for (f in h) frame(lch, f) }
    private fun settle(lch: Int) { if (id.slots[lch].encrypted) held[lch].clear() else play(lch) }
    /** Seeds the user knows for this channel (WACN, system ID, NAC), tried before any heard. */
    fun setSeeds(seeds: List<Triple<Int, Int, Int>>) { user = seeds.map { P2Seed(it.first, it.second, it.third, "set") }; rx.setSeeds(user + heard) }
    fun reset() { id = P2Id(); heard.clear(); rx = make(); voice.forEach { it.reset() }; ph = 0.0; held.forEach { it.clear() } }
    val checked: Int get() = id.macs + if (id.seeded.isNotEmpty()) 1 else 0

    fun push(disc: FloatArray, n: Int) {
        if (re.size < n) { re = FloatArray(n); im = FloatArray(n) }
        var p = ph
        for (k in 0 until n) { p += disc[k]; if (p > PI) p -= 2 * PI else if (p < -PI) p += 2 * PI; re[k] = cos(p).toFloat(); im[k] = sin(p).toFloat() }
        ph = p
        rx.push(re, im, n)
    }
}

// ------------------------------------------------------------------------------------------------ NXDN
data class NxdnId(
    var baud: Int = 0, var ran: Int = -1, var kind: String = "", var src: Int = 0, var dst: Int = 0, var group: Boolean = true, var callType: Int = -1,
    var emergency: Boolean = false, var cipher: Int = 0, var keyId: Int = 0, var voiceOpt: Int = 0, var typeD: Boolean = false,
    var activity: String = "", var calls: Int = 0, var voiceFrames: Int = 0, var lastSym: Long = -1, var checked: Int = 0,
)
private val NX_FSW = intArrayOf(-3, 1, -3, 3, -3, -3, 3, 3, -1, 3)

class NxdnIdentity {
    var onAudio: (FloatArray) -> Unit = {}
    var id = NxdnId(); private set
    private inner class Rate(val baud: Int) {
        val framer = NxdnFramer()
        val ambe = AmbeStream(); val imbe = ImbeStream()
        var checked = 0; var t = 0L
        private val ring = FloatArray(10); private var rp = 0; private var g = 1.0
        fun push(s: Double) {
            t++
            ring[rp] = s.toFloat(); rp = (rp + 1) % 10
            var c = 0.0; var a = 0.0; for (k in 0 until 10) { val x = ring[(rp + k) % 10].toDouble(); c += x * NX_FSW[k]; a += abs(x) }
            val fsw = a > 0 && c / (3 * a) > 0.85
            framer.push((if (fsw) s else s * g).toFloat())
            if (fsw) g = 26 / a
        }
    }
    private lateinit var r48: Rate; private lateinit var r96: Rate
    init { build() }
    private fun build() { r48 = Rate(2400); r96 = Rate(4800); for (r in listOf(r48, r96)) r.framer.onTraffic = { traffic(r, it) } }
    fun reset() { id = NxdnId(); build() }
    val checked: Int get() = id.checked
    fun pushSymbol24(s: Double) = r48.push(s)
    fun pushSymbol48(s: Double) = r96.push(s)

    private fun traffic(r: Rate, t: NxdnTraffic) {
        if (!r.framer.locked) return
        if (id.baud != r.baud) { if (id.baud != 0 && r.checked < 2) return; id.baud = r.baud }
        r.checked++; id.checked++; id.lastSym = r.t * (4800 / r.baud)
        if (t.ran >= 0) id.ran = t.ran
        id.kind = if (t.typeD) "Type-D" else if (t.rf == 2) "conventional" else "trunked"
        t.scch?.let { x ->
            id.typeD = true
            if (x.info == 3 && x.src >= 0) { if (x.src != id.src) start(r); id.src = x.src }
            if ((x.info == 4 || x.info == 2) && x.kind == "busy" && x.dst >= 0) { id.dst = x.dst; id.group = x.group }
            if (x.info == 1 && x.cipher >= 0) { id.cipher = x.cipher; id.keyId = max(0, x.keyId) }
        }
        for (m in t.msgs) {
            if (m.type == 0x01 && m.dst != null) {
                if (m.src != id.src || id.activity != "voice") start(r)
                id.src = m.src ?: 0; id.dst = m.dst!!; id.group = m.group; id.callType = m.callType ?: -1; id.emergency = m.emergency
                id.cipher = m.cipher ?: 0; id.keyId = m.keyId ?: 0; id.voiceOpt = m.voiceOpt ?: 0; id.typeD = m.typeD || t.typeD
            } else if (m.type == 0x08 || m.type == 0x07 || m.type == 0x11) id.activity = ""
        }
        val halves = t.halves.filterNotNull()
        if (halves.isEmpty()) return
        if (id.activity != "voice") start(r)
        if (id.cipher != 0) return
        val efr = (id.voiceOpt and 7) == 3
        for (h in halves) {
            if (efr) { id.voiceFrames++; onAudio(r.imbe.decode(h)) }
            else for (f in listOf(h.copyOfRange(0, 72), h.copyOfRange(72, 144))) { id.voiceFrames++; onAudio(r.ambe.decode(f)) }
        }
    }
    private fun start(r: Rate) { id.activity = "voice"; id.calls++; r.ambe.reset(); r.imbe.reset() }
}

// ------------------------------------------------------------------------------------------------ dPMR
private fun dpLevels(hex: String): FloatArray { val o = ArrayList<Float>(); for (c in hex) { val v = c.digitToInt(16); for (d in intArrayOf(v shr 2, v and 3)) o.add(if (d == 1) 3f else if (d == 0) 1f else if (d == 2) -1f else -3f) }; return o.toFloatArray() }
val DPMR_FS1 = dpLevels("57FF5F75D577"); val DPMR_FS2 = dpLevels("5FF77D"); val DPMR_FS3 = dpLevels("7DDFF5"); val DPMR_FS4 = dpLevels("FD55F5DF7FDD")
/** The 6 check bits of a color code value (Table 6.1: 22 XOR one word per value bit). */
fun dpmrCcCheck(v: Int): Int { val b = intArrayOf(48, 17, 35, 54, 28, 56); var r = 22; for (k in 0 until 6) if ((v and (1 shl k)) != 0) r = r xor b[k]; return r }
fun dpmrCcLevels(v: Int): FloatArray { val c = (v shl 6) or dpmrCcCheck(v); return FloatArray(12) { if (((c shr (11 - it)) and 1) != 0) -3f else 3f } }
private val CC_LV = Array(64) { dpmrCcLevels(it) }
private val GROUP_A = setOf(5, 6, 7, 0, 1, 2, 3, 12, 13, 14, 15, 8, 9, 10, 11, 20)
/** X^9 + X^5 + 1, S9..S1 preset to ones, output S1, S1 + S5 fed to S9 (7.4). */
fun dpmrScrambler(n: Int): IntArray { val s = intArrayOf(0, 1, 1, 1, 1, 1, 1, 1, 1, 1); val o = IntArray(n); for (k in 0 until n) { val out = s[1]; val fb = s[1] xor s[5]; o[k] = out; for (i in 1 until 9) s[i] = s[i + 1]; s[9] = fb }; return o }
private val DP_SCR = dpmrScrambler(120)
private val DP_HAM = intArrayOf(0b1110, 0b0111, 0b1010, 0b0101, 0b1011, 0b1100, 0b0110, 0b0011)
fun dpmrHamming(d: Int): Int { var p = 0; for (i in 0 until 8) if ((d and (0x80 shr i)) != 0) p = p xor DP_HAM[i]; return (d shl 4) or p }
fun dpmrHammingDecode(w: Int): Int {
    val d = (w shr 4) and 0xff; val syn = (dpmrHamming(d) xor w) and 15
    if (syn == 0) return d
    for (i in 0 until 8) if (syn == DP_HAM[i]) return d xor (0x80 shr i)
    if (syn == 1 || syn == 2 || syn == 4 || syn == 8) return d
    return -1
}
fun dpmrCrc(bits: IntArray, n: Int, width: Int, poly: Int): Int { val mask = (1 shl width) - 1; var r = 0; for (i in 0 until n) { val fb = ((r shr (width - 1)) and 1) xor bits[i]; r = (r shl 1) and mask; if (fb != 0) r = r xor poly }; return r }
fun dpmrCrc7(b: IntArray, n: Int) = dpmrCrc(b, n, 7, 0x09)
fun dpmrCrc8(b: IntArray, n: Int) = dpmrCrc(b, n, 8, 0x07)
private fun dpField(b: IntArray, at: Int, n: Int): Int { var v = 0; for (k in 0 until n) v = v * 2 + b[at + k]; return v }
/** One coded field (descrambled, de-interleaved, Hamming words decoded): the data bits, or null if a word fails. */
fun dpmrField(rx: IntArray, cols: Int): IntArray? {
    val coded = IntArray(12 * cols)
    for (r in 0 until 12) for (c in 0 until cols) coded[c * 12 + r] = rx[r * cols + c] xor DP_SCR[r * cols + c]
    val out = IntArray(8 * cols)
    for (w in 0 until cols) { val d = dpmrHammingDecode(dpField(coded, 12 * w, 12)); if (d < 0) return null; for (i in 0 until 8) out[8 * w + i] = (d shr (7 - i)) and 1 }
    return out
}
/** Annex A, B2 reversed: seven characters ('*' for 10 in the last four), or "" when the address is none. */
fun dpmrDial(id: Int): String {
    var r = id; val k = IntArray(7); val m = intArrayOf(1464100, 146410, 14641, 1331, 121, 11, 1)
    for (i in 0 until 7) { k[i] = r / m[i]; r %= m[i] }
    if (k[0] > 9 || k[1] > 9 || k[2] > 9 || (3 until 7).any { k[it] > 10 }) return ""
    return (0 until 7).joinToString("") { if (it >= 3 && k[it] == 10) "*" else k[it].toString() }
}
data class DpmrId(
    var cc: Int = -1, var ccGroup: String = "", var called: Int = -1, var own: Int = -1, var calledText: String = "", var ownText: String = "", var group: Boolean = false,
    var headerType: Int = -1, var commMode: Int = -1, var format: Int = -1,
    var activity: String = "", var calls: Int = 0, var voiceFrames: Int = 0, var headers: Int = 0, var frames: Int = 0,
    var slowData: String = "", var position: Position? = null, var inverted: Boolean = false, var lastSym: Long = -1,
)
private fun dpIdText(v: Int) = if ((v ushr 16) <= 0xff && (v and 0xffff) == 0xffff) "COMMON ${v ushr 16}" else dpmrDial(v).ifEmpty { v.toString() }
private const val DP_H = 1024

class DpmrIdentity {
    var onAudio: (FloatArray) -> Unit = {}
    var id = DpmrId(); private set
    private class Job(val kind: Int, val at: Long, val sign: Double, val fly: Int)   // kind 0 header, 1 frame, 2 end
    private val hist = FloatArray(DP_H); private var t = 0L
    private var jobs = ArrayList<Job>()
    private var lastFrame = -1_000_000_000L
    private val voice = AmbeStream()
    private val ids = IntArray(4) { -1 }; private val idAt = LongArray(4) { -1_000_000_000L }
    private val lines = LineBuffer()
    var checked = 0; private set

    fun reset() { id = DpmrId(); hist.fill(0f); t = 0; jobs = ArrayList(); lastFrame = -1_000_000_000L; voice.reset(); ids.fill(-1); idAt.fill(-1_000_000_000L); lines.reset(); checked = 0 }
    private fun at(i: Long): Double = hist[(i and (DP_H - 1).toLong()).toInt()].toDouble()
    private fun corr(pat: FloatArray): Pair<Double, Double> {
        var c = 0.0; var a = 0.0; val n = pat.size
        for (k in 0 until n) { val x = at(t - n + k); c += x * pat[k]; a += abs(x) }
        return if (a > n * 0.5) Pair(c / (3 * a), 3.0 * n / a) else Pair(0.0, 1.0)
    }
    private fun bits(from: Long, nsym: Int, sign: Double): IntArray {
        val o = IntArray(2 * nsym)
        for (k in 0 until nsym) { val x = sign * at(from + k); o[2 * k] = if (x < 0) 1 else 0; o[2 * k + 1] = if (abs(x) > 2) 1 else 0 }
        return o
    }
    private fun queue(kind: Int, at: Long, sign: Double, fly: Int = 0) {
        if (kind == 1 && jobs.any { it.kind == 1 && abs(it.at - at) <= 2 }) return
        if (kind == 1 && abs(at - lastFrame) <= 2) return
        jobs.add(Job(kind, at, sign, fly))
    }
    fun pushSymbol(s: Double) {
        hist[(t and (DP_H - 1).toLong()).toInt()] = s.toFloat(); t++
        val f1 = corr(DPMR_FS1); val f2 = corr(DPMR_FS2); val f3 = corr(DPMR_FS3)
        if (abs(f1.first) > 0.9) queue(0, t, sign(f1.first) * f1.second)
        else if (abs(f2.first) > 0.92) queue(1, t - 12, sign(f2.first) * f2.second)
        else if (abs(f3.first) > 0.92) queue(2, t, sign(f3.first) * f3.second)
        val due = jobs.filter { t >= it.at + when (it.kind) { 0 -> 132; 2 -> 36; else -> 192 } }
        if (due.isEmpty()) return
        jobs = ArrayList(jobs.filter { it !in due })
        for (j in due.sortedBy { it.at }) when (j.kind) { 0 -> header(j.at, j.sign); 2 -> end(j.at, j.sign); else -> frame(j.at, j.sign, j.fly) }
    }
    private fun cc(from: Long, sign: Double): Int {
        var best = -1; var bc = 0.0
        for (v in 0 until 64) { var c = 0.0; var a = 0.0; for (k in 0 until 12) { val x = sign(sign) * at(from + k); c += x * CC_LV[v][k]; a += abs(x) }; val r = if (a > 0) c / (3 * a) else 0.0; if (r > bc) { bc = r; best = v } }
        return if (bc > 0.8) best else -1
    }
    private fun setCc(v: Int) { if (v < 0) return; id.cc = v; id.ccGroup = if (v in GROUP_A) "A" else if (v >= 48) "B" else "" }
    private fun header(at: Long, sign: Double) {
        var hi: IntArray? = null
        for (from in longArrayOf(at, at + 72)) { val d = dpmrField(bits(from, 60, sign), 10); if (d != null && dpmrCrc8(d, 72) == dpField(d, 72, 8)) { hi = d; break } }
        if (hi == null) return
        checked++; id.inverted = sign < 0; id.headers++; id.lastSym = t
        setCc(cc(at + 60, sign))
        id.headerType = dpField(hi, 0, 4); id.called = dpField(hi, 4, 24); id.own = dpField(hi, 28, 24); id.commMode = dpField(hi, 52, 3); id.format = dpField(hi, 55, 4)
        id.calledText = dpIdText(id.called); id.ownText = dpIdText(id.own); id.group = id.calledText.contains('*') || id.calledText.startsWith("COMMON")
        if (id.headerType == 0 || id.headerType == 5 || id.headerType == 6) { start(); queue(1, at + 132, sign, -1) }
    }
    private fun start() { id.activity = "voice"; id.calls++; voice.reset(); lines.reset(); id.slowData = ""; ids.fill(-1) }
    private fun frame(at: Long, sign0: Double, fly: Int) {
        var a = 0.0; for (k in 0 until 12) a += abs(at(at + k))
        val sign = if (a > 0) sign(sign0) * 36 / a else sign0
        val d = dpmrField(bits(at + 12, 36, sign), 6)
        val ok = d != null && dpmrCrc7(d, 41) == dpField(d, 41, 7)
        if (!ok) { if (id.activity == "voice" && fly < 4) queue(1, at + 192, sign, max(0, fly) + 1); return }
        val chained = fly != 0 || abs(at - lastFrame - 192) <= 2
        lastFrame = at
        if (!chained) { queue(1, at + 192, sign); return }
        checked++; id.inverted = sign < 0; id.frames++; id.lastSym = t
        val fn = dpField(d!!, 0, 2); val part = dpField(d, 2, 12); val mode = dpField(d, 14, 3)
        id.commMode = mode; id.format = dpField(d, 17, 4)
        if (fn == 1 || fn == 3) setCc(cc(at, sign))
        if (id.activity != "voice") start()
        ids[fn] = part; idAt[fn] = at
        if (fn == 1 && ids[0] >= 0 && abs(at - idAt[0] - 192) <= 2) { id.called = (ids[0] shl 12) or part; id.calledText = dpIdText(id.called); id.group = id.calledText.contains('*') || id.calledText.startsWith("COMMON") }
        if (fn == 3 && ids[2] >= 0 && abs(at - idAt[2] - 192) <= 2) { id.own = (ids[2] shl 12) or part; id.ownText = dpIdText(id.own) }
        if (mode == 1) {
            val txt = StringBuilder()
            for (o in intArrayOf(24, 33)) { val b = dpField(d, o, 8); if (b in 32..126) txt.append(b.toChar()) else if (b == 13 || b == 10) txt.append('\n') }
            if (txt.isNotEmpty()) {
                id.slowData = (id.slowData + txt).takeLast(64)
                for (line in lines.push(txt.toString())) { val p = parsePositionLine(line); if (p != null) { p.source = "dpmr-sld"; id.position = p } }
            }
        }
        val dp = dpField(d, 28, 2)
        if (mode == 0 || mode == 1 || (mode == 5 && dp != 3)) {
            val tch = bits(at + 48, 144, sign)
            for (k in 0 until 4) { id.voiceFrames++; onAudio(voice.decode(tch.copyOfRange(72 * k, 72 * k + 72))) }
        }
        queue(1, at + 192, sign)
    }
    private fun end(at: Long, sign: Double) {
        if (id.activity != "voice") return
        val b = bits(at, 36, sign); val sc = dpmrScrambler(72)
        for (half in intArrayOf(0, 36)) {
            val w = IntArray(24); var good = true
            for (k in 0 until 3) {
                var v = 0; for (i in 0 until 12) v = v * 2 + (b[half + 12 * k + i] xor sc[half + 12 * k + i])
                val x = dpmrHammingDecode(v); if (x < 0) { good = false; break }
                for (i in 0 until 8) w[8 * k + i] = (x shr (7 - i)) and 1
            }
            if (good && dpmrCrc7(w, 17) == dpField(w, 17, 7)) { checked++; id.activity = ""; id.lastSym = t; jobs = ArrayList(jobs.filter { it.kind != 1 }); return }
        }
    }
}

// ------------------------------------------------------------------------------------------------ the face
class P25ModesSnap(val mode: String, val p25: P25Id?, val p25p2: P2Id?, val nxdn: NxdnId?, val dpmr: DpmrId?, val station: String, val repeater: String, val position: Position?)

class P25Modes(val fs: Double) {
    /** Clear voice, 160 samples at 8 kHz a frame: the mode ("P25", "P25P2", "NXDN", "dPMR") and the slot. */
    var onAudio: (String, Int, FloatArray) -> Unit = { _, _, _ -> }
    val p25 = P25Identity()
    val p25p2 = P25P2Identity(fs)
    val nxdn = NxdnIdentity()
    val dpmr = DpmrIdentity()
    private val s24 = DiscSymbols(fs, 2400.0)
    private var samples = 0L
    private val last = LinkedHashMap<String, Pair<Long, Int>>()
    /** Checked frames on their grid, timed in 4800/s symbols (the 2400/s ones count two each). */
    val gate = FrameGate()
    private var t48 = 0L; private var t24 = 0L
    init {
        s24.onSymbol = { t24++; nxdn.pushSymbol24(it); dpmr.pushSymbol(it); gate.mark("NXDN", nxdn.checked, 2 * t24); gate.mark("dPMR", dpmr.checked, 2 * t24) }
        p25.onAudio = { onAudio("P25", 0, it) }
        p25p2.onAudio = { lch, pcm -> onAudio("P25P2", lch, pcm) }
        nxdn.onAudio = { onAudio("NXDN", 0, it) }
        dpmr.onAudio = { onAudio("dPMR", 0, it) }
    }
    fun reset() { p25.reset(); p25p2.reset(); nxdn.reset(); dpmr.reset(); s24.reset(); samples = 0; last.clear(); gate.reset(); t48 = 0; t24 = 0 }
    fun pushSymbol48(s: Double) {
        t48++; p25.pushSymbol(s); nxdn.pushSymbol48(s)
        // P25's frames of one NAC: TDUs every 72 symbols in a repeater's hang time, LDUs every 864
        gate.mark("P25:" + p25.id.nac, p25.checked, t48); gate.mark("NXDN", nxdn.checked, t48)
    }
    /** Whether [m]'s checked frames came on its frame grid (Phase 2: its checks alone). */
    fun framed(m: String): Boolean = when (m) { "P25P2" -> true; "P25" -> nac() >= 0; else -> gate.framed(m) }
    /** The NAC whose frames came on the grid most (a stray frame that passes its code with another NAC is not it), -1 none. */
    fun nac(): Int { val k = gate.best("P25:"); return if (k.isNotEmpty()) k.substring(4).toInt() else -1 }
    fun push(disc: FloatArray, n: Int) {
        s24.push(disc, n); p25p2.push(disc, n); samples += n
        fun mark(m: String, c: Int) { val l = last[m]; if (c > 0 && (l == null || l.second != c)) last[m] = Pair(samples, c) }
        mark("P25", p25.checked); mark("P25P2", p25p2.checked); mark("NXDN", nxdn.checked); mark("dPMR", dpmr.checked)
    }
    /** The mode whose checks passed last, or "" when none has. */
    val mode: String get() { var best = ""; var at = -1L; for ((m, l) in last) if (l.first > at && framed(m)) { at = l.first; best = m }; return best }

    fun snapshot(): P25ModesSnap {
        val m = mode
        return when (m) {
            "P25" -> { val x = p25.id.copy(nac = nac()); P25ModesSnap(m, x, null, null, null, if (x.src != 0) x.src.toString() else "", "", null) }
            "P25P2" -> { val x = p25p2.id.deep(); val live = x.slots.filter { it.src > 0 }.maxByOrNull { it.lastSym }; P25ModesSnap(m, null, x, null, null, live?.src?.toString() ?: "", "", null) }
            "NXDN" -> { val x = nxdn.id.copy(); P25ModesSnap(m, null, null, x, null, if (x.src == 0) "" else if (x.typeD) "${x.src shr 11}-${x.src and 0x7ff}" else x.src.toString(), "", null) }
            "dPMR" -> { val x = dpmr.id.copy(); P25ModesSnap(m, null, null, null, x, x.ownText, "", x.position) }
            else -> P25ModesSnap("", null, null, null, null, "", "", null)
        }
    }
}
