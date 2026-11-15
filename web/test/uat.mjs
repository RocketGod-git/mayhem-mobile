/**
 * UAT (978 MHz): Reed-Solomon repair, then whole frames built the way a tower and an aircraft build them (DO-282B),
 * CPFSK-modulated with noise and run through the receiver: an aircraft downlink (position, altitude, velocity, call
 * sign) and a ground uplink carrying a FIS-B METAR and a radar block. Also the METAR reader.
 */
import { rsCorrect, rsEncode, uplinkFrame, uplinkMessage } from '../dist/dsp/uat/rs.js';
import { UatReceiver, UAT_BITRATE } from '../dist/dsp/uat/demod.js';
import { decodeDownlink } from '../dist/dsp/uat/traffic.js';
import { productsOf, radarBlocks, textOf, parseMetar, stationOf } from '../dist/dsp/uat/fisb.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(a === b, what, `got ${a}, want ${b}`);
const near = (a, b, tol, what) => ok(a !== undefined && Math.abs(a - b) <= tol, what, `got ${a}, want ${b} ± ${tol}`);
console.log('UAT: 978 MHz weather and traffic');

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

// ---- Reed-Solomon: random codewords, up to t byte errors corrected, more rejected
for (const [k, nr] of [[72, 20], [18, 12], [34, 14]]) {
  let fixedAll = true, rejected = 0;
  for (let trial = 0; trial < 40; trial++) {
    const data = Array.from({ length: k }, () => Math.floor(rnd() * 256));
    const cw = rsEncode(data, nr);
    const nErr = trial % (nr / 2 + 1);
    const bad = cw.slice();
    const pos = new Set(); while (pos.size < nErr) pos.add(Math.floor(rnd() * cw.length));
    for (const p of pos) bad[p] ^= 1 + Math.floor(rnd() * 255);
    const n = rsCorrect(bad, nr);
    if (n !== nErr || bad.some((v, i) => v !== cw[i])) fixedAll = false;
  }
  ok(fixedAll, `RS(${k + nr},${k}) corrects up to ${nr / 2} byte errors`);
  const cw = rsEncode(Array.from({ length: k }, () => 7), nr), bad = cw.slice();
  for (let i = 0; i < nr / 2 + 2; i++) bad[i * 3] ^= 0x5a;
  if (rsCorrect(bad, nr) < 0) rejected++;
  eq(rejected, 1, `RS(${k + nr},${k}) rejects ${nr / 2 + 2} errors`);
}

// ---- building frames
const bitsOf = bytes => { const out = []; for (const b of bytes) for (let i = 7; i >= 0; i--) out.push((b >> i) & 1); return out; };
const syncBits = w => Array.from({ length: 36 }, (_, i) => Math.floor(w / 2 ** (35 - i)) & 1);
/**
 * CPFSK, h = 0.6, at [rate], with a quiet lead-in, noise, a carrier offset and an amplitude. The phase is the exact
 * integral of the frequency up to each sample instant (a transmitter turns it continuously); stepping it once a sample
 * gave some bits half their turn at 1.92 samples a bit.
 */
function modulate(bits, rate, { noise = 6, offsetHz = 4000, amp = 60 } = {}) {
  const spb = rate / UAT_BITRATE, dev = 0.3 * UAT_BITRATE;          // h = 0.6: +-312.5 kHz
  const n = Math.ceil((bits.length + 200) * spb), out = new Int8Array(2 * n);
  const tb = 1 / UAT_BITRATE, lead = 100 * tb;
  const cum = [0];                                                     // phase (cycles) at the start of each bit
  for (const b of bits) cum.push(cum[cum.length - 1] + (b ? dev : -dev) * tb);
  for (let k = 0; k < n; k++) {
    const t = k / rate, bi = Math.floor((t - lead) / tb);
    const f = bi >= 0 && bi < bits.length ? (bits[bi] ? dev : -dev) : 0;
    const a = bi >= 0 && bi < bits.length ? amp : 0;
    const cyc = bi < 0 ? 0 : bi >= bits.length ? cum[bits.length] : cum[bi] + f * (t - lead - bi * tb);
    const ph = 2 * Math.PI * (cyc + offsetHz * t);
    const g = () => (rnd() + rnd() + rnd() - 1.5) * noise;
    out[2 * k] = Math.max(-127, Math.min(127, Math.round(a * Math.cos(ph) + g())));
    out[2 * k + 1] = Math.max(-127, Math.min(127, Math.round(a * Math.sin(ph) + g())));
  }
  return out;
}
function run(iq, rate) {
  const ups = [], downs = [];
  const rx = new UatReceiver(u => ups.push(u), d => downs.push(d));
  rx.reset(rate);
  for (let o = 0; o < iq.length; o += 65536) rx.onIq(iq.subarray(o, o + 65536), rate);
  return { ups, downs };
}

