/**
 * Every sonde decoder a channel runs, side by side on the same discriminator: whichever finds its sync word and
 * passes its checks names the type. The TypeScript twin of core/sonde/SondeBank.kt and SondeBank.swift.
 */
import { FskFramer, type SondeFrame, type SondeSink } from './types.js';
import { Rs41Decoder, RS41_BAUD, RS41_HEADER, RS41_SYMS } from './rs41.js';
import { makeBankA } from './bank-a.js';
import { makeBankB } from './bank-b.js';
import { makeBankC } from './bank-c.js';

/** `hz`: a decoder that wants its channel's frequency (iMet IDs are made from it) declares it; the channel keeps it set. */
export interface ChannelDecoder { readonly name: string; push(x: number): void; hz?: number }

/** A framer and a frame decoder: the shape most types take. */
export class Framed implements ChannelDecoder {
  private readonly fr: FskFramer;
  constructor(readonly name: string, baud: number, rate: number, header: string, syms: number, maxErr: number,
    decode: (soft: Float32Array) => SondeFrame | SondeFrame[] | null, sink: SondeSink) {
    this.fr = new FskFramer(baud, rate, header, syms, maxErr, soft => {
      const r = decode(soft);
      if (!r) return;
      for (const f of Array.isArray(r) ? r : [r]) if (f.serial) sink(f);
    });
  }
  push(x: number): void { this.fr.push(x); }
}

export function makeDecoders(rate: number, sink: SondeSink): ChannelDecoder[] {
  const rs41 = new Rs41Decoder();
  return [
    new Framed('RS41', RS41_BAUD, rate, RS41_HEADER, RS41_SYMS, 3, s => rs41.decode(s), sink),
    ...makeBankA(rate, sink), ...makeBankB(rate, sink), ...makeBankC(rate, sink),
  ];
}
