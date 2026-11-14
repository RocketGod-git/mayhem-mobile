/** Decoders for Graw DFM-06/09/17, Meteomodem M10/M20, MTS01. */
import { Framed, type ChannelDecoder } from './bank.js';
import type { SondeSink } from './types.js';
import { DfmChannel } from './dfm.js';
import { M10Decoder, M10_BAUD, M10_HEADER, M10_SYMS } from './m10.js';
import { Mts01Channel } from './mts01.js';

export function makeBankA(rate: number, sink: SondeSink): ChannelDecoder[] {
  const m10 = new M10Decoder();
  return [
    new DfmChannel(rate, sink),
    // M10 and M20 share the sync and the line code; the checksum and the type byte tell them apart
    new Framed('M10', M10_BAUD, rate, M10_HEADER, M10_SYMS, 2, s => m10.decode(s), sink),
    new Mts01Channel(rate, sink),
  ];
}
