/**
 * The Meters app's mesh decoder (iOS MeshDecoderTest): synthetic hopping 2-FSK bursts through it at the RTL-SDR
 * rates, Mayhem's 4.19 Msps and the 19.2 Msps wide span; a poll and its reply in one burst; weak bursts; Gridstream
 * beacons with the CoServ CRC seed, the meter card they make, and WAN addresses as positions. Also the Meters
 * processor end to end: an ERT SCM packet and a mesh beacon in the same samples, one card each.
 */
import { MeshDecoder, MetersProcessor, GridstreamWan } from '../dist/dsp/mesh.js';
import { ErtDecoder } from '../dist/dsp/ert.js';
import { jrandom } from './jrandom.mjs';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const near = (a, b, tol, what) => ok(Math.abs(a - b) <= tol, what, `got ${a}, want ${b}±${tol}`);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
console.log('Meters: mesh networks, Gridstream and ERT in one span');

const RATE = MeshDecoder.RATE, CENTER = 911_600_000;

/** Raw IQ for bursts of `bits` at offsets from the center (one each), 2-FSK ±20 kHz, `gap` seconds apart. */
function iq(bursts, { baud = 9600, amp = 25, noise = 3, gap = 0.012, rate = RATE } = {}) {
  const g = jrandom(11).nextGaussian;
  const sps = rate / baud;
  let total = Math.floor(gap * rate);
  for (const [bits] of bursts) total += Math.floor(0.001 * rate) + Math.ceil(bits.length * sps) + 1 + Math.floor(gap * rate);
  const out = new Int8Array(2 * total);
  let at = 0;
  const push = (i, q) => {
    out[at++] = Math.max(-128, Math.min(127, Math.round(i + noise * g())));
    out[at++] = Math.max(-128, Math.min(127, Math.round(q + noise * g())));
  };
  for (let k = Math.floor(gap * rate); k > 0; k--) push(0, 0);
  for (const [bits, off] of bursts) {
    let ph = 0, acc = 0;
    for (let k = Math.floor(0.001 * rate); k > 0; k--) { ph += 2 * Math.PI * off / rate; push(amp * Math.cos(ph), amp * Math.sin(ph)); }   // ramp-up carrier
    for (const b of bits) {
      acc += sps; const n = Math.floor(acc); acc -= n;
      for (let k = 0; k < n; k++) { ph += 2 * Math.PI * (off + (b === 1 ? 20_000 : -20_000)) / rate; push(amp * Math.cos(ph), amp * Math.sin(ph)); }
    }
    for (let k = Math.floor(gap * rate); k > 0; k--) push(0, 0);
  }
  return out.subarray(0, at);
}
const bitsOf = (bytes) => bytes.flatMap(b => [0, 1, 2, 3, 4, 5, 6, 7].map(k => (b >> (7 - k)) & 1));
const meshBits = (payload) => [...Array.from({ length: 32 }, (_, k) => k & 1), ...bitsOf([0xF6, 0xE5, 0x6B, ...payload]), 0, 1, 0, 1];   // and a short tail

function feed(d, samples, rate, chunk = 262_144) {
  for (let at = 0; at < samples.length; at += 2 * chunk) d.onIq(samples.subarray(at, Math.min(samples.length, at + 2 * chunk)), rate);
}
function run(samples, rate = RATE) {
  const d = new MeshDecoder(() => {}); d.shedding = false;
  const got = [];
  d.onFrame = f => got.push(f);
  d.centerHz = CENTER;
  d.reset(rate);
  feed(d, samples, rate);
  return got;
}
const BEACON = [0x2A, 0x55, 0x00, 0x23, 0x30, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0x50, 0x21, 0xD0, 0x05, 0x00,
  0x7C, 0x00, 0x03, 0xFB, 0x20, 0xA4, 0x03, 0x50, 0x21, 0xD0, 0x05, 0x01, 0x00, 0x07, 0x20, 0x01, 0x1E, 0x56, 0x7E, 0x00];
/** A Gridstream frame on air: 0xAA preamble, then 00 FF and the body UART-framed (start 0, 8 bits LSB first, stop 1). */
function gridstreamBits(body) {
  const bits = [];
  for (let k = 0; k < 6; k++) bits.push(...bitsOf([0xAA]));
  bits.push(1, 0, 1, 0);
  for (const b of [0x00, 0xFF, ...body, 0x04]) { bits.push(0); for (let k = 0; k < 8; k++) bits.push((b >> k) & 1); bits.push(1); }
  return bits;
}
function withCrc(body, seed) { const c = MeshDecoder.crcCcitt(body, 0, body.length, seed); return [...body, c >> 8, c & 0xFF]; }
const P5 = [0xD7, 0xEB, 0x12, 0x34, 0x0C];

