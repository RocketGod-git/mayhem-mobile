package com.rocketgod.mayhem.ui

import androidx.compose.ui.composed
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.RepeatMode
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
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

/** Where a transmit control would be, on a radio that cannot transmit: says so, and what would. */
@Composable
fun ReceiveOnlyNote(accent: Color) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth().alpha(0.85f).panel(Palette.line).padding(d.dp(12f))) {
        Text("${com.rocketgod.mayhem.core.Radio.name.uppercase()} RECEIVES ONLY", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), letterSpacing = 2.sp)
        Text("Transmitting needs a HackRF. Everything that listens works on this radio.", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(top = d.dp(6f)))
    }
}

/** First-enable warning for a bias tee (RTL-SDR 4.5 V, HackRF antenna power 3.3 V): DC on the antenna port can damage the wrong gear. */
@Composable
internal fun BiasTeeDialog(accent: Color, volts: Double, radioName: String, onConfirm: () -> Unit, onCancel: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        containerColor = Palette.surface,
        titleContentColor = accent,
        textContentColor = Palette.ink,
        title = { Text("Bias-tee: DC on the antenna port", fontFamily = Mono, fontWeight = FontWeight.Bold) },
        text = {
            Column {
                Text("This puts about $volts V DC on the $radioName's antenna port to power an inline LNA.", fontFamily = Mono, modifier = Modifier.padding(bottom = 6.dp))
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

/** A [Chip]-sized button holding an icon instead of a word. */
@Composable
fun IconChip(icon: ImageVector, description: String, accent: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    Box(
        modifier.control(accent, false).clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }
            .padding(vertical = d.dp(8f), horizontal = d.dp(10f)),
        contentAlignment = Alignment.Center
    ) {
        Icon(icon, contentDescription = description, tint = Palette.ink, modifier = Modifier.size(d.dp(18f)))
    }
}

/** Material's full-screen and exit-full-screen glyphs (Apache-2.0), kept as path data so no icon library is pulled in. */
val FullscreenIcon: ImageVector by lazy { pathIcon("Fullscreen", "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z") }
/** Material's speaker glyphs: sound on, and muted. */
val SpeakerIcon: ImageVector by lazy { pathIcon("Speaker", "M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z") }
val SpeakerOffIcon: ImageVector by lazy { pathIcon("SpeakerOff", "M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z") }
/** Material's apps grid and star, for HOME and FAVES in the top bar. */
val AppsIcon: ImageVector by lazy { pathIcon("Apps", "M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z") }
val StarIcon: ImageVector by lazy { pathIcon("Star", "M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z") }
/** Material's tune (sliders) glyph, for RADIO in the top bar. */
val TuneIcon: ImageVector by lazy { pathIcon("Tune", "M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z") }
/** Material's settings gear. */
val GearIcon: ImageVector by lazy { pathIcon("Gear", "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z") }

/** One tap: Mayhem's own sound on or off. The phone's volume buttons still set how loud. */
@Composable
fun SpeakerButton(modifier: Modifier = Modifier, size: Dp = 20.dp) {
    val muted by SdrEngine.muted.collectAsState()
    val haptic = LocalHapticFeedback.current
    Box(modifier.clip(RoundedCornerShape(6.dp)).clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); SdrEngine.toggleMute() }.padding(4.dp),
        contentAlignment = Alignment.Center) {
        Icon(if (muted) SpeakerOffIcon else SpeakerIcon, contentDescription = if (muted) "Unmute" else "Mute",
            tint = if (muted) Palette.danger else Palette.muted, modifier = Modifier.size(size))
    }
}

/** Material's delete glyph, for CLEAR. */
/** A waterfall: rows of spectrum stacked over time, for the WATERFALL on / off button. */
val WaterfallIcon: ImageVector by lazy { pathIcon("Waterfall", "M3 4h18v3H3V4zm0 5h18v3H3V9zm0 5h18v2.5H3V14zm0 4.5h18V20H3v-1.5z") }
val ClearIcon: ImageVector by lazy { pathIcon("Clear", "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z") }

val FullscreenExitIcon: ImageVector by lazy { pathIcon("FullscreenExit", "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z") }

