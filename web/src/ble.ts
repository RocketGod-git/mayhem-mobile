/**
 * BLE devices: one record per advertiser, built from the raw advertising PDUs the receiver hands over.
 *
 * parseAdv() reads a PDU (header, length, AdvA, AD structures) into its fields; classify() names the maker from the
 * Bluetooth SIG company identifier and the kind of device from what it advertises (Apple Continuity types, the
 * tracker services, Eddystone, Fast Pair, the GAP appearance, and last of all the name); BleTracker keeps one device
 * per address with its signal history, packet count and raw advertisements, and raises a tracker alert when a
 * tracker-type device stays with you for 20 minutes or is still there after you have moved.
 *
 * Twin ports: core/apps/BleDevices.kt and core/apps/BleDevices.swift (same names, same constants).
 */

const PDU_TYPES = ['ADV_IND', 'ADV_DIRECT_IND', 'ADV_NONCONN_IND', 'SCAN_REQ', 'SCAN_RSP', 'CONNECT_REQ', 'ADV_SCAN_IND'];

/** One service-data AD structure: its 16-bit UUID and the bytes after it. */
export interface BleSvcData { uuid: number; data: number[] }
/** One advertisement, as read off the air. */
export interface BleAdv {
  pduType: string; mac: string; random: boolean; db: number; ch: number;
  /** Complete or shortened local name ('' when none). */
  name: string;
  /** Flags AD (-1 when none). */
  flags: number;
  /** Company identifier of the manufacturer-specific data (-1 when none) and the bytes after it. */
  mfr: number; mfrData: number[];
  uuids16: number[]; svc: BleSvcData[];
  /** TX power level in dBm (null when not sent). */
  txPower: number | null;
  /** GAP appearance (-1 when not sent). */
  appearance: number;
  /** The whole PDU in hex, header first. */
  raw: string;
}

const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');

/**
 * Reads one advertising PDU: byte 0 the header (type in the low nibble, TxAdd in bit 6), byte 1 the payload length,
 * bytes 2..7 the advertiser's address (least significant byte first), then the AD structures for the PDU types that
 * carry them. Returns null for a PDU too short to hold an address.
 */
export function parseAdv(pdu: ArrayLike<number>, db: number, ch: number): BleAdv | null {
  if (pdu.length < 8) return null;
  const p = Array.from(pdu, v => v & 0xFF);
  const type = p[0] & 0x0F;
  const len = Math.min(p[1] & 0x3F, p.length - 2);
  const end = 2 + len;
  const a: BleAdv = {
    pduType: PDU_TYPES[type] ?? `PDU${type}`, mac: [7, 6, 5, 4, 3, 2].map(i => hex2(p[i])).join(':'), random: (p[0] & 0x40) !== 0,
    db, ch, name: '', flags: -1, mfr: -1, mfrData: [], uuids16: [], svc: [], txPower: null, appearance: -1,
    raw: p.slice(0, end).map(hex2).join(''),
  };
  if (type !== 0 && type !== 2 && type !== 4 && type !== 6) return a;
  let q = 8;
  while (q < end) {
    const l = p[q];
    if (l === 0 || q + 1 + l > end) break;
    const ad = p[q + 1], ds = q + 2, dl = l - 1, d = p.slice(ds, ds + dl);
    switch (ad) {
      case 0x01: if (dl >= 1) a.flags = d[0]; break;
      case 0x02: case 0x03: for (let i = 0; i + 1 < dl; i += 2) a.uuids16.push(d[i] | (d[i + 1] << 8)); break;
      case 0x08: case 0x09: a.name = String.fromCharCode(...d.filter(c => c >= 0x20 && c < 0x7F)); break;
      case 0x0A: if (dl >= 1) a.txPower = (d[0] << 24) >> 24; break;
      case 0x16: if (dl >= 2) a.svc.push({ uuid: d[0] | (d[1] << 8), data: d.slice(2) }); break;
      case 0x19: if (dl >= 2) a.appearance = d[0] | (d[1] << 8); break;
      case 0xFF: if (dl >= 2) { a.mfr = d[0] | (d[1] << 8); a.mfrData = d.slice(2); } break;
    }
    q += 1 + l;
  }
  return a;
}

