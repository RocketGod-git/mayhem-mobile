/**
 * Meters: a busy network's misread syncs are a bit slipped (the search locked early or late, or on the preamble's
 * tail), not a few bits flipped. These six came off the air as F6E56B frames; they must not found networks of their
 * own (on the air one network was listed as about a hundred). A real second network must still be listed.
 */
import { MeshDecoder } from '../dist/dsp/mesh.js';

let pass = 0, fail = 0;
const ok = (c, what, extra = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${extra ? ' — ' + extra : ''}`); } };

const d = new MeshDecoder(() => {});
let ms = 1000;
const frame = sync => { const f = { ms, hz: 915_000_000, snrDb: 20, sync, baud: 9600, bytes: [0xD7, 0xF5, 0x39, 0x12], durMs: 10, crcOk: false, lenOk: false }; ms += 10; return f; };
for (let i = 0; i < 30; i++) d.publish(frame(0xF6E56B));
const ghosts = [0xF56BD7, 0xB95AD7, 0x95AD7F, 0xD557DB, 0xD57DB9, 0xFB95AF];
for (let i = 0; i < 25; i++) for (const g of ghosts) d.publish(frame(g));
ms += 2000; d.publish(frame(0xF6E56B)); d.flush();
ok(d.nets.length === 1 && d.nets[0].sync === 0xF6E56B, 'slipped syncs found no networks', d.nets.map(n => n.sync.toString(16)).join(','));
ok(d.slips === 25 * ghosts.length, 'every slipped frame counted', `${d.slips}`);
for (let i = 0; i < 25; i++) d.publish(frame(0x3C9A41));
ms += 2000; d.publish(frame(0xF6E56B)); d.flush();
ok(d.nets.some(n => n.sync === 0x3C9A41), 'a real second network is still listed');

console.log(`mesh-slip: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
