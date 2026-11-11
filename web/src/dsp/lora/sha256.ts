/**
 * SHA-256 (FIPS 180-4) and HMAC-SHA256. Port of core/lora/Sha256.swift: pure synchronous code, so it runs inside
 * the DSP loop (MeshCore names its group channels by the hash of their key and signs group messages with an HMAC).
 */

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export const Sha256 = {
  hash(msg: ArrayLike<number>): Uint8Array {
    const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    let total = msg.length + 1;
    while (total % 64 !== 56) total++;
    const m = new Uint8Array(total + 8);
    for (let i = 0; i < msg.length; i++) m[i] = msg[i];
    m[msg.length] = 0x80;
    const bits = msg.length * 8;
    // the 64-bit big-endian bit count (messages here are far below 2^53 bits)
    const hi = Math.floor(bits / 4294967296), lo = bits >>> 0;
    m[total] = hi >>> 24; m[total + 1] = hi >>> 16; m[total + 2] = hi >>> 8; m[total + 3] = hi;
    m[total + 4] = lo >>> 24; m[total + 5] = lo >>> 16; m[total + 6] = lo >>> 8; m[total + 7] = lo;
    const w = new Uint32Array(64);
    for (let c = 0; c < m.length; c += 64) {
      for (let i = 0; i < 16; i++) w[i] = (m[c + 4 * i] << 24) | (m[c + 4 * i + 1] << 16) | (m[c + 4 * i + 2] << 8) | m[c + 4 * i + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h[0], b = h[1], cc = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & cc) ^ (b & cc))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = cc; cc = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] += a; h[1] += b; h[2] += cc; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) { out[4 * i] = h[i] >>> 24; out[4 * i + 1] = h[i] >>> 16; out[4 * i + 2] = h[i] >>> 8; out[4 * i + 3] = h[i]; }
    return out;
  },

  hmac(key: ArrayLike<number>, msg: ArrayLike<number>): Uint8Array {
    const k = new Uint8Array(64);
    k.set(key.length > 64 ? Sha256.hash(key) : Array.from(key));
    const inner = new Uint8Array(64 + msg.length), outer = new Uint8Array(64 + 32);
    for (let i = 0; i < 64; i++) { inner[i] = k[i] ^ 0x36; outer[i] = k[i] ^ 0x5c; }
    for (let i = 0; i < msg.length; i++) inner[64 + i] = msg[i];
    outer.set(Sha256.hash(inner), 64);
    return Sha256.hash(outer);
  },
};
