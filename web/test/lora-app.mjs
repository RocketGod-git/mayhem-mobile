/**
 * The LoRa app: the wideband scanner on a real Meshtastic packet placed in a wider span, the MeshCore and LoRaWAN
 * parsers on frames built to their published layouts, and the hashes and ciphers they lean on. Port of
 * LoraAppTest.swift (its env-driven testReceiverOnClip / testReplayRecording are tools, not tests;
 * MAYHEM_LORA_TRACE=<hz> traces the scanner here too). The hub's emitted messages are checked at the end.
 */
import { readFileSync } from 'node:fs';
import { Sha256 } from '../dist/dsp/lora/sha256.js';
import { Aes128 } from '../dist/dsp/lora/aes128.js';
import { Meshtastic } from '../dist/dsp/lora/meshtastic.js';
import { MeshCore } from '../dist/dsp/lora/meshcore.js';
import { LoraWan } from '../dist/dsp/lora/lorawan.js';
import { LoraScanner } from '../dist/dsp/lora/scanner.js';
import { LoraHub } from '../dist/dsp/lora/hub.js';
import { fft } from '../dist/fft.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(a === b, what, `got ${String(a)}, want ${String(b)}`);
const near = (a, b, tol, what) => ok(Math.abs(a - b) <= tol, what, `got ${a}, want ${b}±${tol}`);
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const utf8 = s => Array.from(new TextEncoder().encode(s));

