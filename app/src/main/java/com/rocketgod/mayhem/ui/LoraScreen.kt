@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package com.rocketgod.mayhem.ui

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInParent
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.Station
import com.rocketgod.mayhem.core.Tx
import com.rocketgod.mayhem.core.Units
import com.rocketgod.mayhem.core.apps.MeshField
import com.rocketgod.mayhem.core.ham.distanceBearing
import com.rocketgod.mayhem.core.lora.LoraChatRow
import com.rocketgod.mayhem.core.lora.LoraHistory
import com.rocketgod.mayhem.core.lora.LoraHub
import com.rocketgod.mayhem.core.lora.LoraLocal
import com.rocketgod.mayhem.core.lora.LoraMe
import com.rocketgod.mayhem.core.lora.LoraMsg
import com.rocketgod.mayhem.core.lora.LoraNode
import com.rocketgod.mayhem.core.lora.LoraPlan
import com.rocketgod.mayhem.core.lora.LoraScanner
import com.rocketgod.mayhem.core.lora.LoraSend
import kotlinx.coroutines.delay
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/** Each network's color: its filter chip, its dots, its pins and its links on the map. */
internal val LORA_NET_COLOR = mapOf("Meshtastic" to Color(0xFF67EA94), "MeshCore" to Color(0xFFA890FF), "LoRaWAN" to Color(0xFFF2A93B), "LoRa" to Color(0xFF8A93A6))
private val LORA_NETS = listOf("all", "Meshtastic", "MeshCore", "LoRaWAN")
private val LORA_COLS = listOf("Meshtastic", "MeshCore", "LoRaWAN")
private val LORA_VIEWS = listOf("map", "nodes", "messages", "channels", "log")
private fun netColor(proto: String): Color = LORA_NET_COLOR[proto] ?: LORA_NET_COLOR.getValue("LoRa")

private val SendIcon: ImageVector by lazy { loraIcon("Send", "M2.01 21 23 12 2.01 3 2 10l15 2-15 2z") }
/** An outlined smiley (Material's sentiment satisfied, outlined). */
private val SmileIcon: ImageVector by lazy {
    loraIcon("Smile", "M15.5 9.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0M8.5 9.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0" +
        "M12 16c-1.48 0-2.75-.81-3.45-2H6.88c.8 2.05 2.79 3.5 5.12 3.5s4.32-1.45 5.12-3.5h-1.67c-.7 1.19-1.97 2-3.45 2z" +
        "m-.01-14C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z")
}
private fun loraIcon(name: String, path: String): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).addPath(addPathNodes(path), fill = SolidColor(Color.Black)).build()

/** A protocol's enum name read as words: TELEMETRY_APP is Telemetry, CLIENT_BASE is Client base, RAK4631 stays. */
private val LORA_WORDS = mapOf(
    "ENCRYPTED" to "Encrypted (private channel)", "TEXT_MESSAGE_APP" to "Text message", "NODEINFO_APP" to "Node info", "POSITION_APP" to "Position",
    "TELEMETRY_APP" to "Telemetry", "ROUTING_APP" to "Routing", "TRACEROUTE_APP" to "Traceroute", "NEIGHBORINFO_APP" to "Neighbor info",
    "MAP_REPORT_APP" to "Map report", "WAYPOINT_APP" to "Waypoint", "RANGE_TEST_APP" to "Range test", "STORE_FORWARD_APP" to "Store and forward",
    "PAXCOUNTER_APP" to "People counter", "DETECTION_SENSOR_APP" to "Detection sensor", "ADMIN_APP" to "Admin", "ALERT_APP" to "Alert",
    "T_DECK" to "T-Deck", "TBEAM" to "T-Beam", "T_ECHO" to "T-Echo", "TLORA_V2" to "T-LoRa V2", "HELTEC_V3" to "Heltec V3", "HELTEC_WSL_V3" to "Heltec Wireless Stick Lite V3",
    "STATION_G2" to "Station G2", "TRACKER_T1000_E" to "SenseCAP T1000-E", "MESHTASTIC_NODE" to "Meshtastic node", "MESHCORE_NODE" to "MeshCore node",
)
private val WORD_RE = Regex("\\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\\b|\\b[A-Z]{4,}\\b")
internal fun loraWords(s: String): String = WORD_RE.replace(s) { m ->
    val w = m.value
    LORA_WORDS[w] ?: if (w.any { it.isDigit() } && !w.contains('_')) w
    else w.removeSuffix("_APP").split('_').mapIndexed { i, t -> if (t.any { it.isDigit() }) t else if (i == 0) t[0] + t.substring(1).lowercase() else t.lowercase() }.joinToString(" ")
}

private fun field(n: LoraNode, name: String): String = n.fields.firstOrNull { it.name == name }?.value ?: ""
private fun agoText(ms: Long, now: Long): String { val s = max(0L, (now - ms) / 1000); return if (s < 60) "$s s" else if (s < 3600) "${s / 60} min" else "${s / 3600} h" }
private fun mhz3(hz: Long) = "%.3f".format(java.util.Locale.US, hz / 1e6)
private fun mhz4(hz: Long) = "%.4f".format(java.util.Locale.US, hz / 1e6)

/** The readings that fit a card, short: a label and a value each, the ones people look for first. */
private fun loraStats(n: LoraNode, home: Pair<Double, Double>?): List<Pair<String, String>> {
    val out = ArrayList<Pair<String, String>>()
    val hops = field(n, "HOPS AWAY"); if (hops.isNotEmpty()) out += "HOPS" to if (hops == "0") "direct" else hops
    val bat = field(n, "BATTERY").ifEmpty { field(n, "DEVICE BATTERY") }; val volt = field(n, "VOLTAGE")
    if (bat.isNotEmpty() || volt.isNotEmpty()) out += "BAT" to listOf(bat, volt).filter { it.isNotEmpty() }.joinToString(" · ")
    val la = n.lat; val lo = n.lon
    if (la != null && lo != null) {
        // from you, when your position is known: how far and which way; otherwise where
        out += "POS" to if (home != null) { val (km, deg) = distanceBearing(home.first, home.second, la, lo)
            "${Units.fmtDist(km)} ${listOf("N", "NE", "E", "SE", "S", "SW", "W", "NW")[((deg / 45).roundToInt()) % 8]}" } else "%.4f, %.4f".format(java.util.Locale.US, la, lo)
    }
    for ((k, l) in listOf("CHANNEL USE" to "CH", "AIRTIME TX" to "AIR", "TEMPERATURE" to "TEMP", "HUMIDITY" to "RH", "PRESSURE" to "BARO",
        "NETWORK" to "NET", "FRAME COUNT" to "FCNT", "LINK MARGIN" to "MARGIN", "PORT" to "PORT")) {
        // a sensor the node does not have reports zero: humidity or pressure of nothing is left off
        val v = field(n, k)
        if (v.isNotEmpty() && !((k == "HUMIDITY" || k == "PRESSURE") && abs(v.takeWhile { it.isDigit() || it == '.' || it == '-' }.toDoubleOrNull() ?: 0.0) < 0.05)) out += l to v
    }
    val up = field(n, "UPTIME"); if (up.isNotEmpty()) out += "UP" to up.removePrefix("0d ").split(' ').take(2).joinToString(" ")
    val nb = field(n, "NEIGHBORS"); if (nb.isNotEmpty()) out += "NBRS" to "${nb.count { it == '!' }}"
    if (field(n, "VIA MQTT").isNotEmpty()) out += "VIA" to "MQTT"
    val to = field(n, "LAST SENT TO"); if (to.isNotEmpty()) out += "TO" to to
    return out
}

/**
 * The links between nodes that have positions: neighbors a Meshtastic node reports (solid), the hops of a traceroute
 * and the node a packet was last relayed by (dashed), and the repeaters a MeshCore packet took (dashed). A link only
 * shows when both ends are on the map; a MeshCore hop or a relay is named by one byte, so it is drawn only when one
 * node matches it.
 */
private fun loraLinks(nodes: List<LoraNode>): List<GeoShape> {
    val placed = nodes.filter { it.lat != null && it.lon != null }
    val byKey = placed.associateBy { it.key.lowercase() }
    val out = ArrayList<GeoShape>(); val seen = HashSet<String>()
    fun add(a: LoraNode, b: LoraNode, color: Color, dashed: Boolean) {
        if (a.key == b.key) return
        val k = listOf(a.key, b.key).sorted().joinToString("|") + if (dashed) "~" else ""
        if (!seen.add(k)) return
        out += GeoShape("ln:$k", listOf(a.lat!! to a.lon!!, b.lat!! to b.lon!!), true, color.toArgb(), dashed)
    }
    fun oneByTail(proto: String, tail: String) = placed.filter { it.proto == proto && it.key.lowercase().endsWith(tail) }.singleOrNull()
    fun oneByHead(head: String) = placed.filter { it.proto == "MeshCore" && it.key.lowercase().startsWith("mc/$head") }.singleOrNull()
    val mt = netColor("Meshtastic"); val mc = netColor("MeshCore")
    for (n in placed) {
        if (n.proto == "Meshtastic") {
            for (m in Regex("!([0-9a-f]{8})", RegexOption.IGNORE_CASE).findAll(field(n, "NEIGHBORS"))) byKey["mt/!" + m.groupValues[1].lowercase()]?.let { add(n, it, mt, false) }
            var prev: LoraNode? = null
            for (h in Regex("![0-9a-f]{8}", RegexOption.IGNORE_CASE).findAll(field(n, "ROUTE"))) { val o = byKey["mt/" + h.value.lowercase()]; if (o != null && prev != null) add(prev, o, mt, true); prev = o }
            prev?.let { add(it, n, mt, true) }
            Regex("…([0-9a-f]{2})", RegexOption.IGNORE_CASE).find(field(n, "RELAYED BY"))?.let { r -> oneByTail("Meshtastic", r.groupValues[1].lowercase())?.let { add(it, n, mt, true) } }
        } else if (n.proto == "MeshCore") {
            var prev: LoraNode? = n
            for (h in Regex("[0-9a-f]{2}", RegexOption.IGNORE_CASE).findAll(field(n, "PATH"))) { val o = oneByHead(h.value.lowercase()); if (o != null && prev != null) add(prev, o, mc, true); prev = o }
        }
    }
    return out
}

