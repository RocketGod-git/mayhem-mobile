package com.rocketgod.mayhem.ui

/** What a tap on a map's locate button does next. */
enum class LocateStep { NONE, FIT, HOME, REF }

/**
 * What a tap on the locate button does: fit everything plotted; with your position known, the next tap centers on you
 * and the one after fits again; with nothing plotted, your position, else the reference position. Shared by every map.
 */
fun locateNext(plotted: Int, home: Boolean, last: LocateStep): LocateStep {
    if (plotted == 0) return if (home) LocateStep.HOME else LocateStep.REF
    if (home && last == LocateStep.FIT) return LocateStep.HOME
    return LocateStep.FIT
}
