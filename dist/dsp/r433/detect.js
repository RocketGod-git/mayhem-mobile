export const PD_MAX_PULSES = 1200;
export const PD_MIN_PULSES = 16;
export const PD_MIN_PULSE_SAMPLES = 10;
export const PD_MIN_GAP_MS = 10;
export const PD_MAX_GAP_MS = 100;
export const PD_MAX_GAP_RATIO = 10;
const OOK_MAX_HIGH_LEVEL = 16384;
const OOK_EST_HIGH_RATIO = 64;
const OOK_EST_LOW_RATIO = 1024;
const FSK_EST_SLOW = 64;
const OOK_MIN_HIGH_LEVEL = 600;
const OOK_HIGH_LOW_RATIO = 3;
function emptyPulses(sampleRate, fsk) {
    return {
        pulse: new Int32Array(PD_MAX_PULSES + 1),
        gap: new Int32Array(PD_MAX_PULSES + 1),
        numPulses: 0,
        sampleRate,
        fsk,
    };
}
function clearPulses(p) {
    p.pulse.fill(0);
    p.gap.fill(0);
    p.numPulses = 0;
}
function shiftPulses(p) {
    const offs = PD_MAX_PULSES >> 1;
    p.pulse.copyWithin(0, offs);
    p.gap.copyWithin(0, offs);
    p.numPulses -= offs;
}
class FskDetect {
    constructor() {
        this.varMax = -32768;
        this.varMin = 32767;
        this.state = 0;
        this.pulseLength = 0;
        this.f1Est = 0;
        this.f2Est = 0;
        this.skipSamples = 40;
    }
    reset() {
        this.varMax = -32768;
        this.varMin = 32767;
        this.state = 0;
        this.pulseLength = 0;
        this.f1Est = 0;
        this.f2Est = 0;
        this.skipSamples = 40;
    }
    step(fm, out) {
        if (this.skipSamples === 0) {
            if (fm > this.varMax)
                this.varMax = fm;
            if (fm < this.varMin)
                this.varMin = fm;
            const mid = ((this.varMax + this.varMin) / 2) | 0;
            if (fm > mid)
                this.varMax -= 10;
            if (fm < mid)
                this.varMin += 10;
            this.pulseLength += 1;
            switch (this.state) {
                case 0:
                    this.state = fm > mid ? 1 : 2;
                    break;
                case 1:
                    if (fm < mid) {
                        this.state = 2;
                        out.pulse[out.numPulses] = this.pulseLength;
                        this.pulseLength = 0;
                    }
                    this.f2Est += ((fm / FSK_EST_SLOW) | 0) - ((this.f2Est / FSK_EST_SLOW) | 0);
                    break;
                case 2:
                    if (fm > mid) {
                        this.state = 1;
                        out.gap[out.numPulses] = this.pulseLength;
                        out.numPulses += 1;
                        this.pulseLength = 0;
                        if (out.numPulses >= PD_MAX_PULSES)
                            shiftPulses(out);
                    }
                    this.f1Est += ((fm / FSK_EST_SLOW) | 0) - ((this.f1Est / FSK_EST_SLOW) | 0);
                    break;
                default:
                    break;
            }
        }
        if (this.skipSamples > 0)
            this.skipSamples -= 1;
    }
}
export class PulseDetect {
    constructor(sampleRate) {
        this.sampleRate = sampleRate;
        this.ookState = 0;
        this.pulseLength = 0;
        this.maxPulse = 0;
        this.leadIn = 0;
        this.lowEstimate = 0;
        this.highEstimate = 0;
        this.fsk = new FskDetect();
        this.ook = emptyPulses(sampleRate, false);
        this.fskPulses = emptyPulses(sampleRate, true);
    }
    setSampleRate(rate) {
        this.sampleRate = rate;
        this.ook.sampleRate = rate;
        this.fskPulses.sampleRate = rate;
    }
    reset() {
        this.ookState = 0;
        this.pulseLength = 0;
        this.maxPulse = 0;
        this.leadIn = 0;
        this.lowEstimate = 0;
        this.highEstimate = 0;
        this.fsk.reset();
        clearPulses(this.ook);
        clearPulses(this.fskPulses);
    }
    process(env, fm, len, onBurst) {
        const samplesPerMs = (this.sampleRate / 1000) | 0;
        let eopOnSpurious = false;
        if (this.highEstimate < OOK_MIN_HIGH_LEVEL)
            this.highEstimate = OOK_MIN_HIGH_LEVEL;
        let n = 0;
        while (n < len) {
            const amp = env[n];
            const threshold = ((this.lowEstimate + Math.min(this.highEstimate, OOK_MAX_HIGH_LEVEL)) / 2) | 0;
            const hysteresis = (threshold / 8) | 0;
            switch (this.ookState) {
                case 0:
                    if (amp > threshold + hysteresis && this.leadIn > OOK_EST_LOW_RATIO) {
                        clearPulses(this.ook);
                        clearPulses(this.fskPulses);
                        this.pulseLength = 0;
                        this.maxPulse = 0;
                        this.fsk.reset();
                        this.ookState = 1;
                    }
                    else {
                        const delta = amp - this.lowEstimate;
                        this.lowEstimate += (delta / OOK_EST_LOW_RATIO) | 0;
                        this.lowEstimate += delta > 0 ? 1 : -1;
                        this.highEstimate = Math.max(OOK_HIGH_LOW_RATIO * this.lowEstimate, OOK_MIN_HIGH_LEVEL);
                        if (this.leadIn <= OOK_EST_LOW_RATIO)
                            this.leadIn += 1;
                    }
                    break;
                case 1:
                    this.pulseLength += 1;
                    if (amp < threshold - hysteresis) {
                        if (this.pulseLength < PD_MIN_PULSE_SAMPLES) {
                            if (this.ook.numPulses <= 1)
                                this.ookState = 0;
                            else {
                                eopOnSpurious = true;
                                this.ookState = 3;
                            }
                        }
                        else {
                            this.ook.pulse[this.ook.numPulses] = this.pulseLength;
                            if (this.pulseLength > this.maxPulse)
                                this.maxPulse = this.pulseLength;
                            this.pulseLength = 0;
                            this.ookState = 2;
                        }
                    }
                    else {
                        this.highEstimate += ((amp / OOK_EST_HIGH_RATIO) | 0) - ((this.highEstimate / OOK_EST_HIGH_RATIO) | 0);
                        if (this.highEstimate < OOK_MIN_HIGH_LEVEL)
                            this.highEstimate = OOK_MIN_HIGH_LEVEL;
                    }
                    if (this.ook.numPulses === 0)
                        this.fsk.step(fm[n], this.fskPulses);
                    break;
                case 2:
                    this.pulseLength += 1;
                    if (amp > threshold + hysteresis) {
                        this.pulseLength += this.ook.pulse[this.ook.numPulses];
                        this.ookState = 1;
                    }
                    else if (this.pulseLength >= PD_MIN_PULSE_SAMPLES) {
                        this.ookState = 3;
                        if (this.fskPulses.numPulses > PD_MIN_PULSES) {
                            this.ookState = 0;
                            onBurst(2, this.fskPulses);
                            eopOnSpurious = false;
                            continue;
                        }
                    }
                    if (this.ook.numPulses === 0)
                        this.fsk.step(fm[n], this.fskPulses);
                    break;
                case 3:
                    this.pulseLength += 1;
                    if (amp > threshold + hysteresis) {
                        this.ook.gap[this.ook.numPulses] = this.pulseLength;
                        this.ook.numPulses += 1;
                        if (this.ook.numPulses >= PD_MAX_PULSES) {
                            this.ookState = 0;
                            onBurst(1, this.ook);
                            eopOnSpurious = false;
                            continue;
                        }
                        this.pulseLength = 0;
                        this.ookState = 1;
                    }
                    if (eopOnSpurious
                        || (this.pulseLength > PD_MAX_GAP_RATIO * this.maxPulse && this.pulseLength > PD_MIN_GAP_MS * samplesPerMs)
                        || this.pulseLength > PD_MAX_GAP_MS * samplesPerMs) {
                        this.ook.gap[this.ook.numPulses] = this.pulseLength;
                        this.ook.numPulses += 1;
                        this.ookState = 0;
                        onBurst(1, this.ook);
                        eopOnSpurious = false;
                        continue;
                    }
                    break;
            }
            n += 1;
        }
    }
    levels() {
        const threshold = ((this.lowEstimate + Math.min(this.highEstimate, OOK_MAX_HIGH_LEVEL)) / 2) | 0;
        return { noise: this.lowEstimate | 0, trigger: (threshold + ((threshold / 8) | 0)) | 0 };
    }
    flush(onBurst) {
        if (this.ookState === 0)
            return;
        if (this.ookState === 1) {
            if (this.pulseLength < PD_MIN_PULSE_SAMPLES) {
                if (this.ook.numPulses <= 1) {
                    this.ookState = 0;
                    return;
                }
                this.ookState = 3;
            }
            else {
                this.ook.pulse[this.ook.numPulses] = this.pulseLength;
                if (this.pulseLength > this.maxPulse)
                    this.maxPulse = this.pulseLength;
                this.pulseLength = 0;
                this.ookState = 2;
            }
        }
        if (this.ookState === 2) {
            this.ookState = 3;
            if (this.fskPulses.numPulses > PD_MIN_PULSES) {
                this.ookState = 0;
                onBurst(2, this.fskPulses);
                return;
            }
        }
        if (this.ookState === 3) {
            this.ook.gap[this.ook.numPulses] = this.pulseLength;
            this.ook.numPulses += 1;
            this.ookState = 0;
            onBurst(1, this.ook);
        }
    }
}
