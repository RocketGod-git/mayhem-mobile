package com.rocketgod.mayhem.core

import kotlin.math.max
import kotlin.math.min

/** A gap: samples lost, samples delivered since it, and how far either side it may really be. */
data class Gap(val lost: Long, val back: Long, val slack: Long)

/** Delivery under this share is losing samples (about one 64 KiB read in 30 s at 20 Msps). */
const val DELIVERY_OK = 0.999

/**
 * How much of what a radio sends arrives: samples delivered against wall time, for the HackRF and RTL-SDR drivers.
 * Kotlin twin of the web delivery.ts.
 *
 * A radio read too late overflows and drops samples with no error at all. At 20 Msps many hosts lose a few 64 KiB
 * reads a second that way, and one gap ruins any frame it lands in.
 *
 * The lag (samples the clock says were sent, less those delivered) rises while the reads are late and falls back as
 * they arrive. Lost samples never arrive, so they lift its floor for good. When the lowest lag over a settling time
 * stands clear above the floor, that is a gap, placed where the lag first came down to its new level.
 */
class DeliveryMeter {
    private var rate = 0
    private var t0 = 0.0
    private var delivered = 0L
    private var floor = 0.0
    private var settleMs = 300.0
    private var buf = 32_768L
    /** Recent buffers: ms, delivered before it, lag after it. */
    private class Mark(val t: Double, val before: Long, val lag: Double)
    private val hist = ArrayDeque<Mark>()
    /** Recent gaps: ms, samples lost. */
    private val losses = ArrayDeque<Pair<Double, Long>>()
    /** Samples lost since the last restart. */
    var lostTotal = 0L; private set
    /** Gaps since the last restart. */
    var gaps = 0; private set

    /** Watched from here: the stream (re)started at [rate], with [inflight] samples of reads queued at most and buffers
     *  of [buf] samples. Call after bring-up, a rate change, or any pause the driver makes on purpose. */
    fun restart(rate: Int, nowMs: Double, inflight: Long = 262_144, buf: Long = 32_768) {
        this.rate = rate; t0 = nowMs; delivered = 0; floor = Double.POSITIVE_INFINITY
        this.buf = max(1L, buf)
        // a stall shorter than the reads queued loses nothing, so the lag may stand up that long without a gap
        settleMs = max(300.0, 1.5 * 1000.0 * inflight / max(1, rate) + 100)
        hist.clear(); losses.clear(); lostTotal = 0; gaps = 0
    }

    /** How long this rate has been watched (ms). */
    fun measuredMs(nowMs: Double): Double = if (rate > 0) nowMs - t0 else 0.0

    /** The share of samples delivered over the last [windowMs] (1: none lost). */
    fun share(nowMs: Double, windowMs: Double = 10_000.0): Double {
        val span = min(windowMs, nowMs - t0)
        if (rate <= 0 || span <= 0) return 1.0
        var lost = 0L
        for ((t, n) in losses) if (nowMs - t <= windowMs) lost += n
        return max(0.0, 1 - lost / (rate * span / 1000))
    }

    /** Losing samples: watched at least [minMs] at this rate, and delivering under DELIVERY_OK. */
    fun losing(nowMs: Double, minMs: Double = 5000.0): Boolean = measuredMs(nowMs) >= minMs && share(nowMs) < DELIVERY_OK

    /** A buffer of [n] samples arrived at [nowMs]. Returns the gap found, if any. */
    fun push(n: Long, nowMs: Double): Gap? {
        if (rate <= 0) return null
        val before = delivered
        delivered += n
        val lag = rate * (nowMs - t0) / 1000 - delivered
        hist.addLast(Mark(nowMs, before, lag))
        while (hist.isNotEmpty() && nowMs - hist.first().t > 2 * settleMs) hist.removeFirst()
        // a host clock running slow, or a late first read, lowers the floor
        if (lag < floor) floor = lag
        if (nowMs - t0 < settleMs || nowMs - hist.first().t < settleMs) return null
        var low = Double.POSITIVE_INFINITY
        for (h in hist) if (nowMs - h.t <= settleMs && h.lag < low) low = h.lag
        val up = low - floor
        val thr = max(4096.0, buf / 4.0)
        if (up < thr) {
            // the radio's crystal against the host's clock: a slow drift, followed
            if (up > 0) floor += 0.02 * up
            return null
        }
        // after the last buffer still at the old floor, the first one down at the new level came after the gap (or is
        // the last one queued before it: the slack covers that)
        val tol = min(up, buf.toDouble()) / 2
        var j = -1
        for ((i, h) in hist.withIndex()) if (h.lag < floor + tol) j = i
        var at = before
        for (i in j + 1 until hist.size) if (hist[i].lag <= low + tol) { at = hist[i].before; break }
        val lost = Math.round(up)
        floor = low
        lostTotal += lost; gaps++
        losses.addLast(nowMs to lost)
        while (losses.isNotEmpty() && nowMs - losses.first().first > 60_000) losses.removeFirst()
        return Gap(lost, delivered - at, 2 * buf)
    }

    /** For a health line: "" while nothing is lost, else what share went missing lately. */
    fun note(nowMs: Double): String {
        val s = share(nowMs)
        if (s >= 1) return ""
        val pct = (1 - s) * 100
        return "radio lost %s%% of samples".format(java.util.Locale.US, if (pct < 0.1) "%.2f".format(java.util.Locale.US, pct) else "%.1f".format(java.util.Locale.US, pct))
    }

    companion object {
        /** The clock the meter runs on (ms). */
        fun nowMs(): Double = System.nanoTime() / 1e6
    }
}
