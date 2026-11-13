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
import { pulseTable, symbolFit, clockDrift, frameSegments, levels, eyeStarts, pulseCsv, classCsv, framesCsv, samplesCsv, selectionCsv, groupPresses, sameFrame, syncTrim, AnalyzerCapture, captureFile, analyze, align, bitsToHex, bitsToAscii, pulsesUs, toSub, parseSub, synthesize, toCu8, fromIqFile, rateFromName, freqFromName, similar, histogram, findCheck, findCounter, suggest, dataStart, fromStart, recognize, fieldValue, checkHolds, checkOf, bytesOf, encodeBundle, decodeBundle, passes, NO_FILTER, DEFAULT_FILTER, hasData } from '../dist/dsp/analyzer/index.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const NL = String.fromCharCode(10);
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
  // every bit knows where it lies: a pulse-width bit spans its mark and its gap, 1.4 ms
  const f0 = a.frames[0];
  check(f0.spans.length === 2 * f0.bits.length, `spans: one per bit (${f0.spans.length / 2} for ${f0.bits.length})`);
  check(f0.spans[0] >= f0.start - 2 && f0.spans[f0.spans.length - 1] <= f0.end + 400, 'spans: inside the frame');
  check(near((f0.spans[1] - f0.spans[0]) / b.rate * 1e6, 1400, 60), `spans: a PWM bit is 1.4 ms (${((f0.spans[1] - f0.spans[0]) / b.rate * 1e6).toFixed(0)} us)`);
  const h = histogram(a, b.rate);
  const peak = (v) => { const m = [...v].map((x, i) => [x, i]).sort((x, y) => y[0] - x[0]); return [m[0][1], m[1][1]].map(i => (i + 0.5) * h.binUs).sort((x, y) => x - y); };
  const pm = peak(h.marks);
  check(near(pm[0], 350, 100) && near(pm[1], 1050, 100), `histogram: marks at 350 and 1050 us (${pm.map(x => x.toFixed(0))})`);
  // measurements: the two mark lengths and two gap lengths as classes, the threshold between them, the fit of the
  // symbol, the four repeats with their spacing, and the levels
  const pt = pulseTable(a, b.rate, b.env);
  check(pt.marks.length === 2 && pt.spaces.length === 2, `pulses: two mark and two gap classes (${pt.marks.length}, ${pt.spaces.length})`);
  check(pt.marks[0].count + pt.marks[1].count === 100, `pulses: 100 marks in four frames (${pt.marks.map(c => c.count)})`);
  check(near(pt.marks[0].mean, 350, 25) && near(pt.marks[1].mean, 1050, 25) && near(pt.spaces[0].mean, 350, 25) && near(pt.spaces[1].mean, 1050, 25) && pt.marks.every(c => c.jitterPct < 10), `pulses: lengths true to 25 us, edge to edge (marks ${pt.marks.map(c => c.mean.toFixed(0))}, gaps ${pt.spaces.map(c => c.mean.toFixed(0))}); classes ${pt.marks.map(c => `${c.mean.toFixed(0)}±${c.sd.toFixed(0)}`)}`);
  check(pt.markCuts.length === 1 && pt.markCuts[0] > 450 && pt.markCuts[0] < 950, `pulses: the cut between short and long (${pt.markCuts.map(x => x.toFixed(0))})`);
  check(pt.pulses.every(p => p.hi ? p.cls === (p.us > pt.markCuts[0] ? 1 : 0) : true), 'pulses: each mark in its class');
  const fit = symbolFit(a, b.rate);
  check(fit.errPct < 20 && fit.runs > 150, `symbol fit: error ${fit.errPct.toFixed(1)}% over ${fit.runs} runs`);
  const drift = clockDrift(a, b.rate);
  check(drift.length === 4 && drift.every(d => d.worstPct < 35), `clock: edges stay near the ticks (${drift.map(d => d.worstPct.toFixed(0))}%)`);
  const segs = frameSegments(a, b.rate);
  check(segs.length === 4 && segs.slice(1).every(s => near(s.intervalMs, 44.8, 1.5) && s.diff.length === 0), `frames: four repeats every 44.8 ms, identical (${segs.map(s => s.intervalMs.toFixed(1))})`);
  check(segs.slice(1).every(s => near(s.gapMs, 10.85, 1)), `frames: 10.85 ms between them (${segs.map(s => s.gapMs.toFixed(2))})`);
  const lv = levels(a, b.env, b.fm, b.rate);
  check(lv.depthDb > 20 && lv.markDbfs < 0 && lv.riseUs > 0 && lv.riseUs < 200, `levels: OOK depth ${lv.depthDb.toFixed(0)} dB, rise ${lv.riseUs.toFixed(0)} us`);
  check(near(lv.carrierHz, 0, 6000), `levels: carrier on the channel (${lv.carrierHz.toFixed(0)} Hz)`);
  const eye = eyeStarts(a, b.rate);
  check(eye.starts.length > 300 && near(eye.len, 2 * 350 * b.rate / 1e6, 4), `eye: a trace per symbol (${eye.starts.length})`);
  const csv = selectionCsv({ samples: samplesCsv(b.iq, b.env, b.fm, b.rate, 0, 10), pulses: pulseCsv(pt), classes: classCsv(pt), frames: framesCsv(segs) });
  check(csv.startsWith('# samples' + NL + 'sample,t_us,i,q,envelope,freq_hz' + NL + '0,') && csv.includes('# pulses' + NL + 'frame,index,level') && csv.includes(NL + 'M2,mark,') && csv.includes('# frames' + NL + 'frame,start_ms'), 'csv: four sections');
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
  check(bits.includes(code.slice(8, -2)), `FSK NRZ: bits read (${bits.length} bits)`);
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
  // copies of one frame with different preamble lengths read the same hex from the sync on
  check(frames.every(f => bitsToHex(f).includes('34A5C33C96')), `phase: every copy shows the sync on a byte (${frames.map(f => bitsToHex(f).slice(0, 14)).join(' ')})`);
  const mf = reads[0].frames[reads[0].frames.length - 1];
  check(near((mf.spans[2 * 40 + 1] - mf.spans[2 * 40]) / bursts[0].rate * 1e6, 128, 8), 'spans: a Manchester bit is two half bits');
  const lvf = levels(reads[1], bursts[1].env, bursts[1].fm, bursts[1].rate);
  check(near(lvf.deviationHz, 23_000, 4000) && near(lvf.centerHz, 0, 30_000), `levels: FSK deviation ${lvf.deviationHz.toFixed(0)} Hz, center ${lvf.centerHz.toFixed(0)} Hz`);
  check(lvf.toneHist.reduce((x, y) => x + y, 0) > 1000, 'levels: tone histogram filled');
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
  // the checksum finder: CRC-16/XMODEM over bytes 4..15, stored in 16..17 (as worked out by hand from the recordings)
  const start = dataStart(al);
  const crc = findCheck(fromStart(al, start));
  check(crc && /XMODEM/.test(crc.name) && crc.from === 4 && crc.to === 16 && crc.at === 16 && !crc.little, `Land Rover: CRC found (${crc?.name} over ${crc?.from}..${crc?.to} at ${crc?.at})`);
  const sg = suggest(al);
  const kinds = sg.fields.map(f => f.kind);
  check(kinds.includes('preamble') && kinds.includes('sync') && kinds.includes('crc') && kinds.includes('id'), `Land Rover: fields suggested (${sg.fields.map(f => `${f.kind}:${f.from}-${f.to}`).join(' ')})`);
  // saved as a protocol, it is recognized in a later frame, with the CRC checked
  const proto = { name: 'Land Rover', sync: al.sync.bits, mod: 'FSK', coding: 'Manchester', symUs: 64, fields: sg.fields, check: sg.check };
  const hit = recognize([proto], frames[0], 'FSK', 'Manchester');
  check(hit && hit.protocol.name === 'Land Rover', 'protocol: recognized by its sync');
  check(hit && checkHolds(proto, frames[0], hit.start) === true, 'protocol: its CRC holds on a real frame');
  const broken = frames[0].slice(0, hit.start + 50) + (frames[0][hit.start + 50] === '1' ? '0' : '1') + frames[0].slice(hit.start + 51);
  check(checkHolds(proto, broken, hit.start) === false, 'protocol: a flipped bit fails the CRC');
  check(fieldValue(frames[0], hit.start, sg.fields.find(f => f.kind === 'sync')).startsWith('D3683C0E'), 'protocol: field values read');
  check(recognize([proto], frames[0], 'OOK', 'PWM') === null, 'protocol: another modulation is not it');
}

