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
 *       Natural Earth 1:50m admin-0 countries (public domain), as world-atlas@2 countries-50m.json
 *       (TopoJSON, ids = ISO 3166-1 numeric), converted with topojson-client.
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
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.CACHE_DIR || path.join(os.tmpdir(), 'learn_the_country_cache');
const DATA_DIR = path.join(ROOT, 'data');
const FLAGS_DIR = path.join(ROOT, 'flags');

const FLAG_ICONS_VERSION = '7.5.0';
const SRC = {
  countries: 'https://raw.githubusercontent.com/mledoze/countries/master/countries.json',
  places: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson',
  atlas: 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json',
  topojson: 'https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.js',
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

// world-atlas geometries without an ISO numeric id, keyed by their NE name.
// value = iso2 to merge into, or null to drop.
const UNNUMBERED_GEOMETRIES = {
  'Kosovo': 'XK',
  'Somaliland': 'SO',       // merged into Somalia
  'N. Cyprus': 'CY',        // merged into Cyprus
  'Siachen Glacier': 'IN',  // de facto administered by India
  'Indian Ocean Ter.': null, // Christmas/Cocos sliver, dropped
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

function buildWorld(topology, topojson, mledoze, countries) {
  const n3ToIso = Object.fromEntries(mledoze.map((c) => [c.ccn3, c.cca2]));
  const wanted = new Set(countries.map((c) => c.id));

  // Group geometries by target iso2 so merges (Somaliland -> SO, ...) dissolve shared borders.
  const groups = new Map();
  for (const g of topology.objects.countries.geometries) {
    let iso;
    if (/^\d{3}$/.test(g.id ?? '')) iso = n3ToIso[g.id];
    else iso = UNNUMBERED_GEOMETRIES[g.properties.name];
    if (iso === undefined) throw new Error(`unmapped geometry: ${g.id} ${g.properties.name}`);
    if (iso === null) continue;
    (groups.has(iso) ? groups.get(iso) : groups.set(iso, []).get(iso)).push(g);
  }

  const roundRing = (ring) => ring.map(([x, y]) => [round3(x), round3(y)]);
  const roundGeom = (geom) => {
    if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(roundRing) };
    if (geom.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: geom.coordinates.map((p) => p.map(roundRing)) };
    throw new Error(`unexpected geometry type ${geom.type}`);
  };

  const features = [];
  for (const [iso, geoms] of groups) {
    const geom = geoms.length === 1
      ? topojson.feature(topology, geoms[0]).geometry
      : topojson.merge(topology, geoms);
    features.push({ type: 'Feature', properties: { id: iso.toLowerCase() }, geometry: roundGeom(geom) });
  }
  features.sort((a, b) => (a.properties.id < b.properties.id ? -1 : 1));

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
  fs.rmSync(FLAGS_DIR, { recursive: true, force: true });
  fs.mkdirSync(FLAGS_DIR, { recursive: true });
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

  const [countriesFile, placesFile, atlasFile, topoFile, flagsTgz] = await Promise.all([
    download(SRC.countries, 'mledoze-countries.json'),
    download(SRC.places, 'ne_10m_populated_places_simple.geojson'),
    download(SRC.atlas, 'countries-50m.json'),
    download(SRC.topojson, 'topojson-client.cjs'),
    download(SRC.flags, `flag-icons-${FLAG_ICONS_VERSION}.tgz`),
  ]);

  const mledoze = readJson(countriesFile);
  const countries = buildCountries(mledoze, readJson(placesFile));
  const countriesPath = path.join(DATA_DIR, 'countries.json');
  fs.writeFileSync(countriesPath, '[\n' + countries.map((c) => '  ' + JSON.stringify(c)).join(',\n') + '\n]\n');
  const nSov = countries.filter((c) => c.sovereign).length;
  console.log(`countries.json: ${countries.length} entries (${nSov} sovereign, ${countries.length - nSov} territories), ${fs.statSync(countriesPath).size} bytes`);

  const topojson = createRequire(import.meta.url)(topoFile);
  const { fc, noPolygon, extra } = buildWorld(readJson(atlasFile), topojson, mledoze, countries);
  const worldPath = path.join(DATA_DIR, 'world.geojson');
  fs.writeFileSync(worldPath, JSON.stringify(fc));
  console.log(`world.geojson: ${fc.features.length} features, ${fs.statSync(worldPath).size} bytes`);
  console.log(`  ids without polygon (shown as dots): ${noPolygon.join(', ')}`);
  console.log(`  polygons not in countries.json: ${extra.join(', ')}`);

  const flagBytes = buildFlags(flagsTgz, countries);
  console.log(`flags/: ${countries.length} svg files, ${flagBytes} bytes`);
}

main().catch((e) => { console.error(e); process.exit(1); });
