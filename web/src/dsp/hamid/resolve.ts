/**
 * A channel's identity snapshot turned into what HAM+ shows: the station (callsign, name, city and state), the
 * talkgroup or the radio called, the repeater and its network, and the position. What the signal itself carries
 * comes first (a D-STAR RPT1, a Fusion downlink, a DMR talker alias, a CW ID); the directories fill in the rest.
 * Callsigns heard that no offline table knows are queued in [wanted] for the platform to look up online. No DOM.
 */
import type { HamIdSnap } from './channel.js';
import type { Position } from './gps.js';
import { RadioIdTable, TalkgroupTable, RepeaterDirectory, lookupKey, type CallRecord, type Repeater, type RadioIdUser } from './directory.js';

export interface Station { callsign: string; radioId: number; alias: string; name: string; city: string; state: string; country: string; source: string }
export interface Resolved {
  mode: string;
  station: Station | null;
  /** The talkgroup name (with [tgId]); for a private DMR call, the called radio. */
  talkgroup: string; tgId: number; group: boolean; called: Station | null;
  /** The repeater as the signal names it (D-STAR RPT1 and module, Fusion downlink, CW ID). */
  repeater: string;
  /** The repeater as a directory lists it at this frequency (with the tone or color code heard), its site and network. */
  listed: string; repeaterSite: string; network: string; dgid: number; colorCode: number; slot: number;
  position: Position | null;
}
export interface ChannelContext { hz: number; tone?: string; cwId?: string; lat?: number; lon?: number }

const blank = (): Station => ({ callsign: '', radioId: 0, alias: '', name: '', city: '', state: '', country: '', source: '' });

export class HamIdResolver {
  users: RadioIdTable | null = null;
  readonly talkgroups = new TalkgroupTable();
  readonly repeaters = new RepeaterDirectory();
  readonly calls = new Map<string, CallRecord>();
  /** Callsigns heard on the air that no table has: the platform may look these up and add the answers. */
  readonly wanted = new Set<string>();
  /** DMR radio IDs answered one at a time (the web's per-ID lookups), and those heard that nothing has answered yet. */
  readonly ids = new Map<number, RadioIdUser>();
  readonly wantedIds = new Set<number>();

  addCall(r: CallRecord): void { this.calls.set(r.callsign, r); this.wanted.delete(r.callsign); }
  addUser(u: RadioIdUser): void { this.ids.set(u.id, u); this.wantedIds.delete(u.id); }

  private fromUser(st: Station, u: RadioIdUser): void {
    st.callsign = st.callsign || u.callsign; st.radioId = st.radioId || u.id; st.name = u.name; st.city = u.city; st.state = u.state; st.country = u.country; st.source = 'radioid.net';
  }
  /** Fills a station's name and place from what it is called: the offline tables, else queues the callsign. */
  private fill(st: Station): void {
    if (st.radioId) {
      const u = this.users?.byId(st.radioId) ?? this.ids.get(st.radioId);
      if (u) { this.fromUser(st, u); return; }
      if (!this.users) this.wantedIds.add(st.radioId);
    }
    const key = lookupKey(st.callsign);
    if (!key) return;
    const rec = this.calls.get(key);
    if (rec) { st.name = rec.name; st.city = rec.city; st.state = rec.state; st.country = st.country || 'United States'; st.source = rec.source; return; }
    if (this.users) { const u = this.users.byCallsign(key); if (u) { const id = st.radioId; this.fromUser(st, u); st.radioId = id; return; } }
    this.wanted.add(key);
  }

  resolve(snap: HamIdSnap, ctx: ChannelContext): Resolved {
    const out: Resolved = { mode: snap.mode, station: null, talkgroup: '', tgId: 0, group: true, called: null, repeater: '', listed: '', repeaterSite: '', network: '', dgid: -1, colorCode: -1, slot: 0, position: snap.position };
    let rep: Repeater | null = null;
    if (snap.mode === 'DMR' && snap.dmr) {
      out.colorCode = snap.dmr.cc;
      rep = this.repeaters.at(ctx.hz, { cc: snap.dmr.cc, mode: 'DMR', lat: ctx.lat, lon: ctx.lon })[0] ?? null;
      const live = snap.dmr.slots.filter(s => s.src > 0).sort((a, b) => b.lastSym - a.lastSym)[0];
      if (live) {
        out.slot = live.slot;
        const st = blank(); st.radioId = live.src; st.alias = live.alias;
        const aliasCall = lookupKey(live.alias); if (aliasCall) st.callsign = aliasCall;
        this.fill(st); out.station = st;
        out.group = live.group; out.tgId = live.tg;
        if (live.group) { const tg = this.talkgroups.lookup(live.tg, rep?.network ?? ''); out.talkgroup = tg ? tg.name : ''; }
        else { const c = blank(); c.radioId = live.tg; this.fill(c); out.called = c; }
        out.position = live.position;
      }
    } else if (snap.mode === 'D-STAR' && snap.dstar?.header) {
      const h = snap.dstar.header, st = blank(); st.callsign = h.my; st.alias = h.suffix; this.fill(st); out.station = st;
      out.talkgroup = h.ur;
      out.repeater = snap.repeater;
    } else if (snap.mode === 'YSF' && snap.ysf) {
      const st = blank(); st.callsign = snap.ysf.src; this.fill(st); out.station = st;
      out.talkgroup = snap.ysf.dest; out.dgid = snap.ysf.dgid; out.repeater = snap.ysf.down;
    }
    if (!rep && snap.mode !== 'DMR') rep = this.repeaters.at(ctx.hz, { tone: ctx.tone, mode: snap.mode === 'analog' || snap.mode === '' ? 'FM' : snap.mode, lat: ctx.lat, lon: ctx.lon })[0] ?? null;
    if (!out.repeater && ctx.cwId) out.repeater = ctx.cwId;
    if (rep) { out.listed = rep.name || rep.call; out.repeaterSite = rep.site || rep.city; out.network = rep.network; }
    return out;
  }
}
