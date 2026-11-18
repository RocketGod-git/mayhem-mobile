/**
 * DMR control signaling blocks to named fields: the ETSI TS 102 361-2/-4 CSBKs (Tier III Aloha, broadcasts,
 * grants, acknowledgements) and, under feature set ID 0x10, the block formats derived from our own recordings
 * (rest-channel beacon, unit report header and unit report, with the vendor check). No DOM.
 */
import { hex } from './codes.js';
import { h, type Field } from './tsbk.js';

export interface Csbk {
  op: number; fid: number; last: boolean; name: string; hex: string; fields: Field[]; kind: string;
  /** Checked by its CRC; the derived unit-report formats have none known. */
  verified: boolean;
  derived?: boolean;
  sysCode?: number; net?: number; site?: number; model?: string;
  lpcn?: number; slot?: number; dst?: number; src?: number; group?: boolean; emergency?: boolean;
  rest?: number; busy?: number[]; beaconSlot?: number; unit?: number; lcn?: number;
  lonLo?: number; latLo?: number; noFix?: boolean;
}

const OPS: Record<number, string> = {
  0x04: 'UNIT TO UNIT VOICE REQUEST', 0x05: 'UNIT TO UNIT VOICE ANSWER', 0x07: 'CHANNEL TIMING', 0x19: 'ALOHA',
  0x1a: 'UNIFIED DATA TRANSPORT HEADER', 0x1c: 'AHOY', 0x1e: 'ACKNOWLEDGE VITAL', 0x1f: 'RANDOM ACCESS REQUEST',
  0x20: 'ACKNOWLEDGE', 0x21: 'ACKNOWLEDGE (TIER II)', 0x24: 'RADIO CHECK', 0x26: 'NEGATIVE ACKNOWLEDGE', 0x27: 'EMERGENCY',
  0x28: 'BROADCAST', 0x2a: 'MAINTENANCE', 0x2e: 'CLEAR', 0x2f: 'PROTECT', 0x30: 'PRIVATE VOICE GRANT', 0x31: 'TALKGROUP VOICE GRANT',
  0x32: 'BROADCAST TALKGROUP VOICE GRANT', 0x33: 'PRIVATE DATA GRANT', 0x34: 'TALKGROUP DATA GRANT', 0x35: 'DUPLEX PRIVATE VOICE GRANT',
  0x36: 'DUPLEX PRIVATE DATA GRANT', 0x38: 'BS OUTBOUND ACTIVATION', 0x39: 'MOVE', 0x3d: 'PREAMBLE',
};
const BCAST: Record<number, string> = {
  0: 'ANNOUNCE/WITHDRAW CONTROL CHANNEL', 1: 'CALL TIMER PARAMETERS', 2: 'VOTE NOW', 3: 'LOCAL TIME', 4: 'MASS REGISTRATION',
  5: 'CHANNEL FREQUENCY', 6: 'ADJACENT SITE', 7: 'GENERAL SITE PARAMETERS',
};
const MODELS = ['TINY', 'SMALL', 'LARGE', 'HUGE'];
/** Network and site bits per system identity model (TS 102 361-4 C_SYScode). */
const NET_BITS = [9, 7, 4, 2];

/** The 16-bit system identity code: model, network, site, partition. */
export function sysCode(c: number): { model: string; net: number; site: number; par: number } {
  const m = c >> 14, nb = NET_BITS[m], sb = 12 - nb;
  return { model: MODELS[m], net: (c >> (2 + sb)) & ((1 << nb) - 1), site: ((c >> 2) & ((1 << sb) - 1)) + 1, par: c & 3 };
}

function fieldOf(b: ArrayLike<number>): (from: number, n: number) => number {
  return (from, n) => { let v = 0; for (let i = 0; i < n; i++) { const p = from + i; v = v * 2 + ((b[2 + (p >> 3)] >> (7 - (p & 7))) & 1); } return v; };
}

