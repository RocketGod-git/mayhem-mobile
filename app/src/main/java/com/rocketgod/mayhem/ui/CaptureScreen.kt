package com.rocketgod.mayhem.ui

import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.core.content.FileProvider
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.SdrEngine
import java.io.File

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
    var files by remember { mutableStateOf(rec?.captureFiles() ?: emptyList()) }
    var doomed by remember { mutableStateOf<File?>(null) }
    val ctx = LocalContext.current
    doomed?.let { f ->
        AlertDialog(
            onDismissRequest = { doomed = null },
            containerColor = Palette.surface, titleContentColor = Palette.ink, textContentColor = Palette.ink,
            title = { Text("Delete capture?", fontFamily = Mono, fontWeight = FontWeight.Bold) },
            text = { Text("${f.name} and its .txt sidecar are removed from the phone for good.", fontFamily = Mono) },
            confirmButton = { TextButton({ rec?.delete(f); files = rec?.captureFiles() ?: emptyList(); doomed = null }) { Text("DELETE", color = Palette.danger, fontFamily = Mono) } },
            dismissButton = { TextButton({ doomed = null }) { Text("KEEP", color = Palette.muted, fontFamily = Mono) } },
        )
    }
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
                    if (recording) { rec.stop(); recording = false; files = rec.captureFiles() }
                    else { rec.start(freq, rate); recording = true }
                }
                Text(
                    if (recording) "%.1f MB · %s%s".format(bytes / 1e6, file ?: "", if (dropped > 0) " · $dropped dropped" else "")
                    else "%d Msps · %.1f MB/s".format(rate / 1_000_000, rate * 2 / 1e6),
                    color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.weight(2f), maxLines = 1
                )
            }
            Text(rec.directory, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), modifier = Modifier.fillMaxWidth().padding(top = d.dp(6f)), maxLines = 2, textAlign = TextAlign.Center)
            SectionLabel("CAPTURES · SHARE sends the recording and its sidecar to any app")
            if (files.isEmpty()) Text("no captures yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(d.dp(4f)))
            else LazyColumn(Modifier.fillMaxWidth().weight(1f).panel().padding(d.dp(4f))) {
                items(files, key = { it.name }) { f ->
                    Row(Modifier.fillMaxWidth().padding(vertical = d.dp(3f)), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(f.name, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("%.1f MB · %s".format(f.length() / 1e6, java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(f.lastModified()))),
                                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1)
                        }
                        Chip("SHARE", selected = false, accent = accent) { shareCapture(ctx, rec.filesOf(f)) }
                        Spacer(Modifier.width(d.dp(4f)))
                        Chip("✕", selected = false, accent = Palette.danger) { doomed = f }
                    }
                }
            }
        } else {
            Text("recorder unavailable", color = Palette.danger, fontFamily = Mono, fontSize = d.sp(11f))
        }
    }
}

/** Hand a recording and its sidecar to whatever app the user picks (SDR# / GNU Radio on a PC, a cloud drive, mail). */
private fun shareCapture(ctx: Context, files: List<File>) {
    runCatching {
        val uris = ArrayList(files.map { FileProvider.getUriForFile(ctx, ctx.packageName + ".logs", it) })
        val send = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "application/octet-stream"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
            putExtra(Intent.EXTRA_SUBJECT, files.first().name)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        ctx.startActivity(Intent.createChooser(send, "Share capture").apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) })
    }.onFailure { Toast.makeText(ctx, "Could not share the capture", Toast.LENGTH_LONG).show() }
}
