package com.rocketgod.mayhem.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.rocketgod.mayhem.core.Station
import com.rocketgod.mayhem.core.Saves
import com.rocketgod.mayhem.core.Tx
import com.rocketgod.mayhem.core.ham.BandMonitor
import com.rocketgod.mayhem.core.ham.DmrStatus
import com.rocketgod.mayhem.core.ham.Ham
import com.rocketgod.mayhem.core.ham.HamDemod.Mode
import com.rocketgod.mayhem.core.ham.HamDigital
import com.rocketgod.mayhem.core.ham.Logbook
import com.rocketgod.mayhem.core.ham.P25Status
import com.rocketgod.mayhem.core.ham.bandOfHz
import com.rocketgod.mayhem.core.ham.distanceBearing
import com.rocketgod.mayhem.core.ham.gridToLatLon
import com.rocketgod.mayhem.core.ham.parseCall
import com.rocketgod.mayhem.core.ham.repeaterInput
import com.rocketgod.mayhem.core.ham.rstDefault
import com.rocketgod.mayhem.core.ham.toAdif
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

// ================================================================================================ MONITOR

@Composable
internal fun HamMonitor(accent: Color) {
    val d = rememberDims()
    val r by Ham.monitor.report.collectAsState()
    val m by Ham.mon.collectAsState()
    val s by Ham.state.collectAsState()
    LaunchedEffect(r) { Ham.monitorActivity(r) }
    val status: @Composable () -> Unit = {
        Text("${r.count} channels @ ${r.spacing / 1e3} kHz · ${r.open.size} open · ${r.listening.size} playing",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.dp(4f)))
    }
    HamLayout(accent, meter = false, status = status) {
        HamTabs(accent)
        SectionLabel("CHANNELS · tap to lock one, tap again to mix")
        ChannelGrid(r, m.lock, accent) { Ham.monitorLock(it) }
        SectionLabel("OPEN NOW")
        Column(Modifier.fillMaxWidth().panel().padding(d.dp(6f))) {
            if (r.open.isEmpty()) Text("nothing open — watching every channel", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
            for ((i, k) in r.open.withIndex()) {
                val hz = r.first + k.toLong() * r.spacing
                val sub = r.tones[k]?.let { "CTCSS %.1f".format(it) } ?: r.dcs[k]?.let { "DCS %03d".format(it) } ?: "—"
                Row(Modifier.fillMaxWidth().clickable { Ham.monitorLock(k) }.padding(vertical = d.dp(2f)), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("%.4f MHz%s".format(hz / 1e6, if (k in r.listening) " 🔊" else ""), color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f))
                    Text("+%.0f dB · %s · %ds".format(r.snr.getOrElse(k) { 0f }, sub, (r.since.getOrElse(i) { 0L } / 1000)), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
                }
            }
        }
        SectionLabel("LISTEN")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (l in BandMonitor.Listen.entries) Chip(l.name, m.listen == l, accent, Modifier.weight(1f)) { Ham.monitorListen(l) }
        }
        SectionLabel("RASTER · THRESHOLD")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (sp in listOf(12_500, 25_000)) Chip("${sp / 1e3} kHz", m.spacing == sp, accent, Modifier.weight(1f)) { Ham.monitorSpacing(sp) }
            for (t in listOf(6, 8, 12)) Chip("+$t dB", m.threshold == t, accent, Modifier.weight(1f)) { Ham.monitorThreshold(t) }
        }
        SectionLabel("BAND")
        BandChips(accent, s.channel) { Ham.pickBand(it) }
        SectionLabel("ACTIVITY")
        Column(Modifier.fillMaxWidth().panel().padding(d.dp(6f))) {
            if (m.log.isEmpty()) Text("activity log", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
            for (l in m.log.take(30)) Text(l, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f))
        }
        GainRow(accent)
        Spacer(Modifier.height(d.dp(12f)))
    }
}

