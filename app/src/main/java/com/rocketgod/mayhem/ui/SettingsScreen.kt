package com.rocketgod.mayhem.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import com.rocketgod.mayhem.BuildConfig
import com.rocketgod.mayhem.core.Apps
import com.rocketgod.mayhem.core.MayhemApp
import com.rocketgod.mayhem.core.NavBar
import com.rocketgod.mayhem.core.Radio
import com.rocketgod.mayhem.core.SdrEngine
import com.rocketgod.mayhem.usb.HackRfOne
import com.rocketgod.mayhem.usb.RtlSdr
import kotlinx.coroutines.delay
import com.rocketgod.mayhem.core.ham.Ham
import com.rocketgod.mayhem.core.ham.HamDemod.Mode as HamMode
import kotlin.math.roundToInt

/** Where Settings lands when it opens: the radio line under the digits asks for "radio". */
object SettingsNav {
    var jump by mutableStateOf<String?>(null)
    fun open(section: String) {
        RadioUi.open = false
        jump = section
        if (Apps.current.value != MayhemApp.SETTINGS) Apps.open(MayhemApp.SETTINGS)
    }
}

/** One searchable row of a Settings group: the words it answers to, and how it draws. */
private class SRow(val keys: String, val content: @Composable () -> Unit)

/**
 * Settings: everything that is about the radio, the bar or the app rather than the signal on screen. It opens on
 * the app it was opened from ("this app"), then the radio, and searches every row and every app's explainer. A
 * switch is a switch, a level is a slider, a choice is a segmented row; only the bias tee asks, once.
 */
@Composable
fun SettingsScreen(accent: Color) {
    val d = rememberDims()
    val ctx = LocalContext.current
    val scroll = rememberScrollState()
    val tops = remember { HashMap<String, Int>() }
    val edges = remember { floatArrayOf(0f, 0f) }   // the scroll viewport's top and bottom in the window, for drag auto-scroll
    var q by remember { mutableStateOf("") }
    val over = Apps.settingsOver()
    val multi by Apps.pagerMulti.collectAsState()
    val rdsOn by SdrEngine.rdsWanted.collectAsState()
    val hdOn by SdrEngine.hdWanted.collectAsState()
    val ham by Ham.state.collectAsState()
    val opensLast by NavBar.opensOnLast.collectAsState()
    val txOn = com.rocketgod.mayhem.core.Tx.enabled.collectAsState().value
    var how by remember { mutableStateOf<MayhemApp?>(null) }
    // Every group starts folded each time Settings opens, so the page reads as a short list of headings.
    val opened = remember { mutableStateListOf<String>() }
    LaunchedEffect(SettingsNav.jump) {
        val j = SettingsNav.jump ?: return@LaunchedEffect
        // RADIO has no body: its pill (and anything sent to it) opens the RADIO panel itself
        if (j == "radio") { SettingsNav.jump = null; RadioUi.show(); return@LaunchedEffect }
        if (j !in opened) opened.add(j)
        delay(80)
        tops[j]?.let { scroll.animateScrollTo(it) }
        SettingsNav.jump = null
    }
    val term = q.trim()
    fun hit(keys: String) = term.isEmpty() || keys.contains(term, ignoreCase = true)
    // while searching, every group with a hit is open; clearing the search puts the folds back as they were
    val folds = Folds(opened, term.isNotEmpty())

    // ---- the rows, by section ----
    val appRows = when (over) {
        MayhemApp.AUDIO -> listOf(
            SRow("rds station name radiotext fm") { SwitchRow("RDS", rdsOn, "Station name and radiotext on broadcast FM") { SdrEngine.setRds(it) } },
            SRow("hd radio digital") { SwitchRow("HD Radio", hdOn, "The digital sidebands, where a station has them") { SdrEngine.setHd(it) } },
        )
        MayhemApp.HAM -> hamRows(ham)
        MayhemApp.PAGER -> listOf(
            SRow("mode single multi hunt channels") { SegRow("Mode", listOf("0" to "SINGLE", "1" to "MULTI"), if (multi) "1" else "0") { Apps.setPagerMulti(it == "1") } },
            SRow("fold repeats duplicate") { SwitchRow("Fold repeats", PagerUi.fold) { PagerUi.fold = it } },
        )
        else -> emptyList()
    }
    // The radio's own settings live in the RADIO panel; its heading here opens it, and a search for gain lands on it.
    val radioKeys = "radio gain lna vga amp agc bias tee ppm sample rate filter"
    val barRows = listOf(
        SRow("opens on start home last") { SegRow("Opens on", listOf("home" to "HOME", "last" to "LAST APP"), if (opensLast) "last" else "home") { NavBar.setOpensOnLast(it == "last") } },
    )
    val barKeys = "bar order apps reorder drag " + NavBar.all().joinToString(" ") { it.title + " " + it.blurb }
    val lookKeys = "look skin theme colour color waterfall palette " + Skin.entries.joinToString(" ") { it.title }
    val stationKeys = "station callsign call grid license name dmr aprs ssid"
    val txKeys = "transmit tx enable license dummy load"
    val howApps = NavBar.all()
    val logKeys = "log diagnostics share save problem"
    val aboutKeys = "about version license source credits made by rocketgod pirates"

    Column(
        Modifier.fillMaxSize().onGloballyPositioned { val y = it.positionInWindow().y; edges[0] = y; edges[1] = y + it.size.height }
            .verticalScroll(scroll),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Column(Modifier.widthIn(max = 720.dp).fillMaxWidth()) {
            SearchField(q, accent) { q = it }
            Spacer(Modifier.height(d.dp(10f)))
            RadioCard(accent)
            // section shortcuts: plain pills that jump; they don't stick over the card
            val keys = buildList {
                if (over != null && appRows.isNotEmpty()) add("app" to over.title.uppercase())
                add("radio" to "RADIO"); add("bar" to "BAR"); add("look" to "LOOK"); add("station" to "STATION")
                add("transmit" to "TRANSMIT"); add("how" to "HOW IT WORKS"); add("log" to "LOG"); add("about" to "ABOUT")
            }
            val pills = rememberScrollState()
            if (term.isEmpty()) Row(Modifier.fillMaxWidth().padding(top = d.dp(10f)).scrollGlow(pills, horizontal = true).horizontalScroll(pills), horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                for ((k, l) in keys) Text(l, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1,
                    modifier = Modifier.clip(RoundedCornerShape(50)).border(1.dp, accent.copy(alpha = 0.6f), RoundedCornerShape(50))
                        .clickable { SettingsNav.jump = k }.padding(horizontal = d.dp(12f), vertical = d.dp(6f)))
            }

            if (over != null) Section("app", over.title.uppercase(), "this app", tops, folds, appRows.filter { hit(it.keys + " " + over.title) })
            if (hit(radioKeys)) SectionHead("radio", "RADIO", Radio.label.ifEmpty { null }, tops, folds, link = { RadioUi.show() }) {}

            val showBarList = hit(barKeys)
            val barShown = barRows.filter { hit(it.keys) }
            if (barShown.isNotEmpty() || showBarList) SectionHead("bar", "BAR", null, tops, folds) {
                if (barShown.isNotEmpty()) Group(barShown)
                if (showBarList) {
                    Spacer(Modifier.height(d.dp(8f)))
                    BarChecklist(accent, scroll, edges)
                    Text("Ticked apps sit in the bar along the bottom, in this order. Drag ≡ to move one.", color = Palette.muted, fontFamily = Mono,
                        fontSize = d.sp(10f), modifier = Modifier.padding(start = d.dp(4f), top = d.dp(6f)))
                }
            }

            if (hit(lookKeys)) SectionHead("look", "LOOK", null, tops, folds) { LookGroup(ctx) }
            if (hit(stationKeys)) SectionHead("station", "STATION", "for the HAM logbook, APRS and FT8", tops, folds) { StationGroup(accent) }
            if (hit(txKeys)) SectionHead("transmit", "TRANSMIT", null, tops, folds) {
                Group(listOf(SRow(txKeys) {
                    SwitchRow("Transmit", txOn, "Signal generator, Morse, OOK. Most bands need a licence; use a dummy load or a rated antenna.", tint = Palette.danger) {
                        com.rocketgod.mayhem.core.Tx.setEnabled(ctx, it)
                    }
                }))
            }

            val howShown = howApps.filter { a -> hit("how it works help " + a.title + " " + a.blurb + " " + (HOW[a]?.joinToString(" ") ?: "")) }
            val tipsShown = TIPS.filter { (k, v) -> hit("tips field notes $k $v") }
            if (howShown.isNotEmpty() || tipsShown.isNotEmpty()) SectionHead("how", "HOW IT WORKS", null, tops, folds) {
                for (cat in listOf("Receive", "Analyze", "Transmit", "Tools")) {
                    val apps = howShown.filter { it.category == cat }
                    if (apps.isEmpty()) continue
                    Text(cat.uppercase(), color = tintFor(apps.first()), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp,
                        modifier = Modifier.padding(start = d.dp(4f), top = d.dp(8f), bottom = d.dp(4f)))
                    Group(apps.map { a -> SRow(a.name) { HowRow(a, how == a, accent) { how = if (how == a) null else a } } })
                }
                if (tipsShown.isNotEmpty()) {
                    Text("TIPS", color = Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(9f), letterSpacing = 2.sp,
                        modifier = Modifier.padding(start = d.dp(4f), top = d.dp(10f), bottom = d.dp(4f)))
                    Group(tipsShown.map { (k, v) -> SRow(k) { ValueRow(k, "", v) } })
                }
            }

            if (hit(logKeys)) SectionHead("log", "LOG", null, tops, folds) {
                Group(listOf(SRow(logKeys) {
                    SRowLayout("Diagnostics log", "What the radio and decoders are doing. Share it when reporting a problem.") {
                        SmallButton("OPEN", accent) { LogUi.open = true }
                    }
                }))
            }
            if (hit(aboutKeys)) SectionHead("about", "ABOUT", null, tops, folds) { AboutGroup(accent) }
            Spacer(Modifier.height(d.dp(16f)))
        }
    }
}

