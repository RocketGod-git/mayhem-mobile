package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.usb.HackRfOne
import com.rocketgod.mayhem.usb.RtlSdr
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.log10
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Wideband sweep (Mayhem Looking Glass / Search): steps the radio across [startHz]..[endHz] one IQ-bandwidth slice
 * at a time. After each retune settles, every 1024-point frame of a buffer is power-averaged into [BINS] bins and
 * the inner [KEEP] of them are kept: the baseband filter rolls the outer bins off, so slices step by the kept width
 * and overlap with no seam. Each slice is published as it is measured ([live]) and the stitched row once a pass
 * completes ([row]). Search runs on the rows.
 */
class SweepProcessor(val startHz: Long, val endHz: Long, val sliceHz: Int) : IqProcessor {
    /** Distance between slice centres: the kept part of a slice. */
    val stepHz: Double = sliceHz.toDouble() * KEEP / BINS
    val binHz: Double = sliceHz.toDouble() / BINS
    val steps: Int = ceil((endHz - startHz) / stepHz).toInt().coerceAtLeast(1)
    /** How far a row reaches from [startHz]: whole steps, so up to one step past [endHz]. */
    val coverHz: Long = (steps * stepHz).toLong()
    private val re = FloatArray(FFT); private val im = FloatArray(FFT)
    private val acc = DoubleArray(FFT)
    private val win = FloatArray(FFT) { (0.5 - 0.5 * cos(2.0 * Math.PI * it / (FFT - 1))).toFloat() }
    private val slice = FloatArray(BINS)
    // NaN until a slice has been measured, so the first pass's live trace does not drag the floor down
    private val work = FloatArray(steps * KEEP) { Float.NaN }
    private var step = 0
    private var settle = 0
    /** The centre asked for and not yet confirmed by the driver; 0 once it has been. */
    private var awaiting = 0L
    private var lastLive = 0L

    private val _row = MutableStateFlow(FloatArray(0))
    /** Latest complete sweep: steps × KEEP dB values, low → high frequency. */
    val row: StateFlow<FloatArray> = _row.asStateFlow()
    private val _live = MutableStateFlow(FloatArray(0))
    /** The pass in progress, as [row] but refreshed slice by slice (NaN where nothing has been measured yet). */
    val live: StateFlow<FloatArray> = _live.asStateFlow()
    private val _progress = MutableStateFlow(0)
    val progress: StateFlow<Int> = _progress.asStateFlow()
    private val _sweeps = MutableStateFlow(0)
    val sweeps: StateFlow<Int> = _sweeps.asStateFlow()

    /** Tune so the kept part of slice [i] covers [startHz] + i·step .. + (i+1)·step. */
    fun centerOf(i: Int): Long = startHz + (stepHz / 2 + i * stepHz).toLong()
    /** Frequency of a bin index into a [row]. */
    fun freqOfBin(idx: Int): Long = startHz + (idx * binHz).toLong()

    override fun reset(rate: Int) {
        step = 0
        settle = 8
        awaiting = centerOf(0)
        SdrEngine.tune(awaiting)
    }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        // once the driver confirms the retune, only the reads already in flight are stale, not the whole settle time
        if (awaiting != 0L && (HackRfOne.appliedFreq == awaiting || RtlSdr.appliedFreq == awaiting)) { awaiting = 0L; settle = minOf(settle, INFLIGHT_STALE) }
        if (settle > 0) { settle--; return }
        val nSamp = len / 2
        acc.fill(0.0)
        var frames = 0
        var off = 0
        while (off + FFT <= nSamp) {
            for (k in 0 until FFT) {
                val j = 2 * (off + k)
                re[k] = ((iq[j].toInt() and 0xff) - 127.4f) * win[k]
                im[k] = ((iq[j + 1].toInt() and 0xff) - 127.4f) * win[k]
            }
            Dsp.fft(re, im)
            for (k in 0 until FFT) { val s = (k + FFT / 2) % FFT; acc[k] += (re[s] * re[s] + im[s] * im[s]).toDouble() }
            frames++
            off += FFT
        }
        if (frames == 0) return
        // fftshifted, averaged, peak-downsampled to BINS
        val g = FFT / BINS
        for (b in 0 until BINS) {
            var pk = 0.0
            for (j in 0 until g) { val v = acc[b * g + j]; if (v > pk) pk = v }
            slice[b] = (10.0 * log10(pk / frames + 1e-9)).toFloat()
        }
        // The DC spike sits in the centre bins: replace with the neighbours.
        val c = BINS / 2
        slice[c] = (slice[c - 2] + slice[c + 2]) * 0.5f
        slice[c - 1] = slice[c - 2]
        slice[c + 1] = slice[c + 2]
        System.arraycopy(slice, KEEP0, work, step * KEEP, KEEP)
        val now = System.currentTimeMillis()
        if (now - lastLive >= LIVE_MS) { lastLive = now; _live.value = work.copyOf() }
        step++
        if (step >= steps) {
            step = 0
            _row.value = work.copyOf()
            _sweeps.value = _sweeps.value + 1
        }
        _progress.value = step
        awaiting = centerOf(step)
        SdrEngine.tune(awaiting)
        // Retune settle: the driver sleeps ~50 ms after a tune and the USB pipeline holds ~12 buffers of stale IQ.
        val bufMs = nSamp * 1000.0 / rate
        settle = ceil(SETTLE_MS / bufMs).toInt().coerceIn(2, 500)
    }

    companion object {
        const val BINS = 512
        private const val KEEP0 = 52
        private const val KEEP1 = 460
        const val KEEP = KEEP1 - KEEP0
        private const val FFT = 1024
        private const val SETTLE_MS = 130.0
        /** Twelve bulk reads in flight in the driver, up to eight queued for the DSP thread, and the one being filled. */
        private const val INFLIGHT_STALE = 21
        /** The live trace is republished at most this often; the completed pass corrects everything. */
        private const val LIVE_MS = 110L
    }
}
