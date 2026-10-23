import { BitBuffer, bitAt } from '../bitbuffer.js';
import { DECODE_ABORT_EARLY, DECODE_ABORT_LENGTH, DECODE_FAIL_MIC, DECODE_FAIL_SANITY, register, } from '../device.js';
import { addNibbles, crc4, crc16, reflect4, xorBytes } from '../util.js';
const BAND_433 = [433920000];
const round1 = (x) => Math.round(x * 10) / 10;
const LIGHTWAVE_NIBBLE = (() => {
    const table = new Int8Array(256).fill(-1);
    const bytes = [0xf6, 0xee, 0xed, 0xeb, 0xde, 0xdd, 0xdb, 0xbe,
        0xbd, 0xbb, 0xb7, 0x7e, 0x7d, 0x7b, 0x77, 0x6f];
    bytes.forEach((b, nibble) => { table[b] = nibble; });
    return table;
})();
export const lightwaveRf = register({
    num: 61,
    name: 'LightwaveRF',
    what: 'lighting and socket remote',
    modulation: 5,
    shortWidth: 250,
    longWidth: 1250,
    resetLimit: 1500,
    bands: BAND_433,
    disabled: true,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] !== 71 || bits.numRows !== 1)
            return DECODE_ABORT_LENGTH;
        bits.invert();
        const stuffed = new BitBuffer();
        for (let n = 0; n < bits.bitsPerRow[0]; n++) {
            if (bitAt(bits.bb[0], n)) {
                stuffed.addBit(1);
            }
            else {
                stuffed.addBit(1);
                stuffed.addBit(0);
            }
        }
        if (stuffed.bitsPerRow[0] !== 91)
            return DECODE_ABORT_LENGTH;
        let idx = 0;
        if (!bitAt(stuffed.bb[0], idx++))
            return DECODE_ABORT_EARLY;
        const stripped = new BitBuffer();
        for (let n = 0; n < 10; n++) {
            if (!bitAt(stuffed.bb[0], idx++))
                return DECODE_ABORT_EARLY;
            for (let m = 0; m < 8; m++)
                stripped.addBit(bitAt(stuffed.bb[0], idx++));
        }
        const nibbles = new BitBuffer();
        for (let n = 0; n < 10; n++) {
            const nibble = LIGHTWAVE_NIBBLE[stripped.bb[0][n]];
            if (nibble < 0)
                return DECODE_FAIL_SANITY;
            for (let m = 0; m < 4; m++)
                nibbles.addBit((nibble >> (3 - m)) & 1);
        }
        const b = nibbles.bb[0];
        ctx.emit({
            model: 'Lightwave-RF',
            type: 'Remote',
            id: (b[2] << 16) | (b[3] << 8) | b[4],
            subunit: (b[1] & 0xf0) >> 4,
            command: b[1] & 0x0f,
            parameter: b[0],
        });
        return 1;
    },
});
const PHILIPS_CHANNEL = [2, 0, 1, 0, 3];
export const philipsAj3650 = register({
    num: 94,
    name: 'Philips outdoor temperature sensor (type AJ3650)',
    what: 'thermometer',
    modulation: 6,
    shortWidth: 2000,
    longWidth: 6000,
    resetLimit: 30000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        bits.invert();
        if (bits.numRows !== 1)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[0] !== 112)
            return DECODE_ABORT_LENGTH;
        const bb = bits.bb[0];
        if ((bb[0] >> 4) !== 0x0)
            return DECODE_ABORT_EARLY;
        const packet = new Uint8Array(4);
        for (let i = 0; i < 4; i++) {
            const a = bb[i + 1];
            const b = ((bb[i + 5] << 4) | ((bb[i + 6] >> 4) & 0x0f)) & 0xff;
            const c = bb[i + 10];
            packet[i] = (a & b) | (b & c) | (a & c);
        }
        if (crc4(packet, 4, 0x9, 1) !== 0)
            return DECODE_FAIL_MIC;
        const wire = packet[0] & 0x0f;
        const tempRaw = (packet[1] << 2) | (packet[2] >> 6);
        ctx.emit({
            model: 'Philips-Temperature',
            type: 'Weather',
            channel: wire >= PHILIPS_CHANNEL.length ? 0 : PHILIPS_CHANNEL[wire],
            battery_ok: (packet[3] & 0x40) ? 0 : 1,
            temperature_C: round1((tempRaw - 500) * 0.1),
        });
        return 1;
    },
});
function geDecodeBits(bits, start, out) {
    const row = bits.bb[0];
    const len = bits.bitsPerRow[0];
    let ipos = start;
    while (ipos < len) {
        const first = bitAt(row, ipos++);
        const second = bitAt(row, ipos++);
        if (first === 1 && second === 0) {
            out.addBit(0);
        }
        else if (first === 1 && second === 1) {
            if (bitAt(row, ipos++) === 0 && bitAt(row, ipos++) === 0)
                out.addBit(1);
            else
                break;
        }
        else {
            break;
        }
    }
}
function geFrame(bits, start, ctx) {
    const packet = new BitBuffer();
    geDecodeBits(bits, start, packet);
    if (packet.bitsPerRow[0] !== 17)
        return DECODE_ABORT_LENGTH;
    const b = packet.bb[0];
    if (b[0] & 0xc0)
        return DECODE_FAIL_SANITY;
    if (b[2] & 0x80)
        return DECODE_FAIL_SANITY;
    const command = b[1];
    const named = command === 0x5a ? 'change' : command === 0xaa ? 'on' : command === 0x55 ? 'off' : null;
    ctx.emit({
        model: 'GE-ColorEffects',
        type: 'Remote',
        id: b[0],
        command: named ?? `0x${command.toString(16)}`,
    });
    return 1;
}
export const geColoreffects = register({
    num: 98,
    name: 'GE Color Effects',
    what: 'Christmas light remote',
    modulation: 16,
    shortWidth: 52,
    longWidth: 52,
    resetLimit: 450,
    decode(_dev, bits, ctx) {
        const patterns = [
            [new Uint8Array([0xcc, 0xff, 0x00]), 24],
            [new Uint8Array([0xcc, 0xff, 0x00]), 23],
            [new Uint8Array([0xcc, 0xfe, 0x00]), 23],
            [new Uint8Array([0xcc, 0xfe, 0x00]), 22],
        ];
        let bitpos = 0;
        let events = 0;
        let ret = 0;
        for (;;) {
            let found = -1;
            for (const [pattern, len] of patterns) {
                const at = bits.search(0, bitpos, pattern, len) + len;
                if (at + 33 <= bits.bitsPerRow[0]) {
                    found = at;
                    break;
                }
            }
            if (found < 0)
                break;
            bitpos = found;
            ret = geFrame(bits, bitpos, ctx);
            if (ret > 0)
                events += ret;
            bitpos++;
        }
        return events > 0 ? events : ret;
    },
});
export const philipsAj7010 = register({
    num: 135,
    name: 'Philips outdoor temperature sensor (type AJ7010)',
    what: 'thermometer',
    modulation: 6,
    shortWidth: 2000,
    longWidth: 6000,
    syncWidth: 1000,
    resetLimit: 30000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        bits.invert();
        if (bits.numRows !== 1)
            return DECODE_ABORT_LENGTH;
        if (bits.bitsPerRow[0] !== 40)
            return DECODE_ABORT_LENGTH;
        const b = bits.bb[0];
        if (!b[0] && !b[2] && !b[3] && !b[4])
            return DECODE_FAIL_SANITY;
        if (b[0] !== 0x00)
            return DECODE_FAIL_SANITY;
        if (xorBytes(b, 5) && (xorBytes(b, 3) ^ b[4]))
            return DECODE_FAIL_MIC;
        const channel = b[1] === 0x36 ? 3 : b[1] === 0x45 ? 2 : b[1] === 0x5a ? 1 : 0;
        const tempRaw = ((b[3] & 0x3f) << 8) | b[2];
        ctx.emit({
            model: 'Philips-AJ7010',
            type: 'Weather',
            channel,
            temperature_C: round1(tempRaw / 353.0 - 9.2),
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
export const quinetic = register({
    num: 270,
    name: 'Quinetic',
    what: 'kinetic wall switch',
    modulation: 16,
    shortWidth: 10,
    longWidth: 10,
    resetLimit: 120,
    tolerance: 1,
    bands: [433300000],
    disabled: true,
    decode(_dev, bits, ctx) {
        if (bits.bitsPerRow[0] < 110 || bits.bitsPerRow[0] > 140)
            return DECODE_ABORT_LENGTH;
        const pos = bits.search(0, 0, new Uint8Array([0xa4, 0x23]), 16);
        if (pos >= bits.bitsPerRow[0])
            return DECODE_ABORT_EARLY;
        const b = bits.bytes(0, pos + 16, 40);
        if (crc16(b, 5, 0x1021, 0x1d0f) !== 0)
            return DECODE_FAIL_MIC;
        if (b[2] === 192)
            return DECODE_ABORT_EARLY;
        ctx.emit({
            model: 'Quinetic',
            type: 'Remote',
            id: ((b[0] << 8) | b[1]).toString(16).padStart(4, '0'),
            channel: b[2],
            mic: 'CRC',
        });
        return 1;
    },
});
const MARTEC_SPEED = ['off', 'high', 'medium', 'low'];
export const martecMplcd = register({
    num: 335,
    name: 'Martec MPLCD Ceiling Fan Remote',
    what: 'ceiling fan remote',
    modulation: 6,
    shortWidth: 292,
    longWidth: 648,
    gapLimit: 850,
    resetLimit: 12000,
    bands: BAND_433,
    decode(_dev, bits, ctx) {
        const row = bits.findRepeatedRow(2, 22);
        if (row < 0)
            return DECODE_ABORT_EARLY;
        if (bits.bitsPerRow[row] > 22)
            return DECODE_ABORT_LENGTH;
        const bytes = bits.bytes(row, 1, 21);
        if ((addNibbles(bytes, 2) & 0x0f) !== ((bytes[2] >> 3) & 0x0f))
            return DECODE_FAIL_MIC;
        if (bytes[0] === 0 && bytes[1] === 0)
            return DECODE_FAIL_SANITY;
        let dimmer = ((bytes[0] & 0x01) << 6) + ((bytes[1] >> 2) & 0x3f);
        if (dimmer > 0)
            dimmer = 42 - dimmer;
        ctx.emit({
            model: 'Martec-MPLCD',
            type: 'Remote',
            id: reflect4(((~bytes[0]) >> 1) & 0x0f),
            dimmer,
            speed: MARTEC_SPEED[bytes[1] & 0x03],
            mic: 'CHECKSUM',
        });
        return 1;
    },
});