// ---------------------------------------------------------------- the radio card

@Composable
private fun RadioCard(accent: Color) {
    val d = rememberDims()
    val radio by Radio.kind.collectAsState()
    val lo by SdrEngine.freqHz.collectAsState()
    val offset by SdrEngine.offsetHz.collectAsState()
    val level by SdrEngine.levelDb.collectAsState()
    val agc by SdrEngine.agc.collectAsState()
    val lna by SdrEngine.radioLna.collectAsState()
    val vga by SdrEngine.radioVga.collectAsState()
    val amp by SdrEngine.radioAmp.collectAsState()
    val bias by SdrEngine.biasTee.collectAsState()
    val muted by SdrEngine.muted.collectAsState()
    val up = radio != Radio.Kind.NONE && RadioStatus.connected
    val rtl = radio == Radio.Kind.RTLSDR
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape)
            .background(Brush.radialGradient(listOf(accent.copy(alpha = 0.20f), Color.Transparent), radius = 900f, center = androidx.compose.ui.geometry.Offset(2000f, 0f)))
            .background(Palette.surface.copy(alpha = 0.92f)).border(1.dp, Palette.line, shape).padding(d.dp(12f)),
        verticalArrangement = Arrangement.spacedBy(d.dp(10f))
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
            Box(Modifier.size(8.dp).background(if (up) Palette.ok else Palette.danger, CircleShape))
            Text(if (up) Radio.label.uppercase() else "NO RADIO", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f),
                letterSpacing = 1.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (rtl && RtlSdr.tuner.isNotEmpty()) Badge(RtlSdr.tuner)
        }
        if (up) Row(Modifier.fillMaxWidth()) {
            Stat("TUNED", "%.3f".format((lo + offset) / 1e6), Modifier.weight(1f))
            Stat("RATE", "%.2f Msps".format(SdrEngine.currentRate() / 1e6), Modifier.weight(1f))
            Stat("GAIN", if (agc) "AGC" else if (rtl) "$vga dB" else "$lna/$vga dB", Modifier.weight(1f))
        }
        if (up) LevelBar(level, accent, Modifier.fillMaxWidth().height(d.dp(5f)))
        val badges = buildList {
            if (rtl && RtlSdr.hfReady) add("HF READY" to true)
            if (bias) add("BIAS-T ON" to true)
            if (!rtl && up && amp) add("AMP +14" to true)
            if (muted) add("MUTED" to true)
        }
        if (badges.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) { for ((b, hot) in badges) Badge(b, hot) }
        if (RadioStatus.text.isNotBlank()) Text(RadioStatus.text, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), maxLines = 2)
    }
}

@Composable
private fun Stat(label: String, value: String, modifier: Modifier) {
    val d = rememberDims()
    Column(modifier) {
        Text(label, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 2.sp)
        Text(value, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 1)
    }
}

@Composable
private fun Badge(text: String, hot: Boolean = false) {
    val d = rememberDims()
    val c = if (hot) Palette.accent2 else Palette.muted
    Text(text, color = c, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 1.sp, maxLines = 1,
        modifier = Modifier.border(1.dp, if (hot) c else Palette.line, RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 3.dp))
}

// ---------------------------------------------------------------- RADIO: the connected radio's own settings

/** The RADIO panel: open over whatever is running, which keeps receiving underneath. */
object RadioUi {
    var open by mutableStateOf(false)
    /** Open it; Settings closes first (it is an app here, so leaving it goes back to what it was open over). */
    fun show() {
        if (Apps.current.value == MayhemApp.SETTINGS) Apps.back()
        open = true
    }
}

/**
 * Everything the connected radio can be told besides frequency, in one place apart from Settings. Each radio lists
 * what it really has ([Radio.Caps]), and only those controls are drawn: a HackRF gets LNA, VGA, the amp, antenna power
 * and the baseband filter; an RTL-SDR gets its tuner gain, the tuner's and the RTL's AGCs, the bias tee, crystal
 * correction and, on an R820T, direct sampling. Every control applies to the radio at once.
 */
