package com.rocketgod.mayhem.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.Tx
import com.rocketgod.mayhem.core.TxEncoders
import kotlin.math.roundToLong

/** Transmit (Mayhem siggen / morse / OOK TX / replay). Gated by the Settings TX switch; red styling as a caution. */
@Composable
fun TxScreen(defaultAccent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val enabled by Tx.enabled.collectAsState()
    val active by Tx.active.collectAsState()
    val status by Tx.status.collectAsState()
    val gain by Tx.gain.collectAsState()
    val amp by Tx.amp.collectAsState()
    val freq by SdrEngine.freqHz.collectAsState()
    val needsPrompt by Tx.needsPrompt.collectAsState()
    val accent = Palette.danger
    var tab by remember { mutableStateOf(0) }

    val radio by com.rocketgod.mayhem.core.Radio.kind.collectAsState()
    val canTx = radio != com.rocketgod.mayhem.core.Radio.Kind.RTLSDR
    if (needsPrompt && canTx) SafetyPromptDialog(accent) { Tx.acknowledgeSafety() }

    ScrollColumn(Modifier.fillMaxSize()) {
        if (!canTx) { ReceiveOnlyNote(accent); return@ScrollColumn }
        if (!enabled) {
            Column(Modifier.fillMaxWidth().panel(accent).padding(d.dp(12f))) {
                Text("TRANSMIT IS OFF", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), letterSpacing = 2.sp)
                Text("You switched TX off in Settings. Turn it back on there.", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(top = d.dp(6f)))
                Box(Modifier.padding(top = d.dp(10f))) { Chip("OPEN SETTINGS", selected = false, accent = accent) { Apps.open(com.rocketgod.mayhem.core.MayhemApp.SETTINGS) } }
            }
            return@ScrollColumn
        }

        FreqReadout(accent, if (status.isNotEmpty()) status else "idle", big = true)
        SectionLabel("TUNE · MHz")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            for (s in longArrayOf(1_000_000L, 100_000L, 10_000L)) Chip("−" + txStep(s), false, accent, Modifier.weight(1f)) { SdrEngine.tune(freq - s) }
            for (s in longArrayOf(10_000L, 100_000L, 1_000_000L)) Chip("+" + txStep(s), false, accent, Modifier.weight(1f)) { SdrEngine.tune(freq + s) }
        }

        SectionLabel("TX GAIN · IF 0–47 dB   ·   AMP +14 dB")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (g in intArrayOf(0, 10, 20, 30, 47)) Chip("$g", selected = gain == g, accent = accent, modifier = Modifier.weight(1f)) { Tx.setGain(g) }
            Chip(if (amp) "AMP" else "amp", selected = amp, accent = accent, modifier = Modifier.weight(1f)) { Tx.toggleAmp() }
        }

        SectionLabel("MODE")
        val modes = listOf(
            "Signal", "Tones", "POCSAG", "RTTY",
            "APRS", "Morse", "OOK", "Replay",
            "MDC", "QC-II", "SubGHz", "KeeLoq",
            "Noise", "Brute", "Hopper", "ADS-B",
        )
        for (rowModes in modes.withIndex().chunked(4)) {
            Row(Modifier.fillMaxWidth().padding(bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for ((i, t) in rowModes) Chip(t, selected = tab == i, accent = accent, modifier = Modifier.weight(1f)) { tab = i }
            }
        }

        Box(Modifier.padding(top = d.dp(8f))) {
            when (tab) {
                0 -> SigGenTab(accent, freq, active)
                1 -> TonesTab(accent, freq, active)
                2 -> PocsagTab(accent, freq, active)
                3 -> RttyTab(accent, freq, active)
                4 -> AprsTab(accent, freq, active)
                5 -> MorseTab(accent, freq, active)
                6 -> OokTab(accent, freq, active)
                7 -> ReplayTab(accent, active)
                8 -> MdcTab(accent, freq, active)
                9 -> QcTab(accent, freq, active)
                10 -> SubGhzTab(accent, freq, active)
                11 -> KeeloqTab(accent, freq, active)
                12 -> NoiseTab(accent, freq, active)
                13 -> BruteTab(accent, freq, active)
                14 -> HopperTab(accent, freq, active)
                else -> AdsbTab(accent, active)
            }
        }

        if (active) Box(Modifier.padding(top = d.dp(10f))) { Chip("■ STOP", selected = true, accent = accent, modifier = Modifier.fillMaxWidth()) { Tx.stop() } }
    }
}

