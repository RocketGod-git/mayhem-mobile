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
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
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
import com.rocketgod.mayhem.core.Gmrs
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.gmrs.GmrsBand
import com.rocketgod.mayhem.core.gmrs.GmrsChanState
import com.rocketgod.mayhem.core.gmrs.GmrsKind
import com.rocketgod.mayhem.core.gmrs.GmrsSnap
import com.rocketgod.mayhem.core.gmrs.channelsOf
import com.rocketgod.mayhem.core.gmrs.dataLines
import com.rocketgod.mayhem.core.gmrs.gmrsChan
import com.rocketgod.mayhem.core.gmrs.gmrsName
import com.rocketgod.mayhem.core.gmrs.gmrsTitle
import com.rocketgod.mayhem.core.gmrs.idCalls
import com.rocketgod.mayhem.core.hamplus.HpParams
import com.rocketgod.mayhem.core.hamplus.HpPrefs
import com.rocketgod.mayhem.core.hamplus.HpSnap
import com.rocketgod.mayhem.core.hamplus.HpTile
import com.rocketgod.mayhem.core.hamplus.HpTxRow
import com.rocketgod.mayhem.core.hamplus.hpIdentLine
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.max

/** "CH 15", "CH 15R", "MURS 4", or the frequency off the plans. */
internal fun gmrsChanTitle(hz: Long): String = gmrsChan(hz)?.let { gmrsTitle(it) } ?: hpMhz(hz)
/** The second line of a channel: its frequency, and its name when it has one. */
internal fun gmrsSub(hz: Long): String { val n = gmrsChan(hz)?.let { gmrsName(it) } ?: ""; return if (n.isNotEmpty()) "${hpMhz(hz)} · $n" else hpMhz(hz) }

/** What a keyup carried beyond its voice: its repeater (input and output tones), else its tone; DATA for a burst no decoder named. */
internal fun gmrsMeta(r: HpTxRow, s: GmrsSnap?): String {
    val parts = ArrayList<String>(); val p = s?.rpt?.get(r.id)
    if (p != null) {
        if (abs(r.heardHz - p.inHz) < 1_000) parts.add(if (p.outHeard) "VIA REPEATER ${hpMhz(p.outHz)}" else "REPEATER INPUT FOR ${hpMhz(p.outHz)}, OUTPUT NOT HEARD")
        else parts.add("REPEATER ${hpMhz(p.outHz)}, INPUT ${hpMhz(p.inHz)} HEARD")
        val inT = hpTone(p.inTone, p.inDcs); val ot = hpTone(p.outTone, p.outDcs)
        if (inT.isNotEmpty()) parts.add("IN $inT")
        if (p.outHeard && ot.isNotEmpty()) parts.add("OUT $ot")
    } else { val t = hpTone(r.tone, r.dcs); if (t.isNotEmpty()) parts.add(t) }
    if (dataLines(r.ident).isNotEmpty()) parts.add("DATA")
    return parts.joinToString(" · ")
}

/** GMRS names channels by number, frequency second, and a keyup by its repeater and tones. */
private class GmrsNamer(val s: GmrsSnap?) : HpNamer {
    override fun chan(hz: Long) = gmrsChanTitle(hz)
    override fun name(t: HpTile) = gmrsSub(t.hz)
    override fun meta(r: HpTxRow) = gmrsMeta(r, s)
    override fun waiting(hold: String) = gmrsChanTitle(hold.toLongOrNull() ?: 0)
}
private val GMRS_HOST = object : HpHost {
    override val note get() = Gmrs.note
    override fun note(text: String) = Gmrs.note(text)
    override fun follow(key: String) = Gmrs.follow(key)
    override fun pref(kind: String, key: String) = Gmrs.pref(kind, key)
    override fun setMode(m: HpParams.Mode) = Gmrs.setMode(m)
    override fun setAudio(on: Boolean, gain: Double) = Gmrs.setAudio(on, gain)
    override fun clear() = Gmrs.clear()
    override fun stopReplay() = Gmrs.stopReplay()
}

