#!/usr/bin/env node
/**
 * build_water_index.mjs — makes the rivers and lakes of data/water.geojson learnable (the
 * "Rivers & lakes" mode of the app; experimental, see CLAUDE.md for how to remove it).
 *
 *   node tools/build_water.mjs && node tools/build_water_index.mjs
 *
 * Reads data/water.geojson (from build_water.mjs), data/world.geojson and data/countries.json, and
 *   - merges the pieces of each named river / lake (z <= MAX_Z) into one feature with an `id`
 *     (same kind + name, pieces within GAP_DEG of each other; e.g. the Rio Grande of the US and
 *     the Grande of Brazil stay apart), rewriting data/water.geojson in place;
 *   - writes data/water.json: [{id, name, kind, z, lon, lat, countries, continents}] where lon/lat
 *     is the label point (lakes: pole of inaccessibility; rivers: halfway along the longest
 *     piece) and countries are the ones the feature lies in (sampled vertices, point in polygon).
 * Idempotent: running it again on its own output gives the same files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointInGeometry, flagPoint, polygonsOf } from './geo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_Z = 5;      // quizzable: shown at country scale or earlier
const GAP_DEG = 3;    // pieces of the same name further apart than this are different features
const SAMPLES = 60;   // vertices sampled per feature to find its countries

const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const water = read('data/water.geojson');
const world = read('data/world.geojson');
const countries = read('data/countries.json');
const continentOf = new Map(countries.map((c) => [c.id, c.continent]));
// the app counts Russia and Turkey as Europe; for water the part of the country matters
// (the Ob or Lake Van are not European): Asian Russia east of the Urals, Anatolia
const continentAt = (id, [x, y]) => (id === 'ru' && x > 60) || (id === 'tr' && !(x < 29.2 && y > 40.5)) ? 'Asia' : continentOf.get(id);

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const linesOf = (g) => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : polygonsOf(g).map((p) => p[0]));
function bbox(g) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const l of linesOf(g)) for (const [x, y] of l) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}
const gap = (a, b) => Math.max(0, a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]);

// ---- group pieces: same kind + name, close together ------------------------------------------
const keep = [], groups = new Map();
for (const f of water.features) {
  const { k, z, n } = f.properties;
  if (!n || z > MAX_Z) { keep.push({ type: 'Feature', properties: { k, z, ...(n ? { n } : {}) }, geometry: f.geometry }); continue; }
  const key = k + '|' + n;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ f, box: bbox(f.geometry) });
}
const merged = [];
for (const pieces of groups.values()) {
  // union-find over pieces whose boxes are within GAP_DEG
  const parent = pieces.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++)
    if (gap(pieces[i].box, pieces[j].box) <= GAP_DEG) parent[find(i)] = find(j);
  const clusters = new Map();
  pieces.forEach((p, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(p.f); });
  for (const fs_ of clusters.values()) merged.push(fs_);
}

// ---- countries (point in polygon on sampled vertices) ------------------------------------------
const worldBoxes = world.features.map((f) => ({ id: f.properties.id, geom: f.geometry, box: bbox(f.geometry) }));
function countriesOf(geom, label) {
  const pts = linesOf(geom).flat();
  const step = Math.max(1, Math.floor(pts.length / SAMPLES));
  const sample = [label, ...pts.filter((_, i) => i % step === 0)];
  const hits = new Map(), conts = new Map();
  for (const p of sample) for (const c of worldBoxes) {
    const b = c.box;
    if (p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3]) continue;
    if (pointInGeometry(p, c.geom)) {
      hits.set(c.id, (hits.get(c.id) || 0) + 1);
      const ct = continentAt(c.id, p);
      if (ct) conts.set(ct, (conts.get(ct) || 0) + 1);
      break;
    }
  }
  const min = Math.max(1, Math.round(sample.length * 0.03));  // ignore a stray sample at a border
  const ok = ([id, n]) => n >= min;
  return {
    countries: [...hits].filter(([id, n]) => ok([id, n]) && continentOf.has(id)).sort((a, b) => b[1] - a[1]).map(([id]) => id),
    continents: [...conts].filter(ok).sort((a, b) => b[1] - a[1]).map(([c]) => c),
  };
}

// a river's label point: halfway along its longest piece
function midpoint(lines) {
  const len = (l) => l.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0);
  const l = lines.reduce((a, b) => (len(b) > len(a) ? b : a));
  let half = len(l) / 2;
  for (let i = 1; i < l.length; i++) {
    const d = Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
    if (half <= d) return l[i];
    half -= d;
  }
  return l[l.length - 1];
}

// ---- features + index ------------------------------------------------------------------------
const items = [], used = new Map(), out = [];
for (const fs_ of merged.sort((a, b) => (a[0].properties.n + a[0].properties.k).localeCompare(b[0].properties.n + b[0].properties.k) || bbox(a[0].geometry)[0] - bbox(b[0].geometry)[0])) {
  const { k, n } = fs_[0].properties;
  const z = Math.min(...fs_.map((f) => f.properties.z));
  const geometry = k === 'lake'
    ? { type: 'MultiPolygon', coordinates: fs_.flatMap((f) => polygonsOf(f.geometry)) }
    : { type: 'MultiLineString', coordinates: fs_.flatMap((f) => linesOf(f.geometry)) };
  const label = k === 'lake' ? flagPoint(geometry) : midpoint(geometry.coordinates);
  const { countries: cs, continents } = countriesOf(geometry, label);
  if (!cs.length || !continents.length) { out.push({ type: 'Feature', properties: { k, z, n }, geometry }); continue; }  // e.g. Antarctica
  const base = `w-${k[0]}-${slug(n) || 'x'}`;
  used.set(base, (used.get(base) || 0) + 1);
  const id = used.get(base) > 1 ? `${base}-${used.get(base)}` : base;
  out.push({ type: 'Feature', properties: { k, z, n, id }, geometry });
  const r3 = (v) => Math.round(v * 1000) / 1000;
  items.push({ id, name: n, kind: k, z, lon: r3(label[0]), lat: r3(label[1]), countries: cs, continents });
}

water.features = [...out, ...keep];
fs.writeFileSync(path.join(ROOT, 'data/water.geojson'), JSON.stringify(water));
items.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id));
fs.writeFileSync(path.join(ROOT, 'data/water.json'), '[\n' + items.map((x) => '  ' + JSON.stringify(x)).join(',\n') + '\n]\n');
const by = (k, z) => items.filter((x) => x.kind === k && x.z <= z).length;
console.log(`water.json: ${items.length} items (rivers z<=3/4/5: ${by('river', 3)}/${by('river', 4)}/${by('river', 5)}, lakes: ${by('lake', 3)}/${by('lake', 4)}/${by('lake', 5)}); ` +
  `water.geojson ${fs.statSync(path.join(ROOT, 'data/water.geojson')).size} B`);
for (const n of ['Rhine', 'Danube', 'Aare', 'Nile', 'Lake Geneva', 'Lake Zurich', 'Lake Victoria', 'Mississippi', 'Amazon', 'Volga', 'Ob', 'Lake Van', 'Biya']) {
  const x = items.filter((i) => i.name === n);
  console.log(' ', n, x.map((i) => `${i.id} z${i.z} [${i.countries.join(' ')}] ${i.continents.join('/')}`).join(' | ') || 'MISSING');
}
