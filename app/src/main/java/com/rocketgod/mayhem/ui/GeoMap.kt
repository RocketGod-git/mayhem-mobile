package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
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
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.BoundingBox
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.CustomZoomButtonsController
import org.osmdroid.views.MapView
import org.osmdroid.views.overlay.Overlay
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/** Something to put on a map: a logged contact, a looked-up callsign, a satellite, a sensor. */
data class GeoItem(val id: String, val lat: Double, val lon: Double, val label: String, val kind: Kind) {
    enum class Kind { QSO, OBJECT, SAT, DEVICE }
}

/** The map's extra layers: lines home to each contact, a satellite's ground track and radio footprint. */
data class GeoLayers(
    val lines: List<Pair<Pair<Double, Double>, Pair<Double, Double>>> = emptyList(),
    val track: List<Pair<Double, Double>> = emptyList(),
    /** Centre lat, lon and radius in km. */
    val footprint: Triple<Double, Double, Double>? = null,
)

private class ItemsOverlay(private val accentInt: Int, private val goldInt: Int, private val onPick: (String) -> Unit) : Overlay() {
    @Volatile var items: List<GeoItem> = emptyList()
    @Volatile var layers = GeoLayers()
    @Volatile var selected: String? = null
    @Volatile var home: Pair<Double, Double>? = null
    private val dot = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { style = android.graphics.Paint.Style.FILL }
    private val rim = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF0B1416.toInt(); style = android.graphics.Paint.Style.STROKE; strokeWidth = 2f }
    private val line = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { style = android.graphics.Paint.Style.STROKE; strokeWidth = 2f }
    private val area = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { style = android.graphics.Paint.Style.FILL }
    private val label = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFFFFFF.toInt(); textAlign = android.graphics.Paint.Align.CENTER; isFakeBoldText = true; typeface = android.graphics.Typeface.MONOSPACE }
    private val halo = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xE6050B0D.toInt(); textAlign = android.graphics.Paint.Align.CENTER; isFakeBoldText = true; style = android.graphics.Paint.Style.STROKE; strokeWidth = 3f; typeface = android.graphics.Typeface.MONOSPACE }
    private val pt = android.graphics.Point()

    private fun xy(mv: MapView, lat: Double, lon: Double): Pair<Float, Float> { mv.projection.toPixels(GeoPoint(lat, lon), pt); return pt.x.toFloat() to pt.y.toFloat() }

    /** A polyline in map space, broken where it crosses the antimeridian rather than drawn across the world. */
    private fun polyline(c: android.graphics.Canvas, mv: MapView, pts: List<Pair<Double, Double>>, p: android.graphics.Paint) {
        val path = android.graphics.Path(); var prevLon: Double? = null
        for ((la, lo) in pts) {
            val (x, y) = xy(mv, la, lo)
            if (prevLon == null || abs(lo - prevLon) > 180) path.moveTo(x, y) else path.lineTo(x, y)
            prevLon = lo
        }
        c.drawPath(path, p)
    }

    override fun draw(c: android.graphics.Canvas, mv: MapView, shadow: Boolean) {
        if (shadow) return
        val d = mv.resources.displayMetrics.density
        label.textSize = 10f * d; halo.textSize = 10f * d
        val rgb = accentInt and 0x00FFFFFF
        layers.footprint?.let { (la, lo, km) ->
            val ring = (0..72).map { destination(la, lo, km, it * 5.0) }
            area.color = (0x22 shl 24) or rgb
            val path = android.graphics.Path(); var first = true; var prev: Double? = null
            for ((a, b) in ring) { val (x, y) = xy(mv, a, b); if (first || (prev != null && abs(b - prev) > 180)) path.moveTo(x, y) else path.lineTo(x, y); first = false; prev = b }
            c.drawPath(path, area)
            line.color = (0x99 shl 24) or rgb; line.strokeWidth = 1.5f * d
            polyline(c, mv, ring, line)
        }
        if (layers.track.isNotEmpty()) {
            line.color = goldInt; line.strokeWidth = 2f * d; line.pathEffect = android.graphics.DashPathEffect(floatArrayOf(6f * d, 4f * d), 0f)
            polyline(c, mv, layers.track, line)
            line.pathEffect = null
        }
        line.color = (0x66 shl 24) or rgb; line.strokeWidth = 1.2f * d
        for ((a, b) in layers.lines) polyline(c, mv, listOf(a, b), line)
        home?.let { (la, lo) -> val (x, y) = xy(mv, la, lo); dot.color = 0xFFFFFFFF.toInt(); c.drawCircle(x, y, 4f * d, dot); c.drawCircle(x, y, 4f * d, rim) }
        for (it in items) {
            val (x, y) = xy(mv, it.lat, it.lon)
            val col = when (it.kind) { GeoItem.Kind.OBJECT -> goldInt; GeoItem.Kind.SAT -> goldInt; else -> accentInt }
            val r = (if (it.kind == GeoItem.Kind.SAT) 7f else 5f) * d
            dot.color = col
            c.drawCircle(x, y, r, dot); c.drawCircle(x, y, r, rim)
            if (it.id == selected) { line.color = 0xFFFFFFFF.toInt(); line.strokeWidth = 2f * d; c.drawCircle(x, y, r + 4f * d, line) }
            val ly = y + r + label.textSize + 2f * d
            c.drawText(it.label, x, ly, halo); c.drawText(it.label, x, ly, label)
        }
    }

    override fun onSingleTapConfirmed(e: android.view.MotionEvent, mv: MapView): Boolean {
        var best: String? = null; var bestD = Float.MAX_VALUE
        for (it in items) {
            val (x, y) = xy(mv, it.lat, it.lon)
            val dd = (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y)
            if (dd < bestD) { bestD = dd; best = it.id }
        }
        val tapR = 26f * mv.resources.displayMetrics.density
        return if (best != null && bestD < tapR * tapR) { onPick(best); true } else false
    }
}

