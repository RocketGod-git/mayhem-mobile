/**
 * The four JS8 speeds. Symbol rates, tone spacings, transmit lengths and slot lengths are from the JS8Call User
 * Guide's modulation table; the first-tone delays after the slot boundary are the published nominal ones.
 */
import { COSTAS_MODIFIED, COSTAS_ORIGINAL } from './tables.js';

export type Js8Speed = 'slow' | 'normal' | 'fast' | 'turbo';

export interface Js8Mode {
  readonly id: Js8Speed;
  readonly label: string;
  /** Slot length, seconds. */
  readonly period: number;
  /** Symbol length, seconds (79 symbols per frame). */
  readonly symbol: number;
  /** Tone spacing, Hz (= the baud rate). */
  readonly spacing: number;
  /** Nominal first-tone time after the slot boundary, seconds. */
  readonly delay: number;
  readonly costas: readonly (readonly number[])[];
  /** Working sample rate: a power-of-two number of samples per symbol. */
  readonly fs: number;
  /** Decoder threshold quoted by the guide relative to Normal, dB (Normal is -24 dB in 2500 Hz). */
  readonly threshold: number;
}

export const JS8_MODES: readonly Js8Mode[] = [
  { id: 'slow', label: 'SLOW', period: 30, symbol: 0.32, spacing: 3.125, delay: 0.5, costas: COSTAS_MODIFIED, fs: 12_800, threshold: -27 },
  { id: 'normal', label: 'NORMAL', period: 15, symbol: 0.16, spacing: 6.25, delay: 0.5, costas: COSTAS_ORIGINAL, fs: 12_800, threshold: -24 },
  { id: 'fast', label: 'FAST', period: 10, symbol: 0.1, spacing: 10, delay: 0.2, costas: COSTAS_MODIFIED, fs: 10_240, threshold: -22 },
  { id: 'turbo', label: 'TURBO', period: 6, symbol: 0.05, spacing: 20, delay: 0.1, costas: COSTAS_MODIFIED, fs: 10_240, threshold: -18 },
];
export const js8Mode = (id: Js8Speed): Js8Mode => JS8_MODES.find(m => m.id === id)!;
export const SYMBOLS = 79;
/** Seconds one frame is on the air. */
export const frameSeconds = (m: Js8Mode): number => SYMBOLS * m.symbol;
/** Samples per symbol at the mode's working rate. */
export const symSamples = (m: Js8Mode): number => Math.round(m.symbol * m.fs);
/** Start of the slot holding `ms`, epoch milliseconds. */
export const slotStart = (m: Js8Mode, ms: number): number => Math.floor(ms / (m.period * 1000)) * m.period * 1000;

/** Suggested JS8 dial frequencies, USB (JS8Call User Guide, Frequencies). */
export const JS8_DIALS: readonly [string, number][] = [
  ['160m', 1_842_000], ['80m', 3_578_000], ['40m', 7_078_000], ['30m', 10_130_000], ['20m', 14_078_000], ['17m', 18_104_000],
  ['15m', 21_078_000], ['12m', 24_922_000], ['10m', 28_078_000], ['6m', 50_318_000], ['2m', 144_178_000],
];
/** JS8Call keeps its transmissions out of the lowest 500 Hz of the passband; heartbeats sit in 500-1000 Hz. */
export const TX_MIN_HZ = 500, TX_MAX_HZ = 2900, HB_LO_HZ = 500, HB_HI_HZ = 1000;
