/**
 * HAM+ band plan: the FM bands it watches, the names the US band plans give single frequencies, which segments hold
 * repeater outputs and inputs and their standard offsets, and the windows a receiver narrower than a band steps
 * through. Everything here is the published ARRL band plan; nothing local.
 */

export interface HpBand { id: string; name: string; lo: number; hi: number }
export const HP_BANDS: HpBand[] = [
  { id: '2M', name: '2 m', lo: 144_000_000, hi: 148_000_000 },
  { id: '125', name: '1.25 m', lo: 222_000_000, hi: 225_000_000 },
  { id: '70CM', name: '70 cm', lo: 420_000_000, hi: 450_000_000 },
  { id: '6M', name: '6 m', lo: 51_000_000, hi: 54_000_000 },
  { id: '10M', name: '10 m', lo: 29_500_000, hi: 29_700_000 },
];
export const hpBandOf = (hz: number): HpBand | undefined => HP_BANDS.find(b => hz >= b.lo && hz <= b.hi);

/** The raster channels are measured on: every 2.5 kHz, so 5, 12.5, 15, 20 and 25 kHz channel plans all land on it. */
export const HP_RASTER = 2_500;

const NAMED: [number, string][] = [
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
  if (named) return { label: named[1], use: /SIMPLEX/.test(named[1]) ? 'simplex' : named[1] === 'APRS' || named[1] === 'SATELLITE APRS' ? 'data' : 'weak', offsets: [] };
  const s = SEGS.find(x => hz >= x.lo - 1_250 && hz <= x.hi + 1_250);
  if (!s) return { label: '', use: '', offsets: [] };
  return { label: '', use: s.use, offsets: s.use === 'output' || s.use === 'shared' ? s.offsets ?? [] : [] };
}
/** The offset text a tile shows for a repeater output, from the plan: '−600 kHz', '+5 MHz or −5 MHz'. */
export function offsetText(offsets: number[]): string {
  const one = (o: number) => `${o < 0 ? '−' : '+'}${Math.abs(o) >= 1_000_000 ? `${Math.abs(o) / 1e6} MHz` : `${Math.abs(o) / 1e3} kHz`}`;
  return offsets.slice(0, 2).map(one).join(' or ');
}

/** The centers a band is heard from with [rate] samples a second: one when the span covers it, else even steps. */
export function hpWindows(bandId: string, rate: number): { band: string; hz: number }[] {
  const use = rate * 0.8, out: { band: string; hz: number }[] = [];
  for (const b of HP_BANDS) {
    if (bandId !== 'AUTO' && bandId !== b.id) continue;
    const n = Math.max(1, Math.ceil((b.hi - b.lo) / use));
    for (let i = 0; i < n; i++) out.push({ band: b.id, hz: Math.round(n === 1 ? (b.lo + b.hi) / 2 : b.lo + use / 2 + i * ((b.hi - b.lo - use) / (n - 1))) + 1_250 });
  }
  return out;
}
