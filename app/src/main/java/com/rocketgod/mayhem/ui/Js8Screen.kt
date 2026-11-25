package com.rocketgod.mayhem.ui

import com.rocketgod.mayhem.core.Units
import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.Station
import com.rocketgod.mayhem.core.Tx
import com.rocketgod.mayhem.core.ham.gridToLatLon
import com.rocketgod.mayhem.core.js8.JS8_DIALS
import com.rocketgod.mayhem.core.js8.JS8_MODES
import com.rocketgod.mayhem.core.js8.Js8
import com.rocketgod.mayhem.core.js8.Js8Speed
import com.rocketgod.mayhem.core.js8.js8Mode
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** The views: CHAT, GROUPS, HEARD, MAP, WATERFALL, INBOX, ACTIVITY (a wide screen shows the map and waterfall beside them). */
private val J8_VIEWS = listOf("chat" to "CHAT", "groups" to "GROUPS", "heard" to "HEARD", "map" to "MAP", "band" to "WATERFALL", "inbox" to "INBOX", "log" to "ACTIVITY")
private val J8_WIDE_VIEWS = J8_VIEWS.filter { it.first != "map" && it.first != "band" }

/** What the rows can do, handed down instead of a dozen callbacks. */
private class J8Acts(val pick: (String) -> Unit, val send: (String, String, String, Int) -> Unit, val goMap: (String) -> Unit, val chat: (String) -> Unit)

/**
 * JS8: keyboard-to-keyboard messaging on HF, receive and send. Conversations per station and group, the groups
 * (@ALLCALL, @HB and @TPP built in), the stations heard with their grid, distance and bearing, their map, the passband
 * waterfall with each decode marked, the inbox and every frame decoded. A phone gets one page that scrolls with a
 * pinned row of section chips; a wide screen keeps the map and waterfall in the big pane. Twin of web/src/js8-ui.ts.
 */
