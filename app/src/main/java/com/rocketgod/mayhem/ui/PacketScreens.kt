package com.rocketgod.mayhem.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.widget.Toast
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

/** Shared layout for the packet receivers: readout + waterfall (visual pane), controls, count, decoded log. */
@Composable
private fun PacketFrame(accent: Color, log: PacketLog, tunable: Boolean = true, roomy: Boolean = false, controls: @Composable () -> Unit, list: (@Composable () -> Unit)? = null) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val health by SdrEngine.rxHealth.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val snap by log.snapshot.collectAsState()
    var held by remember { mutableStateOf<List<String>?>(null) }
    var full by remember { mutableStateOf(false) }
    val onPreview: (Float?) -> Unit = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } }
    val onTune: (Float) -> Unit = { frac -> SdrEngine.tune(spanHz(freq, SdrEngine.currentRate(), frac)) }
    AdaptivePane(
        // a screen that gave up its tune steppers gets their height back as bigger digits and more waterfall
        visualHeightNarrow = d.dp(if (roomy) 250f else 190f),
        visual = { m ->
            Column(m) {
                FreqReadout(accent, if (health.isNotEmpty()) health else "waiting for IQ…", big = d.wide || roomy)
                WaterfallView(spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)),
                    rows = if (d.wide) 160 else 70, traceFrac = 0.35f, labels = centredLabels(freq, SdrEngine.currentRate()),
                    onPreviewFrac = if (tunable) onPreview else null, onTapFrac = if (tunable) onTune else null)
            }
        }
    ) {
        controls()
        // PAUSE holds the rows still for reading; decoding carries on underneath and RESUME catches up
        val logActions: @Composable () -> Unit = {
            Chip(if (held != null) "RESUME" else "PAUSE", selected = held != null, accent = accent) { held = if (held == null) snap.lines else null }
            Spacer(Modifier.width(d.dp(4f)))
            Chip("CLEAR", selected = false, accent = accent) { log.clear(); if (held != null) held = emptyList() }
        }
        Row(Modifier.fillMaxWidth().padding(top = d.dp(8f), bottom = d.dp(4f)), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("${snap.total} DECODED", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 2.sp, modifier = Modifier.weight(1f))
            IconChip(FullscreenIcon, "Full screen", accent) { full = true }
            Spacer(Modifier.width(d.dp(4f)))
            logActions()
        }
        if (list != null) list()
        LogList(held ?: snap.lines, Modifier.fillMaxWidth().weight(1f), total = if (held == null) snap.total else null, accent = accent)
        if (full) FullscreenPanel("${snap.total} DECODED", accent, onClose = { full = false }, actions = { logActions() }) {
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
    val d = rememberDims()
    val which by Apps.pager.which.collectAsState()
    PacketFrame(accent, Apps.pagerLog, roomy = true, controls = {
        Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (w in PagerDecoder.Which.entries) Chip(w.label, selected = which == w, accent = accent, modifier = Modifier.weight(1f)) { Apps.pager.select(w) }
        }
        PresetRow(accent, listOf("929.6125" to 929_612_500L, "929.6625" to 929_662_500L, "931.9375" to 931_937_500L, "466.175" to 466_175_000L), title = "CHANNEL · MHz")
    })
}

/** The multi-channel hunter: tune to a pager band and it decodes the busiest carriers in the span (AUTO), or only
 *  the ones you tap. Audio for the focused channel plays through the normal path, so the global mute rules it. */
@Composable
private fun PagerHunterView(accent: Color) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val health by SdrEngine.rxHealth.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val status by PagerEngine.status.collectAsState()
    val channels by PagerEngine.channels.collectAsState()
    val messages by PagerEngine.messages.collectAsState()
    val capcodes by PagerEngine.capcodes.collectAsState()
    val filter = remember { PagerFilter() }
    var full by remember { mutableStateOf(false) }
    val onPreview: (Float?) -> Unit = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } }
    val onTune: (Float) -> Unit = { frac -> SdrEngine.tune(spanHz(freq, SdrEngine.currentRate(), frac)) }
    AdaptivePane(
        visualHeightNarrow = d.dp(250f),
        visual = { m ->
            Column(m) {
                FreqReadout(accent, if (health.isNotEmpty()) health else "waiting for IQ…", big = true)
                WaterfallView(spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)),
                    rows = if (d.wide) 160 else 70, traceFrac = 0.35f, labels = centredLabels(freq, SdrEngine.currentRate()),
                    onPreviewFrac = onPreview, onTapFrac = onTune)
            }
        }
    ) {
        ChannelPills(accent, channels, status)
        PagerFeed(messages, capcodes, filter, accent, Modifier.fillMaxWidth().weight(1f), onFull = { full = true })
    }
    if (full) FullscreenPanel("PAGES", accent, onClose = { full = false }) {
        PagerFeed(messages, capcodes, filter, accent, Modifier.fillMaxWidth().weight(1f), onFull = null)
    }
}

