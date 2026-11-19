package com.rocketgod.mayhem.core.fleet

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * One 12.5 kHz channel, from complex baseband to blocks: a differential-phase 4-level demodulator that serves C4FM,
 * CQPSK/LSM and DMR alike (the phase step across one symbol), symbol timing picked again for every block of 480
 * symbols so a dropped sample costs one block, the P25 and DMR framers, and a Morse reader for CW IDs.
 */
const val BAUD = 4800
private const val BLOCK = 480

/**
 * Soft 4-level symbols (about ±1 / ±3) from complex samples. [diff] is the phase-step span as a fraction of a symbol.
 * A whole symbol suits P25 and DMR; NXDN's outer levels turn the phase by nearly half a turn a symbol, so it measures
 * over half a symbol to stay clear of the wrap.
 */
class SymbolRx(val fs: Double, baud: Double = BAUD.toDouble(), diff: Double = 1.0) {
    var onSymbol: (Float) -> Unit = {}
    val sps = fs / baud
    private val dl = max(1, (sps * diff).roundToInt())
    private val ri = FloatArray(dl); private val rq = FloatArray(dl); private var rp = 0
    private var buf = FloatArray(ceil(sps * BLOCK * 2).toInt() + 64); private var n = 0; private var base = 0L
    private var tNext = 0.0
    private var w = 0.0; private var ph = 0.0
    var center = 0.0; var level = 0.0
    /** Eye opening of the last block: energy at the chosen phase over the mean of all phases. */
    var eye = 1.0
    var envMean = 0.0; var envVar = 0.0; var power = 0.0
    var symbols = 0L

    /** Coarse frequency correction (Hz) to start from. */
    fun setOffset(hz: Double) { w = -2 * PI * hz / fs }
    val offsetHz: Double get() = -w * fs / (2 * PI)

    fun push(zi: FloatArray, zq: FloatArray, count: Int) {
        var p = ph; var envM = envMean; var envV = envVar; var pw = power
        for (k in 0 until count) {
            val c = cos(p); val s = sin(p)
            p += w; if (p > PI) p -= 2 * PI else if (p < -PI) p += 2 * PI
            val a = (zi[k] * c - zq[k] * s).toFloat(); val b = (zi[k] * s + zq[k] * c).toFloat()
            val pa = ri[rp]; val pb = rq[rp]
            ri[rp] = a; rq[rp] = b; if (++rp >= dl) rp = 0
            val re = a * pa + b * pb; val im = b * pa - a * pb
            val m2 = (a * a + b * b).toDouble(); val m = sqrt(m2)
            pw += 0.0005 * (m2 - pw); envM += 0.0005 * (m - envM); envV += 0.0005 * ((m - envM) * (m - envM) - envV)
            if (n >= buf.size) grow()
            buf[n++] = atan2(im, re)
        }
        ph = p; envMean = envM; envVar = envV; power = pw
        val need = ceil(sps * (BLOCK + 2)).toInt() + 2
        while (n >= need) block()
    }
    /** Envelope variation over its mean: near 0 for constant-envelope FM, about 0.3 for linear modulation. */
    val envCv: Double get() = if (envMean > 0) sqrt(max(0.0, envVar)) / envMean else 0.0

    /**
     * A chunk bigger than the buffer (a long recording fed at once): the buffer grows. It used to keep only the last
     * four symbols, which threw away the rest of the chunk mid-frame and cost P25 voice frames whole.
     */
    private fun grow() { buf = buf.copyOf(buf.size * 2) }
    private fun at(t: Double): Double {
        val i = floor(t).toInt(); val f = t - i
        return buf[i] * (1 - f) + buf[min(i + 1, n - 1)] * f
    }
    /** Decode what is left in the buffer as a short last block. */
    fun flush() { val k = floor(n / sps).toInt() - 2; if (k > 20) block(k) }
    private fun block(nsym: Int = BLOCK) {
        val tt = sps; val len = nsym * tt
        var best = 0.0; var bestE = -1.0; var sumE = 0.0
        for (p in 0 until 8) {
            val off = p * tt / 8
            var e = 0.0
            for (k in 0 until nsym) { val x = at(off + k * tt) - center; e += x * x }
            sumE += e
            if (e > bestE) { bestE = e; best = off }
        }
        eye = if (sumE > 0) bestE / (sumE / 8) else 1.0
        // continue the previous grid: the first symbol of this block is the one at least half a symbol after the last
        val t0 = tNext - base
        var k0 = ceil((t0 - tt / 2 - best) / tt).toInt(); if (k0 < 0) k0 = 0
        val vals = ArrayList<Double>(nsym + 4)
        var t = best + k0 * tt
        while (t < len) { vals.add(at(t)); t += tt }
        tNext = base + t
        // eye levels: the outer quarter of each side
        val sorted = FloatArray(vals.size) { vals[it].toFloat() }.also { it.sort() }; val q = max(1, sorted.size / 4)
        var lo = 0.0; var hi = 0.0; for (i in 0 until q) { lo += sorted[i]; hi += sorted[sorted.size - 1 - i] }; lo /= q; hi /= q
        val c = (hi + lo) / 2; val l = (hi - lo) / 2
        if (l > 0.2) {
            center = if (level > 0) center + 0.5 * (c - center) else c
            level = if (level > 0) level + 0.5 * (l - level) else l
            // the AFC takes the center out, so the phase steps stay clear of the ±π wrap
            w -= 0.5 * center / dl; center *= 0.5
            val lim = 2 * PI * 2500 / fs; if (w > lim) w = lim else if (w < -lim) w = -lim
        }
        val sc = if (level > 0) 3 / level else 1.0
        for (v in vals) { symbols++; onSymbol(((v - center) * sc).toFloat()) }
        val used = floor(len).toInt()
        buf.copyInto(buf, 0, used, n); n -= used; base += used
    }
}

