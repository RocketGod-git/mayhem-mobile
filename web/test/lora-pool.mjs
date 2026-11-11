/**
 * The LoRa standing channels run off the scanner (the browser hands them to Web Workers at 20 Msps): the same real
 * Meshtastic LongFast frame, inside a 2 Msps span, decoded by a ChannelRunner the way a pool worker runs it, with
 * the buffers and the frames passed between them as a worker pool passes them (structured clones).
 */
import { readFileSync } from 'node:fs';
import { LoraHub } from '../dist/dsp/lora/hub.js';
import { ChannelRunner } from '../dist/dsp/lora/scanner.js';
import { fft } from '../dist/fft.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };
console.log('LoRa: standing channels in a pool worker');

const LONGFAST_US = 906_875_000, RATE = 2_000_000, CENTER = LONGFAST_US + 300_000;
// the 250 kHz clip, FFT-upsampled to 2 Msps and placed -300 kHz from the center, in noise
const raw = new Int8Array(readFileSync(new URL('./resources/meshtastic_nodeinfo_a_250k_sf11.i8', import.meta.url)).buffer.slice(0));
const n = raw.length / 2;
let big = 1; while (big < n) big <<= 1;
const re = new Float32Array(big), im = new Float32Array(big);
for (let k = 0; k < n; k++) { re[k] = raw[2 * k]; im[k] = raw[2 * k + 1]; }
fft(re, im);
const m = big * 8, r2 = new Float32Array(m), i2 = new Float32Array(m);
for (let k = 0; k < big; k++) { const dst = k < big / 2 ? k : m - (big - k); r2[dst] = re[k]; i2[dst] = -im[k]; }
fft(r2, i2);
const lead = RATE / 2, total = lead + m + lead, iq = new Int8Array(2 * total);
let seed = 1;
const noise = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return (seed >>> 8) / (1 << 24) - 0.5; };
const w = 2 * Math.PI * (LONGFAST_US - CENTER) / RATE, sc = 0.3 / big;
for (let k = 0; k < total; k++) {
  let x = 6 * noise(), y = 6 * noise();
  const s = k - lead;
  if (s >= 0 && s < m) { const a = r2[s] * sc, b = -i2[s] * sc, c = Math.cos(w * k), d = Math.sin(w * k); x += a * c - b * d; y += a * d + b * c; }
  iq[2 * k] = Math.max(-128, Math.min(127, Math.round(x))); iq[2 * k + 1] = Math.max(-128, Math.min(127, Math.round(y)));
}

/** A pool whose one worker is a ChannelRunner here, every message structured-cloned as postMessage would. */
function syncPool() {
  const runner = new ChannelRunner(); runner.shedding = false;
  const pool = {
    onHeard: null, busy: 0, added: [], dropped: [],
    feed(buf, start) { runner.feed(structuredClone(buf), start, RATE); },
    add(spec) { pool.added.push(spec); runner.add(structuredClone(spec)); },
    drop(ids) { pool.dropped.push(...ids); runner.drop(ids); },
    reset() { runner.reset(); },
  };
  runner.onHeard = (id, f, hz, inv, at) => pool.onHeard?.(id, structuredClone(f), hz, inv, at);
  return pool;
}

const msgs = [];
const hub = new LoraHub(x => msgs.push(x));
hub.scanner.shedding = false;
hub.setCenter(CENTER);
hub.reset(RATE);
const pool = syncPool();
hub.scanner.pool = pool;
for (let at = 0; at < iq.length; at += 32768) hub.onIq(iq.subarray(at, Math.min(iq.length, at + 32768)), RATE);
hub.flush();
const snap = msgs.filter(x => x.type === 'lora').pop();
const lines = msgs.filter(x => x.type === 'packet').map(x => x.line);
ok(pool.added.length >= 1 && pool.added.every(sp => sp.name.length > 0), 'the standing channels went to the pool', JSON.stringify(pool.added.map(sp => sp.name)));
ok(lines.some(l => l.includes('MESHTASTIC') && l.includes('NODEINFO_APP')), 'the frame decoded in the pool', JSON.stringify(lines));
ok(snap.nodes.length === 1, 'one node', `${snap.nodes.length}`);
ok(snap.channels.some(c => c.standing && c.frames >= 1), 'counted on its standing channel', JSON.stringify(snap.channels));
// the span moves: the pool's channels are dropped and placed again
hub.setCenter(CENTER + 1_000);
hub.onIq(iq.subarray(0, 32768), RATE);
ok(pool.dropped.length >= 1 && pool.added.length >= 2, 'a retune drops the pool channels and places them again');
// back inline: the pool's channels stop there
const before = pool.dropped.length;
hub.scanner.pool = null;
hub.onIq(iq.subarray(0, 32768), RATE);
ok(pool.dropped.length > before, 'taking the pool away drops its channels');
ok(hub.scanner.openChannels >= 1, 'and the standing channels run inline again');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
