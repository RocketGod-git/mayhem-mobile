package com.rocketgod.mayhem.core

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** One signal in view: center, peak level, height over the floor, settled widths and the track's label. */
data class Signal(val hz: Double, val db: Double, val snr: Double, val bw6: Double, val bw20: Double, val cls: String, val conf: Double)

/**
 * Signal finder and modulation classifier over an averaged power spectrum (dB per bin, fftshifted).
 *
 * Each call peak-holds with decay, smooths, and takes every hump at least [minSnr] dB over the median floor. A hump is
 * measured (−6 / −20 dB widths, how far its top stands over its band, left/right energy skew, two-tone top) and matched
 * to a track holding its last few seconds. The track is what gets classified: widths as an 80th percentile so a station
 * stays "wide" through a quiet bar, the frequency band as a prior on what can live there, and a decaying vote so a
 * label only changes when a challenger clearly out-votes it for a couple of seconds.
 */
class Classifier {
    var minSnr = 6.0
    private var hold = FloatArray(0)
    private var smooth = FloatArray(0)
    private var tracks = ArrayList<Track>()
    private var frame = 0

    private class Track(var hz: Double, var seen: Int) {
        var onFrames = 0; var frames = 0
        val levels = ArrayList<Double>(); val bw6 = ArrayList<Double>(); val bw20 = ArrayList<Double>()
        val peaky = ArrayList<Double>(); val skew = ArrayList<Double>(); val bimodal = ArrayList<Double>()
        val votes = LinkedHashMap<String, Double>(); var cls = ""; var ruleConf = 0.0
    }

    fun reset() { hold = FloatArray(0); smooth = FloatArray(0); tracks.clear(); frame = 0 }

    /** [pdb]: fftshifted dB per bin; [rate]: span in Hz; [centerHz]: span center. Returns the signals found this call. */
    fun update(pdb: FloatArray, rate: Double, centerHz: Double, floorDb: Double): List<Signal> {
        val n = pdb.size; val binHz = rate / n
        if (hold.size != n) { hold = pdb.copyOf(); smooth = FloatArray(n) }
        val hold = hold
        for (i in 0 until n) hold[i] = if (pdb[i] > hold[i]) pdb[i] else hold[i] - 0.6f
        val rad = max(1, (600 / binHz).roundToInt())
        val sm = smooth
        var acc = 0.0
        for (i in 0 until min(n, rad)) acc += hold[i]
        for (i in 0 until n) {
            val a = i - rad - 1; val b = i + rad
            if (b < n) acc += hold[b]
            if (a >= 0) acc -= hold[a]
            sm[i] = (acc / (min(n - 1, b) - max(0, a + 1) + 1)).toFloat()
        }
        val thr = floorDb + minSnr
        val sep = max(2, (2500 / binHz).roundToInt())
        val out = ArrayList<Signal>()
        frame++
        for (i in 1 until n - 1) {
            if (sm[i] < thr || sm[i] < sm[i - 1] || sm[i] < sm[i + 1]) continue
            var best = true
            for (k in max(0, i - sep) until min(n, i + sep)) if (sm[k] > sm[i]) { best = false; break }
            if (!best) continue
            var pk = -1e9; var pi = i
            for (k in max(0, i - rad)..min(n - 1, i + rad)) if (hold[k] > pk) { pk = hold[k].toDouble(); pi = k }
            val w6 = width(hold, pi, pk - 6); val w20 = width(hold, pi, max(floorDb + 3, pk - 20))
            val center = (w6.first + w6.second) / 2.0
            val bw6 = (w6.second - w6.first + 1) * binHz; val bw20 = (w20.second - w20.first + 1) * binHz
            var sumL = 0.0; var sumR = 0.0; var sum = 0.0; var cnt = 0; var mx = -1e9
            for (k in w20.first..w20.second) {
                val v = 10.0.pow(hold[k] / 10.0); sum += v; cnt++
                if (k < center) sumL += v else sumR += v
                if (hold[k] > mx) mx = hold[k].toDouble()
            }
            val mean = sum / max(1, cnt)
            val peakiness = mx - 10 * log10(mean + 1e-12)
            val skew = (sumR - sumL) / (sum + 1e-12)
            val bimodal = isBimodal(hold, w6.first, w6.second, pk)
            // The power centroid of the −6 dB band sits on the carrier for AM, NFM and broadcast FM alike, and holds
            // still when FM pushes one shoulder in and out.
            var cenNum = 0.0; var cenDen = 0.0
            for (k in w6.first..w6.second) { val v = 10.0.pow(hold[k] / 10.0); cenNum += k * v; cenDen += v }
            val hz = centerHz + ((if (cenDen > 0) cenNum / cenDen else center) - n / 2) * binHz
            if (abs(hz - centerHz) < 2500) continue                 // the HackRF's own DC spike at the LO
            val t = track(hz, pk, bw6, bw20, peakiness, skew, bimodal)
            val f6 = pct(t.bw6, 0.8); val f20 = pct(t.bw20, 0.8)
            val duty = t.onFrames.toDouble() / max(1, t.frames)
            val (cls, conf) = classify(f6, f20, pct(t.peaky, 0.5), avg(t.skew), avg(t.bimodal) > 0.5, duty, levelVar(t.levels), t.frames, t.hz)
            vote(t, cls, conf)
            val c = if (t.cls.isNotEmpty()) min(1.0, t.ruleConf * min(1.0, (t.votes[t.cls] ?: 0.0) / 4)) else 0.0
            out.add(Signal(t.hz, pk, pk - floorDb, f6, f20, t.cls, c))
        }
        tracks.removeAll { frame - it.seen >= 40 }
        for (t in tracks) if (t.seen != frame) { t.frames++; decay(t) }
        // One label per hump: a wide station's noisy top throws several maxima, and a weak broadcast station's
        // subcarriers show as small humps on its shoulders.
        out.sortByDescending { it.snr }
        val kept = ArrayList<Signal>()
        for (s in out) if (kept.none { k -> abs(k.hz - s.hz) < maxOf(2500.0, 0.6 * max(k.bw20, s.bw20), 0.55 * (k.bw6 + s.bw6)) }) kept.add(s)
        return kept.take(12)
    }

