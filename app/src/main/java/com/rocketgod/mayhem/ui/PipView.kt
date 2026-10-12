package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.AdsbStore
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.Prowl
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.ham.Ham
import com.rocketgod.mayhem.core.r433.Devices
import kotlinx.coroutines.flow.MutableStateFlow

/** Whether the activity is showing as a floating picture-in-picture window. */
object Pip {
    val active = MutableStateFlow(false)
}

/**
 * The floating window: what is open, the frequency it is on, a waterfall, and the one line that says what is
 * happening. No controls; tapping the window brings the full app back, and mute (plus skip in Prowl) ride on the
 * window's own buttons.
 */
@Composable
fun PipView(app: MayhemApp?, accent: Color) {
    val spec by SdrEngine.spectrum.collectAsState()
    val lo by SdrEngine.freqHz.collectAsState()
    val offset by SdrEngine.offsetHz.collectAsState()
    val mode by SdrEngine.mode.collectAsState()
    val muted by SdrEngine.muted.collectAsState()
    val ham by Ham.state.collectAsState()
    val hz = when (app) {
        MayhemApp.HAM -> ham.channel
        else -> lo + offset
    }
    Column(Modifier.fillMaxSize().background(Palette.paper).padding(4.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text((app?.title ?: "MAYHEM").uppercase(), color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = 10.sp, letterSpacing = 1.sp,
                modifier = Modifier.weight(1f), maxLines = 1)
            if (muted) Text("MUTED", color = Palette.danger, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 9.sp)
        }
        Row(verticalAlignment = Alignment.Bottom) {
            Text("%.4f".format(hz / 1e6), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = 20.sp, maxLines = 1)
            val m = when (app) { MayhemApp.HAM -> ham.mode.name; else -> if (mode == SdrEngine.Mode.NONE) "" else mode.name }
            Text(" MHz $m", color = Palette.muted, fontFamily = Mono, fontSize = 9.sp, modifier = Modifier.padding(bottom = 3.dp), maxLines = 1)
        }
        WaterfallView(spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = 2.dp), rows = 40, traceFrac = 0.4f)
        Text(pipLine(app), color = Palette.accent2, fontFamily = Mono, fontSize = 9.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun lastLine(log: PacketLog): String = log.lines.collectAsState().value.firstOrNull() ?: "listening…"

/** The one line that says what this app is doing right now. */
@Composable
private fun pipLine(app: MayhemApp?): String = when (app) {
    MayhemApp.AUDIO -> {
        val rds by SdrEngine.rds.collectAsState()
        val open by SdrEngine.squelchOpen.collectAsState()
        val r = rds
        if (r != null && r.ps.isNotBlank()) listOf(r.ps.trim(), r.rt.trim()).filter { it.isNotEmpty() }.joinToString(" · ")
        else if (open) "signal" else "squelched"
    }
    MayhemApp.PROWL -> {
        val v by Prowl.view.collectAsState()
        val t = v.target
        if (t != null) "${t.cls.ifEmpty { "?" }} · speech %.2f · %ds".format(v.score, v.dwellS)
        else if (v.on) "hunting · ${v.seen} in view" else v.note.ifEmpty { "stopped" }
    }
    MayhemApp.ADSB -> {
        val planes by AdsbStore.flow.collectAsState()
        val frames by AdsbStore.frames.collectAsState()
        "${planes.size} aircraft · ${planes.count { it.lat != null }} on the map · $frames frames"
    }
    MayhemApp.AIS -> "${Apps.ais.table.collectAsState().value.size} vessels · ${lastLine(Apps.aisLog)}"
    MayhemApp.APRS -> "${Apps.aprs.table.collectAsState().value.size} stations · ${lastLine(Apps.aprsLog)}"
    MayhemApp.DEVICES -> {
        val heard by Devices.proc.devices.collectAsState()
        heard.maxByOrNull { it.lastSeen }?.let { "${it.model} · ${Devices.summary(it.data)}" } ?: "${heard.size} devices"
    }
    MayhemApp.PAGER -> lastLine(Apps.pagerLog)
    MayhemApp.ERT -> lastLine(Apps.ertLog)
    MayhemApp.BTLE -> lastLine(Apps.btleLog)
    MayhemApp.TPMS -> lastLine(Apps.tpmsLog)
    MayhemApp.ACARS -> lastLine(Apps.acarsLog)
    MayhemApp.SUBGHZ -> lastLine(Apps.ismLog)
    else -> app?.blurb ?: ""
}
