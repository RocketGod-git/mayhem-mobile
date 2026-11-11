/** Port of ProtoPirate protocols/fiat_v2.c (decoder and get_string; GPL-3.0). Twin of pirate/PPFiatV2.kt. */
import { PPDecoder, PPModulation, ppConst, hx, MASK64, type PPHit } from './pp-base.js';

const STEP_RESET = 0, STEP_DATA = 1;
const WIRE_BITS = 112, WIRE_BYTES = 14, WIRE_CELLS = 224, LOGICAL_BITS = 112;
const BOUNDARY_MIN_US = 900;

function buttonValid(b: number): boolean { const s = b >>> 6; return s === 0x2 || s === 0x3 || s === 0x1; }
export function fiatV2ButtonName(b: number): string {
  switch (b >>> 6) { case 0x2: return 'Lock'; case 0x3: return 'Unlock'; case 0x1: return 'Trunk'; default: return 'Unknown'; }
}
const uidOf = (r: number[]): number => ((r[2] << 24) | (r[3] << 16) | (r[4] << 8) | r[5]) >>> 0;
const isFca = (r: number[]): boolean => (r[6] & 0xF0) === 0xD0;
function hopOf(r: number[]): number {
  if (isFca(r)) return ((r[10] << 24) | (r[11] << 16) | (r[12] << 8) | r[13]) >>> 0;
  return ((r[9] << 24) | (r[10] << 16) | (r[11] << 8) | r[12]) >>> 0;
}
function counterOf(r: number[]): number {
  if (isFca(r)) { const raw = (r[8] << 6) | (r[9] >>> 2); return ~raw & 0x3FFF; }
  const raw = ((r[7] & 0x3F) << 5) | (r[8] >>> 3);
  return ~raw & 0x7FF;
}
function frameValid(r: number[]): boolean {
  if (r[0] !== 0x00 || r[1] !== 0x01) return false;
  if (!buttonValid(r[7])) return false;
  const u = uidOf(r);
  return u !== 0 && u !== 0xFFFFFFFF;
}
const sameBytes = (a: number[], b: number[]): boolean => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

/**
 * Fiat V2: AM, Manchester cells at 210 / 420 us in a sliding 224-cell window; 112 wire bits = 14 bytes: 00 01, a
 * 32-bit UID, a type nibble, the button byte (top two bits select the button), an inverted counter, and a 32-bit hop
 * (its position depends on whether the frame is the FCA type, nibble D).
 */
export class PPFiatV2 extends PPDecoder {
  private readonly cells = new Uint8Array(WIRE_CELLS);
  private cellCount = 0;
  private rawData: number[] = new Array<number>(14).fill(0);
  private lastRawData: number[] = new Array<number>(14).fill(0);
  private lastRawValid = false;
  private uid = 0;
  private hop = 0;
  private button = 0;

  constructor() { super('Fiat V2', PPModulation.AM, ppConst(210, 420, 100, 112)); this.reset(); }

  override reset(): void {
    this.rawData = new Array<number>(14).fill(0); this.lastRawData = this.rawData.slice();
    this.parserStep = STEP_RESET; this.decodeData = 0n; this.decodeCountBit = 0;
    this.lastRawValid = false;
    this.data = 0n; this.dataCountBit = 0; this.serial = 0n; this.btn = 0; this.cnt = 0n;
    this.uid = 0; this.hop = 0; this.button = 0;
    this.clearCells();
  }

  private clearCells(): void { this.cellCount = 0; this.cells.fill(0); }

  private decodeFields(): void {
    this.uid = uidOf(this.rawData);
    this.button = this.rawData[7];
    this.hop = hopOf(this.rawData);
    this.serial = BigInt(this.uid); this.btn = this.button; this.cnt = BigInt(counterOf(this.rawData));
    this.data = ((this.serial << 32n) | BigInt(this.hop)) & MASK64;
    this.dataCountBit = LOGICAL_BITS;
    this.decodeData = this.data; this.decodeCountBit = this.dataCountBit;
  }

  private commit(raw: number[]): boolean {
    if (!frameValid(raw)) return false;
    if (this.lastRawValid && sameBytes(this.lastRawData, raw)) return true;
    this.rawData = raw.slice(); this.lastRawData = raw.slice(); this.lastRawValid = true;
    this.decodeFields();
    this.emit();
    return true;
  }

  private tryDecodeWindow(invert: boolean): boolean {
    if (this.cellCount !== WIRE_CELLS) return false;
    const cl = this.cells;
    const raw = new Array<number>(WIRE_BYTES).fill(0);
    for (let bi = 0; bi < WIRE_BITS; bi++) {
      const first = cl[bi * 2], second = cl[bi * 2 + 1];
      if (first === second) return false;
      let bit = first !== 0;
      if (invert) bit = !bit;
      if (bit) raw[bi >> 3] |= 1 << (7 - (bi & 7));
    }
    return this.commit(raw);
  }

  private pushCell(level: boolean): void {
    if (this.cellCount < WIRE_CELLS) { this.cells[this.cellCount] = level ? 1 : 0; this.cellCount++; }
    else { this.cells.copyWithin(0, 1); this.cells[WIRE_CELLS - 1] = level ? 1 : 0; }
    if (!this.tryDecodeWindow(false)) this.tryDecodeWindow(true);
  }

  private feedDataPulse(level: boolean, duration: number): boolean {
    if (this.isShort(duration)) { this.pushCell(level); return true; }
    if (this.isLong(duration)) { this.pushCell(level); this.pushCell(level); return true; }
    if (!level && duration >= BOUNDARY_MIN_US) this.pushCell(false);
    this.clearCells();
    return false;
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (this.isShort(duration) || this.isLong(duration)) {
          this.clearCells();
          this.parserStep = STEP_DATA;
          this.feedDataPulse(level, duration);
        }
        break;
      case STEP_DATA:
        if (!this.feedDataPulse(level, duration)) this.parserStep = STEP_RESET;
        break;
    }
  }

  override describe(): PPHit {
    return { name: this.name, bits: LOGICAL_BITS, key: this.rawData.map((b) => hx('%02X', b)).join(''), serial: BigInt(this.uid),
      btn: hx('%02X', this.button), cnt: this.cnt,
      fields: [{ name: 'Hop', value: hx('%08X', this.hop) },
        { name: 'Type', value: hx('%01X', this.rawData[6] >>> 4) },
        { name: 'Button', value: fiatV2ButtonName(this.button) }] };
  }

  /** fiat_v2.c get_string: "%s %ubit\r\nUID:%08lX\r\nHop:%08lX Type:%01X\r\nBtn:%02X [%s] Cnt:%02lX\r\n". */
  override cString(h: PPHit): string {
    return `${h.name} ${h.bits}bit | ` + hx('UID:%08X', h.serial ?? 0n) + ` | Hop:${h.fields[0].value} Type:${h.fields[1].value}` +
      ` | Btn:${h.btn ?? ''} [${h.fields[2].value}] ` + hx('Cnt:%02X', h.cnt ?? 0n);
  }
}
