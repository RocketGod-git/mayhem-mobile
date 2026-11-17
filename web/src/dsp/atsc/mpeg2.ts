/**
 * MPEG-2 video (ITU-T H.262) intra pictures to small RGBA stills: sequence and picture headers and their extensions,
 * slices, intra macroblocks and blocks (Annex B VLC tables), DC prediction, inverse scan and quantization with
 * mismatch control, and an IDCT reduced to the still's size (each 8x8 block averaged down to s x s pixels).
 * Slices that cross a lost packet are skipped; the still keeps the rows it had before.
 */

const B1 = '1 1|011 2|010 3|0011 4|0010 5|00011 6|00010 7|0000111 8|0000110 9|00001011 10|00001010 11|00001001 12|00001000 13|00000111 14|00000110 15|0000010111 16|0000010110 17|0000010101 18|0000010100 19|0000010011 20|0000010010 21|00000100011 22|00000100010 23|00000100001 24|00000100000 25|00000011111 26|00000011110 27|00000011101 28|00000011100 29|00000011011 30|00000011010 31|00000011001 32|00000011000 33|00000001000 34';
const B12 = '100 0|00 1|01 2|101 3|110 4|1110 5|11110 6|111110 7|1111110 8|11111110 9|111111110 10|111111111 11';
const B13 = '00 0|01 1|10 2|110 3|1110 4|11110 5|111110 6|1111110 7|11111110 8|111111110 9|1111111110 10|1111111111 11';
const B14 = '10 EOB|11 0 1|011 1 1|0100 0 2|0101 2 1|00101 0 3|00111 3 1|00110 4 1|000110 1 2|000111 5 1|000101 6 1|000100 7 1|0000110 0 4|0000100 2 2|0000111 8 1|0000101 9 1|000001 ESC|00100110 0 5|00100001 0 6|00100101 1 3|00100100 3 2|00100111 10 1|00100011 11 1|00100010 12 1|00100000 13 1|0000001010 0 7|0000001100 1 4|0000001011 2 3|0000001111 4 2|0000001001 5 2|0000001110 14 1|0000001101 15 1|0000001000 16 1|000000011101 0 8|000000011000 0 9|000000010011 0 10|000000010000 0 11|000000011011 1 5|000000010100 2 4|000000011100 3 3|000000010010 4 3|000000011110 6 2|000000010101 7 2|000000010001 8 2|000000011111 17 1|000000011010 18 1|000000011001 19 1|000000010111 20 1|000000010110 21 1|0000000011010 0 12|0000000011001 0 13|0000000011000 0 14|0000000010111 0 15|0000000010110 1 6|0000000010101 1 7|0000000010100 2 5|0000000010011 3 4|0000000010010 5 3|0000000010001 9 2|0000000010000 10 2|0000000011111 22 1|0000000011110 23 1|0000000011101 24 1|0000000011100 25 1|0000000011011 26 1|00000000011111 0 16|00000000011110 0 17|00000000011101 0 18|00000000011100 0 19|00000000011011 0 20|00000000011010 0 21|00000000011001 0 22|00000000011000 0 23|00000000010111 0 24|00000000010110 0 25|00000000010101 0 26|00000000010100 0 27|00000000010011 0 28|00000000010010 0 29|00000000010001 0 30|00000000010000 0 31|000000000011000 0 32|000000000010111 0 33|000000000010110 0 34|000000000010101 0 35|000000000010100 0 36|000000000010011 0 37|000000000010010 0 38|000000000010001 0 39|000000000010000 0 40|000000000011111 1 8|000000000011110 1 9|000000000011101 1 10|000000000011100 1 11|000000000011011 1 12|000000000011010 1 13|000000000011001 1 14|0000000000010011 1 15|0000000000010010 1 16|0000000000010001 1 17|0000000000010000 1 18|0000000000010100 6 3|0000000000011010 11 2|0000000000011001 12 2|0000000000011000 13 2|0000000000010111 14 2|0000000000010110 15 2|0000000000010101 16 2|0000000000011111 27 1|0000000000011110 28 1|0000000000011101 29 1|0000000000011100 30 1|0000000000011011 31 1';
const B15 = '0110 EOB|10 0 1|010 1 1|110 0 2|00101 2 1|0111 0 3|00111 3 1|000110 4 1|00110 1 2|000111 5 1|0000110 6 1|0000100 7 1|11100 0 4|0000111 2 2|0000101 8 1|1111000 9 1|000001 ESC|11101 0 5|000101 0 6|1111001 1 3|00100110 3 2|1111010 10 1|00100001 11 1|00100101 12 1|00100100 13 1|000100 0 7|00100111 1 4|11111100 2 3|11111101 4 2|000000100 5 2|000000101 14 1|000000111 15 1|0000001101 16 1|1111011 0 8|1111100 0 9|00100011 0 10|00100010 0 11|00100000 1 5|0000001100 2 4|000000011100 3 3|000000010010 4 3|000000011110 6 2|000000010101 7 2|000000010001 8 2|000000011111 17 1|000000011010 18 1|000000011001 19 1|000000010111 20 1|000000010110 21 1|11111010 0 12|11111011 0 13|11111110 0 14|11111111 0 15|0000000010110 1 6|0000000010101 1 7|0000000010100 2 5|0000000010011 3 4|0000000010010 5 3|0000000010001 9 2|0000000010000 10 2|0000000011111 22 1|0000000011110 23 1|0000000011101 24 1|0000000011100 25 1|0000000011011 26 1|00000000011111 0 16|00000000011110 0 17|00000000011101 0 18|00000000011100 0 19|00000000011011 0 20|00000000011010 0 21|00000000011001 0 22|00000000011000 0 23|00000000010111 0 24|00000000010110 0 25|00000000010101 0 26|00000000010100 0 27|00000000010011 0 28|00000000010010 0 29|00000000010001 0 30|00000000010000 0 31|000000000011000 0 32|000000000010111 0 33|000000000010110 0 34|000000000010101 0 35|000000000010100 0 36|000000000010011 0 37|000000000010010 0 38|000000000010001 0 39|000000000010000 0 40|000000000011111 1 8|000000000011110 1 9|000000000011101 1 10|000000000011100 1 11|000000000011011 1 12|000000000011010 1 13|000000000011001 1 14|0000000000010011 1 15|0000000000010010 1 16|0000000000010001 1 17|0000000000010000 1 18|0000000000010100 6 3|0000000000011010 11 2|0000000000011001 12 2|0000000000011000 13 2|0000000000010111 14 2|0000000000010110 15 2|0000000000010101 16 2|0000000000011111 27 1|0000000000011110 28 1|0000000000011101 29 1|0000000000011100 30 1|0000000000011011 31 1';
/** The VLC tables as text (code, then run and level, or EOB / ESC), for the tests' own encoder. */
export const VLC = { B1, B12, B13, B14, B15 };