    private fun track(hz: Double, level: Double, bw6: Double, bw20: Double, peaky: Double, skew: Double, bimodal: Boolean): Track {
        var t = tracks.firstOrNull { abs(it.hz - hz) < max(3000.0, 0.5 * max(bw6, pct(it.bw6, 0.8))) }
        if (t == null) { t = Track(hz, frame); tracks.add(t) }
        t.hz = t.hz * 0.7 + hz * 0.3; t.seen = frame; t.onFrames++; t.frames++
        push(t.levels, level, 20); push(t.bw6, bw6, HIST); push(t.bw20, bw20, HIST)
        push(t.peaky, peaky, HIST); push(t.skew, skew, HIST); push(t.bimodal, if (bimodal) 1.0 else 0.0, HIST)
        return t
    }

    /** A label changes only when the challenger holds clearly more of the decaying vote than the sitting one. */
    private fun vote(t: Track, cls: String, conf: Double) {
        decay(t)
        t.votes[cls] = (t.votes[cls] ?: 0.0) + 1
        val cur = t.cls; val v = t.votes[cls] ?: 0.0; val vc = if (cur.isNotEmpty()) t.votes[cur] ?: 0.0 else 0.0
        if (cur.isEmpty()) { if (t.frames >= 3) { t.cls = cls; t.ruleConf = conf }; return }
        if (cls == cur) { t.ruleConf = conf; return }
        if (v > vc * 1.6 + 0.6) { t.cls = cls; t.ruleConf = conf }
    }
    private fun decay(t: Track) { for (k in t.votes.keys) t.votes[k] = t.votes[k]!! * 0.85 }

