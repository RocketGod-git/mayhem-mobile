/**
 * Trains (TrainsTest.kt / TrainsTest.swift): EOT / HOT frames and PTC bursts, synthesized onto raw IQ, through the
 * whole receiver. Real off-air EOT frames check the BCH; PTC bursts as demodulated from a recording (a base station and
 * a wayside unit) check the pi/4-DQPSK path, station kinds, beacon periods and status changes.
 * MAYHEM_TRAINS_IQ=path,rate,center,EOT|PTC replays a recording (offset-128 u8 IQ).
 */
import { readFileSync } from 'node:fs';
import { EotParser, TrainsProcessor, EOT_HZ, HOT_HZ, EOT_CENTER, EOT_RATE, EOT_NARROW, PTC_CENTER, PTC_RATE, PTC_NARROW, PTC_MIN_SYNC } from '../dist/dsp/trains.js';
import { jrandom } from './jrandom.mjs';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
const eq = (a, b, what) => ok(a === b, what, `got ${a}, want ${b}`);
console.log('Trains: end-of-train telemetry and the PTC network');

const REAL = [
  ['11100010010111100001000011100101000010000100010111100010100010001110111110', 10690, 66],
  ['11100010010111100000001000001100100100110100101101101110011010010111011011', 19472, 89],
  ['11100010010111100000101001010110010100110101001011101011011001110010101001', 39572, 89]];
const BASE = '2222222220202122323321302121313001312030332132222022200302000323333100023300302210222011020013023031201300333210032203212310122120130032322000011021121302330111110311101202123110';
const WAYSIDE = '222222222020212232332130212131300131203313230101330100203202332301130101130301100032101000000000321010132103003320300103202111103100230331';
const bits = s => [...s].map(Number);
const dotting = (n, endsOn) => Array.from({ length: n }, (_, k) => (n - 1 - k) % 2 === 0 ? endsOn : 1 - endsOn);

function eotFrame(unit, psig, motion) {
  const p = new Array(74).fill(0);
  for (let k = 0; k < 11; k++) p[k] = (EotParser.FSYNC11 >> (10 - k)) & 1;
  p[13] = 1; p[14] = 1;
  for (let i = 0; i < 17; i++) p[18 + i] = (unit >> i) & 1;
  for (let i = 0; i < 7; i++) p[35 + i] = (psig >> i) & 1;
  for (let i = 0; i < 7; i++) p[42 + i] = (100 >> i) & 1;
  p[50] = 1; p[53] = motion ? 1 : 0; p[55] = 1;
  const c = EotParser.check(p.slice(11, 56));
  for (let i = 0; i < 18; i++) p[56 + i] = c[i];
  return p;
}

/** Signed int8 IQ out of parts appended in order. */
class Iq {
  constructor() { this.parts = []; this.n = 0; }
  add(a) { this.parts.push(a); this.n += a.length; }
  get() { const o = new Int8Array(this.n); let at = 0; for (const p of this.parts) { o.set(p, at); at += p.length; } return o; }
}
const s8 = v => Math.max(-128, Math.min(127, Math.round(v)));

function ffskIq(out, b, off, rate, { lead = 0.05, amp = 30, noise = 3 } = {}) {
  const g = jrandom(7).nextGaussian;
  const spb = rate / 1200, total = Math.floor(2 * lead * rate) + Math.ceil(b.length * spb) + 2;
  const a = new Int8Array(2 * total); let at = 0, ph = 0, tone = 0;
  const push = (on, f) => {
    if (on) { tone += 2 * Math.PI * f / rate; ph += 2 * Math.PI * (off + 3000 * Math.sin(tone)) / rate; }
    const A = on ? amp : 0;
    a[at++] = s8(A * Math.cos(ph) + noise * g()); a[at++] = s8(A * Math.sin(ph) + noise * g());
  };
  for (let k = 0; k < Math.floor(lead * rate); k++) push(false, 0);
  let acc = 0;
  for (const x of b) { acc += spb; const n = Math.floor(acc); acc -= n; for (let k = 0; k < n; k++) push(true, x === 1 ? 1200 : 1800); }
  for (let k = 0; k < Math.floor(lead * rate); k++) push(false, 0);
  out.add(a.subarray(0, at));
}