/** [verified]: the block passed its CRC. */
export function parseCsbk(b: ArrayLike<number>, verified: boolean): Csbk {
  const op = b[0] & 0x3f, fid = b[1], f = fieldOf(b), fields: Field[] = [];
  const c: Csbk = { op, fid, last: (b[0] & 0x80) !== 0, name: '', hex: hex(b, 0, 12), fields, kind: 'other', verified };
  const add = (k: string, v: string) => fields.push({ k, v });
  const sysF = (v: number) => { const s = sysCode(v); c.sysCode = v; c.net = s.net; c.site = s.site; c.model = s.model; add('SYSTEM CODE', `${h(v, 4)} (${s.model} net ${s.net} site ${s.site})`); };
  if (fid === 0x10) return vendor10(b, c, add);
  if (fid !== 0) { c.name = `FID ${h(fid, 2)} CSBK ${h(op, 2)}`; c.kind = 'vendor'; add('PAYLOAD', hex(b, 2, 10)); return c; }
  c.name = OPS[op] ?? `CSBK ${h(op, 2)}`;
  switch (op) {
    case 0x19: {
      c.kind = 'aloha';
      add('SITE TS SYNC', `${f(2, 1)}`); add('VERSION', `${f(3, 3)}`); add('ACTIVE CONNECTION', `${f(7, 1)}`); add('MASK', `${f(8, 5)}`);
      add('SERVICE FUNCTION', `${f(13, 2)}`); add('NRAND WAIT', `${f(15, 4)}`); add('REGISTRATION REQUIRED', f(19, 1) ? 'yes' : 'no'); add('BACKOFF', `${f(20, 4)}`);
      sysF(f(24, 16)); const ms = f(40, 24); if (ms) { c.dst = ms; add('MS ADDRESS', `${ms}`); }
      break;
    }
    case 0x28: {
      c.kind = 'bcast'; const ty = f(0, 5);
      c.name = `BROADCAST · ${BCAST[ty] ?? `TYPE ${ty}`}`;
      add('PARAMETERS 1', h(f(5, 14), 4)); add('REGISTRATION REQUIRED', f(19, 1) ? 'yes' : 'no'); add('BACKOFF', `${f(20, 4)}`); sysF(f(24, 16)); add('PARAMETERS 2', h(f(40, 24), 6));
      break;
    }
    case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: {
      c.kind = 'grant'; c.lpcn = f(0, 12); c.slot = f(12, 1); c.emergency = f(14, 1) === 1; c.dst = f(16, 24); c.src = f(40, 24);
      c.group = op === 0x31 || op === 0x32 || op === 0x34;
      add('CHANNEL', `LPCN ${c.lpcn} slot ${c.slot + 1}`); add('LATE ENTRY', `${f(13, 1)}`); add('EMERGENCY', c.emergency ? 'yes' : 'no');
      add(c.group ? 'TALKGROUP' : 'TARGET', `${c.dst}`); add('SOURCE', `${c.src}`);
      break;
    }
    case 0x20: case 0x1e: {
      c.kind = 'ack'; c.dst = f(16, 24); c.src = f(40, 24);
      add('RESPONSE INFO', h(f(0, 7), 2)); add('REASON', h(f(7, 8), 2)); add('TARGET', `${c.dst}`); add('ADDITIONAL', `${c.src}`);
      break;
    }
    case 0x1c: case 0x2e: case 0x2f: case 0x39: case 0x04: case 0x05: case 0x24: case 0x26: case 0x27: case 0x38: case 0x3d: {
      c.kind = 'unit'; c.dst = f(16, 24); c.src = f(40, 24);
      add('INFO', h(f(0, 16), 4)); add('TARGET', `${c.dst}`); add('SOURCE', `${c.src}`);
      break;
    }
    default: add('PAYLOAD', hex(b, 2, 10));
  }
  return c;
}

