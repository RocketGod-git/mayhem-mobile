package com.rocketgod.mayhem.core.fleet

import com.rocketgod.mayhem.core.hamid.Position
import kotlin.math.roundToInt

/**
 * What a unit sends besides its calls, as the fleet and the HAM identity show it: a position (P25 packet data and the
 * vendor GPS link controls, P25Data.kt; NXDN data calls, NxdnData.kt), a status, a short message, a talker alias.
 * These positions are whole coordinates, not the low 16 bits a DMR unit report carries. The same as the web's
 * dsp/fleet/unitdata.ts.
 */
open class UnitData(val proto: String, val unit: Int, var kind: String, val name: String, var line: String, val hex: String) {
    var position: Position? = null
    /** Degrees, -1 unknown. */
    var heading = -1.0
    var status: Int? = null; var message: String? = null; var alias: String? = null; var encrypted = false
}
fun posText(p: Position, heading: Double = -1.0): String =
    "%.5f, %.5f".format(java.util.Locale.US, p.lat, p.lon) + if (heading >= 0) " · heading ${heading.roundToInt()}" else ""
