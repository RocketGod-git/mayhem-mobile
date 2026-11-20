/**
 * TETRA downlink above the physical layer (ETSI EN 300 392-2), receive only. No DOM.
 *
 *  - The AACH's ACCESS-ASSIGN PDU (21.4.7.2, Tables 21.82 and 21.83): what each downlink slot carries (common or
 *    assigned control, unallocated, or traffic with its usage marker).
 *  - Which logical channels a burst carries (9.5.1, Tables 9.13 and 9.28): a synchronization burst has the BSCH and
 *    an SCH/HD (or BNCH) in block 2; a normal burst with training sequence 1 is a full slot (SCH/F, or TCH on a slot
 *    the AACH marks traffic), with training sequence 2 two half slots (SCH/HD and SCH/HD or BNCH; on a traffic slot
 *    the STCH steals the first half, and the second half too when the first says so).
 *  - The MAC PDUs (21.4): MAC-RESOURCE (Table 21.55) with its address, encryption mode and channel allocation
 *    (21.5.2, Table 21.87), MAC-FRAG and MAC-END (Tables 21.57 and 21.59) with the fragments put back together per
 *    timeslot, SYSINFO (Table 21.65, with D-MLE-SYSINFO of 18.4.2.2 and the BS service details of 18.5.2.1) and
 *    ACCESS-DEFINE (Table 21.79). Several PDUs in one block (association, 23.4.2.3), fill bits taken off (23.4.3.2),
 *    lengths in octets on a pi/4-DQPSK channel (21.6, Table 21.98).
 *  - LLC basic link PDUs (21.2.1, Table 21.1; 21.2.2), the MLE protocol discriminator (18.5.21, Table 18.87).
 *  - CMCE (14.7.1, the elements of 14.8, encoded as annex E says): D-SETUP, D-CONNECT, D-TX GRANTED, D-TX CEASED,
 *    D-RELEASE, D-DISCONNECT, D-CALL RESTORE, D-SDS-DATA, D-STATUS and the rest by name; SDS-TL text messaging
 *    (29.4.2.4, 29.5.2, 29.5.3). MM by name (16.10.39), with the unit a location update accepts.
 *  - The security information of the extended services broadcast (EN 300 392-7 A.8.77, Table A.104) and the
 *    encryption mode of MAC-RESOURCE (EN 300 392-7 6.5.1): a TM-SDU whose encryption mode is not 00 is encrypted on
 *    the air interface and is not read.
 */
import { TetraRx, tetraColorBits, tetraSchHd, tetraSchF, tetraAach, tetraDescramble, type TetraBurst, type TetraSync } from './tetra.js';
import { tetraTchFull, tetraTchHalf } from './tetra-acelp.js';

/** A cursor over bits (one per byte, most significant first). Reading past the end throws. */
export class TetraBits {
  constructor(readonly b: ArrayLike<number>, public pos = 0, public end = b.length) {}
  get left(): number { return this.end - this.pos; }
  u(n: number): number { if (this.pos + n > this.end) throw new Error('short'); let v = 0; for (let i = 0; i < n; i++) v = v * 2 + (this.b[this.pos++] & 1); return v; }
  /** A type 2 element: its presence bit, then its value (-1 when absent). */
  p(n: number): number { return this.u(1) ? this.u(n) : -1; }
}
/** Fill bits taken off the end of a PDU (23.4.3.2): the last 1 and the zeros after it. */
export function tetraUnfill(b: ArrayLike<number>, from: number, to: number): number {
  let k = to - 1; while (k >= from && !b[k]) k--;
  return k >= from ? k : from;
}

