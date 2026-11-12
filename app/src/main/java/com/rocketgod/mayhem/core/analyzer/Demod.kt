package com.rocketgod.mayhem.core.analyzer

import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/*
 * The Analyzer's demodulator: one captured burst in, bits out, the way a person does it in Universal Radio Hacker.
 *
 * A burst arrives as the same two streams every Devices decoder reads (the envelope and the FM discriminator at the
 * channel rate, see `r433/Front.kt`). From those this works out, in order:
 *
 *  1. where the burst is: the samples the carrier stands clear of the noise heard before it began;
 *  2. how it is modulated: on-off (OOK), two amplitude levels (ASK) or two frequencies (FSK);
 *  3. where to slice it: the middle between its two levels, as a fraction of the range between them;
 *  4. the length of one symbol: the shortest element, refined over every run that is a whole number of them;
 *  5. the line coding: NRZ (a level per bit), Manchester (a transition per bit), PWM (the width of each mark) or
 *     PPM (the width of each gap);
 *  6. the bits of each frame, frames being split wherever the line rests far longer than any symbol.
 *
 * Every step can be overridden, and the later ones are worked out again from the override. Nothing here keeps
 * state, so the same burst always reads the same way. Twin of web/src/dsp/analyzer/demod.ts and Demod.swift.
 */

enum class Mod { OOK, ASK, FSK }
enum class Coding { NRZ, Manchester, PWM, PPM }
val MODS: List<Mod> = Mod.entries
val CODINGS: List<Coding> = Coding.entries

/** One run of the sliced line: high or low, for `n` samples. */
class Run(val hi: Boolean, var n: Int)

/**
 * One frame: where it lies in the burst (samples) and its bits as a string of 0 and 1. [spans] says where each bit
 * lies in the burst: samples [spans[2i], spans[2i+1]) carry bit i. For the trace and its link to the text.
 */
class Frame(val start: Int, val end: Int, val bits: String, val spans: IntArray = IntArray(0))

/** What the person has set by hand. Anything left out (null) is worked out. */
data class Overrides(
    val mod: Mod? = null,
    /** The symbol length, in microseconds (for Manchester, the half bit). */
    val symUs: Double? = null,
    /** Where to slice, as a fraction of the way from the low level to the high one. */
    val thr: Double? = null,
    val coding: Coding? = null,
    /** Read every bit the other way up. */
    val invert: Boolean = false,
    /** Only this part of the burst, in samples. */
    val from: Double? = null,
    val to: Double? = null,
)

class Analysis(
    val mod: Mod, val modAuto: Mod,
    /** The symbol length in microseconds, and what was measured. */
    val symUs: Double, val symAuto: Double,
    val thr: Double, val thrAuto: Double,
    val coding: Coding, val codingAuto: Coding,
    val invert: Boolean,
    /** The two levels sliced between, in the units of the stream sliced (envelope or discriminator). */
    val lo: Double, val hi: Double,
    /** The level the line is cut at, in the same units. */
    val cut: Double,
    /** The part of the burst read, in samples. */
    val from: Int, val to: Int,
    /** The sliced line from `from`, run by run. */
    val runs: List<Run>,
    val frames: List<Frame>,
    /** Bits a second, after the coding. */
    val baud: Double,
    /** The frequency shift between the two tones in hertz (FSK), or 0. */
    val shiftHz: Double,
    /** A short account of why it was read this way, for the panel. */
    val why: String,
)

/** Two-means result: the two centers, the share in the upper one, and the spread within them. */
data class TwoMeans(val a: Double, val b: Double, val share: Double, val sd: Double)

/** Discriminator units are radians times this (see Baseband). */
const val FM_SCALE = 10430.378
/** Above the noise by this much is a carrier (10 dB), and it lets go below 7 dB, as the key slicer does. */
private const val ON_K = 3.2
private const val OFF_K = 2.2
/** Less shift than this between the tones (about 4.6 kHz at 250 kHz) is not FSK. */
private const val MIN_FSK_SPREAD = 1200
/** A rest this many symbols long ends a frame. */
private const val GAP_SYMBOLS = 20
/** Frames shorter than this are fragments, not frames. */
private const val MIN_FRAME_BITS = 8