/** Every raster channel as a cell: shaded by SNR, open ones in the second accent, playing ones ringed, the lock in red. */
@Composable
private fun ChannelGrid(r: BandMonitor.Report, lock: Int, accent: Color, onTap: (Int) -> Unit) {
    val d = rememberDims()
    val n = r.count
    if (n == 0) { Text("waiting for the first sweep…", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f)); return }
    val gold = Palette.accent2; val ink = Palette.ink
    var cols by remember { mutableStateOf(8) }
    val rows = ceil(n / cols.toDouble()).toInt()
    val cellH = d.dp(26f)
    Canvas(
        Modifier.fillMaxWidth().height(cellH * rows).pointerInput(n, cols) {
            detectTapGestures { p ->
                val cw = size.width.toFloat() / cols
                val k = (p.y / (size.height.toFloat() / rows)).toInt() * cols + (p.x / cw).toInt()
                if (k in 0 until n) onTap(k)
            }
        }
    ) {
        val c = max(8, min(n, (size.width / (22.dp.toPx())).toInt()))
        if (c != cols) cols = c
        val cw = size.width / cols; val ch = size.height / rows
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            textAlign = android.graphics.Paint.Align.CENTER; textSize = 8.dp.toPx(); typeface = android.graphics.Typeface.MONOSPACE
        }
        for (k in 0 until n) {
            val x = (k % cols) * cw; val y = (k / cols) * ch
            val snr = r.snr.getOrElse(k) { 0f }; val open = k in r.open
            val t = (snr / 30f).coerceIn(0f, 1f)
            drawRect(if (open) gold else accent.copy(alpha = 0.08f + t * 0.7f), Offset(x + 1, y + 1), Size(cw - 2, ch - 2))
            if (k in r.listening) drawRect(Color.White, Offset(x + 2, y + 2), Size(cw - 4, ch - 4), style = Stroke(2f))
            if (lock == k) drawRect(Palette.danger, Offset(x + 1, y + 1), Size(cw - 2, ch - 2), style = Stroke(2.5f))
            paint.color = (if (open) Color(0xFF05080A) else ink).toArgb()
            val hz = r.first + k.toLong() * r.spacing
            val frac = "%.${if (r.spacing >= 25_000) 3 else 4}f".format((hz / 1e6) % 1).drop(1)
            drawContext.canvas.nativeCanvas.drawText(frac, x + cw / 2, y + ch * 0.38f, paint)
            if (open) {
                val sub = r.tones[k]?.let { "%.1f".format(it) } ?: r.dcs[k]?.let { "D%03d".format(it) } ?: "+%.0f".format(snr)
                drawContext.canvas.nativeCanvas.drawText(sub, x + cw / 2, y + ch * 0.78f, paint)
            }
        }
    }
}

// ================================================================================================ DIGITAL

