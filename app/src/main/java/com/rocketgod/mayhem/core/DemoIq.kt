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

    /**
     * Program audio the stations carry, 8 s at 32 kHz, looped: music (a chord that changes every beat, a kick and
     * hi-hat noise, compressed loud as broadcast is) or talk (a voiced buzz in syllables, words and pauses). A real
     * program's spread of tones and loudness is what gives an FM station its ragged, breathing shape on a waterfall;
     * a sine or two only makes clean comb lines.
     */
    private const val PROG_RATE = 32_000.0
    private val music: FloatArray by lazy { program(false) }
    private val talk: FloatArray by lazy { program(true) }
    private fun program(isTalk: Boolean): FloatArray {
        val r = Random(if (isTalk) 11L else 7L)
        val out = FloatArray(1 shl 18)
        var lp = 0.0; var lp2 = 0.0; var note = 220.0; var ph1 = 0.0; var ph2 = 0.0; var ph3 = 0.0
        var pitch = 0.0; var f0 = 120.0; var env = 0.0; var loud = 1.0
        var left = 0; var on = false; var syls = 0      // talk: samples left in this syllable or gap, syllables left in the phrase
        for (k in out.indices) {
            val w = r.nextGaussian()
            lp += 0.35 * (w - lp); lp2 += 0.04 * (lp - lp2)
            if (k % 1600 == 0) loud = (loud + 0.25 * r.nextGaussian()).coerceIn(0.5, 1.5)   // loudness wanders, 20 times a second
            out[k] = if (isTalk) {
                if (--left <= 0) {
                    on = !on && syls > 0
                    if (on) { syls--; left = (0.08 + 0.18 * r.nextDouble()).times(PROG_RATE).toInt(); f0 = (f0 + 25 * r.nextGaussian()).coerceIn(85.0, 190.0) }
                    else if (syls > 0) left = (0.02 + 0.10 * r.nextDouble()).times(PROG_RATE).toInt()
                    else { syls = 3 + r.nextInt(7); left = (0.15 + 0.7 * r.nextDouble()).times(PROG_RATE).toInt() }
                }
                env += ((if (on) 1.0 else 0.3) - env) * 0.0015   // breath and room between words, never dead air
                pitch += f0 / PROG_RATE
                (((pitch % 1.0) - 0.5) + 0.8 * (lp - lp2)) * env * loud
            } else {
                if (k % (6000 + 4000 * (k / 50000 % 2)) == 0) note = 98 * 2.0.pow(r.nextInt(24) / 12.0)
                ph1 += note / PROG_RATE; ph2 += note * 1.26 / PROG_RATE; ph3 += note * 1.5 / PROG_RATE
                // saw-edged chord for a full spread of harmonics, a bed of hiss, and only a light kick
                val chord = ((ph1 % 1.0) - 0.5) + 0.7 * ((ph2 % 1.0) - 0.5) + 0.6 * ((ph3 % 1.0) - 0.5)
                val beat = (k / PROG_RATE * 2.1) % 1.0
                val kick = kotlin.math.exp(-beat * 12) * sin(2 * PI * 60 * k / PROG_RATE)
                (0.6 * chord + 1.2 * (lp - lp2) + 0.25 * kick) * loud
            }.toFloat()
        }
        // compressed and clipped hard, as broadcast is: the deviation stays near full instead of idling at the carrier
        var rms = 0.0
        for (v in out) rms += v * v
        rms = kotlin.math.sqrt(rms / out.size)
        val g = (if (isTalk) 0.6 else 0.9) / rms
        for (k in out.indices) out[k] = kotlin.math.tanh(g * out[k]).toFloat()
        return out
    }

    /**
     * One station on the dial, all from its frequency: level, deviation, what it plays and from where in the loop, its
     * fade. Broadcast stations send the FM stereo multiplex (L+R, a 19 kHz pilot, L-R on 38 kHz, RDS on 57 kHz).
     */
    private class Station(val hz: Long, val amp: Double, val dev: Double, val prog: FloatArray, val stereo: Boolean,
                          val duty: Double, val fade: Double, val fph: Double, start: Double) {
        var ph = 0.0; var ap = start; var pil = 0.0
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
        val start = u(h, 7) * 200_000
        if (hz in 88_000_000L..108_000_000L) {
            if (u(h, 0) > 0.55) return@getOrPut null
            val db = 6 + 14 * u(h, 1)
            val isTalk = u(h, 3) < 0.25
            Station(hz, 8 * 10.0.pow((db - 24) / 20), 60_000 + 15_000 * u(h, 2), if (isTalk) talk else music, !isTalk || u(h, 4) < 0.5,
                1.0, 3 + 9 * u(h, 5), u(h, 6), start)
        } else {
            if (u(h, 0) > 0.045) return@getOrPut null
            val db = 6 + 14 * u(h, 1)
            val carrier = u(h, 2) < 0.3
            // narrow FM is mostly two-way talk, keyed up part of the time; a few carriers stay on
            Station(hz, 10.0.pow((db - (if (carrier) 20 else 12)) / 20), if (carrier) 0.0 else 2500 + 2000 * u(h, 3), talk, false,
                if (carrier) 1.0 else 0.3 + 0.5 * u(h, 4), 2 + 8 * u(h, 5), u(h, 6), start)
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
        var p2 = 0.0; var v1 = 0.0                // the voice channel's carrier phase (cycles) and place in the talk loop
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
                val step = PROG_RATE / rate; val pMask = music.size - 1
                for (st in stationsIn(fc - (0.48 * rate).toLong(), fc + (0.48 * rate).toLong())) {
                    // keyed stations talk in overs: on for part of each cycle, a cycle set by the station
                    if (st.duty < 1.0 && ((sec / (4 + 6 * st.fph) + st.fph) % 1.0) > st.duty) continue
                    val off = (st.hz - fc) / rate; val dv = st.dev / rate; val pil = 19_000 / rate
                    // each fades on its own, with a little multipath flicker from buffer to buffer
                    val a = st.amp * (0.7 + 0.3 * sin(2 * PI * (sec / st.fade + st.fph))) * (1 + 0.12 * rng.nextGaussian())
                    val prog = st.prog
                    var ph = st.ph; var ap = st.ap; var pp = st.pil
                    for (k in 0 until n) {
                        ap += step; pp += pil
                        val x = ap.toInt()
                        var m = prog[x and pMask].toDouble()
                        if (st.stereo) {
                            val diff = prog[(x + 40_000) and pMask]                           // L-R: another stretch of the program
                            val rds = if (prog[((pp / 16).toInt() * 7919) and pMask] > 0) 1 else -1  // 1187.5 bit/s, BPSK-ish
                            m = 0.75 * m + 0.1 * sinC(pp) + 0.35 * diff * sinC(2 * pp) + 0.05 * rds * sinC(3 * pp)
                        }
                        ph += off + dv * m
                        si[k] += a * cosC(ph); sq[k] += a * sinC(ph)
                    }
                    st.ph = ph - floor(ph); st.ap = ap % (pMask + 1); st.pil = pp - floor(pp)
                }
                // a voice channel that keys up for three seconds in five, talking
                if ((sec % 5.0) < 3.0) {
                    for (k in 0 until n) {
                        v1 += step
                        p2 += (f2 + 2500 * talk[v1.toInt() and pMask]) / rate
                        si[k] += 1.5 * cosC(p2); sq[k] += 1.5 * sinC(p2)
                    }
                    p2 -= floor(p2); v1 %= (pMask + 1)
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
