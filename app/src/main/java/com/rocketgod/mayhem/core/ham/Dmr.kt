package com.rocketgod.mayhem.core.ham

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

/*
 * DMR (ETSI TS 102 361) receiver fed with the NFM discriminator: 4FSK at 4800 symbols/s (the transmitter's
 * raised-cosine pulses are Nyquist, so the receiver band-limits and samples at the symbol centers), sync-word
 * correlation for symbol timing and eye levels, then per 30 ms time slot:
 *   · CACH (which slot), slot type via Golay (20,8): color code + data type
 *   · BPTC(196,96) for voice LC headers / terminators (RS(12,9) checked) and CSBKs (CRC-CCITT checked)
 *   · EMB via QR(16,7) plus the embedded LC spread over voice bursts B–E (Hamming 16,11,4, column parity,
 *     5-bit checksum) — talkgroup, source ID and talker alias mid-call
 *   · the three AMBE+2 voice frames per burst, de-interleaved and handed to the vocoder
 * Both time slots are followed; the audio follows one of them. The same correlator recognizes P25 (decoded, with
 * its IMBE vocoder), D-STAR, NXDN and Fusion (YSF) sync words so the DIGITAL tab can name what it hears.
 * Twin of web/src/dsp/ham/dmr.ts.
 */

private const val RATE = 48_000
private const val SPS = 10
private const val SLOT = 144
private const val RING = 4096
private const val MASK = RING - 1

// AMBE frame de-interleave (which row / bit of the 4 code words each of the 36 dibits feeds)
private val rW = intArrayOf(0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2)
private val rX = intArrayOf(23, 10, 22, 9, 21, 8, 20, 7, 19, 6, 18, 5, 17, 4, 16, 3, 15, 2, 14, 1, 13, 0, 12, 10, 11, 9, 10, 8, 9, 7, 8, 6, 7, 5, 6, 4)
private val rY = intArrayOf(0, 2, 0, 2, 0, 2, 0, 2, 0, 3, 0, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3)
private val rZ = intArrayOf(5, 3, 4, 2, 3, 1, 2, 0, 1, 13, 0, 12, 22, 11, 21, 10, 20, 9, 19, 8, 18, 7, 17, 6, 16, 5, 15, 4, 14, 3, 13, 2, 12, 1, 11, 0)

// ------------------------------------------------------------------------------------------- sync words
private class Sync(val proto: String, val kind: String, val src: String, val s: IntArray, val sp: Int, val thr: Float)

/** Symbol signs from a hex sync word (each dibit: MSB set → −). */
private fun fromHex(hex: String): IntArray {
    val out = ArrayList<Int>()
    for (ch in hex) { val v = ch.digitToInt(16); out.add(if ((v and 8) != 0) -1 else 1); out.add(if ((v and 2) != 0) -1 else 1) }
    return out.toIntArray()
}
private fun fromSigns(s: String) = IntArray(s.length) { if (s[it] == '1') 1 else -1 }
private fun inv(a: IntArray) = IntArray(a.size) { -a[it] }

private val SYNCS = listOf(
    Sync("DMR", "voice", "BS", fromHex("755FD7DF75F7"), 10, 0.82f),
    Sync("DMR", "data", "BS", fromHex("DFF57D75DF5D"), 10, 0.82f),
    Sync("DMR", "voice", "MS", fromHex("7F7D5DD57DFD"), 10, 0.82f),
    Sync("DMR", "data", "MS", fromHex("D5D7F77FD757"), 10, 0.82f),
    Sync("DMR", "voice", "DM1", fromHex("5D577F7757FF"), 10, 0.82f),
    Sync("DMR", "data", "DM1", fromHex("F7FDD5DDFD55"), 10, 0.82f),
    Sync("DMR", "voice", "DM2", fromHex("7DFFD5F55D5F"), 10, 0.82f),
    Sync("DMR", "data", "DM2", fromHex("D7557F5FF7F5"), 10, 0.82f),
    Sync("P25", "", "", fromHex("5575F5FF77FF"), 10, 0.86f),
    Sync("P25", "", "inv", inv(fromHex("5575F5FF77FF")), 10, 0.86f),
    Sync("D-STAR", "", "", fromSigns("313131313133131113313111"), 10, 0.95f),
    Sync("D-STAR", "", "inv", inv(fromSigns("313131313133131113313111")), 10, 0.95f),
    Sync("YSF", "", "", fromHex("D471C9634D"), 10, 0.95f),
    Sync("NXDN", "", "", fromSigns("313133113131111333"), 20, 0.95f),
    Sync("NXDN", "", "", fromSigns("313133113131113133"), 20, 0.95f),
    Sync("NXDN", "", "", fromSigns("313133113131111313"), 20, 0.95f),
    Sync("NXDN", "", "", fromSigns("313133113131113113"), 20, 0.95f),
    Sync("NXDN", "", "inv", inv(fromSigns("313133113131111333")), 20, 0.95f),
    Sync("NXDN", "", "inv", inv(fromSigns("313133113131113133")), 20, 0.95f),
)
private val DMR_SYNCS = SYNCS.filter { it.proto == "DMR" }