/** The point [km] away from lat, lon on bearing [deg] (great circle). */
private fun destination(lat: Double, lon: Double, km: Double, deg: Double): Pair<Double, Double> {
    val r = Math.PI / 180; val dr = km / 6371.0; val br = deg * r; val p1 = lat * r; val l1 = lon * r
    val p2 = asin(sin(p1) * cos(dr) + cos(p1) * sin(dr) * cos(br))
    val l2 = l1 + atan2(sin(br) * sin(dr) * cos(p1), cos(dr) - sin(p1) * sin(p2))
    var lo = l2 / r; while (lo > 180) lo -= 360; while (lo < -180) lo += 360
    return p2 / r to lo
}

/**
 * A general map on OSM tiles (same dark look as the ADS-B map): items with labels, an optional ground track and
 * footprint, lines home. It fits everything once when the item set first appears, then leaves the view to the user.
 */
@Composable
fun GeoMapView(
    items: List<GeoItem>, accent: Color, modifier: Modifier = Modifier, home: Pair<Double, Double>? = null,
    selected: String? = null, layers: GeoLayers = GeoLayers(), follow: String? = null, onPick: (String) -> Unit = {},
) {
    val accentInt = accent.toArgb(); val goldInt = Palette.accent2.toArgb()
    var mapRef by remember { mutableStateOf<MapView?>(null) }
    var overlayRef by remember { mutableStateOf<ItemsOverlay?>(null) }
    var fitted by remember { mutableStateOf(false) }

    LaunchedEffect(items, layers, selected, home) {
        val mv = mapRef ?: return@LaunchedEffect
        overlayRef?.let { it.items = items; it.layers = layers; it.selected = selected; it.home = home; mv.invalidate() }
        val f = follow?.let { id -> items.firstOrNull { it.id == id } }
        if (f != null) { mv.controller.animateTo(GeoPoint(f.lat, f.lon)); return@LaunchedEffect }
        if (!fitted && mv.width > 0) {
            val pts = items.map { it.lat to it.lon } + listOfNotNull(home)
            if (pts.size >= 2) {
                val pad = 1.0
                runCatching { mv.zoomToBoundingBox(BoundingBox(pts.maxOf { it.first } + pad, pts.maxOf { it.second } + pad, pts.minOf { it.first } - pad, pts.minOf { it.second } - pad), false, 60) }
                fitted = true
            } else if (pts.size == 1) { mv.controller.setCenter(GeoPoint(pts[0].first, pts[0].second)); fitted = items.isNotEmpty() }
        }
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
                    isHorizontalMapRepetitionEnabled = true
                    zoomController.setVisibility(CustomZoomButtonsController.Visibility.SHOW_AND_FADEOUT)
                    controller.setZoom(3.0)
                    controller.setCenter(if (home != null) GeoPoint(home.first, home.second) else GeoPoint(30.0, -40.0))
                    @Suppress("ClickableViewAccessibility")
                    setOnTouchListener { v, ev ->
                        when (ev.actionMasked) {
                            android.view.MotionEvent.ACTION_DOWN -> v.parent?.requestDisallowInterceptTouchEvent(true)
                            android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> v.parent?.requestDisallowInterceptTouchEvent(false)
                        }
                        false
                    }
                    val ov = ItemsOverlay(accentInt, goldInt, onPick).also { it.items = items; it.layers = layers; it.selected = selected; it.home = home }
                    overlays.add(ov); overlayRef = ov
                    onResume()
                }
            }
        )
        Text("© OpenStreetMap contributors", color = Palette.muted, fontFamily = Mono, fontSize = 8.sp,
            modifier = Modifier.align(Alignment.BottomStart).padding(4.dp).background(Palette.paper.copy(alpha = 0.6f), RoundedCornerShape(3.dp)).padding(horizontal = 4.dp, vertical = 1.dp))
    }
}