/** What Mesh keeps in prefs: the view, the network shown, the NODES columns and the channel last sent on. */
private class LoraPrefs(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("mayhem", Context.MODE_PRIVATE)
    fun get(k: String, d: String): String = p.getString(k, d) ?: d
    fun put(k: String, v: String) = p.edit().putString(k, v).apply()
}

/**
 * Mesh: every Meshtastic, MeshCore and LoRaWAN node heard across the span. Network chips filter what is shown, a pill
 * per local channel says which are in the span (a tap moves the span to one), four tiles count what is heard, and the
 * views are MAP (with the node list beside it), NODES (a column per network), CHAT (with the send bar), CHANNELS and
 * the LOG. Everything heard is kept across launches until CLEAR. Twin of the web app's Mesh screen.
 */
@Composable
fun LoraScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val prefs = remember { LoraPrefs(ctx) }
    val phone = d.widthDp < 600
    val rate by SdrEngine.rateHz.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val histNodes by LoraHistory.nodes.collectAsState()
    val histMsgs by LoraHistory.msgs.collectAsState()
    val bursts by Apps.lora.bursts.collectAsState()
    val frames by Apps.lora.frames.collectAsState()
    val logSnap by Apps.loraLog.snapshot.collectAsState()
    val me by LoraMe.me.collectAsState()
    val station by Station.info.collectAsState()
    val fix by Geo.fix.collectAsState()
    val localTick by LoraLocal.version.collectAsState()
    val narrowed by Apps.lora.narrowed.collectAsState()
    val losing by Apps.lora.deliveryNote.collectAsState()
    val needsPrompt by Tx.needsPrompt.collectAsState()
    val txGlobal by Tx.status.collectAsState()
    val home = fix ?: Geo.lastKnownPos()
    // PAUSE holds the cards, the chat and the log still for reading; decoding carries on and RESUME catches up
    var held by remember { mutableStateOf<Triple<List<LoraNode>, List<LoraMsg>, List<String>>?>(null) }
    val all = held?.first ?: histNodes
    val msgsAll = held?.second ?: histMsgs
    val logLines = held?.third ?: logSnap.lines
    var view by remember { mutableStateOf(prefs.get("lora_view", "map").takeIf { it in LORA_VIEWS } ?: "map") }
    fun setView(v: String) { view = v; prefs.put("lora_view", v) }
    var net by remember { mutableStateOf(prefs.get("lora_net", "all").takeIf { it in LORA_NETS } ?: "all") }
    var order by remember { mutableStateOf(prefs.get("lora_cols_order", "").split(',').filter { it in LORA_COLS }.let { o -> o + LORA_COLS.filter { it !in o } }) }
    var hidden by remember { mutableStateOf(prefs.get("lora_cols_hidden", "").split(',').filter { it in LORA_COLS }) }
    fun saveCols() { prefs.put("lora_cols_order", order.joinToString(",")); prefs.put("lora_cols_hidden", hidden.joinToString(",")) }
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var focusKey by remember { mutableIntStateOf(0) }
    var full by remember { mutableStateOf(false) }
    var settingsOpen by remember { mutableStateOf(false) }
    var settingsToNode by remember { mutableStateOf(false) }
    var asking by remember { mutableStateOf<(() -> Unit)?>(null) }
    var geoAsked by remember { mutableStateOf(false) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(250); value = System.currentTimeMillis() } }.value
    val states = remember(now, rate, freq) { Apps.lora.scanner.channelStates() }
    val area = remember(localTick, fix) { LoraLocal.area() }
    val local = remember(localTick, area) { LoraLocal.listening(area) }
    val wanBands = remember(localTick, area) { LoraLocal.lorawanBands(area) }
    // a span stepped down because the radio lost samples is tried wide again once delivery has been clean a while
    LaunchedEffect(Unit) { while (true) { delay(1000); Apps.loraRecover() } }
    val inNet = { proto: String -> net == "all" || proto == net }
    val nodes = all.filter { inNet(it.proto) }
    val newest = nodes.sortedByDescending { it.lastMs }
    val myName = LoraMe.name(me)
    val chat = remember(msgsAll, me, station) { LoraHistory.chat(msgsAll, me.key, myName) }.filter { inNet(it.msg.proto) }
    val mapItems = nodes.mapNotNull { n -> val la = n.lat; val lo = n.lon; if (la != null && lo != null) GeoItem(n.key, la, lo, n.label, GeoItem.Kind.DEVICE, color = netColor(n.proto).toArgb()) else null }
    val picked = all.firstOrNull { it.key == sel }
    val spanHas = { hz: Long, bw: Int -> LoraSend.inSpan(hz, bw, freq, rate) }
    val wf = waterfallOn(MayhemApp.LORA, phoneDefault = true)

    // a position that arrived after USE MY LOCATION: the area (and its regional channels) and the span follow it
    LaunchedEffect(fix != null, geoAsked) {
        if (geoAsked && fix != null) {
            LoraPlan.invalidate(); Apps.lora.scanner.replan()
            if (SdrEngine.savedLong("lora_user_wide") == 0L && rate > 2_400_000) SdrEngine.tune(Apps.loraWideStart(rate))
            geoAsked = false
        }
    }
    val askGeo = { geoAsked = true; Geo.ask(ctx) }

    /** Move the span so it holds this channel, and as many of the area's other channels as fit with it, with no channel
     *  on the spike at the center. Narrow: the channel itself. The span picked is kept: Mesh opens there next time. */
    fun tuneTo(hz: Long) {
        // a local channel, or a LoRaWAN band (held whole, with as many local channels as fit beside it)
        class Ch(val hz: Long, val bw: Int)
        val chans = local.map { Ch(it.hz, it.bw) }.toMutableList()
        val c = chans.firstOrNull { it.hz == hz } ?: wanBands.firstOrNull { it.hz == hz }?.let { Ch(it.hz, it.bw) }?.also { chans += it } ?: return
        if (rate <= 2_400_000) { SdrEngine.saveLong("lora_user_narrow", c.hz); SdrEngine.tune(c.hz + LoraSend.NARROW_SHIFT); return }
        val half = rate * 0.44; val step = 25_000L
        var best = c.hz + rate / 4; var score = -1
        var f = (c.hz - half + c.bw / 2).toLong()
        while (f <= c.hz + half - c.bw / 2) {
            if (chans.none { abs(it.hz - f) < it.bw / 2 + 50_000 }) {
                val n = chans.count { abs(it.hz - f) + it.bw / 2.0 < half }
                if (n > score || (n == score && abs(f - c.hz - rate / 4) < abs(best - c.hz - rate / 4))) { best = f; score = n }
            }
            f += step
        }
        SdrEngine.saveLong("lora_user_wide", best); SdrEngine.tune(best)
    }
    /**
     * The network chips pick what the views show. With one channel at a time (a 2 MHz span), picking Meshtastic or
     * MeshCore also tunes to that network's local channel, since both cannot be heard at once; a wide span none of
     * its channels is in moves onto one, a quarter span off center, clear of the spike there.
     */
    fun setNet(k: String) {
        net = k; prefs.put("lora_net", k)
        val mine = local.filter { it.name.startsWith("$k ") }
        if ((k == "Meshtastic" || k == "MeshCore") && mine.isNotEmpty()) {
            val c = mine[0]
            if (rate <= 2_400_000) {
                if (abs(freq - LoraSend.NARROW_SHIFT - c.hz) > 1000) { SdrEngine.saveLong("lora_user_narrow", c.hz); SdrEngine.tune(c.hz + LoraSend.NARROW_SHIFT) }
            } else if (mine.none { abs(it.hz - freq) + it.bw / 2.0 < rate * 0.44 }) {
                val to = c.hz + rate / 4; SdrEngine.saveLong("lora_user_wide", to); SdrEngine.tune(to)
            }
        } else if (k == "LoRaWAN" && rate > 2_400_000) {
            val b = wanBands.firstOrNull()
            if (b != null && !spanHas(b.hz, b.bw)) tuneTo(b.hz)
        } else if (k == "all" && rate > 2_400_000 && SdrEngine.savedLong("lora_user_wide") == 0L) SdrEngine.tune(Apps.loraWideStart(rate))
    }
    fun clearAll() { Apps.lora.clear(); Apps.loraLog.clear(); LoraHistory.clear(); sel = null; if (held != null) held = Triple(emptyList(), emptyList(), emptyList()) }

    // ---- the send bar's state
    var txText by remember { mutableStateOf(TextFieldValue("")) }
    var txKey by remember { mutableStateOf(prefs.get("lora_txch", "")) }
    var txStatus by remember { mutableStateOf("") }
    var showTx by remember { mutableStateOf(false) }
    val txFocus = remember { FocusRequester() }
    // Meshtastic first, LongFast first among its presets (where most people talk); the last one picked wins after that
    val txChans = remember(local) { LoraSend.channels(area).sortedWith(compareByDescending<LoraSend.Channel> { it.net == "Meshtastic" }.thenByDescending { it.preset == "LongFast" }) }
    val txPick = txChans.firstOrNull { it.key == txKey && spanHas(it.hz, it.bw) } ?: txChans.firstOrNull { spanHas(it.hz, it.bw) }
    fun doSend() {
        showTx = false
        when (val r = LoraSend.send(txText.text, txPick, freq, rate)) {
            is LoraSend.Result.Sent -> { txText = TextFieldValue(""); txStatus = ""; showTx = true }
            is LoraSend.Result.Prompt -> asking = { doSend() }
            is LoraSend.Result.Refused -> txStatus = r.why
        }
    }
    fun doAnnounce() {
        showTx = false
        when (val r = LoraSend.announce(txPick)) {
            is LoraSend.Result.Sent -> { txStatus = ""; showTx = true }
            is LoraSend.Result.Prompt -> asking = { doAnnounce() }
            is LoraSend.Result.Refused -> txStatus = r.why
        }
    }
    asking?.let { again -> if (needsPrompt) SafetyPromptDialog(accent, onCancel = { asking = null }) { Tx.acknowledgeSafety(); asking = null; again() } else asking = null }

    val counts = mapOf("map" to mapItems.size, "nodes" to nodes.size, "messages" to chat.size, "channels" to states.count { it.standing || it.active })

    @Composable
    fun tabs(modifier: Modifier = Modifier) {
        val labels = LORA_VIEWS.map { v -> when (v) { "map" -> "MAP ${counts["map"]}"; "nodes" -> "NODES ${counts["nodes"]}"; "messages" -> "CHAT ${counts["messages"]}"; "channels" -> "CHANNELS ${counts["channels"]}"; else -> "LOG" } }
        if (!phone) SegBar(labels, LORA_VIEWS.indexOf(view), accent, modifier.fillMaxWidth()) { setView(LORA_VIEWS[it]); if (LORA_VIEWS[it] == "map") focusKey++ }
        else Row(modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            labels.forEachIndexed { i, l -> ToggleBox(l, view == LORA_VIEWS[i], accent) { setView(LORA_VIEWS[i]) } }
        }
    }

    @Composable
    fun composeBar() {
        val (used, maxB) = LoraSend.limit(txText.text, txPick)
        var chOpen by remember { mutableStateOf(false) }
        var emoOpen by remember { mutableStateOf(false) }
        val shape = RoundedCornerShape(d.dp(10f))
        @Composable fun asChip() = LoraChip("AS ${me.short} ✎", false, accent) { settingsToNode = true; settingsOpen = true }
        @Composable fun picker(m: Modifier) = Box(m) {
            Text((txPick?.label ?: if (txChans.isEmpty()) "no channel to send on here" else "no channel of yours in the span") + "  ▾",
                color = if (txPick != null) Palette.ink else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f),
                modifier = Modifier.fillMaxWidth().clip(shape).border(1.dp, accent.copy(alpha = 0.6f), shape).clickable { chOpen = true }.padding(horizontal = d.dp(10f), vertical = d.dp(9f)))
            DropdownMenu(chOpen, onDismissRequest = { chOpen = false }, modifier = Modifier.background(Palette.surface)) {
                for (c in txChans) {
                    val on = spanHas(c.hz, c.bw)
                    DropdownMenuItem(enabled = on, text = {
                        Text((if (c == txPick) "✓ " else "") + c.label + if (on) "" else " · outside the span", color = if (!on) Palette.muted else if (c == txPick) accent else Palette.ink,
                            fontFamily = Mono, fontSize = d.sp(12f))
                    }, onClick = { chOpen = false; txKey = c.key; prefs.put("lora_txch", c.key) })
                }
            }
        }
        @Composable fun box(m: Modifier) = Box(m) {
            OutlinedTextField(txText, { txText = it }, singleLine = false, maxLines = 4,
                placeholder = { Text("Message to the mesh", fontFamily = Mono, color = Palette.muted, fontSize = d.sp(12f)) },
                textStyle = TextStyle(fontFamily = Mono, color = Palette.ink, fontSize = d.sp(13f)),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { doSend() }),
                trailingIcon = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (used > 0) Text("$used/$maxB", color = if (used > maxB) Palette.danger else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), fontWeight = FontWeight.Bold)
                        Box(Modifier.clip(CircleShape).clickable { emoOpen = !emoOpen }.padding(d.dp(8f))) {
                            Icon(SmileIcon, "Emoji", tint = if (emoOpen) accent else Palette.muted, modifier = Modifier.size(d.dp(20f)))
                        }
                    }
                },
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = accent, unfocusedBorderColor = accent.copy(alpha = 0.6f), cursorColor = accent),
                modifier = Modifier.fillMaxWidth().focusRequester(txFocus))
            DropdownMenu(emoOpen, onDismissRequest = { emoOpen = false }, modifier = Modifier.background(Palette.surface)) {
                // a tap puts one where the cursor is; the count says how much of the packet is left (an emoji is 4 bytes)
                for (row in LoraSend.EMOJI.chunked(8)) Row {
                    for (e in row) Text(e, fontSize = d.sp(20f), modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable {
                        val t = txText.text; val a = txText.selection.min; val z = txText.selection.max
                        txText = TextFieldValue(t.substring(0, a) + e + t.substring(z), TextRange(a + e.length))
                    }.padding(d.dp(6f)))
                }
            }
        }
        @Composable fun sendBtn(m: Modifier = Modifier) = Box(m.alpha(if (txPick != null) 1f else 0.4f).clip(shape).background(accent).clickable(enabled = txPick != null) { doSend() }
            .padding(horizontal = d.dp(16f), vertical = d.dp(11f)), contentAlignment = Alignment.Center) {
            Text("SEND", color = inkOn(accent), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 1.5.sp)
        }
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            if (phone) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) { asChip(); picker(Modifier.weight(1f)) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) { box(Modifier.weight(1f)); sendBtn() }
            } else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                asChip(); picker(Modifier.width(d.dp(240f))); box(Modifier.weight(1f)); sendBtn()
            }
            val st = txStatus.ifEmpty { if (showTx) txGlobal else "" }
            if (st.isNotEmpty()) Text(st, color = if (txStatus.isNotEmpty()) Palette.danger else Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(14f))
        }
    }

    @Composable
    fun stage(modifier: Modifier, big: Boolean) {
        var panelRect by remember { mutableStateOf<Rect?>(null) }
        val slop = LocalViewConfiguration.current.touchSlop
        // a tap anywhere but on the detail puts it away (a tap on another node opens that one)
        Box(modifier.pointerInput(picked != null) {
            if (picked == null) return@pointerInput
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                val r = panelRect
                if (r == null || r.contains(down.position)) return@awaitEachGesture
                val up = waitForUpOrCancellation(PointerEventPass.Initial)
                if (up != null && (up.position - down.position).getDistance() < slop) sel = null
            }
        }) {
            when (view) {
                "map" -> LoraMapView(mapItems, nodes, newest, accent, home, sel, focusKey, picked, now, me.key, phone, onPick = { k -> sel = k; focusKey++ }) { k -> sel = if (sel == k) null else k }
                "nodes" -> LoraNodesView(nodes, newest, states, net, order, hidden, accent, now, sel, home, phone, big, waiting = { LoraWaiting(states, net, bursts, frames, accent) },
                    onPick = { k -> sel = if (sel == k) null else k },
                    onMove = { k, dir ->
                        val shown = order.filter { it !in hidden && (nodes.any { n -> n.proto == it } || states.any { s -> s.name.startsWith("$it ") }) }
                        val other = shown.getOrNull(shown.indexOf(k) + dir)
                        if (other != null) { order = order.map { if (it == k) other else if (it == other) k else it }; saveCols() }
                    },
                    onHide = { k -> hidden = hidden + k; saveCols() }, onShow = { k -> hidden = hidden - k; saveCols() })
                "messages" -> LoraChatView(chat, accent, now) { k -> if (all.any { it.key == k }) sel = k }
                "channels" -> LoraChannelsTab(states, all, now, phone)
                else -> LogList(logLines, Modifier.fillMaxSize(), empty = "listening for LoRa frames…", total = if (held == null) logSnap.total else null, accent = accent)
            }
            if (picked != null) {
                var dx by remember(picked.key) { mutableFloatStateOf(0f) }; var dy by remember(picked.key) { mutableFloatStateOf(0f) }
                LoraDetail(picked, accent, home,
                    Modifier.align(if (phone) Alignment.BottomCenter else Alignment.TopEnd).offset { IntOffset(dx.roundToInt(), dy.roundToInt()) }
                        .then(if (phone) Modifier.fillMaxWidth() else Modifier.widthIn(max = d.dp(420f)).fillMaxWidth(0.5f))
                        .padding(d.dp(6f)).onGloballyPositioned { panelRect = it.boundsInParent() },
                    onDrag = { x, y -> dx += x; dy += y },
                    onMap = if (mapItems.any { it.id == picked.key }) ({ setView("map"); focusKey++ }) else null,
                    onCards = if (view != "nodes") ({ setView("nodes") }) else null) { sel = null }
            }
        }
    }

    // the waterfall's labels: the channels being listened to (always-on higher than ones opened for a burst)
    val marks = if (rate > 0) states.filter { it.standing || it.active }.map { x ->
        Triple((0.5 + (x.hz - freq).toDouble() / rate).toFloat(), if (x.standing) 0.94f else 0.72f, "${x.name.removePrefix("Meshtastic ").removePrefix("LoRaWAN ")} ${mhz3(x.hz)}")
    } else null

    PacketFrame(accent, Apps.loraLog, tag = "MESH", title = "MESH RADIO TEXT", roomy = true, waterfall = wf, marks = marks, slimWaterfall = 88f,
        onWaterfall = { Apps.setWaterfall(MayhemApp.LORA, !wf) }, controls = {
        // A. the network chips, PAUSE, CLEAR, SEND, the cog and full screen; on a phone the chips get a row of their own
        val chips: @Composable () -> Unit = {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
                for (k in LORA_NETS) {
                    val count = if (k == "all") all.size else all.count { it.proto == k }
                    LoraNetChip(if (k == "all") "ALL" else k.uppercase(), count, if (k == "all") null else netColor(k), net == k, accent) { setNet(if (k != "all" && net == k) "all" else k) }
                }
            }
        }
        val buttons: @Composable () -> Unit = {
            Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
                PauseClear(held != null, accent, onPause = { held = if (held == null) Triple(histNodes, histMsgs, logSnap.lines) else null }) { clearAll() }
                IconBox(SendIcon, "Send a message from your own node", Modifier.fillMaxHeight()) { setView("messages"); runCatching { txFocus.requestFocus() } }
                IconBox(GearIcon, "Listening settings", Modifier.fillMaxHeight()) { settingsToNode = false; settingsOpen = true }
                IconBox(FullscreenIcon, "Full screen", Modifier.fillMaxHeight()) { full = true }
            }
        }
        if (phone) { chips(); Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { buttons() } }
        else Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Box(Modifier.weight(1f)) { chips() }; buttons()
        }
        // B. a pill per local channel, by frequency: solid in the span, dashed outside it (a tap moves the span there)
        val netOf = { name: String -> if (name.startsWith("Meshtastic ")) "Meshtastic" else if (name.startsWith("MeshCore ")) "MeshCore" else null }
        val shownCh = local.filter { net == "all" || netOf(it.name) == net || (net != "LoRaWAN" && netOf(it.name) == null) }.sortedBy { it.hz }
        val wan = states.count { it.name.startsWith("LoRaWAN ") }
        val wanPill = (net == "all" || net == "LoRaWAN") && wan > 0
        val bandsShown = if (net == "all" || net == "LoRaWAN") wanBands else emptyList()
        if (shownCh.isNotEmpty() || wanPill || bandsShown.isNotEmpty()) {
            val pills: @Composable () -> Unit = {
                for (c in shownCh) {
                    val on = spanHas(c.hz, c.bw)
                    val label = c.name.removePrefix("Meshtastic ").removePrefix("MeshCore ").replace(Regex("^[A-Z][A-Za-z]+ - "), "")
                    LoraChannelPill(label, mhz3(c.hz), netOf(c.name)?.let { netColor(it) } ?: accent, on) { if (!on) tuneTo(c.hz) }
                }
                for (b in bandsShown) {
                    val on = spanHas(b.hz, b.bw)
                    LoraChannelPill(b.name, "%.1f–%.1f".format(java.util.Locale.US, b.lo / 1e6 + 0.0625, b.hi / 1e6 - 0.0625), netColor("LoRaWAN"), on) { if (!on) tuneTo(b.hz) }
                }
                if (wanPill) LoraChannelPill("LoRaWAN", "$wan ch", netColor("LoRaWAN"), true) {}
            }
            if (phone) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) { pills() }
            else FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) { pills() }
            val out = shownCh.count { !spanHas(it.hz, it.bw) } + bandsShown.count { !spanHas(it.hz, it.bw) }
            val regional = shownCh.any { c -> LoraLocal.MESHCORE.any { it.area.contains('-') && "MeshCore ${it.title}" == c.name } }
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
                Text("● listening  ○ outside the span${if (out > 0) ", tap one to move there" else ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f))
                if (home == null && regional) {
                    Text("· not sure which are yours?", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f))
                    Text("USE MY LOCATION", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f), modifier = Modifier.clickable { askGeo() })
                }
            }
        }
        // C. four numbers: nodes, messages, how busy the mesh says its channel is, and the farthest node
        LoraTiles(nodes, chat, net, home, now, phone, accent, askGeo)
        if (settingsOpen) LoraSettings(accent, rate, freq, area, states, settingsToNode, { doAnnounce() }, txStatus) { settingsOpen = false }
    }, body = {
        Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            tabs()
            stage(Modifier.fillMaxWidth().weight(1f), big = false)
            if (view == "messages") composeBar()
            LoraFooter(states, all, rate, freq, bursts, frames, narrowed, losing, now, accent) { setView("channels") }
        }
    })
    if (full) FullscreenPanel("MESH · ${when (view) { "map" -> "MAP"; "nodes" -> "${nodes.size} NODES"; "messages" -> "CHAT"; "channels" -> "CHANNELS"; else -> "LOG" }}", accent, onClose = { full = false }) {
        tabs(Modifier.padding(bottom = d.dp(8f)))
        stage(Modifier.fillMaxWidth().weight(1f), big = true)
        if (view == "messages") Box(Modifier.padding(top = d.dp(8f))) { composeBar() }
    }
}

