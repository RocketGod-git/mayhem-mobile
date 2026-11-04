package com.rocketgod.mayhem.ui

import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.LocalTextStyle
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
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.Station
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
                Box(Modifier.padding(top = d.dp(10f))) { ActionButton("OPEN SETTINGS", accent) { Apps.open(com.rocketgod.mayhem.core.MayhemApp.SETTINGS) } }
            }
            return@ScrollColumn
        }

        FreqCard(accent, tag = "TX", title = status.ifEmpty { "idle" }.uppercase(), freq = freq, meter = gain / 47f, scale = listOf(0f to "0", 10f / 47f to "10", 20f / 47f to "20", 30f / 47f to "30", 1f to "47 dB"),
            left = "GAIN $gain dB", right = if (amp) "AMP +14 dB" else "AMP off", rightColor = if (amp) accent else Palette.muted,
            lamp = { if (active) Lamp("ON AIR", accent, blink = true) else Lamp("IDLE", Palette.muted) })

        // IF gain 0–47 dB; AMP adds 14 dB
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(top = d.dp(10f)), horizontalArrangement = Arrangement.spacedBy(d.dp(8f)),
            verticalAlignment = Alignment.CenterVertically) {
            val gains = listOf(0, 10, 20, 30, 47)
            RowLabel("GAIN")
            SegBar(gains.map { "$it" }, gains.indexOf(gain), accent, Modifier.weight(1f).fillMaxHeight()) { Tx.setGain(gains[it]) }
            ToggleBox("AMP", amp, accent, Modifier.fillMaxHeight()) { Tx.toggleAmp() }
        }

        val modes = listOf(
            "Signal", "Tones", "POCSAG", "RTTY",
            "APRS", "Morse", "OOK", "Replay",
            "MDC", "QC-II", "SubGHz", "KeeLoq",
            "Noise", "Brute", "Hopper",
            // ADS-B TX ships only in the sideload APK (the same build flag as Troll): Play's policy has no room for
            // an app that puts aircraft on someone else's display. It stays last so every other mode keeps its index.
        ) + (if (com.rocketgod.mayhem.BuildConfig.INCLUDE_TROLL) listOf("ADS-B") else emptyList())
        // what each sends, from its own panel's note
        val subs = mapOf("Signal" to "test carrier", "Tones" to "DTMF", "POCSAG" to "pager", "RTTY" to "45 baud", "APRS" to "AX.25", "Morse" to "CW",
            "OOK" to "PT2262", "Replay" to "IQ capture", "MDC" to "PTT-ID", "QC-II" to "two-tone", "SubGhz" to "Flipper .sub", "KeeLoq" to "HCS301",
            "Noise" to "OOK noise", "Brute" to "PT2262", "Hopper" to "hop list", "ADS-B" to "DF17")
        Box(Modifier.padding(top = d.dp(10f))) {
            TileGrid(modes.mapIndexed { i, m -> Tile(m.uppercase(), subs[m] ?: "", tab == i) }, accent, columns = 4) { tab = it }
        }

        Column(Modifier.fillMaxWidth().padding(top = d.dp(8f))) {
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
                14 -> HopperTab(accent, active)
                15 -> if (com.rocketgod.mayhem.BuildConfig.INCLUDE_TROLL) AdsbTab(accent, active)
            }
        }

        if (active) ToggleBox("■  STOP", true, accent, Modifier.fillMaxWidth().padding(top = d.dp(10f))) { Tx.stop() }
    }
}

@Composable private fun TonesTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var digits by remember { mutableStateOf("1234") }
    Row(Modifier.fillMaxWidth().padding(bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        ActionButton("▶ 1 kHz", accent, Modifier.weight(1f)) { if (!active) Tx.tones(Tx.ToneMode.SINGLE, "", freq) }
        ActionButton("▶ TWO-TONE", accent, Modifier.weight(1f)) { if (!active) Tx.tones(Tx.ToneMode.TWO_TONE, "", freq) }
    }
    TxField(digits, accent, "DTMF digits (0-9 A-D * #)", kb = Kb.CAPS) { digits = it.uppercase().filter { c -> c in "0123456789ABCD*#" }.take(32) }
    Box(Modifier.padding(top = d.dp(10f))) { ActionButton("▶ SEND DTMF", accent, Modifier.fillMaxWidth()) { if (!active) Tx.tones(Tx.ToneMode.DTMF, digits, freq) } }
}

