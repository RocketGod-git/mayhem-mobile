package com.rocketgod.mayhem.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.widget.Toast
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.TextStyle
import kotlinx.coroutines.delay
import kotlin.math.roundToInt
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.apps.BtleDecoder
import com.rocketgod.mayhem.core.apps.PagerDecoder
import com.rocketgod.mayhem.core.pager.PageKind
import com.rocketgod.mayhem.core.pager.PagerEngine
import com.rocketgod.mayhem.core.pager.PagerMessage
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** The readout and waterfall at their size, unless the phone is short: then they give way, capped at 30% of the
 *  screen, so the decoded feed or log under them keeps its share. */
private fun fitVisual(d: Dims, preferredDp: Float): Dp = minOf(d.dp(preferredDp), maxOf(140.dp, (d.heightDp * 0.30f).dp))

/** A preset frequency as a tile: [title] large, [sub] under it. */
private class Preset(val title: String, val sub: String, val hz: Long)

/** Presets as a tile row, the one the radio sits on lit. */
@Composable
private fun PresetTiles(accent: Color, presets: List<Preset>, width: Dp = 92.dp) {
    val freq by SdrEngine.freqHz.collectAsState()
    TileRow(presets.map { Tile(it.title, it.sub, freq == it.hz) }, accent, width) { SdrEngine.tune(presets[it].hz) }
}

/** A short muted note under a row of controls: what the app decodes, and how to get the most from it. */
@Composable
private fun AppNote(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(14f), modifier = Modifier.padding(top = d.dp(6f)))
}

/**
 * Shared layout for the packet receivers: a face card ([tag], [title], a lamp that reads LISTENING until something
 * decodes, the digits and the level) over the waterfall, then [controls], the log header and the decoded log.
 */
@Composable
private fun PacketFrame(accent: Color, log: PacketLog, tag: String, title: String, tunable: Boolean = true, roomy: Boolean = false,
                        controls: @Composable () -> Unit, list: (@Composable () -> Unit)? = null) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val level by SdrEngine.levelDb.collectAsState()
    val snap by log.snapshot.collectAsState()
    var held by remember { mutableStateOf<List<String>?>(null) }
    var full by remember { mutableStateOf(false) }
    val onPreview: (Float?) -> Unit = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } }
    val onTune: (Float) -> Unit = { frac -> SdrEngine.tune(spanHz(freq, SdrEngine.currentRate(), frac)) }
    AdaptivePane(
        // the card keeps its height; the waterfall and the log split the rest evenly
        share = true,
        face = {
            Column(Modifier.faceCard(accent, d)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    FaceTag(tag, accent)
                    Text(title, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 2.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).padding(horizontal = d.dp(8f)))
                    if (tunable) DialActions(accent, freq)
                    if (snap.total > 0) Lamp("${snap.total} DECODED", Palette.ok) else Lamp("LISTENING", Palette.accent2, blink = true)
                }
                Box(Modifier.padding(top = d.dp(2f))) {
                    if (tunable) DialRow(accent, freq, big = false)
                    else FreqDigits(freq, false, accent, false, glow = accent, modifier = Modifier.fillMaxWidth(), onTune = null)
                }
                LedMeter(level / 45f, accent, Modifier.fillMaxWidth().padding(top = d.dp(4f)))
            }
        },
        visual = { m ->
            Column(m) {
                Box(Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(d.dp(12f))).border(1.dp, Palette.line, RoundedCornerShape(d.dp(12f)))) {
                    WaterfallView(spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxSize(),
                        rows = if (d.wide) 160 else 90, traceFrac = 0.38f, labels = centredLabels(freq, SdrEngine.currentRate()),
                        onPreviewFrac = if (tunable) onPreview else null, onTapFrac = if (tunable) onTune else null)
                }
            }
        }
    ) {
        Column(Modifier.fillMaxWidth().padding(top = d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) { controls() }
        // PAUSE holds the rows still for reading; decoding carries on underneath and RESUME catches up
        val logActions: @Composable () -> Unit = {
            ToggleBox(if (held != null) "RESUME" else "PAUSE", held != null, accent, Modifier.fillMaxHeight()) { held = if (held == null) snap.lines else null }
            IconBox(ClearIcon, "Clear", Modifier.fillMaxHeight()) { log.clear(); if (held != null) held = emptyList() }
        }
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(top = d.dp(8f), bottom = d.dp(6f)), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)),
            verticalAlignment = Alignment.CenterVertically) {
            Text("${snap.total} DECODED", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 2.sp, modifier = Modifier.weight(1f))
            IconBox(FullscreenIcon, "Full screen", Modifier.fillMaxHeight()) { full = true }
            logActions()
        }
        if (list != null) list()
        LogList(held ?: snap.lines, Modifier.fillMaxWidth().weight(1f), total = if (held == null) snap.total else null, accent = accent)
        if (full) FullscreenPanel("${snap.total} DECODED", accent, onClose = { full = false }, actions = { Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) { logActions() } }) {
            LogList(held ?: snap.lines, Modifier.fillMaxWidth().weight(1f), total = if (held == null) snap.total else null, accent = accent)
        }
    }
}

