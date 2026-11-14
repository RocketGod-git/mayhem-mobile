/**
 * POCSAG over the air through the whole pager hunter: a transmitter that keys up only to send (unlike FLEX, which
 * never stops), its data low-pass shaped, the radio's frequency error and DC offset on top, as signed 8-bit IQ. The
 * survey has to find the carrier, give it a receiver and replay what it missed, and every transmission must decode,
 * the first one included: at 512, 1200 and 2400 baud either way up, on the tuned center, with long gaps, narrow
 * deviation, weak. Noise alone must list no carriers and give no pages.
 */
import { PagerHunter } from '../dist/dsp/pagerhunt.js';
import { bchEncode } from '../dist/dsp/flex.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
console.log('Pager hunter: bursty POCSAG found, replayed and decoded across a span');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

const SYNC = 0x7CD215D8, IDLE = 0x7A89C197;
function pocsagBits(pages) {
  const cws = [];
  for (const [ric, func, text, alpha] of pages) {
    while ((cws.length % 16) / 2 >> 0 !== (ric & 7)) cws.push(IDLE);
    cws.push(bchEncode((((ric >>> 3) & 0x3FFFF) << 2) | func));
    const bits = [];
    if (alpha) { for (const ch of text) for (let k = 0; k < 7; k++) bits.push((ch.charCodeAt(0) >>> k) & 1); for (let k = 0; k < 7; k++) bits.push(k === 2 ? 1 : 0); }
    else for (const ch of text) { const d = '0123456789'.indexOf(ch); for (let k = 0; k < 4; k++) bits.push((d >>> k) & 1); }
    while (bits.length % 20 !== 0) bits.push(alpha ? 0 : (0xC >>> (bits.length % 4)) & 1);
    for (let c = 0; c < bits.length; c += 20) { let v = 0; for (let k = 0; k < 20; k++) v = (v << 1) | bits[c + k]; cws.push(bchEncode((1 << 20) | v)); }
  }
  while (cws.length % 16 !== 0) cws.push(IDLE);
  const out = [];
  for (let i = 0; i < 576; i++) out.push((i + 1) & 1);
  for (let b = 0; b < cws.length / 16; b++) {
    for (let k = 31; k >= 0; k--) out.push((SYNC >>> k) & 1);
    for (let c = 0; c < 16; c++) { const w = cws[b * 16 + c]; for (let k = 31; k >= 0; k--) out.push((w >>> k) & 1); }
  }
  for (let i = 0; i < 64; i++) out.push(i & 1);
  return out;
}

const TEXT = 'CODE BLUE RM 412 EAST';
const BITS = pocsagBits([[1234567, 3, TEXT, true], [765432, 0, '5551234', false]]);

function air({ baud, invert = false, seed, rate = 1_000_000, bursts = 3, gapS = 4, errHz = 1800, amp = 20, chanOff = 312_500, devHz = 4500 }) {
  const center = 152_000_000, chan = center + chanOff, sps = rate / baud;
  const r = rng(seed), table = new Float32Array(1 << 16); for (let i = 0; i < table.length; i++) table[i] = gauss(r);
  let ni = 0; const nz = () => table[(ni = (ni * 1103515245 + 12345) >>> 0) >>> 16];
  const events = [], hunter = new PagerHunter((m) => events.push(m));
  let clockMs = 0; hunter.clock = () => clockMs; hunter.centerHz = center;
  const alpha = 1 - Math.exp(-2 * Math.PI * 0.6 * baud / rate);   // ~0.6 x baud transmitter low-pass
  const burstLen = Math.floor(BITS.length * sps), gap = Math.floor(gapS * rate), lead = 3 * rate;
  const total = lead + bursts * (burstLen + gap), chunk = 131072;
  let ph = 0, shaped = 0;
  for (let s0 = 0; s0 < total; s0 += chunk) {
    const iq = new Int8Array(2 * chunk);
    for (let k = 0; k < chunk; k++) {
      const at = s0 + k;
      let on = false, dev = 0;
      if (at >= lead) {
        const q = (at - lead) % (burstLen + gap);
        if (q < burstLen) { on = true; const b = BITS[Math.min(BITS.length - 1, Math.floor(q / sps))]; dev = (b === 1) !== invert ? -devHz : devHz; }   // a 1 is the low tone
      }
      shaped += (dev - shaped) * alpha;
      let a = nz() * 4 + 5, b = nz() * 4 - 3;   // with the radio's DC offset
      if (on) {
        ph += 2 * Math.PI * (chan - center + errHz + shaped) / rate;
        if (ph > Math.PI) ph -= 2 * Math.PI;
        a += amp * Math.cos(ph); b += amp * Math.sin(ph);
      }
      iq[2 * k] = Math.max(-127, Math.min(127, Math.round(a))); iq[2 * k + 1] = Math.max(-127, Math.min(127, Math.round(b)));
    }
    clockMs = (s0 + chunk) / rate * 1000;
    hunter.onIq(iq, rate);
  }
  const state = events.filter(e => e.type === 'huntState').pop();
  return { pages: events.filter(e => e.type === 'huntPage' && e.page).map(e => e.page), channels: state?.channels ?? [] };
}

function check(name, opts) {
  const bursts = opts.bursts ?? 3, { pages } = air(opts);
  const a = pages.filter(p => p.cap === 1234567), n = pages.filter(p => p.cap === 765432);
  ok(a.length === bursts && a.every(p => p.text === TEXT && p.protocol === 'POCSAG' && p.rate === String(opts.baud)), `${name}: every alpha page, the first included`, JSON.stringify(pages.map(p => [p.cap, p.rate, p.text])));
  ok(n.length === bursts && n.every(p => p.text === '5551234'), `${name}: every numeric page`, JSON.stringify(n.map(p => p.text)));
}

for (const baud of [512, 1200, 2400]) for (const invert of [false, true]) check(`POCSAG ${baud}${invert ? ' inverted' : ''}`, { baud, invert, seed: baud + (invert ? 1 : 0) });
check('on the tuned center (the DC spike)', { baud: 1200, seed: 37, chanOff: 0 });
check('512 inverted, weak, 2.5 kHz off center', { baud: 512, invert: true, seed: 38, chanOff: 2500, amp: 1.4, rate: 2_400_000 });
check('a pager that keys up every half minute', { baud: 2400, seed: 39, gapS: 30 });
check('narrow deviation, 5 kHz frequency error, 2.4 Msps', { baud: 1200, invert: true, seed: 40, devHz: 2500, errHz: 5000, rate: 2_400_000 });
check('2400 baud, weak', { baud: 2400, seed: 41, amp: 1.4, rate: 2_400_000 });
{
  const { pages, channels } = air({ baud: 1200, seed: 42, amp: 0, bursts: 1 });
  ok(pages.length === 0, 'noise alone: no pages', JSON.stringify(pages));
  ok(channels.length === 0, 'noise alone: no carriers listed', JSON.stringify(channels));
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
