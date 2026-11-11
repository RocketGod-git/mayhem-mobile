/** Port of ProtoPirate protocols/fiat_v1.c (decoder and get_string; GPL-3.0). Twin of pirate/PPFiatV1.kt. */
import { PPDecoder, PPModulation, ppConst, hx, MASK64, type PPHit, type PPField } from './pp-base.js';

const STEP_RESET = 0, STEP_DATA = 1;
const WIRE_BITS = 104, WIRE_BYTES = 13, WIRE_CELLS = 208, LOGICAL_BITS = 102;
const BOUNDARY_MIN_US = 800, DEFAULT_TAIL_BITS = 2;
const VARIANT_A = 0, VARIANT_B = 1;
const CONSTS = [ppConst(250, 500, 100, 102), ppConst(100, 200, 50, 102)];
const knownKeys = [
  [0xB7, 0x92, 0x80, 0xAE, 0xCC, 0x37],
  [0xD4, 0x24, 0x28, 0xF7, 0xD9, 0x66],
  [0x4D, 0x34, 0x3F, 0xD4, 0xE7, 0xB6],
  [0x6D, 0x6B, 0xF2, 0x1D, 0x3A, 0x1A],
  [0xA3, 0xF3, 0xAC, 0xF7, 0xB9, 0x10],
  [0x4D, 0x49, 0x4B, 0x52, 0x4F, 0x4E],
  [0xCD, 0x49, 0x4B, 0x52, 0x4F, 0x4E],
  [0x33, 0xFA, 0x2F, 0xCD, 0xC3, 0x3B],
  [0xF6, 0x1A, 0xEF, 0x9C, 0xD0, 0x1B],
];

// ---- durations ----
const absd = (a: number, b: number): number => (a < b ? b - a : a - b);
const isShortV = (v: number, d: number): boolean => absd(d, CONSTS[v].teShort) < CONSTS[v].teDelta;
const isLongV = (v: number, d: number): boolean => absd(d, CONSTS[v].teLong) < CONSTS[v].teDelta;
const isPulse = (d: number): boolean => isShortV(0, d) || isLongV(0, d) || isShortV(1, d) || isLongV(1, d);

const buttonValid = (b: number): boolean => b === 0x1 || b === 0x2 || b === 0x4 || b === 0x8;
export function fiatV1ButtonName(b: number): string {
  switch (b) { case 0x8: return 'Unlock'; case 0x4: return 'Lock'; case 0x2: return 'Trunk'; case 0x1: return 'Close'; default: return 'Unknown'; }
}
function frameXorOf(raw: number[]): number { let v = 0x01; for (let i = 0; i < 12; i++) v ^= raw[i]; return v; }
const uidOf = (raw: number[]): number => ((raw[2] << 24) | (raw[3] << 16) | (raw[4] << 8) | raw[5]) >>> 0;
const counterOf = (raw: number[]): number => ((raw[6] & 0x0F) << 6) | (raw[7] >>> 2);
const hopOf = (raw: number[]): number =>
  (((raw[7] & 0x03) << 30) | (raw[8] << 22) | (raw[9] << 14) | (raw[10] << 6) | (raw[11] >>> 2)) >>> 0;
function frameValid(raw: number[]): boolean {
  if (raw[0] !== 0x00 || raw[1] !== 0x01) return false;
  if (frameXorOf(raw) !== raw[12]) return false;
  if (!buttonValid(raw[6] >>> 4)) return false;
  const u = uidOf(raw);
  return u !== 0 && u !== 0xFFFFFFFF;
}

// ---- BCM Hitag2 ----
const truth = (table: number, index: number): number => (table >>> index) & 1;
const fidx = (a: number, b: number, c: number, d: number): number => (a << 3) | (b << 2) | (c << 1) | d;
const bb = (byte: number, bit: number): number => (byte >>> bit) & 1;

function hitag2Filter(s: number[]): number {
  let g = 0;
  g |= truth(0x2c79, fidx(bb(s[0], 1), bb(s[0], 2), bb(s[0], 4), bb(s[0], 5)));
  g |= truth(0x6671, fidx(bb(s[1], 0), bb(s[1], 1), bb(s[1], 3), bb(s[1], 7))) << 1;
  g |= truth(0x6671, fidx(bb(s[3], 5), bb(s[2], 0), bb(s[2], 2), bb(s[2], 6))) << 2;
  g |= truth(0x6671, fidx(bb(s[4], 6), bb(s[3], 0), bb(s[3], 2), bb(s[3], 3))) << 3;
  g |= truth(0x2c79, fidx(bb(s[5], 1), bb(s[5], 3), bb(s[5], 4), bb(s[4], 5))) << 4;
  return truth(0x7907287b, g);
}
function parity8(v0: number): number { let v = v0; v ^= v >>> 4; v ^= v >>> 2; v ^= v >>> 1; return v & 1; }
const feedbackMasks = [0xb3, 0x80, 0x83, 0x22, 0x00, 0x73];
function hitag2Feedback(s: number[]): number {
  let f = 0;
  for (let i = 0; i < 6; i++) f ^= parity8(s[i] & feedbackMasks[i]);
  return f & 1;
}
function hitag2Shift(s: number[], input: number): void {
  for (let i = 0; i < 5; i++) s[i] = ((s[i] << 1) | (s[i + 1] >>> 7)) & 0xFF;
  s[5] = ((s[5] << 1) | (input & 1)) & 0xFF;
}

