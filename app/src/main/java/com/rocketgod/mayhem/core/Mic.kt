package com.rocketgod.mayhem.core

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import com.rocketgod.mayhem.Diag

/** The phone's microphone at 48 kHz for push-to-talk, buffered in a ring the transmitter drains sample by sample. */
object Mic {
    const val RATE = 48_000
    private val ring = FloatArray(RATE * 2)
    @Volatile private var r = 0
    @Volatile private var w = 0
    @Volatile private var running = false
    private var rec: AudioRecord? = null
    private var thread: Thread? = null

    fun granted(ctx: Context) = ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission")
    fun start(ctx: Context): Boolean {
        if (running) { r = w; return true }
        if (!granted(ctx)) return false
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val a = runCatching {
            AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT, maxOf(min, 9600))
        }.getOrNull()
        if (a == null || a.state != AudioRecord.STATE_INITIALIZED) { Diag.log("mic: could not open"); a?.release(); return false }
        rec = a; r = 0; w = 0; running = true
        a.startRecording()
        thread = Thread({
            val buf = FloatArray(960)
            while (running) {
                val n = a.read(buf, 0, buf.size, AudioRecord.READ_BLOCKING)
                if (n <= 0) continue
                var wp = w
                for (i in 0 until n) { ring[wp] = buf[i]; wp = (wp + 1) % ring.size }
                w = wp
            }
        }, "mic").apply { isDaemon = true; start() }
        return true
    }

    fun stop() {
        running = false
        thread?.join(300); thread = null
        rec?.runCatching { stop(); release() }; rec = null
    }

    /** Next sample, or 0 when the transmitter has caught up with the microphone. */
    fun read(): Float {
        val rp = r
        if (rp == w) return 0f
        val v = ring[rp]; r = (rp + 1) % ring.size
        return v
    }
}