@Composable private fun TonesTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var digits by remember { mutableStateOf("1234") }
    Row(Modifier.fillMaxWidth().padding(bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        Chip("1 kHz", selected = false, accent = accent, modifier = Modifier.weight(1f)) { if (!active) Tx.tones(Tx.ToneMode.SINGLE, "", freq) }
        Chip("two-tone", selected = false, accent = accent, modifier = Modifier.weight(1f)) { if (!active) Tx.tones(Tx.ToneMode.TWO_TONE, "", freq) }
    }
    TxField(digits, accent, "DTMF digits (0-9 A-D * #)") { digits = it.uppercase().filter { c -> c in "0123456789ABCD*#" } }
    Box(Modifier.padding(top = d.gap)) { Chip("▶ SEND DTMF", selected = false, accent = accent, modifier = Modifier.fillMaxWidth()) { if (!active) Tx.tones(Tx.ToneMode.DTMF, digits, freq) } }
}

@Composable private fun PocsagTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var addr by remember { mutableStateOf("1234567") }
    var msg by remember { mutableStateOf("TEST DE MAYHEM") }
    var baud by remember { mutableStateOf(1200) }
    var numeric by remember { mutableStateOf(false) }
    TxField(addr, accent, "address (RIC)") { addr = it.filter { c -> c.isDigit() }.take(7) }
    TxField(msg, accent, if (numeric) "digits 0-9 SU-][ " else "message") { msg = if (numeric) it.filter { c -> c in "0123456789SU -][" } else it }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap), verticalAlignment = Alignment.CenterVertically) {
        Chip("$baud bd", selected = false, accent = accent, modifier = Modifier.weight(1f)) { baud = if (baud == 1200) 2400 else if (baud == 2400) 512 else 1200 }
        Chip(if (numeric) "numeric" else "alpha", selected = numeric, accent = accent, modifier = Modifier.weight(1f)) { numeric = !numeric }
    }
    Box(Modifier.padding(top = d.gap)) { Chip("▶ PAGE", selected = false, accent = accent, modifier = Modifier.fillMaxWidth()) {
        if (!active) Tx.pocsag(addr.toIntOrNull() ?: 0, 3, msg, if (numeric) TxEncoders.PocsagType.NUMERIC else TxEncoders.PocsagType.ALPHANUMERIC, baud, freq) } }
    Note("Decodes on the Pager RX app and on PDW. RIC + function 3.")
}

@Composable private fun RttyTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var text by remember { mutableStateOf("RYRYRY DE MAYHEM") }
    var shift by remember { mutableStateOf(170) }
    TxField(text, accent, "text") { text = it }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        Chip("${shift} Hz", selected = false, accent = accent, modifier = Modifier.weight(1f)) { shift = if (shift == 170) 425 else if (shift == 425) 850 else 170 }
        Chip("▶ SEND 45 bd", selected = false, accent = accent, modifier = Modifier.weight(1.4f)) { if (!active) Tx.rtty(text, 45, shift.toDouble(), freq) }
    }
    Note("ITA2 Baudot, 45.45 baud — decodes on any RTTY reader (fldigi, etc.).")
}

@Composable private fun AprsTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var call by remember { mutableStateOf("N0CALL-9") }
    var info by remember { mutableStateOf("!4903.50N/07201.75W-Mayhem Mobile") }
    TxField(call, accent, "source callsign-ssid") { call = it.uppercase() }
    TxField(info, accent, "AX.25 info (position/status)") { info = it }
    Box(Modifier.padding(top = d.gap)) { Chip("▶ BEACON 144.39", selected = false, accent = accent, modifier = Modifier.fillMaxWidth()) { if (!active) Tx.aprs(call, info, freq) } }
    Note("Bell 202 AX.25 UI frame — decodes on the APRS app and on any TNC. Ham licence required on 144.39.")
}

@Composable private fun SigGenTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    for (m in Tx.SigMode.values().toList().chunked(2)) {
        Row(Modifier.fillMaxWidth().padding(bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (mode in m) Chip(mode.label, selected = false, accent = accent, modifier = Modifier.weight(1f)) { if (!active) Tx.sigGen(freq, mode) }
            if (m.size == 1) Box(Modifier.weight(1f))
        }
    }
    Note("A continuous test signal until you press STOP. Use a dummy load.")
}

