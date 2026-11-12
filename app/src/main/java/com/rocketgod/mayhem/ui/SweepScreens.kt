package com.rocketgod.mayhem.ui

import androidx.compose.foundation.border
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.apps.SweepProcessor
import kotlinx.coroutines.flow.MutableStateFlow

/** Sweep ranges: a tile's name, the line under it, and the span. */
private val RANGES = listOf(
    Triple("FM", "88–108", 88_000_000L to 108_000_000L),
    Triple("AIR", "118–137", 118_000_000L to 137_000_000L),
    Triple("2 m", "144–148", 144_000_000L to 148_000_000L),
    Triple("70 cm", "420–450", 420_000_000L to 450_000_000L),
    Triple("ISM", "902–928", 902_000_000L to 928_000_000L),
    Triple("GSM", "925–960", 925_000_000L to 960_000_000L),
    Triple("L-BAND", "1.2–1.6 G", 1_200_000_000L to 1_600_000_000L),
    Triple("2.4 G", "ISM", 2_400_000_000L to 2_483_000_000L),
    Triple("0.1–1 G", "wide", 100_000_000L to 1_000_000_000L),
    Triple("1–3 G", "wide", 1_000_000_000L to 3_000_000_000L),
    Triple("3–6 G", "wide", 3_000_000_000L to 6_000_000_000L),
)

private val emptyRow = MutableStateFlow(FloatArray(0))
private val zero = MutableStateFlow(0)

/** The ranges as tiles (wider spans sweep slower), then the slice width (wider is faster, if the radio keeps up). */
@Composable
private fun RangeChips(accent: Color, sp: SweepProcessor?) {
    val d = rememberDims()
    val rate by SdrEngine.rateHz.collectAsState()
    // FULL is the whole radio: hundreds of steps and slow, but it is the "what is out there anywhere" view
    val all = RANGES + Triple("FULL", "1 M–6 G", SdrEngine.FREQ_MIN_HZ to SdrEngine.FREQ_MAX_HZ)
    val whys = all.map { com.rocketgod.mayhem.core.Radio.tuneWhy(it.third.first, it.third.second) }
    TileRow(all.mapIndexed { i, (name, sub, r) -> Tile(name, sub, sp?.startHz == r.first && sp?.endHz == r.second, dim = whys[i].isNotEmpty()) }, accent, width = 84.dp) { i ->
        val r = all[i].third
        gated(whys[i]) { Apps.startSweep(r.first, r.second) }()
    }
    val rates = listOf(2_000_000, 4_000_000, 8_000_000, 16_000_000)
    val rateWhys = rates.map { com.rocketgod.mayhem.core.Radio.rateWhy(it) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
        RowLabel("SLICE")
        SegBar(rates.map { "${it / 1_000_000} MHz" }, rates.indexOf(rate), accent, Modifier.weight(1f),
            tints = rateWhys.map { if (it.isNotEmpty()) Palette.muted.copy(alpha = 0.45f) else null }) { i ->
            gated(rateWhys[i]) { Apps.sweepRate = rates[i]; if (sp != null) Apps.startSweep(sp.startHz, sp.endHz) }()
        }
    }
}

/** The sweep's card: what it is, the range, a lamp counting passes, and how far through this pass it is. */
@Composable
private fun SweepFace(accent: Color, tag: String, s: SweepProcessor?, progress: Int, sweeps: Int, note: String?) {
    val d = rememberDims()
    FreqCard(accent, tag = tag, title = note ?: if (s == null) "NO SWEEP" else "SWEEPING THE RANGE", titleColor = if (note != null) Palette.accent2 else Palette.muted,
        freq = 0L, onTune = null, meter = if (s != null && s.steps > 0) progress.toFloat() / s.steps else 0f,
        scale = listOf(0f to "0", 0.5f to "50%", 1f to "100%"),
        left = if (s == null) "—" else "SLICE $progress / ${s.steps}", right = if (s == null) "" else "%.1f MHz wide".format((s.endHz - s.startHz) / 1e6),
        lamp = { if (s == null) Lamp("IDLE", Palette.muted) else if (sweeps == 0) Lamp("FIRST PASS", Palette.accent2, blink = true) else Lamp("PASS ${sweeps + 1}", Palette.ok) },
        // a sweep has a range, not one frequency: the range in the dial's place, the same size and glow
        digits = {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(if (s == null) "—" else "%.1f–%.1f".format(s.startHz / 1e6, s.endHz / 1e6), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black,
                    fontSize = d.sp(40f), maxLines = 1, softWrap = false,
                    style = androidx.compose.ui.text.TextStyle(shadow = androidx.compose.ui.graphics.Shadow(accent.copy(alpha = 0.6f), blurRadius = 24f)))
                Text("MHz", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
            }
        })
}