@Composable private fun PocsagTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var addr by remember { mutableStateOf("1234567") }
    var msg by remember { mutableStateOf("TEST DE MAYHEM") }
    var baud by remember { mutableStateOf(1200) }
    var numeric by remember { mutableStateOf(false) }
    TxField(addr, accent, "address (RIC)", kb = Kb.NUMBER) { addr = digitsOf(it, 7) }
    TxField(msg, accent, if (numeric) "digits 0-9 SU-][ " else "message") { msg = (if (numeric) it.filter { c -> c in "0123456789SU -][" } else it).take(80) }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap), verticalAlignment = Alignment.CenterVertically) {
        val bauds = listOf(512, 1200, 2400)
        SegBar(bauds.map { "$it" }, bauds.indexOf(baud), accent, Modifier.weight(1f)) { baud = bauds[it] }
        SegBar(listOf("ALPHA", "NUM"), if (numeric) 1 else 0, accent, Modifier.weight(1f)) { numeric = it == 1 }
    }
    Box(Modifier.padding(top = d.dp(10f))) { ActionButton("▶ PAGE", accent, Modifier.fillMaxWidth()) {
        if (!active) Tx.pocsag(addr.toIntOrNull() ?: 0, 3, msg, if (numeric) TxEncoders.PocsagType.NUMERIC else TxEncoders.PocsagType.ALPHANUMERIC, baud, freq) } }
    Note("Decodes on the Pager RX app and on PDW. RIC + function 3.")
}

@Composable private fun RttyTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var text by remember { mutableStateOf("RYRYRY DE ${stationCall()}") }
    var shift by remember { mutableStateOf(170) }
    TxField(text, accent, "text", kb = Kb.CAPS) { text = it.take(120) }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        val shifts = listOf(170, 425, 850)
        SegBar(shifts.map { "$it Hz" }, shifts.indexOf(shift), accent, Modifier.weight(1f)) { shift = shifts[it] }
    }
    Box(Modifier.padding(top = d.dp(10f))) {
        ActionButton("▶ SEND 45 bd", accent, Modifier.fillMaxWidth()) { if (!active) Tx.rtty(text, 45, shift.toDouble(), freq) }
    }
    Note("ITA2 Baudot, 45.45 baud — decodes on any RTTY reader (fldigi, etc.).")
}

@Composable private fun AprsTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var call by remember { mutableStateOf(Station.aprsCall()) }
    var info by remember { mutableStateOf("!4903.50N/07201.75W-Mayhem Mobile") }
    TxField(call, accent, "source callsign-ssid", kb = Kb.CAPS) { call = it.uppercase().take(9) }
    TxField(info, accent, "AX.25 info (position/status)") { info = it.take(120) }
    Box(Modifier.padding(top = d.dp(10f))) { ActionButton("▶ BEACON 144.39", accent, Modifier.fillMaxWidth()) { if (!active) Tx.aprs(call, info, freq) } }
    Note("Bell 202 AX.25 UI frame — decodes on the APRS app and on any TNC. Ham license required on 144.39.")
}

@Composable private fun SigGenTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    for (m in Tx.SigMode.values().toList().chunked(2)) {
        Row(Modifier.fillMaxWidth().padding(bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (mode in m) ActionButton("▶ " + mode.label.uppercase(), accent, Modifier.weight(1f)) { if (!active) Tx.sigGen(freq, mode) }
            if (m.size == 1) Box(Modifier.weight(1f))
        }
    }
    Note("A continuous test signal until you press STOP. Use a dummy load.")
}

