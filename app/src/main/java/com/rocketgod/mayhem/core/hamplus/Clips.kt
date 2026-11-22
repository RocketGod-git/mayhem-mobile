package com.rocketgod.mayhem.core.hamplus

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/*
 * HAM+ time machine: every transmission's audio kept in memory as 8 kHz G.711 mu-law (8 kB a second of air), oldest
 * dropped first once the store passes its cap, and replays planned from it: one transmission, one conversation in
 * order, or the whole band from a moment on with overlapping transmissions mixed and long silences shortened.
 */

const val CLIP_RATE = 8_000
/** The store's cap: 24 MB is about 50 minutes of air. */
const val CLIP_CAP_BYTES = 24 * 1024 * 1024
/** A replay from a moment on shortens any silence longer than this to it. */
const val GAP_MAX_MS = 1_500.0

/** G.711 mu-law (ITU-T G.711), input in [-1, 1]. */
fun muEncode(x: Double): Int {
    var s = (max(-1.0, min(1.0, x)) * 32_635).roundToInt()
    val sign = if (s < 0) 0x80 else 0
    if (s < 0) s = -s
    s += 0x84
    var exp = 7
    var m = 0x4000
    while ((s and m) == 0 && exp > 0) { exp--; m = m shr 1 }
    val mant = (s shr (exp + 3)) and 0x0f
    return (sign or (exp shl 4) or mant).inv() and 0xff
}

private val MU_TABLE = FloatArray(256) { i ->
    val u = i.inv() and 0xff
    val sign = u and 0x80; val exp = (u shr 4) and 7; val mant = u and 0x0f
    val v = (((mant shl 3) + 0x84) shl exp) - 0x84
    (if (sign != 0) -v else v) / 32_635f
}

fun muDecode(b: Int): Float = MU_TABLE[b and 0xff]

/** One transmission's audio as it grows. */
class ClipWriter {
    private var buf = ByteArray(CLIP_RATE * 4)
    var len = 0; private set
    fun push(x: FloatArray, n: Int) {
        if (len + n > buf.size) buf = buf.copyOf(max(buf.size * 2, len + n))
        for (i in 0 until n) buf[len++] = muEncode(x[i].toDouble()).toByte()
    }
    fun done(): ByteArray = buf.copyOf(len)
}

class Clip(val id: Int, val chan: Long, val startMs: Double, val data: ByteArray)

class ClipStore(val cap: Int = CLIP_CAP_BYTES) {
    private val clips = LinkedHashMap<Int, Clip>()
    var bytes = 0L; private set

    fun add(c: Clip): List<Int> {
        clips.remove(c.id)?.let { bytes -= it.data.size }
        clips[c.id] = c; bytes += c.data.size
        val dropped = ArrayList<Int>()
        // insertion order: the first ones are the oldest
        val it = clips.entries.iterator()
        while (it.hasNext() && bytes > cap) { val e = it.next(); it.remove(); bytes -= e.value.data.size; dropped.add(e.key) }
        return dropped
    }
    fun get(id: Int): Clip? = clips[id]
    fun has(id: Int): Boolean = clips.containsKey(id)
    val size: Int get() = clips.size
    /** Seconds of audio held. */
    val seconds: Double get() = bytes.toDouble() / CLIP_RATE
    fun oldestMs(): Double = clips.values.firstOrNull()?.startMs ?: 0.0
    fun all(): List<Clip> = clips.values.toList()
    fun clear() { clips.clear(); bytes = 0 }
}

/** Where each clip of a replay starts, in samples from the replay's start. */
data class ReplayPart(val id: Int, val at: Int)

/** A kept clip's place in time, for [replayFromPlan]. */
data class ClipSpan(val id: Int, val startMs: Double, val endMs: Double)

/**
 * What a tap on the timeline at [ms] replays: every clip still on the air after that moment, or, when nothing was
 * heard after it, the band from the start of the last transmission before it. Empty only when nothing is kept.
 */
fun replayFromPlan(clips: List<ClipSpan>, ms: Double): Pair<List<Int>, Double> {
    if (clips.isEmpty()) return emptyList<Int>() to ms
    val from = if (clips.any { it.endMs > ms }) ms else clips.maxBy { it.endMs }.startMs
    return clips.filter { it.endMs > from }.sortedBy { it.startMs }.map { it.id } to from
}

/**
 * Plans a replay: clips in time order, each placed at its true time after the first, with every silence longer than
 * [gapMaxMs] cut to it. Clips that overlapped on the air overlap in the replay (and are mixed).
 */
fun planReplay(clips: List<Clip>, gapMaxMs: Double = GAP_MAX_MS): List<ReplayPart> {
    val cs = clips.sortedBy { it.startMs }
    val out = ArrayList<ReplayPart>()
    var shift = 0.0; var endMs = Double.NEGATIVE_INFINITY
    val t0 = if (cs.isNotEmpty()) cs[0].startMs else 0.0
    for (c in cs) {
        val gap = c.startMs - endMs
        if (gap > gapMaxMs) shift += gap - gapMaxMs
        if (out.isEmpty()) shift = 0.0
        out.add(ReplayPart(c.id, ((c.startMs - t0 - shift) * CLIP_RATE / 1000).roundToInt()))
        endMs = max(endMs, c.startMs + c.data.size * 1000.0 / CLIP_RATE)
    }
    return out
}

class MixPart(val id: Int, val at: Int, val data: ByteArray)

/** Mixes a planned replay into 8 kHz audio, a block at a time. */
class ReplayMixer(private val parts: List<MixPart>, private val gain: Double = 1.0) {
    var pos = 0; private set
    val total: Int = parts.fold(0) { m, p -> max(m, p.at + p.data.size) }
    val done: Boolean get() = pos >= total
    private var cnt = IntArray(0)

    /** The id of the clip playing at the replay's position (the latest started), or -1. */
    fun current(): Int {
        var id = -1; var at = -1
        for (p in parts) if (p.at <= pos && p.at + p.data.size > pos && p.at > at) { at = p.at; id = p.id }
        return id
    }

    fun next(out: FloatArray, n: Int): Int {
        val k = min(n, total - pos)
        if (k <= 0) return 0
        out.fill(0f, 0, k)
        if (cnt.size < k) cnt = IntArray(k)
        cnt.fill(0, 0, k)
        for (p in parts) {
            val a = max(pos, p.at); val b = min(pos + k, p.at + p.data.size)
            for (t in a until b) { out[t - pos] += muDecode(p.data[t - p.at].toInt()); cnt[t - pos]++ }
        }
        // overlapping voices are scaled by the square root of how many play at that moment
        for (i in 0 until k) {
            val v = out[i] * gain / (if (cnt[i] > 1) sqrt(cnt[i].toDouble()) else 1.0)
            out[i] = (if (v > 1) 1.0 else if (v < -1) -1.0 else v).toFloat()
        }
        pos += k
        return k
    }
}
