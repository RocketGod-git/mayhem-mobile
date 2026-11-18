/**
 * The app's own vocoders behind Dispatch's codec plug point: IMBE (ham/imbe.ts) for P25 Phase 1 full rate, and
 * AMBE+2 3600x2450 (ham/mbe.ts) for DMR, fed through the DMR frame de-interleave the HAM receiver uses. Each call
 * gets its own decoder state. No DOM.
 */
import { registerCodec } from './codec.js';
import { ImbeDecoder } from '../ham/imbe.js';
import { AmbeDecoder } from '../ham/mbe.js';
import { rW, rX, rY, rZ } from '../ham/dmr.js';

registerCodec('imbe', () => {
  const d = new ImbeDecoder();
  return { id: 'imbe', reset: () => d.reset(), decode: (bits: Uint8Array) => d.decodeVoice(bits).slice() };
});
registerCodec('ambe2', () => {
  const d = new AmbeDecoder();
  const fr: [Uint8Array, Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(24), new Uint8Array(24), new Uint8Array(24), new Uint8Array(24)];
  return {
    id: 'ambe2', reset: () => d.reset(),
    /** One 72-bit frame as it sits in the burst: 36 dibits, each split across the four code words. */
    decode: (bits: Uint8Array) => {
      for (const row of fr) row.fill(0);
      for (let i = 0; i < 36; i++) { fr[rW[i]][rX[i]] = bits[2 * i]; fr[rY[i]][rZ[i]] = bits[2 * i + 1]; }
      return d.decode(fr).slice();
    },
  };
});
