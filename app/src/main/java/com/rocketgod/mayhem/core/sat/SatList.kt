package com.rocketgod.mayhem.core.sat

/* The satellite catalog. Generated from web/src/sat.ts and packet-sats.ts; edit those and regenerate. */

enum class SatKind { FM, LINEAR, PACKET, SSTV, APT, LRPT, DIGI, CW }

data class SatService(
    val name: String, val kind: SatKind, val down: Long, val up: Long?, val tone: Double?,
    /** The technical detail: bandwidths, sub-bands, tones. */
    val note: String?,
    /** What to actually do on this service, in plain words. */
    val how: String?,
)

data class SatDef(val name: String, val norad: Int, val what: String?, val services: List<SatService>)

/** Curated amateur / weather birds a HackRF hears with a whip, with what each one offers and how to use it. */
val SATS: List<SatDef> = listOf(
    SatDef("ISS", 25544, "The International Space Station, 400 km up and by far the loudest thing in amateur space. A handheld antenna is plenty. Passes last ten minutes at best, and what it is doing depends on the crew: the packet digipeater runs most of the time, the voice repeater and the picture transmissions come and go.", listOf(
        SatService("APRS digipeater", SatKind.PACKET, 145825000L, 145825000L, null, "AX.25 1200 bd · path ARISS", "Uplink and downlink are the same channel, so your packet goes up and comes straight back down and you hear yourself repeated. Everyone in the footprint hears it too, which can be a third of a continent."),
        SatService("FM repeater", SatKind.FM, 437800000L, 145990000L, 67.0, "cross-band voice repeater", "Talk on 2 m, listen on 70 cm, so you can hear yourself and know you are getting in. It is switched off more often than on. Needs a license to transmit."),
        SatService("SSTV", SatKind.SSTV, 437550000L, null, null, "Robot 36 during ARISS events · the older Russian mode was PD120 on 145.800", "Nothing to transmit. The recurring ARISS series moved to 70 cm and Robot 36, two minutes on and two minutes off, during events announced a few days ahead. The old 145.800 PD120 mode still appears occasionally."),
        SatService("Crew voice", SatKind.FM, 145800000L, 144490000L, null, "Region 2 uplink 144.490 · Region 1/3 145.200", "The astronauts’ own channel. Almost always silent, and busy only during scheduled school contacts. Listen; do not call."),
    )),
    SatDef("SO-50", 27607, "SaudiSat 1C, launched in 2002 and still the easiest satellite to work with nothing but a handheld and a small beam. Because it is easy, everyone piles onto its single channel and a pass is a scramble.", listOf(
        SatService("FM repeater", SatKind.FM, 436795000L, 145850000L, 67.0, "74.4 Hz for 2 s arms the 10-minute timer, then 67.0", "Send a 74.4 Hz tone for two seconds to arm its ten-minute timer, then talk with 67.0 Hz. One conversation at a time, so listen before calling."),
    )),
    SatDef("AO-91", 43017, "RadFxSat, a Fox-1 cubesat carrying a radiation-effects experiment for Vanderbilt University. Its battery is worn out, so the repeater only runs while the satellite is in sunlight.", listOf(
        SatService("FM repeater", SatKind.FM, 145960000L, 435250000L, 67.0, "sunlit passes only", "Talk on 70 cm with a 67 Hz tone, listen on 2 m. Expect silence on eclipsed passes; check the pass list for one in daylight."),
    )),
    SatDef("PO-101", 43678, "Diwata-2, a Philippine earth-observation satellite that carries an amateur voice repeater as a secondary payload. The repeater is switched on to a published schedule rather than left running.", listOf(
        SatService("FM repeater", SatKind.FM, 145900000L, 437500000L, 141.3, "Diwata-2 · scheduled", "Only alive during announced windows, usually posted a few days ahead. Uses an unusual 141.3 Hz tone."),
    )),
    SatDef("TEVEL-2", 63217, "One of a fleet of identical Israeli school cubesats, built by teams of teenagers and all sharing a single frequency pair. Several can be above the horizon at the same time.", listOf(
        SatService("FM repeater", SatKind.FM, 436400000L, 145970000L, null, "nine-satellite fleet on one pair · no tone · this tracks TEVEL2-1", "No tone needed. If two of the fleet are in view at once you will hear both repeating you, which sounds like an echo."),
    )),
    SatDef("RS-44", 44909, "A Russian navigation satellite carrying an amateur linear transponder, in an orbit twice as high as the cubesats. Passes last half an hour rather than ten minutes, and it reaches much further.", listOf(
        SatService("Linear transponder", SatKind.LINEAR, 435640000L, 145965000L, null, "USB down 435.610–435.670 · LSB up", "It relays a slice of spectrum rather than one channel, so use single sideband and pick a quiet spot inside it. A transponder relays whatever it hears, so it is silent unless another operator is working through it. It is not broken and you are not mistuned: there is simply nothing to relay. Listen to the beacon first to prove you can hear the satellite at all."),
        SatService("CW beacon", SatKind.CW, 435605000L, null, null, "always transmitting while the satellite is on", "This is the one thing that is always there. If you can hear the beacon you are receiving the satellite, whatever the transponder is doing."),
    )),
    SatDef("AO-7", 7530, "Launched in 1974 and given up for dead in 1981 when its batteries failed. In 2002 one of them went open circuit instead of short, and it came back to life running straight from its solar panels. It is the oldest working amateur satellite by decades.", listOf(
        SatService("Mode B transponder", SatKind.LINEAR, 145950000L, 432150000L, null, "145.925–145.975 · sunlit only", "Works only in sunlight, and flips between its modes on its own roughly every day, so check the beacon first. Keep your power low: too much and it captures the whole transponder."),
    )),
    SatDef("FO-29", 24278, "JAS-2, a Japanese amateur satellite from 1996 whose transponder still works whenever the satellite is in sunlight.", listOf(
        SatService("Linear transponder", SatKind.LINEAR, 435850000L, 145950000L, null, "435.800–435.900", "Inverting, so as you move up the passband your downlink moves down, and the Doppler on the two links pulls in opposite directions. Single sideband."),
    )),
    SatDef("AO-73", 39444, "FUNcube-1, built to put a live telemetry beacon in front of school science classes. It runs telemetry in daylight and hands the transponder to amateurs at night.", listOf(
        SatService("Linear transponder", SatKind.LINEAR, 145960000L, 435140000L, null, "145.950–145.970 · night passes only", "It runs the transponder in eclipse and telemetry in sunlight, so check the beacon to see which mode it is in. A transponder relays whatever it hears, so it is silent unless another operator is working through it. It is not broken and you are not mistuned: there is simply nothing to relay. "),
        SatService("Telemetry beacon", SatKind.CW, 145935000L, null, null, "1200 bd differential BPSK · tuned but not decoded here", "Always on, and much stronger than the transponder in daylight. It is data rather than Morse, so it sounds like a warble; hearing it at all proves the pass. The app does not decode it yet."),
    )),
    SatDef("JO-97", 43803, "JY1SAT, a Jordanian cubesat named after the callsign of the late King Hussein. Carries a linear transponder and sends slow-scan images of its own.", listOf(
        SatService("Linear transponder", SatKind.LINEAR, 145865000L, 435110000L, null, "145.855–145.875", "Single sideband through a narrow passband. Listen across the whole slice; there is often only one contact in progress."),
    )),
    SatDef("XW-3", 50466, "CAS-9, a Chinese amateur satellite in a high sun-synchronous orbit, so passes are long and predictable and come at about the same time each day.", listOf(
        SatService("Linear transponder", SatKind.LINEAR, 435195000L, 145870000L, null, "CAS-9 · 435.180–435.210 down", "Single sideband, across a thirty kilohertz slice. A transponder relays whatever it hears, so it is silent unless another operator is working through it. It is not broken and you are not mistuned: there is simply nothing to relay. "),
        SatService("CW beacon", SatKind.CW, 435575000L, null, null, "well away from the passband, always on", "The quickest way to confirm you are hearing this satellite. It sits clear of the transponder, so nothing else can mask it."),
    )),
    SatDef("IO-117", 53109, "GreenCube, an Italian satellite six times higher than the usual cubesat. It is above the horizon for hours rather than minutes and its footprint spans continents, so it is used to pass short messages between countries.", listOf(
        SatService("GreenCube digipeater", SatKind.DIGI, 435310000L, 435310000L, null, "MEO · 1200 bd GMSK · not decoded here yet", "A store-and-forward message digipeater rather than a voice repeater. This app tunes it and shows the signal, but does not decode it yet."),
    )),
    SatDef("NOAA 15", 25338, "An American weather satellite that broadcast a live picture, one line at a time, in a format from the 1960s simple enough to decode with a tape recorder. Switched off in 2025 after 27 years.", listOf(
        SatService("APT images", SatKind.APT, 137620000L, null, null, "retired 2025 · no TLE, tuning still works", "No longer transmitting. Kept here so you can check the frequency and confirm the silence."),
    )),
    SatDef("NOAA 18", 28654, "The middle of the three American analog weather satellites, retired in June 2025. Its picture was a live scan of whatever it was flying over, visible light by day and infrared by night.", listOf(
        SatService("APT images", SatKind.APT, 137912500L, null, null, "retired June 2025 · no TLE, tuning still works", "No longer transmitting."),
    )),
    SatDef("NOAA 19", 33591, "The last of the American analog weather satellites, retired in 2025. Between them these three gave anyone with a scanner a live picture of their own weather for half a century.", listOf(
        SatService("APT images", SatKind.APT, 137100000L, null, null, "retired 2025 · no TLE, tuning still works", "No longer transmitting."),
    )),
    SatDef("METEOR M2-3", 57166, "A Russian weather satellite that replaced the old analog picture with a digital one: sharper, in color, and error corrected. This is the one to point at now that the American analog birds are gone.", listOf(
        SatService("LRPT images", SatKind.LRPT, 137900000L, null, null, "72 kbaud QPSK · decoded to a color picture", "Receive only. Start it as the satellite rises and leave it: the app demodulates, corrects the errors and builds the picture line by line across the pass. A turnstile or a simple V antenna makes a real difference."),
    )),
    SatDef("METEOR M2-4", 59051, "The newest of the Russian digital weather satellites, launched in 2024. Same picture format as M2-3 on a different channel, so on a good day you can catch both.", listOf(
        SatService("LRPT images", SatKind.LRPT, 137100000L, null, null, "72 kbaud QPSK · decoded to a color picture", "Receive only, exactly like M2-3. Check the pass list: the two often rise within an hour of each other."),
    )),
)

