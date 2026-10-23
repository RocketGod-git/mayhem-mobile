import { Fam } from './base.js';
import { allProtos } from './registry.js';
import { parseWeather } from './weather-fields.js';
import { parseRemote } from './remote-fields.js';
import { parseCar } from './car-fields.js';
const STATE_IDLE = 0, STATE_PULSE = 1, STATE_GAP_START = 2, STATE_GAP = 3, MIN_HIGH = 4, MAX_HIGH = 60000;
const hex = (v, w = 8) => v.toString(16).toUpperCase().padStart(w, '0');
export class IsmDecoder {
    constructor(emit) {
        this.emit = emit;
        this.weather = true;
        this.remotes = true;
        this.cars = true;
        this.dcI = 0;
        this.dcQ = 0;
        this.dec = 4;
        this.accI = 0;
        this.accQ = 0;
        this.accN = 0;
        this.nsPerSamp = 2000;
        this.state = STATE_IDLE;
        this.lowEstimate = 10;
        this.highEstimate = 1000;
        this.numg = 0;
        this.currentDurationNs = 0;
        this.currentHiLow = false;
        this.seen = new Map();
        this.protos = allProtos();
        for (const p of this.protos)
            p.callback = (q) => this.onHit(q);
    }
    reset(rate) {
        this.dec = Math.max(1, Math.floor(rate / 500000));
        this.nsPerSamp = 1e9 / (rate / this.dec);
        this.accI = this.accQ = this.accN = 0;
        this.state = STATE_IDLE;
        this.lowEstimate = 10;
        this.highEstimate = 1000;
        this.numg = 0;
        this.currentDurationNs = 0;
        this.currentHiLow = false;
    }
    onIq(iq) {
        const nSamp = iq.length >> 1;
        let sI = 0, sQ = 0;
        for (let i = 0; i < nSamp; i++) {
            sI += iq[2 * i];
            sQ += iq[2 * i + 1];
        }
        this.dcI += 0.2 * (sI / nSamp - this.dcI);
        this.dcQ += 0.2 * (sQ / nSamp - this.dcQ);
        for (let i = 0; i < nSamp; i++) {
            this.accI += iq[2 * i] - this.dcI;
            this.accQ += iq[2 * i + 1] - this.dcQ;
            if (++this.accN < this.dec)
                continue;
            const ci = this.accI / this.accN, cq = this.accQ / this.accN;
            this.accI = this.accQ = 0;
            this.accN = 0;
            this.sample(ci * ci + cq * cq);
        }
    }
    sample(mag) {
        const threshold = (this.lowEstimate + this.highEstimate) / 2;
        const hysteresis = threshold / 8;
        let meashl = this.currentHiLow;
        switch (this.state) {
            case STATE_IDLE:
                if (mag > threshold + hysteresis) {
                    meashl = true;
                    this.state = STATE_PULSE;
                    this.numg = 0;
                }
                else {
                    meashl = false;
                    const delta = mag - this.lowEstimate;
                    this.lowEstimate += delta / 5;
                    this.lowEstimate += delta > 0 ? 0.01 : -0.01;
                    if (this.lowEstimate < 0.5)
                        this.lowEstimate = 0.5;
                    this.highEstimate = Math.min(MAX_HIGH, Math.max(MIN_HIGH, 1.35 * this.lowEstimate));
                }
                break;
            case STATE_PULSE:
                if (++this.numg > 100)
                    this.numg = 100;
                if (mag < threshold - hysteresis) {
                    if (this.numg < 3)
                        this.state = STATE_GAP;
                    else {
                        this.numg = 0;
                        this.state = STATE_GAP_START;
                    }
                    meashl = false;
                }
                else {
                    this.highEstimate += mag / 3 - this.highEstimate / 3;
                    this.highEstimate = Math.min(MAX_HIGH, Math.max(MIN_HIGH, this.highEstimate));
                    meashl = true;
                }
                break;
            case STATE_GAP_START:
                ++this.numg;
                if (mag > threshold + hysteresis) {
                    this.state = STATE_PULSE;
                    meashl = true;
                }
                else if (this.numg >= 3) {
                    this.state = STATE_GAP;
                    meashl = false;
                }
                break;
            case STATE_GAP:
                ++this.numg;
                if (mag > threshold + hysteresis) {
                    this.numg = 0;
                    this.state = STATE_PULSE;
                    meashl = true;
                }
                else
                    meashl = false;
                break;
        }
        if (meashl === this.currentHiLow && this.currentDurationNs < 30000000)
            this.currentDurationNs += this.nsPerSamp;
        else {
            if (this.currentDurationNs >= 30000000)
                this.state = STATE_IDLE;
            this.feed(this.currentHiLow, Math.floor(this.currentDurationNs / 1000));
            this.currentDurationNs = this.nsPerSamp;
            this.currentHiLow = meashl;
        }
    }
    feed(level, durationUs) {
        for (const p of this.protos) {
            const on = p.family === Fam.WEATHER ? this.weather : p.family === Fam.REMOTE ? this.remotes : this.cars;
            if (on)
                p.feed(level, durationUs);
        }
    }
    onHit(p) {
        const key = `${p.family}:${p.sensorType}:${p.decodeData}:${p.decodeData2}`;
        const now = performance.now();
        if (now - (this.seen.get(key) ?? -1e9) < 1200)
            return;
        this.seen.set(key, now);
        if (this.seen.size > 500)
            this.seen.clear();
        let line;
        if (p.family === Fam.WEATHER) {
            const w = parseWeather(p.sensorType, p.decodeData);
            line = `WX ${w.name.padEnd(20)} id ${w.id}`;
            if (w.channel !== null)
                line += `  ch ${w.channel}`;
            if (w.temp !== null)
                line += `  ${w.temp.toFixed(1)}°C / ${(w.temp * 9 / 5 + 32).toFixed(1)}°F`;
            if (w.humidity !== null)
                line += `  ${w.humidity}%`;
            if (w.batteryLow !== null)
                line += w.batteryLow ? '  batt LOW' : '  batt OK';
        }
        else if (p.family === Fam.REMOTE) {
            const r = parseRemote(p.sensorType, p.decodeData, p.dataCountBit);
            line = `REMOTE ${r.name.padEnd(16)} key ${hex(p.decodeData)} (${p.dataCountBit} bits)`;
            if (r.serial !== 0n)
                line += `  serial ${hex(r.serial, 1)}`;
            if (r.btn !== null)
                line += `  btn ${r.btn}`;
            if (r.cnt !== null)
                line += `  cnt ${r.cnt}`;
            for (const e of r.extra)
                line += `  ${e}`;
        }
        else {
            const c = parseCar(p.sensorType, p.decodeData, p.decodeData2, p.dataCountBit);
            line = `CAR ${c.name.padEnd(12)} serial ${hex(c.serial, 1)}`;
            if (c.btn)
                line += `  btn ${c.btn}`;
            if (c.cnt !== null)
                line += `  cnt ${c.cnt}`;
            line += `  data ${hex(p.decodeData, 1)}`;
            if (p.decodeData2 !== 0n)
                line += ` ${hex(p.decodeData2, 1)}`;
            for (const e of c.extra)
                line += `  ${e}`;
        }
        this.emit({ type: 'packet', line });
    }
}
