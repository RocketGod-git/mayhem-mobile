package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.geometry.Offset
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.AppVisibility
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.NavBar
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine

fun tintFor(app: MayhemApp): Color = when (app.category) { "Receive" -> Palette.accent; "Analyze" -> Palette.accent2; "Transmit" -> Palette.danger; else -> Palette.muted }

/**
 * The front door: a spectrum browser over the app grid; side by side when a phone is on its side. On a tablet the
 * apps ride one sideways row along the bottom, so the waterfall takes all the height above it.
 */
@Composable
fun Launcher(accent: Color) {
    val d = rememberDims()
    val side = d.wide && d.heightDp < 520
    if (d.cls != ScreenClass.COMPACT && !side) Column(Modifier.fillMaxSize()) {
        Browser(accent, Modifier.fillMaxWidth().weight(1f), stretch = true)
        AppRail(Modifier.fillMaxWidth().padding(top = d.dp(6f)))
    } else if (side) Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
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
            (if (stretch) Modifier.fillMaxWidth().weight(1f) else Modifier.fillMaxWidth().height(d.dp(if (d.wide) 200f else 240f))).padding(top = if (stretch) 0.dp else d.dp(6f)),
            rows = 70, traceFrac = 0.32f, wholeRange = true)
        Row(Modifier.fillMaxWidth().padding(top = d.dp(4f), bottom = d.dp(4f)), verticalAlignment = Alignment.CenterVertically) {
            Text(if (health.isNotEmpty()) "%.3f MHz%s%s · %s".format(freq / 1e6, if (mode == SdrEngine.Mode.NONE) "" else " ${mode.name}", band?.let { " · ${it.what}" } ?: "", health)
                 else "no IQ yet, attach a HackRF or an RTL-SDR over USB-OTG, or connect one on your network in RADIO", color = if (Tuning.previewHz != null) Palette.accent2 else Palette.muted,
                fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.weight(1f), maxLines = 1)
        }
        // a chip shows the whole band (as wide as this radio and screen take) and picks its strongest station
        ListenBandChips(accent, lo) { b ->
            SdrEngine.viewBand(b.lo, b.hi, b.mode, if (wide) 19_200_000 else 7_680_000)
            seen.value = b
            com.rocketgod.mayhem.core.AutoPick.arm()
        }
        // Home plays the tuned FM, so it gets its own volume and mute like Audio and HD.
        Box(Modifier.fillMaxWidth().padding(top = d.dp(4f))) { VolumeMuteCard("home", accent) }
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
    val kind by Radio.kind.collectAsState()
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
        // The Troll app (novelty transmitters) ships only in the sideload APK, never the Play build; an RTL-SDR hides
        // both transmit apps (AppVisibility).
        val groups = MayhemApp.entries
            .filter { (it != MayhemApp.TROLL || com.rocketgod.mayhem.BuildConfig.INCLUDE_TROLL) && it.barKey() == it && !AppVisibility.hidden(it, kind) }
            .groupBy { it.category }
        for ((cat, apps) in listOf("Receive", "Analyze", "Transmit", "Tools").mapNotNull { c -> groups[c]?.let { c to it } }) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Text(cat.uppercase(), color = tintFor(apps.first()), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 3.sp,
                    modifier = Modifier.padding(top = d.dp(6f), start = d.dp(2f)))
            }
            items(apps) { app -> AppTile(app, d) { if (Radio.blockedBecause(app).isNotEmpty()) asking = app else Apps.openPicked(app) } }
        }
    }
}

/** Where the tablet's app row was scrolled to, kept while an app is open so coming back lands in the same place. */
private object RailSpot { var x = 0 }

/** The apps as one sideways row (tablet home): each group's name over its tiles, the same tiles as the grid. */
@Composable
private fun AppRail(modifier: Modifier) {
    val d = rememberDims()
    var asking by remember { mutableStateOf<MayhemApp?>(null) }
    asking?.let { app -> NeedsHackRfDialog(app) { asking = null } }
    val scroll = rememberScrollState(RailSpot.x)
    DisposableEffect(Unit) { onDispose { RailSpot.x = scroll.value } }
    val kind by Radio.kind.collectAsState()
    // The Troll app (novelty transmitters) ships only in the sideload APK, never the Play build; an RTL-SDR hides
    // both transmit apps (AppVisibility).
    val groups = MayhemApp.entries
        .filter { (it != MayhemApp.TROLL || com.rocketgod.mayhem.BuildConfig.INCLUDE_TROLL) && it.barKey() == it && !AppVisibility.hidden(it, kind) }
        .groupBy { it.category }
    Row(modifier.scrollGlow(scroll, horizontal = true).horizontalScroll(scroll).padding(bottom = d.dp(6f)),
        horizontalArrangement = Arrangement.spacedBy(d.dp(14f))) {
        for ((cat, apps) in listOf("Receive", "Analyze", "Transmit", "Tools").mapNotNull { c -> groups[c]?.let { c to it } }) {
            Column(verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                Text(cat.uppercase(), color = tintFor(apps.first()), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 3.sp,
                    modifier = Modifier.padding(start = d.dp(2f)))
                Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    for (app in apps) Box(Modifier.width(d.tileMin)) {
                        AppTile(app, d) { if (Radio.blockedBecause(app).isNotEmpty()) asking = app else Apps.openPicked(app) }
                    }
                }
            }
        }
    }
}

