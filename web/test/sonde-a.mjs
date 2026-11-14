/**
 * Sondes, bank A (SondeTestA.kt / SondeTestA.swift): Graw DFM-06/09/17/PS-15, Meteomodem M10/M10+/M2K2/M20 and
 * Meteosis MTS01. Frames built the way each sonde builds them, through the frame decoders; reference vectors from the
 * spec so the encoder and decoder can't be wrong together; damage rejected or repaired; both FM polarities through the
 * channel decoders; no cross-type false decodes; then every type at once on raw IQ through the whole receiver.
 */
import { DfmDecoder, dfmHamming, dfmTempFromR, dfmFl24 } from '../dist/dsp/sonde/dfm.js';
import { M10Decoder, checkM10, m10TempFromR, m10Serial, m20Serial } from '../dist/dsp/sonde/m10.js';
import { Mts01Decoder, mts01Crc, mts01TempFromR } from '../dist/dsp/sonde/mts01.js';
import { makeBankA } from '../dist/dsp/sonde/bank-a.js';
import { SondeProcessor } from '../dist/dsp/sonde/front.js';
import * as A from '../dist/dsp/sonde/synth-a.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const near = (a, b, tol, what) => ok(a !== undefined && Math.abs(a - b) <= tol, what, `got ${a}, want ${b} ± ${tol}`);
const eq = (a, b, what) => ok(a === b, what, `got ${a}, want ${b}`);
console.log('Sondes: DFM, M10/M20, MTS01');

const flight = (k) => ({ lat: 39.7392 + k * 1e-4, lon: -104.9903 + k * 2e-4, alt: 1600 + k * 5.1, vN: 3.0, vE: 4.0, vU: 5.1 });
const T0 = Date.UTC(2026, 10, 14, 12, 34, 50);   // 2026-11-14 12:34:50 UTC
const enc = (s) => Array.from(s, c => c.charCodeAt(0));

// ---- reference vectors from the spec (independent of the encoders)
{
  eq(checkM10(enc('123456789'), 9), 0xF6D4, 'M10 checksum vector "123456789"');
  eq(checkM10([0x64, 0x9F], 2), 0x3E42, 'M10 checksum vector 64 9F');
  eq(checkM10(Array.from({ length: 100 }, (_, i) => i), 100), 0xBA7F, 'M10 checksum vector 00..63');
  eq(mts01Crc(enc('123456789'), 0, 9), 0xE775, 'MTS01 CRC vector "123456789"');
  const table = [0x00, 0x1E, 0x2D, 0x33, 0x4B, 0x55, 0x66, 0x78, 0x87, 0x99, 0xAA, 0xB4, 0xCC, 0xD2, 0xE1, 0xFF];
  ok(table.every((v, n) => dfmHamming(n) === v), 'DFM Hamming(8,4) codeword table');
  // thermistor tables from the sources (R/R25 for the DFM NTC, kilohms for the M10)
  near(dfmTempFromR(2.7936 * 5000), 0, 0.3, 'DFM NTC: 0 °C');
  near(dfmTempFromR(1.0 * 5000), 25, 0.3, 'DFM NTC: 25 °C');
  near(dfmTempFromR(20.96 * 5000), -40, 0.5, 'DFM NTC: -40 °C');
  near(m10TempFromR(15.00e3), 0, 0.5, 'M10 NTC: 0 °C');
  near(m10TempFromR(5.370e3), 25, 0.5, 'M10 NTC: 25 °C');
  near(m10TempFromR(112.6e3), -40, 0.5, 'M10 NTC: -40 °C');
  near(mts01TempFromR(15.0), 0, 1e-9, 'MTS01 thermistor: 0 °C at R0');
  eq(dfmFl24(0x2ABCDE), 0xABCDE / 4, 'DFM float24');
  // serial formats from the raw bytes
  eq(m10Serial(Uint8Array.from([0x42, 0x00, 0x93, 0xD2, 0x24]), 0), '903-2-11234', 'M10 serial format (raw bytes)');
  eq(m20Serial((5 * 12 + 11) | (0 << 7) | (4350 << 10) | (1 << 23), 0), '512-1-14350', 'M20 serial format');
  eq(m20Serial(0, 7), '000-0-00000-007', 'M20 blank serial');
}

