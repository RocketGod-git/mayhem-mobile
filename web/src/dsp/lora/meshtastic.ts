/**
 * Meshtastic over the air. Port of core/lora/Meshtastic.swift: the 16-byte header, the channel's AES-CTR (the public
 * default key decrypts the default channel), and the protobuf messages inside, read field by field.
 */
import { Aes128 } from './aes128.js';
import { HWMODEL, PORTNUM, ROLE } from './meshtastic-enums.js';
import { allPresetNames } from './plan.js';

export type Field = [string, string];

export const hex2 = (v: number): string => (v & 0xff).toString(16).padStart(2, '0');
export const hexBytes = (b: ArrayLike<number>, from = 0, to = b.length): string => { let s = ''; for (let i = from; i < Math.min(to, b.length); i++) s += hex2(b[i]); return s; };
export const hex8 = (v: number): string => (v >>> 0).toString(16).padStart(8, '0');

/** Swift's `Date.description`: "2026-11-10 21:04:05 +0000". */
export function dateDescription(sec: number): string {
  const d = new Date(sec * 1000);
  if (isNaN(d.getTime())) return String(sec);
  const p = (v: number, w = 2): string => String(v).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
/** Swift's `String(bytes:encoding: .utf8)`: null when the bytes are not valid UTF-8. */
export function utf8OrNull(b: Uint8Array): string | null { try { return strictUtf8.decode(b); } catch { return null; } }
const looseUtf8 = new TextDecoder('utf-8');
/** Swift's `String(decoding:as: UTF8.self)`: invalid sequences become U+FFFD. */
export const utf8Lossy = (b: Uint8Array): string => looseUtf8.decode(b);

/** `%.Nf`. */
export const fixed = (v: number, d: number): string => v.toFixed(d);

type ProtoValue = { int: bigint } | { bytes: Uint8Array };

/** A protobuf message as (field number, value) pairs: varints and fixed ints as 64-bit unsigned, length-delimited as bytes. */
export class Proto {
  private constructor(readonly fields: [number, ProtoValue][]) {}

  static parse(b: Uint8Array): Proto | null {
    const f: [number, ProtoValue][] = [];
    let i = 0;
    const varint = (): bigint | null => {
      let v = 0n, shift = 0n;
      while (i < b.length) {
        const x = b[i]; i++;
        v |= BigInt(x & 0x7f) << shift;
        if ((x & 0x80) === 0) return v & 0xffffffffffffffffn;
        shift += 7n;
        if (shift > 63n) return null;
      }
      return null;
    };
    const le = (n: number): bigint => { let v = 0n; for (let k = 0; k < n; k++) v |= BigInt(b[i + k]) << BigInt(8 * k); return v; };
    while (i < b.length) {
      const key = varint();
      if (key === null) return null;
      const num = Number(key >> 3n);
      switch (Number(key & 7n)) {
        case 0: { const v = varint(); if (v === null) return null; f.push([num, { int: v }]); break; }
        case 1: if (i + 8 > b.length) return null; f.push([num, { int: le(8) }]); i += 8; break;
        case 5: if (i + 4 > b.length) return null; f.push([num, { int: le(4) }]); i += 4; break;
        case 2: {
          const l = varint();
          if (l === null || BigInt(i) + l > BigInt(b.length)) return null;
          const len = Number(l);
          f.push([num, { bytes: b.slice(i, i + len) }]); i += len; break;
        }
        default: return null;
      }
    }
    if (f.some(x => x[0] === 0)) return null;   // field 0 does not exist: not a protobuf
    return new Proto(f);
  }

  int(n: number): bigint | null { for (const [k, v] of this.fields) if (k === n && 'int' in v) return v.int; return null; }
  bytes(n: number): Uint8Array | null { for (const [k, v] of this.fields) if (k === n && 'bytes' in v) return v.bytes; return null; }
  all(n: number): ProtoValue[] { return this.fields.filter(x => x[0] === n).map(x => x[1]); }
  /** A number field as a JS number (exact below 2^53). */
  num(n: number): number | null { const v = this.int(n); return v === null ? null : Number(v); }
  string(n: number): string | null { const b = this.bytes(n); return b ? utf8OrNull(b) : null; }
  float(n: number): number | null {
    const v = this.int(n);
    if (v === null) return null;
    const dv = new DataView(new ArrayBuffer(4)); dv.setUint32(0, Number(v & 0xffffffffn)); return dv.getFloat32(0);
  }
  sint32(n: number): number | null { const v = this.int(n); return v === null ? null : Number(BigInt.asIntN(32, v)); }
  zigzag(n: number): bigint | null { const v = this.int(n); return v === null ? null : BigInt.asIntN(64, (v >> 1n) ^ (0n - (v & 1n))); }
}

/** One Meshtastic packet, decoded as far as it goes. */
export interface MeshtasticPacket {
  dest: number; from: number; id: number;
  hopLimit: number; hopStart: number; wantAck: boolean; viaMqtt: boolean;
  channelHash: number; nextHop: number; relayNode: number;
  /** Decrypted with a known key (the default channel), else null and only the header is known. */
  portnum: number | null;
  /** Everything read from the message, in order. */
  fields: Field[];
  // what the app keeps per node
  longName: string | null; shortName: string | null; hwModel: string | null; role: string | null;
  lat: number | null; lon: number | null; altitude: number | null;
  battery: number | null; voltage: number | null; channelUtil: number | null; airUtilTx: number | null; uptime: number | null;
  text: string | null;
}

export function portName(p: MeshtasticPacket): string { return p.portnum === null ? 'ENCRYPTED' : PORTNUM[p.portnum] ?? `PORT_${p.portnum}`; }
export function nodeName(n: number): string { return n >>> 0 === 0xffffffff ? 'everyone' : `!${hex8(n)}`; }

/** The public default key ("AQ==", the LongFast default channel). */
export const defaultKey = Uint8Array.from([0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59, 0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01]);
/** Keys to try, by channel hash (xor of the channel name's bytes and the key's bytes). The default channel of every
 *  modem preset shares the default key; each preset's name gives its own hash. */
export const presetNames: string[] = [...allPresetNames, 'LongModerate', 'VeryLongSlow', 'VLongSlow'];

export function channelHash(name: string, key: ArrayLike<number>): number {
  let h = 0;
  for (const b of new TextEncoder().encode(name)) h ^= b;
  for (let i = 0; i < key.length; i++) h ^= key[i];
  return h;
}

/** Meshtastic's simple public keys: PSK index 1 is the default key, 2-10 the default key with its last byte stepped
 *  up by one each. */
export const simpleKeys: Uint8Array[] = Array.from({ length: 10 }, (_, i) => { const k = defaultKey.slice(); k[15] = (k[15] + i) & 0xff; return k; });

export const knownChannels: Map<number, [string, Uint8Array]> = (() => {
  const m = new Map<number, [string, Uint8Array]>();
  for (const n of presetNames) m.set(channelHash(n, defaultKey), [n, defaultKey]);
  return m;
})();

const sameKey = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const fmtF = (v: number | null, unit: string, d = 1): string | null => (v === null ? null : `${fixed(v, d)}${unit}`);

export function parse(b: Uint8Array): MeshtasticPacket | null {
  if (b.length < 16) return null;
  const u32 = (i: number): number => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const flags = b[12];
  const p: MeshtasticPacket = {
    dest: u32(0), from: u32(4), id: u32(8), hopLimit: flags & 7, hopStart: flags >> 5,
    wantAck: (flags & 8) !== 0, viaMqtt: (flags & 16) !== 0, channelHash: b[13], nextHop: b[14], relayNode: b[15],
    portnum: null, fields: [], longName: null, shortName: null, hwModel: null, role: null, lat: null, lon: null, altitude: null,
    battery: null, voltage: null, channelUtil: null, airUtilTx: null, uptime: null, text: null,
  };
  const nonce = new Uint8Array(16);
  for (let k = 0; k < 4; k++) { nonce[k] = b[8 + k]; nonce[8 + k] = b[4 + k]; }
  // the preset's own channel first; then every public key on any channel name: a channel's hash only says which
  // name and key it is, and any name on a public key decrypts with that key
  const tries: [string, Uint8Array][] = [];
  const k0 = knownChannels.get(p.channelHash);
  if (k0) tries.push(k0);
  simpleKeys.forEach((key, i) => {
    if (!tries.some(t => sameKey(t[1], key))) tries.push([`public key ${i + 1} · hash ${hex2(p.channelHash).toUpperCase()}`, key]);
  });
  let found: [string, Proto, number] | null = null;
  const body = b.subarray(16);
  for (const [chan, key] of tries) {
    const plain = Aes128.ctr(key, nonce, body);
    // a wrong key gives noise: only a message that reads cleanly, on a port that exists, counts
    const data = Proto.parse(plain);
    const port = data?.int(1) ?? null;
    if (data && port !== null && port > 0n && port < 512n && PORTNUM[Number(port)] !== undefined && data.bytes(2) !== null) {
      found = [chan, data, Number(port)]; break;
    }
  }
  if (!found) return p;
  const [chan, data, port] = found;
  p.portnum = port;
  p.fields.push(['CHANNEL', chan]);
  const payload = data.bytes(2) ?? new Uint8Array(0);
  const rid = data.int(6);
  if (rid !== null) p.fields.push(['REPLY TO', hex8(Number(rid & 0xffffffffn))]);
  decode(p, port, payload);
  return p;
}

const model = (v: bigint | null): string | null => (v === null ? null : HWMODEL[Number(v)] ?? `MODEL_${v}`);

export function decode(p: MeshtasticPacket, port: number, b: Uint8Array): void {
  switch (port) {
    case 1: {   // TEXT_MESSAGE_APP
      p.text = utf8OrNull(b) ?? hexBytes(b);
      p.fields.push(['TEXT', p.text]);
      break;
    }
    case 3: {   // POSITION_APP
      const m = Proto.parse(b); if (!m) return;
      const la = m.sint32(1), lo = m.sint32(2);
      if (la !== null && lo !== null && (la !== 0 || lo !== 0)) { p.lat = la / 1e7; p.lon = lo / 1e7; }
      const a = m.int(3); if (a !== null) p.altitude = Number(BigInt.asIntN(32, a));
      if (p.lat !== null && p.lon !== null) p.fields.push(['POSITION', `${fixed(p.lat, 5)}, ${fixed(p.lon, 5)}`]);
      if (p.altitude !== null) p.fields.push(['ALTITUDE', `${p.altitude} m`]);
      const t = m.int(4); if (t !== null) p.fields.push(['GPS TIME', dateDescription(Number(t))]);
      const s = m.int(15); if (s !== null) p.fields.push(['SPEED', `${s} m/s`]);
      const sat = m.int(19); if (sat !== null) p.fields.push(['SATELLITES', `${sat}`]);
      const pb = m.int(23); if (pb !== null) p.fields.push(['PRECISION', `${pb} bits`]);
      break;
    }
    case 4: {   // NODEINFO_APP
      const m = Proto.parse(b); if (!m) return;
      p.longName = m.string(2); p.shortName = m.string(3);
      p.hwModel = model(m.int(5));
      const r = m.int(7); p.role = r === null ? 'CLIENT' : ROLE[Number(r)] ?? `ROLE_${r}`;
      const id = m.string(1); if (id !== null) p.fields.push(['NODE ID', id]);
      if (p.longName !== null) p.fields.push(['NAME', p.longName]);
      if (p.shortName !== null) p.fields.push(['SHORT', p.shortName]);
      if (p.hwModel !== null) p.fields.push(['HARDWARE', p.hwModel]);
      if (p.role !== null) p.fields.push(['ROLE', p.role]);
      if (m.int(6) === 1n) p.fields.push(['LICENSED', 'ham']);
      const k = m.bytes(8); if (k && k.length > 0) p.fields.push(['PUBLIC KEY', hexBytes(k, 0, 8) + '…']);
      break;
    }
    case 67: {  // TELEMETRY_APP
      const m = Proto.parse(b); if (!m) return;
      const dmb = m.bytes(2), dm = dmb ? Proto.parse(dmb) : null;
      if (dm) {
        p.battery = dm.num(1); p.voltage = dm.float(2); p.channelUtil = dm.float(3); p.airUtilTx = dm.float(4); p.uptime = dm.num(5);
        if (p.battery !== null) p.fields.push(['BATTERY', p.battery > 100 ? 'powered' : `${p.battery}%`]);
        let v = fmtF(p.voltage, ' V', 2); if (v !== null) p.fields.push(['VOLTAGE', v]);
        v = fmtF(p.channelUtil, '%'); if (v !== null) p.fields.push(['CHANNEL USE', v]);
        v = fmtF(p.airUtilTx, '%', 2); if (v !== null) p.fields.push(['AIRTIME TX', v]);
        const u = p.uptime; if (u !== null) p.fields.push(['UPTIME', `${Math.floor(u / 86400)}d ${Math.floor(u / 3600) % 24}h ${Math.floor(u / 60) % 60}m`]);
      }
      const emb = m.bytes(3), em = emb ? Proto.parse(emb) : null;
      if (em) {
        let v = fmtF(em.float(1), ' °C'); if (v !== null) p.fields.push(['TEMPERATURE', v]);
        v = fmtF(em.float(2), ' %'); if (v !== null) p.fields.push(['HUMIDITY', v]);
        v = fmtF(em.float(3), ' hPa'); if (v !== null) p.fields.push(['PRESSURE', v]);
        v = fmtF(em.float(9), ' lx', 0); if (v !== null) p.fields.push(['LIGHT', v]);
        v = fmtF(em.float(14), ' m/s'); if (v !== null) p.fields.push(['WIND', v]);
      }
      if (m.bytes(5) !== null) p.fields.push(['POWER', 'power metrics']);
      const lsb = m.bytes(6), ls = lsb ? Proto.parse(lsb) : null;
      if (ls) {
        let v = ls.int(5); if (v !== null) p.fields.push(['NODES ONLINE', `${v}`]);
        v = ls.int(3); if (v !== null) p.fields.push(['PACKETS TX', `${v}`]);
        v = ls.int(4); if (v !== null) p.fields.push(['PACKETS RX', `${v}`]);
      }
      break;
    }
    case 70: {  // TRACEROUTE_APP
      const m = Proto.parse(b); if (!m) return;
      const hops: string[] = [];
      for (const v of m.all(1)) if ('int' in v) hops.push(nodeName(Number(v.int & 0xffffffffn)));
      p.fields.push(['ROUTE', hops.length === 0 ? 'direct' : hops.join(' → ')]);
      break;
    }
    case 71: {  // NEIGHBORINFO_APP
      const m = Proto.parse(b); if (!m) return;
      const ns: string[] = [];
      for (const v of m.all(4)) {
        if (!('bytes' in v)) continue;
        const n = Proto.parse(v.bytes), id = n?.int(1) ?? null;
        if (!n || id === null) continue;
        const snr = n.float(2);
        ns.push(nodeName(Number(id & 0xffffffffn)) + (snr === null ? '' : ` ${fixed(snr, 1)} dB`));
      }
      p.fields.push(['NEIGHBORS', ns.length === 0 ? 'none' : ns.join(', ')]);
      break;
    }
    case 73: {  // MAP_REPORT_APP
      const m = Proto.parse(b); if (!m) return;
      p.longName = m.string(1); p.shortName = m.string(2);
      p.hwModel = model(m.int(4));
      const la = m.sint32(9), lo = m.sint32(10);
      if (la !== null && lo !== null && (la !== 0 || lo !== 0)) { p.lat = la / 1e7; p.lon = lo / 1e7; }
      if (p.longName !== null) p.fields.push(['NAME', p.longName]);
      const fw = m.string(5); if (fw !== null) p.fields.push(['FIRMWARE', fw]);
      const v = m.int(13); if (v !== null) p.fields.push(['NODES ONLINE', `${v}`]);
      break;
    }
    case 5: {   // ROUTING_APP
      const m = Proto.parse(b), e = m?.int(3) ?? null;
      if (e !== null) p.fields.push(['ROUTING', e === 0n ? 'ack' : `error ${e}`]);
      break;
    }
    default:
      p.fields.push(['PAYLOAD', hexBytes(b, 0, 32)]);
  }
}

export const Meshtastic = { parse, decode, channelHash, defaultKey, simpleKeys, knownChannels, presetNames, nodeName, portName };
