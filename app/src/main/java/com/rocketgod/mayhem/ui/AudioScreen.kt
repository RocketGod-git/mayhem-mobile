package com.rocketgod.mayhem.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Bookmarks
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.Scanner
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.audio.HdReport
import com.rocketgod.mayhem.core.audio.RdsState
import com.rocketgod.mayhem.core.audio.SameHeader
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.roundToInt

/** Audio receiver (Mayhem "Audio" / analog_audio_app): tuner face, waterfall, WFM/NFM/AM/USB/LSB, bands, squelch and scan. */
@Composable
fun AudioScreen(accent: Color) {
    val d = rememberDims()
    val lo by SdrEngine.freqHz.collectAsState()
    val offset by SdrEngine.offsetHz.collectAsState()
    val freq = lo + offset
    val mode by SdrEngine.mode.collectAsState()
    val squelch by SdrEngine.squelchDb.collectAsState()
    val bookmarks by Bookmarks.list.collectAsState()
    val scanning by Scanner.active.collectAsState()
    val rdsWanted by SdrEngine.rdsWanted.collectAsState()
    val hdWanted by SdrEngine.hdWanted.collectAsState()
    val rds by SdrEngine.rds.collectAsState()
    val hd by SdrEngine.hd.collectAsState()
    val alert by SdrEngine.same.collectAsState()
    val station = mode == SdrEngine.Mode.WFM && rdsWanted

    // Three rows: how to listen, where, and squelch with SCAN. The digits, ⌨ and the waterfall tune; ☆ saves and
    // FAVES recalls; RDS and HD Radio are switches in Settings while Audio is open.
    val controls: @Composable (Modifier) -> Unit = { m ->
        ScrollColumn(m) {
            Column(Modifier.fillMaxWidth().padding(top = d.dp(6f), bottom = d.dp(2f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                SegBar(MODES.map { it.name }, MODES.indexOf(mode), accent) { SdrEngine.setMode(MODES[it]) }
                val lit = bandAt(freq)
                TileRow(LISTEN_BANDS.map { Tile(it.name, "%d–%d".format(it.lo / 1_000_000, it.hi / 1_000_000), it == lit) }, accent) { i ->
                    val b = LISTEN_BANDS[i]; SdrEngine.setMode(b.mode); SdrEngine.tune(b.centre)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)), verticalAlignment = Alignment.CenterVertically) {
                    Text("SQL", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 2.sp)
                    SegBar(SQL_STEPS.map { if (it == 0) "OFF" else "$it dB" }, SQL_STEPS.indexOf(squelch), accent, Modifier.weight(1f)) { SdrEngine.setSquelch(SQL_STEPS[it]) }
                    ScanButton(scanning, bookmarks.isEmpty(), Modifier.width(d.dp(96f)).height(d.dp(40f))) {
                        if (bookmarks.isEmpty()) Notice.msg.value = "SCAN hops your FAVES — star a few with ☆ beside the frequency first" else Scanner.toggle()
                    }
                }
            }
        }
    }
    val scope: @Composable (Modifier) -> Unit = { m ->
        Box(m.clip(RoundedCornerShape(d.dp(12f))).border(1.dp, Palette.line, RoundedCornerShape(d.dp(12f)))) {
            ReceiverScope(accent, Modifier.fillMaxSize(), rows = 200)
            if (mode == SdrEngine.Mode.WFM && hdWanted) HdBadge(hd, Modifier.align(Alignment.TopStart).padding(d.dp(6f)))
        }
    }

    if (d.wide) {
        // Landscape / tablet: the dial and the controls side by side along the top, the waterfall the full width
        // below (Audio's controls are short, so a side pane of their own left most of the screen empty).
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
                Column(Modifier.weight(1.35f), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    alert?.header?.let { h -> SameBanner(h) }
                    TunerFace(accent, freq, mode)
                    if (station) StationStrip(rds, accent)
                }
                controls(Modifier.weight(1f))
            }
            scope(Modifier.fillMaxWidth().weight(1f))
        }
        return
    }
    AdaptivePane(
        // the controls take their own height and the waterfall flexes into whatever is left, on any phone
        visualHeightNarrow = null,
        visual = { m ->
            Column(m, verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                alert?.header?.let { h -> SameBanner(h) }
                TunerFace(accent, freq, mode)
                if (station) StationStrip(rds, accent)
                scope(Modifier.fillMaxWidth().weight(1f))
            }
        }
    ) { controls(Modifier.fillMaxWidth()) }
}