/** Bluetooth SIG company identifiers seen most often in the wild. */
const COMPANIES: [number, string][] = [
  [0x0000, 'Ericsson'], [0x0002, 'Intel'], [0x0006, 'Microsoft'], [0x000A, 'Qualcomm'], [0x000D, 'Texas Instruments'],
  [0x000F, 'Broadcom'], [0x001D, 'Qualcomm'], [0x0046, 'MediaTek'], [0x004C, 'Apple'], [0x0057, 'Harman'],
  [0x0059, 'Nordic Semiconductor'], [0x005D, 'Realtek'], [0x0075, 'Samsung'], [0x0078, 'Nike'], [0x0087, 'Garmin'],
  [0x009E, 'Bose'], [0x00C4, 'LG Electronics'], [0x00E0, 'Google'], [0x0131, 'Cypress'], [0x0157, 'Huami (Amazfit)'],
  [0x0171, 'Amazon'], [0x01DA, 'Logitech'], [0x027D, 'Huawei'], [0x02E5, 'Espressif'], [0x038F, 'Xiaomi'],
  [0x0499, 'Ruuvi'], [0x05A7, 'Sonos'],
];
/** The maker for a company identifier ('' when unknown). */
export function companyName(id: number): string {
  for (const [k, v] of COMPANIES) if (k === id) return v;
  return '';
}

/** Service UUIDs that name their maker on their own. */
const SERVICE_MAKERS: [number, string][] = [
  [0xFEAA, 'Google'], [0xFE2C, 'Google'], [0xFD5A, 'Samsung'], [0xFEED, 'Tile'], [0xFEEC, 'Tile'], [0xFD84, 'Tile'],
  [0xFE9F, 'Google'], [0xFD6F, 'Exposure Notification'],
];

export type BleKind = 'airtag' | 'findmy' | 'tile' | 'smarttag' | 'findhub' | 'phone' | 'computer' | 'earbuds' | 'audio'
  | 'watch' | 'ibeacon' | 'eddystone' | 'hid' | 'tv' | 'device';
/** What each kind is called on a card. */
export const KIND_LABEL: Record<BleKind, string> = {
  airtag: 'AirTag / Find My', findmy: 'Find My', tile: 'Tile', smarttag: 'SmartTag', findhub: 'Find Hub tag', phone: 'Phone',
  computer: 'Computer', earbuds: 'Earbuds', audio: 'Speaker', watch: 'Watch', ibeacon: 'iBeacon', eddystone: 'Eddystone',
  hid: 'Keyboard / mouse', tv: 'TV / AirPlay', device: 'Device',
};
/** The kinds that exist to be carried and found: the ones a tracker alert is raised for. */
export const TRACKER_KINDS: BleKind[] = ['airtag', 'findmy', 'tile', 'smarttag', 'findhub'];

export interface BleClass { maker: string; kind: BleKind; tracker: boolean; /** One line on what gave it away. */ why: string; extra: { name: string; value: string }[] }

const EDDY_SCHEME = ['http://www.', 'https://www.', 'http://', 'https://'];
const EDDY_TLD = ['.com/', '.org/', '.edu/', '.net/', '.info/', '.biz/', '.gov/', '.com', '.org', '.edu', '.net', '.info', '.biz', '.gov'];
/** An Eddystone-URL frame's URL (frame type 0x10: tx power, scheme, encoded text). */
export function eddystoneUrl(d: number[]): string {
  if (d.length < 3 || d[0] !== 0x10) return '';
  let s = EDDY_SCHEME[d[2]] ?? '';
  for (let i = 3; i < d.length; i++) s += d[i] < EDDY_TLD.length ? EDDY_TLD[d[i]] : String.fromCharCode(d[i]);
  return s;
}
/** GAP appearance category (the value's top 10 bits) to a kind, or null when it says nothing useful. */
function appearanceKind(app: number): BleKind | null {
  switch (app >> 6) {
    case 1: return 'phone';
    case 2: return 'computer';
    case 3: return 'watch';
    case 15: return 'hid';
    case 33: return 'audio';
    case 37: return 'earbuds';
    default: return null;
  }
}
/** Last resort: what the name says. */
function nameKind(name: string): BleKind | null {
  const n = name.toLowerCase();
  if (!n) return null;
  if (/airpods|buds|beats|earbud|headphone|headset|wh-1000|wf-1000|jabra/.test(n)) return 'earbuds';
  if (/watch|band \d|fitbit|forerunner|fenix|venu|amazfit|mi band|whoop/.test(n)) return 'watch';
  if (/iphone|pixel|galaxy|oneplus|moto/.test(n)) return 'phone';
  if (/macbook|imac|laptop|desktop|-pc\b|thinkpad/.test(n)) return 'computer';
  if (/keyboard|mouse|mx master|trackpad/.test(n)) return 'hid';
  if (/\btv\b|roku|chromecast|fire tv|bravia/.test(n)) return 'tv';
  if (/speaker|soundbar|sonos|jbl|bose|ue boom/.test(n)) return 'audio';
  if (/^tile\b/.test(n)) return 'tile';
  return null;
}

