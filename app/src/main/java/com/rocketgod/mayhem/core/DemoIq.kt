package com.rocketgod.mayhem.core

import java.util.Random
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * A stand-in radio for debug builds on an emulator: noise plus a few signals around the dial (a wide FM station, a
 * keyed FM voice channel, a steady carrier), fed to [SdrEngine] exactly as the HackRF's buffers are, so screens can be
 * laid out and photographed without hardware. Never started in a release build.
 */
object DemoIq {
    @Volatile private var thread: Thread? = null

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
        while (true) {
            val rate = SdrEngine.rateHz.value.toDouble()
            SdrEngine.onSource(rate.toInt())
            val span = rate / 2
            val f1 = -0.55 * span; val f2 = 0.3 * span; val f3 = -0.15 * span
            for (k in 0 until n) {
                val s = (t + k) / rate
                p1 += 2 * PI * (f1 + 60_000 * sin(2 * PI * 900 * s)) / rate
                // a voice channel that keys up for three seconds in five, with a syllable-rate swing
                val keyed = (s % 5.0) < 3.0
                p2 += 2 * PI * (f2 + 2500 * sin(2 * PI * 600 * s) * (0.6 + 0.4 * sin(2 * PI * 4 * s))) / rate
                p3 += 2 * PI * f3 / rate
                var i = 3.0 * rng.nextGaussian() + 24 * cos(p1) + 5 * cos(p3)
                var q = 3.0 * rng.nextGaussian() + 24 * sin(p1) + 5 * sin(p3)
                if (keyed) { i += 14 * cos(p2); q += 14 * sin(p2) }
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
