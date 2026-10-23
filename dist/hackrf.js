export const HACKRF_FILTERS = [
    { vendorId: 0x1d50, productId: 0x6089 },
    { vendorId: 0x1d50, productId: 0x604b },
    { vendorId: 0x1d50, productId: 0xcc15 },
];
const PID_MAYHEM_SERIAL = 0x6018;
export function isHackRf(d) {
    return d.vendorId === 0x1d50 && HACKRF_FILTERS.some(f => f.productId === d.productId);
}
export function isMayhemSerial(d) {
    return d.vendorId === 0x1d50 && d.productId === PID_MAYHEM_SERIAL;
}
const REQ = {
    SET_TRANSCEIVER_MODE: 1, SAMPLE_RATE_SET: 6, BASEBAND_FILTER_BW_SET: 7, BOARD_ID_READ: 14, VERSION_STRING_READ: 15,
    SET_FREQ: 16, AMP_ENABLE: 17, SET_LNA_GAIN: 19, SET_VGA_GAIN: 20, SET_TXVGA_GAIN: 21, SET_HW_SYNC_MODE: 29, BOARD_REV_READ: 45,
};
const MODE_OFF = 0, MODE_RECEIVE = 1, MODE_TRANSMIT = 2;
const BB_FILTER_BW = [1750000, 2500000, 3500000, 5000000, 5500000, 6000000, 7000000, 8000000, 9000000, 10000000,
    12000000, 14000000, 15000000, 20000000, 24000000, 28000000];
