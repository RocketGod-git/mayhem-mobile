package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.sat.SatcomProcessor
import com.rocketgod.mayhem.core.sat.Stdc
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs

private val SC_WARN = Color(0xFFF5A524)
private fun scColor(priority: Int, accent: Color) = when (priority) { 3 -> Palette.danger; 2 -> SC_WARN; 1 -> accent; else -> Palette.muted }

/** Satcom: Inmarsat on L-band, receive only. EGC broadcasts to ships as cards; Aero's ACARS as the log (and in Flight Msgs). */
@Composable
fun SatcomScreen(accent: Color) {
    val d = rememberDims()
    val mode by Apps.satcomMode.collectAsState()
    val snap by Apps.satcom.snap.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val offset by SdrEngine.offsetHz.collectAsState()
    val ch = freq + offset
    val egc = mode == SatcomProcessor.Mode.EGC
    val msgs = snap?.messages.orEmpty()
    val locked = (snap?.lock ?: 0.0) > 0.5
    val wf = waterfallOn(MayhemApp.SATCOM, phoneDefault = true)
    // EGC's cards take the log's place; Aero keeps the log
    val egcBody: @Composable ColumnScope.() -> Unit = {
        Box(Modifier.fillMaxWidth().weight(1f)) {
            if (msgs.isEmpty()) EmptyState("satcom", Modifier.fillMaxSize(), accent)
            else LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                items(msgs, key = { it.key }) { m -> EgcCard(m, accent) }
            }
        }
        AppNote("EGC: SafetyNET and FleetNET broadcasts on the region's NCS carrier, with their priority and area. Encrypted ones are flagged, not decoded. AERO's ACARS also shows in Flight Msgs, marked SATCOM. Needs an L-band patch antenna and an LNA.")
    }
    PacketFrame(accent, Apps.satcomLog, tag = "SATCOM", title = "INMARSAT · L-BAND", roomy = true, emptyKey = "satcom", waterfall = wf,
        onWaterfall = { Apps.setWaterfall(MayhemApp.SATCOM, !wf) },
        lamp = {
            when {
                egc && msgs.isNotEmpty() -> Lamp("${msgs.size} MESSAGE${if (msgs.size == 1) "" else "S"}", Palette.ok)
                locked -> Lamp("LOCKED", Palette.ok)
                else -> Lamp("LISTENING", Palette.accent2, blink = true)
            }
        },
        controls = {
            SegBar(listOf("EGC · SHIPS", "AERO 600", "AERO 1200"), mode.ordinal, accent) { Apps.setSatcomMode(SatcomProcessor.Mode.entries[it]) }
            if (egc) TileRow(Stdc.NCS_CHANNELS.map { (n, hz) -> Tile(String.format(Locale.US, "%.3f", hz / 1e6), n, ch == hz) }, accent, 92.dp) { Apps.satcomTune(Stdc.NCS_CHANNELS[it].second) }
            else AppNote("Tap a P-channel carrier on the waterfall, about 1545 to 1555 MHz, or type its frequency.")
            Text(statusLine(snap, egc), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.dp(4f)))
        },
        body = if (egc) egcBody else null)
}

private fun statusLine(s: SatcomProcessor.Snap?, egc: Boolean): String {
    val carrier = if (s != null && !s.carrierHz.isNaN()) "CARRIER ${if (s.carrierHz >= 0) "+" else "−"}${String.format(Locale.US, "%.2f", abs(s.carrierHz / 1000))} kHz · ${if (s.lock > 0.5) "LOCKED" else "NOT LOCKED"}" else "NO CARRIER YET"
    if (egc) {
        val f = s?.egc
        val utc = if (f != null && f.frameNo >= 0) " · FRAME ${f.frameNo} (${SimpleDateFormat("HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(f.frameNo * 8640L))} UTC)" else ""
        return "$carrier · ${f?.frames ?: 0} FRAMES · ${f?.packets ?: 0} PACKETS${if ((f?.badPackets ?: 0) > 0) " · ${f!!.badPackets} BAD" else ""}$utc"
    }
    val a = s?.aero
    return "$carrier · ${a?.frames ?: 0} FRAMES · ${a?.units ?: 0} SIGNAL UNITS${if ((a?.badUnits ?: 0) > 0) " · ${a!!.badUnits} BAD" else ""}${if (a != null && a.ges >= 0) " · GES ${a.ges}" else ""}"
}

@Composable
private fun EgcCard(m: Stdc.EgcMessage, accent: Color) {
    val d = rememberDims()
    val c = scColor(m.priority, accent)
    Column(Modifier.fillMaxWidth().panel(c).padding(d.dp(10f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Pill(m.priorityName, c)
            Text(SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(m.lastMs)), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
            Text(m.serviceName, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), modifier = Modifier.weight(1f))
        }
        if (m.area.isNotEmpty()) Text(m.area, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.copy(alpha = 0.25f)))
        Text("MESSAGE ${m.seq}${if (m.repeats > 0) " · HEARD ${m.repeats + 1} TIMES" else ""}", color = c, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f))
        when {
            m.encrypted -> Text("encrypted or binary: present, not decoded", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
            m.text.isNotEmpty() -> SelectionContainer { Text(m.text, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(13f), lineHeight = d.sp(18f)) }
        }
        if (!m.complete) Text("${m.parts} part${if (m.parts == 1) "" else "s"} in, waiting for the rest", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
    }
}
