#!/usr/bin/env node
/**
 * build_data.mjs — rebuilds the offline data for the flags-and-capitals app.
 *
 *   node tools/build_data.mjs            (downloads sources into a cache dir, then writes:)
 *     data/countries.json   one entry per country/territory, sorted by name
 *     data/world.geojson    country polygons, properties.id = iso2 lowercase
 *     flags/<id>.svg        one flag per countries.json entry
 *
 * Sources (all downloaded at build time, cached in $CACHE_DIR or <os tmp>/learn_the_country_cache):
 *   - Country list, names, capitals, regions, UN membership:
 *       mledoze/countries (ODbL-1.0)  https://github.com/mledoze/countries  (countries.json)
 *       (this is the dataset behind restcountries.com; its v3.1 API has been retired)
 *   - Capital coordinates:
 *       Natural Earth 1:10m populated places (public domain), via nvkelso/natural-earth-vector
 *       Entries missing there are filled from the CAPITAL_COORDS table below.
 *   - Country shapes:
 *       Natural Earth 1:50m admin-0 countries (public domain), the GeoJSON from
 *       nvkelso/natural-earth-vector. Its rings are already cut at the antimeridian
 *       (no ring jumps from +180 to -180), which MapLibre's globe needs. Somaliland, N. Cyprus
 *       and Siachen Glacier are dissolved into Somalia / Cyprus / India (shared border removed).
 *   - Flag position (fx, fy in countries.json):
 *       pole of inaccessibility (polylabel algorithm, reimplemented in tools/geo.mjs after
 *       mapbox/polylabel, ISC) of each country's largest polygon, computed in a plane where
 *       longitude is scaled by cos(mean latitude) of that polygon.
 *   - Flags:
 *       flag-icons npm package (MIT) https://github.com/lipis/flag-icons, flags/4x3/ set.
 *
 * Only data/, flags/ and the cache directory are written. No build step or deps are needed:
 * runs on Node >= 18 (uses global fetch) plus the system `tar` binary.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { polygonsOf, ringArea, flagPoint, assertNoAntimeridianJumps } from './geo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.CACHE_DIR || path.join(os.tmpdir(), 'learn_the_country_cache');
const DATA_DIR = path.join(ROOT, 'data');
const FLAGS_DIR = path.join(ROOT, 'flags');

const FLAG_ICONS_VERSION = '7.5.0';
const SRC = {
  countries: 'https://raw.githubusercontent.com/mledoze/countries/master/countries.json',
  places: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson',
  shapes: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson',
  flags: `https://registry.npmjs.org/flag-icons/-/flag-icons-${FLAG_ICONS_VERSION}.tgz`,
};

// ---------------------------------------------------------------------------
// Curation tables
// ---------------------------------------------------------------------------

// Non-UN entities treated as sovereign for the app.
const EXTRA_SOVEREIGN = new Set(['VA', 'PS', 'XK', 'TW']);

// Inhabited dependent territories to include (sovereign:false). Everything else that is not
// sovereign (uninhabited islands, French overseas departments which are integral parts of
// France, Svalbard which has no flag of its own, ...) is skipped.
const TERRITORIES = new Set([
  'GL', 'FO',                               // Denmark
  'PR', 'GU', 'VI', 'AS', 'MP',             // United States
  'HK', 'MO',                               // China
  'EH',                                     // Western Sahara (disputed)
  'NC', 'PF', 'WF', 'PM', 'BL', 'MF',       // France (overseas collectivities)
  'BM', 'KY', 'VG', 'AI', 'MS', 'TC', 'FK', 'GI', 'SH', 'PN', // United Kingdom
  'IM', 'JE', 'GG',                         // British Crown dependencies
  'AW', 'CW', 'SX', 'BQ',                   // Kingdom of the Netherlands
  'CK', 'NU', 'TK',                         // New Zealand
  'NF', 'CX', 'CC',                         // Australia
  'AX',                                     // Finland
]);

// Common English names where the source uses something else.
const NAME_OVERRIDES = {
  TR: 'Turkey',
  CG: 'Republic of the Congo',
  CD: 'DR Congo',
  SH: 'Saint Helena',
  FM: 'Micronesia',
  BQ: 'Caribbean Netherlands',
};

// One capital per entry, using the seat of government commonly taught.
const CAPITAL_OVERRIDES = {
  ZA: 'Pretoria',
  BO: 'Sucre',
  NL: 'Amsterdam',
  LK: 'Sri Jayawardenepura Kotte',
  SZ: 'Mbabane',
  EH: 'Laayoune',
  MN: 'Ulaanbaatar',
  US: 'Washington, D.C.',
  KI: 'Tarawa',
  BQ: 'Kralendijk',
  MO: 'Macau',        // city-territory, empty in source
  HK: 'Hong Kong',    // city-territory ("City of Victoria" in source)
  PF: 'Papeete',
  GG: 'Saint Peter Port',
};

// Capital coordinates (lat, lon) for capitals absent from Natural Earth populated places,
// or where the NE record is not the one we want. Looked up manually.
const CAPITAL_COORDS = {
  LK: [6.894, 79.902],   // Sri Jayawardenepura Kotte
  NR: [-0.547, 166.921], // Yaren
  EH: [27.15, -13.2],    // Laayoune (NE files it under Morocco)
  AI: [18.217, -63.057], // The Valley
  SH: [-15.925, -5.718], // Jamestown
  GG: [49.456, -2.536],  // Saint Peter Port
  GU: [13.476, 144.75],  // Hagåtña
  JE: [49.187, -2.107],  // Saint Helier
  MP: [15.188, 145.751], // Saipan
  MS: [16.706, -62.215], // Plymouth
  PM: [46.776, -56.177], // Saint-Pierre
  TC: [21.461, -71.142], // Cockburn Town
  VG: [18.427, -64.62],  // Road Town
  VI: [18.342, -64.931], // Charlotte Amalie
  WF: [-13.282, -176.176], // Mata-Utu
  PW: [7.5, 134.624],    // Ngerulmud
  BQ: [12.151, -68.277], // Kralendijk
  PN: [-25.067, -130.1], // Adamstown
  TK: [-9.38, -171.22],  // Fakaofo
  CC: [-12.157, 96.823], // West Island
  CX: [-10.422, 105.679],// Flying Fish Cove
  NF: [-29.056, 167.96], // Kingston
  BL: [17.896, -62.85],  // Gustavia
  MF: [18.067, -63.083], // Marigot
  AX: [60.097, 19.935],  // Mariehamn
  SX: [18.026, -63.045], // Philipsburg
  MO: [22.199, 113.543], // Macau
  HK: [22.279, 114.163], // Hong Kong
  VA: [41.903, 12.453],  // Vatican City
  SG: [1.29, 103.852],   // Singapore
  MC: [43.738, 7.425],   // Monaco
  GI: [36.141, -5.353],  // Gibraltar
  TV: [-8.521, 179.197], // Funafuti
};

// Natural Earth lists several capitals for a few countries; prefer these specific records.
// Map iso2 -> NE "name" to use (defaults to the single "Admin-0 capital" record).
const NE_NAME_HINT = {
  ZA: 'Pretoria', BO: 'Sucre', NL: 'Amsterdam', CI: 'Yamoussoukro', MM: 'Naypyidaw',
  IL: 'Jerusalem', TZ: 'Dodoma', BJ: 'Porto-Novo', NG: 'Abuja', MY: 'Kuala Lumpur',
  CL: 'Santiago', JP: 'Tokyo', PH: 'Manila', MA: 'Rabat', SZ: 'Mbabane', LK: 'Colombo',
};

// Natural Earth features whose ISO_A2_EH is not a usable code, keyed by ADM0_A3.
// value = iso2 to dissolve into, or null to drop.
const SHAPE_OVERRIDES = {
  SOL: 'SO',   // Somaliland -> Somalia
  CYN: 'CY',   // N. Cyprus -> Cyprus
  KAS: 'IN',   // Siachen Glacier -> India (de facto administered)
  IOA: null,   // Indian Ocean Territories (Christmas/Cocos sliver, no polygon in the app)
  ATC: null,   // Ashmore and Cartier Islands (uninhabited)
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
const round3 = (n) => Math.round(n * 1000) / 1000;

function continentOf(c) {
  if (c.cca2 === 'TR' || c.cca2 === 'RU') return 'Europe';
  switch (c.region) {
    case 'Americas': return c.subregion === 'South America' ? 'South America' : 'North America';
    case 'Africa': case 'Asia': case 'Europe': case 'Oceania': return c.region;
    default: throw new Error(`no continent for ${c.cca2} (${c.region})`);
  }
}

// ---------------------------------------------------------------------------
// Polygon dissolve: union of two polygons that share an exact common border (as Natural
// Earth features do). Directed edges that appear in both directions cancel; the remaining
// edges are chained back into rings. Rings with the orientation of the original outer ring
// become outers, the rest holes.
// ---------------------------------------------------------------------------

function dissolve(polyA, polyB) {
  const key = (p) => `${p[0]},${p[1]}`;
  const edges = new Map(); // "from|to" -> [from, to]
  for (const poly of [polyA, polyB]) for (const ring of poly) {
    for (let i = 1; i < ring.length; i++) edges.set(`${key(ring[i - 1])}|${key(ring[i])}`, [ring[i - 1], ring[i]]);
  }
  for (const k of [...edges.keys()]) {
    const [a, b] = k.split('|');
    if (edges.has(`${b}|${a}`)) { edges.delete(k); edges.delete(`${b}|${a}`); }
  }
  const next = new Map(); // from -> [edge keys]
  for (const [k, [a]] of edges) (next.get(key(a)) ?? next.set(key(a), []).get(key(a))).push(k);
  const rings = [];
  while (edges.size) {
    const start = edges.keys().next().value;
    const ring = [edges.get(start)[0]];
    let cur = start;
    while (cur) {
      const [, to] = edges.get(cur);
      edges.delete(cur);
      ring.push(to);
      const out = (next.get(key(to)) ?? []).filter((k) => edges.has(k));
      cur = out[0];
      if (key(to) === key(ring[0])) break;
    }
    if (key(ring[0]) !== key(ring[ring.length - 1])) throw new Error('dissolve: open ring');
    rings.push(ring);
  }
  const outerSign = Math.sign(ringArea(polyA[0]));
  const outers = rings.filter((r) => Math.sign(ringArea(r)) === outerSign);
  const holes = rings.filter((r) => Math.sign(ringArea(r)) !== outerSign);
  if (outers.length !== 1) throw new Error(`dissolve: expected 1 outer ring, got ${outers.length}`);
  return [outers[0], ...holes];
}

// Merge feature B's polygons into feature A's geometry. Polygons that touch are dissolved,
// the others are appended as they are.
function mergeGeometries(geomA, geomB) {
  const polysA = polygonsOf(geomA).map((p) => p);
  const polysB = polygonsOf(geomB);
  const vertexSet = (poly) => new Set(poly.flat().map((p) => `${p[0]},${p[1]}`));
  for (const pb of polysB) {
    const vb = vertexSet(pb);
    const i = polysA.findIndex((pa) => pa[0].some((p) => vb.has(`${p[0]},${p[1]}`)));
    if (i === -1) polysA.push(pb);
    else polysA[i] = dissolve(polysA[i], pb);
  }
  return polysA.length === 1 ? { type: 'Polygon', coordinates: polysA[0] } : { type: 'MultiPolygon', coordinates: polysA };
}

// ---------------------------------------------------------------------------
// 1. countries.json
// ---------------------------------------------------------------------------

function buildCountries(mledoze, places) {
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // Index NE populated places by iso_a2 and by adm0name (territory capitals are tagged as
  // "Admin-0 region capital" / "Admin-1 capital", sometimes under the parent's iso code).
  // Records are ranked by feature class so a national capital wins over a same-named
  // lesser place (NE has e.g. an "Admin-1 capital" mislabelled "Niamey" that is Maradi).
  const RANK = { 'Admin-0 capital': 0, 'Admin-0 capital alt': 1, 'Admin-0 region capital': 2, 'Admin-1 capital': 3 };
  const byIso = {};
  const byAdm0 = {};
  for (const f of places.features) {
    const p = f.properties;
    const rec = {
      name: norm(p.name), nameascii: norm(p.nameascii), rank: RANK[p.featurecla] ?? 9,
      lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
    };
    (byIso[p.iso_a2] ??= []).push(rec);
    (byAdm0[norm(p.adm0name)] ??= []).push(rec);
  }
  for (const list of [...Object.values(byIso), ...Object.values(byAdm0)]) list.sort((a, b) => a.rank - b.rank);

  const out = [];
  const missingCoords = [];
  for (const c of mledoze) {
    const iso = c.cca2;
    const sovereign = (c.unMember && iso !== 'VA') || EXTRA_SOVEREIGN.has(iso);
    if (!sovereign && !TERRITORIES.has(iso)) continue;

    const name = NAME_OVERRIDES[iso] ?? c.name.common;
    const capital = CAPITAL_OVERRIDES[iso] ?? c.capital[0];
    if (!capital) throw new Error(`no capital for ${iso}`);

    let coords = CAPITAL_COORDS[iso];
    if (!coords) {
      const cands = [...(byIso[iso] ?? []), ...(byAdm0[norm(name)] ?? [])];
      const hint = norm(NE_NAME_HINT[iso] ?? capital);
      const hit = cands.find((x) => x.name === hint || x.nameascii === hint)
        ?? cands.find((x) => x.rank === 0);
      if (hit) coords = [hit.lat, hit.lon];
    }
    if (!coords) { missingCoords.push(`${iso} ${capital}`); coords = [NaN, NaN]; }

    out.push({
      id: iso.toLowerCase(),
      name,
      capital,
      lat: round3(coords[0]),
      lon: round3(coords[1]),
      continent: continentOf(c),
      sovereign,
    });
  }
  if (missingCoords.length) throw new Error(`capital coordinates missing: ${missingCoords.join(', ')}`);
  out.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return out;
}

// ---------------------------------------------------------------------------
// 2. world.geojson
// ---------------------------------------------------------------------------

function buildWorld(ne, countries) {
  const wanted = new Set(countries.map((c) => c.id));

  // Group NE features by target iso2 (dissolving Somaliland into Somalia etc.).
  const geoms = new Map();
  for (const f of ne.features) {
    const p = f.properties;
    let iso = p.ADM0_A3 in SHAPE_OVERRIDES ? SHAPE_OVERRIDES[p.ADM0_A3] : p.ISO_A2_EH;
    if (iso === null) continue;
    if (!/^[A-Z]{2}$/.test(iso)) throw new Error(`unmapped NE feature: ${p.NAME} (${p.ADM0_A3})`);
    geoms.set(iso, geoms.has(iso) ? mergeGeometries(geoms.get(iso), f.geometry) : f.geometry);
  }

  const roundRing = (ring) => {
    const out = [];
    for (const [x, y] of ring) {
      const p = [round3(x), round3(y)];
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p); // drop duplicates created by rounding
    }
    return out;
  };
  const roundPoly = (poly) => poly.map(roundRing).filter((r) => r.length >= 4);

  const features = [];
  for (const [iso, geom] of geoms) {
    const polys = polygonsOf(geom).map(roundPoly).filter((p) => p.length && p[0].length >= 4);
    const rounded = polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
    features.push({ type: 'Feature', properties: { id: iso.toLowerCase() }, geometry: rounded });
  }
  features.sort((a, b) => (a.properties.id < b.properties.id ? -1 : 1));

  assertNoAntimeridianJumps(features); // MapLibre's globe cannot handle rings that jump across the antimeridian

  const withPolygon = new Set(features.map((f) => f.properties.id));
  const noPolygon = countries.filter((c) => !withPolygon.has(c.id)).map((c) => c.id);
  const extra = features.map((f) => f.properties.id).filter((id) => !wanted.has(id));
  return { fc: { type: 'FeatureCollection', features }, noPolygon, extra };
}

// ---------------------------------------------------------------------------
// 3. flags
// ---------------------------------------------------------------------------

function buildFlags(tarball, countries) {
  const pkgDir = path.join(CACHE, `flag-icons-${FLAG_ICONS_VERSION}`);
  if (!fs.existsSync(path.join(pkgDir, 'package', 'flags', '4x3'))) {
    fs.mkdirSync(pkgDir, { recursive: true });
    execFileSync('tar', ['xzf', tarball, '-C', pkgDir]);
  }
  fs.mkdirSync(FLAGS_DIR, { recursive: true }); // files are overwritten in place, nothing else in flags/ is removed
  let bytes = 0;
  for (const c of countries) {
    const src = path.join(pkgDir, 'package', 'flags', '4x3', `${c.id}.svg`);
    if (!fs.existsSync(src)) throw new Error(`no flag for ${c.id}`);
    fs.copyFileSync(src, path.join(FLAGS_DIR, `${c.id}.svg`));
    bytes += fs.statSync(src).size;
  }
  return bytes;
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const [countriesFile, placesFile, shapesFile, flagsTgz] = await Promise.all([
    download(SRC.countries, 'mledoze-countries.json'),
    download(SRC.places, 'ne_10m_populated_places_simple.geojson'),
    download(SRC.shapes, 'ne_50m_admin_0_countries.geojson'),
    download(SRC.flags, `flag-icons-${FLAG_ICONS_VERSION}.tgz`),
  ]);

  const mledoze = readJson(countriesFile);
  const countries = buildCountries(mledoze, readJson(placesFile));

  const { fc, noPolygon, extra } = buildWorld(readJson(shapesFile), countries);
  const worldPath = path.join(DATA_DIR, 'world.geojson');
  fs.writeFileSync(worldPath, JSON.stringify(fc));
  console.log(`world.geojson: ${fc.features.length} features, ${fs.statSync(worldPath).size} bytes`);
  console.log(`  ids without polygon (shown as dots): ${noPolygon.join(', ')}`);
  console.log(`  polygons not in countries.json: ${extra.join(', ')}`);

  // Countries whose largest part is not the one people picture: use the part nearest the capital
  // (Kiribati: Tarawa, not Kiritimati; Malaysia: the peninsula, not Borneo).
  const FLAG_AT_CAPITAL_PART = new Set(['ki', 'my']);
  const partNearest = (g, lon, lat) => {
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const d = (poly) => Math.min(...poly[0].map(([x, y]) => (x - lon) ** 2 + (y - lat) ** 2));
    return { type: 'Polygon', coordinates: polys.reduce((a, b) => (d(b) < d(a) ? b : a)) };
  };
  // Flag anchor per country (from the written, rounded geometry so it matches what the app draws).
  const geomById = new Map(fc.features.map((f) => [f.properties.id, f.geometry]));
  for (const c of countries) {
    const g = geomById.get(c.id);
    const [fx, fy] = g ? flagPoint(FLAG_AT_CAPITAL_PART.has(c.id) ? partNearest(g, c.lon, c.lat) : g) : [c.lon, c.lat];
    c.fx = round3(fx);
    c.fy = round3(fy);
  }
  const countriesPath = path.join(DATA_DIR, 'countries.json');
  fs.writeFileSync(countriesPath, '[\n' + countries.map((c) => '  ' + JSON.stringify(c)).join(',\n') + '\n]\n');
  const nSov = countries.filter((c) => c.sovereign).length;
  console.log(`countries.json: ${countries.length} entries (${nSov} sovereign, ${countries.length - nSov} territories), ${fs.statSync(countriesPath).size} bytes`);

  const flagBytes = buildFlags(flagsTgz, countries);
  console.log(`flags/: ${countries.length} svg files, ${flagBytes} bytes`);
}

main().catch((e) => { console.error(e); process.exit(1); });
