package com.rocketgod.mayhem.core.atsc

import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** US TV channels after the repack (VHF 2-13, UHF 14-36), 6 MHz each, and where the ATSC pilot sits in them. */
class TvChannel(val ch: Int, val lo: Double, val band: String)
val ATSC_CHANNELS: List<TvChannel> = buildList {
    for (ch in 2..4) add(TvChannel(ch, 54e6 + (ch - 2) * 6e6, "VHF-LO"))
    for (ch in 5..6) add(TvChannel(ch, 76e6 + (ch - 5) * 6e6, "VHF-LO"))
    for (i in 0 until 7) add(TvChannel(7 + i, 174e6 + i * 6e6, "VHF-HI"))
    for (i in 0 until 23) add(TvChannel(14 + i, 470e6 + i * 6e6, "UHF"))
}
fun centerOf(ch: Int): Double = (ATSC_CHANNELS.firstOrNull { it.ch == ch }?.lo ?: 0.0) + 3e6
/** The pilot: 309.441 kHz above the lower channel edge (A/53 Part 2 Sec 5.4.2), Sr/4 below the center. */
fun pilotOf(ch: Int): Double = centerOf(ch) - SR / 4
fun channelAt(hz: Double): TvChannel? = ATSC_CHANNELS.firstOrNull { hz > it.lo && hz < it.lo + 6e6 }

/** One burst of IQ to TS packets: the 8VSB receiver, then de-interleaving, RS and the de-randomizer. */
class BurstOut(
    val ok: Boolean, val reason: String, val pilot: PilotInfo?,
    val ts: ByteArray, val rs: RsStats, val fields: Int, val fieldSnr: DoubleArray,
    val snrDb: Double, val sliceSnrDb: Double, val segPeak: Double, val syncs: Int,
    val hist: IntArray, val eye: FloatArray, val echo: FloatArray, val dfe: FloatArray, val ffe: FloatArray,
    val eps: Double, val pilotHz: Double, val cpuMs: Double, val symbols: Int, val profile: Map<String, Double>,
)

/** [iq] is signed int8 I,Q, [len] bytes of it. */
fun decodeBurst(iq: ByteArray, rate: Double, st: BurstState, len: Int = iq.size): BurstOut {
    val t0 = System.nanoTime()
    val r = demodBurst(iq, rate, st, len)
    val rs = RsStats()
    var ts = ByteArray(0)
    if (r.ok && r.fields.isNotEmpty()) {
        val all = ByteArray(r.fields.size * FIELD_BYTES)
        r.fields.forEachIndexed { i, f -> System.arraycopy(f.bytes, 0, all, i * FIELD_BYTES, FIELD_BYTES) }
        ts = packetsToTs(deinterleave(all), 0, rs)
    }
    return BurstOut(r.ok, r.reason, r.pilot, ts, rs, r.fields.size, DoubleArray(r.fields.size) { r.fields[it].snrDb },
        r.snrDb, r.sliceSnrDb, r.segPeak, r.syncs, r.hist, r.eye, r.echo, r.dfe, r.ffe,
        st.eps, st.pilotHz, (System.nanoTime() - t0) / 1e6, r.symbols, r.profile)
}

/**
 * Burst decoding on threads of their own: the radio thread captures a burst and hands it to a free decoder, which
 * runs the receiver and the FEC and calls back with the TS packets. Each burst is independent, so as many bursts
 * decode at once as there are decoders.
 */
class AtscPool(val size: Int) {
    private val busy = AtomicInteger(0)
    @Volatile var failed = false
    private val ex = Executors.newFixedThreadPool(size) { r -> Thread(r, "atsc-burst").apply { isDaemon = true; priority = Thread.NORM_PRIORITY - 1 } }
    val free: Int get() = size - busy.get()
    /** Decodes a burst on a free decoder; false when none is free. */
    fun run(iq: ByteArray, rate: Double, st: BurstState, done: (BurstOut?, BurstState) -> Unit): Boolean {
        while (true) { val b = busy.get(); if (b >= size) return false; if (busy.compareAndSet(b, b + 1)) break }
        try {
            ex.execute {
                var out: BurstOut? = null
                try { out = decodeBurst(iq, rate, st) } catch (_: OutOfMemoryError) { failed = true } catch (_: Exception) { }
                busy.decrementAndGet()
                done(out, st)
            }
        } catch (_: Exception) { busy.decrementAndGet(); failed = true; return false }
        return true
    }
    fun close() { ex.shutdownNow() }

    companion object {
        /** Decoders for this device: half its cores (up to four), as many as a burst's working memory allows. */
        fun sized(): Int {
            val cores = Runtime.getRuntime().availableProcessors()
            val mem = (Runtime.getRuntime().maxMemory() / 2 / 100_000_000L).toInt()
            return (cores / 2).coerceAtMost(4).coerceAtMost(mem).coerceAtLeast(1)
        }
    }
}