@Composable
fun Js8Screen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val s by Js8.state.collectAsState()
    val level by SdrEngine.levelDb.collectAsState()
    val fix by Geo.fix.collectAsState()
    val station by Station.info.collectAsState()
    val needsPrompt by Tx.needsPrompt.collectAsState()
    val txActive by Tx.active.collectAsState()
    var view by rememberSaveable { mutableStateOf("chat") }
    /** A station's call, or "e:<entry id>" for a message opened for its details. */
    var sel by rememberSaveable { mutableStateOf("") }
    var asking by remember { mutableStateOf(false) }
    var focusKey by remember { mutableIntStateOf(0) }
    var focusAt by remember { mutableStateOf<Pair<Double, Double>?>(null) }
    var jump by remember { mutableStateOf<String?>(null) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(250); value = System.currentTimeMillis() } }.value
    LaunchedEffect(Unit) { Geo.start(ctx) }
    // frames go out on their slot boundaries while the screen is up
    LaunchedEffect(Unit) { while (true) { delay(100); Js8.pump() } }
    LaunchedEffect(Unit) { Js8.loadDictionary() }
    if (asking && needsPrompt) SafetyPromptDialog(accent, onCancel = { asking = false }) { Tx.acknowledgeSafety(); asking = false }
    val wide = d.wide
    LaunchedEffect(wide) { if (wide && (view == "map" || view == "band")) view = "chat" }
    val my = station.call.trim().uppercase()

    val acts = J8Acts(
        pick = { k -> sel = if (sel == k) "" else k },
        send = { kind, target, text, snr -> if (Js8.send(kind, target, text, snr) == Js8.Sent.PROMPT) asking = true },
        goMap = { call ->
            val p = s.stations[call]?.grid?.let { gridToLatLon(it) }
            if (p != null) { focusAt = p; focusKey++; sel = call; if (!wide) jump = "map" }
        },
        chat = { call -> Js8.chatWith(call); view = "chat"; if (!wide) jump = "chat" },
    )
    val rooms = remember(s.entries, s.follow, s.read, my) { Js8.rooms(s) }
    val inbox = remember(s.entries, my) { Js8.inbox(s) }
    val counts = mapOf("chat" to rooms.sumOf { it.unread }, "groups" to s.groups.size, "heard" to s.stations.size, "map" to 0, "band" to 0,
        "inbox" to inbox.size, "log" to s.activity.size)
    val sending = s.entries.any { it.mine && (it.state == "queued" || it.state == "sending") } || txActive

    @Composable
    fun map(modifier: Modifier, page: Boolean) {
        val items = s.stations.values.mapNotNull { st -> gridToLatLon(st.grid)?.let { GeoItem(st.call, it.first, it.second, "${st.call} ${Js8.fmtSnr(st.snr)}", GeoItem.Kind.STATION) } }
        GeoMapView(items, accent, modifier.panel(), home = fix ?: Js8.home(), selected = sel.takeIf { it.isNotEmpty() && !it.startsWith("e:") },
            start = remember { mapStart(Js8.home()) }, focus = focusAt, focusKey = focusKey, steady = true, fitPins = true, twoFinger = page,
            emptyTitle = if (items.isEmpty()) "No stations with a grid yet" else "", emptySub = "Stations appear on the map once they send their grid",
            fallback = { Js8.home() ?: Geo.lastKnownPos() ?: Geo.zoneGuess() }) { id -> sel = id; view = "heard"; if (!wide) jump = "heard" }
    }

    val face: @Composable () -> Unit = {
        FreqCard(accent, tag = "JS8", title = "HF MESSAGING", freq = s.dial, meter = level / 40f, left = "SIGNAL +%.0f dB".format(level),
            right = if (s.activity.isNotEmpty()) "${s.activity.size} frames" else "nothing decoded yet",
            onTune = { Js8.tune(it) },
            lamp = {
                if (sending) Lamp("SENDING", Palette.danger, blink = true)
                else if (s.stations.isNotEmpty()) Lamp("${s.stations.size} HEARD", Palette.ok)
                else Lamp("LISTENING", Palette.accent2, blink = true)
            })
    }

    if (wide) {
        AdaptivePane(face = face, visual = { m ->
            Column(m, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                map(Modifier.fillMaxWidth().weight(1f), false)
                J8Waterfall(s, accent, Modifier.fillMaxWidth().height(d.dp(200f)))
            }
        }) {
            Column(Modifier.fillMaxWidth().weight(1f).padding(top = d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                J8Head(s, now, accent)
                J8Seg(J8_WIDE_VIEWS.map { (k, l) -> if ((counts[k] ?: 0) > 0) "$l ${counts[k]}" else l }, J8_WIDE_VIEWS.indexOfFirst { it.first == view }, accent, Modifier.fillMaxWidth()) {
                    view = J8_WIDE_VIEWS[it].first
                }
                LazyColumn(Modifier.fillMaxWidth().weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    when (view) {
                        "chat" -> chatItems(s, rooms, now, sel, accent, acts, "chat", compose = false)
                        "groups" -> groupItems(s, rooms, accent, "groups")
                        "heard" -> heardItems(s, now, sel, accent, acts, "heard")
                        "inbox" -> inboxItems(s, inbox, now, sel, accent, acts, "inbox")
                        else -> logItems(s, accent, "log")
                    }
                }
                // the compose box stays at the bottom while the chat scrolls
                if (view == "chat") J8Compose(s, accent, acts)
            }
        }
        return
    }

    // the phone: one page that scrolls, nothing hidden behind tabs. The section chips stay pinned on top; a chip
    // scrolls to its section, and the chip of the section on screen lights up. The map is the big size (70% of the
    // screen, 320 to 560 dp)
    AdaptivePane(share = true, noVisual = true, face = face, visual = {}) {
        val list = rememberLazyListState()
        val scope = rememberCoroutineScope()
        val starts = remember { IntArray(J8_VIEWS.size) }
        val mapH = (LocalConfiguration.current.screenHeightDp * 0.7f).coerceIn(320f, 560f).dp
        val th = with(LocalDensity.current) { d.dp(24f).roundToPx() }
        val active by remember { derivedStateOf {
            val first = list.layoutInfo.visibleItemsInfo.firstOrNull { it.offset + it.size > th }
            val k = (first?.key as? String)?.substringBefore(':') ?: "chat"
            if (!list.canScrollForward && list.canScrollBackward) J8_VIEWS.size - 1 else J8_VIEWS.indexOfFirst { it.first == k }.coerceAtLeast(0)
        } }
        LaunchedEffect(jump) { val j = jump ?: return@LaunchedEffect; val i = J8_VIEWS.indexOfFirst { it.first == j }; if (i >= 0) list.animateScrollToItem(starts[i]); jump = null }
        Column(Modifier.fillMaxWidth().weight(1f).padding(top = d.dp(4f))) {
            Column(Modifier.fillMaxWidth().background(Palette.paper).padding(bottom = d.dp(4f))) {
                J8Jump(J8_VIEWS.map { it.second }, J8_VIEWS.map { counts[it.first] ?: 0 }, active, accent) { i -> scope.launch { list.animateScrollToItem(starts[i]) } }
            }
            LazyColumn(Modifier.fillMaxWidth().weight(1f), state = list, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                var idx = 0
                item(key = "chat:top") { J8Head(s, now, accent) }; idx++
                starts[0] = idx; item(key = "chat:head") { J8SecHead("CHAT") }; idx++
                idx += chatItems(s, rooms, now, sel, accent, acts, "chat")
                starts[1] = idx; item(key = "groups:head") { J8SecHead("GROUPS") }; idx++
                idx += groupItems(s, rooms, accent, "groups")
                starts[2] = idx; item(key = "heard:head") { J8SecHead("HEARD") }; idx++
                idx += heardItems(s, now, sel, accent, acts, "heard")
                starts[3] = idx; item(key = "map:head") { J8SecHead("MAP") }; idx++
                item(key = "map:map") { map(Modifier.fillMaxWidth().height(mapH), true) }; idx++
                starts[4] = idx; item(key = "band:head") { J8SecHead("WATERFALL") }; idx++
                item(key = "band:wf") { J8Waterfall(s, accent, Modifier.fillMaxWidth().height(d.dp(260f))) }; idx++
                starts[5] = idx; item(key = "inbox:head") { J8SecHead("INBOX") }; idx++
                idx += inboxItems(s, inbox, now, sel, accent, acts, "inbox")
                starts[6] = idx; item(key = "log:head") { J8SecHead("ACTIVITY") }; idx++
                logItems(s, accent, "log")
            }
        }
    }
}

