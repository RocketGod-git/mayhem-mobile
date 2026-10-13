package com.rocketgod.mayhem.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine

fun tintFor(app: MayhemApp): Color = when (app.category) { "Receive" -> Palette.accent; "Analyze" -> Palette.accent2; "Transmit" -> Palette.danger; else -> Palette.muted }

/** The front door: a spectrum browser over the app grid; side by side when a phone is on its side. */
@Composable
fun Launcher(accent: Color) {
    val d = rememberDims()
    val side = d.wide && d.heightDp < 520
    if (side) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
        Browser(accent, Modifier.weight(1f).fillMaxHeight(), stretch = true)
        AppGrid(Modifier.weight(1.2f).fillMaxHeight())
    } else Column(Modifier.fillMaxSize()) {
        Browser(accent, Modifier.fillMaxWidth(), stretch = false)
        AppGrid(Modifier.fillMaxSize())
    }
}

/**
 * Pick a band, tap what you see, then pick the app to hear it with. A tap sets the dial the Audio app opens on, so
 * "that one" carries straight into the receiver.
 */
@Composable
private fun Browser(accent: Color, modifier: Modifier, stretch: Boolean) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val health by SdrEngine.rxHealth.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val band = bandAt(freq)
    Column(modifier) {
        WaterfallView(
            spec, SdrEngine.SPEC_BINS, accent,
            (if (stretch) Modifier.fillMaxWidth().weight(1f) else Modifier.fillMaxWidth().height(d.dp(if (d.wide) 200f else 160f))).padding(top = d.dp(6f)),
            rows = 70, traceFrac = 0.32f, labels = centredLabels(freq, SdrEngine.currentRate()),
            onPreviewFrac = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } }
        ) { frac ->
            val hz = spanHz(freq, SdrEngine.currentRate(), frac)
            SdrEngine.tune(hz); SdrEngine.setDial(hz, bandAt(hz)?.mode ?: SdrEngine.Mode.NFM)
        }
        Text(if (health.isNotEmpty()) "%.3f MHz%s · %s".format(freq / 1e6, band?.let { " · ${it.what}" } ?: "", health)
             else "no IQ yet — attach a HackRF or an RTL-SDR over USB-OTG", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f),
            modifier = Modifier.fillMaxWidth().padding(top = d.dp(4f), bottom = d.dp(4f)), maxLines = 1)
        ListenBandChips(accent, freq) { b -> SdrEngine.tune(b.centre); SdrEngine.setDial(b.centre, b.mode) }
    }
}

/** The apps by what they do: receivers, analysers, transmit, tools. 2-up on a phone, 5–6 across on a tablet. */
@Composable
private fun AppGrid(modifier: Modifier) {
    val d = rememberDims()
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = d.tileMin),
        verticalArrangement = Arrangement.spacedBy(d.dp(8f)),
        horizontalArrangement = Arrangement.spacedBy(d.dp(8f)),
        contentPadding = PaddingValues(top = d.dp(2f), bottom = d.dp(12f)),
        modifier = modifier
    ) {
        val groups = MayhemApp.entries.groupBy { it.category }
        for ((cat, apps) in listOf("Receive", "Analyze", "Transmit", "Tools").mapNotNull { c -> groups[c]?.let { c to it } }) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Text(cat.uppercase(), color = tintFor(apps.first()), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 3.sp,
                    modifier = Modifier.padding(top = d.dp(6f), start = d.dp(2f)))
            }
            items(apps) { app -> AppTile(app, d) }
        }
    }
}

@Composable
private fun AppTile(app: MayhemApp, d: Dims) {
    val tint = tintFor(app)
    // dimmed, never locked: a dongle owner may still want two-metre HAM
    Radio.kind.collectAsState().value
    val why = Radio.blockedBecause(app)
    Column(
        Modifier.fillMaxWidth().aspectRatio(1.3f).alpha(if (why.isNotEmpty()) 0.4f else 1f).panel(tint).clickable { Apps.open(app) }.padding(d.dp(12f))
    ) {
        AppGlyph(app, tint, Modifier.size(d.dp(36f)))
        Box(Modifier.weight(1f))
        Text(app.title, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(15f), maxLines = 1)
        Text(if (why.isNotEmpty()) "${Radio.name}: $why" else app.blurb, color = if (why.isNotEmpty()) Palette.accent2 else Palette.muted,
            fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 2, modifier = Modifier.padding(top = d.dp(3f)))
    }
}
