package com.rocketgod.mayhem.core.atsc

import com.rocketgod.mayhem.core.Dsp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 8VSB receiver for one burst of samples (ATSC A/53 Part 2 Sec 5): pilot lock, resampling to 2 samples per symbol
 * through a root-raised-cosine receive filter, segment and field sync, then a T/2 equalizer (complex in, real out,
 * with a pilot bias tap and decision feedback for long echoes) and the 12-way trellis decoder.
 * The equalizer starts from a least-squares fit on the field sync and segment syncs; its feedback taps start from
 * the echo profile measured on PN511, then both adapt (LMS) on decisions.
 */
const val SR = 4.5e6 / 286 * 684
private const val SEG2 = 2 * SEG
private const val PN511S = "0000000101111111110010101010111001100110100010001001111000011101011111010011010100111011001110100100010110001111001000010100011111001111010100010100110000110001000001000011111100000101010000001100111111101110101010010110011000110111011110110100101001001110011100010111010000110100111110110001010110111100110110101110110110010110110111001001001011100011100101111010001101011000010011011111000100101011110001100101000010001100000111101111110101101010110010011001000111011100001011010000011011000000100100000001110"
private const val PN63S = "111001001011011101100110101011111100000100001100010100111101000"
private const val VSB_MODE_8T = "000010100101111101011010"
val PN511 = FloatArray(511) { if (PN511S[it] == '1') 1f else -1f }
val PN63 = FloatArray(63) { if (PN63S[it] == '1') 1f else -1f }
private val FS_NORMAL by lazy { buildFieldSync(false) }
private val FS_INVERTED by lazy { buildFieldSync(true) }
/** Known symbols at the start of a field sync segment (pilot excluded): 728 of them. */
fun fieldSyncSymbols(middleInverted: Boolean): FloatArray = if (middleInverted) FS_INVERTED else FS_NORMAL
private fun buildFieldSync(middleInverted: Boolean): FloatArray {
    val out = FloatArray(728)
    out[0] = 5f; out[1] = -5f; out[2] = -5f; out[3] = 5f
    for (k in 0 until 511) out[4 + k] = 5 * PN511[k]
    for (k in 0 until 63) { out[515 + k] = 5 * PN63[k]; out[578 + k] = (if (middleInverted) -5 else 5) * PN63[k]; out[641 + k] = 5 * PN63[k] }
    for (k in 0 until 24) out[704 + k] = if (VSB_MODE_8T[k] == '1') 5f else -5f
    return out
}

/** Root raised cosine, time in symbols. */
fun rrc(t: Double, a: Double): Double {
    if (abs(t) < 1e-9) return 1 - a + 4 * a / PI
    if (abs(abs(4 * a * t) - 1) < 1e-9) return a / sqrt(2.0) * ((1 + 2 / PI) * sin(PI / (4 * a)) + (1 - 2 / PI) * cos(PI / (4 * a)))
    val q = 4 * a * t
    return (sin(PI * t * (1 - a)) + 4 * a * t * cos(PI * t * (1 + a))) / (PI * t * (1 - q * q))
}
const val ALPHA = 0.1152

class PilotInfo(
    val hz: Double, val db: Double, val topDb: Double,
    /** The pilot over the plateau that A/53 gives (1.25 against the data's 21 of power, per FFT bin here). */
    val expectDb: Double,
    /** An 8VSB channel: a data plateau over the floor and a pilot at about the A/53 level above it (a spur on noise is not). */
    val ok: Boolean,
)
/** Plateau over the floor an 8VSB channel must show, dB. */
const val MIN_TOP_DB = 2.5

private fun ms(): Double = System.nanoTime() / 1e6

/**
 * The pilot near [nominal] (from the tuned center; -Sr/4 when the channel is centered), its offset from where it
 * should be and its level over the data plateau above it; `topDb` is the plateau over the floor below the channel.
 */
