package com.rocketgod.mayhem.core

import android.content.Context
import com.rocketgod.mayhem.core.apps.AcarsDecoder
import com.rocketgod.mayhem.core.apps.AcarsPlane
import com.rocketgod.mayhem.core.apps.AcarsPlanes
import com.rocketgod.mayhem.core.apps.AisDecoder
import com.rocketgod.mayhem.core.apps.AprsDecoder
import com.rocketgod.mayhem.core.apps.BleDevice
import com.rocketgod.mayhem.core.apps.BlePos
import com.rocketgod.mayhem.core.apps.BleTracker
import com.rocketgod.mayhem.core.apps.BtleDecoder
import com.rocketgod.mayhem.core.apps.ErtDecoder
import com.rocketgod.mayhem.core.apps.IqRecorder
import com.rocketgod.mayhem.core.apps.MeshDecoder
import com.rocketgod.mayhem.core.apps.MetersProcessor
import com.rocketgod.mayhem.core.apps.PagerDecoder
import com.rocketgod.mayhem.core.apps.SweepProcessor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

/** The app menu — Mayhem's launcher grid, HackRF-DSP apps only (no games, no PortaPack-hardware apps). */
enum class MayhemApp(val title: String, val blurb: String, val category: String) {
    HAM("HAM", "SSB · CW · repeaters", "Receive"),
    AUDIO("Audio", "WFM · NFM · AM · SSB", "Receive"),
    HD("HD Radio", "station data · art · traffic", "Receive"),
    DEVICES("Devices", "keys, remotes, TPMS", "Receive"),
    SAT("Satellites", "track and decode", "Receive"),
    ADSB("ADS-B", "aircraft, 1090 MHz", "Receive"),
    UAT("UAT", "weather & small planes", "Receive"),
    AIS("AIS", "ships, 162 MHz", "Receive"),
    APRS("APRS", "packet, 144.39 MHz", "Receive"),
    PAGER("Pagers", "FLEX · POCSAG pagers", "Receive"),
    ERT("Meters", "ERT · Gridstream · 802.15.4g", "Receive"),
    LORA("LoRa", "Meshtastic, MeshCore", "Receive"),
    BTLE("BLE RX", "advertising, 2.4 GHz", "Receive"),
    VDL2("VDL2", "VDL Mode 2 messages, 136.975 MHz", "Receive"),
    ACARS("ACARS", "messages, 131 MHz", "Receive"),
    TRAINS("Trains", "EOT · PTC telemetry", "Receive"),
    FLEET("Fleet", "P25 · DMR trunking", "Receive"),
    CELL("Cell", "LTE alerts · cell info", "Receive"),
    ATSC("ATSC TV", "digital TV channels, guide, pictures", "Receive"),
    SONDES("Sondes", "weather balloons", "Receive"),
    PROWL("Prowl", "hunts live voice", "Receive"),
    SPECTRUM("Spectrum", "analyzer, zero span", "Analyze"),
    ANALYZER("Analyzer", "bursts to bits", "Analyze"),
    LOOKING_GLASS("Looking Glass", "wideband sweep", "Analyze"),
    SEARCH("Search", "find active channels", "Analyze"),
    CAPTURE("Capture", "record raw IQ", "Tools"),
    TRANSMIT("Transmit", "OOK · morse · replay", "Transmit"),
    TROLL("Troll", "novelty transmitters", "Transmit"),
    SETTINGS("Settings", "theme · about", "Tools");

    companion object {
        /** An app by its saved name; Sub-GHz and TPMS are part of Devices now, so a bookmark, bar or last app saved with
         *  either opens Devices. */
        fun byName(name: String): MayhemApp? = if (name == "SUBGHZ" || name == "TPMS") DEVICES else entries.firstOrNull { it.name == name }
    }
}

