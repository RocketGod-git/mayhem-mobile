/** Port of ProtoPirate protocols/ford_v3.c (decoder and get_string; GPL-3.0). Twin of pirate/PPFordV3.kt. */
import { PPDecoder, PPModulation, ppConst, hx, ppField, PPManchester, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_PREAMBLE = 1, STEP_DATA = 2;
const DATA_BITS = 104, PREAMBLE_MIN = 30;
const CELL_CAP = 320, CELL_MIN = 200, CELL_MIN_BITS = 100;
const BTN_LOCK = 0x01, BTN_UNLOCK = 0x02;
const VARIANT_EU = 0, VARIANT_US = 1;
/** subghz_protocol_ford_v3_cell_const: the same timings with a 120 us tolerance. */
const CELL_DELTA = 120;
const { SHORT_LOW, SHORT_HIGH, LONG_LOW, LONG_HIGH } = PPManchester;

// The C has separate US and EU tables; they are identical.
const buttonName = (b: number): string => (b === BTN_LOCK ? 'Lock' : b === BTN_UNLOCK ? 'Unlock' : '?');

function cellFrameValid(raw: number[]): boolean {
  if (raw[0] !== 0xFF) return false;
  const s = ((raw[1] << 24) | (raw[2] << 16) | (raw[3] << 8) | raw[4]) >>> 0;
  if (s === 0 || s === 0xFFFFFFFF) return false;
  if (raw[6] !== BTN_LOCK && raw[6] !== BTN_UNLOCK) return false;
  if ((raw[5] & 0x80) === 0) return false;
  return true;
}

function cellDecode(cells: Uint8Array, cellCount: number): number[] | null {
  for (let phase = 0; phase < 2; phase++) {
    const frame = new Array<number>(13).fill(0);
    let bitCount = 0;
    let ok = true;
    for (let i = phase; i + 1 < cellCount && bitCount < DATA_BITS; i += 2) {
      const first = cells[i], second = cells[i + 1];
      if (first === second) { ok = false; break; }
      if (first !== 0) frame[bitCount >> 3] |= 1 << (7 - (bitCount & 7));
      bitCount++;
    }
    if (!ok || bitCount < CELL_MIN_BITS) continue;
    if (!cellFrameValid(frame)) continue;
    return frame;
  }
  return null;
}

const sameBytes = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const hexBytes = (k: number[], from: number, to: number): string => { let s = ''; for (let i = from; i <= to; i++) s += hx('%02X', k[i]); return s; };

/**
 * Ford V3: FM, 240 / 480 us, 13 bytes (104 bits) read two ways at once: a Manchester path after 30+ short
 * preamble pulses (the EU layout, counter sent inverted) and a cell path that splits every pulse into 240 us cells
 * and pairs them (the US layout, header byte FF). A frame identical to the last one shown is not shown again.
 */
export class PPFordV3 extends PPDecoder {
  private manchesterRaw: number[] = new Array<number>(13).fill(0);
  private manchesterBitCount = 0;
  private preambleCount = 0;   // uint16
  private readonly cells = new Uint8Array(CELL_CAP);
  private cellCount = 0;
  private rawBytes: number[] = new Array<number>(13).fill(0);
  private lastRawBytes: number[] = new Array<number>(13).fill(0);
  private lastRawValid = false;
  private variant = 0;
  private counter = 0;

  constructor() { super('Ford V3', PPModulation.FM, ppConst(240, 480, 60, 104)); }

  private resetManchester(): void {
    this.manchesterRaw = new Array<number>(13).fill(0); this.manchesterBitCount = 0; this.preambleCount = 0;
    this.manchesterAdvance(8);
  }

  override reset(): void {
    this.parserStep = STEP_RESET; this.resetManchester(); this.cellCount = 0; this.lastRawValid = false;
  }

  private addManchesterBit(bit: number): void {
    if (this.manchesterBitCount >= DATA_BITS) return;
    const byteIndex = this.manchesterBitCount >> 3, bitInByte = 7 - (this.manchesterBitCount & 7);
    if (bit !== 0) this.manchesterRaw[byteIndex] |= 1 << bitInByte;
    this.manchesterBitCount++;
  }

  private parseFields(): void {
    const b = this.rawBytes;
    this.serial = BigInt(((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0);
    if (this.variant === VARIANT_US) {
      this.counter = (b[7] << 8) | b[8]; this.btn = b[6];
    } else {
      this.counter = ((~b[7] & 0xFF) << 8) | (~b[8] & 0xFF);
      this.btn = b[6] & 0x01 ? BTN_UNLOCK : BTN_LOCK;
    }
    this.cnt = BigInt(this.counter);
  }

  private commitFrame(raw: number[], v: number): void {
    if (this.lastRawValid && sameBytes(this.lastRawBytes, raw)) return;
    this.rawBytes = raw.slice(); this.lastRawBytes = raw.slice(); this.lastRawValid = true;
    this.variant = v; this.dataCountBit = DATA_BITS;
    this.parseFields();
    this.emit();
  }

  private manchesterEmitIfReady(): void {
    if (this.manchesterBitCount < DATA_BITS) return;
    this.commitFrame(this.manchesterRaw, VARIANT_EU);
  }

  private cellProcess(): void {
    if (this.cellCount < CELL_MIN) return;
    const raw = cellDecode(this.cells, this.cellCount);
    if (raw) this.commitFrame(raw, VARIANT_US);
  }

  private cellFeed(level: boolean, duration: number): void {
    if (this.dd(duration, this.c.teShort) < CELL_DELTA) {
      if (this.cellCount < CELL_CAP) this.cells[this.cellCount++] = level ? 1 : 0;
    } else if (this.dd(duration, this.c.teLong) < CELL_DELTA) {
      if (this.cellCount + 2 <= CELL_CAP) {
        this.cells[this.cellCount++] = level ? 1 : 0;
        this.cells[this.cellCount++] = level ? 1 : 0;
      }
    } else {
      this.cellProcess();
      this.cellCount = 0;
    }
  }

  private manchesterFeed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (this.isShort(duration)) { this.resetManchester(); this.preambleCount = 1; this.parserStep = STEP_PREAMBLE; }
        break;
      case STEP_PREAMBLE:
        if (this.isShort(duration)) {
          this.preambleCount = (this.preambleCount + 1) & 0xFFFF;
        } else if (this.preambleCount >= PREAMBLE_MIN && this.isLong(duration)) {
          this.manchester = PPManchester.MID1;
          const bit = this.manchesterAdvance(level ? LONG_HIGH : LONG_LOW);
          if (bit >= 0) this.addManchesterBit(bit);
          this.parserStep = STEP_DATA;
        } else {
          this.parserStep = STEP_RESET;
        }
        break;
      case STEP_DATA: {
        const sh = this.isShort(duration);
        if (!sh && !this.isLong(duration)) {
          this.manchesterEmitIfReady();
          this.parserStep = STEP_RESET;
          // The C then re-checks pp_is_short here, which can never be true: dead code, left out.
          return;
        }
        const event = level ? (sh ? SHORT_HIGH : LONG_HIGH) : (sh ? SHORT_LOW : LONG_LOW);
        const bit = this.manchesterAdvance(event);
        if (bit >= 0) {
          this.addManchesterBit(bit);
          if (this.manchesterBitCount >= DATA_BITS) { this.manchesterEmitIfReady(); this.parserStep = STEP_RESET; }
        }
        break;
      }
    }
  }

  feed(level: boolean, duration: number): void {
    this.cellFeed(level, duration);
    this.manchesterFeed(level, duration);
  }

  override describe(): PPHit {
    const k = this.rawBytes;
    const us = this.variant === VARIANT_US;
    return { name: this.name, bits: this.dataCountBit, key: hexBytes(k, 0, 12), serial: this.serial,
      btn: hx('%02X ', this.btn) + buttonName(this.btn), cnt: BigInt(this.counter),
      fields: [{ name: 'Variant', value: us ? 'US' : 'EU' }, { name: 'Hop', value: hexBytes(k, 9, 12) }] };
  }

  /** ford_v3.c get_string: "%s[ US] %dbit\r\nKey:%02X x13\r\nSn:%08lX Btn:%02X %s\r\nCnt:%04X Hop:%02X x4\r\n". */
  override cString(h: PPHit): string {
    const us = ppField(h, 'Variant') === 'US';
    return `${h.name}${us ? ' US' : ''} ${h.bits}bit | Key:${h.key} | ` + hx('Sn:%08X', h.serial ?? 0n) +
      ` Btn:${h.btn ?? ''} | ` + hx('Cnt:%04X', h.cnt ?? 0n) + ` Hop:${ppField(h, 'Hop')}`;
  }
}
