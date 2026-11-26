package com.rocketgod.mayhem.core.hd

import com.rocketgod.mayhem.core.ham.SincResampler
import com.rocketgod.mayhem.core.hd.hdc.HdcCore
import com.rocketgod.mayhem.core.hd.hdc.HdcSbr
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

private const val OUT = 48_000
private const val PKT = 2048
/** The buffer depth that starts (and after a dropout restarts) the digital audio. */
private const val START = 2 * OUT
/** Room for the station's diversity delay (digital leads its analog by several seconds) and the start buffer. */
private const val CAP = 14 * OUT
private val FADE = (0.06 * OUT).roundToInt()
/** Packets bad or lost in a row (about 1 s) before the program counts as gone and the fallback plays. */
private const val BAD_RUN = 22
/** The decoder's full scale against the analog FM's level here. */
private const val GAIN = 0.75f
/** A frame this loud came from bit errors the CRC missed. */
private const val WILD = 4f
/** The buffer's low point each window stays between these: a sample in 1000 skipped or repeated until it is back. */
private const val TROUGH_LO = 0.15 * OUT
private const val TROUGH_HI = CAP - OUT
private const val WINDOW = 4 * OUT
/** HD1 is lined up with the analog over this much of it, first at 1 kHz, then sample-exact. */
private const val ALIGN = 2 * OUT
private const val DEC = 48
private const val FINE = OUT / 4
private const val HIST = 3 * OUT
/** Digital ahead of the match point when HD1 switches: one L1 frame's burst (1.486 s) and some. */
private const val MARGIN = 1.7 * OUT
/** Waiting this long for a match starts the digital unaligned. */
private const val ALIGN_WAIT = 12 * OUT
/** A true match is near 1; music's own repeats give false ones around 0.5. */
private const val MATCH = 0.75
/** The level meter's window. */
private const val VU_N = 1024

class HdAudioStatus(
    val program: Int, /** "digital", "analog" or "silent" */ val state: String, val filling: Boolean, val bufferS: Double,
    val good: Int, val bad: Int, val lost: Int, val underruns: Int, val msPerPacket: Double,
)

private fun crc8ok(p: IntArray): Boolean {
    var c = 0xFF
    for (i in 0 until p.size - 1) { c = c xor p[i]; for (k in 0 until 8) c = if (c and 0x80 != 0) ((c shl 1) xor 0x31) and 255 else (c shl 1) and 255 }
    return c == p[p.size - 1]
}

/** One HD program's digital audio, buffered about 2 s; [lock] guards queue and ring, [decLock] the decoder. */
class HdAudio {
    @Volatile var program = 0; private set
    private val lock = Any()
    private val decLock = Any()
    private var core = HdcCore()
    private var sbr = HdcSbr()
    private val rsL = SincResampler(44_100.0, OUT.toDouble(), 1, 32, 512)
    private val rsR = SincResampler(44_100.0, OUT.toDouble(), 1, 32, 512)
    /** Packets waiting to be decoded, CRC bytes removed; null for one lost or failed. */
    private val queue = ArrayDeque<IntArray?>()
    private class Front(val seq: Int, val bytes: IntArray?)
    private var front: Front? = null
    private var nextSeq = -1
    private var badRun = BAD_RUN + 1
    private val ringL = FloatArray(CAP)
    private val ringR = FloatArray(CAP)
    private val okRing = ByteArray(CAP)
    private var r = 0; private var w = 0; private var n = 0
    private var playing = false
    private var blend = 0.0
    private var lastL = 0.0; private var lastR = 0.0
    private var written = 0
    private val aHist = FloatArray(HIST)
    private var aw = 0; private var aCount = 0; private var waited = 0; private var nextTry = 0
    private var flip = 1; private var dGain = 1.0; private var aligned = false
    private var trough = CAP; private var since = 0; private var trim = 0; private var trimAt = 0
    private val pl = FloatArray(PKT)
    private val pr = FloatArray(PKT)
    private val outL = FloatArray(PKT + 256)
    private val outR = FloatArray(PKT + 256)
    private var good = 0; private var bad = 0; private var lost = 0; private var underruns = 0; private var decodeMs = 0.0; private var decoded = 0