private val GMRS_SECTIONS = listOf("ch" to "CHANNELS", "tl" to "TIMELINE", "talk" to "CONVERSATIONS", "calls" to "CALLSIGNS", "act" to "ACTIVITY", "log" to "LOG")
private const val GM_V_TALK = 0
private const val GM_V_CALLS = 1
private const val GM_V_ACT = 2
private val GMRS_WIDE_TABS = listOf("CONVERSATIONS", "CALLSIGNS", "ACTIVITY", "LOG")
private const val GMRS_HEAT_EMPTY = "each channel's busy hours fill in here as the day goes on, kept between sessions"
/** The activity map a row a channel, in the plan's order. */
private fun gmrsHeatRows(s: HpSnap?, band: GmrsBand): List<Pair<String, String>> {
    val order = channelsOf(band).map { it.id }
    return s?.heat?.bands.orEmpty().filter { b -> b.slots.any { it > 0 } && b.id.removePrefix("CH") in order }.sortedBy { order.indexOf(it.id.removePrefix("CH")) }
        .map { b -> val id = b.id.removePrefix("CH"); b.id to (if (band == GmrsBand.MURS) "MURS ${id.drop(1)}" else "CH $id") }
}

/**
 * GMRS: every FRS and GMRS channel at once, or the five MURS ones on its tab, receive only. The board shows the band's
 * channels in plan order with what is on each now, the channels heard are tiles, a channel's card says what it is and
 * its last tone and callsign, the callsigns heard in Morse IDs are listed, and the live bar, the timeline, the
 * conversations, the activity map and the log are HAM+'s, naming channels by number and keyups by their repeater.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun GmrsScreen(accent: Color) {
    val d = rememberDims()
    val band by Gmrs.band.collectAsState()
    val s0 by Gmrs.engineOf(band).snap.collectAsState()
    val s = s0 as? GmrsSnap
    val prefs by Gmrs.prefs.collectAsState()
    val mode by Gmrs.mode.collectAsState()
    val audioOn by Gmrs.audioOn.collectAsState()
    val gain by Gmrs.gain.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(GM_V_TALK) }
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf<Pair<String, String>?>(null) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(250); value = System.currentTimeMillis() } }.value
    LaunchedEffect(Unit) { while (true) { delay(500); if (Apps.playing() == MayhemApp.GMRS) Gmrs.tick(System.currentTimeMillis()) } }
    DisposableEffect(Unit) { onDispose { Gmrs.saveKnown() } }
    val wf = waterfallOn(MayhemApp.GMRS, phoneDefault = false)
    val wide = d.wide
    val bottomH = (LocalConfiguration.current.screenHeightDp * 0.24f).coerceIn(140f, 260f)
    val nm = GmrsNamer(s)
    val acts = HpActs({ Gmrs.follow(it) }, { sel = if (sel == it) null else it }, { ids, label, k -> Gmrs.replayTx(ids, label, k) }, { Gmrs.replayFrom(it) },
        { key, cur -> renaming = key to cur }, GMRS_HOST, nm)
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
            confirmButton = { TextButton({ Gmrs.label(key, text); renaming = null }) { Text("SAVE", color = accent, fontFamily = Mono) } },
            dismissButton = { TextButton({ Gmrs.label(key, ""); renaming = null }) { Text("CLEAR NAME", color = Palette.muted, fontFamily = Mono) } })
    }

    @Composable
    fun detail(modifier: Modifier) {
        val c = s?.chans?.firstOrNull { it.key == sel }
        if (s != null && c != null) GmrsCard(c, s, now, prefs, accent, acts, modifier) { sel = null }
    }

    @Composable
    fun channels() {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            GmrsBoard(s, band, now, prefs.hold, sel, accent, acts)
            GmrsTileGrid(tiles, s, band, prefs.hold, now, accent, acts)
        }
    }

    @Composable
    fun bands() {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            RowLabel("BAND")
            HpSeg(listOf("GMRS / FRS", "MURS"), if (band == GmrsBand.MURS) 1 else 0, accent, Modifier.weight(1f)) { sel = null; Gmrs.setBand(if (it == 1) GmrsBand.MURS else GmrsBand.GMRS) }
        }
    }

    PacketFrame(accent, Gmrs.log, tag = "GMRS", title = "ALL 30 CHANNELS · MURS", roomy = true, titleRow = true, waterfall = wf, right = hpCountText(tiles),
        widePane = { m -> Column(m.padding(top = d.dp(4f))) { HpTimeline(s, now, accent, acts, Modifier.fillMaxSize(), lanesMax = 14, fill = true) } }, paneWaterfall = bottomH,
        onWaterfall = { Apps.setWaterfall(MayhemApp.GMRS, !wf) },
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
                val starts = remember { IntArray(GMRS_SECTIONS.size) }
                val th = with(LocalDensity.current) { d.dp(24f).roundToPx() }
                val active by remember { derivedStateOf {
                    val first = list.layoutInfo.visibleItemsInfo.firstOrNull { it.offset + it.size > th }
                    val k = (first?.key as? String)?.substringBefore(':') ?: "ch"
                    if (!list.canScrollForward && list.canScrollBackward) GMRS_SECTIONS.size - 1 else GMRS_SECTIONS.indexOfFirst { it.first == k }.coerceAtLeast(0)
                } }
                LaunchedEffect(sel) { if (sel != null) list.animateScrollToItem(1) }
                val counts = listOf(tiles.size, s?.rows?.count { now - it.startMs < HP_TL_MS || it.live } ?: 0, s?.convs?.size ?: 0, s?.calls?.size ?: 0, 0, s?.rows?.size ?: 0)
                Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f))) {
                    Column(Modifier.fillMaxWidth().background(Palette.paper).padding(bottom = d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        HpJump(counts, active, accent, GMRS_SECTIONS) { i -> scope.launch { list.animateScrollToItem(starts[i]) } }
                        HpLiveBar(s, now, audioOn, prefs.hold, accent, acts)
                    }
                    LazyColumn(Modifier.fillMaxWidth().weight(1f), state = list, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        var idx = 0
                        item(key = "ch:top") {
                            Column(Modifier.fillMaxWidth().padding(top = d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                                bands()
                                GmrsHead(s, band, accent)
                                HpListenRow(prefs.hold, mode, accent, acts)
                                HpAudioRow(audioOn, gain, accent, acts)
                            }
                        }; idx++
                        item(key = "ch:card") { detail(Modifier.fillMaxWidth()) }; idx++
                        starts[0] = idx; item(key = "ch:head") { HpSecHead("CHANNELS") }; idx++
                        item(key = "ch:grid") { channels() }; idx++
                        starts[1] = idx; item(key = "tl:head") { HpSecHead("TIMELINE · TAP A KEYUP TO HEAR IT, ANYWHERE ELSE TO REPLAY FROM THERE") }; idx++
                        item(key = "tl:tl") { HpTimeline(s, now, accent, acts, Modifier.fillMaxWidth(), lanesMax = 8) }; idx++
                        starts[2] = idx; item(key = "talk:head") { HpSecHead("CONVERSATIONS") }; idx++
                        idx += hpTalkItems(s, now, accent, acts, max = 12)
                        starts[3] = idx; item(key = "calls:head") { HpSecHead("CALLSIGNS") }; idx++
                        idx += gmrsCallItems(s, now)
                        starts[4] = idx; item(key = "act:head") { HpSecHead("ACTIVITY · 24 HOURS A CHANNEL") }; idx++
                        item(key = "act:map") { HpHeatmap(s, now, Modifier.fillMaxWidth(), gmrsHeatRows(s, band), GMRS_HEAT_EMPTY) }; idx++
                        starts[5] = idx; item(key = "log:head") { HpSecHead("LOG") }; idx++
                        gmrsLogItems(s, now)
                    }
                }
            } else Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                // HAM+'s steady grid: the controls never move, the board and the channels scroll in their own space,
                // and the tabs sit in a region as tall as the waterfall
                bands()
                GmrsHead(s, band, accent)
                HpListenRow(prefs.hold, mode, accent, acts)
                HpAudioRow(audioOn, gain, accent, acts)
                HpLiveBar(s, now, audioOn, prefs.hold, accent, acts)
                Box(Modifier.fillMaxWidth().weight(1f)) {
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        Box(Modifier.fillMaxWidth().weight(1f)) {
                            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) { channels() }
                        }
                        Column(Modifier.fillMaxWidth().height(d.dp(bottomH)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                            HpSeg(GMRS_WIDE_TABS, view, accent, Modifier.fillMaxWidth()) { view = it }
                            val list = rememberLazyListState()
                            LaunchedEffect(view) { list.scrollToItem(0) }
                            LazyColumn(Modifier.fillMaxWidth().weight(1f), state = list, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                                when (view) {
                                    GM_V_TALK -> hpTalkItems(s, now, accent, acts, max = 20)
                                    GM_V_CALLS -> gmrsCallItems(s, now)
                                    GM_V_ACT -> item(key = "act:map") { HpHeatmap(s, now, Modifier.fillMaxWidth(), gmrsHeatRows(s, band), GMRS_HEAT_EMPTY) }
                                    else -> gmrsLogItems(s, now)
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
private fun GmrsHead(s: GmrsSnap?, band: GmrsBand, accent: Color) {
    val d = rememberDims()
    val tiles = s?.tiles.orEmpty()
    val all = channelsOf(band).size
    val inSpan = s?.chans?.count { it.inSpan } ?: 0
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Text(if (band == GmrsBand.MURS) "MURS" else "GMRS", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, maxLines = 1, softWrap = false)
            Text("${if (band == GmrsBand.MURS) "151.820–154.600 MHz" else "462.550–467.725 MHz"}${if (s != null && s.rate > 0 && inSpan < all) " · $inSpan of $all channels in the span" else " · all $all channels"}",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, softWrap = false)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            val onAir = s?.stats?.onAir ?: 0
            val steady = s?.chans?.count { it.steady } ?: 0
            val rpt = s?.rpt?.values?.map { it.inHz }?.toSet()?.size ?: 0
            val mins = (s?.stats?.clipS ?: 0L) / 60
            for ((n, l) in listOf("${tiles.size}" to "HEARD", "$onAir" to "ON AIR", "${s?.calls?.size ?: 0}" to "CALLS", "$rpt" to "REPEATERS", "$steady" to "CARRIERS", "$mins" to "MIN KEPT")) {
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

/** Every channel of the band in plan order, a cell each: its number, frequency and what is on it now. 20 and the repeater inputs are marked. */
@Composable
private fun GmrsBoard(s: GmrsSnap?, band: GmrsBand, now: Long, hold: String, sel: String?, accent: Color, acts: HpActs) {
    val d = rememberDims()
    val chans = if (s != null && s.band == band) s.chans else return
    val pulse = rememberInfiniteTransition(label = "gmrs").animateFloat(0.35f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "p").value
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val cols = listOf(10, 8, 5).firstOrNull { maxWidth / it >= d.dp(48f) } ?: 5
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                for (row in chans.chunked(cols)) Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                    for (c in row) GmrsCell(Modifier.weight(1f).fillMaxHeight(), c, s.playing.contains(c.key), hold == c.key, sel == c.key, now, pulse, accent) { acts.info(c.key) }
                    repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
        val off = chans.count { !it.inSpan }
        if (off > 0) Text("$off channel${if (off == 1) " is" else "s are"} outside what this radio hears at once · a HackRF hears the whole band",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 3, modifier = Modifier.padding(horizontal = d.dp(2f)))
    }
}

