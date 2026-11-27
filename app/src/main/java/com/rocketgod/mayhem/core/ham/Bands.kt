package com.rocketgod.mayhem.core.ham

import com.rocketgod.mayhem.core.ham.HamDemod.Mode

/** Amateur band plan (IARU Region 2 / FCC flavoured), with the mode, step and repeater offset each band expects. */
data class Band(
    val id: String,
    val name: String,
    val lo: Long,
    val hi: Long,
    val mode: Mode,
    val step: Long,
    val offset: Long? = null,     // repeater offset where the band has repeaters
    val calling: Long? = null,    // a sensible place to land
    val segments: List<Triple<Long, Long, String>>,
)

val BANDS = listOf(
    Band("160m", "160 m", 1_800_000, 2_000_000, Mode.LSB, 500, calling = 1_850_000,
        segments = listOf(Triple(1_800_000L, 1_840_000L, "CW / digital"), Triple(1_840_000L, 2_000_000L, "phone"))),
    Band("80m", "80 m", 3_500_000, 4_000_000, Mode.LSB, 500, calling = 3_850_000,
        segments = listOf(Triple(3_500_000L, 3_600_000L, "CW / digital"), Triple(3_573_000L, 3_576_000L, "FT8"), Triple(3_600_000L, 4_000_000L, "phone"))),
    Band("40m", "40 m", 7_000_000, 7_300_000, Mode.LSB, 500, calling = 7_200_000,
        segments = listOf(Triple(7_000_000L, 7_125_000L, "CW / digital"), Triple(7_074_000L, 7_077_000L, "FT8"), Triple(7_125_000L, 7_300_000L, "phone"))),
    Band("30m", "30 m", 10_100_000, 10_150_000, Mode.CW, 100, calling = 10_136_000,
        segments = listOf(Triple(10_100_000L, 10_130_000L, "CW"), Triple(10_130_000L, 10_150_000L, "digital · FT8 10.136"))),
    Band("20m", "20 m", 14_000_000, 14_350_000, Mode.USB, 500, calling = 14_074_000,
        segments = listOf(Triple(14_000_000L, 14_150_000L, "CW / digital"), Triple(14_074_000L, 14_077_000L, "FT8"), Triple(14_150_000L, 14_350_000L, "phone"))),
    Band("17m", "17 m", 18_068_000, 18_168_000, Mode.USB, 500, calling = 18_100_000,
        segments = listOf(Triple(18_068_000L, 18_110_000L, "CW / digital"), Triple(18_110_000L, 18_168_000L, "phone"))),
    Band("15m", "15 m", 21_000_000, 21_450_000, Mode.USB, 500, calling = 21_074_000,
        segments = listOf(Triple(21_000_000L, 21_200_000L, "CW / digital"), Triple(21_074_000L, 21_077_000L, "FT8"), Triple(21_200_000L, 21_450_000L, "phone"))),
    Band("12m", "12 m", 24_890_000, 24_990_000, Mode.USB, 500, calling = 24_915_000,
        segments = listOf(Triple(24_890_000L, 24_930_000L, "CW / digital"), Triple(24_930_000L, 24_990_000L, "phone"))),
    Band("10m", "10 m", 28_000_000, 29_700_000, Mode.USB, 1000, offset = -100_000, calling = 28_400_000,
        segments = listOf(Triple(28_000_000L, 28_300_000L, "CW / digital"), Triple(28_074_000L, 28_077_000L, "FT8"),
            Triple(28_300_000L, 29_000_000L, "phone"), Triple(29_000_000L, 29_700_000L, "FM · repeaters 29.62–29.68"))),
    Band("6m", "6 m", 50_000_000, 54_000_000, Mode.USB, 1000, offset = -500_000, calling = 50_125_000,
        segments = listOf(Triple(50_000_000L, 50_100_000L, "CW"), Triple(50_100_000L, 50_300_000L, "SSB · 50.125 calling"),
            Triple(50_313_000L, 50_316_000L, "FT8"), Triple(51_000_000L, 54_000_000L, "FM · repeaters"))),
    Band("2m", "2 m", 144_000_000, 148_000_000, Mode.NFM, 12_500, offset = -600_000, calling = 146_520_000,
        segments = listOf(Triple(144_000_000L, 144_300_000L, "CW / SSB · 144.200 calling"), Triple(144_174_000L, 144_177_000L, "FT8"),
            Triple(144_390_000L, 144_390_000L, "APRS"), Triple(145_100_000L, 145_500_000L, "repeater outputs (−600)"),
            Triple(145_800_000L, 146_000_000L, "satellites"), Triple(146_400_000L, 146_600_000L, "simplex · 146.520 calling"),
            Triple(146_610_000L, 147_390_000L, "repeaters (−/+600)"), Triple(147_420_000L, 147_570_000L, "simplex"))),
    Band("1.25m", "1.25 m", 222_000_000, 225_000_000, Mode.NFM, 20_000, offset = -1_600_000, calling = 223_500_000,
        segments = listOf(Triple(222_000_000L, 222_150_000L, "CW / SSB"), Triple(223_400_000L, 223_520_000L, "simplex · 223.500 calling"),
            Triple(223_850_000L, 224_980_000L, "repeaters (−1.6)"))),
    Band("70cm", "70 cm", 420_000_000, 450_000_000, Mode.NFM, 12_500, offset = 5_000_000, calling = 446_000_000,
        segments = listOf(Triple(432_000_000L, 432_300_000L, "CW / SSB · 432.100 calling"), Triple(435_000_000L, 438_000_000L, "satellites"),
            Triple(442_000_000L, 445_000_000L, "repeater outputs (+5)"), Triple(445_000_000L, 447_000_000L, "simplex · 446.000 calling"),
            Triple(447_000_000L, 450_000_000L, "repeater outputs (−5)"))),
    Band("33cm", "33 cm", 902_000_000, 928_000_000, Mode.NFM, 25_000, offset = -12_000_000, calling = 927_500_000,
        segments = listOf(Triple(902_000_000L, 928_000_000L, "shared with ISM"))),
    Band("23cm", "23 cm", 1_240_000_000, 1_300_000_000, Mode.NFM, 25_000, offset = -20_000_000, calling = 1_294_500_000,
        segments = listOf(Triple(1_240_000_000L, 1_300_000_000L, "FM / ATV / repeaters"))),
)

