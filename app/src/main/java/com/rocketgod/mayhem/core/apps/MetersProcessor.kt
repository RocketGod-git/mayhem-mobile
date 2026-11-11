package com.rocketgod.mayhem.core.apps

import com.rocketgod.mayhem.core.IqProcessor

/**
 * The Meters app's processor: ErtDecoder (Itron SCM / SCM+ / IDM and Neptune R900, OOK) and MeshDecoder (the
 * hopping FSK mesh networks, Gridstream) on every buffer. Both live in 902-928 MHz and want the same wide span, so
 * one app hears all of them.
 */
class MetersProcessor(val ert: ErtDecoder, val mesh: MeshDecoder) : IqProcessor {
    init {
        ert.onReading = { k, id, c, v, extra -> mesh.ertReading(k, id, c, v, extra) }
    }

    override fun reset(rate: Int) { ert.reset(rate); mesh.reset(rate) }
    override fun onIq(iq: ByteArray, len: Int, rate: Int) { ert.onIq(iq, len, rate); mesh.onIq(iq, len, rate) }
}