/** A network chip: its color's dot, its name and how many nodes of it were heard. */
@Composable
private fun LoraNetChip(label: String, count: Int, c: Color?, on: Boolean, accent: Color, onClick: () -> Unit) {
    val d = rememberDims()
    val tint = c ?: accent
    val shape = RoundedCornerShape(d.dp(12f))
    Row(Modifier.clip(shape).background(if (on) tint.copy(alpha = 0.22f) else Palette.surface).border(1.dp, if (on) tint else Palette.line, shape)
        .clickable { onClick() }.padding(horizontal = d.dp(10f), vertical = d.dp(8f)), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        if (c != null) Box(Modifier.size(d.dp(8f)).background(c, CircleShape))
        Text(label, color = if (on) Palette.ink else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, softWrap = false)
        Text("$count", color = if (on) tint else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), softWrap = false)
    }
}

/** A small outlined chip (AS …, a column's buttons). */
@Composable
private fun LoraChip(label: String, on: Boolean, accent: Color, enabled: Boolean = true, onClick: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(8f))
    Text(label, color = if (!enabled) Palette.muted.copy(alpha = 0.5f) else if (on) Palette.ink else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f),
        softWrap = false, modifier = Modifier.clip(shape).background(if (on) accent.copy(alpha = 0.22f) else Palette.surface)
            .border(1.dp, if (on) accent else accent.copy(alpha = if (enabled) 0.5f else 0.2f), shape).clickable(enabled = enabled) { onClick() }
            .padding(horizontal = d.dp(10f), vertical = d.dp(8f)))
}