/** A growable list of doubles without boxing. */
internal class DoubleBuf(cap: Int = 64) {
    var a = DoubleArray(max(1, cap)); private set
    var size = 0; private set
    fun add(x: Double) { if (size == a.size) a = a.copyOf(a.size * 2); a[size++] = x }
    fun toArray(): DoubleArray = a.copyOf(size)
}

/** The level of the noise in the look-back before the burst: the median of its first 6 ms, past the filter's start. */
fun noiseOf(env: ShortArray, n: Int, rate: Double): Double {
    val a = min(20, n); val b = min(n, a + max(16, Math.round(rate * 0.006).toInt()))
    if (b <= a) return 1.0
    val v = IntArray(b - a) { env[a + it].toInt() }; v.sort()
    return max(1, v[v.size shr 1]).toDouble()
}

/**
 * Where the carrier is up, sample by sample, with the key slicer's hysteresis: 10 dB over the noise to rise and
 * 7 dB to fall. Never less than 22 dB under the burst's own peak, so a strong neighbor leaking into the channel
 * through the decimator's skirts does not read as this burst carrying on.
 */
fun carrierOf(env: ShortArray, n: Int, noise: Double): BooleanArray {
    var peak = 0
    for (i in 0 until n) if (env[i] > peak) peak = env[i].toInt()
    val rise = max(noise * ON_K, peak * 0.08); val fall = max(noise * OFF_K, peak * 0.055)
    val on = BooleanArray(n)
    var up = false
    for (i in 0 until n) {
        val e = env[i].toDouble()
        if (!up && e > rise) up = true else if (up && e < fall) up = false
        on[i] = up
    }
    return on
}

/** Two-means on a set of values: the two centers, the share in the upper one, and the spread within them. */
fun twoMeans(v: DoubleArray, count: Int = v.size): TwoMeans {
    if (count == 0) return TwoMeans(0.0, 0.0, 0.0, 0.0)
    // started from the 5th and 95th percentiles: from the extremes, one stray spike can claim a center to itself
    val sorted = v.copyOf(count); sorted.sort()
    var a = sorted[Math.floor(count * 0.05).toInt()]; var b = sorted[min(count - 1, Math.floor(count * 0.95).toInt())]
    for (it in 0 until 12) {
        val t = (a + b) / 2
        var sa = 0.0; var na = 0; var sb = 0.0; var nb = 0
        for (i in 0 until count) { val x = v[i]; if (x > t) { sb += x; nb++ } else { sa += x; na++ } }
        val a2 = if (na != 0) sa / na else a; val b2 = if (nb != 0) sb / nb else b
        if (a2 == a && b2 == b) break
        a = a2; b = b2
    }
    val t = (a + b) / 2
    var ss = 0.0; var nb = 0
    for (i in 0 until count) { val x = v[i]; val c = if (x > t) b else a; if (x > t) nb++; ss += (x - c) * (x - c) }
    return TwoMeans(a, b, nb.toDouble() / count, sqrt(ss / count))
}

/** Runs of one level shorter than `min` samples are glitches: they are folded into the runs around them. */
fun deglitch(runs: List<Run>, min: Int): List<Run> {
    val out = ArrayList<Run>()
    for (r in runs) {
        if (r.n < min && out.isNotEmpty()) { out[out.size - 1].n += r.n; continue }
        if (out.isNotEmpty() && out[out.size - 1].hi == r.hi) out[out.size - 1].n += r.n
        else out.add(Run(r.hi, r.n))
    }
    return out
}