private fun pathIcon(name: String, path: String): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).addPath(addPathNodes(path), fill = SolidColor(Color.Black)).build()

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
            accent: Color = Palette.accent,
            /** An [EMPTY] key: the list waits with that app's empty state (glyph, title, tips) instead of [empty]. */
            emptyKey: String? = null, onTap: ((String) -> Unit)? = null) {
    val d = rememberDims()
    val state = rememberLazyListState()
    Box(modifier.panel()) {
        if (lines.isEmpty() && emptyKey != null && EMPTY.containsKey(emptyKey)) {
            EmptyState(emptyKey, Modifier.fillMaxSize(), accent)
        } else if (lines.isEmpty()) {
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

/** [rememberFollowNewest] for a grid of cards (a newest-first grid keeps the card it had at the top, so a card that
 *  moved up landed above the view). */
@Composable
fun rememberFollowNewest(grid: LazyGridState, newest: Long, enabled: Boolean = true): FollowNewest {
    val f = remember { FollowNewest() }
    val dragged = grid.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(grid) {
        snapshotFlow { (grid.firstVisibleItemIndex == 0 && grid.firstVisibleItemScrollOffset < 24) to dragged.value }
            .collect { (top, drag) -> if (top) f.follow = true else if (drag) f.follow = false }
    }
    LaunchedEffect(newest, f.follow, enabled) {
        if (!enabled || !f.follow) return@LaunchedEffect
        f.seen = newest
        if (grid.firstVisibleItemIndex != 0 || grid.firstVisibleItemScrollOffset != 0) grid.animateScrollToItem(0)
    }
    return f
}

/** [NewestPill] over a grid of cards. */
@Composable
fun NewestPill(f: FollowNewest, grid: LazyGridState, fresh: Int, accent: Color, modifier: Modifier = Modifier) {
    val d = rememberDims()
    val scope = rememberCoroutineScope()
    val away by remember(grid) { derivedStateOf { grid.firstVisibleItemIndex > 0 } }
    if (f.follow || !away) return
    Text(if (fresh > 0) "↑ $fresh NEW" else "↑ NEWEST", color = inkOn(accent), fontFamily = Mono, fontWeight = FontWeight.Bold,
        fontSize = d.sp(11f), maxLines = 1,
        modifier = modifier.padding(top = d.dp(6f)).clip(RoundedCornerShape(50)).background(accent)
            .clickable { f.follow = true; scope.launch { grid.animateScrollToItem(0) } }
            .padding(horizontal = d.dp(12f), vertical = d.dp(4f)))
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
 * A full-screen sheet for a log: its title, any extra [actions], the exit-full-screen button, then the content
 * filling the rest. Back closes it too. The content is the same composable the inline view uses, so filters and
 * state carry over.
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
                IconChip(FullscreenExitIcon, "Exit full screen", accent) { onClose() }
            }
            content()
        }
    }
}

/**
 * Two-pane on wide screens (visual left, controls right), stacked on phones. On a phone the waterfall always takes
 * the room nobody else needs:
 *
 *  - [share] off (controls that scroll): the controls take their own height and the visual flexes into the rest,
 *    never below [visualHeightNarrow] (or 40% of the pane); controls taller than what is left scroll.
 *  - [share] on (the controls hold a log or list with a weight): the visual and that list split what is left
 *    evenly, so a waterfall is as tall as the log beside it.
 *
 * [face] is a card that keeps its own height above the visual (the frequency card), so the even split is between
 * the waterfall and the log, not the card and the log.
 *
 * [stacked]: on a wide screen, short controls go beside the face along the top and the visual takes the full width
 * below, instead of a tall controls pane that sits mostly empty (Looking Glass, Capture).
 */