@Composable
internal fun HamDigitalTab(accent: Color) {
    val d = rememberDims()
    val g by HamDigital.settings.collectAsState()
    val st by HamDigital.status.collectAsState()
    val text by HamDigital.text.collectAsState()
    val ft8 by HamDigital.ft8List.collectAsState()
    val dmr by HamDigital.dmrStatus.collectAsState()
    val p25 by HamDigital.p25Status.collectAsState()
    val s by Ham.state.collectAsState()
    val status: @Composable () -> Unit = {
        val line = if (g.mode == HamDigital.Mode.OFF) "pick a decoder" else
            "${st.winner.ifEmpty { g.mode.name }} · " + st.conf.joinToString(" ") { "${it.first} ${it.second}%" } + if (g.mode == HamDigital.Mode.CW || st.winner == "CW") " · ${st.wpm} WPM" else ""
        Text(line, color = accent, fontFamily = Mono, fontSize = d.sp(10f), fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = d.dp(4f)))
    }
    fun pick(m: HamDigital.Mode) {
        when (m) {
            HamDigital.Mode.FT8 -> if (s.mode != Mode.USB) Ham.setMode(Mode.USB)
            HamDigital.Mode.CW -> if (s.mode != Mode.CW) Ham.setMode(Mode.CW)
            HamDigital.Mode.DMR, HamDigital.Mode.P25 -> if (s.mode != Mode.NFM) Ham.setMode(Mode.NFM)
            HamDigital.Mode.PSK31, HamDigital.Mode.RTTY -> if (s.mode != Mode.USB && s.mode != Mode.LSB) Ham.setMode(Mode.USB)
            else -> {}
        }
        HamDigital.update { it.copy(mode = m) }
    }
    HamLayout(accent, meter = true, status = status) {
        HamTabs(accent)
        SectionLabel("DECODER · AUTO picks whichever modem is making sense")
        ChipGrid(HamDigital.Mode.entries.toList(), columns = 5) { m -> Chip(m.name, g.mode == m, accent, Modifier.weight(1f)) { pick(m) } }
        Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (md in listOf(Mode.USB, Mode.LSB, Mode.CW, Mode.NFM)) Chip(md.name, s.mode == md, accent, Modifier.weight(1f)) { Ham.setMode(md) }
            Chip("CLEAR", false, accent, Modifier.weight(1f)) { HamDigital.clear() }
        }
        if (g.mode == HamDigital.Mode.P25 || g.mode == HamDigital.Mode.AUTO) P25Panel(p25)
        if (g.mode == HamDigital.Mode.DMR || g.mode == HamDigital.Mode.AUTO) DmrPanel(accent, dmr, g.dmrSlot)
        SectionLabel("PSK31 AUDIO CENTRE · RTTY BAUD/SHIFT")
        ChipGrid(listOf(500.0, 1000.0, 1500.0, 2000.0), columns = 4) { f -> Chip("${f.toInt()}", g.pskHz == f, accent, Modifier.weight(1f)) { HamDigital.update { it.copy(pskHz = f) } } }
        Spacer(Modifier.height(d.gap))
        ChipGrid(listOf(45.45 to 170.0, 50.0 to 170.0, 75.0 to 170.0, 45.45 to 450.0, 50.0 to 850.0), columns = 5) { (b, sh) ->
            Chip("${if (b % 1.0 == 0.0) b.toInt().toString() else b.toString()}/${sh.toInt()}", g.rttyBaud == b && g.rttyShift == sh, accent, Modifier.weight(1f)) {
                HamDigital.update { it.copy(rttyBaud = b, rttyShift = sh) }
            }
        }
        Box(Modifier.padding(top = d.gap)) { Chip("RTTY REVERSE", g.rttyRev, accent, Modifier.fillMaxWidth()) { HamDigital.update { it.copy(rttyRev = !it.rttyRev) } } }
        SectionLabel("TEXT")
        val sc = rememberScrollState()
        LaunchedEffect(text.length) { sc.scrollTo(sc.maxValue) }
        Box(Modifier.fillMaxWidth().heightIn(min = d.dp(80f), max = d.dp(220f)).panel().verticalScroll(sc).padding(d.dp(6f))) {
            Text(text.ifEmpty { "decoded text appears here" }, color = if (text.isEmpty()) Palette.muted else Palette.ink, fontFamily = Mono, fontSize = d.sp(11f))
        }
        if (g.mode == HamDigital.Mode.SSTV || g.mode == HamDigital.Mode.AUTO) {
            PicturePanel(accent)
            SectionLabel("SSTV FREQUENCIES")
            ChipGrid(listOf(Triple("20m 14.230", 14_230_000L, Mode.USB), Triple("20m 14.233", 14_233_000L, Mode.USB), Triple("10m 28.680", 28_680_000L, Mode.USB),
                Triple("40m 7.171", 7_171_000L, Mode.LSB), Triple("ISS 145.800", 145_800_000L, Mode.NFM)), columns = 3) { (l, f, md) ->
                Chip(l, s.channel == f, accent, Modifier.weight(1f)) { if (s.mode != md) Ham.setMode(md); Ham.tune(f); HamDigital.update { it.copy(mode = HamDigital.Mode.SSTV) } }
            }
        }
        if (g.mode == HamDigital.Mode.FT8 || g.mode == HamDigital.Mode.AUTO) {
            var now by remember { mutableStateOf(System.currentTimeMillis()) }
            LaunchedEffect(Unit) { while (true) { kotlinx.coroutines.delay(500); now = System.currentTimeMillis() } }
            SectionLabel("FT8 · ${15 - (now / 1000) % 15} s to next slot · UTC  SNR  DT  Hz  message")
            Column(Modifier.fillMaxWidth().panel().padding(d.dp(6f))) {
                if (ft8.isEmpty()) Text("FT8 decodes appear every 15 s — tune a band's FT8 frequency in USB · tap a decode to log the station",
                    color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
                for (r in ft8.take(60)) {
                    Row(Modifier.fillMaxWidth().clickable { logFromFt8(r.text, r.snr) }.padding(vertical = d.dp(1f)), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("%s %3d %4.1f %4d".format(r.utc, r.snr, r.dt, r.hz), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
                        Text(r.text, color = if (r.text.startsWith("CQ ")) Palette.accent2 else Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
                    }
                }
            }
            SectionLabel("FT8 FREQUENCIES")
            ChipGrid(listOf("160m" to 1_840_000L, "80m" to 3_573_000L, "40m" to 7_074_000L, "30m" to 10_136_000L, "20m" to 14_074_000L,
                "17m" to 18_100_000L, "15m" to 21_074_000L, "12m" to 24_915_000L, "10m" to 28_074_000L, "6m" to 50_313_000L, "2m" to 144_174_000L), columns = 6) { (l, f) ->
                Chip(l, s.channel == f, accent, Modifier.weight(1f)) { if (s.mode != Mode.USB) Ham.setMode(Mode.USB); Ham.tune(f); HamDigital.update { it.copy(mode = HamDigital.Mode.FT8) } }
            }
        }
        SectionLabel("TUNE")
        TuneSteps(accent)
        GainRow(accent)
        Spacer(Modifier.height(d.dp(12f)))
    }
}

/** An FT8 decode → a logbook draft for whoever it is from. */
private fun logFromFt8(text: String, snr: Int) {
    val tok = text.replace(Regex("^CQ (DX|POTA|SOTA|[A-Z]{2}) "), "CQ ").split(Regex("\\s+"))
    val call = (if (tok.firstOrNull() == "CQ") tok.getOrNull(1) else tok.getOrNull(1) ?: tok.firstOrNull()) ?: ""
    val grid = tok.firstOrNull { Regex("^[A-R]{2}\\d{2}$").matches(it) } ?: ""
    Logbook.prefill(Logbook.Draft(call = call.removePrefix("<").removeSuffix(">"), grid = grid, rstR = snr.toString(), mode = "FT8", notes = text))
    Ham.setTab(Ham.Tab.LOG)
}

@Composable
private fun DmrPanel(accent: Color, s: DmrStatus?, slotSel: Int) {
    val d = rememberDims()
    val head = when {
        s == null -> "waiting for the decoder"
        s.locked -> "LOCKED · ${when (s.source) { "BS" -> "repeater / base"; "MS" -> "mobile"; else -> "direct mode" }} · colour code ${if (s.cc >= 0) s.cc.toString() else "?"} · deviation %.0f Hz · audio slot ${s.audioSlot}".format(s.level * 48000 / (2 * Math.PI))
        s.dv.isNotEmpty() -> "${s.dv} sync seen · identification only"
        else -> "searching for sync · tune a DMR channel in NFM"
    }
    SectionLabel("DMR · $head")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        for (i in 0 until 2) {
            val sl = s?.slots?.getOrNull(i)
            val playing = s != null && s.locked && s.audioSlot == i + 1
            Column(Modifier.weight(1f).panel(if (sl?.voice == true) accent else Palette.line).padding(d.dp(6f))) {
                Text("SLOT ${i + 1}${if (sl?.voice == true) " · ▶ VOICE" else ""}${if (playing) " · 🔊" else ""}", color = if (sl?.voice == true) accent else Palette.ink,
                    fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f))
                val who = if (sl != null && (sl.tg != 0 || sl.src != 0)) "${if (sl.group) "TG" else "ID"} ${sl.tg} ← ${sl.src}${if (sl.alias.isNotEmpty()) " “${sl.alias}”" else ""}" else "no call seen"
                Text(who, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
                Text((sl?.last?.ifEmpty { null } ?: if (s?.locked == true) "idle" else "—") + (if ((sl?.cc ?: -1) >= 0) " · CC ${sl!!.cc}" else "") +
                    (if ((sl?.errs ?: 0f) > 0.02f) " · %.0f%% frame errors".format(sl!!.errs * 100) else ""), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
            }
        }
    }
    SectionLabel("AUDIO FOLLOWS · both time slots are decoded, you hear one")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        for ((v, l) in listOf(0 to "AUTO", 1 to "SLOT 1", 2 to "SLOT 2")) Chip(l, slotSel == v, accent, Modifier.weight(1f)) { HamDigital.update { it.copy(dmrSlot = v) } }
    }
}