@Composable
fun RadioPanel() {
    val d = rememberDims()
    // RADIO is red all through (title, headings, switches, sliders, pickers), so it never reads as the general Settings
    val red = Palette.danger
    val radio by Radio.kind.collectAsState()
    val agc by SdrEngine.agc.collectAsState()
    val lna by SdrEngine.radioLna.collectAsState()
    val vga by SdrEngine.radioVga.collectAsState()
    val amp by SdrEngine.radioAmp.collectAsState()
    val bias by SdrEngine.biasTee.collectAsState()
    val tunerAgc by SdrEngine.tunerAgc.collectAsState()
    val rtlAgc by SdrEngine.rtlAgc.collectAsState()
    val ppm by SdrEngine.ppm.collectAsState()
    val ds by SdrEngine.directSampling.collectAsState()
    val bb by SdrEngine.bbFilterHz.collectAsState()
    val rate by SdrEngine.rateHz.collectAsState()
    // the driver's status line changes once bring-up has named the board or tuner, which is when the caps are known
    @Suppress("UNUSED_VARIABLE") val status = RadioStatus.text
    val over = Apps.playing()
    val caps = Radio.caps
    val rtl = radio == Radio.Kind.RTLSDR
    var askBias by remember { mutableStateOf(false) }
    if (askBias) BiasTeeDialog(red, caps?.biasVolts ?: 4.5, if (rtl) "RTL-SDR" else "HackRF",
        onConfirm = { NavBar.acceptBias(); SdrEngine.setBiasTee(true); askBias = false }, onCancel = { askBias = false })
    // Bias tee pushes DC out the antenna port, so it is off by default and the first enable asks first.
    fun toggleBias(on: Boolean) { if (!on) SdrEngine.setBiasTee(false) else if (NavBar.biasOk) SdrEngine.setBiasTee(true) else askBias = true }

    // an opaque sheet over the app: nothing under it takes a touch while it is open
    // a red edge and a faint red wash on the sheet; the heading strip a shade stronger
    CompositionLocalProvider(LocalRadioRed provides true) {
    Column(Modifier.fillMaxSize().background(lerp(Palette.paper, red, 0.07f)).border(1.dp, red)
        .pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent() } }) {
        Row(Modifier.fillMaxWidth().background(lerp(Palette.surface, red, 0.14f)).padding(horizontal = d.dp(8f), vertical = d.dp(8f)), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(10f))) {
            Text("RADIO", color = red, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(14f), letterSpacing = 3.sp)
            Text(if (over != null) "· ${barLabel(over)}" else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(11f), letterSpacing = 2.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            SmallButton("DONE", red) { RadioUi.open = false }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(lerp(Palette.line, red, 0.45f)))
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
            Column(Modifier.widthIn(max = 720.dp).fillMaxWidth().padding(top = d.dp(10f), bottom = d.dp(16f))) {
                if (caps == null) PanelCard("NO RADIO", "Plug in a HackRF, a PortaPack in HackRF mode, or an RTL-SDR to see what it can be set to.", false)
                else {
                    val sub = if (rtl) "${RtlSdr.label} · tuner ${RtlSdr.tuner.ifEmpty { "?" }}"
                              else HackRfOne.boardLabel.ifEmpty { "HackRF" } + if (HackRfOne.firmware.isNotEmpty()) " · fw ${HackRfOne.firmware}" else ""
                    PanelCard(if (rtl) "RTL-SDR" else "HACKRF", sub, true)

                    val gain = buildList {
                        add(SRow("agc") { SwitchRow("AGC", agc, "The app keeps the level right by stepping the gain${if (caps.stagedGain) " (VGA first, then LNA)" else ""}. Moving a gain by hand turns it off.") { SdrEngine.setAgc(it) } })
                        if (caps.stagedGain) {
                            add(SRow("lna") { SliderRow("LNA", lna, 0, SdrEngine.LNA_MAX, SdrEngine.LNA_STEP, "dB · 0–40 in 8s", auto = agc) { SdrEngine.setRadioLna(it) } })
                            add(SRow("vga") { SliderRow("VGA", vga, 0, SdrEngine.VGA_MAX, SdrEngine.VGA_STEP, "dB · 0–62 in 2s", auto = agc) { SdrEngine.setRadioVga(it) } })
                        }
                        if (caps.tunerGain) add(SRow("tuner gain") {
                            SliderRow("Tuner gain", minOf(48, vga), 0, 48, SdrEngine.VGA_STEP, "dB · 0–${RtlSdr.MAX_GAIN_DB}", auto = agc || tunerAgc,
                                autoText = if (tunerAgc) "TUNER AGC" else "AUTO") { SdrEngine.setRadioVga(it) }
                        })
                        if (caps.amp) add(SRow("amp") { SwitchRow("Amp", amp, "The +14 dB front-end amplifier. Strong local signals can overload it.") { if (it != amp) SdrEngine.toggleRadioAmp() } })
                        if (caps.tunerAgc) add(SRow("tuner agc") { SwitchRow("Tuner AGC", tunerAgc, "The R82xx tuner's own automatic gain, in place of the app's") { SdrEngine.setTunerAgc(it) } })
                        if (caps.rtlAgc) add(SRow("rtl agc") { SwitchRow("RTL AGC", rtlAgc, "The RTL2832U's digital AGC, which evens out the level after the converter") { SdrEngine.setRtlAgc(it) } })
                    }
                    val front = buildList {
                        if (caps.biasT) add(SRow("bias") { SwitchRow(if (rtl) "Bias tee" else "Antenna power", bias, "${caps.biasVolts} V DC out the antenna port, for an inline LNA. Off at every connect.") { toggleBias(it) } })
                        if (caps.bbFilters.isNotEmpty()) add(SRow("bb") {
                            PickRow("Baseband filter", if (bb > 0) "Set by hand" else "AUTO follows the sample rate: ${mhzText(HackRfOne.bbFilterRoundDownLt(rate))} now",
                                listOf(0 to "AUTO") + caps.bbFilters.map { it to mhzText(it) }, bb, red) { SdrEngine.setBbFilter(it) }
                        })
                    }
                    val rates = (Radio.RATE_CHOICES.filter { Radio.canSample(Radio.limits, it) } + rate).distinct().sortedDescending()
                    val samp = buildList {
                        add(SRow("rate") { PickRow("Sample rate", "Each app opens at its own rate. A change here lasts until you open another app.", rates.map { it to mspsText(it) }, rate, red) { SdrEngine.setRate(it) } })
                        if (caps.ppm) add(SRow("ppm") { PpmRow(ppm, red) })
                        if (caps.directSampling) add(SRow("ds") { SwitchRow("Direct sampling", ds, "HF below 24 MHz read straight off the ADC (Q branch). Off, the dongle stops at 24 MHz.") { SdrEngine.setDirectSampling(it) } })
                    }
                    PanelSection("GAIN", gain)
                    PanelSection("FRONT END", front)
                    PanelSection("SAMPLING", samp)
                    if (rtl) Text("No offset tuning: R82xx tuners have no offset mode (librtlsdr refuses it for them too).", color = Palette.muted, fontFamily = Mono,
                        fontSize = d.sp(10f), lineHeight = d.sp(15f), modifier = Modifier.padding(start = d.dp(4f), end = d.dp(4f), top = d.dp(12f)))
                }
            }
        }
    }
    }
}

private fun mhzText(hz: Int) = "%.3f".format(java.util.Locale.US, hz / 1e6).trimEnd('0').trimEnd('.') + " MHz"
private fun mspsText(hz: Int) = "%.3f".format(java.util.Locale.US, hz / 1e6).trimEnd('0').trimEnd('.') + " Msps"

@Composable
private fun PanelCard(title: String, sub: String, on: Boolean) {
    val d = rememberDims()
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.fillMaxWidth().clip(shape).background(lerp(Palette.surface, Palette.danger, 0.05f)).border(1.dp, lerp(Palette.line, Palette.danger, 0.22f), shape).padding(d.dp(12f)),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(8f))) {
        Box(Modifier.size(8.dp).background(if (on) Palette.ok else Palette.danger, CircleShape))
        Column(Modifier.weight(1f)) {
            Text(title, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), letterSpacing = 1.sp, maxLines = 1)
            Text(sub, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(14f))
        }
    }
}

