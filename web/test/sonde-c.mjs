/**
 * Sondes, bank C: InterMet iMet-1-RSB / iMet-4 (Bell 202 AFSK on FM), InterMet iMet-54 / iMet-50 and Meisei iMS-100 /
 * RS-11G. Frames built the way each sonde builds them go through the frame decoders (CRCs, Hamming and BCH repair,
 * both FM polarities), then all three types on raw IQ through the whole receiver.
 */
import { createHash } from 'node:crypto';
import { ImetDecoder, imetCrc, imetUniqueId } from '../dist/dsp/sonde/imet.js';
import { Imet54Decoder, IMET54_HEADER } from '../dist/dsp/sonde/imet54.js';
import { MeiseiDecoder, MEISEI_HEADER, meiseiBlock, meiseiBlockFix, f32e2, toF32e2 } from '../dist/dsp/sonde/meisei.js';
import { makeBankC } from '../dist/dsp/sonde/bank-c.js';
import { SondeProcessor } from '../dist/dsp/sonde/front.js';
import { Ddc } from '../dist/dsp/trains.js';
import * as S from '../dist/dsp/sonde/synth.js';
import * as C from '../dist/dsp/sonde/synth-c.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const near = (a, b, tol, what) => ok(a !== undefined && Math.abs(a - b) <= tol, what, `got ${a}, want ${b} ± ${tol}`);
const eq = (a, b, what) => ok(a === b, what, `got ${a}, want ${b}`);
console.log('Sondes: iMet-1/iMet-4, iMet-54, Meisei');

const CH = 48_000;
/** The FM discriminator (radians per sample) of int8 IQ, as the receiver's channel computes it; `sign` -1 flips polarity. */
function disc(iq, sign = 1) {
  const n = iq.length >> 1, out = new Float32Array(n);
  let pi = 1, pq = 0;
  for (let i = 0; i < n; i++) {
    const a = iq[2 * i], b = iq[2 * i + 1];
    out[i] = sign * Math.atan2(b * pi - a * pq, a * pi + b * pq);
    pi = a; pq = b;
  }
  return out;
}
const concat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Int8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const bankDec = (name, sink) => makeBankC(CH, sink).find(d => d.name === name);
const sha = (s) => 'IMET-' + createHash('sha256').update(s, 'ascii').digest('hex').toUpperCase().slice(-8);