/** Zigzag and alternate scans, Fig 7-2 / 7-3: scan[v][u] = n. */
export const SCAN0 = [0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53, 10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63];
export const SCAN1 = [0, 4, 6, 20, 22, 36, 38, 52, 1, 5, 7, 21, 23, 37, 39, 53, 2, 8, 19, 24, 34, 40, 50, 54, 3, 9, 18, 25, 35, 41, 51, 55, 10, 17, 26, 30, 42, 46, 56, 60, 11, 16, 27, 31, 43, 47, 57, 61, 12, 15, 28, 32, 44, 48, 58, 62, 13, 14, 29, 33, 45, 49, 59, 63];
/** Default intra matrix (6.3.11), raster order. */
export const W_INTRA = [8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38, 22, 22, 26, 27, 29, 34, 37, 40, 22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58, 26, 27, 29, 34, 38, 46, 56, 69, 27, 29, 35, 38, 46, 56, 69, 83];
const QS = [[0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 96, 104, 112]];
/** Raster position of coefficient n in each scan. */
const INV = [SCAN0, SCAN1].map(sc => { const o = new Int32Array(64); for (let i = 0; i < 64; i++) o[sc[i]] = i; return o; });

// LUT entries: length | value << 5 (B1, B12, B13); coefficient tables: length | run << 5 | level << 11 | kind << 18 (1 EOB, 2 ESC)
function lut(spec: string, bits: number, coef: boolean): Int32Array {
  const t = new Int32Array(1 << bits);
  for (const ent of spec.split('|')) {
    const [code, a, b] = ent.trim().split(' ');
    const L = code.length, base = parseInt(code, 2) << (bits - L);
    let v: number;
    if (!coef) v = L | (Number(a) << 5);
    else if (a === 'EOB') v = L | (1 << 18);
    else if (a === 'ESC') v = L | (2 << 18);
    else v = (L + 1) | (Number(a) << 5) | (Number(b) << 11);
    for (let k = 0; k < 1 << (bits - L); k++) t[base + k] = v;
  }
  return t;
}
let LUTS: { b1: Int32Array; b12: Int32Array; b13: Int32Array; b14: Int32Array; b15: Int32Array } | null = null;
function luts() { return (LUTS ??= { b1: lut(B1, 11, false), b12: lut(B12, 9, false), b13: lut(B13, 10, false), b14: lut(B14, 17, true), b15: lut(B15, 17, true) }); }