@Composable
private fun PanelSection(title: String, rows: List<SRow>) {
    if (rows.isEmpty()) return
    val d = rememberDims()
    Text(title, color = rowAccent(), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f), letterSpacing = 3.sp,
        modifier = Modifier.padding(start = d.dp(4f), top = d.dp(16f), bottom = d.dp(6f)))
    Group(rows)
}

/** A choice from a list: the current one on the right, the rest in a menu under it. */
@Composable
private fun PickRow(label: String, desc: String?, options: List<Pair<Int, String>>, selected: Int, accent: Color, onPick: (Int) -> Unit) {
    val d = rememberDims()
    var open by remember { mutableStateOf(false) }
    SRowLayout(label, desc) {
        Box {
            Text((options.firstOrNull { it.first == selected }?.second ?: "") + "  ▾", color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold,
                fontSize = d.sp(11f), maxLines = 1, softWrap = false,
                modifier = Modifier.clip(RoundedCornerShape(6.dp)).border(1.dp, accent.copy(alpha = 0.7f), RoundedCornerShape(6.dp)).clickable { open = true }
                    .padding(horizontal = d.dp(12f), vertical = d.dp(7f)))
            androidx.compose.material3.DropdownMenu(open, onDismissRequest = { open = false }, modifier = Modifier.background(Palette.surface)) {
                for ((v, l) in options) androidx.compose.material3.DropdownMenuItem(
                    text = { Text(l, color = if (v == selected) accent else Palette.ink, fontFamily = Mono, fontWeight = if (v == selected) FontWeight.Bold else FontWeight.Medium, fontSize = d.sp(12f)) },
                    onClick = { open = false; if (v != selected) onPick(v) })
            }
        }
    }
}

/** An RTL-SDR's crystal correction: − and + a part per million at a time, or typed. */
@Composable
private fun PpmRow(ppm: Int, accent: Color) {
    val d = rememberDims()
    var txt by remember(ppm) { mutableStateOf(ppm.toString()) }
    SRowLayout("Frequency correction", "Crystal error in parts per million. Remembered on this device.") {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            SmallButton("−", accent) { SdrEngine.setPpm(ppm - 1) }
            BasicTextField(txt, { v ->
                    val f = v.filterIndexed { i, c -> c.isDigit() || (i == 0 && c == '-') }.take(4)
                    txt = f
                    f.toIntOrNull()?.let { SdrEngine.setPpm(it) }
                }, singleLine = true, cursorBrush = SolidColor(accent),
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Number),
                textStyle = TextStyle(color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), textAlign = TextAlign.Center),
                modifier = Modifier.width(d.dp(56f)).clip(RoundedCornerShape(6.dp)).border(1.dp, Palette.line, RoundedCornerShape(6.dp)).padding(vertical = d.dp(7f)))
            SmallButton("+", accent) { SdrEngine.setPpm(ppm + 1) }
        }
    }
}

// ---------------------------------------------------------------- building blocks

@Composable
private fun SearchField(value: String, accent: Color, onChange: (String) -> Unit) {
    val d = rememberDims()
    Box(Modifier.fillMaxWidth().height(d.dp(42f)).clip(RoundedCornerShape(8.dp)).background(Palette.surface).border(1.dp, Palette.line, RoundedCornerShape(8.dp))
        .padding(horizontal = d.dp(12f)), contentAlignment = Alignment.CenterStart) {
        if (value.isEmpty()) Text("Search settings and apps", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(13f))
        BasicTextField(value, onChange, singleLine = true, cursorBrush = SolidColor(accent),
            textStyle = TextStyle(color = Palette.ink, fontFamily = Mono, fontSize = d.sp(13f)), modifier = Modifier.fillMaxWidth())
    }
}

/** Which Settings groups are open: the ones tapped open this visit, or every one with a hit while searching. */
private class Folds(val opened: MutableList<String>, val searching: Boolean) {
    fun isOpen(key: String) = searching || key in opened
    fun flip(key: String) { if (key in opened) opened.remove(key) else opened.add(key) }
}

/** True inside the RADIO panel, which is red all through so it never reads as the general Settings. */
private val LocalRadioRed = staticCompositionLocalOf { false }

/** The accent a row's switch, slider or choice takes: the theme's, or red in the RADIO panel. */
@Composable
private fun rowAccent(): Color = if (LocalRadioRed.current) Palette.danger else Palette.accent

/** A section title with its rows; nothing at all when a search leaves it empty. */
@Composable
private fun Section(key: String, title: String, sub: String?, tops: HashMap<String, Int>, folds: Folds, rows: List<SRow>) {
    if (rows.isEmpty()) return
    SectionHead(key, title, sub, tops, folds) { Group(rows) }
}

/**
 * One group as an accordion card: the heading row always shown, the body sliding open and shut beneath it. A [link]
 * group has no body: it stays folded and its heading opens what it names (RADIO opens the RADIO panel).
 */
@Composable
private fun SectionHead(key: String, title: String, sub: String?, tops: HashMap<String, Int>, folds: Folds, link: (() -> Unit)? = null,
                        content: @Composable ColumnScope.() -> Unit) {
    val d = rememberDims()
    val open = link == null && folds.isOpen(key)
    val shape = RoundedCornerShape(14.dp)
    val edge by animateColorAsState(if (open) lerp(Palette.line, Palette.accent, 0.45f) else Palette.line, label = "setEdge")
    val turn by animateFloatAsState(if (open) 0f else -90f, label = "setChevron")
    Column(Modifier.fillMaxWidth().onGloballyPositioned { tops[key] = it.positionInParent().y.roundToInt() }.padding(top = d.dp(8f))) {
        Column(Modifier.fillMaxWidth().clip(shape).background(Palette.surface).border(1.dp, edge, shape)) {
            Row(Modifier.fillMaxWidth().clickable { if (link != null) link() else folds.flip(key) }.padding(horizontal = d.dp(16f), vertical = d.dp(14f)),
                verticalAlignment = Alignment.CenterVertically) {
                Text(title, color = Palette.accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 3.sp)
                Text(if (sub != null) "  ·  $sub" else "", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1,
                    overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                val tint = Palette.accent
                androidx.compose.foundation.Canvas(Modifier.size(d.dp(12f)).graphicsLayer { rotationZ = turn }) {
                    val w = size.width; val h = size.height; val sw = 2.dp.toPx()
                    drawLine(tint, androidx.compose.ui.geometry.Offset(w * 0.15f, h * 0.35f), androidx.compose.ui.geometry.Offset(w * 0.5f, h * 0.7f), sw, StrokeCap.Round)
                    drawLine(tint, androidx.compose.ui.geometry.Offset(w * 0.5f, h * 0.7f), androidx.compose.ui.geometry.Offset(w * 0.85f, h * 0.35f), sw, StrokeCap.Round)
                }
            }
            AnimatedVisibility(open, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
                Column(Modifier.fillMaxWidth().padding(start = d.dp(10f), end = d.dp(10f), bottom = d.dp(10f))) { content() }
            }
        }
    }
}

@Composable
private fun Group(rows: List<SRow>) {
    val shape = RoundedCornerShape(12.dp)
    val red = LocalRadioRed.current
    // in RADIO the rows take a faint red wash and edge
    val bg = if (red) lerp(Palette.surface, Palette.danger, 0.05f) else Palette.surface
    val line = if (red) lerp(Palette.line, Palette.danger, 0.22f) else Palette.line
    Column(Modifier.fillMaxWidth().clip(shape).background(bg).border(1.dp, line, shape)) {
        rows.forEachIndexed { i, r ->
            if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(line))
            r.content()
        }
    }
}

