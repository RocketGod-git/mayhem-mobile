package com.rocketgod.mayhem.core.spectrum

import com.rocketgod.mayhem.core.apps.Retuner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Spectrum: RBW / VBW, the FFT's level scale, trace math, marker peak search, channel power, occupied bandwidth,
 * ACPR, noise floor, the sweep's stitching and zero span (filter, trigger, pulse measurements), all on synthetic
 * signals made here with a fixed PRNG (mulberry32) so every run, and every port, sees the same samples. Twin of
 * web/test/spectrum.mjs, check for check (130 of them), with the same signals and tolerances.
 */
class SpectrumTest {
    private var checks = 0
    private var failed = 0
    private val failures = ArrayList<String>()
    private fun ok(cond: Boolean, what: String) { checks++; if (!cond) { failed++; failures.add(what); println("  FAIL $what") } }
    private fun near(a: Double, b: Double, tol: Double, what: String) = ok(abs(a - b) <= tol, "$what: $a vs $b (±$tol)")
    private fun f1(x: Double) = String.format(Locale.US, "%.1f", x)
    private fun f2(x: Double) = String.format(Locale.US, "%.2f", x)

    /** mulberry32, bit for bit as the web test's. */
    private class Mulberry(private var a: Int) {
        fun next(): Double {
            a += 0x6D2B79F5
            var t = (a xor (a ushr 15)) * (1 or a)
            t = (t + (t xor (t ushr 7)) * (61 or t)) xor t
            return ((t xor (t ushr 14)).toLong() and 0xFFFFFFFFL) / 4294967296.0
        }
    }
    private fun gauss(rnd: Mulberry): Double { val u = max(1e-12, rnd.next()); val v = rnd.next(); return sqrt(-2 * ln(u)) * cos(2 * PI * v) }

    private class Tone(val f: Double, val a: Double, val ph: Double = 0.0)
    private class Sig(val i: FloatArray, val q: FloatArray)

    /** n samples (float, int8 counts): tones (f cycles/sample, a counts, ph) plus complex noise of `sigma` per rail. */
    private fun signal(n: Int, tones: List<Tone>, sigma: Double, rnd: Mulberry?, start: Int = 0): Sig {
        val i = FloatArray(n); val q = FloatArray(n)
        for (k in 0 until n) {
            var x = 0.0; var y = 0.0
            for (t in tones) { val p = 2 * PI * t.f * (k + start) + t.ph; x += t.a * cos(p); y += t.a * sin(p) }
            if (sigma != 0.0) { x += sigma * gauss(rnd!!); y += sigma * gauss(rnd) }
            i[k] = x.toFloat(); q[k] = y.toFloat()
        }
        return Sig(i, q)
    }
    /** The same as the radio's bytes: signed int8, rounded and clipped, then offset by 128 (as the Android engine delivers). */
    private fun int8(sig: Sig): ByteArray {
        val out = ByteArray(sig.i.size * 2)
        fun b(v: Float): Byte = (max(-128.0, min(127.0, jsRound(v.toDouble()))).toInt() + 128).toByte()
        for (k in sig.i.indices) { out[2 * k] = b(sig.i[k]); out[2 * k + 1] = b(sig.q[k]) }
        return out
    }
    /** JavaScript's Math.round (halves go up). */
    private fun jsRound(x: Double): Double = kotlin.math.floor(x + 0.5)
    private fun dbfs(a: Double) = 20 * log10(a / 128)
    private fun p(d: Double) = 10.0.pow(d / 10)
    private fun fa(vararg v: Double) = FloatArray(v.size) { v[it].toFloat() }
    private fun join(a: FloatArray?) = a!!.joinToString(",") { jsNum(it.toDouble()) }
    private fun jsNum(v: Double) = if (v == kotlin.math.floor(v)) v.toLong().toString() else v.toString()

    @Test
    fun spectrum() {
        rbw()
        levels()
        resolution()
        noise()
        vbw()
        traces()
        markers()
        power()
        scale()
        cal()
        sweep()
        fftMode()
        zeroSpan()
        persistence()
        println("spectrum: ${checks - failed}/$checks checks passed")
        assertTrue("failures: $failures", failed == 0)
        assertEquals("checks run", 130, checks)
    }

    // ---- RBW ----------------------------------------------------------------------------------------------------
    private fun rbw() {
        near(enbwBins(WindowKind.HANN), 1.5, 1e-3, "Hann ENBW is 1.5 bins")
        near(enbwBins(WindowKind.FLATTOP), 3.77, 0.01, "flat-top ENBW is 3.77 bins")
        ok(fftSizeFor(2e6, 3000.0, WindowKind.HANN) == 1024, "RBW 3 kHz at 2 Msps picks 1024 points")
        near(rbwOf(2e6, 1024, WindowKind.HANN), 2929.7, 0.1, "and reports the RBW it really has")
        ok(fftSizeFor(2e6, 1.0, WindowKind.HANN) == MAX_FFT, "an RBW finer than the longest FFT is clamped to it")
        ok(fftSizeFor(2e6, 1e6, WindowKind.HANN) == MIN_FFT, "an RBW wider than the shortest FFT is clamped to it")
        ok(autoRbw(2e6) == 3000.0, "auto RBW for a 2 MHz span is 3 kHz")
        ok(autoRbw(100e6) == 100000.0, "auto RBW for a 100 MHz span is 100 kHz")
        ok(stepBw(3000.0, 1) == 10000.0 && stepBw(3000.0, -1) == 1000.0 && stepBw(2900.0, 1) == 10000.0, "RBW steps go 1-3-10")
    }

