// Mayhem Mobile: a per-ID pass-through to radioid.net for the web app.
//
// Browsers can't read radioid.net's per-ID API directly (it sends no CORS header). This function forwards one
// lookup, returns only the public directory fields, and adds the CORS header. It stores nothing; answers carry a
// cache header so the CDN and the browser keep them for a day.
const { onRequest } = require('firebase-functions/v2/https');

const ORIGINS = new Set(['https://rocketgod-git.github.io', 'https://rocketgod.dev', 'http://localhost:8261']);
const KINDS = { dmr: 'dmr', nxdn: 'nxdn' };
const FIELDS = ['id', 'radio_id', 'callsign', 'fname', 'name', 'surname', 'city', 'state', 'country'];

exports.radioidLookup = onRequest({ region: 'us-central1', maxInstances: 2, memory: '128MiB', timeoutSeconds: 10, concurrency: 40 }, async (req, res) => {
  const origin = req.get('origin') || '';
  if (ORIGINS.has(origin)) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') { res.set('Access-Control-Allow-Methods', 'GET'); res.set('Access-Control-Max-Age', '86400'); res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).end(); return; }
  if (origin && !ORIGINS.has(origin)) { res.status(403).end(); return; }
  const id = String(req.query.id || ''), kind = KINDS[String(req.query.kind || 'dmr')];
  if (!/^\d{1,8}$/.test(id) || !kind) { res.status(400).json({ error: 'id must be 1 to 8 digits; kind dmr or nxdn' }); return; }
  try {
    const r = await fetch(`https://radioid.net/api/${kind}/user/?id=${id}`, { headers: { 'User-Agent': 'MayhemMobile-lookup/1' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { res.set('Cache-Control', 'public, max-age=3600'); res.status(r.status === 404 ? 404 : 502).json({ results: [] }); return; }
    const j = await r.json();
    const results = (Array.isArray(j.results) ? j.results : []).slice(0, 5)
      .map(u => Object.fromEntries(FIELDS.filter(f => u[f] !== undefined).map(f => [f, u[f]])));
    res.set('Cache-Control', results.length ? 'public, max-age=86400, s-maxage=86400' : 'public, max-age=3600');
    res.json({ count: results.length, results });
  } catch {
    res.set('Cache-Control', 'no-store');
    res.status(502).json({ results: [] });
  }
});
