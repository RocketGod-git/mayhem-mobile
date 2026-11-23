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
        mode.onSymbol48 = { dmr.pushSymbol(it); dstar.pushSymbol(it); ysf.pushSymbol(it) }
        dmr.onVoiceFrame = { pcm(it, dmr.slots[if (it.stream == "dmr2") 1 else 0].privacy) }
        dstar.onVoiceFrame = { pcm(it, false) }
        ysf.onVoiceFrame = { pcm(it, false) }
    }
    private fun pcm(f: HamVoiceFrame, encrypted: Boolean) { onPcm?.invoke(voice.decode(f, encrypted)) }
    fun reset() { mode.reset(); dmr.reset(); dstar.reset(); ysf.reset(); dtmf.reset(); voice.reset(); dd?.reset() }
    /** Discriminator samples, radians per sample, at [fs]. */
    fun push(disc: FloatArray, n: Int) { mode.push(disc, n); dtmf.push(disc, n); dd?.push(disc, n) }

    fun snapshot(): HamIdSnap {
        val r = mode.result()
        var m = r.mode
        if (ysf.id.frames > 0) m = "YSF"
        else if (dstar.id.headers > 0 || dstar.id.frames >= 20) m = "D-STAR"
        else if (dmr.checked > 0) m = "DMR"
        else if (dd != null && dd.id.packets > 0) m = "D-STAR"
        val ddId = if (dd != null && dd.id.packets > 0) dd.id.copy() else null
        var station = ""; var repeater = ""; var position: Position? = null
        var slots: List<DmrSlotId>? = null; var ds: DStarId? = null; var ys: YsfId? = null
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
        }
        val h = ds?.header ?: if (m == "D-STAR") ddId?.header else null
        return HamIdSnap(m, r.hits, if (m == "DMR") dmr.cc else -1, slots, ds, ys, station, repeater, position, dtmf.text,
            h?.let { dstarFlags(it.flag1) }, h?.let { urcallCommand(it.ur) },
            if (ys != null && ys.voip) ys.down to ys.rem[2] else null, ddId)
    }
}