// ---- DFM frames
function dfmRun(opts, nFrames, inv = false, mangle = null) {
  const tx = new A.DfmTx(opts), dec = new DfmDecoder(), outs = [];
  for (let i = 0; i < nFrames; i++) {
    const bits = Uint8Array.from(tx.next());
    if (mangle) mangle(bits, i);
    const r = dec.frame(bits, inv);
    if (r) outs.push(r);
  }
  return outs;
}
{
  const base = { startMs: T0, flight, sats: 11, battV: 3.12, chStart: 0 };
  const o09 = dfmRun({ ...base, kind: 'DFM-09', serial: 19072298, tempC: -20 }, 60);
  const last = o09[o09.length - 1];
  ok(o09.length >= 5, 'DFM-09 frames decode', `${o09.length} outputs`);
  eq(last?.type, 'DFM', 'DFM family');
  eq(last?.model, 'DFM-09', 'DFM-09 model (subtype 0xA, normal polarity)');
  eq(last?.serial, 'DFM-19072298', 'DFM-09 serial (decimal, two halves)');
  const k = 13 - 1;   // 60 frames = 120 packets = 13 seconds; the last full one is second 12
  eq(last?.frame, (1 + k) & 255, 'DFM frame counter');
  near(last?.lat, flight(k).lat, 1e-7, 'DFM latitude');
  near(last?.lon, flight(k).lon, 1e-7, 'DFM longitude');
  near(last?.alt, flight(k).alt, 0.01, 'DFM altitude');
  near(last?.vH, 5.0, 0.01, 'DFM ground speed');
  near(last?.heading, 53.13, 0.01, 'DFM heading');
  near(last?.climb, 5.1, 0.01, 'DFM climb');
  eq(last?.sats, 11, 'DFM satellites');
  near(last?.tempC, -20, 0.05, 'DFM-09 temperature (channels 0, 3, 4; Rf 220k)');
  near(last?.battV, 3.12, 0.001, 'DFM battery');
  eq(last?.date, '2026-11-14', 'DFM date');
  near(last?.timeS, 12 * 3600 + 34 * 60 + 50 + k, 0.01, 'DFM time of day');
  eq(last?.extra?.['MCU TEMPERATURE'], '25.0 °C', 'DFM MCU temperature');
  eq(last?.extra?.['GEOID HEIGHT'], '33.5 m', 'DFM geoid height');
  eq(last?.fixed, 0, 'DFM clean frames need no repair');

  const o17 = dfmRun({ ...base, kind: 'DFM-17', serial: 23038743, tempC: 12.5 }, 60, true);
  const l17 = o17[o17.length - 1];
  eq(l17?.model, 'DFM-17', 'DFM-17 model (subtype 0xB)');
  eq(l17?.serial, 'DFM-23038743', 'DFM-17 serial');
  near(l17?.tempC, 12.5, 0.05, 'DFM-17 temperature (Rf 332k)');
  eq(l17?.extra?.['SONDE CLOCK'], '4321 s', 'DFM-17 seconds counter');
  // subtype 0xA with a 23xxxxxx serial and inverted polarity: the DFM-17 heuristic
  const o0a = dfmRun({ ...base, kind: 'DFM-09', serial: 23038744, tempC: 5 }, 60, true);
  eq(o0a[o0a.length - 1]?.model, 'DFM-17', 'DFM subtype 0xA, inverted, serial >= 23000000: DFM-17');
  const o9p = dfmRun({ ...base, kind: 'DFM-09P', serial: 20123456, tempC: -35 }, 70);
  const l9p = o9p[o9p.length - 1];
  eq(l9p?.model, 'DFM-09P', 'DFM-09P model (subtype 0xC, P sensor)');
  near(l9p?.tempC, -35, 0.05, 'DFM-09P temperature (channels 1, 5, 6)');
  near(l9p?.battV, 3.12, 0.001, 'DFM-09P battery (channel 7)');
  const o06 = dfmRun({ ...base, kind: 'DFM-06', serial: 0x123456, tempC: 18 }, 60, true);
  const l06 = o06[o06.length - 1];
  eq(l06?.model, 'DFM-06', 'DFM-06 model');
  eq(l06?.serial, 'DFM-123456', 'DFM-06 serial (six hex digits)');
  near(l06?.tempC, 18, 0.05, 'DFM-06 temperature');
  const ops = dfmRun({ ...base, kind: 'PS-15', serial: 17012345, tempC: 0 }, 60);
  const lps = ops[ops.length - 1];
  eq(lps?.model, 'PS-15', 'PS-15 model (serial nibble 0)');
  eq(lps?.serial, 'DFM-17012345', 'PS-15 serial');
  eq(lps?.tempC, undefined, 'PS-15: no temperature claimed');

  // Hamming repair: one wrong bit in every config codeword and in 4 of each data block's 13 (more marks a packet bad)
  const oneBit = (bits) => {
    for (const [start, L, step] of [[16, 7, 1], [72, 13, 4], [176, 13, 4]]) for (let i = 0; i < L; i += step) bits[start + L * ((i * 3 + 1) % 8) + i] ^= 1;
  };
  const rep = dfmRun({ ...base, kind: 'DFM-09', serial: 19072298, tempC: -20 }, 60, false, oneBit);
  const lr = rep[rep.length - 1];
  eq(lr?.serial, 'DFM-19072298', 'DFM Hamming repairs one bit per codeword');
  near(lr?.lat, flight(12).lat, 1e-7, 'DFM repaired latitude');
  ok((lr?.fixed ?? 0) > 0, 'DFM reports repaired codewords', `${lr?.fixed}`);
  // two wrong bits in one codeword of each data block: those packets are dropped, nothing comes out
  const twoBit = (bits) => { for (const s of [72, 176]) { bits[s] ^= 1; bits[s + 13] ^= 1; } };
  eq(dfmRun({ ...base, kind: 'DFM-09', serial: 19072298, tempC: -20 }, 60, false, twoBit).length, 0, 'DFM uncorrectable codewords: no frames');
}