export function boardName(id) {
    return ['Jellybean', 'Jawbreaker', 'HackRF One', 'rad1o', 'HackRF One r9', 'HackRF Pro'][id] ?? 'HackRF?';
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const HACKRF_LIMITS = {
    minHz: 1000000,
    maxHz: 6000000000,
    rates: [[1000000, 20000000]],
    canTransmit: true,
};
export class HackRf {
    get label() { return this.board || 'HackRF'; }
    setGain(lnaDb, vgaDb, amp) {
        this.lnaDb = lnaDb;
        this.vgaDb = vgaDb;
        this.amp = amp;
    }
    constructor(dev, ev) {
        this.dev = dev;
        this.ev = ev;
        this.kind = 'hackrf';
        this.limits = HACKRF_LIMITS;
        this.targetFreqHz = 92300000;
        this.targetRateHz = 2000000;
        this.lnaDb = 24;
        this.vgaDb = 24;
        this.amp = false;
        this.board = '';
        this.firmware = '';
        this.running = false;
        this.epIn = 1;
        this.epOut = 2;
        this.txJob = null;
        this.txCancel = false;
        this.txActive = false;
        this.stopFlag = false;
        this.appliedFreq = 0;
        this.appliedRate = 0;
        this.appliedLna = -1;
        this.appliedVga = -1;
        this.appliedAmp = -1;
        this.dbgBuffers = 0;
    }
    static async remembered() {
        const ds = await navigator.usb.getDevices();
        return ds.find(isHackRf);
    }
    static request() {
        return navigator.usb.requestDevice({ filters: HACKRF_FILTERS });
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
        const epo = alt?.endpoints.find(e => e.type === 'bulk' && e.direction === 'out');
        if (epo)
            this.epOut = epo.endpointNumber;
        this.ev.onLog(`HackRF: RX endpoint=0x${(0x80 | this.epIn).toString(16)} (expect 0x81)`);
    }
    async run() {
        if (this.running)
            return;
        this.running = true;
        this.stopFlag = false;
        this.dbgBuffers = 0;
        this.appliedFreq = 0;
        this.appliedRate = 0;
        this.appliedLna = -1;
        this.appliedVga = -1;
        this.appliedAmp = -1;
        try {
            this.ev.onLog('=== HackRF bring-up (WebUSB, libhackrf protocol) ===');
            this.ev.onStatus('HackRF · initializing…');
            const id = await this.boardId();
            this.board = boardName(id);
            this.firmware = await this.versionString();
            this.ev.onLog(`HackRF: board id = ${id} (${this.board})`);
            this.ev.onLog(`HackRF: fw='${this.firmware}' boardRev=${await this.boardRev()}`);
            while (!this.stopFlag) {
                await this.bringUpRx();
                await this.stream();
                const job = this.txJob;
                if (!job || this.stopFlag)
                    break;
                this.txJob = null;
                await this.doTransmit(job);
            }
        }
        catch (e) {
            this.ev.onLog(`HackRF error: ${e.message}`);
            this.ev.onStatus(`HackRF stopped: ${e.message}`);
        }
        finally {
            try {
                await this.setTransceiverMode(MODE_OFF);
            }
            catch { }
            try {
                await this.dev.releaseInterface(0);
            }
            catch { }
            try {
                await this.dev.close();
            }
            catch { }
            this.running = false;
            this.ev.onLog('HackRF: RX loop stopped');
        }
    }
    stop() { this.stopFlag = true; }
    transmit(job) {
        if (!this.running || this.txJob || this.txActive)
            return false;
        this.txCancel = false;
        this.txJob = job;
        return true;
    }
    abortTx() { this.txCancel = true; }
    async bringUpRx() {
        this.appliedFreq = 0;
        this.appliedRate = 0;
        this.appliedLna = -1;
        this.appliedVga = -1;
        this.appliedAmp = -1;
        await this.setTransceiverMode(MODE_OFF);
        await sleep(100);
        await this.setHwSync(false);
        await this.setSampleRate(this.targetRateHz);
        this.appliedRate = this.targetRateHz;
        await this.setBasebandFilter(bbFilterRoundDownLt(this.targetRateHz));
        await this.setFreq(this.targetFreqHz);
        this.appliedFreq = this.targetFreqHz;
        await this.applyGains();
        await this.setTransceiverMode(MODE_RECEIVE);
        await sleep(40);
        await this.setFreq(this.targetFreqHz + 1000000);
        await this.setFreq(this.targetFreqHz);
        await this.applyGains();
        await sleep(60);
        this.ev.onLog(`HackRF: streaming IQ @ ${(this.targetFreqHz / 1e6).toFixed(3)} MHz, ${(this.targetRateHz / 1e6).toFixed(2)} Msps`);
        this.ev.onStatus(`${this.board} · ${(this.targetFreqHz / 1e6).toFixed(3)} MHz`);
    }
    async doTransmit(job) {
        this.txActive = true;
        let err = null;
        try {
            this.ev.onLog(`HackRF TX: ${job.label} @ ${(job.freqHz / 1e6).toFixed(4)} MHz, ${(job.rateHz / 1e6).toFixed(2)} Msps, txvga=${job.txVgaDb} amp=${job.amp}`);
            this.ev.onStatus(`TX · ${job.label}`);
            await this.setTransceiverMode(MODE_OFF);
            await sleep(50);
            await this.setSampleRate(job.rateHz);
            await this.setBasebandFilter(bbFilterRoundDownLt(job.rateHz));
            await this.setFreq(job.freqHz + 1000000);
            await this.setFreq(job.freqHz);
            await this.ctrlOut(REQ.AMP_ENABLE, job.amp ? 1 : 0, 0, undefined, 'AMP');
            await this.ctrlIn(REQ.SET_TXVGA_GAIN, 0, Math.min(47, Math.max(0, job.txVgaDb)), 1, 'TXVGA');
            await sleep(40);
            await this.setTransceiverMode(MODE_TRANSMIT);
            const buf = new Int8Array(32768);
            const N = 4;
            const inflight = [];
            const fillOne = () => { const n = job.fill(buf); if (n <= 0)
                return null; return buf.slice(0, n); };
            for (let i = 0; i < N; i++) {
                const c = fillOne();
                if (c)
                    inflight.push(this.dev.transferOut(this.epOut, c));
            }
            while (inflight.length && !this.stopFlag && !this.txCancel) {
                const r = await inflight.shift();
                if (r.status !== 'ok') {
                    err = `bulk OUT ${r.status}`;
                    break;
                }
                const c = fillOne();
                if (c)
                    inflight.push(this.dev.transferOut(this.epOut, c));
            }
            await Promise.allSettled(inflight);
            const zero = new Int8Array(32768);
            for (let i = 0; i < 2; i++)
                await this.dev.transferOut(this.epOut, zero).catch(() => undefined);
        }
        catch (e) {
            err = e.message;
        }
        finally {
            await this.setTransceiverMode(MODE_OFF).catch(() => undefined);
            await this.ctrlOut(REQ.AMP_ENABLE, 0, 0, undefined, 'AMP').catch(() => undefined);
            await sleep(60);
            this.txActive = false;
            job.onDone(err);
        }
    }
    async stream() {
        const N = 8, SIZE = 65536;
        const inflight = [];
        for (let i = 0; i < N; i++)
            inflight.push(this.dev.transferIn(this.epIn, SIZE));
        let lastStatus = 0;
        while (!this.stopFlag && !this.txJob) {
            const res = await inflight.shift();
            if (!this.stopFlag && !this.txJob)
                inflight.push(this.dev.transferIn(this.epIn, SIZE));
            if (res.status !== 'ok' || !res.data) {
                this.ev.onLog(`HackRF: transfer ${res.status}`);
                if (res.status === 'stall')
                    await this.dev.clearHalt('in', this.epIn);
                continue;
            }
            const dv = res.data;
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
                this.ev.onLog(`HackRF raw: n=${buf.length} nonZero=${nz}/${buf.length} min=${mn} max=${mx}`);
                if (nz === 0) {
                    this.ev.onLog('HackRF: RX is all-zero samples — front-end delivering nothing. Check antenna, a data-capable OTG cable / powered hub, and that a PortaPack is in HackRF mode.');
                    this.ev.onStatus('HackRF: no signal — check antenna / cable / PortaPack mode');
                }
                else if (nz * 50 < buf.length) {
                    this.ev.onLog(`HackRF: RX level is under 1 LSB (${nz}/${buf.length} non-zero) — raise LNA / VGA (a HackRF Pro needs roughly 30 dB more VGA than a HackRF One).`);
                }
            }
            this.ev.onIq(buf);
            await this.applyPending();
            const now = performance.now();
            if (now - lastStatus > 1000) {
                lastStatus = now;
                this.ev.onStatus(`${this.board} · ${(this.appliedFreq / 1e6).toFixed(3)} MHz`);
            }
        }
        await Promise.allSettled(inflight);
    }
    async applyPending() {
        const rateChanged = this.targetRateHz !== this.appliedRate;
        const freqChanged = this.targetFreqHz !== this.appliedFreq;
        const ampV = this.amp ? 1 : 0;
        const gainChanged = this.lnaDb !== this.appliedLna || this.vgaDb !== this.appliedVga || ampV !== this.appliedAmp;
        if (!rateChanged && !freqChanged && !gainChanged)
            return;
        if (rateChanged) {
            await this.setSampleRate(this.targetRateHz);
            await this.setBasebandFilter(bbFilterRoundDownLt(this.targetRateHz));
            this.appliedRate = this.targetRateHz;
        }
        if (freqChanged || rateChanged) {
            await this.setFreq(this.targetFreqHz + 1000000);
            await this.setFreq(this.targetFreqHz);
            this.appliedFreq = this.targetFreqHz;
            await sleep(50);
            this.ev.onStatus(`${this.board} · ${(this.appliedFreq / 1e6).toFixed(3)} MHz`);
        }
        if (gainChanged)
            await this.applyGains();
    }
    async ctrlOut(request, value, index, data, tag = '') {
        const r = await this.dev.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index }, data);
        const rc = r.status === 'ok' ? (r.bytesWritten ?? 0) : -1;
        if (tag)
            this.ev.onLog(`HackRF tx ${tag.padEnd(9)} OUT req=${request} wV=0x${value.toString(16).padStart(4, '0')} wI=0x${index.toString(16).padStart(4, '0')} rc=${rc}`);
        return rc;
    }
    async ctrlIn(request, value, index, length, tag = '') {
        const r = await this.dev.controlTransferIn({ requestType: 'vendor', recipient: 'device', request, value, index }, length);
        const ok = r.status === 'ok' && !!r.data;
        if (tag)
            this.ev.onLog(`HackRF tx ${tag.padEnd(9)} IN  req=${request} wV=0x${value.toString(16).padStart(4, '0')} wI=0x${index.toString(16).padStart(4, '0')} rc=${ok ? r.data.byteLength : -1}`);
        return ok ? r.data : null;
    }
    async boardId() { const d = await this.ctrlIn(REQ.BOARD_ID_READ, 0, 0, 1); return d ? d.getUint8(0) : -1; }
    async boardRev() { try {
        const d = await this.ctrlIn(REQ.BOARD_REV_READ, 0, 0, 1);
        return d ? d.getUint8(0) : -1;
    }
    catch {
        return -1;
    } }
    async versionString() {
        try {
            const d = await this.ctrlIn(REQ.VERSION_STRING_READ, 0, 0, 255);
            return d ? new TextDecoder('ascii').decode(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)).trim() : '?';
        }
        catch {
            return '?';
        }
    }
    setTransceiverMode(m) { return this.ctrlOut(REQ.SET_TRANSCEIVER_MODE, m, 0, undefined, 'TRXMODE'); }
    setHwSync(on) { return this.ctrlOut(REQ.SET_HW_SYNC_MODE, on ? 1 : 0, 0, undefined, 'HWSYNC'); }
    setSampleRate(rate) {
        const d = new DataView(new ArrayBuffer(8));
        d.setUint32(0, rate, true);
        d.setUint32(4, 1, true);
        return this.ctrlOut(REQ.SAMPLE_RATE_SET, 0, 0, d.buffer, 'SAMPLERATE');
    }
    setBasebandFilter(bw) { return this.ctrlOut(REQ.BASEBAND_FILTER_BW_SET, bw & 0xffff, (bw >>> 16) & 0xffff, undefined, 'BBFILTER'); }
    setFreq(hz) {
        const mhz = Math.floor(hz / 1000000), rem = hz - mhz * 1000000;
        const d = new DataView(new ArrayBuffer(8));
        d.setUint32(0, mhz, true);
        d.setUint32(4, rem, true);
        return this.ctrlOut(REQ.SET_FREQ, 0, 0, d.buffer, 'SETFREQ');
    }
    async applyGains() {
        const lna = Math.min(40, Math.max(0, this.lnaDb)) & ~7;
        const vga = Math.min(62, Math.max(0, this.vgaDb)) & ~1;
        const a = await this.ctrlOut(REQ.AMP_ENABLE, this.amp ? 1 : 0, 0, undefined, 'AMP');
        const l = (await this.ctrlIn(REQ.SET_LNA_GAIN, 0, lna, 1, 'LNA')) ? 1 : -1;
        const v = (await this.ctrlIn(REQ.SET_VGA_GAIN, 0, vga, 1, 'VGA')) ? 1 : -1;
        this.appliedLna = this.lnaDb;
        this.appliedVga = this.vgaDb;
        this.appliedAmp = this.amp ? 1 : 0;
        return [a, l, v];
    }
}
function bbFilterRoundDownLt(rate) {
    let chosen = BB_FILTER_BW[0];
    for (const bw of BB_FILTER_BW) {
        if (bw < rate)
            chosen = bw;
        else
            break;
    }
    return chosen;
}
