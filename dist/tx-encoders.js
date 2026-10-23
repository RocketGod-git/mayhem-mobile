const PREAMBLE = 0xAAAAAAAA | 0, SYNCWORD = 0x7CD215D8 | 0, IDLEWORD = 0x7A89C197 | 0;
export function insertBch(codewordIn) {
    const d21 = codewordIn >>> 11;
    let rem = (d21 << 10) >>> 0;
    for (let i = 30; i >= 10; i--)
        if (rem & (1 << i))
            rem ^= 0x769 << (i - 10);
    let cw = ((codewordIn & 0xFFFFF801) | ((rem & 0x3FF) << 1)) >>> 0;
    let parity = 0;
    for (let i = 1; i <= 31; i++)
        if (cw & (1 << i))
            parity++;
    return (cw | (parity & 1)) >>> 0;
}
function digitCode(ch) {
    let code;
    if (ch >= '0' && ch <= '9')
        code = ch.charCodeAt(0) - 48;
    else if (ch === 'S')
        code = 10;
    else if (ch === 'U')
        code = 11;
    else if (ch === ' ')
        code = 12;
    else if (ch === '-')
        code = 13;
    else if (ch === ']')
        code = 14;
    else if (ch === '[')
        code = 15;
    else
        code = 12;
    code = ((code & 0x0C) >> 2) | ((code & 0x03) << 2);
    code = ((code & 0x0A) >> 1) | ((code & 0x05) << 1);
    return code;
}
export function pocsag(address, func, message, type) {
    const cw = [];
    for (let b = 0; b < 576 / 32; b++)
        cw.push(PREAMBLE);
    let codeword = ((address & 0x1FFFF8) << 10) >>> 0;
    const addressSlot = (address & 7) * 2;
    codeword = (codeword | (func << 11)) >>> 0;
    codeword = insertBch(codeword);
    cw.push(SYNCWORD);
    let c = 0;
    while (c < 16) {
        if (c === addressSlot) {
            cw.push(codeword);
            if (type !== 2)
                break;
        }
        else
            cw.push(IDLEWORD);
        c++;
    }
    if (type === 2)
        return cw;
    c++;
    codeword = 0;
    let bitIdx = 20 + 11, charIdx = 0, ascii = 0;
    const size = message.length;
    do {
        if (c === 0)
            cw.push(SYNCWORD);
        for (; c < 16; c++) {
            if (type === 0) {
                if (charIdx < size || ascii !== 0) {
                    do {
                        bitIdx -= 7;
                        ascii = charIdx < size ? message.charCodeAt(charIdx) & 0x7F : 0;
                        ascii = ((ascii & 0xF0) >> 4) | ((ascii & 0x0F) << 4);
                        ascii = ((ascii & 0xCC) >> 2) | ((ascii & 0x33) << 2);
                        ascii = ((ascii & 0xAA) >> 2) | (ascii & 0x55);
                        codeword = (codeword | (ascii << bitIdx)) >>> 0;
                        charIdx++;
                    } while (bitIdx > 11);
                    codeword = (codeword & 0x7FFFF800) >>> 0;
                    codeword = (codeword | 0x80000000) >>> 0;
                    codeword = insertBch(codeword);
                    cw.push(codeword | 0);
                    if (bitIdx !== 11) {
                        bitIdx += 20;
                        codeword = (ascii << bitIdx) >>> 0;
                    }
                    else {
                        bitIdx = 20 + 11;
                        codeword = 0;
                    }
                }
                else
                    cw.push(IDLEWORD);
            }
            else if (type === 1) {
                if (charIdx < size) {
                    do {
                        bitIdx -= 4;
                        const dc = charIdx < size ? digitCode(message[charIdx]) : 3;
                        codeword = (codeword | (dc << bitIdx)) >>> 0;
                        charIdx++;
                    } while (bitIdx > 11);
                    codeword = (codeword | 0x80000000) >>> 0;
                    codeword = insertBch(codeword);
                    cw.push(codeword | 0);
                    bitIdx = 20 + 11;
                    codeword = 0;
                }
                else
                    cw.push(IDLEWORD);
            }
        }
        c = 0;
    } while (charIdx < size);
    return cw;
}
export function pocsagBits(codewords) {
    const bits = [];
    for (const w of codewords)
        for (let b = 31; b >= 0; b--)
            bits.push(((w >>> b) & 1) === 1);
    return bits;
}
const LTRS = [0, 'E', '\n', 'A', ' ', 'S', 'I', 'U', '\r', 'D', 'R', 'J', 'N', 'F', 'C', 'K', 'T', 'Z', 'L', 'W', 'H', 'Y', 'P', 'Q', 'O', 'B', 'G', 0, 'M', 'X', 'V', 0];
const FIGS = [0, '3', '\n', '-', ' ', "'", '8', '7', '\r', '$', '4', '\x07', ',', '!', ':', '(', '5', '+', ')', '2', '#', '6', '0', '1', '9', '?', '&', 0, '.', '/', '=', 0];
const FIGS_SHIFT = 0x1B, LTRS_SHIFT = 0x1F;
export function baudot(text) {
    const out = [LTRS_SHIFT];
    let figures = false;
    for (const ch of text.toUpperCase()) {
        if (ch === ' ') {
            out.push(0x04);
            continue;
        }
        let idx = -1, wantFigs = false;
        for (let i = 1; i < 32; i++) {
            if (LTRS[i] === ch) {
                idx = i;
                wantFigs = false;
                break;
            }
            if (FIGS[i] === ch) {
                idx = i;
                wantFigs = true;
            }
        }
        if (idx < 0)
            continue;
        if (wantFigs !== figures) {
            out.push(wantFigs ? FIGS_SHIFT : LTRS_SHIFT);
            figures = wantFigs;
        }
        out.push(idx);
    }
    return out;
}
export function ax25Aprs(source, info) {
    const f = [];
    const addr = (call, ssid, last) => {
        const c = call.toUpperCase().padEnd(6, ' ');
        for (let i = 0; i < 6; i++)
            f.push((c.charCodeAt(i) & 0x7F) << 1);
        f.push(((ssid & 0x0F) << 1) | 0x60 | (last ? 1 : 0));
    };
    const call = source.split('-')[0].slice(0, 6);
    const ssid = parseInt(source.split('-')[1] ?? '0', 10) || 0;
    addr('APZMHM', 0, false);
    addr(call, ssid, true);
    f.push(0x03, 0xF0);
    for (const ch of info)
        f.push(ch.charCodeAt(0) & 0xFF);
    let crc = 0xFFFF;
    for (const b of f) {
        let v = b;
        for (let k = 0; k < 8; k++) {
            const bit = (crc & 1) ^ (v & 1);
            crc >>>= 1;
            if (bit)
                crc ^= 0x8408;
            v >>= 1;
        }
    }
    crc = (~crc) & 0xFFFF;
    f.push(crc & 0xFF, (crc >> 8) & 0xFF);
    return f;
}
export function ax25Bits(frame, flags = 32) {
    const raw = [];
    const flag = () => { for (const b of [0, 1, 1, 1, 1, 1, 1, 0])
        raw.push(b === 1); };
    for (let i = 0; i < flags; i++)
        flag();
    let ones = 0;
    for (const byte of frame)
        for (let i = 0; i < 8; i++) {
            const bit = (byte >> i) & 1;
            raw.push(bit === 1);
            if (bit === 1) {
                ones++;
                if (ones === 5) {
                    raw.push(false);
                    ones = 0;
                }
            }
            else
                ones = 0;
        }
    for (let i = 0; i < flags; i++)
        flag();
    const out = new Array(raw.length);
    let level = true;
    for (let i = 0; i < raw.length; i++) {
        if (!raw[i])
            level = !level;
        out[i] = level;
    }
    return out;
}
const DTMF_ROW = [697, 770, 852, 941], DTMF_COL = [1209, 1336, 1477, 1633], DTMF_KEYS = '123A456B789C*0#D';
export function dtmf(key) {
    const i = DTMF_KEYS.indexOf(key.toUpperCase());
    return i < 0 ? null : [DTMF_ROW[Math.floor(i / 4)], DTMF_COL[i % 4]];
}
