/**
 * Where a vocoder plugs into Dispatch. A call's voice frames are handed to the codec for its air interface; with no
 * codec registered the call is still followed and shown, without audio. No DOM.
 *  - 'imbe': P25 Phase 1 full rate, 144-bit frames (88 voice bits under FEC), 20 ms each.
 *  - 'ambe2': half rate, 72-bit frames (49 voice bits under FEC), 20 ms each: DMR and P25 Phase 2.
 */
export type CodecId = 'imbe' | 'ambe2';
export interface VoiceCodec {
  readonly id: CodecId;
  /** One frame of bits (one per byte, as sent) to 160 samples of 8 kHz audio, or null for a frame it drops. */
  decode(bits: Uint8Array): Float32Array | null;
  reset(): void;
}
const registry = new Map<CodecId, () => VoiceCodec>();
export function registerCodec(id: CodecId, make: () => VoiceCodec): void { registry.set(id, make); }
export function makeCodec(id: CodecId): VoiceCodec | null { const f = registry.get(id); return f ? f() : null; }
export const hasCodec = (id: CodecId) => registry.has(id);

/** 8 kHz vocoder audio to the 48 kHz output, linear between samples, times [gain]. */
export function to48k(pcm: Float32Array, gain: number, prev = 0): Float32Array {
  const out = new Float32Array(pcm.length * 6);
  let a = prev;
  for (let i = 0; i < pcm.length; i++) { const b = pcm[i]; for (let k = 0; k < 6; k++) out[i * 6 + k] = gain * (a + (b - a) * (k + 1) / 6); a = b; }
  return out;
}

/**
 * The live output of Dispatch: 8 kHz vocoder audio to 48 kHz, faded in over [fadeIn] samples when a different call
 * starts, and faded out from its last sample over [fadeOut] when the call heard changes or ends, so the switch
 * between calls never clicks.
 */
export class AudioFader {
  private key = ''; private prev = 0; private ramp = 0; private last = 0;
  constructor(readonly fadeIn = 480, readonly fadeOut = 240) {}
  get current(): string { return this.key; }
  push(pcm: Float32Array, key: string, gain: number): Float32Array[] {
    const out: Float32Array[] = [];
    if (key !== this.key) { const t = this.tail(); if (t) out.push(t); this.key = key; this.prev = 0; this.ramp = 0; }
    const y = to48k(pcm, gain, this.prev);
    this.prev = pcm.length ? pcm[pcm.length - 1] : this.prev;
    for (let i = 0; i < y.length && this.ramp < this.fadeIn; i++, this.ramp++) y[i] *= this.ramp / this.fadeIn;
    this.last = y.length ? y[y.length - 1] : this.last;
    out.push(y);
    return out;
  }
  /** The fade out from the last sample sent, or null when nothing is playing (or it already ended near zero). */
  tail(): Float32Array | null {
    const a = this.last;
    this.key = ''; this.last = 0; this.prev = 0; this.ramp = 0;
    if (Math.abs(a) < 1e-4) return null;
    const t = new Float32Array(this.fadeOut);
    for (let i = 0; i < t.length; i++) t[i] = a * (1 - (i + 1) / t.length);
    return t;
  }
}
