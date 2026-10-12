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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
            for ((label, r) in row) Chip(label, selected = sp?.startHz == r.first && sp?.endHz == r.second, accent = accent, modifier = Modifier.weight(1f)) { Apps.startSweep(r.first, r.second) }
        }
    }
    SectionLabel("SLICE WIDTH · wider = faster, if the HackRF keeps up")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        for (r in intArrayOf(2_000_000, 4_000_000, 8_000_000, 16_000_000)) {
            Chip("${r / 1_000_000} MHz", selected = rate == r, accent = accent, modifier = Modifier.weight(1f)) {
                Apps.sweepRate = r
                if (sp != null) Apps.startSweep(sp.startHz, sp.endHz)
            }
        }
    }
}

/** Downsample a sweep row (steps × 256 dB) to [cols] columns by max, auto-ranged to 0..1. */
private fun rowToSpec(row: FloatArray, cols: Int): FloatArray {
    val out = FloatArray(cols)
    if (row.isEmpty()) return out
    val sorted = row.copyOf(); java.util.Arrays.sort(sorted)
    var floor = 0f; val nHalf = (sorted.size / 2).coerceAtLeast(1)
    for (i in 0 until nHalf) floor += sorted[i]
    floor /= nHalf
    for (c in 0 until cols) {
        val a = (c.toLong() * row.size / cols).toInt(); val b = ((c + 1).toLong() * row.size / cols).toInt().coerceAtLeast(a + 1)
        var peak = -999f
        for (i in a until minOf(b, row.size)) if (row[i] > peak) peak = row[i]
        out[c] = ((peak - floor) / 45f).coerceIn(0f, 1f)
    }
    return out
}

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
    val progress by (s?.progress ?: zero).collectAsState()
    val sweeps by (s?.sweeps ?: zero).collectAsState()
    val cols = if (d.wide) 768 else 512
    val spec = remember(row, cols) { rowToSpec(row, cols) }
    var previewHz by remember { mutableStateOf<Long?>(null) }
    AdaptivePane(
        visual = { m ->
            Column(m) {
                SweepTitle(s, progress, sweeps, if (previewHz != null) " · LISTEN %.3f MHz — lift to tune".format(previewHz!! / 1e6) else "", if (previewHz != null) Palette.accent2 else accent)
                WaterfallView(
                    spec, cols, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)), rows = 200, traceFrac = 0.3f,
                    centreMarker = false, labels = if (s != null) rangeLabels(s.startHz, s.endHz, if (d.wide) 7 else 5) else emptyList(),
                    onPreviewFrac = { f -> previewHz = if (f != null && s != null) s.startHz + ((s.endHz - s.startHz) * f.toDouble()).toLong() else null }
                ) { frac ->
                    if (s != null) {
                        val f = s.startHz + ((s.endHz - s.startHz) * frac.toDouble()).toLong()
                        Apps.listen((f / 10_000L) * 10_000L, if (f < 108_000_000L && f > 87_000_000L) SdrEngine.Mode.WFM else SdrEngine.Mode.NFM)
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
    val progress by (s?.progress ?: zero).collectAsState()
    val sweeps by (s?.sweeps ?: zero).collectAsState()
    var threshold by remember { mutableStateOf(15) }
    val hits = remember(row, threshold, s) { if (s == null) emptyList() else findHits(row, threshold, s) }
    val cols = if (d.wide) 768 else 512
    val spec = remember(row, cols) { rowToSpec(row, cols) }
    AdaptivePane(
        visualHeightNarrow = d.dp(200f),
        visual = { m ->
            Column(m) {
                SweepTitle(s, progress, sweeps, " · ${hits.size} hits", accent)
                WaterfallView(
                    spec, cols, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)), rows = if (d.wide) 200 else 80, traceFrac = 0.35f,
                    centreMarker = false, labels = if (s != null) rangeLabels(s.startHz, s.endHz, if (d.wide) 7 else 5) else emptyList()
                )
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