/** The channel allocation element (21.5.2, Table 21.87). [tn] is its lowest timeslot (1 to 4), 0 for "the MCCH". */
export interface TetraChanAlloc {
  type: number; slots: number; tn: number; updown: number; clch: number; cellChange: number; carrier: number;
  band: number; offset: number; duplex: number; reverse: number; monitoring: number;
}
function chanAlloc(r: TetraBits): TetraChanAlloc {
  const type = r.u(2), slots = r.u(4), updown = r.u(2), clch = r.u(1), cellChange = r.u(1), carrier = r.u(12);
  let band = -1, offset = -1, duplex = -1, reverse = -1;
  if (r.u(1)) { band = r.u(4); offset = r.u(2); duplex = r.u(3); reverse = r.u(1); }
  const monitoring = r.u(2);
  if (monitoring === 0) r.u(2);
  if (updown === 0) {
    // augmented channel allocation
    r.u(2); r.u(3); const mod = r.u(3); r.u(3); r.u(3); r.u(4); r.u(5);
    void mod;
    const nap = r.u(2); if (nap === 1) r.u(11);
    r.u(4); if (r.u(1)) r.u(16); if (r.u(1)) r.u(16); r.u(1);
  }
  const tn = slots === 0 ? 0 : [1, 2, 3, 4].find(t => (slots >> (4 - t)) & 1) ?? 0;
  return { type, slots, tn, updown, clch, cellChange, carrier, band, offset, duplex, reverse, monitoring };
}
/** A carrier number to its downlink frequency (Hz): base = band x 100 MHz (TS 100 392-15), 25 kHz steps, offset. */
export function tetraCarrierHz(carrier: number, band: number, offset: number): number {
  return band * 100e6 + carrier * 25e3 + [0, 6250, -6250, 12500][offset & 3];
}

/** SYSINFO with its D-MLE-SYSINFO. */
export interface TetraSysinfo {
  mainCarrier: number; band: number; offset: number; duplex: number; reverse: number; scch: number;
  msTxPwr: number; rxLevMin: number; accessParam: number; radioDlTimeout: number;
  /** The hyperframe number, or the common cipher key identifier (or static cipher key version) when [cck]. */
  cck: boolean; hyperframe: number; optFlag: number;
  la: number; subscriberClass: number;
  services: { registration: boolean; deregistration: boolean; priority: boolean; minimumMode: boolean; migration: boolean; systemWide: boolean; voice: boolean; data: boolean; sndcp: boolean; aie: boolean; advancedLink: boolean };
  /** The security information of the extended services broadcast (when that option is sent). */
  security: { auth: boolean; class1: boolean; class3: boolean; sckn: number } | null;
  mainHz: number;
}
function sysinfo(r: TetraBits): TetraSysinfo {
  const mainCarrier = r.u(12), band = r.u(4), offset = r.u(2), duplex = r.u(3), reverse = r.u(1), scch = r.u(2), msTxPwr = r.u(3), rxLevMin = r.u(4), accessParam = r.u(4), radioDlTimeout = r.u(4);
  const cck = r.u(1) === 1, hyperframe = r.u(16), optFlag = r.u(2);
  let security: TetraSysinfo['security'] = null;
  if (optFlag === 3) {
    const auth = r.u(1) === 1, class1 = r.u(1) === 1, class3 = r.u(1) === 1, rest = r.u(5);
    security = { auth, class1, class3, sckn: class3 ? -1 : rest };
    r.u(12);
  } else r.u(20);
  const la = r.u(14), subscriberClass = r.u(16);
  const s = Array.from({ length: 12 }, () => r.u(1) === 1);
  return { mainCarrier, band, offset, duplex, reverse, scch, msTxPwr, rxLevMin, accessParam, radioDlTimeout, cck, hyperframe, optFlag, la, subscriberClass,
    services: { registration: s[0], deregistration: s[1], priority: s[2], minimumMode: !s[3], migration: s[4], systemWide: s[5], voice: s[6], data: s[7], sndcp: s[9], aie: s[10], advancedLink: s[11] },
    security, mainHz: band > 0 ? tetraCarrierHz(mainCarrier, band, offset) : 0 };
}

