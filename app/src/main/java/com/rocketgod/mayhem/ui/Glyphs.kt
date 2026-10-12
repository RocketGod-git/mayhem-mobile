package com.rocketgod.mayhem.ui

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import com.rocketgod.mayhem.core.MayhemApp
import kotlin.math.cos
import kotlin.math.sin

/** Line-art glyph for each app, in normalised 0..1 coordinates. */
@Composable
fun AppGlyph(app: MayhemApp, tint: Color, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val w = size.width; val h = size.height
        val s = if (w < h) w else h
        val ox = (w - s) / 2f; val oy = (h - s) / 2f
        fun p(x: Float, y: Float) = Offset(ox + x * s, oy + y * s)
        fun Path.m(x: Float, y: Float) { val o = p(x, y); moveTo(o.x, o.y) }
        fun Path.l(x: Float, y: Float) { val o = p(x, y); lineTo(o.x, o.y) }
        val path = Path()
        val circles = ArrayList<Triple<Float, Float, Float>>()
        var dot: Triple<Float, Float, Float>? = null
        when (app) {
            MayhemApp.HAM -> {
                path.m(0.5f, 0.92f); path.l(0.5f, 0.14f)
                path.m(0.24f, 0.22f); path.l(0.76f, 0.22f)
                path.m(0.3f, 0.36f); path.l(0.7f, 0.36f)
                path.m(0.36f, 0.5f); path.l(0.64f, 0.5f)
                path.m(0.34f, 0.92f); path.l(0.66f, 0.92f)
            }
            MayhemApp.SAT -> {
                // a body with two solar panels, and the arc of its downlink
                path.m(0.40f, 0.40f); path.l(0.60f, 0.40f); path.l(0.60f, 0.60f); path.l(0.40f, 0.60f); path.close()
                path.m(0.10f, 0.44f); path.l(0.32f, 0.44f); path.l(0.32f, 0.56f); path.l(0.10f, 0.56f); path.close()
                path.m(0.68f, 0.44f); path.l(0.90f, 0.44f); path.l(0.90f, 0.56f); path.l(0.68f, 0.56f); path.close()
                path.m(0.32f, 0.50f); path.l(0.40f, 0.50f); path.m(0.60f, 0.50f); path.l(0.68f, 0.50f)
                path.m(0.50f, 0.60f); path.l(0.50f, 0.70f)
                var a = 200.0; var first = true
                while (a <= 340.0) { val x = 0.5f + 0.2f * cos(Math.toRadians(a)).toFloat(); val y = 0.9f + 0.2f * sin(Math.toRadians(a)).toFloat(); if (first) { path.m(x, y); first = false } else path.l(x, y); a += 10.0 }
            }
            MayhemApp.AUDIO -> {
                path.m(0.05f, 0.5f)
                for (i in 0..40) {
                    val env = sin(Math.PI * i / 40.0).toFloat()
                    path.l(0.05f + 0.9f * i / 40f, 0.5f + 0.38f * env * sin(i * 0.9).toFloat())
                }
            }
            MayhemApp.ADSB -> {
                path.m(0.5f, 0.06f); path.l(0.5f, 0.92f)
                path.m(0.06f, 0.52f); path.l(0.5f, 0.38f); path.l(0.94f, 0.52f)
                path.m(0.3f, 0.9f); path.l(0.5f, 0.78f); path.l(0.7f, 0.9f)
            }
            MayhemApp.AIS -> {
                path.m(0.08f, 0.6f); path.l(0.92f, 0.6f); path.l(0.78f, 0.84f); path.l(0.22f, 0.84f); path.close()
                path.m(0.5f, 0.6f); path.l(0.5f, 0.14f)
                path.m(0.5f, 0.2f); path.l(0.72f, 0.42f); path.l(0.5f, 0.42f)
                path.m(0.08f, 0.94f)
                for (i in 0..12) path.l(0.08f + 0.84f * i / 12f, 0.94f + 0.03f * sin(i * 1.6).toFloat())
            }
            MayhemApp.APRS -> {
                path.m(0.5f, 0.12f); path.l(0.28f, 0.92f)
                path.m(0.5f, 0.12f); path.l(0.72f, 0.92f)
                path.m(0.38f, 0.55f); path.l(0.62f, 0.55f)
                path.m(0.33f, 0.74f); path.l(0.67f, 0.74f)
                for (r in floatArrayOf(0.14f, 0.24f)) {
                    var a = -150.0; var first = true
                    while (a <= -30.0) {
                        val x = 0.5f + r * cos(Math.toRadians(a)).toFloat(); val y = 0.14f + r * sin(Math.toRadians(a)).toFloat()
                        if (first) { path.m(x, y); first = false } else path.l(x, y)
                        a += 10.0
                    }
                }
            }
            MayhemApp.PAGER -> {
                val a = p(0.12f, 0.28f); val b = p(0.88f, 0.76f)
                path.addRoundRect(RoundRect(a.x, a.y, b.x, b.y, s * 0.06f, s * 0.06f))
                path.m(0.22f, 0.42f); path.l(0.78f, 0.42f)
                path.m(0.22f, 0.54f); path.l(0.6f, 0.54f)
                path.m(0.7f, 0.66f); path.l(0.78f, 0.66f)
            }
            MayhemApp.TPMS -> {
                circles.add(Triple(0.5f, 0.5f, 0.4f)); circles.add(Triple(0.5f, 0.5f, 0.2f))
                for (k in 0 until 4) { val a = Math.toRadians(45.0 + k * 90.0); val c = cos(a).toFloat(); val sn = sin(a).toFloat(); path.m(0.5f + 0.2f * c, 0.5f + 0.2f * sn); path.l(0.5f + 0.4f * c, 0.5f + 0.4f * sn) }
            }
            MayhemApp.ACARS -> {
                val a = p(0.1f, 0.3f); val b = p(0.9f, 0.78f)
                path.addRoundRect(RoundRect(a.x, a.y, b.x, b.y, s * 0.06f, s * 0.06f))
                path.m(0.1f, 0.32f); path.l(0.5f, 0.56f); path.l(0.9f, 0.32f)
                path.m(0.5f, 0.06f); path.l(0.5f, 0.2f); path.m(0.38f, 0.14f); path.l(0.62f, 0.14f)
            }
            MayhemApp.SUBGHZ -> {
                path.m(0.5f, 0.92f); path.l(0.5f, 0.42f)
                circles.add(Triple(0.5f, 0.42f, 0.07f))
                for (r in floatArrayOf(0.2f, 0.32f)) {
                    var a = -150.0; var first = true
                    while (a <= -30.0) { val x = 0.5f + r * cos(Math.toRadians(a)).toFloat(); val y = 0.42f + r * sin(Math.toRadians(a)).toFloat(); if (first) { path.m(x, y); first = false } else path.l(x, y); a += 10.0 }
                }
                path.m(0.2f, 0.92f); path.l(0.8f, 0.92f)
            }
            MayhemApp.ERT -> {
                var a = 150.0; var first = true
                while (a <= 390.0) {
                    val x = 0.5f + 0.38f * cos(Math.toRadians(a)).toFloat(); val y = 0.55f + 0.38f * sin(Math.toRadians(a)).toFloat()
                    if (first) { path.m(x, y); first = false } else path.l(x, y)
                    a += 10.0
                }
                path.m(0.5f, 0.55f); path.l(0.74f, 0.3f)
                dot = Triple(0.5f, 0.55f, 0.05f)
            }
            MayhemApp.BTLE -> {
                path.m(0.32f, 0.3f); path.l(0.68f, 0.68f); path.l(0.5f, 0.88f); path.l(0.5f, 0.12f); path.l(0.68f, 0.32f); path.l(0.32f, 0.7f)
            }
            MayhemApp.LOOKING_GLASS -> {
                circles.add(Triple(0.42f, 0.42f, 0.26f))
                path.m(0.61f, 0.61f); path.l(0.9f, 0.9f)
                path.m(0.28f, 0.42f)
                for (i in 0..10) path.l(0.28f + 0.28f * i / 10f, 0.42f - 0.12f * sin(i * 1.1).toFloat())
            }
            MayhemApp.SEARCH -> {
                circles.add(Triple(0.5f, 0.5f, 0.3f))
                path.m(0.5f, 0.08f); path.l(0.5f, 0.3f)
                path.m(0.5f, 0.7f); path.l(0.5f, 0.92f)
                path.m(0.08f, 0.5f); path.l(0.3f, 0.5f)
                path.m(0.7f, 0.5f); path.l(0.92f, 0.5f)
                dot = Triple(0.5f, 0.5f, 0.05f)
            }
            MayhemApp.CAPTURE -> {
                circles.add(Triple(0.5f, 0.5f, 0.36f))
                dot = Triple(0.5f, 0.5f, 0.2f)
            }
            MayhemApp.TRANSMIT -> {
                path.m(0.5f, 0.92f); path.l(0.5f, 0.5f)
                circles.add(Triple(0.5f, 0.5f, 0.08f))
                for (r in floatArrayOf(0.22f, 0.34f)) {
                    for (side in intArrayOf(-1, 1)) {
                        var a = 90.0 + side * 35.0; var first = true; val end = 90.0 + side * 78.0
                        while (if (side > 0) a <= end else a >= end) { val x = 0.5f + r * cos(Math.toRadians(a)).toFloat(); val y = 0.5f - r * sin(Math.toRadians(a)).toFloat(); if (first) { path.m(x, y); first = false } else path.l(x, y); a += side * 8.0 }
                    }
                }
                path.m(0.3f, 0.92f); path.l(0.7f, 0.92f)
            }
            MayhemApp.SETTINGS -> {
                circles.add(Triple(0.5f, 0.5f, 0.16f))
                for (k in 0 until 8) {
                    val a = Math.toRadians(k * 45.0)
                    val c = cos(a).toFloat(); val sn = sin(a).toFloat()
                    path.m(0.5f + 0.28f * c, 0.5f + 0.28f * sn); path.l(0.5f + 0.4f * c, 0.5f + 0.4f * sn)
                }
                circles.add(Triple(0.5f, 0.5f, 0.28f))
            }
        }
        val width = s * 0.07f
        drawPath(path, tint, style = Stroke(width, cap = StrokeCap.Round, join = StrokeJoin.Round))
        for ((cx, cy, r) in circles) drawCircle(tint, r * s, p(cx, cy), style = Stroke(width))
        val dd = dot
        if (dd != null) drawCircle(tint, dd.third * s + width * 0.3f, p(dd.first, dd.second))
    }
}
