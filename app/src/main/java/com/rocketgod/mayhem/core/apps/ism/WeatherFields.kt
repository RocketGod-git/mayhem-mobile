package com.rocketgod.mayhem.core.apps.ism

/** One weather reading. Null = the sensor doesn't send that field. */
data class WeatherInfo(val name: String, val id: Long, val channel: Int?, val batteryLow: Boolean?, val temp: Float?, val humidity: Int?)

/** Field extraction per sensor type (Mayhem ui_weatherstation.cpp process_data + getWeatherSensorTypeName). */
object WeatherFields {
    fun name(type: Int): String = when (type) {
        W.NEXUS_TH -> "Nexus-TH"; W.ACURITE_592TXR -> "Acurite 592TXR"; W.ACURITE_606TX -> "Acurite 606TX"; W.ACURITE_609TX -> "Acurite 609TXC"
        W.AMBIENT -> "Ambient Weather"; W.AURIOL_AHFL -> "Auriol AHFL"; W.AURIOL_TH -> "Auriol TH"; W.GT_WT02 -> "GT-WT02"; W.GT_WT03 -> "GT-WT03"
        W.INFACTORY -> "inFactory"; W.LACROSSE_TX -> "LaCrosse TX"; W.LACROSSE_TX141THBV2 -> "LaCrosse TX141TH-Bv2"; W.OREGON2 -> "Oregon v2"
        W.OREGON2B -> "Oregon v2 THGR122N"; W.OREGON3 -> "Oregon v3"; W.OREGON_V1 -> "Oregon v1"; W.THERMOPRO_TX4 -> "ThermoPro TX4"; W.TX_8300 -> "TX8300"
        W.WENDOX_W6726 -> "Wendox W6726"; W.ACURITE_986 -> "Acurite 986"; W.KEDSUM -> "Kedsum"; W.ACURITE_5IN1 -> "Acurite 5-in-1"; W.EMOS_E601X -> "EMOS E601x"
        W.SOLIGHT_TE44 -> "Solight TE44"; W.BRESSER_3CH -> "Bresser 3CH"; W.BRESSER_3CH_V1 -> "Bresser 3CH v1"; W.VAUNO_EN8822 -> "Vauno EN8822"
        else -> "Unknown"
    }

    private fun bcdShort(d: Long): Int = ((d and 0xF).toInt()) * 10 + ((d ushr 4) and 0xF).toInt()
    private fun tempSign11(d: Long, shift: Int): Float =
        if (((d ushr (shift + 11)) and 1L) == 0L) ((d ushr shift) and 0x07FF).toInt() / 10.0f
        else (((d ushr shift).inv() and 0x07FF).toInt() + 1) / -10.0f
    private fun s12(v: Int): Int = if (v and 0x800 != 0) v or -0x1000 else v
    private val CH_3021 = intArrayOf(3, 0, 2, 1)