/** What a MAC-RESOURCE (or a MAC-END completing one) said about the PDU it carries. */
export interface TetraMacInfo {
  /** 1 SSI, 2 event label, 3 USSI, 4 SMI, 5 SSI + event label, 6 SSI + usage marker, 7 SMI + event label. */
  addrType: number; ssi: number; um: number; enc: number; chan: TetraChanAlloc | null; tn: number; fn: number;
}
export const CMCE_NAMES = ['D-ALERT', 'D-CALL PROCEEDING', 'D-CONNECT', 'D-CONNECT ACKNOWLEDGE', 'D-DISCONNECT', 'D-INFO', 'D-RELEASE', 'D-SETUP', 'D-STATUS', 'D-TX CEASED', 'D-TX CONTINUE', 'D-TX GRANTED', 'D-TX WAIT', 'D-TX INTERRUPT', 'D-CALL RESTORE', 'D-SDS-DATA', 'D-FACILITY'];
export const MM_NAMES = ['D-OTAR', 'D-AUTHENTICATION', 'D-CK CHANGE DEMAND', 'D-DISABLE', 'D-ENABLE', 'D-LOCATION UPDATE ACCEPT', 'D-LOCATION UPDATE COMMAND', 'D-LOCATION UPDATE REJECT', 'MM 8', 'D-LOCATION UPDATE PROCEEDING', 'D-ATTACH/DETACH GROUP IDENTITY', 'D-ATTACH/DETACH GROUP IDENTITY ACK', 'D-MM STATUS', 'MM 13', 'MM 14', 'MM FUNCTION NOT SUPPORTED'];
const DISCONNECT = ['cause unknown', 'user requested', 'called party busy', 'called party not reachable', 'called party does not support encryption', 'congestion', 'traffic case not allowed', 'incompatible traffic case',
  'service not available', 'pre-emptive use of resource', 'invalid call identifier', 'call rejected', 'no idle CC entity', 'timer expired', 'SwMI requested', 'acknowledged service not completed', 'unknown TETRA identity',
  'SS-specific', 'unknown external subscriber', 'call restoration failed', 'called party requires encryption', 'concurrent set-up not supported', 'same DM-GATE', 'non-call owner requested'];
