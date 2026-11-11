/**
 * The LoRa receiver on two real Meshtastic packets (LongFast, SF11 / 250 kHz) recorded off the air with a HackRF,
 * sent by the owner's own node with known contents; the Meshtastic layer on top of it. Port of LoraPhyTest.swift
 * (LoraPhyTest and MeshtasticTest).
 */
import { readFileSync } from 'node:fs';
import { LoraReceiver, LoraCodec } from '../dist/dsp/lora/phy.js';
import { Aes128 } from '../dist/dsp/lora/aes128.js';
import { Meshtastic, portName } from '../dist/dsp/lora/meshtastic.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), what, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

const clip = name => { const raw = readFileSync(new URL(`./resources/${name}.i8`, import.meta.url)); return Float32Array.from(new Int8Array(raw.buffer, raw.byteOffset, raw.length)); };

const frames = (name, chunk = 8192) => {
  const x = clip(name);
  const rx = new LoraReceiver(11, 250_000);
  const got = [];
  rx.onFrame = f => got.push(f);
  for (let at = 0; at < x.length; at += chunk) rx.push(x.subarray(at, Math.min(x.length, at + chunk)));
  return got;
};

// testRealPacketA
{
  const f = frames('meshtastic_nodeinfo_a_250k_sf11');
  eq(f.length, 1, 'A: one frame');
  const p = f[0];
  if (p) {
    eq(p.crcOk, true, 'A: CRC ok');
    eq(p.payload.length, 66, 'A: 66 bytes');
    eq(Array.from(p.payload.subarray(0, 12)), [0xff, 0xff, 0xff, 0xff, 0x32, 0x81, 0xb1, 0x2b, 0x0e, 0x62, 0x46, 0xd4], 'A: first 12 bytes');
    console.log(`A: cfo ${p.cfoHz} Hz, snr ${p.snrDb} dB, sync [${p.sync}]`);
  }
}
// testRealPacketB
{
  const f = frames('meshtastic_nodeinfo_b_250k_sf11');
  eq(f[0]?.crcOk, true, 'B: CRC ok');
  eq(Array.from(f[0]?.payload.subarray(0, 12) ?? []), [0xff, 0xff, 0xff, 0xff, 0x32, 0x81, 0xb1, 0x2b, 0x10, 0x96, 0xeb, 0xf5], 'B: first 12 bytes');
}
// testWhitening
eq(Array.from(LoraCodec.whitening.subarray(0, 8)), [0xFF, 0xFE, 0xFC, 0xF8, 0xF0, 0xE1, 0xC2, 0x85], 'whitening sequence');

// MeshtasticTest.testAesVector (FIPS-197 appendix C.1)
{
  const key = Array.from({ length: 16 }, (_, i) => i);
  const pt = [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
  eq(hex(Aes128.encrypt(pt, Aes128.expand(key))), '69c4e0d86a7b0430d8cdb78070b4c55a', 'AES-128 FIPS-197 C.1');
}
// MeshtasticTest.testLongFastHash
eq(Meshtastic.channelHash('LongFast', Meshtastic.defaultKey), 0x08, 'LongFast channel hash');
// MeshtasticTest.testRealNodeInfo (the whole clip in one push)
{
  const rx = new LoraReceiver(11, 250_000);
  const got = [];
  rx.onFrame = f => got.push(f);
  rx.push(clip('meshtastic_nodeinfo_a_250k_sf11'));
  const pkt = got[0] ? Meshtastic.parse(got[0].payload) : null;
  ok(pkt !== null, 'node info parses');
  if (pkt) {
    eq(pkt.from, 0x2bb18132, 'from');
    eq(pkt.dest, 0xFFFFFFFF, 'dest');
    eq(pkt.id, 0xd446620e, 'id');
    eq(portName(pkt), 'NODEINFO_APP', 'port');
    eq(pkt.longName, 'Meshtastic 8132', 'long name');
    eq(pkt.shortName, '8132', 'short name');
    eq(pkt.hwModel, 'HELTEC_MESH_NODE_T114', 'hardware');
    console.log(JSON.stringify(pkt.fields));
  }
}

console.log(`lora-phy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
