package com.rocketgod.mayhem.core.sat

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.rocketgod.mayhem.Diag
import com.rocketgod.mayhem.core.Geo
import com.rocketgod.mayhem.core.PacketLog
import com.rocketgod.mayhem.core.apps.AprsDecoder
import com.rocketgod.mayhem.core.ham.AptDecoder
import com.rocketgod.mayhem.core.ham.FmTap
import com.rocketgod.mayhem.core.ham.Ham
import com.rocketgod.mayhem.core.ham.HamDemod
import com.rocketgod.mayhem.core.ham.HamDigital
import com.rocketgod.mayhem.core.ham.LrptDecoder
import com.rocketgod.mayhem.core.ham.Picture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The Satellites app: the amateur and weather birds you track and listen to (with Doppler), the packet cubesats,
 * and the ORBCOMM fleet. It drives the HAM channel receiver and hangs the right decoder on it. Twin of the web
 * app's satellite views.
 */
object Sats {
    enum class View(val label: String) { TRACK("TRACK & LISTEN"), PACKET("PACKET"), ORBCOMM("ORBCOMM") }

    data class Ui(
        val view: View = View.TRACK, val sel: Int = 25544, val svc: Int = 0, val track: Boolean = false,
        val status: String = "", val passes: List<Pass> = emptyList(),
    )

    /** One packet transmitter in the PACKET list, with where it is right now. */
    data class PacketRow(val norad: Int, val hz: Long, val baud: Int, val name: String, val geoscan: Boolean, val el: Double, val hasOrbit: Boolean)

    data class OrbState(val channel: Long = ORBCOMM_CHANNELS[0], val hunt: Boolean = false, val sats: List<OrbcommSat> = emptyList(),
        val frames: Int = 0, val packets: Int = 0, val bad: Int = 0, val sel: Int = -1, val named: Map<Int, Pair<String, Double>> = emptyMap())

    data class GeoPic(val frames: Int = 0, val bad: Int = 0, val fragments: Int = 0, val high: Int = 0, val complete: Boolean = false, val bitmap: Bitmap? = null)

    private val _ui = MutableStateFlow(Ui())
    val ui: StateFlow<Ui> = _ui.asStateFlow()
    private val tles = HashMap<Int, Tle>()
    private val sgps = HashMap<Int, Sgp4?>()
    @Volatile private var tlesLoading = false

    // decoders hung on the HAM receiver
    val aprsLog = PacketLog(100)
    private val aprs = AprsDecoder(aprsLog)
    private val aprsTap = object : FmTap { override fun onFm(samples: FloatArray, n: Int, rate: Double) = aprs.onFm(samples, n, rate.toInt()) }
    val apt = AptDecoder()
    val lrpt = LrptDecoder()
    val orbcomm = OrbcommDecoder()
    val g3ruh = G3ruhDecoder()
    val geoscan = GeoscanDecoder()

    private val _orb = MutableStateFlow(OrbState())
    val orb: StateFlow<OrbState> = _orb.asStateFlow()
    private val orbOrbits = ArrayList<Pair<String, Sgp4>>()
    private val _packetRows = MutableStateFlow<List<PacketRow>>(emptyList())
    val packetRows: StateFlow<List<PacketRow>> = _packetRows.asStateFlow()
    private val _packetSel = MutableStateFlow(-1)
    val packetSel: StateFlow<Int> = _packetSel.asStateFlow()
    private val _frames = MutableStateFlow<List<PacketFrame>>(emptyList())
    val frames: StateFlow<List<PacketFrame>> = _frames.asStateFlow()
    private val _geo = MutableStateFlow(GeoPic())
    val geo: StateFlow<GeoPic> = _geo.asStateFlow()
    @Volatile private var framing = "g3ruh"
    private val packetSgps = HashMap<Int, Sgp4>()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var ticker: Job? = null