/** The US itinerant business channels any licensee may use, by their color dots and stars. */
private val ITINERANT = listOf(
    Triple(151_625_000L, 151_625_000L, "itinerant · red dot"), Triple(151_955_000L, 151_955_000L, "itinerant · purple dot"),
    Triple(464_500_000L, 464_500_000L, "itinerant · brown dot"), Triple(464_550_000L, 464_550_000L, "itinerant · yellow dot"),
    Triple(467_762_500L, 467_762_500L, "itinerant · J dot"), Triple(467_812_500L, 467_812_500L, "itinerant · K dot"),
    Triple(467_850_000L, 467_850_000L, "itinerant · silver star"), Triple(467_875_000L, 467_875_000L, "itinerant · gold star"),
    Triple(467_900_000L, 467_900_000L, "itinerant · red star"), Triple(467_925_000L, 467_925_000L, "itinerant · blue star"),
    Triple(469_500_000L, 469_500_000L, "itinerant"), Triple(469_550_000L, 469_550_000L, "itinerant"),
)

/** Earlier entries win where they overlap: the narrow services first, the business bands around them last. */
val NON_HAM = listOf(
    Band("air", "Air", 118_000_000, 137_000_000, Mode.AM, 25_000, calling = 121_500_000,
        segments = listOf(Triple(118_000_000L, 137_000_000L, "AM · 121.500 guard"))),
    Band("wx", "NOAA", 162_400_000, 162_550_000, Mode.NFM, 25_000, calling = 162_400_000,
        segments = listOf(Triple(162_400_000L, 162_550_000L, "weather radio"))),
    Band("rail", "Railroad", 160_215_000, 161_565_000, Mode.NFM, 7_500,
        segments = listOf(Triple(160_215_000L, 161_565_000L, "AAR road and yard channels"))),
    Band("marine", "Marine", 156_000_000, 162_025_000, Mode.NFM, 25_000, calling = 156_800_000,
        segments = listOf(Triple(156_000_000L, 162_025_000L, "VHF marine · ch 16 = 156.800"))),
    Band("frs", "FRS/GMRS", 462_550_000, 467_725_000, Mode.NFM, 12_500, calling = 462_562_500,
        segments = listOf(Triple(462_550_000L, 462_725_000L, "ch 1–7 / 15–22"), Triple(467_562_500L, 467_712_500L, "ch 8–14"))),
    Band("vhfbiz", "VHF Business", 150_000_000, 174_000_000, Mode.NFM, 2_500, calling = 151_820_000,
        segments = listOf(
            Triple(151_820_000L, 151_820_000L, "MURS 1"), Triple(151_880_000L, 151_880_000L, "MURS 2"), Triple(151_940_000L, 151_940_000L, "MURS 3"),
            Triple(154_570_000L, 154_570_000L, "MURS 4 · blue dot"), Triple(154_600_000L, 154_600_000L, "MURS 5 · green dot"),
        ) + ITINERANT.filter { it.first < 174_000_000L } + Triple(150_000_000L, 174_000_000L, "land mobile · 7.5 kHz channels")),
    Band("uhfbiz", "UHF Business", 450_000_000, 470_000_000, Mode.NFM, 6_250, offset = 5_000_000, calling = 464_500_000,
        segments = listOf(Triple(451_150_000L, 451_150_000L, "business repeater · DMR"), Triple(451_400_000L, 451_400_000L, "business repeater · DMR")) +
            ITINERANT.filter { it.first > 450_000_000L } + listOf(
            Triple(450_000_000L, 455_000_000L, "repeater outputs (+5)"), Triple(455_000_000L, 460_000_000L, "repeater inputs"),
            Triple(460_000_000L, 465_000_000L, "repeater outputs (+5)"), Triple(465_000_000L, 470_000_000L, "repeater inputs"))),
    Band("800", "800 MHz", 851_000_000, 869_000_000, Mode.NFM, 12_500, offset = -45_000_000,
        segments = listOf(Triple(851_000_000L, 869_000_000L, "business and public safety · repeaters (−45)"))),
    Band("800m", "800 Mobiles", 806_000_000, 824_000_000, Mode.NFM, 12_500,
        segments = listOf(Triple(806_000_000L, 824_000_000L, "mobiles of the 851–869 repeaters"))),
    Band("900", "900 MHz", 935_000_000, 941_000_000, Mode.NFM, 6_250, offset = -39_000_000,
        segments = listOf(Triple(935_000_000L, 941_000_000L, "business repeaters (−39)"))),
    Band("900m", "900 Mobiles", 896_000_000, 902_000_000, Mode.NFM, 6_250,
        segments = listOf(Triple(896_000_000L, 902_000_000L, "mobiles of the 935–941 repeaters"))),
)