@Composable
private fun GmrsCell(modifier: Modifier, c: GmrsChanState, playing: Boolean, followed: Boolean, selected: Boolean, now: Long, pulse: Float, accent: Color, onTap: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(8f))
    val recent = !c.open && c.lastMs > 0 && now - c.lastMs < 600_000
    val mark = when { c.id == "20" -> "TRAVEL" to Palette.danger; c.kind == GmrsKind.INPUT -> "RPT IN" to Palette.accent2; c.data -> "DATA" to Palette.accent2; else -> null }
    val border = when { selected -> accent; c.open -> Palette.ok.copy(alpha = 0.4f + 0.5f * pulse); followed -> accent; mark != null -> mark.second.copy(alpha = 0.55f); else -> Palette.line }
    val bg = when { followed || selected -> accent.copy(alpha = 0.14f); c.open -> Palette.ok.copy(alpha = 0.1f); else -> Palette.surface }
    val tone = hpTone(c.tone, c.dcs)
    val (status, sc) = when {
        c.open -> tone.ifEmpty { "ON AIR" } to Palette.ok
        c.steady -> "CARRIER" to Palette.muted
        recent -> hpHeard(now.toDouble(), c.lastMs) to Palette.ink
        else -> "" to Palette.muted
    }
    Column(modifier.alpha(if (!c.inSpan) 0.4f else if (c.steady) 0.75f else 1f).clip(shape).background(bg).border(if (selected) 2.dp else 1.dp, border, shape)
        .clickable { onTap() }.padding(horizontal = d.dp(4f), vertical = d.dp(4f)), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Text(c.id.removePrefix("M"), color = if (c.open) Palette.ok else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(15f), maxLines = 1, softWrap = false)
            if (playing) Text("♪", color = Palette.ok, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(10f))
        }
        Text(hpMhz(c.hz), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7.5f), maxLines = 1, softWrap = false)
        Text(status.ifEmpty { " " }, color = sc, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(7.5f), letterSpacing = 0.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (mark != null) Text(mark.first, color = mark.second, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(6.5f), letterSpacing = 1.sp, maxLines = 1, softWrap = false)
    }
}