@Composable private fun MorseTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var text by remember { mutableStateOf("CQ DE MAYHEM") }
    var wpm by remember { mutableStateOf(20) }
    var fm by remember { mutableStateOf(true) }
    TxField(text, accent, "message") { text = it.uppercase() }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap), verticalAlignment = Alignment.CenterVertically) {
        Text("$wpm WPM", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.weight(1f))
        Chip("−", false, accent, Modifier.weight(0.5f)) { wpm = (wpm - 5).coerceAtLeast(5) }
        Chip("+", false, accent, Modifier.weight(0.5f)) { wpm = (wpm + 5).coerceAtMost(60) }
        Chip(if (fm) "FM tone" else "CW key", selected = fm, accent = accent, modifier = Modifier.weight(1f)) { fm = !fm }
    }
    Box(Modifier.padding(top = d.gap)) { Chip("▶ SEND", selected = false, accent = accent, modifier = Modifier.fillMaxWidth()) { if (!active) Tx.morse(text, wpm, freq, fm) } }
}

@Composable private fun OokTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var hex by remember { mutableStateOf("A5C3F1") }
    var bits by remember { mutableStateOf(24) }
    var te by remember { mutableStateOf(350) }
    TxField(hex, accent, "code (hex)") { hex = it.filter { c -> c.isDigit() || c in 'a'..'f' || c in 'A'..'F' }.take(12) }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap), verticalAlignment = Alignment.CenterVertically) {
        Text("$bits bit  ${te}µs", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.weight(1.2f))
        Chip("bits", false, accent, Modifier.weight(1f)) { bits = if (bits == 24) 12 else if (bits == 12) 32 else 24 }
        Chip("te", false, accent, Modifier.weight(1f)) { te = if (te == 350) 500 else if (te == 500) 200 else 350 }
    }
    Box(Modifier.padding(top = d.gap)) { Chip("▶ SEND ×8", selected = false, accent = accent, modifier = Modifier.fillMaxWidth()) { if (!active) Tx.ookPrinceton(freq, hex.toLongOrNull(16) ?: 0L, bits, te, 8) } }
    Note("Fixed-code Princeton/PT2262 OOK — for remotes you own on a licence-free ISM band.")
}

@Composable private fun ReplayTab(accent: Color, active: Boolean) {
    val d = rememberDims()
    val rec = Apps.recorder
    val files = remember { rec?.listCaptures() ?: emptyList() }
    if (files.isEmpty()) { Note("No captures. Record raw IQ in the Capture app first; its sidecar carries the frequency to replay on."); return }
    Column(Modifier.fillMaxWidth()) {
        for (f in files) Row(Modifier.fillMaxWidth().panel().padding(d.dp(10f)).clickable { if (!active && rec != null) Tx.replay(java.io.File(rec.directory, f)) }.padding(vertical = d.dp(2f))) {
            Text("▶ $f", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), maxLines = 1)
        }
    }
}

@Composable private fun TxField(value: String, accent: Color, label: String, onChange: (String) -> Unit) {
    OutlinedTextField(value, onChange, singleLine = true, label = { Text(label, fontFamily = Mono) }, modifier = Modifier.fillMaxWidth(),
        colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Palette.ink, unfocusedTextColor = Palette.ink, focusedBorderColor = accent,
            unfocusedBorderColor = Palette.line, cursorColor = accent, focusedLabelColor = accent, unfocusedLabelColor = Palette.muted))
}

@Composable private fun Note(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.fillMaxWidth().padding(top = d.dp(8f)))
}

private fun txStep(hz: Long): String = if (hz >= 1_000_000L) "${hz / 1_000_000}" else if (hz >= 1_000L) ".${"%03d".format(hz / 1000)}" else "$hz"