export const tetraDisconnectCause = (c: number) => DISCONNECT[c] ?? `cause ${c}`;
/** Basic service information (14.8.2): circuit mode type, end-to-end encryption flag, communication type. */
export interface TetraBasic { mode: number; e2ee: boolean; comm: number; speech: number }
const basic = (v: number): TetraBasic => ({ mode: v >> 5, e2ee: ((v >> 4) & 1) === 1, comm: (v >> 2) & 3, speech: v & 3 });
export interface TetraSds { from: number; kind: string; text: string; hex: string; status: number; protocol: number }
/** One CMCE PDU, its fields as far as they apply (-1 where not sent). */
export interface TetraCmce {
  type: number; name: string; callId: number; grant: number; reqPerm: number; basic: TetraBasic | null; prio: number;
  calling: number; talker: number; cause: number; newCallId: number; encCtl: number; timeout: number; duplex: number; sds: TetraSds | null;
}
const GRANTS = ['granted', 'not granted', 'queued', 'granted to another'];
export const tetraGrantName = (g: number) => GRANTS[g] ?? '';
const COMM = ['individual', 'group', 'group acknowledged', 'broadcast'];
export const tetraCommName = (c: number) => COMM[c] ?? '';
/** Text in one of the SDS-TL text coding schemes (29.5.4.1): 8-bit Latin alphabets read as Latin 1, UCS-2, 7-bit GSM. */
function sdsText(r: TetraBits, scheme: number): string {
  const n = r.left;
  if (scheme === 0) {
    // the 7-bit alphabet (29.5.4.3), its printable characters read as ASCII
    let s = ''; for (let i = 0; i + 7 <= n; i += 7) { const c = r.u(7); s += c === 0 ? '@' : c === 2 ? '$' : c >= 32 && c < 127 ? String.fromCharCode(c) : c === 10 || c === 13 ? ' ' : '?'; }
    return s.trim();
  }
  if (scheme === 26) { let s = ''; for (let i = 0; i + 16 <= n; i += 16) s += String.fromCharCode(r.u(16)); return s.trim(); }
  let s = ''; for (let i = 0; i + 8 <= n; i += 8) { const c = r.u(8); s += c >= 32 && c !== 127 ? String.fromCharCode(c) : c === 10 || c === 13 ? ' ' : ''; }
  return s.trim();
}
/** The user defined data of a D-SDS-DATA (its type 4 data): text messaging read, the rest kept as hex. */
function sdsData(r: TetraBits, bits: number, from: number): TetraSds {
  const start = r.pos, end = Math.min(r.end, start + bits);
  const hex = (() => { let h = ''; const q = new TetraBits(r.b, start, end); while (q.left >= 4) h += q.u(4).toString(16); return h.toUpperCase(); })();
  const out: TetraSds = { from, kind: 'data', text: '', hex, status: -1, protocol: -1 };
  if (bits < 8) return out;
  const q = new TetraBits(r.b, start, end), pid = q.u(8); out.protocol = pid;
  try {
    if (pid === 0x02 || pid === 0x09) { q.u(1); const tcs = q.u(7); out.kind = 'text'; out.text = sdsText(q, tcs); }
    else if (pid === 0x82 || pid === 0x89) {
      const mt = q.u(4);
      if (mt !== 0) { out.kind = 'report'; return out; }
      q.u(2); q.u(1); const store = q.u(1); q.u(8);
      if (store) {
        q.u(5); const fat = q.u(3);
        if (fat === 0) q.u(8); else if (fat === 1) q.u(24); else if (fat === 2) q.u(48); else if (fat === 3) { const d = q.u(8); q.u(4 * d + (d & 1 ? 4 : 0)); }
      }
      const ts = q.u(1), tcs = q.u(7); if (ts) q.u(24);
      out.kind = 'text'; out.text = sdsText(q, tcs);
    } else out.kind = `protocol ${pid}`;
  } catch { /* a short PDU: what was read stays */ }
  return out;
}
function cmce(r: TetraBits): TetraCmce {
  const type = r.u(5);
  const c: TetraCmce = { type, name: CMCE_NAMES[type] ?? `CMCE ${type}`, callId: -1, grant: -1, reqPerm: -1, basic: null, prio: -1, calling: -1, talker: -1, cause: -1, newCallId: -1, encCtl: -1, timeout: -1, duplex: -1, sds: null };
  const party = () => { const t = r.p(2); if (t === 1 || t === 2) { const ssi = r.u(24); if (t === 2) r.u(24); return ssi; } return -1; };
  try {
    switch (type) {
      case 0: c.callId = r.u(14); r.u(3); r.u(1); c.duplex = r.u(1); r.u(1); if (r.u(1)) { const b = r.p(8); if (b >= 0) c.basic = basic(b); } break;
      case 1: c.callId = r.u(14); r.u(3); r.u(1); c.duplex = r.u(1); if (r.u(1)) { const b = r.p(8); if (b >= 0) c.basic = basic(b); } break;
      case 2: {
        c.callId = r.u(14); c.timeout = r.u(4); r.u(1); c.duplex = r.u(1); c.grant = r.u(2); c.reqPerm = r.u(1); r.u(1);
        if (r.u(1)) { c.prio = r.p(4); const b = r.p(8); if (b >= 0) c.basic = basic(b); r.p(24); r.p(6); }
        break;
      }
      case 3: c.callId = r.u(14); c.timeout = r.u(4); c.grant = r.u(2); c.reqPerm = r.u(1); break;
      case 4: case 6: c.callId = r.u(14); c.cause = r.u(5); break;
      case 5: c.callId = r.u(14); break;
      case 7: {
        c.callId = r.u(14); c.timeout = r.u(4); r.u(1); c.duplex = r.u(1); c.basic = basic(r.u(8)); c.grant = r.u(2); c.reqPerm = r.u(1); c.prio = r.u(4);
        if (r.u(1)) { r.p(6); r.p(24); c.calling = party(); }
        break;
      }
      case 8: case 15: {
        const t = r.u(2); let from = -1; if (t === 1 || t === 2) { from = r.u(24); if (t === 2) r.u(24); }
        c.calling = from;
        if (type === 8) { const st = r.u(16); c.sds = { from, kind: 'status', text: '', hex: st.toString(16).toUpperCase().padStart(4, '0'), status: st, protocol: -1 }; break; }
        const sdti = r.u(2), len = sdti === 3 ? r.u(11) : [16, 32, 64][sdti];
        c.sds = sdsData(r, len, from);
        break;
      }
      case 9: c.callId = r.u(14); c.reqPerm = r.u(1); break;
      case 10: c.callId = r.u(14); r.u(1); c.reqPerm = r.u(1); break;
      case 11: case 13: {
        c.callId = r.u(14); c.grant = r.u(2); c.reqPerm = r.u(1); c.encCtl = r.u(1); r.u(1);
        if (r.u(1)) { r.p(6); c.talker = party(); }
        break;
      }
      case 12: c.callId = r.u(14); c.reqPerm = r.u(1); break;
      case 14: {
        c.callId = r.u(14); c.grant = r.u(2); c.reqPerm = r.u(1); r.u(1);
        if (r.u(1)) { c.newCallId = r.p(14); c.timeout = r.p(4); r.p(3); r.p(9); r.p(6); }
        break;
      }
    }
  } catch { /* a PDU cut short: the fields read so far stand */ }
  return c;
}