// ---- an aircraft: long ADS-B frame, payload type 1 (state vector + mode status with a call sign)
function downlinkBytes() {
  const b = new Uint8Array(34);
  b[0] = (1 << 3) | 0;                                   // payload type 1, ADS-B with ICAO address
  b[1] = 0xa5; b[2] = 0xa8; b[3] = 0x14;
  const rawLat = Math.round(34.3842 / 360 * 2 ** 24), rawLon = Math.round((-118.7675 + 360) / 360 * 2 ** 24);
  b[4] = rawLat >> 15; b[5] = (rawLat >> 7) & 0xff; b[6] = ((rawLat & 0x7f) << 1) | (rawLon >> 23);
  b[7] = (rawLon >> 15) & 0xff; b[8] = (rawLon >> 7) & 0xff; b[9] = (rawLon & 0x7f) << 1;   // baro altitude
  const rawAlt = (8300 + 1000) / 25 + 1;
  b[10] = rawAlt >> 4; b[11] = ((rawAlt & 0xf) << 4) | 8;                                   // NIC 8
  const ns = 0x400 | (13 + 1), ew = 0x400 | (99 + 1);   // 13 kt south, 99 kt west
  b[12] = (0 << 6) | (ns >> 6); b[13] = ((ns & 0x3f) << 2) | (ew >> 9); b[14] = (ew >> 1) & 0xff;
  const vv = 0x200 | (5 + 1);                            // 320 ft/min down (5 * 64)
  b[15] = ((ew & 1) << 7) | (vv >> 4); b[16] = (vv & 0xf) << 4;
  const B40 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ  ..', cs = 'N4637G  '.split('').map(c => B40.indexOf(c));
  const w1 = 1 * 1600 + cs[0] * 40 + cs[1], w2 = cs[2] * 1600 + cs[3] * 40 + cs[4], w3 = cs[5] * 1600 + cs[6] * 40 + cs[7];
  b[17] = w1 >> 8; b[18] = w1 & 0xff; b[19] = w2 >> 8; b[20] = w2 & 0xff; b[21] = w3 >> 8; b[22] = w3 & 0xff;
  return b;
}
{
  const data = downlinkBytes();
  const cw = rsEncode(data, 14);
  for (const rate of [2e6, 2.4e6, 8e6]) {
    const bits = [...syncBits(0xeacdda4e2), ...bitsOf(cw)];
    const corrupt = bits.slice(); for (const i of [60, 61, 200, 300]) corrupt[i] ^= 1;
    const { downs } = run(modulate(corrupt, rate), rate);
    eq(downs.length, 1, `downlink decodes at ${rate / 1e6} Msps`);
    if (!downs.length) continue;
    const t = decodeDownlink(downs[0].bytes);
    eq(t.address, 'A5A814', `address at ${rate / 1e6} Msps`);
    if (rate !== 2e6) continue;
    eq(t.callsign, 'N4637G', 'call sign');
    near(t.lat, 34.3842, 1e-4, 'latitude'); near(t.lon, -118.7675, 1e-4, 'longitude');
    eq(t.altFt, 8300, 'altitude'); near(t.speedKt, 100, 1, 'ground speed'); near(t.trackDeg, 262, 1, 'track');
    eq(t.vertFpm, -320, 'vertical rate'); eq(t.qualifier, 0, 'ADS-B (not TIS-B)');
  }
}