/** uid and the result are uint32 numbers. */
export function fiatV1Authenticator(uid: number, button: number, control: number, key: number[], epoch: number): number {
  const state = [(uid >>> 24) & 0xFF, (uid >>> 16) & 0xFF, (uid >>> 8) & 0xFF, uid & 0xFF, key[4], key[5]];
  const iv = (((epoch & 0x3FFFF) << 14) | ((control & 0x03FF) << 4) | (button & 0x0F)) >>> 0;
  for (let i = 0; i < 32; i++) {
    const input = ((iv >>> (31 - i)) & 1) ^ ((key[i >> 3] >>> (7 - (i & 7))) & 1) ^ hitag2Filter(state);
    hitag2Shift(state, input);
  }
  let auth = 0;
  for (let i = 0; i < 32; i++) {
    auth = ((auth << 1) | hitag2Filter(state)) >>> 0;
    hitag2Shift(state, hitag2Feedback(state));
  }
  return auth;
}

const keyMatches = (uid: number, button: number, control: number, hop: number, key: number[], epoch: number): boolean =>
  fiatV1Authenticator(uid, button, control, key, epoch) === hop;
function keyMatchesAnyButton(uid: number, control: number, hop: number, key: number[], epoch: number): boolean {
  for (const b of [0x1, 0x2, 0x4, 0x8]) if (keyMatches(uid, b, control, hop, key, epoch)) return true;
  return false;
}

const sameBytes = (a: number[], b: number[]): boolean => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

/**
 * Fiat V1 (BCM Hitag2): AM, Manchester cells at either 250 / 500 us (variant A) or 100 / 200 us (variant B), both
 * tracked at once in a sliding 208-cell window; 104 wire bits = 13 bytes: 00, family 01, a 32-bit UID, a 4-bit
 * button, a 10-bit control counter, a 32-bit Hitag2 authenticator, 2 tail bits, and an XOR byte. The authenticator is
 * checked against ProtoPirate's built-in list of known Hitag2 keys (epoch 0).
 */
export class PPFiatV1 extends PPDecoder {
  private readonly cells = [new Uint8Array(WIRE_CELLS), new Uint8Array(WIRE_CELLS)];
  private readonly cellCount = [0, 0];
  private rawData: number[] = new Array<number>(13).fill(0);
  private lastRawData: number[] = new Array<number>(13).fill(0);
  private lastRawValid = false;
  private uid = 0;
  private hop = 0;
  private family = 0;
  private tailBits = 2;
  private frameXor = 0;
  private hitag2Key: number[] = new Array<number>(6).fill(0);
  private hitag2KeyValid = false;
  private teVariant = 1;

  constructor() { super('Fiat V1', PPModulation.AM, CONSTS[0]); this.reset(); }

  override reset(): void {
    this.rawData = new Array<number>(13).fill(0); this.lastRawData = this.rawData.slice();
    this.parserStep = STEP_RESET; this.decodeData = 0n; this.decodeCountBit = 0;
    this.lastRawValid = false;
    this.data = 0n; this.dataCountBit = 0; this.serial = 0n; this.btn = 0; this.cnt = 0n;
    this.uid = 0; this.hop = 0; this.family = 0; this.tailBits = DEFAULT_TAIL_BITS; this.frameXor = 0;
    this.hitag2KeyValid = false; this.teVariant = VARIANT_B;
    this.hitag2Key = new Array<number>(6).fill(0);
    this.clearAllCells();
  }

  private clearCells(v: number): void { this.cellCount[v] = 0; this.cells[v].fill(0); }
  private clearAllCells(): void { this.clearCells(0); this.clearCells(1); }

  private decodeFields(): void {
    const r = this.rawData;
    this.family = r[1];
    this.uid = uidOf(r);
    this.serial = BigInt(this.uid);
    this.btn = r[6] >>> 4;
    this.cnt = BigInt(counterOf(r));
    this.hop = hopOf(r);
    this.tailBits = r[11] & 0x03;
    this.frameXor = r[12];
    this.data = ((this.serial << 32n) | BigInt(this.hop)) & MASK64;
    this.dataCountBit = LOGICAL_BITS;
    this.decodeData = this.data; this.decodeCountBit = this.dataCountBit;
    this.verifyHitag2Key();
  }

