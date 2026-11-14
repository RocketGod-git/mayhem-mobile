/**
 * Flipper Unleashed Sub-GHz remotes, group B (elplast, faac_tm, feron, freezer, hay21, hollarm, jarolift, keyfinder).
 * Each pulse train is built the way the protocol's own encoder in the .c lays it out, fed to a fresh decoder, and the hit,
 * the raw key and the parsed fields are checked. Twins: RemotesUlBTest.kt and RemotesUlBTest.swift.
 */
const { SElplast } = await import('../dist/dsp/ism/s-elplast.js');
const { SFaacTm } = await import('../dist/dsp/ism/s-faac_tm.js');
const { SFeron } = await import('../dist/dsp/ism/s-feron.js');
const { SFreezer } = await import('../dist/dsp/ism/s-freezer.js');
const { SHay21 } = await import('../dist/dsp/ism/s-hay21.js');
const { SHollarm } = await import('../dist/dsp/ism/s-hollarm.js');
const { SJarolift } = await import('../dist/dsp/ism/s-jarolift.js');
const { SKeyfinder } = await import('../dist/dsp/ism/s-keyfinder.js');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed++; else { failed++; console.error('FAIL ' + name + (detail ? ': ' + detail : '')); }
}

const bit = (v, i) => Number((BigInt(v) >> BigInt(i)) & 1n);
const reverse = (v, n) => { let r = 0n; for (let i = 0; i < n; i++) r = (r << 1n) | BigInt(bit(v, i)); return r; };

/** Deterministic timing jitter of up to 3 percent. `keep` leaves a pulse exact. */
const F = [1.03, 0.97, 1.02, 0.98, 1.01, 0.99];
const jitter = (pulses, keep = () => false) => pulses.map(([l, d], i) => [l, keep(d) ? d : Math.round(d * F[i % F.length])]);

/** Feeds a train to a fresh decoder; returns every hit as { data, data2, bits, info }. */
function run(make, pulses) {
  const p = make();
  const hits = [];
  p.callback = (q) => hits.push({ data: q.decodeData, data2: q.decodeData2, bits: q.dataCountBit, info: q.remoteInfo() });
  for (const [l, d] of pulses) p.feed(l, d);
  return hits;
}

function expectHit(name, make, pulses, data, bits, serial, btn, cnt, extra, data2 = 0n) {
  for (const [tag, train] of [['clean', pulses], ['jitter', name === 'feron' ? jitter(pulses, (d) => d === 500) : jitter(pulses)]]) {
    const n = `${name} ${tag}`;
    const hits = run(make, train);
    check(n + ' hits', hits.length >= 1, `got ${hits.length}`);
    if (!hits.length) continue;
    const h = hits[0];
    check(n + ' data', h.data === data, `0x${h.data.toString(16)} vs 0x${data.toString(16)}`);
    check(n + ' data2', h.data2 === data2, `0x${h.data2.toString(16)}`);
    check(n + ' bits', h.bits === bits, `${h.bits}`);
    check(n + ' info', h.info !== null);
    if (!h.info) continue;
    check(n + ' serial', h.info.serial === serial, `0x${h.info.serial.toString(16)}`);
    check(n + ' btn', h.info.btn === btn, `${h.info.btn}`);
    check(n + ' cnt', h.info.cnt === cnt, `${h.info.cnt}`);
    const ex = tag === 'clean' ? extra : extra.filter((e) => !e.startsWith('Te: '));
    for (const e of ex) check(n + ' extra ' + e, h.info.extra.includes(e), JSON.stringify(h.info.extra));
  }
}