@Composable
fun PagerScreen(accent: Color) {
    val multi by Apps.pagerMulti.collectAsState()
    if (multi) PagerHunterView(accent) else PagerSingleView(accent)
}

@Composable
private fun PagerSingleView(accent: Color) {
    val which by Apps.pager.which.collectAsState()
    PacketFrame(accent, Apps.pagerLog, tag = "PAGER", title = "ONE CHANNEL", roomy = true, controls = {
        val all = PagerDecoder.Which.entries
        SegBar(all.map { it.label }, all.indexOf(which), accent) { Apps.pager.select(all[it]) }
        PresetTiles(accent, listOf(Preset("929.6125", "FLEX", 929_612_500L), Preset("929.6625", "FLEX", 929_662_500L),
            Preset("931.9375", "POCSAG", 931_937_500L), Preset("466.175", "FLEX", 466_175_000L)))
    })
}

/** The multi-channel hunter: tune to a pager band and it decodes the busiest carriers in the span (AUTO), or only
 *  the ones you tap. Audio for the focused channel plays through the normal path, so the global mute rules it. */
@Composable
private fun PagerHunterView(accent: Color) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val status by PagerEngine.status.collectAsState()
    val channels by PagerEngine.channels.collectAsState()
    val messages by PagerEngine.messages.collectAsState()
    val capcodes by PagerEngine.capcodes.collectAsState()
    val filter = remember { PagerFilter() }
    var full by remember { mutableStateOf(false) }
    val onPreview: (Float?) -> Unit = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } }
    val onTune: (Float) -> Unit = { frac -> SdrEngine.tune(spanHz(freq, SdrEngine.currentRate(), frac)) }
    // a short phone drops the activity strip, so the feed keeps its room
    val spark = d.wide || d.heightDp >= 700
    AdaptivePane(
        // the card keeps its height; the waterfall and the feed split the rest evenly
        share = true,
        face = { HunterFace(accent, freq, status, channels, messages, capcodes, spark) },
        visual = { m ->
            Column(m) {
                Box(Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(d.dp(12f))).border(1.dp, Palette.line, RoundedCornerShape(d.dp(12f)))) {
                    WaterfallView(spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxSize(),
                        rows = if (d.wide) 160 else 70, traceFrac = 0.38f, labels = centredLabels(freq, SdrEngine.currentRate()),
                        onPreviewFrac = onPreview, onTapFrac = onTune)
                }
            }
        }
    ) {
        ChannelTiles(accent, channels, status)
        PagerFeed(messages, filter, accent, Modifier.fillMaxWidth().weight(1f), onFull = { full = true })
    }
    if (full) FullscreenPanel("PAGES", accent, onClose = { full = false }) {
        PagerFeed(messages, filter, accent, Modifier.fillMaxWidth().weight(1f), onFull = null)
    }
}

/**
 * The hunter's card: HUNT or PINNED and a lamp for what it is doing, the span's centre, four counters, and the last
 * half hour of pages a minute (a minute with a call-out in it is red).
 */
