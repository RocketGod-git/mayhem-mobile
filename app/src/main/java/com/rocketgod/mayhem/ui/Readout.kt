package com.rocketgod.mayhem.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.Bookmarks
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.Scanner
import com.rocketgod.mayhem.core.SdrEngine
import kotlin.math.abs

private val GROUPS = listOf(listOf(1_000_000_000L) to "GHz", listOf(100_000_000L, 10_000_000L, 1_000_000L) to "MHz",
    listOf(100_000L, 10_000L, 1_000L) to "kHz", listOf(100L, 10L, 1L) to "Hz")

/**
 * "433.92", "433,92", "144390k", "1.2 GHz", "162550000 Hz": a unit wins; a bare number is MHz, or Hz once it is too
 * big to be MHz. Null when it does not read as a frequency.
 */
fun parseFreq(s: String): Long? {
    val m = Regex("^\\s*(\\d+(?:[.,]\\d*)?|[.,]\\d+)\\s*([kmgKMG])?([hH][zZ])?\\s*$").find(s) ?: return null
    val v = m.groupValues[1].replace(',', '.').toDoubleOrNull() ?: return null
    val mul = when (m.groupValues[2].lowercase()) { "k" -> 1e3; "m" -> 1e6; "g" -> 1e9; else -> if (m.groupValues[3].isNotEmpty() || v >= 1e5) 1.0 else 1e6 }
    return if (v > 0) Math.round(v * mul) else null
}

/**
 * The frequency as ten digits from 1 GHz down to 1 Hz, each its own control: tap its top half to add one, its bottom
 * half to take one away, or slide up and down for a run. Leading zeros are dimmed so the eye lands on the live
 * digits, and each group is captioned with its unit.
 */
@Composable
fun FreqDigits(hz: Long, big: Boolean, tint: Color, preview: Boolean, onTune: ((Long) -> Unit)?) {
    val d = rememberDims()
    val haptic = LocalHapticFeedback.current
    val now = rememberUpdatedState(hz)
    val tuneNow = rememberUpdatedState(onTune)
    val stepPx = with(LocalDensity.current) { 22.dp.toPx() }
    val fs = d.sp(if (big) 34f else 26f)
    val fsPx = with(LocalDensity.current) { fs.toPx() }
    // which way the last change went, so every digit that moved flashes the same direction
    val last = remember { longArrayOf(hz) }
    val dir = if (hz > last[0]) 1 else if (hz < last[0]) -1 else 0
    SideEffect { last[0] = hz }
    var lead = true
    Row(verticalAlignment = Alignment.Bottom) {
        GROUPS.forEachIndexed { gi, (weights, unit) ->
            if (gi > 0) Text(".", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = fs, modifier = Modifier.padding(bottom = d.dp(9f)))
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Row {
                    for (w in weights) key(w) {
                        val v = ((hz / w) % 10).toInt()
                        if (v != 0 || w <= 1_000_000L) lead = false
                        val dim = lead
                        val base = when { preview -> Palette.accent2; dim -> Palette.muted.copy(alpha = 0.4f); w >= 1_000_000L -> Palette.ink; else -> tint }
                        // a digit that changes kicks a little in the direction it moved, lit in the second accent
                        val flash = remember { Animatable(0f) }
                        val kick = remember { intArrayOf(0) }
                        val seen = remember { intArrayOf(v) }
                        LaunchedEffect(v) {
                            if (v != seen[0] && dir != 0) { kick[0] = dir; flash.snapTo(1f); flash.animateTo(0f, tween(250)) }
                            seen[0] = v
                        }
                        val color = lerp(base, Palette.accent2, flash.value)
                        val hint = Palette.accent2.copy(alpha = 0.35f)
                        Text("$v", color = color, fontFamily = Mono, fontWeight = if (w >= 1_000_000L) FontWeight.Black else FontWeight.Bold, fontSize = fs,
                            modifier = (if (onTune == null || preview) Modifier else Modifier.drawBehind {
                                // faint chevrons on every tunable digit: there is no hover on a phone to reveal them
                                val t = fsPx * 0.14f; val cx = size.width / 2
                                drawPath(Path().apply { moveTo(cx - t, t); lineTo(cx + t, t); lineTo(cx, 0f); close() }, hint)
                                drawPath(Path().apply { moveTo(cx - t, size.height - t); lineTo(cx + t, size.height - t); lineTo(cx, size.height); close() }, hint)
                            }).graphicsLayer { translationY = -kick[0] * flash.value * fsPx * 0.12f }.then(if (onTune == null) Modifier else Modifier.pointerInput(w) {
                                awaitEachGesture {
                                    val down = awaitFirstDown()
                                    var moved = 0f; var stepped = false
                                    while (true) {
                                        val ev = awaitPointerEvent()
                                        val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
                                        if (!ch.pressed) break
                                        moved += ch.position.y - ch.previousPosition.y
                                        while (abs(moved) >= stepPx) {
                                            val dir = if (moved < 0) 1 else -1
                                            tuneNow.value?.invoke(now.value + dir * w); stepped = true
                                            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                            moved -= -dir * stepPx
                                        }
                                        ch.consume()
                                    }
                                    if (!stepped) {
                                        tuneNow.value?.invoke(now.value + if (down.position.y < size.height / 2f) w else -w)
                                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    }
                                }
                            }))
                    }
                }
                Text(unit, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8f), letterSpacing = 1.sp)
            }
        }
    }
}

