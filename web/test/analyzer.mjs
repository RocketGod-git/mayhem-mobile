/**
 * The Analyzer end to end: synthetic bursts of every modulation and line coding, made into I/Q, found by the burst
 * front end anywhere in the span, then read back with nothing set by hand. Then repeated frames lined up bit by bit,
 * the fixed and changing columns checked, and the file formats round-tripped.
 *
 * No real key is in here: the synthetic frames use made-up bytes, and the Land Rover check uses the ProtoPirate-style
 * fixture already in the repo (resources/pirate/land_rover_fsk.txt), turned back into samples.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AnalyzerCapture, captureFile, analyze, align, bitsToHex, bitsToAscii, pulsesUs, toSub, parseSub, synthesize, toCu8, fromIqFile, rateFromName, freqFromName, similar } from '../dist/dsp/analyzer/index.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (ok, what) => { if (ok) pass++; else { fail++; console.log('FAIL', what); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// mulberry32: an LCG's bits repeat in shifted runs, which made made-up hops look like copies of each other
let seed = 99;
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const randBits = (n) => Array.from({ length: n }, () => (rnd() < 0.5 ? '1' : '0')).join('');
const hexBits = (h) => [...h].map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');

const RATE = 2_000_000;
/** A signal builder at 2 Msps: segments of (amplitude, frequency offset) for a number of microseconds, over noise. */
class Air {
  constructor() { this.out = []; this.ph = 0; }
  seg(us, amp, hz) {
    const n = Math.round(us * RATE / 1e6);
    for (let k = 0; k < n; k++) {
      this.ph += 2 * Math.PI * hz / RATE;
      if (this.ph > Math.PI) this.ph -= 2 * Math.PI;
      this.out.push(Math.max(-128, Math.min(127, Math.round(amp * Math.cos(this.ph) + gauss() * 3))), Math.max(-128, Math.min(127, Math.round(amp * Math.sin(this.ph) + gauss() * 3))));
    }
  }
  quiet(ms) { this.seg(ms * 1000, 0, 0); }
  /** On-off or two-level keying: each [high, us]. */
  ook(levels, hz, amp = 50, low = 0) { for (const [h, us] of levels) this.seg(us, h ? amp : low, hz); }
  /** Frequency keying: each [high, us]. */
  fsk(levels, hz, dev, amp = 50) { for (const [h, us] of levels) this.seg(us, amp, hz + (h ? dev : -dev)); }
  iq() { return Int8Array.from(this.out); }
}

/** Every burst the capture keeps from a signal. */
function capture(air) {
  const bursts = [];
  const cap = new AnalyzerCapture(b => bursts.push(b));
  cap.reset(RATE);
  const iq = air.iq();
  for (let p = 0; p < iq.length; p += 262144) cap.onIq(iq.subarray(p, Math.min(iq.length, p + 262144)), RATE);
  cap.finish();
  return bursts;
}
const read = (b, o) => analyze(b.env, b.fm, b.n, b.rate, o);

// ---- OOK, pulse width: a PT2262-style 24-bit remote, four repeats --------------------------------------------------
{
  const code = randBits(24);
  const air = new Air();
  air.quiet(60);
  const frame = [];
  for (const c of code) frame.push(c === '1' ? [true, 1050] : [true, 350], c === '1' ? [false, 350] : [false, 1050]);
  frame.push([true, 350], [false, 10_850]);
  for (let r = 0; r < 4; r++) air.ook(frame, 210_000);
  air.quiet(150);
  const bursts = capture(air);
  check(bursts.length === 1, `PWM: one burst kept (got ${bursts.length})`);
  const b = bursts[0];
  check(b && near(b.hz, 210_000, 12_000), `PWM: tuned to the burst (${b?.hz})`);
  const a = read(b);
  check(a.mod === 'OOK', `PWM: OOK detected (${a.mod}, ${a.why})`);
  check(a.coding === 'PWM', `PWM: pulse width detected (${a.coding})`);
  check(near(a.symUs, 350, 35), `PWM: symbol 350 us (${a.symUs.toFixed(1)})`);
  check(a.frames.length === 4, `PWM: four frames (${a.frames.length})`);
  check(a.frames.every(f => f.bits.startsWith(code)), `PWM: every frame reads the code (${a.frames.map(f => f.bits).join(' ')} vs ${code})`);
  check(b.matches.some(m => /princeton|remote/i.test(m)), `PWM: the Devices decoders recognize it (${b.matches.join(', ')})`);
  check(near(a.baud, 1e6 / 1400, 40), `PWM: rate ${a.baud.toFixed(0)} bits/s`);
  const inv = read(b, { invert: true });
  check(inv.frames[0].bits.slice(0, 24) === code.replace(/./g, c => (c === '1' ? '0' : '1')), 'PWM: invert flips the bits');
  // the Flipper file: same pulses out and back
  const pu = pulsesUs(a, b.rate);
  const sub = parseSub(toSub(pu, 433_920_000, false, 0));
  check(sub && sub.pulses.length === pu.length && sub.pulses.every((v, i) => v === pu[i]) && sub.freqHz === 433_920_000 && !sub.fsk, 'PWM: .sub round trip');
  check(pu[0] > 0 && pu[pu.length - 1] > 0, '.sub: starts and ends on a mark');
  // and the .sub turned back into samples reads the same
  const again = [];
  captureFile(synthesize(sub.pulses, false), 1_000_000, 'x.sub', bb => again.push(bb));
  const a2 = again.length ? read(again[0]) : null;
  check(a2 && a2.coding === 'PWM' && a2.frames[0]?.bits.startsWith(code), `.sub import reads the same code (${a2?.frames[0]?.bits})`);
}

