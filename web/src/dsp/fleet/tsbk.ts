/**
 * P25 trunking signaling blocks (TIA-102 outbound TSBK opcodes) to named fields, and the channel tables that turn
 * a 16-bit channel number into a frequency. Each block is 12 bytes: last-block and protected flags with the opcode,
 * the manufacturer ID, 64 bits of payload, CRC. No DOM.
 */
import { hex } from './codes.js';

export interface Field { k: string; v: string }
export interface Iden {
  iden: number; base: number; spacing: number; txOffset: number; bw: number; tdma: boolean; slots: number; form: string; raw: string;
}
export interface Tsbk {
  op: number; mfid: number; last: boolean; prot: boolean; name: string; hex: string; fields: Field[];
  /** Fields the station model uses. */
  kind: string;
  sys?: number; wacn?: number; rfss?: number; site?: number; lra?: number; cls?: number;
  ch?: number; ch2?: number; group?: number; group2?: number; src?: number; dst?: number; svc?: number;
  iden?: Iden; time?: string;
}

const OPS: Record<number, string> = {
  0x00: 'GROUP VOICE GRANT', 0x02: 'GROUP VOICE GRANT UPDATE', 0x03: 'GROUP VOICE GRANT UPDATE (EXPLICIT)',
  0x04: 'UNIT TO UNIT VOICE GRANT', 0x05: 'UNIT TO UNIT ANSWER REQUEST', 0x06: 'UNIT TO UNIT VOICE GRANT UPDATE',
  0x08: 'TELEPHONE INTERCONNECT GRANT', 0x09: 'TELEPHONE INTERCONNECT GRANT UPDATE', 0x0a: 'TELEPHONE INTERCONNECT ANSWER REQUEST',
  0x10: 'INDIVIDUAL DATA GRANT', 0x11: 'GROUP DATA GRANT', 0x12: 'GROUP DATA ANNOUNCEMENT', 0x13: 'GROUP DATA ANNOUNCEMENT (EXPLICIT)',
  0x14: 'SNDCP DATA CHANNEL GRANT', 0x15: 'SNDCP DATA PAGE REQUEST', 0x16: 'SNDCP DATA CHANNEL ANNOUNCEMENT',
  0x18: 'STATUS UPDATE', 0x1a: 'STATUS QUERY', 0x1c: 'MESSAGE UPDATE', 0x1d: 'RADIO UNIT MONITOR', 0x1f: 'CALL ALERT',
  0x20: 'ACKNOWLEDGE RESPONSE', 0x21: 'QUEUED RESPONSE', 0x24: 'EXTENDED FUNCTION COMMAND', 0x27: 'DENY RESPONSE',
  0x28: 'GROUP AFFILIATION RESPONSE', 0x29: 'SECONDARY CONTROL CHANNEL (EXPLICIT)', 0x2a: 'GROUP AFFILIATION QUERY',
  0x2b: 'LOCATION REGISTRATION RESPONSE', 0x2c: 'UNIT REGISTRATION RESPONSE', 0x2d: 'UNIT REGISTRATION COMMAND',
  0x2e: 'AUTHENTICATION COMMAND', 0x2f: 'UNIT DEREGISTRATION ACK', 0x30: 'SYNCHRONIZATION BROADCAST',
  0x33: 'IDENTIFIER UPDATE TDMA', 0x34: 'IDENTIFIER UPDATE VHF/UHF', 0x35: 'TIME AND DATE ANNOUNCEMENT',
  0x36: 'ROAMING ADDRESS COMMAND', 0x37: 'ROAMING ADDRESS UPDATE', 0x38: 'SYSTEM SERVICE BROADCAST',
  0x39: 'SECONDARY CONTROL CHANNEL', 0x3a: 'RFSS STATUS', 0x3b: 'NETWORK STATUS', 0x3c: 'ADJACENT SITE STATUS',
  0x3d: 'IDENTIFIER UPDATE',
};

/** Bits [from, from+n) of the 64-bit payload (bytes 2..9), most significant first. */
function fieldOf(b: ArrayLike<number>): (from: number, n: number) => number {
  return (from, n) => { let v = 0; for (let i = 0; i < n; i++) { const p = from + i; v = v * 2 + ((b[2 + (p >> 3)] >> (7 - (p & 7))) & 1); } return v; };
}
export const h = (v: number, w: number) => v.toString(16).toUpperCase().padStart(w, '0');
const chs = (c: number) => `${h(c, 4)} (iden ${c >> 12}, ch ${c & 0xfff})`;
const svcText = (s: number) => [s & 0x80 ? 'emergency' : '', s & 0x40 ? 'encrypted' : '', s & 0x20 ? 'duplex' : '', s & 0x10 ? 'packet' : '', `priority ${s & 7}`].filter(Boolean).join(', ');
export const svcFlags = (s: number) => ({ emergency: (s & 0x80) !== 0, encrypted: (s & 0x40) !== 0 });

