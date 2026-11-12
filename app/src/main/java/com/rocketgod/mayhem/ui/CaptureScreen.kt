package com.rocketgod.mayhem.ui

import androidx.compose.foundation.border
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
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
        // the waterfall and the list under it split the screen evenly
        share = true,
        stacked = true,
        face = {
            val bytes = rec?.bytes?.collectAsState()?.value ?: 0L
            val level by SdrEngine.levelDb.collectAsState()
            FreqCard(recTint, tag = "CAPTURE", title = "%d MSPS · .C8 IQ".format(rate / 1_000_000), freq = freq, meter = level / 40f, left = "SIGNAL +%.0f dB".format(level),
                right = "%.1f MB/s to disk".format(rate * 2 / 1e6),
                lamp = { if (recording) Lamp("REC %.1f MB".format(bytes.toLong() / 1e6), Palette.danger, blink = true) else Lamp("READY", Palette.ok) })
        },
        visual = { m ->
            Box(m.clip(RoundedCornerShape(d.dp(12f))).border(1.dp, if (recording) Palette.danger else Palette.line, RoundedCornerShape(d.dp(12f)))) {
                ReceiverScope(recTint, Modifier.fillMaxSize(), rows = if (d.wide) 160 else 100, traceFrac = 0.26f, fitMode = false)
            }
        }
    ) {
        if (rec != null) {
            val bytes by rec.bytes.collectAsState()
            val file by rec.file.collectAsState()
            val dropped by rec.dropped.collectAsState()
            // signed 8-bit I/Q (.c8) with a .txt sidecar
            ToggleBox(if (recording) "■  STOP" else "●  RECORD", recording, Palette.danger, Modifier.fillMaxWidth().padding(top = d.dp(8f))) {
                if (recording) { rec.stop(); recording = false; files = rec.captureFiles() }
                else { rec.start(freq, rate); recording = true }
            }
            Text(if (recording) "${file ?: ""}${if (dropped > 0) " · $dropped dropped" else ""}" else rec.directory,
                color = if (dropped > 0) Palette.danger else Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 2, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = d.dp(6f)))
            // SHARE sends the recording and its sidecar to any app
            Text("${files.size} CAPTURES", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 2.sp,
                modifier = Modifier.padding(top = d.dp(10f), bottom = d.dp(6f)))
            if (files.isEmpty()) Box(Modifier.fillMaxWidth().weight(1f).panel()) { EmptyState("capture", Modifier.fillMaxSize(), accent) }
            else LazyColumn(Modifier.fillMaxWidth().weight(1f).panel().padding(d.dp(4f))) {
                items(files, key = { it.name }) { f ->
                    Row(Modifier.fillMaxWidth().padding(vertical = d.dp(3f)), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(f.name, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("%.1f MB · %s".format(f.length() / 1e6, java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(f.lastModified()))),
                                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1)
                        }
                        ToggleBox("SHARE", false, accent) { shareCapture(ctx, rec.filesOf(f)) }
                        Spacer(Modifier.width(d.dp(4f)))
                        IconBox(ClearIcon, "Delete") { doomed = f }
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
