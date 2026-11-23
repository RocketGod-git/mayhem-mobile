package com.rocketgod.mayhem.core.cb

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * Home's CB demodulator, the one the owner signed off by ear ("holds well now"), in streaming form. Home works a
 * keyup at a time on a recording; here the same steps run as the samples come, each 10 ms:
 *  - the spectrum of the last 20 ms (Hann, zero-padded to about 6 Hz a bin) within 2.8 kHz of the center, its
 *    strongest bin and how far it stands over the median (q);
 *  - finding: over the first half second, the frequencies (to 10 Hz) of the bins standing 20 dB and more are counted;
 *    a station's carrier is one held for 8 % of those (or more), up to three of them 40 Hz apart, never one within
 *    8 Hz of an idle line. The most held is taken and the others are notched and kept out of its search;
 *  - tracking: each 10 ms the strongest bin within 60 Hz of the carrier's last frequency (50 Hz clear of the others),
 *    moving the carrier there when it stands 15 dB over the median; a gap of up to 1.5 s is bridged, a longer one
 *    ends the keyup and the next one is found afresh;
 *  - AM: the signal turned down by the carrier (the median of its last five readings), the carrier phasor from a 40 Hz
 *    low-pass, audio = the part in line with it over the carrier's level (a 5 Hz low-pass, never under 0.15 of its
 *    middle: about 16 dB of gain at most). FM when the envelope is flat (spread under 0.12 of its mean);
 *  - readable: a carrier whose median q over the keyup is 22 dB or more (under that it was static to the ear);
 *  - no carrier: single sideband when one side of the center (300 to 3000 Hz) holds 4 times the other (6 dB).
 * Twin of web dsp/cb/carrier.ts.
 */

const val HOP_MS = 10.0
const val WIN_MS = 20.0
const val SEARCH_HZ = 2_800.0
/** The sideband split: 300 to 3000 Hz either side in 25 Hz bands, each band's level kept in half-dB steps from -10 dB. */
const val SIDE_LO_HZ = 300.0
const val SIDE_HI_HZ = 3_000.0
const val SIDE_BAND_HZ = 25.0
const val SIDE_HIST = 120
const val SIDE_HIST_LO = 20
private class SideAcc(k: Int) { val sum = DoubleArray(k); val hist = IntArray(k * SIDE_HIST); var n = 0; var at = -1; var res: CbMode? = null }
const val STRONG_DB = 20.0
const val HELD_SHARE = 0.08
const val CAND_APART_HZ = 40.0
const val MAX_CAND = 3
const val ON_LINE_HZ = 8.0
const val FIND_MS = 500.0
const val TRACK_HZ = 60.0
const val OTHERS_HZ = 50.0
const val ON_DB = 15.0
const val BRIDGE_MS = 1_500.0
/** The held carrier gone this long while another stands strong elsewhere: a new keyup, found at once (ms). */
const val NEXT_KEYUP_MS = 300.0
const val SQUELCH_DB = 22.0
const val FLAT_FM = 0.12
const val LVL_FLOOR = 0.15
/** Lines are notched 12 Hz wide, and never within 30 Hz of the carrier. */
const val NOTCH_HZ = 12.0
const val NOTCH_CLEAR_HZ = 30.0
/** A notch keeps itself on its line within this far of where it was set (Hz). */
const val NOTCH_PULL_HZ = 25.0

/** A symmetric Hann window (the web's). */
internal fun hannSym(n: Int): FloatArray = FloatArray(n) { (0.5 - 0.5 * cos(2 * PI * it / (n - 1))).toFloat() }