private val MODES = listOf(SdrEngine.Mode.WFM, SdrEngine.Mode.NFM, SdrEngine.Mode.AM, SdrEngine.Mode.USB, SdrEngine.Mode.LSB)
private val SQL_STEPS = listOf(0, 6, 12, 20)
/** The meter's full scale, in dB over the noise floor. */
private const val METER_DB = 40f

/**
 * How far the tuned channel stands over the noise, in dB: the mean power of the spectrum bins inside the channel
 * against the median bin of the whole span. The squelch's own floor slowly rises to meet a carrier that stays up,
 * so it can't drive a meter; the spectrum's median doesn't.
 */
private fun channelOverNoise(spec: FloatArray, rate: Int, offset: Int, mode: SdrEngine.Mode): Float {
    val n = spec.size
    if (n < 16 || rate <= 0) return 0f
    val (a, b) = when (mode) {
        SdrEngine.Mode.WFM -> -100_000 to 100_000; SdrEngine.Mode.NFM -> -6_250 to 6_250; SdrEngine.Mode.AM -> -5_000 to 5_000
        SdrEngine.Mode.USB -> 0 to 3_000; SdrEngine.Mode.LSB -> -3_000 to 0; SdrEngine.Mode.NONE -> return 0f
    }
    val i0 = ((0.5 + (offset + a).toDouble() / rate) * n).toInt().coerceIn(0, n - 1)
    val i1 = ((0.5 + (offset + b).toDouble() / rate) * n).toInt().coerceIn(i0, n - 1)
    var sum = 0.0
    for (i in i0..i1) sum += 10.0.pow(spec[i] * SdrEngine.SPEC_RANGE_DB / 10.0)
    val chDb = 10.0 * log10(sum / (i1 - i0 + 1))
    val median = spec.copyOf().also { it.sort() }[n / 2] * SdrEngine.SPEC_RANGE_DB
    return (chDb - median).toFloat().coerceAtLeast(0f)
}

/** What the tuned frequency is, in a few words; the band chip's description where nothing more particular fits. */
private fun bandTitle(hz: Long): String = when (hz) {
    in 87_500_000L..108_000_000L -> "FM BROADCAST"
    in 108_000_001L..117_999_999L -> "AIR NAVIGATION"
    in 118_000_000L..137_000_000L -> "AIRBAND"
    in 144_000_000L..146_000_000L -> "2 M AMATEUR"
    in 156_000_000L..162_025_000L -> "MARINE VHF"
    in 162_400_000L..162_550_000L -> "NOAA WEATHER"
    in 433_050_000L..434_790_000L -> "ISM 433"
    in 430_000_000L..440_000_000L -> "70 CM AMATEUR"
    in 902_000_000L..928_000_000L -> "ISM 915"
    in 1_089_000_000L..1_091_000_000L -> "ADS-B"
    else -> bandAt(hz)?.what?.uppercase() ?: "GENERAL COVERAGE"
}

/**
 * The top card: the mode, what the band is and the squelch lamp; the digits with ☆ and ⌨; then the signal meter,
 * with a tick where the squelch is set so you can see a signal clear it.
 */
@Composable
private fun TunerFace(accent: Color, freq: Long, mode: SdrEngine.Mode) {
    val spec by SdrEngine.spectrum.collectAsState()
    val rate by SdrEngine.rateHz.collectAsState()
    val offset by SdrEngine.offsetHz.collectAsState()
    val channelDb = remember(spec, rate, offset, mode) { channelOverNoise(spec, rate, offset, mode) }
    val squelch by SdrEngine.squelchDb.collectAsState()
    val sqOpen by SdrEngine.squelchOpen.collectAsState()
    val scanning by Scanner.active.collectAsState()
    FreqCard(accent, tag = mode.name, title = bandTitle(Tuning.previewHz ?: freq), freq = freq,
        meter = channelDb / METER_DB, tick = if (squelch > 0) squelch / METER_DB else null,
        left = "+%.0f dB over the noise".format(channelDb), right = if (squelch > 0) "SQL $squelch dB" else "SQL OFF",
        lamp = { SquelchLamp(squelch, sqOpen, scanning) })
}

/** OPEN (green), SQUELCHED (hollow) or SCAN (amber, blinking): the one word that says whether you'd hear anything. */
@Composable
private fun SquelchLamp(squelch: Int, open: Boolean, scanning: Boolean) = when {
    scanning -> Lamp(if (open && squelch > 0) "SCAN · SIGNAL" else "SCAN", Palette.accent2, blink = true)
    squelch > 0 && !open -> Lamp("SQUELCHED", Palette.muted)
    else -> Lamp("OPEN", Palette.ok)
}

