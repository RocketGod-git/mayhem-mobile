package com.rocketgod.mayhem.core.hamid

/**
 * One FM channel's identity: the discriminator through the mode detector, its 4800/s symbols through the DMR, D-STAR
 * and Fusion decoders at once. A decoder whose checks pass names the mode before the sync count does. With [onPcm]
 * set, the voice comes out as 20 ms frames of 8 kHz audio with their times; a channel at 256 kS/s or more also reads
 * D-STAR DD packets. The same as the web's dsp/hamid/channel.ts.
 */
class HamIdSnap(
    val mode: String, val hits: Map<String, Int>,
    val dmrCc: Int, val dmrSlots: List<DmrSlotId>?,
    val dstar: DStarId?, val ysf: YsfId?,
    val station: String, val repeater: String, val position: Position?,
    /** DTMF digits heard on the channel so far; D-STAR header flags and what its URCALL asks for. */
    val dtmf: String = "", val dstarFlags: DStarFlags? = null, val urcall: UrCall? = null,
    /** Fusion through the Internet: the node's callsign (the downlink) and its ID (Rem3). D-STAR DD packets. */
    val internet: Pair<String, String>? = null, val dd: DdId? = null,
    /** P25 Phase 1 and 2, NXDN and dPMR: who is talking (null unless that mode is named). */
    val p25: P25Id? = null, val p25p2: P2Id? = null, val nxdn: NxdnId? = null, val dpmr: DpmrId? = null,
    /** Analog signaling, one summary per transmission: CW ID, selcall, MDC-1200, sub-audio, courtesy tone, tail. */
    val analog: AnalogSnap? = null,
    /** M17: the link setup (callsigns, CAN, META text, position, the originator and reflector a repeater names). */
    val m17: M17Id? = null,
)

class HamIdChannel(val fs: Double) {
    val mode = ModeDetector(fs)
    val dmr = DmrIdentity()
    val dstar = DStarReceiver()
    val ysf = YsfReceiver()
    val dtmf = DtmfDecoder(fs)
    val voice = HamVoice()
    val dd: DStarDdReceiver? = if (fs >= 256000) DStarDdReceiver(fs) else null
    /** Set to hear the channel: every vocoder frame, decoded, in the order sent per stream. */
    var onPcm: ((HamPcmFrame) -> Unit)? = null
    init {
        mode.onSymbol48 = { dmr.pushSymbol(it); dstar.pushSymbol(it); ysf.pushSymbol(it); m17.pushSymbol(it); frames() }
        dmr.onVoiceFrame = { pcm(it, dmr.slots[if (it.stream == "dmr2") 1 else 0].privacy) }
        dstar.onVoiceFrame = { pcm(it, false) }
        ysf.onVoiceFrame = { pcm(it, false) }
    }
    private fun pcm(f: HamVoiceFrame, encrypted: Boolean) { onPcm?.invoke(voice.decode(f, encrypted)) }
    val m17 = M17Receiver()
    /** Decoded M17 voice (Codec 2), 16-bit PCM at 8 kHz; voice is decoded only while this is set. */
    var onM17Pcm: ((ShortArray) -> Unit)? = null
    private var c2: Codec2.Decoder? = null
    init {
        m17.onVoice = { f, rate ->
            onM17Pcm?.let { cb ->
                if (c2?.rate != rate) c2 = Codec2.Decoder(if (rate == 1600) 1600 else 3200)
                cb(c2!!.decode(f))
            }
        }
    }
    /** Checked frames of the 4800/s decoders on their grids, and the symbol count they are timed by. */
    val gate = FrameGate()
    private var t48 = 0L
    /** Discriminator samples pushed, and those pushed while the receiver clipped. */
    var samples = 0L; var clippedSamples = 0L
    val p25 = P25Modes(fs)
    val analog = AnalogSignaling(fs)
    /** Clear digital voice, 160 samples at 8 kHz a frame: the mode and the slot (0, or Phase 2's 0 and 1). */
    var onAudio: (String, Int, FloatArray) -> Unit = { _, _, _ -> }
    init { p25.onAudio = { m, slot, pcm -> onAudio(m, slot, pcm) }; val s48 = mode.onSymbol48; mode.onSymbol48 = { s48(it); p25.pushSymbol48(it) } }
    fun reset() { mode.reset(); dmr.reset(); dstar.reset(); ysf.reset(); dtmf.reset(); voice.reset(); dd?.reset(); p25.reset(); analog.reset(); m17.reset(); c2 = null; gate.reset(); t48 = 0; samples = 0; clippedSamples = 0 }
    /** Discriminator samples, radians per sample, at [fs]. */
    fun push(disc: FloatArray, n: Int, clipped: Boolean = false) {
        samples += n
        // while the receiver clips (a strong signal nearby spraying spurs) only the analog signaling hears the channel
        if (clipped) { clippedSamples += n; analog.push(disc, n); return }
        mode.push(disc, n); dtmf.push(disc, n); dd?.push(disc, n); p25.push(disc, n); analog.push(disc, n)
    }
    /** After each 4800/s symbol: a checked frame of DMR, D-STAR, Fusion or M17 is timed for the frame grid. */
    private fun frames() {
        val t = ++t48
        gate.mark("DMR", dmr.checked + dmr.clean, t); gate.mark("D-STAR", dstar.id.frames, t)
        gate.mark("YSF", ysf.id.frames, t); gate.mark("M17", m17.id.lsfs + m17.id.frames, t)
    }
    /** Whether a decoder's checks may name [m]: its frames on their grid, its syncs not heard off it, the eye for M17. */
    fun claims(m: String): Boolean = when (m) {
        "M17" -> (m17.id.lsfs > 0 || m17.id.frames >= 3) && gate.framed("M17") && !mode.offGrid("M17") && eyeOk(mode.eye("M17"))
        "YSF" -> ysf.id.frames > 0 && gate.framed("YSF") && !mode.offGrid("YSF")
        "D-STAR" -> dstar.id.headers > 0 || (dstar.id.frames >= 20 && gate.framed("D-STAR"))
        "DMR" -> (dmr.checked > 0 || dmr.clean >= 3) && gate.framed("DMR") && !mode.offGrid("DMR")
        else -> false
    }
    /** P25 Phase 1 and 2, NXDN and dPMR: the mode whose checked frames came last on their grid (P25 with its eye). */
    private fun moreMode(): String { val m = p25.mode; return if (m == "P25" && !eyeOk(mode.eye("P25"))) "" else m }

