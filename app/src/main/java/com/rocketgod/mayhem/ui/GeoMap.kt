package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
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
data class GeoItem(val id: String, val lat: Double, val lon: Double, val label: String, val kind: Kind, val heading: Double? = null,
                   /** ARGB fill instead of the accent (airports by flight category). */ val color: Int? = null) {
    enum class Kind { QSO, OBJECT, SAT, DEVICE, SHIP, ATON, STATION, SONDE, LANDING, BURST, AIRPORT, TOWER, PLANE }
}

/** A radar block: south-west corner and size in degrees, [bins] cols across and rows from the north, 0 = clear. */
class RadarCell(val lat: Double, val lon: Double, val dLat: Double, val dLon: Double, val cols: Int, val rows: Int, val bins: ByteArray,
                /** ARGB by value for this block (a hazard grid), instead of the radar's colors. */ val colors: IntArray? = null) {
    /** The block as a cols x rows bitmap, made once, drawn smoothed when zoomed in. */
    @Volatile var bitmap: android.graphics.Bitmap? = null
}

/** A hazard drawn on the map (a G-AIRMET): an area or a line in [color], tappable by [id]. */
data class GeoShape(val id: String, val pts: List<Pair<Double, Double>>, val line: Boolean, val color: Int, val dashed: Boolean = false, val sel: Boolean = false)

/** The map's extra layers: lines home to each contact, a satellite's ground track and radio footprint. */
data class GeoLayers(
    val lines: List<Pair<Pair<Double, Double>, Pair<Double, Double>>> = emptyList(),
    val track: List<Pair<Double, Double>> = emptyList(),
    /** Centre lat, lon and radius in km. */
    val footprint: Triple<Double, Double, Double>? = null,
    /** Any number of paths in the accent (sonde flight tracks solid, predicted descents dashed). */
    val paths: List<GeoPath> = emptyList(),
    /** Weather radar under everything else, [radarColors] ARGB by intensity (0 means not drawn). */
    val radar: List<RadarCell> = emptyList(),
    val radarColors: IntArray = IntArray(0),
    /** Hazard areas and lines over the radar, under the markers. */
    val shapes: List<GeoShape> = emptyList(),
)

/** A line through [pts]: dashed for a prediction, faint for one that is not the selected item's. */
data class GeoPath(val pts: List<Pair<Double, Double>>, val dashed: Boolean = false, val faint: Boolean = false)

/** Regional zoom: a couple of hundred kilometers across, where ships, stations and aircraft near you show up. */
const val REGION_ZOOM = 8.0

/** Where a map opens before anything is plotted. [standIn]: there is no position at all, so it is the middle of the US. */
data class MapStart(val lat: Double, val lon: Double, val zoom: Double, val standIn: Boolean)

/** Where a map opens: your position, else the last one known, else the middle of the US; always at regional zoom. */
fun mapStart(home: Pair<Double, Double>?): MapStart {
    val p = home ?: com.rocketgod.mayhem.core.Geo.lastKnownPos()
    return if (p != null) MapStart(p.first, p.second, REGION_ZOOM, false) else MapStart(39.5, -98.35, REGION_ZOOM - 3, true)
}

/** The second line of a map's empty overlay: what will show up, and where the map is centered. */
fun mapEmptySub(what: String, home: Pair<Double, Double>?): String =
    "$what. " + if (home != null) "Centered on you." else if (mapStart(null).standIn) "No location yet: allow it to center the map on you." else "Centered where you were last."

/** Over a map until its first contact: a centered translucent box with [title] and [sub] under it. */
@Composable
fun MapEmptyOverlay(title: String, sub: String, modifier: Modifier = Modifier) {
    if (title.isEmpty()) return
    val shape = RoundedCornerShape(12.dp)
    androidx.compose.foundation.layout.Column(
        modifier.widthIn(max = 320.dp).background(Palette.surface.copy(alpha = 0.86f), shape).border(1.dp, Palette.line, shape)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(4.dp)
    ) {
        Text(title, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = 12.sp, letterSpacing = 1.2.sp, textAlign = TextAlign.Center)
        if (sub.isNotEmpty()) Text(sub, color = Palette.muted, fontFamily = Mono, fontSize = 10.sp, lineHeight = 14.sp, textAlign = TextAlign.Center)
    }
}

