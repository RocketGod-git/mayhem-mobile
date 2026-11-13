package com.rocketgod.mayhem.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.utf16CodePoint
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import kotlin.math.roundToLong

/** GHz, MHz, kHz, Hz: every frequency the app asks for. */
val FREQ_UNITS: List<Pair<String, Double>> = listOf("GHz" to 1e9, "MHz" to 1e6, "kHz" to 1e3, "Hz" to 1.0)

/** A key pressed on the keypad, applied to what has been typed so far. */
fun keypadEdit(text: String, k: String): String = when {
    k == "bs" -> text.dropLast(1)
    k == "C" -> ""
    k == "±" -> if (text.startsWith("-")) text.drop(1) else "-$text"
    k == "." -> if (text.contains('.')) text else text + k
    k.length == 1 && k[0].isDigit() -> text + k
    else -> text
}

/** A hardware key as the keypad reads it ("0".."9", ".", "-", "enter", "bs", "esc", or a letter); null for anything else. */
fun keypadHardKey(e: KeyEvent): String? {
    if (e.type != KeyEventType.KeyDown) return null
    return when (e.key) {
        Key.Enter, Key.NumPadEnter -> "enter"; Key.Backspace -> "bs"; Key.Escape -> "esc"
        Key.DirectionLeft -> "left"; Key.DirectionRight -> "right"
        else -> { val c = e.utf16CodePoint; if (c > 0) c.toChar().lowercaseChar().toString() else null }
    }
}

/**
 * The app's keypad: the one way a frequency (or any value with a unit) is typed, in every app, the same as the web
 * app's. Digits count 1 2 3 from the top, then 0, '.', and C (± for a [signed] value), ⌫, and a column of [units]: a
 * unit key enters the number in that unit. [text] is what has been typed; [hint] shows dim while it is empty.
 * [onHardKey] takes a hardware keyboard's keys first (digits, '.', '-', Backspace, Esc, Enter, a unit's first letter).
 */
@Composable
fun KeypadDialog(label: String, text: String, hint: String, units: List<Pair<String, Double>>, signed: Boolean, accent: Color,
                 onKey: (String) -> Unit, onUnit: (Double) -> Unit, onHardKey: (String) -> Boolean, onClose: () -> Unit) {
    val d = rememberDims()
    val focus = remember { FocusRequester() }
    val blink by rememberInfiniteTransition(label = "caret").animateFloat(1f, 0f, infiniteRepeatable(tween(600, easing = LinearEasing), RepeatMode.Reverse), label = "caret")
    Dialog(onDismissRequest = onClose) {
        val shape = RoundedCornerShape(d.dp(16f))
        Column(Modifier.widthIn(max = d.dp(380f)).clip(shape).background(Palette.surface).border(1.dp, lerp(Palette.line, accent, 0.5f), shape)
            .focusRequester(focus).focusable().onKeyEvent { e -> keypadHardKey(e)?.let(onHardKey) ?: false }
            .padding(d.dp(14f)), verticalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label, color = accent, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(12f), letterSpacing = 2.sp, modifier = Modifier.weight(1f))
                Text("✕", color = Palette.muted, fontSize = d.sp(18f), modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable { onClose() }.padding(horizontal = 8.dp))
            }
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Palette.paper).border(1.dp, Palette.line, RoundedCornerShape(10.dp)).padding(horizontal = d.dp(12f), vertical = d.dp(8f)),
                verticalAlignment = Alignment.CenterVertically) {
                if (text.isEmpty()) {
                    // nothing typed yet: the caret, then the value now, dim
                    Box(Modifier.weight(1f))
                    Box(Modifier.padding(end = 6.dp).width(3.dp).height(d.dp(30f)).alpha(blink).background(KEYPAD_CARET))
                    Text(hint, color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(18f), maxLines = 1)
                } else {
                    Text(text, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(30f), textAlign = TextAlign.End, maxLines = 1,
                        style = TextStyle(shadow = Shadow(accent.copy(alpha = 0.4f), blurRadius = 24f)), modifier = Modifier.weight(1f))
                    Box(Modifier.padding(start = 3.dp).width(3.dp).height(d.dp(30f)).alpha(blink).background(KEYPAD_CARET))
                }
            }
            val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "0", ".", if (signed) "±" else "C")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                Column(Modifier.weight(3f), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    for (row in keys.chunked(3)) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                        for (k in row) KeypadKey(k, Palette.ink, Modifier.weight(1f)) { onKey(k) }
                    }
                }
                Column(Modifier.weight(1.3f), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                    for ((l, m) in units) KeypadKey(l, accent, Modifier.fillMaxWidth(), filled = true) { onUnit(m) }
                    KeypadKey("⌫", Palette.muted, Modifier.fillMaxWidth()) { onKey("bs") }
                }
            }
        }
    }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
}

