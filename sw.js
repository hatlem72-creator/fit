/* Fit Log service worker: app shell offline, big OCR files cached on first use.
   App files are always fetched from the network first (bypassing the HTTP cache), so an update can never mix old JS with new HTML. */
const VERSION = 'fitlog-v7';
const SHELL = ['./', 'index.html', 'css/app.css?v=7', 'js/calc.js?v=7', 'js/labelparse.js?v=7', 'js/importers.js?v=7', 'js/app.js?v=7',
  'vendor/chart.umd.min.js', 'vendor/zxing.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-180.png'];
const BIG = 'fitlog-vendor-v1';
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).catch(() => { }));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys(), old = keys.filter(k => k !== VERSION && k !== BIG);
    // pages from versions before v4 can't reload themselves after an update, so reload them once from here
    const fromLegacy = old.some(k => /^fitlog-v[1-3]$/.test(k));
    await Promise.all(old.map(k => caches.delete(k)));
    await self.clients.claim();
    // (not awaited: the reload's own fetch waits for activation to finish)
    if (fromLegacy) self.clients.matchAll({ type: 'window' }).then(cs => cs.forEach(c => { const u = new URL(c.url); u.searchParams.set('updated', '1'); c.navigate(u.href).catch(() => { }); }));
  })());
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Open Food Facts etc: network only
  if (url.pathname.includes('/vendor/tesseract/') || url.pathname.includes('/vendor/lang/')) {
    e.respondWith(caches.open(BIG).then(async c => { const hit = await c.match(e.request); if (hit) return hit; const r = await fetch(e.request); if (r.ok) c.put(e.request, r.clone()); return r; }));
    return;
  }
  // network first, skipping the browser's HTTP cache; fall back to this version's cache when offline
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) { const cp = r.clone(); caches.open(VERSION).then(c => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then(r => r || caches.match('index.html'))));
});