fun findPilot(re: FloatArray, im: FloatArray, rate: Double, searchHz: Double = 30_000.0, nominal: Double = -SR / 4, n: Int = re.size): PilotInfo? {
    val nn = 16384
    if (n < nn) return null
    val acc = DoubleArray(nn); val fr = FloatArray(nn); val fi = FloatArray(nn); val w = FloatArray(nn)
    for (i in 0 until nn) w[i] = (0.5 - 0.5 * cos(2 * PI * i / nn)).toFloat()
    val frames = min(24, n / nn); val step = (n - nn) / max(1, frames - 1)
    for (f in 0 until frames) {
        val o = f * step
        for (i in 0 until nn) { fr[i] = re[o + i] * w[i]; fi[i] = im[o + i] * w[i] }
        Dsp.fft(fr, fi)
        for (i in 0 until nn) acc[i] += fr[i].toDouble() * fr[i] + fi[i].toDouble() * fi[i]
    }
    fun wrap(k: Long): Int = (((k % nn) + nn) % nn).toInt()
    fun at(k: Long): Double = acc[wrap(k)]
    fun bin(hz: Double): Double = acc[wrap(Math.round(hz / rate * nn))]
    val lo = Math.round((nominal - searchHz) / rate * nn); val hi = Math.round((nominal + searchHz) / rate * nn)
    var best = lo; var bv = -1.0
    for (k in lo..hi) { val v = at(k); if (v > bv) { bv = v; best = k } }
    if (bv <= 0) return null
    val a = kotlin.math.ln(at(best - 1) + 1e-12); val b = kotlin.math.ln(at(best) + 1e-12); val c = kotlin.math.ln(at(best + 1) + 1e-12)
    val den = a - 2 * b + c; val d = if (den != 0.0) 0.5 * (a - c) / den else 0.0
    val hz = (best + d) * rate / nn
    // the data plateau: median level from 0.3 MHz above the pilot to the top of the channel (what of it is in the span);
    // the floor: the stretches just below and just above the channel, together
    val plateau = ArrayList<Double>(); val outside = ArrayList<Double>()
    val edge = rate / 2 - 150_000
    var f = hz + 300_000; while (f < hz + 5_500_000 && f < edge) { plateau.add(bin(f)); f += rate / nn * 7 }
    f = hz - 450_000; while (f > -edge && f > hz - 900_000) { outside.add(bin(f)); f -= rate / nn * 3 }
    f = hz + 5_850_000; while (f < edge && f < hz + 6_300_000) { outside.add(bin(f)); f += rate / nn * 3 }
    fun median(v: ArrayList<Double>): Double { v.sort(); val x = if (v.isEmpty()) 0.0 else v[v.size shr 1]; return if (x == 0.0 || x.isNaN()) 1e-12 else x }
    val med = median(plateau)
    val pk = at(best - 1) + at(best) + at(best + 1)
    val db = 10 * log10(pk / med)
    val topDb = if (outside.size > 4) 10 * log10(med / median(outside)) else Double.NaN
    // pilot power 1.25^2 against data power 21 spread over Sr/2; per Hann bin (1.5 bins wide), the median 1.6 dB under the mean
    val expectDb = 10 * log10((SR / 2) * 1.5625 / 21 / (1.5 * rate / nn)) + 1.6
    val ok = topDb.isFinite() && topDb >= MIN_TOP_DB && db > expectDb - 9 && db < expectDb + 6
    return PilotInfo(hz - nominal, db, topDb, expectDb, ok)
}

/** Halves the rate with a 31-tap half-band low pass (16 and 20 MS/s spans to 8 and 10). */
private fun halve(re: FloatArray, im: FloatArray, len: Int): Triple<FloatArray, FloatArray, Int> {
    val l = 31; val h = DoubleArray(l); val c = (l - 1) / 2
    var s = 0.0
    for (k in 0 until l) {
        val t = k - c; val v = if (t == 0) 0.5 else sin(PI * t / 2) / (PI * t)
        val w = 0.42 - 0.5 * cos(2 * PI * k / (l - 1)) + 0.08 * cos(4 * PI * k / (l - 1))
        h[k] = (v * w).toFloat().toDouble(); s += h[k]
    }
    for (k in 0 until l) h[k] = (h[k] / s).toFloat().toDouble()
    val taps = (0 until l).filter { h[it] != 0.0 }.toIntArray(); val hv = DoubleArray(taps.size) { h[taps[it]] }
    val n = (len - l) / 2; val or = FloatArray(n); val oi = FloatArray(n)
    for (m in 0 until n) {
        var ar = 0.0; var ai = 0.0; val o = 2 * m
        for (q in taps.indices) { val v = hv[q]; val k = taps[q]; ar += v * re[o + k]; ai += v * im[o + k] }
        or[m] = ar.toFloat(); oi[m] = ai.toFloat()
    }
    return Triple(or, oi, n)
}

