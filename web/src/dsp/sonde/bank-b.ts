/** Decoders for Vaisala RS92, Lockheed Martin LMS6-403 / LMSX, LMS6-1680 (Mk2a), MRZ. */
import type { ChannelDecoder } from './bank.js';
import type { SondeSink } from './types.js';

export function makeBankB(_rate: number, _sink: SondeSink): ChannelDecoder[] {
  return [];
}