@Composable
private fun SRowLayout(label: String, desc: String? = null, dim: Boolean = false, control: @Composable () -> Unit) {
    val d = rememberDims()
    Row(Modifier.fillMaxWidth().heightIn(min = d.dp(52f)).padding(horizontal = d.dp(14f), vertical = d.dp(8f)),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(d.dp(12f))) {
        Column(Modifier.weight(1f).alpha(if (dim) 0.5f else 1f)) {
            Text(label, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Medium, fontSize = d.sp(13f))
            if (!desc.isNullOrBlank()) Text(desc, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(14f), modifier = Modifier.padding(top = 2.dp))
        }
        control()
    }
}

/** HAM's fine controls: the filter's exact edges (or width), the passband shift, the CW pitch and the volume. */
private fun hamRows(s: Ham.State): List<SRow> {
    val rows = ArrayList<SRow>()
    if (s.mode == HamMode.USB || s.mode == HamMode.LSB) {
        rows += SRow("filter low edge passband hz") { SliderRow("Filter low edge", s.pbLo.roundToInt(), 0, 5000, 50, "Hz", false) { Ham.setPassband(it.toDouble(), Ham.state.value.pbHi.coerceIn(it + 100.0, 6000.0)) } }
        rows += SRow("filter high edge passband hz") { SliderRow("Filter high edge", s.pbHi.roundToInt(), (s.pbLo.roundToInt() + 100).coerceAtMost(6000), 6000, 50, "Hz", false) { Ham.setPassband(Ham.state.value.pbLo, it.toDouble()) } }
        rows += SRow("passband shift ibs") { SliderRow("Passband shift", s.shift.roundToInt(), -600, 600, 50, "Hz", false) { Ham.setShift(it.toDouble()) } }
    } else {
        val (lo, hi, step) = when (s.mode) {
            HamMode.CW -> Triple(50, 2000, 50); HamMode.AM -> Triple(1500, 12_000, 500); HamMode.NFM -> Triple(2500, 25_000, 500); else -> Triple(25_000, 100_000, 5000)
        }
        rows += SRow("filter width bandwidth hz") { SliderRow("Filter width", s.width.roundToInt().coerceIn(lo, hi), lo, hi, step, "Hz", false) { Ham.setWidth(it.toDouble()) } }
    }
    if (s.mode == HamMode.CW) rows += SRow("cw pitch tone") {
        SegRow("CW pitch", listOf(500, 600, 700, 800).map { "$it" to "$it" }, s.pitch.roundToInt().toString()) { Ham.setPitch(it.toDouble()) }
    }
    rows += SRow("volume loudness") { SliderRow("Volume", (s.volume * 100).roundToInt(), 0, 200, 5, "%", false) { Ham.setVolume(it / 100f) } }
    return rows
}

@Composable
private fun SwitchRow(label: String, on: Boolean, desc: String? = null, tint: Color = rowAccent(), onChange: (Boolean) -> Unit) {
    SRowLayout(label, desc) {
        Switch(on, onChange, colors = SwitchDefaults.colors(
            checkedThumbColor = inkOn(tint), checkedTrackColor = tint, checkedBorderColor = tint,
            uncheckedThumbColor = Palette.ink, uncheckedTrackColor = Palette.line, uncheckedBorderColor = Palette.line))
    }
}

@Composable
private fun ValueRow(label: String, value: String, desc: String? = null) {
    val d = rememberDims()
    SRowLayout(label, desc) { if (value.isNotEmpty()) Text(value, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(12f), maxLines = 1) }
}

@Composable
private fun SegRow(label: String, options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    SRowLayout(label) { Seg(options, selected, onSelect) }
}

@Composable
private fun Seg(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    val d = rememberDims()
    val shape = RoundedCornerShape(6.dp)
    val tint = rowAccent()
    Row(Modifier.clip(shape).border(1.dp, Palette.line, shape)) {
        for ((v, l) in options) {
            val on = v == selected
            Box(Modifier.background(if (on) tint else Color.Transparent).clickable { onSelect(v) }
                .padding(horizontal = d.dp(11f), vertical = d.dp(7f)), contentAlignment = Alignment.Center) {
                Text(l, color = if (on) inkOn(tint) else Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1)
            }
        }
    }
}

/** A level: its value on the right, the slider under it. Under AGC it reads AUTO; moving it takes the gain back by hand. */
@Composable
private fun SliderRow(label: String, value: Int, min: Int, max: Int, step: Int, unit: String, auto: Boolean, autoText: String = "AUTO", onChange: (Int) -> Unit) {
    val d = rememberDims()
    var dragging by remember { mutableStateOf<Float?>(null) }
    val shown = dragging?.roundToInt() ?: value
    val tint = rowAccent()
    Column(Modifier.fillMaxWidth().padding(horizontal = d.dp(14f), vertical = d.dp(8f))) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Medium, fontSize = d.sp(13f), modifier = Modifier.weight(1f).alpha(if (auto) 0.5f else 1f))
            Text(if (auto && dragging == null) autoText else "$shown $unit", color = if (auto && dragging == null) Palette.accent2 else Palette.ink, fontFamily = Mono, fontSize = d.sp(12f))
        }
        Slider(
            value = (dragging ?: value.toFloat()).coerceIn(min.toFloat(), max.toFloat()),
            onValueChange = { dragging = ((it / step).roundToInt() * step).toFloat() },
            onValueChangeFinished = { dragging?.let { onChange(it.roundToInt()) }; dragging = null },
            valueRange = min.toFloat()..max.toFloat(),
            steps = ((max - min) / step - 1).coerceAtLeast(0),
            colors = SliderDefaults.colors(thumbColor = tint, activeTrackColor = if (auto) Palette.muted else tint,
                inactiveTrackColor = Palette.line, activeTickColor = Color.Transparent, inactiveTickColor = Color.Transparent),
            modifier = Modifier.alpha(if (auto) 0.6f else 1f)
        )
    }
}

@Composable
private fun SmallButton(label: String, accent: Color, onClick: () -> Unit) {
    val d = rememberDims()
    Text(label, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f),
        modifier = Modifier.clip(RoundedCornerShape(6.dp)).border(1.dp, accent.copy(alpha = 0.7f), RoundedCornerShape(6.dp)).clickable { onClick() }
            .padding(horizontal = d.dp(12f), vertical = d.dp(7f)))
}

// ---------------------------------------------------------------- the bar: tick to include, drag ≡ to order