/** A sweep row as 0..1 columns and the dB its 0 sits at. */
private class SweepSpec(val spec: FloatArray, val floorDb: Float)
private val noSpec = SweepSpec(FloatArray(0), Float.NaN)
private const val SWEEP_RANGE_DB = 32f

/**
 * Downsample a sweep row (KEEP-bin slices stitched, NaN where not yet measured) to at most [cols] columns. Each
 * column keeps the loudest of its bins so a narrow carrier never vanishes between columns; the floor is then read
 * from those column peaks (their median, plus 1 dB), not from the raw bins: peak-picking lifts the noise a few dB,
 * and a floor from the raw median left the background a bright speckle. Noise sits near black, stations stand out.
 */
private fun rowToSpec(row: FloatArray, cols: Int = 8192): SweepSpec {
    if (row.isEmpty()) return noSpec
    val n = minOf(cols, row.size)
    val peaks = FloatArray(n)
    var m = 0
    val sample = FloatArray(n)
    for (c in 0 until n) {
        val a = (c.toLong() * row.size / n).toInt(); val b = ((c + 1).toLong() * row.size / n).toInt().coerceAtLeast(a + 1)
        var peak = Float.NaN
        for (k in a until minOf(b, row.size)) { val v = row[k]; if (!v.isNaN() && (peak.isNaN() || v > peak)) peak = v }
        peaks[c] = peak
        if (!peak.isNaN()) sample[m++] = peak
    }
    if (m == 0) return noSpec
    java.util.Arrays.sort(sample, 0, m)
    val floor = sample[m / 2] + 1f
    val out = FloatArray(n) { c -> val p = peaks[c]; if (p.isNaN()) 0f else ((p - floor) / SWEEP_RANGE_DB).coerceIn(0f, 1f) }
    return SweepSpec(out, floor)
}

/** The sweep's frequency at a fraction of its row, as the waterfall labels it. */
private fun sweepLabel(s: SweepProcessor): (Float, Float) -> String = { f, _ -> "%.3f".format((s.startHz + s.coverHz * f.toDouble()) / 1e6) }

@Composable
private fun SweepTitle(s: SweepProcessor?, progress: Int, sweeps: Int, extra: String, accent: Color) {
    val d = rememberDims()
    Text(
        if (s == null) "no sweep" else "%.1f – %.1f MHz · slice %d/%d · sweep %d%s".format(s.startHz / 1e6, s.endHz / 1e6, progress, s.steps, sweeps, extra),
        color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp,
        modifier = Modifier.fillMaxWidth().padding(vertical = d.dp(4f)), textAlign = TextAlign.Center
    )
}

/** Looking Glass: the whole range as one waterfall. Tap to listen there. */
@Composable
fun LookingGlassScreen(accent: Color) {
    val d = rememberDims()
    val sp by Apps.sweep.collectAsState()
    val s = sp
    val row by (s?.row ?: emptyRow).collectAsState()
    val live by (s?.live ?: emptyRow).collectAsState()
    val progress by (s?.progress ?: zero).collectAsState()
    val sweeps by (s?.sweeps ?: zero).collectAsState()
    val cols = if (d.wide) 768 else 512
    val done = remember(row) { rowToSpec(row) }
    val now = remember(live) { rowToSpec(live) }
    val floorDb = if (now.floorDb.isNaN()) done.floorDb else now.floorDb
    val rowPx = maxOf(1, (2 * LocalDensity.current.density).toInt())
    var previewHz by remember { mutableStateOf<Long?>(null) }
    AdaptivePane(
        stacked = true,
        face = { SweepFace(accent, "GLASS", s, progress, sweeps, previewHz?.let { "LISTEN %.3f MHZ · LIFT TO TUNE".format(it / 1e6) }) },
        visual = { m ->
            Column(m.clip(RoundedCornerShape(d.dp(12f))).border(1.dp, Palette.line, RoundedCornerShape(d.dp(12f)))) {
                // a new sweep starts a new history: rows from another range would mislead
                key(s) {
                    WaterfallView(
                        done.spec, cols, accent, Modifier.fillMaxWidth().weight(1f), rows = 64, traceFrac = 0.3f,
                        centreMarker = false, centerHz0 = 0L, spanHz0 = 0, labels = if (s != null) rangeLabels(s.startHz, s.startHz + s.coverHz, if (d.wide) 7 else 5) else emptyList(),
                        onPreviewFrac = { f -> previewHz = if (f != null && s != null) s.startHz + (s.coverHz * f.toDouble()).toLong() else null },
                        live = now.spec, scale = floorDb to SWEEP_RANGE_DB, labelAt = s?.let { sweepLabel(it) }, rowPx = rowPx,
                    ) { frac ->
                        if (s != null) {
                            val f = s.startHz + (s.coverHz * frac.toDouble()).toLong()
                            Apps.listen((f / 10_000L) * 10_000L, if (f < 108_000_000L && f > 87_000_000L) SdrEngine.Mode.WFM else SdrEngine.Mode.NFM)
                        }
                    }
                }
            }
        }
    ) {
        ScrollColumn(Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(top = d.dp(6f), bottom = d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) { RangeChips(accent, s) }
        }
    }
}

