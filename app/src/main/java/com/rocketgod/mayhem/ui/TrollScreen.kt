package com.rocketgod.mayhem.ui

import android.content.Context
import android.media.MediaPlayer
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.R
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.core.Tx
import com.rocketgod.mayhem.core.TxApps

/**
 * The "Troll" app: Mayhem's novelty transmitters — fixed-code OOK pranks, a .sub replay, FM jingles, Tesla
 * charge-port and weather-sensor spoofs — plus the shopping-cart wheel sounds, which are phone audio and need
 * no radio. Everything else transmits and is gated by the Settings TX switch and the first-TX safety prompt,
 * exactly like the Transmit app. Ships only in the sideload APK (BuildConfig.INCLUDE_TROLL / the launcher tile
 * is hidden in the Play build).
 */
@Composable
fun TrollScreen(defaultAccent: Color) {
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
    val radio by Radio.kind.collectAsState()
    val canTx = radio != Radio.Kind.RTLSDR
    if (needsPrompt && canTx && enabled) SafetyPromptDialog(accent) { Tx.acknowledgeSafety() }

    ScrollColumn(Modifier.fillMaxSize()) {
        // The shopping cart is audio-only, so it works on a receive-only dongle and with TX switched off.
        if (!canTx) {
            ReceiveOnlyNote(accent)
            Note("The transmitters need a HackRF. The shopping-cart sounds below are phone audio and work on any radio.")
            CartCard(ctx, accent)
            return@ScrollColumn
        }
        if (!enabled) {
            Column(Modifier.fillMaxWidth().panel(accent).padding(d.dp(12f))) {
                Text("TRANSMIT IS OFF", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), letterSpacing = 2.sp)
                Text("Most Troll tricks transmit — turn TX back on in Settings. The shopping-cart one is phone audio and works regardless.",
                    color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(top = d.dp(6f)))
                Box(Modifier.padding(top = d.dp(10f))) { Chip("OPEN SETTINGS", selected = false, accent = accent) { Apps.open(MayhemApp.SETTINGS) } }
            }
            CartCard(ctx, accent)
            return@ScrollColumn
        }

        FreqReadout(accent, if (status.isNotEmpty()) status else "idle", big = true)
        Note("Everything here transmits unless noted — use a dummy load or an antenna you are allowed to key. Some of these are regulated on air where you live.")

        SectionLabel("TUNE · MHz")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            for (s in longArrayOf(1_000_000L, 100_000L, 10_000L)) Chip("−" + trollStep(s), false, accent, Modifier.weight(1f)) { SdrEngine.tune(freq - s) }
            for (s in longArrayOf(10_000L, 100_000L, 1_000_000L)) Chip("+" + trollStep(s), false, accent, Modifier.weight(1f)) { SdrEngine.tune(freq + s) }
        }

        SectionLabel("TX GAIN · IF 0–47 dB   ·   AMP +14 dB")
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (g in intArrayOf(0, 10, 20, 30, 47)) Chip("$g", selected = gain == g, accent = accent, modifier = Modifier.weight(1f)) { Tx.setGain(g) }
            Chip(if (amp) "AMP" else "amp", selected = amp, accent = accent, modifier = Modifier.weight(1f)) { Tx.toggleAmp() }
        }

        // ---- ON THE DIAL: fires on the frequency tuned above --------------------------------------------------
        Column(Modifier.fillMaxWidth().padding(top = d.dp(10f)).panel(accent).padding(d.dp(12f))) {
            CardHead("📡 ON THE DIAL", "fires on the frequency tuned above", accent)

            SubLabel("Band · sub-GHz")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for ((label, hz) in listOf("433.92" to 433_920_000L, "315.00" to 315_000_000L, "868.35" to 868_350_000L, "915.00" to 915_000_000L))
                    Chip(label, selected = freq == hz, accent = accent, modifier = Modifier.weight(1f)) { SdrEngine.tune(hz) }
            }

            SubLabel("Fixed-code OOK · doorbells · outlets · gates")
            Row(Modifier.fillMaxWidth().padding(bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                Chip("Doorbell", false, accent, Modifier.weight(1f)) { if (!active) Tx.ookPrinceton(freq, 0x1A2B3CL, 24, 350, 12) }
                Chip("Outlet", false, accent, Modifier.weight(1f)) { if (!active) Tx.ookPrinceton(freq, 0x145591L, 24, 320, 10) }
                Chip("Fan / LED", false, accent, Modifier.weight(1f)) { if (!active) Tx.ookPrinceton(freq, 0x0AAA55L, 24, 380, 10) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                Chip("Code walk", false, accent, Modifier.weight(1f)) { if (!active) Tx.ookBrute(freq, 24, 0L, 255L, 350) }
                Chip("Gate opener", false, accent, Modifier.weight(1f)) { if (!active) Tx.gateOpener(12, 350, freq) }
                Chip("Static burst", false, accent, Modifier.weight(1f)) { if (!active) Tx.ookNoise(0L, 100, 3, freq) }
            }

            SubLabel("Replay a capture · paste a Flipper .sub")
            var raw by remember { mutableStateOf("") }
            var reps by remember { mutableStateOf(3) }
            TxField(raw, accent, "Flipper .sub file", placeholder = "Protocol: RAW / RAW_Data: 340 -1020 340 -1020 …", lines = 3) { raw = it }
            Row(Modifier.fillMaxWidth().padding(top = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                GainStepper("×", reps, accent, Modifier.weight(1f), onMinus = { reps = (reps - 1).coerceAtLeast(1) }, onPlus = { reps = (reps + 1).coerceAtMost(20) })
                Chip("▶ FIRE .SUB", selected = false, accent = accent, modifier = Modifier.weight(1f)) { if (!active) Tx.subghzReplay(raw, freq, reps) }
            }

            SubLabel("FM jingle · tune to a station first")
            for (row in TxApps.tuneNames().chunked(3)) {
                Row(Modifier.fillMaxWidth().padding(bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                    for (name in row) Chip(name, selected = false, accent = accent, modifier = Modifier.weight(1f)) { if (!active) Tx.jingle(name, freq) }
                    repeat(3 - row.size) { Box(Modifier.weight(1f)) }
                }
            }

            SubLabel("Morse · troll a repeater in code")
            var morse by remember { mutableStateOf("HI HI") }
            TxField(morse, accent, "message", kb = Kb.CAPS) { morse = it.uppercase().take(60) }
            Box(Modifier.padding(top = d.gap)) { Chip("▶ SEND MORSE", selected = false, accent = accent, modifier = Modifier.fillMaxWidth()) { if (!active) Tx.morse(morse, 20, freq, true) } }
        }

        // ---- FIXED SIGNALS: each sets its own frequency -------------------------------------------------------
        Column(Modifier.fillMaxWidth().padding(top = d.dp(10f)).panel(accent).padding(d.dp(12f))) {
            CardHead("🎯 FIXED SIGNALS", "each sets its own frequency", accent)

            SubLabel("Tesla charge port")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                Chip("US · 315", false, accent, Modifier.weight(1f)) { if (!active) { SdrEngine.tune(315_000_000L); Tx.teslaChargePort(315_000_000L) } }
                Chip("EU · 433.92", false, accent, Modifier.weight(1f)) { if (!active) { SdrEngine.tune(433_920_000L); Tx.teslaChargePort(433_920_000L) } }
            }

            SubLabel("Weather spoof · phantom Acurite · 433.92")
            var temp by remember { mutableStateOf("45") }
            var hum by remember { mutableStateOf("50") }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap), verticalAlignment = Alignment.CenterVertically) {
                TxField(temp, accent, "°C", Modifier.weight(1f), Kb.DECIMAL) { temp = decimalOf(it) }
                TxField(hum, accent, "%RH", Modifier.weight(1f), Kb.NUMBER) { hum = digitsOf(it, 3) }
                Chip("▶ SEND", selected = false, accent = accent, modifier = Modifier.weight(1f)) {
                    if (!active) {
                        SdrEngine.tune(433_920_000L)
                        val h = hum.trim().ifBlank { null }?.toIntOrNull()
                        Tx.weatherSpoof(temp.toDoubleOrNull() ?: 20.0, h, 433_920_000L)
                    }
                }
            }
        }

        CartCard(ctx, accent)

        if (active) Box(Modifier.padding(top = d.dp(10f))) { Chip("■ STOP", selected = true, accent = accent, modifier = Modifier.fillMaxWidth()) { Tx.stop() } }
    }
}