/** A two-pole Butterworth section, designed by the bilinear transform. */
class Biquad(lp: Boolean, hz: Double, fs: Double, q: Double = sqrt(0.5)) {
    private val b0: Double; private val b1: Double; private val b2: Double; private val a1: Double; private val a2: Double
    private var x1 = 0.0; private var x2 = 0.0; private var y1 = 0.0; private var y2 = 0.0
    init {
        val w = 2 * PI * hz / fs; val c = cos(w); val s = sin(w); val al = s / (2 * q); val a0 = 1 + al
        if (lp) { b0 = (1 - c) / 2 / a0; b1 = (1 - c) / a0 } else { b0 = (1 + c) / 2 / a0; b1 = -(1 + c) / a0 }
        b2 = b0
        a1 = -2 * c / a0; a2 = (1 - al) / a0
    }
    fun step(x: Double): Double {
        val y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2 = x1; x1 = x; y2 = y1; y1 = y; return y
    }
}
/** Fourth-order Butterworth as two sections (Q 0.541 and 1.307). */
fun butter4(lp: Boolean, hz: Double, fs: Double): List<Biquad> = listOf(Biquad(lp, hz, fs, 0.5412), Biquad(lp, hz, fs, 1.3066))
/** A two-pole Butterworth twice over: the response of home's filtfilt of one. */
fun twice(lp: Boolean, hz: Double, fs: Double): List<Biquad> = listOf(Biquad(lp, hz, fs), Biquad(lp, hz, fs))
/** A sample through a chain of sections. */
fun run(fs: List<Biquad>, x0: Double): Double { var x = x0; for (f in fs) x = f.step(x); return x }

/**
 * Takes one steady line out: the signal turned down by it, a 12 Hz two-pole low-pass of that subtracted, turned back.
 * Home's low-pass runs both ways over the recording, so it takes no phase and a line a few Hz off its frequency still
 * cancels; streaming it can only run forward, so the notch keeps itself on the line instead (by how fast the low-passed
 * line turns, every 64 samples, never more than 25 Hz from where it was set).
 */
class LineNotch(hz: Double, private val fs: Double) {
    var hz = hz; private set
    private val li = Biquad(true, NOTCH_HZ, fs); private val lq = Biquad(true, NOTCH_HZ, fs)
    private var ph = 0.0; private val w0 = 2 * PI * hz / fs; private var w = w0
    private var n = 0; private var pr = 0.0; private var pq = 0.0; private val wMax = 2 * PI * NOTCH_PULL_HZ / fs

    fun run(xi: FloatArray, xq: FloatArray, m: Int) {
        for (k in 0 until m) {
            val c = cos(ph); val s = sin(ph); val i = xi[k].toDouble(); val q = xq[k].toDouble()
            val ui = i * c + q * s; val uq = q * c - i * s; val l1 = li.step(ui); val l2 = lq.step(uq)
            xi[k] = (i - (l1 * c - l2 * s)).toFloat(); xq[k] = (q - (l1 * s + l2 * c)).toFloat()
            ph += w; if (ph > PI) ph -= 2 * PI else if (ph < -PI) ph += 2 * PI
            if (++n >= 64) {
                n = 0
                if (pr != 0.0 || pq != 0.0) {
                    val d = atan2(l2 * pr - l1 * pq, l1 * pr + l2 * pq)
                    w = max(w0 - wMax, min(w0 + wMax, w + 0.3 * d / 64)); this.hz = w * fs / (2 * PI)
                }
                pr = l1; pq = l2
            }
        }
    }
}

internal fun median(a: List<Double>): Double { if (a.isEmpty()) return Double.NaN; val s = a.sorted(); return s[s.size shr 1] }

class CarrierChange(val ms: Double, val hz: Double)

