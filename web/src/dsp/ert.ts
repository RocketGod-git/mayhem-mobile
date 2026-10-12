/** ERT utility-meter receiver (Mayhem proc_ert / rtlamr; port of core/apps/ErtDecoder.kt). */
import type { Emit, IqProcessor } from './core.js';

const TYPE_NONE = 0, TYPE_SCM = 1, TYPE_PLUS = 2;

export class ErtDecoder implements IqProcessor {
  private spb = 61;
  private phase = 0;
  private hSum = 0; private h1 = 0;
  private envMax = 10; private envMin = 0;
  private lastAbove = false;
  private dcI = 0; private dcQ = 0;
  private bits = 0;
  private collecting = TYPE_NONE;
  private idmCandidate = false;
  private readonly buf = new Uint8Array(704);
  private count = 0;

  constructor(private readonly emit: Emit) {}

  reset(rate: number): void {
    this.spb = rate / 32768;
    this.phase = 0; this.hSum = 0; this.h1 = 0; this.envMax = 10; this.envMin = 0; this.lastAbove = false;
    this.bits = 0; this.collecting = TYPE_NONE; this.count = 0;
  }

  onIq(iq: Int8Array): void {
    const nSamp = iq.length >> 1;
    let sI = 0, sQ = 0;
    for (let i = 0; i < nSamp; i++) { sI += iq[2 * i]; sQ += iq[2 * i + 1]; }
    this.dcI += 0.2 * (sI / nSamp - this.dcI); this.dcQ += 0.2 * (sQ / nSamp - this.dcQ);
    const inc = 1 / this.spb;
    for (let i = 0; i < nSamp; i++) {
      const iv = iq[2 * i] - this.dcI, qv = iq[2 * i + 1] - this.dcQ;
      const mag = Math.sqrt(iv * iv + qv * qv);
      if (mag > this.envMax) this.envMax = mag; else this.envMax += (mag - this.envMax) * 0.0005;
      if (mag < this.envMin) this.envMin = mag; else this.envMin += (mag - this.envMin) * 0.0005;
      const above = mag > (this.envMax + this.envMin) * 0.5;
      if (above !== this.lastAbove) {
        const target = (this.phase < 0.25 || this.phase >= 0.75) ? 0 : 0.5;
        let err = this.phase - target;
        if (err > 0.5) err -= 1;
        this.phase -= err * 0.15;
        if (this.phase < 0) this.phase += 1;
      }
      this.lastAbove = above;
      this.hSum += mag;
      const before = this.phase;
      this.phase += inc;
      if (before < 0.5 && this.phase >= 0.5) { this.h1 = this.hSum; this.hSum = 0; }
      if (this.phase >= 1) {
        this.phase -= 1;
        const h2 = this.hSum; this.hSum = 0;
        this.onSymbol(this.h1 > h2 ? 1 : 0);
      }
    }
  }

  private onSymbol(bit: number): void {
    if (this.collecting === TYPE_NONE) {
      this.bits = ((this.bits << 1) | bit) >>> 0;
      if ((this.bits & 0x1FFFFF) === 0x1F2A60) { this.collecting = TYPE_SCM; this.count = 0; }
      else if ((this.bits & 0xFFFF) === 0x16A3) { this.collecting = TYPE_PLUS; this.count = 0; this.idmCandidate = (this.bits >>> 16) === 0x5555; }
      return;
    }
    this.buf[this.count++] = bit;
    if (this.collecting === TYPE_SCM) {
      if (this.count >= 75) { this.checkScm(); this.collecting = TYPE_NONE; this.bits = 0; }
    } else if (this.count === 112 && this.checkScmPlus()) { this.collecting = TYPE_NONE; this.bits = 0; }
    else if (this.count >= 704) { if (this.idmCandidate) this.checkIdm(); this.collecting = TYPE_NONE; this.bits = 0; }
  }

  private rd(start: number, len: number): number { let v = 0; for (let i = 0; i < len; i++) v = v * 2 + this.buf[start + i]; return v; }
  private crc16(n: number, poly: number, init: number): number {
    let crc = init;
    for (let i = 0; i < n; i++) {
      const msb = (crc >> 15) & 1;
      crc = (crc << 1) & 0xFFFF;
      if (msb ^ this.buf[i]) crc ^= poly;
    }
    return crc & 0xFFFF;
  }
  private checkScm(): void {
    if (this.crc16(75, 0x6F63, 0) !== 0) return;
    const id = this.rd(0, 2) * 16777216 + this.rd(35, 24);
    this.emit({ type: 'packet', line: `SCM  ID ${String(id).padEnd(10)} ${ErtDecoder.commodity(this.rd(5, 4)).padEnd(8)} cons ${this.rd(11, 24)} tamper p${this.rd(3, 2)}/e${this.rd(9, 2)}` });
  }
  private checkScmPlus(): boolean {
    if (this.crc16(112, 0x1021, 0xFFFF) !== 0x1D0F) return false;
    this.emit({ type: 'packet', line: `SCM+ ID ${String(this.rd(16, 32)).padEnd(10)} ${ErtDecoder.commodity(this.rd(12, 4)).padEnd(8)} cons ${this.rd(48, 32)} tamper 0x${this.rd(80, 16).toString(16).padStart(4, '0')}` });
    return true;
  }
  private checkIdm(): void {
    if (this.crc16(704, 0x1021, 0xFFFF) !== 0x1D0F) return;
    this.emit({ type: 'packet', line: `IDM  ID ${String(this.rd(40, 32)).padEnd(10)} ${ErtDecoder.commodity(this.rd(36, 4)).padEnd(8)} cons ${this.rd(200, 32)}` });
  }
  private static commodity(t: number): string {
    if ([4, 5, 7, 8].includes(t)) return 'electric';
    if ([2, 9, 12].includes(t)) return 'gas';
    if ([3, 11, 13].includes(t)) return 'water';
    return `type${t}`;
  }
}
