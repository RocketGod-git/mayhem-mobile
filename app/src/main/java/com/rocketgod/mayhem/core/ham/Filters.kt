package com.rocketgod.mayhem.core.ham

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/*
 * DSP building blocks for the HAM receiver: windowed-sinc FIR design, real / complex FIR filters with integer
 * decimation, an NCO mixer, Goertzel tone detectors, an audio AGC, spectral-subtraction noise reduction and an
 * LMS adaptive notch. Twin of web/src/dsp/ham/filters.ts — same algorithms and constants. Allocation-free in the
 * hot path.
 */

/** Windowed-sinc low-pass prototype, cutoff as a fraction of the sample rate (0..0.5), Blackman-Harris window. */
fun lowpassTaps(cutoffFrac: Double, taps: Int): FloatArray {
    val h = FloatArray(taps)
    val m = (taps - 1) / 2.0
    var sum = 0.0
    for (i in 0 until taps) {
        val x = i - m
        val sinc = if (x == 0.0) 2 * cutoffFrac else sin(2 * PI * cutoffFrac * x) / (PI * x)
        val t = i / (taps - 1.0)
        val w = 0.35875 - 0.48829 * cos(2 * PI * t) + 0.14128 * cos(4 * PI * t) - 0.01168 * cos(6 * PI * t)
        h[i] = (sinc * w).toFloat(); sum += h[i]
    }
    for (i in 0 until taps) h[i] = (h[i] / sum).toFloat()
    return h
}

/**
 * Complex band-pass taps from a low-pass prototype: pass band [loHz, hiHz] (either sign) at [rate]. Returns
 * interleaved re/im taps. The phasing-method SSB filter: pass +f for USB, −f for LSB.
 */
fun complexBandpassTaps(loHz: Double, hiHz: Double, rate: Double, taps: Int): FloatArray {
    val center = (loHz + hiHz) / 2
    val half = abs(hiHz - loHz) / 2
    val lp = lowpassTaps(half / rate, taps)
    val out = FloatArray(taps * 2)
    val m = (taps - 1) / 2.0
    val w = 2 * PI * center / rate
    for (i in 0 until taps) {
        out[2 * i] = (lp[i] * cos(w * (i - m))).toFloat()
        out[2 * i + 1] = (lp[i] * sin(w * (i - m))).toFloat()
    }
    return out
}

/** Complex FIR (real taps) with integer decimation. */
class ComplexFirDecimator(private val h: FloatArray, private val decim: Int) {
    private val hist = FloatArray(h.size * 2)   // circular, interleaved I/Q
    private var pos = 0
    private var phase = 0

    fun reset() { hist.fill(0f); pos = 0; phase = 0 }

    /** [inp]: interleaved I/Q, [n] complex samples. Returns the complex outputs written to [out]. */
    fun process(inp: FloatArray, n: Int, out: FloatArray): Int {
        val taps = h.size
        var o = 0; var p = pos; var ph = phase
        for (i in 0 until n) {
            hist[2 * p] = inp[2 * i]; hist[2 * p + 1] = inp[2 * i + 1]
            if (++ph >= decim) {
                ph = 0
                var sI = 0f; var sQ = 0f; var k = p
                for (t in 0 until taps) {
                    val c = h[t]
                    sI += c * hist[2 * k]; sQ += c * hist[2 * k + 1]
                    if (--k < 0) k = taps - 1
                }
                out[2 * o] = sI; out[2 * o + 1] = sQ; o++
            }
            if (++p >= taps) p = 0
        }
        pos = p; phase = ph
        return o
    }
}

/**
 * Third-order CIC decimator on integer-quantised complex samples. The integrators wrap in Int arithmetic, so they
 * never lose precision however long they run; six adds per input sample. At D = 10 the worst alias into a
 * ±110 kHz passband is about −75 dB and the droop under 0.1 dB, which is what lets a 19.2 Msps stream feed the
 * 1.92 M FIR chain without a 63-tap FIR at the full rate.
 */
class Cic3Decimator(private val d: Int, private val scale: Int = 256) {
    private var i1r = 0; private var i1i = 0; private var i2r = 0; private var i2i = 0; private var i3r = 0; private var i3i = 0
    private var c1r = 0; private var c1i = 0; private var c2r = 0; private var c2i = 0; private var c3r = 0; private var c3i = 0
    private var ph = 0
    private val gain = 1.0f / (scale.toFloat() * d * d * d)

