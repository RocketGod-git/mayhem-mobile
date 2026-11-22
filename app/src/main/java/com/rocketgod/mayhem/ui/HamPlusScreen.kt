package com.rocketgod.mayhem.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.HamPlus
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.hamplus.HP_BANDS
import com.rocketgod.mayhem.core.hamplus.HEAT_SLOTS
import com.rocketgod.mayhem.core.hamplus.HpParams
import com.rocketgod.mayhem.core.hamplus.HpSnap
import com.rocketgod.mayhem.core.hamplus.HpTile
import com.rocketgod.mayhem.core.hamplus.HpTxRow
import com.rocketgod.mayhem.core.hamplus.hpBandOf
import com.rocketgod.mayhem.core.hamplus.cwCallsign
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** A station's color, by its letter (A is 0): the same color everywhere it shows. */
internal val HP_COLORS = listOf(0xFF4C8DFF, 0xFFFFAF00, 0xFF3DDC84, 0xFFFF5BD2, 0xFF00D5FF, 0xFFFF7A45, 0xFFB18CFF, 0xFFE8E14A, 0xFFFF5B52, 0xFF52FFB8).map { Color(it) }
internal fun hpColor(i: Int): Color = if (i < 0) Palette.muted else HP_COLORS[i % HP_COLORS.size]

/** 146.52 as 146.520, 442.0125 as 442.0125: at least three decimals, a fourth only when it is there. */
internal fun hpMhz(hz: Long): String { val s = "%.4f".format(java.util.Locale.US, hz / 1e6); return if (s.endsWith("0")) s.dropLast(1) else s }
internal fun hpDur(ms: Double): String { val t = max(0L, (ms / 1000).roundToInt().toLong()); return if (t < 3600) "${t / 60}:${(t % 60).toString().padStart(2, '0')}" else "${t / 3600}:${((t / 60) % 60).toString().padStart(2, '0')}:${(t % 60).toString().padStart(2, '0')}" }
internal fun hpAgo(ms: Double): String = when { ms < 2_000 -> "now"; ms < 60_000 -> "${(ms / 1000).toInt()} s ago"; ms < 3_600_000 -> "${(ms / 60_000).toInt()} min ago"; else -> "${(ms / 3_600_000).toInt()} h ago" }
internal fun hpClock(ms: Double): String = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date(ms.toLong()))
internal fun hpTone(tone: Double, dcs: Int): String = if (tone > 0) "PL %.1f".format(java.util.Locale.US, tone) else if (dcs > 0) "DCS ${dcs.toString().padStart(3, '0')}" else ""
/** A tile's name: the CW ID callsign, else the band plan's name for the frequency, else what kind of channel it is. */
internal fun hpName(t: HpTile): String = t.callsign.ifEmpty { t.label.ifEmpty { t.kind.ifEmpty { hpBandOf(t.hz)?.name?.uppercase()?.let { "$it FM" } ?: "" } } }

private val HP_SECTIONS = listOf("ch" to "CHANNELS", "tl" to "TIMELINE", "talk" to "CONVERSATIONS", "act" to "ACTIVITY", "log" to "LOG")
private const val V_TALK = 0
private const val V_ACT = 1
private const val V_LOG = 2
private val WIDE_TABS = listOf("CONVERSATIONS", "ACTIVITY", "LOG")
/** The timeline shows the last ten minutes. */
private const val TL_MS = 600_000.0

private class HpActs(val follow: (String) -> Unit, val info: (String) -> Unit, val replay: (List<Int>, String, String) -> Unit, val replayFrom: (Double) -> Unit, val rename: (String, String) -> Unit)

