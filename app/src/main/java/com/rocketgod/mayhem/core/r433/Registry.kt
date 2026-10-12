package com.rocketgod.mayhem.core.r433

import com.rocketgod.mayhem.core.r433.devices.*

/** Every device decoder, in the web app's registration order (devices/index.ts). Which one looks first is set by priority. */
object R433Registry {
    val all: List<RDevice> by lazy {
        listOf(
            WEATHER_PPM, TPMS, KEELOQ, LACROSSE, LACROSSE2, LACROSSE3, ACURITE, FINEOFFSET, FINEOFFSET2, FINEOFFSET3, OREGON, BRESSER,
            SECURITY, AMBIENT, METERS, TPMS2, TPMS3, ENERGY, REMOTES, AURIOL, WEATHER_MORE,
            TFA, THERMOPRO, THERMOPRO2, MBUS, TPMS4, TPMS5, TPMS6,
            REMOTES2, REMOTES3, SECPLUS, REMOTES4, SECURITY2, WEATHER2, WEATHER3, WEATHER4, GRILL,
            ENERGY2, METERS2, OIL, REMOTES5, ENERGY3, WEATHER5, HVAC,
            WEATHER6, THERMO4, RAIN, LIGHTING, HOMEAUTO, HOMEAUTO2, DEFERRED, HEATING,
            ODDMENTS, TELEMETRY, STATIONS, THERMO3, SWITCHES_FAMILY, SECURITY3,
        ).flatten()
    }
}
