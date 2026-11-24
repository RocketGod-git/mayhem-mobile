package com.rocketgod.mayhem.core

/**
 * Which apps the attached radio gets to see.
 *
 * An RTL-SDR only receives, on USB or across the network (rtl_tcp), so the transmit apps (TX and Troll) are hidden
 * while one is the radio: gone from the launcher, the app bar, FAVES, the last app Mayhem reopens and every other
 * way in. With a HackRF they show as always, and with nothing attached they show too, because a HackRF may be the
 * next thing plugged in.
 */
object AppVisibility {
    /** The apps that only make sense on a radio that can send. */
    val TX_APPS: Set<MayhemApp> = setOf(MayhemApp.TRANSMIT, MayhemApp.TROLL)

    /** Whether the transmit apps are hidden for this radio. */
    fun txHidden(kind: Radio.Kind): Boolean = kind == Radio.Kind.RTLSDR

    /** Whether [app] is hidden for this radio (null, Home, never is). */
    fun hidden(app: MayhemApp?, kind: Radio.Kind = Radio.kind.value): Boolean = app != null && app in TX_APPS && txHidden(kind)

    /** [apps] without the ones this radio hides, in the same order. */
    fun visible(apps: List<MayhemApp>, kind: Radio.Kind = Radio.kind.value): List<MayhemApp> = apps.filter { !hidden(it, kind) }
}
