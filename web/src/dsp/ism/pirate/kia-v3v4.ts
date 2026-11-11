/** Port of ProtoPirate protocols/kia_v3_v4.c (decoder and get_string; GPL-3.0). Twin of pirate/PPKiaV3V4.kt. */
import { PPDecoder, PPModulation, PPMath, KeeLoq, PPKeys, ppConst, hx, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_CHECK_PREAMBLE = 1, STEP_COLLECT_RAW_BITS = 2;
const versionNames = ['Kia V4', 'Kia V3'];
const r = (v: number): bigint => BigInt(PPMath.reverseBits8(v));

/**
 * Kia V3/V4: FM, PWM at 400 / 800 us after a short-pair preamble and a ~1.2 ms sync (high sync = V4, low sync = V3,
 * whose bits arrive inverted). 64 key bits plus a CRC nibble: a KeeLoq hop (checked against the manufacturer key),
 * a 28-bit serial and a button, all bit-reversed per byte.
 */
export class PPKiaV3V4 extends PPDecoder {
  private rawBits = new Array<number>(32).fill(0);
  private rawBitCount = 0;
  private isV3Sync = false;
  private crc = 0;
  private version = 0;

  constructor() { super('Kia V3/V4', PPModulation.FM, ppConst(400, 800, 150, 68)); }

  private addRawBit(bit: boolean): void {
    if (this.rawBitCount < 256) {
      const byteIdx = this.rawBitCount >>> 3, bitIdx = 7 - (this.rawBitCount & 7);
      if (bit) this.rawBits[byteIdx] |= 1 << bitIdx; else this.rawBits[byteIdx] &= ~(1 << bitIdx) & 0xFF;
      this.rawBitCount++;
    }
  }

  private processBuffer(): boolean {
    if (this.rawBitCount < 68) return false;
    const b = this.rawBits;
    if (this.isV3Sync) for (let i = 0; i < (this.rawBitCount + 7) >>> 3; i++) b[i] = ~b[i] & 0xFF;
    const crc = (b[8] >>> 4) & 0x0F;
    const enc = (r(b[3]) << 24n) | (r(b[2]) << 16n) | (r(b[1]) << 8n) | r(b[0]);
    const ser = (r(b[7] & 0xF0) << 24n) | (r(b[6]) << 16n) | (r(b[5]) << 8n) | r(b[4]);
    const bt = Number((r(b[7]) & 0xF0n) >> 4n);
    const ourSerialLsb = Number(ser & 0xFFn);
    const dec = KeeLoq.decrypt(enc, PPKeys.kiaMf ?? 0n);
    const decBtn = Number((dec >> 28n) & 0x0Fn), decSerialLsb = Number((dec >> 16n) & 0xFFn);
    if (decBtn !== bt || decSerialLsb !== ourSerialLsb) return false;
    this.crc = crc;
    this.serial = ser; this.btn = bt; this.cnt = dec & 0xFFFFn;
    this.version = this.isV3Sync ? 1 : 0;
    this.data = PPMath.bytesToU64BE(b.slice(0, 8));
    this.dataCountBit = 68;
    return true;
  }

  override reset(): void {
    this.parserStep = STEP_RESET; this.headerCount = 0; this.rawBitCount = 0; this.crc = 0;
    this.rawBits = new Array<number>(32).fill(0);
  }

  private startCollect(v3: boolean): void {
    this.parserStep = STEP_COLLECT_RAW_BITS; this.rawBitCount = 0; this.isV3Sync = v3;
    this.rawBits = new Array<number>(32).fill(0);
  }

  feed(level: boolean, duration: number): void {
    const c = this.c;
    const isSync = duration > 1000 && duration < 1500;
    switch (this.parserStep) {
      case STEP_RESET:
        if (level && this.dd(duration, c.teShort) < c.teDelta) { this.parserStep = STEP_CHECK_PREAMBLE; this.teLast = duration; this.headerCount = 1; }
        break;
      case STEP_CHECK_PREAMBLE:
        if (level) {
          if (this.dd(duration, c.teShort) < c.teDelta) this.teLast = duration;
          else if (isSync) { if (this.headerCount >= 8) this.startCollect(false); else this.parserStep = STEP_RESET; }
          else this.parserStep = STEP_RESET;
        } else {
          if (isSync) { if (this.headerCount >= 8) this.startCollect(true); else this.parserStep = STEP_RESET; }
          else if (this.dd(duration, c.teShort) < c.teDelta && this.dd(this.teLast, c.teShort) < c.teDelta) this.headerCount = (this.headerCount + 1) & 0xFFFF;
          else if (duration > 1500) this.parserStep = STEP_RESET;
        }
        break;
      case STEP_COLLECT_RAW_BITS:
        if (level) {
          if (isSync) {
            if (this.processBuffer()) this.emit();
            this.parserStep = STEP_RESET;
          } else if (this.dd(duration, c.teShort) < c.teDelta) this.addRawBit(false);
          else if (this.dd(duration, c.teLong) < c.teDelta) this.addRawBit(true);
          else this.parserStep = STEP_RESET;
        } else if (isSync || duration > 1500) {
          if (this.processBuffer()) this.emit();
          this.parserStep = STEP_RESET;
        }
        break;
    }
  }

  override describe(): PPHit {
    const yek = PPMath.reverseKey(this.data, 64);
    return { name: versionNames[this.version], bits: this.dataCountBit, key: hx('%016X', this.data), serial: this.serial, btn: hx('%01X', this.btn), cnt: this.cnt,
      fields: [{ name: 'Yek', value: hx('%016X', yek) }, { name: 'CRC', value: hx('%01X', this.crc) }] };
  }

  /** kia_v3_v4.c get_string: "%s %dbit\r\nKey:%08lX%08lX\r\nYek:%08lX%08lX\r\nSerial:%07lX Btn:%01X\r\nCnt:%04lX CRC:%01X\r\n". */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | Key:${h.key} | Yek:${h.fields[0].value} | ` + hx('Serial:%07X', h.serial ?? 0n) +
      ` Btn:${h.btn ?? ''} | ` + hx('Cnt:%04X', h.cnt ?? 0n) + ` CRC:${h.fields[1].value}`;
  }
}
