package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.ScrollableState
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
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
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.rocketgod.mayhem.core.Scanner
import com.rocketgod.mayhem.core.SdrEngine
import kotlinx.coroutines.launch

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
        val bias by SdrEngine.biasTee.collectAsState()
        var warn by remember { mutableStateOf(false) }
        // a dongle has one tuner gain; showing an LNA and an amp that do nothing would be worse than not showing them
        SectionLabel(if (agc) "GAIN · AUTO · tap it to set it" else "GAIN · BY HAND · AGC for auto")
        // RTL-SDR Blog bias tee rides the same row: DC on the antenna port for an inline LNA, off by default, and the
        // first enable asks. A row of its own pushed every decoder's log a full button height down the screen.
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip(if (agc) "AGC" else "MANUAL", selected = agc, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.setAgc(!agc) }
            GainStepper("GAIN", vga, accent, Modifier.weight(1.8f), auto = agc,
                onMinus = { SdrEngine.setRadioVga(vga - SdrEngine.VGA_STEP) },
                onPlus = { SdrEngine.setRadioVga(vga + SdrEngine.VGA_STEP) })
            Chip(if (bias) "BIAS-T ON" else "BIAS-T", selected = bias, accent = accent, modifier = Modifier.weight(1.1f)) {
                if (bias) SdrEngine.setBiasTee(false) else warn = true
            }
        }
        if (warn) BiasTeeDialog(accent, onConfirm = { SdrEngine.setBiasTee(true); warn = false }, onCancel = { warn = false })
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

/** First-enable warning for the RTL-SDR bias tee — it puts DC on the antenna port and can damage the wrong gear. */
@Composable
private fun BiasTeeDialog(accent: Color, onConfirm: () -> Unit, onCancel: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        containerColor = Palette.surface,
        titleContentColor = accent,
        textContentColor = Palette.ink,
        title = { Text("Bias-tee: DC on the antenna port", fontFamily = Mono, fontWeight = FontWeight.Bold) },
        text = {
            Column {
                Text("This puts about 4.5 V DC on the dongle's antenna input to power an inline LNA.", fontFamily = Mono, modifier = Modifier.padding(bottom = 6.dp))
                Text("• Only turn it on with a bias-tee-ready LNA or feed.", fontFamily = Mono, color = Palette.muted, fontSize = 12.sp)
                Text("• Never into a plain antenna, a shorted feed, or gear that isn't DC-blocked.", fontFamily = Mono, color = Palette.muted, fontSize = 12.sp)
            }
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text("ENABLE BIAS-T", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold) } },
        dismissButton = { TextButton(onClick = onCancel) { Text("CANCEL", color = Palette.muted, fontFamily = Mono) } },
    )
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

/**
 * Monospace scrolling log with striped rows, newest at the top.
 *
 * Given the log's running [total], each row is keyed by its place in the whole history, so a reader scrolled down
 * into older lines holds still while new ones arrive above instead of having the list slide out from under them.
 * At the top it follows new lines; scrolled away, a pill counts what has come in and jumps back. Without a total
 * (a paused log, a list that is not newest-first) it is a plain list.
 */
@Composable
fun LogList(lines: List<String>, modifier: Modifier = Modifier, empty: String = "listening…", total: Int? = null,
            accent: Color = Palette.accent, onTap: ((String) -> Unit)? = null) {
    val d = rememberDims()
    val state = rememberLazyListState()
    Box(modifier.panel()) {
        if (lines.isEmpty()) {
            Text(empty, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(d.dp(10f)))
        } else {
            val follow = rememberFollowNewest(state, (total ?: 0).toLong(), enabled = total != null)
            val row: @Composable (Int, String) -> Unit = { i, l ->
                val m = Modifier.fillMaxWidth()
                    .background(if (i % 2 == 0) Color.Transparent else Palette.panel.copy(alpha = 0.6f), RoundedCornerShape(3.dp))
                    .padding(vertical = d.dp(3f), horizontal = d.dp(4f))
                Text(l, color = if (i == 0) Palette.ink else Palette.ink.copy(alpha = 0.82f), fontFamily = Mono, fontSize = d.sp(11f),
                    modifier = if (onTap != null) m.clickable { onTap(l) } else m)
            }
            LazyColumn(Modifier.fillMaxSize().scrollGlow(state).padding(horizontal = d.dp(6f), vertical = d.dp(4f)), state = state) {
                if (total != null) itemsIndexed(lines, key = { i, _ -> total - i }) { i, l -> row(i, l) }
                else itemsIndexed(lines) { i, l -> row(i, l) }
            }
            if (total != null) NewestPill(follow, state, (total - follow.seen).toInt(), accent, Modifier.align(Alignment.TopCenter))
        }
    }
}

/** Whether a newest-first list is following its newest entry, and which entry the reader last had at the top. */
class FollowNewest { var follow by mutableStateOf(true); var seen by mutableLongStateOf(0L) }

/**
 * Keep a newest-first list on its top entry while the reader is there. Only the reader's own drag away stops it —
 * the jump back up after a new entry does not — and coming back to the top starts it again. [newest] is anything
 * that grows with each new entry: an id, or a running count.
 */
@Composable
fun rememberFollowNewest(list: LazyListState, newest: Long, enabled: Boolean = true): FollowNewest {
    val f = remember { FollowNewest() }
    val dragged = list.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(list) {
        snapshotFlow { (list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset < 24) to dragged.value }
            .collect { (top, drag) -> if (top) f.follow = true else if (drag) f.follow = false }
    }
    LaunchedEffect(newest, f.follow, enabled) {
        if (!enabled || !f.follow) return@LaunchedEffect
        f.seen = newest
        if (list.firstVisibleItemIndex != 0) list.animateScrollToItem(0)
    }
    return f
}

/** "↑ 3 NEW" over a newest-first list the reader has scrolled away from; a tap goes back to the top and follows again. */
@Composable
fun NewestPill(f: FollowNewest, list: LazyListState, fresh: Int, accent: Color, modifier: Modifier = Modifier) {
    val d = rememberDims()
    val scope = rememberCoroutineScope()
    val away by remember(list) { derivedStateOf { list.firstVisibleItemIndex > 0 } }
    if (f.follow || !away) return
    Text(if (fresh > 0) "↑ $fresh NEW" else "↑ NEWEST", color = inkOn(accent), fontFamily = Mono, fontWeight = FontWeight.Bold,
        fontSize = d.sp(11f), maxLines = 1,
        modifier = modifier.padding(top = d.dp(6f)).clip(RoundedCornerShape(50)).background(accent)
            .clickable { f.follow = true; scope.launch { list.animateScrollToItem(0) } }
            .padding(horizontal = d.dp(12f), vertical = d.dp(4f)))
}

/**
 * A full-screen sheet for a log: its title, any extra [actions], CLOSE, then the content filling the rest. Back
 * closes it too. The content is the same composable the inline view uses, so filters and state carry over.
 */
@Composable
fun FullscreenPanel(title: String, accent: Color, onClose: () -> Unit, actions: @Composable RowScope.() -> Unit = {},
                    content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val d = rememberDims()
        Column(Modifier.fillMaxSize().background(Palette.paper).padding(d.dp(10f))) {
            Row(Modifier.fillMaxWidth().padding(bottom = d.dp(6f)), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                Text(title, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 2.sp,
                    maxLines = 1, modifier = Modifier.weight(1f))
                actions()
                Chip("CLOSE", selected = false, accent = accent) { onClose() }
            }
            content()
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
