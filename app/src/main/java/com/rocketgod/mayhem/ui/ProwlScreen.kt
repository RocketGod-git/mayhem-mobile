package com.rocketgod.mayhem.ui

import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.border
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import kotlin.math.abs
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
    val held = v.held

    val chBw = (t?.bw ?: 12_500.0).coerceAtLeast(6_000.0)
    val chFrac = (0.5 + offset.toDouble() / rate).toFloat()
    val channel = if (offset != 0) (chFrac - (chBw / 2 / rate).toFloat()) to (chFrac + (chBw / 2 / rate).toFloat()) else null
    val voice = t != null && t.judged && v.score >= Prowl.VOICE
    val (head, mid, low) = when {
        t != null -> Triple("${t.cls.ifEmpty { "unclassified" }} · ${t.peak.roundToInt()} dB · ${v.dwellS}s".uppercase(),
            "speech ${"%.2f".format(v.score)} · best ${"%.2f".format(v.best)}${if (t.judged) "" else " · deciding"}", "")
        held != null -> Triple("HOLDING HERE", "listening until you press HUNT", "${v.seen} in view · ${v.remembered} remembered")
        else -> Triple("${v.seen} IN VIEW · ${v.ready} WORTH A TRY", "${v.remembered} remembered${if (v.sweep) " · ${v.band.ifEmpty { "this span" }}" else ""}", "")
    }
    AdaptivePane(
        visualHeightNarrow = d.dp(170f),
        face = {
            FreqCard(accent, tag = if (t != null) mode.name else "PROWL", title = head, titleColor = if (voice) Palette.ok else Palette.muted, freq = lo + offset,
                // how much it sounds like speech: the hunt keeps a channel once this passes the mark
                meter = if (t != null) v.score.toFloat().coerceIn(0f, 1f) else 0f, tick = Prowl.VOICE.toFloat(),
                scale = listOf(0f to "0", 0.5f to "0.5", 1f to "1.0 SPEECH"),
                left = if (t != null) "SPEECH %.2f · best %.2f".format(v.score, v.best) else "SPEECH —",
                right = listOf(mid, low).filter { it.isNotEmpty() }.joinToString(" · ").let { if (t != null) low.ifEmpty { if (t.judged) "judged" else "deciding" } else it },
                lamp = {
                    when {
                        voice -> Lamp("VOICE", Palette.ok)
                        held != null -> Lamp("HOLDING", Palette.ok)
                        v.on -> Lamp("HUNTING", Palette.accent2, blink = true)
                        else -> Lamp("STOPPED", Palette.muted)
                    }
                })
        },
        visual = { m ->
            Box(m.clip(RoundedCornerShape(d.dp(12f))).border(1.dp, Palette.line, RoundedCornerShape(d.dp(12f)))) {
                WaterfallView(spec, SdrEngine.SPEC_BINS, accent, Modifier.fillMaxSize(),
                    rows = if (d.wide) 160 else 80, traceFrac = 0.38f, centreMarker = offset == 0, channel = channel,
                    labels = centredLabels(lo, rate),
                    onPreviewFrac = { f -> Tuning.previewHz = f?.let { spanHz(lo, rate, it) } },
                    onTapFrac = { frac -> Prowl.holdAt(spanHz(lo, rate, frac).toDouble()) })
            }
        }
    ) {
        ScrollColumn(Modifier.fillMaxWidth()) {
          Column(Modifier.fillMaxWidth().padding(top = d.dp(6f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                ToggleBox(if (v.on) "STOP HUNTING" else "HUNT", v.on, if (v.on) Palette.danger else accent, Modifier.weight(2f).fillMaxHeight()) { if (v.on) Prowl.stop() else Prowl.start() }
                ToggleBox(if (v.on) "SKIP" else "NEXT", false, accent, Modifier.weight(1f).fillMaxHeight()) { Prowl.skip() }
            }
            if (v.note.isNotEmpty()) Text(v.note, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
            // What the signal finder sees, so a tap can go straight to one.
            val inView = signals.sortedByDescending { it.snr }.take(8)
            if (inView.isNotEmpty()) TileRow(inView.map { s ->
                Tile("%.3f".format(s.hz / 1e6), (if (s.cls.isNotEmpty()) "${s.cls}${if (s.conf < 0.6) "?" else ""} · " else "") + "${s.snr.roundToInt()} dB",
                    t != null && abs(t.hz - s.hz) < 5_000)
            }, accent, width = 96.dp) { Prowl.holdAt(inView[it].hz) }
            // wider hears more at once, narrower hears further into the noise
            val whys = Prowl.SPANS.map { com.rocketgod.mayhem.core.Radio.rateWhy(it.second) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("SPAN")
                SegBar(Prowl.SPANS.map { it.first }, Prowl.SPANS.indexOfFirst { it.second == rate }, accent, Modifier.weight(1f),
                    tints = whys.map { if (it.isNotEmpty()) Palette.muted.copy(alpha = 0.45f) else null }) { i -> gated(whys[i]) { Prowl.setSpan(Prowl.SPANS[i].second) }() }
            }
            // when this span goes quiet: stay, or move to another band
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("QUIET")
                SegBar(listOf("STAY HERE", "MOVE ON"), if (v.sweep) 1 else 0, accent, Modifier.weight(1f)) { if ((it == 1) != v.sweep) Prowl.toggleSweep() }
            }
          }
            Row(Modifier.fillMaxWidth().padding(top = d.dp(8f), bottom = d.dp(4f)), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("HEARD", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 2.sp)
                IconBox(ClearIcon, "Clear") { Prowl.clearLog() }
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
