package com.rocketgod.mayhem.core

import com.rocketgod.mayhem.model.Aircraft
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.ConcurrentHashMap

/**
 * Live aircraft store fed by [AdsbDecoder]. Aircraft age out 60 s after their last frame. Observed by the UI.
 * (Wardrive Go's version also banks positions for upload; that is app-specific and left out here.)
 */
object AdsbStore {
    private const val AGE_MS = 60_000L

    private val planes = ConcurrentHashMap<String, Aircraft>()
    private val _flow = MutableStateFlow<List<Aircraft>>(emptyList())
    /** Current aircraft, oldest-first (stable order). */
    val flow: StateFlow<List<Aircraft>> = _flow.asStateFlow()

    // Raw decoded-frame counter — proof the SDR is actively INGESTING Mode-S even before any aircraft has a
    // full position (a plane needs a matched even+odd pair or a GPS reference). Surfaced in the UI.
    private val _frames = MutableStateFlow(0L)
    val frames: StateFlow<Long> = _frames.asStateFlow()
    fun noteFrame() { _frames.value = _frames.value + 1 }

    /** Merge a decoder batch (newest field values win), age out stale aircraft, publish. */
    fun merge(batch: Map<String, Aircraft>, nowMs: Long) {
        for ((icao, a) in batch) {
            val cur = planes.getOrPut(icao) { Aircraft(icao).also { it.firstSeenMs = nowMs } }
            a.flight?.let { cur.flight = it }
            a.lat?.let { cur.lat = it }
            a.lon?.let { cur.lon = it }
            a.altBaro?.let { cur.altBaro = it }
            a.gs?.let { cur.gs = it }
            a.track?.let { cur.track = it }
            a.vertRate?.let { cur.vertRate = it }
            a.squawk?.let { cur.squawk = it }
            if (a.lastTs > cur.lastTs) cur.lastTs = a.lastTs
            cur.seenAtMs = nowMs
        }
        planes.values.removeIf { nowMs - it.seenAtMs > AGE_MS }
        _flow.value = planes.values.sortedBy { it.firstSeenMs }
    }

    fun clear() {
        planes.clear()
        _flow.value = emptyList()
        _frames.value = 0L
    }
}
