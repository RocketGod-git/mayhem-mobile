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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Saves
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.Signal
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
import com.rocketgod.mayhem.core.signalAt
import com.rocketgod.mayhem.core.signalDial
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

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
        Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            if (s.mode == Mode.USB || s.mode == Mode.LSB) {
                HzBox(s.pbLo.roundToInt(), "low edge · Hz", 0..5000, accent, Modifier.weight(1f)) { v ->
                    Ham.setPassband(v.toDouble(), Ham.state.value.pbHi.coerceIn(v + 100.0, 6000.0))
                }
                HzBox(s.pbHi.roundToInt(), "high edge · Hz", (s.pbLo.roundToInt() + 100)..6000, accent, Modifier.weight(1f)) { v ->
                    Ham.setPassband(Ham.state.value.pbLo, v.toDouble())
                }
            } else {
                HzBox(s.width.roundToInt(), if (s.mode == Mode.CW) "width · Hz" else "Hz wide", 50..50_000, accent, Modifier.weight(1f)) { v -> Ham.setWidth(v.toDouble()) }
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
    val wide = d.cls != ScreenClass.COMPACT || d.wide
    LaunchedEffect(wide) { Ham.wideScreen = wide }
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
    val radio by com.rocketgod.mayhem.core.Radio.kind.collectAsState()
    // the tabs share the width in proportion to their labels, so all five are always on screen
    Row(Modifier.fillMaxWidth().padding(bottom = d.dp(4f)), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
        for (t in Ham.Tab.entries) Chip(t.label, selected = tab == t, accent = accent, modifier = Modifier.weight(t.label.length + 2f),
            dim = t == Ham.Tab.TX && radio == com.rocketgod.mayhem.core.Radio.Kind.RTLSDR) { Ham.setTab(t) }
    }
}

@Composable
internal fun BandChips(accent: Color, channel: Long, onPick: (Band) -> Unit) {
    val current = bandOf(channel)?.id
    ChipGrid(BANDS + NON_HAM, columns = 5) { b ->
        val why = com.rocketgod.mayhem.core.Radio.tuneWhy(b.lo, b.hi)
        Chip(b.name, selected = current == b.id, accent = accent, modifier = Modifier.weight(1f), dim = why.isNotEmpty(), onClick = gated(why) { onPick(b) })
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

    Column(Modifier.fillMaxWidth().panel().padding(d.dp(8f))) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val preview = Tuning.previewHz
            FreqDigits(preview ?: s.channel, big = false, tint = accent, preview = preview != null) { Ham.tune(it) }
            Text("  ${s.mode.name}", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f))
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
    val ham = Ham.host == Ham.Host.HAM
    val mon = tab == Ham.Tab.MONITOR && ham
    // the monitor re-plants its whole channel set, so a slide only lands once it comes to rest
    var monTo by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(monTo) { val c = monTo ?: return@LaunchedEffect; delay(400); if (Ham.monitoring) Ham.slide(c); monTo = null }
    val centre = if (mon) monTo ?: Ham.monitorCentre() else s.lo
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
    // the filter edges drag to set the pass band, the way the web app's HAM does
    val edges: ((Float, Float, Boolean) -> Unit)? = if (mon) null else { loF, hiF, hiEdge ->
        val off = (s.channel - s.lo).toDouble()
        val a = (loF - 0.5) * rate - off; val bb = (hiF - 0.5) * rate - off
        when (s.mode) {
            Mode.USB -> { val lo = a.coerceIn(0.0, 5000.0); Ham.setPassband(lo, bb.coerceIn(lo + 100, 6000.0)) }
            Mode.LSB -> { val lo = (-bb).coerceIn(0.0, 5000.0); Ham.setPassband(lo, (-a).coerceIn(lo + 100, 6000.0)) }
            Mode.CW -> Ham.setPassband(0.0, (bb - a).coerceIn(50.0, 2000.0))
            else -> Ham.setPassband(0.0, kotlin.math.abs(if (hiEdge) bb else a).coerceIn(if (s.mode == Mode.AM) 1500.0 else 2500.0, if (s.mode == Mode.NFM) 25_000.0 else if (s.mode == Mode.AM) 12_000.0 else 100_000.0))
        }
    }
    // in HAM a tap on a classified signal lands on the band's raster and brings the mode and filter with it, and
    // anywhere else on the nearest 100 Hz
    fun target(frac: Float): Pair<Long, Signal?> {
        val hz = centre + ((frac - 0.5f) * rate).toLong()
        val sig = signalAt(hz, rate * 0.015)
        if (!ham) return (sig?.let { signalDial(it, if (s.channel < 30_000_000L) 100L else 1000L) } ?: spanHz(centre, rate, frac)) to null
        return (sig?.let { signalDial(it, Ham.raster()) } ?: (Math.round(hz / 100.0) * 100L)) to sig
    }
    fun slideTo(c: Long) { if (mon) monTo = c else Ham.slide(c) }
    WaterfallView(
        spec, SdrEngine.SPEC_BINS, accent, modifier,
        rows = 160, centreMarker = false, channel = chan,
        labels = centredLabels(centre, rate), centerHz0 = centre, spanHz0 = rate, onChannelEdge = edges,
        onPreviewFrac = { f -> Tuning.previewHz = f?.let { target(it).first } },
        onSlide = { slideTo(it) },
        onRecentre = { monTo = null; Ham.recentre() },
        onSpanStep = { dir -> Ham.spanStep(dir) },
    ) { frac ->
        val (hz, sig) = target(frac)
        if (sig != null) Ham.fitSignal(sig)
        Ham.tune(hz)
    }
}

/** Hertz typed into a box: applied, clamped to [range], on Done or when the box loses focus. */
@Composable
private fun HzBox(value: Int, label: String, range: IntRange, accent: Color, modifier: Modifier, onSet: (Int) -> Unit) {
    val d = rememberDims()
    val focus = LocalFocusManager.current
    var text by remember(value) { mutableStateOf(value.toString()) }
    var focused by remember { mutableStateOf(false) }
    fun commit() {
        if (text == value.toString()) return
        val v = text.toIntOrNull()?.coerceIn(range) ?: value
        text = v.toString()
        if (v != value) onSet(v)
    }
    OutlinedTextField(
        value = text, onValueChange = { t -> text = t.filter { it.isDigit() }.take(6) }, singleLine = true,
        modifier = modifier.onFocusChanged { f -> if (focused && !f.isFocused) commit(); focused = f.isFocused },
        label = { Text(label, fontFamily = Mono, fontSize = d.sp(10f)) },
        textStyle = TextStyle(fontFamily = Mono, color = Palette.ink, fontSize = d.sp(13f)),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = accent, unfocusedBorderColor = Palette.line, focusedLabelColor = accent,
            unfocusedLabelColor = Palette.muted, cursorColor = accent),
    )
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
