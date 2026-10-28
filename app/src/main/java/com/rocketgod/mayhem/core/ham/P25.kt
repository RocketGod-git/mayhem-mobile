package com.rocketgod.mayhem.core.ham

/*
 * P25 Phase 1 (TIA-102) framing, on top of the same 4FSK symbol recovery the DMR decoder uses: C4FM at 4800
 * baud, but one continuous stream rather than TDMA slots. Twin of web/src/dsp/ham/p25.ts.
 *
 * A transmission is a run of frames, each starting with the 48-bit frame sync and a 64-bit Network ID carrying
 * the NAC (which system) and the DUID (which kind of frame). A status symbol is punched into the stream after
 * every 35 symbols and has to be pulled back out before anything parses.
 *
 * Link control is protected three deep: each 6-bit hex word carries a Hamming (10,6) code word, the 24 hex words
 * are a shortened Reed-Solomon (24,12) code over GF(64), and only then are there 72 bits naming the talkgroup
 * and the radio.
 */

data class P25Status(
    val locked: Boolean, val nac: Int, val duid: Int, val frame: String,
    val talkgroup: Int, val source: Int, val encrypted: Boolean, val lcf: Int,
    val frames: Int, val errs: Int, val since: Long,
)

private val DUID_NAME = linkedMapOf(0x0 to "HEADER", 0x3 to "TERMINATOR", 0x5 to "VOICE 1", 0x7 to "TRUNKING",
    0xa to "VOICE 2", 0xc to "DATA", 0xf to "TERMINATOR + LC")
/** Information symbols per frame type, after the status symbols are removed (sync and NID included). */
private val DUID_SYMBOLS = mapOf(0x0 to 385, 0x3 to 70, 0x5 to 840, 0x7 to 175, 0xa to 840, 0xc to 0, 0xf to 210)

// --------------------------------------------------------------------------------------- GF(64) for the RS code
private val GF64_EXP = IntArray(128)
private val GF64_LOG = IntArray(64)
private val gfInit = run {
    var x = 1
    for (i in 0 until 63) { GF64_EXP[i] = x; GF64_LOG[x] = i; x = x shl 1; if ((x and 0x40) != 0) x = x xor 0x43 }   // x^6 + x + 1
    for (i in 63 until 126) GF64_EXP[i] = GF64_EXP[i - 63]
    true
}
private fun g64mul(a: Int, b: Int) = if (a == 0 || b == 0) 0 else GF64_EXP[GF64_LOG[a] + GF64_LOG[b]]
private fun g64div(a: Int, b: Int) = if (a == 0) 0 else GF64_EXP[GF64_LOG[a] + 63 - GF64_LOG[b]]

/** Shortened RS(24,12) over GF(64): syndromes, Berlekamp-Massey, Chien, Forney. Symbols corrected, or −1. */
private fun rsDecode(data: IntArray, nroots: Int): Int {
    check(gfInit)
    val n = data.size
    val synd = IntArray(nroots)
    var bad = false
    for (i in 0 until nroots) {
        var s = 0
        for (j in 0 until n) s = g64mul(s, GF64_EXP[i + 1]) xor data[j]
        synd[i] = s
        if (s != 0) bad = true
    }
    if (!bad) return 0
    var lam = IntArray(nroots + 1); lam[0] = 1
    var b = IntArray(nroots + 1); b[0] = 1
    var L = 0
    for (r in 1..nroots) {
        var d = 0
        for (i in 0..L) d = d xor g64mul(lam[i], if (r - 1 - i in 0 until nroots) synd[r - 1 - i] else 0)
        val bShift = IntArray(nroots + 1)
        for (i in 0 until nroots) bShift[i + 1] = b[i]
        if (d == 0) { b = bShift; continue }
        val t = IntArray(nroots + 1)
        for (i in 0..nroots) t[i] = lam[i] xor g64mul(d, bShift[i])
        if (2 * L <= r - 1) {
            val inv = g64div(1, d)
            b = IntArray(nroots + 1) { g64mul(lam[it], inv) }
            L = r - L
        } else b = bShift
        lam = t
    }
    if (L > nroots shr 1) return -1
    val roots = ArrayList<Int>(); val pos = ArrayList<Int>()
    for (i in 0 until 63) {
        var s = 0
        for (j in 0..L) s = s xor g64mul(lam[j], GF64_EXP[(j * i) % 63])
        if (s == 0) { val p = (63 - i) % 63; if (p < n) { roots.add(GF64_EXP[i]); pos.add(n - 1 - p) } }
    }
    if (roots.size != L) return -1
    val omega = IntArray(nroots)
    for (i in 0 until nroots) { var s = 0; for (j in 0..minOf(i, L)) s = s xor g64mul(lam[j], synd[i - j]); omega[i] = s }
    for (k in pos.indices) {
        val xInv = roots[k]
        var num = 0
        for (i in 0 until nroots) num = num xor g64mul(omega[i], GF64_EXP[(GF64_LOG[xInv] * i) % 63])
        var den = 0
        var i = 1
        while (i <= L) { den = den xor g64mul(lam[i], GF64_EXP[(GF64_LOG[xInv] * (i - 1)) % 63]); i += 2 }
        if (den == 0) return -1
        data[pos[k]] = data[pos[k]] xor g64div(num, den)
    }
    return pos.size
}

