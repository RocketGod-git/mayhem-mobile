package com.rocketgod.mayhem.ui

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

private val RANGES = listOf(
    "FM 88-108" to (88_000_000L to 108_000_000L),
    "AIR 118-137" to (118_000_000L to 137_000_000L),
    "2m 144-148" to (144_000_000L to 148_000_000L),
    "70cm 420-450" to (420_000_000L to 450_000_000L),
    "ISM 902-928" to (902_000_000L to 928_000_000L),
    "GSM 925-960" to (925_000_000L to 960_000_000L),
    "1.2-1.6G" to (1_200_000_000L to 1_600_000_000L),
    "2.4G ISM" to (2_400_000_000L to 2_483_000_000L),
    "0.1-1 GHz" to (100_000_000L to 1_000_000_000L),
    "1-3 GHz" to (1_000_000_000L to 3_000_000_000L),
    "3-6 GHz" to (3_000_000_000L to 6_000_000_000L),
)

private val emptyRow = MutableStateFlow(FloatArray(0))
private val zero = MutableStateFlow(0)

@Composable
private fun RangeChips(accent: Color, sp: SweepProcessor?) {
    val d = rememberDims()
    val rate by SdrEngine.rateHz.collectAsState()
    SectionLabel("RANGE · wider spans sweep slower")
    // FULL is the whole radio: hundreds of steps and slow, but it is the "what is out there anywhere" view
    val chips = RANGES + ("FULL 1M-6G" to (SdrEngine.FREQ_MIN_HZ to SdrEngine.FREQ_MAX_HZ))
    for ((i, row) in chips.chunked(4).withIndex()) {
        Row(Modifier.fillMaxWidth().padding(top = if (i > 0) d.dp(4f) else 0.dp), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            for ((label, r) in row) {
                val why = com.rocketgod.mayhem.core.Radio.tuneWhy(r.first, r.second)
                Chip(label, selected = sp?.startHz == r.first && sp?.endHz == r.second, accent = accent, modifier = Modifier.weight(1f), dim = why.isNotEmpty(),
                    onClick = gated(why) { Apps.startSweep(r.first, r.second) })
            }
        }
    }
    SectionLabel("SLICE WIDTH · wider = faster, if the HackRF keeps up")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        for (r in intArrayOf(2_000_000, 4_000_000, 8_000_000, 16_000_000)) {
            val why = com.rocketgod.mayhem.core.Radio.rateWhy(r)
            Chip("${r / 1_000_000} MHz", selected = rate == r, accent = accent, modifier = Modifier.weight(1f), dim = why.isNotEmpty(), onClick = gated(why) {
                Apps.sweepRate = r
                if (sp != null) Apps.startSweep(sp.startHz, sp.endHz)
            })
        }
    }
}

/** A sweep row as 0..1 columns and the dB its 0 sits at. */
private class SweepSpec(val spec: FloatArray, val floorDb: Float)
private val noSpec = SweepSpec(FloatArray(0), Float.NaN)
private const val SWEEP_RANGE_DB = 30f

/**
 * Downsample a sweep row (steps × KEEP dB, NaN where not yet measured) to at most [cols] columns by max. The median
 * is the floor, sitting 4 dB up a 30 dB scale, so a sweep reads like the live waterfall; it is taken over at most
 * ~4096 samples of the row, which a full-range row (150 k bins) would otherwise have to sort on every live update.
 */
private fun rowToSpec(row: FloatArray, cols: Int = 8192): SweepSpec {
    if (row.isEmpty()) return noSpec
    val stride = maxOf(1, row.size / 4096)
    val sample = FloatArray((row.size + stride - 1) / stride)
    var m = 0; var i = 0
    while (i < row.size) { val v = row[i]; if (!v.isNaN()) sample[m++] = v; i += stride }
    if (m == 0) return noSpec
    java.util.Arrays.sort(sample, 0, m)
    val floor = sample[m / 2] - 4f
    val n = minOf(cols, row.size)
    val out = FloatArray(n)
    for (c in 0 until n) {
        val a = (c.toLong() * row.size / n).toInt(); val b = ((c + 1).toLong() * row.size / n).toInt().coerceAtLeast(a + 1)
        var peak = -999f
        for (k in a until minOf(b, row.size)) if (row[k] > peak) peak = row[k]
        out[c] = ((peak - floor) / SWEEP_RANGE_DB).coerceIn(0f, 1f)
    }
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
        visual = { m ->
            Column(m) {
                SweepTitle(s, progress, sweeps, if (previewHz != null) " · LISTEN %.3f MHz — lift to tune".format(previewHz!! / 1e6) else "", if (previewHz != null) Palette.accent2 else accent)
                // a new sweep starts a new history: rows from another range would mislead
                key(s) {
                    WaterfallView(
                        done.spec, cols, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)), rows = 64, traceFrac = 0.3f,
                        centerMarker = false, centerHz0 = 0L, spanHz0 = 0, labels = if (s != null) rangeLabels(s.startHz, s.startHz + s.coverHz, if (d.wide) 7 else 5) else emptyList(),
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
            RangeChips(accent, s)
            GainRow(accent)
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
        visualHeightNarrow = d.dp(200f),
        visual = { m ->
            Column(m) {
                SweepTitle(s, progress, sweeps, " · ${hits.size} hits", accent)
                key(s) {
                    WaterfallView(
                        done.spec, cols, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)), rows = 64, traceFrac = 0.35f,
                        centerMarker = false, centerHz0 = 0L, spanHz0 = 0, labels = if (s != null) rangeLabels(s.startHz, s.startHz + s.coverHz, if (d.wide) 7 else 5) else emptyList(),
                        live = now.spec, scale = floorDb to SWEEP_RANGE_DB, labelAt = s?.let { sweepLabel(it) }, rowPx = rowPx,
                    )
                }
            }
        }
    ) {
        SectionLabel("THRESHOLD · above noise floor")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            for (t in intArrayOf(10, 15, 20, 30)) Chip("+$t dB", selected = threshold == t, accent = accent, modifier = Modifier.weight(1f)) { threshold = t }
        }
        RangeChips(accent, s)
        GainRow(accent)
        SectionLabel("HITS · tap to listen")
        LogList(hits, Modifier.fillMaxWidth().weight(1f), empty = "sweeping… hits appear after the first full pass") { line ->
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
