/**
 * Minimal ASN.1 parser and unaligned PER (UPER) decoder, enough for the 36.331 BCCH-DL-SCH definitions.
 * 36.331 clause 8 names the basic production of unaligned PER (ITU-T X.691):
 *   SEQUENCE   [ext bit] + presence bitmap of OPTIONAL/DEFAULT root components + components; extension additions =
 *              normally small length of the addition bitmap, the bitmap, each present addition as an open type
 *              (length determinant + octets); a [[ ]] group is one addition, its members merged into the parent.
 *   CHOICE     [ext bit] + index in ceil(log2 n) bits; extension alternatives = normally small index + open type.
 *   ENUMERATED [ext bit] + index in ceil(log2 n) bits; extension values = normally small number.
 *   INTEGER    constrained lb..ub = offset in ceil(log2(ub-lb+1)) bits, [ext bit] if extensible.
 *   BIT/OCTET STRING, SEQUENCE OF: fixed size = no length, size range = offset in ceil(log2 range) bits,
 *              unconstrained = general length determinant. CONTAINING decodes the content recursively.
 * Values: SEQUENCE = object, CHOICE = { alternative: value }, ENUMERATED = name, BIT STRING = '0101' string,
 * OCTET STRING = lowercase hex, NULL = null.
 */

export type Bound = number | string;
export interface Constraint { range?: [Bound, Bound]; ext?: boolean; size?: [Bound, Bound]; sizeExt?: boolean; containing?: string }
export interface Comp { name: string; t: AsnType; opt: boolean; def?: string }
export type Add = Comp | { group: Comp[] };
export type AsnType =
  | { k: 'SEQUENCE' | 'CHOICE'; root: Comp[]; adds: Add[]; ext: boolean }
  | { k: 'SEQOF'; el: AsnType; size?: Constraint }
  | { k: 'ENUM'; root: string[]; extv: string[]; ext: boolean }
  | { k: 'INT' | 'BITS' | 'OCTETS' | 'STRING'; c: Constraint }
  | { k: 'BOOL' } | { k: 'NULL' }
  | { k: 'REF'; name: string; c?: Constraint };
export interface Asn1Schema { types: Map<string, AsnType>; values: Map<string, number>; failed: [string, string][] }

const TOK = /::=|\.\.\.|\.\.|\[\[|\]\]|[{}(),|<>[\]]|-?\d+|[A-Za-z][A-Za-z0-9-]*/g;

export function tokenize(text: string): string[] {
  const lines = text.split('\n').map(l => { const i = l.indexOf('--'); return i < 0 ? l : l.slice(0, i) + ' '; });
  return lines.join('\n').match(TOK) ?? [];
}

class P {
  i = 0;
  constructor(readonly t: string[]) {}
  peek(k = 0): string | undefined { return this.t[this.i + k]; }
  take(exp?: string): string {
    const v = this.t[this.i];
    if (v === undefined) throw new SyntaxError('unexpected end');
    if (exp !== undefined && v !== exp) throw new SyntaxError(`expected ${exp} got ${v} near ${this.t.slice(Math.max(0, this.i - 8), this.i + 8).join(' ')}`);
    this.i++;
    return v;
  }
}

export function parseAsn1(text: string): Asn1Schema {
  const p = new P(tokenize(text));
  const types = new Map<string, AsnType>(), values = new Map<string, number>(), failed: [string, string][] = [];
  while (p.peek() !== undefined) {
    const tk = p.peek()!;
    if (tk === 'IMPORTS' || tk === 'EXPORTS') { while (p.peek() !== undefined && p.take() !== ';') { /* skip */ } continue; }
    if (tk === 'DEFINITIONS') { p.take(); while (p.peek() !== undefined && p.peek() !== 'BEGIN') p.take(); p.take(); continue; }
    if (tk === 'END' || tk === 'BEGIN' || tk === 'AUTOMATIC' || tk === 'TAGS') { p.take(); continue; }
    if (p.peek(1) === 'INTEGER' && p.peek(2) === '::=') { const name = p.take(); p.take(); p.take(); values.set(name, Number(p.take())); continue; }
    if (p.peek(1) === '::=') {
      const name = p.take(); p.take();
      try { types.set(name, parseType(p)); } catch (e) {
        failed.push([name, String((e as Error).message).slice(0, 160)]);
        while (p.peek() !== undefined && p.peek(1) !== '::=') p.take();
      }
      continue;
    }
    p.take();
  }
  return { types, values, failed };
}

