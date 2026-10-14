package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.r433.Devices
import com.rocketgod.mayhem.core.r433.HeardDevice
import com.rocketgod.mayhem.core.r433.R433Protocol
import com.rocketgod.mayhem.core.r433.fmtValue
import kotlinx.coroutines.delay

/**
 * Alarms, meters, remotes, tire sensors and weather: every protocol listening at once across the slice. Twin of the
 * web app's Devices view.
 */
@Composable
fun DevicesScreen(accent: Color) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val health by SdrEngine.rxHealth.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val live by Devices.proc.devices.collectAsState()
    val rep by Devices.proc.report.collectAsState()
    val band by Devices.band.collectAsState()
    val span by Devices.span.collectAsState()
    val hop by Devices.hop.collectAsState()
    var showProtocols by remember { mutableStateOf(false) }
    var paused by remember { mutableStateOf<List<HeardDevice>?>(null) }
    val heard = paused ?: live

    // The band walk; tuning goes through the normal path, so the waterfall follows.
    LaunchedEffect(hop) { while (hop) { delay(Devices.DWELL_MS); Devices.nextBand() } }

    val onPreview: (Float?) -> Unit = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } }
    val onTune: (Float) -> Unit = { frac -> SdrEngine.tune(spanHz(freq, SdrEngine.currentRate(), frac)) }
    AdaptivePane(
        visualHeightNarrow = d.dp(170f),
        visual = { m ->
            Column(m) {
                FreqReadout(accent, if (health.isNotEmpty()) health else "waiting for IQ…", big = d.wide)
                WaterfallView(spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)),
                    rows = if (d.wide) 160 else 70, traceFrac = 0.35f, labels = centredLabels(freq, SdrEngine.currentRate()),
                    onPreviewFrac = onPreview, onTapFrac = onTune)
            }
        }
    ) {
        SectionLabel("BAND · MHz · the American four span 14 MHz, wider than one slice, so hearing them all means visiting each")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for ((label, hz) in Devices.BANDS.take(5)) Chip(label, selected = freq == hz, accent = accent, modifier = Modifier.weight(1f)) { Devices.pickFreq(hz) }
        }
        Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for ((label, hz) in Devices.BANDS.drop(5)) Chip(label, selected = freq == hz, accent = accent, modifier = Modifier.weight(1f)) { Devices.pickFreq(hz) }
        }
        StepperRow(accent, longArrayOf(1_000_000L, 100_000L, 10_000L))
        SectionLabel("LISTEN ACROSS · narrower hears weaker devices, wider finds ones off the dial")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for ((label, hz) in Devices.SPANS) Chip(label, selected = span == hz, accent = accent, modifier = Modifier.weight(1f)) { Devices.setSpan(hz) }
            Chip(if (hop) "HOP ON" else "HOP OFF", selected = hop, accent = accent, modifier = Modifier.weight(1f)) { Devices.setHop(!hop) }
        }
        GainRow(accent)
        val stats = if (rep.span > 0) buildString {
            append("${Devices.BANDS[band].first} MHz · ${rep.protocols} protocols · ${rep.bursts} bursts (${rep.ook} keyed, ${rep.fsk} shifted) · ${rep.decoded} decoded")
            if (rep.badChecksum > 0) append(" · ${rep.badChecksum} failed their checksum")
            append(" · listening across ${Devices.spanLabel(rep.span)} · noise ${rep.noise}, triggers above ${rep.trigger}")
        } else "listening…"
        Text(stats, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.dp(6f)))
        Row(Modifier.fillMaxWidth().padding(top = d.dp(6f), bottom = d.dp(4f)), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            val count = if (showProtocols) "${Devices.protocols.size} PROTOCOLS · ALL RUNNING"
                else "${heard.size} DEVICE${if (heard.size == 1) "" else "S"}"
            Text(count, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, modifier = Modifier.weight(1f))
            Row(horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                Chip(if (showProtocols) "DEVICES" else "PROTOCOLS ${Devices.protocols.size}", selected = showProtocols, accent = accent) { showProtocols = !showProtocols }
                Chip("PAUSE", selected = paused != null, accent = accent) { paused = if (paused == null) live else null }
                Chip("CLEAR", selected = false, accent = accent) { Devices.proc.clear(); if (paused != null) paused = emptyList() }
            }
        }
        if (showProtocols) ProtocolList(Devices.protocols, Modifier.fillMaxWidth().weight(1f))
        else DeviceList(heard, accent, Modifier.fillMaxWidth().weight(1f))
    }
}

@Composable
private fun DeviceList(heard: List<HeardDevice>, accent: Color, modifier: Modifier) {
    val d = rememberDims()
    val state = rememberLazyListState()
    Box(modifier.panel()) {
        if (heard.isEmpty()) {
            Text("nothing yet — most of these report every thirty to sixty seconds, so give it a minute",
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(d.dp(10f)))
            return@Box
        }
        LazyColumn(Modifier.fillMaxSize().scrollGlow(state).padding(horizontal = d.dp(6f), vertical = d.dp(4f)), state = state) {
            itemsIndexed(heard, key = { _, h -> h.key }) { i, h -> DeviceRow(h, i, accent) }
        }
    }
}

/**
 * One device and everything it sent; always shown, since comparing two sensors one tap at a time is worse than scrolling.
 * The fields with an explanation are underlined, and tapping one shows it under the row.
 */
