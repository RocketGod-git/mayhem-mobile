package com.rocketgod.mayhem.core.hamid

/**
 * One FM channel's identity: the discriminator through the mode detector, its 4800/s symbols through the DMR, D-STAR
 * and Fusion decoders at once. A decoder whose checks pass names the mode before the sync count does. The same as the
 * web's dsp/hamid/channel.ts.
 */
class HamIdSnap(
    val mode: String, val hits: Map<String, Int>,
    val dmrCc: Int, val dmrSlots: List<DmrSlotId>?,
    val dstar: DStarId?, val ysf: YsfId?,
    val station: String, val repeater: String, val position: Position?,
    /** DTMF digits heard on the channel so far; D-STAR header flags and what its URCALL asks for. */
    val dtmf: String = "", val dstarFlags: DStarFlags? = null, val urcall: UrCall? = null,
)

class HamIdChannel(val fs: Double) {
    val mode = ModeDetector(fs)
    val dmr = DmrIdentity()
    val dstar = DStarReceiver()
    val ysf = YsfReceiver()
    val dtmf = DtmfDecoder(fs)
    init { mode.onSymbol48 = { dmr.pushSymbol(it); dstar.pushSymbol(it); ysf.pushSymbol(it) } }
    fun reset() { mode.reset(); dmr.reset(); dstar.reset(); ysf.reset(); dtmf.reset() }
    /** Discriminator samples, radians per sample, at [fs]. */
    fun push(disc: FloatArray, n: Int) { mode.push(disc, n); dtmf.push(disc, n) }

    fun snapshot(): HamIdSnap {
        val r = mode.result()
        var m = r.mode
        if (ysf.id.frames > 0) m = "YSF"
        else if (dstar.id.headers > 0 || dstar.id.frames >= 20) m = "D-STAR"
        else if (dmr.checked > 0) m = "DMR"
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
                ds.header?.let { h ->
                    station = h.my + if (h.suffix.isNotEmpty()) "/" + h.suffix else ""
                    val (call, module) = repeaterOf(h.rpt1)
                    if (call.isNotEmpty() && call != "DIRECT") repeater = call + if (module.isNotEmpty()) " $module" else ""
                }
                position = ds.position
            }
            "YSF" -> { ys = ysf.id.copy(); station = ys.src; repeater = ys.down; position = ys.position }
        }
        val h = ds?.header
        return HamIdSnap(m, r.hits, if (m == "DMR") dmr.cc else -1, slots, ds, ys, station, repeater, position, dtmf.text,
            h?.let { dstarFlags(it.flag1) }, h?.let { urcallCommand(it.ur) })
    }
}