/** The maker and kind of an advertiser, from everything in one advertisement. */
export function classify(a: BleAdv): BleClass {
  const extra: { name: string; value: string }[] = [];
  let maker = a.mfr >= 0 ? companyName(a.mfr) : '';
  if (!maker) for (const s of [...a.svc.map(x => x.uuid), ...a.uuids16]) { const m = SERVICE_MAKERS.find(([u]) => u === s); if (m) { maker = m[1]; break; } }
  const make = (kind: BleKind, why: string): BleClass => ({ maker, kind, tracker: TRACKER_KINDS.includes(kind), why, extra });
  // Apple Continuity: the first byte after the company ID is the message type
  if (a.mfr === 0x004C && a.mfrData.length >= 2) {
    const t = a.mfrData[0], l = a.mfrData[1], d = a.mfrData;
    switch (t) {
      case 0x12:
        extra.push({ name: 'Find My status', value: `0x${hex2(d[2] ?? 0)}` });
        return l >= 0x19 ? make('airtag', 'Find My, away from its owner (full key)') : make('findmy', 'Find My, near its owner');
      case 0x02:
        if (l === 0x15 && d.length >= 23) {
          const u = d.slice(2, 18).map(hex2).join('');
          extra.push({ name: 'UUID', value: `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}` });
          extra.push({ name: 'Major', value: String((d[18] << 8) | d[19]) }, { name: 'Minor', value: String((d[20] << 8) | d[21]) });
          extra.push({ name: 'Power at 1 m', value: `${(d[22] << 24) >> 24} dBm` });
          return make('ibeacon', 'iBeacon');
        }
        break;
      case 0x07: return make('earbuds', 'Apple proximity pairing (AirPods / Beats)');
      case 0x10: return make('phone', 'Apple Nearby Info (iPhone, iPad or Mac)');
      case 0x0C: return make('phone', 'Apple Handoff');
      case 0x0F: return make('phone', 'Apple Nearby Action');
      case 0x05: return make('phone', 'AirDrop');
      case 0x09: return make('tv', 'AirPlay target');
    }
  }
  if (a.mfr === 0x0006 && a.mfrData.length >= 1) {
    if (a.mfrData[0] === 0x01) return make('computer', 'Microsoft CDP beacon (Windows)');
    if (a.mfrData[0] === 0x03) return make(appearanceKind(a.appearance) ?? 'hid', 'Microsoft Swift Pair');
  }
  for (const s of a.svc) {
    if (s.uuid === 0xFEAA && s.data.length >= 1) {
      const f = s.data[0];
      if (f === 0x40 || f === 0x41) return make('findhub', 'Google Find Hub network');
      if (f === 0x10) { const url = eddystoneUrl(s.data); if (url) extra.push({ name: 'URL', value: url }); return make('eddystone', 'Eddystone-URL'); }
      if (f === 0x00 && s.data.length >= 18) { extra.push({ name: 'Namespace', value: s.data.slice(2, 12).map(hex2).join('') }, { name: 'Instance', value: s.data.slice(12, 18).map(hex2).join('') }); return make('eddystone', 'Eddystone-UID'); }
      if (f === 0x20) return make('eddystone', 'Eddystone-TLM');
      if (f === 0x30) return make('eddystone', 'Eddystone-EID');
    }
    if (s.uuid === 0xFD5A) return make('smarttag', 'Samsung SmartTag');
    if (s.uuid === 0xFE2C) return make(appearanceKind(a.appearance) ?? 'earbuds', 'Google Fast Pair');
  }
  const all16 = [...a.uuids16, ...a.svc.map(s => s.uuid)];
  if (all16.some(u => u === 0xFEED || u === 0xFEEC || u === 0xFD84)) return make('tile', 'Tile service');
  if (all16.includes(0xFD5A)) return make('smarttag', 'Samsung SmartTag');
  const ak = appearanceKind(a.appearance);
  if (ak) return make(ak, `appearance 0x${hex4(a.appearance)}`);
  const nk = nameKind(a.name);
  if (nk) return make(nk, 'by its name');
  return make('device', maker ? 'manufacturer data' : 'nothing recognizable');
}

/** A tracker-type device seen this long is worth a look. */
export const TRACKER_ALERT_MS = 20 * 60_000;
/** Or one still heard after you have moved this far. */
export const TRACKER_MOVE_M = 500;
/** How many signal readings and raw advertisements each device keeps. */
export const RSSI_KEEP = 40, HISTORY_KEEP = 60;

export interface BleHeard { ms: number; ch: number; db: number; pduType: string; raw: string }
export interface BleDevice {
  mac: string; random: boolean; name: string; maker: string; kind: BleKind; tracker: boolean; why: string;
  firstMs: number; lastMs: number; count: number;
  rssi: number[]; history: BleHeard[];
  /** Every field from the latest advertisement (and the name, which may come in a scan response). */
  fields: { name: string; value: string }[];
  /** Where you were when it was first and last heard (null without a position). */
  firstPos: { lat: number; lon: number } | null; lastPos: { lat: number; lon: number } | null;
  /** The farthest you have been from firstPos while still hearing it, in meters. */
  movedM: number;
  /** Why it is flagged ('' when it is not). */
  alert: string;
}

