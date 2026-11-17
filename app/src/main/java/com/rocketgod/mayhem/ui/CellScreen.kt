package com.rocketgod.mayhem.ui

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.Saves
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.cell.AlertGroup
import com.rocketgod.mayhem.core.cell.CELL_BANDS
import com.rocketgod.mayhem.core.cell.CellDetail
import com.rocketgod.mayhem.core.cell.CellRow
import com.rocketgod.mayhem.core.cell.CellSnap
import com.rocketgod.mayhem.core.cell.fieldGroups
import com.rocketgod.mayhem.core.cell.groupAlerts
import com.rocketgod.mayhem.core.cell.jsNum
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale
import kotlin.math.max

private val CL_VIEWS = listOf("ALERTS", "CELLS", "NEIGHBORS", "LOG")
/** On a wide screen the alerts have the big pane, so they are not a tab. */
private val CL_WIDE_VIEWS = listOf(1, 2, 3)
private val CL_BW = mapOf(6 to "1.4", 15 to "3", 25 to "5", 50 to "10", 75 to "15", 100 to "20")

private fun clMhz(hz: Long) = "%.1f".format(Locale.US, hz / 1e6)
private fun clAgo(ms: Long): String = when {
    ms < 2_000 -> "now"
    ms < 60_000 -> "${ms / 1000} s ago"
    ms < 3_600_000 -> "${ms / 60_000} min ago"
    ms < 172_800_000 -> "${ms / 3_600_000} h ago"
    else -> "${ms / 86_400_000} d ago"
}
private fun clTime(ms: Long): String = java.text.SimpleDateFormat("MMM d HH:mm:ss", Locale.US).format(java.util.Date(ms))
private fun hex(v: Long, w: Int = 0) = java.lang.Long.toHexString(v).uppercase(Locale.US).padStart(w, '0')
private fun clBandAt(hz: Long) = CELL_BANDS.firstOrNull { hz >= it.lo - 2_000_000 && hz <= it.hi + 2_000_000 }
/** Severity colors by rank: tests, public safety, severe and AMBER, extreme, presidential and ETWS disasters. */
private fun rankColor(rank: Int): Color = when (rank.coerceIn(0, 5)) {
    0 -> Palette.muted; 1 -> Palette.accent; 2 -> Color(0xFFFFAF00); 3 -> Color(0xFFFF7A45); 4 -> Color(0xFFFF4D4D); else -> Color(0xFFFF2A6A)
}
private fun cellLabel(c: CellRow, pci: Boolean = true): String {
    val op = c.summary?.plmns?.firstOrNull { it.name.isNotEmpty() }?.name ?: c.summary?.plmns?.firstOrNull()?.id ?: ""
    return "${if (op.isNotEmpty()) "$op · " else ""}${clMhz(c.hz)} MHz${if (pci) " · PCI ${c.pci}" else ""}"
}
/** What the connected radio can and cannot do here, said plainly. */
private fun capability(kind: Radio.Kind): Pair<String, Int> = when {
    kind == Radio.Kind.NONE -> "NO RADIO · a HackRF reads cells, SIBs and alerts; an RTL-SDR reads cells and their MIB" to 0
    Apps.cellRate() < 15_360_000 -> "RTL-SDR · 1.92 MS/s · cell search and MIB from the center 1.08 MHz · SIBs and alerts need the whole carrier: a HackRF" to 1
    else -> "HACKRF · 15.36 MS/s · cells, MIB, every SIB and the alerts of carriers up to 15 MHz (20 MHz carriers: MIB only)" to 2
}

/**
 * Cell: LTE cells and their emergency alerts (WEA/CMAS, ETWS) from the broadcast channels, receive only. ALERTS holds
 * every warning heard until it is cleared, CELLS every cell with its SIBs, NEIGHBORS the relations they announce, LOG
 * every decoded block. A tap on a cell opens every decoded field.
 */
