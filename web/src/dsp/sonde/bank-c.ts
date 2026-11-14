/** Decoders for InterMet iMet-1/iMet-4 (AFSK), iMet-54, Meisei iMS-100 / RS-11G. */
import type { ChannelDecoder } from './bank.js';
import type { SondeSink } from './types.js';
import { ImetDecoder } from './imet.js';
import { Imet54Channel } from './imet54.js';
import { MeiseiChannel } from './meisei.js';

export function makeBankC(rate: number, sink: SondeSink): ChannelDecoder[] {
  return [
    new ImetDecoder(rate, sink),
    new Imet54Channel(rate, sink),
    new MeiseiChannel(rate, sink),
  ];
}