/** Wires each app to its engine configuration and baseband processor (Mayhem's receiver_model per app). */
object Apps {
    val pagerLog = PacketLog(); val pager = PagerDecoder(pagerLog)
    val hunter = com.rocketgod.mayhem.core.pager.PagerHunter()
    /** The pager app's mode: false = the single tuned-channel decoder, true = the multi-channel span hunter. */
    private val _pagerMulti = MutableStateFlow(true)
    val pagerMulti: StateFlow<Boolean> = _pagerMulti.asStateFlow()
    fun setPagerMulti(on: Boolean) {
        if (_pagerMulti.value == on) return
        _pagerMulti.value = on
        // the mode is switched from Settings now, opened over the pager: reconfigure it underneath, don't leave Settings
        if (_current.value == MayhemApp.PAGER || (_current.value == MayhemApp.SETTINGS && under == MayhemApp.PAGER)) startPager()
    }
    private fun startPager() {
        val r = SdrEngine.IQ_RATE
        if (_pagerMulti.value) {
            // the hunter decodes every carrier in view: where the radio can take 3.84 Msps the span covers the whole
            // US pager band (929.0-932.0 MHz) from its middle, instead of half of it at 2 Msps
            if (Radio.canSample(Radio.limits, 3_840_000)) SdrEngine.configure(SdrEngine.Mode.NONE, 930_500_000L, 3_840_000, 32, 40, true, hunter)
            else SdrEngine.configure(SdrEngine.Mode.NONE, 929_612_500L, r, 32, 40, true, hunter)
            com.rocketgod.mayhem.core.pager.PagerEngine.start()
        } else {
            com.rocketgod.mayhem.core.pager.PagerEngine.stop()
            SdrEngine.configure(SdrEngine.Mode.NFM, 929_612_500L, r, 32, 32, false, pager)
        }
    }
    /** AIS and APRS: how far above the channel the radio sits, clear of the DC spike at the center of the span. */
    const val NARROW_SHIFT = 250_000L
    val aisLog = PacketLog(); val ais = AisDecoder(aisLog)
    val aprsLog = PacketLog(); val aprs = AprsDecoder(aprsLog)
    /** Meters: ERT and the mesh networks on the same samples, into one log (the app keeps ERT's name in settings). */
    val metersLog = PacketLog(); val ert = ErtDecoder(metersLog); val mesh = MeshDecoder(metersLog)
    val meters = MetersProcessor(ert, mesh)
    /** LoRa: Meshtastic, MeshCore, LoRaWAN and any other LoRa across one wide span. */
    val loraLog = PacketLog(); val lora = com.rocketgod.mayhem.core.lora.LoraHub(loraLog)
    val btleLog = PacketLog(); val btle = BtleDecoder(btleLog)
    /** BLE RX's devices: one per advertiser, fed the whole PDU of every good packet. Read through [bleDevices]. */
    private val bleTracker = BleTracker()
    private val _bleTick = MutableStateFlow(0L)
    /** Bumped with each advertisement, so the screen knows to look again. */
    val bleTick: StateFlow<Long> = _bleTick.asStateFlow()
    /** Where you are, for the tracker alert's 500 m rule: only a fix the app already has (location already allowed). */
    @Volatile var blePos: BlePos? = null
    /** The devices as of now (copies, safe to read while packets keep arriving): alerted first, then first heard. */
    fun bleDevices(): List<BleDevice> = synchronized(bleTracker) { bleTracker.list().map { it.snapshot() } }
    fun bleClear() { synchronized(bleTracker) { bleTracker.clear() }; btleLog.clear(); _bleTick.value++ }
    val acarsLog = PacketLog(); val acars = AcarsDecoder(acarsLog)
    /** ACARS's aircraft: every decoded line grouped by registration (else flight). Read through [acarsPlaneList]. */
    private val acarsPlanes = AcarsPlanes()
    private val _acarsTick = MutableStateFlow(0L)
    val acarsTick: StateFlow<Long> = _acarsTick.asStateFlow()
    fun acarsPlaneList(): List<AcarsPlane> = synchronized(acarsPlanes) { acarsPlanes.list().map { it.snapshot() } }
    fun acarsClear() { synchronized(acarsPlanes) { acarsPlanes.clear(); acarsStats.clear() }; acarsLog.clear(); _acarsTick.value++ }
    /** Messages a minute, by channel, kind and airline (ACARS's STATS view). */
    private val acarsStats = com.rocketgod.mayhem.core.apps.AcarsStats()
    fun acarsStatsSnap(): com.rocketgod.mayhem.core.apps.AcarsStats = synchronized(acarsPlanes) { acarsStats.snapshot() }
    /** An airport by ICAO ident from the bundled list (once it has loaded), for the message readers and the map. */
    val airportLookup: com.rocketgod.mayhem.core.apps.AirportLookup = { id ->
        com.rocketgod.mayhem.core.uat.Airports[id]?.let { com.rocketgod.mayhem.core.apps.AcarsAirport(id, it.lat, it.lon, it.name) }
    }
    private fun countMsg(stats: com.rocketgod.mayhem.core.apps.AcarsStats, m: com.rocketgod.mayhem.core.apps.AcarsMsg, p: AcarsPlane?) {
        if (m.label == "SQ") return
        val kind = com.rocketgod.mayhem.core.apps.msgInsight(m).kind
        stats.add(m.ms, m.mhz, kind, com.rocketgod.mayhem.core.apps.airlineOf(p?.flight ?: m.flight), p?.key ?: "")
    }
    /** VDL2: VDL Mode 2 on every channel from 136.10 to 136.975; its ACARS messages grouped like ACARS's, apart from them. */
    val vdl2Log = PacketLog(); val vdl2 = com.rocketgod.mayhem.core.apps.Vdl2Decoder(vdl2Log)
    private val vdl2Planes = AcarsPlanes()
    private val _vdl2Tick = MutableStateFlow(0L)
    val vdl2Tick: StateFlow<Long> = _vdl2Tick.asStateFlow()
    fun vdl2PlaneList(): List<AcarsPlane> = synchronized(vdl2Planes) { vdl2Planes.list().map { it.snapshot() } }
    fun vdl2Clear() { synchronized(vdl2Planes) { vdl2Planes.clear(); vdl2Stats.clear(); vdl2Tracker.clear() }; vdl2Log.clear(); _vdl2Tick.value++ }
    private val vdl2Stats = com.rocketgod.mayhem.core.apps.AcarsStats()
    /** VDL2's every aircraft and ground station, by their AVLC addresses (ACARS or not). Guarded by vdl2Planes. */
    private val vdl2Tracker = com.rocketgod.mayhem.core.apps.Vdl2Tracker(airportLookup)
    fun vdl2StatsSnap(): com.rocketgod.mayhem.core.apps.AcarsStats = synchronized(vdl2Planes) { vdl2Stats.snapshot() }
    fun vdl2Aircraft(): List<com.rocketgod.mayhem.core.apps.VdlAircraft> = synchronized(vdl2Planes) { vdl2Tracker.list().map { it.snapshot() } }
    fun vdl2Stations(): List<com.rocketgod.mayhem.core.apps.VdlStation> = synchronized(vdl2Planes) { vdl2Tracker.stationList().map { it.snapshot() } }
    fun vdl2Chans(): Map<Long, Int> = synchronized(vdl2Planes) { LinkedHashMap(vdl2Tracker.chans) }
    /** An aircraft ADS-B should open on (ACARS's ADS-B button): ADS-B keeps what it has heard instead of starting clean. */
    @Volatile var adsbPick: String? = null
    init {
        btle.onAdv = { pdu, db, ch ->
            val a = com.rocketgod.mayhem.core.apps.parseAdv(pdu, db, ch)
            if (a != null) { synchronized(bleTracker) { bleTracker.add(a, System.currentTimeMillis(), blePos) }; _bleTick.value++ }
        }
        acarsLog.onAdd = { line ->
            val m = com.rocketgod.mayhem.core.apps.parseAcarsLine(line, System.currentTimeMillis())
            if (m != null) { synchronized(acarsPlanes) { val p = acarsPlanes.add(m); countMsg(acarsStats, m, p) }; _acarsTick.value++ }
        }
        vdl2Log.onAdd = { line ->
            val m = com.rocketgod.mayhem.core.apps.parseAcarsLine(line, System.currentTimeMillis())
            if (m != null) { synchronized(vdl2Planes) { val p = vdl2Planes.add(m); countMsg(vdl2Stats, m, p) }; _vdl2Tick.value++ }
        }
        // every frame, ACARS or not: the aircraft and ground stations by address (the decoder's lines are unchanged)
        vdl2.onFrame = { f -> synchronized(vdl2Planes) { vdl2Tracker.add(f, System.currentTimeMillis()) }; _vdl2Tick.value++ }
    }
    /** Trains: end-of-train / head-of-train telemetry, or the PTC network; BOTH takes turns between them. */
    val trainsLog = PacketLog(); val trains = com.rocketgod.mayhem.core.trains.TrainsProcessor(trainsLog)
    // it opens on BOTH, starting where the traffic is: PTC beacons every few seconds, a rear unit only with a train
    private val _trainsBand = MutableStateFlow(com.rocketgod.mayhem.core.trains.TrainsProcessor.Band.PTC)
    val trainsBand: StateFlow<com.rocketgod.mayhem.core.trains.TrainsProcessor.Band> = _trainsBand.asStateFlow()
    private val _trainsAuto = MutableStateFlow(true)
    val trainsAuto: StateFlow<Boolean> = _trainsAuto.asStateFlow()
    fun setTrainsBand(b: com.rocketgod.mayhem.core.trains.TrainsProcessor.Band, keepAuto: Boolean = false) {
        if (!keepAuto) _trainsAuto.value = false
        _trainsBand.value = b
        if (playing() == MayhemApp.TRAINS) startTrains()
    }
    /** Whether Trains shows the waterfall, once chosen; null: by screen size (a phone leaves it out for the cards). */
    private val _trainsWaterfall = MutableStateFlow<Boolean?>(null)
    val trainsWaterfall: StateFlow<Boolean?> = _trainsWaterfall.asStateFlow()
    fun setTrainsWaterfall(on: Boolean) { _trainsWaterfall.value = on }
    /** The apps whose waterfall can be put away (BLE, ADS-B, Meters, LoRa, ACARS): the choice, once made. */
    private val _waterfalls = MutableStateFlow<Map<MayhemApp, Boolean>>(emptyMap())
    val waterfalls: StateFlow<Map<MayhemApp, Boolean>> = _waterfalls.asStateFlow()
    fun setWaterfall(app: MayhemApp, on: Boolean) { _waterfalls.value = _waterfalls.value + (app to on) }
    fun setTrainsAuto() { _trainsAuto.value = true; if (playing() == MayhemApp.TRAINS) startTrains() }
    private fun startTrains() {
        val t = com.rocketgod.mayhem.core.trains.TrainsProcessor
        val b = _trainsBand.value
        trains.band = b
        trains.centerOf = { SdrEngine.freqHz.value }
        // as wide as the band needs where the radio can (both EOT channels, or all of 216-222.5 MHz); else the channels
        // heard most, from 2 MHz
        if (b == com.rocketgod.mayhem.core.trains.TrainsProcessor.Band.EOT) {
            if (Radio.canSample(Radio.limits, t.EOT_RATE)) SdrEngine.configure(SdrEngine.Mode.NONE, t.EOT_CENTER, t.EOT_RATE, 32, 40, true, trains)
            else SdrEngine.configure(SdrEngine.Mode.NONE, t.EOT_NARROW, 2_000_000, 32, 40, true, trains)
        } else {
            if (Radio.canSample(Radio.limits, t.PTC_RATE)) SdrEngine.configure(SdrEngine.Mode.NONE, t.PTC_CENTER, t.PTC_RATE, 32, 40, true, trains)
            else SdrEngine.configure(SdrEngine.Mode.NONE, t.PTC_NARROW, 2_000_000, 32, 40, true, trains)
        }
    }
    /** Fleet: P25 and DMR trunked systems from their control channels, every carrier in the span at once. */
    val fleetLog = PacketLog(); val fleet = com.rocketgod.mayhem.core.fleet.FleetProcessor(fleetLog)
    /** AUTO or one band id from [com.rocketgod.mayhem.core.fleet.FleetProcessor.BANDS]. */
    private val _fleetBand = MutableStateFlow("AUTO")
    val fleetBand: StateFlow<String> = _fleetBand.asStateFlow()
    private val _fleetSpan = MutableStateFlow(8_000_000)
    val fleetSpan: StateFlow<Int> = _fleetSpan.asStateFlow()
    /** The scan: the centers it steps through, the one tuned, when it moves on, and whether a system holds it there. */
    data class FleetScan(val windows: List<com.rocketgod.mayhem.core.fleet.FleetProcessor.Window> = emptyList(), val idx: Int = 0, val dwellEnd: Long = 0L, val found: Boolean = false)
    private val _fleetScan = MutableStateFlow(FleetScan())
    val fleetScan: StateFlow<FleetScan> = _fleetScan.asStateFlow()
    /** The sample rate Fleet asks for: the chosen span where the radio takes it, else as wide as it goes up to 2.4 MHz. */
    fun fleetRate(): Int {
        val want = _fleetSpan.value
        if (Radio.canSample(Radio.limits, want)) return want
        return if (Radio.canSample(Radio.limits, 2_400_000)) 2_400_000 else 2_000_000
    }
    private fun fleetRestart(now: Long, tuneNow: Boolean) {
        val w = com.rocketgod.mayhem.core.fleet.FleetProcessor.windows(_fleetBand.value, fleetRate())
        _fleetScan.value = FleetScan(w, 0, now + 6_000, false)
        if (tuneNow && w.isNotEmpty()) SdrEngine.tune(w[0].hz)
    }
    fun setFleetBand(b: String) { _fleetBand.value = b; if (playing() == MayhemApp.FLEET) fleetRestart(System.currentTimeMillis(), true) }
    fun setFleetSpan(r: Int) {
        _fleetSpan.value = r
        if (playing() != MayhemApp.FLEET) return
        SdrEngine.setRate(fleetRate()); fleetRestart(System.currentTimeMillis(), true)
    }
    /** The receiver's own position, for the DMR unit reports. */
    fun fleetRef(p: Pair<Double, Double>?) { if (p != null) fleet.setRef(p.first, p.second) }
    /**
     * One step of the scan, every half second while the screen is up: six seconds a window; a window where a control
     * channel decodes keeps the radio for 25.
     */
    fun fleetTick(now: Long) {
        val sc = _fleetScan.value
        if (sc.windows.size < 2 || playing() != MayhemApp.FLEET) return
        val s = fleet.snap.value
        val live = s != null && s.carriers.any { (it.role == "control" || it.role == "rest") && it.hz > s.spanLo && it.hz < s.spanHi && now - it.lastDecodeMs < 5_000 }
        var next = sc
        if (live && !next.found) next = next.copy(found = true, dwellEnd = now + 25_000)
        if (now >= next.dwellEnd) {
            val i = (next.idx + 1) % next.windows.size
            next = next.copy(idx = i, found = false, dwellEnd = now + 6_000)
            SdrEngine.tune(next.windows[i].hz)
        }
        _fleetScan.value = next
    }
    private fun startFleet() {
        fleet.centerOf = { SdrEngine.freqHz.value }
        fleetRef(Geo.fix.value ?: Geo.lastKnownPos() ?: Geo.zoneGuess())
        val w = com.rocketgod.mayhem.core.fleet.FleetProcessor.windows(_fleetBand.value, fleetRate())
        SdrEngine.configure(SdrEngine.Mode.NONE, w[0].hz, fleetRate(), 32, 40, true, fleet)
        fleetRestart(System.currentTimeMillis(), false)
    }
    /** Cell: LTE system information and emergency alerts (SI-RNTI only). What it heard is kept in [cellFile]. */
    val cellLog = PacketLog(); val cell = com.rocketgod.mayhem.core.cell.CellProcessor(cellLog)
    @Volatile var cellFile: File? = null
    /** AUTO or one band id from [com.rocketgod.mayhem.core.cell.CELL_BANDS]. */
    private val _cellBand = MutableStateFlow("AUTO")
    val cellBand: StateFlow<String> = _cellBand.asStateFlow()
    /** The scan: survey a band in windows, visit each carrier found, dwell for its SI cycle; or stay on one carrier. */
    data class CellScan(val phase: String = "survey", val bandIdx: Int = 0, val windows: List<Long> = emptyList(), val wi: Int = 0,
                        val cands: List<com.rocketgod.mayhem.core.cell.CarrierGuess> = emptyList(), val ci: Int = 0, val until: Long = 0, val tunedMs: Long = 0, val stayHz: Long = 0)
    private val _cellScan = MutableStateFlow(CellScan())
    val cellScan: StateFlow<CellScan> = _cellScan.asStateFlow()
    private var cellProfile: com.rocketgod.mayhem.core.cell.Profile? = null
    @Volatile private var cellRestored = false
    @Volatile private var cellSaved = -1
    private var cellSaver: java.util.Timer? = null
    fun cellRtl() = Radio.kind.value == Radio.Kind.RTLSDR
    /** 15.36 MS/s holds a whole 10 or 15 MHz carrier; a radio that can't sample it gets the central 1.08 MHz at 1.92. */
    fun cellRate(): Int = if (Radio.canSample(Radio.limits, 15_360_000)) 15_360_000 else 1_920_000
    /** The bands the scan walks: every one the radio tunes on AUTO, else the one chosen. */
    fun cellBands(): List<com.rocketgod.mayhem.core.cell.BandPreset> {
        val all = com.rocketgod.mayhem.core.cell.CELL_BANDS
        if (_cellBand.value != "AUTO") return all.filter { it.id == _cellBand.value }
        return all.filter { it.lo >= Radio.limits.minHz && it.hi <= Radio.limits.maxHz }.ifEmpty { all }
    }
    private fun cellSurvey(first: Boolean = false, bandIdx: Int = _cellScan.value.bandIdx) {
        val bands = cellBands(); val b = bands[bandIdx % bands.size]; val use = 0.8 * cellRate()
        val n = maxOf(1, Math.ceil((b.hi - b.lo) / use).toInt())
        val w = (0 until n).map { i -> Math.round(if (n == 1) (b.lo + b.hi) / 2.0 else b.lo + use / 2 + i * ((b.hi - b.lo - use) / (n - 1))) }
        cellProfile = com.rocketgod.mayhem.core.cell.newProfile(b.lo, b.hi)
        _cellScan.value = CellScan("survey", bandIdx % bands.size, w)
        if (!first) cellGo(w[0], 700)
    }
    private fun cellGo(hz: Long, ms: Long) {
        val now = System.currentTimeMillis()
        _cellScan.value = _cellScan.value.copy(until = now + ms, tunedMs = now)
        SdrEngine.tune(hz)
    }
    private fun cellNextBand() { cellSurvey(bandIdx = (_cellScan.value.bandIdx + 1) % cellBands().size) }
    private fun cellNextCandidate() {
        val sc = _cellScan.value; val ci = sc.ci + 1
        if (ci >= sc.cands.size) { if (_cellBand.value == "AUTO") cellNextBand() else cellSurvey(); return }
        _cellScan.value = sc.copy(phase = "visit", ci = ci)
        cellGo(sc.cands[ci].centerHz, 1600)
    }
    /** One step of the scan, every 300 ms while the screen is up. */
    fun cellTick(now: Long) {
        if (playing() != MayhemApp.CELL) return
        val sc = _cellScan.value; val s = cell.snap.value; val freq = SdrEngine.freqHz.value
        val here = if (s != null && s.centerHz == freq && s.lastBlockMs > sc.tunedMs) s else null
        when (sc.phase) {
            "survey" -> {
                val p = cellProfile; val hp = here?.profile
                if (hp != null && p != null) com.rocketgod.mayhem.core.cell.stitch(p, hp.lo, hp.step, hp.db)
                if (now >= sc.until && (here != null || now - sc.tunedMs > 3000)) {
                    val wi = sc.wi + 1
                    if (wi < sc.windows.size) { _cellScan.value = sc.copy(wi = wi); cellGo(sc.windows[wi], 700) }
                    else {
                        val b = cellBands()[sc.bandIdx % cellBands().size]
                        // exact centers first: the LTE carriers other cells list in SIB5, and cells already heard here
                        val exact = s?.cells.orEmpty().flatMap { c -> c.neighbors?.inter.orEmpty().mapNotNull { f -> f.mhz?.let { Math.round(it * 1e6) } } } + s?.cells.orEmpty().map { it.hz }
                        val cands = com.rocketgod.mayhem.core.cell.scanCandidates(b.lo, b.hi, if (p != null) com.rocketgod.mayhem.core.cell.findCarriers(p) else emptyList(), exact)
                        if (cands.isEmpty()) { if (_cellBand.value == "AUTO") cellNextBand() else cellSurvey() }
                        else { _cellScan.value = sc.copy(wi = wi, cands = cands, ci = -1); cellNextCandidate() }
                    }
                }
            }
            "visit" -> {
                // a cell found up to 300 kHz off the tuned center counts: retune to its own center and read it there
                val near = here?.cells?.firstOrNull { kotlin.math.abs(it.hz - freq) <= 300_000 && it.mib != null && now - it.mibMs < 3000 }
                if (near != null && near.hz != freq) cellGo(near.hz, 2500)
                else if (near != null) _cellScan.value = sc.copy(phase = "dwell", until = now + if (cellRate() < 15_360_000) 2500 else 13_000)
                else if (now >= sc.until && (here != null || now - sc.tunedMs > 4000)) cellNextCandidate()
            }
            "dwell" -> {
                val cs = here?.cells?.filter { it.hz == freq && now - it.lastMs < 15_000 } ?: emptyList()
                val done = cs.isNotEmpty() && cs.all { it.complete || !it.fullBand }
                var until = sc.until
                if (done && now < until - 11_000) { until = now + 1500; _cellScan.value = sc.copy(until = until) }
                if (now >= until) cellNextCandidate()
            }
        }
    }
    fun setCellBand(b: String) {
        _cellBand.value = b
        if (playing() != MayhemApp.CELL) { _cellScan.value = CellScan(); return }
        cellSurvey(bandIdx = 0)
    }
    /** STAY HERE on one carrier, or (tapped again) back to the scan. */
    fun cellStay(hz: Long) {
        val sc = _cellScan.value
        if (sc.phase == "stay" && sc.stayHz == hz) { cellSurvey(); return }
        _cellScan.value = sc.copy(phase = "stay", stayHz = hz)
        cellGo(hz, 0)
    }
    private fun startCell() {
        cell.centerOf = { SdrEngine.freqHz.value }
        val sc = _cellScan.value
        if (sc.phase == "stay" && sc.stayHz > 0) SdrEngine.configure(SdrEngine.Mode.NONE, sc.stayHz, cellRate(), 32, 40, true, cell)
        else { cellSurvey(first = true); SdrEngine.configure(SdrEngine.Mode.NONE, _cellScan.value.windows[0], cellRate(), 32, 40, true, cell) }
        val f = cellFile ?: return
        if (!cellRestored) kotlin.concurrent.thread(isDaemon = true, name = "cell-restore") {
            runCatching { if (f.exists()) cell.restore(f.readText()) }
            cellSaved = cell.version; cellRestored = true
        }
        // what was heard is written out every 5 s once it changes, the alerts above all
        if (cellSaver == null) cellSaver = kotlin.concurrent.fixedRateTimer("cell-save", true, 5_000, 5_000) {
            val v = cell.version
            if (v != cellSaved && cellRestored) { cellSaved = v; runCatching { f.writeText(cell.exportState()) } }
        }
    }
    @Volatile var recorder: IqRecorder? = null; private set

