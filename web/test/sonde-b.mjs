/**
 * Sondes, bank B (SondeTestB.kt / SondeTestB.swift): Vaisala RS92 (SGP and NGP), Lockheed Martin LMS6-403, LMSX and
 * LMS6-1680, MRZ. Frames built the way each sonde builds them, through the frame decoders and the channel decoders
 * (symbol slicer, header search in both FM polarities), the published test vectors, then FSK on raw IQ through the
 * whole receiver.
 */
import { makeBankB } from '../dist/dsp/sonde/bank-b.js';
import { Rs92Decoder, RS92_HEADER } from '../dist/dsp/sonde/rs92.js';
import { Lms6Decoder, LmsxDecoder, LMS6_HEADER, LMS6_SYNC_STATE, lmsParse } from '../dist/dsp/sonde/lms6.js';
import { Mk2aDecoder, mk2aLength, MK2A_HEADER } from '../dist/dsp/sonde/mk2a.js';
import { MrzDecoder, MRZ_HEADER } from '../dist/dsp/sonde/mrz.js';
import { Viterbi, convEncode } from '../dist/dsp/sonde/viterbi.js';
import { SondeProcessor } from '../dist/dsp/sonde/front.js';
import * as S from '../dist/dsp/sonde/synth.js';
import * as B from '../dist/dsp/sonde/synth-b.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const near = (a, b, tol, what) => ok(a !== undefined && Math.abs(a - b) <= tol, what, `got ${a}, want ${b} ± ${tol}`);
const eq = (a, b, what) => ok(a === b, what, `got ${a}, want ${b}`);
const hex = (s) => Uint8Array.from(s.replace(/[^0-9a-fA-F]/g, '').match(/../g), h => parseInt(h, 16));
const bitsLsb = (bytes) => S.bitsOf(bytes, true);
console.log('Sondes: RS92, LMS6-403, LMSX, LMS6-1680, MRZ');

const flight = (k) => ({ lat: 39.7392 + k * 1e-4, lon: -104.9903 + k * 2e-4, alt: 1600 + k * 5.1, vN: 3.0, vE: 4.0, vU: 5.1 });
const fall = (k) => ({ lat: -33.9 + k * 1e-4, lon: 151.2 - k * 1e-4, alt: 20_000 - k * 12, vN: -6.0, vE: -2.5, vU: -12.0 });

/**
 * Channel symbols as an ideal discriminator (radians/sample) at `rate`, through every bank-B channel decoder. A run of
 * idle alternating symbols before and after; `invert` flips the FM polarity; `flip` lists symbol indexes to corrupt.
 */
function feed(syms, baud, { rate = 48_000, invert = false, flip = [], idle = 64 } = {}) {
  const out = [];
  const decs = makeBankB(rate, f => out.push(f));
  const all = [...new Array(idle).fill(0).map((_, i) => i & 1), ...syms, ...new Array(idle).fill(0).map((_, i) => i & 1)];
  const bad = new Set(flip.map(i => i + idle));
  const n = Math.floor(all.length * rate / baud), amp = invert ? -0.3 : 0.3;
  const rng = new S.Prng(77);
  for (let t = 0; t < n; t++) {
    const k = Math.floor(t * baud / rate);
    let v = all[k] ? amp : -amp;
    if (bad.has(k)) v = -v;
    v += 0.05 * rng.gauss();
    for (const d of decs) d.push(v);
  }
  return out;
}

// ---- the convolutional code: the sync's code symbols are the published ones; Viterbi repairs scattered errors
{
  const blkSync = '0000000000000000' + '0000001101011101' + '0100100111000010' + '0100111111110010' + '0110100001101011';
  const code = new Uint8Array(80);
  convEncode(bitsLsb([0x00, 0x58, 0xf3, 0x3f, 0xb8]), 0, code, 0);
  eq(Array.from(code).join(''), blkSync, 'LMS6 sync bytes encode to the published code symbols');
  const raw = Array.from(code.slice(16), (c, i) => (i & 1 ? 1 - c : c)).join('');
  eq(raw, LMS6_HEADER, 'LMS6 header = the sync code with every second symbol inverted');
  const rng = new S.Prng(5);
  const bits = Array.from({ length: 2000 }, () => (rng.next() < 0.5 ? 1 : 0));
  const c2 = new Uint8Array(4000);
  convEncode(bits, LMS6_SYNC_STATE, c2, 0);
  const soft = Float32Array.from(c2, v => (v ? 1 : -1));
  let flips = 0;
  for (let i = 0; i < soft.length; i += 37) { soft[i] = -soft[i]; flips++; }
  const out = new Uint8Array(2000);
  const errs = new Viterbi(2000).decode(soft, 0, 2000, LMS6_SYNC_STATE, out);
  ok(out.every((b, i) => b === bits[i]), 'Viterbi corrects scattered symbol errors');
  eq(errs, flips, 'Viterbi counts the symbols it repaired');
}

