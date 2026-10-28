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
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
 * The front door listens: the receiver plays here as it does in Audio, a tap tunes what you see, and the Audio app
 * opens on whatever is playing.
 */
@Composable
private fun Browser(accent: Color, modifier: Modifier, stretch: Boolean) {
    val d = rememberDims()
    val health by SdrEngine.rxHealth.collectAsState()
    val lo by SdrEngine.freqHz.collectAsState()
    val offset by SdrEngine.offsetHz.collectAsState()
    val mode by SdrEngine.mode.collectAsState()
    val freq = Tuning.previewHz ?: (lo + offset)
    val band = bandAt(freq)
    val wide = d.cls != ScreenClass.COMPACT
    // Landing in a band (sliding the span there) lights its chip and takes up the way you listen there, so a drag
    // from 93 MHz to 433 does not leave wideband FM putting a wall of noise through the speaker.
    val seen = remember { mutableStateOf(bandAt(lo)) }
    LaunchedEffect(lo) {
        val b = bandAt(lo)
        if (b != null && b !== seen.value && b.mode != SdrEngine.mode.value) SdrEngine.setMode(b.mode, silent = true)
        seen.value = b
    }
    Column(modifier) {
        ReceiverScope(accent,
            (if (stretch) Modifier.fillMaxWidth().weight(1f) else Modifier.fillMaxWidth().height(d.dp(if (d.wide) 200f else 160f))).padding(top = d.dp(6f)),
            rows = 70, traceFrac = 0.32f, wholeRange = true)
        Text(if (health.isNotEmpty()) "%.3f MHz%s%s · %s".format(freq / 1e6, if (mode == SdrEngine.Mode.NONE) "" else " ${mode.name}", band?.let { " · ${it.what}" } ?: "", health)
             else "no IQ yet — attach a HackRF or an RTL-SDR over USB-OTG", color = if (Tuning.previewHz != null) Palette.accent2 else Palette.muted,
            fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.fillMaxWidth().padding(top = d.dp(4f), bottom = d.dp(4f)), maxLines = 1)
        // a chip shows the whole band (as wide as this radio and screen take) and picks its strongest station
        ListenBandChips(accent, lo) { b ->
            SdrEngine.viewBand(b.lo, b.hi, b.mode, if (wide) 19_200_000 else 7_680_000)
            seen.value = b
            com.rocketgod.mayhem.core.AutoPick.arm()
        }
    }
}

/** Where the app list was scrolled to, kept while an app is open so coming back lands in the same place. */
private object GridSpot { var index = 0; var offset = 0 }

/** The apps by what they do: receivers, analysers, transmit, tools. 2-up on a phone, 5–6 across on a tablet. */
@Composable
private fun AppGrid(modifier: Modifier) {
    val d = rememberDims()
    var asking by remember { mutableStateOf<MayhemApp?>(null) }
    asking?.let { app -> NeedsHackRfDialog(app) { asking = null } }
    val grid = rememberLazyGridState(GridSpot.index, GridSpot.offset)
    DisposableEffect(Unit) { onDispose { GridSpot.index = grid.firstVisibleItemIndex; GridSpot.offset = grid.firstVisibleItemScrollOffset } }
    LazyVerticalGrid(
        state = grid,
        columns = GridCells.Adaptive(minSize = d.tileMin),
        verticalArrangement = Arrangement.spacedBy(d.dp(8f)),
        horizontalArrangement = Arrangement.spacedBy(d.dp(8f)),
        contentPadding = PaddingValues(top = d.dp(2f), bottom = d.dp(12f)),
        modifier = modifier
    ) {
        // The Troll app (novelty transmitters) ships only in the sideload APK, never the Play build.
        val groups = MayhemApp.entries
            .filter { it != MayhemApp.TROLL || com.rocketgod.mayhem.BuildConfig.INCLUDE_TROLL }
            .groupBy { it.category }
        for ((cat, apps) in listOf("Receive", "Analyze", "Transmit", "Tools").mapNotNull { c -> groups[c]?.let { c to it } }) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Text(cat.uppercase(), color = tintFor(apps.first()), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 3.sp,
                    modifier = Modifier.padding(top = d.dp(6f), start = d.dp(2f)))
            }
            items(apps) { app -> AppTile(app, d) { if (Radio.blockedBecause(app).isNotEmpty()) asking = app else Apps.open(app) } }
        }
    }
}

@Composable
private fun AppTile(app: MayhemApp, d: Dims, onClick: () -> Unit) {
    val tint = tintFor(app)
    // dimmed, never locked: a dongle owner may still want two-metre HAM
    Radio.kind.collectAsState().value
    val why = Radio.blockedBecause(app)
    Column(
        Modifier.fillMaxWidth().aspectRatio(1.3f).alpha(if (why.isNotEmpty()) 0.4f else 1f).panel(tint).clickable { onClick() }.padding(d.dp(12f))
    ) {
        AppGlyph(app, tint, Modifier.size(d.dp(36f)))
        Box(Modifier.weight(1f))
        Text(app.title, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(15f), maxLines = 1)
        Text(if (why.isNotEmpty()) "${Radio.name}: $why" else app.blurb, color = if (why.isNotEmpty()) Palette.accent2 else Palette.muted,
            fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 2, modifier = Modifier.padding(top = d.dp(3f)))
    }
}

/** What a dimmed tile says when tapped: why this radio cannot, what can, and a way in where part of it still works. */
@Composable
private fun NeedsHackRfDialog(app: MayhemApp, onDismiss: () -> Unit) {
    val still = when (app) {
        MayhemApp.HAM -> "Two meters, 70 cm and the bands above still work on this radio; the HF bands and FT8 at 14.074 do not."
        MayhemApp.TRANSMIT -> "Everything that listens works on this radio."
        else -> ""
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.surface, titleContentColor = Palette.ink, textContentColor = Palette.ink,
        title = { Text("${app.title} needs a HackRF", fontFamily = Mono, fontWeight = FontWeight.Bold) },
        text = { Text(listOf("${Radio.name}: ${Radio.blockedBecause(app)}.", still, Radio.HACKRF_PITCH).filter { it.isNotEmpty() }.joinToString("\n\n"), fontFamily = Mono) },
        confirmButton = {
            if (app == MayhemApp.HAM) TextButton({ onDismiss(); Apps.open(app) }) { Text("OPEN ANYWAY", color = Palette.accent, fontFamily = Mono) }
            else TextButton(onDismiss) { Text("OK", color = Palette.accent, fontFamily = Mono) }
        },
        dismissButton = { if (app == MayhemApp.HAM) TextButton(onDismiss) { Text("CANCEL", color = Palette.muted, fontFamily = Mono) } },
    )
}