/** The line cut at `cut` with a little hysteresis, as runs. Where the carrier is down (FSK), the line is low. */
fun sliceRuns(sig: ShortArray, from: Int, to: Int, cut: Double, hyst: Double, gate: BooleanArray?): List<Run> {
    val runs = ArrayList<Run>()
    var lvl = false; var n = 0
    for (i in from until to) {
        val x = sig[i].toDouble()
        var l = lvl
        if (gate != null && !gate[i]) l = false
        else if (x > cut + hyst) l = true
        else if (x < cut - hyst) l = false
        if (l == lvl) n++
        else { if (n != 0) runs.add(Run(lvl, n)); lvl = l; n = 1 }
    }
    if (n != 0) runs.add(Run(lvl, n))
    return runs
}

/**
 * The symbol length in samples: the mean of the shortest runs, then refined over every run that is a whole number
 * of symbols (up to 16), so a hundred runs vote rather than the one shortest.
 */
fun symbolOf(runs: List<Run>): Double {
    val inner = if (runs.size > 2) runs.subList(1, runs.size - 1).map { it.n }.filter { it > 0 }.toIntArray() else IntArray(0)
    if (inner.isEmpty()) return if (runs.isNotEmpty()) runs[0].n.toDouble() else 1.0
    val s = inner.copyOf(); s.sort()
    // the lengths that recur: runs within 20% of each other, each group at least 5% of all of them; the symbol is one
    // of these or a half or third of one
    val cands = ArrayList<Double>()
    var i = 0
    while (i < s.size) {
        var j = i; var sum = 0.0
        while (j < s.size && s[j] <= s[i] * 1.2) { sum += s[j]; j++ }
        if (j - i >= max(2.0, s.size * 0.05)) { val c = sum / (j - i); cands.add(c); cands.add(c / 2); cands.add(c / 3) }
        i = j
    }
    if (cands.isEmpty()) cands.add(s[s.size shr 1].toDouble())
    // The longest symbol that the frame is a whole number of (any shorter one would fit it too). Measured as the
    // longest unbroken stretch of runs that fit, so noise before the preamble, which fits nothing for long, has no say.
    val fits = cands.map { c -> if (c >= 1) stretchOf(inner, c) else 0 }
    val most = fits.max()
    var u = 0.0
    for (k in cands.indices) if (fits[k] >= most * 0.8 && cands[k] > u) u = cands[k]
    for (it in 0 until 3) {
        var sr = 0.0; var sk = 0L
        for (n in inner) { val x = n / u; val k = Math.round(x); if (k >= 1 && k <= 16 && abs(x - k) < 0.25 + 0.03 * k) { sr += n; sk += k } }
        if (sk != 0L) u = sr / sk
    }
    return u
}

/** The longest unbroken stretch of runs that are close to a whole number (1..16) of symbols `u`; rests are skipped. */
private fun stretchOf(runs: IntArray, u: Double): Int {
    var best = 0; var cur = 0
    for (n in runs) {
        val x = n / u; val k = Math.round(x)
        if (k > 16) continue
        if (k >= 1 && abs(x - k) < 0.25 + 0.03 * k) { cur++; if (cur > best) best = cur } else cur = 0
    }
    return best
}

/** A frame's runs and where it starts (samples from the start of the runs). */
class FrameRuns(val start: Int, val runs: MutableList<Run>)

/** Split the runs into frames wherever the line rests `gap` samples or more. Each frame starts on a high run. */
fun framesOf(runs: List<Run>, gap: Double): List<FrameRuns> {
    val out = ArrayList<FrameRuns>()
    var cur = ArrayList<Run>(); var at = 0; var start = 0
    for (r in runs) {
        if (r.n >= gap) { if (cur.isNotEmpty()) out.add(FrameRuns(start, cur)); cur = ArrayList(); at += r.n; continue }
        if (cur.isEmpty()) { if (!r.hi) { at += r.n; continue }; start = at }
        cur.add(r); at += r.n
    }
    if (cur.isNotEmpty()) out.add(FrameRuns(start, cur))
    // a frame ends on its last mark: a short low after it is the carrier dying away, not a symbol
    for (f in out) while (f.runs.isNotEmpty() && !f.runs[f.runs.size - 1].hi) f.runs.removeAt(f.runs.size - 1)
    return out
}