    fun parse(type: Int, d: Long): WeatherInfo {
        var id = 0L; var ch: Int? = null; var batt: Boolean? = null; var temp: Float? = null; var hum: Int? = null
        when (type) {
            W.NEXUS_TH -> {
                id = (d ushr 28) and 0xFF; batt = ((d ushr 27) and 1L) == 0L; ch = ((d ushr 24) and 0x03).toInt() + 1
                temp = tempSign11(d, 12)
                hum = (d and 0xFF).toInt().coerceIn(20, 95)
            }
            W.ACURITE_592TXR -> {
                ch = CH_3021[((d ushr 54) and 0x03).toInt()]; id = (d ushr 40) and 0x3FFF; batt = ((d ushr 38) and 1L) == 0L
                hum = ((d ushr 24) and 0x7F).toInt()
                val u16 = (((d ushr 9) and 0xF80) or ((d ushr 8) and 0x7F)).toInt()
                temp = (u16 - 1000) / 10.0f
            }
            W.ACURITE_606TX -> { id = (d ushr 24) and 0xFF; batt = ((d ushr 23) and 1L) != 0L; temp = tempSign11(d, 8) }
            W.ACURITE_609TX -> {
                id = (d ushr 32) and 0xFF; batt = ((d ushr 31) and 1L) != 0L
                val i16 = ((((d ushr 12) and 0xf000) or (((d ushr 16) shl 4) and 0xFFFF)).toInt()).toShort().toInt()
                temp = (i16 shr 4) * 0.1f
                hum = ((d ushr 8) and 0xff).toInt()
            }
            W.AMBIENT -> {
                id = (d ushr 32) and 0xFF; batt = ((d ushr 31) and 1L) != 0L; ch = ((d ushr 28) and 0x07).toInt() + 1
                temp = FG.fToC((((d ushr 16) and 0x0FFF).toInt() - 400.0f) / 10.0f); hum = ((d ushr 8) and 0xFF).toInt()
            }
            W.AURIOL_AHFL -> {
                id = d ushr 34; batt = ((d ushr 33) and 1L) != 0L; ch = ((d ushr 30) and 0x3).toInt() + 1
                temp = tempSign11(d, 18); hum = ((d ushr 11) and 0x7F).toInt()
            }
            W.AURIOL_TH -> {
                id = (d ushr 31) and 0xFF; batt = ((d ushr 30) and 1L) != 0L; ch = ((d ushr 25) and 0x03).toInt() + 1
                temp = tempSign11(d, 13); hum = ((d ushr 1) and 0x7F).toInt()
            }
            W.GT_WT02 -> {
                id = (d ushr 29) and 0xFF; batt = ((d ushr 28) and 1L) != 0L; ch = ((d ushr 25) and 0x3).toInt() + 1
                temp = tempSign11(d, 13)
                val h = ((d ushr 6) and 0x7F).toInt(); hum = if (h <= 10) 0 else if (h > 90) 100 else h
            }
            W.GT_WT03 -> {
                id = d ushr 33
                val h = ((d ushr 25) and 0xFF).toInt(); hum = if (h <= 10) 0 else if (h > 95) 100 else h
                batt = ((d ushr 24) and 1L) != 0L; ch = ((d ushr 21) and 0x03).toInt() + 1; temp = tempSign11(d, 9)
            }
            W.INFACTORY -> {
                id = d ushr 32; batt = ((d ushr 26) and 1L) != 0L
                temp = FG.fToC((((d ushr 12) and 0x0FFF).toInt() - 900.0f) / 10.0f)
                hum = (((d ushr 8) and 0x0F).toInt() * 10) + ((d ushr 4) and 0x0F).toInt(); ch = (d and 0x03).toInt()
            }
            W.LACROSSE_TX -> {
                val u8 = ((d ushr 32) and 0x0F).toInt()
                id = ((((d ushr 28) and 0x0F) shl 3) or (((d ushr 24) and 0x0F) ushr 1))
                val flo = ((d ushr 20) and 0x0F).toInt() * 10.0f + ((d ushr 16) and 0x0F).toInt() + ((d ushr 12) and 0x0F).toInt() * 0.1f
                if (u8 == 0x00) temp = flo - 50.0f else if (u8 == 0x0E) hum = flo.toInt()
            }
            W.LACROSSE_TX141THBV2 -> {
                id = d ushr 32; batt = ((d ushr 31) and 1L) != 0L; ch = ((d ushr 28) and 0x03).toInt() + 1
                temp = (((d ushr 16) and 0x0FFF).toInt() - 500.0f) / 10.0f; hum = ((d ushr 8) and 0xFF).toInt()
            }
            W.OREGON2 -> {
                var i32 = bcdShort(d ushr 4) * 10 + ((d ushr 12) and 0xf).toInt(); if ((d and 0xF) != 0L) i32 = -i32
                temp = i32 / 10.0f; batt = ((d ushr 32) and 0x4) != 0L
                var u8 = ((d ushr 44) and 0xF).toInt(); var c = 1; while (u8 > 1) { c++; u8 = u8 ushr 1 }; ch = c
            }
            W.OREGON2B -> {
                hum = bcdShort(d); val u64 = d ushr 8
                var i32 = bcdShort(u64 ushr 4) * 10 + ((u64 ushr 12) and 0xf).toInt(); if ((u64 and 0xF) != 0L) i32 = -i32
                temp = i32 / 10.0f; batt = ((d ushr 32) and 0x4) != 0L
                var u8 = ((d ushr 44) and 0xF).toInt(); var c = 1; while (u8 > 1) { c++; u8 = u8 ushr 1 }; ch = c
            }
            W.OREGON3 -> {
                hum = ((d ushr 4) and 0xF).toInt() * 10 + (((d ushr 4) ushr 4) and 0xF).toInt()
                var i16 = ((((d ushr 12) ushr 4) and 0xF).toInt() * 10 + ((((d ushr 12) ushr 4) ushr 4) and 0xF).toInt()) * 10 + (((d ushr 12) ushr 12) and 0xF).toInt()
                if (((d ushr 12) and 0xF) != 0L) i16 = -i16
                temp = i16 / 10.0f
            }
            W.OREGON_V1 -> {
                val u64 = FG.reverseKey(d, 32)
                id = u64 and 0xFF; ch = ((u64 ushr 6) and 0x03).toInt() + 1
                var t = ((u64 ushr 8) and 0x0F).toInt() * 0.1f + ((u64 ushr 12) and 0x0F).toInt() + ((u64 ushr 16) and 0x0F).toInt() * 10.0f
                if (((u64 ushr 21) and 1L) != 0L) t = -t
                temp = t; batt = ((u64 ushr 23) and 1L) == 0L
            }
            W.THERMOPRO_TX4 -> {
                id = (d ushr 25) and 0xFF; batt = ((d ushr 24) and 1L) != 0L; ch = ((d ushr 21) and 0x03).toInt() + 1
                temp = tempSign11(d, 9); hum = ((d ushr 1) and 0xFF).toInt()
            }
            W.TX_8300 -> {
                hum = (((d ushr 28) and 0x0F).toInt() * 10) + ((d ushr 24) and 0x0F).toInt()
                batt = ((d ushr 22) and 0x03) != 0L; ch = ((d ushr 20) and 0x03).toInt(); id = (d ushr 12) and 0x7F
                var t = ((d ushr 8) and 0x0F).toInt() * 10.0f + ((d ushr 4) and 0x0F).toInt() + (d and 0x0F).toInt() * 0.1f
                if (((d ushr 19) and 1L) != 0L) t = -t
                temp = t
            }
            W.WENDOX_W6726 -> {
                id = (d ushr 24) and 0xFF; batt = ((d ushr 6) and 1L) != 0L
                var t = if (((d ushr 23) and 1L) != 0L) (((d ushr 14) and 0x1FF).toInt() + 12) / 10.0f else ((((d ushr 14).inv() and 0x1FF).toInt() + 1 - 12)) / -10.0f
                temp = t.coerceIn(-50.0f, 70.0f)
            }
            W.ACURITE_986 -> {
                id = (FG.reverseKey(d ushr 24, 8) shl 8) or FG.reverseKey(d ushr 16, 8)
                batt = ((d ushr 14) and 1L) != 0L; ch = ((d ushr 15) and 1L).toInt() + 1
                var i16 = FG.reverseKey(d ushr 32, 8).toInt(); if (i16 and 0x80 != 0) i16 = -(i16 and 0x7F)
                temp = FG.fToC(i16.toFloat())
            }
            W.KEDSUM -> {
                id = d ushr 32; batt = ((d ushr 30) and 0x3) == 0L; ch = ((d ushr 28) and 0x3).toInt() + 1
                val u16 = (((d ushr 16) and 0x0f) shl 8).toInt() or (((d ushr 20) and 0x0f) shl 4).toInt() or ((d ushr 24) and 0x0f).toInt()
                temp = FG.fToC((u16 - 900.0f) / 10.0f)
                hum = (((d ushr 8) and 0x0f) shl 4).toInt() or ((d ushr 12) and 0x0f).toInt()
            }
            W.ACURITE_5IN1 -> {
                ch = CH_3021[((d ushr 62) and 0x03).toInt()]; id = (d ushr 48) and 0x3FFF; batt = ((d ushr 46) and 1L) == 0L
                hum = ((d ushr 8) and 0x7F).toInt()
                val u16 = (((d ushr (24 - 7)) and 0x780) or ((d ushr 16) and 0x7F)).toInt()
                temp = FG.fToC((u16 - 400) / 10.0f)
            }
            W.EMOS_E601X -> {
                id = 0xffff; batt = ((d ushr 10) and 1L) != 0L
                temp = s12(((d ushr 40) and 0xfff).toInt()) / 10.0f; hum = ((d ushr 32) and 0xff).toInt(); ch = ((d ushr 52) and 0x03).toInt()
            }
            W.SOLIGHT_TE44 -> {
                id = (d ushr 28) and 0xff; batt = ((d ushr 27) and 1L) == 0L; ch = ((d ushr 24) and 0x03).toInt() + 1
                temp = s12(((d ushr 12) and 0x0fff).toInt()) / 10.0f
            }
            W.BRESSER_3CH -> {
                id = (d ushr 28) and 0xff; ch = (((d ushr 27) and 1L) or (((d ushr 26) and 1L) shl 1)).toInt(); batt = ((d ushr 24) and 1L) != 0L
                temp = s12(((d ushr 12) and 0x0fff).toInt()) / 10.0f; hum = (d and 0xff).toInt()
            }
            W.BRESSER_3CH_V1 -> {
                id = (d ushr 32) and 0xff; batt = ((d ushr 31) and 1L) != 0L; ch = ((d ushr 28) and 0x3).toInt()
                temp = FG.fToC((((d ushr 16) and 0xfff).toInt() - 900) / 10.0f); hum = ((d ushr 8) and 0xff).toInt()
            }
            W.VAUNO_EN8822 -> {
                id = (d ushr 34) and 0xff; batt = ((d ushr 33) and 1L) != 0L; ch = ((d ushr 30) and 0x03).toInt()
                temp = s12(((d ushr 18) and 0x0fff).toInt()) / 10.0f; hum = ((d ushr 11) and 0x7f).toInt()
            }
        }
        return WeatherInfo(name(type), id, ch, batt, temp, hum)
    }
}
