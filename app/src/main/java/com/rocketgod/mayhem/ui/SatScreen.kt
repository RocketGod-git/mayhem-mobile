package com.rocketgod.mayhem.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Mic
import com.rocketgod.mayhem.core.Tx
import com.rocketgod.mayhem.core.ham.Ham
import com.rocketgod.mayhem.core.ham.Logbook
import com.rocketgod.mayhem.core.sat.ORBCOMM_CHANNELS
import com.rocketgod.mayhem.core.sat.SATS
import com.rocketgod.mayhem.core.sat.SatKind
import com.rocketgod.mayhem.core.sat.Sats
import com.rocketgod.mayhem.core.sat.XKMPER
import com.rocketgod.mayhem.core.sat.doppler
import com.rocketgod.mayhem.core.sat.dopplerUp
import com.rocketgod.mayhem.core.sat.look
import java.util.Calendar
import kotlin.math.acos
import kotlin.math.max

/** Satellites: track and listen (with Doppler) to the amateur and weather birds, the packet cubesats, and ORBCOMM. */
@Composable
fun SatScreen(accent: Color) {
    val u by Sats.ui.collectAsState()
    when (u.view) {
        Sats.View.TRACK -> SatTrack(accent)
        Sats.View.PACKET -> SatPacket(accent)
        Sats.View.ORBCOMM -> SatOrbcomm(accent)
    }
}

@Composable
private fun SatStrip(accent: Color) {
    val d = rememberDims()
    val u by Sats.ui.collectAsState()
    Row(Modifier.fillMaxWidth().padding(bottom = d.dp(4f)), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        for (v in Sats.View.entries) Chip(v.label, u.view == v, accent, Modifier.weight(v.label.length + 2f)) { Sats.setView(v) }
    }
}

private fun hhmm(ms: Long): String { val c = Calendar.getInstance().apply { timeInMillis = ms }; return "%02d:%02d".format(c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE)) }