/** One local channel: solid and tinted while the span holds it, dashed outside it. */
@Composable
private fun LoraChannelPill(label: String, value: String, c: Color, on: Boolean, onClick: () -> Unit) {
    val d = rememberDims()
    val r = d.dp(12f)
    Row(Modifier.drawBehind {
            val cr = CornerRadius(r.toPx())
            if (on) { drawRoundRect(c.copy(alpha = 0.18f), cornerRadius = cr); drawRoundRect(c.copy(alpha = 0.85f), cornerRadius = cr, style = Stroke(1.dp.toPx())) }
            else drawRoundRect(c.copy(alpha = 0.7f), cornerRadius = cr, style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(5.dp.toPx(), 4.dp.toPx()))))
        }.clip(RoundedCornerShape(r)).clickable { onClick() }.padding(horizontal = d.dp(10f), vertical = d.dp(6f)),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Box(Modifier.size(d.dp(7f)).then(if (on) Modifier.background(c, CircleShape) else Modifier.border(1.dp, c, CircleShape)))
        Text(label, color = if (on) Palette.ink else Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f), softWrap = false)
        Text(value, color = if (on) Palette.ink else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10.5f), softWrap = false)
    }
}

/** The four numbers on top: nodes, messages, how busy the mesh says its channel is, and the farthest node. */
@Composable
private fun LoraTiles(nodes: List<LoraNode>, chat: List<LoraChatRow>, net: String, home: Pair<Double, Double>?, now: Long, phone: Boolean, accent: Color, askGeo: () -> Unit) {
    val d = rememberDims()
    val mesh = nodes.count { it.proto == "Meshtastic" || it.proto == "MeshCore" }; val lw = nodes.count { it.proto == "LoRaWAN" }
    val placed = nodes.count { it.lat != null }
    val nodeSub = if (net == "all") "$mesh mesh · $lw device${if (lw == 1) "" else "s"}" else "$placed on the map"
    val msgSub = chat.firstOrNull()?.let { "last ${agoText(it.msg.ms, now)} ago" } ?: "none yet"
    // channel use as the Meshtastic nodes heard in the last half hour report it
    val use = nodes.filter { it.proto == "Meshtastic" && now - it.lastMs < 1_800_000 }.mapNotNull { field(it, "CHANNEL USE").removeSuffix("%").toDoubleOrNull() }
    val busy = if (use.isNotEmpty()) "${use.average().roundToInt()}%" else "-"
    var far = "-"; var farSub = if (home != null) "no positions yet" else ""
    if (home != null) {
        var best: LoraNode? = null; var km = -1.0
        for (n in nodes) { val la = n.lat; val lo = n.lon; if (la != null && lo != null) { val k = distanceBearing(home.first, home.second, la, lo).first; if (k > km) { km = k; best = n } } }
        best?.let { far = Units.fmtDist(km); farSub = it.label }
    }
    @Composable fun tile(label: String, big: String, sub: String, m: Modifier, extra: (@Composable () -> Unit)? = null) {
        val shape = RoundedCornerShape(d.dp(10f))
        Column(m.clip(shape).background(Palette.surface).border(1.dp, Palette.line, shape).padding(horizontal = d.dp(10f), vertical = d.dp(7f))) {
            Text(label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.5.sp)
            Text(big, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f))
            if (sub.isNotEmpty()) Text(sub, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), lineHeight = d.sp(12f))
            extra?.invoke()
        }
    }
    val t: List<@Composable (Modifier) -> Unit> = listOf(
        { m -> tile("NODES", "${nodes.size}", nodeSub, m) },
        { m -> tile("MESSAGES", "${chat.size}", msgSub, m) },
        { m -> tile("MESH BUSY", busy, if (use.isNotEmpty()) "channel use · ${use.size} node${if (use.size == 1) "" else "s"}" else "no reports yet", m) },
        { m -> tile("FARTHEST", far, farSub, m, if (home == null) ({ Text("USE MY LOCATION", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f), modifier = Modifier.clickable { askGeo() }.padding(top = d.dp(2f))) }) else null) },
    )
    if (phone) Column(verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        for (pair in t.chunked(2)) Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) { for (f in pair) f(Modifier.weight(1f).fillMaxHeight()) }
    } else Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) { for (f in t) f(Modifier.weight(1f).fillMaxHeight()) }
}

