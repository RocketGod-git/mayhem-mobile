package com.rocketgod.mayhem.ui

import android.graphics.Bitmap
import android.widget.Toast
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Saves
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.ham.BANDS
import com.rocketgod.mayhem.core.ham.Band
import com.rocketgod.mayhem.core.ham.Ham
import com.rocketgod.mayhem.core.ham.HamDemod.AgcMode
import com.rocketgod.mayhem.core.ham.HamDemod.Mode
import com.rocketgod.mayhem.core.ham.NON_HAM
import com.rocketgod.mayhem.core.ham.Picture
import com.rocketgod.mayhem.core.ham.bandOf
import com.rocketgod.mayhem.core.ham.repeaterInput
import com.rocketgod.mayhem.core.ham.segmentOf

/**
 * HAM: a proper channel receiver — any mode, any filter width, anywhere in the HackRF's span — on a panadapter
 * that stays still while you tune; a whole-band monitor; sound-card digital modes, DMR and P25; push-to-talk; and
 * a logbook. Twin of the web app's HAM.
 */
@Composable
fun HamScreen(accent: Color) {
    val tab by Ham.tab.collectAsState()
    when (tab) {
        Ham.Tab.RX -> HamReceive(accent)
        Ham.Tab.MONITOR -> HamMonitor(accent)
        Ham.Tab.DIGI -> HamDigitalTab(accent)
        Ham.Tab.TX -> HamTransmit(accent)
        Ham.Tab.LOG -> HamLogbook(accent)
    }
}

@Composable
private fun HamReceive(accent: Color) {
    val d = rememberDims()
    val s by Ham.state.collectAsState()

    HamLayout(accent, meter = true) {
        HamTabs(accent)
        SectionLabel("BAND")
        BandChips(accent, s.channel) { Ham.pickBand(it) }

        SectionLabel("MODE")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (md in listOf(Mode.LSB, Mode.USB, Mode.CW, Mode.AM, Mode.NFM, Mode.WFM)) {
                Chip(md.name, selected = s.mode == md, accent = accent, modifier = Modifier.weight(1f)) { Ham.setMode(md) }
            }
        }

        SectionLabel("TUNE")
        TuneSteps(accent)

        SectionLabel(when (s.mode) {
            Mode.USB, Mode.LSB -> "FILTER · %.0f–%.0f Hz".format(s.pbLo, s.pbHi)
            Mode.CW -> "FILTER · %.0f Hz around the pitch".format(s.width)
            else -> "FILTER · %.0f Hz wide (±%.0f)".format(s.width, s.pbHi)
        })
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
            }
            val rin = repeaterInput(s.channel)
            if (s.rev || rin != null) {
                Box(Modifier.padding(top = d.gap)) {
                    Chip(if (s.rev) "LISTENING ON INPUT · tap to return" else "REV · input %.4f".format((rin ?: s.channel) / 1e6),
                        selected = s.rev, accent = accent, modifier = Modifier.fillMaxWidth()) { Ham.toggleReverse() }
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

// ================================================================================================ shared parts

/** Readout + (optionally) S-meter over the panadapter, controls beside or below; the frame every HAM tab uses. */
@Composable
internal fun HamLayout(accent: Color, meter: Boolean, status: (@Composable () -> Unit)? = null, visualHeight: Dp? = null, controls: @Composable ColumnScope.() -> Unit) {
    val d = rememberDims()
    val s by Ham.state.collectAsState()
    val spec by SdrEngine.spectrum.collectAsState()
    val rate = SdrEngine.currentRate()
    AdaptivePane(
        visualHeightNarrow = visualHeight ?: d.dp(if (meter) 300f else 250f),
        visual = { mod ->
            Column(mod) {
                HamReadout(accent, meter)
                status?.invoke()
                HamPanadapter(accent, Modifier.fillMaxWidth().weight(1f).padding(vertical = d.dp(6f)), spec, s, rate)
            }
        }
    ) {
        ScrollColumn(Modifier.fillMaxWidth()) { controls() }
    }
}

@Composable
internal fun HamTabs(accent: Color) {
    val d = rememberDims()
    val tab by Ham.tab.collectAsState()
    // the tabs share the width in proportion to their labels, so all five are always on screen
    Row(Modifier.fillMaxWidth().padding(bottom = d.dp(4f)), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        for (t in Ham.Tab.entries) Chip(t.label, selected = tab == t, accent = accent, modifier = Modifier.weight(t.label.length + 2f)) { Ham.setTab(t) }
    }
}

@Composable
internal fun BandChips(accent: Color, channel: Long, onPick: (Band) -> Unit) {
    val current = bandOf(channel)?.id
    ChipGrid(BANDS + NON_HAM, columns = 5) { b ->
        Chip(b.name, selected = current == b.id, accent = accent, modifier = Modifier.weight(1f)) { onPick(b) }
    }
}

@Composable
internal fun TuneSteps(accent: Color) {
    val d = rememberDims()
    val s by Ham.state.collectAsState()
    val steps = remember(s.channel) { Ham.steps() }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        for (st in steps) Chip((if (st > 0) "+" else "−") + hamStepLabel(kotlin.math.abs(st)), false, accent, Modifier.weight(1f)) { Ham.nudge(st) }
    }
}

/** Channel frequency, where it sits in the band plan, and (with [meter]) the S-meter and the squelch / AGC line. */
@Composable
internal fun HamReadout(accent: Color, meter: Boolean = true) {
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
        Text(segmentOf(s.channel).ifEmpty { "outside the amateur bands" } + if (s.rev) " · REVERSE" else "",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 1.sp)
        if (!meter) return@Column

        // S-meter: S0 at the left, S9 marked, S9+60 at the right edge
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
            Text("%s · %.0f dBm est · +%.0f dB · audio %d%%".format(Ham.sUnits(dbm, s.channel), dbm, m.db - m.floor, (m.audioPeak * 100).toInt()),
                color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
            Text(Ham.statusLine(m, s), color = if (s.mode == Mode.NFM && m.open) accent else Palette.muted,
                fontFamily = Mono, fontSize = d.sp(10f), fontWeight = FontWeight.Bold)
        }
    }
}