@Composable
private fun DeviceRow(h: HeardDevice, i: Int, accent: Color) {
    val d = rememberDims()
    var why by remember { mutableStateOf<String?>(null) }
    val toggle: (String) -> Unit = { k -> why = if (why == k) null else k }
    val explained = TextLinkStyles(SpanStyle(textDecoration = TextDecoration.Underline))
    val doubtful = h.num in Devices.doubtful
    val mic = h.data["mic"]?.toString() ?: ""
    val id = listOfNotNull(h.data["id"]?.let { fmtValue(it) }, h.data["channel"]?.let { "ch ${fmtValue(it)}" }).joinToString(" ")
    Column(Modifier.fillMaxWidth()
        .background(if (i % 2 == 0) Color.Transparent else Palette.panel.copy(alpha = 0.6f), RoundedCornerShape(3.dp))
        .padding(vertical = d.dp(5f), horizontal = d.dp(4f))) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(buildAnnotatedString {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = Palette.ink)) { append(h.model) }
                if (id.isNotEmpty()) withStyle(SpanStyle(color = Palette.muted)) { append("  $id") }
                when {
                    doubtful -> withStyle(SpanStyle(color = Palette.accent2)) { append("  ?") }
                    mic.isNotEmpty() -> withStyle(SpanStyle(color = accent)) { append("  ✓") }
                }
            }, fontFamily = Mono, fontSize = d.sp(12f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text("${h.count}×", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(horizontal = d.dp(6f)))
            Text(Devices.clock(h.lastSeen), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
        }
        val reading = Devices.summary(h.data)
        if (reading.isNotEmpty()) Text(reading, color = accent, fontFamily = Mono, fontSize = d.sp(12f), fontWeight = FontWeight.Bold)
        // Everything else it sent. A couple of values already read as a sentence and carry no label.
        Text(buildAnnotatedString {
            var first = true
            for ((k, v) in h.data) {
                if (k == "model" || k in Devices.LONG) continue
                if (!first) append("   ")
                first = false
                val field: () -> Unit = {
                    if (k != "battery_ok" && k != "leak_detected") withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = Palette.ink)) { append(k.replace('_', ' ') + " ") }
                    append(Devices.value(k, v))
                }
                if (k in Devices.MEANING) withLink(LinkAnnotation.Clickable(k, explained) { toggle(k) }) { field() } else field()
            }
            withStyle(SpanStyle(color = Palette.muted)) {
                append("   ${h.what}${if (h.num != 0) " · rtl_433 protocol ${h.num}" else ""} · first heard ${Devices.clock(h.firstSeen)}")
            }
            if (doubtful) withStyle(SpanStyle(color = Palette.accent2)) { append("   no checksum — nothing in the frame proves this reading") }
        }, color = Palette.ink.copy(alpha = 0.82f), fontFamily = Mono, fontSize = d.sp(10.5f))
        for ((k, v) in h.data) {
            if (k !in Devices.LONG || k == "summary") continue
            val explains = k in Devices.MEANING
            Text(buildAnnotatedString {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold, textDecoration = if (explains) TextDecoration.Underline else null)) { append(k.replace('_', ' ')) }
                append(" " + fmtValue(v))
            }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = if (explains) Modifier.clickable { toggle(k) } else Modifier)
        }
        why?.let { k ->
            Text("${k.replace('_', ' ')} — ${Devices.MEANING[k] ?: ""}", color = Palette.accent2, fontFamily = Mono, fontSize = d.sp(10f),
                modifier = Modifier.fillMaxWidth().clickable { why = null }.padding(top = d.dp(3f)))
        }
    }
}

/** Everything the receiver can recognise, so "nothing there" can be told from "not supported". */
@Composable
private fun ProtocolList(protocols: List<R433Protocol>, modifier: Modifier) {
    val d = rememberDims()
    val state = rememberLazyListState()
    Box(modifier.panel()) {
        LazyColumn(Modifier.fillMaxSize().scrollGlow(state).padding(horizontal = d.dp(6f), vertical = d.dp(4f)), state = state) {
            item {
                Text("Every one of these runs over every burst, so nothing has to be chosen in advance: whatever transmits nearby is " +
                    "decoded. Weather stations and tire sensors, but also door contacts and motion detectors, gas and electricity " +
                    "meters, gate and blind remotes, doorbells, smoke alarms, leak detectors and cooking probes — anything that talks " +
                    "in the clear. Bursts that none of them claim are still listed, described by their timings.",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f), modifier = Modifier.padding(horizontal = d.dp(4f), vertical = d.dp(6f)))
            }
            itemsIndexed(protocols, key = { _, p -> p.num }) { i, p ->
                Row(Modifier.fillMaxWidth()
                    .background(if (i % 2 == 0) Color.Transparent else Palette.panel.copy(alpha = 0.6f), RoundedCornerShape(3.dp))
                    .padding(vertical = d.dp(3f), horizontal = d.dp(4f))) {
                    Text("${p.num}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10.5f), modifier = Modifier.width(d.dp(34f)))
                    Column(Modifier.weight(1f)) {
                        Text(p.name, color = if (p.doubtful) Palette.muted else Palette.ink, fontFamily = Mono, fontSize = d.sp(11f))
                        Text(buildString {
                            append(p.what.ifEmpty { "—" })
                            append(" · ${p.coding}")
                            if (p.bands.isNotEmpty()) append(" · ${p.bands.joinToString(", ") { fmtValue(it) }} MHz")
                            if (p.doubtful) append(" · no checksum, readings unverified")
                        }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
                    }
                }
            }
        }
    }
}