@Composable
private fun HunterFace(accent: Color, freq: Long, status: PagerEngine.Status, channels: List<PagerEngine.Chan>, messages: List<PagerMessage>,
                       capcodes: Int, spark: Boolean) {
    val d = rememberDims()
    val decoding = channels.count { it.listening && it.protocol.isNotEmpty() }
    val alerts = remember(messages) { messages.count { it.alert } }
    Column(Modifier.faceCard(accent, d)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            FaceTag(if (status.hunting) "HUNT" else "PINNED", accent)
            Text("FLEX · POCSAG", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 2.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(horizontal = d.dp(8f)))
            DialActions(accent, freq)
            when {
                !status.hunting -> Lamp("PINNED ${status.pinned}", Palette.ok)
                decoding > 0 -> Lamp("DECODING $decoding", Palette.ok)
                else -> Lamp("HUNTING", Palette.accent2, blink = true)
            }
        }
        Box(Modifier.padding(top = d.dp(2f), bottom = d.dp(4f))) { DialRow(accent, freq, big = false) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            StatTile("${messages.size}", "PAGES", accent, Modifier.weight(1f))
            StatTile("$capcodes", "CAPCODES", accent, Modifier.weight(1f))
            StatTile("$alerts", "CALL-OUTS", Palette.danger, Modifier.weight(1f))
            StatTile("$decoding / ${channels.size}", "CHANNELS", accent, Modifier.weight(1f))
        }
        if (spark) ActivityStrip(messages, accent, Modifier.fillMaxWidth().padding(top = d.dp(6f)))
    }
}

@Composable
private fun StatTile(value: String, label: String, c: Color, modifier: Modifier) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(10f))
    Column(modifier.clip(shape).background(Palette.paper.copy(alpha = 0.6f)).border(1.dp, Palette.line, shape).padding(horizontal = d.dp(7f), vertical = d.dp(4f))) {
        Text(value, color = if (c == Palette.danger) c else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(16f), maxLines = 1,
            style = TextStyle(shadow = Shadow(c.copy(alpha = 0.55f), blurRadius = 14f)), softWrap = false)
        Text(label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp, maxLines = 1, softWrap = false)
    }
}

/** Pages a minute over the last thirty, oldest at the left. Redraws once a minute even when nothing arrives. */
@Composable
private fun ActivityStrip(messages: List<PagerMessage>, accent: Color, modifier: Modifier) {
    val d = rememberDims()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(20_000L); now = System.currentTimeMillis() } }
    val minutes = 30
    val (counts, red) = remember(messages, now / 60_000L) {
        val c = IntArray(minutes); val r = BooleanArray(minutes)
        val end = System.currentTimeMillis()
        for (m in messages) {
            val ago = ((end - m.at) / 60_000L).toInt()
            if (ago in 0 until minutes) { val i = minutes - 1 - ago; c[i]++; if (m.alert) r[i] = true }
        }
        c to r
    }
    val top = maxOf(1, counts.maxOrNull() ?: 1)
    val line = Palette.line; val danger = Palette.danger
    Column(modifier) {
        Canvas(Modifier.fillMaxWidth().height(d.dp(12f))) {
            val gap = 2.dp.toPx()
            val w = (size.width - gap * (minutes - 1)) / minutes
            for (i in 0 until minutes) {
                val x = i * (w + gap)
                val h = if (counts[i] == 0) 2.dp.toPx() else maxOf(3.dp.toPx(), size.height * counts[i] / top)
                val c = if (counts[i] == 0) line else if (red[i]) danger else accent
                if (counts[i] > 0) drawRoundRect(c.copy(alpha = 0.3f), Offset(x - 1.dp.toPx(), size.height - h - 1.dp.toPx()), Size(w + 2.dp.toPx(), h + 1.dp.toPx()), CornerRadius(2.dp.toPx()))
                drawRoundRect(c, Offset(x, size.height - h), Size(w, h), CornerRadius(1.dp.toPx()))
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 2.dp)) {
            Text("−30 MIN", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp, modifier = Modifier.weight(1f))
            Text("PAGES / MIN", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
            Text("NOW", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp, modifier = Modifier.weight(1f), textAlign = TextAlign.End)
        }
    }
}