    private val _sweep = MutableStateFlow<SweepProcessor?>(null)
    val sweep: StateFlow<SweepProcessor?> = _sweep.asStateFlow()
    private val _current = MutableStateFlow<MayhemApp?>(null)
    val current: StateFlow<MayhemApp?> = _current.asStateFlow()
    /** IQ rate used for sweeps (bigger slices = faster sweeps; 2 Msps is the HackRF Pro's proven-safe rate). */
    /**
     * Slice width a sweep starts with. Every hop costs the same (the LO relocks and the reads already in flight are
     * thrown away), so a wider slice sweeps a range in fewer hops: 8 MHz is four times the speed of 2 MHz on a
     * HackRF, and a radio that can't sample that fast is clamped to its own widest.
     */
    @Volatile var sweepRate = 8_000_000

    fun init(ctx: Context) {
        if (recorder == null) recorder = IqRecorder(File(ctx.getExternalFilesDir(null), "captures"))
        Geo.init(ctx)
        com.rocketgod.mayhem.core.lora.LoraLocal.init(ctx)
        Bookmarks.load(ctx)
        com.rocketgod.mayhem.core.spectrum.Spectrum.load(ctx)
        com.rocketgod.mayhem.core.hd.HdApp.init(ctx)
        com.rocketgod.mayhem.core.atsc.AtscApp.init(ctx)
    }

