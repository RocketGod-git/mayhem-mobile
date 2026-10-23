export const RTLSDR_READY = true;
export const RTLSDR_FILTERS = [
    { vendorId: 0x0bda, productId: 0x2832 },
    { vendorId: 0x0bda, productId: 0x2838 },
    { vendorId: 0x0ccd, productId: 0x00a9 }, { vendorId: 0x0ccd, productId: 0x00b3 },
    { vendorId: 0x1554, productId: 0x5020 },
    { vendorId: 0x185b, productId: 0x0620 }, { vendorId: 0x185b, productId: 0x0650 },
    { vendorId: 0x1f4d, productId: 0xb803 }, { vendorId: 0x1f4d, productId: 0xc803 },
];
export function isRtlSdr(d) {
    return RTLSDR_FILTERS.some(f => f.vendorId === d.vendorId && f.productId === d.productId);
}
const DEMODB = 0, USBB = 1, SYSB = 2, IICB = 6;
const USB_SYSCTL = 0x2000, USB_EPA_CTL = 0x2148, USB_EPA_MAXPKT = 0x2158;
const DEMOD_CTL = 0x3000, DEMOD_CTL_1 = 0x300b;
const GPO = 0x3001, GPOE = 0x3003, GPD = 0x3004;
const RTL_XTAL = 28800000;
const R82XX_IF_HZ = 3570000;
const R820T_ADDR = 0x34;
const R828D_ADDR = 0x74;
const R828D_XTAL = 16000000;
const BLOG_MAKER = 'RTLSDRBlog', BLOG_V4L = 'Blog V4L';
const usbString = (s) => (s ?? '').replace(/\0/g, '').trim();
const R82XX_CHECK_VAL = 0x69;
export const GAIN_AUTO = -1;
const LNA_STEPS = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13];
const MIX_STEPS = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8];
export const RTL_MAX_GAIN_DB = 48.8;
const FIR_DEFAULT = [-54, -36, -41, -40, -32, -14, 14, 53, 101, 156, 215, 273, 327, 372, 404, 421];
const REV4 = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf];
const bitrev = (b) => (REV4[b & 0xf] << 4) | REV4[(b >> 4) & 0xf];
const FREQ_RANGES = [
    { freq: 0, openD: 0x08, rfMux: 0x02, tfC: 0xdf, cap0p: 0x00 },
    { freq: 50, openD: 0x08, rfMux: 0x02, tfC: 0xbe, cap0p: 0x00 },
    { freq: 55, openD: 0x08, rfMux: 0x02, tfC: 0x8b, cap0p: 0x00 },
    { freq: 60, openD: 0x08, rfMux: 0x02, tfC: 0x7b, cap0p: 0x00 },
    { freq: 65, openD: 0x08, rfMux: 0x02, tfC: 0x69, cap0p: 0x00 },
    { freq: 70, openD: 0x08, rfMux: 0x02, tfC: 0x58, cap0p: 0x00 },
    { freq: 75, openD: 0x00, rfMux: 0x02, tfC: 0x44, cap0p: 0x00 },
    { freq: 80, openD: 0x00, rfMux: 0x02, tfC: 0x44, cap0p: 0x00 },
    { freq: 90, openD: 0x00, rfMux: 0x02, tfC: 0x34, cap0p: 0x00 },
    { freq: 100, openD: 0x00, rfMux: 0x02, tfC: 0x34, cap0p: 0x00 },
    { freq: 110, openD: 0x00, rfMux: 0x02, tfC: 0x24, cap0p: 0x00 },
    { freq: 120, openD: 0x00, rfMux: 0x02, tfC: 0x24, cap0p: 0x00 },
    { freq: 140, openD: 0x00, rfMux: 0x02, tfC: 0x14, cap0p: 0x00 },
    { freq: 180, openD: 0x00, rfMux: 0x02, tfC: 0x13, cap0p: 0x00 },
    { freq: 220, openD: 0x00, rfMux: 0x02, tfC: 0x13, cap0p: 0x00 },
    { freq: 250, openD: 0x00, rfMux: 0x02, tfC: 0x11, cap0p: 0x00 },
    { freq: 280, openD: 0x00, rfMux: 0x02, tfC: 0x00, cap0p: 0x00 },
    { freq: 310, openD: 0x00, rfMux: 0x41, tfC: 0x00, cap0p: 0x00 },
    { freq: 450, openD: 0x00, rfMux: 0x41, tfC: 0x00, cap0p: 0x00 },
    { freq: 588, openD: 0x00, rfMux: 0x40, tfC: 0x00, cap0p: 0x00 },
    { freq: 650, openD: 0x00, rfMux: 0x40, tfC: 0x00, cap0p: 0x00 },
];
const R82XX_INIT = [
    0x80, 0x13, 0x70, 0xc0, 0x40, 0xdb, 0x6b, 0xeb, 0x53, 0x75, 0x68, 0x6c, 0xbb, 0x80,
    0x31, 0x0f, 0x00, 0xc0, 0x30, 0x48, 0xec, 0x60, 0x00, 0x24, 0xdd, 0x0e, 0x40,
];
export function firBytes() {
    const fir = new Array(20).fill(0);
    for (let i = 0; i < 8; i++)
        fir[i] = FIR_DEFAULT[i] & 0xff;
    for (let i = 0; i < 8; i += 2) {
        const v0 = FIR_DEFAULT[8 + i], v1 = FIR_DEFAULT[8 + i + 1];
        const at = 8 + ((i * 3) >> 1);
        fir[at] = (v0 >> 4) & 0xff;
        fir[at + 1] = ((v0 << 4) | ((v1 >> 8) & 0x0f)) & 0xff;
        fir[at + 2] = v1 & 0xff;
    }
    return fir;
}
export function pllPlan(freqHz, pllRef, fine, vcoPowerRef = 2) {
    const VCO_MIN_KHZ = 1770000, VCO_MAX_KHZ = VCO_MIN_KHZ * 2;
    const freqKhz = Math.trunc((freqHz + 500) / 1000);
    let mixDiv = 2, divNum = 0;
    while (mixDiv <= 64) {
        if (freqKhz * mixDiv >= VCO_MIN_KHZ && freqKhz * mixDiv < VCO_MAX_KHZ) {
            let db = mixDiv;
            while (db > 2) {
                db >>= 1;
                divNum++;
            }
            break;
        }
        mixDiv <<= 1;
    }
    if (fine > vcoPowerRef)
        divNum -= 1;
    else if (fine < vcoPowerRef)
        divNum += 1;
    const vcoFreq = freqHz * mixDiv;
    const vcoDiv = Math.trunc((pllRef + 65536 * vcoFreq) / (2 * pllRef));
    const nint = Math.trunc(vcoDiv / 65536);
    const sdm = vcoDiv % 65536;
    return { mixDiv, divNum, nint, sdm, ok: nint <= (128 / vcoPowerRef) - 1 };
}
export function pllFreq(p, pllRef) {
    return (2 * pllRef * (p.nint + p.sdm / 65536)) / p.mixDiv;
}
export function gainSteps(tenthDb) {
    let total = 0, lna = 0, mix = 0;
    for (let i = 0; i < 15; i++) {
        if (total >= tenthDb)
            break;
        total += LNA_STEPS[++lna];
        if (total >= tenthDb)
            break;
        total += MIX_STEPS[++mix];
    }
    return { lna, mix, total };
}
export const RTL_LIMITS = {
    minHz: 24000000,
    maxHz: 1766000000,
    rates: [[225001, 300000], [900001, 2400000]],
    canTransmit: false,
};
export class RtlSdr {
    constructor(dev, ev) {
        this.dev = dev;
        this.ev = ev;
        this.kind = 'rtlsdr';
        this.targetFreqHz = 433920000;
        this.targetRateHz = 2000000;
        this.targetGainTenthDb = 496;
        this.running = false;
        this.limits = RTL_LIMITS;
        this.tuner = '';
        this.label = 'RTL-SDR';
        this.epIn = 1;
        this.stopFlag = false;
        this.tunerRegs = new Uint8Array(32);
        this.tunerAddr = R820T_ADDR;
        this.tunerXtal = RTL_XTAL;
        this.vcoPowerRef = 2;
        this.appliedFreq = 0;
        this.appliedRate = 0;
        this.appliedGain = Number.MAX_SAFE_INTEGER;
        this.dbgBuffers = 0;
        this.lastError = null;
        this.retuneError = null;
        this.quietRetune = false;
        this.retuneAfter = 0;
    }
    static async remembered() {
        return (await navigator.usb.getDevices()).find(isRtlSdr);
    }
    static request() {
        return navigator.usb.requestDevice({ filters: RTLSDR_FILTERS });
    }
    async open() {
        await this.dev.open();
        if (this.dev.configuration === null)
            await this.dev.selectConfiguration(1);
        await this.dev.claimInterface(0);
        const alt = this.dev.configuration?.interfaces[0]?.alternate;
        const ep = alt?.endpoints.find(e => e.type === 'bulk' && e.direction === 'in');
        if (!ep)
            throw new Error('no bulk-IN endpoint');
        this.epIn = ep.endpointNumber;
        this.ev.onLog(`RTL-SDR: RX endpoint=0x${(0x80 | this.epIn).toString(16)}`);
    }
    async run() {
        if (this.running)
            return;
        this.running = true;
        this.stopFlag = false;
        this.dbgBuffers = 0;
        this.appliedFreq = 0;
        this.appliedRate = 0;
        this.appliedGain = Number.MAX_SAFE_INTEGER;
        try {
            this.ev.onLog('=== RTL-SDR bring-up (RTL2832U + R82xx, WebUSB) ===');
            this.ev.onStatus('RTL-SDR · initializing…');
            try {
                await this.dev.clearHalt('in', this.epIn);
            }
            catch { }
            await this.initBaseband();
            await this.initTuner();
            await this.setSampleRate(this.targetRateHz);
            this.appliedRate = this.targetRateHz;
            await this.setCenterFreq(this.targetFreqHz);
            this.appliedFreq = this.targetFreqHz;
            await this.applyGain(this.targetGainTenthDb);
            this.appliedGain = this.targetGainTenthDb;
            await this.resetBuffer();
            this.ev.onLog(`RTL-SDR: streaming ${(this.targetFreqHz / 1e6).toFixed(3)} MHz @ ${(this.targetRateHz / 1e6).toFixed(3)} Msps`);
            await this.stream();
        }
        catch (e) {
            this.ev.onLog(`RTL-SDR error: ${e.message}`);
            this.ev.onStatus(`RTL-SDR stopped: ${e.message}`);
        }
        finally {
            try {
                await this.dev.releaseInterface(0);
            }
            catch { }
            try {
                await this.dev.close();
            }
            catch { }
            this.running = false;
            this.ev.onLog('RTL-SDR: RX loop stopped');
        }
    }
    stop() { this.stopFlag = true; }
    setGain(_lnaDb, vgaDb, _amp) {
        this.targetGainTenthDb = Math.max(0, Math.min(Math.round(RTL_MAX_GAIN_DB * 10), Math.round(vgaDb * 10)));
    }
    async stream() {
        const N = 8, SIZE = 65536;
        const read = () => this.dev.transferIn(this.epIn, SIZE).catch((e) => {
            this.lastError = e.message;
            return { status: 'babble', data: undefined };
        });
        const inflight = [];
        for (let i = 0; i < N; i++)
            inflight.push(read());
        let lastStatus = 0, bad = 0;
        while (!this.stopFlag) {
            const res = await inflight.shift();
            if (!this.stopFlag)
                inflight.push(read());
            if (res.status !== 'ok' || !res.data) {
                if (++bad > N * 2) {
                    this.ev.onLog(`RTL-SDR: giving up — ${this.lastError ?? res.status}`);
                    break;
                }
                if (bad === 1)
                    this.ev.onLog(`RTL-SDR: transfer ${res.status}${this.lastError ? ` — ${this.lastError}` : ''}`);
                if (res.status === 'stall') {
                    try {
                        await this.dev.clearHalt('in', this.epIn);
                    }
                    catch { }
                }
                continue;
            }
            bad = 0;
            const dv = res.data;
            const raw = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
            for (let k = 0; k < raw.length; k++)
                raw[k] ^= 0x80;
            const buf = new Int8Array(dv.buffer, dv.byteOffset, dv.byteLength);
            if (this.dbgBuffers < 3) {
                this.dbgBuffers++;
                let nz = 0, mn = 127, mx = -128;
                for (let k = 0; k < buf.length; k++) {
                    const v = buf[k];
                    if (v !== 0)
                        nz++;
                    if (v < mn)
                        mn = v;
                    if (v > mx)
                        mx = v;
                }
                this.ev.onLog(`RTL-SDR raw: n=${buf.length} nonZero=${nz}/${buf.length} min=${mn} max=${mx}`);
                if (nz === 0) {
                    this.ev.onLog('RTL-SDR: all-zero samples — the tuner is not delivering. Check the aerial and try a different USB port.');
                    this.ev.onStatus('RTL-SDR: no signal — check aerial / cable');
                }
            }
            this.ev.onIq(buf);
            if (this.targetRateHz !== this.appliedRate) {
                const rest = inflight.splice(0);
                await Promise.allSettled(rest);
                try {
                    await this.setSampleRate(this.targetRateHz);
                    await this.resetBuffer();
                    this.appliedRate = this.targetRateHz;
                }
                catch (e) {
                    this.ev.onLog(`RTL-SDR: rate change failed — ${e.message}`);
                }
                try {
                    await this.dev.clearHalt('in', this.epIn);
                }
                catch { }
                if (!this.stopFlag)
                    for (let i = 0; i < N; i++)
                        inflight.push(read());
                bad = 0;
            }
            if (this.pending() && performance.now() >= this.retuneAfter) {
                let ok = !this.quietRetune && await this.applyPending();
                if (!ok) {
                    const rest = inflight.splice(0);
                    await Promise.allSettled(rest);
                    ok = await this.applyPending();
                    try {
                        await this.dev.clearHalt('in', this.epIn);
                    }
                    catch { }
                    if (!this.stopFlag)
                        for (let i = 0; i < N; i++)
                            inflight.push(read());
                    bad = 0;
                    if (!ok)
                        this.retuneAfter = performance.now() + 1000;
                    if (ok && !this.quietRetune) {
                        this.quietRetune = true;
                        this.ev.onLog('RTL-SDR: this USB stack rejects retunes during streaming — retuning between drained reads from now on');
                    }
                }
            }
            const now = performance.now();
            if (now - lastStatus > 1000) {
                lastStatus = now;
                this.ev.onStatus(`${this.label} · ${(this.appliedFreq / 1e6).toFixed(3)} MHz`);
            }
        }
        await Promise.allSettled(inflight);
    }
    pending() {
        return this.targetFreqHz !== this.appliedFreq || this.targetGainTenthDb !== this.appliedGain;
    }
    async applyPending() {
        try {
            if (this.targetFreqHz !== this.appliedFreq) {
                await this.setCenterFreq(this.targetFreqHz);
                this.appliedFreq = this.targetFreqHz;
            }
            if (this.targetGainTenthDb !== this.appliedGain) {
                await this.applyGain(this.targetGainTenthDb);
                this.appliedGain = this.targetGainTenthDb;
            }
            this.retuneError = null;
            return true;
        }
        catch (e) {
            const msg = e.message;
            if (msg !== this.retuneError)
                this.ev.onLog(`RTL-SDR: retune failed, retrying — ${msg}`);
            this.retuneError = msg;
            return false;
        }
    }
    async writeReg(block, addr, val, len) {
        const data = len === 1 ? new Uint8Array([val & 0xff]) : new Uint8Array([(val >> 8) & 0xff, val & 0xff]);
        await this.dev.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0, value: addr, index: (block << 8) | 0x10 }, data);
    }
    async readReg(block, addr) {
        const r = await this.dev.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0, value: addr, index: block << 8 }, 1);
        return r.status === 'ok' && r.data && r.data.byteLength ? r.data.getUint8(0) : 0;
    }
    async setGpio(pin, on) {
        const bit = 1 << pin;
        await this.writeReg(SYSB, GPD, (await this.readReg(SYSB, GPD)) & ~bit, 1);
        await this.writeReg(SYSB, GPOE, (await this.readReg(SYSB, GPOE)) | bit, 1);
        const v = await this.readReg(SYSB, GPO);
        await this.writeReg(SYSB, GPO, on ? v | bit : v & ~bit, 1);
    }
    async demodWrite(page, addr, val, len) {
        const data = len === 1 ? new Uint8Array([val & 0xff]) : new Uint8Array([(val >> 8) & 0xff, val & 0xff]);
        await this.dev.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0, value: (addr << 8) | 0x20, index: 0x10 | page }, data);
        await this.demodRead(0x0a, 0x01, 1);
    }
    async demodRead(page, addr, len) {
        const r = await this.dev.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0, value: (addr << 8) | 0x20, index: page }, len);
        if (r.status !== 'ok' || !r.data || r.data.byteLength !== len)
            return 0;
        return len === 1 ? r.data.getUint8(0) : (r.data.getUint8(1) << 8) | r.data.getUint8(0);
    }
    async setFir() {
        const fir = firBytes();
        for (let j = 0; j < 20; j++)
            await this.demodWrite(1, 0x1c + j, fir[j], 1);
    }
    async initBaseband() {
        await this.writeReg(USBB, USB_SYSCTL, 0x09, 1);
        await this.writeReg(USBB, USB_EPA_MAXPKT, 0x0002, 2);
        await this.writeReg(USBB, USB_EPA_CTL, 0x1002, 2);
        await this.writeReg(SYSB, DEMOD_CTL_1, 0x22, 1);
        await this.writeReg(SYSB, DEMOD_CTL, 0xe8, 1);
        await this.demodWrite(1, 0x01, 0x14, 1);
        await this.demodWrite(1, 0x01, 0x10, 1);
        await this.demodWrite(1, 0x15, 0x00, 1);
        await this.demodWrite(1, 0x16, 0x0000, 2);
        for (let i = 0; i < 6; i++)
            await this.demodWrite(1, 0x16 + i, 0x00, 1);
        await this.setFir();
        await this.demodWrite(0, 0x19, 0x05, 1);
        await this.demodWrite(1, 0x93, 0xf0, 1);
        await this.demodWrite(1, 0x94, 0x0f, 1);
        await this.demodWrite(1, 0x11, 0x00, 1);
        await this.demodWrite(1, 0x04, 0x00, 1);
        await this.demodWrite(DEMODB, 0x61, 0x60, 1);
        await this.demodWrite(DEMODB, 0x06, 0x80, 1);
        await this.demodWrite(1, 0xb1, 0x1b, 1);
        await this.demodWrite(DEMODB, 0x0d, 0x83, 1);
    }
    async setIfFreq(freqHz) {
        const ifFreq = -Math.trunc((freqHz * 0x400000) / RTL_XTAL);
        await this.demodWrite(1, 0x19, (ifFreq >> 16) & 0x3f, 1);
        await this.demodWrite(1, 0x1a, (ifFreq >> 8) & 0xff, 1);
        await this.demodWrite(1, 0x1b, ifFreq & 0xff, 1);
    }
    async setSampleRate(rate) {
        const rsamp = Math.trunc((RTL_XTAL * 0x400000) / rate) & 0x0ffffffc;
        await this.demodWrite(1, 0x9f, (rsamp >> 16) & 0xffff, 2);
        await this.demodWrite(1, 0xa1, rsamp & 0xffff, 2);
        await this.demodWrite(1, 0x3e, 0, 1);
        await this.demodWrite(1, 0x3f, 0, 1);
        await this.demodWrite(1, 0x01, 0x14, 1);
        await this.demodWrite(1, 0x01, 0x10, 1);
    }
    setI2cRepeater(on) {
        return this.demodWrite(1, 0x01, on ? 0x18 : 0x10, 1);
    }
    async resetBuffer() {
        await this.writeReg(USBB, USB_EPA_CTL, 0x1002, 2);
        await this.writeReg(USBB, USB_EPA_CTL, 0x0000, 2);
    }
    async setCenterFreq(freqHz) {
        await this.setI2cRepeater(true);
        await this.r82xxSetFreq(freqHz);
        await this.setI2cRepeater(false);
    }
    async i2cWrite(bytes) {
        await this.dev.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0, value: this.tunerAddr, index: (IICB << 8) | 0x10 }, bytes);
    }
    async r82xxRead(len) {
        const out = new Array(len).fill(0);
        const raw = await this.i2cReadRaw(len);
        for (let i = 0; i < len && i < raw.length; i++)
            out[i] = bitrev(raw[i]);
        return out;
    }
    async i2cReadRaw(len) {
        try {
            const r = await this.dev.controlTransferIn({ requestType: 'vendor', recipient: 'device', request: 0, value: this.tunerAddr, index: IICB << 8 }, len);
            if (r.status !== 'ok' || !r.data)
                return [];
            const out = [];
            for (let i = 0; i < len && i < r.data.byteLength; i++)
                out.push(r.data.getUint8(i));
            return out;
        }
        catch {
            return [];
        }
    }
    async tunerWrite(startReg, vals) {
        for (let pos = 0; pos < vals.length;) {
            const size = Math.min(7, vals.length - pos);
            const b = new Uint8Array(size + 1);
            b[0] = (startReg + pos) & 0xff;
            for (let i = 0; i < size; i++) {
                b[i + 1] = vals[pos + i] & 0xff;
                const reg = startReg + pos + i;
                if (reg >= 5 && reg < 32)
                    this.tunerRegs[reg] = vals[pos + i] & 0xff;
            }
            await this.i2cWrite(b);
            pos += size;
        }
    }
    tunerWriteReg(reg, v) { return this.tunerWrite(reg, [v & 0xff]); }
    tunerWriteMask(reg, v, mask) {
        return this.tunerWriteReg(reg, (this.tunerRegs[reg] & ~mask) | (v & mask));
    }
    async initTuner() {
        await this.demodWrite(1, 0xb1, 0x1a, 1);
        await this.demodWrite(DEMODB, 0x08, 0x4d, 1);
        await this.setIfFreq(R82XX_IF_HZ);
        await this.demodWrite(1, 0x15, 0x01, 1);
        await this.setI2cRepeater(true);
        let found = false;
        for (const [addr, xtal, ref, name] of [
            [R820T_ADDR, RTL_XTAL, 2, 'R820T/R820T2'],
            [R828D_ADDR, R828D_XTAL, 1, 'R828D'],
        ]) {
            this.tunerAddr = addr;
            const probe = await this.i2cReadRaw(1);
            if (probe.length && probe[0] === R82XX_CHECK_VAL) {
                this.tunerXtal = xtal;
                this.vcoPowerRef = ref;
                this.tuner = name;
                found = true;
                this.ev.onLog(`RTL-SDR: tuner ${name} at I2C 0x${addr.toString(16)}`);
                break;
            }
        }
        if (!found) {
            this.tunerAddr = R820T_ADDR;
            this.tunerXtal = RTL_XTAL;
            this.vcoPowerRef = 2;
            this.tuner = 'unknown';
            this.ev.onLog('RTL-SDR: no R82xx answered. An E4000 or FC0012 dongle is not supported yet — expect static.');
        }
        if (found && this.tunerAddr === R820T_ADDR
            && usbString(this.dev.manufacturerName) === BLOG_MAKER && usbString(this.dev.productName) === BLOG_V4L) {
            this.tuner = 'R828S';
            this.vcoPowerRef = 1;
            this.ev.onLog('RTL-SDR: RTL-SDR Blog V4L (R828S)');
        }
        this.label = this.tuner === 'R828S' ? 'RTL-SDR Blog V4L' : `RTL-SDR · ${this.tuner}`;
        for (let i = 0; i < R82XX_INIT.length; i++)
            this.tunerRegs[5 + i] = R82XX_INIT[i];
        await this.tunerWrite(0x05, R82XX_INIT);
        if (found && this.tuner === 'R828D')
            await this.pickR828dReference();
        await this.setTvStandard();
        await this.sysFreqSel();
        await this.setI2cRepeater(false);
        if (this.tuner === 'R828S')
            await this.setGpio(5, true);
    }
    async pickR828dReference() {
        for (const cand of [R828D_XTAL, RTL_XTAL]) {
            this.tunerXtal = cand;
            if (await this.r82xxSetPll(100000000, true)) {
                this.ev.onLog(`RTL-SDR: R828D locks against ${(cand / 1e6).toFixed(1)} MHz`);
                return;
            }
        }
        this.tunerXtal = R828D_XTAL;
        this.ev.onLog('RTL-SDR: R828D would not lock against either reference — expect a weak, mistuned front end.');
    }
    async setTvStandard() {
        const filtQ = 0x10;
        let filCal = 0;
        for (let i = 0; i < 2; i++) {
            await this.tunerWriteMask(0x0f, 0x04, 0x04);
            await this.r82xxSetPll(56000000);
            await this.tunerWriteMask(0x0b, 0x10, 0x10);
            await this.tunerWriteMask(0x0b, 0x00, 0x10);
            await this.tunerWriteMask(0x0f, 0x00, 0x04);
            filCal = (await this.r82xxRead(5))[4] & 0x0f;
            if (filCal !== 0 && filCal !== 0x0f)
                break;
        }
        if (filCal === 0x0f)
            filCal = 0;
        await this.tunerWriteMask(0x0a, filtQ | filCal, 0x1f);
    }
    async sysFreqSel() {
        await this.tunerWriteMask(0x05, 0x00, 0x60);
        await this.tunerWriteMask(0x06, 0x00, 0x08);
        await this.tunerWriteMask(0x1d, 0x00, 0x38);
        await this.tunerWriteMask(0x06, 0x00, 0x40);
        await this.tunerWriteMask(0x1a, 0x30, 0x30);
        await this.tunerWriteMask(0x1d, 0x18, 0x38);
        await this.tunerWriteMask(0x1a, 0x20, 0x30);
    }
    async setMux(loFreqHz) {
        const mhz = Math.trunc(loFreqHz / 1000000);
        let r = FREQ_RANGES[0];
        for (const fr of FREQ_RANGES) {
            if (mhz >= fr.freq)
                r = fr;
            else
                break;
        }
        await this.tunerWriteMask(0x17, r.openD, 0x08);
        await this.tunerWriteMask(0x1a, r.rfMux, 0xc3);
        await this.tunerWriteReg(0x1b, r.tfC);
        await this.tunerWriteMask(0x10, r.cap0p, 0x0b);
        await this.tunerWriteMask(0x08, 0x00, 0x3f);
        await this.tunerWriteMask(0x09, 0x00, 0x3f);
    }
    async r82xxSetPll(freqHz, quiet = false) {
        const pllRef = this.tunerXtal;
        const VCO_CURR_MIN = 0x80, VCO_CURR_MAX = 0x60;
        await this.tunerWriteMask(0x10, 0x00, 0x10);
        await this.tunerWriteMask(0x1a, 0x00, 0x0c);
        await this.tunerWriteMask(0x12, VCO_CURR_MIN, 0xe0);
        const fine = ((await this.r82xxRead(5))[4] & 0x30) >> 4;
        const plan = pllPlan(freqHz, pllRef, fine, this.vcoPowerRef);
        await this.tunerWriteMask(0x10, plan.divNum << 5, 0xe0);
        if (!plan.ok) {
            this.ev.onLog(`RTL-SDR: PLL integer out of range at ${(freqHz / 1e6).toFixed(3)} MHz`);
            return false;
        }
        const { nint, sdm } = plan;
        const ni = Math.trunc((nint - 13) / 4);
        const si = nint - 4 * ni - 13;
        await this.tunerWriteReg(0x14, ni + (si << 6));
        await this.tunerWriteMask(0x12, sdm === 0 ? 0x08 : 0x00, 0x18);
        await this.tunerWriteReg(0x16, sdm >> 8);
        await this.tunerWriteReg(0x15, sdm & 0xff);
        let locked = false, saw = [];
        for (let i = 0; i < 2; i++) {
            saw = await this.r82xxRead(3);
            if ((saw[2] & 0x40) !== 0) {
                locked = true;
                break;
            }
            if (i === 0)
                await this.tunerWriteMask(0x12, VCO_CURR_MAX, 0xe0);
        }
        if (!locked) {
            if (!quiet) {
                this.ev.onLog(`RTL-SDR: PLL lock bit clear — status ${saw.length ? saw.map(v => v.toString(16).padStart(2, '0')).join(' ') : '(no answer)'}, nint ${nint} sdm ${sdm} mixDiv ${plan.mixDiv}`);
            }
            return false;
        }
        await this.tunerWriteMask(0x1a, 0x08, 0x08);
        return true;
    }
    async r82xxSetFreq(rfHz) {
        const lo = rfHz + R82XX_IF_HZ;
        await this.setMux(lo);
        if (this.tuner === 'R828D')
            await this.tunerWriteMask(0x05, rfHz > 345000000 ? 0x00 : 0x60, 0x60);
        if (this.tuner === 'R828S')
            await this.tunerWriteMask(0x05, 0x00, 0x60);
        if (!(await this.r82xxSetPll(lo))) {
            this.ev.onLog(`RTL-SDR: PLL did not lock at ${(rfHz / 1e6).toFixed(3)} MHz`);
        }
    }
    async applyGain(tenthDb) {
        await this.setI2cRepeater(true);
        if (tenthDb === GAIN_AUTO) {
            await this.tunerWriteMask(0x05, 0x00, 0x10);
            await this.tunerWriteMask(0x07, 0x10, 0x10);
            await this.tunerWriteMask(0x0c, 0x0b, 0x9f);
        }
        else {
            const { lna, mix } = gainSteps(tenthDb);
            await this.tunerWriteMask(0x05, 0x10, 0x10);
            await this.tunerWriteMask(0x07, 0x00, 0x10);
            await this.tunerWriteMask(0x05, lna, 0x0f);
            await this.tunerWriteMask(0x07, mix, 0x0f);
            await this.tunerWriteMask(0x0c, 0x08, 0x9f);
        }
        await this.setI2cRepeater(false);
    }
}
