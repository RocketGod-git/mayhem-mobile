import { BitBuffer } from './bitbuffer.js';
const INT_MAX = 0x7fffffff;
const trunc = (x) => (x < 0 ? Math.ceil(x) : Math.floor(x));
function widths(pulses, dev) {
    const spus = pulses.sampleRate / 1e6;
    const w = {
        sShort: trunc(dev.shortWidth * spus),
        sLong: trunc(dev.longWidth * spus),
        sReset: trunc(dev.resetLimit * spus),
        sGap: trunc((dev.gapLimit ?? 0) * spus),
        sSync: trunc((dev.syncWidth ?? 0) * spus),
        sTol: trunc((dev.tolerance ?? 0) * spus),
    };
    if ((dev.shortWidth > 0 && w.sShort <= 0)
        || (dev.longWidth > 0 && w.sLong <= 0)
        || (dev.resetLimit > 0 && w.sReset <= 0)
        || ((dev.gapLimit ?? 0) > 0 && w.sGap <= 0)
        || ((dev.syncWidth ?? 0) > 0 && w.sSync <= 0)
        || ((dev.tolerance ?? 0) > 0 && w.sTol <= 0))
        return null;
    return w;
}
export function pulseSlicerPcm(pulses, dev, account) {
    const w = widths(pulses, dev);
    if (!w)
        return 0;
    const { sShort, sLong, sReset } = w;
    let sTol = w.sTol;
    let fShort = dev.shortWidth > 0 ? 1 / (dev.shortWidth * (pulses.sampleRate / 1e6)) : 0;
    let fLong = dev.longWidth > 0 ? 1 / (dev.longWidth * (pulses.sampleRate / 1e6)) : 0;
    let events = 0;
    const bits = new BitBuffer();
    const gapLimit = w.sGap ? w.sGap : sReset;
    const maxZeros = trunc(gapLimit / sLong);
    if (sTol <= 0)
        sTol = trunc(sLong / 4);
    let minCount = sShort === sLong ? 12 : 4;
    let preambleLen = 0;
    for (let n = 0; sShort !== sLong && n < pulses.numPulses; ++n) {
        let swidth = 0, lwidth = 0, count = 0;
        while (n < pulses.numPulses
            && pulses.pulse[n] >= sShort - sTol && pulses.pulse[n] <= sShort + sTol
            && pulses.pulse[n] + pulses.gap[n] >= sLong - sTol
            && pulses.pulse[n] + pulses.gap[n] <= sLong + sTol) {
            swidth += pulses.pulse[n];
            lwidth += pulses.pulse[n] + pulses.gap[n];
            count += 1;
            n++;
        }
        if (count >= minCount) {
            fLong = count / lwidth;
            fShort = count / swidth;
            minCount = count;
            preambleLen = count;
        }
    }
    let rzsWidth = 0, rzlWidth = 0, rzCount = 0;
    for (let n = 0; preambleLen === 0 && sShort !== sLong && n < pulses.numPulses; ++n) {
        if (pulses.pulse[n] >= sShort - sTol && pulses.pulse[n] <= sShort + sTol
            && pulses.pulse[n] + pulses.gap[n] >= sLong - sTol
            && pulses.pulse[n] + pulses.gap[n] <= sLong + sTol) {
            rzsWidth += pulses.pulse[n];
            rzlWidth += pulses.pulse[n] + pulses.gap[n];
            rzCount += 1;
        }
    }
    if (rzCount > 8) {
        fLong = rzCount / rzlWidth;
        fShort = rzCount / rzsWidth;
    }
    for (let n = 0; sShort === sLong && n < pulses.numPulses; ++n) {
        let width = 0, count = 0;
        while (n < pulses.numPulses
            && trunc(pulses.pulse[n] * fShort + 0.5) === 1
            && trunc(pulses.gap[n] * fLong + 0.5) === 1) {
            width += pulses.pulse[n] + pulses.gap[n];
            count += 2;
            n++;
        }
        if (count >= minCount) {
            fShort = fLong = count / width;
            minCount = count;
            preambleLen = count;
        }
    }
    let nrzWidth = 0, nrzCount = 0;
    for (let n = 0; preambleLen === 0 && sShort === sLong && n < pulses.numPulses; ++n) {
        if (pulses.pulse[n] >= sShort - sTol && pulses.pulse[n] <= sShort + sTol) {
            nrzWidth += pulses.pulse[n];
            nrzCount += 1;
        }
        if (pulses.pulse[n] >= 2 * sShort - sTol && pulses.pulse[n] <= 2 * sShort + sTol) {
            nrzWidth += pulses.pulse[n];
            nrzCount += 2;
        }
        if (pulses.gap[n] >= sLong - sTol && pulses.gap[n] <= sLong + sTol) {
            nrzWidth += pulses.gap[n];
            nrzCount += 1;
        }
        if (pulses.gap[n] >= 2 * sLong - sTol && pulses.gap[n] <= 2 * sLong + sTol) {
            nrzWidth += pulses.gap[n];
            nrzCount += 2;
        }
    }
    if (nrzCount > 20)
        fShort = fLong = nrzCount / nrzWidth;
    for (let n = 0; n < pulses.numPulses; ++n) {
        const highs = trunc(pulses.pulse[n] * fShort + 0.5);
        let lows = trunc((pulses.gap[n] + sShort - sLong) * fLong + 0.5);
        for (let i = 0; i < highs; ++i)
            bits.addBit(1);
        lows = Math.min(lows, maxZeros);
        for (let i = 0; i < lows; ++i)
            bits.addBit(0);
        if (sShort !== sLong && Math.abs(pulses.pulse[n] - sShort) > sTol) {
            bits.clear();
        }
        else if (pulses.gap[n] > gapLimit && pulses.gap[n] <= sReset) {
            bits.addRow();
        }
        if ((n === pulses.numPulses - 1 || pulses.gap[n] > sReset)
            && (bits.bitsPerRow[0] > 0 || bits.numRows > 1)) {
            events += account(bits);
        }
    }
    return events;
}
export function pulseSlicerPpm(pulses, dev, account) {
    const w = widths(pulses, dev);
    if (!w)
        return 0;
    const { sShort, sLong, sReset, sGap, sSync, sTol } = w;
    let events = 0;
    const bits = new BitBuffer();
    let zeroL, zeroU, oneL, oneU, syncL = 0, syncU = 0;
    if (sTol > 0) {
        zeroL = sShort - sTol;
        zeroU = sShort + sTol;
        oneL = sLong - sTol;
        oneU = sLong + sTol;
        if (sSync > 0) {
            syncL = sSync - sTol;
            syncU = sSync + sTol;
        }
    }
    else {
        zeroL = 0;
        zeroU = trunc((sShort + sLong) / 2) + 1;
        oneL = zeroU - 1;
        oneU = sGap ? sGap : sReset;
    }
    for (let n = 0; n < pulses.numPulses; ++n) {
        if (pulses.gap[n] > zeroL && pulses.gap[n] < zeroU)
            bits.addBit(0);
        else if (pulses.gap[n] > oneL && pulses.gap[n] < oneU)
            bits.addBit(1);
        else if (pulses.gap[n] > syncL && pulses.gap[n] < syncU)
            bits.addSync();
        else if (pulses.gap[n] < sReset)
            bits.addRow();
        if ((n === pulses.numPulses - 1 || pulses.gap[n] >= sReset)
            && (bits.bitsPerRow[0] > 0 || bits.numRows > 1)) {
            events += account(bits);
        }
    }
    return events;
}
export function pulseSlicerPwm(pulses, dev, account) {
    const w = widths(pulses, dev);
    if (!w)
        return 0;
    const { sShort, sLong, sReset, sGap, sSync, sTol } = w;
    let events = 0;
    const bits = new BitBuffer();
    let oneL, oneU, zeroL, zeroU, syncL = 0, syncU = 0;
    if (sTol > 0) {
        oneL = sShort - sTol;
        oneU = sShort + sTol;
        zeroL = sLong - sTol;
        zeroU = sLong + sTol;
        if (sSync > 0) {
            syncL = sSync - sTol;
            syncU = sSync + sTol;
        }
    }
    else if (sSync <= 0) {
        oneL = 0;
        oneU = trunc((sShort + sLong) / 2) + 1;
        zeroL = oneU - 1;
        zeroU = INT_MAX;
    }
    else if (sSync < sShort) {
        syncL = 0;
        syncU = trunc((sSync + sShort) / 2) + 1;
        oneL = syncU - 1;
        oneU = trunc((sShort + sLong) / 2) + 1;
        zeroL = oneU - 1;
        zeroU = INT_MAX;
    }
    else if (sSync < sLong) {
        oneL = 0;
        oneU = trunc((sShort + sSync) / 2) + 1;
        syncL = oneU - 1;
        syncU = trunc((sSync + sLong) / 2) + 1;
        zeroL = syncU - 1;
        zeroU = INT_MAX;
    }
    else {
        oneL = 0;
        oneU = trunc((sShort + sLong) / 2) + 1;
        zeroL = oneU - 1;
        zeroU = trunc((sLong + sSync) / 2) + 1;
        syncL = zeroU - 1;
        syncU = INT_MAX;
    }
    for (let n = 0; n < pulses.numPulses; ++n) {
        const p = pulses.pulse[n];
        if (p > oneL && p < oneU)
            bits.addBit(1);
        else if (p > zeroL && p < zeroU)
            bits.addBit(0);
        else if (p > syncL && p < syncU)
            bits.addSync();
        else if (p <= oneL) { }
        else
            bits.addRow();
        if ((n === pulses.numPulses - 1 || pulses.gap[n] > sReset) && bits.numRows > 0) {
            events += account(bits);
        }
        else if (sGap > 0 && pulses.gap[n] > sGap && bits.numRows > 0 && bits.bitsPerRow[bits.numRows - 1] > 0) {
            bits.addRow();
        }
    }
    return events;
}
export function pulseSlicerManchesterZerobit(pulses, dev, account) {
    const w = widths(pulses, dev);
    if (!w)
        return 0;
    const { sShort, sReset, sTol } = w;
    let events = 0;
    let timeSinceLast = 0;
    const bits = new BitBuffer();
    bits.addBit(0);
    for (let n = 0; n < pulses.numPulses; ++n) {
        if (sTol > 0
            && (pulses.pulse[n] < sShort - sTol || pulses.pulse[n] > sShort * 2 + sTol
                || pulses.gap[n] < sShort - sTol || pulses.gap[n] > sShort * 2 + sTol)) {
            if (pulses.pulse[n] > sShort * 1.5 && pulses.pulse[n] <= sShort * 2 + sTol) {
                bits.addBit(1);
            }
            bits.addRow();
            bits.addBit(0);
            timeSinceLast = 0;
        }
        else if (pulses.pulse[n] + timeSinceLast > sShort * 1.5) {
            bits.addBit(1);
            timeSinceLast = 0;
        }
        else {
            timeSinceLast += pulses.pulse[n];
        }
        if ((n === pulses.numPulses - 1 || pulses.gap[n] > sReset) && bits.numRows > 0) {
            events += account(bits);
            bits.addBit(0);
            timeSinceLast = 0;
        }
        else if (pulses.gap[n] + timeSinceLast > sShort * 1.5) {
            bits.addBit(0);
            timeSinceLast = 0;
        }
        else {
            timeSinceLast += pulses.gap[n];
        }
    }
    return events;
}
function symbolAt(pulses, n) {
    return n % 2 === 0 ? pulses.pulse[n >> 1] : pulses.gap[n >> 1];
}
export function pulseSlicerDmc(pulses, dev, account) {
    const w = widths(pulses, dev);
    if (!w)
        return 0;
    const { sShort, sLong, sReset, sTol } = w;
    const bits = new BitBuffer();
    let events = 0;
    const total = pulses.numPulses * 2;
    for (let n = 0; n < total; ++n) {
        let symbol = symbolAt(pulses, n);
        if (Math.abs(symbol - sShort) < sTol) {
            bits.addBit(1);
            symbol = n + 1 < total ? symbolAt(pulses, ++n) : 0;
            if (Math.abs(symbol - sShort) > sTol) {
                if (symbol >= sReset - sTol)
                    n--;
                else if (bits.numRows > 0 && bits.bitsPerRow[bits.numRows - 1] > 0)
                    bits.addRow();
            }
        }
        else if (Math.abs(symbol - sLong) < sTol) {
            bits.addBit(0);
        }
        else if (symbol >= sReset - sTol && bits.numRows > 0) {
            events += account(bits);
        }
    }
    return events;
}
export function pulseSlicerPiwmRaw(pulses, dev, account) {
    const w = widths(pulses, dev);
    if (!w)
        return 0;
    const { sShort, sLong, sReset, sTol } = w;
    const fShort = dev.shortWidth > 0 ? 1 / (dev.shortWidth * (pulses.sampleRate / 1e6)) : 0;
    const bits = new BitBuffer();
    let events = 0;
    const total = pulses.numPulses * 2;
    for (let n = 0; n < total; ++n) {
        const symbol = symbolAt(pulses, n);
        let count = trunc(symbol * fShort + 0.5);
        if (symbol > sLong) {
            bits.addRow();
        }
        else if (Math.abs(symbol - count * sShort) < sTol) {
            for (; count > 0; --count)
                bits.addBit(1 - (n % 2));
        }
        else if (symbol < sReset && bits.numRows > 0 && bits.bitsPerRow[bits.numRows - 1] > 0) {
            bits.addRow();
        }
        if ((n === total - 1 || symbol > sReset) && bits.numRows > 0) {
            events += account(bits);
        }
    }
    return events;
}
export function pulseSlicerPiwmDc(pulses, dev, account) {
    const w = widths(pulses, dev);
    if (!w)
        return 0;
    const { sShort, sLong, sReset, sTol } = w;
    const bits = new BitBuffer();
    let events = 0;
    const total = pulses.numPulses * 2;
    for (let n = 0; n < total; ++n) {
        const symbol = symbolAt(pulses, n);
        if (Math.abs(symbol - sShort) < sTol)
            bits.addBit(1);
        else if (Math.abs(symbol - sLong) < sTol)
            bits.addBit(0);
        else if (symbol < sReset && bits.numRows > 0 && bits.bitsPerRow[bits.numRows - 1] > 0)
            bits.addRow();
        if ((n === total - 1 || symbol > sReset) && bits.numRows > 0) {
            events += account(bits);
        }
    }
    return events;
}
export function pulseSlicerNrzs(pulses, dev, account) {
    const w = widths(pulses, dev);
    if (!w)
        return 0;
    const { sShort: limit, sReset } = w;
    let events = 0;
    const bits = new BitBuffer();
    for (let n = 0; n < pulses.numPulses; ++n) {
        if (pulses.pulse[n] > limit) {
            for (let i = 0; i < trunc(pulses.pulse[n] / limit); i++)
                bits.addBit(1);
            bits.addBit(0);
        }
        else if (pulses.pulse[n] < limit) {
            bits.addBit(0);
        }
        if (n === pulses.numPulses - 1 || pulses.gap[n] >= sReset)
            events += account(bits);
    }
    return events;
}
export function pulseSlicerRzi(pulses, dev, account) {
    const w = widths(pulses, dev);
    if (!w)
        return 0;
    const { sShort, sLong, sReset } = w;
    const sBase = sLong - sShort;
    const half = trunc(sLong / 2);
    let events = 0;
    const bits = new BitBuffer();
    let atStart = true;
    for (let n = 0; n < pulses.numPulses; ++n) {
        const high = pulses.pulse[n];
        let ones = atStart ? trunc((high + half) / sLong) : trunc((high - sBase + half) / sLong);
        atStart = false;
        if (ones < 0)
            ones = 0;
        for (let k = 0; k < ones; ++k)
            bits.addBit(1);
        if (pulses.gap[n] > sReset || n === pulses.numPulses - 1) {
            if (bits.bitsPerRow[0] > 0)
                events += account(bits);
            atStart = true;
            continue;
        }
        bits.addBit(0);
    }
    return events;
}
export function pulseSlicerOsv1(pulses, dev, account) {
    const w = widths(pulses, dev);
    if (!w)
        return 0;
    const { sShort, sReset } = w;
    const halfbitMin = trunc(sShort / 2);
    const halfbitMax = trunc((sShort * 3) / 2);
    const syncMin = 2 * halfbitMax;
    let events = 0;
    let manbit = 0;
    const bits = new BitBuffer();
    let n = 0;
    let preamble = 0;
    for (; n < pulses.numPulses; ++n) {
        if (pulses.pulse[n] > halfbitMin && pulses.gap[n] > halfbitMin) {
            preamble++;
            if (pulses.gap[n] > halfbitMax)
                break;
        }
        else {
            return events;
        }
    }
    if (preamble !== 12)
        return events;
    ++n;
    if (n >= pulses.numPulses || pulses.pulse[n] < syncMin || pulses.gap[n] < syncMin)
        return events;
    if (pulses.gap[n] > pulses.pulse[n]) {
        manbit ^= 1;
        if (manbit)
            bits.addBit(0);
    }
    for (n++; n < pulses.numPulses; ++n) {
        manbit ^= 1;
        if (manbit)
            bits.addBit(1);
        if (pulses.pulse[n] > halfbitMax) {
            manbit ^= 1;
            if (manbit)
                bits.addBit(1);
        }
        if ((n === pulses.numPulses - 1 || pulses.gap[n] > sReset) && bits.numRows > 0) {
            events += account(bits);
            return events;
        }
        manbit ^= 1;
        if (manbit)
            bits.addBit(0);
        if (pulses.gap[n] > halfbitMax) {
            manbit ^= 1;
            if (manbit)
                bits.addBit(0);
        }
    }
    return events;
}
export function slice(pulses, dev, account) {
    switch (dev.modulation) {
        case 4:
        case 16:
            return pulseSlicerPcm(pulses, dev, account);
        case 5:
            return pulseSlicerPpm(pulses, dev, account);
        case 6:
        case 17:
            return pulseSlicerPwm(pulses, dev, account);
        case 3:
        case 18:
            return pulseSlicerManchesterZerobit(pulses, dev, account);
        case 9:
            return pulseSlicerDmc(pulses, dev, account);
        case 8:
            return pulseSlicerPiwmRaw(pulses, dev, account);
        case 11:
            return pulseSlicerPiwmDc(pulses, dev, account);
        case 12:
            return pulseSlicerNrzs(pulses, dev, account);
        case 13:
            return pulseSlicerRzi(pulses, dev, account);
        case 10:
            return pulseSlicerOsv1(pulses, dev, account);
        default:
            return 0;
    }
}