// An RTL-SDR runs Meters at 2.0 Msps (2.4 at most): mesh and Gridstream beacons across its span still decode.
for (const rate of [2_000_000, 2_400_000]) {
  const offs = [-850_000, -300_000, 420_000, 900_000];
  let got = run(iq(offs.map(o => [meshBits(P5), o]), { rate }), rate);
  ok(got.filter(f => f.sync === 0xF6E56B && same(f.bytes.slice(0, 5), P5)).length === offs.length, `mesh at ${rate}`, `${got.length} frames`);
  got.slice(0, offs.length).forEach((f, i) => near(f.hz, CENTER + offs[i], 5_000, `mesh frequency ${offs[i]} at ${rate}`));
  got = run(iq([[gridstreamBits(withCrc(BEACON, 0x45F8)), -600_000]], { rate }), rate);
  ok(got.filter(f => f.sync === MeshDecoder.GRIDSTREAM && f.crcOk).length === 1, `gridstream at ${rate}`);
}

// 19.2 Msps: beacons hopping across the whole ±9 MHz, decoded and placed right
{
  const rate = 19_200_000;
  const offs = [-8_400_000, -3_100_000, 2_250_000, 7_900_000, 450_000, -6_000_000];
  const samples = iq(offs.map(o => [meshBits(P5), o]), { rate });
  const t0 = performance.now();
  const got = run(samples, rate);
  const secs = (performance.now() - t0) / 1000, air = samples.length / 2 / rate;
  console.log(`wide: ${got.filter(f => f.sync === 0xF6E56B).length} of ${offs.length} decoded, ${air.toFixed(2)} s of IQ in ${secs.toFixed(2)} s (${Math.round(100 * secs / air)}% of real time)`);
  ok(got.filter(f => f.sync === 0xF6E56B && same(f.bytes.slice(0, 5), P5)).length === offs.length, 'wide span: every hop decoded');
  got.slice(0, offs.length).forEach((f, i) => near(f.hz, CENTER + offs[i], 5_000, `wide frequency ${offs[i]}`));
}

// hopping beacons
{
  const payloads = [[0xD7, 0xEB, 0xA7, 0x8C, 0x0C], [0xD7, 0xEB, 0x9C, 0x9E, 0x08], [0x5F, 0xE8, 0xC4, 0x5D, 0xC0, 0x20, 0x11, 0x99, 0x42, 0x07, 0x33, 0x81]];
  const offs = [-1_650_000, 410_000, 1_220_000, -380_000, 1_800_000, -900_000];
  const bursts = [];
  for (let k = 0; k < 12; k++) bursts.push([meshBits(payloads[k % 3]), offs[k % offs.length]]);
  const got = run(iq(bursts));
  const good = got.filter(f => f.sync === 0xF6E56B && payloads.some(p => f.bytes.length >= p.length && same(f.bytes.slice(0, p.length), p)));
  ok(good.length >= 11, 'hopping beacons', `${good.length} of 12 bursts decoded`);
  ok(good.some(f => f.bytes[0] === 0x5F), 'the long frame among them');
}

// a poll, 16 bits of fresh preamble, the sync word again and a reply, all in one burst
{
  const poll = [0x5F, 0xE4, 0x74, 0xED], reply = [0xD3, 0xF5, 0x91, 0xDA, 0x40, 0x20, 0x11, 0x22];
  const head = meshBits(poll).slice(0, 32 + 24 + 32);
  const pre = Array.from({ length: 16 }, (_, k) => k & 1);
  const got = run(iq([[[...head, ...pre, ...bitsOf([0xF6, 0xE5, 0x6B, ...reply]), 0, 1, 0, 1], 500_000]]));
  ok(got.length === 2, 'poll and reply: two frames', `${got.length}`);
  ok(same(got[0]?.bytes.slice(0, 4) ?? [], poll), 'the poll');
  ok(same(got[got.length - 1]?.bytes.slice(0, 8) ?? [], reply), 'the reply');
}

// the frequency is right
{
  const got = run(iq([[meshBits([0xD7, 0xEB, 1, 2, 3]), 777_000]]));
  ok(got.length === 1, 'one burst, one frame');
  if (got[0]) near(got[0].hz, CENTER + 777_000, 3_000, 'frequency of the burst');
}

// weak bursts
{
  const got = run(iq(Array.from({ length: 10 }, () => [meshBits(P5), 600_000]), { amp: 6, noise: 4 }));
  const good = got.filter(f => f.sync === 0xF6E56B && same(f.bytes.slice(0, 5), P5));
  console.log(`weak: ${good.length}/10`);
  ok(good.length >= 8, 'weak bursts', `${good.length} of 10`);
}

// a 0x55 beacon laid out as on the RECESSIM wiki, CRC with the CoServ seed over the bytes after 00 FF
{
  const bits = gridstreamBits(withCrc(BEACON, 0x45F8));
  const got = run(iq([[bits, -500_000], [bits, 900_000]]));
  ok(got.filter(f => f.sync === MeshDecoder.GRIDSTREAM && f.crcOk).length === 2, 'Gridstream beacons, CRC good');
  ok(MeshDecoder.line(got[0]).includes('GRIDSTREAM beacon 5021D005'), 'Gridstream beacon log line', MeshDecoder.line(got[0]));
}