// ---- M10 / M20 frames
const m10o = (k) => ({ serial: '903-2-11234', counter: 40 + k, p: flight(k), week: 2408, towMs: 6 * 86400000 + 45_296_000 + k * 1000, leap: 18, sats: 8, tempC: -12, rh: 47, tHumC: -10, battV: 3.05 });
{
  const dec = new M10Decoder();
  const f = A.m10Frame(m10o(3));
  const r = dec.parse(f);
  ok(r !== null, 'M10 frame parses (checksum)');
  eq(r?.type, 'M10', 'M10 family'); eq(r?.model, 'M10', 'M10 model');
  eq(r?.serial, 'M10-903-2-11234', 'M10 serial');
  eq(r?.frame, 43, 'M10 frame counter');
  near(r?.lat, flight(3).lat, 1e-6, 'M10 latitude'); near(r?.lon, flight(3).lon, 1e-6, 'M10 longitude');
  near(r?.alt, flight(3).alt, 0.001, 'M10 altitude');
  near(r?.vH, 5.0, 0.01, 'M10 ground speed'); near(r?.heading, 53.13, 0.05, 'M10 heading'); near(r?.climb, 5.1, 0.005, 'M10 climb');
  eq(r?.sats, 8, 'M10 satellites');
  near(r?.timeS, (45_296 + 3 - 18), 0.001, 'M10 UTC time of day (leap seconds applied)');
  eq(r?.date, new Date(Date.UTC(1980, 0, 6) + (2408 * 604800 + 6 * 86400 + 45_296 + 3 - 18) * 1000).toISOString().slice(0, 10), 'M10 date');
  near(r?.tempC, -12, 0.15, 'M10 temperature');
  near(r?.rh, 47 + 12 / 5.5, 0.1, 'M10 humidity (with the cold correction)');
  near(r?.tHumC, -10, 0.2, 'M10 humidity sensor temperature');
  near(r?.battV, 3.05, 0.01, 'M10 battery');
  // damage: one bit anywhere fails the checksum
  for (const p of [1, 20, 0x5e, 0x62, 0x63]) { const b = f.slice(); b[p] ^= 0x08; ok(dec.parse(b) === null, `M10 bit error at byte 0x${p.toString(16)} rejected`); }
  // M2K2, M10+ (Gtop), signal-level frames
  eq(dec.parse(A.m10Frame({ ...m10o(0), type: 0x8f }))?.model, 'M2K2', 'M2K2 model');
  const g = dec.parse(A.m10Frame({ ...m10o(5), type: 0xaf }));
  eq(g?.model, 'M10+', 'M10+ model');
  near(g?.lat, flight(5).lat, 1e-6, 'M10+ latitude'); near(g?.alt, flight(5).alt, 0.01, 'M10+ altitude'); near(g?.climb, 5.1, 0.01, 'M10+ climb');
  near(g?.timeS, (45_296 + 5 - 18) % 86400, 0.001, 'M10+ time');
  ok(dec.parse(A.m10Frame({ ...m10o(0), type: 0x49 })) === null, 'M10 signal-level frame (0x49) reported as nothing');
  eq(dec.parse(A.m10Frame({ ...m10o(0), aux: 2 }))?.serial, 'M10-903-2-11234', 'M10 with 2 aux bytes (frame length 0x66)');
  // from soft symbols, after the sync
  const syms = A.m10Symbols(f, false, 0).slice(32);
  const soft = Float32Array.from([...syms, ...new Array(64 * 16).fill(0)], b => (b ? 1 : -1));
  eq(dec.decode(soft)?.serial, 'M10-903-2-11234', 'M10 from biphase-mark symbols');
  eq(dec.decode(soft.map(v => -v))?.serial, 'M10-903-2-11234', 'M10 symbols inverted: same frame');

  const m20 = { serial: '512-1-14350', counter: 200, p: flight(7), week: 2408, towS: 3 * 86400 + 3600 + 7, tempC: 21.5, rh: 63, tHumC: 20, battV: 3.0, hPa: 845.25 };
  const r20 = dec.parse(A.m20Frame(m20));
  ok(r20 !== null, 'M20 frame parses (checksum)');
  eq(r20?.type, 'M20', 'M20 family');
  eq(r20?.serial, 'M20-512-1-14350', 'M20 serial');
  eq(r20?.frame, 200, 'M20 frame counter');
  near(r20?.lat, flight(7).lat, 1e-6, 'M20 latitude'); near(r20?.lon, flight(7).lon, 1e-6, 'M20 longitude');
  near(r20?.alt, flight(7).alt, 0.01, 'M20 altitude');
  near(r20?.vH, 5.0, 0.01, 'M20 ground speed'); near(r20?.heading, 53.13, 0.2, 'M20 heading'); near(r20?.climb, 5.1, 0.01, 'M20 climb');
  eq(r20?.timeS, 3600 + 7, 'M20 GPS time of day');
  near(r20?.tempC, 21.5, 0.2, 'M20 temperature');
  near(r20?.tHumC, 20, 0.2, 'M20 humidity sensor temperature');
  near(r20?.rh, 63, 0.5, 'M20 humidity');
  near(r20?.hPa, 845.25, 0.01, 'M20 pressure');
  near(r20?.battV, 3.0, 0.02, 'M20 battery');
  const b20 = A.m20Frame(m20); b20[0x30] ^= 1;
  ok(dec.parse(b20) === null, 'M20 bit error rejected');
}

