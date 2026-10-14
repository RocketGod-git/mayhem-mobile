import { BitReader, BitSync, DiscFilter, HdlcFramer } from './core.js';
export class AisDecoder {
    constructor(emit) {
        this.emit = emit;
        this.wantsFm = true;
        this.fmRate = 0;
        this.sync = new BitSync(9600, 48000);
        this.filt = new DiscFilter(7200, 48000);
        this.framer = new HdlcFramer(160, f => this.onFrame(f));
        this.vessels = new Map();
    }
    reset() { this.fmRate = 0; this.framer.reset(); }
    clear() { this.vessels.clear(); this.emit({ type: 'table', rows: [] }); }
    onIq() { }
    onFm(samples, n, rate) {
        if (rate !== this.fmRate) {
            this.fmRate = rate;
            this.sync = new BitSync(9600, rate);
            this.filt = new DiscFilter(7200, rate);
            this.framer.reset();
        }
        for (let i = 0; i < n; i++) {
            const b = this.sync.push(this.filt.push(samples[i]));
            if (b >= 0)
                this.framer.pushRaw(b);
        }
    }
    onFrame(f) {
        if (f.length < 5 || !HdlcFramer.fcsOk(f))
            return;
        const r = new BitReader(f);
        const dataBits = (f.length - 2) * 8;
        const type = r.read(0, 6), mmsi = r.read(8, 30);
        const now = Date.now();
        let v = this.vessels.get(mmsi);
        if (!v) {
            v = { mmsi, cls: '', msgs: 0, firstMs: now, lastMs: now };
            this.vessels.set(mmsi, v);
        }
        v.lastMs = now;
        v.msgs++;
        const pos = (lonAt, latAt) => { const lon = r.readSigned(lonAt, 28) / 600000, lat = r.readSigned(latAt, 27) / 600000; if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) {
            v.lon = lon;
            v.lat = lat;
        } };
        const dims = (at) => { v.dimA = r.read(at, 9); v.dimB = r.read(at + 9, 9); v.dimC = r.read(at + 18, 6); v.dimD = r.read(at + 24, 6); };
        const hdg = (at) => { const h = r.read(at, 9); v.hdg = h === 511 ? undefined : h; };
        let line;
        switch (type) {
            case 1:
            case 2:
            case 3: {
                if (dataBits !== 168)
                    return;
                v.cls = 'A';
                v.navStatus = r.read(38, 4);
                const rot = r.readSigned(42, 8);
                v.rot = rot === -128 ? undefined : Math.sign(rot) * Math.pow(rot / 4.733, 2);
                const sog = r.read(50, 10);
                v.sog = sog === 1023 ? undefined : sog / 10;
                v.accuracy = r.read(60, 1) === 1;
                pos(61, 89);
                const cog = r.read(116, 12);
                v.cog = cog === 3600 ? undefined : cog / 10;
                hdg(128);
                line = `T${type} MMSI ${mmsi} ${this.pos(v)} ${v.sog?.toFixed(1) ?? '?'}kn COG ${v.cog?.toFixed(0) ?? '?'} HDG ${v.hdg ?? '?'}`;
                break;
            }
            case 4: {
                if (dataBits !== 168)
                    return;
                v.cls = 'base';
                pos(79, 107);
                line = `T4 base station MMSI ${mmsi} ${this.pos(v)}`;
                break;
            }
            case 5: {
                if (dataBits !== 424)
                    return;
                v.cls = 'A';
                const imo = r.read(40, 30);
                v.imo = imo || undefined;
                v.callsign = this.text(r, 70, 7);
                v.name = this.text(r, 112, 20);
                v.shipType = r.read(232, 8);
                dims(240);
                const month = r.read(274, 4), day = r.read(278, 5), hour = r.read(283, 5), minute = r.read(288, 6);
                if (month)
                    v.eta = { month, day, hour, minute };
                const dr = r.read(294, 8);
                v.draft = dr ? dr / 10 : undefined;
                v.dest = this.text(r, 302, 20);
                line = `T5 MMSI ${mmsi} name '${v.name}' callsign '${v.callsign}' → '${v.dest}'`;
                break;
            }
            case 9: {
                if (dataBits !== 168)
                    return;
                v.cls = 'SAR';
                const alt = r.read(38, 12);
                v.alt = alt === 4095 ? undefined : alt;
                const sog = r.read(50, 10);
                v.sog = sog === 1023 ? undefined : sog;
                pos(61, 89);
                const cog = r.read(116, 12);
                v.cog = cog === 3600 ? undefined : cog / 10;
                line = `T9 SAR aircraft MMSI ${mmsi} ${this.pos(v)} ${v.alt ?? '?'} m`;
                break;
            }
            case 18: {
                if (dataBits !== 168)
                    return;
                v.cls = 'B';
                const sog = r.read(46, 10);
                v.sog = sog === 1023 ? undefined : sog / 10;
                v.accuracy = r.read(56, 1) === 1;
                pos(57, 85);
                const cog = r.read(112, 12);
                v.cog = cog === 3600 ? undefined : cog / 10;
                hdg(124);
                line = `T18 class B MMSI ${mmsi} ${this.pos(v)} ${v.sog?.toFixed(1) ?? '?'}kn COG ${v.cog?.toFixed(0) ?? '?'}`;
                break;
            }
            case 19: {
                if (dataBits < 312)
                    return;
                v.cls = 'B';
                const sog = r.read(46, 10);
                v.sog = sog === 1023 ? undefined : sog / 10;
                pos(57, 85);
                const cog = r.read(112, 12);
                v.cog = cog === 3600 ? undefined : cog / 10;
                hdg(124);
                v.name = this.text(r, 143, 20);
                v.shipType = r.read(263, 8);
                dims(271);
                line = `T19 class B MMSI ${mmsi} '${v.name}' ${this.pos(v)}`;
                break;
            }
            case 21: {
                if (dataBits < 272)
                    return;
                v.cls = 'AtoN';
                v.atonType = r.read(38, 5);
                v.name = this.text(r, 43, 20);
                v.accuracy = r.read(163, 1) === 1;
                pos(164, 192);
                dims(219);
                v.virtualAton = r.read(269, 1) === 1;
                line = `T21 AtoN MMSI ${mmsi} '${v.name}' ${this.pos(v)}`;
                break;
            }
            case 24: {
                if (dataBits < 160)
                    return;
                v.cls = v.cls || 'B';
                if (r.read(38, 2) === 0) {
                    v.name = this.text(r, 40, 20);
                    line = `T24A MMSI ${mmsi} name '${v.name}'`;
                }
                else {
                    v.shipType = r.read(40, 8);
                    v.vendor = this.text(r, 48, 3);
                    v.callsign = this.text(r, 90, 7);
                    if (dataBits >= 168)
                        dims(132);
                    line = `T24B MMSI ${mmsi} callsign '${v.callsign}'`;
                }
                break;
            }
            default: line = `T${type} MMSI ${mmsi} (${dataBits} bits)`;
        }
        this.emit({ type: 'packet', line });
        for (const [k, x] of this.vessels)
            if (now - x.lastMs > 30 * 60000)
                this.vessels.delete(k);
        this.emit({ type: 'table', rows: [...this.vessels.values()].sort((a, b) => b.lastMs - a.lastMs).map(x => ({ ...x })) });
    }
    pos(v) {
        if (v.lat === undefined || v.lon === undefined)
            return 'no fix';
        return `${v.lat.toFixed(4)},${v.lon.toFixed(4)}`;
    }
    text(r, start, chars) {
        let s = '';
        for (let i = 0; i < chars; i++) {
            const c = r.read(start + i * 6, 6);
            const ch = String.fromCharCode(c < 32 ? c + 64 : c);
            if (ch === '@')
                break;
            s += ch;
        }
        return s.trim();
    }
}