// the same beacon twice: one meter, its id from bytes 26-29, its uptime from 20-23
{
  const bits = gridstreamBits([...BEACON, 0x12, 0x34]);   // a CRC with a seed we do not know: the length still checks out
  const msgs = [];
  const d = new MeshDecoder(m => msgs.push(m)); d.shedding = false;
  d.centerHz = CENTER; d.reset(RATE);
  feed(d, iq([[bits, 300_000], [bits, -700_000]]), RATE, 32768);
  d.flush();
  const dev = d.devices.find(x => x.net === MeshDecoder.GRIDSTREAM);
  ok(dev?.id === 0x5021D005, 'meter id', dev?.id?.toString(16));
  ok(dev?.uptimeS === 0x0003FB20, 'uptime');
  ok(dev?.frames === 2, 'two frames');
  ok(!!dev?.fields.find(f => f.name === 'WAN ADDRESS'), 'WAN address field');
  const snap = msgs.filter(m => m.type === 'meters').pop();
  ok(!!snap && snap.devices.some(x => x.label === '5021D005'), 'the snapshot carries the card');
  ok(!!snap && JSON.stringify(structuredClone(snap)).length > 0, 'the snapshot is plain data');
}

// WAN addresses as positions
{
  const p = GridstreamWan.decode(0x42CBBE0E55E5);
  near(p.lat, 43.0342, 0.0001, 'gpsdecode example latitude'); near(p.lon, -87.4801, 0.0001, 'gpsdecode example longitude');
  ok(p.color === 5, 'node color');
  const oncor = GridstreamWan.decode(0x50CF8DD9E2C0);   // the wiki's Oncor beacon: north Texas
  near(oncor.lat, 33.18, 0.01, 'Oncor latitude'); near(oncor.lon, -96.70, 0.01, 'Oncor longitude');
}

// the Meters processor: an ERT SCM packet (OOK) and a hopping mesh, one card each kind
{
  const crc16 = (bits, poly) => { let crc = 0; for (const b of bits) { const msb = (crc >> 15) & 1; crc = (crc << 1) & 0xFFFF; if (msb ^ b) crc ^= poly; } return crc; };
  const field = (v, n) => Array.from({ length: n }, (_, i) => Math.floor(v / 2 ** (n - 1 - i)) & 1);
  let data = [...field(0, 2), 0, ...field(0, 2), ...field(7, 4), ...field(0, 2), ...field(123_456, 24), ...field(4_242_424, 24)];
  data = [...data, ...field(crc16(data, 0x6F63), 16)];
  const scm = [...field(0x1F2A60, 21), ...data];
  const rate = RATE, spc = rate / 32768;
  const chips = [...new Array(400).fill(false), ...scm.flatMap(b => [b === 1, b !== 1]), ...new Array(400).fill(false)];
  const ert = new Int8Array(2 * Math.floor(chips.length * spc));
  for (let k = 0, ph = 0; k < ert.length / 2; k++) { ph += 2 * Math.PI * 300_000 / rate; const a = chips[Math.floor(k / spc)] ? 50 : 0; ert[2 * k] = Math.round(a * Math.cos(ph)); ert[2 * k + 1] = Math.round(a * Math.sin(ph)); }
  const mesh = iq(Array.from({ length: 8 }, (_, k) => [meshBits([0xD7, 0xEB, 0x12, 0x34 - k * 2, 0x0C]), [-1_000_000, 700_000][k % 2]]));
  const all = new Int8Array(ert.length + mesh.length); all.set(ert); all.set(mesh, ert.length);
  const lines = [];
  const m = new MeshDecoder(x => { if (x.type === 'packet') lines.push(x.line); }); m.shedding = false; m.centerHz = CENTER;
  const p = new MetersProcessor(new ErtDecoder(x => { if (x.type === 'packet') lines.push(x.line); }), m);
  p.reset(rate);
  for (let at = 0; at < all.length; at += 2 * 65536) p.onIq(all.subarray(at, Math.min(all.length, at + 2 * 65536)), rate);
  m.flush();
  const ertCard = m.devices.find(d => d.net === MeshDecoder.ERT);
  ok(ertCard?.id === 4_242_424 && ertCard.cons === 123_456 && ertCard.ertKind === 'SCM', 'ERT meter card', JSON.stringify(ertCard?.fields));
  ok(lines.some(l => l.startsWith('SCM  ID 4242424')), 'ERT log line');
  ok(m.nets.some(n => n.sync === 0xF6E56B && n.frames === 8), 'the mesh network', JSON.stringify(m.nets.map(n => [n.sync, n.frames])));
  ok(m.devices.some(d => d.net === 0xF6E56B && d.id === 0xD7 && d.frames >= 5), 'its transmitter card (tracked once the network has 3 frames)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
