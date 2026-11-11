/**
 * Where LoRa networks sit, worldwide. Port of core/lora/LoraPlan.swift: Meshtastic's regions, presets and
 * frequency-slot rule as its firmware defines them (src/mesh/RadioInterface.cpp, MeshRadio.h,
 * DisplayFormatters.cpp), MeshCore's regional presets, and the LoRaWAN channel plans.
 */

/** A channel with a known modem. `standing`: listened to all the time while inside the span (a far node's packet is
 *  below the noise in any one bin and never shows up as a burst, but its own channel's receivers still decode it:
 *  LoRa works under the noise). */
export interface LoraChannel { hz: number; bw: number; sf: number | null; name: string; standing: boolean }

/** A Meshtastic preset: its display name (also the default channel's name), bandwidth, spreading factor. */
export interface LoraPreset { name: string; bw: number; sf: number }

/** A Meshtastic region: band edges (MHz), its presets, slot spacing and padding (MHz), a fixed slot (1-based, 0 = by
 *  the channel name's hash), and the preset a new node starts on. */
export interface LoraRegion { name: string; lo: number; hi: number; presets: LoraPreset[]; spacing: number; padding: number; slot: number; start: string }

/** A wide-span view: center, title, what is in it. A radio that can't sample wide gets a 2 MHz window on `narrow`
 *  (the band's main channel) instead. */
export interface LoraBand { title: string; sub: string; center: number; narrow: number }

const P = (name: string, bw: number, sf: number): LoraPreset => ({ name, bw, sf });

export const STD: LoraPreset[] = [P('LongFast', 250_000, 11), P('LongSlow', 125_000, 12), P('MediumSlow', 250_000, 10), P('MediumFast', 250_000, 9),
  P('ShortSlow', 250_000, 8), P('ShortFast', 250_000, 7), P('LongMod', 125_000, 11), P('ShortTurbo', 500_000, 7),
  P('LongTurbo', 500_000, 11), P('MediumTurbo', 500_000, 9)];
export const LITE: LoraPreset[] = [P('LiteFast', 125_000, 9), P('LiteSlow', 125_000, 10)];
export const NARROW: LoraPreset[] = [P('NarrowFast', 62_500, 7), P('NarrowSlow', 62_500, 8)];
export const allPresetNames: string[] = [...STD, ...LITE, ...NARROW].map(p => p.name);

const std = (name: string, lo: number, hi: number): LoraRegion => ({ name, lo, hi, presets: STD, spacing: 0, padding: 0, slot: 0, start: 'LongFast' });

export const REGIONS: LoraRegion[] = [std('US', 902, 928), std('EU_433', 433, 434),
  { name: 'EU_868', lo: 869.4, hi: 869.65, presets: STD.slice(0, 7), spacing: 0, padding: 0, slot: 0, start: 'LongFast' },
  { name: 'EU_866', lo: 865.6, hi: 867.6, presets: LITE, spacing: 0.4, padding: 0.0375, slot: 0, start: 'LiteFast' },
  { name: 'EU_N_868', lo: 869.4, hi: 869.65, presets: NARROW, spacing: 0, padding: 0.0104, slot: 1, start: 'NarrowSlow' },
  std('CN', 470, 510), std('JP', 920.5, 923.5), std('ANZ', 915, 928), std('ANZ_433', 433.05, 434.79),
  std('RU', 868.7, 869.2), std('KR', 920, 923), std('TW', 920, 925), std('IN', 865, 867), std('NZ_865', 864, 868),
  std('TH', 920, 925), std('UA_433', 433, 434.7), std('MY_433', 433, 435), std('MY_919', 919, 924),
  std('SG_923', 917, 925), std('PH_433', 433, 434.7), std('PH_868', 868, 869.4), std('PH_915', 915, 918),
  std('KZ_433', 433.075, 434.775), std('KZ_863', 863, 868), std('NP_865', 865, 868), std('BR_902', 902, 907.5)];

export function djb2(s: string): number {
  let h = 5381;
  for (const c of new TextEncoder().encode(s)) h = (Math.imul(h, 33) + c) >>> 0;
  return h;
}

/** Swift's `.rounded()` for the plan's own arithmetic: to nearest, halves away from zero. */
const roundAway = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

/** The default (unnamed) channel of a preset in a region: hz, or null when the preset does not fit. */
export function slotHz(r: LoraRegion, p: LoraPreset): number | null {
  const bw = p.bw / 1e6;
  const width = r.spacing + 2 * r.padding + bw;
  const n = roundAway((r.hi - r.lo + r.spacing) / width);
  if (n <= 0) return null;
  const slot = r.slot > 0 ? Math.min(r.slot, n) - 1 : djb2(p.name) % n;
  return roundAway((r.lo + bw / 2 + r.padding + slot * width) * 1e6);
}

/** Every channel with a known modem, worldwide. `standing`: listened to all the time once inside the span (each
 *  region's starting preset, the newer US default LongTurbo and the popular MediumFast, MeshCore's presets). */
