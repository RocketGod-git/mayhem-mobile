package com.rocketgod.mayhem.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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

/** Audio receiver (Mayhem "Audio" / analog_audio_app): waterfall, slide-to-tune, WFM/NFM/AM/USB/LSB, bands, squelch and scan. */
@Composable
fun AudioScreen(accent: Color) {
    val d = rememberDims()
    val lo by SdrEngine.freqHz.collectAsState()
    val offset by SdrEngine.offsetHz.collectAsState()
    val freq = lo + offset
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

    AdaptivePane(
        // a receiver is mostly for looking at: on a phone the waterfall gets most of the screen, the controls four rows
        visualHeightNarrow = (d.heightDp * 0.58f).dp,
        visual = { m ->
            Column(m) {
                alert?.header?.let { h -> SameBanner(h) }
                FreqReadout(accent, if (health.isNotEmpty()) health else "waiting for IQ…", big = true)
                Box(Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f))) {
                    ReceiverScope(accent, Modifier.fillMaxSize(), rows = 200)
                    if (mode == SdrEngine.Mode.WFM && rdsWanted) RdsBar(rds, accent, Modifier.align(Alignment.TopCenter))
                    if (mode == SdrEngine.Mode.WFM && hdWanted) HdBadge(hd, Modifier.align(Alignment.TopEnd).padding(top = d.dp(if (rdsWanted) 30f else 4f), end = d.dp(4f)))
                }
            }
        }
    ) {
        // Four rows: how to listen, where (the bands), and squelch with SCAN. Everything else has a better home —
        // the digits, ⌨ and the waterfall tune; ☆ saves and FAVES recalls; RDS and HD are switches in Settings › Audio.
        ScrollColumn(Modifier.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth().padding(top = d.dp(4f), bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for (m in listOf(SdrEngine.Mode.WFM, SdrEngine.Mode.NFM, SdrEngine.Mode.AM, SdrEngine.Mode.USB, SdrEngine.Mode.LSB)) {
                    Chip(m.name, selected = mode == m, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.setMode(m) }
                }
            }
            ListenBandChips(accent, freq) { b -> SdrEngine.setMode(b.mode); SdrEngine.tune(b.centre) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap), verticalAlignment = Alignment.CenterVertically) {
                Text("SQL", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 2.sp)
                for (s in intArrayOf(0, 6, 12, 20)) Chip(if (s == 0) "OFF" else "$s dB", selected = squelch == s, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.setSquelch(s) }
                // SCAN hops your FAVES and holds wherever the squelch opens
                Chip(if (scanning) "SCANNING" else "SCAN", selected = scanning, accent = accent, modifier = Modifier.weight(1.5f), dim = bookmarks.isEmpty()) {
                    if (bookmarks.isEmpty()) Notice.msg.value = "SCAN hops your FAVES — star a few with ☆ beside the frequency first" else Scanner.toggle()
                }
            }
        }
    }
}

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