@Composable
fun CellScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val s by Apps.cell.snap.collectAsState()
    val band by Apps.cellBand.collectAsState()
    val scan by Apps.cellScan.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val kind by Radio.kind.collectAsState()
    val logSnap by Apps.cellLog.snapshot.collectAsState()
    val wide = d.wide
    var view by rememberSaveable { mutableIntStateOf(0) }
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var detail by remember { mutableStateOf<CellDetail?>(null) }
    var clearArm by remember { mutableLongStateOf(0L) }
    var banner by remember { mutableStateOf("") }
    val seen = remember { HashSet<String>() }
    val open = remember { mutableStateMapOf<String, Boolean>() }
    var full by remember { mutableStateOf(false) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(250); value = System.currentTimeMillis() } }.value
    // the scan runs while the screen is up
    LaunchedEffect(Unit) { while (true) { delay(300); Apps.cellTick(System.currentTimeMillis()) } }
    LaunchedEffect(wide) { if (wide && view == 0) { view = 1; full = false } }
    LaunchedEffect(sel) {
        detail = null
        val k = sel ?: return@LaunchedEffect
        while (true) { detail = withContext(Dispatchers.Default) { Apps.cell.detail(k) }; delay(5_000) }
    }
    val groups = remember(s?.alerts) { s?.let { groupAlerts(it.alerts) } ?: emptyList() }
    // new alerts: the lamp and a banner until they are looked at
    LaunchedEffect(s?.alerts) {
        for (a in s?.alerts.orEmpty()) if (a.complete && seen.add(a.key) && System.currentTimeMillis() - a.firstMs < 3_600_000) banner = "NEW ${a.cls.uppercase(Locale.US)}"
    }
    LaunchedEffect(view, wide, banner) { if ((view == 0 || wide) && banner.isNotEmpty()) banner = "" }
    val wf = waterfallOn(MayhemApp.CELL, phoneDefault = false)
    val tabs = if (wide) CL_WIDE_VIEWS else CL_VIEWS.indices.toList()
    val nbCount = s?.cells?.count { c -> c.neighbors?.let { it.intra.isNotEmpty() || it.inter.isNotEmpty() || it.nr.isNotEmpty() } == true } ?: 0

    fun pick(k: String) { sel = if (sel == k) null else k }
    fun export() {
        scope.launch {
            val (csv, json) = withContext(Dispatchers.Default) { Apps.cell.exportAll() }; val stamp = Saves.stamp()
            val a = Saves.toDownloads(ctx, "cell-log-$stamp.csv", "text/csv", csv.toByteArray())
            val b = Saves.toDownloads(ctx, "cell-decoded-$stamp.json", "application/json", json.toByteArray())
            Toast.makeText(ctx, if (a != null && b != null) "saved $a and $b" else "could not save", Toast.LENGTH_LONG).show()
        }
    }
    fun clearAlerts() {
        if (System.currentTimeMillis() - clearArm < 4000) { clearArm = 0; seen.clear(); scope.launch(Dispatchers.Default) { Apps.cell.clearAlerts() } }
        else clearArm = System.currentTimeMillis()
    }

    @Composable
    fun switcher(withFull: Boolean, modifier: Modifier = Modifier) {
        val counts = listOf("${groups.size}", "${s?.cells?.size ?: 0}", "$nbCount", "")
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalAlignment = Alignment.Top) {
            ClSeg(tabs.map { "${CL_VIEWS[it]} ${counts[it]}".trim() }, tabs.indexOf(view), accent, Modifier.weight(1f)) { view = tabs[it] }
            ToggleBox("EXPORT", false, accent) { export() }
            IconBox(ClearIcon, "Clear") { scope.launch(Dispatchers.Default) { Apps.cell.clear() }; sel = null }
            if (withFull && !wide) IconBox(FullscreenIcon, "Full screen") { full = true }
        }
    }

    @Composable
    fun alertList(modifier: Modifier) {
        val snap = s
        if (snap == null || groups.isEmpty()) { EmptyState("cell", modifier.panel(), accent); return }
        LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(d.dp(9f))) {
            items(groups, key = { it.key }) { g -> AlertCard(g, snap, now, ::pick) }
            item(key = "clear") {
                ToggleBox(if (System.currentTimeMillis() - clearArm < 4000) "TAP AGAIN TO CLEAR EVERY ALERT" else "CLEAR ALERTS", false, accent) { clearAlerts() }
            }
        }
    }

    @Composable
    fun detailPanel(modifier: Modifier) {
        val snap = s ?: return
        val c = snap.cells.firstOrNull { it.key == sel } ?: return
        CellDetailPanel(c, snap, detail?.takeIf { it.key == c.key }, scan, now, accent, open, modifier, onClose = { sel = null })
    }

    @Composable
    fun stage(modifier: Modifier) {
        Box(modifier) {
            val gap = Arrangement.spacedBy(d.dp(9f))
            when (view) {
                0 -> alertList(Modifier.fillMaxSize())
                1 -> if (s == null || s!!.cells.isEmpty()) EmptyState("cellcards", Modifier.fillMaxSize().panel(), accent)
                    else LazyColumn(Modifier.fillMaxSize(), verticalArrangement = gap) { items(s!!.cells, key = { it.key }) { c -> CellCard(c, s!!, now, sel == c.key, accent, ::pick) } }
                2 -> NeighborList(s, now, accent, Modifier.fillMaxSize(), ::pick)
                else -> LogList(logSnap.lines, Modifier.fillMaxSize(), empty = "watching for LTE cells…", total = logSnap.total, accent = accent)
            }
            if (!wide && view != 3) detailPanel(Modifier.align(Alignment.BottomCenter).padding(d.dp(6f)))
        }
    }

    PacketFrame(accent, Apps.cellLog, tag = "CELL", title = "LTE ALERTS · CELL INFO", roomy = true, waterfall = wf,
        widePane = { m ->
            Column(m) {
                Row(Modifier.padding(start = d.dp(2f), bottom = d.dp(6f)), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
                    Text("ALERTS", color = Palette.danger, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 2.sp)
                    if (groups.isNotEmpty()) Text("${groups.size} kept until cleared", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                }
                alertList(Modifier.fillMaxWidth().weight(1f))
            }
        },
        onWaterfall = { Apps.setWaterfall(MayhemApp.CELL, !wf) },
        lamp = {
            val live = s?.cells?.count { now - it.lastMs < 10_000 } ?: 0
            when {
                s?.alerts?.any { it.complete && now - it.lastMs < 600_000 } == true -> Lamp("ALERT", Palette.danger, blink = true)
                live > 0 -> Lamp("$live CELL${if (live == 1) "" else "S"}", Palette.ok)
                s?.lte == true -> Lamp("LTE HEARD", Palette.accent2, blink = true)
                kind == Radio.Kind.NONE -> Lamp("NO RADIO", Palette.muted)
                else -> Lamp("SEARCHING", Palette.accent2, blink = true)
            }
        },
        controls = {
            ClSeg(listOf("AUTO") + CELL_BANDS.map { it.label }, (listOf("AUTO") + CELL_BANDS.map { it.id }).indexOf(band), accent, Modifier.fillMaxWidth()) {
                Apps.setCellBand(if (it == 0) "AUTO" else CELL_BANDS[it - 1].id)
            }
        }, body = {
            Column(Modifier.fillMaxWidth().weight(1.6f).padding(top = d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                CellHead(s, scan, freq, kind, groups.size, now, accent, if (!wide && view != 0) banner else "") { view = 0; banner = "" }
                switcher(true, Modifier.fillMaxWidth())
                // a wide screen docks the details above the cards
                if (wide) detailPanel(Modifier.fillMaxWidth())
                stage(Modifier.fillMaxWidth().weight(1f))
            }
        })
    if (full) FullscreenPanel("CELL · ${CL_VIEWS[view]}", accent, onClose = { full = false }) {
        switcher(false, Modifier.fillMaxWidth().padding(bottom = d.dp(8f)))
        stage(Modifier.fillMaxWidth().weight(1f))
    }
}

/** What it is watching, what the radio can do here, the counters, and the scan state. */
@Composable
private fun CellHead(s: CellSnap?, scan: Apps.CellScan, freq: Long, kind: Radio.Kind, alerts: Int, now: Long, accent: Color, banner: String, onBanner: () -> Unit) {
    val d = rememberDims()
    val (cap, tone) = capability(kind); val band = clBandAt(freq)
    val cells = s?.cells.orEmpty(); val carriers = cells.map { Math.round(it.hz / 1e5) }.toSet().size
    val sibs = cells.sumOf { it.sibs.size + (if (it.summary != null) 1 else 0) }
    val auto = if (Apps.cellBand.value == "AUTO") "AUTO · " else ""
    val status = when (scan.phase) {
        "stay" -> "STAYING · ${clMhz(scan.stayHz)} MHz"
        "survey" -> "${auto}SWEEP ${minOf(scan.wi + 1, scan.windows.size)}/${scan.windows.size}"
        else -> "${auto}CARRIER ${scan.ci + 1}/${scan.cands.size} · ${if (scan.phase == "dwell") "READING" else "LOOKING"} ${max(0L, (scan.until - now + 999) / 1000)} s"
    }
    val on = scan.phase == "dwell" || scan.phase == "stay"
    val here = cells.filter { it.hz == freq && now - it.lastMs < 10_000 }
    Column(verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        if (banner.isNotEmpty()) Text("$banner · VIEW", color = Color.White, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(11f), letterSpacing = 1.5.sp,
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(d.dp(10f))).background(Palette.danger).clickable { onBanner() }.padding(horizontal = d.dp(10f), vertical = d.dp(8f)))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text("${if (band != null) "${band.label} · " else ""}${clMhz(freq)} MHz", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f), letterSpacing = 2.sp, maxLines = 1)
            Text((if (here.isNotEmpty()) here.joinToString(" · ") { "PCI ${it.pci}" } else if (s?.lte == true) "LTE heard, reading the MIB" else "no LTE cell on this center") +
                (if ((s?.cpuMs ?: 0) > 0) " · ${s!!.cpuMs} ms per block" else ""),
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            val pc = if (on) Palette.ok else Palette.muted
            Text(status, color = pc, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.5.sp, maxLines = 1,
                modifier = Modifier.clip(RoundedCornerShape(50)).border(1.dp, pc.copy(alpha = if (on) 1f else 0.4f), RoundedCornerShape(50)).padding(horizontal = d.dp(8f), vertical = d.dp(3f)))
        }
        val tc = when (tone) { 2 -> Palette.ok; 1 -> Palette.accent2; else -> Palette.muted }
        Text(cap, color = tc, fontFamily = Mono, fontSize = d.sp(9.5f), lineHeight = d.sp(13f),
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(d.dp(8f))).border(1.dp, tc.copy(alpha = 0.45f), RoundedCornerShape(d.dp(8f))).padding(horizontal = d.dp(8f), vertical = d.dp(5f)))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            for ((n, l) in listOf("$alerts" to "ALERTS", "${cells.size}" to "CELLS", "$carriers" to "CARRIERS", "$sibs" to "SIBS", "${s?.tbOk ?: 0}" to "BLOCKS")) {
                val al = l == "ALERTS" && alerts > 0
                Column(Modifier.weight(1f).clip(RoundedCornerShape(d.dp(10f))).background(if (al) Palette.danger.copy(alpha = 0.12f) else Palette.surface)
                    .border(1.dp, if (al) Palette.danger else accent.copy(alpha = 0.25f), RoundedCornerShape(d.dp(10f))).padding(vertical = d.dp(5f)), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(n, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f), maxLines = 1)
                    Text(l, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(7.5f), letterSpacing = 1.sp, maxLines = 1)
                }
            }
        }
    }
}

