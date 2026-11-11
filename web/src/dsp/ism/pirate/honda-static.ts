/** Port of ProtoPirate protocols/honda_static.c (decoder and get_string; GPL-3.0). Twin of pirate/PPHondaStatic.kt. */
import { PPDecoder, PPModulation, PPMath, ppConst, hx, M32, type PPHit } from './pp-base.js';

const BIT_COUNT = 64, MIN_SYMBOLS = 36;
const SHORT_BASE = 28, SHORT_SPAN = 70, LONG_BASE = 61, LONG_SPAN = 130;
const SYMBOL_CAPACITY = 512, PREAMBLE_MAX_TRANSITIONS = 19;
const buttonNames = ['Lock', 'Unlock', 'Unknown', 'Trunk', 'Remote Start', 'Unknown', 'Unknown', 'Panic', 'Lock x2'];

interface Fields { serial: bigint; counter: bigint; button: number; checksum: number }

/** Up to 32 bits MSB first starting at bit `start` (as a uint32). */
function getBits(data: number[], start: number, count: number): bigint {
  let value = 0;
  for (let i = 0; i < count; i++) {
    const bitIndex = (start + i) & 0xFF;
    const byte = data[bitIndex >>> 3];
    const shift = ~bitIndex & 0x07;
    value = ((value << 1) | ((byte >>> shift) & 1)) >>> 0;
  }
  return BigInt(value);
}

const isValidButton = (b: number): boolean => b <= 9 && ((0x336 >>> b) & 1) !== 0;
const isValidSerial = (s: bigint): boolean => s !== 0n && s !== 0x0FFFFFFFn;

export function hondaStaticButtonName(b: number): string { return b >= 1 && b <= buttonNames.length ? buttonNames[b - 1] : 'Unknown'; }

function compactChecksum(c: number[]): number {
  const canonical = [((c[0] << 4) | (c[1] >>> 4)) & 0xFF, ((c[1] << 4) | (c[2] >>> 4)) & 0xFF,
    ((c[2] << 4) | (c[3] >>> 4)) & 0xFF, ((c[3] << 4) | (c[4] >>> 4)) & 0xFF, c[5], c[6], c[7]];
  return PPMath.xorBytes(canonical);
}

function unpackCompact(key: bigint): Fields {
  const c = PPMath.u64ToBytesBE(key);
  return {
    button: c[0] & 0x0F,
    serial: (BigInt(c[1]) << 20n) | (BigInt(c[2]) << 12n) | (BigInt(c[3]) << 4n) | BigInt(c[4] >>> 4),
    counter: (BigInt(c[5]) << 16n) | (BigInt(c[6]) << 8n) | BigInt(c[7]),
    checksum: compactChecksum(c),
  };
}

function packCompact(f: Fields): bigint {
  const s = f.serial, n = f.counter;
  const c = [f.button & 0x0F, Number((s >> 20n) & 0xFFn), Number((s >> 12n) & 0xFFn), Number((s >> 4n) & 0xFFn), Number((s << 4n) & 0xFFn),
    Number((n >> 16n) & 0xFFn), Number((n >> 8n) & 0xFFn), Number(n & 0xFFn)];
  return PPMath.bytesToU64BE(c);
}

function validateForward(packet: number[]): Fields | null {
  const button = Number(getBits(packet, 0, 4) & 0xFFn);
  const serial = getBits(packet, 4, 28);
  const counter = getBits(packet, 32, 24);
  const checksum = Number(getBits(packet, 56, 8) & 0xFFn);
  const calc = PPMath.xorBytes(packet.slice(0, 7));
  if (checksum !== calc || !isValidButton(button) || !isValidSerial(serial)) return null;
  return { serial, counter, button, checksum };
}

/** The reverse path computes its checksum but never compares it (as in the C). */
function validateReverse(packet: number[]): Fields | null {
  const reversed = packet.map((b) => PPMath.reverseBits8(b));
  const button = Number(getBits(reversed, 0, 4) & 0xFFn);
  const serial = getBits(reversed, 4, 28);
  const counter = getBits(reversed, 32, 24);
  const checksum = PPMath.xorBytes(reversed.slice(0, 7));
  if (!isValidButton(button) || !isValidSerial(serial)) return null;
  return { serial, counter, button, checksum };
}