/**
 * HAM+: every FM conversation on the ham bands at once. Each channel heard is a tile (its name, tone, repeater offset,
 * live level, activity and talk time), every transmission is in the time machine, each conversation reads as a thread
 * with a bubble per talker (told apart by their own radio's carrier error), and the timeline and the 24-hour map show
 * the band at a glance. ALL hears every channel (mixed, or the newest); a tap on a tile follows only it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun HamPlusScreen(accent: Color) {
    val d = rememberDims()
    val s by HamPlus.engine.snap.collectAsState()
    val prefs by HamPlus.prefs.collectAsState()
    val labels by HamPlus.labels.collectAsState()
    val mode by HamPlus.mode.collectAsState()
    val audioOn by HamPlus.audioOn.collectAsState()
    val gain by HamPlus.gain.collectAsState()
    val band by HamPlus.band.collectAsState()
    val scan by HamPlus.scan.collectAsState()
    val kind by Radio.kind.collectAsState()
    val rate by SdrEngine.rateHz.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(V_TALK) }
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf<Pair<String, String>?>(null) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(250); value = System.currentTimeMillis() } }.value
    LaunchedEffect(Unit) { while (true) { delay(500); if (Apps.playing() == MayhemApp.HAMPLUS) HamPlus.tick(System.currentTimeMillis()) } }
    DisposableEffect(Unit) { onDispose { HamPlus.saveKnown() } }
    val wf = waterfallOn(MayhemApp.HAMPLUS, phoneDefault = false)
    val wide = d.wide
    val bottomH = (LocalConfiguration.current.screenHeightDp * 0.24f).coerceIn(140f, 260f)
    val acts = HpActs({ HamPlus.follow(it) }, { sel = if (sel == it) null else it }, { ids, label, k -> HamPlus.replayTx(ids, label, k) }, { HamPlus.replayFrom(it) },
        { key, cur -> renaming = key to cur })
    val tiles = s?.tiles.orEmpty()
    val onAir = s?.stats?.onAir ?: 0

    renaming?.let { (key, cur) ->
        var text by remember(key) { mutableStateOf(cur) }
        AlertDialog(onDismissRequest = { renaming = null }, containerColor = Palette.surface, titleContentColor = Palette.ink, textContentColor = Palette.ink,
            title = { Text("Name this station", fontFamily = Mono, fontWeight = FontWeight.Bold) },
            text = {
                OutlinedTextField(text, { t -> text = t.take(16) }, singleLine = true, textStyle = TextStyle(fontFamily = Mono, color = Palette.ink, fontSize = d.sp(14f)),
                    colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = accent, unfocusedBorderColor = Palette.line, cursorColor = accent))
            },
            confirmButton = { TextButton({ HamPlus.label(key, text); renaming = null }) { Text("SAVE", color = accent, fontFamily = Mono) } },
            dismissButton = { TextButton({ HamPlus.label(key, ""); renaming = null }) { Text("CLEAR NAME", color = Palette.muted, fontFamily = Mono) } })
    }

    @Composable
    fun detail(modifier: Modifier) {
        val t = tiles.firstOrNull { it.key == sel }
        if (s != null && t != null) HpTileCard(t, s!!, now, prefs.mute.contains(t.key), prefs.prio.contains(t.key), prefs.hold == t.key, accent, acts, modifier) { sel = null }
    }

    PacketFrame(accent, HamPlus.log, tag = "HAM+", title = "EVERY CHANNEL · EVERY TALKER", roomy = true, waterfall = wf,
        widePane = { m -> Column(m.padding(top = d.dp(4f))) { HpTimeline(s, now, accent, acts, Modifier.fillMaxSize(), lanesMax = 14, fill = true) } }, paneWaterfall = bottomH,
        onWaterfall = { Apps.setWaterfall(MayhemApp.HAMPLUS, !wf) },
        lamp = {
            if (s?.replay?.active == true) Lamp("REPLAYING", Palette.accent2, blink = true)
            else if (onAir > 0) Lamp("$onAir ON AIR", Palette.ok, blink = true)
            else if (tiles.isNotEmpty()) Lamp("${tiles.size} CHANNEL${if (tiles.size == 1) "" else "S"}", Palette.ok)
            else Lamp("LISTENING", Palette.accent2, blink = true)
        },
        controls = {
            HpSeg(HamPlus.BANDS.map { it.second }, HamPlus.BANDS.indexOfFirst { it.first == band }, accent, Modifier.fillMaxWidth()) { HamPlus.setBand(HamPlus.BANDS[it].first) }
            if (kind != Radio.Kind.RTLSDR) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("SPAN")
                val whys = HamPlus.SPANS.map { Radio.rateWhy(it.first) }
                SegBar(HamPlus.SPANS.map { it.second }, HamPlus.SPANS.indexOfFirst { it.first == rate }, accent, Modifier.weight(1f),
                    tints = whys.map { if (it.isNotEmpty()) Palette.muted.copy(alpha = 0.45f) else null }) { i -> gated(whys[i]) { HamPlus.setSpan(HamPlus.SPANS[i].first) }() }
            }
        }, body = {
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
                val counts = listOf(tiles.size, s?.rows?.count { now - it.startMs < TL_MS || it.live } ?: 0, s?.convs?.size ?: 0, 0, s?.rows?.size ?: 0)
                Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f))) {
                    Column(Modifier.fillMaxWidth().background(Palette.paper).padding(bottom = d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        HpJump(counts, active, accent) { i -> scope.launch { list.animateScrollToItem(starts[i]) } }
                        HpLiveBar(s, now, audioOn, prefs.hold, accent)
                    }
                    LazyColumn(Modifier.fillMaxWidth().weight(1f), state = list, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        var idx = 0
                        item(key = "ch:top") {
                            Column(Modifier.fillMaxWidth().padding(top = d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                                HpHead(s, now, accent)
                                HpListenRow(prefs.hold, mode, accent)
                                HpAudioRow(audioOn, gain, accent)
                            }
                        }; idx++
                        item(key = "ch:card") { detail(Modifier.fillMaxWidth()) }; idx++
                        starts[0] = idx; item(key = "ch:head") { HpSecHead("CHANNELS") }; idx++
                        item(key = "ch:grid") { HpTileGrid(tiles, s, prefs.hold, now, accent, acts) }; idx++
                        starts[1] = idx; item(key = "tl:head") { HpSecHead("TIMELINE · TAP A TRANSMISSION TO HEAR IT, ANYWHERE ELSE TO REPLAY THE BAND FROM THERE") }; idx++
                        item(key = "tl:tl") { HpTimeline(s, now, accent, acts, Modifier.fillMaxWidth(), lanesMax = 8) }; idx++
                        starts[2] = idx; item(key = "talk:head") { HpSecHead("CONVERSATIONS") }; idx++
                        idx += talkItems(s, now, accent, acts, max = 12)
                        starts[3] = idx; item(key = "act:head") { HpSecHead("ACTIVITY · 24 HOURS") }; idx++
                        item(key = "act:map") { HpHeatmap(s, now, Modifier.fillMaxWidth()) }; idx++
                        starts[4] = idx; item(key = "log:head") { HpSecHead("LOG") }; idx++
                        logItems(s, now)
                    }
                }
            } else Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                // a steady grid beside the timeline: the controls never move, the live bar keeps one height, the channels
                // fill the space and scroll there, and the tabs sit in a region as tall as the waterfall
                HpHead(s, now, accent)
                HpListenRow(prefs.hold, mode, accent)
                HpAudioRow(audioOn, gain, accent)
                HpLiveBar(s, now, audioOn, prefs.hold, accent)
                Box(Modifier.fillMaxWidth().weight(1f)) {
                    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        Box(Modifier.fillMaxWidth().weight(1f)) {
                            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) { HpTileGrid(tiles, s, prefs.hold, now, accent, acts) }
                        }
                        Column(Modifier.fillMaxWidth().height(d.dp(bottomH)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                            HpSeg(WIDE_TABS, view, accent, Modifier.fillMaxWidth()) { view = it }
                            val list = rememberLazyListState()
                            LaunchedEffect(view) { list.scrollToItem(0) }
                            LazyColumn(Modifier.fillMaxWidth().weight(1f), state = list, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                                when (view) {
                                    V_TALK -> talkItems(s, now, accent, acts, max = 20)
                                    V_ACT -> item(key = "act:map") { HpHeatmap(s, now, Modifier.fillMaxWidth()) }
                                    else -> logItems(s, now)
                                }
                            }
                        }
                    }
                    // a channel's card opens over the channels and the tabs, in a scroll of its own
                    if (sel != null && tiles.any { it.key == sel }) Column(Modifier.fillMaxSize().background(Palette.paper).verticalScroll(rememberScrollState())) { detail(Modifier.fillMaxWidth()) }
                }
            }
        })
}

@Composable
private fun HpSecHead(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 2.sp, maxLines = 2,
        modifier = Modifier.padding(top = d.dp(10f), start = d.dp(2f), bottom = d.dp(2f)))
}

@Composable
private fun HpDim(text: String, modifier: Modifier = Modifier) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = modifier.padding(d.dp(8f)))
}

/** Choices sized to their labels that wrap onto another line rather than clip. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HpSeg(labels: List<String>, selected: Int, accent: Color, modifier: Modifier, onPick: (Int) -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(9f))
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        labels.forEachIndexed { i, label ->
            val on = i == selected
            Text(label, color = if (on) inkOn(accent) else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, maxLines = 1, softWrap = false,
                modifier = Modifier.clip(shape).background(if (on) accent else Palette.surface).border(1.dp, if (on) accent else Palette.line, shape).clickable { onPick(i) }
                    .padding(horizontal = d.dp(10f), vertical = d.dp(7f)))
        }
    }
}

/** The section chips: one row that scrolls sideways, a count on each (none at 0), the section on screen lit. */
@Composable
private fun HpJump(counts: List<Int>, active: Int, accent: Color, onPick: (Int) -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(50)
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = d.dp(4f), horizontal = d.dp(2f)), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)),
        verticalAlignment = Alignment.CenterVertically) {
        HP_SECTIONS.forEachIndexed { i, (_, label) ->
            val on = i == active
            Row(Modifier.then(if (on) Modifier.shadow(d.dp(8f), shape, ambientColor = accent, spotColor = accent) else Modifier).clip(shape)
                .background(if (on) accent else Palette.surface).border(1.dp, if (on) accent else Palette.line, shape).clickable { onPick(i) }
                .padding(horizontal = d.dp(12f), vertical = d.dp(7f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                Text(label, color = if (on) inkOn(accent) else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, maxLines = 1, softWrap = false)
                val n = counts.getOrElse(i) { 0 }
                if (n > 0) Text(if (n > 999) "999+" else "$n", color = if (on) accent else Palette.paper, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), maxLines = 1,
                    modifier = Modifier.clip(shape).background(if (on) inkOn(accent) else Palette.muted).padding(horizontal = d.dp(5f), vertical = d.dp(1f)))
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
/** What is watched (band, span, the scan) and the counters, with the time machine's fill and the demodulators in use. */
@Composable
private fun HpHead(s: HpSnap?, now: Long, accent: Color) {
    val d = rememberDims()
    val c = s?.centerHz ?: 0L
    val bandName = hpBandOf(c)?.name?.uppercase() ?: HP_BANDS.firstOrNull { c >= it.lo - 4_000_000 && c <= it.hi + 4_000_000 }?.name?.uppercase() ?: ""
    val tiles = s?.tiles.orEmpty()
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Text(bandName, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, maxLines = 1, softWrap = false)
            if (s != null && s.rate > 0) Text("%.3f–%.3f MHz".format(java.util.Locale.US, s.spanLo / 1e6, s.spanHi / 1e6), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, softWrap = false)
            Text(HamPlus.scanText(now), color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1, softWrap = false)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            val nets = tiles.count { it.net != null }
            val onAir = s?.stats?.onAir ?: 0
            val mins = (s?.stats?.clipS ?: 0L) / 60
            for ((n, l) in listOf("${tiles.size}" to "CHANNELS", "$onAir" to "ON AIR", "${s?.stats?.stations ?: 0}" to "STATIONS", "${s?.convs?.size ?: 0}" to "CONVOS", "$nets" to "NETS", "$mins" to "MIN KEPT")) {
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

/** What is heard: ALL (every channel) or the one followed, and MIX (every channel at once) or NEWEST (the latest to key up). */
@Composable
private fun HpListenRow(hold: String, mode: HpParams.Mode, accent: Color) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(10f))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
        val on = hold.isNotEmpty()
        Row(Modifier.weight(1f).clip(shape).background(if (on) accent.copy(alpha = 0.14f) else Palette.surface).border(1.dp, if (on) accent else Palette.line, shape)
            .padding(horizontal = d.dp(10f), vertical = d.dp(6f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(if (on) "FOLLOWING" else "HEARING", color = if (on) accent else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(8f), letterSpacing = 1.5.sp)
            Text(if (on) hpMhz(hold.toLongOrNull() ?: 0) else "ALL", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 1, softWrap = false)
            Text(if (on) "only this channel is heard" else if (mode == HpParams.Mode.MIX) "every channel at once" else "the newest to key up",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 2, modifier = Modifier.weight(1f))
            if (on) ToggleBox("ALL", false, accent) { HamPlus.follow("") }
        }
        HpSeg(listOf("MIX", "NEWEST"), if (mode == HpParams.Mode.MIX) 0 else 1, accent, Modifier) { HamPlus.setMode(if (it == 0) HpParams.Mode.MIX else HpParams.Mode.NEWEST) }
    }
}

@Composable
private fun HpAudioRow(on: Boolean, gain: Double, accent: Color) {
    val d = rememberDims()
    var dragging by remember { mutableStateOf<Float?>(null) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
        ToggleBox(if (on) "AUDIO ON" else "AUDIO OFF", on, accent) { HamPlus.setAudio(!on) }
        RowLabel("VOLUME")
        Slider(value = dragging ?: (gain * 100).toFloat(), onValueChange = { dragging = it; HamPlus.setAudio(on, it / 100.0) }, onValueChangeFinished = { dragging = null },
            valueRange = 0f..150f, colors = SliderDefaults.colors(thumbColor = accent, activeTrackColor = accent, inactiveTrackColor = Palette.line), modifier = Modifier.weight(1f))
        Text("${(dragging ?: (gain * 100).toFloat()).toInt()}%", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
        IconBox(ClearIcon, "Clear") { HamPlus.clear() }
    }
}

/**
 * The live bar: a replay from the time machine (with STOP), else what is heard right now (the channel, its name, who is
 * talking, how long, its level), else LISTENING. Always the same height, so nothing under it moves.
 */
@Composable
private fun HpLiveBar(s: HpSnap?, now: Long, audioOn: Boolean, hold: String, accent: Color) {
    val d = rememberDims()
    val rp = s?.replay
    val (noteText, noteUntil) = HamPlus.note.collectAsState().value
    val note = if (now < noteUntil && rp?.active != true) noteText else ""
    val heard = if (s != null && audioOn) s.rows.filter { it.live && it.hz.toString() in s.playing } else emptyList()
    val r = heard.maxByOrNull { it.startMs }
    val tile = r?.let { x -> s?.tiles?.firstOrNull { it.hz == x.hz } }
    val col = if (rp?.active == true || note.isNotEmpty()) Palette.accent2 else if (r != null) hpColor(r.color).takeIf { r.color >= 0 } ?: Palette.ok else Palette.line
    val shape = RoundedCornerShape(d.dp(12f))
    val lit = rp?.active == true || r != null || note.isNotEmpty()
    Column(Modifier.fillMaxWidth().height(d.dp(52f)).clip(shape).background(Brush.horizontalGradient(listOf(col.copy(alpha = if (lit) 0.24f else 0.05f), Palette.surface)))
        .border(1.dp, col.copy(alpha = if (lit) 0.9f else 0.6f), shape).padding(horizontal = d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f), Alignment.CenterVertically)) {
        val blink = (now / 500) % 2 == 0L
        if (note.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Text("REPLAY", color = Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1)
                Text(note, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
            Text("a transmission can be replayed as soon as it ends", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            return@Column
        }
        if (rp != null && rp.active) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Box(Modifier.size(d.dp(8f)).alpha(if (blink) 1f else 0.35f).background(Palette.accent2, CircleShape))
                Text("REPLAYING", color = Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1)
                Text(rp.label, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                ToggleBox("STOP", true, accent) { HamPlus.stopReplay() }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                HpBar((rp.pos / max(0.1, rp.total)).toFloat(), Palette.accent2, Modifier.weight(1f).height(d.dp(5f)))
                Text("${hpDur(rp.pos * 1000)} / ${hpDur(rp.total * 1000)}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
            }
            return@Column
        }
        if (r == null) {
            Text("LISTENING", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(9f), letterSpacing = 2.sp)
            Text(if (!audioOn) "audio is off · every channel is still recorded" else if (hold.isNotEmpty()) "waiting for ${hpMhz(hold.toLongOrNull() ?: 0)} MHz to key up" else "nothing on the air · every channel is heard the moment it keys up",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            return@Column
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Box(Modifier.size(d.dp(8f)).alpha(if (blink) 1f else 0.35f).background(Palette.ok, CircleShape))
            Text("NOW PLAYING", color = Palette.ok, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(9f), letterSpacing = 2.sp, maxLines = 1)
            Text(hpMhz(r.hz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f), maxLines = 1, softWrap = false)
            Text(listOfNotNull(tile?.let { hpName(it) }, r.stationLabel.takeIf { it.isNotEmpty() }?.let { "$it talking" }, if (heard.size > 1) "+${heard.size - 1} more" else null).joinToString(" · "),
                color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(hpDur(now - r.startMs), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(listOf(hpTone(r.tone, r.dcs), if (r.direct) "HEARD DIRECT, NEARBY" else "", tile?.offset?.takeIf { tile.kind == "REPEATER" }?.let { "REPEATER $it" } ?: "").filter { it.isNotEmpty() }.joinToString(" · "),
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            HpBar(((r.peakDb.toFloat()) / 40f).coerceIn(0f, 1f), Palette.ok, Modifier.width(d.dp(70f)).height(d.dp(6f)))
        }
    }
}

@Composable
private fun HpBar(frac: Float, c: Color, modifier: Modifier) {
    val f by animateFloatAsState(frac.coerceIn(0f, 1f), tween(220), label = "bar")
    Canvas(modifier) {
        val r = CornerRadius(size.height / 2, size.height / 2)
        drawRoundRect(Palette.line, cornerRadius = r)
        drawRoundRect(c, size = Size(size.width * f, size.height), cornerRadius = r)
    }
}

/** The channel tiles: ALL first, then every channel heard (live ones first), a few columns as the width allows. */
@Composable
private fun HpTileGrid(tiles: List<HpTile>, s: HpSnap?, hold: String, now: Long, accent: Color, acts: HpActs) {
    val d = rememberDims()
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val cols = max(2, (maxWidth / d.dp(156f)).toInt())
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            val cells: List<HpTile?> = listOf<HpTile?>(null) + tiles
            for (row in cells.chunked(cols)) {
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    for (t in row) {
                        if (t == null) HpAllTile(Modifier.weight(1f).fillMaxHeight(), hold.isEmpty(), s, accent) { acts.follow("") }
                        else HpTileBox(Modifier.weight(1f).fillMaxHeight(), t, s?.playing?.contains(t.key) == true, now, accent, acts)
                    }
                    repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
            if (tiles.isEmpty()) EmptyState("hamplus", Modifier.fillMaxWidth().height(d.dp(250f)).panel(), accent)
        }
    }
}

@Composable
private fun HpAllTile(modifier: Modifier, on: Boolean, s: HpSnap?, accent: Color, onTap: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(10f))
    Column(modifier.clip(shape).background(if (on) accent.copy(alpha = 0.16f) else Palette.surface).border(1.dp, if (on) accent else Palette.line, shape)
        .drawBehind { drawRect(if (on) accent else Palette.muted, size = Size(3.dp.toPx(), size.height)) }.clickable { onTap() }
        .padding(start = d.dp(11f), end = d.dp(9f), top = d.dp(7f), bottom = d.dp(7f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
        Text("ALL", color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(15f))
        Text("EVERY CHANNEL", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8f), letterSpacing = 1.sp, maxLines = 1)
        Text(if (on) "hearing all ${s?.tiles?.size ?: 0}" else "tap to hear them all", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 2)
    }
}

/**
 * One channel: its frequency and name (CW ID, band-plan name or kind), its tone and repeater offset, a live level while
 * it is open or when it was last heard, a sparkline of the last 30 minutes, the talk time, and its badges (NET, LINKED,
 * NEARBY when its input is heard, following, muted, priority, and how many transmissions were not recorded). A tap
 * follows it; the i opens its card.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HpTileBox(modifier: Modifier, t: HpTile, playing: Boolean, now: Long, accent: Color, acts: HpActs) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(10f))
    val pulse = rememberInfiniteTransition(label = "live").animateFloat(0.35f, 1f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "p").value
    val edge = when { t.live -> Palette.ok; t.followed -> accent; t.prio -> Palette.accent2; else -> Palette.line }
    val border = when { t.followed -> accent; t.live -> Palette.ok.copy(alpha = 0.4f + 0.5f * pulse); else -> Palette.line }
    Box(modifier.alpha(if (t.muted) 0.5f else 1f).clip(shape).background(if (t.followed) accent.copy(alpha = 0.14f) else if (t.live) Palette.ok.copy(alpha = 0.07f) else Palette.surface)
        .border(1.dp, border, shape).drawBehind { drawRect(edge, size = Size(3.dp.toPx(), size.height)) }.clickable { acts.follow(t.key) }) {
        Column(Modifier.fillMaxWidth().padding(start = d.dp(11f), end = d.dp(8f), top = d.dp(7f), bottom = d.dp(7f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), modifier = Modifier.padding(end = d.dp(20f))) {
                Text(hpMhz(t.hz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(15f), maxLines = 1, softWrap = false)
                if (playing) Text("♪", color = Palette.ok, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(12f))
            }
            Text(hpName(t), color = if (t.callsign.isNotEmpty()) accent else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val line = listOf(hpTone(t.tone, t.dcs), if (t.kind == "REPEATER" || t.use == "output") t.offset else "").filter { it.isNotEmpty() }.joinToString(" · ")
            if (line.isNotEmpty()) Text(line, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (t.live) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                Text("ON AIR ${hpDur(t.openMs)}", color = Palette.ok, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f), maxLines = 1, softWrap = false)
                HpBar((t.snrDb.toFloat() / 40f).coerceIn(0.05f, 1f), Palette.ok, Modifier.weight(1f).height(d.dp(5f)))
            } else Text("${hpAgo(now - t.lastMs)} · ${t.txs} tx · ${hpDur(t.talkMs)}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            HpSpark(t.spark, if (t.live) Palette.ok else accent, Modifier.fillMaxWidth().height(d.dp(14f)))
            val badges = buildList {
                t.net?.let { add("NET · ${it.control}" to accent) }
                if (t.link > 0) add("LINKED ${t.link}" to Palette.accent2)
                if (t.inputHz > 0 && now - t.nearMs < 600_000) add("NEARBY" to Palette.ok)
                if (t.followed) add("FOLLOWING" to accent)
                if (t.prio) add("PRIORITY" to Palette.accent2)
                if (t.muted) add("MUTED" to Palette.muted)
                if (t.unrecorded > 0) add("${t.unrecorded} NOT RECORDED" to Palette.danger)
            }
            if (badges.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) { for ((b, c) in badges) HpPill(b, c) }
        }
        Box(Modifier.align(Alignment.TopEnd).padding(d.dp(5f)).size(d.dp(20f)).clip(CircleShape).border(1.dp, Palette.line, CircleShape).clickable { acts.info(t.key) },
            contentAlignment = Alignment.Center) { Text("i", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f)) }
    }
}

@Composable
private fun HpPill(text: String, c: Color) {
    val d = rememberDims()
    Text(text, color = c, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(7.5f), letterSpacing = 1.sp, maxLines = 1, softWrap = false,
        modifier = Modifier.clip(RoundedCornerShape(50)).border(1.dp, c.copy(alpha = 0.6f), RoundedCornerShape(50)).padding(horizontal = d.dp(6f), vertical = d.dp(1.5f)))
}

/** Seconds on the air each minute for the last 30 minutes, as bars (the newest on the right). */
@Composable
private fun HpSpark(spark: List<Int>, c: Color, modifier: Modifier) {
    Canvas(modifier) {
        val n = max(1, spark.size); val w = size.width / n; val top = max(10, spark.maxOrNull() ?: 0).toFloat()
        drawRect(Palette.line.copy(alpha = 0.5f), Offset(0f, size.height - 1f), Size(size.width, 1f))
        spark.forEachIndexed { i, v -> if (v > 0) { val h = max(2f, size.height * min(1f, v / top)); drawRect(c.copy(alpha = 0.45f + 0.55f * i / n), Offset(i * w + 0.5f, size.height - h), Size(max(1f, w - 1f), h)) } }
    }
}

/** The transmission on lane [hz] nearest [ms], when it is within [tolMs] of its bar; else none (the tap is on empty time). */
internal fun hpTapTx(rows: List<HpTxRow>, hz: Long, ms: Double, now: Double, tolMs: Double): HpTxRow? {
    var best: HpTxRow? = null; var bd = Double.MAX_VALUE
    for (r in rows) {
        if (r.hz != hz) continue
        val e = if (r.live) now else r.endMs
        val dd = if (ms < r.startMs) r.startMs - ms else if (ms > e) ms - e else 0.0
        if (dd <= tolMs && dd < bd) { bd = dd; best = r }
    }
    return best
}

/** What the quiet timeline says: the last transmission heard (a tap replays from it), else that nothing was heard yet. */
internal fun hpQuietText(rows: List<HpTxRow>, now: Double): Pair<String, String> {
    val last = rows.filter { !it.live }.maxByOrNull { it.endMs } ?: return "nothing on the air yet" to "every transmission shows here as it happens"
    return "nothing on the air for ten minutes" to "last heard ${hpMhz(last.hz)}, ${hpAgo(now - last.endMs)}${if (last.recorded) ", tap to replay from there" else ""}"
}

/** A tap within this many dp of a transmission's bar replays that transmission. */
private const val TAP_DP = 10f

/**
 * The band timeline: a lane per channel heard in the last ten minutes, each transmission a bar in its talker's color,
 * the ones on the air growing at the right edge. A tap on a bar replays that transmission; a tap anywhere else replays
 * the whole band from that moment (from the last transmission when tapped after it), a new replay in place of one
 * playing. Quiet, it keeps one lane's height on a phone (the first channel to key up moves nothing) and the grid with
 * a line on what was last heard.
 */
@Composable
private fun HpTimeline(s: HpSnap?, now: Long, accent: Color, acts: HpActs, modifier: Modifier, lanesMax: Int, fill: Boolean = false) {
    val d = rememberDims()
    val all = s?.rows.orEmpty()
    // the window grows with what was heard, two minutes at the least and ten at the most; quiet, it shows all ten
    val first = all.filter { it.live || it.endMs > now - TL_MS }.minOfOrNull { it.startMs }
    val span = if (first == null) TL_MS else ((now - first) + 10_000).coerceIn(120_000.0, TL_MS)
    val t0 = now - span
    val rows = all.filter { it.live || it.endMs > t0 }
    val lanes = rows.map { it.hz }.distinct().sortedBy { h -> -(rows.filter { it.hz == h }.maxOf { if (it.live) now.toDouble() else it.endMs }) }.take(lanesMax).sorted()
    val tiles = s?.tiles.orEmpty()
    val laneH = d.dp(22f); val labelW = d.dp(78f)
    val replayClip = s?.replay?.takeIf { it.active }?.clip ?: -1
    val pulse = rememberInfiniteTransition(label = "tl").animateFloat(0.5f, 1f, infiniteRepeatable(tween(600), RepeatMode.Reverse), label = "p").value
    val fixedH = !fill
    // the tap reads the latest picture: keyed on it, the gesture restarted every redraw and lost taps
    val cur = androidx.compose.runtime.rememberUpdatedState(Triple(rows, lanes, Pair(now, span)))
    val hasKept = all.any { it.recorded && !it.live }
    val keptNow = androidx.compose.runtime.rememberUpdatedState(hasKept)
    val tapEmpty: (Double) -> Unit = { ms -> if (keptNow.value) acts.replayFrom(ms) else HamPlus.note("Nothing recorded yet") }
    Column(modifier.clip(RoundedCornerShape(d.dp(10f))).background(Palette.surface.copy(alpha = 0.5f)).border(1.dp, Palette.line, RoundedCornerShape(d.dp(10f))).padding(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().then(if (fixedH) Modifier.height(laneH * max(1, lanes.size)) else Modifier.weight(1f))) {
            Column(Modifier.width(labelW)) {
                if (lanes.isEmpty()) Column(Modifier.height(laneH), verticalArrangement = Arrangement.Center) {
                    Text("QUIET", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1)
                }
                for (h in lanes) {
                    val t = tiles.firstOrNull { it.hz == h }
                    Column(Modifier.height(laneH).clickable { acts.follow(h.toString()) }, verticalArrangement = Arrangement.Center) {
                        Text(hpMhz(h), color = if (rows.any { it.live && it.hz == h }) Palette.ok else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1, softWrap = false)
                        if (t != null) Text(hpName(t), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            val lineC = Palette.line; val okC = Palette.ok; val inkC = Palette.ink; val mutedC = Palette.muted
            val tolPx = with(LocalDensity.current) { d.dp(TAP_DP).toPx() }
            Box(Modifier.weight(1f).fillMaxHeight()) {
                Canvas(Modifier.fillMaxSize().pointerInput(Unit) {
                    detectTapGestures { p ->
                        val (rs, ls, nt) = cur.value; val (nw, sp) = nt
                        val lh = laneH.toPx()
                        val ms = (nw - sp) + sp * (p.x / size.width).coerceIn(0f, 1f)
                        if (ls.isEmpty()) { tapEmpty(nw.toDouble()); return@detectTapGestures }
                        val h = ls[(p.y / lh).toInt().coerceIn(0, ls.size - 1)]
                        val hit = hpTapTx(rs, h, ms, nw.toDouble(), tolPx * sp / size.width)
                        if (hit != null && hit.recorded && !hit.live) acts.replay(listOf(hit.id), "${hpMhz(hit.hz)} at ${hpClock(hit.startMs)}", "tx")
                        else tapEmpty(ms)
                    }
                }) {
                    val lh = laneH.toPx(); val w = size.width
                    // the big view keeps its grid to the bottom however few channels there are, so it reads as a timeline
                    val gridH = if (lanes.isEmpty() || fill) size.height else lh * lanes.size
                    for (m in 0..10) { val x = w * m / 10f; drawLine(lineC.copy(alpha = if (m % 5 == 0) 0.9f else 0.35f), Offset(x, 0f), Offset(x, gridH)) }
                    lanes.forEachIndexed { li, h ->
                        val y = li * lh
                        drawLine(lineC.copy(alpha = 0.3f), Offset(0f, y + lh), Offset(w, y + lh))
                        for (r in rows) {
                            if (r.hz != h) continue
                            val a = ((r.startMs - t0) / span).toFloat().coerceIn(0f, 1f) * w
                            val b = (((if (r.live) now.toDouble() else r.endMs) - t0) / span).toFloat().coerceIn(0f, 1f) * w
                            val c = if (r.color >= 0) hpColor(r.color) else accent
                            val top = y + lh * 0.18f; val hh = lh * 0.64f
                            drawRoundRect(c.copy(alpha = if (r.live) pulse else if (r.recorded) 0.85f else 0.35f), Offset(a, top), Size(max(2.5f, b - a), hh), CornerRadius(3f, 3f))
                            if (r.id == replayClip) drawRoundRect(inkC, Offset(a - 1f, top - 1f), Size(max(2.5f, b - a) + 2f, hh + 2f), CornerRadius(3f, 3f), style = Stroke(2f))
                            if (r.live) drawCircle(okC, lh * 0.12f, Offset(b, y + lh / 2))
                        }
                    }
                    drawLine(mutedC, Offset(w - 1f, 0f), Offset(w - 1f, gridH), strokeWidth = 2f)
                }
                if (lanes.isEmpty()) {
                    val (head, sub) = hpQuietText(all, now.toDouble())
                    if (fill) Column(Modifier.fillMaxSize().padding(horizontal = d.dp(8f)), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(head.uppercase(), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(sub, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    }
                    else Text(sub, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.align(Alignment.CenterStart).padding(horizontal = d.dp(6f)))
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(start = labelW), horizontalArrangement = Arrangement.SpaceBetween) {
            val mins = (span / 60_000).roundToInt()
            for (l in listOf("−$mins min", if (mins % 2 == 0) "−${mins / 2} min" else "−%.1f min".format(java.util.Locale.US, mins / 2.0), "now")) Text(l, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f))
        }
    }
}

/** The conversations, newest first: each a thread with a bubble per transmission in its talker's color. */
private fun LazyListScope.talkItems(s: HpSnap?, now: Long, accent: Color, acts: HpActs, max: Int): Int {
    val convs = s?.convs.orEmpty().take(max)
    if (s == null || convs.isEmpty()) { item(key = "talk:none") { HpDim("conversations show here as a thread, a bubble per talker, each radio told apart by its own carrier") }; return 1 }
    items(convs, key = { "talk:${it.id}" }) { c -> HpConvCard(c.id, s, now, accent, acts) }
    return convs.size
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HpConvCard(convId: Int, s: HpSnap, now: Long, accent: Color, acts: HpActs) {
    val d = rememberDims()
    val c = s.convs.firstOrNull { it.id == convId } ?: return
    val rows = s.rows.filter { it.conv == convId }.sortedBy { it.startMs }
    val t = s.tiles.firstOrNull { it.hz == c.hz }
    var all by remember(convId) { mutableStateOf(false) }
    val shown = if (all) rows else rows.takeLast(8)
    val shape = RoundedCornerShape(d.dp(12f))
    Column(Modifier.fillMaxWidth().clip(shape).background(Palette.surface).border(1.dp, if (c.live) Palette.ok.copy(alpha = 0.7f) else Palette.line, shape).padding(d.dp(8f)).animateContentSize(),
        verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(hpMhz(c.hz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(14f), maxLines = 1, softWrap = false)
            Text(listOfNotNull(t?.let { hpName(it) }, if (c.live) "ON THE AIR" else hpAgo(now - c.endMs)).joinToString(" · "), color = if (c.live) Palette.ok else Palette.muted,
                fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (c.net) HpPill("NET", accent)
            val ids = rows.filter { it.recorded && !it.live }.map { it.id }
            if (ids.isNotEmpty()) ToggleBox("▶ ${hpDur(c.talkMs)}", false, accent) { acts.replay(ids, "${hpMhz(c.hz)} conversation from ${hpClock(c.startMs)}", "conv") }
        }
        if (rows.size > shown.size) Text("${rows.size - shown.size} earlier · show all", color = accent, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.clickable { all = true }.padding(vertical = d.dp(2f)))
        val order = rows.map { it.station }.filter { it.isNotEmpty() }.distinct()
        for (r in shown) HpBubble(r, order.indexOf(r.station), t?.kind == "REPEATER", now, accent, acts)
    }
}

/** One transmission as a chat bubble: the first talker on the left, the others on the right, each in its own color. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HpBubble(r: HpTxRow, side: Int, repeater: Boolean, now: Long, accent: Color, acts: HpActs) {
    val d = rememberDims()
    val c = if (r.color >= 0) hpColor(r.color) else Palette.ink
    val right = side > 0
    val shape = RoundedCornerShape(topStart = d.dp(12f), topEnd = d.dp(12f), bottomStart = d.dp(if (right) 12f else 3f), bottomEnd = d.dp(if (right) 3f else 12f))
    val pulse = if (r.live) rememberInfiniteTransition(label = "b").animateFloat(0.4f, 1f, infiniteRepeatable(tween(650), RepeatMode.Reverse), label = "p").value else 1f
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (right) Arrangement.End else Arrangement.Start) {
        Column(Modifier.widthIn(max = d.dp(300f)).clip(shape).background(c.copy(alpha = 0.2f).compositeOver(Palette.surface)).border(1.dp, c.copy(alpha = if (r.live) pulse else 0.75f), shape)
            .clickable(enabled = r.recorded && !r.live) { acts.replay(listOf(r.id), "${hpMhz(r.hz)} at ${hpClock(r.startMs)}", "tx") }
            .padding(horizontal = d.dp(9f), vertical = d.dp(5f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                val who = r.stationLabel.ifEmpty { if (repeater) "VIA REPEATER" else "UNKNOWN" }
                Text(who, color = c, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(11f), maxLines = 1, softWrap = false,
                    modifier = if (r.station.isNotEmpty()) Modifier.clickable { acts.rename(r.station, r.stationLabel.takeIf { it.length > 1 } ?: "") } else Modifier)
                Text(if (r.live) "TALKING ${hpDur(now - r.startMs)}" else hpDur(r.endMs - r.startMs), color = if (r.live) Palette.ok else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1)
                if (r.recorded && !r.live) Text("▶", color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(11f))
            }
            val meta = listOf(hpClock(r.startMs), hpTone(r.tone, r.dcs), if (r.offsetHz.isFinite()) "%+d Hz".format(java.util.Locale.US, r.offsetHz.roundToInt()) else "",
                if (r.direct) "NEARBY" else "", cwCallsign(r.cw).let { if (it.isNotEmpty()) "CW ID $it" else "" }, if (!r.recorded) "NOT RECORDED" else "").filter { it.isNotEmpty() }
            Text(meta.joinToString(" · "), color = Palette.ink.copy(alpha = 0.72f), fontFamily = Mono, fontSize = d.sp(8.5f), maxLines = 2)
        }
    }
}

/**
 * The last 24 hours, per band: each cell a quarter hour, brighter the more of it was on the air (airtime over the time
 * listened); a quarter hour never listened to stays a faint dot, so a quiet hour and an unheard one look different.
 */
@Composable
private fun HpHeatmap(s: HpSnap?, now: Long, modifier: Modifier) {
    val d = rememberDims()
    val heat = s?.heat
    val bands = HP_BANDS.filter { b -> heat?.bands?.any { it.id == b.id && it.slots.any { v -> v > 0 } } == true }
    Column(modifier.clip(RoundedCornerShape(d.dp(10f))).background(Palette.surface.copy(alpha = 0.5f)).border(1.dp, Palette.line, RoundedCornerShape(d.dp(10f))).padding(d.dp(8f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        if (heat == null || bands.isEmpty()) { HpDim("each band's busy hours fill in here as the day goes on, kept between sessions"); return@Column }
        val cal = java.util.Calendar.getInstance().apply { timeInMillis = now }
        val nowSlot = (cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 + cal.get(java.util.Calendar.MINUTE)) / (1440 / HEAT_SLOTS)
        val okC = Palette.ok; val lineC = Palette.line; val inkC = Palette.ink
        for (b in bands) {
            val slots = heat.bands.first { it.id == b.id }.slots
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(b.name.uppercase(), color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), modifier = Modifier.width(d.dp(52f)), maxLines = 1)
                Canvas(Modifier.weight(1f).height(d.dp(16f))) {
                    val w = size.width / HEAT_SLOTS
                    for (i in 0 until HEAT_SLOTS) {
                        val cover = heat.cover[i]; val v = slots[i]
                        if (cover < 1 && v <= 0) { drawCircle(lineC, 1.2f, Offset(i * w + w / 2, size.height / 2)); continue }
                        val f = if (cover > 0) min(1.0, v / max(cover, 1.0) * 4).toFloat() else 1f
                        drawRect(okC.copy(alpha = 0.08f + 0.92f * f), Offset(i * w + 0.5f, 0f), Size(max(1f, w - 1f), size.height))
                    }
                    drawRect(inkC, Offset(nowSlot * w, -1f), Size(max(1.5f, w * 0.4f), size.height + 2f))
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(start = d.dp(52f)), horizontalArrangement = Arrangement.SpaceBetween) {
            for (h in listOf("0", "6", "12", "18", "24")) Text(h, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f))
        }
    }
}

/** Every transmission, newest first. */
private fun LazyListScope.logItems(s: HpSnap?, now: Long) {
    val rows = s?.rows.orEmpty().take(200)
    if (rows.isEmpty()) { item(key = "log:none") { HpDim("every transmission is logged here with its time, channel, length, tone and carrier offset") }; return }
    items(rows, key = { "log:${it.id}" }) { r -> HpLogLine(r, now) }
}

@Composable
private fun HpLogLine(r: HpTxRow, now: Long) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth().padding(horizontal = d.dp(4f), vertical = d.dp(1f)), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
        Text(hpClock(r.startMs), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, softWrap = false)
        Text(hpMhz(r.hz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), maxLines = 1, softWrap = false)
        Text(if (r.live) "LIVE" else hpDur(r.endMs - r.startMs), color = if (r.live) Palette.ok else Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, softWrap = false)
        Text(listOf(r.stationLabel, hpTone(r.tone, r.dcs), if (r.offsetHz.isFinite()) "%+d Hz".format(java.util.Locale.US, r.offsetHz.roundToInt()) else "", if (!r.recorded) "NOT RECORDED" else "").filter { it.isNotEmpty() }.joinToString(" · "),
            color = if (r.color >= 0) hpColor(r.color) else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
    }
}

/** A channel's card: all it is known by, follow / mute / priority, its stations (tap one to name it) and its last conversation. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HpTileCard(t: HpTile, s: HpSnap, now: Long, muted: Boolean, prio: Boolean, followed: Boolean, accent: Color, acts: HpActs, modifier: Modifier, onClose: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(12f))
    Column(modifier.padding(vertical = d.dp(4f)).clip(shape).background(Palette.surface).border(1.dp, accent.copy(alpha = 0.7f), shape).padding(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(hpMhz(t.hz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(20f), maxLines = 1, softWrap = false)
            Text(hpName(t), color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            ToggleBox("CLOSE", false, accent) { onClose() }
        }
        val kv = listOfNotNull(
            t.label.takeIf { it.isNotEmpty() }?.let { "BAND PLAN" to it },
            t.kind.takeIf { it.isNotEmpty() }?.let { "KIND" to it },
            if (t.inputHz > 0) "INPUT" to "${hpMhz(t.inputHz)} MHz heard, talkers there are nearby" else t.offset.takeIf { it.isNotEmpty() }?.let { "OFFSET" to "$it (band plan)" },
            hpTone(t.tone, t.dcs).takeIf { it.isNotEmpty() }?.let { "TONE" to it },
            "HEARD" to "${t.txs} transmissions · ${hpDur(t.talkMs)} on the air · ${if (t.live) "on the air now" else hpAgo(now - t.lastMs)}",
            t.net?.let { "NET" to "net control ${it.control}, ${it.checkins} check-ins" },
            if (t.link > 0) "LINKED" to (s.tiles.filter { it.link == t.link && it.key != t.key }.joinToString(", ") { hpMhz(it.hz) }.ifEmpty { "network ${t.link}" }) else null,
            if (t.unrecorded > 0) "NOT RECORDED" to "${t.unrecorded} transmissions came while every demodulator was busy" else null,
        )
        for ((k, v) in kv) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 1.sp, modifier = Modifier.width(d.dp(86f)), maxLines = 1)
            Text(v, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.weight(1f))
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            ToggleBox(if (followed) "FOLLOWING" else "FOLLOW", followed, accent) { acts.follow(t.key) }
            ToggleBox(if (muted) "MUTED" else "MUTE", muted, accent) { HamPlus.pref("mute", t.key) }
            ToggleBox("PRIORITY", prio, accent) { HamPlus.pref("prio", t.key) }
            val conv = s.convs.firstOrNull { it.hz == t.hz }
            val ids = conv?.let { c -> s.rows.filter { it.conv == c.id && it.recorded && !it.live }.map { it.id } }.orEmpty()
            if (ids.isNotEmpty()) ToggleBox("▶ LAST CONVERSATION", false, accent) { acts.replay(ids, "${hpMhz(t.hz)} conversation from ${hpClock(conv!!.startMs)}", "conv") }
        }
        if (t.stations.isNotEmpty()) {
            Text(if (t.kind == "REPEATER") "TALKERS HEARD ON THE INPUT · TAP TO NAME" else "STATIONS BY THEIR CARRIER · TAP TO NAME", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 1.sp)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                for (st in t.stations) {
                    val c = hpColor(st.color); val sh = RoundedCornerShape(d.dp(8f))
                    Row(Modifier.clip(sh).background(c.copy(alpha = 0.14f)).border(1.dp, c.copy(alpha = 0.6f), sh).clickable { acts.rename(st.key, st.label.takeIf { it != st.letter && it != st.callsign } ?: "") }
                        .padding(horizontal = d.dp(8f), vertical = d.dp(4f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        Text(st.label, color = c, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(11f), maxLines = 1, softWrap = false)
                        Text("${st.txs} tx · %+d Hz".format(java.util.Locale.US, st.offsetHz), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, softWrap = false)
                    }
                }
            }
        }
        s.convs.firstOrNull { it.hz == t.hz }?.let { HpConvCard(it.id, s, now, accent, acts) }
    }
}
