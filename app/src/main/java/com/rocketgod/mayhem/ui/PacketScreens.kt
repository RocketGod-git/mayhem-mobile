package com.rocketgod.mayhem.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.AdsbStore
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.apps.BtleDecoder
import com.rocketgod.mayhem.core.apps.PagerDecoder

/** Shared layout for the packet receivers: readout + waterfall (visual pane), controls, count, decoded log. */
@Composable
private fun PacketFrame(accent: Color, log: PacketLog, tunable: Boolean = true, controls: @Composable () -> Unit, list: (@Composable () -> Unit)? = null) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val health by SdrEngine.rxHealth.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val count by log.count.collectAsState()
    val lines by log.lines.collectAsState()
    val onPreview: (Float?) -> Unit = { f -> Tuning.previewHz = f?.let { spanHz(freq, SdrEngine.currentRate(), it) } }
    val onTune: (Float) -> Unit = { frac -> SdrEngine.tune(spanHz(freq, SdrEngine.currentRate(), frac)) }
    AdaptivePane(
        visualHeightNarrow = d.dp(190f),
        visual = { m ->
            Column(m) {
                FreqReadout(accent, if (health.isNotEmpty()) health else "waiting for IQ…", big = d.wide)
                WaterfallView(spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)),
                    rows = if (d.wide) 160 else 70, traceFrac = 0.35f, labels = centredLabels(freq, SdrEngine.currentRate()),
                    onPreviewFrac = if (tunable) onPreview else null, onTapFrac = if (tunable) onTune else null)
            }
        }
    ) {
        controls()
        GainRow(accent)
        Row(Modifier.fillMaxWidth().padding(top = d.dp(8f), bottom = d.dp(4f)), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("$count DECODED", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 2.sp)
            Text("CLEAR", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 2.sp,
                modifier = Modifier.padding(start = 12.dp).clickable { log.clear() })
        }
        if (list != null) list()
        LogList(lines, Modifier.fillMaxWidth().weight(1f))
    }
}

@Composable
fun AisScreen(accent: Color) {
    val d = rememberDims()
    var showTable by remember { mutableStateOf(false) }
    val table by Apps.ais.table.collectAsState()
    val tableList: @Composable () -> Unit = {
        Box(Modifier.fillMaxWidth().padding(bottom = d.dp(6f)).panel(Palette.accent2)) {
            LazyColumn(Modifier.fillMaxWidth().padding(d.dp(6f))) {
                items(table) { Text(it, color = Palette.accent2, fontFamily = Mono, fontSize = d.sp(11f), maxLines = 1) }
            }
        }
    }
    PacketFrame(accent, Apps.aisLog, controls = {
        PresetRow(accent, listOf("AIS A 161.975" to 161_975_000L, "AIS B 162.025" to 162_025_000L), title = "CHANNEL")
        SectionLabel("VIEW")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip("LOG", selected = !showTable, accent = accent, modifier = Modifier.weight(1f)) { showTable = false }
            Chip("VESSELS ${table.size}", selected = showTable, accent = accent, modifier = Modifier.weight(1f)) { showTable = true }
        }
    }, list = if (showTable) tableList else null)
}

@Composable
fun AprsScreen(accent: Color) {
    PacketFrame(accent, Apps.aprsLog, controls = {
        PresetRow(accent, listOf("NA 144.39" to 144_390_000L, "EU 144.80" to 144_800_000L, "AU 145.175" to 145_175_000L, "JP 144.64" to 144_640_000L), title = "REGION")
    })
}

@Composable
fun PagerScreen(accent: Color) {
    val d = rememberDims()
    val which by Apps.pager.which.collectAsState()
    PacketFrame(accent, Apps.pagerLog, controls = {
        SectionLabel("DECODER · FLEX 1600/3200 2L/4L · POCSAG 512/1200/2400")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (w in PagerDecoder.Which.entries) Chip(w.label, selected = which == w, accent = accent, modifier = Modifier.weight(1f)) { Apps.pager.select(w) }
        }
        PresetRow(accent, listOf("929.6125" to 929_612_500L, "929.6625" to 929_662_500L, "931.9375" to 931_937_500L, "466.175" to 466_175_000L), title = "CHANNEL · MHz")
        StepperRow(accent, longArrayOf(100_000L, 12_500L, 2_500L))
    })
}

@Composable
fun TpmsScreen(accent: Color) {
    PacketFrame(accent, Apps.tpmsLog, controls = {
        PresetRow(accent, listOf("315.000 · US" to 315_000_000L, "433.920 · EU" to 433_920_000L), title = "BAND · MHz")
        SectionLabel("DECODES · FSK 19.2k Schrader FLM 64/72/80 · OOK 8.192k Schrader · OOK 8.4k GMC — drive past parked cars, readings repeat every minute or so")
    })
}

@Composable
fun AcarsScreen(accent: Color) {
    PacketFrame(accent, Apps.acarsLog, controls = {
        PresetRow(accent, listOf("131.550 US" to 131_550_000L, "131.525 EU" to 131_525_000L, "131.725 EU2" to 131_725_000L, "131.450 JP" to 131_450_000L, "130.025" to 130_025_000L), title = "CHANNEL · MHz")
        StepperRow(accent, longArrayOf(1_000_000L, 25_000L, 5_000L))
        SectionLabel("AM · 2400 bps MSK · registration, label, block, message number, flight, text · CRC-16 checked")
    })
}

