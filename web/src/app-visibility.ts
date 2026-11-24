/**
 * Which apps the connected radio gets to see.
 *
 * An RTL-SDR only receives, so the transmit apps (TX and Troll) are hidden while one is the radio: gone from the
 * launcher, the app bar, FAVES and every other way in. With a HackRF they show as always, and with no radio at all
 * they show too, because a HackRF may be the next thing plugged in.
 */
import type { RadioKind } from './radio.js';

/** The apps that only make sense on a radio that can send. */
export const TX_APPS: readonly string[] = ['transmit', 'troll'];

/** Whether the transmit apps are hidden for this radio (null or undefined: nothing connected). */
export const txAppsHidden = (kind: RadioKind | null | undefined): boolean => kind === 'rtlsdr';

/** Whether app `id` is hidden for this radio. */
export const appHidden = (id: string | null | undefined, kind: RadioKind | null | undefined): boolean =>
  !!id && TX_APPS.includes(id) && txAppsHidden(kind);
