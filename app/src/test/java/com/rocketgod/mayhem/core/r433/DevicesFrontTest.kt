package com.rocketgod.mayhem.core.r433

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The Devices front end end to end: raw IQ in, readings out, with the burst far off the dial. Twin of
 * web/test/devices-front.mjs.
 *
 * A Ford V3 key frame (ProtoPirate's own golden pulses, so no real key is in the repo) is frequency shift keyed
 * onto a carrier 335 kHz above the dial, as a real Ford key does, then sent again 327 kHz below it, the other
 * frequency the same key uses. Both must be found, tuned to and decoded, and nothing else may be reported.
 */
class DevicesFrontTest {
    /** The first train of the fixture: levels and durations in microseconds. */
    private fun train(): List<Pair<Boolean, Int>> {
        val text = javaClass.classLoader!!.getResource("pirate/ford_v3.txt")!!.readText()
        val out = ArrayList<Pair<Boolean, Int>>()
        var n = 0
        for (raw in text.split('\n')) {
            val line = raw.trim()
            if (line.startsWith("# train")) { if (++n > 1) break; continue }
            if (line.isEmpty() || line[0] == '#' || line[0] == '=') continue
            val parts = line.split(' ')
            out.add((parts[0] != "0") to parts[1].toInt())
        }
        return out
    }

    @Test
    fun fordKeyFarOffTheDialOnBothFrequencies() {
        val train = train()
        assertTrue("fixture train read", train.size > 100)

        val rate = 2_000_000
        var seed = 12345L
        // in doubles, as the web test does it (the product passes 2^53, so its low bits round the same way)
        fun rnd(): Double { seed = (seed.toDouble() * 1103515245 + 12345).toLong() and 0xFFFFFFFFL; return seed / 4294967296.0 }
        fun gauss(): Double = sqrt(-2 * ln(rnd() + 1e-12)) * cos(2 * PI * rnd())
        val out = java.io.ByteArrayOutputStream()
        var phase = 0.0
        fun push(i: Double, q: Double) {
            // offset-128 bytes, the form the receiver takes
            out.write(max(-128, min(127, Math.round(i + gauss() * 5).toInt())) + 128)
            out.write(max(-128, min(127, Math.round(q + gauss() * 5).toInt())) + 128)
        }
        /** Noise for [ms], or the train shifted onto [hz] with ±[dev] Hz of shift. */
        fun emit(ms: Int, hz: Double? = null, dev: Double = 10_500.0, amp: Double = 40.0) {
            if (hz == null) { for (k in 0 until rate / 1000 * ms) push(0.0, 0.0); return }
            for ((level, us) in train.drop(1)) {
                val f = hz + if (level) dev else -dev
                for (k in 0 until (us * rate / 1e6).roundToInt()) { phase += 2 * PI * f / rate; push(amp * cos(phase), amp * sin(phase)) }
            }
        }
        emit(100)
        emit(0, 335_000.0)
        emit(1300)
        emit(0, -327_000.0)
        emit(200)

        val readings = ArrayList<HeardDevice>()
        val p = R433Processor()
        p.onReading = { synchronized(readings) { readings.add(it) } }
        p.reset(rate)
        val iq = out.toByteArray()
        var i = 0
        while (i < iq.size) {
            val n = min(262_144, iq.size - i)
            p.onIq(iq.copyOfRange(i, i + n), n, rate)
            p.settle()
            i += n
        }
        p.settle()

        val got = synchronized(readings) { readings.toList() }
        val list = got.joinToString(", ") { "${it.model}@${it.offsetHz}" }.ifEmpty { "nothing" }
        val fords = got.filter { it.model == "Ford V3" && it.data["id"] == "2265B1F6" }
        assertTrue("Ford found 335 kHz above the dial (got $list)", fords.any { abs(it.offsetHz - 335_000) < 20_000 })
        assertTrue("Ford found 327 kHz below the dial (got $list)", fords.any { abs(it.offsetHz + 327_000) < 20_000 })
        assertTrue("reads as an Unlock press", fords.all { it.family == "key" && it.data["button"] == "02 Unlock" })
        assertEquals("nothing else reported (got $list)", fords.size, got.size)
    }
}
