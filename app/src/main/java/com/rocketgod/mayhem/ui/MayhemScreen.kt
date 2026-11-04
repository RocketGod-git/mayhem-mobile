package com.rocketgod.mayhem.ui

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
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

/** The diagnostics log window: opened from Settings › Log, closed from its own ✕. */
object LogUi { var open by mutableStateOf(false) }

/** The driver's last word and whether a radio is up, for Settings' radio card (the header that showed them is gone). */
object RadioStatus { var text by mutableStateOf(""); var connected by mutableStateOf(false) }

/**
 * Root: the open app or Home, and under it one bar — HOME and your apps in a strip that scrolls sideways, and
 * Settings on its own at the right. There is no header: the lit segment says where you are. Back goes Home from an
 * app, back to the app from Settings, and out of Mayhem from Home.
 */
@Composable
fun MayhemScreen(status: String, connected: Boolean) {
    val accent = Palette.accent
    val d = rememberDims()
    val current by Apps.current.collectAsState()
    SideEffect { RadioStatus.text = status; RadioStatus.connected = connected }
    BackHandler(enabled = current != null) { Apps.back() }
    // every screen, Home included, is a live receiver: none of them may dim and lock mid-listen
    val view = LocalView.current
    DisposableEffect(Unit) { view.keepScreenOn = true; onDispose { view.keepScreenOn = false } }
    val inPip by Pip.active.collectAsState()
    if (inPip) { PipView(Apps.playing(), accent); return }
    Box(Modifier.fillMaxSize().background(Palette.paper)) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
            // a little air at the top: the readout's top chevrons sat right against the edge
            Box(Modifier.weight(1f).fillMaxWidth().padding(start = d.pad, end = d.pad, top = d.dp(10f))) {
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
                    MayhemApp.ERT -> ErtScreen(accent)
                    MayhemApp.BTLE -> BtleScreen(accent)
                    MayhemApp.TPMS -> TpmsScreen(accent)
                    MayhemApp.ACARS -> AcarsScreen(accent)
                    MayhemApp.SUBGHZ -> SubGhzScreen(accent)
                    MayhemApp.PROWL -> ProwlScreen(accent)
                    MayhemApp.LOOKING_GLASS -> LookingGlassScreen(accent)
                    MayhemApp.SEARCH -> SearchScreen(accent)
                    MayhemApp.CAPTURE -> CaptureScreen(accent)
                    MayhemApp.TRANSMIT -> TxScreen(accent)
                    MayhemApp.TROLL -> TrollScreen(accent)
                    MayhemApp.SETTINGS -> SettingsScreen(accent)
                }
            }
            if (!connected) RadioMissing(status)
            BottomBar(current, connected, accent)
        }
        NoticeBar(Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = d.dp(62f)))
        if (LogUi.open) LogWindow(onClose = { LogUi.open = false })
        UpdateDialog()
    }
}

/** What an app is called in the bar: short enough that four or five fit across a phone. */
internal fun barLabel(app: MayhemApp): String = when (app) {
    MayhemApp.LOOKING_GLASS -> "GLASS"
    MayhemApp.SAT -> "SATS"
    MayhemApp.SUBGHZ -> "SUB-GHZ"
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

/**
 * HOME and the apps ticked in Settings › Bar, in their order, as one strip that scrolls sideways and keeps the open
 * one in view. The lit segment is where you are, in its category's colour (Transmit is always red). Settings sits
 * apart on the right with the radio's connection dot on it.
 */
@Composable
private fun BottomBar(current: MayhemApp?, connected: Boolean, accent: Color) {
    val d = rememberDims()
    val bar by NavBar.bar.collectAsState()
    Radio.kind.collectAsState().value
    var asking by remember { mutableStateOf<MayhemApp?>(null) }
    asking?.let { app -> NeedsHackRfDialog(app) { asking = null } }
    val scroll = rememberScrollState()
    val spots = remember { HashMap<String, Pair<Int, Int>>() }
    val here = when (current) { null -> "HOME"; MayhemApp.SETTINGS -> Apps.settingsOver()?.name ?: "HOME"; else -> current!!.name }
    LaunchedEffect(here, bar) {
        val (x, w) = spots[here] ?: return@LaunchedEffect
        scroll.animateScrollTo((x - (scroll.viewportSize - w) / 2).coerceIn(0, scroll.maxValue))
    }
    val onSettings = current == MayhemApp.SETTINGS
    Column(Modifier.fillMaxWidth().background(Palette.surface)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.line))
        Row(Modifier.fillMaxWidth().padding(horizontal = d.pad, vertical = d.dp(6f)), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Row(
                Modifier.weight(1f).height(d.dp(44f)).clip(RoundedCornerShape(8.dp)).background(Palette.paper)
                    .border(1.dp, Palette.line, RoundedCornerShape(8.dp)).horizontalScroll(scroll).padding(3.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically
            ) {
                BarSeg("HOME", on = current == null, tint = Palette.ink, key = "HOME", spots = spots) { if (current != null) Apps.home() }
                for (app in bar) {
                    val blocked = Radio.blockedBecause(app).isNotEmpty()
                    BarSeg(barLabel(app), on = current == app, tint = tintFor(app), key = app.name, spots = spots, dim = blocked) {
                        when {
                            current == app -> {}
                            // the app Settings is open over: just close Settings, don't start it again
                            onSettings && Apps.settingsOver() == app -> Apps.back()
                            blocked -> asking = app
                            else -> Apps.open(app)
                        }
                    }
                }
            }
            Box(
                Modifier.size(d.dp(44f)).clip(RoundedCornerShape(8.dp)).background(if (onSettings) Palette.panel else Color.Transparent)
                    .border(1.dp, if (onSettings) accent else Palette.line, RoundedCornerShape(8.dp))
                    .clickable { if (onSettings) Apps.back() else Apps.open(MayhemApp.SETTINGS) },
                contentAlignment = Alignment.Center
            ) {
                Icon(GearIcon, contentDescription = "Settings", tint = Palette.ink, modifier = Modifier.size(d.dp(22f)))
                Box(Modifier.align(Alignment.TopEnd).padding(5.dp).size(7.dp).background(if (connected) Palette.ok else Palette.danger, CircleShape))
            }
        }
    }
}

@Composable
private fun BarSeg(label: String, on: Boolean, tint: Color, key: String, spots: HashMap<String, Pair<Int, Int>>, dim: Boolean = false, onClick: () -> Unit) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    Box(
        Modifier.fillMaxHeight().widthIn(min = d.dp(48f)).onGloballyPositioned { spots[key] = it.positionInParent().x.toInt() to it.size.width }
            .clip(RoundedCornerShape(6.dp)).background(if (on) tint else Color.Transparent).alpha(if (dim && !on) 0.45f else 1f)
            .clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() }.padding(horizontal = d.dp(12f)),
        contentAlignment = Alignment.Center
    ) {
        Text(label, color = if (on) inkOn(tint) else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f),
            letterSpacing = 0.5.sp, maxLines = 1, softWrap = false)
    }
}