@Composable
private fun P25Panel(s: P25Status?) {
    val d = rememberDims()
    val head = when {
        s == null || s.nac < 0 -> "searching for sync · tune a P25 channel in NFM"
        s.locked -> "LOCKED · NAC ${Integer.toHexString(s.nac).uppercase()} · ${s.frames} frames${if (s.errs > 0) " · ${s.errs} rejected" else ""}"
        else -> "last heard NAC ${Integer.toHexString(s.nac).uppercase()} · ${s.frames} frames"
    }
    SectionLabel("P25 · $head")
    Column(Modifier.fillMaxWidth().panel().padding(d.dp(6f))) {
        if (s == null || s.nac < 0) { Text("NO CALL SEEN", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f)); return@Column }
        val stale = s.since > 2 * 48_000
        val who = if (s.talkgroup == 0 && s.source == 0) "no link control yet" else if (s.lcf == 0x03) "radio ${s.talkgroup} ← ${s.source}" else "TG ${s.talkgroup} ← ${s.source}"
        Text("${s.frame.ifEmpty { "—" }}${if (s.encrypted) " · 🔒 ENCRYPTED" else ""}", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f))
        Text(who, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f))
        Text("${if (stale) "idle" else "receiving"}${if (s.lcf != 0) " · LCF ${Integer.toHexString(s.lcf)}" else ""}", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
    }
}