@Composable private fun MorseTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var text by remember { mutableStateOf("CQ DE ${stationCall()}") }
    var wpm by remember { mutableStateOf(20) }
    var fm by remember { mutableStateOf(true) }
    TxField(text, accent, "message", kb = Kb.CAPS) { text = it.uppercase().take(80) }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap), verticalAlignment = Alignment.CenterVertically) {
        val speeds = listOf(10, 15, 20, 25, 30)
        RowLabel("WPM")
        SegBar(speeds.map { "$it" }, speeds.indexOf(wpm), accent, Modifier.weight(1.4f)) { wpm = speeds[it] }
        SegBar(listOf("FM", "CW"), if (fm) 0 else 1, accent, Modifier.weight(1f)) { fm = it == 0 }
    }
    Box(Modifier.padding(top = d.dp(10f))) { ActionButton("▶ SEND", accent, Modifier.fillMaxWidth()) { if (!active) Tx.morse(text, wpm, freq, fm) } }
}

@Composable private fun OokTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var hex by remember { mutableStateOf("A5C3F1") }
    var bits by remember { mutableStateOf(24) }
    var te by remember { mutableStateOf(350) }
    TxField(hex, accent, "code (hex)", kb = Kb.HEX) { hex = hexOf(it, 12) }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap), verticalAlignment = Alignment.CenterVertically) {
        val bitsOpts = listOf(12, 24, 32); val teOpts = listOf(200, 350, 500)
        SegBar(bitsOpts.map { "$it bit" }, bitsOpts.indexOf(bits), accent, Modifier.weight(1f)) { bits = bitsOpts[it] }
        SegBar(teOpts.map { "${it}µs" }, teOpts.indexOf(te), accent, Modifier.weight(1f)) { te = teOpts[it] }
    }
    Box(Modifier.padding(top = d.dp(10f))) { ActionButton("▶ SEND ×8", accent, Modifier.fillMaxWidth()) { if (!active) Tx.ookPrinceton(freq, hex.toLongOrNull(16) ?: 0L, bits, te, 8) } }
    Note("Fixed-code Princeton/PT2262 OOK — for remotes you own on a license-free ISM band.")
}

@Composable private fun ReplayTab(accent: Color, active: Boolean) {
    val d = rememberDims()
    val rec = Apps.recorder
    val files = remember { rec?.listCaptures() ?: emptyList() }
    if (files.isEmpty()) { Note("No captures. Record raw IQ in the Capture app first; its sidecar carries the frequency to replay on."); return }
    Column(Modifier.fillMaxWidth()) {
        for (f in files) Box(Modifier.padding(bottom = d.dp(6f))) {
            ToggleBox("▶  $f", false, accent, Modifier.fillMaxWidth()) { if (!active && rec != null) Tx.replay(java.io.File(rec.directory, f)) }
        }
    }
}

internal enum class Kb { TEXT, CAPS, HEX, NUMBER, DECIMAL }

/** A transmit parameter field; [lines] > 1 makes it a paste box that grows to twice that before scrolling. */
@Composable internal fun TxField(value: String, accent: Color, label: String, modifier: Modifier = Modifier.fillMaxWidth(), kb: Kb = Kb.TEXT,
                                placeholder: String? = null, lines: Int = 1, onChange: (String) -> Unit) {
    val keys = when (kb) {
        Kb.TEXT -> KeyboardOptions.Default
        Kb.CAPS -> KeyboardOptions(capitalization = KeyboardCapitalization.Characters)
        Kb.HEX -> KeyboardOptions(capitalization = KeyboardCapitalization.Characters, keyboardType = KeyboardType.Ascii)
        Kb.NUMBER -> KeyboardOptions(keyboardType = KeyboardType.Number)
        Kb.DECIMAL -> KeyboardOptions(keyboardType = KeyboardType.Decimal)
    }
    OutlinedTextField(value, onChange, modifier = modifier, singleLine = lines == 1, minLines = lines, maxLines = if (lines == 1) 1 else lines * 2,
        textStyle = LocalTextStyle.current.copy(fontFamily = Mono), keyboardOptions = keys,
        label = { Text(label, fontFamily = Mono, maxLines = 1) },
        placeholder = if (placeholder != null) { { Text(placeholder, fontFamily = Mono, color = Palette.muted) } } else null,
        colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Palette.ink, unfocusedTextColor = Palette.ink, focusedBorderColor = accent,
            unfocusedBorderColor = Palette.line, cursorColor = accent, focusedLabelColor = accent, unfocusedLabelColor = Palette.muted))
}

