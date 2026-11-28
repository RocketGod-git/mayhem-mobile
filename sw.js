const CACHE = 'mayhem-mobile-v3';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // The APK is served from this origin so it needs no GitHub sign-in, but it is megabytes and is downloaded
  // once - keeping a copy in the cache would evict the app itself, so it goes straight to the network.
  if (/\.(apk|aab)$/.test(new URL(req.url).pathname)) return;
  e.respondWith((async () => {
    try {
      // Revalidate with the server every time (a 304 when unchanged) so a new deploy is never masked by the
      // browser's heuristic cache. A navigation request cannot take fetch options, so it goes through as-is.
      const res = req.mode === 'navigate' ? await fetch(req) : await fetch(req, { cache: 'no-cache' });
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()).catch(() => {}); }
      return res;
    } catch {
      const hit = await caches.match(req);
      return hit || new Response('offline', { status: 503 });
    }
  })());
});
