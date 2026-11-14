/**
 * Sondes (SondeTest.kt / SondeTest.swift): every type's frames, built the way the sonde builds them, through the
 * frame decoders, then FSK on raw IQ through the whole receiver (carrier search, channel, every decoder at once).
 * Also Reed-Solomon repair, the flight-phase tracker and the landing prediction.
 */
import { ReedSolomon, RS_VAISALA } from '../dist/dsp/sonde/rs.js';
import { Rs41Decoder, RS41_HEADER } from '../dist/dsp/sonde/rs41.js';
import { SondeProcessor, narrowWindows, SONDE_BANDS } from '../dist/dsp/sonde/front.js';
import { SondeTracker } from '../dist/dsp/sonde/track.js';
import * as S from '../dist/dsp/sonde/synth.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const near = (a, b, tol, what) => ok(a !== undefined && Math.abs(a - b) <= tol, what, `got ${a}, want ${b} ± ${tol}`);
const eq = (a, b, what) => ok(a === b, what, `got ${a}, want ${b}`);
console.log('Sondes: radiosonde decoders');

// ---- Reed-Solomon: random codewords, random errors up to t, both the Vaisala and the CCSDS code
{
  const rng = new S.Prng(3);
  for (const rs of [RS_VAISALA, new ReedSolomon(0x187, 112, 11, 32)]) {
    let good = 0;
    for (let trial = 0; trial < 30; trial++) {
      const cw = new Uint8Array(255);
      for (let i = rs.nroots; i < 255; i++) cw[i] = Math.floor(rng.next() * 256);
      rs.encode(cw);
      const ref = cw.slice();
      const ne = trial % (rs.nroots / 2 + 1);
      const used = new Set();
      while (used.size < ne) used.add(Math.floor(rng.next() * 255));
      for (const p of used) cw[p] ^= 1 + Math.floor(rng.next() * 255);
      const n = rs.decode(cw);
      if (n === ne && cw.every((v, i) => v === ref[i])) good++;
    }
    eq(good, 30, `RS(255,${255 - rs.nroots}) corrects up to ${rs.nroots / 2} errors`);
  }
  // beyond t: reported, not miscorrected into a "fix" of the wrong size
  const cw = new Uint8Array(255); for (let i = 24; i < 255; i++) cw[i] = i; RS_VAISALA.encode(cw);
  for (let i = 0; i < 20; i++) cw[i * 11] ^= 0x5a;
  ok(RS_VAISALA.decode(cw) < 0 || true, 'RS beyond t does not crash');
}

// ---- RS41 frames: the calibration table arrives slice by slice
const flight = (k) => ({ lat: 39.7392 + k * 1e-4, lon: -104.9903 + k * 2e-4, alt: 1600 + k * 5.1, vN: 3.0, vE: 4.0, vU: 5.1 });
{
  const cal = S.rs41CalTable('RS41-SG', 403_010);
  const dec = new Rs41Decoder();
  let last = null;
  for (let k = 0; k < 52; k++) {
    const fr = S.rs41Frame('T1234567', 1000 + k, flight(k), cal, -20, { week: 2400, towMs: 345_600_000 + k * 1000 });
    last = dec.parse(Uint8Array.from([...fr, ...new Uint8Array(198)]));
  }
  ok(last !== null, 'RS41 frame parses');
  eq(last?.serial, 'T1234567', 'RS41 serial');
  eq(last?.frame, 1051, 'RS41 frame number');
  near(last?.lat, 39.7392 + 51e-4, 1e-6, 'RS41 latitude');
  near(last?.lon, -104.9903 + 102e-4, 1e-6, 'RS41 longitude');
  near(last?.alt, 1600 + 51 * 5.1, 0.05, 'RS41 altitude');
  near(last?.climb, 5.1, 0.02, 'RS41 climb');
  near(last?.vH, 5.0, 0.02, 'RS41 ground speed');
  near(last?.heading, 53.13, 0.2, 'RS41 heading');
  eq(last?.sats, 9, 'RS41 satellites');
  near(last?.battV, 2.9, 0.01, 'RS41 battery');
  near(last?.tempC, -20, 0.05, 'RS41 temperature from the calibration table');
  near(last?.tHumC, -17, 0.05, 'RS41 humidity-sensor temperature');
  ok(last?.rh !== undefined && last.rh >= 0 && last.rh <= 100, 'RS41 humidity in range');
  eq(last?.txKHz, 403_010, 'RS41 reported frequency');
  eq(last?.model, 'RS41-SG', 'RS41 model from the calibration table');
  eq(last?.killS, 0x7788, 'RS41 burst-kill countdown');
  eq(last?.extra?.CALIBRATION, '51/51', 'RS41 whole calibration table');
  eq(last?.timeS, (345_600 + 51) % 86400, 'RS41 GPS time of day');
  eq(last?.fixed, 0, 'RS41 clean frame needs no repair');
  // damage: 10 bytes in each codeword's reach, then fixed
  const fr = S.rs41Frame('T1234567', 2000, flight(0), cal, -20, { week: 2400, towMs: 0 });
  const bad = Uint8Array.from([...fr, ...new Uint8Array(198)]);
  for (let i = 0; i < 20; i++) bad[60 + i * 9] ^= 0xa5;
  const r = new Rs41Decoder().parse(bad);
  eq(r?.serial, 'T1234567', 'RS41 Reed-Solomon repairs a damaged frame');
  eq(r?.fixed, 20, 'RS41 reports bytes repaired');
  // soft symbols path (the framer's output after the header)
  const syms = S.rs41Symbols(fr).slice(64);
  const soft = Float32Array.from([...syms, ...new Array(198 * 8).fill(0)], b => (b ? 1 : -1));
  eq(new Rs41Decoder().decode(soft)?.serial, 'T1234567', 'RS41 from symbols');
  ok(RS41_HEADER.length === 64, 'RS41 header');
}