// ------------------------------------------------------------------------------------------- block codes
/** Hamming single-error correction; [eq] lists, per parity bit, the data bits it covers. 0 ok, 1 corrected, −1 not. */
private fun hamming(bits: IntArray, off: Int, k: Int, eq: IntArray): Int {
    var syn = 0
    for (p in eq.indices) {
        var c = 0; val m = eq[p]
        for (i in 0 until k) if ((m and (1 shl i)) != 0) c = c xor bits[off + i]
        syn = syn or ((c xor bits[off + k + p]) shl p)
    }
    if (syn == 0) return 0
    for (i in 0 until k) {
        var col = 0
        for (p in eq.indices) if ((eq[p] and (1 shl i)) != 0) col = col or (1 shl p)
        if (col == syn) { bits[off + i] = bits[off + i] xor 1; return 1 }
    }
    for (p in eq.indices) if (syn == (1 shl p)) { bits[off + k + p] = bits[off + k + p] xor 1; return 1 }
    return -1
}
private fun mask(vararg idx: Int) = idx.fold(0) { m, i -> m or (1 shl i) }
private val H15113 = intArrayOf(mask(0, 1, 2, 3, 5, 7, 8), mask(1, 2, 3, 4, 6, 8, 9), mask(2, 3, 4, 5, 7, 9, 10), mask(0, 1, 2, 4, 6, 7, 10))
private val H16114 = H15113 + mask(0, 2, 5, 6, 8, 9, 10)
private val H1393 = intArrayOf(mask(0, 1, 3, 5, 6), mask(0, 1, 2, 4, 6, 7), mask(0, 1, 2, 3, 5, 7, 8), mask(0, 2, 4, 5, 8))

/** BPTC(196,96): 196 received bits → 12 bytes (errors corrected where the row / column Hamming codes allow). */
private fun bptc(raw: IntArray): IntArray {
    val de = IntArray(196); val col = IntArray(13)
    for (a in 0 until 196) de[a] = raw[(a * 181) % 196]
    for (pass in 0 until 5) {
        var fixing = false
        for (c in 0 until 15) {
            for (a in 0 until 13) col[a] = de[c + 1 + a * 15]
            if (hamming(col, 0, 9, H1393) == 1) { fixing = true; for (a in 0 until 13) de[c + 1 + a * 15] = col[a] }
        }
        for (r in 0 until 9) if (hamming(de, r * 15 + 1, 11, H15113) == 1) fixing = true
        if (!fixing) break
    }
    val out = IntArray(12)
    var pos = 0
    fun take(a: Int) { if (de[a] != 0) out[pos shr 3] = out[pos shr 3] or (0x80 shr (pos and 7)); pos++ }
    for (a in 4..11) take(a)
    for (r in 1 until 9) for (a in r * 15 + 1..r * 15 + 11) take(a)
    return out
}

// Reed-Solomon (12,9) over GF(256), generator 0x11d, used as a check only
private val GF_EXP = IntArray(512)
private val GF_LOG = IntArray(256)
private val gf256 = run {
    var x = 1
    for (i in 0 until 255) { GF_EXP[i] = x; GF_LOG[x] = i; x = x shl 1; if ((x and 0x100) != 0) x = x xor 0x11d }
    for (i in 255 until 512) GF_EXP[i] = GF_EXP[i - 255]
    true
}
private fun gmul(a: Int, b: Int) = if (a == 0 || b == 0) 0 else GF_EXP[GF_LOG[a] + GF_LOG[b]]
private val RS_POLY = intArrayOf(64, 56, 14, 1)
private fun rs129ok(b: IntArray): Boolean {
    check(gf256)
    val par = IntArray(4)
    for (i in 0 until 9) {
        val d = b[i] xor par[2]
        par[2] = par[1] xor gmul(RS_POLY[2], d); par[1] = par[0] xor gmul(RS_POLY[1], d); par[0] = gmul(RS_POLY[0], d)
    }
    return b[9] == par[2] && b[10] == par[1] && b[11] == par[0]
}

// CRC-CCITT (poly 0x1021, init 0, final complement), stored big-endian in the last two bytes
private val CRC_T = IntArray(256) { i -> var c = i shl 8; repeat(8) { c = if ((c and 0x8000) != 0) ((c shl 1) xor 0x1021) and 0xffff else (c shl 1) and 0xffff }; c }
private fun crcOk(b: IntArray, n: Int): Boolean {
    var crc = 0
    for (i in 0 until n - 2) crc = ((crc shl 8) and 0xffff) xor CRC_T[((crc shr 8) xor b[i]) and 0xff]
    crc = crc.inv() and 0xffff
    return (crc shr 8) == b[n - 2] && (crc and 0xff) == b[n - 1]
}

// QR (16,7,6) for the EMB: 15-bit word (7 data + 8 parity, the final parity bit dropped), generator 0x139
private fun qrSyn(x0: Int): Int { var x = x0; for (i in 14 downTo 8) if ((x and (1 shl i)) != 0) x = x xor (0x139 shl (i - 8)); return x and 0xff }
private val QR_FIX = IntArray(256) { -1 }.also { t ->
    t[0] = 0
    for (i in 0 until 15) { t[qrSyn(1 shl i)] = 1 shl i; for (j in i + 1 until 15) t[qrSyn((1 shl i) or (1 shl j))] = (1 shl i) or (1 shl j) }
}
/** data | corrections << 8, or −1. */
private fun qr167(word15: Int): Int { val e = QR_FIX[qrSyn(word15)]; return if (e < 0) -1 else ((word15 xor e) shr 8) or (popcount(e) shl 8) }