class CarrierTracker(private val fs: Double) {
    /** The carrier (Hz from the center), whether one is held, how often it changed, and each change (ms in, Hz). */
    var hz = 0.0; private set
    var have = false; private set
    var switches = 0; private set
    val changes = ArrayList<CarrierChange>()
    /** The other stations' carriers found with it (notched), and the idle lines never taken for a carrier. */
    var others: List<Double> = emptyList(); private set
    var ignore: List<Double> = emptyList()
    /** Present now (on, or inside a bridged gap), and on in the last 10 ms itself. */
    var present = false; private set
    var onNow = false; private set
    /** The signal turned down by the carrier, the carrier phasor (40 Hz) and its level (5 Hz), written each sample. */
    var br = 0.0; private set
    var bi = 0.0; private set
    var cr = 0.0; private set
    var ci = 0.0; private set
    var lvl = 0.0; private set
    /** Each 10 ms while held and on: the carrier's frequency, its q and its level. */
    val log = ArrayList<Double>(); val qs = ArrayList<Double>(); val lvls = ArrayList<Double>()
    private var envS = 0.0; private var envS2 = 0.0; private var envN = 0
    private val b = (fs * WIN_MS / 1000).roundToInt(); private val hopN = (fs * HOP_MS / 1000).roundToInt(); private val nf: Int
    private val win = hannSym(b)
    private val ri = FloatArray(b); private val rq = FloatArray(b); private var rn = 0; private var filled = 0; private var n = 0; private var ms = 0.0
    /** Hops since the carrier was taken, and how many of them it stood 15 dB over the median. */
    var heldHops = 0; private set
    var onHops = 0; private set
    private var find = ArrayList<Double>(); private var findHops = 0; private var offMs = 0.0; private var recent = ArrayList<Double>(); private var elsewhere = 0.0
    private var ph = 0.0; private var w = 0.0; private var floorV = 0.0
    // each of home's low-passes is run forward and back (filtfilt), which squares its response: here each runs twice
    // forward, the same response with a delay instead of none
    private val carI = twice(true, 40.0, fs); private val carQ = twice(true, 40.0, fs); private val lvlF = twice(true, 5.0, fs)
    private var medQ = Double.NaN

    init { var x = 1; while (x < fs / 6) x = x shl 1; nf = x }

    val heldMs: Double get() = if (have) ms - (changes.lastOrNull()?.ms ?: 0.0) else 0.0
    /** The level floor: 0.15 of the carrier's middle level over the keyup. */
    fun floor(): Double = floorV
    /** The keyup's median q, NaN before the carrier was on 10 times. */
    fun medianQ(): Double = medQ
    /** The envelope's spread over its mean while the carrier was on. */
    fun flatness(): Double { if (envN < 10) return Double.NaN; val m = envS / envN; return sqrt(max(0.0, envS2 / envN - m * m)) / (m + 1e-9) }
    fun offset(): Double = if (log.size >= 3) median(log) else Double.NaN

    fun step(i: Double, q: Double) {
        ri[rn] = i.toFloat(); rq[rn] = q.toFloat(); if (++rn >= b) rn = 0; if (filled < b) filled++
        val c = cos(ph); val s = sin(ph)
        val br = i * c + q * s; val bi = q * c - i * s; this.br = br; this.bi = bi
        cr = run(carI, br); ci = run(carQ, bi)
        lvl = run(lvlF, hypot(cr, ci))
        if (have && present) { val e = hypot(br, bi); envS += e; envS2 += e * e; envN++ }
        ph += w; if (ph > PI) ph -= 2 * PI else if (ph < -PI) ph += 2 * PI
        if (++n >= hopN) { n = 0; hop() }
    }

    private class Peak(val hz: Double, val q: Double)

