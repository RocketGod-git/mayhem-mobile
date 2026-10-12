package com.rocketgod.mayhem.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The selected aircraft, vessel or station: a name bar with MAP and close, who or what it is one fact to a line, an
 * optional photo, and a grid of live readings.
 */
@Composable
fun DetailCard(
    title: String, sub: String, lines: List<String>, grid: List<Pair<String, String>>,
    onMap: (() -> Unit)?, onClose: () -> Unit, photo: ImageBitmap? = null,
) {
    val d = rememberDims()
    val gold = Palette.accent2
    Column(Modifier.fillMaxWidth().padding(bottom = d.dp(6f)).panel(gold).padding(d.dp(8f))) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(title, color = gold, fontFamily = Mono, fontWeight = FontWeight.Black, fontSize = d.sp(15f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("  $sub", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Row(horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
                if (onMap != null) Chip("MAP", selected = false, accent = gold) { onMap() }
                Chip("✕", selected = false, accent = gold) { onClose() }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = d.dp(4f))) {
            Column(Modifier.weight(1f)) {
                lines.forEachIndexed { i, l ->
                    Text(l, color = if (i == 0) Palette.ink else Palette.ink.copy(alpha = 0.8f), fontFamily = Mono,
                        fontWeight = if (i == 0) FontWeight.Bold else FontWeight.Normal, fontSize = d.sp(11f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            if (photo != null) Image(photo, null, contentScale = ContentScale.Crop,
                modifier = Modifier.padding(start = d.dp(6f)).size(d.dp(96f), d.dp(64f)).clip(RoundedCornerShape(4.dp)))
        }
        val cols = if (d.wide) 3 else 2
        for (row in grid.chunked(cols)) {
            Row(Modifier.fillMaxWidth().padding(top = d.dp(4f))) {
                for ((k, v) in row) Column(Modifier.weight(1f)) {
                    Text(k, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(8.5f), letterSpacing = 1.sp, maxLines = 1)
                    Text(v, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                repeat(cols - row.size) { Column(Modifier.weight(1f)) {} }
            }
        }
    }
}

/** `now`, `12 s ago`, `3 min ago`. */
fun ageText(ms: Long): String = when {
    ms < 1000 -> "now"
    ms < 60_000 -> "${(ms / 1000.0).toInt()} s ago"
    else -> "${(ms / 60_000.0).toInt()} min ago"
}

/** Distance and bearing from the phone, or why there is none. */
fun fromYou(home: Pair<Double, Double>?, lat: Double?, lon: Double?, miles: Boolean = false): String {
    if (home == null) return "allow location to see"
    if (lat == null || lon == null) return "—"
    val (km, deg) = com.rocketgod.mayhem.core.ham.distanceBearing(home.first, home.second, lat, lon)
    val other = if (miles) "%.0f mi".format(km * 0.621371) else "%.0f nmi".format(km * 0.539957)
    return "%s km · %s · %d°".format(if (km < 10) "%.1f".format(km) else "%.0f".format(km), other, deg.toInt())
}

/** The time of day, for "first heard". */
fun clockOf(ms: Long): String = java.text.DateFormat.getTimeInstance(java.text.DateFormat.MEDIUM).format(java.util.Date(ms))