@Composable
private fun BarChecklist(accent: Color, scroll: ScrollState, edges: FloatArray) {
    val d = rememberDims()
    val order by NavBar.order.collectAsState()
    val checked by NavBar.checked.collectAsState()
    val orderNow by rememberUpdatedState(order)
    val rowH = d.dp(56f)
    val slotPx = with(LocalDensity.current) { rowH.toPx() }
    var dragIndex by remember { mutableIntStateOf(-1) }
    var dragBy by remember { mutableFloatStateOf(0f) }
    var fingerY by remember { mutableFloatStateOf(0f) }
    val target = if (dragIndex < 0) -1 else (dragIndex + (dragBy / slotPx).roundToInt()).coerceIn(0, order.lastIndex)
    // while a row is held near the top or bottom of the screen, the page scrolls under it and the row stays put
    LaunchedEffect(dragIndex) {
        if (dragIndex < 0) return@LaunchedEffect
        while (true) {
            withFrameNanos { }
            val step = when {
                fingerY < edges[0] + slotPx -> -12f
                fingerY > edges[1] - slotPx -> 12f
                else -> 0f
            }
            if (step != 0f) dragBy += scroll.dispatchRawDelta(step)
        }
    }
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(Palette.surface).border(1.dp, Palette.line, shape)) {
        order.forEachIndexed { i, app -> key(app) {
            val on = app in checked
            val dragging = i == dragIndex
            val room = when {
                dragIndex < 0 || dragging -> 0f
                dragIndex < target && i > dragIndex && i <= target -> -slotPx
                dragIndex > target && i < dragIndex && i >= target -> slotPx
                else -> 0f
            }
            val shiftY by animateFloatAsState(room, label = "barRoom")
            val tint = tintFor(app)
            var handleTop by remember { mutableFloatStateOf(0f) }
            Row(
                Modifier.fillMaxWidth().height(rowH).zIndex(if (dragging) 1f else 0f)
                    .graphicsLayer { translationY = if (dragging) dragBy else shiftY; shadowElevation = if (dragging) 16f else 0f }
                    .background(if (dragging) Palette.panel else Palette.surface),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(Modifier.size(rowH).clickable { NavBar.toggle(app) }, contentAlignment = Alignment.Center) {
                    Box(Modifier.size(d.dp(22f)).clip(RoundedCornerShape(6.dp)).background(if (on) tint else Color.Transparent)
                        .border(2.dp, if (on) tint else Palette.muted, RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) {
                        if (on) Text("✓", color = inkOn(tint), fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f))
                    }
                }
                Column(Modifier.weight(1f).clickable { NavBar.toggle(app) }) {
                    Text(app.title.uppercase(), color = if (on) tint else Palette.muted, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(13f), maxLines = 1)
                    Text(app.blurb, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Box(
                    Modifier.size(rowH).onGloballyPositioned { if (dragIndex < 0) handleTop = it.positionInWindow().y }
                        .pointerInput(app) {
                            var startY = 0f
                            detectDragGestures(
                                onDragStart = { off -> dragIndex = orderNow.indexOf(app); dragBy = 0f; startY = handleTop + off.y; fingerY = startY },
                                onDragEnd = {
                                    val from = dragIndex; val to = (from + (dragBy / slotPx).roundToInt()).coerceIn(0, orderNow.lastIndex)
                                    dragIndex = -1; dragBy = 0f
                                    if (from >= 0 && to != from) NavBar.move(from, to)
                                },
                                onDragCancel = { dragIndex = -1; dragBy = 0f },
                                onDrag = { change, amount -> change.consume(); dragBy += amount.y; fingerY += amount.y }
                            )
                        },
                    contentAlignment = Alignment.Center
                ) { Text("≡", color = Palette.muted, fontSize = d.sp(22f)) }
            }
            if (i < order.lastIndex) Box(Modifier.fillMaxWidth().height(1.dp).background(Palette.line))
        } }
    }
}

// ---------------------------------------------------------------- look, station, about

@Composable
private fun LookGroup(ctx: android.content.Context) {
    val d = rememberDims()
    val cols = if (d.wide) 4 else 2
    Column(Modifier.fillMaxWidth()) {
        for (rowSkins in Skin.entries.chunked(cols)) {
            Row(Modifier.fillMaxWidth().padding(bottom = d.gap), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
                for (skin in rowSkins) SkinCard(skin, skin == Skins.current, Modifier.weight(1f)) { Skins.set(ctx, skin) }
                repeat(cols - rowSkins.size) { Box(Modifier.weight(1f)) }
            }
        }
        Text("WATERFALL", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 2.sp, modifier = Modifier.padding(start = d.dp(4f), top = d.dp(6f), bottom = d.dp(4f)))
        Group(WfPalette.entries.map { p ->
            SRow(p.title) {
                val on = Waterfalls.palette == p
                val lut = remember(p, Palette.paper, Palette.accent, Palette.accent2) { Waterfalls.lut(p, Palette.paper, Palette.accent, Palette.accent2) }
                Row(Modifier.fillMaxWidth().clickable { Waterfalls.set(ctx, p) }.heightIn(min = d.dp(48f)).padding(horizontal = d.dp(14f)),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text(p.title, color = if (on) Palette.accent else Palette.ink, fontFamily = Mono, fontWeight = if (on) FontWeight.Bold else FontWeight.Medium, fontSize = d.sp(12f), modifier = Modifier.weight(1f))
                    androidx.compose.foundation.Canvas(Modifier.size(width = d.dp(110f), height = d.dp(14f)).clip(RoundedCornerShape(3.dp))) {
                        val n = 64
                        for (i in 0 until n) drawRect(Color(lut[i * 255 / (n - 1)]), androidx.compose.ui.geometry.Offset(size.width * i / n, 0f), androidx.compose.ui.geometry.Size(size.width / n + 1f, size.height))
                    }
                    Spacer(Modifier.width(d.dp(10f)))
                    Text(if (on) "●" else "○", color = if (on) Palette.accent else Palette.muted, fontFamily = Mono, fontSize = d.sp(12f))
                }
            }
        })
    }
}

@Composable
private fun StationGroup(accent: Color) {
    val d = rememberDims()
    val st = com.rocketgod.mayhem.core.Station.info.collectAsState().value
    val gpsGrid = com.rocketgod.mayhem.core.Geo.fix.collectAsState().value?.let { com.rocketgod.mayhem.core.ham.latLonToGrid(it.first, it.second) }
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(Palette.surface).border(1.dp, Palette.line, shape).padding(d.dp(10f))) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            LogField(st.call, "callsign", accent, Modifier.weight(1f), caps = true) { v -> com.rocketgod.mayhem.core.Station.update { it.copy(call = v.uppercase().trim()) } }
            LogField(st.license, "license class", accent, Modifier.weight(1f)) { v -> com.rocketgod.mayhem.core.Station.update { it.copy(license = v) } }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            LogField(st.name, "name", accent, Modifier.weight(1f)) { v -> com.rocketgod.mayhem.core.Station.update { it.copy(name = v) } }
            LogField(st.grid, gpsGrid?.let { "grid · $it from GPS" } ?: "grid square, e.g. DM04og", accent, Modifier.weight(1f), caps = true) { v -> com.rocketgod.mayhem.core.Station.update { it.copy(grid = v.trim()) } }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(d.gap)) {
            LogField(st.dmrId, "DMR ID (radioid.net)", accent, Modifier.weight(1f)) { v -> com.rocketgod.mayhem.core.Station.update { it.copy(dmrId = v.filter { c -> c.isDigit() }) } }
            LogField(st.aprsSsid, "APRS SSID (9 = mobile)", accent, Modifier.weight(1f)) { v -> com.rocketgod.mayhem.core.Station.update { it.copy(aprsSsid = v.filter { c -> c.isDigit() }.take(2)) } }
        }
        Text("Goes into the ADIF log (STATION_CALLSIGN, MY_GRIDSQUARE) and the logbook's distance and bearing. Nothing is sent anywhere else.",
            color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9.5f), modifier = Modifier.padding(top = d.dp(6f)))
    }
}