    /** LoRa's wide span center: the one the user picked (kept until they pick LOCAL again), else the local one. */
    fun loraWideStart(): Long {
        val u = SdrEngine.savedLong("lora_user_wide")
        if (u in 400_000_000L..1_000_000_000L) return u
        val local = com.rocketgod.mayhem.core.lora.LoraLocal
        return local.wideCenter(local.area()) ?: com.rocketgod.mayhem.core.lora.LoraPlan.homeBand().center
    }

    /** LoRa one channel at a time: the user's pick, else the most local channel; the radio sits 300 kHz above it. */
    fun loraNarrowStart(): Long {
        val u = SdrEngine.savedLong("lora_user_narrow")
        if (u in 400_000_000L..1_000_000_000L) return u + 300_000
        val local = com.rocketgod.mayhem.core.lora.LoraLocal
        return (local.narrowChannel(local.area()) ?: com.rocketgod.mayhem.core.lora.LoraPlan.homeBand().narrow) + 300_000
    }

    /** Sondes: every carrier in the 400–406 MHz band (or 1680 MHz), every sonde type on each. */
    /** UAT: FIS-B weather from the ground towers and the aircraft on 978 MHz. */
    val uatLog = PacketLog(); val uat = com.rocketgod.mayhem.core.uat.UatProcessor(uatLog)
    val sondesLog = PacketLog(); val sondes = com.rocketgod.mayhem.core.sonde.SondeProcessor(sondesLog)
    /** The band Sondes watches, by id ("400" or "1680"), kept across runs. */
    fun sondeBandId(): String = SdrEngine.savedLong("sonde_band").let { if (it == 0L) "400" else it.toString() }
    fun setSondeBand(id: String) {
        SdrEngine.saveLong("sonde_band", id.toLongOrNull() ?: 400L)
        val f = com.rocketgod.mayhem.core.sonde.SondeFront
        val band = f.band(id)
        sondes.setBand(id)
        if (playing() == MayhemApp.SONDES) {
            val rate = SdrEngine.rateHz.value
            SdrEngine.tune(if (rate >= 6_000_000) f.wideCenter(band) else f.narrowWindows(band, rate)[0])
        }
    }
    /** CLEAR: the sondes, their channels and the log. */
    fun sondesClear() { sondes.clear(); sondesLog.clear() }
    private fun startSondes() {
        val f = com.rocketgod.mayhem.core.sonde.SondeFront
        val band = f.band(sondeBandId())
        // a radio that samples the whole band watches every carrier at once; a narrower one steps across it in windows
        val wide = Radio.canSample(Radio.limits, f.WIDE)
        SdrEngine.configure(SdrEngine.Mode.NONE, if (wide) f.wideCenter(band) else f.narrowWindows(band, f.NARROW)[0], if (wide) f.WIDE else f.NARROW, 32, 40, true, sondes)
        sondes.centerOf = { SdrEngine.freqHz.value }
        sondes.onNote = { com.rocketgod.mayhem.Diag.log(it) }
        sondes.setBand(band.id)
    }
    /** A frequency another app (Spectrum) asked the next app to open on, used once (Analyzer and Devices take it). */
    @Volatile var handoffHz: Long? = null
    fun takeHandoff(): Long? { val h = handoffHz; handoffHz = null; return h }