// ---- OOK, pulse position ---------------------------------------------------------------------------------------
{
  const code = randBits(32);
  const air = new Air();
  air.quiet(60);
  const frame = [[true, 9000], [false, 4500]];
  // a long start mark ends up its own frame part: drop it; PPM proper is constant marks
  frame.length = 0;
  for (const c of code) frame.push([true, 500], [false, c === '1' ? 2000 : 1000]);
  frame.push([true, 500], [false, 12_000]);
  for (let r = 0; r < 3; r++) air.ook(frame, -340_000);
  air.quiet(150);
  const bursts = capture(air);
  check(bursts.length === 1, `PPM: one burst (${bursts.length})`);
  const a = read(bursts[0]);
  check(a.mod === 'OOK' && a.coding === 'PPM', `PPM: OOK + PPM detected (${a.mod} ${a.coding})`);
  check(a.frames.length === 3 && a.frames.every(f => f.bits === code), `PPM: frames read the code (${a.frames.map(f => f.bits).join(' ')})`);
}

// ---- ASK, NRZ -----------------------------------------------------------------------------------------------------
{
  const code = '1010101010101010' + randBits(48);
  const air = new Air();
  air.quiet(60);
  const lv = [];
  for (const c of code) { const h = c === '1'; if (lv.length && lv[lv.length - 1][0] === h) lv[lv.length - 1][1] += 500; else lv.push([h, 500]); }
  air.ook(lv, 80_000, 70, 22);
  air.quiet(150);
  const bursts = capture(air);
  check(bursts.length === 1, `ASK: one burst (${bursts.length})`);
  const a = read(bursts[0]);
  check(a.mod === 'ASK', `ASK detected (${a.mod}, ${a.why})`);
  check(a.coding === 'NRZ', `ASK: NRZ detected (${a.coding})`);
  check(near(a.symUs, 500, 25), `ASK: symbol 500 us (${a.symUs.toFixed(1)})`);
  const bits = a.frames[0]?.bits ?? '';
  check(bits.includes(code.replace(/0+$/, '').slice(1)), `ASK: bits read (${bits} vs ${code})`);
}

// ---- FSK, NRZ (a TPMS-like 19.2 kbaud packet) --------------------------------------------------------------------
{
  const code = '0101010101010101' + '00111111' + randBits(64);
  const air = new Air();
  air.quiet(60);
  const us = 1e6 / 19_200, lv = [];
  for (const c of code) { const h = c === '1'; if (lv.length && lv[lv.length - 1][0] === h) lv[lv.length - 1][1] += us; else lv.push([h, us]); }
  air.fsk(lv, 150_000, 30_000);
  air.quiet(150);
  const bursts = capture(air);
  check(bursts.length === 1, `FSK NRZ: one burst (${bursts.length})`);
  const a = read(bursts[0]);
  check(a.mod === 'FSK', `FSK NRZ: FSK detected (${a.mod}, ${a.why})`);
  check(a.coding === 'NRZ', `FSK NRZ: NRZ detected (${a.coding})`);
  check(near(a.symUs, us, 4), `FSK NRZ: symbol ${us.toFixed(1)} us (${a.symUs.toFixed(1)})`);
  check(near(a.shiftHz, 60_000, 12_000), `FSK NRZ: shift 60 kHz (${a.shiftHz.toFixed(0)})`);
  const bits = a.frames[0]?.bits ?? '';
  check(bits.includes(code.slice(4, -2)), `FSK NRZ: bits read (${bits.length} bits)`);
}