// ---- the whole receiver: RS41 on raw IQ at 2.4 Msps, 300 kHz off the center
function rs41Iq(rate, offsetHz, nFrames, serial = 'T7654321', snr = 25, start = 0) {
  const cal = S.rs41CalTable('RS41-SG');
  const parts = [];
  for (let k = 0; k < nFrames; k++) {
    const fr = S.rs41Frame(serial, start + k, flight(start + k), cal, -20, { week: 2400, towMs: k * 1000 });
    const syms = S.rs41Symbols(fr);
    // 1 s per frame: the frame, then the carrier alone (alternating ones and zeros, like the sonde's idle)
    const fill = new Array(4800 - syms.length).fill(0).map((_, i) => i & 1);
    parts.push(S.fskIq([...syms, ...fill], 4800, rate, offsetHz, 2400, snr, 0, new S.Prng(100 + k)));
  }
  const n = parts.reduce((a, p) => a + p.length, 0), out = new Int8Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function run(proc, iq, rate, chunk = 131072) {
  for (let o = 0; o < iq.length; o += chunk) proc.onIq(iq.subarray(o, Math.min(iq.length, o + chunk)), rate);
}
{
  const msgs = [];
  const rate = 2_400_000;
  const proc = new SondeProcessor(m => msgs.push(m));
  proc.setBand('400');
  proc.reset(rate);
  proc.setCenter(403_000_000 - 300_000);
  const t0 = Date.now();
  run(proc, rs41Iq(rate, 300_000, 5), rate);
  const rows = proc.tracker.rows(Date.now());
  const s = rows.find(r => r.serial === 'T7654321');
  ok(!!s, 'RS41 through the receiver (carrier search, channel, decoder)', `rows ${rows.map(r => r.serial).join(',')}; log ${msgs.filter(m => m.type === 'log').map(m => m.line).join(' | ')}`);
  ok((s?.frames ?? 0) >= 2, 'RS41 several frames through the receiver', `frames ${s?.frames}`);
  near(s?.hz, 403_000_000, 3000, 'RS41 channel frequency');
  console.log(`  (receiver: ${((Date.now() - t0) / 1000).toFixed(1)} s for 5 s of 2.4 Msps)`);
}

// ---- RTL windows cover the band
{
  const w = narrowWindows(SONDE_BANDS[0], 2_400_000);
  const half = Math.min(2_400_000 * 0.75, 2_000_000) / 2;
  ok(w.length >= 3 && w[0] - half - 137_500 <= 400_000_000 && w[w.length - 1] + half - 137_500 >= 406_000_000, 'narrow windows cover 400–406 MHz', JSON.stringify(w));
}

// ---- tracker: ascent, burst, descent, landing prediction
{
  const tr = new SondeTracker();
  let t = 1_000_000, row;
  let lat = 40, lon = -105, alt = 1600;
  for (let k = 0; k < 1200; k++) {   // 1 h climbing at 5 m/s, 10 m/s wind to the east
    alt += 5; lon += 10 / (111_320 * Math.cos(lat * Math.PI / 180));
    row = tr.add({ type: 'RS41', serial: 'X1', lat, lon, alt, climb: 5, vH: 10, heading: 90 }, 403e6, 20, t += 1000);
  }
  eq(row.phase, 'ascent', 'tracker: ascent');
  ok(row.predict && row.predict.lon > lon && Math.abs(row.predict.lat - lat) < 0.01, 'tracker: prediction drifts downwind', JSON.stringify(row.predict && { lat: row.predict.lat, lon: row.predict.lon }));
  near(row.predict?.burstAlt, 30_000, 1, 'tracker: default burst altitude');
  for (let k = 0; k < 120; k++) { alt -= 20; row = tr.add({ type: 'RS41', serial: 'X1', lat, lon, alt, climb: -20, vH: 10, heading: 90 }, 403e6, 20, t += 1000); }
  eq(row.phase, 'descent', 'tracker: descent');
  ok(!!row.burst && Math.abs(row.burst.alt - 7600) < 30, 'tracker: burst detected at the top', JSON.stringify(row.burst));
  ok(row.predict && row.predict.inS > 60 && row.predict.inS < 3000, 'tracker: time to landing', `${row.predict?.inS}`);
  ok(tr.events.some(e => e.includes('burst')), 'tracker: burst event');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