/** What the MAC layer passes up. */
export type TetraEvent =
  | { kind: 'sysinfo'; info: TetraSysinfo; tn: number }
  | { kind: 'access'; text: string }
  | { kind: 'cmce'; pdu: TetraCmce; mac: TetraMacInfo }
  | { kind: 'mm'; name: string; type: number; mac: TetraMacInfo }
  | { kind: 'other'; name: string; mac: TetraMacInfo }
  /** A TM-SDU encrypted on the air interface (encryption mode not 00): not readable. */
  | { kind: 'encrypted'; mac: TetraMacInfo }
  /** A MAC-RESOURCE that allocates a channel or a usage marker and carries nothing else. */
  | { kind: 'alloc'; mac: TetraMacInfo }
  /** Speech frames of a traffic slot (137 bits each; an empty frame is a bad or stolen one). */
  | { kind: 'voice'; tn: number; um: number; frames: Uint8Array[] }
  | { kind: 'aach'; tn: number; fn: number; usage: number };

const LLC_FCS = new Set([4, 5, 6, 7]);
const AL_NAMES = ['AL-SETUP', 'AL-DATA', 'AL-UDATA', 'AL-ACK', 'AL-RECONNECT', 'AL SUPPLEMENTARY', 'LAYER 2 SIGNALLING', 'AL-DISC'];

/**
 * The MAC of one carrier: the receiver's bursts in, what they carry out. The color code comes from the carrier's own
 * synchronization bursts, or from the cell it belongs to ([setCell]).
 */
