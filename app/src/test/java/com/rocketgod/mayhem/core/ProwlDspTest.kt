package com.rocketgod.mayhem.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

class ProwlDspTest {
    private val n = 2048
    private val rate = 2_000_000.0

    /** A noise floor near −60 dB with one Gaussian-shouldered hump per (bin offset, height) pair. */
    private fun spectrum(rng: Random, humps: List<Pair<Int, Double>>): FloatArray {
        val p = FloatArray(n) { (-60 + rng.nextGaussian()).toFloat() }
        for ((at, h) in humps) for (k in -16..16) {
            val i = n / 2 + at + k
            val v = -60 + h - 0.15 * k * k
            if (v > p[i]) p[i] = v.toFloat()
        }
        return p
    }

    private fun run(center: Double, humps: List<Pair<Int, Double>>): List<Signal> {
        val c = Classifier(); val rng = Random(1)
        var out = emptyList<Signal>()
        repeat(20) {
            val p = spectrum(rng, humps)
            out = c.update(p, rate, center, p.sorted()[n / 2].toDouble())
        }
        return out
    }

    @Test fun findsAndLabelsAVoiceChannel() {
        val sigs = run(146e6, listOf(300 to 30.0))
        val s = sigs.firstOrNull { abs(it.hz - (146e6 + 300 * rate / n)) < 2000 }
        assertNotNull("hump not found in $sigs", s)
        assertTrue("bw6 ${s!!.bw6}", s.bw6 in 6_000.0..16_000.0)
        assertTrue("class ${s.cls}", s.cls == "NFM" || s.cls == "DMR")
        assertEquals(30.0, s.snr, 2.0)
    }

    @Test fun broadcastBandIsWideFm() {
        val s = run(98e6, listOf(-200 to 30.0)).firstOrNull()
        assertNotNull(s)
        assertEquals("WFM", s!!.cls)
    }

    @Test fun ignoresTheSpikeAtTheLo() {
        assertTrue(run(146e6, listOf(0 to 30.0)).none { abs(it.hz - 146e6) < 2500 })
    }

    private fun score(gen: (Int) -> Double): VoiceScore {
        val v = VoiceDetector()
        for (i in 0 until 48_000 * 3) v.push(gen(i).toFloat())
        return v.read()
    }

    @Test fun steadyToneIsNotSpeech() {
        val s = score { i -> 0.3 * sin(2 * PI * 1000 * i / 48_000) }
        assertTrue("tone scored ${s.score}", s.score < Prowl.VOICE)
    }

    @Test fun syllabicSpeechBandAudioIsSpeech() {
        // Harmonics of a 140 Hz voice, gated into syllables four times a second with pauses between words.
        val s = score { i ->
            val t = i / 48_000.0
            val syl = sin(PI * ((t * 4) % 1.0)).let { it * it } * (if ((t * 0.7) % 1.0 < 0.8) 1.0 else 0.05)
            var x = 0.0
            for (h in 3..20) x += sin(2 * PI * 140 * h * t + h) / h
            0.5 * syl * x
        }
        assertTrue("speech scored ${s.score} (band ${s.band}, mod ${s.mod}, vary ${s.vary}, level ${s.levelDb})", s.score > Prowl.VOICE)
    }
}
