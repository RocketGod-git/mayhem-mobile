// Port of ProtoPirate protocols/scher_khan.c (decoder and get_string; GPL-3.0).
package com.rocketgod.mayhem.core.apps.ism.pirate

import com.rocketgod.mayhem.core.apps.MeshField

/**
 * Scher-Khan (Magic Code / Magicar): FM, 750 / 1100 µs PWM after a 1500 µs header, 35 bits or more ended by a long
 * high pulse; the bit count names the variant, and only the 51-bit dynamic one carries serial, button and counter.
 */
class PPScherKhan : PPDecoder("Scher-Khan", PPModulation.FM, PPConst(750, 1100, 160, 35)) {
    companion object {
        private const val STEP_RESET = 0; private const val STEP_CHECK_PREAMBULA = 1; private const val STEP_SAVE_DURATION = 2; private const val STEP_CHECK_DURATION = 3
    }

    private var protocolName = ""

    override fun feed(level: Boolean, duration: Int) {
        val teShort = c.teShort; val teLong = c.teLong; val teDelta = c.teDelta
        when (parserStep) {
            STEP_RESET -> if (level && dd(duration, teShort * 2) < teDelta) {
                parserStep = STEP_CHECK_PREAMBULA; teLast = duration; headerCount = 0
            }
            STEP_CHECK_PREAMBULA -> if (level) {
                if (dd(duration, teShort * 2) < teDelta || dd(duration, teShort) < teDelta) teLast = duration
                else parserStep = STEP_RESET
            } else if (dd(duration, teShort * 2) < teDelta || dd(duration, teShort) < teDelta) {
                if (dd(teLast, teShort * 2) < teDelta) {
                    headerCount++   // found header
                } else if (dd(teLast, teShort) < teDelta) {
                    // found start bit
                    if (headerCount >= 2) { parserStep = STEP_SAVE_DURATION; decodeData = 0; decodeCountBit = 1 }
                    else parserStep = STEP_RESET
                } else parserStep = STEP_RESET
            } else parserStep = STEP_RESET
            STEP_SAVE_DURATION -> if (level) {
                if (duration >= teDelta * 2 + teLong) {
                    // found stop bit
                    parserStep = STEP_RESET
                    if (decodeCountBit >= c.minBits) {
                        data = decodeData; dataCountBit = decodeCountBit
                        emit()
                    }
                    decodeData = 0; decodeCountBit = 0
                } else { teLast = duration; parserStep = STEP_CHECK_DURATION }
            } else parserStep = STEP_RESET
            STEP_CHECK_DURATION -> if (!level) {
                if (dd(teLast, teShort) < teDelta && dd(duration, teShort) < teDelta) { addBit(0); parserStep = STEP_SAVE_DURATION }
                else if (dd(teLast, teLong) < teDelta && dd(duration, teLong) < teDelta) { addBit(1); parserStep = STEP_SAVE_DURATION }
                else parserStep = STEP_RESET
            } else parserStep = STEP_RESET
        }
    }

    /** subghz_protocol_scher_khan_check_remote_controller. */
    private fun checkRemoteController() {
        serial = 0; btn = 0; cnt = 0
        when (dataCountBit) {
            35 -> protocolName = "MAGIC CODE, Static"
            51 -> {
                protocolName = "MAGIC CODE, Dynamic"
                serial = (((data ushr 24) and 0xFFFFFF0) or ((data ushr 20) and 0x0F)) and M32
                btn = ((data ushr 24) and 0x0F).toInt()
                cnt = data and 0xFFFF
            }
            57 -> protocolName = "MAGIC CODE PRO/PRO2"
            63 -> protocolName = "MAGIC CODE, Response"
            64 -> protocolName = "MAGICAR, Response"
            81, 82 -> protocolName = "MAGIC CODE PRO,\n Response"
            else -> protocolName = "Unknown"
        }
    }

    override fun describe(): PPHit {
        checkRemoteController()
        val key = hx("0x%X%08X", (data ushr 32) and M32, data and M32)
        return PPHit(name, dataCountBit, key, serial, hx("%X", btn.toLong()), cnt, listOf(MeshField("Pt", protocolName)))
    }

    /**
     * scher_khan.c get_string: "%s %dbit\r\nKey:0x%lX%08lX\r\nSn:%07lX Btn:%X\r\nCntr:%04lX\r\nPt: %s\r\n".
     * The 81/82-bit name holds a bare "\n", which the harness also turns into " | ".
     */
    override fun cString(h: PPHit): String =
        "${h.name} ${h.bits}bit | Key:${h.key} | " + hx("Sn:%07X", h.serial ?: 0) + " Btn:${h.btn ?: ""}" +
            " | " + hx("Cntr:%04X", h.cnt ?: 0) +
            " | Pt: ${(h.fields.firstOrNull()?.value ?: "").replace("\n", " | ")}"
}
