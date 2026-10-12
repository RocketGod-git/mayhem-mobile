/** ACARS receiver (Mayhem proc_acars / acars_app, decision after acarsdec; port of core/apps/AcarsDecoder.kt). */
import { BitSync, type Emit, type IqProcessor } from './core.js';

const SYNC = 0x161601, STX = 0x02, ETX = 0x03, ETB = 0x17;

export class AcarsDecoder implements IqProcessor {
  private dec1 = 41; private accI = 0; private accQ = 0; private accN = 0;
  private envDc = 0; private env4 = 0; private env4n = 0;
  private fs = 12195; private ph = 0; private phInc = 0;
  private lpI = 0; private lpQ = 0; private pI = 0; private pQ = 0; private bI = 0; private bQ = 0;
  private mfI = new Float32Array(5); private mfQ = new Float32Array(5); private mfPos = 0; private mfSumI = 0; private mfSumQ = 0;
  private sync = new BitSync(2400, 12195);
  private window = 0; private collecting = false; private polarity = 0;
  private byte = 0; private nBits = 0;
  private readonly bytes = new Uint8Array(300); private count = 0; private parityErrors = 0;
  private crcBytes = 0; private crcHi = 0; private crcLo = 0; private inCrc = false;

  constructor(private readonly emit: Emit) {}

  reset(rate: number): void {
    this.dec1 = Math.max(1, Math.floor(rate / 48000));
    this.fs = rate / this.dec1 / 4;
    this.phInc = 2 * Math.PI * 1800 / this.fs;
    this.sync = new BitSync(2400, this.fs);
    const mfLen = Math.max(2, Math.round(this.fs / 2400));
    this.mfI = new Float32Array(mfLen); this.mfQ = new Float32Array(mfLen); this.mfPos = 0; this.mfSumI = 0; this.mfSumQ = 0;
    this.accI = this.accQ = this.accN = 0; this.env4 = 0; this.env4n = 0; this.lpI = this.lpQ = this.pI = this.pQ = 0;
    this.collecting = false; this.window = 0; this.nBits = 0; this.byte = 0; this.count = 0;
  }

  onIq(iq: Int8Array): void {
    const nSamp = iq.length >> 1;
    for (let i = 0; i < nSamp; i++) {
      this.accI += iq[2 * i]; this.accQ += iq[2 * i + 1];
      if (++this.accN < this.dec1) continue;
      const ci = this.accI / this.accN, cq = this.accQ / this.accN; this.accI = this.accQ = 0; this.accN = 0;
      const env = Math.sqrt(ci * ci + cq * cq);
      this.envDc += 0.002 * (env - this.envDc);
      this.env4 += env - this.envDc;
      if (++this.env4n < 4) continue;
      const a = this.env4 / 4; this.env4 = 0; this.env4n = 0;
      this.audio(a);
    }
  }

  private audio(a: number): void {
    this.ph += this.phInc; if (this.ph > 2 * Math.PI) this.ph -= 2 * Math.PI;
    const mi = a * Math.cos(this.ph), mq = -a * Math.sin(this.ph);
    this.mfSumI += mi - this.mfI[this.mfPos]; this.mfSumQ += mq - this.mfQ[this.mfPos];
    this.mfI[this.mfPos] = mi; this.mfQ[this.mfPos] = mq; if (++this.mfPos >= this.mfI.length) this.mfPos = 0;
    this.lpI = this.mfSumI; this.lpQ = this.mfSumQ;
    const f = this.lpQ * this.pI - this.lpI * this.pQ;
    this.pI = this.lpI; this.pQ = this.lpQ;
    if (this.sync.push(f) >= 0) {
      const step = this.lpQ * this.bI - this.lpI * this.bQ;
      this.bI = this.lpI; this.bQ = this.lpQ;
      this.onBit(step > 0 ? 1 : 0);
    }
  }