/** How each mark and the gap after it measure, for telling the pulse codings apart. */
private class PairStats(val marks: DoubleArray, val spaces: DoubleArray, val periods: DoubleArray)

private fun pairStats(frames: List<FrameRuns>): PairStats {
    val marks = DoubleBuf(); val spaces = DoubleBuf(); val periods = DoubleBuf()
    for (f in frames) {
        val r = f.runs
        for (i in r.indices) {
            if (!r[i].hi) continue
            marks.add(r[i].n.toDouble())
            if (i + 1 < r.size) { spaces.add(r[i + 1].n.toDouble()); periods.add((r[i].n + r[i + 1].n).toDouble()) }
        }
    }
    return PairStats(marks.toArray(), spaces.toArray(), periods.toArray())
}

private fun cv(v: DoubleArray): Double {
    if (v.size < 2) return 1.0
    val m = v.sum() / v.size
    var s = 0.0; for (x in v) s += (x - m) * (x - m)
    return sqrt(s / v.size) / m
}
/** Two widths, each at least 15% of the whole, the longer at least 1.5 times the shorter. */
private fun twoWidths(v: DoubleArray): Boolean {
    if (v.size < 4) return false
    val t = twoMeans(v)
    return t.b >= t.a * 1.5 && t.share >= 0.15 && t.share <= 0.85
}

/** Which line coding fits the runs, measured against symbol `u` (samples). */
fun codingOf(frames: List<FrameRuns>, u: Double): Coding {
    val ps = pairStats(frames)
    if (twoWidths(ps.marks) && cv(ps.periods) < 0.15) return Coding.PWM
    var one = 0; var two = 0; var all = 0
    for (f in frames) for (r in f.runs) { val k = Math.round(r.n / u); all++; if (k <= 1) one++ else if (k == 2L) two++ }
    // (a frame that is mostly preamble is nearly all double runs: a couple of single ones are enough)
    if (all >= 8 && (one + two).toDouble() / all >= 0.95 && two.toDouble() / all >= 0.08 && one >= 2) return Coding.Manchester
    if (ps.marks.size >= 4 && cv(ps.marks) < 0.2 && twoWidths(ps.spaces)) return Coding.PPM
    return Coding.NRZ
}

/** The bits of one frame. */
fun decodeFrame(runs: List<Run>, coding: Coding, u: Double, marks: TwoMeans, spaces: TwoMeans): String =
    decodeSpans(runs, 0, coding, u, marks, spaces).bits

/** A frame's bits and where each one lies (two samples per bit: [start, end)). */
class Spans(val bits: String, val spans: IntArray)

/** A growable list of ints without boxing. */
internal class IntBuf(cap: Int = 64) {
    var a = IntArray(max(1, cap)); private set
    var size = 0; private set
    fun add(x: Int) { if (size == a.size) a = a.copyOf(a.size * 2); a[size++] = x }
    operator fun get(i: Int) = a[i]
    fun toArray(): IntArray = a.copyOf(size)
}

/**
 * The bits of one frame and where each one lies: the frame's first run starts at sample `at`. NRZ splits each run
 * into its whole symbols; a Manchester bit is its two halves; a pulse-width or pulse-position bit runs from its
 * mark to the start of the next.
 */
