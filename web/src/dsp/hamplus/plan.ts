/**
 * HAM+ band plan: the FM bands it watches, the names the US band plans give single frequencies, which segments hold
 * repeater outputs and inputs and their standard offsets, and the windows a receiver narrower than a band steps
 * through. The ham bands are the published ARRL band plan; the business bands (BIZ) the FCC Part 90 land mobile bands
 * and their usual repeater pairs. Nothing local.
 */

/** [biz]: a business band, scanned by BIZ rather than AUTO. [grid]: the channel raster a carrier snaps to (HP_RASTER when absent). */
export interface HpBand { id: string; name: string; lo: number; hi: number; biz?: boolean; grid?: number }
export const HP_BANDS: HpBand[] = [
  { id: '2M', name: '2 m', lo: 144_000_000, hi: 148_000_000 },
  { id: '125', name: '1.25 m', lo: 222_000_000, hi: 225_000_000 },
  { id: '70CM', name: '70 cm', lo: 420_000_000, hi: 450_000_000 },
  { id: '6M', name: '6 m', lo: 51_000_000, hi: 54_000_000 },
  { id: '10M', name: '10 m', lo: 29_500_000, hi: 29_700_000 },
  // VHF channels sit 7.5 kHz apart on a 2.5 kHz grid; UHF and 900 MHz are 12.5 kHz channels split to 6.25 kHz
  { id: 'VHFB', name: 'VHF business', lo: 150_000_000, hi: 174_000_000, biz: true },
  { id: 'UHFB', name: 'UHF business', lo: 450_000_000, hi: 470_000_000, biz: true, grid: 6_250 },
  { id: '900B', name: '900 business', lo: 935_000_000, hi: 941_000_000, biz: true, grid: 6_250 },
  { id: '900M', name: '900 business mobiles', lo: 896_000_000, hi: 902_000_000, biz: true, grid: 6_250 },
];
export const hpBandOf = (hz: number): HpBand | undefined => HP_BANDS.find(b => hz >= b.lo && hz <= b.hi);

/** The raster channels are measured on: every 2.5 kHz, so 5, 7.5, 12.5, 15, 20 and 25 kHz channel plans all land on it. */
export const HP_RASTER = 2_500;
/** The channel raster a carrier at [hz] snaps to: 6.25 kHz on UHF and 900 MHz business, else the measuring raster. */
export const hpGridOf = (hz: number): number => hpBandOf(hz)?.grid ?? HP_RASTER;

/** [hz, name, use]: the use when it is not read from the name (SIMPLEX, APRS). */
const NAMED: [number, string, string?][] = [
  [146_520_000, 'NATIONAL SIMPLEX CALLING'],
  [223_500_000, 'NATIONAL SIMPLEX CALLING'],
  [446_000_000, 'NATIONAL SIMPLEX CALLING'],
  [52_525_000, 'NATIONAL SIMPLEX CALLING'],
  [52_540_000, 'SECONDARY SIMPLEX'],
  [29_600_000, 'NATIONAL SIMPLEX CALLING'],
  [144_390_000, 'APRS'],
  [145_825_000, 'SATELLITE APRS'],
  [144_200_000, 'SSB CALLING'],
  [432_100_000, 'SSB CALLING'],
  // MURS, and the itinerant business channels any licensee may use, known by their color dots and stars
  [151_820_000, 'MURS 1', 'simplex'], [151_880_000, 'MURS 2', 'simplex'], [151_940_000, 'MURS 3', 'simplex'],
  [154_570_000, 'MURS 4 BLUE DOT', 'simplex'], [154_600_000, 'MURS 5 GREEN DOT', 'simplex'],
  [151_625_000, 'RED DOT ITINERANT', 'simplex'], [151_955_000, 'PURPLE DOT ITINERANT', 'simplex'],
  [464_500_000, 'BROWN DOT ITINERANT', 'simplex'], [464_550_000, 'YELLOW DOT ITINERANT', 'simplex'],
  [467_762_500, 'J DOT ITINERANT', 'simplex'], [467_812_500, 'K DOT ITINERANT', 'simplex'],
  [467_850_000, 'SILVER STAR ITINERANT', 'simplex'], [467_875_000, 'GOLD STAR ITINERANT', 'simplex'],
  [467_900_000, 'RED STAR ITINERANT', 'simplex'], [467_925_000, 'BLUE STAR ITINERANT', 'simplex'],
  [469_500_000, 'ITINERANT', 'simplex'], [469_550_000, 'ITINERANT', 'simplex'],
];

