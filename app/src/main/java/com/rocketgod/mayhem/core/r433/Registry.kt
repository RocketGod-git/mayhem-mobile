package com.rocketgod.mayhem.core.r433

import com.rocketgod.mayhem.core.r433.devices.*

/** Every device decoder, in the web app's registration order (devices/index.ts). Which one looks first is set by priority. */
object R433Registry {
    val all: List<RDevice> by lazy {
        listOf(
            WEATHER_PPM, TPMS, KEELOQ, LACROSSE, LACROSSE2, LACROSSE3, ACURITE, FINEOFFSET, FINEOFFSET2, FINEOFFSET3, OREGON, BRESSER,
        ).flatten()
    }
}