export const CHANNELS: LoraChannel[] = (() => {
  const c: LoraChannel[] = [];
  const seen = new Set<string>();
  const add = (hz: number, bw: number, sf: number | null, name: string, standing: boolean): void => {
    const k = `${hz}/${bw}/${sf ?? 0}`;
    const i = c.findIndex(x => `${x.hz}/${x.bw}/${x.sf ?? 0}` === k);
    if (i >= 0) {
      if (standing && !c[i].standing) c[i] = { hz, bw, sf, name: c[i].name, standing: true };
      return;
    }
    if (!seen.has(k)) { seen.add(k); c.push({ hz, bw, sf, name, standing }); }
  };
  for (const r of REGIONS) {
    for (const p of r.presets) {
      const hz = slotHz(r, p);
      if (hz === null) continue;
      const standing = p.name === r.start || ((r.name === 'US' || r.name === 'ANZ') && (p.name === 'LongTurbo' || p.name === 'MediumFast'));
      add(hz, p.bw, p.sf, `Meshtastic ${p.name} ${r.name}`, standing);
    }
  }
  // MeshCore's regional presets
  add(910_525_000, 62_500, 7, 'MeshCore US', true);
  add(927_875_000, 62_500, 7, 'MeshCore US 927.875', true);
  add(869_618_000, 62_500, 8, 'MeshCore EU/UK narrow', true);
  add(869_525_000, 250_000, 11, 'MeshCore EU/UK long range', true);
  add(916_575_000, 62_500, 7, 'MeshCore ANZ', true);
  // LoRaWAN: US915 / AU915 uplinks (125 kHz every 200 kHz, 500 kHz every 1.6 MHz) and downlinks (500 kHz every 600 kHz)
  for (const [base, name] of [[902_300_000, 'US915'], [915_200_000, 'AU915']] as [number, string][]) {
    for (let k = 0; k < 64; k++) add(base + k * 200_000, 125_000, null, `LoRaWAN ${name} uplink ${k}`, false);
    for (let k = 0; k < 8; k++) add(base + 700_000 + k * 1_600_000, 500_000, null, `LoRaWAN ${name} uplink ${64 + k}`, false);
  }
  for (let k = 0; k < 8; k++) add(923_300_000 + k * 600_000, 500_000, null, `LoRaWAN US915/AU915 downlink ${k}`, false);
  // EU868 (the three join channels, the common 867.1-867.9 set, RX2), AS923, KR920, IN865, CN470
  for (const f of [868_100_000, 868_300_000, 868_500_000, 867_100_000, 867_300_000, 867_500_000, 867_700_000, 867_900_000]) add(f, 125_000, null, 'LoRaWAN EU868', false);
  add(869_525_000, 125_000, 9, 'LoRaWAN EU868 RX2', false);
  for (const f of [923_200_000, 923_400_000, 922_200_000, 922_400_000, 922_600_000, 922_800_000, 923_000_000, 922_000_000]) add(f, 125_000, null, 'LoRaWAN AS923', false);
  for (const f of [922_100_000, 922_300_000, 922_500_000]) add(f, 125_000, null, 'LoRaWAN KR920', false);
  for (const f of [865_062_500, 865_402_500, 865_985_000]) add(f, 125_000, null, 'LoRaWAN IN865', false);
  for (let k = 0; k < 96; k++) add(470_300_000 + k * 200_000, 125_000, null, `LoRaWAN CN470 uplink ${k}`, false);
  return c;
})();

export const BANDS: LoraBand[] = [
  { title: '903–923', sub: 'US · Americas', center: 913_000_000, narrow: 906_875_000 },
  { title: '908–928', sub: 'US upper', center: 918_000_000, narrow: 910_525_000 },
  { title: '859–879', sub: 'Europe · India', center: 869_000_000, narrow: 869_525_000 },
  { title: '912–932', sub: 'ANZ · Asia', center: 922_000_000, narrow: 916_575_000 },
  { title: '424–444', sub: '433 MHz', center: 434_000_000, narrow: 433_875_000 },
  { title: '470–490', sub: 'China', center: 480_000_000, narrow: 470_300_000 },
];

/** The 2 MHz span's tiles (one channel at a time: the radio sits 300 kHz above it, clear of the spike at the
 *  center), from LoraScreen.swift. */
export const NARROW_TILES: { title: string; sub: string; hz: number }[] = [
  { title: '906.875', sub: 'LongFast US', hz: 906_875_000 }, { title: '910.525', sub: 'MeshCore US', hz: 910_525_000 },
  { title: '869.525', sub: 'LongFast EU', hz: 869_525_000 }, { title: '869.618', sub: 'MeshCore EU', hz: 869_618_000 },
  { title: '916.575', sub: 'MeshCore ANZ', hz: 916_575_000 }, { title: '927.875', sub: 'MeshCore', hz: 927_875_000 },
];
/** How far above a narrow tile's channel the radio is tuned. */
export const NARROW_SHIFT = 300_000;

const EU = new Set(['GB', 'IE', 'FR', 'DE', 'NL', 'BE', 'LU', 'ES', 'PT', 'IT', 'AT', 'CH', 'DK', 'SE', 'NO', 'FI', 'IS', 'PL', 'CZ',
  'SK', 'HU', 'SI', 'HR', 'RO', 'BG', 'GR', 'CY', 'MT', 'EE', 'LV', 'LT', 'RU', 'UA', 'BY', 'RS', 'BA', 'ME', 'MK',
  'AL', 'MD', 'TR', 'IL', 'ZA', 'IN', 'NP', 'KZ', 'AE', 'SA', 'EG', 'MA', 'NG', 'KE']);
const ASIA = new Set(['AU', 'NZ', 'JP', 'KR', 'TW', 'TH', 'SG', 'MY', 'PH', 'ID', 'VN', 'HK']);

/** The region code of the browser's locale ("en-US" -> "US"), US when it has none. */
export function localeRegion(): string {
  try {
    const nav = (globalThis as { navigator?: { language?: string } }).navigator;
    const tag = nav?.language ?? Intl.DateTimeFormat().resolvedOptions().locale;
    const m = /[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(tag ?? '');
    return m ? m[1].toUpperCase() : 'US';
  } catch { return 'US'; }
}

/** Where to start: the band for the device's own region setting (not its location). */
export function homeBand(cc: string = localeRegion()): LoraBand {
  if (cc === 'CN') return BANDS[5];
  if (EU.has(cc)) return BANDS[2];
  if (ASIA.has(cc)) return BANDS[3];
  return BANDS[0];
}
