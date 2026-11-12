package com.rocketgod.mayhem.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.layout.offset
import com.rocketgod.mayhem.core.trains.PtcScanner
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.trains.EotUnit
import com.rocketgod.mayhem.core.trains.HotHeard
import com.rocketgod.mayhem.core.trains.PtcStation
import com.rocketgod.mayhem.core.trains.TrainsProcessor
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Trains: the railroad's radios. The end-of-train units' telemetry (brake pipe pressure, motion, marker light,
 * battery) and the head unit's commands to them, and the PTC train-control network around you: base stations,
 * wayside units and locomotives, when each was heard, how often, and when a wayside's status changed. Receive only.
 */
@Composable
fun TrainsScreen(accent: Color) {
    val d = rememberDims()
    val band by Apps.trainsBand.collectAsState()
    val auto by Apps.trainsAuto.collectAsState()
    val units by Apps.trains.units.collectAsState()
    val hots by Apps.trains.hots.collectAsState()
    val stations by Apps.trains.stations.collectAsState()
    val activity by Apps.trains.activity.collectAsState()
    val other by Apps.trains.ptcOther.collectAsState()
    var view by rememberSaveable { mutableIntStateOf(0) }
    /** The card opened for its full decode: "u<unit>" or "s<hz>". */
    var sel by rememberSaveable { mutableStateOf<String?>(null) }
    var full by remember { mutableStateOf(false) }
    val now = produceState(System.currentTimeMillis()) { while (true) { delay(200); value = System.currentTimeMillis() } }.value

    // BOTH: the radio takes turns, 30 s on PTC (a wayside speaks every ~46 s) and 20 s on EOT, while the screen is up
    LaunchedEffect(auto) {
        if (!auto) return@LaunchedEffect
        while (true) {
            delay(if (Apps.trainsBand.value == TrainsProcessor.Band.PTC) 30_000L else 20_000L)
            Apps.setTrainsBand(if (Apps.trainsBand.value == TrainsProcessor.Band.EOT) TrainsProcessor.Band.PTC else TrainsProcessor.Band.EOT, keepAuto = true)
        }
    }
    // whoever is first heard picks the view: a unit's card, else the PTC stations
    LaunchedEffect(units.isEmpty(), stations.isEmpty()) { if (units.isEmpty() && stations.isNotEmpty() && view == 0) view = 1 }

    @Composable
    fun switcher(modifier: Modifier = Modifier) {
        SegBar(listOf("EOT · ${units.size}", "PTC · ${stations.size}", "HOT · ${hots.size}"), view, accent, modifier) { view = it }
    }

    /**
     * The headline and the PTC band ride at the top of the card grid and scroll away with it, so on a phone the cards get
     * the room; the tabs above stay put.
     */
    @Composable
    fun stage(modifier: Modifier, stripHeight: Float = 48f) {
        Box(modifier) {
            val pickedUnit = units.firstOrNull { "u${it.unit}" == sel }
            val pickedStation = stations.firstOrNull { "s${it.hz}" == sel }
            LazyVerticalGrid(GridCells.Adaptive(d.dp(if (full) 320f else 270f)), Modifier.fillMaxSize(),
                horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                item(key = "head", span = { GridItemSpan(maxLineSpan) }) {
                    Column(verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                        TrainBanner(units, stations, hots, now, accent)
                        if (band == TrainsProcessor.Band.PTC || auto || stations.isNotEmpty()) BandStrip(stations, now, accent, Modifier.fillMaxWidth().height(d.dp(stripHeight)))
                    }
                }
                when (view) {
                    0 -> if (units.isEmpty()) item(key = "empty", span = { GridItemSpan(maxLineSpan) }) {
                        TrainsEmpty("A rear unit only shows while a train passes: it reports about once a minute and on every brake change." +
                            (if (stations.isNotEmpty()) " The PTC network is live: ${stations.size} station${if (stations.size == 1) "" else "s"} on the PTC tab." else ""), Modifier.fillMaxWidth())
                    } else items(units.sortedBy { it.firstMs }, key = { "u${it.unit}" }) { u ->
                        Box(Modifier.clickable { sel = if (sel == "u${u.unit}") null else "u${u.unit}" }) { EotCard(u, accent, now, sel == "u${u.unit}") }
                    }
                    1 -> if (stations.isEmpty()) item(key = "empty", span = { GridItemSpan(maxLineSpan) }) {
                        TrainsEmpty(if (band == TrainsProcessor.Band.PTC || auto) "watching 216–222.5 MHz for the train-control network: a base station beacons every few seconds${if (other > 0) " · $other other bursts" else ""}" else "switch to PTC 220 or BOTH to watch the train-control network", Modifier.fillMaxWidth())
                    // in the order first heard: a new station joins at the end, so nothing the eye is on moves
                    } else items(stations.sortedBy { it.firstMs }, key = { "s${it.hz}" }) { st ->
                        Box(Modifier.clickable { sel = if (sel == "s${st.hz}") null else "s${st.hz}" }) { PtcCard(st, accent, now, sel == "s${st.hz}", band == TrainsProcessor.Band.PTC) }
                    }
                    else -> if (hots.isEmpty()) item(key = "empty", span = { GridItemSpan(maxLineSpan) }) {
                        TrainsEmpty("no head-of-train command heard yet · a locomotive sends one when it checks on its rear unit or brakes", Modifier.fillMaxWidth())
                    } else items(hots.take(30), key = { "h${it.ms}" }, span = { GridItemSpan(maxLineSpan) }) { HotRow(it, accent, now) }
                }
            }
            if (pickedUnit != null && view == 0) FieldDetail(eotFields(pickedUnit, now), "${pickedUnit.unit}", if (pickedUnit.channel == "DPU") "DISTRIBUTED POWER" else "END OF TRAIN", accent,
                Modifier.align(Alignment.BottomCenter).padding(d.dp(6f))) { sel = null }
            if (pickedStation != null && view == 1) FieldDetail(ptcFields(pickedStation, now), "%.4f".format(pickedStation.hz / 1e6), pickedStation.kind.label,
                if (pickedStation.kind == PtcStation.Kind.LOCOMOTIVE) Palette.danger else accent, Modifier.align(Alignment.BottomCenter).padding(d.dp(6f))) { sel = null }
        }
    }

    // the meter follows the bursts themselves (20 ms PTC bursts and 0.2 s EOT frames barely move the band's average)
    val burst = (stations.filter { now - it.lastMs < 4000 }.mapNotNull { it.snr.lastOrNull() } + units.filter { now - it.lastMs < 4000 }.mapNotNull { it.snr.lastOrNull() })
        .maxOrNull()?.toFloat()
    val waterfall by Apps.trainsWaterfall.collectAsState()
    PacketFrame(accent, Apps.trainsLog, tag = "TRAINS", title = "EOT · PTC", roomy = true, listWeight = if (waterfall) 2.5f else 6f, burstDb = burst, waterfall = waterfall, controls = {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
            SegBar(listOf("EOT", "PTC", "BOTH"), if (auto) 2 else if (band == TrainsProcessor.Band.EOT) 0 else 1, accent, Modifier.weight(1f)) {
                when (it) {
                    0 -> Apps.setTrainsBand(TrainsProcessor.Band.EOT)
                    1 -> Apps.setTrainsBand(TrainsProcessor.Band.PTC)
                    else -> Apps.setTrainsAuto()
                }
            }
            // the waterfall at 8 MHz shows little of a 20 ms burst: off by default, the band strip does that job
            ToggleBox("WATERFALL", waterfall, accent) { Apps.setTrainsWaterfall(!waterfall) }
        }
        ChannelLamps(band, activity, now, accent)
    }, list = {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                switcher(Modifier.weight(1f).fillMaxHeight())
                IconBox(FullscreenIcon, "Full screen", Modifier.fillMaxHeight()) { full = true }
            }
            stage(Modifier.fillMaxWidth().weight(1f))
        }
    })
    if (full) FullscreenPanel("TRAINS", accent, onClose = { full = false }, actions = { switcher(Modifier.weight(3f)) }) {
        stage(Modifier.fillMaxWidth().weight(1f), stripHeight = 64f)
    }
}