/** A segment of a band plan: what it is used for and, for repeater outputs, where the inputs are. */
interface Seg { lo: number; hi: number; use: 'output' | 'input' | 'simplex' | 'satellite' | 'weak' | 'shared'; offsets?: number[] }
const SEGS: Seg[] = [
  { lo: 144_000_000, hi: 144_275_000, use: 'weak' },
  { lo: 144_510_000, hi: 144_890_000, use: 'input' },
  { lo: 145_110_000, hi: 145_490_000, use: 'output', offsets: [-600_000] },
  { lo: 145_800_000, hi: 146_000_000, use: 'satellite' },
  { lo: 146_010_000, hi: 146_370_000, use: 'input' },
  { lo: 146_400_000, hi: 146_580_000, use: 'simplex' },
  { lo: 146_610_000, hi: 146_970_000, use: 'output', offsets: [-600_000] },
  { lo: 147_000_000, hi: 147_390_000, use: 'output', offsets: [600_000] },
  { lo: 147_420_000, hi: 147_570_000, use: 'simplex' },
  { lo: 147_600_000, hi: 147_990_000, use: 'input' },
  { lo: 222_000_000, hi: 222_150_000, use: 'weak' },
  { lo: 222_250_000, hi: 223_380_000, use: 'input' },
  { lo: 223_400_000, hi: 223_520_000, use: 'simplex' },
  { lo: 223_850_000, hi: 224_980_000, use: 'output', offsets: [-1_600_000] },
  { lo: 432_000_000, hi: 432_300_000, use: 'weak' },
  { lo: 435_000_000, hi: 438_000_000, use: 'satellite' },
  { lo: 442_000_000, hi: 445_000_000, use: 'output', offsets: [5_000_000, -5_000_000] },
  { lo: 445_000_000, hi: 447_000_000, use: 'shared', offsets: [-5_000_000, 5_000_000] },
  { lo: 447_000_000, hi: 450_000_000, use: 'output', offsets: [-5_000_000, 5_000_000] },
  { lo: 51_120_000, hi: 51_480_000, use: 'input' },
  { lo: 51_620_000, hi: 51_980_000, use: 'output', offsets: [-500_000] },
  { lo: 52_000_000, hi: 52_480_000, use: 'input' },
  { lo: 52_500_000, hi: 52_980_000, use: 'output', offsets: [-500_000, -1_000_000] },
  { lo: 53_000_000, hi: 53_480_000, use: 'input' },
  { lo: 53_500_000, hi: 53_980_000, use: 'output', offsets: [-500_000, -1_000_000] },
  { lo: 29_520_000, hi: 29_580_000, use: 'input' },
  { lo: 29_620_000, hi: 29_680_000, use: 'output', offsets: [-100_000] },
  // UHF business: repeaters on 450-455 and 460-465 MHz listen 5 MHz up
  { lo: 450_000_000, hi: 455_000_000, use: 'output', offsets: [5_000_000] },
  { lo: 455_000_000, hi: 460_000_000, use: 'input' },
  { lo: 460_000_000, hi: 465_000_000, use: 'output', offsets: [5_000_000] },
  { lo: 465_000_000, hi: 470_000_000, use: 'input' },
  // 900 MHz business: repeaters on 935-941 MHz listen 39 MHz down
  { lo: 935_000_000, hi: 941_000_000, use: 'output', offsets: [-39_000_000] },
  { lo: 896_000_000, hi: 902_000_000, use: 'input' },
];

export interface PlanInfo {
  /** The plan's name for this exact frequency, or ''. */
  label: string;
  /** 'output' (a repeater output), 'input', 'simplex', 'satellite', 'weak', 'shared' or ''. */
  use: string;
  /** Where a repeater with its output here listens, offsets in Hz, most usual first (empty when not an output). */
  offsets: number[];
}
const near = (a: number, b: number) => Math.abs(a - b) < 1_250;
export function planInfo(hz: number): PlanInfo {
  const named = NAMED.find(([f]) => near(f, hz));
  // the national calling frequencies are simplex even where they sit inside another segment
  if (named) return { label: named[1], use: named[2] ?? (/SIMPLEX/.test(named[1]) ? 'simplex' : named[1] === 'APRS' || named[1] === 'SATELLITE APRS' ? 'data' : 'weak'), offsets: [] };
  const s = SEGS.find(x => hz >= x.lo - 1_250 && hz <= x.hi + 1_250);
  if (!s) return { label: '', use: '', offsets: [] };
  return { label: '', use: s.use, offsets: s.use === 'output' || s.use === 'shared' ? s.offsets ?? [] : [] };
}
/** The offset text a tile shows for a repeater output, from the plan: '−600 kHz', '+5 MHz or −5 MHz'. */
export function offsetText(offsets: number[]): string {
  const one = (o: number) => `${o < 0 ? '−' : '+'}${Math.abs(o) >= 1_000_000 ? `${Math.abs(o) / 1e6} MHz` : `${Math.abs(o) / 1e3} kHz`}`;
  return offsets.slice(0, 2).map(one).join(' or ');
}

/**
 * The centers a band is heard from with [rate] samples a second: one when the span covers it, else even steps. AUTO
 * is every ham band, BIZ every business band.
 */
export function hpWindows(bandId: string, rate: number): { band: string; hz: number }[] {
  const use = rate * 0.8, out: { band: string; hz: number }[] = [];
  for (const b of HP_BANDS) {
    if (bandId === 'AUTO' ? b.biz : bandId === 'BIZ' ? !b.biz : bandId !== b.id) continue;
    const n = Math.max(1, Math.ceil((b.hi - b.lo) / use));
    for (let i = 0; i < n; i++) out.push({ band: b.id, hz: Math.round(n === 1 ? (b.lo + b.hi) / 2 : b.lo + use / 2 + i * ((b.hi - b.lo - use) / (n - 1))) + 1_250 });
  }
  return out;
}