// ---- FSK, Manchester: a hopping key, six packets on three channels ----------------------------------------------
// Made-up bytes in the Land Rover's layout: 24-bit training run, 5 fixed bytes, a channel byte, 2 fixed bytes, a
// 64-bit hop that changes every packet, a 16-bit check.
const FIXED = '34A5C33C96', FIXED2 = '7E81';
const packets = [];
{
  const air = new Air();
  air.quiet(60);
  const chans = [-312_000, 5_000, 323_000];
  for (let p = 0; p < 6; p++) {
    const ch = p % 3, hop = randBits(64), crc = randBits(16);
    const bits = '1010'.repeat(6) + hexBits(FIXED) + (ch << 3).toString(2).padStart(8, '0') + hexBits(FIXED2) + hop + crc;
    packets.push({ bits: bits.slice(24), hop, ch });
    const lv = [[false, 50_000]];
    for (const c of bits) lv.push(c === '1' ? [true, 64] : [false, 64], c === '1' ? [false, 64] : [true, 64]);
    lv.push([false, 200]);
    air.fsk(lv, chans[ch], 23_000);
    air.quiet(30);
  }
  air.quiet(150);
  const bursts = capture(air);
  check(bursts.length === 6, `Manchester: six bursts (${bursts.length})`);
  check(bursts.every((b, i) => near(b.hz, chans[i % 3], 30_000)), `Manchester: each on its channel (${bursts.map(b => (b.hz / 1e3).toFixed(0)).join(', ')})`);
  check(bursts.every(b => near(b.ms, 72, 4)), `Manchester: lengths ${bursts.map(b => b.ms.toFixed(1)).join(', ')} ms`);
  const reads = bursts.map(b => read(b));
  check(reads.every(a => a.mod === 'FSK'), `Manchester: FSK detected (${reads.map(a => a.mod)})`);
  check(reads.every(a => a.coding === 'Manchester'), `Manchester: detected (${reads.map(a => a.coding)})`);
  check(reads.every(a => near(a.symUs, 64, 4)), `Manchester: half bit 64 us (${reads.map(a => a.symUs.toFixed(1))})`);
  check(reads.every(a => near(a.baud, 7812.5, 300)), `Manchester: 7.8 kbit/s (${reads.map(a => a.baud.toFixed(0))})`);
  const frames = reads.map(a => a.frames[a.frames.length - 1]?.bits ?? '');
  check(frames.every((f, i) => f.includes(packets[i].bits.slice(0, 140))), 'Manchester: every packet reads back');
  // line them up
  const al = align(frames);
  check(al.preamble !== null && al.preamble[1] - al.preamble[0] >= 16, `align: preamble found (${al.preamble})`);
  check(al.sync && al.sync.hex.startsWith('34A5C33C'), `align: sync word (${al.sync?.hex})`);
  const base = al.sync ? al.sync.from : 0;
  // fixed bytes fixed, channel bits changing, hop changing
  let fixedOk = true; for (let c = base; c < base + 40; c++) if (al.state[c] !== 1) fixedOk = false;
  check(fixedOk, 'align: the five fixed bytes are fixed');
  check(al.state[base + 40 + 3] === 0 && al.state[base + 40 + 4] === 0, 'align: the channel bits change');
  let fixed2 = true; for (let c = base + 48; c < base + 64; c++) if (al.state[c] !== 1) fixed2 = false;
  check(fixed2, 'align: the two fixed bytes after the channel are fixed');
  let hopCh = 0; for (let c = base + 64; c < base + 128; c++) if (al.state[c] === 0) hopCh++;
  check(hopCh > 50, `align: the hop changes (${hopCh}/64 columns)`);
  check(al.segments.length >= 4, `align: segments ${al.segments.map(s => `${s.fixed ? 'F' : 'C'}${s.to - s.from}`).join(' ')}`);
  // grouping
  const sum = reads.map((a, i) => ({ i, mod: a.mod, coding: a.coding, symUs: a.symUs, bits: frames[i].length }));
  check(similar(sum, sum[0]).length === 6, 'similar: the six packets group together');
}