/** Pager display settings shared by the feed and Settings › FLEX. */
object PagerUi {
    var fold by mutableStateOf(true)
    /** Show pages that came in too damaged to read anything (hidden unless asked for). */
    var noise by mutableStateOf(false)
}

/** A page the decoder gave up on: its words were lost before anything readable came through. */
private fun unreadable(m: PagerMessage) = m.page.errors > 0 && m.page.text.isBlank() && (m.page.kind == PageKind.ALPHA || m.page.kind == PageKind.SECURE || m.page.kind == PageKind.BINARY)

/** What the MULTI feed is narrowed to. One instance serves the inline feed and the full-screen one, so both agree. */
private class PagerFilter {
    /** 0 everything · 1 pages with text · 2 call-outs only. */
    var kind by mutableIntStateOf(0)
    /** "FLEX", "POCSAG", or null for both. */
    var protocol by mutableStateOf<String?>(null)
    /** Follow one pager: only this capcode. */
    var capcode by mutableStateOf<Long?>(null)
    /** Only what came in on this channel. */
    var hz by mutableStateOf<Long?>(null)
    /** Fold the same text sent again within [FOLD_MS] into one card. One setting: the feed's pill and Settings › FLEX. */
    var fold: Boolean
        get() = PagerUi.fold
        set(v) { PagerUi.fold = v }

    fun keeps(m: PagerMessage): Boolean =
        (PagerUi.noise || !unreadable(m)) && (capcode == null || m.page.capcode == capcode) && (hz == null || m.hz == hz) &&
            (protocol == null || m.page.protocol == protocol) && when (kind) {
                1 -> m.page.kind == PageKind.ALPHA && m.page.text.isNotBlank()
                2 -> m.alert
                else -> true
            }
}

/** A card in the feed: the newest copy of a page, how many times that text came in, and to how many capcodes. */
private class PageRow(val m: PagerMessage, val repeats: Int, val capcodes: Int)

/**
 * Networks send the same text again and again — every frame of a FLEX cycle, every capcode in a fire group, a
 * dispatcher repeating a call — and one call-out can fill the screen. Folding keeps the newest copy of a text with a
 * count, so the feed reads as what was said rather than how often. Text-less pages (tones, numeric-only) never fold.
 */
private const val FOLD_MS = 120_000L

private fun foldPages(newestFirst: List<PagerMessage>, fold: Boolean): List<PageRow> {
    if (!fold) return newestFirst.map { PageRow(it, 1, 1) }
    val heads = ArrayList<PagerMessage>(); val counts = ArrayList<Int>(); val caps = ArrayList<HashSet<Long>>()
    val open = HashMap<String, Int>()
    for (m in newestFirst) {
        val t = m.page.text.trim()
        val at = if (t.isEmpty()) null else open[t]
        if (at != null && heads[at].at - m.at <= FOLD_MS) { counts[at] = counts[at] + 1; caps[at].add(m.page.capcode); continue }
        heads.add(m); counts.add(1); caps.add(hashSetOf(m.page.capcode))
        if (t.isNotEmpty()) open[t] = heads.lastIndex
    }
    return heads.indices.map { PageRow(heads[it], counts[it], caps[it].size) }
}

/**
 * The MULTI feed: what to show (ALL · TEXT · CALL-OUTS) with full screen and clear beside it, the protocol and fold
 * toggles, then page cards newest first. At the top it follows new pages; scrolled away it holds still and a pill
 * counts what has arrived. Tap a card to copy its text; tap its CAP or MHz to narrow the feed to that pager or that
 * channel, and tap the chip in the toggle row to let it go.
 */