    fun reset() {
        i1r = 0; i1i = 0; i2r = 0; i2i = 0; i3r = 0; i3i = 0
        c1r = 0; c1i = 0; c2r = 0; c2i = 0; c3r = 0; c3i = 0; ph = 0
    }

    fun process(inp: FloatArray, n: Int, out: FloatArray): Int {
        var o = 0
        for (i in 0 until n) {
            i1r += (inp[2 * i] * scale).roundToInt(); i1i += (inp[2 * i + 1] * scale).roundToInt()
            i2r += i1r; i2i += i1i
            i3r += i2r; i3i += i2i
            if (++ph >= d) {
                ph = 0
                val y1r = i3r - c1r; val y1i = i3i - c1i; c1r = i3r; c1i = i3i
                val y2r = y1r - c2r; val y2i = y1i - c2i; c2r = y1r; c2i = y1i
                val y3r = y2r - c3r; val y3i = y2i - c3i; c3r = y2r; c3i = y2i
                out[2 * o] = y3r * gain; out[2 * o + 1] = y3i * gain; o++
            }
        }
        return o
    }
}

/** Complex FIR with complex taps (interleaved), no decimation; outputs the real part only (SSB audio). */
class ComplexBandpassToReal(private var h: FloatArray) {
    private val hist = FloatArray(h.size)
    private var pos = 0

    fun setTaps(taps: FloatArray) {
        if (taps.size != h.size) { hist.fill(0f); pos = 0 }
        h = taps
    }

    fun reset() { hist.fill(0f); pos = 0 }

    fun process(inp: FloatArray, n: Int, out: FloatArray) {
        val taps = h.size shr 1
        var p = pos
        for (i in 0 until n) {
            hist[2 * p] = inp[2 * i]; hist[2 * p + 1] = inp[2 * i + 1]
            var re = 0f; var k = p
            for (t in 0 until taps) {
                re += h[2 * t] * hist[2 * k] - h[2 * t + 1] * hist[2 * k + 1]
                if (--k < 0) k = taps - 1
            }
            out[i] = re
            if (++p >= taps) p = 0
        }
        pos = p
    }
}

/** Real FIR, no decimation. */
class RealFir(private val h: FloatArray) {
    private val hist = FloatArray(h.size)
    private var pos = 0

    fun reset() { hist.fill(0f); pos = 0 }

    fun process(inp: FloatArray, n: Int, out: FloatArray) {
        val taps = h.size
        var p = pos
        for (i in 0 until n) {
            hist[p] = inp[i]
            var s = 0f; var k = p
            for (t in 0 until taps) { s += h[t] * hist[k]; if (--k < 0) k = taps - 1 }
            out[i] = s
            if (++p >= taps) p = 0
        }
        pos = p
    }
}

/**
 * Numerically controlled oscillator: multiplies I/Q by e^{-j·2π·f·t}. The phasor is rotated recursively (one
 * complex multiply per sample) and re-normalized every 1024 samples — no trig per sample.
 */
class Mixer(private var rate: Double, hz: Double = 0.0) {
    var freq = 0.0; private set
    private var cr = 1.0; private var ci = 0.0   // current phasor e^{-jθ}
    private var dr = 1.0; private var di = 0.0   // per-sample rotation

    init { setFreq(hz) }

    fun setRate(r: Double) { rate = r; setFreq(freq) }

    fun setFreq(hz: Double) {
        freq = hz
        val w = -2 * PI * hz / rate
        dr = cos(w); di = sin(w)
    }

    /** Offset-128 bytes from the driver; a signal at +f lands on DC. */
    fun process(inp: ByteArray, n: Int, out: FloatArray) {
        var r = cr; var c = ci
        for (i in 0 until n) {
            val a = ((inp[2 * i].toInt() and 0xff) - 128).toDouble()
            val b = ((inp[2 * i + 1].toInt() and 0xff) - 128).toDouble()
            out[2 * i] = (a * r - b * c).toFloat(); out[2 * i + 1] = (a * c + b * r).toFloat()
            val nr = r * dr - c * di; c = r * di + c * dr; r = nr
            if ((i and 1023) == 1023) { val g = 1 / sqrt(r * r + c * c); r *= g; c *= g }
        }
        cr = r; ci = c
    }