// ------------------------------------------------------------------- BCH (63,16,23) over the Network ID
/** Generator of the Network ID code: the product of the minimal polynomials of alpha^1..alpha^22 (binary, degree 47). */
private val BCH_GEN: Long = run {
    check(gfInit)
    var g = intArrayOf(1)
    val seen = HashSet<Int>()
    for (r in 1..22) {
        val conj = ArrayList<Int>()
        var c = r
        while (c !in conj) { conj.add(c); c = (c * 2) % 63 }
        if (conj.any { it in seen }) continue
        seen.addAll(conj)
        var mp = intArrayOf(1)
        for (cc in conj) {
            val np = IntArray(mp.size + 1)
            for (j in mp.indices) { np[j] = np[j] xor g64mul(mp[j], GF64_EXP[cc]); np[j + 1] = np[j + 1] xor mp[j] }
            mp = np
        }
        val ng = IntArray(g.size + mp.size - 1)
        for (i in g.indices) if (g[i] != 0) for (j in mp.indices) ng[i + j] = ng[i + j] xor g64mul(g[i], mp[j])
        g = ng
    }
    var v = 0L
    for (i in g.indices) if (g[i] != 0) v = v or (1L shl i)
    v
}

/** The 64 bits a network code and frame type must produce: 16 data, 47 parity, one overall parity. */
private fun nidWord(nac: Int, duid: Int): Long {
    val data = ((nac shl 4) or duid).toLong() and 0xFFFF
    var reg = data shl 47
    for (b in 62 downTo 47) if (((reg shr b) and 1L) != 0L) reg = reg xor (BCH_GEN shl (b - 47))
    val cw = (data shl 47) or (reg and ((1L shl 47) - 1))
    val par = java.lang.Long.bitCount(cw).toLong() and 1L
    return (cw shl 1) or par
}

/** Hamming (10,6): six data bits and four parity, correcting one bit. The data, or −1. */
private val H106 = intArrayOf(0x0e, 0x0d, 0x0b, 0x07, 0x03, 0x0c)
private fun hamming106(word: Int): Int {
    val data = (word shr 4) and 0x3f; val par = word and 0xf
    var syn = par
    for (i in 0 until 6) if ((data and (1 shl (5 - i))) != 0) syn = syn xor H106[i]
    if (syn == 0) return data
    for (i in 0 until 6) if (syn == H106[i]) return data xor (1 shl (5 - i))
    for (i in 0 until 4) if (syn == (1 shl i)) return data
    return -1
}

class P25Decoder {
    var onLog: (String) -> Unit = {}
    /** Raw 144-bit voice frames as they come out of an LDU, for the vocoder. */
    var onVoice: (IntArray) -> Unit = {}

    private var nac = -1; private var duid = -1
    private var frameName = ""; private var tg = 0; private var src = 0; private var enc = false; private var lcf = 0
    private var frames = 0; private var errs = 0
    /** Sample at which the last good frame was read, so the receiver can tell a live stream from a stale lock. */
    var lastFrame = -1_000_000_000L; private set
    private var locked = false
    private val nacVotes = HashMap<Int, Int>()
    private val nidCache = HashMap<Int, List<Pair<Long, Int>>>()
    private var sym = 0
    private val info = IntArray(900)
    private var nInfo = 0
    private var want = 0
    /** 0 idle, 1 skip (stepping over the next frame's sync without waiting for it to be detected), 2 nid, 3 body. */
    private var state = 0
    private val voice = IntArray(144)

    fun reset() {
        nac = -1; duid = -1; frameName = ""; tg = 0; src = 0; enc = false
        lcf = 0; frames = 0; errs = 0; nacVotes.clear()
        idle()
    }

    /** The signal went away: stop collecting, but keep what was decoded so the UI can still show the last call. */
    fun idle() { locked = false; want = 0; nInfo = 0; sym = 0; state = 0 }

    /**
     * P25 frames run back to back, so the moment one ends the next one's sync is already arriving. Keeping the
     * symbol clock and stepping over those 24 symbols decodes the next frame even when its sync correlation was
     * too weak to fire; the Network ID's own error correction then says whether a frame was really there.
     */
    private fun expectNext() { sym = 0; nInfo = 0; want = 24; state = 1 }

    fun status(now: Long) = P25Status(locked, nac, duid, frameName, tg, src, enc, lcf, frames, errs, now - lastFrame)

