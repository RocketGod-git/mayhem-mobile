package com.rocketgod.mayhem.core.ham

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The live picture shared by SSTV (HAM DIGITAL and Satellites), NOAA APT and Meteor LRPT. Decoders write rows on
 * the DSP thread; the screen redraws when [version] moves. A resize swaps in a new [Frame] whole, so a reader
 * never sees a half-grown buffer.
 */
object Picture {
    class Frame(val width: Int, val height: Int) { val argb = IntArray(width * height) { 0xFF000000.toInt() } }

    @Volatile var frame = Frame(320, 240); private set
    private val _version = MutableStateFlow(0)
    val version: StateFlow<Int> = _version.asStateFlow()
    private val _caption = MutableStateFlow("waiting for a picture")
    val caption: StateFlow<String> = _caption.asStateFlow()
    @Volatile var mode = ""; private set
    private var line = 0
    private var aptLines = 0
    // LRPT: one gray plane per APID, composited into the frame strip by strip
    private const val LRPT_W = 1568
    private val planes = HashMap<Int, ByteArray>()
    private var lrptLines = 0
    @Volatile var lrptStats = ""

    fun reset() {
        mode = ""; line = 0; aptLines = 0; planes.clear(); lrptLines = 0; lrptStats = ""
        frame = Frame(320, 240); _caption.value = "waiting for a picture"; _version.value++
    }

    fun onSstv(r: SstvRows) {
        if (mode != r.mode || frame.width != r.width || r.line == 0) { mode = r.mode; frame = Frame(r.width, r.height) }
        val f = frame
        System.arraycopy(r.argb, 0, f.argb, r.line * f.width, minOf(r.argb.size, f.argb.size - r.line * f.width))
        line = r.line + r.count
        _caption.value = "SSTV ${r.mode} · ${r.width}×${r.height} · line $line${if (line >= r.height) " · complete" else ""}"
        _version.value++
    }

    fun onApt(row: IntArray, index: Int) {
        if (mode != "APT" || index == 0) { mode = "APT"; aptLines = 0; frame = Frame(APT_LINE, 400) }
        var f = frame
        if (aptLines >= f.height) {
            val g = Frame(APT_LINE, f.height + 400); System.arraycopy(f.argb, 0, g.argb, 0, f.argb.size); frame = g; f = g
        }
        val o = aptLines * APT_LINE
        for (k in 0 until APT_LINE) { val v = row[k]; f.argb[o + k] = (0xFF shl 24) or (v shl 16) or (v shl 8) or v }
        aptLines++
        _caption.value = "APT · $aptLines lines · channel A left, B right"
        _version.value++
    }

    /** One 8-row, 112-pixel strip of one spectral channel; the frame shows red 66/68, green 65/67, blue 64. */
    fun onLrpt(apid: Int, stripLine: Int, x: Int, px: ByteArray) {
        if (mode != "LRPT") { mode = "LRPT"; planes.clear(); lrptLines = 0; frame = Frame(LRPT_W, 256) }
        val need = (stripLine + 1) * 8 * LRPT_W
        var plane = planes[apid]
        if (plane == null || plane.size < need) {
            val np = ByteArray(maxOf(need, (plane?.size ?: 0) * 2, 64 * 8 * LRPT_W)); plane?.copyInto(np); planes[apid] = np; plane = np
        }
        for (y in 0 until 8) System.arraycopy(px, y * 112, plane, (stripLine * 8 + y) * LRPT_W + x, 112)
        if (stripLine + 1 > lrptLines) lrptLines = stripLine + 1
        var f = frame
        if (f.height < lrptLines * 8) {
            val g = Frame(LRPT_W, lrptLines * 8 + 256); System.arraycopy(f.argb, 0, g.argb, 0, f.argb.size); frame = g; f = g
        }
        val r = planes[66] ?: planes[68] ?: plane; val gr = planes[65] ?: planes[67] ?: plane; val b = planes[64] ?: plane
        for (y in 0 until 8) for (k in 0 until 112) {
            val src = (stripLine * 8 + y) * LRPT_W + x + k
            fun at(p: ByteArray) = if (src < p.size) p[src].toInt() and 0xff else 0
            f.argb[(stripLine * 8 + y) * LRPT_W + x + k] = (0xFF shl 24) or (at(r) shl 16) or (at(gr) shl 8) or at(b)
        }
        _caption.value = "LRPT · $lrptLines lines · channels ${planes.keys.sorted().joinToString(", ")}${if (lrptStats.isNotEmpty()) " · $lrptStats" else ""}"
        _version.value++
    }

    fun lrptStatus(s: String) {
        lrptStats = s
        if (mode != "SSTV" && mode != "APT") _caption.value = "LRPT · $lrptLines lines · $s"
    }

    /** The rows that hold picture so far (APT and LRPT grow downward), for saving. */
    fun usedHeight(): Int = when (mode) {
        "APT" -> maxOf(1, aptLines)
        "LRPT" -> maxOf(1, lrptLines * 8)
        else -> frame.height
    }
}