// ---- counter and checksum on made-up frames ------------------------------------------------------------------
{
  const sync = hexBits('2DD4'), id = hexBits('A1B2');
  const rows = [];
  for (let k = 0; k < 6; k++) {
    const cnt = (40 + (k >> 1)).toString(2).padStart(8, '0');            // two repeats per press
    const body = id + cnt + randBits(16);
    const crc = checkOf({ kind: 'crc', width: 8, poly: 0x07, init: 0, refl: false, xorout: 0 }, bytesOf(body), 0, 5).toString(2).padStart(8, '0');
    rows.push('1010'.repeat(4) + sync + body + crc);
  }
  const al = align(rows);
  const sg = suggest(al);
  const cnt = sg.fields.find(f => f.kind === 'counter');
  check(cnt && cnt.from === 32 && cnt.to === 40, `counter suggested (${cnt?.from}-${cnt?.to})`);
  check(sg.check && /CRC-8/.test(sg.check.name) && sg.check.at === 7, `CRC-8 found (${sg.check?.name} at ${sg.check?.at})`);
  check(findCounter(fromStart(al, dataStart(al)).reverse(), [{ from: 32, to: 40 }]) === null, 'a counter that runs backward in time is not one');
}

// ---- session bundle and capture filter -----------------------------------------------------------------------
{
  const env = Int16Array.from([1, -2, 300, 32767]), fm = Int16Array.from([-32768, 5, 6, 7]), iq = Int8Array.from([1, -1, 2, -2, 127, -128, 0, 5]);
  const meta = { version: 1, bursts: [{ n: 4, id: 7, name: 'gate', star: true, note: 'left button' }], protocols: [{ name: 'p' }] };
  const back = decodeBundle(encodeBundle(meta, [{ env, fm, iq }]));
  check(back && back.meta.bursts[0].name === 'gate' && back.meta.protocols.length === 1, 'bundle: names and protocols round trip');
  check(back && back.arrays[0].env.every((v, i) => v === env[i]) && back.arrays[0].fm.every((v, i) => v === fm[i]) && back.arrays[0].iq.every((v, i) => v === iq[i]), 'bundle: samples round trip');
  check(decodeBundle(new Uint8Array([1, 2, 3])) === null, 'bundle: other bytes are not one');
  const b = { hz: 50_000, snr: 12, ms: 20, matches: [] };
  check(passes(NO_FILTER, b, 433_920_000), 'filter: none lets everything through');
  check(!passes({ ...NO_FILTER, loHz: 434e6 }, b, 433_920_000) && passes({ ...NO_FILTER, loHz: 433.9e6, hiHz: 434e6 }, b, 433_920_000), 'filter: frequency range');
  check(!passes({ ...NO_FILTER, minSnr: 15 }, b, 0) && !passes({ ...NO_FILTER, maxMs: 10 }, b, 0) && !passes({ ...NO_FILTER, minMs: 30 }, b, 0), 'filter: SNR and length');
  check(!passes({ ...NO_FILTER, unknownOnly: true }, { ...b, matches: ['remote: x'] }, 0) && passes({ ...NO_FILTER, unknownOnly: true }, b, 0), 'filter: only unknown');
  check(passes({ ...NO_FILTER, loHz: 434e6 }, b, 0), 'filter: a file with no center skips the frequency test');
  const fr = (n) => [{ bits: '1101001110100010'.repeat(Math.ceil(n / 16)).slice(0, n) }];
  check(!hasData({ frames: [], baud: 0 }, { ms: 1, matches: [] }) && !hasData({ frames: fr(18), baud: 169_000 }, { ms: 1.1, matches: [] }), 'data only: a carrier and a 1 ms tick are dropped');
  check(!hasData({ frames: fr(38), baud: 105_000 }, { ms: 70, matches: [] }) && !hasData({ frames: fr(10), baud: 2000 }, { ms: 20, matches: [] }), 'data only: an implausible rate or too few bits are dropped');
  check(!hasData({ frames: fr(17), baud: 2800 }, { ms: 56, matches: [] }) && hasData({ frames: fr(393), baud: 7808 }, { ms: 123, matches: [] }), 'data only: a few stray bits in 56 ms of noise are dropped, gapped repeats are kept');
  check(hasData({ frames: fr(64), baud: 7800 }, { ms: 20, matches: [] }) && hasData({ frames: [], baud: 0 }, { ms: 1, matches: ['remote: x'] }), 'data only: a real frame, or anything a decoder claims, is kept');
  check(DEFAULT_FILTER.dataOnly && !NO_FILTER.dataOnly, 'data only: on by default');
  check(!hasData({ frames: [{ bits: '10'.repeat(40) }], baud: 4000 }, { ms: 20, matches: [] }), 'data only: a frame that is one short pattern over and over (a ripple, a preamble) is not data');
}