  private lsbFirst3(w: number): number {
    let out = 0;
    for (let k = 0; k < 3; k++) { let b = 0; for (let i = 0; i < 8; i++) b |= ((w >>> (23 - (k * 8 + i))) & 1) << i; out = (out << 8) | b; }
    return out;
  }

  private start(polarity: number): void { this.collecting = true; this.polarity = polarity; this.nBits = 0; this.byte = 0; this.count = 0; this.parityErrors = 0; this.inCrc = false; this.crcBytes = 0; }

  private onBit(raw: number): void {
    if (!this.collecting) {
      this.window = ((this.window << 1) | raw) & 0xFFFFFF;
      if (this.lsbFirst3(this.window) === SYNC) this.start(0);
      else if (this.lsbFirst3(~this.window & 0xFFFFFF) === SYNC) this.start(1);
      return;
    }
    const bit = raw ^ this.polarity;
    this.byte |= bit << this.nBits;
    if (++this.nBits < 8) return;
    const b = this.byte; this.byte = 0; this.nBits = 0;
    if (this.inCrc) {
      if (this.crcBytes === 0) { this.crcHi = b; this.crcBytes = 1; return; }
      this.crcLo = b; this.finish(); return;
    }
    let ones = 0; for (let i = 0; i < 8; i++) ones += (b >> i) & 1;
    if (ones % 2 === 0 && ++this.parityErrors > 4) { this.collecting = false; this.window = 0; return; }
    const ch = b & 0x7f;
    this.bytes[this.count++] = ch;
    if (ch === ETX || ch === ETB) { this.inCrc = true; this.crcBytes = 0; return; }
    if (this.count >= this.bytes.length) { this.collecting = false; this.window = 0; }
  }

  private crcOk(n: number): boolean {
    let crc = 0;
    for (let i = 0; i < n; i++) { crc ^= this.bytes[i] << 8; for (let k = 0; k < 8; k++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
    const rx1 = (this.crcHi << 8) | this.crcLo, rx2 = (this.crcLo << 8) | this.crcHi;
    if (crc === rx1 || crc === rx2) return true;
    let r = 0;
    for (let i = 0; i < n; i++) { let v = this.bytes[i]; for (let k = 0; k < 8; k++) { const lsb = (r ^ v) & 1; r >>>= 1; if (lsb) r ^= 0x8408; v >>>= 1; } }
    return r === rx1 || r === rx2;
  }

  private finish(): void {
    this.collecting = false; this.window = 0;
    const n = this.count, B = this.bytes;
    if (n < 13) return;
    const ok = this.crcOk(n);
    const ch = (i: number) => String.fromCharCode(B[i]);
    const mode = ch(0);
    let reg = ''; for (let i = 1; i <= 7; i++) reg += ch(i); reg = reg.replace(/^[. ]+|[. ]+$/g, '');
    const ack = B[8] === 0x15 ? 'NAK' : ch(8);
    const label = ch(9) + (B[10] === 0x7f ? 'd' : ch(10));
    const blk = ch(11);
    const down = blk >= '0' && blk <= '9';
    let p = 12, msn = '', flight = '';
    if (B[p] === STX) {
      p++;
      if (down && n - p >= 11) { for (let i = 0; i < 4; i++) msn += ch(p + i); for (let i = 4; i < 10; i++) flight += ch(p + i); flight = flight.trim(); p += 10; }
    }
    let text = '';
    while (p < n) { const c = B[p++]; if (c === ETX || c === ETB) break; text += (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : (c === 0x0a || c === 0x0d) ? ' ' : '·'; }
    const head = `ACARS ${down ? '↓' : '↑'} ${reg}  ${label}  blk ${blk}  ack ${ack}${msn ? `  #${msn} ${flight}` : ''}${ok ? '' : '  CRC?'}${mode !== '2' ? `  mode ${mode}` : ''}`;
    const body = text.trim();
    this.emit({ type: 'packet', line: body ? `${head}\n${body}` : head });
  }
}
