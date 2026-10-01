/* Service worker: caches the app (code, data and every flag) so it works offline.
   CACHE is stamped by tools/release.py; old caches are deleted on activate. */
var CACHE = 'ltc-2026-10-01.150452';
var FILES = ['./', './index.html', './src/style.css', './src/app.js', './src/data.js', './src/map.js',
             './src/quiz.js', './src/store.js', './src/sync-github.js', './data/info.json', './data/colors.json', './lib/maplibre-gl.js', './lib/maplibre-gl.css', './data/countries.json',
             './data/world.geojson', './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png',
             './icons/icon-512.png'];

function allFiles() {
  return fetch('./data/countries.json').then(function (r) { return r.json(); })
    .then(function (list) { return FILES.concat(list.map(function (x) { return './flags/' + x.id + '.svg'; })); });
}
function precache() {
  return caches.open(CACHE).then(function (c) {
    return allFiles().then(function (files) { return c.addAll(files); });
  });
}
// {done, total}: how many app files are saved on the device for offline use
function offlineStatus() {
  return caches.open(CACHE).then(function (c) {
    return allFiles().catch(function () {
      return c.match('./data/countries.json').then(function (r) { return r.json(); })
        .then(function (list) { return FILES.concat(list.map(function (x) { return './flags/' + x.id + '.svg'; })); });
    }).then(function (files) {
      return Promise.all(files.map(function (f) { return c.match(f); })).then(function (hits) {
        return { done: hits.filter(Boolean).length, total: files.length };
      });
    });
  });
}

self.addEventListener('install', function (e) {
  e.waitUntil(precache().then(function () { return self.skipWaiting(); }));
});
// the page asks: {type: 'offline-status'} or {type: 'download'} (re-save everything); answer on the port
self.addEventListener('message', function (e) {
  var port = e.ports[0];
  if (!port) return;
  var job = e.data && e.data.type === 'download' ? precache().then(offlineStatus) : offlineStatus();
  job.then(function (st) { port.postMessage(st); }, function (err) { port.postMessage({ error: String(err) }); });
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