// ---- one press, one stale label: grouped by protocol, named by the majority; another button 2 s later stays apart --
{
  const lr = (id, t, hz, l) => ({ id, t, dur: 0.02, hz, matches: [`car key: Land Rover FSK ${l}`], bits: '1010' });
  const tx = groupPresses([lr(1, 0, 315.0e6, '80E32F'), lr(2, 0.1, 314.7e6, '80E32F'), lr(3, 2.0, 315.0e6, '80E32F'), lr(4, 2.1, 314.7e6, 'C0E32F'), lr(5, 2.2, 315.3e6, 'C0E32F')]);
  check(tx.length === 2 && tx[1].ids.length === 3, 'group: a stale label on one copy does not split a press');
  check(tx[1].label.endsWith('C0E32F') && tx[0].label.endsWith('80E32F'), 'group: a press is named by what most of its copies say');
  const wake = { id: 9, t: 5.0, dur: 0.12, hz: 315.0e6, matches: [], bits: '10'.repeat(60) };
  const data = { id: 10, t: 5.2, dur: 0.02, hz: 314.7e6, matches: ['car key: Land Rover FSK C0E32F'], bits: '1101001110100010110100111' };
  check(groupPresses([wake, data]).length === 1, 'group: an unnamed wake-up preamble goes with the press it is heard in');
}

