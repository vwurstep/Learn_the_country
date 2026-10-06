#!/usr/bin/env node
/**
 * build_subdivisions.mjs — offline data for the "deep dive" into subdivisions (US states,
 * Swiss cantons).
 *
 *   node tools/build_subdivisions.mjs       (downloads sources into a cache dir, then writes:)
 *     data/sub/index.json       the sets: [{id, name, kind, kinds, label}] (label: quiz chip text)
 *     data/sub/<set>.json       one entry per subdivision, sorted by name:
 *                               {id, name, capital, lat, lon, fx, fy, color, flag}
 *     data/sub/<set>.geojson    subdivision polygons, properties.id = the json id
 *     flags/sub/<id>.svg|.png   one flag per subdivision (path in the json `flag` field)
 *
 * Sources (all downloaded at build time, cached in $CACHE_DIR or <os tmp>/learn_the_country_cache):
 *   - Shapes: Natural Earth admin-1 states/provinces (public domain), the GeoJSON from
 *       nvkelso/natural-earth-vector. 1:50m for the US states (it has all 50, Alaska and Hawaii
 *       included; its Alaska stops at 178°W, so no ring crosses the antimeridian), 1:10m for the
 *       Swiss cantons (not in the 50m set). Coordinates are rounded (US 3 decimals, CH 4), nothing
 *       else is simplified, so shared borders stay identical between neighbours.
 *   - Names and capitals: the tables below. Cantons use their own official spelling
 *       (Zürich, Genève, Ticino...), capitals are the official Hauptort / chef-lieu.
 *   - Capital coordinates (lat, lon): Wikidata (CC0), the subdivision's "capital" (P36) and its
 *       "coordinate location" (P625), one SPARQL query; subdivisions are matched through the
 *       `wikidataid` that Natural Earth carries. Checked to lie inside the subdivision.
 *   - Flag position (fx, fy): pole of inaccessibility (polylabel, tools/geo.mjs, shared with
 *       build_data.mjs) of the largest polygon, cos(lat)-scaled.
 *   - Colours: greedy graph colouring (palette below, 6 hues) over the neighbour graph; two
 *       subdivisions are neighbours when their rounded rings share a vertex. Random restarts with a
 *       fixed seed keep the result reproducible and the number of colours minimal.
 *   - Flags: Wikimedia Commons, the original SVG of "Flag of <state>.svg" /
 *       "Flag of Canton of <canton>.svg", found through the Commons API (which also gives the
 *       licence, recorded in LICENSES.md). Files above 100 KB (seal-heavy US state flags) are
 *       rendered to a 240 px wide PNG with headless Google Chrome and downscaled with sips (macOS),
 *       which keeps the app's offline cache small. Requests carry a descriptive User-Agent and are
 *       sent at most once per second (Wikimedia policy).
 *
 * Only data/sub/, flags/sub/ and the cache directory are written. Runs on Node >= 18 (global
 * fetch); the PNG rendering needs macOS with Google Chrome installed.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { polygonsOf, ringArea, pointInGeometry, roundGeometry, flagPoint, assertNoAntimeridianJumps } from './geo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.CACHE_DIR || path.join(os.tmpdir(), 'learn_the_country_cache');
const DATA_DIR = path.join(ROOT, 'data', 'sub');
const FLAGS_DIR = path.join(ROOT, 'flags', 'sub');
const FLAG_REL = 'flags/sub'; // as written into the json

const USER_AGENT = 'LearnTheCountry-build/1.0 (https://github.com/vwurstep/Learn_the_country; philippe.vonwurstemberger@gmail.com) node';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAX_SVG_BYTES = 100_000; // bigger flags are rendered to PNG
const PNG_WIDTH = 240;
const RENDER_WIDTH = 1200;     // Chrome wants a window of at least ~500 px; render big, then downscale

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const SRC = {
  ne50: NE + 'ne_50m_admin_1_states_provinces.geojson',
  ne10: NE + 'ne_10m_admin_1_states_provinces.geojson',
  commonsApi: 'https://commons.wikimedia.org/w/api.php',
  sparql: 'https://query.wikidata.org/sparql',
};

// Saturated hues; the app draws them mixed 50% with white. Index order = preference order.
const PALETTE = ['#e0393e', '#2f6fd0', '#2fa84f', '#f29e1f', '#8b5cd6', '#19a3a3'];

// ---------------------------------------------------------------------------
// Curation tables: code -> [name, capital, Commons flag title]
// ---------------------------------------------------------------------------

const US_STATES = {
  AL: ['Alabama', 'Montgomery'], AK: ['Alaska', 'Juneau'], AZ: ['Arizona', 'Phoenix'], AR: ['Arkansas', 'Little Rock'],
  CA: ['California', 'Sacramento'], CO: ['Colorado', 'Denver'], CT: ['Connecticut', 'Hartford'], DE: ['Delaware', 'Dover'],
  FL: ['Florida', 'Tallahassee'], GA: ['Georgia', 'Atlanta', 'Flag of Georgia (U.S. state).svg'], HI: ['Hawaii', 'Honolulu'],
  ID: ['Idaho', 'Boise'], IL: ['Illinois', 'Springfield'], IN: ['Indiana', 'Indianapolis'], IA: ['Iowa', 'Des Moines'],
  KS: ['Kansas', 'Topeka'], KY: ['Kentucky', 'Frankfort'], LA: ['Louisiana', 'Baton Rouge'], ME: ['Maine', 'Augusta'],
  MD: ['Maryland', 'Annapolis'], MA: ['Massachusetts', 'Boston'], MI: ['Michigan', 'Lansing'], MN: ['Minnesota', 'Saint Paul'],
  MS: ['Mississippi', 'Jackson'], MO: ['Missouri', 'Jefferson City'], MT: ['Montana', 'Helena'], NE: ['Nebraska', 'Lincoln'],
  NV: ['Nevada', 'Carson City'], NH: ['New Hampshire', 'Concord'], NJ: ['New Jersey', 'Trenton'], NM: ['New Mexico', 'Santa Fe'],
  NY: ['New York', 'Albany'], NC: ['North Carolina', 'Raleigh'], ND: ['North Dakota', 'Bismarck'], OH: ['Ohio', 'Columbus'],
  OK: ['Oklahoma', 'Oklahoma City'], OR: ['Oregon', 'Salem'], PA: ['Pennsylvania', 'Harrisburg'], RI: ['Rhode Island', 'Providence'],
  SC: ['South Carolina', 'Columbia'], SD: ['South Dakota', 'Pierre'], TN: ['Tennessee', 'Nashville'], TX: ['Texas', 'Austin'],
  UT: ['Utah', 'Salt Lake City'], VT: ['Vermont', 'Montpelier'], VA: ['Virginia', 'Richmond'], WA: ['Washington', 'Olympia'],
  WV: ['West Virginia', 'Charleston'], WI: ['Wisconsin', 'Madison'], WY: ['Wyoming', 'Cheyenne'],
};

// Commons names the cantons in English ("Flag of Canton of Lucerne.svg"); the app uses the local names.
const CH_CANTONS = {
  ZH: ['Zürich', 'Zürich', 'Flag of Canton of Zürich.svg'],
  BE: ['Bern', 'Bern', 'Flag of Canton of Bern.svg'],
  LU: ['Luzern', 'Luzern', 'Flag of Canton of Lucerne.svg'],
  UR: ['Uri', 'Altdorf', 'Flag of Canton of Uri.svg'],
  SZ: ['Schwyz', 'Schwyz', 'Flag of Canton of Schwyz.svg'],
  OW: ['Obwalden', 'Sarnen', 'Flag of Canton of Obwalden.svg'],
  NW: ['Nidwalden', 'Stans', 'Flag of Canton of Nidwalden.svg'],
  GL: ['Glarus', 'Glarus', 'Flag of Canton of Glarus.svg'],
  ZG: ['Zug', 'Zug', 'Flag of Canton of Zug.svg'],
  FR: ['Fribourg', 'Fribourg', 'Flag of Canton of Fribourg.svg'],
  SO: ['Solothurn', 'Solothurn', 'Flag of Canton of Solothurn.svg'],
  BS: ['Basel-Stadt', 'Basel', 'Flag of Canton of Basel.svg'],
  BL: ['Basel-Landschaft', 'Liestal', 'Flag of Canton of Basel-Landschaft.svg'],
  SH: ['Schaffhausen', 'Schaffhausen', 'Flag of Canton of Schaffhausen.svg'],
  AR: ['Appenzell Ausserrhoden', 'Herisau', 'Flag of Canton of Appenzell Ausserrhoden.svg'],
  AI: ['Appenzell Innerrhoden', 'Appenzell', 'Flag of Canton of Appenzell Innerrhoden.svg'],
  SG: ['St. Gallen', 'St. Gallen', 'Flag of Canton of Sankt Gallen.svg'],
  GR: ['Graubünden', 'Chur', 'Flag of Canton of Graubünden.svg'],
  AG: ['Aargau', 'Aarau', 'Flag of Canton of Aargau.svg'],
  TG: ['Thurgau', 'Frauenfeld', 'Flag of Canton of Thurgau.svg'],
  TI: ['Ticino', 'Bellinzona', 'Flag of Canton of Ticino.svg'],
  VD: ['Vaud', 'Lausanne', 'Flag of Canton of Vaud.svg'],
  VS: ['Valais', 'Sion', 'Flag of Canton of Valais.svg'],
  NE: ['Neuchâtel', 'Neuchâtel', 'Flag of Canton of Neuchâtel.svg'],
  GE: ['Genève', 'Genève', 'Flag of Canton of Geneva.svg'],
  JU: ['Jura', 'Delémont', 'Flag of Canton of Jura.svg'],
};

// Wikidata lists more than one "capital" for a few subdivisions; pick this item then.
const CAPITAL_QID = {
  'ch-ar': 'Q63970', // Herisau is the seat of government; Trogen (also listed) only hosts the cantonal court
};

const SETS = [
  { id: 'us', name: 'United States', kind: 'state', kinds: 'states', label: 'US states', adm0: 'USA', iso: 'US', shapes: 'ne50', decimals: 3, table: US_STATES },
  { id: 'ch', name: 'Switzerland', kind: 'canton', kinds: 'cantons', label: 'Swiss cantons', adm0: 'CHE', iso: 'CH', shapes: 'ne10', decimals: 4, table: CH_CANTONS },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const round3 = (n) => Math.round(n * 1000) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { 'User-Agent': USER_AGENT };

let lastRequest = 0;
async function politeFetch(url, init = {}) { // at most one request per second to the Wikimedia servers
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

// ---------------------------------------------------------------------------
// 1. Shapes
// ---------------------------------------------------------------------------

function buildShapes(ne, set) {
  const byCode = new Map();
  for (const f of ne.features) {
    const p = f.properties;
    if (p.adm0_a3 !== set.adm0) continue;
    const m = /^([A-Z]{2})-([A-Z0-9]{2,3})$/.exec(p.iso_3166_2 || '');
    if (!m || m[1] !== set.iso) continue;
    if (!(m[2] in set.table)) continue; // DC, territories
    if (byCode.has(m[2])) throw new Error(`${set.id}: duplicate feature for ${m[2]}`);
    byCode.set(m[2], f);
  }
  const missing = Object.keys(set.table).filter((c) => !byCode.has(c));
  if (missing.length) throw new Error(`${set.id}: no shape for ${missing.join(', ')}`);

  const features = [...byCode].map(([code, f]) => ({
    type: 'Feature',
    properties: { id: `${set.id}-${code.toLowerCase()}`, wikidata: f.properties.wikidataid },
    geometry: roundGeometry(f.geometry, set.decimals),
  }));
  features.sort((a, b) => (a.properties.id < b.properties.id ? -1 : 1));
  assertNoAntimeridianJumps(features);
  return features;
}

// Neighbour graph: ids whose rounded rings share at least one vertex (a shared border, or a
// corner such as the Four Corners). Returns Map id -> Set of ids.
function adjacency(features) {
  const owners = new Map();
  for (const f of features) {
    const seen = new Set();
    for (const poly of polygonsOf(f.geometry)) for (const ring of poly) for (const [x, y] of ring) {
      const k = `${x},${y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      (owners.get(k) ?? owners.set(k, []).get(k)).push(f.properties.id);
    }
  }
  const adj = new Map(features.map((f) => [f.properties.id, new Set()]));
  for (const ids of owners.values()) {
    for (const a of ids) for (const b of ids) if (a !== b) adj.get(a).add(b);
  }
  return adj;
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
      const used = new Set([...adj.get(id)].map((o) => col.get(o)).filter((c) => c !== undefined));
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
// 2. Capital coordinates from Wikidata
// ---------------------------------------------------------------------------

async function capitalCoords(features, set) {
  const qids = features.map((f) => f.properties.wikidata);
  if (qids.some((q) => !/^Q\d+$/.test(q || ''))) throw new Error('feature without wikidataid');
  const query = `SELECT ?adm ?cap ?coord WHERE { VALUES ?adm { ${qids.map((q) => 'wd:' + q).join(' ')} } ?adm wdt:P36 ?cap . ?cap wdt:P625 ?coord . }`;
  const file = await download(`${SRC.sparql}?format=json&query=${encodeURIComponent(query)}`, `wikidata-sub-capitals-${set.id}.json`, { headers: { Accept: 'application/sparql-results+json' } });
  const rows = readJson(file).results.bindings.map((b) => {
    const m = /^Point\((-?[\d.]+) (-?[\d.]+)\)$/.exec(b.coord.value);
    if (!m) throw new Error(`bad coordinate ${b.coord.value}`);
    return { adm: b.adm.value.split('/').pop(), cap: b.cap.value.split('/').pop(), lon: +m[1], lat: +m[2] };
  });
  const out = new Map();
  for (const f of features) {
    const id = f.properties.id;
    let cands = rows.filter((r) => r.adm === f.properties.wikidata);
    const caps = [...new Set(cands.map((r) => r.cap))];
    if (caps.length > 1) {
      if (!CAPITAL_QID[id]) throw new Error(`${id}: several capitals on Wikidata (${caps.join(', ')}), add CAPITAL_QID`);
      cands = cands.filter((r) => r.cap === CAPITAL_QID[id]);
    }
    if (!cands.length) throw new Error(`${id}: no capital coordinates on Wikidata (${f.properties.wikidata})`);
    const { lat, lon } = cands[0];
    if (!nearGeometry([lon, lat], f.geometry)) throw new Error(`${id}: capital ${lat},${lon} is outside its shape`);
    out.set(id, [round3(lat), round3(lon)]);
  }
  return out;
}

// Inside the geometry, or within `km` of its outline: coastal capitals (Juneau, Annapolis) fall
// just off the generalised 1:50m coastline.
function nearGeometry([lon, lat], geom, km = 3) {
  if (pointInGeometry([lon, lat], geom)) return true;
  const k = Math.cos((lat * Math.PI) / 180);
  const segDist = (px, py, [ax, ay], [bx, by]) => {
    let x = ax, y = ay, dx = bx - ax, dy = by - ay;
    if (dx || dy) { const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy); if (t > 1) { x = bx; y = by; } else if (t > 0) { x += dx * t; y += dy * t; } }
    return Math.hypot(px - x, py - y);
  };
  let d = Infinity;
  for (const poly of polygonsOf(geom)) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
    d = Math.min(d, segDist(lon * k, lat, [ring[i - 1][0] * k, ring[i - 1][1]], [ring[i][0] * k, ring[i][1]]));
  }
  return d * 111 <= km;
}

// ---------------------------------------------------------------------------
// 3. Flags from Wikimedia Commons
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

async function buildFlags(entries, set) {
  fs.mkdirSync(FLAGS_DIR, { recursive: true });
  fs.mkdirSync(path.join(CACHE, 'commons'), { recursive: true });
  const titles = entries.map((e) => e.commonsTitle);
  const info = await commonsInfo(titles, `commons-sub-${set.id}.json`);
  const credits = [];
  let bytes = 0;
  for (const e of entries) {
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

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const shapeFiles = {};
  for (const key of new Set(SETS.map((s) => s.shapes))) shapeFiles[key] = readJson(await download(SRC[key], path.basename(SRC[key])));

  const allCredits = [];
  for (const set of SETS) {
    const features = buildShapes(shapeFiles[set.shapes], set);
    const coords = await capitalCoords(features, set);
    const adj = adjacency(features);
    const { n: nColours, col } = colourGraph(adj);

    const entries = [];
    for (const f of features) {
      const id = f.properties.id;
      const code = id.slice(set.id.length + 1).toUpperCase();
      const [name, capital, commonsTitle = `Flag of ${name}.svg`] = set.table[code];
      const [lat, lon] = coords.get(id);
      const [fx, fy] = flagPoint(f.geometry).map(round3);
      if (!pointInGeometry([fx, fy], f.geometry)) throw new Error(`${id}: flag point outside its shape`);
      entries.push({ id, name, capital, lat, lon, fx, fy, color: PALETTE[col.get(id)], flag: null, commonsTitle });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));

    const { bytes: flagBytes, credits } = await buildFlags(entries, set);
    allCredits.push(...credits);

    // geojson (properties: only id)
    const fc = { type: 'FeatureCollection', features: features.map((f) => ({ type: 'Feature', properties: { id: f.properties.id }, geometry: f.geometry })) };
    const geoPath = path.join(DATA_DIR, `${set.id}.geojson`);
    writeIfChanged(geoPath, JSON.stringify(fc));
    const geoBytes = fs.statSync(geoPath).size;
    if (geoBytes > 500_000) console.warn(`  warning: ${set.id}.geojson is ${geoBytes} bytes (> 500 KB)`);

    // json
    const rows = entries.map(({ commonsTitle, ...e }) => e);
    const jsonPath = path.join(DATA_DIR, `${set.id}.json`);
    writeIfChanged(jsonPath, '[\n' + rows.map((e) => '  ' + JSON.stringify(e)).join(',\n') + '\n]\n');

    // final checks
    validate(set, rows, fc, adj);
    const nPng = rows.filter((e) => e.flag.endsWith('.png')).length;
    console.log(`${set.id}: ${rows.length} ${set.kinds}, ${nColours} colours, ${set.id}.geojson ${geoBytes} B, ${set.id}.json ${fs.statSync(jsonPath).size} B, flags ${flagBytes} B (${rows.length - nPng} svg, ${nPng} png)`);
  }

  const index = SETS.map(({ id, name, kind, kinds, label }) => ({ id, name, kind, kinds, label }));
  writeIfChanged(path.join(DATA_DIR, 'index.json'), '[\n' + index.map((e) => '  ' + JSON.stringify(e)).join(',\n') + '\n]\n');

  // Flag credits for LICENSES.md
  const byLicense = {};
  for (const c of allCredits) (byLicense[c.license] ??= []).push(c);
  const lines = ['| id | Commons file | licence | author |', '|---|---|---|---|'];
  for (const c of allCredits) lines.push(`| ${c.id} | [${c.file}](https://commons.wikimedia.org/wiki/File:${encodeURI(c.file.replace(/ /g, '_'))}) | ${c.license} | ${c.artist.replace(/\|/g, '/')} |`);
  const creditsFile = path.join(CACHE, 'sub-flag-credits.md');
  fs.writeFileSync(creditsFile, lines.join('\n') + '\n');
  console.log(`flag licences: ${Object.entries(byLicense).map(([l, c]) => `${l} ×${c.length}`).join(', ')}; table written to ${creditsFile}`);
}

function validate(set, rows, fc, adj) {
  const n = Object.keys(set.table).length;
  if (rows.length !== n) throw new Error(`${set.id}: ${rows.length} entries, expected ${n}`);
  const geom = new Map(fc.features.map((f) => [f.properties.id, f.geometry]));
  if (geom.size !== n) throw new Error(`${set.id}: ${geom.size} shapes, expected ${n}`);
  const colour = new Map(rows.map((e) => [e.id, e.color]));
  for (const e of rows) {
    const g = geom.get(e.id);
    if (!g) throw new Error(`${e.id}: no geometry`);
    if (!fs.existsSync(path.join(ROOT, e.flag))) throw new Error(`${e.id}: flag file ${e.flag} missing`);
    if (!pointInGeometry([e.fx, e.fy], g)) throw new Error(`${e.id}: fx/fy outside`);
    if (!nearGeometry([e.lon, e.lat], g)) throw new Error(`${e.id}: capital outside`);
    for (const o of adj.get(e.id)) if (colour.get(o) === e.color) throw new Error(`${e.id} and ${o} are neighbours with the same colour`);
    if (!/^#[0-9a-f]{6}$/.test(e.color)) throw new Error(`${e.id}: bad colour`);
  }
  assertNoAntimeridianJumps(fc.features);
  for (const f of fc.features) for (const poly of polygonsOf(f.geometry)) if (ringArea(poly[0]) === 0) throw new Error(`${f.properties.id}: degenerate ring`);
}

main().catch((e) => { console.error(e); process.exit(1); });
