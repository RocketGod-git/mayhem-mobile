package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.ScrollableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Scanner
import com.rocketgod.mayhem.core.SdrEngine

@Composable
fun Chip(label: String, selected: Boolean, accent: Color, modifier: Modifier = Modifier, dim: Boolean = false, onClick: () -> Unit) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    Box(
        modifier.alpha(if (dim) 0.38f else 1f).control(accent, selected).clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }.padding(vertical = d.dp(9f), horizontal = d.dp(6f)),
        contentAlignment = Alignment.Center
    ) {
        // A label never wraps (FRS/GMRS used to break at the slash); one that does not fit steps its size down until it does.
        var fit by remember(label) { mutableFloatStateOf(1f) }
        Text(label, color = if (selected) inkOn(accent) else Palette.ink, fontFamily = Mono, fontSize = d.sp(12f) * fit,
            fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false,
            onTextLayout = { r -> if (r.didOverflowWidth && fit > 0.6f) fit *= 0.9f })
    }
}

/** A HackRF gain-stage stepper: [−] LABEL <value> [+]. */
@Composable
fun GainStepper(label: String, value: Int, accent: Color, modifier: Modifier, auto: Boolean = false, onMinus: () -> Unit, onPlus: () -> Unit) {
    val d = rememberDims()
    Row(modifier.control(accent, false), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f).clickable { onMinus() }.padding(vertical = d.dp(9f)), contentAlignment = Alignment.Center) {
            Text("−", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f))
        }
        Text("$label $value", color = if (auto) Palette.accent2 else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f),
            maxLines = 1, modifier = Modifier.weight(2f), textAlign = TextAlign.Center)
        Box(Modifier.weight(1f).clickable { onPlus() }.padding(vertical = d.dp(9f)), contentAlignment = Alignment.Center) {
            Text("+", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f))
        }
    }
}

/** Where a transmit control would be, on a radio that cannot transmit: says so, and what would. */
@Composable
fun ReceiveOnlyNote(accent: Color) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth().alpha(0.85f).panel(Palette.line).padding(d.dp(12f))) {
        Text("${com.rocketgod.mayhem.core.Radio.name.uppercase()} RECEIVES ONLY", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), letterSpacing = 2.sp)
        Text("Transmitting needs a HackRF. Everything that listens works on this radio.", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(top = d.dp(6f)))
    }
}

/** The HackRF's three gain stages: RF amp toggle (+14 dB) and the LNA (0..40/8) / VGA (0..62/2) steppers. */
@Composable
fun GainRow(accent: Color) {
    val d = rememberDims()
    val lna by SdrEngine.radioLna.collectAsState()
    val vga by SdrEngine.radioVga.collectAsState()
    val amp by SdrEngine.radioAmp.collectAsState()
    val agc by SdrEngine.agc.collectAsState()
    val radio by com.rocketgod.mayhem.core.Radio.kind.collectAsState()
    if (radio == com.rocketgod.mayhem.core.Radio.Kind.RTLSDR) {
        // a dongle has one tuner gain; showing an LNA and an amp that do nothing would be worse than not showing them
        SectionLabel(if (agc) "GAIN · AUTO · tap it to set it" else "GAIN · BY HAND · AGC for auto")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip(if (agc) "AGC" else "MANUAL", selected = agc, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.setAgc(!agc) }
            GainStepper("GAIN", vga, accent, Modifier.weight(2f), auto = agc,
                onMinus = { SdrEngine.setRadioVga(vga - SdrEngine.VGA_STEP) },
                onPlus = { SdrEngine.setRadioVga(vga + SdrEngine.VGA_STEP) })
        }
        return
    }
    SectionLabel(if (agc) "GAIN · AUTO · tap LNA or VGA to set it" else "GAIN · BY HAND · AGC for auto")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        Chip(if (agc) "AGC" else "MANUAL", selected = agc, accent = accent, modifier = Modifier.weight(0.8f)) { SdrEngine.setAgc(!agc) }
        Chip(if (amp) "AMP +14" else "AMP OFF", selected = amp, accent = accent, modifier = Modifier.weight(0.9f)) { SdrEngine.toggleRadioAmp() }
        GainStepper("LNA", lna, accent, Modifier.weight(1f), auto = agc,
            onMinus = { SdrEngine.setRadioLna(lna - SdrEngine.LNA_STEP) },
            onPlus = { SdrEngine.setRadioLna(lna + SdrEngine.LNA_STEP) })
        GainStepper("VGA", vga, accent, Modifier.weight(1f), auto = agc,
            onMinus = { SdrEngine.setRadioVga(vga - SdrEngine.VGA_STEP) },
            onPlus = { SdrEngine.setRadioVga(vga + SdrEngine.VGA_STEP) })
    }
}

/** Small uppercase caption above a control group. */
@Composable
fun SectionLabel(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 2.sp,
        modifier = Modifier.padding(top = d.dp(8f), bottom = d.dp(4f), start = 2.dp))
}

/** Peak-over-floor level meter, 0..45 dB → full width. */
@Composable
fun LevelBar(levelDb: Float, accent: Color, modifier: Modifier = Modifier) {
    val frac = (levelDb / 45f).coerceIn(0f, 1f)
    Box(modifier.clip(RoundedCornerShape(2.dp)).background(Palette.line)) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(frac).background(accent))
    }
}

/** Fine-tuning steppers. */
@Composable
fun StepperRow(accent: Color, steps: LongArray = longArrayOf(1_000_000L, 100_000L, 10_000L)) {
    val d = rememberDims()
    SectionLabel("TUNE · MHz")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        for (s in steps) Chip("−" + stepLabel(s), false, accent, Modifier.weight(1f)) { SdrEngine.nudge(-s) }
        for (s in steps.reversedArray()) Chip("+" + stepLabel(s), false, accent, Modifier.weight(1f)) { SdrEngine.nudge(s) }
    }
}