/** Pager display settings shared by the feed and Settings › FLEX. */
object PagerUi { var fold by mutableStateOf(true) }

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
        (capcode == null || m.page.capcode == capcode) && (hz == null || m.hz == hz) &&
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
 * The MULTI feed: totals, filter pills, then page cards newest first. At the top it follows new pages; scrolled
 * away it holds still and a pill counts what has arrived. Tap a card to copy its text; tap its CAP or MHz to
 * narrow the feed to that pager or that channel, and tap the pill above to let it go.
 */
@Composable
private fun PagerFeed(messages: List<PagerMessage>, capcodes: Int, f: PagerFilter, accent: Color, modifier: Modifier, onFull: (() -> Unit)?) {
    val d = rememberDims()
    val alerts = remember(messages) { messages.count { it.alert } }
    val flex = remember(messages) { messages.count { it.page.protocol == "FLEX" } }
    Column(modifier) {
        Row(Modifier.fillMaxWidth().padding(top = d.dp(8f), bottom = d.dp(4f)), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            Text("$capcodes CAPCODES · ${messages.size} PAGES", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold,
                fontSize = d.sp(11f), letterSpacing = 2.sp, maxLines = 1, modifier = Modifier.weight(1f))
            if (onFull != null) IconChip(FullscreenIcon, "Full screen", accent) { onFull() }
            Chip("CLEAR", selected = false, accent = accent) { PagerEngine.clear(); f.capcode = null; f.hz = null }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = d.dp(4f)),
            horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
            FilterPill("ALL ${messages.size}", f.kind == 0, accent) { f.kind = 0 }
            FilterPill("TEXT", f.kind == 1, accent) { f.kind = 1 }
            FilterPill("CALL-OUTS $alerts", f.kind == 2, Palette.danger) { f.kind = 2 }
            FilterPill("FLEX $flex", f.protocol == "FLEX", accent) { f.protocol = if (f.protocol == "FLEX") null else "FLEX" }
            FilterPill("POCSAG ${messages.size - flex}", f.protocol == "POCSAG", accent) { f.protocol = if (f.protocol == "POCSAG") null else "POCSAG" }
            FilterPill("FOLD REPEATS", f.fold, accent) { f.fold = !f.fold }
        }
        val cap = f.capcode; val hz = f.hz
        if (cap != null || hz != null) {
            Row(Modifier.fillMaxWidth().padding(bottom = d.dp(4f)), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
                Text("ONLY", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 1.sp)
                if (cap != null) FilterPill("CAP $cap  ×", true, accent) { f.capcode = null }
                if (hz != null) FilterPill("%.4f MHz  ×".format(hz / 1e6), true, accent) { f.hz = null }
            }
        }
        val rows = remember(messages, f.kind, f.protocol, f.capcode, f.hz, f.fold) { foldPages(messages.filter(f::keeps), f.fold) }
        if (rows.isEmpty()) {
            Box(Modifier.fillMaxWidth().weight(1f).panel(), contentAlignment = Alignment.Center) {
                Text(if (messages.isEmpty()) "listening…\npages show up here the moment a channel in the span sends one"
                     else "nothing matches these filters yet",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), textAlign = TextAlign.Center, modifier = Modifier.padding(d.dp(10f)))
            }
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
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min).clip(shape).background(Palette.surface)
            .then(if (m.alert) Modifier.border(1.dp, Palette.danger.copy(alpha = 0.8f), shape) else Modifier)
            .clickable { copyPage(ctx, p.text.ifBlank { "CAP ${p.capcode}" }) }
    ) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(edge))
        Column(Modifier.weight(1f).padding(horizontal = d.dp(8f), vertical = d.dp(6f))) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (m.alert) "CALL-OUT" else p.kind.label, color = if (m.alert) Palette.danger else accent, fontFamily = Mono,
                    fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp)
                Text("  " + PAGE_TIME.get()!!.format(Date(m.at)), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
                if (r.repeats > 1) Text("  ×${r.repeats}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
                Spacer(Modifier.weight(1f))
                Text("${p.protocol} ${p.rate}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1)
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = d.dp(2f))) {
                val capOn = f.capcode == p.capcode
                Text("CAP ${p.capcode}" + (if (r.capcodes > 1) " +${r.capcodes - 1}" else ""),
                    color = if (capOn) inkOn(accent) else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f),
                    modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(if (capOn) accent else Palette.panel)
                        .clickable { f.capcode = if (capOn) null else p.capcode }.padding(horizontal = d.dp(5f), vertical = d.dp(2f)))
                Spacer(Modifier.width(d.dp(6f)))
                val hzOn = f.hz == m.hz
                Text("%.4f MHz".format(m.hz / 1e6), color = if (hzOn) inkOn(accent) else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f),
                    modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(if (hzOn) accent else Palette.panel)
                        .clickable { f.hz = if (hzOn) null else m.hz }.padding(horizontal = d.dp(5f), vertical = d.dp(2f)))
            }
            val body = when {
                p.text.isNotBlank() -> p.text
                p.kind == PageKind.TONE -> "tone only (beep)"
                else -> "no message"
            }
            Text(body, color = if (p.text.isBlank()) Palette.muted else Palette.ink, fontFamily = Mono, fontSize = d.sp(13f),
                modifier = Modifier.padding(top = d.dp(4f)))
        }
    }
}