// ------------------------------------------------------------------------------------------- link control
private class Lc(val flco: Int, val fid: Int, val opts: Int, val dst: Int, val src: Int)
private fun parseLc(b: IntArray) = Lc(b[0] and 0x3f, b[1], b[2], (b[3] shl 16) or (b[4] shl 8) or b[5], (b[6] shl 16) or (b[7] shl 8) or b[8])

/** Collects the four 32-bit embedded-LC fragments of a voice superframe and validates the 128-bit block. */
private class EmbeddedLc {
    private val raw = IntArray(128)
    private var state = 0
    fun reset() { state = 0 }
    fun add(frag: IntArray, lcss: Int): IntArray? {
        if (lcss == 1) { frag.copyInto(raw, 0); state = 1; return null }
        if (lcss == 3 && state == 1) { frag.copyInto(raw, 32); state = 2; return null }
        if (lcss == 3 && state == 2) { frag.copyInto(raw, 64); state = 3; return null }
        if (lcss == 2 && state == 3) { frag.copyInto(raw, 96); state = 0; return decode() }
        if (lcss != 0) state = 0
        return null
    }
    private fun decode(): IntArray? {
        val data = IntArray(128)
        var b = 0
        for (a in 0 until 128) { data[b] = raw[a]; b += 16; if (b > 127) b -= 127 }
        var a = 0
        while (a < 112) { if (hamming(data, a, 11, H16114) < 0) return null; a += 16 }
        for (c in 0 until 16) { var p = 0; for (r in 0 until 8) p = p xor data[c + 16 * r]; if (p != 0) return null }
        val bytes = IntArray(9)
        var pos = 0
        fun take(i: Int) { if (data[i] != 0) bytes[pos shr 3] = bytes[pos shr 3] or (0x80 shr (pos and 7)); pos++ }
        for (i in 0 until 11) take(i)
        for (i in 16 until 27) take(i)
        for (i in 32 until 42) take(i)
        for (i in 48 until 58) take(i)
        for (i in 64 until 74) take(i)
        for (i in 80 until 90) take(i)
        for (i in 96 until 106) take(i)
        val crc = (data[42] shl 4) or (data[58] shl 3) or (data[74] shl 2) or (data[90] shl 1) or data[106]
        return if (bytes.sum() % 31 == crc) bytes else null
    }
}

private val FIDS = mapOf(0 to "", 16 to "MOTOROLA", 104 to "HYTERA", 6 to "TRIDENT", 8 to "SELEX", 51 to "SIMOCO", 60 to "RADIODATA", 88 to "TAIT")
private val CSBKO = mapOf(0x04 to "UNIT-TO-UNIT REQUEST", 0x05 to "UNIT-TO-UNIT ANSWER", 0x07 to "CHANNEL TIMING", 0x1c to "AHOY",
    0x1f to "CALL ALERT", 0x20 to "CALL ALERT ACK", 0x21 to "ACK", 0x24 to "RADIO CHECK", 0x26 to "NACK", 0x27 to "EMERGENCY",
    0x28 to "BROADCAST", 0x2a to "MAINTENANCE", 0x2e to "CLEAR", 0x30 to "PRIVATE VOICE GRANT", 0x31 to "TALKGROUP VOICE GRANT",
    0x38 to "BS OUTBOUND ACTIVATION", 0x3d to "PREAMBLE")
private val DATA_TYPES = listOf("PI HEADER", "VOICE HEADER", "END OF CALL", "CSBK", "MBC HEADER", "MBC", "DATA HEADER", "RATE ½ DATA", "RATE ¾ DATA", "IDLE", "RATE 1 DATA")

// ------------------------------------------------------------------------------------------- time slot
data class SlotStatus(val voice: Boolean, val tg: Int, val src: Int, val group: Boolean, val alias: String, val cc: Int, val last: String, val since: Long, val errs: Float)

private class TimeSlot {
    var voice = false; var seq = -1
    var tg = 0; var src = 0; var group = true; var alias = ""; var cc = -1
    var last = ""; var since = 0L
    var errs = 0f; var frames = 0
    var lastLog = ""; var lastLogAt = -1_000_000_000L
    val ambe = AmbeDecoder()
    val emb = EmbeddedLc()
    private val aliasParts = arrayOf("", "", "", "")
    private var aliasFmt = 1

    fun setLc(lc: Lc): Boolean {
        if (lc.flco in 4..7) { talkerAlias(lc); return false }
        if (lc.flco == 8) return false                 // GPS info, not shown
        val changed = lc.dst != tg || lc.src != src
        tg = lc.dst; src = lc.src; group = lc.flco == 0
        return changed
    }

    fun status() = SlotStatus(voice, tg, src, group, alias, cc, last, since, if (frames > 0) errs / frames else 0f)
    fun endCall() { voice = false; seq = -1; emb.reset(); ambe.reset() }

