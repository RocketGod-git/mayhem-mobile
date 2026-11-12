package com.rocketgod.mayhem.core.analyzer

import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/*
 * Measuring a burst: the numbers behind what the trace shows.
 *
 * Everything an analyst reads off a waveform by hand, worked out once: every mark and gap with its length; the
 * lengths that recur (the short and long classes a pulse-width or pulse-position code is built from) with their
 * spread and jitter and the thresholds between them; how well the symbol length fits, and how far the edges drift
 * from a clock run at it; the repeats inside one burst, their spacing and how they differ; the levels (how loud the
 * marks and gaps are, how fast the carrier rises and falls, the tones and their deviation). Twin of
 * web/src/dsp/analyzer/measure.ts and Measure.swift.
 */

private fun f(d: Int, x: Double) = String.format(Locale.US, "%.${d}f", x)

/** One mark or gap inside a frame: which frame and its place in it, where it starts (sample), how long, and its length class (per level). */
class Pulse(val frame: Int, val index: Int, val hi: Boolean, val start: Int, val n: Int, val us: Double, var cls: Int = 0)

/** A length that recurs among the marks (or the gaps): count, mean/min/max µs, σ µs and as a share of the mean, and the mean in symbols. */
class PulseClass(val hi: Boolean, val count: Int, val mean: Double, val min: Double, val max: Double, val sd: Double, val jitterPct: Double, val symbols: Double)

class PulseTable(
    val pulses: List<Pulse>,
    /** Marks' classes, short to long, and gaps' classes, short to long. */
    val marks: List<PulseClass>,
    val spaces: List<PulseClass>,
    /** The lengths (µs) that split one class from the next: midway between neighbors. */
    val markCuts: List<Double>,
    val spaceCuts: List<Double>,
)

/** Lengths into classes: sorted, split wherever the next is more than 30% longer than the class's longest so far. */
fun classify(us: List<Double>): List<List<Int>> {
    val s = us.indices.sortedBy { us[it] }
    val out = ArrayList<List<Int>>()
    var cur = ArrayList<Int>(); var last = -1.0
    for (i in s) {
        val v = us[i]
        if (cur.isNotEmpty() && v > last * 1.3) { out.add(cur); cur = ArrayList() }
        cur.add(i); last = v
    }
    if (cur.isNotEmpty()) out.add(cur)
    return out
}

private fun stats(us: List<Double>, ids: List<Int>, hi: Boolean, symUs: Double): PulseClass {
    val v = ids.map { us[it] }
    val mean = v.sum() / v.size
    var ss = 0.0; for (x in v) ss += (x - mean) * (x - mean)
    val sd = sqrt(ss / v.size)
    return PulseClass(hi, v.size, mean, v.min(), v.max(), sd, if (mean != 0.0) sd / mean * 100 else 0.0, if (symUs != 0.0) mean / symUs else 0.0)
}

/**
 * Where each edge of the sliced line really is. The slicer cuts an OOK burst low (just over the noise), and the
 * envelope is smoothed, so its edges land early on the rise and late on the fall: every mark reads long and every gap
 * short by the same amount. Measured here at the halfway point between the gap and mark levels instead (linear
 * between samples), which the smoothing delays equally on both edges. FSK edges are already cut halfway.
 */
fun edgesOf(a: Analysis, env: ShortArray?): DoubleArray {
    val out = DoubleArray(a.runs.size + 1)
    var pos = a.from
    for ((k, r) in a.runs.withIndex()) { out[k] = pos.toDouble(); pos += r.n }
    out[a.runs.size] = pos.toDouble()
    if (env == null || a.mod == Mod.FSK) return out
    val mid = (a.lo + a.hi) / 2; val w = 40
    for (k in 1 until out.size - 1) {
        val e = out[k].toInt(); val rising = a.runs[k].hi
        for (i in max(1, e - w) until min(env.size, e + w)) {
            val p = env[i - 1].toDouble(); val q = env[i].toDouble()
            if (if (rising) p < mid && q >= mid else p >= mid && q < mid) { out[k] = i - 1 + (mid - p) / (q - p); break }
        }
    }
    return out
}