// ---- MTS01 frames
const mtso = (k) => ({ id: 'MTS1A234', counter: 1000 + k, startMs: T0 + k * 1000, battMv: 3710, lat: flight(k).lat, lon: flight(k).lon, alt: flight(k).alt, heading: 53.1, speed: 5.0, rawT: 15 * Math.exp(3000 * (1 / (273.15 - 15) - 1 / 273.15)) });
{
  const dec = new Mts01Decoder();
  const f = A.mts01Frame(mtso(2));
  const r = dec.parse(f);
  ok(r !== null, 'MTS01 frame parses (CRC)');
  eq(r?.type, 'MTS01', 'MTS01 family');
  eq(r?.serial, 'MTS01-MTS1A234', 'MTS01 serial');
  eq(r?.frame, 1002, 'MTS01 frame counter');
  near(r?.lat, flight(2).lat, 1e-6, 'MTS01 latitude'); near(r?.lon, flight(2).lon, 1e-6, 'MTS01 longitude'); near(r?.alt, flight(2).alt, 0.05, 'MTS01 altitude');
  near(r?.heading, 53.1, 0.01, 'MTS01 heading'); near(r?.vH, 5.0, 0.01, 'MTS01 speed');
  eq(r?.climb, undefined, 'MTS01 has no climb field');
  near(r?.tempC, -15, 0.01, 'MTS01 temperature');
  near(r?.battV, 3.71, 1e-9, 'MTS01 battery');
  eq(r?.date, '2026-11-14', 'MTS01 date');
  eq(r?.timeS, 12 * 3600 + 34 * 60 + 52, 'MTS01 time');
  const b = f.slice(); b[40] ^= 0x01;
  ok(dec.parse(b) === null, 'MTS01 bit error rejected');
  const soft = Float32Array.from(A.mts01Symbols(f, false, 0).slice(32), v => (v ? 1 : -1));
  eq(dec.decode(soft)?.serial, 'MTS01-MTS1A234', 'MTS01 from symbols');
}