    /** Talker alias (FLCO 4 header + 5..7 blocks): 7-bit, ISO-8, UTF-8 or UTF-16BE text. */
    private fun talkerAlias(lc: Lc) {
        val b = intArrayOf(lc.opts, (lc.dst shr 16) and 255, (lc.dst shr 8) and 255, lc.dst and 255, (lc.src shr 16) and 255, (lc.src shr 8) and 255, lc.src and 255)
        val idx = lc.flco - 4
        val text = StringBuilder()
        if (idx == 0) { aliasFmt = b[0] shr 6; for (i in 0 until 4) aliasParts[i] = "" }
        when (aliasFmt) {
            0 -> {
                val bits = ArrayList<Int>(); for (v in b) for (i in 7 downTo 0) bits.add((v shr i) and 1)
                var p = if (idx == 0) 7 else 0
                while (p + 7 <= bits.size) { var c = 0; for (i in 0 until 7) c = (c shl 1) or bits[p + i]; if (c >= 32) text.append(c.toChar()); p += 7 }
            }
            3 -> { var i = if (idx == 0) 1 else 0; while (i + 1 < b.size) { val c = (b[i] shl 8) or b[i + 1]; if (c >= 32) text.append(c.toChar()); i += 2 } }
            else -> {
                val bytes = b.drop(if (idx == 0) 1 else 0).filter { it != 0 }.map { it.toByte() }.toByteArray()
                text.append(if (aliasFmt == 2) String(bytes, Charsets.UTF_8) else String(bytes, Charsets.ISO_8859_1))
            }
        }
        aliasParts[idx] = text.toString().replace(Regex("[\\x00-\\x1f]"), "")
        alias = aliasParts.joinToString("").trim()
    }
}

data class DmrStatus(
    val locked: Boolean, val proto: String, val source: String, val cc: Int, val level: Float, val syncs: Int,
    val slots: List<SlotStatus>, val audioSlot: Int, val dv: String, val dvCount: Int, val inverted: Boolean,
    /** Checked payloads (RS / CRC / embedded LC) or a settled color code have been seen: this is DMR, not a look-alike. */
    val strong: Boolean,
)

class DmrDecoder : FmTap {
    var onAudio: (FloatArray, Int) -> Unit = { _, _ -> }
    var onLog: (String) -> Unit = {}
    /** 0 = follow whichever slot last started talking, 1 / 2 = fixed. */
    @Volatile var slotSel = 0
    override val minHalf = 6500.0
    override fun onFm(samples: FloatArray, n: Int, rate: Double) { if (abs(rate - RATE) < 1) push(samples, n) }

    private val lp = RealFir(lowpassTaps(4200.0 / RATE, 95))   // 4FSK at 4800 baud reaches ~2.9 kHz; leave room
    private var tmp = FloatArray(0)
    private val ring = FloatArray(RING)
    private var n = 0L
    private var locked = false
    private var symNext = 0.0
    private var center = 0f; private var lvl = 0.25f
    private val sorted = FloatArray(SLOT)
    /** Receiver polarity: an inverted discriminator swaps voice and data sync words and every dibit's MSB. */
    private var inverted = false
    private var polOk = 0; private var polBad = 0; private var confirmed = false
    private var validCount = 0
    private var sps = SPS.toDouble()
    private var lastFireT = -1e9
    private val ccVotes = FloatArray(16)
    private val soft = FloatArray(SLOT)
    private val dib = IntArray(SLOT)
    private var pos = 0
    private var frame = 0
    private var parity = 0
    private var simplexPhase = -1
    private var msDual = false
    private var msOther = 0
    /** P25 shares this receiver's symbol recovery; it only frames differently once a sync lands. */
    val p25 = P25Decoder()
    private val imbe = ImbeDecoder()
    /** Follow P25 as well as DMR (the DIGITAL tab turns this on for P25 or AUTO). */
    @Volatile var p25On = false
    private var p25Mode = false
    private var dmrFrameN = -1_000_000_000L
    private var lastSyncN = -1_000_000_000L
    private var syncCount = 0
    private var source = ""
    var cc = -1; private set
    private val ts = arrayOf(TimeSlot(), TimeSlot())
    private var audioSlot = 0
    private var candCorr = 0f; private var candN = 0L; private var candSync: Sync? = null
    private val v24 = FloatArray(24); private val v18 = FloatArray(18); private val v18a = FloatArray(18); private val v18b = FloatArray(18)
    private var dvName = ""; private var dvAt = -1_000_000_000L; private var dvCount = 0
    // audio upsampling 8 k → 48 k
    private val up = RealFir(lowpassTaps(3400.0 / RATE, 47))
    private val upIn = FloatArray(960); private val upOut = FloatArray(960)
    private val fr = Array(4) { IntArray(24) }
    private val raw196 = IntArray(196)
    private val frag = IntArray(32)
    private var lastIdleLog = 0L; private var lastLine = ""; private var lastLineAt = -1_000_000_000L; private var lockLine = ""

    init {
        // P25 voice frames go through their own vocoder into the same audio path DMR uses
        p25.onVoice = { bits -> val pcm = imbe.decodeVoice(bits); if (p25Mode) emitAudio(pcm) }
    }

