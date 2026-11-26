/** Reed-Solomon over GF(256) (poly 0x11D, first root a^1, 8 parity bytes), for the 96-byte audio PDU header (1017s). */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const NROOTS = 8, N = 255;

/** Corrects a codeword given highest degree first; returns the corrections made, or -1 if it can't. */
export function rsDecode(c: Uint8Array): number {
  const n = c.length;
  const S = new Uint8Array(NROOTS);
  let any = 0;
  for (let j = 0; j < NROOTS; j++) {
    let s = 0; const a = j + 1;
    for (let i = 0; i < n; i++) s = mul(s, EXP[a]) ^ c[i];
    S[j] = s; any |= s;
  }
  if (!any) return 0;
  // Berlekamp-Massey
  let L = 0; const C = new Uint8Array(NROOTS + 1), B = new Uint8Array(NROOTS + 1); C[0] = 1; B[0] = 1;
  let m = 1, b = 1;
  for (let r = 0; r < NROOTS; r++) {
    let d = S[r]; for (let i = 1; i <= L; i++) d ^= mul(C[i], S[r - i]);
    if (!d) { m++; continue; }
    const coef = mul(d, EXP[255 - LOG[b]]), T = C.slice();
    for (let i = m; i <= NROOTS; i++) C[i] ^= mul(coef, B[i - m]);
    if (2 * L <= r) { L = r + 1 - L; B.set(T); b = d; m = 1; } else m++;
  }
  if (L > NROOTS / 2) return -1;
  // Chien search over the positions this (shortened) codeword has: position p counts from the end
  const pos: number[] = [];
  for (let p = 0; p < n; p++) {
    const xinv = EXP[(255 - p) % 255]; let v = 0, xp = 1;
    for (let i = 0; i <= L; i++) { v ^= mul(C[i], xp); xp = mul(xp, xinv); }
    if (!v) pos.push(p);
  }
  if (pos.length !== L) return -1;
  // Forney: Omega = S(x) C(x) mod x^NROOTS
  const Om = new Uint8Array(NROOTS);
  for (let i = 0; i < NROOTS; i++) { let v = 0; for (let k = 0; k <= Math.min(i, L); k++) v ^= mul(C[k], S[i - k]); Om[i] = v; }
  for (const p of pos) {
    const X = EXP[p % 255], xinv = EXP[(255 - p) % 255];
    let om = 0, xp = 1; for (let i = 0; i < NROOTS; i++) { om ^= mul(Om[i], xp); xp = mul(xp, xinv); }
    let dc = 0; xp = 1; for (let i = 1; i <= L; i += 2) { dc ^= mul(C[i], xp); xp = mul(xp, mul(xinv, xinv)); }
    if (!dc) return -1;
    const e = mul(om, EXP[255 - LOG[dc]]);
    c[n - 1 - p] ^= e;
    void X; void N;
  }
  return pos.length;
}

const HDR = 96;
/** Corrects an audio PDU header in place (its bytes are stored lowest degree first); false if beyond repair. */
export function fixAudioHeader(by: Uint8Array, off: number): boolean {
  if (off + HDR > by.length) return false;
  const c = new Uint8Array(HDR);
  for (let i = 0; i < HDR; i++) c[i] = by[off + HDR - 1 - i];
  const r = rsDecode(c);
  if (r < 0) return false;
  for (let i = 0; i < HDR; i++) by[off + i] = c[HDR - 1 - i];
  return true;
}
