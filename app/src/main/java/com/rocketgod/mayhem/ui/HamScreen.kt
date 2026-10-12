package com.rocketgod.mayhem.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.ham.BANDS
import com.rocketgod.mayhem.core.ham.Ham
import com.rocketgod.mayhem.core.ham.HamDemod.AgcMode
import com.rocketgod.mayhem.core.ham.HamDemod.Mode
import com.rocketgod.mayhem.core.ham.NON_HAM
import com.rocketgod.mayhem.core.ham.bandOf
import com.rocketgod.mayhem.core.ham.repeaterInput
import com.rocketgod.mayhem.core.ham.segmentOf

/**
 * HAM: a proper channel receiver — any mode, any filter width, anywhere in the HackRF's span — on a panadapter
 * that stays still while you tune. Twin of the web app's HAM receive tab.
 */
@Composable
fun HamScreen(accent: Color) {
    val d = rememberDims()
    val s by Ham.state.collectAsState()
    val spec by SdrEngine.spectrum.collectAsState()
    val rate = SdrEngine.currentRate()

    AdaptivePane(
        visualHeightNarrow = d.dp(300f),
        visual = { mod ->
            Column(mod) {
                HamReadout(accent)
                HamPanadapter(accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)), spec, s, rate)
            }
        }
    ) {
        ScrollColumn(Modifier.fillMaxWidth()) {
            SectionLabel("BAND")
            ChipGrid(BANDS + NON_HAM, columns = 5) { b ->
                Chip(b.name, selected = bandOf(s.channel)?.id == b.id, accent = accent, modifier = Modifier.weight(1f)) { Ham.pickBand(b) }
            }

            SectionLabel("MODE")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for (md in listOf(Mode.LSB, Mode.USB, Mode.CW, Mode.AM, Mode.NFM, Mode.WFM)) {
                    Chip(md.name, selected = s.mode == md, accent = accent, modifier = Modifier.weight(1f)) { Ham.setMode(md) }
                }
            }

            SectionLabel("TUNE")
            val steps = when (s.mode) {
                Mode.USB, Mode.LSB, Mode.CW -> longArrayOf(10_000, 1_000, 100)
                Mode.WFM -> longArrayOf(1_000_000, 200_000, 100_000)
                else -> longArrayOf(100_000, 25_000, 12_500)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for (st in steps) Chip("−" + stepLabel(st), false, accent, Modifier.weight(1f)) { Ham.nudge(-st) }
                for (st in steps.reversed()) Chip("+" + stepLabel(st), false, accent, Modifier.weight(1f)) { Ham.nudge(st) }
            }

            SectionLabel(if (s.mode == Mode.CW) "FILTER · Hz around the pitch" else "FILTER · Hz")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for ((label, w) in Ham.WIDTHS.getValue(s.mode)) {
                    Chip(label, selected = s.width == w, accent = accent, modifier = Modifier.weight(1f)) { Ham.setWidth(w) }
                }
            }

            if (s.mode == Mode.USB || s.mode == Mode.LSB) {
                SectionLabel("PASSBAND SHIFT · ${s.shift.toInt()} Hz")
                Slider(
                    value = s.shift.toFloat(), onValueChange = { Ham.setShift(Math.round(it / 50f) * 50.0) },
                    valueRange = -600f..600f, steps = 23,
                    colors = SliderDefaults.colors(thumbColor = accent, activeTrackColor = accent, inactiveTrackColor = Palette.line),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            if (s.mode == Mode.CW) {
                SectionLabel("CW PITCH · Hz")
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                    for (p in listOf(500.0, 600.0, 700.0, 800.0)) {
                        Chip(p.toInt().toString(), selected = s.pitch == p, accent = accent, modifier = Modifier.weight(1f)) { Ham.setPitch(p) }
                    }
                }
            }

            SectionLabel("AGC · DSP")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for (a in AgcMode.entries) {
                    Chip("AGC ${a.name}", selected = s.agc == a, accent = accent, modifier = Modifier.weight(1f)) { Ham.setAgc(a) }
                }
                Chip("NR", selected = s.nr, accent = accent, modifier = Modifier.weight(1f)) { Ham.toggleNr() }
                Chip("NOTCH", selected = s.anf, accent = accent, modifier = Modifier.weight(1f)) { Ham.toggleAnf() }
            }

            if (s.mode == Mode.NFM) {
                SectionLabel("SQUELCH · dB over floor")
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                    for (q in listOf(0, 3, 6, 10, 15)) {
                        Chip(if (q == 0) "OFF" else "$q", selected = s.squelch == q, accent = accent, modifier = Modifier.weight(1f)) { Ham.setSquelch(q) }
                    }
                    // Repeater reverse: only meaningful where the channel is a repeater output.
                    if (s.rev || repeaterInput(s.channel) != null) {
                        Chip("REV", selected = s.rev, accent = accent, modifier = Modifier.weight(1f)) { Ham.toggleReverse() }
                    }
                }
            }

            SectionLabel("VOLUME")
            Slider(
                value = s.volume, onValueChange = { Ham.setVolume(it) }, valueRange = 0f..2f,
                colors = SliderDefaults.colors(thumbColor = accent, activeTrackColor = accent, inactiveTrackColor = Palette.line),
                modifier = Modifier.fillMaxWidth(),
            )

            GainRow(accent)
            Spacer(Modifier.height(d.dp(12f)))
        }
    }
}