/** Search: list the bins that rise above the sweep's noise floor. Tap a hit to listen. */
@Composable
fun SearchScreen(accent: Color) {
    val d = rememberDims()
    val sp by Apps.sweep.collectAsState()
    val s = sp
    val row by (s?.row ?: emptyRow).collectAsState()
    val live by (s?.live ?: emptyRow).collectAsState()
    val progress by (s?.progress ?: zero).collectAsState()
    val sweeps by (s?.sweeps ?: zero).collectAsState()
    var threshold by remember { mutableStateOf(15) }
    val hits = remember(row, threshold, s) { if (s == null) emptyList() else findHits(row, threshold, s) }
    val cols = if (d.wide) 768 else 512
    val done = remember(row) { rowToSpec(row) }
    val now = remember(live) { rowToSpec(live) }
    val floorDb = if (now.floorDb.isNaN()) done.floorDb else now.floorDb
    val rowPx = maxOf(1, (2 * LocalDensity.current.density).toInt())
    AdaptivePane(
        // the waterfall and the list under it split the screen evenly
        share = true,
        face = { SweepFace(accent, "SEARCH", s, progress, sweeps, null) },
        visual = { m ->
            Column(m.clip(RoundedCornerShape(d.dp(12f))).border(1.dp, Palette.line, RoundedCornerShape(d.dp(12f)))) {
                key(s) {
                    WaterfallView(
                        done.spec, cols, accent, Modifier.fillMaxWidth().weight(1f), rows = 64, traceFrac = 0.35f,
                        centreMarker = false, centerHz0 = 0L, spanHz0 = 0, labels = if (s != null) rangeLabels(s.startHz, s.startHz + s.coverHz, if (d.wide) 7 else 5) else emptyList(),
                        live = now.spec, scale = floorDb to SWEEP_RANGE_DB, labelAt = s?.let { sweepLabel(it) }, rowPx = rowPx,
                    )
                }
            }
        }
    ) {
        Column(Modifier.fillMaxWidth().padding(top = d.dp(6f), bottom = d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            RangeChips(accent, s)
            val ts = listOf(10, 15, 20, 30)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("ABOVE")
                SegBar(ts.map { "+$it dB" }, ts.indexOf(threshold), accent, Modifier.weight(1f)) { threshold = ts[it] }
            }
            Text("${hits.size} HITS · TAP ONE TO LISTEN", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 2.sp)
        }
        LogList(hits, Modifier.fillMaxWidth().weight(1f), empty = "sweeping… hits appear after the first full pass", accent = accent, emptyKey = "search") { line ->
            val mhz = line.trim().split(" ")[0].toDoubleOrNull()
            if (mhz != null) Apps.listen((mhz * 1e6).toLong(), if (mhz in 87.0..108.0) SdrEngine.Mode.WFM else SdrEngine.Mode.NFM)
        }
    }
}

private fun findHits(row: FloatArray, thresholdDb: Int, s: SweepProcessor): List<String> {
    if (row.isEmpty()) return emptyList()
    val sorted = row.copyOf(); java.util.Arrays.sort(sorted)
    val floor = sorted[sorted.size / 2]
    val out = ArrayList<Pair<Float, String>>()
    var i = 0
    while (i < row.size) {
        if (row[i] - floor >= thresholdDb) {
            var peak = row[i]; var peakIdx = i
            var j = i
            while (j < row.size && row[j] - floor >= thresholdDb) { if (row[j] > peak) { peak = row[j]; peakIdx = j }; j++ }
            out.add((peak - floor) to "%.4f MHz  %+.0f dB".format(s.freqOfBin(peakIdx) / 1e6, peak - floor))
            i = j
        } else i++
    }
    return out.sortedByDescending { it.first }.take(200).map { it.second }
}
