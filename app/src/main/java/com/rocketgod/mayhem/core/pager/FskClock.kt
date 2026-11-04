package com.rocketgod.mayhem.core.pager

/**
 * Symbol recovery for pager FSK on FM-discriminator samples. A fractional phase accumulator runs at [baud]; every
 * level crossing pulls it so crossings land on symbol edges, and each symbol is the average of its middle 60%, so
 * one noisy sample can't flip it. The carrier's frequency error is a slow DC on the discriminator, tracked here
 * and removed. [push] returns true when a symbol finished; its value is [value] (DC removed).
 */
class FskClock(private val fs: Double, baud: Int) {
    var baud: Int = baud
        set(v) { field = v; step = v / fs }
    private var step = baud / fs
    private var phase = 0.0
    private var sum = 0.0
    private var n = 0
    private var prev = 0.0
    var dc = 0.0; private set
    /** Lower once a decoder has locked: the loop then holds timing through runs of identical symbols. */
    var gain = HUNT_GAIN
    /** DC tracking speed per sample; decoders freeze it (0) inside data so long runs don't drag the slicer. */
    var dcRate = 1.0 / (0.08 * fs)
    var value = 0.0; private set

    // Crossings are found on a short moving average (a quarter symbol): raw discriminator noise crosses zero far
    // more often than the data does.
    private val ring = DoubleArray(64)
    private var rp = 0
    private var rsum = 0.0
    private var lastLen = 0

    fun push(x: Float): Boolean {
        dc += (x - dc) * dcRate
        val v = x - dc
        val len = (fs / baud / 4).toInt().coerceIn(1, ring.size - 1)
        if (len != lastLen) { lastLen = len; rsum = 0.0; for (k in 1 until len) rsum += ring[(rp - k + ring.size) % ring.size] }
        else rsum -= ring[(rp - len + ring.size) % ring.size]
        rsum += v
        ring[rp] = v; rp = (rp + 1) % ring.size
        val sm = rsum / len
        if ((prev < 0.0) != (sm < 0.0)) {
            // A crossing belongs on a symbol edge; the smoothing delays it by half its length. Nudge toward the near
            // edge. Once locked, crossings that land mid-symbol are noise, not data, and are ignored; while still
            // hunting every crossing counts, or a clock that starts half a symbol off could never pull in.
            var err = phase - (len - 1) / 2.0 * step
            if (err < -0.5) err += 1.0 else if (err >= 0.5) err -= 1.0
            if (gain >= HUNT_GAIN || (err > -0.4 && err < 0.4)) phase -= err * gain
        }
        prev = sm
        if (phase > 0.2 && phase < 0.8) { sum += v; n++ }
        phase += step
        if (phase >= 1.0) {
            phase -= 1.0
            value = if (n > 0) sum / n else v
            sum = 0.0; n = 0
            return true
        }
        return false
    }

    companion object {
        /** Loop gain while hunting; decoders drop to [LOCK_GAIN] once they have a sync. */
        const val HUNT_GAIN = 0.08
        const val LOCK_GAIN = 0.03
    }
}