@Composable private fun MdcTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var unit by remember { mutableStateOf("0001") }
    var op by remember { mutableStateOf(0x35) }
    TxField(unit, accent, "unit ID (hex)") { unit = it.uppercase().filter { c -> c in "0123456789ABCDEF" }.take(4) }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        Chip("PTT ID (01)", selected = op == 0x01, accent = accent, modifier = Modifier.weight(1f)) { op = 0x01 }
        Chip("Emerg (30)", selected = op == 0x30, accent = accent, modifier = Modifier.weight(1f)) { op = 0x30 }
        Chip("Radio ck (35)", selected = op == 0x35, accent = accent, modifier = Modifier.weight(1f)) { op = 0x35 }
    }
    Box(Modifier.padding(top = d.gap)) { Chip("▶ SEND", selected = false, accent = accent, modifier = Modifier.fillMaxWidth()) { if (!active) Tx.mdc1200(op, 0x00, unit.toIntOrNull(16) ?: 0, freq) } }
    Note("Motorola PTT-ID (1200 bps AFSK) — for business-band radios you own.")
}

@Composable private fun QcTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var a by remember { mutableStateOf("1122.5") }
    var b by remember { mutableStateOf("1358.9") }
    TxField(a, accent, "Tone A (Hz)") { a = it }
    TxField(b, accent, "Tone B (Hz)") { b = it }
    Box(Modifier.padding(top = d.gap)) { Chip("▶ PAGE", selected = false, accent = accent, modifier = Modifier.fillMaxWidth()) { if (!active) Tx.quickCall2(a.toDoubleOrNull() ?: 1000.0, b.toDoubleOrNull() ?: 1500.0, freq) } }
    Note("Quick-Call II two-tone paging (fire, utility). 1 s A, 3 s B, then a carrier tail.")
}

@Composable private fun SubGhzTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var raw by remember { mutableStateOf("RAW_Data: 340 -1020 340 -340 1020 -340 340 -1020") }
    var reps by remember { mutableStateOf(3) }
    TxField(raw, accent, "Flipper .sub RAW_Data line") { raw = it }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        Chip("×$reps", selected = false, accent = accent, modifier = Modifier.weight(1f)) { reps = if (reps == 3) 5 else if (reps == 5) 10 else 3 }
        Chip("▶ REPLAY", selected = false, accent = accent, modifier = Modifier.weight(2f)) { if (!active) Tx.subghzReplay(raw, freq, reps) }
    }
    Note("Replay a Flipper .sub file's RAW pulses — remotes on your own equipment.")
}

@Composable private fun KeeloqTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var key by remember { mutableStateOf("0000000000000000") }
    var serial by remember { mutableStateOf("0000000") }
    var counter by remember { mutableStateOf(1) }
    var button by remember { mutableStateOf(1) }
    TxField(key, accent, "64-bit key (hex)") { key = it.uppercase().filter { c -> c in "0123456789ABCDEF" }.take(16) }
    TxField(serial, accent, "serial (hex, 28 bits)") { serial = it.uppercase().filter { c -> c in "0123456789ABCDEF" }.take(7) }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        Chip("btn $button", selected = false, accent = accent, modifier = Modifier.weight(1f)) { button = (button % 15) + 1 }
        Chip("cnt $counter", selected = false, accent = accent, modifier = Modifier.weight(1f)) { counter++ }
        Chip("▶ SEND", selected = false, accent = accent, modifier = Modifier.weight(1.4f)) { if (!active) Tx.keeloqTx(key.toULong(16).toLong(), serial.toIntOrNull(16) ?: 0, button, counter, freq, 3) }
    }
    Note("HCS301 (Microchip) rolling-code — needs the manufacturer key. Test on equipment you own.")
}

@Composable private fun NoiseTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var chip by remember { mutableStateOf(400) }
    var secs by remember { mutableStateOf(3) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        Chip("${chip}µs", selected = false, accent = accent, modifier = Modifier.weight(1f)) { chip = if (chip == 400) 200 else if (chip == 200) 800 else 400 }
        Chip("${secs}s", selected = false, accent = accent, modifier = Modifier.weight(1f)) { secs = if (secs == 3) 10 else if (secs == 10) 30 else 3 }
    }
    Box(Modifier.padding(top = d.gap)) { Chip("▶ NOISE", selected = false, accent = accent, modifier = Modifier.fillMaxWidth()) { if (!active) Tx.ookNoise(0L, chip, secs, freq) } }
    Note("Random OOK for authorised RF-lab work only. Illegal on populated bands.")
}