/** Shopping-cart wheel sounds — real captures played through the phone speaker; no radio involved. */
@Composable
private fun CartCard(ctx: Context, accent: Color) {
    val d = rememberDims()
    Column(Modifier.fillMaxWidth().padding(top = d.dp(10f)).panel(Palette.accent2).padding(d.dp(12f))) {
        CardHead("🛒 SHOPPING CART", "real wheel sounds · phone speaker · no radio", Palette.accent2)

        Image(painterResource(R.drawable.cart_gk), "Gatekeeper locking cart wheel",
            Modifier.fillMaxWidth().height(d.dp(120f)).padding(vertical = d.dp(4f)), contentScale = ContentScale.Fit)
        Text("Gatekeeper · 7.8 kHz", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(bottom = d.gap))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip("Unlock", false, Palette.accent2, Modifier.weight(1f)) { CartSound.play(ctx, R.raw.cart_gk_unlock) }
            Chip("Lock", false, Palette.accent2, Modifier.weight(1f)) { CartSound.play(ctx, R.raw.cart_gk_lock) }
        }

        Image(painterResource(R.drawable.cart_rc), "Rocateq locking cart wheel",
            Modifier.fillMaxWidth().height(d.dp(120f)).padding(top = d.dp(10f), bottom = d.dp(4f)), contentScale = ContentScale.Fit)
        Text("Rocateq", color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), modifier = Modifier.padding(bottom = d.gap))
        Row(Modifier.fillMaxWidth().padding(bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip("Unlock", false, Palette.accent2, Modifier.weight(1f)) { CartSound.play(ctx, R.raw.cart_rc_unlock) }
            Chip("Lock", false, Palette.accent2, Modifier.weight(1f)) { CartSound.play(ctx, R.raw.cart_rc_lock) }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            Chip("Arm", false, Palette.accent2, Modifier.weight(1f)) { CartSound.play(ctx, R.raw.cart_rc_arm) }
            Chip("Purchase check", false, Palette.accent2, Modifier.weight(1f)) { CartSound.play(ctx, R.raw.cart_rc_purchase) }
        }
        Note("Point the speaker at a cart wheel. Credit: begaydocrime.com.")
    }
}

@Composable
private fun CardHead(title: String, sub: String, accent: Color) {
    val d = rememberDims()
    Text(title, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), letterSpacing = 1.sp)
    Text(sub, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.dp(2f), bottom = d.dp(6f)))
}

@Composable
private fun SubLabel(text: String) {
    val d = rememberDims()
    Text(text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), modifier = Modifier.padding(top = d.dp(10f), bottom = d.dp(4f)))
}

private fun trollStep(hz: Long): String = if (hz >= 1_000_000L) "${hz / 1_000_000}" else if (hz >= 1_000L) ".${"%03d".format(hz / 1000)}" else "$hz"

/** One cart sound at a time; a new tap interrupts the last. The player releases itself on completion. */
private object CartSound {
    private var mp: MediaPlayer? = null
    fun play(ctx: Context, resId: Int) {
        try {
            mp?.let { old -> try { old.stop() } catch (_: Exception) {}; old.release() }
            mp = null
            val p = MediaPlayer.create(ctx, resId) ?: return
            p.setOnCompletionListener { done -> done.release(); if (mp === done) mp = null }
            p.start()
            mp = p
        } catch (_: Exception) {
        }
    }
}