@Composable
private fun PagerFeed(messages: List<PagerMessage>, f: PagerFilter, accent: Color, modifier: Modifier, onFull: (() -> Unit)?) {
    val d = rememberDims()
    val alerts = remember(messages) { messages.count { it.alert } }
    val flex = remember(messages) { messages.count { it.page.protocol == "FLEX" } }
    val noise = remember(messages) { messages.count(::unreadable) }
    Column(modifier) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(top = d.dp(6f)), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            SegBar(listOf("ALL ${messages.size}", "TEXT", "CALL-OUTS $alerts"), f.kind, accent, Modifier.weight(1f).fillMaxHeight(),
                tints = listOf(null, null, Palette.danger)) { f.kind = it }
            if (onFull != null) IconBox(FullscreenIcon, "Full screen", Modifier.fillMaxHeight()) { onFull() }
            IconBox(ClearIcon, "Clear", Modifier.fillMaxHeight()) { PagerEngine.clear(); f.capcode = null; f.hz = null }
        }
        // a lit toggle is shown; tapping the only one lit can't hide everything, so it lights the other again
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = d.dp(6f)),
            horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
            TogglePill("FLEX $flex", f.protocol != "POCSAG", accent) { f.protocol = if (f.protocol == null) "POCSAG" else null }
            TogglePill("POCSAG ${messages.size - flex}", f.protocol != "FLEX", accent) { f.protocol = if (f.protocol == null) "FLEX" else null }
            TogglePill("FOLD", f.fold, accent) { f.fold = !f.fold }
            if (noise > 0) TogglePill("NOISE $noise", PagerUi.noise, accent) { PagerUi.noise = !PagerUi.noise }
            f.capcode?.let { cap -> OnlyChip("CAP $cap", accent) { f.capcode = null } }
            f.hz?.let { hz -> OnlyChip("%.4f MHz".format(hz / 1e6), accent) { f.hz = null } }
        }
        val rows = remember(messages, f.kind, f.protocol, f.capcode, f.hz, f.fold, PagerUi.noise) { foldPages(messages.filter(f::keeps), f.fold) }
        if (rows.isEmpty()) {
            EmptyFeed(if (messages.isEmpty()) "hunting the span for pager carriers…\npages land here the moment one decodes"
                      else "nothing matches these filters yet", hunting = messages.isEmpty(), Modifier.fillMaxWidth().weight(1f))
        } else {
            val list = rememberLazyListState()
            val follow = rememberFollowNewest(list, rows.first().m.id)
            Box(Modifier.fillMaxWidth().weight(1f)) {
                LazyColumn(Modifier.fillMaxSize().scrollGlow(list), state = list, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    items(rows, key = { it.m.id }) { r -> PageCard(r, accent, f) }
                }
                NewestPill(follow, list, rows.count { it.m.id > follow.seen }, accent, Modifier.align(Alignment.TopCenter))
            }
        }
    }
}

@Composable
private fun EmptyFeed(text: String, hunting: Boolean, modifier: Modifier) {
    val d = rememberDims()
    val line = Palette.line
    Column(modifier.drawBehind {
        val r = 12.dp.toPx()
        drawRoundRect(line, cornerRadius = CornerRadius(r), style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 5.dp.toPx()))))
    }.padding(d.dp(16f)), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        if (hunting) RadarGlyph(Palette.accent2, true, Modifier.size(d.dp(56f)).padding(bottom = d.dp(8f)))
        Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), textAlign = TextAlign.Center)
    }
}