/** Slots per carrier for an IDENTIFIER UPDATE TDMA channel type (TIA-102 channel type table). */
const TDMA_SLOTS: Record<number, number> = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 4, 5: 2 };

export function parseTsbk(b: ArrayLike<number>): Tsbk {
  const op = b[0] & 0x3f, mfid = b[1], f = fieldOf(b), fields: Field[] = [];
  const t: Tsbk = { op, mfid, last: (b[0] & 0x80) !== 0, prot: (b[0] & 0x40) !== 0, name: '', hex: hex(b, 0, 12), fields, kind: 'other' };
  const add = (k: string, v: string) => fields.push({ k, v });
  if (t.prot) { t.name = `PROTECTED BLOCK OPCODE ${h(op, 2)}`; add('PAYLOAD', hex(b, 2, 10)); return t; }
  if (mfid !== 0) { t.name = `MFID ${h(mfid, 2)} OPCODE ${h(op, 2)}`; t.kind = 'vendor'; add('MANUFACTURER ID', h(mfid, 2)); add('PAYLOAD', hex(b, 2, 10)); return t; }
  t.name = OPS[op] ?? `OPCODE ${h(op, 2)}`;
  switch (op) {
    case 0x00: case 0x11: {
      t.kind = op === 0 ? 'grant' : 'datagrant'; t.svc = f(0, 8); t.ch = f(8, 16); t.group = f(24, 16); t.src = f(40, 24);
      add('SERVICE OPTIONS', `${h(t.svc, 2)} (${svcText(t.svc)})`); add('CHANNEL', chs(t.ch)); add('TALKGROUP', `${t.group}`); add('SOURCE', `${t.src}`); break;
    }
    case 0x02: {
      t.kind = 'update'; t.ch = f(0, 16); t.group = f(16, 16); t.ch2 = f(32, 16); t.group2 = f(48, 16);
      add('CHANNEL A', chs(t.ch)); add('TALKGROUP A', `${t.group}`); add('CHANNEL B', chs(t.ch2)); add('TALKGROUP B', `${t.group2}`); break;
    }
    case 0x03: {
      t.kind = 'update'; t.svc = f(0, 8); t.ch = f(16, 16); t.ch2 = f(32, 16); t.group = f(48, 16);
      add('SERVICE OPTIONS', `${h(t.svc, 2)} (${svcText(t.svc)})`); add('CHANNEL (TX)', chs(t.ch)); add('CHANNEL (RX)', chs(t.ch2)); add('TALKGROUP', `${t.group}`); break;
    }
    case 0x04: case 0x06: case 0x10: {
      t.kind = op === 0x10 ? 'datagrant' : 'u2u'; t.ch = f(0, 16); t.dst = f(16, 24); t.src = f(40, 24);
      add('CHANNEL', chs(t.ch)); add('TARGET', `${t.dst}`); add('SOURCE', `${t.src}`); break;
    }
    case 0x05: {
      t.kind = 'u2u'; t.svc = f(0, 8); t.dst = f(16, 24); t.src = f(40, 24);
      add('SERVICE OPTIONS', `${h(t.svc, 2)} (${svcText(t.svc)})`); add('TARGET', `${t.dst}`); add('SOURCE', `${t.src}`); break;
    }
    case 0x08: case 0x09: {
      t.kind = 'grant'; t.svc = f(0, 8); t.ch = f(8, 16); t.dst = f(40, 24);
      add('SERVICE OPTIONS', `${h(t.svc, 2)} (${svcText(t.svc)})`); add('CHANNEL', chs(t.ch)); add('CALL TIMER', `${f(24, 16)}`); add('TARGET', `${t.dst}`); break;
    }
    case 0x12: {
      t.kind = 'datagrant'; t.ch = f(0, 16); t.group = f(16, 16);
      add('CHANNEL A', chs(t.ch)); add('TALKGROUP A', `${t.group}`); add('CHANNEL B', chs(f(32, 16))); add('TALKGROUP B', `${f(48, 16)}`); break;
    }
    case 0x14: {
      t.kind = 'datagrant'; t.svc = f(0, 8); t.ch = f(8, 16); t.ch2 = f(24, 16); t.dst = f(40, 24);
      add('SERVICE OPTIONS', h(t.svc, 2)); add('CHANNEL (TX)', chs(t.ch)); add('CHANNEL (RX)', t.ch2 === 0xffff ? 'same' : chs(t.ch2)); add('TARGET', `${t.dst}`); break;
    }
    case 0x16: {
      t.kind = 'dataann'; const c = f(16, 16); if (c !== 0xffff) t.ch = c;
      add('FLAGS', h(f(0, 16), 4)); add('CHANNEL (TX)', c === 0xffff ? 'none' : chs(c)); add('CHANNEL (RX)', f(32, 16) === 0xffff ? 'same' : chs(f(32, 16))); add('SYSTEM SERVICE CLASS', h(f(48, 16), 4)); break;
    }
    case 0x18: case 0x1c: case 0x1f: case 0x1d: case 0x1a: case 0x15: {
      t.kind = 'unit'; t.dst = f(16, 24); t.src = f(40, 24);
      add('INFO', h(f(0, 16), 4)); add('TARGET', `${t.dst}`); add('SOURCE', `${t.src}`); break;
    }
    case 0x20: case 0x21: case 0x27: {
      t.kind = 'unit'; t.dst = f(40, 24);
      add('SERVICE TYPE', h(f(2, 6), 2)); if (op !== 0x20) add('REASON', h(f(8, 8), 2));
      add('ADDITIONAL INFO', h(f(op === 0x20 ? 8 : 16, op === 0x20 ? 32 : 24), op === 0x20 ? 8 : 6)); add('TARGET', `${t.dst}`); break;
    }
    case 0x28: {
      t.kind = 'affil'; t.group = f(24, 16); t.dst = f(40, 24);
      add('RESPONSE', ['accept', 'fail', 'deny', 'refused'][f(6, 2)]); add('ANNOUNCEMENT GROUP', `${f(8, 16)}`); add('TALKGROUP', `${t.group}`); add('TARGET', `${t.dst}`); break;
    }
    case 0x2a: {
      t.kind = 'unit'; t.dst = f(16, 24); t.src = f(40, 24);
      add('TARGET', `${t.dst}`); add('SOURCE', h(t.src, 6)); break;
    }
    case 0x2b: {
      t.kind = 'affil'; t.group = f(8, 16); t.rfss = f(24, 8); t.site = f(32, 8); t.dst = f(40, 24);
      add('RESPONSE', ['accept', 'fail', 'deny', 'refused'][f(6, 2)]); add('TALKGROUP', `${t.group}`); add('RFSS', `${t.rfss}`); add('SITE', `${t.site}`); add('TARGET', `${t.dst}`); break;
    }
    case 0x2c: {
      t.kind = 'reg'; t.sys = f(4, 12); t.src = f(16, 24); t.dst = f(40, 24);
      add('RESPONSE', ['accept', 'fail', 'deny', 'refused'][f(2, 2)]); add('SYSTEM', h(t.sys, 3)); add('UNIT ID', `${t.src}`); add('ADDRESS', `${t.dst}`); break;
    }
    case 0x2d: {
      t.kind = 'reg'; t.dst = f(16, 24); t.src = f(40, 24);
      add('TARGET', `${t.dst}`); add('SOURCE', h(t.src, 6)); break;
    }
    case 0x2f: {
      t.kind = 'dereg'; t.wacn = f(8, 20); t.sys = f(28, 12); t.src = f(40, 24);
      add('WACN', h(t.wacn, 5)); add('SYSTEM', h(t.sys, 3)); add('UNIT ID', `${t.src}`); break;
    }
    case 0x30: {
      t.kind = 'time';
      const y = 2000 + f(24, 7), mo = f(31, 4), d = f(35, 5), hr = f(40, 5), mi = f(45, 6), us = f(51, 13);
      const sec = us * 0.0075;
      t.time = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(hr).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')} UTC`;
      add('DATE AND TIME', t.time); add('MICROSLOTS', `${us} (7.5 ms)`); add('HEADER BITS', h(f(0, 24), 6)); break;
    }
    case 0x35: {
      t.kind = 'time';
      const mo = f(16, 4), d = f(20, 5), y = f(25, 13), hr = f(40, 5), mi = f(45, 6), s = f(51, 6);
      t.time = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(hr).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      add('DATE AND TIME', t.time); add('FLAGS AND OFFSET', h(f(0, 16), 4)); break;
    }
    case 0x29: {
      t.kind = 'sccb'; t.rfss = f(0, 8); t.site = f(8, 8); t.ch = f(16, 16); t.ch2 = f(32, 16); t.cls = f(48, 8);
      add('RFSS', `${t.rfss}`); add('SITE', `${t.site}`); add('CHANNEL (TX)', chs(t.ch)); add('CHANNEL (RX)', chs(t.ch2)); add('SERVICE CLASS', h(t.cls, 2)); break;
    }
    case 0x39: {
      t.kind = 'sccb'; t.rfss = f(0, 8); t.site = f(8, 8); t.ch = f(16, 16); t.cls = f(32, 8); t.ch2 = f(40, 16);
      add('RFSS', `${t.rfss}`); add('SITE', `${t.site}`); add('CHANNEL 1', chs(t.ch)); add('SERVICE CLASS 1', h(t.cls, 2)); add('CHANNEL 2', chs(t.ch2)); add('SERVICE CLASS 2', h(f(56, 8), 2)); break;
    }
    case 0x3a: {
      t.kind = 'rfss'; t.lra = f(0, 8); t.sys = f(12, 12); t.rfss = f(24, 8); t.site = f(32, 8); t.ch = f(40, 16); t.cls = f(56, 8);
      add('LRA', h(t.lra, 2)); add('FLAGS', h(f(8, 4), 1)); add('SYSTEM', h(t.sys, 3)); add('RFSS', `${t.rfss}`); add('SITE', `${t.site}`); add('CHANNEL', chs(t.ch)); add('SERVICE CLASS', h(t.cls, 2)); break;
    }
    case 0x3b: {
      t.kind = 'net'; t.lra = f(0, 8); t.wacn = f(8, 20); t.sys = f(28, 12); t.ch = f(40, 16); t.cls = f(56, 8);
      add('LRA', h(t.lra, 2)); add('WACN', h(t.wacn, 5)); add('SYSTEM', h(t.sys, 3)); add('CHANNEL', chs(t.ch)); add('SERVICE CLASS', h(t.cls, 2)); break;
    }
    case 0x3c: {
      t.kind = 'adj'; t.lra = f(0, 8); t.sys = f(12, 12); t.rfss = f(24, 8); t.site = f(32, 8); t.ch = f(40, 16); t.cls = f(56, 8);
      add('LRA', h(t.lra, 2)); add('FLAGS', h(f(8, 4), 1)); add('SYSTEM', h(t.sys, 3)); add('RFSS', `${t.rfss}`); add('SITE', `${t.site}`); add('CHANNEL', chs(t.ch)); add('SERVICE CLASS', h(t.cls, 2)); break;
    }
    case 0x3d: {
      const off = f(13, 9), sp = f(22, 10) * 125;
      t.kind = 'iden';
      t.iden = { iden: f(0, 4), bw: f(4, 9) * 125, txOffset: (off & 0x100 ? 1 : -1) * (off & 0xff) * 250_000, spacing: sp, base: f(32, 32) * 5, tdma: false, slots: 1, form: 'FDMA', raw: hex(b, 2, 10) };
      break;
    }
    case 0x33: {
      const ty = f(4, 4), off = f(8, 14), sp = f(22, 10) * 125;
      t.kind = 'iden';
      t.iden = { iden: f(0, 4), bw: 0, txOffset: (off & 0x2000 ? 1 : -1) * (off & 0x1fff) * sp, spacing: sp, base: f(32, 32) * 5, tdma: true, slots: TDMA_SLOTS[ty] ?? 2, form: `TDMA type ${ty}`, raw: hex(b, 2, 10) };
      break;
    }
    case 0x34: {
      const off = f(8, 14), sp = f(22, 10) * 125;
      t.kind = 'iden';
      t.iden = { iden: f(0, 4), bw: f(4, 4), txOffset: (off & 0x2000 ? 1 : -1) * (off & 0x1fff) * sp, spacing: sp, base: f(32, 32) * 5, tdma: false, slots: 1, form: 'VHF/UHF', raw: hex(b, 2, 10) };
      break;
    }
    default: add('PAYLOAD', hex(b, 2, 10));
  }
  if (t.iden) {
    const i = t.iden;
    add('IDENTIFIER', `${i.iden}`); add('FORM', i.form); add('BASE', `${(i.base / 1e6).toFixed(5)} MHz`); add('SPACING', `${(i.spacing / 1e3).toFixed(3)} kHz`);
    add('TX OFFSET', `${i.txOffset >= 0 ? '+' : ''}${(i.txOffset / 1e6).toFixed(4)} MHz`); if (i.tdma) add('SLOTS', `${i.slots}`); else if (i.bw) add('BANDWIDTH', i.form === 'FDMA' ? `${(i.bw / 1e3).toFixed(2)} kHz` : `code ${i.bw}`);
  }
  return t;
}

/** A channel number through a site's identifier table: frequency, slot and whether it is a TDMA (Phase 2) channel. */
export function resolveChannel(ch: number, tables: Map<number, Iden> | Record<number, Iden>): { hz: number; slot: number; tdma: boolean } | null {
  const i = tables instanceof Map ? tables.get(ch >> 12) : tables[ch >> 12];
  if (!i || !i.spacing) return null;
  const n = ch & 0xfff, s = i.tdma ? Math.max(1, i.slots) : 1;
  return { hz: i.base + Math.floor(n / s) * i.spacing, slot: n % s, tdma: i.tdma && s > 1 };
}

/** One line for the log: name and its fields. */
export function tsbkLine(t: Tsbk): string {
  return `${t.name}${t.fields.length ? ' · ' + t.fields.map(x => `${x.k.toLowerCase()} ${x.v}`).join(' · ') : ''}`;
}