    /** The app open before the current one; null is the launcher. */
    @Volatile var cameFrom: MayhemApp? = null; private set
    /** The app Settings was opened over, which keeps running underneath it. */
    private var under: MayhemApp? = null
    /** What the radio is doing for: the open app, or the one under Settings. */
    fun playing(): MayhemApp? = if (_current.value == MayhemApp.SETTINGS) under else _current.value
    /** The app Settings is open over (null: over Home, or Settings is not open). */
    fun settingsOver(): MayhemApp? = if (_current.value == MayhemApp.SETTINGS) under else null

    fun open(app: MayhemApp) {
        if (app == MayhemApp.SETTINGS) {
            if (_current.value != MayhemApp.SETTINGS) under = _current.value
            _current.value = app
            return
        }
        under = null
        recorder?.stop()
        // the start-up pick belongs to the receiver: another app taking the radio calls it off
        if (app != MayhemApp.AUDIO) AutoPick.stop()
        // one tap in the bar now switches app; a transmission never outlives the app that started it
        if (app != MayhemApp.TRANSMIT && app != MayhemApp.TROLL) Tx.stop()
        if (app != MayhemApp.LOOKING_GLASS && app != MayhemApp.SEARCH) _sweep.value = null
        if (app != MayhemApp.AUDIO) Scanner.stop()
        if (app != MayhemApp.HAM) com.rocketgod.mayhem.core.ham.Ham.stopPtt()
        if (app != MayhemApp.SAT) com.rocketgod.mayhem.core.sat.Sats.close()
        if (app != MayhemApp.PROWL) Prowl.stop()          // the hunt owns the receiver; anything else takes it back
        if (!(app == MayhemApp.PAGER && _pagerMulti.value)) com.rocketgod.mayhem.core.pager.PagerEngine.stop()
        // the signal finder labels every waterfall; the sweeps have no fixed span to label
        SdrEngine.watchSignals = app != MayhemApp.LOOKING_GLASS && app != MayhemApp.SEARCH
        SdrEngine.deepQueue = app == MayhemApp.LORA
        SdrEngine.sameOn = app == MayhemApp.AUDIO
        cameFrom = _current.value
        _current.value = app
        NavBar.noteOpened(app)
        val r = SdrEngine.IQ_RATE
        when (app) {
            MayhemApp.HAM -> com.rocketgod.mayhem.core.ham.Ham.open()
            MayhemApp.SAT -> com.rocketgod.mayhem.core.sat.Sats.open()
            MayhemApp.DEVICES -> com.rocketgod.mayhem.core.r433.Devices.open()
            // already listening (from the launcher, or back from Settings): carry on exactly where it is
            MayhemApp.AUDIO -> when {
                SdrEngine.listening() -> {}
                SdrEngine.plain() -> SdrEngine.setMode(SdrEngine.radioMode, silent = true)
                // another app had the radio (ADS-B, AIS...): back on the dial, and onto the strongest station in view
                else -> { SdrEngine.configure(SdrEngine.radioMode, SdrEngine.radioFreqHz, SdrEngine.RX_RATE, 24, 24, false, null); AutoPick.armBand() }
            }
            MayhemApp.HD -> com.rocketgod.mayhem.core.hd.HdApp.start()
            MayhemApp.UAT -> SdrEngine.configure(SdrEngine.Mode.NONE, 978_000_000L, 2_000_000, 32, 32, true, uat)
            MayhemApp.ADSB -> { if (adsbPick == null) AdsbStore.clear(); SdrEngine.configure(SdrEngine.Mode.NONE, 1_090_000_000L, r, 32, 32, true, AdsbDecoder) }
            // the radio sits NARROW_SHIFT above the channel, as Mayhem keeps its channels off the DC spike, and the
            // engine mixes the channel back down through the offset
            MayhemApp.AIS -> { SdrEngine.configure(SdrEngine.Mode.NFM, 161_975_000L + NARROW_SHIFT, r, 32, 32, false, ais); SdrEngine.setOffset(-NARROW_SHIFT.toInt()) }
            MayhemApp.APRS -> { SdrEngine.configure(SdrEngine.Mode.NFM, 144_390_000L + NARROW_SHIFT, r, 24, 24, false, aprs); SdrEngine.setOffset(-NARROW_SHIFT.toInt()) }
            MayhemApp.PAGER -> startPager()
            // as wide as the radio goes (19.2 Msps on a HackRF hears 118 hopping channels and about six times the meters
            // of Mayhem's 4.19 Msps ERT span), centered where the ERT meters sit
            MayhemApp.ERT -> {
                val wide = when {
                    Radio.canSample(Radio.limits, MeshDecoder.WIDE) -> MeshDecoder.WIDE
                    Radio.canSample(Radio.limits, ErtDecoder.RATE) -> ErtDecoder.RATE
                    else -> r
                }
                SdrEngine.configure(SdrEngine.Mode.NONE, 911_600_000L, wide, 32, 40, true, meters)
                mesh.centerOf = { SdrEngine.freqHz.value }
            }
            MayhemApp.LORA -> {
                val wide = Radio.canSample(Radio.limits, com.rocketgod.mayhem.core.lora.LoraScanner.RATE)
                // Where the user last put it, if they did; else centered on what is local to where the device is (its
                // MeshCore presets and its Meshtastic region, LoraLocal). A radio that can't sample 20 MHz sits on one
                // channel, 300 kHz off it (clear of the spike at the center).
                val band = com.rocketgod.mayhem.core.lora.LoraPlan.homeBand()
                val local = com.rocketgod.mayhem.core.lora.LoraLocal
                SdrEngine.configure(SdrEngine.Mode.NONE, if (wide) loraWideStart() else loraNarrowStart(), if (wide) com.rocketgod.mayhem.core.lora.LoraScanner.RATE else 2_000_000, 32, 40, true, lora.scanner)
                lora.scanner.centerOf = { SdrEngine.freqHz.value }
                SdrEngine.loraRecall()
                // another area or the user's own channel: the channels again, and the span follows when the user hasn't set one
                local.onChange = onChange@{
                    lora.scanner.replan()
                    if (playing() != MayhemApp.LORA) return@onChange
                    val w = SdrEngine.rateHz.value >= 10_000_000
                    kotlin.concurrent.thread(isDaemon = true, name = "lora-area") { SdrEngine.tune(if (w) loraWideStart() else loraNarrowStart()) }
                }
                lora.narrowed.value = 0
                lora.scanner.onTooMuch = onTooMuch@{ r ->
                    // the next span down this radio can sample, still holding the band's main channel
                    val next = intArrayOf(10_000_000, 5_000_000, 2_000_000).firstOrNull { it < r && Radio.canSample(Radio.limits, it) } ?: return@onTooMuch
                    val area = local.area()
                    val ch = local.narrowChannel(area) ?: band.narrow
                    val wc = local.wideCenter(area) ?: band.center
                    val c = if (next <= 2_400_000) ch + 300_000
                        else if (wc >= ch) minOf(wc, ch + (0.45 * next).toLong())
                        else maxOf(wc, ch - (0.45 * next).toLong())
                    com.rocketgod.mayhem.Diag.log("LoRa: this device fell behind at %.0f MHz, narrowing the span to %.0f MHz".format(r / 1e6, next / 1e6))
                    lora.narrowed.value = next
                    // off the engine's thread, which is the one asking
                    kotlin.concurrent.thread(isDaemon = true, name = "lora-narrow") { SdrEngine.setRate(next); SdrEngine.tune(c) }
                }
            }
            MayhemApp.BTLE -> SdrEngine.configure(SdrEngine.Mode.NONE, BtleDecoder.channelFreq(btle.channel), r, 32, 40, true, btle)
            // the radio sits LO_SHIFT from the channel (130.8 MHz for 131.550), so every US channel is in the span and
            // decoded at once; the AM audio plays the tuned one through the offset
            // the radio sits at 136.55 MHz: 2 MHz holds every VDL2 channel (136.10 to 136.975), all decoded at once
            MayhemApp.VDL2 -> {
                SdrEngine.configure(SdrEngine.Mode.NONE, com.rocketgod.mayhem.core.apps.Vdl2Decoder.SPAN_HZ, r, 32, 32, false, vdl2)
                vdl2.centerOf = { SdrEngine.freqHz.value }
                vdl2.onNote = { com.rocketgod.mayhem.Diag.log(it) }
            }
            MayhemApp.ACARS -> {
                SdrEngine.configure(SdrEngine.Mode.AM, 131_550_000L + AcarsDecoder.LO_SHIFT, r, 32, 32, false, acars)
                SdrEngine.setOffset(-AcarsDecoder.LO_SHIFT.toInt())
                acars.centerOf = { SdrEngine.freqHz.value }; acars.tunedOf = { SdrEngine.channelHz() }
                acars.onNote = { com.rocketgod.mayhem.Diag.log(it) }
            }
            MayhemApp.TRAINS -> startTrains()
            MayhemApp.FLEET -> startFleet()
            MayhemApp.CELL -> startCell()
            MayhemApp.ATSC -> com.rocketgod.mayhem.core.atsc.AtscApp.start()
            MayhemApp.SONDES -> startSondes()
            MayhemApp.PROWL -> Prowl.open()
            MayhemApp.LOOKING_GLASS -> startSweep(88_000_000L, 108_000_000L)
            MayhemApp.SEARCH -> startSweep(400_000_000L, 470_000_000L)
            MayhemApp.ANALYZER -> com.rocketgod.mayhem.core.analyzer.Analyzer.open()
            // the processor starts on the span and plan the settings call for (Spectrum.restart)
            MayhemApp.SPECTRUM -> com.rocketgod.mayhem.core.spectrum.Spectrum.open()
            MayhemApp.CAPTURE -> SdrEngine.configure(SdrEngine.Mode.NONE, SdrEngine.radioFreqHz, SdrEngine.RX_RATE, 24, 24, false, recorder)
            MayhemApp.TRANSMIT -> SdrEngine.configure(SdrEngine.Mode.NONE, SdrEngine.radioFreqHz, SdrEngine.RX_RATE, 24, 24, false, null)
            MayhemApp.TROLL -> SdrEngine.configure(SdrEngine.Mode.NONE, SdrEngine.radioFreqHz, SdrEngine.RX_RATE, 24, 24, false, null)
            MayhemApp.SETTINGS -> {}
        }
    }

