/** Port of ProtoPirate protocols/ford_v2.c (decoder and get_string; GPL-3.0). Twin of pirate/PPFordV2.kt. */
import { PPDecoder, PPModulation, ppConst, hx, ppField, PPManchester, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_PREAMBLE = 1, STEP_SYNC = 2, STEP_DATA = 3;
const PREAMBLE_MIN = 64, DATA_BITS = 104, DATA_BYTES = 13;
const SYNC0 = 0x7F, SYNC1 = 0xA7;
const SYNC_BITS = 16, POST_SYNC_DECODE_COUNT_BIT = 16, PREAMBLE_COUNT_MAX = 0xFFFF;
const SYNC_SHIFT16_INV = ~((SYNC0 << 8) | SYNC1) & 0xFFFF;
const { SHORT_LOW, SHORT_HIGH, LONG_LOW, LONG_HIGH } = PPManchester;

const buttonIsValid = (b: number): boolean => b === 0x10 || b === 0x11 || b === 0x13 || b === 0x14 || b === 0x15;

function buttonName(b: number): string {
  switch (b) {
    case 0x10: return 'Lock'; case 0x11: return 'Unlock'; case 0x13: return 'Trunk'; case 0x14: return 'Panic';
    case 0x15: return 'RemoteStart'; default: return 'Unknown';
  }
}

const hexBytes = (k: number[], from: number, to: number): string => { let s = ''; for (let i = from; i <= to; i++) s += hx('%02X', k[i]); return s; };

/**
 * Ford V2: FM, Manchester at 200 / 400 us (wide 260 us tolerance) after 64+ short preamble pulses; the inverted
 * 16-bit sync 7F A7 opens 13 bytes (104 bits): serial, button, a 16-bit counter spread over bytes 7..9, and a 31-bit
 * tail. A frame is shown only when its structure checks out.
 */
export class PPFordV2 extends PPDecoder {
  private preambleCount = 0;   // uint16
  private rawBytes: number[] = new Array<number>(13).fill(0);
  private byteCount = 0;
  private syncShift = 0;       // uint16
  private syncBitCount = 0;
  private counter16 = 0;
  private tail31 = 0;
  private structureOk = false;

  constructor() { super('Ford V2', PPModulation.FM, ppConst(200, 400, 260, 104)); }

  private resetState(): void {
    this.parserStep = STEP_RESET; this.decodeData = 0n; this.decodeCountBit = 0; this.teLast = 0;
    this.byteCount = 0; this.syncShift = 0; this.syncBitCount = 0; this.preambleCount = 0; this.counter16 = 0; this.tail31 = 0; this.structureOk = false;
    this.rawBytes = new Array<number>(13).fill(0);
    this.manchesterAdvance(8);
  }

  override reset(): void { this.resetState(); }

  private extractFromRaw(): void {
    const k = this.rawBytes;
    this.serial = BigInt(((k[2] << 24) | (k[3] << 16) | (k[4] << 8) | k[5]) >>> 0);
    this.btn = k[6];
    this.counter16 = (((k[7] & 0x7F) << 9) | (k[8] << 1) | (k[9] >>> 7)) & 0xFFFF;
    this.cnt = BigInt(this.counter16);
    this.tail31 = (((k[9] & 0x7F) << 24) | (k[10] << 16) | (k[11] << 8) | k[12]) >>> 0;
    let ok = true;
    if (k[0] !== SYNC0) ok = false;
    if (k[1] !== SYNC1) ok = false;
    if (!buttonIsValid(k[6])) ok = false;
    if ((k[7] & 0x7F) !== ((this.counter16 >>> 9) & 0x7F)) ok = false;
    if (k[8] !== ((this.counter16 >>> 1) & 0xFF)) ok = false;
    if (((k[9] >>> 7) & 1) !== (this.counter16 & 1)) ok = false;
    this.structureOk = ok;
    let d = 0n;
    for (let i = 0; i < 8; i++) d = (d << 8n) | BigInt(k[i]);
    this.data = d;
    this.dataCountBit = DATA_BITS;
  }

  private commitFrame(): boolean {
    if (this.rawBytes[0] !== SYNC0 || this.rawBytes[1] !== SYNC1) return false;
    this.extractFromRaw();
    if (!this.structureOk) return false;
    this.emit();
    return true;
  }

  private syncEnterData(): void {
    this.rawBytes = new Array<number>(13).fill(0);
    this.rawBytes[0] = SYNC0; this.rawBytes[1] = SYNC1;
    this.byteCount = 2; this.parserStep = STEP_DATA; this.decodeData = 0n; this.decodeCountBit = POST_SYNC_DECODE_COUNT_BIT;
  }

  private syncFeedEvent(e: number): boolean {
    const bit = this.manchesterAdvance(e);
    if (bit < 0) return false;
    this.syncShift = ((this.syncShift << 1) | bit) & 0xFFFF;
    if (this.syncBitCount < SYNC_BITS) this.syncBitCount++;
    return this.syncBitCount >= SYNC_BITS && this.syncShift === SYNC_SHIFT16_INV;
  }

  private manchesterFeedEvent(e: number): void {
    if (this.parserStep === STEP_SYNC) {
      if (this.syncFeedEvent(e)) this.syncEnterData();
      return;
    }
    const b = this.manchesterAdvance(e);
    if (b < 0) return;
    if (this.parserStep !== STEP_DATA) return;
    const bit = b ^ 1;
    this.decodeData = (this.decodeData << 1n) | BigInt(bit);
    this.decodeCountBit = (this.decodeCountBit + 1) & 0xFF;   // uint8_t decode_count_bit
    if ((this.decodeCountBit & 7) === 0) {
      const v = Number(this.decodeData & 0xFFn);
      if (this.byteCount < DATA_BYTES) { this.rawBytes[this.byteCount] = v; this.byteCount++; }
      this.decodeData = 0n;
      if (this.byteCount === DATA_BYTES) { this.commitFrame(); this.resetState(); }
    }
  }

  private manchesterFeedPulse(level: boolean, duration: number): boolean {
    if (this.isShort(duration)) { this.manchesterFeedEvent(level ? SHORT_HIGH : SHORT_LOW); return true; }
    if (this.isLong(duration)) { this.manchesterFeedEvent(level ? LONG_HIGH : LONG_LOW); return true; }
    return false;
  }

  private enterSyncFromPreamble(level: boolean, duration: number): void {
    this.parserStep = STEP_SYNC; this.decodeData = 0n; this.decodeCountBit = 0; this.byteCount = 0; this.syncShift = 0; this.syncBitCount = 0;
    this.rawBytes = new Array<number>(13).fill(0);
    this.manchesterAdvance(8);
    if (this.isShort(duration)) {
      const ev = level ? SHORT_HIGH : SHORT_LOW;
      if (ev === SHORT_LOW || ev === LONG_LOW) this.manchester = PPManchester.MID0;
      this.manchesterFeedEvent(ev);
    } else if (this.isLong(duration)) {
      const ev = level ? LONG_HIGH : LONG_LOW;
      if (ev === SHORT_LOW || ev === LONG_LOW) this.manchester = PPManchester.MID0;
      this.manchesterFeedEvent(ev);
    } else this.resetState();
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (this.isShort(duration)) { this.preambleCount = 1; this.parserStep = STEP_PREAMBLE; }
        break;
      case STEP_PREAMBLE:
        if (this.isShort(duration)) {
          if (this.preambleCount < PREAMBLE_COUNT_MAX) this.preambleCount++;
        } else if (!level && this.isLong(duration)) {
          if (this.preambleCount >= PREAMBLE_MIN) this.enterSyncFromPreamble(level, duration); else this.resetState();
        } else this.resetState();
        break;
      case STEP_SYNC:
      case STEP_DATA:
        if (!this.manchesterFeedPulse(level, duration)) {
          // Every branch of the C resets here (the gap checks only differ in their break).
          this.resetState();
          return;
        }
        this.teLast = duration;
        break;
    }
  }

  override describe(): PPHit {
    const k = this.rawBytes;
    return { name: this.name, bits: this.dataCountBit, key: hexBytes(k, 2, 12), serial: this.serial,
      btn: hx('%02X [', this.btn) + buttonName(this.btn) + ']', cnt: BigInt(this.counter16),
      fields: [{ name: 'Struct', value: this.structureOk ? 'OK' : 'BAD' },
        { name: 'Tail31', value: hx('%08X', this.tail31) },
        { name: 'TailRaw', value: hexBytes(k, 8, 12) }] };
  }

  /**
   * ford_v2.c get_string: "%s %dbit\r\nKey:%02X x11\r\nSn:%08lX Btn:%02X [%s]\r\nCnt:%u Struct:%s\r\nTail31:%08lX\r\n
   * TailRaw:%02X x5\r\n".
   */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | Key:${h.key} | ` + hx('Sn:%08X', h.serial ?? 0n) + ` Btn:${h.btn ?? ''}` +
      ` | Cnt:${h.cnt ?? 0n} Struct:${ppField(h, 'Struct')} | Tail31:${ppField(h, 'Tail31')} | TailRaw:${ppField(h, 'TailRaw')}`;
  }
}
