/* Service worker: caches the app (code, data and every flag) so it works offline.
   CACHE is stamped by tools/release.py; old caches are deleted on activate. */
var CACHE = 'ltc-2026-10-01.133919';
var FILES = ['./', './index.html', './src/style.css', './src/app.js', './src/data.js', './src/map.js',
             './src/quiz.js', './src/store.js', './src/sync-github.js', './data/info.json', './data/colors.json', './lib/maplibre-gl.js', './lib/maplibre-gl.css', './data/countries.json',
             './data/world.geojson', './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png',
             './icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(FILES).then(function () { return fetch('./data/countries.json'); })
      .then(function (r) { return r.json(); })
      .then(function (list) { return c.addAll(list.map(function (x) { return './flags/' + x.id + '.svg'; })); });
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// Network first (so updates arrive when online), cache as fallback (offline).
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(function (res) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
    return res;
  }).catch(function () { return caches.match(e.request, { ignoreSearch: true }); }));
});