    /** The last 20 ms: the strongest bin within [lo, hi] Hz clear of [avoid] (±[clear] Hz), and q over the median of ±2.8 kHz. */
    private fun peak(lo: Double, hi: Double, avoid: List<Double>, clear: Double): Peak {
        val nn = nf; val re = FloatArray(nn); val im = FloatArray(nn)
        for (k in 0 until b) { val j = (rn + k) % b; re[k] = ri[j] * win[k]; im[k] = rq[j] * win[k] }
        Dsp.fft(re, im)
        val bh = fs / nn; val r = floor(SEARCH_HZ / bh).toInt(); val pw = DoubleArray(2 * r + 1)
        for (bb in -r..r) { val k = (bb + nn) % nn; val x = re[k].toDouble(); val y = im[k].toDouble(); pw[bb + r] = x * x + y * y }
        val med = pw.sorted()[pw.size shr 1].let { if (it == 0.0 || it.isNaN()) 1e-20 else it }
        if (!sided) {
            // once a hop: the power in 25 Hz bands across the channel, over the median, for the sideband split
            sided = true; hopBands.fill(0.0)
            for (bb in pw.indices) {
                val k = floor(((bb - r) * bh + SIDE_HI_HZ) / SIDE_BAND_HZ).toInt(); if (k >= 0 && k < hopBands.size) hopBands[k] += pw[bb] / med
            }
            hopFilled = true
        }
        var best = -1
        for (bb in pw.indices) {
            val f = (bb - r) * bh; if (f < lo || f > hi || avoid.any { abs(f - it) <= clear }) continue
            if (best < 0 || pw[bb] > pw[best]) best = bb
        }
        if (best < 0) return Peak(Double.NaN, -99.0)
        var d = 0.0
        if (best > 0 && best < pw.size - 1) {
            val l = ln(pw[best - 1] + 1e-20); val cc = ln(pw[best] + 1e-20); val rr = ln(pw[best + 1] + 1e-20)
            d = 0.5 * (l - rr) / (l - 2 * cc + rr - 1e-12); if (!d.isFinite() || abs(d) > 1) d = 0.0
        }
        return Peak((best - r + d) * bh, 10 * log10(pw[best] / med))
    }

