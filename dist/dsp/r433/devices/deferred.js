import { bitAt } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { crc16 } from '../util.js';
const BAND_345 = [345000000];
const BAND_433 = [433920000];
const BAND_915 = [915000000];
const hexOf = (b, from, n) => {
    let s = '';
    for (let i = 0; i < n; i++)
        s += b[from + i].toString(16).padStart(2, '0');
    return s;
};
const DTV_BUTTON = {
    0x01: '1', 0x02: '2', 0x03: '3', 0x04: '4', 0x05: '5', 0x06: '6', 0x07: '7', 0x08: '8', 0x09: '9',
    0x0d: 'CH UP', 0x0e: 'CH DOWN', 0x0f: 'CH PREV', 0x10: 'PWR', 0x11: '0', 0x12: 'DASH', 0x13: 'ENTER',
    0x14: 'DASH REPEAT', 0x15: 'ENTER REPEAT', 0x20: 'MENU', 0x21: 'UP', 0x22: 'DOWN', 0x23: 'LEFT',
    0x24: 'RIGHT', 0x25: 'SELECT', 0x26: 'EXIT', 0x27: 'BACK', 0x28: 'GUIDE', 0x29: 'ACTIVE', 0x2a: 'LIST',
    0x2b: 'LIST REPEAT', 0x2c: 'INFO REPEAT', 0x2d: 'GUIDE REPEAT', 0x2e: 'INFO',
    0x30: 'VCR PLAY', 0x31: 'VCR STOP', 0x32: 'VCR PAUSE', 0x33: 'VCR RWD', 0x34: 'VCR FFD', 0x35: 'VCR REC',
    0x36: 'VCR BACK', 0x37: 'VCR SKIP', 0x38: 'VCR SKIP REPEAT', 0x3a: 'VCR PLAY REPEAT',
    0x3b: 'VCR PAUSE REPEAT', 0x3c: 'VCR RWD REPEAT', 0x3d: 'VCR FFD REPEAT', 0x3e: 'VCR REC REPEAT',
    0x3f: 'VCR BACK REPEAT',
    0x41: 'RED', 0x42: 'YELLOW', 0x43: 'GREEN', 0x44: 'BLUE', 0x45: 'MENU REPEAT', 0x46: 'ACTIVE REPEAT',
    0x4a: 'RED REPEAT', 0x4b: 'YELLOW REPEAT', 0x4c: 'GREEN REPEAT', 0x4d: 'BLUE REPEAT',
    0x51: 'TV: VCR ALERT', 0x59: 'VOLUME ALERT', 0x5a: 'AV1/AV2/TV: IR ALERT 1', 0x5b: 'DTV: IR ALERT',
    0x5c: 'AV1/AV2/TV: IR ALERT 2', 0x5d: 'TV: DTV ALERT', 0x5e: 'AV1: DTV ALERT', 0x5f: 'AV2: DTV ALERT',
    0x60: '0 REPEAT', 0x61: '1 REPEAT', 0x62: '2 REPEAT', 0x63: '3 REPEAT', 0x64: '4 REPEAT', 0x65: '5 REPEAT',
    0x66: '6 REPEAT', 0x67: '7 REPEAT', 0x68: '8 REPEAT', 0x69: '9 REPEAT',
    0x73: 'FORMAT', 0x75: 'FORMAT REPEAT',
    0x80: 'DTV: DTV&TV POWER ON', 0x81: 'DTV: DTV&TV POWER OFF', 0xd6: 'SELECT RELEASE',
};
function dpwmDecode(row, bitLen, start) {
    const out = [];
    let bufPos = -1;
    let cur = 0xffffffff;
    let syncPos = start, syncLen = 0;
    let syncing = 1;
    let prev = 0xff;
    for (let p = start; p < bitLen; p++) {
        const b = bitAt(row, p);
        if (b === prev) {
            cur = (cur + 1) >>> 0;
            if (cur > 1)
                syncing = 1;
        }
        else {
            if (syncing) {
                syncLen = (cur + 1) >>> 0;
                syncPos = (p - cur - 1) >>> 0;
                bufPos = -1;
                syncing = 0;
            }
            else {
                if (bufPos >= 0)
                    out[bufPos] = cur;
                bufPos++;
            }
            cur = 0;
        }
        prev = b;
    }
    if (syncing)
        bufPos -= 1;
    if (bufPos < 0)
        bufPos = 0;
    return { bits: out.slice(0, bufPos), syncPos, syncLen };
}
export const directv = register({
    num: 128,
    name: 'DirecTV RC66RX Remote Control',
    what: 'satellite television remote',
    modulation: 16,
    shortWidth: 600,
    longWidth: 600,
    gapLimit: 30000,
    resetLimit: 50000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const bitLen = bits.bitsPerRow[0];
        if (bitLen < 44 || bitLen > 99)
            return DECODE_FAIL_SANITY;
        const { bits: logical, syncLen } = dpwmDecode(bits.bb[0], bitLen, 0);
        if (logical.length !== 40)
            return DECODE_ABORT_LENGTH;
        const b = new Uint8Array(5);
        logical.forEach((v, i) => { if (v)
            b[i >> 3] |= 0x80 >> (i & 7); });
        if (b[0] !== 0x10)
            return DECODE_FAIL_SANITY;
        let sum = 0;
        for (let i = 0; i < 4; i++)
            sum += (b[i] >> 4) + (b[i] & 0x0f);
        sum = (sum + (b[4] >> 4)) & 0x0f;
        if (sum !== (b[4] & 0x0f))
            return DECODE_FAIL_MIC;
        const id = (b[1] << 12) | (b[2] << 4) | (b[3] >> 4);
        if (id > 999999)
            return DECODE_FAIL_SANITY;
        const button = ((b[3] << 4) | (b[4] >> 4)) & 0xff;
        ctx.emit({
            model: 'DirecTV-RC66RX',
            type: 'Remote',
            id,
            button_id: button,
            button_name: DTV_BUTTON[button] ?? 'unknown',
            event: syncLen > 5 ? 'INITIAL' : 'REPEAT',
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const vivint = register({
    num: 342,
    name: 'Vivint Door/Window Sensor, V-DW21R-345/V-DW11-345',
    what: 'security sensor',
    modulation: 3,
    shortWidth: 150,
    longWidth: 0,
    resetLimit: 300,
    bands: BAND_345,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        bits.invert();
        const pos = bits.search(0, 0, new Uint8Array([0xff, 0xe0]), 12) + 12;
        if (bits.bitsPerRow[0] - pos < 80)
            return DECODE_ABORT_LENGTH;
        const b = bits.bytes(0, pos, 80);
        const eventType = b[0];
        const counter = (b[1] << 8) | b[2];
        const flags = b[3];
        const id = (((b[4] << 24) >>> 0) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0;
        if (id === 0 || id === 0xffffffff)
            return DECODE_FAIL_SANITY;
        let valid = false;
        if (eventType === 0xd0) {
            valid = ((b[8] << 8) | b[9]) === crc16(b, 8, 0x8050, 0);
        }
        else {
            const full = b[8];
            b[8] = full & 0xf0;
            const check12 = crc16(b, 9, 0x8050, 0) >> 4;
            b[8] = full;
            valid = check12 === (((full & 0x0f) << 8) | b[9]);
        }
        if (!valid)
            return DECODE_FAIL_MIC;
        const idStr = `${String((id >>> 20) & 0xfff).padStart(4, '0')}-${String(id & 0xfffff).padStart(7, '0')}`;
        ctx.emit({
            model: 'Vivint-Security',
            type: 'Security',
            id: idStr,
            counter,
            flags,
            event_type: eventType,
            data: hexOf(b, 0, 10),
            mic: 'CRC',
        });
        return 1;
    },
});
function crc32Mpeg2(d, len, from = 0) {
    let c = 0xffffffff;
    for (let i = 0; i < len; i++) {
        c = (c ^ (d[from + i] << 24)) >>> 0;
        for (let b = 0; b < 8; b++)
            c = (c & 0x80000000) ? (((c << 1) ^ 0x04c11db7) >>> 0) : ((c << 1) >>> 0);
    }
    return c >>> 0;
}
function ssnDescramble(buf, len, seed) {
    let reg = seed & 0xff;
    for (let i = 0; i < len; i++) {
        let k = 0;
        for (let b = 0; b < 8; b++) {
            k = ((k << 1) | ((reg >> 7) & 1)) & 0xff;
            let t = reg & 0x8e;
            t ^= t >> 4;
            t ^= t >> 2;
            t ^= t >> 1;
            reg = ((reg << 1) | (t & 1)) & 0xff;
        }
        buf[i] ^= k;
    }
}
function ssnTlv(psdu, len, i, parts, extras) {
    if (i + 2 > len)
        return { used: 0, type: 0, isDll: false };
    const h0 = psdu[i], h1 = psdu[i + 1];
    const isMpdu = (h0 & 0x80) !== 0;
    const type = isMpdu ? (h0 >> 3) : (((h0 << 1) | (h1 >> 7)) & 0x1ff);
    const vlen = isMpdu ? (((h0 & 0x07) << 8) | h1) : (h1 & 0x7f);
    if (i + 2 + vlen > len)
        return { used: 0, type: 0, isDll: false };
    parts.push(`${isMpdu ? 'M' : 'D'}${type}/${vlen}`);
    if (isMpdu && type === 17 && vlen > 0) {
        const nested = [];
        ssnTlv(psdu, i + 2 + vlen, i + 2, nested, null);
        parts[parts.length - 1] += `{${nested.join(' ')}}`;
    }
    if (extras) {
        const val = i + 2;
        if (isMpdu) {
            extras.seenMpdu = true;
        }
        else if (type === 2) {
            extras.seenDll2 = true;
            if (vlen === 3) {
                const raw = (psdu[val] << 16) | (psdu[val + 1] << 8) | psdu[val + 2];
                extras.cli = {
                    txPri: (raw >> 21) & 0x7, txTime: (raw >> 12) & 0x1ff,
                    rxPri: (raw >> 9) & 0x7, rxTime: raw & 0x1ff,
                };
            }
        }
        else if (type === 4) {
            extras.seenDll4 = true;
            if (vlen === 2) {
                const raw = (psdu[val] << 8) | psdu[val + 1];
                extras.seq = {
                    retry: (raw >> 15) & 1, fragMore: (raw >> 14) & 1,
                    fragNum: (raw >> 10) & 0xf, seqNum: raw & 0x3ff,
                };
            }
        }
        else if (type === 9) {
            extras.seenDll9 = true;
            if (vlen === 1)
                extras.rssi = psdu[val] >= 128 ? psdu[val] - 256 : psdu[val];
        }
        else if (type === 1) {
            if (vlen === 2)
                extras.fet = (psdu[val] << 8) | psdu[val + 1];
        }
        else if (type === 8) {
            if (vlen === 5)
                extras.syncChannel = psdu[val + 4];
        }
    }
    return { used: 2 + vlen, type, isDll: !isMpdu };
}
function ssnTlvs(psdu, psduLen, start, extras) {
    const parts = [];
    let i = start;
    let sawCrcMarker = false;
    while (i < psduLen) {
        const { used, type, isDll } = ssnTlv(psdu, psduLen, i, parts, extras);
        if (!used)
            break;
        i += used;
        if (isDll && type === 6) {
            sawCrcMarker = true;
            continue;
        }
        if (isDll && type === 5) {
            if (i < psduLen)
                parts.push(`+${psduLen - i}B`);
            return parts.join(' ');
        }
    }
    if (sawCrcMarker && i + 4 === psduLen) {
        const want = (((psdu[i] << 24) >>> 0) | (psdu[i + 1] << 16) | (psdu[i + 2] << 8) | psdu[i + 3]) >>> 0;
        parts.push(crc32Mpeg2(psdu, i) === want ? ':ok' : ':bad');
    }
    else if (i < psduLen) {
        parts.push(`+${psduLen - i}B`);
    }
    return parts.join(' ');
}
function ssnLink(fctrl, e) {
    if (fctrl === 2)
        return 'broadcast';
    if (fctrl === 3)
        return 'poll';
    if (fctrl === 1) {
        if (e.seenDll4 || e.seenMpdu)
            return 'data';
        if (e.seenDll2)
            return 'poll_ack';
        if (e.seenDll9)
            return 'data_ack';
    }
    return '';
}
export const silverSpringMesh = register({
    num: 383,
    name: 'Silver Spring Networks mesh endpoint (-s 1600k)',
    what: 'utility mesh endpoint',
    modulation: 16,
    shortWidth: 10,
    longWidth: 10,
    resetLimit: 1000,
    bands: BAND_915,
    decode(_dev, bits, ctx) {
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        const sync = new Uint8Array([0xaa, 0xaa, 0x18, 0xbf]);
        let pos = bits.search(0, 0, sync, 32);
        if (pos >= bits.bitsPerRow[0]) {
            bits.invert();
            pos = bits.search(0, 0, sync, 32);
            if (pos >= bits.bitsPerRow[0])
                return DECODE_ABORT_EARLY;
        }
        const frameStart = pos + 32 - 1;
        const availBits = bits.bitsPerRow[0] - frameStart;
        if (availBits < (3 + 4) * 8)
            return DECODE_ABORT_LENGTH;
        let availBytes = (availBits / 8) | 0;
        if (availBytes > 512)
            availBytes = 512;
        bits.invert();
        const frame = bits.bytes(0, frameStart, availBytes * 8);
        if (frame[1] & 0xf8)
            return DECODE_FAIL_SANITY;
        const channel = frame[0];
        const psduLen = ((frame[1] & 0x07) << 8) | frame[2];
        if (psduLen < 1 || 3 + psduLen + 4 > availBytes)
            return DECODE_ABORT_LENGTH;
        const scrLen = psduLen + 4;
        const psdu = new Uint8Array(scrLen);
        let seedFound = -1;
        for (let seed = 1; seed < 256; seed++) {
            psdu.set(frame.subarray(3, 3 + scrLen));
            ssnDescramble(psdu, scrLen, seed);
            const fcs = (((psdu[psduLen] << 24) >>> 0) | (psdu[psduLen + 1] << 16)
                | (psdu[psduLen + 2] << 8) | psdu[psduLen + 3]) >>> 0;
            if (crc32Mpeg2(psdu, psduLen) === fcs) {
                seedFound = seed;
                break;
            }
        }
        if (seedFound < 0)
            return DECODE_FAIL_MIC;
        const fctrl = psdu[0];
        let at = 1;
        let dst = '', src = '';
        if ((fctrl & 0x01) && at + 8 <= psduLen) {
            dst = hexOf(psdu, at, 8);
            at += 8;
        }
        if ((fctrl & 0x02) && at + 8 <= psduLen) {
            src = hexOf(psdu, at, 8);
            at += 8;
        }
        const extras = { seenDll2: false, seenDll4: false, seenDll9: false, seenMpdu: false };
        const tlvs = ssnTlvs(psdu, psduLen, at, extras);
        const link = ssnLink(fctrl, extras);
        const out = {
            model: 'SilverSpring-Mesh',
            type: 'Meter',
            channel,
            seed: seedFound,
            len: psduLen,
            data: hexOf(psdu, 0, psduLen),
            mic: 'CRC',
        };
        if (dst)
            out.dst_id = dst;
        if (src)
            out.src_id = src;
        if (link)
            out.link = link;
        if (tlvs)
            out.tlvs = tlvs;
        if (extras.seq) {
            out.seq_num = extras.seq.seqNum;
            out.frag_num = extras.seq.fragNum;
            out.frag_more = extras.seq.fragMore;
            out.retry = extras.seq.retry;
        }
        if (extras.fet !== undefined)
            out.fet = extras.fet;
        if (extras.rssi !== undefined)
            out.rssi = extras.rssi;
        if (extras.cli) {
            out.cli_tx_pri = extras.cli.txPri;
            out.cli_tx_time = extras.cli.txTime;
            out.cli_rx_pri = extras.cli.rxPri;
            out.cli_rx_time = extras.cli.rxTime;
        }
        if (extras.syncChannel !== undefined)
            out.sync_channel = extras.syncChannel;
        ctx.emit(out);
        return 1;
    },
});
