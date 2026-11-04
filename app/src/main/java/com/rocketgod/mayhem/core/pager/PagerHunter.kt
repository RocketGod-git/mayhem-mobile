package com.rocketgod.mayhem.core.pager

import com.rocketgod.mayhem.core.IqProcessor
import com.rocketgod.mayhem.core.SdrEngine

/**
 * The PAGERS multi-channel hunter as an [IqProcessor]. It channelises up to four carriers out of each buffer itself,
 * so it runs with no built-in demod mode and just forwards every buffer tagged with the center the radio is on. The
 * heard channel's audio comes back through [drainAudio], so the engine's AudioTrack plays it and the global mute
 * governs it — no app-specific speaker control.
 */
class PagerHunter : IqProcessor {
    override val producesAudio: Boolean get() = true

    override fun reset(rate: Int) { PagerEngine.start() }

    override fun onIq(iq: ByteArray, len: Int, rate: Int) {
        PagerEngine.onIq(iq, len, rate, SdrEngine.freqHz.value)
    }

    override fun drainAudio(dst: FloatArray, max: Int): Int = PagerEngine.drainAudio(dst, max)
}
