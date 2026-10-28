/** Amateur band plan (IARU Region 2 / FCC flavored), with the mode, step and repeater offset each band expects. */
import type { HamMode } from './dsp/ham/demod.js';

export interface Band {
  id: string; name: string; lo: number; hi: number;
  mode: HamMode; step: number; offset?: number;   // repeater offset (Hz) where the band has repeaters
  calling?: number;                                // a sensible place to land
  segments: [number, number, string][];            // [lo, hi, label]
}

export const BANDS: Band[] = [
  { id: '160m', name: '160 m', lo: 1_800_000, hi: 2_000_000, mode: 'LSB', step: 500, calling: 1_850_000, segments: [[1_800_000, 1_840_000, 'CW / digital'], [1_840_000, 2_000_000, 'phone']] },
  { id: '80m', name: '80 m', lo: 3_500_000, hi: 4_000_000, mode: 'LSB', step: 500, calling: 3_850_000, segments: [[3_500_000, 3_600_000, 'CW / digital'], [3_573_000, 3_576_000, 'FT8'], [3_600_000, 4_000_000, 'phone']] },
  { id: '40m', name: '40 m', lo: 7_000_000, hi: 7_300_000, mode: 'LSB', step: 500, calling: 7_200_000, segments: [[7_000_000, 7_125_000, 'CW / digital'], [7_074_000, 7_077_000, 'FT8'], [7_125_000, 7_300_000, 'phone']] },
  { id: '30m', name: '30 m', lo: 10_100_000, hi: 10_150_000, mode: 'CW', step: 100, calling: 10_136_000, segments: [[10_100_000, 10_130_000, 'CW'], [10_130_000, 10_150_000, 'digital · FT8 10.136']] },
  { id: '20m', name: '20 m', lo: 14_000_000, hi: 14_350_000, mode: 'USB', step: 500, calling: 14_074_000, segments: [[14_000_000, 14_150_000, 'CW / digital'], [14_074_000, 14_077_000, 'FT8'], [14_150_000, 14_350_000, 'phone']] },
  { id: '17m', name: '17 m', lo: 18_068_000, hi: 18_168_000, mode: 'USB', step: 500, calling: 18_100_000, segments: [[18_068_000, 18_110_000, 'CW / digital'], [18_110_000, 18_168_000, 'phone']] },
  { id: '15m', name: '15 m', lo: 21_000_000, hi: 21_450_000, mode: 'USB', step: 500, calling: 21_074_000, segments: [[21_000_000, 21_200_000, 'CW / digital'], [21_074_000, 21_077_000, 'FT8'], [21_200_000, 21_450_000, 'phone']] },
  { id: '12m', name: '12 m', lo: 24_890_000, hi: 24_990_000, mode: 'USB', step: 500, calling: 24_915_000, segments: [[24_890_000, 24_930_000, 'CW / digital'], [24_930_000, 24_990_000, 'phone']] },
  { id: '10m', name: '10 m', lo: 28_000_000, hi: 29_700_000, mode: 'USB', step: 1000, offset: -100_000, calling: 28_400_000, segments: [[28_000_000, 28_300_000, 'CW / digital'], [28_074_000, 28_077_000, 'FT8'], [28_300_000, 29_000_000, 'phone'], [29_000_000, 29_700_000, 'FM · repeaters 29.62–29.68']] },
  { id: '6m', name: '6 m', lo: 50_000_000, hi: 54_000_000, mode: 'USB', step: 1000, offset: -500_000, calling: 50_125_000, segments: [[50_000_000, 50_100_000, 'CW'], [50_100_000, 50_300_000, 'SSB · 50.125 calling'], [50_313_000, 50_316_000, 'FT8'], [51_000_000, 54_000_000, 'FM · repeaters']] },
  { id: '2m', name: '2 m', lo: 144_000_000, hi: 148_000_000, mode: 'NFM', step: 12_500, offset: -600_000, calling: 146_520_000, segments: [[144_000_000, 144_300_000, 'CW / SSB · 144.200 calling'], [144_174_000, 144_177_000, 'FT8'], [144_390_000, 144_390_000, 'APRS'], [145_100_000, 145_500_000, 'repeater outputs (−600)'], [145_800_000, 146_000_000, 'satellites'], [146_400_000, 146_600_000, 'simplex · 146.520 calling'], [146_610_000, 147_390_000, 'repeaters (−/+600)'], [147_420_000, 147_570_000, 'simplex']] },
  { id: '1.25m', name: '1.25 m', lo: 222_000_000, hi: 225_000_000, mode: 'NFM', step: 20_000, offset: -1_600_000, calling: 223_500_000, segments: [[222_000_000, 222_150_000, 'CW / SSB'], [223_400_000, 223_520_000, 'simplex · 223.500 calling'], [223_850_000, 224_980_000, 'repeaters (−1.6)']] },
  { id: '70cm', name: '70 cm', lo: 420_000_000, hi: 450_000_000, mode: 'NFM', step: 12_500, offset: 5_000_000, calling: 446_000_000, segments: [[432_000_000, 432_300_000, 'CW / SSB · 432.100 calling'], [435_000_000, 438_000_000, 'satellites'], [442_000_000, 445_000_000, 'repeater outputs (+5)'], [445_000_000, 447_000_000, 'simplex · 446.000 calling'], [447_000_000, 450_000_000, 'repeater outputs (−5)']] },
  { id: '33cm', name: '33 cm', lo: 902_000_000, hi: 928_000_000, mode: 'NFM', step: 25_000, offset: -12_000_000, calling: 927_500_000, segments: [[902_000_000, 928_000_000, 'shared with ISM']] },
  { id: '23cm', name: '23 cm', lo: 1_240_000_000, hi: 1_300_000_000, mode: 'NFM', step: 25_000, offset: -20_000_000, calling: 1_294_500_000, segments: [[1_240_000_000, 1_300_000_000, 'FM / ATV / repeaters']] },
];

