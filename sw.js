/* Fit Log service worker: app shell offline, big OCR files cached on first use.
   App files are always fetched from the network first (bypassing the HTTP cache), so an update can never mix old JS with new HTML. */
const VERSION = 'fitlog-v4';
const SHELL = ['./', 'index.html', 'css/app.css?v=4', 'js/calc.js?v=4', 'js/labelparse.js?v=4', 'js/importers.js?v=4', 'js/app.js?v=4',
  'vendor/chart.umd.min.js', 'vendor/zxing.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-180.png'];
const BIG = 'fitlog-vendor-v1';
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).catch(() => { }));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== BIG).map(k => caches.delete(k)))).then(() => self.clients.claim()));
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