@Composable
private fun PageCard(r: PageRow, accent: Color, f: PagerFilter) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val m = r.m; val p = m.page
    val edge = when {
        m.alert -> Palette.danger
        p.kind == PageKind.ALPHA -> accent
        p.kind == PageKind.NUMERIC -> Palette.accent2
        else -> Palette.muted
    }
    val shape = RoundedCornerShape(d.dp(12f))
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min).clip(shape)
            .background(if (m.alert) Brush.horizontalGradient(listOf(Palette.danger.copy(alpha = 0.16f), Palette.surface), endX = 900f) else Brush.horizontalGradient(listOf(Palette.surface, Palette.surface)))
            .border(1.dp, if (m.alert) Palette.danger.copy(alpha = 0.75f) else Palette.line, shape)
            .clickable { copyPage(ctx, p.text.ifBlank { "CAP ${p.capcode}" }) }
    ) {
        // the edge glows in its colour, except for tone-only pages, which have nothing to read
        Box(Modifier.width(4.dp).fillMaxHeight().background(edge).drawBehind {
            if (edge != Palette.muted) drawRect(edge.copy(alpha = 0.35f), Offset(size.width, 0f), Size(5.dp.toPx(), size.height))
        })
        Column(Modifier.weight(1f).padding(start = d.dp(10f), end = d.dp(10f), top = d.dp(7f), bottom = d.dp(8f))) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val badge = if (m.alert) "⚠ CALL-OUT" else p.kind.label
                Text(badge, color = if (m.alert) Color.White else edge, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(10f), letterSpacing = 1.sp,
                    modifier = Modifier.background(if (m.alert) Palette.danger else if (edge == Palette.muted) Palette.panel else edge.copy(alpha = 0.2f), RoundedCornerShape(4.dp))
                        .padding(horizontal = 6.dp, vertical = 1.dp))
                Text("  " + PAGE_TIME.get()!!.format(Date(m.at)), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
                if (r.repeats > 1) Text("  ×${r.repeats}", color = Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(10f))
                // some of its words were lost on the air: the text stops where the damage began
                if (p.errors > 0 && p.text.isNotBlank()) Box(Modifier.padding(start = d.dp(6f))) { Pill("PARTIAL", Palette.accent2) }
                Spacer(Modifier.weight(1f))
                Text("${p.protocol} ${p.rate}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1)
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = d.dp(5f))) {
                val capOn = f.capcode == p.capcode
                Text("CAP ${p.capcode}" + (if (r.capcodes > 1) " +${r.capcodes - 1}" else ""),
                    color = if (capOn) inkOn(accent) else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f),
                    modifier = Modifier.clip(RoundedCornerShape(5.dp)).background(if (capOn) accent else Palette.panel)
                        .clickable { f.capcode = if (capOn) null else p.capcode }.padding(horizontal = d.dp(6f), vertical = d.dp(2f)))
                Spacer(Modifier.width(d.dp(6f)))
                val hzOn = f.hz == m.hz
                Text("%.4f".format(m.hz / 1e6), color = if (hzOn) inkOn(accent) else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f),
                    modifier = Modifier.clip(RoundedCornerShape(5.dp)).background(if (hzOn) accent else Palette.panel)
                        .clickable { f.hz = if (hzOn) null else m.hz }.padding(horizontal = d.dp(6f), vertical = d.dp(2f)))
            }
            val body = when {
                p.text.isNotBlank() -> p.text
                p.kind == PageKind.TONE -> "tone only (beep)"
                p.errors > 0 -> "unreadable: too much of it was lost on the air"
                else -> "no message"
            }
            Text(body, color = if (p.text.isBlank()) Palette.muted else Palette.ink, fontFamily = Mono, fontSize = d.sp(13.5f), lineHeight = d.sp(18f),
                modifier = Modifier.padding(top = d.dp(5f)))
        }
    }
}

/** A feed toggle: lit when what it names is shown. */
@Composable
private fun TogglePill(label: String, on: Boolean, accent: Color, onClick: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(50)
    Text(label, color = if (on) Palette.ink else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 1,
        modifier = Modifier.clip(shape).background(if (on) accent.copy(alpha = 0.2f) else Color.Transparent)
            .border(1.dp, if (on) accent else Palette.line, shape).clickable { onClick() }
            .padding(horizontal = d.dp(10f), vertical = d.dp(4f)))
}

/** The feed is narrowed to this pager or channel; ✕ lets it go. */
@Composable
private fun OnlyChip(label: String, accent: Color, onClear: () -> Unit) {
    val d = rememberDims()
    Text("$label  ✕", color = inkOn(accent), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 1,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(accent).clickable { onClear() }
            .padding(horizontal = d.dp(10f), vertical = d.dp(4f)))
}

/** Copy a page's text. Android 13 and up confirm a copy themselves; older versions get a toast. */
private fun copyPage(ctx: Context, text: String) {
    ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("page", text))
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
}

private val PAGE_TIME: ThreadLocal<SimpleDateFormat> = ThreadLocal.withInitial { SimpleDateFormat("HH:mm:ss", Locale.US) }

/**
 * The span's carriers as one scrolling row of tiles: AUTO first, then each carrier. AUTO hunts the busiest by
 * itself; tapping a carrier pins it (and plays it), tapping it again lets it go, and letting the last one go goes
 * back to AUTO. A carrier that is decoding has a pulsing dot and a lit edge; a pinned one is filled.
 */