@Composable
private fun TrainsEmpty(text: String, modifier: Modifier) {
    val d = rememberDims()
    Box(modifier.panel(), contentAlignment = Alignment.Center) {
        Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(d.dp(14f)))
    }
}

/** Each channel this tuning hears, lit while a carrier is on it. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ChannelLamps(band: TrainsProcessor.Band, activity: Map<String, Long>, now: Long, accent: Color) {
    val d = rememberDims()
    val hears = remember(band, Apps.trains.hears().joinToString()) { Apps.trains.hears() }
    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(14f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        if (band == TrainsProcessor.Band.EOT) {
            for ((name, mhz) in listOf("EOT" to "457.9375", "HOT" to "452.9375", "DPU" to "457.925")) {
                val on = name in hears
                val live = on && now - (activity[name] ?: 0L) < 1500
                Lamp("$name $mhz", if (live) accent else if (on) Palette.ok.copy(alpha = 0.7f) else Palette.muted)
            }
            if ("HOT" !in hears) Text("HOT needs a radio 6 MHz wide", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
        } else {
            Lamp("WAYSIDE 217", Palette.ok.copy(alpha = 0.7f)); Lamp("BASE 220", Palette.ok.copy(alpha = 0.7f)); Lamp("LOCO 221", Palette.ok.copy(alpha = 0.7f))
        }
    }
}

/**
 * The headline: a train nearby (a rear unit heard, a locomotive on PTC, or a head unit's command in the last two
 * minutes), moving or stopped; else PTC territory; else listening.
 */