    fun startSweep(startHz0: Long, endHz0: Long) {
        // a range that runs past what the radio tunes is swept as far as it goes
        val lim = Radio.limits
        val startHz = startHz0.coerceIn(lim.minHz, lim.maxHz); val endHz = endHz0.coerceIn(lim.minHz, lim.maxHz)
        val rate = Radio.nearestRate(lim, sweepRate)
        val sp = SweepProcessor(startHz, endHz, rate)
        _sweep.value = sp
        SdrEngine.configure(SdrEngine.Mode.NONE, sp.centerOf(0), rate, 24, 24, false, sp)
    }

    /** Back: off Settings to whatever it was opened over (the launcher included), otherwise to the launcher. */
    fun back() {
        if (_current.value == MayhemApp.SETTINGS) { _current.value = under; under = null } else home()
    }

    /**
     * Back to the launcher, which is a receiver as well: what was playing keeps playing, and leaving a decoder
     * brings the last station back.
     */
    fun home() {
        under = null
        recorder?.stop()
        Tx.stop()
        Scanner.stop()
        Prowl.stop()
        com.rocketgod.mayhem.core.ham.Ham.stopPtt()
        com.rocketgod.mayhem.core.sat.Sats.close()
        SdrEngine.watchSignals = true
        SdrEngine.deepQueue = false
        SdrEngine.sameOn = true
        _current.value = null
        _sweep.value = null
        // Back from an app that moved the radio (ADS-B, AIS...): the launcher listens again, and lands on the
        // strongest station in view rather than the old dial. The pick is silent, so it never becomes the dial,
        // and anything the user tunes first cancels it.
        if (!SdrEngine.listening()) { SdrEngine.configure(SdrEngine.radioMode, SdrEngine.radioFreqHz, SdrEngine.RX_RATE, 24, 24, false, null); AutoPick.armBand() }
        // the launcher has no gain controls of its own, so it rides the AGC unless the gain has been set by hand
        SdrEngine.rideAgc()
    }

    /** Jump from a sweep hit into the Audio receiver on that frequency. */
    fun listen(freqHz: Long, mode: SdrEngine.Mode) {
        _sweep.value = null
        SdrEngine.watchSignals = true
        SdrEngine.deepQueue = false
        SdrEngine.sameOn = true
        _current.value = MayhemApp.AUDIO
        SdrEngine.configure(mode, freqHz, SdrEngine.RX_RATE, 24, 24, false, null)
        SdrEngine.setDial(freqHz, mode)
    }
}
