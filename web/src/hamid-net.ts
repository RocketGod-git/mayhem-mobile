/**
 * The web side of the HAM+ identity directories: downloads, their caches and refresh. The parsing and matching are in
 * dsp/hamid/directory.ts and resolve.ts, shared with Android and iOS.
 *
 *   · talkgroups: Brandmeister's list (about 17 KB compressed, browsers may fetch it), refreshed weekly;
 *   · PAPA's repeater lists: their published sheet, refreshed weekly (a copy ships in the app);
 *   · callsigns heard on the air: callook.info, one at a time, cached 30 days (a miss for a day);
 *   · DMR radio IDs: radioid.net's list sends no CORS header, so a browser cannot download it from there; the web
 *     app reads it from a mirror URL when one is set, or a file the user picks. Android and iOS download it directly.
 */
import { HamIdResolver } from './dsp/hamid/resolve.js';
import { RadioIdTable, parsePapaCsv, parseCallook } from './dsp/hamid/directory.js';
import { PAPA_ANALOG_URL, PAPA_DMR_URL } from './dsp/hamid/papa-seed.js';

export const BM_TALKGROUPS_URL = 'https://api.brandmeister.network/v2/talkgroup';
export const RADIOID_USERS_URL = 'https://radioid.net/static/user.csv';
export const CALLOOK_URL = (call: string) => `https://callook.info/${encodeURIComponent(call)}/json`;
const WEEK = 7 * 86_400_000, MONTH = 30 * 86_400_000, DAY = 86_400_000;

function store(key: string): { at: number; text: string } | null {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
function keep(key: string, text: string): void { try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), text })); } catch { /* storage full or blocked: run without it */ } }

async function getText(url: string, ms = 10_000): Promise<string> {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); } finally { clearTimeout(t); }
}
/** A cached download: the stored copy while it is younger than [maxAge], else a fresh one (the stored copy if that fails). */
async function cached(key: string, url: string, maxAge: number): Promise<string | null> {
  const s = store(key);
  if (s && Date.now() - s.at < maxAge) return s.text;
  try { const t = await getText(url); keep(key, t); return t; } catch { return s?.text ?? null; }
}

/** Brandmeister's talkgroup names into the resolver. */
export async function loadTalkgroups(res: HamIdResolver): Promise<number> {
  const t = await cached('hamid.bm.tg', BM_TALKGROUPS_URL, WEEK);
  try { return t ? res.talkgroups.addBrandmeister(t) : 0; } catch { return 0; }
}

/** PAPA's lists, fresher than the copy in the app when the download works. */
export async function loadPapa(res: HamIdResolver): Promise<boolean> {
  const [a, d] = await Promise.all([cached('hamid.papa.analog', PAPA_ANALOG_URL, WEEK), cached('hamid.papa.dmr', PAPA_DMR_URL, WEEK)]);
  const ra = a ? parsePapaCsv(a, 'analog') : [], rd = d ? parsePapaCsv(d, 'dmr') : [];
  if (ra.length < 5 || rd.length < 5) return false;
  const list = res.repeaters.list;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].network === 'PAPA') list.splice(i, 1);
  res.repeaters.add(ra); res.repeaters.add(rd);
  return true;
}

/** The DMR user list from a URL the browser may read (a mirror, or a blob: URL of a file the user picked). */
export async function loadRadioIds(res: HamIdResolver, url: string): Promise<number> {
  const text = await getText(url, 60_000);
  res.users = RadioIdTable.fromCsv(text);
  return res.users.size;
}

/** Looks up to [max] of the callsigns the resolver has queued (US callsigns, callook.info). */
export async function lookupWanted(res: HamIdResolver, max = 2): Promise<number> {
  let n = 0;
  for (const call of [...res.wanted].slice(0, max)) {
    const key = `hamid.call.${call}`, s = store(key);
    if (s && Date.now() - s.at < (s.text ? MONTH : DAY)) { const r = s.text ? parseCallook(s.text) : null; if (r) res.addCall(r); else res.wanted.delete(call); continue; }
    try {
      const t = await getText(CALLOOK_URL(call));
      const r = parseCallook(t);
      keep(key, r ? t : '');
      if (r) { res.addCall(r); n++; } else res.wanted.delete(call);
    } catch { /* offline: try again later */ }
  }
  return n;
}
