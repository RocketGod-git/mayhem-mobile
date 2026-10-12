package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.rocketgod.mayhem.model.Aircraft
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.CustomZoomButtonsController
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Overlay
import kotlin.math.max

/** OpenStreetMap tiles pushed to a dark, low-saturation look so the accent-coloured aircraft carry the scene. */
private val DARK_TILE_FILTER = android.graphics.ColorMatrixColorFilter(android.graphics.ColorMatrix().apply {
    val invert = android.graphics.ColorMatrix(floatArrayOf(
        -1f, 0f, 0f, 0f, 255f,
        0f, -1f, 0f, 0f, 255f,
        0f, 0f, -1f, 0f, 255f,
        0f, 0f, 0f, 1f, 0f))
    val desat = android.graphics.ColorMatrix().apply { setSaturation(0.25f) }
    val dim = android.graphics.ColorMatrix(floatArrayOf(
        0.82f, 0f, 0f, 0f, 0f,
        0f, 0.85f, 0f, 0f, 0f,
        0f, 0f, 0.92f, 0f, 0f,
        0f, 0f, 0f, 1f, 0f))
    postConcat(invert); postConcat(desat); postConcat(dim)
})

/** Each aircraft as a top-down jet silhouette rotated to its ground track, in the accent, callsign beneath; tap → nearest. */
private class PlanesOverlay(private val accentInt: Int, @Volatile var planes: List<Aircraft>, @Volatile var selected: String?, private val onTap: (String) -> Unit) : Overlay() {
    private val fill = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = accentInt; style = android.graphics.Paint.Style.FILL }
    private val rim = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF0B1416.toInt(); style = android.graphics.Paint.Style.STROKE; strokeWidth = 2f; strokeJoin = android.graphics.Paint.Join.ROUND }
    private val ring = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); style = android.graphics.Paint.Style.STROKE; strokeWidth = 2f }
    private val glow = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { style = android.graphics.Paint.Style.FILL }
    private val label = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); textAlign = android.graphics.Paint.Align.CENTER; isFakeBoldText = true; typeface = android.graphics.Typeface.MONOSPACE }
    private val labelHalo = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xE6050B0D.toInt(); textAlign = android.graphics.Paint.Align.CENTER; isFakeBoldText = true; style = android.graphics.Paint.Style.STROKE; strokeWidth = 3f; typeface = android.graphics.Typeface.MONOSPACE }
    private val pt = android.graphics.Point()

    private fun planePath(x: Float, y: Float, r: Float): android.graphics.Path = android.graphics.Path().apply {
        moveTo(x, y - r * 1.25f)
        lineTo(x + r * 0.15f, y - r * 0.45f); lineTo(x + r * 1.15f, y + r * 0.18f); lineTo(x + r * 1.15f, y + r * 0.40f)
        lineTo(x + r * 0.15f, y + r * 0.10f); lineTo(x + r * 0.13f, y + r * 0.80f); lineTo(x + r * 0.55f, y + r * 1.12f)
        lineTo(x + r * 0.55f, y + r * 1.28f); lineTo(x, y + r * 1.00f); lineTo(x - r * 0.55f, y + r * 1.28f)
        lineTo(x - r * 0.55f, y + r * 1.12f); lineTo(x - r * 0.13f, y + r * 0.80f); lineTo(x - r * 0.15f, y + r * 0.10f)
        lineTo(x - r * 1.15f, y + r * 0.40f); lineTo(x - r * 1.15f, y + r * 0.18f); lineTo(x - r * 0.15f, y - r * 0.45f)
        close()
    }

    override fun draw(canvas: android.graphics.Canvas, mapView: MapView, shadow: Boolean) {
        if (shadow) return
        val proj = mapView.projection
        val d = mapView.resources.displayMetrics.density
        val r = 10f * d
        label.textSize = 10f * d; labelHalo.textSize = 10f * d
        val rgb = accentInt and 0x00FFFFFF
        val w = mapView.width; val h = mapView.height; val margin = max(w, h)
        for (a in planes) {
            val la = a.lat ?: continue; val lo = a.lon ?: continue
            proj.toPixels(GeoPoint(la, lo), pt)
            if (pt.x < -margin || pt.y < -margin || pt.x > w + margin || pt.y > h + margin) continue
            val x = pt.x.toFloat(); val y = pt.y.toFloat()
            glow.shader = android.graphics.RadialGradient(x, y, r * 2.1f, (0x70 shl 24) or rgb, rgb, android.graphics.Shader.TileMode.CLAMP)
            canvas.drawCircle(x, y, r * 2.1f, glow)
            if (a.icao == selected) canvas.drawCircle(x, y, r * 1.9f, ring)
            canvas.save()
            canvas.rotate((a.track ?: 0).toFloat(), x, y)
            val path = planePath(x, y, r)
            canvas.drawPath(path, fill); canvas.drawPath(path, rim)
            canvas.restore()
            val tag = a.flight?.trim().takeIf { !it.isNullOrBlank() } ?: a.icao.uppercase()
            val ly = y + r * 1.55f + label.textSize
            canvas.drawText(tag, x, ly, labelHalo); canvas.drawText(tag, x, ly, label)
        }
    }

    override fun onSingleTapConfirmed(e: android.view.MotionEvent, mapView: MapView): Boolean {
        val proj = mapView.projection
        var best: String? = null; var bestD = Float.MAX_VALUE
        for (a in planes) {
            val la = a.lat ?: continue; val lo = a.lon ?: continue
            proj.toPixels(GeoPoint(la, lo), pt)
            val dx = e.x - pt.x; val dy = e.y - pt.y; val dd = dx * dx + dy * dy
            if (dd < bestD) { bestD = dd; best = a.icao }
        }
        val tapR = 26f * mapView.resources.displayMetrics.density
        return if (best != null && bestD < tapR * tapR) { onTap(best); true } else false
    }
}