/**
 * Cubesats that beacon 9600 (or 4800) baud packet in the two bands a whip hears, from the SatNOGS transmitter
 * database (2026-09-09), keeping only live ones CelesTrak also has an orbit for. NORAD id, downlink, baud, name.
 */
data class PacketSat(val norad: Int, val down: Long, val baud: Int, val name: String)

val PACKET_SATS: List<PacketSat> = listOf(
    PacketSat(64881, 436270000L, 9600, "239ALFEROV (RS61S)"),
    PacketSat(68506, 437325000L, 9600, "AEPEX"),
    PacketSat(35933, 435950000L, 4800, "BEESAT-1"),
    PacketSat(40974, 437375500L, 9600, "BISONSAT"),
    PacketSat(40014, 437445000L, 9600, "BUGSAT-1 (TITA)"),
    PacketSat(68635, 437250000L, 9600, "CANVAS"),
    PacketSat(61746, 436835000L, 9600, "COLIBRI-S (RS67S)"),
    PacketSat(62394, 436775000L, 9600, "CROCUBE"),
    PacketSat(57175, 436990000L, 9600, "CUBEBEL 2 (EU11S)"),
    PacketSat(39440, 437445000L, 9600, "CUBEBUG-2 (LO-74)"),
    PacketSat(66778, 437125000L, 9600, "FORESAIL-1 PRIME"),
    PacketSat(60237, 145935000L, 9600, "GRBBETA"),
    PacketSat(60237, 436785000L, 9600, "GRBBETA"),
    PacketSat(57188, 435300000L, 9600, "HORS 1"),
    PacketSat(25544, 437800000L, 9600, "ISS (ZARYA)"),
    PacketSat(67683, 145825000L, 9600, "KNACKSAT-2"),
    PacketSat(62391, 436925000L, 9600, "LASARSAT"),
    PacketSat(40908, 437225000L, 4800, "LILACSAT-2"),
    PacketSat(43485, 437250000L, 4800, "LUOJIA-1 01"),
    PacketSat(58810, 435950000L, 4800, "NANOFF A"),
    PacketSat(58755, 435950000L, 4800, "NANOFF B"),
    PacketSat(60525, 436500000L, 9600, "ORESAT0.5"),
    PacketSat(40042, 437675000L, 9600, "POLYITAN-1"),
    PacketSat(67291, 436950000L, 9600, "QMR-KWT-2 (RS95S)"),
    PacketSat(60476, 435600000L, 9600, "QUBE"),
    PacketSat(43773, 437475000L, 9600, "RANGE-A"),
    PacketSat(60243, 436750000L, 9600, "ROBUSTA-3A (MEDITERRAN*)"),
    PacketSat(67290, 437350000L, 9600, "SAKHACUBE-CHOLBON (RS1*)"),
    PacketSat(55104, 437325000L, 9600, "SHARJAHSAT-1"),
    PacketSat(52899, 436490000L, 9600, "SNUGLITE-II"),
    PacketSat(59112, 437025000L, 9600, "SONATE-2"),
    PacketSat(42829, 435950000L, 4800, "TECHNOSAT"),
    PacketSat(25397, 435225000L, 9600, "TECHSAT 1B (GO-32)"),
    PacketSat(25397, 435325000L, 9600, "TECHSAT 1B (GO-32)"),
    PacketSat(49396, 437450000L, 9600, "TEIKYOSAT-4 (OORURI)"),
    PacketSat(43677, 437390000L, 9600, "TEN-KOH"),
    PacketSat(44881, 145890000L, 4800, "TIANYAN 01"),
    PacketSat(40043, 435000000L, 9600, "TIGRISAT"),
    PacketSat(39446, 436395000L, 9600, "UWE-3"),
    PacketSat(43880, 435600000L, 9600, "UWE-4"),
    PacketSat(61749, 436870000L, 9600, "VIZARD-ION (RS68S)"),
    PacketSat(50466, 435725000L, 4800, "XW-3 (CAS-9)"),
    PacketSat(39417, 437356000L, 9600, "ZACUBE-1 (TSHEPISOSAT)"),
)