    init {
        apt.onRow = { row, i -> Picture.onApt(row, i) }
        lrpt.onStrip = { apid, line, x, px -> Picture.onLrpt(apid, line, x, px) }
        lrpt.onStats = { s ->
            Picture.lrptStatus(if (s.lock) "locked · %+.0f Hz · BER %.1f%% · RS %s · frames %d/%d".format(s.freqHz, s.ber * 100, if (s.rs < 0) "fail" else s.rs.toString(), s.frames, s.frames + s.badFrames)
                else "searching (offset %.0f Hz)".format(s.freqHz))
        }
        lrpt.onLog = { Diag.log(it) }
        orbcomm.onReport = { list ->
            val o = _orb.value
            _orb.value = o.copy(sats = list, frames = orbcomm.frames, packets = orbcomm.packets, bad = orbcomm.badPackets,
                sel = if (o.sel < 0 && list.isNotEmpty()) list[0].id else o.sel)
            orbName()
        }
        g3ruh.onFrames = { _frames.value = it }
        geoscan.onJpeg = { jpeg -> _geo.value = _geo.value.copy(bitmap = runCatching { BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) }.getOrNull() ?: _geo.value.bitmap) }
        geoscan.onStats = { _geo.value = _geo.value.copy(frames = geoscan.frames, bad = geoscan.bad, fragments = geoscan.fragments, high = geoscan.high, complete = geoscan.complete) }
    }

    // ---- lifecycle ----------------------------------------------------------------------------------------
    fun open() {
        when (_ui.value.view) {
            View.TRACK -> { loadTles(); applyService() }
            View.PACKET -> { packetLoad(); val row = _packetRows.value.firstOrNull { it.norad == _packetSel.value }; listenRow(row) }
            View.ORBCOMM -> { orbLoad(); setTaps(listOf(orbcomm)); if (Ham.state.value.mode != HamDemod.Mode.NFM) Ham.setMode(HamDemod.Mode.NFM); Ham.openSat(_orb.value.channel); orbcomm.channelHz = _orb.value.channel }
        }
        if (ticker == null) ticker = scope.launch { while (isActive) { delay(1000); tick() } }
    }

    fun close() {
        ticker?.cancel(); ticker = null
        setTaps(emptyList())
        Ham.stopPtt()
    }

    fun setView(v: View) {
        if (v == _ui.value.view) return
        Ham.stopPtt()
        _ui.value = _ui.value.copy(view = v)
        open()
    }

    private fun setTaps(taps: List<FmTap>, lrptOn: Boolean = false) {
        HamDigital.satTaps = taps
        Ham.demod.iqTaps = if (lrptOn) listOf(lrpt) else emptyList()
        HamDigital.satMute = lrptOn
    }

    // ---- TRACK & LISTEN -----------------------------------------------------------------------------------
    fun def(): SatDef = SATS.firstOrNull { it.norad == _ui.value.sel } ?: SATS[0]
    fun service(): SatService { val d = def(); return d.services[min(_ui.value.svc, d.services.size - 1)] }
    fun sgp(norad: Int): Sgp4? = sgps.getOrPut(norad) { tles[norad]?.let { runCatching { Sgp4(it) }.getOrNull() } }

    fun loadTles(force: Boolean = false) {
        if (tlesLoading || (tles.isNotEmpty() && !force)) return
        tlesLoading = true
        _ui.value = _ui.value.copy(status = "fetching TLEs…")
        scope.launch {
            runCatching { Tles.forIds(SATS.map { it.norad }) }
                .onSuccess { m -> tles.clear(); tles.putAll(m); sgps.clear(); _ui.value = _ui.value.copy(status = "${m.size} TLEs"); recomputePasses() }
                .onFailure { e -> _ui.value = _ui.value.copy(status = "TLE fetch failed: ${e.message}") }
            tlesLoading = false
        }
    }

    fun refreshTles() {
        Tles.forget()
        tles.clear(); sgps.clear()
        loadTles(true)
    }

    fun select(norad: Int) { _ui.value = _ui.value.copy(sel = norad, svc = 0, passes = emptyList()); applyService(); recomputePasses() }
    fun selectService(i: Int) { _ui.value = _ui.value.copy(svc = i); applyService() }
    fun toggleTrack() { _ui.value = _ui.value.copy(track = !_ui.value.track); if (_ui.value.track) applyService() }

    /** Put the receiver (and the decoders) into the shape the selected service needs. */
    fun applyService() {
        val svc = service()
        val mode = when (svc.kind) { SatKind.LINEAR -> HamDemod.Mode.USB; SatKind.CW -> HamDemod.Mode.CW; else -> HamDemod.Mode.NFM }
        if (Ham.state.value.mode != mode) Ham.setMode(mode)
        if (svc.kind == SatKind.APT || svc.kind == SatKind.LRPT) Ham.setHalfWidth(20_000.0)
        when (svc.kind) {
            SatKind.PACKET -> { aprs.reset(48_000); setTaps(listOf(aprsTap)) }
            SatKind.APT -> { apt.reset(); setTaps(listOf(apt)) }
            SatKind.LRPT -> { lrpt.reset(); setTaps(emptyList(), lrptOn = true) }
            else -> setTaps(emptyList())
        }
        if (svc.kind == SatKind.SSTV) HamDigital.update { it.copy(mode = HamDigital.Mode.SSTV) }
        else if (HamDigital.settings.value.mode == HamDigital.Mode.SSTV) HamDigital.update { it.copy(mode = HamDigital.Mode.OFF) }
        aprsLog.clear(); Picture.reset()
        Ham.openSat(svc.down)
    }

    fun recomputePasses() {
        val home = Geo.fix.value ?: return
        val s = sgp(_ui.value.sel) ?: return
        scope.launch { _ui.value = _ui.value.copy(passes = passes(s, home.first, home.second, System.currentTimeMillis(), 24)) }
    }

    /** Uplink frequency now (Doppler-corrected) and its tone, or null when the service is receive-only. */
    fun uplink(): Pair<Long, Double>? {
        val svc = service(); val up = svc.up ?: return null
        val home = Geo.fix.value; val s = sgp(_ui.value.sel)
        val rr = if (home != null && s != null) look(s, System.currentTimeMillis(), home.first, home.second).rangeRate else 0.0
        return dopplerUp(up, rr) to (svc.tone ?: 0.0)
    }

    private fun tick() {
        val u = _ui.value
        when (u.view) {
            View.TRACK -> {
                val home = Geo.fix.value ?: return
                val s = sgp(u.sel) ?: return
                val l = runCatching { look(s, System.currentTimeMillis(), home.first, home.second) }.getOrNull() ?: return
                val rx = doppler(service().down, l.rangeRate)
                if (u.track && l.el > -5 && abs(rx - Ham.state.value.channel) > 25 && !Ham.ptt.value.on) Ham.tune(rx)
                if (u.passes.isEmpty() || System.currentTimeMillis() > (u.passes.firstOrNull()?.los ?: 0)) recomputePasses()
            }
            View.ORBCOMM -> orbTick()
            View.PACKET -> packetRank()
        }
    }

    // ---- ORBCOMM -----------------------------------------------------------------------------------------
    private var orbHuntAt = 0L
    private var orbLastFrames = 0

    private fun orbLoad() {
        if (orbOrbits.isNotEmpty()) return
        scope.launch {
            runCatching { Tles.group("orbcomm") }.onSuccess { list ->
                for (t in list) runCatching { orbOrbits.add(t.name to Sgp4(t)) }
                Diag.log("ORBCOMM: ${orbOrbits.size} orbits loaded, for naming what is heard")
                orbName()
            }.onFailure { Diag.log("ORBCOMM: could not fetch orbits, satellites will show by identifier only") }
        }
    }

    /**
     * Names for the satellites: over the air each gives only a one-byte identifier, but it also says where it is,
     * so propagating the published orbits and seeing which one is in that spot names it — and says how far apart
     * the two answers are, an independent check that the decode is right.
     */
    private fun orbName() {
        if (orbOrbits.isEmpty()) return
        val o = _orb.value; val named = o.named.toMutableMap(); val now = System.currentTimeMillis()
        for (s in o.sats) {
            val la = s.lat ?: continue; val lo = s.lon ?: continue
            if (s.id in named) continue
            var best = ""; var bestKm = Double.MAX_VALUE
            for ((name, sg) in orbOrbits) {
                val l = runCatching { look(sg, now, 0.0, 0.0) }.getOrNull() ?: continue
                val dLat = Math.toRadians(l.lat - la); val dLon = Math.toRadians(l.lon - lo)
                val a = sin(dLat / 2).let { it * it } + cos(Math.toRadians(l.lat)) * cos(Math.toRadians(la)) * sin(dLon / 2).let { it * it }
                val km = 2 * 6371 * asin(min(1.0, sqrt(a)))
                if (km < bestKm) { bestKm = km; best = name }
            }
            if (best.isNotEmpty() && bestKm < 300) named[s.id] = best to bestKm
        }
        _orb.value = _orb.value.copy(named = named)
    }

    fun orbTune(hz: Long) {
        _orb.value = _orb.value.copy(channel = hz)
        orbcomm.channelHz = hz
        Ham.tune(hz)
    }

    fun orbHunt() { _orb.value = _orb.value.copy(hunt = !_orb.value.hunt); orbHuntAt = System.currentTimeMillis() }
    fun orbSelect(id: Int) { _orb.value = _orb.value.copy(sel = id) }

    /** Step through the channel plan while nothing decodes, and stop as soon as a frame comes in. */
    private fun orbTick() {
        val o = _orb.value
        if (o.hunt) {
            val now = System.currentTimeMillis()
            if (orbcomm.frames > orbLastFrames) { _orb.value = o.copy(hunt = false); Diag.log("ORBCOMM locked on %.4f".format(o.channel / 1e6)) }
            else if (now - orbHuntAt > 6000) {
                orbHuntAt = now
                val i = (ORBCOMM_CHANNELS.indexOf(o.channel) + 1) % ORBCOMM_CHANNELS.size
                orbTune(ORBCOMM_CHANNELS[i])
            }
        }
        orbLastFrames = orbcomm.frames
        _orb.value = _orb.value.copy(frames = orbcomm.frames, packets = orbcomm.packets, bad = orbcomm.badPackets)
    }

    // ---- PACKET ------------------------------------------------------------------------------------------
    private var packetNote = ""
    fun packetNote() = packetNote

    private fun packetLoad() {
        if (_packetRows.value.isNotEmpty()) { packetRank(); return }
        _packetRows.value = PACKET_SATS.map { PacketRow(it.norad, it.down, it.baud, it.name, false, -90.0, false) } +
            GEOSCAN_SATS.map { PacketRow(it.first, it.second, 9600, it.third, true, -90.0, false) }
        scope.launch {
            runCatching {
                val byNorad = HashMap<Int, Tle>()
                for (g in listOf("amateur", "cubesat")) for (t in Tles.group(g)) t.line1.substring(2, 7).trim().toIntOrNull()?.let { byNorad.putIfAbsent(it, t) }
                for (r in _packetRows.value) byNorad[r.norad]?.let { t -> runCatching { packetSgps[r.norad] = Sgp4(t) } }
                Diag.log("packet satellites: ${_packetRows.value.size} transmitters, ${packetSgps.size} with orbits")
            }.onFailure { packetNote = "no orbits — the list still tunes, but cannot be sorted by what is overhead" }
            packetRank()
        }
    }

    /** What is up right now, highest first. */
    private fun packetRank() {
        val home = Geo.fix.value
        val now = System.currentTimeMillis()
        val rows = _packetRows.value.map { r ->
            val s = packetSgps[r.norad]
            r.copy(el = if (home != null && s != null) runCatching { look(s, now, home.first, home.second).el }.getOrDefault(-90.0) else -90.0, hasOrbit = s != null)
        }
        _packetRows.value = if (home != null) rows.sortedWith(compareByDescending<PacketRow> { it.el }.thenBy { it.name }) else rows.sortedBy { it.name }
    }

    fun listenRow(r: PacketRow?) {
        if (r == null) { setTaps(listOf(g3ruh)); Ham.openSat(Ham.state.value.channel); return }
        _packetSel.value = r.norad
        framing = if (r.geoscan) "geoscan" else "g3ruh"
        if (Ham.state.value.mode != HamDemod.Mode.NFM) Ham.setMode(HamDemod.Mode.NFM)
        if (r.geoscan) { geoscan.reset(); _geo.value = GeoPic(); setTaps(listOf(geoscan)) }
        else { g3ruh.baud = r.baud.toDouble(); g3ruh.reset(); setTaps(listOf(g3ruh)) }
        Ham.openSat(r.hz)
        Diag.log("listening to ${r.name} on %.4f at ${r.baud} baud${if (r.geoscan) ", looking for pictures" else ""}".format(r.hz / 1e6))
    }

    fun clearFrames() { g3ruh.clear(); _frames.value = emptyList() }
}
