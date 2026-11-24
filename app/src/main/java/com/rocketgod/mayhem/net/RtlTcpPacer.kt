package com.rocketgod.mayhem.net

/**
 * A jitter buffer between an rtl_tcp socket and the engine, the way a streaming or VoIP player keeps one. rtl_tcp
 * sends in bursts (measured from a wired PC: 2 to 16 MB/s in 250 ms slices around the 4.8 MB/s that 2.4 Msps needs)
 * and Wi-Fi adds stalls of a second or two, after which the server sends what it held all at once. The engine expects
 * samples the way a USB dongle delivers them, steadily. The reader [write]s whatever arrives; [tick], called every few
 * milliseconds on its own thread, hands the engine [chunk]-byte pieces (2 bytes a sample) on a steady clock:
 *
 *  - It starts once [PREBUFFER_S] is buffered (at connect and after every retune, so the dial answers quickly).
 *  - The depth it keeps, [targetS], is learned from the link. A stall (no data for half a second or more) raises it
 *    to the stall's length plus a margin, up to [MAX_TARGET_S], and running dry raises it a step too; a run dry waits
 *    for the whole target again. Each clean minute (no stall, nothing run dry) takes a step back toward [PREBUFFER_S].
 *    The target belongs to the link, so a retune keeps it.
 *  - It reaches and holds the target only by releasing a little fast or slow: the backlog's low point over two
 *    seconds against the target sets a speed between [MIN_SPEED] and [MAX_SPEED] of real time, which the audio
 *    output's resampler absorbs without a sound. Nothing is thrown away, except a backlog past [CUT_S], which is cut
 *    back to the target at a chunk boundary and said once.
 *
 * Plain JVM; time comes in as nanoseconds, so it is tested with a made-up clock.
 */
class RtlTcpPacer(private val sink: (ByteArray, Int) -> Unit, private val onEvent: (String) -> Unit = {}) {
    private val lock = Object()
    private var ring = ByteArray(0)
    private var head = 0          // next byte out
    private var count = 0         // bytes buffered
    private var bps = 0L          // bytes a second at the nominal rate
    var chunk = 65536; private set
    // chunks copied out under the lock and handed to the engine after it, so the socket reader never waits on the engine
    private var outs = Array(0) { ByteArray(0) }

    private var playing = false
    private var refillToTarget = false   // ran dry: wait for the whole target, not the short prebuffer
    private var lastNs = 0L
    private var credit = 0.0
    private var winStartNs = 0L
    private var winMin = Int.MAX_VALUE
    private var inTotal = 0L      // bytes written ever
    private var inSeen = 0L       // [inTotal] at the last arrival [tick] saw
    private var lastInNs = -1L    // when [tick] last saw bytes arrive
    private var cleanSinceNs = -1L
    private var growPending = false
    private var dryGapS = 0.0     // the longest stall around the last run dry, for its log line

    /** The depth it steers to, in seconds; learned from the link and kept across resets. */
    @Volatile var targetS = PREBUFFER_S; private set
    /** How fast it releases right now, against real time. */
    @Volatile var speed = 1.0; private set
    /** Times it ran dry while playing and had to wait for the target again. */
    @Volatile var rebuffers = 0; private set
    /** Bytes thrown away because the buffer was full (it holds [CAPACITY_S]); should stay 0. */
    @Volatile var overflowBytes = 0L; private set
    /** Bytes cut from a backlog past [CUT_S]; should stay 0. */
    @Volatile var cutBytes = 0L; private set
    @Volatile var deliveredBytes = 0L; private set
    /** Handing samples to the engine (not waiting for the buffer to fill). */
    val isPlaying: Boolean get() = synchronized(lock) { playing }
    /** How far behind the radio the engine is right now: what is buffered, in seconds. */
    val latencyS: Double get() = synchronized(lock) { if (bps > 0) count.toDouble() / bps else 0.0 }

    /** Start over at [rateHz]: everything buffered is from the old tuning or rate, so it goes. */
    fun reset(rateHz: Int) = synchronized(lock) {
        val b = rateHz.toLong() * 2
        if (b != bps) {
            bps = b
            ring = ByteArray(((b * CAPACITY_S).toLong().coerceIn(1L shl 16, 64L shl 20) and 1L.inv()).toInt())
            chunk = if (b >= 3_200_000L) 65536 else 16384
            // the most one tick can owe: a tenth of a second of credit, plus one
            outs = Array((maxOf(b / 10, chunk.toLong()) / chunk + 2).toInt()) { ByteArray(chunk) }
        }
        head = 0; count = 0; playing = false; refillToTarget = false; credit = 0.0; speed = 1.0
        winMin = Int.MAX_VALUE; winStartNs = 0L; lastInNs = -1L; inSeen = inTotal
    }

    /** Samples from the socket, whole I/Q pairs. */
    fun write(b: ByteArray, n: Int) = synchronized(lock) {
        if (ring.isEmpty() || n <= 0) return@synchronized
        var off = 0; var len = n
        inTotal += n
        if (len > ring.size) { overflowBytes += len - ring.size; off = len - ring.size; len = ring.size }
        val free = ring.size - count
        if (len > free) {
            // full: the oldest goes (whole pairs, as the ring size and every write are even)
            val drop = len - free
            head = (head + drop) % ring.size; count -= drop; overflowBytes += drop
        }
        var tail = (head + count) % ring.size
        var left = len
        while (left > 0) {
            val k = minOf(left, ring.size - tail)
            System.arraycopy(b, off, ring, tail, k)
            off += k; left -= k; tail = (tail + k) % ring.size
        }
        count += len
        Unit
    }