/** pi/4-DQPSK with raised-cosine pulses (beta 0.35), 8000 symbols/s. */
function dqpskIq(out, syms, off, rate, { gap = 0.05, amp = 30, noise = 3, seed = 3 } = {}) {
  const g = jrandom(seed).nextGaussian, sps = rate / 8000;
  const ph = new Float64Array(syms.length + 5).fill(0.3);
  [...syms].forEach((c, i) => { ph[3 + i] = ph[2 + i] + (c === '0' ? Math.PI / 4 : c === '1' ? 3 * Math.PI / 4 : c === '2' ? -3 * Math.PI / 4 : -Math.PI / 4); });
  ph[syms.length + 3] = ph[syms.length + 2]; ph[syms.length + 4] = ph[syms.length + 2];
  const rc = t => { const b = 0.35; if (Math.abs(t) < 1e-9) return 1; const den = 1 - (2 * b * t) ** 2, s = Math.sin(Math.PI * t) / (Math.PI * t); return Math.abs(den) < 1e-6 ? s * Math.PI / 4 : s * Math.cos(Math.PI * b * t) / den; };
  const body = Math.floor((ph.length + 2) * sps), total = 2 * Math.floor(gap * rate) + body;
  const a = new Int8Array(2 * total); let at = 0, car = 0;
  const push = (i, q) => { car += 2 * Math.PI * off / rate; const c = Math.cos(car), sn = Math.sin(car); a[at++] = s8(i * c - q * sn + noise * g()); a[at++] = s8(i * sn + q * c + noise * g()); };
  for (let k = 0; k < Math.floor(gap * rate); k++) push(0, 0);
  for (let n = 0; n < body; n++) {
    const t = n / sps - 1, k0 = Math.floor(t); let i = 0, q = 0;
    for (let k = k0 - 5; k <= k0 + 6; k++) { if (k < 0 || k >= ph.length) continue; const w = rc(t - k); i += w * Math.cos(ph[k]); q += w * Math.sin(ph[k]); }
    push(amp * i, amp * q);
  }
  for (let k = 0; k < Math.floor(gap * rate); k++) push(0, 0);
  out.add(a);
}

function run(p, iq, rate) {
  p.reset(rate);
  for (let at = 0; at < iq.length; at += 524_288) p.onIq(iq.subarray(at, Math.min(iq.length, at + 524_288)), rate);
}

// real EOT frames
for (const [s, unit, psig] of REAL) { const p = EotParser.decode(bits(s)); ok(p !== null, `real frame ${unit} checks`); eq(p?.unit, unit, 'unit'); eq(p?.psig, psig, 'psig'); }
{ const bad = bits(REAL[0][0]); bad[40] ^= 1; ok(EotParser.decode(bad) === null, 'one flipped bit fails the check'); }

// EOT + HOT over the air, a wide radio
{
  const rate = EOT_RATE, c = EOT_CENTER, out = new Iq();
  const f = eotFrame(12345, 87, true);
  ffskIq(out, [...dotting(69, 0), ...f, 0, ...dotting(69, 0), ...f, 0, 0, 0, 0], EOT_HZ - c, rate);
  let v = BigInt((0b101 << 27) | (12345 << 5) | 0b10011) << 34n;
  let ones = 0; for (let x = v; x > 0n; x >>= 1n) ones += Number(x & 1n);
  if (ones % 2 === 0) v |= 1n;
  const blk = Array.from({ length: 64 }, (_, i) => Number((v >> BigInt(63 - i)) & 1n));
  ffskIq(out, [...dotting(456, 0), ...bits('110100101101110010010110'), ...blk, ...blk, ...blk, 0, 0, 0, 0], HOT_HZ - c, rate);
  const lines = [];
  const p = new TrainsProcessor(m => { if (m.type === 'packet') lines.push(m.line); }); p.centerHz = c; p.band = 'EOT';
  const seen = []; p.onEot = e => seen.push(e);
  run(p, out.get(), rate);
  for (const l of lines) console.log('  ' + l);
  eq(p.hears().join(','), 'EOT,HOT,DPU', 'a 6 MHz span hears all three');
  eq(seen.length, 1, 'one report for the frame sent twice');
  eq(seen[0]?.unit, 12345, 'unit'); eq(seen[0]?.psig, 87, 'psig'); eq(seen[0]?.motion, true, 'moving');
  eq(p.hots.length, 1, 'one HOT command'); eq(p.hots[0]?.unit, 12345, 'the HOT names the unit'); eq(p.hots[0]?.agree, 3, 'all three copies agree');
  ok((p.units.get(12345)?.hotMs ?? 0) > 0, 'the unit is linked to its head');
}

