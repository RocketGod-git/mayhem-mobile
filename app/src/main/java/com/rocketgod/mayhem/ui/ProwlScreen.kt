package com.rocketgod.mayhem.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
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
import com.rocketgod.mayhem.core.Prowl
import com.rocketgod.mayhem.core.SdrEngine
import kotlin.math.roundToInt

/** Hunts live voice across the bands. Twin of the web app's Prowl view. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProwlScreen(accent: Color) {
    val d = rememberDims()
    val spec by SdrEngine.spectrum.collectAsState()
    val health by SdrEngine.rxHealth.collectAsState()
    val lo by SdrEngine.freqHz.collectAsState()
    val offset by SdrEngine.offsetHz.collectAsState()
    val rate by SdrEngine.rateHz.collectAsState()
    val mode by SdrEngine.mode.collectAsState()
    val signals by SdrEngine.signals.collectAsState()
    val v by Prowl.view.collectAsState()
    val t = v.target

    val chBw = (t?.bw ?: 12_500.0).coerceAtLeast(6_000.0)
    val chFrac = (0.5 + offset.toDouble() / rate).toFloat()
    val channel = if (offset != 0) (chFrac - (chBw / 2 / rate).toFloat()) to (chFrac + (chBw / 2 / rate).toFloat()) else null
    AdaptivePane(
        visualHeightNarrow = d.dp(170f),
        visual = { m ->
            Column(m) {
                FreqReadout(accent, if (health.isNotEmpty()) health else "waiting for IQ…", big = d.wide, channelHz = lo + offset)
                WaterfallView(spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)),
                    rows = if (d.wide) 160 else 70, traceFrac = 0.35f, centreMarker = offset == 0, channel = channel,
                    labels = centredLabels(lo, rate),
                    onPreviewFrac = { f -> Tuning.previewHz = f?.let { spanHz(lo, rate, it) } },
                    onTapFrac = { frac -> Prowl.holdAt(spanHz(lo, rate, frac).toDouble()) })
            }
        }
    ) {
        ScrollColumn(Modifier.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                Chip(if (v.on) "STOP HUNTING" else "HUNT", selected = v.on, accent = accent, modifier = Modifier.weight(2f)) { if (v.on) Prowl.stop() else Prowl.start() }
                Chip(if (v.on) "SKIP" else "NEXT", selected = false, accent = accent, modifier = Modifier.weight(1f)) { Prowl.skip() }
            }
            SectionLabel("NOW")
            val voice = t != null && t.judged && v.score >= Prowl.VOICE
            Column(Modifier.fillMaxWidth().panel(if (voice) Palette.ok else Palette.line).padding(d.dp(8f))) {
                val (head, mid, low) = when {
                    t != null -> Triple("${Prowl.mhz(t.hz)} MHz · $mode",
                        "${t.cls.ifEmpty { "unclassified" }} · ${t.peak.roundToInt()} dB · ${v.dwellS}s",
                        "speech ${"%.2f".format(v.score)}, best ${"%.2f".format(v.best)}${if (t.judged) "" else " · deciding"}")
                    v.held != null -> Triple("HOLDING ${Prowl.mhz(v.held)} MHz", "listening here until you press HUNT",
                        "${v.seen} in view · ${v.remembered} remembered")
                    else -> Triple(if (v.on) "HUNTING" else "STOPPED", "${v.seen} in view · ${v.ready} worth a try",
                        "${v.remembered} remembered${if (v.sweep) " · ${v.band.ifEmpty { "this span" }}" else ""}")
                }
                Text(head, color = if (voice) Palette.ok else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f))
                Text(mid, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f))
                Text(low, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
            }
            if (v.note.isNotEmpty()) Text(v.note, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.dp(4f)))
            // What the signal finder sees, so a tap can go straight to one.
            val inView = signals.sortedByDescending { it.snr }.take(8)
            if (inView.isNotEmpty()) {
                SectionLabel("IN VIEW · tap to listen")
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    for (s in inView) {
                        val label = "%.3f".format(s.hz / 1e6) + (if (s.cls.isNotEmpty()) " ${s.cls}${if (s.conf < 0.6) "?" else ""}" else "") + " ${s.snr.roundToInt()}dB"
                        Text(label, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f),
                            modifier = Modifier.control(accent, false).clickable { Prowl.holdAt(s.hz) }.padding(horizontal = d.dp(8f), vertical = d.dp(5f)))
                    }
                }
            }
            SectionLabel("SPAN · wider hears more at once, narrower hears further into the noise")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for ((label, hz) in Prowl.SPANS) Chip(label, selected = rate == hz, accent = accent, modifier = Modifier.weight(1f)) { Prowl.setSpan(hz) }
            }
            SectionLabel("WHEN THIS SPAN GOES QUIET")
            Chip(if (v.sweep) "MOVE TO ANOTHER BAND" else "STAY WHERE I PUT IT", selected = v.sweep, accent = accent, modifier = Modifier.fillMaxWidth()) { Prowl.toggleSweep() }
            GainRow(accent)
            Row(Modifier.fillMaxWidth().padding(top = d.dp(8f), bottom = d.dp(4f)), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("HEARD", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 2.sp)
                Text("CLEAR", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 2.sp,
                    modifier = Modifier.clickable { Prowl.clearLog() }.padding(start = 12.dp))
            }
            if (v.log.isEmpty()) {
                Text("nothing heard yet, press HUNT", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(2.dp))
            } else {
                // Everything it stopped on, kept or not: tap one to hold the receiver there.
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    for (h in v.log) {
                        val ink = if (h.kept) inkOn(accent) else Palette.muted
                        Row(Modifier.control(accent, h.kept).padding(vertical = d.dp(6f)).padding(start = d.dp(10f), end = d.dp(4f)), verticalAlignment = Alignment.CenterVertically) {
                            Text("${Prowl.mhz(h.hz)} · ${h.secs.roundToInt()}s · ${"%.2f".format(h.score)}${if (h.kept) "" else " · ${h.why.ifEmpty { "not speech" }}"}",
                                color = ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.clickable { Prowl.holdAt(h.hz, h.mode) })
                            Text("✕", color = ink, fontFamily = Mono, fontSize = d.sp(11f),
                                modifier = Modifier.padding(start = 6.dp).clickable { Prowl.removeHit(h) }.padding(horizontal = 6.dp))
                        }
                    }
                }
            }
        }
    }
}