function val(x: string): Bound { return /^-?\d+$/.test(x) ? Number(x) : x; }

function range(buf: string[]): [[Bound, Bound], boolean] {
  const ext = buf.includes('...');
  const b = buf.filter(x => x !== ',' && x !== '...');
  const j = b.indexOf('..');
  if (j >= 0) return [[val(b[j - 1]), val(b[j + 1])], ext];
  return [[val(b[0]), val(b[0])], ext];
}

function parseConstraint(p: P): Constraint {
  p.take('(');
  let depth = 1;
  const buf: string[] = [];
  for (;;) {
    const tk = p.take();
    if (tk === '(') depth++;
    else if (tk === ')') { depth--; if (depth === 0) break; }
    buf.push(tk);
  }
  if (buf[0] === 'SIZE') {
    const close = buf.indexOf(')');
    const inner = buf[1] === '(' ? buf.slice(2, close) : buf.slice(1);
    const [size, sizeExt] = range(inner);
    return { size, sizeExt };
  }
  if (buf[0] === 'CONTAINING') return { containing: buf[1] };
  const [r, ext] = range(buf);
  return { range: r, ext };
}

function parseType(p: P): AsnType {
  const tk = p.take();
  if (tk === 'SEQUENCE' || tk === 'SET') {
    if (p.peek() === '{') return parseComponents(p, 'SEQUENCE');
    const size = p.peek() === '(' ? parseConstraint(p) : undefined;
    p.take('OF');
    return { k: 'SEQOF', el: parseType(p), size };
  }
  if (tk === 'CHOICE') return parseComponents(p, 'CHOICE');
  if (tk === 'ENUMERATED') {
    p.take('{');
    const root: string[] = [], extv: string[] = [];
    let isExt = false;
    for (;;) {
      const x = p.take();
      if (x === '}') break;
      if (x === ',') continue;
      if (x === '...') { isExt = true; continue; }
      (isExt ? extv : root).push(x);
    }
    return { k: 'ENUM', root, extv, ext: isExt };
  }
  if (tk === 'INTEGER') return { k: 'INT', c: p.peek() === '(' ? parseConstraint(p) : {} };
  if (tk === 'BOOLEAN') return { k: 'BOOL' };
  if (tk === 'NULL') return { k: 'NULL' };
  if (tk === 'BIT' || tk === 'OCTET') {
    p.take('STRING');
    if (p.peek() === '{') while (p.take() !== '}') { /* named bits */ }
    return { k: tk === 'BIT' ? 'BITS' : 'OCTETS', c: p.peek() === '(' ? parseConstraint(p) : {} };
  }
  if (tk === 'VisibleString' || tk === 'IA5String' || tk === 'UTF8String' || tk === 'PrintableString') return { k: 'STRING', c: p.peek() === '(' ? parseConstraint(p) : {} };
  const t: AsnType = { k: 'REF', name: tk };
  if (p.peek() === '(') t.c = parseConstraint(p);
  return t;
}

function parseComponents(p: P, kind: 'SEQUENCE' | 'CHOICE'): AsnType {
  p.take('{');
  const root: Comp[] = [], adds: Add[] = [];
  let inExt = false, extSeen = false;
  for (;;) {
    const x = p.peek();
    if (x === '}') { p.take(); break; }
    if (x === ',') { p.take(); continue; }
    if (x === '...') { p.take(); inExt = kind === 'SEQUENCE' ? !inExt : true; extSeen = true; continue; }
    if (x === '[[') {
      p.take();
      const grp: Comp[] = [];
      while (p.peek() !== ']]') { if (p.peek() === ',') { p.take(); continue; } grp.push(parseComponent(p)); }
      p.take(']]');
      adds.push({ group: grp });
      continue;
    }
    const c = parseComponent(p);
    (inExt ? adds : root).push(c);
  }
  return { k: kind, root, adds, ext: extSeen };
}