// ---- encoders (from each protocol's get_upload) ----
function elplast(data, n = 18) {
  const p = [[false, 1550 * 8]];
  for (let i = n; i > 0; i--) {
    if (bit(data, i - 1)) p.push([true, 1550], [false, i === 1 ? 1550 * 8 : 230]);
    else p.push([true, 230], [false, i === 1 ? 1550 * 8 : 1550]);
  }
  return p;
}
function faacTm(data, te = 400) {
  const p = [[false, te * 35], [true, te]];
  for (let i = 12; i > 0; i--) {
    if (bit(data, i - 1)) p.push([false, te], [true, te * 2]); else p.push([false, te * 2], [true, te]);
  }
  p.push([false, te * 35]); // next repeat's header closes the frame
  return p;
}
function feron(data) {
  const p = [[false, 750 * 6]];
  for (let i = 32; i > 0; i--) {
    p.push([true, bit(data, i - 1) ? 750 : 350]);
    if (i === 1) p.push([false, 500], [true, 500], [false, 750 * 6]);
    else p.push([false, bit(data, i - 1) ? 350 : 750]);
  }
  return p;
}
function freezerFrame(data) {
  const p = [[true, 250]];
  for (let i = 24; i > 0; i--) {
    if (bit(data, i - 1)) p.push([false, 250], [true, 500]); else p.push([false, 500], [true, 250]);
  }
  p.push([false, 250 * 36]);
  return p;
}
function hay21(data) {
  const p = [[false, 700 * 6]];
  for (let i = 21; i > 0; i--) {
    if (bit(data, i - 1)) p.push([true, 700], [false, i === 1 ? 4200 : 300]);
    else p.push([true, 300], [false, i === 1 ? 4200 : 700]);
  }
  return p;
}
function hollarm(data) {
  const d = BigInt(data) << 2n;
  const p = [[false, 200 * 12]];
  for (let i = 42; i > 0; i--) p.push([true, 200], [false, i === 1 ? 2400 : bit(d, i - 1) ? 1600 : 1000]);
  return p;
}
function jarolift(data, group) {
  const p = [[false, 800 * 18], [true, 1500], [false, 400]];
  for (let i = 0; i < 8; i++) p.push([true, 400], [false, i === 7 ? 3800 : 400]);
  const cell = (b) => (b ? [[true, 400], [false, 800]] : [[true, 800], [false, 400]]);
  for (let i = 64; i > 0; i--) p.push(...cell(bit(data, i - 1)));
  for (let i = 8; i > 0; i--) p.push(...cell(bit(group, i - 1)));
  p[p.length - 1] = [false, p[p.length - 1][1] + 800 * 18]; // the last low runs into the next repeat's 14.4 ms lead-in
  return p;
}
function keyfinder(data) {
  const p = [[false, 4000]];
  for (let i = 24; i > 0; i--) {
    if (bit(data, i - 1)) p.push([true, 400], [false, 1200]); else p.push([true, 1200], [false, 400]);
  }
  for (let i = 0; i < 3; i++) p.push([true, 400], [false, 400]);
  p.push([true, 400], [false, 4000]);
  return p;
}

// ---- cases ----
expectHit('elplast', () => new SElplast(), elplast(0x32C0An), 0x32C0An, 18, 0n, null, null,
  ['Yek: 0x' + reverse(0x32C0An, 18).toString(16).toUpperCase().padStart(5, '0')]);

expectHit('faac_tm', () => new SFaacTm(), faacTm(0xA5Cn), 0xA5Cn, 12, 0n, null, null, ['Te: 400us', 'DIP: 101001011100']);

expectHit('feron', () => new SFeron(), feron(0x6338857An), 0x6338857An, 32, 0x6338n, null, null, ['Command: 0x857A']);

{
  const key = 0xABCDE3n;
  const twice = [[false, 9000], ...freezerFrame(key), ...freezerFrame(key)];
  expectHit('freezer', () => new SFreezer(), twice, key, 24, 0xABCDEn, 3, null, []);
  check('freezer single frame not reported', run(() => new SFreezer(), [[false, 9000], ...freezerFrame(key)]).length === 0);
  check('freezer two different frames not reported', run(() => new SFreezer(), [[false, 9000], ...freezerFrame(key), ...freezerFrame(key ^ 0x10n)]).length === 0);
}

expectHit('hay21', () => new SHay21(), hay21(0x1877B9n), 0x1877B9n, 21, 0xBDn, 0xC3, 0xC, ['Button: Mode']);

expectHit('hollarm', () => new SHollarm(), hollarm(0xF0B93422FFn), 0xF0B93422FFn, 42, 0xF0B934n, 2, null, ['Sum: FF', 'Button: Arm']);
check('hollarm bad sum not reported', run(() => new SHollarm(), hollarm(0xF0B93422FEn)).length === 0);
check('hollarm flipped bit not reported', run(() => new SHollarm(), hollarm(0xF0B93522FFn)).length === 0);

{
  // Reversed key = btn 8 (Up) | serial 0x1234567 | hop 0xDEADBEEF; reversed grouping byte 0x01
  const fixHop = 0x81234567DEADBEEFn;
  const data = reverse(fixHop, 64), group = reverse(0x01n, 8);
  expectHit('jarolift', () => new SJarolift(), jarolift(data, group), data, 72, 0x1234567n, 8, null,
    ['Button: Up', 'Hop: DEADBEEF (encrypted)', 'Group: 01'], group);
}

expectHit('keyfinder', () => new SKeyfinder(), keyfinder(0xC396FEn), 0xC396FEn, 24, 0xC396Fn, 0xE, null,
  ['Yek: 0x' + reverse(0xC396FEn, 24).toString(16).toUpperCase().padStart(6, '0')]);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