// a narrow radio hears the end unit
{
  const rate = 2_000_000, c = EOT_NARROW, out = new Iq();
  ffskIq(out, [...dotting(69, 0), ...eotFrame(777, 90, false), 0, 0, 0, 0], EOT_HZ - c, rate);
  const p = new TrainsProcessor(null); p.centerHz = c;
  run(p, out.get(), rate);
  eq(p.hears().join(','), 'EOT,DPU', '2 MHz hears EOT and DPU');
  eq([...p.units.keys()].join(','), '777', 'the unit');
}

// PTC stations
{
  const rate = PTC_RATE, c = PTC_CENTER, out = new Iq();
  const changed = BASE.slice(0, 100) + [...BASE.slice(100)].map(x => String((Number(x) + 1) % 4)).join('');
  dqpskIq(out, BASE, 220_712_500 - c, rate, { seed: 1 });
  dqpskIq(out, WAYSIDE, 219_512_500 - c, rate, { seed: 2 });
  dqpskIq(out, BASE, 220_712_500 - c, rate, { seed: 3 });
  dqpskIq(out, WAYSIDE, 219_512_500 - c, rate, { seed: 4 });
  dqpskIq(out, changed, 220_712_500 - c, rate, { seed: 5 });
  dqpskIq(out, WAYSIDE, 221_437_500 - c, rate, { seed: 6 });
  const p = new TrainsProcessor(null); p.centerHz = c; p.band = 'PTC';
  const got = []; p.onPtc = b => got.push(b);
  run(p, out.get(), rate);
  for (const b of got) console.log(`  burst ${(b.hz / 1e6).toFixed(4)} ${b.symbols} sym sync ${b.syncScore}/30 +${b.snrDb} dB`);
  eq(got.filter(b => b.syncScore >= PTC_MIN_SYNC).length, 6, 'six PTC bursts');
  const st = [...p.stations.values()];
  eq(st.length, 3, 'three stations');
  const base = st.find(s => s.kind === 'BASE'), way = st.find(s => s.kind === 'WAYSIDE'), loco = st.find(s => s.kind === 'LOCOMOTIVE');
  eq(base?.hz, 220_712_500, 'base station'); eq(way?.hz, 219_512_500, 'wayside'); eq(loco?.hz, 221_437_500, 'locomotive');
  eq(base?.bursts, 3, 'base bursts'); eq(way?.bursts, 2, 'wayside bursts');
  eq(base?.changes, 1, 'the base station repeated itself, then changed'); eq(way?.changes, 0, 'the wayside did not change');
}

// a burst that is not PTC
{
  const rate = 2_000_000, out = new Iq(), r = jrandom(9);
  dqpskIq(out, Array.from({ length: 160 }, () => '0123'[Math.floor(r.nextDouble() * 4)]).join(''), 400_000, rate);
  const p = new TrainsProcessor(null); p.centerHz = PTC_NARROW; p.band = 'PTC';
  run(p, out.get(), rate);
  eq(p.stations.size, 0, 'no station'); eq(p.ptc.others, 1, 'one other burst');
}

const spec = process.env.MAYHEM_TRAINS_IQ;
if (spec) {
  const [path, r, c, band] = spec.split(','), rate = Number(r);
  const raw = readFileSync(path), iq = new Int8Array(raw.length);
  for (let i = 0; i < raw.length; i++) iq[i] = raw[i] - 128;
  let t = 0;
  const p = new TrainsProcessor(m => { if (m.type === 'packet') console.log('  ' + m.line); }); p.centerHz = Number(c); p.band = band; p.now = () => t;
  p.onPtc = b => console.log(`  t ${(t / 1000).toFixed(3)} s · ${(b.hz / 1e6).toFixed(4)} MHz · ${b.symbols} sym · sync ${b.syncScore}/30 · +${b.snrDb} dB`);
  p.reset(rate);
  for (let at = 0; at < iq.length; at += 524_288) { p.onIq(iq.subarray(at, Math.min(iq.length, at + 524_288)), rate); t = Math.floor((at + 524_288) / 2 * 1000 / rate); }
  for (const s of p.stations.values()) console.log(`  ${s.kind} ${s.hz} bursts ${s.bursts} changes ${s.changes}`);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