/** Great-circle distance in meters. */
export function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** The tracker alert for a device as of now ('' when none). */
export function trackerAlert(d: BleDevice): string {
  if (!d.tracker) return '';
  const mins = Math.floor((d.lastMs - d.firstMs) / 60_000);
  if (d.movedM >= TRACKER_MOVE_M) return `${KIND_LABEL[d.kind].toUpperCase()} MOVING WITH YOU · ${(d.movedM / 1000).toFixed(1)} km · ${mins} min`;
  if (d.lastMs - d.firstMs >= TRACKER_ALERT_MS) return `${KIND_LABEL[d.kind].toUpperCase()} NEAR YOU FOR ${mins} MIN`;
  return '';
}

/** One device per advertiser address. */
export class BleTracker {
  readonly devices = new Map<string, BleDevice>();
  /** Adds an advertisement heard at nowMs (pos: where you are, when known); returns its device. */
  add(a: BleAdv, nowMs: number, pos: { lat: number; lon: number } | null = null): BleDevice {
    const c = classify(a);
    let d = this.devices.get(a.mac);
    if (!d) {
      d = { mac: a.mac, random: a.random, name: '', maker: '', kind: 'device', tracker: false, why: '', firstMs: nowMs, lastMs: nowMs, count: 0,
        rssi: [], history: [], fields: [], firstPos: pos, lastPos: pos, movedM: 0, alert: '' };
      this.devices.set(a.mac, d);
    }
    d.count++; d.lastMs = nowMs;
    if (a.name) d.name = a.name;
    // a scan response or a bare advertisement says less than the one before it: keep what was learned
    if (c.maker) d.maker = c.maker;
    if (c.kind !== 'device' || d.kind === 'device') { d.kind = c.kind; d.tracker = c.tracker; d.why = c.why; }
    d.rssi.push(Math.round(a.db)); if (d.rssi.length > RSSI_KEEP) d.rssi.shift();
    d.history.push({ ms: nowMs, ch: a.ch, db: a.db, pduType: a.pduType, raw: a.raw }); if (d.history.length > HISTORY_KEEP) d.history.shift();
    if (pos) {
      if (!d.firstPos) d.firstPos = pos;
      d.lastPos = pos;
      d.movedM = Math.max(d.movedM, distM(d.firstPos, pos));
    }
    d.fields = advFields(a, c, d);
    d.alert = trackerAlert(d);
    return d;
  }
  /** Devices in a steady order (cards do not jump about as packets arrive): the ones with an alert first, then in the
   *  order they were first heard. */
  list(): BleDevice[] {
    return [...this.devices.values()].sort((x, y) => (y.alert ? 1 : 0) - (x.alert ? 1 : 0) || x.firstMs - y.firstMs || (x.mac < y.mac ? -1 : 1));
  }
  clear(): void { this.devices.clear(); }
}

/** Every field worth showing for one device. */
function advFields(a: BleAdv, c: BleClass, d: BleDevice): { name: string; value: string }[] {
  const f: { name: string; value: string }[] = [];
  f.push({ name: 'Address', value: `${a.mac} · ${a.random ? 'random' : 'public'}` });
  if (d.name) f.push({ name: 'Name', value: d.name });
  f.push({ name: 'Maker', value: d.maker || 'unknown' });
  f.push({ name: 'Type', value: `${KIND_LABEL[d.kind]} · ${d.why}` });
  f.push({ name: 'Last PDU', value: `${a.pduType} · channel ${a.ch}` });
  f.push({ name: 'Signal', value: `${Math.round(a.db)} dB` });
  if (a.flags >= 0) f.push({ name: 'Flags', value: `0x${hex2(a.flags)}${a.flags & 0x04 ? ' · BLE only' : ''}${a.flags & 0x02 ? ' · discoverable' : ''}` });
  if (a.txPower !== null) f.push({ name: 'TX power', value: `${a.txPower} dBm` });
  if (a.appearance >= 0) f.push({ name: 'Appearance', value: `0x${hex4(a.appearance)}` });
  if (a.mfr >= 0) f.push({ name: 'Manufacturer data', value: `0x${hex4(a.mfr)}${companyName(a.mfr) ? ` ${companyName(a.mfr)}` : ''} · ${a.mfrData.map(hex2).join(' ')}` });
  if (a.uuids16.length) f.push({ name: 'Services', value: a.uuids16.map(u => `0x${hex4(u)}`).join(' ') });
  for (const s of a.svc) f.push({ name: `Service data 0x${hex4(s.uuid)}`, value: s.data.map(hex2).join(' ') || '—' });
  f.push(...c.extra);
  f.push({ name: 'Packets', value: String(d.count) });
  return f;
}
