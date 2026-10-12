package com.rocketgod.mayhem.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.rocketgod.mayhem.core.SdrEngine

/** A band worth a look, and the mode to hear it in; ISM and ADS-B have no voice mode, so NFM is the default to browse them. */
class ListenBand(val name: String, val lo: Long, val hi: Long, val mode: SdrEngine.Mode, val what: String) {
    val centre: Long get() = (lo + hi) / 2
}

/** The same eight the web app offers on its front door and in its receiver. */
val LISTEN_BANDS = listOf(
    ListenBand("FM", 88_000_000L, 108_000_000L, SdrEngine.Mode.WFM, "broadcast radio"),
    ListenBand("AIR", 118_000_000L, 137_000_000L, SdrEngine.Mode.AM, "airband AM"),
    ListenBand("VHF", 144_000_000L, 163_000_000L, SdrEngine.Mode.NFM, "two metres, marine, weather"),
    ListenBand("315", 314_000_000L, 316_000_000L, SdrEngine.Mode.NFM, "American remotes and sensors"),
    ListenBand("UHF", 430_000_000L, 450_000_000L, SdrEngine.Mode.NFM, "seventy centimetres"),
    ListenBand("433", 433_000_000L, 435_000_000L, SdrEngine.Mode.NFM, "European remotes and sensors"),
    ListenBand("915", 902_000_000L, 928_000_000L, SdrEngine.Mode.NFM, "meters and telemetry"),
    ListenBand("1090", 1_089_000_000L, 1_091_000_000L, SdrEngine.Mode.NFM, "aircraft"),
)

fun bandAt(hz: Long): ListenBand? = LISTEN_BANDS.firstOrNull { hz in it.lo..it.hi }

/** Eight chips, four to a row on a phone and one row of eight on a wide screen; the band holding [hz] is lit. */
@Composable
fun BandChips(accent: androidx.compose.ui.graphics.Color, hz: Long, onPick: (ListenBand) -> Unit) {
    val d = rememberDims()
    val lit = bandAt(hz)
    for (row in LISTEN_BANDS.chunked(if (d.widthDp >= 600) 8 else 4)) {
        Row(Modifier.fillMaxWidth().padding(bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            for (b in row) Chip(b.name, selected = b === lit, accent = accent, modifier = Modifier.weight(1f)) { onPick(b) }
        }
    }
}
