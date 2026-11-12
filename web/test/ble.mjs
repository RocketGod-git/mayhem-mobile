/**
 * BLE devices (BleDevicesTest.kt / BleDevicesTest.swift): advertising PDUs built byte by byte are read back field by
 * field, each maker and device type is recognized from what it advertises, and the tracker keeps one device per
 * address and raises its alert after 20 minutes or a move.
 */
import { parseAdv, classify, companyName, eddystoneUrl, BleTracker, distM, TRACKER_ALERT_MS, RSSI_KEEP, HISTORY_KEEP } from '../dist/ble.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(a === b, what, `got ${a}, want ${b}`);
console.log('BLE devices: advertisements, makers, device types and the tracker alert');

/** A PDU: header (type, TxAdd), length, the address (written MSB first here, sent LSB first), AD structures. */
function pdu(type, mac, ads, random = true) {
  const addr = mac.split(':').map(h => parseInt(h, 16)).reverse();
  const body = [...addr, ...ads.flatMap(([t, d]) => [d.length + 1, t, ...d])];
  return [type | (random ? 0x40 : 0), body.length, ...body];
}
const mfr = (id, d) => [0xFF, [id & 0xFF, id >> 8, ...d]];
const svc = (u, d) => [0x16, [u & 0xFF, u >> 8, ...d]];
const uuids = (...us) => [0x03, us.flatMap(u => [u & 0xFF, u >> 8])];
const name = (s) => [0x09, [...s].map(c => c.charCodeAt(0))];
const flags = (f) => [0x01, [f]];
const appear = (v) => [0x19, [v & 0xFF, v >> 8]];
const zeros = (n) => new Array(n).fill(0);
const kindOf = (p) => classify(parseAdv(p, -60, 37));

// ---- parsing ----
{
  const a = parseAdv(pdu(0, 'C0:FF:EE:12:34:56', [flags(0x06), name('Pixel 9'), [0x0A, [0xF4]], appear(0x0040), uuids(0x180F, 0xFE2C)], false), -51.6, 38);
  eq(a.pduType, 'ADV_IND', 'pdu type');
  eq(a.mac, 'C0:FF:EE:12:34:56', 'address read LSB first');
  eq(a.random, false, 'public address');
  eq(a.name, 'Pixel 9', 'name');
  eq(a.flags, 0x06, 'flags');
  eq(a.txPower, -12, 'tx power is signed');
  eq(a.appearance, 0x0040, 'appearance');
  eq(a.uuids16.join(','), [0x180F, 0xFE2C].join(','), 'service uuids');
  eq(a.ch, 38, 'channel kept');
  eq(a.raw.slice(0, 4), '00' + (a.raw.length / 2 - 2).toString(16).toUpperCase().padStart(2, '0'), 'raw hex starts with header and length');
  const n = parseAdv(pdu(2, '11:22:33:44:55:66', [mfr(0x004C, [0x12, 0x02, 0x00, 0x01])]), -70, 37);
  eq(n.pduType, 'ADV_NONCONN_IND', 'nonconnectable');
  eq(n.random, true, 'random address');
  eq(n.mfr, 0x004C, 'company id');
  eq(n.mfrData.join(','), '18,2,0,1', 'manufacturer data after the company id');
  eq(parseAdv([0, 6, 1, 2, 3], -60, 37), null, 'too short for an address');
  const bad = parseAdv([0x40, 12, 1, 2, 3, 4, 5, 6, 9, 0x09, 0x41, 0x42], -60, 37);
  eq(bad.name, '', 'an AD structure running past the end is dropped');
  const direct = parseAdv(pdu(1, '01:02:03:04:05:06', [name('x')]), -60, 37);
  eq(direct.name, '', 'ADV_DIRECT_IND carries no AD structures');
  const sr = parseAdv(pdu(4, '01:02:03:04:05:06', [name('Galaxy Buds2')]), -60, 37);
  eq(sr.pduType, 'SCAN_RSP', 'scan response');
  eq(sr.name, 'Galaxy Buds2', 'scan response name');
  const sd = parseAdv(pdu(0, '01:02:03:04:05:06', [svc(0xFEAA, [0x20, 0x00, 0x0B, 0xB8])]), -60, 37);
  eq(sd.svc.length, 1, 'service data');
  eq(sd.svc[0].uuid, 0xFEAA, 'service data uuid');
  eq(sd.svc[0].data.join(','), '32,0,11,184', 'service data bytes');
}