/** While nothing is heard yet: what is being listened to right now, what the scanner is catching, and where to look. */
@Composable
private fun LoraWaiting(states: List<LoraScanner.ChannelState>, net: String, bursts: Int, frames: Int, accent: Color) {
    val d = rememberDims()
    val always = states.filter { it.standing }
    Column(Modifier.fillMaxSize().panel().verticalScroll(rememberScrollState()).padding(d.dp(14f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        Text("LISTENING FOR ${if (net == "all") "" else "${net.uppercase()} "}NODES", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 1.5.sp)
        val p = TextStyle(fontFamily = Mono, color = Palette.muted, fontSize = d.sp(11f), lineHeight = d.sp(16f))
        Text(if (always.isNotEmpty()) "On ${always.size} channel${if (always.size == 1) "" else "s"} all the time: " + always.joinToString(" · ") { "${it.name.removePrefix("Meshtastic ").removePrefix("LoRaWAN ")} ${mhz3(it.hz)}" }
            else "No channel of this area is in the span: the cog changes the area or the band.", style = p)
        Text("$bursts LoRa bursts caught, $frames frames decoded so far.", style = p)
        Text("Nodes appear as they speak: Meshtastic beacons its name and position about every 15 minutes, MeshCore when it adverts, LoRaWAN devices with each uplink. CHANNELS shows every channel watched; the cog sets the area, band and span.", style = p)
    }
}

/** MAP: the nodes with positions (in their network's color, with the links between them), and the list of every node beside it. */
@Composable
private fun LoraMapView(items: List<GeoItem>, nodes: List<LoraNode>, newest: List<LoraNode>, accent: Color, home: Pair<Double, Double>?, sel: String?, focusKey: Int,
                        picked: LoraNode?, now: Long, myKey: String, phone: Boolean, onPick: (String) -> Unit, onRow: (String) -> Unit) {
    val d = rememberDims()
    val pla = picked?.lat; val plo = picked?.lon
    val focus = if (pla != null && plo != null) pla to plo else null
    val links = remember(nodes) { loraLinks(nodes) }
    val map: @Composable (Modifier) -> Unit = { m ->
        Box(m) {
            GeoMapView(items, accent, Modifier.fillMaxSize().panel(), home = home, selected = sel, layers = GeoLayers(shapes = links),
                start = remember { mapStart(home) }, focus = focus, focusKey = focusKey, fitPins = true) { onPick(it) }
            if (items.isEmpty()) Text("no positions yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.align(Alignment.BottomStart).padding(d.dp(10f)))
        }
    }
    val list: @Composable (Modifier) -> Unit = { m ->
        LazyColumn(m.panel(), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            items(newest, key = { it.key }) { n -> LoraRow(n, now, sel == n.key, n.key == myKey) { onRow(n.key); onPick(n.key) } }
        }
    }
    if (phone) Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) { map(Modifier.fillMaxWidth().weight(0.6f)); if (newest.isNotEmpty()) list(Modifier.fillMaxWidth().weight(0.4f)) }
    else Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) { map(Modifier.weight(0.62f).fillMaxHeight()); if (newest.isNotEmpty()) list(Modifier.weight(0.38f).fillMaxHeight()) }
}

/** One node in the list beside the map: who, what it is, how far, its battery, its last signal, how long ago. */
@Composable
private fun LoraRow(n: LoraNode, now: Long, selected: Boolean, mine: Boolean, onClick: () -> Unit) {
    val d = rememberDims()
    val live = now - n.lastMs < 600_000
    val v = n.snr.lastOrNull()
    val hops = field(n, "HOPS AWAY"); val batt = field(n, "BATTERY")
    val kind = if (Regex("^(MESHTASTIC|MESHCORE) NODE$").matches(n.kind)) "" else loraWords(n.kind)
    val what = if (n.proto == "LoRaWAN") listOf(field(n, "NETWORK"), field(n, "FRAME COUNT").let { if (it.isNotEmpty()) "frame $it" else "" })
        else listOf(kind, if (hops.isEmpty()) "" else if (hops == "0") "direct" else "$hops hop${if (hops == "1") "" else "s"}", batt)
    Row(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.6f).background(if (selected) netColor(n.proto).copy(alpha = 0.16f) else Color.Transparent).clickable { onClick() }
        .padding(horizontal = d.dp(8f), vertical = d.dp(6f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        Box(Modifier.size(d.dp(8f)).background(netColor(n.proto), CircleShape))
        Column(Modifier.weight(1f)) {
            Text(buildAnnotatedString {
                withStyle(SpanStyle(color = Palette.ink, fontWeight = FontWeight.Bold)) { append(n.label) }
                if (mine) withStyle(SpanStyle(color = Palette.ok, fontWeight = FontWeight.Bold)) { append(" YOU") }
                val nm = n.name; if (nm != null && nm != n.label) withStyle(SpanStyle(color = Palette.muted)) { append(" $nm") }
            }, fontFamily = Mono, fontSize = d.sp(11.5f))
            Text(what.filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { n.proto }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f))
        }
        Column(horizontalAlignment = Alignment.End) {
            if (v != null) Text("${if (v >= 0) "+" else ""}$v dB", color = snrColor(v), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), softWrap = false)
            Text((if (n.lat != null) "◉ " else "") + agoText(n.lastMs, now), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), softWrap = false)
        }
    }
}

private fun snrColor(v: Int): Color = if (v >= 0) Palette.ok else if (v >= -10) Palette.ink else Color(0xFFF2A93B)

/** NODES: in ALL a column per network the area has (equal widths, movable, hideable); one network, a grid of cards. */
@Composable
private fun LoraNodesView(nodes: List<LoraNode>, newest: List<LoraNode>, states: List<LoraScanner.ChannelState>, net: String, order: List<String>, hidden: List<String>,
                          accent: Color, now: Long, sel: String?, home: Pair<Double, Double>?, phone: Boolean, big: Boolean, waiting: @Composable () -> Unit,
                          onPick: (String) -> Unit, onMove: (String, Int) -> Unit, onHide: (String) -> Unit, onShow: (String) -> Unit) {
    val d = rememberDims()
    if (nodes.isEmpty()) { waiting(); return }
    val have = { k: String -> nodes.any { it.proto == k } || states.any { it.name.startsWith("$k ") } }
    val all3 = order.filter(have)
    val cols = if (net == "all") all3.filter { it !in hidden } else emptyList()
    val hiddenCols = if (net == "all") all3.filter { it in hidden } else emptyList()
    if (cols.size <= 1 && hiddenCols.isEmpty()) {
        val grid = rememberLazyGridState()
        val follow = rememberFollowNewest(grid, newest.first().lastMs)
        Box(Modifier.fillMaxSize()) {
            LazyVerticalGrid(GridCells.Adaptive(d.dp(if (big) 300f else 260f)), Modifier.fillMaxSize(), state = grid,
                horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                items(newest, key = { it.key }) { n -> LoraNodeCard(n, now, sel == n.key, home) { onPick(n.key) } }
            }
            NewestPill(follow, grid, newest.count { it.lastMs > follow.seen }, accent, Modifier.align(Alignment.TopCenter))
        }
        return
    }
    @Composable fun header(k: String, at: Int, count: Int) {
        val c = netColor(k)
        Row(Modifier.fillMaxWidth().padding(vertical = d.dp(4f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Box(Modifier.size(d.dp(8f)).background(c, CircleShape))
            Text(buildAnnotatedString { append(k.uppercase()); withStyle(SpanStyle(color = c)) { append(" $count") } }, color = Palette.ink, fontFamily = Mono,
                fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, modifier = Modifier.weight(1f))
            LoraChip("‹", false, c, enabled = at > 0) { onMove(k, -1) }
            LoraChip("›", false, c, enabled = at < cols.size - 1) { onMove(k, 1) }
            LoraChip("✕", false, c) { onHide(k) }
        }
    }
    @Composable fun restore() {
        if (hiddenCols.isEmpty()) return
        FlowRow(Modifier.fillMaxWidth().padding(bottom = d.dp(4f)), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            Text("HIDDEN", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), letterSpacing = 1.5.sp, modifier = Modifier.align(Alignment.CenterVertically))
            for (k in hiddenCols) LoraChannelPill(k.uppercase(), "+", netColor(k), false) { onShow(k) }
        }
    }
    @Composable fun empty(k: String) = Text("No $k nodes heard yet.", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f), modifier = Modifier.padding(d.dp(8f)))
    if (phone) {
        // a phone stacks the columns: each network's header, then its cards
        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            item { restore() }
            cols.forEachIndexed { at, k ->
                val mine = newest.filter { it.proto == k }
                item(key = "h/$k") { header(k, at, mine.size) }
                if (mine.isEmpty()) item(key = "e/$k") { empty(k) }
                items(mine, key = { it.key }) { n -> LoraNodeCard(n, now, sel == n.key, home) { onPick(n.key) } }
            }
        }
    } else Column(Modifier.fillMaxSize()) {
        restore()
        Row(Modifier.fillMaxWidth().weight(1f), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            cols.forEachIndexed { at, k ->
                val mine = newest.filter { it.proto == k }
                Column(Modifier.weight(1f).fillMaxHeight()) {
                    header(k, at, mine.size)
                    LazyColumn(Modifier.fillMaxWidth().weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        if (mine.isEmpty()) item { empty(k) }
                        items(mine, key = { it.key }) { n -> LoraNodeCard(n, now, sel == n.key, home) { onPick(n.key) } }
                    }
                }
            }
        }
    }
}

/**
 * One node, live, in a few lines: who and what it is, its readings, what it last sent, its signal over the recent
 * packets. Kept short so a column holds many; nothing is cut off, every line wraps.
 */
@Composable
private fun LoraNodeCard(n: LoraNode, now: Long, selected: Boolean, home: Pair<Double, Double>?, onClick: () -> Unit) {
    val d = rememberDims()
    val age = (now - n.lastMs) / 1000.0
    val flash = max(0.0, 1 - age / 0.9).toFloat()
    // nodes speak every few minutes: lit for ten, and once heard a node stays on the board
    val live = age < 600
    val c = netColor(n.proto)
    val shape = RoundedCornerShape(d.dp(10f))
    val v = n.snr.lastOrNull()
    val kind = loraWords(n.kind); val role = field(n, "ROLE")
    val tag = (kind.split(" · ") + (if (role.isNotEmpty()) loraWords(role) else "")).distinct().filter { it.isNotEmpty() && !it.endsWith(" node", ignoreCase = true) }.joinToString(" · ")
    val stats = loraStats(n, home)
    val nm = n.name
    // a label that is only the start of the name (MeshCore's first ten letters) gives way to the whole name
    val whole = nm != null && nm.startsWith(n.label)
    Column(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.72f).clip(shape)
        .background(Brush.horizontalGradient(listOf(c.copy(alpha = 0.10f + 0.18f * flash), Palette.panel)))
        .border(if (selected) 2.dp else 1.dp, if (selected) c else c.copy(alpha = 0.22f + 0.6f * flash), shape)
        .drawBehind { drawRect(c, size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height)) }
        .clickable { onClick() }.padding(start = d.dp(11f), end = d.dp(9f), top = d.dp(7f), bottom = d.dp(7f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Text(buildAnnotatedString {
                withStyle(SpanStyle(color = c, fontWeight = FontWeight.Bold)) { append(if (whole) nm!! else n.label) }
                if (nm != null && !whole) withStyle(SpanStyle(color = Palette.ink)) { append("  $nm") }
            }, fontFamily = Mono, fontSize = d.sp(12.5f), modifier = Modifier.weight(1f))
            if (v != null) Text(buildAnnotatedString { append("${if (v >= 0) "+" else ""}$v"); withStyle(SpanStyle(fontSize = d.sp(8.5f))) { append("dB") } },
                color = snrColor(v), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), softWrap = false)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                Box(Modifier.padding(top = d.dp(1f)).size(d.dp(7f) * (1 + 0.5f * flash)).background(if (live) Palette.ok else Palette.muted, CircleShape))
                Text(agoText(n.lastMs, now), color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9.5f), softWrap = false)
            }
        }
        if (tag.isNotEmpty()) Text(tag, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(13f))
        if (stats.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(1f))) {
            for ((k, x) in stats) Text(buildAnnotatedString {
                withStyle(SpanStyle(color = Palette.muted, fontSize = d.sp(8.5f))) { append("$k ") }
                withStyle(SpanStyle(color = Palette.ink)) { append(x) }
            }, fontFamily = Mono, fontSize = d.sp(10f))
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Text(loraWords(n.last), color = Palette.ink.copy(alpha = 0.85f), fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(13f), modifier = Modifier.align(Alignment.CenterVertically))
            if (n.snr.size >= 2) LoraSpark(n.snr, c, Modifier.align(Alignment.CenterVertically).width(d.dp(46f)).height(d.dp(14f)))
            Text("${mhz3(n.hz)} · ${n.modem.substringBefore(" · CR").replaceFirst(" · ", "/").replace(" kHz", "k")} · ${n.packets}×", color = Palette.muted,
                fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.align(Alignment.CenterVertically))
        }
    }
}