/** Receive-filter kernel for the band center at DC (RRC of rate Sr/2), sampled per input sample at NP phases. */
private const val NP = 256
private class Kernel(val k: Int, val tab: FloatArray)
private val kernels = java.util.concurrent.ConcurrentHashMap<Long, Kernel>()
private fun kernelFor(rate: Double): Kernel {
    val key = Math.round(rate)
    kernels[key]?.let { return it }
    val span = 6; val tp = 2 / SR; val half = ceil(span * tp * rate).toInt(); val kk = 2 * half
    val tab = FloatArray(NP * kk)
    for (p in 0 until NP) {
        val frac = p.toDouble() / NP; var s = 0.0
        for (k in 0 until kk) {
            val t = frac + half - 1 - k; val ts = t / rate; val u = ts / tp
            val w = if (abs(t) >= half) 0.0 else 0.5 + 0.5 * cos(PI * t / half)
            val v = (rrc(u, ALPHA) * w).toFloat(); tab[p * kk + k] = v; s += v
        }
        for (k in 0 until kk) tab[p * kk + k] = (tab[p * kk + k] / s).toFloat()
    }
    val r = Kernel(kk, tab); kernels[key] = r; return r
}

class BurstState(
    /** Sample clock correction learned on this channel (fraction, +1e-6 = 1 ppm more samples per symbol). */
    var eps: Double = 0.0,
    var pilotHz: Double = 0.0,
    /** Feedback delays that carried echoes on this channel last time (null: search them all). */
    var act: IntArray? = null,
    var bursts: Int = 0,
) {
    fun copy() = BurstState(eps, pilotHz, act, bursts)
}
class FieldOut(val bytes: ByteArray, val snrDb: Double, val inverted: Boolean, val rho: Float)
class BurstResult {
    var ok = false; var reason = ""
    var pilot: PilotInfo? = null
    val fields = ArrayList<FieldOut>()
    /** Field syncs found, segment syncs strength (peak over mean). */
    var syncs = 0; var segPeak = 0.0
    var snrDb = Double.NaN; var sliceSnrDb = Double.NaN
    /** Equalizer output histogram over -10.5..+10.5 in 168 bins, and a strip of output values for the eye. */
    val hist = IntArray(168); var eye = FloatArray(0)
    /** Echo profile from PN511: magnitude (dB re the main path) per half symbol from -32 to +704 symbols. */
    var echo = FloatArray(0); val echoStart = -ECHO_PRE
    /** Feedback and forward taps as they ended. */
    var dfe = FloatArray(0); var ffe = FloatArray(0)
    var eps = 0.0; var cpuMs = 0.0; var symbols = 0
    /** Milliseconds per stage. */
    var profile: Map<String, Double> = emptyMap()
}

private const val PRE = 8
private const val POST = 20
private const val NFF = 2 * (PRE + POST) + 1
private const val ECHO_PRE = 32
private const val ECHO_POST = 704