@Composable
private fun FilterPill(label: String, on: Boolean, color: Color, onClick: () -> Unit) {
    val d = rememberDims()
    Text(label, color = if (on) inkOn(color) else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(if (on) color else Palette.surface)
            .border(1.dp, color.copy(alpha = 0.6f), RoundedCornerShape(50)).clickable { onClick() }
            .padding(horizontal = d.dp(10f), vertical = d.dp(5f)))
}

/** Copy a page's text. Android 13 and up confirm a copy themselves; older versions get a toast. */
private fun copyPage(ctx: Context, text: String) {
    ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("page", text))
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(ctx, "Copied", Toast.LENGTH_SHORT).show()
}

private val PAGE_TIME: ThreadLocal<SimpleDateFormat> = ThreadLocal.withInitial { SimpleDateFormat("HH:mm:ss", Locale.US) }

/**
 * The span's carriers as one scrolling row: AUTO first, then each carrier. AUTO hunts the busiest by itself;
 * tapping a carrier pins it (and plays it), tapping it again lets it go, and letting the last one go goes back to
 * AUTO. A carrier that is decoding has a lit edge; a pinned one is filled. One row instead of a list keeps the
 * feed below it the room it needs.
 */
@Composable
private fun ChannelPills(accent: Color, channels: List<PagerEngine.Chan>, status: PagerEngine.Status) {
    val d = rememberDims()
    val pins = PagerEngine.pinnedList().toHashSet()
    Row(Modifier.fillMaxWidth().padding(top = d.dp(10f), bottom = d.dp(4f)), verticalAlignment = Alignment.CenterVertically) {
        Text("CHANNELS", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 2.sp)
        Text("  ·  ${status.text}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        ChanPill("AUTO", "hunt", on = status.hunting, live = false, accent = accent) { PagerEngine.setHunting(true) }
        for (c in channels) {
            val pinned = c.hz in pins
            val sub = when {
                c.protocol.isNotEmpty() -> "${c.protocol} ${c.rate}" + (if (c.pages > 0) " · ${c.pages}p" else "")
                c.listening -> "trying"
                else -> "%.0f dB".format(c.snrDb)
            }
            ChanPill("%.4f".format(c.hz / 1e6), sub, on = pinned, live = c.listening && c.protocol.isNotEmpty(), accent = accent) {
                if (pinned) PagerEngine.unpin(c.hz) else PagerEngine.pin(c.hz)
            }
        }
    }
}

@Composable
private fun ChanPill(title: String, sub: String, on: Boolean, live: Boolean, accent: Color, onClick: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(8.dp)
    Column(
        Modifier.clip(shape).background(if (on) accent.copy(alpha = 0.22f) else Palette.surface)
            .border(if (on || live) 1.5.dp else 1.dp, if (on || live) accent else Palette.line, shape)
            .clickable { onClick() }.padding(horizontal = d.dp(10f), vertical = d.dp(5f))
    ) {
        Text(title, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1)
        Text(sub, color = if (live) accent else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1)
    }
}

@Composable
fun TpmsScreen(accent: Color) {
    PacketFrame(accent, Apps.tpmsLog, controls = {
        PresetRow(accent, listOf("315.000 · US" to 315_000_000L, "433.920 · EU" to 433_920_000L), title = "BAND · MHz")
        SectionLabel("DECODES · FSK 19.2k Schrader FLM 64/72/80 · OOK 8.192k Schrader · OOK 8.4k GMC — drive past parked cars, readings repeat every minute or so")
    })
}

@Composable
fun AcarsScreen(accent: Color) {
    PacketFrame(accent, Apps.acarsLog, roomy = true, controls = {
        PresetRow(accent, listOf("131.550 US" to 131_550_000L, "131.525 EU" to 131_525_000L, "131.725 EU2" to 131_725_000L, "131.450 JP" to 131_450_000L, "130.025" to 130_025_000L), title = "CHANNEL · MHz")
        SectionLabel("AM · 2400 bps MSK · registration, label, block, message number, flight, text · CRC-16 checked")
    })
}

@Composable
fun SubGhzScreen(accent: Color) {
    val d = rememberDims()
    var wx by remember { mutableStateOf(Apps.ism.weather) }
    var rc by remember { mutableStateOf(Apps.ism.remotes) }
    var car by remember { mutableStateOf(Apps.ism.cars) }
    PacketFrame(accent, Apps.ismLog, roomy = true, controls = {
        PresetRow(accent, listOf("433.92" to 433_920_000L, "315.00" to 315_000_000L, "868.35" to 868_350_000L, "915.00" to 915_000_000L, "303.875" to 303_875_000L), title = "BAND · MHz")
        SectionLabel("FAMILIES · every protocol runs at once; tap to mute a family")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip("WEATHER 26", selected = wx, accent = accent, modifier = Modifier.weight(1f)) { wx = !wx; Apps.ism.weather = wx }
            Chip("REMOTES 47", selected = rc, accent = accent, modifier = Modifier.weight(1f)) { rc = !rc; Apps.ism.remotes = rc }
            Chip("CAR KEYS 11", selected = car, accent = accent, modifier = Modifier.weight(1f)) { car = !car; Apps.ism.cars = car }
        }
    })
}

