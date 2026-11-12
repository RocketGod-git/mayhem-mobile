package com.rocketgod.mayhem.core

import android.content.Context
import com.rocketgod.mayhem.core.apps.AcarsDecoder
import com.rocketgod.mayhem.core.apps.AisDecoder
import com.rocketgod.mayhem.core.apps.AprsDecoder
import com.rocketgod.mayhem.core.apps.BtleDecoder
import com.rocketgod.mayhem.core.apps.ErtDecoder
import com.rocketgod.mayhem.core.apps.IqRecorder
import com.rocketgod.mayhem.core.apps.MeshDecoder
import com.rocketgod.mayhem.core.apps.MetersProcessor
import com.rocketgod.mayhem.core.apps.PagerDecoder
import com.rocketgod.mayhem.core.apps.SweepProcessor
import com.rocketgod.mayhem.core.apps.TpmsDecoder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

/** The app menu — Mayhem's launcher grid, HackRF-DSP apps only (no games, no PortaPack-hardware apps). */
enum class MayhemApp(val title: String, val blurb: String, val category: String) {
    HAM("HAM", "SSB · CW · AM · NFM · repeaters · CTCSS", "Receive"),
    AUDIO("Audio", "WFM · NFM · AM · SSB receiver", "Receive"),
    DEVICES("Devices", "car keys, remotes, tire sensors, weather, alarms", "Receive"),
    SAT("Satellites", "track, listen to and decode what is overhead", "Receive"),
    ADSB("ADS-B", "aircraft, 1090 MHz", "Receive"),
    AIS("AIS", "ships, 162 MHz", "Receive"),
    APRS("APRS", "packet radio, 144.39 MHz", "Receive"),
    PAGER("FLEX", "pager RX · FLEX, or POCSAG too", "Receive"),
    ERT("Meters", "utility meters: ERT, mesh networks, Gridstream", "Receive"),
    LORA("LoRa", "Meshtastic · MeshCore · LoRaWAN, 915 MHz", "Receive"),
    BTLE("BLE RX", "advertising, 2.4 GHz", "Receive"),
    TPMS("TPMS", "tire pressure, 315 / 433 MHz", "Receive"),
    ACARS("ACARS", "aircraft messages, 131 MHz", "Receive"),
    TRAINS("Trains", "end-of-train telemetry · PTC train control", "Receive"),
    PROWL("Prowl", "hunts live voice across the bands", "Receive"),
    SPECTRUM("Spectrum", "spectrum analyzer: markers, traces, channel power, zero span", "Analyze"),
    ANALYZER("Analyzer", "capture bursts, read the bits, compare repeats", "Analyze"),
    LOOKING_GLASS("Looking Glass", "wideband sweep waterfall", "Analyze"),
    SEARCH("Search", "find active frequencies", "Analyze"),
    CAPTURE("Capture", "record raw IQ to file", "Tools"),
    TRANSMIT("Transmit", "signal gen · morse · OOK · replay", "Transmit"),
    TROLL("Troll", "novelty transmitters · jingles · cart sounds", "Transmit"),
    SETTINGS("Settings", "theme · about", "Tools");

    companion object {
        /** An app by its saved name; Sub-GHz is part of Devices now, so a bookmark or bar saved with it opens Devices. */
        fun byName(name: String): MayhemApp? = if (name == "SUBGHZ") DEVICES else entries.firstOrNull { it.name == name }
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
    val tpmsLog = PacketLog(); val tpms = TpmsDecoder(tpmsLog)
    val acarsLog = PacketLog(); val acars = AcarsDecoder(acarsLog)
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
    /** Whether Trains shows the waterfall (off: the band strip shows the bursts, and the cards get the room). */
    private val _trainsWaterfall = MutableStateFlow(false)
    val trainsWaterfall: StateFlow<Boolean> = _trainsWaterfall.asStateFlow()
    fun setTrainsWaterfall(on: Boolean) { _trainsWaterfall.value = on }
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
        Bookmarks.load(ctx)
        com.rocketgod.mayhem.core.spectrum.Spectrum.load(ctx)
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
            MayhemApp.ADSB -> { AdsbStore.clear(); SdrEngine.configure(SdrEngine.Mode.NONE, 1_090_000_000L, r, 32, 32, true, AdsbDecoder) }
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
                // the band for this device's region setting; a radio that can't sample 20 MHz sits on that band's main
                // channel, 300 kHz off it (clear of the spike at the center)
                val band = com.rocketgod.mayhem.core.lora.LoraPlan.homeBand()
                SdrEngine.configure(SdrEngine.Mode.NONE, if (wide) band.center else band.narrow + 300_000, if (wide) com.rocketgod.mayhem.core.lora.LoraScanner.RATE else 2_000_000, 32, 40, true, lora.scanner)
                lora.scanner.centerOf = { SdrEngine.freqHz.value }
                lora.narrowed.value = 0
                lora.scanner.onTooMuch = onTooMuch@{ r ->
                    // the next span down this radio can sample, still holding the band's main channel
                    val next = intArrayOf(10_000_000, 5_000_000, 2_000_000).firstOrNull { it < r && Radio.canSample(Radio.limits, it) } ?: return@onTooMuch
                    val c = if (next <= 2_400_000) band.narrow + 300_000
                        else if (band.center >= band.narrow) minOf(band.center, band.narrow + (0.45 * next).toLong())
                        else maxOf(band.center, band.narrow - (0.45 * next).toLong())
                    com.rocketgod.mayhem.Diag.log("LoRa: this device fell behind at %.0f MHz, narrowing the span to %.0f MHz".format(r / 1e6, next / 1e6))
                    lora.narrowed.value = next
                    // off the engine's thread, which is the one asking
                    kotlin.concurrent.thread(isDaemon = true, name = "lora-narrow") { SdrEngine.setRate(next); SdrEngine.tune(c) }
                }
            }
            MayhemApp.BTLE -> SdrEngine.configure(SdrEngine.Mode.NONE, BtleDecoder.channelFreq(btle.channel), r, 32, 40, true, btle)
            MayhemApp.TPMS -> SdrEngine.configure(SdrEngine.Mode.NONE, 315_000_000L, r, 32, 40, true, tpms)
            // the radio sits LO_SHIFT from the channel (130.8 MHz for 131.550), so every US channel is in the span and
            // decoded at once; the AM audio plays the tuned one through the offset
            MayhemApp.ACARS -> {
                SdrEngine.configure(SdrEngine.Mode.AM, 131_550_000L + AcarsDecoder.LO_SHIFT, r, 32, 32, false, acars)
                SdrEngine.setOffset(-AcarsDecoder.LO_SHIFT.toInt())
                acars.centerOf = { SdrEngine.freqHz.value }; acars.tunedOf = { SdrEngine.channelHz() }
                acars.onNote = { com.rocketgod.mayhem.Diag.log(it) }
            }
            MayhemApp.TRAINS -> startTrains()
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
