package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.IqProcessor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * IQ capture (Mayhem proc_capture / Capture app): writes the raw stream as signed 8-bit interleaved I/Q (`.c8`,
 * the HackRF's native `hackrf_transfer` format) plus a Mayhem-style `.txt` sidecar with sample_rate and
 * center_frequency. A writer thread drains a queue so the DSP thread never blocks on flash.
 */
class IqRecorder(private val dir: File) : IqProcessor {
    private val queue = LinkedBlockingQueue<ByteArray>(64)
    @Volatile private var out: OutputStream? = null
    private var thread: Thread? = null
    private val _bytes = MutableStateFlow(0L)
    val bytes: StateFlow<Long> = _bytes.asStateFlow()
    private val _file = MutableStateFlow<String?>(null)
    val file: StateFlow<String?> = _file.asStateFlow()
    private val _dropped = MutableStateFlow(0)
    val dropped: StateFlow<Int> = _dropped.asStateFlow()
    val recording: Boolean get() = out != null

    fun start(freqHz: Long, rate: Int) {
        stop()
        dir.mkdirs()
        val ts = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val base = "${ts}_${"%.3f".format(freqHz / 1e6)}MHz_${rate / 1000}k"
        File(dir, "$base.txt").writeText("sample_rate=$rate\ncenter_frequency=$freqHz\nformat=c8 (signed int8 I,Q)\n")
        val f = File(dir, "$base.c8")
        val o = BufferedOutputStream(FileOutputStream(f), 1 shl 20)
        out = o
        _file.value = f.name
        _bytes.value = 0L
        _dropped.value = 0
        queue.clear()
        thread = Thread({ writer(o) }, "iq-writer").apply { isDaemon = true; start() }
        Diag.log("capture: recording to ${f.absolutePath}")
    }

    fun stop() {
        if (out == null) return
        out = null
        thread?.join(3000)
        thread = null
        Diag.log("capture: stopped, ${_bytes.value} bytes, ${_dropped.value} dropped buffers")
    }

    fun listCaptures(): List<String> =
        captureFiles().map { "%s  %.1f MB".format(it.name, it.length() / 1e6) }

    /** Recordings, newest first. */
    fun captureFiles(): List<File> =
        (dir.listFiles() ?: emptyArray()).filter { it.name.endsWith(".c8") }.sortedByDescending { it.lastModified() }

    /** The recording and its .txt sidecar. */
    fun filesOf(c8: File): List<File> = listOf(c8, File(c8.parentFile, c8.name.removeSuffix(".c8") + ".txt")).filter { it.exists() }

    fun delete(c8: File) { filesOf(c8).forEach { it.delete() } }

    val directory: String get() = dir.absolutePath

    override fun reset(rate: Int) {}

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        if (out == null) return
        val c = ByteArray(len)
        for (i in 0 until len) c[i] = (iq[i].toInt() xor 0x80).toByte()   // offset-128 → signed int8
        if (!queue.offer(c)) _dropped.value = _dropped.value + 1
    }

    private fun writer(o: OutputStream) {
        try {
            while (true) {
                val b = queue.poll(200, TimeUnit.MILLISECONDS)
                if (b == null) { if (out == null) break else continue }
                o.write(b)
                _bytes.value = _bytes.value + b.size
            }
            while (true) { val b = queue.poll() ?: break; o.write(b); _bytes.value = _bytes.value + b.size }
        } catch (t: Throwable) {
            Diag.log("capture write error: ${t.message}")
        } finally {
            runCatching { o.flush() }; runCatching { o.close() }
        }
    }
}