export class TetraMac {
  onEvent: (e: TetraEvent) => void = () => undefined;
  private e: Uint8Array | null = null;
  /** Per timeslot: the downlink usage marker last read on its AACH (-1 unknown) and the slot count then. */
  private readonly usage = [-1, -1, -1, -1, -1]; private readonly usageAt = [0, 0, 0, 0, 0];
  private readonly frag = new Map<number, { mac: TetraMacInfo; bits: number[] }>();
  private slots = 0;
  readonly stats = { blocks: 0, crcOk: 0, voice: 0, aachOk: 0 };
  constructor(rx: TetraRx | null) { if (rx) rx.onBurst = b => this.burst(b); }
  setCell(mcc: number, mnc: number, cc: number): void { this.e = tetraColorBits(mcc, mnc, cc); }
  get cellKnown(): boolean { return this.e !== null; }
  burst(b: TetraBurst): void {
    this.slots++;
    if (b.sync) this.setCell(b.sync.mcc, b.sync.mnc, b.sync.colorCode);
    const e = this.e; if (!e) return;
    const s = b.soft, tn = b.tn, fn = b.fn;
    // the AACH: 30 bits of the broadcast block
    const bb = b.kind === 'sync' ? s.subarray(252, 282) : Float32Array.from([...s.subarray(230, 244), ...s.subarray(266, 282)]);
    const acc = tetraAach(bb, e);
    if (acc !== null) {
      this.stats.aachOk++;
      const hdr = acc >> 12, f1 = (acc >> 6) & 63;
      // frames 1 to 17 say what the downlink slot carries; frame 18 is the control frame
      const use = fn === 18 ? 2 : hdr === 0 ? 2 : f1;
      this.usage[tn] = use; this.usageAt[tn] = this.slots;
      this.onEvent({ kind: 'aach', tn, fn, usage: use });
    }
    const recent = this.slots - this.usageAt[tn] < 72;
    const traffic = fn !== 18 && recent && this.usage[tn] >= 4, um = traffic ? this.usage[tn] : -1;
    const meta = { tn, fn };
    if (b.kind === 'sync') { this.block(s.subarray(282, 498), 'hd', meta); return; }
    if (b.kind === 'n1') {
      if (traffic) { this.voice(tn, um, tetraTchFull(tetraDescramble(Float32Array.from([...s.subarray(14, 230), ...s.subarray(282, 498)]), e))); return; }
      this.block(Float32Array.from([...s.subarray(14, 230), ...s.subarray(282, 498)]), 'f', meta);
      return;
    }
    // two half slots: on a traffic slot the first is stolen for signalling, and the second too when the first says so
    const stolen2 = this.block(s.subarray(14, 230), traffic ? 'stch' : 'hd', meta);
    if (traffic && !stolen2) {
      const h = tetraTchHalf(tetraDescramble(s.subarray(282, 498), e));
      this.voice(tn, um, { frames: [new Uint8Array(0), h.frames[0]], bfi: h.bfi }, true);
    } else this.block(s.subarray(282, 498), traffic ? 'stch' : 'hd', meta);
  }
  private voice(tn: number, um: number, sp: { frames: Uint8Array[]; bfi: boolean }, half = false): void {
    this.stats.voice++;
    const frames = sp.frames.map((f, i) => sp.bfi && (!half || i === 1) ? new Uint8Array(0) : f);
    this.onEvent({ kind: 'voice', tn, um, frames });
  }
  /**
   * One MAC block: decoded, then every PDU in it. Returns whether an STCH block says the second half slot is stolen
   * as well.
   */
  private block(soft: ArrayLike<number>, ch: 'f' | 'hd' | 'stch', meta: { tn: number; fn: number }): boolean {
    this.stats.blocks++;
    const bits = ch === 'f' ? tetraSchF(soft, this.e!) : tetraSchHd(soft, this.e!);
    if (!bits) return false;
    this.stats.crcOk++;
    return this.pdus(bits, meta);
  }
  /** The PDUs of a decoded MAC block (exposed for the tests). */
  pdus(bits: ArrayLike<number>, meta: { tn: number; fn: number }): boolean {
    const n = bits.length, r = new TetraBits(bits);
    let stolen = false;
    try {
      while (r.left >= 16) {
        const start = r.pos, type = r.u(2);
        if (type === 0) {
          const fill = r.u(1); r.u(1); const enc = r.u(2); r.u(1); const li = r.u(6), at = r.u(3);
          if (at === 0) break;
          let ssi = -1, um = -1;
          if (at === 1 || at === 3 || at === 4) ssi = r.u(24);
          else if (at === 2) r.u(10);
          else if (at === 5 || at === 7) { ssi = r.u(24); r.u(10); }
          else if (at === 6) { ssi = r.u(24); um = r.u(6); }
          if (r.u(1)) r.u(4);
          if (r.u(1)) r.u(8);
          const chan = r.u(1) ? chanAlloc(r) : null;
          const mac: TetraMacInfo = { addrType: at, ssi, um, enc, chan, ...meta };
          const end = li >= 1 && li <= 58 ? Math.min(n, start + 8 * li) : n;
          if (li === 62) stolen = true;
          const sduEnd = fill ? tetraUnfill(bits, r.pos, end) : end;
          const sdu = Array.from({ length: Math.max(0, sduEnd - r.pos) }, (_, i) => bits[r.pos + i]);
          if (li === 63) { this.frag.set(meta.tn, { mac, bits: sdu }); break; }
          this.sdu(mac, sdu);
          if (end >= n) break;
          r.pos = end;
        } else if (type === 1) {
          if (r.u(1) === 0) {
            // MAC-FRAG: the rest of the block continues the TM-SDU being put together on this timeslot
            const fill = r.u(1), sduEnd = fill ? tetraUnfill(bits, r.pos, n) : n;
            const f = this.frag.get(meta.tn); if (f) for (let i = r.pos; i < sduEnd; i++) f.bits.push(bits[i]);
            break;
          }
          // MAC-END: its last part, and maybe a channel allocation for the whole
          const fill = r.u(1); r.u(1); const li = r.u(6);
          if (r.u(1)) r.u(8);
          const chan = r.u(1) ? chanAlloc(r) : null;
          const end = li >= 1 && li <= 58 ? Math.min(n, start + 8 * li) : n;
          const sduEnd = fill ? tetraUnfill(bits, r.pos, end) : end;
          const f = this.frag.get(meta.tn); this.frag.delete(meta.tn);
          if (f) {
            for (let i = r.pos; i < sduEnd; i++) f.bits.push(bits[i]);
            this.sdu({ ...f.mac, chan: chan ?? f.mac.chan }, f.bits);
          }
          if (end >= n) break;
          r.pos = end;
        } else if (type === 2) {
          const bt = r.u(2);
          if (bt === 0) { this.onEvent({ kind: 'sysinfo', info: sysinfo(r), tn: meta.tn }); }
          else if (bt === 1) {
            const common = r.u(1), code = r.u(2), imm = r.u(4), wt = r.u(4), nu = r.u(4), flf = r.u(1), tsp = r.u(4), pri = r.u(3);
            this.onEvent({ kind: 'access', text: `ACCESS-DEFINE · ${common ? 'assigned' : 'common'} control · access code ${'ABCD'[code]} · IMM ${imm} · WT ${wt} · Nu ${nu} · frame-length x${flf ? 4 : 1} · timeslots ${tsp} · minimum priority ${pri}` });
          }
          break;
        } else break;   // MAC-U-SIGNAL and MAC-D-BLCK carry nothing read here
      }
    } catch { /* a block that ended mid-PDU */ }
    return stolen;
  }
  /** A whole TM-SDU: LLC, then MLE, then CMCE or MM. Encrypted ones go no further. */
  private sdu(mac: TetraMacInfo, sdu: number[]): void {
    if (mac.enc !== 0) { this.onEvent({ kind: 'encrypted', mac }); return; }
    if (sdu.length < 4) { if (mac.chan || mac.um >= 0) this.onEvent({ kind: 'alloc', mac }); return; }
    const r = new TetraBits(sdu);
    try {
      const llc = r.u(4);
      if (llc >= 8) { this.onEvent({ kind: 'other', name: AL_NAMES[llc - 8], mac }); return; }
      if (llc === 0 || llc === 4) r.u(2); else if (llc === 1 || llc === 5 || llc === 3 || llc === 7) r.u(1);
      if (LLC_FCS.has(llc)) r.end = Math.max(r.pos, r.end - 32);
      if (r.left < 3) { if (mac.chan) this.onEvent({ kind: 'alloc', mac }); return; }
      const pd = r.u(3);
      if (pd === 2) this.onEvent({ kind: 'cmce', pdu: cmce(r), mac });
      else if (pd === 1) { const t = r.u(4); this.onEvent({ kind: 'mm', name: MM_NAMES[t], type: t, mac }); }
      else this.onEvent({ kind: 'other', name: ['', 'MM', 'CMCE', 'MLE 3', 'SNDCP', 'MLE', 'TETRA MANAGEMENT', 'TEST'][pd] || `MLE ${pd}`, mac });
    } catch { /* too short to say */ }
  }
}
export type { TetraSync };
