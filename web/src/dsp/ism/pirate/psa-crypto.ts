/**
 * Port of ProtoPirate protocols/psa_crypto.c (decoder-side helpers; GPL-3.0). Twin of pirate/PPPsaCrypto.kt. The TEA
 * encrypt is encoder-only and the TEA brute force (psa_crypto_bf.c) is never run during decode, so neither ships here.
 * 32-bit words are plain numbers held in 0..0xFFFFFFFF.
 */
export const PPPsaCrypto = {
  BF1_CONST_U4: 0x0E0F5C41,
  BF1_CONST_U5: 0x0F5C4123,
  BF1_START: 0x23000000, BF1_END: 0x24000000,
  BF2_START: 0xF3000000, BF2_END: 0xF4000000,
  bf1KeySchedule: [0x4A434915, 0xD6743C2B, 0x1F29D308, 0xE6B79A64],
  bf2KeySchedule: [0x4039C240, 0xEDA92CAB, 0x4306C02A, 0x02192A04],

  /** psa_crypto_setup_byte_buffer: key1 big-endian into buffer[0..7], the low 16 bits of key2 into buffer[8..9]. */
  setupByteBuffer(buffer: number[], key1Low: number, key1High: number, key2Low: number): void {
    for (let i = 0; i < 8; i++) {
      const shift = i * 8;
      buffer[7 - i] = shift < 32 ? (key1Low >>> shift) & 0xFF : (key1High >>> (shift - 32)) & 0xFF;
    }
    buffer[9] = key2Low & 0xFF;
    buffer[8] = (key2Low >>> 8) & 0xFF;
  },

  /** psa_crypto_prepare_tea_data */
  prepareTeaData(b: number[]): [number, number] {
    const w0 = ((b[3] << 16) | (b[2] << 24) | (b[4] << 8) | b[5]) >>> 0;
    const w1 = ((b[7] << 16) | (b[6] << 24) | (b[8] << 8) | b[9]) >>> 0;
    return [w0, w1];
  },

  /** psa_crypto_tea_crc: the byte sum of v0 and the top three bytes of v1. */
  teaCrc(v0: number, v1: number): number {
    let crc = ((v0 >>> 24) & 0xFF) + ((v0 >>> 16) & 0xFF) + ((v0 >>> 8) & 0xFF) + (v0 & 0xFF);
    crc += ((v1 >>> 24) & 0xFF) + ((v1 >>> 16) & 0xFF) + ((v1 >>> 8) & 0xFF);
    return crc & 0xFF;
  },

  /** psa_crypto_crc16_bf2: CRC-16 poly 0x8005, init 0. */
  crc16Bf2(buffer: number[], length: number): number {
    let crc = 0;
    for (let i = 0; i < length; i++) {
      crc ^= buffer[i] << 8;
      for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc;
  },

  /** psa_crypto_unpack_tea_result_to_buffer */
  unpackTeaResult(b: number[], v0: number, v1: number): void {
    b[2] = (v0 >>> 24) & 0xFF; b[3] = (v0 >>> 16) & 0xFF; b[4] = (v0 >>> 8) & 0xFF; b[5] = v0 & 0xFF;
    b[6] = (v1 >>> 24) & 0xFF; b[7] = (v1 >>> 16) & 0xFF; b[8] = (v1 >>> 8) & 0xFF; b[9] = v1 & 0xFF;
  },
};
