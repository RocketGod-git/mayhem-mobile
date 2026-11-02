package com.rocketgod.mayhem.core

import java.util.Random
import kotlin.math.PI
import kotlin.math.floor
import kotlin.math.pow
import kotlin.math.sin

/**
 * A stand-in radio for debug builds on an emulator: noise plus a dial full of stations (wide FM every few channels
 * across 88-108 MHz, scattered narrow FM and carriers elsewhere, each at its own level and slowly fading, placed by
 * frequency so every tuning and every Looking Glass slice sees its own), and a keyed FM voice channel, fed to
 * [SdrEngine] exactly as the HackRF's buffers are, so screens can be laid out and photographed without hardware.
 * Never started in a release build.
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
            // each plane at its own steady level, 12 to 23 dB over the noise as at its own range: strong enough to decode,
            // not so strong that the pulses wash the whole waterfall
            bytes?.let { Frame(ms.toLong(), TxApps.adsbSymbols(it), 12.0 + (hex.substring(2, 8).hashCode() and 31)) }
        }
    }

    // a sine table indexed in cycles: Math.sin per sample per station is too slow on an emulator
    private val SIN = FloatArray(4096) { sin(2 * PI * it / 4096).toFloat() }
    private fun sinC(c: Double) = SIN[(c * 4096).toInt() and 4095]
    private fun cosC(c: Double) = SIN[((c * 4096).toInt() + 1024) and 4095]

    /** One station on the dial: level, FM deviation and two message tones, fade period, all from its frequency. */
    private class Station(val hz: Long, val amp: Double, val dev: Double, val m1: Double, val m2: Double, val fade: Double, val fph: Double) {
        var ph = 0.0; var a1 = 0.0; var a2 = 0.0
    }
    private val stations = HashMap<Long, Station?>()

    private fun mix(x: Long): Long {   // splitmix64: the same frequency always gets the same station
        var z = x + -0x61c8864680b583ebL
        z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
        z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
        return z xor (z ushr 31)
    }
    private fun u(h: Long, k: Int) = ((h ushr (8 * k)) and 255) / 255.0

    // levels are dB over the floor on the waterfall's 40 dB scale, kept low (6 to 20) as real stations mostly are, so
    // they spread across the colour ramp instead of all clipping to the top of it
    private fun station(hz: Long): Station? = stations.getOrPut(hz) {
        val h = mix(hz)
        if (hz in 88_000_000L..108_000_000L) {
            if (u(h, 0) > 0.55) return@getOrPut null
            val db = 6 + 14 * u(h, 1)
            Station(hz, 8 * 10.0.pow((db - 24) / 20), 45_000 + 30_000 * u(h, 2), 300 + 2000 * u(h, 3), 1500 + 4000 * u(h, 4), 3 + 9 * u(h, 5), u(h, 6))
        } else {
            if (u(h, 0) > 0.045) return@getOrPut null
            val db = 6 + 14 * u(h, 1)
            val carrier = u(h, 2) < 0.35
            Station(hz, 10.0.pow((db - (if (carrier) 20 else 10)) / 20), if (carrier) 0.0 else 2000 + 2500 * u(h, 3),
                200 + 800 * u(h, 4), 600 + 1500 * u(h, 5), 2 + 8 * u(h, 6), u(h, 7))
        }
    }

    /** The stations inside [lo, hi]: wide FM on the odd 100 kHz channels of the broadcast band, narrow on a 25 kHz grid elsewhere. */
    private fun stationsIn(lo: Long, hi: Long): List<Station> {
        val out = ArrayList<Station>()
        var f = (Math.floorDiv(lo - 100_000L, 200_000L) + 1) * 200_000L + 100_000L
        while (f <= hi) { if (f in 88_000_000L..108_000_000L) station(f)?.let { out.add(it) }; f += 200_000L }
        f = (Math.floorDiv(lo, 25_000L) + 1) * 25_000L
        while (f <= hi) { if (f !in 87_900_000L..108_100_000L) station(f)?.let { out.add(it) }; f += 25_000L }
        return out
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
        var p2 = 0.0; var v1 = 0.0                // the voice channel's carrier and tone phases, in cycles
        val pulse = DoubleArray(n)
        val si = DoubleArray(n); val sq = DoubleArray(n)
        // a ring of Gaussian noise, read from a random point each buffer: nextGaussian per sample is too slow on an emulator
        val noise = DoubleArray(1 shl 18) { 3.0 * rng.nextGaussian() }
        val nMask = noise.size - 1
        var next = 0                   // the next recorded frame to play
        var loopAt = 0L                // the sample the recording's current pass started at
        var free = 0L                  // the first sample after the last frame played: frames never overlap
        var clock = System.nanoTime()  // paced by the clock: a buffer's worth of real time per buffer, less the work
        while (true) {
            val rate = SdrEngine.rateHz.value.toDouble()
            SdrEngine.onSource(rate.toInt())
            val f2 = 0.15 * rate
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
            si.fill(0.0); sq.fill(0.0)
            if (!onAdsb) {                        // on 1090 MHz the dial's stations give way to the ADS-B pulses, as on air
                val fc = SdrEngine.freqHz.value
                val sec = t / rate
                for (st in stationsIn(fc - (0.48 * rate).toLong(), fc + (0.48 * rate).toLong())) {
                    val off = (st.hz - fc) / rate; val dv = st.dev / rate / 1.5; val d1 = st.m1 / rate; val d2 = st.m2 / rate
                    val a = st.amp * (0.7 + 0.3 * sin(2 * PI * (sec / st.fade + st.fph)))   // each fades on its own
                    var ph = st.ph; var a1 = st.a1; var a2 = st.a2
                    for (k in 0 until n) {
                        a1 += d1; a2 += d2
                        ph += off + dv * (sinC(a1) + 0.5 * sinC(a2))
                        si[k] += a * cosC(ph); sq[k] += a * sinC(ph)
                    }
                    st.ph = ph - floor(ph); st.a1 = a1 - floor(a1); st.a2 = a2 - floor(a2)
                }
                // a voice channel that keys up for three seconds in five, with a syllable-rate swing
                if ((sec % 5.0) < 3.0) {
                    for (k in 0 until n) {
                        v1 += 600 / rate
                        p2 += (f2 + 2500 * sinC(v1) * (0.6 + 0.4 * sinC(4 * (sec + k / rate)))) / rate
                        si[k] += 1.5 * cosC(p2); sq[k] += 1.5 * sinC(p2)
                    }
                    p2 -= floor(p2); v1 -= floor(v1)
                }
            }
            var nz = rng.nextInt(noise.size)
            for (k in 0 until n) {
                var i = noise[nz] + si[k]; var q = noise[(nz + 7919) and nMask] + sq[k]; nz = (nz + 1) and nMask
                if (pulse[k] > 0) { i += pulse[k]; q += 0.3 * pulse[k] }
                buf[2 * k] = (127.4 + i).toInt().coerceIn(0, 255).toByte()
                buf[2 * k + 1] = (127.4 + q).toInt().coerceIn(0, 255).toByte()
            }
            t += n
            SdrEngine.onIq(buf, buf.size)
            clock += (n * 1e9 / rate).toLong()
            val wait = (clock - System.nanoTime()) / 1_000_000
            if (wait < -500) clock = System.nanoTime()        // too far behind (a slow emulator): stop trying to catch up
            try { Thread.sleep(wait.coerceAtLeast(1)) } catch (e: InterruptedException) { return }
        }
    }
}