/**
 * Honda Static: FM (Honda1 route), a symbol stream of ~63 us elements (short 28..98 us = one symbol, long 61..191 us =
 * two), parsed on the first other pulse: an alternating preamble, then 64 Manchester bits (button nibble, 28-bit serial,
 * 24-bit counter, XOR checksum byte), tried inverted first, then plain, then bit-reversed.
 */
export class PPHondaStatic extends PPDecoder {
  private symbolsCount = 0;
  private readonly symbols = new Array<number>((512 + 7) >> 3).fill(0);

  constructor() { super('Honda Static', PPModulation.FM, ppConst(63, 126, 35, 64)); }

  private symbolSet(index: number, v: number): void {
    const byteIndex = (index >>> 3) & 0xFF;
    const mask = 1 << (~index & 0x07);
    if (v !== 0) this.symbols[byteIndex] |= mask; else this.symbols[byteIndex] &= ~mask & 0xFF;
  }

  private symbolGet(index: number): number {
    return (this.symbols[(index >>> 3) & 0xFF] >>> (~index & 0x07)) & 1;
  }

  private manchesterPack64(count: number, startPos: number, inverted: boolean): number[] | null {
    const packet = new Array<number>(9).fill(0);
    let pos = startPos, bitCount = 0;
    while (pos + 1 < count) {
      if (bitCount >= BIT_COUNT) break;
      const a = this.symbolGet(pos), b = this.symbolGet(pos + 1);
      if (a === b) { pos++; continue; }
      const bit = inverted ? (a === 0 && b === 1) : (a === 1 && b === 0);
      if (bit) packet[bitCount >> 3] |= 1 << (~bitCount & 0x07);
      bitCount++;
      pos += 2;
    }
    return bitCount >= BIT_COUNT ? packet : null;
  }

  private parseSymbols(inverted: boolean): boolean {
    const count = this.symbolsCount;
    let index = 1, transitions = 0;
    while (index < count) {
      if (this.symbolGet(index) !== this.symbolGet(index - 1)) transitions++;
      else {
        if (transitions > PREAMBLE_MAX_TRANSITIONS) break;
        transitions = 0;
      }
      index++;
    }
    if (index >= count) return false;
    while (index + 1 < count && this.symbolGet(index) === this.symbolGet(index + 1)) index++;
    const packet = this.manchesterPack64(count, index, inverted);
    if (!packet) return false;
    const f = validateForward(packet);
    if (f) { this.commit(f); return true; }
    if (inverted) return false;
    const r = validateReverse(packet);
    if (r) { this.commit(r); return true; }
    return false;
  }

  private commit(d: Fields): void {
    this.dataCountBit = BIT_COUNT;
    this.data = packCompact(d);
    this.serial = d.serial & M32;
    this.cnt = d.counter;
    this.btn = d.button;
    this.emit();
  }

  override reset(): void { super.reset(); this.symbolsCount = 0; }

  feed(level: boolean, duration: number): void {
    const sym = level ? 1 : 0;
    if (duration >= SHORT_BASE && duration - SHORT_BASE <= SHORT_SPAN) {
      if (this.symbolsCount < SYMBOL_CAPACITY) { this.symbolSet(this.symbolsCount, sym); this.symbolsCount++; }
      return;
    }
    if (duration >= LONG_BASE && duration - LONG_BASE <= LONG_SPAN) {
      if (this.symbolsCount + 2 <= SYMBOL_CAPACITY) {
        this.symbolSet(this.symbolsCount, sym); this.symbolsCount++;
        this.symbolSet(this.symbolsCount, sym); this.symbolsCount++;
      }
      return;
    }
    if (this.symbolsCount >= MIN_SYMBOLS) {
      if (!this.parseSymbols(true)) this.parseSymbols(false);
    }
    this.symbolsCount = 0;
  }

  override describe(): PPHit {
    const d = unpackCompact(this.data);
    return { name: this.name, bits: this.dataCountBit, key: hx('%016X', this.data), serial: d.serial, btn: hondaStaticButtonName(d.button), cnt: d.counter,
      fields: [{ name: 'Checksum', value: hx('%02X', d.checksum) }] };
  }

  /** honda_static.c get_string: "%s\r\nKey:%016llX\r\nBtn:%s\r\nSer:%07lX Cnt:%06lX". */
  override cString(h: PPHit): string {
    return `${h.name} | Key:${h.key} | Btn:${h.btn ?? ''} | ` + hx('Ser:%07X Cnt:%06X', h.serial ?? 0n, h.cnt ?? 0n);
  }
}
