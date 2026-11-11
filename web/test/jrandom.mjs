/** java.util.Random (iOS JRandom, Kotlin's java.util.Random): the iOS and Android tests' exact noise sequences. */
export function jrandom(seed) {
  const M = (1n << 48n) - 1n;
  let st = (BigInt(seed) ^ 0x5DEECE66Dn) & M, have = false, keep = 0;
  const next = (bits) => { st = (st * 0x5DEECE66Dn + 0xBn) & M; return Number(BigInt.asIntN(32, st >> BigInt(48 - bits))); };
  const nextDouble = () => (next(26) * 2 ** 27 + next(27)) * 2 ** -53;
  const nextGaussian = () => {
    if (have) { have = false; return keep; }
    let v1, v2, s;
    do { v1 = 2 * nextDouble() - 1; v2 = 2 * nextDouble() - 1; s = v1 * v1 + v2 * v2; } while (s >= 1 || s === 0);
    const mul = Math.sqrt(-2 * Math.log(s) / s);
    keep = v2 * mul; have = true;
    return v1 * mul;
  };
  return { next, nextDouble, nextGaussian };
}
