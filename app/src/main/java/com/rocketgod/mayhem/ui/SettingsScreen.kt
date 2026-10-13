package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.setValue
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.rocketgod.mayhem.BuildConfig

/** Settings (Mayhem ui_settings): theme skins lifted from the firmware, and an About panel. */
@Composable
fun SettingsScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val cols = if (d.wide) 4 else 2
    ScrollColumn(Modifier.fillMaxSize()) {
        SectionLabel("THEME · the PortaPack Mayhem firmware skins, plus the mobile default")
        for (rowSkins in Skin.values().toList().chunked(cols)) {
            Row(Modifier.fillMaxWidth().padding(bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for (skin in rowSkins) SkinCard(skin, skin == Skins.current, Modifier.weight(1f)) { Skins.set(ctx, skin) }
                repeat(cols - rowSkins.size) { Box(Modifier.weight(1f)) }
            }
        }
        SectionLabel("STATION · your callsign and grid, for the HAM logbook, APRS and FT8")
        val st = com.rocketgod.mayhem.core.Station.info.collectAsState().value
        val gpsGrid = com.rocketgod.mayhem.core.Geo.fix.collectAsState().value?.let { com.rocketgod.mayhem.core.ham.latLonToGrid(it.first, it.second) }
        Column(Modifier.fillMaxWidth().panel().padding(d.dp(8f))) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                LogField(st.call, "callsign", accent, Modifier.weight(1f), caps = true) { v -> com.rocketgod.mayhem.core.Station.update { it.copy(call = v.uppercase().trim()) } }
                LogField(st.license, "licence class", accent, Modifier.weight(1f)) { v -> com.rocketgod.mayhem.core.Station.update { it.copy(license = v) } }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                LogField(st.name, "name", accent, Modifier.weight(1f)) { v -> com.rocketgod.mayhem.core.Station.update { it.copy(name = v) } }
                LogField(st.grid, gpsGrid?.let { "grid · $it from GPS" } ?: "grid square, e.g. DM04og", accent, Modifier.weight(1f), caps = true) { v -> com.rocketgod.mayhem.core.Station.update { it.copy(grid = v.trim()) } }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                LogField(st.dmrId, "DMR ID (radioid.net)", accent, Modifier.weight(1f)) { v -> com.rocketgod.mayhem.core.Station.update { it.copy(dmrId = v.filter { c -> c.isDigit() }) } }
                LogField(st.aprsSsid, "APRS SSID (9 = mobile)", accent, Modifier.weight(1f)) { v -> com.rocketgod.mayhem.core.Station.update { it.copy(aprsSsid = v.filter { c -> c.isDigit() }.take(2)) } }
            }
        }
        Box(Modifier.height(d.dp(8f)))
        SectionLabel("TRANSMIT · on, with a safety prompt before the first send — you are responsible for what you send")
        val txOn = com.rocketgod.mayhem.core.Tx.enabled.collectAsState().value
        Column(Modifier.fillMaxWidth().panel(if (txOn) Palette.danger else Palette.line).padding(d.dp(10f))) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(if (txOn) "TX ENABLED" else "TX DISABLED", color = if (txOn) Palette.danger else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 2.sp)
                    Text("Enables the Transmit app. Most bands require a licence; always use a dummy load or an antenna rated for the frequency.", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.padding(top = d.dp(4f)))
                }
                Box(Modifier.padding(start = d.dp(10f))) { Chip(if (txOn) "ON" else "OFF", selected = txOn, accent = Palette.danger) { com.rocketgod.mayhem.core.Tx.setEnabled(ctx, !txOn) } }
            }
        }
        Box(Modifier.height(d.dp(8f)))
        SectionLabel("ABOUT")
        Column(Modifier.fillMaxWidth().panel().padding(d.dp(10f))) {
            AboutLine("Mayhem Mobile", "v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) · build ${BuildConfig.GIT_SHA}")
            AboutLine("Web app", "rocketgod-git.github.io/mayhem-mobile — same build, in Chrome/Edge over WebUSB")
            AboutLine("Device", com.rocketgod.mayhem.core.Radio.label.ifEmpty { "no radio attached" })
            AboutLine("What it is", "PortaPack Mayhem's receivers, ported to Kotlin and run on the phone from raw HackRF or RTL-SDR IQ over USB")
            AboutLine("Source", "github.com/RocketGod-git/mayhem-mobile")
            AboutLine("Upstream", "github.com/portapack-mayhem/mayhem-firmware")
            AboutLine("License", "GPL-3.0 (Mayhem-derived)")
        }
        SectionLabel("MADE BY")
        Column(Modifier.fillMaxWidth().panel().padding(d.dp(10f))) {
            LinkLine("RocketGod", "RocketGod.dev", "https://rocketgod.dev")
            LinkLine("Crew", "The Pirates' Plunder — discord.gg/thepirates", "https://discord.gg/thepirates")
        }
        SectionLabel("CREDITS · who wrote what this app is built from")
        CreditsRoll(accent)
        SectionLabel("FIELD NOTES")
        Column(Modifier.fillMaxWidth().panel().padding(d.dp(10f))) {
            AboutLine("Plugging in", "the app opens by itself when a HackRF or an RTL-SDR is plugged in; allow the USB prompt once and tick 'always'")
            AboutLine("RTL-SDR", "receive only, 24 MHz to 1.766 GHz, up to 2.4 Msps, one gain control: the transmit side is greyed out, HAM's HF bands and Bluetooth are out of reach, and wider spans are held to 2.4 MHz")
            AboutLine("Power", "a HackRF Pro can draw more than a phone's OTG port supplies — use a powered OTG hub if the log shows all-zero IQ")
            AboutLine("Reading LOG", "iqRMS ≈ 0.85 with dcI = dcQ ≈ 0.6 means all-zero buffers: cable, power, or a PortaPack not in HackRF mode")
            AboutLine("Tuning", "press the waterfall and slide: the amber guide and readout follow your finger and the radio retunes when you lift. On the home screen a tap sets where Audio opens")
            AboutLine("Floating window", "press home while an app is open and it keeps going in a small window with the waterfall and what it is hearing; mute (and skip, in Prowl) are on the window")
            AboutLine("Screen", "the screen stays on while an app is open, and sleeps as usual on the home screen")
            AboutLine("Maps", "ADS-B, AIS and APRS plot on OpenStreetMap; allow location so distances and single-frame aircraft positions use your spot")
            AboutLine("Gain", "receivers start at LNA 24 / VGA 24 / amp off (the amp overloads strong FM); ADS-B uses Mayhem's LNA 32 / VGA 32 / amp on")
            AboutLine("Squelch + scan", "squelch gates audio against a tracked noise floor; SCAN in Audio hops your bookmarks and holds where the squelch opens")
            AboutLine("Captures", "Capture records signed 8-bit IQ with a .txt sidecar; SHARE sends both to SDR#, GNU Radio or a drive")
        }
        Box(Modifier.height(d.dp(12f)))
    }
}

