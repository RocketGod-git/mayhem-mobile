package com.rocketgod.mayhem.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Cb
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.cb.CB_MODES
import com.rocketgod.mayhem.core.cb.CbChan
import com.rocketgod.mayhem.core.cb.CbMode
import com.rocketgod.mayhem.core.cb.CbSnap
import com.rocketgod.mayhem.core.cb.cbChannel
import com.rocketgod.mayhem.core.cb.cbName
import com.rocketgod.mayhem.core.hamplus.HpParams
import com.rocketgod.mayhem.core.hamplus.HpPrefs
import com.rocketgod.mayhem.core.hamplus.HpSnap
import com.rocketgod.mayhem.core.hamplus.HpTile
import com.rocketgod.mayhem.core.hamplus.HpTxRow
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.roundToInt

/** 27.185 as 27.185: CB frequencies need three decimals, never four. */
internal fun cbMhz(hz: Long): String = "%.3f".format(java.util.Locale.US, hz / 1e6)
/** "CH 19", or the frequency for anything off the plan. */
internal fun cbTitle(hz: Long): String { val ch = cbChannel(hz); return if (ch != 0) "CH $ch" else cbMhz(hz) }
/** The second line of a channel: its frequency, and its name when it has one. */
internal fun cbSub(hz: Long): String { val ch = cbChannel(hz); val n = if (ch != 0) cbName(ch) else ""; return if (n.isNotEmpty()) "${cbMhz(hz)} · $n" else cbMhz(hz) }

/** CB names channels by number, frequency second, and a transmission by its mode (HAM+ by its frequency and tone). */
internal val CB_NAMER = object : HpNamer {
    override fun chan(hz: Long) = cbTitle(hz)
    override fun name(t: HpTile) = cbSub(t.hz)
    override fun meta(r: HpTxRow) = r.mode
    override fun waiting(hold: String) = cbTitle(hold.toLongOrNull() ?: 0)
}
private val CB_HOST = object : HpHost {
    override val note get() = Cb.note
    override fun note(text: String) = Cb.note(text)
    override fun follow(key: String) = Cb.follow(key)
    override fun pref(kind: String, key: String) = Cb.pref(kind, key)
    override fun setMode(m: HpParams.Mode) = Cb.setMode(m)
    override fun setAudio(on: Boolean, gain: Double) = Cb.setAudio(on, gain)
    override fun clear() = Cb.clear()
    override fun stopReplay() = Cb.stopReplay()
}

/** The steady carrier on a channel, as the screen says it: measured, so it names its level and how long it held. */
internal fun cbSteadyText(c: CbChan): String {
    val mins = (c.steadyMs / 60_000).toInt()
    val held = if (mins >= 1) "$mins min" else "${max(1, (c.steadyMs / 1000).roundToInt())} s"
    return "steady carrier +${c.lineDb} dB, no voice, $held${if (c.steadyPct > 0) " · on ${c.steadyPct}% of the last 10 min" else ""}"
}

/** The board's footer: how many channels hold a steady carrier and stay closed; empty when none does. */
internal fun cbFootText(steady: Int): String = if (steady == 0) "" else
    "$steady channel${if (steady == 1) " holds" else "s hold"} a steady carrier with no voice and stay${if (steady == 1) "s" else ""} closed · a voice under one still opens it"

private const val CB_HEAT_EMPTY = "each channel's busy hours fill in here as the day goes on, kept between sessions, so a band opening for skip shows up"
/** The activity map a row a channel, in channel order. */
private fun cbHeatRows(s: HpSnap?): List<Pair<String, String>> =
    s?.heat?.bands.orEmpty().filter { b -> b.slots.any { it > 0 } }.mapNotNull { b -> b.id.removePrefix("CH").toIntOrNull()?.takeIf { it > 0 }?.let { b.id to it } }
        .sortedBy { it.second }.map { (id, ch) -> id to "CH $ch" }

