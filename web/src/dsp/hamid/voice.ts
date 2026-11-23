/**
 * Voice out of a repeater channel: the vocoder frames the DMR, D-STAR and Fusion receivers take off the air, each with
 * the time it was sent, turned into 8 kHz audio by the app's own vocoders (ham/mbe.ts, ham/imbe.ts):
 *
 *   · 'ambe2': a 72-bit AMBE+2 3600x2450 frame with the vocoder's own error correction, in the order it is sent
 *     (DMR voice bursts, ETSI TS 102 361-1; Fusion V/D mode 1, whose VCH carries the same 72-bit frame);
 *   · 'ambe2-49': the 49 AMBE+2 voice bits without that correction (Fusion V/D mode 2, whose VCH and VeCH carry them
 *     under Yaesu's own majority code: the first 27 bits three times each, then 22, then a zero bit, whitened with the
 *     PN (9,5) sequence and interleaved 26 by 4, Yaesu "Amateur Radio Digital Specifications" 4.5 (3));
 *   · 'imbe': a 144-bit full rate frame (Fusion Voice FR, AMBE+2 full rate at 7200 bps, the IMBE-compatible mode);
 *   · 'ambe-dstar': a 72-bit D-STAR frame (AMBE 3600x2400). Its bit order and parameter tables are not in a published
 *     standard and the app has no decoder for it, so it comes out as frames with their timing and no audio.
 * No DOM.
 */
import { AmbeDecoder, golayParity, popcount } from '../ham/mbe.js';
import { ImbeDecoder } from '../ham/imbe.js';
import { rW, rX, rY, rZ } from '../ham/dmr.js';
import { ysfWhitening } from './ysf.js';

export type HamVoiceCodec = 'ambe2' | 'ambe2-49' | 'imbe' | 'ambe-dstar';
/** A vocoder frame as a receiver took it off the air. [stream]: 'dmr1', 'dmr2', 'dstar' or 'ysf'. */
export interface HamVoiceFrame { stream: string; codec: HamVoiceCodec; bits: Uint8Array; atSym: number; errs: number }
/** One frame of audio: 160 samples at 8 kHz (20 ms), or null when there is no decoder for the codec or the voice is
 *  encrypted. [atS]: when the frame was sent, seconds from the channel's start. [status]: the vocoder's ('' voice,
 *  'R' repeated, 'M' muted, 'S' silence, 'E' erasure, 'T' tone), or 'no vocoder', or 'encrypted'. */
export interface HamPcmFrame { stream: string; codec: HamVoiceCodec; atS: number; pcm: Float32Array | null; status: string; errs: number; bits: Uint8Array }

let WHITE104: Uint8Array | null = null;

/** Fusion V/D mode 2: the 52 dibits of a VCH and its VeCH → the 49 voice bits, by majority over the three copies. */
export function ysfVd2Voice(d: ArrayLike<number>): { bits: Uint8Array; errs: number } {
  const s = new Uint8Array(104), W = WHITE104 ??= ysfWhitening(104);
  for (let k = 0; k < 104; k++) { const v = d[k >> 1]; s[26 * (k % 4) + (k >> 2)] = ((k & 1 ? v : v >> 1) & 1) ^ W[26 * (k % 4) + (k >> 2)]; }
  const bits = new Uint8Array(49); let errs = 0;
  for (let i = 0; i < 27; i++) { const n = s[3 * i] + s[3 * i + 1] + s[3 * i + 2]; bits[i] = n >= 2 ? 1 : 0; if (n === 1 || n === 2) errs++; }
  for (let i = 27; i < 49; i++) bits[i] = s[81 + i - 27];
  return { bits, errs };
}

/** 49 AMBE+2 voice bits → the four code words the decoder takes (C0 and C1 with their Golay parity, C1 scrambled). */
export function ambe49Frame(d: ArrayLike<number>): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] {
  const fr: [Uint8Array, Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(24), new Uint8Array(24), new Uint8Array(24), new Uint8Array(24)];
  let u0 = 0, u1 = 0;
  for (let i = 0; i < 12; i++) { u0 = (u0 << 1) | (d[i] & 1); u1 = (u1 << 1) | (d[12 + i] & 1); }
  const c0 = (u0 << 11) | golayParity(u0, 12), c1 = (u1 << 11) | golayParity(u1, 12);
  for (let j = 1; j <= 23; j++) fr[0][j] = (c0 >>> (j - 1)) & 1;
  fr[0][0] = popcount(c0) & 1;
  let pr = 16 * u0;
  for (let j = 22; j >= 0; j--) { pr = (173 * pr + 13849) % 65536; fr[1][j] = ((c1 >>> j) & 1) ^ (pr >>> 15); }
  for (let i = 0; i < 11; i++) fr[2][10 - i] = d[24 + i] & 1;
  for (let i = 0; i < 14; i++) fr[3][13 - i] = d[35 + i] & 1;
  return fr;
}

/** A 72-bit AMBE+2 frame as sent → the four code words (the de-interleave the DMR receiver uses). */
export function ambe72Frame(bits: ArrayLike<number>): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] {
  const fr: [Uint8Array, Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(24), new Uint8Array(24), new Uint8Array(24), new Uint8Array(24)];
  for (let i = 0; i < 36; i++) { fr[rW[i]][rX[i]] = bits[2 * i] & 1; fr[rY[i]][rZ[i]] = bits[2 * i + 1] & 1; }
  return fr;
}

/** Each stream's vocoder state, kept from frame to frame. */
export class HamVoice {
  private readonly ambe = new Map<string, AmbeDecoder>();
  private readonly imbe = new Map<string, ImbeDecoder>();
  reset(): void { this.ambe.clear(); this.imbe.clear(); }
  /** Forgets one stream's state (a new call on it). */
  restart(stream: string): void { this.ambe.delete(stream); this.imbe.delete(stream); }

  decode(f: HamVoiceFrame, encrypted = false): HamPcmFrame {
    const out: HamPcmFrame = { stream: f.stream, codec: f.codec, atS: f.atSym / 4800, pcm: null, status: '', errs: f.errs, bits: f.bits };
    if (f.codec === 'ambe-dstar') { out.status = 'no vocoder'; return out; }
    if (encrypted) { out.status = 'encrypted'; return out; }
    if (f.codec === 'imbe') {
      let d = this.imbe.get(f.stream); if (!d) { d = new ImbeDecoder(); this.imbe.set(f.stream, d); }
      out.pcm = d.decodeVoice(f.bits).slice(); out.status = d.status; out.errs += d.errs;
      return out;
    }
    let d = this.ambe.get(f.stream); if (!d) { d = new AmbeDecoder(); this.ambe.set(f.stream, d); }
    out.pcm = d.decode(f.codec === 'ambe2' ? ambe72Frame(f.bits) : ambe49Frame(f.bits)).slice(); out.status = d.status; out.errs += d.errs;
    return out;
  }
}