/** Signal of the recent packets, as a tiny filled line. */
@Composable
private fun LoraSpark(v: List<Int>, c: Color, modifier: Modifier) {
    Canvas(modifier) {
        val lo = (v.min() - 2).toDouble(); val hi = (v.max() + 2).toDouble()
        val w = size.width; val h = size.height
        val pts = v.mapIndexed { i, s -> Offset(w * i / (v.size - 1), h - h * ((s - lo) / max(hi - lo, 1.0)).toFloat()) }
        val line = Path().apply { moveTo(pts[0].x, pts[0].y); for (p in pts.drop(1)) lineTo(p.x, p.y) }
        val fill = Path().apply { addPath(line); lineTo(w, h); lineTo(0f, h); close() }
        drawPath(fill, c.copy(alpha = 0.25f))
        drawPath(line, c, style = Stroke(1.2.dp.toPx()))
    }
}

/** CHAT: newest first, line breaks kept, MeshCore's "name: " left off the body, your own with whether it was relayed. */
@Composable
private fun LoraChatView(rows: List<LoraChatRow>, accent: Color, now: Long, onPick: (String) -> Unit) {
    val d = rememberDims()
    if (rows.isEmpty()) { EmptyState("loramsg", Modifier.fillMaxSize().panel(), accent); return }
    val list = rememberLazyListState()
    val follow = rememberFollowNewest(list, rows.first().msg.ms)
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), state = list, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            items(rows, key = { it.msg.id }) { r -> LoraMessageRow(r, accent) { r.msg.nodeKey?.let(onPick) } }
        }
        NewestPill(follow, list, rows.count { it.msg.ms > follow.seen }, accent, Modifier.align(Alignment.TopCenter))
    }
}

@Composable
private fun LoraMessageRow(r: LoraChatRow, accent: Color, onClick: () -> Unit) {
    val d = rememberDims()
    val e = r.msg
    val mine = e.id < 0
    val c = netColor(e.proto)
    val shape = RoundedCornerShape(d.dp(10f))
    val from = e.from; val text = e.text ?: ""
    val body = if (e.proto == "MeshCore" && from != null && text.startsWith("$from: ")) text.substring(from.length + 2) else text
    Column(Modifier.fillMaxWidth().clip(shape).background(if (mine) accent.copy(alpha = 0.10f) else Palette.panel).border(1.dp, (if (mine) accent else c).copy(alpha = 0.35f), shape)
        .clickable { onClick() }.padding(d.dp(9f)), verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            Text(from ?: "?", color = if (mine) accent else c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f))
            Text(e.proto.uppercase() + (e.channel?.let { " · $it" } ?: ""), color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f),
                letterSpacing = 1.sp, modifier = Modifier.align(Alignment.CenterVertically))
            if (mine) Text(if (r.relayed > 0) "✓ RELAYED${if (r.relayed > 1) " ×${r.relayed}" else ""} · ${r.relayAfter} s" else "SENT · not heard back yet",
                color = if (r.relayed > 0) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), modifier = Modifier.align(Alignment.CenterVertically))
            Text(LoraHub.clock(e.ms), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.align(Alignment.CenterVertically))
        }
        SelectionContainer { Text(body, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(12.5f), lineHeight = d.sp(17f)) }
    }
}

/**
 * CHANNELS: every known channel in the span, busiest first, with where it is, its modem, whether it is listened to all
 * the time or was opened for a burst, how many frames it gave, and when something was last decoded there.
 */
@Composable
private fun LoraChannelsTab(list: List<LoraScanner.ChannelState>, nodes: List<LoraNode>, now: Long, phone: Boolean) {
    val d = rememberDims()
    if (list.isEmpty()) { Text("No known channels in this span. The cog changes the area, band or span.", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.fillMaxSize().panel().padding(d.dp(14f))); return }
    val lastFrame = { c: LoraScanner.ChannelState -> nodes.filter { abs(it.hz - c.hz) <= c.bw / 4 }.maxOfOrNull { it.lastMs } ?: 0L }
    val rows = list.sortedWith(compareByDescending<LoraScanner.ChannelState> { lastFrame(it) }.thenByDescending { it.frames }.thenByDescending { it.standing }.thenByDescending { it.opens }.thenBy { it.hz })
    fun listening(c: LoraScanner.ChannelState) = if (c.standing) "ALWAYS" else if (c.opens > 0) "OPENED ${c.opens}× · ${agoText(now - (c.openAgoMs ?: 0L), now)}" else "ON A BURST"
    fun modem(c: LoraScanner.ChannelState) = (c.sf?.let { "SF$it · " } ?: "") + LoraHub.bwName(c.bw)
    val head = TextStyle(fontFamily = Mono, color = Palette.muted, fontSize = d.sp(9f), letterSpacing = 1.sp)
    val cell = TextStyle(fontFamily = Mono, color = Palette.ink, fontSize = d.sp(10.5f))
    LazyColumn(Modifier.fillMaxSize().panel().padding(horizontal = d.dp(8f), vertical = d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
        if (!phone) item {
            Row(Modifier.fillMaxWidth().padding(vertical = d.dp(4f)), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Spacer(Modifier.width(d.dp(8f)))
                Text("CHANNEL", style = head, modifier = Modifier.weight(2.2f)); Text("MHz", style = head, modifier = Modifier.weight(1f))
                Text("MODEM", style = head, modifier = Modifier.weight(1.2f)); Text("LISTENING", style = head, modifier = Modifier.weight(1.6f))
                Text("FRAMES", style = head, modifier = Modifier.weight(0.7f)); Text("LAST FRAME", style = head, modifier = Modifier.weight(1f))
            }
        }
        items(rows, key = { "${it.hz}/${it.bw}/${it.sf}/${it.name}" }) { c ->
            val lf = lastFrame(c); val hot = now - lf < 5000
            val quiet = !(c.standing || c.active || c.frames > 0)
            val dot: @Composable () -> Unit = { Box(Modifier.padding(top = d.dp(4f)).size(d.dp(8f)).background(netColor(c.name.substringBefore(' ')), CircleShape)) }
            val when0 = if (lf > 0) "${agoText(lf, now)} ago" else ""
            Box(Modifier.fillMaxWidth().alpha(if (quiet) 0.55f else 1f).background(if (hot) Palette.ok.copy(alpha = 0.10f) else Color.Transparent, RoundedCornerShape(6.dp)).padding(vertical = d.dp(4f))) {
                if (phone) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    dot()
                    Column(Modifier.weight(1f)) {
                        Text(c.name, style = cell.copy(fontWeight = FontWeight.Bold))
                        Text("${mhz4(c.hz)} · ${modem(c)} · ${listening(c)}" + (if (c.frames > 0) " · ${c.frames} frames" else "") + (if (when0.isNotEmpty()) " · last $when0" else ""),
                            style = cell.copy(color = Palette.muted, fontSize = d.sp(9.5f)))
                    }
                } else Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    dot()
                    Text(c.name, style = cell.copy(fontWeight = FontWeight.Bold), modifier = Modifier.weight(2.2f)); Text(mhz4(c.hz), style = cell, modifier = Modifier.weight(1f))
                    Text(modem(c), style = cell.copy(color = Palette.muted), modifier = Modifier.weight(1.2f)); Text(listening(c), style = cell, modifier = Modifier.weight(1.6f))
                    Text(if (c.frames > 0) "${c.frames}" else "", style = cell, modifier = Modifier.weight(0.7f)); Text(when0, style = cell.copy(color = Palette.muted), modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

/**
 * The footer line: the span, the channels something was decoded on (lit while it is being heard), bursts and frames,
 * what is wrong said plainly (a frame lost to a gap shows for a minute, not the rest of the session), and how many
 * channels are listened to all the time, which opens CHANNELS.
 */
@Composable
private fun LoraFooter(states: List<LoraScanner.ChannelState>, nodes: List<LoraNode>, rate: Int, freq: Long, bursts: Int, frames: Int, narrowed: Int, losing: String,
                       now: Long, accent: Color, onWatch: () -> Unit) {
    val d = rememberDims()
    val torn = Apps.lora.torn
    val tornSeen = remember { longArrayOf(0L, 0L) }   // the count last seen and when it went up
    if (torn > tornSeen[0]) { tornSeen[0] = torn.toLong(); tornSeen[1] = now }
    if (torn < tornSeen[0]) tornSeen[0] = torn.toLong()
    val busy = Apps.lora.scanner.busy
    val heard = states.filter { it.frames > 0 }.sortedByDescending { it.frames }
    val watched = states.count { it.standing }
    val lastFrame = { c: LoraScanner.ChannelState -> nodes.filter { abs(it.hz - c.hz) <= c.bw / 4 }.maxOfOrNull { it.lastMs } ?: 0L }
    val small = TextStyle(fontFamily = Mono, fontSize = d.sp(9.5f), letterSpacing = 1.sp, color = Palette.muted)
    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        val lo = (freq - rate / 2) / 1e6; val hi = (freq + rate / 2) / 1e6
        Text("%.1f–%.1f MHz".format(java.util.Locale.US, lo, hi), style = small.copy(color = Palette.ink, fontWeight = FontWeight.Bold), modifier = Modifier.align(Alignment.CenterVertically))
        Text(buildAnnotatedString {
            if (heard.isEmpty()) {
                val last = nodes.maxOfOrNull { it.lastMs } ?: 0L
                append(if (last > 0) "LISTENING · LAST FRAME ${agoText(last, now).uppercase()} AGO" else "LISTENING · NOTHING DECODED YET")
            } else {
                append("HEARD ON ")
                heard.forEachIndexed { i, c ->
                    if (i > 0) append(" · ")
                    val hot = now - lastFrame(c) < 5000
                    withStyle(SpanStyle(color = if (hot) Palette.ok else Palette.ink, fontWeight = FontWeight.Bold)) { append("${if (hot) "● " else ""}${c.name.removePrefix("Meshtastic ").removePrefix("LoRaWAN ")} ${c.frames}") }
                }
            }
        }, style = small, modifier = Modifier.align(Alignment.CenterVertically))
        Text("$bursts BURSTS · $frames FRAMES", style = small, modifier = Modifier.align(Alignment.CenterVertically))
        val trouble = buildList {
            if (busy > 1.05) add("DECODER BEHIND · ${Math.round(100 * busy)}%")
            if (torn > 0 && now - tornSeen[1] < 60_000) add("FRAMES LOST TO GAPS")
            if (narrowed != 0 && narrowed == rate) add(losing.ifEmpty { "SPAN NARROWED TO ${rate / 1_000_000} MHZ" }.uppercase())
        }
        for (t in trouble) Text(t, style = small.copy(color = Palette.danger, fontWeight = FontWeight.Bold), modifier = Modifier.align(Alignment.CenterVertically))
        if (watched > 0) Text("WATCHING $watched", style = small.copy(color = Palette.ink, fontWeight = FontWeight.Bold),
            modifier = Modifier.align(Alignment.CenterVertically).clip(RoundedCornerShape(8.dp)).border(1.dp, accent.copy(alpha = 0.5f), RoundedCornerShape(8.dp)).clickable { onWatch() }
                .padding(horizontal = d.dp(8f), vertical = d.dp(4f)))
    }
}

/** Everything decoded from one node, field by field, its recent messages, with MAP when it has a position. Moves by its header. */
@Composable
private fun LoraDetail(node: LoraNode, accent: Color, home: Pair<Double, Double>?, modifier: Modifier, onDrag: (Float, Float) -> Unit, onMap: (() -> Unit)?, onCards: (() -> Unit)?, onClose: () -> Unit) {
    val d = rememberDims()
    val c = netColor(node.proto)
    val shape = RoundedCornerShape(d.dp(14f))
    val scroll = rememberScrollState()
    BoxWithConstraints(modifier) {
        Column(Modifier.fillMaxWidth().heightIn(max = maxHeight * 0.92f).clip(shape).background(Palette.panel.copy(alpha = 0.96f))
            .background(Brush.linearGradient(listOf(c.copy(alpha = 0.16f), Palette.panel)))
            .border(1.5.dp, c.copy(alpha = 0.8f), shape).padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).pointerInput(node.key) { detectDragGestures { ch, drag -> ch.consume(); onDrag(drag.x, drag.y) } },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                Column(Modifier.weight(1f)) {
                    Text(node.label, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f))
                    Text("${node.proto.uppercase()} · ${loraWords(node.kind)}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp)
                }
                if (onMap != null) ToggleBox("MAP", false, accent, Modifier.fillMaxHeight()) { onMap() }
                if (onCards != null) ToggleBox("CARDS", false, accent, Modifier.fillMaxHeight()) { onCards() }
                ToggleBox("✕", false, accent, Modifier.fillMaxHeight()) { onClose() }
            }
            val all = listOf(MeshField("FIRST HEARD", LoraHub.clock(node.firstMs)), MeshField("LAST HEARD", LoraHub.clock(node.lastMs)),
                MeshField("PACKETS", "${node.packets}"), MeshField("FREQUENCY", LoraHub.mhz(node.hz)), MeshField("MODEM", node.modem)) +
                (if (home != null && node.lat != null && node.lon != null) listOf(MeshField("FROM YOU", fromYou(home, node.lat, node.lon))) else emptyList()) +
                node.fields.map { MeshField(it.name, if (it.name == "ROLE" || it.name == "HARDWARE") loraWords(it.value) else Units.fmtText(it.value)) }
            Column(Modifier.fillMaxWidth().weight(1f, fill = false).scrollGlow(scroll).verticalScroll(scroll)) {
                SelectionContainer {
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                        FieldGrid(all.map { it.name to it.value }, labelWidth = 96f, minColumn = 220f)
                        for (t in node.texts.reversed()) Text("“$t”", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f))
                    }
                }
            }
        }
    }
}

