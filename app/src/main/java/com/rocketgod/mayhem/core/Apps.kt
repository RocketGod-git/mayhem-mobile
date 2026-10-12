package com.rocketgod.mayhem.core

import android.content.Context
import com.rocketgod.mayhem.core.apps.AcarsDecoder
import com.rocketgod.mayhem.core.apps.AisDecoder
import com.rocketgod.mayhem.core.apps.AprsDecoder
import com.rocketgod.mayhem.core.apps.BtleDecoder
import com.rocketgod.mayhem.core.apps.ErtDecoder
import com.rocketgod.mayhem.core.apps.IqRecorder
import com.rocketgod.mayhem.core.apps.PagerDecoder
import com.rocketgod.mayhem.core.apps.SweepProcessor
import com.rocketgod.mayhem.core.apps.TpmsDecoder
import com.rocketgod.mayhem.core.apps.ism.IsmDecoder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

/** The app menu — Mayhem's launcher grid, HackRF-DSP apps only (no games, no PortaPack-hardware apps). */
enum class MayhemApp(val title: String, val blurb: String, val category: String) {
    HAM("HAM", "SSB · CW · AM · NFM · repeaters · CTCSS", "Receive"),
    AUDIO("Audio", "WFM · NFM · AM · SSB receiver", "Receive"),
    DEVICES("Devices", "alarms, meters, remotes, tire sensors, weather", "Receive"),
    SAT("Satellites", "track, listen to and decode what is overhead", "Receive"),
    ADSB("ADS-B", "aircraft, 1090 MHz", "Receive"),
    AIS("AIS", "ships, 162 MHz", "Receive"),
    APRS("APRS", "packet radio, 144.39 MHz", "Receive"),
    PAGER("FLEX", "pager RX · FLEX, or POCSAG too", "Receive"),
    ERT("ERT", "utility meters, 915 MHz", "Receive"),
    BTLE("BLE RX", "advertising, 2.4 GHz", "Receive"),
    TPMS("TPMS", "tyre pressure, 315 / 433 MHz", "Receive"),
    ACARS("ACARS", "aircraft messages, 131 MHz", "Receive"),
    SUBGHZ("Sub-GHz", "weather · remotes · car keys, rtl_433 style", "Receive"),
    PROWL("Prowl", "hunts live voice across the bands", "Receive"),
    LOOKING_GLASS("Looking Glass", "wideband sweep waterfall", "Analyze"),
    SEARCH("Search", "find active frequencies", "Analyze"),
    CAPTURE("Capture", "record raw IQ to file", "Tools"),
    TRANSMIT("Transmit", "signal gen · morse · OOK · replay", "Transmit"),
    SETTINGS("Settings", "theme · about", "Tools");
}

/** Wires each app to its engine configuration and baseband processor (Mayhem's receiver_model per app). */
object Apps {
    val pagerLog = PacketLog(); val pager = PagerDecoder(pagerLog)
    val aisLog = PacketLog(); val ais = AisDecoder(aisLog)
    val aprsLog = PacketLog(); val aprs = AprsDecoder(aprsLog)
    val ertLog = PacketLog(); val ert = ErtDecoder(ertLog)
    val btleLog = PacketLog(); val btle = BtleDecoder(btleLog)
    val tpmsLog = PacketLog(); val tpms = TpmsDecoder(tpmsLog)
    val acarsLog = PacketLog(); val acars = AcarsDecoder(acarsLog)
    val ismLog = PacketLog(); val ism = IsmDecoder(ismLog)
    @Volatile var recorder: IqRecorder? = null; private set

    private val _sweep = MutableStateFlow<SweepProcessor?>(null)
    val sweep: StateFlow<SweepProcessor?> = _sweep.asStateFlow()
    private val _current = MutableStateFlow<MayhemApp?>(null)
    val current: StateFlow<MayhemApp?> = _current.asStateFlow()
    /** IQ rate used for sweeps (bigger slices = faster sweeps; 2 Msps is the HackRF Pro's proven-safe rate). */
    @Volatile var sweepRate = SdrEngine.IQ_RATE

    fun init(ctx: Context) {
        if (recorder == null) recorder = IqRecorder(File(ctx.getExternalFilesDir(null), "captures"))
        Bookmarks.load(ctx)
    }