@Composable private fun BruteTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var bits by remember { mutableStateOf(12) }
    var from by remember { mutableStateOf("0") }
    var to by remember { mutableStateOf("4095") }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap), verticalAlignment = Alignment.CenterVertically) {
        Chip("$bits bit", selected = false, accent = accent, modifier = Modifier.weight(1f)) { bits = if (bits == 12) 20 else if (bits == 20) 24 else 12 }
    }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        Box(Modifier.weight(1f)) { TxField(from, accent, "from") { from = it.filter { c -> c.isDigit() } } }
        Box(Modifier.weight(1f)) { TxField(to, accent, "to") { to = it.filter { c -> c.isDigit() } } }
    }
    Box(Modifier.padding(top = d.gap)) { Chip("▶ BRUTE", selected = false, accent = accent, modifier = Modifier.fillMaxWidth()) { if (!active) Tx.ookBrute(freq, bits, from.toLongOrNull() ?: 0, to.toLongOrNull() ?: 0, 350) } }
    Note("Sweep a Princeton codespace — for your own remotes or a bench receiver.")
}

@Composable private fun HopperTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var count by remember { mutableStateOf(20) }
    var lowMhz by remember { mutableStateOf("433.0") }
    var highMhz by remember { mutableStateOf("434.0") }
    TxField(lowMhz, accent, "low (MHz)") { lowMhz = it }
    TxField(highMhz, accent, "high (MHz)") { highMhz = it }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        Chip("×$count", selected = false, accent = accent, modifier = Modifier.weight(1f)) { count = if (count == 20) 50 else if (count == 50) 100 else 20 }
        Chip("▶ HOP", selected = false, accent = accent, modifier = Modifier.weight(1.4f)) {
            if (!active) {
                val lo = ((lowMhz.toDoubleOrNull() ?: 433.0) * 1e6).toLong()
                val hi = ((highMhz.toDoubleOrNull() ?: 434.0) * 1e6).toLong()
                Tx.frequencyHopper(com.rocketgod.mayhem.core.TxApps.hopList(lo, hi, count), 100)
            }
        }
    }
    Note("Random-hop CW carrier for spread-spectrum experiments on a licence-free band.")
}

@Composable private fun AdsbTab(accent: Color, active: Boolean) {
    val d = rememberDims()
    var icao by remember { mutableStateOf("A19E43") }
    var me by remember { mutableStateOf("58C382C82F4D4A") }
    TxField(icao, accent, "ICAO 24-bit (hex)") { icao = it.uppercase().filter { c -> c in "0123456789ABCDEF" }.take(6) }
    TxField(me, accent, "ME field (56 bits hex)") { me = it.uppercase().filter { c -> c in "0123456789ABCDEF" }.take(14) }
    Box(Modifier.padding(top = d.gap)) { Chip("▶ SQUITTER", selected = false, accent = accent, modifier = Modifier.fillMaxWidth()) {
        if (!active) Tx.adsb(icao.toIntOrNull(16) ?: 0, me.padStart(14, '0').toULong(16).toLong())
    } }
    Note("Mode-S DF17 Extended Squitter (1090 MHz). Only for bench test / dummy load — real airspace is illegal.")
}

/** Session-scoped safety prompt: confirms an antenna or a dummy load is attached before the first transmission. */
@Composable
internal fun SafetyPromptDialog(accent: Color, onCancel: () -> Unit = { Apps.home() }, onAck: () -> Unit) {
    androidx.compose.material3.AlertDialog(
        onDismissRequest = {},
        containerColor = Palette.surface,
        titleContentColor = accent,
        textContentColor = Palette.ink,
        title = { Text("Before you transmit", fontFamily = Mono, fontWeight = FontWeight.Bold) },
        text = {
            Column {
                Text("Do you have an antenna, dummy load or matched load on the ANT port?", fontFamily = Mono, modifier = Modifier.padding(bottom = 6.dp))
                Text("• Transmitting into an open port can damage the HackRF.", fontFamily = Mono, color = Palette.muted, fontSize = 12.sp)
                Text("• Most bands need a licence — know the rules where you are.", fontFamily = Mono, color = Palette.muted, fontSize = 12.sp)
                Text("• Turn TX GAIN low first; the amp adds +14 dB.", fontFamily = Mono, color = Palette.muted, fontSize = 12.sp)
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(onClick = onAck) { Text("I HAVE ONE — CONTINUE", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold) } },
        dismissButton = { androidx.compose.material3.TextButton(onClick = onCancel) { Text("CANCEL", color = Palette.muted, fontFamily = Mono) } },
    )
}