// ---- RS92: the published frame
const RS92_VECTOR = '2a2a2a2a2a10' + '6510' + 'e81820204b34393533393334006100083d3d07b342bb3e9809d3bc3f754c963b' + 'ebfb' +
  '690c' + 'ca2b0fd9670f00670f8c0f11a458111e8810da410d30430d' + 'dc84' +
  '673d' + 'b01c852167ab07298b3cb05a536e0fffcf4faf7f4f3fff8fcfffffffff7fe5918aef20e8110175879900d0e0e900061f8c048aa393009edea1fe2557dc0019549f04b5160d00ae998b00e12a4200370b8608cacc1900b3e08905bd60040126da9303e1d4b4006d04a00573469700d6a98b00699f120195828f04' + '6ed7' +
  '6805' + '03030000000000000000' + 'b27d' + 'ff02' + '02000200' + 'f0be2a40a7cd69b9ed0668ec12182e8560ea6dd0733612a1';
{
  const v = hex(RS92_VECTOR);
  eq(v.length, 240, 'RS92 vector is a whole frame');
  const r = new Rs92Decoder().parse(v.slice());
  eq(r?.serial, 'K4953934', 'RS92 vector: serial');
  eq(r?.frame, 6376, 'RS92 vector: frame number');
  eq(r?.fixed, 0, 'RS92 vector: RS parity checks (no repair)');
  eq(r?.extra?.CALIBRATION, '1/32', 'RS92 vector: one calibration row');
  eq(r?.lat, undefined, 'RS92 vector: no position (raw GPS)');
  eq(r?.extra?.POSITION, 'raw GPS only (needs an ephemeris)', 'RS92 says why there is no position');
  ok(r?.timeS !== undefined && r.timeS >= 0 && r.timeS < 86400, 'RS92 vector: GPS time of day', `${r?.timeS}`);
  // the same frame off the air: 8N1 Manchester symbols after the 60-symbol header
  const syms = B.rs92Symbols(v);
  eq(syms.slice(60, 120).join(''), RS92_HEADER, 'RS92 header symbols');
  eq(new Rs92Decoder().decode(Float32Array.from(syms.slice(120), b => (b ? 1 : -1)))?.serial, 'K4953934', 'RS92 vector from symbols');
  // damage: 12 bytes repaired, then too many
  const bad = v.slice(); for (let i = 0; i < 12; i++) bad[10 + i * 17] ^= 0x5a;
  const rb = new Rs92Decoder().parse(bad);
  eq(rb?.serial, 'K4953934', 'RS92 Reed-Solomon repairs 12 bytes');
  eq(rb?.fixed, 12, 'RS92 reports bytes repaired');
  const worse = v.slice(); for (let i = 0; i < 30; i++) worse[8 + i * 7] ^= 0x33;
  eq(new Rs92Decoder().parse(worse), null, 'RS92 beyond repair is rejected');
}