// ---- the head: band chips, speeds, the slot clock ----------------------------------------------------------------------
@Composable
private fun J8Head(s: Js8.State, now: Long, accent: Color) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            for ((l, f) in JS8_DIALS) {
                val on = f == s.dial; val shape = RoundedCornerShape(d.dp(9f))
                Column(Modifier.clip(shape).background(if (on) accent else Palette.surface).border(1.dp, if (on) accent else Palette.line, shape)
                    .clickable { Js8.tune(f) }.padding(horizontal = d.dp(10f), vertical = d.dp(5f)), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(l, color = if (on) inkOn(accent) else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1)
                    Text("%.3f".format(java.util.Locale.US, f / 1e6), color = if (on) inkOn(accent) else Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
                }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            for (m in JS8_MODES) ToggleBox(m.label, s.speeds[m.id] != false, accent, Modifier.weight(1f)) { Js8.toggleSpeed(m.id) }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(10f)), verticalAlignment = Alignment.CenterVertically) {
            for (m in JS8_MODES) {
                val p = m.period * 1000L; val left = ceil((p - now % p) / 1000.0).toInt()
                val on = s.speeds[m.id] != false
                Text("${m.label} $left s", color = if (m.id == s.txSpeed) accent else if (on) Palette.ink else Palette.muted, fontFamily = Mono,
                    fontWeight = if (m.id == s.txSpeed) FontWeight.Bold else FontWeight.Medium, fontSize = d.sp(10f), maxLines = 1)
            }
            Text("${Js8.utc(now)} UTC", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.End)
        }
    }
}

// ---- chat ----------------------------------------------------------------------------------------------------------------
/** The chat's rows into a list, keyed under [sec]; returns how many items it added. */
private fun LazyListScope.chatItems(s: Js8.State, rooms: List<Js8.Room>, now: Long, sel: String, accent: Color, acts: J8Acts, sec: String, compose: Boolean = true): Int {
    var n = 0
    val room = s.room
    item(key = "$sec:chathead") { J8ChatHead(room, accent) }; n++
    if (room.isEmpty()) { item(key = "$sec:rooms") { J8Rooms(s, rooms, now, accent) }; n++ }
    val my = Js8.me()
    val items = if (room.isNotEmpty()) s.entries.filter { Js8.roomOf(it, my) == room }.takeLast(80)
        else s.entries.filter { it.meaning.kind != "text" || it.mine || it.frames > 1 }.takeLast(30)
    if (items.isEmpty()) { item(key = "$sec:none") { J8Dim(if (room.isNotEmpty()) "Nothing in ${Js8.roomTitle(room)} yet" else "No messages yet") }; n++ }
    else { items(items, key = { "$sec:e:${it.id}" }) { e -> J8Bubble(e, now, sel == "e:${e.id}", accent) { acts.pick("e:${e.id}") } }; n += items.size }
    if (compose) { item(key = "$sec:compose") { J8Compose(s, accent, acts) }; n++ }
    return n
}