private class ItemsOverlay(private val accentInt: Int, private val goldInt: Int, private val onPick: (String) -> Unit,
                           private val onMapTap: ((Double, Double) -> Unit)? = null) : Overlay() {
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
        GeoItem.Kind.SAT -> 30f; GeoItem.Kind.STATION, GeoItem.Kind.DEVICE -> 18f; GeoItem.Kind.QSO -> 14f; GeoItem.Kind.AIRPORT -> 12f
        GeoItem.Kind.PLANE -> 26f; else -> 22f
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
            // a balloon on its line with the sonde under it
            GeoItem.Kind.SONDE -> {
                p.addCircle(x, y - 0.55f * s, 0.62f * s, cw)
                p.addRect(x - 0.07f * s, y + 0.05f * s, x + 0.07f * s, y + 0.77f * s, cw)
                box.set(x - 0.3f * s, y + 0.75f * s, x + 0.3f * s, y + 1.25f * s); p.addRoundRect(box, 0.08f * s, 0.08f * s, cw)
            }
            // where it comes down: a target
            GeoItem.Kind.LANDING -> {
                p.addCircle(x, y, 1.1f * s, cw); p.addCircle(x, y, 0.78f * s, android.graphics.Path.Direction.CCW); p.addCircle(x, y, 0.32f * s, cw)
            }
            GeoItem.Kind.AIRPORT -> p.addCircle(x, y, 0.62f * s, cw)
            // a FIS-B ground station: a mast with a dot on top
            GeoItem.Kind.TOWER -> {
                p.moveTo(x, y - 0.5f * s); p.lineTo(x + 0.45f * s, y + 1.2f * s); p.lineTo(x + 0.2f * s, y + 1.2f * s); p.lineTo(x, y + 0.45f * s)
                p.lineTo(x - 0.2f * s, y + 1.2f * s); p.lineTo(x - 0.45f * s, y + 1.2f * s); p.close(); p.addCircle(x, y - 0.62f * s, 0.22f * s, cw)
            }
            // an airliner seen from above, nose up (it turns with the heading)
            GeoItem.Kind.PLANE -> {
                val xs = floatArrayOf(0f, 0.15f, 1.15f, 1.15f, 0.15f, 0.13f, 0.55f, 0.55f, 0f, -0.55f, -0.55f, -0.13f, -0.15f, -1.15f, -1.15f, -0.15f)
                val ys = floatArrayOf(-1.25f, -0.45f, 0.18f, 0.4f, 0.1f, 0.8f, 1.12f, 1.28f, 1f, 1.28f, 1.12f, 0.8f, 0.1f, 0.4f, 0.18f, -0.45f)
                p.moveTo(x + xs[0] * s, y + ys[0] * s); for (i in 1 until xs.size) p.lineTo(x + xs[i] * s, y + ys[i] * s); p.close()
            }
            // where it burst: a star
            GeoItem.Kind.BURST -> {
                val xs = floatArrayOf(0f, 0.3f, 1.15f, 0.45f, 0.72f, 0f, -0.72f, -0.45f, -1.15f, -0.3f)
                val ys = floatArrayOf(-1.2f, -0.4f, -0.4f, 0.12f, 0.95f, 0.45f, 0.95f, 0.12f, -0.4f, -0.4f)
                p.moveTo(x + xs[0] * s, y + ys[0] * s); for (i in 1 until xs.size) p.lineTo(x + xs[i] * s, y + ys[i] * s); p.close()
            }
        }
    }

    override fun draw(c: android.graphics.Canvas, mv: MapView, shadow: Boolean) {
        if (shadow) return
        val d = mv.resources.displayMetrics.density
        label.textSize = 10f * d; halo.textSize = 10f * d
        val rgb = accentInt and 0x00FFFFFF
        if (layers.radar.isNotEmpty()) drawRadar(c, mv)
        for (sh in layers.shapes) {
            if (sh.pts.size < 2) continue
            val path = android.graphics.Path()
            sh.pts.forEachIndexed { i, (a, b) -> val (x, y) = xy(mv, a, b); if (i == 0) path.moveTo(x, y) else path.lineTo(x, y) }
            if (!sh.line) { path.close(); area.color = ((if (sh.sel) 0x48 else 0x1F) shl 24) or (sh.color and 0x00FFFFFF); c.drawPath(path, area) }
            line.color = ((if (sh.sel) 0xFF else 0xD0) shl 24) or (sh.color and 0x00FFFFFF); line.strokeWidth = (if (sh.sel) 3.5f else if (sh.line) 2f else 1.5f) * d
            line.pathEffect = if (sh.dashed) android.graphics.DashPathEffect(floatArrayOf(6f * d, 5f * d), 0f) else null
            c.drawPath(path, line); line.pathEffect = null
        }
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
        for (pa in layers.paths) {
            if (pa.pts.size < 2) continue
            line.color = ((if (pa.faint) 0x66 else 0xD9) shl 24) or rgb; line.strokeWidth = (if (pa.dashed) 2f else 3f) * d
            line.pathEffect = if (pa.dashed) android.graphics.DashPathEffect(floatArrayOf(6f * d, 6f * d), 0f) else null
            polyline(c, mv, pa.pts, line)
            line.pathEffect = null
        }
        line.color = (0x66 shl 24) or rgb; line.strokeWidth = 1.2f * d
        for ((a, b) in layers.lines) polyline(c, mv, listOf(a, b), line)
        rim.strokeWidth = 2f
        home?.let { (la, lo) -> val (x, y) = xy(mv, la, lo); dot.color = 0xFFFFFFFF.toInt(); c.drawCircle(x, y, 4f * d, dot); c.drawCircle(x, y, 4f * d, rim) }
        for (it in items) {
            val (x, y) = xy(mv, it.lat, it.lon)
            val col = it.color ?: when (it.kind) { GeoItem.Kind.OBJECT, GeoItem.Kind.SAT, GeoItem.Kind.ATON -> goldInt; else -> accentInt }
            val half = sizeDp(it.kind) * d / 2f
            val s = half / 1.4f
            glow.shader = android.graphics.RadialGradient(x, y, half * 1.3f, (0x70 shl 24) or (col and 0x00FFFFFF), col and 0x00FFFFFF, android.graphics.Shader.TileMode.CLAMP)
            c.drawCircle(x, y, half * 1.3f, glow)
            if (it.id == selected) { line.color = 0xFFFFFFFF.toInt(); line.strokeWidth = 2f * d; c.drawCircle(x, y, half + 3f * d, line) }
            outline(it, x, y, s)
            dot.color = col; rim.strokeWidth = 0.12f * s
            // only a ship's hull turns: the other shapes have no front
            val turn = if (it.kind == GeoItem.Kind.SHIP || it.kind == GeoItem.Kind.PLANE) it.heading else null
            c.save()
            if (turn != null) c.rotate(turn.toFloat(), x, y)
            c.drawPath(shape, dot); c.drawPath(shape, rim)
            c.restore()
            if (it.kind == GeoItem.Kind.STATION) { dot.color = 0xFF0B1416.toInt(); c.drawCircle(x, y, 0.3f * s, dot) }
            val ly = y + half + label.textSize
            c.drawText(it.label, x, ly, halo); c.drawText(it.label, x, ly, label)
        }
    }

    private val cell = android.graphics.Paint().apply { style = android.graphics.Paint.Style.FILL }
    private val smooth = android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG)

    /**
     * The radar: each block projected corner to corner and its bins drawn as cells. Zoomed out, where a bin would be
     * under a pixel and a half wide, neighboring bins are merged (the strongest wins) so a phone is not asked to paint
     * a whole country's worth of single-pixel rectangles every frame.
     */
    private fun drawRadar(c: android.graphics.Canvas, mv: MapView) {
        val bb = mv.boundingBox
        for (rc in layers.radar) {
            val colors = rc.colors ?: layers.radarColors
            if (rc.lat > bb.latNorth || rc.lat + rc.dLat < bb.latSouth) continue
            if (bb.lonWest <= bb.lonEast && (rc.lon > bb.lonEast || rc.lon + rc.dLon < bb.lonWest)) continue
            val (x0, y0) = xy(mv, rc.lat + rc.dLat, rc.lon); val (x1, y1) = xy(mv, rc.lat, rc.lon + rc.dLon)
            val bw = (x1 - x0) / rc.cols; val bh = (y1 - y0) / rc.rows
            if (x1 - x0 < 0.5f) continue
            // zoomed in so a bin is several pixels: the block as a small bitmap drawn with filtering, soft fields
            // like a forecast map instead of hard squares
            if (bw >= 4f) {
                val bmp = rc.bitmap ?: android.graphics.Bitmap.createBitmap(rc.cols, rc.rows, android.graphics.Bitmap.Config.ARGB_8888).also { b ->
                    for (r in 0 until rc.rows) for (k in 0 until rc.cols) { val v = rc.bins[r * rc.cols + k].toInt() and 0xff; b.setPixel(k, r, if (v in 1 until colors.size) colors[v] else 0) }
                    rc.bitmap = b
                }
                c.drawBitmap(bmp, null, android.graphics.RectF(x0, y0, x1, y1), smooth)
                continue
            }
            val g = if (bw >= 1.5f) 1 else minOf(rc.cols, kotlin.math.ceil(1.5f / maxOf(bw, 0.01f)).toInt())
            for (r in 0 until rc.rows) {
                var k = 0
                while (k < rc.cols) {
                    var v = 0
                    for (j in k until minOf(rc.cols, k + g)) v = maxOf(v, rc.bins[r * rc.cols + j].toInt() and 0xff)
                    if (v > 0 && v < colors.size && colors[v] != 0) {
                        cell.color = colors[v]
                        c.drawRect(x0 + k * bw, y0 + r * bh, x0 + minOf(rc.cols, k + g) * bw + 0.5f, y0 + (r + 1) * bh + 0.5f, cell)
                    }
                    k += g
                }
            }
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
        if (best != null && bestD < tapR * tapR) { onPick(best); return true }
        // a hazard area or line under the finger, else a tap on open map
        val gp = mv.projection.fromPixels(e.x.toInt(), e.y.toInt())
        val la = gp.latitude; val lo = gp.longitude
        for (sh in layers.shapes.asReversed()) {
            if (!sh.line && inPoly(la, lo, sh.pts)) { onPick(sh.id); return true }
        }
        val tap = onMapTap ?: return false
        tap(la, lo); return true
    }
}