@Composable
private fun ChannelTiles(accent: Color, channels: List<PagerEngine.Chan>, status: PagerEngine.Status) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    val pins = PagerEngine.pinnedList().toHashSet()
    val pulse by rememberInfiniteTransition(label = "live").animateFloat(1f, 0.3f, infiniteRepeatable(tween(600), RepeatMode.Reverse), label = "pulse")
    // the tiles share the tallest one's height; the intrinsic is taken inside the scroller, not across it
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = d.dp(8f))) { Row(Modifier.height(IntrinsicSize.Min),
        horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        val shape = RoundedCornerShape(d.dp(12f))
        val auto = status.hunting
        Row(Modifier.fillMaxHeight()
            .then(if (auto) Modifier.drawBehind {
                drawRoundRect(Palette.accent2.copy(alpha = 0.3f), Offset(-2.dp.toPx(), -2.dp.toPx()), Size(size.width + 4.dp.toPx(), size.height + 4.dp.toPx()), CornerRadius(14.dp.toPx()))
            } else Modifier)
            .clip(shape).background(if (auto) Palette.accent2 else Palette.surface).border(1.dp, if (auto) Palette.accent2 else Palette.line, shape)
            .clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); PagerEngine.setHunting(true) }
            .padding(horizontal = d.dp(10f), vertical = d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
            val fg = if (auto) inkOn(Palette.accent2) else Palette.ink
            RadarGlyph(fg, auto, Modifier.size(d.dp(20f)))
            Column(Modifier.padding(start = d.dp(7f))) {
                Text("AUTO", color = fg, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 1)
                Text(if (auto) "hunting" else "tap to hunt", color = fg.copy(alpha = 0.7f), fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
            }
        }
        for (c in channels) {
            val pinned = c.hz in pins
            val live = c.listening && c.protocol.isNotEmpty()
            val sub = when {
                c.protocol.isNotEmpty() -> "${c.protocol} ${c.rate}" + (if (c.pages > 0) " · ${c.pages}p" else "")
                c.listening -> "trying"
                else -> "%.0f dB".format(c.snrDb)
            }
            val bars = (c.snrDb / 6f).roundToInt().coerceIn(0, 5)
            val ok = Palette.ok; val line = Palette.line
            Column(Modifier.fillMaxHeight().clip(shape)
                .background(if (pinned) Brush.verticalGradient(listOf(accent.copy(alpha = 0.26f), Palette.surface)) else Brush.verticalGradient(listOf(Palette.surface, Palette.surface)))
                .border(1.dp, if (pinned || live) accent else Palette.line, shape)
                .drawBehind {
                    if (pinned) {
                        val inset = 10.dp.toPx(); val h = 2.dp.toPx()
                        drawRoundRect(accent.copy(alpha = 0.35f), Offset(inset - 2.dp.toPx(), size.height - h * 3), Size(size.width - inset * 2 + 4.dp.toPx(), h * 3), CornerRadius(h * 2))
                        drawRoundRect(accent, Offset(inset, size.height - h), Size(size.width - inset * 2, h), CornerRadius(h))
                    }
                }
                .clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); if (pinned) PagerEngine.unpin(c.hz) else PagerEngine.pin(c.hz) }
                .padding(horizontal = d.dp(9f), vertical = d.dp(6f))) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (live) Box(Modifier.padding(end = 5.dp).size(6.dp).alpha(pulse).drawBehind { drawCircle(ok.copy(alpha = 0.35f), radius = size.minDimension) }.background(ok, CircleShape))
                    Text("%.4f".format(c.hz / 1e6), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 1)
                }
                Text(sub, color = if (live) accent else Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, softWrap = false)
                Canvas(Modifier.padding(top = d.dp(4f)).width(d.dp(55f)).height(3.dp)) {
                    val gap = 2.dp.toPx(); val w = (size.width - gap * 4) / 5
                    for (i in 0 until 5) drawRoundRect(if (i < bars) accent else line, Offset(i * (w + gap), 0f), Size(w, size.height), CornerRadius(1.dp.toPx()))
                }
            }
        }
    }
    }
}