@Composable
private fun J8ChatHead(room: String, accent: Color) {
    val d = rememberDims()
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        if (room.isNotEmpty()) ToggleBox("‹ ALL", false, accent) { Js8.allRooms() }
        Text(if (room.isNotEmpty()) Js8.roomTitle(room) else "ALL ROOMS", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 1.sp)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun J8Rooms(s: Js8.State, rooms: List<Js8.Room>, now: Long, accent: Color) {
    val d = rememberDims()
    if (rooms.isEmpty()) { EmptyState("js8", Modifier.fillMaxWidth().panel(), accent); return }
    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        for (r in rooms) {
            val fol = Js8.followed(s, r.key); val shape = RoundedCornerShape(d.dp(10f))
            Row(Modifier.widthIn(min = d.dp(150f)).clip(shape).background(Palette.surface).border(1.dp, if (fol) accent else Palette.line, shape)
                .clickable { Js8.openRoom(r.key) }.padding(horizontal = d.dp(10f), vertical = d.dp(6f)), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Column(Modifier.weight(1f, fill = false)) {
                    Text(Js8.roomTitle(r.key), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(if (r.n > 0) "${r.n} · ${Js8.ago(r.last, now)}" else "no messages yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
                }
                if (r.unread > 0) J8Count(r.unread, accent)
            }
        }
    }
}

@Composable
private fun J8Count(n: Int, accent: Color) {
    val d = rememberDims()
    Text(if (n > 999) "999+" else "$n", color = inkOn(accent), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), maxLines = 1,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(accent).padding(horizontal = d.dp(6f), vertical = d.dp(1f)))
}

@Composable
private fun J8Bubble(e: Js8.Entry, now: Long, open: Boolean, accent: Color, onTap: () -> Unit) {
    val d = rememberDims()
    val m = e.meaning; val tome = Js8.forMe(e)
    val who = if (e.mine) "YOU" else m.from.ifEmpty { "UNKNOWN" }
    val body = if (m.from.isNotEmpty() && e.text.startsWith("${m.from}:")) e.text.substring(m.from.length + 1).trim() else e.text
    val meta = if (e.mine) "${Js8.utc(e.ms)} · ${js8Mode(e.mode).label} · ${e.hz} Hz · ${when (e.state) { "sent" -> "SENT"; "sending" -> "SENDING"; "failed" -> "NOT SENT"; else -> "QUEUED" }}"
        else "${Js8.utc(e.ms)} · ${e.mode.short} · ${Js8.fmtSnr(e.snr)} dB · ${e.hz} Hz"
    val tag = if (m.kind != "directed" && m.kind != "text") (m.command ?: m.kind.uppercase()) else null
    val big = d.dp(12f); val small = d.dp(4f)
    // a speech bubble: the corner by the speaker is the sharp one
    val shape = if (e.mine) RoundedCornerShape(big, big, small, big) else RoundedCornerShape(big, big, big, small)
    val edge = if (tome) Palette.accent2 else if (e.mine) accent.copy(alpha = 0.5f) else Palette.line
    Box(Modifier.fillMaxWidth(), contentAlignment = if (e.mine) Alignment.CenterEnd else Alignment.CenterStart) {
        Column(Modifier.fillMaxWidth(0.92f).clip(shape).background(if (e.mine) lerp(Palette.surface, accent, 0.14f) else Palette.surface).border(1.dp, edge, shape)
            .clickable(onClick = onTap).padding(horizontal = d.dp(10f), vertical = d.dp(7f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Text(who, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 0.5.sp, maxLines = 1)
                if (tag != null) Text(tag, color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1,
                    modifier = Modifier.border(1.dp, accent.copy(alpha = 0.5f), RoundedCornerShape(4.dp)).padding(horizontal = d.dp(5f), vertical = d.dp(1f)))
                Text(meta, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
            Text(androidx.compose.ui.text.buildAnnotatedString {
                append(body)
                if (e.complete && !e.mine) withStyle(androidx.compose.ui.text.SpanStyle(color = Palette.muted)) { append(" \u2662") }
            }, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(13f))
            if (open) {
                Box(Modifier.fillMaxWidth().padding(top = d.dp(4f)).height(1.dp).background(Palette.line))
                J8EntryDetail(e, now)
            }
        }
    }
}

@Composable
private fun J8EntryDetail(e: Js8.Entry, now: Long) {
    val m = e.meaning
    val rows = buildList {
        add("Heard" to "${Js8.utc(e.ms)} UTC, ${Js8.ago(e.ms, now)} ago"); add("Speed" to js8Mode(e.mode).label); add("Offset" to "${e.hz} Hz")
        add("SNR" to "${Js8.fmtSnr(e.snr)} dB"); add("DT" to "%.1f s".format(java.util.Locale.US, e.dt)); add("Frames" to "${e.frames}")
        add("Type" to (m.command ?: m.kind.uppercase()))
        if (m.from.isNotEmpty()) add("From" to m.from)
        if (m.to.isNotEmpty()) add("To" to m.to)
        if (!m.path.isNullOrEmpty()) add("Relay" to (listOf(m.to) + m.path).joinToString(" > "))
        if (m.dest != null) add("For" to m.dest)
        if (m.snr != null) add("Report" to "${Js8.fmtSnr(m.snr)} dB")
        if (m.grid != null) add("Grid" to m.grid)
        if (m.msgId != null) add("Message" to "${m.msgId}")
        add("Text" to e.text)
    }
    J8Kv(rows)
}

@Composable
private fun J8Kv(rows: List<Pair<String, String>>) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth().padding(top = d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
        for ((k, v) in rows) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.widthIn(min = d.dp(76f)))
            Text(v, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.weight(1f))
        }
    }
}

/** Compose: the target and speed, the text and SEND, HEARTBEAT and CQ, the frame count and the transmit offset. */
@Composable
private fun J8Compose(s: Js8.State, accent: Color, acts: J8Acts) {
    val d = rememberDims()
    var text by remember { mutableStateOf(s.draft) }
    LaunchedEffect(s.draftRev) { text = Js8.state.value.draft }
    val budget = remember(s.target, text, s.txSpeed, s.status, s.dict) {
        val p = Js8.plan(s.target, text)
        if (p.why.isNotEmpty()) p.why else {
            val n = p.frames?.size ?: 0; val m = js8Mode(s.txSpeed)
            if (n > 0) "$n frame${if (n > 1) "s" else ""} · ${n * m.period} s at ${m.label}" else "type a message"
        }
    }
    val targets = buildList {
        add("BAND"); addAll(s.groups); addAll(s.stations.values.sortedByDescending { it.lastMs }.take(40).map { it.call })
        if (s.target.isNotEmpty() && s.target !in this) add(1, s.target)
    }
    Column(Modifier.fillMaxWidth().panel().padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            J8Menu(targets.map { it to ((if (it == "BAND") "BAND (no address)" else it) + if (Js8.followed(s, it)) " ★" else "") }, s.target.ifEmpty { "BAND" }, accent, Modifier.weight(1.6f)) { Js8.setTarget(it) }
            J8Menu(JS8_MODES.map { it.id.id to it.label }, s.txSpeed.id, accent, Modifier.weight(1f)) { id -> Js8Speed.of(id)?.let { Js8.setTxSpeed(it) } }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(text, { text = it; Js8.setDraft(it) }, modifier = Modifier.weight(1f), singleLine = true,
                textStyle = LocalTextStyle.current.copy(fontFamily = Mono),
                placeholder = { Text("message", fontFamily = Mono, color = Palette.muted) },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { acts.send("text", s.target, text, 0) }),
                colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Palette.ink, unfocusedTextColor = Palette.ink, focusedBorderColor = accent,
                    unfocusedBorderColor = Palette.line, cursorColor = accent))
            ToggleBox("SEND", true, accent) { acts.send("text", s.target, text, 0) }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            ToggleBox("HEARTBEAT", false, accent, Modifier.weight(1f)) { acts.send("hb", "", "", 0) }
            ToggleBox("CQ", false, accent, Modifier.weight(1f)) { acts.send("cq", "", "", 0) }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
            Text(budget, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.weight(1f), maxLines = 2)
            ToggleBox("−", false, accent) { Js8.nudgeTx(-50) }
            Text("TX ${s.txHz.roundToInt()} Hz", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1)
            ToggleBox("+", false, accent) { Js8.nudgeTx(50) }
        }
        if (s.status.isNotEmpty()) Text(s.status, color = Palette.accent2, fontFamily = Mono, fontSize = d.sp(10f))
    }
}