fun slice(s: Float): Int = if (s > 2) 1 else if (s > 0) 0 else if (s > -2) 2 else 3

/** Normalized correlation of the last 24 symbols against a sign pattern. */
private class SyncMatch {
    private val ring = FloatArray(24); private var p = 0
    fun push(s: Float) { ring[p] = s; p = (p + 1) % 24 }
    fun corr(sig: IntArray): Float {
        var c = 0f; var a = 0f
        for (k in 0 until 24) { val x = ring[(p + k) % 24]; c += x * sig[k]; a += abs(x) }
        return if (a > 0) c / a else 0f
    }
    /** Mean magnitude of the window: a sync is all outer symbols. */
    fun mag(): Float { var a = 0f; for (k in 0 until 24) a += abs(ring[k]); return a / 24 }
}

class P25Block(val nac: Int, val nidErrs: Int, val bytes: IntArray, val crcOk: Boolean, val metric: Int, val index: Int)
private val P25S = Codes.syncSigns(Codes.P25_SYNC)

/** P25 Phase 1: frame sync, NID, status symbols out, trunking blocks through the trellis and CRC. */
class P25Framer {
    var onBlock: (P25Block) -> Unit = {}
    /** Any frame with a valid NID (voice and data frames too): the NAC and DUID. */
    var onFrame: (Int, Int) -> Unit = { _, _ -> }
    private val sm = SyncMatch()
    private enum class St { IDLE, NID, BODY, SKIP }
    private var state = St.IDLE
    private var pos = 0; private val buf = IntArray(400); private var nb = 0; private var want = 0
    private var nac = -1; private var nidErrs = 0; private var blk = 0; private var flywheel = 0
    val nacs = LinkedHashSet<Int>()
    var syncs = 0; var frames = 0
    /** Frames whose NID came through with at most 4 bit errors. */
    var clean = 0
    fun push(s: Float) {
        sm.push(s)
        if (state != St.BODY && state != St.NID && sm.corr(P25S) > 0.82f && sm.mag() > 1.8f) { syncs++; begin(); return }
        if (state == St.IDLE) return
        val at = pos++
        if (Codes.isStatusPos(at)) return
        // frame positions run on across frames (360 symbols, a multiple of 36): the next sync ends at 360 + 23
        if (state == St.SKIP) { if (at >= 383) { state = St.NID; pos = 24; nb = 0; want = 32 }; return }
        buf[nb++] = slice(s)
        if (nb < want) return
        if (state == St.NID) nid() else body()
    }
    private fun begin() { state = St.NID; pos = 24; nb = 0; want = 32; flywheel = 0 }
    private fun nid() {
        val r = Codes.nidDecode(buf, nacs)
        if (r == null) { state = St.IDLE; return }
        frames++; nac = r.nac; nidErrs = r.errs; if (r.errs <= 4) clean++
        if (r.errs <= 4) { nacs.add(r.nac); if (nacs.size > 6) nacs.remove(nacs.first()) }
        onFrame(r.nac, r.duid)
        if (r.duid == 7) { state = St.BODY; nb = 0; want = 98; blk = 0 } else state = St.IDLE
    }
    private fun body() {
        val t = Codes.tsbkDecode(buf)
        val ok = Codes.crc12Ok(t.bytes)
        onBlock(P25Block(nac, nidErrs, t.bytes, ok, t.metric, blk))
        blk++
        if (blk >= 3 || (ok && (t.bytes[0] and 0x80) != 0)) {
            // frames run back to back: carry the clock across the next sync, at most a few frames without one
            if (blk >= 3 && flywheel < 4) { flywheel++; state = St.SKIP } else state = St.IDLE
            return
        }
        nb = 0; want = 98
    }
}