/** Every mark and gap inside the frames (lengths measured edge to edge, see [edgesOf]), and the classes of their lengths. */
fun pulseTable(a: Analysis, rate: Double, env: ShortArray? = null): PulseTable {
    val usPer = 1e6 / rate
    val pulses = ArrayList<Pulse>()
    val edges = edgesOf(a, env)
    var pos = a.from; var frame = -1; var index = 0; var ri = 0
    val fr = a.frames
    for (r in a.runs) {
        val len = edges[ri + 1] - edges[ri]; ri++
        // a run is in a frame when it overlaps it (a frame trimmed onto its sync may start part way into a run)
        val fi = fr.indexOfFirst { pos < it.end && pos + r.n > it.start }
        if (fi >= 0) {
            if (fi != frame) { frame = fi; index = 0 }
            pulses.add(Pulse(fi, index++, r.hi, pos, r.n, len * usPer))
        }
        pos += r.n
    }
    var marks: List<PulseClass> = emptyList(); var spaces: List<PulseClass> = emptyList()
    var markCuts: List<Double> = emptyList(); var spaceCuts: List<Double> = emptyList()
    for (hi in booleanArrayOf(true, false)) {
        val idx = pulses.indices.filter { pulses[it].hi == hi }
        val us = idx.map { pulses[it].us }
        val groups = classify(us)
        val cls = groups.map { stats(us, it, hi, a.symUs) }
        groups.forEachIndexed { c, g -> g.forEach { k -> pulses[idx[k]].cls = c } }
        val cuts = (1 until cls.size).map { (cls[it - 1].max + cls[it].min) / 2 }
        if (hi) { marks = cls; markCuts = cuts } else { spaces = cls; spaceCuts = cuts }
    }
    return PulseTable(pulses, marks, spaces, markCuts, spaceCuts)
}

class SymbolFit(val symUs: Double, val baud: Double, val errPct: Double, val runs: Int)

/**
 * How well the symbol length fits: the symbol each run implies (its length over its whole number of symbols) and how
 * much those disagree, as a share of the symbol. Runs over 16 symbols (rests) are left out.
 */
fun symbolFit(a: Analysis, rate: Double): SymbolFit {
    val usPer = 1e6 / rate; val u = a.symUs
    val est = ArrayList<Double>()
    if (a.runs.size > 2 && u != 0.0) for (r in a.runs.subList(1, a.runs.size - 1)) { val k = Math.round(r.n * usPer / u); if (k in 1..16) est.add(r.n * usPer / k) }
    if (est.isEmpty() || u == 0.0) return SymbolFit(u, a.baud, 0.0, 0)
    val m = est.sum() / est.size
    var ss = 0.0; for (x in est) ss += (x - m) * (x - m)
    return SymbolFit(m, a.baud, sqrt(ss / est.size) / m * 100, est.size)
}

class Drift(val frame: Int, val start: Int, val u: Double, val worstPct: Double, val meanPct: Double)

/**
 * The clock a receiver would run: from each frame's first edge, a tick every symbol. For each edge in the frame, how
 * far it lands from the nearest tick, as a share of a symbol; the worst of these is the drift.
 */
fun clockDrift(a: Analysis, rate: Double): List<Drift> {
    val u = a.symUs * rate / 1e6
    if (u == 0.0) return emptyList()
    return a.frames.mapIndexed { fi, f ->
        var pos = a.from; var worst = 0.0; var sum = 0.0; var n = 0
        val start = if (f.spans.isNotEmpty()) f.spans[0] else f.start
        for (r in a.runs) {
            if (pos > start && pos < f.end) { val k = (pos - start) / u; val e = abs(k - Math.round(k)); worst = max(worst, e); sum += e; n++ }
            pos += r.n
        }
        Drift(fi, start, u, worst * 100, if (n != 0) sum / n * 100 else 0.0)
    }
}

/** A repeat inside a burst: when it starts and ends, the gap before it, the time from the last one's start, and where it differs from the first. */
class FrameSeg(val index: Int, val startMs: Double, val endMs: Double, val gapMs: Double, val intervalMs: Double, val bits: Int, val hex: String,
               /** Bit positions that differ from the first frame (compared over the shorter of the two). */
               val diff: List<Int>)