/** A select: the chosen label, and the list it opens. */
@Composable
private fun J8Menu(options: List<Pair<String, String>>, picked: String, accent: Color, modifier: Modifier, onPick: (String) -> Unit) {
    val d = rememberDims()
    var open by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(6.dp)
    Box(modifier) {
        Text("${options.firstOrNull { it.first == picked }?.second ?: picked}  ▾", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth().clip(shape).border(1.dp, accent.copy(alpha = 0.7f), shape).clickable { open = true }
                .padding(horizontal = d.dp(12f), vertical = d.dp(8f)))
        DropdownMenu(open, onDismissRequest = { open = false }, modifier = Modifier.background(Palette.surface)) {
            for ((k, l) in options) DropdownMenuItem(text = {
                Text((if (k == picked) "✓ " else "") + l, color = if (k == picked) accent else Palette.ink, fontFamily = Mono,
                    fontWeight = if (k == picked) FontWeight.Bold else FontWeight.Medium, fontSize = d.sp(12f))
            }, onClick = { open = false; onPick(k) })
        }
    }
}

// ---- groups ------------------------------------------------------------------------------------------------------------
private fun LazyListScope.groupItems(s: Js8.State, rooms: List<Js8.Room>, accent: Color, sec: String): Int {
    items(s.groups, key = { "$sec:g:$it" }) { g -> J8Group(s, g, rooms.firstOrNull { it.key == g }?.n ?: 0, accent) }
    item(key = "$sec:add") { J8AddGroup(accent) }
    return s.groups.size + 1
}