class DmrEvent(val burst: Codes.DmrBurst, val dibits: IntArray)
private val DMR_BS_DATA = Codes.syncSigns(Codes.DMR_BS_DATA)
private val DMR_BS_VOICE = Codes.syncSigns(Codes.DMR_BS_VOICE)
private val DMR_MS_DATA = Codes.syncSigns(Codes.DMR_MS_DATA)
private val DMR_MS_VOICE = Codes.syncSigns(Codes.DMR_MS_VOICE)

/**
 * DMR base-station bursts: sync, CACH slot, slot type, BPTC. A voice sync starts a superframe: its burst and the five
 * after it in the same slot (every 288 symbols) are handed over as voice bursts.
 */
class DmrFramer {
    var onBurst: (DmrEvent) -> Unit = {}
    /** A voice burst: its slot from the CACH, the 144 dibits, and its place in the superframe (0 = the one with the sync). */
    var onVoice: (slot: Int, dibits: IntArray, n: Int) -> Unit = { _, _, _ -> }
    private class Sf(var slot: Int)
    private class Q(val at: Long, val voice: Boolean, val n: Int, val sf: Sf)
    private val sm = SyncMatch()
    private val hist = IntArray(144); private var hp = 0
    private var t = 0L; private var lastData = -1_000_000_000L
    private var queue = ArrayList<Q>()
    var syncs = 0; var voice = 0; var ms = 0
    /** Data bursts whose slot type came through without a correction: a real DMR signal, where a sync alone can be chance. */
    var bursts = 0
    /** Voice syncs heard lately, and when one last came a superframe (1728 symbols, 360 ms) after another. */
    private val voiceAt = ArrayList<Long>(); private var confirmedAt = -1_000_000_000L
    /** Voice superframes are arriving on their own grid: a voice call heard without a data burst (late entry). */
    val voiceLive: Boolean get() = t - confirmedAt < 3_500
    fun push(s: Float) {
        sm.push(s)
        hist[hp] = slice(s); hp = (hp + 1) % 144
        val t = ++this.t
        while (queue.isNotEmpty() && queue[0].at <= t) emit(queue.removeAt(0))
        if (queue.any { !it.voice && it.at > t }) return
        if (sm.mag() < 1.8f) return
        if (sm.corr(DMR_BS_DATA) > 0.82f) {
            syncs++
            queue.removeAll { abs(it.at - (t + 54)) <= 10 }
            add(Q(t + 54, false, 0, Sf(-1)))
        } else if (sm.corr(DMR_BS_VOICE) > 0.82f) {
            if (queue.any { it.voice && it.n == 0 && abs(it.at - (t + 54)) <= 10 }) return
            // bursts come every 144 symbols: a voice sync off the grid of the data bursts heard lately is in some payload
            // (the grid is set only by data bursts whose slot type came through clean, so a chance data sync moves nothing)
            val ph = (t - lastData) % 144
            if (t - lastData < 9_600 && ph > 2 && ph < 142) return
            syncs++; voice++
            if (voiceAt.any { abs(t - it - 1728) <= 4 }) confirmedAt = t
            voiceAt.add(t); if (voiceAt.size > 4) voiceAt.removeAt(0)
            val sf = Sf(-1)
            for (k in 0 until 6) add(Q(t + 54 + 288L * k, true, k, sf))
        }
        else if (sm.corr(DMR_MS_DATA) > 0.82f || sm.corr(DMR_MS_VOICE) > 0.82f) ms++
    }
    private fun add(q: Q) { queue.add(q); queue.sortBy { it.at } }
    private fun emit(q: Q) {
        val d = IntArray(144) { hist[(hp + it) % 144] }
        if (q.voice) {
            val cach = IntArray(24)
            for (i in 0 until 12) { cach[2 * i] = d[i] shr 1; cach[2 * i + 1] = d[i] and 1 }
            // the superframe's slot is the one its sync burst's CACH said: the five after it are in the same slot
            if (q.sf.slot < 0) q.sf.slot = Codes.cachSlot(cach)
            onVoice(q.sf.slot, d, q.n)
            return
        }
        val b = Codes.dmrReadBurst(d)
        if (b != null) { if (b.stErrs == 0) { bursts++; lastData = q.at - 54 }; onBurst(DmrEvent(b, d)) }
    }
}

