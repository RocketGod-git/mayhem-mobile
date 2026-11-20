package com.rocketgod.mayhem.core.fleet

import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.tanh

/**
 * Where a vocoder plugs into Dispatch. A call's voice frames are handed to the codec for its air interface; with no
 * codec registered the call is still followed and shown, without audio.
 *  - "imbe": P25 Phase 1 full rate, 144-bit frames (88 voice bits under FEC), 20 ms each.
 *  - "ambe2": half rate, 72-bit frames (49 voice bits under FEC), 20 ms each: DMR and P25 Phase 2.
 *  - "tetra": the TETRA ACELP codec, 137-bit frames (after the speech channel decoding), 30 ms each.
 */
object CodecIds { const val IMBE = "imbe"; const val AMBE2 = "ambe2"; const val TETRA = "tetra" }

interface VoiceCodec {
    val id: String
    /** One frame of bits (one per element, as sent) to 8 kHz audio (160 samples, 240 for TETRA), or null for a frame it drops. An
     *  empty frame is an erasure. */
    fun decode(bits: IntArray): FloatArray?
    /** The last frame decoded was past its error correction (repeated or muted by the vocoder). */
    val bad: Boolean get() = false
    /** The last frame was the codec's own silence (a radio keyed with nobody talking): it neither takes nor keeps the audio. */
    val silent: Boolean get() = false
    fun reset()
}

private val codecRegistry = java.util.concurrent.ConcurrentHashMap<String, () -> VoiceCodec>()
fun registerCodec(id: String, make: () -> VoiceCodec) { codecRegistry[id] = make }
fun unregisterCodec(id: String) { codecRegistry.remove(id) }
fun makeCodec(id: String): VoiceCodec? = codecRegistry[id]?.invoke()
fun hasCodec(id: String): Boolean = codecRegistry.containsKey(id)

/** 8 kHz vocoder audio to the 48 kHz output, linear between samples, times [gain]. */
fun to48k(pcm: FloatArray, gain: Double, prev: Float = 0f): FloatArray {
    val out = FloatArray(pcm.size * 6)
    var a = prev
    for (i in pcm.indices) { val b = pcm[i]; for (k in 0 until 6) out[i * 6 + k] = (gain * (a + (b - a) * (k + 1) / 6.0)).toFloat(); a = b }
    return out
}

/**
 * 8 kHz vocoder audio to 48 kHz through a proper interpolation filter: six phases of a 120-tap windowed sinc
 * (Blackman, cut at 3.7 kHz), so the images of the speech band at 8, 16 and 24 kHz are filtered out instead of left
 * in, as straight-line interpolation leaves them (heard as a harsh, buzzy edge on every voice). 1.25 ms of delay.
 */
private const val UP = 6
private const val UP_TAPS = 120
private const val UP_PH = UP_TAPS / UP
private val UP_H: FloatArray = run {
    val h = DoubleArray(UP_TAPS); val m = (UP_TAPS - 1) / 2.0; val fc = 3700.0 / 48_000; var sum = 0.0
    for (i in 0 until UP_TAPS) {
        val x = i - m; val sinc = if (x == 0.0) 2 * fc else sin(2 * PI * fc * x) / (PI * x); val t = i.toDouble() / (UP_TAPS - 1)
        h[i] = sinc * (0.42 - 0.5 * cos(2 * PI * t) + 0.08 * cos(4 * PI * t)); sum += h[i]
    }
    FloatArray(UP_TAPS) { (h[it] * UP / sum).toFloat() }
}
/** Make-up for the vocoders' headroom (Vocoders.kt): the level the listener asked for, with room above it. */
const val MAKEUP = 2.0
/** Linear to 0.8, then a smooth knee that never passes 1: peaks round off instead of clipping. */
fun soft(x: Double): Double { val a = if (x < 0) -x else x; if (a <= 0.8) return x; val y = 0.8 + 0.2 * tanh((a - 0.8) / 0.2); return if (x < 0) -y else y }

class Upsampler {
    private val hist = FloatArray(UP_PH); private var pos = 0
    fun reset() { hist.fill(0f); pos = 0 }
    fun process(pcm: FloatArray, gain: Double, n: Int = pcm.size): FloatArray {
        val out = FloatArray(n * UP)
        for (i in 0 until n) {
            hist[pos] = pcm[i]
            for (p in 0 until UP) {
                var s = 0.0; var k = pos
                for (j in 0 until UP_PH) { s += UP_H[j * UP + p] * hist[k]; if (--k < 0) k = UP_PH - 1 }
                out[i * UP + p] = soft(gain * s).toFloat()
            }
            if (++pos >= UP_PH) pos = 0
        }
        return out
    }
}

/**
 * The live output of Dispatch: 8 kHz vocoder audio to 48 kHz (through [Upsampler]), faded in over [fadeIn] samples
 * when a different call starts, and faded out over [fadeOut] when the call heard changes or ends (the filter is run
 * out under the fade), so the switch between calls never clicks.
 */
class AudioFader(val fadeIn: Int = 480, val fadeOut: Int = 240) {
    private var key = ""; private var ramp = 0; private var gain = 1.0; private var live = false
    private val up = Upsampler()
    val current: String get() = key
    fun push(pcm: FloatArray, key: String, gain: Double): List<FloatArray> {
        val out = ArrayList<FloatArray>(2)
        if (key != this.key) { tail()?.let { out.add(it) }; this.key = key; ramp = 0 }
        this.gain = gain; live = true
        val y = up.process(pcm, gain * MAKEUP)
        var i = 0
        while (i < y.size && ramp < fadeIn) { y[i] *= ramp.toFloat() / fadeIn; i++; ramp++ }
        out.add(y)
        return out
    }
    /** The fade out: the filter run out over [fadeOut] samples under a ramp to zero, or null when nothing is playing. */
    fun tail(): FloatArray? {
        val was = live
        key = ""; ramp = 0; live = false
        if (!was) { up.reset(); return null }
        val t = up.process(FloatArray(ceil(fadeOut.toDouble() / UP).toInt()), gain * MAKEUP).copyOf(fadeOut)
        for (i in t.indices) t[i] *= 1 - (i + 1).toFloat() / t.size
        up.reset()
        return t
    }
}
