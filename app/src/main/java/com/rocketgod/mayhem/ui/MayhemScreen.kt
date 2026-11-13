package com.rocketgod.mayhem.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Constraints
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.roundToInt
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.displayCutoutPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.NavBar
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine

/** The diagnostics log window: opened from Settings › Log, closed from its own ✕. */
object LogUi { var open by mutableStateOf(false) }

/** The driver's last word and whether a radio is up, for Settings' radio card (the header that showed them is gone). */
object RadioStatus { var text by mutableStateOf(""); var connected by mutableStateOf(false) }

/**
 * Root: a short action bar on top (HOME · FAVES · MUTE · SETTINGS), the open app or Home, and your apps in a
 * full-width scroller along the bottom where the thumb is. The lit app is where you are. Back goes Home from an app,
 * back to the app from Settings, and out of Mayhem from Home.
 */
@Composable
fun MayhemScreen(status: String, connected: Boolean) {
    val accent = Palette.accent
    val d = rememberDims()
    val current by Apps.current.collectAsState()
    var faves by remember { mutableStateOf(false) }
    SideEffect { RadioStatus.text = status; RadioStatus.connected = connected }
    BackHandler(enabled = current != null) { Apps.back() }
    // registered after, so it wins: back closes the RADIO panel before it leaves the app under it
    BackHandler(enabled = RadioUi.open) { RadioUi.open = false }
    // every screen, Home included, is a live receiver: none of them may dim and lock mid-listen
    val view = LocalView.current
    DisposableEffect(Unit) { view.keepScreenOn = true; onDispose { view.keepScreenOn = false } }
    val inPip by Pip.active.collectAsState()
    if (inPip) { PipView(Apps.playing(), accent); return }
    Box(Modifier.fillMaxSize().background(Palette.paper)) {
        Column(Modifier.fillMaxSize().statusBarsPadding().displayCutoutPadding().navigationBarsPadding()) {
            TopBar(current, connected, accent, favesOpen = faves) { faves = true }
            if (!connected) RadioMissing(status)
            // a little air under the bar: the readout's top chevrons sat right against it
            Box(Modifier.weight(1f).fillMaxWidth().padding(start = d.pad, end = d.pad, top = d.dp(if (d.cls != ScreenClass.COMPACT) 6f else 10f))) {
                when (current) {
                    null -> Launcher(accent)
                    MayhemApp.HAM -> HamScreen(accent)
                    MayhemApp.AUDIO -> AudioScreen(accent)
                    MayhemApp.DEVICES -> DevicesScreen(accent)
                    MayhemApp.SAT -> SatScreen(accent)
                    MayhemApp.ADSB -> AdsbScreen(accent)
                    MayhemApp.AIS -> AisScreen(accent)
                    MayhemApp.APRS -> AprsScreen(accent)
                    MayhemApp.PAGER -> PagerScreen(accent)
                    MayhemApp.ERT -> MetersScreen(accent)
                    MayhemApp.LORA -> LoraScreen(accent)
                    MayhemApp.BTLE -> BtleScreen(accent)
                    MayhemApp.ACARS -> AcarsScreen(accent)
                    MayhemApp.TRAINS -> TrainsScreen(accent)
                    MayhemApp.PROWL -> ProwlScreen(accent)
                    MayhemApp.LOOKING_GLASS -> LookingGlassScreen(accent)
                    MayhemApp.SEARCH -> SearchScreen(accent)
                    MayhemApp.ANALYZER -> AnalyzerScreen(accent)
                    MayhemApp.SPECTRUM -> SpectrumScreen(accent)
                    MayhemApp.CAPTURE -> CaptureScreen(accent)
                    MayhemApp.TRANSMIT -> TxScreen(accent)
                    MayhemApp.TROLL -> TrollScreen(accent)
                    MayhemApp.SETTINGS -> SettingsScreen(accent)
                }
                // over the app, which keeps running and receiving underneath
                if (RadioUi.open) RadioPanel()
            }
            AppScroller(current)
        }
        NoticeBar(Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = d.dp(58f)))
        if (faves) FavesSheet(accent) { faves = false }
        if (LogUi.open) LogWindow(onClose = { LogUi.open = false })
        UpdateDialog()
    }
}