// ---- RS92 frames from the encoder: 33 frames bring the whole calibration table in
function rs92Run(ngp, serial = 'P3141592', n = 33) {
  const cal = B.rs92CalTable(ngp ? 1_680_000 : 402_150, 0x0e10, ngp);
  const ptu = B.rs92PtuCounts(-20, 60, 40, 850);
  const frames = [];
  for (let k = 0; k < n; k++) frames.push(B.rs92Frame({ serial, frame: 500 + k, cal, ptu, towMs: 3 * 86_400_000 + 45_296_000 + k * 1000, prns: [2, 5, 7, 12, 13, 15, 19, 24, 30], aux: [0x1234, 0, 0, 0xabcd], ngp }));
  return frames;
}
{
  for (const ngp of [false, true]) {
    const name = ngp ? 'RS92-NGP' : 'RS92-SGP';
    const dec = new Rs92Decoder();
    let last = null;
    for (const fr of rs92Run(ngp)) last = dec.parse(fr);
    eq(last?.serial, 'P3141592', `${name} serial`);
    eq(last?.frame, 532, `${name} frame number`);
    eq(last?.model, name, `${name} model from the calibration table`);
    eq(last?.extra?.CALIBRATION, '32/32', `${name} whole calibration table`);
    near(last?.tempC, -20, 0.01, `${name} temperature`);
    near(last?.rh, 60, 0.01, `${name} humidity (the higher sensor)`);
    near(last?.hPa, 850, 0.05, `${name} pressure`);
    eq(last?.txKHz, ngp ? 1_680_000 : 402_150, `${name} reported frequency`);
    eq(last?.killS, 0x0e10, `${name} burst timer`);
    eq(last?.sats, 9, `${name} satellites tracked`);
    eq(last?.extra?.PRN, '2 5 7 12 13 15 19 24 30', `${name} PRNs`);
    eq(last?.timeS, 45_296 + 32, `${name} GPS time of day`);
    eq(last?.extra?.['GPS WEEKDAY'], 'Wed', `${name} GPS weekday`);
    eq(last?.extra?.AUX, '12340000' + '0000abcd', `${name} aux words`);
    eq(last?.lat, undefined, `${name} leaves the position undefined`);
    eq(last?.battV, undefined, `${name} sends no battery voltage`);
  }
  // through the channel decoders, both polarities, with symbol errors for the RS to repair
  const frames = rs92Run(false, 'P2718281', 3);
  const syms = frames.flatMap(f => B.rs92Symbols(f));
  for (const invert of [false, true]) {
    const out = feed(syms, 4800, { invert, flip: [500, 501, 1500, 1501, 2600, 2601, 3334, 3335, 6000, 6001, 7776, 7777] }).filter(f => f.type === 'RS92');
    eq(out.length, 3, `RS92 channel decoder, ${invert ? 'inverted' : 'upright'} FM`);
    eq(out[0]?.serial, 'P2718281', `RS92 channel decoder serial, ${invert ? 'inverted' : 'upright'}`);
    ok((out[0]?.fixed ?? 0) > 0, 'RS92 channel decoder repaired the flipped symbols', `fixed ${out[0]?.fixed}`);
  }
}

// ---- LMS6-403: the published RS block
const LMS6_VECTOR = '0058f33fb8' +
  '24540000007a9a4a1f130cbf07ebffe6d5a724379382ffa65ed3014af1e700c57f0030fc0016f30038062d1f83e87e6e1cfb46c5882b80000000000000000010241f93527ea51cf0fe0e092c1f7d6199e91cf727050300840000000000000000022d1f82806c481cf28f241a1e1f988f57a41cf61524172a1f8a93d8971cfad879072f1f82ce07431ced04ee05291f8d40eddb1ceaddfb1e2b1f8d3b04691ce93c511d1b1f95ed89031cf18e5203c33700000003a60a09b3110000000000001be4360fc22803c34903c35003c34c03c34c00000026ee3986069d361682f5fb' +
  'b00f3bd474dc5798959cb3abbd9a6b81a50b3bbbfeaf87cdc15a220cf5e6c437';
function checkLms6Vector(f, what) {
  eq(f?.serial, 'LMS6-8034890', `${what}: serial`);
  eq(f?.type, 'LMS6', `${what}: type`);
  eq(f?.model, 'LMS6-403', `${what}: model`);
  eq(f?.frame, 7955, `${what}: frame counter`);
  near(f?.timeS, 213_845.995 - 2 * 86400, 1e-6, `${what}: GPS time of day`);
  eq(f?.extra?.['GPS WEEKDAY'], 'Tue', `${what}: GPS weekday`);
  near(f?.lat, 50.930289, 1e-6, `${what}: latitude`);
  near(f?.lon, -0.492350, 1e-6, `${what}: longitude`);
  near(f?.alt, 21688.807, 1e-3, `${what}: altitude`);
  near(f?.vH, Math.hypot(50.559, 12.540), 1e-3, `${what}: ground speed`);
  near(f?.heading, Math.atan2(50.559, 12.540) * 180 / Math.PI, 1e-3, `${what}: heading`);
  near(f?.climb, 5.875, 1e-3, `${what}: climb`);
}
{
  const v = hex(LMS6_VECTOR);
  eq(v.length, 260, 'LMS6 vector is a whole block');
  const fr = new Lms6Decoder().blockBytes(v.slice(), false);
  eq(fr.length, 1, 'LMS6 vector: one frame in the block');
  checkLms6Vector(fr[0], 'LMS6 vector');
  eq(fr[0]?.fixed, 0, 'LMS6 vector: RS parity checks (no repair)');
  // the block off the air: convolutional code, the header, the Viterbi
  const syms = B.lmsSymbols(v);
  eq(syms.slice(16, 80).join(''), LMS6_HEADER, 'LMS6 vector: header symbols');
  const soft = Float32Array.from(syms.slice(80), b => (b ? 1 : -1));
  for (let i = 0; i < soft.length; i += 29) soft[i] = -soft[i];
  const fs = new Lms6Decoder().decode(soft, false);
  checkLms6Vector(fs[0], 'LMS6 vector through the Viterbi (3% symbol errors)');
  // RS: 16 bytes repaired, 17+ rejected
  const bad = v.slice(); for (let i = 0; i < 16; i++) bad[6 + i * 15] ^= 0xc3;
  const rb = new Lms6Decoder().blockBytes(bad, false);
  eq(rb[0]?.serial, 'LMS6-8034890', 'LMS6 Reed-Solomon repairs 16 bytes');
  eq(rb[0]?.fixed, 16, 'LMS6 reports bytes repaired');
  const worse = v.slice(); for (let i = 0; i < 24; i++) worse[6 + i * 10] ^= 0x3c;
  eq(new Lms6Decoder().blockBytes(worse, false).length, 0, 'LMS6 beyond repair is rejected');
  const crcBad = v.slice(5, 228); crcBad[30] ^= 1;
  eq(lmsParse(crcBad, false), null, 'LMS6 frame with a bad CRC is rejected');
}