@Composable
private fun SatTrack(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val u by Sats.ui.collectAsState()
    val home by Geo.fix.collectAsState()
    val s by Ham.state.collectAsState()
    val p by Ham.ptt.collectAsState()
    val needsPrompt by Tx.needsPrompt.collectAsState()
    val txStatus by Tx.status.collectAsState()
    val aprs by Sats.aprsLog.lines.collectAsState()
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { kotlinx.coroutines.delay(1000); now = System.currentTimeMillis() } }
    var note by remember { mutableStateOf("") }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> note = if (ok) "microphone ready — hold the button" else "no microphone permission" }
    // A receive app first: the transmit safety prompt waits until push-to-talk is actually pressed.
    var asking by remember { mutableStateOf(false) }
    if (asking && needsPrompt) SafetyPromptDialog(accent, onCancel = { asking = false }) { Tx.acknowledgeSafety(); asking = false }
    // Taken from `u`, not Sats' own copy, so this scope recomposes when the TLEs land or the selection changes. Before
    // that it read no state at all while the orbit was missing (`now` is only read once there is one), so a screen
    // opened before the TLEs arrived kept saying "no orbit data" while the passes below it filled in.
    val def = Sats.def(u); val svc = Sats.service(u); val sgp = Sats.sgp(def.norad)
    val l = if (sgp != null && home != null) runCatching { look(sgp, now, home!!.first, home!!.second) }.getOrNull() else null
    val status: @Composable () -> Unit = {
        Text(u.status + (home?.let { " · %.2f, %.2f".format(it.first, it.second) } ?: " · no GPS fix"), color = Palette.muted, fontFamily = Mono,
            fontSize = d.sp(10f), modifier = Modifier.padding(top = d.dp(4f)))
    }
    HamLayout(accent, meter = true, status = status) {
        SatStrip(accent)
        SectionLabel("SATELLITE")
        ChipGrid(SATS, columns = 4) { x -> Chip(x.name, u.sel == x.norad, accent, Modifier.weight(1f)) { Sats.select(x.norad) } }
        def.what?.let { Text(it, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10.5f), modifier = Modifier.padding(top = d.dp(6f))) }
        SectionLabel("WHAT IT OFFERS · tap to set the receiver up for it")
        ChipGrid(def.services.withIndex().toList(), columns = 2) { (i, x) -> Chip(x.name.uppercase(), u.svc == i, accent, Modifier.weight(1f)) { Sats.selectService(i) } }
        Text((if (svc.up != null) "Two-way, license needed to transmit. " else "Receive only. ") + (svc.how ?: ""), color = Palette.ink, fontFamily = Mono,
            fontSize = d.sp(10.5f), modifier = Modifier.padding(top = d.dp(6f)))
        Text("${svc.name} · %.4f MHz down".format(svc.down / 1e6) + (svc.up?.let { " · %.3f up".format(it / 1e6) + (svc.tone?.let { t -> " tone $t" } ?: "") } ?: "") +
            (svc.note?.let { " · $it" } ?: ""), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.dp(4f)))
        Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip(if (u.track) "LISTENING · DOPPLER ON" else "LISTEN · TRACK DOPPLER", u.track, accent, Modifier.weight(2f)) { Sats.toggleTrack() }
            Chip("REFRESH TLE", false, accent, Modifier.weight(1f)) { Sats.refreshTles() }
        }
        val radio by com.rocketgod.mayhem.core.Radio.kind.collectAsState()
        if (svc.up != null && radio == com.rocketgod.mayhem.core.Radio.Kind.RTLSDR) Box(Modifier.padding(top = d.gap)) { ReceiveOnlyNote(accent) }
        else if (svc.up != null) {
            Box(
                Modifier.fillMaxWidth().padding(top = d.gap).height(d.dp(56f))
                    .background(if (p.on) Palette.danger else Palette.surface, RoundedCornerShape(10.dp)).then(Modifier.panel(if (p.on) Palette.danger else accent))
                    .pointerInput(Unit) {
                        detectTapGestures(onPress = {
                            if (Tx.needsPrompt.value) { asking = true; return@detectTapGestures }
                            if (!Mic.granted(ctx)) { askMic.launch(Manifest.permission.RECORD_AUDIO); return@detectTapGestures }
                            val up = Sats.uplink()
                            if (up != null) Ham.startPtt(ctx, up.first, up.second)?.let { note = it }
                            tryAwaitRelease()
                            Ham.stopPtt()
                        })
                    },
                contentAlignment = Alignment.Center,
            ) {
                Text(if (p.on) "TX UPLINK %.4f".format((Sats.uplink()?.first ?: 0L) / 1e6) else "PUSH TO TALK · UPLINK", color = if (p.on) Color.White else accent,
                    fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(15f))
            }
            Text(note.ifEmpty { txStatus }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
        }
        // now
        Column(Modifier.fillMaxWidth().padding(top = d.gap).panel().padding(d.dp(6f))) {
            when {
                sgp == null -> KvLine(def.name, if (u.status.endsWith("TLEs")) "no orbit data from CelesTrak — retired or renamed; the receiver is tuned anyway" else "waiting for orbit data…")
                home == null || l == null -> KvLine(def.name, "allow location to get look angles, Doppler and passes")
                else -> {
                    val rx = doppler(svc.down, l.rangeRate)
                    KvLine("Now", "az %.0f° · el %.1f° · %.0f km · %+.2f km/s%s".format(l.az, l.el, l.rangeKm, l.rangeRate, if (l.el < 0) " · below the horizon" else ""))
                    KvLine("Receive", "%.4f → %.4f MHz (%+d Hz)".format(svc.down / 1e6, rx / 1e6, rx - svc.down))
                    svc.up?.let { up -> KvLine("Transmit", "%.4f → %.4f MHz%s".format(up / 1e6, dopplerUp(up, l.rangeRate) / 1e6, svc.tone?.let { " · CTCSS %.1f".format(it) } ?: " · no tone")) }
                    KvLine("Sub-point", "%.1f, %.1f · %.0f km".format(l.lat, l.lon, l.altKm))
                }
            }
        }
        // map: where it is, its radio footprint, the next 90 minutes of ground track
        if (sgp != null) {
            val h = home ?: (0.0 to 0.0)
            val sub = runCatching { look(sgp, now, h.first, h.second) }.getOrNull()
            val trackPts = remember(def.norad, now / 30_000) {
                (0..90).mapNotNull { m -> runCatching { look(sgp, now + m * 60_000L, h.first, h.second) }.getOrNull()?.let { it.lat to it.lon } }
            }
            if (sub != null) {
                val foot = XKMPER * acos(XKMPER / (XKMPER + max(100.0, sub.altKm)))
                SectionLabel("MAP")
                GeoMapView(listOf(GeoItem("sat", sub.lat, sub.lon, if (home != null) "${def.name} · el %.0f°".format(sub.el) else def.name, GeoItem.Kind.SAT)), accent,
                    Modifier.fillMaxWidth().height(d.dp(260f)).panel(), home = home, selected = "sat",
                    layers = GeoLayers(track = trackPts, footprint = Triple(sub.lat, sub.lon, foot)), follow = "sat")
            }
        }
        if (svc.kind == SatKind.PACKET) {
            SectionLabel("PACKETS HEARD · tap to log the station")
            Column(Modifier.fillMaxWidth().panel().padding(d.dp(6f))) {
                if (aprs.isEmpty()) Text("nothing heard yet", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
                for (line in aprs.take(50)) {
                    Text(line, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.fillMaxWidth().clickable {
                        val m = Regex("([A-Z0-9]+(?:-\\d+)?)>").find(line)
                        if (m != null) {
                            Logbook.prefill(Logbook.Draft(call = m.groupValues[1].replace(Regex("-\\d+$"), ""), mode = "APRS", notes = line))
                            Ham.setTab(Ham.Tab.LOG); Apps.open(MayhemApp.HAM)
                        }
                    }.padding(vertical = d.dp(2f)))
                }
            }
        }
        if (svc.kind == SatKind.SSTV || svc.kind == SatKind.APT || svc.kind == SatKind.LRPT) PicturePanel(accent)
        SectionLabel("PASSES · next 24 h · local time")
        Column(Modifier.fillMaxWidth().panel().padding(d.dp(6f))) {
            if (u.passes.isEmpty()) Text(if (sgp == null) "no TLE, no passes" else if (home == null) "needs your location" else "no passes in the next 24 h",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
            for (ps in u.passes) {
                val live = now in ps.aos..ps.los
                Row(Modifier.fillMaxWidth().padding(vertical = d.dp(2f)), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("${if (live) "NOW · " else ""}${hhmm(ps.aos)} → ${hhmm(ps.los)} (${(ps.los - ps.aos) / 60000} min)", color = if (live) Palette.accent2 else Palette.ink,
                        fontFamily = Mono, fontSize = d.sp(10.5f))
                    Text("max el %.0f° · az %.0f→%.0f".format(ps.maxEl, ps.aosAz, ps.losAz), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f))
                }
            }
        }
        GainRow(accent)
        Spacer(Modifier.height(d.dp(12f)))
    }
}