/** What RDS says about the station: its name large, then programme type, traffic and PI, and the radiotext scrolling. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun StationStrip(r: RdsState?, accent: Color) {
    val d = rememberDims()
    val shape = RoundedCornerShape(d.dp(12f))
    val locked = r?.synced == true
    Row(Modifier.fillMaxWidth().background(Palette.surface, shape).border(1.dp, Palette.line, shape).padding(horizontal = d.dp(10f), vertical = d.dp(8f)),
        verticalAlignment = Alignment.CenterVertically) {
        val ps = r?.ps?.trim().orEmpty()
        Text(ps.ifEmpty { "RDS" }, color = if (ps.isEmpty()) Palette.muted else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black,
            fontSize = d.sp(19f), letterSpacing = 3.sp, maxLines = 1)
        Column(Modifier.weight(1f).padding(start = d.dp(10f))) {
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Pill(if (locked) "LOCKED" else "LISTENING", if (locked) Palette.ok else Palette.muted)
                if (r != null && r.ptyName.isNotEmpty() && r.ptyName != "None") Pill(r.ptyName.uppercase(), Palette.muted)
                if (r?.tp == true) Pill("TP", accent)
                r?.pi?.let { Pill("PI %04X".format(it), Palette.muted) }
            }
            val rt = r?.rt?.trim().orEmpty()
            Text(rt.ifEmpty { if (locked) "no radiotext from this station" else "reading the station's data…" }, color = Palette.muted, fontFamily = Mono,
                fontSize = d.sp(11f), maxLines = 1, modifier = Modifier.padding(top = 3.dp).basicMarquee(iterations = Int.MAX_VALUE))
        }
    }
}

/** SCAN with a radar glyph: amber and sweeping while it runs, dimmed until there are FAVES to hop. */
@Composable
private fun ScanButton(scanning: Boolean, empty: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    val shape = RoundedCornerShape(d.dp(12f))
    val bg = if (scanning) Palette.accent2 else Palette.surface
    val fg = if (scanning) inkOn(Palette.accent2) else Palette.ink
    Row(modifier.alpha(if (empty && !scanning) 0.45f else 1f)
        .then(if (scanning) Modifier.drawBehind {
            drawRoundRect(Palette.accent2.copy(alpha = 0.3f), Offset(-3.dp.toPx(), -3.dp.toPx()), Size(size.width + 6.dp.toPx(), size.height + 6.dp.toPx()), CornerRadius(15.dp.toPx()))
        } else Modifier)
        .clip(shape).background(bg).border(1.dp, if (scanning) Palette.accent2 else Palette.line, shape)
        .clickable { haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove); onClick() },
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        RadarGlyph(fg, scanning, Modifier.size(d.dp(18f)))
        Text("SCAN", color = fg, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 2.sp,
            modifier = Modifier.padding(start = d.dp(7f)))
    }
}

/** Whether the station carries HD Radio sidebands beside its analog signal. */
@Composable
private fun HdBadge(r: HdReport?, modifier: Modifier) {
    val d = rememberDims()
    val label = when {
        r == null -> "HD · listening…"
        r.present -> "HD ◉ %.0f dB · lock %.1f · %+.0f Hz".format(r.snrDb, r.lock, r.cfoHz)
        else -> "HD · none (%.0f dB · lock %.2f)".format(r.snrDb, r.lock)
    }
    val c = if (r?.present == true) Palette.ok else Palette.muted
    Text(label, color = c, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1,
        modifier = modifier.background(Palette.surface.copy(alpha = 0.82f), RoundedCornerShape(4.dp)).border(1.dp, c, RoundedCornerShape(4.dp))
            .padding(horizontal = d.dp(6f), vertical = d.dp(2f)))
}

/** A decoded NOAA Weather Radio / EAS header. Tap to dismiss; the end-of-message burst clears it on its own. */
@Composable
private fun SameBanner(h: SameHeader) {
    val d = rememberDims()
    val dur = if (h.hours > 0 || h.minutes > 0) " · " + (if (h.hours > 0) "${h.hours}h" else "") + (if (h.minutes > 0) "${h.minutes}m" else "") else ""
    val areas = if (h.locations.isNotEmpty()) " · ${h.locations.size} area${if (h.locations.size == 1) "" else "s"}" else ""
    Text("⚠ ${h.eventName.uppercase()} · ${h.originatorName}$areas$dur${if (h.callsign.isNotEmpty()) " · " + h.callsign else ""}   ✕",
        color = Color.White, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f),
        modifier = Modifier.fillMaxWidth().padding(bottom = d.dp(4f)).background(Palette.danger, RoundedCornerShape(4.dp))
            .clickable { SdrEngine.dismissSame() }.padding(horizontal = d.dp(8f), vertical = d.dp(6f)))
}