fun decodeSpans(runs: List<Run>, at: Int, coding: Coding, u: Double, marks: TwoMeans, spaces: TwoMeans): Spans {
    val bits = StringBuilder()
    val spans = IntBuf()
    if (coding == Coding.NRZ || coding == Coding.Manchester) {
        val half = StringBuilder()
        val hs = IntBuf()
        var pos = at.toDouble()
        for (r in runs) {
            val k = max(1L, Math.round(r.n / u)).toInt()
            for (j in 0 until k) { half.append(if (r.hi) '1' else '0'); hs.add(jsRound(pos + j * r.n.toDouble() / k)); hs.add(jsRound(pos + (j + 1) * r.n.toDouble() / k)) }
            pos += r.n
        }
        if (coding == Coding.NRZ) return Spans(half.toString(), hs.toArray())
        // pairs of half bits: high then low is 1, low then high is 0; a pair that is neither slips one half bit, which
        // finds the bit boundary on its own wherever the frame starts
        var i = 0
        while (i + 1 < half.length) {
            val p0 = half[i]; val p1 = half[i + 1]
            if (p0 != p1) { bits.append(if (p0 == '1') '1' else '0'); spans.add(hs[2 * i]); spans.add(hs[2 * i + 3]); i += 2 } else i += 1
        }
        return Spans(bits.toString(), spans.toArray())
    }
    val starts = IntArray(runs.size)
    var pos = at
    for (k in runs.indices) { starts[k] = pos; pos += runs[k].n }
    if (coding == Coding.PWM) {
        val mid = (marks.a + marks.b) / 2
        for (i in runs.indices) {
            if (!runs[i].hi) continue
            bits.append(if (runs[i].n > mid) '1' else '0')
            spans.add(starts[i]); spans.add(if (i + 1 < runs.size) starts[i + 1] + runs[i + 1].n else starts[i] + runs[i].n)
        }
        return Spans(bits.toString(), spans.toArray())
    }
    // PPM: the gap after each mark, the last mark ending the frame
    val mid = (spaces.a + spaces.b) / 2
    for (i in 0 until runs.size - 1) {
        if (!runs[i].hi) continue
        bits.append(if (runs[i + 1].n > mid) '1' else '0')
        spans.add(starts[i]); spans.add(starts[i + 1] + runs[i + 1].n)
    }
    return Spans(bits.toString(), spans.toArray())
}

/** Math.round as JavaScript does it (halves up), so spans land on the same samples as the web's. */
private fun jsRound(x: Double): Int = Math.floor(x + 0.5).toInt()

/** Bits as hex, four to a digit, the last digit padded with zeros on the right. */
fun bitsToHex(bits: String): String {
    val out = StringBuilder()
    var i = 0
    while (i < bits.length) { out.append(Integer.toHexString(bits.substring(i, min(bits.length, i + 4)).padEnd(4, '0').toInt(2)).uppercase(Locale.US)); i += 4 }
    return out.toString()
}
/** Bits as text, eight to a character; anything unprintable shows as a dot. */
fun bitsToAscii(bits: String): String {
    val out = StringBuilder()
    var i = 0
    while (i + 8 <= bits.length) { val c = bits.substring(i, i + 8).toInt(2); out.append(if (c in 0x20 until 0x7f) c.toChar() else '.'); i += 8 }
    return out.toString()
}

/** The burst's signal to read for a modulation: the envelope, or the discriminator. */
fun signalOf(mod: Mod, env: ShortArray, fm: ShortArray): ShortArray = if (mod == Mod.FSK) fm else env

private fun f1(x: Double) = String.format(Locale.US, "%.1f", x)

/**
 * Read one burst. `rate` is the stream's sample rate; `n` how many samples it holds.
 */