@Composable
private fun SkinCard(skin: Skin, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val d = rememberDims()
    Column(
        modifier.clip(RoundedCornerShape(8.dp)).background(skin.paper)
            .border(if (selected) 2.dp else 1.dp, if (selected) skin.accent else skin.line, RoundedCornerShape(8.dp))
            .clickable { onClick() }.padding(d.dp(10f))
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(skin.title, color = skin.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1)
            if (selected) Text("●", color = skin.accent, fontFamily = Mono, fontSize = d.sp(11f))
        }
        Row(Modifier.fillMaxWidth().padding(top = d.dp(8f)), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            for (c in listOf(skin.surface, skin.panel, skin.line, skin.muted, skin.accent, skin.accent2))
                Box(Modifier.weight(1f).height(d.dp(14f)).clip(RoundedCornerShape(3.dp)).background(c))
        }
        Box(Modifier.fillMaxWidth().padding(top = d.dp(8f)).clip(RoundedCornerShape(4.dp)).background(skin.surface)
            .border(1.dp, skin.accent.copy(alpha = 0.5f), RoundedCornerShape(4.dp)).padding(vertical = d.dp(5f)), contentAlignment = Alignment.Center) {
            Text("92.3000 MHz", color = skin.accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
        }
    }
}

/** Rolling credits, PortaPack style: Mayhem's contributor lists plus the authors of every file we ported.
 *  The list is rendered twice back-to-back and the auto-scroll snaps back to 0 when it crosses the first copy's
 *  height — an endless loop with no pause. Drag or fling to steer; the loop resumes as soon as you let go. */
@Composable
private fun CreditsRoll(accent: Color) {
    val d = rememberDims()
    val scroll = rememberScrollState()
    var listHeightPx by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(0) }
    LaunchedEffect(scroll, listHeightPx) {
        while (true) {
            if (!scroll.isScrollInProgress) {
                val max = scroll.maxValue
                if (listHeightPx > 0 && scroll.value >= listHeightPx) {
                    scroll.scrollTo(scroll.value - listHeightPx)
                } else if (max > 0 && scroll.value < max) {
                    scroll.scrollBy(1f)
                }
            }
            delay(28)
        }
    }
    Column(Modifier.fillMaxWidth().height(d.dp(240f)).panel().padding(horizontal = d.dp(12f)).verticalScroll(scroll)) {
        for (copy in 0 until 2) {
            Column(Modifier.fillMaxWidth().onGloballyPositioned { if (copy == 0) listHeightPx = it.size.height }) {
                for ((head, text) in Credits.lines) {
                    if (head) Text(text, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 2.sp,
                        modifier = Modifier.fillMaxWidth().padding(top = d.dp(14f), bottom = d.dp(4f)), textAlign = TextAlign.Center)
                    else Text(text, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(14f),
                        modifier = Modifier.fillMaxWidth().padding(vertical = d.dp(2f)), textAlign = TextAlign.Center)
                }
                Box(Modifier.height(d.dp(28f)))
            }
        }
    }
}

@Composable
private fun LinkLine(k: String, v: String, url: String) {
    val d = rememberDims()
    val uri = LocalUriHandler.current
    Row(Modifier.fillMaxWidth().clickable { runCatching { uri.openUri(url) } }.padding(vertical = d.dp(3f))) {
        Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.size(width = d.dp(92f), height = d.dp(16f)))
        Text(v, color = Palette.accent, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.weight(1f))
    }
}

@Composable
private fun AboutLine(k: String, v: String) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth().padding(vertical = d.dp(3f))) {
        Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.size(width = d.dp(92f), height = d.dp(16f)))
        Text(v, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.weight(1f))
    }
}