// ---------------------------------------------------------------- iMet-1 / iMet-4
const NOW = Date.UTC(2026, 10, 14, 15, 0, 0);
const imetData = (k, over = {}) => ({
  frame: 1000 + k, hPa: 850.25, tempC: -12.34, rh: 56.78, battV: 5.6,
  lat: 35.12345 + k * 1e-4, lon: -97.4321 - k * 1e-4, alt: 1500 + 5 * k, sats: 9, timeS: 50_000 + k,
  vE: 3.0, vN: 4.0, vU: 5.25, ext: [21.5, -3.25, -11.75], ...over,
});
{
  eq(imetCrc([...'123456789'].map(c => c.charCodeAt(0)), 0, 9), 0xe5cc, 'iMet CRC-16/AUG-CCITT check value');

  // iMet-4: frame counter once a second; the first frame is held back to tell iMet-1 from iMet-4
  const got = [];
  const dec = new ImetDecoder(CH, f => got.push(f));
  dec.hz = 402_012_000; dec.clock = () => NOW;
  const b0 = Uint8Array.from(C.imetBurst(imetData(0))), b1 = Uint8Array.from(C.imetBurst(imetData(1, { xdata: [0x01, 0x07, 0x12, 0x34, 0x09, 0xc4, 0x50, 0x0e] })));
  eq(dec.parseBurst(b0, b0.length), null, 'iMet first frame held back (model decision)');
  const f = dec.parseBurst(b1, b1.length);
  eq(f?.type, 'iMet', 'iMet type');
  eq(f?.model, 'iMet-4', 'iMet-4 from the counter rate');
  const powerOn = Date.UTC(2026, 10, 14) + (50_001 - 1001) * 1000;
  const want = sha(new Date(powerOn).toISOString().slice(0, 19) + 'Z' + '402.000 MHz' + 'SONDE');
  eq(f?.serial, want, 'iMet-4 ID = auto_rx SHA-256(power-on time + frequency)');
  eq(imetUniqueId(powerOn, 402_012_000), want, 'iMet ID helper');
  eq(f?.frame, 1001, 'iMet frame counter');
  near(f?.lat, 35.12355, 1e-5, 'iMet latitude');
  near(f?.lon, -97.4322, 1e-5, 'iMet longitude');
  eq(f?.alt, 1505, 'iMet altitude');
  eq(f?.sats, 9, 'iMet satellites');
  eq(f?.timeS, 50_001, 'iMet GPS time of day');
  near(f?.vH, 5.0, 1e-5, 'iMet ground speed (eGPS)');
  near(f?.heading, 36.87, 0.01, 'iMet heading (eGPS)');
  near(f?.climb, 5.25, 1e-5, 'iMet climb (eGPS, CRC at its real offset 0x1C)');
  near(f?.tempC, -12.34, 1e-9, 'iMet temperature');
  near(f?.rh, 56.78, 1e-9, 'iMet humidity');
  near(f?.hPa, 850.25, 1e-9, 'iMet pressure');
  near(f?.battV, 5.6, 1e-9, 'iMet battery');
  near(f?.tHumC, -11.75, 1e-9, 'iMet humidity-sensor temperature (ePTU)');
  eq(f?.extra?.AUX, 'ozone (ECC)', 'iMet XDATA instrument');
  eq(f?.extra?.['AUX DATA'], '01071234' + '09C4500E', 'iMet XDATA payload');
  eq(got.length, 1, 'iMet sink got the frame');
  // same sonde, next second: same ID
  const b2 = Uint8Array.from(C.imetBurst(imetData(2)));
  eq(dec.parseBurst(b2, b2.length)?.serial, want, 'iMet ID stable frame to frame');
  // CRC: a damaged PTU packet means no report; a damaged GPS packet means no position
  const bad = b2.slice(); bad[30 + 8] ^= 0x10;
  eq(dec.parseBurst(bad, bad.length), null, 'iMet damaged PTU rejected (CRC)');
  const badG = Uint8Array.from(C.imetBurst(imetData(3))); badG[5] ^= 0x01;
  const g = new ImetDecoder(CH, () => {}); g.clock = () => NOW;
  const fg = g.parseBurst(badG, badG.length);
  ok(fg !== null && fg.lat === undefined, 'iMet damaged GPS packet: PTU only, no position');
  // plain GPS + plain PTU packets
  const plain = new ImetDecoder(CH, () => {}); plain.clock = () => NOW; plain.hz = 403_500_000;
  const pb = (k) => Uint8Array.from(C.imetBurst(imetData(k, { vE: undefined, ext: undefined })));
  plain.parseBurst(pb(0), pb(0).length);
  const fp = plain.parseBurst(pb(1), pb(1).length);
  near(fp?.alt, 1505, 0, 'iMet plain GPS packet');
  eq(fp?.climb, undefined, 'iMet plain GPS has no velocity');
  eq(fp?.serial, sha(new Date(powerOn).toISOString().slice(0, 19) + 'Z403.500 MHzSONDE'), 'iMet ID with the other frequency');

  // iMet-1: the counter runs twice a second
  const d1 = new ImetDecoder(CH, () => {}); d1.clock = () => NOW; d1.hz = 402_012_000;
  const i1 = (k) => Uint8Array.from(C.imetBurst(imetData(k, { frame: 400 + 2 * k })));
  d1.parseBurst(i1(0), i1(0).length);
  const f1 = d1.parseBurst(i1(1), i1(1).length);
  eq(f1?.model, 'iMet-1-RSB', 'iMet-1 from the counter rate');
  eq(f1?.serial, sha(new Date(Date.UTC(2026, 10, 14) + (50_001 - 201) * 1000).toISOString().slice(0, 19) + 'Z402.000 MHzSONDE'), 'iMet-1 ID (counter / 2)');
  // no GPS lock: frequency-only ID, no position
  const nl = new ImetDecoder(CH, () => {}); nl.hz = 402_012_000;
  const bn = Uint8Array.from(C.imetBurst(imetData(0, { sats: 2 })));
  const fn = nl.parseBurst(bn, bn.length);
  eq(fn?.serial, sha('402.000 MHzSONDE'), 'iMet without lock: ID from the frequency alone');
  eq(fn?.lat, undefined, 'iMet without lock: no position');

  // the tone demodulator: AFSK on FM, both FM polarities
  for (const sign of [1, -1]) {
    const out = [];
    const d = new ImetDecoder(CH, fr => out.push(fr)); d.clock = () => NOW; d.hz = 402_012_000;
    const iq = concat([0, 1, 2].map(k => C.afskFmIq(C.imetLineBits(C.imetBurst(imetData(k)), 30, 600), CH, 1500 * sign, 4000, 22, 0.02, new S.Prng(20 + k))));
    const x = disc(iq, sign);
    for (let i = 0; i < x.length; i++) d.push(x[i]);
    eq(out.length, 2, `iMet AFSK on FM, ${sign > 0 ? 'normal' : 'inverted'} polarity: frames`);
    eq(out[0]?.serial, want, `iMet AFSK on FM, ${sign > 0 ? 'normal' : 'inverted'}: ID`);
    eq(out[1]?.frame, 1002, `iMet AFSK on FM, ${sign > 0 ? 'normal' : 'inverted'}: frame`);
    near(out[1]?.climb, 5.25, 1e-5, `iMet AFSK on FM, ${sign > 0 ? 'normal' : 'inverted'}: climb`);
  }
}

