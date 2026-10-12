package com.rocketgod.mayhem.core

import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/** [score] 0 = certainly not speech, 1 = certainly speech; the three parts behind it; the audio level in dBFS. */
data class VoiceScore(val score: Double, val band: Double, val mod: Double, val vary: Double, val levelDb: Double)

/**
 * Does this sound like somebody talking? Signal strength cannot say: a data carrier, a paging burst and a dispatcher
 * look the same on a waterfall. Three things do separate speech from everything else:
 *
 *  - where the energy sits: 300–3400 Hz, where a data carrier spreads flat and a tone puts it all in one place;
 *  - how the envelope moves: syllables come two to eight times a second, a rhythm remarkably constant across
 *    languages and speakers, where carriers, tones and most digital modes hold a steady level;
 *  - how much the level varies: speech has pauses and stresses, a continuous transmission does not.
 *
 * None is conclusive alone, so the score is a weighted blend, and it needs a reasonable level before it claims anything.
 */
class VoiceDetector {
    private val buf = FloatArray(NF)
    private var n = 0
    private val re = FloatArray(NF); private val im = FloatArray(NF)
    private val win = FloatArray(NF) { (0.5 - 0.5 * cos(2 * Math.PI * it / NF)).toFloat() }
    private val env = FloatArray(ENV); private val envDb = FloatArray(ENV)
    private var envN = 0; private var filled = 0
    private var bandAvg = 0.0
    private val ere = FloatArray(ENV); private val eim = FloatArray(ENV)
    private val envRate = 48_000.0 / NF
    private val loBin = max(1, (2 * ENV / envRate).roundToInt())
    private val hiBin = min(ENV / 2 - 1, (8 * ENV / envRate).roundToInt())

    @Synchronized fun reset() { n = 0; envN = 0; filled = 0; bandAvg = 0.0; env.fill(0f); envDb.fill(0f) }

    /** Demodulated audio at 48 kHz, full scale ±1. */
    @Synchronized fun push(v: Float) {
        buf[n++] = v
        if (n >= NF) { frame(); n = 0 }
    }

    private fun frame() {
        var sq = 0.0
        for (i in 0 until NF) { val v = buf[i]; sq += v * v; re[i] = v * win[i]; im[i] = 0f }
        Dsp.fft(re, im)
        // The speech band is measured against 100–8000 Hz, so hum and hiss outside the passband count against it.
        fun bin(hz: Int) = (hz.toDouble() * NF / 48_000).roundToInt()
        var inBand = 0.0; var wide = 0.0
        for (k in bin(100)..bin(8000)) {
            val p = (re[k] * re[k] + im[k] * im[k]).toDouble()
            wide += p
            if (k >= bin(300) && k <= bin(3400)) inBand += p
        }
        val rms = sqrt(sq / NF)
        env[envN] = rms.toFloat()
        envDb[envN] = (20 * log10(rms + 1e-9)).toFloat()
        envN = (envN + 1) % ENV
        if (filled < ENV) filled++
        val ratio = if (wide > 0) inBand / wide else 0.0
        bandAvg += 0.1 * (ratio - bandAvg)
    }

    /** The current verdict; meaningless until about a second of audio has gone through. */
    @Synchronized fun read(): VoiceScore {
        if (filled < ENV) return VoiceScore(0.0, bandAvg, 0.0, 0.0, -99.0)
        var mean = 0.0
        for (i in 0 until ENV) mean += env[i]
        mean /= ENV
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
        val levelDb = 20 * log10(mean + 1e-9)
        // Too quiet to judge: squelch open on noise would otherwise score well on variability alone.
        if (levelDb < -46) return VoiceScore(0.0, bandAvg, mod, vary, levelDb)
        val band = clamp01((bandAvg - 0.35) / 0.30)
        val rhythm = clamp01((mod - 0.06) / 0.14)
        val moving = clamp01((vary - 2) / 6)
        return VoiceScore(0.35 * band + 0.40 * rhythm + 0.25 * moving, bandAvg, mod, vary, levelDb)
    }

    private companion object {
        const val NF = 512        // 10.7 ms at 48 kHz, 93.75 Hz per bin
        const val ENV = 128       // 1.37 s of envelope
        fun clamp01(v: Double) = if (v < 0) 0.0 else if (v > 1) 1.0 else v
    }
}
