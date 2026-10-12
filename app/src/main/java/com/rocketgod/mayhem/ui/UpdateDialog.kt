package com.rocketgod.mayhem.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.AppUpdates

/**
 * Shown once per launch when something newer exists. Skip silences that exact build only.
 *
 * A Play install cannot be updated by the app itself, so UPDATE opens Play's own update flow; a sideload
 * opens the release page. The dialog is the same either way — only the button's destination differs.
 */
@Composable
fun UpdateDialog() {
    val ctx = LocalContext.current
    val info by AppUpdates.available.collectAsState()
    val a = info ?: return

    AlertDialog(
        onDismissRequest = { AppUpdates.dismiss() },
        containerColor = Palette.panel,
        titleContentColor = Palette.accent,
        textContentColor = Palette.ink,
        title = {
            Text("UPDATE AVAILABLE", fontFamily = Mono, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
        },
        text = {
            Column(Modifier.fillMaxWidth()) {
                Line("installed", a.current)
                Line("available", a.offered)
                Text(
                    if (a.fromPlay) "Google Play will handle the update."
                    else "Opens the release page to download the APK.",
                    color = Palette.muted, fontFamily = Mono, fontSize = 11.sp,
                    modifier = Modifier.padding(top = 10.dp),
                )
            }
        },
        confirmButton = {
            Chip("UPDATE", selected = true, accent = Palette.accent) {
                ctx.activity()?.let { AppUpdates.start(it) }
            }
        },
        dismissButton = {
            Chip("SKIP", selected = false, accent = Palette.muted) { AppUpdates.skip(ctx) }
        },
    )
}

@Composable
private fun Line(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp)) {
        Text(label.uppercase(), color = Palette.muted, fontFamily = Mono, fontSize = 11.sp, letterSpacing = 1.sp)
        Text("  $value", color = Palette.ink, fontFamily = Mono, fontSize = 13.sp, fontWeight = FontWeight.Bold)
    }
}

/** Compose hands out a ContextWrapper, not the Activity the Play update flow needs. */
private fun Context.activity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}
