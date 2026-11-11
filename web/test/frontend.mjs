/**
 * The receive front end and the decoders it was fixed for (iOS ChannelDecimatorTest, AisDecoderRateTest,
 * ErtDecoderTest and AprsDecoderTest's tilt cases):
 *
 * - ChannelDecimator, the narrow modes' first decimation: what it passes and what it keeps from folding onto the
 *   channel, at every rate a radio runs.
 * - AIS at the intermediate rates the engine hands it (rate / its first decimation: 48 to 60 kHz), fed packets as a
 *   transponder sends them: 24 bits of 0101 training, a flag, the packet, a flag. The fields must read back MSB
 *   first per octet.
 * - ERT straight into the decoder: SCM packets as OOK Manchester (32768 chips a second) at both rates the app runs,
 *   clean and with noise, with random gaps and clock error so the clock has to find each packet on its own.
 * - APRS with one tone louder than the other, as pre-emphasis and radio audio leave it.
 */
import { ChannelDecimator } from '../dist/dsp/ham/filters.js';
import { AisDecoder } from '../dist/dsp/ais.js';
import { ErtDecoder } from '../dist/dsp/ert.js';
import { AprsDecoder } from '../dist/dsp/aprs.js';
import { ax25Aprs, ax25Bits } from '../dist/tx-encoders.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) { pass++; } else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };

/** Seeded uniform [0,1) and a Gaussian from it. */
const rng = (seed) => {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const g = () => { let x = 0; while (x === 0) x = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u()); };
  return { u, g, int: (n) => Math.floor(u() * n) };
};

// ---- ChannelDecimator ----
/** Output power (dB) of a tone at `hz` through a decimator for `rate`, after the filter settles. */
function gainDb(rate, hz) {
  const dec = new ChannelDecimator(Math.floor(rate / 48_000));
  const n = Math.max(Math.floor(rate / 20), 60_000);
  const inp = new Float32Array(2 * n);
  for (let k = 0; k < n; k++) { const ph = 2 * Math.PI * hz * k / rate; inp[2 * k] = 50 * Math.cos(ph); inp[2 * k + 1] = 50 * Math.sin(ph); }
  const { out, n: m } = dec.process(inp, n);
  let p = 0;
  for (let k = m >> 1; k < m; k++) p += out[2 * k] * out[2 * k] + out[2 * k + 1] * out[2 * k + 1];
  return 10 * Math.log10(p / (m - (m >> 1)) / 2500 + 1e-15);
}
{
  const [a, b] = ChannelDecimator.split(40); ok(a * b === 40, 'split 40');
  const [c, d] = ChannelDecimator.split(41); ok(c * d === 40, 'split 41 -> 40');
  const [e, f] = ChannelDecimator.split(83); ok(e * f <= 83 && e * f >= 78 && f >= 3 && f <= 6, `split 83 (${e}x${f})`);
  const RATES = [1_920_000, 2_000_000, 2_400_000, 4_000_000, 10_000_000, 20_000_000];
  for (const rate of RATES) for (const hz of [0, 5_000, -8_000, 12_000]) {
    const g = gainDb(rate, hz); ok(Math.abs(g) <= 0.6, `passes ${hz} Hz at ${rate}`, `${g.toFixed(2)} dB`);
  }
  for (const rate of RATES) {
    const out = rate / new ChannelDecimator(Math.floor(rate / 48_000)).total;
    let worst = -200;
    for (let n = 1; n <= 8; n++) for (const dd of [-12_000, -6_000, 0, 6_000, 12_000]) for (const s of [1, -1]) worst = Math.max(worst, gainDb(rate, s * (n * out + dd)));
    ok(worst < -50, `fold rejection at ${rate}`, `${worst.toFixed(0)} dB`);
    console.log(`fold rejection at ${rate}: ${worst.toFixed(0)} dB`);
  }
}

// ---- AIS at every intermediate rate ----
function aisAirBits() {
  const m = [];
  const put = (v, n) => { for (let k = 0; k < n; k++) m.push(Math.floor(v / 2 ** (n - 1 - k)) & 1); };
  put(1, 6); put(0, 2); put(366_123_456, 30); put(0, 4); put(0, 8); put(123, 10); put(1, 1);
  put((Math.round(-118.25 * 600_000) & 0xFFFFFFF) >>> 0, 28); put(Math.round(33.75 * 600_000) & 0x7FFFFFF, 27);
  put(2_705, 12); put(271, 9); put(30, 6); put(0, 2); put(0, 3); put(0, 1); put(0, 19);
  // each octet of the message is sent LSB first: pack MSB first, and the HDLC encoder sends bytes LSB first
  const f = [];
  for (let j = 0; j < 21; j++) { let v = 0; for (let b = 0; b < 8; b++) v = (v << 1) | m[8 * j + b]; f.push(v); }
  let crc = 0xFFFF;
  for (const b of f) { let v = b; for (let i = 0; i < 8; i++) { const bit = (crc & 1) ^ (v & 1); crc >>= 1; if (bit) crc ^= 0x8408; v >>= 1; } }
  crc ^= 0xFFFF; f.push(crc & 0xFF, crc >> 8);
  const train = Array.from({ length: 24 }, (_, i) => i % 2 === 1);
  return [...train, ...ax25Bits(f, 1)];
}
function aisDecoded(rate, noise) {
  const lines = [];
  const d = new AisDecoder(m => { if (m.type === 'packet') lines.push(m.line); });
  d.reset(rate);
  const r = rng(5);
  const dev = 2 * Math.PI * 2400 / rate;
  const fm = [];
  const gap = () => { for (let i = 0; i < Math.floor(rate / 20); i++) fm.push(0); };
  gap();
  const spb = rate / 9600; let acc = 0;
  const bits = aisAirBits();
  for (let rep = 0; rep < 3; rep++) {
    for (const b of bits) { acc += spb; const n = Math.floor(acc); acc -= n; for (let i = 0; i < n; i++) fm.push((b ? dev : -dev) + noise * dev * r.g()); }
    gap();
  }
  d.onFm(Float32Array.from(fm), fm.length, rate);
  return lines;
}
for (const r of [48_000, 48_780, 49_382, 50_000, 51_200, 60_000]) {
  const clean = aisDecoded(r, 0);
  ok(clean.length === 3, `AIS clean at ${r}`, `${clean.length} of 3`);
  ok(clean.length > 0 && clean[0].includes('366123456'), `AIS MMSI read MSB first at ${r}`, clean[0]);
  const noisy = aisDecoded(r, 0.5).length;
  ok(noisy >= 2, `AIS noisy at ${r}`, `${noisy} of 3`);
}

