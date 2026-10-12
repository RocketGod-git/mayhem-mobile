package com.rocketgod.mayhem.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.SdrEngine

fun tintFor(app: MayhemApp): Color = when (app.category) { "Receive" -> Palette.accent; "Analyze" -> Palette.accent2; "Transmit" -> Palette.danger; else -> Palette.muted }

/** Mayhem's app grid, sized to the screen: 2-up tiles on a phone, 5–6 across on a tablet. */
@Composable
fun Launcher(accent: Color) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val health by SdrEngine.rxHealth.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    Column(Modifier.fillMaxSize()) {
        WaterfallView(
            spec, SdrEngine.SPEC_BINS, accent,
            Modifier.fillMaxWidth().height(d.dp(if (d.wide) 200f else 180f)).padding(top = d.dp(6f)),
            rows = 70, traceFrac = 0.32f, labels = centredLabels(freq, SdrEngine.currentRate())
        )
        Text(if (health.isNotEmpty()) health else "no IQ yet — attach a HackRF over USB-OTG", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f),
            modifier = Modifier.fillMaxWidth().padding(top = d.dp(4f), bottom = d.dp(6f)), maxLines = 1)
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = d.tileMin),
            verticalArrangement = Arrangement.spacedBy(d.dp(8f)),
            horizontalArrangement = Arrangement.spacedBy(d.dp(8f)),
            contentPadding = PaddingValues(bottom = d.dp(12f)),
            modifier = Modifier.fillMaxSize()
        ) {
            items(MayhemApp.values().toList()) { app -> AppTile(app, d) }
        }
    }
}

@Composable
private fun AppTile(app: MayhemApp, d: Dims) {
    val tint = tintFor(app)
    Column(
        Modifier.fillMaxWidth().aspectRatio(1.3f).panel(tint).clickable { Apps.open(app) }.padding(d.dp(12f))
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Top) {
            AppGlyph(app, tint, Modifier.size(d.dp(36f)))
            Text(app.category.uppercase(), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 2.sp)
        }
        Box(Modifier.weight(1f))
        Text(app.title, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(15f), maxLines = 1)
        Text(app.blurb, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 2, modifier = Modifier.padding(top = d.dp(3f)))
    }
}