@Composable
fun TpmsScreen(accent: Color) {
    PacketFrame(accent, Apps.tpmsLog, tag = "TPMS", title = "TYRE SENSORS", controls = {
        PresetTiles(accent, listOf(Preset("315.000", "US", 315_000_000L), Preset("433.920", "EU", 433_920_000L)))
        AppNote("Schrader, FLM and GMC sensors. Drive past parked cars: each one repeats every minute or so.")
    })
}

@Composable
fun AcarsScreen(accent: Color) {
    PacketFrame(accent, Apps.acarsLog, tag = "ACARS", title = "AIRCRAFT DATALINK", roomy = true, controls = {
        PresetTiles(accent, listOf(Preset("131.550", "US", 131_550_000L), Preset("131.525", "EU", 131_525_000L), Preset("131.725", "EU 2", 131_725_000L),
            Preset("131.450", "JP", 131_450_000L), Preset("130.025", "US 2", 130_025_000L)))
        AppNote("Registration, flight, label and text from each message, CRC checked.")
    })
}

@Composable
fun SubGhzScreen(accent: Color) {
    val d = rememberDims()
    var wx by remember { mutableStateOf(Apps.ism.weather) }
    var rc by remember { mutableStateOf(Apps.ism.remotes) }
    var car by remember { mutableStateOf(Apps.ism.cars) }
    PacketFrame(accent, Apps.ismLog, tag = "SUB-GHZ", title = "SENSORS · REMOTES · KEYS", roomy = true, controls = {
        PresetTiles(accent, listOf(Preset("433.92", "EU · US", 433_920_000L), Preset("315.00", "US", 315_000_000L), Preset("868.35", "EU", 868_350_000L),
            Preset("915.00", "US", 915_000_000L), Preset("303.875", "US", 303_875_000L)))
        // every protocol runs at once; a family switched off is muted
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            ToggleBox("WEATHER", wx, accent, Modifier.weight(1f).fillMaxHeight()) { wx = !wx; Apps.ism.weather = wx }
            ToggleBox("REMOTES", rc, accent, Modifier.weight(1f).fillMaxHeight()) { rc = !rc; Apps.ism.remotes = rc }
            ToggleBox("CAR KEYS", car, accent, Modifier.weight(1f).fillMaxHeight()) { car = !car; Apps.ism.cars = car }
        }
    })
}

@Composable
fun ErtScreen(accent: Color) {
    val d = rememberDims()
    val rate by SdrEngine.rateHz.collectAsState()
    PacketFrame(accent, Apps.ertLog, tag = "ERT", title = "UTILITY METERS", controls = {
        PresetTiles(accent, listOf(Preset("911.6", "low", 911_600_000L), Preset("915.0", "centre", 915_000_000L), Preset("920.0", "high", 920_000_000L)))
        val why = com.rocketgod.mayhem.core.Radio.rateWhy(4_194_304)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            RowLabel("RATE")
            SegBar(listOf("2.0 Msps", "4.194 Msps"), if (rate == 4_194_304) 1 else if (rate == 2_000_000) 0 else -1, accent, Modifier.weight(1f),
                tints = listOf(null, if (why.isNotEmpty()) Palette.muted.copy(alpha = 0.45f) else null)) {
                if (it == 0) SdrEngine.setRate(2_000_000) else gated(why) { SdrEngine.setRate(4_194_304) }()
            }
        }
    })
}

@Composable
fun BtleScreen(accent: Color) {
    val freq by SdrEngine.freqHz.collectAsState()
    PacketFrame(accent, Apps.btleLog, tag = "BLE", title = "ADVERTISING", tunable = false, controls = {
        val chans = intArrayOf(37, 38, 39)
        TileRow(chans.map { ch -> val hz = BtleDecoder.channelFreq(ch); Tile("CH $ch", "${hz / 1_000_000} MHz", freq == hz) }, accent, width = 104.dp) { i ->
            val ch = chans[i]; Apps.btle.channel = ch; SdrEngine.tune(BtleDecoder.channelFreq(ch))
        }
    })
}