// ---- a tower: one uplink with a METAR (product 413) and a regional radar block (product 63)
const char6 = c => (c >= 'A' && c <= 'Z' ? c.charCodeAt(0) - 64 : c.charCodeAt(0));
function apdu(pid, hh, mm, payloadBits) {
  const head = [0, 0, 0, ...Array.from({ length: 11 }, (_, i) => (pid >> (10 - i)) & 1), 0, 0, 0, 0,
    ...Array.from({ length: 5 }, (_, i) => (hh >> (4 - i)) & 1), ...Array.from({ length: 6 }, (_, i) => (mm >> (5 - i)) & 1)];
  while (head.length % 8) head.push(0);
  const bits = [...head, ...payloadBits]; while (bits.length % 8) bits.push(0);
  const out = new Uint8Array(bits.length / 8);
  bits.forEach((v, i) => { if (v) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
}
const METAR = 'METAR KCMA 150455Z 06007KT 10SM CLR 15/11 A2999 RMK AO2=';
{
  const textBits = METAR.split('').flatMap(c => Array.from({ length: 6 }, (_, i) => (char6(c) >> (5 - i)) & 1));
  const a1 = apdu(413, 4, 55, textBits);
  // radar block 222600 (32.93 N, 120.00 W), high resolution: a run of 64 at level 3 then 64 at level 0
  const radar = [0x80 | ((222600 >> 16) & 0xf), (222600 >> 8) & 0xff, 222600 & 0xff, (31 << 3) | 3, (31 << 3) | 3, (31 << 3) | 0, (31 << 3) | 0];
  const a2 = apdu(63, 5, 36, radar.flatMap(b => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1)));
  const msg = new Uint8Array(432);
  const rawLat = Math.round(34.0755 / 360 * 2 ** 24), rawLon = Math.round((-118.6595 + 360) / 360 * 2 ** 24);
  msg[0] = rawLat >> 15; msg[1] = (rawLat >> 7) & 0xff; msg[2] = ((rawLat & 0x7f) << 1) | (rawLon >> 23);
  msg[3] = (rawLon >> 15) & 0xff; msg[4] = (rawLon >> 7) & 0xff; msg[5] = ((rawLon & 0x7f) << 1) | 1;
  msg[6] = 0x80 | 0x20 | 7; msg[7] = 12 << 4;
  let i = 8;
  for (const a of [a1, a2]) { msg[i] = a.length >> 1; msg[i + 1] = ((a.length & 1) << 7) | 0; msg.set(a, i + 2); i += 2 + a.length; }
  const frame = uplinkFrame(msg);
  eq(uplinkMessage(frame)?.fixed, 0, 'uplink frame round trip');
  const bits = [...syncBits(0x153225b1d), ...bitsOf(frame)];
  for (const k of [100, 900, 901, 2000, 3000, 4400]) bits[k] ^= 1;
  for (const rate of [2e6, 2.4e6]) {
    const { ups } = run(modulate(bits, rate), rate);
    eq(ups.length, 1, `uplink decodes at ${rate / 1e6} Msps`);
    if (!ups.length || rate !== 2e6) continue;
    const m = ups[0].msg;
    const st = stationOf(m);
    near(st.lat, 34.0755, 1e-4, 'tower latitude'); near(st.lon, -118.6595, 1e-4, 'tower longitude'); eq(st.slot, 7, 'tower slot');
    const ps = productsOf(m);
    eq(ps.length, 2, 'two products');
    const text = ps.find(p => p.id === 413);
    ok(text && textOf(text.payload).startsWith('METAR KCMA 150455Z'), 'METAR text', text ? textOf(text.payload) : 'none');
    const w = parseMetar(textOf(text.payload));
    eq(w?.windDir, 60, 'METAR wind direction'); eq(w?.windKt, 7, 'METAR wind'); eq(w?.visSm, 10, 'METAR visibility');
    eq(w?.tempC, 15, 'METAR temperature'); eq(w?.altimInHg, 29.99, 'METAR altimeter'); eq(w?.category, 'VFR', 'METAR category');
    const rb = radarBlocks(ps.find(p => p.id === 63));
    eq(rb.length, 1, 'one radar block'); near(rb[0]?.lat, 32.93, 0.01, 'radar block latitude'); near(rb[0]?.lon, -120, 0.01, 'radar block longitude');
    eq(rb[0]?.bins?.[0], 3, 'radar first bin'); eq(rb[0]?.bins?.[127], 0, 'radar last bin');
  }
}

// ---- METAR flight categories
eq(parseMetar('METAR KSFO 150456Z 28012G20KT 2SM BR OVC008 12/11 A3001')?.category, 'IFR', 'IFR');
eq(parseMetar('METAR KSMO 150451Z 00000KT 1/2SM FG VV002 13/13 A3000')?.category, 'LIFR', 'LIFR');
eq(parseMetar('METAR KBUR 150453Z 15005KT 6SM HZ BKN025 16/11 A3002')?.category, 'MVFR', 'MVFR');
eq(parseMetar('METAR K05U 150535Z AUTO 21006KT 10SM CLR M02/M03 A3010')?.tempC, -2, 'below-zero temperature');

console.log(`  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
