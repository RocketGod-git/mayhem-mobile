package com.rocketgod.mayhem.core.fleet

import com.rocketgod.mayhem.core.ham.AmbeDecoder
import com.rocketgod.mayhem.core.ham.ImbeDecoder
import com.rocketgod.mayhem.core.ham.rW
import com.rocketgod.mayhem.core.ham.rX
import com.rocketgod.mayhem.core.ham.rY
import com.rocketgod.mayhem.core.ham.rZ

/**
 * The app's own vocoders behind Dispatch's codec plug point: IMBE (ham ImbeDecoder) for P25 Phase 1 full rate, and
 * AMBE+2 3600x2450 (ham AmbeDecoder) for DMR and P25 Phase 2, fed through the DMR frame de-interleave the HAM
 * receiver uses. Each call gets its own decoder state. [Vocoders.ensure] registers them (once).
 */
object Vocoders {
    /** 9.5 dB under the HAM receiver's level: loud talkers on a trunked system no longer clip inside the vocoder. The
     *  output stage (Codec.kt) makes the level up and limits softly. */
    const val VOCODER_GAIN = 7.0 / 32768 / 3

    /** A muted frame is not left at exact zero mid-call: a faint noise floor (about -80 dBFS) keeps the output alive. */
    fun comfort(pcm: FloatArray): FloatArray {
        for (v in pcm) if (v != 0f) return pcm
        for (i in pcm.indices) pcm[i] = ((Math.random() - 0.5) * 2e-4).toFloat()
        return pcm
    }

    /** Registers the real vocoders again (a test that put stand-ins in their place restores them with this). */
    fun register() {
        registerCodec(CodecIds.IMBE) {
            val d = ImbeDecoder(); d.outGain = VOCODER_GAIN
            object : VoiceCodec {
                override val id = CodecIds.IMBE
                override fun reset() = d.reset()
                override fun decode(bits: IntArray): FloatArray = comfort(if (bits.isNotEmpty()) d.decodeVoice(bits).copyOf() else d.erase().copyOf())
                override val bad: Boolean get() = d.status == "R" || d.status == "M"
            }
        }
        registerCodec(CodecIds.AMBE2) {
            val d = AmbeDecoder(); d.outGain = VOCODER_GAIN
            val fr = Array(4) { IntArray(24) }
            object : VoiceCodec {
                override val id = CodecIds.AMBE2
                override fun reset() = d.reset()
                override val bad: Boolean get() = d.status == "R" || d.status == "M"
                override val silent: Boolean get() = d.status == "S"
                /** One 72-bit frame as it sits in the burst: 36 dibits, each split across the four code words. */
                override fun decode(bits: IntArray): FloatArray {
                    // an empty frame is an erasure: the last frame again, faded (muted after a few), never a burst of noise
                    if (bits.isEmpty()) return comfort(d.erase().copyOf())
                    for (row in fr) row.fill(0)
                    for (i in 0 until 36) { fr[rW[i]][rX[i]] = bits[2 * i]; fr[rY[i]][rZ[i]] = bits[2 * i + 1] }
                    return comfort(d.decode(fr).copyOf())
                }
            }
        }
    }
    private val registered = run { register(); true }

    /** Registers the vocoders (the first call does it). */
    fun ensure(): Boolean = registered
}