    private fun hop() {
        sided = false; hopFilled = false
        hop0()
        if (!hopFilled) return
        addHop(all)
        if (have && !onNow) addHop(off)
    }
    private fun addHop(a: SideAcc) {
        for (k in hopBands.indices) {
            val x = hopBands[k]; a.sum[k] += x
            val j = max(0, min(SIDE_HIST - 1, floor(2 * 10 * log10(x + 1e-12)).toInt() + SIDE_HIST_LO))
            a.hist[k * SIDE_HIST + j]++
        }
        a.n++
    }
    /**
     * Which side of the center carries a voice, over the keyup ([off]: only the hops a followed line was off): home's
     * split of the power 300 to 3000 Hz either side, with its idle-line notches done another way. Each 25 Hz band's
     * power is followed hop by hop, and what counts is how far its mean stands over its median: a voice comes and goes
     * (its mean well over its median), noise a little and the same on both sides, a steady line or a cluster of a
     * nearby device's lines hardly at all, however strong. One side must hold [ratio] times the other.
     */
    fun side(off: Boolean, ratio: Double): CbMode? {
        val a = if (off) this.off else all
        if (a.n < 10) return null
        if (a.n == a.at) return a.res
        var up = 0.0; var lo = 0.0
        for (k in hopBands.indices) {
            val f = (k + 0.5) * SIDE_BAND_HZ - SIDE_HI_HZ; val af = abs(f); if (af < SIDE_LO_HZ || af > SIDE_HI_HZ) continue
            var c = 0; var j = 0; val half = a.n / 2.0
            while (j < SIDE_HIST) { c += a.hist[k * SIDE_HIST + j]; if (c >= half) break; j++ }
            val md = Math.pow(10.0, (j + 0.5 - SIDE_HIST_LO) / 20); val x = max(0.0, a.sum[k] / a.n - md)
            if (f > 0) up += x else lo += x
        }
        a.at = a.n; a.res = if (up + lo > 0 && max(up, lo) >= ratio * min(up, lo)) (if (up > lo) CbMode.USB else CbMode.LSB) else null
        return a.res
    }
    private val hopBands = DoubleArray((2 * SIDE_HI_HZ / SIDE_BAND_HZ).toInt())
    private val all = SideAcc(hopBands.size); private val off = SideAcc(hopBands.size)
    val offHops: Int get() = off.n
    private var sided = false; private var hopFilled = false
    private fun hop0() {
        ms += HOP_MS
        if (filled < b) return
        if (!have) {
            // finding: count the strong bins' frequencies over half a second
            val p = peak(-SEARCH_HZ, SEARCH_HZ, emptyList(), 0.0)
            findHops++
            if (p.q > STRONG_DB) find.add(Math.round(p.hz / 10).toDouble() * 10)
            val span = FIND_MS / HOP_MS
            if (findHops >= span) {
                val strong = find
                if (strong.size >= HELD_SHARE * findHops) {
                    val count = LinkedHashMap<Double, Int>(); for (v in strong) count[v] = (count[v] ?: 0) + 1
                    val cand = ArrayList<Double>()
                    for ((v, c) in count.entries.sortedByDescending { it.value }) if (c >= HELD_SHARE * strong.size && cand.all { abs(v - it) > CAND_APART_HZ }) cand.add(v)
                    val ok = cand.take(MAX_CAND).filter { x -> ignore.none { abs(x - it) < ON_LINE_HZ } }
                    if (ok.isNotEmpty()) { take(ok[0], ok.drop(1)); return }
                }
                // slide on: the oldest tenth goes, and the half second is looked at again
                find = ArrayList(find.drop(ceil(find.size / 10.0).toInt())); findHops = (span * 0.9).roundToInt()
            }
            return
        }
        // tracking: the strongest bin within 60 Hz of the carrier, 50 Hz clear of the others
        val p = peak(hz - TRACK_HZ, hz + TRACK_HZ, others, OTHERS_HZ)
        heldHops++
        onNow = p.q > ON_DB
        if (p.q > ON_DB) {
            onHops++
            recent.add(p.hz); if (recent.size > 5) recent.removeAt(0)
            hz = p.hz; setW(median(recent))
            offMs = 0.0; present = true
            log.add(p.hz); qs.add(p.q); lvls.add(lvl)
            if (qs.size >= 10 && (qs.size < 100 || qs.size % 10 == 0)) medQ = median(qs.takeLast(1000))
            if (lvls.size % 10 == 1) floorV = LVL_FLOOR * median(lvls.takeLast(500))
        } else {
            offMs += HOP_MS
            // gone a while with another station strong elsewhere: the next keyup has started, find it now; with nothing
            // else there, a fade is bridged up to 1.5 s
            val o = peak(-SEARCH_HZ, SEARCH_HZ, emptyList(), 0.0)
            elsewhere = if (o.q > STRONG_DB && abs(o.hz - hz) > TRACK_HZ) elsewhere + HOP_MS else 0.0
            if (offMs > BRIDGE_MS || elsewhere >= NEXT_KEYUP_MS) {
                present = elsewhere >= NEXT_KEYUP_MS && offMs <= BRIDGE_MS; have = false; find = ArrayList(); findHops = 0; recent = ArrayList(); elsewhere = 0.0
            }
        }
    }
    private fun setW(hz: Double) { w = 2 * PI * hz / fs }
    private fun take(hz: Double, others: List<Double>) {
        if (changes.isNotEmpty()) switches++
        changes.add(CarrierChange(ms, hz))
        heldHops = 0; onHops = 0
        have = true; present = true; this.hz = hz; recent = arrayListOf(hz); setW(hz); this.others = others; offMs = 0.0
        find = ArrayList(); findHops = 0
    }
}

/**
 * Home's gentle noise reduction, streaming: half-overlapped frames of about 21 ms, each bin's noise the 20th
 * percentile of its power over the last 150 frames that had any, and a gain of 1 less that noise over the power
 * smoothed 3 bins by 5 frames, never under 0.35. Two frames late, so the smoothing is centered as home's is.
 */