/** The channels heard, live first: ALL, then a tile each with its number, frequency and name, its tone and airtime. */
@Composable
private fun GmrsTileGrid(tiles: List<HpTile>, s: GmrsSnap?, band: GmrsBand, hold: String, now: Long, accent: Color, acts: HpActs) {
    val d = rememberDims()
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val cols = max(2, (maxWidth / d.dp(156f)).toInt())
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            val cells: List<HpTile?> = listOf<HpTile?>(null) + tiles
            for (row in cells.chunked(cols)) {
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    for (t in row) {
                        if (t == null) HpAllTile(Modifier.weight(1f).fillMaxHeight(), hold.isEmpty(), s, accent) { acts.follow("") }
                        else GmrsTileBox(Modifier.weight(1f).fillMaxHeight(), t, s?.chans?.firstOrNull { it.key == t.key }, s?.playing?.contains(t.key) == true, now, accent, acts)
                    }
                    repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
            if (tiles.isEmpty()) EmptyState(if (band == GmrsBand.MURS) "murs" else "gmrs", Modifier.fillMaxWidth().height(d.dp(250f)).panel(), accent,
                title = if (s?.chans?.any { it.steady } == true) "No voice heard yet" else null)
        }
    }
}

/** One channel heard: HAM+'s tile with the channel first, its tone, and GMRS's badges. A tap follows it; the i opens its card. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GmrsTileBox(modifier: Modifier, t: HpTile, c: GmrsChanState?, playing: Boolean, now: Long, accent: Color, acts: HpActs) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(10f))
    val pulse = rememberInfiniteTransition(label = "live").animateFloat(0.35f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "p").value
    val edge = when { t.live -> Palette.ok; t.followed -> accent; t.prio -> Palette.accent2; else -> Palette.line }
    val border = when { t.followed -> accent; t.live -> Palette.ok.copy(alpha = 0.4f + 0.5f * pulse); else -> Palette.line }
    Box(modifier.alpha(if (t.muted) 0.5f else 1f).clip(shape).background(if (t.followed) accent.copy(alpha = 0.14f) else if (t.live) Palette.ok.copy(alpha = 0.07f) else Palette.surface)
        .border(1.dp, border, shape).drawBehind { drawRect(edge, size = Size(3.dp.toPx(), size.height)) }.clickable { acts.follow(t.key) }) {
        Column(Modifier.fillMaxWidth().padding(start = d.dp(11f), end = d.dp(8f), top = d.dp(7f), bottom = d.dp(7f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), modifier = Modifier.padding(end = d.dp(20f))) {
                Text(gmrsChanTitle(t.hz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(15f), maxLines = 1, softWrap = false)
                if (playing) Text("♪", color = Palette.ok, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(12f))
            }
            Text(gmrsSub(t.hz), color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val tone = hpTone(t.tone, t.dcs)
            if (tone.isNotEmpty()) Text(tone, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (t.live) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                Text("ON AIR ${hpDur(t.openMs)}", color = Palette.ok, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f), maxLines = 1, softWrap = false)
                HpBar((t.snrDb.toFloat() / 40f).coerceIn(0.05f, 1f), Palette.ok, Modifier.weight(1f).height(d.dp(5f)))
            } else Text(hpTileLine(t, now.toDouble()), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            HpSpark(t.spark, if (t.live) Palette.ok else accent, Modifier.fillMaxWidth().height(d.dp(14f)))
            val badges = buildList {
                if (c?.id == "20") add("TRAVEL" to Palette.accent2)
                if (t.inputHz != 0L) add("REPEATER, INPUT ${hpMhz(t.inputHz)}" to accent)
                if (c?.kind == GmrsKind.INPUT) add("REPEATER INPUT" to Palette.muted)
                if (t.callsign.isNotEmpty()) add(t.callsign to accent)
                if (c?.data == true) add("DATA" to Palette.accent2)
                if (c?.steady == true) add("STEADY CARRIER" to Palette.muted)
                if (t.followed) add("FOLLOWING" to accent)
                if (t.prio) add("PRIORITY" to Palette.accent2)
                if (t.muted) add("MUTED" to Palette.muted)
                if (t.unrecorded > 0) add("${t.unrecorded} NOT RECORDED · DEVICE BUSY" to Palette.danger)
            }
            if (badges.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) { for ((b, bc) in badges) HpPill(b, bc) }
        }
        Box(Modifier.align(Alignment.TopEnd).padding(d.dp(5f)).size(d.dp(20f)).clip(CircleShape).border(1.dp, Palette.line, CircleShape).clickable { acts.info(t.key) },
            contentAlignment = Alignment.Center) { Text("i", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f)) }
    }
}

/** What a channel is, in words. */
private fun gmrsKindText(c: GmrsChanState): String = when (c.kind) {
    GmrsKind.FRS -> "FRS and GMRS, simplex"
    GmrsKind.GMRS -> "GMRS simplex, and a repeater output listening on ${hpMhz(c.hz + 5_000_000)}"
    GmrsKind.INPUT -> "GMRS repeater input, the repeater talks back on ${hpMhz(c.hz - 5_000_000)}"
    GmrsKind.MURS -> "MURS, simplex"
}