// ---- LMS6-403 and LMSX from the encoder, through the channel decoders
const lmsOpts = (k, p = fall) => ({ sn: 0x123456, frame: 300 + k, towMs: 4 * 86_400_000 + 3_600_000 + k * 1000, p: p(k) });
function checkLms(f, k, what, x) {
  const p = fall(k);
  eq(f?.serial, `${x ? 'LMSX' : 'LMS6'}-${0x123456}`, `${what}: serial`);
  eq(f?.model, x ? 'LMSX' : 'LMS6-403', `${what}: model`);
  eq(f?.frame, 300 + k, `${what}: frame counter`);
  near(f?.timeS, 3600 + k, 1e-6, `${what}: GPS time of day`);
  near(f?.lat, p.lat, x ? 1e-7 : 1e-7, `${what}: latitude`);
  near(f?.lon, p.lon, 1e-7, `${what}: longitude`);
  near(f?.alt, p.alt, x ? 0.01 : 0.001, `${what}: altitude`);
  near(f?.vH, Math.hypot(p.vN, p.vE), 0.01, `${what}: ground speed`);
  near(f?.heading, (Math.atan2(p.vE, p.vN) * 180 / Math.PI + 360) % 360, 0.01, `${what}: heading`);
  near(f?.climb, p.vU, 0.01, `${what}: climb`);
}
{
  // frames straddle the 260-byte blocks (34 fill bytes between frames, like the real 13:15 drift)
  const frames = Array.from({ length: 5 }, (_, k) => B.lms6Frame(lmsOpts(k)));
  const syms = B.lmsSymbols(B.lms6Blocks(frames, 34));
  for (const invert of [false, true]) {
    const flip = []; for (let i = 300; i < syms.length; i += 41) flip.push(i);
    const out = feed(syms, 4800, { invert, flip });
    const l6 = out.filter(f => f.serial.startsWith('LMS6'));
    eq(l6.length, 5, `LMS6 channel decoder: all frames across blocks, ${invert ? 'inverted' : 'upright'} FM`);
    checkLms(l6[3], 3, `LMS6 channel decoder (${invert ? 'inverted' : 'upright'})`, false);
    eq(out.filter(f => f.serial.startsWith('LMSX') || f.type !== 'LMS6').length, 0, 'LMS6 signal decodes as nothing else');
  }
  // a gap in the block stream: the frame cut by it is dropped, never stitched to the wrong bytes
  const blocks = B.lms6Blocks(frames, 34);
  const dec = new Lms6Decoder();
  let got = [];
  for (let k = 0; k < blocks.length / 260; k++) if (k !== 2) got = got.concat(dec.blockBytes(blocks.slice(260 * k, 260 * k + 260), k !== 3));
  ok(got.length >= 2 && got.length < 5 && got.every(f => f.frame >= 300 && f.frame <= 304), 'LMS6 stream restarts after a missed block', got.map(f => f.frame).join(','));
}
{
  const frames = Array.from({ length: 4 }, (_, k) => B.lmsxFrame(lmsOpts(k)));
  const syms = B.lmsSymbols(B.lmsxUnits(frames));
  for (const invert of [false, true]) {
    const flip = []; for (let i = 200; i < syms.length; i += 37) flip.push(i);
    const out = feed(syms, 4797.8, { invert, flip });
    const lx = out.filter(f => f.serial.startsWith('LMSX'));
    eq(lx.length, 4, `LMSX channel decoder, ${invert ? 'inverted' : 'upright'} FM`);
    checkLms(lx[2], 2, `LMSX channel decoder (${invert ? 'inverted' : 'upright'})`, true);
    eq(out.filter(f => !f.serial.startsWith('LMSX')).length, 0, 'LMSX signal decodes as nothing else');
  }
  // the codeword 35 bytes late (block byte 40), RS repair, and beyond repair
  const unit = new Uint8Array(300);
  unit.set([0x00, 0x58, 0xf3, 0x3f, 0xb8], 0); unit.fill(0xca, 5, 40);
  unit.set(B.lmsCodeword(frames[1]), 40);
  checkLms(new LmsxDecoder().unit(unit), 1, 'LMSX codeword at block byte 40', true);
  const bad = unit.slice(); for (let i = 0; i < 15; i++) bad[41 + i * 16] ^= 0x99;
  eq(new LmsxDecoder().unit(bad)?.fixed, 15, 'LMSX Reed-Solomon repairs 15 bytes');
  const worse = unit.slice(); for (let i = 0; i < 40; i++) worse[42 + i * 6] ^= 0x99;
  eq(new LmsxDecoder().unit(worse), null, 'LMSX beyond repair is rejected');
}

