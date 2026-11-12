package com.rocketgod.mayhem.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rocketgod.mayhem.core.ham.Ham
import com.rocketgod.mayhem.core.ham.bandOf
import com.rocketgod.mayhem.core.ham.repeaterInput
import kotlin.math.abs

/** An offset as the band plan says it: `600 kHz`, `5 MHz`. */
private fun offsetText(hz: Long): String = if (abs(hz) >= 1_000_000) "${fmtNum(abs(hz) / 1e6)} MHz" else "${fmtNum(abs(hz) / 1e3)} kHz"
private fun fmtNum(v: Double): String = if (v == Math.floor(v)) v.toLong().toString() else v.toString()

/**
 * The band plan for the band the receiver is in (web hamBandPlanHtml): the band's name, range, mode and repeater
 * offset; a strip of its segments with the dial marked; in a repeater output segment, the pair the dial belongs to;
 * then each segment as a row, the current one outlined. A tap on a row tunes to its start.
 */
@Composable
internal fun HamBandPlan(accent: Color) {
    val d = rememberDims()
    val s by Ham.state.collectAsState()
    val m by Ham.demod.meter.collectAsState()
    val hz = s.channel
    val b = bandOf(hz)
    SectionLabel("BAND PLAN · tap a segment to go there")
    val shape = RoundedCornerShape(d.dp(12f))
    Column(Modifier.fillMaxWidth().clip(shape).background(Palette.surface).border(1.dp, Palette.line, shape).padding(d.dp(10f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
        if (b == null) {
            Text("%.4f MHz is outside the amateur bands: pick a band above".format(hz / 1e6), color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f))
            return@Column
        }
        val colors = listOf(accent, Palette.accent2, Palette.ok, lerp(accent, Palette.danger, 0.5f))
        fun mhz(v: Long) = "%.3f".format(v / 1e6)
        fun inSeg(seg: Triple<Long, Long, String>) = hz in seg.first..seg.second
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Text(b.name, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), letterSpacing = 1.sp)
            Text("${mhz(b.lo)}–${mhz(b.hi)} MHz · ${b.mode.name}" + (b.offset?.takeIf { it != 0L }?.let { " · repeaters ${if (it > 0) "+" else "−"}${offsetText(it)}" } ?: ""),
                color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        val span = (b.hi - b.lo).toFloat().coerceAtLeast(1f)
        fun at(v: Long) = ((v - b.lo) / span).coerceIn(0f, 1f)
        val paper = Palette.paper; val ink = Palette.ink
        Canvas(Modifier.fillMaxWidth().height(d.dp(18f))) {
            drawRoundRect(paper.copy(alpha = 0.7f), cornerRadius = CornerRadius(6.dp.toPx()))
            val inset = 3.dp.toPx()
            b.segments.forEachIndexed { i, seg ->
                val x = at(seg.first) * size.width
                val w = maxOf(0.008f, at(seg.second) - at(seg.first)) * size.width
                drawRoundRect(colors[i % 4].copy(alpha = if (inSeg(seg)) 1f else 0.55f), Offset(x, inset), Size(w, size.height - 2 * inset), CornerRadius(3.dp.toPx()))
            }
            val mx = at(hz) * size.width
            drawRect(ink.copy(alpha = 0.35f), Offset(mx - 3.dp.toPx(), 0f), Size(6.dp.toPx(), size.height))
            drawRect(ink, Offset(mx - 1.dp.toPx(), 0f), Size(2.dp.toPx(), size.height))
        }
        val rin = repeaterInput(hz)
        if (rin != null) {
            Text("REPEATER PAIR · out %.4f · in %.4f · %s%s".format(hz / 1e6, rin / 1e6, if (rin > hz) "+" else "−", offsetText(rin - hz)) +
                (if (m.tone > 0) " · tone %.1f".format(m.tone) else ""),
                color = Palette.accent2, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 1.sp)
        }
        Column(verticalArrangement = Arrangement.spacedBy(d.dp(2f))) {
            b.segments.forEachIndexed { i, seg ->
                val on = inSeg(seg)
                val rs = RoundedCornerShape(d.dp(8f))
                Row(Modifier.fillMaxWidth().clip(rs).background(if (on) accent.copy(alpha = 0.12f) else Color.Transparent)
                    .border(1.dp, if (on) accent else Color.Transparent, rs)
                    .clickable { if (s.rev) Ham.toggleReverse(); Ham.tune(seg.first) }.padding(horizontal = d.dp(6f), vertical = d.dp(5f)),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
                    Box(Modifier.size(d.dp(10f)).background(colors[i % 4], RoundedCornerShape(3.dp)))
                    Text(if (seg.first == seg.second) mhz(seg.first) else "${mhz(seg.first)}–${mhz(seg.second)}", color = Palette.muted, fontFamily = Mono,
                        fontSize = d.sp(10f), maxLines = 1, modifier = Modifier.width(d.dp(130f)))
                    Text(seg.third, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.SemiBold, fontSize = d.sp(11f), modifier = Modifier.weight(1f))
                }
            }
        }
    }
}
