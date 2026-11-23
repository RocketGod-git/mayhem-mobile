/**
 * Voice for the identity layer: the app's own vocoders, one state per voice stream. AMBE+2 half rate (3600x2450) takes
 * a 72-bit frame in the order DMR sends it, which is the order P25 Phase 2, NXDN (EHR) and dPMR send it too; IMBE takes
 * a P25 Phase 1 (or NXDN EFR) 144-bit frame as sent. Each frame gives 160 samples at 8 kHz. Nothing random is added,
 * so every platform gives the same samples for the same frames. No DOM.
 */
import { AmbeDecoder } from '../ham/mbe.js';
import { ImbeDecoder } from '../ham/imbe.js';
import { rW, rX, rY, rZ } from '../ham/dmr.js';

/** The level Dispatch's vocoders use (9.5 dB under the HAM receiver's), so loud talkers do not clip. */
export const HAMID_VOICE_GAIN = 7 / 32768 / 3;
export const HAMID_VOICE_RATE = 8000;

export class AmbeStream {
  private readonly d = new AmbeDecoder();
  private readonly fr: [Uint8Array, Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(24), new Uint8Array(24), new Uint8Array(24), new Uint8Array(24)];
  frames = 0;
  constructor() { this.d.outGain = HAMID_VOICE_GAIN; }
  reset(): void { this.d.reset(); this.frames = 0; }
  /** One 72-bit frame, or an empty one for a frame lost (the decoder repeats, then mutes). */
  decode(bits: ArrayLike<number>): Float32Array {
    this.frames++;
    if (!bits.length) return this.d.erase().slice();
    for (const row of this.fr) row.fill(0);
    for (let i = 0; i < 36; i++) { this.fr[rW[i]][rX[i]] = bits[2 * i]; this.fr[rY[i]][rZ[i]] = bits[2 * i + 1]; }
    return this.d.decode(this.fr).slice();
  }
}

export class ImbeStream {
  private readonly d = new ImbeDecoder();
  private readonly b = new Uint8Array(144);
  frames = 0;
  constructor() { this.d.outGain = HAMID_VOICE_GAIN; }
  reset(): void { this.d.reset(); this.frames = 0; }
  decode(bits: ArrayLike<number>): Float32Array {
    this.frames++;
    if (bits.length < 144) return this.d.erase().slice();
    for (let i = 0; i < 144; i++) this.b[i] = bits[i];
    return this.d.decodeVoice(this.b).slice();
  }
}