// ---- makers ----
eq(companyName(0x004C), 'Apple', 'Apple');
eq(companyName(0x0006), 'Microsoft', 'Microsoft');
eq(companyName(0x0075), 'Samsung', 'Samsung');
eq(companyName(0x00E0), 'Google', 'Google');
eq(companyName(0x0087), 'Garmin', 'Garmin');
eq(companyName(0x1234), '', 'unknown company');
eq(kindOf(pdu(0, 'AA:BB:CC:00:00:01', [mfr(0x0075, [0x42, 0x09, 0x01])])).maker, 'Samsung', 'maker from manufacturer data');
eq(kindOf(pdu(0, 'AA:BB:CC:00:00:02', [svc(0xFD5A, zeros(8))])).maker, 'Samsung', 'maker from a SmartTag service');
eq(kindOf(pdu(0, 'AA:BB:CC:00:00:03', [uuids(0xFEED)])).maker, 'Tile', 'maker from a Tile service');
eq(kindOf(pdu(0, 'AA:BB:CC:00:00:04', [name('thing')])).maker, '', 'no maker');

// ---- device types ----
const cases = [
  ['AirTag away from its owner', pdu(2, 'D1:00:00:00:00:01', [mfr(0x004C, [0x12, 0x19, 0x10, ...zeros(22), 0x01, 0x00])]), 'airtag', true],
  ['Find My near its owner', pdu(2, 'D1:00:00:00:00:02', [mfr(0x004C, [0x12, 0x02, 0x24, 0x01])]), 'findmy', true],
  ['iBeacon', pdu(2, 'D1:00:00:00:00:03', [flags(0x06), mfr(0x004C, [0x02, 0x15, ...Array.from({ length: 16 }, (_, i) => i), 0x00, 0x07, 0x01, 0x2C, 0xC5])]), 'ibeacon', false],
  ['AirPods', pdu(0, 'D1:00:00:00:00:04', [mfr(0x004C, [0x07, 0x19, 0x01, 0x0E, 0x20, ...zeros(20)])]), 'earbuds', false],
  ['iPhone (Nearby Info)', pdu(0, 'D1:00:00:00:00:05', [flags(0x1A), mfr(0x004C, [0x10, 0x05, 0x01, 0x18, 0x44, 0x00, 0x00])]), 'phone', false],
  ['AirPlay target', pdu(0, 'D1:00:00:00:00:06', [mfr(0x004C, [0x09, 0x06, 0x03, 0x00, 0xC0, 0xA8, 0x01, 0x02])]), 'tv', false],
  ['Windows PC', pdu(2, 'D1:00:00:00:00:07', [mfr(0x0006, [0x01, 0x09, 0x20, 0x02, ...zeros(20)])]), 'computer', false],
  ['Tile', pdu(0, 'D1:00:00:00:00:08', [flags(0x06), uuids(0xFEED), svc(0xFEED, [0x02, 0x00, ...zeros(8)])]), 'tile', true],
  ['Galaxy SmartTag', pdu(2, 'D1:00:00:00:00:09', [svc(0xFD5A, [0x10, ...zeros(15)])]), 'smarttag', true],
  ['Google Find Hub tag', pdu(2, 'D1:00:00:00:00:0A', [svc(0xFEAA, [0x41, ...zeros(20)])]), 'findhub', true],
  ['Eddystone-URL', pdu(2, 'D1:00:00:00:00:0B', [uuids(0xFEAA), svc(0xFEAA, [0x10, 0xEB, 0x03, ...[...'goo.gl/x'].map(c => c.charCodeAt(0))])]), 'eddystone', false],
  ['Eddystone-UID', pdu(2, 'D1:00:00:00:00:0C', [svc(0xFEAA, [0x00, 0xEB, ...Array.from({ length: 16 }, (_, i) => i + 1), 0, 0])]), 'eddystone', false],
  ['Fast Pair earbuds', pdu(0, 'D1:00:00:00:00:0D', [svc(0xFE2C, [0x00, 0x01, 0x02])]), 'earbuds', false],
  ['watch by appearance', pdu(0, 'D1:00:00:00:00:0E', [appear(0x00C1), name('Unknown')]), 'watch', false],
  ['phone by appearance', pdu(0, 'D1:00:00:00:00:0F', [appear(0x0040)]), 'phone', false],
  ['earbuds by appearance', pdu(0, 'D1:00:00:00:00:10', [appear(0x0941)]), 'earbuds', false],
  ['keyboard by appearance', pdu(0, 'D1:00:00:00:00:11', [appear(0x03C1)]), 'hid', false],
  ['watch by name', pdu(0, 'D1:00:00:00:00:12', [mfr(0x0087, [0x01]), name('Forerunner 265')]), 'watch', false],
  ['earbuds by name', pdu(0, 'D1:00:00:00:00:13', [name('Galaxy Buds2 Pro')]), 'earbuds', false],
  ['phone by name', pdu(0, 'D1:00:00:00:00:14', [name("Jo's iPhone")]), 'phone', false],
  ['plain device', pdu(0, 'D1:00:00:00:00:15', [mfr(0x0059, [0x01, 0x02])]), 'device', false],
];
for (const [what, p, kind, tracker] of cases) {
  const c = kindOf(p);
  eq(c.kind, kind, `type: ${what}`);
  eq(c.tracker, tracker, `tracker: ${what}`);
}
{
  const c = kindOf(cases[2][1]);
  eq(c.extra.find(e => e.name === 'UUID')?.value, '00010203-0405-0607-0809-0A0B0C0D0E0F', 'iBeacon UUID');
  eq(c.extra.find(e => e.name === 'Major')?.value, '7', 'iBeacon major');
  eq(c.extra.find(e => e.name === 'Minor')?.value, '300', 'iBeacon minor');
  eq(c.extra.find(e => e.name === 'Power at 1 m')?.value, '-59 dBm', 'iBeacon power');
  eq(kindOf(cases[10][1]).extra.find(e => e.name === 'URL')?.value, 'https://goo.gl/x', 'Eddystone URL');
  eq(eddystoneUrl([0x10, 0, 0x00, 0x61, 0x00]), 'http://www.a.com/', 'Eddystone URL expansion');
  eq(kindOf(cases[11][1]).extra.find(e => e.name === 'Namespace')?.value, '0102030405060708090A', 'Eddystone namespace');
  eq(kindOf(cases[0][1]).maker, 'Apple', 'AirTag maker');
  eq(kindOf(cases[9][1]).maker, 'Google', 'Find Hub maker');
}

