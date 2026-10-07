/* Service worker: keeps the whole app (code, data, every flag, all deep dives) on the phone so
   it works offline. files.json (written by tools/release.py) lists every file with a content
   hash; on an update only files whose hash changed are downloaded, the rest is copied from the
   previous cache. CACHE is stamped by tools/release.py; old caches are deleted on activate. */
var CACHE = 'ltc-2026-10-07.125948';

function manifest() {
  return fetch('./files.json', { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error('files.json ' + r.status);
    return r.json();
  });
}
function cachedManifest(cache) {
  return cache.match('./files.json').then(function (r) { return r ? r.json() : { files: {} }; }).catch(function () { return { files: {} }; });
}
// put every file of manifest m into cache c: copied from `old` (previous version's cache) when
// its hash is unchanged and `old` has it, else downloaded. 8 at a time.
function fill(c, m, old, oldM) {
  var paths = Object.keys(m.files), i = 0;
  function next() {
    if (i >= paths.length) return Promise.resolve();
    var p = paths[i++];
    var reuse = old && oldM.files[p] === m.files[p] ? old.match(p) : Promise.resolve(null);
    return reuse.then(function (r) {
      return r || fetch(p, { cache: 'no-cache' }).then(function (res) { if (!res.ok) throw new Error(p + ' ' + res.status); return res; });
    }).then(function (res) { return c.put(p, res); }).then(next);
  }
  var workers = [];
  for (var k = 0; k < 8; k++) workers.push(next());
  return Promise.all(workers).then(function () {
    return c.put('./files.json', new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/json' } }));
  });
}
function install() {
  return Promise.all([manifest(), caches.open(CACHE), caches.keys()]).then(function (r) {
    var m = r[0], c = r[1];
    var prev = r[2].filter(function (k) { return k !== CACHE && k.indexOf('ltc-') === 0; }).pop();
    if (!prev) return fill(c, m, null, { files: {} });
    return caches.open(prev).then(function (old) {
      return cachedManifest(old).then(function (oldM) { return fill(c, m, old, oldM); });
    });
  });
}
// {done, total}: how many of the app's files are saved on the device
function offlineStatus() {
  return caches.open(CACHE).then(function (c) {
    return manifest().catch(function () { return cachedManifest(c); }).then(function (m) {
      var paths = Object.keys(m.files);
      return Promise.all(paths.map(function (p) { return c.match(p); })).then(function (hits) {
        return { done: hits.filter(Boolean).length, total: paths.length };
      });
    });
  });
}
// "Download" button: fetch whatever is missing from the current cache
function download() {
  return Promise.all([manifest(), caches.open(CACHE)]).then(function (r) {
    return fill(r[1], r[0], r[1], r[0]);  // reuse what this cache already has
  }).then(offlineStatus);
}

self.addEventListener('install', function (e) {
  e.waitUntil(install().then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// the page asks: {type: 'offline-status'} or {type: 'download'}; answer on the port
self.addEventListener('message', function (e) {
  var port = e.ports[0];
  if (!port) return;
  var job = e.data && e.data.type === 'download' ? download() : offlineStatus();
  job.then(function (st) { port.postMessage(st); }, function (err) { port.postMessage({ error: String(err) }); });
});
// Network first (so updates arrive when online), cache as fallback (offline).
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(function (res) {
    var copy = res.clone();
    if (res.ok) caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
    return res;
  }).catch(function () { return caches.match(e.request, { ignoreSearch: true }); }));
});