    fun reset() {
        imbe.reset()
        lp.reset(); up.reset(); ring.fill(0f); n = 0; locked = false; pos = 0; frame = 0; parity = 0
        lastSyncN = -1_000_000_000L; syncCount = 0; cc = -1; source = ""; candSync = null; candCorr = 0f
        simplexPhase = -1; msDual = false; msOther = 0; p25Mode = false; dmrFrameN = -1_000_000_000L; p25.reset()
        for (t in ts) { t.endCall(); t.tg = 0; t.src = 0; t.alias = ""; t.last = ""; t.cc = -1; t.errs = 0f; t.frames = 0 }
        polOk = 0; polBad = 0; confirmed = false; sps = SPS.toDouble(); ccVotes.fill(0f); validCount = 0
        dvName = ""; dvAt = -1_000_000_000L; dvCount = 0
    }

    /** Samples seen, so a caller can age the P25 status. */
    val samples: Long get() = n

    fun status(): DmrStatus {
        val dv = if (n - dvAt < 2 * RATE && dvCount >= 3) dvName else ""
        var bestVotes = 0f; for (i in 0 until 16) if (ccVotes[i] > bestVotes) bestVotes = ccVotes[i]
        return DmrStatus(locked && confirmed, if (locked) "DMR" else "", source, cc, lvl, syncCount, listOf(ts[0].status(), ts[1].status()),
            audioSlot + 1, dv, dvCount, inverted, locked && confirmed && (validCount >= 2 || bestVotes >= 4))
    }

    /** Discriminator samples (radians per sample) at 48 kHz. */
    fun push(disc: FloatArray, count: Int) {
        if (tmp.size < count) tmp = FloatArray(count)
        val y = tmp
        lp.process(disc, count, y)
        for (i in 0 until count) {
            val t = n
            ring[(t and MASK.toLong()).toInt()] = y[i]
            var search = !locked
            if (locked) { val r = (((t - symNext) % SPS) + SPS) % SPS; search = r < 1.5 || r > 8.5 }
            if (search) checkSync(t)
            val cs = candSync
            if (cs != null && t - candN >= 6) { val cn = candN; candSync = null; candCorr = 0f; fire(cs, cn) }
            if (locked) {
                while (symNext + 1 <= t) {
                    val x = interp(symNext)
                    symNext += sps
                    if (p25Mode) { p25.push(slice(x), n); continue }
                    soft[pos] = x; dib[pos] = slice(x)
                    if (++pos >= SLOT) { pos = 0; processSlot() }
                }
                // a free-running P25 framer can decode for a long time without the correlator firing
                val alive = if (p25Mode) max(lastSyncN, p25.lastFrame) else lastSyncN
                if (t - alive > 2 * RATE) {
                    locked = false; for (s in ts) s.endCall()
                    if (confirmed) log(if (p25Mode) "P25 lost" else "DMR lost")
                    confirmed = false; if (p25Mode) p25.idle(); p25Mode = false
                    polOk = 0; polBad = 0; simplexPhase = -1; msDual = false; msOther = 0; ccVotes.fill(0f)
                }
            }
            n++
        }
    }

    private fun interp(t: Double): Float {
        val i = floor(t).toLong(); val f = (t - i).toFloat()
        return ring[(i and MASK.toLong()).toInt()] * (1 - f) + ring[((i + 1) and MASK.toLong()).toInt()] * f
    }

    private fun slice(x: Float): Int {
        val d = if (inverted) center - x else x - center; val thr = lvl * 2 / 3
        return if (d > thr) 1 else if (d > 0) 0 else if (d > -thr) 2 else 3
    }

    /** A sync word's meaning under the current polarity (inverted → voice and data swap). */
    private fun kindOf(s: Sync) = if (inverted) (if (s.kind == "voice") "data" else "voice") else s.kind

    /** Polarity bookkeeping: after a run of failed slot types / EMBs, try the other polarity. */
    private fun polarity(ok: Boolean) {
        if (ok) {
            polOk++
            if (polOk >= 3 && !confirmed) { confirmed = true; log("$lockLine${if (inverted) " · inverted" else ""}") }
            if (polOk > 12) { polOk = 12; polBad = 0 }
            return
        }
        polBad++
        if (polBad >= 4 && polOk < 3) { inverted = !inverted; polBad = 0; polOk = 0; for (s in ts) s.endCall() }
        else if (polBad >= 24) { polOk = 0; polBad = 0; confirmed = false }
    }

    /**
     * Color-code voting: every burst of a DMR system carries the same color code, so once one is settled a burst
     * claiming another is noise whose Golay happened to land on a code word — rejecting it keeps a phantom caller
     * out of the other time slot.
     */
    private fun ccVote(c: Int, errs: Int): Boolean {
        val v = ccVotes
        var best = 0; for (i in 1 until 16) if (v[i] > v[best]) best = i
        if (v[best] >= 3 && c != best) return false
        if (errs <= 1 || v[best] < 3) { for (i in 0 until 16) v[i] *= 0.95f; v[c] += 1f; return true }
        return false
    }