    /** Float I/Q in, float I/Q out. */
    fun process(inp: FloatArray, n: Int, out: FloatArray) {
        var r = cr; var c = ci
        for (i in 0 until n) {
            val a = inp[2 * i].toDouble(); val b = inp[2 * i + 1].toDouble()
            out[2 * i] = (a * r - b * c).toFloat(); out[2 * i + 1] = (a * c + b * r).toFloat()
            val nr = r * dr - c * di; c = r * di + c * dr; r = nr
            if ((i and 1023) == 1023) { val g = 1 / sqrt(r * r + c * c); r *= g; c *= g }
        }
        cr = r; ci = c
    }
}

/** One-pole DC blocker. */
class DcBlock(private val r: Float = 0.995f) {
    private var x1 = 0f; private var y1 = 0f
    fun process(buf: FloatArray, n: Int) {
        for (i in 0 until n) { val x = buf[i]; val y = x - x1 + r * y1; x1 = x; y1 = y; buf[i] = y }
    }
}

/** Goertzel power at one frequency over a block. */
class Goertzel(hz: Double, rate: Double, private val block: Int) {
    private val coeff = 2 * cos(2 * PI * hz / rate)
    private var s1 = 0.0; private var s2 = 0.0; private var n = 0

    /** Push one sample; returns the block power when a block completes, else −1. */
    fun push(x: Float): Double {
        val s0 = x + coeff * s1 - s2; s2 = s1; s1 = s0
        if (++n >= block) {
            val p = s1 * s1 + s2 * s2 - coeff * s1 * s2
            s1 = 0.0; s2 = 0.0; n = 0
            return p / block
        }
        return -1.0
    }
}

/**
 * Audio AGC: peak-following gain with fast attack and a selectable decay, plus a hang time so syllables do not
 * pump. Output level aims at [target] (linear, of ±1 full scale).
 */
class Agc(
    private val rate: Double,
    var target: Float = 0.35f,
    attackMs: Double = 3.0,
    decayMs: Double = 500.0,
    hangMs: Double = 250.0,
    var maxGain: Float = 2000f,
) {
    var gain = 1f
    private var env = 0f
    private var hang = 0
    private val attack = (1 - exp(-1 / (rate * attackMs / 1000))).toFloat()
    private var decay = (1 - exp(-1 / (rate * decayMs / 1000))).toFloat()
    private var hangSamples = (rate * hangMs / 1000).roundToInt()

    fun setSpeed(decayMs: Double, hangMs: Double) {
        decay = (1 - exp(-1 / (rate * decayMs / 1000))).toFloat()
        hangSamples = (rate * hangMs / 1000).roundToInt()
    }

    fun process(buf: FloatArray, n: Int) {
        for (i in 0 until n) {
            val a = abs(buf[i])
            if (a > env) { env += attack * (a - env); hang = hangSamples }
            else if (hang > 0) hang--
            else env += decay * (a - env)
            val want = if (env > 1e-6f) target / env else maxGain
            gain = min(maxGain, want)
            buf[i] *= gain
        }
    }
}

/**
 * Spectral-subtraction noise reduction on 48 kHz audio: 512-point Hann frames, 50% overlap-add, a per-bin noise
 * estimate by tracked minimum (rises slowly, drops fast), and a gain floor so speech keeps its body.
 */
class NoiseReducer {
    private val nPts = 512
    private val hop = 256
    private val win = FloatArray(512) { (0.5 - 0.5 * cos(2 * PI * it / 512)).toFloat() }
    private val inBuf = FloatArray(512)
    private val outBuf = FloatArray(768)
    private val re = FloatArray(512)
    private val im = FloatArray(512)
    private val noise = FloatArray(257) { 1e-3f }
    private var inFill = 256
    private var outRead = 0
    private var frames = 0
    var strength = 1.0f   // over-subtraction factor
    var floor = 0.12f

    fun reset() { inBuf.fill(0f); outBuf.fill(0f); inFill = 256; outRead = 0; noise.fill(1e-3f); frames = 0 }

    /** In place. Introduces 256 samples (5.3 ms) of latency. */
    fun process(buf: FloatArray, n: Int) {
        for (i in 0 until n) {
            inBuf[inFill++] = buf[i]
            if (inFill == nPts) { frame(); inFill = hop }
            buf[i] = outBuf[outRead]; outBuf[outRead] = 0f
            if (++outRead >= nPts) outRead = 0
        }
    }