@Composable
private fun J8Group(s: Js8.State, g: String, n: Int, accent: Color) {
    val d = rememberDims()
    val fol = Js8.followed(s, g); val builtIn = g in Js8.BUILTIN_GROUPS
    Row(Modifier.fillMaxWidth().panel(if (fol) accent.copy(alpha = 0.6f) else Palette.line).padding(horizontal = d.dp(10f), vertical = d.dp(6f)),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Column(Modifier.weight(1f).clickable { Js8.openRoom(g) }) {
            Text(g, color = if (fol) accent else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1)
            Text("$n message${if (n == 1) "" else "s"}${if (builtIn) " · built in" else ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
        }
        ToggleBox(if (fol) "FOLLOWING" else "FOLLOW", fol, accent) { Js8.toggleFollow(g) }
        if (!builtIn) IconBox(ClearIcon, "Remove $g") { Js8.removeGroup(g) }
    }
}

@Composable
private fun J8AddGroup(accent: Color) {
    val d = rememberDims()
    var v by remember { mutableStateOf("") }
    fun add() { if (Js8.addGroup(v)) v = "" }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(v, { v = it }, modifier = Modifier.weight(1f), singleLine = true, textStyle = LocalTextStyle.current.copy(fontFamily = Mono),
            placeholder = { Text("@GROUPNAME", fontFamily = Mono, color = Palette.muted) },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { add() }),
            colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Palette.ink, unfocusedTextColor = Palette.ink, focusedBorderColor = accent, unfocusedBorderColor = Palette.line, cursorColor = accent))
        ToggleBox("ADD", false, accent) { add() }
    }
}

// ---- heard ---------------------------------------------------------------------------------------------------------------
private fun LazyListScope.heardItems(s: Js8.State, now: Long, sel: String, accent: Color, acts: J8Acts, sec: String): Int {
    val list = s.stations.values.sortedByDescending { it.lastMs }
    if (list.isEmpty()) { item(key = "$sec:none") { J8Dim("Stations show here as they are heard") }; return 1 }
    items(list, key = { "$sec:s:${it.call}" }) { st -> J8Station(st, now, sel == st.call, accent, acts) }
    return list.size
}

