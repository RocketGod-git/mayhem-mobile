package com.rocketgod.mayhem.ui

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Skins. The six after "Mayhem Mobile" are the PortaPack Mayhem firmware's own themes (firmware/application/
 * theme.cpp): paper = bg_darkest, surface/panel = the next steps up, line = bg_dark, muted = fg_dark,
 * accent = fg_medium / table-header, accent2 = option_active. "Mayhem Mobile" is the default: the same
 * structure in a calmer blue-black, tuned for a phone OLED. "Cyan" is Wardrive Go's palette.
 */
enum class Skin(
    val title: String, val paper: Color, val surface: Color, val panel: Color, val line: Color,
    val ink: Color, val muted: Color, val accent: Color, val accent2: Color
) {
    MAYHEM("Mayhem Mobile", Color(0xFF0A0D13), Color(0xFF121722), Color(0xFF1A2130), Color(0xFF2A3348), Color(0xFFE8ECF4), Color(0xFF8D97AB), Color(0xFF4C8DFF), Color(0xFFFFAF00)),
    CLASSIC("Mayhem Default", Color(0xFF000000), Color(0xFF141414), Color(0xFF1F1F1F), Color(0xFF3F3F3F), Color(0xFFFFFFFF), Color(0xFF7F7F7F), Color(0xFF3B6CFF), Color(0xFFFFD200)),
    YELLOW("Mayhem Yellow", Color(0xFF1F1F00), Color(0xFF2E2E00), Color(0xFF444400), Color(0xFF666600), Color(0xFFFFFFFF), Color(0xFF999900), Color(0xFFCCCC00), Color(0xFFFFAF00)),
    AQUA("Mayhem Aqua", Color(0xFF001F1F), Color(0xFF002E2E), Color(0xFF004444), Color(0xFF006666), Color(0xFFFFFFFF), Color(0xFF009999), Color(0xFF00CCCC), Color(0xFF0090C8)),
    GREEN("Mayhem Green", Color(0xFF002104), Color(0xFF003006), Color(0xFF004009), Color(0xFF004F09), Color(0xFFFFFFFF), Color(0xFF00630C), Color(0xFF00CD1E), Color(0xFFFFAF00)),
    RED("Mayhem Red", Color(0xFF210400), Color(0xFF300600), Color(0xFF400900), Color(0xFF4F0900), Color(0xFFFFFFFF), Color(0xFF8F1100), Color(0xFFCD1E00), Color(0xFFFFAF00)),
    DARK("Mayhem Dark", Color(0xFF000000), Color(0xFF0C0C0C), Color(0xFF161616), Color(0xFF303030), Color(0xFFFFFFFF), Color(0xFF808080), Color(0xFFC8C8C8), Color(0xFF606060)),
    WARBLE("Cyan", Color(0xFF06090A), Color(0xFF0E1618), Color(0xFF16211F), Color(0xFF2C3D3B), Color(0xFFE9F3F0), Color(0xFF94A9A4), Color(0xFF37ECCB), Color(0xFFFFD24A));
}

/** The live palette. State-backed so a skin change recomposes every screen. */
object Palette {
    var paper by mutableStateOf(Skin.MAYHEM.paper); private set
    var surface by mutableStateOf(Skin.MAYHEM.surface); private set
    var panel by mutableStateOf(Skin.MAYHEM.panel); private set
    var line by mutableStateOf(Skin.MAYHEM.line); private set
    var ink by mutableStateOf(Skin.MAYHEM.ink); private set
    var muted by mutableStateOf(Skin.MAYHEM.muted); private set
    var accent by mutableStateOf(Skin.MAYHEM.accent); private set
    var accent2 by mutableStateOf(Skin.MAYHEM.accent2); private set
    val danger = Color(0xFFFF5B52)
    val ok = Color(0xFF3DDC84)
    /** Peak-hold trace color: the secondary accent unless it is too dark to read over the spectrum. */
    val hold: Color get() = if (accent2.luminance() < 0.15f) ink.copy(alpha = 0.6f) else accent2

    fun apply(s: Skin) {
        paper = s.paper; surface = s.surface; panel = s.panel; line = s.line
        ink = s.ink; muted = s.muted; accent = s.accent; accent2 = s.accent2
    }
}

/** Skin selection + persistence. */
object Skins {
    var current by mutableStateOf(Skin.MAYHEM); private set

    fun load(ctx: Context) {
        val name = ctx.getSharedPreferences("mayhem", Context.MODE_PRIVATE).getString("skin", null)
        set(ctx, runCatching { Skin.valueOf(name ?: "") }.getOrDefault(Skin.MAYHEM), persist = false)
    }

    fun set(ctx: Context, skin: Skin, persist: Boolean = true) {
        current = skin
        Palette.apply(skin)
        if (persist) ctx.getSharedPreferences("mayhem", Context.MODE_PRIVATE).edit().putString("skin", skin.name).apply()
    }
}

val Mono: FontFamily = FontFamily.Monospace

/** Text color that reads on a filled [bg]. */
fun inkOn(bg: Color): Color = if (bg.luminance() > 0.45f) Color(0xFF05080A) else Color(0xFFF4F6F8)

// ---- Responsive sizing -------------------------------------------------------------------------------------
enum class ScreenClass { COMPACT, MEDIUM, EXPANDED }

/** Screen-class-aware dimensions: phones scale 1.0, small tablets 1.15, big tablets 1.3; [wide] switches
 *  screens to a two-pane layout (visual left, controls right). */
class Dims(val cls: ScreenClass, val wide: Boolean, val scale: Float, val widthDp: Int, val heightDp: Int) {
    val pad: Dp get() = (8f * scale).dp
    val gap: Dp get() = (6f * scale).dp
    val tileMin: Dp get() = (150f * scale).dp
    fun sp(v: Float): TextUnit = (v * scale).sp
    fun dp(v: Float): Dp = (v * scale).dp
}

@Composable
fun rememberDims(): Dims {
    val cfg = LocalConfiguration.current
    val w = cfg.screenWidthDp; val h = cfg.screenHeightDp
    return remember(w, h) {
        val cls = when { w >= 840 -> ScreenClass.EXPANDED; w >= 600 -> ScreenClass.MEDIUM; else -> ScreenClass.COMPACT }
        // side by side when the screen is on its side; a tablet held upright stacks like a phone, only bigger
        val wide = (w > h && w >= 560) || w >= 1100
        val scale = when (cls) { ScreenClass.COMPACT -> 1f; ScreenClass.MEDIUM -> 1.15f; ScreenClass.EXPANDED -> 1.3f }
        Dims(cls, wide, scale, w, h)
    }
}

// ---- Surfaces (flat, Mayhem-like: solid fills, 1 px edges, small radii) -------------------------------------
/** A control surface: [selected] fills with the tint, otherwise a surface with a thin tinted edge. */
fun Modifier.control(tint: Color, selected: Boolean, shape: Shape = RoundedCornerShape(6.dp)): Modifier = this
    .clip(shape)
    .background(if (selected) tint else Palette.surface, shape)
    .border(1.dp, if (selected) tint else tint.copy(alpha = 0.45f), shape)

/** A content panel: surface fill with a line edge. */
fun Modifier.panel(tint: Color = Palette.line, shape: Shape = RoundedCornerShape(8.dp)): Modifier = this
    .clip(shape)
    .background(Palette.surface, shape)
    .border(1.dp, tint.copy(alpha = 0.6f), shape)
