package com.rocketgod.mayhem.core.apps.ism

/**
 * One decoded remote frame. [serial] is Mayhem's uint32 serial (0 when the protocol has none); [btn] / [cnt] are null
 * when Mayhem leaves them at SD_NO_BTN / SD_NO_CNT. [extra] holds the additional "key: value" lines the Mayhem detail
 * view prints for special protocols (restaurant pager station/pager/action, KeeLoq fix/encrypted/manufacturer, FAAC seed).
 */
data class RemoteInfo(val name: String, val serial: Long, val btn: Int?, val cnt: Int?, val extra: List<String>)

/**
 * Field extraction per remote type (Mayhem ui_subghzd.cpp SubGhzDRecentEntryDetailView::parseProtocol + update_data +
 * SubGhzDView::getSensorTypeName). Mayhem's serial / cnt are uint32 and btn is uint8, so every assignment truncates the
 * same way here; serial is kept as an unsigned value in a Long, cnt is the 32-bit value reinterpreted as Int.
 */
object RemoteFields {
    fun name(type: Int): String = when (type) {
        S.PRINCETON -> "Princeton"; S.BETT -> "Bett"; S.CAME -> "Came"; S.PRASTEL -> "Prastel"; S.AIRFORCE -> "Airforce"
        S.CAME_ATOMO -> "Came Atomo"; S.CAME_TWEE -> "Came Twee"; S.CHAMBCODE -> "Chamb Code"; S.CLEMSA -> "Clemsa"; S.DOITRAND -> "Doitrand"
        S.DOOYA -> "Dooya"; S.FAAC -> "Faac"; S.GATE_TX -> "Gate TX"; S.HOLTEK -> "Holtek"; S.HOLTEK_HT12X -> "Holtek HT12X"
        S.HONEYWELL -> "Honeywell"; S.HONEYWELL_WDB -> "Honeywell Wdb"; S.HORMANN -> "Hormann"; S.IDO -> "Ido 11x"; S.INTERTECHNO_V3 -> "Intertechno v3"
        S.SUPERROLLO -> "Superrollo"; S.KEELOQ -> "KeeLoq"; S.KINGGATES_STYLO_4K -> "Kinggate Stylo4K"; S.LINEAR -> "Linear"; S.LINEAR_DELTA3 -> "Linear Delta3"
        S.MAGELLAN -> "Magellan"; S.MARANTEC -> "Marantec"; S.MASTERCODE -> "Mastercode"; S.MEGACODE -> "Megacode"; S.NERO_RADIO -> "Nero Radio"
        S.NERO_SKETCH -> "Nero Sketch"; S.NICE_FLO -> "Nice Flo"; S.NICE_FLORS -> "Nice Flor S"; S.PHOENIX_V2 -> "Phoenix V2"; S.POWER_SMART -> "PowerSmart"
        S.SECPLUS_V1 -> "SecPlus V1"; S.SECPLUS_V2 -> "SecPlus V2"; S.SMC5326 -> "SMC5326"; S.STARLINE -> "Star Line"; S.X10 -> "X10"
        S.LEGRAND -> "Legrand"; S.SOMFY_KEYTIS -> "Somfy Keytis"; S.SOMFY_TELIS -> "Somfy Telis"; S.GANGQI -> "GangQi"; S.MARANTEC24 -> "Marantec24"
        S.HOLTEK_HT6P20B -> "Holtek HT6P20B"; S.RESTAURANT_PAGER -> "Rest. Pager"
        else -> "Unknown"
    }

    private const val M32 = 0xFFFFFFFFL
    private fun u32(v: Long): Long = v and M32
    private fun hex8(v: Long): String = "%08X".format(v and M32)
    private fun hex2(v: Int): String = "%02X".format(v and 0xFF)

    private val CAME_TWEE_MAGIC_NUMBERS_XOR = longArrayOf(
        0x0E0E0E00L, 0x1D1D1D11L, 0x2C2C2C22L, 0x3B3B3B33L, 0x4A4A4A44L, 0x59595955L, 0x68686866L, 0x77777777L,
        0x86868688L, 0x95959599L, 0xA4A4A4AAL, 0xB3B3B3BBL, 0xC2C2C2CCL, 0xD1D1D1DDL, 0xE0E0E0EEL,
    )