// testSha256AndHmac
eq(hex(Sha256.hash(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'SHA-256 "abc"');
eq(hex(Sha256.hash([])), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'SHA-256 empty');
// RFC 4231 test case 2
eq(hex(Sha256.hmac(utf8('Jefe'), utf8('what do ya want for nothing?'))), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843', 'HMAC-SHA256 RFC 4231 #2');

// testAesDecrypt
{
  const key = Array.from({ length: 16 }, (_, i) => i);
  const ct = [0x69, 0xc4, 0xe0, 0xd8, 0x6a, 0x7b, 0x04, 0x30, 0xd8, 0xcd, 0xb7, 0x80, 0x70, 0xb4, 0xc5, 0x5a];
  eq(hex(Aes128.decrypt(ct, Aes128.expand(key))), '00112233445566778899aabbccddeeff', 'AES-128 decrypt');
}

// testMeshtasticAnyPublicChannel: a text on a channel whose name no preset has, on public key 3
{
  const text = utf8('hello from a custom channel');
  const data = [0x08, 0x01, 0x12, text.length, ...text];          // portnum 1 (text), payload
  const from = [0x32, 0x81, 0xb1, 0x2b], id = [0x11, 0x22, 0x33, 0x44];
  const nonce = new Uint8Array(16);
  for (let k = 0; k < 4; k++) { nonce[k] = id[k]; nonce[8 + k] = from[k]; }
  const ct = Aes128.ctr(Meshtastic.simpleKeys[2], nonce, Uint8Array.from(data));
  const pkt = Uint8Array.from([0xff, 0xff, 0xff, 0xff, ...from, ...id, 0x63, 0x5A, 0x00, 0x00, ...ct]);   // channel hash 5A
  const p = Meshtastic.parse(pkt);
  ok(p !== null, 'custom-channel packet parses');
  eq(p?.portnum, 1, 'custom channel: text port');
  eq(p?.text, 'hello from a custom channel', 'custom channel: text');
}

// testMeshtasticPlan
{
  const plan = LoraScanner.plan, by = n => plan.find(c => c.name === n);
  eq(by('Meshtastic LongFast US')?.hz, 906_875_000, 'LongFast US');
  eq(by('Meshtastic MediumFast US')?.hz, 913_125_000, 'MediumFast US');
  eq(by('Meshtastic ShortFast US')?.hz, 918_875_000, 'ShortFast US');
  // worldwide: Meshtastic's own slot rule per region
  eq(by('Meshtastic LongFast ANZ')?.hz, 919_875_000, 'LongFast ANZ');
  eq(by('Meshtastic LongFast EU_868')?.hz, 869_525_000, 'LongFast EU_868');
  ok(by('Meshtastic LongFast EU_868')?.standing === true, 'LongFast EU_868 standing');
  ok(plan.some(c => c.name === 'MeshCore EU/UK narrow' && c.hz === 869_618_000), 'MeshCore EU/UK narrow');
}

// testMeshCoreAdvert
{
  const b = [0x11, 0x00];                                   // flood (1) advert (4 << 2), no hops
  for (let i = 0; i < 32; i++) b.push((i * 7) & 0xff);
  b.push(0x10, 0x32, 0x54, 0x76);                           // timestamp
  for (let i = 0; i < 64; i++) b.push(0xAA);                // signature
  b.push(0x92);                                             // has name (80), has position (10), repeater (2)
  for (const v of [34_273_650, -118_780_320]) { const u = v >>> 0; for (let k = 0; k < 4; k++) b.push((u >>> (8 * k)) & 0xff); }
  b.push(...utf8('Simi Hill RPT'));
  const p = MeshCore.parse(Uint8Array.from(b));
  ok(p !== null, 'advert parses');
  eq(p?.typeName, 'ADVERT', 'advert type');
  eq(p?.nodeType, 'repeater', 'advert node type');
  eq(p?.name, 'Simi Hill RPT', 'advert name');
  near(p?.lat ?? 0, 34.27365, 1e-6, 'advert lat');
  near(p?.lon ?? 0, -118.78032, 1e-6, 'advert lon');
}

// testMeshCorePublicGroupText: AES-128 ECB under the channel key, 2-byte HMAC-SHA256
{
  const key = MeshCore.publicKey;
  const plain = [0x00, 0x10, 0x20, 0x30, 0x00, ...utf8('RocketGod: hello mesh')];
  while (plain.length % 16 !== 0) plain.push(0);
  const rk = Aes128.expand(key);
  const ct = [];
  for (let i = 0; i < plain.length; i += 16) ct.push(...Aes128.encrypt(plain.slice(i, i + 16), rk));
  const mac = Sha256.hmac([...key, ...new Array(16).fill(0)], ct);
  const b = Uint8Array.from([0x15, 0x41, 0xAB, 0xCD, Sha256.hash(key)[0], mac[0], mac[1], ...ct]);   // 1 hop, 2-byte hashes
  const p = MeshCore.parse(b);
  ok(p !== null, 'group text parses');
  eq(p?.hashSize, 2, 'group text hash size');
  eq(p ? JSON.stringify(p.path.map(x => Array.from(x))) : '', JSON.stringify([[0xAB, 0xCD]]), 'group text path');
  eq(p?.channel, 'Public', 'group text channel');
  eq(p?.text, 'RocketGod: hello mesh', 'group text');
  eq(p?.name, 'RocketGod', 'group text sender');
}

// testLoraWanJoinAndData
{
  const j = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x9A, 0xBC, 1, 2, 3, 4]);
  const p = LoraWan.parse(j);
  eq(p?.typeName, 'JOIN REQUEST', 'join request');
  eq(p?.devEui, 0x8877665544332211n, 'device EUI');
  const d = Uint8Array.from([0x40, 0x78, 0x56, 0x34, 0x12, 0x80, 0x2A, 0x00, 0x01, 0xDE, 0xAD, 9, 9, 9, 9]);
  const q = LoraWan.parse(d);
  eq(q?.typeName, 'UPLINK', 'uplink');
  eq(q?.devAddr, 0x12345678, 'device address');
  eq(q?.fcnt, 42, 'frame count');
  eq(q?.port, 1, 'port');
}

/**
 * testScannerFindsPacketInSpan: the real LongFast packet (250 kHz, one sample a chip) band-limited up to 2 Msps,
 * moved 300 kHz off the center, quantized like a radio's samples (signed int8 here), and given to the scanner,
 * which has to find it, pick its bandwidth, and decode it as Meshtastic without being told where it is.
 */
{
  const raw = new Int8Array(readFileSync(new URL('./resources/meshtastic_nodeinfo_a_250k_sf11.i8', import.meta.url)).buffer.slice(0));
  const n = raw.length / 2;
  const up = 8, rate = 2_000_000;
  let big = 1; while (big < n) big <<= 1;
  const re = new Float32Array(big), im = new Float32Array(big);
  for (let k = 0; k < n; k++) { re[k] = raw[2 * k]; im[k] = raw[2 * k + 1]; }
  fft(re, im);
  const m = big * up;
  const r2 = new Float32Array(m), i2 = new Float32Array(m);
  for (let k = 0; k < big; k++) { const dst = k < big / 2 ? k : m - (big - k); r2[dst] = re[k]; i2[dst] = -im[k]; }   // conjugate: the forward FFT then inverts
  fft(r2, i2);
  const off = 300_000, scale = 0.3 / big;   // the clip peaks near 165: keep it inside 8 bits
  const total = m + rate / 10;
  const bytes = new Int8Array(2 * total);
  let seed = 1;
  const noise = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return (seed >>> 8) / (1 << 24) - 0.5; };
  for (let k = 0; k < total; k++) {
    let x = 0, y = 0;
    if (k >= rate / 20 && k - rate / 20 < m) {
      const s = k - rate / 20, a = r2[s] * scale, b = -i2[s] * scale, w = 2 * Math.PI * off * k / rate;
      x = a * Math.cos(w) - b * Math.sin(w); y = a * Math.sin(w) + b * Math.cos(w);
    }
    x += 6 * noise(); y += 6 * noise();
    bytes[2 * k] = Math.max(-128, Math.min(127, Math.round(x)));
    bytes[2 * k + 1] = Math.max(-128, Math.min(127, Math.round(y)));
  }
  const msgs = [];
  const hub = new LoraHub(msg => msgs.push(msg));
  hub.scanner.shedding = false;
  hub.setCenter(906_875_000 - 300_000);
  const got = [], heard = [];
  hub.onHeard = (h, e) => { heard.push(h); got.push(e); };
  if (process.env.MAYHEM_LORA_TRACE) { LoraScanner.traceHz = Number(process.env.MAYHEM_LORA_TRACE); LoraScanner.trace = s => console.log('TRACE ' + s); }
  hub.reset(rate);
  const chunk = 131_072;
  const t0 = performance.now();
  for (let at = 0; at < bytes.length; at += chunk) hub.onIq(bytes.subarray(at, Math.min(bytes.length, at + chunk)), rate);
  const wall = (performance.now() - t0) / 1000;
  LoraScanner.trace = null; LoraScanner.traceHz = 0;
  for (const e of got) console.log('EVENT ' + e.line);
  const e = got.find(x => x.proto === 'Meshtastic');
  ok(e !== undefined, 'scanner: a Meshtastic event');
  eq(e?.kind, 'NODEINFO_APP', 'scanner: node info');
  eq(hub.nodeList.length, 1, 'scanner: one node');
  console.log(`bursts ${hub.burstCount}, ${(total / rate).toFixed(2)} s of 2 Msps in ${wall.toFixed(2)} s`);
  ok(hub.burstCount >= 1 && hub.burstCount <= 4, 'scanner: 1-4 bursts', `got ${hub.burstCount}`);

  // ---- beyond the Swift test: what the screen gets ----
  ok(msgs.some(x => x.type === 'packet' && / MESHTASTIC 8132 NODEINFO_APP · 906\.87\d SF11\/250k /.test(x.line)), 'emit: packet line');
  hub.flush();
  const snap = msgs.filter(x => x.type === 'lora').pop();
  ok(snap !== undefined && snap.nodes.length === 1 && snap.nodes[0].label === '8132' && snap.nodes[0].name === 'Meshtastic 8132', 'emit: snapshot with the node');
  let clone = null; try { clone = structuredClone(snap); } catch { /* not cloneable */ }
  ok(clone !== null && JSON.parse(JSON.stringify(snap)).nodes[0].key === 'MT/!2bb18132', 'emit: snapshot is plain data');
  ok(snap.channels.some(c => c.name === 'Meshtastic LongFast US' && c.standing && c.frames === 1), 'emit: LongFast US standing, one frame on it');
  eq(snap.wide, false, 'emit: 2 Msps is the narrow span');
  // a repeater's copy of the same packet (its hop fields rewritten) counts, and is not shown again
  const h = heard.find(x => got[heard.indexOf(x)].proto === 'Meshtastic');
  const copy = h.frame.payload.slice(); copy[12] = (copy[12] & ~7) | ((copy[12] & 7) - 1 & 7); copy[15] = 0x77;
  const events = hub.eventList.length;
  hub.heard({ ...h, frame: { ...h.frame, payload: copy } });
  eq(hub.eventList.length, events, 'repeat: no new event');
  eq(hub.nodeList[0].fields.find(f => f.name === 'REPEATS HEARD')?.value, '1', 'repeat: counted on the node');
  hub.clear();
  const last = msgs[msgs.length - 1];
  ok(hub.nodeList.length === 0 && last.type === 'lora' && last.nodes.length === 0 && last.frames === 0, 'clear: empties and re-sends');
}

console.log(`lora-app: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
