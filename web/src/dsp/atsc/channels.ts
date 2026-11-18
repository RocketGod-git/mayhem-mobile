/** US TV channels after the repack (VHF 2-13, UHF 14-36), 6 MHz each, and where the ATSC pilot sits in them. */
export const SR = 4.5e6 / 286 * 684;
export interface TvChannel { ch: number; lo: number; band: 'VHF-LO' | 'VHF-HI' | 'UHF' }
export const CHANNELS: TvChannel[] = [
  ...[2, 3, 4].map(ch => ({ ch, lo: 54e6 + (ch - 2) * 6e6, band: 'VHF-LO' as const })),
  ...[5, 6].map(ch => ({ ch, lo: 76e6 + (ch - 5) * 6e6, band: 'VHF-LO' as const })),
  ...Array.from({ length: 7 }, (_, i) => ({ ch: 7 + i, lo: 174e6 + i * 6e6, band: 'VHF-HI' as const })),
  ...Array.from({ length: 23 }, (_, i) => ({ ch: 14 + i, lo: 470e6 + i * 6e6, band: 'UHF' as const })),
];
export const centerOf = (ch: number) => (CHANNELS.find(c => c.ch === ch)?.lo ?? 0) + 3e6;
/** The pilot: 309.441 kHz above the lower channel edge (A/53 Part 2 Sec 5.4.2), Sr/4 below the center. */
export const pilotOf = (ch: number) => centerOf(ch) - SR / 4;
export function channelAt(hz: number): TvChannel | null { return CHANNELS.find(c => hz > c.lo && hz < c.lo + 6e6) ?? null; }