/** Demodulates one burst (signed int8 IQ at [rate], tuned to the channel center) to trellis-decoded field bytes. */
fun demodBurst(iq: ByteArray, rate: Double, st: BurstState, len: Int = iq.size): BurstResult {
    val t0 = ms()
    val res = BurstResult(); res.eps = st.eps
    fun done(): BurstResult { res.cpuMs = ms() - t0; return res }
    var n = len shr 1
    var re = FloatArray(n); var im = FloatArray(n)
    for (i in 0 until n) { re[i] = iq[2 * i] + 0.5f; im[i] = iq[2 * i + 1] + 0.5f }
    var r = rate
    while (r > 12_500_000) { val h = halve(re, im, n); re = h.first; im = h.second; n = h.third; r /= 2 }
    if (r < 6_400_000) { res.reason = "rate too low to hold the channel"; return done() }
    val pilot = findPilot(re, im, r, n = n)
    res.pilot = pilot
    val tm = arrayListOf(ms())
    if (pilot == null || !pilot.ok) { res.reason = "no pilot"; return done() }
    st.pilotHz = pilot.hz

    // pilot phase at ~100 kHz: mix the pilot to DC, average blocks, low pass both ways
    val dd = max(8, Math.round(r / 100_000).toInt()); val nb = n / dd
    val pr = DoubleArray(nb); val pi = DoubleArray(nb)
    val fp = -SR / 4 + pilot.hz; val w = -2 * PI * fp / r
    run {
        var cr = 1.0; var ci = 0.0; val dr = cos(w); val di = sin(w)
        for (b in 0 until nb) {
            var ar = 0.0; var ai = 0.0
            for (k in 0 until dd) {
                val i = b * dd + k; val x = re[i].toDouble(); val y = im[i].toDouble()
                ar += x * cr - y * ci; ai += x * ci + y * cr
                val t = cr * dr - ci * di; ci = cr * di + ci * dr; cr = t
            }
            val g = 1 / hypot(cr, ci); cr *= g; ci *= g
            pr[b] = ar; pi[b] = ai
        }
        val a = exp(-2 * PI * 2_000 / (r / dd))
        for (pass in 0 until 2) {
            var sr = pr[0]; var si = pi[0]
            for (b in 0 until nb) { sr = a * sr + (1 - a) * pr[b]; si = a * si + (1 - a) * pi[b]; pr[b] = sr; pi[b] = si }
            sr = pr[nb - 1]; si = pi[nb - 1]
            for (b in nb - 1 downTo 0) { sr = a * sr + (1 - a) * pr[b]; si = a * si + (1 - a) * pi[b]; pr[b] = sr; pi[b] = si }
        }
    }
    val ph = DoubleArray(nb)
    for (b in 0 until nb) { var p = atan2(pi[b], pr[b]); if (b > 0) { val d = p - ph[b - 1]; p -= 2 * PI * Math.round(d / (2 * PI)) }; ph[b] = p }
    // band center to DC: rotate by the pilot's frequency + Sr/4 and its tracked phase, block by block
    run {
        val w0 = -2 * PI * (fp + SR / 4) / r
        for (b in 0 until nb) {
            val p0 = ph[b]; val p1 = if (b + 1 < nb) ph[b + 1] else ph[b]
            val th0 = w0 * (b * dd + dd / 2.0) - p0; val dth = w0 - (p1 - p0) / dd
            var cr = cos(th0 - dth * (dd / 2.0)); var ci = sin(th0 - dth * (dd / 2.0))
            val dr = cos(dth); val di = sin(dth)
            val base = b * dd
            for (k in 0 until dd) {
                val i = base + k; val x = re[i].toDouble(); val y = im[i].toDouble()
                re[i] = (x * cr - y * ci).toFloat(); im[i] = (x * ci + y * cr).toFloat()
                val t = cr * dr - ci * di; ci = cr * di + ci * dr; cr = t
            }
        }
        for (i in nb * dd until n) { re[i] = 0f; im[i] = 0f }
    }

    // resample to 2 samples per symbol, the sample clock corrected by eps; re-done once when the segment syncs drift.
    // The segment sync is followed block by block: a jump means samples were lost, and the burst ends there.
    var zr = FloatArray(0); var zi = FloatArray(0); var segPos = 0.0
    for (attempt in 0 until 2) {
        val z = resample(re, im, nb * dd, r, st.eps); zr = z.first; zi = z.second
        val blk = 32 * SEG2
        if (zr.size < 3 * blk) { res.reason = "burst too short"; return done() }
        val nbk = (zr.size - 8) / blk; val pos = DoubleArray(nbk); val pk = DoubleArray(nbk)
        for (i in 0 until nbk) { val g = segSync(zr, i * blk, blk); pos[i] = g.first; pk[i] = g.second }
        // the longest run of blocks whose sync holds still (within 1.5 samples block to block)
        var bestA = 0; var bestB = 0
        var a = 0
        while (a < nbk) {
            if (pk[a] < 4) { a++; continue }
            var b = a + 1; var last = pos[a]
            while (b < nbk && pk[b] >= 4) { var p = pos[b]; p -= SEG2 * Math.round((p - last) / SEG2).toDouble(); if (abs(p - last) > 1.5) break; pos[b] = p; last = p; b++ }
            if (b - a > bestB - bestA) { bestA = a; bestB = b }
            a = b
        }
        var peak = Double.POSITIVE_INFINITY
        for (i in bestA until bestB) peak = min(peak, pk[i])
        res.segPeak = if (peak.isFinite()) peak else 0.0
        if (bestB - bestA < 3) { res.reason = "no segment sync"; return done() }
        if (bestA > 0 || bestB < nbk) { zr = zr.copyOfRange(bestA * blk, bestB * blk); zi = zi.copyOfRange(bestA * blk, bestB * blk) }
        segPos = (((pos[bestA] - bestA * blk) % SEG2) + SEG2) % SEG2
        val end = bestB - bestA; for (i in 0 until end) pos[i] = pos[bestA + i]
        val drift = pos[end - 1] - pos[0]; val span = (end - 1).toDouble() * blk
        if (abs(drift) < 0.3 || attempt == 1 || abs(drift / span) > 40e-6) break
        st.eps += drift / span
    }
    res.eps = st.eps
    re = FloatArray(0); im = FloatArray(0)
    tm.add(ms())
    // energy normalization
    run {
        var s = 0.0; val m = min(zr.size, 400_000)
        for (i in 0 until m) s += zr[i].toDouble() * zr[i]
        val g = sqrt(22.6 / (s / m)).toFloat()
        for (i in zr.indices) { zr[i] *= g; zi[i] *= g }
    }
    val c0 = ((Math.round(segPos) % SEG2 + SEG2) % SEG2).toInt()
    // field syncs: PN511 after the segment sync, on the on-symbol samples
    val nSeg = (zr.size - c0 - 2 * 520) / SEG2
    val rho = FloatArray(max(0, nSeg))
    for (s in 0 until nSeg) {
        val o = c0 + s * SEG2 + 8
        var c = 0.0; var e = 0.0
        for (k in 0 until 511) { val v = zr[o + 2 * k].toDouble(); c += v * PN511[k]; e += v * v }
        rho[s] = (c / sqrt(e * 511 + 1e-9)).toFloat()
    }
    var first = -1
    for (s in 0 until nSeg) if (rho[s] > 0.45 && (s == 0 || rho[s] >= rho[s - 1]) && (s + 1 >= nSeg || rho[s] >= rho[s + 1])) { if (c0 + s * SEG2 >= 2 * POST + 4) { first = s; break } }
    if (first < 0) { res.reason = "no field sync"; return done() }
    val syncs = ArrayList<Int>()
    run { var s = first; while (s < nSeg) { syncs.add(s); s += FIELD_SEGS } }
    res.syncs = syncs.count { rho[it] > 0.45 }
    // a field sync found off the 313-segment grid means samples were lost: stop the burst there
    for (s in first + 1 until nSeg) if (rho[s] > 0.6 && (s - first) % FIELD_SEGS != 0) { while (syncs.isNotEmpty() && syncs.last() >= s - FIELD_SEGS + 1) syncs.removeAt(syncs.size - 1); break }
    val start = c0 + first * SEG2
    val avail = (zr.size - start - 2 * PRE - 2) / 2
    val nFields = min(syncs.size, avail / FIELD_SYMS)
    if (nFields < 1) { res.reason = "no whole field"; return done() }
    res.echo = echoProfile(zr, zi, syncs.subList(0, min(4, nFields)).map { c0 + it * SEG2 })
    tm.add(ms())
    val inv = BooleanArray(nFields) { f ->
        val o = c0 + syncs[f] * SEG2 + 8 + 2 * 511; var a = 0.0; var b = 0.0
        for (k in 0 until 63) { a += zr[o + 2 * k] * PN63[k]; b += zr[o + 2 * (63 + k)] * PN63[k] }
        a * b < 0
    }
    val ydata = FloatArray(FIELD_DATA_SYMS)
    val full = st.act == null || st.bursts % 20 == 0
    st.bursts++
    val eq = Equalizer(zr, zi, start, res.echo, nFields * FIELD_SYMS, if (full) null else st.act)
    eq.train(fieldSyncSymbols(inv[0]))
    // the first field twice: once to converge (faster steps), then for real
    tm.add(ms())
    eq.gear(4.0)
    eq.runField(0, fieldSyncSymbols(inv[0]), ydata)
    eq.prune()
    st.act = eq.active()
    // after a search over every delay the pruned set converges once more before it counts
    if (full) { eq.restart(); eq.train(fieldSyncSymbols(inv[0])); eq.gear(4.0); eq.runField(0, fieldSyncSymbols(inv[0]), ydata) }
    eq.gear(1.0)
    val trellis = TrellisDecoder()
    var errT = 0.0; var nT = 0.0; var errS = 0.0; var tEq = 0.0; var tTr = 0.0
    val eye = FloatArray(3000)
    for (f in 0 until nFields) {
        val q0 = ms()
        eq.runField(f, fieldSyncSymbols(inv[f]), ydata)
        tEq += ms() - q0
        val q1 = ms()
        val bytes = trellis.field(ydata)
        tTr += ms() - q1
        var e = 0.0; var es = 0.0
        val lv = trellis.levels
        for (i in 0 until FIELD_DATA_SYMS) {
            val y = ydata[i].toDouble(); val d = y - lv[i]; e += d * d
            val sl = max(-7.0, min(7.0, 2 * floor(y / 2) + 1)); val ds = y - sl; es += ds * ds
            val h = floor((y + 10.5) * 8).toInt(); if (h in 0..167) res.hist[h]++
        }
        if (f == nFields - 1) for (i in 0 until 3000) eye[i] = ydata[(i * 79) % FIELD_DATA_SYMS]
        errT += e; errS += es; nT += FIELD_DATA_SYMS
        res.fields.add(FieldOut(bytes, 10 * log10(21 / (e / FIELD_DATA_SYMS)), inv[f], rho[syncs[f]]))
    }
    res.snrDb = 10 * log10(21 / (errT / nT))
    res.sliceSnrDb = 10 * log10(21 / (errS / nT))
    res.eye = eye
    res.dfe = eq.dfeTaps(); res.ffe = eq.ffeTaps()
    res.symbols = nFields * FIELD_SYMS
    res.profile = mapOf("front" to tm[1] - tm[0], "sync" to tm[2] - tm[1], "train" to tm[3] - tm[2], "eq" to tEq, "trellis" to tTr, "nd" to eq.feedback.toDouble())
    res.ok = true
    return done()
}