class Bits {
  p: number; readonly n: number;
  constructor(private readonly d: Uint8Array, from: number, to: number) { this.p = from * 8; this.n = to * 8; }
  peek(k: number): number {
    const i = this.p >> 3, d = this.d;
    const v = (((d[i] ?? 0) << 24) | ((d[i + 1] ?? 0) << 16) | ((d[i + 2] ?? 0) << 8) | (d[i + 3] ?? 0)) >>> 0;
    const s = this.p & 7;
    const w = s ? ((v << s) | ((d[i + 4] ?? 0) >>> (8 - s))) >>> 0 : v;
    return w >>> (32 - k);
  }
  get(k: number): number { const v = this.peek(k); this.p += k; return v; }
}

export interface SeqInfo { width: number; height: number; aspect: number; frameRate: number; bitRate: number; progressive: boolean; chroma: number; profileLevel: number; intraMatrix: boolean }
export interface PicInfo { type: number; temporalRef: number; structure: number; topFirst: boolean; framePredDct: boolean; concealment: boolean; qScaleType: number; intraVlc: number; altScan: number; dcPrecision: number; progressiveFrame: boolean }
export interface Still { width: number; height: number; rgba: Uint8ClampedArray; dar: number; seq: SeqInfo; pic: PicInfo; mbs: number; mbsTotal: number; slices: number; badSlices: number; complete: boolean }

const FRAME_RATES = [0, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];
const DARS = [0, 1, 4 / 3, 16 / 9, 2.21];

/** Average-down IDCT matrices: R[s][i*8+u] gives pixel row i of an s x s block from coefficient row u. */
const RED = new Map<number, Float32Array>();
function reduce(s: number): Float32Array {
  const have = RED.get(s); if (have) return have;
  const m = new Float32Array(s * 8), box = 8 / s;
  for (let i = 0; i < s; i++) for (let u = 0; u < 8; u++) {
    let a = 0;
    for (let x = i * box; x < (i + 1) * box; x++) a += (u === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * x + 1) * u * Math.PI / 16) / 2;
    m[i * 8 + u] = a / box;
  }
  RED.set(s, m); return m;
}

/** Decodes MPEG-2 video elementary-stream units (a PES payload each) and makes stills of the intra pictures. */
export class StillDecoder {
  seq: SeqInfo | null = null;
  private seqRaw: { h: number; v: number; aspect: number; rate: number; br: number; matrix: Int32Array } | null = null;
  private ext: { progressive: boolean; chroma: number; hx: number; vx: number; brx: number; pl: number; fn: number; fd: number } | null = null;
  /** Reduced planes of the last still (kept for compositing a damaged picture over it). */
  private y: Uint8Array | null = null; private cb: Uint8Array | null = null; private cr: Uint8Array | null = null;
  private key = '';
  pictures = 0; iPictures = 0; gop = '';
  /** Maximum still width in pixels; each 8x8 block is averaged to s x s with s a power of two that fits. */
  constructor(private readonly maxWidth = 480) {}

