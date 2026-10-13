package com.rocketgod.mayhem.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.SdrEngine

/** Root: header (back / wordmark / device status / LOG), optional diagnostic panel, launcher or the open app. */
@Composable
fun MayhemScreen(status: String, connected: Boolean) {
    val accent = Palette.accent
    val d = rememberDims()
    val current by Apps.current.collectAsState()
    var showLog by remember { mutableStateOf(false) }
    var showTools by remember { mutableStateOf(false) }
    LaunchedEffect(connected) { if (!connected) showTools = true }
    BackHandler(enabled = current != null) { Apps.back() }
    // every screen, the launcher included, is a live receiver: none of them may dim and lock mid-listen
    val view = LocalView.current
    DisposableEffect(Unit) { view.keepScreenOn = true; onDispose { view.keepScreenOn = false } }
    val inPip by Pip.active.collectAsState()
    if (inPip) { PipView(Apps.playing(), accent); return }
    Box(Modifier.fillMaxSize().background(Palette.paper)) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(horizontal = d.pad, vertical = d.dp(6f))) {
            Header(status, connected, current, showLog, showTools, accent, onLog = { showLog = !showLog }, onTools = { showTools = !showTools })
            Box(Modifier.weight(1f).fillMaxWidth()) {
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
                    MayhemApp.SETTINGS -> SettingsScreen(accent)
                }
            }
        }
        NoticeBar(Modifier.align(Alignment.BottomCenter).navigationBarsPadding())
        if (showLog) LogWindow(onClose = { showLog = false })
        UpdateDialog()
    }
}

/** Mayhem-style status bar: an accent stripe, the wordmark, the board, the connection state, the LOG toggle. */
@Composable
private fun Header(status: String, connected: Boolean, app: MayhemApp?, showLog: Boolean, showTools: Boolean, accent: Color, onLog: () -> Unit, onTools: () -> Unit) {
    val d = rememberDims()
    val muted by SdrEngine.muted.collectAsState()
    Column(Modifier.fillMaxWidth().panel()) {
        Box(Modifier.fillMaxWidth().height(2.dp).background(accent))
        Row(
            Modifier.fillMaxWidth().padding(start = d.dp(12f), end = d.dp(8f), top = d.dp(6f), bottom = d.dp(6f)),
            horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f).clickable { if (app != null) Apps.back() }) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(
                        if (app == null) "MAYHEM" else "‹ ${app.title.uppercase()}",
                        color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(16f), letterSpacing = 3.sp, maxLines = 1
                    )
                    if (app == null) Text(" MOBILE", color = accent, fontFamily = Mono, fontWeight = FontWeight.Light, fontSize = d.sp(11f), letterSpacing = 3.sp,
                        modifier = Modifier.padding(bottom = 2.dp))
                }
                if (app == null) Text(
                    "Android phone · Desktop web app",
                    color = Palette.accent2, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1
                )
                Text(
                    if (app == null) "${com.rocketgod.mayhem.core.Radio.label.ifEmpty { "HackRF or RTL-SDR" }} · $status"
                    // the readout shows the channel; the radio's own centre here would read as a second, wrong frequency
                    else "${app.blurb} · ${status.replace(Regex(" · [0-9.]+ MHz$"), "")}",
                    color = if (connected) Palette.muted else Palette.danger, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1
                )
            }
            Box(Modifier.padding(horizontal = d.dp(8f)).size(d.dp(8f)).background(if (connected) Palette.ok else Palette.danger, CircleShape))
            Chip(if (showTools) "✕" else "☰", selected = showTools, accent = accent) { onTools() }
        }
        AnimatedVisibility(visible = showTools) {
            Row(Modifier.fillMaxWidth().padding(start = d.dp(8f), end = d.dp(8f), bottom = d.dp(8f)), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                Chip(if (muted) "UNMUTE" else "MUTE", selected = muted, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.toggleMute() }
                Chip(if (showLog) "LOG ▲" else "LOG", selected = showLog, accent = accent, modifier = Modifier.weight(1f)) { onLog() }
                Chip("HOME", selected = false, accent = accent, modifier = Modifier.weight(1f)) { Apps.home() }
                Chip("SETTINGS", selected = app == MayhemApp.SETTINGS, accent = accent, modifier = Modifier.weight(1f)) { Apps.open(MayhemApp.SETTINGS) }
            }
        }
    }
}