private fun stepLabel(hz: Long): String = when {
    hz >= 1_000_000L -> "${hz / 1_000_000L}"
    hz >= 100_000L -> ".${hz / 100_000L}"
    hz >= 10_000L -> ".0${hz / 10_000L}"
    hz >= 1_000L -> ".00${hz / 1_000L}"
    else -> ".000${hz / 100L}"
}

/** Frequency presets: label → Hz. */
@Composable
fun PresetRow(accent: Color, presets: List<Pair<String, Long>>, title: String = "PRESETS", onPick: (Long) -> Unit = { SdrEngine.tune(it) }) {
    val d = rememberDims()
    val freq by SdrEngine.freqHz.collectAsState()
    SectionLabel(title)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        for ((label, hz) in presets) Chip(label, selected = freq == hz, accent = accent, modifier = Modifier.weight(1f)) { onPick(hz) }
    }
}

/** Monospace scrolling log with striped rows. */
@Composable
fun LogList(lines: List<String>, modifier: Modifier = Modifier, empty: String = "listening…", onTap: ((String) -> Unit)? = null) {
    val d = rememberDims()
    val state = rememberLazyListState()
    Box(modifier.panel()) {
        if (lines.isEmpty()) {
            Text(empty, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(d.dp(10f)))
        } else {
            LazyColumn(Modifier.fillMaxSize().scrollGlow(state).padding(horizontal = d.dp(6f), vertical = d.dp(4f)), state = state) {
                itemsIndexed(lines) { i, l ->
                    val m = Modifier.fillMaxWidth()
                        .background(if (i % 2 == 0) Color.Transparent else Palette.panel.copy(alpha = 0.6f), RoundedCornerShape(3.dp))
                        .padding(vertical = d.dp(3f), horizontal = d.dp(4f))
                    Text(l, color = if (i == 0) Palette.ink else Palette.ink.copy(alpha = 0.82f), fontFamily = Mono, fontSize = d.sp(11f),
                        modifier = if (onTap != null) m.clickable { onTap(l) } else m)
                }
            }
        }
    }
}

/**
 * Two-pane on wide screens (visual left, controls right), stacked on phones. [visualHeightNarrow] caps the
 * visual's height when stacked (null = it takes the remaining space and the controls stay compact).
 */
@Composable
fun AdaptivePane(
    visualHeightNarrow: Dp? = null,
    visual: @Composable (Modifier) -> Unit,
    controls: @Composable ColumnScope.() -> Unit
) {
    val d = rememberDims()
    if (d.wide) {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Box(Modifier.weight(1.35f).fillMaxHeight()) { visual(Modifier.fillMaxSize()) }
            // A phone on its side is too short for a controls pane with a list or a map in it, so the pane scrolls
            // and is laid out as if it had a tablet's height: lists and maps keep real room instead of collapsing.
            BoxWithConstraints(Modifier.weight(1f).fillMaxHeight()) {
                val room = 640.dp
                if (maxHeight >= room) Column(Modifier.fillMaxSize()) { controls() }
                else { val scroll = rememberScrollState(); Column(Modifier.fillMaxWidth().scrollGlow(scroll).verticalScroll(scroll)) { Column(Modifier.fillMaxWidth().height(room)) { controls() } } }
            }
        }
    } else {
        Column(Modifier.fillMaxSize()) {
            // an upright tablet has the height for a real waterfall: at least a third of the screen
            val h = visualHeightNarrow?.let { if (d.cls != ScreenClass.COMPACT) maxOf(it, (d.heightDp * 0.32f).dp) else it }
            if (h != null) visual(Modifier.fillMaxWidth().height(h))
            else visual(Modifier.fillMaxWidth().weight(1f))
            controls()
        }
    }
}

/** A vertically scrolling controls column (for wide layouts where controls can exceed the height). */
@Composable
fun ScrollColumn(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val scroll = rememberScrollState()
    Column(modifier.scrollGlow(scroll).verticalScroll(scroll)) { content() }
}

/**
 * A soft accent glow over each edge of a scroller that has more past it, so a list says it goes on without a
 * scrollbar. Goes before the scroll modifier, so it draws on the viewport. [horizontal] for a sideways strip.
 */
fun Modifier.scrollGlow(state: ScrollableState, horizontal: Boolean = false): Modifier = drawWithContent {
    drawContent()
    val a = Palette.accent
    val depth = (if (horizontal) 18 else 16).dp.toPx()
    val edge = 1.dp.toPx()
    val stops = arrayOf(0f to a.copy(alpha = 0.22f), 0.5f to a.copy(alpha = 0.06f), 1f to Color.Transparent)
    fun glow(start: Boolean) {
        if (horizontal) {
            val x = if (start) 0f else size.width - depth
            drawRect(Brush.horizontalGradient(*stops, startX = if (start) 0f else size.width, endX = if (start) depth else size.width - depth),
                topLeft = Offset(x, 0f), size = Size(depth, size.height))
            drawRect(a.copy(alpha = 0.4f), topLeft = Offset(if (start) 0f else size.width - edge, 0f), size = Size(edge, size.height))
        } else {
            val y = if (start) 0f else size.height - depth
            drawRect(Brush.verticalGradient(*stops, startY = if (start) 0f else size.height, endY = if (start) depth else size.height - depth),
                topLeft = Offset(0f, y), size = Size(size.width, depth))
            drawRect(a.copy(alpha = 0.4f), topLeft = Offset(0f, if (start) 0f else size.height - edge), size = Size(size.width, edge))
        }
    }
    if (state.canScrollBackward) glow(true)
    if (state.canScrollForward) glow(false)
}