/** What an app is called in the bar: short enough that four or five fit across a phone. */
internal fun barLabel(app: MayhemApp): String = when (app) {
    MayhemApp.LOOKING_GLASS -> "GLASS"
    MayhemApp.SAT -> "SATS"
    MayhemApp.BTLE -> "BLE"
    MayhemApp.TRANSMIT -> "TX"
    else -> app.title.uppercase()
}

/** No radio: one quiet line above the bar, in place of the status the header used to carry. */
@Composable
private fun RadioMissing(status: String) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth().background(Palette.danger.copy(alpha = 0.12f)).padding(horizontal = d.pad, vertical = d.dp(6f)),
        verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).background(Palette.danger, CircleShape))
        Spacer(Modifier.width(d.dp(8f)))
        Text(status.ifBlank { "No radio · plug in a HackRF or an RTL-SDR over USB-OTG" }, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f),
            maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** HOME · FAVES · MUTE · RADIO · SETTINGS, icon and word on one line: everything here works from any screen. */
@Composable
private fun TopBar(current: MayhemApp?, connected: Boolean, accent: Color, favesOpen: Boolean, onFaves: () -> Unit) {
    val d = rememberDims()
    val muted by SdrEngine.muted.collectAsState()
    val onSettings = current == MayhemApp.SETTINGS
    val radioOpen = RadioUi.open
    // a longer word gets a wider button, so SETTINGS fits beside four short ones on a phone
    fun w(label: String) = maxOf(1f, label.length / 5f)
    // tablets: a slimmer bar than the phone's, so the screen below starts higher
    val slim = d.cls != ScreenClass.COMPACT
    Column(Modifier.fillMaxWidth().background(Palette.surface)) {
        Box(Modifier.fillMaxWidth().height(2.dp).background(accent))
        Row(Modifier.fillMaxWidth().height(d.dp(if (slim) 32f else 44f)).padding(horizontal = d.dp(8f)), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            TopButton(AppsIcon, "HOME", on = current == null && !radioOpen, accent = accent, modifier = Modifier.weight(w("HOME"))) {
                RadioUi.open = false; if (current != null) Apps.home()
            }
            TopButton(StarIcon, "FAVES", on = favesOpen, accent = accent, modifier = Modifier.weight(w("FAVES"))) { onFaves() }
            TopButton(if (muted) SpeakerOffIcon else SpeakerIcon, if (muted) "MUTED" else "MUTE", on = false, accent = accent,
                warn = muted, modifier = Modifier.weight(w("MUTED"))) { SdrEngine.toggleMute() }
            // red while the panel is open, as the panel itself is
            TopButton(TuneIcon, "RADIO", on = radioOpen, accent = Palette.danger, labelTint = Palette.danger, modifier = Modifier.weight(w("RADIO"))) {
                if (radioOpen) RadioUi.open = false else RadioUi.show()
            }
            Box(Modifier.weight(w("SETTINGS"))) {
                TopButton(GearIcon, "SETTINGS", on = onSettings && !radioOpen, accent = accent, modifier = Modifier.fillMaxWidth()) {
                    RadioUi.open = false
                    if (onSettings) Apps.back() else Apps.open(MayhemApp.SETTINGS)
                }
                Box(Modifier.align(Alignment.TopEnd).padding(top = 6.dp, end = 6.dp).size(6.dp).background(if (connected) Palette.ok else Palette.danger, CircleShape))
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.line))
    }
}