@Composable
private fun TrainBanner(units: List<EotUnit>, stations: List<PtcStation>, hots: List<HotHeard>, now: Long, accent: Color) {
    val d = rememberDims()
    val recent = units.filter { now - it.lastMs < 120_000 }
    val loco = stations.filter { it.kind == PtcStation.Kind.LOCOMOTIVE && now - it.lastMs < 120_000 }
    val hot = hots.firstOrNull { now - it.ms < 120_000 }
    val train = recent.isNotEmpty() || loco.isNotEmpty() || hot != null
    val moving = recent.any { it.last.motion }
    val braking = recent.mapNotNull { brakeState(it) }.firstOrNull()
    val pulse by rememberInfiniteTransition(label = "train").animateFloat(1f, 0.55f, infiniteRepeatable(tween(650), RepeatMode.Reverse), label = "pulse")
    val shape = RoundedCornerShape(d.dp(14f))
    // a PTC locomotive or the brakes going on turn the banner red
    val c = when { braking != null -> Palette.danger; loco.isNotEmpty() -> Palette.danger; train -> accent; else -> Palette.muted }
    Row(Modifier.fillMaxWidth().clip(shape)
        .background(Brush.horizontalGradient(listOf(c.copy(alpha = if (train) 0.28f else 0.08f), Palette.panel)))
        .border(if (train) 2.dp else 1.dp, c.copy(alpha = if (train) 0.9f else 0.35f), shape).padding(horizontal = d.dp(12f), vertical = d.dp(9f)),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(12f))) {
        TrackScene(c, rolling = moving || (loco.isNotEmpty() && recent.isEmpty()), lit = train, Modifier.size(d.dp(76f), d.dp(34f)).alpha(if (train) pulse else 0.8f))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            val head = when {
                braking != null -> braking.first.substringBefore(" ·").let { if (it.startsWith("EMERGENCY")) "EMERGENCY BRAKING" else "TRAIN BRAKING" }
                train && moving -> "TRAIN NEARBY · MOVING"
                recent.isNotEmpty() -> "TRAIN NEARBY · STOPPED"
                loco.isNotEmpty() -> "PTC TRAIN APPROACHING"
                train -> "TRAIN NEARBY"
                stations.isNotEmpty() -> "PTC TERRITORY"
                else -> "LISTENING FOR TRAINS"
            }
            Text(head, color = if (train) c else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(16f), letterSpacing = 1.sp, maxLines = 1,
                overflow = TextOverflow.Ellipsis)
            val bits = ArrayList<String>()
            recent.firstOrNull()?.let { bits += "rear unit ${it.unit} · ${it.last.psig} psig" }
            if (loco.isNotEmpty()) bits += "${loco.size} locomotive${if (loco.size > 1) "s" else ""} on PTC"
            hot?.let { bits += "head unit command ${trainAgo(now - it.ms)}" }
            // a wayside's status changing is the signal and switch logic reacting to a train on its block
            stations.filter { it.kind == PtcStation.Kind.WAYSIDE && it.lastChangeMs > 0 && now - it.lastChangeMs < 120_000 }
                .maxByOrNull { it.lastChangeMs }?.let { bits += "wayside %.4f changed ${trainAgo(now - it.lastChangeMs)}".format(it.hz / 1e6) }
            if (bits.isEmpty()) {
                val base = stations.count { it.kind == PtcStation.Kind.BASE }; val way = stations.count { it.kind == PtcStation.Kind.WAYSIDE }
                bits += if (stations.isNotEmpty()) "$base base · $way wayside station${if (way == 1) "" else "s"} heard" else "end-of-train units and the PTC network"
            }
            Text(bits.joinToString(" · "), color = Palette.ink.copy(alpha = 0.85f), fontFamily = Mono, fontSize = d.sp(10f), maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A locomotive in outline, wheels turning while the train moves. */
@Composable
private fun TrainGlyph(c: Color, moving: Boolean, modifier: Modifier) {
    val spin by rememberInfiniteTransition(label = "wheels").animateFloat(0f, 360f, infiniteRepeatable(tween(900)), label = "spin")
    Canvas(modifier) {
        val w = size.width; val h = size.height; val s = 1.6.dp.toPx()
        drawRoundRect(c, Offset(w * 0.05f, h * 0.25f), Size(w * 0.7f, h * 0.45f), CornerRadius(3.dp.toPx()), style = Stroke(s))
        drawRoundRect(c, Offset(w * 0.55f, h * 0.05f), Size(w * 0.2f, h * 0.2f), CornerRadius(2.dp.toPx()), style = Stroke(s))
        val path = Path().apply { moveTo(w * 0.75f, h * 0.35f); lineTo(w * 0.95f, h * 0.5f); lineTo(w * 0.95f, h * 0.7f); lineTo(w * 0.75f, h * 0.7f) }
        drawPath(path, c, style = Stroke(s))
        drawLine(c, Offset(0f, h * 0.97f), Offset(w, h * 0.97f), s)
        for (x in floatArrayOf(0.2f, 0.42f, 0.66f)) {
            val cx = w * x; val cy = h * 0.8f; val r = h * 0.13f
            drawCircle(c, r, Offset(cx, cy), style = Stroke(s))
            val a = Math.toRadians((if (moving) spin else 0f).toDouble() + x * 120)
            drawLine(c, Offset(cx, cy), Offset(cx + r * cos(a).toFloat(), cy + r * sin(a).toFloat()), s)
        }
    }
}

private fun trainAgo(ms: Long): String = when {
    ms < 2_000 -> "now"
    ms < 60_000 -> "${ms / 1000} s ago"
    ms < 3_600_000 -> "${ms / 60_000} min ago"
    else -> "${ms / 3_600_000} h ago"
}

/** One rear unit: its id, a brake pipe gauge, what it says about the train, and its pressure over time. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EotCard(u: EotUnit, accent: Color, now: Long, selected: Boolean = false) {
    val d = rememberDims()
    val age = now - u.lastMs
    val flash = max(0f, 1 - age / 900f)
    val live = age < 120_000
    val shape = RoundedCornerShape(d.dp(14f))
    val p = u.last
    Column(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.75f).clip(shape)
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.10f + 0.16f * flash), Palette.panel)))
        .border(if (selected) 2.5.dp else (1 + 1.4f * flash).dp, accent.copy(alpha = if (selected) 1f else 0.25f + 0.7f * flash), shape).padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Column(Modifier.weight(1f)) {
                Text("${u.unit}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(24f))
                Text(if (u.channel == "DPU") "DISTRIBUTED POWER" else "END OF TRAIN", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold,
                    fontSize = d.sp(9f), letterSpacing = 2.sp)
                Text("${u.frames} report${if (u.frames == 1) "" else "s"} · first ${trainAgo(now - u.firstMs)}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
            }
            PsiGauge(p.psig, if (brakeState(u)?.second == Palette.danger) Palette.danger else accent, Modifier.size(d.dp(84f), d.dp(60f)))
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            brakeState(u)?.let { (t, col) -> TrainPill(t, col) }
            TrainPill(if (p.motion) "MOVING" else "STOPPED", if (p.motion) accent else Palette.muted)
            TrainPill(if (p.markerLight) "MARKER ON" else "MARKER OFF", if (p.markerLight) Palette.ok else Palette.muted)
            TrainPill("BATT ${p.batteryPct}%", if (p.batteryCond == "OK") Palette.ok else if (p.batteryCond == "NOT MONITORED") Palette.muted else Palette.danger)
            if (p.arm != "NORMAL") TrainPill(p.arm, Palette.danger)
            if (u.hotMs > 0 && now - u.hotMs < 600_000) TrainPill("HOT LINK", accent)
        }
        PressureSpark(u, accent, Modifier.fillMaxWidth().height(d.dp(34f)))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Box(Modifier.size(d.dp(8f)).background(if (live) Palette.ok else Palette.muted, CircleShape))
            Text(if (live) "LIVE · ${trainAgo(age)}" else trainAgo(age), color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold,
                fontSize = d.sp(9f), letterSpacing = 1.sp, modifier = Modifier.weight(1f))
            Text("battery ${p.batteryCond.lowercase()} · turbine ${if (p.turbine) "on" else "off"}${u.snr.lastOrNull()?.let { " · +$it dB" } ?: ""}",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun TrainPill(text: String, c: Color) {
    val d = rememberDims()
    Text(text, color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1,
        modifier = Modifier.clip(RoundedCornerShape(50)).border(1.dp, c.copy(alpha = 0.7f), RoundedCornerShape(50))
            .background(c.copy(alpha = 0.10f)).padding(horizontal = d.dp(7f), vertical = d.dp(2f)))
}

/** Brake pipe pressure, 0-127 psig, on an arc; a charged train line is about 90. */
@Composable
private fun PsiGauge(psig: Int, accent: Color, modifier: Modifier) {
    val d = rememberDims()
    val track = Palette.line; val ink = Palette.ink
    Box(modifier, contentAlignment = Alignment.BottomCenter) {
        Canvas(Modifier.fillMaxSize()) {
            val s = 5.dp.toPx(); val r = min(size.width / 2, size.height) - s
            val c = Offset(size.width / 2, size.height - s / 2)
            val tl = Offset(c.x - r, c.y - r); val sz = Size(2 * r, 2 * r)
            drawArc(track, 180f, 180f, false, tl, sz, style = Stroke(s, cap = StrokeCap.Round))
            val frac = (psig / 127f).coerceIn(0f, 1f)
            drawArc(accent, 180f, 180f * frac, false, tl, sz, style = Stroke(s, cap = StrokeCap.Round))
            // 90 psig, a charged line
            val a = PI + PI * 90 / 127
            drawLine(ink.copy(alpha = 0.5f), Offset(c.x + (r - s) * cos(a).toFloat(), c.y + (r - s) * sin(a).toFloat()),
                Offset(c.x + (r + s) * cos(a).toFloat(), c.y + (r + s) * sin(a).toFloat()), 1.dp.toPx())
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("$psig", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(17f))
            Text("PSIG", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
        }
    }
}

/** The rear unit's brake pipe pressure across its reports: a drop is the brakes going on. */
@Composable
private fun PressureSpark(u: EotUnit, accent: Color, modifier: Modifier) {
    val v = u.pressure
    Box(modifier) {
        if (v.size < 2) {
            Text("pressure history builds with each report", color = Palette.muted, fontFamily = Mono, fontSize = 9.sp, modifier = Modifier.align(Alignment.CenterStart))
            return@Box
        }
        Canvas(Modifier.fillMaxSize()) {
            val t0 = v.first().first; val t1 = max(v.last().first, t0 + 1)
            val lo = (v.minOf { it.second } - 4).toFloat(); val hi = (v.maxOf { it.second } + 4).toFloat()
            val pts = v.map { (t, p) -> Offset(size.width * (t - t0) / (t1 - t0), size.height - size.height * (p - lo) / max(hi - lo, 1f)) }
            val line = Path().apply { moveTo(pts[0].x, pts[0].y); for (q in pts.drop(1)) lineTo(q.x, q.y) }
            val fill = Path().apply { addPath(line); lineTo(size.width, size.height); lineTo(0f, size.height); close() }
            drawPath(fill, Brush.verticalGradient(listOf(accent.copy(alpha = 0.32f), accent.copy(alpha = 0.02f)), 0f, size.height))
            drawPath(line, accent, style = Stroke(1.5.dp.toPx()))
            for (q in pts) drawCircle(accent, 1.8.dp.toPx(), q)
        }
    }
}

/** One PTC station: where, what it is, how often it speaks, whether its message changes, and the last five minutes. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PtcCard(s: PtcStation, accent: Color, now: Long, selected: Boolean = false, listening: Boolean = true) {
    val d = rememberDims()
    val age = now - s.lastMs
    val flash = max(0f, 1 - age / 700f)
    val live = age < max(30_000.0, s.period() * 2500).toLong()
    val loco = s.kind == PtcStation.Kind.LOCOMOTIVE
    val c = if (loco) Palette.danger else accent
    val changedRecently = s.lastChangeMs > 0 && now - s.lastChangeMs < 60_000
    val shape = RoundedCornerShape(d.dp(14f))
    Column(Modifier.fillMaxWidth().alpha(if (live) 1f else 0.75f).clip(shape)
        .background(Brush.linearGradient(listOf(c.copy(alpha = 0.10f + 0.16f * flash), Palette.panel)))
        .border(if (changedRecently || selected) 2.5.dp else (1 + 1.4f * flash).dp, c.copy(alpha = if (changedRecently || selected) 1f else 0.25f + 0.7f * flash), shape)
        .padding(d.dp(11f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Column(Modifier.weight(1f)) {
                Text("%.4f".format(s.hz / 1e6), color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
                Text(s.kind.label, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp)
            }
            Column(horizontalAlignment = Alignment.End) {
                val per = s.period()
                Text(if (per > 0) "%.${if (per < 10) 2 else 1}f s".format(per) else if (s.bursts == 1) "HEARD ONCE" else "—", color = Palette.ink, fontFamily = Mono,
                    fontWeight = FontWeight.Bold, fontSize = d.sp(if (per > 0) 16f else 12f))
                Text(if (per > 0) "EVERY · ${s.bursts} BURSTS" else "${s.bursts} BURST${if (s.bursts == 1) "" else "S"}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(d.dp(5f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            when {
                changedRecently -> TrainPill("STATUS CHANGED ${trainAgo(now - s.lastChangeMs)}", Palette.danger)
                s.varies -> TrainPill("NEW CONTENT EVERY BURST", Palette.muted)
                s.steady >= 1 -> TrainPill("SAME STATUS ×${s.steady + 1}", Palette.ok)
                else -> TrainPill("LISTENING", Palette.muted)
            }
            if (s.changes > 0 && !changedRecently) TrainPill("${s.changes} CHANGE${if (s.changes > 1) "S" else ""}", accent)
            TrainPill("${s.lastSymbols} SYM", Palette.muted)
        }
        NextBurst(s, c, now, listening)
        BurstTimeline(s, c, now, Modifier.fillMaxWidth().height(d.dp(20f)))
        PtcFingerprint(s.print, c, Modifier.fillMaxWidth().height(d.dp(12f)))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Box(Modifier.size(d.dp(8f)).background(if (live) Palette.ok else Palette.muted, CircleShape))
            Text(if (live) "LIVE · ${trainAgo(age)}" else trainAgo(age), color = if (live) Palette.ok else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold,
                fontSize = d.sp(9f), letterSpacing = 1.sp, modifier = Modifier.weight(1f))
            Text("π/4-DQPSK 16 kbps${s.snr.lastOrNull()?.let { " · +$it dB" } ?: ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
        }
    }
}

/** Its bursts across the last five minutes, newest at the right. */
@Composable
private fun BurstTimeline(s: PtcStation, c: Color, now: Long, modifier: Modifier) {
    val back = Palette.paper; val grid = Palette.line
    Canvas(modifier) {
        val w = size.width; val h = size.height
        drawRoundRect(back.copy(alpha = 0.55f), cornerRadius = CornerRadius(5.dp.toPx()))
        for (m in 1 until 5) { val x = w * m / 5; drawLine(grid.copy(alpha = 0.4f), Offset(x, 2f), Offset(x, h - 2f), 0.5.dp.toPx()) }
        for (t in s.times) {
            val x = w * (1 - (now - t) / 300_000f)
            if (x < 0) continue
            val fresh = max(0f, 1 - (now - t) / 1500f)
            drawLine(c.copy(alpha = 0.55f + 0.45f * fresh), Offset(x, h * 0.18f), Offset(x, h * 0.82f), (1.4f + 2f * fresh).dp.toPx())
        }
    }
}

/** The first symbols of its last message as colored cells: the pattern holds while its status does. */
@Composable
private fun PtcFingerprint(print: IntArray, c: Color, modifier: Modifier) {
    Canvas(modifier) {
        if (print.isEmpty()) return@Canvas
        val n = print.size; val w = size.width / n
        val shades = floatArrayOf(0.18f, 0.42f, 0.66f, 0.95f)
        for ((i, v) in print.withIndex()) drawRect(c.copy(alpha = shades[v and 3]), Offset(i * w + 0.5f, 0f), Size(w - 1f, size.height))
    }
}

@Composable
private fun HotRow(h: HotHeard, accent: Color, now: Long) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth().panel().padding(horizontal = d.dp(10f), vertical = d.dp(7f)), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
        Text("HOT", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 2.sp)
        Column(Modifier.weight(1f)) {
            Text("command %08X".format(h.frame.data) + (h.unit?.let { " → unit $it" } ?: ""), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1)
            Text("sync %06X · ${h.frame.agree} of 3 copies agree${if (h.frame.parityOk) "" else " · parity?"} · +${h.snrDb} dB".format(h.frame.sync24),
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), maxLines = 1)
        }
        Text(trainAgo(now - h.ms), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f))
    }
}

