package com.rocketgod.mayhem.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.height
import kotlin.math.roundToInt
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Bookmarks
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import kotlin.math.abs

/* The pieces the receiver faces share: Audio's tuner card and the pager hunter's are built from these. */

/** A face card: panel-to-surface gradient, an accent glow from the top edge, a hairline border. */
fun Modifier.faceCard(accent: Color, d: Dims): Modifier {
    val shape = RoundedCornerShape(d.dp(16f))
    return this.fillMaxWidth().clip(shape)
        .background(Brush.verticalGradient(listOf(Palette.panel, Palette.surface)))
        .drawBehind { drawRect(Brush.radialGradient(listOf(accent.copy(alpha = 0.18f), Color.Transparent), center = Offset(size.width / 2, 0f), radius = size.width * 0.75f)) }
        .border(1.dp, Palette.line, shape)
        .padding(horizontal = d.dp(12f), vertical = d.dp(10f))
}

/** The filled tag at the start of a face's header: the mode, or what the hunter is doing. */
@Composable
fun FaceTag(text: String, accent: Color) {
    val d = rememberDims()
    Text(text, color = inkOn(accent), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.5.sp, maxLines = 1,
        modifier = Modifier.drawBehind { drawRoundRect(accent.copy(alpha = 0.3f), Offset(-2.dp.toPx(), -2.dp.toPx()), Size(size.width + 4.dp.toPx(), size.height + 4.dp.toPx()), CornerRadius(7.dp.toPx())) }
            .background(accent, RoundedCornerShape(5.dp)).padding(horizontal = 7.dp, vertical = 2.dp))
}

/** A status lamp and its word. Lit in any colour but muted, hollow in muted; [blink] while something is searching. */
@Composable
fun Lamp(label: String, c: Color, blink: Boolean = false) {
    val d = rememberDims()
    val a by rememberInfiniteTransition(label = "lamp").animateFloat(1f, 0.25f, infiniteRepeatable(tween(500), RepeatMode.Reverse), label = "blink")
    val lit = c != Palette.muted
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).alpha(if (blink) a else 1f).then(
            if (lit) Modifier.drawBehind { drawCircle(c.copy(alpha = 0.35f), radius = size.minDimension) }.background(c, CircleShape)
            else Modifier.border(1.5.dp, c, CircleShape)))
        Text(label, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 2.sp, maxLines = 1,
            modifier = Modifier.padding(start = 6.dp))
    }
}

/**
 * The glowing digits across the card's whole width, and a warning under them when the radio can't reach the
 * frequency. A waterfall gesture in progress shows where it would land, in the second accent. ☆ and ⌨ are
 * [DialActions], in the card's header.
 */
@Composable
fun DialRow(accent: Color, freq: Long, big: Boolean = true, onTune: (Long) -> Unit = { SdrEngine.tune(it) }) {
    val d = rememberDims()
    val radio by Radio.kind.collectAsState()
    val preview = Tuning.previewHz
    val shown = preview ?: freq
    Column(Modifier.fillMaxWidth()) {
        FreqDigits(shown, big, if (preview != null) Palette.accent2 else accent, preview != null, glow = accent, modifier = Modifier.fillMaxWidth()) { onTune(it) }
        val lim = Radio.limits
        if (radio != Radio.Kind.NONE && !Radio.canTune(lim, shown))
            Text("outside this ${Radio.name}'s %d–%d MHz".format(lim.minHz / 1_000_000, lim.maxHz / 1_000_000),
                color = Palette.danger, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.fillMaxWidth().padding(top = 4.dp), maxLines = 1, textAlign = TextAlign.Center)
    }
}

/**
 * ☆ (save to FAVES, ★ once saved) and ⌨ (key a frequency in), for a face's header. An app that saves its own kind
 * of favourite passes [onStar] (and [starred]); without [onStar] there is no star, only the keypad, when [star] is off.
 */