    private fun frame() {
        for (i in 0 until nPts) { re[i] = inBuf[i] * win[i]; im[i] = 0f }
        fftInPlace(re, im, false)
        val slowUp = if (frames < 20) 0.5f else 0.003f
        val fastDown = 0.3f
        for (k in 0..nPts / 2) {
            val p = re[k] * re[k] + im[k] * im[k]
            val nz = noise[k]
            noise[k] = if (p < nz) nz + fastDown * (p - nz) else nz + slowUp * (p - nz)
            val g = max(floor, min(1f, (p - strength * noise[k]) / (p + 1e-12f)))
            re[k] *= g; im[k] *= g
            if (k > 0 && k < nPts / 2) { re[nPts - k] = re[k]; im[nPts - k] = -im[k] }
        }
        fftInPlace(re, im, true)
        frames++
        // overlap-add: window again for a smooth (Hann², sums to 1 with the 0.5 hop scaling) reconstruction
        for (i in 0 until nPts) { val o = (outRead + i) % nPts; outBuf[o] += re[i] * win[i] * (2f / 3f) }
        System.arraycopy(inBuf, hop, inBuf, 0, nPts - hop)
    }
}

/** LMS adaptive notch (adaptive line enhancer subtracted): removes steady carriers and tones from audio. */
class AutoNotch(private val taps: Int = 64, private val delay: Int = 48, private val mu: Float = 0.002f) {
    private val w = FloatArray(taps)
    private val x = FloatArray(taps + delay + 1)
    private var pos = 0

    fun reset() { w.fill(0f); x.fill(0f); pos = 0 }

    fun process(buf: FloatArray, n: Int) {
        val l = x.size
        for (i in 0 until n) {
            val s = buf[i]
            x[pos] = s
            var y = 0f; var k = pos - delay; if (k < 0) k += l
            var pw = 0f
            for (t in 0 until taps) { val v = x[k]; y += w[t] * v; pw += v * v; if (--k < 0) k = l - 1 }
            val e = s - y                       // the signal minus its predictable (tonal) part
            val g = mu / (pw + 1e-3f)
            k = pos - delay; if (k < 0) k += l
            for (t in 0 until taps) { w[t] += g * e * x[k]; if (--k < 0) k = l - 1 }
            buf[i] = e
            if (++pos >= l) pos = 0
        }
    }
}

/** In-place radix-2 FFT (forward, or inverse with 1/N scaling). */
fun fftInPlace(re: FloatArray, im: FloatArray, inverse: Boolean) {
    val n = re.size
    var j = 0
    for (i in 1 until n) {
        var bit = n shr 1
        while ((j and bit) != 0) { j = j xor bit; bit = bit shr 1 }
        j = j xor bit
        if (i < j) {
            val tr = re[i]; re[i] = re[j]; re[j] = tr
            val ti = im[i]; im[i] = im[j]; im[j] = ti
        }
    }
    var len = 2
    while (len <= n) {
        val ang = (if (inverse) 2 else -2) * PI / len
        val wr = cos(ang).toFloat(); val wi = sin(ang).toFloat()
        var i = 0
        while (i < n) {
            var cr = 1f; var ci = 0f
            for (k in 0 until len / 2) {
                val a = i + k; val b = a + len / 2
                val tr = cr * re[b] - ci * im[b]; val ti = cr * im[b] + ci * re[b]
                re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
                val ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr
            }
            i += len
        }
        len = len shl 1
    }
    if (inverse) for (i in 0 until n) { re[i] /= n; im[i] /= n }
}

/** Linear-interpolating resampler for audio (ratio close to 1). */
class Resampler(private val ratio: Double) {   // out rate / in rate
    private var frac = 0.0
    private var last = 0f

    fun process(inp: FloatArray, n: Int, out: FloatArray): Int {
        var o = 0; var f = frac; var prev = last
        val step = 1 / ratio
        for (i in 0 until n) {
            val cur = inp[i]
            while (f < 1) { out[o++] = (prev + (cur - prev) * f).toFloat(); f += step }
            f -= 1; prev = cur
        }
        frac = f; last = prev
        return o
    }
}
