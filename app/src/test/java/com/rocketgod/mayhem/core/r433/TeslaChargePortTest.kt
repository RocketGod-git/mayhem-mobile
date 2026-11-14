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
 * Tesla charge port opener: a synthetic press built from the published bit sequence. Twin of web/test/tesla.mjs.
 * Pulse level first (with mark widening and jitter), then end to end from noisy IQ through the Devices front end.
 */
class TeslaChargePortTest {
    /** fredilarsen/TeslaChargeDoorOpener: 43 bytes sent MSB first, one bit per 400 us, five times 23 ms apart. */
    private val seq = intArrayOf(0x02, 0xAA, 0xAA, 0xAA, 0x2B, 0x2C, 0xCB, 0x33, 0x33, 0x2D, 0x34, 0xB5, 0x2B, 0x4D, 0x32, 0xAD, 0x2C,
        0x56, 0x59, 0x96, 0x66, 0x66, 0x5A, 0x69, 0x6A, 0x56, 0x9A, 0x65, 0x5A, 0x58, 0xAC, 0xB3, 0x2C, 0xCC, 0xCC, 0xB4,
        0xD2, 0xD4, 0xAD, 0x34, 0xCA, 0xB4, 0xA0)

    /** One message as (on, us) runs, leading zeros dropped; the trailing silence is the 23 ms to the next one. */
    private fun message(s: IntArray = seq): List<Pair<Boolean, Int>> {
        val bits = s.flatMap { b -> (7 downTo 0).map { (b shr it) and 1 } }
        val runs = ArrayList<Pair<Boolean, Int>>()
        for (b in bits.drop(bits.indexOf(1))) {
            val on = b == 1
            if (runs.isNotEmpty() && runs.last().first == on) runs[runs.size - 1] = on to runs.last().second + 400
            else runs.add(on to 400)
        }
        if (!runs.last().first) runs.removeAt(runs.size - 1)
        runs.add(false to 23_000)
        return runs
    }

    private var seed = 4242L
    private fun rnd(): Double { seed = (seed.toDouble() * 1103515245 + 12345).toLong() and 0xFFFFFFFFL; return seed / 4294967296.0 }

    private fun pulses(runs: List<Pair<Boolean, Int>>, rate: Double, widen: Int = 0, jitter: Int = 0): PulseData {
        val p = PulseData(runs.size, rate, false)
        for (i in runs.indices step 2) {
            val j = { (rnd() * 2 - 1) * jitter }
            p.pulse[p.numPulses] = ((runs[i].second + widen + j()) * rate / 1e6).roundToInt()
            p.gap[p.numPulses] = ((runs[i + 1].second - widen + j()) * rate / 1e6).roundToInt()
            p.numPulses++
        }
        return p
    }

    private val tesla get() = R433Registry.all.first { it.num == 1001 }

    @Test
    fun registered() {
        assertEquals("Tesla charge port opener", tesla.name)
        assertTrue(tesla.bands.containsAll(listOf(315_000_000L, 433_920_000L)))
    }

    @Test
    fun pulseLevel() {
        for ((widen, jitter) in listOf(0 to 0, 60 to 40, -60 to 40)) {
            val got = R433(listOf(tesla)).run(false, pulses(message(), 250_000.0, widen, jitter))
            assertEquals("one reading (widen $widen, jitter $jitter)", 1, got.size)
            assertEquals("Tesla-ChargePort", got[0].data["model"])
            assertEquals("all three frames", 3, got[0].data["frames"])
        }
        val bad = seq.copyOf(); bad[10] = bad[10] xor 0x10; bad[22] = bad[22] xor 0x10; bad[36] = bad[36] xor 0x10
        assertEquals("a corrupted code is not claimed", 0, R433(listOf(tesla)).run(false, pulses(message(bad), 250_000.0)).size)
        val others = R433(R433Registry.all.filter { it.num != 1001 }).run(false, pulses(message(), 250_000.0)).filter { !it.dev.disabled }
        assertEquals("no other protocol claims it: ${others.map { it.data["model"] }}", 0, others.size)
    }

    @Test
    fun endToEndOffTheDial() {
        val rate = 2_000_000; val offset = 150_000.0
        fun gauss(): Double = sqrt(-2 * ln(rnd() + 1e-12)) * cos(2 * PI * rnd())
        val out = java.io.ByteArrayOutputStream()
        var phase = 0.0
        fun push(i: Double, q: Double) {
            out.write(max(-128, min(127, Math.round(i + gauss() * 5).toInt())) + 128)
            out.write(max(-128, min(127, Math.round(q + gauss() * 5).toInt())) + 128)
        }
        fun key(on: Boolean, us: Int) {
            for (k in 0 until (us.toDouble() * rate / 1e6).roundToInt()) {
                phase += 2 * PI * offset / rate
                if (on) push(40 * cos(phase), 40 * sin(phase)) else push(0.0, 0.0)
            }
        }
        key(false, 100_000)
        repeat(5) { for ((on, us) in message()) key(on, us) }
        key(false, 200_000)

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
        val t = got.filter { it.model == "Tesla-ChargePort" }
        assertTrue("heard end to end (got $list)", t.isNotEmpty())
        assertTrue("shown as a Tesla charge port opener card", t.all { it.num == 1001 && it.what == "Tesla charge port opener" && it.family == "sensor" })
        assertTrue("found 150 kHz off the dial (got $list)", t.all { abs(it.offsetHz - offset) < 20_000 })
        assertEquals("one card, nothing else reported (got $list)", 1, got.map { it.key }.toSet().size)
    }
}