// ---- channel decoders on a clean discriminator: both FM polarities, and no type decodes another's signal
const CH_RATE = 47_619;
function disc(syms, baud, dev, invert, rate = CH_RATE) {
  const n = Math.ceil(syms.length * rate / baud), out = new Float32Array(n), a = 2 * Math.PI * dev / rate;
  for (let i = 0; i < n; i++) { const k = Math.min(syms.length - 1, Math.floor(i * baud / rate)); out[i] = 0.02 + ((syms[k] ? 1 : 0) !== (invert ? 1 : 0) ? a : -a); }
  return out;
}
function bankRun(x) {
  const got = [];
  const decs = makeBankA(CH_RATE, f => got.push(f));
  for (let i = 0; i < x.length; i++) for (const d of decs) d.push(x[i]);
  return got;
}
const sigs = {
  DFM: (inv) => { const tx = new A.DfmTx({ kind: 'DFM-09', serial: 19072298, tempC: -20, startMs: T0, flight, chStart: 10 }); const fr = []; for (let i = 0; i < 40; i++) fr.push(tx.next()); return disc(A.dfmSymbols(fr), 2500, 2400, inv); },
  M10: (inv) => { const s = []; for (let k = 0; k < 3; k++) { const f = A.m10Symbols(A.m10Frame(m10o(k))); s.push(...f, ...new Array(9615 - f.length).fill(0).map((_, i) => (i >> 1) & 1)); } return disc(s, 9615, 4800, inv); },
  M20: (inv) => { const s = []; for (let k = 0; k < 3; k++) { const f = A.m10Symbols(A.m20Frame({ serial: '512-1-14350', counter: k, p: flight(k), week: 2408, towS: 1000 + k, tempC: 5, rh: 40, tHumC: 5, battV: 3 })); s.push(...f, ...new Array(9600 - f.length).fill(0).map((_, i) => (i >> 1) & 1)); } return disc(s, 9600, 4800, inv); },
  MTS01: (inv) => { const s = []; for (let k = 0; k < 3; k++) { const f = A.mts01Symbols(A.mts01Frame(mtso(k))); s.push(...f, ...new Array(1200 - f.length).fill(0).map((_, i) => i & 1)); } return disc(s, 1200, 640, inv); },
};
const serials = { DFM: 'DFM-19072298', M10: 'M10-903-2-11234', M20: 'M20-512-1-14350', MTS01: 'MTS01-MTS1A234' };
for (const [type, mk] of Object.entries(sigs)) {
  for (const inv of [false, true]) {
    const got = bankRun(mk(inv));
    const mine = got.filter(f => f.type === type && f.serial === serials[type]);
    ok(mine.length >= (type === 'DFM' ? 3 : 2), `${type} through its channel decoder, ${inv ? 'inverted' : 'normal'} polarity`, `${mine.length} frames`);
    ok(got.every(f => f.type === type), `${type} signal: no other type decodes it (${inv ? 'inverted' : 'normal'})`, got.filter(f => f.type !== type).map(f => f.type).join(','));
    if (type === 'DFM') eq(mine[mine.length - 1]?.model, inv ? 'DFM-09' : 'DFM-09', `DFM polarity seen (${inv ? 'inverted' : 'normal'}), serial < 23000000 stays DFM-09`);
  }
}
// the DFM polarity estimate feeds the DFM-17 heuristic: subtype 0xA, a 23xxxxxx serial
{
  const mk = (inv) => { const tx = new A.DfmTx({ kind: 'DFM-09', serial: 23038744, tempC: -20, startMs: T0, flight, chStart: 10 }); const fr = []; for (let i = 0; i < 40; i++) fr.push(tx.next()); return disc(A.dfmSymbols(fr), 2500, 2400, inv); };
  const n = bankRun(mk(false)), i = bankRun(mk(true));
  eq(n[n.length - 1]?.model, 'DFM-09', 'DFM 0xA normal polarity: DFM-09');
  eq(i[i.length - 1]?.model, 'DFM-17', 'DFM 0xA inverted polarity: DFM-17');
}
// noise alone: nothing
{
  let s = 5; const x = new Float32Array(CH_RATE * 3);
  for (let k = 0; k < x.length; k++) { s = (s * 1103515245 + 12345) >>> 0; x[k] = (s / 4294967296 - 0.5) * 2; }
  eq(bankRun(x).length, 0, 'noise: no frames');
}