@Composable
private fun AboutGroup(accent: Color) {
    val d = rememberDims()
    Group(listOf(
        SRow("version") { ValueRow("Mayhem Mobile", "v${BuildConfig.VERSION_NAME}", "build ${BuildConfig.GIT_SHA} · ${BuildConfig.VERSION_CODE}") },
        SRow("web app") { LinkRow("Web app", "Same build in Chrome or Edge, over WebUSB", "https://rocketgod-git.github.io/mayhem-mobile") },
        SRow("source") { LinkRow("Source", "github.com/RocketGod-git/mayhem-mobile", "https://github.com/RocketGod-git/mayhem-mobile") },
        SRow("upstream") { LinkRow("Upstream", "github.com/portapack-mayhem/mayhem-firmware", "https://github.com/portapack-mayhem/mayhem-firmware") },
        SRow("license") { ValueRow("License", "GPL-3.0", "Mayhem-derived") },
        SRow("made by rocketgod") { LinkRow("Made by", "RocketGod · RocketGod.dev", "https://rocketgod.dev") },
        SRow("crew pirates") { LinkRow("Crew", "The Pirates' Plunder · discord.gg/thepirates", "https://discord.gg/thepirates") },
    ))
    Text("CREDITS · who wrote what this app is built from · drag to steer", color = Palette.muted, fontFamily = Mono, fontSize = d.sp(9f), letterSpacing = 2.sp,
        modifier = Modifier.padding(start = d.dp(4f), top = d.dp(12f), bottom = d.dp(6f)))
    CreditsRoll(accent)
}

@Composable
private fun LinkRow(label: String, value: String, url: String) {
    val d = rememberDims()
    val uri = LocalUriHandler.current
    Row(Modifier.fillMaxWidth().clickable { runCatching { uri.openUri(url) } }.heightIn(min = d.dp(52f)).padding(horizontal = d.dp(14f), vertical = d.dp(8f)),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Medium, fontSize = d.sp(13f))
            Text(value, color = Palette.accent, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text("↗", color = Palette.muted, fontSize = d.sp(14f))
    }
}

// ---------------------------------------------------------------- how it works

/** What each app does, where it listens, and a tip. Shown in Settings › How it works, and searched. */
private val HOW: Map<MayhemApp, List<String>> = mapOf(
    MayhemApp.AUDIO to listOf("A general receiver: broadcast FM with RDS station names, airband AM, narrow FM, and SSB or CW.", "88–108 FM · 118–137 air · anywhere the radio reaches", "Tap the waterfall or a band chip to tune; ☆ saves a station to FAVES. RDS and HD Radio switch on here."),
    MayhemApp.HAM to listOf("Amateur radio: FM simplex and repeaters on 2 m and 70 cm, SSB and CW on HF, digital modes and a logbook.", "144–148 · 420–450 · HF below 30 MHz", "HF needs a HackRF, or an RTL-SDR Blog V3 or V4L."),
    MayhemApp.DEVICES to listOf("Decodes the short bursts household gadgets send — weather stations, doorbells, tire sensors, meters, remotes — from the rtl_433 device library.", "433.92 · 315 · 868 · 915 MHz", "Readings repeat every minute or so; leave it listening."),
    MayhemApp.SAT to listOf("Tracks what is overhead, follows each pass's Doppler shift, and decodes what the satellite sends.", "145.800 ISS · 137 MHz · 437 MHz cubesats", "Passes last 5–15 minutes; an outdoor antenna helps."),
    MayhemApp.ADSB to listOf("Aircraft broadcast their position, altitude and speed every second; Mayhem lists them and puts them on the map.", "1090 MHz", "Range is line of sight: a window or the roof makes the difference."),
    MayhemApp.AIS to listOf("Ships report their name, position, course and speed.", "161.975 and 162.025 MHz", "Anywhere near a coast, river or lake with traffic."),
    MayhemApp.APRS to listOf("Amateur packet radio: positions, weather stations and short messages.", "144.390 North America · 144.800 Europe", ""),
    MayhemApp.PAGER to listOf("Decodes pager networks: FLEX at 1600, 3200 and 6400 and POCSAG at 512, 1200 and 2400. MULTI decodes up to four channels across the span at once; tap a channel to stay on it.", "929–932 MHz in the US · varies by country", "Tune to your country's pager band; MULTI finds the carriers itself."),
    MayhemApp.ERT to listOf("Utility meters, three ways at once: Itron ERT meters (SCM, SCM+, IDM) with their readings, the hopping smart-meter mesh networks (each learned by its sync word, every transmitter on its own live card with its hop clock), and Landis+Gyr Gridstream meters with their IDs, uptime and position.", "902–928 MHz", "A HackRF watches 19.2 MHz at once; an RTL-SDR 2 MHz, and the presets move it across the band."),
    MayhemApp.LORA to listOf("LoRa across the band at once: Meshtastic (decrypted on the default channels: names, positions, telemetry, text), MeshCore (adverts with names and positions, public channel messages) and LoRaWAN (device addresses, frame counters), plus any other LoRa as raw frames.", "902–928 MHz", "A HackRF watches 20 MHz at once; an RTL-SDR one channel at a time."),
    MayhemApp.BTLE to listOf("Bluetooth Low Energy advertising: the beacons phones, trackers and wearables send.", "2.402 · 2.426 · 2.480 GHz", "Needs a HackRF: 2.4 GHz is above an RTL-SDR's range."),
    MayhemApp.TPMS to listOf("Tire pressure sensors: each wheel reports its pressure and temperature.", "315 MHz US · 433.92 MHz EU", "Walk or drive past parked cars."),
    MayhemApp.ACARS to listOf("Text messages between aircraft and their airline: position reports, weather, maintenance.", "131.550 US · 131.525 / 131.725 EU · 131.450 JP", ""),
    MayhemApp.TRAINS to listOf("The railroad's radios, receive only. EOT · HOT decodes the end-of-train units (brake pipe pressure, motion, marker light, battery) and spots the head unit's commands to them; PTC 220 watches the train-control network: base stations, wayside units (and when their status changes) and locomotives. BOTH takes turns.", "457.9375 EOT · 452.9375 HOT · 457.925 DPU · 217–222 MHz PTC", "A rear unit reports about once a minute and on every brake change; a locomotive on PTC means a train is close. A HackRF hears both EOT channels or all of PTC at once."),
    MayhemApp.SUBGHZ to listOf("rtl_433-style decoding with every protocol running at once; mute the families you don't want.", "300–928 MHz", ""),
    MayhemApp.PROWL to listOf("Hunts across the bands for live voice and stops on it.", "the bands you choose", "Good for finding what is busy near you."),
    MayhemApp.LOOKING_GLASS to listOf("Sweeps a range far wider than one view to show what is active across it.", "any range the radio reaches", "A HackRF sweeps hundreds of MHz at a time."),
    MayhemApp.SEARCH to listOf("Steps through a range and lists the frequencies that come alive; tap one to listen.", "any range", ""),
    MayhemApp.CAPTURE to listOf("Records raw IQ to a file, with a .txt sidecar, to replay or study later in SDR#, GNU Radio or similar.", "any frequency · up to the radio's sample rate", "2 Msps of 8-bit IQ is about 4 MB a second."),
    MayhemApp.TRANSMIT to listOf("Signal generator, Morse, OOK and replay. Transmitting is your responsibility: use a band you are licensed for, or a dummy load.", "a HackRF's range, 1 MHz–6 GHz", "Needs a HackRF. Leaving the app stops the transmission."),
    MayhemApp.TROLL to listOf("Novelty transmitters, jingles and cart sounds.", "a HackRF's range", "Needs a HackRF. Sideload build only."),
)