@Composable
private fun J8Station(st: Js8.Station, now: Long, open: Boolean, accent: Color, acts: J8Acts) {
    val d = rememberDims()
    val w = if (st.grid.isNotEmpty()) Js8.where(st.grid) else null
    val live = now - st.lastMs < 5 * 60_000
    Column(Modifier.fillMaxWidth().panel(if (open) accent else Palette.line).then(if (live) Modifier.drawBehind { drawRect(accent, size = Size(3.dp.toPx(), size.height)) } else Modifier)
        .clickable { acts.pick(st.call) }.padding(horizontal = d.dp(10f), vertical = d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            Text(st.call, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), maxLines = 1)
            Text("${Js8.fmtSnr(st.snr)} dB", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1)
            Text(Js8.ago(st.lastMs, now), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1)
            Text("${st.hz.roundToInt()} Hz", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1)
            Text(st.grid, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1)
            Text(if (w != null) "${Units.fmtDist(w.first)} ${Js8.compass(w.second)}" else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1,
                modifier = Modifier.weight(1f), overflow = TextOverflow.Ellipsis)
        }
        if (open) {
            J8Kv(buildList {
                add("Last heard" to "${Js8.utc(st.lastMs)} UTC · ${js8Mode(st.mode).label}"); add("Offset" to "${st.hz.roundToInt()} Hz"); add("SNR" to "${Js8.fmtSnr(st.snr)} dB")
                add("DT" to "%.2f s now · %.2f s average".format(java.util.Locale.US, st.dt, st.dtAvg)); add("Drift" to "%.1f Hz/min".format(java.util.Locale.US, st.drift))
                if (st.grid.isNotEmpty()) add("Grid" to st.grid)
                if (w != null) add("From you" to "${Units.fmtDist(w.first)} · ${w.second.roundToInt()}° ${Js8.compass(w.second)}")
                add("Frames" to "${st.heard} since ${Js8.utc(st.firstMs)} UTC")
            })
            Row(horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                ToggleBox("MESSAGE", false, accent) { acts.chat(st.call) }
                ToggleBox("ACK ${Js8.fmtSnr(st.snr)} dB", false, accent) { acts.send("hbsnr", st.call, "", st.snr) }
                if (st.grid.isNotEmpty()) ToggleBox("MAP", false, accent) { acts.goMap(st.call) }
            }
        }
    }
}

// ---- inbox ---------------------------------------------------------------------------------------------------------------
private fun LazyListScope.inboxItems(s: Js8.State, inbox: List<Js8.Entry>, now: Long, sel: String, accent: Color, acts: J8Acts, sec: String): Int {
    val kept = Js8.keptForOthers(s)
    if (inbox.isEmpty() && kept.isEmpty()) {
        val my = Js8.me()
        item(key = "$sec:none") { J8Dim(if (my.isNotEmpty()) "Messages to $my land here" else "Set your callsign in Settings, STATION, and messages to you land here") }
        return 1
    }
    var n = 0
    val mine = inbox.asReversed()
    items(mine, key = { "$sec:e:${it.id}" }) { e -> J8Bubble(e, now, sel == "e:${e.id}", accent) { acts.pick("e:${e.id}") } }; n += mine.size
    if (kept.isNotEmpty()) {
        item(key = "$sec:keptcap") { J8SecHead("KEPT FOR OTHERS") }; n++
        items(kept, key = { "$sec:k:${it.id}" }) { e -> J8Kept(e, accent) }; n += kept.size
    }
    return n
}

@Composable
private fun J8Kept(e: Js8.Entry, accent: Color) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth().panel().padding(horizontal = d.dp(10f), vertical = d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        Row(horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
            Text(e.meaning.from, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f))
            Text("FOR ${e.meaning.dest ?: ""}", color = Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f))
            Text(Js8.utc(e.ms), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
        }
        Text(e.meaning.body, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(12f))
        ToggleBox("DELIVER", false, accent) { Js8.deliver(e.id) }
    }
}

// ---- activity ------------------------------------------------------------------------------------------------------------
private fun LazyListScope.logItems(s: Js8.State, accent: Color, sec: String): Int {
    if (s.activity.isEmpty()) { item(key = "$sec:none") { J8Dim("Every frame decoded shows here with its time, speed, SNR, DT and offset") }; return 1 }
    val rows = s.activity.take(200)
    items(rows.size, key = { "$sec:a:${rows[it].ms}:${rows[it].hz}:$it" }) { i ->
        val a = rows[i]; val d = rememberDims()
        Row(Modifier.fillMaxWidth().background(if (i % 2 == 1) Palette.surface else Color.Transparent).padding(horizontal = d.dp(6f), vertical = d.dp(3f)),
            horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("%s %s %3s %4.1f %4d".format(java.util.Locale.US, Js8.utc(a.ms), a.mode.short, Js8.fmtSnr(a.snr), a.dt, a.hz.roundToInt()),
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1)
            Text(a.text, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.weight(1f))
        }
    }
    item(key = "$sec:clear") { Row { ToggleBox("CLEAR", false, accent) { Js8.clearActivity() } } }
    return rows.size + 1
}

// ---- the passband waterfall ------------------------------------------------------------------------------------------------
/**
 * The audio passband (0-3200 Hz), newest at the top, each decode boxed and labeled where and when it was heard, and
 * the transmit offset in red. A tap sets the transmit offset.
 */