    // A tone's level reads true at a bin center (both windows) and, with the flat top, between bins too.
    private fun levels() {
        val n = 1024; val a = 100.0
        for (kind in listOf(WindowKind.HANN, WindowKind.FLATTOP)) {
            val e = FftEngine(n, kind, 2e6, 1e9, false)
            val s = signal(n, listOf(Tone(100.0 / n, a)), 0.0, null)
            e.pushFloat(s.i, s.q)
            val t = e.take()
            near(t.live[n / 2 + 100].toDouble(), dbfs(a), 0.01, "$kind: a tone on a bin center reads its level")
        }
        val e = FftEngine(n, WindowKind.FLATTOP, 2e6, 1e9, false)
        val s = signal(n, listOf(Tone(100.5 / n, a)), 0.0, null)
        e.pushFloat(s.i, s.q)
        val t = e.take()
        near(max(t.live[n / 2 + 100], t.live[n / 2 + 101]).toDouble(), dbfs(a), 0.05, "FLATTOP: a tone between bins still reads its level")
        val h = FftEngine(n, WindowKind.HANN, 2e6, 1e9, false)
        h.pushFloat(s.i, s.q)
        val th = h.take()
        near(max(th.live[n / 2 + 100], th.live[n / 2 + 101]) - dbfs(a), -1.42, 0.05, "HANN: between bins it scallops by 1.42 dB")
    }

    // Two tones 3 RBW apart are resolved (a deep dip between them); half an RBW apart they are one lump.
    private fun resolution() {
        val n = 4096; val rate = 2e6; val kind = WindowKind.HANN
        val rbw = rbwOf(rate, n, kind); val binHz = rate / n
        fun dip(sepHz: Double): Double {
            val e = FftEngine(n, kind, rate, 1e9, false)
            val f1 = 200 * binHz; val f2 = f1 + sepHz
            val s = signal(n, listOf(Tone(f1 / rate, 60.0), Tone(f2 / rate, 60.0)), 0.0, null)
            e.pushFloat(s.i, s.q)
            val y = e.take().live
            val b1 = n / 2 + jsRound(f1 / binHz).toInt(); val b2 = n / 2 + jsRound(f2 / binHz).toInt()
            var lo = Double.POSITIVE_INFINITY; for (k in b1..b2) lo = min(lo, y[k].toDouble())
            return min(y[b1], y[b2]) - lo
        }
        ok(dip(3 * rbw) > 6, "tones 3 RBW apart are resolved (dip ${f1(dip(3 * rbw))} dB)")
        ok(dip(0.5 * rbw) < 1, "tones half an RBW apart are not (dip ${f2(dip(0.5 * rbw))} dB)")
    }

    // Noise reads its density: each bin holds total power × RBW / rate.
    private fun noise() {
        val n = 2048; val rate = 2e6; val sigma = 8.0; val rnd = Mulberry(1)
        val e = FftEngine(n, WindowKind.HANN, rate, 1e9, false)
        val tr = Trace(TraceMode.AVG, 64)
        for (f in 0 until 64) { val s = signal(n, emptyList(), sigma, rnd); e.pushFloat(s.i, s.q); val t = e.take(); tr.update(t.live, t.max, t.min, 0.0, rate / n) }
        val total = 2 * sigma * sigma / (128 * 128)
        val nf = noiseFloor(tr.data!!, e.rbwHz)
        near(nf.floor, 10 * log10(total * e.rbwHz / rate), 0.4, "noise floor per RBW")
        near(nf.density, 10 * log10(total / rate), 0.4, "noise density per hertz")
        near(noiseAt(tr.data!!, n / 2, e.rbwHz, 64), 10 * log10(total / rate), 0.6, "noise density at a marker")
        near(channelPower(tr.data!!, -rate / 2, rate / n, e.rbwHz, 0.0, rate / 2), 10 * log10(total / 2), 0.4, "channel power of noise over half the band")
    }

