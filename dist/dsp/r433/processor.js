import { Baseband } from './baseband.js';
import { PulseDetect } from './detect.js';
import { R433 } from './runner.js';
import { REGISTRY } from './device.js';
import { describeBurst, shapeSummary } from './analyze.js';
import './devices/index.js';
const CODING = {
    3: 'Manchester', 4: 'level per bit', 5: 'pulse position', 6: 'pulse width',
    8: 'level per bit, raw', 9: 'differential Manchester', 10: 'pulse width, Oregon v1',
    11: 'level per bit, clocked', 12: 'NRZ-S', 13: 'return to zero, inverted',
    16: 'frequency shift, level per bit', 17: 'frequency shift, pulse width',
    18: 'frequency shift, Manchester',
};
export function protocolList() {
    return REGISTRY.map(d => ({
        num: d.num,
        name: d.name,
        what: d.what ?? '',
        coding: CODING[d.modulation] ?? String(d.modulation),
        bands: (d.bands ?? []).map(hz => hz / 1e6),
        doubtful: !!d.disabled,
    })).sort((a, b) => a.num - b.num);
}
function keyOf(model, d) {
    const id = d.id !== undefined ? String(d.id) : '';
    const ch = d.channel !== undefined ? String(d.channel) : '';
    const sub = d.subtype !== undefined ? String(d.subtype) : '';
    return [model, id, ch, sub].filter(Boolean).join('/');
}
const STATS_MS = 1000;
export class R433Processor {
    constructor(emit) {
        this.emit = emit;
        this.baseband = new Baseband();
        this.detect = new PulseDetect(2000000);
        this.radio = new R433();
        this.rate = 0;
        this.lastStats = 0;
        this.heard = new Map();
        this.lastPayload = new Map();
        this.unknownSeen = new Map();
        this.wantSpan = 250000;
    }
    reset(rate) {
        this.rate = rate;
        this.baseband.reset();
        let decim = 1;
        while (rate / (decim * 2) >= this.wantSpan)
            decim *= 2;
        this.baseband.decim = decim;
        this.detect = new PulseDetect(Math.round(rate / decim));
        this.lastStats = 0;
    }
    setSpan(hz) {
        this.wantSpan = hz;
        if (this.rate)
            this.reset(this.rate);
    }
    span() {
        return this.rate ? Math.round(this.rate / (this.baseband.decim || 1)) : 0;
    }
    setProtocols(nums) {
        const devices = nums && nums.length
            ? REGISTRY.filter(d => nums.includes(d.num))
            : REGISTRY.slice();
        this.radio = new R433(devices);
    }
    clear() {
        this.heard.clear();
        this.lastPayload.clear();
        this.unknownSeen.clear();
    }
    onIq(iq, rate) {
        if (rate !== this.rate)
            this.reset(rate);
        const { env, fm, n } = this.baseband.process(iq);
        const sink = (kind, pulses) => {
            const found = this.radio.run(kind, pulses);
            const verified = found.some(r => !r.dev.disabled);
            for (const res of found) {
                if (verified && res.dev.disabled)
                    continue;
                this.report(res.dev, res.data, kind);
            }
            if (!found.length)
                this.reportUnknown(pulses);
        };
        this.detect.process(env, fm, n, sink);
        const now = Date.now();
        if (now - this.lastStats >= STATS_MS) {
            this.lastStats = now;
            const lv = this.detect.levels();
            const report = {
                ...this.radio.stats, devices: this.heard.size, protocols: this.radio.devices.length,
                noise: lv.noise, trigger: lv.trigger, span: this.span(),
            };
            this.emit({ type: 'r433stats', ...report });
        }
    }
    reportUnknown(p) {
        if (p.numPulses < 8)
            return;
        const shape = describeBurst(p);
        const key = `? ${shape.key}`;
        const now = Date.now();
        const seen = this.unknownSeen.get(key) ?? 0;
        if (now - seen < 1000)
            return;
        this.unknownSeen.set(key, now);
        console.log(`[r433] unidentified · ${shape.fsk ? 'FSK' : 'OOK'} · ${shapeSummary(shape)} · ${shape.coding || 'coding unsettled'}`, shape);
    }
    report(dev, data, kind) {
        const key = keyOf(data.model, data);
        const now = Date.now();
        const json = JSON.stringify(data);
        const last = this.lastPayload.get(key);
        if (last && last.json === json && now - last.at < 1000)
            return;
        this.lastPayload.set(key, { json, at: now });
        if (dev.disabled) {
            console.log(`[r433] unverified ${data.model} (protocol ${dev.num})`, data);
            return;
        }
        const prev = this.heard.get(key);
        const entry = {
            key,
            model: data.model,
            num: dev.num,
            what: dev.what ?? dev.name,
            count: (prev?.count ?? 0) + 1,
            firstSeen: prev?.firstSeen ?? now,
            lastSeen: now,
            data,
        };
        this.heard.set(key, entry);
        this.emit({ type: 'r433', ...entry, fsk: kind === 2 });
    }
}