    /** True while the output is upmixed to 5.1 (set only when the device plays 6 channels). */
    @Volatile var surround = false; private set
    private var up: Upmixer? = null
    /** The engine's mute, so the level meter reads what is heard. */
    @Volatile var muted = false
    private val vuL = FloatArray(VU_N); private val vuR = FloatArray(VU_N)
    private var vuW = 0; private var vuAt = 0L
    private val vuLv = FloatArray(2)

    fun setSurround(on: Boolean) = synchronized(lock) {
        if (on && up == null) up = Upmixer(OUT)
        if (on && !surround) up!!.reset()
        surround = on
    }

    /** [mix], then the 5.1 upmix when surround is on: [L, R] or [L, R, C, LFE, Ls, Rs]. */
    fun output(a: FloatArray, n: Int): Array<FloatArray> {
        val (l, r) = mix(a, n)
        val u = up
        val out = synchronized(lock) { if (surround && u != null) u.process(l, r, n) else arrayOf(l, r) }
        synchronized(vuL) {
            val o0 = out[0]; val o1 = out[1]
            for (i in 0 until n) { vuL[vuW] = o0[i]; vuR[vuW] = o1[i]; vuW = (vuW + 1) % VU_N }
            vuAt = System.currentTimeMillis()
        }
        return out
    }

    /** The output level of L and R, 0..1, over the last 1024 samples: rises at once, falls back smoothly. */
    fun levels(): FloatArray = synchronized(vuL) {
        val live = !muted && System.currentTimeMillis() - vuAt < 250
        for ((i, b) in arrayOf(vuL, vuR).withIndex()) {
            var s = 0.0
            if (live) for (v in b) s += v.toDouble() * v
            val pct = ((10 * kotlin.math.log10(s / VU_N + 1e-12) + 54) / 50).coerceIn(0.0, 1.0).toFloat()
            vuLv[i] = if (pct > vuLv[i]) pct else vuLv[i] * 0.85f + pct * 0.15f
        }
        vuLv.copyOf()
    }

    fun select(program: Int) { if (program != this.program) { this.program = program; reset() } }

    fun reset() = synchronized(decLock) {
        synchronized(lock) {
            core = HdcCore(); sbr = HdcSbr(); rsL.reset(); rsR.reset()
            queue.clear(); front = null; nextSeq = -1; badRun = BAD_RUN + 1
            r = 0; w = 0; n = 0; playing = false; lastL = 0.0; lastR = 0.0; written = 0; waited = 0; flip = 1; dGain = 1.0; aligned = false
            trough = CAP; since = 0; trim = 0
            good = 0; bad = 0; lost = 0; underruns = 0; decodeMs = 0.0; decoded = 0
        }
    }

    /** One L1 frame's audio PDUs (the L2 PDU bytes they sit in). */
    fun addFrame(by: IntArray, pdus: List<HdL2.AudioPdu>) { synchronized(lock) { take(by, pdus) } }

    private fun take(by: IntArray, pdus: List<HdL2.AudioPdu>) {
        val d = pdus.firstOrNull { it.program == program && it.streamId == 0 } ?: return
        val pk = ArrayList<IntArray>()
        var start = d.off + d.la + 1
        for (loc in d.locators) {
            val end = d.off + loc
            if (end < start || end >= by.size) return
            pk.add(by.copyOfRange(start, end + 1)); start = end + 1
        }
        if (pk.isEmpty()) return
        // every piece carries its own CRC, a packet split across two frames too (each half)
        val first = (d.pktSeq - (if (d.pfirst) 1 else 0)) and 63
        val fr = front
        if (fr != null && !(d.pfirst && fr.seq == first)) { deliver(fr.seq, null); front = null }
        for (j in pk.indices) {
            val seq = (first + j) and 63; val p = if (pk[j].size >= 2 && crc8ok(pk[j])) pk[j].copyOf(pk[j].size - 1) else null
            if (j == 0 && d.pfirst) {
                val f = front; front = null
                val fb = f?.bytes
                if (fb != null && p != null) deliver(seq, fb + p)
                else deliver(seq, null)
            } else if (j == pk.size - 1 && d.plast) front = Front(seq, p)
            else deliver(seq, p)
        }
    }