@Composable
private fun TopButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, on: Boolean, accent: Color, modifier: Modifier,
                      warn: Boolean = false, labelTint: Color? = null, onClick: () -> Unit) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    val c = if (warn) Palette.danger else if (on) accent else Palette.ink
    Row(
        modifier.height(d.dp(if (d.cls != ScreenClass.COMPACT) 27f else 34f)).clip(RoundedCornerShape(8.dp)).background(if (on) Palette.panel else Color.Transparent)
            .clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() },
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(icon, contentDescription = null, tint = c, modifier = Modifier.size(d.dp(18f)))
        Spacer(Modifier.width(d.dp(6f)))
        Text(label, color = if (warn) Palette.danger else if (on) labelTint ?: Palette.ink else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold,
            fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 1, softWrap = false)
    }
}

/**
 * The apps ticked in Settings › Bar, in their order, along the bottom, drawn as a tool strip: a ⚙ square at the left
 * (which apps the bar shows, Settings › Bar), then one short uppercase key per app in a hairline pill. Each key is
 * faintly lit in its own tint; the open app (or the one Settings is open over) wears a glowing fill that slides
 * between keys. When the keys outgrow the row they scroll sideways with the open one kept centered and the edges glow
 * (as every scroller here does); when they fit they stretch to fill the pill. On Home nothing is lit.
 */
@Composable
private fun AppScroller(current: MayhemApp?) {
    val d = rememberDims()
    val bar by NavBar.bar.collectAsState()
    Radio.kind.collectAsState().value
    var asking by remember { mutableStateOf<MayhemApp?>(null) }
    asking?.let { app -> NeedsHackRfDialog(app) { asking = null } }
    val onSettings = current == MayhemApp.SETTINGS
    val lit = if (onSettings) Apps.settingsOver() else current
    Row(Modifier.fillMaxWidth().background(Palette.paper).height(StripGeo.band).padding(horizontal = d.pad),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StripGear { SettingsNav.open("bar") }
        StripSegments(bar, lit, Modifier.weight(1f)) { app ->
            RadioUi.open = false
            when {
                current == app -> {}
                // the app Settings is open over: just close Settings, don't start it again
                onSettings && Apps.settingsOver() == app -> Apps.back()
                Radio.blockedBecause(app).isNotEmpty() -> asking = app
                else -> Apps.open(app)
            }
        }
    }
}

/** The strip's measurements: the touch band, the visible pill and ⚙ square inside it, and the keys. */
private object StripGeo {
    val band = 44.dp
    val pill = 36.dp
    val inset = 3.dp
    val gap = 4.dp
    val segMin = 48.dp
    val segPad = 14.dp
    val corner = 8.dp
}

/** Shrinks a little while held, as a key does. */
@Composable
private fun pressScale(source: MutableInteractionSource, to: Float): Float {
    val pressed by source.collectIsPressedAsState()
    return animateFloatAsState(if (pressed) to else 1f, tween(120), label = "press").value
}

@Composable
private fun StripGear(onClick: () -> Unit) {
    val haptic = LocalHapticFeedback.current
    val src = remember { MutableInteractionSource() }
    val k = pressScale(src, 0.92f)
    val shape = RoundedCornerShape(StripGeo.corner)
    Box(Modifier.size(StripGeo.pill, StripGeo.band).semantics { contentDescription = "Choose apps"; role = Role.Button }
        .clickable(src, indication = null) { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() },
        contentAlignment = Alignment.Center) {
        Box(Modifier.size(StripGeo.pill).graphicsLayer { scaleX = k; scaleY = k }.clip(shape).background(Palette.surface)
            .border(1.dp, Palette.line, shape), contentAlignment = Alignment.Center) {
            Icon(GearIcon, contentDescription = null, tint = Palette.accent, modifier = Modifier.size(20.dp))
        }
    }
}

/** Where each key sits along the row (px), written as the row is measured and read by the fill and the scroll. */
private class KeySpots { var x = IntArray(0); var w = IntArray(0) }