// ---------------------------------------------------------------- iMet-54
const i54 = (k, over = {}) => ({ serial: 55064506, timeS: 41718 + k, lat: -25.91298 - k * 1e-5, lon: 28.20926, alt: 2627.3 + 8 * k, tempC: 14.9, rh: 69.73, tRh: 15.53, ...over });
{
  const dec = new Imet54Decoder();
  const fr = C.imet54Frame(i54(0));
  const f = dec.parse(fr);
  eq(f?.type, 'iMet-54', 'iMet-54 type');
  eq(f?.model, 'iMet-54', 'iMet-54 model');
  eq(f?.serial, '55064506', 'iMet-54 serial');
  eq(f?.timeS, 41718, 'iMet-54 time');
  eq(f?.frame, 41718, 'iMet-54 frame = seconds of day');
  near(f?.lat, -25.91298, 2e-6, 'iMet-54 latitude');
  near(f?.lon, 28.20926, 2e-6, 'iMet-54 longitude');
  near(f?.alt, 2627.3, 0.05, 'iMet-54 altitude');
  near(f?.tempC, 14.9, 1e-4, 'iMet-54 temperature');
  near(f?.tHumC, 15.53, 1e-4, 'iMet-54 humidity-sensor temperature');
  near(f?.rh, 69.73 * 1.0412, 0.3, 'iMet-54 humidity corrected to air temperature');
  eq(f?.extra?.CRC, 'frame', 'iMet-54 whole-frame CRC');
  // through the symbols: Hamming code, interleave, 8N1
  const syms = C.imet54Symbols(fr);
  const hdrAt = syms.join('').indexOf(IMET54_HEADER, 18 * 10);
  eq(hdrAt, 18 * 10, 'iMet-54 header in the preamble');
  const soft = Float32Array.from(syms.slice(hdrAt + 40, hdrAt + 40 + 2200), b => (b ? 1 : -1));
  const fs = new Imet54Decoder().decode(soft);
  eq(fs?.serial, '55064506', 'iMet-54 from symbols');
  eq(fs?.fixed, 0, 'iMet-54 clean');
  // one wrong bit in each of 40 codewords: repaired
  const dmg = soft.slice();
  for (let k = 0; k < 40; k++) { const g = 3 + 8 * (k % 27) + (k >> 3) % 8, j = k % 8; dmg[g * 10 + 1 + j] *= -1; }
  const fd = new Imet54Decoder().decode(dmg);
  eq(fd?.serial, '55064506', 'iMet-54 Hamming repairs one bit per codeword');
  eq(fd?.fixed, 40, 'iMet-54 reports repaired codewords');
  // two wrong bits in one codeword: detected, the CRC then rejects the frame
  const two = soft.slice();
  two[(3 + 8 * 2 + 0) * 10 + 1 + 2] *= -1; two[(3 + 8 * 2 + 1) * 10 + 1 + 2] *= -1;
  eq(new Imet54Decoder().decode(two), null, 'iMet-54 double error in a codeword: rejected');
  const crcBad = fr.slice(); crcBad[0x1d] ^= 0x04;
  eq(dec.parse(crcBad), null, 'iMet-54 damaged frame rejected (CRC)');
  // the newer firmware's CRC over the first 52 bytes alone
  const fc = C.imet54Frame(i54(0, { cont: true }));
  eq(dec.parse(fc)?.extra?.CRC, 'both', 'iMet-54 both CRCs');
  const contOnly = fc.slice(); contOnly[0x40] ^= 0xff;
  eq(dec.parse(contOnly)?.extra?.CRC, 'first 52 bytes', 'iMet-54 first-52-byte CRC alone accepted');
  const contBad = contOnly.slice(); contBad[0x10] ^= 1;
  eq(dec.parse(contBad), null, 'iMet-54 both CRCs failing: rejected');
  // iMet-50: GPS only, PTU sensors absent
  const f50 = dec.parse(C.imet54Frame(i54(0, { tempC: undefined, rh: undefined, tRh: undefined, status: 0x0030 })));
  eq(f50?.model, 'iMet-50', 'iMet-50 recognized');
  eq(f50?.tempC, undefined, 'iMet-50 no temperature');
  near(f50?.alt, 2627.3, 0.05, 'iMet-50 altitude');
  eq(dec.parse(C.imet54Frame(i54(0, { status: 0x000e }))), null, 'iMet-54 without GPS status rejected');

  // the real frame from imet54.txt (its first 44 bytes; zeros after, the CRCs computed over that)
  const real = new Uint8Array(108);
  real.set([0x03, 0x48, 0x37, 0xBA, 0x06, 0xC4, 0x25, 0xB0, 0xFE, 0x7A, 0x2B, 0xF6, 0x01, 0xAD, 0x29, 0x71, 0x00, 0x00, 0x66, 0xA1,
    0, 0, 0, 0, 0, 0, 0, 0, 0x41, 0x6E, 0x81, 0x4E, 0x42, 0x8B, 0x74, 0x18, 0x41, 0x78, 0x83, 0x80, 0x62, 0x10, 0x00, 0x3E]);
  C.imet54SetStd(real);
  const fr0 = dec.parse(real);
  eq(fr0?.serial, '55064506', 'iMet-54 real frame: serial');
  eq(fr0?.timeS, 11 * 3600 + 35 * 60 + 18, 'iMet-54 real frame: 11:35:18');
  near(fr0?.lat, -25.91298, 5e-6, 'iMet-54 real frame: latitude');
  near(fr0?.lon, 28.20926, 1e-5, 'iMet-54 real frame: longitude');
  near(fr0?.alt, 2627.3, 0.01, 'iMet-54 real frame: altitude');
  near(fr0?.tempC, 14.9, 0.05, 'iMet-54 real frame: temperature');
  eq(Math.round(fr0?.rh), 73, 'iMet-54 real frame: humidity 73%');

  // on the FM channel, both polarities
  for (const sign of [1, -1]) {
    const out = [];
    const d = bankDec('iMet-54', f => out.push(f));
    const iq = concat([0, 1].map(k => S.fskIq([...C.imet54Symbols(C.imet54Frame(i54(k))), ...new Array(400).fill(0).map((_, i) => i & 1)], 4800, CH, 0, 1920 * sign, 30, 0.02, new S.Prng(40 + k))));
    const x = disc(iq);
    for (let i = 0; i < x.length; i++) d.push(x[i]);
    eq(out.length, 2, `iMet-54 on FM, ${sign > 0 ? 'normal' : 'inverted'} polarity: frames`);
    eq(out[1]?.serial, '55064506', `iMet-54 on FM, ${sign > 0 ? 'normal' : 'inverted'}: serial`);
    near(out[1]?.alt, 2635.3, 0.05, `iMet-54 on FM, ${sign > 0 ? 'normal' : 'inverted'}: altitude`);
  }
}

