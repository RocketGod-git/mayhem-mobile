package com.rocketgod.mayhem.core.pager

import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.SdrEngine

/**
 * The PAGERS tab's multi-channel hunter as an [IqProcessor]. The engine retunes the radio itself to survey the
 * pager windows and channelises up to four carriers out of each buffer, so this runs with no built-in demod mode
 * and simply forwards every buffer, tagged with the center the radio is on. Audio (the heard channel's FSK) goes
 * straight to [PagerAudio] from the engine, gated by its speaker toggle.
 */
class PagerHunter : IqProcessor {
    override fun reset(rate: Int) { PagerEngine.start() }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        PagerEngine.onIq(iq, len, rate, SdrEngine.freqHz.value)
    }
}