@Composable
private fun AppTile(app: MayhemApp, d: Dims, onClick: () -> Unit) {
    val tint = tintFor(app)
    // dimmed, never locked: a dongle owner may still want two-metre HAM
    Radio.kind.collectAsState().value
    val why = Radio.blockedBecause(app)
    val off = why.isNotEmpty()
    // a tile this radio can't run stays crisp (a faded tile read as broken): its glyph and name go gray, a small amber
    // HACKRF chip says why, and a tap still explains
    val glyphTint = if (off) Palette.muted.copy(alpha = 0.7f) else tint
    val shape = RoundedCornerShape(d.dp(12f))
    // wide and short: the glyph in its badge, then the name over a one-line description, with no tall gap between
    Box(
        Modifier.fillMaxWidth().aspectRatio(1.8f).clip(shape)
            .background(Palette.surface, shape)
            // the category's color glows in from the top-left corner
            .background(Brush.radialGradient(listOf(glyphTint.copy(alpha = if (off) 0.05f else 0.16f), Color.Transparent),
                center = Offset.Zero, radius = 900f), shape)
            .border(1.dp, Brush.linearGradient(listOf(glyphTint.copy(alpha = if (off) 0.35f else 0.85f), glyphTint.copy(alpha = if (off) 0.12f else 0.25f))), shape)
            .clickable { onClick() }
    ) {
        // the glyph again, large and faint, bleeding off the bottom-right corner
        AppGlyph(app, glyphTint.copy(alpha = if (off) 0.04f else 0.08f),
            Modifier.size(d.dp(84f)).align(Alignment.BottomEnd).offset(x = d.dp(18f), y = d.dp(18f)))
        if (off) Text("HACKRF", color = Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8f), letterSpacing = 1.5.sp,
            modifier = Modifier.align(Alignment.TopEnd).padding(d.dp(10f)).clip(RoundedCornerShape(4.dp))
                .background(Palette.accent2.copy(alpha = 0.14f)).border(1.dp, Palette.accent2.copy(alpha = 0.5f), RoundedCornerShape(4.dp))
                .padding(horizontal = d.dp(5f), vertical = d.dp(2f)))
        Column(Modifier.fillMaxSize().padding(d.dp(12f))) {
            Box(Modifier.size(d.dp(40f)).clip(RoundedCornerShape(d.dp(10f))).background(glyphTint.copy(alpha = if (off) 0.06f else 0.14f))
                .border(1.dp, glyphTint.copy(alpha = if (off) 0.2f else 0.4f), RoundedCornerShape(d.dp(10f))), contentAlignment = Alignment.Center) {
                AppGlyph(app, glyphTint, Modifier.size(d.dp(26f)))
            }
            Box(Modifier.weight(1f))
            // the two-word names (Flight Messages, Weather Balloons) step down a size so they fit a phone's two-across tile whole
            Text(app.title, color = if (off) Palette.muted else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold,
                fontSize = d.sp(if (app.title.length > 12) 13f else 15f), maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
            Text(if (off) "needs a HackRF" else app.blurb, color = Palette.muted,
                fontFamily = Mono, fontSize = d.sp(9.5f), minLines = 2, maxLines = 2, lineHeight = d.sp(11.5f), modifier = Modifier.padding(top = d.dp(3f)))
        }
    }
}

/** What a dimmed tile says when tapped: why this radio cannot, what can, and a way in where part of it still works. */
@Composable
internal fun NeedsHackRfDialog(app: MayhemApp, onDismiss: () -> Unit) {
    val still = when (app) {
        MayhemApp.TRANSMIT -> "Everything that listens works on this radio."
        else -> ""
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.surface, titleContentColor = Palette.ink, textContentColor = Palette.ink,
        title = { Text("${app.title} needs a HackRF", fontFamily = Mono, fontWeight = FontWeight.Bold) },
        text = { Text(listOf("${Radio.name}: ${Radio.blockedBecause(app)}.", still, Radio.HACKRF_PITCH).filter { it.isNotEmpty() }.joinToString("\n\n"), fontFamily = Mono) },
        confirmButton = {
            TextButton(onDismiss) { Text("OK", color = Palette.accent, fontFamily = Mono) }
        },
    )
}