/**
 * The PTC band, 216-222.5 MHz, as the network sees it: the wayside, base and locomotive sub-bands, and every station
 * heard as a mark at its frequency that flares on each burst. The waterfall at 8 MHz can't show a 20 ms burst; this can.
 */
@Composable
private fun BandStrip(stations: List<PtcStation>, now: Long, accent: Color, modifier: Modifier) {
    val d = rememberDims()
    val lo = 216.0; val hi = 222.5
    val back = Palette.paper; val line = Palette.line; val ok = Palette.ok; val danger = Palette.danger; val ink = Palette.ink; val muted = Palette.muted
    Column(modifier) {
        Canvas(Modifier.fillMaxWidth().weight(1f)) {
            val w = size.width; val h = size.height
            fun x(mhz: Double) = (w * (mhz - lo) / (hi - lo)).toFloat()
            drawRoundRect(back.copy(alpha = 0.6f), cornerRadius = CornerRadius(6.dp.toPx()))
            // the sub-bands: wayside, base, locomotive
            for ((a, b, c) in listOf(Triple(217.0, 220.0, ok), Triple(220.0, 221.0, accent), Triple(221.0, 222.0, danger))) {
                drawRect(c.copy(alpha = 0.10f), Offset(x(a), 0f), Size(x(b) - x(a), h))
                drawLine(c.copy(alpha = 0.5f), Offset(x(a), h - 1.5.dp.toPx()), Offset(x(b), h - 1.5.dp.toPx()), 2.dp.toPx())
            }
            for (m in 217..222) drawLine(line.copy(alpha = 0.5f), Offset(x(m.toDouble()), 0f), Offset(x(m.toDouble()), h), 0.5.dp.toPx())
            for (s in stations) {
                val c = when (s.kind) { PtcStation.Kind.LOCOMOTIVE -> danger; PtcStation.Kind.WAYSIDE -> ok; else -> accent }
                val fresh = max(0f, 1 - (now - s.lastMs) / 1200f)
                val px = x(s.hz / 1e6)
                if (fresh > 0) drawCircle(c.copy(alpha = 0.35f * fresh), (6 + 16 * (1 - fresh)).dp.toPx(), Offset(px, h * 0.45f))
                drawLine(c.copy(alpha = 0.55f + 0.45f * fresh), Offset(px, h * 0.12f), Offset(px, h * 0.82f), (2f + 2.5f * fresh).dp.toPx(), cap = StrokeCap.Round)
            }
        }
        // each MHz label centered under its own line
        androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().height(d.dp(12f))) {
            for (m in 217..222) {
                val fx = ((m - lo) / (hi - lo)).toFloat()
                Text("$m", color = ink.copy(alpha = 0.7f), fontFamily = Mono, fontSize = d.sp(8f),
                    modifier = Modifier.offset(x = maxWidth * fx - d.dp(8f)))
            }
        }
    }
}

