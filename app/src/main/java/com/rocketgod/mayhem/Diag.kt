package com.rocketgod.mayhem

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * In-memory diagnostic log (plus logcat, tag "Mayhem"). Every USB control transfer, the once-per-second RX
 * health line (iqRMS / DC / peak bin — the diagnostic that proved the HackRF Pro quarter-shift bug) and the
 * ADS-B decode-health counters land here, and the UI can show the tail on screen so a phone in the field
 * needs no adb to tell "front-end delivering nothing" from "signal present, decoder unhappy".
 */
object Diag {
    private const val MAX_LINES = 400
    private val buf = ArrayDeque<String>()
    private val fmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)
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

    fun dump(): String = synchronized(buf) { buf.joinToString("\n") }
}