/**
 * CB: all 40 channels at once, each in its own mode (AM, FM, USB, LSB). The board shows the 40 in channel order with
 * what is on each now, the channels heard are tiles, a channel's card sets its mode and the SSB clarifier, and the live
 * bar, the timeline, the conversations, the activity map and the log are HAM+'s, naming channels by number.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CbScreen(accent: Color) {
    val d = rememberDims()
    val s0 by Cb.engine.snap.collectAsState()
    val s = s0 as? CbSnap
    val prefs by Cb.prefs.collectAsState()
    val mode by Cb.mode.collectAsState()
    val audioOn by Cb.audioOn.collectAsState()
    val gain by Cb.gain.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(HP_V_TALK) }
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf<Pair<String, String>?>(null) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(250); value = System.currentTimeMillis() } }.value
    LaunchedEffect(Unit) { while (true) { delay(500); if (Apps.playing() == MayhemApp.CB) Cb.tick(System.currentTimeMillis()) } }
    DisposableEffect(Unit) { onDispose { Cb.saveKnown() } }
    val wf = waterfallOn(MayhemApp.CB, phoneDefault = false)
    val wide = d.wide
    val bottomH = (LocalConfiguration.current.screenHeightDp * 0.24f).coerceIn(140f, 260f)
    val acts = HpActs({ Cb.follow(it) }, { sel = if (sel == it) null else it }, { ids, label, k -> Cb.replayTx(ids, label, k) }, { Cb.replayFrom(it) },
        { key, cur -> renaming = key to cur }, CB_HOST, CB_NAMER)
    val tiles = s?.tiles.orEmpty()
    val onAir = s?.stats?.onAir ?: 0

    renaming?.let { (key, cur) ->
        var text by remember(key) { mutableStateOf(cur) }
        AlertDialog(onDismissRequest = { renaming = null }, containerColor = Palette.surface, titleContentColor = Palette.ink, textContentColor = Palette.ink,
            title = { Text("Name this talker", fontFamily = Mono, fontWeight = FontWeight.Bold) },
            text = {
                OutlinedTextField(text, { t -> text = t.take(16) }, singleLine = true, textStyle = TextStyle(fontFamily = Mono, color = Palette.ink, fontSize = d.sp(14f)),
                    colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = accent, unfocusedBorderColor = Palette.line, cursorColor = accent))
            },
            confirmButton = { TextButton({ Cb.label(key, text); renaming = null }) { Text("SAVE", color = accent, fontFamily = Mono) } },
            dismissButton = { TextButton({ Cb.label(key, ""); renaming = null }) { Text("CLEAR NAME", color = Palette.muted, fontFamily = Mono) } })
    }

    @Composable
    fun detail(modifier: Modifier) {
        val c = s?.chans?.firstOrNull { it.key == sel }
        if (s != null && c != null) CbCard(c, s, now, prefs, accent, acts, modifier) { sel = null }
    }

    @Composable
    fun channels() {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            CbBoard(s, now, prefs.hold, sel, accent, acts)
            CbTileGrid(tiles, s, prefs.hold, now, accent, acts)
        }
    }

    PacketFrame(accent, Cb.log, tag = "CB RADIO", title = "ALL 40 CHANNELS · AM · FM · SSB", roomy = true, titleRow = true, waterfall = wf, right = hpCountText(tiles),
        widePane = { m -> Column(m.padding(top = d.dp(4f))) { HpTimeline(s, now, accent, acts, Modifier.fillMaxSize(), lanesMax = 14, fill = true) } }, paneWaterfall = bottomH,
        onWaterfall = { Apps.setWaterfall(MayhemApp.CB, !wf) },
        lamp = {
            if (s?.replay?.active == true) Lamp("REPLAYING", Palette.accent2, blink = true)
            else if (onAir > 0) Lamp("$onAir ON AIR", Palette.ok, blink = true)
            else if (tiles.isNotEmpty()) Lamp("${tiles.size} CHANNEL${if (tiles.size == 1) "" else "S"}", Palette.ok)
            else Lamp("LISTENING", Palette.accent2, blink = true)
        },
        controls = {}, body = {
            if (!wide) {
                // the phone: one page that scrolls; the section chips and the live bar stay pinned on top
                val list = rememberLazyListState()
                val scope = rememberCoroutineScope()
                val starts = remember { IntArray(HP_SECTIONS.size) }
                val th = with(LocalDensity.current) { d.dp(24f).roundToPx() }
                val active by remember { derivedStateOf {
                    val first = list.layoutInfo.visibleItemsInfo.firstOrNull { it.offset + it.size > th }
                    val k = (first?.key as? String)?.substringBefore(':') ?: "ch"
                    if (!list.canScrollForward && list.canScrollBackward) HP_SECTIONS.size - 1 else HP_SECTIONS.indexOfFirst { it.first == k }.coerceAtLeast(0)
                } }
                LaunchedEffect(sel) { if (sel != null) list.animateScrollToItem(1) }
                val counts = listOf(tiles.size, s?.rows?.count { now - it.startMs < HP_TL_MS || it.live } ?: 0, s?.convs?.size ?: 0, 0, s?.rows?.size ?: 0)
                Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f))) {
                    Column(Modifier.fillMaxWidth().background(Palette.paper).padding(bottom = d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        HpJump(counts, active, accent) { i -> scope.launch { list.animateScrollToItem(starts[i]) } }
                        HpLiveBar(s, now, audioOn, prefs.hold, accent, acts)
                    }
                    LazyColumn(Modifier.fillMaxWidth().weight(1f), state = list, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        var idx = 0
                        item(key = "ch:top") {
                            Column(Modifier.fillMaxWidth().padding(top = d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                                CbHead(s, accent)
                                HpListenRow(prefs.hold, mode, accent, acts)
                                HpAudioRow(audioOn, gain, accent, acts)
                            }
                        }; idx++
                        item(key = "ch:card") { detail(Modifier.fillMaxWidth()) }; idx++
                        starts[0] = idx; item(key = "ch:head") { HpSecHead("CHANNELS") }; idx++
                        item(key = "ch:grid") { channels() }; idx++
                        starts[1] = idx; item(key = "tl:head") { HpSecHead("TIMELINE · TAP A TRANSMISSION TO HEAR IT, ANYWHERE ELSE TO REPLAY FROM THERE") }; idx++
                        item(key = "tl:tl") { HpTimeline(s, now, accent, acts, Modifier.fillMaxWidth(), lanesMax = 8) }; idx++
                        starts[2] = idx; item(key = "talk:head") { HpSecHead("CONVERSATIONS") }; idx++
                        idx += hpTalkItems(s, now, accent, acts, max = 12)
                        starts[3] = idx; item(key = "act:head") { HpSecHead("ACTIVITY · 24 HOURS A CHANNEL") }; idx++
                        item(key = "act:map") { HpHeatmap(s, now, Modifier.fillMaxWidth(), cbHeatRows(s), CB_HEAT_EMPTY) }; idx++
                        starts[4] = idx; item(key = "log:head") { HpSecHead("LOG") }; idx++
                        hpLogItems(s, now, CB_NAMER)
                    }
                }
            } else Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                // HAM+'s steady grid: the controls never move, the board and the channels scroll in their own space,
                // and the tabs sit in a region as tall as the waterfall
                CbHead(s, accent)
                HpListenRow(prefs.hold, mode, accent, acts)
                HpAudioRow(audioOn, gain, accent, acts)
                HpLiveBar(s, now, audioOn, prefs.hold, accent, acts)
                Box(Modifier.fillMaxWidth().weight(1f)) {
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        Box(Modifier.fillMaxWidth().weight(1f)) {
                            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) { channels() }
                        }
                        Column(Modifier.fillMaxWidth().height(d.dp(bottomH)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                            HpSeg(HP_WIDE_TABS, view, accent, Modifier.fillMaxWidth()) { view = it }
                            val list = rememberLazyListState()
                            LaunchedEffect(view) { list.scrollToItem(0) }
                            LazyColumn(Modifier.fillMaxWidth().weight(1f), state = list, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                                when (view) {
                                    HP_V_TALK -> hpTalkItems(s, now, accent, acts, max = 20)
                                    HP_V_ACT -> item(key = "act:map") { HpHeatmap(s, now, Modifier.fillMaxWidth(), cbHeatRows(s), CB_HEAT_EMPTY) }
                                    else -> hpLogItems(s, now, CB_NAMER)
                                }
                            }
                        }
                    }
                    // a channel's card opens over the board and the tabs, in a scroll of its own
                    if (sel != null && s?.chans?.any { it.key == sel } == true) Column(Modifier.fillMaxSize().background(Palette.paper).verticalScroll(rememberScrollState())) { detail(Modifier.fillMaxWidth()) }
                }
            }
        })
}

/** The band and how much of it is in the span, the counters, and the demodulators in use against what the device keeps up with. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CbHead(s: CbSnap?, accent: Color) {
    val d = rememberDims()
    val tiles = s?.tiles.orEmpty()
    val inSpan = s?.chans?.count { it.inSpan } ?: 0
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Text("CB RADIO", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, maxLines = 1, softWrap = false)
            Text("26.965–27.405 MHz${if (s != null && s.rate > 0 && inSpan < 40) " · $inSpan of 40 channels in the span" else " · all 40 channels"}",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, softWrap = false)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            val onAir = s?.stats?.onAir ?: 0
            val steady = s?.chans?.count { it.steady } ?: 0
            val mins = (s?.stats?.clipS ?: 0L) / 60
            for ((n, l) in listOf("${tiles.size}" to "HEARD", "$onAir" to "ON AIR", "${s?.stats?.stations ?: 0}" to "TALKERS", "${s?.convs?.size ?: 0}" to "CONVOS", "$steady" to "CARRIERS", "$mins" to "MIN KEPT")) {
                val air = l == "ON AIR" && onAir > 0
                Column(Modifier.weight(1f).panel(if (air) Palette.ok else Palette.line).padding(horizontal = d.dp(3f), vertical = d.dp(4f)), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(n, color = if (air) Palette.ok else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f), maxLines = 1, softWrap = false)
                    Text(l, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7f), letterSpacing = 0.5.sp, maxLines = 1, softWrap = false)
                }
            }
        }
        if (s != null) Text("demodulating ${s.stats.probes} now · this device keeps up with ${s.stats.cap} at once${if (s.stats.costMs > 0) " (%.0f ms a channel a second)".format(java.util.Locale.US, s.stats.costMs) else ""} · time machine ${s.stats.clipMB} of ${s.stats.capMB} MB",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 2)
    }
}

/**
 * The 40 channels in their order, a cell each: the number, the frequency, and what is on it now (on the air and in
 * which mode, a steady carrier, heard a while ago). Channels 9 and 19 are marked. A tap opens the channel's card.
 */