@Composable
fun AdaptivePane(
    visualHeightNarrow: Dp? = null,
    share: Boolean = false,
    face: (@Composable () -> Unit)? = null,
    stacked: Boolean = false,
    /** No waterfall at all: the controls (and their list) take its room. */
    noVisual: Boolean = false,
    visual: @Composable (Modifier) -> Unit,
    controls: @Composable ColumnScope.() -> Unit
) {
    val d = rememberDims()
    if (d.wide && stacked) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            // a list among the controls ([share]) needs a height to fill: the top gets 45%, the visual the rest
            val top = if (share) Modifier.fillMaxWidth().height(maxHeight * 0.45f) else Modifier.fillMaxWidth()
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                Row(top, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
                    Column(Modifier.weight(1.35f), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) { face?.invoke() }
                    Column(Modifier.weight(1f).then(if (share) Modifier.fillMaxHeight() else Modifier)) { controls() }
                }
                if (!noVisual) Box(Modifier.fillMaxWidth().weight(1f)) { visual(Modifier.fillMaxSize()) }
            }
        }
    } else if (d.wide) {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Column(Modifier.weight(1.35f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                face?.invoke()
                if (!noVisual) Box(Modifier.fillMaxWidth().weight(1f)) { visual(Modifier.fillMaxSize()) }
            }
            // A phone on its side is too short for a controls pane with a list or a map in it, so the pane scrolls
            // and is laid out as if it had a tablet's height: lists and maps keep real room instead of collapsing.
            BoxWithConstraints(Modifier.weight(1f).fillMaxHeight()) {
                val room = 640.dp
                if (maxHeight >= room) Column(Modifier.fillMaxSize()) { controls() }
                else { val scroll = rememberScrollState(); Column(Modifier.fillMaxWidth().scrollGlow(scroll).verticalScroll(scroll)) { Column(Modifier.fillMaxWidth().height(room)) { controls() } } }
            }
        }
    } else {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val total = maxHeight
            Column(Modifier.fillMaxSize()) {
                if (face != null) Box(Modifier.fillMaxWidth().padding(bottom = d.dp(6f))) { face() }
                if (share) {
                    if (!noVisual) visual(Modifier.fillMaxWidth().weight(1f))
                    controls()
                } else {
                    // an upright tablet has the height for a real waterfall: at least a third of the screen
                    val floor = (visualHeightNarrow ?: total * 0.4f).let { if (d.cls != ScreenClass.COMPACT) maxOf(it, (d.heightDp * 0.32f).dp) else it }
                    visual(Modifier.fillMaxWidth().weight(1f))
                    Column(Modifier.fillMaxWidth().heightIn(max = (total - floor).coerceAtLeast(0.dp))) { controls() }
                }
            }
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
fun Modifier.scrollGlow(state: ScrollableState, horizontal: Boolean = false): Modifier = composed {
    // the glow breathes, so an edge with more past it catches the eye without an arrow in the way
    val pulse by rememberInfiniteTransition(label = "glow").animateFloat(0.55f, 1f, infiniteRepeatable(tween(1100), RepeatMode.Reverse), label = "breath")
    drawWithContent {
    drawContent()
    val a = Palette.accent
    val depth = (if (horizontal) 22 else 18).dp.toPx()
    val edge = (if (horizontal) 2 else 1).dp.toPx()
    val stops = arrayOf(0f to a.copy(alpha = 0.34f * pulse), 0.5f to a.copy(alpha = 0.10f * pulse), 1f to Color.Transparent)
    fun glow(start: Boolean) {
        if (horizontal) {
            val x = if (start) 0f else size.width - depth
            drawRect(Brush.horizontalGradient(*stops, startX = if (start) 0f else size.width, endX = if (start) depth else size.width - depth),
                topLeft = Offset(x, 0f), size = Size(depth, size.height))
            drawRect(a.copy(alpha = 0.75f * pulse), topLeft = Offset(if (start) 0f else size.width - edge, 0f), size = Size(edge, size.height))
        } else {
            val y = if (start) 0f else size.height - depth
            drawRect(Brush.verticalGradient(*stops, startY = if (start) 0f else size.height, endY = if (start) depth else size.height - depth),
                topLeft = Offset(0f, y), size = Size(size.width, depth))
            drawRect(a.copy(alpha = 0.6f * pulse), topLeft = Offset(0f, if (start) 0f else size.height - edge), size = Size(size.width, edge))
        }
    }
    if (state.canScrollBackward) glow(true)
    if (state.canScrollForward) glow(false)
    }
}
