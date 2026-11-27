/**
 * The FRS/GMRS and MURS channel plans (FCC Part 95 Subparts B, E and J). FRS and GMRS share 22 channels: 1 to 7 at
 * 462.5625 to 462.7125 MHz and 8 to 14 at 467.5625 to 467.7125, both on 25 kHz steps, and 15 to 22 at 462.550 to
 * 462.725. Channels 15 to 22 are also GMRS repeater outputs, each listening 5 MHz up (467.550 to 467.725): the 8
 * repeater inputs, here 15R to 22R. 462.675 (channel 20) is where many listen for travelers and emergencies, by
 * custom only. MURS is five VHF channels: 151.820, 151.880, 151.940, 154.570 (Blue Dot) and 154.600 (Green Dot).
 */
import type { PlanInfo } from '../hamplus/plan.js';
import type { TrackerPlan } from '../hamplus/tracker.js';

export type GmrsBand = 'gmrs' | 'murs';
export interface GmrsChan {
  /** '1' to '22', '15R' to '22R' for the repeater inputs, 'M1' to 'M5' on MURS. */
  id: string; hz: number;
  /** 'frs' (1 to 14, low power), 'gmrs' (15 to 22, simplex or a repeater's output), 'input' (a repeater's input) or 'murs'. */
  kind: 'frs' | 'gmrs' | 'input' | 'murs';
  /** A repeater input's output, 5 MHz down; 0 for the rest. */
  outHz: number;
}

const ch = (id: string, hz: number, kind: GmrsChan['kind'], outHz = 0): GmrsChan => ({ id, hz, kind, outHz });
export const GMRS_CHANNELS: readonly GmrsChan[] = [
  ...[0, 1, 2, 3, 4, 5, 6].map(i => ch(String(i + 1), 462_562_500 + i * 25_000, 'frs')),
  ...[0, 1, 2, 3, 4, 5, 6].map(i => ch(String(i + 8), 467_562_500 + i * 25_000, 'frs')),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => ch(String(i + 15), 462_550_000 + i * 25_000, 'gmrs')),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => ch(`${i + 15}R`, 467_550_000 + i * 25_000, 'input', 462_550_000 + i * 25_000)),
];
export const MURS_CHANNELS: readonly GmrsChan[] = [151_820_000, 151_880_000, 151_940_000, 154_570_000, 154_600_000].map((hz, i) => ch(`M${i + 1}`, hz, 'murs'));
export const channelsOf = (b: GmrsBand) => b === 'murs' ? MURS_CHANNELS : GMRS_CHANNELS;
/** A repeater listens this far above its output. */
export const GMRS_RPT_OFFSET = 5_000_000;

/**
 * Where the radio is tuned. A HackRF at 8 MS/s hears all 30 GMRS channels from 465.140625 MHz: DC on no channel, and
 * the receiver's mirror image of each channel lands halfway between two others. A radio that cannot (an RTL-SDR) hears
 * the 15 channels at 462 MHz (1 to 7, 15 to 22) from 462.800 at 2.4 MS/s, its DC and mirror images clear of all of them. MURS: all five from
 * 153.000 at 4 MS/s, or the three at 151 MHz from 151.700 on an RTL-SDR, where no image falls on a channel either.
 */
export const GMRS_CENTER = 465_140_625, GMRS_NARROW_CENTER = 462_800_000, GMRS_RATE = 8_000_000;
export const MURS_CENTER = 153_000_000, MURS_NARROW_CENTER = 151_700_000, MURS_RATE = 4_000_000;
export const NARROW_RATE = 2_400_000;
export const centerOf = (b: GmrsBand, wide: boolean) => b === 'murs' ? (wide ? MURS_CENTER : MURS_NARROW_CENTER) : (wide ? GMRS_CENTER : GMRS_NARROW_CENTER);

/** The channel at [hz] (within 1 kHz) of either plan, or null. */
export function gmrsChan(hz: number): GmrsChan | null {
  for (const c of GMRS_CHANNELS) if (Math.abs(c.hz - hz) < 1_000) return c;
  for (const c of MURS_CHANNELS) if (Math.abs(c.hz - hz) < 1_000) return c;
  return null;
}
/** A repeater's input whose output is [hz], or 0. */
export const inputFor = (hz: number) => GMRS_CHANNELS.find(c => c.kind === 'input' && Math.abs(c.outHz - hz) < 1_000)?.hz ?? 0;

/** The name a channel goes by, '' for most. */
export function gmrsName(c: GmrsChan): string {
  if (c.id === '20') return 'TRAVEL / EMERGENCY';
  if (c.id === 'M4') return 'BLUE DOT';
  if (c.id === 'M5') return 'GREEN DOT';
  return c.kind === 'input' ? `REPEATER INPUT FOR ${c.id.slice(0, -1)}` : '';
}
/** How the screen titles a channel: 'CH 15', 'CH 15R', 'MURS 4'. */
export const gmrsTitle = (c: GmrsChan) => c.kind === 'murs' ? `MURS ${c.id.slice(1)}` : `CH ${c.id}`;

/**
 * GMRS callsigns as the FCC issues them: four letters and three digits (WRAB123), or the older three letters and four
 * digits (KAE1234).
 */
export const GMRS_CALL_RE = /^(?:WR[A-Z]{2}\d{3}|K[A-Z]{2}\d{4})$/;
/** An amateur callsign (a GMRS licensee may also hold one). */
const HAM_CALL_RE = /^(?:[A-Z]{1,2}|[A-Z]\d|\d[A-Z])\d[A-Z]{1,4}$/;
/** The callsigns in a Morse ID ('DE WRAB123', 'WRAB123/R'), each with whether it is a GMRS one. */
export function idCalls(text: string): { call: string; gmrs: boolean }[] {
  const out: { call: string; gmrs: boolean }[] = [];
  for (const w of text.toUpperCase().split(/\s+/)) {
    const c = (w.startsWith('DE') && w.length > 6 ? w.slice(2) : w).split('/')[0];
    const gmrs = GMRS_CALL_RE.test(c);
    if ((gmrs || (HAM_CALL_RE.test(c) && c.length >= 4)) && !out.some(x => x.call === c)) out.push({ call: c, gmrs });
  }
  return out;
}

export function gmrsPlanInfo(hz: number): PlanInfo {
  const c = gmrsChan(hz);
  if (!c) return { label: '', use: '', offsets: [] };
  // 15 to 22 are simplex and repeater outputs both: the tracker learns a pair from its input keying with it
  return { label: gmrsName(c), use: c.kind === 'input' ? 'input' : 'simplex', offsets: c.kind === 'gmrs' ? [GMRS_RPT_OFFSET] : [] };
}
/** The tracker on GMRS and MURS: the activity map keeps a row a channel. */
export const GMRS_TRACKER_PLAN: TrackerPlan = { info: gmrsPlanInfo, heatRow: hz => { const c = gmrsChan(hz); return c ? `CH${c.id}` : ''; } };