/** 2-sps resampling through the receive filter; the band center is at DC on input and the pilot at DC on output. */
fun resample(re: FloatArray, im: FloatArray, n: Int, rr: Double, eps: Double): Pair<FloatArray, FloatArray> {
    val kn = kernelFor(rr); val kk = kn.k; val tab = kn.tab; val half = kk / 2
    val step = rr / (2 * SR) * (1 + eps)
    val m = floor((n - kk - 2) / step).toInt() - 1
    val zr = FloatArray(max(0, m)); val zi = FloatArray(max(0, m))
    val wph = PI / 4 * (1 + eps)
    var tau = half + 1.0
    val ph0 = 2 * PI * (SR / 4) * tau / rr
    var cr = cos(ph0); var ci = sin(ph0); val dr = cos(wph); val di = sin(wph)
    for (j in 0 until m) {
        var n0 = floor(tau).toInt(); var p = Math.round((tau - n0) * NP).toInt()
        if (p == NP) { p = 0; n0++ }
        val base = n0 - half + 1; val o = p * kk
        var ar = 0f; var ai = 0f
        for (k in 0 until kk) { val h = tab[o + k]; ar += h * re[base + k]; ai += h * im[base + k] }
        zr[j] = (ar * cr - ai * ci).toFloat(); zi[j] = (ar * ci + ai * cr).toFloat()
        val t = cr * dr - ci * di; ci = cr * di + ci * dr; cr = t
        if (j and 1023 == 1023) { val g = 1 / hypot(cr, ci); cr *= g; ci *= g }
        tau += step
    }
    return zr to zi
}