// ---- alignment from shifted copies ------------------------------------------------------------------------------
{
  const pre = '10'.repeat(12), sync = hexBits('2DD4'), fixed = randBits(24);
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(pre.slice(i * 2) + sync + fixed + randBits(32));
  const al = align(rows);
  const s0 = al.rows.map(r => r.shift);
  check(new Set(rows.map((r, i) => s0[i] + r.length)).size === 1, `align: ragged starts line up on the end (${s0})`);
  check(al.sync && al.sync.hex.startsWith('2DD4'), `align: sync after a ragged preamble (${al.sync?.hex})`);
}

// ---- the Land Rover fixture, through the whole import path ------------------------------------------------------
{
  const text = readFileSync(join(here, 'resources', 'pirate', 'land_rover_fsk.txt'), 'utf8');
  const trains = []; const expect = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('# train')) { cur = []; trains.push(cur); continue; }
    if (line.startsWith('= ')) { expect.push(/Key:([0-9A-F]+)/.exec(line)?.[1]); continue; }
    if (!cur || !line || line[0] === '#') continue;
    const [l, us] = line.split(' ');
    cur.push(l === '1' ? +us : -us);
  }
  const keys = []; const frames = [];
  for (let t = 0; t < trains.length; t++) {
    const pulses = [-60_000, ...trains[t], -2000];
    const got = [];
    captureFile(synthesize(pulses, true), 1_000_000, `lr${t}.sub`, b => got.push(b));
    const b = got.sort((x, y) => y.n - x.n)[0];
    if (!b) continue;
    const a = read(b);
    const f = a.frames.sort((x, y) => y.bits.length - x.bits.length)[0];
    if (!f) continue;
    frames.push(f.bits);
    if (a.mod === 'FSK' && a.coding === 'Manchester') keys.push(f.bits);
    if (t === 0) check(b.matches.some(m => /land rover/i.test(m)), `Land Rover: the Devices decoder recognizes the import (${b.matches})`);
  }
  check(keys.length === trains.length, `Land Rover: every train reads as FSK Manchester (${keys.length}/${trains.length})`);
  const hits = expect.filter(k => frames.some(f => f.includes(hexBits(k).slice(0, 120)))).length;
  check(hits === expect.length, `Land Rover: every expected frame is in the bits (${hits}/${expect.length})`);
  const al = align(frames);
  check(al.sync && al.sync.hex.startsWith('D3683C0E'), `Land Rover: sync word D3683C0E (${al.sync?.hex})`);
  const base = al.sync?.from ?? 0;
  let f5 = true; for (let c = base; c < base + 40; c++) if (al.state[c] !== 1) f5 = false;
  check(f5, 'Land Rover: bytes 0..4 fixed');
  let hop = 0; for (let c = base + 64; c < base + 128; c++) if (al.state[c] === 0) hop++;
  check(hop > 56, `Land Rover: the hop changes (${hop}/64)`);
}

// ---- small things -------------------------------------------------------------------------------------------------
check(bitsToHex('1101001101101') === 'D368', `hex (${bitsToHex('1101001101101')})`);
check(bitsToAscii('0100100001101001') === 'Hi', 'ascii');
check(rateFromName('landrover2_315MHz_2Msps.u8') === 2e6, `rate from name (${rateFromName('landrover2_315MHz_2Msps.u8')})`);
check(rateFromName('analyzer_433.920MHz_250k_3.cu8') === 250e3, `rate from name 250k (${rateFromName('analyzer_433.920MHz_250k_3.cu8')})`);
check(freqFromName('landrover2_315MHz_2Msps.u8') === 315e6, 'freq from name');
check(freqFromName('analyzer_433.920MHz_250k_3.cu8') === 433_920_000, 'freq from name, decimals');
{
  const iq = Int8Array.from([-128, -1, 0, 1, 127, 5]);
  const back = fromIqFile(toCu8(iq), 'x.cu8');
  check(back.every((v, i) => v === iq[i]), 'cu8 round trip');
  check(fromIqFile(new Uint8Array([255, 1]), 'x.cs8')[0] === -1, 'cs8 is signed');
}
check(parseSub('Filetype: Flipper SubGhz Key File\nProtocol: Princeton\nKey: 00 00 00 00 00 12 34 56\n') === null, 'a decoded .sub is not RAW');

console.log(`analyzer: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
