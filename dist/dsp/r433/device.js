export const FSK_DEMOD_MIN_VAL = 16;
export const DECODE_FAIL_OTHER = 0;
export const DECODE_ABORT_LENGTH = -1;
export const DECODE_ABORT_EARLY = -2;
export const DECODE_FAIL_MIC = -3;
export const DECODE_FAIL_SANITY = -4;
export const REGISTRY = [];
export function register(dev) {
    REGISTRY.push(dev);
    return dev;
}
export function byNum(num) {
    return REGISTRY.find(d => d.num === num);
}