@Composable
fun DialActions(accent: Color, freq: Long, star: Boolean = true, starred: Boolean? = null, onStar: (() -> Unit)? = null,
                onTune: (Long) -> Unit = { SdrEngine.tune(it) }) {
    val d = rememberDims()
    val mode by SdrEngine.mode.collectAsState()
    val marks by Bookmarks.list.collectAsState()
    var keying by remember { mutableStateOf(false) }
    if (keying) FreqEntryDialog(freq, accent) { f -> keying = false; if (f != null) onTune(f) }
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (star) {
            val fav = starred ?: marks.any { abs(it.hz - freq) < 50 }
            Text(if (fav) "★" else "☆", color = if (fav) Palette.accent2 else Palette.muted, fontSize = d.sp(17f),
                modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable { onStar?.invoke() ?: Bookmarks.star(freq, mode) }.padding(horizontal = d.dp(6f)))
        }
        Text("⌨", color = Palette.muted, fontSize = d.sp(16f),
            modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable { keying = true }.padding(horizontal = d.dp(6f)))
    }
}

/** One rounded bar of equal segments, the chosen one filled and lit; [tints] gives a segment its own colour. */
@Composable
fun SegBar(labels: List<String>, selected: Int, accent: Color, modifier: Modifier = Modifier, tints: List<Color?>? = null, onPick: (Int) -> Unit) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    val outer = RoundedCornerShape(d.dp(12f))
    val inner = RoundedCornerShape(d.dp(9f))
    Row(modifier.fillMaxWidth().background(Palette.surface, outer).border(1.dp, Palette.line, outer).padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        labels.forEachIndexed { i, label ->
            val on = i == selected
            val c = tints?.getOrNull(i) ?: accent
            Box(Modifier.weight(1f)
                .then(if (on) Modifier.drawBehind {
                    // a soft halo just outside the lit segment
                    drawRoundRect(c.copy(alpha = 0.28f), Offset(-2.dp.toPx(), -2.dp.toPx()), Size(size.width + 4.dp.toPx(), size.height + 4.dp.toPx()), CornerRadius(11.dp.toPx()))
                }.background(c, inner) else Modifier)
                .clip(inner)
                .clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onPick(i) }
                .padding(vertical = d.dp(8f)), contentAlignment = Alignment.Center) {
                Text(label, color = if (on) inkOn(c) else if (tints?.getOrNull(i) != null) c else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold,
                    fontSize = d.sp(12f), letterSpacing = 1.5.sp, maxLines = 1, softWrap = false)
            }
        }
    }
}

/** A small outlined pill: a status word, a programme type, a count. */
@Composable
fun Pill(text: String, c: Color) {
    val d = rememberDims()
    Text(text, color = c, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1,
        modifier = Modifier.border(1.dp, if (c == Palette.muted) Palette.line else c, RoundedCornerShape(20.dp)).padding(horizontal = 6.dp, vertical = 1.dp))
}

/** Two rings and a sweep: SCAN and the pager's AUTO hunt. It turns while [spinning]. */
@Composable
fun RadarGlyph(color: Color, spinning: Boolean, modifier: Modifier) {
    val angle by rememberInfiniteTransition(label = "radar").animateFloat(0f, 360f, infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "sweep")
    Canvas(modifier) {
        val c = center; val r = size.minDimension / 2
        val sw = maxOf(1.6.dp.toPx(), r * 0.09f)
        drawCircle(color.copy(alpha = 0.5f), r - sw / 2, c, style = Stroke(sw))
        drawCircle(color.copy(alpha = 0.7f), r * 0.5f, c, style = Stroke(sw))
        rotate(if (spinning) angle else 0f, c) { drawLine(color, c, Offset(c.x, c.y - r + sw), sw * 1.2f, StrokeCap.Round) }
        drawCircle(color, sw, c)
    }
}

/** A square outlined button holding an icon, the height of a [SegBar]. */
@Composable
fun IconBox(icon: ImageVector, description: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    val shape = RoundedCornerShape(d.dp(12f))
    Box(modifier.clip(shape).background(Palette.surface).border(1.dp, Palette.line, shape)
        .clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }
        .padding(horizontal = d.dp(10f), vertical = d.dp(8f)), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = description, tint = Palette.ink, modifier = Modifier.size(d.dp(18f)))
    }
}

/** A label at the start of a control row: FILTER, SQL, AGC. */
@Composable
fun RowLabel(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1, softWrap = false)
}

