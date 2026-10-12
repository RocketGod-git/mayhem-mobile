package com.rocketgod.mayhem.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Bookmarks
import com.rocketgod.mayhem.core.Scanner
import com.rocketgod.mayhem.core.SdrEngine
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.roundToLong

/** Audio receiver (Mayhem "Audio" / analog_audio_app): waterfall, slide-to-tune, WFM/NFM/AM/USB/LSB, squelch, bookmarks + scan, gain. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AudioScreen(accent: Color) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val mode by SdrEngine.mode.collectAsState()
    val health by SdrEngine.rxHealth.collectAsState()
    val squelch by SdrEngine.squelchDb.collectAsState()
    val bookmarks by Bookmarks.list.collectAsState()
    val scanning by Scanner.active.collectAsState()
    var naming by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }

    if (naming) {
        AlertDialog(
            onDismissRequest = { naming = false },
            containerColor = Palette.surface, titleContentColor = Palette.ink, textContentColor = Palette.ink,
            title = { Text("Bookmark", fontFamily = Mono, fontWeight = FontWeight.Bold) },
            text = {
                OutlinedTextField(newName, { newName = it }, singleLine = true, label = { Text("name", fontFamily = Mono) },
                    colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Palette.ink, unfocusedTextColor = Palette.ink, focusedBorderColor = accent, unfocusedBorderColor = Palette.line, cursorColor = accent, focusedLabelColor = accent, unfocusedLabelColor = Palette.muted))
            },
            confirmButton = { TextButton({ Bookmarks.add(newName, freq, mode); naming = false }) { Text("SAVE", color = accent, fontFamily = Mono) } },
            dismissButton = { TextButton({ naming = false }) { Text("CANCEL", color = Palette.muted, fontFamily = Mono) } }
        )
    }

    AdaptivePane(
        visual = { m ->
            Column(m) {
                FreqReadout(accent, if (health.isNotEmpty()) health else "waiting for IQ…", big = true)
                WaterfallView(
                    spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)),
                    rows = 160, labels = centredLabels(freq, SdrEngine.currentRate()),
                    onPreviewFrac = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } }
                ) { frac -> SdrEngine.tune(spanHz(freq, SdrEngine.currentRate(), frac)) }
            }
        }
    ) {
        ScrollColumn(Modifier.fillMaxWidth()) {
            // Coarse tuning across 1 MHz – 6 GHz on a log scale; fine control = tap-to-tune + steppers.
            SectionLabel("BAND · 1 MHz – 6 GHz")
            val lo = log10(SdrEngine.FREQ_MIN_HZ / 1e6).toFloat(); val hi = log10(SdrEngine.FREQ_MAX_HZ / 1e6).toFloat()
            val pos = log10((freq / 1e6).coerceAtLeast(1.0)).toFloat().coerceIn(lo, hi)
            Slider(
                value = pos,
                onValueChange = { v -> SdrEngine.tune(((10.0.pow(v.toDouble()) * 1e6) / 10_000.0).roundToLong() * 10_000L) },
                valueRange = lo..hi,
                colors = SliderDefaults.colors(thumbColor = accent, activeTrackColor = accent, inactiveTrackColor = Palette.line),
                modifier = Modifier.fillMaxWidth()
            )
            SectionLabel("MODE")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for (m in listOf(SdrEngine.Mode.WFM, SdrEngine.Mode.NFM, SdrEngine.Mode.AM, SdrEngine.Mode.USB, SdrEngine.Mode.LSB)) {
                    Chip(m.name, selected = mode == m, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.setMode(m) }
                }
            }
            StepperRow(accent)
            PresetRow(accent, listOf("FM 92.3" to 92_300_000L, "AIR 121.5" to 121_500_000L, "NOAA 162.4" to 162_400_000L, "ISM 433.92" to 433_920_000L)) { hz ->
                SdrEngine.setMode(when (hz) { 92_300_000L -> SdrEngine.Mode.WFM; 121_500_000L -> SdrEngine.Mode.AM; else -> SdrEngine.Mode.NFM })
                SdrEngine.tune(hz)
            }
            SectionLabel("SQUELCH · dB above the noise floor")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for (s in intArrayOf(0, 6, 12, 20)) Chip(if (s == 0) "OFF" else "$s dB", selected = squelch == s, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.setSquelch(s) }
            }
            GainRow(accent)
            Row(Modifier.fillMaxWidth().padding(top = d.dp(8f), bottom = d.dp(4f)), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("BOOKMARKS", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 2.sp)
                Row {
                    Text("★ SAVE", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 2.sp,
                        modifier = Modifier.padding(start = 12.dp).clickable { newName = "%.4f %s".format(freq / 1e6, mode.name); naming = true })
                    Text("⟳ SCAN", color = if (scanning) Palette.accent2 else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 2.sp,
                        modifier = Modifier.padding(start = 12.dp).clickable { Scanner.toggle() })
                }
            }
            if (bookmarks.isEmpty()) {
                Text("no bookmarks — tune something and tap ★ SAVE", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(2.dp))
            } else {
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    for (b in bookmarks) {
                        val on = b.hz == freq
                        Row(Modifier.control(accent, on).padding(vertical = d.dp(6f)).padding(start = d.dp(10f), end = d.dp(4f)), verticalAlignment = Alignment.CenterVertically) {
                            Text(b.name, color = if (on) inkOn(accent) else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1,
                                modifier = Modifier.clickable { Scanner.stop(); Bookmarks.go(b) })
                            Text("✕", color = if (on) inkOn(accent) else Palette.muted, fontFamily = Mono, fontSize = d.sp(11f),
                                modifier = Modifier.padding(start = 6.dp).clickable { Bookmarks.remove(b) }.padding(horizontal = 6.dp))
                        }
                    }
                }
            }
        }
    }
}