/** Channel frequency, where it sits in the band plan, the S-meter and what the squelch / AGC is doing. */
@Composable
private fun HamReadout(accent: Color) {
    val d = rememberDims()
    val s by Ham.state.collectAsState()
    val m by Ham.demod.meter.collectAsState()
    val dbm = Ham.dbm(m.db)
    val mhz = s.channel / 1_000_000L
    val khz = (s.channel / 1000L) % 1000L
    val hz = s.channel % 1000L

    Column(Modifier.fillMaxWidth().panel().padding(d.dp(8f))) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text("$mhz.", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(30f))
            Text("%03d".format(khz), color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(30f))
            Text(".%03d".format(hz), color = accent, fontFamily = Mono, fontSize = d.sp(18f), modifier = Modifier.padding(bottom = d.dp(4f)))
            Text("  ${s.mode.name}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f),
                modifier = Modifier.padding(bottom = d.dp(5f)))
        }
        Text(segmentOf(s.channel).ifEmpty { "out of band" } + if (s.rev) " · REVERSE" else "",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 1.sp)

        // S-meter: S0 at the left, S9 marked, S9+60 at the right edge.
        val frac = Ham.meterFrac(dbm, s.channel)
        val bar = if (dbm > Ham.s9(s.channel) + 30) Palette.danger else accent
        val track = Palette.panel
        val tick = Palette.ink.copy(alpha = 0.6f)
        Canvas(Modifier.fillMaxWidth().padding(top = d.dp(6f)).height(d.dp(10f))) {
            drawRoundRect(track, cornerRadius = CornerRadius(3f, 3f))
            drawRoundRect(bar, size = Size(size.width * frac, size.height), cornerRadius = CornerRadius(3f, 3f))
            for (u in 1..9) {
                val x = size.width * (u * 6f) / 114f
                drawLine(tick, Offset(x, if (u == 9) 0f else size.height * 0.6f), Offset(x, size.height), strokeWidth = if (u == 9) 2f else 1f)
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = d.dp(3f)), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("%s · %.0f dBm est · +%.0f dB".format(Ham.sUnits(dbm, s.channel), dbm, m.db - m.floor),
                color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
            Text(Ham.statusLine(m, s), color = if (s.mode == Mode.NFM && m.open) accent else Palette.muted,
                fontFamily = Mono, fontSize = d.sp(10f), fontWeight = FontWeight.Bold)
        }
    }
}

/** The panadapter: centred on the LO, with the receiver's pass band shaded where the channel actually sits. */
@Composable
private fun HamPanadapter(accent: Color, modifier: Modifier, spec: FloatArray, s: Ham.State, rate: Int) {
    val (lo, hi) = when (s.mode) {
        Mode.USB -> (s.pbLo + s.shift) to (s.pbHi + s.shift)
        Mode.LSB -> -(s.pbHi + s.shift) to -(s.pbLo + s.shift)
        Mode.CW -> -(s.pbHi - s.pbLo) / 2 to (s.pbHi - s.pbLo) / 2
        else -> -s.pbHi to s.pbHi
    }
    val off = (s.channel - s.lo).toDouble()
    val a = (0.5 + (off + lo) / rate).toFloat()
    val b = (0.5 + (off + hi) / rate).toFloat()
    WaterfallView(
        spec, SdrEngine.SPEC_BINS, accent, modifier,
        rows = 160, centreMarker = false, channel = a to b,
        labels = centredLabels(s.lo, rate),
        onPreviewFrac = { f -> Tuning.previewHz = f?.let { spanHz(s.lo, rate, it) } },
    ) { frac -> Ham.tune(spanHz(s.lo, rate, frac)) }
}

/** Rows of [columns] chips, so long sets like the band list wrap instead of squeezing to a sliver each. */
@Composable
private fun <T> ChipGrid(items: List<T>, columns: Int, chip: @Composable androidx.compose.foundation.layout.RowScope.(T) -> Unit) {
    val d = rememberDims()
    Column(verticalArrangement = Arrangement.spacedBy(d.gap)) {
        for (row in items.chunked(columns)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for (it in row) chip(it)
                repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

private fun stepLabel(hz: Long) = when {
    hz >= 1_000_000 -> "${hz / 1_000_000}M"
    hz >= 1_000 -> if (hz % 1000 == 0L) "${hz / 1000}k" else "%.1fk".format(hz / 1000.0)
    else -> "$hz"
}