/** An on/off box the height of a [SegBar]: lit and glowing when on. Use in a row of [IntrinsicSize.Min] height. */
@Composable
fun ToggleBox(label: String, on: Boolean, accent: Color, modifier: Modifier = Modifier, dim: Boolean = false, onClick: () -> Unit) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    val shape = RoundedCornerShape(d.dp(12f))
    Box(modifier.alpha(if (dim) 0.4f else 1f)
        .then(if (on) Modifier.drawBehind {
            drawRoundRect(accent.copy(alpha = 0.28f), Offset(-2.dp.toPx(), -2.dp.toPx()), Size(size.width + 4.dp.toPx(), size.height + 4.dp.toPx()), CornerRadius(14.dp.toPx()))
        } else Modifier)
        .clip(shape).background(if (on) accent.copy(alpha = 0.24f) else Palette.surface).border(1.dp, if (on) accent else Palette.line, shape)
        .clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }
        .padding(horizontal = d.dp(12f), vertical = d.dp(8f)), contentAlignment = Alignment.Center) {
        Text(label, color = if (on) Palette.ink else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f),
            letterSpacing = 1.5.sp, maxLines = 1, softWrap = false)
    }
}

/** One tile in a [TileRow]: a name, a line under it (a range, a frequency), lit when it is where you are. */
class Tile(val title: String, val sub: String, val on: Boolean, val dim: Boolean = false)

/**
 * Tiles in one scrolling row, the lit one scrolled into view: bands, presets, channels. Each is [width] wide so a
 * row of them reads as a set; [onPick] gets the tile's index.
 */
@Composable
fun TileRow(tiles: List<Tile>, accent: Color, width: Dp = 74.dp, onPick: (Int) -> Unit) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    val scroll = rememberScrollState()
    val tileW = d.dp(width.value)
    val gap = d.dp(6f)
    val stepPx = with(LocalDensity.current) { (tileW + gap).toPx() }
    val lit = tiles.indexOfFirst { it.on }
    LaunchedEffect(lit) { if (lit >= 0) scroll.animateScrollTo(((lit - 1) * stepPx).roundToInt().coerceAtLeast(0)) }
    Row(Modifier.fillMaxWidth().scrollGlow(scroll, horizontal = true).horizontalScroll(scroll), horizontalArrangement = Arrangement.spacedBy(gap)) {
        tiles.forEachIndexed { i, t ->
            val shape = RoundedCornerShape(d.dp(12f))
            Column(Modifier.width(tileW).alpha(if (t.dim) 0.4f else 1f).clip(shape)
                .background(if (t.on) Brush.verticalGradient(listOf(accent.copy(alpha = 0.24f), Palette.surface)) else SolidColor(Palette.surface))
                .border(1.dp, if (t.on) accent else Palette.line, shape)
                .drawBehind {
                    if (t.on) {
                        val inset = 10.dp.toPx(); val h = 2.dp.toPx()
                        drawRoundRect(accent.copy(alpha = 0.35f), Offset(inset - 2.dp.toPx(), size.height - h * 3), Size(size.width - inset * 2 + 4.dp.toPx(), h * 3), CornerRadius(h * 2))
                        drawRoundRect(accent, Offset(inset, size.height - h), Size(size.width - inset * 2, h), CornerRadius(h))
                    }
                }
                .clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onPick(i) }
                .padding(horizontal = d.dp(8f), vertical = d.dp(6f))) {
                Text(t.title, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f), letterSpacing = 1.sp, maxLines = 1, softWrap = false)
                Text(t.sub, color = if (t.on) accent else Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, softWrap = false)
            }
        }
    }
}

/** Thirty-two LEDs over [frac] of full scale: blue, then green, amber and red toward the top. */
@Composable
fun LedMeter(frac: Float, accent: Color, modifier: Modifier, tick: Float? = null) {
    val d = rememberDims()
    val n = 32
    val lit = (frac * n).roundToInt().coerceIn(0, n)
    val off = Palette.line.copy(alpha = 0.7f)
    val ok = Palette.ok; val amber = Palette.accent2; val red = Palette.danger
    val ink = Palette.ink
    Canvas(modifier.height(d.dp(12f))) {
        val gap = 2.dp.toPx()
        val w = (size.width - gap * (n - 1)) / n
        val r = CornerRadius(2.dp.toPx())
        for (i in 0 until n) {
            val c = if (i >= lit) off else when { i < 14 -> accent; i < 22 -> ok; i < 28 -> amber; else -> red }
            val x = i * (w + gap)
            if (i < lit) drawRoundRect(c.copy(alpha = 0.3f), Offset(x - 1.dp.toPx(), -1.dp.toPx()), Size(w + 2.dp.toPx(), size.height + 2.dp.toPx()), r)
            drawRoundRect(c, Offset(x, 0f), Size(w, size.height), r)
        }
        // a threshold: a white mark on a dark casing, so it reads over lit and unlit LEDs alike
        if (tick != null) {
            val x = tick.coerceIn(0f, 1f) * size.width
            drawLine(Color.Black.copy(alpha = 0.6f), Offset(x, -3.dp.toPx()), Offset(x, size.height + 3.dp.toPx()), 4.dp.toPx(), StrokeCap.Round)
            drawLine(ink, Offset(x, -3.dp.toPx()), Offset(x, size.height + 3.dp.toPx()), 2.dp.toPx(), StrokeCap.Round)
        }
    }
}