@Composable
private fun StripSegments(apps: List<MayhemApp>, selected: MayhemApp?, modifier: Modifier, onPick: (MayhemApp) -> Unit) {
    val pill = RoundedCornerShape(StripGeo.corner)
    BoxWithConstraints(modifier.height(StripGeo.pill).clip(pill).background(Palette.surface).border(1.dp, Palette.line, pill)) {
        val density = LocalDensity.current
        val viewport = constraints.maxWidth
        val scroll = rememberScrollState()
        val spots = remember { KeySpots() }
        var rowW by remember { mutableIntStateOf(0) }
        val idx = apps.indexOf(selected)
        val fillX = remember { Animatable(0f) }
        val fillW = remember { Animatable(0f) }
        var fillOn by remember { mutableStateOf(false) }
        val tint by animateColorAsState(if (selected != null) tintFor(selected) else Palette.accent, tween(240), label = "fill")
        // the fill springs to the open key and the row scrolls it to the middle; from Home it appears in place
        LaunchedEffect(idx, apps, rowW, viewport) {
            if (idx < 0 || idx >= spots.x.size) { fillOn = false; return@LaunchedEffect }
            val x = spots.x[idx].toFloat(); val w = spots.w[idx].toFloat()
            val target = (x + w / 2 - viewport / 2f).roundToInt().coerceIn(0, max(0, rowW - viewport))
            launch { scroll.animateScrollTo(target, tween(320)) }
            if (!fillOn) { fillX.snapTo(x); fillW.snapTo(w); fillOn = true }
            else {
                val sp = spring<Float>(dampingRatio = 0.82f, stiffness = 300f)
                launch { fillW.animateTo(w, sp) }
                fillX.animateTo(x, sp)
            }
        }
        Box(Modifier.fillMaxSize().scrollGlow(scroll, horizontal = true).horizontalScroll(scroll)) {
            val inset = with(density) { (StripGeo.inset + 1.dp).roundToPx() }
            val gap = with(density) { StripGeo.gap.roundToPx() }
            val segMin = with(density) { StripGeo.segMin.roundToPx() }
            Layout(
                content = {
                    for (app in apps) StripSeg(app, barLabel(app), active = app == selected, tint = tintFor(app),
                        dim = Radio.blockedBecause(app).isNotEmpty()) { onPick(app) }
                },
                modifier = Modifier.fillMaxHeight().onSizeChanged { rowW = it.width }.drawBehind {
                    if (!fillOn || selected == null) return@drawBehind
                    // the open key: filled with its tint, glowing softly
                    val r = (StripGeo.corner - StripGeo.inset).toPx()
                    val top = inset.toFloat(); val hh = size.height - 2 * inset
                    for (k in 3 downTo 1) {
                        val g = k * 2.dp.toPx()
                        drawRoundRect(tint.copy(alpha = 0.12f), Offset(fillX.value - g, top - g), Size(fillW.value + 2 * g, hh + 2 * g), CornerRadius(r + g))
                    }
                    drawRoundRect(tint, Offset(fillX.value, top), Size(fillW.value, hh), CornerRadius(r))
                },
            ) { ms, c ->
                val h = max(0, c.maxHeight - 2 * inset)
                val natural = IntArray(ms.size) { max(segMin, ms[it].maxIntrinsicWidth(h)) }
                // keys that fit stretch to fill the pill: an equal share each, any wider key keeping its own width
                val room = viewport - 2 * inset - gap * max(0, ms.size - 1)
                val widths = natural.copyOf()
                if (ms.isNotEmpty() && natural.sum() < room) {
                    val wide = BooleanArray(ms.size)
                    while (true) {
                        val free = ms.indices.filter { !wide[it] }
                        if (free.isEmpty()) break
                        val share = (room - ms.indices.filter { wide[it] }.sumOf { natural[it] }) / free.size
                        val over = free.filter { natural[it] > share }
                        if (over.isEmpty()) { free.forEach { widths[it] = share }; break }
                        over.forEach { wide[it] = true }
                    }
                }
                val ps = ms.mapIndexed { i, m -> m.measure(Constraints.fixed(widths[i], h)) }
                val xs = IntArray(ps.size); var x = inset
                for (i in ps.indices) { xs[i] = x; x += widths[i] + if (i < ps.size - 1) gap else 0 }
                spots.x = xs; spots.w = widths
                layout(max(x + inset, viewport), c.maxHeight) { ps.forEachIndexed { i, p -> p.place(xs[i], inset) } }
            }
        }
    }
}

