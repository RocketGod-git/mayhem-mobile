package com.rocketgod.mayhem.core.hamid

import com.rocketgod.mayhem.core.ham.AmbeDecoder
import com.rocketgod.mayhem.core.ham.ImbeDecoder
import com.rocketgod.mayhem.core.ham.golayParity
import com.rocketgod.mayhem.core.ham.popcount
import com.rocketgod.mayhem.core.ham.rW
import com.rocketgod.mayhem.core.ham.rX
import com.rocketgod.mayhem.core.ham.rY
import com.rocketgod.mayhem.core.ham.rZ

/**
 * Voice out of a repeater channel: the vocoder frames the DMR, D-STAR and Fusion receivers take off the air, each with
 * the time it was sent, turned into 8 kHz audio by the app's own vocoders. Codecs: "ambe2" (a 72-bit AMBE+2 frame
 * with the vocoder's error correction: DMR, Fusion V/D mode 1), "ambe2-49" (the 49 voice bits: Fusion V/D mode 2,
 * under Yaesu's majority code), "imbe" (144-bit full rate: Fusion Voice FR) and "ambe-dstar" (D-STAR AMBE 3600x2400:
 * its bit order and tables are not published and there is no decoder, so frames come out without audio). The same as
 * the web's dsp/hamid/voice.ts.
 */
class HamVoiceFrame(val stream: String, val codec: String, val bits: IntArray, val atSym: Double, val errs: Int)
/** 160 samples at 8 kHz, or null (no vocoder, or encrypted); [atS] seconds from the channel's start. */
class HamPcmFrame(val stream: String, val codec: String, val atS: Double, val pcm: FloatArray?, val status: String, val errs: Int, val bits: IntArray)

class Vd2Voice(val bits: IntArray, val errs: Int)
private val WHITE104 by lazy { ysfWhitening(104) }
/** Fusion V/D mode 2: the 52 dibits of a VCH and its VeCH → the 49 voice bits, by majority over the three copies. */
fun ysfVd2Voice(d: IntArray, from: Int = 0): Vd2Voice {
    val s = IntArray(104)
    for (k in 0 until 104) { val v = d[from + (k shr 1)]; val at = 26 * (k % 4) + (k shr 2); s[at] = ((if (k and 1 == 1) v else v shr 1) and 1) xor WHITE104[at] }
    val bits = IntArray(49); var errs = 0
    for (i in 0 until 27) { val n = s[3 * i] + s[3 * i + 1] + s[3 * i + 2]; bits[i] = if (n >= 2) 1 else 0; if (n == 1 || n == 2) errs++ }
    for (i in 27 until 49) bits[i] = s[81 + i - 27]
    return Vd2Voice(bits, errs)
}

/** 49 AMBE+2 voice bits → the four code words the decoder takes (C0 and C1 with their Golay parity, C1 scrambled). */
fun ambe49Frame(d: IntArray): Array<IntArray> {
    val fr = Array(4) { IntArray(24) }
    var u0 = 0; var u1 = 0
    for (i in 0 until 12) { u0 = (u0 shl 1) or (d[i] and 1); u1 = (u1 shl 1) or (d[12 + i] and 1) }
    val c0 = (u0 shl 11) or golayParity(u0, 12); val c1 = (u1 shl 11) or golayParity(u1, 12)
    for (j in 1..23) fr[0][j] = (c0 ushr (j - 1)) and 1
    fr[0][0] = popcount(c0) and 1
    var pr = 16 * u0
    for (j in 22 downTo 0) { pr = (173 * pr + 13849) % 65536; fr[1][j] = ((c1 ushr j) and 1) xor (pr ushr 15) }
    for (i in 0 until 11) fr[2][10 - i] = d[24 + i] and 1
    for (i in 0 until 14) fr[3][13 - i] = d[35 + i] and 1
    return fr
}

/** A 72-bit AMBE+2 frame as sent → the four code words (the de-interleave the DMR receiver uses). */
fun ambe72Frame(bits: IntArray): Array<IntArray> {
    val fr = Array(4) { IntArray(24) }
    for (i in 0 until 36) { fr[rW[i]][rX[i]] = bits[2 * i] and 1; fr[rY[i]][rZ[i]] = bits[2 * i + 1] and 1 }
    return fr
}

/** Each stream's vocoder state, kept from frame to frame. */
class HamVoice {
    private val ambe = HashMap<String, AmbeDecoder>()
    private val imbe = HashMap<String, ImbeDecoder>()
    fun reset() { ambe.clear(); imbe.clear() }
    fun restart(stream: String) { ambe.remove(stream); imbe.remove(stream) }

    fun decode(f: HamVoiceFrame, encrypted: Boolean = false): HamPcmFrame {
        val at = f.atSym / 4800
        if (f.codec == "ambe-dstar") return HamPcmFrame(f.stream, f.codec, at, null, "no vocoder", f.errs, f.bits)
        if (encrypted) return HamPcmFrame(f.stream, f.codec, at, null, "encrypted", f.errs, f.bits)
        if (f.codec == "imbe") {
            val d = imbe.getOrPut(f.stream) { ImbeDecoder() }
            val pcm = d.decodeVoice(f.bits).copyOf()
            return HamPcmFrame(f.stream, f.codec, at, pcm, d.status, f.errs + d.errs, f.bits)
        }
        val d = ambe.getOrPut(f.stream) { AmbeDecoder() }
        val pcm = d.decode(if (f.codec == "ambe2") ambe72Frame(f.bits) else ambe49Frame(f.bits)).copyOf()
        return HamPcmFrame(f.stream, f.codec, at, pcm, d.status, f.errs + d.errs, f.bits)
    }
}
