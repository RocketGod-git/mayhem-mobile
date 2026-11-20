/**
 * Where a vocoder plugs into Dispatch. A call's voice frames are handed to the codec for its air interface; with no
 * codec registered the call is still followed and shown, without audio. No DOM.
 *  - 'imbe': P25 Phase 1 full rate, 144-bit frames (88 voice bits under FEC), 20 ms each.
 *  - 'ambe2': half rate, 72-bit frames (49 voice bits under FEC), 20 ms each: DMR and P25 Phase 2.
 *  - 'tetra': the TETRA ACELP codec, 137-bit frames (after the speech channel decoding), 30 ms each.
 */
export type CodecId = 'imbe' | 'ambe2' | 'tetra';
export interface VoiceCodec {
  readonly id: CodecId;
  /** One frame of bits (one per byte, as sent) to 8 kHz audio (160 samples, 240 for TETRA), or null for a frame it drops. */
  decode(bits: Uint8Array): Float32Array | null;
  /** The last frame decoded was past its error correction (repeated or muted by the vocoder). */
  readonly bad?: boolean;
  /** The last frame was the codec's own silence (a radio keyed with nobody talking): it neither takes nor keeps the audio. */
  readonly silent?: boolean;
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
 * 8 kHz vocoder audio to 48 kHz through a proper interpolation filter: six phases of a 120-tap windowed sinc
 * (Blackman, cut at 3.7 kHz), so the images of the speech band at 8, 16 and 24 kHz are filtered out instead of left
 * in, as straight-line interpolation leaves them (heard as a harsh, buzzy edge on every voice). 1.25 ms of delay.
 */
const UP = 6, UP_TAPS = 120, UP_PH = UP_TAPS / UP;
const UP_H = (() => {
  const h = new Float32Array(UP_TAPS), m = (UP_TAPS - 1) / 2, fc = 3700 / 48_000; let sum = 0;
  for (let i = 0; i < UP_TAPS; i++) {
    const x = i - m, sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x), t = i / (UP_TAPS - 1);
    h[i] = sinc * (0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t)); sum += h[i];
  }
  for (let i = 0; i < UP_TAPS; i++) h[i] *= UP / sum;
  return h;
})();
/** Make-up for the vocoders' headroom (vocoders.ts): the level the listener asked for, with room above it. */
export const MAKEUP = 2;
/** Linear to 0.8, then a smooth knee that never passes 1: peaks round off instead of clipping. */
export const soft = (x: number) => { const a = x < 0 ? -x : x; if (a <= 0.8) return x; const y = 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2); return x < 0 ? -y : y; };
export class Upsampler {
  private readonly hist = new Float32Array(UP_PH); private pos = 0;
  reset(): void { this.hist.fill(0); this.pos = 0; }
  process(pcm: ArrayLike<number>, gain: number, n = pcm.length): Float32Array {
    const out = new Float32Array(n * UP), hist = this.hist;
    for (let i = 0; i < n; i++) {
      hist[this.pos] = pcm[i];
      for (let p = 0; p < UP; p++) {
        let s = 0, k = this.pos;
        for (let j = 0; j < UP_PH; j++) { s += UP_H[j * UP + p] * hist[k]; if (--k < 0) k = UP_PH - 1; }
        out[i * UP + p] = soft(gain * s);
      }
      if (++this.pos >= UP_PH) this.pos = 0;
    }
    return out;
  }
}

/**
 * The live output of Dispatch: 8 kHz vocoder audio to 48 kHz (through [Upsampler]), faded in over [fadeIn] samples
 * when a different call starts, and faded out over [fadeOut] when the call heard changes or ends (the filter is run
 * out under the fade), so the switch between calls never clicks.
 */
export class AudioFader {
  private key = ''; private ramp = 0; private gain = 1; private live = false;
  private readonly up = new Upsampler();
  constructor(readonly fadeIn = 480, readonly fadeOut = 240) {}
  get current(): string { return this.key; }
  push(pcm: Float32Array, key: string, gain: number): Float32Array[] {
    const out: Float32Array[] = [];
    if (key !== this.key) { const t = this.tail(); if (t) out.push(t); this.key = key; this.ramp = 0; }
    this.gain = gain; this.live = true;
    const y = this.up.process(pcm, gain * MAKEUP);
    for (let i = 0; i < y.length && this.ramp < this.fadeIn; i++, this.ramp++) y[i] *= this.ramp / this.fadeIn;
    out.push(y);
    return out;
  }
  /** The fade out: the filter run out over [fadeOut] samples under a ramp to zero, or null when nothing is playing. */
  tail(): Float32Array | null {
    const was = this.live;
    this.key = ''; this.ramp = 0; this.live = false;
    if (!was) { this.up.reset(); return null; }
    const t = this.up.process(new Float32Array(Math.ceil(this.fadeOut / UP)), this.gain * MAKEUP).subarray(0, this.fadeOut);
    for (let i = 0; i < t.length; i++) t[i] *= 1 - (i + 1) / t.length;
    this.up.reset();
    return t;
  }
}
