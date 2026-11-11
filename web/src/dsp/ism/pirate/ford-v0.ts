/** Port of ProtoPirate protocols/ford_v0.c (decoder and get_string; GPL-3.0). Twin of pirate/PPFordV0.kt. */
import { PPDecoder, PPModulation, ppConst, hx, ppField, MASK64, PPMath, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_PREAMBLE = 1, STEP_PREAMBLE_CHECK = 2, STEP_GAP = 3, STEP_DATA = 4;
const GAP_THRESHOLD = 3500;

const crcMatrix = [0xDA, 0xB5, 0x55, 0x6A, 0xAA, 0xAA, 0xAA, 0xD5, 0xB6, 0x6C, 0xCC, 0xD9, 0x99, 0x99, 0x99, 0xB3,
  0x71, 0xE3, 0xC3, 0xC7, 0x87, 0x87, 0x87, 0x8F, 0x0F, 0xE0, 0x3F, 0xC0, 0x7F, 0x80, 0x7F, 0x80,
  0x00, 0x1F, 0xFF, 0xC0, 0x00, 0x7F, 0xFF, 0x80, 0x00, 0x00, 0x00, 0x3F, 0xFF, 0xFF, 0xFF, 0x80,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7F, 0x23, 0x12, 0x94, 0x84, 0x35, 0xF4, 0x55, 0x84];

function calculateCrc(buf: number[]): number {
  let crc = 0;
  for (let row = 0; row < 8; row++) {
    let xorSum = 0;
    for (let col = 0; col < 8; col++) xorSum ^= crcMatrix[row * 8 + col] & buf[col + 1];
    if (PPMath.parity8(xorSum) !== 0) crc |= 1 << row;
  }
  return crc;
}

function verifyCrc(key1: bigint, key2: number): boolean {
  const buf = new Array<number>(16).fill(0);
  for (let i = 0; i < 8; i++) buf[i] = Number((key1 >> BigInt(56 - i * 8)) & 0xFFn);
  buf[8] = (key2 >>> 8) & 0xFF;
  const calculated = calculateCrc(buf);
  const received = (key2 & 0xFF) ^ 0x80;
  return (calculated & 0x7F) === (received & 0x7F);
}

/** decode_ford_v0: [serial, button, count] */
function decode(key1: bigint, key2: number): [bigint, number, bigint] {
  const buf = new Array<number>(13).fill(0);
  for (let i = 0; i < 8; i++) buf[i] = Number((key1 >> BigInt(56 - i * 8)) & 0xFFn);
  buf[8] = (key2 >>> 8) & 0xFF;
  buf[9] = key2 & 0xFF;

  let tmp = buf[8];
  let parity = 0;
  const parityAny = tmp !== 0;
  while (tmp !== 0) { parity ^= tmp & 1; tmp >>>= 1; }
  buf[11] = parityAny ? parity : 0;

  let xorByte: number, limit: number;
  if (buf[11] !== 0) { xorByte = buf[7]; limit = 7; } else { xorByte = buf[6]; limit = 6; }
  for (let idx = 1; idx < limit; idx++) buf[idx] ^= xorByte;
  if (buf[11] === 0) buf[7] ^= xorByte;

  const origB7 = buf[7];
  buf[7] = (origB7 & 0xAA) | (buf[6] & 0x55);
  const mixed = (buf[6] & 0xAA) | (origB7 & 0x55);
  buf[12] = mixed;
  buf[6] = mixed;

  // The C reads the serial little-endian then byte-swaps it: big-endian bytes 1..4.
  const serial = BigInt(((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0);
  const button = (buf[5] >>> 3) & 0x0F;
  const count = BigInt(((buf[5] & 0x07) << 16) | (buf[6] << 8) | buf[7]);
  return [serial, button, count];
}

function buttonName(b: number): string {
  switch (b) { case 0x01: return 'Panic'; case 0x02: return 'Lock'; case 0x04: return 'Unlock'; case 0x08: return 'Boot'; default: return '??'; }
}

/**
 * Ford V0: AM, Manchester at 250 / 500 us after a short/long preamble and a 3.5 ms gap; 80 bits, sent inverted:
 * key1 (64 bits: header, XOR-obfuscated serial, button, 19-bit counter) and key2 (checksum byte + GF(2) matrix CRC).
 */
export class PPFordV0 extends PPDecoder {
  private dataLow = 0n;
  private dataHigh = 0n;
  private bitCount = 0;   // uint8
  private key1 = 0n;
  private key2 = 0;       // uint16
  private fSerial = 0n;
  private button = 0;
  private count = 0n;

  constructor() { super('Ford V0', PPModulation.AM, ppConst(250, 500, 100, 64)); }

  private addBitV0(bit: number): void {
    const low = this.dataLow;
    this.dataLow = ((this.dataLow << 1n) | (bit ? 1n : 0n)) & MASK64;
    this.dataHigh = ((this.dataHigh << 1n) | ((low >> 31n) & 1n)) & MASK64;
    this.bitCount = (this.bitCount + 1) & 0xFF;
  }

  private processData(): boolean {
    if (this.bitCount === 64) {
      const combined = ((this.dataHigh << 32n) | this.dataLow) & MASK64;
      this.key1 = combined ^ MASK64;
      this.dataLow = 0n; this.dataHigh = 0n;
      return false;
    }
    if (this.bitCount === 80) {
      const raw = Number(this.dataLow & 0xFFFFn);
      const k2 = ~raw & 0xFFFF;
      const [s, b, n] = decode(this.key1, k2);
      this.fSerial = s; this.button = b; this.count = n;
      this.key2 = k2;
      return true;
    }
    return false;
  }

  override reset(): void {
    super.reset();
    this.teLast = 0; this.dataLow = 0n; this.dataHigh = 0n; this.bitCount = 0; this.key1 = 0n; this.key2 = 0; this.fSerial = 0n; this.button = 0; this.count = 0n;
  }

  feed(level: boolean, duration: number): void {
    const c = this.c;
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, c.teShort) < c.teDelta) {
          this.dataLow = 0n; this.dataHigh = 0n; this.parserStep = STEP_PREAMBLE; this.teLast = duration; this.headerCount = 0; this.bitCount = 0;
          this.manchesterAdvance(8);
        }
        break;
      case STEP_PREAMBLE:
        if (!level) {
          if (this.dd(duration, c.teLong) < c.teDelta) { this.teLast = duration; this.parserStep = STEP_PREAMBLE_CHECK; }
          else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_PREAMBLE_CHECK:
        if (level) {
          if (this.dd(duration, c.teLong) < c.teDelta) { this.headerCount++; this.teLast = duration; this.parserStep = STEP_PREAMBLE; }
          else if (this.dd(duration, c.teShort) < c.teDelta) this.parserStep = STEP_GAP;
          else this.parserStep = STEP_RESET;
        }
        break;
      case STEP_GAP:
        if (!level && this.dd(duration, GAP_THRESHOLD) < 250) {
          this.dataLow = 1n; this.dataHigh = 0n; this.bitCount = 1; this.parserStep = STEP_DATA;
        } else if (!level && duration > GAP_THRESHOLD + 250) {
          this.parserStep = STEP_RESET;
        }
        break;
      case STEP_DATA: {
        const ev = this.manchesterEvent(duration, level);
        if (ev === 8) { this.parserStep = STEP_RESET; return; }
        const bit = this.manchesterAdvance(ev);
        if (bit >= 0) {
          this.addBitV0(bit);
          if (this.processData()) {
            this.data = this.key1; this.dataCountBit = 64; this.serial = this.fSerial; this.btn = this.button; this.cnt = this.count;
            this.emit();
            this.dataLow = 0n; this.dataHigh = 0n; this.bitCount = 0; this.parserStep = STEP_RESET;
          }
        }
        this.teLast = duration;
        break;
      }
    }
  }

  override describe(): PPHit {
    const ok = verifyCrc(this.key1, this.key2);
    return { name: this.name, bits: this.dataCountBit, key: hx('%016X', this.key1), serial: this.fSerial,
      btn: hx('%02X - ', this.button) + buttonName(this.button), cnt: this.count,
      fields: [{ name: 'CRC', value: ok ? 'OK' : 'BAD' },
        { name: 'Key2', value: hx('%04X', this.key2) },
        { name: 'Checksum', value: hx('%02X', (this.key2 >>> 8) & 0xFF) },
        { name: 'CRC byte', value: hx('%02X', this.key2 & 0xFF) }] };
  }

  /**
   * ford_v0.c get_string: "%s %dbit CRC:%s\r\nKey1: %08lX%08lX\r\nKey2: %04X  Sn: %08lX\r\nCnt: %05lX  Checksum: %02X\r\n
   * Btn: %02X - %s  CRC: %02X".
   */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit CRC:${ppField(h, 'CRC')} | Key1: ${h.key} | Key2: ${ppField(h, 'Key2')}  Sn: ` + hx('%08X', h.serial ?? 0n) +
      ' | ' + hx('Cnt: %05X', h.cnt ?? 0n) + `  Checksum: ${ppField(h, 'Checksum')} | Btn: ${h.btn ?? ''}  CRC: ${ppField(h, 'CRC byte')}`;
  }
}
