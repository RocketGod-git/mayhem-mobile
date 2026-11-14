/** Decoders for InterMet iMet-1/iMet-4 (AFSK), iMet-54, Meisei iMS-100 / RS-11G. */
import type { ChannelDecoder } from './bank.js';
import type { SondeSink } from './types.js';

export function makeBankC(_rate: number, _sink: SondeSink): ChannelDecoder[] {
  return [];
}
