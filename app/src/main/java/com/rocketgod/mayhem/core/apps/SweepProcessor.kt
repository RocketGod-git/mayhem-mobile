package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.Dsp
import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.SdrEngine
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.ceil

/**
 * Wideband sweep (Mayhem Looking Glass / Search): steps the HackRF across [startHz]..[endHz] one IQ-bandwidth
 * slice at a time, takes one FFT per slice after the retune settles, and publishes the stitched power row (dB,
 * [BINS] values per slice) at the end of each sweep. Search runs on the same rows.
 */
class SweepProcessor(val startHz: Long, val endHz: Long, val sliceHz: Int) : IqProcessor {
    val steps: Int = ceil((endHz - startHz).toDouble() / sliceHz).toInt().coerceAtLeast(1)
    private val re = FloatArray(1024); private val im = FloatArray(1024)
    private val slice = FloatArray(BINS)
    private val work = FloatArray(steps * BINS)
    private var step = 0
    private var settle = 0

    private val _row = MutableStateFlow(FloatArray(0))
    /** Latest complete sweep: steps × BINS dB values, low → high frequency. */
    val row: StateFlow<FloatArray> = _row.asStateFlow()
    private val _progress = MutableStateFlow(0)
    val progress: StateFlow<Int> = _progress.asStateFlow()
    private val _sweeps = MutableStateFlow(0)
    val sweeps: StateFlow<Int> = _sweeps.asStateFlow()

    fun centerOf(i: Int): Long = startHz + sliceHz / 2 + i.toLong() * sliceHz
    /** Frequency of a bin index into a [row]. */
    fun freqOfBin(idx: Int): Long = startHz + (idx.toLong() * sliceHz) / BINS

    override fun reset(rate: Int) {
        step = 0
        settle = 8
        SdrEngine.tune(centerOf(0))
    }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (settle > 0) { settle--; return }
        val nSamp = len / 2
        Dsp.loadIq(iq, nSamp, re, im)
        Dsp.fft(re, im)
        Dsp.powerDb(re, im, slice)
        // The HackRF's DC spike sits in the centre bins: replace with the neighbours.
        val c = BINS / 2
        slice[c] = (slice[c - 2] + slice[c + 2]) * 0.5f
        slice[c - 1] = slice[c - 2]
        slice[c + 1] = slice[c + 2]
        System.arraycopy(slice, 0, work, step * BINS, BINS)
        step++
        if (step >= steps) {
            step = 0
            _row.value = work.copyOf()
            _sweeps.value = _sweeps.value + 1
        }
        _progress.value = step
        SdrEngine.tune(centerOf(step))
        // Retune settle: the driver sleeps ~50 ms after a tune and the USB pipeline holds ~12 buffers of stale IQ.
        val bufMs = nSamp * 1000.0 / rate
        settle = ceil(SETTLE_MS / bufMs).toInt().coerceIn(2, 500)
    }

    companion object {
        const val BINS = 256
        private const val SETTLE_MS = 130.0
    }
}
