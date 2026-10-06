/* Service worker: caches the app (code, data and every flag) so it works offline.
   CACHE is stamped by tools/release.py; old caches are deleted on activate. */
var CACHE = 'ltc-2026-10-06.165402';
var FILES = ['./', './index.html', './src/style.css', './src/app.js', './src/data.js', './src/map.js',
             './src/quiz.js', './src/store.js', './src/sync-github.js', './data/info.json', './data/colors.json', './lib/maplibre-gl.js', './lib/maplibre-gl.css', './data/countries.json',
             './data/world.geojson', './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png',
             './icons/icon-512.png'];

// JSON from the network, or from the cache when offline
function getJSON(url) {
  return fetch(url).catch(function () { return caches.match(url); })
    .then(function (r) { if (!r || !r.ok) throw new Error(url); return r.json(); });
}
// every file the app needs offline: app shell, country flags, and the deep dives listed in
// data/sub/index.json (their items, shapes and flags)
function allFiles() {
  var countries = getJSON('./data/countries.json')
    .then(function (cs) { return FILES.concat(cs.map(function (x) { return './flags/' + x.id + '.svg'; })); });
  var subs = getJSON('./data/sub/index.json').catch(function () { return []; }).then(function (idx) {
    return Promise.all(idx.map(function (m) {
      return getJSON('./data/sub/' + m.id + '.json').then(function (items) {
        return ['./data/sub/' + m.id + '.json', './data/sub/' + m.id + '.geojson']
          .concat(items.map(function (x) { return './' + x.flag; }));
      });
    })).then(function (lists) {
      var out = idx.length ? ['./data/sub/index.json'] : [];
      lists.forEach(function (l) { out = out.concat(l); });
      return out;
    });
  });
  return Promise.all([countries, subs]).then(function (r) { return r[0].concat(r[1]); });
}
function precache() {
  return caches.open(CACHE).then(function (c) {
    return allFiles().then(function (files) { return c.addAll(files); });
  });
}
// {done, total}: how many app files are saved on the device for offline use
function offlineStatus() {
  return caches.open(CACHE).then(function (c) {
    return allFiles().then(function (files) {
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
