/** BLE advertising receiver (Mayhem proc_btlerx; port of core/apps/BtleDecoder.kt). */
import type { Emit, IqProcessor } from './core.js';

const ACCESS_ADDRESS = 0x8E89BED6;
const PDU_TYPES = ['ADV_IND', 'ADV_DIRECT_IND', 'ADV_NONCONN_IND', 'SCAN_REQ', 'SCAN_RSP', 'CONNECT_REQ', 'ADV_SCAN_IND'];
export function btleChannelFreq(ch: number): number { return ch === 37 ? 2_402_000_000 : ch === 38 ? 2_426_000_000 : 2_480_000_000; }

export class BtleDecoder implements IqProcessor {
  channel = 37;
  private sps = 2;
  private dcI = 0; private dcQ = 0;
  private prevI = 0; private prevQ = 0;
  private dRing = new Float32Array(2); private dIdx = 0; private dSum = 0;
  private regs = new Uint32Array(2);
  private state = 0;
  private sampCount = 0; private acc = 0;
  private readonly pdu = new Uint8Array(48);
  private byteIdx = 0; private bitIdx = 0; private need = 2;
  private lfsr = 0; private crcA = 0; private crcB = 0;
  private pktMaxMag = 0; private bufMaxMag = 0;

  constructor(private readonly emit: Emit) {}

  reset(rate: number): void {
    this.sps = Math.max(1, Math.floor(rate / 1_000_000));
    this.dRing = new Float32Array(this.sps); this.dIdx = 0; this.dSum = 0;
    this.regs = new Uint32Array(this.sps);
    this.state = 0; this.sampCount = 0; this.acc = 0;
  }

  onIq(iq: Int8Array): void {
    const nSamp = iq.length >> 1;
    let sI = 0, sQ = 0; this.bufMaxMag = 0;
    for (let i = 0; i < nSamp; i++) {
      const a = iq[2 * i], b = iq[2 * i + 1];
      sI += a; sQ += b;
      const mm = Math.max(Math.abs(a), Math.abs(b));
      if (mm > this.bufMaxMag) this.bufMaxMag = mm;
    }
    this.dcI += 0.2 * (sI / nSamp - this.dcI); this.dcQ += 0.2 * (sQ / nSamp - this.dcQ);
    for (let i = 0; i < nSamp; i++) {
      const iv = iq[2 * i] - this.dcI, qv = iq[2 * i + 1] - this.dcQ;
      const d = qv * this.prevI - iv * this.prevQ;
      this.prevI = iv; this.prevQ = qv;
      if (this.state === 0) {
        this.dSum += d - this.dRing[this.dIdx]; this.dRing[this.dIdx] = d;
        const bit = this.dSum > 0 ? 1 : 0;
        this.regs[this.dIdx] = ((this.regs[this.dIdx] >>> 1) | (bit << 31)) >>> 0;
        if (this.regs[this.dIdx] === ACCESS_ADDRESS) {
          this.state = 1; this.sampCount = 0; this.acc = 0; this.byteIdx = 0; this.bitIdx = 0; this.need = 2;
          this.pdu.fill(0);
          this.lfsr = 0x40 | this.channel;
          this.crcA = 0x555555; this.crcB = 0xAAAAAA;
          this.pktMaxMag = this.bufMaxMag;
          this.regs.fill(0);
        }
        this.dIdx = this.dIdx + 1 >= this.sps ? 0 : this.dIdx + 1;
      } else {
        this.acc += d;
        if (++this.sampCount >= this.sps) {
          this.sampCount = 0;
          const raw = this.acc > 0 ? 1 : 0;
          this.acc = 0;
          this.onBit(raw ^ this.whitenBit());
        }
      }
    }
  }

  private whitenBit(): number {
    const o = this.lfsr & 1;
    this.lfsr = (this.lfsr >>> 1) | (o << 6);
    if (o === 1) this.lfsr ^= 0x04;
    return o;
  }
  private static crcStep(crc: number, bit: number): number {
    const fb = ((crc >> 23) & 1) ^ bit;
    let c = (crc << 1) & 0xFFFFFF;
    if (fb === 1) c ^= 0x00065B;
    return c;
  }
  private onBit(bit: number): void {
    this.crcA = BtleDecoder.crcStep(this.crcA, bit); this.crcB = BtleDecoder.crcStep(this.crcB, bit);
    this.pdu[this.byteIdx] |= bit << this.bitIdx;
    if (++this.bitIdx < 8) return;
    this.bitIdx = 0; this.byteIdx++;
    if (this.byteIdx === 2) {
      const len = this.pdu[1] & 0x3F;
      if (len < 6 || len > 37) { this.state = 0; return; }
      this.need = 2 + len + 3;
    }
    if (this.byteIdx >= this.need) {
      if (this.crcA === 0 || this.crcB === 0) this.report(this.need - 5);
      this.state = 0;
    }
  }

  private report(payloadLen: number): void {
    const p = this.pdu;
    const type = p[0] & 0x0F, txAdd = (p[0] & 0x40) !== 0;
    const mac = [7, 6, 5, 4, 3, 2].map(i => p[i].toString(16).padStart(2, '0').toUpperCase()).join(':');
    const db = 20 * Math.log10(this.pktMaxMag / 128 + 1e-6);
    let s = `${(PDU_TYPES[type] ?? `PDU${type}`).padEnd(15)} ${mac} ${txAdd ? 'rnd' : 'pub'} ${db.toFixed(0).padStart(4)}dB`;
    let q = 8;
    const end = 2 + payloadLen;
    if (type === 0 || type === 2 || type === 4 || type === 6) {
      while (q < end) {
        const l = p[q];
        if (l === 0 || q + 1 + l > end) break;
        const ad = p[q + 1], ds = q + 2, dl = l - 1;
        const u16 = () => ((p[ds + 1] << 8) | p[ds]).toString(16).padStart(4, '0');
        switch (ad) {
          case 0x08: case 0x09: s += ` name '${String.fromCharCode(...p.subarray(ds, ds + dl))}'`; break;
          case 0x01: s += ` flags 0x${p[ds].toString(16).padStart(2, '0')}`; break;
          case 0xFF: if (dl >= 2) s += ` mfr 0x${u16()}`; break;
          case 0x02: case 0x03: if (dl >= 2) s += ` uuid16 0x${u16()}`; break;
          case 0x16: if (dl >= 2) s += ` svc 0x${u16()}`; break;
          case 0x0A: if (dl >= 1) s += ` tx ${(p[ds] << 24) >> 24}dBm`; break;
          default: s += ` ad${ad.toString(16).padStart(2, '0')}[${dl}]`;
        }
        q += 1 + l;
      }
    }
    this.emit({ type: 'packet', line: s });
  }
}