private fun hexOf(s: String, max: Int) = s.uppercase().filter { it in "0123456789ABCDEF" }.take(max)
internal fun digitsOf(s: String, max: Int) = s.filter { it.isDigit() }.take(max)
internal fun decimalOf(s: String) = s.filter { it.isDigit() || it == '.' }.take(12)
/** The station callsign from Settings, or MAYHEM before one is set. */
private fun stationCall() = Station.info.value.call.ifBlank { "MAYHEM" }

@Composable internal fun Note(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.fillMaxWidth().padding(top = d.dp(8f)))
}

private fun txStep(hz: Long): String = if (hz >= 1_000_000L) "${hz / 1_000_000}" else if (hz >= 1_000L) ".${"%03d".format(hz / 1000)}" else "$hz"

@Composable private fun MdcTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var op by remember { mutableStateOf("01") }
    var arg by remember { mutableStateOf("00") }
    var unit by remember { mutableStateOf("1234") }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        TxField(op, accent, "op", Modifier.weight(1f), Kb.HEX) { op = hexOf(it, 2) }
        TxField(arg, accent, "arg", Modifier.weight(1f), Kb.HEX) { arg = hexOf(it, 2) }
        TxField(unit, accent, "unit ID", Modifier.weight(2f), Kb.HEX) { unit = hexOf(it, 4) }
    }
    val opv = op.toIntOrNull(16)
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        val ops = listOf(0x01 to "PTT ID 01", 0x30 to "EMERG 30", 0x35 to "CHECK 35")
        SegBar(ops.map { it.second }, ops.indexOfFirst { it.first == opv }, accent) { op = "%02X".format(ops[it].first) }
    }
    Box(Modifier.padding(top = d.dp(10f))) { ActionButton("▶ PTT-ID", accent, Modifier.fillMaxWidth()) {
        if (!active) Tx.mdc1200(opv ?: 0, arg.toIntOrNull(16) ?: 0, unit.toIntOrNull(16) ?: 0, freq) } }
    Note("MDC-1200 Motorola PTT-ID · op / arg (hex) / 16-bit unit ID (hex) · 1200 bd AFSK — for business-band radios you own.")
}

@Composable private fun QcTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var a by remember { mutableStateOf("1122.5") }
    var b by remember { mutableStateOf("1465.5") }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        TxField(a, accent, "Tone A (Hz)", Modifier.weight(1f), Kb.DECIMAL) { a = decimalOf(it) }
        TxField(b, accent, "Tone B (Hz)", Modifier.weight(1f), Kb.DECIMAL) { b = decimalOf(it) }
    }
    Box(Modifier.padding(top = d.dp(10f))) { ActionButton("▶ PAGE QC-II", accent, Modifier.fillMaxWidth()) {
        if (!active) Tx.quickCall2(a.toDoubleOrNull() ?: 0.0, b.toDoubleOrNull() ?: 0.0, freq) } }
    Note("Quick-Call II two-tone paging (fire, utility). 1 s A, 3 s B, then a 26 s carrier tail.")
}