/**
 * A locomotive on its rails: the ties stream past while the train rolls, the wheels turn, and the headlight beam
 * sweeps ahead of it.
 */
@Composable
private fun TrackScene(c: Color, rolling: Boolean, lit: Boolean, modifier: Modifier) {
    val t = rememberInfiniteTransition(label = "track")
    val run by t.animateFloat(0f, 1f, infiniteRepeatable(tween(700, easing = LinearEasing)), label = "run")
    val beam by t.animateFloat(0.3f, 1f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "beam")
    Canvas(modifier) {
        val w = size.width; val h = size.height; val s = 1.6.dp.toPx()
        // rails and ties
        val railY = h * 0.94f
        drawLine(c.copy(alpha = 0.8f), Offset(0f, railY), Offset(w, railY), s)
        val gap = w / 9
        val shift = if (rolling) run * gap else 0f
        var x = -gap + (gap - shift)
        while (x < w + gap) { drawLine(c.copy(alpha = 0.45f), Offset(x, railY - 2.dp.toPx()), Offset(x - gap * 0.25f, h), 1.2.dp.toPx()); x += gap }
        // the locomotive, nose to the right
        val bw = w * 0.62f; val bx = w * 0.06f; val by = h * 0.28f; val bh = h * 0.42f
        drawRoundRect(c.copy(alpha = 0.18f), Offset(bx, by), Size(bw, bh), CornerRadius(3.dp.toPx()))
        drawRoundRect(c, Offset(bx, by), Size(bw, bh), CornerRadius(3.dp.toPx()), style = Stroke(s))
        drawRoundRect(c, Offset(bx + bw * 0.62f, h * 0.06f), Size(bw * 0.3f, h * 0.22f), CornerRadius(2.dp.toPx()), style = Stroke(s))
        val nose = Path().apply { moveTo(bx + bw, by + bh * 0.2f); lineTo(bx + bw + w * 0.1f, by + bh * 0.55f); lineTo(bx + bw + w * 0.1f, by + bh); lineTo(bx + bw, by + bh) }
        drawPath(nose, c, style = Stroke(s))
        // headlight and its beam
        val hx = bx + bw + w * 0.1f; val hy = by + bh * 0.62f
        drawCircle(c, 2.4.dp.toPx(), Offset(hx, hy))
        if (lit) {
            val cone = Path().apply { moveTo(hx, hy); lineTo(w, hy - h * 0.28f); lineTo(w, hy + h * 0.22f); close() }
            drawPath(cone, Brush.horizontalGradient(listOf(c.copy(alpha = 0.45f * beam), c.copy(alpha = 0f)), hx, w))
        }
        // wheels, turning while it rolls
        for (k in 0 until 3) {
            val cx = bx + bw * (0.18f + 0.32f * k); val cy = h * 0.8f; val r = h * 0.12f
            drawCircle(c, r, Offset(cx, cy), style = Stroke(s))
            val a = 2 * Math.PI * (if (rolling) run else 0f) + k
            drawLine(c, Offset(cx, cy), Offset(cx + r * cos(a).toFloat(), cy + r * sin(a).toFloat()), s)
        }
    }
}