private val MORSE = mapOf(
    ".-" to "A", "-..." to "B", "-.-." to "C", "-.." to "D", "." to "E", "..-." to "F", "--." to "G", "...." to "H", ".." to "I", ".---" to "J", "-.-" to "K", ".-.." to "L", "--" to "M",
    "-." to "N", "---" to "O", ".--." to "P", "--.-" to "Q", ".-." to "R", "..." to "S", "-" to "T", "..-" to "U", "...-" to "V", ".--" to "W", "-..-" to "X", "-.--" to "Y", "--.." to "Z",
    "-----" to "0", ".----" to "1", "..---" to "2", "...--" to "3", "....-" to "4", "....." to "5", "-...." to "6", "--..." to "7", "---.." to "8", "----." to "9", "-..-." to "/",
)
private val CALLSIGN = Regex("^[A-Z]{1,4}\\d{1,4}[A-Z]{0,4}(/[A-Z0-9]{1,3})?$")
/** A station ID: a letter prefix, digits, an optional letter suffix (W1AW, KA6XYZ, WQAB123, AB1CD/R). */
fun looksLikeCallsign(s: String) = CALLSIGN.matches(s) && s.length >= 4

/**
 * CW ID on an FM carrier: the discriminator's tone keyed on and off, read in 5 ms steps. A run of key-down lengths
 * becomes dots and dashes against the shortest mark; a pause of 0.4 s or the carrier dropping ends it.
 */
class CwReader(private val fs: Double) {
    var onText: (String) -> Unit = {}
    private var pi = 0f; private var pq = 0f; private var acc = 0.0; private var zc = 0; private var prev = 0.0; private var cnt = 0
    private var env = 0.0; private var env2 = 0.0
    private var hp = 0.0; private var floorP = 0.0; private var peak = 0.0
    private class Run(val on: Boolean, var n: Int)
    private var runs = ArrayList<Run>(); private var on = false; private var len = 0
    private val step = max(8, (fs * 0.005).roundToInt())
    fun reset() { runs = ArrayList(); on = false; len = 0; peak = 0.0; floorP = 0.0 }
    fun push(zi: FloatArray, zq: FloatArray, count: Int) {
        for (k in 0 until count) {
            val a = zi[k]; val b = zq[k]
            val f = atan2((b * pi - a * pq).toDouble(), (a * pi + b * pq).toDouble())
            pi = a; pq = b
            hp += 0.02 * (f - hp)
            val x = f - hp
            acc += x * x; val e2 = (a * a + b * b).toDouble(); env += sqrt(e2); env2 += e2
            if ((x > 0) != (prev > 0)) zc++
            prev = x
            if (++cnt >= step) window()
        }
    }
    private fun window() {
        val p = acc / cnt; val hz = zc * fs / (2 * cnt); val em = env / cnt; val ev = env2 / cnt - em * em
        acc = 0.0; zc = 0; cnt = 0; env = 0.0; env2 = 0.0
        // with the carrier down the discriminator puts out noise far louder than any tone: those windows (a noise-like
        // envelope, its spread over its mean about 0.5 against near 0 for a carrier) are key-up and leave the references alone
        val carrier = em > 0 && sqrt(max(0.0, ev)) / em < 0.3
        if (carrier) {
            floorP = if (floorP == 0.0) p else if (p < floorP) floorP + 0.2 * (p - floorP) else floorP + 0.002 * (p - floorP)
            peak = max(p, peak * 0.999)
        }
        val key = carrier && p > 4 * floorP && p > 0.4 * peak && hz > 300 && hz < 3000
        if (key == on) len++
        else { if (len > 0) runs.add(Run(on, len)); on = key; len = 1 }
        if (!on && len == 80 && runs.isNotEmpty()) finish()
        if (runs.size > 400) runs.subList(0, 200).clear()
    }
    /** The carrier went away: whatever was keyed is complete. */
    fun end() { if (len > 0) runs.add(Run(on, len)); on = false; len = 0; if (runs.isNotEmpty()) finish() }
    private fun finish() {
        val merged = ArrayList<Run>()
        for (r in runs) {
            if (r.n < 3 && merged.isNotEmpty()) { merged.last().n += r.n; continue }
            if (merged.isNotEmpty() && merged.last().on == r.on) merged.last().n += r.n else merged.add(Run(r.on, r.n))
        }
        runs = ArrayList()
        while (merged.isNotEmpty() && !merged[0].on) merged.removeAt(0)
        val marks = merged.filter { it.on }.map { it.n }
        if (marks.size < 4) return
        val sorted = marks.sorted(); val unit = sorted[floor(sorted.size * 0.2).toInt()].toDouble()
        // keyed Morse: every mark is a dot or a dash, one unit or three
        val clean = marks.count { m -> val u = m / unit; (u > 0.6 && u < 1.6) || (u > 2.2 && u < 4) }
        if (clean < marks.size * 0.85) return
        val txt = StringBuilder()
        for (r in merged) { val u = r.n / unit; txt.append(if (r.on) (if (u < 2) "." else "-") else (if (u < 2) "" else if (u < 5) " " else " / ")) }
        val text = txt.split('/').joinToString(" ") { w -> w.trim().split(Regex("\\s+")).joinToString("") { MORSE[it] ?: "?" } }.trim()
        if (text.isNotEmpty()) onText(text)
    }
}