  /** One PES payload; `holes` are byte offsets where packets were lost. Returns a still when an I picture decodes. */
  unit(es: Uint8Array, holes: number[] = [], wantStill = true): Still | null {
    const codes: [number, number][] = [];
    for (let i = 0; i + 3 < es.length; i++) {
      if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1) { codes.push([i, es[i + 3]]); i += 3; }
    }
    let pic: PicInfo | null = null, matrix: Int32Array | null = null;
    const slices: [number, number, number][] = [];
    let out: Still | null = null;
    const flush = () => {
      if (pic && pic.type === 1 && slices.length && wantStill && this.seq && this.seqRaw && this.ext) out = this.decode(es, slices, pic, matrix ?? this.seqRaw.matrix, holes) ?? out;
      slices.length = 0;
    };
    for (let k = 0; k < codes.length; k++) {
      const [off, code] = codes[k], end = k + 1 < codes.length ? codes[k + 1][0] : es.length;
      const b = new Bits(es, off + 4, end);
      if (code === 0xb3) {
        flush(); pic = null;
        const h = b.get(12), v = b.get(12), aspect = b.get(4), rate = b.get(4), br = b.get(18); b.get(1); b.get(10); b.get(1);
        const mat = Int32Array.from(W_INTRA);
        if (b.get(1)) for (let i = 0; i < 64; i++) mat[INV[0][i]] = b.get(8);
        this.seqRaw = { h, v, aspect, rate, br, matrix: mat };
        this.refreshSeq();
      } else if (code === 0xb5) {
        const id = b.get(4);
        if (id === 1) {
          const pl = b.get(8), progressive = b.get(1) === 1, chroma = b.get(2), hx = b.get(2), vx = b.get(2), brx = b.get(12); b.get(1); b.get(8); b.get(1);
          const fn = b.get(2), fd = b.get(5);
          this.ext = { progressive, chroma, hx, vx, brx, pl, fn, fd };
          this.refreshSeq();
        } else if (id === 8 && pic) {
          b.get(16);
          pic.dcPrecision = b.get(2); pic.structure = b.get(2); pic.topFirst = b.get(1) === 1; pic.framePredDct = b.get(1) === 1; pic.concealment = b.get(1) === 1;
          pic.qScaleType = b.get(1); pic.intraVlc = b.get(1); pic.altScan = b.get(1); b.get(1); b.get(1); pic.progressiveFrame = b.get(1) === 1;
        } else if (id === 3 && pic) {
          if (b.get(1)) { matrix = new Int32Array(64); for (let i = 0; i < 64; i++) matrix[INV[0][i]] = b.get(8); }
        }
      } else if (code === 0x00) {
        flush();
        const tr = b.get(10), type = b.get(3);
        pic = { type, temporalRef: tr, structure: 3, topFirst: true, framePredDct: true, concealment: false, qScaleType: 0, intraVlc: 0, altScan: 0, dcPrecision: 0, progressiveFrame: true };
        matrix = null;
        this.pictures++; if (type === 1) this.iPictures++;
        this.gop = (this.gop + ' IPB?'[Math.min(4, type)]).slice(-30);
      } else if (code >= 0x01 && code <= 0xaf && pic) slices.push([off, code, end]);
    }
    flush();
    return out;
  }

  private refreshSeq(): void {
    const s = this.seqRaw, x = this.ext; if (!s) return;
    const w = s.h | ((x?.hx ?? 0) << 12), h = s.v | ((x?.vx ?? 0) << 12);
    this.seq = { width: w, height: h, aspect: s.aspect, frameRate: (FRAME_RATES[s.rate] ?? 0) * ((x?.fn ?? 0) + 1) / ((x?.fd ?? 0) + 1), bitRate: (s.br | ((x?.brx ?? 0) << 18)) * 400,
      progressive: x?.progressive ?? true, chroma: x?.chroma ?? 1, profileLevel: x?.pl ?? 0, intraMatrix: s.matrix.some((v, i) => v !== W_INTRA[i]) };
  }

  private decode(es: Uint8Array, slices: [number, number, number][], pic: PicInfo, W: Int32Array, holes: number[]): Still | null {
    const seq = this.seq!, x = this.ext!;
    if (x.chroma !== 1 || pic.concealment) return null;
    const mbw = (seq.width + 15) >> 4;
    const mbh = x.progressive ? (seq.height + 15) >> 4 : 2 * ((seq.height + 31) >> 5);
    const field = pic.structure !== 3, mbhPic = field ? mbh >> 1 : mbh;
    let s = 8; while (s > 1 && mbw * 2 * s > this.maxWidth) s >>= 1;
    const yw = mbw * 2 * s, yh = mbhPic * 2 * s, cw = mbw * s, ch = mbhPic * s;
    const key = `${seq.width}x${seq.height}/${pic.structure}/${s}`;
    if (key !== this.key || !this.y) { this.key = key; this.y = new Uint8Array(yw * yh).fill(16); this.cb = new Uint8Array(cw * ch).fill(128); this.cr = new Uint8Array(cw * ch).fill(128); }
    const Y = this.y, CB = this.cb!, CR = this.cr!;
    const L = luts(), lutc = pic.intraVlc ? L.b15 : L.b14, inv = INV[pic.altScan], qs = QS[pic.qScaleType];
    const dcMult = [8, 4, 2, 1][pic.dcPrecision], dcReset = [128, 256, 512, 1024][pic.dcPrecision];
    const R = reduce(s), R8 = reduce(8);
    const F = new Int32Array(64), tmp = new Float32Array(64), blk = new Float32Array(6 * 64), full = new Float32Array(256);
    let mbs = 0, bad = 0;
    const nmb = mbw * mbhPic;
    for (const [off, code, end] of slices) {
      if (holes.some(h => h > off && h <= end)) { bad++; continue; }
      const b = new Bits(es, off + 4, end);
      const pred = [dcReset, dcReset, dcReset];
      const done: number[] = [];
      try {
        let qsc = b.get(5);
        if (b.peek(1)) { b.get(9); while (b.get(1)) b.get(8); } else b.get(1);
        let addr = (code - 1) * mbw - 1, first = true;
        for (;;) {
          if (b.p + 23 >= b.n || b.peek(23) === 0) break;
          let inc = 0;
          for (;;) { const v = L.b1[b.peek(11)]; if (!v) throw new Error('mb address'); b.p += v & 31; const val = v >> 5; if (val === 34) { inc += 33; continue; } inc += val; break; }
          if (inc > 1 && !first) pred[0] = pred[1] = pred[2] = dcReset;
          addr += inc; first = false;
          let quant = false;
          if (b.get(1) === 0) { if (b.get(1) !== 1) throw new Error('macroblock type'); quant = true; }
          const dct = !field && !pic.framePredDct ? b.get(1) : 0;
          if (quant) qsc = b.get(5);
          const qscale = qs[qsc];
          if (addr >= nmb || addr < 0) throw new Error('mb address');
          for (let bk = 0; bk < 6; bk++) {
            const cc = bk < 4 ? 0 : bk === 4 ? 1 : 2;
            F.fill(0);
            const dv = cc === 0 ? L.b12[b.peek(9)] : L.b13[b.peek(10)];
            if (!dv) throw new Error('dc size');
            b.p += dv & 31;
            const size = dv >> 5;
            let diff = 0;
            if (size) { const dd = b.get(size), half = 1 << (size - 1); diff = dd >= half ? dd : dd + 1 - 2 * half; }
            pred[cc] += diff;
            let n = 1, sum = 0;
            const dc = dcMult * pred[cc]; F[0] = dc; sum += dc;
            for (;;) {
              const v = lutc[b.peek(17)];
              if (!v) throw new Error('coefficient');
              const kind = v >> 18;
              if (kind === 1) { b.p += v & 31; break; }
              let run: number, level: number;
              if (kind === 2) {
                b.p += v & 31; run = b.get(6); level = b.get(12);
                if (level >= 2048) level -= 4096;
                if (level === 0 || level === -2048) throw new Error('escape');
              } else {
                const len = v & 31, sign = (b.peek(len) & 1) === 1;
                b.p += len; run = (v >> 5) & 63; level = (v >> 11) & 127; if (sign) level = -level;
              }
              n += run;
              if (n > 63) throw new Error('run');
              const pos = inv[n], w = W[pos];
              let val = (2 * Math.abs(level) * w * qscale) >> 5;
              if (level < 0) val = -val;
              if (val > 2047) val = 2047; else if (val < -2048) val = -2048;
              F[pos] = val; sum += val;
              n++;
            }
            if ((sum & 1) === 0) F[63] += (F[63] & 1) ? -1 : 1;
            const o = bk * 64;
            if (cc === 0 && dct) {
              idct(F, R8, 8, tmp, blk, o);
            } else idct(F, R, s, tmp, blk, o);
          }
          // place the macroblock
          const mr = (addr / mbw) | 0, mc = addr - mr * mbw;
          if (dct) {
            for (let bk = 0; bk < 4; bk++) { const bx = (bk & 1) * 8, top = bk < 2 ? 0 : 1; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) full[(2 * r + top) * 16 + bx + c] = blk[bk * 64 + r * 8 + c]; }
            const box = 16 / (2 * s);
            for (let r = 0; r < 2 * s; r++) for (let c = 0; c < 2 * s; c++) {
              let a = 0; for (let i = 0; i < box; i++) for (let j = 0; j < box; j++) a += full[(r * box + i) * 16 + c * box + j];
              Y[(mr * 2 * s + r) * yw + mc * 2 * s + c] = clip(a / (box * box));
            }
          } else {
            for (let bk = 0; bk < 4; bk++) {
              const ox = mc * 2 * s + (bk & 1) * s, oy = mr * 2 * s + (bk >> 1) * s;
              for (let r = 0; r < s; r++) for (let c = 0; c < s; c++) Y[(oy + r) * yw + ox + c] = clip(blk[bk * 64 + r * s + c]);
            }
          }
          for (let r = 0; r < s; r++) for (let c = 0; c < s; c++) {
            CB[(mr * s + r) * cw + mc * s + c] = clip(blk[4 * 64 + r * s + c]);
            CR[(mr * s + r) * cw + mc * s + c] = clip(blk[5 * 64 + r * s + c]);
          }
          done.push(addr);
        }
        mbs += done.length;
      } catch {
        bad++;
        mbs += done.length;
      }
    }
    if (!mbs) return null;
    // to RGB (BT.709), cropped to the picture, a field doubled in height
    const pw = Math.min(yw, Math.round(seq.width * 2 * s / 16)), ph = Math.min(yh, Math.round((field ? seq.height / 2 : seq.height) * 2 * s / 16));
    const oh = field ? 2 * ph : ph, rgba = new Uint8ClampedArray(pw * oh * 4);
    for (let r = 0; r < oh; r++) {
      const yr = field ? r >> 1 : r;
      for (let c = 0; c < pw; c++) {
        const yy = (Y[yr * yw + c] - 16) * 255 / 219, ci = (yr >> 1) * cw + (c >> 1);
        const u = (CB[ci] - 128) * 255 / 224, v = (CR[ci] - 128) * 255 / 224, o = (r * pw + c) * 4;
        rgba[o] = yy + 1.5748 * v; rgba[o + 1] = yy - 0.1873 * u - 0.4681 * v; rgba[o + 2] = yy + 1.8556 * u; rgba[o + 3] = 255;
      }
    }
    const dar = DARS[this.seqRaw!.aspect] === 1 || !DARS[this.seqRaw!.aspect] ? seq.width / seq.height : DARS[this.seqRaw!.aspect];
    return { width: pw, height: oh, rgba, dar, seq, pic, mbs, mbsTotal: nmb, slices: slices.length, badSlices: bad, complete: mbs === nmb && bad === 0 };
  }
}

const clip = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** 2-D inverse DCT of raster coefficients F averaged down to s x s (s = 8 is the full Annex A IDCT). */
function idct(F: Int32Array, R: Float32Array, s: number, tmp: Float32Array, out: Float32Array, o: number): void {
  // rows of the output: tmp[i][u] = sum_v R[i][v] F[v][u]
  for (let i = 0; i < s; i++) for (let u = 0; u < 8; u++) { let a = 0; for (let v = 0; v < 8; v++) a += R[i * 8 + v] * F[v * 8 + u]; tmp[i * 8 + u] = a; }
  for (let i = 0; i < s; i++) for (let j = 0; j < s; j++) { let a = 0; for (let u = 0; u < 8; u++) a += tmp[i * 8 + u] * R[j * 8 + u]; out[o + i * s + j] = a; }
}