/** Key a frequency in; the phone brings up its number pad. */
@Composable
fun FreqEntryDialog(hz: Long, accent: Color, onDone: (Long?) -> Unit) {
    var text by remember { mutableStateOf("") }
    var bad by remember { mutableStateOf(false) }
    val go = { val f = parseFreq(text); if (f != null) onDone(f) else bad = true }
    AlertDialog(
        onDismissRequest = { onDone(null) },
        containerColor = Palette.surface, titleContentColor = Palette.ink, textContentColor = Palette.ink,
        title = { Text("Tune to", fontFamily = Mono, fontWeight = FontWeight.Bold) },
        text = {
            Column {
                OutlinedTextField(text, { text = it; bad = false }, singleLine = true,
                    placeholder = { Text("%.4f MHz".format(hz / 1e6), fontFamily = Mono) },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), keyboardActions = KeyboardActions(onDone = { go() }),
                    colors = OutlinedTextFieldDefaults.colors(focusedTextColor = Palette.ink, unfocusedTextColor = Palette.ink, focusedBorderColor = accent,
                        unfocusedBorderColor = Palette.line, cursorColor = accent))
                Text(if (bad) "that isn't a frequency — try 433.92, 144390k or 1.2G" else "433.92 · 144390k · 1.2G · 162550000 Hz",
                    color = if (bad) Palette.danger else Palette.muted, fontFamily = Mono, fontSize = 10.sp, modifier = Modifier.padding(top = 4.dp))
            }
        },
        confirmButton = { TextButton({ go() }) { Text("TUNE", color = accent, fontFamily = Mono) } },
        dismissButton = { TextButton({ onDone(null) }) { Text("CANCEL", color = Palette.muted, fontFamily = Mono) } },
    )
}

/**
 * The tuned frequency with digit tuning, keypad entry and a favorite star, then the level bar and the RX-health
 * line. [channelHz] overrides what is shown; [onTune] is where a digit or the keypad sends the new frequency.
 */
@Composable
fun FreqReadout(accent: Color, sub: String = "", big: Boolean = false, channelHz: Long? = null, onTune: ((Long) -> Unit)? = { SdrEngine.tune(it) }) {
    val d = rememberDims()
    val lo by SdrEngine.freqHz.collectAsState()
    val offset by SdrEngine.offsetHz.collectAsState()
    val mode by SdrEngine.mode.collectAsState()
    val level by SdrEngine.levelDb.collectAsState()
    val squelch by SdrEngine.squelchDb.collectAsState()
    val sqOpen by SdrEngine.squelchOpen.collectAsState()
    val scanning by Scanner.active.collectAsState()
    val marks by Bookmarks.list.collectAsState()
    var keying by remember { mutableStateOf(false) }
    val preview = Tuning.previewHz
    val tuned = channelHz ?: (lo + offset)
    val freq = preview ?: tuned
    val tint = if (preview != null) Palette.accent2 else accent
    if (keying) FreqEntryDialog(tuned, accent) { f -> keying = false; if (f != null) onTune?.invoke(f) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        FreqDigits(freq, big, tint, preview != null, onTune)
        if (onTune != null) Column(Modifier.padding(start = d.dp(6f)), horizontalAlignment = Alignment.CenterHorizontally) {
            val fav = marks.firstOrNull { abs(it.hz - tuned) < 50 }
            Text(if (fav != null) "★" else "☆", color = if (fav != null) Palette.accent2 else Palette.muted, fontSize = d.sp(18f),
                modifier = Modifier.clickable { Bookmarks.star(tuned, mode) }.padding(horizontal = 4.dp))
            Text("⌨", color = Palette.muted, fontSize = d.sp(16f), modifier = Modifier.clickable { keying = true }.padding(horizontal = 4.dp))
        }
    }
    if (squelch > 0 || scanning) {
        val badge = if (scanning) (if (sqOpen) "SCAN · SIGNAL" else "SCAN") else if (sqOpen) "OPEN" else "SQL"
        val c = if (sqOpen) Palette.ok else Palette.muted
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            Text(badge, color = c, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp,
                modifier = Modifier.border(1.dp, c, RoundedCornerShape(3.dp)).padding(horizontal = 5.dp, vertical = 1.dp))
        }
    }
    LevelBar(level, tint, Modifier.fillMaxWidth().padding(horizontal = d.dp(24f), vertical = d.dp(3f)).height(d.dp(4f)))
    if (sub.isNotEmpty()) Text(sub, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f),
        modifier = Modifier.fillMaxWidth(), maxLines = 1, textAlign = TextAlign.Center)
    val radio by Radio.kind.collectAsState()
    val lim = Radio.limits
    if (radio != Radio.Kind.NONE && !Radio.canTune(lim, freq))
        Text("outside this ${Radio.name}'s %d–%d MHz".format(lim.minHz / 1_000_000, lim.maxHz / 1_000_000),
            color = Palette.danger, fontFamily = Mono, fontSize = d.sp(9f), modifier = Modifier.fillMaxWidth(), maxLines = 1, textAlign = TextAlign.Center)
}