/** One alert: its class, when, every language it came in, the alert area as received, and the cells that carried it. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AlertCard(g: AlertGroup, s: CellSnap, now: Long, pick: (String) -> Unit) {
    val d = rememberDims()
    val col = rankColor(g.rank); val fresh = now - g.lastMs < 600_000
    val shape = RoundedCornerShape(d.dp(14f))
    var areaOpen by remember { mutableStateOf(setOf<String>()) }
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).clip(shape).background(Brush.linearGradient(listOf(col.copy(alpha = if (fresh) 0.24f else 0.16f), Palette.surface)))
        .border(if (fresh) 2.dp else 1.dp, col.copy(alpha = if (fresh) 0.85f else 0.55f), shape)) {
        Box(Modifier.width(d.dp(5f)).fillMaxHeight().background(col))
        Column(Modifier.weight(1f).padding(d.dp(12f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f)), itemVerticalAlignment = Alignment.CenterVertically) {
                Text(g.cls.uppercase(Locale.US), color = Color(0xFF05080A), fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(11f), letterSpacing = 1.5.sp,
                    modifier = Modifier.clip(RoundedCornerShape(d.dp(6f))).background(col).padding(horizontal = d.dp(8f), vertical = d.dp(4f)))
                Text(g.messages[0].category, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f))
            }
            Text("${clTime(g.firstMs)} · ${clAgo(now - g.lastMs)}${if (g.lastMs - g.firstMs > 2000) " · heard until ${clTime(g.lastMs)}" else ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
            for (m in g.messages) Column(verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                Box(Modifier.fillMaxWidth().height(1.dp).background(col.copy(alpha = 0.25f)))
                val lang = m.language?.uppercase(Locale.US) ?: if (m.source == "SIB10") "WARNING TYPE" else if (m.alphabet == "8bit") "DATA" else "TEXT"
                Text(lang + if (m.additionalLanguage) " · ADDITIONAL LANGUAGE" else "", color = col, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(9f), letterSpacing = 1.5.sp)
                SelectionContainer {
                    Column(verticalArrangement = Arrangement.spacedBy(d.dp(3f))) {
                        val wt = m.warningType
                        when {
                            !m.complete -> Text("segments ${m.segments.joinToString(", ")} of ${if (m.lastSegment >= 0) "${m.lastSegment + 1}" else "?"} received, waiting for the rest", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
                            m.text.isNotEmpty() -> Text(m.text, color = Palette.ink, fontSize = d.sp(15f), lineHeight = d.sp(21f))
                            m.binaryHex.isNotEmpty() -> {
                                Text(m.binaryHex, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(12f))
                                Text("binary content; its layout is defined outside the 3GPP specs this app is built from (ATIS-0700041): shown as received", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                            }
                            wt != null -> Text(wt.type.uppercase(Locale.US) + (if (wt.userAlert) " · USER ALERT" else "") + (if (wt.popup) " · POPUP" else ""), color = Palette.ink, fontSize = d.sp(15f))
                        }
                        val meta = listOf("ID ${m.id} (0x${hex(m.id.toLong())})", "SERIAL 0x${hex(m.serial.toLong(), 4)}", m.scope, "CODE ${m.messageCode}", "UPDATE ${m.updateNumber}",
                            if (m.dcs >= 0) "DCS 0x${hex(m.dcs.toLong(), 2)}" else "", if (m.pages > 0) "${m.pages} PAGE${if (m.pages == 1) "" else "S"}" else "", m.source).filter { it.isNotEmpty() }.joinToString(" · ")
                        Text(meta, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 0.4.sp)
                    }
                }
                if (m.areaHex.isNotEmpty()) {
                    val isOpen = m.key in areaOpen
                    Text("${if (isOpen) "▾" else "▸"} ALERT AREA · ${m.areaHex.length / 2} OCTETS", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.2.sp,
                        modifier = Modifier.clickable { areaOpen = if (isOpen) areaOpen - m.key else areaOpen + m.key })
                    if (isOpen) SelectionContainer {
                        Column {
                            Text(m.areaHex, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                            Text("the polygon's encoding is ATIS-0700041 (named by TS 23.041 9.3.63), outside the specs this app is built from: shown as received", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                        }
                    }
                }
            }
            val rows = g.cells.mapNotNull { k -> s.cells.firstOrNull { it.key == k } }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f)), itemVerticalAlignment = Alignment.CenterVertically) {
                Text("CARRIED BY", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.5.sp)
                val chips: List<Pair<String, String?>> = if (rows.isNotEmpty()) rows.map { cellLabel(it) to it.key } else g.cells.map { it to null }
                for ((t, k) in chips) Text(t, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f),
                    modifier = Modifier.clip(RoundedCornerShape(d.dp(7f))).border(1.dp, col.copy(alpha = 0.45f), RoundedCornerShape(d.dp(7f)))
                        .then(if (k != null) Modifier.clickable { pick(k) } else Modifier).padding(horizontal = d.dp(7f), vertical = d.dp(3f)))
            }
        }
    }
}

@Composable
private fun ClPill(text: String, c: Color) {
    val d = rememberDims()
    Text(text, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1,
        modifier = Modifier.clip(RoundedCornerShape(50)).border(1.dp, c.copy(alpha = 0.7f), RoundedCornerShape(50)).background(c.copy(alpha = 0.10f))
            .padding(horizontal = d.dp(7f), vertical = d.dp(2f)))
}

/** One cell: band, operator, frequency, IDs, the SIBs scheduled (lit when received) and its flags. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CellCard(c: CellRow, s: CellSnap, now: Long, selected: Boolean, accent: Color, pick: (String) -> Unit) {
    val d = rememberDims()
    val live = now - c.lastMs < 10_000; val sm = c.summary
    val shape = RoundedCornerShape(d.dp(14f))
    val ops = sm?.plmns?.joinToString(" · ") { if (it.name.isNotEmpty()) "${it.name} ${it.id}" else it.id } ?: ""
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).alpha(if (live) 1f else 0.72f).clip(shape).background(Brush.linearGradient(listOf(accent.copy(alpha = 0.10f), Palette.surface)))
        .border(if (selected) 2.dp else 1.dp, accent.copy(alpha = if (selected) 1f else 0.35f), shape).clickable { pick(c.key) }) {
        Box(Modifier.width(d.dp(4f)).fillMaxHeight().background(accent))
        Column(Modifier.weight(1f).padding(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(7f))) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
                Text(if (c.band != null) "B${c.band}${if (c.tdd) " TDD" else ""}" else "LTE", color = Color(0xFF05080A), fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(10f), letterSpacing = 1.2.sp,
                    modifier = Modifier.clip(RoundedCornerShape(d.dp(6f))).background(accent).padding(horizontal = d.dp(7f), vertical = d.dp(4f)))
                Column(Modifier.weight(1f)) {
                    Text(ops.ifEmpty { "operator not read yet" }, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 2)
                    Text("${clMhz(c.hz)} MHz${if (c.earfcn != null) " · EARFCN ${c.earfcn}" else ""} · ${CL_BW[c.nrb]?.let { "$it MHz" } ?: "-"}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f))
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(5f))) {
                    Box(Modifier.size(d.dp(8f)).background(if (live) Palette.ok else Palette.muted, CircleShape))
                    Text(if (live) "LIVE" else clAgo(now - c.lastMs), color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp)
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(14f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                val kv = listOfNotNull("PCI" to "${c.pci}", sm?.let { "CELL" to "${it.enbId}/${it.cellId}" }, sm?.let { "TAC" to "${it.tac}" }, "SNR" to "%.0f dB".format(Locale.US, c.snrDb),
                    "PORTS" to (if (c.ports > 0) "${c.ports}" else "-"), "SFN" to (if (c.sfn >= 0) "${c.sfn}" else "-"))
                for ((k, v) in kv) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalAlignment = Alignment.CenterVertically) {
                    Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp)
                    Text(v, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f))
                }
            }
            if (sm != null) {
                val strip = { n: String -> n.replace(Regex("-v\\d+$"), "").replace(Regex("-r\\d+$"), "") }
                val want = sm.schedule.flatMap { t -> t.sibs.map { strip(it.replace("sibType", "sib")) } }.distinct()
                val got = c.sibs.map { strip(it.name) }.toSet()
                FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                    for (n in listOf("sib1") + want) {
                        val on = n == "sib1" || n in got; val warn = Regex("^sib1[012]$").matches(n)
                        Text(n.uppercase(Locale.US), color = if (on) Palette.ink else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(8.5f), letterSpacing = 1.sp,
                            modifier = Modifier.clip(RoundedCornerShape(d.dp(6f))).background(if (on) Palette.ok.copy(alpha = 0.10f) else Color.Transparent)
                                .border(1.dp, if (warn) Palette.danger else if (on) Palette.ok.copy(alpha = 0.6f) else Palette.muted.copy(alpha = 0.45f), RoundedCornerShape(d.dp(6f)))
                                .padding(horizontal = d.dp(6f), vertical = d.dp(2f)))
                    }
                }
            }
            val flags = buildList {
                if (sm?.warning?.sib12 == true) add("WEA SCHEDULED" to Palette.danger)
                if (sm?.warning?.sib10 == true || sm?.warning?.sib11 == true) add("ETWS SCHEDULED" to Palette.danger)
                if (c.alerts > 0) add("${c.alerts} ALERT${if (c.alerts == 1) "" else "S"}" to Palette.danger)
                if (sm?.barred == "barred") add("BARRED" to Palette.muted)
                if (!c.fullBand && sm == null && c.mib != null) add((if (c.nrb > s.maxRb) "MIB ONLY · CARRIER WIDER THAN THE SPAN" else "MIB ONLY") to Palette.muted)
            }
            if (flags.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) { for ((t, col) in flags) ClPill(t, col) }
        }
    }
}

/** A small table: a header row and value rows, each column its share of the width. */
@Composable
private fun ClTable(head: List<String>, rows: List<List<String>>, weights: List<Float>, lit: (Int, Int) -> Boolean = { _, _ -> false }) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth()) { head.forEachIndexed { i, h -> Text(h, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8f), letterSpacing = 1.sp, maxLines = 1, modifier = Modifier.weight(weights[i])) } }
        rows.forEachIndexed { r, row ->
            Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.line.copy(alpha = 0.7f)))
            Row(Modifier.fillMaxWidth().padding(vertical = d.dp(3f))) {
                row.forEachIndexed { i, v -> Text(v, color = if (lit(r, i)) Palette.ok else Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.weight(weights[i])) }
            }
        }
    }
}