    private fun checkSync(t: Long) {
        var a24 = 0f; var a20 = 0f; var min24 = Float.MAX_VALUE
        for (k in 0 until 24) {
            val x = ring[((t - (23 - k) * 10) and MASK.toLong()).toInt()]; v24[k] = x
            val a = abs(x); a24 += a; if (k >= 4) a20 += a; if (a < min24) min24 = a
        }
        if (a24 < 1e-4f) return
        val strong = min24 > 0.3f * (a24 / 24)            // every sync symbol is ±3: no weak symbols allowed
        val nxdn = !locked
        var a18 = 0f; var a18a = 0f; var a18b = 0f; var min18 = Float.MAX_VALUE
        if (nxdn) for (k in 0 until 18) {                  // 2400 symbols/s: the symbol must hold ±5 samples around its center
            val i = t - (17 - k) * 20
            val x = ring[(i and MASK.toLong()).toInt()]; val xa = ring[((i - 5) and MASK.toLong()).toInt()]; val xb = ring[((i + 5) and MASK.toLong()).toInt()]
            v18[k] = x; v18a[k] = xa; v18b[k] = xb
            val ax = abs(x); val aa = abs(xa); val ab = abs(xb)
            a18 += ax; a18a += aa; a18b += ab
            min18 = minOf(min18, ax, aa, ab)
        }
        val strong18 = nxdn && min18 > 0.3f * (a18 / 18)
        var min20 = Float.MAX_VALUE; for (k in 4 until 24) min20 = min(min20, abs(v24[k]))
        val strong20 = min20 > 0.15f * (a20 / 20)
        for (s in SYNCS) {
            if (!wants(s)) continue
            var c = 0f; val a: Float
            if (s.sp == 20) {
                if (!strong18) continue
                var ca = 0f; var cb = 0f
                for (k in 0 until 18) { c += v18[k] * s.s[k]; ca += v18a[k] * s.s[k]; cb += v18b[k] * s.s[k] }
                if (ca / a18a < s.thr || cb / a18b < s.thr) continue
                a = a18
            } else if (s.s.size == 20) { for (k in 0 until 20) c += v24[k + 4] * s.s[k]; a = a20 }
            else { for (k in 0 until 24) c += v24[k] * s.s[k]; a = a24 }
            val corr = c / a
            if (corr < s.thr) continue
            if (if (s.proto == "YSF") !strong20 else s.sp != 20 && !strong) continue
            if (corr > candCorr) { candCorr = corr; candN = t; candSync = s }
        }
    }

    /**
     * Which protocols may compete for the receiver right now, decided when the candidate is picked: only the best
     * correlation in a six-sample window survives, so a chance match on one protocol's sync could swallow the
     * other's real one.
     */
    private fun wants(s: Sync): Boolean {
        if (!locked) return true
        if (p25Mode && n - p25.lastFrame < RATE / 2) return s.proto == "P25"
        if (!p25Mode && n - dmrFrameN < RATE / 2) return s.proto == "DMR"
        return true
    }

    /** A sync word ended at sample [n0]: refine the timing, then lock (DMR / P25) or count an identification. */
    private fun fire(s: Sync, n0: Long) {
        val wantP25 = s.proto == "P25" && p25On
        if (s.proto != "DMR" && !wantP25) {
            if (locked) return
            if (dvName != s.proto || n - dvAt > 2 * RATE) dvCount = 0
            dvName = s.proto; dvAt = n; dvCount++
            if (dvCount == 3) log("${s.proto} sync detected (identification only)")
            return
        }
        // both are 4FSK at 4800 baud and each one's traffic throws the other's sync now and then: follow whichever
        // is actually producing frames
        if (wantP25 && !p25Mode && locked && n - dmrFrameN < RATE / 2) return
        if (s.proto == "DMR" && p25Mode && n - p25.lastFrame < RATE / 2) return
        // Matched-filter output, NOT the normalized correlation: dividing by the signal's own magnitude flattens the
        // very peak this is locating, and the parabolic fit then lands about a tenth of a symbol early.
        fun corrAt(t: Double): Float { var c = 0f; for (k in 0 until 24) c += interp(t - (23 - k) * 10) * s.s[k]; return c }
        val cm = corrAt(n0 - 1.0); val c0 = corrAt(n0.toDouble()); val cp = corrAt(n0 + 1.0)
        val den = cm - 2 * c0 + cp
        var delta = if (den < 0) 0.5 * (cm - cp) / den else 0.0
        delta = delta.coerceIn(-0.5, 0.5)
        val t0 = n0 + delta
        if (locked && t0 - lastFireT < RATE) {             // symbol clock: the sync should end on a symbol instant
            val prevSym = symNext - sps; val e = t0 - prevSym; val err = e - (e / sps).roundToLong() * sps
            val symbols = (t0 - lastFireT) / sps
            if (abs(err) < 3 && symbols >= 100) sps += 0.2 * err / symbols
            sps = sps.coerceIn(SPS * 0.99, SPS * 1.01)
        }
        lastFireT = t0
        var sp = 0f; var sn = 0f; var np = 0; var nn = 0
        for (k in 0 until 24) { val x = interp(t0 - (23 - k) * 10); if (s.s[k] > 0) { sp += x; np++ } else { sn += x; nn++ } }
        val mp = sp / np; val mn = sn / nn; val ctr = (mp + mn) / 2; val lv = (mp - mn) / 2
        if (lv < 0.01f) return
        if (!locked) {
            center = ctr; lvl = lv
            lockLine = "${s.proto} sync (${s.src.ifEmpty { "P25" }}) · deviation ${"%.0f".format(lv * RATE / (2 * PI))} Hz"
        } else { center += 0.5f * (ctr - center); lvl += 0.5f * (lv - lvl) }
        if (wantP25) {
            // P25 is one continuous stream: no slots, no polarity question, just frames that start here
            if (!p25Mode) { p25Mode = true; p25.idle(); imbe.reset(); confirmed = true; log(lockLine) }
            inverted = s.src == "inv"
            symNext = t0 + sps; locked = true; lastSyncN = t0.toLong(); syncCount++; source = "P25"
            p25.sync(n)
            return
        }
        if (p25Mode) { p25Mode = false; p25.idle(); confirmed = false; polOk = 0; polBad = 0 }
        for (k in 0 until 90) { val x = interp(t0 - (89 - k) * sps); soft[k] = x; dib[k] = slice(x) }
        symNext = t0 + sps; pos = 90; locked = true; lastSyncN = t0.toLong(); syncCount++; source = s.src
    }