    private fun deliver(seq: Int, bytes: IntArray?) {
        if (nextSeq < 0) { nextSeq = (seq + 1) and 63; if (bytes == null) return }
        else {
            val gap = (seq - nextSeq) and 63
            if (gap >= 48) return                        // behind: a repeat
            for (i in 0 until gap) { queue.addLast(null); lost++ }
            nextSeq = (seq + 1) and 63
        }
        if (bytes != null) queue.addLast(bytes)
        else { queue.addLast(null); bad++ }
        while (queue.size > 200) queue.removeFirst()
    }

    /** Decode one waiting packet into the buffer; false when none waits. */
    fun decodeOne(): Boolean { synchronized(decLock) { return decodeLocked() } }

    private fun decodeLocked(): Boolean {
        val pkt: IntArray?
        synchronized(lock) { if (queue.isEmpty()) return false; pkt = queue.removeFirst() }
        val t0 = System.nanoTime()
        var f = core.decode(pkt ?: IntArray(0))
        var ok = pkt != null && f.error == null
        if (ok && wild(f.pcm)) { ok = false; f = core.undo() }
        val o = sbr.process(f.pcm, f.stereo, if (ok) f.sbr else null, f.conceal)
        val lb = pl; val rb = pr
        val peak = split(o, lb, rb)
        if (peak > WILD || !peak.isFinite()) { ok = false; lb.fill(0f); rb.fill(0f) }
        if (ok) badRun = 0 else badRun++
        val alive = badRun <= BAD_RUN
        if (!alive) { lb.fill(0f); rb.fill(0f) }
        for (i in 0 until PKT) { lb[i] = clip(lb[i]); rb[i] = clip(rb[i]) }
        val nOut = rsL.process(lb, PKT, outL)
        rsR.process(rb, PKT, outR)
        synchronized(lock) {
            if (ok) good++
            for (i in 0 until nOut) {
                if (n >= CAP) { r = (r + 1) % CAP; n-- }
                ringL[w] = outL[i]; ringR[w] = outR[i]; okRing[w] = if (alive) 1 else 0; w = (w + 1) % CAP; n++
                if (written < CAP) written++
            }
            decodeMs += (System.nanoTime() - t0) / 1e6; decoded++
        }
        return true
    }

    /** Core output this loud (or not finite) came from bit errors the CRC missed. */
    private fun wild(pcm: List<FloatArray>): Boolean {
        for (c in pcm) for (v in c) { val a = abs(v) * GAIN; if (!(a <= WILD)) return true }
        return false
    }

    private fun clip(v: Float): Float = if (v > 1f) 1f else if (v < -1f) -1f else if (v.isNaN()) 0f else v

    /** Decoder output at the playing gain into l and r (a mono program on both); returns the peak. */
    private fun split(o: List<FloatArray>, l: FloatArray, r: FloatArray): Float {
        val b = if (o.size > 1) o[1] else o[0]
        var peak = 0f
        for (i in 0 until PKT) {
            l[i] = o[0][i] * GAIN; r[i] = b[i] * GAIN
            val a = max(abs(l[i]), abs(r[i])); if (a > peak) peak = a
        }
        return peak
    }

    private fun start() { playing = true; trough = CAP; since = 0; waited = 0; nextTry = 0 }

    private fun mid(j: Int): Double { val k = ((j % CAP) + CAP) % CAP; return ringL[k].toDouble() + ringR[k] }