fun frameSegments(a: Analysis, rate: Double): List<FrameSeg> {
    fun ms(s: Int) = s / rate * 1000
    val f0 = a.frames.firstOrNull()?.bits ?: ""
    return a.frames.mapIndexed { i, f ->
        val prev = a.frames.getOrNull(i - 1)
        val diff = ArrayList<Int>()
        for (k in 0 until min(f0.length, f.bits.length)) if (f.bits[k] != f0[k]) diff.add(k)
        FrameSeg(i, ms(f.start), ms(f.end), if (prev != null) ms(f.start - prev.end) else 0.0, if (prev != null) ms(f.start - prev.start) else 0.0,
            f.bits.length, bitsToHex(f.bits), diff)
    }
}

/** Levels: how loud, how fast, and on what frequencies. */
class Levels(
    /** Mean envelope over the marks and over the gaps (well inside each), dBFS, and the difference. */
    val markDbfs: Double, val spaceDbfs: Double, val depthDb: Double,
    /** 10% → 90% of the way up (and back down) at the marks' edges, µs, averaged. */
    val riseUs: Double, val fallUs: Double,
    /** For FSK: the two tones and their middle, Hz from the channel center, and the deviation (half the shift). */
    val toneLoHz: Double, val toneHiHz: Double, val centerHz: Double, val deviationHz: Double,
    /** For OOK/ASK: the carrier's own offset from the channel center, Hz, measured inside the marks. */
    val carrierHz: Double,
    /** The discriminator inside the carrier, binned by 2 kHz from −60 to +60 kHz: the tones as two peaks. */
    val toneHist: IntArray,
    /** ASK: the two amplitude levels, dBFS. */
    val askLoDbfs: Double, val askHiDbfs: Double,
)

private const val ENV_FULL = 16384.0
private fun dbfs(v: Double) = 20 * log10(max(1.0, v) / ENV_FULL)

fun levels(a: Analysis, env: ShortArray, fm: ShortArray, rate: Double): Levels {
    fun toHz(v: Double) = v / FM_SCALE * rate / (2 * PI)
    val margin = max(2L, Math.round(rate * 16e-6)).toInt()
    var mS = 0.0; var mN = 0; var sS = 0.0; var sN = 0; var fS = 0.0; var fN = 0
    val hist = IntArray(61)
    var pos = a.from
    val rises = ArrayList<Double>(); val falls = ArrayList<Double>()
    val fsk = a.mod == Mod.FSK
    for (r in a.runs) {
        for (i in pos + margin until pos + r.n - margin) {
            if (r.hi || fsk) {
                mS += env[i]; mN++
                fS += fm[i]; fN++
                val k = Math.round(toHz(fm[i].toDouble()) / 2000).toInt() + 30
                if (k in 0..60) hist[k]++
            } else { sS += env[i]; sN++ }
        }
        pos += r.n
    }
    val markMean = if (mN != 0) mS / mN else 0.0; val spaceMean = if (sN != 0) sS / sN else 1.0
    // rise and fall at each edge of the carrier (OOK and ASK): from the level before to the level after
    if (!fsk) {
        pos = a.from
        for (r in a.runs) {
            val lo = spaceMean; val hi = markMean; val t10 = lo + 0.1 * (hi - lo); val t90 = lo + 0.9 * (hi - lo)
            val w = min(r.n.toLong(), Math.round(rate * 200e-6)).toInt()
            if (r.hi) {
                var i10 = -1; var i90 = -1
                var i = max(0, pos - w)
                while (i < pos + w && i < env.size) { if (i10 < 0 && env[i].toDouble() >= t10) i10 = i; if (i10 >= 0 && env[i].toDouble() >= t90) { i90 = i; break }; i++ }
                if (i10 >= 0 && i90 > i10) rises.add((i90 - i10) / rate * 1e6)
            } else if (pos > a.from) {
                var i90 = -1; var i10 = -1
                var i = max(0, pos - w)
                while (i < pos + w && i < env.size) { if (i90 < 0 && env[i].toDouble() <= t90) i90 = i; if (i90 >= 0 && env[i].toDouble() <= t10) { i10 = i; break }; i++ }
                if (i90 >= 0 && i10 > i90) falls.add((i10 - i90) / rate * 1e6)
            }
            pos += r.n
        }
    }
    fun avg(v: List<Double>) = if (v.isNotEmpty()) v.sum() / v.size else 0.0
    val loHz = if (fsk) toHz(a.lo) else 0.0; val hiHz = if (fsk) toHz(a.hi) else 0.0
    return Levels(dbfs(markMean), dbfs(spaceMean), dbfs(markMean) - dbfs(spaceMean), avg(rises), avg(falls),
        loHz, hiHz, if (fsk) (loHz + hiHz) / 2 else 0.0, if (fsk) abs(hiHz - loHz) / 2 else 0.0,
        if (!fsk && fN != 0) toHz(fS / fN) else 0.0, hist,
        if (a.mod == Mod.ASK) dbfs(a.lo) else 0.0, if (a.mod == Mod.ASK) dbfs(a.hi) else 0.0)
}

