package com.rocketgod.mayhem.ui

import android.graphics.Bitmap
import android.widget.Toast
import androidx.compose.foundation.Canvas
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
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
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

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

    // Tabs, the band, the mode, the filter, then AGC and the noise tools (squelch and reverse in FM). The digits and
    // the panadapter tune; the filter's exact edges, the shift, the CW pitch and the volume are in Settings.
    HamLayout(accent, meter = true) {
        Column(Modifier.fillMaxWidth().padding(top = d.dp(6f), bottom = d.dp(4f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            HamTabs(accent)
            BandChips(accent, s.channel) { Ham.pickBand(it) }
            val modes = listOf(Mode.LSB, Mode.USB, Mode.CW, Mode.AM, Mode.NFM, Mode.WFM)
            SegBar(modes.map { it.name }, modes.indexOf(s.mode), accent) { Ham.setMode(modes[it]) }
            val widths = Ham.WIDTHS.getValue(s.mode)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                RowLabel("FILTER")
                SegBar(widths.map { it.first }, widths.indexOfFirst { it.second == s.width }, accent, Modifier.weight(1f)) { Ham.setWidth(widths[it].second) }
            }
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                if (s.mode == Mode.NFM) {
                    val steps = listOf(0, 3, 6, 10, 15)
                    RowLabel("SQL")
                    SegBar(steps.map { if (it == 0) "OFF" else "$it" }, steps.indexOf(s.squelch), accent, Modifier.weight(1f)) { Ham.setSquelch(steps[it]) }
                    val rin = repeaterInput(s.channel)
                    if (s.rev || rin != null) ToggleBox("REV", s.rev, accent, Modifier.fillMaxHeight()) { Ham.toggleReverse() }
                } else {
                    val agcs = AgcMode.entries
                    RowLabel("AGC")
                    SegBar(agcs.map { it.name }, agcs.indexOf(s.agc), accent, Modifier.weight(1f)) { Ham.setAgc(agcs[it]) }
                    ToggleBox("NR", s.nr, accent, Modifier.fillMaxHeight()) { Ham.toggleNr() }
                    ToggleBox("NOTCH", s.anf, accent, Modifier.fillMaxHeight()) { Ham.toggleAnf() }
                }
            }
        }
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
    val tab by Ham.tab.collectAsState()
    val radio by com.rocketgod.mayhem.core.Radio.kind.collectAsState()
    val tabs = Ham.Tab.entries
    val noTx = radio == com.rocketgod.mayhem.core.Radio.Kind.RTLSDR
    // short names so all five sit on one bar; TRANSMIT is faded on a radio that can't
    SegBar(tabs.map { when (it) { Ham.Tab.RX -> "RX"; Ham.Tab.MONITOR -> "MONITOR"; Ham.Tab.DIGI -> "DIGITAL"; Ham.Tab.TX -> "TX"; Ham.Tab.LOG -> "LOG" } },
        tabs.indexOf(tab), accent, tints = tabs.map { if (it == Ham.Tab.TX && noTx) Palette.muted.copy(alpha = 0.45f) else null }) { Ham.setTab(tabs[it]) }
}

/** The bands as scrolling tiles with their ranges; one this radio can't reach is faded and says why when tapped. */
@Composable
internal fun BandChips(accent: Color, channel: Long, onPick: (Band) -> Unit) {
    val current = bandOf(channel)?.id
    val all = BANDS + NON_HAM
    fun mhz(hz: Long) = if (hz < 30_000_000L) "%.1f".format(hz / 1e6) else "${hz / 1_000_000}"
    val whys = all.map { com.rocketgod.mayhem.core.Radio.tuneWhy(it.lo, it.hi) }
    TileRow(all.mapIndexed { i, b -> Tile(b.name, "${mhz(b.lo)}–${mhz(b.hi)}", current == b.id, dim = whys[i].isNotEmpty()) }, accent, width = 88.dp) { i ->
        gated(whys[i]) { onPick(all[i]) }()
    }
}

/** Channel frequency, where it sits in the band plan, the S-meter and the squelch / AGC line: HAM's [FreqCard]. */
@Composable
internal fun HamReadout(accent: Color, meter: Boolean = true) {
    val s by Ham.state.collectAsState()
    val m by Ham.demod.meter.collectAsState()
    val dbm = Ham.dbm(m.db)
    val playing = com.rocketgod.mayhem.core.Apps.playing() == com.rocketgod.mayhem.core.MayhemApp.HAM
    val marks by com.rocketgod.mayhem.core.Bookmarks.list.collectAsState()
    // S0 at the left, 6 dB an S-unit to S9 (54 dB), then dB over to S9+60 at the right
    fun at(units: Float) = units / 114f
    FreqCard(accent, tag = s.mode.name,
        title = (segmentOf(s.channel).ifEmpty { "outside the amateur bands" } + if (s.rev) " · reverse" else "").uppercase(),
        freq = s.channel, meter = Ham.meterFrac(dbm, s.channel),
        scale = listOf(at(6f) to "S1", at(18f) to "3", at(30f) to "5", at(42f) to "7", at(54f) to "9", at(74f) to "+20", at(94f) to "+40", 1f to "+60"),
        left = "%s · %.0f dBm".format(Ham.sUnits(dbm, s.channel), dbm), right = Ham.statusLine(m, s),
        rightColor = if (s.mode == Mode.NFM && m.open) accent else Palette.muted,
        onTune = { Ham.tune(it) },
        actions = {
            DialActions(accent, s.channel, star = playing, starred = marks.any { kotlin.math.abs(it.hz - s.channel) < 50 },
                onStar = { com.rocketgod.mayhem.core.Bookmarks.star(s.channel, SdrEngine.Mode.NFM, s.mode.name, Ham.favourite()) }) { Ham.tune(it) }
        },
        lamp = {
            when {
                s.mode == Mode.NFM && s.squelch > 0 && !m.open -> Lamp("SQUELCHED", Palette.muted)
                s.mode == Mode.NFM && s.squelch > 0 -> Lamp("OPEN", Palette.ok)
                else -> Lamp("RX", Palette.ok)
            }
        })
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