/** Segment sync (+5 -5 -5 +5) folded over a block: its position mod 1664 samples and peak over mean. */
fun segSync(z: FloatArray, from: Int, len: Int): Pair<Double, Double> {
    val acc = DoubleArray(SEG2); val segs = len / SEG2
    for (s in 0 until segs) {
        val o = from + s * SEG2
        for (k in 0 until SEG2) { val i = o + k; acc[k] += (z[i] - z[i + 2] - z[i + 4] + z[i + 6]).toDouble() }
    }
    var best = 0; var mean = 0.0
    for (k in 0 until SEG2) { mean += abs(acc[k]); if (acc[k] > acc[best]) best = k }
    mean /= SEG2
    val a = acc[(best + SEG2 - 1) % SEG2]; val b = acc[best]; val c = acc[(best + 1) % SEG2]; val den = a - 2 * b + c
    val d = if (den != 0.0) 0.5 * (a - c) / den else 0.0
    return ((((from + best + d) % SEG2) + SEG2) % SEG2) to b / (mean + 1e-9)
}

/** Channel echo profile from the PN511 of each field sync: |h| per half symbol, dB re the strongest path. */
private fun echoProfile(zr: FloatArray, zi: FloatArray, at: List<Int>): FloatArray {
    val n = 2 * (ECHO_PRE + ECHO_POST); val out = FloatArray(n); val pw = DoubleArray(n)
    for (s in at) {
        val o = s + 8
        for (d in 0 until n) {
            val off = o + d - 2 * ECHO_PRE
            if (off < 0 || off + 1022 >= zr.size) continue
            var a = 0f; var b = 0f
            for (k in 0 until 511) { val p = PN511[k]; a += p * zr[off + 2 * k]; b += p * zi[off + 2 * k] }
            pw[d] += a.toDouble() * a + b.toDouble() * b
        }
    }
    var mx = 1e-12
    for (d in 0 until n) if (pw[d] > mx) mx = pw[d]
    for (d in 0 until n) out[d] = (10 * log10(pw[d] / mx + 1e-9)).toFloat()
    return out
}