@Composable
private fun CbBoard(s: CbSnap?, now: Long, hold: String, sel: String?, accent: Color, acts: HpActs) {
    val d = rememberDims()
    val chans = s?.chans ?: return
    val pulse = rememberInfiniteTransition(label = "cb").animateFloat(0.35f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "p").value
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            // 10, 8 or 5 a row, so the 40 fill whole rows
            val cols = listOf(10, 8, 5).firstOrNull { maxWidth / it >= d.dp(48f) } ?: 5
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                for (row in chans.chunked(cols)) Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                    for (c in row) {
                        val t = s.tiles.firstOrNull { it.key == c.key }
                        CbCell(Modifier.weight(1f).fillMaxHeight(), c, t, s.playing.contains(c.key), hold == c.key, sel == c.key, now, pulse, accent) { acts.info(c.key) }
                    }
                    repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
        val foot = cbFootText(chans.count { it.steady })
        if (foot.isNotEmpty()) Text(foot, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 3, modifier = Modifier.padding(horizontal = d.dp(2f)))
    }
}

@Composable
private fun CbCell(modifier: Modifier, c: CbChan, t: HpTile?, playing: Boolean, followed: Boolean, selected: Boolean, now: Long, pulse: Float, accent: Color, onTap: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(8f))
    val recent = t != null && !t.live && now - t.lastMs < 600_000
    val mark = when (c.ch) { 9 -> "EMERG" to Palette.danger; 19 -> "HWY" to Palette.accent2; else -> null }
    val border = when { selected -> accent; c.open -> Palette.ok.copy(alpha = 0.4f + 0.5f * pulse); followed -> accent; mark != null -> mark.second.copy(alpha = 0.55f); else -> Palette.line }
    val bg = when { followed || selected -> accent.copy(alpha = 0.14f); c.open -> Palette.ok.copy(alpha = 0.1f); else -> Palette.surface }
    val (status, sc) = when {
        c.open -> c.mode.name to Palette.ok
        c.steady -> "CARRIER" to Palette.muted
        recent -> hpAgo((now - t!!.lastMs).toDouble()) to Palette.ink
        c.manual != null -> c.manual.name to Palette.muted
        else -> "" to Palette.muted
    }
    Column(modifier.alpha(if (!c.inSpan) 0.4f else if (c.steady) 0.75f else 1f).clip(shape).background(bg).border(if (selected) 2.dp else 1.dp, border, shape)
        .clickable { onTap() }.padding(horizontal = d.dp(4f), vertical = d.dp(4f)), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Text("${c.ch}", color = if (c.open) Palette.ok else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(15f), maxLines = 1, softWrap = false)
            if (playing) Text("♪", color = Palette.ok, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(10f))
        }
        Text(cbMhz(c.hz), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7.5f), maxLines = 1, softWrap = false)
        Text(status.ifEmpty { " " }, color = sc, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(7.5f), letterSpacing = 0.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (mark != null) Text(mark.first, color = mark.second, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(6.5f), letterSpacing = 1.sp, maxLines = 1, softWrap = false)
    }
}

