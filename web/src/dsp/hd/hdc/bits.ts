/** MSB-first bit reader over one HDC packet. */
export class Bits {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end = buf.length * 8) {}
  get left(): number { return this.end - this.pos; }
  bit(): number {
    if (this.pos >= this.end) throw new RangeError('HDC packet overrun');
    const b = (this.buf[this.pos >> 3] >> (7 - (this.pos & 7))) & 1; this.pos++; return b;
  }
  read(n: number): number { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.bit(); return v >>> 0; }
  peek(n: number): number { const p = this.pos; const v = this.read(Math.min(n, this.left)) << Math.max(0, n - this.left); this.pos = p; return v; }
  skip(n: number): void { this.pos += n; if (this.pos > this.end) throw new RangeError('HDC packet overrun'); }
}