/**
 * Feature set 0x10, formats derived from our recordings: 0x3E is a rest-channel beacon (CRC verified), 0x3D with
 * 0x09 after it is a unit report (the vendor check below), 0x3B a periodic broadcast, 0x08 a call
 * announcement. Anything else is shown as hex.
 */
function vendor10(b: ArrayLike<number>, c: Csbk, add: (k: string, v: string) => void): Csbk {
  const op = c.op, w = (i: number) => (b[i] << 8) | b[i + 1];
  c.derived = true;
  if (op === 0x3e) {
    c.kind = 'beacon'; c.name = 'REST-CHANNEL BEACON';
    c.beaconSlot = (b[2] >> 5) & 1; c.rest = b[2] & 15;
    c.busy = []; if (b[5] & 0x80) for (let n = 1; n <= 8; n++) if (b[6] & (0x80 >> (n - 1))) c.busy.push(n);
    const id = w(7);
    add('SLOT', `${c.beaconSlot + 1}`); add('REST CHANNEL', `LCN ${c.rest}`); add('BUSY', c.busy.length ? c.busy.map(n => `LCN ${n}`).join(', ') : 'none');
    if (id !== 0xffff && (b[5] & 0x80)) { c.unit = id; add('ID ON BUSY CHANNEL', `${id} (${h(id, 4)})`); }
    add('FLAGS', `${h(b[2], 2)} ${h(b[3], 2)}`);
  } else if (op === 0x3d) {
    c.kind = 'unithdr'; c.name = 'UNIT REPORT HEADER';
    if (b[2] === 0x88) { c.unit = w(8); c.lcn = b[7]; add('UNIT', `${c.unit} (${h(c.unit, 4)})`); add('LCN', `${c.lcn}`); }
    else { c.unit = w(5); c.name = 'DATA HEADER TOWARD UNIT'; add('UNIT', `${c.unit} (${h(c.unit, 4)})`); add('VALUE', h(b[7], 2)); }
    add('FORM', h(b[2], 2));
  } else if (op === 0x09) {
    c.kind = 'unitrpt'; c.name = 'UNIT REPORT';
    c.unit = w(4);
    c.noFix = b[6] === 0x02 && b[7] === 0 && b[8] === 0 && b[9] === 0;
    add('UNIT', `${c.unit} (${h(c.unit, 4)})`);
    if (!c.noFix) { c.lonLo = w(6); c.latLo = w(8); add('LON LOW 16', h(c.lonLo, 4)); add('LAT LOW 16', h(c.latLo, 4)); }
    else add('POSITION', 'no fix');
    add('STATUS', h(b[2], 2));
  } else if (op === 0x3b) {
    c.kind = 'sysbcast'; c.name = 'PERIODIC SYSTEM BROADCAST'; add('PAYLOAD', hex(b, 2, 10));
  } else if (op === 0x08) {
    c.kind = 'callann'; c.name = 'CALL ANNOUNCEMENT';
    const a = w(3), z = w(6); add('ID A', a === 0xffff ? 'all' : `${a}`); add('ID B', z === 0xffff ? 'all' : `${z}`);
    if (a !== 0xffff) c.unit = a;
  } else { c.derived = false; c.kind = 'vendor'; c.name = `FID 10 CSBK ${h(op, 2)}`; add('PAYLOAD', hex(b, 2, 10)); }
  return c;
}

/**
 * The check on the feature set 0x10 unit report (0x89) and its header (0xBD), derived from our recordings: CRC-CCITT
 * (0x11021) over the data bits in a fixed vendor order, given here as a table (data bit, MSB first from byte 0, to
 * the exponent of its column x^e mod 0x11021). c = tail XOR the columns of every set mapped bit; a block passes when
 * c equals its family's constant. The constant depends on the bits outside the table, so it is kept per family key
 * (the block with the mapped bits and the tail cleared): two are known from our recordings, others are learned when
 * the same c repeats on one system.
 */