// ---- LMS6-1680 / Mk2a: the published subframes (a 0x4D with the full serial, a 0x54 with GPS)
const MK2A_4D = '24 52 4D 31 EC 64 05 D8 00 38 0D 03 B9 B2 19 FA 6C 11 D6 32 19 FC 86 1F F8 56 0F FF FD 1D FD 74 11 F6 4E 03 B9 BD 03 B9 D4 03 B9 C5 03 B9 BA 03 B9 BE EC 64 00 6B 00 0D 6D 07 60 13 71 56 9A CB 42 38 E4 15 CA CA CA CA';
const MK2A_54 = '24 52 54 32 EC 64 05 D7 00 A2 19 94 37 BB FF EE 84 92 21 41 60 82 B8 57 DA EF 00 1B FD 3E 00 07 BD FF F9 A0 00 0E E8 00 30 0A 10 28 0F 14 00 84 35 5F 47 1C FB 32 8E 07 2E 0F 14 00 83 07 E0 E2 1C EC F4 4D 0A 2B 0F 14 00 8B EE 8C 09 1C F6 1B C8 06 26 0F 14 00 83 AF 54 27 1C F3 08 C3 08 29 0F 14 00 91 E7 40 26 1C EA F7 A2 0D 2B 0F 14 00 79 F5 EB D4 1C F4 CE C8 13 24 0F 14 00 89 DB 4B F1 1C EA 78 64 17 2B 0F 14 00 7E A0 15 A5 1C F9 BA C4 03 27 0F 14 00 80 6F 4F 86 1C EE A7 8A 05 26 0F 14 00 98 60 25 99 1C ED EE 47 B4 B5 CA CA CA';
{
  const c = hex(MK2A_4D), g = hex(MK2A_54);
  eq(mk2aLength(c, c.length), 66, 'LMS6-1680 vector: config subframe length from its CRC');
  eq(mk2aLength(g, g.length), 172, 'LMS6-1680 vector: GPS subframe length from its CRC');
  const dec = new Mk2aDecoder();
  eq(dec.parse(g, 172), null, 'LMS6-1680 waits for the full serial');
  eq(dec.parse(c, 66), null, 'LMS6-1680 config subframe gives the serial (no report of its own)');
  const f = dec.parse(g, 172);
  eq(f?.serial, `LMS6-${0x006bec64}`, 'LMS6-1680 vector: serial');
  eq(f?.type, 'LMS6', 'LMS6-1680 vector: type');
  eq(f?.model, 'LMS6-1680', 'LMS6-1680 vector: model');
  eq(f?.frame, 1495, 'LMS6-1680 vector: frame counter');
  near(f?.timeS, 429_143.995 - 4 * 86400, 1e-6, 'LMS6-1680 vector: GPS time of day');
  eq(f?.extra?.['GPS WEEKDAY'], 'Thu', 'LMS6-1680 vector: GPS weekday');
  near(f?.lat, 46.765379, 1e-6, 'LMS6-1680 vector: latitude');
  near(f?.lon, -100.767403, 1e-6, 'LMS6-1680 vector: longitude');
  near(f?.alt, 1834.302, 1e-3, 'LMS6-1680 vector: altitude');
  near(f?.vH, Math.hypot(1.981, -1.632), 1e-3, 'LMS6-1680 vector: ground speed');
  near(f?.heading, 129.5, 0.1, 'LMS6-1680 vector: heading');
  near(f?.climb, 3.816, 1e-3, 'LMS6-1680 vector: climb');
  eq(dec.parse(g, 172), null, 'LMS6-1680 repeat of the same frame is not reported twice');
  const bad = g.slice(); bad[20] ^= 4;
  eq(new Mk2aDecoder().parse(bad, 172), null, 'LMS6-1680 bad CRC is rejected');
  // the real subframes off the air, through the channel decoder, both polarities
  const syms = B.mk2aSymbols([c.slice(0, 68), c.slice(0, 68), g.slice(0, 174), g.slice(0, 174)]);
  eq(syms.slice(60, 110).join(''), MK2A_HEADER, 'LMS6-1680 header symbols');
  for (const invert of [false, true]) {
    const out = feed(syms, 9616, { invert });
    eq(out.length, 1, `LMS6-1680 channel decoder, real subframes, ${invert ? 'inverted' : 'upright'} FM`);
    eq(out[0]?.serial, `LMS6-${0x006bec64}`, `LMS6-1680 channel decoder serial (${invert ? 'inverted' : 'upright'})`);
  }
}
{
  // the encoder: config then GPS each second, every subframe twice
  const id = 0x00a1b2c3, subs = [];
  for (let k = 0; k < 3; k++) {
    const c = B.mk2aConfig(id, 900 + k), g = B.mk2aGps(id, 900 + k, 5 * 86_400_000 + 7_200_000 + k * 1000, flight(k));
    subs.push(c, c, g, g);
  }
  const syms = B.mk2aSymbols(subs);
  for (const invert of [false, true]) {
    const out = feed(syms, 9616, { invert });
    eq(out.length, 3, `LMS6-1680 channel decoder, one report per frame, ${invert ? 'inverted' : 'upright'} FM`);
    const f = out[2], p = flight(2);
    eq(f?.serial, `LMS6-${0x00a1b2c3}`, 'LMS6-1680 encoder: serial');
    eq(f?.frame, 902, 'LMS6-1680 encoder: frame counter');
    near(f?.timeS, 7200 + 2, 1e-6, 'LMS6-1680 encoder: GPS time of day');
    near(f?.lat, p.lat, 1e-6, 'LMS6-1680 encoder: latitude');
    near(f?.lon, p.lon, 1e-6, 'LMS6-1680 encoder: longitude');
    near(f?.alt, p.alt, 1e-3, 'LMS6-1680 encoder: altitude');
    near(f?.vH, 5, 1e-3, 'LMS6-1680 encoder: ground speed');
    near(f?.heading, 53.13, 0.01, 'LMS6-1680 encoder: heading');
    near(f?.climb, 5.1, 1e-3, 'LMS6-1680 encoder: climb');
  }
  // a damaged GPS subframe (both copies) is dropped, the next second still decodes
  const dmg = feed(syms, 9616, { flip: [4000, 6000] });
  ok(dmg.length >= 2, 'LMS6-1680 symbol errors lose at most that frame', `${dmg.length}`);
  const flipAll = []; for (let i = 2000; i < 9000; i += 300) flipAll.push(i);
  ok(feed(syms, 9616, { flip: flipAll }).every(f => f.serial === `LMS6-${0x00a1b2c3}` && f.frame >= 900), 'LMS6-1680 never reports a damaged subframe');
}

