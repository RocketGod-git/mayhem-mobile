package com.rocketgod.mayhem

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * In-memory diagnostic log (plus logcat, tag "Mayhem"). Every USB control transfer, the once-per-second RX
 * health line (iqRMS / DC / peak bin — the diagnostic that proved the HackRF Pro quarter-shift bug) and the
 * ADS-B decode-health counters land here, and the UI can show the tail on screen so a phone in the field
 * needs no adb to tell "front-end delivering nothing" from "signal present, decoder unhappy".
 *
 * A log is only useful to whoever receives it if it says what produced it, so every dump and every shared
 * file starts with [header]: app version and build, Android version, device, and the radio that was attached.
 * Without that a pasted log is a wall of timestamps with no way to reproduce anything.
 */
object Diag {
    private const val MAX_LINES = 4000
    private val buf = ArrayDeque<String>()
    private val fmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
    private val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)
    private val _lines = MutableStateFlow<List<String>>(emptyList())

    /** Newest-last snapshot of the buffer; observed by the on-screen log panel. */
    val lines: StateFlow<List<String>> = _lines.asStateFlow()

    fun log(s: String) {
        Log.i("Mayhem", s)
        synchronized(buf) {
            buf.addLast(fmt.format(Date()) + " " + s)
            while (buf.size > MAX_LINES) buf.removeFirst()
            _lines.value = buf.toList()
        }
    }

    fun clear() = synchronized(buf) { buf.clear(); _lines.value = emptyList() }

    /** Everything a reader needs to place this log, as plain lines. */
    fun header(): List<String> = listOf(
        "Mayhem Mobile ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) · build ${BuildConfig.GIT_SHA}",
        "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) · ${Build.MANUFACTURER} ${Build.MODEL}",
        "ABI ${Build.SUPPORTED_ABIS.firstOrNull() ?: "?"} · captured ${SimpleDateFormat("yyyy-MM-dd HH:mm:ss z", Locale.US).format(Date())}",
        "Radio " + com.rocketgod.mayhem.core.Radio.label.ifEmpty { "none attached" },
        "Lines ${synchronized(buf) { buf.size }} of $MAX_LINES" +
            if (synchronized(buf) { buf.size } >= MAX_LINES) " (oldest dropped)" else "",
    )

    fun dump(): String = (header() + "" + synchronized(buf) { buf.toList() }).joinToString("\n")

    /** Writes the dump into the cache so it can be handed to the share sheet through the FileProvider. */
    fun writeShareFile(ctx: Context): File {
        val dir = File(ctx.cacheDir, "logs").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }   // one at a time; these are throwaway
        return File(dir, "mayhem-${stamp.format(Date())}.log").apply { writeText(dump()) }
    }

    /**
     * Saves the dump where the user can find it later. Downloads via MediaStore needs no permission on
     * Android 10+; below that there is no unprivileged path into a shared folder, so it lands in the app's
     * own external files directory and the caller reports that path instead.
     */
    fun saveToDownloads(ctx: Context): String? = runCatching {
        val name = "mayhem-${stamp.format(Date())}.log"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, "text/plain")
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return@runCatching null
            ctx.contentResolver.openOutputStream(uri)?.use { it.write(dump().toByteArray()) }
            "Downloads/$name"
        } else {
            val f = File(ctx.getExternalFilesDir(null), name)
            f.writeText(dump())
            f.absolutePath
        }
    }.getOrNull()
}