/** A channel's card: what it is, its last tone and callsign, follow / mute / priority, its talkers and its last conversation. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GmrsCard(c: GmrsChanState, s: GmrsSnap, now: Long, prefs: HpPrefs, accent: Color, acts: HpActs, modifier: Modifier, onClose: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(12f))
    val t = s.tiles.firstOrNull { it.key == c.key }
    val key = c.key
    val title = gmrsChanTitle(c.hz)
    Column(modifier.padding(vertical = d.dp(4f)).clip(shape).background(Palette.surface).border(1.dp, accent.copy(alpha = 0.7f), shape).padding(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(title, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(20f), maxLines = 1, softWrap = false)
            Text(gmrsSub(c.hz), color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            ToggleBox("CLOSE", false, accent) { onClose() }
        }
        val kv = buildList {
            add("FREQUENCY" to "${hpMhz(c.hz)} MHz")
            add("CHANNEL" to gmrsKindText(c))
            if (c.name.isNotEmpty() && c.kind != GmrsKind.INPUT) add("USE" to if (c.id == "20") "by custom, travelers and emergencies" else c.name.lowercase())
            val tone = hpTone(c.tone, c.dcs); if (tone.isNotEmpty()) add("TONE" to "$tone${if (c.open) ", on the air now" else ", the last keyup"}")
            if (c.call.isNotEmpty()) add("CALLSIGN" to "${c.call}, from its Morse ID")
            if (c.steady) add("ON IT NOW" to "a steady carrier with no voice")
            if (c.data) add("DATA" to "the last keyup carried a data burst no decoder here names")
            if (!c.inSpan) add("SPAN" to "outside what the radio hears now")
            if (t != null) {
                add("HEARD" to "${t.txs} keyups · ${hpDur(t.talkMs)} on the air · ${if (t.live) "on the air now" else hpHeard(now.toDouble(), t.lastMs)}")
                if (t.unrecorded > 0) add("NOT RECORDED" to "${t.unrecorded} keyups were heard but their audio was not kept, because every demodulator this device runs at once was busy with other channels")
            }
        }
        for ((k, v) in kv) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 1.sp, modifier = Modifier.width(d.dp(86f)), maxLines = 1)
            Text(v, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.weight(1f))
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            val followed = prefs.hold == key; val muted = key in prefs.mute
            ToggleBox(if (followed) "FOLLOWING" else "FOLLOW", followed, accent) { acts.follow(key) }
            ToggleBox(if (muted) "MUTED" else "MUTE", muted, accent) { Gmrs.pref("mute", key) }
            ToggleBox("PRIORITY", key in prefs.prio, accent) { Gmrs.pref("prio", key) }
            val conv = s.convs.firstOrNull { it.key == key }
            val ids = conv?.let { cv -> s.rows.filter { it.conv == cv.id && it.recorded && !it.live }.map { it.id } }.orEmpty()
            if (ids.isNotEmpty()) ToggleBox("▶ LAST CONVERSATION", false, accent) { acts.replay(ids, "$title conversation from ${hpClock(conv!!.startMs)}", "conv") }
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

/** Every callsign heard in a Morse ID, the latest first; the number of items added. */
private fun LazyListScope.gmrsCallItems(s: GmrsSnap?, now: Long): Int {
    val calls = s?.calls.orEmpty()
    if (calls.isEmpty()) { item(key = "calls:none") { HpDim("every callsign sent in Morse is listed here, GMRS ones (WRAB123) and amateur ones; an ID spoken by voice is heard in the recording but not read") }; return 1 }
    items(calls, key = { "calls:${it.call}" }) { c ->
        val d = rememberDims()
        Row(Modifier.fillMaxWidth().padding(horizontal = d.dp(4f), vertical = d.dp(1f)), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            Text(hpClock(c.lastMs), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, softWrap = false)
            Text(c.call, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1, softWrap = false)
            Text(if (c.gmrs) "GMRS" else "AMATEUR", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, softWrap = false)
            Text("${gmrsChanTitle(c.hz)} · heard ${c.count} time${if (c.count == 1) "" else "s"} · ${hpHeard(now.toDouble(), c.lastMs)}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f),
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
    }
    return calls.size
}

/** Every keyup, newest first: when, the channel, how long, its signaling, its repeater and tones, the callsigns in its ID. */
private fun LazyListScope.gmrsLogItems(s: GmrsSnap?, now: Long) {
    val rows = s?.rows.orEmpty().take(200)
    if (rows.isEmpty()) { item(key = "log:none") { HpDim("every keyup is logged here with its time, channel, length, tone, its repeater when it went through one, and any ID or data it carried") }; return }
    items(rows, key = { "log:${it.id}" }) { r ->
        val d = rememberDims()
        val calls = idCalls(r.cw).map { it.call }
        Row(Modifier.fillMaxWidth().padding(horizontal = d.dp(4f), vertical = d.dp(1f)), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            Text(hpClock(r.startMs), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, softWrap = false)
            Text(gmrsChanTitle(r.heardHz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1, softWrap = false)
            Text(if (r.live) "LIVE" else hpDur(r.endMs - r.startMs), color = if (r.live) Palette.ok else Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, softWrap = false)
            Text(listOf(r.ident?.let { hpIdentLine(it) } ?: r.stationLabel, gmrsMeta(r, s), if (calls.isNotEmpty()) "CW ID ${calls.joinToString(" ")}" else "", if (!r.recorded) "NO AUDIO KEPT" else "").filter { it.isNotEmpty() }.joinToString(" · "),
                color = if (r.color >= 0) hpColor(r.color) else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
    }
}