/** Where each eye trace starts (half a symbol before its tick), and the trace length. */
class Eye(val starts: IntArray, val len: Int)

/**
 * The eye: two symbols of the sliced signal at every tick of each frame's clock, laid over each other. Returns the
 * sample each trace starts at (half a symbol before its tick) and the trace length; the caller draws them.
 */
fun eyeStarts(a: Analysis, rate: Double): Eye {
    val u = a.symUs * rate / 1e6
    if (u == 0.0) return Eye(IntArray(0), 0)
    val starts = IntBuf()
    for (fr in a.frames) {
        val s0 = if (fr.spans.isNotEmpty()) fr.spans[0] else fr.start
        var t = s0.toDouble()
        while (t + 1.5 * u <= fr.end) { starts.add(Math.round(t - u / 2).toInt()); t += u }
    }
    return Eye(starts.toArray(), Math.round(2 * u).toInt())
}

// ---- text for the clipboard and files ---------------------------------------------------------------------------

fun pulseCsv(t: PulseTable): String {
    val rows = arrayListOf("frame,index,level,start_sample,samples,us,class")
    for (p in t.pulses) rows.add("${p.frame + 1},${p.index},${if (p.hi) "mark" else "gap"},${p.start},${p.n},${f(1, p.us)},${if (p.hi) "M" else "G"}${p.cls + 1}")
    return rows.joinToString("\n")
}

fun classCsv(t: PulseTable): String {
    val rows = arrayListOf("class,level,count,mean_us,min_us,max_us,sd_us,jitter_pct,symbols")
    fun add(c: PulseClass, i: Int) = rows.add("${if (c.hi) "M" else "G"}${i + 1},${if (c.hi) "mark" else "gap"},${c.count},${f(1, c.mean)},${f(1, c.min)},${f(1, c.max)},${f(1, c.sd)},${f(1, c.jitterPct)},${f(2, c.symbols)}")
    t.marks.forEachIndexed { i, c -> add(c, i) }; t.spaces.forEachIndexed { i, c -> add(c, i) }
    return rows.joinToString("\n")
}

fun framesCsv(segs: List<FrameSeg>): String {
    val rows = arrayListOf("frame,start_ms,end_ms,gap_ms,interval_ms,bits,hex,differs_from_frame_1_at")
    for (s in segs) rows.add("${s.index + 1},${f(3, s.startMs)},${f(3, s.endMs)},${f(3, s.gapMs)},${f(3, s.intervalMs)},${s.bits},${s.hex},${s.diff.joinToString(" ")}")
    return rows.joinToString("\n")
}

/** The samples of [from, to): time, I, Q, envelope, discriminator in Hz. */
fun samplesCsv(iq: ByteArray, env: ShortArray, fm: ShortArray, rate: Double, from: Int, to: Int): String {
    val sb = StringBuilder("sample,t_us,i,q,envelope,freq_hz")
    for (i in from until to) sb.append('\n').append("$i,${f(1, i / rate * 1e6)},${iq[2 * i]},${iq[2 * i + 1]},${env[i]},${f(0, fm[i] / FM_SCALE * rate / (2 * PI))}")
    return sb.toString()
}

/** One file for a selection: its samples, pulses, classes and frames, each section under a `# name` line. */
fun selectionCsv(samples: String, pulses: String, classes: String, frames: String): String =
    "# samples\n$samples\n\n# pulses\n$pulses\n\n# classes\n$classes\n\n# frames\n$frames\n"