// ---------------------------------------------------------------- Meisei
{
  // BCH(46,34): random blocks, up to two wrong bits repaired; parity bits are odd
  const rng = new S.Prng(5);
  let good = 0, caught = 0;
  for (let t = 0; t < 300; t++) {
    const blk = new Uint8Array(46), A = Math.floor(rng.next() * 65536), B = Math.floor(rng.next() * 65536);
    meiseiBlock(A, B, blk, 0);
    const ref = blk.slice(), ne = t % 3;
    const used = new Set(); while (used.size < ne) used.add(Math.floor(rng.next() * 46));
    for (const p of used) blk[p] ^= 1;
    if (meiseiBlockFix(blk, 0) === ne && blk.every((v, i) => v === ref[i])) good++;
    // three wrong bits: never handed back as the original
    const b3 = ref.slice(); const u3 = new Set(); while (u3.size < 3) u3.add(Math.floor(rng.next() * 46));
    for (const p of u3) b3[p] ^= 1;
    if (meiseiBlockFix(b3, 0) < 0 || !b3.every((v, i) => v === ref[i])) caught++;
  }
  eq(good, 300, 'Meisei BCH(46,34) repairs up to 2 bits');
  eq(caught, 300, 'Meisei BCH beyond 2 bits never passes as the original');
  near(f32e2(toF32e2(-12.375)), -12.375, 0, 'RS-11G float format round trip');
  // biphase-S: the encoder's 0x049DCE is the header (or its inverse)
  const hb = []; for (let k = 0; k < 24; k++) hb.push((0x049dce >> (23 - k)) & 1);
  const raw = new C.BiphaseS().encode(hb).join(''), inv = [...MEISEI_HEADER].map(c => (c === '1' ? '0' : '1')).join('');
  ok(raw === MEISEI_HEADER || raw === inv, 'Meisei header is biphase-S 0x049DCE', raw);
}
const msFlight = (c) => ({ lat: 35.6812 + c * 1e-5, lon: 139.7671 + c * 2e-5, alt: 1234.56 + c, vH: 7.5, heading: 271.25, climb: 5.2,
  timeS: 3 * 3600 + 4 * 60 + c / 2, year: 2026, month: 11, day: 14, tRaw: 0, uRaw: 0, fRef: 60000 });