/**
 * What the rear unit's brake pipe says: a drop from where it was charged is a brake application, the line vented
 * near zero is an emergency, and pressure coming back is the release.
 */
internal fun brakeState(u: EotUnit): Pair<String, Color>? {
    val p = u.last.psig
    val recent = u.pressure.filter { u.lastMs - it.first < 600_000 }
    val peak = recent.maxOfOrNull { it.second } ?: p
    val prev = if (u.pressure.size >= 2) u.pressure[u.pressure.size - 2].second else p
    return when {
        p < 15 && peak >= 40 -> "EMERGENCY · LINE VENTED" to Palette.danger
        peak - p >= 6 && p <= prev -> "BRAKES APPLIED −${peak - p} PSI" to Palette.danger
        p - prev >= 3 -> "RELEASING +${p - prev} PSI" to Palette.ok
        else -> null
    }
}

/** How far along the station is toward its next burst, from its own period: a bar that fills, and the seconds left. */
@Composable
private fun NextBurst(s: PtcStation, c: Color, now: Long, listening: Boolean) {
    val d = rememberDims()
    val per = s.period()
    if (per <= 0) return
    // BOTH has the radio on the EOT channels for a while: nothing is late, it just isn't being heard
    if (!listening) {
        Text("ON EOT · BACK SOON", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp)
        return
    }
    val el = (now - s.lastMs) / 1000.0
    val late = el > per * 1.3
    val frac = (el / per).coerceIn(0.0, 1.0).toFloat()
    val track = Palette.line
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        Canvas(Modifier.weight(1f).height(d.dp(6f))) {
            drawRoundRect(track.copy(alpha = 0.6f), cornerRadius = CornerRadius(size.height / 2))
            drawRoundRect(if (late) Palette.danger.copy(alpha = 0.7f) else c, size = Size(size.width * frac, size.height), cornerRadius = CornerRadius(size.height / 2))
        }
        Text(if (late) "OVERDUE %.0f s".format(el - per) else "NEXT IN %.1f s".format(per - el), color = if (late) Palette.danger else Palette.ink,
            fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1)
    }
}

