/**
 * The app's own vocoders behind Dispatch's codec plug point: IMBE (ham/imbe.ts) for P25 Phase 1 full rate, and
 * AMBE+2 3600x2450 (ham/mbe.ts) for DMR, fed through the DMR frame de-interleave the HAM receiver uses. Each call
 * gets its own decoder state. No DOM.
 */
import { registerCodec } from './codec.js';
import { ImbeDecoder } from '../ham/imbe.js';
import { AmbeDecoder } from '../ham/mbe.js';
import { rW, rX, rY, rZ } from '../ham/dmr.js';

/** 9.5 dB under the HAM receiver's level: loud talkers on a trunked system no longer clip inside the vocoder. The
 *  output stage (codec.ts) makes the level up and limits softly. */
export const VOCODER_GAIN = 7 / 32768 / 3;
/** A muted frame is not left at exact zero mid-call: a faint noise floor (about -80 dBFS) keeps the output alive. */
function comfort(pcm: Float32Array): Float32Array {
  for (let i = 0; i < pcm.length; i++) if (pcm[i] !== 0) return pcm;
  for (let i = 0; i < pcm.length; i++) pcm[i] = (Math.random() - 0.5) * 2e-4;
  return pcm;
}
registerCodec('imbe', () => {
  const d = new ImbeDecoder(); d.outGain = VOCODER_GAIN;
  return { id: 'imbe', reset: () => d.reset(), decode: (bits: Uint8Array) => comfort(bits.length ? d.decodeVoice(bits).slice() : d.erase().slice()), get bad() { return d.status === 'R' || d.status === 'M'; } };
});
registerCodec('ambe2', () => {
  const d = new AmbeDecoder(); d.outGain = VOCODER_GAIN;
  const fr: [Uint8Array, Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(24), new Uint8Array(24), new Uint8Array(24), new Uint8Array(24)];
  return {
    id: 'ambe2', reset: () => d.reset(), get bad() { return d.status === 'R' || d.status === 'M'; }, get silent() { return d.status === 'S'; },
    /** One 72-bit frame as it sits in the burst: 36 dibits, each split across the four code words. */
    decode: (bits: Uint8Array) => {
      // an empty frame is an erasure: the last frame again, faded (muted after a few), never a burst of noise
      if (!bits.length) return comfort(d.erase().slice());
      for (const row of fr) row.fill(0);
      for (let i = 0; i < 36; i++) { fr[rW[i]][rX[i]] = bits[2 * i]; fr[rY[i]][rZ[i]] = bits[2 * i + 1]; }
      return comfort(d.decode(fr).slice());
    },
  };
});