@Composable
private fun J8Waterfall(s: Js8.State, accent: Color, modifier: Modifier) {
    val d = rememberDims()
    val tick by Js8.wfTick.collectAsState()
    val rows = remember(tick) { Js8.wfSnapshot() }
    val shown = max(60, min(240, rows.size))
    val bmp = remember(tick) {
        val w = 512; val h = shown; val px = IntArray(w * h) { 0xFF05080A.toInt() }
        val n = rows.size
        for (y in 0 until h) {
            val ri = n - 1 - y; if (ri < 0) break
            val r = rows[ri].row
            for (x in 0 until w) {
                val v = r[x].toInt() and 0xFF
                val red = min(255, if (v * 1.1 > 180) (v - 160) * 3 else 0); val g = min(255, (v * 0.9).toInt()); val b = min(255, (40 + v * 0.7).toInt())
                px[y * w + x] = (0xFF shl 24) or (red.coerceAtLeast(0) shl 16) or (g shl 8) or b
            }
        }
        Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888).asImageBitmap()
    }
    val labelPaint = remember { android.graphics.Paint().apply { isAntiAlias = true; typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD) } }
    val density = LocalDensity.current
    Column(modifier, verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
        Box(Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(d.dp(12f))).border(1.dp, Palette.line, RoundedCornerShape(d.dp(12f)))) {
            Canvas(Modifier.fillMaxSize().pointerInput(Unit) {
                detectTapGestures { o -> val hz = ((o.x / size.width) * 3200 / 10).roundToInt() * 10.0; Js8.setTxHz(hz); Js8.status("transmit offset ${Js8.state.value.txHz.roundToInt()} Hz") }
            }) {
                val w = size.width; val hgt = size.height; val maxHz = 3200f
                drawImage(bmp, IntOffset.Zero, IntSize(bmp.width, bmp.height), IntOffset.Zero, IntSize(w.roundToInt(), hgt.roundToInt()), filterQuality = FilterQuality.Low)
                val rowH = hgt / shown
                val newest = rows.lastOrNull()?.ms ?: System.currentTimeMillis()
                labelPaint.color = accent.toArgb(); labelPaint.textSize = with(density) { 10.sp.toPx() }
                for (mk in s.marks) {
                    val y = (newest - mk.ms) / 250f * rowH; if (y < 0 || y > hgt) continue
                    val x = (mk.hz / maxHz * w).toFloat(); val bw = max(3f, (8 * js8Mode(mk.mode).spacing / maxHz * w).toFloat())
                    drawRect(accent, Offset(x, y - 2), Size(bw, 4f), style = Stroke(1.5f))
                    drawContext.canvas.nativeCanvas.drawText(mk.label, min(w - 60 * density.density, x + bw + 3), y + labelPaint.textSize / 3, labelPaint)
                }
                // transmit offset
                val tx = (s.txHz / maxHz * w).toFloat(); val tw = (8 * js8Mode(s.txSpeed).spacing / maxHz * w).toFloat()
                drawRect(Color(0x2EFF5050), Offset(tx, 0f), Size(max(2f, tw), hgt))
                drawLine(Color(0xFFFF5050), Offset(tx + 0.5f, 0f), Offset(tx + 0.5f, hgt), 1f)
            }
        }
        Box(Modifier.fillMaxWidth().height(d.dp(14f))) {
            Canvas(Modifier.fillMaxSize()) {
                val p = android.graphics.Paint().apply { isAntiAlias = true; color = Palette.muted.toArgb(); textSize = with(density) { 9.sp.toPx() }; textAlign = android.graphics.Paint.Align.CENTER }
                for (f in listOf(500, 1000, 1500, 2000, 2500, 3000)) drawContext.canvas.nativeCanvas.drawText("$f", f / 3200f * size.width, size.height - 2, p)
            }
        }
    }
}

// ---- pieces ----------------------------------------------------------------------------------------------------------------
@Composable
private fun J8Dim(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(d.dp(8f)))
}

/** A section's small header on the phone page. */
@Composable
private fun J8SecHead(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 2.sp,
        modifier = Modifier.padding(top = d.dp(10f), start = d.dp(2f), bottom = d.dp(2f)))
}

/** The section chips: one row that scrolls sideways, a count on each (none at 0), the section on screen lit. */
@Composable
private fun J8Jump(labels: List<String>, counts: List<Int>, active: Int, accent: Color, onPick: (Int) -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(50)
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = d.dp(4f), horizontal = d.dp(2f)), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)),
        verticalAlignment = Alignment.CenterVertically) {
        labels.forEachIndexed { i, label ->
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

/** Choices sized to their labels that wrap onto another line rather than clip. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun J8Seg(labels: List<String>, selected: Int, accent: Color, modifier: Modifier, onPick: (Int) -> Unit) {
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
