#!/usr/bin/env node
/**
 * build_water.mjs — builds the lakes and major rivers the map draws on top of the country shapes,
 * so that someone zoomed into a country (a "deep dive") can orient themselves by them.
 *
 *   node tools/build_water.mjs            (downloads sources into a cache dir, then writes:)
 *     data/water.geojson    one FeatureCollection, properties { k: 'lake' | 'river', z, n }
 *                             k  kind
 *                             z  minimum zoom at which to show the feature (1 .. 6, integer)
 *                             n  short name (English where a common one exists), absent if unnamed
 *
 * Sources (all downloaded at build time, cached in $CACHE_DIR or <os tmp>/learn_the_country_cache):
 *   Natural Earth 1:10m physical vectors (public domain), the GeoJSON from nvkelso/natural-earth-vector:
 *     ne_10m_lakes                   lakes and reservoirs of the world (the Caspian Sea is not among
 *                                    them: Natural Earth files it as ocean, and so does the app)
 *     ne_10m_lakes_europe            supplement with the smaller European lakes (Zurich, Lucerne, ...)
 *     ne_10m_rivers_lake_centerlines rivers of the world; their "Lake Centerline" pieces (the course
 *                                    of a river through a lake) are left out, the lake is drawn there
 *     ne_10m_rivers_europe           supplement with the smaller European rivers (Aare, Reuss, ...);
 *                                    its "Intermittent River" pieces are left out
 *   The supplements only add detail (their rivers do not retrace the base rivers), but a lake
 *   present in both sets is taken from the base set, and a supplement river running along a base
 *   river is dropped, as a safeguard.
 *
 * Zoom: Natural Earth's min_zoom (made for a tiled map, where things may appear late) is mapped to
 * z with Z_OF below: the giants keep their zoom (Great Lakes, Baikal, Victoria at 1; Nile, Amazon,
 * Mississippi, Danube at 2), from NE 4.7 on everything appears one zoom level earlier, so a
 * country view at zoom 5-6 has its national lakes and rivers (Lake Zurich, Aare) and nothing
 * needs more than zoom 6 (Walensee, Reuss, Inn).
 *
 * Geometry: simplified with mapshaper (npm, run with npx): Douglas-Peucker with a tolerance per
 * kind and z (TOLERANCE_M, 600 m for z 6 lakes up to 4 km for the giants; it keeps the ends and
 * tips of thin Alpine lakes, which a global vertex percentage eats first), coordinates rounded to
 * 3 decimals. Lakes are simplified ring by ring with `keep-shapes`, so islands (holes) survive;
 * only slivers that collapse under the rounding (under ~100 m across) are dropped. Unnamed
 * features above z 4 are left out (UNNAMED_MAX_Z). River pieces with the same name and z are
 * merged into one MultiLineString, unnamed lakes with the same z into one MultiPolygon. Rings and
 * lines never jump across the antimeridian (asserted, MapLibre's globe cannot draw such a jump).
 *
 * Only data/water.geojson and the cache directory are written. Runs on Node >= 18 (global fetch)
 * with npm (npx mapshaper).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { polygonsOf, ringArea, pointInGeometry, roundGeometry } from './geo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.CACHE_DIR || path.join(os.tmpdir(), 'learn_the_country_cache');
const OUT = path.join(ROOT, 'data', 'water.geojson');

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const SRC = {
  lakes: `${NE}ne_10m_lakes.geojson`,
  lakesEurope: `${NE}ne_10m_lakes_europe.geojson`,
  rivers: `${NE}ne_10m_rivers_lake_centerlines.geojson`,
  riversEurope: `${NE}ne_10m_rivers_europe.geojson`,
};

const DECIMALS = 3;

// Simplification tolerance (Douglas-Peucker, metres of maximum deviation) by kind and z: a
// feature that appears at world or continental zoom is mostly looked at there (1 px is 2.4 km
// at zoom 4, 300 m at zoom 7, both at the equator), so it may be coarser than one that appears
// at zoom 6; a river (a thin line) bears a coarser tolerance than a lake outline. The rivers hold
// most of the vertices: these values are the size knob (together with UNNAMED_MAX_Z).
// The Swiss lakes and rivers are coarse in Natural Earth anyway (Lake Geneva has 39 vertices).
const TOLERANCE_M = {
  lake: { 1: 4000, 2: 4000, 3: 3000, 4: 1200, 5: 1000, 6: 600 },
  river: { 1: 4000, 2: 4000, 3: 3000, 4: 3000, 5: 2000, 6: 1500 },
};

// Unnamed features (nameless lakes and streams, mostly in Canada's, Finland's and Siberia's lake
// country) are kept down to this z (the unnamed Untersee of Lake Constance is z 4); the finer
// unnamed ones are left out, which keeps the file small and the map calm. Named features are
// always kept (Walensee, Reuss, ... are z 6).
const UNNAMED_MAX_Z = 4;

// Natural Earth min_zoom -> z (see the header). Any other value is an error, so a changed source
// is noticed.
const Z_OF = { 1: 1, 1.7: 2, 2: 2, 2.1: 2, 3: 3, 4: 4, 4.7: 4, 5: 4, 5.7: 5, 6: 5, 6.5: 6, 6.7: 6, 7: 6, 7.1: 6, 7.2: 6 };

// ---------------------------------------------------------------------------
// Curation tables
// ---------------------------------------------------------------------------

// Base lakes whose Natural Earth name belongs to another lake, by ne_id: the polygon named
// "Lago di Como" lies where Lago Maggiore is, the one named "Lago di Bracciano" where Lago di
// Bolsena is (Como and Bracciano themselves come, correctly placed, from the Europe supplement).
const LAKE_NAME_BY_NE_ID = {
  1159116693: 'Lago Maggiore',
  1159118119: 'Lago di Bolsena',
};

// Common English names for lakes the app is likely to show up close (Natural Earth's `name` is
// the local name for the Europe supplement and for many base lakes); everything else keeps its
// Natural Earth name.
const LAKE_NAMES_EN = {
  'Bodensee': 'Lake Constance',
  'Zürichsee': 'Lake Zurich',
  'Vierwaldstättersee': 'Lake Lucerne',
  'Neuchâtel': 'Lake Neuchâtel',
  'Thunersee': 'Lake Thun',
  'Brienzersee': 'Lake Brienz',
  'Bielersee': 'Lake Biel',
  'Zugersee': 'Lake Zug',
  'Murtensee': 'Lake Murten',
  'Lago di Lugano': 'Lake Lugano',
  'Lago Maggiore': 'Lake Maggiore',
  'Lago di Como': 'Lake Como',
  'Lago di Garda': 'Lake Garda',
  "Lago d'Iseo": 'Lake Iseo',
  'Lago di Bolsena': 'Lake Bolsena',
  'Lago di Bracciano': 'Lake Bracciano',
  'Trasimeno': 'Lake Trasimeno',
  "Lac d'Annecy": 'Lake Annecy',
  'Lac du Bourget': 'Lake Bourget',
  'Neusiedlersee': 'Lake Neusiedl',
  'Lago Titicaca': 'Lake Titicaca',
  'Lago Poopó': 'Lake Poopó',
  'Lago de Nicaragua': 'Lake Nicaragua',
  'Lago de Managua': 'Lake Managua',
  'Biwa Ko': 'Lake Biwa',
  'Qinghai Hu': 'Qinghai Lake',
};

// Common English names for rivers (Natural Earth's `name` is mostly the local name).
const RIVER_NAMES_EN = {
  'Donau': 'Danube',
  'Rhein': 'Rhine',
  'Rhin': 'Rhine',
  'Mosel': 'Moselle',
  'Maas': 'Meuse',
  'Schelde': 'Scheldt',
  'Tejo': 'Tagus',
  'Tajo': 'Tagus',
  'Tevere': 'Tiber',
  'Drau': 'Drava',
  'Tisa': 'Tisza',
  'Dnipro': 'Dnieper',
  'Dnepre': 'Dnieper',
  'Dnepr': 'Dnieper',
  'Buh': 'Southern Bug',
  'Zakhidnyy Buh': 'Western Bug',
  'Evros': 'Maritsa',
  'Strymnas': 'Struma',
  'Amazonas': 'Amazon',
  'Chang Jiang': 'Yangtze',
  'Huang': 'Yellow River',
  'Lancang': 'Mekong',
  'Nu': 'Salween',
  'Ayeyarwady': 'Irrawaddy',
  'Ertix': 'Irtysh',
  'Ertis': 'Irtysh',
  'El Bahr el Abyad': 'White Nile',
  'El Bahr el Azraq': 'Blue Nile',
  'Abay': 'Blue Nile',
  'Mouhoun': 'Black Volta',
  'Nakanbé': 'White Volta',
};

// Features the output must contain, with their z: the build fails if one is missing, which is
// how a changed source or a broken step gets noticed.
const EXPECT = {
  lake: {
    'Lake Superior': 1, 'Lake Victoria': 1, 'Lake Baikal': 1, 'Lake Titicaca': 2, 'Vänern': 2,
    'Lake Geneva': 4, 'Lake Constance': 4, 'Lake Neuchâtel': 5, 'Lake Lucerne': 5, 'Lake Zurich': 5,
    'Lake Maggiore': 5, 'Lake Como': 5, 'Lake Lugano': 6, 'Lake Thun': 6, 'Lake Brienz': 6,
    'Lake Biel': 6, 'Lake Zug': 6, 'Walensee': 6, 'Lake Murten': 6,
  },
  river: {
    'Nile': 2, 'Amazon': 2, 'Mississippi': 2, 'Yangtze': 2, 'Danube': 2, 'Volga': 3, 'Rhine': 4,
    'Rhône': 4, 'Elbe': 4, 'Po': 4, 'Aare': 5, 'Reuss': 6, 'Limmat': 6, 'Inn': 6, 'Ticino': 6,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function download(url, file) {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const hasGeometry = (f) => f.geometry && f.geometry.coordinates && f.geometry.coordinates.length > 0; // NE's base "Loire" has an empty geometry
const linesOf = (geom) => (geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates);

function zOf(p, what) {
  const z = Z_OF[p.min_zoom];
  if (z === undefined) throw new Error(`${what}: unexpected min_zoom ${p.min_zoom} (${p.name})`);
  return z;
}

// Natural Earth names as the app shows them: trimmed, "MURTENSEE" -> "Murtensee",
// "Lac d' Annecy" -> "Lac d'Annecy", "Lago di Lugano - Ceresio" -> "Lago di Lugano".
function cleanName(raw) {
  if (!raw) return undefined;
  let s = raw.trim().replace(/\s+/g, ' ').replace(/\b([dl]') /gi, '$1').split(' - ')[0];
  if (s.length > 3 && s === s.toUpperCase() && /[A-Z]{3}/.test(s)) s = s[0] + s.slice(1).toLowerCase();
  return s || undefined;
}

function bbox(geom) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c[0] === 'number') { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); }
    else c.forEach(walk);
  };
  walk(geom.coordinates);
  return b;
}
const bboxesTouch = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// ---------------------------------------------------------------------------
// 1. Lakes: base + Europe supplement (minus the lakes the base already has)
// ---------------------------------------------------------------------------

function collectLakes(base, europe) {
  const lakes = [];
  for (const f of base.features) {
    if (!hasGeometry(f)) continue;
    const name = LAKE_NAME_BY_NE_ID[f.properties.ne_id] ?? cleanName(f.properties.name);
    lakes.push({ k: 'lake', z: zOf(f.properties, 'lake'), n: name, geometry: f.geometry, box: bbox(f.geometry) });
  }
  // A supplement lake overlapping a base lake (some outer vertex of one inside the other) is the
  // same lake twice: keep the base one.
  const samplePoints = (geom) => polygonsOf(geom).flatMap((poly) => poly[0].filter((_, i) => i % 5 === 0));
  const overlaps = (a, b) => bboxesTouch(a.box, b.box)
    && (samplePoints(a.geometry).some((p) => pointInGeometry(p, b.geometry)) || samplePoints(b.geometry).some((p) => pointInGeometry(p, a.geometry)));
  const dropped = [];
  for (const f of europe.features) {
    if (!hasGeometry(f)) continue;
    const lake = { k: 'lake', z: zOf(f.properties, 'lake'), n: cleanName(f.properties.name), geometry: f.geometry, box: bbox(f.geometry) };
    const twin = lakes.find((b) => overlaps(lake, b));
    if (twin) dropped.push(`${lake.n ?? '?'} (= ${twin.n ?? '?'})`);
    else lakes.push(lake);
  }
  for (const l of lakes) if (l.n && LAKE_NAMES_EN[l.n]) l.n = LAKE_NAMES_EN[l.n];
  const kept = lakes.filter(isWanted);
  console.log(`lakes: ${kept.length} (${base.features.length} base + ${europe.features.length} supplement, ${dropped.length} supplement lakes already in the base: ${dropped.join(', ')}; ${lakes.length - kept.length} unnamed ones above z ${UNNAMED_MAX_Z} left out)`);
  return kept;
}

const isWanted = (f) => Boolean(f.n) || f.z <= UNNAMED_MAX_Z;

// ---------------------------------------------------------------------------
// 2. Rivers: base + Europe supplement, without lake centerlines and intermittent rivers
// ---------------------------------------------------------------------------

function collectRivers(base, europe) {
  const isRiver = (f) => f.properties.featurecla === 'River' && hasGeometry(f);
  const rivers = base.features.filter(isRiver).map((f) => ({ k: 'river', z: zOf(f.properties, 'river'), n: cleanName(f.properties.name), geometry: f.geometry }));

  // Grid index of the base river segments, to spot supplement rivers retracing them.
  const CELL = 0.1, NEAR = 0.03; // degrees; NEAR is about 2-3 km
  const grid = new Map();
  const segments = [];
  for (const r of rivers) for (const line of linesOf(r.geometry)) for (let i = 1; i < line.length; i++) {
    const seg = [line[i - 1], line[i]];
    const id = segments.push(seg) - 1;
    const [x0, x1] = [Math.min(seg[0][0], seg[1][0]), Math.max(seg[0][0], seg[1][0])].map((x) => Math.floor(x / CELL));
    const [y0, y1] = [Math.min(seg[0][1], seg[1][1]), Math.max(seg[0][1], seg[1][1])].map((y) => Math.floor(y / CELL));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = `${x},${y}`; (grid.get(k) ?? grid.set(k, []).get(k)).push(id); }
  }
  const segDist = ([px, py], [[ax, ay], [bx, by]]) => {
    let x = ax, y = ay;
    const dx = bx - ax, dy = by - ay;
    if (dx || dy) { const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); x += dx * t; y += dy * t; }
    return Math.hypot(px - x, py - y);
  };
  const nearBase = (p) => {
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (const id of grid.get(`${x},${y}`) ?? []) if (segDist(p, segments[id]) < NEAR) return true;
    return false;
  };

  const dropped = [];
  let nIntermittent = 0;
  for (const f of europe.features) {
    if (f.properties.featurecla === 'Intermittent River') nIntermittent++;
    if (!isRiver(f)) continue;
    const pts = linesOf(f.geometry).flat();
    const onBase = pts.filter(nearBase).length / pts.length;
    if (onBase >= 0.5) { dropped.push(`${cleanName(f.properties.name) ?? '?'} (${pts.length} pts)`); continue; }
    rivers.push({ k: 'river', z: zOf(f.properties, 'river'), n: cleanName(f.properties.name), geometry: f.geometry });
  }
  for (const r of rivers) if (r.n && RIVER_NAMES_EN[r.n]) r.n = RIVER_NAMES_EN[r.n];
  const kept = rivers.filter(isWanted);
  const nCenterlines = [...base.features, ...europe.features].filter((f) => f.properties.featurecla === 'Lake Centerline').length;
  console.log(`rivers: ${kept.length} pieces (${nCenterlines} lake centerlines and ${nIntermittent} intermittent rivers left out, ${dropped.length} supplement rivers retracing base rivers: ${dropped.join(', ')}; ${rivers.length - kept.length} unnamed pieces above z ${UNNAMED_MAX_Z} left out)`);
  return kept;
}

// ---------------------------------------------------------------------------
// 3. Simplification with mapshaper
// ---------------------------------------------------------------------------

// Douglas-Peucker with the tolerance each feature carries in its `t` property (metres); the
// output is rounded to DECIMALS by mapshaper itself.
function mapshaper(input, output) {
  const args = [input, '-simplify', 'dp', 'variable', 'interval=t', 'keep-shapes', '-o', output, 'format=geojson', `precision=${10 ** -DECIMALS}`, 'force'];
  execFileSync('npx', ['--yes', 'mapshaper', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  return readJson(output).features;
}

// Lakes go through mapshaper one ring per feature, so `keep-shapes` protects every island.
function simplifyLakes(lakes, dir) {
  const rings = [];
  lakes.forEach((lake, i) => polygonsOf(lake.geometry).forEach((poly, p) => poly.forEach((ring, r) => {
    rings.push({ type: 'Feature', properties: { i, p, r, t: TOLERANCE_M.lake[lake.z] }, geometry: { type: 'Polygon', coordinates: [ring] } });
  })));
  fs.writeFileSync(path.join(dir, 'lakes-in.geojson'), JSON.stringify({ type: 'FeatureCollection', features: rings }));
  console.log(`mapshaper lakes: ${lakes.length} lakes, ${rings.length} rings`);
  const out = mapshaper(path.join(dir, 'lakes-in.geojson'), path.join(dir, 'lakes-out.geojson'));

  // Reassemble: polygons[i][p] = [outer, ...holes]; a ring that collapsed is left out.
  const polygons = lakes.map(() => []);
  const collapsed = [], split = [];
  for (const f of out) {
    const { i, p, r } = f.properties;
    // mapshaper splits a self-touching ring into several: keep the largest piece.
    const pieces = hasGeometry(f) ? polygonsOf(f.geometry).flat().filter((ring) => ring.length >= 4) : [];
    if (!pieces.length) { collapsed.push(`${lakes[i].n ?? '?'}${r ? ' (island)' : ''}`); continue; }
    if (pieces.length > 1) split.push(`${lakes[i].n ?? '?'}${r ? ' (island)' : ''}`);
    const ring = pieces.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a));
    (polygons[i][p] ??= [])[r] = ring;
  }
  const result = [];
  let holes = 0;
  lakes.forEach((lake, i) => {
    const polys = [];
    for (const rings_ of polygons[i]) {
      if (!rings_ || !rings_[0]) continue; // outer ring collapsed: the island holes go with it
      const outerSign = Math.sign(ringArea(rings_[0]));
      const poly = [rings_[0]];
      for (const h of rings_.slice(1)) if (h) poly.push(Math.sign(ringArea(h)) === outerSign ? [...h].reverse() : h);
      holes += poly.length - 1;
      polys.push(poly);
    }
    if (!polys.length) return;
    const geometry = roundGeometry(polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys }, DECIMALS);
    if (!polygonsOf(geometry).length || !polygonsOf(geometry)[0].length) return;
    result.push({ k: lake.k, z: lake.z, n: lake.n, geometry });
  });
  const sourceHoles = lakes.reduce((s, l) => s + polygonsOf(l.geometry).reduce((t, p) => t + p.length - 1, 0), 0);
  console.log(`  ${result.length} lakes kept, ${holes} of ${sourceHoles} islands kept; ${collapsed.length} rings collapsed under rounding (slivers): ${collapsed.join(', ')}`);
  if (split.length) console.log(`  ${split.length} self-touching rings reduced to their largest piece: ${split.join(', ')}`);
  return result;
}

function simplifyRivers(rivers, dir) {
  const features = rivers.map((r, i) => ({ type: 'Feature', properties: { i, t: TOLERANCE_M.river[r.z] }, geometry: r.geometry }));
  fs.writeFileSync(path.join(dir, 'rivers-in.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(`mapshaper rivers: ${rivers.length} pieces`);
  const out = mapshaper(path.join(dir, 'rivers-in.geojson'), path.join(dir, 'rivers-out.geojson'));
  const result = [];
  for (const f of out) {
    const river = rivers[f.properties.i];
    if (!f.geometry) { console.log(`  river piece ${river.n ?? '?'} collapsed`); continue; }
    const lines = linesOf(f.geometry).map(roundLine).filter((l) => l.length >= 2);
    if (!lines.length) { console.log(`  river piece ${river.n ?? '?'} collapsed under rounding`); continue; }
    result.push({ k: river.k, z: river.z, n: river.n, geometry: { type: 'MultiLineString', coordinates: lines } });
  }
  return result;
}

// Like roundGeometry in geo.mjs, for a line.
function roundLine(line) {
  const f = 10 ** DECIMALS;
  const out = [];
  for (const [x, y] of line) {
    const p = [Math.round(x * f) / f, Math.round(y * f) / f];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Merge, order, check
// ---------------------------------------------------------------------------

// River pieces with the same name and z become one feature (the base set cuts rivers into many
// pieces), unnamed lakes with the same z one MultiPolygon; named lakes stay separate features.
function mergeFeatures(features) {
  const groups = new Map();
  for (const f of features) {
    const key = f.k === 'river' || !f.n ? `${f.k}|${f.z}|${f.n ?? ''}` : Symbol();
    const g = groups.get(key);
    if (!g) groups.set(key, { k: f.k, z: f.z, n: f.n, parts: [f.geometry] });
    else g.parts.push(f.geometry);
  }
  const out = [];
  for (const g of groups.values()) {
    let geometry;
    if (g.parts.length === 1) geometry = g.parts[0];
    else if (g.k === 'river') geometry = { type: 'MultiLineString', coordinates: g.parts.flatMap(linesOf) };
    else geometry = { type: 'MultiPolygon', coordinates: g.parts.flatMap(polygonsOf) };
    const properties = { k: g.k, z: g.z };
    if (g.n) properties.n = g.n;
    out.push({ type: 'Feature', properties, geometry });
  }
  const order = (f) => `${f.properties.z}|${f.properties.k}|${f.properties.n ?? '~'}`;
  out.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  return out;
}

// MapLibre's globe cannot handle rings or lines that jump across the antimeridian (+180 -> -180);
// the Natural Earth sources are cut there (see assertNoAntimeridianJumps in geo.mjs).
function assertNoAntimeridianJumps(features) {
  for (const f of features) {
    const paths = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : polygonsOf(f.geometry).flat();
    for (const p of paths) for (let i = 1; i < p.length; i++) {
      if (Math.abs(p[i][0] - p[i - 1][0]) > 180) throw new Error(`antimeridian jump in ${f.properties.k} ${f.properties.n} at ${p[i - 1]} -> ${p[i]}`);
    }
  }
}

function checkExpected(features) {
  const minZ = new Map();
  for (const f of features) {
    const key = `${f.properties.k}|${f.properties.n}`;
    minZ.set(key, Math.min(minZ.get(key) ?? Infinity, f.properties.z));
  }
  const problems = [];
  for (const [k, table] of Object.entries(EXPECT)) for (const [n, z] of Object.entries(table)) {
    const got = minZ.get(`${k}|${n}`);
    if (got !== z) problems.push(`${k} ${n}: expected z ${z}, got ${got ?? 'missing'}`);
  }
  if (problems.length) throw new Error(`unexpected output:\n  ${problems.join('\n  ')}`);
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  const files = await Promise.all(Object.entries(SRC).map(([key, url]) => download(url, path.basename(url)).then((f) => [key, f])));
  const src = Object.fromEntries(files.map(([key, f]) => [key, readJson(f)]));

  const lakes = collectLakes(src.lakes, src.lakesEurope);
  const rivers = collectRivers(src.rivers, src.riversEurope);

  const dir = path.join(CACHE, 'mapshaper');
  fs.mkdirSync(dir, { recursive: true });
  const features = mergeFeatures([...simplifyLakes(lakes, dir), ...simplifyRivers(rivers, dir)]);
  assertNoAntimeridianJumps(features);
  checkExpected(features);

  const fc = { type: 'FeatureCollection', features };
  fs.writeFileSync(OUT, JSON.stringify(fc));

  const verticesOf = (f) => (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : polygonsOf(f.geometry).flat()).reduce((t, p) => t + p.length, 0);
  const stat = (k, z) => { const fs_ = features.filter((f) => f.properties.k === k && f.properties.z === z); return `${fs_.length} ${k}s/${fs_.reduce((s, f) => s + verticesOf(f), 0)}v`; };
  const zs = [...new Set(features.map((f) => f.properties.z))].sort();
  const vertices = features.reduce((s, f) => s + verticesOf(f), 0);
  console.log(`water.geojson: ${features.length} features (${features.filter((f) => f.properties.k === 'lake').length} lakes, ${features.filter((f) => f.properties.k === 'river').length} rivers), ${vertices} vertices, ${fs.statSync(OUT).size} bytes`);
  console.log(`  by z: ${zs.map((z) => `z${z}: ${stat('lake', z)}, ${stat('river', z)}`).join('; ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