function parseComponent(p: P): Comp {
  const name = p.take();
  const c: Comp = { name, t: parseType(p), opt: false };
  if (p.peek() === 'OPTIONAL') { p.take(); c.opt = true; }
  else if (p.peek() === 'DEFAULT') {
    p.take(); c.opt = true;
    const v = p.take();
    if (v === '{') while (p.take() !== '}') { /* skip */ }
    c.def = v;
  }
  return c;
}

class Bits {
  pos = 0;
  constructor(readonly b: string) {}
  static of(data: Uint8Array): Bits { let s = ''; for (const x of data) s += x.toString(2).padStart(8, '0'); return new Bits(s); }
  read(n: number): number {
    if (n === 0) return 0;
    if (this.pos + n > this.b.length) throw new RangeError(`read past end (${this.pos}+${n}>${this.b.length})`);
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + (this.b.charCodeAt(this.pos + i) & 1);
    this.pos += n;
    return v;
  }
  readBits(n: number): string {
    if (this.pos + n > this.b.length) throw new RangeError(`read past end (${this.pos}+${n}>${this.b.length})`);
    const s = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
}

const nbits = (r: number) => r <= 1 ? 0 : Math.ceil(Math.log2(r));
const bitsToBytes = (s: string) => { const o = new Uint8Array(s.length >> 3); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(8 * i, 8 * i + 8), 2); return o; };
const hexOf = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

export class Uper {
  constructor(readonly s: Asn1Schema) {}

  decode(type: string, data: Uint8Array): { value: unknown; bitsUsed: number } {
    const t = this.s.types.get(type);
    if (!t) throw new Error(`unknown type ${type}`);
    const b = Bits.of(data);
    return { value: this.dec(t, b), bitsUsed: b.pos };
  }

  private val(x: Bound): number {
    if (typeof x === 'number') return x;
    const v = this.s.values.get(x);
    if (v !== undefined) return v;
    const m = /^(.+)-(\d+)$/.exec(x);
    if (m && this.s.values.has(m[1])) return this.s.values.get(m[1])! - Number(m[2]);
    throw new Error(`unknown constant ${x}`);
  }

  private glen(b: Bits): number {
    if (b.read(1) === 0) return b.read(7);
    if (b.read(1) === 0) return b.read(14);
    throw new Error('fragmented length');
  }

  private nsnn(b: Bits): number {
    if (b.read(1) === 0) return b.read(6);
    return b.read(8 * this.glen(b));
  }

  private resolve(t: AsnType): AsnType {
    while (t.k === 'REF') {
      const inner = this.s.types.get(t.name);
      if (!inner) throw new Error(`unknown type ${t.name}`);
      const c = t.c;
      t = inner;
      if (c && 'c' in t) t = { ...t, c: { ...t.c, ...c } } as AsnType;
    }
    return t;
  }