fun analyze(env: ShortArray, fm: ShortArray, n: Int, rate: Double, o: Overrides = Overrides()): Analysis {
    val usPer = 1e6 / rate
    val noise = noiseOf(env, n, rate)
    val on = carrierOf(env, n, noise)
    var from = 0; var to = n
    while (from < n && !on[from]) from++
    while (to > from && !on[to - 1]) to--
    if (o.from != null) from = max(0, min(n, Math.round(o.from).toInt()))
    if (o.to != null) to = max(from, min(n, Math.round(o.to).toInt()))
    if (to - from < 8) return Analysis(
        o.mod ?: Mod.OOK, Mod.OOK, o.symUs ?: 0.0, 0.0, o.thr ?: 0.5, 0.5,
        o.coding ?: Coding.NRZ, Coding.NRZ, o.invert, 0.0, 0.0, 0.0, from, to, emptyList(), emptyList(), 0.0, 0.0,
        "no carrier above the noise")

    // the envelope and the discriminator, measured where the carrier is up; the discriminator away from the edges of
    // each mark, where it swings in from the noise
    val envOn = DoubleBuf(to - from); val fmOn = DoubleBuf(to - from)
    var offN = 0; var edges = 0
    for (i in from until to) {
        if (!on[i]) { offN++; continue }
        envOn.add(env[i].toDouble())
        if (i > 0 && !on[i - 1]) edges++
        var inner = true
        var dd = -4
        while (dd <= 4 && inner) { val j = i + dd; if (j < from || j >= to || !on[j]) inner = false; dd++ }
        if (inner) fmOn.add(fm[i].toDouble())
    }
    val span = to - from
    val offFrac = offN.toDouble() / span
    val envT = twoMeans(envOn.a, envOn.size); val fmT = twoMeans(fmOn.a, fmOn.size)
    val fmSpread = fmT.b - fmT.a
    val fskLike = fmOn.size >= 32 && fmSpread > MIN_FSK_SPREAD && fmSpread > 2 * fmT.sd && fmT.share > 0.1 && fmT.share < 0.9
    val askLike = envOn.size >= 32 && envT.a > 0 && envT.a / envT.b > 0.15 && envT.a / envT.b < 0.75 && (envT.b - envT.a) > 3 * envT.sd && envT.share > 0.1 && envT.share < 0.9
    val ookLike = offFrac >= 0.1 && edges >= 3
    // FSK switches tones far more often than the carrier stops; an OOK burst does the opposite
    var fmEdges = 0
    if (fskLike) {
        val t = (fmT.a + fmT.b) / 2; var l = fm[from] > t
        for (i in from until to) { if (!on[i]) continue; val x = fm[i] > t; if (x != l) { fmEdges++; l = x } }
    }
    var modAuto = Mod.OOK; val why: String
    if (fskLike && fmEdges > 2 * edges + 4) { modAuto = Mod.FSK; why = "two tones ${f1((fmSpread / FM_SCALE) * rate / (2 * PI) / 1e3)} kHz apart" }
    else if (ookLike) { modAuto = Mod.OOK; why = "carrier keyed on and off (${Math.round(offFrac * 100)}% off)" }
    else if (askLike) { modAuto = Mod.ASK; why = "two levels, the lower ${Math.round(envT.a / envT.b * 100)}% of the upper" }
    else if (fskLike) { modAuto = Mod.FSK; why = "two tones" }
    else why = "a plain carrier: nothing keyed"
    val mod = o.mod ?: modAuto

    // the two levels to slice between, and where
    val sig = signalOf(mod, env, fm)
    var lo: Double; var hi: Double
    if (mod == Mod.FSK) { lo = fmT.a; hi = fmT.b }
    else if (mod == Mod.ASK) { lo = envT.a; hi = envT.b }
    else {
        lo = noise
        hi = if (envOn.size > 0) { var s = 0.0; for (k in 0 until envOn.size) s += envOn.a[k]; s / envOn.size } else noise * ON_K
        if (envT.share < 0.9 && askLike) hi = envT.b
    }
    if (hi <= lo) hi = lo + 1
    val thrAuto = if (mod == Mod.OOK) min(0.5, max(0.15, (noise * ON_K - lo) / (hi - lo))) else 0.5
    val thr = o.thr ?: thrAuto
    val cut = lo + thr * (hi - lo)
    // FSK noise rides around the middle of the two tones, so it gets the key slicer's wider band; an OOK cut sits
    // near the noise, and a band that wide would reach below it
    val hyst = (hi - lo) * (if (mod == Mod.FSK) 0.12 else 0.08)
    val minRun = max(2, Math.round(12 / usPer).toInt())
    val runs = deglitch(sliceRuns(sig, from, to, cut, hyst, if (mod == Mod.FSK) on else null), minRun)

    // symbol, frames and coding
    val uAuto = symbolOf(runs)
    val symAuto = uAuto * usPer
    val u = if (o.symUs != null && o.symUs != 0.0) o.symUs / usPer else uAuto
    val frames0 = framesOf(runs, max(u * GAP_SYMBOLS, 12.0))
    val codingAuto = if (frames0.isNotEmpty()) codingOf(frames0, u) else Coding.NRZ
    val coding = o.coding ?: codingAuto
    val ps = pairStats(frames0)
    val mk = twoMeans(ps.marks); val sp = twoMeans(ps.spaces)
    val frames = ArrayList<Frame>()
    for (f in frames0) {
        val dd = decodeSpans(f.runs, from + f.start, coding, u, mk, sp)
        var bits = dd.bits
        if (o.invert) bits = buildString(bits.length) { for (c in bits) append(if (c == '0') '1' else if (c == '1') '0' else c) }
        if (bits.length < MIN_FRAME_BITS) continue
        val len = f.runs.sumOf { it.n }
        frames.add(Frame(from + f.start, from + f.start + len, bits, dd.spans))
    }
    val period = if (ps.periods.isNotEmpty()) ps.periods.copyOf().also { it.sort() }[ps.periods.size shr 1] else 2 * u
    val baud = if (coding == Coding.Manchester) rate / (2 * u) else if (coding == Coding.NRZ) rate / u else rate / period
    val shiftHz = if (mod == Mod.FSK) abs(hi - lo) / FM_SCALE * rate / (2 * PI) else 0.0
    return Analysis(mod, modAuto, u * usPer, symAuto, thr, thrAuto, coding, codingAuto, o.invert, lo, hi, cut, from, to, runs, frames, baud, shiftHz, why)
}