/**
 * The service a frequency belongs to where one band plan names it for every screen (Audio, Repeaters): NOAA weather
 * radio 162.400 to 162.550, then marine VHF 156.000 to 162.025, which wins over the land mobile band around it. "" elsewhere.
 */
fun serviceTitle(hz: Long): String = when {
    hz >= 162_400_000L - 1_250 && hz <= 162_550_000L + 1_250 -> "NOAA WEATHER RADIO"
    hz in 156_000_000L..162_025_000L -> "MARINE VHF"
    else -> ""
}
/** The band at [hz]: a ham band, else the first other one with a segment there (FRS/GMRS spans business channels), else any. */
fun bandOf(hz: Long): Band? = BANDS.firstOrNull { hz in it.lo..it.hi }
    ?: NON_HAM.firstOrNull { b -> hz in b.lo..b.hi && b.segments.any { (lo, hi, _) -> hz in lo..hi } }
    ?: NON_HAM.firstOrNull { hz in it.lo..it.hi }

fun segmentOf(hz: Long): String {
    val b = bandOf(hz) ?: return ""
    val s = b.segments.firstOrNull { (lo, hi, _) -> hz in lo..hi }
    return if (s != null) "${b.name} · ${s.third}" else b.name
}

/** Repeater output segments and their offsets (US band plans, ham and business); outside these a frequency is simplex. */
private val REPEATER_SEGMENTS = listOf(
    Triple(29_620_000L, 29_700_000L, -100_000L),
    Triple(51_620_000L, 51_980_000L, -500_000L), Triple(52_500_000L, 52_980_000L, -500_000L), Triple(53_000_000L, 53_980_000L, -1_000_000L),
    Triple(145_100_000L, 145_500_000L, -600_000L), Triple(146_610_000L, 146_995_000L, -600_000L), Triple(147_000_000L, 147_390_000L, 600_000L),
    Triple(223_850_000L, 224_980_000L, -1_600_000L),
    Triple(442_000_000L, 445_000_000L, 5_000_000L), Triple(447_000_000L, 450_000_000L, -5_000_000L),
    Triple(927_000_000L, 928_000_000L, -25_000_000L),
    Triple(1_282_000_000L, 1_288_000_000L, -12_000_000L),
    // business: UHF, 800 and 900 MHz repeater pairs
    Triple(450_000_000L, 455_000_000L, 5_000_000L), Triple(460_000_000L, 465_000_000L, 5_000_000L),
    Triple(851_000_000L, 869_000_000L, -45_000_000L), Triple(935_000_000L, 941_000_000L, -39_000_000L),
)

/** The repeater input for an output frequency, or null when the frequency is not in a repeater output segment. */
fun repeaterInput(hz: Long): Long? = REPEATER_SEGMENTS.firstOrNull { (lo, hi, _) -> hz in lo..hi }?.let { hz + it.third }