private val KEYPAD_CARET = Color(0xFFFFAF00)

@Composable
private fun KeypadKey(label: String, c: Color, modifier: Modifier, filled: Boolean = false, onClick: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(10.dp)
    Box(modifier.height(d.dp(48f)).clip(shape).background(if (filled) c.copy(alpha = 0.18f) else Palette.paper).border(1.dp, if (filled) c else Palette.line, shape).clickable { onClick() },
        contentAlignment = Alignment.Center) {
        // every unit key one size, every digit another
        Text(label, color = c, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(if (filled) 14f else 20f), maxLines = 1)
    }
}

/** A frequency as a keypad field shows it: MHz, without trailing zeros. */
fun keypadMhz(hz: Long): String = String.format(java.util.Locale.US, "%.6f", hz / 1e6).trimEnd('0').trimEnd('.') + " MHz"

/**
 * The keypad for a frequency: a unit key enters it in that unit; Enter on a keyboard takes MHz, or Hz when it was typed
 * out in full (100000 and up). [onDone] gets the frequency in Hz, or null when the keypad was closed.
 */
@Composable
fun FreqKeypad(label: String, hz: Long?, accent: Color, onDone: (Long?) -> Unit) {
    var text by remember { mutableStateOf("") }
    fun finish(mult: Double) {
        val v = text.toDoubleOrNull()
        if (v == null || !(v * mult).isFinite() || v <= 0) { onDone(null); return }
        onDone((v * mult).roundToLong())
    }
    val hint = if (hz != null && hz > 0) keypadMhz(hz) else ""
    KeypadDialog(label, text, hint = hint,
        units = FREQ_UNITS, signed = false, accent = accent,
        onKey = { text = keypadEdit(text, it) }, onUnit = { finish(it) },
        onHardKey = { k ->
            when {
                k == "esc" -> { onDone(null); true }
                k == "enter" -> { finish(if ((text.toDoubleOrNull() ?: 0.0) >= 1e5) 1.0 else 1e6); true }
                k == "bs" -> { text = keypadEdit(text, "bs"); true }
                k == "," || k == "." -> { text = keypadEdit(text, "."); true }
                k.length == 1 && k[0].isDigit() -> { text = keypadEdit(text, k); true }
                else -> FREQ_UNITS.firstOrNull { it.first[0].lowercaseChar().toString() == k }?.let { finish(it.second); true } ?: false
            }
        },
        onClose = { onDone(null) })
}

/**
 * A value typed on the keypad, shown as a field: its [label] small over the value (or "any", dim), a tap opens the
 * keypad ([onClick]), and ✕ clears it when [onClear] is given and it has a value.
 */
@Composable
fun KeypadField(label: String, value: String?, accent: Color, modifier: Modifier = Modifier, onClear: (() -> Unit)? = null, onClick: () -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(8.dp)
    Row(modifier.clip(shape).border(1.dp, if (value != null) accent.copy(alpha = 0.6f) else Palette.line, shape).clickable { onClick() }
        .padding(horizontal = d.dp(10f), vertical = d.dp(6f)), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1)
            Text(value ?: "any", color = if (value != null) Palette.ink else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 1)
        }
        if (value != null && onClear != null)
            Text("✕", color = Palette.muted, fontSize = d.sp(14f), modifier = Modifier.clip(RoundedCornerShape(6.dp)).clickable { onClear() }.padding(horizontal = 4.dp))
    }
}