/**
 * The burst as levels and durations in microseconds, signed the way a Flipper RAW file is (positive high), from
 * the first mark to the last.
 */
fun pulsesUs(a: Analysis, rate: Double): List<Int> {
    val usPer = 1e6 / rate; val out = ArrayList<Int>()
    var started = false
    for (r in a.runs) {
        if (!started && !r.hi) continue
        started = true
        val us = max(1L, Math.round(r.n * usPer)).toInt()
        out.add(if (r.hi) us else -us)
    }
    while (out.isNotEmpty() && out[out.size - 1] < 0) out.removeAt(out.size - 1)
    return out
}

/** The pulse-length histogram: bins [binUs] wide, the marks' and the gaps' counts in each. */
class Histogram(val binUs: Double, val marks: IntArray, val spaces: IntArray)

/**
 * How long the marks and the gaps last, as URH draws it: run lengths in microseconds, binned. Bins are `binUs`
 * wide up to `maxUs`; anything longer goes in the last. The frame-ending rests are left out.
 */
fun histogram(a: Analysis, rate: Double, bins: Int = 48): Histogram {
    val usPer = 1e6 / rate
    val inner = (if (a.runs.size > 2) a.runs.subList(1, a.runs.size - 1) else emptyList()).filter { it.n * usPer < a.symUs * GAP_SYMBOLS }
    var maxUs = a.symUs * 6
    for (r in inner) maxUs = max(maxUs, r.n * usPer)
    maxUs *= 1.02
    val binUs = maxUs / bins
    val marks = IntArray(bins); val spaces = IntArray(bins)
    for (r in inner) { val i = min(bins - 1, Math.floor(r.n * usPer / binUs).toInt()); if (r.hi) marks[i]++ else spaces[i]++ }
    return Histogram(binUs, marks, spaces)
}