// ---- MRZ: slots C (sonde serial), D (sensor serial), F (date), E (calibration date) and the rest
const mrzSlots = [[0xc, 12345678], [0xd, 87654321], [0xf, 141126], [0xe, 10926], [0x0, 0x3f800000], [0x1, 0x40000000]];
function mrzFrames(latlon = false, n = mrzSlots.length) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const [slot, word] = mrzSlots[k % mrzSlots.length];
    out.push(B.mrzFrame({ slot, word, h: 13, m: 45, s: 10 + k, p: fall(k), sats: 11, tempC: -31.25, rh: 47.5, latlon }));
  }
  return out;
}
{
  const dec = new MrzDecoder();
  const fr = mrzFrames();
  eq(dec.parse(fr[0]), null, 'MRZ waits for both serials');
  let last = null;
  for (const f of fr.slice(1)) last = dec.parse(f) ?? last;
  const p = fall(5);
  eq(last?.serial, 'MRZ-12345678-87654321', 'MRZ serial (sonde and sensor boom)');
  eq(last?.type, 'MRZ', 'MRZ type');
  eq(last?.date, '2026-11-14', 'MRZ date from its config slot');
  eq(last?.timeS, 13 * 3600 + 45 * 60 + 15, 'MRZ UTC time of day');
  eq(last?.frame, (Date.UTC(2026, 10, 14) - Date.UTC(1980, 0, 6)) / 1000 + 13 * 3600 + 45 * 60 + 15, 'MRZ frame = GPS-epoch seconds');
  near(last?.lat, p.lat, 1e-6, 'MRZ latitude (ECEF)');
  near(last?.lon, p.lon, 1e-6, 'MRZ longitude (ECEF)');
  near(last?.alt, p.alt, 0.02, 'MRZ altitude (ECEF)');
  near(last?.vH, Math.hypot(p.vN, p.vE), 0.02, 'MRZ ground speed');
  near(last?.heading, (Math.atan2(p.vE, p.vN) * 180 / Math.PI + 360) % 360, 0.3, 'MRZ heading');
  near(last?.climb, p.vU, 0.02, 'MRZ climb');
  eq(last?.sats, 11, 'MRZ satellites');
  near(last?.tempC, -31.25, 1e-9, 'MRZ temperature');
  near(last?.rh, 47.5, 1e-9, 'MRZ humidity');
  eq(last?.extra?.['CALIBRATION DATE'], '010926', 'MRZ calibration date');
  eq(dec.parse(fr[5]), null, 'MRZ repeat of the same second is reported once');
  const bad = fr[5].slice(); bad[12] ^= 0x10;
  eq(new MrzDecoder().parse(bad), null, 'MRZ bad CRC is rejected');
  // lat/lon frames (FF FF marker, 42-byte CRC)
  const dl = new MrzDecoder();
  let l = null;
  for (const f of mrzFrames(true)) l = dl.parse(Uint8Array.from([...f, 0xaa, 0xaa, 0xaa])) ?? l;
  near(l?.lat, p.lat, 1e-6, 'MRZ latitude (lat/lon frame)');
  near(l?.lon, p.lon, 1e-6, 'MRZ longitude (lat/lon frame)');
  near(l?.alt, p.alt, 0.01, 'MRZ altitude (lat/lon frame, MSL)');
  near(l?.vH, Math.hypot(p.vN, p.vE), 0.01, 'MRZ ground speed (lat/lon frame)');
  near(l?.tempC, -31.25, 1e-9, 'MRZ temperature (lat/lon frame)');
  eq(l?.climb, undefined, 'MRZ lat/lon frame has no climb');
  // off the air, both polarities, six copies of each frame
  const syms = B.mrzSymbols(fr, 6);
  eq(syms.slice(4 * 16 - 32, 4 * 16 + 12).join(''), MRZ_HEADER, 'MRZ header symbols');
  for (const invert of [false, true]) {
    const out = feed(syms, 2399, { invert, flip: [] });
    eq(out.length, 5, `MRZ channel decoder: one report per second once the serials are in, ${invert ? 'inverted' : 'upright'} FM`);
    eq(out[0]?.serial, 'MRZ-12345678-87654321', `MRZ channel decoder serial (${invert ? 'inverted' : 'upright'})`);
    eq(out.filter(f => f.type !== 'MRZ').length, 0, 'MRZ signal decodes as nothing else');
  }
}

