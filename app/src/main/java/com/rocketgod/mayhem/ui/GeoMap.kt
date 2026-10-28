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
import kotlinx.coroutines.delay
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
data class GeoItem(val id: String, val lat: Double, val lon: Double, val label: String, val kind: Kind, val heading: Double? = null) {
    enum class Kind { QSO, OBJECT, SAT, DEVICE, SHIP, ATON, STATION }
}

/** The map's extra layers: lines home to each contact, a satellite's ground track and radio footprint. */
data class GeoLayers(
    val lines: List<Pair<Pair<Double, Double>, Pair<Double, Double>>> = emptyList(),
    val track: List<Pair<Double, Double>> = emptyList(),
    /** Center lat, lon and radius in km. */
    val footprint: Triple<Double, Double, Double>? = null,
)

private class ItemsOverlay(private val accentInt: Int, private val goldInt: Int, private val onPick: (String) -> Unit) : Overlay() {
    @Volatile var items: List<GeoItem> = emptyList()
    @Volatile var layers = GeoLayers()
    @Volatile var selected: String? = null
    @Volatile var home: Pair<Double, Double>? = null
    private val dot = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { style = android.graphics.Paint.Style.FILL }
    private val rim = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF0B1416.toInt(); style = android.graphics.Paint.Style.STROKE; strokeWidth = 2f; strokeJoin = android.graphics.Paint.Join.ROUND }
    private val glow = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { style = android.graphics.Paint.Style.FILL }
    private val shape = android.graphics.Path()
    private val box = android.graphics.RectF()
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

    /** Marker size in dp: the drawn shapes span ±1.4 units of it. */
    private fun sizeDp(k: GeoItem.Kind): Float = when (k) {
        GeoItem.Kind.SAT -> 30f; GeoItem.Kind.STATION, GeoItem.Kind.DEVICE -> 18f; GeoItem.Kind.QSO -> 14f; else -> 22f
    }

    /** Each kind's outline around x, y at [s] px per unit: a hull for a ship under way, a diamond for an AtoN, a ring for a station. */
    private fun outline(it: GeoItem, x: Float, y: Float, s: Float) {
        val p = shape; p.reset()
        val cw = android.graphics.Path.Direction.CW
        when (it.kind) {
            GeoItem.Kind.SHIP -> if (it.heading == null) p.addCircle(x, y, 0.75f * s, cw) else {
                p.moveTo(x, y - 1.25f * s); p.lineTo(x + 0.62f * s, y - 0.35f * s); p.lineTo(x + 0.62f * s, y + 1.05f * s)
                p.lineTo(x - 0.62f * s, y + 1.05f * s); p.lineTo(x - 0.62f * s, y - 0.35f * s); p.close()
            }
            GeoItem.Kind.ATON -> { p.moveTo(x, y - 1.1f * s); p.lineTo(x + 1.1f * s, y); p.lineTo(x, y + 1.1f * s); p.lineTo(x - 1.1f * s, y); p.close() }
            GeoItem.Kind.STATION -> p.addCircle(x, y, 0.8f * s, cw)
            GeoItem.Kind.OBJECT -> { box.set(x - 0.8f * s, y - 0.8f * s, x + 0.8f * s, y + 0.8f * s); p.addRoundRect(box, 0.2f * s, 0.2f * s, cw) }
            GeoItem.Kind.SAT -> {
                p.addRect(x - 0.35f * s, y - 0.35f * s, x + 0.35f * s, y + 0.35f * s, cw)
                p.addRect(x - 1.3f * s, y - 0.2f * s, x - 0.5f * s, y + 0.2f * s, cw)
                p.addRect(x + 0.5f * s, y - 0.2f * s, x + 1.3f * s, y + 0.2f * s, cw)
            }
            GeoItem.Kind.QSO, GeoItem.Kind.DEVICE -> p.addCircle(x, y, 0.6f * s, cw)
        }
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
        rim.strokeWidth = 2f
        home?.let { (la, lo) -> val (x, y) = xy(mv, la, lo); dot.color = 0xFFFFFFFF.toInt(); c.drawCircle(x, y, 4f * d, dot); c.drawCircle(x, y, 4f * d, rim) }
        for (it in items) {
            val (x, y) = xy(mv, it.lat, it.lon)
            val col = when (it.kind) { GeoItem.Kind.OBJECT, GeoItem.Kind.SAT, GeoItem.Kind.ATON -> goldInt; else -> accentInt }
            val half = sizeDp(it.kind) * d / 2f
            val s = half / 1.4f
            glow.shader = android.graphics.RadialGradient(x, y, half * 1.3f, (0x70 shl 24) or (col and 0x00FFFFFF), col and 0x00FFFFFF, android.graphics.Shader.TileMode.CLAMP)
            c.drawCircle(x, y, half * 1.3f, glow)
            if (it.id == selected) { line.color = 0xFFFFFFFF.toInt(); line.strokeWidth = 2f * d; c.drawCircle(x, y, half + 3f * d, line) }
            outline(it, x, y, s)
            dot.color = col; rim.strokeWidth = 0.12f * s
            // only a ship's hull turns: the other shapes have no front
            val turn = if (it.kind == GeoItem.Kind.SHIP) it.heading else null
            c.save()
            if (turn != null) c.rotate(turn.toFloat(), x, y)
            c.drawPath(shape, dot); c.drawPath(shape, rim)
            c.restore()
            if (it.kind == GeoItem.Kind.STATION) { dot.color = 0xFF0B1416.toInt(); c.drawCircle(x, y, 0.3f * s, dot) }
            val ly = y + half + label.textSize
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
 * footprint, lines home. It follows the traffic, re-fitting as it moves, until you drag; the crosshair button
 * re-arms it. [follow] names an item to keep centered instead of fitting the lot (a satellite and its long track).
 */
@Composable
fun GeoMapView(
    items: List<GeoItem>, accent: Color, modifier: Modifier = Modifier, home: Pair<Double, Double>? = null,
    selected: String? = null, layers: GeoLayers = GeoLayers(), follow: String? = null,
    /** Center on this point whenever [focusKey] changes (the MAP button on a detail card). */
    focus: Pair<Double, Double>? = null, focusKey: Int = 0, onPick: (String) -> Unit = {},
) {
    val accentInt = accent.toArgb(); val goldInt = Palette.accent2.toArgb()
    var mapRef by remember { mutableStateOf<MapView?>(null) }
    var overlayRef by remember { mutableStateOf<ItemsOverlay?>(null) }
    var following by remember { mutableStateOf(true) }

    fun fitTo(mv: MapView) {
        val f = follow?.let { id -> items.firstOrNull { it.id == id } }
        if (f != null) { mv.controller.animateTo(GeoPoint(f.lat, f.lon)); return }
        // home only counts when something is drawn from it
        val pts = items.map { it.lat to it.lon } + layers.track +
            (if (layers.track.isNotEmpty() || layers.lines.isNotEmpty()) listOfNotNull(home) else emptyList())
        if (pts.isEmpty()) return
        val n = pts.maxOf { it.first }; val s = pts.minOf { it.first }; val e = pts.maxOf { it.second }; val w = pts.minOf { it.second }
        if (n - s < 1e-6 && e - w < 1e-6) { mv.controller.animateTo(GeoPoint(pts[0].first, pts[0].second)); return }
        runCatching { mv.zoomToBoundingBox(BoundingBox(n, e, s, w), false, (40 * mv.resources.displayMetrics.density).toInt()) }
        if (mv.zoomLevelDouble > 11.0) mv.controller.setZoom(11.0)
    }

    LaunchedEffect(mapRef, items, layers, selected, home, following) {
        val mv = mapRef ?: return@LaunchedEffect
        overlayRef?.let { it.items = items; it.layers = layers; it.selected = selected; it.home = home; mv.invalidate() }
        if (!following) return@LaunchedEffect
        var waits = 0
        while ((mv.width == 0 || mv.height == 0) && waits++ < 40) delay(50)
        if (mv.width > 0 && mv.height > 0) fitTo(mv)
    }

    LaunchedEffect(focusKey) {
        val mv = mapRef ?: return@LaunchedEffect
        val f = focus ?: return@LaunchedEffect
        if (focusKey == 0) return@LaunchedEffect
        following = false
        if (mv.zoomLevelDouble < 11.0) mv.controller.setZoom(11.0)
        mv.controller.animateTo(GeoPoint(f.first, f.second))
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
                    // a drag (past the touch slop, so a tap on a marker does not count) hands the view to the user
                    val slop = android.view.ViewConfiguration.get(c).scaledTouchSlop.toFloat()
                    var downX = 0f; var downY = 0f
                    @Suppress("ClickableViewAccessibility")
                    setOnTouchListener { v, ev ->
                        when (ev.actionMasked) {
                            android.view.MotionEvent.ACTION_DOWN -> { downX = ev.x; downY = ev.y; v.parent?.requestDisallowInterceptTouchEvent(true) }
                            android.view.MotionEvent.ACTION_MOVE -> if (following && (abs(ev.x - downX) > slop || abs(ev.y - downY) > slop)) following = false
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
        Box(
            Modifier.align(Alignment.BottomEnd).padding(6.dp).size(30.dp)
                .background(if (following) accent else Palette.surface.copy(alpha = 0.9f), RoundedCornerShape(8.dp))
                .clickable { following = !following },
            contentAlignment = Alignment.Center
        ) { Text("⌖", color = if (following) inkOn(accent) else Palette.ink, fontFamily = Mono) }
        Text("© OpenStreetMap contributors", color = Palette.muted, fontFamily = Mono, fontSize = 8.sp,
            modifier = Modifier.align(Alignment.BottomStart).padding(4.dp).background(Palette.paper.copy(alpha = 0.6f), RoundedCornerShape(3.dp)).padding(horizontal = 4.dp, vertical = 1.dp))
    }
}