@Composable private fun SubGhzTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var raw by remember { mutableStateOf("") }
    var reps by remember { mutableStateOf(3) }
    TxField(raw, accent, "Flipper .sub file", placeholder = "Paste a Flipper .sub file here — Protocol: RAW / RAW_Data: 340 -1020 …", lines = 5) { raw = it }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        val repOpts = listOf(1, 3, 5, 10, 20)
        RowLabel("REPEAT")
        SegBar(repOpts.map { "×$it" }, repOpts.indexOf(reps), accent, Modifier.weight(1f)) { reps = repOpts[it] }
    }
    Box(Modifier.padding(top = d.dp(10f))) {
        ActionButton("▶ REPLAY", accent, Modifier.fillMaxWidth()) { if (!active) Tx.subghzReplay(raw, freq, reps) }
    }
    Note("Replay a Flipper Zero .sub file's RAW pulses as OOK, 2 Msps — remotes on your own equipment.")
}

@Composable private fun KeeloqTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var key by remember { mutableStateOf("5CEC6701B79FD949") }
    var serial by remember { mutableStateOf("1234567") }
    var button by remember { mutableStateOf("2") }
    var counter by remember { mutableStateOf("42") }
    var reps by remember { mutableStateOf(3) }
    TxField(key, accent, "64-bit key (hex)", kb = Kb.HEX) { key = hexOf(it, 16) }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        TxField(serial, accent, "serial (hex)", Modifier.weight(1.5f), Kb.HEX) { serial = hexOf(it, 7) }
        TxField(button, accent, "btn", Modifier.weight(0.7f), Kb.NUMBER) { button = digitsOf(it, 2) }
        TxField(counter, accent, "counter", Modifier.weight(1f), Kb.NUMBER) { counter = digitsOf(it, 6) }
    }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        val repOpts = listOf(1, 2, 3, 5, 8)
        RowLabel("REPEAT")
        SegBar(repOpts.map { "×$it" }, repOpts.indexOf(reps), accent, Modifier.weight(1f)) { reps = repOpts[it] }
    }
    Box(Modifier.padding(top = d.dp(10f))) {
        ActionButton("▶ HOP", accent, Modifier.fillMaxWidth()) {
            if (!active) Tx.keeloqTx(key.toULongOrNull(16)?.toLong() ?: 0L, serial.toIntOrNull(16) ?: 0, (button.toIntOrNull() ?: 0).coerceAtMost(15),
                counter.toIntOrNull() ?: 0, freq, reps)
        }
    }
    Note("HCS301 (Microchip) rolling code · 64-bit key / 28-bit serial (hex) / 4-bit button / counter · OOK PWM — needs the manufacturer key. Test on equipment you own.")
}

@Composable private fun NoiseTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var chip by remember { mutableStateOf("100") }
    var secs by remember { mutableStateOf("3") }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        TxField(chip, accent, "chip (µs)", Modifier.weight(1f), Kb.NUMBER) { chip = digitsOf(it, 7) }
        TxField(secs, accent, "seconds", Modifier.weight(1f), Kb.NUMBER) { secs = digitsOf(it, 5) }
    }
    Box(Modifier.padding(top = d.dp(10f))) { ActionButton("▶ NOISE", accent, Modifier.fillMaxWidth()) {
        if (!active) Tx.ookNoise(0L, chip.toIntOrNull() ?: 0, secs.toIntOrNull() ?: 0, freq) } }
    Note("Pseudo-random OOK for authorized RF-lab work on your own gear only. Illegal on populated bands.")
}

