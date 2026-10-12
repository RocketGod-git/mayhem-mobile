package com.rocketgod.mayhem.core.r433

import com.rocketgod.mayhem.core.r433.devices.WEATHER_PPM

/** Every device decoder, in the web app's registration order (devices/index.ts). Which one looks first is set by priority. */
object R433Registry {
    val all: List<RDevice> by lazy {
        listOf(
            WEATHER_PPM,
        ).flatten()
    }
}
