package com.rocketgod.mayhem.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.MayhemApp
import java.util.Locale

/**
 * What an empty list or card stage says, centered: the app's glyph, what it is waiting for, and one or two concrete
 * things to try. Keyed by app (and a few sub-lists). Twin of the web app's EMPTY table and emptyState().
 */
internal val EMPTY: Map<String, Triple<MayhemApp, String, List<String>>> = mapOf(
    "prowl" to Triple(MayhemApp.PROWL, "Nothing heard yet", listOf("Press HUNT: it lands on anyone talking and moves on when they stop", "A wider SPAN watches more at once; a narrower one hears weak voices better")),
    "search" to Triple(MayhemApp.SEARCH, "No active frequencies yet", listOf("Pick a range above: AIR 118–137 and 2m 144–148 are busy almost everywhere", "Set ABOVE to +10 dB to catch weaker signals")),
    "capture" to Triple(MayhemApp.CAPTURE, "No captures yet", listOf("Tune to a signal and press ● REC", "Keep it short: 2 Msps fills about 4 MB a second")),
    "acars" to Triple(MayhemApp.ACARS, "Waiting for ACARS messages", listOf("Aircraft send them every few minutes; 131.550 is the busiest US channel", "Near an airport, or with an antenna that sees the sky, you hear aircraft up to 200 miles out")),
    "btle" to Triple(MayhemApp.BTLE, "Waiting for BLE advertisements", listOf("Phones, earbuds and watches advertise several times a second: start on CH 37", "BLE is low power: hold the radio within a few meters of a device")),
    "lora" to Triple(MayhemApp.LORA, "No nodes yet", listOf("Meshtastic nodes beacon about every 15 minutes: leave it running", "A wider SPAN (20 MHz on a HackRF) covers all of 902–928 MHz")),
    "loramsg" to Triple(MayhemApp.LORA, "No messages yet", listOf("Text on the default Meshtastic and MeshCore public channels shows up here", "Names and positions arrive first; messages are rarer")),
    "ham" to Triple(MayhemApp.HAM, "Nothing open", listOf("Every channel in the span is watched; one that opens shows up here with its tone", "Try 2 m near 146.520, or set the threshold to +6 dB")),
    "ert" to Triple(MayhemApp.ERT, "No meters yet", listOf("Meters report every 30 s to a few minutes: give it a minute", "Most meters sit at 908–924 MHz: the 19.2 MHz span covers them")),
    "adsb" to Triple(MayhemApp.ADSB, "No aircraft yet", listOf("Aircraft send on 1090 MHz several times a second: a window with a view of the sky helps", "A 1090 MHz antenna (about 6.9 cm) reaches 100+ miles")),
    "ais" to Triple(MayhemApp.AIS, "No vessels yet", listOf("Ships under way report every 2–10 s, at anchor every 3 minutes", "AIS is VHF: you need a line of sight to the water")),
    "aprs" to Triple(MayhemApp.APRS, "No stations yet", listOf("North America uses 144.390 MHz: cars and digipeaters beacon every few minutes", "An antenna up high hears much farther")),
    "analyzer" to Triple(MayhemApp.ANALYZER, "No bursts yet", listOf("Press a key fob or a remote near the antenna", "Or IMPORT a recording (.cu8 .cs8 .sub) or a session (.mmanalyzer)")),
    "pager" to Triple(MayhemApp.PAGER, "No pages yet", listOf("US FLEX networks sit around 929–932 MHz: try the presets", "POCSAG is common on 152–158 and 466 MHz")),
)

/**
 * The empty state for [key], centered in [modifier]'s area: the glyph (44 dp, the accent leaning toward muted), the
 * title in capitals, the tips each after an accent arrow. A key with no entry shows [title] (or "listening…") alone.
 */
@Composable
fun EmptyState(key: String, modifier: Modifier = Modifier, accent: Color = Palette.accent, title: String? = null, tips: List<String>? = null) {
    val d = rememberDims()
    val e = EMPTY[key]
    // centered in the area it is given; an area too short for it scrolls rather than cutting the tips off
    BoxWithConstraints(modifier.heightIn(min = d.dp(180f))) {
        // (only a bounded area scrolls: inside a list or a scrolling column it simply takes its height)
        val fill = if (constraints.hasBoundedHeight) Modifier.verticalScroll(rememberScrollState()).heightIn(min = maxHeight) else Modifier
        Column(Modifier.fillMaxWidth().then(fill).padding(horizontal = d.dp(16f), vertical = d.dp(18f)),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(d.dp(8f), Alignment.CenterVertically)) {
        if (e == null) {
            Text(title ?: "listening…", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), textAlign = TextAlign.Center)
            return@Column
        }
            AppGlyph(e.first, lerp(Palette.muted, accent, 0.7f), Modifier.size(d.dp(44f)).alpha(0.9f))
            Text((title ?: e.second).uppercase(Locale.US), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f),
                letterSpacing = 0.8.sp, textAlign = TextAlign.Center)
            Column(Modifier.widthIn(max = d.dp(420f)), verticalArrangement = Arrangement.spacedBy(d.dp(4f)), horizontalAlignment = Alignment.CenterHorizontally) {
                for (t in tips ?: e.third) Text(buildAnnotatedString {
                    withStyle(SpanStyle(color = accent)) { append("→ ") }
                    append(t)
                }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), lineHeight = d.sp(16f), textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth())
            }
        }
    }
}