// ================================================================================================ TRANSMIT

@Composable
internal fun HamTransmit(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val s by Ham.state.collectAsState()
    val p by Ham.ptt.collectAsState()
    val txStatus by Tx.status.collectAsState()
    val gain by Tx.gain.collectAsState()
    val amp by Tx.amp.collectAsState()
    val needsPrompt by Tx.needsPrompt.collectAsState()
    var note by remember { mutableStateOf("") }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> note = if (ok) "microphone ready — hold the button" else "no microphone permission" }
    if (needsPrompt) SafetyPromptDialog(accent) { Tx.acknowledgeSafety() }
    val rin = repeaterInput(s.channel)
    HamLayout(accent, meter = true) {
        HamTabs(accent)
        SectionLabel("TX · ${if (rin != null && !s.rev) "repeater input %.4f MHz (offset applied)".format(rin / 1e6) else "simplex on the dial frequency"} · hold the button")
        Box(
            Modifier.fillMaxWidth().height(d.dp(64f))
                .background(if (p.on) Palette.danger else Palette.surface, RoundedCornerShape(10.dp))
                .then(Modifier.panel(if (p.on) Palette.danger else accent))
                .pointerInput(Unit) {
                    detectTapGestures(onPress = {
                        if (!com.rocketgod.mayhem.core.Mic.granted(ctx)) { askMic.launch(Manifest.permission.RECORD_AUDIO); return@detectTapGestures }
                        Ham.startPtt(ctx)?.let { note = it }
                        tryAwaitRelease()
                        Ham.stopPtt()
                    })
                },
            contentAlignment = Alignment.Center,
        ) {
            Text(if (p.on) "TX %.4f%s".format(Ham.txFreq() / 1e6, if (p.tone > 0) " · %.1f Hz".format(p.tone) else "") else "PUSH TO TALK",
                color = if (p.on) Color.White else accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f))
        }
        Text(note.ifEmpty { txStatus.ifEmpty { "idle" } }, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.dp(4f)))
        SectionLabel("DEVIATION · CTCSS")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (dev in listOf(2500, 5000)) Chip("±${dev / 1000.0} kHz", p.dev == dev, accent, Modifier.weight(1f)) { Ham.setDeviation(dev) }
        }
        Spacer(Modifier.height(d.gap))
        ChipGrid(listOf(0.0, 67.0, 71.9, 77.0, 88.5, 100.0, 103.5, 107.2, 114.8, 123.0, 131.8, 141.3, 151.4, 162.2, 173.8, 186.2, 203.5), columns = 6) { t ->
            Chip(if (t == 0.0) "none" else "%.1f".format(t), p.tone == t, accent, Modifier.weight(1f)) { Ham.setTone(t) }
        }
        SectionLabel("TX GAIN · IF 0–47 dB · AMP +14 dB")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (gv in listOf(0, 10, 20, 30, 47)) Chip("$gv", gain == gv, accent, Modifier.weight(1f)) { Tx.setGain(gv) }
            Chip("AMP", amp, accent, Modifier.weight(1f)) { Tx.toggleAmp() }
        }
        SectionLabel("BAND")
        BandChips(accent, s.channel) { Ham.pickBand(it) }
        SectionLabel("MODE (receive between overs)")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (md in listOf(Mode.NFM, Mode.USB, Mode.LSB)) Chip(md.name, s.mode == md, accent, Modifier.weight(1f)) { Ham.setMode(md) }
        }
        SectionLabel("TUNE")
        TuneSteps(accent)
        Spacer(Modifier.height(d.dp(12f)))
    }
}