/**
 * Live aircraft map (Wardrive Go's ADS-B map, on key-free OSM tiles). Follows the aircraft until you drag, the
 * crosshair button re-arms it. [home] is the phone's fix, used to centre an empty map.
 */
@Composable
fun AdsbMap(planes: List<Aircraft>, accent: Color, home: Pair<Double, Double>?, selected: String?, modifier: Modifier = Modifier, onTapPlane: (String) -> Unit) {
    val accentInt = accent.toArgb()
    var mapRef by remember { mutableStateOf<MapView?>(null) }
    var overlayRef by remember { mutableStateOf<PlanesOverlay?>(null) }
    var seeded by remember { mutableStateOf(false) }
    var follow by remember { mutableStateOf(true) }

    fun fitTo(mv: MapView) {
        val withPos = planes.filter { it.lat != null && it.lon != null }
        if (withPos.isEmpty() || mv.width == 0 || mv.height == 0) return
        val lats = withPos.map { it.lat!! }; val lons = withPos.map { it.lon!! }
        if (withPos.size == 1) { mv.controller.animateTo(GeoPoint(lats[0], lons[0])); return }
        val pad = 0.05
        runCatching { mv.zoomToBoundingBox(BoundingBox(lats.max() + pad, lons.max() + pad, lats.min() - pad, lons.min() - pad), true, 80) }
    }

    LaunchedEffect(planes, follow, selected) {
        val mv = mapRef ?: return@LaunchedEffect
        overlayRef?.let { it.planes = planes; it.selected = selected; mv.invalidate() }
        if (follow) fitTo(mv)
    }
    LaunchedEffect(mapRef, home, planes.isEmpty()) {
        val mv = mapRef ?: return@LaunchedEffect
        if (planes.isEmpty() && !seeded && home != null) { mv.controller.setZoom(9.0); mv.controller.setCenter(GeoPoint(home.first, home.second)); seeded = true }
    }

    Box(modifier.clipToBounds()) {
        AndroidView(
            modifier = Modifier.fillMaxSize().clipToBounds(),
            factory = { c ->
                Configuration.getInstance().userAgentValue = c.packageName
                MapView(c).apply {
                    mapRef = this
                    setTileSource(TileSourceFactory.MAPNIK)
                    overlayManager.tilesOverlay.setColorFilter(DARK_TILE_FILTER)
                    overlayManager.tilesOverlay.loadingBackgroundColor = 0xFF0A0D13.toInt()
                    overlayManager.tilesOverlay.loadingLineColor = 0xFF1A2130.toInt()
                    setMultiTouchControls(true)
                    setTilesScaledToDpi(true)
                    zoomController.setVisibility(CustomZoomButtonsController.Visibility.SHOW_AND_FADEOUT)
                    controller.setZoom(9.0)
                    controller.setCenter(if (home != null) GeoPoint(home.first, home.second).also { seeded = true } else GeoPoint(39.5, -98.35))
                    @Suppress("ClickableViewAccessibility")
                    setOnTouchListener { v, ev ->
                        when (ev.actionMasked) {
                            android.view.MotionEvent.ACTION_DOWN -> v.parent?.requestDisallowInterceptTouchEvent(true)
                            android.view.MotionEvent.ACTION_MOVE -> if (follow) follow = false
                            android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> v.parent?.requestDisallowInterceptTouchEvent(false)
                        }
                        false
                    }
                    val ov = PlanesOverlay(accentInt, planes, selected, onTapPlane)
                    overlays.add(ov); overlayRef = ov
                    onResume()
                }
            }
        )
        Box(
            Modifier.align(Alignment.BottomEnd).padding(6.dp).size(30.dp)
                .background(if (follow) accent else Palette.surface.copy(alpha = 0.9f), RoundedCornerShape(8.dp))
                .clickable { follow = !follow; if (follow) mapRef?.let { fitTo(it) } },
            contentAlignment = Alignment.Center
        ) { Text("⌖", color = if (follow) inkOn(accent) else Palette.ink, fontFamily = Mono) }
        Text("© OpenStreetMap contributors", color = Palette.muted, fontFamily = Mono, fontSize = 8.sp,
            modifier = Modifier.align(Alignment.BottomStart).padding(4.dp).background(Palette.paper.copy(alpha = 0.6f), RoundedCornerShape(3.dp)).padding(horizontal = 4.dp, vertical = 1.dp))
    }
}