  private commit(raw: number[], variant: number): boolean {
    if (!frameValid(raw)) return false;
    if (this.lastRawValid && sameBytes(this.lastRawData, raw)) return true;
    this.rawData = raw.slice(); this.lastRawData = raw.slice(); this.lastRawValid = true;
    this.teVariant = variant === VARIANT_A ? VARIANT_A : VARIANT_B;
    this.decodeFields();
    this.emit();
    return true;
  }

  private tryDecodeWindow(v: number, invert: boolean): boolean {
    if (this.cellCount[v] !== WIRE_CELLS) return false;
    const cl = this.cells[v];
    const raw = new Array<number>(WIRE_BYTES).fill(0);
    for (let bi = 0; bi < WIRE_BITS; bi++) {
      const first = cl[bi * 2], second = cl[bi * 2 + 1];
      if (first === second) return false;
      let bit = first !== 0;
      if (invert) bit = !bit;
      if (bit) raw[bi >> 3] |= 1 << (7 - (bi & 7));
    }
    return this.commit(raw, v);
  }

  private tryDecode(v: number): void {
    if (this.tryDecodeWindow(v, false)) return;
    this.tryDecodeWindow(v, true);
  }

  private pushCell(v: number, level: boolean): void {
    const cl = this.cells[v];
    if (this.cellCount[v] < WIRE_CELLS) {
      cl[this.cellCount[v]] = level ? 1 : 0; this.cellCount[v]++;
    } else {
      cl.copyWithin(0, 1); cl[WIRE_CELLS - 1] = level ? 1 : 0;
    }
    this.tryDecode(v);
  }

  private feedDataPulse(level: boolean, duration: number): boolean {
    let matched = false;
    for (let v = 0; v < 2; v++) {
      if (isShortV(v, duration)) {
        this.pushCell(v, level); matched = true;
      } else if (isLongV(v, duration)) {
        this.pushCell(v, level); this.pushCell(v, level); matched = true;
      } else {
        if (!level && duration >= BOUNDARY_MIN_US) this.pushCell(v, false);
        this.clearCells(v);
      }
    }
    return matched;
  }

  private verifyHitag2Key(): void {
    this.hitag2KeyValid = false; this.hitag2Key = new Array<number>(6).fill(0);
    const control = Number(this.cnt & 0x03FFn);
    for (const k of knownKeys) {
      if (keyMatches(this.uid, this.btn, control, this.hop, k, 0) || keyMatchesAnyButton(this.uid, control, this.hop, k, 0)) {
        this.hitag2Key = k.slice(); this.hitag2KeyValid = true;
        return;
      }
    }
  }

  feed(level: boolean, duration: number): void {
    switch (this.parserStep) {
      case STEP_RESET:
        if (isPulse(duration)) {
          this.clearAllCells();
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
    const f: PPField[] = [{ name: 'Sync', value: hx('%02X', this.family) },
      { name: 'UID', value: hx('%08X', this.uid) },
      { name: 'Auth', value: hx('%08X', this.hop) },
      { name: 'Button', value: fiatV1ButtonName(this.btn) },
      { name: 'Ctrl', value: hx('%03X', this.cnt) },
      { name: 'TE', value: `${this.teVariant}` },
      { name: 'Tail', value: `${this.tailBits}` },
      { name: 'XOR', value: hx('%02X', this.frameXor) },
      { name: 'KEY', value: this.hitag2KeyValid ? 'OK' : '??' }];
    if (this.hitag2KeyValid) f.push({ name: 'Hitag2 Key', value: this.hitag2Key.map((b) => hx('%02X', b)).join('') });
    return { name: this.name, bits: LOGICAL_BITS, key: hx('%08X %03X%01X %08X', this.serial, this.cnt, this.btn, this.hop),
      serial: this.serial, btn: hx('%02X', this.btn), cnt: this.cnt, fields: f };
  }

  /**
   * fiat_v1.c get_string: "%s %ubit %s\r\n%08lX %03lX%01X %08lX\r\nSync:%02X UID:%08lX Auth:%08lX\r\n
   * Btn:%02X [%s] Ctrl:%03lX\r\nTE:%u Tail:%u XOR:%02X\r\n".
   */
  override cString(h: PPHit): string {
    const v = new Map<string, string>();
    for (const f of h.fields) if (!v.has(f.name)) v.set(f.name, f.value);
    return `${h.name} ${h.bits}bit KEY:${v.get('KEY')} | ${h.key} | Sync:${v.get('Sync')} UID:${v.get('UID')} Auth:${v.get('Auth')}` +
      ` | Btn:${h.btn} [${v.get('Button')}] Ctrl:${v.get('Ctrl')} | TE:${v.get('TE')} Tail:${v.get('Tail')} XOR:${v.get('XOR')}`;
  }
}