/** The scale every dB meter on a [FreqCard] uses unless it has its own: 0 to 40 dB in tens. */
val DB_SCALE: List<Pair<Float, String>> = listOf(0f to "0", 0.25f to "10", 0.5f to "20", 0.75f to "30", 1f to "40 dB")

/**
 * The frequency card, the same on every app: a header (a filled [tag], a [title], ☆ and ⌨, the [lamp]), the digits
 * across the full width, a 32-LED [meter] (0..1) with an optional [tick] (a threshold, at 0..1) and its [scale],
 * then a caption line ([left] in bold, [right] muted). [digits] replaces the dial for an app that shows a range
 * instead of one frequency; [footer] is for an app's own extras (the pager's counters), under everything else.
 * [onTune] null means the dial is shown but can't be tuned (and there is no ☆ or ⌨).
 */
@Composable
fun FreqCard(
    accent: Color, tag: String, title: String, freq: Long, meter: Float, left: String, right: String,
    lamp: @Composable () -> Unit,
    titleColor: Color = Palette.muted,
    tick: Float? = null,
    scale: List<Pair<Float, String>> = DB_SCALE,
    onTune: ((Long) -> Unit)? = { SdrEngine.tune(it) },
    actions: (@Composable () -> Unit)? = null,
    rightColor: Color = Palette.muted,
    digits: (@Composable () -> Unit)? = null,
    footer: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val d = rememberDims()
    Column(Modifier.faceCard(accent, d)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            FaceTag(tag, accent)
            // a phone's header is too narrow for both: the subtitle gives way so the gain pill shows in full
            if (d.widthDp <= 480) Spacer(Modifier.weight(1f))
            else Text(title, color = titleColor, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 2.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(horizontal = d.dp(8f)))
            if (actions != null) actions() else if (onTune != null) DialActions(accent, freq, onTune = onTune)
            GainChip(accent)
            lamp()
        }
        Box(Modifier.fillMaxWidth().padding(top = d.dp(2f))) {
            when {
                digits != null -> digits()
                onTune != null -> DialRow(accent, freq, big = true, onTune = onTune)
                else -> FreqDigits(freq, true, accent, false, glow = accent, modifier = Modifier.fillMaxWidth(), onTune = null)
            }
        }
        LedMeter(meter, accent, Modifier.fillMaxWidth().padding(top = d.dp(6f)), tick = tick)
        if (scale.isNotEmpty()) BoxWithConstraints(Modifier.fillMaxWidth().height(d.dp(12f)).padding(top = 2.dp)) {
            val w = maxWidth
            for ((at, label) in scale) {
                if (at >= 0.98f) Text(label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), maxLines = 1, softWrap = false, modifier = Modifier.align(Alignment.TopEnd))
                else Text(label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), maxLines = 1, softWrap = false, modifier = Modifier.offset(x = w * at))
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = d.dp(3f)), verticalAlignment = Alignment.CenterVertically) {
            Text(left, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false))
            Spacer(Modifier.weight(0.01f))
            Text(right, color = rightColor, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.End,
                modifier = Modifier.padding(start = d.dp(8f)))
        }
        footer?.invoke(this)
    }
}

/**
 * The gain as one line ("AGC · LNA 24 VGA 50 · AMP"): MANUAL when the AGC is off, TUNER AGC while an RTL-SDR's own
 * AGC runs, AMP and BIAS-T only when on. Twin of the web app's gainSummary().
 */
fun gainSummary(rtl: Boolean, agc: Boolean, tunerAgc: Boolean, lna: Int, vga: Int, amp: Boolean, biasTee: Boolean): String {
    val who = if (rtl && tunerAgc) "TUNER AGC" else if (agc) "AGC" else "MANUAL"
    return if (rtl) "$who · GAIN ${minOf(vga, com.rocketgod.mayhem.usb.RtlSdr.MAX_GAIN_DB.toInt())} dB${if (biasTee) " · BIAS-T" else ""}"
    else "$who · LNA $lna VGA $vga${if (amp) " · AMP" else ""}"
}

