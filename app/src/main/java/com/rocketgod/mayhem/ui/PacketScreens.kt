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