// ---- the tracker ----
{
  const t = new BleTracker();
  const tag = cases[0][1], buds = cases[3][1];
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 10; i++) t.add(parseAdv(tag, -60 - i, 37 + (i % 3)), t0 + i * 1000);
  t.add(parseAdv(buds, -40, 37), t0 + 500);
  eq(t.devices.size, 2, 'one device per address');
  const d = t.devices.get('D1:00:00:00:00:01');
  eq(d.count, 10, 'packet count');
  eq(d.rssi.length, 10, 'signal history');
  eq(d.rssi[9], -69, 'latest signal');
  eq(d.history[3].ch, 37, 'raw history keeps the channel');
  eq(d.lastMs - d.firstMs, 9000, 'first and last heard');
  eq(d.alert, '', 'no alert after nine seconds');
  eq(d.fields.find(f => f.name === 'Maker')?.value, 'Apple', 'maker field');
  eq(d.fields.find(f => f.name === 'Packets')?.value, '10', 'packets field');
  t.add(parseAdv(tag, -61, 37), t0 + TRACKER_ALERT_MS);
  ok(d.alert.includes('NEAR YOU FOR 20 MIN'), 'alert after 20 minutes', d.alert);
  eq(t.list()[0].mac, d.mac, 'the alerted device leads the list');
  const b = t.devices.get('D1:00:00:00:00:04');
  t.add(parseAdv(buds, -40, 37), t0 + TRACKER_ALERT_MS * 2);
  eq(b.alert, '', 'earbuds never raise a tracker alert');
  for (let i = 0; i < RSSI_KEEP + HISTORY_KEEP; i++) t.add(parseAdv(buds, -40, 37), t0 + i);
  eq(b.rssi.length, RSSI_KEEP, 'signal history is capped');
  eq(b.history.length, HISTORY_KEEP, 'raw history is capped');

  const m = new BleTracker(), tile = cases[7][1];
  m.add(parseAdv(tile, -60, 37), t0, { lat: 34.0, lon: -118.0 });
  m.add(parseAdv(tile, -60, 37), t0 + 60_000, { lat: 34.002, lon: -118.0 });
  eq(m.list()[0].alert, '', 'no alert after 220 m');
  m.add(parseAdv(tile, -60, 37), t0 + 120_000, { lat: 34.01, lon: -118.0 });
  ok(m.list()[0].alert.includes('MOVING WITH YOU'), 'alert after a move', m.list()[0].alert);
  ok(Math.abs(distM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 111_195) < 50, 'one degree of latitude');

  // a name in a scan response sticks; a bare advertisement does not undo a recognized type
  const n = new BleTracker();
  n.add(parseAdv(pdu(0, 'E1:00:00:00:00:01', [appear(0x0941)]), -60, 37), t0);
  n.add(parseAdv(pdu(4, 'E1:00:00:00:00:01', [name('Buds Live')]), -60, 37), t0 + 10);
  n.add(parseAdv(pdu(0, 'E1:00:00:00:00:01', [flags(0x06)]), -60, 37), t0 + 20);
  const e = n.devices.get('E1:00:00:00:00:01');
  eq(e.name, 'Buds Live', 'name from the scan response');
  eq(e.kind, 'earbuds', 'type kept');
  n.clear(); eq(n.devices.size, 0, 'clear');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