    // ---- VBW ----------------------------------------------------------------------------------------------------
    private fun vbw() {
        ok(videoAlpha(3000.0, 1024 / 2e6) > 0.99, "a VBW equal to the RBW passes every frame")
        near(videoAlpha(0.0, 1.0), 0.0, 1e-12, "a VBW of zero holds")
        fun spread(vbw: Double): Double {
            val n = 512; val rate = 2e6; val rnd = Mulberry(7)
            val e = FftEngine(n, WindowKind.HANN, rate, vbw, false)
            val vals = ArrayList<Double>()
            for (f in 0 until 400) { val s = signal(n, emptyList(), 8.0, rnd); e.pushFloat(s.i, s.q); if (f >= 200) vals.add(e.take().live[100].toDouble()) }
            val m = vals.sum() / vals.size
            return sqrt(vals.sumOf { (it - m) * (it - m) } / vals.size)
        }
        val wide = spread(1e6); val narrow = spread(30.0)
        ok(wide > 4, "with VBW ≥ RBW a noise bin swings by ${f1(wide)} dB")
        ok(narrow < wide / 4, "a VBW 200x narrower settles it (${f2(narrow)} dB)")

        // The video filter tracks max and min between takes.
        run {
            val e = FftEngine(256, WindowKind.HANN, 2e6, 1e9, false)
            val loud = signal(256, listOf(Tone(20.0 / 256, 100.0)), 0.0, null); val quiet = signal(256, listOf(Tone(20.0 / 256, 10.0)), 0.0, null)
            e.pushFloat(loud.i, loud.q); e.pushFloat(quiet.i, quiet.q)
            val t = e.take()
            near(t.max[128 + 20].toDouble(), dbfs(100.0), 0.05, "the frame max between takes keeps the loud frame")
            near(t.min[128 + 20].toDouble(), dbfs(10.0), 0.05, "the frame min keeps the quiet one")
            near(t.live[128 + 20].toDouble(), 10 * log10(((100.0 / 128).pow(2) + (10.0 / 128).pow(2)) / 2), 0.05, "live is the power mean of the frames since the last take")
            ok(t.frames == 2, "take counts the frames it folded")
            // dozens of noise frames between two takes read steady: the shown frame is their mean, not the last one
            run {
                val en = FftEngine(512, WindowKind.HANN, 2e6, 1e9, false); val rn = Mulberry(13)
                for (f in 0 until 64) { val sg = signal(512, emptyList(), 8.0, rn); en.pushFloat(sg.i, sg.q) }
                val y = en.take().live; val m = y.average()
                val sd = kotlin.math.sqrt(y.sumOf { (it - m) * (it - m) } / y.size)
                ok(sd < 1, "64 noise frames averaged per screen frame hold within ${"%.2f".format(sd)} dB")
            }
        }
        // The DC patch lays the DC spike on a line.
        run {
            val pp = fa(1.0, 1.0, 1.0, 9.0, 9.0, 9.0, 9.0, 9.0, 3.0, 3.0, 3.0)
            patchDc(pp, 5, 2)
            ok(abs(pp[5] - 2) < 1e-6 && pp[8] == 3f && pp[2] == 1f, "patchDc interpolates across the center bins")
        }
        // Int8 reads go through the same path as float frames, and the budget skips frames above it.
        run {
            val rate = 20e6; val n = 1024
            val e = FftEngine(n, WindowKind.HANN, rate, 1e9, false)
            ok(e.skip == kotlin.math.ceil(rate / FFT_BUDGET).toInt() - 1, "frames are skipped above the FFT budget")
            val iq = int8(signal(32768, listOf(Tone(64.0 / n, 90.0)), 0.0, null))
            val done = e.push(iq)
            val per = (n * (1 + e.skip)).toDouble()
            ok(done == kotlin.math.floor(32768 / per).toInt() || done == kotlin.math.ceil(32768 / per).toInt(), "an int8 read gives its frames ($done)")
            near(e.take().live[n / 2 + 64].toDouble(), dbfs(90.0), 0.1, "and reads the tone level")
        }
    }

    // ---- traces -------------------------------------------------------------------------------------------------
    private fun traces() {
        val live = Trace(TraceMode.LIVE); val mx = Trace(TraceMode.MAX); val mn = Trace(TraceMode.MIN); val av = Trace(TraceMode.AVG, 2); val view = Trace(TraceMode.LIVE)
        val frames = listOf(doubleArrayOf(-50.0, -40.0, -30.0), doubleArrayOf(-45.0, -60.0, -35.0), doubleArrayOf(-55.0, -42.0, -20.0))
        for (fr in frames) for (t in listOf(live, mx, mn, av, view)) t.update(fa(*fr), null, null, 100.0, 10.0)
        ok(join(live.data) == "-55,-42,-20", "LIVE shows the last frame")
        ok(join(mx.data) == "-45,-40,-20", "MAX HOLD keeps each bin's highest")
        ok(join(mn.data) == "-55,-60,-35", "MIN HOLD keeps each bin's lowest")
        // AVG 2: (−50, −45) mean in power, then exponential with weight 1/2
        val expect0 = 10 * log10(((p(-50.0) + p(-45.0)) / 2 + p(-55.0)) / 2)
        near(av.data!![0].toDouble(), expect0, 1e-3, "AVG (N) power-averages, running mean then 1/N")
        view.setMode(TraceMode.VIEW)
        view.update(fa(0.0, 0.0, 0.0), null, null, 100.0, 10.0)
        ok(join(view.data) == "-55,-42,-20", "VIEW freezes the trace")
        mx.update(fa(-50.0, -50.0, -50.0), fa(-10.0, -50.0, -50.0), null, 100.0, 10.0)
        ok(mx.data!![0] == -10f, "MAX HOLD takes the frame max, not just the frame")
        mx.clear(); ok(mx.data == null && mx.count == 0, "a trace clears")
        mn.update(fa(1.0, 2.0), null, null, 100.0, 10.0)
        ok(mn.data!!.size == 2 && mn.count == 1, "a new bin layout starts the trace over")
        val off = Trace(TraceMode.OFF); off.update(fa(1.0), null, null, 0.0, 1.0); ok(off.data == null, "OFF draws nothing")
        ok(defaultTraces().joinToString(",") { it.mode.name } == "LIVE,MAX,OFF,OFF", "four traces: live, max hold, two off")
        val y = fa(-10.0, -80.0, -80.0, -80.0, -20.0, -20.0, -20.0, -20.0)
        ok(join(toColumns(y, 2, Detector.PEAK)) == "-10,-20", "PEAK detector keeps the highest bin per column")
        ok(join(toColumns(y, 2, Detector.SAMPLE)) == "-80,-20", "SAMPLE detector takes the middle bin")
        near(toColumns(y, 2, Detector.RMS)[0].toDouble(), 10 * log10((p(-10.0) + 3 * p(-80.0)) / 4), 1e-3, "RMS detector power-averages")
        ok(join(toColumns(fa(-1.0, -2.0), 4, Detector.PEAK)) == "-1,-1,-2,-2", "fewer bins than columns repeats them")
    }

