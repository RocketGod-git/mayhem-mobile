// Port of ProtoPirate protocols/star_line.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Star Line: AM, 250 / 500 µs PWM after a 1000 µs preamble, 64 bits sent LSB first: a 32-bit fix (button byte +
 * 24-bit serial) and a 32-bit KeeLoq hop. No manufacturer keys ship, so the hop is never decrypted: the C finds no
 * key, names the manufacturer "Unknown" and leaves the counter at 0.
 */
class PPStarLine : PPDecoder("Star Line", PPModulation.AM, PPConst(250, 500, 120, 64)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULA = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3
    }

    /** The keystore's mfname: "" after reset, "Unknown" once a frame found no key (it then skips the key search). */
    private var keystoreMfname = ""
    private var manufactureName = ""

    override fun reset() { parserStep = STEP_RESET; keystoreMfname = "" }

    override fun feed(level: Boolean, duration: Int) {
        val teShort = c.teShort; val teLong = c.teLong; val teDelta = c.teDelta
        when (parserStep) {
            STEP_RESET -> if (level) {
                if (dd(duration, teLong * 2) < teDelta * 2) { parserStep = STEP_CHECK_PREAMBULA; headerCount++ }
                else if (headerCount > 4) {
                    decodeData = 0; decodeCountBit = 0; teLast = duration; parserStep = STEP_CHECK_DURATION
                }
            } else headerCount = 0
            STEP_CHECK_PREAMBULA -> if (!level && dd(duration, teLong * 2) < teDelta * 2) parserStep = STEP_RESET   // found preambula
                else { headerCount = 0; parserStep = STEP_RESET }
            STEP_SAVE_DURATION -> if (level) {
                if (duration >= teLong + teDelta) {
                    parserStep = STEP_RESET
                    if (decodeCountBit >= c.minBits && decodeCountBit <= c.minBits + 2) {
                        if (data != decodeData) {
                            data = decodeData; dataCountBit = c.minBits
                            emit()
                        }
                    }
                    decodeData = 0; decodeCountBit = 0; headerCount = 0
                } else { teLast = duration; parserStep = STEP_CHECK_DURATION }
            } else parserStep = STEP_RESET
            STEP_CHECK_DURATION -> if (!level) {
                if (dd(teLast, teShort) < teDelta && dd(duration, teShort) < teDelta) {
                    if (decodeCountBit < c.minBits) addBit(0) else decodeCountBit++
                    parserStep = STEP_SAVE_DURATION
                } else if (dd(teLast, teLong) < teDelta && dd(duration, teLong) < teDelta) {
                    if (decodeCountBit < c.minBits) addBit(1) else decodeCountBit++
                    parserStep = STEP_SAVE_DURATION
                } else parserStep = STEP_RESET
            } else parserStep = STEP_RESET
        }
    }

    /** subghz_protocol_star_line_check_remote_controller with an empty keystore: the selector's key loop never runs. */
    private fun checkRemoteController() {
        val key = PPMath.reverseKey(data, dataCountBit)
        val fix = (key ushr 32) and M32
        if (keystoreMfname != "Unknown") {
            // "" (not set) or a name: no key matches, so the C falls through to "Unknown" and clears the counter.
            manufactureName = "Unknown"; keystoreMfname = "Unknown"; cnt = 0
        }
        serial = fix and 0x00FFFFFF
        btn = ((fix ushr 24) and 0xFF).toInt()
    }

    override fun describe(): PPHit {
        checkRemoteController()
        val rev = PPMath.reverseKey(data, dataCountBit)
        return PPHit(name, dataCountBit, hx("%016X", data), serial, hx("%02X", btn.toLong()), cnt,
            listOf(MeshField("Fix", hx("0x%08X", (rev ushr 32) and M32)),
                MeshField("Hop", hx("0x%08X", rev and M32)),
                MeshField("MF", manufactureName)))
    }

    /** star_line.c get_string: "%s %dbit\r\nKey:%08lX%08lX\r\nFix:0x%08lX    Cnt:%04lX\r\nHop:0x%08lX    Btn:%02X\r\nMF:%s\r\n". */
    override fun cString(h: PPHit): String {
        val f = h.fields
        return "${h.name} ${h.bits}bit | Key:${h.key} | Fix:${f[0].value}    " + hx("Cnt:%04X", h.cnt ?: 0) +
            " | Hop:${f[1].value}    Btn:${h.btn ?: ""} | MF:${f[2].value}"
    }
}
