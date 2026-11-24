package com.rocketgod.mayhem.net

/**
 * A jitter buffer between an rtl_tcp socket and the engine. rtl_tcp sends in bursts (measured from a wired PC: 2 to
 * 16 MB/s in 250 ms slices around the 4.8 MB/s that 2.4 Msps needs), and Wi-Fi adds its own. The engine expects
 * samples the way a USB dongle delivers them, steadily, so its queue and the audio writer drop on a burst and
 * underrun on a gap. The reader [write]s whatever arrives; [tick], called every few milliseconds on its own
 * thread, hands the engine [chunk]-byte pieces at the nominal rate (2 bytes a sample) on a steady clock:
 *
 *  - It starts once [PREBUFFER_S] is buffered, and if it runs dry it waits for that much again (a rebuffer). Each
 *    rebuffer adds a tenth of a second to what it waits for, up to [MAX_PREBUFFER_S], so a link with longer gaps
 *    gets the margin it needs and a steady one keeps the short delay.
 *  - When the backlog's lowest point over two seconds stays above the prebuffer (the server ran ahead, or the delay
 *    a burst left behind), it releases faster, half again as fast when it is far behind and a few percent when it is
 *    a little behind, until the delay is back to the prebuffer, rather than throwing samples away. A backlog near
 *    [HIGH_S] is caught up at once.
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
    private var out = ByteArray(chunk)

    private var playing = false
    private var lastNs = 0L
    private var credit = 0.0
    private var draining = false
    private var trimming = false
    private var winStartNs = 0L
    private var winMin = Int.MAX_VALUE
    /** Seconds buffered before playing starts; grows with each rebuffer, kept across resets (it is the link's). */
    @Volatile var prebufferS = PREBUFFER_S; private set

    /** Times it ran dry while playing and had to wait for [PREBUFFER_S] again. */
    @Volatile var rebuffers = 0; private set
    /** Bytes thrown away because the buffer was full (it holds [CAPACITY_S]); should stay 0. */
    @Volatile var overflowBytes = 0L; private set
    @Volatile var deliveredBytes = 0L; private set
    /** How far behind the radio the engine is right now: what is buffered, in seconds. */
    val latencyS: Double get() = synchronized(lock) { if (bps > 0) count.toDouble() / bps else 0.0 }

    /** Start over at [rateHz]: everything buffered is from the old tuning or rate, so it goes. */
    fun reset(rateHz: Int) = synchronized(lock) {
        val b = rateHz.toLong() * 2
        if (b != bps) {
            bps = b
            ring = ByteArray(((b * CAPACITY_S).toLong().coerceIn(1L shl 16, 64L shl 20) and 1L.inv()).toInt())
            chunk = if (b >= 3_200_000L) 65536 else 16384
            out = ByteArray(chunk)
        }
        head = 0; count = 0; playing = false; credit = 0.0; draining = false; trimming = false; winMin = Int.MAX_VALUE; winStartNs = 0L
    }

    /** Samples from the socket, whole I/Q pairs. */
    fun write(b: ByteArray, n: Int) = synchronized(lock) {
        if (ring.isEmpty() || n <= 0) return@synchronized
        var off = 0; var len = n
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

    /** Hand the engine what is due at [nowNs]; returns the chunks handed over. */
    fun tick(nowNs: Long): Int = synchronized(lock) {
        if (bps == 0L) return@synchronized 0
        if (!playing) {
            if (count < bps * prebufferS) return@synchronized 0
            playing = true; lastNs = nowNs; credit = 0.0; winStartNs = nowNs; winMin = count
            return@synchronized 0
        }
        val dt = (nowNs - lastNs).coerceAtLeast(0L); lastNs = nowNs
        // the backlog's low point over a few seconds is the delay a burst does not explain
        winMin = minOf(winMin, count)
        // A burst lifts the backlog for a moment and the gap after it takes it back, so a high level on its own says
        // nothing; only a low point that stays high is delay to shed. Shedding it fast or slow is decided once a window.
        if (nowNs - winStartNs >= WINDOW_NS) {
            val low = winMin.toDouble() / bps
            val wasDraining = draining
            draining = low > prebufferS + DRAIN_ABOVE_S
            trimming = !draining && (low > prebufferS + TRIM_ABOVE_S || ((trimming || wasDraining) && low > prebufferS + 0.05))
            if (draining && !wasDraining) onEvent("rtl_tcp: %.2f s behind, catching up".format(low))
            winStartNs = nowNs; winMin = count
        }
        // close to full (the server ran far ahead): shed it now, before anything is lost
        if (count > bps * HIGH_S && !draining) { draining = true; onEvent("rtl_tcp: %.2f s buffered, catching up".format(count.toDouble() / bps)) }
        // never faster than the clock once the backlog is down to the prebuffer
        val speed = if (count <= bps * prebufferS) 1.0 else if (draining) DRAIN_SPEED else if (trimming) TRIM_SPEED else 1.0
        // a late wake-up is made up for, but never by more than a tenth of a second at once
        credit = minOf(credit + dt * 1e-9 * bps * speed, maxOf(bps / 10.0, chunk.toDouble()))
        var n = 0
        while (credit >= chunk) {
            if (count < chunk) {
                playing = false; credit = 0.0; rebuffers++
                prebufferS = minOf(prebufferS + 0.1, MAX_PREBUFFER_S)
                onEvent("rtl_tcp: ran dry, waiting for %.1f s of samples (rebuffer %d)".format(prebufferS, rebuffers))
                break
            }
            val first = minOf(chunk, ring.size - head)
            System.arraycopy(ring, head, out, 0, first)
            if (first < chunk) System.arraycopy(ring, 0, out, first, chunk - first)
            head = (head + chunk) % ring.size; count -= chunk
            credit -= chunk; deliveredBytes += chunk
            sink(out, chunk)
            n++
        }
        n
    }

    companion object {
        const val PREBUFFER_S = 0.3
        /** Buffered past this, it catches up at once ([CAPACITY_S] is the most it holds). */
        const val HIGH_S = 2.0
        /** Catch up fast when the backlog's low point stays this far above the prebuffer. */
        const val DRAIN_ABOVE_S = 0.6
        const val MAX_PREBUFFER_S = 0.7
        /** Trim when the backlog's low point stays this far above the prebuffer. */
        const val TRIM_ABOVE_S = 0.15
        const val CAPACITY_S = 3.0
        const val DRAIN_SPEED = 1.5
        const val TRIM_SPEED = 1.03
        const val WINDOW_NS = 2_000_000_000L
    }
}