    /** Lines HD1's digital up with the analog now playing (the read point, polarity and level); false to keep waiting. */
    private fun align(chunk: Int): Boolean {
        aligned = false
        if (aCount < ALIGN || written < ALIGN + FINE) return false
        val nA = ALIGN / DEC; val A = FloatArray(nA)
        for (b in 0 until nA) { var v = 0.0; for (k in 0 until DEC) v += aHist[(aw - ALIGN + b * DEC + k + HIST) % HIST]; A[b] = v.toFloat() }
        val nD = floor(written.toDouble() / DEC).toInt(); val D = FloatArray(nD); val d0 = w - nD * DEC
        for (b in 0 until nD) { var v = 0.0; for (k in 0 until DEC) v += mid(d0 + b * DEC + k); D[b] = v.toFloat() }
        var best = 0.0; var at = -1
        for (e in nA..nD) {
            var ab = 0.0; var aa = 0.0; var bb = 0.0
            for (b in 0 until nA) { val x = A[b].toDouble(); val y = D[e - nA + b].toDouble(); ab += x * y; aa += x * x; bb += y * y }
            val c = ab / sqrt(aa * bb + 1e-20)
            if (abs(c) > abs(best)) { best = c; at = e }
        }
        if (abs(best) < 0.5) return false
        // sample-exact: the ring index that matches the newest analog sample
        val coarse = d0 + at * DEC - 1
        var fBest = 0.0; var j = coarse; var ea = 0.0; var ed = 0.0
        for (lag in -2 * DEC..2 * DEC) {
            var ab = 0.0; var aa = 0.0; var bb = 0.0
            for (k in 0 until FINE) { val x = aHist[(aw - FINE + k + HIST) % HIST].toDouble(); val y = mid(coarse + lag - FINE + 1 + k); ab += x * y; aa += x * x; bb += y * y }
            val c = ab / sqrt(aa * bb + 1e-20)
            if (abs(c) > abs(fBest)) { fBest = c; j = coarse + lag; ea = aa; ed = bb }
        }
        // this chunk's first sample plays against its first analog sample
        val rr = ((j + 1 - chunk) % CAP + CAP) % CAP; val nn = (w - rr + CAP) % CAP
        if (abs(fBest) < MATCH || nn < MARGIN) return false
        r = rr; n = nn
        flip = if (fBest < 0) -1 else 1
        dGain = min(4.0, max(0.25, 2 * sqrt(ea / (ed + 1e-20))))
        aligned = true
        return true
    }

    /** What plays for one chunk of the analog audio (48 kHz mono, ±1): left and right. */
    fun mix(a: FloatArray, len: Int = a.size): Pair<FloatArray, FloatArray> = synchronized(lock) {
        val analog = program == 0; val L = FloatArray(len); val R = FloatArray(len)
        for (i in 0 until len) { aHist[aw] = a[i]; aw = (aw + 1) % HIST }
        aCount = min(HIST, aCount + len)
        if (!playing && n >= START) {
            if (!analog) start()
            else if (waited >= nextTry && align(len)) start()
            else if (waited >= nextTry) nextTry = waited + OUT / 4
            if (analog && !playing) { waited += len; if (waited >= ALIGN_WAIT) { flip = 1; dGain = 1.0; start() } }
        }
        val g = if (analog && aligned) flip * dGain else 1.0
        for (i in 0 until len) {
            var dl = 0.0; var dr = 0.0; var ok = false
            if (playing) {
                if (n > 0) {
                    dl = ringL[r].toDouble(); dr = ringR[r].toDouble(); ok = okRing[r].toInt() == 1; lastL = dl; lastR = dr
                    var adv = 1
                    if (trim != 0 && ++trimAt >= 1000) { trimAt = 0; adv = if (trim > 0) 2 else 0 }
                    adv = min(adv, n); r = (r + adv) % CAP; n -= adv
                } else { playing = false; underruns++ }
                if (n < trough) trough = n
                if (++since >= WINDOW) {
                    val t = trough
                    trim = if (t > TROUGH_HI) 1 else if (t < TROUGH_LO) -1 else if ((trim > 0 && t < OUT) || (trim < 0 && t > 0.75 * OUT)) 0 else trim
                    trough = CAP; since = 0
                }
            }
            if (!playing) { lastL *= 0.995; lastR *= 0.995; dl = lastL; dr = lastR }
            val want = if (playing && ok) 1.0 else 0.0
            if (blend != want) blend = if (want > blend) min(1.0, blend + 1.0 / FADE) else max(0.0, blend - 1.0 / FADE)
            val an = (1 - blend) * (if (analog) a[i].toDouble() else 0.0)
            L[i] = (blend * g * dl + an).toFloat(); R[i] = (blend * g * dr + an).toFloat()
        }
        L to R
    }

    fun status(): HdAudioStatus = synchronized(lock) {
        HdAudioStatus(
            program, if (blend > 0.5) "digital" else if (program == 0) "analog" else "silent",
            !playing, n.toDouble() / OUT, good, bad, lost, underruns,
            if (decoded > 0) decodeMs / decoded else 0.0,
        )
    }
}