@Composable private fun BruteTab(accent: Color, freq: Long, active: Boolean) {
    val d = rememberDims()
    var bits by remember { mutableStateOf("24") }
    var from by remember { mutableStateOf("0") }
    var to by remember { mutableStateOf("255") }
    var te by remember { mutableStateOf("350") }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        TxField(bits, accent, "bits", Modifier.weight(1f), Kb.NUMBER) { bits = digitsOf(it, 2) }
        TxField(from, accent, "from", Modifier.weight(1f), Kb.NUMBER) { from = digitsOf(it, 10) }
        TxField(to, accent, "to", Modifier.weight(1f), Kb.NUMBER) { to = digitsOf(it, 10) }
    }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap), verticalAlignment = Alignment.CenterVertically) {
        TxField(te, accent, "te (µs)", Modifier.weight(1.5f), Kb.NUMBER) { te = digitsOf(it, 5) }
        val bitOpts = listOf(12, 24, 32)
        SegBar(bitOpts.map { "$it" }, bitOpts.indexOfFirst { "$it" == bits }, accent, Modifier.weight(2f)) { bits = "${bitOpts[it]}" }
    }
    Box(Modifier.padding(top = d.dp(10f))) { ActionButton("▶ BRUTE", accent, Modifier.fillMaxWidth()) {
        if (!active) Tx.ookBrute(freq, (bits.toIntOrNull() ?: 24).coerceIn(1, 32), from.toLongOrNull() ?: 0L, to.toLongOrNull() ?: 0L, te.toIntOrNull() ?: 350)
    } }
    Note("Princeton PT2262 brute force · bits (12/24/32), from–to (decimal), te µs — a gate or remote you own on ISM.")
}

@Composable private fun HopperTab(accent: Color, active: Boolean) {
    val d = rememberDims()
    var lowMhz by remember { mutableStateOf("433.05") }
    var highMhz by remember { mutableStateOf("434.79") }
    var count by remember { mutableStateOf("16") }
    var dwell by remember { mutableStateOf("20") }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        TxField(lowMhz, accent, "low (MHz)", Modifier.weight(1f), Kb.DECIMAL) { lowMhz = decimalOf(it) }
        TxField(highMhz, accent, "high (MHz)", Modifier.weight(1f), Kb.DECIMAL) { highMhz = decimalOf(it) }
    }
    Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
        TxField(count, accent, "hops", Modifier.weight(1f), Kb.NUMBER) { count = digitsOf(it, 5) }
        TxField(dwell, accent, "dwell (ms)", Modifier.weight(1f), Kb.NUMBER) { dwell = digitsOf(it, 5) }
    }
    Box(Modifier.padding(top = d.dp(10f))) { ActionButton("▶ HOP", accent, Modifier.fillMaxWidth()) {
        if (!active) {
            val lo = ((lowMhz.toDoubleOrNull() ?: 433.05) * 1e6).roundToLong()
            val hi = ((highMhz.toDoubleOrNull() ?: 434.79) * 1e6).roundToLong()
            Tx.frequencyHopper(com.rocketgod.mayhem.core.TxApps.hopList(lo, hi, count.toIntOrNull() ?: 16), (dwell.toIntOrNull() ?: 20).coerceAtLeast(1))
        }
    } }
    Note("Random-hop CW carrier · low–high MHz · hops · dwell ms each — spread-spectrum bench work on a license-free band.")
}

@Composable private fun AdsbTab(accent: Color, active: Boolean) {
    val d = rememberDims()
    var icao by remember { mutableStateOf("A19E43") }
    var me by remember { mutableStateOf("58C382C82F4D4A") }
    TxField(icao, accent, "ICAO 24-bit (hex)", kb = Kb.HEX) { icao = hexOf(it, 6) }
    TxField(me, accent, "ME field (56 bits hex)", kb = Kb.HEX) { me = hexOf(it, 14) }
    Box(Modifier.padding(top = d.dp(10f))) { ActionButton("▶ SQUITTER", accent, Modifier.fillMaxWidth()) {
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
                Text("• Most bands need a license — know the rules where you are.", fontFamily = Mono, color = Palette.muted, fontSize = 12.sp)
                Text("• Turn TX GAIN low first; the amp adds +14 dB.", fontFamily = Mono, color = Palette.muted, fontSize = 12.sp)
            }
        },
        confirmButton = { androidx.compose.material3.TextButton(onClick = onAck) { Text("I HAVE ONE — CONTINUE", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold) } },
        dismissButton = { androidx.compose.material3.TextButton(onClick = onCancel) { Text("CANCEL", color = Palette.muted, fontFamily = Mono) } },
    )
}
