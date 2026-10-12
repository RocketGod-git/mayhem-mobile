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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.SdrEngine

/** Capture (Mayhem capture_app): record raw IQ at the current dial to a .c8 + .txt pair. */
@Composable
fun CaptureScreen(accent: Color) {
    val d = rememberDims()
    val rec = Apps.recorder
    val spec by SdrEngine.spectrum.collectAsState()
    val health by SdrEngine.rxHealth.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val rate by SdrEngine.rateHz.collectAsState()
    var recording by remember { mutableStateOf(rec?.recording == true) }
    var files by remember { mutableStateOf(rec?.listCaptures() ?: emptyList()) }
    val recTint = if (recording) Palette.danger else accent
    AdaptivePane(
        visualHeightNarrow = d.dp(200f),
        visual = { m ->
            Column(m) {
                FreqReadout(if (recording) Palette.danger else accent, if (health.isNotEmpty()) health else "waiting for IQ…", big = d.wide)
                WaterfallView(spec, SdrEngine.SPEC_BINS, recTint, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)),
                    rows = if (d.wide) 160 else 80, traceFrac = 0.35f, labels = centredLabels(freq, SdrEngine.currentRate()),
                    onPreviewFrac = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } },
                    onTapFrac = { frac -> SdrEngine.tune(spanHz(freq, SdrEngine.currentRate(), frac)) })
            }
        }
    ) {
        StepperRow(accent)
        GainRow(accent)
        if (rec != null) {
            val bytes by rec.bytes.collectAsState()
            val file by rec.file.collectAsState()
            val dropped by rec.dropped.collectAsState()
            SectionLabel("RECORD · signed 8-bit I/Q (.c8) + .txt sidecar")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap), verticalAlignment = Alignment.CenterVertically) {
                Chip(if (recording) "■  STOP" else "●  REC", selected = recording, accent = recTint, modifier = Modifier.weight(1f)) {
                    if (recording) { rec.stop(); recording = false; files = rec.listCaptures() }
                    else { rec.start(freq, rate); recording = true }
                }
                Text(
                    if (recording) "%.1f MB · %s%s".format(bytes / 1e6, file ?: "", if (dropped > 0) " · $dropped dropped" else "")
                    else "%d Msps · %.1f MB/s".format(rate / 1_000_000, rate * 2 / 1e6),
                    color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.weight(2f), maxLines = 1
                )
            }
            Text(rec.directory, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), modifier = Modifier.fillMaxWidth().padding(top = d.dp(6f)), maxLines = 2, textAlign = TextAlign.Center)
            SectionLabel("CAPTURES")
            LogList(files, Modifier.fillMaxWidth().weight(1f), empty = "no captures yet")
        } else {
            Text("recorder unavailable", color = Palette.danger, fontFamily = Mono, fontSize = d.sp(11f))
        }
    }
}