const VENDOR_MAP: [number, number][] = [
  [16, 34], [18, 39], [19, 16], [20, 35], [34, 77], [35, 47], [36, 17], [37, 67], [38, 40], [39, 32], [40, 90], [41, 74], [42, 112],
  [43, 104], [44, 72], [45, 30], [46, 73], [47, 115], [48, 82], [49, 98], [50, 80], [51, 100], [52, 41], [53, 59], [54, 78], [55, 20],
  [56, 99], [57, 42], [58, 107], [59, 36], [60, 26], [61, 52], [62, 102], [63, 88], [64, 28], [65, 92], [66, 24], [67, 65], [68, 75],
  [69, 69], [70, 106], [71, 45], [72, 117], [73, 61], [74, 29], [75, 62], [76, 116], [77, 23], [78, 44], [79, 76],
];
const xpow = (e: number) => { let x = 1; for (let i = 0; i < e; i++) x = x & 0x8000 ? ((x << 1) ^ 0x11021) & 0xffff : (x << 1) & 0xffff; return x; };
const VENDOR_COL = VENDOR_MAP.map(([p, e]) => [p, xpow(e)] as [number, number]);
/** The block's family key (mapped bits and tail cleared) and its check value c. */
export function vendorCheckValue(b: ArrayLike<number>): { key: string; c: number } {
  const k = Array.from({ length: 10 }, (_, i) => b[i] & 255);
  let c = ((b[10] << 8) | b[11]) & 0xffff;
  for (const [p, col] of VENDOR_COL) { const m = 0x80 >> (p & 7); if (b[p >> 3] & m) c ^= col; k[p >> 3] &= ~m; }
  return { key: k.map(v => v.toString(16).padStart(2, '0')).join(''), c };
}
/** Family keys and constants from our recordings. */
const VENDOR_KNOWN = new Map<string, number>([
  [vendorCheckValue([0x89, 0x10, 0x11, 0x00, 0x0e, 0x7d, 0xe4, 0x9a, 0x18, 0x09, 0xcc, 0x92]).key, 0x06da],
  [vendorCheckValue([0xbd, 0x10, 0x88, 0x02, 0x00, 0xff, 0xff, 0x06, 0x0a, 0x8f, 0xb1, 0x61]).key, 0x4616],
]);
/** Checks 0x89 / 0xBD blocks; the constants for other systems' fixed bytes are learned from repeats. */
export class VendorCheck {
  private readonly learned = new Map<string, number>();
  private readonly votes = new Map<string, Map<number, number>>();
  static known(key: string): number | undefined { return VENDOR_KNOWN.get(key); }
  /** [scope] separates systems: a learned constant holds for the system it was learned on. */
  check(b: ArrayLike<number>, scope = ''): boolean {
    const { key, c } = vendorCheckValue(b), k0 = VENDOR_KNOWN.get(key);
    if (k0 !== undefined) return c === k0;
    const sk = `${scope}|${key}`, l = this.learned.get(sk);
    if (l !== undefined) return c === l;
    const v = this.votes.get(sk) ?? new Map<number, number>(); v.set(c, (v.get(c) ?? 0) + 1); this.votes.set(sk, v);
    if (this.votes.size > 2000) this.votes.clear();
    if ((v.get(c) ?? 0) >= 4) { this.learned.set(sk, c); return true; }
    return false;
  }
}

/** Degrees × 2^22/360: the unit report carries the low 16 bits of each. */
export const POS_SCALE = 2 ** 22 / 360;
/** The full coordinate from its low 16 bits: the wrap nearest the reference (valid within about 300 km). */
export function unwrap16(lo16: number, refDeg: number): number {
  const r = Math.round(refDeg * POS_SCALE), d = ((lo16 - (r & 0xffff) + 32768) % 65536 + 65536) % 65536 - 32768;
  return (r + d) / POS_SCALE;
}

export function csbkLine(c: Csbk): string {
  return `${c.name}${c.fields.length ? ' · ' + c.fields.map(x => `${x.k.toLowerCase()} ${x.v}`).join(' · ') : ''}`;
}