@Composable
fun SubGhzScreen(accent: Color) {
    val d = rememberDims()
    var wx by remember { mutableStateOf(Apps.ism.weather) }
    var rc by remember { mutableStateOf(Apps.ism.remotes) }
    var car by remember { mutableStateOf(Apps.ism.cars) }
    PacketFrame(accent, Apps.ismLog, controls = {
        PresetRow(accent, listOf("433.92" to 433_920_000L, "315.00" to 315_000_000L, "868.35" to 868_350_000L, "915.00" to 915_000_000L, "303.875" to 303_875_000L), title = "BAND · MHz")
        StepperRow(accent, longArrayOf(1_000_000L, 100_000L, 10_000L))
        SectionLabel("FAMILIES · every protocol runs at once; tap to mute a family")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip("WEATHER 26", selected = wx, accent = accent, modifier = Modifier.weight(1f)) { wx = !wx; Apps.ism.weather = wx }
            Chip("REMOTES 47", selected = rc, accent = accent, modifier = Modifier.weight(1f)) { rc = !rc; Apps.ism.remotes = rc }
            Chip("CAR KEYS 11", selected = car, accent = accent, modifier = Modifier.weight(1f)) { car = !car; Apps.ism.cars = car }
        }
    })
}

@Composable
fun ErtScreen(accent: Color) {
    val d = rememberDims()
    val rate by SdrEngine.rateHz.collectAsState()
    PacketFrame(accent, Apps.ertLog, controls = {
        PresetRow(accent, listOf("911.6" to 911_600_000L, "915.0" to 915_000_000L, "920.0" to 920_000_000L), title = "CENTRE · MHz")
        SectionLabel("IQ RATE")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip("2.0 Msps", selected = rate == 2_000_000, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.setRate(2_000_000) }
            Chip("4.194 Msps · Mayhem", selected = rate == 4_194_304, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.setRate(4_194_304) }
        }
    })
}

@Composable
fun BtleScreen(accent: Color) {
    val d = rememberDims()
    val freq by SdrEngine.freqHz.collectAsState()
    PacketFrame(accent, Apps.btleLog, tunable = false, controls = {
        SectionLabel("ADVERTISING CHANNEL")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (ch in intArrayOf(37, 38, 39)) {
                val hz = BtleDecoder.channelFreq(ch)
                Chip("CH $ch · ${hz / 1_000_000}", selected = freq == hz, accent = accent, modifier = Modifier.weight(1f)) {
                    Apps.btle.channel = ch; SdrEngine.tune(hz)
                }
            }
        }
    })
}

@Composable
fun AdsbScreen(accent: Color) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val health by SdrEngine.rxHealth.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val planes by AdsbStore.flow.collectAsState()
    val frames by AdsbStore.frames.collectAsState()
    val home by Geo.fix.collectAsState()
    var showMap by remember { mutableStateOf(true) }
    var selected by remember { mutableStateOf<String?>(null) }
    val ctx = LocalContext.current
    LaunchedEffect(Unit) { Geo.start(ctx) }
    AdaptivePane(
        visualHeightNarrow = d.dp(190f),
        visual = { m ->
            Column(m) {
                FreqReadout(accent, if (health.isNotEmpty()) health else "waiting for IQ…", big = d.wide)
                WaterfallView(spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)),
                    rows = if (d.wide) 160 else 70, traceFrac = 0.35f, labels = centredLabels(freq, SdrEngine.currentRate()))
            }
        }
    ) {
        GainRow(accent)
        Row(Modifier.fillMaxWidth().padding(top = d.dp(8f), bottom = d.dp(4f)), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("✈ $frames MODE-S FRAMES · ${planes.size} AIRCRAFT", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 1.sp, modifier = Modifier.weight(1f))
            Row(horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                Chip("MAP", selected = showMap, accent = accent) { showMap = true }
                Chip("LIST", selected = !showMap, accent = accent) { showMap = false }
            }
        }
        val sel = planes.firstOrNull { it.icao == selected }
        if (sel != null) {
            Text("%s %s · %s · %s · %s · %s".format(sel.icao.uppercase(), sel.flight ?: "", sel.altBaro?.let { "${it} ft" } ?: "alt ?", sel.gs?.let { "${it} kt" } ?: "gs ?", sel.track?.let { "$it°" } ?: "trk ?",
                if (sel.lat != null && sel.lon != null) "%.3f,%.3f".format(sel.lat, sel.lon) else "no pos"),
                color = Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, modifier = Modifier.fillMaxWidth().padding(bottom = d.dp(4f)))
        }
        if (showMap) {
            AdsbMap(planes, accent, home, selected, Modifier.fillMaxWidth().weight(1f).panel()) { selected = it }
        } else Box(Modifier.fillMaxWidth().weight(1f).panel()) {
            if (planes.isEmpty()) Text("listening on 1090 MHz…", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(d.dp(10f)))
            LazyColumn(Modifier.fillMaxSize().padding(d.dp(6f))) {
                items(planes, key = { it.icao }) { a ->
                    val la = a.lat; val lo = a.lon
                    val pos = if (la != null && lo != null) "%.3f,%.3f".format(la, lo) else "no pos"
                    Row(Modifier.fillMaxWidth().clickable { selected = a.icao; showMap = a.lat != null }.padding(vertical = d.dp(3f)), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("%s %-8s".format(a.icao.uppercase(), a.flight ?: ""), color = if (a.icao == selected) Palette.accent2 else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1)
                        Text("%6s %5s %4s %s".format(a.altBaro?.let { "${it}ft" } ?: "", a.gs?.let { "${it}kt" } ?: "", a.track?.let { "$it°" } ?: "", pos),
                            color = Palette.ink.copy(alpha = 0.8f), fontFamily = Mono, fontSize = d.sp(11f), maxLines = 1)
                    }
                }
            }
        }
    }
}