    // ---- markers ------------------------------------------------------------------------------------------------
    private fun markers() {
        // a trace with peaks at 100 (-20), 300 (-35), 600 (-10), 800 (-50), a 3 dB ripple everywhere, on a -90 floor
        val n = 1000; val rnd = Mulberry(3)
        val y = FloatArray(n)
        val pk = listOf(100 to -20.0, 300 to -35.0, 600 to -10.0, 800 to -50.0)
        for (i in 0 until n) {
            var v = -90 + 3 * rnd.next()
            for ((c, l) in pk) v = max(v, l - 0.05 * (i - c).toDouble().pow(2))
            y[i] = v.toFloat()
        }
        val peaks = findPeaks(y)
        ok(peaks.joinToString(",") == "100,300,600,800", "peaks at the four signals only, not the ripple (${peaks.take(8).joinToString(",")})")
        ok(peakSearch(y) == 600, "PEAK finds the highest")
        ok(nextPeak(y, 600) == 100 && nextPeak(y, 100) == 300 && nextPeak(y, 300) == 800, "NEXT PEAK walks down in level")
        ok(nextPeak(y, 800) == 800, "NEXT PEAK stays on the lowest")
        ok(nextPeakRight(y, 300) == 600 && nextPeakLeft(y, 300) == 100, "NEXT RIGHT / LEFT go to the neighbors")
        ok(nextPeakLeft(y, 100) == 100 && nextPeakRight(y, 800) == 800, "and stay put at the ends")
        ok(findPeaks(y, 6.0, -30.0).joinToString(",") == "100,600", "the peak threshold drops peaks under it")
        ok(findPeaks(y, 50.0).joinToString(",") == "100,300,600", "a 50 dB excursion drops the peak that rises only 40 dB")
        ok(peakSearch(fa(1.0, 2.0, 3.0, 4.0)) == 3, "with no peak, PEAK takes the highest bin")
        ok(findPeaks(fa(0.0, 10.0, 10.0, 10.0, 0.0)).joinToString(",") == "1", "a flat top is one peak")
        // a tone between bins: the parabola finds its frequency to a fraction of a bin
        val nn = 2048; val e = FftEngine(nn, WindowKind.HANN, 2e6, 1e9, false)
        val s = signal(nn, listOf(Tone(300.3 / nn, 50.0)), 0.0, null)
        e.pushFloat(s.i, s.q)
        val t = e.take().live
        val i = peakSearch(t); val r = refinePeak(t, i)
        near(i - nn / 2 + r.offset, 300.3, 0.05, "refinePeak puts the tone within 0.05 bin")
        near(r.level, dbfs(50.0), 0.6, "and its level within the scallop")
        ok(binOf(1005.0, 1000.0, 10.0, 50) == 1 && binOf(-1e9, 0.0, 1.0, 10) == 0 && binOf(1e9, 0.0, 1.0, 10) == 9, "binOf rounds and clamps")
        ok(defaultMarkers().size == 4 && defaultMarkers().all { !it.on }, "four markers, all off")
    }