  private dec(t0: AsnType, b: Bits): unknown {
    const t = this.resolve(t0);
    switch (t.k) {
      case 'SEQUENCE': return this.decSeq(t, b);
      case 'CHOICE': return this.decChoice(t, b);
      case 'ENUM': {
        if (t.ext && b.read(1)) { const i = this.nsnn(b); return i < t.extv.length ? t.extv[i] : `ext-value-${i}`; }
        const i = b.read(nbits(t.root.length));
        return i < t.root.length ? t.root[i] : `invalid-${i}`;
      }
      case 'INT': {
        const c = t.c;
        if (c.ext && b.read(1)) { const n = this.glen(b); return b.read(8 * n); }
        if (c.range) {
          const lo = this.val(c.range[0]);
          if (c.range[1] === 'MAX') { const n = this.glen(b); return lo + b.read(8 * n); }
          return lo + b.read(nbits(this.val(c.range[1]) - lo + 1));
        }
        const n = this.glen(b);
        let v = b.read(8 * n);
        if (v >= 2 ** (8 * n - 1)) v -= 2 ** (8 * n);
        return v;
      }
      case 'BOOL': return b.read(1) === 1;
      case 'NULL': return null;
      case 'BITS': case 'OCTETS': case 'STRING': {
        const c = t.c, unit = t.k === 'BITS' ? 1 : 8;
        let n: number;
        if ((c.ext || c.sizeExt) && b.read(1)) n = this.glen(b);
        else if (c.size) { const lo = this.val(c.size[0]), hi = this.val(c.size[1]); n = hi !== lo ? lo + b.read(nbits(hi - lo + 1)) : lo; }
        else n = this.glen(b);
        const s = b.readBits(n * unit);
        if (t.k === 'BITS') {
          if (c.containing) return { containing: this.dec(this.typeOf(c.containing), new Bits(s)) };
          return s;
        }
        const raw = bitsToBytes(s);
        if (c.containing) {
          try { return { [c.containing]: this.dec(this.typeOf(c.containing), new Bits(s)) }; } catch (e) { return { hex: hexOf(raw), containing_error: (e as Error).message }; }
        }
        if (t.k === 'STRING') return String.fromCharCode(...raw);
        return hexOf(raw);
      }
      case 'SEQOF': {
        const c = t.size ?? {};
        let n: number;
        if ((c.ext || c.sizeExt) && b.read(1)) n = this.glen(b);
        else if (c.size) { const lo = this.val(c.size[0]), hi = this.val(c.size[1]); n = hi !== lo ? lo + b.read(nbits(hi - lo + 1)) : lo; }
        else n = this.glen(b);
        const out: unknown[] = [];
        for (let i = 0; i < n; i++) out.push(this.dec(t.el, b));
        return out;
      }
    }
    throw new Error('unsupported type');
  }

  private typeOf(name: string): AsnType {
    const t = this.s.types.get(name);
    if (!t) throw new Error(`unknown type ${name}`);
    return t;
  }

  private decSeq(t: { root: Comp[]; adds: Add[]; ext: boolean }, b: Bits): Record<string, unknown> {
    const ext = t.ext && b.read(1) === 1;
    const opts = t.root.filter(c => c.opt);
    const bm = opts.length ? b.readBits(opts.length) : '';
    const pres = new Map(opts.map((c, i) => [c.name, bm[i]]));
    const out: Record<string, unknown> = {};
    for (const c of t.root) {
      if (c.opt && pres.get(c.name) === '0') continue;
      out[c.name] = this.dec(c.t, b);
    }
    if (ext) {
      const n = this.nsnn(b) + 1;
      const bmp = b.readBits(n);
      for (let i = 0; i < n; i++) {
        if (bmp[i] === '0') continue;
        const chunk = b.readBits(8 * this.glen(b));
        const a = t.adds[i];
        if (!a) { out[`unknown_ext_${i}`] = chunk; continue; }
        try {
          if ('group' in a) Object.assign(out, this.decSeq({ root: a.group, adds: [], ext: false }, new Bits(chunk)));
          else out[a.name] = this.dec(a.t, new Bits(chunk));
        } catch (e) { out[`ext${i}_error`] = `${(e as Error).message} (${chunk})`; }
      }
    }
    return out;
  }

  private decChoice(t: { root: Comp[]; adds: Add[]; ext: boolean }, b: Bits): Record<string, unknown> {
    if (t.ext && b.read(1)) {
      const i = this.nsnn(b);
      const chunk = b.readBits(8 * this.glen(b));
      const a = t.adds[i];
      if (a && !('group' in a)) {
        try { return { [a.name]: this.dec(a.t, new Bits(chunk)) }; } catch (e) { return { [a.name]: { hex: hexOf(bitsToBytes(chunk)), error: (e as Error).message } }; }
      }
      return { [`unknown_ext_alt_${i}`]: chunk };
    }
    const i = b.read(nbits(t.root.length));
    const a = t.root[i];
    if (!a) throw new Error(`choice index ${i} out of range`);
    return { [a.name]: this.dec(a.t, b) };
  }
}