private fun clock(ms: Long): String = java.text.DateFormat.getTimeInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(ms))

/** Every field the rear unit's frame carries, and what the receiver made of it. */
private fun eotFields(u: EotUnit, now: Long): List<Pair<String, String>> {
    val p = u.last
    val lo = u.pressure.minOfOrNull { it.second } ?: p.psig; val hi = u.pressure.maxOfOrNull { it.second } ?: p.psig
    return listOf(
        "UNIT ID" to "${p.unit}  (0x%05X)".format(p.unit),
        "CHANNEL" to if (u.channel == "DPU") "DPU 457.925 MHz" else "EOT 457.9375 MHz",
        "BRAKE PIPE" to "${p.psig} psig",
        "RANGE HEARD" to "$lo – $hi psig over ${u.pressure.size} reports",
        "BRAKES" to (brakeState(u)?.first ?: "released / steady"),
        "MOTION" to if (p.motion) "moving" else "stopped",
        "MARKER LIGHT" to if (p.markerLight) "on" else "off",
        "MARKER BATTERY" to if (p.markerBattery) "ok" else "weak",
        "BATTERY" to "${p.batteryPct}% · ${p.batteryCond.lowercase()}",
        "AIR TURBINE" to if (p.turbine) "generating" else "off",
        "VALVE CIRCUIT" to if (p.valve) "1 (ready)" else "0",
        "ARM STATUS" to p.arm.lowercase(),
        "MESSAGE TYPE" to "%d (%s)".format(p.type, Integer.toBinaryString(p.type).padStart(3, '0')),
        "CONFIRM BIT" to if (p.confirm) "1" else "0",
        "HEAD UNIT LINK" to if (u.hotMs > 0) "command heard ${trainAgo(now - u.hotMs)}" else "none heard",
        "REPORTS" to "${u.frames}",
        "FIRST HEARD" to clock(u.firstMs),
        "LAST HEARD" to "${clock(u.lastMs)} · ${trainAgo(now - u.lastMs)}",
        "SIGNAL" to (u.snr.lastOrNull()?.let { "+$it dB (best +${u.snr.max()} dB)" } ?: "—"),
        "CHECK" to "BCH(63,45) passed",
        "FRAME" to p.bits.chunked(4).joinToString("") { Integer.parseInt(it.padEnd(4, '0'), 2).toString(16).uppercase() },
    )
}