/** The channels heard, live first: ALL, then a tile each with its number, frequency and name, mode and airtime. */
@Composable
private fun CbTileGrid(tiles: List<HpTile>, s: CbSnap?, hold: String, now: Long, accent: Color, acts: HpActs) {
    val d = rememberDims()
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val cols = max(2, (maxWidth / d.dp(156f)).toInt())
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            val cells: List<HpTile?> = listOf<HpTile?>(null) + tiles
            for (row in cells.chunked(cols)) {
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    for (t in row) {
                        if (t == null) HpAllTile(Modifier.weight(1f).fillMaxHeight(), hold.isEmpty(), s, accent) { acts.follow("") }
                        else CbTileBox(Modifier.weight(1f).fillMaxHeight(), t, s?.chans?.firstOrNull { it.key == t.key }, s?.playing?.contains(t.key) == true, now, accent, acts)
                    }
                    repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
            // (steady carriers on the board are not voices: with nothing heard yet the board still says so)
            if (tiles.isEmpty()) EmptyState("cb", Modifier.fillMaxWidth().height(d.dp(250f)).panel(), accent,
                title = if (s?.chans?.any { it.steady } == true) "No voice heard yet" else null)
        }
    }
}

/** One channel heard: HAM+'s tile with the channel number first, its mode (or the one set), and CB's badges. A tap follows it; the i opens its card. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CbTileBox(modifier: Modifier, t: HpTile, c: CbChan?, playing: Boolean, now: Long, accent: Color, acts: HpActs) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(10f))
    val pulse = rememberInfiniteTransition(label = "live").animateFloat(0.35f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "p").value
    val ch = cbChannel(t.hz)
    val edge = when { t.live -> Palette.ok; t.followed -> accent; t.prio -> Palette.accent2; else -> Palette.line }
    val border = when { t.followed -> accent; t.live -> Palette.ok.copy(alpha = 0.4f + 0.5f * pulse); else -> Palette.line }
    Box(modifier.alpha(if (t.muted) 0.5f else 1f).clip(shape).background(if (t.followed) accent.copy(alpha = 0.14f) else if (t.live) Palette.ok.copy(alpha = 0.07f) else Palette.surface)
        .border(1.dp, border, shape).drawBehind { drawRect(edge, size = Size(3.dp.toPx(), size.height)) }.clickable { acts.follow(t.key) }) {
        Column(Modifier.fillMaxWidth().padding(start = d.dp(11f), end = d.dp(8f), top = d.dp(7f), bottom = d.dp(7f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), modifier = Modifier.padding(end = d.dp(20f))) {
                Text(cbTitle(t.hz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(15f), maxLines = 1, softWrap = false)
                if (playing) Text("♪", color = Palette.ok, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(12f))
            }
            Text(cbSub(t.hz), color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val mode = if (c == null) "" else c.manual?.let { "${it.name} (SET)" } ?: c.mode.name
            if (mode.isNotEmpty()) Text(mode, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (t.live) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                Text("ON AIR ${hpDur(t.openMs)}", color = Palette.ok, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f), maxLines = 1, softWrap = false)
                HpBar((t.snrDb.toFloat() / 40f).coerceIn(0.05f, 1f), Palette.ok, Modifier.weight(1f).height(d.dp(5f)))
            } else Text("${hpAgo(now - t.lastMs)} · ${t.txs} tx · ${hpDur(t.talkMs)}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            HpSpark(t.spark, if (t.live) Palette.ok else accent, Modifier.fillMaxWidth().height(d.dp(14f)))
            val badges = buildList {
                if (ch == 9) add("EMERGENCY" to Palette.danger)
                if (ch == 19) add("HIGHWAY" to Palette.accent2)
                if (c != null && c.lineDb > 0 && !c.open) add("STEADY CARRIER +${c.lineDb} dB" to Palette.muted)
                if (t.followed) add("FOLLOWING" to accent)
                if (t.prio) add("PRIORITY" to Palette.accent2)
                if (t.muted) add("MUTED" to Palette.muted)
                if (t.unrecorded > 0) add("${t.unrecorded} NOT RECORDED" to Palette.danger)
            }
            if (badges.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) { for ((b, bc) in badges) HpPill(b, bc) }
        }
        Box(Modifier.align(Alignment.TopEnd).padding(d.dp(5f)).size(d.dp(20f)).clip(CircleShape).border(1.dp, Palette.line, CircleShape).clickable { acts.info(t.key) },
            contentAlignment = Alignment.Center) { Text("i", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f)) }
    }
}

/**
 * A channel's card: its number, frequency and name, the mode (AUTO or set by hand) and for SSB the clarifier, what is
 * on it now (a steady carrier measured), follow / mute / priority, its talkers and its last conversation.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CbCard(c: CbChan, s: CbSnap, now: Long, prefs: HpPrefs, accent: Color, acts: HpActs, modifier: Modifier, onClose: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(12f))
    val t = s.tiles.firstOrNull { it.key == c.key }
    val key = c.key
    Column(modifier.padding(vertical = d.dp(4f)).clip(shape).background(Palette.surface).border(1.dp, accent.copy(alpha = 0.7f), shape).padding(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("CH ${c.ch}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(20f), maxLines = 1, softWrap = false)
            Text(cbSub(c.hz), color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            ToggleBox("CLOSE", false, accent) { onClose() }
        }
        val kv = buildList {
            add("FREQUENCY" to "${cbMhz(c.hz)} MHz")
            if (cbName(c.ch).isNotEmpty()) add("USE" to when (c.ch) { 9 -> "emergencies and help to travelers"; 19 -> "highway traffic"; 38 -> "single sideband calling, LSB"; else -> "single sideband" })
            add("MODE" to (c.manual?.let { "${it.name}, set by hand" } ?: if (c.open && c.measured != null) "${c.measured.name}, measured on this transmission" else "${c.mode.name}, chosen on each transmission"))
            if (c.open) add("ON IT NOW" to "${c.mode.name} on the air, voice ${c.voiceDb.roundToInt()} dB over the quiet channels${if (c.lineDb > 0) ", under a steady carrier +${c.lineDb} dB" else ""}")
            else if (c.lineDb > 0) add("ON IT NOW" to cbSteadyText(c))
            if (!c.inSpan) add("SPAN" to "outside what the radio hears now")
            if (t != null) {
                add("HEARD" to "${t.txs} transmissions · ${hpDur(t.talkMs)} on the air · ${if (t.live) "on the air now" else hpAgo(now - t.lastMs)}")
                if (t.unrecorded > 0) add("NOT RECORDED" to "${t.unrecorded} transmissions came while every demodulator was busy")
            }
        }
        for ((k, v) in kv) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 1.sp, modifier = Modifier.width(d.dp(86f)), maxLines = 1)
            Text(v, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.weight(1f))
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            RowLabel("MODE")
            val modes: List<CbMode?> = listOf<CbMode?>(null) + CB_MODES
            HpSeg(modes.map { it?.name ?: "AUTO" }, modes.indexOf(c.manual), accent, Modifier.weight(1f)) { Cb.setChanMode(key, modes[it]) }
        }
        val ssb = c.manual == CbMode.USB || c.manual == CbMode.LSB || (c.manual == null && (c.mode == CbMode.USB || c.mode == CbMode.LSB))
        if (ssb) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            RowLabel("CLARIFIER")
            ToggleBox("−", false, accent) { Cb.clarify(key, -Cb.CLAR_STEP) }
            Text("${if (c.clarHz > 0) "+" else ""}${c.clarHz} Hz", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1, softWrap = false)
            ToggleBox("+", false, accent) { Cb.clarify(key, Cb.CLAR_STEP) }
            if (c.clarHz != 0) ToggleBox("CENTER", false, accent) { Cb.clarify(key, 0) }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            val followed = prefs.hold == key; val muted = key in prefs.mute
            ToggleBox(if (followed) "FOLLOWING" else "FOLLOW", followed, accent) { acts.follow(key) }
            ToggleBox(if (muted) "MUTED" else "MUTE", muted, accent) { Cb.pref("mute", key) }
            ToggleBox("PRIORITY", key in prefs.prio, accent) { Cb.pref("prio", key) }
            val conv = s.convs.firstOrNull { it.key == key }
            val ids = conv?.let { cv -> s.rows.filter { it.conv == cv.id && it.recorded && !it.live }.map { it.id } }.orEmpty()
            if (ids.isNotEmpty()) ToggleBox("▶ LAST CONVERSATION", false, accent) { acts.replay(ids, "CH ${c.ch} conversation from ${hpClock(conv!!.startMs)}", "conv") }
        }
        if (t != null && t.stations.isNotEmpty()) {
            Text("TALKERS BY THEIR CARRIER · TAP TO NAME", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 1.sp)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                for (st in t.stations) {
                    val sc = hpColor(st.color); val sh = RoundedCornerShape(d.dp(8f))
                    Row(Modifier.clip(sh).background(sc.copy(alpha = 0.14f)).border(1.dp, sc.copy(alpha = 0.6f), sh).clickable { acts.rename(st.key, st.label.takeIf { it != st.letter } ?: "") }
                        .padding(horizontal = d.dp(8f), vertical = d.dp(4f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        Text(st.label, color = sc, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(11f), maxLines = 1, softWrap = false)
                        Text("${st.txs} tx · %+d Hz".format(java.util.Locale.US, st.offsetHz), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, softWrap = false)
                    }
                }
            }
        }
        s.convs.firstOrNull { it.key == key }?.let { HpConvCard(it.id, s, now, accent, acts) }
    }
}
