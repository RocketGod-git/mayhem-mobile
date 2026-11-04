package com.rocketgod.mayhem.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.height
import kotlin.math.roundToInt
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.width
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
fun LedMeter(frac: Float, accent: Color, modifier: Modifier) {
    val d = rememberDims()
    val n = 32
    val lit = (frac * n).roundToInt().coerceIn(0, n)
    val off = Palette.line.copy(alpha = 0.7f)
    val ok = Palette.ok; val amber = Palette.accent2; val red = Palette.danger
    Canvas(modifier.height(d.dp(10f))) {
        val gap = 2.dp.toPx()
        val w = (size.width - gap * (n - 1)) / n
        val r = CornerRadius(2.dp.toPx())
        for (i in 0 until n) {
            val c = if (i >= lit) off else when { i < 14 -> accent; i < 22 -> ok; i < 28 -> amber; else -> red }
            val x = i * (w + gap)
            if (i < lit) drawRoundRect(c.copy(alpha = 0.3f), Offset(x - 1.dp.toPx(), -1.dp.toPx()), Size(w + 2.dp.toPx(), size.height + 2.dp.toPx()), r)
            drawRoundRect(c, Offset(x, 0f), Size(w, size.height), r)
        }
    }
}
