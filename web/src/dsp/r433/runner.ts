/**
 * Running every decoder over every burst.
 *
 * There is no signal analysis here at all — that is the point of the design. A burst arrives, and each protocol
 * in turn slices it with its own timings and offers the resulting bits to its own decoder. Most decoders reject
 * it in their first few lines, on length or on a checksum. Whichever ones recognize it produce readings.
 *
 * Trying every protocol on every burst sounds wasteful and is not: slicing a few hundred pulses is arithmetic on
 * a small array, and it is what lets one receiver hear a few hundred different devices without being told in
 * advance which one is out there.
 */

import { BitBuffer } from './bitbuffer.js';
import { PulseKind } from './detect.js';
import { slice, type PulseData } from './slicers.js';
import { FSK_DEMOD_MIN_VAL, REGISTRY, type R433Data, type RDevice } from './device.js';

/** A reading, with the protocol that produced it. */
export interface R433Result {
  dev: RDevice;
  data: R433Data;
}

/**
 * The bits as they came off the air, before the decoder touched them.
 *
 * Worth keeping on every reading. Several decoders invert or unmask the buffer in place, so by the time a
 * reading exists the bits it came from are gone; and for anything not yet understood - an unknown flag, a field
 * rtl_433 marks as a guess, a device nobody has decoded at all - the raw frame is the only thing that lets the
 * question be taken any further.
 */
function snapshot(bits: BitBuffer): { n: number; bytes: Uint8Array }[] {
  const rows: { n: number; bytes: Uint8Array }[] = [];
  for (let r = 0; r < bits.numRows; r++) {
    const n = bits.bitsPerRow[r];
    if (n) rows.push({ n, bytes: bits.bb[r].slice(0, (n + 7) >> 3) });
  }
  return rows;
}

/** Format a snapshot the way rtl_433 writes its test codes, so it can be pasted straight back into that tool. */
function rawText(rows: { n: number; bytes: Uint8Array }[]): string {
  return rows.map(({ n, bytes }) => {
    let hex = '';
    for (const v of bytes) hex += v.toString(16).padStart(2, '0');
    return `{${n}}${hex}`;
  }).join('/');
}

/** Why a burst that looked like a real transmission was thrown away, for the "almost heard something" line. */
export interface R433Stats {
  bursts: number;
  ook: number;
  fsk: number;
  decoded: number;
  /** Transmissions a decoder claimed but whose checksum failed — a device in range, too weak to read. */
  badChecksum: number;
  /**
   * Which protocols those near misses belonged to, and how many each.
   *
   * This is the most useful diagnostic the receiver has and it used to be thrown away. A frame that reaches a
   * decoder's checksum got through the length and the header and the sanity checks first, so the protocol is
   * almost certainly right and only the last few bits were wrong. Seeing "LaCrosse-TX141 ×6" means there is a
   * LaCrosse out there and the aerial or the gain is not quite good enough for it; seeing nothing but tire
   * sensors means there is genuinely nothing else transmitting nearby, which is a different problem entirely.
   */
  near: Record<string, number>;
}

export class R433 {
  readonly stats: R433Stats = { bursts: 0, ook: 0, fsk: 0, decoded: 0, badChecksum: 0, near: {} };
  /** Protocols to try. Defaults to everything registered; narrow it to save work on a slow phone. */
  devices: RDevice[];

  constructor(devices?: RDevice[]) {
    // Everything runs. rtl_433 ships a handful of these switched off because they have no usable checksum and
    // will occasionally claim another maker's transmission; that judgement is kept on each device as a note,
    // but it no longer decides anything. Hearing a doubtful reading beats not hearing a real one.
    this.devices = (devices ?? REGISTRY.slice())
      .slice()
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  }

  /** Try every protocol against one burst and return whatever was recognized. */
  run(kind: PulseKind, pulses: PulseData): R433Result[] {
    const out: R433Result[] = [];
    this.stats.bursts++;
    if (kind === PulseKind.FSK) this.stats.fsk++; else this.stats.ook++;
    const wantFsk = kind === PulseKind.FSK;

    for (const dev of this.devices) {
      if ((dev.modulation >= FSK_DEMOD_MIN_VAL) !== wantFsk) continue;
      let raw: { n: number; bytes: Uint8Array }[] = [];
      const ctx = {
        // The raw frame goes on every reading, formatted only when there is a reading to put it on.
        emit: (d: R433Data) => { out.push({ dev, data: { ...d, raw: rawText(raw), protocol: dev.num } }); },
      };
      slice(pulses, dev, (bits: BitBuffer) => {
        let n = 0;
        raw = snapshot(bits);
        try {
          n = dev.decode(dev, bits, ctx);
        } catch {
          n = 0;                                     // a decoder that throws must not take the receiver with it
        }
        if (n === -3) {                              // DECODE_FAIL_MIC
          this.stats.badChecksum++;
          this.stats.near[dev.name] = (this.stats.near[dev.name] ?? 0) + 1;
        }
        bits.clear();                                // every message starts from a clean buffer
        return n > 0 ? n : 0;
      });
    }
    this.stats.decoded += out.length;
    return out;
  }
}