// ---- the whole receiver: all four types at once on raw IQ at 2.4 Msps, hundreds of kHz either side of the center
{
  const rate = 2_400_000, secs = 10, n = rate * secs;
  const center = 403_000_000;
  // DFM: continuous frames; serial channel first so the serial is complete in under 3 s
  const tx = new A.DfmTx({ kind: 'DFM-17', serial: 23038743, tempC: -20, startMs: T0, flight, battV: 3.1 });
  const tx2 = new A.DfmTx({ kind: 'DFM-17', serial: 23038743, tempC: -20, startMs: T0, flight, battV: 3.1, chStart: tx.cycleLen - 1 });
  const dfmFr = []; for (let i = 0; i < secs * 4.5 + 2; i++) dfmFr.push(tx2.next());
  // M10, M20: a burst a second; MTS01: a frame a second; idle carrier between
  const burst = (frames, baud) => { const s = []; for (const f of frames) { s.push(...f); while (s.length % baud) s.push((s.length >> 1) & 1); } return s; };
  const m10s = burst(Array.from({ length: secs }, (_, k) => A.m10Symbols(A.m10Frame(m10o(k)))), 9615);
  const m20s = burst(Array.from({ length: secs }, (_, k) => A.m10Symbols(A.m20Frame({ serial: '512-1-14350', counter: k, p: flight(k), week: 2408, towS: 1000 + k, tempC: 5, rh: 40, tHumC: 5, battV: 3 }), true)), 9600);
  const mtss = []; for (let k = 0; k < secs; k++) { const f = A.mts01Symbols(A.mts01Frame(mtso(k))); mtss.push(...f); while (mtss.length % 1200) mtss.push(mtss.length & 1); }
  const t0 = Date.now();
  const iq = A.fskMix(rate, n, [
    { syms: A.dfmSymbols(dfmFr, true), baud: 2500, offsetHz: -650_000, dev: 2400, amp: 26 },
    { syms: m10s, baud: 9615, offsetHz: -250_000, dev: 4800, amp: 26 },
    { syms: m20s, baud: 9600, offsetHz: 300_000, dev: 4800, amp: 26 },
    { syms: mtss, baud: 1200, offsetHz: 700_000, dev: 640, amp: 26 },
  ], 6);
  const tGen = Date.now() - t0;
  const msgs = [];
  const proc = new SondeProcessor(m => msgs.push(m));
  proc.setBand('400'); proc.reset(rate); proc.setCenter(center);
  const t1 = Date.now();
  for (let o = 0; o < iq.length; o += 131072) proc.onIq(iq.subarray(o, Math.min(iq.length, o + 131072)), rate);
  const tRun = Date.now() - t1;
  const rows = proc.tracker.rows(Date.now());
  const log = msgs.filter(m => m.type === 'log').map(m => m.line).join(' | ');
  const want = [['DFM', 'DFM-23038743', -650_000, 2], ['M10', 'M10-903-2-11234', -250_000, 2], ['M20', 'M20-512-1-14350', 300_000, 2], ['MTS01', 'MTS01-MTS1A234', 700_000, 2]];
  for (const [type, serial, off, min] of want) {
    const s = rows.find(r => r.type + '-' + r.serial === serial);
    ok(!!s && s.type === type, `${type} through the receiver`, `rows ${rows.map(r => `${r.type}:${r.serial}`).join(',')}; log ${log}`);
    ok((s?.frames ?? 0) >= min, `${type} several frames through the receiver`, `frames ${s?.frames}`);
    near(s?.hz, center + off, 3000, `${type} channel frequency`);
  }
  eq(rows.find(r => r.serial === '23038743')?.model, 'DFM-17', 'DFM-17 model through the receiver');
  near(rows.find(r => r.serial === '23038743')?.tempC, -20, 0.1, 'DFM-17 temperature through the receiver');
  eq(rows.length, 4, 'receiver: exactly the four sondes, no false decodes', rows.map(r => `${r.type}:${r.serial}`).join(','));
  console.log(`  (receiver: ${(tRun / 1000).toFixed(1)} s for ${secs} s of 2.4 Msps with 4 channels; signal generation ${(tGen / 1000).toFixed(1)} s)`);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
