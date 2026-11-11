/**
 * MeshCore over the air, from its published packet format. Port of core/lora/MeshCore.swift: the header byte (route
 * type, payload type, version), transport codes, the path, then the payload. Adverts are signed but not encrypted,
 * so every node's name, type and position can be read; group text on a channel whose key is known (the public
 * channel) is AES-128 ECB with a 2-byte HMAC-SHA256, which is checked before anything is believed.
 */
import { Aes128 } from './aes128.js';
import { Sha256 } from './sha256.js';
import { dateDescription, fixed, hex2, hexBytes, utf8Lossy, type Field } from './meshtastic.js';

export interface MeshCorePacket {
  route: number; type: number; version: number;
  transport: number[];
  hashSize: number;
  path: Uint8Array[];
  payload: Uint8Array;
  fields: Field[];
  /** A node's identity (its public key, or the first bytes of it) when the packet carries one. */
  nodeKey: Uint8Array | null;
  name: string | null; nodeType: string | null;
  lat: number | null; lon: number | null;
  text: string | null; channel: string | null;
  advertTime: number | null;
  typeName: string;
}

export const ROUTE_NAMES = ['transport flood', 'flood', 'direct', 'transport direct'];
export const TYPE_NAMES = ['REQUEST', 'RESPONSE', 'DIRECT MESSAGE', 'ACK', 'ADVERT', 'GROUP TEXT', 'GROUP DATA',
  'ANON REQUEST', 'PATH', 'TRACE', 'MULTIPART', 'CONTROL', 'TYPE 12', 'TYPE 13', 'TYPE 14', 'RAW CUSTOM'];

/** Group channels whose key is public: the default public channel, and hashtag channels (key = the first 16 bytes
 *  of SHA-256 of the name with its '#'). */
export const publicKey = Uint8Array.from([0x8b, 0x33, 0x87, 0xe9, 0xc5, 0xcd, 0xea, 0x6a, 0xc9, 0xe5, 0xed, 0xba, 0xa1, 0x15, 0xcd, 0x72]);
export const HASHTAGS = ['#test', '#general', '#public', '#meshcore', '#emergency', '#weather', '#socal', '#la', '#ventura', '#california', '#usa', '#ping', '#bot', '#repeaters',
  '#socalmesh', '#socal-mesh', '#lamesh', '#losangeles', '#mesh', '#ham', '#chat', '#news', '#help', '#sos', '#offgrid', '#oc',
  '#orangecounty', '#sandiego', '#sd', '#inlandempire', '#ie', '#sfv', '#valley', '#simivalley', '#moorpark', '#thousandoaks',
  '#oxnard', '#santaclarita', '#pasadena', '#longbeach', '#hikers', '#radio', '#tech', '#random', '#traffic', '#fire', '#quake'];

export const MC_CHANNELS: { name: string; key: Uint8Array; hash: number }[] = (() => {
  const c = [{ name: 'Public', key: publicKey, hash: Sha256.hash(publicKey)[0] }];
  for (const h of HASHTAGS) { const k = Sha256.hash(new TextEncoder().encode(h)).slice(0, 16); c.push({ name: h, key: k, hash: Sha256.hash(k)[0] }); }
  return c;
})();

const u32 = (b: Uint8Array, i: number): number => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const hex4 = (v: number): string => v.toString(16).padStart(4, '0');
/** `.trimmingCharacters(in: .controlCharacters)`: Unicode Cc and Cf at either end. */
const trimControl = (s: string): string => s.replace(/^[\p{Cc}\p{Cf}]+|[\p{Cc}\p{Cf}]+$/gu, '');

export function parse(b: Uint8Array): MeshCorePacket | null {
  if (b.length < 2) return null;
  const h = b[0];
  const route = h & 3, type = (h >> 2) & 0x0f, version = h >> 6;
  if (version !== 0) return null;
  let i = 1;
  let transport: number[] = [];
  if (route === 0 || route === 3) {
    if (b.length < i + 4) return null;
    transport = [b[i] | (b[i + 1] << 8), b[i + 2] | (b[i + 3] << 8)]; i += 4;
  }
  if (i >= b.length) return null;
  const pl = b[i]; i++;
  const hops = pl & 0x3f, hs = (pl >> 6) + 1;
  if (hs === 4 || i + hops * hs > b.length || hops * hs > 64) return null;
  const path: Uint8Array[] = [];
  for (let k = 0; k < hops; k++) path.push(b.slice(i + k * hs, i + (k + 1) * hs));
  i += hops * hs;
  const p: MeshCorePacket = {
    route, type, version, transport, hashSize: hs, path, payload: b.slice(i), fields: [],
    nodeKey: null, name: null, nodeType: null, lat: null, lon: null, text: null, channel: null, advertTime: null,
    typeName: TYPE_NAMES[type],
  };
  p.fields.push(['ROUTE', ROUTE_NAMES[route] + (hops === 0 ? ', no hops yet' : `, ${hops} hop${hops === 1 ? '' : 's'}`)]);
  if (path.length > 0) p.fields.push(['PATH', path.map(x => hexBytes(x)).join(' → ')]);
  if (transport.length > 0) p.fields.push(['TRANSPORT', `${hex4(transport[0])} ${hex4(transport[1])}`]);
  if (!payloadFits(p)) return null;
  return p;
}

