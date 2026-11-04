package com.rocketgod.mayhem.core.pager

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The PAGERS speaker: one channel's FM discriminator played as it is, so you hear the FSK of the page going by.
 * Called on the SDR's DSP thread; writes never block it (a full buffer drops the rest of the block).
 */
internal object PagerAudio {
    private const val GAIN = 9_000f   // FSK swings about ±0.6 rad on the discriminator
    private var track: AudioTrack? = null
    private var rate = 0
    private var buf = ShortArray(0)
    private var dc = 0f

    @Synchronized fun write(xs: FloatArray, n: Int, fs: Double) {
        val r = fs.roundToInt()
        if (r <= 0) return
        if (track == null || r != rate) { release(); track = open(r) ?: return; rate = r }
        if (buf.size < n) buf = ShortArray(n)
        for (i in 0 until n) {
            dc += (xs[i] - dc) * 0.001f   // the carrier's frequency offset
            buf[i] = ((xs[i] - dc) * GAIN).coerceIn(-32_767f, 32_767f).toInt().toShort()
        }
        runCatching { track?.write(buf, 0, n, AudioTrack.WRITE_NON_BLOCKING) }
    }

    @Synchronized fun release() {
        track?.let { runCatching { it.stop() }; runCatching { it.release() } }
        track = null; rate = 0; dc = 0f
    }

    private fun open(r: Int): AudioTrack? = runCatching {
        val min = AudioTrack.getMinBufferSize(r, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(r).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(max(min, r / 2 * 2))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build().also { it.play() }
    }.getOrNull()
}
