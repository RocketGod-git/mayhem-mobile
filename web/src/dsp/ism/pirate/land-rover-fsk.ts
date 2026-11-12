/**
 * Land Rover FSK: a receive-only decoder for a Land Rover key fob that ProtoPirate does not cover (its "Land Rover V0"
 * is an alias of Honda V2, a different protocol). Worked out from recordings of a real fob at 315 MHz; not a port
 * of any C source. Twin of pirate/PPLandRoverFsk.kt.
 *
 * On air: 2-FSK, about +-23 kHz deviation, Manchester at 64 us per half bit (7.8 kbit/s). One press sends each frame
 * on three channels about 318 kHz apart (around 314.69, 315.005 and 315.32 MHz), each after a 50 ms bare carrier.
 * A frame is a run of 1010 preamble bits, then 144 bits (18 bytes, MSB first, a half bit high then low = 1):
 *
 *   bytes 0..4   fixed (D3 68 3C 0E 24 on the fob this was built from)
 *   byte  5      channel << 3: 0 = 315.005, 1 = the lower channel, 2 = the upper channel
 *   bytes 6..7   fixed (A8 24)
 *   bytes 8..15  hop: 64 bits that change on every repeat; encrypted, shown as received, never decrypted
 *   bytes 16..17 CRC-16 (poly 0x1021, init 0) over bytes 4..15
 *
 * The frame starts on the first repeated bit after at least 8 alternating preamble bits. Whether bytes 0..4 are a
 * per-fob ID or a sync word shared by every fob of this type is not known, so no serial is claimed; no button or
 * counter is visible in the clear. The same hop heard again on another channel is not shown again.
 */
import { PPDecoder, PPModulation, ppConst, PPMath, hx, ppField, type PPHit } from './pp-base.js';

const FRAME_BITS = 144, FRAME_BYTES = 18;
const PREAMBLE_MIN = 8;
/** Half bits held for one frame: preamble (about 50 bits) plus 144 data bits, two half bits each, with room to spare. */
const HALF_CAP = 512;

const hexBytes = (k: number[], from: number, to: number): string => { let s = ''; for (let i = from; i <= to; i++) s += hx('%02X', k[i]); return s; };

export class PPLandRoverFsk extends PPDecoder {
  private readonly half = new Uint8Array(HALF_CAP);
  private halfCount = 0;
  private frame: number[] = new Array<number>(FRAME_BYTES).fill(0);
  private last: number[] = new Array<number>(FRAME_BYTES).fill(0);
  private lastValid = false;

  constructor() { super('Land Rover FSK', PPModulation.FM, ppConst(64, 128, 32, FRAME_BITS)); }

  override reset(): void { super.reset(); this.halfCount = 0; this.lastValid = false; }

  /** Manchester pairs from one half-bit phase: 1 (high, low), 0 (low, high), -1 for a broken pair. */
  private pairs(phase: number): Int8Array {
    const n = Math.max(0, (this.halfCount - phase) >> 1);
    const out = new Int8Array(n);
    for (let j = 0; j < n; j++) {
      const a = this.half[phase + 2 * j], b = this.half[phase + 2 * j + 1];
      out[j] = a === b ? -1 : a;
    }
    return out;
  }

  /** The 18 bytes from bit `start`, or null when a pair is broken, the channel byte is not one of the three, or the CRC fails. */
  private frameAt(bits: Int8Array, start: number): number[] | null {
    const f = new Array<number>(FRAME_BYTES).fill(0);
    for (let i = 0; i < FRAME_BITS; i++) {
      const b = bits[start + i];
      if (b < 0) return null;
      if (b) f[i >> 3] |= 0x80 >> (i & 7);
    }
    if ((f[5] & 0xE7) !== 0 || (f[5] >> 3) > 2) return null;
    if (PPMath.crc16(f.slice(4, 16), 0x1021, 0) !== ((f[16] << 8) | f[17])) return null;
    return f;
  }

  private process(): void {
    for (let phase = 0; phase < 2; phase++) {
      const bits = this.pairs(phase);
      let run = 0;
      for (let i = 1; i + FRAME_BITS <= bits.length; i++) {
        if (bits[i] < 0 || bits[i - 1] < 0) { run = 0; continue; }
        if (bits[i] !== bits[i - 1]) { run++; continue; }
        const enough = run >= PREAMBLE_MIN;
        run = 0;
        if (!enough) continue;
        const f = this.frameAt(bits, i);
        if (f) { this.commit(f); return; }
      }
    }
  }

  private commit(f: number[]): void {
    // The same frame on another channel differs only in byte 5 and the CRC.
    let same = this.lastValid;
    for (let i = 0; same && i < 16; i++) if (i !== 5 && f[i] !== this.last[i]) same = false;
    if (same) return;
    this.frame = f; this.last = f.slice(); this.lastValid = true;
    this.dataCountBit = FRAME_BITS;
    this.emit();
  }

  feed(level: boolean, duration: number): void {
    const k = this.isShort(duration) ? 1 : this.isLong(duration) ? 2 : 0;
    if (k === 0 || this.halfCount + k > HALF_CAP) {
      // A pulse longer than a long one at the end of a frame still starts with the last half bit.
      if (k === 0 && duration > this.c.teLong && this.halfCount < HALF_CAP) this.half[this.halfCount++] = level ? 1 : 0;
      if (this.halfCount >= 2 * FRAME_BITS) this.process();
      this.halfCount = 0;
      if (k === 0) return;
    }
    for (let j = 0; j < k; j++) this.half[this.halfCount++] = level ? 1 : 0;
  }

  override describe(): PPHit {
    const k = this.frame;
    return { name: this.name, bits: this.dataCountBit, key: hexBytes(k, 0, 17), serial: null, btn: null, cnt: null,
      fields: [{ name: 'Fixed', value: hexBytes(k, 0, 4) + ' ' + hexBytes(k, 6, 7) }, { name: 'Ch', value: String(k[5] >> 3) },
        { name: 'Hop', value: hexBytes(k, 8, 15) }, { name: 'Crc', value: hexBytes(k, 16, 17) }] };
  }

  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | Key:${h.key} | Fixed:${ppField(h, 'Fixed')} Ch:${ppField(h, 'Ch')} | ` +
      `Hop:${ppField(h, 'Hop')} Crc:${ppField(h, 'Crc')}`;
  }
}