function meiseiRun(model, c0, n, tempC, rhWant, dmg) {
  const cfg = C.meiseiCfg(model, 412345, 403_500);
  const d = new MeiseiDecoder(); d.refYear = 2026;
  const outs = [];
  for (let c = c0; c < c0 + n; c++) {
    const fd = msFlight(c);
    fd.tRaw = C.meiseiTRaw(model, cfg, tempC, fd.fRef); fd.uRaw = Math.round(rhWant / 100 * fd.fRef);
    const b = C.meiseiFrame(model, c, fd, cfg);
    if (dmg) dmg(b, c);
    const f = d.parse(b);
    if (f) outs.push(f);
  }
  return outs;
}
for (const model of ['iMS-100', 'RS-11G']) {
  const outs = meiseiRun(model, 0, 130, -23.4, 42);
  const f = outs[outs.length - 1];
  eq(outs.length, 65, `${model}: one report per frame pair`);
  eq(f?.type, 'MEISEI', `${model} type`);
  eq(f?.model, model, `${model} model from word 7`);
  eq(f?.serial, '412345', `${model} serial from the config table`);
  eq(f?.frame, 128, `${model} frame counter`);
  near(f?.lat, 35.6812 + 128e-5, 2e-6, `${model} latitude`);
  near(f?.lon, 139.7671 + 256e-5, 2e-6, `${model} longitude`);
  near(f?.alt, 1234.56 + 128, 0.006, `${model} altitude`);
  near(f?.vH, 7.5, 0.01, `${model} ground speed`);
  near(f?.heading, 271.25, 0.006, `${model} heading`);
  near(f?.climb, 5.2, 0.06, `${model} climb`);
  near(f?.tempC, -23.4, 0.05, `${model} temperature from the calibration table`);
  near(f?.rh, 42, 0.01, `${model} humidity`);
  eq(f?.txKHz, 403_500, `${model} reported frequency`);
  eq(f?.date, '2026-11-14', `${model} date`);
  near(f?.timeS, 3 * 3600 + 4 * 60 + (model === 'iMS-100' ? 64 : 64.5), 0.001, `${model} time`);
  eq(f?.fixed, 0, `${model} clean`);
  eq(f?.extra?.CALIBRATION, '64/64', `${model} whole config table`);
  // two wrong bits in every block of both subframes: repaired (RS-11G trusts single-bit repairs only)
  // (iMS-100 keeps a config word only when its blocks needed at most one repair, like the reference decoder)
  const nb = (k) => (model === 'iMS-100' ? (k < 2 ? 1 : 2) : 1);
  const rep = meiseiRun(model, 32, 4, -23.4, 42, (b) => { for (let k = 0; k < 12; k++) for (let e = 0; e < nb(k); e++) b[300 * (k >= 6 ? 1 : 0) + 24 + 46 * (k % 6) + 5 + 20 * e] ^= 1; });
  let want = 0; for (let k = 0; k < 12; k++) want += nb(k);
  eq(rep.length, 2, `${model}: BCH repairs ${model === 'iMS-100' ? 'two bits' : 'a bit'} in every block`);
  eq(rep[1]?.fixed, want, `${model} reports repaired bits`);
  near(rep[1]?.lat, 35.6812 + 34e-5, 2e-6, `${model} repaired latitude`);
  // three wrong bits in subframe 0's first block: the frame is dropped
  const drop = meiseiRun(model, 32, 4, -23.4, 42, (b, c) => { if (c === 34) for (const p of [3, 9, 30]) b[24 + p] ^= 1; });
  eq(drop.length, 1, `${model}: an unrepairable block drops its frame`);
}
{
  // iMS-100: the GPS checksum guards the position
  const outs = meiseiRun('iMS-100', 32, 4, 0, 10, (b, c) => {
    if (c === 34) { const w = []; for (let j = 0; j < 2; j++) { let v = 0; for (let k = 0; k < 16; k++) v = (v << 1) | b[300 + 24 + 46 * 5 + 17 * j + k]; w.push(v); } meiseiBlock(w[0], (w[1] + 1) & 0xffff, b, 300 + 24 + 46 * 5); }
  });
  eq(outs.length, 1, 'iMS-100 bad GPS checksum: that report is dropped');
  eq(outs[0]?.frame, 32, 'iMS-100 the good pair still reports');
}
{
  // on the FM channel, both polarities (biphase-S does not care, the framer finds either header sign)
  for (const sign of [1, -1]) {
    const out = [];
    const d = bankDec('MEISEI', f => out.push(f));
    const cfg = C.meiseiCfg('iMS-100', 412345, 403_500), bp = new C.BiphaseS();
    const raw = [];
    for (let c = 30; c < 40; c++) raw.push(...bp.encode(C.meiseiFrame('iMS-100', c, { ...msFlight(c), tRaw: 20000, uRaw: 3000 }, cfg)));
    const x = disc(S.fskIq(raw, 2400, CH, 0, 2400 * sign, 30, 0.02, new S.Prng(60)));
    for (let i = 0; i < x.length; i++) d.push(x[i]);
    ok(out.length >= 3, `Meisei on FM, ${sign > 0 ? 'normal' : 'inverted'} polarity: reports`, `${out.length}`);
    eq(out[0]?.serial, '412345', `Meisei on FM, ${sign > 0 ? 'normal' : 'inverted'}: serial`);
    eq(out[0]?.frame, 32, `Meisei on FM, ${sign > 0 ? 'normal' : 'inverted'}: frame`);
    near(out[0]?.alt, 1234.56 + 32, 0.006, `Meisei on FM, ${sign > 0 ? 'normal' : 'inverted'}: altitude`);
  }
}