    private fun atomoDecrypt(buff: IntArray) {
        buff[0] = (buff[0] xor 5) and 0x7F
        var tmpB = (-buff[0]) and 0x7F
        var bitCnt = 8
        while (bitCnt < 59) {
            tmpB = if ((tmpB and 0x18) != 0 && (((tmpB / 8) and 3) != 3)) ((tmpB shl 1) and 0xFF) or 1 else (tmpB shl 1) and 0xFF
            if ((tmpB and 0x80) != 0) buff[bitCnt / 8] = buff[bitCnt / 8] xor (0x80 ushr (bitCnt and 7))
            bitCnt++
        }
    }

    fun parse(type: Int, data: Long, bits: Int): RemoteInfo {
        val name = name(type)
        var serial = 0L; var btn: Int? = null; var cnt: Int? = null
        val extra = ArrayList<String>(0)
        when (type) {
            S.CAME_ATOMO -> {
                val d = (data xor -1L) shl 4
                val pack = IntArray(8) { ((d ushr (56 - it * 8)) and 0xFF).toInt() }
                atomoDecrypt(pack)
                cnt = (pack[1] shl 8) or pack[2]
                serial = u32((pack[3].toLong() shl 24) or (pack[4].toLong() shl 16) or (pack[5].toLong() shl 8) or pack[6].toLong())
                when (pack[7] ushr 4) { 0x0 -> btn = 0x1; 0x2 -> btn = 0x2; 0x4 -> btn = 0x3; 0x6 -> btn = 0x4 }
            }
            S.CAME_TWEE -> {
                val cntParcel = (data and 0xF).toInt()
                // Mayhem indexes the 15-entry table unguarded (UB for parcel 15); the protocol never emits it, so yield nothing.
                if (cntParcel >= CAME_TWEE_MAGIC_NUMBERS_XOR.size) return RemoteInfo(name, serial, btn, cnt, extra)
                var d = u32(data) xor CAME_TWEE_MAGIC_NUMBERS_XOR[cntParcel]
                serial = d
                d /= 4
                btn = ((d ushr 4) and 0x0F).toInt()
                d = d ushr 16
                d = FG.reverseKey(d, 16) and 0xFFFF
                cnt = (d ushr 6).toInt()
            }
            S.CLEMSA -> { serial = (data ushr 2) and 0xFFFF; btn = (data and 0x03).toInt() }
            S.DOITRAND -> { cnt = u32((data ushr 24) or ((data ushr 15) and 0x1)).toInt(); btn = ((data ushr 18) and 0x3).toInt() }
            S.DOOYA -> {
                serial = u32(data ushr 16)
                cnt = if (((data ushr 12) and 0x0F) != 0L) ((data ushr 8) and 0x0F).toInt() else 0xff
                btn = (data and 0xFF).toInt()
            }
            S.FAAC -> {
                val codeFix = u32(data ushr 32); val codeHop = u32(data)
                val p = IntArray(8)
                p[0] = (codeHop and 0xFF).toInt(); p[1] = ((codeHop ushr 8) and 0xFF).toInt(); p[2] = ((codeHop ushr 16) and 0xFF).toInt(); p[3] = (codeHop ushr 24).toInt()
                p[4] = (codeFix and 0xFF).toInt(); p[5] = ((codeFix ushr 8) and 0xFF).toInt(); p[6] = ((codeFix ushr 16) and 0xFF).toInt(); p[7] = (codeFix ushr 24).toInt()
                if (p[7] == 0x52 && p[6] == 0x0F && p[0] == 0x00) {
                    var i = p[1] and 0xF
                    while (i != 0) {
                        val tmp = p[2]
                        p[2] = (p[2] ushr 1) or ((p[3] and 1) shl 7)
                        p[3] = (p[3] ushr 1) or ((p[4] and 1) shl 7)
                        p[4] = (p[4] ushr 1) or ((p[5] and 1) shl 7)
                        p[5] = (p[5] ushr 1) or ((tmp and 1) shl 7)
                        i--
                    }
                    p[2] = p[2] xor p[1]; p[3] = p[3] xor p[1]; p[4] = p[4] xor p[1]; p[5] = p[5] xor p[1]
                    val seed = (p[5].toLong() shl 24) or (p[4].toLong() shl 16) or (p[3].toLong() shl 8) or p[2].toLong()
                    cnt = p[1]
                    extra.add("Seed: " + hex8(seed))
                } else if (codeFix != 0L) { serial = codeFix ushr 4; btn = (codeFix and 0xF).toInt() }
            }
            S.GATE_TX -> {
                val r = u32(FG.reverseKey(data, bits))
                serial = u32(((r and 0xFF) shl 12) or (((r ushr 8) and 0xFF) shl 4) or ((r ushr 20) and 0x0F))
                btn = ((r ushr 16) and 0x0F).toInt()
            }
            S.HOLTEK -> {
                if ((data and 0xF000000000L) == 0x5000000000L) {
                    serial = u32(FG.reverseKey((data ushr 16) and 0xFFFFF, 20))
                    val b = (data and 0xFFFF).toInt()
                    btn = if ((b and 0xf) != 0xA) (0x1 shl 4) or (b and 0xF)
                    else if (((b ushr 4) and 0xF) != 0xA) (0x2 shl 4) or ((b ushr 4) and 0xF)
                    else if (((b ushr 8) and 0xF) != 0xA) (0x3 shl 4) or ((b ushr 8) and 0xF)
                    else if (((b ushr 12) and 0xF) != 0xA) (0x4 shl 4) or ((b ushr 12) and 0xF)
                    else 0
                } else { serial = 0; btn = 0; cnt = 0 }
            }
            S.HOLTEK_HT12X -> { btn = (data and 0x0F).toInt(); cnt = ((data ushr 4) and 0xFF).toInt() }
            S.HONEYWELL -> { serial = (data ushr 24) and 0xFFFFF; btn = ((data ushr 16) and 0xFF).toInt(); cnt = ((data ushr 44) and 0xF).toInt() }
            S.HONEYWELL_WDB -> serial = (data ushr 28) and 0xFFFFF
            S.HORMANN -> btn = ((data ushr 8) and 0xF).toInt()
            S.IDO -> {
                val codeFix = FG.reverseKey(data, bits) and 0xFFFFFF
                serial = codeFix and 0xFFFFF; btn = ((codeFix ushr 20) and 0x0F).toInt()
            }
            S.INTERTECHNO_V3 -> {
                if (bits == 32) {
                    serial = (data ushr 6) and 0x3FFFFFF
                    cnt = if (((data ushr 5) and 0x1) != 0L) 1 shl 5 else (data.inv() and 0xF).toInt()
                    btn = ((data ushr 4) and 0x1).toInt()
                } else if (bits == 36) {
                    serial = (data ushr 10) and 0x3FFFFFF
                    cnt = if (((data ushr 9) and 0x1) != 0L) 1 shl 5 else ((data ushr 4).inv() and 0xF).toInt()
                    btn = (data and 0xF).toInt()
                } else { serial = 0; cnt = 0; btn = 0 }
            }
            S.KEELOQ, S.SUPERROLLO -> {
                // No manufacturer keystore here: raw fix/hop split only, cnt stays absent and manufacturer is unknown.
                val rev = FG.reverseKey(data, 64)
                btn = (rev ushr 60).toInt()
                serial = (rev ushr 32) and 0xFFFFFFF
                val fix = u32(rev ushr 32); val encrypted = u32(rev)
                extra.add("Fix: " + hex8(fix)); extra.add("Encrypted: " + hex8(encrypted)); extra.add("Manufacturer: Unknown")
            }
            S.KINGGATES_STYLO_4K -> {
                val fix = FG.reverseKey(data, 53)
                btn = ((fix ushr 17) and 0x0F).toInt()
                serial = u32(((fix ushr 5) and 0xFFFF0000L) or (fix and 0xFFFF))
            }
            S.MAGELLAN -> { val rev = FG.reverseKey(data ushr 8, 24); serial = rev and 0xFFFF; btn = ((rev ushr 16) and 0xFF).toInt() }
            S.MARANTEC -> { btn = ((data ushr 16) and 0xF).toInt(); serial = u32(((data ushr 12) and 0xFFFFFF00L) or ((data ushr 8) and 0xFF)) }
            S.MASTERCODE -> { serial = (data ushr 4) and 0xFFFF; btn = ((data ushr 2) and 0x03).toInt() }
            S.MEGACODE -> {
                if ((data ushr 23) == 1L) { serial = (data ushr 3) and 0xFFFF; btn = (data and 0b111).toInt(); cnt = ((data ushr 19) and 0b1111).toInt() }
                else { serial = 0; btn = 0; cnt = 0 }
            }
            S.PHOENIX_V2 -> {
                // Mayhem reverses bits + 4 (52-bit frames -> 56); clamp to 64 so an oversized bit count stays defined.
                val rev = FG.reverseKey(data, minOf(bits + 4, 64))
                serial = u32(rev); cnt = ((rev ushr 40) and 0xFFFF).toInt(); btn = ((rev ushr 32) and 0xF).toInt()
            }
            S.POWER_SMART -> {
                btn = (((data ushr 54) and 0x02) or ((data ushr 40) and 0x1)).toInt()
                serial = ((data ushr 33) and 0x3FFF00) or ((data ushr 32) and 0xFF)
                cnt = ((data ushr 49) and 0x3F).toInt()
            }
            S.PRINCETON -> { serial = u32(data ushr 4); btn = (data and 0xF).toInt() }
            S.SECPLUS_V1 -> {
                val fixed = u32(data ushr 32)
                cnt = u32(data).toInt()
                btn = (fixed % 3).toInt()
                val id1 = (fixed / 9) % 3
                serial = if (id1 == 0L) (fixed / 27) % 2187 else fixed / 27
            }
            S.STARLINE -> {
                val keyFix = u32(FG.reverseKey(data, bits) ushr 32)
                serial = keyFix and 0x00FFFFFF; btn = (keyFix ushr 24).toInt()
            }
            S.X10 -> {
                serial = (data and 0xF0000000L) ushr (24 + 4)
                btn = (((data and 0x07000000L) ushr 24) or ((data and 0xF800) ushr 8)).toInt() and 0xFF
            }
            S.SOMFY_KEYTIS -> {
                val d = data xor (data ushr 8)
                btn = ((d ushr 48) and 0xF).toInt(); cnt = ((d ushr 24) and 0xFFFF).toInt(); serial = d and 0xFFFFFF
            }
            S.SOMFY_TELIS -> {
                val d = data xor (data ushr 8)
                btn = ((d ushr 44) and 0xF).toInt(); cnt = ((d ushr 24) and 0xFFFF).toInt(); serial = d and 0xFFFFFF
            }
            S.GANGQI -> { btn = 0; cnt = ((data ushr 32) and 0xFF).toInt(); serial = u32(data) }
            S.MARANTEC24 -> { serial = u32(data ushr 4); btn = (data and 0xf).toInt() }
            S.HOLTEK_HT6P20B -> { serial = u32(data ushr 8); btn = ((data ushr 4) and 0xF).toInt() }
            S.RESTAURANT_PAGER -> {
                // 25-bit EV1527-variant: [sysid:16][pager:4][func:4][stop:1]
                serial = (data ushr 9) and 0xFFFF
                val pagerAddr = ((data ushr 5) and 0x0F).toInt()
                val funcCode = ((data ushr 1) and 0x0F).toInt()
                extra.add("Station: 0x" + hex8(serial) + " (" + serial + ")")
                extra.add("Pager: $pagerAddr")
                extra.add(if (funcCode == 0x0D) "Action: Buzz" else if (funcCode == 0x0F) "Action: Sync" else "Action: 0x" + hex2(funcCode))
            }
            // BETT, CAME/PRASTEL/AIRFORCE, CHAMBCODE, LEGRAND, LINEAR(_DELTA3), NERO_*, NICE_FLO(RS), SECPLUS_V2, SMC5326: nothing in Mayhem.
            else -> {}
        }
        return RemoteInfo(name, serial, btn, cnt, extra)
    }
}