@Composable
fun ErtScreen(accent: Color) {
    val d = rememberDims()
    val rate by SdrEngine.rateHz.collectAsState()
    PacketFrame(accent, Apps.ertLog, controls = {
        PresetRow(accent, listOf("911.6" to 911_600_000L, "915.0" to 915_000_000L, "920.0" to 920_000_000L), title = "CENTER · MHz")
        SectionLabel("IQ RATE")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip("2.0 Msps", selected = rate == 2_000_000, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.setRate(2_000_000) }
            val why = com.rocketgod.mayhem.core.Radio.rateWhy(4_194_304)
            Chip("4.194 Msps · Mayhem", selected = rate == 4_194_304, accent = accent, modifier = Modifier.weight(1f), dim = why.isNotEmpty(),
                onClick = gated(why) { SdrEngine.setRate(4_194_304) })
        }
    })
}

@Composable
fun BtleScreen(accent: Color) {
    val d = rememberDims()
    val freq by SdrEngine.freqHz.collectAsState()
    PacketFrame(accent, Apps.btleLog, tunable = false, controls = {
        SectionLabel("ADVERTISING CHANNEL")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (ch in intArrayOf(37, 38, 39)) {
                val hz = BtleDecoder.channelFreq(ch)
                Chip("CH $ch · ${hz / 1_000_000}", selected = freq == hz, accent = accent, modifier = Modifier.weight(1f)) {
                    Apps.btle.channel = ch; SdrEngine.tune(hz)
                }
            }
        }
    })
}