// ---------------------------------------------------------------- noise margin: 15 dB, five seeds, both polarities
// IQ at 192 kHz through the receiver's own channel filter (Ddc, 11 kHz) and discriminator. SNR as each generator
// defines it: fskIq per symbol bandwidth (Meisei: per 2400 Hz half-symbol), afskFmIq over the FM bandwidth.
function channel(iq, rate, sign) {
  const ddc = new Ddc(11_000, 48_000, 63); ddc.reset(rate); ddc.offsetHz = 0;
  const n = iq.length >> 1, re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) { re[i] = iq[2 * i] / 128; im[i] = iq[2 * i + 1] / 128; }
  const oi = new Float32Array(ddc.maxOut(n)), oq = new Float32Array(ddc.maxOut(n));
  const k = ddc.push(re, im, n, oi, oq), x = new Float32Array(k);
  let pi = 1, pq = 0;
  for (let i = 0; i < k; i++) { x[i] = sign * Math.atan2(oq[i] * pi - oi[i] * pq, oi[i] * pi + oq[i] * pq); pi = oi[i]; pq = oq[i]; }
  return { x, rate: ddc.outRate };
}
{
  const R = 192_000, SNR = 15;
  const idle = (n) => new Array(n).fill(0).map((_, i) => i & 1);
  const gen = {
    iMet: (seed) => concat([...Array(11).keys()].map(k => { const b = C.imetLineBits(C.imetBurst(imetData(k)), 30, 0); while (b.length < 1200) b.push(1); return C.afskFmIq(b, R, 0, 4000, SNR, 0, new S.Prng(seed * 31 + k)); })),
    'iMet-54': (seed) => concat([...Array(10).keys()].map(k => { const s = C.imet54Symbols(C.imet54Frame(i54(k))); return S.fskIq([...idle(1200), ...s, ...idle(3600 - s.length)], 4800, R, 0, 1920, SNR, 0, new S.Prng(seed * 31 + k)); })),
    MEISEI: (seed) => { const cfg = C.meiseiCfg('iMS-100', 412345, 403_500), bp = new C.BiphaseS(); const raw = []; for (let c = 30; c < 52; c++) raw.push(...bp.encode(C.meiseiFrame("iMS-100", c, { ...msFlight(c), tRaw: 20000, uRaw: 3000 }, cfg))); return S.fskIq(raw, 2400, R, 0, 2400, SNR, 0.05, new S.Prng(seed)); },
  };
  for (const t of Object.keys(gen)) {
    const counts = [];
    for (const sign of [1, -1]) for (const seed of [1, 2, 3, 4, 5]) {
      const out = [];
      const { x, rate } = channel(gen[t](seed), R, sign);
      const d = makeBankC(rate, f => out.push(f)).find(dd => dd.name === t);
      d.hz = 402_000_000;
      for (let i = 0; i < x.length; i++) d.push(x[i]);
      counts.push(out.length);
    }
    ok(counts.every(c => c === 10), `${t} at ${SNR} dB: 10 of 10 frames, 5 seeds, both polarities`, counts.join(' '));
  }
}

