/**
 * The web side of the HAM+ identity directories: downloads, their caches and refresh, worldwide sources only. The
 * parsing and matching are in dsp/hamid/directory.ts and resolve.ts, shared with Android and iOS.
 *
 * What a browser may read (each sends a CORS header):
 *   · Brandmeister's talkgroup names (about 17 KB compressed), refreshed weekly;
 *   · Brandmeister's device list, the DMR repeaters with their frequencies, color codes and positions (about 1.1 MB
 *     compressed), refreshed weekly in the browser's cache storage;
 *   · callook.info for US callsigns heard on the air, one at a time, cached 30 days (a miss for a day).
 * What it may not: radioid.net (user list and per-ID answers) and HearHam send no CORS header. A radio ID is looked
 * up one at a time through [radioIdUrl]: by default our own pass-through (firebase/functions, radioidLookup), which
 * forwards one ID to radioid.net's per-ID API and adds the CORS header, storing nothing. radioid.net's own address
 * (RADIOID_API_URL) still works where the page runs without the browser's CORS rule, and a user list file the user
 * picks also works. Android and iOS download radioid.net's list and HearHam's directory directly.
 */
import { HamIdResolver } from './dsp/hamid/resolve.js';
import { RadioIdTable, parseCallook, parseBrandmeisterDevices, parseRadioIdApi } from './dsp/hamid/directory.js';

export const BM_TALKGROUPS_URL = 'https://api.brandmeister.network/v2/talkgroup';
export const BM_DEVICES_URL = 'https://api.brandmeister.network/v2/device';
export const RADIOID_USERS_URL = 'https://radioid.net/static/user.csv';
export const RADIOID_API_URL = (id: number) => `https://radioid.net/api/dmr/user/?id=${id}`;
export const RADIOID_PROXY_URL = (id: number) => `https://us-central1-wardrive-go-ff393.cloudfunctions.net/radioidLookup?id=${id}`;
/** NXDN IDs through the same pass-through (radioid.net's NXDN list). */
export const RADIOID_NXDN_PROXY_URL = (id: number) => `https://us-central1-wardrive-go-ff393.cloudfunctions.net/radioidLookup?id=${id}&kind=nxdn`;
/** radioid.net's NXDN ID list (the same columns), for NXDN unit IDs. */
export const RADIOID_NXDN_URL = 'https://radioid.net/static/nxdn.csv';
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
/** A small cached download in local storage: the stored copy while younger than [maxAge], else a fresh one. */
async function cached(key: string, url: string, maxAge: number): Promise<string | null> {
  const s = store(key);
  if (s && Date.now() - s.at < maxAge) return s.text;
  try { const t = await getText(url); keep(key, t); return t; } catch { return s?.text ?? null; }
}
/** A large cached download in the browser's cache storage (local storage holds a few MB at most). */
async function cachedLarge(url: string, maxAge: number): Promise<string | null> {
  let cache: Cache | null = null;
  try { cache = await caches.open('hamid'); } catch { cache = null; }
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
  const at = Number(hit?.headers.get('x-hamid-at') ?? 0);
  if (hit && Date.now() - at < maxAge) return hit.text();
  try {
    const t = await getText(url, 60_000);
    if (cache) await cache.put(url, new Response(t, { headers: { 'x-hamid-at': String(Date.now()), 'content-type': 'application/json' } })).catch(() => undefined);
    return t;
  } catch { return hit ? hit.text() : null; }
}

/** Brandmeister's talkgroup names into the resolver. */
export async function loadTalkgroups(res: HamIdResolver): Promise<number> {
  const t = await cached('hamid.bm.tg', BM_TALKGROUPS_URL, WEEK);
  try { return t ? res.talkgroups.addBrandmeister(t) : 0; } catch { return 0; }
}

/** Brandmeister's DMR repeaters into the resolver's directory. */
export async function loadBrandmeisterRepeaters(res: HamIdResolver): Promise<number> {
  const t = await cachedLarge(BM_DEVICES_URL, WEEK);
  if (!t) return 0;
  try { const list = parseBrandmeisterDevices(t); res.repeaters.add(list); return list.length; } catch { return 0; }
}

/** A user list from a URL the browser may read (a blob: URL of a file the user picked, or a permitted mirror). */
export async function loadRadioIds(res: HamIdResolver, url: string): Promise<number> {
  const text = await getText(url, 60_000);
  res.users = RadioIdTable.fromCsv(text);
  return res.users.size;
}

/** Looks up to [max] of the DMR radio IDs the resolver has queued, one request each, cached 30 days (a miss a day). */
export async function lookupWantedIds(res: HamIdResolver, max = 2, radioIdUrl = RADIOID_PROXY_URL): Promise<number> {
  let n = 0;
  for (const id of [...res.wantedIds].slice(0, max)) {
    const key = `hamid.id.${id}`, s = store(key);
    if (s && Date.now() - s.at < (s.text ? MONTH : DAY)) { const u = s.text ? parseRadioIdApi(s.text) : null; if (u) res.addUser(u); else res.wantedIds.delete(id); continue; }
    try {
      const t = await getText(radioIdUrl(id));
      const u = parseRadioIdApi(t);
      keep(key, u ? t : '');
      if (u) { res.addUser(u); n++; } else res.wantedIds.delete(id);
    } catch { /* blocked or offline: try again later */ }
  }
  return n;
}

/** Looks up to [max] of the NXDN IDs the resolver has queued, the same way (cached 30 days, a miss a day). */
export async function lookupWantedNxdn(res: HamIdResolver, max = 2, url = RADIOID_NXDN_PROXY_URL): Promise<number> {
  let n = 0;
  for (const id of [...res.wantedNxdn].slice(0, max)) {
    const key = `hamid.nxdn.${id}`, s = store(key);
    if (s && Date.now() - s.at < (s.text ? MONTH : DAY)) { const u = s.text ? parseRadioIdApi(s.text) : null; if (u) res.addNxdnUser(u); else res.wantedNxdn.delete(id); continue; }
    try {
      const t = await getText(url(id));
      const u = parseRadioIdApi(t);
      keep(key, u ? t : '');
      if (u) { res.addNxdnUser(u); n++; } else res.wantedNxdn.delete(id);
    } catch { /* blocked or offline: try again later */ }
  }
  return n;
}

/** The NXDN ID list from a URL the browser may read (a mirror, or a blob: URL of a file the user picked). */
export async function loadNxdnIds(res: HamIdResolver, url: string): Promise<number> {
  const text = await getText(url, 60_000);
  res.nxdnUsers = RadioIdTable.fromCsv(text);
  return res.nxdnUsers.size;
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