class Denoiser(fs: Double) {
    private val n: Int; private val h: Int; private val win: FloatArray
    private val inBuf: FloatArray; private var inN = 0
    private class Frame(val re: FloatArray, val im: FloatArray, val p: FloatArray)
    private val frames = ArrayList<Frame>()
    private val hist = ArrayList<FloatArray>()
    private val ola: FloatArray; private var out = FloatArray(4096); private var outLen = 0; private var noise: FloatArray? = null; private var sinceNoise = 0

    init {
        var x = 1; while (x < fs * 0.0213) x = x shl 1; n = x; h = x shr 1
        // the square root of a Hann window both ways sums to one at half overlap
        win = FloatArray(n) { k -> sqrt(0.5 - 0.5 * cos(2 * PI * k / n)).toFloat() }
        inBuf = FloatArray(n); ola = FloatArray(n)
    }

    fun process(x: FloatArray, m: Int, y: FloatArray) {
        for (k in 0 until m) {
            inBuf[inN++] = x[k]
            if (inN == n) { frame(); System.arraycopy(inBuf, h, inBuf, 0, n - h); inN = h }
        }
        val k = min(m, outLen); System.arraycopy(out, 0, y, 0, k)
        System.arraycopy(out, k, out, 0, outLen - k); outLen -= k
        // until the first frames are through, silence (a few tens of ms)
        for (i in k until m) y[i] = 0f
    }

    private fun frame() {
        val nn = n; val re = FloatArray(nn); val im = FloatArray(nn); val nb = nn / 2 + 1; val p = FloatArray(nb)
        for (k in 0 until nn) re[k] = inBuf[k] * win[k]
        Dsp.fft(re, im)
        var e = 0.0
        for (b in 0 until nb) { val a = re[b].toDouble(); val c = im[b].toDouble(); p[b] = (a * a + c * c).toFloat(); e += p[b] }
        if (e > 0) { hist.add(p); if (hist.size > 150) hist.removeAt(0) }
        frames.add(Frame(re, im, p)); if (frames.size > 5) frames.removeAt(0)
        if (frames.size < 3) return
        // the frame two back, its power smoothed over the five frames around it and the bins beside
        val f = frames[frames.size - 3]; val g = FloatArray(nb)
        // the noise per bin, worked out again every 10 frames (it moves slowly)
        if (noise == null || ++sinceNoise >= 10) {
            sinceNoise = 0; val nz = FloatArray(nb); val col = FloatArray(hist.size)
            for (b in 0 until nb) { for (j in hist.indices) col[j] = hist[j][b]; col.sort(); nz[b] = if (col.isNotEmpty()) col[floor(0.2 * (col.size - 1)).toInt()] else 0f }
            noise = nz
        }
        val nz = noise!!
        for (b in 0 until nb) {
            var s = 0.0; var c = 0
            for (fr in frames) for (d in -1..1) { val j = b + d; if (j in 0 until nb) { s += fr.p[j]; c++ } }
            g[b] = max(1 - nz[b] / (s / c + 1e-12), 0.35).toFloat()
        }
        val ore = FloatArray(nn); val oim = FloatArray(nn)
        for (b in 0 until nb) {
            ore[b] = f.re[b] * g[b]; oim[b] = -f.im[b] * g[b]
            if (b > 0 && b < nn / 2) { ore[nn - b] = f.re[nn - b] * g[b]; oim[nn - b] = -f.im[nn - b] * g[b] }
        }
        // the inverse transform, as the forward transform of the conjugate
        Dsp.fft(ore, oim)
        for (k in 0 until nn) ola[k] = (ola[k] + ore[k].toDouble() / nn * win[k]).toFloat()
        if (outLen + h > out.size) out = out.copyOf(max(out.size * 2, outLen + h))
        System.arraycopy(ola, 0, out, outLen, h); outLen += h
        System.arraycopy(ola, h, ola, 0, nn - h); java.util.Arrays.fill(ola, nn - h, nn, 0f)
    }
}