// ---- no false decodes: other types' signals and random symbols decode as nothing in this bank
{
  const cal = S.rs41CalTable('RS41-SG');
  const rs41 = []; for (let k = 0; k < 3; k++) rs41.push(...S.rs41Symbols(S.rs41Frame('T7654321', k, flight(k), cal, -20, { week: 2400, towMs: k * 1000 })), ...new Array(4800 - 2560).fill(0).map((_, i) => i & 1));
  eq(feed(rs41, 4800).length, 0, 'RS41 signal: nothing from bank B');
  const rs92 = rs92Run(false, 'P2718281', 3).flatMap(f => B.rs92Symbols(f));
  ok(feed(rs92, 4800).every(f => f.type === 'RS92'), 'RS92 signal decodes as nothing else');
  const mk = B.mk2aSymbols([B.mk2aConfig(0x00a1b2c3, 1), B.mk2aGps(0x00a1b2c3, 1, 1000, flight(1))]);
  ok(feed(mk, 9616).every(f => f.model === 'LMS6-1680'), 'LMS6-1680 signal decodes as nothing else');
  const rng = new S.Prng(99);
  for (const baud of [2399, 4800, 9616]) {
    const junk = Array.from({ length: baud * 4 }, () => (rng.next() < 0.5 ? 1 : 0));
    eq(feed(junk, baud).length, 0, `random symbols at ${baud} Bd: no frames`);
  }
}