/**
 * The listening sheet (the cog): area, band, span, your own channel, YOUR NODE (what you send as), anything going
 * wrong, and every channel being watched.
 */
@Composable
private fun LoraSettings(accent: Color, rate: Int, freq: Long, area: String, states: List<LoraScanner.ChannelState>, toNode: Boolean, onAnnounce: () -> Unit, txStatus: String, onClose: () -> Unit) {
    val d = rememberDims()
    val localTick by LoraLocal.version.collectAsState()
    val me by LoraMe.me.collectAsState()
    val station by Station.info.collectAsState()
    val narrowed by Apps.lora.narrowed.collectAsState()
    val losing by Apps.lora.deliveryNote.collectAsState()
    var pickTick by remember { mutableIntStateOf(0) }
    var customOpen by remember { mutableStateOf(false) }
    val wide = rate > 2_400_000
    val midSpan = rate in 2_400_001 until LoraScanner.RATE
    val scroll = rememberScrollState()
    var nodeY by remember { mutableIntStateOf(-1) }
    LaunchedEffect(toNode, nodeY) { if (toNode && nodeY > 0) scroll.animateScrollTo(nodeY) }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val shape = RoundedCornerShape(d.dp(14f))
        Box(Modifier.fillMaxSize().clickable(interactionSource = null, indication = null) { onClose() }, contentAlignment = Alignment.Center) {
            Column(Modifier.widthIn(max = 640.dp).fillMaxWidth().padding(d.dp(12f)).clip(shape).background(Palette.surface).border(1.dp, accent.copy(alpha = 0.6f), shape)
                .clickable(interactionSource = null, indication = null) {}.verticalScroll(scroll).padding(d.dp(14f)), verticalArrangement = Arrangement.spacedBy(d.dp(10f))) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("LISTENING", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), letterSpacing = 2.sp, modifier = Modifier.weight(1f))
                    ToggleBox("✕", false, accent) { onClose() }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                    RowLabel("AREA")
                    // another area starts from its own channels: a span picked for the old one is let go
                    LoraAreaMenu(accent, LoraLocal.picked, area, Modifier.weight(1f)) { SdrEngine.saveLong("lora_user_wide", 0L); LoraLocal.picked = it }
                }
                SubHead(if (wide) "BAND" else "CHANNEL")
                if (wide) {
                    // LOCAL follows the area; a band tile is the user's own pick, kept until LOCAL is tapped again
                    val localHz = remember(localTick, area, rate) { LoraLocal.wideCenter(area, rate) ?: LoraPlan.homeBand().center }
                    val userWide = remember(pickTick, localTick, freq) { SdrEngine.savedLong("lora_user_wide") }
                    val tiles = listOf(Tile("LOCAL", LoraLocal.title(area), userWide == 0L && freq == localHz)) + LoraPlan.bands.map { Tile(it.title, it.sub, userWide != 0L && freq == it.center) }
                    TileRow(tiles, accent, width = 132.dp) { i ->
                        if (i == 0) { SdrEngine.saveLong("lora_user_wide", 0L); SdrEngine.tune(localHz) }
                        else { val c = LoraPlan.bands[i - 1].center; SdrEngine.saveLong("lora_user_wide", c); SdrEngine.tune(c) }
                        pickTick++
                    }
                } else {
                    // one channel at a time, the area's own first; the radio sits 300 kHz above it, clear of the spike at the center
                    val chans = remember(localTick, area) { LoraLocal.listening(area).take(8) }
                    val tiles = chans.map { c -> Tile(mhz3(c.hz), c.name.removePrefix("MeshCore ").removePrefix("Meshtastic "), freq - LoraSend.NARROW_SHIFT == c.hz) }
                    TileRow(tiles, accent, width = 132.dp) { i -> SdrEngine.saveLong("lora_user_narrow", chans[i].hz); SdrEngine.tune(chans[i].hz + LoraSend.NARROW_SHIFT); pickTick++ }
                }
                // 10 MHz opens; 20 is by hand. A span picked by hand is tried again even where the radio lost samples before
                val spans = listOf(LoraScanner.RATE, LoraScanner.MAX_RATE)
                val whys = spans.map { Radio.rateWhy(it) }
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                    RowLabel("SPAN")
                    SegBar(listOf("2 MHz", if (midSpan) "${rate / 1_000_000} MHz" else "10 MHz", "20 MHz"),
                        if (rate <= 2_400_000) 0 else if (rate < LoraScanner.MAX_RATE) 1 else 2, accent, Modifier.weight(1f),
                        tints = listOf(null) + whys.map { if (it.isNotEmpty()) Palette.muted.copy(alpha = 0.45f) else null }) {
                        if (it == 0) {
                            if (rate > 2_400_000) { SdrEngine.setRate(2_000_000); SdrEngine.tune(Apps.loraNarrowStart()) }
                        } else gated(whys[it - 1]) {
                            val to = spans[it - 1]
                            if (rate != to) {
                                Apps.lora.narrowed.value = 0; Apps.lora.deliveryNote.value = ""; Apps.loraCap = 0; Apps.loraCapAt = 0L; Apps.loraRetryMs = 120_000L
                                SdrEngine.setRate(to); SdrEngine.tune(Apps.loraWideStart(to))
                            }
                        }()
                    }
                    ToggleBox("YOUR CHANNEL", false, accent, Modifier.fillMaxHeight()) { customOpen = true }
                }
                val mine = remember(localTick) { LoraLocal.custom }
                if (mine != null) Text("YOUR CHANNEL · %.4f MHz · %s · SF%d".format(java.util.Locale.US, mine.hz / 1e6, LoraHub.bwName(mine.bw), mine.sf),
                    color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp)

                // YOUR NODE: the names are counted in bytes, as the networks count them: one emoji is 4, and a short name is one emoji at most
                Column(Modifier.onGloballyPositioned { nodeY = it.boundsInParent().top.roundToInt() }, verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    SubHead("YOUR NODE · WHAT YOU SEND AS")
                    var long by remember { mutableStateOf(me.long) }
                    var short by remember { mutableStateOf(me.short) }
                    fun save(lic: Boolean = me.licensed) = LoraMe.save(me.copy(long = long.trim().ifEmpty { me.long }, short = short.trim().ifEmpty { me.short }, licensed = lic))
                    @Composable fun nameField(v: String, max0: Int, label: String, m: Modifier, set: (String) -> Unit) =
                        OutlinedTextField(v, { t -> set(LoraMe.clipBytes(t, max0)) }, singleLine = true, label = { Text(label, fontFamily = Mono, fontSize = d.sp(10f)) },
                            textStyle = TextStyle(fontFamily = Mono, fontWeight = FontWeight.Bold, color = Palette.ink, fontSize = d.sp(13f)),
                            trailingIcon = { Text("${LoraMe.bytes(v.trim())}/$max0", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(end = d.dp(8f))) },
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { save() }),
                            colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = accent, unfocusedBorderColor = accent.copy(alpha = 0.6f), cursorColor = accent, focusedLabelColor = accent),
                            modifier = m.onFocusLeft { save() })
                    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        nameField(long, LoraMe.LONG_MAX, "LONG NAME", Modifier.widthIn(min = 200.dp).weight(1f)) { long = it }
                        nameField(short, LoraMe.SHORT_MAX, "SHORT", Modifier.width(d.dp(130f))) { short = it }
                    }
                    Text("Long name up to ${LoraMe.LONG_MAX} bytes, short name up to ${LoraMe.SHORT_MAX} (one emoji is 4 bytes).", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
                    val call = station.call.trim().uppercase()
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(me.licensed, { save(it) }, colors = CheckboxDefaults.colors(checkedColor = accent, uncheckedColor = Palette.muted))
                        Text("Licensed (ham): no encryption, sent under your callsign${if (call.isNotEmpty()) " ($call)" else " (set it in Settings, STATION)"}",
                            color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.weight(1f))
                    }
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("NODE !${me.hex}", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, modifier = Modifier.weight(1f))
                        LoraChip("ANNOUNCE", false, accent) { save(); onAnnounce() }
                    }
                    if (txStatus.isNotEmpty()) Text(txStatus, color = Palette.danger, fontFamily = Mono, fontSize = d.sp(10f))
                }
                // what is going wrong, and the channels being watched
                val torn = Apps.lora.torn; val busy = Apps.lora.scanner.busy
                val warn = listOfNotNull(if (narrowed != 0 && narrowed == rate) losing.ifEmpty { "span narrowed to ${rate / 1_000_000} MHz: this device fell behind at a wider one" } else null,
                    if (torn > 0) "$torn frames lost to radio gaps" else null, if (busy > 1.05) "decoding needs ${Math.round(100 * busy)}% of real time to keep up" else null)
                if (warn.isNotEmpty()) Text(warn.joinToString(" · "), color = Palette.danger, fontFamily = Mono, fontSize = d.sp(10.5f), lineHeight = d.sp(15f))
                val always = states.filter { it.standing }; val now = states.filter { it.active && !it.standing }
                if (always.isNotEmpty()) { SubHead("ALWAYS ON · ${always.size} CHANNEL${if (always.size == 1) "" else "S"}"); LoraChannelTable(always) }
                SubHead("OPEN FOR A BURST NOW")
                if (now.isNotEmpty()) LoraChannelTable(now)
                else Text("NONE · any other known channel opens when a burst is heard on it, LoRaWAN uplinks among them", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f))
                Text("Meshtastic is decrypted on the default channels (names, positions, telemetry, text), MeshCore read from its adverts and public channel, and LoRaWAN by device address and network; any other LoRa shows as raw frames. It starts on the channels where you are: AREA, the band tiles and your own channel change that. A HackRF watches 10 MHz at once (20 by hand, where the radio delivers every sample); an RTL-SDR one channel at a time.",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(15f))
            }
        }
    }
    if (customOpen) LoraCustomDialog(accent) { customOpen = false }
}

