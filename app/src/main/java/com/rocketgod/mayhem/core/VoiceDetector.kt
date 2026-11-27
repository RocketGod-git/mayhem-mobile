package com.rocketgod.mayhem.core

import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * [score] 0 = certainly not speech, 1 = certainly speech; the three parts behind it; the audio level in dBFS;
 * [tone] the share of frames that are a tone or a pair of tones.
 */
data class VoiceScore(val score: Double, val band: Double, val mod: Double, val vary: Double, val levelDb: Double, val tone: Double)

/**
 * Does this sound like somebody talking? Signal strength cannot say: a data carrier, a paging burst and a dispatcher
 * look the same on a waterfall. Three things do separate speech from everything else:
 *
 *  - where the energy sits: 300–3400 Hz, where a data carrier spreads flat and a tone puts it all in one place;
 *  - how the envelope moves: syllables come two to eight times a second, a rhythm remarkably constant across
 *    languages and speakers, where carriers, tones and most digital modes hold a steady level;
 *  - how much the level varies: speech has pauses and stresses, a continuous transmission does not.
 *
 * None is conclusive alone, so the score is a blend, and it needs a reasonable level before it claims anything. A tone
 * keyed on and off (a page, DTMF, AFSK) has all three, so it is ruled out by how much of the speech band sits in a few bins.
 *
 * All of it is read from the speech band only. A CTCSS tone sits steady under the voice, so in the full-band level it
 * flattened the rhythm and the swing of a real over (155.055, PL 82.5: 0.09 before, 0.74 after).
 */
class VoiceDetector {
    private val buf = FloatArray(NF)
    private var n = 0
    private val re = FloatArray(NF); private val im = FloatArray(NF)
    private val win = FloatArray(NF) { (0.5 - 0.5 * cos(2 * Math.PI * it / NF)).toFloat() }
    private val env = FloatArray(ENV); private val envDb = FloatArray(ENV)
    // per frame: speech band share, full-band level for the quiet gate, share of the speech band in its top bins
    private val share = FloatArray(ENV); private val full = FloatArray(ENV); private val peak = FloatArray(ENV)
    private val top = FloatArray(TOP); private val sorted = FloatArray(ENV)
    private var envN = 0; private var filled = 0
    private val ere = FloatArray(ENV); private val eim = FloatArray(ENV)
    private val envRate = 48_000.0 / NF
    private val loBin = max(1, (2 * ENV / envRate).roundToInt())
    private val hiBin = min(ENV / 2 - 1, (8 * ENV / envRate).roundToInt())

    @Synchronized fun reset() { n = 0; envN = 0; filled = 0; env.fill(0f); envDb.fill(0f); share.fill(0f); full.fill(0f); peak.fill(0f) }

    /** Demodulated audio at 48 kHz, full scale ±1. */
    @Synchronized fun push(v: Float) {
        buf[n++] = v
        if (n >= NF) { frame(); n = 0 }
    }

    private fun frame() {
        var sq = 0.0
        for (i in 0 until NF) { val v = buf[i]; sq += v * v; re[i] = v * win[i]; im[i] = 0f }
        Dsp.fft(re, im)
        // The speech band is measured against 300–8000 Hz, so hiss counts against it and a CTCSS tone below 300 does not.
        fun bin(hz: Int) = (hz.toDouble() * NF / 48_000).roundToInt()
        var inBand = 0.0; var wide = 0.0
        top.fill(0f)
        for (k in bin(300)..bin(8000)) {
            val p = re[k] * re[k] + im[k] * im[k]
            wide += p
            if (k > bin(3400)) continue
            inBand += p
            if (p > top[TOP - 1]) { var m = TOP - 1; while (m > 0 && top[m - 1] < p) { top[m] = top[m - 1]; m-- }; top[m] = p }
        }
        var pk = 0.0
        for (m in 0 until TOP) pk += top[m]
        // Hann power gain 3/8, one-sided: this is the speech band's RMS
        val rms = sqrt(2 * inBand / (NF.toDouble() * NF * 0.375))
        val j = envN
        env[j] = rms.toFloat()
        envDb[j] = (20 * log10(rms + 1e-9)).toFloat()
        share[j] = if (wide > 0) (inBand / wide).toFloat() else 0f
        full[j] = sqrt(sq / NF).toFloat()
        peak[j] = if (inBand > 0) (pk / inBand).toFloat() else 0f
        envN = (j + 1) % ENV
        if (filled < ENV) filled++
    }

    /** Upper quartile of the band share: a fade or a pause between words does not pull it down. */
    private fun bandShare(): Double { share.copyInto(sorted); sorted.sort(); return sorted[ENV * 3 / 4].toDouble() }

    /** Share of frames that are a tone or a pair of tones. */
    private fun tonal(): Double { var c = 0; for (i in 0 until ENV) if (peak[i] > 0.9f) c++; return c.toDouble() / ENV }

    /** The current verdict; meaningless until about a second of audio has gone through. */
    @Synchronized fun read(): VoiceScore {
        if (filled < ENV) return VoiceScore(0.0, 0.0, 0.0, 0.0, -99.0, 0.0)
        var mean = 0.0; var fullMean = 0.0
        for (i in 0 until ENV) { mean += env[i]; fullMean += full[i] }
        mean /= ENV; fullMean /= ENV
        for (i in 0 until ENV) { ere[i] = (env[(envN + i) % ENV] - mean).toFloat(); eim[i] = 0f }
        Dsp.fft(ere, eim)
        var syl = 0.0
        for (k in loBin..hiBin) syl += (ere[k] * ere[k] + eim[k] * eim[k]).toDouble()
        val mod = if (mean > 0) sqrt(syl / ENV) / (mean * ENV / 2) else 0.0
        var dbMean = 0.0
        for (i in 0 until ENV) dbMean += envDb[i]
        dbMean /= ENV
        var vsum = 0.0
        for (i in 0 until ENV) { val d = envDb[i] - dbMean; vsum += d * d }
        val vary = sqrt(vsum / ENV)
        val levelDb = 20 * log10(fullMean + 1e-9); val shareQ = bandShare(); val tone = tonal()
        // Too quiet to judge: squelch open on noise would otherwise score well on variability alone.
        if (levelDb < -46) return VoiceScore(0.0, shareQ, mod, vary, levelDb, tone)
        // Rhythm and swing count only as far as the energy is in the speech band: squelch noise that flutters on a
        // weak carrier swings at the syllable rate too. A tone keyed on and off (a page, DTMF, AFSK packets) has the
        // band and the swing, so a window that is tone for a quarter of its frames scores nothing.
        val band = clamp01((shareQ - 0.50) / 0.30)
        val rhythm = clamp01((mod - 0.06) / 0.14)
        val moving = clamp01((vary - 2) / 6)
        val untoned = clamp01(1 - tone / 0.25)
        return VoiceScore(untoned * band * (0.35 + 0.40 * rhythm + 0.25 * moving), shareQ, mod, vary, levelDb, tone)
    }

    private companion object {
        const val NF = 512        // 10.7 ms at 48 kHz, 93.75 Hz per bin
        const val ENV = 128       // 1.37 s of envelope
        const val TOP = 6         // bins that hold a tone or a pair of tones
        fun clamp01(v: Double) = if (v < 0) 0.0 else if (v > 1) 1.0 else v
    }
}