    companion object {
        private const val HIST = 12

        private fun push(a: ArrayList<Double>, v: Double, maxN: Int) { a.add(v); if (a.size > maxN) a.removeAt(0) }
        private fun pct(a: List<Double>, p: Double): Double {
            if (a.isEmpty()) return 0.0
            val s = a.sorted()
            return s[min(s.size - 1, max(0, ceil(p * s.size).toInt() - 1))]
        }
        private fun avg(a: List<Double>) = if (a.isEmpty()) 0.0 else a.sum() / a.size
        private fun width(a: FloatArray, pi: Int, thr: Double): Pair<Int, Int> {
            var lo = pi; var hi = pi
            while (lo > 0 && a[lo - 1] >= thr) lo--
            while (hi < a.size - 1 && a[hi + 1] >= thr) hi++
            return lo to hi
        }
        /** Two maxima within 4 dB of the peak with a dip of at least 4 dB between them: two FSK tones. */
        private fun isBimodal(a: FloatArray, lo: Int, hi: Int, pk: Double): Boolean {
            if (hi - lo < 4) return false
            var peaks = 0; var lastPeak = -1; var minBetween = 1e9
            for (k in lo + 1 until hi) {
                if (a[k] >= a[k - 1] && a[k] >= a[k + 1] && a[k] > pk - 4) {
                    if (lastPeak >= 0 && a[k] - minBetween > 4 && minBetween < pk - 4) peaks++ else if (lastPeak < 0) peaks = 1
                    lastPeak = k; minBetween = 1e9
                } else if (lastPeak >= 0 && a[k] < minBetween) minBetween = a[k].toDouble()
            }
            return peaks >= 2
        }
        private fun levelVar(levels: List<Double>): Double {
            if (levels.size < 4) return 0.0
            val m = levels.sum() / levels.size
            return sqrt(levels.sumOf { (it - m) * (it - m) } / levels.size)
        }

        private enum class Band { BCFM, AIR, WEAK, PAGER, LAND, HFBC, MW, HF }
        private val HF_BROADCAST = listOf(3.2e6 to 3.4e6, 4.75e6 to 5.06e6, 5.9e6 to 6.2e6, 7.2e6 to 7.45e6, 9.4e6 to 9.9e6,
            11.6e6 to 12.1e6, 13.57e6 to 13.87e6, 15.1e6 to 15.8e6, 17.48e6 to 17.9e6, 18.9e6 to 19.02e6, 21.45e6 to 21.85e6, 25.67e6 to 26.1e6)
        /** What a frequency band is used for: the strongest prior the classifier has. */
        private fun bandOfHz(hz: Double): Band {
            if (hz < 30e6) {
                if (hz in 520e3..1.71e6) return Band.MW
                if (HF_BROADCAST.any { (a, b) -> hz in a..b }) return Band.HFBC
                return Band.HF
            }
            if (hz in 87.5e6..108e6) return Band.BCFM
            if (hz > 108e6 && hz <= 137e6) return Band.AIR
            if ((hz >= 50e6 && hz < 50.3e6) || (hz >= 144e6 && hz < 144.3e6) || (hz >= 432e6 && hz < 432.3e6) || (hz >= 1296e6 && hz < 1296.3e6)) return Band.WEAK
            if (hz in 152e6..152.9e6 || hz in 929e6..932e6) return Band.PAGER
            return Band.LAND
        }

        private fun classify(bw6: Double, bw20: Double, peakiness: Double, skew: Double, bimodal: Boolean, duty: Double, lv: Double, frames: Int, hz: Double): Pair<String, Double> {
            val young = frames < 6; val band = bandOfHz(hz)
            val peaky = peakiness > 10 && abs(skew) < 0.25
            if (band == Band.BCFM) return "WFM" to (if (bw6 > 60_000) 0.95 else 0.7)
            if (bw6 > 100_000) return "WFM" to 0.9
            if (band == Band.AIR) return if (bw6 <= 30_000) "AM" to (if (bw6 >= 1500) 0.85 else 0.6) else "WIDE" to 0.4
            if (band == Band.PAGER && (bimodal || bw6 > 4000)) return "FSK" to 0.8
            if (band == Band.LAND) {
                if (bw6 < 1200) {
                    if (duty < 0.6 && !young) return "OOK" to 0.6
                    return if (peakiness > 8) "CARRIER" to 0.7 else "DIGI" to 0.5
                }
                if (bimodal && bw6 < 30_000) return "FSK" to 0.6
                if (bw6 <= 4200) return "NFM" to 0.5
                if (bw6 <= 16_000) {
                    val flat = peakiness < 4.5
                    if (flat && lv < 1.5 && !young) return "DMR" to 0.5
                    return "NFM" to (if (flat) 0.6 else 0.8)
                }
                if (bw6 <= 40_000) return "NFM" to 0.6
                return "WIDE" to 0.4
            }
            if ((band == Band.HFBC || band == Band.MW) && peaky && bw6 >= 3000 && bw6 <= 20_000) return "AM" to 0.9
            if (bw6 < 350 && bw20 < 1500) {
                if (duty < 0.7 && !young) return "CW" to 0.75
                return if (peakiness > 8) "CW" to 0.55 else "DIGI" to 0.55
            }
            if (bw6 < 1200) return if (duty < 0.6 && !young) "OOK" to 0.5 else "DIGI" to 0.6
            if (bimodal && bw6 < 30_000) return "FSK" to 0.65
            if (bw6 <= 4200) {
                if (peaky) return "AM" to 0.6
                // The band plan settles the sideband when the skew does not: LSB below 10 MHz, USB above.
                val lsb = skew < -0.15 || (abs(skew) <= 0.15 && hz < 10e6)
                return (if (skew > 0.15) "USB" else if (lsb) "LSB" else "USB") to (if (abs(skew) > 0.15) 0.7 else 0.55)
            }
            if (bw6 <= 14_000) return if (peaky) "AM" to 0.7 else "NFM" to 0.6
            if (bw6 <= 40_000) return "NFM" to 0.5
            return "WIDE" to 0.4
        }
    }
}