// ---- an overloaded radio: a strong key's weaker copy elsewhere in the span is dropped, a weak key of its own is not --
{
  // its own generator, so the shared one's sequence (and every test after this) is unchanged
  let sd = 7; const rnd = () => { sd = (sd + 0x6D2B79F5) | 0; let t = sd; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rate = 2e6, n = rate * 0.5, iq = new Int8Array(n * 2);
  const tone = (t, f, a) => [a * Math.cos(2 * Math.PI * f * t), a * Math.sin(2 * Math.PI * f * t)];
  for (let i = 0; i < n; i++) {
    const t = i / rate; let I = (rnd() - 0.5) * 4, Q = (rnd() - 0.5) * 4;
    const key = (t0) => t > t0 && t < t0 + 0.04 && Math.floor((t - t0) / 0.0005) % 2 === 0;
    if (key(0.1)) { let [a, b] = tone(t, 100e3, 90); I += a; Q += b; [a, b] = tone(t, 500e3, 9); I += a; Q += b; }
    if (key(0.3)) { const [a, b] = tone(t, -400e3, 9); I += a; Q += b; }
    iq[2 * i] = Math.max(-127, Math.min(127, Math.round(I))); iq[2 * i + 1] = Math.max(-127, Math.min(127, Math.round(Q)));
  }
  const got = []; const cap = new AnalyzerCapture(b => got.push(b)); cap.reset(rate);
  for (let o = 0; o < iq.length; o += 262144) cap.onIq(iq.subarray(o, o + 262144), rate);
  cap.finish();
  const at = (hz) => got.some(b => Math.abs(b.hz - hz) < 30e3);
  check(at(100e3) && !at(500e3), 'overload: the copy 20 dB down at the same instant is dropped');
  check(at(-400e3), 'overload: a weak key of its own, later, is kept');
}

// ---- a steady emitter with a comb of sidebands: switched on and off, or on throughout, never a capture -----------
{
  let sd = 3; const rnd = () => { sd = (sd + 0x6D2B79F5) | 0; let t = sd; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const kept = (on, rough) => {
    const rate = 2e6, n = rate * 1.5, iq = new Int8Array(n * 2);
    let flick = 1;
    for (let i = 0; i < n; i++) {
      const t = i / rate; let I = (rnd() - 0.5) * 4, Q = (rnd() - 0.5) * 4;
      if (rough ? rnd() < 1 / 60 : i % 200 === 0) flick = rough ? 0.35 + 0.65 * rnd() : 0.85 + 0.3 * rnd();
      if (on(t)) {
        const am = flick * (1 + 0.6 * Math.cos(2 * Math.PI * 30e3 * t) + 0.25 * Math.cos(2 * Math.PI * 61e3 * t));
        const ph = 2 * Math.PI * 5e3 * t; I += 40 * am * Math.cos(ph); Q += 40 * am * Math.sin(ph);
      }
      iq[2 * i] = Math.max(-127, Math.min(127, Math.round(I))); iq[2 * i + 1] = Math.max(-127, Math.min(127, Math.round(Q)));
    }
    const got = []; const cap = new AnalyzerCapture(b => got.push(b)); cap.reset(rate);
    for (let o = 0; o < iq.length; o += 262144) cap.onIq(iq.subarray(o, o + 262144), rate);
    cap.finish();
    return got.filter(b => hasData(analyze(b.env, b.fm, b.n, b.rate), b)).length;
  };
  check(kept(() => true, false) === 0 && kept(() => true, true) === 0, 'steady emitter: on throughout, with sidebands and flicker, gives no captures');
  check(kept(t => (t % 0.5) < 0.3, false) === 0 && kept(t => (t % 0.5) < 0.3, true) === 0, 'steady emitter: switched on and off, its ripple gives no captures');
  check(kept(t => t > 0.4, true) === 0, 'steady emitter: one that comes on mid-capture and stays gives no captures');
}

// ---- OOK whose transmitter pulls its frequency at every mark: still OOK ------------------------------------------
{
  // a cheap 315 MHz remote (a fog machine's): its frequency swings ±60 kHz as each mark keys up and down, so the discriminator spikes at
  // every edge; read as FSK it gave a 6 us "symbol" instead of its real 400 us
  const code = randBits(24);
  const air = new Air();
  air.quiet(60);
  for (let r = 0; r < 5; r++) {
    for (const c of code) {
      const mark = c === '1' ? 1200 : 400, space = c === '1' ? 400 : 1200;
      const wobble = () => { for (let k = 0; k < 3; k++) { air.seg(4, 50, -200_000 + 60_000); air.seg(4, 50, -200_000 - 60_000); } };
      wobble(); air.seg(mark - 48, 50, -200_000); wobble();
      air.seg(space, 0, 0);
    }
    air.seg(400, 50, -200_000); air.quiet(12);
  }
  air.quiet(150);
  const bursts = capture(air);
  const a = bursts.length ? read(bursts[0]) : null;
  check(a && a.mod === 'OOK', `chirpy OOK: read as OOK (${a?.mod}, ${a?.why})`);
  check(a && near(a.symUs, 400, 60), `chirpy OOK: symbol 400 us (${a?.symUs.toFixed(1)})`);
  check(a && a.frames.length === 5 && a.frames.every(f => f.bits.startsWith(code)), `chirpy OOK: five frames read the code (${a?.frames.length})`);
}

// ---- a sensor whose marks run short and gaps long, with a carrier that never fully keys off ---------------------
{
  // Manchester at a 120 us half bit, every mark 20 us short and every gap 20 us long, the off level up to 45% (a fob
  // seen on the owner's Mac): cut low as plain OOK the lengths smear; read right it is 120 us Manchester
  const data = '1010'.repeat(6) + '0110' + randBits(64);
  const half = [];
  for (const c of data) half.push(c === '1' ? 1 : 0, c === '1' ? 0 : 1);
  const lv = [];
  for (const h of half) { if (lv.length && lv[lv.length - 1][0] === !!h) lv[lv.length - 1][1] += 120; else lv.push([!!h, 120]); }
  for (const r of lv) r[1] += r[0] ? -20 : 20;
  const air = new Air();
  air.quiet(60);
  // the off level wanders between nothing and 45% of the mark, so the carrier seems to stop for part of each gap
  const gap = (us) => { for (let t = 0; t < us; t += 10) air.seg(Math.min(10, us - t), Math.round(rnd() * 27), 260_000); };
  for (let rep = 0; rep < 2; rep++) { for (const [h, us] of lv) { if (h) air.seg(us, 60, 260_000); else gap(us); } gap(3000); }
  air.quiet(150);
  const bursts = capture(air);
  const a = bursts.length ? read(bursts[0]) : null;
  check(a && a.coding === 'Manchester' && near(a.symUs, 120, 10), `uneven Manchester: read at 120 us (${a?.mod} ${a?.coding} ${a?.symUs.toFixed(1)})`);
  check(a && a.frames.some(f => f.bits.includes(data.slice(26, 88))), 'uneven Manchester: the data reads back');
}

// ---- Manchester phase and sync trim -----------------------------------------------------------------------------
{
  // a frame opening with a long run of ones reads the same on either half-bit phase for a while; the phase that
  // reads the whole frame cleanly is the right one, so the run must not come out inverted
  const data = '1'.repeat(24) + randBits(80);
  const air = new Air();
  air.quiet(60);
  const lv = [];
  for (const c of data) lv.push(c === '1' ? [true, 64] : [false, 64], c === '1' ? [false, 64] : [true, 64]);
  air.fsk(lv, 120_000, 23_000);
  air.quiet(150);
  const bursts = capture(air);
  const a = bursts.length ? read(bursts[0], { coding: 'Manchester' }) : null;
  const f = a?.frames[a.frames.length - 1]?.bits ?? '';
  check(f.includes(data.slice(4, 100)) && !f.includes('0'.repeat(16)), `phase: a run of ones reads as ones (${bitsToHex(f).slice(0, 12)})`);
  check(syncTrim('10'.repeat(9) + '1' + '1101') === 19 % 8 && syncTrim('0' + '10'.repeat(10) + '0110') === 21 % 8 && syncTrim('1100110011110000') === 0, 'sync trim: to the break in the training run');
}

// ---- one press, many bursts: grouped into a transmission ---------------------------------------------------------
{
  const k = 'car key: Land Rover FSK A824', f1 = randBits(160), f2 = randBits(160), other = randBits(160);
  const flip = (s, i) => s.slice(0, i) + (s[i] === '1' ? '0' : '1') + s.slice(i + 1);
  const bursts = [
    // a press: two hop values, each on three channels, about 100 ms apart
    ...[0, 1, 2, 3, 4, 5].map(i => ({ id: i + 1, t: 10 + i * 0.1016, dur: 0.072, hz: [314.708e6, 315.020e6, 315.342e6][i % 3], matches: [k], bits: i < 3 ? f1 : f2 })),
    // the same key pressed again two seconds later
    { id: 7, t: 12.5, dur: 0.072, hz: 315.020e6, matches: [k], bits: f2 },
    // an unclaimed remote sending one frame four times (one copy with a bit error), then something else at once
    ...[0, 1, 2, 3].map(i => ({ id: 10 + i, t: 20 + i * 0.03, dur: 0.02, hz: 433.92e6, matches: [], bits: i === 2 ? flip(other, 50) : other })),
    { id: 20, t: 20.15, dur: 0.02, hz: 433.92e6, matches: [], bits: randBits(160) },
    // the same frame, but from a file: never grouped with the air
    { id: 30, t: 20.05, dur: 0.02, hz: 433.92e6, matches: [], bits: other, src: 'x.sub' },
  ];
  const tx = groupPresses(bursts);
  check(tx.length === 5, `grouping: five transmissions (${tx.map(t => t.ids.join('+')).join(' | ')})`);
  check(tx[0].ids.length === 6 && tx[0].label === k && tx[0].freqs.length === 3, `grouping: one press, 6 frames on 3 channels (${tx[0].ids.length}, ${tx[0].freqs.map(f => (f / 1e6).toFixed(3))})`);
  check(tx[1].ids.join() === '7', 'grouping: the next press is its own');
  check(tx.some(t => t.ids.join() === '10,11,12,13' && t.label === ''), 'grouping: unclaimed repeats group by their bits, a bit error and all');
  check(tx.some(t => t.ids.join() === '20') && tx.some(t => t.ids.join() === '30'), 'grouping: a different frame, or a file, stays apart');
  check(sameFrame(other, flip(other, 3)) && !sameFrame(other, randBits(160)), 'sameFrame');
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
