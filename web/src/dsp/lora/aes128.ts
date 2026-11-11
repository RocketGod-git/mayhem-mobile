/**
 * AES-128 (FIPS-197): one-block encryption and decryption, ECB decryption and counter mode on top of them.
 * Port of core/lora/Aes128.swift. Pure synchronous code (WebCrypto is async and cannot run inside the DSP loop):
 * Meshtastic channel traffic is AES-CTR, MeshCore group traffic AES-ECB.
 */

const SBOX = Uint8Array.from([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

const INV = (() => { const t = new Uint8Array(256); for (let i = 0; i < 256; i++) t[SBOX[i]] = i; return t; })();

const xtime = (x: number): number => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;

function mul(a: number, b: number): number {
  let p = 0;
  while (b !== 0) { if (b & 1) p ^= a; a = xtime(a); b >>= 1; }
  return p;
}

export const Aes128 = {
  /** The 11 round keys, 176 bytes. */
  expand(key: ArrayLike<number>): Uint8Array {
    const w = new Uint8Array(176);
    for (let i = 0; i < 16; i++) w[i] = key[i];
    let rcon = 1, len = 16;
    while (len < 176) {
      let t = [w[len - 4], w[len - 3], w[len - 2], w[len - 1]];
      if (len % 16 === 0) {
        t = [SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
        rcon = xtime(rcon);
      }
      for (let i = 0; i < 4; i++) { w[len] = w[len - 16] ^ t[i]; len++; }
    }
    return w;
  },

  encrypt(block: ArrayLike<number>, rk: Uint8Array): Uint8Array {
    let s = new Uint8Array(16);
    for (let i = 0; i < 16; i++) s[i] = block[i] ^ rk[i];
    for (let round = 1; round <= 10; round++) {
      for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
      // shift rows (state is column-major: s[r + 4c])
      s = Uint8Array.of(s[0], s[5], s[10], s[15], s[4], s[9], s[14], s[3], s[8], s[13], s[2], s[7], s[12], s[1], s[6], s[11]);
      if (round < 10) {
        for (let c = 0; c < 4; c++) {
          const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
          const all = a0 ^ a1 ^ a2 ^ a3;
          s[4 * c] ^= all ^ xtime(a0 ^ a1);
          s[4 * c + 1] ^= all ^ xtime(a1 ^ a2);
          s[4 * c + 2] ^= all ^ xtime(a2 ^ a3);
          s[4 * c + 3] ^= all ^ xtime(a3 ^ a0);
        }
      }
      for (let i = 0; i < 16; i++) s[i] ^= rk[16 * round + i];
    }
    return s;
  },

  /** The inverse cipher on one block (MeshCore encrypts with AES-128 in ECB mode). */
  decrypt(block: ArrayLike<number>, rk: Uint8Array): Uint8Array {
    let s = new Uint8Array(16);
    for (let i = 0; i < 16; i++) s[i] = block[i] ^ rk[160 + i];
    for (let round = 9; round >= 0; round--) {
      // inverse shift rows
      s = Uint8Array.of(s[0], s[13], s[10], s[7], s[4], s[1], s[14], s[11], s[8], s[5], s[2], s[15], s[12], s[9], s[6], s[3]);
      for (let i = 0; i < 16; i++) s[i] = INV[s[i]];
      for (let i = 0; i < 16; i++) s[i] ^= rk[16 * round + i];
      if (round > 0) {
        for (let c = 0; c < 4; c++) {
          const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
          s[4 * c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
          s[4 * c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
          s[4 * c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
          s[4 * c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
        }
      }
    }
    return s;
  },

  /** ECB decryption of whole blocks (a short tail is dropped). */
  ecbDecrypt(key: ArrayLike<number>, data: Uint8Array): Uint8Array {
    const rk = Aes128.expand(key);
    const out = new Uint8Array(data.length - (data.length % 16));
    for (let i = 0; i + 16 <= data.length; i += 16) out.set(Aes128.decrypt(data.subarray(i, i + 16), rk), i);
    return out;
  },

  /** Counter mode: the 16-byte counter block counts up big-endian from `iv`. */
  ctr(key: ArrayLike<number>, iv: ArrayLike<number>, data: Uint8Array): Uint8Array {
    const rk = Aes128.expand(key);
    const ctr = Uint8Array.from(iv as ArrayLike<number>);
    const out = new Uint8Array(data.length);
    let ks = new Uint8Array(16);
    for (let i = 0; i < data.length; i++) {
      if (i % 16 === 0) {
        ks = Aes128.encrypt(ctr, rk);
        for (let k = 15; k >= 0; k--) { ctr[k] = (ctr[k] + 1) & 0xff; if (ctr[k] !== 0) break; }
      }
      out[i] = data[i] ^ ks[i % 16];
    }
    return out;
  },
};
