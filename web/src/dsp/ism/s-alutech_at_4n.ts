/**
 * Alutech AT-4N rolling-code remotes, 72-bit OOK PWM: 64-bit encrypted hop + 8-bit CRC (Flipper Unleashed
 * lib/subghz/protocols/alutech_at_4n.c; twin of ism/SAlutechAt4n.kt). Receive only. Serial, button and counter sit
 * inside the encrypted part, which needs the manufacturer's rainbow table, so only the raw hop and CRC are shown.
 * A frame whose CRC (computed over the encrypted part, no key needed) does not match is dropped.
 */
import { FProto, Fam, S, FG, MASK64 } from './base.js';
import { remoteName, type RemoteInfo } from './remote-fields.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBULA = 1, STEP_SAVE_DURATION = 2, STEP_CHECK_DURATION = 3;

/** CRC-8 (poly 0x31, init 0xFF) over the 8 bytes of a uint64 in little-endian memory order. */
function alutechCrc(data: bigint): number {
  let crc = 0xFF;
  for (let y = 0; y < 8; y++) {
    crc ^= FG.bits(data, y * 8, 0xFF);
    for (let i = 0; i < 8; i++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x31) & 0xFF : (crc << 1) & 0xFF;
  }
  return crc;
}

export class SAlutechAt4n extends FProto {
  /** generic.data in Flipper: the last reported hop, so an identical repeat is not reported twice. */
  private lastData = 0n;
  private crc = 0;
  /** First 64 bits of the frame being received. */
  private hop = 0n;

  constructor() { super(Fam.REMOTE, S.ALUTECH_AT_4N); this.teShort = 400; this.teLong = 800; this.teDelta = 140; this.minCountBitForFound = 72; }

  /** Received CRC matches the CRC of the (bit-reversed) 64-bit hop. */
  static crcOk(data: bigint, crc: number): boolean {
    return Number(FG.reverseKey(BigInt(crc & 0xFF), 8)) === alutechCrc(FG.reverseKey(data & MASK64, 64));
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_CHECK_PREAMBULA; this.headerCount++; }
        break;
      case STEP_CHECK_PREAMBULA:
        if (!level && this.dd(duration, this.teShort) < this.teDelta) { this.parserStep = STEP_RESET; break; }
        if (this.headerCount > 9 && this.dd(duration, this.teShort * 10) < this.teDelta * 10) {
          // Found header
          this.parserStep = STEP_SAVE_DURATION; this.decodeData = 0n; this.decodeCountBit = 0;
        } else { this.parserStep = STEP_RESET; this.headerCount = 0; }
        break;
      case STEP_SAVE_DURATION:
        if (level) { this.teLast = duration; this.parserStep = STEP_CHECK_DURATION; }
        break;
      case STEP_CHECK_DURATION:
        if (!level) {
          if (duration >= this.teShort * 2 + this.teDelta) {
            // Add the last bit, read from its mark alone
            if (this.dd(this.teLast, this.teShort) < this.teDelta) this.addBit(1);
            else if (this.dd(this.teLast, this.teLong) < this.teDelta * 2) this.addBit(0);
            // Found end TX
            this.parserStep = STEP_RESET;
            if (this.decodeCountBit === this.minCountBitForFound) {
              const crc = Number(this.decodeData & 0xFFn);
              if (this.hop !== this.lastData && SAlutechAt4n.crcOk(this.hop, crc)) {
                this.lastData = this.hop;
                this.crc = crc;
                this.dataCountBit = this.decodeCountBit;
                // Report the hop as decodeData and the CRC as decodeData2
                this.decodeData = this.hop; this.decodeData2 = BigInt(crc);
                this.hit();
              }
              this.decodeData = 0n; this.decodeCountBit = 0; this.headerCount = 0;
            }
            break;
          } else if (this.dd(this.teLast, this.teShort) < this.teDelta && this.dd(duration, this.teLong) < this.teDelta * 2) {
            this.addBit(1);
            if (this.decodeCountBit === 64) { this.hop = this.decodeData; this.decodeData = 0n; }
            this.parserStep = STEP_SAVE_DURATION;
          } else if (this.dd(this.teLast, this.teLong) < this.teDelta * 2 && this.dd(duration, this.teShort) < this.teDelta) {
            this.addBit(0);
            if (this.decodeCountBit === 64) { this.hop = this.decodeData; this.decodeData = 0n; }
            this.parserStep = STEP_SAVE_DURATION;
          } else { this.parserStep = STEP_RESET; this.headerCount = 0; }
        } else { this.parserStep = STEP_RESET; this.headerCount = 0; }
        break;
    }
  }

  override remoteInfo(): RemoteInfo | null {
    if (this.dataCountBit !== this.minCountBitForFound) return null;
    return { name: remoteName(this.sensorType), serial: 0n, btn: null, cnt: null, extra: ['CRC: ' + this.crc.toString(16).toUpperCase().padStart(2, '0'), 'Hop: encrypted'] };
  }
}