    /** Soft match of the slot's center 48 bits against the DMR sync words. */
    private fun matchCenter(thr: Float): Sync? {
        var a = 0f; for (k in 0 until 24) a += abs(soft[66 + k] - center)
        if (a < 24 * 0.4f * lvl) return null                // sync symbols are all ±3: a weak center is not a sync
        var best: Sync? = null; var bestC = thr
        for (s in DMR_SYNCS) {
            var c = 0f; for (k in 0 until 24) c += (soft[66 + k] - center) * s.s[k]
            c /= a
            if (c > bestC) { bestC = c; best = s }
        }
        return best
    }

    private fun processSlot() {
        // the parity free-runs at the 30 ms burst rate; the slot index derives from it, so forcing a slot never
        // disturbs the alternation a repeater's two time slots rely on
        parity = parity xor 1
        frame = if (simplexPhase >= 0) 0 else parity
        var t = ts[frame]
        val sync = matchCenter(if (t.voice && t.seq >= 5) 0.6f else 0.72f)
        if (sync != null) {
            lastSyncN = n; syncCount++; source = sync.src; dmrFrameN = n
            when (sync.src) {
                "MS" -> {
                    // one radio is one stream on one parity, the other half dead air; two radios sharing a repeater's
                    // uplink slots put MS sync on both parities, and then both slots must be followed
                    if (msDual) frame = parity
                    else if (simplexPhase < 0) { simplexPhase = parity; frame = 0 }
                    else if (parity == simplexPhase) { frame = 0; msOther = 0 }
                    else if (++msOther >= 6) { msDual = true; simplexPhase = -1; frame = parity }
                    else return                              // a lone sync in the idle half is noise
                    t = ts[frame]
                }
                "BS" -> { simplexPhase = -1; frame = (dib[2] shr 1) and 1; parity = frame; t = ts[frame] }
                "DM1" -> { simplexPhase = -1; frame = 0; parity = 0; t = ts[0] }
                "DM2" -> { simplexPhase = -1; frame = 1; parity = 1; t = ts[1] }
            }
        } else if (simplexPhase >= 0 && parity != simplexPhase) return
        // eye tracking from the data when there is no sync word this slot (voice bursts B–F)
        if (sync == null) {
            soft.copyInto(sorted); sorted.sort()
            var lo = 0f; var hi = 0f; for (k in 0 until 36) { lo += sorted[k]; hi += sorted[SLOT - 1 - k] }
            lo /= 36; hi /= 36
            if (hi - lo > 0.02f) { center += 0.1f * ((hi + lo) / 2 - center); lvl += 0.1f * ((hi - lo) / 2 - lvl) }
        }
        val kind = if (sync != null) kindOf(sync) else ""
        if (kind == "data") dataBurst(t)
        else if (kind == "voice") {
            t.seq = 0; t.emb.reset()
            if (confirmed) {
                // a voice sync on its own is not proof of a call: wait for this slot's color code to match the system's
                if (!t.voice && cc >= 0 && t.cc == cc) {
                    t.since = n; t.ambe.reset()
                    if (slotSel == 0) audioSlot = frame
                    t.voice = true
                    logLine(t, "VOICE")
                }
                if (t.voice) voiceBurst(t) else voiceEvidence(t)
            } else voiceEvidence(t)
        } else if (t.seq in 0..4) {                        // inside a voice superframe (bursts B–F carry EMB + embedded LC)
            t.seq++
            embedded(t)
            if (t.voice && confirmed) voiceBurst(t) else voiceEvidence(t)
        } else if (t.voice) { t.endCall(); logLine(t, "voice stopped") }
        else t.seq = -1
    }

    /** Polarity evidence from a voice burst's first AMBE frame without synthesizing anything. */
    private fun voiceEvidence(t: TimeSlot) {
        for (row in fr) row.fill(0)
        for (i in 0 until 36) { val d = dib[12 + i]; fr[rW[i]][rX[i]] = d shr 1; fr[rY[i]][rZ[i]] = d and 1 }
        polarity(c0Clean(fr[0]))
        if (!confirmed) t.voice = false
    }

