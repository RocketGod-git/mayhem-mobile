/**
 * Telcoma / Cardin EDGE remotes, 433.92 MHz AM, 32-bit Manchester fixed code (Flipper Unleashed
 * lib/subghz/protocols/telcoma_edge.c; twin of ism/STelcomaEdge.kt). Each pulse is split into half-bits (Te 1270 us),
 * paired high-to-low = 1 and low-to-high = 0, and any other duration ends the frame. The gate channel is 32 bits; the
 * other channels carry a one-hot marker that makes 33 bits (the extra trailing bit is dropped). A key must start with
 * 0xFF; payload[23:3] is the serial and payload[2:0] the one-hot channel. Receive only.
 */
import { FProto, Fam, S } from './base.js';
import { type RemoteInfo, remoteName } from './remote-fields.js';

export class STelcomaEdge extends FProto {
  private rx = 0n;
  private halfPending = false;
  private halfLevel = false;
  constructor() { super(Fam.REMOTE, S.TELCOMA_EDGE); this.teShort = 1270; this.teLong = 2540; this.teDelta = 520; this.minCountBitForFound = 32; }

  private addHalf(level: boolean): void {
    if (!this.halfPending) { this.halfPending = true; this.halfLevel = level; return; }
    this.halfPending = false;
    if (this.halfLevel && !level) this.addBit(1);
    else if (!this.halfLevel && level) this.addBit(0);
    // same-level pair: phase violation, no bit
  }

  feed(level: boolean, duration: number): void {
    if (this.dd(duration, this.teShort) < this.teDelta) this.addHalf(level);
    else if (this.dd(duration, this.teLong) < this.teDelta) { this.addHalf(level); this.addHalf(level); }
    else {
      // End of a burst: publish a complete frame.
      const count = this.decodeCountBit;
      if (count === 32 || count === 33) {
        const key = (count === 33 ? this.decodeData >> 1n : this.decodeData) & 0xFFFFFFFFn;
        if ((key >> 24n) === 0xFFn) {
          this.decodeData = key; this.dataCountBit = this.minCountBitForFound; this.rx = key;
          this.hit();
        }
      }
      this.decodeData = 0n; this.decodeCountBit = 0; this.halfPending = false;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    const payload = this.rx & 0xFFFFFFn;
    return { name: remoteName(this.sensorType), serial: (payload >> 3n) & 0x1FFFFFn, btn: Number(payload & 0x7n), cnt: null, extra: [] };
  }
}
