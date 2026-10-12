package com.rocketgod.mayhem.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Bookmarks
import com.rocketgod.mayhem.core.Scanner
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.audio.HdReport
import com.rocketgod.mayhem.core.audio.RdsState
import com.rocketgod.mayhem.core.audio.SameHeader
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
    val rdsWanted by SdrEngine.rdsWanted.collectAsState()
    val hdWanted by SdrEngine.hdWanted.collectAsState()
    val rds by SdrEngine.rds.collectAsState()
    val hd by SdrEngine.hd.collectAsState()
    val alert by SdrEngine.same.collectAsState()
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
                alert?.header?.let { h -> SameBanner(h) }
                FreqReadout(accent, if (health.isNotEmpty()) health else "waiting for IQ…", big = true)
                Box(Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f))) {
                    WaterfallView(
                        spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxSize(),
                        rows = 160, labels = centredLabels(freq, SdrEngine.currentRate()),
                        onPreviewFrac = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } }
                    ) { frac -> SdrEngine.tune(spanHz(freq, SdrEngine.currentRate(), frac)) }
                    if (mode == SdrEngine.Mode.WFM && rdsWanted) RdsBar(rds, accent, Modifier.align(Alignment.TopCenter))
                    if (mode == SdrEngine.Mode.WFM && hdWanted) HdBadge(hd, Modifier.align(Alignment.TopEnd).padding(top = d.dp(if (rdsWanted) 30f else 4f), end = d.dp(4f)))
                }
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
            Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                Chip("RDS", selected = rdsWanted, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.setRds(!rdsWanted) }
                Chip("HD", selected = hdWanted, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.setHd(!hdWanted) }
            }
            StepperRow(accent)
            PresetRow(accent, listOf("FM 92.3" to 92_300_000L, "AIR 121.5" to 121_500_000L, "NOAA 162.4" to 162_400_000L, "ISM 433.92" to 433_920_000L)) { hz ->
                SdrEngine.setMode(when (hz) { 92_300_000L -> SdrEngine.Mode.WFM; 121_500_000L -> SdrEngine.Mode.AM; else -> SdrEngine.Mode.NFM })
                SdrEngine.tune(hz)
            }
            SectionLabel("BANDS")
            for (row in LISTEN_BANDS.chunked(4)) {
                Row(Modifier.fillMaxWidth().padding(bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                    for (b in row) Chip(b.name, selected = freq in b.lo..b.hi, accent = accent, modifier = Modifier.weight(1f)) {
                        SdrEngine.setMode(b.mode); SdrEngine.tune((b.lo + b.hi) / 2)
                    }
                }
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

/** The band chips shared with the web receiver; ISM and ADS-B have no voice mode, so NFM is the default to browse them. */
private class ListenBand(val name: String, val lo: Long, val hi: Long, val mode: SdrEngine.Mode)
private val LISTEN_BANDS = listOf(
    ListenBand("FM", 88_000_000L, 108_000_000L, SdrEngine.Mode.WFM),
    ListenBand("AIR", 118_000_000L, 137_000_000L, SdrEngine.Mode.AM),
    ListenBand("VHF", 144_000_000L, 163_000_000L, SdrEngine.Mode.NFM),
    ListenBand("315", 314_000_000L, 316_000_000L, SdrEngine.Mode.NFM),
    ListenBand("UHF", 430_000_000L, 450_000_000L, SdrEngine.Mode.NFM),
    ListenBand("433", 433_000_000L, 435_000_000L, SdrEngine.Mode.NFM),
    ListenBand("915", 902_000_000L, 928_000_000L, SdrEngine.Mode.NFM),
    ListenBand("1090", 1_089_000_000L, 1_091_000_000L, SdrEngine.Mode.NFM),
)

/** Everything RDS gave, station identity first and RadioText last, scrolling as one line when it overflows. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RdsBar(r: RdsState?, accent: Color, modifier: Modifier) {
    val d = rememberDims()
    val text = buildAnnotatedString {
        val fields = ArrayList<Pair<String, String>>()
        if (r != null) {
            if (r.ps.isNotBlank()) fields.add("" to r.ps.trim())
            if (r.ptyName.isNotEmpty() && r.ptyName != "None") fields.add("" to r.ptyName)
            r.pi?.let { fields.add("PI" to "%04X".format(it)) }
            if (r.rt.isNotBlank()) fields.add("" to r.rt.trim())
            if (r.af.isNotEmpty()) fields.add("AF" to r.af.joinToString(" ") { "%.1f".format(it) })
        }
        if (fields.isEmpty()) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(if (r?.synced == true) "RDS · reading…" else "RDS · listening…") }
        fields.forEachIndexed { i, (k, v) ->
            if (i > 0) withStyle(SpanStyle(color = Palette.muted)) { append("  ·  ") }
            if (k.isNotEmpty()) withStyle(SpanStyle(color = Palette.muted)) { append("$k ") }
            withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = if (i == 0) accent else Palette.ink)) { append(v) }
        }
    }
    // Dimmed until a station's data actually locks.
    Text(text, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(12f), maxLines = 1,
        modifier = modifier.fillMaxWidth().alpha(if (r?.synced == true) 1f else 0.55f)
            .background(Palette.surface.copy(alpha = 0.82f), RoundedCornerShape(4.dp))
            .padding(horizontal = d.dp(8f), vertical = d.dp(4f)).basicMarquee(iterations = Int.MAX_VALUE))
}

/** Whether the station carries HD Radio sidebands beside its analog signal. */
@Composable
private fun HdBadge(r: HdReport?, modifier: Modifier) {
    val d = rememberDims()
    val label = when {
        r == null -> "HD · listening…"
        r.present -> "HD ◉ %.0f dB · lock %.1f · %+.0f Hz".format(r.snrDb, r.lock, r.cfoHz)
        else -> "HD · none (%.0f dB · lock %.2f)".format(r.snrDb, r.lock)
    }
    val c = if (r?.present == true) Palette.ok else Palette.muted
    Text(label, color = c, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1,
        modifier = modifier.background(Palette.surface.copy(alpha = 0.82f), RoundedCornerShape(4.dp)).border(1.dp, c, RoundedCornerShape(4.dp))
            .padding(horizontal = d.dp(6f), vertical = d.dp(2f)))
}

/** A decoded NOAA Weather Radio / EAS header. Tap to dismiss; the end-of-message burst clears it on its own. */
@Composable
private fun SameBanner(h: SameHeader) {
    val d = rememberDims()
    val dur = if (h.hours > 0 || h.minutes > 0) " · " + (if (h.hours > 0) "${h.hours}h" else "") + (if (h.minutes > 0) "${h.minutes}m" else "") else ""
    val areas = if (h.locations.isNotEmpty()) " · ${h.locations.size} area${if (h.locations.size == 1) "" else "s"}" else ""
    Text("⚠ ${h.eventName.uppercase()} · ${h.originatorName}$areas$dur${if (h.callsign.isNotEmpty()) " · " + h.callsign else ""}   ✕",
        color = Color.White, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f),
        modifier = Modifier.fillMaxWidth().padding(bottom = d.dp(4f)).background(Palette.danger, RoundedCornerShape(4.dp))
            .clickable { SdrEngine.dismissSame() }.padding(horizontal = d.dp(8f), vertical = d.dp(6f)))
}