// ---- ERT ----
function crc16(bits, poly) { let crc = 0; for (const b of bits) { const msb = (crc >> 15) & 1; crc = (crc << 1) & 0xFFFF; if (msb ^ b) crc ^= poly; } return crc; }
const field = (v, n) => Array.from({ length: n }, (_, i) => Math.floor(v / 2 ** (n - 1 - i)) & 1);
function scm(id, cons) {
  let data = field(Math.floor(id / 2 ** 24), 2);
  data = data.concat([0], field(0, 2), field(7, 4), field(0, 2), field(cons, 24), field(id % 2 ** 24, 24));
  data = data.concat(field(crc16(data, 0x6F63), 16));
  return field(0x1F2A60, 21).concat(data);
}
function ertPackets(rate, n, amp, noise, ppm = 0) {
  const lines = [];
  const d = new ErtDecoder(m => { if (m.type === 'packet') lines.push(m.line); });
  d.reset(rate);
  const r = rng(5);
  const chips = [];
  for (let k = 0; k < n; k++) {
    for (let i = 100 + r.int(300); i > 0; i--) chips.push(false);
    for (const b of scm(1_000 + k, 50_000 + k)) { chips.push(b === 1); chips.push(b !== 1); }
  }
  for (let i = 0; i < 200; i++) chips.push(false);
  const spc = rate / (32768 * (1 + ppm / 1e6));
  const total = Math.floor(chips.length * spc);
  const iq = new Int8Array(2 * total);
  let ph = 0;
  for (let k = 0; k < total; k++) {
    const on = chips[Math.min(chips.length - 1, Math.floor(k / spc))];
    ph += 2 * Math.PI * 300_000 / rate;
    const a = on ? amp : 0;
    iq[2 * k] = Math.max(-128, Math.min(127, Math.round(a * Math.cos(ph) + noise * r.g())));
    iq[2 * k + 1] = Math.max(-128, Math.min(127, Math.round(a * Math.sin(ph) + noise * r.g())));
  }
  const chunk = 262_144;
  for (let p = 0; p < iq.length; p += chunk) d.onIq(iq.subarray(p, Math.min(iq.length, p + chunk)), rate);
  return lines.length;
}
for (const rate of [2_000_000, ErtDecoder.RATE]) {
  const got = ertPackets(rate, 20, 50, 2);
  ok(got >= 19, `ERT clean @${rate}`, `${got} of 20`);
  for (const [amp, noise, ppm] of [[20, 10, 0], [10, 10, 0], [6, 10, 0], [20, 5, 200], [20, 5, -200]]) {
    const g = ertPackets(rate, 20, amp, noise, ppm);
    console.log(`ERT @${rate} amp ${amp} noise ${noise} ppm ${ppm}: ${g} of 20`);
    if (amp >= 20) ok(g >= 18, `ERT @${rate} amp ${amp} noise ${noise} ppm ${ppm}`, `${g} of 20`);
  }
}
ok(ertPackets(2_000_000, 0, 0, 10) === 0, 'ERT: noise gives nothing');

// ---- APRS tone tilt ----
function afskPackets(tiltDb, noise, n = 10) {
  const lines = new Set();
  const d = new AprsDecoder(m => { if (m.type === 'packet') lines.add(m.line); });
  const rate = 48_000, r = rng(11), space = 10 ** (tiltDb / 20);
  let ph = 0;
  const buf = new Float32Array(4_800); let at = 0;
  const push = (x) => { buf[at++] = x; if (at === buf.length) { d.onFm(buf, at, rate); at = 0; } };
  for (let k = 0; k < n; k++) {
    const bits = ax25Bits(ax25Aprs(`N0CALL-${k}`, `!3415.00N/11847.00W>tilt test packet ${k}`), 24);
    for (let i = 0; i < 2_400; i++) push(noise * r.g());
    let acc = 0;
    for (const b of bits) {
      acc += 40; const m = Math.floor(acc); acc -= m;
      for (let i = 0; i < m; i++) {
        ph += 2 * Math.PI * (b ? 1200 : 2200) / rate;
        const a = (b ? 1 : space) * Math.sin(ph);
        push(2 * Math.PI * 3000 * a / rate + noise * r.g());   // discriminator output: radians a sample, 3 kHz deviation
      }
    }
  }
  for (let i = 0; i < 4_800; i++) push(0);
  return lines.size;
}
{
  const flat = afskPackets(0, 0.05); ok(flat === 10, 'APRS flat', `${flat} of 10`);
  const up = afskPackets(6, 0.05); ok(up >= 9, 'APRS space tilted up 6 dB', `${up} of 10`);
  const down = afskPackets(-6, 0.05); ok(down >= 9, 'APRS space tilted down 6 dB', `${down} of 10`);
  console.log(`APRS noisy: ${afskPackets(-4, 0.25)} of 10`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