// ---------------------------------------------------------------- the whole receiver: all three on raw IQ at 2.4 Msps
function run(proc, iq, rate, chunk = 131072) {
  for (let o = 0; o < iq.length; o += chunk) proc.onIq(iq.subarray(o, Math.min(iq.length, o + chunk)), rate);
}
{
  const rate = 2_400_000, secs = 6, center = 402_500_000;
  const parts = [];
  // iMet-4 at 402.150 MHz: one burst a second, idle mark between
  {
    const segs = [];
    for (let k = 0; k < secs; k++) {
      const bits = C.imetLineBits(C.imetBurst(imetData(k)), 30, 0);
      while (bits.length < 1200) bits.push(1);
      segs.push(C.afskFmIq(bits, rate, -350_000, 4000, 25, 0, new S.Prng(100 + k), 40));
    }
    parts.push(concat(segs));
  }
  // iMet-54 at 402.750 MHz: one frame a second
  {
    const segs = [];
    for (let k = 0; k < secs; k++) {
      const s = C.imet54Symbols(C.imet54Frame(i54(k)));
      const fill = new Array(4800 - s.length).fill(0).map((_, i) => i & 1);
      segs.push(S.fskIq([...s, ...fill], 4800, rate, 250_000, 1920, 25, 0, new S.Prng(200 + k), 40));
    }
    parts.push(concat(segs));
  }
  // iMS-100 at 403.000 MHz: continuous, two frames a second
  {
    const cfg = C.meiseiCfg('iMS-100', 412345, 403_000), bp = new C.BiphaseS();
    const segs = [];
    for (let c = 44; c < 44 + 2 * secs; c++) segs.push(S.fskIq(bp.encode(C.meiseiFrame('iMS-100', c, { ...msFlight(c), tRaw: 20000, uRaw: 3000 }, cfg)), 2400, rate, 500_000, 2400, 25, 0, new S.Prng(300 + c), 40));
    parts.push(concat(segs));
  }
  const n = Math.min(...parts.map(p => p.length)), iq = new Int8Array(n);
  for (let i = 0; i < n; i++) { let v = parts[0][i] + parts[1][i] + parts[2][i]; iq[i] = v > 127 ? 127 : v < -127 ? -127 : v; }
  const msgs = [];
  const proc = new SondeProcessor(m => msgs.push(m));
  proc.setBand('400');
  proc.reset(rate);
  proc.setCenter(center);
  const t0 = Date.now();
  run(proc, iq, rate);
  const wall = (Date.now() - t0) / 1000;
  const rows = proc.tracker.rows(Date.now());
  const log = `rows ${rows.map(r => `${r.type}/${r.model}/${r.serial}@${r.hz}`).join(',')}; log ${msgs.filter(m => m.type === 'log').map(m => m.line).join(' | ')}`;
  const im = rows.find(r => r.type === 'iMet'), i5 = rows.find(r => r.type === 'iMet-54'), me = rows.find(r => r.type === 'MEISEI');
  ok(!!im && /^IMET-[0-9A-F]{8}$/.test(im.serial), 'iMet-4 through the receiver', log);
  eq(im?.model, 'iMet-4', 'iMet-4 model through the receiver');
  near(im?.hz, 402_150_000, 3000, 'iMet-4 channel frequency');
  eq(i5?.serial, '55064506', 'iMet-54 through the receiver');
  ok((i5?.frames ?? 0) >= 3, 'iMet-54 several frames through the receiver', `frames ${i5?.frames}`);
  eq(me?.serial, '412345', 'iMS-100 through the receiver');
  eq(me?.model, 'iMS-100', 'iMS-100 model through the receiver');
  ok((me?.frames ?? 0) >= 3, 'iMS-100 several frames through the receiver', `frames ${me?.frames}`);
  console.log(`  (receiver: ${wall.toFixed(1)} s for ${secs} s of 2.4 Msps, three sondes)`);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