    // ---- channel power, OBW, ACPR -------------------------------------------------------------------------------
    private fun power() {
        val n = 4096; val rate = 2e6; val binHz = rate / n
        for (kind in listOf(WindowKind.HANN, WindowKind.FLATTOP)) {
            val e = FftEngine(n, kind, rate, 1e9, false)
            val s = signal(n, listOf(Tone(123.37 * binHz / rate, 64.0)), 0.0, null)
            e.pushFloat(s.i, s.q)
            val y = e.take().live; val f0 = -rate / 2
            near(channelPower(y, f0, binHz, e.rbwHz, 123.37 * binHz, 20 * e.rbwHz), dbfs(64.0), 0.05, "$kind: channel power of a tone is the tone")
        }
        // a flat block of power 100 kHz wide: 99 % OBW is 99 kHz, and its channel power is its total
        val y = FloatArray(n); val f0 = -rate / 2
        val lo = 200_000.0; val hi = 300_000.0
        for (i in 0 until n) { val f = f0 + i * binHz; y[i] = if (f >= lo && f < hi) -40f else -160f }
        val o = occupiedBw(y, f0, binHz, 1.5 * binHz)
        near(o.bw, 99_000.0, binHz, "OBW of a flat 100 kHz block is 99 kHz")
        near((o.lo + o.hi) / 2, 250_000 - binHz / 2, binHz, "centered on the block")
        val inBlock = jsRound(100_000 / binHz)
        near(channelPower(y, f0, binHz, 1.5 * binHz, 250_000 - binHz / 2, 100_000.0), -40 + 10 * log10(inBlock / 1.5), 0.1, "channel power of the block")
        near(occupiedBw(y, f0, binHz, 1.5 * binHz, 90.0).bw, 90_000.0, binHz, "OBW at 90 % is 90 kHz")
        // an FFT'd noise channel: OBW ≈ 99 % of the band it fills
        val rnd = Mulberry(11); val e = FftEngine(n, WindowKind.HANN, rate, 1e9, false); val tr = Trace(TraceMode.AVG, 32)
        val band = 0.25   // noise filling ±0.125 of the rate, shaped in the frequency domain (a moving average of white noise is not flat)
        for (k in 0 until 32) {
            // shape noise in the frequency domain: random phase, flat magnitude inside the band
            val re = FloatArray(n); val im = FloatArray(n)
            for (b in 0 until n) { val fb = (if (b < n / 2) b else b - n).toDouble() / n; if (abs(fb) < band / 2) { val ph = 2 * PI * rnd.next(); re[b] = cos(ph).toFloat(); im[b] = sin(ph).toFloat() } }
            val xi = FloatArray(n); val xq = FloatArray(n)
            ifft(re, im); for (b in 0 until n) { xi[b] = re[b] * 2000; xq[b] = im[b] * 2000 }
            e.pushFloat(xi, xq); val t = e.take(); tr.update(t.live, null, null, f0, binHz)
        }
        val ob = occupiedBw(tr.data!!, f0, binHz, e.rbwHz)
        near(ob.bw, 0.99 * band * rate, 3 * e.rbwHz, "OBW of a noise channel filling ${jsNum(band * rate / 1e3)} kHz")
        // ACPR: a main channel tone with neighbors 30 dB down, 100 kHz away
        val ea = FftEngine(n, WindowKind.HANN, rate, 1e9, false)
        val sa = signal(n, listOf(Tone(100 * binHz / rate, 100.0), Tone((100 * binHz - 100_000) / rate, 100 / 31.62), Tone((100 * binHz + 100_000) / rate, 100 / 31.62)), 0.0, null)
        ea.pushFloat(sa.i, sa.q)
        val ya = ea.take().live
        val r = acpr(ya, f0, binHz, ea.rbwHz, 100 * binHz, 25_000.0, 100_000.0)
        near(r.lowerDbc, -30.0, 0.2, "ACPR lower neighbor −30 dBc")
        near(r.upperDbc, -30.0, 0.2, "ACPR upper neighbor −30 dBc")
        near(r.main, dbfs(100.0), 0.1, "ACPR main channel power")
    }
    /** Inverse FFT by conjugation, radix-2 in place (the web test's own, float storage and double arithmetic). */
    private fun ifft(re: FloatArray, im: FloatArray) {
        val n = re.size
        for (k in 0 until n) im[k] = -im[k]
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) { j = j xor bit; bit = bit shr 1 }
            j = j or bit
            if (i < j) { val tr = re[i]; re[i] = re[j]; re[j] = tr; val ti = im[i]; im[i] = im[j]; im[j] = ti }
        }
        var len = 2
        while (len <= n) {
            val ang = -2 * PI / len
            var i = 0
            while (i < n) {
                for (k in 0 until len / 2) {
                    val cr = cos(ang * k); val ci = sin(ang * k); val a = i + k; val b = a + len / 2
                    val tr = cr * re[b] - ci * im[b]; val ti = cr * im[b] + ci * re[b]
                    re[b] = (re[a] - tr).toFloat(); im[b] = (im[a] - ti).toFloat(); re[a] = (re[a] + tr).toFloat(); im[a] = (im[a] + ti).toFloat()
                }
                i += len
            }
            len = len shl 1
        }
        for (k in 0 until n) { re[k] = (re[k].toDouble() / n).toFloat(); im[k] = (-im[k].toDouble() / n).toFloat() }
    }

    private fun scale() {
        val y = FloatArray(200) { -118f }; y[100] = -62f
        val a = autoScale(y)
        ok(a.ref == -55 && a.div == 10, "AUTO SCALE frames a -62 dBm peak over a -118 floor (${a.ref}, ${a.div})")
        val b = autoScale(fa(-80.0, -79.0, -81.0, -40.0))
        ok(b.ref == -35 && b.div == 10, "and a small trace (${b.ref}, ${b.div})")
    }

    // ---- calibration and span plans -----------------------------------------------------------------------------
    private fun cal() {
        val g = GainState(RadioKind.HACKRF, pro = false, lna = 32, vga = 20, amp = true, tunerDb = Double.NaN)
        near(dbmOffset(g).offset, -10.0 - 66, 1e-9, "HackRF dBm offset follows LNA + VGA + amp")
        near(dbmOffset(g.copy(pro = true)).offset - dbmOffset(g).offset, HACKRF_PRO_DB.toDouble(), 1e-9, "a Pro is offset by its own figure at the same settings")
        near(dbmOffset(g, 3.0).offset - dbmOffset(g).offset, 3.0, 1e-9, "the CAL trim adds")
        near(dbmOffset(GainState(RadioKind.RTLSDR, false, 0, 0, false, 29.7)).offset, -5 - 29.7, 1e-9, "RTL-SDR offset follows the tuner gain")
        ok(!dbmOffset(GainState(RadioKind.RTLSDR, false, 0, 0, false, Double.NaN)).ok, "the tuner AGC leaves the scale uncalibrated")
        val rates = listOf(20e6, 10e6, 8e6, 4e6, 2e6)
        val p1 = planSpan(433.42e6, 434.42e6, rates)
        ok(p1 is SpanPlan.Fft && p1.rate == 4e6 && !p1.dcPatch && p1.tuneHz == 433.92e6 + 1e6, "a 1 MHz span sits off DC at 4 Msps")
        val p2 = planSpan(430e6, 440e6, rates)
        ok(p2 is SpanPlan.Fft && p2.rate == 20e6 && p2.dcPatch, "10 MHz spans centered at 20 Msps with DC patched")
        val p3 = planSpan(400e6, 500e6, rates)
        ok(p3 is SpanPlan.Sweep && p3.sliceRate == 20e6, "100 MHz sweeps in 20 MHz slices")
        val p4 = planSpan(100e6, 100.3e6, listOf(2.4e6, 2.048e6, 1.024e6))
        ok(p4 is SpanPlan.Fft && p4.rate == 1.024e6, "an RTL-SDR takes the smallest rate that fits")
        ok(parseHz("433.92M") == 433.92e6 && parseHz("100k") == 1e5 && parseHz("2.4G") == 2.4e9 && parseHz("915") == 915e6 && parseHz("915000000") == 915e6 && parseHz("x") == null, "parseHz reads units")
        ok(fmtHz(433.92e6) == "433.92 MHz" && fmtHz(12500.0) == "12.5 kHz", "fmtHz prints like a bench (${fmtHz(433.92e6)}, ${fmtHz(12500.0)})")
        ok(fmtSec(0.00125) == "1.250 ms" && fmtSec(830e-6) == "830.00 µs", "fmtSec prints like a scope")
    }

    // ---- sweep: slices stitched across a span wider than the radio ---------------------------------------------
    private fun sweep() {
        val sliceRate = 8e6; val start = 400e6; val stop = 440e6; val toneHz = 427.123e6; val a = 60.0
        val ev = ArrayList<SpectrumEvent>()
        val tunes = ArrayList<Long>()
        val cfg = SpecConfig(SpecMode.SWEEP, 0.0, start, stop, 30_000.0, WindowKind.HANN, 1e9, true, sliceRate, null)
        val sp = SpectrumProcessor(cfg, { ev.add(it) }, Retuner(tune = { tunes.add(it) }, applied = { false }))
        sp.reset(sliceRate.toInt())
        var tuned = start; var k = 0; var rows = 0; var last: SpFrame? = null
        var reads = 0
        while (reads < 3000 && rows < 2) {
            for (hz in tunes) { tuned = hz.toDouble(); sp.tuned() }
            tunes.clear()
            for (m in ev) if (m is SpFrame && m.step == m.steps) { rows++; last = m }
            ev.clear()
            val off = (toneHz - tuned) / sliceRate
            val tones = if (abs(off) < 0.5) listOf(Tone(off, a)) else emptyList()
            val s = signal(32768, tones, 1.0, Mulberry(100 + reads), k)
            k += 32768
            val iq = int8(s)
            sp.onIq(iq, iq.size, sliceRate.toInt())
            reads++
        }
        ok(rows >= 2, "the sweep completes passes ($rows)")
        last?.let { l ->
            val y = l.live; val i = peakSearch(y); val r = refinePeak(y, i)
            val f = l.f0 + (i + r.offset) * l.binHz
            near(f, toneHz, l.binHz, "a tone in a sweep lands at its frequency")
            near(r.level, dbfs(a), 1.6, "at its level")
            near(l.f0 + y.size * l.binHz, stop, l.binHz * sweepKeep(l.n), "the row covers the span")
            near(l.rbw / rbwOf(sliceRate, l.n, WindowKind.HANN), 1.0, 1e-5, "and reports its RBW")
        }
        val wn = sweepFft(0.0, 6e9, 20e6, 100.0, WindowKind.HANN)
        ok(wn < 65536 && kotlin.math.ceil(6e9 / (20e6 / wn)) <= MAX_ROW_BINS, "a very wide sweep widens its RBW to fit the row")
    }

    // ---- FFT mode: the processor crops the span and paces the screen --------------------------------------------
    private fun fftMode() {
        val rate = 4e6; val ev = ArrayList<SpectrumEvent>()
        val plan = planSpan(433.42e6, 434.42e6, listOf(rate)) as SpanPlan.Fft
        val cfg = SpecConfig(SpecMode.FFT, plan.tuneHz, 433.42e6, 434.42e6, 3000.0, WindowKind.HANN, 1e9, plan.dcPatch, 0.0, null)
        val sp = SpectrumProcessor(cfg, { ev.add(it) }, Retuner(tune = {}, applied = { false }))
        sp.reset(rate.toInt())
        val off = (433.92e6 - plan.tuneHz) / rate
        for (r in 0 until 10) { val iq = int8(signal(32768, listOf(Tone(off, 50.0)), 1.0, Mulberry(r), r * 32768)); sp.onIq(iq, iq.size, rate.toInt()) }
        val fr = ev.filterIsInstance<SpFrame>()
        ok(fr.size in 2..4, "about 30 frames a second reach the screen (${fr.size} for 82 ms)")
        val m = fr[fr.size - 1]
        ok(m.f0 >= 433.42e6 && m.f0 + m.live.size * m.binHz <= 434.42e6 + m.binHz, "the frame holds only the span")
        val i = peakSearch(m.live)
        near(m.f0 + i * m.binHz, 433.92e6, m.binHz, "and the tone is where it belongs")
    }

    /** A pulsed carrier at offset `off` Hz: on for `onS`, period `perS`, starting `lead` seconds in. */
    private fun pulsed(rate: Double, secs: Double, off: Double, a: Double, onS: Double, perS: Double, lead: Double, rnd: Mulberry, noise: Double = 0.5): Sig {
        val n = jsRound(rate * secs).toInt(); val i = FloatArray(n); val q = FloatArray(n)
        for (k in 0 until n) {
            val t = k / rate; val on = t >= lead && ((t - lead) % perS) < onS
            val ph = 2 * PI * off * t
            i[k] = ((if (on) a * cos(ph) else 0.0) + noise * gauss(rnd)).toFloat(); q[k] = ((if (on) a * sin(ph) else 0.0) + noise * gauss(rnd)).toFloat()
        }
        return Sig(i, q)
    }

    // ---- zero span ----------------------------------------------------------------------------------------------
    private fun zeroSpan() {
        run {
            val h = designLowpass(0.05, 63)
            near(h.sumOf { it.toDouble() }, 1.0, 1e-6, "the zero-span filter has unity gain at DC")
            val p = zsPlan(2e6, 10_000.0)
            ok(p.d1 == 12 && p.outRate >= 40_000 && p.outRate < 80_000, "zero-span plan for 10 kHz at 2 Msps (d1 ${p.d1}, out ${p.outRate})")
            near(zsMaxBw(2e6), 720_000.0, 1.0, "the widest filter at 2 Msps")
        }
        val rate = 2e6; val off = 400_000.0; val bw = 100_000.0
        val zcfg = ZsConfig(offsetHz = off, bwHz = bw, sweepSec = 0.02, trigger = TrigMode.RISE, single = false, levelDb = -30.0, pre = 0.25)
        val caps = ArrayList<ZsCapture>()
        val z = ZeroSpan(rate, zcfg) { if (!it.preview) caps.add(it) }
        val s = pulsed(rate, 0.06, off, 60.0, 0.001, 0.004, 0.0105, Mulberry(5))
        z.pushFloat(s.i, s.q)
        ok(caps.size >= 1, "RISE triggers on the pulses (${caps.size} captures)")
        val c = caps.firstOrNull()
        ok(c != null && !c.roll && abs(c.trig - 0.25 * c.amp.size) <= 1, "the trigger sits 25 % into the window (pre-trigger)")
        if (c != null) {
            ok(c.amp[c.trig - 2] < -30 && c.amp[c.trig + 3] > -30, "the amplitude crosses the level at the trigger")
            near(c.amp.maxOrNull()!!.toDouble(), dbfs(60.0), 0.5, "the pulse reads its level through the filter")
            val st = pulseStats(c.amp, c.rate)
            ok(st != null, "the window holds pulses")
            if (st != null) {
                near(st.width, 0.001, 0.00003, "pulse width 1 ms")
                near(st.period, 0.004, 0.00003, "period 4 ms")
                near(st.duty, 0.25, 0.01, "duty cycle 25 %")
                ok(st.rise > 0 && st.rise < 2 / bw, "rise time ${f1(st.rise * 1e6)} µs, set by the 100 kHz filter")
                ok(st.fall > 0 && st.fall < 2 / bw, "fall time likewise")
                near(st.top, dbfs(60.0), 0.5, "the top level")
                ok(st.pulses >= 4, "every complete pulse counted (${st.pulses})")
            }
        }
        // FALL triggers on the falling edge
        val caps2 = ArrayList<ZsCapture>(); val z2 = ZeroSpan(rate, zcfg.copy(trigger = TrigMode.FALL)) { if (!it.preview) caps2.add(it) }
        z2.pushFloat(s.i, s.q)
        val c2 = caps2.firstOrNull()
        ok(c2 != null && c2.amp[c2.trig - 3] > -30 && c2.amp[c2.trig + 2] < -30, "FALL triggers on the falling edge")
        // SINGLE takes one capture and waits to be armed again
        val caps3 = ArrayList<ZsCapture>(); val done3 = ArrayList<Boolean>()
        var z3h: ZeroSpan? = null
        val z3 = ZeroSpan(rate, zcfg.copy(single = true)) { if (!it.preview) { caps3.add(it); done3.add(z3h!!.done) } }
        z3h = z3
        z3.pushFloat(s.i, s.q)
        ok(caps3.size == 1 && z3.done, "SINGLE takes one capture")
        ok(done3.firstOrNull() == true, "and is already done when its capture goes out (the screen shows DONE, not ARMED)")
        z3.rearm(); z3.pushFloat(s.i, s.q)
        ok(caps3.size == 2, "and one more once re-armed")
        // FREE rolls: windows come at least 20 times a second of signal, without waiting for a trigger
        val caps4 = ArrayList<ZsCapture>(); val z4 = ZeroSpan(rate, zcfg.copy(trigger = TrigMode.FREE)) { caps4.add(it) }
        val quiet = pulsed(rate, 0.2, off, 0.0, 0.0, 1.0, 1.0, Mulberry(9))
        z4.pushFloat(quiet.i, quiet.q)
        ok(caps4.size >= 4 && caps4.all { it.roll && it.trig == -1 }, "FREE rolls without a trigger (${caps4.size})")
        // no trigger on a quiet channel
        val caps5 = ArrayList<ZsCapture>(); val prev5 = ArrayList<ZsCapture>(); val z5 = ZeroSpan(rate, zcfg) { (if (it.preview) prev5 else caps5).add(it) }
        val quiet1 = pulsed(rate, 1.0, off, 0.0, 0.0, 1.0, 2.0, Mulberry(19))
        z5.pushFloat(quiet1.i, quiet1.q)
        ok(caps5.size == 0, "RISE waits on a quiet channel")
        ok(prev5.size in 4..6 && prev5.all { it.roll && it.trig == -1 }, "and shows a preview of it while it waits, about 5 a second (${prev5.size} in 1 s)")
        // instantaneous frequency: a carrier 12 kHz above the channel reads +12 kHz
        val caps6 = ArrayList<ZsCapture>(); val z6 = ZeroSpan(rate, zcfg.copy(trigger = TrigMode.FREE, sweepSec = 0.005)) { caps6.add(it) }
        val fm = pulsed(rate, 0.02, off + 12_000, 50.0, 1.0, 1.0, 0.0, Mulberry(4))
        z6.pushFloat(fm.i, fm.q)
        val lastFm = caps6[caps6.size - 1].fm
        val sortedFm = lastFm.copyOf().also { it.sort() }
        near(sortedFm[sortedFm.size shr 1].toDouble(), 12_000.0, 50.0, "instantaneous frequency of an offset carrier")
        // phase advances by 360° per 1 / 12 kHz
        val ph = caps6[caps6.size - 1].ph; val prate = caps6[caps6.size - 1].rate
        var unwrapped = 0.0
        for (k in 1 until ph.size) { var d = ph[k].toDouble() - ph[k - 1]; if (d > 180) d -= 360; if (d < -180) d += 360; unwrapped += d }
        near(unwrapped / ((ph.size - 1) / prate) / 360, 12_000.0, 50.0, "phase turns at the offset frequency")
        ok(pulseStats(FloatArray(100) { -40f }, 1e5) == null, "a steady trace has no pulses")
        run {
            // a steady carrier in noise with a few fading dips: 6 dB between its noise peaks and its dips is not a pulse train
            val rnd = Mulberry(21); val y = FloatArray(4000)
            for (k in y.indices) y[k] = (-60 + 3 * gauss(rnd) - (if (k % 97 == 0) 25 else 0)).toFloat()
            ok(pulseStats(y, 1e5) == null, "a noisy steady carrier with fading dips has no pulses")
        }
        run {
            // the envelope of noise alone fades deeply and often, but it is not a pulse train
            val rnd = Mulberry(22); val y = FloatArray(20000)
            for (k in y.indices) { val a = 5 * gauss(rnd); val b = 5 * gauss(rnd); y[k] = (10 * log10((a * a + b * b) / (128 * 128) + 1e-20)).toFloat() }
            ok(pulseStats(y, 1e6) == null && twoLevels(y) == null, "noise alone has no pulses")
            // a weak pulse train only 15 dB over that same noise still reads
            val rp = Mulberry(23); val yp = FloatArray(20000)
            for (k in yp.indices) { val on = (k % 400) < 100; val a = 5 * gauss(rp) + (if (on) 28 else 0); val b = 5 * gauss(rp); yp[k] = (10 * log10((a * a + b * b) / (128 * 128) + 1e-20)).toFloat() }
            val sp = pulseStats(yp, 1e6)
            ok(sp != null && abs(sp.period - 400e-6) < 5e-6 && abs(sp.duty - 0.25) < 0.03, "a pulse train 15 dB over the noise reads (${sp?.let { f1(it.period * 1e6) }} µs, ${sp?.duty})")
        }
        ok(fmtSec(0.0) == "0 s", "zero time prints as 0 s")
        run {
            // the frequency pane fits an FSK swing of ±23 kHz (past half a 30 kHz filter), ignoring the noise between bursts
            val n = 1000; val fm = FloatArray(n); val amp = FloatArray(n); val r = Mulberry(31)
            for (k in 0 until n) { val on = k % 200 < 100; amp[k] = if (on) -60f else -120f; fm[k] = if (on) (if (k % 20 < 10) 23000f else -23000f) else (90000 * (r.next() - 0.5)).toFloat() }
            ok(fmScale(fm, amp, -110f, 30000.0) == 25000.0, "the frequency pane fits a ±23 kHz FSK swing (${fmScale(fm, amp, -110f, 30000.0)})")
            ok(fmScale(fm, FloatArray(n) { -130f }, -110f, 30000.0) == 15000.0, "with no signal it is half the filter")
        }
        ok(autoLevel(fa(-90.0, -88.0, -89.0, -40.0, -91.0)) == -77.0, "AUTO LEVEL sits 12 dB over the median")
        // long windows are reduced for the screen with the amplitude peak-held
        val big = ArrayList<ZsCapture>(); val zb = ZeroSpan(rate, zcfg.copy(bwHz = 300_000.0, sweepSec = 0.2, trigger = TrigMode.FREE)) { big.add(it) }
        ok(zb.window <= ZS_MAX_POINTS, "a window is capped")
        zb.pushFloat(quiet.i, quiet.q)
        ok(big.size > 0 && big[big.size - 1].amp.size <= ZS_SHOW_POINTS, "and reduced for the screen")
    }

    // ---- persistence --------------------------------------------------------------------------------------------
    private fun persistence() {
        val p = Persistence(4, 10, 0.5)
        p.add(fa(-10.0, -10.0, -50.0, -95.0), 0.0, 100.0)
        p.add(fa(-10.0, -10.0, -50.0, -95.0), 0.0, 100.0)
        ok(p.hits[1 * 4 + 0] == 1.5f && p.hits[5 * 4 + 2] == 1.5f && p.hits[9 * 4 + 3] == 1.5f, "persistence drops hits where the trace is, old ones fading")
        val pc = Persistence(3, 10, 1.0)
        pc.addColumns(fa(-15.0, -55.0, -55.0), 0.0, 100.0)
        ok(pc.hits[1 * 3 + 0] == 1f && pc.hits[5 * 3 + 1] == 1f && abs(pc.hits[3 * 3 + 1] - 0.35f) < 1e-6 && abs(pc.hits[1 * 3 + 1] - 0.35f) < 1e-6 && pc.hits[5 * 3 + 2] == 1f, "addColumns joins a column to the last with a run")
        val lv = p.level(); ok(abs(lv[4] - 1) < 1e-6 && lv[0] == 0f, "brightness is scaled to the busiest cell")
    }

}
