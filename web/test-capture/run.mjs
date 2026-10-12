// usage: node test-capture/run.mjs <test.mjs> <out.json>
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REGISTRY } from '../dist/dsp/r433/device.js';
import '../dist/dsp/r433/devices/index.js';

const [,, testPath, outPath] = process.argv;
const POS = 60, NEG = 6;
const per = new Map();
const out = [];
for (const dev of REGISTRY) {
  const orig = dev.decode;
  dev.decode = (d, bits, ctx) => {
    const rows = [];
    for (let r = 0; r < bits.numRows; r++) {
      const n = bits.bitsPerRow[r];
      let hex = '';
      for (let i = 0; i < ((n + 7) >> 3); i++) hex += bits.bb[r][i].toString(16).padStart(2, '0');
      rows.push({ n, hex, s: bits.syncsBeforeRow[r] });
    }
    const emitted = [];
    const c2 = { emit: x => { emitted.push(x); ctx.emit(x); }, log: ctx.log };
    const ret = orig(d, bits, c2);
    const k = per.get(dev.num) ?? { pos: 0, neg: 0 };
    const isPos = ret > 0 || emitted.length > 0;
    if ((isPos && k.pos < POS) || (!isPos && k.neg < NEG && rows.some(r => r.n > 0))) {
      out.push({ num: dev.num, name: dev.name, rows, ret, out: emitted });
      if (isPos) k.pos++; else k.neg++;
      per.set(dev.num, k);
    }
    return ret;
  };
}
const replacer = (_k, v) => {
  if (v instanceof Uint8Array || v instanceof Int8Array || v instanceof Uint16Array || v instanceof Int16Array || v instanceof Int32Array || v instanceof Float32Array || v instanceof Float64Array) return Array.from(v);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
};
process.on('exit', () => { writeFileSync(outPath, JSON.stringify(out, replacer)); });
console.log = () => {};
await import(pathToFileURL(testPath).href);