/** Saves when focus leaves the field. */
private fun Modifier.onFocusLeft(f: () -> Unit): Modifier = this.then(Modifier.onFocusChanged { if (!it.isFocused) f() })

@Composable
private fun SubHead(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 2.sp, modifier = Modifier.padding(top = d.dp(4f)))
}

/** A list of channels with where each one is and its modem; a long list folds into groups by system instead. */
@Composable
private fun LoraChannelTable(list: List<LoraScanner.ChannelState>) {
    val d = rememberDims()
    val cell = TextStyle(fontFamily = Mono, color = Palette.ink, fontSize = d.sp(10.5f))
    Column(Modifier.fillMaxWidth().panel().padding(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        if (list.size > 12) for ((sys, names) in loraWatchGroups(list.map { it.name })) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(sys.uppercase(), style = cell.copy(fontWeight = FontWeight.Bold), modifier = Modifier.width(d.dp(96f)))
            Text(names.joinToString(" · "), style = cell.copy(color = Palette.muted), modifier = Modifier.weight(1f))
        }
        else for (c in list.sortedBy { it.hz }) FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text(c.name, style = cell.copy(fontWeight = FontWeight.Bold))
            Text("${mhz4(c.hz)} MHz", style = cell)
            Text((c.sf?.let { "SF$it · " } ?: "") + LoraHub.bwName(c.bw), style = cell.copy(color = Palette.muted))
        }
    }
}

/**
 * The channels being watched, by system (Meshtastic, MeshCore, LoRaWAN...), with the system's name left off each one
 * and numbered channels folded into ranges: "US915 uplink 15–71" instead of 57 names.
 */
internal fun loraWatchGroups(names: List<String>): List<Pair<String, List<String>>> {
    val by = LinkedHashMap<String, MutableList<String>>()
    for (n in names) {
        val sp = n.indexOf(' ')
        by.getOrPut(if (sp > 0) n.substring(0, sp) else "Other") { mutableListOf() } += if (sp > 0) n.substring(sp + 1) else n
    }
    val numbered = Regex("^(.*\\D) (\\d+)$")
    return by.map { (sys, list) ->
        val runs = LinkedHashMap<String, MutableList<Int>>(); val plain = mutableListOf<String>()
        for (n in list) { val m = numbered.find(n); if (m != null) runs.getOrPut(m.groupValues[1]) { mutableListOf() } += m.groupValues[2].toInt() else plain += n }
        for ((base, all) in runs) {
            val nums = all.sorted(); val parts = mutableListOf<String>(); var i = 0
            while (i < nums.size) { var j = i; while (j + 1 < nums.size && nums[j + 1] == nums[j] + 1) j++; parts += if (i == j) "${nums[i]}" else "${nums[i]}–${nums[j]}"; i = j + 1 }
            plain += "$base ${parts.joinToString(", ")}"
        }
        sys to plain
    }
}

/** The area picker: Automatic (where the device is) or any country or part of one with presets of its own. */
@Composable
private fun LoraAreaMenu(accent: Color, picked: String, area: String, modifier: Modifier, onPick: (String) -> Unit) {
    val d = rememberDims()
    var open by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(6.dp)
    val label = if (picked == "AUTO") "AUTOMATIC · " + LoraLocal.title(area).uppercase() else LoraLocal.title(picked).uppercase()
    Box(modifier) {
        Text("$label  ▾", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f),
            modifier = Modifier.fillMaxWidth().clip(shape).border(1.dp, accent.copy(alpha = 0.7f), shape).clickable { open = true }
                .padding(horizontal = d.dp(12f), vertical = d.dp(7f)))
        DropdownMenu(open, onDismissRequest = { open = false }, modifier = Modifier.background(Palette.surface)) {
            for (a in LoraLocal.areas()) DropdownMenuItem(
                text = {
                    Text((if (a.id == picked) "✓ " else "") + a.title, color = if (a.id == picked) accent else Palette.ink, fontFamily = Mono,
                        fontWeight = if (a.id == picked) FontWeight.Bold else FontWeight.Medium, fontSize = d.sp(12f))
                },
                onClick = { open = false; if (a.id != picked) onPick(a.id) })
        }
    }
}

/** A channel of the user's own: frequency, bandwidth and spreading factor, listened to all the time while in span. */
@Composable
private fun LoraCustomDialog(accent: Color, onDone: () -> Unit) {
    val d = rememberDims()
    val now = remember { LoraLocal.custom }
    var mhz by remember { mutableStateOf(now?.let { "%.4f".format(java.util.Locale.US, it.hz / 1e6) } ?: "") }
    var bw by remember { mutableIntStateOf(LoraScanner.BWS.indexOf(now?.bw ?: 125_000).let { if (it < 0) 1 else it }) }
    var sf by remember { mutableIntStateOf((now?.sf ?: 7) - 7) }
    fun save() {
        val f = mhz.replace(',', '.').toDoubleOrNull() ?: return
        if (f < 400 || f > 1000) return
        LoraLocal.custom = LoraLocal.Custom(Math.round(f * 1e6), LoraScanner.BWS[bw], 7 + sf)
        onDone()
    }
    Dialog(onDismissRequest = onDone) {
        val shape = RoundedCornerShape(d.dp(14f))
        Column(Modifier.fillMaxWidth().clip(shape).background(Palette.surface).border(1.dp, accent.copy(alpha = 0.6f), shape).padding(d.dp(18f)),
            verticalArrangement = Arrangement.spacedBy(d.dp(12f))) {
            Text("YOUR OWN CHANNEL", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 1.sp)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("MHz")
                OutlinedTextField(
                    value = mhz, onValueChange = { t -> mhz = t.filter { it.isDigit() || it == '.' || it == ',' }.take(10) }, singleLine = true,
                    placeholder = { Text("915.0000", fontFamily = Mono, color = Palette.muted) },
                    textStyle = TextStyle(fontFamily = Mono, fontWeight = FontWeight.Bold, color = Palette.ink, fontSize = d.sp(14f)),
                    keyboardOptions = KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { save() }),
                    colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = accent, unfocusedBorderColor = accent.copy(alpha = 0.7f), cursorColor = accent),
                    modifier = Modifier.weight(1f))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("BW")
                SegBar(LoraScanner.BWS.map { LoraHub.bwName(it) }, bw, accent, Modifier.weight(1f)) { bw = it }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("SF")
                SegBar((7..12).map { "$it" }, sf, accent, Modifier.weight(1f)) { sf = it }
            }
            SegBar(listOf("CLEAR", "SAVE"), -1, accent, Modifier.fillMaxWidth()) { i ->
                if (i == 0) { LoraLocal.custom = null; onDone() } else save()
            }
        }
    }
}
