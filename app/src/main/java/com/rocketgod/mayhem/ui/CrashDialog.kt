package com.rocketgod.mayhem.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Shown on the launch after a crash: send the report to the developer, save it, or let it go. */
@Composable
fun CrashDialog(headline: String, onSend: () -> Unit, onSave: () -> Unit, onDismiss: () -> Unit) {
    val accent = Palette.accent
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.surface,
        titleContentColor = accent,
        textContentColor = Palette.ink,
        title = { Text("Mayhem closed unexpectedly", fontFamily = Mono, fontWeight = FontWeight.Bold) },
        text = {
            Column {
                Text("A report is ready: what crashed, and the app's log from just before it.", fontFamily = Mono,
                    modifier = Modifier.padding(bottom = 8.dp))
                Text(headline, fontFamily = Mono, color = Palette.muted, fontSize = 12.sp)
            }
        },
        confirmButton = { TextButton(onClick = onSend) { Text("SEND TO DEV", color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold) } },
        dismissButton = {
            Row {
                TextButton(onClick = onSave) { Text("SAVE", color = Palette.ink, fontFamily = Mono) }
                TextButton(onClick = onDismiss) { Text("DISMISS", color = Palette.muted, fontFamily = Mono) }
            }
        },
    )
}