/** The equalizer: FFE on the complex 2-sps samples (real output), a bias tap and a decision-feedback section. */
private class Equalizer(private val zr: FloatArray, private val zi: FloatArray, private val start: Int, echo: FloatArray, total: Int, known: IntArray?) {
    private val a = FloatArray(NFF); private val b = FloatArray(NFF); private var bias = 1.25
    private val nd = ECHO_POST
    private val f = FloatArray(nd + 1)
    /** The feedback delays in use (a sparse set around the echoes). */
    private var act: IntArray
    /** Decisions (or known symbols) by symbol index, offset by nd + 1. */
    private val dec = ByteArray(total + nd + 2)
    private val mu0 = 0.004 / (NFF * 22); private var mu = mu0
    private var muF = 0.0; private var muF0 = 0.0
    init {
        // feedback delays to start with: wherever the PN511 echo profile stands 7 dB over its own floor
        val tail = ArrayList<Float>()
        for (d in 2 * (ECHO_PRE + 40) until echo.size) tail.add(echo[d])
        tail.sort()
        val floor = if (tail.isNotEmpty()) tail[tail.size shr 1] else -30f
        val want = ByteArray(nd + 1)
        for (d in 1..24) want[d] = 1
        if (known != null) { for (d in known) want[d] = 1 } else want.fill(1, 1)
        for (i in 2 * ECHO_PRE until echo.size) if (echo[i] > floor + 6) { val c = Math.round((i - 2 * ECHO_PRE) / 2.0).toInt(); for (d in c - 6..c + 6) if (d in 1..nd) want[d] = 1 }
        act = use(want)
    }
    private fun use(want: ByteArray): IntArray {
        val out = ArrayList<Int>()
        for (d in 1..nd) if (want[d].toInt() != 0) out.add(d) else f[d] = 0f
        muF0 = 0.03 / (21 * max(16, out.size)); muF = muF0
        return out.toIntArray()
    }
    /** After convergence: keep the feedback taps that matter, with a few neighbors each. */
    fun prune() {
        val mags = act.map { abs(f[it]) }.sorted()
        val thr = max(0.012f, 4 * (mags.getOrNull(mags.size shr 1) ?: 0f)); val want = ByteArray(nd + 1)
        for (d in 1..20) want[d] = 1
        for (d in act) if (abs(f[d]) > thr) for (k in d - 8..d + 8) if (k in 1..nd) want[k] = 1
        act = use(want)
    }
    val feedback: Int get() = act.size
    /** Feedback taps back to zero (the forward taps keep what they learned). */
    fun restart() { f.fill(0f) }
    fun active(): IntArray = act.copyOf()
    /** Step sizes as a multiple of the tracking ones. */
    fun gear(x: Double) { mu = mu0 * x; muF = muF0 * x }
    fun ffeTaps(): FloatArray = FloatArray(NFF) { hypot(a[it], b[it]) }
    fun dfeTaps(): FloatArray = f.copyOfRange(1, f.size)
    /** Least squares on the known symbols of the first field (field sync and every segment sync). */
    fun train(fs: FloatArray) {
        val rows = ArrayList<Int>(); val dv = ArrayList<Float>()
        for (k in 0 until FIELD_SYMS) {
            if (k < 728) { rows.add(k); dv.add(fs[k]) }
            else if (k >= SEG && k % SEG < 4) { rows.add(k); dv.add(if (k % SEG == 0 || k % SEG == 3) 5f else -5f) }
        }
        val p = 2 * NFF + 1; val aa = DoubleArray(p * p); val rhs = DoubleArray(p); val x = DoubleArray(p)
        for (r in rows.indices) {
            val c = start + 2 * rows[r] + 2 * PRE
            for (j in 0 until NFF) { x[j] = zr[c - j].toDouble(); x[NFF + j] = zi[c - j].toDouble() }
            x[p - 1] = 1.0
            val d = dv[r].toDouble()
            for (q in 0 until p) { val xp = x[q]; rhs[q] += xp * d; val o = q * p; for (s in q until p) aa[o + s] += xp * x[s] }
        }
        var tr = 0.0
        for (q in 0 until p) { for (s in 0 until q) aa[q * p + s] = aa[s * p + q]; tr += aa[q * p + q] }
        for (q in 0 until p) aa[q * p + q] += 1e-3 * tr / p
        val sol = solve(aa, rhs, p) ?: return
        for (j in 0 until NFF) { a[j] = sol[j].toFloat(); b[j] = sol[NFF + j].toFloat() }
        bias = sol[p - 1]
    }
    /** Equalizes field [fi] (symbols from its field sync), writing its 312 x 828 data symbols into [out]. */
    fun runField(fi: Int, fs: FloatArray, out: FloatArray) {
        val zr = zr; val zi = zi; val a = a; val b = b; val fb = f; val act = act; val na = act.size; val dec = dec; val off = nd + 1
        val mu = mu.toFloat(); val muF = muF.toFloat(); val k0 = fi * FIELD_SYMS
        var o = 0
        var bias = bias
        for (p in 0 until FIELD_SYMS) {
            val k = k0 + p; val c = start + 2 * k + 2 * PRE; val q = k + off
            var y = bias.toFloat()
            for (j in 0 until NFF) y += a[j] * zr[c - j] + b[j] * zi[c - j]
            for (t in 0 until na) { val d = act[t]; y -= fb[d] * dec[q - d] }
            val want: Float
            val seg = p / SEG; val sp = p - seg * SEG
            if (p < 728) want = fs[p]
            else if (seg > 0 && sp < 4) want = if (sp == 0 || sp == 3) 5f else -5f
            else { var w = 2 * floor(y / 2) + 1; if (w > 7) w = 7f else if (w < -7) w = -7f; want = w }
            if (seg > 0 && sp >= 4) out[o++] = y
            dec[q] = want.toInt().toByte()
            val e = want - y; val me = mu * e
            for (j in 0 until NFF) { a[j] += me * zr[c - j]; b[j] += me * zi[c - j] }
            bias += 0.0005 * e
            if (p and 1 == 0) { val mf = muF * e; for (t in 0 until na) { val d = act[t]; fb[d] -= mf * dec[q - d] } }
        }
        this.bias = bias
    }
}

private fun solve(a: DoubleArray, b: DoubleArray, n: Int): DoubleArray? {
    // Cholesky
    val l = DoubleArray(n * n)
    for (i in 0 until n) {
        for (j in 0..i) {
            var s = a[i * n + j]
            for (k in 0 until j) s -= l[i * n + k] * l[j * n + k]
            if (i == j) { if (s <= 0) return null; l[i * n + i] = sqrt(s) } else l[i * n + j] = s / l[j * n + j]
        }
    }
    val y = DoubleArray(n); val x = DoubleArray(n)
    for (i in 0 until n) { var s = b[i]; for (k in 0 until i) s -= l[i * n + k] * y[k]; y[i] = s / l[i * n + i] }
    for (i in n - 1 downTo 0) { var s = y[i]; for (k in i + 1 until n) s -= l[k * n + i] * x[k]; x[i] = s / l[i * n + i] }
    return x
}