/**
 * The gain in every app's card header, as a pill; a tap opens RADIO, where every gain control lives. No screen has a
 * gain row of its own.
 */
@Composable
fun GainChip(accent: Color) {
    val d = rememberDims()
    val radio by Radio.kind.collectAsState()
    val agc by SdrEngine.agc.collectAsState()
    val tunerAgc by SdrEngine.tunerAgc.collectAsState()
    val lna by SdrEngine.radioLna.collectAsState()
    val vga by SdrEngine.radioVga.collectAsState()
    val amp by SdrEngine.radioAmp.collectAsState()
    val bias by SdrEngine.biasTee.collectAsState()
    val text = gainSummary(radio == Radio.Kind.RTLSDR, agc, tunerAgc, lna, vga, amp, bias)
    val shape = RoundedCornerShape(50)
    // capped (half a phone, under a third of a wider card), so the lamp always fits beside it
    Text(text, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1,
        overflow = TextOverflow.Ellipsis, softWrap = false,
        modifier = Modifier.padding(horizontal = d.dp(6f)).widthIn(max = (d.widthDp * if (d.widthDp <= 480) 0.5f else 0.3f).dp)
            .clip(shape).background(accent.copy(alpha = 0.12f)).border(1.dp, accent.copy(alpha = 0.45f), shape)
            .clickable { RadioUi.show() }.padding(horizontal = d.dp(8f), vertical = d.dp(3f)))
}

/** Tiles in a grid of [columns], for a set that should all be in view at once (TX's modes). */
@Composable
fun TileGrid(tiles: List<Tile>, accent: Color, columns: Int = 4, onPick: (Int) -> Unit) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        for (row in tiles.withIndex().chunked(columns)) {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                for ((i, t) in row) {
                    val shape = RoundedCornerShape(d.dp(12f))
                    Column(Modifier.weight(1f).fillMaxHeight().alpha(if (t.dim) 0.4f else 1f).clip(shape)
                        .background(if (t.on) Brush.verticalGradient(listOf(accent.copy(alpha = 0.26f), Palette.surface)) else SolidColor(Palette.surface))
                        .border(1.dp, if (t.on) accent else Palette.line, shape)
                        .drawBehind {
                            if (t.on) {
                                val inset = 8.dp.toPx(); val h = 2.dp.toPx()
                                drawRoundRect(accent.copy(alpha = 0.35f), Offset(inset - 2.dp.toPx(), size.height - h * 3), Size(size.width - inset * 2 + 4.dp.toPx(), h * 3), CornerRadius(h * 2))
                                drawRoundRect(accent, Offset(inset, size.height - h), Size(size.width - inset * 2, h), CornerRadius(h))
                            }
                        }
                        .clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onPick(i) }
                        .padding(horizontal = d.dp(7f), vertical = d.dp(6f))) {
                        Text(t.title, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12.5f), maxLines = 1, softWrap = false)
                        Text(t.sub, color = if (t.on) accent else Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 1, softWrap = false)
                    }
                }
                repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** The one thing a panel does (▶ SEND, ▶ PAGE): filled in its colour and glowing, the full width it is given. */
@Composable
fun ActionButton(label: String, accent: Color, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    val shape = RoundedCornerShape(d.dp(12f))
    Box(modifier.alpha(if (enabled) 1f else 0.4f)
        .drawBehind { drawRoundRect(accent.copy(alpha = 0.3f), Offset(-3.dp.toPx(), -3.dp.toPx()), Size(size.width + 6.dp.toPx(), size.height + 6.dp.toPx()), CornerRadius(15.dp.toPx())) }
        .clip(shape).background(Brush.verticalGradient(listOf(accent, accent.copy(alpha = 0.8f))))
        .clickable(enabled = enabled) { haptic.performHapticFeedback(HapticFeedbackType.LongPress); onClick() }
        .padding(horizontal = d.dp(12f), vertical = d.dp(11f)), contentAlignment = Alignment.Center) {
        Text(label, color = inkOn(accent), fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(13f), letterSpacing = 2.sp, maxLines = 1, softWrap = false)
    }
}
