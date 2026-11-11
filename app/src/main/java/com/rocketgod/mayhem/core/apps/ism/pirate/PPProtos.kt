// ProtoPirate's protocol catalog (protocols/protocol_items.c): which decoders listen behind AM (OOK) and which behind
// FM (2-FSK). Protocols ProtoPirate routes by the preset's modulation run behind both, one instance each.
package com.rocketgod.mayhem.core.apps.ism.pirate

object PPProtos {
    /** Fresh decoders: the AM set and the FM set. */
    fun all(): Pair<List<PPDecoder>, List<PPDecoder>> {
        val am = listOf<PPDecoder>(PPChryslerV0(), PPFiatV0(), PPFiatV1(), PPFiatV2(), PPFordV0(), PPHondaV1(), PPKiaV1(), PPKiaV2(),
            PPMazdaV0(), PPPsa(), PPRenaultV0(), PPRenaultV1(), PPStarLine(), PPSubaru(), PPVag())
        val fm = listOf<PPDecoder>(PPFordV1(), PPFordV2(), PPFordV3(), PPHondaStatic(), PPHondaV2(), PPKiaV0(), PPKiaV3V4(), PPKiaV5(),
            PPKiaV6(), PPKiaV7(), PPScherKhan(), PPMazdaV0(), PPPsa(), PPRenaultV1())
        return Pair(am, fm)
    }
}
