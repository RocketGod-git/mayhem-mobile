package com.rocketgod.mayhem.core

import java.util.Random
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * A stand-in radio for debug builds on an emulator: noise plus a few signals around the dial (a wide FM station, a
 * keyed FM voice channel, a steady carrier), fed to [SdrEngine] exactly as the HackRF's buffers are, so screens can be
 * laid out and photographed without hardware. Never started in a release build.
 *
 * Tuned to 1090 MHz at 2 Msps it also plays real ADS-B: DF17/18 frames recorded off the air by a dump1090 feeder
 * (adsb-demo.txt, debug resources only: "ms hexframe" per line), modulated back into PPM pulses at their recorded
 * times and looped, so the ADS-B screen fills with real traffic decoded by [AdsbDecoder] as it would be on air.
 */
object DemoIq {
    @Volatile private var thread: Thread? = null

    private class Frame(val ms: Long, val slots: BooleanArray, val amp: Double)
    private val adsb: List<Frame> by lazy {
        val res = DemoIq::class.java.classLoader?.getResourceAsStream("adsb-demo.txt") ?: return@lazy emptyList()
        res.bufferedReader().readLines().mapNotNull { line ->
            val (ms, hex) = line.split(' ').takeIf { it.size == 2 } ?: return@mapNotNull null
            val bytes = runCatching { ByteArray(hex.length / 2) { hex.substring(2 * it, 2 * it + 2).toInt(16).toByte() } }.getOrNull()
            // each plane at its own steady level, as it would be at its own range
            bytes?.let { Frame(ms.toLong(), TxApps.adsbSymbols(it), 60.0 + (hex.substring(2, 8).hashCode() and 31)) }
        }
    }

    fun start() {
        if (thread != null) return
        SdrEngine.onSource(SdrEngine.rateHz.value)
        SdrEngine.setActive(true)
        thread = Thread({ run() }, "demo-iq").apply { isDaemon = true; start() }
    }

    private fun run() {
        val rng = Random(1)
        val n = 65536
        val buf = ByteArray(2 * n)
        var t = 0L
        var p1 = 0.0; var p2 = 0.0; var p3 = 0.0
        val pulse = DoubleArray(n)
        var next = 0                   // the next recorded frame to play
        var loopAt = 0L                // the sample the recording's current pass started at
        var free = 0L                  // the first sample after the last frame played: frames never overlap
        while (true) {
            val rate = SdrEngine.rateHz.value.toDouble()
            SdrEngine.onSource(rate.toInt())
            val span = rate / 2
            val f1 = -0.55 * span; val f2 = 0.3 * span; val f3 = -0.15 * span
            pulse.fill(0.0)
            val onAdsb = rate == SdrEngine.IQ_RATE.toDouble() && kotlin.math.abs(SdrEngine.freqHz.value - 1_090_000_000L) < 1_000_000L
            if (onAdsb && adsb.isNotEmpty()) {
                val passLen = (adsb.last().ms + 1000) * 2000
                while (true) {
                    if (next >= adsb.size) { next = 0; loopAt += passLen }
                    val f = adsb[next]
                    val at = maxOf(loopAt + f.ms * 2000, free)
                    if (at >= t + n) break
                    for (s in f.slots.indices) { val x = at + s - t; if (f.slots[s] && x in 0 until n) pulse[x.toInt()] = f.amp }
                    free = at + f.slots.size + 4
                    next++
                }
            } else { loopAt = t; next = 0; free = t }
            for (k in 0 until n) {
                val s = (t + k) / rate
                p1 += 2 * PI * (f1 + 60_000 * sin(2 * PI * 900 * s)) / rate
                // a voice channel that keys up for three seconds in five, with a syllable-rate swing
                val keyed = (s % 5.0) < 3.0
                p2 += 2 * PI * (f2 + 2500 * sin(2 * PI * 600 * s) * (0.6 + 0.4 * sin(2 * PI * 4 * s))) / rate
                p3 += 2 * PI * f3 / rate
                // on 1090 MHz the dial's stations give way to the ADS-B pulses, as on air
                val tones = if (onAdsb) 0.0 else 1.0
                var i = 3.0 * rng.nextGaussian() + tones * (24 * cos(p1) + 5 * cos(p3))
                var q = 3.0 * rng.nextGaussian() + tones * (24 * sin(p1) + 5 * sin(p3))
                if (keyed) { i += tones * 14 * cos(p2); q += tones * 14 * sin(p2) }
                if (pulse[k] > 0) { i += pulse[k]; q += 0.3 * pulse[k] }
                buf[2 * k] = (127.4 + i).toInt().coerceIn(0, 255).toByte()
                buf[2 * k + 1] = (127.4 + q).toInt().coerceIn(0, 255).toByte()
            }
            t += n
            p1 %= 2 * PI; p2 %= 2 * PI; p3 %= 2 * PI
            SdrEngine.onIq(buf, buf.size)
            try { Thread.sleep((n * 1000 / rate).toLong().coerceAtLeast(5)) } catch (e: InterruptedException) { return }
        }
    }
}
