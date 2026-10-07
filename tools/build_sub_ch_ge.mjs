#!/usr/bin/env node
/**
 * build_sub_ch_ge.mjs — offline data for the nested "deep dive" into the communes of the canton of
 * Geneva: the set `ch-ge` (45 communes), which lives inside the Swiss cantons set `ch` under its
 * item `ch-ge` (Genève).
 *
 *   node tools/build_sub_ch_ge.mjs       (downloads sources into a cache dir, then writes:)
 *     data/sub/ch-ge.json       one entry per commune, sorted by name (French collation):
 *                               {id, name, capital: null, lat, lon, fx, fy, color, flag, pop}
 *                               id = "ch-ge-" + BFS commune number (6601..6645). Communes have no
 *                               capital, so lat/lon repeat fx/fy (the pole of inaccessibility).
 *     data/sub/ch-ge.geojson    commune polygons, land only, properties.id = the json id
 *     flags/sub/ch-ge-<bfs>.svg|png   the commune's coat of arms (path in the json `flag` field)
 *     data/sub/index.json       only the `ch-ge` entry is added or replaced (other sets keep theirs)
 *
 * Same conventions as build_subdivisions.mjs and build_sub_cn.mjs; the differences:
 *   - Shapes: swisstopo swissBOUNDARIES3D (open government data, free use with source statement),
 *       the TLM_HOHEITSGEBIET layer of the shapefile release named in SRC, the "Gemeindegebiet"
 *       features of canton 25. Its LV95 coordinates (EPSG:2056) are converted to WGS84 with
 *       swisstopo's approximate formulas (accuracy ~1 m, far below the 4-decimal rounding, ~10 m).
 *       In Geneva the communes' territory extends into Lake Geneva (unlike in Vaud, where the lake
 *       belongs to no commune), so the lake is cut out with OpenStreetMap's water polygon of the
 *       lake (relation 332617, ODbL, fetched through the Overpass API); the app draws the lake
 *       itself. mapshaper (npm, run with npx; a build tool, not a dependency of the app) does the
 *       erase (rings under MIN_ISLAND left by the clipping, harbour moles and islets, are dropped),
 *       then a topology-preserving simplification (Visvalingam weighted, SIMPLIFY = share of
 *       vertices kept, small shapes kept) and rounds to DECIMALS. Neighbours share arcs, so their common border stays identical on both sides; the
 *       script checks that the neighbour graph is the same before and after simplification.
 *   - Names: the official French spelling of the BFS commune register ("Carouge" without the
 *       "(GE)" disambiguator, "Le Grand-Saconnex", "Vandœuvres"), curated in the table below and
 *       checked against swisstopo's NAME attribute (which writes "Carouge (GE)", "Vandoeuvres").
 *   - Capitals: none (`capital: null`), the index entry says `noCapital`.
 *   - Shapes are clipped to land (Léman removed): the entry says `landOnly`, so the app draws lakes
 *     underneath the communes instead of on top.
 *   - Population (`pop`, optional): the Federal Statistical Office's STATPOP table on its px-web
 *       API, permanent resident population at 31 December of the latest year the table offers.
 *   - Flags: the communes' coats of arms, the Commons file that Wikidata names as "coat of arms
 *       image" (P94) of the commune item (matched by BFS number, P771); all are official heraldry
 *       in the public domain. Files above 100 KB are rendered to a 240 px PNG (Chrome + sips).
 *       A commune without a P94 file (none today) would get `flag: null`.
 *
 * Only data/sub/, flags/sub/ and the cache directory ($CACHE_DIR or <os tmp>/learn_the_country_cache)
 * are written. Runs on Node >= 18 (global fetch) with npx and unzip; the PNG rendering needs macOS
 * with Google Chrome installed. Requests to Wikimedia servers carry a descriptive User-Agent and
 * are sent at most once per second.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { polygonsOf, ringArea, pointInRing, pointInGeometry, roundGeometry, flagPoint, assertNoAntimeridianJumps } from './geo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.CACHE_DIR || path.join(os.tmpdir(), 'learn_the_country_cache');
const DATA_DIR = path.join(ROOT, 'data', 'sub');
const FLAGS_DIR = path.join(ROOT, 'flags', 'sub');
const FLAG_REL = 'flags/sub'; // as written into the json

const USER_AGENT = 'LearnTheCountry-build/1.0 (https://github.com/vwurstep/Learn_the_country; philippe.vonwurstemberger@gmail.com) node';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAPSHAPER = process.env.MAPSHAPER ? [process.env.MAPSHAPER] : ['npx', '--yes', 'mapshaper'];
const MAX_SVG_BYTES = 100_000; // bigger arms are rendered to PNG
const PNG_WIDTH = 240;
const RENDER_WIDTH = 1200;     // Chrome wants a window of at least ~500 px; render big, then downscale

const DECIMALS = 4;
const SIMPLIFY = '40%';        // share of vertices kept (Visvalingam, weighted); ~200 KB at 4 decimals
const MIN_ISLAND = '20000m2';  // 2 ha: smaller detached rings (slivers left by the lake clipping, islets) are dropped
const MAX_GEOJSON_BYTES = 250_000;

const SRC = {
  // swissBOUNDARIES3D release (the STAC collection ch.swisstopo.swissboundaries3d lists the releases)
  swissboundaries: 'https://data.geo.admin.ch/ch.swisstopo.swissboundaries3d/swissboundaries3d_2026-01/swissboundaries3d_2026-01_2056_5728.shp.zip',
  overpass: 'https://overpass-api.de/api/interpreter',
  commonsApi: 'https://commons.wikimedia.org/w/api.php',
  sparql: 'https://query.wikidata.org/sparql',
  // STATPOP: permanent and non-permanent resident population by year, commune, population type, nationality, sex, age
  statpop: 'https://www.pxweb.bfs.admin.ch/api/v1/fr/px-x-0102010000_101/px-x-0102010000_101.px',
};
const KANTONSNUM = 25;                              // canton of Geneva in swissBOUNDARIES3D
const LAKE = { wikidata: 'Q6403', osmRelation: 332617 }; // Lake Geneva ("Le Léman" on OSM)

// Saturated hues; the app draws them mixed 50% with white. Index order = preference order.
const PALETTE = ['#e0393e', '#2f6fd0', '#2fa84f', '#f29e1f', '#8b5cd6', '#19a3a3'];

const SET = { id: 'ch-ge', parent: 'ch', parentItem: 'ch-ge', name: 'Geneva', kind: 'commune', kinds: 'communes', label: 'Geneva communes' };

// ---------------------------------------------------------------------------
// Curation table: BFS commune number -> official name (French)
// ---------------------------------------------------------------------------

const COMMUNES = {
  6601: 'Aire-la-Ville', 6602: 'Anières', 6603: 'Avully', 6604: 'Avusy', 6605: 'Bardonnex',
  6606: 'Bellevue', 6607: 'Bernex', 6608: 'Carouge', 6609: 'Cartigny', 6610: 'Céligny',
  6611: 'Chancy', 6612: 'Chêne-Bougeries', 6613: 'Chêne-Bourg', 6614: 'Choulex', 6615: 'Collex-Bossy',
  6616: 'Collonge-Bellerive', 6617: 'Cologny', 6618: 'Confignon', 6619: 'Corsier', 6620: 'Dardagny',
  6621: 'Genève', 6622: 'Genthod', 6623: 'Le Grand-Saconnex', 6624: 'Gy', 6625: 'Hermance',
  6626: 'Jussy', 6627: 'Laconnex', 6628: 'Lancy', 6629: 'Meinier', 6630: 'Meyrin',
  6631: 'Onex', 6632: 'Perly-Certoux', 6633: 'Plan-les-Ouates', 6634: 'Pregny-Chambésy', 6635: 'Presinge',
  6636: 'Puplinge', 6637: 'Russin', 6638: 'Satigny', 6639: 'Soral', 6640: 'Thônex',
  6641: 'Troinex', 6642: 'Vandœuvres', 6643: 'Vernier', 6644: 'Versoix', 6645: 'Veyrier',
};
const idOf = (bfs) => `${SET.id}-${bfs}`;
const bfsOf = (id) => +id.slice(SET.id.length + 1);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const round = (n) => Math.round(n * 10 ** DECIMALS) / 10 ** DECIMALS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { 'User-Agent': USER_AGENT };

let lastRequest = 0;
async function politeFetch(url, init = {}) { // at most one request per second (Wikimedia policy; the others do not mind either)
  const wait = lastRequest + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function download(url, file, init) {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  console.log(`downloading ${url}`);
  const res = await politeFetch(url, init);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

// Write a file only if its content changed (keeps mtimes and iCloud quiet).
function writeIfChanged(file, content) {
  if (fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), Buffer.from(content)) === 0) return;
  fs.writeFileSync(file, content);
}

function mapshaper(args) {
  execFileSync(MAPSHAPER[0], [...MAPSHAPER.slice(1), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}

// Area of a geometry in km², cos(lat)-scaled planar shoelace (good enough for a 1% check).
function areaKm2(geom) {
  let a = 0;
  for (const poly of polygonsOf(geom)) {
    const k = Math.cos((poly[0][0][1] * Math.PI) / 180);
    poly.forEach((ring, i) => { a += (i ? -1 : 1) * Math.abs(ringArea(ring.map(([x, y]) => [x * k * 111.32, y * 111.32]))); });
  }
  return a;
}

// ---------------------------------------------------------------------------
// 1. Shapes
// ---------------------------------------------------------------------------

// swisstopo's approximate formulas (LV95 -> WGS84, ellipsoidal, accuracy ~1 m). Checked on
// swisstopo's reference point Zimmerwald: E 2602030.680 N 1191775.030 -> 7.465273°E 46.877094°N.
function lv95ToWgs84([E, N]) {
  const y = (E - 2600000) / 1e6, x = (N - 1200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x * x * x;
  return [(lon * 100) / 36, (lat * 100) / 36];
}
function projectGeometry(geom) { // Polygon or MultiPolygon; a third (height) coordinate is dropped
  const polys = polygonsOf(geom).map((poly) => poly.map((ring) => ring.map(lv95ToWgs84)));
  return geom.type === 'Polygon' ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

// swisstopo names carry a canton disambiguator and write œ as oe ("Carouge (GE)", "Vandoeuvres").
const normaliseName = (s) => s.replace(/\s*\((GE)\)$/, '').replace(/oe/g, 'œ');

// The commune features of canton 25 from the swissBOUNDARIES3D shapefile, projected to WGS84
// (full precision), as [{id, bfs, name, landHa, geometry}] sorted by id.
async function rawShapes() {
  const zip = await download(SRC.swissboundaries, path.basename(SRC.swissboundaries));
  const dir = path.join(CACHE, 'swissboundaries3d');
  const shp = () => fs.existsSync(dir) && fs.readdirSync(dir).find((f) => /TLM_HOHEITSGEBIET\.shp$/.test(f));
  if (!shp()) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', '-j', zip, '*TLM_HOHEITSGEBIET.*', '-d', dir], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (!shp()) throw new Error(`no TLM_HOHEITSGEBIET shapefile in ${zip}`);
  }
  const lv95File = path.join(CACHE, 'ch-ge-lv95.geojson');
  if (!fs.existsSync(lv95File)) {
    console.log(`mapshaper: extracting canton ${KANTONSNUM} from ${shp()}`);
    mapshaper(['-i', path.join(dir, shp()), '-filter', `KANTONSNUM==${KANTONSNUM}`, '-filter-fields', 'BFS_NUMMER,NAME,OBJEKTART,GEM_FLAECH,SEE_FLAECH',
      '-o', lv95File, 'format=geojson', 'force']);
  }
  const features = [];
  for (const f of readJson(lv95File).features) {
    const p = f.properties;
    if (p.OBJEKTART !== 'Gemeindegebiet') throw new Error(`ch-ge: unexpected feature ${p.NAME} (${p.OBJEKTART})`);
    const bfs = +p.BFS_NUMMER;
    if (!(bfs in COMMUNES)) throw new Error(`ch-ge: swisstopo has a commune that the table lacks: ${bfs} ${p.NAME} (a new commune or a merger? update the table)`);
    if (normaliseName(p.NAME) !== COMMUNES[bfs]) throw new Error(`ch-ge-${bfs}: swisstopo calls it "${p.NAME}", table says "${COMMUNES[bfs]}"`);
    if (features.some((g) => g.bfs === bfs)) throw new Error(`ch-ge-${bfs}: several features`);
    if (!['Polygon', 'MultiPolygon'].includes(f.geometry?.type)) throw new Error(`ch-ge-${bfs}: no polygon`);
    features.push({ id: idOf(bfs), bfs, name: COMMUNES[bfs], landHa: p.GEM_FLAECH - p.SEE_FLAECH, geometry: projectGeometry(f.geometry) });
  }
  const missing = Object.keys(COMMUNES).filter((b) => !features.some((f) => f.bfs === +b));
  if (missing.length) throw new Error(`ch-ge: no shape for ${missing.join(', ')} (merged? update the table)`);
  features.sort((a, b) => (a.id < b.id ? -1 : 1));
  return features;
}

// Lake Geneva as a GeoJSON MultiPolygon, assembled from the member ways of the OSM water relation
// (Overpass API). Outer rings become polygons, inner rings (islands, harbour moles) holes of the
// polygon that contains them.
async function lakePolygon() {
  const query = `[out:json][timeout:180];relation["natural"="water"]["wikidata"="${LAKE.wikidata}"];out geom;`;
  const file = await download(SRC.overpass, 'osm-lake-leman.json', { method: 'POST', body: `data=${encodeURIComponent(query)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const rels = readJson(file).elements.filter((e) => e.type === 'relation' && e.members);
  if (rels.length !== 1) throw new Error(`Overpass: ${rels.length} water relations tagged ${LAKE.wikidata}, expected 1`);
  const rel = rels[0];
  if (rel.id !== LAKE.osmRelation) console.warn(`  note: the lake relation is now ${rel.id}, not ${LAKE.osmRelation}`);
  const ways = { outer: [], inner: [] };
  for (const m of rel.members) {
    if (m.type === 'way' && m.geometry && ways[m.role]) ways[m.role].push(m.geometry.map((p) => [p.lon, p.lat]));
  }
  const rings = { outer: joinRings(ways.outer), inner: joinRings(ways.inner) };
  const polys = rings.outer.map((r) => [r]);
  for (const hole of rings.inner) {
    const poly = polys.find((p) => pointInRing(hole[0], p[0]));
    if (poly) poly.push(hole); else console.warn(`  note: a lake inner ring at ${hole[0]} lies in no outer ring, dropped`);
  }
  const geometry = { type: 'MultiPolygon', coordinates: polys };
  const km2 = areaKm2(geometry);
  if (km2 < 560 || km2 > 600) throw new Error(`lake area ${km2.toFixed(0)} km², expected ~580`);
  console.log(`lake: relation ${rel.id}, ${rings.outer.length} outer and ${rings.inner.length} inner rings, ${km2.toFixed(0)} km²`);
  const out = path.join(CACHE, 'lake-leman.geojson');
  writeIfChanged(out, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry }] }));
  return out;
}

// Join way fragments end to end into closed rings.
function joinRings(ways) {
  const key = (p) => `${p[0]},${p[1]}`;
  const pending = ways.filter((w) => w.length > 1).map((w) => w.slice());
  const rings = [];
  while (pending.length) {
    let ring = pending.shift();
    while (key(ring[0]) !== key(ring[ring.length - 1])) {
      const end = key(ring[ring.length - 1]);
      const i = pending.findIndex((w) => key(w[0]) === end || key(w[w.length - 1]) === end);
      if (i < 0) throw new Error(`lake: open ring ending at ${end}`);
      const [w] = pending.splice(i, 1);
      ring = ring.concat((key(w[0]) === end ? w : w.reverse()).slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

// Cut out the lake, drop sliver islands, simplify (topology-preserving) and round with mapshaper.
// The lake polygon has holes for harbour moles and islets; after the erase those are land again,
// detached or hanging on the shore by a single vertex, so that -filter-slivers / -filter-islands
// can drop them (Île Rousseau is 0.3 ha, the moles far less). Céligny's exclave (64 ha) stays.
// Returns {clipped, simplified}: the features before and after simplification, both rounded.
function clipAndSimplify(raw, lakeFile) {
  const input = path.join(CACHE, 'ch-ge-wgs84.geojson');
  const clippedFile = path.join(CACHE, 'ch-ge-clipped.geojson');
  const simplifiedFile = path.join(CACHE, 'ch-ge-simplified.geojson');
  writeIfChanged(input, JSON.stringify({ type: 'FeatureCollection', features: raw.map((f) => ({ type: 'Feature', properties: { id: f.id }, geometry: f.geometry })) }));
  console.log(`mapshaper: -erase lake -filter-slivers/-filter-islands min-area=${MIN_ISLAND} -simplify weighted ${SIMPLIFY} keep-shapes`);
  mapshaper(['-i', input, '-erase', lakeFile, '-clean', '-filter-slivers', `min-area=${MIN_ISLAND}`, '-filter-islands', `min-area=${MIN_ISLAND}`, '-clean',
    '-o', clippedFile, 'format=geojson', `precision=${10 ** -DECIMALS}`, 'force',
    '-simplify', 'weighted', SIMPLIFY, 'keep-shapes', '-clean',
    '-o', simplifiedFile, 'format=geojson', `precision=${10 ** -DECIMALS}`, 'force']);
  const load = (file) => {
    const features = readJson(file).features.map((f) => {
      if (!f.geometry || !['Polygon', 'MultiPolygon'].includes(f.geometry.type)) throw new Error(`${f.properties.id}: mapshaper dropped the geometry`);
      return { type: 'Feature', properties: { id: f.properties.id }, geometry: roundGeometry(f.geometry, DECIMALS) };
    });
    features.sort((a, b) => (a.properties.id < b.properties.id ? -1 : 1));
    if (features.length !== raw.length || features.some((f, i) => f.properties.id !== raw[i].id)) throw new Error(`${file}: features differ from the input`);
    assertNoAntimeridianJumps(features);
    return features;
  };
  return { clipped: load(clippedFile), simplified: load(simplifiedFile) };
}

// Neighbour graph: ids whose rounded rings share at least one vertex (a shared border, or a
// corner). Returns Map id -> Map of neighbour id -> the shared vertices ([x, y][]).
function adjacency(features) {
  const owners = new Map();
  for (const f of features) {
    const seen = new Set();
    for (const poly of polygonsOf(f.geometry)) for (const ring of poly) for (const [x, y] of ring) {
      const k = `${x},${y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      (owners.get(k) ?? owners.set(k, { p: [x, y], ids: [] }).get(k)).ids.push(f.properties.id);
    }
  }
  const adj = new Map(features.map((f) => [f.properties.id, new Map()]));
  for (const { p, ids } of owners.values()) {
    for (const a of ids) for (const b of ids) if (a !== b) (adj.get(a).get(b) ?? adj.get(a).set(b, []).get(b)).push(p);
  }
  return adj;
}

// The simplified shapes must have the same neighbours as the clipped ones, and every shared border
// must still be a shared border (>= 2 common vertices): that is what "gap-free" means here, since
// mapshaper keeps one arc per border and both sides reference it. A "border" whose vertices all lie
// within two rounding steps of each other (a few metres of stub at a four-way corner) is a corner
// touch; it may collapse to one vertex.
function checkTopology(rawAdj, adj) {
  const extent = (pts) => Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
  for (const [id, rawN] of rawAdj) {
    const n = adj.get(id);
    for (const [o, pts] of rawN) {
      if (!n.has(o)) throw new Error(`${id} and ${o} touch before simplification but not after`);
      if (pts.length >= 2 && extent(pts) > 2 * 10 ** -DECIMALS && n.get(o).length < 2) throw new Error(`${id} and ${o} lost their shared border`);
    }
    for (const o of n.keys()) if (!rawN.has(o)) throw new Error(`${id} and ${o} touch only after simplification`);
  }
}

// Greedy colouring with random restarts (seeded, so the build is reproducible). Vertices are
// taken in the given order and get the lowest colour not used by a coloured neighbour; the order
// is shuffled on every restart and the colouring with the fewest colours wins.
function colourGraph(adj, restarts = 3000) {
  const ids = [...adj.keys()];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
  let best = null;
  for (let r = 0; r < restarts; r++) {
    const order = ids.slice();
    if (r > 0) for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    else order.sort((a, b) => adj.get(b).size - adj.get(a).size); // first try: most neighbours first
    const col = new Map();
    let n = 0;
    for (const id of order) {
      const used = new Set([...adj.get(id).keys()].map((o) => col.get(o)).filter((c) => c !== undefined));
      let c = 0;
      while (used.has(c)) c++;
      col.set(id, c);
      n = Math.max(n, c + 1);
      if (best && n >= best.n) break;
    }
    if (col.size === ids.length && (!best || n < best.n)) best = { n, col };
  }
  if (best.n > PALETTE.length) throw new Error(`need ${best.n} colours, palette has ${PALETTE.length}`);
  return best;
}

// ---------------------------------------------------------------------------
// 2. Wikidata (coat of arms file) and BFS (population)
// ---------------------------------------------------------------------------

// Map bfs -> {qid, label, coa (Commons title or null)}.
async function wikidataArms(bfsNumbers) {
  const query = `SELECT ?bfs ?item ?label ?coa WHERE {
    VALUES ?bfs { ${bfsNumbers.map((b) => JSON.stringify(String(b))).join(' ')} }
    ?item wdt:P771 ?bfs ; wdt:P31 wd:Q70208 .
    OPTIONAL { ?item rdfs:label ?label FILTER(lang(?label) = "fr") }
    OPTIONAL { ?item wdt:P94 ?coa }
  }`;
  const file = await download(`${SRC.sparql}?format=json&query=${encodeURIComponent(query)}`, 'wikidata-sub-ch-ge.json', { headers: { Accept: 'application/sparql-results+json' } });
  const out = new Map();
  for (const b of readJson(file).results.bindings) {
    const bfs = +b.bfs.value;
    const e = out.get(bfs) ?? out.set(bfs, { qid: b.item.value.split('/').pop(), label: b.label?.value, coas: new Set() }).get(bfs);
    if (e.qid !== b.item.value.split('/').pop()) throw new Error(`ch-ge-${bfs}: several Wikidata items (${e.qid}, ${b.item.value})`);
    if (b.coa) e.coas.add(decodeURIComponent(b.coa.value.split('/Special:FilePath/').pop()).replace(/_/g, ' '));
  }
  for (const bfs of bfsNumbers) {
    const e = out.get(bfs);
    if (!e) throw new Error(`ch-ge-${bfs}: not on Wikidata (P771 = ${bfs})`);
    const coas = [...e.coas].sort((a, b) => (/^CHE .* COA\.svg$/.test(b) ? 1 : 0) - (/^CHE .* COA\.svg$/.test(a) ? 1 : 0) || a.localeCompare(b));
    if (coas.length > 1) console.warn(`  ch-ge-${bfs}: several coats of arms on Wikidata (${coas.join(', ')}), taking ${coas[0]}`);
    e.coa = coas[0] || null;
    if (!e.coa) console.warn(`  ch-ge-${bfs}: no coat of arms on Wikidata (P94), flag: null`);
    if (e.label && e.label !== COMMUNES[bfs] && e.label !== COMMUNES[bfs].replace(/^Le /, '')) console.warn(`  ch-ge-${bfs}: Wikidata's French label is "${e.label}", table says "${COMMUNES[bfs]}"`);
  }
  return out;
}

// Map bfs -> permanent resident population, plus the reference year, from the BFS px-web API.
async function population(bfsNumbers) {
  const meta = readJson(await download(SRC.statpop, 'bfs-statpop-meta.json'));
  const vars = meta.variables;
  const yearVar = vars.find((v) => v.time || v.code === 'Jahr');
  const communeVar = vars.find((v) => /Gemeinde|Commune/i.test(v.code));
  if (!yearVar || !communeVar) throw new Error('BFS: unexpected table layout');
  const year = yearVar.values.map(Number).sort((a, b) => b - a)[0];
  const codes = bfsNumbers.map(String);
  const absent = codes.filter((c) => !communeVar.values.includes(c));
  if (absent.length) throw new Error(`BFS: communes ${absent.join(', ')} not in the table`);
  const query = { query: [], response: { format: 'json' } };
  for (const v of vars) {
    let values;
    if (v === yearVar) values = [String(year)];
    else if (v === communeVar) values = codes;
    else if (v.values.includes('-99999')) values = ['-99999'];       // the total
    else if (v.code === 'Bevölkerungstyp') values = ['1'];            // permanent resident population
    else throw new Error(`BFS: do not know which value of "${v.text}" to take`);
    query.query.push({ code: v.code, selection: { filter: 'item', values } });
  }
  const file = await download(SRC.statpop, `bfs-statpop-ch-ge-${year}.json`, { method: 'POST', body: JSON.stringify(query), headers: { 'Content-Type': 'application/json' } });
  const pop = new Map();
  for (const row of readJson(file).data) {
    const bfs = +row.key[vars.indexOf(communeVar)];
    const n = +row.values[0];
    if (Number.isInteger(n) && n > 0) pop.set(bfs, n);
  }
  const missing = bfsNumbers.filter((b) => !pop.has(b));
  if (missing.length) throw new Error(`BFS: no ${year} population for ${missing.join(', ')}`);
  return { pop, year };
}

// ---------------------------------------------------------------------------
// 3. Flags (coats of arms) from Wikimedia Commons
// ---------------------------------------------------------------------------

// Commons API: title -> {title (after redirects), url, size, width, height, license, artist}.
async function commonsInfo(titles, cacheName) {
  const file = path.join(CACHE, cacheName);
  if (!fs.existsSync(file)) {
    const pages = [];
    for (let i = 0; i < titles.length; i += 50) {
      const body = new URLSearchParams({
        action: 'query', format: 'json', redirects: '1', prop: 'imageinfo',
        iiprop: 'url|size|extmetadata', iiextmetadatafilter: 'LicenseShortName|Artist|AttributionRequired',
        titles: titles.slice(i, i + 50).map((t) => 'File:' + t).join('|'),
      });
      console.log(`querying Commons for ${Math.min(50, titles.length - i)} files`);
      const res = await politeFetch(SRC.commonsApi, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      pages.push(await res.json());
    }
    fs.writeFileSync(file, JSON.stringify(pages));
  }
  const info = new Map();
  for (const j of readJson(file)) {
    const q = j.query;
    const alias = new Map([...(q.normalized || []), ...(q.redirects || [])].map((r) => [r.from, r.to]));
    const byTitle = new Map(Object.values(q.pages).map((p) => [p.title, p]));
    for (const t of titles) {
      let title = 'File:' + t;
      for (let i = 0; i < 3 && alias.has(title); i++) title = alias.get(title);
      const p = byTitle.get(title);
      if (!p) continue;
      if (p.missing !== undefined || !p.imageinfo) throw new Error(`Commons: ${t} not found`);
      const ii = p.imageinfo[0], m = ii.extmetadata || {};
      const strip = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/(Unknown author)\1/, '$1').trim();
      info.set(t, {
        title: p.title.replace(/^File:/, ''), url: ii.url.split('?')[0], size: ii.size, width: ii.width, height: ii.height,
        license: strip(m.LicenseShortName?.value) || 'unknown', artist: strip(m.Artist?.value),
        attributionRequired: strip(m.AttributionRequired?.value) === 'true',
      });
    }
  }
  return info;
}

// Render an SVG to a PNG_WIDTH px wide PNG. Chrome's new headless mode often does not exit
// after --screenshot, so we wait for the file and then kill it.
async function renderPng(svgFile, width, height, outFile) {
  const dir = path.join(CACHE, 'render');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(svgFile, '.svg');
  const h = Math.round((RENDER_WIDTH * height) / width);
  const html = path.join(dir, `${base}.html`);
  const big = path.join(dir, `${base}-big.png`);
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{display:block;width:${RENDER_WIDTH}px;height:${h}px}</style></head><body><img src="file://${svgFile}"></body></html>`);
  fs.rmSync(big, { force: true });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--default-background-color=00000000', `--window-size=${RENDER_WIDTH},${h}`,
    `--user-data-dir=${path.join(dir, 'chrome-profile')}`, `--screenshot=${big}`, `file://${html}`,
  ], { stdio: 'ignore' });
  let exited = false;
  chrome.on('exit', () => { exited = true; });
  const t0 = Date.now();
  for (;;) {
    await sleep(200);
    if (exited) break;
    if (fs.existsSync(big) && fs.statSync(big).size > 0 && Date.now() - t0 > 1500) { await sleep(300); chrome.kill('SIGKILL'); break; }
    if (Date.now() - t0 > 60_000) { chrome.kill('SIGKILL'); throw new Error(`Chrome timed out rendering ${svgFile}`); }
  }
  if (!fs.existsSync(big)) throw new Error(`Chrome produced no screenshot for ${svgFile}`);
  execFileSync('sips', ['--resampleWidth', String(PNG_WIDTH), big, '--out', outFile], { stdio: 'ignore' });
}

async function buildFlags(entries) {
  fs.mkdirSync(FLAGS_DIR, { recursive: true });
  fs.mkdirSync(path.join(CACHE, 'commons'), { recursive: true });
  const withFlag = entries.filter((e) => e.commonsTitle);
  const info = withFlag.length ? await commonsInfo(withFlag.map((e) => e.commonsTitle), `commons-sub-${SET.id}.json`) : new Map();
  const credits = [];
  let bytes = 0;
  for (const e of entries) {
    if (!e.commonsTitle) { // no coat of arms on Commons
      for (const ext of ['svg', 'png']) fs.rmSync(path.join(FLAGS_DIR, `${e.id}.${ext}`), { force: true });
      continue;
    }
    const fi = info.get(e.commonsTitle);
    if (!fi) throw new Error(`no Commons info for ${e.commonsTitle}`);
    const cached = await download(fi.url, path.join('commons', `${e.id}.svg`));
    const usePng = fs.statSync(cached).size > MAX_SVG_BYTES;
    const out = path.join(FLAGS_DIR, `${e.id}.${usePng ? 'png' : 'svg'}`);
    fs.rmSync(path.join(FLAGS_DIR, `${e.id}.${usePng ? 'svg' : 'png'}`), { force: true }); // stale counterpart
    if (usePng) {
      if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(cached).mtimeMs) {
        console.log(`rendering ${e.id} (${fi.size} B svg) to png`);
        await renderPng(cached, fi.width, fi.height, out);
      }
    } else {
      writeIfChanged(out, fs.readFileSync(cached));
    }
    e.flag = `${FLAG_REL}/${path.basename(out)}`;
    bytes += fs.statSync(out).size;
    credits.push({ id: e.id, file: fi.title, license: fi.license, artist: fi.artist, attributionRequired: fi.attributionRequired });
  }
  return { bytes, credits };
}

// ---------------------------------------------------------------------------
// 4. Output
// ---------------------------------------------------------------------------

// Add or replace this set's entry in data/sub/index.json, leaving the other entries (written by
// other build scripts, possibly at the same time) untouched; the file is read right before writing.
// A new entry goes right after its parent set.
function updateIndex(entry) {
  const file = path.join(DATA_DIR, 'index.json');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]';
  const index = JSON.parse(text);
  const i = index.findIndex((e) => e.id === entry.id);
  if (i >= 0) index[i] = entry;
  else {
    const p = index.findIndex((e) => e.id === entry.parent);
    index.splice(p >= 0 ? p + 1 : index.length, 0, entry);
  }
  const pretty = /^\[\n \{/.test(text); // keep the file's layout: JSON.stringify(_, null, 1) or one entry per line
  writeIfChanged(file, pretty ? JSON.stringify(index, null, 1) + '\n' : '[\n' + index.map((e) => '  ' + JSON.stringify(e)).join(',\n') + '\n]\n');
}

// A point in the lake inside the canton (the Petit-Lac between Versoix and Collonge-Bellerive):
// it must be covered before the clipping and by no commune after it.
const LAKE_POINT = [6.19, 46.27];

function validate(rows, fc, adj, raw, geoBytes) {
  const n = Object.keys(COMMUNES).length;
  if (rows.length !== n) throw new Error(`ch-ge: ${rows.length} entries, expected ${n}`);
  const geom = new Map(fc.features.map((f) => [f.properties.id, f.geometry]));
  if (geom.size !== n) throw new Error(`ch-ge: ${geom.size} shapes, expected ${n}`);
  const colour = new Map(rows.map((e) => [e.id, e.color]));
  const keys = ['id', 'name', 'capital', 'lat', 'lon', 'fx', 'fy', 'color', 'flag', 'pop', 'commonsTitle'];
  for (const e of rows) {
    const g = geom.get(e.id);
    if (!g) throw new Error(`${e.id}: no geometry`);
    if (!/^ch-ge-66\d\d$/.test(e.id) || COMMUNES[bfsOf(e.id)] !== e.name) throw new Error(`${e.id}: bad id or name`);
    if (Object.keys(e).some((k) => !keys.includes(k))) throw new Error(`${e.id}: unexpected field`);
    if (e.capital !== null) throw new Error(`${e.id}: capital must be null`);
    if (e.flag === null) { if (e.commonsTitle) throw new Error(`${e.id}: flag missing`); }
    else if (!/^flags\/sub\/[a-z0-9-]+\.(svg|png)$/.test(e.flag) || !fs.existsSync(path.join(ROOT, e.flag))) throw new Error(`${e.id}: flag file ${e.flag} missing`);
    if (!pointInGeometry([e.fx, e.fy], g)) throw new Error(`${e.id}: fx/fy outside`);
    if (e.lat !== e.fy || e.lon !== e.fx) throw new Error(`${e.id}: lat/lon must equal fy/fx`);
    if ('pop' in e && !(Number.isInteger(e.pop) && e.pop > 0)) throw new Error(`${e.id}: bad pop`);
    for (const o of adj.get(e.id).keys()) if (colour.get(o) === e.color) throw new Error(`${e.id} and ${o} are neighbours with the same colour`);
    if (!/^#[0-9a-f]{6}$/.test(e.color)) throw new Error(`${e.id}: bad colour`);
  }
  assertNoAntimeridianJumps(fc.features);
  for (const f of fc.features) {
    if (Object.keys(f.properties).join() !== 'id') throw new Error(`${f.properties.id}: properties must be {id}`);
    for (const poly of polygonsOf(f.geometry)) if (ringArea(poly[0]) === 0) throw new Error(`${f.properties.id}: degenerate ring`);
    for (const poly of polygonsOf(f.geometry)) for (const ring of poly) for (const [x, y] of ring) {
      if (round(x) !== x || round(y) !== y) throw new Error(`${f.properties.id}: coordinate with more than ${DECIMALS} decimals`);
    }
  }
  // the lake is cut out and nothing else: every commune is one polygon (Céligny two), no commune
  // covers the lake point any more, and the land area agrees with swisstopo's (commune area minus
  // lake area, in hectares)
  for (const [id, g] of geom) {
    const parts = polygonsOf(g).length, want = id === idOf(6610) ? 2 : 1; // Céligny: the main part and an exclave, both in Vaud
    if (parts !== want) throw new Error(`${id}: ${parts} polygons, expected ${want}`);
  }
  if (!raw.some((f) => pointInGeometry(LAKE_POINT, f.geometry))) throw new Error('lake point is not in the raw shapes (is it in the canton?)');
  if (fc.features.some((f) => pointInGeometry(LAKE_POINT, f.geometry))) throw new Error('a commune still covers the lake');
  const landKm2 = raw.reduce((s, f) => s + f.landHa, 0) / 100;
  const km2 = fc.features.reduce((s, f) => s + areaKm2(f.geometry), 0);
  if (Math.abs(km2 - landKm2) > landKm2 * 0.02) throw new Error(`land area ${km2.toFixed(1)} km², swisstopo says ${landKm2.toFixed(1)}`);
  if (geoBytes > MAX_GEOJSON_BYTES) throw new Error(`ch-ge.geojson is ${geoBytes} bytes (> ${MAX_GEOJSON_BYTES}), lower SIMPLIFY`);
  const index = readJson(path.join(DATA_DIR, 'index.json'));
  if (index.filter((e) => e.id === SET.id).length !== 1) throw new Error('index.json: ch-ge entry missing or duplicated');
  const parentItems = readJson(path.join(DATA_DIR, `${SET.parent}.json`));
  if (!parentItems.some((e) => e.id === SET.parentItem)) throw new Error(`${SET.parent}.json has no item ${SET.parentItem}`);
  return { km2, landKm2 };
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // shapes: extract, project, cut out the lake, simplify, round
  const raw = await rawShapes();
  const lakeFile = await lakePolygon();
  const { clipped, simplified: features } = clipAndSimplify(raw, lakeFile);
  const clippedAdj = adjacency(clipped);
  const adj = adjacency(features);
  checkTopology(clippedAdj, adj);
  const { n: nColours, col } = colourGraph(adj);

  // arms and population
  const bfsNumbers = features.map((f) => bfsOf(f.properties.id));
  const arms = await wikidataArms(bfsNumbers);
  const { pop, year } = await population(bfsNumbers);

  const entries = [];
  for (const f of features) {
    const id = f.properties.id, bfs = bfsOf(id);
    const [fx, fy] = flagPoint(f.geometry).map(round);
    if (!pointInGeometry([fx, fy], f.geometry)) throw new Error(`${id}: flag point outside its shape`);
    entries.push({ id, name: COMMUNES[bfs], capital: null, lat: fy, lon: fx, fx, fy, color: PALETTE[col.get(id)], flag: null, pop: pop.get(bfs), commonsTitle: arms.get(bfs).coa });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  const { bytes: flagBytes, credits } = await buildFlags(entries);

  // geojson (properties: only id)
  const fc = { type: 'FeatureCollection', features: features.map((f) => ({ type: 'Feature', properties: { id: f.properties.id }, geometry: f.geometry })) };
  const geoPath = path.join(DATA_DIR, `${SET.id}.geojson`);
  writeIfChanged(geoPath, JSON.stringify(fc));
  const geoBytes = fs.statSync(geoPath).size;

  // json
  const rows = entries.map(({ commonsTitle, ...e }) => e);
  const jsonPath = path.join(DATA_DIR, `${SET.id}.json`);
  writeIfChanged(jsonPath, '[\n' + rows.map((e) => '  ' + JSON.stringify(e)).join(',\n') + '\n]\n');

  // index
  updateIndex({ id: SET.id, parent: SET.parent, parentItem: SET.parentItem, name: SET.name, kind: SET.kind, kinds: SET.kinds, label: SET.label, count: rows.length, noCapital: true, landOnly: true });

  const { km2, landKm2 } = validate(entries, fc, adj, raw, geoBytes);
  const nPolys = features.reduce((s, f) => s + polygonsOf(f.geometry).length, 0);
  const nVerts = features.reduce((s, f) => s + polygonsOf(f.geometry).reduce((t, p) => t + p.reduce((u, r) => u + r.length, 0), 0), 0);
  const nPng = rows.filter((e) => e.flag && e.flag.endsWith('.png')).length;
  const nNull = rows.filter((e) => !e.flag).length;
  console.log(`ch-ge: ${rows.length} ${SET.kinds}, ${nColours} colours, ${SET.id}.geojson ${geoBytes} B (${nPolys} polygons, ${nVerts} vertices, ${km2.toFixed(1)} km² of land, swisstopo: ${landKm2.toFixed(1)}), ${SET.id}.json ${fs.statSync(jsonPath).size} B, population ${year}, flags ${flagBytes} B (${rows.length - nPng - nNull} svg, ${nPng} png${nNull ? `, ${nNull} without: ${rows.filter((e) => !e.flag).map((e) => e.id).join(' ')}` : ''})`);

  // Flag credits for LICENSES.md
  const byLicense = {};
  for (const c of credits) (byLicense[c.license] ??= []).push(c);
  const lines = ['| id | Commons file | licence | author |', '|---|---|---|---|'];
  for (const c of credits) lines.push(`| ${c.id} | [${c.file}](https://commons.wikimedia.org/wiki/File:${encodeURI(c.file.replace(/ /g, '_'))}) | ${c.license} | ${c.artist.replace(/\|/g, '/')} |`);
  const creditsFile = path.join(CACHE, `sub-flag-credits-${SET.id}.md`);
  fs.writeFileSync(creditsFile, lines.join('\n') + '\n');
  console.log(`flag licences: ${Object.entries(byLicense).map(([l, c]) => `${l} ×${c.length}`).join(', ')}; table written to ${creditsFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