/** Whether lat, lon is inside the polygon [pts] (ray casting). */
fun inPoly(lat: Double, lon: Double, pts: List<Pair<Double, Double>>): Boolean {
    var inside = false; var j = pts.size - 1
    for (i in pts.indices) {
        val (ya, xa) = pts[i]; val (yb, xb) = pts[j]
        if ((ya > lat) != (yb > lat) && lon < (xb - xa) * (lat - ya) / (yb - ya) + xa) inside = !inside
        j = i
    }
    return inside
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
 * re-arms it. [follow] names an item to keep centred instead of fitting the lot (a satellite and its long track).
 */
@Composable
fun GeoMapView(
    items: List<GeoItem>, accent: Color, modifier: Modifier = Modifier, home: Pair<Double, Double>? = null,
    selected: String? = null, layers: GeoLayers = GeoLayers(), follow: String? = null,
    /** Centre on this point whenever [focusKey] changes (the MAP button on a detail card). */
    focus: Pair<Double, Double>? = null, focusKey: Int = 0,
    /** Start on [home] at street level, and keep it in view with the items when fitting (meters around you). */
    fitHome: Boolean = false,
    /** Keep [home] in every fit, so the map shows your area and what you have heard around it (APRS). */
    withHome: Boolean = false,
    /** Where it opens before anything is plotted ([mapStart]); a fix arriving later moves it only while nothing is. */
    start: MapStart? = null,
    /** Shown over the map until its first contact ("" hides it), with [emptySub] under it. */
    emptyTitle: String = "", emptySub: String = "",
    /** Fit the view to the items as they come (false: stay where it opened until the crosshair is pressed). */
    autoFollow: Boolean = true,
    /** A tap on open map (not on a marker or a hazard area). */
    onMapTap: ((Double, Double) -> Unit)? = null,
    /** Moving markers: fit when the set of items changes, not on every move (a refit every update keeps the map panning). */
    steady: Boolean = false,
    onPick: (String) -> Unit = {},
) {
    val accentInt = accent.toArgb(); val goldInt = Palette.accent2.toArgb()
    var mapRef by remember { mutableStateOf<MapView?>(null) }
    var overlayRef by remember { mutableStateOf<ItemsOverlay?>(null) }
    var following by remember { mutableStateOf(autoFollow) }
    // the first fix centers the map on your area once (it usually lands after the map opened on the world)
    var homed by remember { mutableStateOf(false) }

    fun fitTo(mv: MapView) {
        val f = follow?.let { id -> items.firstOrNull { it.id == id } }
        if (f != null) { mv.controller.animateTo(GeoPoint(f.lat, f.lon)); return }
        // home only counts when something is drawn from it
        val pts = items.map { it.lat to it.lon } + layers.track +
            (if (withHome || layers.track.isNotEmpty() || layers.lines.isNotEmpty() || (fitHome && items.isEmpty())) listOfNotNull(home) else emptyList())
        // nothing plotted yet: a map with a start point stays at regional zoom, recentered once when a fix comes in
        if (start != null && items.isEmpty() && layers.track.isEmpty()) {
            if (home != null && !homed) { homed = true; mv.controller.animateTo(GeoPoint(home.first, home.second), REGION_ZOOM, null) }
            return
        }
        if (pts.isEmpty()) {
            if (home != null && !homed) { homed = true; mv.controller.animateTo(GeoPoint(home.first, home.second), maxOf(mv.zoomLevelDouble, 9.0), null) }
            return
        }
        homed = true
        val n = pts.maxOf { it.first }; val s = pts.minOf { it.first }; val e = pts.maxOf { it.second }; val w = pts.minOf { it.second }
        // one point (or several on the same spot): glide there and zoom in as part of the glide (a setZoom after
        // animateTo stops the glide, which left the map zoomed in on its starting point, far from the pin)
        if (pts.size == 1 || (n - s < 1e-6 && e - w < 1e-6)) {
            mv.controller.animateTo(GeoPoint(pts[0].first, pts[0].second), if (fitHome) 15.0 else maxOf(mv.zoomLevelDouble, 11.0), null)
            return
        }
        runCatching { mv.zoomToBoundingBox(BoundingBox(n, e, s, w), false, ((if (fitHome) 70 else 40) * mv.resources.displayMetrics.density).toInt()) }
        val maxZoom = if (fitHome) 17.0 else 11.0
        if (mv.zoomLevelDouble > maxZoom) mv.controller.setZoom(maxZoom)
    }

    LaunchedEffect(mapRef, items, layers, selected, home) {
        val mv = mapRef ?: return@LaunchedEffect
        overlayRef?.let { it.items = items; it.layers = layers; it.selected = selected; it.home = home; mv.invalidate() }
    }
    val fitKey: Any = if (steady) items.map { it.id }.sorted() else listOf(items, layers, selected, home)
    LaunchedEffect(mapRef, fitKey, following) {
        val mv = mapRef ?: return@LaunchedEffect
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
                    // our own − / + below, the same on every platform
                    zoomController.setVisibility(CustomZoomButtonsController.Visibility.NEVER)
                    if (start != null) { controller.setZoom(start.zoom); controller.setCenter(GeoPoint(start.lat, start.lon)) }
                    else {
                        controller.setZoom(if (home == null) 3.0 else if (fitHome) 13.0 else 9.0)
                        controller.setCenter(if (home != null) GeoPoint(home.first, home.second) else GeoPoint(30.0, -40.0))
                    }
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
                    val ov = ItemsOverlay(accentInt, goldInt, onPick, onMapTap).also { it.items = items; it.layers = layers; it.selected = selected; it.home = home }
                    overlays.add(ov); overlayRef = ov
                    onResume()
                }
            }
        )
        MapEmptyOverlay(emptyTitle, emptySub, Modifier.align(Alignment.Center).padding(16.dp))
        // + / − zoom, top left (the web map's): a zoom by hand stops the follow, as a drag does
        androidx.compose.foundation.layout.Column(Modifier.align(Alignment.TopStart).padding(6.dp)) {
            for ((label, step) in listOf("+" to 1.0, "−" to -1.0)) {
                Box(
                    Modifier.padding(bottom = 4.dp).size(30.dp).background(Palette.surface.copy(alpha = 0.9f), RoundedCornerShape(8.dp))
                        .clickable { val mv = mapRef ?: return@clickable; following = false; mv.controller.setZoom((mv.zoomLevelDouble + step).coerceIn(2.0, 19.0)) },
                    contentAlignment = Alignment.Center
                ) { Text(label, color = Palette.ink, fontFamily = Mono, fontSize = 16.sp) }
            }
        }
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