    private fun dataBurst(t: TimeSlot) {
        var st = 0
        for (i in 61..65) st = (st shl 2) or dib[i]
        for (i in 90..94) st = (st shl 2) or dib[i]
        val code = golay208(st ushr 1)
        val dt = if (code < 0) -1 else code and 15
        val errs = if (code < 0) 9 else code shr 8
        val c = if (code < 0) -1 else (code shr 4) and 15
        val clean = dt in 0..10 && errs <= 1 && (st ushr 1) != 0   // the all-zero word is a code word too (a dead carrier)
        polarity(clean)
        if (dt < 0 || dt > 10 || (st ushr 1) == 0 || !confirmed || !ccVote(c, errs)) return
        cc = c; t.cc = c
        val wasVoice = t.voice && confirmed
        t.endCall()
        val raw = raw196
        var p = 0
        for (i in 12..60) { raw[p++] = dib[i] shr 1; raw[p++] = dib[i] and 1 }
        for (i in 95..143) { raw[p++] = dib[i] shr 1; raw[p++] = dib[i] and 1 }
        val name = DATA_TYPES.getOrNull(dt) ?: "DATA TYPE $dt"
        if (dt == 1 || dt == 2) {
            val b = bptc(raw)
            val m = if (dt == 1) 0x96 else 0x99
            b[9] = b[9] xor m; b[10] = b[10] xor m; b[11] = b[11] xor m
            if (rs129ok(b)) { validCount++; t.setLc(parseLc(b)); logLine(t, if (dt == 1) "VOICE HEADER" else "END OF CALL") }
            else logLine(t, "$name (bad RS)")
        } else if (dt == 3 || dt == 4) {
            val b = bptc(raw)
            val m = if (dt == 3) 0xa5 else 0xaa
            b[10] = b[10] xor m; b[11] = b[11] xor m
            if (crcOk(b, 12)) {
                validCount++
                val op = b[0] and 0x3f; val fid = b[1]
                val dst = (b[4] shl 16) or (b[5] shl 8) or b[6]; val src = (b[7] shl 16) or (b[8] shl 8) or b[9]
                val vendor = FIDS[fid] ?: "FID $fid"
                if (fid != 0) logLine(t, "$vendor CSBK 0x%02x · %s".format(op, (2 until 10).joinToString(" ") { "%02x".format(b[it]) }))
                else {
                    val opName = CSBKO[op] ?: "CSBK 0x${Integer.toHexString(op)}"
                    val detail = when (op) {
                        0x38 -> "BS $dst ← $src"
                        0x26 -> "→ $dst from $src"
                        else -> "${if ((b[2] and 0x40) != 0 && op == 0x3d) "TG" else "ID"} $dst ← $src"
                    }
                    logLine(t, "$opName · $detail")
                }
            } else logLine(t, "$name (bad CRC)")
        } else if (dt == 9) {
            if (n - lastIdleLog > 5 * RATE) { lastIdleLog = n; logLine(t, "IDLE") }
            t.last = "IDLE"
        } else logLine(t, name)
        if (wasVoice && dt != 2) logLine(t, "voice stopped")
    }

    private fun embedded(t: TimeSlot) {
        var emb = 0
        for (i in 66..69) emb = (emb shl 2) or dib[i]
        for (i in 86..89) emb = (emb shl 2) or dib[i]
        val code = qr167(emb ushr 1)
        val errs = if (code < 0) 9 else code shr 8
        val c = if (code < 0) -1 else (code shr 3) and 15
        val lcss = code and 3
        polarity(errs == 0)
        if (code < 0 || !confirmed || !ccVote(c, errs)) return
        cc = c; t.cc = c
        for (i in 0 until 16) { frag[2 * i] = dib[70 + i] shr 1; frag[2 * i + 1] = dib[70 + i] and 1 }
        val lc = t.emb.add(frag, lcss) ?: return
        validCount++
        val parsed = parseLc(lc)
        if (t.setLc(parsed)) logLine(t, "VOICE")
        else if (parsed.flco in 4..7 && t.alias.isNotEmpty()) logLine(t, "alias ${t.alias}")
    }

    private fun voiceBurst(t: TimeSlot) {
        val play = confirmed && frame == (if (slotSel == 0) audioSlot else slotSel - 1)
        fun decodeOne(fill: (Int) -> Int) {
            for (row in fr) row.fill(0)
            for (i in 0 until 36) { val d = fill(i); fr[rW[i]][rX[i]] = d shr 1; fr[rY[i]][rZ[i]] = d and 1 }
            val pcm = t.ambe.decode(fr)
            t.frames++; t.errs += min(1f, t.ambe.errs / 8f)
            if (play) emitAudio(pcm)
        }
        decodeOne { dib[12 + it] }
        decodeOne { if (it < 18) dib[48 + it] else dib[90 + it - 18] }
        decodeOne { dib[108 + it] }
    }

    private fun emitAudio(pcm8k: FloatArray) {
        upIn.fill(0f)
        for (i in 0 until 160) upIn[i * 6] = pcm8k[i] * 6
        up.process(upIn, 960, upOut)
        onAudio(upOut, 960)
    }

    private fun logLine(t: TimeSlot, what: String) {
        val slot = frame + 1
        val who = if (t.tg != 0 || t.src != 0) " · ${if (t.group) "TG" else "ID"} ${t.tg} ← ${t.src}${if (t.alias.isNotEmpty()) " \"${t.alias}\"" else ""}" else ""
        t.last = what
        val line = "S$slot CC${if (t.cc >= 0) t.cc.toString() else "?"} $what$who"
        if (line == t.lastLog && n - t.lastLogAt < 3 * RATE) return
        t.lastLog = line; t.lastLogAt = n
        log(line)
    }

    private fun log(line: String) {
        if (line == lastLine && n - lastLineAt < 3 * RATE) return
        lastLine = line; lastLineAt = n
        onLog(line)
    }
}
