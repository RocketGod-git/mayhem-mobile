package com.rocketgod.mayhem.ui

import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.rocketgod.mayhem.Diag
import kotlin.math.roundToInt

/**
 * The diagnostic log as a terminal: full screen by default, or shrunk to a floating panel that can be
 * dragged anywhere on top of whatever app is running, so a decode can be watched while the log scrolls.
 *
 * SAVE writes to Downloads, SHARE hands the same text to the share sheet through the FileProvider — both
 * start with [Diag.header], which is what makes a log someone sends us actually diagnosable.
 */
@Composable
fun LogWindow(onClose: () -> Unit) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val lines by Diag.lines.collectAsState()
    var floating by remember { mutableStateOf(false) }
    var offX by remember { mutableStateOf(0f) }
    var offY by remember { mutableStateOf(0f) }
    val listState = rememberLazyListState()
    var follow by remember { mutableStateOf(true) }

    // Follow the tail unless the reader has scrolled up to look at something.
    LaunchedEffect(lines.size, follow) {
        if (follow && lines.isNotEmpty()) listState.scrollToItem(lines.size - 1)
    }

    val body: @Composable () -> Unit = {
        Column(Modifier.fillMaxSize().background(Palette.paper).padding(d.dp(8f))) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                Text("LOG", color = Palette.accent, fontFamily = Mono, fontWeight = FontWeight.Bold,
                    fontSize = d.sp(12f), letterSpacing = 2.sp, modifier = Modifier.padding(end = d.dp(4f)))
                Chip(if (floating) "FULL" else "PIP", selected = false, accent = Palette.accent,
                    modifier = Modifier.weight(1f)) { floating = !floating }
                Chip("SAVE", selected = false, accent = Palette.accent, modifier = Modifier.weight(1f)) {
                    val where = Diag.saveToDownloads(ctx)
                    Toast.makeText(ctx, where?.let { "Saved to $it" } ?: "Could not save the log",
                        Toast.LENGTH_LONG).show()
                }
                Chip("SHARE", selected = false, accent = Palette.accent, modifier = Modifier.weight(1f)) {
                    runCatching {
                        val f = Diag.writeShareFile(ctx)
                        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".logs", f)
                        val send = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_STREAM, uri)
                            putExtra(Intent.EXTRA_SUBJECT, "Mayhem Mobile log")
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        ctx.startActivity(Intent.createChooser(send, "Share log").apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        })
                    }.onFailure { Toast.makeText(ctx, "Could not share the log", Toast.LENGTH_LONG).show() }
                }
                Chip("CLEAR", selected = false, accent = Palette.danger, modifier = Modifier.weight(1f)) { Diag.clear() }
                Chip("✕", selected = false, accent = Palette.accent) { onClose() }
            }

            for (h in Diag.header()) {
                Text(h, color = Palette.accent2, fontFamily = Mono, fontSize = d.sp(8.5f),
                    modifier = Modifier.padding(top = d.dp(2f)))
            }

            LazyColumn(state = listState, modifier = Modifier.fillMaxSize().padding(top = d.dp(6f))) {
                items(lines) { l ->
                    Text(l, color = Palette.ink.copy(alpha = 0.88f), fontFamily = Mono, fontSize = d.sp(9f))
                }
            }
        }
    }

    if (floating) {
        // A panel the size of a PIP window, dragged by its whole surface. Kept inside the composition rather
        // than a system overlay: that would need SYSTEM_ALERT_WINDOW, which is a permission prompt and a
        // Play declaration for something only a developer uses.
        Box(
            Modifier
                .offset { IntOffset(offX.roundToInt(), offY.roundToInt()) }
                .padding(d.dp(8f))
                .width(d.dp(240f))
                .height(d.dp(200f))
                .panel(Palette.accent)
                .pointerInput(Unit) {
                    detectDragGestures { _, drag -> offX += drag.x; offY += drag.y }
                }
        ) { body() }
    } else {
        Box(Modifier.fillMaxSize()) { body() }
    }

    // Touching the list stops the auto-follow; the FULL/PIP toggle resumes it.
    LaunchedEffect(listState.isScrollInProgress) {
        if (listState.isScrollInProgress) follow = false
    }
}