@Composable
private fun KvLine(k: String, v: String) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth().padding(vertical = d.dp(1f))) {
        Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f), modifier = Modifier.padding(end = d.dp(8f)))
        Text(v, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10.5f))
    }
}

@Composable
private fun SatPacket(accent: Color) {
    val d = rememberDims()
    val rows by Sats.packetRows.collectAsState()
    val sel by Sats.packetSel.collectAsState()
    val frames by Sats.frames.collectAsState()
    val geo by Sats.geo.collectAsState()
    val home by Geo.fix.collectAsState()
    var frozen by remember { mutableStateOf<List<com.rocketgod.mayhem.core.sat.PacketFrame>?>(null) }
    val paused = frozen != null
    val shown = frozen ?: frames
    val selRow = rows.firstOrNull { it.norad == sel }
    HamLayout(accent, meter = false) {
        SatStrip(accent)
        SectionLabel("ABOVE THE HORIZON NOW · tap to listen")
        val up = rows.filter { it.el > -1 }
        Column(Modifier.fillMaxWidth().panel().padding(d.dp(6f))) {
            val show = (if (up.isNotEmpty()) up else rows).take(60)
            if (show.isEmpty()) Text(Sats.packetNote().ifEmpty { "fetching the list of packet satellites…" }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
            for (r in show) {
                Text("${r.name} · %.4f · ${r.baud}bd${if (r.geoscan) " · 📷" else ""} · ${if (r.el > -1) "el %.0f°".format(r.el) else if (r.hasOrbit) "below the horizon" else "no orbit"}".format(r.hz / 1e6),
                    color = if (r.norad == sel) accent else Palette.ink, fontFamily = Mono, fontSize = d.sp(10.5f),
                    modifier = Modifier.fillMaxWidth().clickable { Sats.listenRow(r) }.padding(vertical = d.dp(3f)))
            }
        }
        Text(if (home == null) "allow location to sort these by what is overhead" else if (rows.isNotEmpty()) "${up.size} of ${rows.size} above the horizon${if (Sats.g3ruh.bad > 0) " · ${Sats.g3ruh.bad} frames failed their check" else ""}" else Sats.packetNote(),
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.dp(4f)))
        if (selRow?.geoscan == true) {
            SectionLabel("PICTURE · built up as the pass goes on")
            Box(Modifier.fillMaxWidth().panel().padding(d.dp(4f))) {
                val b = geo.bitmap
                if (b != null) Image(b.asImageBitmap(), "picture from the satellite", Modifier.fillMaxWidth(), contentScale = ContentScale.FillWidth)
                else Text("nothing yet — a picture takes most of a pass to come down", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
            }
            if (geo.frames > 0) Text("${geo.frames} frames · ${geo.fragments} pieces of picture · %.1f kB${if (geo.complete) " · complete" else ""}${if (geo.bad > 0) " · ${geo.bad} failed the checksum" else ""}".format(geo.high / 1024.0),
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
        }
        Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("${Sats.g3ruh.heard} FRAME${if (Sats.g3ruh.heard == 1) "" else "S"}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f))
            Row(horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                Chip(if (paused) "RESUME" else "PAUSE", paused, accent) { frozen = if (paused) null else frames }
                Chip("CLEAR", false, accent) { Sats.clearFrames(); if (paused) frozen = emptyList() }
            }
        }
        Column(Modifier.fillMaxWidth().padding(top = d.dp(4f)).panel().padding(d.dp(6f))) {
            if (shown.isEmpty()) Text("nothing heard yet — pick something that is up and wait for a beacon", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
            for (f in shown) {
                Text("${f.from} > ${f.to} · ${f.payload.size} bytes", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10.5f))
                Text(f.text.ifEmpty { f.hex }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(bottom = d.dp(4f)))
            }
        }
        Text("Ordinary AX.25 at 9600 baud, scrambled the way James Miller's modem does it. The payload is usually binary telemetry rather than text, so the callsigns are the part you read: they tell you which satellite you just heard.",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.gap))
        GainRow(accent)
        Spacer(Modifier.height(d.dp(12f)))
    }
}

@Composable
private fun SatOrbcomm(accent: Color) {
    val d = rememberDims()
    val o by Sats.orb.collectAsState()
    val home by Geo.fix.collectAsState()
    HamLayout(accent, meter = false) {
        SatStrip(accent)
        SectionLabel("CHANNEL · the busy ones are listed first")
        ChipGrid(ORBCOMM_CHANNELS.toList(), columns = 4) { hz ->
            Chip("%.4f".format(hz / 1e6).trimEnd('0'), o.channel == hz, accent, Modifier.weight(1f)) { if (o.hunt) Sats.orbHunt(); Sats.orbTune(hz) }
        }
        Box(Modifier.padding(top = d.gap)) { Chip(if (o.hunt) "SEARCHING THE CHANNELS" else "FIND A BUSY CHANNEL", o.hunt, accent, Modifier.fillMaxWidth()) { Sats.orbHunt() } }
        Text(if (o.frames > 0) "${o.frames} frames · ${o.packets} packets, ${o.packets - o.bad} good · %.4f MHz".format(o.channel / 1e6) + if (o.sats.isEmpty()) " · decoding, waiting for a position report" else ""
            else "nothing decoded yet on %.4f MHz · a pass lasts about ten minutes and there is often nothing overhead · look for a narrow line on the waterfall".format(o.channel / 1e6),
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.dp(4f)))
        SectionLabel("${o.sats.size} SATELLITE${if (o.sats.size == 1) "" else "S"}")
        Column(Modifier.fillMaxWidth().panel().padding(d.dp(6f))) {
            if (o.sats.isEmpty()) Text("nothing yet — try FIND A BUSY CHANNEL, or wait for a pass", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
            for (s in o.sats) {
                val n = o.named[s.id]
                val utc = s.utc?.let { java.time.Instant.ofEpochMilli(it).toString().substring(11, 19) + "Z" }
                Text((n?.first ?: "0x%02X".format(s.id)) + " · " + (if (s.lat != null) "%.2f, %.2f · %.0f km · %.2f km/s".format(s.lat, s.lon, s.altKm, s.speedKms) else "heard, no position yet") +
                    (n?.let { " · %.0f km from its published orbit".format(it.second) } ?: "") + (utc?.let { " · $it" } ?: ""),
                    color = if (s.id == o.sel) accent else Palette.ink, fontFamily = Mono, fontSize = d.sp(10.5f),
                    modifier = Modifier.fillMaxWidth().clickable { Sats.orbSelect(s.id) }.padding(vertical = d.dp(2f)))
            }
        }
        val items = o.sats.filter { it.lat != null && it.lon != null }.map { s ->
            GeoItem(s.id.toString(), s.lat!!, s.lon!!, "${o.named[s.id]?.first ?: "0x%X".format(s.id)} · %.0f km".format(s.altKm ?: 0.0), GeoItem.Kind.SAT)
        }
        SectionLabel("MAP · each satellite where it says it is")
        GeoMapView(items, accent, Modifier.fillMaxWidth().height(d.dp(260f)).panel(), home = home, selected = o.sel.toString()) { Sats.orbSelect(it.toIntOrNull() ?: -1) }
        Text("The message packets are encrypted and are not decoded. What is shown is each satellite's own report of where it is, which it sends every four seconds, plus its clock and speed.",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.gap))
        GainRow(accent)
        Spacer(Modifier.height(d.dp(12f)))
    }
}