/** The panadapter: centred on the LO, with the receiver's pass band shaded where the channel actually sits. */
@Composable
private fun HamPanadapter(accent: Color, modifier: Modifier, spec: FloatArray, s: Ham.State, rate: Int) {
    val tab by Ham.tab.collectAsState()
    val mon = tab == Ham.Tab.MONITOR && Ham.host == Ham.Host.HAM
    val centre = if (mon) Ham.monitorCentre() else s.lo
    val chan = if (mon) null else {
        val (lo, hi) = when (s.mode) {
            Mode.USB -> (s.pbLo + s.shift) to (s.pbHi + s.shift)
            Mode.LSB -> -(s.pbHi + s.shift) to -(s.pbLo + s.shift)
            Mode.CW -> -(s.pbHi - s.pbLo) / 2 to (s.pbHi - s.pbLo) / 2
            else -> -s.pbHi to s.pbHi
        }
        val off = (s.channel - s.lo).toDouble()
        (0.5 + (off + lo) / rate).toFloat() to (0.5 + (off + hi) / rate).toFloat()
    }
    WaterfallView(
        spec, SdrEngine.SPEC_BINS, accent, modifier,
        rows = 160, centreMarker = false, channel = chan,
        labels = centredLabels(centre, rate),
        onPreviewFrac = { f -> Tuning.previewHz = f?.let { spanHz(centre, rate, it) } },
    ) { frac -> Ham.tune(spanHz(centre, rate, frac)) }
}

/** Rows of [columns] chips, so long sets like the band list wrap instead of squeezing to a sliver each. */
@Composable
internal fun <T> ChipGrid(items: List<T>, columns: Int, chip: @Composable RowScope.(T) -> Unit) {
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

internal fun hamStepLabel(hz: Long) = when {
    hz >= 1_000_000 -> if (hz % 1_000_000 == 0L) "${hz / 1_000_000}M" else "%.1fM".format(hz / 1e6)
    hz >= 1_000 -> if (hz % 1000 == 0L) "${hz / 1000}k" else "%.1fk".format(hz / 1000.0)
    else -> "$hz"
}

/** The live picture (SSTV / APT / LRPT) with SAVE PNG and CLEAR. */
@Composable
internal fun PicturePanel(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val v by Picture.version.collectAsState()
    val caption by Picture.caption.collectAsState()
    val frame = Picture.frame
    val bmp = remember(v, frame) {
        val h = Picture.usedHeight().coerceIn(1, frame.height)
        Bitmap.createBitmap(frame.argb, 0, frame.width, frame.width, h, Bitmap.Config.ARGB_8888)
    }
    SectionLabel("PICTURE · $caption")
    Box(Modifier.fillMaxWidth().panel().padding(d.dp(4f)).heightIn(max = d.dp(420f))) {
        Image(bmp.asImageBitmap(), null, Modifier.fillMaxWidth(), contentScale = ContentScale.FillWidth, filterQuality = FilterQuality.Low)
    }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        Chip("SAVE PNG", false, accent, Modifier.weight(1f)) {
            val where = Saves.toDownloads(ctx, "${Picture.mode.ifEmpty { "image" }.replace(' ', '_')}-${Saves.stamp()}.png", "image/png", Saves.png(bmp), pictures = true)
            Toast.makeText(ctx, where?.let { "saved to $it" } ?: "could not save", Toast.LENGTH_SHORT).show()
        }
        Chip("CLEAR", false, accent, Modifier.weight(1f)) { Picture.reset() }
    }
}
