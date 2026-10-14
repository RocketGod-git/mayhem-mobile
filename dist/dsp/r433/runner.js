import { slice } from './slicers.js';
import { FSK_DEMOD_MIN_VAL, REGISTRY } from './device.js';
function snapshot(bits) {
    const rows = [];
    for (let r = 0; r < bits.numRows; r++) {
        const n = bits.bitsPerRow[r];
        if (n)
            rows.push({ n, bytes: bits.bb[r].slice(0, (n + 7) >> 3) });
    }
    return rows;
}
function rawText(rows) {
    return rows.map(({ n, bytes }) => {
        let hex = '';
        for (const v of bytes)
            hex += v.toString(16).padStart(2, '0');
        return `{${n}}${hex}`;
    }).join('/');
}
export class R433 {
    constructor(devices) {
        this.stats = { bursts: 0, ook: 0, fsk: 0, decoded: 0, badChecksum: 0, near: {} };
        this.devices = (devices ?? REGISTRY.slice())
            .slice()
            .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    }
    run(kind, pulses) {
        const out = [];
        this.stats.bursts++;
        if (kind === 2)
            this.stats.fsk++;
        else
            this.stats.ook++;
        const wantFsk = kind === 2;
        for (const dev of this.devices) {
            if ((dev.modulation >= FSK_DEMOD_MIN_VAL) !== wantFsk)
                continue;
            let raw = [];
            const ctx = {
                emit: (d) => { out.push({ dev, data: { ...d, raw: rawText(raw), protocol: dev.num } }); },
            };
            slice(pulses, dev, (bits) => {
                let n = 0;
                raw = snapshot(bits);
                try {
                    n = dev.decode(dev, bits, ctx);
                }
                catch {
                    n = 0;
                }
                if (n === -3) {
                    this.stats.badChecksum++;
                    this.stats.near[dev.name] = (this.stats.near[dev.name] ?? 0) + 1;
                }
                bits.clear();
                return n > 0 ? n : 0;
            });
        }
        this.stats.decoded += out.length;
        return out;
    }
}