    fun open(app: MayhemApp) {
        recorder?.stop()
        if (app != MayhemApp.AUDIO) Scanner.stop()
        if (app != MayhemApp.HAM) com.rocketgod.mayhem.core.ham.Ham.stopPtt()
        if (app != MayhemApp.SAT) com.rocketgod.mayhem.core.sat.Sats.close()
        if (app != MayhemApp.PROWL) Prowl.stop()          // the hunt owns the receiver; anything else takes it back
        SdrEngine.watchSignals = app == MayhemApp.PROWL
        _current.value = app
        val r = SdrEngine.IQ_RATE
        when (app) {
            MayhemApp.HAM -> com.rocketgod.mayhem.core.ham.Ham.open()
            MayhemApp.SAT -> com.rocketgod.mayhem.core.sat.Sats.open()
            MayhemApp.DEVICES -> com.rocketgod.mayhem.core.r433.Devices.open()
            MayhemApp.AUDIO -> SdrEngine.configure(SdrEngine.radioMode, SdrEngine.radioFreqHz, r, 24, 24, false, null)
            MayhemApp.ADSB -> { AdsbStore.clear(); SdrEngine.configure(SdrEngine.Mode.NONE, 1_090_000_000L, r, 32, 32, true, AdsbDecoder) }
            MayhemApp.AIS -> SdrEngine.configure(SdrEngine.Mode.NFM, 161_975_000L, r, 32, 32, false, ais)
            MayhemApp.APRS -> SdrEngine.configure(SdrEngine.Mode.NFM, 144_390_000L, r, 24, 24, false, aprs)
            MayhemApp.PAGER -> SdrEngine.configure(SdrEngine.Mode.NFM, 929_612_500L, r, 32, 32, false, pager)
            MayhemApp.ERT -> SdrEngine.configure(SdrEngine.Mode.NONE, 911_600_000L, r, 32, 40, true, ert)
            MayhemApp.BTLE -> SdrEngine.configure(SdrEngine.Mode.NONE, BtleDecoder.channelFreq(btle.channel), r, 32, 40, true, btle)
            MayhemApp.TPMS -> SdrEngine.configure(SdrEngine.Mode.NONE, 315_000_000L, r, 32, 40, true, tpms)
            MayhemApp.ACARS -> SdrEngine.configure(SdrEngine.Mode.AM, 131_550_000L, r, 32, 32, false, acars)
            MayhemApp.SUBGHZ -> SdrEngine.configure(SdrEngine.Mode.NONE, 433_920_000L, r, 32, 40, true, ism)
            MayhemApp.PROWL -> Prowl.open()
            MayhemApp.LOOKING_GLASS -> startSweep(88_000_000L, 108_000_000L)
            MayhemApp.SEARCH -> startSweep(400_000_000L, 470_000_000L)
            MayhemApp.CAPTURE -> SdrEngine.configure(SdrEngine.Mode.NONE, SdrEngine.radioFreqHz, r, 24, 24, false, recorder)
            MayhemApp.TRANSMIT -> SdrEngine.configure(SdrEngine.Mode.NONE, SdrEngine.radioFreqHz, r, 24, 24, false, null)
            MayhemApp.SETTINGS -> SdrEngine.configure(SdrEngine.Mode.NONE, SdrEngine.radioFreqHz, r, 24, 24, false, null)
        }
    }

    fun startSweep(startHz: Long, endHz: Long) {
        val rate = sweepRate
        val sp = SweepProcessor(startHz, endHz, rate)
        _sweep.value = sp
        SdrEngine.configure(SdrEngine.Mode.NONE, sp.centerOf(0), rate, 24, 24, false, sp)
    }

    /** Back to the launcher: audio off, no processor (the HackRF keeps streaming for the waterfall). */
    fun home() {
        recorder?.stop()
        Scanner.stop()
        Prowl.stop()
        SdrEngine.watchSignals = false
        _current.value = null
        _sweep.value = null
        SdrEngine.configure(SdrEngine.Mode.NONE, SdrEngine.radioFreqHz, SdrEngine.IQ_RATE, 24, 24, false, null)
    }

    /** Jump from a sweep hit into the Audio receiver on that frequency. */
    fun listen(freqHz: Long, mode: SdrEngine.Mode) {
        _sweep.value = null
        SdrEngine.watchSignals = false
        _current.value = MayhemApp.AUDIO
        SdrEngine.configure(mode, freqHz, SdrEngine.IQ_RATE, 24, 24, false, null)
    }
}