    fun snapshot(): HamIdSnap {
        val r = mode.result()
        var m = r.mode
        // a decoder's checks name the mode before the detector's sync count does
        var claimed = true
        if (claims("M17")) m = "M17"
        else if (claims("YSF")) m = "YSF"
        else if (claims("D-STAR")) m = "D-STAR"
        else if (claims("DMR")) m = "DMR"
        else if (dd != null && dd.id.packets > 0) m = "D-STAR"
        else claimed = false
        val more = if (moreMode().isNotEmpty()) p25.snapshot() else null
        if (more != null && !claimed) m = more.mode
        val ddId = if (dd != null && dd.id.packets > 0) dd.id.copy() else null
        var station = ""; var repeater = ""; var position: Position? = null
        var slots: List<DmrSlotId>? = null; var ds: DStarId? = null; var ys: YsfId? = null; var mi: M17Id? = null
        when (m) {
            "DMR" -> {
                slots = dmr.slots.map { it.copy() }
                val live = slots.filter { it.src > 0 }.maxByOrNull { it.lastSym }
                if (live != null) { station = live.alias.ifEmpty { live.src.toString() }; position = live.position }
            }
            "D-STAR" -> {
                ds = dstar.id.copy()
                (ds.header ?: ddId?.header)?.let { h ->
                    station = h.my + if (h.suffix.isNotEmpty()) "/" + h.suffix else ""
                    val (call, module) = repeaterOf(h.rpt1)
                    if (call.isNotEmpty() && call != "DIRECT") repeater = call + if (module.isNotEmpty()) " $module" else ""
                }
                position = ds.position
            }
            "YSF" -> { ys = ysf.id.copy(); station = ys.src; repeater = ys.down; position = ys.position }
            more?.mode -> { station = more!!.station; repeater = more.repeater; position = more.position }
            "M17" -> {
                // a repeater sends its own callsign as the source and the station it relays as the originator
                val id = m17.id.copy(); mi = id
                station = id.originator.ifEmpty { id.src }
                repeater = if (id.originator.isNotEmpty()) id.src else if (id.reflector.isNotEmpty()) id.reflector + (if (id.module.isNotEmpty()) " ${id.module}" else "") else ""
                position = id.position
            }
        }
        val mm = if (more != null && m == more.mode) more else null
        val h = ds?.header ?: if (m == "D-STAR") ddId?.header else null
        return HamIdSnap(m, r.hits, if (m == "DMR") dmr.cc else -1, slots, ds, ys, station, repeater, position, dtmf.text,
            h?.let { dstarFlags(it.flag1) }, h?.let { urcallCommand(it.ur) },
            if (ys != null && ys.voip) ys.down to ys.rem[2] else null, ddId,
            mm?.p25, mm?.p25p2, mm?.nxdn, mm?.dpmr, analog.snapshot(), mi)
    }
}