/** The field notes: the things people ask about. */
private val TIPS = listOf(
    "Plugging in" to "The app opens by itself when a HackRF or an RTL-SDR is plugged in; allow the USB prompt once and tick 'always'.",
    "Nothing happens" to "Check the phone's OTG switch — OnePlus, OPPO and realme turn it off after ten idle minutes — and that the cable carries data.",
    "RTL-SDR" to "Receive only, up to 1.766 GHz and 2.4 Msps. Below 24 MHz only on an RTL-SDR Blog V3 or V4L; transmit and Bluetooth need a HackRF.",
    "Power" to "A HackRF Pro can draw more than a phone's OTG port supplies — use a powered OTG hub if the log shows all-zero IQ.",
    "Faves" to "Tap ☆ beside the digits to keep a frequency; FAVES in the top bar brings it back in its own app, as it was heard.",
    "Tuning" to "Drag the digits up or down, tap ⌨ to type a frequency, or press the waterfall and slide; the radio retunes when you lift.",
    "Mute" to "MUTE in the top bar silences Mayhem from any screen; the phone's volume buttons set how loud.",
    "Gain" to "AGC sets the gain for you. To set it by hand, tap RADIO in the top bar from any app: gain, bias tee and everything else the radio can do.",
    "Floating window" to "Press home while an app is open and it keeps going in a small window with the waterfall and what it is hearing.",
    "Maps" to "ADS-B, AIS and APRS plot on OpenStreetMap; each map follows the traffic until you drag, and ⌖ re-arms it.",
    "Squelch and scan" to "Squelch gates audio against a tracked noise floor; SCAN in Audio hops your FAVES and holds where the squelch opens.",
    "Captures" to "Capture records signed 8-bit IQ with a .txt sidecar; share both to SDR#, GNU Radio or a drive.",
)

@Composable
private fun HowRow(app: MayhemApp, open: Boolean, accent: Color, onToggle: () -> Unit) {
    val d = rememberDims()
    val tint = tintFor(app)
    val (what, where, tip) = HOW[app] ?: listOf("", "", "")
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().clickable { onToggle() }.heightIn(min = d.dp(48f)).padding(horizontal = d.dp(14f)), verticalAlignment = Alignment.CenterVertically) {
            Text(app.title.uppercase(), color = tint, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(12f), modifier = Modifier.width(d.dp(110f)), maxLines = 1)
            Text(app.blurb, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(if (open) "▴" else "▾", color = Palette.muted, fontSize = d.sp(12f), modifier = Modifier.padding(start = d.dp(6f)))
        }
        if (open) Column(Modifier.fillMaxWidth().padding(start = d.dp(14f), end = d.dp(14f), bottom = d.dp(12f)), verticalArrangement = Arrangement.spacedBy(d.dp(6f))) {
            Text(what, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(11f), lineHeight = d.sp(16f))
            Row(horizontalArrangement = Arrangement.spacedBy(d.dp(6f))) {
                if (where.isNotEmpty()) Badge(where)
                val needs = app == MayhemApp.BTLE || app == MayhemApp.TRANSMIT || app == MayhemApp.TROLL
                Badge(if (needs) "NEEDS A HACKRF" else "RTL-SDR OR HACKRF", hot = needs)
            }
            if (tip.isNotEmpty()) Text(tip, color = Palette.muted, fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(15f))
            SmallButton("OPEN ${app.title.uppercase()}", accent) {
                if (Radio.blockedBecause(app).isEmpty()) Apps.open(app)
                else Notice.msg.value = "${app.title}: ${Radio.blockedBecause(app)}"
            }
        }
    }
}

// ---------------------------------------------------------------- kept from the old Settings

@Composable
private fun SkinCard(skin: Skin, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val d = rememberDims()
    Column(
        modifier.clip(RoundedCornerShape(8.dp)).background(skin.paper)
            .border(if (selected) 2.dp else 1.dp, if (selected) skin.accent else skin.line, RoundedCornerShape(8.dp))
            .clickable { onClick() }.padding(d.dp(10f))
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(skin.title, color = skin.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), maxLines = 1)
            if (selected) Text("●", color = skin.accent, fontFamily = Mono, fontSize = d.sp(11f))
        }
        Row(Modifier.fillMaxWidth().padding(top = d.dp(8f)), horizontalArrangement = Arrangement.spacedBy(d.dp(4f))) {
            for (c in listOf(skin.surface, skin.panel, skin.line, skin.muted, skin.accent, skin.accent2))
                Box(Modifier.weight(1f).height(d.dp(14f)).clip(RoundedCornerShape(3.dp)).background(c))
        }
        Box(Modifier.fillMaxWidth().padding(top = d.dp(8f)).clip(RoundedCornerShape(4.dp)).background(skin.surface)
            .border(1.dp, skin.accent.copy(alpha = 0.5f), RoundedCornerShape(4.dp)).padding(vertical = d.dp(5f)), contentAlignment = Alignment.Center) {
            Text("92.3000 MHz", color = skin.accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(10f))
        }
    }
}

/** Rolling credits, PortaPack style: Mayhem's contributor lists plus the authors of every file we ported.
 *  The list is rendered twice back-to-back and the auto-scroll snaps back to 0 when it crosses the first copy's
 *  height — an endless loop with no pause. Drag or fling to steer; the loop resumes as soon as you let go. */
@Composable
private fun CreditsRoll(accent: Color) {
    val d = rememberDims()
    val scroll = rememberScrollState()
    var listHeightPx by remember { mutableStateOf(0) }
    LaunchedEffect(scroll, listHeightPx) {
        while (true) {
            if (!scroll.isScrollInProgress) {
                val max = scroll.maxValue
                if (listHeightPx > 0 && scroll.value >= listHeightPx) {
                    scroll.scrollTo(scroll.value - listHeightPx)
                } else if (max > 0 && scroll.value < max) {
                    scroll.scrollBy(1f)
                }
            }
            delay(28)
        }
    }
    Column(Modifier.fillMaxWidth().height(d.dp(240f)).panel().padding(horizontal = d.dp(12f)).verticalScroll(scroll)) {
        for (copy in 0 until 2) {
            Column(Modifier.fillMaxWidth().onGloballyPositioned { if (copy == 0) listHeightPx = it.size.height }) {
                for ((head, text) in Credits.lines) {
                    if (head) Text(text, color = accent, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f), letterSpacing = 2.sp,
                        modifier = Modifier.fillMaxWidth().padding(top = d.dp(14f), bottom = d.dp(4f)), textAlign = TextAlign.Center)
                    else Text(text, color = Palette.ink, fontFamily = Mono, fontSize = d.sp(10f), lineHeight = d.sp(14f),
                        modifier = Modifier.fillMaxWidth().padding(vertical = d.dp(2f)), textAlign = TextAlign.Center)
                }
                Box(Modifier.height(d.dp(28f)))
            }
        }
    }
}