/** One key: a single-line uppercase label on a faintly lit key of its own tint, ink-on-tint while open. */
@Composable
private fun StripSeg(app: MayhemApp, label: String, active: Boolean, tint: Color, dim: Boolean, onClick: () -> Unit) {
    val haptic = LocalHapticFeedback.current
    val src = remember { MutableInteractionSource() }
    val k = pressScale(src, 0.94f)
    val key = RoundedCornerShape(StripGeo.corner - StripGeo.inset)
    Box(Modifier.graphicsLayer { scaleX = k; scaleY = k; alpha = if (dim && !active) 0.45f else 1f }
        .semantics { role = Role.Button; selected = active }
        // every key: a breath of its tint and a hairline, so the strip reads as controls, not a list
        .clip(key).background(tint.copy(alpha = 0.07f)).border(1.dp, tint.copy(alpha = 0.22f), key)
        .clickable(src, indication = null) { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }
        .padding(horizontal = StripGeo.segPad), contentAlignment = Alignment.Center) {
        // the app's own glyph (the Home tile's) beside its name, so the strip reads at a glance
        Row(verticalAlignment = Alignment.CenterVertically) {
            AppGlyph(app, if (active) inkOn(tint) else tint, Modifier.size(15.dp))
            Spacer(Modifier.width(6.dp))
            Text(label, color = if (active) inkOn(tint) else Palette.ink.copy(alpha = 0.82f), fontFamily = Mono, fontWeight = FontWeight.Bold,
                fontSize = 13.sp, letterSpacing = 1.sp, maxLines = 1, softWrap = false)
        }
    }
}

/** FAVES: the frequencies starred with ☆ beside the digits. A tap brings one back in its own app, as it was heard. */
@Composable
private fun FavesSheet(accent: Color, onClose: () -> Unit) {
    val d = rememberDims()
    val list by com.rocketgod.mayhem.core.Bookmarks.list.collectAsState()
    androidx.compose.ui.window.Dialog(onDismissRequest = onClose) {
        Column(Modifier.fillMaxWidth().heightIn(max = (d.heightDp * 0.75f).dp).clip(RoundedCornerShape(14.dp)).background(Palette.surface)
            .border(1.dp, Palette.line, RoundedCornerShape(14.dp)).padding(d.dp(14f))) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(StarIcon, contentDescription = null, tint = accent, modifier = Modifier.size(d.dp(18f)))
                Spacer(Modifier.width(d.dp(8f)))
                Text("FAVES", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f), letterSpacing = 3.sp, modifier = Modifier.weight(1f))
                ToggleBox("DONE", false, accent) { onClose() }
            }
            Spacer(Modifier.height(d.dp(10f)))
            if (list.isEmpty()) Text("Nothing saved yet. Tap ☆ beside the frequency in any app to keep it here.",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), lineHeight = d.sp(16f))
            else Column(Modifier.verticalScroll(rememberScrollState()).clip(RoundedCornerShape(10.dp)).border(1.dp, Palette.line, RoundedCornerShape(10.dp))) {
                list.forEachIndexed { i, b ->
                    if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.line))
                    val app = b.app?.let { n -> MayhemApp.byName(n) }
                    Row(Modifier.fillMaxWidth().clickable { onClose(); com.rocketgod.mayhem.core.Bookmarks.open(b) }.heightIn(min = d.dp(52f))
                        .padding(start = d.dp(12f), end = d.dp(4f)), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("%.4f MHz".format(b.hz / 1e6), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f))
                            Text(listOfNotNull(b.name.takeIf { it.isNotBlank() && it != b.mode.name }, app?.title, b.mode.name).joinToString(" · "),
                                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Box(Modifier.size(d.dp(44f)).clickable { com.rocketgod.mayhem.core.Bookmarks.remove(b) }, contentAlignment = Alignment.Center) {
                            Text("✕", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(14f))
                        }
                    }
                }
            }
        }
    }
}