/** Everything that can be read off a PTC station without the network's keys. */
private fun ptcFields(s: PtcStation, now: Long): List<Pair<String, String>> {
    val per = s.period()
    return listOf(
        "FREQUENCY" to "%.4f MHz".format(s.hz / 1e6),
        "ROLE" to when (s.kind) {
            PtcStation.Kind.WAYSIDE -> "wayside interface unit (217–220 MHz): signals and switches on its block"
            PtcStation.Kind.BASE -> "base station (220–221 MHz): the network's beacon"
            PtcStation.Kind.LOCOMOTIVE -> "locomotive (221–222 MHz): a PTC train in range"
            PtcStation.Kind.OTHER -> "PTC, outside the usual sub-bands"
        },
        "PERIOD" to if (per > 0) "%.2f s (%s)".format(per, s.gaps.takeLast(4).joinToString(" · ") { "%.1f".format(it) }) else "—",
        "BURSTS" to "${s.bursts}",
        "MESSAGE LENGTHS" to s.lengths.joinToString(" · ") { "$it sym" },
        "CONTENT" to when { s.varies -> "new every burst (a running counter or time)"; s.steady >= 1 -> "same ×${s.steady + 1}"; else -> "—" },
        "STATUS CHANGES" to if (s.changes > 0) "${s.changes} · last ${trainAgo(now - s.lastChangeMs)}" else "none",
        "STATION HEADER" to s.header,
        "CARRIER" to "%+.0f Hz off channel (its own crystal)".format(s.carrierHz),
        "SIGNAL" to "+${s.snr.lastOrNull() ?: 0} dB (best +${s.snrMax} dB)",
        "FIRST HEARD" to clock(s.firstMs),
        "LAST HEARD" to "${clock(s.lastMs)} · ${trainAgo(now - s.lastMs)}",
        "MODULATION" to "π/4-DQPSK · 8000 sym/s · 16 kbps · 25 kHz",
        "SYNC" to "9-symbol preamble + shared 30-symbol word",
        "MESSAGE" to PtcScanner.symHex(s.last),
    )
}

/**
 * A card's full decode, field by field, over the cards (Trains and Devices). [history], when there is one, follows
 * the fields: when, and what was heard then, newest first. Every field shows at once: the panel is as tall as its
 * fields, up to the space over the cards, and only past that does the whole panel scroll.
 */
@Composable
internal fun FieldDetail(fields: List<Pair<String, String>>, title: String, kind: String, accent: Color, modifier: Modifier,
                         history: List<Pair<String, String>> = emptyList(), onClose: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(14f))
    val scroll = rememberScrollState()
    Column(modifier.fillMaxWidth().clip(shape).background(Palette.panel.copy(alpha = 0.95f))
        .background(Brush.linearGradient(listOf(accent.copy(alpha = 0.16f), Palette.panel)))
        .border(1.5.dp, accent.copy(alpha = 0.8f), shape).scrollGlow(scroll).verticalScroll(scroll).padding(d.dp(11f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Text(title, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(22f))
            Text(kind, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 2.sp, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            ToggleBox("✕", false, accent, Modifier.fillMaxHeight()) { onClose() }
        }
        SelectionContainer {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                FieldGrid(fields, labelWidth = 112f, minColumn = 320f)
                if (history.isNotEmpty()) {
                    Text("EVERY TIME IT WAS HEARD", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp,
                        modifier = Modifier.padding(top = d.dp(4f)))
                    for ((t, v) in history) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                        Text(t, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), modifier = Modifier.width(d.dp(112f)))
                        Text(v, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
                    }
                }
            }
        }
    }
}

/**
 * Name/value rows in as many columns as the width holds (each at least [minColumn] wide), filled row by row like
 * the web's field grid: a phone gets one column, a tablet or a full-screen panel two or more.
 */
@Composable
internal fun FieldGrid(fields: List<Pair<String, String>>, labelWidth: Float, minColumn: Float) {
    val d = rememberDims()
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val gap = d.dp(10f)
        val cols = ((maxWidth + gap) / (d.dp(minColumn) + gap)).toInt().coerceAtLeast(1)
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            for (row in fields.chunked(cols)) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap)) {
                for (i in 0 until cols) {
                    val f = row.getOrNull(i)
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                        if (f != null) {
                            Text(f.first, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 1.sp,
                                modifier = Modifier.width(d.dp(labelWidth)))
                            Text(f.second, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
                        }
                    }
                }
            }
        }
    }
}