/** Reads the payload by type; false when it can't be one of that type (a frame that only looked like MeshCore). */
function payloadFits(p: MeshCorePacket): boolean {
  const b = p.payload;
  switch (p.type) {
    case 4: {   // ADVERT: public key 32, timestamp 4, signature 64, app data
      if (b.length < 101) return false;
      p.nodeKey = b.slice(0, 32);
      p.advertTime = u32(b, 32);
      const fl = b[100];
      let j = 101;
      const types: Record<number, string> = { 1: 'chat', 2: 'repeater', 3: 'room server', 4: 'sensor' };
      p.nodeType = types[fl & 0x0f] ?? `type ${fl & 0x0f}`;
      if (fl & 0x10) {
        if (b.length < j + 8) return false;
        const la = u32(b, j) | 0, lo = u32(b, j + 4) | 0; j += 8;
        if ((la !== 0 || lo !== 0) && Math.abs(la) <= 90_000_000 && Math.abs(lo) <= 180_000_000) { p.lat = la / 1e6; p.lon = lo / 1e6; }
      }
      if (fl & 0x20) j += 2;
      if (fl & 0x40) j += 2;
      if ((fl & 0x80) && j < b.length) p.name = trimControl(utf8Lossy(b.subarray(j)));
      p.fields.push(['NODE', p.nodeType]);
      if (p.name !== null) p.fields.push(['NAME', p.name]);
      if (p.lat !== null && p.lon !== null) p.fields.push(['POSITION', `${fixed(p.lat, 5)}, ${fixed(p.lon, 5)}`]);
      p.fields.push(['PUBLIC KEY', hexBytes(b, 0, 32)]);
      p.fields.push(['ADVERT TIME', dateDescription(p.advertTime)]);
      break;
    }
    case 5: case 6: {   // GROUP TEXT / DATA: channel hash 1, MAC 2, ciphertext
      if (!(b.length >= 3 + 16 && (b.length - 3) % 16 === 0)) return b.length >= 3;
      const ct = b.slice(3);
      p.fields.push(['CHANNEL HASH', hex2(b[0])]);
      for (const c of MC_CHANNELS) {
        if (c.hash !== b[0]) continue;
        const mk = new Uint8Array(32); mk.set(c.key);
        const mac = Sha256.hmac(mk, ct);
        if (mac[0] !== b[1] || mac[1] !== b[2]) continue;
        const plain = Aes128.ecbDecrypt(c.key, ct);
        p.channel = c.name;
        p.fields.push(['CHANNEL', c.name]);
        p.fields.push(['SENT', dateDescription(u32(plain, 0))]);
        if (p.type === 5) {
          let end = plain.length; while (end > 5 && plain[end - 1] === 0) end--;
          p.text = utf8Lossy(plain.subarray(5, end));
          p.fields.push(['TEXT', p.text]);
          const k = p.text.indexOf(': ');
          if (k >= 0) p.name = p.text.slice(0, k);
        } else {
          p.fields.push(['DATA TYPE', hex2(plain[4]) + hex2(plain[5])]);
          p.fields.push(['DATA', hexBytes(plain, 7, 7 + plain[6])]);
        }
        break;
      }
      if (p.channel === null) p.fields.push(['TEXT', 'encrypted (private channel)']);
      break;
    }
    case 0: case 1: case 2: case 8:   // REQ / RESPONSE / TXT_MSG / PATH: dest hash, src hash, MAC 2, ciphertext
      if (b.length < 4) return false;
      p.fields.push(['FROM', hex2(b[1])]); p.fields.push(['TO', hex2(b[0])]);
      p.fields.push(['CONTENT', `end-to-end encrypted, ${b.length - 4} bytes`]);
      break;
    case 3:   // ACK: CRC 4
      if (b.length < 4) return false;
      p.fields.push(['ACK', hexBytes(b, 0, 4)]);
      break;
    case 7:   // ANON_REQ: dest hash, sender key 32, MAC 2, ciphertext
      if (b.length < 35) return false;
      p.nodeKey = b.slice(1, 33);
      p.fields.push(['TO', hex2(b[0])]); p.fields.push(['FROM KEY', hexBytes(b, 1, 33)]);
      break;
    case 9:   // TRACE: tag 4, auth 4, flags 1, path hashes
      if (b.length < 9) return false;
      p.fields.push(['TAG', hexBytes(b, 0, 4)]);
      if (b.length > 9) p.fields.push(['TRACE PATH', Array.from(b.subarray(9), hex2).join(' → ')]);
      break;
    case 11: {  // CONTROL: flags (sub-type in the top nibble)
      if (b.length === 0) return false;
      const sub = b[0] >> 4;
      p.fields.push(['CONTROL', sub === 8 ? 'discover request' : sub === 9 ? 'discover response' : `sub-type ${sub}`]);
      if (sub === 9 && b.length >= 14) {
        p.fields.push(['SNR', `${fixed(((b[1] << 24) >> 24) / 4, 1)} dB`]);
        p.nodeKey = b.slice(6);
      }
      break;
    }
    case 12: case 13: case 14: return false;
    default:
      p.fields.push(['PAYLOAD', hexBytes(b, 0, 48)]);
  }
  return true;
}

export const MeshCore = { parse, publicKey, channels: MC_CHANNELS, hashtags: HASHTAGS };