// ---- the whole receiver: FSK on raw IQ at 2.4 Msps, some hundreds of kHz off the center
function iqOf(syms, baud, rate, offsetHz, dev, snr = 25) {
  // a second at a time, each with its own noise (like rs41Iq in sonde.mjs)
  const per = Math.round(baud), parts = [];
  for (let k = 0; k * per < syms.length; k++) parts.push(S.fskIq(syms.slice(k * per, (k + 1) * per), baud, rate, offsetHz, dev, snr, 0, new S.Prng(100 + k)));
  const out = new Int8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function run(proc, iq, rate, chunk = 131072) {
  for (let o = 0; o < iq.length; o += chunk) proc.onIq(iq.subarray(o, Math.min(iq.length, o + chunk)), rate);
}
let rxTime = 0, rxSeconds = 0;
function receiver(what, band, centerHz, offsetHz, syms, baud, dev, serial, type, model) {
  const msgs = [], rate = 2_400_000;
  const proc = new SondeProcessor(m => msgs.push(m));
  proc.setBand(band);
  proc.reset(rate);
  proc.setCenter(centerHz - offsetHz);
  const iq = iqOf(syms, baud, rate, offsetHz, dev);
  const t0 = Date.now();
  run(proc, iq, rate);
  rxTime += Date.now() - t0; rxSeconds += iq.length / 2 / rate;
  const rows = proc.tracker.rows(Date.now());
  // the tracker drops a family prefix the card already shows ("LMS6-1193046" → "1193046")
  const shown = serial.startsWith(type + '-') ? serial.slice(type.length + 1) : serial;
  const s = rows.find(r => r.serial === shown);
  ok(!!s, `${what} through the receiver`, `rows ${rows.map(r => r.serial).join(',')}; log ${msgs.filter(m => m.type === 'log').map(m => m.line).join(' | ')}`);
  eq(s?.type, type, `${what} receiver row type`);
  if (model) eq(s?.model, model, `${what} receiver row model`);
  ok((s?.frames ?? 0) >= 2, `${what} several frames through the receiver`, `frames ${s?.frames}`);
  near(s?.hz, centerHz, 3000, `${what} channel frequency`);
  return s;
}
{
  // RS92-SGP: 5 frames, 1 s each
  const rs = rs92Run(false, 'P1618033', 5).flatMap(f => B.rs92Symbols(f));
  receiver('RS92', '400', 402_150_000, 310_000, rs, 4800, 1920, 'P1618033', 'RS92');
  // LMS6-403: 6 frames across 7 blocks
  const l6 = B.lmsSymbols(B.lms6Blocks(Array.from({ length: 6 }, (_, k) => B.lms6Frame(lmsOpts(k))), 34));
  const r6 = receiver('LMS6-403', '400', 403_400_000, -270_000, l6, 4800, 2160, `LMS6-${0x123456}`, 'LMS6', 'LMS6-403');
  ok(r6?.lat !== undefined, 'LMS6-403 receiver row has a position');
  // LMSX: 5 units
  const lx = B.lmsSymbols(B.lmsxUnits(Array.from({ length: 5 }, (_, k) => B.lmsxFrame(lmsOpts(k)))));
  receiver('LMSX', '400', 404_800_000, 420_000, lx, 4797.8, 2160, `LMSX-${0x123456}`, 'LMS6', 'LMSX');
  // MRZ: the slot cycle twice, two copies each
  const mz = B.mrzSymbols(mrzFrames(false, 12), 2);
  receiver('MRZ', '400', 401_500_000, -350_000, mz, 2399, 4800, 'MRZ-12345678-87654321', 'MRZ');
  // LMS6-1680 at 1680 MHz: config + GPS twice a second, idle CA to fill the second
  const subs = [];
  for (let k = 0; k < 5; k++) { const c = B.mk2aConfig(0x00a1b2c3, 900 + k), g = B.mk2aGps(0x00a1b2c3, 900 + k, 7_200_000 + k * 1000, flight(k)); subs.push(c, c, g, g); }
  let mk = [];
  for (let k = 0; k < 5; k++) { const sec = B.mk2aSymbols(subs.slice(4 * k, 4 * k + 4)); mk = mk.concat(sec, B.uartBits(new Array(Math.floor((9616 - sec.length) / 10)).fill(0xca))); }
  receiver('LMS6-1680', '1680', 1_680_000_000, 260_000, mk, 9616, 40_000, `LMS6-${0x00a1b2c3}`, 'LMS6', 'LMS6-1680');
  console.log(`  (receiver: ${(rxTime / 1000).toFixed(1)} s for ${rxSeconds.toFixed(1)} s of 2.4 Msps over 5 types)`);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