// ================================================================================================ LOGBOOK

@Composable
internal fun HamLogbook(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val st by Station.info.collectAsState()
    val draft by Logbook.draft.collectAsState()
    val info by Logbook.info.collectAsState()
    val entries by Logbook.entries.collectAsState()
    val editing by Logbook.editing.collectAsState()
    val busy by Logbook.busy.collectAsState()
    val s by Ham.state.collectAsState()
    var msg by remember { mutableStateOf("") }
    var confirmWipe by remember { mutableStateOf(false) }
    val modeNow = HamDigital.logMode(s.mode)
    val import = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val text = runCatching { ctx.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } }.getOrNull()
            msg = if (text == null) "could not read that file" else "imported ${Logbook.import(text)} contacts"
        }
    }
    if (confirmWipe) AlertDialog(
        onDismissRequest = { confirmWipe = false }, containerColor = Palette.surface, textContentColor = Palette.ink,
        text = { Text("Delete all ${entries.size} contacts? Export an ADIF first if you want to keep them.", fontFamily = Mono) },
        confirmButton = { TextButton(onClick = { Logbook.deleteAll(); confirmWipe = false }) { Text("DELETE ALL", color = Palette.danger, fontFamily = Mono) } },
        dismissButton = { TextButton(onClick = { confirmWipe = false }) { Text("KEEP", color = Palette.muted, fontFamily = Mono) } },
    )
    LaunchedEffect(Unit) { if (draft.call.isNotBlank() && info?.source?.contains("offline") != false) Logbook.lookup() }

    HamLayout(accent, meter = false, visualHeight = d.dp(200f)) {
        HamTabs(accent)
        SectionLabel("STATION · " + if (st.call.isNotBlank()) "${st.call}${if (st.name.isNotBlank()) " · ${st.name}" else ""} · grid ${Station.grid().ifEmpty { "?" }}${if (st.license.isNotBlank()) " · ${st.license}" else ""}" else "set your callsign and grid in Settings")
        SectionLabel("CONTACT · " + if (editing.isNotEmpty()) "editing an earlier contact" else
            "now · %.4f MHz · %s · %s".format(s.channel / 1e6, draft.mode.ifEmpty { modeNow }, bandOfHz(s.channel).ifEmpty { "out of band" }))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap), verticalAlignment = Alignment.CenterVertically) {
            LogField(draft.call, "CALLSIGN", accent, Modifier.weight(2f), caps = true) { Logbook.setDraft(draft.copy(call = it.uppercase())) }
            Chip(if (busy) "…" else "LOOKUP", false, accent, Modifier.weight(1f)) { Logbook.lookup() }
            Chip("QRZ ↗", false, accent, Modifier.weight(1f)) {
                val c = parseCall(draft.call).base
                if (c.isNotEmpty()) runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.qrz.com/db/$c"))) }
            }
        }
        CallInfoPanel(draft.call, entries)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            LogField(draft.rstS, "RST sent · ${rstDefault(draft.mode.ifEmpty { modeNow })}", accent, Modifier.weight(1f)) { Logbook.setDraft(draft.copy(rstS = it)) }
            LogField(draft.rstR, "RST rcvd · ${rstDefault(draft.mode.ifEmpty { modeNow })}", accent, Modifier.weight(1f)) { Logbook.setDraft(draft.copy(rstR = it)) }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            LogField(draft.name, "name", accent, Modifier.weight(1f)) { Logbook.setDraft(draft.copy(name = it)) }
            LogField(draft.grid, "grid", accent, Modifier.weight(1f), caps = true) { Logbook.setDraft(draft.copy(grid = it.uppercase())) }
        }
        LogField(draft.qth, "QTH", accent, Modifier.fillMaxWidth()) { Logbook.setDraft(draft.copy(qth = it)) }
        LogField(draft.notes, "notes", accent, Modifier.fillMaxWidth()) { Logbook.setDraft(draft.copy(notes = it)) }
        Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip(if (editing.isNotEmpty()) "SAVE CHANGES" else "LOG IT", true, accent, Modifier.weight(2f)) {
                val dr = Logbook.draft.value
                val filled = dr.copy(rstS = dr.rstS.ifEmpty { rstDefault(dr.mode.ifEmpty { modeNow }) }, rstR = dr.rstR.ifEmpty { rstDefault(dr.mode.ifEmpty { modeNow }) })
                Logbook.setDraft(filled)
                msg = Logbook.save(s.channel, modeNow) ?: "logged ${filled.call.uppercase()} · %.4f MHz ${filled.mode.ifEmpty { modeNow }}".format(s.channel / 1e6)
            }
            Chip("CLEAR", false, accent, Modifier.weight(1f)) { Logbook.clearForm(); msg = "" }
        }
        if (msg.isNotEmpty()) Text(msg, color = Palette.accent2, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.dp(4f)))

        val calls = entries.map { parseCall(it.call).base }.toSet().size
        val ents = entries.mapNotNull { it.country ?: com.rocketgod.mayhem.core.ham.offlineInfo(it.call).country }.toSet().size
        SectionLabel("LOGBOOK · " + (if (entries.isEmpty()) "empty" else "${entries.size} QSO${if (entries.size == 1) "" else "s"} · $calls callsign${if (calls == 1) "" else "s"} · $ents entit${if (ents == 1) "y" else "ies"}") + " · tap to edit")
        Column(Modifier.fillMaxWidth().panel().padding(d.dp(6f))) {
            if (entries.isEmpty()) Text("no contacts yet — work someone and LOG IT, or import an ADIF", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
            for (x in entries.take(300)) {
                Row(Modifier.fillMaxWidth().clickable { Logbook.edit(x.id) }.padding(vertical = d.dp(2f)), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        val utc = java.time.Instant.ofEpochMilli(x.ts).toString().take(16).replace('T', ' ')
                        Text("${x.call}  ${utc}z · %.4f ${x.mode}".format(x.freq / 1e6) + if (x.rstS.isNotEmpty() || x.rstR.isNotEmpty()) " · ${x.rstS.ifEmpty { "—" }}/${x.rstR.ifEmpty { "—" }}" else "",
                            color = if (x.id == editing) Palette.accent2 else Palette.ink, fontFamily = Mono, fontSize = d.sp(10.5f), fontWeight = FontWeight.Bold)
                        val extra = listOfNotNull(x.name.ifEmpty { null }, x.qth.ifEmpty { null }, x.grid.ifEmpty { null }, x.country).joinToString(" · ")
                        if (extra.isNotEmpty()) Text(extra, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f))
                    }
                    Text("✕", color = Palette.muted, fontFamily = Mono, modifier = Modifier.clickable { Logbook.delete(x.id) }.padding(d.dp(6f)))
                }
            }
        }
        SectionLabel("MAP · contacts by grid square, the callsign you are looking up in gold")
        val me = Station.latLon()
        val items = entries.mapNotNull { e -> gridToLatLon(e.grid)?.let { GeoItem(e.id, it.first, it.second, e.call, GeoItem.Kind.QSO) } } +
            listOfNotNull(info?.let { i -> (i.grid?.let { gridToLatLon(it) } ?: if (i.lat != null && i.lon != null) i.lat!! to i.lon!! else null)?.let { GeoItem("lookup", it.first, it.second, i.call, GeoItem.Kind.OBJECT) } })
        val lines = if (me != null) items.filter { it.kind == GeoItem.Kind.QSO }.map { me to (it.lat to it.lon) } else emptyList()
        GeoMapView(items, accent, Modifier.fillMaxWidth().height(d.dp(260f)).panel(), home = me, selected = editing.ifEmpty { "lookup" },
            layers = GeoLayers(lines = lines)) { id -> if (id != "lookup") Logbook.edit(id) }
        Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip("EXPORT ADIF", false, accent, Modifier.weight(1f)) {
                val where = Saves.toDownloads(ctx, "mayhem-log-${Saves.stamp()}.adi", "text/plain", toAdif(entries, st.call, Station.grid()).toByteArray())
                msg = where?.let { "saved $it" } ?: "could not save"
            }
            Chip("IMPORT ADIF", false, accent, Modifier.weight(1f)) { import.launch(arrayOf("*/*")) }
        }
        Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip("EXPORT CSV", false, accent, Modifier.weight(1f)) {
                val where = Saves.toDownloads(ctx, "mayhem-log-${Saves.stamp()}.csv", "text/csv", Logbook.csv().toByteArray())
                msg = where?.let { "saved $it" } ?: "could not save"
            }
            Chip("DELETE ALL", false, accent, Modifier.weight(1f)) { if (entries.isNotEmpty()) confirmWipe = true }
        }
        Spacer(Modifier.height(d.dp(12f)))
    }
}