/** The cell relations each cell announces: same frequency, other LTE carriers, NR, older networks. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NeighborList(s: CellSnap?, now: Long, accent: Color, modifier: Modifier, pick: (String) -> Unit) {
    val d = rememberDims()
    val rows = s?.cells.orEmpty().filter { c -> c.neighbors?.let { it.intra.isNotEmpty() || it.inter.isNotEmpty() || it.nr.isNotEmpty() || it.utra.isNotEmpty() || it.geran.isNotEmpty() || it.cdma.isNotEmpty() } == true }
    if (s == null || rows.isEmpty()) {
        Text("neighbor lists arrive in SIB4 (same frequency), SIB5 (other LTE carriers), SIB24 (5G NR) and SIB6/7/8 (older networks) · they need the whole carrier in the span",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = modifier.padding(d.dp(8f)))
        return
    }
    fun heard(mhz: Double?, pci: Int) = mhz != null && s.cells.any { kotlin.math.abs(it.hz / 1e6 - mhz) < 0.06 && it.pci == pci }
    @Composable
    fun chips(label: String, items: List<Pair<String, Boolean>>) = FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f)), itemVerticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.5.sp)
        for ((t, h) in items) Text(t, color = if (h) Palette.ink else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f),
            modifier = Modifier.clip(RoundedCornerShape(d.dp(6f))).border(1.dp, if (h) Palette.ok else Palette.muted.copy(alpha = 0.35f), RoundedCornerShape(d.dp(6f))).padding(horizontal = d.dp(6f), vertical = d.dp(2f)))
    }
    LazyColumn(modifier, verticalArrangement = Arrangement.spacedBy(d.dp(9f))) {
        items(rows, key = { it.key }) { c ->
            val n = c.neighbors!!; val mhz = c.hz / 1e6; val live = now - c.lastMs < 10_000
            Column(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.75f).clip(RoundedCornerShape(d.dp(12f))).background(Palette.surface)
                .border(1.dp, accent.copy(alpha = 0.25f), RoundedCornerShape(d.dp(12f))).padding(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(7f))) {
                Column(Modifier.clickable { pick(c.key) }) {
                    Text(cellLabel(c), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f))
                    Text("${n.intra.size} same-frequency · ${n.inter.size} LTE carriers · ${n.nr.size} NR carriers", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                }
                if (n.intra.isNotEmpty()) chips("SAME FREQUENCY · SIB4", n.intra.map { r -> ("${r.pci}" + if (r.offset.isNotEmpty() && r.offset != "dB0") " ${r.offset}" else "") to heard(mhz, r.pci) })
                if (n.intraExcluded.isNotEmpty()) chips("EXCLUDED", n.intraExcluded.map { it to false })
                if (n.inter.isNotEmpty()) ClTable(listOf("LTE CARRIER · SIB5", "BAND", "MHz", "PRIO", "CELLS"),
                    n.inter.map { f -> listOf("${f.earfcn}", (f.band?.toString() ?: "-") + if (f.bands.size > 1) " (${f.bands.drop(1).joinToString(", ")})" else "", f.mhz?.let { jsNum(it) } ?: "-",
                        f.priority?.toString() ?: "-", f.cells.joinToString(" ") { r -> if (heard(f.mhz, r.pci)) "${r.pci}●" else "${r.pci}" }.ifEmpty { "-" }) },
                    listOf(0.24f, 0.14f, 0.14f, 0.1f, 0.38f))
                if (n.nr.isNotEmpty()) ClTable(listOf("NR CARRIER · SIB24", "MHz", "BAND", "SCS", "PRIO"),
                    n.nr.map { f -> listOf("${f.arfcn}", jsNum(f.mhz), f.bands.joinToString(", ") { "n$it" }.ifEmpty { "-" }, "${f.scs.replace("kHz", "")} kHz", f.priority?.toString() ?: "-") },
                    listOf(0.26f, 0.2f, 0.2f, 0.18f, 0.16f))
                val old = n.utra.map { "UTRA ${it.kind} ${it.uarfcn}${if (it.priority != null) " · prio ${it.priority}" else ""}" } + n.geran.map { "GERAN ${it.band} ${it.arfcns.joinToString(", ")}" } +
                    n.cdma.map { "CDMA2000 ${it.bandClass} ch ${it.arfcn}${if (it.pns.isNotEmpty()) " · PN ${it.pns.joinToString(", ")}" else ""}" }
                if (old.isNotEmpty()) chips("OTHER NETWORKS", old.map { it to false })
            }
        }
        item(key = "note") { Text("a highlighted cell (●) is one this app has heard itself", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(d.dp(2f))) }
    }
}

/** Every decoded field of one cell: its signal, the MIB, SIB1 and the SI schedule, then each SIB in named groups with its raw hex. */
@Composable
private fun CellDetailPanel(c: CellRow, s: CellSnap, det: CellDetail?, scan: Apps.CellScan, now: Long, accent: Color, open: MutableMap<String, Boolean>, modifier: Modifier, onClose: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(14f))
    val scroll = rememberScrollState()
    val sm = c.summary; val m = c.mib
    val stay = scan.phase == "stay" && scan.stayHz == c.hz
    @Composable
    fun sect(t: String) = Text(t, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp, modifier = Modifier.padding(top = d.dp(6f)))
    @Composable
    fun dim(t: String) = Text(t, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
    Column(modifier.fillMaxWidth().heightIn(max = d.dp(460f)).clip(shape).background(Palette.panel.copy(alpha = 0.96f))
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.14f), Palette.panel)))
        .border(1.5.dp, accent.copy(alpha = 0.8f), shape).scrollGlow(scroll).verticalScroll(scroll).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Text("PCI ${c.pci}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text(cellLabel(c, false), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 2, modifier = Modifier.weight(1f))
            ToggleBox(if (stay) "SCAN AGAIN" else "STAY HERE", stay, accent, Modifier.fillMaxHeight()) { Apps.cellStay(c.hz) }
            ToggleBox("✕", false, accent, Modifier.fillMaxHeight()) { onClose() }
        }
        SelectionContainer {
            Column(verticalArrangement = Arrangement.spacedBy(d.dp(5f))) {
                sect("CELL")
                FieldGrid(listOf(
                    "FREQUENCY" to "${clMhz(c.hz)} MHz${if (c.earfcn != null) " · EARFCN ${c.earfcn}" else ""}${if (c.band != null) " · band ${c.band}" else ""}",
                    "PCI" to "${c.pci} (group ${c.pci / 3}, sector ${c.pci % 3})",
                    "SIGNAL" to "SNR %.1f dB · RS %.1f dBFS · CFO ${c.cfoHz} Hz".format(Locale.US, c.snrDb, c.levelDb),
                    "HEARD" to "MIB ${c.mibCount} · SIB1 ${c.sib1Count} · SI DCI ${c.dciCount} · blocks ${c.tbOk} ok, ${c.tbFail} failed",
                    "FIRST HEARD" to clTime(c.firstMs), "LAST HEARD" to "${clTime(c.lastMs)} · ${clAgo(now - c.lastMs)}"), labelWidth = 104f, minColumn = 320f)
                if (m != null) {
                    sect("MIB")
                    FieldGrid(listOf("BANDWIDTH" to "n${m.bandwidth} (${m.bandwidth} RBs)", "PHICH" to "${m.phichDuration} · Ng ${m.phichResource}", "CRS PORTS" to "${m.ports} (from the CRC mask)",
                        "SFN" to "${m.sfn}", "SIB1-BR (LTE-M)" to (if (m.sib1BR > 0) "scheduled, index ${m.sib1BR}" else "not scheduled"), "RAW" to m.bits), labelWidth = 104f, minColumn = 320f)
                }
                if (!c.fullBand && sm == null) dim(if (c.nrb > s.maxRb) "this carrier (${c.nrb} RBs) is wider than the span this radio samples (${s.maxRb} RBs): cell search and MIB only" else "SIB1 and the SI messages come next")
                if (sm != null) {
                    sect("SIB1")
                    FieldGrid(listOf("OPERATOR" to sm.plmns.joinToString(" · ") { "${it.id}${if (it.name.isNotEmpty()) " ${it.name}" else ""}" },
                        "TRACKING AREA" to "${sm.tac} (0x${hex(sm.tac.toLong())})",
                        "CELL IDENTITY" to "0x${hex(sm.cellIdentity, 7)} · eNB ${sm.enbId} · cell ${sm.cellId}",
                        "ACCESS" to "${sm.barred} · intra-frequency reselection ${sm.intraFreqReselection}", "BANDS" to sm.bands.joinToString(", "),
                        "SELECTION" to "q-RxLevMin ${sm.qRxLevMinDbm ?: "-"} dBm${if (sm.qQualMinDb != null) " · q-QualMin ${sm.qQualMinDb} dB" else ""}${if (sm.pMax != null) " · p-Max ${sm.pMax} dBm" else ""}",
                        "SI" to "window ${sm.siWindowMs} ms · value tag ${sm.valueTag}${if (sm.hyperSfn != null) " · hyper SFN ${sm.hyperSfn}" else ""}",
                        "FEATURES" to listOf(if (sm.imsEmergency) "IMS emergency" else "", if (sm.edrx) "eDRX" else "", sm.tdd?.let { "TDD $it" } ?: "").filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { "-" }),
                        labelWidth = 104f, minColumn = 320f)
                    sect("SI SCHEDULE")
                    ClTable(listOf("MESSAGE", "EVERY", "CARRIES", "RECEIVED"), c.si.map { t ->
                        listOf("SI ${t.si}", "${t.periodicity * 10} ms", t.sibs.joinToString(" ") { it.replace("sibType", "SIB") }, if (t.ms > 0) "${clAgo(now - t.ms)} · ×${t.count}" else "not yet")
                    }, listOf(0.16f, 0.18f, 0.36f, 0.3f), lit = { r, i -> i == 3 && c.si[r].ms > 0 })
                }
                c.time?.let { t -> sect("TIME · SIB8"); FieldGrid(listOf("GPS" to t.gpsIso, "UTC" to "${t.utcIso} (18 leap seconds assumed)"), labelWidth = 104f, minColumn = 320f) }
            }
        }
        if (det != null) {
            val blocks = buildList {
                if (det.sib1 != null) add(Triple("sib1", det.sib1 as Any?, det.sib1Hex to ""))
                for (r in det.sibs.sortedWith(compareBy({ it.name.filter { ch -> ch.isLetter() } }, { it.name.drop(3).takeWhile { ch -> ch.isDigit() }.toIntOrNull() ?: 0 }, { it.name })))
                    add(Triple(r.name, r.value as Any?, r.hex to "SI ${if (r.si > 0) "${r.si}" else "?"} · ${clAgo(now - r.ms)} · ×${r.count}"))
            }
            for ((name, value, hm) in blocks) {
                val isOpen = open[name] == true
                Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.line.copy(alpha = 0.8f)))
                Row(Modifier.fillMaxWidth().clickable { open[name] = !isOpen }, verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    Text("${if (isOpen) "▾" else "▸"} ${name.uppercase(Locale.US)}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp)
                    Text(hm.second, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                }
                if (isOpen) SelectionContainer {
                    Column(verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
                        val groups = runCatching { fieldGroups(name, value) }.getOrDefault(emptyList())
                        for (g in groups) {
                            Text(g.name.uppercase(Locale.US), color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8f), letterSpacing = 1.5.sp, modifier = Modifier.padding(top = d.dp(5f)))
                            for ((k, v) in g.rows) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                                Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), modifier = Modifier.weight(0.4f))
                                Text(v, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9.5f), modifier = Modifier.weight(0.6f))
                            }
                        }
                        Text("RAW · ${hm.first.length / 2} OCTETS", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.5.sp, modifier = Modifier.padding(top = d.dp(5f)))
                        Text(hm.first, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
                    }
                }
            }
        } else if (sm != null || c.sibs.isNotEmpty()) dim("loading every decoded field…")
    }
}

/** Choices sized to their labels that wrap onto another line rather than clip. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ClSeg(labels: List<String>, selected: Int, accent: Color, modifier: Modifier, onPick: (Int) -> Unit) {
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