export const NON_HAM: Band[] = [
  { id: 'air', name: 'Air', lo: 118_000_000, hi: 137_000_000, mode: 'AM', step: 25_000, calling: 121_500_000, segments: [[118_000_000, 137_000_000, 'AM · 121.500 guard']] },
  { id: 'wx', name: 'NOAA', lo: 162_400_000, hi: 162_550_000, mode: 'NFM', step: 25_000, calling: 162_400_000, segments: [[162_400_000, 162_550_000, 'weather radio']] },
  { id: 'marine', name: 'Marine', lo: 156_000_000, hi: 162_025_000, mode: 'NFM', step: 25_000, calling: 156_800_000, segments: [[156_000_000, 162_025_000, 'VHF marine · ch 16 = 156.800']] },
  { id: 'frs', name: 'FRS/GMRS', lo: 462_550_000, hi: 467_725_000, mode: 'NFM', step: 12_500, calling: 462_562_500, segments: [[462_550_000, 462_725_000, 'ch 1–7 / 15–22'], [467_562_500, 467_712_500, 'ch 8–14']] },
];

export function bandOf(hz: number): Band | undefined { return BANDS.find(b => hz >= b.lo && hz <= b.hi) ?? NON_HAM.find(b => hz >= b.lo && hz <= b.hi); }
export function segmentOf(hz: number): string {
  const b = bandOf(hz); if (!b) return '';
  const s = b.segments.find(([lo, hi]) => hz >= lo && hz <= hi);
  return s ? `${b.name} · ${s[2]}` : b.name;
}
/** Repeater output segments and their offsets (US band plan); outside these a frequency is simplex. */
const REPEATER_SEGMENTS: [number, number, number][] = [
  [29_620_000, 29_700_000, -100_000],
  [51_620_000, 51_980_000, -500_000], [52_500_000, 52_980_000, -500_000], [53_000_000, 53_980_000, -1_000_000],
  [145_100_000, 145_500_000, -600_000], [146_610_000, 146_995_000, -600_000], [147_000_000, 147_390_000, 600_000],
  [223_850_000, 224_980_000, -1_600_000],
  [442_000_000, 445_000_000, 5_000_000], [447_000_000, 450_000_000, -5_000_000],
  [927_000_000, 928_000_000, -25_000_000],
  [1_282_000_000, 1_288_000_000, -12_000_000],
];
/** The repeater input for an output frequency (null when the frequency is not in a repeater output segment). */
export function repeaterInput(hz: number): number | null {
  const seg = REPEATER_SEGMENTS.find(([lo, hi]) => hz >= lo && hz <= hi);
  return seg ? hz + seg[2] : null;
}
