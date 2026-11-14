/**
 * Flipper (Unleashed) Sub-GHz remotes, group A (RemotesUlATest.kt / RemotesUlATest.swift): a pulse train built by each
 * protocol's own encoder layout is fed to a fresh decoder, clean and with a few percent of timing jitter, and the hit,
 * the raw key and the parsed fields are checked. Protocols with a check (CRC, sync, repeat match) also get a bad frame.
 */
import { SAllstarFirefly } from '../dist/dsp/ism/s-allstar_firefly.js';
import { SAlutechAt4n } from '../dist/dsp/ism/s-alutech_at_4n.js';
import { SAnsonic } from '../dist/dsp/ism/s-ansonic.js';
import { SBelkorn } from '../dist/dsp/ism/s-belkorn.js';
import { SBenincaArc } from '../dist/dsp/ism/s-beninca_arc.js';
import { SDickertMahs } from '../dist/dsp/ism/s-dickert_mahs.js';
import { SDitecGol4 } from '../dist/dsp/ism/s-ditec_gol4.js';
import { SDoorbell32 } from '../dist/dsp/ism/s-doorbell32.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed++;
  else { failed++; console.error(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}
const hex = (v) => '0x' + BigInt(v).toString(16).toUpperCase();

/** Deterministic jitter: every pulse scaled by one of 100/103/97/102/98 percent (integer math, same on every platform). */
const JIT = [100, 103, 97, 102, 98];
function jitter(pulses) { return pulses.map(([l, d], i) => [l, Math.trunc(d * JIT[i % JIT.length] / 100)]); }

/** Feed pulses to a fresh decoder; returns the hits with the fields read inside the callback. */
function run(Cls, pulses) {
  const p = new Cls();
  const hits = [];
  p.callback = (x) => hits.push({ data: x.decodeData, data2: x.decodeData2, bits: x.dataCountBit, info: x.remoteInfo() });
  for (const [l, d] of pulses) p.feed(l, d);
  return { p, hits };
}

function bitAt(v, i) { return Number((BigInt(v) >> BigInt(i)) & 1n); }
function reverseBits(v, n) { let r = 0n; for (let i = 0; i < n; i++) r = (r << 1n) | BigInt(bitAt(v, i)); return r; }

/** Run one case clean and jittered. */
function both(name, Cls, pulses, verify) {
  for (const [tag, pp] of [['clean', pulses], ['jitter', jitter(pulses)]]) {
    const { hits } = run(Cls, pp);
    verify(`${name} ${tag}`, hits);
  }
}
function expectOne(name, hits) { check(`${name} hits`, hits.length === 1, `got ${hits.length}`); return hits[0]; }
function sameExtra(name, got, want) { check(`${name} extra`, JSON.stringify(got) === JSON.stringify(want), `${JSON.stringify(got)} != ${JSON.stringify(want)}`); }

// ---------------------------------------------------------------- Allstar Firefly (18 bits, Flipper example key 0x34B9)
{
  const key = 0x34B9n, n = 18, ts = 600, tl = 4000;
  const pulses = [[false, ts * 50 + 400]];
  for (let i = n; i > 0; i--) {
    const one = bitAt(key, i - 1);
    pulses.push([true, one ? tl : ts]);
    pulses.push([false, i === 1 ? ts * 50 + 400 : one ? ts : tl]);
  }
  both('allstar', SAllstarFirefly, pulses, (name, hits) => {
    const h = expectOne(name, hits); if (!h) return;
    check(`${name} key`, h.data === key && h.bits === 18, `${hex(h.data)}/${h.bits}`);
    check(`${name} serial/btn/cnt`, h.info.serial === 0n && h.info.btn === null && h.info.cnt === null);
    sameExtra(name, h.info.extra, ['Yek: 0x274B0', '+: __*___*__', 'o: _____*_*_', '-: **__*____']);
    check(`${name} name`, h.info.name === 'Allstar Firefly');
  });
}

// ---------------------------------------------------------------- Alutech AT-4N (64-bit hop + CRC-8)
function alutechCrc(data) {
  let crc = 0xFF;
  for (let y = 0; y < 8; y++) {
    crc ^= Number((data >> BigInt(y * 8)) & 0xFFn);
    for (let i = 0; i < 8; i++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x31) & 0xFF : (crc << 1) & 0xFF;
  }
  return crc;
}
function alutechPulses(hop, crc) {
  const ts = 400, tl = 800, out = [];
  for (let i = 0; i < 12; i++) { out.push([true, ts]); out.push([false, ts]); }
  out[out.length - 1][1] += ts * 9;
  const bit = (b) => { out.push([true, b ? ts : tl]); out.push([false, b ? tl : ts]); };
  for (let i = 64; i > 0; i--) bit(bitAt(hop, i - 1));
  for (let i = 8; i > 0; i--) bit(bitAt(crc, i - 1));
  out[out.length - 1][1] += tl * 20;
  return out;
}
{
  const hop = 0x5A3C96E1F00D2B47n;
  const crc = Number(reverseBits(BigInt(alutechCrc(reverseBits(hop, 64))), 8));
  const pulses = alutechPulses(hop, crc);
  both('alutech', SAlutechAt4n, pulses, (name, hits) => {
    const h = expectOne(name, hits); if (!h) return;
    check(`${name} key`, h.data === hop && h.data2 === BigInt(crc) && h.bits === 72, `${hex(h.data)} ${hex(h.data2)}/${h.bits}`);
    check(`${name} fields`, h.info.serial === 0n && h.info.btn === null && h.info.cnt === null);
    sameExtra(name, h.info.extra, ['CRC: ' + crc.toString(16).toUpperCase().padStart(2, '0'), 'Hop: encrypted']);
  });
  check('alutech crc value', crc === 0x2F, hex(crc));
  // The same hop twice in a row is reported once (Flipper keeps the last key)
  check('alutech repeat once', run(SAlutechAt4n, [...pulses, ...pulses]).hits.length === 1);
  // Bad CRC: one hop bit flipped, CRC kept
  check('alutech bad crc', run(SAlutechAt4n, alutechPulses(hop ^ (1n << 20n), crc)).hits.length === 0);
}

// ---------------------------------------------------------------- Ansonic (12 bits)
{
  const key = 0xAAAn, ts = 555, tl = 1111;
  const pulses = [[false, ts * 35], [true, ts]];
  for (let i = 12; i > 0; i--) {
    if (bitAt(key, i - 1)) { pulses.push([false, ts]); pulses.push([true, tl]); }
    else { pulses.push([false, tl]); pulses.push([true, ts]); }
  }
  pulses.push([false, ts * 35]);
  both('ansonic', SAnsonic, pulses, (name, hits) => {
    const h = expectOne(name, hits); if (!h) return;
    check(`${name} key`, h.data === key && h.bits === 12, `${hex(h.data)}/${h.bits}`);
    check(`${name} btn`, h.info.btn === 1 && h.info.serial === 0n && h.info.cnt === null, `${h.info.btn}`);
    sameExtra(name, h.info.extra, ['DIP: 1010101001']);
  });
}

// ---------------------------------------------------------------- BelKorn (118 bits)
function belkornFrame(serialHi, serial, l24, b3, b4, b5, b6, c, btn) {
  const data = (0x801n << 52n) | (BigInt(serialHi & 0xF) << 48n) | (BigInt(serial) << 16n) | (BigInt(l24 & 0xFF) << 8n) | BigInt((l24 >> 8) & 0xFF);
  const data2 = (BigInt((l24 >> 16) & 0xFF) << 46n) | (BigInt(b3) << 38n) | (BigInt(b4) << 30n) | (BigInt(b5) << 22n) | (BigInt(b6) << 14n) | (BigInt(c) << 6n) | BigInt(btn & 0x3F);
  return [data, data2];
}
function belkornPulses(data, data2) {
  const ts = 481, tl = 962, gap = ts * 16, out = [[false, gap]];
  for (let i = 0; i < 118; i++) {
    const set = i < 64 ? bitAt(data, 63 - i) : bitAt(data2, 117 - i);
    out.push([(i & 1) === 0, set ? tl : ts]);
  }
  out.push([true, ts]); out.push([false, gap]);
  return out;
}
{
  const [d, d2] = belkornFrame(0x5, 0x12345678, 0xABCDEF, 0x11, 0x22, 0x03, 0x44, 0x81, 0x04);
  const pulses = belkornPulses(d, d2);
  both('belkorn', SBelkorn, pulses, (name, hits) => {
    const h = expectOne(name, hits); if (!h) return;
    check(`${name} key`, h.data === d && h.data2 === d2 && h.bits === 118, `${hex(h.data)} ${hex(h.data2)}/${h.bits}`);
    check(`${name} fields`, h.info.serial === 0x512345678n && h.info.btn === 4 && h.info.cnt === 0x0381, `${hex(h.info.serial)} ${h.info.btn} ${h.info.cnt}`);
    sameExtra(name, h.info.extra, ['Key2: ' + d2.toString(16).toUpperCase()]);
  });
  // Format A (even counter low byte): counter high byte comes from b6
  const [e, e2] = belkornFrame(0x0, 0xCAFEBABE, 0x0000E0, 0x10, 0x42, 0x01, 0x01, 0x42, 0x20);
  const ha = run(SBelkorn, belkornPulses(e, e2)).hits;
  check('belkorn format A', ha.length === 1 && ha[0].info.serial === 0xCAFEBABEn && ha[0].info.btn === 0x20 && ha[0].info.cnt === 0x0142, ha.length ? `${hex(ha[0].info.serial)} ${ha[0].info.btn} ${ha[0].info.cnt}` : 'no hit');
  // Broken sync word and a two-button frame are dropped
  check('belkorn bad sync', run(SBelkorn, belkornPulses(d ^ (1n << 60n), d2)).hits.length === 0);
  check('belkorn bad btn', run(SBelkorn, belkornPulses(d, d2 ^ 0x2n)).hits.length === 0);
}

// ---------------------------------------------------------------- Beninca ARC (128 bits)
{
  const d = 0xDEADBEEF01234567n, d2 = 0x89ABCDEF55AA1234n, ts = 300, tl = 600;
  const pulses = [[false, tl * 15]];
  const bit = (b) => { pulses.push([true, b ? ts : tl]); pulses.push([false, b ? tl : ts]); };
  for (let i = 64; i > 0; i--) bit(bitAt(d, i - 1));
  for (let i = 64; i > 0; i--) bit(bitAt(d2, i - 1));
  pulses.push([true, ts]); pulses.push([false, tl * 15]);
  both('beninca', SBenincaArc, pulses, (name, hits) => {
    const h = expectOne(name, hits); if (!h) return;
    check(`${name} key`, h.data === d && h.data2 === d2 && h.bits === 128, `${hex(h.data)} ${hex(h.data2)}/${h.bits}`);
    check(`${name} fields`, h.info.serial === 0n && h.info.btn === null && h.info.cnt === null);
    sameExtra(name, h.info.extra, ['Key2: 89ABCDEF55AA1234', 'Hop: AES-128 encrypted']);
  });
}

// ---------------------------------------------------------------- Dickert MAHS (36 bits)
{
  const code = '+0-+0-+0-+' + '0+-0+-0+';
  let key = 0n;
  for (const ch of code) key = (key << 2n) | (ch === '+' ? 3n : ch === '0' ? 1n : 0n);
  const ts = 400, tl = 800;
  const pulses = [[false, ts * 112], [true, ts]];
  for (let i = 36; i > 0; i--) {
    if (bitAt(key, i - 1)) { pulses.push([false, tl]); pulses.push([true, ts]); }
    else { pulses.push([false, ts]); pulses.push([true, tl]); }
  }
  // Next frame's header and start bit end this one; the hit comes on the event after
  pulses.push([false, ts * 112], [true, ts], [false, ts]);
  both('dickert', SDickertMahs, pulses, (name, hits) => {
    const h = expectOne(name, hits); if (!h) return;
    check(`${name} key`, h.data === key && h.bits === 36, `${hex(h.data)}/${h.bits}`);
    check(`${name} fields`, h.info.serial === 0n && h.info.btn === null && h.info.cnt === null);
    sameExtra(name, h.info.extra, ['User DIPs: +0-+0-+0-+', 'Factory code: 0+-0+-0+']);
  });
}

// ---------------------------------------------------------------- Ditec GOL4 (54 bits)
const rev8 = (b) => { let r = 0; for (let i = 0; i < 8; i++) { r = (r << 1) | ((b >> i) & 1); } return r & 0xFF; };
const lcg = (seed, steps) => { let x = seed & 0xFF; for (let i = 0; i < (steps & 0xFF); i++) x = (21 * x + 1) & 0xFF; return x; };
const par8 = (b) => { let p = 0; for (let i = 0; i < 8; i++) p ^= (b >> i) & 1; return p; };
/** subghz_protocol_ditec_gol4_encode_key without the counter step: serial / btn / cnt -> 54-bit key. */
function gol4Encode(serial, btn, cnt) {
  const raw = [(serial >>> 24) & 0xFF, (serial >>> 8) & 0xFF, btn & 0x0F, serial & 0xFF, (serial >>> 16) & 0xFF, cnt & 0xFF, (cnt >> 8) & 0xFF];
  const dec5 = raw[5] ^ 0xA7, dec6 = raw[6] ^ 0x69;
  const enc6 = lcg(dec6, dec5);
  let enc5 = lcg(dec5, 0xFE);
  if (enc6 & 0x80) enc5 ^= 1;
  raw[5] = enc5; raw[6] = enc6;
  raw[0] = rev8(raw[0]); raw[1] = rev8(raw[1]); raw[3] = rev8(raw[3]); raw[4] = rev8(raw[4]);
  if (raw[2] === 0) raw[2] = 0xF0;
  let b2 = rev8(raw[2]); b2 = ~b2 & 0xFF; b2 = ((b2 << 4) | (b2 >> 4)) & 0xFF; b2 &= 0xDF; raw[2] = b2;
  raw[5] = rev8(raw[5]); raw[6] = rev8(raw[6]);
  const p5 = par8(raw[5]), p6 = par8(raw[6]);
  let carry = 0;
  for (let r = 0; r < 3; r++) for (let i = 6; i >= 2; i--) { const nc = (raw[i] >> 7) & 1; raw[i] = ((raw[i] << 1) | carry) & 0xFF; carry = nc; }
  raw[6] = p5 === p6 ? raw[6] & 0xFB : raw[6] | 0x04;
  let key = 0n;
  for (let i = 0; i < 54; i++) key = (key << 1n) | BigInt((raw[i >> 3] >> (7 - (i & 7))) & 1);
  return key;
}
function gol4Pulses(key) {
  const ts = 400, tl = 1100, out = [[false, tl * 22], [true, ts * 2]];
  for (let i = 54; i > 0; i--) {
    if (bitAt(key, i - 1)) { out.push([false, ts]); out.push([true, tl]); }
    else { out.push([false, tl]); out.push([true, ts]); }
  }
  out.push([false, tl * 22], [true, ts * 2], [false, ts]);
  return out;
}
{
  // Real captures from the Flipper source comments, with their buttons
  const samples = [[0xCCB2F83208122n, 1], [0xCCB1F832103B9n, 0], [0xCCB2F8320ED66n, 1], [0xCCB37832104A6n, 2], [0xCCB3B8320DB4En, 4], [0xCCB3D8320E855n, 8]];
  for (const [k, b] of samples) {
    const r = SDitecGol4.decodeKey(k);
    check(`ditec sample ${hex(k)}`, r.btn === b && r.serial === 0xCC093483n, `btn ${r.btn} serial ${hex(r.serial)}`);
  }
  const key = gol4Encode(0xCC093483, 2, 0x1234);
  both('ditec', SDitecGol4, gol4Pulses(key), (name, hits) => {
    const h = expectOne(name, hits); if (!h) return;
    check(`${name} key`, h.data === key && h.bits === 54, `${hex(h.data)}/${h.bits}`);
    check(`${name} fields`, h.info.serial === 0xCC093483n && h.info.btn === 2 && h.info.cnt === 0x1234, `${hex(h.info.serial)} ${h.info.btn} ${h.info.cnt}`);
    sameExtra(name, h.info.extra, []);
  });
  const prog = run(SDitecGol4, gol4Pulses(gol4Encode(0xCC093483, 0, 0xFFFE))).hits;
  check('ditec prog', prog.length === 1 && prog[0].info.btn === 0 && prog[0].info.cnt === 0xFFFE && prog[0].info.extra[0] === 'Prog mode', prog.length ? JSON.stringify(prog[0].info, (_, v) => typeof v === 'bigint' ? v.toString(16) : v) : 'no hit');
}

// ---------------------------------------------------------------- Doorbell32 (32 bits, two matching frames)
function doorbellFrame(key, te) {
  const out = [];
  for (let i = 32; i > 0; i--) {
    if (bitAt(key, i - 1)) { out.push([true, te * 3]); out.push([false, te]); }
    else { out.push([true, te]); out.push([false, te * 3]); }
  }
  out.push([true, te]); out.push([false, te * 14]);
  return out;
}
{
  const key = 0x8A5C3E91n, te = 515;
  const pulses = [[false, te * 14], ...doorbellFrame(key, te), ...doorbellFrame(key, te)];
  for (const [tag, pp] of [['clean', pulses], ['jitter', jitter(pulses)]]) {
    const { hits, p } = run(SDoorbell32, pp);
    const name = `doorbell ${tag}`;
    const h = expectOne(name, hits); if (!h) continue;
    check(`${name} key`, h.data === key && h.bits === 32, `${hex(h.data)}/${h.bits}`);
    const want = tag === 'clean' ? ['Te: 515 us'] : null;
    if (want) sameExtra(name, h.info.extra, want);
    else check(`${name} te`, /^Te: 5[01]\d us$/.test(h.info.extra[0]), h.info.extra[0]);
    check(`${name} fields`, h.info.serial === 0n && h.info.btn === null && h.info.cnt === null);
    void p;
  }
  // Another Te is measured, not assumed
  const h2 = run(SDoorbell32, [[false, 480 * 14], ...doorbellFrame(key, 480), ...doorbellFrame(key, 480)]).hits;
  check('doorbell te 480', h2.length === 1 && h2[0].info.extra[0] === 'Te: 480 us', h2.length ? h2[0].info.extra[0] : 'no hit');
  // One frame alone, or two frames that differ, are not reported
  check('doorbell single', run(SDoorbell32, [[false, te * 14], ...doorbellFrame(key, te)]).hits.length === 0);
  check('doorbell mismatch', run(SDoorbell32, [[false, te * 14], ...doorbellFrame(key, te), ...doorbellFrame(key ^ 0x100n, te)]).hits.length === 0);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