/** What is known about the callsign being typed: entity, name, distance and bearing, worked before. */
@Composable
private fun CallInfoPanel(call: String, entries: List<com.rocketgod.mayhem.core.ham.Qso>) {
    val d = rememberDims()
    val info by Logbook.info.collectAsState()
    val p = parseCall(call)
    val lines = ArrayList<Pair<String, Color>>()
    if (p.base.isEmpty()) lines += "type a callsign — the prefix says where it is, LOOKUP asks HamQTH / hamdb / callook for the rest" to Palette.muted
    else {
        info?.let { i ->
            lines += (i.base + if (i.prefix.isNotEmpty() && i.prefix != i.base.take(i.prefix.length)) " (operating from ${i.prefix})" else "") to Palette.ink
            i.name?.let { lines += (it + (i.cls?.let { c -> " · $c" } ?: "")) to Palette.ink }
            i.country?.let { c ->
                lines += (c + (i.continent?.let { " · $it" } ?: "") + (i.cq?.let { " · CQ $it" } ?: "") + (i.itu?.let { " · ITU $it" } ?: "") +
                    (i.utc?.let { u -> " · UTC${if (-u >= 0) "+" else "−"}${kotlin.math.abs(u).let { if (it % 1.0 == 0.0) it.toInt().toString() else it.toString() }}" } ?: "")) to Palette.ink
            }
            i.qth?.let { lines += it to Palette.ink }
            val here = Station.latLon()
            val there = i.grid?.let { gridToLatLon(it) } ?: if (i.lat != null && i.lon != null) i.lat!! to i.lon!! else null
            if (here != null && there != null) {
                val (km, deg) = distanceBearing(here.first, here.second, there.first, there.second)
                lines += ((i.grid?.let { "grid $it · " } ?: "") + (if (km >= 100) "%.0f".format(km) else "%.1f".format(km)) + " km · bearing %.0f°".format(deg) +
                    if (km > 500) " (long path %.0f°)".format((deg + 180) % 360) else "") to Palette.ink
            } else i.grid?.let { lines += "grid $it" to Palette.ink }
            lines += i.source to Palette.muted
        }
        val worked = entries.filter { parseCall(it.call).base == p.base }.sortedByDescending { it.ts }
        if (worked.isNotEmpty()) {
            val w = worked[0]
            lines += "worked ${worked.size}× · last ${java.time.Instant.ofEpochMilli(w.ts).toString().take(10)} ${bandOfHz(w.freq)} ${w.mode}${if (w.name.isNotEmpty()) " · ${w.name}" else ""}" to Palette.accent2
        } else lines += "new one — not in the log yet" to Palette.muted
    }
    Column(Modifier.fillMaxWidth().padding(vertical = d.dp(4f)).panel().padding(d.dp(6f))) {
        for ((t, c) in lines) Text(t, color = c, fontFamily = Mono, fontSize = d.sp(10.5f))
    }
}

@Composable
internal fun LogField(value: String, label: String, accent: Color, modifier: Modifier, caps: Boolean = false, onChange: (String) -> Unit) {
    val d = rememberDims()
    OutlinedTextField(
        value = value, onValueChange = onChange, singleLine = true, modifier = modifier,
        label = { Text(label, fontFamily = Mono, fontSize = d.sp(10f)) },
        textStyle = androidx.compose.ui.text.TextStyle(fontFamily = Mono, color = Palette.ink, fontSize = d.sp(13f)),
        keyboardOptions = KeyboardOptions(capitalization = if (caps) KeyboardCapitalization.Characters else KeyboardCapitalization.Sentences, autoCorrectEnabled = false),
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = accent, unfocusedBorderColor = Palette.line, focusedLabelColor = accent,
            unfocusedLabelColor = Palette.muted, cursorColor = accent),
    )
}