    private fun grow(toS: Double) { targetS = minOf(MAX_TARGET_S, maxOf(targetS, toS)) }

    /** Hand the engine what is due at [nowNs]; returns the chunks handed over. Called from one thread only. */
    fun tick(nowNs: Long): Int {
        val n = due(nowNs)
        val c = chunk
        for (i in 0 until n) sink(outs[i], c)
        return n
    }

    /** Everything [tick] does under the lock: the bookkeeping, and copying what is due into [outs]. */
    private fun due(nowNs: Long): Int = synchronized(lock) {
        if (bps == 0L) return@synchronized 0
        // stalls: how long since bytes last arrived, judged when they arrive again
        if (lastInNs < 0) { lastInNs = nowNs; inSeen = inTotal }
        if (cleanSinceNs < 0) cleanSinceNs = nowNs
        if (inTotal != inSeen) {
            val gapS = (nowNs - lastInNs) / 1e9
            inSeen = inTotal; lastInNs = nowNs
            if (gapS >= STALL_S) {
                cleanSinceNs = nowNs
                if (growPending) dryGapS = maxOf(dryGapS, gapS)
                if (gapS + MARGIN_S > targetS + 0.05) {
                    val was = targetS
                    grow(gapS + MARGIN_S)
                    // a stall it rode through says so now; one that ran it dry says so when it plays again
                    if (!growPending && targetS > was) onEvent("rtl_tcp: link stalled %.1f s, buffer target up to %.1f s".format(gapS, targetS))
                }
            }
        }
        if (!playing) {
            val need = if (refillToTarget) targetS else PREBUFFER_S
            if (count < bps * need) return@synchronized 0
            playing = true; lastNs = nowNs; credit = 0.0; winStartNs = nowNs; winMin = count; speed = 1.0
            if (growPending) {
                growPending = false
                onEvent((if (dryGapS > 0) "rtl_tcp: link stalled %.1f s, ".format(dryGapS) else "rtl_tcp: ") +
                    "ran dry (rebuffer %d), buffer target up to %.1f s".format(rebuffers, targetS))
            }
            return@synchronized 0
        }
        val dt = (nowNs - lastNs).coerceAtLeast(0L); lastNs = nowNs
        winMin = minOf(winMin, count)
        // A burst lifts the backlog for a moment and the gap after it takes it back, so only the low point over a
        // window says how deep the buffer really is; it is steered toward the target a little at a time.
        if (nowNs - winStartNs >= WINDOW_NS) {
            val err = winMin.toDouble() / bps - targetS
            speed = if (kotlin.math.abs(err) < DEADBAND_S) 1.0 else (1.0 + err * STEER_GAIN).coerceIn(MIN_SPEED, MAX_SPEED)
            winStartNs = nowNs; winMin = count
            if (targetS > PREBUFFER_S && nowNs - cleanSinceNs >= CLEAN_NS) {
                targetS = maxOf(PREBUFFER_S, targetS - DECAY_STEP_S); cleanSinceNs = nowNs
                onEvent("rtl_tcp: link steady, buffer target down to %.1f s".format(targetS))
            }
        }
        // only a backlog far past anything a stall explains is cut, at a chunk boundary, back to the target
        if (count > bps * CUT_S) {
            val keep = (bps * targetS).toLong()
            val drop = ((count - keep) / chunk * chunk).toInt()
            if (drop > 0) {
                head = (head + drop) % ring.size; count -= drop
                if (cutBytes == 0L) onEvent("rtl_tcp: %.1f s backlog, cut back to %.1f s".format((count + drop).toDouble() / bps, targetS))
                cutBytes += drop
            }
        }
        // a late wake-up is made up for, but never by more than a tenth of a second at once
        credit = minOf(credit + dt * 1e-9 * bps * speed, maxOf(bps / 10.0, chunk.toDouble()))
        var n = 0
        while (credit >= chunk && n < outs.size) {
            if (count < chunk) {
                playing = false; refillToTarget = true; credit = 0.0; rebuffers++
                cleanSinceNs = nowNs; growPending = true; dryGapS = 0.0
                grow(targetS + REBUFFER_STEP_S)
                break
            }
            val out = outs[n]
            val first = minOf(chunk, ring.size - head)
            System.arraycopy(ring, head, out, 0, first)
            if (first < chunk) System.arraycopy(ring, 0, out, first, chunk - first)
            head = (head + chunk) % ring.size; count -= chunk
            credit -= chunk; deliveredBytes += chunk
            n++
        }
        n
    }

    companion object {
        const val PREBUFFER_S = 0.3
        const val MAX_TARGET_S = 2.5
        /** No data for this long is a stall, and the target is raised to cover it. */
        const val STALL_S = 0.5
        const val MARGIN_S = 0.4
        const val REBUFFER_STEP_S = 0.2
        const val DECAY_STEP_S = 0.25
        const val CLEAN_NS = 60_000_000_000L
        const val MIN_SPEED = 0.98
        const val MAX_SPEED = 1.02
        /** Speed off real time per second of error, and the error left alone. */
        const val STEER_GAIN = 0.2
        const val DEADBAND_S = 0.05
        const val CUT_S = 6.0
        const val CAPACITY_S = 7.0
        const val WINDOW_NS = 2_000_000_000L
    }
}