    /** A frame sync was recognized: the next symbol is index 24 of a new frame. */
    fun sync(now: Long) { sym = 24; nInfo = 0; want = 32; state = 2; lastFrame = now; locked = true }

    /** One recovered dibit. Status symbols are dropped here; everything else accumulates into the frame. */
    fun push(dibit: Int, now: Long) {
        if (state == 0) return
        val isStatus = sym % 36 == 35
        sym++
        if (isStatus) return
        if (state == 1) {
            if (--want > 0) return
            state = 2; nInfo = 0; want = 32
            return
        }
        info[nInfo++] = dibit
        if (--want > 0) return
        if (state == 2) onNid(now) else onBody(now)
    }

    private fun candidates(n: Int): List<Pair<Long, Int>> = nidCache.getOrPut(n) {
        if (nidCache.size > 8) nidCache.clear()
        DUID_NAME.keys.map { nidWord(n, it) to it }
    }

    /** [from] is a bit offset into the collected dibits, high bit of each dibit first. */
    private fun bits(from: Int, count: Int): Long {
        var v = 0L
        for (i in 0 until count) { val b = from + i; val d = info[b shr 1]; v = v * 2 + (if ((b and 1) != 0) d and 1 else d shr 1) }
        return v
    }

    /**
     * The Network ID: 16 data bits inside a BCH (64,16) code word. Reading the data straight out would throw a
     * frame away for one bad bit; the code carries eleven errors and only seven frame types exist, so the
     * received word is matched against every legal one for this system instead.
     */
    private fun onNid(now: Long) {
        val word = (bits(0, 32) shl 32) or bits(32, 32)
        var bd = 99; var bnac = -1; var bduid = -1
        val nacs = linkedSetOf(bits(0, 12).toInt()).also { if (nac >= 0) it.add(nac) }
        for (n in nacs) for ((w, du) in candidates(n)) {
            val d = java.lang.Long.bitCount(word xor w)
            if (d < bd) { bd = d; bnac = n; bduid = du }
        }
        if (bd > 11) { errs++; idle(); return }
        nacVotes[bnac] = (nacVotes[bnac] ?: 0) + 1
        if (nacVotes.size > 8) nacVotes.clear()
        nac = bnac; duid = bduid; frames++; lastFrame = now
        frameName = DUID_NAME[bduid] ?: ""
        val body = (DUID_SYMBOLS[bduid] ?: 0) - 56
        if (body <= 0) { report(); expectNext(); return }
        want = body; state = 3
    }

    private fun onBody(now: Long) {
        lastFrame = now
        expectNext()
        if (duid == 0x5 || duid == 0xa) onLdu()
        report()
    }

    /** Nine 144-bit vocoder frames with link control (LDU1) or encryption sync (LDU2) threaded between them. */
    private fun onLdu() {
        var at = 32
        val lc = ArrayList<Int>(120)
        fun takeVoice() {
            for (i in 0 until 72) { val d = info[at + i]; voice[i * 2] = d shr 1; voice[i * 2 + 1] = d and 1 }
            at += 72; onVoice(voice)
        }
        fun takeLc() { for (i in 0 until 20) lc.add(info[at + i]); at += 20 }
        takeVoice(); takeVoice()
        repeat(6) { takeLc(); takeVoice() }
        at += 16                                            // low speed data
        takeVoice()
        if (duid == 0x5) decodeLc(lc)
    }

    /** 24 Hamming (10,6) words carrying 24 hex symbols, an RS(24,12) code word; the 12 left are 72 bits of call. */
    private fun decodeLc(lcDibits: List<Int>) {
        if (lcDibits.size < 120) return
        val hex = IntArray(24)
        var bad = 0
        for (w in 0 until 24) {
            var word = 0
            for (i in 0 until 5) word = word * 4 + lcDibits[w * 5 + i]
            val h = hamming106(word)
            if (h < 0) { bad++; hex[w] = 0 } else hex[w] = h
        }
        if (rsDecode(hex, 12) < 0 || bad > 6) { errs++; return }
        fun bit(i: Int) = (hex[i / 6] shr (5 - i % 6)) and 1
        fun f(from: Int, count: Int): Int { var v = 0; for (i in 0 until count) v = v * 2 + bit(from + i); return v }
        val format = f(2, 6); val svc = f(16, 8)
        lcf = format
        enc = bit(0) == 1 || (svc and 0x40) != 0
        if (format == 0x00) { tg = f(32, 16); src = f(48, 24) }          // group call: talkgroup then source
        else if (format == 0x03) { tg = f(24, 24); src = f(48, 24) }     // unit to unit: destination then source
    }

    private fun report() {
        val who = if (tg != 0 || src != 0) " · TG $tg <- $src" else ""
        onLog("P25 NAC ${Integer.toHexString(nac).uppercase()} $frameName$who${if (enc) " · ENCRYPTED" else ""}")
    }
}
